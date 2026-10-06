import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, Type, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  defineTool,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type BeforeProviderRequestEvent,
  type Extension,
  type ExtensionContext,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";
import type { AfterSalesStore } from "./after-sales.ts";
import type { RefundStore } from "./refunds.ts";
import { normalizeBailianGenerationBaseUrl, resolveModelSelection, type ModelSelection } from "./model-selection.ts";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const skillDir = fileURLToPath(new URL("../skills/shop-support", import.meta.url));

export function createModelRuntime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

export function readModelConfig(env: NodeJS.ProcessEnv = process.env, selection: ModelSelection = "configured") {
  const { provider, modelId } = resolveModelSelection(selection, env);
  if (provider === "bailian") {
    if (modelId !== "qwen3.7-plus-2026-05-26") throw new Error("普通百炼生成仅支持固定 qwen3.7-plus-2026-05-26 快照。");
    const apiKey = env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) throw new Error("普通百炼生成请设置 DASHSCOPE_API_KEY；不能复用 MODEL_API_KEY 或 DeepSeek 凭据。");
    normalizeBailianGenerationBaseUrl(env.DASHSCOPE_BASE_URL);
    return { provider, modelId, apiKey };
  }
  const globalProvider = env.MODEL_PROVIDER?.trim() || "deepseek";
  const apiKey = selection === "configured" ? env.MODEL_API_KEY?.trim() || (provider === "deepseek" ? env.DEEPSEEK_API_KEY?.trim() : undefined)
    : env.DEEPSEEK_API_KEY?.trim() || (globalProvider === "deepseek" ? env.MODEL_API_KEY?.trim() : undefined);
  if (!apiKey) throw new Error(provider === "deepseek"
    ? "请设置 DEEPSEEK_API_KEY 或 MODEL_API_KEY；离线验证使用 npm run check。"
    : "请设置 MODEL_API_KEY；离线验证使用 npm run check。");
  return { provider, modelId, apiKey };
}

export async function createConfiguredModelRuntime(env: NodeJS.ProcessEnv = process.env, selection: ModelSelection = "configured") {
  const { provider, modelId, apiKey } = readModelConfig(env, selection);
  const modelRuntime = await createModelRuntime();
  if (provider === "bailian") modelRuntime.registerProvider(provider, {
    api: "openai-completions", baseUrl: normalizeBailianGenerationBaseUrl(env.DASHSCOPE_BASE_URL), apiKey: "DASHSCOPE_API_KEY",
    models: [{ id: modelId, name: "Qwen3.7 Plus 2026-05-26 (Bailian Beijing)", reasoning: true, input: ["text"],
      contextWindow: 1_000_000, maxTokens: 131_072,
      // Pi's catalog assumes USD; NaN preserves unknown USD in memory. Reviewed
      // CNY rates and finite estimates live in model-selection.ts, not this cost.
      cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
      compat: { thinkingFormat: "qwen", supportsReasoningEffort: false, supportsDeveloperRole: false,
        maxTokensField: "max_completion_tokens" } }],
  });
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error(`Pi 模型目录未找到 ${provider}/${modelId}。`);
  // Runtime credential overrides stay in process memory and never write an auth file.
  await modelRuntime.setRuntimeApiKey(provider, apiKey);
  return { modelRuntime, model };
}

