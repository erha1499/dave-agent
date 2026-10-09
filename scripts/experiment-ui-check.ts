import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";

// 实验调试 tab 的离线检查：独立 FakeDOM（与 eval-ui-check.ts 互不影响），同时加载 app.js 与 experiments.js。
class Element {
  tagName = "";
  children: Element[] = [];
  get options() { return this.children.filter(child => child.tagName === "OPTION"); }
  ownText = "";
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  value = "";
  className = "";
  private inactive = false;
  get disabled() { return this.inactive; }
  set disabled(value: boolean) { this.inactive = value; if (value) this.onDisable?.(); }
  hidden = false;
  checked = false;
  open?: boolean;
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  styleAttr = false;
  events = new Map<string, () => unknown>();
  classList = { toggle: (name: string, active: boolean) => {
    const names = new Set(this.className.split(" ").filter(Boolean));
    if (active) names.add(name);
    else names.delete(name);
    this.className = [...names].join(" ");
  } };
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  insertBefore(child: Element, reference: Element | null) {
    const previous = this.children.indexOf(child);
    if (previous >= 0) this.children.splice(previous, 1);
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    assert.ok(index >= 0, "insertBefore reference must be a current child");
    this.children.splice(index, 0, child);
  }
  removeChild(child: Element) {
    const index = this.children.indexOf(child);
    assert.ok(index >= 0, "removeChild target must be a current child");
    this.children.splice(index, 1);
  }
  replaceChild(child: Element, previous: Element) {
    const index = this.children.indexOf(previous);
    assert.ok(index >= 0, "replaceChild target must be a current child");
    this.children[index] = child;
  }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  focused = false;
  onFocus?: () => void;
  onDisable?: () => void;
  connected?: () => boolean;
  get isConnected() { return this.connected?.() ?? false; }
  getClientRects() { return this.hidden || !this.isConnected ? [] : [{}]; }
  focus() { this.focused = true; this.onFocus?.(); }
  setAttribute(key: string, value: string) {
    if (key === "value") this.value = value;
    if (key === "style") this.styleAttr = true;
    this.attrs.set(key, value);
  }
  removeAttribute(key: string) { this.attrs.delete(key); }
  addEventListener(event: string, handler: () => unknown) { this.events.set(event, handler); }
  click() { this.events.get("click")?.(); }
  fire(event: string) { assert.ok(this.events.has(event), `no handler for ${event}`); return this.events.get(event)!(); }
}
const content = (element: Element): string => element.textContent;
const walk = (element: Element): Element[] => [element, ...element.children.flatMap(walk)];
const findClass = (element: Element, cls: string) => walk(element).find(item => item.className.split(" ").includes(cls));
const findAttr = (element: Element, key: string, value: string) => walk(element).find(item => item.attrs.get(key) === value);
const findAllAttr = (element: Element, key: string, value: string) => walk(element).filter(item => item.attrs.get(key) === value);
type Response = { ok: boolean; json: () => Promise<unknown> };
type Pending = { path: string; options?: { method?: string; headers?: Record<string, string>; body?: string }; resolve: (response: Response) => void; reject: (error: Error) => void };
const respond = (request: Pending, body: unknown) => request.resolve({ ok: true, json: async () => body });
const respondError = (request: Pending, body: unknown) => request.resolve({ ok: false, json: async () => body });
const appSource = await readFile(new URL("../web/evaluation/app.js", import.meta.url), "utf8");
const expSource = await readFile(new URL("../web/evaluation/experiments.js", import.meta.url), "utf8");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function boot() {
  const elements = new Map<string, Element>();
  let activeElement: Element | null = null;
  const body = Object.assign(new Element(), { tagName: "BODY" });
  body.onFocus = () => { activeElement = body; };
  const createElement = () => {
    const element = new Element();
    element.onFocus = () => { activeElement = element; };
    element.onDisable = () => { if (activeElement === element) body.focus(); };
    element.connected = () => [...elements.values()].some(root => walk(root).includes(element));
    return element;
  };
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id)!;
  };
  const pending: Pending[] = [];
  const take = () => { const request = pending.shift(); assert.ok(request, "expected a pending request"); return request; };
  const find = (match: (request: Pending) => boolean, label: string) => {
    const index = pending.findIndex(match);
    assert.ok(index >= 0, `expected a pending request for ${label}`);
    return pending.splice(index, 1)[0]!;
  };
  const context = createContext({
    Node: Element,
    document: {
      body,
      get activeElement() { return activeElement; },
      getElementById: element, createElement: (tag: string) => Object.assign(createElement(), { tagName: tag.toUpperCase() }),
      createTextNode: (text: string) => Object.assign(createElement(), { textContent: text }),
    },
    window: { getSelection: () => null },
    fetch: (path: string, options?: Pending["options"]) => new Promise<Response>((resolve, reject) => pending.push({ path, options, resolve, reject })),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: never) => clearTimeout(id),
  });
  runInContext(appSource, context, { filename: "web/evaluation/app.js" });
  runInContext(expSource, context, { filename: "web/evaluation/experiments.js" });
  const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await setImmediate(); };
  return { element, take, find, context, flush, activeElement: () => activeElement, pendingCount: () => pending.length };
}

// 合成 catalog：结构与 src/experiment-config.ts 的 experimentCatalog 一致。
const T = "2026-01-01T00:00:00Z";
const counts = (planned: number, passed: number, failed: number, skipped: number, missing: number): any =>
  ({ planned, passed, failed, skipped, missing, passRate: planned ? passed / planned : null });
const supportParams = (over: Record<string, unknown> = {}): any => ({
  timeoutMs: 60000, repairBudget: 1, agentModel: "configured",
  questionContract: "v2", questionModel: null, questionTimeoutMs: null, merchantEvents: "architecture",
  knowledgeMode: "lexical", knowledgeSupport: "binary", knowledgeSupportModel: "configured", knowledgeSupportPrompt: "v5", knowledgeApplicability: "model_only", knowledgeQueryMode: "combined",
  knowledgeThreshold: 0.71, knowledgeTimeoutMs: 15000, ...over,
});
const retrievalParams = (over: Record<string, unknown> = {}): any => ({
  candidateTopK: 20, bm25K1: 1.2, bm25B: 0.75, rrfK: 60, rrfWindow: 20, cache: "reuse",
  timeoutMs: 15000, retries: 1, maxRequests: 1000, consecutiveFailureLimit: 5, ...over,
});
const catalog = (): any => ({
  presets: [
    { id: "support-ab", name: "业务架构 A/B", config: { version: 1, kind: "support", label: "业务架构 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "atomic", parameters: supportParams({ repairBudget: 0 }) },
      { id: "B", architecture: "controller", parameters: supportParams() }] } },
    { id: "support-controller", name: "Controller 单方案", config: { version: 1, kind: "support", label: "Controller 单方案", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams() }] } },
    { id: "support-knowledge-ab", name: "Controller 知识检索 A/B", config: { version: 1, kind: "support", label: "Controller 知识检索 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams({ knowledgeMode: "lexical" }) },
      { id: "B", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support" }) }] } },
    { id: "support-knowledge-profile-ab", name: "Controller 事实支持判别 A/B", config: { version: 1, kind: "support", label: "Controller 事实支持判别 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "binary" }) },
      { id: "B", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed" }) }] } },
    { id: "support-knowledge-model-ab", name: "事实支持模型 A/B", config: { version: 1, kind: "support", label: "事实支持模型 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "configured", knowledgeThreshold: 0.5 }) },
      { id: "B", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: 0.5 }) }] } },
    { id: "support-knowledge-applicability-ab", name: "规则适用条件 A/B", config: { version: 1, kind: "support", label: "规则适用条件 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeApplicability: "model_only", knowledgeQueryMode: "combined", knowledgeThreshold: 0.5 }) },
      { id: "B", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeApplicability: "declared", knowledgeThreshold: 0.5 }) }] } },
    { id: "support-knowledge-prompt-ab", name: "分类判别 Prompt A/B", config: { version: 1, kind: "support", label: "分类判别 Prompt A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeSupportPrompt: "v5", knowledgeApplicability: "declared", knowledgeThreshold: 0.5 }) },
      { id: "B", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeSupportPrompt: "v6", knowledgeApplicability: "declared", knowledgeThreshold: 0.5 }) }] } },
    { id: "support-question-contract-ab", name: "咨询出处 v2 / v3（开发候选，未准入）", config: { version: 1, kind: "support", label: "咨询出处 v2 / v3（开发候选，未准入）", repeat: 1, allowRemote: false, variants: [
      { id: "A", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: 0.5, questionContract: "v2", questionModel: null, questionTimeoutMs: null }) },
      { id: "B", architecture: "controller", parameters: supportParams({ knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: 0.5, questionContract: "v3", questionModel: "configured", questionTimeoutMs: 10000 }) }] } },
    { id: "retrieval-local", name: "本地检索 M0 / M1", config: { version: 1, kind: "retrieval", label: "本地检索 M0 / M1", repeat: 1, allowRemote: false, variants: [
      { id: "A", modes: ["M0", "M1"], parameters: retrievalParams() } ] } },
    { id: "retrieval-rerank", name: "词项 / 全候选重排", config: { version: 1, kind: "retrieval", label: "词项 / 全候选重排", repeat: 1, allowRemote: false, variants: [
      { id: "A", modes: ["M0", "M4"], parameters: retrievalParams() } ] } },
    { id: "acceptance-development", name: "A1 证据接收开发 A/B", config: { version: 2, kind: "retrieval", label: "A1 证据接收开发 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "off" }, parameters: retrievalParams() },
      { id: "B", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "score", threshold: 0.71 }, parameters: retrievalParams() } ] } },
    { id: "support-validation", name: "A1 事实支持固定验证 A/B", config: { version: 2, kind: "retrieval", label: "A1 事实支持固定验证 A/B", repeat: 1, allowRemote: false, variants: [
      { id: "A", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "score", threshold: 0.71 }, parameters: retrievalParams({ maxRequests: 160, timeoutMs: 60000, retries: 0 }) },
      { id: "B", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "support", threshold: 0.71 }, parameters: retrievalParams({ maxRequests: 160, timeoutMs: 60000, retries: 0 }) } ] } },
  ],
  fields: {
    support: [
      { key: "agentModel", label: "业务 Agent 模型", type: "select", options: [
        { value: "configured", label: "跟随已配置模型" }, { value: "deepseek-flash", label: "DeepSeek Flash" },
        { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }, { value: "qwen3.7-plus-2026-05-26", label: "Qwen3.7 Plus（2026-05-26）" }],
        note: "仅作用于本次实验；configured 保持环境模型，不改变支持判别模型选择" },
      { key: "timeoutMs", label: "每轮超时（ms）", type: "number", min: 10000, max: 120000, step: 1000 },
      { key: "repairBudget", label: "格式修复次数", type: "number", min: 0, max: 2, step: 1, note: "仅 Controller 生效" },
      { key: "questionContract", label: "咨询问题出处", type: "select", options: [
        { value: "v2", label: "v2 既有合同" }, { value: "v3", label: "v3 原问解析（开发候选）" }],
        note: "默认 v2；v3 仅 Controller，整体 C1 未准入" },
      { key: "questionModel", label: "咨询解析模型", type: "select", options: [
        { value: "configured", label: "跟随已配置模型" }, { value: "deepseek-flash", label: "DeepSeek Flash" },
        { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }, { value: "qwen3.7-plus-2026-05-26", label: "Qwen3.7 Plus（2026-05-26）" }],
        note: "仅 v3；省略时 configured，v2 必须为 null" },
      { key: "questionTimeoutMs", label: "咨询解析超时（ms）", type: "number", min: 1000, max: 15000, step: 1000,
        note: "仅 v3；省略时 10000，且不超过每轮超时；v2 必须为 null" },
      { key: "merchantEvents", label: "商家通知处理", type: "select", options: [
        { value: "architecture", label: "跟随架构" }, { value: "host", label: "宿主直接处理" }, { value: "model", label: "经过模型" }], note: "最终状态卡始终由宿主生成" },
      { key: "knowledgeMode", label: "知识检索", type: "select", options: [
        { value: "lexical", label: "本地词项" }, { value: "m4-support", label: "全候选重排 + 事实支持" }], note: "m4-support 仅 Controller；额外调用百炼和支持性模型" },
      { key: "knowledgeThreshold", label: "知识接收阈值", type: "number", min: 0, max: 1, step: 0.01, note: "仅 m4-support；默认冻结值 0.71，分数不是概率" },
      { key: "knowledgeSupport", label: "事实支持判别", type: "select", options: [
        { value: "binary", label: "二元基线 v1" }, { value: "typed", label: "分类候选 v3" }], note: "typed 仅用于 m4-support" },
      { key: "knowledgeSupportModel", label: "支持判别模型", type: "select", options: [
        { value: "configured", label: "跟随已配置模型" }, { value: "deepseek-flash", label: "DeepSeek Flash" },
        { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }, { value: "qwen3.7-plus-2026-05-26", label: "Qwen3.7 Plus（2026-05-26）" }],
        note: "仅 Controller + m4-support；固定选项只切换支持判别" },
      { key: "knowledgeSupportPrompt", label: "分类判别 Prompt", type: "select", options: [
        { value: "v5", label: "v5 基线" }, { value: "v6", label: "v6 诉求合同" }], note: "v6 仅 Controller + m4-support + typed；服务端严格校验" },
      { key: "knowledgeApplicability", label: "规则适用条件", type: "select", options: [
        { value: "model_only", label: "仅模型判断" }, { value: "declared", label: "已声明必要前提" }, { value: "declared-v2", label: "已声明前提 v2（含类别目录）" }], note: "声明模式仅 Controller + m4-support；binary/typed 均可" },
      { key: "knowledgeTimeoutMs", label: "单次知识查询超时（ms）", type: "number", min: 1000, max: 60000, step: 1000, note: "包含读取、重排、支持判别和来源复检；无自动重试" },
    ],
    retrieval: [
      { key: "candidateTopK", label: "候选数 K", type: "number", min: 1, max: 100, step: 1 },
      { key: "cache", label: "远程结果缓存", type: "select", options: [{ value: "reuse", label: "复用缓存" }, { value: "refresh", label: "重新请求" }] },
      { key: "maxRequests", label: "每次运行请求上限", type: "number", min: 1, max: 10000, step: 1 },
    ],
  },
  modes: ["M0 词项", "M1 BM25", "M2 向量", "M3 BM25 + 向量 RRF", "M4 全候选重排", "M5 词项候选重排", "M6 RRF 候选重排"]
    .map((label, index) => ({ value: `M${index}`, label })),
  datasets: [{ value: "legacy", label: "原检索开发集" }, { value: "acceptance-development", label: "A1 开发集（48 题）" },
    { value: "acceptance-validation", label: "A1 原分数固定验证集（60 题，已曝光，非盲测）" },
    { value: "acceptance-support-validation", label: "A1 事实支持固定验证集（60 题，非盲测）" }],
  acceptanceFields: [
    { key: "mode", label: "证据接收策略", type: "select", options: [{ value: "off", label: "关闭（范围内原始 Top5）" },
      { value: "score", label: "按重排分数接收" }, { value: "support", label: "分数 + 事实支持判别" }],
      note: "score/support 仅支持 M4/M5/M6；support 会额外调用模型判断原文是否支持所问事实，增加请求与成本；不修改原始排名。" },
    { key: "threshold", label: "接收分数阈值", type: "number", min: 0, max: 1, step: 0.01,
      note: "score/support 都须显式填写。0.71 为开发冻结值，分数不是概率；事实支持策略须另行验证，尚未准入在线。" },
  ],
  limits: { variants: 2, repeat: 3, concurrentJobs: 1 },
  notes: ["所有配置仅作用于本次评测。"],
});
const supportSummary = (passed: number): any => ({
  runId: "x", scope: "objective", answerQuality: "not_evaluated", issues: [],
  counts: { cases: counts(3, passed, 3 - passed, 0, 0), turns: counts(3, passed, 3 - passed, 0, 0), checks: counts(6, passed * 2, (3 - passed) * 2, 0, 0) },
  categories: [], coverage: [], cases: [],
  usage: { modelRequests: 4, reportedRequests: 4, missingRequests: 0, coverage: 1, knownTokens: 1200, completeTokens: 1200, knownCostUsd: 0.01, completeCostUsd: 0.01 },
  execution: { toolCalls: 3, toolErrors: 0, expectedDenials: 0, modelErrors: 0 },
  timing: { samples: 2, durationP50Ms: 900, durationP95Ms: 1500, measurement: "单轮处理耗时" },
  retrieval: null, attribution: null,
});
const job = (id: string, over: Record<string, unknown> = {}): any => ({
  id, status: "completed", createdAt: T, finishedAt: T,
  config: { version: 1, kind: "support", label: id, repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] },
  configHash: "h", plannedRuns: 1, current: null, error: null, results: [], ...over,
});
const detailOf = (id: string) => ({ run: { id, label: id, suiteId: "suite", suiteName: "套件", kind: "model", status: "completed",
  plannedCases: 1, plannedTurns: 1, startedAt: T, finishedAt: T, metrics: null,
  snapshot: { gitCommit: "abc", gitDirty: false, model: { provider: "test", id: "k", maxTokens: 1, thinking: "off", temperature: null }, hashes: {}, asOf: T, content: {} } }, cases: [] });
