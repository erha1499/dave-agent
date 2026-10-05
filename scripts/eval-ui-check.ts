import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";

// Only record writes and dispatch events; layout and native controls are checked in the browser.
class Element {
  children: Element[] = [];
  textContent = "";
  value = "";
  className = "";
  disabled = false;
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
  addEventListener(event: string, handler: () => unknown) { this.events.set(event, handler); }
  fire(event: string) { assert.ok(this.events.has(event)); return this.events.get(event)!(); }
}
const content = (element: Element): string => element.textContent + element.children.map(content).join("");
const walk = (element: Element): Element[] => [element, ...element.children.flatMap(walk)];
const findClass = (element: Element, cls: string) => walk(element).find(item => item.className.split(" ").includes(cls));
const styleAttrCount = (element: Element): number => walk(element).filter(item => item.styleAttr).length;
type Response = { ok: boolean; json: () => Promise<unknown> };
type Pending = { path: string; resolve: (response: Response) => void; reject: (error: Error) => void };
const respond = (request: Pending, body: unknown) => request.resolve({ ok: true, json: async () => body });
const source = await readFile(new URL("../web/evaluation/app.js", import.meta.url), "utf8");

// 合成数据：只覆盖前端读取的字段，口径与 docs/evaluation-api.md 一致。
const T = "2026-01-01T00:00:00Z";
const BATCH = "11111111-2222-4333-8444-555555555555";
const counts = (planned: number, passed: number, failed: number, skipped: number, missing: number): any =>
  ({ planned, passed, failed, skipped, missing, passRate: planned ? passed / planned : null });
const snapshot = (): any => ({
  gitCommit: "abc123def456", gitDirty: false,
  model: { provider: "test", id: "k-test", maxTokens: 4096, thinking: "off", temperature: null },
  hashes: { prompt: "p1", skill: "s1", tools: "t1", dataset: "d1", checker: "c1", business: "b1" }, asOf: T, content: {},
});
const metrics = (over: Record<string, unknown> = {}): any => ({
  casesPassed: 1, casesFailed: 1, casesSkipped: 0, turnsPassed: 1, turnsFailed: 1, turnsSkipped: 0,
  checksPassed: 2, checksFailed: 1, checksSkipped: 0, durationP50Ms: 900, durationP95Ms: 1500,
  modelRequests: 2, toolCalls: 3, toolErrors: 0, expectedDenials: 0, usageRequests: 2,
  totalTokens: 800, inputTokens: 500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.008, ...over,
});
const turn = (over: Record<string, unknown> = {}): any => ({
  index: 1, question: "问题", reply: "回答", status: "passed", startedAt: T, durationMs: 1000,
  firstTextMs: 400, evidenceIds: [], checks: [], steps: [], ...over,
});
const evalCase = (id: string, over: Record<string, unknown> = {}): any =>
  ({ id, name: id, category: "business", status: "passed", turns: [turn()], ...over });
const runRecord = (id: string, over: Record<string, unknown> = {}): any => ({
  id, label: id, suiteId: "suite", suiteName: "套件", kind: "model", status: "completed",
  plannedCases: 1, plannedTurns: 1, startedAt: T, finishedAt: T, metrics: null, snapshot: snapshot(), ...over,
});
const detailResult = (id: string, cases: any[] = [evalCase("case-1")]): any => ({ run: runRecord(id), cases });
const usageFull = (): any => ({
  modelRequests: 2, reportedRequests: 2, missingRequests: 0, coverage: 1,
  knownTokens: 1000, completeTokens: 1000, knownCostUsd: 0.01, completeCostUsd: 0.01,
});
const analysisResult = (id: string, over: Record<string, unknown> = {}): any => ({
  runId: id, scope: "legacy", answerQuality: "not_evaluated", issues: ["该历史运行没有客观检查计划。"],
  counts: null, categories: [], coverage: [], cases: [], usage: usageFull(),
  execution: { toolCalls: 3, toolErrors: 0, expectedDenials: 0, modelErrors: 0 },
  timing: { samples: 2, durationP50Ms: 900, durationP95Ms: 1500, measurement: "单轮处理耗时，不含 QQ 传输" },
  retrieval: null, ...over,
});
const comparisonResult = (aId: string, bId: string, comparable: boolean): any => {
  const side = (id: string, passed: number): any => analysisResult(id, {
    scope: "objective", issues: [],
    counts: { cases: counts(2, passed, 2 - passed, 0, 0), turns: counts(2, passed, 2 - passed, 0, 0), checks: counts(4, passed * 2, (2 - passed) * 2, 0, 0) },
    cases: [
      { id: "case-1", tags: ["退款"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(2, 2, 0, 0, 0) },
      { id: "case-2", tags: ["身份"], status: passed >= 2 ? "passed" : "failed", turns: counts(1, passed >= 2 ? 1 : 0, passed >= 2 ? 0 : 1, 0, 0), checks: counts(2, passed >= 2 ? 2 : 0, passed >= 2 ? 0 : 2, 0, 0) },
    ],
  });
  const equal = (key: string) => ({ key, status: "equal" });
  return {
    baseline: aId, candidate: bId, comparable, repeatCompatible: comparable,
    conditions: comparable
      ? ["scope", "suite", "kind", "dataset", "checker", "business", "manifest", "measurement"].map(equal)
      : [{ key: "scope", status: "equal" }, { key: "suite", status: "different" }, { key: "kind", status: "equal" },
        { key: "dataset", status: "different" }, { key: "checker", status: "unknown" }, { key: "business", status: "equal" },
        { key: "manifest", status: "different" }, { key: "measurement", status: "equal" }],
    configuration: ["model", "prompt", "skill", "tools", "implementation", "runtime", "settings"].map(equal),
    issues: comparable ? [] : ["suite: different", "dataset: different", "checker: unknown", "manifest: different"],
    analyses: { baseline: side(aId, 1), candidate: side(bId, 2) },
    cases: comparable
      ? [{ id: "case-1", baseline: "passed", candidate: "passed", change: "same" }, { id: "case-2", baseline: "failed", candidate: "passed", change: "improved" }]
      : [{ id: "case-1", baseline: "passed", candidate: "missing", change: "incomplete" }, { id: "case-2", baseline: "failed", candidate: "missing", change: "incomplete" }],
  };
};

async function boot() {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const pending: Pending[] = [];
  const take = () => { const request = pending.shift(); assert.ok(request, "expected a pending request"); return request; };
  const find = (match: (path: string) => boolean, label: string) => {
    const index = pending.findIndex(request => match(request.path));
    assert.ok(index >= 0, `expected a pending request for ${label}`);
    return pending.splice(index, 1)[0]!;
  };
  const context = createContext({ Node: Element, document: {
    getElementById: element, createElement: () => new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
  }, fetch: (path: string) => new Promise<Response>((resolve, reject) => pending.push({ path, resolve, reject })) });
  runInContext(source, context, { filename: "web/evaluation/app.js" });
  const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await setImmediate(); };
  return { element, take, find, context, flush, pendingCount: () => pending.length };
}

// 竞态：重置、切换 A/B、刷新后，旧成功/失败响应不覆盖当前对比结果。
for (const action of ["reset", "selection", "refresh"]) for (const outcome of ["success", "failure"]) {
  const { element, take, context, flush, pendingCount } = await boot();
  respond(take(), { runs: [] });
  await flush();
  runInContext('state.runs = [{ id: "a" }, { id: "b" }]', context);
  element("baseline").value = "a";
  element("candidate").value = "b";
  const old = element("compare-button").fire("click");
  const oldRequests = [take(), take(), take()];
  assert.equal(element("compare-button").disabled, true);

  if (action === "refresh") {
    const refresh = element("refresh").fire("click");
    respond(take(), { runs: [] });
    await refresh;
  } else if (action === "selection") {
    element("candidate").value = "c";
    element("candidate").fire("change");
  } else runInContext("resetComparison()", context);
  assert.match(content(element("compare-detail")), /选择两次运行/);

  // A superseding comparison stays busy even when the old request finishes.
  let current: unknown;
  let currentRequests: Pending[] = [];
  if (action !== "refresh") {
    element("baseline").value = "c";
    element("candidate").value = "d";
    current = element("compare-button").fire("click");
    currentRequests = [take(), take(), take()];
  }
  const visible = element("compare-detail").children;
  const disabled = element("compare-button").disabled;
  for (const [index, request] of oldRequests.entries()) {
    if (outcome === "failure" && index === 0) request.reject(new Error("stale request failed"));
    else if (request.path.startsWith("/api/compare")) respond(request, comparisonResult("a", "b", true));
    else respond(request, detailResult(request.path.slice("/api/runs/".length)));
  }
  await old;
  assert.equal(element("compare-detail").children, visible, `${action}/${outcome}: stale response replaced the current view`);
  assert.equal(element("compare-button").disabled, disabled, `${action}/${outcome}: stale response changed the current button`);

  if (currentRequests.length) {
    for (const request of currentRequests) {
      if (request.path.startsWith("/api/compare")) respond(request, comparisonResult("c", "d", true));
      else respond(request, detailResult(request.path.slice("/api/runs/".length)));
    }
    await current;
    assert.match(content(element("compare-detail")), /场景对比/);
    assert.equal(element("compare-button").disabled, false);
  }
  assert.equal(pendingCount(), 0, `${action}/${outcome}: unresolved request left behind`);
}
console.log("PASS 评测前端：重置、切换 A/B、刷新后，旧成功/失败响应不覆盖当前结果或按钮状态。");

