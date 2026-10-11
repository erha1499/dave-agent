import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import type { AfterSalesStore } from "../src/after-sales.ts";
import type { RefundStore } from "../src/refunds.ts";

const identity = { appId: "PREREQUISITE_CHECK", senderId: "OWNER" }, sourceKey = "test-conversation";
const orderId = "COUPON-2042", scope = { shopId: "SHOP-A", productId: "PRODUCT-A" };
const order = { source: "demo-database", id: orderId, status: "paid", asOf: "2026-10-10T00:00:00Z",
  amounts: { paidCents: 7980, refundedCents: 0 }, shop: { id: scope.shopId },
  items: [{ productId: scope.productId }], coupons: [{ status: "unused", expiresAt: null }] };
const rule = { source: "demo-knowledge", sourceId: "KB-PREREQUISITE", title: "退款条件", body: "需核对当前订单和商家批准。", scope };
const runtime = await createModelRuntime(), faux = fauxProvider({ tokensPerSecond: 0 });
runtime.registerNativeProvider(faux.provider);
const calls: string[] = [], events: AgentSessionEvent[] = [];
let rulesMode: "normal" | "empty" | "wrong" | "error" = "normal", taskStatus = "approved";
let getOrderGate: (() => Promise<void>) | undefined;
const store = {
  async getOrder(actual: typeof identity, id: string) {
    assert.deepEqual(actual, identity); calls.push(`order:${id}`);
    if (id !== orderId) throw new Error("订单不可查询");
    await getOrderGate?.();
    return structuredClone(order);
  },
  async searchKnowledge(query: string, shopId?: string, productId?: string) {
    calls.push(`faq:${shopId ?? "global"}:${productId ?? "global"}`);
    assert.ok(query);
    if (rulesMode === "error") throw new Error("规则服务不可用");
    return rulesMode === "empty" ? [] : [{ ...rule, scope: rulesMode === "wrong" ? { shopId: "OTHER", productId } : { shopId: shopId ?? null, productId: productId ?? null } }];
  },
} as unknown as CouponStore;
const merchant = {
  async getTask(actual: typeof identity, key: string, id: string) {
    assert.deepEqual(actual, identity); assert.equal(key, sourceKey); assert.equal(id, orderId);
    calls.push("merchant"); return { orderId, status: taskStatus };
  },
  async prepare(actual: typeof identity, key: string, id: string, reason: string) {
    assert.deepEqual(actual, identity); assert.equal(key, sourceKey); assert.equal(id, orderId); assert.equal(reason, "计划有变");
    calls.push("prepare-merchant"); return { orderId, status: "confirmation_required" };
  },
} as unknown as AfterSalesStore;
const refunds = { async prepare(actual: typeof identity, key: string, id: string) {
  assert.deepEqual(actual, identity); assert.equal(key, sourceKey); assert.equal(id, orderId);
  calls.push("prepare-refund"); return { orderId, status: "prepared" };
} } as unknown as RefundStore;
const session = await createCouponSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey, refunds });
session.subscribe(event => events.push(event));
const expectedTools = ["get_merchant_request", "get_order", "get_refund", "list_orders", "prepare_merchant_request", "prepare_refund", "search_faq"];
assert.deepEqual(session.getActiveToolNames().sort(), expectedTools);
type Call = { name: string; args: Record<string, string> };
const read = (id = orderId): Call => ({ name: "get_order", args: { orderId: id } });
const faq = (selected = scope): Call => ({ name: "search_faq", args: { query: "未核销退款", ...selected } });
function script(batches: Call[][]) {
  calls.length = 0; events.length = 0;
  faux.setResponses([...batches.map(batch => fauxAssistantMessage(batch.map(call => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" })),
    fauxAssistantMessage("工程检查结束。")]);
}
async function run(batches: Call[][]) {
  script(batches);
  const previous = session.messages.length;
  await session.prompt("按当前消息执行指定工程检查。", { expandPromptTemplates: false });
  assert.equal(session.agent.state.errorMessage, undefined);
  assert.equal(faux.getPendingResponseCount(), 0);
  return session.messages.slice(previous).filter(message => message.role === "toolResult");
}
const ends = () => events.filter(event => event.type === "tool_execution_end");
const starts = () => events.filter(event => event.type === "tool_execution_start");
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("工程检查等待超时")), 3000); })]); }
  finally { clearTimeout(timer); }
}

