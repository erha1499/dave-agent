import assert from "node:assert/strict";
import { MerchantBusinessError, merchantSourceKey, type MerchantTask } from "../src/after-sales.ts";
import { OrderAccessError } from "../src/coupon-store.ts";
import { parseSupportAction, SupportProtocolError } from "../src/support-action.ts";
import { parseContextSupportAction, type ContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, SupportServiceError, type SupportCall, type SupportServices, type SupportTurnContext } from "../src/support-controller.ts";
import { RefundBusinessError, type RefundOperation } from "../src/refunds.ts";
import type { KnowledgeSearchInput, KnowledgeTrace } from "../src/knowledge-service.ts";
import { rememberOrderChoice, supportObjectReference } from "../src/support-context.ts";

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

const amountQuestions = ["还没有核销的那张券，实付与先前展示的金额相同吗？", "和之前显示的价钱一样吗，余下那份？",
  "没有使用过的那张，单价也是前面展示的数额吗？"];
for (const text of amountQuestions) assert.equal(supportObjectReference(text), "remaining_amount");
for (const text of ["未消费的那份也适用相同人数规则吗？", "已消费的券实付一样吗？", "剩余那张券的实付金额是多少？"]) {
  assert.equal(supportObjectReference(text), null, "object, amount and comparison features must all be present");
}
assert.equal(supportObjectReference("另一张未使用的券，实付也和刚才一样吗？"), "ambiguous");

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
  const turn = test.controller.createTurn(test.context("它没用过可以退吗？只咨询。", { focusOrderId: orderId }));
  await assert.rejects(turn.execute({ kind: "refund_eligibility", orderRef: explicit, question: "原问" }), SupportProtocolError);
  assert.equal(test.trace.length, 0, "pure reference failure must not begin a business action");
  const repaired = await turn.execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "原问" });
  assert.equal(repaired.outcome, "ready"); assert.equal(repaired.evidence.order!.id, orderId);
  assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq"]);
  const explicitTurn = test.controller.createTurn(test.context(`查 ${orderId} 退款资格。`));
  await assert.rejects(explicitTurn.execute({ kind: "policy", question: "资格" }), SupportProtocolError);
  await assert.rejects(explicitTurn.execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "资格" }), SupportProtocolError);
  const corrected = await explicitTurn.execute({ kind: "refund_eligibility", orderRef: explicit, question: "资格" });
  assert.equal(corrected.outcome, "ready"); assert.equal(test.preparations, 0);
  const clarified = test.controller.createTurn(test.context());
  await clarified.execute({ kind: "clarify", field: "intent", reason: "ambiguous" });
  assert.throws(() => clarified.execute({ kind: "refund_prepare", orderRef: explicit }), SupportProtocolError,
    "zero-call completed business decisions are still locked; only protocol failures can be repaired");
}
console.log("[support-controller] pure order-reference preflight permits repair without unlocking completed actions PASS");

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
  assert.throws(() => failed.execute({ kind: "order", orderRef: action.orderRef }), SupportProtocolError);
  assert.equal(test.queries, 1); assert.equal(test.preparations, 0);
  const denied = setup();
  let deniedCalls = 0;
  denied.services.store.getOrder = async () => { deniedCalls++; throw new OrderAccessError("private denial"); };
  const deniedTurn = denied.controller.createTurn(denied.context());
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(deniedTurn.execute({ kind: "refund_prepare", orderRef: explicit }),
      error => error instanceof SupportServiceError && error.errorKind === "business_denial");
  }
  assert.throws(() => deniedTurn.execute({ kind: "order", orderRef: explicit }), SupportProtocolError);
  assert.equal(deniedCalls, 1, "a typed business denial is a started action, never a repairable protocol error");
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
  const test = setup(), abort = new AbortController();
  test.services.store.getOrder = async () => { abort.abort(); return structuredClone(order); };
  await assert.rejects(test.controller.createTurn(test.context(undefined, { signal: abort.signal }))
    .execute({ protocol: "v2.2", kind: "order", orderRef: explicit }), { name: "AbortError" });
  assert.equal(test.trace.length, 1); assert.equal(test.trace[0]!.isError, false);
  assert.deepEqual(test.trace[0]!.output, order, "completed read audit survives cancellation even though no result is published");

  const prepared = setup(), stopped = new AbortController(), prepare = prepared.services.refunds!.prepare;
  prepared.services.refunds!.prepare = async (...args) => { const value = await prepare(...args); stopped.abort(); return value; };
  const turn = prepared.controller.createTurn(prepared.context(undefined, { signal: stopped.signal }));
  const action = { protocol: "v2.2" as const, kind: "refund_prepare" as const, orderRef: explicit };
  await assert.rejects(turn.execute(action), { name: "AbortError" });
  await assert.rejects(turn.execute(action), { name: "AbortError" });
  assert.equal(prepared.preparations, 1, "cancellation must not retry a completed prepare");
  assert.equal(prepared.trace.at(-1)!.name, "prepare_refund"); assert.equal(prepared.trace.at(-1)!.isError, false);
  assert.equal((prepared.trace.at(-1)!.output as RefundOperation).status, "prepared", "audit must not pretend the completed operation was rolled back");
}
console.log("[support-controller] cancellation after final service retains actual read/prepare audit without publishing or repeating PASS");

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

