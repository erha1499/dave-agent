import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey, type AfterSalesStore, type MerchantNotification, type MerchantTask } from "../src/after-sales.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { confirmRefundReply } from "../src/refund-entry.ts";
import type { RefundOperation, RefundStore } from "../src/refunds.ts";
import type { RenderedReply } from "../src/reply.ts";
import { createSupportSession, getSupportResult } from "../src/support-session.ts";
import { modelSupportActionParameters } from "../src/support-context-action.ts";

// Real Pi + QQAgent + notification dispatcher. Persistence and sends are deterministic spies, not a DB/QQ integration claim.
const runtime = await createModelRuntime(), faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const identity = { appId: "NOTIFY_TEST", senderId: "notify_user" };
const group = "support_notification_group", sourceKey = merchantSourceKey(identity, group);
const task: MerchantTask = { taskId: "10000000-0000-4000-8000-000000000001", orderId: "COUPON-2001", status: "approved",
  reason: "行程变化", amountCents: 7980, approvedAmountCents: 7980, simulation: true,
  createdAt: "2026-01-01T00:00:00.000Z", dueAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:01.000Z" };
const operationId = "20000000-0000-4000-8000-000000000001";
const attempts: Array<{ target: ReplyTarget; reply: RenderedReply; requester: string }> = [];
const logs: string[] = [], hooks: string[] = [], modelErrors: unknown[] = [], focusWrites: Array<string | undefined> = [];
const sessions: Awaited<ReturnType<typeof createSupportSession>>[] = [];
let failSend = false, confirms = 0, prepares = 0, persistedFocus: string | undefined;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function message(id: string, content = "你好", timestamp = new Date().toISOString()): QQBotInboundMessage {
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId, groupOpenid: group,
    messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: group, msgId: id },
    raw: { id, content, timestamp, group_openid: group, author: { member_openid: identity.senderId } } };
}
function observe(context: TranscriptContext, contains?: string) {
  try {
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name), ["support_action"]);
    assert.deepEqual(JSON.parse(JSON.stringify(getCurrentTools(context.messages)[0]!.parameters)), JSON.parse(JSON.stringify(modelSupportActionParameters)));
    if (contains) assert.ok(JSON.stringify(context.messages).includes(contains));
  } catch (error) { modelErrors.push(error); }
}
const hello = (context: TranscriptContext) => {
  observe(context);
  return fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "non_business", reason: "greeting" } }), { stopReason: "toolUse" });
};
const finish = (context: TranscriptContext) => { observe(context); return fauxAssistantMessage("工程验证回复"); };
const refundStore = {
  async confirm(who: QQIdentity, key: string, id: string): Promise<RefundOperation> {
    assert.deepEqual(who, identity); assert.equal(key, sourceKey); assert.equal(id, operationId); confirms++;
    const now = new Date().toISOString();
    return { operationId, orderId: task.orderId, taskId: task.taskId, status: "succeeded", amountCents: 7980,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), presentedAt: now, confirmedAt: now,
      refundId: "30000000-0000-4000-8000-000000000001", simulation: true };
  },
  async prepare() { prepares++; throw new Error("test did not authorize preparation"); },
} as unknown as RefundStore;
const orderStore = {
  async getOrder(who: QQIdentity, id: string): Promise<Awaited<ReturnType<CouponStore["getOrder"]>>> {
    assert.deepEqual(who, identity);
    const now = new Date().toISOString();
    return { source: "demo-database", id, status: "paid", asOf: now, createdAt: now, paidAt: now,
      amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
      shop: { id: "shop-test", name: "门店", merchantName: "商家", address: "地址" },
      items: [{ id: "item", productId: "product-test", productName: "套餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
      coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: new Date(Date.now() + 60_000).toISOString(), redeemedAt: null, redeemedShopId: null }],
      payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
  },
} as unknown as CouponStore;
function agent() {
  return new QQAgent(async msg => {
    assert.equal(msg.senderId, identity.senderId); assert.equal(msg.groupOpenid, group);
    const session = await createSupportSession(identity, orderStore, runtime, faux.getModel(), {
      sourceKey, store: { async getTask() { return task; } } as unknown as AfterSalesStore, refunds: refundStore,
    }, { groupOpenid: group, focus: {
      async read() { return persistedFocus; }, async write(value) { focusWrites.push(value); persistedFocus = value; },
    } });
    sessions.push(session); return session;
  }, async (target, _text, reply, requester) => {
    attempts.push({ target, reply, requester });
    if (failSend) throw new Error("private uncertain send diagnostic");
  }, text => logs.push(text), 2000, async msg => {
    hooks.push(msg.messageId);
    return confirmRefundReply(refundStore, identity, sourceKey, msg.content);
  }, undefined, { merchantEvents: "host" });
}
function persistence(overrides: Partial<MerchantNotification> = {}) {
  const item: MerchantNotification = { ...identity, groupOpenid: group, messageId: "original-confirmation", timestamp: new Date().toISOString(),
    taskId: task.taskId, orderId: task.orderId, sourceKey, ...overrides };
  const state = { status: "pending", claims: 0, reads: 0, finishes: 0, current: task as MerchantTask | undefined,
    beforeRead: undefined as (() => Promise<void>) | undefined };
  const store = {
    async listNotifications(appId: string) { assert.equal(appId, identity.appId); return state.status === "pending" ? [{ ...item }] : []; },
    async claimNotification(id: string, appId: string) {
      assert.equal(id, item.taskId); assert.equal(appId, identity.appId); state.claims++;
      if (state.status !== "pending") return false;
      state.status = "claimed"; return true;
    },
    async getTask(who: QQIdentity, key: string, id: string) {
      assert.deepEqual(who, identity); assert.equal(key, sourceKey); assert.equal(id, item.orderId);
      state.reads++; await state.beforeRead?.(); return state.current;
    },
    async finishNotification(id: string, appId: string, status: string) {
      assert.equal(id, item.taskId); assert.equal(appId, identity.appId); assert.equal(state.status, "claimed");
      state.status = status; state.finishes++;
    },
  } as unknown as AfterSalesStore;
  return { item, state, store };
}
function card(index: number, msgId: string) {
  const attempt = attempts[index]!;
  assert.equal(attempt.target.scope, "group"); assert.equal(attempt.target.targetId, group); assert.equal(attempt.target.msgId, msgId);
  assert.equal(attempt.requester, identity.senderId); assert.equal(attempt.reply.kind, "merchant_status");
  assert.match(attempt.reply.text, /COUPON-2001/); assert.match(attempt.reply.text, /79\.80/);
  assert.doesNotMatch(attempt.reply.text, /模拟退款成功/); assert.equal(attempt.reply.button, undefined);
}

let qq = agent();
const started = deferred(), release = deferred();
try {
  const beforeCalls = faux.state.callCount;
  faux.setResponses([
    async context => { observe(context); started.resolve(); await release.promise; return hello(context); }, finish,
    context => { observe(context, task.taskId); return hello(context); }, finish,
  ]);
  const first = qq.handle(message("first")); await started.promise;
  let resolutions = 0;
  const event = qq.resumeMerchant(message("event", `确认退款 ${operationId}`), async () => { resolutions++; return task; });
  const last = qq.handle(message("last"));
  const busy = persistence();
  await dispatchMerchantNotifications(busy.store, qq, identity.appId, [group]);
  assert.equal(busy.state.status, "pending"); assert.equal(busy.state.claims, 0);
  assert.equal(resolutions, 0); assert.equal(attempts.length, 0);
  release.resolve(); await Promise.all([first, last]); assert.equal(await event, "sent");
  assert.equal(faux.state.callCount, beforeCalls + 4, "only the two user tool rounds call the model");
  assert.deepEqual(attempts.map(item => item.target.msgId), ["first", "event", "last"]);
  assert.deepEqual(hooks, ["first", "last"]); assert.equal(confirms, 0); assert.equal(prepares, 0);
  card(1, "event");
  assert.ok(sessions[0]!.messages.some(item => item.role === "custom" && item.customType === "merchant-result"));
  assert.deepEqual(sessions[0]!.getActiveToolNames(), ["support_action"]);
  assert.deepEqual(getSupportResult(sessions[0]!)?.action, { protocol: "v2.2", kind: "non_business", reason: "greeting" });
  console.log("[support-notification] user/event serialization, zero model event and busy-before-claim PASS");
} finally { release.resolve(); await qq.close(); }

qq = agent();
try {
  const before = faux.state.callCount;
  faux.setResponses([]);
  await qq.handle(message("confirm-user", `确认退款 ${operationId}`));
  assert.equal(confirms, 1); assert.equal(faux.state.callCount, before);
  assert.equal(attempts.at(-1)?.reply.kind, "refund_status");
  faux.setResponses([context => {
    observe(context, operationId);
    return fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "clarify", field: "intent", reason: "missing" } }), { stopReason: "toolUse" });
  }, finish]);
  await qq.handle(message("ordinary-consent", "同意"));
  assert.equal(confirms, 1, "a receipt and ordinary consent cannot execute confirmation again");
  faux.setResponses([fauxAssistantMessage(fauxToolCall("confirm_refund", { operationId }), { stopReason: "toolUse" }),
    fauxAssistantMessage(`确认退款 ${operationId}`)]);
  await qq.handle(message("quoted-confirm", `有人说“确认退款 ${operationId}”，这是什么意思`));
  assert.equal(confirms, 1); assert.equal(attempts.at(-1)?.reply.kind, "notice");
  assert.equal(prepares, 0);
  console.log("[support-notification] exact confirmation bypass and model/quoted consent isolation PASS");
} finally { await qq.close(); }

