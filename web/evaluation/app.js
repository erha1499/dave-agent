"use strict";

const $ = id => document.getElementById(id);
const state = {
  runs: [], selected: null, view: "overview", kind: "model", request: 0, comparison: 0, selection: 0,
  details: new Map(),
};
const statusNames = { passed: "通过", failed: "失败", skipped: "跳过", missing: "缺失", running: "运行中", completed: "已完成", pending: "未执行" };
const categoryNames = { business: "业务正确性", safety: "身份安全", evidence: "工具证据", execution: "执行完整性" };
const scopeNames = { objective: "客观口径", legacy: "历史口径", invalid: "口径无效" };
const scopeNotes = {
  objective: "分母与分类来自执行前固定的检查计划",
  legacy: "历史措辞口径，不并入客观分数",
  invalid: "计划或结果无效，不生成客观分数",
};
const stabilityNames = { always_passed: "稳定通过", always_failed: "稳定失败", mixed: "结果波动", incomplete: "不完整" };
const conditionNames = {
  scope: "客观口径", suite: "场景套件", kind: "评测类型", dataset: "评测集", checker: "检查规则", business: "业务数据",
  manifest: "检查计划", measurement: "耗时口径", model: "模型", prompt: "Prompt", skill: "Skill", tools: "工具定义",
  implementation: "Agent 实现", runtime: "运行时", settings: "运行设置",
};
const conditionStatus = { equal: "一致", different: "不同", unknown: "未知" };
const changeNames = { same: "状态一致", improved: "失败转通过", regressed: "出现退步", incomplete: "结果不完整" };
const corpusNames = { selected: "选集", full: "全量" };
const retrievalSuiteNames = { standard: "常规", hard: "难题" };
// v2 共同业务计划的三个场景给中文显示名，原 ID 保留在 title 与展开详情中；未知场景原样显示。
const v2CaseNames = {
  "scoped-consult": "只读规则咨询",
  "pending-not-approved": "等待审批的退款请求",
  "approved-confirm-restart": "批准 · 确认 · 重启恢复",
};
const displayCaseName = (id, fallback) => v2CaseNames[id] || fallback || id;
const actorNames = { agent: "Agent", host: "宿主" };
const triggerNames = { user: "普通用户", event: "商家事件", confirmation: "用户确认" };
// v2.2 只读实付比较是纯 DB 事实计算：只补中文标签，无知识检索也不算缺数据或检索失败。
const actionNames = { paid_amount_compare: "只读实付比较" };
const ANSWER_NOTE = "回答效果：本轮不评测";
const number = value => value === null || value === undefined ? "未采集" : new Intl.NumberFormat("zh-CN").format(value);
const duration = value => value === null || value === undefined ? "未采集" : `${(value / 1000).toFixed(2)} s`;
const money = value => value === null || value === undefined ? "未采集" : `$${value.toFixed(5)}`;
const percent = value => value === null || value === undefined ? "不适用" : `${(value * 100).toFixed(1)}%`;
const ratio = value => value === null || value === undefined ? "不适用" : value.toFixed(3);
const date = value => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未结束";
const short = value => value ? value.slice(0, 10) : "未记录";

// All run content is untrusted data; only fixed element/attribute names reach this helper.
function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (key === "checked" || key === "disabled" || key === "hidden") element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
const text = (tag, value, className) => node(tag, className ? { class: className } : {}, value);
const badge = (status, label) => text("span", label || statusNames[status] || status, `status ${status}`);
// 简约图标标记：✓ 通过 / ✕ 失败 / − 跳过、缺失或未执行 / … 进行中；完整措辞见 aria-label。
const glyphs = { passed: "✓", completed: "✓", failed: "✕", skipped: "−", missing: "−", pending: "−", running: "…" };
const mark = status => node("span", { class: `mark ${status}`, role: "img", "aria-label": statusNames[status] || status }, glyphs[status] || "?");
const empty = (title, copy, command) => node("div", { class: "empty-state" }, text("h2", title), text("p", copy), command ? text("code", command) : null);
const json = value => text("pre", JSON.stringify(value, null, 2));
const score = run => run.metrics ? `${run.metrics.casesPassed} / ${run.plannedCases}` : `— / ${run.plannedCases}`;
const checksOf = item => item.turns.flatMap(turn => turn.checks);
const isFailed = item => item.status === "failed" || checksOf(item).some(check => check.status === "failed");

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
  $("notice").className = error ? "notice error" : "notice";
}

async function api(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 503 ? "评测数据库暂不可用。检查 MySQL 运行状态和评测数据库配置后，再刷新记录。" : `无法读取评测记录（HTTP ${response.status}）。请检查后台服务后重试。`);
  return response.json();
}

async function detail(id) {
  if (state.details.has(id)) return state.details.get(id);
  const result = await api(`/api/runs/${encodeURIComponent(id)}`);
  // Completed records are immutable; an in-flight response must not cache an older running snapshot.
  if (result.run.status !== "running") state.details.set(id, result);
  return result;
}

// analysis 与 batch 是派生数据，运行期间会变化；不缓存，避免晚到的旧响应在刷新后污染缓存。
// detail 只缓存非 running 记录：completed/failed 落盘后不可变。
const runAnalysis = id => api(`/api/runs/${encodeURIComponent(id)}/analysis`);
const batchInfo = id => api(`/api/batches/${encodeURIComponent(id)}`);

