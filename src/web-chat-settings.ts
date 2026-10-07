import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createCouponSession, createModelRuntime, readModelConfig } from "./agent.ts";
import { modelSelections, resolveModelSelection, type ModelSelection } from "./model-selection.ts";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";

export type WebChatSettings = { modelSelection: ModelSelection; thinkingLevel: "off" | "high"; maxTokens: 512 | 1024 | 2048 };
export type WebChatModelOption = { id: ModelSelection; label: string; provider: string; modelId: string; available: boolean; supportsThinking: boolean };
export type WebChatSettingsCatalog = { defaults: WebChatSettings; models: WebChatModelOption[];
  options: { thinkingLevels: ["off", "high"]; maxTokens: [512, 1024, 2048] }; evaluationUrl: string;
  metadata: Partial<Record<ModelSelection, Model<Api>>> };
const labels: Record<ModelSelection, string> = { configured: "当前默认模型", "deepseek-flash": "DeepSeek Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro", "qwen3.7-plus-2026-05-26": "Qwen 3.7 Plus" };

export async function createWebChatSettingsCatalog(env: NodeJS.ProcessEnv = {}) {
  const evaluationPort = env.EVAL_PORT ?? "3001";
  if (!/^\d{4,5}$/u.test(evaluationPort) || Number(evaluationPort) < 1024 || Number(evaluationPort) > 65535)
    throw new Error("EVAL_PORT 无效。");
  const runtime = await createModelRuntime();
  const catalog: WebChatSettingsCatalog = { defaults: { modelSelection: "configured", thinkingLevel: "off", maxTokens: 2048 },
    models: [], options: { thinkingLevels: ["off", "high"], maxTokens: [512, 1024, 2048] },
    evaluationUrl: `http://127.0.0.1:${evaluationPort}/`, metadata: {} };
  for (const selection of modelSelections) {
    const resolved = resolveModelSelection(selection, env);
    let model: Model<Api> | undefined = runtime.getModel(resolved.provider, resolved.modelId);
    if (resolved.provider === "bailian") {
      // Reuse the reviewed registration for metadata; offline runtime credentials are never persisted or sent.
      try { model = (await createConfiguredModelRuntime({ ...env, DASHSCOPE_API_KEY: "offline-catalog-only" }, selection)).model; }
      catch { model = undefined; }
    }
    let available = false;
    try { readModelConfig(env, selection); available = !!model; } catch { /* Only availability is public. */ }
    if (model) catalog.metadata[selection] = model;
    catalog.models.push({ id: selection, label: labels[selection], provider: resolved.provider, modelId: resolved.modelId,
      available, supportsThinking: !!model && getSupportedThinkingLevels(model).includes("high") });
  }
  return catalog;
}

export function validateWebChatSettings(value: unknown, catalog: WebChatSettingsCatalog): WebChatSettings {
  const explicit = value !== undefined, input = explicit ? value : catalog.defaults;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("模型设置必须是完整对象。");
  const settings = input as Record<string, unknown>;
  if (Object.keys(settings).length !== 3 || Object.keys(settings).some(key => !["modelSelection", "thinkingLevel", "maxTokens"].includes(key))
    || typeof settings.modelSelection !== "string" || !modelSelections.includes(settings.modelSelection as ModelSelection)
    || typeof settings.thinkingLevel !== "string" || !["off", "high"].includes(settings.thinkingLevel)
    || ![512, 1024, 2048].includes(settings.maxTokens as number)) throw new Error("模型设置须包含允许的模型、推理模式及整数输出上限。");
  const model = catalog.models.find(row => row.id === settings.modelSelection)!;
  const metadata = catalog.metadata[model.id];
  if (!metadata || Number(settings.maxTokens) > metadata.maxTokens) throw new Error("该模型不支持所选输出配置。");
  if (!getSupportedThinkingLevels(metadata).includes(settings.thinkingLevel as "off" | "high"))
    throw new Error(settings.thinkingLevel === "high" ? "该模型不支持开启推理。" : "该模型不支持关闭推理。");
  if (explicit && !model.available) throw new Error("该模型当前不可用，请在服务端配置有效凭据。");
  return { modelSelection: model.id, thinkingLevel: settings.thinkingLevel as "off" | "high", maxTokens: settings.maxTokens as WebChatSettings["maxTokens"] };
}

export function createWebChatAgentFactory(store: CouponStore, env: NodeJS.ProcessEnv) {
  const configuredEnv = { ...env };
  const runtimes = new Map<ModelSelection, Promise<Awaited<ReturnType<typeof createConfiguredModelRuntime>>>>();
  return async (identity: QQIdentity, _id: string, settings: WebChatSettings) => {
    let runtime = runtimes.get(settings.modelSelection);
    if (!runtime) { runtime = createConfiguredModelRuntime(configuredEnv, settings.modelSelection); runtimes.set(settings.modelSelection, runtime); }
    const configured = await runtime;
    const session = await createCouponSession(identity, store, configured.modelRuntime, { ...configured.model, maxTokens: settings.maxTokens });
    session.setThinkingLevel(settings.thinkingLevel);
    if (session.thinkingLevel !== settings.thinkingLevel || session.model?.maxTokens !== settings.maxTokens) {
      session.dispose(); throw new Error("所选模型参数未实际生效。");
    }
    return session;
  };
}