// 客观运行：口径徽章、analysis 分母、覆盖标签、缺失分列、部分用量与批次不完整。
{
  const { element, take, find, flush } = await boot();
  respond(take(), { runs: [runRecord("obj-run", { label: "客观运行甲", plannedCases: 3, plannedTurns: 4, metrics: metrics(), batch: { id: BATCH, repetition: 1, plannedRepetitions: 3 } })] });
  await flush();
  respond(find(path => path === "/api/runs/obj-run/analysis", "analysis"), analysisResult("obj-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(3, 1, 1, 0, 1), turns: counts(4, 2, 1, 0, 1), checks: counts(6, 3, 2, 0, 1) },
    categories: [
      { category: "business", checks: counts(2, 1, 1, 0, 0) }, { category: "safety", checks: counts(2, 1, 0, 0, 1) },
      { category: "evidence", checks: counts(1, 1, 0, 0, 0) }, { category: "execution", checks: counts(1, 0, 1, 0, 0) },
    ],
    coverage: [
      { tag: "退款", cases: counts(2, 1, 1, 0, 0) }, { tag: "身份", cases: counts(1, 0, 0, 0, 1) },
    ],
    cases: [
      { id: "c1", tags: ["退款"], status: "failed", turns: counts(1, 0, 1, 0, 0), checks: counts(2, 1, 1, 0, 0) },
      { id: "c2", tags: ["退款"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(2, 2, 0, 0, 0) },
      { id: "c3", tags: ["身份"], status: "missing", turns: counts(2, 0, 0, 0, 2), checks: counts(2, 0, 0, 0, 2) },
    ],
    usage: { modelRequests: 4, reportedRequests: 3, missingRequests: 1, coverage: 0.75, knownTokens: 1200, completeTokens: null, knownCostUsd: 0.012, completeCostUsd: null },
    execution: { toolCalls: 9, toolErrors: 1, expectedDenials: 1, modelErrors: 0 },
  }));
  respond(find(path => path === "/api/runs/obj-run", "detail"), {
    run: runRecord("obj-run", { label: "客观运行甲", plannedCases: 3, plannedTurns: 4, metrics: metrics(), batch: { id: BATCH, repetition: 1, plannedRepetitions: 3 } }),
    cases: [
      evalCase("c1", { name: "退款确认", status: "failed", turns: [turn({ status: "failed", reply: "好的", checks: [{ id: "chk1", name: "调用退款工具", category: "business", status: "failed", reason: "未调用" }], evidenceIds: ["tool:refund"] })] }),
      evalCase("c2", { name: "身份核验", turns: [turn({ reply: "订单如下" })] }),
    ],
  });
  await flush();
  respond(find(path => path.startsWith("/api/batches/"), "batch"), {
    batchId: BATCH, compatible: true, issues: [], plannedRepetitions: 3, startedRuns: 2, completedRuns: 2, missingRuns: 1,
    runIds: ["obj-run", "obj-run-2"],
    cases: [
      { id: "c1", planned: 3, passed: 1, failed: 1, skipped: 0, missing: 1, status: "incomplete" },
      { id: "c2", planned: 3, passed: 2, failed: 0, skipped: 0, missing: 1, status: "incomplete" },
      { id: "c3", planned: 3, passed: 0, failed: 0, skipped: 0, missing: 3, status: "incomplete" },
    ],
    usage: { modelRequests: 8, reportedRequests: 8, missingRequests: 0, coverage: 1, knownTokens: 5000, completeTokens: null, knownCostUsd: 0.05, completeCostUsd: null },
  });
  await flush();
  const html = content(element("run-detail"));
  assert.match(html, /客观口径/);
  assert.match(html, /回答效果：本轮不评测/);
  assert.match(html, /1 \/ 3/);
  assert.match(html, /退款/);
  assert.match(html, /缺失 1/);
  assert.match(html, /1,200/);
  assert.match(html, /部分用量/);
  assert.match(html, /缺 1 次/);
  assert.match(html, /不完整/);
  assert.ok(!html.includes("稳定通过"), "缺计划运行时不能展示稳定满分");
  assert.match(html, /无执行记录/, "缺失场景不得从已完成案例倒推");
  assert.match(html, /好的/, "失败场景自动展开轨迹");
  assert.ok(!html.includes("订单如下"), "未展开场景的轨迹应惰性构建");
  assert.match(html, /已记录检查 · 0 \/ 1 通过/, "轮次分母是已记录检查而非全部断言");
  assert.match(html, /工具证据/, "证据分类是工具证据而非自然语言引用评分");
  const batchList = findClass(element("run-detail"), "batch-case-list");
  assert.ok(batchList, "批次逐场景明细存在");
  assert.notEqual(batchList.open, true, "批次逐场景明细默认折叠，不顶开主要指标");
  const batchFold = findClass(element("run-detail"), "batch-fold");
  assert.ok(batchFold, "批次稳定性整板折叠存在");
  assert.notEqual(batchFold.open, true, "批次稳定性默认折叠，摘要保留短结果");
  const coverageFold = findClass(element("run-detail"), "coverage-fold");
  assert.ok(coverageFold, "覆盖与分类整板折叠存在");
  assert.notEqual(coverageFold.open, true, "覆盖与分类默认折叠，摘要保留异常提示");
  assert.match(html, /不完整/, "批次概览含不完整计数");
  assert.equal(styleAttrCount(element("run-detail")), 0, "CSP 下不得使用 style 属性（分段条走 CSSOM）");
  assert.equal(styleAttrCount(element("run-list")), 0, "CSP 下侧栏分段条不得使用 style 属性");
  const scoreNode = findClass(element("run-list"), "run-score");
  assert.equal(scoreNode?.attrs.get("title"), "记录计数，口径见详情", "侧栏比分明确是记录计数");
  assert.match(content(element("run-list")), /↻ 1\/3/);
  console.log("PASS 评测前端：客观口径、覆盖标签、缺失分列、部分用量与批次概览（逐场景默认折叠、CSP 无 style 属性）。");
}

// 历史运行与无模型请求的工程运行：历史口径不冒称客观分数；null 不补零、无模型请求属不适用。
{
  const { element, take, find, context, flush } = await boot();
  respond(take(), { runs: [runRecord("leg-run", { plannedCases: 2, plannedTurns: 2, metrics: metrics() }), runRecord("eng-run", { kind: "engineering" })] });
  await flush();
  respond(find(path => path === "/api/runs/leg-run/analysis", "legacy analysis"), analysisResult("leg-run"));
  respond(find(path => path === "/api/runs/leg-run", "legacy detail"), {
    run: runRecord("leg-run", { plannedCases: 2, plannedTurns: 2, metrics: metrics() }),
    cases: [
      evalCase("case-1", { name: "历史通过" }),
      evalCase("case-2", { name: "历史失败", status: "failed", turns: [turn({ status: "failed", reply: "历史回复", checks: [{ id: "w1", name: "措辞检查", category: "business", status: "failed", reason: "缺少关键词" }] })] }),
    ],
  });
  await flush();
  const legacy = content(element("run-detail"));
  assert.match(legacy, /历史口径/);
  assert.match(legacy, /回答效果：本轮不评测/);
  assert.match(legacy, /历史措辞口径，不并入客观分数/);
  assert.match(legacy, /1 \/ 2/);
  assert.ok(!legacy.includes("客观口径"), "历史运行不得展示客观口径徽章");
  assert.match(legacy, /执行分工未采集/, "旧记录无归因显示未采集，不补零");
  assert.equal(walk(element("run-detail")).filter(item => item.className.split(" ").includes("span")).length, 0, "旧无 spans 的轮次不渲染归因明细");
  runInContext('selectRun("eng-run")', context);
  await flush();
  respond(find(path => path === "/api/runs/eng-run/analysis", "engineering analysis"), analysisResult("eng-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(1, 1, 0, 0, 0), turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
    cases: [{ id: "g1", tags: ["数据库"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) }],
    usage: { modelRequests: 0, reportedRequests: 0, missingRequests: 0, coverage: null, knownTokens: null, completeTokens: null, knownCostUsd: null, completeCostUsd: null },
  }));
  respond(find(path => path === "/api/runs/eng-run", "engineering detail"), {
    run: runRecord("eng-run", { kind: "engineering" }),
    cases: [evalCase("g1", { name: "数据库 gate", turns: [turn({ question: "[工程检查]", reply: "", durationMs: 50, firstTextMs: null, checks: [{ id: "g1c1", name: "schema 存在", category: "execution", status: "passed" }], steps: [{ index: 1, type: "tool", name: "db_check", durationMs: 40, input: {}, output: {}, isError: false }] })] })],
  });
  await flush();
  const engineering = content(element("run-detail"));
  assert.match(engineering, /客观口径/);
  assert.match(engineering, /无模型请求/);
  assert.match(engineering, /不适用/);
  assert.ok(!engineering.includes("$0.00000"), "无模型请求时费用不得补零");
  assert.ok(!engineering.includes("未采全"), "无模型请求时完整量属不适用而非未采全");
  console.log("PASS 评测前端：历史口径不冒称客观分数；无模型请求显示不适用，null 不补零。");
}

