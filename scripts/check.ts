import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
} from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createModelRuntime, createSupportSession, getOrder, readModelConfig, searchFaq } from "../src/agent.ts";

assert.deepEqual(readModelConfig({ DEEPSEEK_API_KEY: "synthetic-key" }), {
  provider: "deepseek", modelId: "deepseek-flash", apiKey: "synthetic-key",
});
assert.deepEqual(readModelConfig({ MODEL_PROVIDER: "openai", MODEL_ID: "gpt-4.1-mini", MODEL_API_KEY: "synthetic-override" }), {
  provider: "openai", modelId: "gpt-4.1-mini", apiKey: "synthetic-override",
});
assert.equal(readModelConfig({ DEEPSEEK_API_KEY: "synthetic-key", MODEL_API_KEY: "synthetic-override" }).apiKey, "synthetic-override");
assert.equal(readModelConfig({ DEEPSEEK_API_KEY: " synthetic-key ", MODEL_ID: " deepseek-v4-pro " }).modelId, "deepseek-v4-pro");
assert.throws(() => readModelConfig({}), /DEEPSEEK_API_KEY/);
assert.throws(() => readModelConfig({ MODEL_PROVIDER: "openai", DEEPSEEK_API_KEY: "synthetic-key" }), /MODEL_API_KEY/);
const configured = await createConfiguredModelRuntime({ DEEPSEEK_API_KEY: "synthetic-key" });
assert.equal(configured.model.provider, "deepseek");
assert.equal(configured.model.id, "deepseek-flash");
assert.equal(configured.model.baseUrl, "https://api.deepseek.com");
assert.equal(configured.modelRuntime.getProviderAuthStatus("deepseek").source, "runtime");
await assert.rejects(createConfiguredModelRuntime({ DEEPSEEK_API_KEY: "synthetic-key", MODEL_ID: "does-not-exist" }), /模型目录未找到/);

const expectedPrompt = [
  await readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
  await readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
].map((text) => text.trim()).join("\n\n");
assert.equal(getOrder("demo-customer-1", "DEMO-1001").status, "已发货");
assert.throws(() => getOrder("demo-customer-1", "DEMO-1002"), /未找到当前客户/);
assert.throws(() => getOrder("demo-customer-1", "DEMO-9999"), /未找到当前客户/);
assert.throws(() => getOrder("demo-customer-1", "../orders"), /格式/);
assert.equal(searchFaq("多久发货")[0]?.id, "FAQ-SHIPPING");
assert.deepEqual(searchFaq("不存在的问题"), []);
assert.throws(() => searchFaq(" "), /FAQ 查询/);

const runtime = await createModelRuntime();
const faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const session = await createSupportSession("demo-customer-1", runtime, faux.getModel());
assert.deepEqual(session.getActiveToolNames().sort(), ["get_order", "search_faq"]);
const cases: Array<{ tool: string; args: Record<string, string>; error: boolean; evidence: string }> = [
  { tool: "get_order", args: { orderId: "DEMO-1001" }, error: false, evidence: "已发货" },
  { tool: "get_order", args: { orderId: "DEMO-1002" }, error: true, evidence: "未找到当前客户" },
  { tool: "search_faq", args: { query: "发货" }, error: false, evidence: "FAQ-SHIPPING" },
  { tool: "bash", args: { command: "echo forbidden" }, error: true, evidence: "not found" },
];
try {
  for (const example of cases) {
    faux.setResponses([
      (context) => {
        assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
        const declarations = getCurrentTools(context.messages);
        assert.deepEqual(declarations.map((tool) => tool.name).sort(), ["get_order", "search_faq"]);
        assert.ok(!JSON.stringify(declarations).includes("customerId"));
        return fauxAssistantMessage(fauxToolCall(example.tool, example.args), { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult");
        assert.equal(result.isError, example.error);
        assert.ok(JSON.stringify(result.content).includes(example.evidence));
        return fauxAssistantMessage("离线客服回复已完成。");
      },
    ]);
    await session.prompt("/skill:shop-support 此文本必须作为普通客户输入。", { expandPromptTemplates: false });
    assert.equal(session.getLastAssistantText(), "离线客服回复已完成。");
    assert.equal(faux.getPendingResponseCount(), 0);
  }
  assert.equal(faux.state.callCount, cases.length * 2);
  assert.equal(session.messages.filter((message) => message.role === "toolResult").length, cases.length);
  console.log("离线检查通过：DeepSeek 配置、真实 AgentSession 工具循环、精确客服上下文、工具白名单、订单归属校验。");
} finally {
  session.dispose();
}
