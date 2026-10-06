import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MerchantBusinessError, merchantReasonControls, merchantSourceKey, type AfterSalesStore, type MerchantTask } from "./after-sales.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "./coupon-store.ts";
import type { KnowledgeService, KnowledgeTrace } from "./knowledge-service.ts";
import type { KnowledgeApplicabilityContext } from "./knowledge-applicability.ts";
import { buildSupportEvidenceBinding, validateSupportEvidenceTarget, policyTopicQueries, policyTopicQueryContext, SupportEvidenceFactsError, orderRefundState as refundQuery,
  evidenceBindingV3Version, type EvidenceBindingVersion, type SupportEvidenceTarget, type SupportOrderFacts } from "./support-evidence-context.ts";
import { buildSupportQuestionResolutionInput, requireSupportQuestionResolution, supportQuestionResolutionInputHash,
  type SupportQuestionResolver, type SupportQuestionResolutionInput, type SupportQuestionResolution } from "./support-question-resolution.ts";
import type { SupportQuestionTrace, SupportQuestionObservation } from "./support-question-resolution.ts";
import { RefundBusinessError, type RefundStore } from "./refunds.ts";
import { isRefundOperation, type Reply } from "./reply.ts";
import { SupportProtocolError } from "./support-action.ts";
import { isContextSupportAction, parseAnySupportAction, type AnySupportAction, type ContextOrderRef, type ContextClarificationField } from "./support-context-action.ts";
export { parseAnySupportAction as parseExecutedSupportAction } from "./support-context-action.ts";
import { amountChoiceNotice, compareRemainingAmount, createAmountReference, resolveAmountReference, selectAlternativeOrder, supportObjectReference,
  type RemainingAmountComparison, type TrustedAmountReference, type TrustedAmountChoices, type TrustedOrderChoices } from "./support-context.ts";
export type { RemainingAmountComparison, TrustedAmountReference, TrustedAmountChoices, TrustedOrderChoices } from "./support-context.ts";
import { currentReferenceChoices, emptyReferenceChoices, referenceChoiceNotice, resolveReferenceChoice, type TrustedReferenceChoices } from "./support-reference-selection.ts";
import { currentTaskChoices, resolveTaskReference, taskChoiceNotice, type TrustedTaskChoices } from "./support-task-context.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Knowledge = Awaited<ReturnType<CouponStore["searchKnowledge"]>>;
type CallName = "get_order" | "search_faq" | "prepare_merchant_request" | "get_merchant_request" | "prepare_refund" | "get_refund";
export type SupportCall = {
  id: string; parentSpanId: string; actor: "host"; trigger: "user"; component: "support-controller";
  name: CallName; input: Record<string, unknown>; output?: unknown;
  observedAt: string; durationMs: number; isError: boolean;
  errorKind?: "business_denial" | "service_error";
  knowledge?: { context: SupportKnowledgeContext; trace: KnowledgeTrace };
};
export type SupportKnowledgeContext = {
  originalQuery: string; modelQuestion: string | null; effectiveQuery: string; retrievalQuery?: string;
  purpose: "user_policy" | "refund_eligibility" | "business_prerequisite" | "current_order";
  orderSource: "current_explicit" | "verified_focus" | "verified_alternative" | "none";
  scopeSource: "fresh_order" | "global";
  facts: { orderId: string; asOf: string; status: string; productId: string; productName: string; refundState: string;
    // Absent in legacy replay. Counts are the fresh coupon status fields, not inferred lifecycle transitions.
    couponCounts?: { total: number; unused: number; redeemed: number; expired: number; refunded: number };
    couponDates?: SupportOrderFacts["couponDates"] } | null;
  policyTopic: TrustedPolicyTopic | null;
  objectReference: { kind: "remaining_amount" | "alternative_order"; sourceRequestIds: string[]; fromOrderId: string; toOrderId: string } | null;
  protocol?: "v2.2";
  evidenceBindingVersion?: EvidenceBindingVersion;
  evidenceTarget?: SupportEvidenceTarget;
  evidenceUse?: "current_order" | "explanation";
  // Built from this turn's authorized order, never from user/model-supplied counts.
  applicability?: KnowledgeApplicabilityContext;
};
export type TrustedPolicyTopic = {
  requestId: string; sourceKey: string; groupOpenid: string; originalQuery: string; orderId: string | null;
  scope: { shopId: string | null; productId: string | null };
  sources: Array<{ sourceId: string; version: string }>;
  intent?: "policy" | "refund_eligibility";
  priorQueries?: Array<{ requestId: string; originalQuery: string }>;
};
export type SupportPolicyScopeRepair = {
  version: "policy-scope-repair-v1"; reason: "scope_changed";
  action: AnySupportAction; topic: TrustedPolicyTopic; call: SupportCall;
  budget?: { limit: number; usedBefore: number; usedAfter: number; toolCallId: string };
  questionResolution?: { input: SupportQuestionResolutionInput; value: SupportQuestionResolution };
  questionTrace?: SupportQuestionTrace;
};
function freezePolicyScopeRepair(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const member of Object.values(value)) freezePolicyScopeRepair(member, seen);
  Object.freeze(value);
}
export class SupportPolicyScopeRepairError extends SupportProtocolError {
  readonly repair: SupportPolicyScopeRepair;
  constructor(repair: SupportPolicyScopeRepair) {
    const audit = structuredClone(repair);
    freezePolicyScopeRepair(audit);
    const { questionTrace: _questionTrace, ...modelAudit } = audit;
    super(JSON.stringify({ code: "POLICY_SCOPE_CHANGED", repair: modelAudit,
      instruction: "前序话题的商品范围与本轮订单不同；本轮尚未检索规则或办理业务。若当前原问完整，请重新选择同订单的 policy、standalone 和 current_order；否则明确 clarify policy_topic。不能沿用 previous、旧商品事实或假设。" }));
    this.name = "SupportPolicyScopeRepairError";
    this.repair = audit;
  }
}

