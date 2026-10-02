import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createPool } from "mysql2/promise";
import { createConfiguredModelRuntime, createCouponSession } from "./agent.ts";
import { CouponStore, readDatabaseConfig } from "./coupon-store.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig, startMockMerchant } from "./after-sales.ts";
import { confirmMerchantMessage, merchantSourceKey } from "./after-sales-entry.ts";

async function main() {
  const senderId = process.env.CLI_DEMO_USER || "TEST_USER1";
  if (!["TEST_USER1", "TEST_USER2"].includes(senderId)) throw new Error("CLI_DEMO_USER 仅支持 TEST_USER1 或 TEST_USER2 合成身份。");
  const store = new CouponStore(createPool(readDatabaseConfig()));
  const afterSales = process.env.AFTER_SALES_DB_PASSWORD
    ? new AfterSalesStore(createPool(readAfterSalesDatabaseConfig())) : undefined;
  let stopMerchant: (() => Promise<void>) | undefined;
  try {
    await store.ping();
    if (afterSales) {
      await afterSales.ping();
      stopMerchant = startMockMerchant(afterSales);
    }
    const { modelRuntime, model } = await createConfiguredModelRuntime();
    const identity = { appId: "TEST_APP", senderId };
    const sourceKey = merchantSourceKey(identity, "cli");
    const session = await createCouponSession(identity, store, modelRuntime, model, afterSales ? { store: afterSales, sourceKey } : undefined);
    const input = createInterface({ input: stdin, output: stdout });
    console.log(`团购券客服演示（${senderId}）：券单 COUPON-1001${afterSales ? "；模拟协商 COUPON-2001 / 2002 / 2003" : "，只读咨询"}；输入 /exit 退出。全部是模拟数据。`);
    try {
      while (true) {
        const text = (await input.question("你：")).trim();
        if (text === "/exit") break;
        if (!text) continue;
        try {
          const confirmation = afterSales ? await confirmMerchantMessage(afterSales, identity, sourceKey, text) : undefined;
          if (confirmation !== undefined) {
            await session.sendCustomMessage({ customType: "merchant-receipt", content: confirmation, display: true }, { triggerTurn: false });
            console.log(`客服：${confirmation}`);
            continue;
          }
          await session.prompt(text, { expandPromptTemplates: false });
          if (session.agent.state.errorMessage) throw new Error("模型请求失败，请检查模型配置或稍后重试。");
          console.log(`客服：${session.getLastAssistantText() ?? "未生成回复，请重试。"}`);
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
    finally { await Promise.all([afterSales?.close(), store.close()]); }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "启动失败。");
  process.exitCode = 1;
});
