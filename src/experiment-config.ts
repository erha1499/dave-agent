import { resolveSupportParameters, resolveSupportRunParameters, type SupportExperimentParameters } from "./support-parameters.ts";
import { resolveRetrievalParameters, type RetrievalExperimentParameters } from "./retrieval-ranking.ts";
import { resolveEvidenceAcceptance, type EvidenceAcceptanceConfig } from "./evidence-acceptance.ts";

export const experimentModes = ["M0", "M1", "M2", "M3", "M4", "M5", "M6"] as const;
export type SupportVariant = { id: string; architecture: "atomic" | "controller"; parameters: SupportExperimentParameters };
export const experimentDatasets = ["legacy", "acceptance-development", "acceptance-validation", "acceptance-support-validation"] as const;
type RetrievalV1Variant = { id: string; modes: Array<typeof experimentModes[number]>; parameters: RetrievalExperimentParameters };
export type RetrievalV2Variant = RetrievalV1Variant & { dataset: typeof experimentDatasets[number]; acceptance: EvidenceAcceptanceConfig };
export type RetrievalVariant = RetrievalV1Variant | RetrievalV2Variant;
type Common = { label: string; repeat: number; allowRemote: boolean };
export type ExperimentConfig = Common & ({ version: 1; kind: "support"; variants: SupportVariant[] }
  | { version: 1; kind: "retrieval"; variants: RetrievalV1Variant[] } | { version: 2; kind: "retrieval"; variants: RetrievalV2Variant[] });
export class ExperimentInputError extends Error {}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ExperimentInputError("实验配置含未知字段或不是对象。");
}

// The same whitelist resolves CLI files and HTTP requests. No arbitrary commands, env, paths or credentials.
export function resolveExperimentConfig(value: unknown): ExperimentConfig {
  keys(value, ["version", "kind", "label", "repeat", "allowRemote", "variants"]);
  if ((value.version !== 1 && value.version !== 2) || (value.kind !== "support" && value.kind !== "retrieval")
    || (value.version === 2 && value.kind !== "retrieval")
    || typeof value.label !== "string" || !value.label.trim() || value.label.trim().length > 80 || /[\p{Cc}\p{Cf}]/u.test(value.label)
    || !Number.isInteger(value.repeat) || Number(value.repeat) < 1 || Number(value.repeat) > 3 || typeof value.allowRemote !== "boolean"
    || !Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 2) throw new ExperimentInputError("请选择实验类型、名称、1–3 次重复和 1–2 个方案。");
  const common = { version: value.version, label: value.label.trim(), repeat: Number(value.repeat), allowRemote: value.allowRemote };
  const ids = new Set<string>();
  const variants = value.variants.map(item => {
    keys(item, value.kind === "support" ? ["id", "architecture", "parameters"]
      : value.version === 2 ? ["id", "modes", "parameters", "dataset", "acceptance"] : ["id", "modes", "parameters"]);
    if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(item.id) || ids.has(item.id)) throw new ExperimentInputError("方案 ID 应为唯一的字母、数字或短横线标识。");
    ids.add(item.id);
    if (item.parameters !== undefined && !record(item.parameters)) throw new ExperimentInputError("参数必须为对象。");
    try {
      if (value.kind === "support") {
        if (item.architecture !== "atomic" && item.architecture !== "controller") throw new Error();
        const parameters = resolveSupportParameters(item.parameters);
        resolveSupportRunParameters(item.architecture, parameters);
        return { id: item.id, architecture: item.architecture, parameters };
      }
      if (!Array.isArray(item.modes) || !item.modes.length || item.modes.length > 7 || new Set(item.modes).size !== item.modes.length
        || item.modes.some(mode => !experimentModes.includes(mode))) throw new Error();
      const variant: RetrievalV1Variant = { id: item.id, modes: [...item.modes], parameters: resolveRetrievalParameters(item.parameters) };
      if (value.version === 1) return variant;
      if (!experimentDatasets.includes(item.dataset as typeof experimentDatasets[number]) || !record(item.acceptance)) throw new Error();
      return { ...variant, dataset: item.dataset, acceptance: resolveEvidenceAcceptance(item.acceptance, variant.modes) };
    } catch { throw new ExperimentInputError(`方案 ${item.id} 的模式或参数无效，请按表单范围填写。`); }
  });
  if (value.kind === "support") return { ...common, version: 1, kind: "support", variants: variants as SupportVariant[] };
  return value.version === 1 ? { ...common, version: 1, kind: "retrieval", variants: variants as RetrievalV1Variant[] }
    : { ...common, version: 2, kind: "retrieval", variants: variants as RetrievalV2Variant[] };
}
export const remoteRequired = (config: ExperimentConfig) => config.kind === "support"
  || config.variants.some(variant => variant.modes.some(mode => mode !== "M0" && mode !== "M1"));
