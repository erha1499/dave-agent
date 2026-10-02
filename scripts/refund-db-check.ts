import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { AfterSalesStore, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { readDatabaseConfig } from "../src/coupon-store.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

assert.equal(readRefundDatabaseConfig({ REFUND_DB_PASSWORD: "test" }).user, "dave_agent_refund");
assert.equal(readRefundDatabaseConfig({ REFUND_DB_PASSWORD: "test" }).multipleStatements, false);
assert.throws(() => readRefundDatabaseConfig({}), /REFUND_DB_PASSWORD/);
for (const user of ["root", "dave_agent_read", "dave_agent_eval", "dave_agent_after_sales"]) {
  assert.throws(() => readRefundDatabaseConfig({ REFUND_DB_PASSWORD: "test", REFUND_DB_USER: user }), /独立/);
}
const business = createPool(readDatabaseConfig());
const merchantPool = createPool(readAfterSalesDatabaseConfig());
const merchant = new AfterSalesStore(merchantPool);
let pool = createPool(readRefundDatabaseConfig());
let store = new RefundStore(pool);
const fixture = await createMerchantFixture(Array.from({ length: 18 }, () => "approve" as const), { delayMs: 5000 });
const identity = fixture.identity;
const sourceKey = createHash("sha256").update("REFUND_DB_CHECK_A").digest("hex");
const otherSource = createHash("sha256").update("REFUND_DB_CHECK_B").digest("hex");
const [success, absent, rejected, timedOut, expires, changedAmount, changedApproval, redeemed, expiredCoupon,
  failedPayment, history, changedTask, otherTask, restart, partialApproval, repriced, waitConfirm, waitPresented] = fixture.orders as string[];

async function approve(orderId: string, amount = 7980) {
  const task = await merchant.request(identity, sourceKey, orderId, "模拟退款数据库检查");
  assert.equal(await merchant.applyResult({ taskId: task.taskId, orderId, status: "approved", approvedAmountCents: amount }), true);
}
async function facts(orderId: string) {
  const [rows] = await business.execute<RowDataPacket[]>(`SELECT o.status, o.refunded_cents,
    (SELECT GROUP_CONCAT(c.status ORDER BY c.id) FROM coupons c JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = o.id) AS coupons,
    (SELECT COUNT(*) FROM refunds r WHERE r.order_id = o.id) AS refunds
    FROM orders o WHERE o.id = ?`, [orderId]);
  return { ...rows[0] };
}
async function noRefund(orderId: string) {
  const [rows] = await business.execute<RowDataPacket[]>("SELECT COUNT(*) AS count FROM refunds WHERE order_id = ? AND status = 'succeeded'", [orderId]);
  assert.equal(rows[0]!.count, 0, "rejected operations cannot persist a successful refund");
}
const permissionDenied = (error: unknown) => !!error && typeof error === "object" && "code" in error
  && ["ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR"].includes(String(error.code));
try {
  await store.ping();
  const [baselineBefore] = await business.query<RowDataPacket[]>("SELECT * FROM orders WHERE id LIKE 'COUPON-100%' ORDER BY id");
  await assert.rejects(store.prepare(identity, sourceKey, absent!), /未找到/);
  const rejectedTask = await merchant.request(identity, sourceKey, rejected!, "模拟拒绝");
  assert.equal(await merchant.applyResult({ taskId: rejectedTask.taskId, orderId: rejected!, status: "rejected", approvedAmountCents: null }), true);
  await assert.rejects(store.prepare(identity, sourceKey, rejected!), /审批/);
  await merchant.request(identity, sourceKey, timedOut!, "模拟超时");
  await fixture.expire(timedOut!);
  await merchant.processDue();
  await assert.rejects(store.prepare(identity, sourceKey, timedOut!), /审批/);
  await approve(partialApproval!, 7979);
  await assert.rejects(store.prepare(identity, sourceKey, partialApproval!), /审批/);
  assert.equal(await store.get(identity, sourceKey, absent!), undefined);
  await assert.rejects(store.prepare(identity, sourceKey, "COUPON-1001"));
  await assert.rejects(store.prepare(identity, sourceKey, "COUPON-2001' OR 1=1"));
  await assert.rejects(store.prepare(identity, "arbitrary-source", success!));
  await assert.rejects(store.confirm(identity, sourceKey, "not-an-operation"));
  await assert.rejects(store.confirm(identity, sourceKey, randomUUID()));

  await approve(success!);
  const before = await facts(success!);
  const prepared = await Promise.all(Array.from({ length: 5 }, () => store.prepare(identity, sourceKey, success!)));
  const first = prepared[0]!;
  assert.ok(prepared.every(result => result.operationId === first.operationId));
  assert.equal(first.status, "prepared");
  assert.equal(first.amountCents, 7980);
  assert.equal(first.presentedAt, null);
  assert.equal(first.confirmedAt, null);
  assert.equal(first.refundId, null);
  assert.equal(first.simulation, true);
  assert.ok(Date.parse(first.expiresAt) > Date.now() && Date.parse(first.expiresAt) < Date.now() + 901000);
  assert.ok(!/customer_id|customerId|source_key|sourceKey|TEST_USER|TEST_APP/.test(JSON.stringify(first)));
  await assert.rejects(store.confirm(identity, sourceKey, first.operationId), /尚未成功展示/);
  assert.deepEqual(await facts(success!), before);
  for (const wrong of [{ ...identity, senderId: "TEST_USER2" }, { ...identity, senderId: "UNBOUND_USER" }, { ...identity, appId: "OTHER_APP" }]) {
    await assert.rejects(store.prepare(wrong, sourceKey, success!));
    await assert.rejects(store.markPresented(wrong, sourceKey, first.operationId));
    await assert.rejects(store.confirm(wrong, sourceKey, first.operationId));
    assert.equal(await store.get(wrong, sourceKey, success!), undefined);
  }
  await assert.rejects(store.prepare(identity, otherSource, success!));
  await assert.rejects(store.markPresented(identity, otherSource, first.operationId));
  await assert.rejects(store.confirm(identity, otherSource, first.operationId));
  assert.equal(await store.get(identity, otherSource, success!), undefined);
  const presented = await store.markPresented(identity, sourceKey, first.operationId);
  assert.equal(presented.status, "awaiting_confirmation");
  assert.ok(presented.presentedAt);
  assert.equal(presented.confirmedAt, null);
  assert.deepEqual(await store.markPresented(identity, sourceKey, first.operationId), presented);
  assert.deepEqual(await facts(success!), before);
  const successes = await Promise.all(Array.from({ length: 5 }, () => store.confirm(identity, sourceKey, first.operationId)));
  const completed = successes[0]!;
  assert.ok(successes.every(result => JSON.stringify(result) === JSON.stringify(completed)));
  assert.equal(completed.status, "succeeded");
  assert.ok(completed.confirmedAt && completed.refundId);
  assert.deepEqual(await facts(success!), { status: "refunded", refunded_cents: 7980, coupons: "refunded", refunds: 1 });
  assert.deepEqual(await store.prepare(identity, sourceKey, success!), completed);
  assert.deepEqual(await store.confirm(identity, sourceKey, first.operationId), completed);
  assert.deepEqual(await store.markPresented(identity, sourceKey, first.operationId), completed);

  await approve(expires!);
  const old = await store.prepare(identity, sourceKey, expires!);
  await store.markPresented(identity, sourceKey, old.operationId);
  await fixture.expireRefund(expires!);
  await assert.rejects(store.confirm(identity, sourceKey, old.operationId), /过期/);
  await assert.rejects(store.markPresented(identity, sourceKey, old.operationId), /过期/);
  const renewed = await store.prepare(identity, sourceKey, expires!);
  assert.notEqual(renewed.operationId, old.operationId);
  assert.equal(renewed.status, "prepared");
  assert.equal(renewed.presentedAt, null);
  await assert.rejects(store.confirm(identity, sourceKey, old.operationId));
  await assert.rejects(store.confirm(identity, sourceKey, renewed.operationId), /尚未成功展示/);
  await store.markPresented(identity, sourceKey, renewed.operationId);
  assert.equal((await store.confirm(identity, sourceKey, renewed.operationId)).status, "succeeded");
  await assert.rejects(store.confirm(identity, sourceKey, old.operationId));

  for (const [orderId, change] of [[changedAmount, "amount"], [changedApproval, "approval"], [redeemed, "redeemed"],
    [expiredCoupon, "expired"], [failedPayment, "payment"], [history, "history"]] as const) {
    await approve(orderId!);
    const result = await store.prepare(identity, sourceKey, orderId!);
    await store.markPresented(identity, sourceKey, result.operationId);
    await fixture.invalidateRefund(orderId!, change);
    await assert.rejects(store.confirm(identity, sourceKey, result.operationId));
    await noRefund(orderId!);
  }
  await approve(changedTask!);
  await approve(otherTask!);
  const changed = await store.prepare(identity, sourceKey, changedTask!);
  await store.markPresented(identity, sourceKey, changed.operationId);
  await fixture.replaceRefundTask(changedTask!, otherTask!);
  await assert.rejects(store.confirm(identity, sourceKey, changed.operationId), /审批/);
  await noRefund(changedTask!);

  await approve(repriced!);
  const originalPrice = await store.prepare(identity, sourceKey, repriced!);
  await store.markPresented(identity, sourceKey, originalPrice.operationId);
  await fixture.repriceRefund(repriced!, 6880);
  await assert.rejects(store.confirm(identity, sourceKey, originalPrice.operationId), /审批/);
  const newPrice = await store.prepare(identity, sourceKey, repriced!);
  assert.notEqual(newPrice.operationId, originalPrice.operationId);
  assert.equal(newPrice.amountCents, 6880);
  assert.equal(newPrice.status, "prepared");
  await assert.rejects(store.confirm(identity, sourceKey, originalPrice.operationId));
  await assert.rejects(store.confirm(identity, sourceKey, newPrice.operationId), /尚未成功展示/);
  await store.markPresented(identity, sourceKey, newPrice.operationId);
  assert.equal((await store.confirm(identity, sourceKey, newPrice.operationId)).amountCents, 6880);
  assert.deepEqual(await facts(repriced!), { status: "refunded", refunded_cents: 6880, coupons: "refunded", refunds: 1 });

  for (const [orderId, method] of [[waitConfirm!, "confirm"], [waitPresented!, "markPresented"]] as const) {
    await approve(orderId);
    const pending = await store.prepare(identity, sourceKey, orderId);
    if (method === "confirm") await store.markPresented(identity, sourceKey, pending.operationId);
    const blocker = await merchantPool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.execute("UPDATE merchant_requests SET status = status WHERE order_id = ?", [orderId]);
      await fixture.expireRefundSoon(orderId, 350);
      // Hold the final authorization lock past expiry; a timestamp taken before this wait is unsafe.
      const waiting = assert.rejects(store[method](identity, sourceKey, pending.operationId), /过期/);
      await sleep(500);
      await blocker.commit();
      await waiting;
      await noRefund(orderId);
    } finally { await blocker.rollback(); blocker.release(); }
  }

  await approve(restart!);
  const durable = await store.prepare(identity, sourceKey, restart!);
  await store.markPresented(identity, sourceKey, durable.operationId);
  await store.close();
  pool = createPool(readRefundDatabaseConfig());
  store = new RefundStore(pool);
  assert.equal((await store.get(identity, sourceKey, restart!))?.status, "awaiting_confirmation");
  assert.equal((await store.confirm(identity, sourceKey, durable.operationId)).status, "succeeded");
  assert.deepEqual(await store.get(identity, sourceKey, success!), completed, "successful result survives process/store restart");

  for (const restricted of [business, merchantPool]) {
    for (const sql of ["UPDATE orders SET status = status WHERE 1 = 0", "UPDATE coupons SET status = status WHERE 1 = 0",
      "UPDATE refund_operations SET status = status WHERE 1 = 0", "UPDATE refunds SET status = status WHERE 1 = 0"]) {
      await assert.rejects(restricted.execute(sql), permissionDenied);
    }
  }
  for (const sql of ["UPDATE orders SET paid_cents = paid_cents WHERE 1 = 0", "UPDATE coupons SET expires_at = expires_at WHERE 1 = 0",
    "UPDATE merchant_requests SET status = status WHERE 1 = 0", "DELETE FROM refunds WHERE 1 = 0"]) {
    await assert.rejects(pool.execute(sql), permissionDenied);
  }
  const [baselineAfter] = await business.query<RowDataPacket[]>("SELECT * FROM orders WHERE id LIKE 'COUPON-100%' ORDER BY id");
  assert.deepEqual(baselineAfter, baselineBefore);
  console.log("模拟退款 MySQL 检查通过：送达后确认、15分钟有效期/旧指令失效、身份/群隔离、原审批/金额/券/付款复核、并发幂等、原子退款记录与重启查询；D1及只读权限和100x基线保留。");
} finally {
  await Promise.allSettled([store.close(), merchant.close(), business.end()]);
  await fixture.cleanup();
}
