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

export async function sendQQReply(
  bot: Pick<QQBot, "send">, target: ReplyTarget, reply: RenderedReply, format: QQReplyFormat,
): Promise<void> {
  // A timeout may follow a successful delivery; never resend or fall back automatically.
  const result = await bot.send(format === "markdown"
    ? { target, msgType: 2, markdown: { content: reply.markdown } }
    : { target, msgType: 0, content: reply.text });
  if (!result.id) throw new Error("QQ 未返回消息 ID，发送结果无法确认。");
}
