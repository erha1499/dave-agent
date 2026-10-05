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
