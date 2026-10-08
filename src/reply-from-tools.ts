import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { merchantReasonControls, type MerchantTask } from "./after-sales.ts";
import { isRefundOperation, type Reply } from "./reply.ts";

type ToolResult = Extract<AgentSession["messages"][number], { role: "toolResult" }>;
type Evidence = Pick<ToolResult, "toolName" | "isError" | "content">;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const orderId = (value: unknown): value is string => typeof value === "string" && /^COUPON-\d{4}$/.test(value);

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

// Template selection only sees successful tool results from this turn, never model-chosen tags or old context.
export function replyFromTools(text: string, results: Evidence[]): Reply {
  const orders: Extract<Reply, { kind: "order" }>["orders"] = [];
  const evidenceIds = new Set<string>();
  let hasMore = false;
  let listed = false;
  let listFailed = false;
  let merchant: Reply | undefined;
  let refund: Reply | undefined;
  let refundFailed = false;
  try {
    for (const result of results) {
      if (result.toolName === "list_orders" && result.isError) listFailed = true;
      if (result.isError && ["prepare_refund", "get_refund"].includes(result.toolName)) refundFailed = true;
      if (result.isError || !["list_orders", "get_order", "search_faq", "prepare_merchant_request", "get_merchant_request", "prepare_refund", "get_refund"].includes(result.toolName)) continue;
      const value: unknown = JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
      if (result.toolName === "list_orders") {
        if (!record(value) || value.source !== "demo-database" || typeof value.hasMore !== "boolean"
          || !Array.isArray(value.orders) || value.orders.length > 3) throw new Error();
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
        }
      } else if (result.toolName === "get_order") {
        if (!record(value) || value.source !== "demo-database" || !orderId(value.id) || typeof value.status !== "string"
          || !record(value.amounts) || !cents(value.amounts.paidCents) || !cents(value.amounts.refundedCents)
          || !Array.isArray(value.coupons) || !value.coupons.every(item => record(item) && typeof item.status === "string")) throw new Error();
        orders.push({ id: value.id, status: value.status, paidCents: value.amounts.paidCents,
          refundedCents: value.amounts.refundedCents, couponStatuses: value.coupons.map(item => item.status as string) });
      } else if (result.toolName === "search_faq") {
        if (!Array.isArray(value)) throw new Error();
        for (const document of value) {
          if (record(document) && typeof document.sourceId === "string" && /^KB-[A-Z0-9-]{1,80}$/.test(document.sourceId)) evidenceIds.add(document.sourceId);
        }
      } else if (result.toolName === "prepare_refund" || result.toolName === "get_refund") {
        if (result.toolName === "get_refund" && value === null) continue;
        if (!isRefundOperation(value)) throw new Error();
        refund = { kind: value.status === "succeeded" ? "refund_status" : "refund_confirmation", operation: value };
      } else if (result.toolName === "prepare_merchant_request") {
        if (!record(value) || value.simulation !== true || value.status !== "confirmation_required"
          || !orderId(value.orderId) || !cents(value.amountCents) || value.amountCents === 0
          || typeof value.confirmationText !== "string" || !value.confirmationText.startsWith(`确认联系商家 ${value.orderId} 原因：`)
          || merchantReasonControls.test(value.confirmationText) || [...value.confirmationText].length > 240) throw new Error();
        merchant = { kind: "merchant_confirmation", orderId: value.orderId, amountCents: value.amountCents, confirmationText: value.confirmationText };
      } else if (value !== null) {
        if (!merchantTask(value)) throw new Error();
        merchant = { kind: "merchant_status", task: value };
      }
    }
  } catch {
    return { kind: "notice", text: "查询结果格式异常，无法确认当前状态，请按订单号重新查询。" };
  }
  if (refund) return refund;
  if (refundFailed) return { kind: "notice", text: "无法确认当前模拟退款状态，请在原会话按订单号重新查询，或联系测试管理员核实。" };
  if (merchant) return merchant;
  if (orders.length || listed) return { kind: "order", text: orders.length ? text : "当前客户没有订单记录。", orders: [...new Map(orders.map(order => [order.id, order])).values()], evidenceIds: [...evidenceIds], ...(hasMore ? { hasMore } : {}) };
  if (listFailed) return { kind: "notice", text: "最近订单暂时无法查询，请稍后重试或核对本人身份绑定。" };
  return { kind: "answer", text, evidenceIds: [...evidenceIds] };
}
