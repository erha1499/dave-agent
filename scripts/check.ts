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
