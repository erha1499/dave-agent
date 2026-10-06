import type { CouponStore } from "./coupon-store.ts";
import { buildKnowledgeApplicabilityContext, type KnowledgeApplicabilityContext } from "./knowledge-applicability.ts";
import { SupportProtocolError } from "./support-action.ts";
import type { ContextSupportAction } from "./support-context-action.ts";
import type { TrustedPolicyTopic } from "./support-controller.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
export const evidenceBindingVersion = "order-evidence-binding-v2" as const;
export const evidenceBindingV3Version = "order-evidence-binding-v3" as const;
export const evidenceBindingVersions = [evidenceBindingVersion, evidenceBindingV3Version] as const;
export type EvidenceBindingVersion = typeof evidenceBindingVersions[number];
export class SupportEvidenceFactsError extends Error {
  constructor(message: string) { super(message); this.name = "SupportEvidenceFactsError"; }
}
export type SupportEvidenceTarget = {
  kind: "current_order" | "rule_only"; basis: string | null;
  basisSource: "default" | "current_message" | "previous_policy_topic" | "business_prerequisite";
  basisRequestId: string | null;
};
export type SupportOrderFacts = {
  orderId: string; asOf: string; status: string; productId: string; productName: string; refundState: string;
  couponCounts: { total: number; unused: number; redeemed: number; expired: number; refunded: number };
  couponDates: Array<{ couponId: string; status: string; expiresAt: string | null; expiredAtAsOf: boolean | null }>;
};
type TargetInput = {
  action: ContextSupportAction; originalQuery: string; verifiedTopic?: TrustedPolicyTopic | null;
  binding: { sourceKey: string; groupOpenid: string; orderId: string | null };
};

// Keep a bounded chain of actual user questions, never model summaries. Missing
// priorQueries is the historical one-question contract.
export function policyTopicQueries(topic: TrustedPolicyTopic): Array<{ requestId: string; originalQuery: string }> | undefined {
  if (topic.priorQueries !== undefined && (!Array.isArray(topic.priorQueries) || topic.priorQueries.length > 4)) return undefined;
  const queries = [...(topic.priorQueries ?? []), { requestId: topic.requestId, originalQuery: topic.originalQuery }];
  if (queries.some(row => !row || typeof row.requestId !== "string" || !row.requestId || row.requestId.length > 512
    || typeof row.originalQuery !== "string" || !row.originalQuery.trim())
    || new Set(queries.map(row => row.requestId)).size !== queries.length
    || queries.reduce((sum, row) => sum + row.originalQuery.length, 0) > 500) return undefined;
  return queries.map(row => ({ requestId: row.requestId, originalQuery: row.originalQuery }));
}

export function policyTopicQueryContext(topic: TrustedPolicyTopic): string {
  const queries = policyTopicQueries(topic);
  if (!queries) throw new SupportProtocolError("前序问题链不完整或超过恢复预算，请完整重述当前问题。");
  return `上轮已完成取证的问题（仅用于理解本轮指代）：${topic.originalQuery}`
    + (queries.length > 1 ? `\n更早的已取证原问（按先后顺序，仅用于理解本轮指代）：${queries.slice(0, -1).map(row => row.originalQuery).join("\n")}` : "");
}