// 版本对比：后端 comparable 门控优劣结论；跨题集只并列状态，可比时才给 delta。
{
  const { element, take, find, context, flush } = await boot();
  respond(take(), { runs: [] });
  await flush();
  runInContext('state.runs = [{ id: "a-run" }, { id: "b-run" }]', context);
  element("baseline").value = "a-run";
  element("candidate").value = "b-run";
  const first = element("compare-button").fire("click");
  respond(find(path => path.startsWith("/api/compare"), "cross-suite comparison"), comparisonResult("a-run", "b-run", false));
  respond(find(path => path === "/api/runs/a-run", "baseline detail"), detailResult("a-run", [
    evalCase("case-1", { name: "场景一" }), evalCase("case-2", { name: "场景二", status: "failed", turns: [turn({ status: "failed" })] }),
  ]));
  respond(find(path => path === "/api/runs/b-run", "candidate detail"), detailResult("b-run", [
    evalCase("case-1", { name: "场景一" }), evalCase("case-2", { name: "场景二" }),
  ]));
  await first;
  const limited = content(element("compare-detail"));
  assert.match(limited, /条件不同/);
  assert.match(limited, /结果不完整/);
  assert.match(limited, /场景对比/);
  assert.ok(!limited.includes("场景通过率"), "跨题集不得展示通过率优劣结论");
  assert.ok(!limited.includes("pp"), "跨题集不得展示通过率 delta");
  const second = element("compare-button").fire("click");
  respond(find(path => path.startsWith("/api/compare"), "comparable comparison"), comparisonResult("a-run", "b-run", true));
  await second;
  const compared = content(element("compare-detail"));
  assert.match(compared, /相同配置复跑/);
  assert.match(compared, /场景通过率/);
  assert.match(compared, /↑ 50\.0pp/);
  assert.match(compared, /失败转通过/);
  console.log("PASS 评测前端：可比性由后端门控；跨题集不展示通过率/耗时优劣，可比复跑才展示 delta。");
}

// 检索运行：四组 Recall/MRR 分列、无答案诊断与约 290 案例的惰性渲染。
{
  const { element, take, find, flush } = await boot();
  const cases290 = Array.from({ length: 290 }, (_, i) => evalCase(`rc-${i}`, {
    name: `检索 ${i}`, category: "execution",
    turns: [turn({ question: `问 ${i}`, reply: "诊断回复", durationMs: 30, firstTextMs: null })],
  }));
  respond(take(), { runs: [runRecord("ret-run", { kind: "engineering", suiteId: "retrieval-objective-v1", plannedCases: 290, plannedTurns: 290, metrics: metrics({ casesPassed: 290, casesFailed: 0, totalTokens: null }) })] });
  await flush();
  respond(find(path => path === "/api/runs/ret-run/analysis", "retrieval analysis"), analysisResult("ret-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(290, 290, 0, 0, 0), turns: counts(290, 290, 0, 0, 0), checks: counts(290, 290, 0, 0, 0) },
    cases: cases290.map(item => ({ id: item.id, tags: ["检索"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) })),
    usage: { modelRequests: 0, reportedRequests: 0, missingRequests: 0, coverage: null, knownTokens: null, completeTokens: null, knownCostUsd: null, completeCostUsd: null },
    retrieval: {
      groups: [
        { corpus: "selected", suite: "standard", samples: 44, recallAt1: 0.5, recallAt5: 0.86, mrr: 0.61, mrrAt5: 0.6 },
        { corpus: "selected", suite: "hard", samples: 26, recallAt1: 0.2, recallAt5: 0.35, mrr: 0.25, mrrAt5: 0.24 },
        { corpus: "full", suite: "standard", samples: 136, recallAt1: 0.45, recallAt5: 0.8, mrr: 0.55, mrrAt5: 0.54 },
        { corpus: "full", suite: "hard", samples: 76, recallAt1: 0.18, recallAt5: 0.45, mrr: 0.28, mrrAt5: 0.27 },
      ],
      noAnswer: { samples: 10, empty: 4, nonempty: 6 },
      scope: { samples: 8, passed: 7, failed: 1 },
    },
  }));
  respond(find(path => path === "/api/runs/ret-run", "retrieval detail"), {
    run: runRecord("ret-run", { kind: "engineering", suiteId: "retrieval-objective-v1", plannedCases: 290, plannedTurns: 290 }),
    cases: cases290,
  });
  await flush();
  const html = content(element("run-detail"));
  assert.match(html, /检索指标/);
  assert.match(html, /Recall@5/);
  assert.match(html, /选集/);
  assert.match(html, /全量/);
  assert.match(html, /常规/);
  assert.match(html, /难题/);
  assert.match(html, /86\.0%/);
  assert.match(html, /0\.610/);
  assert.match(html, /非空召回 6/);
  assert.match(html, /召回诊断，不代表回答错误/);
  assert.match(html, /不合成总分/);
  assert.match(html, /范围隔离：7 \/ 8 通过/);
  assert.match(html, /全部场景 290/);
  assert.match(html, /检索 289/);
  assert.ok(!html.includes("诊断回复"), "约 290 案例的轨迹应惰性构建，首屏不渲染全部内容");
  assert.equal(styleAttrCount(element("run-detail")) + styleAttrCount(element("run-list")), 0, "大量案例的比例分段条不得使用 style 属性");
  console.log("PASS 评测前端：检索四组指标分列、无答案仅作召回诊断；约 290 案例惰性渲染。");
}

// 缓存竞态：刷新后旧 analysis 响应晚到不得覆盖新数据；切走再切回必须重新请求并展示新数据。
{
  const { element, take, find, context, flush } = await boot();
  const summaryA = runRecord("fresh-run", { label: "客观运行乙", plannedCases: 20, plannedTurns: 20 });
  const detailA = { run: runRecord("fresh-run", { label: "客观运行乙", plannedCases: 20, plannedTurns: 20 }), cases: [evalCase("c1", { name: "场景一" })] };
  const fresh = analysisResult("fresh-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(20, 20, 0, 0, 0), turns: counts(20, 20, 0, 0, 0), checks: counts(20, 20, 0, 0, 0) },
    cases: [{ id: "c1", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) }],
  });
  const stale = analysisResult("fresh-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(3, 1, 0, 0, 2), turns: counts(3, 1, 0, 0, 2), checks: counts(3, 1, 0, 0, 2) },
    cases: [{ id: "c1", tags: [], status: "missing", turns: counts(1, 0, 0, 0, 1), checks: counts(1, 0, 0, 0, 1) }],
  });
  respond(take(), { runs: [summaryA, runRecord("other-run")] });
  await flush();
  // 第一次 selectRun 的请求暂不响应；刷新会废弃这一代。
  const staleAnalysis = find(path => path === "/api/runs/fresh-run/analysis", "first analysis");
  const staleDetail = find(path => path === "/api/runs/fresh-run", "first detail");
  element("refresh").fire("click");
  respond(take(), { runs: [summaryA, runRecord("other-run")] });
  await flush();
  const freshAnalysis = find(path => path === "/api/runs/fresh-run/analysis", "second analysis");
  const freshDetail = find(path => path === "/api/runs/fresh-run", "second detail");
  respond(freshAnalysis, fresh);
  respond(freshDetail, detailA);
  await flush();
  assert.match(content(element("run-detail")), /20 \/ 20/);
  // 旧响应晚到：不得覆盖刚渲染的新数据，也不得写入任何缓存影响后续读取。
  respond(staleAnalysis, stale);
  respond(staleDetail, detailA);
  await flush();
  const afterStale = content(element("run-detail"));
  assert.match(afterStale, /20 \/ 20/);
  assert.ok(!afterStale.includes("缺失 2"), "刷新前的旧 analysis 晚到后不得生效");
  // 切走再切回：必须发出新请求（无缓存），展示新响应而非晚到的旧响应。
  runInContext('selectRun("other-run")', context);
  await flush();
  respond(find(path => path === "/api/runs/other-run/analysis", "other analysis"), analysisResult("other-run"));
  respond(find(path => path === "/api/runs/other-run", "other detail"), detailResult("other-run"));
  await flush();
  runInContext('selectRun("fresh-run")', context);
  await flush();
  // detail 命中缓存属预期（completed 记录不可变）；analysis 必须重新请求，不得读缓存。
  respond(find(path => path === "/api/runs/fresh-run/analysis", "reselect analysis"), fresh);
  await flush();
  const reselected = content(element("run-detail"));
  assert.match(reselected, /20 \/ 20/);
  assert.match(findClass(element("run-detail"), "verdict-panel")?.className ?? "", /good/, "新数据全部通过时面板为绿色");
  assert.ok(!reselected.includes("缺失 2"), "切回后不得读到晚到旧响应污染的缓存");
  console.log("PASS 评测前端：刷新后旧 analysis 晚到不生效；切走再切回重新请求，展示新数据。");
}

