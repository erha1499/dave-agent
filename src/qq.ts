import {
  QQBot, accessPolicy, contentSanitizer, mentionGate, messageFilter,
  type QQBotOptions,
} from "@tencent-connect/qqbot-nodejs";
import { QQWebhookServer } from "./qq-http.ts";
import { createPool } from "mysql2/promise";
import { createConfiguredModelRuntime, createCouponSession } from "./agent.ts";
import { CouponStore, readDatabaseConfig } from "./coupon-store.ts";
import { recordQQIdentity } from "./qq-identity.ts";
import { QQAgent } from "./qq-agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig, startMockMerchant } from "./after-sales.ts";
import { confirmMerchantMessage, merchantSourceKey } from "./after-sales-entry.ts";

// Keep internal newlines intact so the host can reject malformed confirmation commands.
export const sanitizeQQContent = contentSanitizer({ stripBotMention: true, collapseWhitespace: false });

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

async function main() {
  const { options, allowedGroups } = readQQConfig();
  const store = new CouponStore(createPool(readDatabaseConfig()));
  let afterSales: AfterSalesStore | undefined;
  let stopMerchant: (() => Promise<void>) | undefined;
  try {
    await store.ping();
    if (process.env.AFTER_SALES_DB_PASSWORD) {
      afterSales = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
      await afterSales.ping();
      stopMerchant = startMockMerchant(afterSales);
    }
    const { modelRuntime, model } = await createConfiguredModelRuntime();
    const secrets = [options.appSecret, process.env.DEEPSEEK_API_KEY, process.env.MODEL_API_KEY, process.env.DB_PASSWORD, process.env.AFTER_SALES_DB_PASSWORD].filter((key): key is string => !!key);
    const redact = (text: string) => secrets.reduce((value, key) => value.replaceAll(key, "[redacted]"), text);
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
    // SDK dedup is in-memory; merchant_requests.order_id independently prevents duplicate tasks across restarts.
    bot.use(messageFilter({ dedup: { windowMs: 5 * 60_000, maxSize: 1000 } }));
    bot.use(mentionGate({ requireMentionInGroup: true, alwaysAnswerC2C: false, passthrough: false }));
    bot.use(sanitizeQQContent);
    const agent = new QQAgent(
      async (msg) => {
        const identity = { appId: options.appId, senderId: msg.senderId };
        if (!await store.resolveCustomer(identity)) {
          const tag = await recordQQIdentity(options.appId, msg);
          console.log(`[qq] 未绑定模拟客户 identity=${tag}；管理员核对发信人后运行 npm run qq:bind -- ${tag} customer-demo-1`);
        }
        return createCouponSession(identity, store, modelRuntime, model, afterSales ? {
          store: afterSales, sourceKey: merchantSourceKey(identity, msg.groupOpenid!),
        } : undefined);
      },
      async (target, text) => {
        const result = await bot.sendText(target, text);
        if (!result.id) throw new Error("QQ 未返回消息 ID");
        console.log("[qq] 回复已被平台接收");
      },
      console.log,
      60_000,
      async (msg) => {
        if (!afterSales) return undefined;
        const identity = { appId: options.appId, senderId: msg.senderId };
        return confirmMerchantMessage(afterSales, identity, merchantSourceKey(identity, msg.groupOpenid!), msg.content);
      },
    );
    bot.on("message", async (_ctx, msg) => {
      await agent.handle(msg);
    });
    bot.on("error", (error) => console.error(`[qq] ${redact(error.message)}`));
    bot.on("ready", () => console.log(`[qq] ${options.transport} 团购券客服已就绪；模型 ${model.provider}/${model.id}；${afterSales ? "模拟商家协商已启用，订单/资金只读" : "只读咨询"}。`));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (!allowedGroups.length) console.log("[qq] QQ_ALLOWED_GROUPS 为空：仅发现群 OpenID，不发送回复。");
    try {
      await bot.start(controller.signal);
    } finally {
      await agent.close();
      bot.stop();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await stopMerchant?.();
    await afterSales?.close();
    await store.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const text = error instanceof Error ? error.message : "QQ 启动失败。";
    const secrets = [process.env.QQBOT_APP_SECRET, process.env.DEEPSEEK_API_KEY, process.env.MODEL_API_KEY, process.env.DB_PASSWORD, process.env.AFTER_SALES_DB_PASSWORD].filter((key): key is string => !!key);
    console.error(secrets.reduce((value, key) => value.replaceAll(key, "[redacted]"), text));
    process.exitCode = 1;
  });
}