const openExperiments = async (booted: Awaited<ReturnType<typeof boot>>, jobs: unknown[] = []) => {
  const { element, take, find, flush } = booted;
  respond(take(), { runs: [] });
  await flush();
  assert.equal(booted.pendingCount(), 0, "打开实验 tab 前不得请求实验接口");
  element("experiments-tab").fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/catalog", "catalog"), catalog());
  respond(find(request => request.path === "/api/experiments", "jobs"), { jobs });
  await flush();
};

// 零 Agent 步骤不代表咨询解析等其他提供商没有请求；非零/未知用量仍保留口径。
{
  const { take, context, flush, pendingCount } = await boot();
  respond(take(), { runs: [] }); await flush();
  const summary = supportSummary(2);
  summary.usage = { ...summary.usage, modelRequests: 0, reportedRequests: 0, coverage: null,
    knownTokens: null, completeTokens: null, knownCostUsd: null, completeCostUsd: null };
  const provider = { role: "question", requests: 1, knownTokenRequests: 1, unknownTokenRequests: 0,
    knownTokens: 80, completeTokens: 80, unknownCurrencyRequests: 0, currencies: [] };
  summary.attribution = { spans: 1, groups: [], providers: [{ provider: "synthetic", model: "parser", kind: "model", requests: 1,
    usageReported: 1, knownTokens: 80, costs: [] }], providerUsage: [provider], providerTotals: provider, issues: [] };
  assert.ok(summary.attribution.providerUsage[0].requests > 0);
  assert.equal(summary.usage.knownCostUsd, null); assert.equal(summary.usage.completeCostUsd, null);
  context.round31Summary = summary;
  const rendered = () => content(runInContext("expSupportSummary(round31Summary)", context) as Element);
  assert.match(rendered(), /Agent Tokens 不适用（未记录 Agent 模型步骤）/);
  assert.ok(!rendered().includes("无模型请求"), "有其他提供商正数请求时不能把 Agent 零步骤说成全部无模型请求");
  summary.usage = { ...summary.usage, modelRequests: 4, reportedRequests: 4, coverage: 1,
    knownTokens: 1200, completeTokens: 1200, knownCostUsd: 0.01, completeCostUsd: 0.01 };
  assert.match(rendered(), /Agent Tokens 已知 1,200 · 完整 1,200/);
  summary.usage = { ...summary.usage, modelRequests: undefined, coverage: null,
    knownTokens: 1200, completeTokens: null, completeCostUsd: null };
  assert.match(rendered(), /Agent Tokens 已知 1,200 · 完整 未采全/);
  assert.ok(!rendered().includes("不适用"), "未知 Agent 请求数不能补零");
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：Agent 零步骤与其他提供商正数并存，非零及未知用量口径保留。");
}

// 提交是异步动作，校验/等待/终态只更新动作及任务区，不销毁正在编辑的表单。
for (const success of [false, true]) for (const movedFocus of ["parameter", "download"]) {
  const booted = await boot(), { element, find, context, flush, activeElement, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments"), preset = findAttr(root, "data-field", "preset")!;
  preset.value = "retrieval-local"; preset.fire("change");
  const form = findClass(root, "exp-form")!, label = findAttr(root, "data-field", "exp-label")!;
  const advanced = findClass(root, "exp-advanced")!, topK = findAttr(root, "data-field", "candidateTopK")!;
  const actions = findClass(root, "exp-actions")!, submit = actions.children[0]!, download = actions.children[1]!;
  advanced.open = true; label.value = " "; label.fire("input"); label.focus();
  await runInContext("submitExperiment()", context);
  const assertForm = (phase: string) => {
    assert.equal(findClass(root, "exp-form"), form, `${phase}保留同一个表单`);
    assert.equal(findAttr(root, "data-field", "exp-label"), label, `${phase}保留原输入节点`);
    assert.equal(findClass(root, "exp-advanced"), advanced, `${phase}保留高级参数节点`);
    assert.equal(findAttr(root, "data-field", "candidateTopK"), topK);
    assert.equal(findClass(root, "exp-actions"), actions);
    assert.equal(actions.children[0], submit, `${phase}保留提交按钮`);
    assert.equal(actions.children[1], download, `${phase}保留下载按钮`);
    assert.equal(advanced.open, true);
    assert.ok([form, label, advanced, topK, submit, download].every(node => walk(root).includes(node)), `${phase}节点仍连接在根树`);
  };
  assertForm("校验失败"); assert.equal(label.value, " "); assert.equal(activeElement(), label);
  assert.match(content(actions), /名称/); assert.equal(pendingCount(), 0, "校验失败不能发送 POST");
  label.value = "  提交快照  "; label.fire("input");
  const snapshot = JSON.parse(runInContext("JSON.stringify(expState.draft)", context)); snapshot.label = snapshot.label.trim();
  assert.equal(submit.disabled, false, "本地 M0/M1 不需要远程授权");
  submit.focus(); submit.fire("click");
  const request = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "held submit");
  assertForm("等待提交"); assert.equal(submit.disabled, true);
  assert.equal(activeElement(), runInContext("document.body", context), "原生禁用已聚焦按钮后焦点退回 BODY");
  assert.deepEqual(JSON.parse(request.options!.body!), snapshot, "POST 记录发送时完整参数快照");
  await runInContext("submitExperiment()", context); assert.equal(pendingCount(), 0, "等待期间重复提交只有原 POST");
  label.value = "  等待中保留名称  "; label.fire("input");
  topK.value = "31"; topK.fire("change");
  const focus = movedFocus === "parameter" ? topK : download; focus.focus();
  assertForm("等待中编辑"); assert.equal(activeElement(), focus);
  if (success) respond(request, job("round31-local", { config: snapshot }));
  else respondError(request, { error: "合成提交被拒绝" });
  await flush();
  assertForm(success ? "提交成功" : "提交失败");
  assert.equal(label.value, "  等待中保留名称  "); assert.equal(topK.value, "31");
  assert.equal(runInContext("expState.draft.label", context), label.value);
  assert.equal(runInContext("expState.draft.variants[0].parameters.candidateTopK", context), 31);
  assert.equal(activeElement(), focus, "终态不得抢走等待期间主动转移的焦点");
  assert.equal(submit.disabled, false);
  assert.deepEqual(JSON.parse(request.options!.body!), snapshot, "等待中编辑不会修改已经发送的快照");
  if (success) { assert.equal(runInContext("expState.selected", context), "round31-local"); assert.ok(!content(actions).includes("合成提交被拒绝")); }
  else assert.match(content(actions), /合成提交被拒绝/);
  assert.equal(pendingCount(), 0, "终态不自动重发、不调用真实实验");
}

// 已聚焦的提交按钮被禁用后退到 BODY；只在没有主动选文时归还同一个可操作按钮。
for (const success of [false, true]) for (const guard of ["restore", "selection", "hidden", "disabled", "preset", "view"]) {
  const booted = await boot(), { element, find, context, flush, activeElement, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments"), preset = findAttr(root, "data-field", "preset")!;
  preset.value = "retrieval-local"; preset.fire("change");
  const form = findClass(root, "exp-form")!, source = findClass(root, "primary-button")!;
  source.focus(); source.fire("click");
  const request = find(request => request.options?.method === "POST", "source focus submit");
  const body = runInContext("document.body", context);
  assert.equal(activeElement(), body); assert.equal(source.disabled, true);
  context.window.getSelection = () => guard === "selection" ? { isCollapsed: false } : null;
  if (guard === "hidden") source.hidden = true;
  if (guard === "disabled") {
    const remoteMode = findAttr(root, "data-mode", "M4")!;
    remoteMode.checked = true; remoteMode.fire("change");
  }
  if (guard === "preset") { preset.value = "support-controller"; preset.fire("change"); }
  if (guard === "view") element("overview-tab").fire("click");
  if (success) respond(request, job("round31-focus", { config: JSON.parse(request.options!.body!) }));
  else respondError(request, { error: "合成提交失败" });
  await flush();
  if (guard === "preset") {
    assert.notEqual(findClass(root, "exp-form"), form); assert.equal(source.isConnected, false);
  } else {
    assert.equal(findClass(root, "exp-form"), form);
    assert.equal(findClass(root, "primary-button"), source); assert.equal(source.isConnected, true);
    assert.equal(source.disabled, guard === "disabled", "等待中改成远程方案后仍须授权，不能因回执解锁门禁");
  }
  assert.equal(activeElement(), guard === "restore" ? source : body, `${guard}：成功/失败仅在原源仍可操作且未转移阅读时回焦`);
  assert.equal(pendingCount(), 0);
}
console.log("PASS 实验调试：校验、提交等待及成功/失败不重建表单或动作按钮；参数/下载主动焦点、选区与原入口守卫保留。");

// 合法历史首方案未必叫 A；复制使用另一个 ID，原方案/快照不重编号，删除对应第二项。
for (const [sourceId, copyId] of [["B", "A"], ["A", "B"], ["control", "B"]]) {
  const booted = await boot(), { element, find, context, flush, pendingCount } = booted;
  const original = { id: sourceId, modes: ["M4"], dataset: "acceptance-development",
    acceptance: { mode: "score", threshold: 0.71 }, parameters: retrievalParams() };
  const historical = job("copy-history", { config: { version: 2, kind: "retrieval", label: "历史方案复制", repeat: 1, allowRemote: false, variants: [original] } });
  const snapshot = JSON.stringify(historical.config);
  await openExperiments(booted, [historical]);
  runInContext('selectJob("copy-history")', context);
  respond(find(request => request.path === "/api/experiments/copy-history", "copy history"), historical); await flush();
  const root = element("experiments");
  findAttr(root, "data-action", "load-config")!.fire("click");
  const originalObject = runInContext("expState.draft.variants[0]", context);
  const copy = findAttr(root, "data-action", "copy-b")!, copyLabel = content(copy);
  copy.fire("click");
  const variants = () => JSON.parse(runInContext("JSON.stringify(expState.draft.variants)", context));
  assert.deepEqual(variants().map((variant: any) => variant.id), [sourceId, copyId], "合法单 B 历史复制不能生成重复 B/B");
  assert.equal(copyLabel, `复制 ${sourceId} 成 ${copyId} 对照`);
  assert.deepEqual(variants(), [original, { ...original, id: copyId }], "仅复制件 ID 变化，全部配置深复制");
  assert.equal(runInContext("expState.draft.variants[0]", context), originalObject);
  assert.equal(runInContext("['modes','acceptance','parameters'].every(key => expState.draft.variants[0][key] !== expState.draft.variants[1][key])", context), true, "数组与嵌套对象不能共享引用");
  assert.equal(findAttr(root, "data-action", "copy-b"), undefined, "两方案时不提供第三项复制");
  const byField = (field: string) => findAllAttr(root, "data-field", field).find(input => input.getAttribute("data-variant") === copyId)!;
  const topK = byField("candidateTopK"); topK.value = "30"; topK.fire("change");
  const threshold = byField("acceptance-threshold"); threshold.value = "0.65"; threshold.fire("change");
  const mode = findAllAttr(root, "data-mode", "M5").find(input => input.getAttribute("data-variant") === copyId)!;
  mode.checked = true; mode.fire("change");
  assert.deepEqual(variants()[0], original, "编辑复制件不改变原参数、策略和模式");
  assert.equal(variants()[1].parameters.candidateTopK, 30);
  assert.equal(variants()[1].acceptance.threshold, 0.65);
  assert.deepEqual(variants()[1].modes, ["M4", "M5"]);
  const displayed = JSON.parse(content(walk(findClass(root, "exp-diff-slot")!).find(item => item.tagName === "PRE")!));
  assert.deepEqual(Object.keys(displayed), [sourceId, copyId], "完整参数 JSON 按实际方案 ID 标名");
  assert.ok(Object.entries(displayed).every(([id, variant]: [string, any]) => id === variant.id));
  assert.deepEqual(Object.values(displayed), variants(), "展示完整参数与编辑中的两项方案一致");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "复制保留未授权远程门禁");
  const allow = findAttr(root, "data-field", "allow-remote")!; allow.checked = true; allow.fire("change");
  assert.equal(findClass(root, "primary-button")!.disabled, false);
  let downloaded: Blob | undefined;
  context.Blob = Blob;
  context.URL = { createObjectURL: (blob: Blob) => { downloaded = blob; return "blob:copy-config"; }, revokeObjectURL: () => {} };
  runInContext("downloadExpConfig()", context); assert.ok(downloaded instanceof Blob);
  const exported = JSON.parse(await downloaded.text());
  assert.deepEqual(exported.variants.map((variant: any) => variant.id), [sourceId, copyId]);
  assert.equal(new Set(exported.variants.map((variant: any) => variant.id)).size, 2);
  findClass(root, "primary-button")!.fire("click");
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "unique copy synthetic POST");
  assert.deepEqual(JSON.parse(post.options?.body || "{}"), exported, "下载与合成提交的 ID/全部参数一致");
  respondError(post, { error: "合成提交拒绝" }); await flush();
  assert.equal(pendingCount(), 0);
  const remove = findAttr(root, "data-action", "delete-b")!;
  assert.equal(content(remove), `删除 ${copyId}`, "删除按钮按实际第二项命名");
  remove.fire("click");
  assert.deepEqual(variants(), [original]);
  assert.equal(runInContext("expState.draft.variants[0]", context), originalObject, "删除保留原方案对象");
  assert.equal(content(findAttr(root, "data-action", "copy-b")!), `复制 ${sourceId} 成 ${copyId} 对照`);
  assert.equal(JSON.stringify(historical.config), snapshot, "历史快照未被载入后的编辑改写");
}
{
  const booted = await boot(), { element, find, context, flush } = booted;
  const historical = job("custom-history", { config: { version: 1, kind: "support", label: "两项自定义方案", repeat: 1, allowRemote: false,
    variants: [{ id: "control", architecture: "controller", parameters: supportParams() },
      { id: "candidate", architecture: "atomic", parameters: supportParams({ repairBudget: 0 }) }] } });
  await openExperiments(booted, [historical]);
  runInContext('selectJob("custom-history")', context);
  respond(find(request => request.path === "/api/experiments/custom-history", "two custom variants"), historical); await flush();
  const root = element("experiments"); findAttr(root, "data-action", "load-config")!.fire("click");
  const original = runInContext("expState.draft.variants[0]", context);
  const displayed = JSON.parse(content(walk(findClass(root, "exp-diff-slot")!).find(item => item.tagName === "PRE")!));
  assert.deepEqual(Object.keys(displayed), ["control", "candidate"]);
  assert.ok(Object.entries(displayed).every(([id, variant]: [string, any]) => id === variant.id));
  assert.deepEqual(Object.values(displayed), historical.config.variants, "自定义两项完整 JSON 保留实际 ID 和参数");
  const remove = findAttr(root, "data-action", "delete-b")!;
  assert.equal(content(remove), "删除 candidate"); remove.fire("click");
  assert.equal(runInContext("expState.draft.variants[0]", context), original);
  assert.deepEqual(JSON.parse(runInContext("JSON.stringify(expState.draft.variants)", context)), [historical.config.variants[0]]);
}
console.log("PASS 历史方案复制：B→A/A→B/自定义→B 唯一ID与深复制，实际删除对象/文案，快照/远程门禁及下载提交一致。");

