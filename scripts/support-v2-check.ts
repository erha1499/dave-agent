import assert from "node:assert/strict";
import { merchantSourceKey, type MerchantTask } from "../src/after-sales.ts";
import { SupportController, type SupportServices } from "../src/support-controller.ts";
import { analyzeSupportSpans, checkSupportContract, supportObjectivePlan, type SupportServiceObservation, type SupportState } from "../src/support-evaluation.ts";
import type { EvalSpan } from "../src/evaluation.ts";
import { loadSupportDevelopment, type DevelopmentCase } from "./support-v2-data.ts";
import { checkSupportLiveDataset } from "./support-v2-live.ts";

// This is a deterministic service/protocol test, not an Agent/model or SQL-authorization score.
const identity = { appId: "TEST_APP", senderId: "TEST_USER1" }, group = "support-v2-engineering";
const sourceKey = merchantSourceKey(identity, group);
const taskId = "00000000-0000-4000-8000-000000000001", operationId = "00000000-0000-4000-8000-000000000002";
const refundId = "00000000-0000-4000-8000-000000000003";
const stamp = "2026-01-01T00:00:00.000Z", future = "2099-01-01T00:00:00.000Z";
function fixture(example: DevelopmentCase) {
  const task: MerchantTask = { taskId, orderId: "COUPON-2001", status: example.setup.task, reason: "行程变化", amountCents: 7980,
    approvedAmountCents: example.setup.task === "approved" ? 7980 : null, createdAt: stamp, dueAt: stamp,
    completedAt: example.setup.task === "approved" ? stamp : null, simulation: true };
  const state: SupportState = { orders: ["COUPON-2001", "COUPON-2002"].map(id => ({ id, paidCents: 7980, refundedCents: 0 })), operations: [], refundIds: [] };
  if (example.setup.operation !== "none") state.operations.push({ operationId, taskId, orderId: task.orderId, amountCents: 7980,
    status: example.setup.operation === "expired" ? "awaiting_confirmation" : example.setup.operation,
    expiresAt: example.setup.operation === "expired" ? "2026-01-02T00:00:00.000Z" : future, presentedAt: stamp,
    confirmedAt: example.setup.operation === "succeeded" ? stamp : null,
    refundId: example.setup.operation === "succeeded" ? refundId : null, simulation: true });
  if (example.setup.operation === "succeeded") { state.refundIds.push(refundId); state.orders[0]!.refundedCents = 7980; }
  let calls: SupportServiceObservation[] = [];
  async function observe<T>(name: string, input: Record<string, unknown>, work: () => T): Promise<T> {
    try { const output = work(); calls.push({ name, input, output: structuredClone(output), outcome: "ok" }); return structuredClone(output); }
    catch (error) { calls.push({ name, input, outcome: example.setup.foreign && name === "get_order" ? "denied" : "error" }); throw error; }
  }
  const services: SupportServices = {
    store: {
      getOrder: async (who, orderId) => observe("get_order", { orderId }, () => {
        assert.deepEqual(who, identity);
        if (example.setup.foreign) throw new Error("synthetic authorization denial");
        const order = state.orders.find(item => item.id === orderId); assert.ok(order);
        return { id: orderId, source: "demo-database" as const, asOf: stamp, status: order.refundedCents ? "refunded" : "paid",
          createdAt: stamp, paidAt: stamp, shop: { id: "shop-demo-1", name: "合成门店", address: "合成地址", merchantName: "合成商家" },
          amounts: { totalCents: 7980, paidCents: 7980, refundedCents: order.refundedCents },
          items: [{ id: "item-1", productId: "product-demo-1", productName: "合成套餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
          coupons: [{ id: "coupon-1", orderItemId: "item-1", status: "unused", expiresAt: future, redeemedAt: null, redeemedShopId: null }], payments: [], refunds: [] };
      }),
      searchKnowledge: async (query, shopId, productId) => observe("search_faq", { query, shopId, productId }, () => example.setup.rules
        ? [{ source: "demo-knowledge" as const, sourceId: "KB-TEST", title: "合成政策", body: "未核销券可申请协商，批准后准备方案。", scope: { shopId: "shop-demo-1", productId: "product-demo-1" } }] : []),
    },
    merchant: {
      getTask: async (_who, _source, orderId) => observe("get_merchant_request", { orderId }, () => task),
      prepare: async () => { throw new Error("not used by this fixed development set"); },
    },
    refunds: {
      get: async (_who, _source, orderId) => observe("get_refund", { orderId }, () => state.operations.find(item => item.orderId === orderId)),
      prepare: async (_who, _source, orderId) => observe("prepare_refund", { orderId }, () => {
        assert.equal(task.status, "approved");
        let operation = state.operations.find(item => item.orderId === orderId);
        if (!operation) { operation = { operationId, orderId, taskId, status: "prepared", amountCents: 7980, expiresAt: future,
          presentedAt: null, confirmedAt: null, refundId: null, simulation: true }; state.operations.push(operation); }
        return operation;
      }),
    },
  };
  return { services, snapshot: () => structuredClone(state), takeCalls: () => { const result = calls; calls = []; return result; } };
}

const dataset = await loadSupportDevelopment(), plan = supportObjectivePlan(dataset.cases);
let rounds = 0;
for (const architecture of ["atomic", "controller"] as const) for (const example of dataset.cases) {
  const f = fixture(example); let focus: string | undefined, controller = new SupportController(f.services);
  for (const turn of example.turns) {
    if (turn.restart) { controller = new SupportController(f.services); focus = undefined; }
    const before = f.snapshot();
    try {
      if (architecture === "controller") {
        const result = await controller.createTurn({ requestId: `${architecture}:${example.id}:${turn.index}`, identity, sourceKey,
          trustedRoute: { groupOpenid: group, messageId: `message-${turn.index}` }, userText: turn.question, focusOrderId: focus }).execute(turn.action);
        if (result.verifiedOrderId) focus = result.verifiedOrderId;
        assert.equal(result.action.kind, turn.action.kind);
      } else {
        // Execute the frozen atomic service chain; this does not claim a model chose it.
        for (const name of turn.expect.requiredCalls) {
          const id = turn.expect.orderId!;
          if (name === "get_order") await f.services.store.getOrder(identity, id);
          if (name === "search_faq") await f.services.store.searchKnowledge(turn.question, "shop-demo-1", "product-demo-1");
          if (name === "get_merchant_request") await f.services.merchant!.getTask(identity, sourceKey, id);
          if (name === "prepare_refund") await f.services.refunds!.prepare(identity, sourceKey, id);
          if (name === "get_refund") await f.services.refunds!.get(identity, sourceKey, id);
        }
      }
    } catch (error) { if (turn.expect.branch !== "denied") throw error; }
    const actual = { calls: f.takeCalls(), before, after: f.snapshot(), completed: true };
    const checks = checkSupportContract(turn.expect, actual);
    assert.ok(checks.every(check => check.status === "passed"), `${architecture}/${example.id}/${turn.index}: ${JSON.stringify(checks.filter(check => check.status !== "passed"))}`);
    if (turn.expect.requiredCalls.length) {
      const refusal = checkSupportContract(turn.expect, { ...actual, calls: [], after: before });
      assert.ok(refusal.some(check => check.status === "failed"), "refusing an expected action cannot pass the common contract");
    }
    if (actual.calls.some(call => call.name === "search_faq")) {
      const wrong = structuredClone(actual); const faq = wrong.calls.find(call => call.name === "search_faq")!;
      faq.input = { ...(faq.input as object), shopId: "wrong-shop" };
      assert.equal(checkSupportContract(turn.expect, wrong).find(check => check.id === "evidence.rules")!.status, "failed");
    }
    rounds++;
  }
}
const root: EvalSpan = { id: "request", parentSpanId: null, actor: "agent", trigger: "user", component: "turn", name: "request",
  observedAt: stamp, durationMs: 20, outcome: "ok" };
const host: EvalSpan = { ...root, id: "service", parentSpanId: "request", actor: "host", component: "support-controller", outcome: "denied" };
const llm: EvalSpan = { ...root, id: "llm", parentSpanId: "request", component: "model", usage: { provider: "faux", model: "faux", kind: "llm",
  inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: { currency: "USD", amount: .001, source: "sdk_estimate" } } };
const rerank: EvalSpan = { ...host, id: "rerank", outcome: "ok", component: "retrieval", usage: { provider: "synthetic", model: "rank", kind: "rerank",
  inputTokens: null, outputTokens: null, totalTokens: null, cost: { currency: "CNY", amount: .002, source: "provider" } } };
const attribution = analyzeSupportSpans([root, host, llm, rerank]);
assert.deepEqual(attribution.issues, []); assert.equal(attribution.groups.find(group => group.actor === "agent")!.errors, 0);
assert.equal(attribution.providers.length, 2); assert.equal(attribution.providers[1]!.usageReported, 0);
assert.equal(attribution.providers[0]!.costs[0]!.currency, "USD"); assert.equal(attribution.providers[1]!.costs[0]!.currency, "CNY");
assert.ok(analyzeSupportSpans([root, { ...host, parentSpanId: "missing" }]).issues.length);
assert.ok(analyzeSupportSpans([root, root]).issues.length);
assert.ok(analyzeSupportSpans([{ ...root, parentSpanId: "service" }, host]).issues.length);
assert.equal(plan.version, 2);
const live = await checkSupportLiveDataset("legacy");
assert.equal(live.plan.cases.length, 3); assert.equal(live.plan.cases.reduce((sum, item) => sum + item.turns.length, 0), 8);
const expanded = await checkSupportLiveDataset();
assert.equal(expanded.plan.cases.length, 14); assert.equal(expanded.plan.cases.reduce((sum, item) => sum + item.turns.length, 0), 24);
console.log(`v2 共同契约工程检查通过：12 开发案例 × 2 服务架构，${rounds} 轮；覆盖拒绝替代成功、错误范围、分层归因和币种分列。未运行模型、数据库或 QQ。`);