try {
  let results = await run([[faq()]]);
  assert.equal(results[0]!.isError, true); assert.deepEqual(calls, [], "scoped FAQ cannot reach the store without current authorization");
  results = await run([[{ name: "search_faq", args: { query: "一般规则" } }]]);
  assert.equal(results[0]!.isError, false); assert.deepEqual(calls, ["faq:global:global"]);
  results = await run([[read()], [faq()]]);
  assert.deepEqual(results.map(result => result.isError), [false, false]);
  assert.deepEqual(calls, [`order:${orderId}`, "faq:SHOP-A:PRODUCT-A"]);
  results = await run([[faq()]]);
  assert.equal(results[0]!.isError, true); assert.deepEqual(calls, [], "previous-turn authorization is retired");
  results = await run([[read()], [faq({ shopId: "OTHER", productId: scope.productId })], [faq({ ...scope, productId: "OTHER" })]]);
  assert.deepEqual(results.map(result => result.isError), [false, true, true]); assert.deepEqual(calls, [`order:${orderId}`]);
  results = await run([[read()], [read("COUPON-9999")], [faq()]]);
  assert.deepEqual(results.map(result => result.isError), [false, true, true]);
  assert.deepEqual(calls, [`order:${orderId}`, "order:COUPON-9999"], "failed authorization retires the earlier scope");
  results = await run([[read()], [read("INVALID")], [faq()]]);
  assert.deepEqual(results.map(result => result.isError), [false, true, true]);
  assert.deepEqual(calls, [`order:${orderId}`], "Pi schema rejection before execute also retires the earlier scope");
  results = await run([[read("COUPON-9999")], [read()], [faq()]]);
  assert.deepEqual(results.map(result => result.isError), [true, false, false], "a new authorized read can recover within the same turn");

  for (const name of ["get_merchant_request", "prepare_merchant_request", "prepare_refund"]) {
    results = await run([[{ name, args: { orderId, ...(name === "prepare_merchant_request" ? { reason: "计划有变" } : {}) } }]]);
    assert.equal(results.length, 1, "nested tool results are not forged transcript entries"); assert.equal(results[0]!.isError, false);
    const tail = name === "prepare_merchant_request" ? ["prepare-merchant"] : name === "prepare_refund" ? ["merchant", "prepare-refund"] : ["merchant"];
    assert.deepEqual(calls, [`order:${orderId}`, "faq:SHOP-A:PRODUCT-A", ...tail]);
    const parent = starts()[0]!;
    const inner = starts().filter(event => event.parentToolCallId);
    assert.equal(parent.parentToolCallId, undefined);
    assert.ok(inner.length >= 2);
    for (const event of inner) assert.ok(event.toolCallId.startsWith(`${event.parentToolCallId}/`));
    assert.deepEqual(ends().map(event => event.toolName), name === "prepare_refund"
      ? ["get_order", "search_faq", "get_merchant_request", "prepare_refund"] : ["get_order", "search_faq", name]);
    assert.ok(ends().every(event => !event.isError));
    const nested = (results[0] as unknown as { nestedCalls: { complete: boolean; calls: Array<{ name: string }> } }).nestedCalls;
    assert.equal(nested.complete, true);
    assert.deepEqual(nested.calls.map(call => call.name), name === "prepare_refund"
      ? ["get_merchant_request", "get_order", "search_faq"] : ["get_order", "search_faq"]);
  }
  order.items.push({ productId: "PRODUCT-B" });
  results = await run([[{ name: "get_merchant_request", args: { orderId } }]]);
  assert.equal(results[0]!.isError, false);
  assert.deepEqual(calls, [`order:${orderId}`, "faq:SHOP-A:PRODUCT-A", "faq:SHOP-A:PRODUCT-B", "merchant"], "each order product needs its own applicable query");
  order.items.pop();
  for (const mode of ["empty", "wrong", "error"] as const) {
    rulesMode = mode;
    for (const name of ["get_merchant_request", "prepare_merchant_request", "prepare_refund"]) {
      results = await run([[{ name, args: { orderId, ...(name === "prepare_merchant_request" ? { reason: "计划有变" } : {}) } }]]);
      assert.equal(results[0]!.isError, true);
      assert.deepEqual(calls, [`order:${orderId}`, "faq:SHOP-A:PRODUCT-A"], "invalid/missing rules must stop before the business service");
    }
  }
  rulesMode = "normal";
  results = await run([[{ name: "get_merchant_request", args: { orderId: "COUPON-9999" } }]]);
  assert.equal(results[0]!.isError, true); assert.deepEqual(calls, ["order:COUPON-9999"]);
  taskStatus = "rejected";
  results = await run([[{ name: "prepare_refund", args: { orderId } }]]);
  assert.equal(results[0]!.isError, true); assert.deepEqual(calls, [`order:${orderId}`, "faq:SHOP-A:PRODUCT-A", "merchant"]);
  taskStatus = "approved";
  session.setActiveToolsByName(["get_merchant_request"]);
  results = await run([[{ name: "get_merchant_request", args: { orderId } }]]);
  assert.equal(results[0]!.isError, true); assert.deepEqual(calls, [], "inactive prerequisites cannot be bypassed");
  session.setActiveToolsByName(expectedTools);

  const release = deferred(), denied = deferred();
  getOrderGate = () => release.promise;
  session.agent.toolExecution = "parallel";
  const unsubscribe = session.subscribe(event => { if (event.type === "tool_execution_end" && event.toolName === "get_order" && event.isError) denied.resolve(); });
  const running = run([[read(), read("COUPON-9999")], [faq()]]);
  await bounded(denied.promise); release.resolve();
  results = await running; unsubscribe(); getOrderGate = undefined;
  assert.deepEqual(results.map(result => result.isError), [true, true, true], "a late successful read cannot resurrect retired scope");
  assert.deepEqual(calls, [`order:${orderId}`, "order:COUPON-9999"]);

  const entered = deferred(), canceledRead = deferred();
  getOrderGate = async () => { entered.resolve(); await canceledRead.promise; };
  script([[{ name: "get_merchant_request", args: { orderId } }]]);
  const canceled = session.prompt("取消正在读取的订单。", { expandPromptTemplates: false });
  await bounded(entered.promise);
  const aborting = session.abort(); canceledRead.resolve();
  await Promise.all([canceled, aborting]); getOrderGate = undefined;
  assert.deepEqual(calls, [`order:${orderId}`], "cancellation must stop rules and the business service");
  results = await run([[faq()]]);
  assert.equal(results[0]!.isError, true); assert.deepEqual(calls, [], "a canceled turn cannot authorize the next turn");
} finally { session.dispose(); }
console.log("atomic tool prerequisites passed: fresh scope, native nested traces, fail-closed dependencies, concurrency and cancellation");
