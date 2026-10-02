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
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const skillDir = fileURLToPath(new URL("../skills/shop-support", import.meta.url));

const faq = [
  { id: "FAQ-SHIPPING", keywords: ["发货", "物流", "配送", "快递"], answer: "测试店铺的现货订单通常在付款后 48 小时内发货；实际进度以订单查询结果为准。" },
  { id: "FAQ-RETURN", keywords: ["退货", "退款", "售后"], answer: "测试店铺支持联系客服申请售后；需要订单号、问题描述。当前助手只能说明流程，不能提交退款或修改订单。" },
  { id: "FAQ-INVOICE", keywords: ["发票", "开票"], answer: "测试店铺可由人工客服登记开票需求；请说明订单号与发票类型，不要在群聊发送完整身份证号或银行卡号。" },
];

const orders = [
  { id: "DEMO-1001", customerId: "demo-customer-1", status: "已发货", item: "演示帆布包", carrier: "演示快递", tracking: "DEMO-TRACK-001" },
  { id: "DEMO-1002", customerId: "demo-customer-2", status: "待发货", item: "演示水杯", carrier: null, tracking: null },
];

export function searchFaq(query: string) {
  if (!query.trim() || query.length > 500) throw new Error("请输入 1–500 字的 FAQ 查询。");
  // ponytail: keyword matching covers the three demo FAQs; add retrieval when a real corpus is available.
  return faq.filter((entry) => entry.keywords.some((word) => query.includes(word)))
    .map(({ id, answer }) => ({ source: "demo-faq", id, answer }));
}

export function getOrder(customerId: string, orderId: string) {
  if (!/^DEMO-\d{4}$/.test(orderId)) throw new Error("演示订单号格式为 DEMO-1001。");
  const order = orders.find((entry) => entry.id === orderId && entry.customerId === customerId);
  if (!order) throw new Error("未找到当前客户可查询的订单，请核对订单号或联系人工客服。");
  const { customerId: _owner, ...details } = order;
  return { source: "demo-order", ...details };
}

export function createModelRuntime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

export async function createSupportSession(customerId: string, modelRuntime: ModelRuntime, model: Model<Api>) {
  if (!/^[a-z0-9-]{1,64}$/.test(customerId)) throw new Error("无效的演示客户身份。");
  const [prompt, skill] = await Promise.all([
    readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
  ]);
  // The host loads the only skill, so the model never needs general filesystem access.
  const systemPrompt = `${prompt.trim()}\n\n${skill.trim()}`;
  const skills = loadSkillsFromDir({ dir: skillDir, source: "project" });
  if (skills.skills.length !== 1 || skills.diagnostics.length) throw new Error("客服 Skill 加载失败。");

  const tools = [
    defineTool({
      name: "search_faq",
      label: "查询测试店铺 FAQ",
      description: "检索测试店铺发货、售后、发票 FAQ，返回答案和证据 ID；无匹配时返回空列表。",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      execute: async (_id, { query }) => ({ content: [{ type: "text", text: JSON.stringify(searchFaq(query)) }], details: {} }),
    }),
    defineTool({
      name: "get_order",
      label: "查询当前演示客户订单",
      description: "按 DEMO-1001 格式订单号查询当前客户的模拟订单。身份由宿主绑定；不能查询其他客户，不能修改订单。",
      parameters: Type.Object({ orderId: Type.String({ pattern: "^DEMO-\\d{4}$" }) }, { additionalProperties: false }),
      execute: async (_id, { orderId }) => ({ content: [{ type: "text", text: JSON.stringify(getOrder(customerId, orderId)) }], details: {} }),
    }),
  ];

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({
      extensions: [{
        path: "<customer-service-prompt>",
        resolvedPath: "<customer-service-prompt>",
        sourceInfo: createSyntheticSourceInfo("<customer-service-prompt>", { source: "sdk" }),
        handlers: new Map([["before_agent_start", [async () => ({ systemPrompt })]]]),
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