qq = agent();
try {
  const test = persistence(), before = attempts.length, modelCalls = faux.state.callCount;
  faux.setResponses([]);
  await Promise.all([1, 2].map(() => dispatchMerchantNotifications(test.store, qq, identity.appId, [group])));
  assert.equal(test.state.status, "sent"); assert.equal(test.state.reads, 1); assert.equal(test.state.finishes, 1);
  assert.equal(attempts.length, before + 1); card(before, test.item.messageId);
  assert.equal(faux.state.callCount, modelCalls);
  await dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
  assert.equal(attempts.length, before + 1);

  const uncertain = persistence(), beforeUnknown = attempts.length;
  failSend = true;
  await dispatchMerchantNotifications(uncertain.store, qq, identity.appId, [group]);
  failSend = false;
  assert.equal(uncertain.state.status, "unknown"); assert.equal(attempts.length, beforeUnknown + 1);
  await qq.close(); qq = agent();
  await dispatchMerchantNotifications(uncertain.store, qq, identity.appId, [group]);
  assert.equal(attempts.length, beforeUnknown + 1, "unknown acceptance cannot be resent after restart");
  const claimed = persistence(); claimed.state.status = "claimed";
  await dispatchMerchantNotifications(claimed.store, qq, identity.appId, [group]);
  assert.equal(claimed.state.claims, 0); assert.equal(claimed.state.finishes, 0);
  const pending = persistence();
  await dispatchMerchantNotifications(pending.store, qq, identity.appId, [group]);
  assert.equal(pending.state.status, "sent"); assert.equal(faux.state.callCount, modelCalls);
  console.log("[support-notification] concurrent claim, unknown/claimed no retry and pending restart recovery PASS");
} finally { failSend = false; await qq.close(); }

