import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig, startMockMerchant, type MerchantReplyRoute } from "../src/after-sales.ts";
import { confirmMerchantReply, merchantSourceKey as entrySourceKey } from "../src/after-sales-entry.ts";
import { readDatabaseConfig } from "../src/coupon-store.ts";
import { readRefundDatabaseConfig } from "../src/refunds.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

const fixture = await createMerchantFixture(["approve", "reject", "timeout", "approve", "approve", "approve", "approve"], { delayMs: 5000 });
const [approvedOrder, rejectedOrder, timeoutOrder, cliOrder, restartOrder, claimedOrder, pollingOrder] = fixture.orders as [string, string, string, string, string, string, string];
const identity = fixture.identity;
const group = `notification-${randomUUID()}`;
const sourceKey = merchantSourceKey(identity, group);
let pool = createPool(readAfterSalesDatabaseConfig());
let store = new AfterSalesStore(pool);
const business = createPool(readDatabaseConfig());
const refunds = createPool(readRefundDatabaseConfig());
let stopWorker: (() => Promise<void>) | undefined;
const route = (messageId: string): MerchantReplyRoute => ({ groupOpenid: group, messageId, timestamp: new Date().toISOString() });
const reason = "通知边界检查";
const orderList = fixture.orders.map(() => "?").join(",");
const notifications = async () => (await pool.execute<RowDataPacket[]>(`SELECT n.*, r.order_id FROM merchant_notifications n
  JOIN merchant_requests r ON r.task_id = n.task_id WHERE r.order_id IN (${orderList}) ORDER BY r.order_id`, fixture.orders))[0];
const pending = async () => (await store.listNotifications(identity.appId)).filter(item => fixture.orders.includes(item.orderId));
const facts = async () => {
  const [orders] = await business.execute<RowDataPacket[]>(`SELECT id, status, paid_cents, refunded_cents FROM orders WHERE id IN (${orderList}) ORDER BY id`, fixture.orders);
  const [refundRows] = await business.execute<RowDataPacket[]>(`SELECT * FROM refunds WHERE order_id IN (${orderList}) ORDER BY id`, fixture.orders);
  return { orders, refunds: refundRows };
};
const denied = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ER_TABLEACCESS_DENIED_ERROR";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

