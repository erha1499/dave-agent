import { merchantReasonControls, type AfterSalesStore, type MerchantReplyRoute } from "./after-sales.ts";
import type { QQIdentity } from "./coupon-store.ts";
import { renderReply, type Reply } from "./reply.ts";

export { merchantSourceKey } from "./after-sales.ts";

// Only the host calls this with actual user input; it is deliberately absent from Pi's tools.
export async function confirmMerchantMessage(
  store: AfterSalesStore, identity: QQIdentity, sourceKey: string, text: string,
): Promise<string | undefined> {
  const reply = await confirmMerchantReply(store, identity, sourceKey, text);
  return reply ? renderReply(reply).text : undefined;
}

export async function confirmMerchantReply(
  store: AfterSalesStore, identity: QQIdentity, sourceKey: string, text: string, route?: MerchantReplyRoute,
): Promise<Reply | undefined> {
  // Mobile input may add horizontal padding; preserve every newline and embedded character.
  text = text.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!text.startsWith("确认联系商家")) return undefined;
  const match = /^确认联系商家 (COUPON-\d{4}) 原因：([^\r\n]{1,200})$/u.exec(text);
  if (!match || merchantReasonControls.test(text) || match[2] !== match[2]?.trim()) {
    return { kind: "notice", text: "请完整发送单行确认文字，例如：确认联系商家 COUPON-2001 原因：行程变化。原因限1–200字；这只会发起模拟协商，不会执行退款。" };
  }
  try {
    const task = await store.request(identity, sourceKey, match[1]!, match[2]!, route);
    return { kind: "merchant_status", task };
  } catch {
    return { kind: "notice", text: "暂未能确认模拟协商结果，请核对本人订单和原确认文字，或查询订单协商进度。协商指令不会执行退款；退款状态请另行查询。" };
  }
}
