import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";

// 实验调试 tab 的离线检查：独立 FakeDOM（与 eval-ui-check.ts 互不影响），同时加载 app.js 与 experiments.js。
class Element {
  children: Element[] = [];
  textContent = "";
  value = "";
  className = "";
  disabled = false;
  checked = false;
  open?: boolean;
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  styleAttr = false;
  events = new Map<string, () => unknown>();
  classList = { toggle() {} };
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) {
    if (key === "value") this.value = value;
    if (key === "style") this.styleAttr = true;
    this.attrs.set(key, value);
  }
  removeAttribute(key: string) { this.attrs.delete(key); }
  addEventListener(event: string, handler: () => unknown) { this.events.set(event, handler); }
  fire(event: string) { assert.ok(this.events.has(event), `no handler for ${event}`); return this.events.get(event)!(); }
}
const content = (element: Element): string => element.textContent + element.children.map(content).join("");
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
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
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
      getElementById: element, createElement: () => new Element(),
      createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
    },
    fetch: (path: string, options?: Pending["options"]) => new Promise<Response>((resolve, reject) => pending.push({ path, options, resolve, reject })),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: never) => clearTimeout(id),
  });
  runInContext(appSource, context, { filename: "web/evaluation/app.js" });
  runInContext(expSource, context, { filename: "web/evaluation/experiments.js" });
  const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await setImmediate(); };
  return { element, take, find, context, flush, pendingCount: () => pending.length };
}

// 合成 catalog：结构与 src/experiment-config.ts 的 experimentCatalog 一致。
const T = "2026-01-01T00:00:00Z";
const counts = (planned: number, passed: number, failed: number, skipped: number, missing: number): any =>
  ({ planned, passed, failed, skipped, missing, passRate: planned ? passed / planned : null });
const supportParams = (over: Record<string, unknown> = {}): any => ({
  timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture",
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
      { key: "timeoutMs", label: "每轮超时（ms）", type: "number", min: 10000, max: 120000, step: 1000 },
      { key: "repairBudget", label: "格式修复次数", type: "number", min: 0, max: 2, step: 1, note: "仅 Controller 生效" },
      { key: "merchantEvents", label: "商家通知处理", type: "select", options: [
        { value: "architecture", label: "跟随架构" }, { value: "host", label: "宿主直接处理" }, { value: "model", label: "经过模型" }], note: "最终状态卡始终由宿主生成" },
      { key: "knowledgeMode", label: "知识检索", type: "select", options: [
        { value: "lexical", label: "本地词项" }, { value: "m4-support", label: "全候选重排 + 事实支持" }], note: "m4-support 仅 Controller；额外调用百炼和支持性模型" },
      { key: "knowledgeThreshold", label: "知识接收阈值", type: "number", min: 0, max: 1, step: 0.01, note: "仅 m4-support；默认冻结值 0.71，分数不是概率" },
      { key: "knowledgeSupport", label: "事实支持判别", type: "select", options: [
        { value: "binary", label: "二元基线 v1" }, { value: "typed", label: "分类候选 v3" }], note: "typed 仅用于 m4-support" },
      { key: "knowledgeSupportModel", label: "支持判别模型", type: "select", options: [
        { value: "configured", label: "跟随已配置模型" }, { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }], note: "仅 Controller + m4-support；Pro 只切换支持判别" },
      { key: "knowledgeSupportPrompt", label: "分类判别 Prompt", type: "select", options: [
        { value: "v5", label: "v5 基线" }, { value: "v6", label: "v6 诉求合同" }], note: "v6 仅 Controller + m4-support + typed；服务端严格校验" },
      { key: "knowledgeApplicability", label: "规则适用条件", type: "select", options: [
        { value: "model_only", label: "仅模型判断" }, { value: "declared", label: "已声明必要前提" }], note: "declared 仅 Controller + m4-support；binary/typed 均可" },
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
  const detailOf = (id: string) => ({ run: { id, label: id, suiteId: "suite", suiteName: "套件", kind: "model", status: "completed",
    plannedCases: 1, plannedTurns: 1, startedAt: T, finishedAt: T, metrics: null,
    snapshot: { gitCommit: "abc", gitDirty: false, model: { provider: "test", id: "k", maxTokens: 1, thinking: "off", temperature: null }, hashes: {}, asOf: T, content: {} } }, cases: [] });
  respond(find(request => request.path === "/api/runs/run-a1", "baseline detail"), detailOf("run-a1"));
  respond(find(request => request.path === "/api/runs/run-a2", "candidate detail"), detailOf("run-a2"));
  await flush();
  assert.match(content(element("compare-detail")), /场景对比/, "带入后进入既有对比视图");
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
  const { element, find, flush, pendingCount } = booted;
  await openExperiments(booted, [
    job("job-1", { status: "running", finishedAt: null, config: { version: 1, kind: "support", label: "任务甲", repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "atomic", parameters: supportParams() }] } }),
    job("job-2", { config: { version: 1, kind: "support", label: "任务乙", repeat: 1, allowRemote: true, variants: [{ id: "A", architecture: "controller", parameters: supportParams() }] } }),
  ]);
  const root = element("experiments");
  const jobs = walk(root).filter(item => item.className.split(" ").includes("exp-job"));
  jobs[0]!.fire("click");
  await flush(1);
  const stale = find(request => request.path === "/api/experiments/job-1", "first job detail");
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
  assert.equal(pendingCount(), 0);
  console.log("PASS 实验调试：任务详情竞态，旧响应不覆盖当前选择。");
}

