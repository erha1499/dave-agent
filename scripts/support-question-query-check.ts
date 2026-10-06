import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { merchantSourceKey } from "../src/after-sales.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { SupportProtocolError } from "../src/support-action.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { rememberOrderChoice } from "../src/support-context.ts";
import { SupportController, type SupportTurnContext } from "../src/support-controller.ts";
import { buildSupportEvidenceBinding, evidenceBindingVersion, evidenceBindingV3Version, evidenceBindingVersions } from "../src/support-evidence-context.ts";
import { supportQuestionResolutionInputHash, supportQuestionResolutionVersion, type SupportQuestionResolutionInput } from "../src/support-question-resolution.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Input = Parameters<typeof buildSupportEvidenceBinding>[0];
const identity = { appId: "QUESTION_QUERY_CHECK", senderId: "SYNTHETIC_OWNER" }, groupOpenid = "QUESTION_QUERY_GROUP";
const sourceKey = merchantSourceKey(identity, groupOpenid), orderId = "COUPON-9701", asOf = "2026-10-06T00:00:00.000Z";
const productName = "合成双人午餐券", future = "2026-12-01T00:00:00.000Z", past = "2026-10-01T00:00:00.000Z";
const order: Order = { source: "demo-database", id: orderId, status: "paid", asOf,
  amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: asOf, paidAt: asOf,
  shop: { id: "query-shop", name: "合成餐厅", merchantName: "合成商家", address: "合成地址" },
  items: [{ id: "query-item", productId: "query-lunch", productName, quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
  coupons: [{ id: "query-coupon", orderItemId: "query-item", status: "unused", expiresAt: future, redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 7980, paidAt: asOf }], refunds: [] };
const normalize = (text: string) => text.replaceAll(`订单 ${orderId}`, "该订单").replaceAll(orderId, "该订单");
const action = (kind: "policy" | "refund_eligibility", extra: object = {}): ContextSupportAction => ({ protocol: "v2.2", kind,
  question: "模型自行改写为商家已批准，不是咨询出处", questionContext: { kind: "standalone" },
  orderRef: { kind: "explicit", orderId }, ...extra });
const input = (originalQuery: string, fresh = order, kind: "policy" | "refund_eligibility" = "policy"): Input => ({
  action: action(kind), originalQuery, order: fresh, requestId: "query-current", binding: { sourceKey, groupOpenid, orderId } });
const consultation = (question: string) => normalize(`${question}\n已核实订单商品：${productName}。`);

// The expected lifecycle projections are authored independently of the builder.
// State words remain factual evidence; they are not an automatically added refund request.
const states = [
  { name: "unused", status: "paid", coupons: ["unused"], expiry: [future], refundState: "未核销退款",
    counts: "共1张，未核销1张、已核销0张、已过期0张、已退款0张", dates: "未核销券：日期已过期0张、未到期1张、截止时间未知0张" },
  { name: "redeemed", status: "redeemed", coupons: ["redeemed"], expiry: [future], refundState: "已核销退款",
    counts: "共1张，未核销0张、已核销1张、已过期0张、已退款0张", dates: "已核销券：日期已过期0张、未到期1张、截止时间未知0张" },
  { name: "expired", status: "paid", coupons: ["expired"], expiry: [past], refundState: "过期退款",
    counts: "共1张，未核销0张、已核销0张、已过期1张、已退款0张", dates: "已过期券：日期已过期1张、未到期0张、截止时间未知0张" },
  { name: "refunded", status: "refunded", coupons: ["refunded"], expiry: [future], refundState: "已退款重复退款",
    counts: "共1张，未核销0张、已核销0张、已过期0张、已退款1张", dates: "已退款券：日期已过期0张、未到期1张、截止时间未知0张" },
  { name: "mixed", status: "partially_redeemed", coupons: ["unused", "redeemed"], expiry: [future, past], refundState: "部分核销剩余退款",
    counts: "共2张，未核销1张、已核销1张、已过期0张、已退款0张", dates: "未核销券：日期已过期0张、未到期1张、截止时间未知0张；已核销券：日期已过期1张、未到期0张、截止时间未知0张" },
] as const;
const freshOrder = (state: typeof states[number]): Order => {
  const fresh = structuredClone(order); fresh.status = state.status;
  const quantity = state.coupons.length; fresh.items[0]!.quantity = quantity;
  fresh.amounts.totalCents = fresh.amounts.paidCents = fresh.items[0]!.totalCents = fresh.payments[0]!.amountCents = 7980 * quantity;
  fresh.coupons = state.coupons.map((status, index) => ({ ...fresh.coupons[0]!, id: `query-coupon-${index}`, status, expiresAt: state.expiry[index]!,
    redeemedAt: status === "redeemed" ? asOf : null, redeemedShopId: status === "redeemed" ? fresh.shop.id : null }));
  if (state.name === "refunded") { fresh.amounts.refundedCents = fresh.amounts.paidCents;
    fresh.refunds = [{ status: "succeeded", amountCents: fresh.amounts.paidCents, completedAt: asOf }]; }
  return fresh;
};
const neutralFacts = (state: typeof states[number]) => `\n已核实订单状态：${state.status}。`
  + `\n已核实本单券数：${state.counts}（按券状态字段计数）。`
  + `\n有效期事实（截至${asOf}）：${state.dates}。`
  + "\n以上订单事实仅用于判断上述咨询的适用条件，不构成新的咨询问题。";

export async function checkSupportQuestionQuery() {
  const questions = [
    `订单 ${orderId}：请说明这张团购券一张对应的用餐人数，别把每券价格当人数依据。`,
    `订单 ${orderId}：我问商品在非节假日、无特殊活动的普通周日有哪些到店限制，只解释使用规则，不办理其他业务。`,
    `订单 ${orderId}：这张券还符合申请退款的条件吗？请保留当前核销状态与截止时间限制，不承诺商家批准或到账。`,
  ];
  let checked = 0;
  for (const state of states) for (const question of questions) {
    const fresh = freshOrder(state), oracle = consultation(question), actuals = [];
    for (const kind of ["policy", "refund_eligibility"] as const) {
      const actual = buildSupportEvidenceBinding({ ...input(question, fresh, kind), version: evidenceBindingV3Version });
      assert.equal(actual.evidenceBindingVersion, evidenceBindingV3Version);
      assert.equal(actual.retrievalQuery, oracle, `${state.name}: ranking preserves only the actual consultation and product`);
      assert.equal(actual.effectiveQuery, oracle + neutralFacts(state), `${state.name}: neutral facts must not manufacture a different question`);
      assert.equal(actual.facts!.refundState, state.refundState, "The lifecycle interpretation remains in audit facts");
      assert.equal(actual.facts!.status, fresh.status); assert.equal(actual.facts!.couponCounts.total, fresh.coupons.length);
      assert.equal(actual.applicability!.orderId, fresh.id); assert.equal(actual.applicability!.asOf, asOf);
      assert.ok(!actual.effectiveQuery.includes("模型自行改写"));
      assert.doesNotMatch(actual.effectiveQuery.slice(oracle.length), /订单状态对应的规则条件|状态对应条件：|未核销退款|已核销退款|过期退款|已退款重复退款|部分核销剩余退款/);
      if (!question.includes("退款")) assert.ok(!actual.retrievalQuery.includes("退款"));
      else assert.ok(actual.retrievalQuery.includes("这张券还符合申请退款的条件吗？"), "Explicit refund intent still originates in the actual message");
      actuals.push(actual); checked++;
    }
    assert.deepEqual(actuals[0], actuals[1], "The near-synonym read-only action labels do not alter the user's question");
  }

  // Obtain the donor from actual authorized Controller reads/source results,
  // then verify exact user questions, not model question text, enter the binding.
  const reads: string[] = [], queries: string[] = [], body = "【合成工程规则】普通周日到店前需自行确认接待。";
  const controller = new SupportController({ store: {
    async getOrder(who, id) { assert.deepEqual(who, identity); assert.equal(id, orderId); reads.push(id); return structuredClone(order); },
    async searchKnowledge(query) { queries.push(query); return [{ source: "demo-knowledge", sourceId: "QUERY-RULE", title: "合成咨询规则", body,
      scope: { shopId: order.shop.id, productId: order.items[0]!.productId } }]; },
  } });
  const oldQuestion = `订单 ${orderId}：常规午餐套餐如果安排普通周日到店，接待方面还要向谁核实？`;
  const donor = await controller.createTurn({ identity, sourceKey, requestId: "query-donor", userText: oldQuestion,
    trustedRoute: { groupOpenid, messageId: "query-donor" } }).execute(action("policy"));
  const topic = donor.verifiedPolicyTopic!; assert.ok(topic); assert.equal(topic.originalQuery, oldQuestion);
  assert.deepEqual(reads, [orderId]); assert.equal(queries.length, 1); assert.equal(topic.sources[0]!.sourceId, "QUERY-RULE");
  const followQuestion = "那周日之前的接待核实由谁来做，助手会替我预约吗？";
  for (const kind of ["policy", "refund_eligibility"] as const) {
    const previous = action(kind, { orderRef: { kind: "focus" }, questionContext: { kind: "previous", requestId: topic.requestId } });
    const followed = buildSupportEvidenceBinding({ ...input(followQuestion, order, kind), action: previous, verifiedTopic: topic, version: evidenceBindingV3Version });
    const expected = consultation(`${followQuestion}\n上轮已完成取证的问题（仅用于理解本轮指代）：${oldQuestion}`);
    assert.equal(followed.retrievalQuery, expected); assert.equal(followed.effectiveQuery, expected + neutralFacts(states[0]));
    assert.ok(followed.retrievalQuery.includes(oldQuestion.replaceAll(`订单 ${orderId}`, "该订单")));
    assert.ok(!followed.retrievalQuery.includes("商家已批准"));
  }
  for (const changed of [{ ...topic, requestId: "missing-donor" }, { ...topic, sourceKey: "foreign-owner" },
    { ...topic, groupOpenid: "foreign-group" }, { ...topic, orderId: "COUPON-9702" }]) {
    assert.throws(() => buildSupportEvidenceBinding({ ...input(followQuestion), version: evidenceBindingV3Version, verifiedTopic: changed,
      action: action("policy", { questionContext: { kind: "previous", requestId: topic.requestId } }) }), SupportProtocolError);
  }

  const hypothetical = `订单 ${orderId}：仅假设之后已经核销，通常由谁核实售后原因？这不是本单核销事实。`, basis = "假设之后已经核销";
  const ruleOnly = buildSupportEvidenceBinding({ ...input(hypothetical), version: evidenceBindingV3Version,
    action: action("policy", { evidenceTarget: { kind: "rule_only", basis } }) });
  const explanation = consultation(hypothetical) + `\n仅解释所问规则条件（原文依据：${basis}），不证明当前订单已满足，也不构成退款批准。`;
  assert.equal(ruleOnly.evidenceBindingVersion, evidenceBindingV3Version);
  assert.equal(ruleOnly.retrievalQuery, explanation); assert.equal(ruleOnly.effectiveQuery, explanation);
  assert.equal(ruleOnly.evidenceUse, "explanation"); assert.equal(ruleOnly.applicability, undefined);
  assert.equal(ruleOnly.facts!.couponCounts.unused, 1); assert.ok(!ruleOnly.effectiveQuery.includes("已核实本单券数"));

  const legacyQuestion = `订单 ${orderId} 现在能提出退款申请吗？`;
  const oldInput = input(legacyQuestion), base = consultation(legacyQuestion);
  const expectedV2 = base + "\n已核实订单状态：paid；状态对应条件：未核销退款。"
    + "\n已核实本单券数：共1张，未核销1张、已核销0张、已过期0张、已退款0张（按券状态字段计数）。"
    + `\n有效期事实（截至${asOf}）：未核销券：日期已过期0张、未到期1张、截止时间未知0张。`;
  for (const old of [buildSupportEvidenceBinding(oldInput), buildSupportEvidenceBinding({ ...oldInput, version: evidenceBindingVersion })]) {
    assert.equal(old.evidenceBindingVersion, evidenceBindingVersion); assert.equal(old.effectiveQuery, expectedV2);
    assert.equal(old.retrievalQuery, base + "\n订单状态对应的规则条件：未核销退款。");
  }
  for (const kind of ["merchant_prepare", "refund_prepare"] as const) {
    const prerequisite = buildSupportEvidenceBinding({ ...oldInput, version: evidenceBindingV3Version,
      action: { protocol: "v2.2", kind, orderRef: { kind: "explicit", orderId }, ...(kind === "merchant_prepare" ? { reason: "行程变化" } : {}) } as ContextSupportAction });
    const prerequisiteQuery = `未核销退款\n已核实订单商品：${productName}。`;
    assert.equal(prerequisite.evidenceBindingVersion, evidenceBindingV3Version);
    assert.equal(prerequisite.retrievalQuery, prerequisiteQuery);
    assert.equal(prerequisite.effectiveQuery, prerequisiteQuery + expectedV2.slice(base.length));
    assert.equal(prerequisite.purpose, "business_prerequisite"); assert.equal(prerequisite.evidenceTarget.basisSource, "business_prerequisite");
    assert.equal(prerequisite.applicability!.purpose, "business_prerequisite");
  }
  assert.deepEqual(evidenceBindingVersions, ["order-evidence-binding-v2", "order-evidence-binding-v3"]);
  for (const invalid of [undefined, null, "", "v3", "order-evidence-binding-v4", false, 3, {}]) {
    assert.throws(() => buildSupportEvidenceBinding({ ...oldInput, version: invalid } as unknown as Input), SupportProtocolError);
  }

  // Both alternative candidates come from successful owned reads. A refund
  // topic on the old focus cannot turn a complete new consultation into refunds.
  const otherId = "COUPON-9702", oldRefunded = freshOrder(states[3]), other = structuredClone(order);
  other.id = otherId; other.items[0] = { ...other.items[0]!, id: "query-other-item", productId: "query-dinner", productName: "合成单人晚餐券" };
  other.coupons[0] = { ...other.coupons[0]!, id: "query-other-coupon", orderItemId: "query-other-item" };
  const alternativeReads: string[] = [], alternativeQueries: string[] = [], parserInputs: SupportQuestionResolutionInput[] = [];
  const cross = new SupportController({ questionContract: "v3", questionResolver: { async resolve(value) {
    assert.equal(value.previousTopic, null, "A different order must not carry the old refund topic into the parser");
    parserInputs.push(structuredClone(value));
    return { version: supportQuestionResolutionVersion, inputHash: supportQuestionResolutionInputHash(value),
      decision: "current_complete", currentQuotes: [value.originalQuery], previousRequestId: null };
  } }, store: {
    async getOrder(who, id) { assert.deepEqual(who, identity); assert.ok(id === orderId || id === otherId);
      alternativeReads.push(id); return structuredClone(id === orderId ? oldRefunded : other); },
    async searchKnowledge(query, shopId, productId) { alternativeQueries.push(query);
      assert.equal(shopId, order.shop.id);
      return [{ source: "demo-knowledge", sourceId: productId === "query-dinner" ? "QUERY-CURRENT-RULE" : "QUERY-REFUND-RULE",
        title: "合成隔离资料", body: productId === "query-dinner"
          ? "【合成工程规则】每张单人晚餐券对应一位；无特殊活动且非法定假日的普通周日可按商品说明使用，到店前需自行确认接待。"
          : "【合成工程规则】已退款订单不得重复退款；说明既有退款记录不表示本轮执行。",
        scope: { shopId: shopId ?? null, productId: productId ?? null } }]; },
  } });
  const turnContext = (requestId: string, userText: string, extra: Partial<SupportTurnContext> = {}): SupportTurnContext => ({
    identity, sourceKey, requestId, userText, trustedRoute: { groupOpenid, messageId: requestId }, ...extra });
  const lookedUp = await cross.createTurn(turnContext("query-shown-other", `订单 ${otherId} 的本人订单记录请先查一下。`))
    .execute({ protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: otherId } });
  const refundQuestion = `订单 ${orderId}：款项已退回时，是否还能重复申请退款？这里只说明已有规则。`;
  const refundDonor = await cross.createTurn(turnContext("query-refund-donor", refundQuestion)).execute(action("refund_eligibility", { question: refundQuestion }));
  assert.deepEqual(alternativeReads, [otherId, orderId]); assert.equal(alternativeQueries.length, 1);
  const refundTopic = refundDonor.verifiedPolicyTopic!; assert.ok(refundTopic); assert.equal(refundTopic.intent, "refund_eligibility");
  assert.equal(refundTopic.originalQuery, refundQuestion); assert.equal(refundTopic.sources[0]!.sourceId, "QUERY-REFUND-RULE");
  assert.equal(lookedUp.verifiedOrderId, otherId); assert.equal(refundDonor.verifiedOrderId, orderId);
  const orderBinding = { sourceKey, groupOpenid };
  const choices = rememberOrderChoice(rememberOrderChoice(undefined, orderBinding, lookedUp.verifiedOrderId!, lookedUp.evidence.requestId),
    orderBinding, refundDonor.verifiedOrderId!, refundDonor.evidence.requestId);
  const previousContext = { focusOrderId: orderId, orderChoices: choices, policyTopic: refundTopic };
  alternativeReads.length = alternativeQueries.length = parserInputs.length = 0;
  const newPeopleQuestion = "另一笔订单的这张券每张对应几位用餐者？请查当前商品人数，不沿用前单咨询。";
  const blocked = await cross.createTurn(turnContext("query-alternative-previous", newPeopleQuestion, previousContext))
    .execute(action("refund_eligibility", { question: newPeopleQuestion, orderRef: { kind: "alternative" }, questionContext: { kind: "previous", requestId: refundTopic.requestId } }));
  assert.equal(blocked.outcome, "clarification"); assert.equal(blocked.discardPolicyTopic, true);
  assert.equal(blocked.pendingReferenceKind, "policy"); assert.equal(blocked.referencePresentation, undefined);
  assert.equal(blocked.needsAnswer, false); assert.equal(blocked.verifiedPolicyTopic, undefined);
  assert.deepEqual(blocked.evidence.policyChoices!.candidates, []); assert.deepEqual(blocked.evidence.rules, []);
  assert.deepEqual(blocked.evidence.actualCalls.map(call => call.name), ["get_order"]);
  assert.deepEqual(alternativeReads, [otherId]); assert.equal(alternativeQueries.length, 0); assert.equal(parserInputs.length, 1);
  assert.deepEqual(blocked.evidence.questionResolution!.input, parserInputs[0]);
  assert.equal(parserInputs[0]!.originalQuery, newPeopleQuestion); assert.equal(parserInputs[0]!.previousTopic, null);
  assert.equal(blocked.reply.kind, "notice"); assert.match(blocked.reply.text, /完整重述当前对象、条件和要确认的内容/);
  assert.ok(!blocked.reply.text.includes(refundQuestion) && !blocked.reply.text.includes("选择话题"));
  for (const [index, question] of [newPeopleQuestion,
    "另一笔订单的商品在非法定假日、没有特别活动的普通周日能用吗？只查使用规则，我会自行确认接待。"].entries()) {
    alternativeReads.length = alternativeQueries.length = parserInputs.length = 0;
    const current = await cross.createTurn(turnContext(`query-alternative-current-${index}`, question, previousContext))
      .execute(action("policy", { question, orderRef: { kind: "alternative" } }));
    assert.equal(current.outcome, "ready"); assert.deepEqual(alternativeReads, [otherId]); assert.equal(alternativeQueries.length, 1);
    assert.deepEqual(current.evidence.actualCalls.map(call => call.name), ["get_order", "search_faq"]);
    assert.equal(current.verifiedOrderId, otherId); assert.equal(current.evidence.order!.id, otherId); assert.equal(parserInputs.length, 1);
    assert.equal(parserInputs[0]!.previousTopic, null); assert.equal(parserInputs[0]!.originalQuery, question);
    const knowledge = current.evidence.knowledge[0]!.context, expected = `${question}\n已核实订单商品：合成单人晚餐券。`;
    assert.equal(knowledge.originalQuery, question); assert.equal(knowledge.evidenceBindingVersion, evidenceBindingV3Version);
    assert.equal(knowledge.retrievalQuery, expected); assert.equal(knowledge.effectiveQuery, expected + neutralFacts(states[0]));
    assert.equal(alternativeQueries[0], knowledge.effectiveQuery); assert.equal(knowledge.policyTopic, null);
    assert.deepEqual(current.verifiedPolicyTopic!.priorQueries, []); assert.deepEqual(current.evidence.rules.map(rule => rule.sourceId), ["QUERY-CURRENT-RULE"]);
    assert.ok(!knowledge.retrievalQuery.includes("退款") && !knowledge.effectiveQuery.includes("本轮继续咨询新选定订单的退款申请资格与条件"));
    assert.ok(!knowledge.effectiveQuery.includes(refundQuestion.replaceAll(`订单 ${orderId}`, "该订单")));
  }
  // Binding preserves provenance but deliberately does not classify whether a
  // natural-language question is complete. The v3 Controller parser owns that gate.
  console.log(`[support-question-query] ${checked} v3 read-only projections across 5 fresh states; independent exact queries/facts, real donor, explicit refund, explanation/prerequisite and fixed v2 vector; 2 owned-order alternative groups (previous rejected/FAQ0, 2 standalone variants each fresh1/FAQ1) PASS; 0 remote/DB/QQ, no semantic-completeness claim.`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportQuestionQuery();
