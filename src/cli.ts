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
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, readSupportArchitecture, readSupportContextMode, supportReply } from "./support-session.ts";
import { ConversationStateStore } from "./conversation-state.ts";
import { createKnowledgeService } from "./knowledge-service.ts";
import { readKnowledgeParameters, resolveSupportRunParameters } from "./support-parameters.ts";
import { modelSelections, type ModelSelection } from "./model-selection.ts";
import { createSupportQuestionClient } from "./support-question-client.ts";
import { createArrivalConsultation } from "./arrival-consultation.ts";

export function readCliQuestionOptions(architecture: "atomic" | "controller", env: NodeJS.ProcessEnv = process.env):
  { questionContract: "v2" } | { questionContract: "v3"; modelSelection: ModelSelection; timeoutMs: number } {
  const mode = env.CLI_QUESTION_CONTRACT?.trim() || "v2";
  if (mode !== "v2" && mode !== "v3") throw new Error("CLI_QUESTION_CONTRACT 仅支持 v2 或 v3。");
  const model = env.CLI_QUESTION_MODEL?.trim(), timeout = env.CLI_QUESTION_TIMEOUT_MS?.trim();
  if (mode === "v2") {
    if (model || timeout) throw new Error("CLI咨询解析模型及超时参数仅适用于显式v3候选。");
    return { questionContract: "v2" };
  }
  if (architecture !== "controller") throw new Error("CLI v3咨询候选需要 SUPPORT_ARCHITECTURE=controller。");
  const modelSelection = (model || "deepseek-flash") as ModelSelection;
  if (!modelSelections.includes(modelSelection)) throw new Error(`CLI_QUESTION_MODEL 仅支持 ${modelSelections.join("、")}。`);
  if (timeout && !/^\d+$/u.test(timeout)) throw new Error("CLI_QUESTION_TIMEOUT_MS 应为1000..15000的整数。");
  const timeoutMs = timeout ? Number(timeout) : 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15_000) throw new Error("CLI_QUESTION_TIMEOUT_MS 应为1000..15000的整数。");
  return { questionContract: "v3", modelSelection, timeoutMs };
}

export function parseCliInput(text: string): { kind: "exit" } | { kind: "empty" } | { kind: "message"; text: string } {
  const command = text.trim();
  if (command === "/exit") return { kind: "exit" };
  if (!command) return { kind: "empty" };
  // Trimming is only for local controls; business confirmation sees actual input.
  return { kind: "message", text };
}

export async function runCliPrompt(
  session: AgentSession, text: string, write: (text: string) => Promise<void>,
  afterDeliver?: (reply: Reply) => Promise<void>,
  beforePrompt?: (text: string) => Promise<Reply | undefined>,
) {
  const hostReply = await beforePrompt?.(text);
  if (hostReply !== undefined) {
    await write(`客服：${renderReply(hostReply).text}\n`);
    await afterDeliver?.(hostReply);
    // A read-only rule receipt is history, never consent or an Agent turn.
    try { await session.sendCustomMessage({ customType: "arrival-consultation", content: renderReply(hostReply).text, display: true }, { triggerTurn: false }); }
    catch { /* Delivery already succeeded; do not retry the consultation or send. */ }
    return hostReply;
  }
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
  const questionOptions = readCliQuestionOptions(architecture);
  const contextMode = readSupportContextMode(architecture);
  const parameters = resolveSupportRunParameters(architecture, readKnowledgeParameters());
  const senderId = process.env.CLI_DEMO_USER || "TEST_USER1";
  if (!["TEST_USER1", "TEST_USER2"].includes(senderId)) throw new Error("CLI_DEMO_USER 仅支持 TEST_USER1 或 TEST_USER2 合成身份。");
  const store = new CouponStore(createPool(readDatabaseConfig()));
  const arrival = createArrivalConsultation(store);
  const contexts = contextMode === "mysql" ? new ConversationStateStore(createPool(readAfterSalesDatabaseConfig())) : undefined;
  const knowledge = architecture === "controller" ? createKnowledgeService(store, { mode: parameters.knowledgeMode,
    applicability: parameters.knowledgeApplicability, queryMode: parameters.knowledgeQueryMode, supportProfile: parameters.knowledgeSupport, supportModel: parameters.knowledgeSupportModel, supportPrompt: parameters.knowledgeSupportPrompt, threshold: parameters.knowledgeThreshold, timeoutMs: parameters.knowledgeTimeoutMs }) : undefined;
  const afterSales = process.env.AFTER_SALES_DB_PASSWORD
    ? new AfterSalesStore(createPool(readAfterSalesDatabaseConfig())) : undefined;
  const refunds = process.env.REFUND_DB_PASSWORD ? new RefundStore(createPool(readRefundDatabaseConfig())) : undefined;
  let stopMerchant: (() => Promise<void>) | undefined;
  try {
    await store.ping();
    await contexts?.ping();
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
    const questionResolver = questionOptions.questionContract === "v3" ? await createSupportQuestionClient({
      modelSelection: questionOptions.modelSelection, timeoutMs: questionOptions.timeoutMs }) : undefined;
    const session = architecture === "controller"
      ? await createSupportSession(identity, store, modelRuntime, model, business, { knowledge, context: contexts?.bind(identity, "cli"),
        questionContract: questionOptions.questionContract, questionResolver })
      : await createCouponSession(identity, store, modelRuntime, model, business);
    const input = createInterface({ input: stdin, output: stdout });
    console.log(`团购券客服演示（${senderId}）：券单 COUPON-1001${afterSales ? "；模拟协商 COUPON-2001 / 2002 / 2003" : "，只读咨询"}；输入 /exit 退出。全部是模拟数据。`);
    if (questionResolver) console.log(`显式咨询候选 v3：${questionResolver.settings.provider}/${questionResolver.settings.model}，超时${questionResolver.settings.timeoutMs}ms；每次解析最多增加1个模型请求。v3方案已有有界真实开发对照，完整C1仍未准入；当前配置效果需另行验证。`);
    try {
      while (true) {
        const line = parseCliInput(await input.question("你："));
        if (line.kind === "exit") break;
        if (line.kind === "empty") continue;
        const { text } = line;
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
            refunds ? reply => markRefundReplyPresented(refunds, identity, sourceKey, reply) : undefined,
            text => arrival(identity, text));
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
    finally { await Promise.all([contexts?.close(), refunds?.close(), afterSales?.close(), store.close()]); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "启动失败。");
    process.exitCode = 1;
  });
}