export async function createCouponSession(
  identity: QQIdentity, store: CouponStore, modelRuntime: ModelRuntime, model: Model<Api>,
  afterSales?: { store: AfterSalesStore; sourceKey: string; refunds?: RefundStore },
) {
  const [prompt, skill] = await Promise.all([
    readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
  ]);
  // The host loads the only skill, so the model never needs general filesystem access.
  const systemPrompt = `${prompt.trim()}\n\n${skill.trim()}`;
  const skills = loadSkillsFromDir({ dir: skillDir, source: "project" });
  if (skills.skills.length !== 1 || skills.diagnostics.length) throw new Error("客服 Skill 加载失败。");

  const tools: ToolDefinition[] = [
    defineTool({
      name: "search_faq",
      label: "查询模拟团购券规则",
      description: "检索公开团购券规则并返回证据ID及适用门店/套餐。参数仅为query、shopId、productId；不接受orderId。有明确订单的套餐政策问题先get_order确定范围，再使用该结果中的shopId/productId查询；具体退款资格问题每轮重新取证。不传范围只查询通用规则，其空结果不能证明具体套餐无文档。",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        shopId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        productId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }, { additionalProperties: false }),
      execute: async (_id, { query, shopId, productId }) => ({ content: [{ type: "text", text: JSON.stringify(await store.searchKnowledge(query, shopId, productId)) }], details: {} }),
    }),
    defineTool({
      name: "get_order",
      label: "查询本人模拟券单",
      description: "按COUPON-1001格式订单号查询当前QQ身份的模拟团购券订单、门店/套餐范围、核销、付款和历史退款事实。查询具体订单的套餐政策前先用本工具确定FAQ范围。每次用户询问退款资格或金额都重新调用本工具，历史结果只帮助定位订单，不能代替最新用户消息之后的调用；随后查询适用FAQ。指代不清先询问，不猜单。身份由宿主绑定并在每次执行时校验；不能查询他人或修改数据。金额单位为分。",
      parameters: Type.Object({ orderId: Type.String({ pattern: "^COUPON-\\d{4}$" }) }, { additionalProperties: false }),
      execute: async (_id, { orderId }) => ({ content: [{ type: "text", text: JSON.stringify(await store.getOrder(identity, orderId)) }], details: {} }),
    }),
  ];
  if (afterSales) tools.push(
    defineTool({
      name: "prepare_merchant_request",
      label: "准备模拟商家协商",
      description: "调用前须在本轮先get_order，再按该订单的shopId/productId调用search_faq查询适用规则，不能仅查订单就准备协商。本工具只读校验本人可演示协商的订单，返回金额与用户须完整发送的确认文字。不创建任务，不联系真实商家，不退款。reason是用户提供的1–200字单行原因。",
      parameters: Type.Object({
        orderId: Type.String({ pattern: "^COUPON-\\d{4}$" }),
        reason: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      execute: async (_id, { orderId, reason }) => ({
        content: [{ type: "text", text: JSON.stringify(await afterSales.store.prepare(identity, afterSales.sourceKey, orderId, reason)) }], details: {},
      }),
    }),
    defineTool({
      name: "get_merchant_request",
      label: "查询模拟协商进度",
      description: "查询当前用户在当前会话中为本人订单创建的模拟商家协商。无任务返回null；pending仍在等待，approved仅为模拟商家同意，绝不代表已退款。",
      parameters: Type.Object({ orderId: Type.String({ pattern: "^COUPON-\\d{4}$" }) }, { additionalProperties: false }),
      execute: async (_id, { orderId }) => ({
        content: [{ type: "text", text: JSON.stringify(await afterSales.store.getTask(identity, afterSales.sourceKey, orderId) ?? null) }], details: {},
      }),
    }),
  );
  if (afterSales?.refunds) {
    const refunds = afterSales.refunds;
    tools.push(
      defineTool({
        name: "prepare_refund",
        label: "生成模拟退款方案",
        description: "为本人在当前会话已获模拟商家批准的单张未核销券生成整笔退款方案。仅保存待确认方案，不执行退款；金额由业务服务计算，不能传入或修改金额。必须展示操作编号和方案，请用户本人另发确认。",
        parameters: Type.Object({ orderId: Type.String({ pattern: "^COUPON-2\\d{3}$" }) }, { additionalProperties: false }),
        execute: async (_id, { orderId }) => ({ content: [{ type: "text", text: JSON.stringify(await refunds.prepare(identity, afterSales.sourceKey, orderId)) }], details: {} }),
      }),
      defineTool({
        name: "get_refund",
        label: "查询模拟退款状态",
        description: "按订单号查询本人在当前会话的模拟退款操作，重启后仍可查。null为没有方案，prepared未开放确认，awaiting_confirmation等待用户确认，只有succeeded代表模拟退款已完成；没有真实资金到账。",
        parameters: Type.Object({ orderId: Type.String({ pattern: "^COUPON-2\\d{3}$" }) }, { additionalProperties: false }),
        execute: async (_id, { orderId }) => ({ content: [{ type: "text", text: JSON.stringify(await refunds.get(identity, afterSales.sourceKey, orderId) ?? null) }], details: {} }),
      }),
    );
  }
  return createSession(modelRuntime, { ...model, maxTokens: Math.min(model.maxTokens, 2048) }, systemPrompt, tools, skills);
}

export function createQQSession(modelRuntime: ModelRuntime, model: Model<Api>) {
  const systemPrompt = "你是 QQ 通信联调助手。用简洁中文纯文本自然回复用户，每次回复最多 500 字，不输出网址。\n"
    + "当前只验证 QQ 通信和 Agent 工具循环。用户要求回显或测试工具时，调用 echo 并按结果回复。\n"
    + "唯一工具是 echo，它只原样返回文本。不要声称可以查询订单、修改数据或执行系统命令。";
  const tools = [defineTool({
    name: "echo",
    label: "回显通信测试文本",
    description: "原样返回 1–500 字的测试文本，不执行任何操作。",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
    execute: async (_id, { text }) => {
      if (!text.trim() || text.length > 500) throw new Error("回显文本须为 1–500 字。");
      return { content: [{ type: "text", text }], details: {} };
    },
  })];
  return createSession(modelRuntime, { ...model, maxTokens: Math.min(model.maxTokens, 2048) }, systemPrompt, tools, { skills: [], diagnostics: [] });
}

export async function createSession(
  modelRuntime: ModelRuntime, model: Model<Api>, systemPrompt: string,
  tools: ToolDefinition[], skills: ReturnType<ResourceLoader["getSkills"]>,
  beforeStart?: (prompt: string) => Promise<string | undefined>,
  beforeProviderRequest?: (payload: unknown, api: Api | undefined) => unknown,
) {
  const handlers: Extension["handlers"] = new Map([["before_agent_start", [async (event: unknown) => {
    const context = await beforeStart?.((event as { prompt: string }).prompt);
    return { systemPrompt, ...(context ? { message: { customType: "support-context", content: context, display: false } } : {}) };
  }]]]);
  if (beforeProviderRequest) handlers.set("before_provider_request", [async (event, ctx) =>
    beforeProviderRequest((event as BeforeProviderRequestEvent).payload, (ctx as ExtensionContext).model?.api)]);
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [{
        path: "<host-prompt>",
        resolvedPath: "<host-prompt>",
        sourceInfo: createSyntheticSourceInfo("<host-prompt>", { source: "sdk" }),
        handlers,
        tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map(),
      }],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const { session } = await createAgentSession({
    cwd: projectDir,
    agentDir: `${projectDir}.runtime/pi`,
    modelRuntime, model, thinkingLevel: "off",
    tools: tools.map((tool) => tool.name), customTools: tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(projectDir),
    settingsManager: SettingsManager.inMemory({
      // ponytail: short demo sessions only; add business-specific compaction before long-lived QQ sessions.
      compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 },
      cacheWarming: "off",
    }),
  });
  return session;
}