// Source checks establish provenance, not arbitrary natural-language meaning.
// The read-only explanation channel cannot authorize a later business operation.
export function validateSupportEvidenceTarget(input: TargetInput): SupportEvidenceTarget {
  const { action, originalQuery, verifiedTopic: topic, binding } = input;
  if (action.kind === "merchant_prepare" || action.kind === "refund_prepare") {
    return { kind: "current_order", basis: null, basisSource: "business_prerequisite", basisRequestId: null };
  }
  if (action.kind !== "policy" && action.kind !== "refund_eligibility") throw new SupportProtocolError("此动作不支持知识证据用途。");
  if (!action.evidenceTarget) return { kind: binding.orderId ? "current_order" : "rule_only", basis: null, basisSource: "default", basisRequestId: null };
  if (action.evidenceTarget.kind === "current_order") {
    if (!binding.orderId) throw new SupportProtocolError("当前订单取证需要已定位的订单，请先明确订单对象。");
    return { kind: "current_order", basis: null, basisSource: "current_message", basisRequestId: null };
  }
  const basis = action.evidenceTarget.basis;
  if (!basis.trim() || basis.length > 500) throw new SupportProtocolError("规则解释必须引用本轮问题或可信前序中的明确条件。");
  if (originalQuery.includes(basis)) return { kind: "rule_only", basis, basisSource: "current_message", basisRequestId: null };
  if (action.questionContext.kind === "previous" && action.orderRef?.kind !== "alternative" && topic
    && topic.requestId === action.questionContext.requestId && topic.sourceKey === binding.sourceKey
    && topic.groupOpenid === binding.groupOpenid && topic.orderId === binding.orderId
    && policyTopicQueries(topic)?.some(row => row.originalQuery.includes(basis))
    && topic.sources.length > 0 && topic.sources.length <= 5
    && new Set(topic.sources.map(source => source.sourceId)).size === topic.sources.length
    && topic.sources.every(source => source.sourceId && /^[a-f0-9]{64}$/.test(source.version))) {
    return { kind: "rule_only", basis, basisSource: "previous_policy_topic",
      basisRequestId: policyTopicQueries(topic)!.findLast(row => row.originalQuery.includes(basis))!.requestId };
  }
  throw new SupportProtocolError("规则解释依据不在当前原文或匹配的可信前序中；不能补造条件或搬用另一订单的假设。");
}

export function orderRefundState(order: Order): string {
  if (order.status === "pending_payment") return "未支付退款";
  if (order.status === "closed") return "已关闭订单退款";
  if (order.status === "refunded" || order.amounts.refundedCents > 0) return "已退款重复退款";
  if (order.status === "partially_redeemed") return "部分核销剩余退款";
  if (order.status === "redeemed" || order.coupons.some(coupon => coupon.status === "redeemed")) return "已核销退款";
  if (order.coupons.some(coupon => coupon.status === "expired"
    || (coupon.expiresAt !== null && Date.parse(coupon.expiresAt) <= Date.parse(order.asOf)))) return "过期退款";
  return order.status === "paid" && order.coupons.length > 0 && order.coupons.every(coupon => coupon.status === "unused")
    ? "未核销退款" : "券状态待核实的退款条件";
}

