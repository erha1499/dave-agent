import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { merchantReasonControls, type MerchantTask } from "./after-sales.ts";
import { isRefundOperation, type Reply } from "./reply.ts";

type ToolResult = Extract<AgentSession["messages"][number], { role: "toolResult" }>;
export type Evidence = Pick<ToolResult, "toolName" | "isError" | "content">;
export type ReadOnlyOrderContext = { previousOrderIds: readonly string[]; requestedOrderIds: readonly string[]; allowOrderList?: boolean };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const orderId = (value: unknown): value is string => typeof value === "string" && /^COUPON-\d{4}$/.test(value);
const scopeId = (value: unknown) => value === null || typeof value === "string" && Boolean(value.trim());
// Host-rendered rule excerpts keep the title and body; internal IDs stay in evidence metadata
// and the leading synthetic-data tag is dropped. The remaining body text is unchanged.
const ruleExcerpt = (document: { title: string; body: string }) => `${document.title}\n${document.body.replace(/^【演示规则】/u, "")}`;
const businessTools = ["list_orders", "get_order", "search_faq", "prepare_merchant_request", "get_merchant_request", "prepare_refund", "get_refund"];

export function toolEvidenceFromEvent(event: AgentSessionEvent): Evidence | undefined {
  if (event.type !== "tool_execution_end") return undefined;
  // Keep malformed results so the reply boundary rejects them instead of reusing earlier evidence.
  return { toolName: event.toolName, isError: event.isError,
    content: (record(event.result) ? event.result.content : undefined) as Evidence["content"] };
}

function merchantTask(value: unknown): value is MerchantTask {
  if (!record(value) || value.simulation !== true || !orderId(value.orderId)
    || typeof value.taskId !== "string" || !/^[a-f0-9-]{36}$/.test(value.taskId)
    || typeof value.reason !== "string" || [...value.reason].length > 200
    || !cents(value.amountCents) || value.amountCents === 0
    || typeof value.createdAt !== "string" || typeof value.dueAt !== "string"
    || !(value.completedAt === null || typeof value.completedAt === "string")) return false;
  if (value.status === "approved") return cents(value.approvedAmountCents)
    && value.approvedAmountCents > 0 && value.approvedAmountCents <= value.amountCents;
  return ["pending", "rejected", "timed_out"].includes(String(value.status)) && value.approvedAmountCents === null;
}

