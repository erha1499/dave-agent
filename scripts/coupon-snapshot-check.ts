import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

const pool = createPool({ ...readDatabaseConfig(), connectionLimit: 1 });
const merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
const refunds = new RefundStore(createPool(readRefundDatabaseConfig()));
const fixture = await createMerchantFixture(["approve", "approve"], { delayMs: 5000 });
const [snapshotOrder, defaultOrder] = fixture.orders as [string, string];
const identity = fixture.identity;
const sourceKey = createHash("sha256").update("COUPON_SNAPSHOT_CHECK").digest("hex");
const denied = "未找到当前客户可查询的订单，请核对订单号或联系人工客服。";
const unavailable = "演示业务数据暂时无法查询，请稍后重试。";
type Mode = "normal" | "child-error" | "rollback-error" | "begin-error" | "commit-error" | "acquire-error";
let mode: Mode = "normal", interleave: (() => Promise<void>) | undefined;
const traces: Array<{ thread: number; heads: number; children: number; commits: number; rollbacks: number; releases: number; destroys: number }> = [];

// All reads still run on the restricted real MySQL connection. Only scheduling and failures are injected.
const observedPool = new Proxy(pool, { get(target, property) {
  if (property === "getConnection") return async () => {
    if (mode === "acquire-error") throw new Error("synthetic private acquire diagnostic");
    const connection = await target.getConnection();
    const trace = { thread: connection.threadId, heads: 0, children: 0, commits: 0, rollbacks: 0, releases: 0, destroys: 0 };
    traces.push(trace);
    return new Proxy(connection, { get(current, key) {
      if (key === "execute") return async (...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { sql: string }).sql;
        const head = sql.includes("o.id, o.status, o.total_cents");
        if (head) trace.heads++;
        else trace.children++;
        if (!head && ["child-error", "rollback-error"].includes(mode)) throw new Error("synthetic private query diagnostic");
        const result = await Reflect.apply(current.execute, current, args);
        if (head && interleave) { const action = interleave; interleave = undefined; await action(); }
        return result;
      };
      if (key === "beginTransaction") return async () => {
        if (mode === "begin-error") throw new Error("synthetic private begin diagnostic");
        await current.beginTransaction();
      };
      if (key === "commit") return async () => {
        trace.commits++;
        if (mode === "commit-error") throw new Error("synthetic private commit diagnostic");
        await current.commit();
      };
      if (key === "rollback") return async () => {
        trace.rollbacks++;
        if (mode === "rollback-error") throw new Error("synthetic private rollback diagnostic");
        await current.rollback();
      };
      if (key === "release") return () => { trace.releases++; current.release(); };
      if (key === "destroy") return () => { trace.destroys++; current.destroy(); };
      const value = Reflect.get(current, key);
      return typeof value === "function" ? value.bind(current) : value;
    } });
  };
  // No order SELECT may escape to another pool connection.
  if (property === "execute" || property === "query") return () => { assert.fail("getOrder must use its borrowed connection for every read"); };
  const value = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
} });
const store = new CouponStore(observedPool);

async function approvedOperation(orderId: string) {
  const task = await merchant.request(identity, sourceKey, orderId, "订单一致快照测试");
  assert.equal(await merchant.applyResult({ taskId: task.taskId, orderId, status: "approved", approvedAmountCents: 7980 }), true);
  const operation = await refunds.prepare(identity, sourceKey, orderId);
  await refunds.markPresented(identity, sourceKey, operation.operationId);
  return operation;
}
const facts = (order: Awaited<ReturnType<CouponStore["getOrder"]>>) => ({
  status: order.status, refundedCents: order.amounts.refundedCents,
  coupons: order.coupons.map(coupon => coupon.status),
  refunds: order.refunds.map(refund => ({ status: refund.status, amountCents: refund.amountCents })),
});
const paid = { status: "paid", refundedCents: 0, coupons: ["unused"], refunds: [] };
const refunded = { status: "refunded", refundedCents: 7980, coupons: ["refunded"], refunds: [{ status: "succeeded", amountCents: 7980 }] };