// 高级数值清空不能偷改为 0；下载与提交沿用实际编辑结果，历史缺省/null 不补造数值。
{
  const booted = await boot(), { element, find, context, flush, pendingCount } = booted;
  const legacy = job("numeric-history", { config: { version: 1, kind: "support", label: "历史参数", repeat: 1, allowRemote: false,
    variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, merchantEvents: "architecture",
      knowledgeMode: "lexical", questionContract: "v3", questionModel: "configured", questionTimeoutMs: null } }] } });
  await openExperiments(booted, [legacy]);
  const root = element("experiments");
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-knowledge-model-ab"; preset.fire("change"); await flush();
  const byField = (field: string) => findAllAttr(root, "data-field", field).find(input => input.getAttribute("data-variant") === "A")!;
  const params = () => JSON.parse(runInContext("JSON.stringify(expState.draft.variants[0].parameters)", context));
  const threshold = byField("knowledgeThreshold");
  assert.equal(threshold.value, "0.5");
  threshold.value = ""; threshold.fire("change");
  assert.equal(threshold.value, "0.5", "清空已设数值后显示原值，不能空显示而偷改为 0");
  assert.equal(params().knowledgeThreshold, 0.5);
  threshold.value = "0"; threshold.fire("change");
  assert.equal(params().knowledgeThreshold, 0, "显式 0 仍是合法数值");
  threshold.value = ""; threshold.fire("change");
  assert.equal(threshold.value, "0"); assert.equal(params().knowledgeThreshold, 0);
  threshold.value = "0.37"; threshold.fire("change");
  assert.equal(params().knowledgeThreshold, 0.37, "有限小数仍正常编辑");
  for (const invalid of ["Infinity", "NaN", "非法数值"]) {
    threshold.value = invalid; threshold.fire("change");
    assert.equal(threshold.value, "0.37"); assert.equal(params().knowledgeThreshold, 0.37, "非法数值沿用原回退");
  }
  let downloaded: Blob | undefined;
  context.Blob = Blob;
  context.URL = { createObjectURL: (blob: Blob) => { downloaded = blob; return "blob:experiment-config"; }, revokeObjectURL: () => {} };
  const download = async () => {
    runInContext("downloadExpConfig()", context);
    assert.ok(downloaded instanceof Blob, "调用实际下载入口生成 JSON Blob");
    return JSON.parse(await downloaded.text());
  };
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true; allow.fire("change");
  const exported = await download();
  assert.equal(exported.variants[0].parameters.knowledgeThreshold, 0.37);
  findClass(root, "primary-button")!.fire("click");
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "numeric synthetic POST");
  assert.deepEqual(JSON.parse(post.options?.body || "{}"), exported, "实际下载与合成提交使用同一参数");
  respondError(post, { error: "合成提交拒绝" }); await flush();
  assert.equal(pendingCount(), 0);
  runInContext('selectJob("numeric-history")', context);
  respond(find(request => request.path === "/api/experiments/numeric-history", "numeric history"), legacy); await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  const missing = byField("repairBudget");
  assert.equal(missing.value, ""); missing.fire("change");
  assert.equal(missing.value, ""); assert.equal(Object.hasOwn(params(), "repairBudget"), false, "缺省数值清空不新增字段");
  const nullable = byField("questionTimeoutMs");
  assert.equal(nullable.disabled, false); assert.equal(nullable.value, "");
  for (const raw of ["", "Infinity"]) {
    nullable.value = raw; nullable.fire("change");
    assert.equal(nullable.value, "", "null 回退显示为空而非字串 null");
    assert.equal(params().questionTimeoutMs, null, "非法历史 null 保留给原组合门禁");
  }
  const disabled = byField("knowledgeThreshold");
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.value, "");
  assert.equal(Object.hasOwn(params(), "knowledgeThreshold"), false, "原禁用参数及缺省状态保持");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "v3/null 与远程原门禁保留");
  const historicalExport = await download();
  assert.equal(Object.hasOwn(historicalExport.variants[0].parameters, "repairBudget"), false);
  assert.equal(Object.hasOwn(historicalExport.variants[0].parameters, "knowledgeThreshold"), false);
  assert.equal(historicalExport.variants[0].parameters.questionTimeoutMs, null);
  assert.equal(pendingCount(), 0);
  console.log("PASS 高级数值：清空恢复原值、显式0/有限数正常、非法数回退、省略/null/禁用保留，实际下载与提交一致。");
}

// 同一运行按完整 ID 复用选项；已有名称/时间与节点保持，新 ID 不按短名称误合并。
{
  const booted = await boot(), { element, take, find, context, flush, activeElement, pendingCount } = booted;
  respond(take(), { runs: [] }); await flush();
  const ids = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const cached = new Set<string>();
  const importPair = async (pair: string[]) => {
    runInContext(`expCompare(${JSON.stringify(pair.map((runId, index) => ({ runId, variantId: index ? "B" : "A", repetition: 1 })))})`, context);
    assert.equal(element("baseline").value, pair[0]);
    assert.equal(element("candidate").value, pair[1]);
    assert.equal(activeElement(), element("baseline"), "复用/追加选项均同步聚焦基线");
    assert.equal(element("compare-button").disabled, true);
    if (pair[0] === pair[1]) {
      assert.equal(pendingCount(), 0, "同 ID 对比仍由既有门禁拒绝，零请求");
      assert.match(content(element("compare-detail")), /请选择两次不同的运行/);
      return;
    }
    respond(find(request => request.path === `/api/compare?baseline=${pair[0]}&candidate=${pair[1]}`, "imported pair"), {
      baseline: pair[0], candidate: pair[1], comparable: true, repeatCompatible: true,
      conditions: [], configuration: [], issues: [],
      analyses: { baseline: supportSummary(2), candidate: supportSummary(3) }, cases: [],
    });
    for (const id of pair) if (!cached.has(id)) {
      respond(find(request => request.path === `/api/runs/${id}`, "imported detail"), detailOf(id));
      cached.add(id);
    }
    await flush();
    assert.equal(pendingCount(), 0);
    assert.equal(element("compare-button").disabled, false, "不同 ID 完成后仍可继续对比");
  };
  const matches = (select: string, id: string) => element(select).options.filter(option => option.value === id);
  await importPair(ids);
  const imported = [matches("baseline", ids[0]!)[0]!, matches("candidate", ids[1]!)[0]!];
  await importPair(ids);
  for (const [index, select] of ["baseline", "candidate"].entries()) {
    assert.equal(matches(select, ids[index]!).length, 1, "重复导入每侧同一运行只出现一次");
    assert.equal(matches(select, ids[index]!)[0], imported[index], "重复导入保留原 option 节点");
  }
  const otherIds = ["22222222-2222-4222-8222-222222222221", "33333333-3333-4333-8333-333333333334"];
  await importPair(otherIds);
  for (const [index, select] of ["baseline", "candidate"].entries()) {
    assert.equal(element(select).options.filter(option => option.value).length, 2, "不同完整 ID 追加新选项");
    assert.equal(content(matches(select, otherIds[index]!)[0]!), content(imported[index]!), "短 ID 与文案相同也不能合并不同运行");
    assert.equal(matches(select, ids[index]!)[0], imported[index]);
  }
  runInContext(`state.runs = ${JSON.stringify(ids.map((id, index) => ({ ...detailOf(id).run, label: `原运行名称 ${index}` })))}; renderPickers()`, context);
  const original = [matches("baseline", ids[0]!)[0]!, matches("candidate", ids[1]!)[0]!];
  const originalLabels = original.map(content);
  await importPair(ids);
  for (const [index, select] of ["baseline", "candidate"].entries()) {
    assert.equal(matches(select, ids[index]!).length, 1, "已有同 ID 运行不追加实验别名");
    assert.equal(matches(select, ids[index]!)[0], original[index]);
    assert.equal(content(original[index]!), originalLabels[index], "保留既有运行名称与时间");
    assert.match(content(original[index]!), /原运行名称.*2026/);
  }
  await importPair([ids[0]!, ids[0]!]);
  for (const select of ["baseline", "candidate"]) assert.equal(matches(select, ids[0]!).length, 1);
  console.log("PASS 实验 A/B 导入：重复/已有 ID 复用节点与名称，短 ID 相同的新运行追加，同 ID 门禁与焦点保持。");
}

// 跨视图动作在请求等待时同步交接焦点；成功/失败均不夺走等待期间转移的焦点。
for (const action of ["view-run", "compare-btn"]) for (const fails of [false, true]) for (const movesFocus of [false, true]) {
  const booted = await boot(), { element, find, context, flush, activeElement, pendingCount } = booted;
  const completed = job("jump-job", { plannedRuns: 2, results: [
    { variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "jump-a", summary: supportSummary(2) },
    { variantId: "A", repetition: 2, kind: "support", status: "completed", runId: "jump-b", summary: supportSummary(3) },
  ] });
  await openExperiments(booted, [completed]);
  runInContext('selectJob("jump-job")', context);
  respond(find(request => request.path === "/api/experiments/jump-job", "jump task"), completed);
  await flush();
  const source = findAttr(element("experiments"), "data-action", action)!;
  const target = element(action === "view-run" ? "run-detail" : "baseline");
  source.focus();
  source.fire("click");
  assert.equal(activeElement(), target, `${action} 请求未完成时必须同步聚焦可见目标`);
  assert.equal(runInContext('$("experiments").hidden', context), true);
  assert.equal(target.disabled, false, "跳转目标始终可操作");
  if (action === "view-run") {
    assert.equal(target.getAttribute("aria-busy"), "true");
    assert.match(content(target), /正在读取运行详情/);
  } else {
    assert.equal(element("baseline").value, "jump-a");
    assert.equal(element("candidate").value, "jump-b");
    assert.equal(element("compare-button").disabled, true);
    assert.match(content(element("compare-detail")), /正在对比/);
  }
  const userTarget = element(action === "view-run" ? "overview-tab" : "candidate");
  if (movesFocus) userTarget.focus();
  if (action === "view-run") {
    const detailRequest = find(request => request.path === "/api/runs/jump-a", "jump run detail");
    if (fails) respondError(detailRequest, { error: "合成详情失败" });
    else respond(detailRequest, detailOf("jump-a"));
    respond(find(request => request.path === "/api/runs/jump-a/analysis", "jump run analysis"), supportSummary(2));
  } else {
    const comparison = find(request => request.path.startsWith("/api/compare"), "jump comparison");
    if (fails) respondError(comparison, { error: "合成对比失败" });
    else respond(comparison, {
      baseline: "jump-a", candidate: "jump-b", comparable: true, repeatCompatible: true,
      conditions: [], configuration: [], issues: [],
      analyses: { baseline: supportSummary(2), candidate: supportSummary(3) }, cases: [],
    });
    for (const id of ["jump-a", "jump-b"]) respond(find(request => request.path === `/api/runs/${id}`, id), detailOf(id));
  }
  await flush();
  assert.equal(pendingCount(), 0);
  assert.equal(activeElement(), movesFocus ? userTarget : target, `${action} 完成/失败不得异步夺焦`);
  if (action === "view-run") {
    assert.equal(element("run-detail"), target, "运行详情容器保持同一节点");
    assert.equal(target.getAttribute("aria-busy"), "false");
    assert.match(content(target), fails ? /这次运行暂时无法打开.*重试这次运行/ : /jump-a/);
  } else {
    assert.equal(element("compare-button").disabled, false, "成功/失败均可继续对比");
    assert.match(content(element("compare-detail")), fails ? /暂时无法完成对比/ : /场景对比/);
  }
}
{
  const booted = await boot();
  await openExperiments(booted);
  const tab = booted.element("overview-tab");
  tab.focus(); tab.fire("click");
  assert.equal(booted.activeElement(), tab, "普通页签切换保留页签焦点");
}
console.log("PASS 实验结果跨视图：两动作成功/失败同步交接，等待期转焦不被夺回，普通页签保持焦点。");

// Existing metadata-driven controls preserve a valid prompt comparison; backend
// combination rejection is covered by experiment-check, not inferred from UI.
{
  const booted = await boot(), { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments"), preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-knowledge-prompt-ab"; preset.fire("change"); await flush();
  const prompts = findAllAttr(root, "data-field", "knowledgeSupportPrompt");
  assert.deepEqual(prompts.map(input => input.value), ["v5", "v6"]);
  assert.match(content(root), /knowledgeSupportPrompt v5 → v6/);
  const allow = findAttr(root, "data-field", "allow-remote")!; allow.checked = true; allow.fire("change"); await flush();
  assert.equal(findClass(root, "primary-button")!.disabled, false);
  findClass(root, "primary-button")!.fire("click"); await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "prompt comparison POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.deepEqual(body.variants.map((variant: any) => variant.parameters.knowledgeSupportPrompt), ["v5", "v6"]);
  respond(post, job("prompt-comparison", { config: body })); await flush();
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：Prompt 元数据呈现、v5/v6 单变量差异及提交参数保留。");
}

// 表单：懒加载、远程勾选门控、Controller 隐藏 model 通知、atomic 修复次数不适用、复制/删除方案与参数差异。
{
  const booted = await boot();
  const { element, flush } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const html = content(root);
  assert.match(html, /方案预设/);
  assert.match(html, /方案 A/);
  assert.match(html, /方案 B/);
  assert.match(html, /高级参数/);
  assert.match(html, /允许本次远程模型调用/);
  assert.match(html, /下载 JSON 配置/);
  const submit = () => findClass(root, "primary-button")!;
  assert.equal(submit().disabled, true, "业务实验未勾选远程授权时提交禁用");
  // Controller 方案的商家通知不含 model 选项；atomic 的修复次数禁用。
  const merchantB = findAllAttr(root, "data-field", "merchantEvents").find(item => item.attrs.get("data-variant") === "B")!;
  assert.ok(merchantB.children.every(option => option.attrs.get("value") !== "model"), "Controller 隐藏 merchantEvents=model");
  const repairA = findAllAttr(root, "data-field", "repairBudget").find(item => item.attrs.get("data-variant") === "A")!;
  const repairB = findAllAttr(root, "data-field", "repairBudget").find(item => item.attrs.get("data-variant") === "B")!;
  assert.equal(repairA.disabled, true, "atomic 修复次数不适用");
  assert.equal(repairB.disabled, false, "Controller 修复次数可填");
  // A 先选 model 通知再切 controller：自动回落跟随架构，且选项隐藏。
  const merchantA = () => findAllAttr(root, "data-field", "merchantEvents").find(item => item.attrs.get("data-variant") === "A")!;
  merchantA().value = "model";
  merchantA().fire("change");
  await flush();
  const archA = findAllAttr(root, "data-field", "architecture").find(item => item.attrs.get("data-variant") === "A")!;
  archA.value = "controller";
  archA.fire("change");
  await flush();
  assert.equal(merchantA().value, "architecture", "切到 Controller 后 model 通知自动回落");
  assert.ok(merchantA().children.every(option => option.attrs.get("value") !== "model"));
  // 勾选远程授权后提交可用。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  assert.equal(submit().disabled, false, "勾选远程授权后提交启用");
  // 切预设到检索：模式多选、M4 触发远程门控、复制/删除 B 与差异提示。
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "retrieval-rerank";
  preset.fire("change");
  await flush();
  assert.equal(findAllAttr(root, "data-mode", "M4").find(item => item.attrs.get("data-variant") === "A")?.checked, true, "预设模式 M4 选中");
  assert.equal(findAllAttr(root, "data-mode", "M2").find(item => item.attrs.get("data-variant") === "A")?.checked, false);
  assert.equal(submit().disabled, true, "预设切换重置配置，远程授权需重新勾选");
  assert.match(content(root), /每次运行请求上限 1000/, "标示每次请求上限");
  findAttr(root, "data-action", "copy-b")!.fire("click");
  await flush();
  assert.match(content(root), /两个方案参数完全一致/, "复制后无差异");
  const modeM4B = findAllAttr(root, "data-mode", "M4").find(item => item.attrs.get("data-variant") === "B")!;
  modeM4B.checked = false;
  modeM4B.fire("change");
  await flush();
  assert.match(content(root), /模式 M0\+M4 → M0/, "参数差异短标签");
  findAttr(root, "data-action", "delete-b")!.fire("click");
  await flush();
  assert.ok(!content(root).includes("方案 B"), "删除 B 后回到单方案");
  console.log("PASS 实验调试：懒加载、远程门控、Controller/atomic 参数约束、复制/删除方案与差异提示。");
}

// 提交与状态：POST 头、运行轮询、tab 隐藏停轮询、切回刷新、终态停轮、结果与带入对比。
{
  const booted = await boot();
  const { element, find, context, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-controller";
  preset.fire("change");
  await flush();
  runInContext("expState.pollMs = 1", context);
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  const running = job("job-1", { status: "running", finishedAt: null, plannedRuns: 2, current: { variantId: "A", repetition: 1 },
    config: { version: 1, kind: "support", label: "Controller 单方案", repeat: 2, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] } });
  const completed = job("job-1", { status: "completed", plannedRuns: 2,
    config: { version: 1, kind: "support", label: "Controller 单方案", repeat: 2, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] },
    results: [
      { variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-a1", summary: supportSummary(2) },
      { variantId: "A", repetition: 2, kind: "support", status: "completed", runId: "run-a2", summary: supportSummary(3) },
    ] });
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "submit POST");
  assert.equal(post.options?.headers?.["X-Experiment-Request"], "1", "提交带 X-Experiment-Request 头");
  assert.equal(JSON.parse(post.options?.body || "{}").kind, "support");
  respond(post, running);
  await flush();
  assert.match(content(root), /正在执行 方案 A · 第 1 次 · 已完成 0 \/ 2/, "活动中进度");
  await sleep(10);
  respond(find(request => request.path === "/api/experiments/job-1", "poll tick"), running);
  await flush();
  await sleep(10);
  const staleTick = find(request => request.path === "/api/experiments/job-1", "second tick");
  // tab 切走：停轮询，晚到的旧响应不得覆盖。
  element("overview-tab").fire("click");
  respond(staleTick, completed);
  await flush();
  await sleep(10);
  assert.equal(pendingCount(), 0, "tab 隐藏后不再轮询");
  // 切回：刷新任务并恢复跟踪到终态。
  element("experiments-tab").fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "re-enter refresh"), { jobs: [completed] });
  await flush();
  await sleep(10);
  for (const request of [find(request => request.path === "/api/experiments/job-1", "resume tick")]) respond(request, completed);
  await flush();
  const html = content(root);
  assert.match(html, /已完成 2 \/ 2/);
  assert.match(html, /场景 通过 2 \/ 3 · 失败 1/, "support summary 计数");
  assert.match(html, /Tokens 已知 1,200 · 完整 1,200/);
  assert.match(html, /单轮耗时 P95 1\.50 s/);
  assert.ok(findAttr(root, "data-action", "view-run"), "查看运行入口");
  assert.equal(pendingCount(), 0, "终态后停止轮询");
  // 带入 A/B 对比：复用既有对比流与门控。
  findAttr(root, "data-action", "compare-btn")!.fire("click");
  await flush(1);
  respond(find(request => request.path.startsWith("/api/compare"), "experiment compare"), {
    baseline: "run-a1", candidate: "run-a2", comparable: true, repeatCompatible: true,
    conditions: ["scope", "suite", "kind", "dataset", "checker", "business", "manifest", "measurement"].map(key => ({ key, status: "equal" })),
    configuration: ["model", "prompt", "skill", "tools", "implementation", "runtime", "settings"].map(key => ({ key, status: "equal" })),
    issues: [], analyses: { baseline: supportSummary(2), candidate: supportSummary(3) }, cases: [],
  });
  respond(find(request => request.path === "/api/runs/run-a1", "baseline detail"), detailOf("run-a1"));
  respond(find(request => request.path === "/api/runs/run-a2", "candidate detail"), detailOf("run-a2"));
  await flush();
  assert.match(content(element("compare-detail")), /场景对比/, "带入后进入既有对比视图");
  assert.equal(element("compare-button").disabled, false, "总览无记录也能再次对比导入的两次运行");
  const retryCompare = element("compare-button").fire("click");
  await flush(1);
  assert.equal(element("compare-button").disabled, true);
  respondError(find(request => request.path.startsWith("/api/compare"), "imported comparison retry failure"), { error: "合成对比失败" });
  await retryCompare;
  assert.equal(element("compare-button").disabled, false, "实验导入对比失败后仍可重试");
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：POST 头、运行轮询、tab 停/续、终态停轮、support 结果与带入对比。");
}

