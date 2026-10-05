import assert from "node:assert/strict";
import { merchantSourceKey } from "../src/after-sales.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, type SupportResult, type SupportTurnContext, type TrustedPolicyTopic } from "../src/support-controller.ts";
import { policyTopicQueries } from "../src/support-evidence-context.ts";
import { rememberOrderChoice } from "../src/support-context.ts";
import { emptyReferenceChoices, rememberReferenceChoice, selectReferenceChoice, type TrustedReferenceChoices } from "../src/support-reference-selection.ts";

// Real Controller, synthetic stores. These actions exercise the host contract,
// not a model's ability to recognize arbitrary ambiguous language.
const identity = { appId: "REFERENCE_CHECK", senderId: "OWNER" }, groupOpenid = "reference-controller";
const binding = { sourceKey: merchantSourceKey(identity, groupOpenid), groupOpenid };
const order: Awaited<ReturnType<CouponStore["getOrder"]>> = {
  source: "demo-database", id: "COUPON-2401", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 6000, paidCents: 6000, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: "reference-shop", name: "餐厅", merchantName: "商家", address: "地址" },
  items: [{ id: "item", productId: "reference-product", productName: "午餐券", quantity: 1, unitPriceCents: 6000, totalCents: 6000 }],
  coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 6000, paidAt: null }], refunds: [],
};
const reads: string[] = [], queries: string[] = [];
let afterRead: (() => void) | undefined;
const controller = new SupportController({ store: {
  async getOrder(who, id) { assert.deepEqual(who, identity); reads.push(id); afterRead?.(); return { ...structuredClone(order), id }; },
  async searchKnowledge(query) { queries.push(query); return [{ source: "demo-knowledge", sourceId: "SAME-DOCUMENT", title: "合成规则",
    body: "信用卡与余额有各自的到账条件。", scope: { shopId: null, productId: null } }]; },
} });
let sequence = 0;
const context = (userText: string, extra: Partial<SupportTurnContext> = {}): SupportTurnContext => ({ requestId: `reference-${++sequence}`,
  identity, sourceKey: binding.sourceKey, trustedRoute: { groupOpenid, messageId: `message-${sequence}` }, userText, ...extra });
const policy = (questionContext: { kind: "standalone" } | { kind: "previous"; requestId: string }, extra: Record<string, unknown> = {}) =>
  ({ protocol: "v2.2", kind: "policy", question: "模型问题不会替换原文", questionContext, ...extra }) as ContextSupportAction;
const previous = (topic: TrustedPolicyTopic, extra: Record<string, unknown> = {}) => policy({ kind: "previous", requestId: topic.requestId }, extra);
const text = (result: SupportResult) => { assert.ok("text" in result.reply); return result.reply.text; };
const stopped = (result: SupportResult, kind: "order" | "policy") => {
  assert.equal(result.outcome, "clarification"); assert.equal(result.pendingReferenceKind, kind);
  assert.deepEqual(result.evidence.actualCalls, []); assert.equal(result.verifiedPolicyTopic, undefined);
};

const first = await controller.createTurn(context("信用卡退款到账通常需要几天？")).execute(policy({ kind: "standalone" }));
const second = await controller.createTurn(context("余额退款到账需要等多久？")).execute(policy({ kind: "standalone" }));
const credit = first.verifiedPolicyTopic!, balance = second.verifiedPolicyTopic!;
assert.deepEqual(credit.sources, balance.sources, "Two questions can cite the same document without becoming one topic");
let choices = rememberReferenceChoice(undefined, binding, { kind: "policy", topic: credit })!;
choices = rememberReferenceChoice(choices, binding, { kind: "policy", topic: balance })!;
for (const topic of [credit, balance]) {
  const result = await controller.createTurn(context("超过这个时间应该怎么处理？", { policyChoices: choices, policyTopic: topic })).execute(previous(topic));
  stopped(result, "policy"); assert.match(text(result), /信用卡/); assert.match(text(result), /余额/);
  assert.equal(result.referencePresentation, "policy");
  assert.match(text(result), /选择话题/); assert.deepEqual(result.evidence.policyChoices, choices);
}
for (const field of ["policy_topic", "time_channel", "actor"] as const) {
  const result = await controller.createTurn(context("请继续", { policyChoices: choices })).execute({ protocol: "v2.2", kind: "clarify", field, reason: "ambiguous" });
  stopped(result, "policy"); assert.match(text(result), field === "time_channel" ? /支付渠道/ : field === "actor" ? /哪项操作/ : /具体使用规则/);
  assert.match(text(result), /选择话题/);
}
const orderStillPending = await controller.createTurn(context("也需要澄清话题", { policyChoices: choices, pendingReferenceKind: "order" }))
  .execute({ protocol: "v2.2", kind: "clarify", field: "policy_topic", reason: "ambiguous" });