// Legacy v2.1 replay only. Current v2.2 sessions select bounded references in the
// action; these language heuristics must not route a current action.
export function hasAmbiguousOrderReference(text: string) {
  const ids = [...new Set(text.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
  return ids.length > 1 || ids.length === 0
    && /(?:另(?:一|外)|其他|其余|剩下|剩余)[^，。？！\n]{0,4}(?:张|个|笔|份|单|券|订单|套餐|商品)|(?:换|改|切换)(?:成|到|为)?(?:一|另)?(?:个|张|笔|份|家)(?:订单|套餐|商品|券|店|门店)/u.test(text);
}
const needsPolicyTopic = (text: string) => /[这那](?:个|段|笔)?(?:时间|期限|金额|价格)|[这那]样|(?:问|让|经|要|得)[^，。？！\n]{0,3}(?:他|她)(?:们)?|(?:他|她)(?:们)?(?:同意|批准)/u.test(text);
// Remove only grammatical/lifecycle qualifiers. Unknown product words must still match fresh facts.
// These user-supplied qualifiers never establish status or refund eligibility.
const referenceQualifiers = /(?:已经|刚刚|目前|现在|之前|上次|今天|昨天|仍然|尚|还|刚|已|未|没有|没|不曾)?(?:核销|使用|用|消费|过期|到期|付款|支付|退(?:款|过款?|了款?|回)|购买|买|下单)(?:过|了)?|我们|我|但是|而且|并且|但|且|又|还|的/gu;
const productReferences = (text: string) => [...text.matchAll(/(?:(?:这|那)(?:一)?(?:张|个|份|款|笔)|该|本)([^，。？！!?;；\n]*?)(?:团购券|优惠券|套餐|商品|券)/gu)]
  .map(match => match[1]!.normalize("NFKC").replace(/\s+/gu, "").replace(referenceQualifiers, ""));
const needsOrderScope = (text: string) => productReferences(text).length > 0
  || /(?:这|那|该|本)(?:一)?(?:个|份|款|张)?(?:套餐|商品|券|订单|门店)|(?:这个|那个|它)(?:还|能|可以|没|未)|套餐|这家店|你们店/u.test(text);
const multiplePolicyQuestions = (text: string) => /[?？][^?？]*[?？]|(?:另外|同时|顺便|并且)(?:再)?(?:问|查询|查|看看|确认|了解)/u.test(text);
export function resolveSupportPolicyQuestion(input: {
  originalQuery: string; sourceKey: string; groupOpenid: string; orderId: string | null; policyTopic?: TrustedPolicyTopic;
}): { query: string; topic: TrustedPolicyTopic | null; needsClarification: boolean } {
  if (hasAmbiguousOrderReference(input.originalQuery)) return { query: input.originalQuery, topic: null, needsClarification: true };
  if (!needsPolicyTopic(input.originalQuery)) return { query: input.originalQuery, topic: null, needsClarification: false };
  const topic = input.policyTopic;
  if (!policyTopicMatches(topic, input)) return { query: input.originalQuery, topic: null, needsClarification: true };
  return { query: `${input.originalQuery}\n上轮已完成取证的问题（仅用于理解本轮指代）：${topic!.originalQuery}`, topic: structuredClone(topic!), needsClarification: false };
}
export function policyTopicMatches(topic: TrustedPolicyTopic | undefined, input: { sourceKey: string; groupOpenid: string; orderId: string | null }): boolean {
  return Boolean(topic && topic.sourceKey === input.sourceKey && topic.groupOpenid === input.groupOpenid && topic.orderId === input.orderId
    && policyTopicQueries(topic)
    && Array.isArray(topic.sources) && topic.sources.length > 0 && topic.sources.length <= 5
    && new Set(topic.sources.map(source => source.sourceId)).size === topic.sources.length
    && topic.sources.every(source => source.sourceId && /^[a-f0-9]{64}$/.test(source.version)));
}
export class SupportServiceError extends Error {
  readonly errorKind: NonNullable<SupportCall["errorKind"]>;
  constructor(name: CallName, errorKind: NonNullable<SupportCall["errorKind"]>) {
    super(errorKind === "business_denial" ? `业务服务 ${name} 校验未通过，请核对本人订单及当前业务条件。`
      : `业务服务 ${name} 未成功，当前状态无法确认；请稍后查询。`);
    this.name = "SupportServiceError";
    this.errorKind = errorKind;
  }
}
export type SupportTurnContext = {
  requestId: string; identity: QQIdentity; sourceKey: string;
  trustedRoute: { groupOpenid: string; messageId: string };
  userText: string; focusOrderId?: string; policyTopic?: TrustedPolicyTopic; signal?: AbortSignal;
  orderChoices?: TrustedOrderChoices; amountReference?: TrustedAmountReference; amountChoices?: TrustedAmountChoices;
  policyChoices?: TrustedReferenceChoices; orderReferenceChoices?: TrustedReferenceChoices;
  taskChoices?: TrustedTaskChoices;
  pendingReferenceKind?: "order" | "policy";
  allowPolicyScopeRepair?: boolean;
  onCall?: (call: SupportCall) => void;
  onQuestionTrace?: (observation: SupportQuestionObservation) => void;
};
export type EvidenceBundle = {
  version: 1; requestId: string; trustedRoute: SupportTurnContext["trustedRoute"];
  action: AnySupportAction; actualCalls: SupportCall[];
  policyScopeRepair?: SupportPolicyScopeRepair;
  questionResolution?: { input: SupportQuestionResolutionInput; value: SupportQuestionResolution };
  questionTrace?: SupportQuestionTrace;
  traceDeliveryFailed?: boolean;
  order?: Order; rules: Array<Knowledge[number] & { version: string }>;
  knowledge: Array<{ callId: string; context: SupportKnowledgeContext; trace: KnowledgeTrace }>;
  amountComparison?: RemainingAmountComparison;
  displayedPaidUnit?: TrustedAmountReference;
  amountChoices?: TrustedAmountChoices;
  policyChoices?: TrustedReferenceChoices; orderReferenceChoices?: TrustedReferenceChoices;
  taskChoices?: TrustedTaskChoices;
  task?: MerchantTask | null;
  operation?: Awaited<ReturnType<RefundStore["get"]>> | null;
};
export type SupportResult = {
  action: AnySupportAction; outcome: "ready" | "clarification" | "blocked" | "non_business";
  reply: Reply; evidence: EvidenceBundle; needsAnswer: boolean;
  // Explicit selection or a unique trusted alternative changes focus only after fresh getOrder authorization.
  verifiedOrderId?: string;
  verifiedPolicyTopic?: TrustedPolicyTopic;
  verifiedAmountReference?: TrustedAmountReference;
  pendingReferenceKind?: "order" | "policy";
  referencePresentation?: "order" | "policy" | "task";
  discardPolicyTopic?: true;
};
export type SupportServices = {
  store: Pick<CouponStore, "getOrder" | "searchKnowledge">;
  merchant?: Pick<AfterSalesStore, "prepare" | "getTask">;
  refunds?: Pick<RefundStore, "prepare" | "get">;
  knowledge?: KnowledgeService;
  questionContract?: "v2" | "v3";
  questionResolver?: SupportQuestionResolver;
};

const notice = (text: string): Reply => ({ kind: "notice", text });
function orderReply(order: Order, ids: string[], text: string): Reply {
  return { kind: "order", text, orders: [{ id: order.id, status: order.status,
    paidCents: order.amounts.paidCents, refundedCents: order.amounts.refundedCents,
    couponStatuses: order.coupons.map(coupon => coupon.status) }], evidenceIds: ids };
}
function selectedPolicyTopic(context: SupportTurnContext): TrustedPolicyTopic | undefined {
  if (!context.policyChoices) return context.policyTopic;
  const reference = resolveReferenceChoice(context.policyChoices, { sourceKey: context.sourceKey, groupOpenid: context.trustedRoute.groupOpenid });
  return reference?.kind === "policy" ? reference.topic : undefined;
}
export class SupportController {
  private services: SupportServices;
  private readonly questionContract: "v2" | "v3";
  private readonly questionResolver?: SupportQuestionResolver;
  constructor(services: SupportServices) {
    if (services.questionContract !== undefined && !["v2", "v3"].includes(services.questionContract)) throw new Error("咨询合同仅支持v2或v3。");
    if (services.questionContract === "v3" && typeof services.questionResolver?.resolve !== "function") throw new Error("v3咨询合同必须提供独立解析端口，不能退回模型的standalone标签。");
    if (services.questionResolver && services.questionContract !== "v3") throw new Error("咨询解析端口仅用于显式v3合同。");
    this.services = services;
    this.questionContract = services.questionContract ?? "v2";
    this.questionResolver = services.questionResolver;
  }

  createTurn(context: SupportTurnContext) {
    if (!context.requestId || context.requestId.length > 512 || !context.userText.trim() || context.userText.length > 5000
      || !context.trustedRoute.messageId || context.trustedRoute.messageId.length > 512
      || context.sourceKey !== merchantSourceKey(context.identity, context.trustedRoute.groupOpenid)
      || context.allowPolicyScopeRepair !== undefined && typeof context.allowPolicyScopeRepair !== "boolean"
      || (context.focusOrderId !== undefined && !/^COUPON-\d{4}$/.test(context.focusOrderId))) {
      throw new SupportProtocolError("宿主业务上下文无效。");
    }
    const trusted = { ...context, identity: { ...context.identity }, trustedRoute: { ...context.trustedRoute },
      ...(context.policyTopic ? { policyTopic: structuredClone(context.policyTopic) } : {}),
      ...(context.orderChoices ? { orderChoices: structuredClone(context.orderChoices) } : {}),
      ...(context.policyChoices ? { policyChoices: structuredClone(context.policyChoices) } : {}),
      ...(context.orderReferenceChoices ? { orderReferenceChoices: structuredClone(context.orderReferenceChoices) } : {}),
      ...(context.taskChoices ? { taskChoices: structuredClone(context.taskChoices) } : {}),
      ...(context.amountChoices ? { amountChoices: structuredClone(context.amountChoices) } : {}),
      ...(context.amountReference ? { amountReference: structuredClone(context.amountReference) } : {}) };
    let accepted: AnySupportAction | undefined;
    let pending: Promise<SupportResult> | undefined;
    let sequence = 0;
    let policyScopeRepair: SupportPolicyScopeRepair | undefined;
    let questionTrace: SupportQuestionTrace | undefined;
    let questionTraceDeliveryFailed = false;
    let resolution: { hash: string; promise: Promise<{ input: SupportQuestionResolutionInput; value: SupportQuestionResolution }> } | undefined;
    const resolveQuestion = this.questionContract === "v3" ? async (topic: TrustedPolicyTopic | null) => {
      const input = buildSupportQuestionResolutionInput({ requestId: trusted.requestId, originalQuery: trusted.userText, previousTopic: topic });
      const hash = supportQuestionResolutionInputHash(input);
      if (resolution && resolution.hash !== hash) throw new SupportProtocolError("本轮咨询解析上下文已经固定，不能改用其他历史来源。");
      if (!resolution) resolution = { hash, promise: (async () => {
        trusted.signal?.throwIfAborted();
        const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(trusted.signal ? [trusted.signal] : [])]);
        let abort = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
        let value: SupportQuestionResolution;
        try { value = requireSupportQuestionResolution(await Promise.race([
          this.questionResolver!.resolve(structuredClone(input), { signal, onTrace: trace => {
            if (questionTrace) { questionTraceDeliveryFailed = true; return; }
            try {
              questionTrace = structuredClone(trace);
              trusted.onQuestionTrace?.({ requestId: trusted.requestId, observedAt: new Date().toISOString(),
                input: structuredClone(input), trace: structuredClone(trace) });
            } catch { questionTraceDeliveryFailed = true; }
          } }), cancelled,
        ]), input); }
        finally { signal.removeEventListener("abort", abort); }
        signal.throwIfAborted();
        trusted.signal?.throwIfAborted();
        if (this.questionResolver!.settings && (!questionTrace || questionTrace.inputHash !== hash
          || !isDeepStrictEqual(questionTrace.settings, this.questionResolver!.settings)
          || questionTrace.failure !== null || !isDeepStrictEqual(questionTrace.value, value))) {
          throw new SupportProtocolError("咨询解析请求缺少匹配的实际执行记录。");
        }
        return { input, value };
      })() };
      return structuredClone(await resolution.promise);
    } : undefined;
    const validate = (input: unknown): AnySupportAction => {
      const action = parseAnySupportAction(input);
      if (this.questionContract === "v3") {
        if (!isContextSupportAction(action)) throw new SupportProtocolError("v3咨询合同需要当前v2.2动作协议。");
        if ((action.kind === "policy" || action.kind === "refund_eligibility") && action.question !== trusted.userText.trim()) {
          throw new SupportProtocolError("question必须保留本轮用户原文（仅可去掉首尾空白），不能从历史或模型补写；这只是出处校验，不表示问题完整。");
        }
      }
      if (policyScopeRepair) {
        trusted.signal?.throwIfAborted();
        const original = policyScopeRepair.action;
        const standalone = isContextSupportAction(action) && action.kind === "policy"
          && action.questionContext.kind === "standalone" && action.orderRef?.kind === "explicit"
          && "orderRef" in original && original.orderRef?.kind === "explicit" && action.orderRef.orderId === original.orderRef.orderId
          && (!action.evidenceTarget || action.evidenceTarget.kind === "current_order");
        if (!standalone && !(isContextSupportAction(action) && action.kind === "clarify" && action.field === "policy_topic")) {
          throw new SupportProtocolError("范围修复只能重新查询同订单的完整当前问题（policy/standalone/current_order），或 clarify policy_topic；不能重复 previous、换单、改用途或办理业务。");
        }
      }
      // Pure preflight: invalid current-message references can be repaired before locking any action.
      if (action.kind === "clarify" || action.kind === "non_business"
        || !isContextSupportAction(action) && hasAmbiguousOrderReference(trusted.userText)) return action;
      const ids = [...new Set(trusted.userText.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
      if (action.kind === "merchant_status" && "taskRef" in action && action.taskRef && ids.length) {
        throw new SupportProtocolError("当前消息已写明订单，请使用该显式订单查询协商状态，不能忽略当前对象沿用历史任务。");
      }
      if (action.kind === "merchant_status" && "taskRef" in action) return action;
      if (action.orderRef?.kind === "explicit" && !ids.includes(action.orderRef.orderId)) {
        throw new SupportProtocolError("订单引用不在当前用户消息中；历史唯一订单应使用 focus，不能编造显式选单。");
      }
      if ((action.orderRef?.kind === "focus" || action.orderRef?.kind === "alternative") && ids.length) {
        throw new SupportProtocolError("当前用户已写明订单，请使用该显式订单引用，不能沿用旧焦点。");
      }
      if (action.kind === "policy" && !action.orderRef && ids.length) {
        throw new SupportProtocolError("当前问题涉及明确订单，请提供该订单引用以查询实际套餐范围。");
      }
      if (isContextSupportAction(action) && "productMention" in action && action.productMention
        && (action.productMention.trim() !== action.productMention || !trusted.userText.includes(action.productMention))) {
        throw new SupportProtocolError("商品描述必须摘取本轮用户原文的连续片段，不能补写或从历史话术生成。");
      }
      if (isContextSupportAction(action) && (action.kind === "policy" || action.kind === "refund_eligibility")) {
        const orderId = action.orderRef?.kind === "explicit" ? action.orderRef.orderId : action.orderRef?.kind === "alternative"
          ? selectAlternativeOrder(trusted.orderChoices, { sourceKey: trusted.sourceKey, groupOpenid: trusted.trustedRoute.groupOpenid }, trusted.focusOrderId)
          : action.orderRef ? trusted.focusOrderId : undefined;
        const topic = selectedPolicyTopic(trusted);
        const topicOrderId = action.orderRef?.kind === "alternative" ? trusted.focusOrderId ?? null : orderId ?? null;
        // An unresolved reference needs a user selection, not a model repair that
        // turns an otherwise valid old requestId into authority.
        if (action.questionContext.kind === "previous" && (!policyTopicMatches(topic, {
          sourceKey: trusted.sourceKey, groupOpenid: trusted.trustedRoute.groupOpenid, orderId: topicOrderId,
        }) || topic!.requestId !== action.questionContext.requestId)) return action;
        validateSupportEvidenceTarget({ action, originalQuery: trusted.userText, verifiedTopic: topic,
          binding: { sourceKey: trusted.sourceKey, groupOpenid: trusted.trustedRoute.groupOpenid, orderId: orderId ?? null } });
      }
      return action;
    };
    return {
      validate,
      execute: (input: unknown): Promise<SupportResult> => {
        const action = parseAnySupportAction(input);
        if (accepted) {
          if (!isDeepStrictEqual(action, accepted)) throw new SupportProtocolError("本轮已有业务动作，不能追加冲突动作；请在下一轮明确需求。");
          return pending!;
        }
        try { validate(action); } catch (error) { return Promise.reject(error); }
        accepted = structuredClone(action);
        // Cache the promise, including rejection: a model retry cannot re-run an uncertain mutation.
        pending = this.execute(trusted, accepted, { nextCallId: () => `${trusted.requestId}:${++sequence}`, policyScopeRepair, resolveQuestion,
          questionTrace: () => questionTrace, questionTraceDeliveryFailed: () => questionTraceDeliveryFailed }).catch(error => {
          // Only this completed, side-effect-free scope rejection can release
          // the lock. Service failures and cancellation remain terminal.
          if (error instanceof SupportPolicyScopeRepairError && !policyScopeRepair) {
            trusted.signal?.throwIfAborted();
            policyScopeRepair = structuredClone(error.repair);
            accepted = undefined;
            pending = undefined;
          }
          throw error;
        });
        return pending;
      },
    };
  }

  private async execute(context: SupportTurnContext, action: AnySupportAction,
    attempt: { nextCallId: () => string; policyScopeRepair?: SupportPolicyScopeRepair;
      questionTrace?: () => SupportQuestionTrace | undefined; questionTraceDeliveryFailed?: () => boolean;
      resolveQuestion?: (topic: TrustedPolicyTopic | null) => Promise<{ input: SupportQuestionResolutionInput; value: SupportQuestionResolution }> }): Promise<SupportResult> {
    const evidence: EvidenceBundle = { version: 1, requestId: context.requestId, trustedRoute: { ...context.trustedRoute }, action,
      actualCalls: attempt.policyScopeRepair ? [structuredClone(attempt.policyScopeRepair.call)] : [], rules: [], knowledge: [],
      ...(attempt.policyScopeRepair ? { policyScopeRepair: structuredClone(attempt.policyScopeRepair) } : {}) };
    if (attempt.policyScopeRepair?.questionResolution) evidence.questionResolution = structuredClone(attempt.policyScopeRepair.questionResolution);
    if (context.amountChoices) evidence.amountChoices = structuredClone(context.amountChoices);
    if (context.policyChoices) evidence.policyChoices = structuredClone(context.policyChoices);
    if (context.orderReferenceChoices) evidence.orderReferenceChoices = structuredClone(context.orderReferenceChoices);
    if (context.taskChoices) evidence.taskChoices = structuredClone(context.taskChoices);
    const binding = { sourceKey: context.sourceKey, groupOpenid: context.trustedRoute.groupOpenid };
    // A supplied candidate list is authoritative: the model cannot bypass its
    // ambiguity by naming any otherwise valid historical requestId.
    const amountReference = context.amountChoices ? resolveAmountReference(context.amountChoices, binding) : context.amountReference;
    const policyTopic = selectedPolicyTopic(context);
    let pendingReferenceKind = context.pendingReferenceKind;
    let referencePresentation: SupportResult["referencePresentation"];
    let discardPolicyTopic = false;
    let verifiedOrderId: string | undefined;
    let verifiedPolicyTopic: TrustedPolicyTopic | undefined;
    let verifiedAmountReference: TrustedAmountReference | undefined;
    const result = (reply: Reply, outcome: SupportResult["outcome"] = "ready", needsAnswer = false): SupportResult => {
      const trace = attempt.questionTrace?.();
      if (trace) evidence.questionTrace = structuredClone(trace);
      if (attempt.questionTraceDeliveryFailed?.()) evidence.traceDeliveryFailed = true;
      return { action, outcome, reply, evidence, needsAnswer, ...(verifiedOrderId ? { verifiedOrderId } : {}),
        ...(verifiedPolicyTopic ? { verifiedPolicyTopic } : {}), ...(verifiedAmountReference ? { verifiedAmountReference } : {}),
        ...(pendingReferenceKind ? { pendingReferenceKind } : {}), ...(referencePresentation ? { referencePresentation } : {}),
        ...(discardPolicyTopic ? { discardPolicyTopic: true as const } : {}) };
    };
    const emit = (step: SupportCall) => {
      // Telemetry is not part of the business transaction and cannot turn a completed prepare into a retry.
      try { context.onCall?.(structuredClone(step)); }
      catch { evidence.traceDeliveryFailed = true; }
    };
    const call = async <T>(name: CallName, input: Record<string, unknown>, operation: (step: SupportCall) => Promise<T>): Promise<T> => {
      context.signal?.throwIfAborted();
      const step: SupportCall = { id: attempt.nextCallId(), parentSpanId: context.requestId,
        actor: "host", trigger: "user", component: "support-controller", name, input: structuredClone(input),
        observedAt: new Date().toISOString(), durationMs: 0, isError: false };
      const started = performance.now();
      let value: T;
      try {
        value = await operation(step);
        step.output = structuredClone(value ?? null);
      } catch (error) {
        step.durationMs = performance.now() - started;
        step.isError = true;
        step.errorKind = error instanceof OrderAccessError || error instanceof MerchantBusinessError || error instanceof RefundBusinessError
          ? "business_denial" : "service_error";
        emit(step);
        throw new SupportServiceError(name, step.errorKind);
      }
      step.durationMs = performance.now() - started;
      evidence.actualCalls.push(step);
      emit(step);
      // The service may have completed after cancellation. Preserve its audit,
      // but do not publish a result or continue to the next business operation.
      context.signal?.throwIfAborted();
      return value;
    };
    const clarify = (field: ContextClarificationField) => {
      if (field === "task") {
        const current = currentTaskChoices(context.taskChoices, binding);
        if (current) evidence.taskChoices = { ...current, selected: undefined, selectionRequired: true };
        if (current?.candidates.length) referencePresentation = "task";
        return result(notice(taskChoiceNotice(evidence.taskChoices, binding)), "clarification");
      }
      const referenceKind = field === "order" ? "order" : ["policy_topic", "time_channel", "actor"].includes(field) ? "policy" : undefined;
      if (referenceKind && (pendingReferenceKind !== "order" || referenceKind === "order")) pendingReferenceKind = referenceKind;
      const choices = referenceKind === "order" ? context.orderReferenceChoices : context.policyChoices;
      const now = Date.now(), current = referenceKind ? currentReferenceChoices(choices, binding, now) : undefined;
      const candidates = referenceKind && current?.kind === referenceKind && current.candidates.length
        ? `\n${referenceChoiceNotice(referenceKind, choices, binding, now)}` : "";
      if (candidates) referencePresentation = referenceKind;
      return result(notice({
      order: "请明确本次要查询或操作的模拟订单号。",
      reason: "请说明希望联系商家协商的原因。",
      intent: "请明确本次先处理哪项需求：政策咨询、协商进度、退款申请或退款状态。若续问前文，请补充所指规则、时间或对象。",
      amount_basis: amountChoiceNotice(context.amountChoices, binding),
      policy_topic: "请补充你指的具体使用规则或上一次问题；如果有几种规则，请明确要继续问哪一种，我再按相应条件查询。",
      time_channel: "请说明支付渠道，以及你说的时间是退款审核期限还是到账时限；如果前面有几个时限，请明确指哪一个，并补充具体天数。",
      actor: "请说明是哪项操作，以及你说的“他/对方”指商家还是平台；我再核对该操作是否需要其许可。",
      }[field] + candidates), "clarification");
    };
    const restatePolicy = () => {
      pendingReferenceKind = "policy";
      return result(notice("前文问题链已超过本轮可可靠恢复的范围。请完整重述当前问题，写明具体对象、条件和要确认的内容；不能省略或截断旧条件后继续判断。"), "clarification");
    };
    const unresolvedQuestion = (unavailable = false) => {
      pendingReferenceKind = "policy";
      discardPolicyTopic = true;
      referencePresentation = undefined;
      // No stale choice is shown or reusable after this restatement request.
      evidence.policyChoices = emptyReferenceChoices("policy", binding);
      return result(notice((unavailable ? "本轮咨询问题暂时无法可靠解析。" : "本轮尚未明确完整的咨询问题。")
        + "请完整重述当前对象、条件和要确认的内容；旧话题不能补成当前商品的问题。本轮未检索规则或办理业务。"), "clarification");
    };
    if (action.kind === "clarify") {
      if (attempt.policyScopeRepair && action.field === "policy_topic") {
        if (attempt.resolveQuestion) return unresolvedQuestion();
        pendingReferenceKind = "policy";
        return result(notice("本订单的商品或门店范围已变化。请完整重述当前对象、条件和要确认的问题；旧话题不能直接沿用。"), "clarification");
      }
      return clarify(action.field);
    }
    if (action.kind === "non_business") return result(notice(action.reason === "greeting"
      ? "你好，我可以查询模拟团购券订单、说明套餐规则，以及办理模拟协商和退款。请告诉我你的问题。"
      : "当前仅支持模拟团购券咨询、订单查询、协商和退款，不支持这项请求。"), "non_business");

    // Task references are a separate read-only locator. They never select an
    // order focus, create policy/amount references, or authorize a write.
    if (action.kind === "merchant_status" && "taskRef" in action) {
      const reference = resolveTaskReference(context.taskChoices, binding);
      if (!reference || action.taskRef.kind !== "current" && reference.taskId !== action.taskRef.taskId) return clarify("task");
      if (!this.services.merchant) return result(notice("当前未启用模拟协商，暂时无法核实任务状态。"), "blocked");
      const stillCurrent = () => {
        const current = resolveTaskReference(context.taskChoices, binding);
        return current?.taskId === reference.taskId && current.orderId === reference.orderId;
      };
      try {
        evidence.order = await call("get_order", { orderId: reference.orderId }, async () => {
          const value = await this.services.store.getOrder(context.identity, reference.orderId);
          if (value.id !== reference.orderId || value.source !== "demo-database" || !value.shop.id || !value.items.length) throw new Error();
          return value;
        });
        if (!stillCurrent()) return clarify("task");
        const task = await call("get_merchant_request", { orderId: reference.orderId, taskId: reference.taskId }, async () => {
          const value = await this.services.merchant!.getTask(context.identity, context.sourceKey, reference.orderId, { referenceTaskId: reference.taskId });
          if (value && (value.taskId !== reference.taskId || value.orderId !== reference.orderId
            || !["pending", "approved", "rejected", "timed_out"].includes(value.status))) throw new Error();
          return value;
        });
        if (!stillCurrent()) return clarify("task");
        evidence.task = task ?? null;
        return task ? result({ kind: "merchant_status", task })
          : result(notice("该历史协商任务当前不可查询，请提供本人订单号重新核实；不会沿用旧任务结果。"), "blocked");
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!(error instanceof SupportServiceError)) throw error;
        return result(notice(error.message), "blocked");
      }
    }

    const semantic = isContextSupportAction(action);
    if (context.pendingReferenceKind === "order" && (action.orderRef?.kind === "focus" || action.orderRef?.kind === "alternative"
      || semantic && (action.kind === "policy" || action.kind === "refund_eligibility") && action.questionContext.kind === "previous")) return clarify("order");
    if (context.pendingReferenceKind === "policy" && semantic && (action.kind === "policy" || action.kind === "refund_eligibility")
      && action.questionContext.kind === "previous") return clarify("policy_topic");
    const objectReference = semantic ? action.kind === "paid_amount_compare" ? "remaining_amount"
      : action.orderRef?.kind === "alternative" ? "alternative_order" : null : supportObjectReference(context.userText);
    const readOnlyQuestion = action.kind === "policy" || action.kind === "refund_eligibility" || action.kind === "paid_amount_compare";
    if (objectReference === "ambiguous" || new Set(context.userText.match(/COUPON-\d{4}(?!\d)/g) ?? []).size > 1) return clarify("order");
    if (!semantic && readOnlyQuestion && multiplePolicyQuestions(context.userText)) return clarify("intent");
    let alternativeOrderId: string | undefined;
    if (objectReference) {
      const selectedOrderId = action.orderRef?.kind === "explicit" ? action.orderRef.orderId : context.focusOrderId;
      if (!readOnlyQuestion || !action.orderRef || !selectedOrderId) return clarify("order");
      if (objectReference === "alternative_order") {
        if ((!semantic && action.orderRef.kind !== "focus") || !context.focusOrderId) return clarify("order");
        alternativeOrderId = selectAlternativeOrder(context.orderChoices, binding, context.focusOrderId);
        if (!alternativeOrderId || !semantic && (!policyTopicMatches(policyTopic, { ...binding, orderId: context.focusOrderId })
          || !["policy", "refund_eligibility"].includes(policyTopic!.intent ?? ""))) return clarify("order");
      } else {
        if (!amountReference || amountReference.sourceKey !== context.sourceKey || amountReference.groupOpenid !== binding.groupOpenid
          || action.kind === "paid_amount_compare" && action.amountRef.requestId !== amountReference.requestId) return clarify("amount_basis");
        if (amountReference.orderId !== selectedOrderId) return result(notice("已选金额基准来自 " + amountReference.orderId
          + "，当前比较对象是 " + selectedOrderId + "。暂不支持跨订单实付比较；请查询并选择当前订单的基准。未计算金额差异，也不表示退款批准。"), "clarification");
      }
      if (!semantic && objectReference === "remaining_amount" && /(?:[\d零一二三四五六七八九十百千万两]+(?:\.\d+)?\s*(?:元|块)|[￥¥]\s*\d|(?:金额|单价|价格)\s*(?:是|为|=|：|:)?\s*\d)/u.test(context.userText)) {
        return result(notice("请明确要比较之前展示的每券实付，还是本轮新提到的金额；本轮不会把新金额当作已批准退款额。"), "clarification");
      }
      if (!semantic && objectReference === "remaining_amount" && /(?:上限|最高|最多|最大|批准|获批|核准|同意|承诺)/u.test(context.userText)) {
        return result(notice("当前只能核对券的实付金额，不能据此确定部分退款申请上限或获批金额。请先明确要核对实付，还是咨询退款资格。"), "clarification");
      }
    } else if (!semantic && hasAmbiguousOrderReference(context.userText)) return clarify("order");
    const resolveOrder = (ref: ContextOrderRef): string | undefined => {
      if (ref.kind === "explicit") return ref.orderId;
      return alternativeOrderId ?? context.focusOrderId;
    };
    const orderId = action.orderRef ? resolveOrder(action.orderRef) : undefined;
    if (action.kind !== "policy" && !orderId) return clarify("order");
    if (action.orderRef && !orderId) return clarify("order");
    if (!orderId && action.kind === "policy" && (semantic ? Boolean(action.productMention) : needsOrderScope(context.userText))) return clarify("order");
    const alternateAnchor = !semantic && alternativeOrderId ? policyTopic!.originalQuery.replaceAll(context.focusOrderId!, alternativeOrderId) : undefined;
    let question = semantic ? { query: context.userText, topic: null as TrustedPolicyTopic | null, needsClarification: false }
      : objectReference === "remaining_amount"
      ? { query: `${context.userText}\n已解析为同单唯一剩余未核销券的实付单价比较。规则问题：剩余券退款申请金额是否按对应券实付单价计算？具体金额由宿主本轮订单事实单独核对。`,
        topic: policyTopicMatches(policyTopic, { ...binding, orderId: orderId! }) ? structuredClone(policyTopic!) : null, needsClarification: false }
      : !semantic && alternativeOrderId ? { query: `${context.userText}\n继续咨询已重新选定订单的问题：${alternateAnchor}。旧问题中的订单状态假设不沿用，以本轮订单事实为准。`,
        topic: structuredClone(policyTopic!), needsClarification: false }
      : resolveSupportPolicyQuestion({ originalQuery: context.userText, sourceKey: context.sourceKey,
        groupOpenid: context.trustedRoute.groupOpenid, orderId: orderId ?? null, policyTopic: policyTopic });
    if (semantic && (action.kind === "policy" || action.kind === "refund_eligibility") && action.questionContext.kind === "previous") {
      if (!policyTopicMatches(policyTopic, { ...binding, orderId: alternativeOrderId ? context.focusOrderId! : orderId ?? null })
        || action.questionContext.requestId !== policyTopic!.requestId) return clarify("policy_topic");
      if (alternativeOrderId && (action.kind !== "refund_eligibility" || policyTopic!.intent !== "refund_eligibility")) return clarify("policy_topic");
      const prior = policyTopicQueries(policyTopic!)!;
      if (!alternativeOrderId && (prior.length > 4 || prior.some(row => row.requestId === context.requestId)
        || prior.reduce((sum, row) => sum + row.originalQuery.length, context.userText.length) > 500)) return restatePolicy();
      // A historical question can contain old order-state assumptions. Moving to
      // another order carries only this bounded intent, never the old sentence.
      question = { query: alternativeOrderId ? `${context.userText}\n本轮继续咨询新选定订单的退款申请资格与条件。`
        : `${context.userText}\n${policyTopicQueryContext(policyTopic!)}`,
        topic: structuredClone(policyTopic!), needsClarification: false };
    }
    if ((action.kind === "policy" || action.kind === "refund_eligibility") && question.needsClarification) return clarify("policy_topic");

    const getOrder = async () => {
      const order = await call("get_order", { orderId }, async () => {
        const value = await this.services.store.getOrder(context.identity, orderId!);
        if (value.id !== orderId || value.source !== "demo-database" || !value.shop.id || !value.items.length) throw new Error();
        return value;
      });
      evidence.order = order;
      if (action.orderRef?.kind === "explicit" || alternativeOrderId) verifiedOrderId = order.id;
      return order;
    };
    const getRules = async (knowledgeContext: SupportKnowledgeContext, order?: Order) => {
      const query = knowledgeContext.effectiveQuery;
      // A service may select the compact candidate by query mode. The legacy
      // store-only path still ranks the full query and records that actual input.
      const retrievalQuery = this.services.knowledge ? knowledgeContext.retrievalQuery ?? query : query;
      const scope = { shopId: order?.shop.id ?? null, productId: order?.items[0]?.productId ?? null };
      const documents = await call("search_faq", { query, retrievalQuery, shopId: scope.shopId ?? undefined, productId: scope.productId ?? undefined }, async step => {
        const started = performance.now();
        const response = this.services.knowledge ? await this.services.knowledge.search({ query, retrievalQuery, originalQuery: context.userText, scope,
          applicabilityContext: knowledgeContext.applicability ?? null, signal: context.signal }) : undefined;
        const docs = response?.documents ?? await this.services.store.searchKnowledge(query, scope.shopId ?? undefined, scope.productId ?? undefined);
        const trace: KnowledgeTrace = response?.trace ?? {
          mode: "lexical", threshold: null, query, originalQuery: context.userText, scope, status: docs.length ? "accepted" : "rejected", reason: null,
          rawRanking: docs.map(doc => ({ id: doc.sourceId, score: null })), acceptance: null,
          sourceHashes: { before: null, after: null }, durationMs: performance.now() - started, calls: [],
          usage: { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
          pricing: { estimated: true, rerankCnyPerMillionTokens: null, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" },
        };
        step.knowledge = structuredClone({ context: knowledgeContext, trace });
        evidence.knowledge.push({ callId: step.id, ...structuredClone(step.knowledge) });
        if (docs.some(doc => !doc.sourceId || typeof doc.body !== "string"
          || (doc.scope.shopId !== null && doc.scope.shopId !== scope.shopId)
          || (doc.scope.productId !== null && doc.scope.productId !== scope.productId))
          || trace.status === "unavailable" && docs.length > 0) throw new Error();
        return docs;
      });
      for (const doc of documents) if (!evidence.rules.some(rule => rule.sourceId === doc.sourceId)) {
        evidence.rules.push({ ...doc, version: createHash("sha256").update(JSON.stringify(doc)).digest("hex") });
      }
      return evidence.rules.map(rule => rule.sourceId);
    };
    const getTask = async () => {
      const task = await call("get_merchant_request", { orderId }, async () => {
        const value = await this.services.merchant!.getTask(context.identity, context.sourceKey, orderId!);
        if (value && (value.orderId !== orderId || !["pending", "approved", "rejected", "timed_out"].includes(value.status))) throw new Error();
        return value;
      });
      evidence.task = task ?? null;
      return task;
    };
    const validReason = (value: string) => value.trim() === value && !merchantReasonControls.test(value)
      && value.length > 0 && context.userText.includes(value);

    // Status queries also verify the explicit selection, so the host can safely update conversation focus.
    // Their short path has no FAQ read or prepare operation.
    const order = orderId ? await getOrder() : undefined;
    const mentions = semantic ? "productMention" in action && action.productMention ? [action.productMention] : [] : productReferences(context.userText);
    if (order && readOnlyQuestion && mentions.some(modifier => modifier
      && !order.items.some(item => item.productName.normalize("NFKC").replace(/\s+/gu, "")
        .includes(semantic ? modifier.normalize("NFKC").replace(/\s+/gu, "") : modifier)))) {
      const products = [...new Set(order.items.map(item => item.productName))].join("、");
      return result(notice(`本轮查到订单 ${order.id} 的商品为「${products}」，尚无法与您描述的商品对应。`
        + "如您咨询的是这份商品，请用此订单号、商品名和具体问题重新说明；如不是，请提供对应订单号。"), "clarification");
    }
    if (action.kind === "merchant_status") {
      if (!this.services.merchant) return result(notice("当前未启用模拟协商，只能咨询订单和规则。"), "blocked");
      const task = await getTask();
      return task ? result({ kind: "merchant_status", task }) : result(notice("当前会话没有这笔订单的协商任务，请先提出协商需求。"), "blocked");
    }
    if (action.kind === "refund_status") {
      if (!this.services.refunds) return result(notice("当前未启用模拟退款，不能确认退款执行结果。"), "blocked");
      const operation = await call("get_refund", { orderId }, async () => {
        const value = await this.services.refunds!.get(context.identity, context.sourceKey, orderId!);
        if (value && (!isRefundOperation(value) || value.orderId !== orderId)) throw new Error();
        return value;
      });
      evidence.operation = operation ?? null;
      return operation ? result({ kind: operation.status === "succeeded" ? "refund_status" : "refund_confirmation", operation })
        : result(notice("当前会话没有这笔订单的退款方案；没有查询到成功退款记录。"), "blocked");
    }

    const showPaidUnit = () => {
      verifiedAmountReference = createAmountReference(order!, binding, context.requestId);
      evidence.displayedPaidUnit = verifiedAmountReference;
      return verifiedAmountReference ? `该商品每券实付 ${(verifiedAmountReference.paidCents / 100).toFixed(2)} 元；这是实付事实，不是获批退款金额。` : "";
    };
    if (action.kind === "order") return result(orderReply(order!, [], `以上为当前本人订单事实。${showPaidUnit()}`));
    if (objectReference === "remaining_amount") {
      if (context.amountChoices && !isDeepStrictEqual(resolveAmountReference(context.amountChoices, binding), amountReference)) return clarify("amount_basis");
      evidence.amountComparison = compareRemainingAmount(order!, amountReference, binding);
      if (!evidence.amountComparison) return result(notice("无法唯一核对剩余券与之前展示的实付单价。请明确具体券；存在多张剩余券、已过期或优惠分摊数据缺失时不能推算。"), "clarification");
    }
    if (action.kind === "paid_amount_compare") {
      const comparison = evidence.amountComparison!;
      showPaidUnit();
      return result(orderReply(order!, [], `当前唯一剩余未核销券实付 ${(comparison.remainingUnitPaidCents / 100).toFixed(2)} 元，`
        + `与上次宿主展示的每券实付 ${(comparison.referencePaidCents / 100).toFixed(2)} 元${comparison.comparisonEqual ? "相同" : "不同"}。`
        + "本轮只核对订单和支付事实，不代表退款申请上限、商家批准或可执行退款金额；未生成或提交退款。"));
    }
    if (order && new Set(order.items.map(item => item.productId)).size !== 1) return clarify("order");
    const prerequisite = action.kind === "merchant_prepare" || action.kind === "refund_prepare";
    const refundQuestion = !semantic && alternativeOrderId ? policyTopic!.intent === "refund_eligibility"
      : action.kind === "refund_eligibility" || objectReference === "remaining_amount";
    // The model may classify the request, but cannot replace an unknown fact with an easier policy question.
    const currentScope = { shopId: order?.shop.id ?? null, productId: order?.items[0]?.productId ?? null };
    if (question.topic && context.policyChoices && !isDeepStrictEqual(selectedPolicyTopic(context), question.topic)) return clarify("policy_topic");
    if (attempt.resolveQuestion && semantic && (action.kind === "policy" || action.kind === "refund_eligibility")) {
      // Old questions are absent from the parser input after a scope change.
      // The parser judges meaning; the host separately verifies its provenance.
      const previous = question.topic && !alternativeOrderId && isDeepStrictEqual(question.topic.scope, currentScope) ? question.topic : null;
      try { evidence.questionResolution = await attempt.resolveQuestion(previous); }
      catch {
        context.signal?.throwIfAborted();
        return unresolvedQuestion(true);
      }
      // Parsing is asynchronous; a previously valid reference may expire while it runs.
      if (previous && context.policyChoices && !isDeepStrictEqual(selectedPolicyTopic(context), previous)) return unresolvedQuestion();
      const decision = evidence.questionResolution.value;
      if (decision.decision === "needs_clarification" || decision.decision === "previous_resolved"
        && (!previous || action.questionContext.kind !== "previous" || decision.previousRequestId !== previous.requestId)
        || decision.decision === "current_complete" && (previous || alternativeOrderId && question.topic)) return unresolvedQuestion();
    }
    if (attempt.questionTraceDeliveryFailed?.()) evidence.traceDeliveryFailed = true;
    if (question.topic && !alternativeOrderId && !isDeepStrictEqual(question.topic.scope, currentScope)) {
      const read = evidence.actualCalls[0];
      if (context.allowPolicyScopeRepair && !attempt.policyScopeRepair && context.policyChoices && semantic && action.kind === "policy"
        && action.questionContext.kind === "previous" && action.orderRef?.kind === "explicit"
        && (!action.evidenceTarget || action.evidenceTarget.kind === "current_order")
        && order?.id === action.orderRef.orderId && question.topic.orderId === order.id
        && evidence.actualCalls.length === 1 && read?.name === "get_order" && !read.isError
        && read.input.orderId === order.id && isDeepStrictEqual(read.output, order) && !evidence.traceDeliveryFailed) {
        context.signal?.throwIfAborted();
        const parserTrace = attempt.questionTrace?.();
        throw new SupportPolicyScopeRepairError({ version: "policy-scope-repair-v1", reason: "scope_changed",
          action, topic: question.topic, call: read,
          ...(evidence.questionResolution ? { questionResolution: evidence.questionResolution } : {}),
          ...(parserTrace ? { questionTrace: structuredClone(parserTrace) } : {}) });
      }
      return attempt.resolveQuestion ? unresolvedQuestion() : clarify("policy_topic");
    }
    let evidenceBinding: ReturnType<typeof buildSupportEvidenceBinding> | undefined;
    try {
      if (semantic) evidenceBinding = buildSupportEvidenceBinding({ action, originalQuery: context.userText,
        verifiedTopic: question.topic, order, requestId: context.requestId,
        ...(attempt.resolveQuestion ? { version: evidenceBindingV3Version } : {}),
        binding: { ...binding, orderId: order?.id ?? null } });
    } catch (error) {
      if (error instanceof SupportEvidenceFactsError) return result(notice(error.message), "clarification");
      throw error;
    }
    let query = evidenceBinding?.effectiveQuery ?? (prerequisite ? refundQuery(order!) : question.query.trim()
      + (order ? `\n已核实订单商品：${order.items[0]!.productName}。` : "")
      + (refundQuestion ? `\n订单状态对应的规则条件：${refundQuery(order!)}。` : ""));
    // The authorized ID selects the scope, not semantic evidence. Preserve it in
    // originalQuery/facts while normalizing only this known locator for retrieval.
    if (order) query = query.replaceAll(`订单 ${order.id}`, "该订单").replaceAll(`订单${order.id}`, "该订单").replaceAll(order.id, "该订单");
    if (query.length > 500) return question.topic ? restatePolicy()
      : result(notice("请缩短本次政策问题，保留要确认的具体条件与订单号。"), "clarification");
    const purpose = prerequisite ? "business_prerequisite" : refundQuestion ? "refund_eligibility" : "user_policy";
    const knowledgeContext: SupportKnowledgeContext = { originalQuery: context.userText,
      modelQuestion: "question" in action ? action.question : null, effectiveQuery: query,
      purpose,
      orderSource: alternativeOrderId ? "verified_alternative" : order ? action.orderRef?.kind === "explicit" ? "current_explicit" : "verified_focus" : "none",
      scopeSource: order ? "fresh_order" : "global",
      policyTopic: question.topic,
      objectReference: objectReference ? { kind: objectReference, fromOrderId: objectReference === "remaining_amount" ? context.amountReference!.orderId : context.focusOrderId!, toOrderId: orderId!,
        sourceRequestIds: objectReference === "remaining_amount" ? [context.amountReference!.requestId]
          : [...(question.topic ? [question.topic.requestId] : []), ...context.orderChoices!.orders.map(row => row.requestId)] } : null,
      ...(semantic ? { protocol: "v2.2" as const } : {}),
      facts: order ? { orderId: order.id, asOf: order.asOf, status: order.status,
        productId: order.items[0]!.productId, productName: order.items[0]!.productName, refundState: refundQuery(order) } : null,
      ...evidenceBinding };
    const ids = await getRules(knowledgeContext, order);
    if (action.kind === "policy" || action.kind === "refund_eligibility") {
      const anchor = semantic ? context.userText : alternateAnchor ?? question.topic?.originalQuery ?? context.userText;
      // A single handled question may have several real sources; source count is not an intent count.
      if (ids.length > 0 && ids.length <= 5 && (!semantic || anchor.length <= 500) && (objectReference !== "remaining_amount" || question.topic)
        && (semantic || !/[；;、\n]|[?？].*\S|(?:以及|同时|另外|并且|顺便|和|与)/u.test(anchor))) {
        verifiedPolicyTopic = { requestId: context.requestId, sourceKey: context.sourceKey, groupOpenid: context.trustedRoute.groupOpenid,
          originalQuery: anchor, orderId: order?.id ?? null, scope: currentScope,
          intent: !semantic && alternativeOrderId ? policyTopic!.intent : action.kind,
          ...(semantic ? { priorQueries: question.topic && !alternativeOrderId ? policyTopicQueries(question.topic)! : [] } : {}),
          sources: evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })) };
      }
      if (evidence.amountComparison) {
        const comparison = evidence.amountComparison;
        showPaidUnit();
        return result(orderReply(order!, ids, `当前唯一剩余未核销券实付 ${(comparison.remainingUnitPaidCents / 100).toFixed(2)} 元，`
          + `与上次宿主展示的每券实付 ${(comparison.referencePaidCents / 100).toFixed(2)} 元${comparison.comparisonEqual ? "相同" : "不同"}。`
          + (ids.length ? `退款计算规则依据：${ids.join("、")}。` : "未查到适用退款规则，不能确认可退款金额。")
          + "本轮只比较实付，不代表商家批准或可执行退款金额；未生成或提交退款。"));
      }
      if (order && ids.length && /(?:单价|金额|多少钱|退多少|实付)/u.test(context.userText)) {
        const paid = showPaidUnit();
        if (paid) return result(orderReply(order, ids, `${paid}\n适用规则：${evidence.rules.map(rule => `${rule.body}（${rule.sourceId}）`).join("\n")}\n本轮未申请或执行退款，批准及金额仍需实际业务核验。`));
      }
      const text = ids.length ? "已查到相关规则，暂时未能完成说明，请稍后重新咨询。" : "未查到支持当前问题的适用规则，无法确认，请自行向商家或测试管理员核实。";
      return result(order ? orderReply(order, ids, text) : { kind: "answer", text, evidenceIds: ids }, "ready", ids.length > 0);
    }
    if (!ids.length) return result(orderReply(order!, [], "未查到适用规则，当前不能准备方案，请联系测试管理员核实。"), "blocked");
    if (!this.services.merchant) return result(notice("当前未启用模拟协商，只能咨询订单和规则。"), "blocked");
    if (action.kind === "merchant_prepare") {
      if (!validReason(action.reason)) return clarify("reason");
      const prepared = await call("prepare_merchant_request", { orderId, reason: action.reason }, async () => {
        const value = await this.services.merchant!.prepare(context.identity, context.sourceKey, orderId!, action.reason);
        if (value.orderId !== orderId || value.simulation !== true || value.status !== "confirmation_required"
          || value.confirmationText !== `确认联系商家 ${orderId} 原因：${action.reason}`) throw new Error();
        return value;
      });
      return result({ kind: "merchant_confirmation", orderId: prepared.orderId, amountCents: prepared.amountCents, confirmationText: prepared.confirmationText });
    }
    if (!this.services.refunds) return result(notice("当前未启用模拟退款，不能生成退款方案。"), "blocked");
    const task = await getTask();
    if (!task) return result(notice("当前会话尚无这笔订单的协商任务。请提供原因并明确要求联系商家，收到确认文字后本人确认。"), "blocked");
    if (task.status !== "approved") return result({ kind: "merchant_status", task }, "blocked");
    const operation = await call("prepare_refund", { orderId }, async () => {
      const value = await this.services.refunds!.prepare(context.identity, context.sourceKey, orderId!);
      if (!isRefundOperation(value) || value.orderId !== orderId || value.taskId !== task.taskId
        || value.amountCents !== order!.amounts.paidCents || value.amountCents !== task.approvedAmountCents) throw new Error();
      return value;
    });
    evidence.operation = operation;
    return result({ kind: operation.status === "succeeded" ? "refund_status" : "refund_confirmation", operation });
  }
}
