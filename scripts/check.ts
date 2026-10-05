import assert from "node:assert/strict";
import { createConfiguredModelRuntime, readModelConfig } from "../src/agent.ts";

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

console.log("模型配置检查通过：DeepSeek 默认配置、显式覆盖、运行时密钥与无效模型拒绝。");

await import("./retrieval-check.ts");
await import("./retrieval-context-check.ts");

// Deterministic v2 checks only: faux Pi, in-memory services and mocked provider fetch.
await import("./support-controller-check.ts");
await import("./support-session-check.ts");
await import("./support-clarification-check.ts");
const { checkSupportAmountContext } = await import("./support-amount-context-check.ts");
await checkSupportAmountContext();
await import("./support-host-entry-check.ts");
await import("./support-session-race-check.ts");
await import("./support-evidence-context-check.ts");
const { checkAmountSelectionProbe } = await import("./c1-amount-selection-live.ts");
await checkAmountSelectionProbe();
await import("./support-notification-check.ts");
await import("./support-v2-check.ts");
await import("./retrieval-v2-ranking-check.ts");
await import("./retrieval-v2-check.ts");
const { checkSupportLiveDataset } = await import("./support-v2-live.ts");
await checkSupportLiveDataset();
console.log("v2 live 题集干检查通过；未开启 --live，不连接数据库或调用付费模型。");
const { checkC1SessionRunner } = await import("./c1-session-live.ts");
await checkC1SessionRunner();
const { checkC1ValidationExecutor } = await import("./c1-session-validation-live.ts");
await checkC1ValidationExecutor();
const { checkC1BusinessEvidenceAudit } = await import("./c1-business-evidence-check.ts");
await checkC1BusinessEvidenceAudit();
const { loadC1SupportDevelopment } = await import("./c1-support-check.ts");
await loadC1SupportDevelopment("expanded");
await loadC1SupportDevelopment("language");
