import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { AfterSalesStore, readAfterSalesDatabaseConfig, startMockMerchant } from "../src/after-sales.ts";
import { readDatabaseConfig } from "../src/coupon-store.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

const standalone = readAfterSalesDatabaseConfig({ AFTER_SALES_DB_PASSWORD: "synthetic-local-password" });
assert.equal(standalone.user, "dave_agent_after_sales");
assert.equal(standalone.multipleStatements, false);
assert.throws(() => readAfterSalesDatabaseConfig({}), /AFTER_SALES_DB_PASSWORD/);
for (const user of ["root", "dave_agent_read", "dave_agent_eval"]) {
  assert.throws(() => readAfterSalesDatabaseConfig({ AFTER_SALES_DB_PASSWORD: "test", AFTER_SALES_DB_USER: user }), /独立/);
}

const business = createPool(readDatabaseConfig());
let pool = createPool(readAfterSalesDatabaseConfig());
let store = new AfterSalesStore(pool);
let stopWorker: (() => Promise<void>) | undefined;
const fixture = await createMerchantFixture(["approve", "reject", "timeout", "approve"], { delayMs: 5000 });
const [approveOrder, rejectOrder, timeoutOrder, restartOrder] = fixture.orders as [string, string, string, string];
const identity = fixture.identity;
const sourceKey = createHash("sha256").update(JSON.stringify([identity.appId, "SYNTHETIC_GROUP_A", identity.senderId])).digest("hex");
const otherGroup = createHash("sha256").update(JSON.stringify([identity.appId, "SYNTHETIC_GROUP_B", identity.senderId])).digest("hex");
const reason = "测试行程取消，申请模拟商家协商";
const placeholders = fixture.orders.map(() => "?").join(", ");

