import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, readModelConfig } from "../src/agent.ts";
import { estimateModelUsage, modelPricing, modelSelections, normalizeBailianGenerationBaseUrl, resolveModelSelection } from "../src/model-selection.ts";

export async function checkModelSelection() {
  assert.deepEqual(modelSelections, ["configured", "deepseek-flash", "deepseek-v4-pro", "qwen3.7-plus-2026-05-26"]);
  assert.deepEqual(resolveModelSelection(undefined, {}), { provider: "deepseek", modelId: "deepseek-flash" });
  assert.deepEqual(resolveModelSelection("configured", { MODEL_PROVIDER: " openai ", MODEL_ID: " gpt-4.1-mini " }),
    { provider: "openai", modelId: "gpt-4.1-mini" });
  assert.deepEqual(resolveModelSelection("configured", { MODEL_PROVIDER: "openai" }), { provider: "openai", modelId: "gpt-4.1-mini" });
  for (const selection of ["deepseek-flash", "deepseek-v4-pro"] as const) {
    assert.deepEqual(resolveModelSelection(selection, { MODEL_PROVIDER: "openai", MODEL_ID: "ignored" }), { provider: "deepseek", modelId: selection });
    assert.equal(readModelConfig({ MODEL_PROVIDER: "openai", MODEL_API_KEY: "other-provider-key", DEEPSEEK_API_KEY: " fixed-deepseek-key " }, selection).apiKey,
      "fixed-deepseek-key");
    assert.throws(() => readModelConfig({ MODEL_PROVIDER: "openai", MODEL_API_KEY: "other-provider-key" }, selection), /DEEPSEEK_API_KEY/);
    assert.throws(() => readModelConfig({ MODEL_PROVIDER: "bailian", MODEL_API_KEY: "other-provider-key", DASHSCOPE_API_KEY: "qwen-key" }, selection), /DEEPSEEK_API_KEY/);
    assert.equal(readModelConfig({ MODEL_API_KEY: "global-deepseek-key" }, selection).apiKey, "global-deepseek-key");
    assert.equal(readModelConfig({ MODEL_PROVIDER: "deepseek", MODEL_API_KEY: "global-key", DEEPSEEK_API_KEY: "dedicated-key" }, selection).apiKey, "dedicated-key");
  }
  for (const selection of [null, 1, "qwen3.7-plus", "deepseek-v4-pro ", "", "unknown"]) {
    assert.throws(() => resolveModelSelection(selection as never, {}), /模型选择/);
    assert.throws(() => readModelConfig({ MODEL_API_KEY: "synthetic" }, selection as never), /模型选择/);
  }
  assert.deepEqual(readModelConfig({ DEEPSEEK_API_KEY: "synthetic-key" }), { provider: "deepseek", modelId: "deepseek-flash", apiKey: "synthetic-key" });
  assert.equal(readModelConfig({ DEEPSEEK_API_KEY: "synthetic-key", MODEL_API_KEY: "synthetic-override" }).apiKey, "synthetic-override");
  assert.throws(() => readModelConfig({}), /DEEPSEEK_API_KEY/);
  assert.throws(() => readModelConfig({ MODEL_PROVIDER: "openai", DEEPSEEK_API_KEY: "wrong-provider-key" }), /MODEL_API_KEY/);
  assert.throws(() => readModelConfig({ MODEL_API_KEY: "wrong-provider-key", DEEPSEEK_API_KEY: "wrong-provider-key" }, "qwen3.7-plus-2026-05-26"), /DASHSCOPE_API_KEY/);
  assert.deepEqual(readModelConfig({ MODEL_PROVIDER: "openai", MODEL_API_KEY: "must-not-route", DASHSCOPE_API_KEY: " synthetic-qwen-key " }, "qwen3.7-plus-2026-05-26"),
    { provider: "bailian", modelId: "qwen3.7-plus-2026-05-26", apiKey: "synthetic-qwen-key" });
  assert.throws(() => readModelConfig({ MODEL_PROVIDER: "bailian", MODEL_ID: "qwen3.7-plus", DASHSCOPE_API_KEY: "synthetic" }), /固定/);
  assert.equal(readModelConfig({ MODEL_PROVIDER: "bailian", MODEL_ID: "qwen3.7-plus-2026-05-26", DASHSCOPE_API_KEY: "synthetic" }).provider, "bailian");

  for (const host of ["dashscope.aliyuncs.com", "workspace.cn-beijing.maas.aliyuncs.com", "12345678.cn-beijing.maas.aliyuncs.com", "workspace-123.cn-beijing.maas.aliyuncs.com"]) {
    for (const path of ["", "/", "/api/v1", "/api/v1/", "/compatible-mode/v1", "/compatible-mode/v1/"]) {
      assert.equal(normalizeBailianGenerationBaseUrl(`https://${host}${path}`), `https://${host}/compatible-mode/v1`);
    }
  }
  assert.equal(normalizeBailianGenerationBaseUrl(), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(normalizeBailianGenerationBaseUrl(" https://DASHSCOPE.aliyuncs.com/api/v1 "), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  for (const url of ["http://dashscope.aliyuncs.com", "https://example.com/api/v1", "https://dashscope-intl.aliyuncs.com",
    "https://workspace.cn-shanghai.maas.aliyuncs.com", "https://workspace.ap-southeast-1.maas.aliyuncs.com", "https://dashscope.aliyuncs.com.evil.test",
    "https://fake-key@dashscope.aliyuncs.com", "https://@dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com:444", "https://dashscope.aliyuncs.com:443", "https://dashscope.aliyuncs.com?",
    "https://nested.workspace.cn-beijing.maas.aliyuncs.com", "https://workspace.cn-beijing.maas.aliyuncs.com.",
    "https://-workspace.cn-beijing.maas.aliyuncs.com", "https://workspace_.cn-beijing.maas.aliyuncs.com",
    "https://%31%32%33.cn-beijing.maas.aliyuncs.com", "https://%64ashscope.aliyuncs.com",
    "https://dashscope.aliyuncs.com/api/v1?key=fake-key", "https://dashscope.aliyuncs.com#", "https://dashscope.aliyuncs.com/unknown",
    "https://dashscope.aliyuncs.com/api/../api/v1", "https://dashscope.aliyuncs.com/api/v1//", "https://dashscope.aliyuncs.com\\evil.test",
    "https://dashscope.aliyuncs.com/api/\nv1", "not-a-url"]) {
    assert.throws(() => normalizeBailianGenerationBaseUrl(url), error => error instanceof Error && error.message.includes("北京 HTTPS") && !error.message.includes("fake-key"));
    assert.throws(() => readModelConfig({ DASHSCOPE_API_KEY: "synthetic", DASHSCOPE_BASE_URL: url }, "qwen3.7-plus-2026-05-26"), /北京 HTTPS/);
  }
  for (const value of [null, 1, {}]) assert.throws(() => normalizeBailianGenerationBaseUrl(value as never));

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls++; throw new Error("Pure configuration checks must never use HTTP"); };
  try {
    const deepseek = await createConfiguredModelRuntime({ MODEL_PROVIDER: "openai", MODEL_API_KEY: "wrong-provider-key", DEEPSEEK_API_KEY: "synthetic-deepseek" }, "deepseek-v4-pro");
    assert.equal(deepseek.model.provider, "deepseek"); assert.equal(deepseek.model.id, "deepseek-v4-pro");
    assert.equal((await deepseek.modelRuntime.getAuth(deepseek.model))!.auth.apiKey, "synthetic-deepseek");
    const qwen = await createConfiguredModelRuntime({ MODEL_PROVIDER: "deepseek", MODEL_API_KEY: "must-not-route", DASHSCOPE_API_KEY: "synthetic-qwen",
      DASHSCOPE_BASE_URL: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1" }, "qwen3.7-plus-2026-05-26");
    assert.equal(qwen.model.api, "openai-completions"); assert.equal(qwen.model.provider, "bailian"); assert.equal(qwen.model.id, "qwen3.7-plus-2026-05-26");
    assert.equal(qwen.model.baseUrl, "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    assert.deepEqual(qwen.model.input, ["text"]); assert.equal(qwen.model.reasoning, true);
    assert.ok(qwen.model.compat && "thinkingFormat" in qwen.model.compat); assert.equal(qwen.model.compat.thinkingFormat, "qwen");
    assert.equal(qwen.model.contextWindow, 1_000_000); assert.equal(qwen.model.maxTokens, 131_072);
    assert.equal(qwen.modelRuntime.getProviderAuthStatus("bailian").source, "runtime");
    assert.equal((await qwen.modelRuntime.getAuth(qwen.model))!.auth.apiKey, "synthetic-qwen");
    assert.equal(qwen.modelRuntime.getRegisteredProviderConfig("bailian")!.apiKey, "DASHSCOPE_API_KEY", "The registration stores a credential name, not the key");
    assert.ok(Object.values(qwen.model.cost).every(Number.isNaN), "Unknown USD is never registered as free or CNY");
    const usage: Usage = { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    calculateCost(qwen.model, usage); assert.ok(Number.isNaN(usage.cost.total));
    assert.deepEqual(estimateModelUsage(qwen.model, usage), { estimatedCostUsd: null, estimatedCostCny: .00039 });
    assert.deepEqual(estimateModelUsage(qwen.model, { ...usage, cost: { total: 99 } }), { estimatedCostUsd: null, estimatedCostCny: .00039 });
    const pricing = modelPricing(qwen.model); assert.equal(pricing.currency, "CNY");
    assert.ok(pricing.currency === "CNY" && pricing.region === "cn-beijing" && pricing.inputTierMaxTokens === 256000 && !pricing.cacheDiscounts);
    pricing.rates.input = 999; assert.equal(modelPricing(qwen.model).rates.input, 2, "Pricing snapshots do not mutate shared rates");
    const legacy = modelPricing(deepseek.model); assert.equal(legacy.currency, "USD");
    assert.throws(() => modelPricing({ ...qwen.model, id: "unknown-qwen" }), /价格只审阅/);
    legacy.rates.input = 999; assert.notEqual(deepseek.model.cost.input, 999);
    assert.deepEqual(estimateModelUsage(deepseek.model, { ...usage, cost: { total: 0 } }), { estimatedCostUsd: 0, estimatedCostCny: null });
    assert.deepEqual(estimateModelUsage(deepseek.model, { ...usage, cost: { total: .01 } }), { estimatedCostUsd: .01, estimatedCostCny: null });
    assert.deepEqual(estimateModelUsage(deepseek.model, { ...usage, cost: undefined }), { estimatedCostUsd: null, estimatedCostCny: null });
    assert.deepEqual(estimateModelUsage(qwen.model, { input: 256000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 256000 }),
      { estimatedCostUsd: null, estimatedCostCny: .512 });
    const unknown = { estimatedCostUsd: null, estimatedCostCny: null };
    for (const invalid of [null, undefined, {}, { ...usage, input: null }, { ...usage, output: undefined }, { ...usage, cacheRead: -1 },
      { ...usage, totalTokens: 0 }, { ...usage, totalTokens: 134 }, { ...usage, input: NaN }, { ...usage, output: Infinity }, { ...usage, cacheWrite: .5 },
      { input: 256001, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 256001 },
      { input: 250000, output: 1, cacheRead: 6001, cacheWrite: 0, totalTokens: 256002 }]) assert.deepEqual(estimateModelUsage(qwen.model, invalid), unknown);
    await assert.rejects(createConfiguredModelRuntime({ DEEPSEEK_API_KEY: "synthetic", MODEL_ID: "not-a-model" }), /模型目录未找到/);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
  console.log("[model-selection] bounded choices, configured compatibility, role-specific credential isolation, strict Beijing endpoint, in-memory Pi registration and honest USD/CNY/unknown estimates PASS; 0 remote/DB/QQ, no .env read.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkModelSelection();