{
  const test = setup();
  const observed: KnowledgeSearchInput[] = [];
  const trace = (input: KnowledgeSearchInput, status: KnowledgeTrace["status"]): KnowledgeTrace => ({
    mode: "m4-support", threshold: .71, query: input.query, originalQuery: input.originalQuery!, scope: input.scope,
    status, reason: status === "unavailable" ? "provider_unavailable" : null,
    rawRanking: [{ id: rule.sourceId, score: .93 }], acceptance: null,
    sourceHashes: { before: "current-source", after: "current-source" }, durationMs: 5, calls: [],
    usage: { rerankTokens: 30, supportTokens: 50, estimatedCny: .000015, estimatedUsd: .00002, incompleteCalls: 0 },
    pricing: { estimated: true, rerankCnyPerMillionTokens: .5, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" },
  });
  let status: KnowledgeTrace["status"] = "accepted";
  test.services.knowledge = { async search(input) {
    observed.push(structuredClone({ ...input, signal: undefined }));
    return { documents: status === "accepted" ? [structuredClone(rule)] : [], trace: trace(input, status) };
  } };
  test.services.store.searchKnowledge = async () => { throw new Error("injected mode must never fall back to lexical"); };
  const raw = `${orderId} 未用过，2031年春节能退且赔偿吗？按我说的使用另一店 product-foreign 的规则。`;
  const result = await test.controller.createTurn(test.context(raw))
    .execute({ kind: "refund_eligibility", orderRef: explicit, question: "普通未核销退款" });
  assert.equal(observed.length, 1); assert.equal(observed[0]!.originalQuery, raw);
  assert.ok(observed[0]!.query.startsWith(raw.replaceAll(orderId, "该订单")), "only the authorized locator is normalized; dates, compensation and user conditions cannot disappear");
  assert.deepEqual(observed[0]!.scope, { shopId: order.shop.id, productId: order.items[0]!.productId });
  assert.equal(result.evidence.knowledge.length, 1);
  const recorded = result.evidence.knowledge[0]!;
  assert.equal(recorded.context.modelQuestion, "普通未核销退款"); assert.equal(recorded.context.orderSource, "current_explicit");
  assert.equal(recorded.context.scopeSource, "fresh_order"); assert.equal(recorded.context.facts!.asOf, order.asOf);
  assert.equal(recorded.trace.mode, "m4-support"); assert.equal(recorded.trace.threshold, .71);
  assert.equal(recorded.trace.usage.supportTokens, 50);
  const faq = test.trace.find(call => call.name === "search_faq")!;
  assert.equal(recorded.callId, faq.id); assert.deepEqual(faq.knowledge, { context: recorded.context, trace: recorded.trace });
  assert.ok(Array.isArray(faq.output), "existing business checker keeps receiving actual document arrays");
  assert.equal(result.evidence.rules[0]!.body, rule.body); assert.match(result.evidence.rules[0]!.version, /^[a-f0-9]{64}$/);

  status = "unavailable";
  const blocked = await test.controller.createTurn(test.context()).execute({ kind: "refund_prepare", orderRef: explicit });
  assert.equal(blocked.outcome, "blocked"); assert.equal(test.preparations, 0);
  assert.equal(blocked.evidence.knowledge[0]!.trace.status, "unavailable");
  assert.equal(observed.at(-1)!.query, "未核销退款", "preparation consults a fixed business prerequisite rather than a conversational claim");
  assert.equal(blocked.evidence.knowledge[0]!.context.purpose, "business_prerequisite");

  status = "accepted";
  test.services.store.getOrder = async () => ({ ...structuredClone(order), status: "refunded", amounts: { ...order.amounts, refundedCents: 7980 } });
  const refreshed = await test.controller.createTurn(test.context("那这个还能退吗？", { focusOrderId: orderId }))
    .execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "未核销退款" });
  assert.equal(refreshed.evidence.knowledge[0]!.context.orderSource, "verified_focus");
  assert.equal(refreshed.evidence.knowledge[0]!.context.facts!.status, "refunded");
  assert.match(observed.at(-1)!.query, /已退款重复退款/);
  for (const [status, coupons, expected] of [
    ["closed", order.coupons, "已关闭订单退款"], ["paid", [], "券状态待核实"],
  ] as const) {
    test.services.store.getOrder = async () => ({ ...structuredClone(order), status, coupons: structuredClone([...coupons]) });
    await test.controller.createTurn(test.context("那这个还能退吗？", { focusOrderId: orderId }))
      .execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "未核销退款" });
    assert.ok(observed.at(-1)!.query.includes(expected));
    assert.ok(!observed.at(-1)!.query.includes("未核销退款"), "unknown/closed facts cannot be promoted to unused eligibility by the model");
  }
  test.services.store.getOrder = async () => structuredClone(order);
  const current = await test.controller.createTurn(test.context(`${orderId} 本单有99张券，能退款吗？`))
    .execute({ protocol: "v2.2", kind: "refund_eligibility", orderRef: explicit,
      question: "模型称有99张券", questionContext: { kind: "standalone" } });
  assert.deepEqual(observed.at(-1)!.applicabilityContext, current.evidence.knowledge[0]!.context.applicability);
  assert.equal(observed.at(-1)!.applicabilityContext!.facts!.couponCount, 1, "service receives fresh facts rather than claimed counts");
  assert.equal(observed.at(-1)!.applicabilityContext!.requestId, current.evidence.requestId);
  await test.controller.createTurn(test.context(`假如 ${orderId} 有多张券，一般规则是什么？`))
    .execute({ protocol: "v2.2", kind: "policy", orderRef: explicit,
      question: "一般多券规则", questionContext: { kind: "standalone" } });
  assert.equal(observed.at(-1)!.applicabilityContext, null, "general rules bypass current-order premise checks");
}
console.log("[support-controller] injected knowledge, original-query preservation, source scope and trace provenance PASS");

{
  const test = setup();
  test.services.store.getOrder = async () => ({ ...structuredClone(order), items: [...structuredClone(order.items),
    { ...structuredClone(order.items[0]!), id: "second-item", productId: "second-product", productName: "另一套餐" }] });
  const ambiguous = await test.controller.createTurn(test.context(`查询 ${orderId} 套餐是否周末可用`))
    .execute({ kind: "policy", orderRef: explicit, question: "周末可用吗" });
  assert.equal(ambiguous.outcome, "clarification"); assert.deepEqual(test.trace.map(call => call.name), ["get_order"]);
  assert.equal(ambiguous.evidence.rules.length, 0, "different products must never be merged into one policy answer");
}
console.log("[support-controller] multi-product scope ambiguity stops before knowledge lookup PASS");