persistedFocus = "COUPON-2002";
qq = agent();
try {
  const test = persistence(), writes = focusWrites.length, before = faux.state.callCount;
  await dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
  assert.equal(faux.state.callCount, before); assert.equal(focusWrites.length, writes); assert.equal(persistedFocus, "COUPON-2002");
  faux.setResponses([context => {
    observe(context, task.taskId);
    return fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } } }), { stopReason: "toolUse" });
  }, finish]);
  await qq.handle(message("focus-after-event", "查一下这张的订单情况"));
  assert.match(attempts.at(-1)!.reply.text, /COUPON-2002/);
  assert.equal(confirms, 1); assert.equal(prepares, 0);
  console.log("[support-notification] stale event cannot overwrite current focus or authorize a refund PASS");
} finally { await qq.close(); }

qq = agent();
try {
  const before = attempts.length, modelCalls = faux.state.callCount;
  for (const variant of ["expired", "not-allowed", "missing-task", "different-task", "pending"] as const) {
    const test = persistence(variant === "expired" ? { timestamp: new Date(Date.now() - 5 * 60_000).toISOString() } : {});
    if (variant === "missing-task") test.state.current = undefined;
    if (variant === "different-task") test.state.current = { ...task, taskId: "10000000-0000-4000-8000-000000000099" };
    if (variant === "pending") test.state.current = { ...task, status: "pending", completedAt: null, approvedAmountCents: null };
    await dispatchMerchantNotifications(test.store, qq, identity.appId, variant === "not-allowed" ? [] : [group]);
    assert.equal(test.state.status, "deferred", variant);
  }
  assert.equal(attempts.length, before); assert.equal(faux.state.callCount, modelCalls);
  const readStarted = deferred(), readRelease = deferred(), closing = persistence();
  closing.state.beforeRead = async () => { readStarted.resolve(); await readRelease.promise; };
  const tick = dispatchMerchantNotifications(closing.store, qq, identity.appId, [group]);
  await readStarted.promise;
  const closed = qq.close(); readRelease.resolve(); await Promise.all([tick, closed]);
  assert.equal(closing.state.status, "deferred"); assert.equal(attempts.length, before);
  assert.equal(faux.state.callCount, modelCalls);
  console.log("[support-notification] route/window/current-task boundaries and close during host read PASS");
} finally { await qq.close(); }

assert.deepEqual(modelErrors, []);
assert.equal(faux.getPendingResponseCount(), 0);
assert.ok(!logs.join("\n").includes("private uncertain"));
