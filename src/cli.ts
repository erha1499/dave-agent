import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createModelRuntime, createSupportSession } from "./agent.ts";

async function main() {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("请设置 MODEL_API_KEY；离线验证使用 npm run check。");
  const provider = process.env.MODEL_PROVIDER ?? "openai";
  const modelId = process.env.MODEL_ID ?? "gpt-4.1-mini";
  const runtime = await createModelRuntime();
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`Pi 模型目录未找到 ${provider}/${modelId}。`);
  await runtime.setRuntimeApiKey(provider, apiKey);
  const session = await createSupportSession(process.env.CUSTOMER_ID ?? "demo-customer-1", runtime, model);
  const input = createInterface({ input: stdin, output: stdout });
  console.log("电商客服演示：FAQ / 订单 DEMO-1001；输入 /exit 退出。订单均为模拟数据。");
  try {
    while (true) {
      const text = (await input.question("你：")).trim();
      if (text === "/exit") break;
      if (!text) continue;
      try {
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "启动失败。");
  process.exitCode = 1;
});