{
  const test = setup();
  const anchor = `查询 ${orderId} 的套餐平日可用日期？`;
  const first = await test.controller.createTurn(test.context(anchor)).execute({ kind: "policy", orderRef: explicit, question: "模型重写不能成为话题" });
  const topic = first.verifiedPolicyTopic!;
  assert.ok(topic); assert.equal(topic.originalQuery, anchor); assert.equal(topic.orderId, orderId);
  assert.equal(topic.sourceKey, merchantSourceKey(identity, group)); assert.deepEqual(topic.sources,
    first.evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })));
  test.trace.length = 0;
  const follow = await test.controller.createTurn(test.context("周末也这样吗？", { focusOrderId: orderId, policyTopic: topic }))
    .execute({ kind: "policy", orderRef: { kind: "focus" }, question: "常规套餐都能用" });
  assert.equal(follow.outcome, "ready"); assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq"]);
  assert.equal(follow.evidence.knowledge[0]!.context.policyTopic!.requestId, topic.requestId);
  assert.ok(follow.evidence.knowledge[0]!.context.effectiveQuery.startsWith("周末也这样吗？"));
  assert.ok(follow.evidence.knowledge[0]!.context.effectiveQuery.includes(anchor.replaceAll(orderId, "该订单")));
  assert.equal(follow.verifiedPolicyTopic!.originalQuery, anchor, "bounded topic retains its explicit anchor without growing a transcript");

  for (const userText of ["周末也这样吗？", "那超过这个时间呢？", "这个还得问他同意吗？", "剩下那个也是这个金额吗？", "换成另一张呢？", "换个套餐呢？"]) {
    const before = test.trace.length;
    const result = await test.controller.createTurn(test.context(userText, { focusOrderId: orderId }))
      .execute({ kind: "policy", orderRef: { kind: "focus" }, question: "订单范围内规则" });
    assert.equal(result.outcome, "clarification"); assert.equal(test.trace.length, before,
      "an order focus alone does not identify a policy topic, coupon, amount or alternate entity");
  }
  for (const mutation of [
    { sourceKey: merchantSourceKey({ ...identity, senderId: "someone-else" }, group) },
    { groupOpenid: "another-group" }, { orderId: "COUPON-2002" },
    { sources: [] }, { sources: [...topic.sources, ...topic.sources] },
  ]) {
    const before = test.trace.length;
    const result = await test.controller.createTurn(test.context("周末也这样吗？", { focusOrderId: orderId, policyTopic: { ...topic, ...mutation } }))
      .execute({ kind: "policy", orderRef: { kind: "focus" }, question: "周末" });
    assert.equal(result.outcome, "clarification"); assert.equal(test.trace.length, before);
  }
  const wrongScope = await test.controller.createTurn(test.context("周末也这样吗？", { focusOrderId: orderId,
    policyTopic: { ...topic, scope: { shopId: "another-shop", productId: "another-product" } } }))
    .execute({ kind: "policy", orderRef: { kind: "focus" }, question: "周末" });
  assert.equal(wrongScope.outcome, "clarification"); assert.equal(test.trace.at(-1)!.name, "get_order", "topic cannot choose the fresh scope");

  const newQuestion = "明年的春节赔偿日期是什么？";
  const standalone = await test.controller.createTurn(test.context(newQuestion, { focusOrderId: orderId, policyTopic: topic }))
    .execute({ kind: "policy", orderRef: { kind: "focus" }, question: "常规可退款" });
  assert.equal(standalone.evidence.knowledge[0]!.context.policyTopic, null);
  assert.ok(!standalone.evidence.knowledge[0]!.context.effectiveQuery.includes(anchor), "a standalone new question does not inherit an unrelated successful topic");
  const missingScope = await test.controller.createTurn(test.context("这个套餐周末能用吗？"))
    .execute({ kind: "policy", question: "通用使用规则" });
  assert.equal(missingScope.outcome, "clarification"); assert.equal(missingScope.evidence.actualCalls.length, 0);
  const multiple = await test.controller.createTurn(test.context(`查询 ${orderId} 的可用日期和退款条件？`))
    .execute({ kind: "policy", orderRef: explicit, question: "使用日期" });
  assert.equal(multiple.verifiedPolicyTopic, undefined, "model simplification cannot manufacture a unique host topic from multiple requests");
  const relativeTime = await test.controller.createTurn(test.context(`距离 ${orderId} 的预约还有30分钟，怎么改期？`))
    .execute({ kind: "policy", orderRef: explicit, question: "改期" });
  assert.ok(relativeTime.verifiedPolicyTopic, "还有 is also a remaining-duration expression, not proof of multiple policy topics");

  const another = setup();
  another.services.store.getOrder = async (who, id) => {
    assert.deepEqual(who, identity); assert.equal(id, "COUPON-2002");
    return { ...structuredClone(order), id, shop: { ...order.shop, id: "shop-second" },
      items: [{ ...order.items[0]!, productId: "product-second", productName: "另一门店套餐" }] };
  };
  another.services.store.searchKnowledge = async (_query, shopId, productId) => {
    assert.equal(shopId, "shop-second"); assert.equal(productId, "product-second");
    return [{ ...structuredClone(rule), scope: { shopId, productId } }];
  };
  const switched = await another.controller.createTurn(another.context("查询 COUPON-2002 的可用日期？", { focusOrderId: orderId, policyTopic: topic }))
    .execute({ kind: "policy", orderRef: { kind: "explicit", orderId: "COUPON-2002" }, question: "可用日期" });
  assert.equal(switched.verifiedOrderId, "COUPON-2002");
  assert.equal(switched.evidence.knowledge[0]!.context.orderSource, "current_explicit");
  assert.equal(switched.evidence.knowledge[0]!.context.policyTopic, null);
  assert.equal(switched.evidence.rules[0]!.scope.shopId, "shop-second");
}
console.log("[support-controller] bounded topic anchors, missing-context clarification and identity/order/scope binding PASS");