// Only current-turn tool results may unlock business prose or select a template.
function readEvidence(results: readonly Evidence[]) {
  const orders: Extract<Reply, { kind: "order" }>["orders"] = [];
  const evidenceIds = new Set<string>();
  const documents: Array<{ sourceId: string; title: string; body: string }> = [];
  let hasMore = false;
  let listed = false;
  let listFailed = false;
  let merchant: Reply | undefined;
  let refund: Reply | undefined;
  let refundFailed = false;
  const failed = new Set<string>();
  const orderScopes: Array<{ orderId: string; shopId: string; productIds: string[] }> = [];
  const observedOrderIds = new Set<string>();
  const ruleScopes: Array<{ shopId: string | null; productId: string | null }> = [];
  let orderScopeKnown = true;
  let merchantEmpty = false;
  let refundEmpty = false;
  let rulesSearched = false;
  for (const result of results) {
    if (!businessTools.includes(result.toolName)) continue;
    const group = result.toolName.includes("refund") ? "refund" : result.toolName.includes("merchant") ? "merchant"
      : result.toolName === "search_faq" ? "rules" : result.toolName === "list_orders" ? "list" : "order";
    if (result.isError) {
      failed.add(group);
      if (group === "refund") { refund = undefined; refundEmpty = false; refundFailed = true; }
      if (group === "merchant") { merchant = undefined; merchantEmpty = false; }
      if (group === "order" || group === "list") {
        orders.length = 0; orderScopes.length = 0; orderScopeKnown = true; listed = false; hasMore = false;
        merchant = undefined; refund = undefined; merchantEmpty = false; refundEmpty = false;
        listFailed = result.toolName === "list_orders";
      }
      if (group === "rules") { evidenceIds.clear(); ruleScopes.length = 0; documents.length = 0; }
      continue;
    }
    const value: unknown = JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
    if (result.toolName === "list_orders") {
      if (!record(value) || value.source !== "demo-database" || typeof value.hasMore !== "boolean"
        || !Array.isArray(value.orders) || value.orders.length > 3) throw new Error();
      orders.length = 0; orderScopes.length = 0; orderScopeKnown = true;
      hasMore = value.hasMore;
      listed = true;
      for (const row of value.orders) {
        if (!record(row) || !orderId(row.id) || typeof row.status !== "string" || !cents(row.paidCents) || !cents(row.refundedCents)
          || !Array.isArray(row.couponStatuses) || !row.couponStatuses.every(status => typeof status === "string")
          || typeof row.productName !== "string" || typeof row.shopName !== "string"
          || !(row.createdAt === null || typeof row.createdAt === "string")) throw new Error();
        orders.push({ id: row.id, status: row.status, paidCents: row.paidCents, refundedCents: row.refundedCents,
          couponStatuses: row.couponStatuses as string[], productName: row.productName, shopName: row.shopName,
          createdAt: row.createdAt, selectionText: `选择订单 ${row.id}` });
        observedOrderIds.add(row.id);
      }
    } else if (result.toolName === "get_order") {
      if (!record(value) || value.source !== "demo-database" || !orderId(value.id) || typeof value.status !== "string"
        || !record(value.amounts) || !cents(value.amounts.paidCents) || !cents(value.amounts.refundedCents)
        || !Array.isArray(value.coupons) || !value.coupons.every(item => record(item) && typeof item.status === "string")) throw new Error();
      observedOrderIds.add(value.id);
      // A new order snapshot needs rules read after it, including a reread of the same order.
      evidenceIds.clear(); ruleScopes.length = 0; documents.length = 0;
      merchant = undefined; refund = undefined; merchantEmpty = false; refundEmpty = false;
      const oldOrder = orders.findIndex(order => order.id === value.id);
      if (oldOrder !== -1) orders.splice(oldOrder, 1);
      const oldScope = orderScopes.findIndex(scope => scope.orderId === value.id);
      if (oldScope !== -1) orderScopes.splice(oldScope, 1);
      orders.push({ id: value.id, status: value.status, paidCents: value.amounts.paidCents,
        refundedCents: value.amounts.refundedCents, couponStatuses: value.coupons.map(item => item.status as string) });
      if (record(value.shop) && typeof value.shop.id === "string" && value.shop.id.trim() && Array.isArray(value.items)
        && value.items.length && value.items.every(item => record(item) && typeof item.productId === "string" && item.productId.trim())) {
        orderScopes.push({ orderId: value.id, shopId: value.shop.id, productIds: value.items.map(item => (item as { productId: string }).productId) });
      }
      orderScopeKnown = orderScopes.length === orders.length;
    } else if (result.toolName === "search_faq") {
      if (!Array.isArray(value)) throw new Error();
      evidenceIds.clear(); ruleScopes.length = 0; documents.length = 0; rulesSearched = true;
      for (const document of value) {
        if (!record(document) || document.source !== "demo-knowledge" || typeof document.sourceId !== "string"
          || !/^KB-[A-Z0-9-]{1,80}$/.test(document.sourceId) || typeof document.title !== "string" || !document.title.trim()
          || typeof document.body !== "string" || !document.body.trim() || !record(document.scope)
          || !scopeId(document.scope.shopId) || !scopeId(document.scope.productId)) throw new Error();
        evidenceIds.add(document.sourceId);
        documents.push({ sourceId: document.sourceId, title: document.title, body: document.body });
        ruleScopes.push({ shopId: document.scope.shopId as string | null, productId: document.scope.productId as string | null });
      }
    } else if (result.toolName === "prepare_refund" || result.toolName === "get_refund") {
      if (result.toolName === "get_refund" && value === null) { refund = undefined; refundEmpty = true; }
      else {
        if (!isRefundOperation(value)) throw new Error();
        refundEmpty = false;
        refund = { kind: value.status === "succeeded" ? "refund_status" : "refund_confirmation", operation: value };
      }
    } else if (result.toolName === "prepare_merchant_request") {
      if (!record(value) || value.simulation !== true || value.status !== "confirmation_required"
        || !orderId(value.orderId) || !cents(value.amountCents) || value.amountCents === 0
        || typeof value.confirmationText !== "string" || !value.confirmationText.startsWith(`确认联系商家 ${value.orderId} 原因：`)
        || merchantReasonControls.test(value.confirmationText) || [...value.confirmationText].length > 240) throw new Error();
      merchantEmpty = false;
      merchant = { kind: "merchant_confirmation", orderId: value.orderId, amountCents: value.amountCents, confirmationText: value.confirmationText };
    } else if (value !== null) {
      if (!merchantTask(value)) throw new Error();
      merchantEmpty = false; merchant = { kind: "merchant_status", task: value };
    } else { merchant = undefined; merchantEmpty = true; }
    failed.delete(group);
    if (group === "refund") refundFailed = false;
    if (group === "order") failed.delete("list");
    if (group === "order" || group === "list") listFailed = false;
  }
  return { orders, orderScopes, observedOrderIds, orderScopeKnown, ruleScopes, evidenceIds, documents, hasMore, listed, listFailed, merchant, refund, refundFailed,
    toolFailed: failed.size > 0, orderFailed: failed.has("order") || failed.has("list"), merchantEmpty, refundEmpty, rulesSearched };
}

