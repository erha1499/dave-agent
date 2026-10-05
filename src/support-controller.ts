import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MerchantBusinessError, merchantReasonControls, merchantSourceKey, type AfterSalesStore, type MerchantTask } from "./after-sales.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "./coupon-store.ts";
import { RefundBusinessError, type RefundStore } from "./refunds.ts";
import { isRefundOperation, type Reply } from "./reply.ts";
import { parseSupportAction, SupportProtocolError, type SupportAction, type SupportOrderRef } from "./support-action.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Knowledge = Awaited<ReturnType<CouponStore["searchKnowledge"]>>;
type CallName = "get_order" | "search_faq" | "prepare_merchant_request" | "get_merchant_request" | "prepare_refund" | "get_refund";
export type SupportCall = {
  id: string; parentSpanId: string; actor: "host"; trigger: "user"; component: "support-controller";
  name: CallName; input: Record<string, unknown>; output?: unknown;
  observedAt: string; durationMs: number; isError: boolean;
  errorKind?: "business_denial" | "service_error";
};
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
  userText: string; focusOrderId?: string; signal?: AbortSignal;
  onCall?: (call: SupportCall) => void;
};
export type EvidenceBundle = {
  version: 1; requestId: string; trustedRoute: SupportTurnContext["trustedRoute"];
  action: SupportAction; actualCalls: SupportCall[];
  traceDeliveryFailed?: boolean;
  order?: Order; rules: Array<Knowledge[number] & { version: string }>;
  task?: MerchantTask | null;
  operation?: Awaited<ReturnType<RefundStore["get"]>> | null;
};
export type SupportResult = {
  action: SupportAction; outcome: "ready" | "clarification" | "blocked" | "non_business";
  reply: Reply; evidence: EvidenceBundle; needsAnswer: boolean;
  // Only a current explicit user selection followed by getOrder success can change the host's focus.
  verifiedOrderId?: string;
};
export type SupportServices = {
  store: Pick<CouponStore, "getOrder" | "searchKnowledge">;
  merchant?: Pick<AfterSalesStore, "prepare" | "getTask">;
  refunds?: Pick<RefundStore, "prepare" | "get">;
};

const notice = (text: string): Reply => ({ kind: "notice", text });
function orderReply(order: Order, ids: string[], text: string): Reply {
  return { kind: "order", text, orders: [{ id: order.id, status: order.status,
    paidCents: order.amounts.paidCents, refundedCents: order.amounts.refundedCents,
    couponStatuses: order.coupons.map(coupon => coupon.status) }], evidenceIds: ids };
}
function refundQuery(order: Order): string {
  if (order.status === "pending_payment") return "未支付退款";
  if (order.status === "refunded" || order.amounts.refundedCents > 0) return "已退款重复退款";
  if (order.status === "partially_redeemed") return "部分核销剩余退款";
  if (order.coupons.some(coupon => coupon.status === "redeemed")) return "已核销退款";
  if (order.coupons.some(coupon => coupon.status === "expired"
    || (coupon.expiresAt !== null && Date.parse(coupon.expiresAt) <= Date.parse(order.asOf)))) return "过期退款";
  return "未核销退款";
}

export class SupportController {
  private services: SupportServices;
  constructor(services: SupportServices) { this.services = services; }

  createTurn(context: SupportTurnContext) {
    if (!context.requestId || context.requestId.length > 512 || !context.userText.trim() || context.userText.length > 5000
      || !context.trustedRoute.messageId || context.trustedRoute.messageId.length > 512
      || context.sourceKey !== merchantSourceKey(context.identity, context.trustedRoute.groupOpenid)
      || (context.focusOrderId !== undefined && !/^COUPON-\d{4}$/.test(context.focusOrderId))) {
      throw new SupportProtocolError("宿主业务上下文无效。");
    }
    const trusted = { ...context, identity: { ...context.identity }, trustedRoute: { ...context.trustedRoute } };
    let accepted: SupportAction | undefined;
    let pending: Promise<SupportResult> | undefined;
    return {
      execute: (input: unknown): Promise<SupportResult> => {
        const action = parseSupportAction(input);
        if (accepted) {
          if (!isDeepStrictEqual(action, accepted)) throw new SupportProtocolError("本轮已有业务动作，不能追加冲突动作；请在下一轮明确需求。");
          return pending!;
        }
        accepted = structuredClone(action);
        // Cache the promise, including rejection: a model retry cannot re-run an uncertain mutation.
        pending = this.execute(trusted, accepted);
        return pending;
      },
    };
  }