// 列表快照不覆盖详情：列表请求发出 → 详情返回 completed → 旧列表 running 晚到，详情不得退回旧进度。
{
  const booted = await boot();
  const { element, find, flush } = booted;
  const staleListed = job("job-s", { status: "running", finishedAt: null, plannedRuns: 1, current: { variantId: "A", repetition: 1 } });
  await openExperiments(booted, [staleListed]);
  const root = element("experiments");
  walk(root).find(item => item.className.split(" ").includes("exp-job"))!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments/job-s", "job detail"), job("job-s", {
    plannedRuns: 1, results: [{ variantId: "A", repetition: 1, kind: "support", status: "completed", runId: "run-s1", summary: supportSummary(3) }],
  }));
  await flush();
  const detail = () => content(findAttr(root, "aria-label", "任务详情")!);
  assert.match(detail(), /已完成 1 \/ 1/);
  // 旧列表快照（running）晚到：只能更新列表行，不得把详情退回去。
  findAttr(root, "data-action", "refresh-jobs")!.fire("click");
  await flush(1);
  respond(find(request => request.path === "/api/experiments", "stale list"), { jobs: [staleListed] });
  await flush();
  assert.match(detail(), /已完成 1 \/ 1/, "旧列表 running 响应不得覆盖已完成详情");
  assert.ok(!detail().includes("运行中"), "详情不得停在旧进度");
  assert.ok(findAttr(root, "aria-label", "实验任务")!.children.length > 0);
  console.log("PASS 实验调试：旧列表 running 晚到不覆盖已完成详情。");
}

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
  assert.match(content(root), /固定 Pro 判别模型需 Controller \+ m4-support 知识检索；请改回 configured 或调整组合/, "非法组合明确原因");
  assert.equal(findClass(root, "primary-button")!.disabled, true, "lexical+Pro 禁提交");
  assert.equal(byField("knowledgeSupportModel", "A").disabled, false, "非法值保留可操作以修正");
  assert.equal(byField("knowledgeSupportModel", "A").value, "deepseek-v4-pro", "不暗改参数");
  const modelFix = byField("knowledgeSupportModel", "A");
  modelFix.value = "configured";
  modelFix.fire("change");
  await flush();
  assert.ok(!content(root).includes("固定 Pro 判别模型需"), "改回 configured 后错误消失");
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
  assert.match(content(root), /固定 Pro 判别模型需/, "atomic+Pro 同样禁提交");
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
  assert.ok(!content(root).includes("固定 Pro 判别模型需"), "回到合法组合错误消失");
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