export function readOnlyEvidenceOrderIds(evidence: Evidence): string[] {
  if (evidence.isError || !["get_order", "list_orders"].includes(evidence.toolName)) return [];
  try { return [...readEvidence([evidence]).observedOrderIds]; } catch { return []; }
}

function matchesRequestedOrder(facts: ReturnType<typeof readEvidence>, context: ReadOnlyOrderContext) {
  return context.requestedOrderIds.length === 1 && orderId(context.requestedOrderIds[0])
    && facts.orders.length === 1 && facts.orders[0]!.id === context.requestedOrderIds[0]
    && [...facts.observedOrderIds].every(id => id === context.requestedOrderIds[0]);
}

function allowsReadOnlyProse(facts: ReturnType<typeof readEvidence>, context?: ReadOnlyOrderContext) {
  return !context || matchesRequestedOrder(facts, context)
    && context.previousOrderIds.every(id => id === context.requestedOrderIds[0]);
}

function allowsBusinessText(value: ReturnType<typeof readEvidence>) {
  // This checks evidence presence/shape, not whether every sentence is entailed.
  if (!value.evidenceIds.size || value.toolFailed || value.listed || value.merchant || value.refund
    || value.merchantEmpty || value.refundEmpty) return false;
  if (!value.orders.length) return false;
  const matches = (rule: typeof value.ruleScopes[number], order: typeof value.orderScopes[number], productId: string) =>
    (rule.shopId === null || rule.shopId === order.shopId) && (rule.productId === null || rule.productId === productId);
  return value.orderScopeKnown && value.orderScopes.length > 0
    && value.ruleScopes.every(rule => value.orderScopes.some(order => order.productIds.some(productId => matches(rule, order, productId))))
    && value.orderScopes.every(order => order.productIds.every(productId => value.ruleScopes.some(rule => matches(rule, order, productId))));
}

export function canStreamBusinessText(results: readonly Evidence[], context?: ReadOnlyOrderContext): boolean {
  try { const facts = readEvidence(results); return allowsReadOnlyProse(facts, context) && allowsBusinessText(facts); } catch { return false; }
}

