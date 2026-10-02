import {
  QQBot, accessPolicy, contentSanitizer, mentionGate, messageFilter,
  type QQBotInboundMessage, type QQBotOptions, type ReplyTarget,
} from "@tencent-connect/qqbot-nodejs";
import { QQWebhookServer } from "./qq-http.ts";

export function readQQConfig(env: NodeJS.ProcessEnv = process.env) {
  const appId = env.QQBOT_APP_ID?.trim();
  const appSecret = env.QQBOT_APP_SECRET?.trim();
  if (!appId || !/^\d+$/.test(appId) || !appSecret) {
    throw new Error("请设置有效的 QQBOT_APP_ID 和 QQBOT_APP_SECRET。");
  }
  const transport = env.QQ_TRANSPORT?.trim() || (env.NODE_ENV === "production" ? "webhook" : "websocket");
  if (transport !== "websocket" && transport !== "webhook") {
    throw new Error("QQ_TRANSPORT 仅支持 websocket 或 webhook。");
  }
  const allowedGroups = (env.QQ_ALLOWED_GROUPS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (allowedGroups.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new Error("QQ_ALLOWED_GROUPS 请填写逗号分隔的群 OpenID，不能使用通配符或 QQ 群号替代。");
  }
  const options: QQBotOptions = {
    appId, appSecret, transport, intents: 1 << 25, markdownSupport: false,
    baseUrl: "https://api.bot.qq.com", tokenBaseUrl: "https://api.bot.qq.com",
  };
  if (transport === "webhook") {
    const portText = env.QQBOT_WEBHOOK_PORT?.trim() || "8080";
    const port = Number(portText);
    const path = env.QQBOT_WEBHOOK_PATH?.trim() || "/qq/callback";
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("QQBOT_WEBHOOK_PORT 应为 1–65535 的整数（公网入口通常为 HTTPS 443）。");
    }
    if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) {
      throw new Error("QQBOT_WEBHOOK_PATH 应以 / 开头，只包含字母、数字、下划线、连字符和 /。");
    }
    options.webhook = { port, path };
  }
  return { options, allowedGroups };
}

export async function replyToQQMessage(
  msg: QQBotInboundMessage,
  send: (target: ReplyTarget, text: string) => Promise<unknown>,
  now = Date.now(),
) {
  if (msg.kind !== "group" || msg.rawEventType !== "GROUP_AT_MESSAGE_CREATE"
    || typeof msg.senderId !== "string" || !msg.senderId
    || typeof msg.groupOpenid !== "string" || !msg.groupOpenid
    || typeof msg.messageId !== "string" || !msg.messageId
    || msg.replyTarget?.scope !== "group" || msg.replyTarget.targetId !== msg.groupOpenid
    || msg.replyTarget.msgId !== msg.messageId
    || typeof msg.content !== "string" || !msg.content.trim() || msg.content.length > 5000
    || typeof msg.timestamp !== "string") return;
  const age = now - Date.parse(msg.timestamp);
  if (!Number.isFinite(age) || age < -30_000 || age >= 5 * 60_000) return;
  await send(msg.replyTarget, "QQ 通信测试成功，已收到你的消息。");
}

async function main() {
  const { options, allowedGroups } = readQQConfig();
  const redact = (text: string) => text.replaceAll(options.appSecret, "[redacted]");
  const bot = new QQBot({
    ...options,
    ...(options.webhook && { webhook: { ...options.webhook, server: new QQWebhookServer() } }),
    logger: {
      info: (text) => console.log(redact(text)),
      warn: (text) => console.warn(redact(text)),
      error: (text) => console.error(redact(text)),
    },
  });
  bot.use(accessPolicy({
    c2c: { mode: "disabled" }, guild: { mode: "disabled" },
    group: { mode: "allowlist", allow: allowedGroups },
    onBlock: (ctx) => {
      if (ctx.message.kind === "group") console.log(`[qq] 未启用群 OpenID：${JSON.stringify(ctx.message.groupOpenid)}`);
    },
  }));
  // ponytail: SDK memory dedup is for this demo; persist business idempotency before adding mutations.
  bot.use(messageFilter({ dedup: { windowMs: 5 * 60_000, maxSize: 1000 } }));
  bot.use(mentionGate({ requireMentionInGroup: true, alwaysAnswerC2C: false, passthrough: false }));
  bot.use(contentSanitizer({ stripBotMention: true, collapseWhitespace: true }));
  bot.on("message", async (_ctx, msg) => {
    await replyToQQMessage(msg, (target, text) => bot.sendText(target, text));
  });
  bot.on("error", (error) => console.error(`[qq] ${redact(error.message)}`));
  bot.on("ready", () => console.log(`[qq] ${options.transport} 已就绪；当前仅返回通信测试文本。`));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (!allowedGroups.length) console.log("[qq] QQ_ALLOWED_GROUPS 为空：仅发现群 OpenID，不发送回复。");
  try {
    await bot.start(controller.signal);
  } finally {
    bot.stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const text = error instanceof Error ? error.message : "QQ 启动失败。";
    console.error(process.env.QQBOT_APP_SECRET ? text.replaceAll(process.env.QQBOT_APP_SECRET, "[redacted]") : text);
    process.exitCode = 1;
  });
}
