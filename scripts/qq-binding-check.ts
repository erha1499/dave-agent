import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey, type AfterSalesStore, type MerchantTask } from "../src/after-sales.ts";
import { OrderAccessError, type CouponStore } from "../src/coupon-store.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import type { RefundStore } from "../src/refunds.ts";
import type { RenderedReply } from "../src/reply.ts";

type Binding = { bindingId: string; customerId: string };
const a = { bindingId: "binding-a", customerId: "customer-a" };
const changed = [undefined, { bindingId: "binding-b", customerId: "customer-b" }, { ...a, bindingId: "binding-a-new" }];
const privateFact = "PRIVATE_A_OLD_ORDER", identity = { appId: "BINDING_TEST", senderId: "binding_user" }, group = "binding_group";
const sourceKey = merchantSourceKey(identity, group), orderId = "COUPON-2001";
const task: MerchantTask = { taskId: "00000000-0000-4000-8000-000000000001", orderId, status: "approved", reason: "行程变化",
  amountCents: 7980, approvedAmountCents: 7980, simulation: true, createdAt: "2026-01-01T00:00:00.000Z",
  dueAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:01.000Z" };
const message = (id: string, content = "公开规则如何规定？"): QQBotInboundMessage => {
  const timestamp = new Date().toISOString();
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId, groupOpenid: group,
    messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: group, msgId: id },
    raw: { id, content, timestamp, group_openid: group, author: { member_openid: identity.senderId } } };
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function waitStart(started: Promise<void>, pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, pending.then(() => { throw new Error("[qq-binding] 未进入阻塞点，本轮已结束。"); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("[qq-binding] 等待阻塞点超过5秒。")), 5000); })]);
  } finally { clearTimeout(timer); }
}

