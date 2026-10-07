import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey, type AfterSalesStore, type MerchantNotification, type MerchantTask } from "../src/after-sales.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent, validQQMessage } from "../src/qq-agent.ts";
import type { RefundStore } from "../src/refunds.ts";
import type { RenderedReply } from "../src/reply.ts";

// Real Pi and QQAgent; scripted model and tiny persistence spies. SQL/atomic claims are checked separately.
const identity = { appId: "123", senderId: "notification_user" };
const group = "notification_group", sourceKey = merchantSourceKey(identity, group);
const task: MerchantTask = {
  taskId: "00000000-0000-4000-8000-000000000001", orderId: "COUPON-2001", status: "approved",
  reason: "行程变化", amountCents: 7980, approvedAmountCents: 7980, simulation: true,
  createdAt: "2026-01-01T00:00:00.000Z", dueAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:01.000Z",
};
const allTools = ["get_merchant_request", "get_order", "get_refund", "prepare_merchant_request", "prepare_refund", "search_faq"];
const [prompt, skill] = await Promise.all([
  readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
  readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
]);
const expectedPrompt = `${prompt.trim()}\n\n${skill.trim()}`;
const runtime = await createModelRuntime(), faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const sessions: Awaited<ReturnType<typeof createCouponSession>>[] = [];
const attempts: Array<{ target: ReplyTarget; reply: RenderedReply; requester: string }> = [];
const hooks: string[] = [], logs: string[] = [], modelErrors: unknown[] = [];
let prepareCalls = 0, failSend = false;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function message(id: string, content = "继续咨询", timestamp = new Date().toISOString()): QQBotInboundMessage {
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId, groupOpenid: group,
    messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: group, msgId: id },
    raw: { id, content, timestamp, group_openid: group, author: { member_openid: identity.senderId } } };
}
function inputs(context: TranscriptContext, tools: string[]) {
  // Pi turns callback errors into model errors: retain them so a safe fallback cannot hide a failed assertion.
  try {
    assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
    assert.deepEqual(getCurrentTools(context.messages).map(item => item.name).sort(), tools);
  } catch (error) { modelErrors.push(error); throw error; }
}
function agent(merchantEvents: "model" | "host" = "model", afterCreate?: () => void) {
  return new QQAgent(async msg => {
    assert.equal(msg.senderId, identity.senderId); assert.equal(msg.groupOpenid, group);
    const session = await createCouponSession(identity, {} as CouponStore, runtime, faux.getModel(), {
      sourceKey,
      store: {
        async getTask(actual: QQIdentity, key: string, orderId: string) {
          assert.deepEqual(actual, identity); assert.equal(key, sourceKey);
          return { ...task, orderId };
        },
        async prepare() { prepareCalls++; throw new Error("event must not prepare merchant actions"); },
      } as unknown as AfterSalesStore,
      refunds: { async prepare() { prepareCalls++; throw new Error("event must not prepare refunds"); } } as unknown as RefundStore,
    });
    sessions.push(session); afterCreate?.(); return session;
  }, async (target, _text, reply, requester) => {
    attempts.push({ target, reply, requester });
    if (failSend) throw new Error("synthetic private send uncertainty");
  }, text => logs.push(text), 1000, async msg => { hooks.push(msg.messageId!); return undefined; }, undefined, { merchantEvents });
}
function persistence(overrides: Partial<MerchantNotification> = {}) {
  const item: MerchantNotification = { ...identity, groupOpenid: group, messageId: "original-confirmation",
    timestamp: new Date().toISOString(), taskId: task.taskId, orderId: task.orderId, sourceKey, ...overrides };
  const state = { status: "pending", claims: 0, reads: 0, finishes: 0, current: task as MerchantTask | undefined, readError: false };
  const store = {
    async listNotifications(appId: string) {
      assert.equal(appId, identity.appId); return state.status === "pending" ? [{ ...item }] : [];
    },
    async claimNotification(taskId: string, appId: string) {
      assert.equal(taskId, item.taskId); assert.equal(appId, identity.appId); state.claims++;
      if (state.status !== "pending") return false;
      state.status = "claimed"; return true;
    },
    async getTask(actual: QQIdentity, key: string, orderId: string, options?: { referenceTaskId: string }) {
      assert.deepEqual(actual, identity); assert.equal(key, item.sourceKey); assert.equal(orderId, item.orderId);
      assert.deepEqual(options, { referenceTaskId: item.taskId });
      state.reads++;
      if (state.readError) throw new Error("synthetic authorization read failure");
      return state.current;
    },
    async finishNotification(taskId: string, appId: string, status: string) {
      assert.equal(taskId, item.taskId); assert.equal(appId, identity.appId); assert.equal(state.status, "claimed");
      state.status = status; state.finishes++;
    },
  } as unknown as AfterSalesStore;
  return { item, state, store };
}
function assertCard(index: number, messageId: string) {
  const sent = attempts[index]!;
  assert.equal(sent.target.scope, "group"); assert.equal(sent.target.targetId, group);
  assert.equal(sent.target.msgId, messageId, "notify using the original confirmed message, never a newer user's message");
  assert.equal(sent.requester, identity.senderId); assert.equal(sent.reply.kind, "merchant_status");
  assert.match(sent.reply.text, /COUPON-2001/); assert.match(sent.reply.text, /79\.80 元/);
  assert.doesNotMatch(sent.reply.text, /COUPON-2002|99999|模拟退款成功|真实资金已经到账/);
  assert.equal(sent.reply.button, undefined, "approval notifications must not manufacture refund consent");
}

