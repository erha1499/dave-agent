import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";

export const modelSelections = ["configured", "deepseek-flash", "deepseek-v4-pro", "qwen3.7-plus-2026-05-26"] as const;
export type ModelSelection = typeof modelSelections[number];

export function resolveModelSelection(selection: ModelSelection = "configured", env: NodeJS.ProcessEnv = process.env) {
  if (!modelSelections.includes(selection)) throw new Error("模型选择仅支持 configured、deepseek-flash、deepseek-v4-pro、qwen3.7-plus-2026-05-26。");
  if (selection === "qwen3.7-plus-2026-05-26") return { provider: "bailian", modelId: selection };
  if (selection !== "configured") return { provider: "deepseek", modelId: selection };
  const provider = env.MODEL_PROVIDER?.trim() || "deepseek";
  return { provider, modelId: env.MODEL_ID?.trim() || (provider === "deepseek" ? "deepseek-flash" : "gpt-4.1-mini") };
}

export function normalizeBailianGenerationBaseUrl(value?: string) {
  const invalid = () => new Error("DASHSCOPE_BASE_URL 仅支持已审阅的北京 HTTPS 原点、/api/v1 或 /compatible-mode/v1，不支持凭据、其他路径、查询或片段。");
  if (value !== undefined && typeof value !== "string") throw invalid();
  const input = value?.trim() || "https://dashscope.aliyuncs.com";
  if (/[\\\s\u0000-\u001f\u007f?#@]/u.test(input)) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  const authority = /^https:\/\/([^/]+)(\/.*)?$/iu.exec(input), path = authority?.[2] ?? "";
  const beijingWorkspace = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/iu.test(url.hostname);
  if (url.protocol !== "https:" || !authority || url.hostname !== authority[1]!.toLowerCase() || url.port || url.hostname !== "dashscope.aliyuncs.com" && !beijingWorkspace
    || !["", "/", "/api/v1", "/api/v1/", "/compatible-mode/v1", "/compatible-mode/v1/"].includes(path)) throw invalid();
  return `${url.origin}/compatible-mode/v1`;
}

type PricingModel = Pick<Model<Api>, "provider" | "id" | "cost">;
export type ModelPricing = { currency: "USD"; estimated: true; source: "Pi model catalog"; rates: ModelCost }
  | { currency: "CNY"; estimated: true; source: "Alibaba Cloud Model Studio"; rates: ModelCost;
    version: "bailian-beijing-2026-10-06-v1"; region: "cn-beijing"; inputTierMaxTokens: 256000; cacheDiscounts: false };
export function modelPricing(model: PricingModel): ModelPricing {
  if (model.provider === "bailian" && model.id !== "qwen3.7-plus-2026-05-26") throw new Error("百炼价格只审阅固定 qwen3.7-plus-2026-05-26 快照。");
  if (model.provider === "bailian") return {
    currency: "CNY", estimated: true, source: "Alibaba Cloud Model Studio", version: "bailian-beijing-2026-10-06-v1",
    region: "cn-beijing", inputTierMaxTokens: 256000, cacheDiscounts: false,
    // Reviewed Beijing <=256k original rates; cache tokens use full price as a
    // conservative estimate, not a cache-discount or actual-bill claim.
    rates: { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 },
  };
  return { currency: "USD", estimated: true, source: "Pi model catalog", rates: structuredClone(model.cost) };
}
type Usage = { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown;
  totalTokens?: unknown; cost?: { total?: unknown } | null };
export function estimateModelUsage(model: PricingModel, usage: Usage | null | undefined): {
  estimatedCostUsd: number | null; estimatedCostCny: number | null;
} {
  const unknown = { estimatedCostUsd: null, estimatedCostCny: null };
  if (!usage) return unknown;
  const tokens = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
  if (!tokens.every((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0) || !tokens[4]) return unknown;
  const input = tokens[0]!, output = tokens[1]!, cacheRead = tokens[2]!, cacheWrite = tokens[3]!, totalTokens = tokens[4]!;
  const inputTokens = input + cacheRead + cacheWrite;
  if (inputTokens + output !== totalTokens) return unknown;
  const pricing = modelPricing(model);
  if (pricing.currency === "USD") {
    const cost = usage.cost?.total;
    return { ...unknown, estimatedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null };
  }
  if (inputTokens > pricing.inputTierMaxTokens) return unknown;
  return { ...unknown, estimatedCostCny: (input * pricing.rates.input + output * pricing.rates.output
    + cacheRead * pricing.rates.cacheRead + cacheWrite * pricing.rates.cacheWrite) / 1_000_000 };
}