function setView(view) {
  state.view = view;
  $("overview").hidden = view !== "overview";
  $("comparison").hidden = view !== "compare";
  const experimentsPanel = $("experiments");
  if (experimentsPanel) experimentsPanel.hidden = view !== "experiments";
  for (const [id, active] of [["overview-tab", view === "overview"], ["compare-tab", view === "compare"], ["experiments-tab", view === "experiments"]]) {
    const tab = $(id);
    if (!tab) continue;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  // 实验调试 tab 由 experiments.js 实现；未加载（离线检查或旧缓存页面）时守卫跳过。
  if (typeof experimentViewChanged === "function") experimentViewChanged(view);
}

// 大量案例时按状态比例渲染分段条；少量案例保留逐案例校准块。
// 宽度走 CSSOM 属性赋值：CSP style-src 'self' 会拦截 style 属性，但不拦截 CSSOM。
function segmentBar(entries, label) {
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return null;
  const bar = node("div", { class: "segment-bar", role: "img", "aria-label": label });
  for (const [status, count] of entries) {
    if (!count) continue;
    const segment = node("span", { class: `segment ${status}` });
    segment.style.width = `${(count / total * 100).toFixed(2)}%`;
    bar.append(segment);
  }
  return bar;
}

// 历史记录里一眼扫出质量：按指标汇总渲染每轮的迷你校准条（失败优先靠左）。
function miniStrip(run) {
  const planned = run.plannedCases ?? 0;
  if (!planned) return null;
  if (run.metrics && planned > 60) {
    const rest = Math.max(0, planned - run.metrics.casesPassed - run.metrics.casesFailed - run.metrics.casesSkipped);
    return segmentBar([["failed", run.metrics.casesFailed], ["passed", run.metrics.casesPassed], ["skipped", run.metrics.casesSkipped], [run.status === "running" ? "running" : "pending", rest]],
      `计划 ${planned} 场景的通过比例`);
  }
  const blocks = [];
  const push = (status, count) => { for (let i = 0; i < count; i++) blocks.push(node("span", { class: `mini-block ${status}` })); };
  if (run.metrics) {
    push("failed", run.metrics.casesFailed);
    push("passed", run.metrics.casesPassed);
    push("skipped", run.metrics.casesSkipped);
  }
  push(run.status === "running" ? "running" : "pending", Math.max(0, planned - blocks.length));
  return node("div", { class: "mini-strip", "aria-hidden": "true" }, ...blocks);
}

function renderRunList() {
  $("run-list").replaceChildren(...state.runs.map(run => node("button", {
    type: "button", class: `run-button${run.id === state.selected ? " selected" : ""}`,
    "aria-pressed": String(run.id === state.selected), onclick: () => selectRun(run.id),
  }, text("span", run.label || run.suiteName, "run-title"),
  // 日期与比分同一行；常态（已完成）不占用文字，只有进行中或失败才标记；↻ 表示同批次重复运行。
  // 侧栏比分是落库的记录计数，客观/历史口径以详情与 analysis 为准。
  node("div", { class: "run-row" }, text("p", date(run.startedAt), "run-date"), run.status === "completed" ? null : mark(run.status),
    node("span", { class: "run-score", title: "记录计数，口径见详情" }, score(run)),
    run.batch ? text("span", `↻ ${run.batch.repetition}/${run.batch.plannedRepetitions}`, "batch-tag") : null),
  miniStrip(run))));
  if (!state.runs.length) $("run-list").append(text("p", "这里还没有运行记录。", "sidebar-empty"));
}

function renderPickers() {
  for (const id of ["baseline", "candidate"]) {
    const previous = $(id).value;
    $(id).replaceChildren(node("option", { value: "" }, "选择运行"), ...state.runs.map(run => node("option", { value: run.id }, `${run.label || run.suiteName} · ${date(run.startedAt)}`)));
    if (state.runs.some(run => run.id === previous)) $(id).value = previous;
  }
  if (!$("baseline").value && state.runs.length > 1) $("baseline").value = state.runs[1].id;
  if (!$("candidate").value && state.runs.length) $("candidate").value = state.runs[0].id;
  resetComparison();
}

function resetComparison() {
  state.comparison++;
  $("compare-button").disabled = state.runs.length < 2;
  $("compare-detail").replaceChildren(empty("选择两次运行", state.runs.length < 2 ? "至少需要两次评测记录。" : "点击“开始对比”查看变化。"));
}

async function loadRuns() {
  const request = ++state.request;
  state.selection++;
  resetComparison();
  $("refresh").disabled = true;
  notice("正在读取评测记录…");
  state.details.clear();
  try {
    const result = await api(`/api/runs?kind=${state.kind}&limit=50`);
    if (request !== state.request) return;
    state.runs = result.runs;
    state.selected = state.runs.some(run => run.id === state.selected) ? state.selected : state.runs[0]?.id ?? null;
    $("record-count").textContent = `最近 ${state.runs.length} 次`;
    renderRunList();
    renderPickers();
    notice("");
    if (state.selected) await selectRun(state.selected);
    else $("run-detail").replaceChildren(empty("暂无评测记录", "执行评测后刷新页面。", state.kind === "model" ? "npm run check:model" : "npm run check:eval-db"));
  } catch (error) {
    if (request !== state.request) return;
    notice(error.message, true);
    $("run-detail").replaceChildren(empty("暂时无法读取评测", "检查数据库与本机服务后，点击“刷新记录”重试。"));
  } finally {
    if (request === state.request) $("refresh").disabled = false;
  }
}

// 独立递增选择序号：快速 A→B→A 时较早的 A 响应不得覆盖第二次 A 的新响应。
async function selectRun(id) {
  const selection = ++state.selection;
  const request = state.request;
  state.selected = id;
  renderRunList();
  $("run-detail").replaceChildren(empty("正在读取…", ""));
  try {
    const [result, analysis] = await Promise.all([detail(id), runAnalysis(id)]);
    const batch = result.run.batch
      ? await batchInfo(result.run.batch.id).catch(error => ({ error: error.message }))
      : null;
    if (selection !== state.selection || request !== state.request) return;
    renderDetail(result, analysis, batch);
  } catch (error) {
    if (selection === state.selection && request === state.request) {
      $("run-detail").replaceChildren(empty("这次运行暂时无法打开", error.message));
      notice(error.message, true);
    }
  }
}

function metric(label, value) {
  return node("div", { class: "metric" }, text("p", label, "metric-label"), text("p", value, "metric-value"));
}

// 计数行：通过数以全部计划为分母；失败、跳过、缺失分别标注，缺失不是失败也不补零。
function countsLine(counts, unit) {
  const parts = [`通过 ${counts.passed} / ${counts.planned} ${unit}`];
  if (counts.failed) parts.push(`失败 ${counts.failed}`);
  if (counts.skipped) parts.push(`跳过 ${counts.skipped}`);
  if (counts.missing) parts.push(`缺失 ${counts.missing}`);
  return parts.join(" · ");
}

const countsEntries = counts => [["failed", counts.failed], ["passed", counts.passed], ["skipped", counts.skipped], ["missing", counts.missing]];

// 场景校准条：逐案例块（少量）或比例分段条（大量），状态含缺失。
function caseStrip(items) {
  if (items.length > 120) {
    const tally = { failed: 0, passed: 0, skipped: 0, missing: 0, pending: 0 };
    for (const item of items) tally[item.status in tally ? item.status : "pending"]++;
    const rest = tally.missing + tally.pending;
    return segmentBar([["failed", tally.failed], ["passed", tally.passed], ["skipped", tally.skipped], ["missing", rest]],
      `场景校准条：通过 ${tally.passed} · 失败 ${tally.failed} · 跳过 ${tally.skipped} · 缺失或未执行 ${rest}`);
  }
  return node("div", { class: "case-strip-blocks", role: "img", "aria-label": `场景校准条：${items.map(item => `${item.name} ${statusNames[item.status] || item.status}`).join("，")}` },
    ...items.map(item => node("span", { class: `case-block ${item.status}`, title: `${item.name} · ${statusNames[item.status] || item.status}` })));
}

// 判定区：打开一次运行，先看到口径与判词，再向下钻取证据。
function verdictPanel(run, analysis, cases) {
  const scope = analysis.scope;
  let word = statusNames[run.status] || run.status, tone = "", count, strip = null, legend = null;
  if (scope === "objective" && analysis.counts) {
    const c = analysis.counts.cases;
    count = `${c.passed} / ${c.planned}`;
    if (run.status === "running") { word = "进行中"; tone = "idle"; }
    // 运行本身失败时保留真实计数，但结论不得显示绿色全部通过。
    else if (run.status === "failed") { word = "运行失败"; tone = "bad"; }
    else if (c.failed) { word = `存在失败 ×${c.failed}`; tone = "bad"; }
    else if (c.passed === c.planned && c.planned > 0) { word = "全部通过"; tone = "good"; }
    else { word = "未全部完成"; tone = "idle"; }
    strip = caseStrip(analysis.cases.map(item => ({ status: item.status, name: item.id })));
    const rest = [["失败", c.failed], ["跳过", c.skipped], ["缺失", c.missing]].filter(([, n]) => n);
    if (rest.length && run.status !== "running") legend = text("span", rest.map(([label, n]) => `${label} ${n}`).join(" · "), "case-strip-legend");
  } else if (scope === "legacy") {
    const m = run.metrics;
    const failedCount = cases.filter(isFailed).length;
    if (run.status === "running" || run.status === "pending") { word = "进行中"; tone = "idle"; }
    else if (run.status === "failed") { word = "运行失败"; tone = "bad"; }
    else if (failedCount) { word = `存在失败 ×${failedCount}`; tone = "bad"; }
    else if (m && m.casesPassed === run.plannedCases && run.plannedCases > 0) { word = "全部通过"; tone = "good"; }
    count = m ? `${m.casesPassed} / ${run.plannedCases}` : `— / ${run.plannedCases}`;
    strip = cases.length ? caseStrip(cases.map(item => ({ status: isFailed(item) ? "failed" : item.status, name: item.name }))) : null;
    const passedCount = cases.filter(item => item.status === "passed" && !isFailed(item)).length;
    if (cases.length && (failedCount || cases.length - passedCount - failedCount)) {
      legend = text("span", [["失败", failedCount], ["其他", cases.length - passedCount - failedCount]].filter(([, n]) => n).map(([label, n]) => `${label} ${n}`).join(" · "), "case-strip-legend");
    }
  } else {
    count = "—";
    word = "口径无效";
  }
  const glyph = tone === "bad" ? "✕" : tone === "idle" || run.status === "running" ? "…" : tone === "good" ? "✓" : "−";
  const iconTone = glyph === "✕" ? "bad" : glyph === "…" ? "idle" : glyph === "✓" ? "good" : "flat";
  return node("section", { class: `panel verdict-panel${tone ? ` ${tone}` : ""}`, "aria-label": "评测结论" },
    node("div", { class: "verdict-head" },
      node("div", {}, text("h2", run.label || run.suiteName), text("p", `${date(run.startedAt)} · ${run.snapshot.model.id}`, "meta")),
      node("div", { class: "verdict-side" }, text("span", scopeNames[scope] || scope, `scope-badge ${scope}`), run.batch ? text("span", `↻ 批次 ${run.batch.repetition}/${run.batch.plannedRepetitions}`, "batch-tag") : null)),
    node("div", { class: "verdict-grid" },
      text("p", count, "verdict-count"),
      node("span", { class: `verdict-mark ${iconTone}`, role: "img", "aria-label": word, title: word }, glyph),
      strip, legend),
    text("p", `${ANSWER_NOTE} · ${scopeNotes[scope] || scopeNotes.invalid}`, "verdict-note"));
}

// 口径问题：计划无效、结果与计划不符或检索记录格式错误时列出后端说明，不猜测得分。
function issuesPanel(analysis) {
  if (analysis.scope !== "invalid" || !analysis.issues.length) return null;
  return node("section", { class: "panel issues-panel", "aria-label": "口径与数据问题" },
    node("div", { class: "panel-heading" }, text("h3", "口径与数据问题")),
    node("ul", { class: "issues-list" }, ...analysis.issues.map(issue => node("li", {}, issue))),
    text("p", "存在上述问题时不生成客观通过率；原始轨迹仍可在下方查看。", "metric-note"));
}

// 同配置批次稳定性：缺计划运行、运行未完成或案例跳过时一律标不完整，不展示稳定满分。
function batchPanel(run, batch) {
  if (!run.batch) return null;
  const title = `重复运行批次 · 第 ${run.batch.repetition} / ${run.batch.plannedRepetitions} 次`;
  const heading = node("div", { class: "panel-heading" }, text("h3", title), text("p", run.batch.id, "subtle-id"));
  if (!batch || batch.error) {
    return node("section", { class: "panel batch-panel" }, heading, text("p", batch?.error ? `批次稳定性暂时无法读取：${batch.error}` : "该运行的批次信息未收录。", "batch-note"));
  }
  if (!batch.compatible) {
    return node("section", { class: "panel batch-panel warning" }, heading,
      node("ul", { class: "issues-list" }, ...batch.issues.map(issue => node("li", {}, issue))),
      text("p", "批次配置不一致或元数据无效，不计算稳定性，任何场景都不能视为稳定。", "batch-note"));
  }
  const missing = batch.missingRuns ?? 0;
  const unfinished = batch.completedRuns < batch.startedRuns;
  const summary = [`计划 ${batch.plannedRepetitions ?? "未知"} 次`, `已启动 ${batch.startedRuns}`, `已完成 ${batch.completedRuns}`];
  if (missing) summary.push(`缺 ${missing} 次`);
  const usage = batch.usage;
  const noModel = usage.modelRequests === 0;
  const usageDetails = node("details", { class: "metric-details batch-usage" }, node("summary", {}, "批次用量"),
    node("div", { class: "metrics-foot" },
      noModel ? text("span", "无模型请求，用量、Tokens 与费用均不适用") : text("span", `模型请求 ${usage.modelRequests} · 已报用量 ${usage.reportedRequests} · 覆盖率 ${percent(usage.coverage)}`),
      noModel ? null : text("span", `已知 Tokens ${number(usage.knownTokens)} · 完整 Tokens ${usage.completeTokens === null ? "未采全" : number(usage.completeTokens)}`),
      noModel ? null : text("span", `已知费用 ${money(usage.knownCostUsd)} · 完整费用 ${usage.completeCostUsd === null ? "未采全" : money(usage.completeCostUsd)}`),
      noModel ? null : text("span", "缺任何一次计划运行时完整批次用量为 null，不补零。")));
  // 批次属次要诊断：整板默认折叠，摘要保留进度与稳定性短结果；缺次/未完成在摘要警示。
  // 逐场景明细在折叠内再折叠；缺计划运行、运行未完成或案例跳过时一律标不完整，不展示稳定满分。
  const tally = { always_passed: 0, always_failed: 0, mixed: 0, incomplete: 0 };
  for (const item of batch.cases) tally[item.status in tally ? item.status : "incomplete"]++;
  const overview = [["always_passed", "稳定通过"], ["always_failed", "稳定失败"], ["mixed", "结果波动"], ["incomplete", "不完整"]]
    .map(([status, label]) => [status, label, tally[status]]).filter(([, , n]) => n);
  const caution = missing || unfinished;
  const statusHint = overview.map(([, label, n]) => `${label} ${n}`).join(" · ");
  return node("section", { class: "panel batch-panel", "aria-label": "批次稳定性" },
    node("details", { class: "fold batch-fold" },
      node("summary", {},
        text("span", title, "fold-title"),
        text("span", [...summary, statusHint].filter(Boolean).join(" · "), `fold-hint${caution ? " warn" : ""}`)),
      node("div", { class: "fold-body" },
        node("div", { class: "batch-body" },
          text("p", `批次 ID：${run.batch.id}`, "subtle-id"),
          caution ? text("p", "尚有计划运行未开始或未完成，任何场景都不能视为稳定。", "batch-caution") : null,
          node("div", { class: "batch-runs" }, ...batch.runIds.map(id => node("button", {
            type: "button", class: `run-id-chip${id === run.id ? " current" : ""}`, title: id === run.id ? "当前运行" : "切换到该次运行",
            onclick: () => selectRun(id),
          }, short(id)))),
          batch.cases.length
            ? node("div", { class: "batch-overview" }, ...overview.map(([status, label, n]) => node("span", { class: `batch-stat ${status}` }, label, " ", text("strong", String(n)))))
            : text("p", "没有可汇总的批次场景。", "metric-note"),
          batch.cases.length
            ? node("details", { class: "batch-case-list" }, node("summary", {}, `逐场景稳定性 · ${batch.cases.length} 个场景`),
              node("div", { class: "batch-cases" },
                node("div", { class: "batch-case-head" }, text("span", "场景"), text("span", "逐次结果"), text("span", "稳定性")),
                ...batch.cases.map(item => node("div", { class: "batch-case" },
                  text("span", item.id, "batch-case-id mono"),
                  text("span", [`通过 ${item.passed}`, item.failed ? `失败 ${item.failed}` : null, item.skipped ? `跳过 ${item.skipped}` : null, item.missing ? `缺失 ${item.missing}` : null].filter(Boolean).join(" · "), "batch-case-counts"),
                  badge(item.status, stabilityNames[item.status] || item.status)))))
            : null,
          text("p", "“结果波动”仅表示观察到通过/失败变化，不估计统计置信区间。", "metric-note")),
        usageDetails)));
}

// 覆盖与分类：分母来自检查计划；标签是本题集定义的覆盖范围，不代表业务全集。
// 次要诊断默认折叠，摘要保留检查合计与失败/缺失异常提示。
function coveragePanel(analysis) {
  if (analysis.scope !== "objective" || !analysis.counts) return null;
  const checks = analysis.counts.checks;
  const abnormal = checks.failed || checks.missing;
  return node("section", { class: "panel coverage-panel", "aria-label": "覆盖与分类" },
    node("details", { class: "fold coverage-fold" },
      node("summary", {},
        text("span", "覆盖与分类", "fold-title"),
        text("span", `检查 ${countsLine(checks, "项")} · 通过率 ${percent(checks.passRate)}`, `fold-hint${abnormal ? " warn" : ""}`)),
      node("div", { class: "fold-body" },
        node("div", { class: "coverage-body" },
          node("div", { class: "category-summary" }, ...analysis.categories.map(item => node("span", { class: "category-chip" },
            categoryNames[item.category] || item.category,
            text("strong", `${item.checks.passed} / ${item.checks.planned}`),
            item.checks.failed || item.checks.missing ? text("em", [item.checks.failed ? `失败 ${item.checks.failed}` : null, item.checks.missing ? `缺失 ${item.checks.missing}` : null].filter(Boolean).join(" · ")) : null))),
          analysis.coverage.length ? node("div", { class: "coverage-list" }, ...analysis.coverage.map(item => node("div", { class: "coverage-row" },
            text("span", item.tag, "coverage-tag"),
            segmentBar(countsEntries(item.cases), `${item.tag}：${countsLine(item.cases, "场景")}`),
            text("span", countsLine(item.cases, "场景"), "coverage-counts")))) : text("p", "本题集没有定义覆盖标签。", "metric-note")),
        node("div", { class: "coverage-foot" }, text("p", "标签为本题集定义的覆盖范围，不代表业务全集。", "metric-note")))));
}

// 用量与耗时：首屏 Tokens 为主；known/complete 分列，null 不补零，无模型请求属不适用。
function metricsPanel(run, analysis, cases) {
  const m = run.metrics;
  const { usage, execution, timing } = analysis;
  const noModel = usage.modelRequests === 0;
  const partial = !noModel && usage.missingRequests > 0;
  const complete = (value, formatter) => noModel ? "不适用" : value === null || value === undefined ? "未采全" : formatter(value);
  const panel = node("section", { class: "panel", "aria-label": "运行指标" },
    node("div", { class: "metric-strip" },
      metric("单轮耗时 P95", duration(timing.durationP95Ms)),
      metric(partial ? "Tokens · 部分用量" : "Tokens", noModel ? "不适用" : number(usage.knownTokens))));
  const legacyLines = analysis.scope === "legacy" && m ? (() => {
    const doneTurns = m.turnsPassed + m.turnsFailed + m.turnsSkipped;
    const pending = Math.max(0, run.plannedCases - m.casesPassed - m.casesFailed - m.casesSkipped);
    const caseNote = [["失败", m.casesFailed], ["跳过", m.casesSkipped], ["未执行", pending]].filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(" · ") || "全部通过";
    const checks = cases.flatMap(checksOf);
    return [
      text("span", `场景计划 ${run.plannedCases} · ${caseNote}（历史措辞口径）`),
      text("span", `处理轮次通过 ${m.turnsPassed} / ${run.plannedTurns} · 失败 ${m.turnsFailed} · 跳过 ${m.turnsSkipped} · 未执行 ${Math.max(0, run.plannedTurns - doneTurns)}`),
      checks.length ? node("div", { class: "category-summary" }, ...Object.entries(categoryNames).map(([key, label]) => {
        const group = checks.filter(check => check.category === key);
        return node("span", { class: "category-chip" }, label, text("strong", `${group.filter(check => check.status === "passed").length} / ${group.length}`));
      })) : null,
    ];
  })() : [];
  panel.append(node("details", { class: "metric-details" }, node("summary", {}, "指标明细与口径"),
    node("div", { class: "metrics-foot" },
      text("span", noModel ? "用量：无模型请求，覆盖率与 Tokens 不适用" : `用量覆盖 ${usage.reportedRequests} / ${usage.modelRequests} 次模型请求 · 覆盖率 ${percent(usage.coverage)}${partial ? ` · 缺报 ${usage.missingRequests} 次，仅统计已报告部分` : ""}`),
      text("span", `Tokens：已知 ${noModel ? "不适用" : number(usage.knownTokens)} · 完整 ${complete(usage.completeTokens, number)}`),
      text("span", `费用：已知 ${noModel ? "不适用" : money(usage.knownCostUsd)} · 完整 ${complete(usage.completeCostUsd, money)}`),
      text("span", `执行：工具调用 ${number(execution.toolCalls)} · 非预期工具错误 ${number(execution.toolErrors)} · 预期身份拒绝 ${number(execution.expectedDenials)} · 模型错误 ${number(execution.modelErrors)}`),
      text("span", `耗时：样本 ${timing.samples} · P50 ${duration(timing.durationP50Ms)} · P95 ${duration(timing.durationP95Ms)} · 采集口径 ${timing.measurement || "未记录"}`),
      ...legacyLines),
    text("p", "完整量要求全部模型请求均已上报，未知时不补零；耗时按原采集口径展示，不代表 QQ 平台端到端送达；费用按已报告用量和 SDK 目录单价估算。", "metric-note")));
  return panel;
}

// 检索运行：按 corpus/suite 四组分别给出 Recall/MRR，不合并成一个召回率，也不并入工程或模型总分。
function retrievalPanel(retrieval) {
  if (!retrieval) return null;
  const cell = (value, className) => text("td", value, className);
  return node("section", { class: "panel retrieval-panel", "aria-label": "检索指标" },
    node("div", { class: "panel-heading" }, text("h3", "检索指标"), text("p", "评估检索器，不评回答质量")),
    node("div", { class: "retrieval-scroll" }, node("table", { class: "retrieval-table" },
      node("thead", {}, node("tr", {}, ...["语料", "题集", "样本", "Recall@1", "Recall@5", "MRR", "MRR@5"].map(label => text("th", label)))),
      node("tbody", {}, ...retrieval.groups.map(group => node("tr", {},
        cell(corpusNames[group.corpus] || group.corpus), cell(retrievalSuiteNames[group.suite] || group.suite), cell(String(group.samples), "mono"),
        cell(percent(group.recallAt1), "mono"), cell(percent(group.recallAt5), "mono"), cell(ratio(group.mrr), "mono"), cell(ratio(group.mrrAt5), "mono")))))),
    node("div", { class: "retrieval-foot" },
      text("p", `无答案题 ${retrieval.noAnswer.samples}：空召回 ${retrieval.noAnswer.empty} · 非空召回 ${retrieval.noAnswer.nonempty}；非空召回仅作召回诊断，不代表回答错误。`),
      text("p", `范围隔离：${retrieval.scope.passed} / ${retrieval.scope.samples} 通过${retrieval.scope.failed ? ` · 越界 ${retrieval.scope.failed}` : ""}。`),
      text("p", "检索指标与工程检查、模型行为分列展示，不合成总分。", "metric-note")));
}

// 运行级执行分工：归因是同一次执行的另一视角，默认折叠放场景之后。
// groups 按执行方/触发/组件逐项列出，不造合计，不与 steps 的调用量、Tokens、费用相加。
// 旧记录 attribution 为 null 或省略时显示未采集，不补零。
function attributionPanel(analysis) {
  const attribution = analysis.attribution ?? null;
  const body = attribution
    ? [
        attribution.groups.length ? node("div", { class: "attr-groups" },
          node("div", { class: "attr-row attr-head" }, ...["执行方", "触发", "组件", "调用", "业务拒绝", "执行错误"].map(label => text("span", label))),
          ...attribution.groups.map(group => node("div", { class: "attr-row" },
            text("span", actorNames[group.actor] || group.actor),
            text("span", triggerNames[group.trigger] || group.trigger),
            text("span", group.component, "mono"),
            text("span", String(group.calls), "mono"),
            text("span", String(group.denied), "mono"),
            text("span", String(group.errors), "mono")))) : null,
        text("p", "入口与嵌套服务分别计数，不是可相加的总数；不与执行轨迹的调用量、Tokens、费用重复相加。", "metric-note"),
        ...(attribution.issues?.length ? [node("ul", { class: "issues-list" }, ...attribution.issues.map(issue => node("li", {}, issue)))] : []),
      ].filter(Boolean)
    : [text("p", "该运行没有归因记录（旧记录未采集），不补零。", "metric-note")];
  return node("section", { class: "panel attribution-panel", "aria-label": "执行分工" },
    node("details", { class: "fold attr-fold" },
      node("summary", {}, text("span", "执行分工", "fold-title"), text("span", attribution ? `已记录 ${attribution.spans} 段` : "未采集", "fold-hint")),
      node("div", { class: "fold-body attr-body" }, ...body)));
}

function stepNode(step) {
  const status = step.isError ? step.expectedDenial ? badge("passed", "预期身份拒绝") : badge("failed", "执行错误") : badge("passed", "已完成");
  return node("details", { class: "step" },
    node("summary", { class: "step-top" }, text("span", `#${step.index} ${step.type === "model" ? "模型" : "工具"}`, "step-index"), text("span", step.name, "step-name"), status, text("span", `${step.type === "model" ? "响应流 " : ""}${duration(step.durationMs)}`, "step-timing")),
    step.input !== undefined ? node("div", {}, text("p", step.type === "tool" ? "调用参数" : "请求摘要", "step-label"), json(step.input)) : null,
    step.output !== undefined ? node("div", {}, text("p", step.type === "tool" ? "返回证据" : "模型响应", "step-label"), json(step.output)) : null,
    step.type === "model" ? text("p", step.usage ? `输入 ${number(step.usage.input)} · 输出 ${number(step.usage.output)} · 缓存读 ${number(step.usage.cacheRead)} / 写 ${number(step.usage.cacheWrite)} · 估算 ${money(step.usage.estimatedCostUsd)}` : "此请求未提供用量数据", "step-usage") : null);
}

function checksNode(checks, onlyFailures = false) {
  const items = onlyFailures ? checks.filter(check => check.status !== "passed") : checks;
  if (!items.length) return null;
  return node("ul", { class: "check-list", "aria-label": "检查结果" }, ...items.map(check => node("li", {}, mark(check.status), text("span", check.name), check.reason ? text("span", check.reason, "check-reason") : null)));
}

const isSpanRecord = span => span !== null && typeof span === "object" && !Array.isArray(span);
// 明显缺字段或非法 actor/trigger/outcome 的记录：标无效并展示原始 JSON，不标正常、不静默丢弃。
const spanUsable = span => isSpanRecord(span)
  && typeof span.component === "string" && typeof span.name === "string"
  && (span.actor === "agent" || span.actor === "host")
  && (span.trigger === "user" || span.trigger === "event" || span.trigger === "confirmation")
  && (span.outcome === "ok" || span.outcome === "denied" || span.outcome === "error");

// provider 子 span 的用量行：CNY/USD 与来源分列，缺费用显示未知，不与父 span 或 steps 重复汇总。
function spanUsageLine(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : null;
  const costText = !cost ? "费用未知"
    : `${cost.currency === "CNY" ? "CNY" : "USD"} ${cost.amount === null || cost.amount === undefined ? "未知" : `${cost.currency === "CNY" ? "¥" : "$"}${Number(cost.amount).toFixed(6)}`}（${cost.source || "估算"}）`;
  return text("p", `${usage.kind || "provider"} · 输入 ${number(usage.inputTokens)} · 输出 ${number(usage.outputTokens)} · 合计 ${number(usage.totalTokens)} · ${costText}`, "step-usage");
}

const knowledgeModeNames = { lexical: "本地词项", "m4-support": "全候选重排 + 事实支持" };
const knowledgeStatus = { accepted: ["passed", "接受"], rejected: ["skipped", "拒收"], unavailable: ["failed", "不可用"] };
const knowledgeReasons = { invalid_input: "输入无效", aborted: "已中止", timeout: "查询超时", database_unavailable: "数据库不可用", provider_unavailable: "模型服务不可用", source_changed: "来源已变化" };
const knowledgeRejectReasons = {
  provider_unavailable: "模型服务不可用", not_applicable: "不适用", no_candidates: "无候选", unknown_document: "未知文档",
  inactive_document: "文档已停用", out_of_scope: "超出授权范围", duplicate_document: "重复文档", missing_score: "缺少分数",
  invalid_score: "分数无效", below_threshold: "低于阈值", top_k_limit: "超出条数上限",
  support_verification_required: "待支持判别", unsupported: "事实不支持", support_unavailable: "支持判别不可用",
};
const knowledgeStageNames = { read: "读取", rerank: "重排", support: "支持判别", recheck: "复检" };
const knowledgeVerdictCategories = { direct_fact: "事实或规则", boundary_answer: "明确安全边界问题的回答", limitation_only: "仅说明缺失或需核实", unrelated: "无关" };
const knowledgeMs = value => value === null || value === undefined || !Number.isFinite(value) ? "未知" : `${Math.round(value)} ms`;
const knowledgeMoney = (value, symbol) => value === null || value === undefined || !Number.isFinite(value) ? "未知" : `${symbol}${value.toFixed(6)}`;

// 单次知识取证：首层方案/状态/范围短值/来源/耗时；细节折叠可信上下文、原文、拒收原因、阶段时延与分列成本。
// scope 拒绝属授权判定，不作幻觉结论；阈值是分数门限不是概率。来源正文一律 textContent，防注入。
// 来源版本只取本轮 trace.sources（实际接受原文 sha256）；policyTopic.sources 属历史话题，不充当本轮版本。
function knowledgeNode(span) {
  const knowledge = span.knowledge && typeof span.knowledge === "object" ? span.knowledge : {};
  const context = knowledge.context && typeof knowledge.context === "object" ? knowledge.context : {};
  const trace = knowledge.trace && typeof knowledge.trace === "object" ? knowledge.trace : {};
  const [tone, label] = knowledgeStatus[trace.status] || ["flat", trace.status || "未知"];
  const modeLabel = trace.mode === "m4-support"
    ? `m4-support · 阈值 ${trace.threshold === null || trace.threshold === undefined ? "未记录" : trace.threshold}`
    : knowledgeModeNames[trace.mode] || trace.mode || span.name;
  const scopeLabel = trace.scope?.shopId ? trace.scope.productId ? `${short(trace.scope.shopId)} + ${short(trace.scope.productId)}` : short(trace.scope.shopId) : "全局";
  const traceSources = Array.isArray(trace.sources) ? trace.sources.filter(source => source && typeof source === "object") : null;
  const versionOf = id => {
    const found = traceSources?.find(source => source.sourceId === id);
    return found?.version ? short(found.version) : "未记录";
  };
  const topicSources = context.policyTopic && Array.isArray(context.policyTopic.sources) ? context.policyTopic.sources.length : 0;
  const rawAccepted = Array.isArray(trace.acceptance?.accepted) ? trace.acceptance.accepted : [];
  const rawRejected = Array.isArray(trace.acceptance?.rejected) ? trace.acceptance.rejected : [];
  const accepted = rawAccepted.filter(doc => doc && typeof doc === "object");
  const rejected = rawRejected.filter(item => item && typeof item === "object");
  // 判别明细：supportVerification 为对象 {value, requestHash, inputHash, attempts}，value 是逐文档模型判断。
  // 容器非对象或 value 非数组属记录异常，明确诊断、不默默兼容；binary 旧条目没有 category 标“二元判断”；未请求/失败不记为不支持。
  const verification = trace.supportVerification;
  const verificationInvalid = verification !== null && verification !== undefined
    && (typeof verification !== "object" || Array.isArray(verification) || !Array.isArray(verification.value));
  const rawVerdicts = !verificationInvalid && verification ? verification.value : [];
  const verdicts = rawVerdicts.filter(item => item && typeof item === "object");
  const dropped = rawAccepted.length - accepted.length + (rawRejected.length - rejected.length) + (rawVerdicts.length - verdicts.length);
  const rawProfile = trace.supportProfile ?? trace.settings?.support?.profile;
  const promptVersion = trace.settings?.support?.promptVersion;
  const profileLabel = rawProfile === "typed" ? "typed 分类判别"
    : rawProfile === "binary" || promptVersion === "fact-support-v1" ? "binary 二元判断" : "未知";
  // 实际执行模型以 settings.support.provider/model 为准（trace.supportModel 只是配置选择）；缺记录不猜。
  const supportProvider = trace.settings?.support?.provider;
  const supportModelName = trace.settings?.support?.model;
  const modelSegment = supportProvider || supportModelName ? ` · ${[supportProvider, supportModelName].filter(Boolean).join("/")}` : "";
  const usage = trace.usage && typeof trace.usage === "object" ? trace.usage : {};
  const stages = Array.isArray(trace.stages) ? trace.stages.filter(stage => stage && typeof stage === "object") : [];
  return node("div", { class: "knowledge-call" },
    node("p", { class: "knowledge-head" },
      badge(tone, label),
      text("span", `${span.name} · ${modeLabel} · 范围 ${scopeLabel} · 耗时 ${duration(trace.durationMs)}`)),
    text("p", accepted.length
      ? `来源 ${accepted.map(doc => `${doc.id} · 版本 ${versionOf(doc.id)}`).join("、")}`
      : "无被接受来源", "knowledge-line"),
    node("details", { class: "trace" },
      node("summary", {}, "取证细节"),
      text("p", `原始问题：${context.originalQuery ?? trace.originalQuery ?? "未记录"}`, "knowledge-line"),
      context.modelQuestion ? text("p", `模型建议问题（仅审计）：${context.modelQuestion}`, "knowledge-line") : null,
      text("p", `实际检索问题（宿主构造）：${context.effectiveQuery ?? trace.query ?? "未记录"}`, "knowledge-line"),
      text("p", `实际范围：shopId ${trace.scope?.shopId ?? "全局"} · productId ${trace.scope?.productId ?? "未限定"}`, "knowledge-line"),
      context.facts ? text("p", `可信事实：${context.facts.orderId} · ${context.facts.status} · ${context.facts.productName} · 退款状态 ${context.facts.refundState} · 截止 ${date(context.facts.asOf)}`, "knowledge-line") : null,
      context.policyTopic ? text("p", `可信话题（历史话题，不作本轮版本依据）：来源 ${topicSources} 条 · 范围 ${context.policyTopic.scope?.shopId || "全局"}${context.policyTopic.scope?.productId ? ` + ${context.policyTopic.scope.productId}` : ""}`, "knowledge-line") : null,
      accepted.length
        ? node("div", { class: "knowledge-docs" }, ...accepted.map(doc => node("div", { class: "knowledge-doc" },
          text("p", `${doc.title || doc.id}${doc.score === null || doc.score === undefined ? "" : ` · 分数 ${doc.score}`}`, "knowledge-doc-title"),
          text("p", doc.body ?? "", "knowledge-doc-body"))))
        : null,
      trace.reason ? text("p", `失败原因：${knowledgeReasons[trace.reason] || trace.reason}`, "knowledge-line") : null,
      rejected.length
        ? node("ul", { class: "check-list" }, ...rejected.map(item => node("li", {},
          text("span", `${item.id ?? "—"} · ${knowledgeRejectReasons[item.reason] || item.reason || "未记录"}`))))
        : null,
      rawProfile || promptVersion ? text("p", `判别配置：${profileLabel}${modelSegment}${promptVersion ? ` · prompt ${promptVersion}` : ""}`, "knowledge-line") : null,
      verificationInvalid ? text("p", "判别明细记录异常，无法解析。", "knowledge-line") : null,
      verdicts.length
        ? node("details", { class: "trace" },
          node("summary", {}, `判别明细 · ${verdicts.length} 条`),
          node("ul", { class: "check-list" }, ...verdicts.map(item => node("li", {},
            text("span", `${item.id ?? "—"} · ${item.category ? knowledgeVerdictCategories[item.category] || item.category : "二元判断"} · ${item.supported === true ? "支持" : item.supported === false ? "不支持" : "未知"}`),
            item.quote ? text("span", ` 引用：${item.quote}`) : null,
            item.reason ? text("span", ` 原因：${item.reason}`) : null))),
          text("p", "宿主仅接受事实或规则与明确安全边界问题的回答；仅说明缺失或无关内容不作为具体事实证据；未请求或失败不记为不支持。", "knowledge-line"))
        : null,
      dropped ? text("p", `另有 ${dropped} 条取证记录无法解析。`, "knowledge-line") : null,
      text("p", "范围拒绝属授权判定，不作幻觉结论；阈值是分数门限，不是概率。", "knowledge-line"),
      stages.length ? text("p", `阶段时延：${stages.map(stage => `${knowledgeStageNames[stage.name] || stage.name || "未知"} ${knowledgeMs(stage.durationMs)}`).join(" · ")}`, "knowledge-line knowledge-stages") : null,
      text("p", `成本（估算）：重排 Tokens ${usage.rerankTokens === null || usage.rerankTokens === undefined ? "未知" : number(usage.rerankTokens)} · 支持 Tokens ${usage.supportTokens === null || usage.supportTokens === undefined ? "未知" : number(usage.supportTokens)} · CNY ${knowledgeMoney(usage.estimatedCny, "¥")} · USD ${knowledgeMoney(usage.estimatedUsd, "$")} · 缺量调用 ${usage.incompleteCalls === null || usage.incompleteCalls === undefined ? "未知" : usage.incompleteCalls}`, "knowledge-line")),
    node("details", { class: "trace" }, node("summary", {}, "原始 trace JSON"), json(knowledge)));
}

// 单个归因 span：denied 是已知业务拒绝，error 是执行错误，两者分列；input/output 走 json 文本展示，天然转义。
function spanNode(span) {
  if (!spanUsable(span)) {
    return node("details", { class: "step span invalid" },
      node("summary", { class: "step-top" }, badge("failed", "归因记录无效")),
      json(span ?? null));
  }
  const outcome = span.outcome === "denied" ? badge("skipped", "业务拒绝") : span.outcome === "error" ? badge("failed", "执行错误") : badge("passed", "正常");
  return node("details", { class: "step span" },
    node("summary", { class: "step-top" },
      text("span", actorNames[span.actor] || span.actor, "step-index"),
      text("span", `${span.component} · ${actionNames[span.name] ? `${span.name}（${actionNames[span.name]}）` : span.name}`, "step-name"),
      outcome,
      text("span", duration(span.durationMs), "step-timing")),
    span.input !== undefined ? node("div", {}, text("p", "输入", "step-label"), json(span.input)) : null,
    span.output !== undefined ? node("div", {}, text("p", "输出", "step-label"), json(span.output)) : null,
    spanUsageLine(span.usage));
}

function turnNode(turn, compact = false) {
  const spans = Array.isArray(turn.spans) ? turn.spans : null;
  // 轮次类型优先依据可信入口 span 的 trigger：event 商家事件、confirmation 用户确认、user 普通用户。
  // 入口只认非数组对象且 trigger 属于已知三种的记录；未知 trigger 不默认 user，回退到文本判断。
  // 旧记录无 spans 时沿用问题文本判断商家事件（merchant-notification 套件末轮）。
  const ingress = spans?.find(span => isSpanRecord(span) && span.component === "qq-ingress"
    && (span.trigger === "user" || span.trigger === "event" || span.trigger === "confirmation")) ?? null;
  const trigger = ingress?.trigger ?? null;
  const legacyEvent = trigger === null && turn.question.trimStart().startsWith("[商家结果事件]");
  const isEvent = trigger === "event" || legacyEvent;
  const questionLabel = trigger === "event" ? "商家事件" : trigger === "confirmation" ? "用户确认" : legacyEvent ? "事件" : "用户";
  // 事件与确认的回执由宿主执行，标宿主；普通用户轮保留 Agent，不因含宿主内部服务 span 误标。
  const replyLabel = trigger === "event" || trigger === "confirmation" ? "宿主" : "Agent";
  const element = node("div", { class: "turn" },
    node("div", { class: "turn-top" }, text("h4", `第 ${turn.index} 轮`), mark(turn.status), text("span", duration(turn.durationMs), "turn-timing")),
    node("div", { class: "dialogue" }, text("span", questionLabel, isEvent ? "speaker event-speaker" : "speaker"), text("p", turn.question, isEvent ? "bubble event" : "bubble"), text("span", replyLabel, "speaker"), text("p", turn.reply || "此轮没有回复", "bubble answer")),
    turn.evidenceIds.length ? node("div", { class: "evidence-line" }, text("span", "实际工具证据"), ...turn.evidenceIds.map(id => text("code", id, "evidence-tag"))) : text("p", "本轮没有返回工具证据", "metric-note"),
    turn.error ? text("p", turn.error, "turn-error") : null,
    checksNode(turn.checks, true));
  if (!compact) {
    element.append(
      node("details", { class: "trace" }, node("summary", {}, `已记录检查 · ${turn.checks.filter(check => check.status === "passed").length} / ${turn.checks.length} 通过`), checksNode(turn.checks)),
      node("details", { class: "trace" }, node("summary", {}, `执行轨迹 · ${turn.steps.length} 步`), text("p", `首个文本 ${duration(turn.firstTextMs)}，可能是中间回答；模型步骤仅计响应流，不含请求等待。`, "metric-note"), ...turn.steps.map(stepNode)));
    // v2 归因 span 是同一次执行的另一视角，逐项展示但不与 steps 计数相加；旧记录无 spans 不渲染、不补零。
    if (spans) {
      const noModel = !turn.steps.some(step => step.type === "model");
      element.append(node("details", { class: "trace" },
        node("summary", {}, spans.length ? `执行分工 · ${spans.length} 段` : "执行分工"),
        spans.length
          ? spans.map(spanNode)
          : text("p", "暂无归因记录；显式为空不代表模型调用为零。", "metric-note"),
        noModel ? text("p", "本轮无模型请求。", "metric-note") : null));
      // 知识取证：一轮可能有多次 FAQ 调用，逐次展示；旧记录无 knowledge 不渲染。
      const knowledgeSpans = spans.filter(span => isSpanRecord(span) && span.knowledge && typeof span.knowledge === "object");
      if (knowledgeSpans.length) {
        element.append(node("details", { class: "trace" },
          node("summary", {}, `知识取证 · ${knowledgeSpans.length} 次`),
          ...knowledgeSpans.map(knowledgeNode)));
      }
    }
    // observations 是工作流检查保存的精简真实状态与协议证据，原样展开，不参与计分。
    if (turn.observations) {
      const fields = [["before", "前置状态"], ["after", "后置状态"], ["protocol", "协议证据"]].filter(([key]) => turn.observations[key] !== undefined);
      if (fields.length) element.append(node("details", { class: "trace" }, node("summary", {}, `状态与协议证据 · 合成诊断，不参与计分`),
        ...fields.map(([key, label]) => node("div", {}, text("p", label, "step-label"), json(turn.observations[key])))));
    }
  }
  return element;
}

// 大量案例（如检索约 290 题）时只在展开时构建详情，避免一次渲染全部轨迹。
function lazyDetails(className, summary, build, open = false) {
  const body = node("div", { class: "case-body" });
  const details = node("details", { class: className }, summary, body);
  let built = false;
  const fill = () => {
    if (built) return;
    built = true;
    body.replaceChildren(...build());
  };
  details.addEventListener("toggle", () => { if (details.open) fill(); });
  if (open) {
    details.open = true;
    fill();
  }
  return details;
}

function caseRowNode(row, total) {
  const name = displayCaseName(row.id, row.item?.name);
  const summary = node("summary", {},
    node("span", { class: "case-name", title: `场景 ID：${row.id}` }, name),
    ...row.tags.map(tag => text("span", tag, "tag-chip")),
    row.analysis ? text("span", `${row.analysis.checks.passed} / ${row.analysis.checks.planned} 检查`, "case-meta") : null,
    text("span", row.item ? `${row.item.turns.length} 轮` : "无执行记录", "case-meta"),
    mark(row.status));
  return lazyDetails("case", summary,
    () => [
      name !== row.id ? text("p", row.id, "subtle-id") : null,
      ...(row.item ? row.item.turns.map(turn => turnNode(turn)) : [text("p", "该场景已计划但没有执行记录，按缺失计入分母。", "metric-note")]),
    ].filter(Boolean),
    row.failure && row.item && total <= 30);
}

// 场景结果：客观运行以 analysis 为准（含缺失计划场景），历史运行沿用详情记录与措辞口径标记。
function casesPanel(run, analysis, cases) {
  const objective = analysis.scope === "objective";
  const rows = objective
    ? analysis.cases.map(item => ({ id: item.id, tags: item.tags, status: item.status, failure: item.status === "failed", item: cases.find(value => value.id === item.id) ?? null, analysis: item }))
    : cases.map(item => ({ id: item.id, tags: [], status: isFailed(item) ? "failed" : item.status, failure: isFailed(item), item, analysis: null }));
  const planned = objective ? analysis.counts.cases.planned : run.plannedCases;
  const list = node("div", { class: "case-list" });
  const filters = [["all", `全部场景 ${rows.length}`], ["failed", `失败 ${rows.filter(row => row.failure).length}`],
    ...["skipped", "missing"].map(status => [status, `${statusNames[status]} ${rows.filter(row => row.status === status).length}`])];
  const buttons = new Map();
  const apply = key => {
    for (const [name, button] of buttons) {
      button.classList.toggle("active", name === key);
      button.setAttribute("aria-pressed", String(name === key));
    }
    const selected = key === "all" ? rows : key === "failed" ? rows.filter(row => row.failure) : rows.filter(row => row.status === key);
    list.replaceChildren(...selected.map(row => caseRowNode(row, rows.length)));
    if (!selected.length) list.append(text("p", "该分类下没有场景。", "sidebar-empty"));
  };
  for (const [key, label] of filters) {
    const button = node("button", { class: "filter-button", type: "button", onclick: () => apply(key) }, label);
    buttons.set(key, button);
  }
  apply("all");
  return node("section", { class: "panel" },
    node("div", { class: "panel-heading" }, text("h3", `场景结果 · 计划 ${planned}`), node("div", { class: "case-toolbar" }, ...buttons.values())),
    list);
}

function snapshotPanel(run, heading = "配置与评测快照") {
  const s = run.snapshot;
  const fields = [
    ["运行 ID", run.id], ["评测套件", run.suiteName], ["开始 / 结束", `${date(run.startedAt)} / ${date(run.finishedAt)}`],
    ["代码版本", `${short(s.gitCommit)}${s.gitDirty ? " · 含未提交变更" : " · 工作区干净"}`],
    ["模型", `${s.model.provider} / ${s.model.id}`],
    ["生成配置", `maxTokens ${s.model.maxTokens} · thinking ${s.model.thinking} · temperature ${s.model.temperature ?? "提供方默认"}`],
    ["业务数据时间", date(s.asOf)],
    ...Object.entries(s.hashes).map(([key, hash]) => [({ prompt: "Prompt", skill: "Skill", tools: "工具定义", dataset: "评测集", checker: "检查规则", business: "业务数据" })[key] || key, short(hash)]),
  ];
  if (run.batch) fields.push(["重复批次", `${short(run.batch.id)} · 第 ${run.batch.repetition} / ${run.batch.plannedRepetitions} 次`]);
  return node("section", { class: "panel" }, node("details", { class: "snapshot" }, node("summary", {}, heading),
    node("dl", { class: "snapshot-grid" }, ...fields.flatMap(([label, value]) => [text("dt", label), text("dd", value, "mono")])),
    node("details", {}, node("summary", { class: "metric-note" }, "查看完整快照 JSON"), json(s))));
}

function renderDetail(result, analysis, batch) {
  const { run, cases } = result;
  // 首屏顺序：结论与核心数字 → 场景结果/失败入口 → 次要诊断（批次、覆盖默认折叠；口径问题与报错保持外露）。
  $("run-detail").replaceChildren(
    verdictPanel(run, analysis, cases),
    ...(run.error ? [text("p", run.error, "error-note")] : []),
    ...[issuesPanel(analysis)].filter(Boolean),
    metricsPanel(run, analysis, cases),
    ...(retrievalPanel(analysis.retrieval) ? [retrievalPanel(analysis.retrieval)] : []),
    casesPanel(run, analysis, cases),
    ...[attributionPanel(analysis), batchPanel(run, batch), coveragePanel(analysis)].filter(Boolean),
    snapshotPanel(run));
}

// 可比性完全以后端判定为准：conditions 全部明确相等才可比，configuration 再决定能否视为同配置复跑。
function conditionTags(list) {
  return node("div", { class: "condition-tags" }, ...list.map(item =>
    text("span", `${conditionNames[item.key] || item.key} ${conditionStatus[item.status] || item.status}`, `condition-tag ${item.status}`)));
}

function compatibilityPanel(comparison) {
  const { comparable, repeatCompatible, conditions, configuration, issues } = comparison;
  const names = list => list.filter(item => item.status !== "equal").map(item => conditionNames[item.key] || item.key);
  let title, note, warning = false;
  if (comparable && repeatCompatible) {
    title = "相同配置复跑";
    note = "条件与配置全部明确一致；剩余差异可能来自模型生成波动。";
  } else if (comparable) {
    title = "口径一致，配置有变化";
    note = `不同或未知：${names(configuration).join("、") || "无"}。通过率可对比，归因需结合配置差异。`;
  } else {
    warning = true;
    title = "条件不同，不展示通过率与耗时的优劣结论";
    note = `不一致或未知：${names(conditions).join("、") || "无"}。`;
  }
  const conditionsNode = node("details", { class: "conditions" }, node("summary", {}, "核对条件与配置"),
    text("p", "评测条件", "step-label"), conditionTags(conditions),
    text("p", "运行配置", "step-label"), conditionTags(configuration));
  if (warning) conditionsNode.open = true;
  return node("div", { class: `compatibility${warning ? " warning" : ""}` },
    text("h3", title), text("p", note),
    ...issues.map(issue => text("p", issue, "condition-issue")),
    conditionsNode);
}

// delta 卡：与运行指标同款软卡；变化浓缩为一枚徽章（↑/↓ 表方向，绿/红表优劣，= 持平，— 缺数据）。
function deltaMetric(label, a, b, formatter, lowerBetter = false, deltaFormatter = formatter) {
  const known = a !== null && a !== undefined && b !== null && b !== undefined;
  const delta = known ? b - a : null;
  const tone = !known || delta === 0 ? "flat" : (lowerBetter ? delta < 0 : delta > 0) ? "good" : "bad";
  const arrow = !known ? "—" : delta === 0 ? "=" : delta > 0 ? "↑" : "↓";
  const hint = !known ? "缺少完整数据，不作对比" : delta === 0 ? "无变化" : tone === "good" ? "候选相对基线更优" : "候选相对基线更差";
  return node("div", { class: "metric delta-metric" }, text("p", label, "metric-label"),
    node("div", { class: "delta-values" }, text("span", formatter(a)), text("span", "→", "arrow"), text("span", formatter(b)),
      node("span", { class: `delta-chip ${tone}`, role: "img", "aria-label": hint, title: hint }, delta ? `${arrow} ${deltaFormatter(Math.abs(delta))}` : arrow)));
}

// 仅在后端判定可比时展示优劣 delta；Tokens 只取完整用量，未采全不参与对比。
function deltaPanel(comparison) {
  const A = comparison.analyses.baseline, B = comparison.analyses.candidate;
  const passRate = analysis => analysis.counts?.cases.passRate ?? null;
  return node("section", { class: "panel", "aria-label": "指标对比" },
    node("div", { class: "comparison-grid" },
      deltaMetric("场景通过率", passRate(A), passRate(B), percent, false, value => `${(value * 100).toFixed(1)}pp`),
      deltaMetric("单轮耗时 P95", A.timing.durationP95Ms, B.timing.durationP95Ms, duration, true),
      deltaMetric("Tokens · 完整用量", A.usage.completeTokens, B.usage.completeTokens, number, true)));
}

// comparable 只表示条件一致，不表示已经跑完：两侧 completed 且计划轮次无缺失/跳过才可给优劣结论。
// 未完成时仅并列已采集值（Tokens 取已报告的 known 量），明确不作优化结论。
function metricsComparePanel(comparison, a, b) {
  const A = comparison.analyses.baseline, B = comparison.analyses.candidate;
  const turnsSettled = analysis => analysis.counts && analysis.counts.turns.missing === 0 && analysis.counts.turns.skipped === 0;
  const settled = a.run.status === "completed" && b.run.status === "completed" && turnsSettled(A) && turnsSettled(B);
  if (settled) return deltaPanel(comparison);
  const pair = (label, va, vb) => node("div", { class: "metric delta-metric" }, text("p", label, "metric-label"),
    node("div", { class: "delta-values" }, text("span", va), text("span", "→", "arrow"), text("span", vb),
      node("span", { class: "delta-chip flat", role: "img", "aria-label": "不作优劣结论", title: "不作优劣结论" }, "—")));
  return node("section", { class: "panel", "aria-label": "指标对比" },
    node("div", { class: "comparison-grid" },
      pair("场景通过率", percent(A.counts?.cases.passRate ?? null), percent(B.counts?.cases.passRate ?? null)),
      pair("单轮耗时 P95", duration(A.timing.durationP95Ms), duration(B.timing.durationP95Ms)),
      pair("Tokens · 已采集", number(A.usage.knownTokens), number(B.usage.knownTokens))),
    text("p", "运行未完成或计划轮次未采齐：仅并列已采集值，不作优劣结论。", "compare-limited"));
}

function pairedSide(item, label) {
  if (!item) return node("div", { class: "paired-side" }, text("p", label, "paired-side-heading"), text("p", "该运行没有此场景结果。", "metric-note"));
  return node("div", { class: "paired-side" }, node("div", { class: "paired-side-heading" }, text("span", label), mark(item.status)), ...item.turns.map(turn => turnNode(turn, true)));
}

function pairedPanel(comparison, a, b) {
  const rows = comparison.cases.map(row => ({
    ...row,
    aCase: a.cases.find(item => item.id === row.id) ?? null,
    bCase: b.cases.find(item => item.id === row.id) ?? null,
    tags: comparison.analyses.baseline.cases.find(item => item.id === row.id)?.tags ?? comparison.analyses.candidate.cases.find(item => item.id === row.id)?.tags ?? [],
  }));
  const changed = rows.filter(row => row.change === "improved" || row.change === "regressed").length;
  const incomplete = rows.filter(row => row.change === "incomplete").length;
  const list = node("div", {});
  const filters = [["all", `全部场景 ${rows.length}`], ["changed", `变化 ${changed}`], ["incomplete", `不完整 ${incomplete}`]];
  const buttons = new Map();
  const apply = key => {
    for (const [name, button] of buttons) {
      button.classList.toggle("active", name === key);
      button.setAttribute("aria-pressed", String(name === key));
    }
    const selected = key === "all" ? rows : key === "changed" ? rows.filter(row => row.change === "improved" || row.change === "regressed") : rows.filter(row => row.change === "incomplete");
    list.replaceChildren(...selected.map(row => {
      const tone = row.change === "regressed" ? "bad" : row.change === "improved" ? "good" : "";
      const rowClass = row.change === "regressed" ? "regression" : row.change === "improved" ? "improvement" : "";
      return lazyDetails(`paired-case ${rowClass}`,
        node("summary", { class: "paired-heading" }, node("span", { class: "case-name", title: `场景 ID：${row.id}` }, displayCaseName(row.id, row.bCase?.name || row.aCase?.name)),
          ...row.tags.map(tag => text("span", tag, "tag-chip")),
          node("span", { class: "paired-status" }, text("span", "A", "case-meta"), mark(row.baseline), text("span", "→", "case-meta"), text("span", "B", "case-meta"), mark(row.candidate)),
          text("span", changeNames[row.change] || row.change, `change-tag ${tone}`)),
        () => [text("p", row.id, "subtle-id"), node("div", { class: "paired-columns" }, pairedSide(row.aCase, "A · 基线"), pairedSide(row.bCase, "B · 候选"))]);
    }));
    if (!selected.length) list.append(text("p", "该分类下没有场景。", "sidebar-empty"));
  };
  for (const [key, label] of filters) {
    const button = node("button", { class: "filter-button", type: "button", onclick: () => apply(key) }, label);
    buttons.set(key, button);
  }
  apply("all");
  return node("section", { class: "panel" },
    node("div", { class: "panel-heading" }, text("h3", `场景对比 · 共 ${rows.length} 场景`),
      text("p", "变化结论仅在后端判定可比且两侧均有明确结果时给出"), node("div", { class: "case-toolbar" }, ...buttons.values())),
    list);
}

async function compare() {
  const request = ++state.comparison;
  const aId = $("baseline").value;
  const bId = $("candidate").value;
  if (!aId || !bId || aId === bId) {
    $("compare-detail").replaceChildren(empty("请选择两次不同的运行", "基线 A 与候选 B 应来自两次独立评测。"));
    return;
  }
  $("compare-button").disabled = true;
  $("compare-detail").replaceChildren(empty("正在对比…", ""));
  try {
    const [comparison, a, b] = await Promise.all([
      api(`/api/compare?baseline=${encodeURIComponent(aId)}&candidate=${encodeURIComponent(bId)}`),
      detail(aId), detail(bId),
    ]);
    if (request !== state.comparison) return;
    $("compare-detail").replaceChildren(
      compatibilityPanel(comparison),
      ...(comparison.comparable
        ? [metricsComparePanel(comparison, a, b)]
        : [node("section", { class: "panel" }, text("p", "两侧评测条件不同或未知，按合同不展示通过率、耗时与 Tokens 的优劣结论；以下仅并列场景状态与轨迹。", "compare-limited"))]),
      pairedPanel(comparison, a, b),
      node("div", { class: "compare-snapshots" }, snapshotPanel(a.run, "A · 基线配置快照"), snapshotPanel(b.run, "B · 候选配置快照")));
  } catch (error) {
    if (request === state.comparison) $("compare-detail").replaceChildren(empty("暂时无法完成对比", error.message));
  } finally {
    if (request === state.comparison) $("compare-button").disabled = state.runs.length < 2;
  }
}

$("overview-tab").addEventListener("click", () => setView("overview"));
$("compare-tab").addEventListener("click", () => setView("compare"));
$("experiments-tab")?.addEventListener("click", () => setView("experiments"));
$("refresh").addEventListener("click", loadRuns);
$("kind").addEventListener("change", () => { state.kind = $("kind").value; state.selected = null; loadRuns(); });
$("compare-button").addEventListener("click", compare);
$("baseline").addEventListener("change", resetComparison);
$("candidate").addEventListener("change", resetComparison);
loadRuns();