  private async execute(context: SupportTurnContext, action: SupportAction): Promise<SupportResult> {
    const evidence: EvidenceBundle = { version: 1, requestId: context.requestId, trustedRoute: { ...context.trustedRoute }, action,
      actualCalls: [], rules: [] };
    let verifiedOrderId: string | undefined;
    let sequence = 0;
    const result = (reply: Reply, outcome: SupportResult["outcome"] = "ready", needsAnswer = false): SupportResult =>
      ({ action, outcome, reply, evidence, needsAnswer, ...(verifiedOrderId ? { verifiedOrderId } : {}) });
    const emit = (step: SupportCall) => {
      // Telemetry is not part of the business transaction and cannot turn a completed prepare into a retry.
      try { context.onCall?.(structuredClone(step)); }
      catch { evidence.traceDeliveryFailed = true; }
    };
    const call = async <T>(name: CallName, input: Record<string, unknown>, operation: () => Promise<T>): Promise<T> => {
      context.signal?.throwIfAborted();
      const step: SupportCall = { id: `${context.requestId}:${++sequence}`, parentSpanId: context.requestId,
        actor: "host", trigger: "user", component: "support-controller", name, input: structuredClone(input),
        observedAt: new Date().toISOString(), durationMs: 0, isError: false };
      const started = performance.now();
      let value: T;
      try {
        value = await operation();
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
      return value;
    };
    const clarify = (field: "order" | "reason" | "intent") => result(notice({
      order: "请明确本次要查询或操作的模拟订单号。",
      reason: "请说明希望联系商家协商的原因。",
      intent: "请明确本次先处理哪项需求：政策咨询、协商进度、退款申请或退款状态。",
    }[field]), "clarification");
    if (action.kind === "clarify") return clarify(action.field);
    if (action.kind === "non_business") return result(notice(action.reason === "greeting"
      ? "你好，我可以查询模拟团购券订单、说明套餐规则，以及办理模拟协商和退款。请告诉我你的问题。"
      : "当前仅支持模拟团购券咨询、订单查询、协商和退款，不支持这项请求。"), "non_business");

    const explicitIds = [...new Set(context.userText.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
    if (explicitIds.length > 1) return clarify("order");
    const resolveOrder = (ref: SupportOrderRef): string | undefined => {
      if (ref.kind === "explicit") {
        if (!explicitIds.includes(ref.orderId)) throw new SupportProtocolError("订单引用不在当前用户消息中；历史唯一订单应使用 focus，不能编造显式选单。");
        return ref.orderId;
      }
      if (explicitIds.length) throw new SupportProtocolError("当前用户已写明订单，请使用该显式订单引用，不能沿用旧焦点。");
      return context.focusOrderId;
    };
    const orderId = action.orderRef ? resolveOrder(action.orderRef) : undefined;
    if (action.kind !== "policy" && !orderId) return clarify("order");
    if (action.kind === "policy" && !action.orderRef && explicitIds.length) {
      throw new SupportProtocolError("当前问题涉及明确订单，请提供该订单引用以查询实际套餐范围。");
    }
    if (action.orderRef && !orderId) return clarify("order");

    const getOrder = async () => {
      const order = await call("get_order", { orderId }, async () => {
        const value = await this.services.store.getOrder(context.identity, orderId!);
        if (value.id !== orderId || value.source !== "demo-database" || !value.shop.id || !value.items.length) throw new Error();
        return value;
      });
      evidence.order = order;
      if (action.orderRef?.kind === "explicit") verifiedOrderId = order.id;
      return order;
    };
    const getRules = async (query: string, order?: Order) => {
      const scopes = order ? [...new Set(order.items.map(item => item.productId))].map(productId => ({ shopId: order.shop.id, productId })) : [{}];
      for (const scope of scopes) {
        const documents = await call("search_faq", { query, ...scope }, async () => {
          const docs = await this.services.store.searchKnowledge(query, "shopId" in scope ? scope.shopId : undefined,
            "productId" in scope ? scope.productId : undefined);
          if (docs.some(doc => !doc.sourceId || typeof doc.body !== "string"
            || (doc.scope.shopId !== null && doc.scope.shopId !== ("shopId" in scope ? scope.shopId : undefined))
            || (doc.scope.productId !== null && doc.scope.productId !== ("productId" in scope ? scope.productId : undefined)))) throw new Error();
          return docs;
        });
        for (const doc of documents) if (!evidence.rules.some(rule => rule.sourceId === doc.sourceId)) {
          evidence.rules.push({ ...doc, version: createHash("sha256").update(JSON.stringify(doc)).digest("hex") });
        }
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

    if (action.kind === "order") return result(orderReply(order!, [], "以上为当前本人订单事实。"));
    const query = action.kind === "policy" ? action.question : action.kind === "refund_eligibility"
      ? `${action.question.slice(0, 450)} ${refundQuery(order!)}` : refundQuery(order!);
    const ids = await getRules(query, order);
    if (action.kind === "policy" || action.kind === "refund_eligibility") {
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
