import { createHash } from "node:crypto";
import type { AfterSalesStore } from "./after-sales.ts";
import type { QQIdentity } from "./coupon-store.ts";

export function merchantSourceKey(identity: QQIdentity, conversationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(identity.appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.senderId)
    || !conversationId || conversationId.length > 256) throw new Error("模拟协商会话标识无效。");
  return createHash("sha256").update(JSON.stringify([identity.appId, identity.senderId, conversationId])).digest("hex");
}

// Only the host calls this with actual user input; it is deliberately absent from Pi's tools.
export async function confirmMerchantMessage(
  store: AfterSalesStore, identity: QQIdentity, sourceKey: string, text: string,
): Promise<string | undefined> {
  if (!text.startsWith("确认联系商家")) return undefined;
  const match = /^确认联系商家 (COUPON-\d{4}) 原因：([^\r\n]{1,200})$/u.exec(text);
  if (!match || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(text) || match[2] !== match[2]?.trim()) {
    return "请完整发送单行确认文字，例如：确认联系商家 COUPON-2001 原因：行程变化。原因限1–200字；这只会发起模拟协商，不会执行退款。";
  }
  try {
    const task = await store.request(identity, sourceKey, match[1]!, match[2]!);
    const amount = (task.amountCents / 100).toFixed(2);
    const status = {
      pending: "已登记，正在等待模拟商家结果。你可以继续咨询，稍后按订单号查询进度。",
      approved: `模拟商家已同意 ${(task.approvedAmountCents! / 100).toFixed(2)} 元的协商结果。`,
      rejected: "模拟商家已拒绝本次协商。",
      timed_out: "等待模拟商家结果已超时，可联系测试管理员核实。",
    }[task.status];
    return `模拟协商 ${task.taskId}\n订单：${task.orderId}，申请金额：${amount} 元。\n登记原因：${task.reason}\n${status}\n这是模拟结果，未联系真实商家，也未执行退款；重复确认会返回同一任务。`;
  } catch {
    return "暂未能确认模拟协商结果，请核对本人订单和原确认文字；可用同一句确认文字重试或查询订单协商进度。未执行退款。";
  }
}