{
  const test = setup();
  const partial = structuredClone(order);
  partial.status = "partially_redeemed";
  partial.amounts = { totalCents: 8470, paidCents: 8470, refundedCents: 0 };
  Object.assign(partial.items[0]!, { quantity: 2, unitPriceCents: 4235, totalCents: 8470 });
  partial.payments[0]!.amountCents = 8470;
  partial.coupons = [{ ...partial.coupons[0]!, id: "used", status: "redeemed", redeemedAt: current, redeemedShopId: partial.shop.id },
    { ...partial.coupons[0]!, id: "remaining" }];
  let fresh = structuredClone(partial);
  test.services.store.getOrder = async () => structuredClone(fresh);
  const warmup = await test.controller.createTurn(test.context(`${orderId} 用了一张，剩余券退款金额按什么计算？`))
    .execute({ kind: "refund_eligibility", orderRef: explicit, question: "退款计算" });
  const reference = warmup.verifiedAmountReference!;
  assert.equal(reference.paidCents, 4235); assert.equal(reference.field, "item_paid_unit");
  assert.ok(warmup.reply.kind === "order");
  assert.equal(warmup.needsAnswer, false); assert.match(warmup.reply.text, /42.35.*不是获批退款金额/);
  const follow = async (extra: Partial<SupportTurnContext> = {}, text = "剩下那个也是这个金额吗？") => test.controller.createTurn(test.context(text,
    { focusOrderId: orderId, amountReference: reference, ...extra })).execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "模型称能退9999元" });
  const before = test.trace.length, compared = await follow();
  assert.deepEqual(test.trace.slice(before).map(row => row.name), ["get_order", "search_faq"]);
  assert.equal(compared.evidence.amountComparison!.remainingCouponCount, 1);
  assert.equal(compared.evidence.amountComparison!.remainingUnitPaidCents, 4235);
  assert.equal(compared.evidence.amountComparison!.comparisonEqual, true);
  assert.equal(compared.evidence.amountComparison!.refundApproved, false);
  assert.ok(compared.reply.kind === "order");
  assert.equal(compared.needsAnswer, false); assert.match(compared.reply.text, /实付 42.35 元.*相同/);
  assert.doesNotMatch(compared.reply.text, /9999/); assert.equal(test.preparations, 0);
  assert.equal(compared.evidence.knowledge[0]!.context.objectReference!.sourceRequestIds[0], reference.requestId);
  for (const text of amountQuestions) {
    const result = await follow({}, text);
    assert.equal(result.evidence.amountComparison!.remainingUnitPaidCents, 4235); assert.equal(result.needsAnswer, false);
    const missing = await follow({ amountReference: undefined }, text);
    assert.equal(missing.outcome, "clarification"); assert.equal(missing.evidence.actualCalls.length, 0);
    const queryOnly = await test.controller.createTurn(test.context(text)).execute({ kind: "policy", question: text });
    assert.equal(queryOnly.outcome, "clarification"); assert.equal(queryOnly.evidence.actualCalls.length, 0);
  }
  const explicitComparison = await test.controller.createTurn(test.context(`${orderId} ${amountQuestions[0]}`, { amountReference: reference }))
    .execute({ kind: "policy", orderRef: explicit, question: amountQuestions[0]! });
  assert.equal(explicitComparison.evidence.amountComparison!.comparisonEqual, true);
  assert.equal(explicitComparison.evidence.knowledge[0]!.context.objectReference!.fromOrderId, orderId);
  const explicitMissing = await test.controller.createTurn(test.context(`${orderId} ${amountQuestions[0]}`))
    .execute({ kind: "policy", orderRef: explicit, question: amountQuestions[0]! });
  assert.equal(explicitMissing.outcome, "clarification"); assert.equal(explicitMissing.evidence.actualCalls.length, 0);
  const conflictingObject = await follow({}, "另一张未核销的券，实付也是这个金额吗？");
  assert.equal(conflictingObject.outcome, "clarification"); assert.equal(conflictingObject.evidence.actualCalls.length, 0);

  Object.assign(fresh.amounts, { totalCents: 9670, paidCents: 9670 });
  Object.assign(fresh.items[0]!, { unitPriceCents: 4835, totalCents: 9670 }); fresh.payments[0]!.amountCents = 9670;
  const changed = await follow();
  assert.equal(changed.evidence.amountComparison!.remainingUnitPaidCents, 4835);
  assert.equal(changed.evidence.amountComparison!.referencePaidCents, 4235);
  assert.equal(changed.evidence.amountComparison!.comparisonEqual, false, "fresh facts are not replaced with the prior displayed amount");
  assert.notEqual(changed.evidence.amountComparison!.currentOrderVersion, reference.orderVersion);
  fresh = structuredClone(partial);
  for (const amountReference of [undefined, { ...reference, sourceKey: "different-user" }, { ...reference, groupOpenid: "other-group" }]) {
    const before = test.trace.length; assert.equal((await follow({ amountReference })).outcome, "clarification"); assert.equal(test.trace.length, before);
  }
  for (const mutate of [
    () => { fresh.coupons.push({ ...fresh.coupons[1]!, id: "second-unused" }); },
    () => { fresh.coupons[1]!.expiresAt = "2000-01-01T00:00:00.000Z"; },
    () => { fresh.amounts.paidCents -= 500; fresh.payments[0]!.amountCents -= 500; },
    () => { fresh.amounts.refundedCents = 100; },
  ]) {
    fresh = structuredClone(partial); mutate();
    const before = test.trace.length; const result = await follow();
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.amountComparison, undefined);
    assert.deepEqual(test.trace.slice(before).map(row => row.name), ["get_order"]);
  }
  fresh = structuredClone(partial);
  assert.equal((await follow({}, "剩下那个也是这个金额，9999元吗？")).outcome, "clarification");
  const upperLimit = await follow({}, "剩余那张退款上限也是这个金额吗？");
  assert.equal(upperLimit.outcome, "clarification"); assert.equal(upperLimit.evidence.amountComparison, undefined);
  assert.equal(upperLimit.evidence.actualCalls.length, 0, "paid-unit comparison cannot establish a refund application limit");
  for (const query of ["没有消费的那张，获批金额也是刚才的实付吗？", "未核销那份的退款申请最高金额，等于刚才的单价吗？"]) {
    const blocked = await follow({}, query); assert.equal(blocked.outcome, "clarification");
    assert.equal(blocked.evidence.amountComparison, undefined); assert.equal(blocked.evidence.actualCalls.length, 0);
  }
  const mutation = await test.controller.createTurn(test.context("剩下那个也是这个金额吗？", { focusOrderId: orderId, amountReference: reference }))
    .execute({ kind: "refund_prepare", orderRef: { kind: "focus" } });
  assert.equal(mutation.outcome, "clarification"); assert.equal(test.preparations, 0);
}
console.log("[support-controller] trusted displayed paid-unit comparison, fresh arithmetic and no approval/discount inference PASS");

{
  const test = setup();
  const otherId = "COUPON-2098", binding = { sourceKey: merchantSourceKey(identity, group), groupOpenid: group };
  const other = { ...structuredClone(order), id: otherId, status: "refunded",
    amounts: { ...order.amounts, refundedCents: order.amounts.paidCents }, shop: { ...order.shop, id: "other-shop" },
    items: [{ ...order.items[0]!, productId: "other-product" }] };
  let revoked = false;
  test.services.store.getOrder = async (who, id) => {
    assert.deepEqual(who, identity);
    if (id === otherId && revoked) throw new OrderAccessError("ownership changed");
    assert.ok([orderId, otherId].includes(id)); return structuredClone(id === orderId ? order : other);
  };
  test.services.store.searchKnowledge = async (_query, shopId, productId) => [{ ...structuredClone(rule), scope: { shopId: shopId!, productId: productId! } }];
  const seen = await test.controller.createTurn(test.context(`查看 ${otherId}`)).execute({ kind: "order", orderRef: { kind: "explicit", orderId: otherId } });
  let choices = rememberOrderChoice(undefined, binding, seen.evidence.order!.id, seen.evidence.requestId);
  const prior = await test.controller.createTurn(test.context(`${orderId} 的退款申请资格是什么？`))
    .execute({ kind: "refund_eligibility", orderRef: explicit, question: "退款资格" });
  choices = rememberOrderChoice(choices, binding, prior.evidence.order!.id, prior.evidence.requestId);
  const context = { focusOrderId: orderId, orderChoices: choices, policyTopic: prior.verifiedPolicyTopic! };
  const follow = () => test.controller.createTurn(test.context("换成另一张呢？", context))
    .execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "仍按未核销可退款" });
  const before = test.trace.length, switched = await follow();
  assert.equal(switched.verifiedOrderId, otherId); assert.equal(switched.evidence.order!.status, "refunded");
  assert.deepEqual(test.trace.slice(before).map(row => row.name), ["get_order", "search_faq"]);
  assert.deepEqual(switched.evidence.rules[0]!.scope, { shopId: "other-shop", productId: "other-product" });
  assert.equal(switched.evidence.knowledge[0]!.context.orderSource, "verified_alternative");
  assert.match(switched.evidence.knowledge[0]!.context.effectiveQuery, /已退款重复退款/);
  assert.equal(switched.verifiedPolicyTopic!.orderId, otherId); assert.equal(test.preparations, 0);
  for (const orderChoices of [undefined, { ...choices, sourceKey: "another-user" }, { ...choices, groupOpenid: "another-group" },
    rememberOrderChoice(choices, binding, "COUPON-2099", "third"), { ...choices, overflow: true }]) {
    const before = test.trace.length;
    const result = await test.controller.createTurn(test.context("换成另一张呢？", { ...context, orderChoices }))
      .execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "退款" });
    assert.equal(result.outcome, "clarification"); assert.equal(test.trace.length, before);
  }
  const mutation = await test.controller.createTurn(test.context("换成另一张呢？", context)).execute({ kind: "refund_prepare", orderRef: { kind: "focus" } });
  assert.equal(mutation.outcome, "clarification"); assert.equal(test.preparations, 0);
  revoked = true;
  await assert.rejects(follow(), error => error instanceof SupportServiceError && error.errorKind === "business_denial");
  assert.equal(test.trace.at(-1)!.name, "get_order"); assert.equal(test.trace.at(-1)!.isError, true);
}
console.log("[support-controller] unique trusted alternative, fresh target authorization/scope and ambiguous/write rejection PASS");