export async function checkQQBinding() {
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  let controls = 0;
  await assert.rejects(waitStart(deferred().promise, Promise.resolve()), /未进入阻塞点/);
  async function fixture(merchantEvents: "host" | "model" = "model") {
    const state = { binding: a as Binding | undefined, readError: false, reads: 0, hostWrites: 0, orderReads: 0, sendError: false,
      afterDelivers: 0, afterHost: () => {}, beforeBindingRead: async () => {} };
    const contexts: string[] = [], sends: RenderedReply[] = [], sessions: Awaited<ReturnType<typeof createCouponSession>>[] = [], logs: string[] = [];
    const now = new Date().toISOString();
    const order = { source: "demo-database" as const, id: orderId, status: "paid", asOf: now, createdAt: now, paidAt: now,
      amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
      shop: { id: "shop-binding", name: privateFact, merchantName: "合成商家", address: "合成地址" },
      items: [{ id: "item-binding", productId: "product-binding", productName: privateFact, quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
      coupons: [{ id: "coupon-binding", orderItemId: "item-binding", status: "unused", expiresAt: null, redeemedAt: null, redeemedShopId: null }],
      payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
    const store = {
      async getOrder() { state.orderReads++; if (state.binding?.customerId !== a.customerId) throw new OrderAccessError("未找到当前客户可查询的订单。"); return structuredClone(order); },
      async listOrders() { if (state.binding?.customerId !== a.customerId) throw new OrderAccessError("未找到当前客户可查询的订单。");
        return { source: "demo-database", asOf: now, hasMore: false, orders: [{ id: orderId, status: "paid", paidCents: 7980,
          refundedCents: 0, couponStatuses: ["unused"], productName: "双人午餐", shopName: privateFact, createdAt: now }] }; },
      async searchKnowledge() { return [{ source: "demo-knowledge", sourceId: "KB-BINDING-PUBLIC", title: "公开查询说明",
        body: "公开规则可查询，具体订单须由本人重新授权读取。", scope: { shopId: null, productId: null } }]; },
    } as unknown as CouponStore;
    const merchant = { async getTask() { return structuredClone(task); }, async prepare() { state.hostWrites++; throw new Error("unexpected write"); } } as unknown as AfterSalesStore;
    const options = { merchantEvents, async resolveBinding(msg: QQBotInboundMessage) {
      assert.equal(msg.senderId, identity.senderId); assert.equal(msg.groupOpenid, group); state.reads++; await state.beforeBindingRead();
      if (state.readError) throw new Error("synthetic private binding failure"); return structuredClone(state.binding);
    } };
    const agent = new QQAgent(async () => {
      const session = await createCouponSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey,
        refunds: { async prepare() { state.hostWrites++; throw new Error("unexpected write"); } } as unknown as RefundStore });
      sessions.push(session); return session;
    }, async (_target, _text, reply) => { sends.push(reply); if (state.sendError) throw new Error("synthetic private uncertain send"); },
    text => logs.push(text), 2000, async msg => {
      if (msg.content !== "宿主确认") return undefined;
      state.hostWrites++; state.afterHost(); return `持久业务回执 ${privateFact}`;
    }, async () => { state.afterDelivers++; }, options);
    const response = (reply = "公开咨询已完成", effect = () => {}) => (context: TranscriptContext) => {
      contexts.push(JSON.stringify(context.messages)); effect(); return fauxAssistantMessage(reply);
    };
    const publicQuery = (context: TranscriptContext) => {
      contexts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(fauxToolCall("search_faq", { query: "公开规则如何规定" }), { stopReason: "toolUse" });
    };
    async function warm() {
      faux.setResponses([context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxToolCall("get_order", { orderId }), { stopReason: "toolUse" }); }, response()]);
      await agent.handle(message("private-order", `查询订单 ${orderId}`));
      assert.equal(state.orderReads, 1); assert.ok(contexts.at(-1)!.includes(privateFact), "positive control uses an actual successful private tool result");
      assert.equal(sends.at(-1)!.kind, "order"); assert.ok(sends.at(-1)!.text.includes(orderId)); assert.equal(sessions.length, 1);
    }
    async function recover() {
      const before = contexts.length; faux.setResponses([publicQuery, response()]); await agent.handle(message("recovery"));
      assert.equal(contexts.length, before + 2); assert.ok(contexts.slice(before).every(context => !context.includes(privateFact)), "replacement provider input contains no old private tool results or receipts");
      assert.match(sends.at(-1)!.text, /公开规则可查询，具体订单须由本人重新授权读取。/);
      assert.doesNotMatch(sends.at(-1)!.text, /PRIVATE_A_OLD_ORDER|公开咨询已完成/); assert.equal(sessions.length, 2);
    }
    async function finish() { assert.equal(faux.getPendingResponseCount(), 0); assert.ok(!logs.join("\n").includes("synthetic private")); await agent.close(); }
    return { state, agent, contexts, sends, sessions, response, publicQuery, warm, recover, finish };
  }
  async function run(check: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, mode?: "host" | "model") {
    const f = await fixture(mode); try { await check(f); controls++; } finally { await f.finish(); }
  }

  await run(async f => {
    await f.warm(); faux.setResponses([f.response()]); await f.agent.handle(message("same-binding"));
    assert.ok(f.contexts.at(-1)!.includes(privateFact), "unchanged bindings retain history rather than rebuilding every turn"); assert.equal(f.sessions.length, 1);
  });
  await run(async f => {
    f.state.binding = undefined; faux.setResponses([f.publicQuery, f.response(), f.publicQuery, f.response()]);
    await f.agent.handle(message("unbound-first")); await f.agent.handle(message("unbound-second"));
    assert.equal(f.sessions.length, 1); assert.equal(f.contexts.length, 4);
    assert.equal(JSON.parse(f.contexts[3]!).filter((item: { role: string }) => item.role === "user").length, 2);
    assert.equal(f.sends.length, 2, "unbound users can still ask public questions");
    assert.ok(f.sends.every(reply => reply.kind === "answer" && reply.text.includes("公开规则可查询，具体订单须由本人重新授权读取。")
      && reply.text.includes("依据：KB-BINDING-PUBLIC") && !reply.text.includes("公开咨询已完成")));
  });
  // A→undefined and A→B are the original baseline 0/2 history-protection failures.
  for (const binding of changed) await run(async f => { await f.warm(); f.state.binding = binding; await f.recover(); });
  for (const binding of changed) await run(async f => {
    await f.agent.handle(message("discovery", "我要退款")); assert.equal(f.sends.at(-1)!.kind, "order");
    f.state.binding = binding; const before = faux.state.callCount;
    await f.agent.handle(message("old-card", `选择订单 ${orderId}`));
    assert.equal(faux.state.callCount, before); assert.equal(f.state.orderReads, 0, "old cards cannot authorize or continue the old refund request");
    assert.match(f.sends.at(-1)!.text, /选择已失效/); assert.equal(f.sessions.length, 2);
  });
  await run(async f => {
    await f.warm(); const calls = faux.state.callCount, sent = f.sends.length; f.state.readError = true;
    await f.agent.handle(message("dequeue-error", "宿主确认"));
    assert.equal(faux.state.callCount, calls); assert.equal(f.state.hostWrites, 0); assert.equal(f.sends.length, sent);
    f.state.readError = false; await f.recover();
  });
  for (const binding of changed.slice(0, 2)) await run(async f => {
    await f.warm(); const started = deferred(), release = deferred(), sent = f.sends.length;
    faux.setResponses([async context => { f.contexts.push(JSON.stringify(context.messages)); started.resolve(); await release.promise; return fauxAssistantMessage(`迟到 ${privateFact}`); }]);
    const pending = f.agent.handle(message("wait-change"));
    try { await waitStart(started.promise, pending); f.state.binding = binding; release.resolve(); await pending; }
    finally { release.resolve(); await pending; }
    assert.equal(f.sends.length, sent, "authorization revoked during prompt blocks all old facts, including fallback replies"); await f.recover();
  });
  await run(async f => {
    await f.warm(); const sent = f.sends.length; faux.setResponses([f.response(privateFact, () => { f.state.readError = true; })]);
    await f.agent.handle(message("send-read-error")); assert.equal(f.sends.length, sent);
    f.state.readError = false; await f.recover();
  });
  await run(async f => {
    await f.warm(); const sent = f.sends.length, delivered = f.state.afterDelivers;
    faux.setResponses([context => {
      f.contexts.push(JSON.stringify(context.messages)); f.state.binding = changed[1];
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic private provider failure" });
    }]);
    await f.agent.handle(message("failed-model-revoked"));
    assert.equal(f.sends.length, sent, "model-error catch fallback must reauthorize before sending");
    assert.equal(f.state.afterDelivers, delivered); await f.recover();
  });
  for (const failure of ["change", "read-error"] as const) await run(async f => {
    await f.warm(); const calls = faux.state.callCount, sent = f.sends.length;
    f.state.afterHost = () => { if (failure === "change") f.state.binding = changed[1]; else f.state.readError = true; };
    await f.agent.handle(message(`host-${failure}`, "宿主确认"));
    assert.equal(f.state.hostWrites, 1, "already completed host writes are not retried"); assert.equal(faux.state.callCount, calls);
    assert.equal(f.sends.length, sent, "old host receipts are gated before delivery and history insertion");
    f.state.readError = false; await f.recover();
  });
  for (const mode of ["host", "model"] as const) {
    await run(async f => {
      await f.warm(); const calls = faux.state.callCount, sent = f.sends.length; let resolutions = 0; f.state.readError = true;
      assert.equal(await f.agent.resumeMerchant(message("event-dequeue-error"), async () => { resolutions++; return task; }), "deferred");
      assert.equal(resolutions, 0, "binding read failure precedes notification claims/resolution"); assert.equal(faux.state.callCount, calls); assert.equal(f.sends.length, sent);
      f.state.readError = false; await f.recover();
    }, mode);
    for (const failure of ["change", "read-error"] as const) await run(async f => {
      await f.warm(); const sent = f.sends.length;
      const revoke = () => { if (failure === "change") f.state.binding = changed[1]; else f.state.readError = true; };
      let resolutions = 0;
      if (mode === "model") faux.setResponses([context => { f.contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxToolCall("get_merchant_request", { orderId }), { stopReason: "toolUse" }); }, f.response("事件完成", revoke)]);
      assert.equal(await f.agent.resumeMerchant(message(`event-${mode}-${failure}`), async () => {
        resolutions++; if (mode === "host" && resolutions === 1) revoke(); return task;
      }), "deferred");
      assert.equal(f.sends.length, sent, "host and model merchant events cannot send facts after binding loss/read failure");
      assert.equal(f.state.hostWrites, 0); f.state.readError = false; await f.recover();
    }, mode);
    await run(async f => {
      const calls = faux.state.callCount;
      assert.equal(await f.agent.resumeMerchant(message("event-denied"), async () => undefined), "deferred");
      assert.equal(faux.state.callCount, calls); assert.equal(f.sends.length, 0); assert.equal(f.sessions.length, 0);
    }, mode);
    await run(async f => {
      const ledger = { status: "pending", claims: 0, finishes: 0 };
      const item = { ...identity, groupOpenid: group, messageId: "event-uncertain", timestamp: new Date().toISOString(), sourceKey, taskId: task.taskId, orderId };
      const store = { async listNotifications() { return ledger.status === "pending" ? [item] : []; }, async claimNotification() { ledger.claims++; ledger.status = "claimed"; return true; },
        async getTask() { return task; }, async finishNotification(_task: string, _app: string, status: string) { ledger.status = status; ledger.finishes++; } } as unknown as AfterSalesStore;
      f.state.sendError = true; if (mode === "model") faux.setResponses([f.response("通知完成")]);
      await dispatchMerchantNotifications(store, f.agent, identity.appId, [group]);
      assert.equal(ledger.status, "unknown"); assert.equal(f.sends.length, 1); assert.equal(ledger.claims, 1); assert.equal(ledger.finishes, 1);
      const calls = faux.state.callCount; await dispatchMerchantNotifications(store, f.agent, identity.appId, [group]);
      assert.equal(f.sends.length, 1); assert.equal(faux.state.callCount, calls); assert.equal(ledger.claims, 1, "unknown sends are never automatically reclaimed or retried");
    }, mode);
  }
  for (const stop of ["close", "expire"] as const) await run(async f => {
    const started = deferred(), release = deferred(), originalNow = Date.now; let now = originalNow();
    f.state.beforeBindingRead = async () => { if (f.state.reads === 2) { started.resolve(); await release.promise; } };
    const msg = message(`send-read-wait-${stop}`);
    if (stop === "expire") Date.now = () => now;
    const pending = f.agent.resumeMerchant(msg, async () => task); let closing: Promise<void> | undefined;
    try {
      await waitStart(started.promise, pending);
      closing = stop === "close" ? f.agent.close() : undefined; if (stop === "expire") now += 270_000;
      release.resolve(); assert.equal(await pending, "deferred"); await closing;
      assert.equal(f.sends.length, 0); assert.equal(f.state.afterDelivers, 0);
      assert.ok(!f.sessions[0]!.messages.some(item => item.role === "custom" && item.customType === "merchant-result"), "stopped sends cannot insert a delivery receipt");
    } finally { release.resolve(); try { await Promise.all([pending, closing]); } finally { Date.now = originalNow; } }
  }, "host");
  console.log(`[qq-binding] ${controls}/${controls} deterministic controls passed: actual QQAgent/Pi/faux, private tool-result history, row/customer transitions, old cards, read failures, prompt races, host receipts and both merchant event paths; 0 remote model/DB/QQ, no model-quality or atomic-delivery claim.`);
  return controls;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkQQBinding();
