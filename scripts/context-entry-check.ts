import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { replaceCliSession, runCliPrompt } from "../src/cli.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { ContextBudgetError, currentModelTask, type ModelTaskSummary } from "../src/model-request-budget.ts";
import { prepareOrderDiscoveryPrompt } from "../src/order-discovery.ts";
import { QQAgent } from "../src/qq-agent.ts";
import type { Reply } from "../src/reply.ts";
import { WebChatSessions, WebChatError } from "../src/web-chat.ts";
import { WebChatHistory } from "../src/web-chat-history.ts";
import { createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";

const identity = { appId: "TEST_APP", senderId: "TEST_USER1" };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Context entry check did not settle within 5 seconds")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
function userInputs(context: TranscriptContext) {
  return context.messages.filter(message => message.role === "user").map(message => typeof message.content === "string"
    ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join(""));
}
// Deliberately inject the SDK-normalized failure, not a real payload guard hit.
function contextFailure() {
  const task = currentModelTask(); assert.ok(task);
  task.fail("context_limit");
  return fauxAssistantMessage("", { stopReason: "error", errorMessage: new ContextBudgetError().message });
}
function fixture() {
  let reads = 0, listings = 0;
  const now = new Date().toISOString();
  const summary = { id: "COUPON-1001", status: "paid", paidCents: 7980, refundedCents: 0,
    createdAt: now, productName: "双人午餐", shopName: "云味餐厅", couponStatuses: ["unused"] };
  const order = { source: "demo-database" as const, id: summary.id, status: summary.status, asOf: now,
    createdAt: now, paidAt: now, amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
    shop: { id: "shop-context", name: summary.shopName, merchantName: "测试商家", address: "合成地址" },
    items: [{ id: "item-context", productId: "product-context", productName: summary.productName, quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [{ id: "coupon-context", orderItemId: "item-context", status: "unused", expiresAt: "2099-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
  const store = {
    async resolveBinding(who: QQIdentity) { assert.deepEqual(who, identity); return { bindingId: "context-binding", customerId: "context-customer" }; },
    async listOrders(who: QQIdentity) {
      assert.deepEqual(who, identity); listings++;
      return { source: "demo-database" as const, asOf: now, orders: [structuredClone(summary)], hasMore: false };
    },
    async getOrder(who: QQIdentity, id: string) {
      assert.deepEqual(who, identity); reads++;
      if (id !== order.id) throw new OrderAccessError("未找到当前客户可查询的订单。");
      return structuredClone(order);
    },
    async searchKnowledge() { assert.fail("This recovery check must not invoke knowledge or external services"); },
  } as unknown as CouponStore;
  return { store, counts: () => ({ reads, listings }) };
}
function message(text: string): QQBotInboundMessage {
  const id = randomUUID(), timestamp = new Date().toISOString();
  return { rawEventType: "GROUP_AT_MESSAGE_CREATE", kind: "group", senderId: identity.senderId, groupOpenid: "context-group",
    messageId: id, content: text, timestamp, replyTarget: { scope: "group", targetId: "context-group", msgId: id },
    raw: { id, content: text, timestamp, group_openid: "context-group", author: { member_openid: identity.senderId } } };
}
const orderTool = () => fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" });

export async function checkContextEntries() {
  const previousFetch = globalThis.fetch, previousError = console.error;
  let remoteCalls = 0;
  const summaries: ModelTaskSummary[] = [];
  const capture = (text: string) => {
    if (text.startsWith("[model-task] ")) summaries.push(JSON.parse(text.slice(13)) as ModelTaskSummary);
  };
  globalThis.fetch = async () => { remoteCalls++; throw new Error("Remote transport is forbidden in the context entry check"); };
  console.error = (...values: unknown[]) => { if (typeof values[0] === "string") capture(values[0]); };
  try {
    const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
    const makeSession = (store: CouponStore) => createCouponSession(identity, store, runtime, faux.getModel());
    const catalog = createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "context-entry-synthetic-key" });
    {
      const { store, counts } = fixture(), sent: string[] = [], old = await makeSession(store);
      let replacement: AgentSession | undefined;
      const releaseDrain = deferred(), enteredDrain = deferred();
      let replacing: Promise<AgentSession> | undefined;
      try {
        faux.setResponses([orderTool(), fauxAssistantMessage("订单已查询。")]);
        await within(runCliPrompt(old, "请查询 COUPON-1001", async text => { sent.push(text); }));
        assert.match((await prepareOrderDiscoveryPrompt(old, "我要退款")).prompt, /订单：COUPON-1001/u, "The old Session really has an order focus");
        const before = counts().reads;
        faux.setResponses([orderTool(), contextFailure]);
        await assert.rejects(within(runCliPrompt(old, "再核对一次", async text => { sent.push(text); })), ContextBudgetError);
        assert.equal(counts().reads, before + 1, "A completed read is not rerun to repair a refused explanation");
        assert.equal(sent.length, 1, "The failed turn does not publish an invented answer");
        assert.equal(faux.getPendingResponseCount(), 0);

        const events: string[] = [], abort = old.abort.bind(old), dispose = old.dispose.bind(old);
        old.abort = async () => { events.push("abort"); enteredDrain.resolve(); await releaseDrain.promise; await abort(); events.push("drained"); };
        old.dispose = () => { events.push("dispose"); dispose(); };
        replacing = replaceCliSession(old, async () => {
          events.push("factory"); replacement = await makeSession(store); return replacement;
        });
        await within(enteredDrain.promise);
        assert.deepEqual(events, ["abort"], "A pending drain prevents dispose and replacement creation");
        releaseDrain.resolve(); replacement = await within(replacing);
        assert.deepEqual(events, ["abort", "drained", "dispose", "factory"]);
        assert.notEqual(replacement, old); assert.equal(replacement.messages.length, 0);
        const afterFailure = counts();
        const discovered: { prompt: string; reply?: Reply } = await prepareOrderDiscoveryPrompt(replacement, "我要退款");
        assert.equal(discovered.reply?.kind, "order", "A new Session must list orders instead of inheriting the old focus");
        assert.equal(counts().listings, afterFailure.listings + 1);
        faux.setResponses([context => {
          assert.deepEqual(userInputs(context), ["那张呢"]);
          return fauxAssistantMessage("请重新写明订单号及完整问题。");
        }]);
        await within(runCliPrompt(replacement, "那张呢", async text => { sent.push(text); }));
        assert.equal(counts().reads, afterFailure.reads, "A vague restatement cannot silently access the old order");
        faux.setResponses([orderTool(), fauxAssistantMessage("本轮仅查询订单，未申请退款。")]);
        await within(runCliPrompt(replacement, "只核对 COUPON-1001 的券状态", async text => { sent.push(text); }));
        assert.equal(counts().reads, afterFailure.reads + 1, "An explicit new question performs a fresh authorized read");
      } finally {
        releaseDrain.resolve();
        if (replacing) await replacing.catch(() => {});
        replacement?.dispose(); old.dispose();
      }
    }

    {
      const { store, counts } = fixture(), events: string[] = [], sent: string[] = [], sessions: AgentSession[] = [];
      const agent = new QQAgent(async msg => {
        assert.equal(msg.senderId, identity.senderId);
        const index = sessions.length;
        events.push(`factory:${index}`);
        const session = await makeSession(store), prompt = session.prompt.bind(session), abort = session.abort.bind(session), dispose = session.dispose.bind(session);
        session.prompt = async (...args: Parameters<AgentSession["prompt"]>) => {
          try { return await prompt(...args); } finally { events.push(`prompt-drained:${index}`); }
        };
        session.abort = async () => { events.push(`abort:${index}`); await abort(); events.push(`abort-drained:${index}`); };
        session.dispose = () => { events.push(`dispose:${index}`); dispose(); };
        sessions.push(session); return session;
      }, async (_target, text) => { sent.push(text); }, capture, 2000);
      try {
        faux.setResponses([orderTool(), contextFailure]);
        await within(agent.handle(message("只核对 COUPON-1001 的券状态")));
        assert.equal(counts().reads, 1);
        assert.equal(sent.length, 1);
        assert.match(sent[0]!, /超过当前处理范围.*下一条消息.*订单号及完整问题/u);
        assert.doesNotMatch(sent[0]!, /稍后重试|已压缩|已恢复/u);
        assert.ok(events.indexOf("dispose:0") > events.indexOf("prompt-drained:0"));
        assert.ok(events.indexOf("dispose:0") > events.indexOf("abort-drained:0"));
        faux.setResponses([context => {
          assert.deepEqual(userInputs(context), ["请重新查询 COUPON-1001"]);
          return orderTool();
        }, fauxAssistantMessage("本轮仅查询订单。")]);
        await within(agent.handle(message("请重新查询 COUPON-1001")));
        assert.equal(sessions.length, 2);
        assert.ok(events.indexOf("factory:1") > events.indexOf("dispose:0"));
        assert.equal(counts().reads, 2, "Recovery runs only the explicitly requested new read");
        assert.equal(sent.length, 2);
      } finally { await within(agent.close()); }
    }

    {
      const { store, counts } = fixture(), history = new WebChatHistory(":memory:"), sessions: AgentSession[] = [];
      const chat = new WebChatSessions(store, async () => {
        const session = await makeSession(store); sessions.push(session); return session;
      }, 2000, catalog, history);
      const overlongMarker = "旧上下文故障标记：本轮说明太长";
      const rejected = (error: unknown) => {
        assert.ok(error instanceof WebChatError); assert.equal(error.status, 503);
        assert.match(error.message, /超过当前处理范围.*记录已保留.*新建对话.*订单号及完整问题/u);
        assert.match(error.message, /重开原记录不会缩短上下文/u);
        assert.doesNotMatch(error.message, /已压缩|已恢复|重新连接后继续/u);
        return true;
      };
      try {
        const created = await chat.create(undefined, "demo-a");
        faux.setResponses([orderTool(), fauxAssistantMessage("订单已查询，未申请退款。")]);
        await within(chat.send(created.token, randomUUID(), "只核对 COUPON-1001 的券状态", created.session.id));
        faux.setResponses([contextFailure]);
        await assert.rejects(within(chat.send(created.token, randomUUID(), overlongMarker, created.session.id)), rejected);
        assert.equal(counts().reads, 1);
        assert.equal((await chat.get(created.token)).session, null);
        const retained = structuredClone(history.read(created.session.conversationId)!.messages);
        assert.ok(retained.some(row => row.role === "assistant"));
        assert.ok(retained.some(row => row.text === overlongMarker && row.status === "interrupted"));
        const reopened = await chat.open(undefined, created.ownerToken, created.session.conversationId, "demo-a", null);
        assert.deepEqual(reopened.messages, retained);
        faux.setResponses([context => {
          assert.match(JSON.stringify(context.messages), new RegExp(overlongMarker));
          return contextFailure();
        }]);
        await assert.rejects(within(chat.send(reopened.token, randomUUID(), "继续核对", reopened.session.id)), rejected);
        assert.equal(counts().reads, 1, "Reopening records does not rerun an earlier tool");
        const fresh = await chat.create(undefined, "demo-a", undefined, null, created.ownerToken);
        assert.notEqual(fresh.session.conversationId, created.session.conversationId);
        assert.deepEqual(fresh.messages, []);
        faux.setResponses([context => {
          assert.doesNotMatch(JSON.stringify(context.messages), new RegExp(overlongMarker));
          assert.deepEqual(userInputs(context), ["请查询 COUPON-1001 的券状态"]);
          return orderTool();
        }, fauxAssistantMessage("本轮只查询订单，未申请退款。")]);
        const reply = await within(chat.send(fresh.token, randomUUID(), "请查询 COUPON-1001 的券状态", fresh.session.id));
        assert.equal(reply.reply.kind, "order"); assert.equal(counts().reads, 2);
        assert.equal(sessions.length, 3);
        assert.ok(history.read(created.session.conversationId)!.messages.some(row => row.text === overlongMarker));
      } finally { chat.close(); }
    }
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(remoteCalls, 0);
    const failures = summaries.filter(row => row.failureReason === "context_limit");
    assert.equal(failures.length, 4, "CLI, QQ and two Web failures retain their specific cause");
    for (const summary of summaries) {
      assert.equal(summary.httpRequests, 0);
      assert.deepEqual(summary.contextChecks, [], "Injected entrypoint failures are not evidence of the serialized-payload guard");
    }
  } finally { globalThis.fetch = previousFetch; console.error = previousError; }
  console.log("Context entry checks passed: real Pi/OrderDiscovery CLI replacement and drain ordering; no tool replay; QQ Session replacement; Web retained/reopened history and explicit new conversation. Injected context-limit signal only, not payload-guard acceptance; 0 remote/MySQL/QQ.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkContextEntries();