{
  const test = setup();
  const query = "这份深夜双人套餐周日能用吗？";
  const missing = await test.controller.createTurn(test.context(query)).execute({ kind: "policy", question: query });
  assert.equal(missing.outcome, "clarification"); assert.equal(test.trace.length, 0, "modified product references still require a trusted order scope");
  const wrong = await test.controller.createTurn(test.context(query, { focusOrderId: orderId }))
    .execute({ kind: "policy", orderRef: { kind: "focus" }, question: query });
  assert.equal(wrong.outcome, "clarification"); assert.deepEqual(test.trace.map(call => call.name), ["get_order"]);
  test.services.store.getOrder = async () => ({ ...structuredClone(order),
    items: [{ ...order.items[0]!, productName: "深夜双人套餐" }] });
  test.trace.length = 0;
  const matched = await test.controller.createTurn(test.context(query, { focusOrderId: orderId }))
    .execute({ kind: "policy", orderRef: { kind: "focus" }, question: query });
  assert.equal(matched.outcome, "ready"); assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq"]);
  for (const described of ["这张已经过期但没用的券，申请退款有哪些条件？", "这张还没核销过的券，可以申请退款吗？",
    "我之前买的这张券，退款条件是什么？", "这张我刚购买但还没使用的券，能退款吗？", "这份已经付款的深夜双人套餐，使用规则是什么？",
    "那份之前退过款的商品，重复退款规则是什么？", "这张已经退了款的券，还能申请吗？"]) {
    test.trace.length = 0;
    const known = await test.controller.createTurn(test.context(described, { focusOrderId: orderId }))
      .execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: described });
    assert.equal(known.outcome, "ready", described); assert.deepEqual(test.trace.map(call => call.name), ["get_order", "search_faq"]);
    assert.ok(known.evidence.knowledge[0]!.context.effectiveQuery.includes(described));
    assert.match(known.evidence.knowledge[0]!.context.effectiveQuery, /未核销退款/,
      "user lifecycle descriptions are preserved as a question, never substituted for fresh order status");
  }
  const renamed = "那张已过期但未核销的海鲜套餐能退吗？";
  const mismatch = await test.controller.createTurn(test.context(renamed, { focusOrderId: orderId }))
    .execute({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: renamed });
  assert.equal(mismatch.outcome, "clarification"); assert.equal(mismatch.evidence.actualCalls.length, 1,
    "lifecycle qualifiers cannot hide a different product name");
  const longDescription = "那张仅供周末深夜两人到店使用的专属套餐券能预约吗？";
  const long = await test.controller.createTurn(test.context(longDescription)).execute({ kind: "policy", question: longDescription });
  assert.equal(long.outcome, "clarification"); assert.equal(long.evidence.actualCalls.length, 0, "long modifiers cannot bypass the same scope guard");
}
console.log("[support-controller] generic modified product references bind only to freshly authorized matching products PASS");

{
  const test = setup();
  test.services.store.searchKnowledge = async () => [
    { ...structuredClone(rule), sourceId: "KB-WEEKDAY", body: "工作日午餐十一点开始。" },
    { ...structuredClone(rule), sourceId: "KB-WEEKEND", body: "周末午餐十一点开始。" },
  ];
  const anchor = `${orderId} 的午餐通常几点开始？`;
  const first = await test.controller.createTurn(test.context(anchor))
    .execute({ kind: "policy", orderRef: explicit, question: "模型说十二点，不作上下文" });
  const topic = first.verifiedPolicyTopic!;
  assert.equal(topic.originalQuery, anchor); assert.equal(topic.sources.length, 2);
  assert.deepEqual(topic.sources, first.evidence.rules.map(row => ({ sourceId: row.sourceId, version: row.version })));
  const follow = await test.controller.createTurn(test.context("周末也这样吗？", { focusOrderId: orderId, policyTopic: topic }))
    .execute({ kind: "policy", orderRef: { kind: "focus" }, question: "周末" });
  assert.equal(follow.outcome, "ready"); assert.equal(follow.verifiedPolicyTopic!.sources.length, 2);
  assert.ok(!follow.evidence.knowledge[0]!.context.effectiveQuery.includes("十二点"), "previous model question or answer is never an antecedent");
  const multiple = await test.controller.createTurn(test.context(`${orderId} 午餐几点开始？退款需要哪些条件？`))
    .execute({ kind: "policy", orderRef: explicit, question: "午餐时间" });
  assert.equal(multiple.outcome, "clarification"); assert.equal(multiple.verifiedPolicyTopic, undefined);
  assert.equal(multiple.evidence.actualCalls.length, 0, "several user questions cannot be laundered into one topic by model classification");
}
console.log("[support-controller] one user question can retain multiple real sources; separate questions still clarify PASS");