// 检索结果：mode/corpus/suite 分列、用量折叠、CNY 不与 USD 合并、完整量未知不补零。
{
  const booted = await boot();
  const { element, find, flush } = booted;
  const retrievalJob = job("job-rt", { plannedRuns: 1,
    config: { version: 1, kind: "retrieval", label: "检索 M4 消融", repeat: 1, allowRemote: true, variants: [{ id: "A", modes: ["M0", "M4"], parameters: retrievalParams() }] },
    results: [{ variantId: "A", repetition: 1, kind: "retrieval", status: "completed", runId: "rt-1", summary: {
      plannedRows: 98, completedRows: 96, missingRows: 2,
      groups: [
        { mode: "M4", corpus: "selected", suite: "standard", planned: 44, missing: 0, succeeded: 44, failed: 0, recallAt5: 0.8636, plannedRecallAt5: 0.8409, mrrAt5: 0.7932, scopeViolations: 0, noAnswerNonempty: null },
        { mode: "M4", corpus: "full", suite: "hard", planned: 44, missing: 2, succeeded: 40, failed: 2, recallAt5: 0.5, plannedRecallAt5: 0.4545, mrrAt5: 0.42, scopeViolations: 1, boundaryFailures: 1 },
        { mode: "M4", corpus: "full", suite: "no_answer", planned: 10, missing: null, succeeded: 10, failed: null, recallAt5: null, plannedRecallAt5: null, mrrAt5: null, noAnswerNonempty: 6 },
      ],
      usage: [{ operation: "rerank", requests: 713, successfulRequests: 713, cacheHits: 85, reportedRequests: 713, knownTokens: 1453540, completeTokens: null, knownEstimatedCostCny: 0.72677, completeEstimatedCostCny: null }],
    } }] });
  await openExperiments(booted, [retrievalJob]);
  const root = element("experiments");
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-rt", "retrieval job detail"), retrievalJob);
  await flush();
  const html = content(root);
  assert.match(html, /M4/);
  assert.match(html, /选集/);
  assert.match(html, /难题/);
  assert.match(html, /44 \/ 44/);
  assert.match(html, /86\.4% \/ 84\.1%/, "Recall@5 成功与计划口径同格分列");
  assert.match(html, /50\.0% \/ 45\.5%/, "计划口径分母含失败及缺失");
  assert.match(html, /0\.793/, "MRR@5");
  assert.match(html, /MRR@5（成功均值）/, "MRR 口径标清");
  assert.match(html, /计划口径分母含调用失败及缺失/, "口径说明可见");
  assert.match(html, /越界 0/, "诊断列直接可见");
  assert.match(html, /边界失败 1/, "诊断列含 boundaryFailures");
  assert.match(html, /非空召回 6/, "no_answer 行诊断直接可见");
  const naCells = walk(root).filter(item => item.textContent === "未采集");
  assert.ok(naCells.length >= 2, "失败/缺失为 null 时显示未采集，不补零");
  assert.match(html, /缓存命中 85/);
  assert.match(html, /¥0\.726770/, "CNY 费用按币种分列");
  assert.match(html, /完整 未知/, "完整量未知不补零");
  assert.ok(!html.includes("$"), "不得混入 USD");
  const usageFold = findClass(root, "exp-usage");
  assert.ok(usageFold, "检索用量折叠存在");
  assert.notEqual(usageFold.open, true, "检索用量默认折叠");
  assert.match(html, /原始 summary JSON/);
  assert.match(html, /未记录证据接收指标（旧版原始报告）/, "纯 raw 旧历史没有 acceptance 显示未记录");
  console.log("PASS 实验调试：检索结果分列、用量默认折叠、CNY 不合并、完整量未知不补零。");
}

// 中断任务：未执行明示、错误可见、载入配置复现、提交失败保留可重试表单。
{
  const booted = await boot();
  const { element, find, flush } = booted;
  const interrupted = job("job-x", { status: "interrupted", plannedRuns: 3, error: "执行中断：worker 重启",
    config: { version: 1, kind: "support", label: "中断的实验", repeat: 3, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-x1", summary: supportSummary(3) }] });
  await openExperiments(booted, [interrupted]);
  const root = element("experiments");
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-x", "interrupted detail"), interrupted);
  await flush();
  const html = content(root);
  assert.match(html, /已中断/);
  assert.match(html, /未执行 2 次；中断及未执行的重复不算通过/, "未执行明示");
  assert.match(html, /执行中断：worker 重启/, "错误文本可见");
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(findAttr(root, "data-field", "exp-label")!.value, "中断的实验", "载入配置复现到表单");
  const presetSelect = findAttr(root, "data-field", "preset")!;
  assert.equal(presetSelect.value, "", "载入配置后预设显示自定义占位");
  assert.match(content(presetSelect.children[0]!), /自定义配置/, "占位 option 文案");
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  respondError(find(request => request.path === "/api/experiments" && request.options?.method === "POST", "conflict POST"), { error: "已有活动实验。" });
  await flush();
  assert.match(content(root), /已有活动实验/, "提交失败错误保留在表单");
  assert.equal(findClass(root, "primary-button")!.disabled, false, "失败后可重试，按钮不卡死");
  console.log("PASS 实验调试：中断未执行明示、载入配置复现、提交失败可重试。");
}

// 任务详情竞态：快速切换任务时，晚到的旧详情不覆盖当前选择。
{
  const booted = await boot();
  const { element, find, flush, pendingCount, activeElement } = booted;
  await openExperiments(booted, [
    job("job-1", { status: "running", finishedAt: null, config: { version: 1, kind: "support", label: "任务甲", repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "atomic", parameters: supportParams() }] } }),
    job("job-2", { config: { version: 1, kind: "support", label: "任务乙", repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] } }),
  ]);
  const root = element("experiments");
  const jobs = walk(root).filter(item => item.className.split(" ").includes("exp-job"));
  jobs[0]!.fire("click");
  await flush(1);
  const stale = find(request => request.path === "/api/experiments/job-1", "first job detail");
  jobs[1]!.focus();
  jobs[1]!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-2", "second job detail"), job("job-2", { config: { version: 1, kind: "support", label: "任务乙", repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] } }));
  await flush();
  const detail = () => content(findAttr(root, "aria-label", "任务详情")!);
  assert.match(detail(), /任务乙/);
  respond(stale, job("job-1", { config: { version: 1, kind: "support", label: "任务甲", repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "atomic", parameters: supportParams() }] } }));
  await flush();
  assert.match(detail(), /任务乙/, "晚到的旧详情不得覆盖当前选择");
  assert.ok(!detail().includes("任务甲") || detail().indexOf("任务甲") < 0, "旧任务标签不进入详情面板");
  assert.equal(content(findClass(jobs[0]!, "status")!), "运行中", "迟到的甲详情不能串改甲列表快照");
  assert.equal(content(findClass(jobs[1]!, "status")!), "已完成", "当前乙行按乙详情显示");
  assert.equal(content(findClass(jobs[1]!, "case-meta")!), "0 / 1");
  assert.equal(activeElement(), jobs[1], "旧详情到达保持乙按钮焦点");
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：任务详情竞态，旧响应不覆盖当前选择。");
}

// 首次详情直达终态与旧列表晚到，都必须让当前行显示同一状态/完整分母。
const terminalRows: Array<{ path: string; status: string; count: string }> = [];
{
  const booted = await boot(), { element, find, flush, activeElement, pendingCount } = booted;
  const firstResult = { variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "direct-run-1", summary: supportSummary(2) };
  const running = job("same-prefix-job-a", { status: "running", finishedAt: null, plannedRuns: 3,
    current: { variantId: "A", repetition: 2 }, results: [firstResult] });
  const other = job("same-prefix-job-b", { status: "completed_with_failures", plannedRuns: 4, results: [firstResult] });
  await openExperiments(booted, [structuredClone(running), structuredClone(other)]);
  const root = element("experiments"), buttons = walk(root).filter(item => item.className.split(" ").includes("exp-job"));
  const selected = buttons[0]!, otherButton = buttons[1]!, otherText = content(otherButton);
  const advanced = findClass(root, "exp-advanced")!; advanced.open = true;
  selected.focus(); selected.fire("click");
  const panel = findAttr(root, "aria-label", "任务详情")!, config = findClass(panel, "exp-job-config")!;
  const trace = findClass(panel, "trace")!; trace.open = true;
  const traceJson = trace.children[1]!;
  const terminal = { ...running, status: "interrupted", current: null, finishedAt: T, error: "合成中断", results: [firstResult,
    { ...firstResult, repetition: 2, runId: "direct-run-2", summary: supportSummary(1) }] };
  respond(find(request => request.path === "/api/experiments/same-prefix-job-a", "first terminal detail"), terminal); await flush();
  terminalRows.push({ path: "首次详情终态", status: content(findClass(selected, "status")!), count: content(findClass(selected, "case-meta")!) });
  assert.match(content(panel), /已中断已完成 2 \/ 3/);
  assert.match(content(panel), /未执行 1 次/);
  assert.equal(walk(root).filter(item => item.className.split(" ").includes("exp-job"))[0], selected);
  assert.equal(content(otherButton), otherText, "相同前缀的其他完整 ID 不串改");
  assert.equal(findAttr(root, "aria-label", "任务详情"), panel);
  assert.equal(findClass(panel, "exp-job-config"), config);
  assert.equal(findClass(panel, "trace"), trace); assert.equal(trace.open, true);
  assert.equal(trace.children[1], traceJson, "已完成结果 JSON 保留文本节点");
  assert.equal(findClass(root, "exp-advanced"), advanced); assert.equal(advanced.open, true);
  assert.equal(activeElement(), selected);
  assert.equal(pendingCount(), 0, "首次终态不发起轮询");
  const refresh = findAttr(root, "data-action", "refresh-jobs")!; refresh.fire("click");
  find(request => request.path === "/api/experiments", "terminal list error").reject(new Error("合成列表失败")); await flush();
  assert.match(content(root), /合成列表失败/);
  assert.equal(refresh.disabled, false);
  assert.equal(content(findClass(selected, "status")!), terminalRows[0]!.status, "列表失败保留当前已知行状态");
  assert.equal(content(findClass(selected, "case-meta")!), terminalRows[0]!.count);
  assert.equal(findAttr(root, "aria-label", "任务详情"), panel);
  assert.equal(activeElement(), selected); assert.equal(trace.open, true); assert.equal(pendingCount(), 0);
}

// 列表请求先发出 → 详情返回 completed → 旧列表 running 晚到，当前行与详情都不得退回旧进度。
{
  const booted = await boot();
  const { element, find, flush, pendingCount, activeElement } = booted;
  const staleListed = job("job-s", { status: "running", finishedAt: null, plannedRuns: 1, current: { variantId: "A", repetition: 1 } });
  await openExperiments(booted, [staleListed]);
  const root = element("experiments");
  const selected = findClass(root, "exp-job")!;
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  const staleList = find(request => request.path === "/api/experiments", "stale list before terminal");
  selected.focus(); selected.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-s", "job detail"), job("job-s", {
    plannedRuns: 1, results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-s1", summary: supportSummary(3) }],
  }));
  await flush();
  const detail = () => content(findAttr(root, "aria-label", "任务详情")!);
  assert.match(detail(), /已完成 1 \/ 1/);
  // 旧列表快照（running）晚到：保留当前详情并用其显示同 ID 行。
  respond(staleList, { jobs: [staleListed] });
  await flush();
  assert.match(detail(), /已完成 1 \/ 1/, "旧列表 running 响应不得覆盖已完成详情");
  assert.ok(!detail().includes("运行中"), "详情不得停在旧进度");
  terminalRows.push({ path: "旧列表晚到", status: content(findClass(selected, "status")!), count: content(findClass(selected, "case-meta")!) });
  assert.equal(findClass(root, "exp-job"), selected);
  assert.equal(activeElement(), selected);
  assert.equal(pendingCount(), 0);
  assert.ok(findAttr(root, "aria-label", "实验任务")!.children.length > 0);
}
assert.deepEqual(terminalRows, [
  { path: "首次详情终态", status: "已中断", count: "2 / 3" },
  { path: "旧列表晚到", status: "已完成", count: "1 / 1" },
], "当前任务行必须和详情终态一致，保留完整计划分母");
console.log("PASS 实验调试：首次终态/旧列表晚到保持当前行状态分母，其他 ID、错误及原节点/焦点/展开保持。");

