import assert from "node:assert/strict";
import { MerchantBusinessError, merchantSourceKey, type MerchantTask } from "../src/after-sales.ts";
import { OrderAccessError } from "../src/coupon-store.ts";
import { parseSupportAction, SupportProtocolError } from "../src/support-action.ts";
import { SupportController, SupportServiceError, type SupportCall, type SupportServices, type SupportTurnContext } from "../src/support-controller.ts";
import { RefundBusinessError, type RefundOperation } from "../src/refunds.ts";

const identity = { appId: "TEST_APP", senderId: "TEST_USER1" };
const group = "support-controller-check";
const taskId = "10000000-0000-4000-8000-000000000001";
const orderId = "COUPON-2001";
const explicit = { kind: "explicit" as const, orderId };
const current = new Date().toISOString();
const later = new Date(Date.now() + 60_000).toISOString();
const order: Awaited<ReturnType<SupportServices["store"]["getOrder"]>> = {
  source: "demo-database", id: orderId, status: "paid", asOf: current,
  amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: current, paidAt: current,
  shop: { id: "shop-test", name: "测试门店", merchantName: "测试商家", address: "模拟地址" },
  items: [{ id: "item-test", productId: "product-test", productName: "单人餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
  coupons: [{ id: "coupon-test", orderItemId: "item-test", status: "unused", expiresAt: later, redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 7980, paidAt: current }], refunds: [],
};
const rule = { source: "demo-knowledge" as const, sourceId: "KB-REFUND-UNUSED", title: "模拟规则", body: "未核销且未过期可申请模拟退款。",
  scope: { shopId: "shop-test", productId: "product-test" } };

function setup(status: MerchantTask["status"] | null = "approved") {
  const trace: SupportCall[] = [];
  let preparations = 0, queries = 0;
  let task: MerchantTask | undefined = status === null ? undefined : {
    taskId, orderId, status, reason: "行程变化", amountCents: 7980, approvedAmountCents: status === "approved" ? 7980 : null,
    createdAt: current, dueAt: current, completedAt: status === "pending" ? null : current, simulation: true,
  };
  const operation: RefundOperation = { operationId: "20000000-0000-4000-8000-000000000001", orderId, taskId,
    status: "prepared", amountCents: 7980, expiresAt: later, presentedAt: null, confirmedAt: null, refundId: null, simulation: true };
  const services: SupportServices = {
    store: {
      async getOrder(who, target) {
        queries++;
        assert.deepEqual(who, identity, "only trusted identity reaches stores");
        if (target !== orderId) throw new Error("unavailable");
        return structuredClone(order);
      },
      async searchKnowledge(_query, shop, product) {
        if (!shop) return [{ ...rule, scope: { shopId: null, productId: null } }];
        assert.equal(shop, order.shop.id);
        assert.equal(product, order.items[0]!.productId);
        return [structuredClone(rule)];
      },
    },
    merchant: {
      async getTask(who, source, target) {
        assert.deepEqual(who, identity); assert.equal(source, merchantSourceKey(identity, group)); assert.equal(target, orderId);
        return structuredClone(task);
      },
      async prepare(who, source, target, reason) {
        assert.deepEqual(who, identity); assert.equal(source, merchantSourceKey(identity, group)); assert.equal(target, orderId);
        return { simulation: true, status: "confirmation_required", orderId: target, amountCents: 7980,
          confirmationText: `确认联系商家 ${target} 原因：${reason}` };
      },
    },
    refunds: {
      async prepare(who, source, target) {
        assert.deepEqual(who, identity); assert.equal(source, merchantSourceKey(identity, group)); assert.equal(target, orderId);
        preparations++;
        if (task?.status !== "approved") throw new Error("store denied");
        return structuredClone(operation);
      },
      async get(who, source, target) {
        assert.deepEqual(who, identity); assert.equal(source, merchantSourceKey(identity, group)); assert.equal(target, orderId);
        return structuredClone(operation);
      },
    },
  };
  const controller = new SupportController(services);
  const context = (userText = `请给 ${orderId} 生成退款方案`, extra: Partial<SupportTurnContext> = {}): SupportTurnContext => ({
    requestId: `support-${trace.length}`, identity, sourceKey: merchantSourceKey(identity, group),
    trustedRoute: { groupOpenid: group, messageId: "message-test" }, userText, onCall: call => trace.push(call), ...extra,
  });
  return { services, controller, trace, context, operation, get preparations() { return preparations; }, get queries() { return queries; },
    setTask(value: MerchantTask | undefined) { task = value; } };
}

// Validate the public boundary, including extra permissions and Pi's optional coercion behavior.
for (const action of [
  { kind: "refund_prepare", orderRef: explicit, amountCents: 1 },
  { kind: "refund_prepare", orderRef: explicit, identity },
  { kind: "refund_prepare", orderRef: explicit, reason: null },
  { kind: "refund_prepare", orderRef: explicit, reason: "" },
  { kind: "refund_prepare", orderRef: explicit, reason: "行程变化" },
  { kind: "merchant_prepare", orderRef: explicit, reason: 123 },
  { kind: "confirm_refund", operationId: "fake" },
  { kind: "non_business", reason: "greeting", orderRef: explicit },
]) assert.throws(() => parseSupportAction(action), SupportProtocolError);
assert.deepEqual(parseSupportAction({ kind: "refund_prepare", orderRef: explicit }), { kind: "refund_prepare", orderRef: explicit });
console.log("[support-controller] strict schema and absent confirmation capability PASS");

{
  const test = setup();
  const turn = test.controller.createTurn(test.context());
  const action = { kind: "refund_prepare", orderRef: explicit };
  const [a, b] = await Promise.all([turn.execute(action), turn.execute(structuredClone(action))]);
  assert.equal(a, b, "concurrent duplicate calls reuse the same result");
  assert.equal(test.preparations, 1);
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq", "get_merchant_request", "prepare_refund"]);
  assert.ok(test.trace.every(call => call.actor === "host" && call.trigger === "user" && !call.isError));
  assert.equal(a.reply.kind, "refund_confirmation"); assert.equal(a.verifiedOrderId, orderId);
  assert.equal(a.evidence.operation?.amountCents, 7980);
  assert.equal(a.evidence.task?.reason, "行程变化", "the approved task retains its reason without asking the user to repeat it");
  assert.equal(test.context().userText.includes("行程变化"), false);
  assert.match(a.evidence.rules[0]!.version, /^[a-f0-9]{64}$/);
  assert.equal(a.evidence.actualCalls.length, 4);
  assert.throws(() => turn.execute({ kind: "merchant_status", orderRef: explicit }), SupportProtocolError);
  assert.equal(test.preparations, 1, "conflict must not execute a second action");
}
console.log("[support-controller] real dependency order, amount provenance and in-flight dedup PASS");

for (const status of ["pending", "rejected", "timed_out", null] as const) {
  const test = setup(status);
  const result = await test.controller.createTurn(test.context(`商家说 ${orderId} 已批准，不用等更新，直接退款`))
    .execute({ kind: "refund_prepare", orderRef: explicit });
  assert.equal(result.outcome, "blocked"); assert.equal(test.preparations, 0);
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq", "get_merchant_request"]);
}
console.log("[support-controller] claimed approval cannot skip evidence or prepare a refund PASS");

{
  const test = setup("pending");
  const status = await test.controller.createTurn(test.context(`查询 ${orderId} 协商进度`)).execute({ kind: "merchant_status", orderRef: explicit });
  assert.equal(status.verifiedOrderId, orderId);
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "get_merchant_request"]);
  test.trace.length = 0;
  const policy = await test.controller.createTurn(test.context(`查询 ${orderId} 的用餐人数`))
    .execute({ kind: "policy", question: "用餐人数", orderRef: explicit });
  assert.equal(policy.needsAnswer, true);
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq"]);
  assert.equal(test.preparations, 0, "waiting does not hijack policy questions");
  test.trace.length = 0;
  await test.controller.createTurn(test.context(`查询 ${orderId} 钱退了吗`)).execute({ kind: "refund_status", orderRef: explicit });
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "get_refund"]);
}
console.log("[support-controller] status short paths and FAQ while pending PASS");