// A queued event cannot execute user consent, cannot activate write tools, and cannot change its bound receipt.
const started = deferred(), release = deferred();
let qq = agent();
try {
  let resolutions = 0;
  faux.setResponses([
    async context => { inputs(context, allTools); started.resolve(); await release.promise; return fauxAssistantMessage("第一条完成"); },
    context => {
      inputs(context, ["get_merchant_request"]);
      return fauxAssistantMessage(fauxToolCall("prepare_refund", { orderId: task.orderId }), { stopReason: "toolUse" });
    },
    context => {
      inputs(context, ["get_merchant_request"]);
      const denied = context.messages.findLast(item => item.role === "toolResult");
      assert.ok(denied?.role === "toolResult" && denied.toolName === "prepare_refund" && denied.isError);
      return fauxAssistantMessage(fauxToolCall("get_merchant_request", { orderId: "COUPON-2002" }), { stopReason: "toolUse" });
    },
    context => { inputs(context, ["get_merchant_request"]); return fauxAssistantMessage("COUPON-2002 模拟退款成功 99999 元，真实资金已经到账。"); },
    context => {
      inputs(context, allTools);
      assert.ok(JSON.stringify(context.messages).includes("模拟商家已同意 79.80 元"), "next user turn sees the durable host result");
      return fauxAssistantMessage("继续回答规则问题");
    },
  ]);
  const first = qq.handle(message("user-first")); await started.promise;
  const event = qq.resumeMerchant(message("event", "确认退款 00000000-0000-4000-8000-000000000099"), async () => { resolutions++; return task; });
  const last = qq.handle(message("user-last"));
  const busy = persistence();
  await dispatchMerchantNotifications(busy.store, qq, identity.appId, [group]);
  assert.equal(busy.state.status, "pending"); assert.equal(busy.state.claims, 0, "a full queue must not consume its pending notification");
  assert.equal(resolutions, 0); assert.equal(attempts.length, 0, "events must not send a busy reply or interrupt the active user turn");
  release.resolve(); await Promise.all([first, last]); assert.equal(await event, "sent");
  assert.equal(resolutions, 2); assert.equal(prepareCalls, 0);
  assert.deepEqual(hooks, ["user-first", "user-last"], "business event text must never reach the confirmation hook");
  assert.deepEqual(attempts.map(item => item.target.msgId), ["user-first", "event", "user-last"]);
  assertCard(1, "event"); assert.deepEqual(sessions[0]!.getActiveToolNames().sort(), allTools);
  assert.ok(sessions[0]!.messages.some(item => item.role === "custom" && item.customType === "merchant-result"));
  assert.equal(faux.getPendingResponseCount(), 0); assert.deepEqual(modelErrors, []);
} finally { release.resolve(); await qq.close(); }

