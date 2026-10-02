"use strict";

const $ = id => document.getElementById(id);
const state = { runs: [], selected: null, details: new Map(), view: "overview", kind: "model", request: 0 };
const statusNames = { passed: "通过", failed: "失败", skipped: "跳过", running: "运行中", completed: "已完成", pending: "未执行" };
const categoryNames = { business: "业务正确性", safety: "身份安全", evidence: "证据引用", execution: "执行完整性" };
const number = value => value === null || value === undefined ? "未采集" : new Intl.NumberFormat("zh-CN").format(value);
const duration = value => value === null || value === undefined ? "未采集" : `${(value / 1000).toFixed(2)} s`;
const money = value => value === null || value === undefined ? "未采集" : `$${value.toFixed(5)}`;
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
const empty = (title, copy, command) => node("div", { class: "empty-state" }, text("h2", title), text("p", copy), command ? text("code", command) : null);
const json = value => text("pre", JSON.stringify(value, null, 2));
const metricValue = (run, key) => run.metrics?.[key] ?? null;
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

function setView(view) {
  state.view = view;
  $("overview").hidden = view !== "overview";
  $("comparison").hidden = view !== "compare";
  for (const [id, active] of [["overview-tab", view === "overview"], ["compare-tab", view === "compare"]]) {
    $(id).classList.toggle("active", active);
    if (active) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
}

function renderRunList() {
  $("run-list").replaceChildren(...state.runs.map(run => node("button", {
    type: "button", class: `run-button${run.id === state.selected ? " selected" : ""}`,
    "aria-pressed": String(run.id === state.selected), onclick: () => selectRun(run.id),
  }, node("div", { class: "run-row" }, text("span", run.label || run.suiteName, "run-title"), badge(run.status)),
  text("p", date(run.startedAt), "run-date"),
  node("div", { class: "run-row" }, text("p", run.snapshot.model.id, "run-model"), text("span", score(run), "run-score")),
  text("p", `${short(run.snapshot.gitCommit)}${run.snapshot.gitDirty ? " · 含未提交变更" : ""}`, "run-model"))));
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
  $("compare-button").disabled = state.runs.length < 2;
  $("compare-detail").replaceChildren(empty("选择两次运行，查看逐例变化", state.runs.length < 2 ? "至少完成两次相同场景的评测，才能比较结果。" : "先核对数据和检查规则，再查看场景结果与回答差异。"));
}

async function loadRuns() {
  const request = ++state.request;
  $("refresh").disabled = true;
  notice("正在读取评测记录…");
  state.details.clear();
  try {
    const result = await api(`/api/runs?kind=${state.kind}&limit=50`);
    if (request !== state.request) return;
    state.runs = result.runs;
    state.selected = state.runs.some(run => run.id === state.selected) ? state.selected : state.runs[0]?.id ?? null;
    $("record-count").textContent = `${state.kind === "model" ? "真实模型" : "工程检查"} · ${state.runs.length} 次运行`;
    renderRunList();
    renderPickers();
    notice("");
    if (state.selected) await selectRun(state.selected);
    else $("run-detail").replaceChildren(empty("第一份评测，从一次真实运行开始", state.kind === "model" ? "运行现有模型评测，结果会写入同一个 MySQL。完成后刷新本页。" : "工程检查和真实模型的结果分开展示，不混合计算通过率。", state.kind === "model" ? "npm run check:model" : "npm run check:eval-db"));
  } catch (error) {
    if (request !== state.request) return;
    notice(error.message, true);
    $("run-detail").replaceChildren(empty("暂时无法读取评测", "检查数据库与本机服务后，点击“刷新记录”重试。"));
  } finally {
    if (request === state.request) $("refresh").disabled = false;
  }
}

async function selectRun(id) {
  const request = state.request;
  state.selected = id;
  renderRunList();
  $("run-detail").replaceChildren(empty("正在读取运行详情", "包含逐场景结果、工具证据和配置快照。"));
  try {
    const result = await detail(id);
    if (state.selected !== id || request !== state.request) return;
    renderDetail(result);
  } catch (error) {
    if (state.selected === id && request === state.request) {
      $("run-detail").replaceChildren(empty("这次运行暂时无法打开", error.message));
      notice(error.message, true);
    }
  }
}

function metric(label, value, note) {
  return node("div", { class: "metric" }, text("p", label, "metric-label"), text("p", value, "metric-value"), text("p", note, "metric-note"));
}

function metricsPanel(run, cases) {
  const m = run.metrics;
  const doneCases = m ? m.casesPassed + m.casesFailed + m.casesSkipped : cases.length;
  const doneTurns = m ? m.turnsPassed + m.turnsFailed + m.turnsSkipped : cases.reduce((n, item) => n + item.turns.length, 0);
  const durationSamples = cases.flatMap(item => item.turns).filter(turn => turn.durationMs !== null).length;
  const passed = m ? `${m.casesPassed} / ${run.plannedCases}` : `— / ${run.plannedCases}`;
  const pending = Math.max(0, run.plannedCases - doneCases);
  const caseNote = m ? `失败 ${m.casesFailed} · 跳过 ${m.casesSkipped} · 未执行 ${pending}` : `计划 ${run.plannedCases} 个场景，汇总尚未完成`;
  const partialUsage = m && m.usageRequests < m.modelRequests;
  const coverage = m ? `用量覆盖 ${m.usageRequests} / ${m.modelRequests} 次模型请求${partialUsage ? " · 仅统计已报告部分" : ""}` : "用量尚未汇总";
  const panel = node("section", { class: "panel", "aria-label": "运行指标" },
    node("div", { class: "panel-heading" }, text("h3", "本次结果"), text("p", `${run.plannedCases} 个场景 · ${run.plannedTurns} 次用户提问`)),
    node("div", { class: "metric-strip" },
      metric("场景通过 / 计划总数", passed, caseNote),
      metric("单轮耗时 P50 / P95", `${duration(m?.durationP50Ms)} / ${duration(m?.durationP95Ms)}`, `耗时样本 ${durationSamples} · 已记录 ${doneTurns} / ${run.plannedTurns} 轮`),
      metric(partialUsage ? "已报告 Tokens · 部分" : "累计 Tokens", number(m?.totalTokens), coverage),
      metric(partialUsage ? "SDK 估算费用 · 部分 USD" : "SDK 估算费用 · USD", money(m?.estimatedCostUsd), "按已报告用量和目录单价估算，非账单金额")),
    node("div", { class: "metrics-foot" },
      text("span", m ? `用户轮次通过 ${m.turnsPassed} / ${run.plannedTurns} · 失败 ${m.turnsFailed} · 跳过 ${m.turnsSkipped} · 未执行 ${Math.max(0, run.plannedTurns - doneTurns)}` : "用户轮次结果尚未汇总"),
      text("span", `模型请求 ${number(m?.modelRequests)} · 工具调用 ${number(m?.toolCalls)}`),
      text("span", `预期身份拒绝 ${number(m?.expectedDenials)} · 非预期工具错误 ${number(m?.toolErrors)}`),
      text("span", `输入 ${number(m?.inputTokens)} · 输出 ${number(m?.outputTokens)} · 缓存读 ${number(m?.cacheReadTokens)} / 写 ${number(m?.cacheWriteTokens)}`)));
  const checks = cases.flatMap(checksOf);
  if (checks.length) panel.insertBefore(node("div", { class: "category-summary" }, ...Object.entries(categoryNames).map(([key, label]) => {
    const group = checks.filter(check => check.category === key);
    return node("span", { class: "category-chip" }, label, text("strong", `${group.filter(check => check.status === "passed").length} / ${group.length}`));
  })), panel.lastChild);
  return panel;
}

function stepNode(step) {
  const status = step.isError ? step.expectedDenial ? badge("passed", "预期身份拒绝") : badge("failed", "执行错误") : badge("passed", "已完成");
  return node("div", { class: "step" },
    node("div", { class: "step-top" }, text("span", `#${step.index} ${step.type === "model" ? "模型" : "工具"}`, "step-index"), text("span", step.name, "step-name"), status, text("span", `${step.type === "model" ? "响应流 " : ""}${duration(step.durationMs)}`, "step-timing")),
    step.type === "model" ? text("p", "步骤耗时从模型消息开始事件计起，表示响应流阶段，不包含请求等待；单轮总耗时包含等待。", "metric-note") : null,
    step.input !== undefined ? node("div", {}, text("p", step.type === "tool" ? "调用参数" : "请求摘要", "step-label"), json(step.input)) : null,
    step.output !== undefined ? node("div", {}, text("p", step.type === "tool" ? "返回证据" : "模型响应", "step-label"), json(step.output)) : null,
    step.type === "model" ? text("p", step.usage ? `输入 ${number(step.usage.input)} · 输出 ${number(step.usage.output)} · 缓存读 ${number(step.usage.cacheRead)} / 写 ${number(step.usage.cacheWrite)} · 估算 ${money(step.usage.estimatedCostUsd)}` : "此请求未提供用量数据", "step-usage") : null);
}

function checksNode(checks, onlyFailures = false) {
  const items = onlyFailures ? checks.filter(check => check.status !== "passed") : checks;
  if (!items.length) return onlyFailures ? text("p", "没有失败或跳过的断言", "metric-note") : null;
  return node("ul", { class: "check-list", "aria-label": "检查结果" }, ...items.map(check => node("li", {}, badge(check.status), text("span", check.name), check.reason ? text("span", check.reason, "check-reason") : null)));
}

function turnNode(turn, compact = false) {
  const element = node("div", { class: "turn" },
    node("div", { class: "turn-top" }, text("h4", `用户轮次 ${turn.index}`), badge(turn.status), text("span", `${duration(turn.durationMs)} · 首个文本 ${duration(turn.firstTextMs)}`, "turn-timing")),
    node("div", { class: "dialogue" }, text("span", "用户", "speaker"), text("p", turn.question, "bubble"), text("span", "Agent", "speaker"), text("p", turn.reply || "此轮没有回复", "bubble answer")),
    turn.evidenceIds.length ? node("div", { class: "evidence-line" }, text("span", "实际工具证据"), ...turn.evidenceIds.map(id => text("code", id, "evidence-tag"))) : text("p", "本轮没有返回工具证据", "metric-note"),
    turn.error ? text("p", turn.error, "turn-error") : null,
    checksNode(turn.checks, compact));
  if (!compact) element.append(node("details", { class: "trace" }, node("summary", {}, `模型与工具轨迹 · ${turn.steps.length} 个步骤`), text("p", "首个文本统计模型首次文字输出，可能来自最终答复前的模型轮次。", "metric-note"), ...turn.steps.map(stepNode)));
  return element;
}

function caseNode(item) {
  const details = node("details", { class: "case" }, node("summary", {}, text("span", item.name, "case-name"), text("span", `${item.turns.length} 轮`, "case-meta"), badge(item.status)), node("div", { class: "case-body" }, ...item.turns.map(turn => turnNode(turn))));
  if (isFailed(item)) details.open = true;
  return details;
}

function snapshotPanel(run, heading = "配置与评测快照") {
  const s = run.snapshot;
  const fields = [
    ["代码版本", `${short(s.gitCommit)}${s.gitDirty ? " · 含未提交变更" : " · 工作区干净"}`],
    ["模型", `${s.model.provider} / ${s.model.id}`],
    ["生成配置", `maxTokens ${s.model.maxTokens} · thinking ${s.model.thinking} · temperature ${s.model.temperature ?? "提供方默认"}`],
    ["业务数据时间", date(s.asOf)],
    ...Object.entries(s.hashes).map(([key, hash]) => [({ prompt: "Prompt", skill: "Skill", tools: "工具定义", dataset: "评测集", checker: "检查规则", business: "业务数据" })[key] || key, short(hash)]),
  ];
  return node("section", { class: "panel" }, node("details", { class: "snapshot" }, node("summary", {}, heading),
    node("dl", { class: "snapshot-grid" }, ...fields.flatMap(([label, value]) => [text("dt", label), text("dd", value, "mono")])),
    node("details", {}, node("summary", { class: "metric-note" }, "查看完整快照 JSON"), json(s))));
}

function renderDetail(result) {
  const { run, cases } = result;
  const list = node("div", { class: "case-list" });
  const all = node("button", { class: "filter-button active", type: "button" }, "全部场景");
  const failed = node("button", { class: "filter-button", type: "button" }, `失败 ${cases.filter(isFailed).length}`);
  const renderCases = onlyFailed => {
    all.classList.toggle("active", !onlyFailed);
    failed.classList.toggle("active", onlyFailed);
    const filtered = onlyFailed ? cases.filter(isFailed) : cases;
    list.replaceChildren(...filtered.map(caseNode));
    if (!filtered.length) list.append(text("p", onlyFailed ? "本次运行没有失败场景。" : "场景结果尚未写入。运行结束后刷新记录。", "sidebar-empty"));
  };
  all.addEventListener("click", () => renderCases(false));
  failed.addEventListener("click", () => renderCases(true));
  renderCases(false);
  $("run-detail").replaceChildren(
    node("div", { class: "run-heading" }, node("div", {}, text("h2", run.label || run.suiteName), text("p", `${run.suiteName} · ${date(run.startedAt)}${run.finishedAt ? ` — ${date(run.finishedAt)}` : ""}`), text("p", run.id, "subtle-id")), badge(run.status)),
    run.error ? text("p", run.error, "error-note") : null,
    metricsPanel(run, cases),
    node("section", { class: "panel" }, node("div", { class: "panel-heading" }, text("h3", "逐场景验收"), node("div", { class: "case-toolbar" }, all, failed)), list),
    snapshotPanel(run));
}

function compatibility(a, b) {
  const requirements = [["场景套件", a.suiteId === b.suiteId], ["评测类型", a.kind === b.kind], ["评测集", a.snapshot.hashes.dataset === b.snapshot.hashes.dataset], ["检查规则", a.snapshot.hashes.checker === b.snapshot.hashes.checker], ["业务数据", a.snapshot.hashes.business === b.snapshot.hashes.business]];
  const changed = [["Prompt", "prompt"], ["Skill", "skill"], ["工具", "tools"]].filter(([, key]) => a.snapshot.hashes[key] !== b.snapshot.hashes[key]).map(([label]) => label);
  if (JSON.stringify(a.snapshot.model) !== JSON.stringify(b.snapshot.model)) changed.push("模型或生成配置");
  if (a.snapshot.gitCommit !== b.snapshot.gitCommit) changed.push("代码版本");
  const aSource = a.snapshot.content?.implementation?.hash;
  const bSource = b.snapshot.content?.implementation?.hash;
  if (aSource && bSource && aSource !== bSource) changed.push("Agent 实现");
  const compatible = requirements.every(([, matches]) => matches);
  return node("div", { class: `compatibility${compatible ? "" : " warning"}` },
    text("h3", compatible ? changed.length ? "评测条件一致，可以观察版本变化" : "同一配置的重复运行" : "评测条件存在差异，不能直接归因于版本调整"),
    text("p", compatible ? changed.length ? `变化项：${changed.join("、")}。同场景得分与回复差异仍需逐例判断。` : "Prompt、Skill、工具和模型配置一致；结果差异可能来自模型生成波动。" : `不一致：${requirements.filter(([, matches]) => !matches).map(([label]) => label).join("、")}。请先核对快照。`),
    a.status !== "completed" || b.status !== "completed" ? text("p", "包含未完整完成的运行，未执行场景仍计入计划总数。") : null,
    a.snapshot.gitDirty || b.snapshot.gitDirty ? text("p", "存在未提交的代码；仅凭 Git 版本号不能确认两次源码内容一致。") : null,
    aSource && bSource ? text("p", `Agent 实现快照${aSource === bSource ? "一致" : "不同"} · ${short(aSource)} / ${short(bSource)}`) : null,
    node("div", { class: "condition-tags" }, ...requirements.map(([label, matches]) => text("span", `${label} ${matches ? "一致" : "不同"}`, "condition-tag"))));
}

function deltaMetric(label, a, b, formatter, lowerBetter = false, note = "", deltaFormatter = formatter) {
  const known = a !== null && b !== null;
  const delta = known ? b - a : null;
  const className = known && delta !== 0 ? (lowerBetter ? delta < 0 : delta > 0) ? " good" : " bad" : "";
  const diff = !known ? "缺少完整数据，无法计算变化" : delta === 0 ? "没有变化" : `${delta > 0 ? "+" : "−"}${deltaFormatter(Math.abs(delta))}`;
  return node("div", { class: "delta-metric" }, text("p", label, "metric-label"), node("div", { class: "delta-values" }, text("span", formatter(a)), text("span", "→", "arrow"), text("span", formatter(b))), text("p", `${diff}${note ? ` · ${note}` : ""}`, `delta-note${className}`));
}

function compareRows(a, b) {
  const rows = new Map(a.cases.map(item => [item.id, { id: item.id, a: item, b: null }]));
  for (const item of b.cases) {
    if (rows.has(item.id)) rows.get(item.id).b = item;
    else rows.set(item.id, { id: item.id, a: null, b: item });
  }
  return [...rows.values()];
}

function change(row) {
  if (!row.a || !row.b) return { label: "缺少成对结果", className: "" };
  if (row.a.status === row.b.status) return { label: "结果一致", className: "" };
  if (row.a.status === "passed" && row.b.status === "failed") return { label: "出现退步", className: "bad", rowClass: "regression" };
  if (row.a.status === "failed" && row.b.status === "passed") return { label: "失败转通过", className: "good", rowClass: "improvement" };
  return { label: "执行状态变化", className: "" };
}

function pairedSide(item, label) {
  if (!item) return node("div", { class: "paired-side" }, text("p", label, "paired-side-heading"), text("p", "该运行没有此场景结果。", "metric-note"));
  return node("div", { class: "paired-side" }, node("div", { class: "paired-side-heading" }, text("span", label), badge(item.status)), ...item.turns.map(turn => turnNode(turn, true)));
}

async function compare() {
  const aId = $("baseline").value;
  const bId = $("candidate").value;
  if (!aId || !bId || aId === bId) {
    $("compare-detail").replaceChildren(empty("请选择两次不同的运行", "基线 A 与候选 B 应来自两次独立评测。"));
    return;
  }
  $("compare-button").disabled = true;
  $("compare-detail").replaceChildren(empty("正在对齐场景与快照", "使用固定场景 ID 对齐，保留两侧原始回答。"));
  try {
    const [a, b] = await Promise.all([detail(aId), detail(bId)]);
    if ($("baseline").value !== aId || $("candidate").value !== bId) return;
    const rows = compareRows(a, b);
    const body = node("tbody", {}, ...rows.map(row => {
      const diff = change(row);
      return node("tr", { class: diff.rowClass || "" }, node("td", {}, text("span", row.b?.name || row.a.name), text("p", row.id, "case-key")), node("td", {}, badge(row.a?.status || "pending")), node("td", {}, badge(row.b?.status || "pending")), node("td", {}, text("span", diff.label, `change-tag ${diff.className}`)));
    }));
    const caseRate = run => run.metrics && run.plannedCases ? run.metrics.casesPassed / run.plannedCases * 100 : null;
    const percent = value => value === null ? "未采集" : `${value.toFixed(1)}%`;
    const pairedList = node("div", {});
    const all = node("button", { type: "button", class: "filter-button active" }, "全部场景");
    const changed = node("button", { type: "button", class: "filter-button" }, "只看状态变化");
    const renderPairs = onlyChanges => {
      all.classList.toggle("active", !onlyChanges);
      changed.classList.toggle("active", onlyChanges);
      const selected = onlyChanges ? rows.filter(row => !row.a || !row.b || row.a.status !== row.b.status) : rows;
      pairedList.replaceChildren(...selected.map(row => node("div", { class: "paired-case" }, node("div", { class: "paired-heading" }, text("span", row.b?.name || row.a.name), text("span", change(row).label, `change-tag ${change(row).className}`)), node("div", { class: "paired-columns" }, pairedSide(row.a, "A · 基线"), pairedSide(row.b, "B · 候选")))));
      if (!selected.length) pairedList.append(text("p", "两次运行的场景状态一致；可切换全部场景，继续核对回复内容。", "sidebar-empty"));
    };
    all.addEventListener("click", () => renderPairs(false));
    changed.addEventListener("click", () => renderPairs(true));
    renderPairs(false);
    const completeUsageMetric = (run, key) => run.metrics && run.metrics.usageRequests === run.metrics.modelRequests ? metricValue(run, key) : null;
    $("compare-detail").replaceChildren(compatibility(a.run, b.run),
      node("div", { class: "comparison-grid" },
        deltaMetric("场景通过率 · 含全部计划场景", caseRate(a.run), caseRate(b.run), percent, false, "", value => `${value.toFixed(1)} 个百分点`),
        deltaMetric("单轮耗时 P95", metricValue(a.run, "durationP95Ms"), metricValue(b.run, "durationP95Ms"), duration, true),
        deltaMetric("累计 Tokens · 完整用量", completeUsageMetric(a.run, "totalTokens"), completeUsageMetric(b.run, "totalTokens"), number, true),
        deltaMetric("SDK 估算费用 · 完整用量 USD", completeUsageMetric(a.run, "estimatedCostUsd"), completeUsageMetric(b.run, "estimatedCostUsd"), money, true)),
      node("section", { class: "panel" }, node("div", { class: "panel-heading" }, text("h3", "场景差异矩阵"), text("p", `${rows.filter(row => row.a && row.b).length} / ${rows.length} 个场景有成对结果`)), node("div", { class: "matrix-wrap" }, node("table", { class: "matrix" }, node("thead", {}, node("tr", {}, ...["固定场景", `A · ${a.run.label || "基线"}`, `B · ${b.run.label || "候选"}`, "变化"].map(label => node("th", { scope: "col" }, label)))), body))),
      node("section", { class: "panel" }, node("div", { class: "panel-heading" }, text("h3", "成对回复与失败断言"), node("div", { class: "case-toolbar" }, all, changed)), pairedList),
      node("div", { class: "compare-snapshots" }, snapshotPanel(a.run, "A · 基线配置快照"), snapshotPanel(b.run, "B · 候选配置快照")));
  } catch (error) {
    $("compare-detail").replaceChildren(empty("暂时无法完成对比", error.message));
  } finally {
    $("compare-button").disabled = state.runs.length < 2;
  }
}

$("overview-tab").addEventListener("click", () => setView("overview"));
$("compare-tab").addEventListener("click", () => setView("compare"));
$("refresh").addEventListener("click", loadRuns);
$("kind").addEventListener("change", () => { state.kind = $("kind").value; state.selected = null; loadRuns(); });
$("compare-button").addEventListener("click", compare);
loadRuns();