export function buildSupportEvidenceBinding(input: TargetInput & { order?: Order; requestId: string; version?: EvidenceBindingVersion }) {
  const { action, order, verifiedTopic: topic } = input;
  const version = Object.hasOwn(input, "version") ? input.version : evidenceBindingVersion;
  if (version !== evidenceBindingVersion && version !== evidenceBindingV3Version) throw new SupportProtocolError("知识证据绑定版本无效。");
  const target = validateSupportEvidenceTarget(input);
  const prerequisite = action.kind === "merchant_prepare" || action.kind === "refund_prepare";
  if (target.kind === "current_order" && !order) throw new SupportProtocolError("当前订单取证缺少本轮已授权事实。");
  if ((order?.id ?? null) !== input.binding.orderId) throw new SupportProtocolError("知识取证对象与本轮授权订单不一致。");
  const purpose = prerequisite ? "business_prerequisite" as const : target.kind === "current_order" ? "current_order" as const : "user_policy" as const;
  let facts: SupportOrderFacts | null = null, applicability: KnowledgeApplicabilityContext | undefined;
  if (order) {
    const fresh = buildKnowledgeApplicabilityContext({ order, requestId: input.requestId, purpose: prerequisite ? "business_prerequisite" : "current_order" });
    if (!fresh.facts || fresh.unknownReason) throw new SupportEvidenceFactsError("订单与券记录不完整，暂时无法可靠核对规则条件。请联系测试管理员核实订单数据后重试；本轮未生成或提交退款。");
    const couponDates = order.coupons.map(coupon => {
      if (coupon.expiresAt !== null && (!Number.isFinite(Date.parse(coupon.expiresAt)) || new Date(coupon.expiresAt).toISOString() !== coupon.expiresAt)) {
        throw new SupportEvidenceFactsError("券有效期数据无效，暂时无法判断日期条件。请联系测试管理员核实有效期后重试；本轮未生成或提交退款。");
      }
      return { couponId: coupon.id, status: coupon.status, expiresAt: coupon.expiresAt,
        expiredAtAsOf: coupon.expiresAt === null ? null : Date.parse(coupon.expiresAt) <= Date.parse(order.asOf) };
    });
    facts = { orderId: order.id, asOf: order.asOf, status: order.status, productId: order.items[0]!.productId,
      productName: order.items[0]!.productName, refundState: orderRefundState(order),
      couponCounts: { total: fresh.facts.couponCount, ...fresh.facts.couponStates }, couponDates };
    if (target.kind === "current_order") applicability = fresh;
  }
  let query = input.originalQuery.trim();
  if ((action.kind === "policy" || action.kind === "refund_eligibility") && action.questionContext.kind === "previous") {
    if (!topic || topic.requestId !== action.questionContext.requestId || topic.sourceKey !== input.binding.sourceKey
      || topic.groupOpenid !== input.binding.groupOpenid || !policyTopicQueries(topic)) throw new SupportProtocolError("知识续问缺少真实匹配的前序话题。");
    if (action.orderRef?.kind === "alternative") {
      if (action.kind !== "refund_eligibility" || topic.intent !== "refund_eligibility") throw new SupportProtocolError("跨单续问只能延续明确退款意图。");
      query += "\n本轮继续咨询新选定订单的退款申请资格与条件。";
    } else {
      if (topic.orderId !== input.binding.orderId) throw new SupportProtocolError("前序政策话题属于另一订单。");
      query += `\n${policyTopicQueryContext(topic)}`;
    }
  }
  if (prerequisite) query = orderRefundState(order!);
  if (order) query += `\n已核实订单商品：${order.items[0]!.productName}。`;
  // v2 retains its historical lifecycle hint. v3 read-only ranking carries only
  // the real question/object; neutral evidence facts do not create a new intent.
  let retrievalQuery = query;
  if (target.kind === "current_order") {
    const neutral = version === evidenceBindingV3Version && !prerequisite;
    if (!prerequisite && !neutral) retrievalQuery += `\n订单状态对应的规则条件：${facts!.refundState}。`;
    const counts = facts!.couponCounts, dates = facts!.couponDates;
    const dateGroups = (["unused", "redeemed", "expired", "refunded"] as const).flatMap((status, index) => {
      const rows = dates.filter(row => row.status === status);
      return rows.length ? [`${["未核销", "已核销", "已过期", "已退款"][index]}券：日期已过期${rows.filter(row => row.expiredAtAsOf === true).length}张、未到期${rows.filter(row => row.expiredAtAsOf === false).length}张、截止时间未知${rows.filter(row => row.expiredAtAsOf === null).length}张`] : [];
    });
    query += (neutral ? `\n已核实订单状态：${facts!.status}。` : `\n已核实订单状态：${facts!.status}；状态对应条件：${facts!.refundState}。`)
      + `\n已核实本单券数：共${counts.total}张，未核销${counts.unused}张、已核销${counts.redeemed}张、已过期${counts.expired}张、已退款${counts.refunded}张（按券状态字段计数）。`
      + `\n有效期事实（截至${facts!.asOf}）：${dateGroups.join("；")}。`;
    if (neutral) query += "\n以上订单事实仅用于判断上述咨询的适用条件，不构成新的咨询问题。";
  } else {
    query += `\n仅解释所问规则条件${target.basis ? `（原文依据：${target.basis}）` : ""}，不证明当前订单已满足，也不构成退款批准。`;
    retrievalQuery = query;
  }
  const normalizeLocator = (text: string) => order ? text.replaceAll(`订单 ${order.id}`, "该订单").replaceAll(`订单${order.id}`, "该订单").replaceAll(order.id, "该订单") : text;
  return { evidenceBindingVersion: version, evidenceTarget: target, evidenceUse: target.kind === "current_order" ? "current_order" as const : "explanation" as const,
    purpose, facts, ...(applicability ? { applicability } : {}), effectiveQuery: normalizeLocator(query), retrievalQuery: normalizeLocator(retrievalQuery) };
}
