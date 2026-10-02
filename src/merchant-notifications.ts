import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AfterSalesStore, MerchantNotification } from "./after-sales.ts";
import { QQAgent, validQQMessage } from "./qq-agent.ts";

function notificationMessage(item: MerchantNotification): QQBotInboundMessage {
  const content = `模拟商家任务结果通知 ${item.orderId}`;
  return {
    kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: item.senderId,
    groupOpenid: item.groupOpenid, messageId: item.messageId, timestamp: item.timestamp, content,
    replyTarget: { scope: "group", targetId: item.groupOpenid, msgId: item.messageId },
    raw: { id: item.messageId, timestamp: item.timestamp, content, group_openid: item.groupOpenid,
      author: { member_openid: item.senderId } },
  };
}

// Reuse the merchant worker. Pending rows survive restarts; claimed rows are never automatically retried.
export async function dispatchMerchantNotifications(
  store: AfterSalesStore, agent: QQAgent, appId: string, allowedGroups: string[],
) {
  const items = await store.listNotifications(appId);
  // ponytail: a bounded batch for one test-group service; add a worker concurrency limit if traffic grows.
  const results = await Promise.allSettled(items.map(async item => {
    let claimed = false;
    const msg = notificationMessage(item);
    let outcome: "busy" | "sent" | "deferred" | "unknown" = "deferred";
    if (allowedGroups.includes(item.groupOpenid) && validQQMessage(msg)) {
      outcome = await agent.resumeMerchant(msg, async () => {
        claimed = await store.claimNotification(item.taskId, appId);
        if (!claimed) return undefined;
        const task = await store.getTask({ appId, senderId: item.senderId }, item.sourceKey, item.orderId);
        return task?.taskId === item.taskId && task.status !== "pending" ? task : undefined;
      });
    }
    if (outcome === "busy") return; // Leave pending until the queue has room or the original reply window expires.
    if (!claimed && outcome === "deferred") claimed = await store.claimNotification(item.taskId, appId);
    if (claimed) await store.finishNotification(item.taskId, appId, outcome);
  }));
  if (results.some(result => result.status === "rejected")) {
    console.error("[merchant] 部分通知状态无法确认；已领取的通知不自动重发，可按订单号查询结果。");
  }
}