// v2.2 selects bounded semantics in the action. These supplied actions test the
// executor contract, not whether a real model chooses the correct action.
const protocol = "v2.2" as const;
const standalone = { kind: "standalone" as const };
const focus = { kind: "focus" as const };
{
  const valid = { protocol, kind: "policy" as const, question: "一般规则是什么？", questionContext: standalone };
  assert.deepEqual(parseContextSupportAction(valid), valid);
  for (const invalid of [
    { kind: "policy", question: "旧协议不能出现在当前工具中" },
    { ...valid, questionContext: undefined }, { ...valid, questionContext: { kind: "previous" } },
    { ...valid, scope: { productId: "forged" } }, { ...valid, protocol: "v2.1" },
    { protocol, kind: "refund_prepare", orderRef: { kind: "alternative" } },
    { protocol, kind: "paid_amount_compare", orderRef: focus, amountRef: { requestId: "shown" }, amountCents: 1 },
    { protocol, kind: "paid_amount_compare", orderRef: focus, amountRef: { requestId: "shown" }, approved: true },
    { protocol, kind: "paid_amount_compare", orderRef: { kind: "alternative" }, amountRef: { requestId: "shown" } },
  ]) assert.throws(() => parseContextSupportAction(invalid), SupportProtocolError);
  const test = setup(), raw = "这张退款办理成功了的券，还能再申请吗？";
  const result = await test.controller.createTurn(test.context(raw, { focusOrderId: orderId }))
    .execute({ protocol, kind: "refund_eligibility", question: "模型的归纳不能覆盖原问", questionContext: standalone, orderRef: focus });
  assert.equal(result.outcome, "ready"); assert.equal(result.evidence.order!.id, orderId);
  assert.equal(result.evidence.knowledge[0]!.context.protocol, protocol);
  assert.ok(result.evidence.knowledge[0]!.context.effectiveQuery.startsWith(raw));
  assert.match(result.evidence.knowledge[0]!.context.effectiveQuery, /未核销退款/, "user status words never replace fresh facts");
  const turn = test.controller.createTurn(test.context("这份单人餐周日能用吗？", { focusOrderId: orderId }));
  const action: ContextSupportAction = { protocol, kind: "policy", question: "规则", questionContext: standalone, orderRef: focus, productMention: "双人餐" };
  const before = test.trace.length;
  await assert.rejects(turn.execute(action), SupportProtocolError);
  assert.equal(test.trace.length, before, "invented product text is repairable before locking or any service call");
  assert.equal((await turn.execute({ ...action, productMention: "单人餐" })).outcome, "ready");
  const wrong = await test.controller.createTurn(test.context("这份海鲜套餐能用吗？", { focusOrderId: orderId }))
    .execute({ ...action, productMention: "海鲜套餐" });
  assert.equal(wrong.outcome, "clarification"); assert.deepEqual(wrong.evidence.actualCalls.map(call => call.name), ["get_order"]);
  assert.equal(wrong.reply.kind, "notice");
  if (wrong.reply.kind === "notice") {
    assert.ok(wrong.reply.text.includes(orderId)); assert.ok(wrong.reply.text.includes("单人餐"));
  }
  assert.equal(wrong.verifiedPolicyTopic, undefined, "a product clarification cannot establish a completed policy topic");
  const restated = await test.controller.createTurn(test.context(`订单 ${orderId} 的单人餐周日能用吗？`))
    .execute({ ...action, orderRef: explicit, productMention: "单人餐" });
  assert.equal(restated.outcome, "ready");
  assert.deepEqual(restated.evidence.actualCalls.map(call => call.name), ["get_order", "search_faq"], "restated canonical product is freshly authorized before evidence lookup");
  const noScope = await test.controller.createTurn(test.context("海鲜套餐能用吗？"))
    .execute({ protocol, kind: "policy", question: "规则", questionContext: standalone, productMention: "海鲜套餐" });
  assert.equal(noScope.outcome, "clarification"); assert.equal(noScope.evidence.actualCalls.length, 0);
  const prepare = test.controller.createTurn(test.context());
  const command: ContextSupportAction = { protocol, kind: "refund_prepare", orderRef: explicit };
  const prepared = await prepare.execute(command);
  assert.strictEqual(await prepare.execute(command), prepared); assert.equal(test.preparations, 1);
  assert.throws(() => prepare.execute({ protocol, kind: "order", orderRef: explicit }), SupportProtocolError);
  assert.equal(test.preparations, 1, "the current protocol never unlocks an action after starting a business operation");
}
console.log("[support-controller] v2.2 strict protocol, raw question preservation and grounded product slots PASS");