stopped(orderStillPending, "order"); assert.equal(orderStillPending.referencePresentation, "policy");
assert.match(text(orderStillPending), /选择话题/, "A policy presentation must not replace an unresolved order reference");
const upgradedOrder = await controller.createTurn(context("先选哪笔订单", { pendingReferenceKind: "policy" }))
  .execute({ protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
stopped(upgradedOrder, "order");
for (const changed of [emptyReferenceChoices("policy", binding), { ...choices, sourceKey: "foreign" },
  { ...choices, groupOpenid: "foreign" }, { ...choices, candidates: choices.candidates.map(row => ({ ...row, expiresAt: 1 })) }]) {
  const result = await controller.createTurn(context("接着刚才的时间问", { policyChoices: changed, policyTopic: credit })).execute(previous(credit));
  stopped(result, "policy");
  assert.equal(result.referencePresentation, undefined, "No usable candidate token was displayed");
}
const selected = selectReferenceChoice(choices, binding, choices.candidates[0]!.token)!;
const selectedFollow = await controller.createTurn(context("如果超过这个时间还没到，应去哪核实？", { policyChoices: selected, policyTopic: balance }))
  .execute(previous(credit));
assert.equal(selectedFollow.outcome, "ready");
assert.equal(selectedFollow.evidence.knowledge[0]!.context.policyTopic!.requestId, credit.requestId);
assert.ok(queries.at(-1)!.includes(credit.originalQuery) && !queries.at(-1)!.includes(balance.originalQuery));
assert.equal(selectedFollow.verifiedPolicyTopic!.originalQuery, "如果超过这个时间还没到，应去哪核实？");
assert.deepEqual(selectedFollow.verifiedPolicyTopic!.priorQueries, [{ requestId: credit.requestId, originalQuery: credit.originalQuery }]);
const stillPending = await controller.createTurn(context("继续", { policyChoices: selected, pendingReferenceKind: "policy" })).execute(previous(credit));
stopped(stillPending, "policy");

// A continuation replaces the selected candidate and carries its real question
// chain, including the latest request, instead of permanently pointing to turn 1.
const continued = rememberReferenceChoice(selected, binding, { kind: "policy", topic: selectedFollow.verifiedPolicyTopic! }, { continueRequestId: credit.requestId })!;
const next = await controller.createTurn(context("这项核实需要先准备什么？", { policyChoices: continued })).execute(previous(selectedFollow.verifiedPolicyTopic!,
  { evidenceTarget: { kind: "rule_only", basis: "信用卡退款到账" } }));
assert.equal(next.outcome, "ready");
assert.equal(next.evidence.knowledge[0]!.context.evidenceTarget!.basisRequestId, credit.requestId);
assert.ok(queries.at(-1)!.includes(credit.originalQuery) && queries.at(-1)!.includes(selectedFollow.verifiedPolicyTopic!.originalQuery));
assert.deepEqual(policyTopicQueries(next.verifiedPolicyTopic!)!.map(row => row.requestId), [credit.requestId, selectedFollow.evidence.requestId, next.evidence.requestId]);
const independent = await controller.createTurn(context("我完整重新咨询：余额退款到账通常需要几天？", { policyChoices: choices, pendingReferenceKind: "policy" }))
  .execute(policy({ kind: "standalone" }));
assert.equal(independent.outcome, "ready"); assert.equal(independent.pendingReferenceKind, "policy");
assert.equal(independent.referencePresentation, undefined, "Inherited pending is not a new selection presentation");
assert.equal(independent.evidence.knowledge[0]!.context.policyTopic, null); assert.deepEqual(independent.verifiedPolicyTopic!.priorQueries, []);
assert.ok(!queries.at(-1)!.includes(credit.originalQuery), "Standalone neither inherits old facts nor silently clears a pending choice");

let orderChoices = rememberOrderChoice(undefined, binding, order.id, "lookup-A");
orderChoices = rememberOrderChoice(orderChoices, binding, "COUPON-2402", "lookup-B");
let orderReferences = rememberReferenceChoice(undefined, binding, { kind: "order", requestId: "lookup-A", orderId: order.id })!;
orderReferences = rememberReferenceChoice(orderReferences, binding, { kind: "order", requestId: "lookup-B", orderId: "COUPON-2402" })!;
const orderContext = { focusOrderId: "COUPON-2402", orderChoices, orderReferenceChoices: orderReferences };
for (const ref of [{ kind: "focus" }, { kind: "alternative" }] as const) {
  const result = await controller.createTurn(context("那笔还能退吗？", { ...orderContext, pendingReferenceKind: "order" }))
    .execute({ protocol: "v2.2", kind: "refund_eligibility", question: "退款条件", questionContext: { kind: "standalone" }, orderRef: ref });
  stopped(result, "order"); assert.match(text(result), /选择订单/); assert.deepEqual(result.evidence.orderReferenceChoices, orderReferences);
}
stopped(await controller.createTurn(context("沿用刚才", { ...orderContext, policyTopic: credit, pendingReferenceKind: "order" })).execute(previous(credit)), "order");
const explicit = await controller.createTurn(context(`${order.id} 的退款申请条件是什么？`, { ...orderContext, pendingReferenceKind: "order" }))
  .execute({ protocol: "v2.2", kind: "refund_eligibility", question: "退款条件", questionContext: { kind: "standalone" }, orderRef: { kind: "explicit", orderId: order.id } });
assert.equal(explicit.outcome, "ready"); assert.equal(explicit.evidence.order!.id, order.id); assert.equal(explicit.pendingReferenceKind, "order");
assert.equal(reads.at(-1), order.id, "Explicit current-message order still gets a fresh authorized read while a prior ambiguity is pending");
const realNow = Date.now;
try {
  let now = realNow(); Date.now = () => now;
  const expiring = rememberReferenceChoice(undefined, binding, { kind: "policy", topic: explicit.verifiedPolicyTopic! })!;
  const expiry = expiring.candidates[0]!.expiresAt;
  afterRead = () => { now = expiry; };
  const expiredDuringRead = await controller.createTurn(context("仍按刚才条件吗？", { focusOrderId: order.id, policyChoices: expiring }))
    .execute(previous(explicit.verifiedPolicyTopic!, { orderRef: { kind: "focus" } }));
  assert.equal(expiredDuringRead.outcome, "clarification"); assert.equal(expiredDuringRead.pendingReferenceKind, "policy");
  assert.deepEqual(expiredDuringRead.evidence.actualCalls.map(call => call.name), ["get_order"], "Expiry during fresh read stops before knowledge work");
  assert.equal(expiredDuringRead.referencePresentation, undefined);
} finally { Date.now = realNow; afterRead = undefined; }
const refundTopic = { ...explicit.verifiedPolicyTopic!, orderId: "COUPON-2402", originalQuery: "此单已经退款，是否还能再次申请？" };
const alternative = await controller.createTurn(context("另一笔订单还能申请退款吗？", { ...orderContext, policyTopic: refundTopic }))
  .execute({ protocol: "v2.2", kind: "refund_eligibility", question: "退款条件", questionContext: { kind: "previous", requestId: refundTopic.requestId }, orderRef: { kind: "alternative" } });
assert.equal(alternative.outcome, "ready"); assert.equal(alternative.evidence.order!.id, order.id);
assert.ok(queries.at(-1)!.includes("新选定订单的退款申请资格") && !queries.at(-1)!.includes(refundTopic.originalQuery));
assert.deepEqual(alternative.verifiedPolicyTopic!.priorQueries, [], "Cross-order continuation never inherits the old order's question chain");
const threeOrders = rememberOrderChoice(orderChoices, binding, "COUPON-2403", "lookup-C");
stopped(await controller.createTurn(context("另一笔可以退吗？", { ...orderContext, focusOrderId: "COUPON-2403", orderChoices: threeOrders }))
  .execute({ protocol: "v2.2", kind: "refund_eligibility", question: "退款条件", questionContext: { kind: "standalone" }, orderRef: { kind: "alternative" } }), "order");

// Explicit limits reject before stores and allow a fully restated new question.
for (const topic of [
  { ...credit, priorQueries: Array.from({ length: 4 }, (_, i) => ({ requestId: `history-${i}`, originalQuery: `第${i}个真实原问？` })) },
  { ...credit, originalQuery: "条".repeat(490) },
]) {
  const long = await controller.createTurn(context("沿用前面所有条件，请继续说明后续办理流程。", { policyTopic: topic })).execute(previous(topic));
  stopped(long, "policy"); assert.match(text(long), /完整重述/);
  assert.equal(long.referencePresentation, undefined, "Budget restatement does not publish a token choice");
}
for (const priorQueries of [[{ requestId: credit.requestId, originalQuery: "重复请求" }], [{ requestId: "prior", originalQuery: "" }]]) {
  assert.equal(policyTopicQueries({ ...credit, priorQueries }), undefined);
}
const allExpired: TrustedReferenceChoices = { ...selected, candidates: selected.candidates.map(row => ({ ...row, expiresAt: 1 })) };
stopped(await controller.createTurn(context("继续", { policyChoices: allExpired, policyTopic: credit })).execute(previous(credit)), "policy");
console.log("Reference Controller checks passed: authoritative competing choices, selected recovery, targeted clarification, fresh order boundaries and bounded true question chains; 0 API.");