// Window and identity failures produce no model call or QQ message; durable facts remain queryable.
qq = agent();
try {
  for (const reason of ["expired", "not-allowed", "identity-changed", "wrong-task", "still-pending"] as const) {
    const test = persistence(reason === "expired" ? { timestamp: new Date(Date.now() - 5 * 60_000).toISOString() } : {});
    if (reason === "identity-changed") test.state.current = undefined;
    if (reason === "wrong-task") test.state.current = { ...task, taskId: "00000000-0000-4000-8000-000000000099" };
    if (reason === "still-pending") test.state.current = { ...task, status: "pending", completedAt: null };
    const beforeCalls = faux.state.callCount;
    const beforeAttempts: number = attempts.length;
    await dispatchMerchantNotifications(test.store, qq, identity.appId, reason === "not-allowed" ? [] : [group]);
    assert.equal(test.state.status, "deferred", reason); assert.equal(test.state.finishes, 1);
    assert.equal(faux.state.callCount, beforeCalls, reason); assert.equal(attempts.length, beforeAttempts, reason);
  }
  const invalid = message("bad-target"); invalid.replyTarget.msgId = "different-original-message";
  assert.equal(validQQMessage(invalid), false);
  assert.equal(await qq.resumeMerchant(invalid, async () => { assert.fail("invalid route must not resolve"); }), "deferred");
} finally { await qq.close(); }

// Authorization can change after dequeue, while Pi or session creation is awaited.
for (const path of ["model", "fallback", "host", "read-error", "wrong-task", "pending"] as const) {
  const test = persistence(), before: number = attempts.length, beforeCalls = faux.state.callCount;
  const inFlight = deferred(), continueEvent = deferred();
  qq = agent(path === "host" ? "host" : "model", path === "host" ? () => { test.state.current = undefined; } : undefined);
  try {
    if (path !== "host") faux.setResponses([async context => {
      inputs(context, ["get_merchant_request"]); inFlight.resolve(); await continueEvent.promise;
      return fauxAssistantMessage(path === "fallback" ? "" : "商家结果已完成");
    }]);
    const tick = dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
    if (path !== "host") {
      await inFlight.promise;
      assert.equal(test.state.status, "claimed"); assert.equal(test.state.reads, 1);
      if (path === "read-error") test.state.readError = true;
      else if (path === "wrong-task") test.state.current = { ...task, taskId: "00000000-0000-4000-8000-000000000099" };
      else if (path === "pending") test.state.current = { ...task, status: "pending", completedAt: null };
      else test.state.current = undefined;
      continueEvent.resolve();
    }
    await tick;
    assert.equal(test.state.status, "deferred", `${path}: lost authorization must defer, not send an old result`);
    assert.equal(attempts.length, before, path); assert.equal(test.state.reads, 2, path);
    assert.equal(test.state.claims, 1, "send-time authorization must not claim again");
    assert.equal(test.state.finishes, 1); assert.equal(prepareCalls, 0);
    assert.equal(faux.state.callCount, beforeCalls + (path === "host" ? 0 : 1));
    await dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
    assert.equal(attempts.length, before, "a deferred notification is not retried");
  } finally { continueEvent.resolve(); await qq.close(); }
}

// Re-check the original reply window after waiting in the conversation queue, before claiming or prompting.
const queueStarted = deferred(), queueRelease = deferred();
const realNow = Date.now;
qq = agent();
try {
  const test = persistence(), before = attempts.length;
  faux.setResponses([async context => {
    inputs(context, allTools); queueStarted.resolve(); await queueRelease.promise; return fauxAssistantMessage("迟到的用户回答");
  }]);
  const first = qq.handle(message("window-blocker")); await queueStarted.promise;
  const tick = dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(test.state.claims, 0);
  Date.now = () => realNow() + 5 * 60_000;
  queueRelease.resolve(); await Promise.all([first, tick]);
  assert.equal(test.state.status, "deferred"); assert.equal(test.state.reads, 0);
  assert.equal(attempts.length, before, "neither an expired user reply nor its queued notification may be sent");
} finally { Date.now = realNow; queueRelease.resolve(); await qq.close(); }

