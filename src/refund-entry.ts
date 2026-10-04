import type { QQIdentity } from "./coupon-store.ts";
import type { RefundStore } from "./refunds.ts";
import type { Reply } from "./reply.ts";

// Only actual user ingress reaches this function; no model tool can confirm a refund.
export async function confirmRefundReply(
  store: RefundStore, identity: QQIdentity, sourceKey: string, text: string,
): Promise<Reply | undefined> {
  // Mobile input may add horizontal padding; preserve every newline and embedded character.
  text = text.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!text.startsWith("确认退款")) return undefined;
  const match = /^确认退款 ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(text);
  if (!match || match[0] !== text) return { kind: "notice", text: "请核对退款方案，并完整发送单行“确认退款 操作编号”，或点击方案中的确认按钮后发送。这里只处理模拟退款。" };
  try {
    return { kind: "refund_status", operation: await store.confirm(identity, sourceKey, match[1]!) };
  } catch {
    // Commit/send timeouts can have an unknown outcome; never claim that nothing happened.
    return { kind: "notice", text: "无法确认此次模拟退款结果。请在原会话按订单号查询退款状态；未成功的操作须先核对本人订单、商家批准及未过期的退款方案。" };
  }
}

export async function markRefundReplyPresented(
  store: RefundStore, identity: QQIdentity, sourceKey: string, reply: Reply,
): Promise<void> {
  // Expired summaries contain no confirmation action; delivery must not try to reopen them.
  if (reply.kind === "refund_confirmation" && Date.parse(reply.operation.expiresAt) > Date.now()) {
    await store.markPresented(identity, sourceKey, reply.operation.operationId);
  }
}