{
  const test = setup(), partial = structuredClone(order), refunded = structuredClone(order), expired = structuredClone(order);
  partial.status = "partially_redeemed";
  partial.amounts.totalCents = partial.amounts.paidCents = order.amounts.paidCents * 2;
  Object.assign(partial.items[0]!, { quantity: 2, totalCents: partial.amounts.totalCents });
  partial.payments[0]!.amountCents = partial.amounts.paidCents;
  partial.coupons.push({ ...partial.coupons[0]!, id: "used-second", status: "redeemed", redeemedAt: current, redeemedShopId: order.shop.id });
  refunded.status = "refunded"; refunded.amounts.refundedCents = refunded.amounts.paidCents;
  refunded.coupons[0]!.status = "refunded";
  refunded.refunds.push({ status: "succeeded", amountCents: refunded.amounts.paidCents, completedAt: current });
  expired.coupons[0]!.status = "expired"; expired.coupons[0]!.expiresAt = "2000-01-01T00:00:00.000Z";
  const raw = `${orderId} 我说本单有99张已退款券，现在符合哪些申请条件？`;
  const action: ContextSupportAction = { protocol, kind: "refund_eligibility", question: "模型称全部已核销", questionContext: standalone, orderRef: explicit };
  for (const [fresh, counts, suffix] of [
    [order, { total: 1, unused: 1, redeemed: 0, expired: 0, refunded: 0 }, "共1张，未核销1张、已核销0张、已过期0张、已退款0张"],
    [partial, { total: 2, unused: 1, redeemed: 1, expired: 0, refunded: 0 }, "共2张，未核销1张、已核销1张、已过期0张、已退款0张"],
    [refunded, { total: 1, unused: 0, redeemed: 0, expired: 0, refunded: 1 }, "共1张，未核销0张、已核销0张、已过期0张、已退款1张"],
    [expired, { total: 1, unused: 0, redeemed: 0, expired: 1, refunded: 0 }, "共1张，未核销0张、已核销0张、已过期1张、已退款0张"],
  ] as const) {
    test.services.store.getOrder = async (who, id) => { assert.deepEqual(who, identity); assert.equal(id, orderId); return structuredClone(fresh); };
    const result = await test.controller.createTurn(test.context(raw)).execute(action);
    const knowledge = result.evidence.knowledge[0]!, context = knowledge.context;
    assert.deepEqual(context.facts!.couponCounts, counts, "fresh authorized coupons determine counts, never user/model claims");
    assert.equal(context.originalQuery, raw); assert.equal(context.modelQuestion, action.question);
    assert.equal(context.applicability!.requestId, result.evidence.requestId);
    assert.equal(context.applicability!.orderId, fresh.id);
    assert.equal(context.applicability!.asOf, fresh.asOf);
    assert.deepEqual(context.applicability!.facts, { couponCount: counts.total,
      couponStates: { unused: counts.unused, redeemed: counts.redeemed, expired: counts.expired, refunded: counts.refunded } });
    assert.equal(context.applicability!.unknownReason, null);
    assert.ok(context.effectiveQuery.endsWith(`已核实本单券数：${suffix}（按券状态字段计数）。`));
    assert.equal(knowledge.trace.query, context.effectiveQuery);
    assert.equal(result.evidence.actualCalls.find(call => call.name === "search_faq")!.input.query, context.effectiveQuery);
  }
  test.services.store.getOrder = async () => structuredClone(order);
  const legacy = await test.controller.createTurn(test.context(`${orderId} 能申请退款吗？`))
    .execute({ kind: "refund_eligibility", question: "未核销退款", orderRef: explicit });
  assert.equal(legacy.evidence.knowledge[0]!.context.facts!.couponCounts, undefined);
  assert.equal(legacy.evidence.knowledge[0]!.context.applicability, undefined, "legacy replay cannot silently gain a current-order gate");
  assert.equal(legacy.evidence.knowledge[0]!.context.effectiveQuery,
    `该订单 能申请退款吗？\n已核实订单商品：${order.items[0]!.productName}。\n订单状态对应的规则条件：未核销退款。`, "legacy query bytes stay unchanged");
  const prepared = await test.controller.createTurn(test.context()).execute({ protocol, kind: "refund_prepare", orderRef: explicit });
  assert.match(prepared.evidence.knowledge[0]!.context.effectiveQuery, /^未核销退款\n已核实本单券数：共1张/);
  assert.equal(prepared.evidence.knowledge[0]!.context.applicability!.purpose, "business_prerequisite");
  const generic = await test.controller.createTurn(test.context(`假如订单 ${orderId} 有多张券，一般怎么处理退款？`))
    .execute({ protocol, kind: "policy", question: "多张券的一般规则", orderRef: explicit, questionContext: standalone });
  assert.equal(generic.evidence.knowledge[0]!.context.applicability, undefined, "general policy consultation does not claim instance eligibility");
}
console.log("[support-controller] v2.2 fresh coupon cardinality/status counts and legacy query compatibility PASS");

{
  const test = setup();
  const first = await test.controller.createTurn(test.context(`${orderId} 的入店使用时间有哪些要求？`))
    .execute({ protocol, kind: "policy", question: "使用时间", questionContext: standalone, orderRef: explicit });
  const topic = first.verifiedPolicyTopic!;
  assert.equal(topic.originalQuery, `${orderId} 的入店使用时间有哪些要求？`);
  const action: ContextSupportAction = { protocol, kind: "policy", question: "当前问题", orderRef: focus,
    questionContext: { kind: "previous", requestId: topic.requestId } };
  const text = "如果周日过去，还沿用你刚才查到的安排么？";
  const followed = await test.controller.createTurn(test.context(text, { focusOrderId: orderId, policyTopic: topic })).execute(action);
  assert.equal(followed.outcome, "ready");
  assert.ok(followed.evidence.knowledge[0]!.context.effectiveQuery.includes(topic.originalQuery.replaceAll(orderId, "该订单")));
  for (const policyTopic of [undefined, { ...topic, requestId: "other-result" }, { ...topic, sourceKey: "other-actor" },
    { ...topic, groupOpenid: "other-group" }, { ...topic, orderId: "COUPON-9999" }]) {
    const result = await test.controller.createTurn(test.context(text, { focusOrderId: orderId, policyTopic })).execute(action);
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.actualCalls.length, 0);
    assert.equal(result.needsAnswer, false); assert.ok(result.reply.kind === "notice");
    assert.match(result.reply.text, /先处理哪项需求.*若续问前文，请补充所指规则、时间或对象/);
  }
  const changedScope = structuredClone(topic); changedScope.scope.productId = "old-product";
  const rejectedScope = await test.controller.createTurn(test.context(text, { focusOrderId: orderId, policyTopic: changedScope })).execute(action);
  assert.equal(rejectedScope.outcome, "clarification"); assert.deepEqual(rejectedScope.evidence.actualCalls.map(call => call.name), ["get_order"]);
  const global = await test.controller.createTurn(test.context("预约改期通常需要谁审批？"))
    .execute({ protocol, kind: "policy", question: "预约审批", questionContext: standalone });
  const globalNext = await test.controller.createTurn(test.context("没有他的许可可以直接办理么？", { policyTopic: global.verifiedPolicyTopic }))
    .execute({ protocol, kind: "policy", question: "许可", questionContext: { kind: "previous", requestId: global.verifiedPolicyTopic!.requestId } });
  assert.equal(globalNext.outcome, "ready");
  assert.ok(globalNext.evidence.knowledge[0]!.context.effectiveQuery.includes("预约改期通常需要谁审批"));
}
console.log("[support-controller] v2.2 previous-topic ID, actor/group/order/scope binding and global continuation PASS");