// Closing an in-flight event aborts the actual Pi request before any late model text or fixed fallback can send.
const closingStarted = deferred(), closingRelease = deferred();
qq = agent();
try {
  const test = persistence(), before = attempts.length;
  let aborted = false;
  faux.setResponses([async (context, options) => {
    inputs(context, ["get_merchant_request"]);
    const signal = options?.signal;
    assert.ok(signal, "the real Pi request must have an abort signal");
    signal.addEventListener("abort", () => { aborted = true; closingRelease.resolve(); }, { once: true });
    closingStarted.resolve(); await closingRelease.promise;
    return fauxAssistantMessage("关机后才返回的通知文本");
  }]);
  const tick = dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
  await closingStarted.promise;
  assert.equal(test.state.status, "claimed");
  await Promise.all([qq.close(), tick]);
  assert.equal(aborted, true, "closing must abort an active event model request");
  assert.equal(attempts.length, before, "neither late model output nor fallback may send after closing");
  assert.equal(test.state.status, "deferred"); assert.equal(test.state.finishes, 1);
  const calls = faux.state.callCount;
  qq = agent();
  await dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
  assert.equal(faux.state.callCount, calls); assert.equal(attempts.length, before);
  assert.equal(test.state.claims, 1, "a restarted agent must not reclaim the deferred notification");
  assert.equal(faux.getPendingResponseCount(), 0); assert.deepEqual(modelErrors, []);
} finally { closingRelease.resolve(); await qq.close(); }

// Concurrent ticks share the atomic claim. An ambiguous send is terminal; a new process skips claimed rows.
qq = agent();
try {
  const test = persistence(), before = attempts.length;
  faux.setResponses([context => { inputs(context, ["get_merchant_request"]); return fauxAssistantMessage("商家已经同意"); }]);
  await Promise.all([1, 2].map(() => dispatchMerchantNotifications(test.store, qq, identity.appId, [group])));
  assert.equal(test.state.status, "sent"); assert.equal(test.state.finishes, 1);
  assert.equal(attempts.length, before + 1); assertCard(before, test.item.messageId);
  await dispatchMerchantNotifications(test.store, qq, identity.appId, [group]);
  assert.equal(attempts.length, before + 1);

  const failed = persistence(), beforeFailure = attempts.length;
  failSend = true; faux.setResponses([fauxAssistantMessage("通知商家结果")]);
  await dispatchMerchantNotifications(failed.store, qq, identity.appId, [group]);
  failSend = false;
  assert.equal(failed.state.status, "unknown"); assert.equal(attempts.length, beforeFailure + 1);
  await dispatchMerchantNotifications(failed.store, qq, identity.appId, [group]);
  assert.equal(attempts.length, beforeFailure + 1, "an uncertain platform acceptance must never be retried");
  await qq.close(); qq = agent();
  const crashed = persistence(); crashed.state.status = "claimed";
  await dispatchMerchantNotifications(crashed.store, qq, identity.appId, [group]);
  assert.equal(crashed.state.claims, 0); assert.equal(crashed.state.finishes, 0);
  assert.equal(attempts.length, beforeFailure + 1, "restart must not resend a previously claimed event");

  const fallback = persistence(), beforeFallback = attempts.length;
  faux.setResponses([fauxAssistantMessage("")]);
  await dispatchMerchantNotifications(fallback.store, qq, identity.appId, [group]);
  assert.equal(fallback.state.status, "sent"); assert.equal(attempts.length, beforeFallback + 1);
  assertCard(beforeFallback, fallback.item.messageId);
  await qq.close();
  const closed = persistence(), beforeClosed = attempts.length;
  await dispatchMerchantNotifications(closed.store, qq, identity.appId, [group]);
  assert.equal(closed.state.status, "deferred"); assert.equal(attempts.length, beforeClosed);
  assert.equal(faux.getPendingResponseCount(), 0); assert.deepEqual(modelErrors, []);
  assert.ok(!logs.join("\n").includes("synthetic private"));
  console.log("商家结果续接离线检查通过：真实 Pi 队列串行、原 Prompt/只读工具、宿主固定原单回执、确认隔离、排队过期、身份与群限制、发送前重绑/读取异常/错任务/非终态拒发、原消息路由、并发领取、失败不重发、重启跳过已领取、模型失败兜底、关闭中断在途通知且不补发。数据库原子性另行验证。");
} finally { failSend = false; await qq.close(); }
