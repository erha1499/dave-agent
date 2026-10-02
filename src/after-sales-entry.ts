import { createHash } from "node:crypto";
import { merchantReasonControls, type AfterSalesStore } from "./after-sales.ts";
import type { QQIdentity } from "./coupon-store.ts";
import { renderReply, type Reply } from "./reply.ts";

export function merchantSourceKey(identity: QQIdentity, conversationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(identity.appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.senderId)
    || !conversationId || conversationId.length > 256) throw new Error("模拟协商会话标识无效。");
  return createHash("sha256").update(JSON.stringify([identity.appId, identity.senderId, conversationId])).digest("hex");
}

// Only the host calls this with actual user input; it is deliberately absent from Pi's tools.
export async function confirmMerchantMessage(
  store: AfterSalesStore, identity: QQIdentity, sourceKey: string, text: string,
): Promise<string | undefined> {
  const reply = await confirmMerchantReply(store, identity, sourceKey, text);
  return reply ? renderReply(reply).text : undefined;
}

export async function confirmMerchantReply(
  store: AfterSalesStore, identity: QQIdentity, sourceKey: string, text: string,
): Promise<Reply | undefined> {
  if (!text.startsWith("确认联系商家")) return undefined;
  const match = /^确认联系商家 (COUPON-\d{4}) 原因：([^\r\n]{1,200})$/u.exec(text);
  if (!match || merchantReasonControls.test(text) || match[2] !== match[2]?.trim()) {
    return { kind: "notice", text: "请完整发送单行确认文字，例如：确认联系商家 COUPON-2001 原因：行程变化。原因限1–200字；这只会发起模拟协商，不会执行退款。" };
  }
  try {
    const task = await store.request(identity, sourceKey, match[1]!, match[2]!);
    return { kind: "merchant_status", task };
  } catch {
    return { kind: "notice", text: "暂未能确认模拟协商结果，请核对本人订单和原确认文字；可用同一句确认文字重试或查询订单协商进度。未执行退款。" };
  }
}