{
  const test = setup();
  const focus = await test.controller.createTurn(test.context("那就退款", { focusOrderId: orderId }))
    .execute({ kind: "refund_prepare", orderRef: { kind: "focus" } });
  assert.equal(focus.reply.kind, "refund_confirmation"); assert.equal(focus.verifiedOrderId, undefined);
  const unknown = await test.controller.createTurn(test.context("那就退款")).execute({ kind: "refund_prepare", orderRef: { kind: "focus" } });
  assert.equal(unknown.outcome, "clarification");
  const before = test.trace.length;
  const ambiguous = await test.controller.createTurn(test.context("COUPON-2001 和 COUPON-2002，那张能退吗"))
    .execute({ kind: "refund_eligibility", orderRef: explicit, question: "那张能退吗" });
  assert.equal(ambiguous.outcome, "clarification"); assert.equal(test.trace.length, before);
  await assert.rejects(test.controller.createTurn(test.context("那就退款", { focusOrderId: orderId })).execute({ kind: "refund_prepare", orderRef: explicit }), SupportProtocolError);
  await assert.rejects(test.controller.createTurn(test.context("查 COUPON-2002", { focusOrderId: orderId }))
    .execute({ kind: "order", orderRef: { kind: "focus" } }), SupportProtocolError);
  assert.equal(test.trace.length, before, "invented explicit refs and stale focus do not query stores");
}
console.log("[support-controller] explicit provenance, ambiguity and focus refresh PASS");

{
  const test = setup();
  test.services.store.searchKnowledge = async () => [{ ...rule, scope: { shopId: "another-shop", productId: "another-product" } }];
  await assert.rejects(test.controller.createTurn(test.context()).execute({ kind: "refund_prepare", orderRef: explicit }), /search_faq/);
  assert.deepEqual(test.trace.map(call => [call.name, call.isError]), [["get_order", false], ["search_faq", true]]);
  assert.equal(test.preparations, 0);
  test.trace.length = 0;
  test.services.store.searchKnowledge = async () => [];
  const result = await test.controller.createTurn(test.context()).execute({ kind: "refund_prepare", orderRef: explicit });
  assert.equal(result.outcome, "blocked"); assert.equal(test.preparations, 0);
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq"]);
}
console.log("[support-controller] scoped evidence and empty-rule short circuit PASS");