{
  const test = setup(), otherId = "COUPON-2088", binding = { sourceKey: merchantSourceKey(identity, group), groupOpenid: group };
  const other = { ...structuredClone(order), id: otherId, status: "refunded", amounts: { ...order.amounts, refundedCents: 7980 },
    coupons: [{ ...order.coupons[0]!, status: "refunded" }] };
  let revoked = false;
  test.services.store.getOrder = async (who, id) => {
    assert.deepEqual(who, identity); if (revoked) throw new OrderAccessError("changed owner");
    assert.ok([orderId, otherId].includes(id)); return structuredClone(id === otherId ? other : order);
  };
  const prior = await test.controller.createTurn(test.context(`${otherId} 已经退款成功，还可以再次退款吗？`))
    .execute({ protocol, kind: "refund_eligibility", orderRef: { kind: "explicit", orderId: otherId }, question: "重复退款", questionContext: standalone });
  const choices = rememberOrderChoice(rememberOrderChoice(undefined, binding, orderId, "shown-first"), binding, otherId, "shown-second");
  const ctx = { focusOrderId: otherId, orderChoices: choices, policyTopic: prior.verifiedPolicyTopic! };
  const action: ContextSupportAction = { protocol, kind: "refund_eligibility", orderRef: { kind: "alternative" }, question: "另一笔资格",
    questionContext: { kind: "previous", requestId: ctx.policyTopic.requestId } };
  const switched = await test.controller.createTurn(test.context("那么另一个订单的申请条件呢？", ctx)).execute(action);
  assert.equal(switched.verifiedOrderId, orderId); assert.equal(switched.evidence.order!.status, "paid");
  const query = switched.evidence.knowledge[0]!.context.effectiveQuery;
  assert.match(query, /未核销退款/); assert.doesNotMatch(query, /已经退款成功|再次退款|COUPON-2088/);
  assert.deepEqual(prior.evidence.knowledge[0]!.context.facts!.couponCounts, { total: 1, unused: 0, redeemed: 0, expired: 0, refunded: 1 });
  assert.deepEqual(switched.evidence.knowledge[0]!.context.facts!.couponCounts, { total: 1, unused: 1, redeemed: 0, expired: 0, refunded: 0 });
  assert.match(query, /未核销1张、已核销0张、已过期0张、已退款0张/); assert.doesNotMatch(query, /已退款1张/);
  const independent = await test.controller.createTurn(test.context("另一个订单需要满足哪些退款条件？", { ...ctx, policyTopic: undefined }))
    .execute({ ...action, questionContext: standalone });
  assert.equal(independent.outcome, "ready"); assert.equal(independent.verifiedOrderId, orderId);
  assert.ok(independent.evidence.actualCalls.some(call => call.name === "get_order" && !call.isError && call.input.orderId === orderId));
  assert.match(independent.evidence.knowledge[0]!.context.effectiveQuery, /未核销退款/);
  assert.doesNotMatch(independent.evidence.knowledge[0]!.context.effectiveQuery, /已经退款成功|再次退款|COUPON-2088/);
  for (const orderChoices of [undefined, { ...choices, sourceKey: "other-user" }, { ...choices, groupOpenid: "elsewhere" },
    rememberOrderChoice(choices, binding, "COUPON-2089", "third"), { ...choices, overflow: true }]) {
    const result = await test.controller.createTurn(test.context("另外一笔呢？", { ...ctx, orderChoices })).execute(action);
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.actualCalls.length, 0);
  }
  const generic = await test.controller.createTurn(test.context("另一个也沿用吗？", { ...ctx, policyTopic: { ...ctx.policyTopic, intent: "policy" } }))
    .execute({ ...action, kind: "policy" });
  assert.equal(generic.outcome, "clarification"); assert.equal(generic.evidence.actualCalls.length, 0);
  revoked = true;
  await assert.rejects(test.controller.createTurn(test.context("另一笔呢？", ctx)).execute(action),
    error => error instanceof SupportServiceError && error.errorKind === "business_denial");
  assert.equal(test.preparations, 0);
}
console.log("[support-controller] v2.2 alternative selection renews authorization without copying historical order state PASS");

{
  const test = setup(), partial = structuredClone(order);
  partial.status = "partially_redeemed"; partial.amounts = { totalCents: 9520, paidCents: 9520, refundedCents: 0 };
  Object.assign(partial.items[0]!, { quantity: 2, unitPriceCents: 4760, totalCents: 9520 });
  partial.payments[0]!.amountCents = 9520;
  partial.coupons = [{ ...partial.coupons[0]!, id: "used", status: "redeemed" }, { ...partial.coupons[0]!, id: "remaining" }];
  let fresh = structuredClone(partial);
  test.services.store.getOrder = async () => structuredClone(fresh);
  test.services.store.searchKnowledge = async () => { throw new Error("A paid-fact comparison needs no knowledge request"); };
  const shown = await test.controller.createTurn(test.context(`查询 ${orderId}`)).execute({ protocol, kind: "order", orderRef: explicit });
  const reference = shown.verifiedAmountReference!, ctx = { focusOrderId: orderId, amountReference: reference };
  const action: ContextSupportAction = { protocol, kind: "paid_amount_compare", orderRef: focus, amountRef: { requestId: reference.requestId } };
  const run = (extra: Partial<SupportTurnContext> = {}) => test.controller.createTurn(test.context("还有那份没有消费，实际支付是不是之前给我看的数？", { ...ctx, ...extra })).execute(action);
  const compared = await run();
  assert.equal(compared.evidence.amountComparison!.remainingUnitPaidCents, 4760);
  assert.equal(compared.evidence.amountComparison!.comparisonEqual, true); assert.equal(compared.evidence.amountComparison!.refundApproved, false);
  assert.deepEqual(compared.evidence.actualCalls.map(call => call.name), ["get_order"]);
  assert.equal(compared.evidence.knowledge.length, 0); assert.equal(compared.evidence.rules.length, 0); assert.equal(compared.needsAnswer, false);
  assert.ok(compared.reply.kind === "order"); assert.match(compared.reply.text, /不是|不代表退款申请上限/);
  for (const amountReference of [undefined, { ...reference, requestId: "unseen" }, { ...reference, sourceKey: "different-actor" },
    { ...reference, groupOpenid: "different-group" }]) {
    const rejected = await run({ amountReference }); assert.equal(rejected.outcome, "clarification"); assert.equal(rejected.evidence.actualCalls.length, 0);
  }
  for (const mutate of [
    () => { fresh.coupons.push({ ...fresh.coupons[1]!, id: "also-unused" }); },
    () => { fresh.coupons[1]!.expiresAt = "2000-01-01T00:00:00.000Z"; },
    () => { fresh.amounts.paidCents -= 200; fresh.payments[0]!.amountCents -= 200; },
    () => { fresh.payments[0]!.amountCents = 1; },
    () => { fresh.amounts.refundedCents = 10; },
  ]) {
    fresh = structuredClone(partial); mutate(); const rejected = await run();
    assert.equal(rejected.outcome, "clarification"); assert.equal(rejected.evidence.amountComparison, undefined);
    assert.deepEqual(rejected.evidence.actualCalls.map(call => call.name), ["get_order"]);
  }
  fresh = structuredClone(partial); fresh.amounts.totalCents = fresh.amounts.paidCents = 9720;
  Object.assign(fresh.items[0]!, { unitPriceCents: 4860, totalCents: 9720 }); fresh.payments[0]!.amountCents = 9720;
  const changed = await run(); assert.equal(changed.evidence.amountComparison!.remainingUnitPaidCents, 4860);
  assert.equal(changed.evidence.amountComparison!.referencePaidCents, 4760); assert.equal(changed.evidence.amountComparison!.comparisonEqual, false);
  assert.equal(test.preparations, 0);
}
console.log("[support-controller] v2.2 displayed-amount reference, fresh paid arithmetic and zero-knowledge read-only comparison PASS");