// 轮询不重建表单：输入中值、节点身份与高级参数展开态在轮询后保持不变。
{
  const booted = await boot();
  const { element, find, context, flush } = booted;
  const running = job("job-p", { status: "running", finishedAt: null, plannedRuns: 2, current: { variantId: "A", repetition: 1 } });
  await openExperiments(booted, [running]);
  const root = element("experiments");
  runInContext("expState.pollMs = 1", context);
  // 用户正在编辑：标签输入进行中值（未触发 change）、高级参数已展开、数字输入进行中值。
  const labelInput = findAttr(root, "data-field", "exp-label")!;
  labelInput.value = "编辑中的新名称";
  const advanced = findClass(root, "exp-advanced")!;
  advanced.open = true;
  const timeoutInput = findAllAttr(root, "data-field", "timeoutMs").find(item => item.attrs.get("data-variant") === "A")!;
  timeoutInput.value = "99999";
  // 选中运行任务并等待两轮轮询完成。
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-p", "job detail"), running);
  await flush();
  await sleep(10);
  respond(find(request => request.path === "/api/experiments/job-p", "poll tick 1"), running);
  await flush();
  await sleep(10);
  respond(find(request => request.path === "/api/experiments/job-p", "poll tick 2"), running);
  await flush();
  assert.match(content(findAttr(root, "aria-label", "任务详情")!), /正在执行 方案 A/, "任务区已按轮询更新");
  assert.equal(findAttr(root, "data-field", "exp-label"), labelInput, "轮询不得替换表单节点");
  assert.equal(labelInput.value, "编辑中的新名称", "输入中值不被轮询冲掉");
  assert.equal(findClass(root, "exp-advanced"), advanced, "高级参数节点不被重建");
  assert.equal(advanced.open, true, "高级参数展开态保持");
  assert.equal(timeoutInput.value, "99999", "未提交的数字输入不被重置");
  console.log("PASS 实验调试：轮询只刷任务区，表单节点、输入中值与展开态保持。");
}

// 同任务轮询保留任务按钮、配置与已完成结果的 details；新进度/结果/终态仍更新。
{
  const booted = await boot();
  const { element, find, context, flush, pendingCount } = booted;
  const firstResult = { variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "stable-run-1", summary: supportSummary(2) };
  const running = job("stable-job", { status: "running", finishedAt: null, plannedRuns: 3,
    current: { variantId: "A", repetition: 2 }, results: [firstResult] });
  await openExperiments(booted, [structuredClone(running)]);
  const root = element("experiments");
  runInContext("expState.pollMs = 1", context);
  const taskButton = findClass(root, "exp-job")!;
  taskButton.fire("click");
  respond(find(request => request.path === "/api/experiments/stable-job", "stable job detail"), structuredClone(running));
  await flush();
  const selectedButton = findClass(root, "exp-job")!;
  assert.equal(selectedButton, taskButton, "选择任务本身也保留键盘激活的按钮");
  const panel = findAttr(root, "aria-label", "任务详情")!;
  const config = findClass(panel, "exp-job-config")!;
  const result = findClass(panel, "exp-result")!;
  const details = findClass(result, "trace")!;
  details.open = true;
  const resultText = details.children[1]!;
  const summaryControl = details.children[0]!;
  await sleep(10);
  respond(find(request => request.path === "/api/experiments/stable-job", "unchanged poll"), structuredClone(running));
  await flush();
  assert.equal(findClass(root, "exp-job"), selectedButton, "无变化轮询不移除当前任务按钮");
  assert.equal(findAttr(root, "aria-label", "任务详情"), panel);
  assert.equal(findClass(panel, "exp-job-config"), config);
  assert.equal(findClass(panel, "trace"), details, "原始JSON details不被重建");
  assert.equal(details.open, true, "JSON展开态保持");
  assert.equal(details.children[0], summaryControl, "键盘聚焦的summary节点保持");
  assert.equal(details.children[1], resultText, "已完成JSON的文本选择节点保持");

  await sleep(10);
  const progressing = { ...running, current: { variantId: "A", repetition: 3 } };
  respond(find(request => request.path === "/api/experiments/stable-job", "progress poll"), structuredClone(progressing));
  await flush();
  assert.match(content(panel), /第 3 次 · 已完成 1 \/ 3/, "真实进度继续更新");
  assert.equal(findClass(panel, "exp-result"), result, "进度改变不移除已完成结果");
  assert.equal(details.open, true);

  await sleep(10);
  const secondResult = { ...firstResult, repetition: 2, runId: "stable-run-2", summary: supportSummary(3) };
  const interrupted = { ...progressing, status: "interrupted", current: null, error: "第二批中断", results: [firstResult, secondResult] };
  respond(find(request => request.path === "/api/experiments/stable-job", "result append/terminal poll"), structuredClone(interrupted));
  await flush();
  assert.equal(findClass(root, "exp-job"), selectedButton);
  assert.equal(findClass(panel, "exp-job-config"), config);
  assert.equal(findClass(panel, "exp-result"), result);
  assert.equal(details.open, true);
  assert.match(content(panel), /已完成 2 \/ 3/);
  assert.match(content(panel), /未执行 1 次/);
  assert.match(content(panel), /第二批中断/);
  assert.ok(findAttr(panel, "data-action", "compare-btn"), "新增第二个结果后出现对比入口");
  const resultNodes = walk(panel).filter(item => item.className.split(" ").includes("exp-result"));
  assert.equal(resultNodes.length, 2);
  await sleep(10);
  assert.equal(pendingCount(), 0, "终态停止轮询");

  const retry = runInContext('selectJob("stable-job", true)', context);
  const corrected = { ...interrupted, results: [{ ...firstResult, summary: supportSummary(1) }, secondResult] };
  respond(find(request => request.path === "/api/experiments/stable-job", "revised result"), structuredClone(corrected));
  await retry;
  assert.match(content(panel), /场景 通过 1 \/ 3 · 失败 2/, "服务端修订结果不能被旧DOM吞掉");
  const revisedNodes = walk(panel).filter(item => item.className.split(" ").includes("exp-result"));
  assert.notEqual(revisedNodes[0], result);
  assert.equal(revisedNodes[1], resultNodes[1], "修订一个结果不重建其他结果");
  runInContext('selectJob("stable-job", true)', context);
  find(request => request.path === "/api/experiments/stable-job", "retry error").reject(new Error("合成详情读取失败"));
  await flush();
  assert.match(content(root), /合成详情读取失败/);
  const retryControl = findAttr(root, "data-action", "retry-jobs")!;
  const retrying = retryControl.fire("click");
  assert.equal(selectedButton.focused, true, "重试焦点转回同一任务按钮");
  respond(find(request => request.path === "/api/experiments/stable-job", "retry recovery"), structuredClone(corrected));
  await retrying;
  assert.ok(!content(root).includes("合成详情读取失败"), "成功重试清除旧错误");
  assert.equal(findAttr(root, "data-action", "retry-jobs"), retryControl, "重试控件保持稳定");
  assert.equal(findAttr(root, "aria-label", "任务详情"), panel);
  assert.equal(walk(panel).filter(item => item.className.split(" ").includes("exp-result"))[1], resultNodes[1]);
  console.log("PASS 实验调试：任务按钮/配置/已完成JSON节点稳定，真实进度、追加/修订结果与终态更新。");
}

// 连续调参：参数 change 只写 draft 并局部更新差异/提示，参数卡与输入节点不重建，可继续改第二项。
{
  const booted = await boot();
  const { element, flush } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "retrieval-rerank";
  preset.fire("change");
  await flush();
  findAttr(root, "data-action", "copy-b")!.fire("click");
  await flush();
  const advanced = findClass(root, "exp-advanced")!;
  advanced.open = true;
  const topKA = () => findAllAttr(root, "data-field", "candidateTopK").find(item => item.attrs.get("data-variant") === "A")!;
  const first = topKA()!;
  first.value = "30";
  first.fire("change");
  await flush();
  assert.equal(findClass(root, "exp-advanced"), advanced, "参数卡不被重建");
  assert.equal(advanced.open, true, "高级参数保持展开");
  assert.equal(topKA(), first, "当前输入节点不被替换");
  assert.match(content(root), /candidateTopK 30 → 20/, "差异局部更新");
  const maxA = () => findAllAttr(root, "data-field", "maxRequests").find(item => item.attrs.get("data-variant") === "A")!;
  const second = maxA()!;
  second.value = "500";
  second.fire("change");
  await flush();
  assert.match(content(root), /每次运行请求上限 500 \/ 1000/, "提示局部更新，可继续改第二项");
  assert.equal(maxA(), second, "第二项输入节点不被替换");
  assert.equal(findClass(root, "exp-advanced"), advanced, "连续调参后参数卡仍保持");
  console.log("PASS 实验调试：连续调参不重建参数卡，差异与提示局部更新。");
}

// 刷新按钮解锁：成功/失败后按钮恢复可点，能连续第二次刷新。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const refresh = () => findAttr(root, "data-action", "refresh-jobs")!;
  // 成功路径：完成后按钮恢复，第二次点击再次发出请求。
  refresh().fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "first refresh"), { jobs: [] });
  await flush();
  assert.equal(refresh().disabled, false, "成功刷新后按钮恢复可点");
  refresh().fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "second refresh"), { jobs: [] });
  await flush();
  assert.equal(refresh().disabled, false, "可连续第二次刷新");
  assert.equal(pendingCount(), 0);
  // 失败路径：错误可见且按钮不卡死，还能再次重试。
  refresh().fire("click");
  await flush(1);
  find(request => request.path === "/api/experiments", "failing refresh").reject(new Error("评测数据库暂不可用。"));
  await flush();
  assert.match(content(root), /评测数据库暂不可用/, "刷新失败错误可见");
  assert.equal(refresh().disabled, false, "失败刷新后按钮恢复可点");
  refresh().fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "retry refresh"), { jobs: [] });
  await flush();
  assert.equal(refresh().disabled, false);
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：成功/失败刷新后按钮恢复可点，可连续刷新。");
}

// 共享错误条按失败来源重试；成功只清同来源错误，不能用详情成功冒充列表恢复。
for (const selected of [true, false]) {
  const booted = await boot(), { element, find, take, flush, activeElement, pendingCount } = booted;
  const first = job("retry-first", { results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "retry-run", summary: supportSummary(2) }] });
  await openExperiments(booted, [first]);
  const root = element("experiments"), row = findClass(root, "exp-job")!;
  if (selected) {
    row.fire("click"); respond(find(request => request.path === "/api/experiments/retry-first", "selected retry detail"), first); await flush();
  }
  const panel = selected ? findAttr(root, "aria-label", "任务详情")! : null;
  const trace = panel ? findClass(panel, "trace")! : null; if (trace) trace.open = true;
  const refresh = findAttr(root, "data-action", "refresh-jobs")!;
  refresh.fire("click"); find(request => request.path === "/api/experiments", "list failure").reject(new Error("集合读取失败")); await flush();
  const error = findClass(findAttr(root, "aria-label", "实验任务")!, "batch-caution")!;
  const retry = findAttr(root, "data-action", "retry-jobs")!;
  retry.fire("click");
  const failedRetry = take();
  assert.equal(failedRetry.path, "/api/experiments", `列表错误红条重试必须读取集合（selected=${selected}）`);
  assert.equal(activeElement(), refresh, "列表重试焦点交接现有刷新入口");
  failedRetry.reject(new Error("集合重试仍失败")); await flush();
  assert.equal(error.hidden, false); assert.match(content(error), /集合重试仍失败/);
  assert.equal(findAttr(root, "data-action", "retry-jobs"), retry);
  retry.fire("click");
  respond(find(request => request.path === "/api/experiments", "successful collection retry"), { jobs: [first, job("newly-discovered")] }); await flush();
  assert.equal(error.hidden, true, "集合自身成功才清列表错误");
  const rows = walk(root).filter(item => item.className.split(" ").includes("exp-job"));
  assert.equal(rows[0], row); assert.equal(rows.length, 2); assert.match(content(rows[1]!), /newly-discovered/);
  if (panel) { assert.equal(findAttr(root, "aria-label", "任务详情"), panel); assert.equal(findClass(panel, "trace"), trace); assert.equal(trace!.open, true); }
  assert.equal(activeElement(), refresh); assert.equal(pendingCount(), 0);
}
{
  const booted = await boot(), { element, find, take, flush, activeElement, pendingCount } = booted;
  const a = job("error-epoch-a"), b = job("error-epoch-b");
  await openExperiments(booted, [a, b]);
  const root = element("experiments"), rows = walk(root).filter(item => item.className.split(" ").includes("exp-job"));
  rows[0]!.fire("click"); const stale = find(request => request.path === "/api/experiments/error-epoch-a", "old error detail");
  rows[1]!.focus(); rows[1]!.fire("click"); const current = find(request => request.path === "/api/experiments/error-epoch-b", "current error detail");
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  find(request => request.path === "/api/experiments", "current collection error").reject(new Error("当前集合错误")); await flush();
  stale.reject(new Error("旧甲详情错误")); respond(current, b); await flush();
  const error = findClass(findAttr(root, "aria-label", "实验任务")!, "batch-caution")!;
  assert.equal(error.hidden, false); assert.match(content(error), /当前集合错误/); assert.ok(!content(error).includes("旧甲详情错误"));
  assert.equal(activeElement(), rows[1]); assert.match(content(findAttr(root, "aria-label", "任务详情")!), /error-epoch-b/);
  findAttr(root, "data-action", "retry-jobs")!.fire("click"); const retry = take(); assert.equal(retry.path, "/api/experiments", "迟到旧错误不得改变当前集合重试来源");
  respond(retry, { jobs: [a, b] }); await flush(); assert.equal(error.hidden, true); assert.equal(pendingCount(), 0);
}
for (const source of ["detail", "poll"]) {
  const booted = await boot(), { element, find, take, context, flush, activeElement, pendingCount } = booted;
  const running = job("source-current", { status: "running", finishedAt: null });
  await openExperiments(booted, [running]); runInContext("expState.pollMs = 1", context);
  const root = element("experiments"), row = findClass(root, "exp-job")!;
  row.fire("click");
  const initial = find(request => request.path === "/api/experiments/source-current", "source detail");
  if (source === "poll") { respond(initial, running); await flush(); await sleep(10); }
  const failure = source === "poll" ? find(request => request.path === "/api/experiments/source-current", "source poll") : initial;
  failure.reject(new Error(`${source}读取失败`)); await flush();
  const error = findClass(findAttr(root, "aria-label", "实验任务")!, "batch-caution")!;
  const panel = findAttr(root, "aria-label", "任务详情")!;
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  respond(find(request => request.path === "/api/experiments", "other source collection success"), { jobs: [running, job("new-list-row")] }); await flush();
  assert.equal(error.hidden, false, "列表成功不能清详情或轮询错误"); assert.match(content(error), new RegExp(`${source}读取失败`));
  const retry = findAttr(root, "data-action", "retry-jobs")!; retry.fire("click");
  const retryFailure = take(); assert.equal(retryFailure.path, "/api/experiments/source-current");
  assert.equal(activeElement(), row); retryFailure.reject(new Error("详情重试仍失败")); await flush();
  assert.equal(error.hidden, false); assert.match(content(error), /详情重试仍失败/);
  retry.fire("click"); respond(find(request => request.path === "/api/experiments/source-current", "source recovery"), job("source-current")); await flush();
  assert.equal(error.hidden, true); assert.equal(findAttr(root, "aria-label", "任务详情"), panel);
  assert.equal(findClass(root, "exp-job"), row); assert.equal(activeElement(), row); assert.equal(pendingCount(), 0);
}
for (const success of ["detail", "poll"]) {
  const booted = await boot(), { element, find, take, context, flush, pendingCount } = booted;
  const current = job("list-error-current", success === "poll" ? { status: "running", finishedAt: null } : {});
  const other = job("list-error-other");
  await openExperiments(booted, [current, other]); runInContext("expState.pollMs = 1", context);
  const root = element("experiments"), rows = walk(root).filter(item => item.className.split(" ").includes("exp-job"));
  rows[0]!.fire("click"); respond(find(request => request.path === "/api/experiments/list-error-current", "initial list error detail"), current); await flush();
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  find(request => request.path === "/api/experiments", "independent list failure").reject(new Error("集合错误须保留")); await flush();
  if (success === "poll") {
    await sleep(10); respond(find(request => request.path === "/api/experiments/list-error-current", "independent poll success"), job("list-error-current"));
  } else {
    rows[1]!.fire("click"); respond(find(request => request.path === "/api/experiments/list-error-other", "independent detail success"), other);
  }
  await flush();
  const error = findClass(findAttr(root, "aria-label", "实验任务")!, "batch-caution")!;
  assert.equal(error.hidden, false, `${success}成功不得清另一来源的列表错误`); assert.match(content(error), /集合错误须保留/);
  findAttr(root, "data-action", "retry-jobs")!.fire("click"); const collection = take(); assert.equal(collection.path, "/api/experiments");
  respond(collection, { jobs: [job("list-error-current"), other] }); await flush();
  assert.equal(error.hidden, true); assert.equal(pendingCount(), 0);
}
{
  const booted = await boot(), { element, take, find, flush, pendingCount } = booted;
  respond(take(), { runs: [] }); await flush(); element("experiments-tab").fire("click");
  find(request => request.path === "/api/experiments/catalog", "catalog failure").reject(new Error("目录读取失败"));
  respond(find(request => request.path === "/api/experiments", "initial collection"), { jobs: [] }); await flush();
  const root = element("experiments"); assert.match(content(root), /暂时无法读取实验目录.*目录读取失败/);
  walk(root).find(item => item.tagName === "BUTTON" && content(item) === "重试")!.fire("click");
  respond(find(request => request.path === "/api/experiments/catalog", "catalog retry"), catalog());
  respond(find(request => request.path === "/api/experiments", "catalog paired collection retry"), { jobs: [job("catalog-recovered")] }); await flush();
  assert.ok(!content(root).includes("目录读取失败")); assert.match(content(findClass(root, "exp-job")!), /catalog-recovered/);
  assert.equal(pendingCount(), 0);
}
console.log("PASS 实验调试：错误来源重试真实集合/当前详情，异源成功不清错，目录恢复及稳定行/展开/焦点保持。");

