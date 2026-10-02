import type { QQBot, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { RenderedReply } from "./reply.ts";

export type QQReplyFormat = "markdown" | "text";

export function readQQReplyFormat(env: NodeJS.ProcessEnv = process.env): QQReplyFormat {
  const format = env.QQ_REPLY_FORMAT?.trim() || "markdown";
  if (format !== "markdown" && format !== "text") {
    throw new Error("QQ_REPLY_FORMAT 仅支持 markdown 或 text。");
  }
  return format;
}

export function readQQReplyButtons(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.QQ_REPLY_BUTTONS?.trim() || "false";
  if (value !== "true" && value !== "false") throw new Error("QQ_REPLY_BUTTONS 仅支持 true 或 false。");
  return value === "true";
}

export async function sendQQReply(
  bot: Pick<QQBot, "send">, target: ReplyTarget, reply: RenderedReply, format: QQReplyFormat,
  requesterId?: string,
): Promise<void> {
  // Opt in only after the bot's keyboard permission is verified. Identity comes from trusted ingress.
  const button = format === "markdown" && target.scope === "group" && requesterId !== undefined ? reply.button : undefined;
  if (button && !/^[A-Za-z0-9_-]{1,128}$/.test(requesterId!)) throw new Error("QQ 按钮缺少有效的当前用户。");
  const keyboard = button ? { content: { rows: [{ buttons: [{
    id: reply.kind,
    // Mac QQ ignores the newer styles 3/4; use its supported blue outline.
    render_data: { label: button.label, visited_label: button.label, style: 1 },
    action: {
      type: 2, permission: { type: 0, specify_user_ids: [requesterId!] }, data: button.command,
      enter: false, reply: false, unsupport_tips: "请复制消息中的文字，@机器人后发送。",
      ...(button.confirmation && { modal: { content: button.confirmation, confirm_text: "继续", cancel_text: "返回" } }),
    },
  }] }] } } : undefined;
  // A timeout may follow a successful delivery; never resend or fall back automatically.
  const result = await bot.send(format === "markdown"
    ? { target, msgType: 2, markdown: { content: reply.markdown }, ...(keyboard && { keyboard }) }
    : { target, msgType: 0, content: reply.text });
  if (!result.id) throw new Error("QQ 未返回消息 ID，发送结果无法确认。");
}