try {
  // Deliberately choose different session defaults: getOrder must set only its own transaction.
  await pool.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE");
  const operation = await approvedOperation(snapshotOrder);
  interleave = async () => { await refunds.confirm(identity, sourceKey, operation.operationId); };
  const old = await store.getOrder(identity, snapshotOrder);
  assert.equal(interleave, undefined, "refund must commit between the real header and child reads");
  assert.deepEqual(facts(old), paid, "the whole in-flight read must keep its authorized pre-refund snapshot");
  assert.deepEqual(facts(await store.getOrder(identity, snapshotOrder)), refunded, "the next read must observe the committed refund");
  for (const trace of traces) {
    assert.equal(trace.heads, 1); assert.equal(trace.children, 4);
    assert.equal(trace.commits, 1); assert.equal(trace.rollbacks, 0); assert.equal(trace.releases, 1); assert.equal(trace.destroys, 0);
  }

  const next = await approvedOperation(defaultOrder);
  const connection = await pool.getConnection();
  try {
    const [defaults] = await connection.query<RowDataPacket[]>("SELECT @@session.transaction_isolation AS isolation_level, @@session.transaction_read_only AS read_only");
    assert.equal(defaults[0]!.isolation_level, "READ-COMMITTED"); assert.equal(defaults[0]!.read_only, 0);
    await connection.beginTransaction();
    const read = async () => (await connection.execute<RowDataPacket[]>("SELECT status FROM orders WHERE id = ?", [defaultOrder]))[0][0]!.status;
    assert.equal(await read(), "paid");
    await refunds.confirm(identity, sourceKey, next.operationId);
    assert.equal(await read(), "refunded", "the next transaction must retain READ COMMITTED, not inherit getOrder's repeatable snapshot");
    await connection.commit();
  } finally { await connection.rollback(); connection.release(); }

  await assert.rejects(store.getOrder({ ...identity, senderId: "TEST_USER2" }, snapshotOrder), { message: denied });
  assert.equal(traces.at(-1)!.heads, 1); assert.equal(traces.at(-1)!.children, 0);
  assert.equal(traces.at(-1)!.rollbacks, 1); assert.equal(traces.at(-1)!.releases, 1); assert.equal(traces.at(-1)!.destroys, 0);
  assert.deepEqual(facts(await store.getOrder(identity, snapshotOrder)), refunded);

  for (const failure of ["child-error", "commit-error", "rollback-error", "begin-error"] as const) {
    mode = failure;
    await assert.rejects(store.getOrder(identity, snapshotOrder), { message: unavailable });
    const failed = traces.at(-1)!;
    assert.equal(failed.rollbacks, failure === "begin-error" ? 0 : 1);
    assert.equal(failed.releases, 1);
    const destroyed = failure === "begin-error" || failure === "rollback-error";
    assert.equal(failed.destroys, Number(destroyed));
    mode = "normal";
    assert.deepEqual(facts(await store.getOrder(identity, snapshotOrder)), refunded, "the next borrower must recover after a failed read");
    if (destroyed) assert.notEqual(traces.at(-1)!.thread, failed.thread, "uncertain transaction connections must be discarded");
  }
  const acquired = traces.length;
  mode = "acquire-error";
  await assert.rejects(store.getOrder(identity, snapshotOrder), { message: unavailable });
  assert.equal(traces.length, acquired);
  mode = "normal";
  assert.deepEqual(facts(await store.getOrder(identity, snapshotOrder)), refunded);
  await assert.rejects(pool.execute("UPDATE orders SET status = status WHERE 1 = 0"), (error: unknown) =>
    !!error && typeof error === "object" && "code" in error && error.code === "ER_TABLEACCESS_DENIED_ERROR");
  console.log("订单快照 MySQL 检查通过：真实退款交错保持整单旧快照、后续整单新快照；事务隔离不污染池；未授权/查询/提交/回滚/初始化/连接错误均受控清理，连接恢复且只读权限不变。");
} finally {
  await Promise.allSettled([pool.end(), merchant.close(), refunds.close()]);
  await fixture.cleanup();
}