// 运行失败优先：落盘案例全部通过也不得显示绿色全部通过，保留真实计数并标记运行失败。
{
  const { element, take, find, flush } = await boot();
  respond(take(), { runs: [runRecord("fail-run", { status: "failed", plannedCases: 2, plannedTurns: 2 })] });
  await flush();
  respond(find(path => path === "/api/runs/fail-run/analysis", "failed-run analysis"), analysisResult("fail-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(2, 2, 0, 0, 0), turns: counts(2, 2, 0, 0, 0), checks: counts(2, 2, 0, 0, 0) },
    cases: [
      { id: "c1", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
      { id: "c2", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
    ],
  }));
  respond(find(path => path === "/api/runs/fail-run", "failed-run detail"), {
    run: runRecord("fail-run", { status: "failed", plannedCases: 2, plannedTurns: 2, error: "执行中断：数据库连接丢失" }),
    cases: [evalCase("c1"), evalCase("c2")],
  });
  await flush();
  const html = content(element("run-detail"));
  assert.match(html, /2 \/ 2/, "保留真实计数");
  const verdictClass = findClass(element("run-detail"), "verdict-panel")?.className ?? "";
  assert.match(verdictClass, /bad/, "运行失败时判定区为红色");
  assert.ok(!/\bgood\b/.test(verdictClass), "落盘案例全部通过也不得显示绿色全部通过");
  assert.equal(findClass(element("run-detail"), "verdict-mark")?.attrs.get("aria-label"), "运行失败", "判词标记为运行失败而非全部通过");
  assert.match(html, /执行中断/);
  console.log("PASS 评测前端：运行失败优先于案例计数，全部通过不冒绿。");
}

// 对比未完成：comparable 成立但一侧 running，仅并列已采集值，不给耗时/Tokens 优劣结论。
{
  const { element, take, find, context, flush } = await boot();
  respond(take(), { runs: [] });
  await flush();
  runInContext('state.runs = [{ id: "x-run" }, { id: "y-run" }]', context);
  element("baseline").value = "x-run";
  element("candidate").value = "y-run";
  const pending = element("compare-button").fire("click");
  respond(find(path => path.startsWith("/api/compare"), "unfinished comparison"), comparisonResult("x-run", "y-run", true));
  respond(find(path => path === "/api/runs/x-run", "running baseline"), {
    run: runRecord("x-run", { status: "running", finishedAt: null }),
    cases: [evalCase("case-1", { name: "场景一" })],
  });
  respond(find(path => path === "/api/runs/y-run", "completed candidate"), detailResult("y-run", [
    evalCase("case-1", { name: "场景一" }), evalCase("case-2", { name: "场景二" }),
  ]));
  await pending;
  const html = content(element("compare-detail"));
  assert.match(html, /不作优劣结论/);
  assert.match(html, /场景通过率/);
  assert.match(html, /50\.0%/);
  assert.match(html, /100\.0%/);
  assert.match(html, /Tokens · 已采集/, "未完成时并列已采集 Tokens 而非完整量对比");
  assert.ok(!html.includes("↑") && !html.includes("↓"), "未完成时不得出现优劣方向徽章");
  console.log("PASS 评测前端：comparable 但一侧未完成时仅并列已采集值，不作耗时/Tokens 优劣结论。");
}

// 批次无模型请求：Tokens 与费用整组不适用，不得一边写无模型请求一边写未采全。
{
  const { element, take, find, flush } = await boot();
  respond(take(), { runs: [runRecord("gate-run", { kind: "engineering", batch: { id: BATCH, repetition: 1, plannedRepetitions: 2 } })] });
  await flush();
  respond(find(path => path === "/api/runs/gate-run/analysis", "gate analysis"), analysisResult("gate-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(1, 1, 0, 0, 0), turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
    cases: [{ id: "g1", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) }],
    usage: { modelRequests: 0, reportedRequests: 0, missingRequests: 0, coverage: null, knownTokens: null, completeTokens: null, knownCostUsd: null, completeCostUsd: null },
  }));
  respond(find(path => path === "/api/runs/gate-run", "gate detail"), {
    run: runRecord("gate-run", { kind: "engineering", batch: { id: BATCH, repetition: 1, plannedRepetitions: 2 } }),
    cases: [evalCase("g1", { name: "工程 gate" })],
  });
  await flush();
  respond(find(path => path.startsWith("/api/batches/"), "no-model batch"), {
    batchId: BATCH, compatible: true, issues: [], plannedRepetitions: 2, startedRuns: 2, completedRuns: 2, missingRuns: 0,
    runIds: ["gate-run", "gate-run-2"],
    cases: [{ id: "g1", planned: 2, passed: 2, failed: 0, skipped: 0, missing: 0, status: "always_passed" }],
    usage: { modelRequests: 0, reportedRequests: 0, missingRequests: 0, coverage: null, knownTokens: null, completeTokens: null, knownCostUsd: null, completeCostUsd: null },
  });
  await flush();
  const html = content(element("run-detail"));
  assert.match(html, /稳定通过 1/, "批次概览含稳定通过计数");
  assert.match(html, /无模型请求，用量、Tokens 与费用均不适用/);
  assert.ok(!html.includes("未采全"), "无模型请求时不得写未采全");
  console.log("PASS 评测前端：无模型请求的批次，Tokens 与费用整组不适用。");
}

// 同 ID 重选竞态：同一 refresh epoch 快速 A→B→A（A 仍 running），较早的 A 响应不得覆盖第二次 A 的新响应；失败分支同样只认当前选择。
for (const outcome of ["success", "detail-failure", "analysis-failure"]) {
  const { element, take, find, context, flush } = await boot();
  const summaryA = runRecord("race-a", { status: "running", finishedAt: null, plannedCases: 6, plannedTurns: 6 });
  const detailA = { run: runRecord("race-a", { status: "running", finishedAt: null, plannedCases: 6, plannedTurns: 6 }), cases: [evalCase("c1", { name: "场景一" })] };
  const analysisA = (passed: number, missing: number): any => analysisResult("race-a", {
    scope: "objective", issues: [],
    counts: { cases: counts(6, passed, 0, 0, missing), turns: counts(6, passed, 0, 0, missing), checks: counts(6, passed, 0, 0, missing) },
    cases: [{ id: "c1", tags: [], status: missing ? "missing" : "passed", turns: counts(1, missing ? 0 : 1, 0, 0, missing), checks: counts(1, missing ? 0 : 1, 0, 0, missing) }],
  });
  respond(take(), { runs: [summaryA, runRecord("race-b")] });
  await flush();
  // 第一次 A 的请求挂起不响应；随后 B 与第二次 A 在同一 epoch 内发出。
  const staleAnalysis = find(path => path === "/api/runs/race-a/analysis", "first A analysis");
  const staleDetail = find(path => path === "/api/runs/race-a", "first A detail");
  runInContext('selectRun("race-b")', context);
  await flush();
  respond(find(path => path === "/api/runs/race-b/analysis", "B analysis"), analysisResult("race-b"));
  respond(find(path => path === "/api/runs/race-b", "B detail"), detailResult("race-b", [evalCase("case-1", { name: "B 场景" })]));
  await flush();
  assert.match(content(element("run-detail")), /B 场景/);
  runInContext('selectRun("race-a")', context);
  await flush();
  respond(find(path => path === "/api/runs/race-a/analysis", "second A analysis"), analysisA(5, 1));
  respond(find(path => path === "/api/runs/race-a", "second A detail"), detailA);
  await flush();
  assert.match(content(element("run-detail")), /5 \/ 6/);
  const freshDetail = content(element("run-detail"));
  const freshNotice = content(element("notice"));
  // 必须让同一 A 的旧请求成功或失败；旧 B 失败仅能检验 ID 守卫，抓不到本次重选缺陷。
  if (outcome === "analysis-failure") staleAnalysis.reject(new Error("stale A analysis failed"));
  else respond(staleAnalysis, analysisA(1, 5));
  if (outcome === "detail-failure") staleDetail.reject(new Error("stale A detail failed"));
  else respond(staleDetail, detailA);
  await flush();
  assert.equal(content(element("run-detail")), freshDetail, `旧 A 的 ${outcome} 不得覆盖新详情`);
  assert.equal(content(element("notice")), freshNotice, `旧 A 的 ${outcome} 不得覆盖当前提示`);
  console.log(`PASS 评测前端：同 ID 快速重选的旧 ${outcome} 响应不覆盖当前结果。`);
}