export function requireExperimentExecution(config: ExperimentConfig) {
  if (remoteRequired(config) && !config.allowRemote) throw new ExperimentInputError("该实验调用付费模型，请先启用“允许本次远程模型调用”。");
}

type Field = { key: string; label: string; type: "number" | "select"; min?: number; max?: number; step?: number;
  options?: Array<{ value: string; label: string }>; note?: string };
export const experimentFields: Record<"support" | "retrieval", Field[]> = {
  support: [
    { key: "timeoutMs", label: "每轮超时（ms）", type: "number", min: 10000, max: 120000, step: 1000 },
    { key: "repairBudget", label: "动作修复次数", type: "number", min: 0, max: 2, step: 1, note: "仅 Controller；格式与只读范围修复共用，范围修复最多一次" },
    { key: "merchantEvents", label: "商家通知处理", type: "select", options: [
      { value: "architecture", label: "跟随架构" }, { value: "host", label: "宿主直接处理" }, { value: "model", label: "经过模型" }], note: "最终状态卡始终由宿主生成" },
    { key: "knowledgeMode", label: "知识检索", type: "select", options: [
      { value: "lexical", label: "本地词项" }, { value: "m4-support", label: "全候选重排 + 事实支持" }], note: "m4-support 仅 Controller；额外调用百炼和支持性模型" },
    { key: "knowledgeSupport", label: "事实支持判别", type: "select", options: [
      { value: "binary", label: "二元基线 v1" }, { value: "typed", label: "分类候选（当前版本见运行快照）" }], note: "typed 仅用于 m4-support；区分直接事实、可答边界、仅有缺失说明和无关证据" },
    { key: "knowledgeSupportModel", label: "支持判别模型", type: "select", options: [
      { value: "configured", label: "跟随已配置模型" }, { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }], note: "仅 Controller + m4-support；Pro 只切换支持判别，业务 Agent 不变；要求当前 provider 为 DeepSeek" },
    { key: "knowledgeSupportPrompt", label: "分类判别 Prompt", type: "select", options: [
      { value: "v5", label: "v5 基线" }, { value: "v6", label: "v6 诉求合同" }], note: "默认 v5；v6 仅 Controller + m4-support + typed，强调先确定用户所问命题；binary 保持原二元 Prompt，未调用支持模型不算已验证版本" },
    { key: "knowledgeApplicability", label: "已声明必要前提", type: "select", options: [
      { value: "model_only", label: "模型判断" }, { value: "declared", label: "声明前提 v1 + 模型判断" },
      { value: "declared-v2", label: "商品类别声明 v2（候选）" }], note: "declared 与 declared-v2 仅 Controller + m4-support；v1 检查数量与状态，v2 追加作者审阅的合成 SKU 类别目录；未知类别不猜测；通过不证明全部规则适用或获批，不新增模型调用；身份、范围与确认校验始终保留" },
    { key: "knowledgeQueryMode", label: "排序查询", type: "select", options: [
      { value: "combined", label: "完整事实共用" }, { value: "separated", label: "排序与判别分离" }], note: "默认 combined；separated 仅 Controller + m4-support，排序保留原问、可信前文和简短状态，判别仍使用完整事实；不新增模型阶段，不代表效果已提升" },
    { key: "knowledgeThreshold", label: "知识接收阈值", type: "number", min: 0, max: 1, step: .01, note: "仅 m4-support；默认冻结值 0.71，分数不是概率" },
    { key: "knowledgeTimeoutMs", label: "单次知识查询超时（ms）", type: "number", min: 1000, max: 60000, step: 1000, note: "包含读取、重排、支持判别和来源复检；无自动重试" },
  ],
  retrieval: [
    { key: "candidateTopK", label: "候选数 K", type: "number", min: 1, max: 100, step: 1, note: "M5/M6 重排候选及候选召回；M4 使用范围内全部文档" },
    { key: "bm25K1", label: "BM25 k1", type: "number", min: .1, max: 3, step: .1 },
    { key: "bm25B", label: "BM25 b", type: "number", min: 0, max: 1, step: .05 },
    { key: "rrfK", label: "RRF k", type: "number", min: 1, max: 200, step: 1 },
    { key: "rrfWindow", label: "RRF 每路窗口", type: "number", min: 1, max: 100, step: 1 },
    { key: "cache", label: "远程结果缓存", type: "select", options: [{ value: "reuse", label: "复用缓存" }, { value: "refresh", label: "重新请求" }], note: "缓存复用不算独立模型重复；比较时延请重新请求" },
    { key: "timeoutMs", label: "单请求超时（ms）", type: "number", min: 1000, max: 60000, step: 1000 },
    { key: "retries", label: "失败重试次数", type: "number", min: 0, max: 2, step: 1 },
    { key: "maxRequests", label: "每次运行请求上限", type: "number", min: 1, max: 10000, step: 1, note: "包含向量、重排及事实支持判别的实际请求；缓存命中不消耗请求数" },
    { key: "consecutiveFailureLimit", label: "连续失败停止数", type: "number", min: 1, max: 20, step: 1 },
  ],
};
export function experimentCatalog() {
  const preset = (id: string, name: string, kind: string, variants: unknown[], version: 1 | 2 = 1) => ({ id, name, config: resolveExperimentConfig({
    version, kind, label: name, repeat: 1, allowRemote: false, variants }) });
  return {
    presets: [
      preset("support-ab", "业务架构 A/B", "support", [{ id: "A", architecture: "atomic" }, { id: "B", architecture: "controller" }]),
      preset("support-controller", "Controller 单方案", "support", [{ id: "A", architecture: "controller" }]),
      preset("support-knowledge-ab", "Controller 知识检索 A/B", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "lexical" } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support" } },
      ]),
      preset("support-knowledge-profile-ab", "事实支持分类 A/B", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "binary" } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed" } },
      ]),
      preset("support-knowledge-model-ab", "事实支持模型 A/B", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "configured", knowledgeThreshold: .5 } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5 } },
      ]),
      preset("support-knowledge-applicability-ab", "已声明必要前提 A/B", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "model_only" } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "declared" } },
      ]),
      preset("support-knowledge-category-ab", "商品类别声明 v1/v2 候选对照", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeSupportPrompt: "v6", knowledgeThreshold: .5, knowledgeApplicability: "declared", knowledgeTimeoutMs: 60000, knowledgeQueryMode: "separated" } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeSupportPrompt: "v6", knowledgeThreshold: .5, knowledgeApplicability: "declared-v2", knowledgeTimeoutMs: 60000, knowledgeQueryMode: "separated" } },
      ]),
      preset("support-knowledge-query-ab", "排序查询分离 A/B", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "declared", knowledgeTimeoutMs: 60000, knowledgeQueryMode: "combined" } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "declared", knowledgeTimeoutMs: 60000, knowledgeQueryMode: "separated" } },
      ]),
      preset("support-knowledge-prompt-ab", "分类判别 Prompt A/B", "support", [
        { id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "declared", knowledgeTimeoutMs: 60000, knowledgeQueryMode: "combined", knowledgeSupportPrompt: "v5" } },
        { id: "B", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "declared", knowledgeTimeoutMs: 60000, knowledgeQueryMode: "combined", knowledgeSupportPrompt: "v6" } },
      ]),
      preset("retrieval-local", "本地检索 M0 / M1", "retrieval", [{ id: "A", modes: ["M0", "M1"] }]),
      preset("retrieval-rerank", "词项 / 全候选重排", "retrieval", [{ id: "A", modes: ["M0", "M4"] }]),
      preset("retrieval-all", "检索 M0–M6", "retrieval", [{ id: "A", modes: [...experimentModes] }]),
      preset("acceptance-development", "A1 证据接收开发 A/B", "retrieval", [
        { id: "A", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "off" } },
        { id: "B", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "score", threshold: .71 } },
      ], 2),
      preset("support-development", "A1 事实支持开发 A/B", "retrieval", [
        { id: "A", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "score", threshold: .71 }, parameters: { maxRequests: 160, timeoutMs: 60000, retries: 0 } },
        { id: "B", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "support", threshold: .71 }, parameters: { maxRequests: 160, timeoutMs: 60000, retries: 0 } },
      ], 2),
      preset("support-validation", "A1 事实支持固定验证 A/B", "retrieval", [
        { id: "A", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "score", threshold: .71 }, parameters: { maxRequests: 160, timeoutMs: 60000, retries: 0 } },
        { id: "B", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "support", threshold: .71 }, parameters: { maxRequests: 160, timeoutMs: 60000, retries: 0 } },
      ], 2),
    ], fields: experimentFields,
    datasets: [{ value: "legacy", label: "原检索开发集" }, { value: "acceptance-development", label: "A1 开发集（48 题）" },
      { value: "acceptance-validation", label: "A1 原分数固定验证集（60 题，已曝光，非盲测）" },
      { value: "acceptance-support-validation", label: "A1 事实支持固定验证集（60 题，非盲测）" }],
    acceptanceFields: [
      { key: "mode", label: "证据接收策略", type: "select", options: [{ value: "off", label: "关闭（范围内原始 Top5）" }, { value: "score", label: "按重排分数接收" }, { value: "support", label: "分数 + 事实支持判别" }],
        note: "score/support 仅支持 M4/M5/M6；support 会额外调用模型判断原文是否支持所问事实，增加请求与成本；不修改原始排名。" },
      { key: "threshold", label: "接收分数阈值", type: "number", min: 0, max: 1, step: .01,
        note: "score/support 都须显式填写。0.71 为开发冻结值，分数不是概率；原纯分数验证有误接收，事实支持策略须另行验证，尚未准入在线。" },
    ] satisfies Field[],
    modes: ["M0 词项", "M1 BM25", "M2 向量", "M3 BM25 + 向量 RRF", "M4 全候选重排", "M5 词项候选重排", "M6 RRF 候选重排"].map((label, index) => ({ value: experimentModes[index], label })),
    limits: { variants: 2, repeat: 3, concurrentJobs: 1 },
    notes: ["所有配置仅作用于本次评测，不修改在线 QQ 配置。", "检索实验单独报告 Recall@5 / MRR@5 和接收后的证据指标；Controller 业务实验可显式比较 lexical 与 m4-support。", "原分数验证已曝光且未准入；事实支持策略使用单独的新固定验证集，仍非独立盲测，开发阈值不代表已达标。", "事实支持判别增加模型调用；离线实验与重排共用请求预算，业务知识服务限制单次查询超时且无重试，费用按真实调用分别报告。", "长期记忆、模型改写开关尚未完成。"],
  };
}