try {
  assert.equal(entrySourceKey, merchantSourceKey, "old entry imports must retain the same source-key function");
  const before = await facts();
  const original = route("original-confirmation");
  for (const bad of [
    { ...original, groupOpenid: "other-group" }, { ...original, messageId: "" }, { ...original, messageId: "hidden\nvalue" },
    { ...original, timestamp: "invalid" }, { ...original, timestamp: "0999-01-01T00:00:00.000Z" },
  ]) await assert.rejects(store.request(identity, sourceKey, approvedOrder, reason, bad), /路由/);
  const otherIdentity = { ...identity, senderId: "TEST_USER2" };
  await assert.rejects(store.request(otherIdentity, merchantSourceKey(otherIdentity, group), approvedOrder, reason, original));
  assert.equal((await notifications()).length, 0, "invalid routes/identity must not create either task or notification");
  assert.equal(await store.getTask(identity, sourceKey, approvedOrder), undefined);

  const reply = await confirmMerchantReply(store, identity, sourceKey, `确认联系商家 ${approvedOrder} 原因：${reason}`, original);
  assert.equal(reply?.kind, "merchant_status", "host confirmation passes the original QQ route into the same task transaction");
  const approvedTask = await store.getTask(identity, sourceKey, approvedOrder);
  assert.ok(approvedTask);
  assert.equal(await store.claimNotification(approvedTask.taskId, identity.appId), false, "pending merchant result cannot be claimed");
  assert.equal((await pending()).length, 0);
  await assert.rejects(store.finishNotification(approvedTask.taskId, identity.appId, "sent"));
  const repeated = await Promise.all(Array.from({ length: 4 }, (_, index) => store.request(identity, sourceKey, approvedOrder, reason, route(`replay-${index}`))));
  assert.ok(repeated.every(task => task.taskId === approvedTask.taskId));
  let rows = await notifications();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.message_id, original.messageId);
  assert.equal(rows[0]!.group_openid, original.groupOpenid);
  assert.equal((rows[0]!.message_at as Date).toISOString(), original.timestamp);
  assert.equal(rows[0]!.status, "pending");
  const otherSource = merchantSourceKey(identity, "other-group");
  await assert.rejects(store.request(identity, otherSource, approvedOrder, reason, { ...original, groupOpenid: "other-group" }));
  assert.equal((await notifications()).length, 1);

  const rejectedTask = await store.request(identity, sourceKey, rejectedOrder, reason, route("reject-confirmation"));
  const timeoutTask = await store.request(identity, sourceKey, timeoutOrder, reason, route("timeout-confirmation"));
  const cliTask = await store.request(identity, sourceKey, cliOrder, reason);
  await store.request(identity, sourceKey, cliOrder, reason, route("late-route"));
  assert.ok(!(await notifications()).some(row => row.task_id === cliTask.taskId), "old/CLI tasks cannot acquire a route on replay");
  assert.equal(await store.applyResult({ taskId: approvedTask.taskId, orderId: approvedOrder, status: "approved", approvedAmountCents: 7980 }), true);
  assert.equal(await store.applyResult({ taskId: rejectedTask.taskId, orderId: rejectedOrder, status: "rejected", approvedAmountCents: null }), true);
  await fixture.expire(timeoutOrder);
  await store.processDue();
  const ready = await pending();
  assert.equal(ready.length, 3, "approved/rejected/timed_out all become eligible for notification");
  assert.deepEqual(ready.find(item => item.taskId === approvedTask.taskId), {
    taskId: approvedTask.taskId, orderId: approvedOrder, sourceKey, ...identity, ...original,
  });
  assert.equal((await store.getTask(identity, sourceKey, timeoutOrder))?.status, "timed_out");
  assert.equal((await store.listNotifications("OTHER_APP")).length, 0);
  assert.equal(await store.claimNotification(approvedTask.taskId, "OTHER_APP"), false);
  assert.equal(await store.claimNotification(randomUUID(), identity.appId), false);
  await assert.rejects(store.listNotifications("*"));
  await assert.rejects(store.claimNotification("invalid", identity.appId));
  const claimed = await Promise.all(Array.from({ length: 8 }, () => store.claimNotification(approvedTask.taskId, identity.appId)));
  assert.equal(claimed.filter(Boolean).length, 1, "concurrent delivery attempts may claim only once");
  await assert.rejects(store.finishNotification(approvedTask.taskId, "OTHER_APP", "sent"));
  await store.finishNotification(approvedTask.taskId, identity.appId, "sent");
  await assert.rejects(store.finishNotification(approvedTask.taskId, identity.appId, "unknown"));
  await store.request(identity, sourceKey, approvedOrder, reason, route("after-sent-replay"));
  assert.equal(await store.claimNotification(approvedTask.taskId, identity.appId), false);
  assert.equal(await store.claimNotification(rejectedTask.taskId, identity.appId), true);
  await store.finishNotification(rejectedTask.taskId, identity.appId, "deferred");
  assert.equal(await store.claimNotification(timeoutTask.taskId, identity.appId), true);
  await store.finishNotification(timeoutTask.taskId, identity.appId, "unknown");
  rows = await notifications();
  for (const [taskId, status] of [[approvedTask.taskId, "sent"], [rejectedTask.taskId, "deferred"], [timeoutTask.taskId, "unknown"]]) {
    const row = rows.find(item => item.task_id === taskId)!;
    assert.equal(row.status, status);
    assert.ok(row.claimed_at && row.finished_at);
    assert.equal(await store.claimNotification(taskId!, identity.appId), false);
  }
  assert.equal(rows.find(row => row.task_id === approvedTask.taskId)!.message_id, original.messageId);
  assert.equal((await pending()).length, 0);

  const recovered = await store.request(identity, sourceKey, restartOrder, reason, route("restart-pending"));
  const interrupted = await store.request(identity, sourceKey, claimedOrder, reason, route("restart-claimed"));
  await store.applyResult({ taskId: recovered.taskId, orderId: restartOrder, status: "approved", approvedAmountCents: 7980 });
  await store.applyResult({ taskId: interrupted.taskId, orderId: claimedOrder, status: "approved", approvedAmountCents: 7980 });
  assert.equal(await store.claimNotification(interrupted.taskId, identity.appId), true);
  await store.close();
  pool = createPool(readAfterSalesDatabaseConfig());
  store = new AfterSalesStore(pool);
  assert.deepEqual((await pending()).map(item => item.taskId), [recovered.taskId], "pending survives restart; claimed is never replayed");
  assert.equal(await store.claimNotification(interrupted.taskId, identity.appId), false);
  await fixture.setTiming(pollingOrder, 1);
  let called = 0, polls = 0;
  const notificationGate = deferred(), notificationStarted = deferred(), pollGate = deferred(), secondPoll = deferred(), nextTaskReady = deferred();
  const processDue = store.processDue.bind(store);
  store.processDue = async () => {
    polls++;
    if (polls === 2) await nextTaskReady.promise;
    const result = await processDue();
    if (polls === 2) { secondPoll.resolve(); await pollGate.promise; }
    return result;
  };
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    stopWorker = startMockMerchant(store, { intervalMs: 20, afterProcess: async () => {
      called++;
      notificationStarted.resolve();
      await notificationGate.promise;
    } });
    await notificationStarted.promise;
    await store.request(identity, sourceKey, pollingOrder, reason);
    await sleep(2);
    nextTaskReady.resolve();
    await Promise.race([secondPoll.promise, new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error("slow notification blocked merchant polling")), 2000);
    })]);
    clearTimeout(guard);
    assert.equal((await store.getTask(identity, sourceKey, pollingOrder))?.status, "approved", "another merchant task completes while a notification is blocked");
    await sleep(60);
    assert.equal(polls, 2, "only one processDue may be in flight");
    assert.equal(called, 1, "slow notifications do not re-enter on subsequent polling ticks");
    let stopped = false;
    const stopping = stopWorker().then(() => { stopped = true; });
    notificationGate.resolve();
    await sleep(10);
    assert.equal(stopped, false, "shutdown still waits for processDue after notification processing ends");
    pollGate.resolve();
    await stopping;
    stopWorker = undefined;
    assert.equal(called, 1, "stop prevents any new notification dispatch");
    assert.equal(polls, 2);
  } finally {
    clearTimeout(guard);
    notificationGate.resolve(); pollGate.resolve(); nextTaskReady.resolve();
    await stopWorker?.();
    stopWorker = undefined;
    store.processDue = processDue;
  }
  const lastNotification = deferred(), lastStarted = deferred();
  try {
    stopWorker = startMockMerchant(store, { intervalMs: 20, afterProcess: async () => {
      lastStarted.resolve();
      await lastNotification.promise;
    } });
    await lastStarted.promise;
    let stopped = false;
    const stopping = stopWorker().then(() => { stopped = true; });
    await sleep(10);
    assert.equal(stopped, false, "shutdown also waits for notifications when processDue is finished");
    lastNotification.resolve();
    await stopping;
    stopWorker = undefined;
  } finally {
    lastNotification.resolve();
    await stopWorker?.();
    stopWorker = undefined;
  }
  assert.equal(await store.claimNotification(recovered.taskId, identity.appId), true);
  await store.finishNotification(recovered.taskId, identity.appId, "deferred");
  assert.deepEqual(await facts(), before, "notifications cannot modify orders or refunds");
  for (const sql of ["DELETE FROM merchant_notifications WHERE 1=0", "UPDATE orders SET status=status WHERE 1=0", "UPDATE refunds SET status=status WHERE 1=0", "UPDATE qq_identities SET customer_id=customer_id WHERE 1=0"]) {
    await assert.rejects(pool.execute(sql), denied);
  }
  await assert.rejects(business.execute("UPDATE merchant_notifications SET status=status WHERE 1=0"), denied);
  await assert.rejects(refunds.execute("SELECT task_id FROM merchant_notifications LIMIT 1"), denied);
  console.log("商家通知 MySQL 检查通过：原路由持久、重复确认不改向、CLI 无通知、来源与身份校验、三种终态、并发唯一领取、重启恢复/不重发、慢通知不阻塞商家轮询、两类任务不重入及停机等待和最小权限；订单与退款未变更。");
} finally {
  await stopWorker?.();
  await Promise.allSettled([store.close(), business.end(), refunds.end()]);
  await fixture.cleanup();
}