async function requestCount() {
  const [rows] = await business.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM merchant_requests WHERE order_id IN (${placeholders})`, fixture.orders);
  return Number(rows[0]!.count);
}

async function facts() {
  const [rows] = await business.execute<RowDataPacket[]>(`SELECT o.id, o.status, o.total_cents, o.paid_cents, o.refunded_cents,
    (SELECT COUNT(*) FROM refunds r WHERE r.order_id = o.id) AS refunds,
    (SELECT GROUP_CONCAT(CONCAT(c.status, ':', c.expires_at) ORDER BY c.id) FROM coupons c
      JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = o.id) AS coupons,
    (SELECT GROUP_CONCAT(CONCAT(p.status, ':', p.amount_cents) ORDER BY p.id) FROM payments p WHERE p.order_id = o.id) AS payments
    FROM orders o WHERE o.id IN (${placeholders}) ORDER BY o.id`, fixture.orders);
  return rows.map(row => ({ ...row }));
}

async function waitForDue(orderId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [rows] = await business.execute<RowDataPacket[]>("SELECT due_at <= UTC_TIMESTAMP(3) AS due FROM merchant_requests WHERE order_id = ?", [orderId]);
    if (rows[0]?.due) return;
    await sleep(25);
  }
  throw new Error("测试任务未按数据库时间到期。");
}

try {
  await store.ping();
  const before = await facts();
  assert.equal(before.length, 4);
  const proposal = await store.prepare(identity, sourceKey, approveOrder, reason);
  assert.equal(proposal.status, "confirmation_required");
  assert.equal(proposal.simulation, true);
  assert.equal(proposal.amountCents, 7980);
  assert.equal(proposal.confirmationText, `确认联系商家 ${approveOrder} 原因：${reason}`);
  assert.equal(await requestCount(), 0, "a proposal must not create a task");
  assert.equal(await store.getTask(identity, sourceKey, approveOrder), undefined);
  for (const deniedIdentity of [
    { ...identity, senderId: "TEST_USER2" }, { ...identity, senderId: "UNBOUND_USER" }, { ...identity, appId: "OTHER_APP" },
    { ...identity, senderId: "TEST_USER1' OR 1=1 --" },
  ]) {
    await assert.rejects(store.prepare(deniedIdentity, sourceKey, approveOrder, reason));
    await assert.rejects(store.request(deniedIdentity, sourceKey, approveOrder, reason));
  }
  for (const invalidReason of [" ", "x".repeat(201), "两行\n原因"]) {
    await assert.rejects(store.prepare(identity, sourceKey, approveOrder, invalidReason), /原因/);
  }
  await assert.rejects(store.request(identity, "user-supplied-group", approveOrder, reason));
  await assert.rejects(store.request(identity, sourceKey, "COUPON-1001", reason));
  await assert.rejects(store.request(identity, sourceKey, "COUPON-2001' OR 1=1 --", reason));
  assert.equal(await requestCount(), 0);

  const started = performance.now();
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => store.request(identity, sourceKey, approveOrder, reason)));
  assert.ok(performance.now() - started < 5000, "request must return before the configured merchant reply delay");
  const pending = concurrent[0]!;
  assert.ok(concurrent.every(task => task.taskId === pending.taskId && task.status === "pending"));
  assert.equal(pending.amountCents, 7980);
  assert.equal(pending.approvedAmountCents, null);
  assert.equal(pending.simulation, true);
  assert.equal(await requestCount(), 1);
  assert.ok(!/customer_id|customerId|source_key|sourceKey|TEST_USER|mock_outcome/.test(JSON.stringify(pending)));
  for (const wrongIdentity of [{ ...identity, senderId: "TEST_USER2" }, { ...identity, senderId: "UNBOUND_USER" }, { ...identity, appId: "OTHER_APP" }]) {
    assert.equal(await store.getTask(wrongIdentity, sourceKey, approveOrder), undefined);
  }
  assert.equal(await store.getTask(identity, otherGroup, approveOrder), undefined);
  await assert.rejects(store.prepare(identity, otherGroup, approveOrder, reason));
  await assert.rejects(store.request(identity, otherGroup, approveOrder, reason));
  assert.equal(await requestCount(), 1);

  const callback = { taskId: pending.taskId, orderId: approveOrder, status: "approved" as const, approvedAmountCents: pending.amountCents };
  assert.equal(await store.applyResult({ ...callback, taskId: randomUUID() }), false);
  assert.equal(await store.applyResult({ ...callback, orderId: rejectOrder }), false);
  assert.equal(await store.applyResult({ ...callback, approvedAmountCents: pending.amountCents + 1 }), false);
  for (const amount of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.applyResult({ ...callback, approvedAmountCents: amount }), /回调/);
  }
  await assert.rejects(store.applyResult({ ...callback, status: "rejected", approvedAmountCents: 1 }), /回调/);
  assert.equal((await store.getTask(identity, sourceKey, approveOrder))?.status, "pending");
  assert.equal(await store.applyResult(callback), true);
  const approved = await store.getTask(identity, sourceKey, approveOrder);
  assert.equal(approved?.status, "approved");
  assert.equal(approved.approvedAmountCents, 7980);
  assert.ok(approved.completedAt);
  assert.equal(await store.applyResult(callback), false);
  assert.equal(await store.applyResult({ ...callback, status: "rejected", approvedAmountCents: null }), false);
  assert.deepEqual(await store.request(identity, sourceKey, approveOrder, "重复确认不产生新任务"), approved);

  await fixture.setTiming(rejectOrder, 20);
  const rejectedPending = await store.request(identity, sourceKey, rejectOrder, reason);
  await waitForDue(rejectOrder);
  await store.processDue();
  const rejected = await store.getTask(identity, sourceKey, rejectOrder);
  assert.equal(rejected?.status, "rejected");
  assert.equal(rejected.approvedAmountCents, null);
  assert.equal(await store.applyResult({ ...callback, taskId: rejectedPending.taskId, orderId: rejectOrder }), false);

  const expiring = await store.request(identity, sourceKey, timeoutOrder, reason);
  await fixture.expire(timeoutOrder);
  assert.equal(await store.applyResult({ ...callback, taskId: expiring.taskId, orderId: timeoutOrder }), false, "late callbacks cannot bypass deadline before worker runs");
  await store.processDue();
  const expired = await store.getTask(identity, sourceKey, timeoutOrder);
  assert.equal(expired?.status, "timed_out");
  assert.equal(expired.approvedAmountCents, null);
  assert.equal(await store.applyResult({ ...callback, taskId: expiring.taskId, orderId: timeoutOrder, status: "rejected", approvedAmountCents: null }), false);

  await fixture.setTiming(restartOrder, 5000);
  const recoveryDeadline = performance.now() + 7000;
  const restartPending = await store.request(identity, sourceKey, restartOrder, reason);
  await store.close();
  pool = createPool(readAfterSalesDatabaseConfig());
  store = new AfterSalesStore(pool);
  assert.equal((await store.getTask(identity, sourceKey, restartOrder))?.status, "pending", "pending state survives connection/store restart");
  stopWorker = startMockMerchant(store, { intervalMs: 20 });
  while (performance.now() < recoveryDeadline && (await store.getTask(identity, sourceKey, restartOrder))?.status === "pending") await sleep(25);
  await stopWorker();
  stopWorker = undefined;
  const recovered = await store.getTask(identity, sourceKey, restartOrder);
  assert.equal(recovered?.taskId, restartPending.taskId);
  assert.equal(recovered?.status, "approved");
  assert.equal(await requestCount(), 4);
  assert.deepEqual(await facts(), before, "merchant outcomes must not mutate orders, coupon state, payment amounts or refunds");

  for (const sql of ["UPDATE orders SET status = status WHERE 1 = 0", "UPDATE refunds SET status = status WHERE 1 = 0", "DELETE FROM merchant_requests WHERE 1 = 0"]) {
    await assert.rejects(pool.execute(sql), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ER_TABLEACCESS_DENIED_ERROR");
  }
  console.log("商家协商 MySQL 检查通过：只读提议、身份/群隔离、并发幂等、金额/回调校验、同意/拒绝/超时、重启恢复、终态保护和最小权限；业务订单与退款未变更。");
} finally {
  await stopWorker?.();
  await Promise.allSettled([store.close(), business.end()]);
  await fixture.cleanup();
}
