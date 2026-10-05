import assert from "node:assert/strict";
import { merchantSourceKey } from "../src/after-sales.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { gateKnowledgeApplicability, knowledgeApplicabilitySourceHash, validateKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import type { KnowledgeSearchInput, KnowledgeService, KnowledgeTrace } from "../src/knowledge-service.ts";
import { SupportProtocolError } from "../src/support-action.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, type SupportTurnContext } from "../src/support-controller.ts";
import { buildSupportEvidenceBinding, evidenceBindingVersion } from "../src/support-evidence-context.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
const identity = { appId: "EVIDENCE_CHECK", senderId: "OWNER" }, groupOpenid = "evidence-check";
const sourceKey = merchantSourceKey(identity, groupOpenid), orderId = "COUPON-2301";
const order: Order = { source: "demo-database", id: orderId, status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 6000, paidCents: 6000, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: "unit-shop", name: "餐厅", merchantName: "商家", address: "地址" },
  items: [{ id: "unit-item", productId: "unit-product", productName: "测试套餐", quantity: 1, unitPriceCents: 6000, totalCents: 6000 }],
  coupons: [{ id: "unit-coupon", orderItemId: "unit-item", status: "unused", expiresAt: "2026-10-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 6000, paidAt: null }], refunds: [] };
const candidates = [
  { id: "USED", title: "核销后规则", body: "已经核销时须先核实。", tags: [], shopId: null, productId: null, rank: 1, score: .9 },
  { id: "EXPIRED", title: "过期规则", body: "未核销但超过有效期，可咨询过期处理。", tags: [], shopId: null, productId: null, rank: 2, score: .8 },
];
const snapshot = validateKnowledgeApplicabilitySnapshot({ version: 1, serialization: "knowledge-document-v1", documents: candidates.map((doc, i) => ({
  sourceId: doc.id, scope: { shopId: null, productId: null }, sourceHash: knowledgeApplicabilitySourceHash(doc),
  atLeastOneCouponInStates: i ? ["unused", "expired"] : ["redeemed"],
  basis: [{ field: "atLeastOneCouponInStates", quote: doc.body }], reviewNote: "Synthetic engineering predicate" })) });
const observed: KnowledgeSearchInput[] = [], calls: string[] = [];
let fresh = structuredClone(order), sequence = 0;
const knowledge: KnowledgeService = { async search(input) {
  calls.push("search_faq"); observed.push(structuredClone(input));
  const gate = gateKnowledgeApplicability({ snapshot, context: input.applicabilityContext ?? null, scope: input.scope, candidates });
  const documents = gate.candidates.map(doc => ({ source: "demo-knowledge" as const, sourceId: doc.id, title: doc.title, body: doc.body, scope: { shopId: null, productId: null } }));
  // The injected service selects the compact candidate; Controller must preserve
  // its actual ranking query independently of the full evidence query/span input.
  const trace: KnowledgeTrace = { mode: "lexical", threshold: null, query: input.retrievalQuery ?? input.query, originalQuery: input.originalQuery ?? input.query, scope: input.scope,
    status: documents.length ? "accepted" : "rejected", reason: null, rawRanking: candidates.map(doc => ({ id: doc.id, score: doc.score })),
    acceptance: null, sources: [], sourceHashes: { before: null, after: null }, durationMs: 0, calls: [],
    usage: { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
    pricing: { estimated: true, rerankCnyPerMillionTokens: null, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" } };
  return { documents, trace };
} };
const controller = new SupportController({ store: { async getOrder(who, id) { assert.deepEqual(who, identity); assert.equal(id, fresh.id);
  calls.push("get_order"); return structuredClone(fresh); }, async searchKnowledge() { throw new Error("Injected knowledge required"); } }, knowledge });
const context = (userText: string, extra: Partial<SupportTurnContext> = {}): SupportTurnContext => ({ requestId: `evidence-${++sequence}`, identity, sourceKey,
  trustedRoute: { groupOpenid, messageId: `message-${sequence}` }, userText, ...extra });
const action = (kind: "policy" | "refund_eligibility", extra: Record<string, unknown> = {}) => ({ protocol: "v2.2", kind,
  question: "模型改写成无关问题不会替换原问", questionContext: { kind: "standalone" }, orderRef: { kind: "explicit", orderId }, ...extra }) as ContextSupportAction;

const question = `${orderId} 现在还符合哪些处理条件？`, current = [];
for (const kind of ["policy", "refund_eligibility"] as const) {
  const result = await controller.createTurn(context(question, { requestId: "paired-request" })).execute(action(kind));
  const binding = result.evidence.knowledge[0]!.context; current.push(binding);
  assert.equal(binding.evidenceBindingVersion, evidenceBindingVersion); assert.equal(binding.purpose, "current_order");
  assert.equal(binding.evidenceUse, "current_order"); assert.deepEqual(result.evidence.rules.map(doc => doc.sourceId), ["EXPIRED"]);
  assert.deepEqual(binding.facts!.couponCounts, { total: 1, unused: 1, redeemed: 0, expired: 0, refunded: 0 });
  assert.deepEqual(binding.facts!.couponDates, [{ couponId: "unit-coupon", status: "unused", expiresAt: order.coupons[0]!.expiresAt, expiredAtAsOf: true }]);
  assert.ok(binding.effectiveQuery.startsWith("该订单 现在还符合哪些处理条件？"));
  assert.ok(binding.effectiveQuery.includes("已过期0张") && binding.effectiveQuery.includes("日期已过期1张"));
  assert.ok(!binding.effectiveQuery.includes("无关问题"));
  assert.equal(binding.retrievalQuery, "该订单 现在还符合哪些处理条件？\n已核实订单商品：测试套餐。\n订单状态对应的规则条件：过期退款。");
  assert.equal(observed.at(-1)!.query, binding.effectiveQuery); assert.equal(observed.at(-1)!.retrievalQuery, binding.retrievalQuery);
  assert.equal(observed.at(-1)!.originalQuery, question);
  const span = result.evidence.actualCalls.find(call => call.name === "search_faq")!;
  assert.equal(span.input.query, binding.effectiveQuery); assert.equal(span.input.retrievalQuery, binding.retrievalQuery);
  assert.equal(span.knowledge!.trace.query, binding.retrievalQuery, "Controller must not relabel the service's actual ranking query as the full query");
}
assert.deepEqual(current[0], current[1], "Near-synonym action kinds share query, facts, purpose and gate binding");
assert.deepEqual(calls, ["get_order", "search_faq", "get_order", "search_faq"]);

const hypothetical = `${orderId} 假如之后核销，处理规则有什么不同？`, basis = "假如之后核销";
const explained = await controller.createTurn(context(hypothetical)).execute(action("policy", { evidenceTarget: { kind: "rule_only", basis } }));
const explanation = explained.evidence.knowledge[0]!.context;
assert.equal(explanation.evidenceUse, "explanation"); assert.equal(observed.at(-1)!.applicabilityContext, null);
assert.deepEqual(explanation.facts, current[0]!.facts, "Rule-only keeps actual fresh facts in the audit without using them as hypothetical conditions");
assert.ok(explanation.effectiveQuery.includes(basis) && explanation.effectiveQuery.includes("不证明当前订单已满足"));
assert.ok(!explanation.effectiveQuery.includes("已核实本单券数"), "Actual coupon state must not overwrite an explicit hypothetical");
assert.equal(explanation.retrievalQuery, explanation.effectiveQuery, "Hypothetical ranking keeps its basis and explanation boundary, without current lifecycle facts");
assert.ok(!explanation.retrievalQuery!.includes("过期退款"));
assert.ok(explained.evidence.rules.some(doc => doc.sourceId === "USED"));
assert.deepEqual(explained.evidence.actualCalls.map(call => call.name), ["get_order", "search_faq"]);

const topic = explained.verifiedPolicyTopic!, followQuestion = "延续刚才的假设，该条件下怎么处理？";
const follow = action("policy", { orderRef: { kind: "focus" }, questionContext: { kind: "previous", requestId: topic.requestId }, evidenceTarget: { kind: "rule_only", basis } });
const followed = await controller.createTurn(context(followQuestion, { focusOrderId: orderId, policyTopic: topic })).execute(follow);
assert.equal(followed.evidence.knowledge[0]!.context.evidenceTarget!.basisSource, "previous_policy_topic");
assert.equal(followed.evidence.knowledge[0]!.context.evidenceTarget!.basisRequestId, topic.requestId);
assert.ok(followed.evidence.knowledge[0]!.context.retrievalQuery!.includes(hypothetical.replaceAll(orderId, "该订单")));
for (const changed of [{ ...topic, sourceKey: "other-owner" }, { ...topic, groupOpenid: "other-group" },
  { ...topic, orderId: "COUPON-2302" }, { ...topic, requestId: "unknown-request" }, { ...topic, sources: [] }]) {
  const before = calls.length;
  const unresolved = await controller.createTurn(context(followQuestion, { focusOrderId: orderId, policyTopic: changed })).execute(follow);
  assert.equal(unresolved.outcome, "clarification"); assert.equal(unresolved.pendingReferenceKind, "policy");
  assert.equal(calls.length, before, "Foreign or missing previous-basis references fail before any business call");
}
const repairing = controller.createTurn(context(hypothetical)), beforeRepair = calls.length;
await assert.rejects(repairing.execute(action("policy", { evidenceTarget: { kind: "rule_only", basis: "商家已经批准退款" } })), SupportProtocolError);
assert.equal(calls.length, beforeRepair);
assert.equal((await repairing.execute(action("policy", { evidenceTarget: { kind: "rule_only", basis } }))).outcome, "ready", "Source-invalid protocol can be repaired before lock");
await assert.rejects(controller.createTurn(context(followQuestion, { focusOrderId: orderId, policyTopic: topic })).execute(action("policy",
  { orderRef: { kind: "focus" }, evidenceTarget: { kind: "rule_only", basis } })), SupportProtocolError, "Standalone cannot quietly use an unreferenced earlier question");

// A subsequent prepare builds new current-order evidence instead of promoting the old explanation.
const prepared = await controller.createTurn(context(`${orderId} 请准备退款方案`, { policyTopic: topic })).execute({ protocol: "v2.2", kind: "refund_prepare", orderRef: { kind: "explicit", orderId } });
const prerequisite = prepared.evidence.knowledge[0]!.context;
assert.equal(prerequisite.evidenceUse, "current_order"); assert.equal(prerequisite.purpose, "business_prerequisite");
assert.equal(prerequisite.applicability!.requestId, prepared.evidence.requestId);
assert.equal(prerequisite.retrievalQuery, "过期退款\n已核实订单商品：测试套餐。", "Write prerequisites retain the fixed business-policy query instead of user commands");
assert.deepEqual(prepared.evidence.actualCalls.map(call => call.name), ["get_order", "search_faq"]);
assert.equal(prepared.outcome, "blocked", "Absent business approval/services are not supplied by explanation evidence");

fresh.coupons[0]!.expiresAt = null;
const unknownDate = await controller.createTurn(context(question)).execute(action("policy"));
assert.equal(unknownDate.evidence.knowledge[0]!.context.facts!.couponDates![0]!.expiredAtAsOf, null);
assert.ok(unknownDate.evidence.knowledge[0]!.context.effectiveQuery.includes("截止时间未知1张"));
fresh.coupons[0]!.orderItemId = "unrelated-item";
const beforeIncomplete = observed.length;
const incomplete = await controller.createTurn(context(question)).execute(action("policy"));
assert.equal(incomplete.outcome, "clarification"); assert.equal(incomplete.reply.kind, "notice");
assert.match(incomplete.reply.text, /订单与券记录不完整/);
assert.deepEqual(incomplete.evidence.actualCalls.map(call => call.name), ["get_order"]);
assert.equal(observed.length, beforeIncomplete, "Invalid coupon ownership cannot manufacture a zero-count gate context");
fresh = structuredClone(order); fresh.coupons[0]!.expiresAt = "not-a-date";
const invalidDate = await controller.createTurn(context(question)).execute(action("policy"));
assert.equal(invalidDate.outcome, "clarification"); assert.equal(invalidDate.reply.kind, "notice");
assert.match(invalidDate.reply.text, /券有效期数据无效/);
assert.deepEqual(invalidDate.evidence.actualCalls.map(call => call.name), ["get_order"]);
assert.equal(observed.length, beforeIncomplete, "Invalid date stops before model/knowledge work");

fresh = structuredClone(order); fresh.items[0]!.quantity = 2;
fresh.coupons.push({ ...fresh.coupons[0]!, id: "redeemed-coupon", status: "redeemed", expiresAt: "2027-01-01T00:00:00.000Z" });
const dateBefore = await controller.createTurn(context(question)).execute(action("policy"));
[fresh.coupons[0]!.expiresAt, fresh.coupons[1]!.expiresAt] = [fresh.coupons[1]!.expiresAt, fresh.coupons[0]!.expiresAt];
const dateAfter = await controller.createTurn(context(question)).execute(action("policy"));
const beforeQuery = dateBefore.evidence.knowledge[0]!.context.effectiveQuery, afterQuery = dateAfter.evidence.knowledge[0]!.context.effectiveQuery;
assert.notEqual(beforeQuery, afterQuery, "Swapping expiry between unused/redeemed coupons must change the question's fresh facts");
assert.match(beforeQuery, /未核销券：日期已过期1张、未到期0张/);
assert.match(afterQuery, /未核销券：日期已过期0张、未到期1张/);
assert.equal(dateBefore.evidence.knowledge[0]!.context.retrievalQuery, dateAfter.evidence.knowledge[0]!.context.retrievalQuery,
  "Ranking excludes date/count detail while verification still distinguishes which coupon expired");
const priorQuestion = `${orderId} 我想先弄清楚这笔订单的券各自有什么使用日期限制，尤其是未核销与已核销的券如何区分；这里仅咨询规则，不要求立即退款。`;
const prior = await controller.createTurn(context(priorQuestion)).execute(action("policy"));
assert.equal(prior.outcome, "ready");
const priorTopic = prior.verifiedPolicyTopic!;
const longerFollowup = "沿用上一次咨询的规则，请解释其中有效期和券状态之间的区别：如果我周末才有空使用，应该先核实哪些日期条件？本轮只是继续咨询，没有要求生成退款方案。";
const longFollow = await controller.createTurn(context(longerFollowup, { focusOrderId: orderId, policyTopic: priorTopic })).execute(action("policy",
  { orderRef: { kind: "focus" }, questionContext: { kind: "previous", requestId: priorTopic.requestId } }));
assert.equal(longFollow.outcome, "ready", "A standard previous question plus mixed coupon states fits the actual retrieval budget");
const longQuery = longFollow.evidence.knowledge[0]!.context.effectiveQuery;
assert.ok(longQuery.length <= 500);
assert.ok(longQuery.includes(longerFollowup) && longQuery.includes(priorQuestion.replaceAll(orderId, "该订单")), "Neither question is truncated to fit fresh facts");
const longRetrieval = longFollow.evidence.knowledge[0]!.context.retrievalQuery!;
assert.ok(longRetrieval.includes(longerFollowup) && longRetrieval.includes(priorQuestion.replaceAll(orderId, "该订单")), "Compact query preserves both actual questions");
assert.ok(!longRetrieval.includes("已核实本单券数") && !longRetrieval.includes("有效期事实"));

const alternativeOrder = structuredClone(order); alternativeOrder.id = "COUPON-2302";
const alternative = buildSupportEvidenceBinding({ action: { protocol: "v2.2", kind: "refund_eligibility", question: "模型改写不能替代原问",
  questionContext: { kind: "previous", requestId: topic.requestId }, orderRef: { kind: "alternative" } },
  originalQuery: "那另一张还能申请退款吗？", order: alternativeOrder, requestId: "alternative-request",
  verifiedTopic: { ...topic, intent: "refund_eligibility", originalQuery: `${orderId} 已退款了，是否可以再次申请？` },
  binding: { sourceKey, groupOpenid, orderId: alternativeOrder.id } });
assert.ok(alternative.retrievalQuery.startsWith("那另一张还能申请退款吗？\n本轮继续咨询新选定订单的退款申请资格与条件。"));
assert.ok(alternative.retrievalQuery.includes("过期退款") && !alternative.retrievalQuery.includes("已退款了"), "Cross-order ranking carries intent plus new facts, never old order state");

const global = buildSupportEvidenceBinding({ action: { protocol: "v2.2", kind: "policy", question: "一般条件", questionContext: { kind: "standalone" } },
  originalQuery: "一般条件如何规定？", binding: { sourceKey, groupOpenid, orderId: null }, requestId: "global" });
assert.equal(global.evidenceUse, "explanation"); assert.equal(global.facts, null); assert.equal(global.applicability, undefined);
assert.equal(global.retrievalQuery, global.effectiveQuery);
fresh = structuredClone(order);
const legacy = await controller.createTurn(context(question)).execute({ kind: "policy", question: "旧协议", orderRef: { kind: "explicit", orderId } });
assert.equal(legacy.evidence.knowledge[0]!.context.evidenceBindingVersion, undefined);
assert.equal(legacy.evidence.knowledge[0]!.context.effectiveQuery, "该订单 现在还符合哪些处理条件？\n已核实订单商品：测试套餐。", "Historical replay query is unchanged");
assert.equal(legacy.evidence.knowledge[0]!.context.retrievalQuery, undefined, "Historical binding has no newly inferred compact query");
assert.equal(observed.at(-1)!.retrievalQuery, observed.at(-1)!.query);
let storeQuery: string | undefined;
const fallback = new SupportController({ store: { async getOrder() { return structuredClone(order); }, async searchKnowledge(query) { storeQuery = query; return []; } } });
const fallbackResult = await fallback.createTurn(context(question)).execute(action("policy"));
const fallbackSpan = fallbackResult.evidence.actualCalls.find(call => call.name === "search_faq")!;
assert.equal(storeQuery, fallbackSpan.knowledge!.context.effectiveQuery);
assert.equal(fallbackSpan.input.query, storeQuery); assert.equal(fallbackSpan.input.retrievalQuery, storeQuery);
assert.equal(fallbackSpan.knowledge!.trace.query, storeQuery, "Store-only legacy lexical mode records its actual full ranking input");
assert.notEqual(fallbackSpan.knowledge!.context.retrievalQuery, storeQuery, "Audit can retain the compact candidate without claiming it was executed");
console.log("Support evidence binding checks passed: paired actions, separate ranking/evidence queries, fresh status/date split, hypothetical/previous/alternative provenance and legacy fallback; 0 API.");