// v2 表单：数据集/接收策略回填、阈值启停、组合校验禁提交不丢字段、编辑不重建、提交体原样。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "acceptance-development";
  preset.fire("change");
  await flush();
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  const byMode = (mode: string, variant: string) => findAllAttr(root, "data-mode", mode).find(item => item.attrs.get("data-variant") === variant)!;
  for (const variant of ["A", "B"]) for (const [field, name] of [["acceptance-mode", "证据接收策略"], ["acceptance-threshold", "接收分数阈值"]] as const) {
    const control = byField(field, variant);
    const label = walk(root).find(item => item.tagName === "LABEL" && item.children.includes(control));
    assert.ok(label, `方案 ${variant} 的 ${name} 必须有原生 label 关联`);
    assert.equal(content(findClass(label, "exp-field-label")!), name);
    assert.equal(label.children.filter(item => item.tagName === "INPUT" || item.tagName === "SELECT").length, 1, "每个 label 只关联一个控件");
  }
  console.log("PASS 实验调试：v2 A/B 策略及阈值四控件均有原生 label 关联，标签文案保留。");
  assert.match(content(root), /数据集/);
  assert.match(content(root), /证据接收策略/);
  assert.equal(byField("dataset", "A").value, "acceptance-development");
  assert.equal(byField("acceptance-mode", "A").value, "off");
  assert.equal(byField("acceptance-threshold", "A").disabled, true, "off 时阈值禁用");
  assert.equal(byField("acceptance-mode", "B").value, "score");
  assert.equal(byField("acceptance-threshold", "B").disabled, false, "score 时阈值启用");
  assert.equal(byField("acceptance-threshold", "B").value, "0.71");
  assert.match(content(root), /接收 off → score 0\.71/, "差异含接收策略");
  // 阈值编辑不重建输入节点。
  const thB = byField("acceptance-threshold", "B");
  thB.value = "0.65";
  thB.fire("change");
  await flush();
  assert.equal(byField("acceptance-threshold", "B"), thB, "阈值编辑不重建输入节点");
  assert.match(content(root), /score 0\.65/, "差异局部更新");
  // 组合校验：B 加选 M0 → 错误禁提交，且模式不被偷偷改回。
  const m0B = byMode("M0", "B");
  m0B.checked = true;
  m0B.fire("change");
  await flush();
  assert.match(content(root), /score\/support 接收仅支持 M4\/M5\/M6/);
  assert.equal(findClass(root, "primary-button")!.disabled, true, "score 与非 rerank 组合禁提交");
  assert.equal(byMode("M0", "B").checked, true, "不丢字段、不偷偷改模式");
  m0B.checked = false;
  m0B.fire("change");
  await flush();
  assert.ok(!content(root).includes("接收仅支持"), "恢复合法组合后错误消失");
  // A 切 score 无阈值 → 提示显式填写；填 0.5 后恢复；再切回 off。
  const modeA = byField("acceptance-mode", "A");
  modeA.value = "score";
  modeA.fire("change");
  await flush();
  assert.equal(byField("acceptance-threshold", "A").disabled, false, "切 score 后阈值启用");
  assert.match(content(root), /请显式填写 0–1 的接收阈值/);
  assert.equal(findClass(root, "primary-button")!.disabled, true, "缺阈值禁提交");
  const thA = byField("acceptance-threshold", "A");
  thA.value = "0.5";
  thA.fire("change");
  await flush();
  assert.ok(!content(root).includes("请显式填写"), "填阈值后错误消失");
  modeA.value = "off";
  byField("acceptance-mode", "A").fire("change");
  await flush();
  assert.equal(byField("acceptance-threshold", "A").disabled, true, "切回 off 阈值重新禁用");
  // 提交体：off 方案只含 mode，score 方案带显式阈值，数据集原样。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "v2 POST");
  assert.equal(post.options?.headers?.["X-Experiment-Request"], "1");
  const body = JSON.parse(post.options?.body || "{}");
  assert.equal(body.version, 2);
  assert.equal(body.variants[0].dataset, "acceptance-development");
  assert.deepEqual(body.variants[0].acceptance, { mode: "off" }, "off 方案不得携带阈值");
  assert.deepEqual(body.variants[1].acceptance, { mode: "score", threshold: 0.65 });
  respond(post, job("job-v2", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：v2 表单回填、阈值启停、组合校验、编辑不重建、提交体原样。");
}

// v2 结果：接收指标分表、分子/分母明示、空分母不适用、context 待 C1、策略标签与口径声明；载入配置完整回填。
{
  const booted = await boot();
  const { element, find, flush } = booted;
  const accGroup = (suite: string, raw: Record<string, unknown> = {}, acc: Record<string, unknown> = {}) => ({
    mode: "M4", corpus: "selected", suite, planned: 42, missing: 0, succeeded: 42, failed: 0, notApplicable: 0, measured: 42,
    recallAt5: 0.9, plannedRecallAt5: 0.88, mrrAt5: 0.85, scopeViolations: 0, boundaryFailures: 0, ...raw,
    acceptance: {
      planned: 42, applicablePlanned: 42, measured: 42, missing: 0, failed: 0, notApplicable: 0, deferred: 0,
      plannedAnswerable: 42, answerableMeasured: 40, recallAt5: 0.7, plannedRecallAt5: 0.6667, mrrAt5: 0.66,
      coveredCases: 30, coverage: 30 / 42, plannedCoverage: 30 / 42,
      noAnswerFalseAcceptCases: 0, noAnswerDenominator: 0, noAnswerPlanned: 0, noAnswerFalseAcceptRate: null,
      abstentionFalseAcceptCases: 0, abstentionDenominator: 0, abstentionPlanned: 0, abstentionFalseAcceptRate: null,
      answerableFalseRejectCases: 2, answerableFalseRejectDenominator: 38, answerableFalseRejectRate: 2 / 38,
      scopeViolations: 0, boundaryFailures: 1, ...acc,
    },
  });
  const summaryA = {
    plannedRows: 59, completedRows: 59, missingRows: 0,
    groups: [
      accGroup("standard"),
      accGroup("no_answer", { planned: 10, succeeded: 10, recallAt5: null, plannedRecallAt5: null, mrrAt5: null, noAnswerNonempty: 4 }, {
        planned: 10, applicablePlanned: 10, measured: 10, plannedAnswerable: 0, answerableMeasured: 0,
        recallAt5: null, plannedRecallAt5: null, mrrAt5: null, coveredCases: 1, coverage: 0.1, plannedCoverage: 0.1,
        noAnswerFalseAcceptCases: 1, noAnswerDenominator: 10, noAnswerPlanned: 10, noAnswerFalseAcceptRate: 0.1,
        abstentionFalseAcceptCases: 1, abstentionDenominator: 10, abstentionPlanned: 10, abstentionFalseAcceptRate: 0.1,
        answerableFalseRejectCases: 0, answerableFalseRejectDenominator: 0, answerableFalseRejectRate: null, boundaryFailures: 0,
      }),
      accGroup("scope", { planned: 1, succeeded: 1, measured: 1, recallAt5: null, plannedRecallAt5: null, mrrAt5: null }, {
        planned: 1, applicablePlanned: 1, measured: 1, plannedAnswerable: 0, answerableMeasured: 0,
        recallAt5: null, plannedRecallAt5: null, mrrAt5: null, coveredCases: 1, coverage: 1, plannedCoverage: 1,
        abstentionFalseAcceptCases: 1, abstentionDenominator: 1, abstentionPlanned: 1, abstentionFalseAcceptRate: 1,
        answerableFalseRejectCases: 0, answerableFalseRejectDenominator: 0, answerableFalseRejectRate: null,
        scopeViolations: 0, boundaryFailures: 0,
      }),
      accGroup("context", { planned: 6, succeeded: 0, notApplicable: 6, measured: 0, recallAt5: null, plannedRecallAt5: null, mrrAt5: null }, {
        planned: 6, applicablePlanned: 0, measured: 0, notApplicable: 6, deferred: 6, plannedAnswerable: 0, answerableMeasured: 0,
        recallAt5: null, plannedRecallAt5: null, mrrAt5: null, coveredCases: 0, coverage: null, plannedCoverage: null,
        answerableFalseRejectCases: 0, answerableFalseRejectDenominator: 0, answerableFalseRejectRate: null, boundaryFailures: 0,
      }),
    ],
    usage: [],
  };
  const v2Config = { version: 2, kind: "retrieval", label: "A1 开发验收", repeat: 1, allowRemote: true, variants: [
    { id: "A", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "off" }, parameters: retrievalParams() },
    { id: "B", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "score", threshold: 0.8 }, parameters: retrievalParams() }] };
  const v2Job = job("job-acc", { plannedRuns: 2, config: v2Config,
    results: [
      { variantId: "A", repetition: 1, kind: "retrieval", status: "completed", runId: "rt-a", summary: summaryA },
      { variantId: "B", repetition: 1, kind: "retrieval", status: "completed", runId: "rt-b", summary: {
        plannedRows: 42, completedRows: 42, missingRows: 0, groups: [accGroup("standard", {}, {
          recallAt5: 0.72, plannedRecallAt5: 0.68,
          abstentionFalseAcceptCases: undefined, abstentionDenominator: undefined, abstentionPlanned: undefined, abstentionFalseAcceptRate: undefined,
        })], usage: [] } },
    ] });
  await openExperiments(booted, [v2Job]);
  const root = element("experiments");
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-acc", "v2 job detail"), v2Job);
  await flush();
  const html = content(root);
  assert.match(html, /证据接收：A1 开发集（48 题） · off 诊断基线（范围内原始 Top5）/, "off 标诊断基线并区分数据集");
  assert.match(html, /证据接收：A1 开发集（48 题） · score 实验阈值 0\.8；是否达标见指标/, "score 标实验阈值，不称试值或固定验证");
  assert.match(html, /接收后 Recall@5/);
  assert.match(html, /70\.0% \/ 66\.7%/, "接收后 Recall 双口径");
  assert.match(html, /30 \/ 42（71\.4%）/, "覆盖率分子分母");
  assert.match(html, /2 \/ 38（5\.3%）/, "误拒分子分母");
  assert.match(html, /无答案 1 \/ 10（10\.0%）/, "无答案误接收分子分母");
  assert.match(html, /预期拒答 1 \/ 10（10\.0%）/, "预期拒答误接收含无答案");
  assert.match(html, /预期拒答 1 \/ 1（100\.0%）/, "scope 违规 0 但预期拒答误接收 1/1 不被掩盖");
  assert.match(html, /预期拒答 不适用/, "0 分母显示不适用");
  assert.match(html, /预期拒答 未记录/, "旧报告缺 abstention 字段显示未记录");
  assert.match(html, /无答案 不适用/, "非无答案行的无答案误接收为不适用，两行明确区分");
  assert.match(html, /0 \/ 0（不适用）/, "已测为 0 不补零");
  assert.match(html, /上下文/, "context 显示上下文");
  assert.match(html, /待 C1 6/, "deferred 显示待 C1");
  assert.match(html, /context（上下文）题为待 C1 计划项/, "有 context 数据时才说明待 C1");
  assert.match(html, /离线实验结果，非上线效果/, "口径声明");
  assert.match(html, /任务完成不等于门槛通过/, "不把执行完成显示为策略验收通过");
  // 误接收分母 0 与误拒分母 0 均为不适用。
  const cells = walk(root).filter(item => item.textContent === "不适用");
  assert.ok(cells.length >= 2, "空分母显示不适用");
  // 载入配置完整回填 v2 字段，差异含 dataset/acceptance。
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  assert.equal(byField("dataset", "A").value, "acceptance-development", "历史 v2 数据集回填");
  assert.equal(byField("acceptance-mode", "A").value, "off");
  assert.equal(byField("acceptance-mode", "B").value, "score");
  assert.equal(byField("acceptance-threshold", "B").value, "0.8", "历史阈值回填");
  assert.match(content(root), /接收 off → score 0\.8/, "回填后差异含接收策略");
  console.log("PASS 实验调试：v2 接收指标分表、空分母不适用、待 C1 与口径声明、历史 v2 完整回填。");
}

