import { merchantReasonControls, type MerchantTask } from "./after-sales.ts";

type TextReply<K extends "answer" | "notice"> = { kind: K; text: string; evidenceIds?: string[] };
type Replies = {
  answer: TextReply<"answer">;
  notice: TextReply<"notice">;
  order: {
    kind: "order"; text: string;
    orders: Array<{ id: string; status: string; paidCents: number; refundedCents: number; couponStatuses: string[] }>;
    evidenceIds: string[];
  };
  merchant_confirmation: { kind: "merchant_confirmation"; orderId: string; amountCents: number; confirmationText: string };
  merchant_status: { kind: "merchant_status"; task: MerchantTask };
};
export type Reply = Replies[keyof Replies];
export type RenderedReply = { kind: Reply["kind"]; text: string; markdown: string };
type Content = Omit<RenderedReply, "kind">;

const simulation = "这是模拟结果，未联系真实商家，也未执行退款；重复确认会返回同一任务。";
const orderStatuses = new Map([
  ["pending_payment", "待付款"], ["paid", "已支付"], ["partially_redeemed", "部分核销"],
  ["redeemed", "已核销"], ["refunded", "已退款"], ["closed", "已关闭"],
]);
const couponStatuses = new Map([
  ["unused", "未核销"], ["redeemed", "已核销"], ["expired", "已过期"], ["refunded", "已退款"],
]);
const take = (text: string, size: number) => [...text].slice(0, size).join("");
const field = (text: string, size = 64) => take(text.replace(/[\s\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, " ").trim(), size);

// Every dynamic value is plain text, never Markdown supplied by the model or a tool.
const escape = (text: string) => text.replace(/[\\`*_{}\[\]()#+\-.!|<>~=&:]/gu, "\\$&");
const prose = (text: string) => text.replace(/\r\n?|[\u2028\u2029]/gu, "\n").split("\n")
  .map(line => escape(line.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, " ").trimStart())).join("\n");
function money(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("回复金额必须是非负整数分。");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
function evidence(ids: string[] = []): Content {
  const values = [...new Set(ids)].slice(0, 5).map(id => field(id, 32));
  return values.length ? {
    text: `\n\n依据：${values.join("、")}`,
    markdown: `\n\n**依据**：${values.map(escape).join("、")}`,
  } : { text: "", markdown: "" };
}

const strategies: { [K in keyof Replies]: (reply: Replies[K]) => Content } = {
  answer(reply) {
    const text = take(reply.text, 1000);
    const sources = evidence(reply.evidenceIds);
    return { text: text + sources.text, markdown: `## 客服答复\n\n${prose(text)}${sources.markdown}` };
  },
  notice(reply) {
    const text = take(reply.text, 1000);
    return { text, markdown: `## 服务提示\n\n${prose(text)}` };
  },
  order(reply) {
    const text = take(reply.text, 500);
    const sources = evidence(reply.evidenceIds);
    // ponytail: at most three orders per QQ reply; paginate when multi-order browsing is needed.
    const orders = reply.orders.slice(0, 3).map(order => {
      const id = field(order.id), status = orderStatuses.get(order.status) ?? "未知状态";
      const coupons = order.couponStatuses.slice(0, 3).map(value => couponStatuses.get(value) ?? "未知状态").join("、") || "暂无记录";
      const moreCoupons = order.couponStatuses.length > 3 ? "（仅展示前三张）" : "";
      const paid = money(order.paidCents), refunded = money(order.refundedCents);
      return {
        text: `订单：${id}\n状态：${status}\n实付：${paid} 元\n已退：${refunded} 元\n券状态：${coupons}${moreCoupons}`,
        markdown: `**订单：${escape(id)}**\n\n- 状态：${escape(status)}\n- 实付：${paid} 元\n- 已退：${refunded} 元\n- 券状态：${escape(coupons)}${moreCoupons}`,
      };
    });
    const omitted = reply.orders.length > 3 ? "\n\n本次仅展示前三笔订单，请指定订单号继续查询。" : "";
    return {
      text: ["订单查询", ...orders.map(order => order.text), text].filter(Boolean).join("\n\n") + omitted + sources.text,
      markdown: ["## 订单查询", ...orders.map(order => order.markdown), text ? prose(text) : ""].filter(Boolean).join("\n\n") + omitted + sources.markdown,
    };
  },
  merchant_confirmation(reply) {
    const command = /^确认联系商家 (COUPON-\d{4}) 原因：([^\r\n]{1,200})$/u.exec(reply.confirmationText);
    if (!command || command[1] !== reply.orderId || command[2] !== command[2]?.trim()
      || merchantReasonControls.test(reply.confirmationText)) throw new Error("模拟协商确认文字无效。");
    const amount = money(reply.amountCents);
    const note = "这只会发起模拟协商，未联系真实商家，也未执行退款。";
    return {
      text: `模拟协商待确认\n订单：${reply.orderId}\n申请金额：${amount} 元\n\n请完整发送以下单行文字：\n${reply.confirmationText}\n\n${note}`,
      // QQ copies a quote block with a literal > prefix; keep this command as a plain paragraph.
      markdown: `## 模拟协商待确认\n\n- 订单：${escape(reply.orderId)}\n- 申请金额：${amount} 元\n\n**请完整发送以下单行文字：**\n\n${prose(reply.confirmationText)}\n\n${note}`,
    };
  },
  merchant_status({ task }) {
    if (task.simulation !== true) throw new Error("仅支持模拟商家协商结果。");
    const amount = money(task.amountCents);
    if (task.status === "approved" && (task.approvedAmountCents === null || task.approvedAmountCents <= 0
      || task.approvedAmountCents > task.amountCents)) throw new Error("模拟协商批准金额无效。");
    const statuses: Record<MerchantTask["status"], string> = {
      pending: "已登记，正在等待模拟商家结果。你可以继续咨询，稍后按订单号查询进度。",
      approved: task.status === "approved" ? `模拟商家已同意 ${money(task.approvedAmountCents!)} 元的协商结果。` : "",
      rejected: "模拟商家已拒绝本次协商。",
      timed_out: "等待模拟商家结果已超时，可联系测试管理员核实。",
    };
    const status = statuses[task.status];
    if (!status) throw new Error("模拟协商状态无效。");
    const taskId = field(task.taskId), orderId = field(task.orderId), reason = field(task.reason, 200);
    return {
      text: `模拟协商 ${taskId}\n订单：${orderId}，申请金额：${amount} 元。\n登记原因：${reason}\n${status}\n${simulation}`,
      markdown: `## 模拟协商进度\n\n- 任务：${escape(taskId)}\n- 订单：${escape(orderId)}\n- 申请金额：${amount} 元\n- 登记原因：${escape(reason)}\n\n**${status}**\n\n${simulation}`,
    };
  },
};

function render<K extends keyof Replies>(kind: K, reply: Replies[K]): Content { return strategies[kind](reply); }

export function renderReply(reply: Reply): RenderedReply {
  const content = render(reply.kind, reply);
  // Bound individual fields above, never slice a completed template or its confirmation command.
  if ([...content.markdown].length > 4000) throw new Error("回复模板超过长度限制。");
  return { kind: reply.kind, ...content };
}