export function replyFromTools(text: string, results: readonly Evidence[], activeToolNames: readonly string[] = ["get_order"], context?: ReadOnlyOrderContext): Reply {
  if (!activeToolNames.some(name => businessTools.includes(name))) return { kind: "answer", text };
  let facts: ReturnType<typeof readEvidence>;
  try { facts = readEvidence(results); }
  catch {
    return { kind: "notice", text: "查询结果格式异常，无法确认当前状态，请按订单号重新查询。" };
  }
  const { orders, evidenceIds, hasMore, listed, listFailed, merchant, refund, refundFailed, toolFailed, merchantEmpty, refundEmpty } = facts;
  if (facts.orderFailed) return { kind: "notice", text: listFailed ? "最近订单暂时无法查询，请稍后重试或核对本人身份绑定。"
    : "本轮订单读取未能完成，无法继续展示该轮办理信息。仅支持当前客户本人订单，不能代查他人订单或披露其券状态、金额。请核对本人订单号或联系人工核实；不能据此判断操作是否执行。" };
  if (context && (context.requestedOrderIds.length > 1
    || new Set(context.previousOrderIds).size > 1 && context.requestedOrderIds.length !== 1
    || (!listed || context.allowOrderList !== true || results.some(result => result.toolName === "get_order" && !result.isError))
      && facts.observedOrderIds.size > 0 && !matchesRequestedOrder(facts, context))) {
    return { kind: "notice", text: "请明确本次要咨询的一笔本人订单号；当前不能把不同订单的事实或规则合并答复。选择订单只用于定位，不会办理操作。" };
  }
  if (refund) return refund;
  if (refundFailed) return { kind: "notice", text: "无法确认当前模拟退款状态，请在原会话按订单号重新查询，或联系测试管理员核实。" };
  if (refundEmpty) return { kind: "notice", text: "本轮未查到当前会话的退款方案。这个结果不能证明订单从未退款或真实资金是否到账；请按本人订单核对退款记录，必要时联系人工核实。" };
  if (merchant) return merchant;
  if (merchantEmpty) return { kind: "notice", text: "本轮未查到当前会话的协商任务，不能据此认定商家已经批准。请核对本人订单号和原会话，必要时联系人工核实。" };
  const hasRules = allowsBusinessText(facts);
  const orderText = hasRules ? activeToolNames.includes("get_merchant_request")
    ? "以下仅为本轮读取的订单事实。本轮尚未取得当前协商状态，不能沿用历史拒绝或批准，也不能确认退款方案；请继续查询当前协商结果。"
    : allowsReadOnlyProse(facts, context) ? text
      : "以下是刚刚查询到的这笔订单信息和适用规则。其他订单的历史记录不会用来判断这笔订单；金额、核销和退款状态是已有记录，本次未办理退款、核销、延期、预约或联系商家。\n\n"
        + facts.documents.map(ruleExcerpt).join("\n\n")
    : "这是刚刚查询到的订单信息。本轮未取得完整适用规则依据，不能据此判断退款资格或可退金额；需要的话可以继续核对规则。";
  if (orders.length || listed) return { kind: "order", text: !orders.length ? "当前客户没有订单记录。"
    : listed ? "这是你最近的订单，仅供选单：请选择要咨询的一笔，我会按这笔订单重新查询订单和适用规则。选择订单不会办理任何操作。"
      : orderText,
    orders: [...new Map(orders.map(order => [order.id, order])).values()], evidenceIds: hasRules ? [...evidenceIds] : [], ...(hasMore ? { hasMore } : {}) };
  if (toolFailed) return { kind: "notice", text: "本轮查询未能完成，无法确认当前订单、规则或办理结果。请核对本人订单号，必要时联系人工核实。" };
  if (facts.documents.length) return { kind: "answer", evidenceIds: [...evidenceIds],
    text: "以下是查到的通用规则，尚未核对具体订单，不代表你的订单已满足条件，也不构成退款批准。\n\n"
      + facts.documents.map(ruleExcerpt).join("\n\n") };
  const confirmation = activeToolNames.some(name => name === "prepare_merchant_request" || name === "prepare_refund")
    ? "涉及业务办理时，仍须本人发送对应的完整确认，普通同意不构成授权。" : "";
  // No evidence this turn: say what is missing and how to continue instead of a generic greeting.
  const next = "可以发送订单号，或发送“我有哪些订单”先选择订单。";
  return { kind: "notice", text: (facts.rulesSearched
    ? `通用规则里没有查到相关说明；门店和套餐的具体规定要按订单查询。${next}本轮尚未取得订单依据，暂不能确认办理条件或结果。`
    : `请补充要咨询的订单或具体问题：${next}本轮尚未取得订单或规则依据，暂不能确认办理条件或结果。`) + confirmation };
}