// support 模式：表单与组合校验同 score、off 往返保留输入、差异/历史/详情不误写 off、USD 独立用量与判别失败可见。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  const supportJob = job("job-sup", { plannedRuns: 2,
    config: { version: 2, kind: "retrieval", label: "A1 事实支持固定验证", repeat: 1, allowRemote: true, variants: [
      { id: "A", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "score", threshold: 0.71 }, parameters: retrievalParams({ maxRequests: 160 }) },
      { id: "B", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "support", threshold: 0.71 }, parameters: retrievalParams({ maxRequests: 160 }) }] },
    results: [
      { variantId: "A", repetition: 1, kind: "retrieval", status: "completed", runId: "rt-sa", summary: { plannedRows: 60, completedRows: 60, missingRows: 0, groups: [], usage: [] } },
      { variantId: "B", repetition: 1, kind: "retrieval", status: "completed", runId: "rt-sb", summary: {
        plannedRows: 60, completedRows: 60, missingRows: 0,
        groups: [{
          mode: "M4", corpus: "selected", suite: "standard", planned: 54, missing: 0, succeeded: 54, failed: 0, notApplicable: 0, measured: 54,
          recallAt5: 0.95, plannedRecallAt5: 0.93, mrrAt5: 0.9, scopeViolations: 0, boundaryFailures: 0,
          acceptance: {
            planned: 54, applicablePlanned: 54, measured: 52, missing: 0, failed: 2, notApplicable: 0, deferred: 0,
            plannedAnswerable: 54, answerableMeasured: 52, recallAt5: 0.8, plannedRecallAt5: 0.77, mrrAt5: 0.75,
            coveredCases: 50, coverage: 50 / 52, plannedCoverage: 50 / 54,
            noAnswerFalseAcceptCases: 0, noAnswerDenominator: 0, noAnswerPlanned: 0, noAnswerFalseAcceptRate: null,
            abstentionFalseAcceptCases: 0, abstentionDenominator: 0, abstentionPlanned: 0, abstentionFalseAcceptRate: null,
            answerableFalseRejectCases: 1, answerableFalseRejectDenominator: 50, answerableFalseRejectRate: 0.02,
            scopeViolations: 0, boundaryFailures: 0,
          },
        }],
        usage: [
          { operation: "rerank", requests: 54, successfulRequests: 54, cacheHits: 6, reportedRequests: 54, knownTokens: 120000, completeTokens: 120000, knownEstimatedCostCny: 0.06, completeEstimatedCostCny: 0.06 },
          { operation: "support", requests: 96, successfulRequests: 96, cacheHits: 12, reportedRequests: 96, knownTokens: 3000, completeTokens: null, knownEstimatedCostCny: null, completeEstimatedCostCny: null, knownEstimatedCostUsd: 0.001234, completeEstimatedCostUsd: 0.001234 },
        ],
      } },
    ] });
  await openExperiments(booted, [supportJob]);
  const root = element("experiments");
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-sup", "support job detail"), supportJob);
  await flush();
  const html = content(root);
  // 历史摘要不误写 off。
  assert.match(html, /B M4 · support 0\.71/, "配置快照显示 support 而非 off");
  assert.match(html, /support（分数 \+ 事实支持判别）实验阈值 0\.71；是否达标见指标/, "详情策略标签");
  assert.match(html, /判别另行调用模型增加请求/, "提示额外模型请求");
  assert.match(html, /失败 2/, "判别阶段失败在接收表可见（原始 rerank 失败 0）");
  // 用量：support 独立行，CNY 未知与 USD 分列。
  assert.match(html, /事实支持判别 support · 请求 96 · 缓存命中 12/, "support 用量独立成行不重复");
  assert.match(html, /CNY：已知 未知 · 完整 未知/, "CNY null 不补零");
  assert.match(html, /USD：已知 \$0\.001234 · 完整 \$0\.001234/, "USD 独立显示");
  // 载入配置回显 support，差异不误写 off。
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("acceptance-mode", "B").value, "support", "历史 support 回显");
  assert.equal(byField("acceptance-threshold", "B").value, "0.71");
  assert.match(content(root), /接收 score 0\.71 → support 0\.71/, "差异含 support 阈值");
  // off 往返保留输入行为：B 切 off 移除阈值，切回 support 采纳已输入值。
  const modeB = byField("acceptance-mode", "B");
  modeB.value = "off";
  modeB.fire("change");
  await flush();
  assert.equal(byField("acceptance-threshold", "B").disabled, true, "切 off 阈值禁用");
  modeB.value = "support";
  byField("acceptance-mode", "B").fire("change");
  await flush();
  const thB = byField("acceptance-threshold", "B");
  assert.equal(thB.disabled, false, "切回 support 阈值启用");
  assert.match(content(root), /support 0\.71/, "从 off 返回保留已输入阈值");
  // 组合校验：support 加选 M3 禁提交。
  const m3B = findAllAttr(root, "data-mode", "M3").find(item => item.attrs.get("data-variant") === "B")!;
  m3B.checked = true;
  m3B.fire("change");
  await flush();
  assert.match(content(root), /score\/support 接收仅支持 M4\/M5\/M6/);
  assert.equal(findClass(root, "primary-button")!.disabled, true, "support 与非 rerank 组合禁提交");
  m3B.checked = false;
  findAllAttr(root, "data-mode", "M3").find(item => item.attrs.get("data-variant") === "B")!.fire("change");
  await flush();
  // 提交体原样带 support。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "support POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.deepEqual(body.variants[0].acceptance, { mode: "score", threshold: 0.71 });
  assert.deepEqual(body.variants[1].acceptance, { mode: "support", threshold: 0.71 }, "提交体 support 原样");
  assert.equal(body.variants[1].dataset, "acceptance-support-validation");
  respond(post, job("job-sup-2", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：support 模式表单/校验/回显/差异/提交，USD 独立用量与判别失败可见。");
}

// Controller 知识检索参数：字段来自 catalog，atomic+m4-support 禁提交不改模式，阈值/超时适用性联动，旧配置缺省兼容。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-knowledge-ab";
  preset.fire("change");
  await flush();
  assert.match(content(root), /知识检索/);
  assert.equal(byField("knowledgeMode", "A").value, "lexical");
  assert.equal(byField("knowledgeMode", "B").value, "m4-support");
  assert.equal(byField("knowledgeThreshold", "A").disabled, true, "lexical 方案阈值不适用");
  assert.equal(byField("knowledgeThreshold", "B").disabled, false, "m4-support 方案阈值启用");
  assert.equal(byField("knowledgeTimeoutMs", "A").disabled, false, "controller 知识超时生效");
  assert.match(content(root), /knowledgeMode lexical → m4-support/, "差异含知识检索模式");
  // A 切到 m4-support：阈值就地启用，不重建输入节点。
  const modeA = byField("knowledgeMode", "A");
  modeA.value = "m4-support";
  modeA.fire("change");
  await flush();
  assert.equal(byField("knowledgeMode", "A"), modeA, "模式切换不重建卡片");
  assert.equal(byField("knowledgeThreshold", "A").disabled, false, "阈值适用性即时更新");
  // A 切 atomic：整建后知识超时禁用；m4-support 保留但提示禁提交，不偷偷改模式。
  const archA = byField("architecture", "A");
  archA.value = "atomic";
  archA.fire("change");
  await flush();
  assert.equal(byField("knowledgeTimeoutMs", "A").disabled, true, "atomic 知识超时不适用");
  assert.equal(byField("knowledgeMode", "A").value, "m4-support", "非法模式不被偷偷改回");
  assert.match(content(root), /atomic 仅支持本地词项知识检索；m4-support 请使用 Controller/);
  assert.equal(findClass(root, "primary-button")!.disabled, true, "atomic+m4-support 禁提交");
  // 恢复 controller 后错误消失；提交体带知识参数。
  const archA2 = byField("architecture", "A");
  archA2.value = "controller";
  archA2.fire("change");
  await flush();
  assert.ok(!content(root).includes("atomic 仅支持本地词项知识检索"), "恢复后错误消失");
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "knowledge POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.equal(body.variants[0].parameters.knowledgeMode, "m4-support", "提交体含知识模式");
  assert.equal(body.variants[0].parameters.knowledgeThreshold, 0.71);
  assert.equal(body.variants[0].parameters.knowledgeTimeoutMs, 15000);
  respond(post, job("job-k1", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  // 旧配置缺省兼容：载入无知识字段的历史配置，不崩溃、显示缺省、提交体不带新知识键。
  const legacyJob = job("job-old", {
    config: { version: 1, kind: "support", label: "旧配置复现", repeat: 1, allowRemote: false,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture" } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-old", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh with legacy"), { jobs: [legacyJob] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-old", "legacy job detail"), legacyJob);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("knowledgeMode", "A").value, "lexical", "旧配置缺省显示本地词项");
  assert.equal(byField("knowledgeThreshold", "A").disabled, true, "缺省词项模式阈值不适用");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "缺省兼容但远程仍需勾选");
  console.log("PASS 实验调试：知识检索参数、atomic 非法组合禁提交、适用性联动、旧配置缺省兼容。");
}

// knowledgeSupport 判别类型：仅 Controller + m4-support 生效，其他组合保留配置显示不适用；缺省 binary 兼容。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-knowledge-profile-ab";
  preset.fire("change");
  await flush();
  assert.equal(byField("knowledgeSupport", "A").value, "binary");
  assert.equal(byField("knowledgeSupport", "B").value, "typed");
  assert.equal(byField("knowledgeSupport", "A").disabled, false, "Controller + m4-support 判别类型生效");
  assert.match(content(root), /knowledgeSupport binary → typed/, "差异含判别类型");
  // A 切 lexical：阈值与判别类型就地禁用，不重建节点；切回后启用且配置保留。
  const modeA = byField("knowledgeMode", "A");
  modeA.value = "lexical";
  modeA.fire("change");
  await flush();
  assert.equal(byField("knowledgeMode", "A"), modeA, "模式切换不重建卡片");
  assert.equal(byField("knowledgeThreshold", "A").disabled, true, "lexical 阈值不适用");
  assert.equal(byField("knowledgeSupport", "A").disabled, true, "lexical 判别类型不适用");
  modeA.value = "m4-support";
  byField("knowledgeMode", "A").fire("change");
  await flush();
  assert.equal(byField("knowledgeSupport", "A").disabled, false, "切回后判别类型重新启用");
  assert.equal(byField("knowledgeSupport", "A").value, "binary", "组合变化保留已选配置");
  // A 切 atomic：判别类型不适用并触发既有禁提交，不偷偷改模式。
  const archA = byField("architecture", "A");
  archA.value = "atomic";
  archA.fire("change");
  await flush();
  assert.equal(byField("knowledgeSupport", "A").disabled, true, "atomic 判别类型不适用");
  assert.equal(byField("knowledgeSupport", "A").value, "binary", "配置保留不被改写");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "atomic+m4-support 仍禁提交");
  const archA2 = byField("architecture", "A");
  archA2.value = "controller";
  archA2.fire("change");
  await flush();
  // 非法 typed+lexical：明确原因、禁提交、保留可操作改回 binary 修复；合法 lexical+binary 显示不适用。
  const profileA = byField("knowledgeSupport", "A");
  profileA.value = "typed";
  profileA.fire("change");
  await flush();
  const modeA2 = byField("knowledgeMode", "A");
  modeA2.value = "lexical";
  modeA2.fire("change");
  await flush();
  assert.match(content(root), /typed 事实支持判别需 Controller \+ m4-support 知识检索；请改回 binary 或调整组合/, "非法组合明确原因");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "typed+lexical 禁提交");
  assert.equal(byField("knowledgeSupport", "A").disabled, false, "非法值保留可操作以修正");
  assert.equal(byField("knowledgeSupport", "A").value, "typed", "不偷偷改参数");
  const profileFix = byField("knowledgeSupport", "A");
  profileFix.value = "binary";
  profileFix.fire("change");
  await flush();
  assert.ok(!content(root).includes("typed 事实支持判别需"), "改回 binary 后错误消失");
  assert.equal(byField("knowledgeSupport", "A").disabled, true, "合法 lexical+binary 显示不适用");
  const modeA3 = byField("knowledgeMode", "A");
  modeA3.value = "m4-support";
  modeA3.fire("change");
  await flush();
  assert.equal(byField("knowledgeSupport", "A").disabled, false, "回到合法组合重新启用");
  // 提交体带判别类型。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "profile POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.equal(body.variants[0].parameters.knowledgeSupport, "binary", "提交体含 binary 判别");
  assert.equal(body.variants[1].parameters.knowledgeSupport, "typed", "提交体含 typed 判别");
  respond(post, job("job-p1", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  // 旧缺省 binary 兼容：载入无 knowledgeSupport 的历史配置，显示缺省且不适用（词项模式）。
  const legacyJob = job("job-old-p", {
    config: { version: 1, kind: "support", label: "旧词项配置", repeat: 1, allowRemote: false,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture" } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-old-p", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh legacy profile"), { jobs: [legacyJob] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-old-p", "legacy profile detail"), legacyJob);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("knowledgeSupport", "A").value, "binary", "旧配置缺省显示二元判断");
  assert.equal(byField("knowledgeSupport", "A").disabled, true, "词项旧配置判别类型不适用但配置保留");
  console.log("PASS 实验调试：knowledgeSupport 适用性联动、组合保留配置、提交体新参数、旧缺省 binary 兼容。");
}

// knowledgeSupportModel 固定 Pro：仅 Controller + m4-support 合法，非法组合禁提交不暗改、可改回 configured，旧缺省 configured。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-knowledge-model-ab";
  preset.fire("change");
  await flush();
  assert.equal(byField("knowledgeSupportModel", "A").value, "configured");
  assert.equal(byField("knowledgeSupportModel", "B").value, "deepseek-v4-pro");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, false, "Controller + m4-support 判别模型生效");
  assert.equal(byField("knowledgeThreshold", "A").value, "0.5", "预设阈值回填");
  assert.match(content(root), /knowledgeSupportModel configured → deepseek-v4-pro/, "差异含判别模型");
  // A 先把判别类型归 binary 以隔离 Pro 规则，再改 Pro（合法）→ 切 lexical（非法）：原因可见、禁提交、控件仍可改回、参数不暗改。
  const profileA0 = byField("knowledgeSupport", "A");
  profileA0.value = "binary";
  profileA0.fire("change");
  await flush();
  const modelA = byField("knowledgeSupportModel", "A");
  modelA.value = "deepseek-v4-pro";
  modelA.fire("change");
  await flush();
  const modeA = byField("knowledgeMode", "A");
  modeA.value = "lexical";
  modeA.fire("change");
  await flush();
  assert.match(content(root), /固定判别模型需 Controller \+ m4-support 知识检索；请改回 configured 或调整组合/, "非法组合明确原因");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "lexical+Pro 禁提交");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, false, "非法值保留可操作以修正");
  assert.equal(byField("knowledgeSupportModel", "A").value, "deepseek-v4-pro", "不暗改参数");
  const modelFix = byField("knowledgeSupportModel", "A");
  modelFix.value = "configured";
  modelFix.fire("change");
  await flush();
  assert.ok(!content(root).includes("固定判别模型需"), "改回 configured 后错误消失");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, true, "合法 lexical+configured 显示不适用");
  // 再置 Pro：atomic + Pro 同样命中同一非法规则。
  const modelA2 = byField("knowledgeSupportModel", "A");
  modelA2.value = "deepseek-v4-pro";
  modelA2.fire("change");
  await flush();
  const archA = byField("architecture", "A");
  archA.value = "atomic";
  archA.fire("change");
  await flush();
  assert.match(content(root), /固定判别模型需/, "atomic+Pro 同样禁提交");
  assert.equal(byField("knowledgeSupportModel", "A").value, "deepseek-v4-pro", "atomic 下参数仍保留");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, false, "非法值仍可操作");
  const archA2 = byField("architecture", "A");
  archA2.value = "controller";
  archA2.fire("change");
  await flush();
  const modeA3 = byField("knowledgeMode", "A");
  modeA3.value = "m4-support";
  modeA3.fire("change");
  await flush();
  assert.ok(!content(root).includes("固定判别模型需"), "回到合法组合错误消失");
  // 提交体带判别模型参数。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "model POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.equal(body.variants[0].parameters.knowledgeSupportModel, "deepseek-v4-pro", "提交体含 Pro 选择");
  assert.equal(body.variants[1].parameters.knowledgeSupportModel, "deepseek-v4-pro");
  respond(post, job("job-m1", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  // 旧缺省 configured：无 knowledgeSupportModel 的历史配置显示缺省且词项不适用。
  const legacyJob = job("job-old-m", {
    config: { version: 1, kind: "support", label: "旧模型配置", repeat: 1, allowRemote: false,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture" } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-old-m", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh legacy model"), { jobs: [legacyJob] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-old-m", "legacy model detail"), legacyJob);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("knowledgeSupportModel", "A").value, "configured", "旧配置缺省 configured，不倒填实际模型");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, true, "词项旧配置判别模型不适用");
  console.log("PASS 实验调试：knowledgeSupportModel 非法组合禁提交可修复、提交体参数、旧缺省 configured 兼容。");
}

