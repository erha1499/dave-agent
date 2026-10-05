import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { createPool } from "mysql2/promise";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createConfiguredModelRuntime, createCouponSession } from "./agent.ts";
import { CouponStore, readDatabaseConfig } from "./coupon-store.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig, startMockMerchant } from "./after-sales.ts";
import { confirmMerchantReply, merchantSourceKey } from "./after-sales-entry.ts";
import { RefundStore, readRefundDatabaseConfig } from "./refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "./refund-entry.ts";
import { renderReply, type Reply } from "./reply.ts";
import { replyFromTools } from "./reply-from-tools.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, readSupportArchitecture, supportReply } from "./support-session.ts";
import { createKnowledgeService } from "./knowledge-service.ts";
import { readKnowledgeParameters, resolveSupportRunParameters } from "./support-parameters.ts";

export async function runCliPrompt(
  session: AgentSession, text: string, write: (text: string) => Promise<void>,
  afterDeliver?: (reply: Reply) => Promise<void>,
) {
  const previous = session.messages.length;
  const requestId = randomUUID();
  prepareSupportPrompt(session, { requestId, groupOpenid: "cli", messageId: requestId });
  let modelFailed = false;
  try {
    await session.prompt(text, { expandPromptTemplates: false });
    if (!getSupportHostReceipt(session) && session.agent.state.errorMessage) throw new Error("模型请求失败。");
  } catch {
    modelFailed = true;
    cancelSupportTurn(session);
    await session.abort();
    if (!getSupportResult(session)) throw new Error("模型请求失败，请检查模型配置或稍后重试。");
  }
  const results = session.messages.slice(previous).flatMap(message => message.role === "toolResult" ? [message] : []);
  const assistantText = modelFailed ? "" : session.getLastAssistantText() ?? "未生成回复，请重试。";
  const reply = supportReply(session, assistantText) ?? replyFromTools(assistantText, results);
  // Delivery failures do not re-enter the model fallback or retry any business action.
  await write(`客服：${renderReply(reply).text}\n`);
  await afterDeliver?.(reply);
  return reply;
}

async function main() {
  const architecture = readSupportArchitecture();
  const parameters = resolveSupportRunParameters(architecture, readKnowledgeParameters());
  const senderId = process.env.CLI_DEMO_USER || "TEST_USER1";
  if (!["TEST_USER1", "TEST_USER2"].includes(senderId)) throw new Error("CLI_DEMO_USER 仅支持 TEST_USER1 或 TEST_USER2 合成身份。");
  const store = new CouponStore(createPool(readDatabaseConfig()));
  const knowledge = architecture === "controller" ? createKnowledgeService(store, { mode: parameters.knowledgeMode,
    applicability: parameters.knowledgeApplicability, supportProfile: parameters.knowledgeSupport, supportModel: parameters.knowledgeSupportModel, threshold: parameters.knowledgeThreshold, timeoutMs: parameters.knowledgeTimeoutMs }) : undefined;
  const afterSales = process.env.AFTER_SALES_DB_PASSWORD
    ? new AfterSalesStore(createPool(readAfterSalesDatabaseConfig())) : undefined;
  const refunds = process.env.REFUND_DB_PASSWORD ? new RefundStore(createPool(readRefundDatabaseConfig())) : undefined;
  let stopMerchant: (() => Promise<void>) | undefined;
  try {
    await store.ping();
    if (refunds && !afterSales) throw new Error("模拟退款需要先配置商家协商数据库。");
    await refunds?.ping();
    if (afterSales) {
      await afterSales.ping();
      stopMerchant = startMockMerchant(afterSales);
    }
    const { modelRuntime, model } = await createConfiguredModelRuntime();
    const identity = { appId: "TEST_APP", senderId };
    const sourceKey = merchantSourceKey(identity, "cli");
    const business = afterSales ? { store: afterSales, sourceKey, refunds } : undefined;
    const session = architecture === "controller"
      ? await createSupportSession(identity, store, modelRuntime, model, business, { knowledge })
      : await createCouponSession(identity, store, modelRuntime, model, business);
    const input = createInterface({ input: stdin, output: stdout });
    console.log(`团购券客服演示（${senderId}）：券单 COUPON-1001${afterSales ? "；模拟协商 COUPON-2001 / 2002 / 2003" : "，只读咨询"}；输入 /exit 退出。全部是模拟数据。`);
    try {
      while (true) {
        const text = (await input.question("你：")).trim();
        if (text === "/exit") break;
        if (!text) continue;
        try {
          const confirmation = (refunds ? await confirmRefundReply(refunds, identity, sourceKey, text) : undefined)
            ?? (afterSales ? await confirmMerchantReply(afterSales, identity, sourceKey, text) : undefined);
          if (confirmation !== undefined) {
            const receipt = renderReply(confirmation).text;
            await session.sendCustomMessage({ customType: "business-receipt", content: receipt, display: true }, { triggerTurn: false });
            console.log(`客服：${receipt}`);
            continue;
          }
          await runCliPrompt(session, text,
            output => new Promise<void>((resolve, reject) => stdout.write(output, error => error ? reject(error) : resolve())),
            refunds ? reply => markRefundReplyPresented(refunds, identity, sourceKey, reply) : undefined);
        } catch (error) {
          console.error(error instanceof Error ? error.message : "本轮处理失败。");
        }
      }
    } finally {
      input.close();
      session.dispose();
    }
  } finally {
    try { await stopMerchant?.(); }
    finally { await Promise.all([refunds?.close(), afterSales?.close(), store.close()]); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "启动失败。");
    process.exitCode = 1;
  });
}