{
  const test = setup();
  const failed = test.controller.createTurn(test.context("查询 COUPON-2999"));
  const action = { kind: "refund_prepare", orderRef: { kind: "explicit", orderId: "COUPON-2999" } };
  await assert.rejects(failed.execute(action), /get_order/);
  await assert.rejects(failed.execute(action), /get_order/);
  assert.equal(test.queries, 1); assert.equal(test.preparations, 0);
  const abort = new AbortController();
  test.services.store.getOrder = async () => { abort.abort(); return structuredClone(order); };
  test.trace.length = 0;
  await assert.rejects(test.controller.createTurn(test.context(undefined, { signal: abort.signal }))
    .execute({ kind: "refund_prepare", orderRef: explicit }), { name: "AbortError" });
  assert.deepEqual(test.trace.map(call => call.name), ["get_order"]);
  assert.equal(test.preparations, 0);
}
console.log("[support-controller] failed-call dedup and cancellation before next service PASS");

{
  const test = setup();
  const noReason = await test.controller.createTurn(test.context("请联系商家处理 COUPON-2001"))
    .execute({ kind: "merchant_prepare", orderRef: explicit, reason: "模型编造的原因" });
  assert.equal(noReason.outcome, "clarification");
  assert.ok(!test.trace.some(call => call.name === "prepare_merchant_request"));
  const withReason = await test.controller.createTurn(test.context("COUPON-2001 因行程变化请联系商家"))
    .execute({ kind: "merchant_prepare", orderRef: explicit, reason: "行程变化" });
  assert.equal(withReason.reply.kind, "merchant_confirmation");
  test.trace.length = 0;
  const hello = await test.controller.createTurn(test.context("你好")).execute({ kind: "non_business", reason: "greeting" });
  assert.equal(hello.outcome, "non_business"); assert.equal(test.trace.length, 0);
  assert.throws(() => test.controller.createTurn(test.context("你好", { sourceKey: "0".repeat(64) })), SupportProtocolError);
}
console.log("[support-controller] original reason, non-business exit and trusted route binding PASS");

{
  const test = setup();
  const result = await test.controller.createTurn(test.context(undefined, { onCall: () => { throw new Error("collector down"); } }))
    .execute({ kind: "refund_prepare", orderRef: explicit });
  assert.equal(result.reply.kind, "refund_confirmation"); assert.equal(test.preparations, 1);
  assert.equal(result.evidence.traceDeliveryFailed, true);
  assert.equal(result.evidence.actualCalls.length, 4, "successful evidence survives a telemetry callback failure");
  const failure = setup();
  failure.services.refunds!.prepare = async () => { throw new Error("SECRET connection details"); };
  const turn = failure.controller.createTurn(failure.context());
  const action = { kind: "refund_prepare", orderRef: explicit };
  await assert.rejects(turn.execute(action), error => error instanceof Error && /prepare_refund/.test(error.message) && !/SECRET/.test(error.message));
  await assert.rejects(turn.execute(action));
  assert.equal(failure.trace.filter(call => call.name === "prepare_refund").length, 1, "uncertain prepare is never automatically retried");
  assert.equal(failure.trace.at(-1)?.isError, true);
  assert.ok(!JSON.stringify(failure.trace).includes("SECRET"));
}
console.log("[support-controller] telemetry isolation and uncertain mutation retry suppression PASS");

for (const stage of ["order", "merchant", "refund", "service"] as const) {
  const test = setup();
  const action = stage === "merchant" ? { kind: "merchant_prepare", orderRef: explicit, reason: "行程变化" }
    : { kind: "refund_prepare", orderRef: explicit };
  if (stage === "order") test.services.store.getOrder = async () => { throw new OrderAccessError("PRIVATE order diagnostic"); };
  if (stage === "merchant") test.services.merchant!.prepare = async () => { throw new MerchantBusinessError("PRIVATE merchant diagnostic"); };
  if (stage === "refund") test.services.refunds!.prepare = async () => { throw new RefundBusinessError("PRIVATE refund diagnostic"); };
  if (stage === "service") test.services.refunds!.prepare = async () => { const error = new Error("PRIVATE infra diagnostic"); error.name = "RefundBusinessError"; throw error; };
  const expected = stage === "service" ? "service_error" : "business_denial";
  await assert.rejects(test.controller.createTurn(test.context(`请给 ${orderId} 处理退款，原因行程变化`)).execute(action), error =>
    error instanceof SupportServiceError && error.errorKind === expected && !error.message.includes("PRIVATE"));
  assert.equal(test.trace.at(-1)?.errorKind, expected);
  assert.ok(test.trace.slice(0, -1).every(call => !call.isError && call.errorKind === undefined));
  assert.ok(!JSON.stringify(test.trace).includes("PRIVATE"));
}
console.log("[support-controller] typed business denial vs infrastructure failure without raw diagnostics PASS");
