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
const supportParams = (over: Record<string, unknown> = {}): any => ({ timeoutMs: 60000, repairBudget: 1, merchantEvents: "architecture", ...over });
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
    { id: "retrieval-local", name: "本地检索 M0 / M1", config: { version: 1, kind: "retrieval", label: "本地检索 M0 / M1", repeat: 1, allowRemote: false, variants: [
      { id: "A", modes: ["M0", "M1"], parameters: retrievalParams() } ] } },
    { id: "retrieval-rerank", name: "词项 / 全候选重排", config: { version: 1, kind: "retrieval", label: "词项 / 全候选重排", repeat: 1, allowRemote: false, variants: [
      { id: "A", modes: ["M0", "M4"], parameters: retrievalParams() } ] } },
  ],
  fields: {
    support: [
      { key: "timeoutMs", label: "每轮超时（ms）", type: "number", min: 10000, max: 120000, step: 1000 },
      { key: "repairBudget", label: "格式修复次数", type: "number", min: 0, max: 2, step: 1, note: "仅 Controller 生效" },
      { key: "merchantEvents", label: "商家通知处理", type: "select", options: [
        { value: "architecture", label: "跟随架构" }, { value: "host", label: "宿主直接处理" }, { value: "model", label: "经过模型" }], note: "最终状态卡始终由宿主生成" },
    ],
    retrieval: [
      { key: "candidateTopK", label: "候选数 K", type: "number", min: 1, max: 100, step: 1 },
      { key: "cache", label: "远程结果缓存", type: "select", options: [{ value: "reuse", label: "复用缓存" }, { value: "refresh", label: "重新请求" }] },
      { key: "maxRequests", label: "每次运行请求上限", type: "number", min: 1, max: 10000, step: 1 },
    ],
  },
  modes: ["M0 词项", "M1 BM25", "M2 向量", "M3 BM25 + 向量 RRF", "M4 全候选重排", "M5 词项候选重排", "M6 RRF 候选重排"]
    .map((label, index) => ({ value: `M${index}`, label })),
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