// v2 中文显示名与归因：trigger 标注、spans 逐项展示不合计、denied/error 分列，空 spans 不补零。
{
  const { element, take, find, flush } = await boot();
  const span = (over: Record<string, unknown>): any => ({
    id: "s1", parentSpanId: null, actor: "host", trigger: "user", component: "qq-ingress",
    name: "turn", observedAt: T, durationMs: 100, outcome: "ok", ...over,
  });
  respond(take(), { runs: [runRecord("v2-run", { plannedCases: 4, plannedTurns: 4 })] });
  await flush();
  respond(find(path => path === "/api/runs/v2-run/analysis", "v2 analysis"), analysisResult("v2-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(4, 4, 0, 0, 0), turns: counts(4, 4, 0, 0, 0), checks: counts(4, 4, 0, 0, 0) },
    cases: [
      { id: "scoped-consult", tags: ["readonly"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
      { id: "pending-not-approved", tags: ["aftersales"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
      { id: "approved-confirm-restart", tags: ["confirmation"], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
      { id: "other-case", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
    ],
    attribution: {
      spans: 5,
      groups: [
        { actor: "host", trigger: "event", component: "business-service", calls: 2, denied: 1, errors: 0 },
        { actor: "agent", trigger: "user", component: "model", calls: 3, denied: 0, errors: 1 },
      ],
      providers: [], issues: [],
    },
  }));
  respond(find(path => path === "/api/runs/v2-run", "v2 detail"), {
    run: runRecord("v2-run", { plannedCases: 4, plannedTurns: 4 }),
    cases: [
      evalCase("scoped-consult", { name: "scoped-consult", turns: [turn({ question: "规则咨询", reply: "用户轮回复",
        steps: [{ index: 1, type: "model", name: "k-test", durationMs: 90, usage: null }],
        spans: [span({}), span({ id: "s2", actor: "agent", component: "model", name: "k-test", durationMs: 90, input: { a: 1 }, output: { b: 2 } })] })] }),
      evalCase("pending-not-approved", { name: "pending-not-approved", turns: [turn({ question: "宿主通知批准结果", reply: "事件回执", steps: [],
        spans: [span({ trigger: "event" }), span({ id: "s3", component: "business-service", name: "propose_refund", outcome: "denied", input: {}, output: {} })] })] }),
      evalCase("approved-confirm-restart", { name: "approved-confirm-restart", turns: [turn({ question: "确认退款 op-1", reply: "确认回执", steps: [],
        spans: [span({ trigger: "confirmation" }), span({ id: "s4", component: "confirmation-service", name: "confirm_refund", outcome: "error" })] })] }),
      evalCase("other-case", { name: "other-case", turns: [turn({ question: "空归因轮", reply: "普通回复", spans: [] })] }),
    ],
  });
  await flush();
  // 场景正文惰性构建：展开全部案例后再断言轮级内容。
  for (const item of walk(element("run-detail")).filter(node => node.className.split(" ").includes("case"))) {
    item.open = true;
    item.fire("toggle");
  }
  const html = content(element("run-detail"));
  assert.match(html, /只读规则咨询/, "v2 场景显示中文名");
  assert.match(html, /等待审批的退款请求/, "改后中文名同步");
  assert.match(html, /批准 · 确认 · 重启恢复/);
  const nameNode = walk(element("run-detail")).find(item => item.className.split(" ").includes("case-name") && item.attrs.get("title") === "场景 ID：scoped-consult");
  assert.ok(nameNode, "原 ID 保留在场景名 title 可查");
  assert.match(html, /other-case/, "未知场景原样显示，不强行中文化");
  assert.match(html, /商家事件宿主通知批准结果/, "event 轮输入标商家事件（spans 优先于文本猜测）");
  assert.match(html, /用户确认确认退款/, "confirmation 轮输入标用户确认");
  assert.match(html, /用户规则咨询/, "user 轮输入仍标用户");
  assert.match(html, /宿主事件回执/, "event 轮回执标宿主");
  assert.match(html, /宿主确认回执/, "confirmation 轮回执标宿主");
  assert.match(html, /Agent用户轮回复/, "user 轮回复保留 Agent，不因宿主服务 span 误标");
  assert.match(html, /业务拒绝/, "denied 显示业务拒绝");
  assert.match(html, /执行错误/, "error 显示执行错误");
  assert.match(html, /执行分工 · 2 段/, "轮级归因折叠存在");
  assert.match(html, /暂无归因记录/, "空 spans 明确暂无归因记录，不补零");
  assert.match(html, /本轮无模型请求/, "v2 轮无模型步骤时标注无模型请求");
  assert.match(html, /已记录 5 段/, "运行级归因折叠摘要");
  assert.match(html, /不与执行轨迹的调用量、Tokens、费用重复相加/);
  const attrFold = findClass(element("run-detail"), "attr-fold");
  assert.ok(attrFold, "运行级执行分工折叠存在");
  assert.notEqual(attrFold.open, true, "运行级执行分工默认折叠");
  const rows = walk(element("run-detail")).filter(item => item.className.split(" ").includes("attr-row"));
  assert.equal(rows.length, 3, "归因 groups 逐项列出：表头 + 2 行，不造合计行");
  assert.ok(!html.includes("合计"), "执行分工不造合计");
  console.log("PASS 评测前端：v2 中文名、trigger 标注、轮级/运行级归因折叠（denied/error 分列、不合计），空归因不补零。");
}

// 坏归因记录：null/原始值/数组/缺字段/非法 actor/trigger/outcome 不崩溃、不标正常、原始 JSON 可查；invalid 口径与归因 issues 外露。
{
  const { element, take, find, flush } = await boot();
  respond(take(), { runs: [runRecord("bad-run", { plannedCases: 1, plannedTurns: 1 })] });
  await flush();
  respond(find(path => path === "/api/runs/bad-run/analysis", "bad analysis"), analysisResult("bad-run", {
    scope: "invalid", issues: ["计划检查 chk-9 没有对应结果。"], counts: null,
    attribution: { spans: 6, groups: [], providers: [], issues: ["span[3] outcome 非法，已从统计剔除。"] },
  }));
  respond(find(path => path === "/api/runs/bad-run", "bad detail"), {
    run: runRecord("bad-run", { plannedCases: 1, plannedTurns: 1 }),
    cases: [evalCase("bad-case", { name: "坏归因场景", status: "failed", turns: [turn({
      question: "<b>payload", reply: "坏记录轮", status: "failed",
      checks: [{ id: "c1", name: "协议完整", category: "execution", status: "failed", reason: "缺回执" }],
      spans: [
        null,
        "oops",
        [],
        { component: "model" },
        { id: "s9", actor: "agent", trigger: "user", component: "model", name: "k-test", durationMs: 10, outcome: "success", input: { q: "<b>x</b>" } },
        { id: "s10", actor: "host", trigger: "webhook", component: "qq-ingress", name: "turn", durationMs: 5, outcome: "ok" },
      ],
    })] })],
  });
  await flush();
  const html = content(element("run-detail"));
  assert.match(html, /口径与数据问题/, "invalid 口径问题外露不折叠");
  assert.match(html, /计划检查 chk-9 没有对应结果/, "后端口径 issue 文本可见");
  assert.match(html, /span\[3\] outcome 非法/, "归因 issues 可见");
  assert.match(html, /执行分工 · 6 段/, "坏记录不静默丢弃，逐条列出");
  assert.match(html, /归因记录无效/, "坏记录标无效");
  assert.ok(!html.includes("正常"), "坏记录不得标正常");
  assert.match(html, /"outcome": "success"/, "非法 outcome 的原始 JSON 可展开查看");
  assert.match(html, /<b>x<\/b>/, "input 以文本展示（textContent 转义）");
  assert.match(html, /用户<b>payload/, "未知 trigger 不默认 user 标签体系：回退文本判断，不标宿主");
  assert.match(html, /Agent坏记录轮/, "未知 trigger 轮回复保持 Agent");
  console.log("PASS 评测前端：坏归因记录不崩溃、不标正常、原始 JSON 可查，invalid 口径与归因 issues 外露。");
}

// atomic 商家事件：回执由宿主固定生成标宿主，但实际模型步骤保留，不得显示无模型请求；回执生成方标签不等同是否调用模型。
{
  const { element, take, find, flush } = await boot();
  respond(take(), { runs: [runRecord("atomic-run", { plannedCases: 1, plannedTurns: 1 })] });
  await flush();
  respond(find(path => path === "/api/runs/atomic-run/analysis", "atomic analysis"), analysisResult("atomic-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(1, 1, 0, 0, 0), turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
    cases: [{ id: "atomic-1", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) }],
  }));
  respond(find(path => path === "/api/runs/atomic-run", "atomic detail"), {
    run: runRecord("atomic-run", { plannedCases: 1, plannedTurns: 1 }),
    cases: [evalCase("atomic-1", { name: "atomic-1", turns: [turn({
      question: "宿主通知原子事件", reply: "商家状态回执", durationMs: 800,
      steps: [{ index: 1, type: "model", name: "k-test-atomic", durationMs: 600, usage: null }],
      spans: [{ id: "i1", parentSpanId: null, actor: "host", trigger: "event", component: "qq-ingress", name: "turn", observedAt: T, durationMs: 20, outcome: "ok" }],
    })] })],
  });
  await flush();
  // passed 场景默认不展开，手动展开后断言轮级内容。
  for (const item of walk(element("run-detail")).filter(node => node.className.split(" ").includes("case"))) {
    item.open = true;
    item.fire("toggle");
  }
  const html = content(element("run-detail"));
  assert.match(html, /商家事件宿主通知原子事件/, "atomic 事件轮输入标商家事件");
  assert.match(html, /宿主商家状态回执/, "atomic 事件回执标宿主");
  assert.match(html, /k-test-atomic/, "实际模型步骤保留");
  assert.ok(!html.includes("本轮无模型请求"), "有实际模型步骤时不得显示无模型请求");
  console.log("PASS 评测前端：atomic 商家事件回执标宿主，实际模型步骤保留，不误标无模型请求。");
}

// 知识取证：accepted/rejected/unavailable 逐次展示、来源版本短值、scope 拒绝不作幻觉、CNY/USD 分列、旧记录不受影响。
{
  const { element, take, find, flush } = await boot();
  const span = (over: Record<string, unknown>): any => ({
    id: "s1", parentSpanId: "t1", actor: "host", trigger: "user", component: "business-service", name: "search_faq",
    observedAt: T, durationMs: 1240, outcome: "ok", ...over,
  });
  const knowledgeAccepted = {
    context: {
      originalQuery: "券快过期能退吗", modelQuestion: "团购券临期退款规则", effectiveQuery: "临期退款规则",
      orderSource: "current_explicit", scopeSource: "fresh_order",
      facts: { orderId: "COUPON-1234", asOf: T, status: "paid", productId: "product-1", productName: "双人午餐券", refundState: "none" },
      policyTopic: { requestId: "r1", sourceKey: "k1", groupOpenid: "g1", originalQuery: "券快过期能退吗", orderId: "COUPON-1234",
        scope: { shopId: "shop-demo-long-id-0001", productId: "product-demo-long-0001" },
        sources: [{ sourceId: "KB-REFUND-EXPIRED", version: "a".repeat(64) }] },
    },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "临期退款规则", originalQuery: "券快过期能退吗",
      scope: { shopId: "shop-demo-long-id-0001", productId: "product-demo-long-0001" }, status: "accepted", reason: null,
      rawRanking: [{ id: "KB-REFUND-EXPIRED", score: 0.92 }],
      acceptance: { version: "score-support-v1", config: { mode: "support", threshold: 0.71 }, status: "accepted",
        accepted: [{ id: "KB-REFUND-EXPIRED", title: "临期券退款规则", body: "到期前 72 小时内<b>未核销</b>可退。", tags: ["退款"], score: 0.92, rank: 1 }, null],
        rejected: [], diagnostics: { topScore: 0.92, scoreGap: null, candidates: [] } },
      sources: [{ sourceId: "KB-REFUND-EXPIRED", version: "b".repeat(64) }],
      sourceHashes: { before: "b1", after: "b1" }, durationMs: 1240, calls: [],
      usage: { rerankTokens: 1200, supportTokens: 800, estimatedCny: 0.0006, estimatedUsd: 0.00008, incompleteCalls: 0 },
      pricing: { estimated: true },
      settings: { support: { promptVersion: "fact-support-typed-v2", profile: "typed", provider: "deepseek", model: "deepseek-v4-pro",
        validationVersion: "typed-candidate-isolation-v1" }, serialization: "json-title-tags-body-v1" },
      // 结构取自真实 run 990dac49 首个 case 的知识 trace（脱敏）：对象容器 {value, requestHash, inputHash, attempts}。
      supportVerification: {
        requestHash: "2e0a54caa785947f", inputHash: "9f1c2d",
        attempts: [{ operation: "support", provider: "deepseek", model: "deepseek-flash", attempt: 1, durationMs: 1671, outcome: "ok",
          totalTokens: 1771, inputTokens: 857, outputTokens: 402, cacheReadTokens: 512, cacheWriteTokens: 0, costUsd: 0.000742 }],
        value: [
          { id: "KB-REFUND-EXPIRED", supported: true, category: "direct_fact", quote: "到期前 72 小时内未核销可退", reason: "原文直接给出临期退款规则。" },
          { id: "KB-OTHER", supported: false, category: "limitation_only", quote: "需联系商家核实", reason: "仅说明缺失" },
          { id: "KB-UNRELATED", supported: false, category: "unrelated", quote: null, reason: "与问题无关" },
          { id: "KB-PENDING", supported: null, quote: null, reason: "请求未完成" },
          null,
        ],
        validation: { status: "partial", outputHash: "h1a2b3",
          invalidDecisions: [{ id: "KB-BAD-QUOTE", code: "invalid_quote" }, { id: "KB-BAD-CAT", code: "invalid_category" }] },
      },
      stages: [{ name: "read", observedAt: T, durationMs: 5 }, null, "oops", { name: "rerank", observedAt: T, durationMs: 310 },
        { name: "support", observedAt: T, durationMs: 900 }, { name: "recheck", observedAt: T, durationMs: 25 }],
    },
  };
  const knowledgeRejected = {
    context: { originalQuery: "别的店能用吗", modelQuestion: null, effectiveQuery: "别的店能用吗", orderSource: "verified_focus", scopeSource: "global", facts: null, policyTopic: null },
    trace: {
      mode: "lexical", threshold: null, query: "别的店能用吗", originalQuery: "别的店能用吗",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "rejected", reason: null,
      rawRanking: [{ id: "KB-OTHER-SHOP", score: null }],
      acceptance: { version: "score-gate-v1", config: { mode: "off" }, status: "rejected", accepted: [],
        rejected: [{ id: "KB-OTHER-SHOP", rank: 1, reason: "out_of_scope" }], diagnostics: { topScore: null, scoreGap: null, candidates: [] } },
      sourceHashes: { before: "b1", after: "b1" }, durationMs: 8, calls: [],
      usage: { rerankTokens: null, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 0 },
      stages: [{ name: "read", observedAt: T, durationMs: 8 }],
    },
  };
  const knowledgeUnavailable = {
    context: { originalQuery: "退款规则", modelQuestion: null, effectiveQuery: "退款规则", orderSource: "none", scopeSource: "global", facts: null, policyTopic: null },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "退款规则", originalQuery: "退款规则",
      scope: { shopId: "shop-1", productId: null }, status: "unavailable", reason: "timeout",
      rawRanking: [], acceptance: null, sourceHashes: { before: "b1", after: null }, durationMs: 15000, calls: [],
      usage: { rerankTokens: 0, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 2 },
      stages: [{ name: "read", observedAt: T, durationMs: 4 }, { name: "rerank", observedAt: T, durationMs: 14996 }],
      // 异常容器：顶层数组不是实际后端合同，必须诊断而非默默兼容。
      supportVerification: [{ id: "KB-WRONG-SHAPE", supported: true }],
    },
  };
  // 首次无 policyTopic 的接受：版本只来自本轮 trace.sources。
  const knowledgeAcceptedFresh = {
    context: { originalQuery: "新规能退吗", modelQuestion: null, effectiveQuery: "新规能退吗", orderSource: "current_explicit", scopeSource: "fresh_order", facts: null, policyTopic: null },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "新规能退吗", originalQuery: "新规能退吗",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "accepted", reason: null,
      rawRanking: [{ id: "KB-NEW-RULE", score: 0.88 }],
      acceptance: { version: "score-support-v1", config: { mode: "support", threshold: 0.71 }, status: "accepted",
        accepted: [{ id: "KB-NEW-RULE", title: "新规退款", body: "新规正文", tags: [], score: 0.88, rank: 1 }],
        rejected: [], diagnostics: { topScore: 0.88, scoreGap: null, candidates: [] } },
      sources: [{ sourceId: "KB-NEW-RULE", version: "c".repeat(64) }],
      sourceHashes: { before: "b1", after: "b1" }, durationMs: 900, calls: [],
      settings: { support: { promptVersion: "fact-support-v2-typed", profile: "typed", provider: "deepseek", model: "deepseek-flash" } },
      usage: { rerankTokens: 900, supportTokens: 600, estimatedCny: 0.0004, estimatedUsd: 0.00006, incompleteCalls: 0 },
      stages: [{ name: "read", observedAt: T, durationMs: 3 }],
    },
  };
  // 旧 trace 无 sources 字段：版本显示未记录，policyTopic 旧版本不充当本轮版本。
  const knowledgeLegacyTrace = {    context: {
      originalQuery: "旧规则能退吗", modelQuestion: null, effectiveQuery: "旧规则能退吗", orderSource: "current_explicit", scopeSource: "fresh_order", facts: null,
      policyTopic: { requestId: "r2", sourceKey: "k2", groupOpenid: "g1", originalQuery: "旧规则能退吗", orderId: "COUPON-1234",
        scope: { shopId: "shop-1", productId: "product-1" }, sources: [{ sourceId: "KB-OLD-DOC", version: "a".repeat(64) }] },
    },
    trace: {
      mode: "lexical", threshold: null, query: "旧规则能退吗", originalQuery: "旧规则能退吗",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "accepted", reason: null,
      rawRanking: [{ id: "KB-OLD-DOC", score: null }],
      acceptance: { version: "score-gate-v1", config: { mode: "off" }, status: "accepted",
        accepted: [{ id: "KB-OLD-DOC", title: "旧规退款", body: "旧规正文", tags: [], score: null, rank: 1 }],
        rejected: [], diagnostics: { topScore: null, scoreGap: null, candidates: [] } },
      sourceHashes: { before: "b1", after: "b1" }, durationMs: 6, calls: [],
      settings: { support: { promptVersion: "fact-support-v1" } },
      supportVerification: { requestHash: "ab12cd", inputHash: "ef3456", attempts: [],
        value: [{ id: "KB-OLD-DOC", supported: true, quote: "旧规正文引文", reason: null }] },
      usage: { rerankTokens: null, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 0 },
      stages: [{ name: "read", observedAt: T, durationMs: 6 }],
    },
  };
  // 全部判别无效：业务不可用、没有充分有效证据。
  const knowledgeAllInvalid = {
    context: { originalQuery: "新规能退吗", modelQuestion: null, effectiveQuery: "新规能退吗", orderSource: "none", scopeSource: "global", facts: null, policyTopic: null },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "新规能退吗", originalQuery: "新规能退吗",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "unavailable", reason: null,
      rawRanking: [], acceptance: null, sourceHashes: { before: "b1", after: null }, durationMs: 1200, calls: [],
      usage: { rerankTokens: null, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 0 },
      settings: { support: { promptVersion: "fact-support-typed-v2", profile: "typed", provider: "deepseek", model: "deepseek-v4-pro",
        validationVersion: "typed-candidate-isolation-v1" } },
      supportVerification: { requestHash: "aa11bb", inputHash: "cc22dd", attempts: [],
        value: [],
        validation: { status: "unavailable", outputHash: "z9y8",
          invalidDecisions: [{ id: "KB-X1", code: "invalid_reason" }, { id: "KB-X2", code: "invalid_quote" }] } },
      stages: [{ name: "read", observedAt: T, durationMs: 3 }],
    },
  };
  // 整批形状错误：supportFailure 带 code/outputHash，可能无 verification。
  const knowledgeBatchFailure = {
    context: { originalQuery: "退款规则", modelQuestion: null, effectiveQuery: "退款规则", orderSource: "none", scopeSource: "global", facts: null, policyTopic: null },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "退款规则", originalQuery: "退款规则",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "unavailable", reason: "provider_unavailable",
      rawRanking: [], acceptance: null, sourceHashes: { before: "b1", after: null }, durationMs: 900, calls: [],
      usage: { rerankTokens: null, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 1 },
      settings: { support: { promptVersion: "fact-support-typed-v2", profile: "typed", provider: "deepseek", model: "deepseek-v4-pro",
        validationVersion: "typed-candidate-isolation-v1" } },
      supportFailure: { code: "schema_mismatch", outputHash: "f7e8d9" },
      stages: [{ name: "read", observedAt: T, durationMs: 3 }],
    },
  };
  // 坏 validation 完整性夹具：status 非枚举、complete 含 invalid、invalid 与有效 ID 重叠。
  const badValidationOf = (validation: unknown): any => ({
    context: { originalQuery: "规则", modelQuestion: null, effectiveQuery: "规则", orderSource: "none", scopeSource: "global", facts: null, policyTopic: null },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "规则", originalQuery: "规则",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "accepted", reason: null,
      rawRanking: [{ id: "KB-VALID-9", score: 0.9 }],
      acceptance: { version: "score-support-v1", config: { mode: "support", threshold: 0.71 }, status: "accepted",
        accepted: [{ id: "KB-VALID-9", title: "有效规则", body: "有效正文", tags: [], score: 0.9, rank: 1 }],
        rejected: [], diagnostics: { topScore: 0.9, scoreGap: null, candidates: [] } },
      sourceHashes: { before: "b1", after: "b1" }, durationMs: 700, calls: [],
      usage: { rerankTokens: null, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 0 },
      settings: { support: { promptVersion: "fact-support-typed-v2", profile: "typed", provider: "deepseek", model: "deepseek-v4-pro",
        validationVersion: "typed-candidate-isolation-v1" } },
      supportVerification: { requestHash: "cc33dd", inputHash: "ee44ff", attempts: [],
        value: [{ id: "KB-VALID-9", supported: true, category: "direct_fact", quote: "有效正文", reason: "直接给出规则。" }],
        validation },
      stages: [{ name: "read", observedAt: T, durationMs: 3 }],
    },
  });
  const knowledgeBadStatus = badValidationOf({ status: "weird", outputHash: "s1",
    invalidDecisions: [{ id: "KB-BAD-S", code: "invalid_quote" }] });
  const knowledgeCompleteWithInvalid = badValidationOf({ status: "complete", outputHash: "s2",
    invalidDecisions: [{ id: "KB-BAD-C", code: "invalid_reason" }] });
  const knowledgeOverlapId = badValidationOf({ status: "partial", outputHash: "s3",
    invalidDecisions: [{ id: "KB-VALID-9", code: "invalid_category" }] });
  // 坏 validation 记录：invalidDecisions 非数组，明确数据异常且有效判断仍显示。
  const knowledgeBadValidation = {
    context: { originalQuery: "临期能退吗", modelQuestion: null, effectiveQuery: "临期能退吗", orderSource: "none", scopeSource: "global", facts: null, policyTopic: null },
    trace: {
      mode: "m4-support", threshold: 0.71, query: "临期能退吗", originalQuery: "临期能退吗",
      scope: { shopId: "shop-1", productId: "product-1" }, status: "accepted", reason: null,
      rawRanking: [{ id: "KB-VALID-1", score: 0.9 }],
      acceptance: { version: "score-support-v1", config: { mode: "support", threshold: 0.71 }, status: "accepted",
        accepted: [{ id: "KB-VALID-1", title: "有效规则", body: "有效正文", tags: [], score: 0.9, rank: 1 }],
        rejected: [{ id: "KB-VALID-2", rank: 2, reason: "invalid_support_decision" }], diagnostics: { topScore: 0.9, scoreGap: null, candidates: [] } },
      sourceHashes: { before: "b1", after: "b1" }, durationMs: 800, calls: [],
      usage: { rerankTokens: null, supportTokens: null, estimatedCny: null, estimatedUsd: null, incompleteCalls: 0 },
      settings: { support: { promptVersion: "fact-support-typed-v2", profile: "typed", provider: "deepseek", model: "deepseek-v4-pro",
        validationVersion: "typed-candidate-isolation-v1" } },
      supportVerification: { requestHash: "bb22cc", inputHash: "dd33ee", attempts: [],
        value: [{ id: "KB-VALID-1", supported: true, category: "direct_fact", quote: "有效正文", reason: "直接给出规则。" }],
        validation: { status: "partial", invalidDecisions: "not-an-array", outputHash: null } },
      stages: [{ name: "read", observedAt: T, durationMs: 3 }],
    },
  };
  respond(take(), { runs: [runRecord("k-run", { plannedCases: 2, plannedTurns: 3 })] });
  await flush();
  respond(find(path => path === "/api/runs/k-run/analysis", "knowledge analysis"), analysisResult("k-run", {
    scope: "objective", issues: [],
    counts: { cases: counts(2, 2, 0, 0, 0), turns: counts(3, 3, 0, 0, 0), checks: counts(2, 2, 0, 0, 0) },
    cases: [
      { id: "k1", tags: [], status: "passed", turns: counts(2, 2, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
      { id: "k2", tags: [], status: "passed", turns: counts(1, 1, 0, 0, 0), checks: counts(1, 1, 0, 0, 0) },
    ],
  }));
  respond(find(path => path === "/api/runs/k-run", "knowledge detail"), {
    run: runRecord("k-run", { plannedCases: 2, plannedTurns: 3 }),
    cases: [
      evalCase("k1", { name: "知识取证场景", turns: [
        turn({ index: 1, question: "券快过期能退吗", reply: "可退", steps: [{ index: 1, type: "model", name: "k-test", durationMs: 900, usage: null }],
          spans: [
            span({ id: "k-span-1", knowledge: knowledgeAccepted }),
            span({ id: "k-span-2", knowledge: knowledgeRejected, durationMs: 8 }),
            span({ id: "k-span-b1", knowledge: knowledgeBadStatus, durationMs: 700 }),
            span({ id: "k-span-b2", knowledge: knowledgeCompleteWithInvalid, durationMs: 700 }),
            span({ id: "k-span-b3", knowledge: knowledgeOverlapId, durationMs: 700 }),
            { id: "p1", parentSpanId: "k-span-1", actor: "host", trigger: "user", component: "knowledge-rerank", name: "rerank", observedAt: T, durationMs: 310, outcome: "ok",
              usage: { provider: "bailian", model: "qwen3-rerank", kind: "rerank", inputTokens: 1200, outputTokens: 0, totalTokens: 1200, cost: { currency: "CNY", amount: 0.0006, source: "price_estimate" } } },
            { id: "p2", parentSpanId: "k-span-1", actor: "host", trigger: "user", component: "knowledge-support", name: "support", observedAt: T, durationMs: 900, outcome: "ok",
              usage: { provider: "pi", model: "k-test", kind: "llm", inputTokens: 700, outputTokens: 100, totalTokens: 800, cost: { currency: "USD", amount: 0.00008, source: "sdk_estimate" } } },
            { id: "p3", parentSpanId: "k-span-1", actor: "host", trigger: "user", component: "knowledge-support", name: "support", observedAt: T, durationMs: 100, outcome: "error",
              usage: { provider: "pi", model: "k-test", kind: "llm", inputTokens: null, outputTokens: null, totalTokens: null, cost: null } },
            { id: "p4", parentSpanId: "t1", actor: "host", trigger: "user", component: "business-service", name: "paid_amount_compare", observedAt: T, durationMs: 3, outcome: "ok",
              input: { orderRef: "current", amountRef: { requestId: "r9" } }, output: { paidCents: 7980, compareToCents: 7980, equal: true } },
          ] }),
        turn({ index: 2, question: "退款规则", reply: "稍候", steps: [{ index: 1, type: "model", name: "k-test", durationMs: 500, usage: null }],
          spans: [
            span({ id: "k-span-3", knowledge: knowledgeUnavailable, durationMs: 15000 }),
            span({ id: "k-span-4", knowledge: knowledgeAcceptedFresh, durationMs: 900 }),
            span({ id: "k-span-5", knowledge: knowledgeLegacyTrace, durationMs: 6 }),
            span({ id: "k-span-6", knowledge: knowledgeAllInvalid, durationMs: 1200 }),
            span({ id: "k-span-7", knowledge: knowledgeBatchFailure, durationMs: 900 }),
            span({ id: "k-span-8", knowledge: knowledgeBadValidation, durationMs: 800 }),
          ] }),
      ] }),
      evalCase("k2", { name: "旧记录场景", turns: [turn({ question: "旧问题", reply: "旧回答" })] }),
    ],
  });
  await flush();
  for (const item of walk(element("run-detail")).filter(node => node.className.split(" ").includes("case"))) {
    item.open = true;
    item.fire("toggle");
  }
  const html = content(element("run-detail"));
  assert.match(html, /知识取证 · 5 次/, "一轮多个 FAQ 调用合并成区");
  assert.match(html, /知识取证 · 6 次/, "第二轮六次调用");
  assert.match(html, /m4-support · 阈值 0\.71/, "方案与阈值");
  assert.match(html, /本地词项/, "lexical 方案");
  assert.match(html, /接受/);
  assert.match(html, /拒收/);
  assert.match(html, /不可用/);
  assert.match(html, /查询超时/, "unavailable 原因中文");
  assert.match(html, /范围 shop-demo- \+ product-de/, "首行范围短值");
  assert.match(html, /shopId shop-demo-long-id-0001 · productId product-demo-long-0001/, "细节给完整范围 ID");
  assert.match(html, /KB-REFUND-EXPIRED · 版本 bbbbbbbbbb/, "本轮 trace.sources 版本");
  assert.ok(!html.includes("版本 aaaaaaaaaa"), "policyTopic 上轮旧版本不得作为展示版本（原始 JSON 保留）");
  assert.match(html, /KB-NEW-RULE · 版本 cccccccccc/, "无 policyTopic 也显示本轮版本");
  assert.match(html, /KB-OLD-DOC · 版本 未记录/, "旧 trace 无 sources 字段显示版本未记录");
  assert.match(html, /模型建议问题（仅审计）/, "模型建议问题仅审计，不暗示已采用");
  assert.match(html, /实际检索问题（宿主构造）/, "实际查询由宿主构造");
  assert.match(html, /另有 2 条取证记录无法解析/, "坏历史条目显示缺失信息");
  assert.match(html, /判别明细 · 4 条/, "typed 判别明细折叠");
  assert.match(html, /KB-REFUND-EXPIRED · 事实或规则 · 支持/, "direct_fact 标事实或规则，不限已发生事实");
  assert.match(html, /KB-OTHER · 仅说明缺失或需核实 · 不支持/, "仅说明缺失类别");
  assert.match(html, /KB-UNRELATED · 无关 · 不支持/, "无关类别");
  assert.match(html, /引用：需联系商家核实/, "实际 quote 可见");
  assert.match(html, /KB-PENDING · 二元判断 · 未知/, "未完成不记为不支持");
  assert.match(html, /KB-OLD-DOC · 二元判断 · 支持/, "binary 旧记录不反推类别");
  assert.match(html, /判别配置：typed 分类判别 · deepseek\/deepseek-v4-pro · prompt fact-support-typed-v2 · 校验 typed-candidate-isolation-v1/, "实际 provider/model、prompt 与校验版本");
  assert.match(html, /部分判别无效 · 2 条/, "partial 警示横幅");
  assert.match(html, /KB-BAD-QUOTE · 引用无效/, "无效条目中文原因");
  assert.match(html, /KB-BAD-CAT · 类别无效/);
  assert.ok(!html.includes("KB-BAD-QUOTE · 不支持"), "无效项不得显示为正确拒收");
  assert.match(html, /全部判别无效，没有充分有效证据/, "全 invalid 显示不可用且没有充分证据");
  assert.match(html, /判别失败：schema_mismatch/, "整批 supportFailure code");
  assert.match(html, /判别失败哈希/, "失败哈希折叠不挤占页面");
  assert.match(html, /判别校验记录异常/, "坏 validation 记录明确数据异常");
  assert.match(html, /KB-VALID-1 · 事实或规则 · 支持/, "坏 validation 下有效判断仍显示");
  assert.match(html, /KB-VALID-9 · 事实或规则 · 支持/, "坏完整性记录下有效判断仍保留供排查");
  const partialBanners = walk(element("run-detail")).filter(item => item.textContent.startsWith("部分判别无效 · "));
  assert.equal(partialBanners.length, 1, "坏 status/complete 含 invalid/重叠 ID 均不显示正常 partial 语义");
  const malformedNotes = walk(element("run-detail")).filter(item => item.textContent === "判别校验记录异常，无法解析。");
  assert.equal(malformedNotes.length, 4, "非数组、坏 status、complete 含 invalid、重叠 ID 四处记录异常");
  assert.match(html, /支持判别无效/, "新增拒收原因中文标签");
  assert.match(html, /deepseek\/deepseek-flash/, "另一调用实际模型分列");
  assert.match(html, /paid_amount_compare（只读实付比较）/, "v2.2 只读实付比较中文标签");
  assert.match(html, /判别配置：binary 二元判断 · prompt fact-support-v1/, "fact-support-v1 识别为 binary");
  assert.match(html, /宿主仅接受事实或规则与明确安全边界问题的回答/, "接受口径说明");
  assert.match(html, /判别明细记录异常，无法解析/, "顶层数组等非合同容器明确诊断，不默默兼容");
  const verdictFolds = walk(element("run-detail")).filter(item => item.textContent.startsWith("判别明细 · "));
  assert.equal(verdictFolds.length, 6, "无 supportVerification 的旧记录不伪造判别明细");
  const profileLines = walk(element("run-detail")).filter(item => item.textContent.startsWith("判别配置："));
  assert.equal(profileLines.length, 9, "有记录的判别配置按实际版本显示");
  assert.match(html, /临期券退款规则/, "被接受原文标题");
  assert.match(html, /到期前 72 小时内<b>未核销<\/b>可退。/, "来源正文按文本展示（textContent 防注入）");
  assert.match(html, /超出授权范围/, "scope 拒绝原因中文");
  assert.match(html, /范围拒绝属授权判定，不作幻觉结论/, "不把 scope 拒绝叫模型幻觉");
  assert.match(html, /读取 5 ms · 重排 310 ms · 支持判别 900 ms · 复检 25 ms/, "阶段时延（坏条目剔除）");
  assert.match(html, /CNY ¥0\.000600 · USD \$0\.000080/, "成本 CNY/USD 分列");
  assert.match(html, /CNY 未知 · USD 未知/, "未知费用明确显示未知，不补零");
  assert.match(html, /支持 Tokens 未知/, "未知 Tokens 不补零");
  assert.match(html, /缺量调用 2/);
  assert.match(html, /CNY ¥0\.000600（price_estimate）/, "provider 子 span CNY 估算");
  assert.match(html, /USD \$0\.000080（sdk_estimate）/, "provider 子 span USD 估算");
  assert.match(html, /费用未知/, "缺 cost 显示未知");
  const knowledgeRegions = walk(element("run-detail")).filter(item => item.textContent.startsWith("知识取证 · "));
  assert.equal(knowledgeRegions.length, 2, "旧记录无 knowledge 不渲染取证区");
  console.log("PASS 评测前端：知识取证三态展示、本轮版本来源、scope 拒绝不作幻觉、成本分列、旧记录与坏条目兼容。");
}