// knowledgeApplicability declared：仅 Controller + m4-support 合法，binary/typed 均可；非法组合禁提交不暗改、可改回 model_only。
{
  const booted = await boot();
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-knowledge-applicability-ab";
  preset.fire("change");
  await flush();
  assert.equal(byField("knowledgeApplicability", "A").value, "model_only");
  assert.equal(byField("knowledgeApplicability", "B").value, "declared");
  assert.equal(byField("knowledgeApplicability", "A").disabled, false, "Controller + m4-support 适用条件生效");
  assert.match(content(root), /knowledgeApplicability model_only → declared/, "差异含适用条件");
  // A 改 declared（合法，typed 组合）→ 判别类型归 binary、模型归 configured 以隔离 declared 规则 → 切 lexical（非法）。
  const appA = byField("knowledgeApplicability", "A");
  appA.value = "declared";
  appA.fire("change");
  await flush();
  const profileA0 = byField("knowledgeSupport", "A");
  profileA0.value = "binary";
  profileA0.fire("change");
  await flush();
  const modelA0 = byField("knowledgeSupportModel", "A");
  modelA0.value = "configured";
  modelA0.fire("change");
  await flush();
  const modeA = byField("knowledgeMode", "A");
  modeA.value = "lexical";
  modeA.fire("change");
  await flush();
  assert.match(content(root), /declared 规则适用条件需 Controller \+ m4-support 知识检索；请改回 model_only 或调整组合/, "非法组合明确原因");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "lexical+declared 禁提交");
  assert.equal(byField("knowledgeApplicability", "A").disabled, false, "非法值保留可操作以修正");
  assert.equal(byField("knowledgeApplicability", "A").value, "declared", "不暗改参数");
  const appFix = byField("knowledgeApplicability", "A");
  appFix.value = "model_only";
  appFix.fire("change");
  await flush();
  assert.ok(!content(root).includes("declared 规则适用条件需"), "改回 model_only 后错误消失");
  assert.equal(byField("knowledgeApplicability", "A").disabled, true, "合法 lexical+model_only 显示不适用");
  // binary + declared 同样合法：回 m4-support 且判别类型归 binary，declared 不受 typed 限制。
  const modeA2 = byField("knowledgeMode", "A");
  modeA2.value = "m4-support";
  modeA2.fire("change");
  await flush();
  const profileA = byField("knowledgeSupport", "A");
  profileA.value = "binary";
  profileA.fire("change");
  await flush();
  const appA2 = byField("knowledgeApplicability", "A");
  appA2.value = "declared";
  appA2.fire("change");
  await flush();
  assert.ok(!content(root).includes("declared 规则适用条件需"), "binary + declared 属合法组合");
  // atomic + declared 非法。
  const archA = byField("architecture", "A");
  archA.value = "atomic";
  archA.fire("change");
  await flush();
  assert.match(content(root), /declared 规则适用条件需|atomic 仅支持本地词项知识检索/, "atomic 组合禁提交");
  const archA2 = byField("architecture", "A");
  archA2.value = "controller";
  archA2.fire("change");
  await flush();
  // 提交体与下载配置保留新参数。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "applicability POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.equal(body.variants[0].parameters.knowledgeApplicability, "declared", "提交体含 declared");
  assert.equal(body.variants[1].parameters.knowledgeApplicability, "declared");
  respond(post, job("job-a1", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  // 旧配置缺省 model_only：无该字段的历史配置显示缺省且不伪造历史生效值。
  const legacyJob = job("job-old-a", {
    config: { version: 1, kind: "support", label: "旧适用配置", repeat: 1, allowRemote: false,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture" } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-old-a", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh legacy applicability"), { jobs: [legacyJob] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-old-a", "legacy applicability detail"), legacyJob);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("knowledgeApplicability", "A").value, "model_only", "旧配置缺省 model_only，不伪造历史生效值");
  assert.equal(byField("knowledgeApplicability", "A").disabled, true, "词项旧配置适用条件不适用");
  console.log("PASS 实验调试：knowledgeApplicability 非法组合禁提交可修复、binary 兼容、提交体参数、旧缺省 model_only。");
}

// 咨询出处 v2/v3：默认 v2 显式 null，切换回填缺省，atomic+v3 保留可修复，超时上下界与不超整轮，非法不发 POST。
{
  const booted = await boot();
  const { element, find, context, flush, pendingCount } = booted;
  await openExperiments(booted);
  const root = element("experiments");
  const byField = (field: string, variant: string) => findAllAttr(root, "data-field", field).find(item => item.attrs.get("data-variant") === variant)!;
  const preset = findAttr(root, "data-field", "preset")!;
  preset.value = "support-question-contract-ab";
  preset.fire("change");
  await flush();
  // 默认 v2：两个解析控件不适用且禁用；B 为 v3 显式 configured/10000。
  assert.equal(byField("questionContract", "A").value, "v2");
  assert.equal(byField("questionModel", "A").disabled, true, "v2 解析模型不适用");
  assert.equal(byField("questionTimeoutMs", "A").disabled, true, "v2 解析超时不适用");
  assert.equal(byField("questionContract", "B").value, "v3");
  assert.equal(byField("questionModel", "B").value, "configured", "v3 缺省 configured");
  assert.equal(byField("questionTimeoutMs", "B").value, "10000", "v3 缺省 10000");
  assert.equal(byField("questionModel", "B").disabled, false);
  assert.match(content(root), /questionContract v2 → v3/, "差异含出处合同");
  // 主动 v2→v3：仅空值填 configured/10000。
  const contractA = byField("questionContract", "A");
  contractA.value = "v3";
  contractA.fire("change");
  await flush();
  assert.equal(byField("questionModel", "A").value, "configured", "切 v3 空值填 configured");
  assert.equal(byField("questionTimeoutMs", "A").value, "10000", "切 v3 空值填 10000");
  assert.equal(byField("questionModel", "A").disabled, false, "v3 解析控件启用");
  // 主动 v3→v2：置显式 null，下载/提交带 null。
  contractA.value = "v2";
  byField("questionContract", "A").fire("change");
  await flush();
  assert.equal(byField("questionModel", "A").disabled, true, "回 v2 重新禁用");
  // 往返同步回归：v3 选 Pro/5000 → v2 → v3，控件显示必须同步当前 params（configured/10000），不能残留旧显示值。
  byField("questionContract", "A").value = "v3";
  byField("questionContract", "A").fire("change");
  await flush();
  const qModel = byField("questionModel", "A");
  qModel.value = "deepseek-v4-pro";
  qModel.fire("change");
  await flush();
  const qT0 = byField("questionTimeoutMs", "A");
  qT0.value = "5000";
  qT0.fire("change");
  await flush();
  byField("questionContract", "A").value = "v2";
  byField("questionContract", "A").fire("change");
  await flush();
  assert.equal(byField("questionModel", "A").value, "", "v2 的 null 显示为空");
  byField("questionContract", "A").value = "v3";
  byField("questionContract", "A").fire("change");
  await flush();
  assert.equal(byField("questionModel", "A").value, "configured", "往返后控件与 draft 一致，不是旧显示值 Pro");
  assert.equal(byField("questionTimeoutMs", "A").value, "10000", "往返后超时显示 10000，不是旧显示值 5000");
  // 超时边界：v3 下 500/16000/超整轮均非法，合法 10000 恢复。
  byField("questionContract", "A").value = "v3";
  byField("questionContract", "A").fire("change");
  await flush();
  const qTimeout = byField("questionTimeoutMs", "A");
  qTimeout.value = "500";
  qTimeout.fire("change");
  await flush();
  assert.match(content(root), /v3 解析超时应为 1000–15000 的整数毫秒，且不超过整轮超时/, "低于下界非法");
  qTimeout.value = "16000";
  byField("questionTimeoutMs", "A").fire("change");
  await flush();
  assert.match(content(root), /v3 解析超时应为/, "高于上界非法");
  const wholeTimeout = byField("timeoutMs", "A");
  wholeTimeout.value = "10000";
  wholeTimeout.fire("change");
  await flush();
  const qTimeout2 = byField("questionTimeoutMs", "A");
  qTimeout2.value = "15000";
  qTimeout2.fire("change");
  await flush();
  assert.match(content(root), /不超过整轮超时/, "解析超时不得大于整轮超时");
  qTimeout2.value = "10000";
  byField("questionTimeoutMs", "A").fire("change");
  await flush();
  assert.ok(!content(root).includes("v3 解析超时应为"), "合法超时恢复");
  // 真实非法不发送 POST：先勾选远程授权，再置非法 v3 超时提交，证明拒绝来自参数校验而非远程门控。
  const allow = findAttr(root, "data-field", "allow-remote")!;
  allow.checked = true;
  allow.fire("change");
  await flush();
  const qTimeout3 = byField("questionTimeoutMs", "A");
  qTimeout3.value = "500";
  qTimeout3.fire("change");
  await flush();
  const beforeIllegal = pendingCount();
  findClass(root, "primary-button")!.fire("click");
  await flush();
  assert.equal(pendingCount(), beforeIllegal, "已授权但非法 v3 超时不发出 POST");
  assert.match(content(root), /v3 解析超时应为/, "非法参数错误保留在表单");
  const qTimeoutFixed = byField("questionTimeoutMs", "A");
  qTimeoutFixed.value = "10000";
  qTimeoutFixed.fire("change");
  await flush();
  assert.ok(!content(root).includes("v3 解析超时应为"), "修复后恢复");
  // atomic + v3：先把知识参数归位隔离 v3 规则，保留 v3 值可修复，不偷偷改合同。
  const modeA0 = byField("knowledgeMode", "A");
  modeA0.value = "lexical";
  modeA0.fire("change");
  await flush();
  const profileA0 = byField("knowledgeSupport", "A");
  profileA0.value = "binary";
  profileA0.fire("change");
  await flush();
  const modelA0 = byField("knowledgeSupportModel", "A");
  modelA0.value = "configured";
  modelA0.fire("change");
  await flush();
  const archA = byField("architecture", "A");
  archA.value = "atomic";
  archA.fire("change");
  await flush();
  assert.match(content(root), /咨询出处 v3 仅 Controller 可用；请改回 v2 或改用 Controller/, "atomic+v3 明确原因");
  assert.equal(byField("questionContract", "A").value, "v3", "v3 值保留不暗改");
  assert.equal(byField("questionContract", "A").disabled, false, "合同 select 可修复");
  const beforeAtomic = pendingCount();
  findClass(root, "primary-button")!.fire("click");
  await flush();
  assert.equal(pendingCount(), beforeAtomic, "已授权但 atomic+v3 不发出 POST");
  byField("questionContract", "A").value = "v2";
  byField("questionContract", "A").fire("change");
  await flush();
  assert.ok(!content(root).includes("咨询出处 v3 仅 Controller"), "改回 v2 后错误消失");
  // 固定判别模型跨 lexical 修复：flash 在 lexical 下同样非法。
  const archA2 = byField("architecture", "A");
  archA2.value = "controller";
  archA2.fire("change");
  await flush();
  const modelA = byField("knowledgeSupportModel", "A");
  modelA.value = "deepseek-flash";
  modelA.fire("change");
  await flush();
  const modeA = byField("knowledgeMode", "A");
  modeA.value = "lexical";
  modeA.fire("change");
  await flush();
  assert.match(content(root), /固定判别模型需 Controller \+ m4-support 知识检索/, "固定 Flash 在 lexical 下同样非法");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, false, "非法固定值可改回");
  byField("knowledgeSupportModel", "A").value = "configured";
  byField("knowledgeSupportModel", "A").fire("change");
  await flush();
  assert.ok(!content(root).includes("固定判别模型需"), "改回 configured 后错误消失");
  // 合法提交：A 为 v2 显式 null，B 为 v3。
  allow.checked = true;
  allow.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const post = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "question POST");
  const body = JSON.parse(post.options?.body || "{}");
  assert.ok("questionModel" in body.variants[0].parameters && body.variants[0].parameters.questionModel === null, "v2 提交体显式 null 解析模型");
  assert.ok("questionTimeoutMs" in body.variants[0].parameters && body.variants[0].parameters.questionTimeoutMs === null, "v2 提交体显式 null 超时");
  assert.equal(body.variants[1].questionModel ?? body.variants[1].parameters.questionModel, "configured", "v3 提交体 configured");
  assert.equal(body.variants[1].parameters.questionTimeoutMs, 10000);
  respond(post, job("job-q1", { status: "completed", config: body }));
  await flush();
  assert.equal(pendingCount(), 0);
  // 历史省略键的合法配置按缺省规范化：v2 + 无解析键 → 显示 v2 且控件禁用，不报错。
  const legacyJob = job("job-old-q", {
    config: { version: 1, kind: "support", label: "旧出处配置", repeat: 1, allowRemote: false,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture" } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-old-q", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh legacy question"), { jobs: [legacyJob] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-old-q", "legacy question detail"), legacyJob);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("questionContract", "A").value, "v2", "旧配置缺省 v2");
  assert.equal(byField("questionModel", "A").disabled, true, "缺省 v2 解析控件禁用");
  assert.ok(!content(root).includes("v2 出处不携带"), "省略键的合法配置不报错");
  // 省略键规范化后下载/提交带显式 null。
  assert.match(runInContext("JSON.stringify(expState.draft)", context), /"questionModel":null/, "下载 JSON 显式 null");
  const legacyV3 = job("job-old-v3", {
    config: { version: 1, kind: "support", label: "旧 v3 省略配置", repeat: 1, allowRemote: false,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture", questionContract: "v3" } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-old-v3", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh legacy v3"), { jobs: [legacyV3] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-old-v3", "legacy v3 detail"), legacyV3);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.equal(byField("questionModel", "A").value, "configured", "合法旧 v3 省略键默认 configured");
  assert.equal(byField("questionTimeoutMs", "A").value, "10000", "合法旧 v3 省略键默认 10000");
  const allow2 = findAttr(root, "data-field", "allow-remote")!;
  allow2.checked = true;
  allow2.fire("change");
  await flush();
  findClass(root, "primary-button")!.fire("click");
  await flush(1);
  const postV3 = find(request => request.path === "/api/experiments" && request.options?.method === "POST", "legacy v3 POST");
  const bodyV3 = JSON.parse(postV3.options?.body || "{}");
  assert.equal(bodyV3.variants[0].parameters.questionModel, "configured", "v3 省略键规范化后提交 configured");
  assert.equal(bodyV3.variants[0].parameters.questionTimeoutMs, 10000);
  respond(postV3, job("job-q2", { status: "completed", config: bodyV3 }));
  await flush();
  // v3 显式 null：不偷偷缺省为合法，提示并禁提交。
  const badV3 = job("job-bad-v3", {
    config: { version: 1, kind: "support", label: "坏 v3 显式 null", repeat: 1, allowRemote: true,
      variants: [{ id: "A", architecture: "controller", parameters: { timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture",
        questionContract: "v3", questionModel: null, questionTimeoutMs: null } }] },
    results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-bad-v3", summary: supportSummary(3) }],
  });
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "refresh bad v3"), { jobs: [badV3] });
  await flush();
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-bad-v3", "bad v3 detail"), badV3);
  await flush();
  findAttr(root, "data-action", "load-config")!.fire("click");
  await flush();
  assert.match(content(root), /v3 出处需显式选择解析模型/, "v3 显式 null 提示错误");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "v3 显式 null 禁提交");
  const beforeBad = pendingCount();
  findClass(root, "primary-button")!.fire("click");
  await flush();
  assert.equal(pendingCount(), beforeBad, "v3 显式 null 不发出 POST");
  assert.equal(byField("questionModel", "A").value, "", "显式 null 不偷偷填 configured");
  // expComboError 直接合成校验（JSON 不表达 undefined，直接调用）：省略合法，显式 undefined/null/坏值拒绝。
  const comboCheck = (paramsSource: string): string => runInContext(
    `expComboError({ kind: "support", variants: [{ id: "A", architecture: "controller", parameters: ${paramsSource} }] })`, context) as string;
  assert.equal(comboCheck("{}"), "", "省略 contract 与 v2 省略解析键合法");
  assert.equal(comboCheck('{ questionContract: "v2", questionModel: null, questionTimeoutMs: null }'), "", "v2 显式 null 合法");
  assert.match(comboCheck("{ questionContract: undefined }"), /仅支持 v2 或 v3/, "显式 undefined 合同拒绝");
  assert.match(comboCheck("{ questionContract: null }"), /仅支持 v2 或 v3/, "显式 null 合同拒绝");
  assert.match(comboCheck('{ questionContract: "v9" }'), /仅支持 v2 或 v3/, "未知合同值拒绝");
  assert.match(comboCheck('{ questionContract: "v2", questionModel: undefined }'), /v2 出处不携带/, "v2 显式 undefined 模型拒绝");
  assert.match(comboCheck('{ questionContract: "v2", questionTimeoutMs: undefined }'), /v2 出处不携带/, "v2 显式 undefined 超时拒绝");
  assert.equal(comboCheck('{ questionContract: "v3" }'), "", "v3 省略解析键合法（规范化补缺省）");
  assert.match(comboCheck('{ questionContract: "v3", questionModel: null }'), /v3 出处需显式选择解析模型/, "v3 显式 null 拒绝");
  assert.match(comboCheck('{ questionContract: "v3", questionTimeoutMs: undefined }'), /v3 解析超时应为/, "v3 显式 undefined 超时拒绝");
  console.log("PASS 实验调试：咨询出处 v2/v3 缺省与切换回填、atomic+v3 可修复、超时边界、非法不发 POST、旧缺省兼容。");
}
