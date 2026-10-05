"use strict";

// 实验调试 tab：复用 app.js 的全局 helper（node/text/api/$/setView/selectRun/compare 等，同页经典脚本共享全局词法作用域）。
// 接口以 docs/experiment-controls.md 为准；catalog/jobs 在第一次打开 tab 时才 GET，POST 仅来自用户显式提交并带 X-Experiment-Request。

const expState = {
  loaded: false, catalog: null, presetId: null, draft: null,
  jobs: [], selected: null, job: null,
  loadEpoch: 0, jobsEpoch: 0, pollEpoch: 0, pollTimer: 0, pollMs: 2000,
  jobsLoading: false, submitting: false, formError: "", jobsError: "",
  formSlot: null, sideSlot: null, diffSlot: null, remoteSlot: null, actionsSlot: null,
};
const expKindNames = { support: "业务架构", retrieval: "检索实验" };
const expJobStatus = { running: "运行中", completed: "已完成", completed_with_failures: "部分失败", failed: "失败", interrupted: "已中断" };
const expJobTone = { running: "running", completed: "passed", completed_with_failures: "mixed", failed: "failed", interrupted: "skipped" };
const expSuiteNames = { standard: "常规", hard: "难题", no_answer: "无答案", scope: "范围", context: "上下文" };
const expCopy = value => JSON.parse(JSON.stringify(value));
const expFmt = value => value === undefined || value === null ? "缺省" : String(value);
// 远程需求镜像后端 remoteRequired：业务实验或检索含 M2–M6 必须显式授权。
const expRemoteNeeded = config => config.kind === "support"
  || config.variants.some(variant => (variant.modes || []).some(mode => mode !== "M0" && mode !== "M1"));

// tab 切换钩子：app.js setView 调用。离开即停轮询；切回刷新任务并恢复运行跟踪。
function experimentViewChanged(view) {
  if (view !== "experiments") { stopExpPoll(); return; }
  if (!expState.loaded) loadExperimentData();
  else { refreshJobs(); resumeExpPoll(); }
}

async function loadExperimentData() {
  const epoch = ++expState.loadEpoch;
  expState.jobsError = "";
  renderExperiments();
  try {
    const [catalog, jobs] = await Promise.all([api("/api/experiments/catalog"), api("/api/experiments")]);
    if (epoch !== expState.loadEpoch) return;
    expState.catalog = catalog;
    expState.jobs = jobs.jobs || [];
    expState.loaded = true;
    if (!expState.draft && catalog.presets?.length) applyPreset(catalog.presets[0].id);
    renderExperiments();
    resumeExpPoll();
  } catch (error) {
    if (epoch !== expState.loadEpoch) return;
    expState.jobsError = error.message;
    renderExperiments();
  }
}

async function refreshJobs() {
  if (expState.jobsLoading) return;
  expState.jobsLoading = true;
  const epoch = ++expState.jobsEpoch;
  try {
    const result = await api("/api/experiments");
    // 列表是旧快照：只更新列表本身，绝不覆盖当前详情；详情仅由 selectJob / 轮询响应更新。
    if (epoch !== expState.jobsEpoch) return;
    expState.jobs = result.jobs || [];
    expState.jobsError = "";
  } catch (error) {
    if (epoch !== expState.jobsEpoch) return;
    expState.jobsError = error.message;
  } finally {
    // 解锁与重绘放在 finally：按钮在响应（含旧响应被丢弃）后必定恢复可点。
    expState.jobsLoading = false;
    renderSide();
  }
}

// 任务详情：force 用于错误后的重试；旧响应（切任务或停轮询后晚到）一律丢弃。
async function selectJob(id, force = false) {
  if (!force && expState.selected === id) return;
  expState.selected = id;
  expState.job = expState.jobs.find(job => job.id === id) || null;
  stopExpPoll();
  renderSide();
  const epoch = ++expState.pollEpoch;
  try {
    const job = await api(`/api/experiments/${encodeURIComponent(id)}`);
    if (epoch !== expState.pollEpoch || expState.selected !== id) return;
    expState.job = job;
    renderSide();
    resumeExpPoll();
  } catch (error) {
    if (epoch !== expState.pollEpoch || expState.selected !== id) return;
    expState.jobsError = error.message;
    renderSide();
  }
}

function stopExpPoll() {
  expState.pollEpoch++;
  if (expState.pollTimer) { clearTimeout(expState.pollTimer); expState.pollTimer = 0; }
}

// 运行中的任务每 2 秒轮询一次；tab 不在前台、任务到达终态或选中了别的任务即停止。
function resumeExpPoll() {
  stopExpPoll();
  const job = expState.job;
  if (!job || job.status !== "running" || state.view !== "experiments") return;
  const epoch = expState.pollEpoch;
  const tick = async () => {
    if (epoch !== expState.pollEpoch || state.view !== "experiments") return;
    try {
      const fresh = await api(`/api/experiments/${encodeURIComponent(job.id)}`);
      if (epoch !== expState.pollEpoch || expState.selected !== job.id) return;
      expState.job = fresh;
      const listed = expState.jobs.find(item => item.id === fresh.id);
      if (listed) Object.assign(listed, fresh);
      expState.jobsError = "";
      renderSide();
      if (fresh.status === "running") expState.pollTimer = setTimeout(tick, expState.pollMs);
    } catch (error) {
      if (epoch !== expState.pollEpoch) return;
      expState.jobsError = `${error.message}（轮询已暂停，可重试）`;
      renderSide();
    }
  };
  expState.pollTimer = setTimeout(tick, expState.pollMs);
}

function applyPreset(id) {
  const preset = expState.catalog?.presets.find(item => item.id === id);
  if (!preset) return;
  expState.presetId = id;
  expState.draft = expCopy(preset.config);
  expState.formError = "";
}

// v2 组合校验：score 仅 M4/M5/M6 且阈值必须显式填写；非法组合只提示禁提交，不偷偷改模式或丢字段。
function expComboError(config) {
  if (config.kind !== "retrieval" || config.version !== 2) return "";
  for (const variant of config.variants) {
    if (!variant.dataset) return `方案 ${variant.id} 请选择数据集。`;
    const acceptance = variant.acceptance;
    if (!acceptance || (acceptance.mode !== "off" && acceptance.mode !== "score")) return `方案 ${variant.id} 的接收策略无效。`;
    if (acceptance.mode === "score") {
      if (!variant.modes.length || variant.modes.some(mode => !["M4", "M5", "M6"].includes(mode)))
        return `方案 ${variant.id}：分数接收仅支持 M4/M5/M6，请调整模式或改用关闭策略。`;
      if (typeof acceptance.threshold !== "number" || !Number.isFinite(acceptance.threshold) || acceptance.threshold < 0 || acceptance.threshold > 1)
        return `方案 ${variant.id}：请显式填写 0–1 的接收阈值。`;
    }
  }
  return "";
}

// 提交前的前端镜像校验；最终判定仍以后端 resolveExperimentConfig 为准。
function validateDraft(config) {
  if (!config.label || !config.label.trim() || config.label.trim().length > 80) return "请填写 80 字以内的实验名称。";
  if (!Number.isInteger(config.repeat) || config.repeat < 1 || config.repeat > 3) return "重复次数应为 1–3 的整数。";
  if (!config.variants.length || config.variants.length > 2) return "请保留 1–2 个方案。";
  for (const variant of config.variants) {
    if (config.kind === "support" && variant.architecture === "controller" && variant.parameters?.merchantEvents === "model")
      return "Controller 不支持“经过模型”的商家通知。";
    if (config.kind === "retrieval" && !variant.modes?.length) return `方案 ${variant.id} 至少选择一个模式。`;
  }
  const combo = expComboError(config);
  if (combo) return combo;
  if (expRemoteNeeded(config) && !config.allowRemote) return "该实验调用付费模型，请先勾选允许本次远程模型调用。";
  return "";
}

async function submitExperiment() {
  const draft = expState.draft;
  if (!draft || expState.submitting) return;
  const error = validateDraft(draft);
  if (error) { expState.formError = error; renderExperiments(); return; }
  expState.submitting = true;
  expState.formError = "";
  renderExperiments();
  try {
    const response = await fetch("/api/experiments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Experiment-Request": "1" },
      body: JSON.stringify({ ...draft, label: draft.label.trim() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `提交失败（HTTP ${response.status}），请调整后重试。`);
    expState.selected = result.id;
    expState.job = result;
    if (!expState.jobs.some(job => job.id === result.id)) expState.jobs.unshift(result);
    resumeExpPoll();
  } catch (submitError) {
    expState.formError = submitError.message;
  } finally {
    expState.submitting = false;
    renderExperiments();
  }
}

function downloadExpConfig() {
  if (!expState.draft) return;
  const blob = new Blob([JSON.stringify(expState.draft, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  node("a", { href: url, download: "experiment-config.json" }).click();
  URL.revokeObjectURL(url);
}

// 整页重建仅限初始加载与用户主动操作（切预设/改架构/复制方案/提交等）；
// 轮询与列表刷新只走 renderSide，避免重建表单导致输入中值、焦点和高级参数展开态丢失。
function renderExperiments() {
  const root = $("experiments");
  if (!root) return;
  if (!expState.loaded) {
    expState.formSlot = null;
    expState.sideSlot = null;
    root.replaceChildren(expState.jobsError
      ? node("div", { class: "empty-state" }, text("h2", "暂时无法读取实验目录"), text("p", expState.jobsError),
        node("button", { class: "quiet-button", type: "button", onclick: () => loadExperimentData() }, "重试"))
      : empty("正在读取实验目录…", ""));
    return;
  }
  const formSlot = node("div", { class: "exp-form-slot" });
  const sideSlot = node("div", { class: "exp-side" });
  root.replaceChildren(node("div", { class: "exp-layout" }, formSlot, sideSlot));
  expState.formSlot = formSlot;
  expState.sideSlot = sideSlot;
  renderForm();
  renderSide();
}

function renderForm() {
  if (!expState.formSlot) return;
  expState.diffSlot = null;
  expState.remoteSlot = null;
  expState.actionsSlot = null;
  expState.formSlot.replaceChildren(expFormPanel());
}

// 调参不重建表单：差异、远程提示与提交门控各自有稳定槽位，参数 change 只局部刷新，
// 保留高级参数展开态、当前输入节点与焦点；切预设/改架构/复制方案仍走 renderExperiments 整建。
function renderExpDiff() {
  if (expState.diffSlot && expState.draft) expState.diffSlot.replaceChildren(...expDiffChildren(expState.draft));
}
function renderExpRemote() {
  if (expState.remoteSlot && expState.draft) expState.remoteSlot.replaceChildren(...expRemoteChildren(expState.draft));
}
function renderExpActions() {
  if (expState.actionsSlot && expState.draft) expState.actionsSlot.replaceChildren(...expActionsChildren(expState.draft));
}

function renderSide() {
  if (!expState.sideSlot) return;
  expState.sideSlot.replaceChildren(expJobsPanel(), expJobPanel());
}

const expLabeled = (label, control) => node("label", { class: "exp-field" }, text("span", label, "exp-field-label"), control);

function expFormPanel() {
  const catalog = expState.catalog;
  const draft = expState.draft;
  if (!catalog || !draft) return node("section", { class: "panel" }, text("p", "实验目录不可用，请重试。", "batch-note"));
  const diffSlot = node("div", { class: "exp-diff-slot" });
  const remoteSlot = node("div", { class: "exp-remote-slot" });
  const actionsSlot = node("div", { class: "exp-actions" });
  expState.diffSlot = diffSlot;
  expState.remoteSlot = remoteSlot;
  expState.actionsSlot = actionsSlot;
  diffSlot.replaceChildren(...expDiffChildren(draft));
  remoteSlot.replaceChildren(...expRemoteChildren(draft));
  actionsSlot.replaceChildren(...expActionsChildren(draft));
  return node("section", { class: "panel exp-form", "aria-label": "实验配置" },
    node("div", { class: "panel-heading" }, text("h3", "实验配置"), text("p", "仅本次评测生效")),
    node("div", { class: "exp-form-body" },
      node("div", { class: "exp-fields" },
        expLabeled("方案预设", expPresetSelect(catalog)),
        expLabeled("实验名称", expLabelInput(draft)),
        expLabeled("重复次数", expRepeatInput(draft))),
      text("p", `${expKindNames[draft.kind] || draft.kind} · 类型由预设确定`, "metric-note"),
      node("div", { class: "exp-variants" }, ...draft.variants.map((variant, index) => expVariantCard(draft, variant, index))),
      draft.variants.length === 1
        ? node("button", { class: "quiet-button", type: "button", "data-action": "copy-b", onclick: () => { const b = expCopy(draft.variants[0]); b.id = "B"; draft.variants.push(b); renderExperiments(); } }, "复制 A 成 B 对照")
        : null,
      diffSlot,
      remoteSlot,
      actionsSlot,
      expState.formError ? text("p", expState.formError, "turn-error") : null,
      catalog.notes?.length ? node("details", { class: "conditions" }, node("summary", {}, "实验说明"),
        ...catalog.notes.map(item => text("p", item, "metric-note"))) : null));
}

function expPresetSelect(catalog) {
  const el = node("select", { "data-field": "preset" });
  // “自定义配置”占位：载入历史配置后显示当前不来自任何预设；选中它不触发重置。
  el.append(node("option", { value: "" }, "自定义配置（载入的历史配置）"),
    ...catalog.presets.map(preset => node("option", { value: preset.id }, preset.name)));
  el.value = expState.presetId || "";
  el.addEventListener("change", () => { if (!el.value) return; applyPreset(el.value); renderExperiments(); });
  return el;
}

function expLabelInput(draft) {
  const el = node("input", { type: "text", maxlength: "80", "data-field": "exp-label", placeholder: "80 字以内" });
  el.value = draft.label;
  el.addEventListener("input", () => { draft.label = el.value; });
  return el;
}

function expRepeatInput(draft) {
  const el = node("input", { type: "number", min: "1", max: "3", step: "1", "data-field": "repeat" });
  el.value = String(draft.repeat);
  el.addEventListener("change", () => {
    const value = Number(el.value);
    if (Number.isInteger(value) && value >= 1 && value <= 3) draft.repeat = value;
    else el.value = String(draft.repeat);
    renderExpRemote();
  });
  return el;
}

function expVariantCard(draft, variant, index) {
  const children = [node("div", { class: "exp-variant-head" },
    text("h4", `方案 ${variant.id}`),
    index === 1 ? node("button", { class: "quiet-button", type: "button", "data-action": "delete-b", onclick: () => { draft.variants.splice(1, 1); renderExperiments(); } }, "删除 B") : null)];
  if (draft.kind === "support") children.push(expLabeled("架构", expArchSelect(variant)));
  else children.push(node("div", { class: "exp-field" }, text("span", "模式（多选）", "exp-field-label"),
    node("div", { class: "exp-modes" }, ...(expState.catalog.modes || []).map(mode => expModeChip(variant, mode)))));
  if (draft.kind === "retrieval" && draft.version === 2) children.push(...expV2Fields(variant));
  children.push(expAdvancedNode(draft, variant));
  return node("div", { class: "exp-variant", "data-variant-card": variant.id }, ...children);
}

// version 2 检索方案的 datasets/acceptance 字段：独立于 parameters，编辑只写 draft 并局部刷新差异与门控，不重建卡片。
function expV2Fields(variant) {
  const catalog = expState.catalog;
  const acceptance = variant.acceptance && typeof variant.acceptance === "object" ? variant.acceptance : (variant.acceptance = { mode: "off" });
  const datasetSelect = node("select", { "data-field": "dataset", "data-variant": variant.id });
  datasetSelect.append(...(catalog.datasets || []).map(item => node("option", { value: item.value }, item.label)));
  datasetSelect.value = variant.dataset || "";
  datasetSelect.addEventListener("change", () => { variant.dataset = datasetSelect.value; renderExpDiff(); renderExpActions(); });
  const modeField = catalog.acceptanceFields?.find(field => field.key === "mode");
  const thresholdField = catalog.acceptanceFields?.find(field => field.key === "threshold");
  const modeSelect = node("select", { "data-field": "acceptance-mode", "data-variant": variant.id });
  modeSelect.append(...(modeField?.options || []).map(option => node("option", { value: option.value }, option.label)));
  modeSelect.value = acceptance.mode;
  const thresholdInput = node("input", { type: "number", min: "0", max: "1", step: "0.01", placeholder: "0–1 显式填写",
    "data-field": "acceptance-threshold", "data-variant": variant.id });
  if (typeof acceptance.threshold === "number") thresholdInput.value = String(acceptance.threshold);
  thresholdInput.disabled = acceptance.mode !== "score";
  modeSelect.addEventListener("change", () => {
    if (modeSelect.value === "score") {
      const value = Number(thresholdInput.value);
      // off 配置不得携带阈值；切到 score 时只采纳用户已输入的合法值，不偷偷补默认。
      variant.acceptance = thresholdInput.value !== "" && Number.isFinite(value) && value >= 0 && value <= 1 ? { mode: "score", threshold: value } : { mode: "score" };
      thresholdInput.disabled = false;
    } else {
      variant.acceptance = { mode: "off" };
      thresholdInput.disabled = true;
    }
    renderExpDiff();
    renderExpActions();
  });
  thresholdInput.addEventListener("change", () => {
    const value = Number(thresholdInput.value);
    if (variant.acceptance?.mode === "score" && thresholdInput.value !== "" && Number.isFinite(value) && value >= 0 && value <= 1)
      variant.acceptance.threshold = value;
    else if (variant.acceptance?.mode === "score") delete variant.acceptance.threshold;
    renderExpDiff();
    renderExpActions();
  });
  return [
    expLabeled("数据集", datasetSelect),
    node("div", { class: "exp-field" }, text("span", modeField?.label || "证据接收策略", "exp-field-label"), modeSelect,
      modeField?.note ? text("small", modeField.note, "exp-note") : null),
    node("div", { class: "exp-field" }, text("span", thresholdField?.label || "接收分数阈值", "exp-field-label"), thresholdInput,
      thresholdField?.note ? text("small", thresholdField.note, "exp-note") : null),
  ];
}

function expArchSelect(variant) {
  const el = node("select", { "data-field": "architecture", "data-variant": variant.id });
  el.append(node("option", { value: "atomic" }, "atomic 原子"), node("option", { value: "controller" }, "controller 控制"));
  el.value = variant.architecture;
  el.addEventListener("change", () => {
    variant.architecture = el.value;
    // Controller 不支持 model 通知分支，切到 controller 时回落为跟随架构。
    if (variant.architecture === "controller" && variant.parameters?.merchantEvents === "model") variant.parameters.merchantEvents = "architecture";
    renderExperiments();
  });
  return el;
}

function expModeChip(variant, mode) {
  const input = node("input", { type: "checkbox", "data-mode": mode.value, "data-variant": variant.id });
  input.checked = variant.modes.includes(mode.value);
  const chip = node("label", { class: `exp-mode${variant.modes.includes(mode.value) ? " active" : ""}` }, input, text("span", mode.label));
  input.addEventListener("change", () => {
    const set = new Set(variant.modes);
    if (input.checked) set.add(mode.value); else set.delete(mode.value);
    variant.modes = [...set];
    chip.className = `exp-mode${set.has(mode.value) ? " active" : ""}`;
    renderExpDiff();
    renderExpRemote();
    renderExpActions();
  });
  return chip;
}

// 高级参数默认折叠，按 catalog 字段渲染；切换预设已重置为默认配置。
function expAdvancedNode(draft, variant) {
  const fields = expState.catalog.fields?.[draft.kind] || [];
  return node("details", { class: "metric-details exp-advanced" },
    node("summary", {}, `高级参数 · ${fields.length} 项`),
    node("div", { class: "exp-params" }, ...fields.map(field => expParamRow(draft, variant, field))));
}

function expParamRow(draft, variant, field) {
  const params = variant.parameters || (variant.parameters = {});
  // atomic 没有格式修复环节，修复次数不适用；Controller 隐藏 merchantEvents 的 model 选项。
  const notApplicable = field.key === "repairBudget" && draft.kind === "support" && variant.architecture === "atomic";
  let control;
  if (field.type === "select") {
    control = node("select", { "data-field": field.key, "data-variant": variant.id });
    const options = (field.options || []).filter(option => !(field.key === "merchantEvents" && variant.architecture === "controller" && option.value === "model"));
    control.append(...options.map(option => node("option", { value: option.value }, option.label)));
    control.value = params[field.key] ?? options[0]?.value ?? "";
    control.addEventListener("change", () => { params[field.key] = control.value; renderExpDiff(); renderExpRemote(); });
  } else {
    control = node("input", { type: "number", min: String(field.min), max: String(field.max), step: String(field.step), "data-field": field.key, "data-variant": variant.id });
    if (params[field.key] !== undefined && params[field.key] !== null) control.value = String(params[field.key]);
    control.addEventListener("change", () => {
      const value = Number(control.value);
      if (Number.isFinite(value)) params[field.key] = value;
      else control.value = params[field.key] === undefined ? "" : String(params[field.key]);
      renderExpDiff();
      renderExpRemote();
    });
  }
  if (notApplicable) control.disabled = true;
  return node("label", { class: `exp-param${notApplicable ? " disabled" : ""}` },
    text("span", field.label, "exp-field-label"), control,
    text("small", notApplicable ? "仅 Controller 生效，atomic 不适用" : field.note || "", "exp-note"));
}

// 参数差异：改动的键以 A → B 短标签列出；完整 JSON 折叠诊断。返回槽位子节点，便于局部刷新。
function expDiffChildren(draft) {
  if (draft.variants.length < 2) return [];
  const [a, b] = draft.variants;
  const diffs = [];
  if (draft.kind === "support" && a.architecture !== b.architecture) diffs.push(["架构", `${a.architecture} → ${b.architecture}`]);
  if (draft.kind === "retrieval" && a.modes.join("+") !== b.modes.join("+")) diffs.push(["模式", `${a.modes.join("+")} → ${b.modes.join("+")}`]);
  if (draft.kind === "retrieval" && draft.version === 2) {
    const datasetLabel = value => expState.catalog?.datasets?.find(item => item.value === value)?.label || value || "缺省";
    if (a.dataset !== b.dataset) diffs.push(["数据集", `${datasetLabel(a.dataset)} → ${datasetLabel(b.dataset)}`]);
    const accLabel = variant => variant.acceptance?.mode === "score" ? `score ${expFmt(variant.acceptance.threshold)}` : variant.acceptance?.mode || "缺省";
    if (JSON.stringify(a.acceptance ?? null) !== JSON.stringify(b.acceptance ?? null)) diffs.push(["接收", `${accLabel(a)} → ${accLabel(b)}`]);
  }
  for (const key of [...new Set([...Object.keys(a.parameters || {}), ...Object.keys(b.parameters || {})])]) {
    const va = a.parameters?.[key], vb = b.parameters?.[key];
    if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) diffs.push([key, `${expFmt(va)} → ${expFmt(vb)}`]);
  }
  return [
    diffs.length
      ? node("div", { class: "condition-tags" }, ...diffs.map(([key, value]) => text("span", `${key} ${value}`, "condition-tag different")))
      : text("p", "两个方案参数完全一致。", "metric-note"),
    node("details", { class: "conditions" }, node("summary", {}, "完整参数 JSON"), json({ A: a, B: b })),
  ];
}

function expRemoteChildren(draft) {
  const remoteNeeded = expRemoteNeeded(draft);
  const input = node("input", { type: "checkbox", "data-field": "allow-remote" });
  input.checked = draft.allowRemote;
  input.addEventListener("change", () => { draft.allowRemote = input.checked; renderExpActions(); });
  const notes = [];
  if (remoteNeeded && draft.kind === "retrieval") {
    const limits = [...new Set(draft.variants.map(variant => variant.parameters?.maxRequests).filter(value => typeof value === "number"))];
    notes.push(`每次运行请求上限 ${limits.join(" / ")}；重复 ${draft.repeat} × 方案 ${draft.variants.length} 放大总请求量，重试也计请求。`);
    notes.push("缓存复用不取消远程授权要求。");
  } else if (remoteNeeded) {
    notes.push(`业务实验调用付费模型；重复 ${draft.repeat} × 方案 ${draft.variants.length} 放大总请求量。`);
  } else notes.push("当前方案仅本地模式，不需要远程授权。");
  return [node("div", { class: `exp-remote${remoteNeeded ? " needed" : ""}` },
    node("label", { class: "exp-allow" }, input, text("span", "允许本次远程模型调用")),
    ...notes.map(noteText => text("p", noteText, "exp-note")))];
}

function expActionsChildren(draft) {
  const comboError = expComboError(draft);
  const submitBlocked = Boolean(comboError) || (expRemoteNeeded(draft) && !draft.allowRemote);
  return [
    node("button", { class: "primary-button", type: "button", disabled: expState.submitting || submitBlocked, onclick: () => submitExperiment() },
      expState.submitting ? "正在提交…" : "提交实验"),
    node("button", { class: "quiet-button", type: "button", onclick: () => downloadExpConfig() }, "下载 JSON 配置"),
    comboError ? text("span", comboError, "exp-hint")
      : submitBlocked ? text("span", "该方案调用付费模型，需先勾选允许", "exp-hint") : null,
  ].filter(Boolean);
}

function expJobsPanel() {
  return node("section", { class: "panel", "aria-label": "实验任务" },
    node("div", { class: "panel-heading" }, text("h3", "实验任务"),
      node("button", { class: "quiet-button", type: "button", "data-action": "refresh-jobs", disabled: expState.jobsLoading, onclick: () => refreshJobs() }, "刷新")),
    expState.jobsError ? node("p", { class: "batch-caution" }, expState.jobsError, " ",
      node("button", { class: "quiet-button", type: "button", "data-action": "retry-jobs", onclick: () => expState.selected ? selectJob(expState.selected, true) : refreshJobs() }, "重试")) : null,
    node("div", { class: "exp-jobs" }, ...expState.jobs.map(job => node("button", {
      class: `exp-job${job.id === expState.selected ? " selected" : ""}`, type: "button", onclick: () => selectJob(job.id),
    },
      text("span", job.config?.label || job.id, "exp-job-title"),
      node("span", { class: "exp-job-row" },
        text("span", expJobStatus[job.status] || job.status, `status ${expJobTone[job.status] || "pending"}`),
        text("span", `${job.results.length} / ${job.plannedRuns}`, "case-meta"),
        text("span", date(job.createdAt), "run-date"))))),
    !expState.jobs.length && !expState.jobsError ? text("p", "还没有实验任务。", "sidebar-empty") : null);
}

const expConfigSummary = config => !config ? "配置未采集。"
  : `${expKindNames[config.kind] || config.kind}${config.version === 2 ? " v2" : ""} · 重复 ${config.repeat} 次 · ${(config.variants || []).map(variant => {
    if (config.kind === "support") return `${variant.id} ${variant.architecture}`;
    const acceptance = config.version === 2 ? ` · ${variant.acceptance?.mode === "score" ? `score ${variant.acceptance.threshold}` : "off"}` : "";
    return `${variant.id} ${variant.modes.join("+")}${acceptance}`;
  }).join(" 对比 ")}`;

function expJobPanel() {
  const job = expState.job;
  if (!job) return node("section", { class: "panel" }, text("p", "选择任务查看进度与结果；提交新实验后自动跟踪。任务配置以保存的快照为准，不随表单编辑变化。", "batch-note"));
  const terminal = job.status !== "running";
  const done = job.results.length;
  const missing = terminal ? Math.max(0, job.plannedRuns - done) : 0;
  const comparable = job.results.filter(result => result.kind === "support" && result.runId);
  return node("section", { class: "panel", "aria-label": "任务详情" },
    node("div", { class: "panel-heading" }, text("h3", job.config?.label || "实验任务"), text("p", `ID ${short(job.id)} · ${date(job.createdAt)}`)),
    node("div", { class: "exp-job-body" },
      node("p", { class: "exp-progress" },
        text("span", expJobStatus[job.status] || job.status, `status ${expJobTone[job.status] || "pending"}`),
        text("span", job.status === "running" && job.current
          ? `正在执行 方案 ${job.current.variantId} · 第 ${job.current.repetition} 次 · 已完成 ${done} / ${job.plannedRuns}`
          : `已完成 ${done} / ${job.plannedRuns}`)),
      missing ? text("p", `未执行 ${missing} 次；中断及未执行的重复不算通过。`, "batch-caution") : null,
      job.error ? text("p", job.error, "turn-error") : null,
      node("div", { class: "exp-job-config" },
        text("p", `配置快照：${expConfigSummary(job.config)}`, "metric-note"),
        node("button", { class: "quiet-button", type: "button", "data-action": "load-config", onclick: () => { expState.draft = expCopy(job.config); expState.presetId = null; expState.formError = ""; renderExperiments(); } }, "载入配置到表单")),
      ...job.results.map(result => expResultNode(job, result)),
      comparable.length >= 2
        ? node("div", {}, node("button", { class: "quiet-button", type: "button", "data-action": "compare-btn", onclick: () => expCompare(comparable) }, "带入 A/B 对比"))
        : null));
}

function expResultNode(job, result) {
  const variant = job.config?.variants?.find(item => item.id === result.variantId) ?? null;
  return node("div", { class: "exp-result" },
    node("div", { class: "exp-result-head" },
      text("span", `方案 ${result.variantId} · 第 ${result.repetition} 次`, "exp-result-title"),
      text("span", expJobStatus[result.status] || result.status, `status ${result.status === "completed" ? "passed" : result.status === "failed" ? "failed" : "skipped"}`),
      text("code", short(result.runId), "evidence-tag"),
      result.kind === "support"
        ? node("button", { class: "quiet-button", type: "button", "data-action": "view-run", onclick: () => { setView("overview"); selectRun(result.runId); } }, "查看运行")
        : null),
    result.kind === "support" ? expSupportSummary(result.summary) : expRetrievalSummary(result.summary, variant),
    node("details", { class: "trace" }, node("summary", {}, "原始 summary JSON"), json(result.summary ?? null)));
}

// support summary 即 RunAnalysis：分母与 null 口径沿用主页面规则，不补零。
function expSupportSummary(summary) {
  const cases = summary?.counts?.cases;
  const checks = summary?.counts?.checks;
  const usage = summary?.usage;
  const noModel = usage?.modelRequests === 0;
  const lines = [
    cases ? `场景 通过 ${cases.passed} / ${cases.planned}${cases.failed ? ` · 失败 ${cases.failed}` : ""}${cases.skipped ? ` · 跳过 ${cases.skipped}` : ""}${cases.missing ? ` · 缺失 ${cases.missing}` : ""}` : "场景计数未采集",
    checks ? `检查 通过 ${checks.passed} / ${checks.planned}${checks.failed ? ` · 失败 ${checks.failed}` : ""}${checks.missing ? ` · 缺失 ${checks.missing}` : ""}` : null,
    `单轮耗时 P95 ${duration(summary?.timing?.durationP95Ms)}`,
    noModel ? "Tokens 不适用（无模型请求）" : `Tokens 已知 ${number(usage?.knownTokens)} · 完整 ${usage?.completeTokens === null || usage?.completeTokens === undefined ? "未采全" : number(usage.completeTokens)}`,
    ...(summary?.issues || []).map(issue => `问题：${issue}`),
  ].filter(Boolean);
  return node("div", { class: "exp-summary" }, ...lines.map(line => text("p", line, "exp-summary-line")));
}

// retrieval summary 即 runRetrievalV2 报告 summary：按 mode/corpus/suite 分列，不合成单一通过率。
// Recall 同时给出成功样本均值与计划口径（plannedRecallAt5，分母含调用失败及缺失）；null 显示未采集/不适用，不补零。
function expRetrievalSummary(summary, variant) {
  if (!summary || !Array.isArray(summary.groups)) return text("p", "检索 summary 未采集。", "metric-note");
  const acceptanceMode = variant?.acceptance?.mode;
  const datasetLabel = variant?.dataset ? expState.catalog?.datasets?.find(item => item.value === variant.dataset)?.label || variant.dataset : null;
  const strategy = acceptanceMode === "score"
    ? `证据接收：${datasetLabel ? `${datasetLabel} · ` : ""}score 实验阈值 ${variant.acceptance.threshold}；是否达标见指标`
    : acceptanceMode === "off" ? `证据接收：${datasetLabel ? `${datasetLabel} · ` : ""}off 诊断基线（范围内原始 Top5）` : null;
  const diag = group => {
    const parts = [["noAnswerNonempty", "非空召回"], ["scopeViolations", "越界"], ["boundaryFailures", "边界失败"]]
      .filter(([key]) => group[key] !== null && group[key] !== undefined)
      .map(([key, label]) => `${label} ${group[key]}`);
    return parts.length ? parts.join(" · ") : "不适用";
  };
  return node("div", { class: "exp-summary" },
    strategy ? text("p", strategy, "exp-strategy") : null,
    node("div", { class: "retrieval-scroll" }, node("table", { class: "retrieval-table exp-table" },
      node("thead", {}, node("tr", {}, ...["模式", "语料", "题集", "成功 / 计划", "失败", "缺失", "Recall@5 成功 / 计划", "MRR@5（成功均值）", "诊断"].map(label => text("th", label)))),
      node("tbody", {}, ...summary.groups.map(group => node("tr", {},
        text("td", group.mode, "mono"),
        text("td", corpusNames[group.corpus] || group.corpus),
        text("td", expSuiteNames[group.suite] || group.suite),
        text("td", `${group.succeeded ?? "—"} / ${group.planned ?? "—"}`, "mono"),
        text("td", number(group.failed), "mono"),
        text("td", number(group.missing), "mono"),
        text("td", `${percent(group.recallAt5)} / ${percent(group.plannedRecallAt5)}`, "mono"),
        text("td", ratio(group.mrrAt5), "mono"),
        text("td", diag(group))))))),
    text("p", "Recall/MRR 为成功样本均值；计划口径分母含调用失败及缺失。按模式与语料/题集分列，不合成总体分。", "metric-note"),
    expAcceptanceSection(summary.groups),
    node("details", { class: "metric-details exp-usage" }, node("summary", {}, "检索用量"),
      node("div", { class: "metrics-foot" }, ...expUsageLines(summary.usage))));
}

// 证据接收指标独立分表：与原始 Recall 分开；误接收/误拒给明确分子/分母，分母 0 显示不适用；
// context 题为待 C1 计划项；任务完成不等于策略验收通过。
function expAcceptanceSection(groups) {
  if (!groups.some(group => group.acceptance)) return text("p", "未记录证据接收指标（旧版原始报告）。", "metric-note");
  const ratioCell = (cases, denominator, rate) => !denominator ? "不适用" : `${number(cases)} / ${number(denominator)}（${percent(rate)}）`;
  // 误接收分两行：无答案（仅 no_answer 口径）与预期拒答（no_answer + 期望拒答的 scope）；
  // 旧报告缺 abstention 字段显示未记录，不得让 0 权限违规掩盖预期拒答误接收。
  const falseAcceptCell = acc => node("td", { class: "mono" },
    node("span", { class: "exp-acc-line" }, `无答案 ${ratioCell(acc.noAnswerFalseAcceptCases, acc.noAnswerDenominator, acc.noAnswerFalseAcceptRate)}`),
    node("span", { class: "exp-acc-line" }, acc.abstentionDenominator === undefined
      ? "预期拒答 未记录"
      : `预期拒答 ${ratioCell(acc.abstentionFalseAcceptCases, acc.abstentionDenominator, acc.abstentionFalseAcceptRate)}`));
  const diag = acc => {
    const parts = [];
    if (acc.deferred) parts.push(`待 C1 ${acc.deferred}`);
    if (acc.failed) parts.push(`失败 ${acc.failed}`);
    if (acc.missing) parts.push(`缺失 ${acc.missing}`);
    if (acc.notApplicable) parts.push(`不适用 ${acc.notApplicable}`);
    if (acc.scopeViolations) parts.push(`越界 ${acc.scopeViolations}`);
    if (acc.boundaryFailures) parts.push(`边界失败 ${acc.boundaryFailures}`);
    return parts.length ? parts.join(" · ") : "—";
  };
  const hasContext = groups.some(group => group.suite === "context" || group.acceptance?.deferred);
  return node("div", { class: "exp-acc" },
    text("p", "证据接收（离线实验）", "exp-acc-title"),
    node("div", { class: "retrieval-scroll" }, node("table", { class: "retrieval-table exp-table" },
      node("thead", {}, node("tr", {}, ...["模式", "语料", "题集", "接收后 Recall@5 成功 / 计划", "覆盖率 覆盖/已测", "误接收 无答案 / 预期拒答", "误拒", "诊断"].map(label => text("th", label)))),
      node("tbody", {}, ...groups.map(group => {
        const acc = group.acceptance;
        if (!acc) return node("tr", {},
          text("td", group.mode, "mono"), text("td", corpusNames[group.corpus] || group.corpus), text("td", expSuiteNames[group.suite] || group.suite),
          node("td", { colspan: "5" }, "未记录"));
        return node("tr", {},
          text("td", group.mode, "mono"),
          text("td", corpusNames[group.corpus] || group.corpus),
          text("td", expSuiteNames[group.suite] || group.suite),
          text("td", `${percent(acc.recallAt5)} / ${percent(acc.plannedRecallAt5)}`, "mono"),
          text("td", acc.measured === null || acc.measured === undefined ? "未采集" : `${number(acc.coveredCases)} / ${number(acc.measured)}（${percent(acc.coverage)}）`, "mono"),
          falseAcceptCell(acc),
          text("td", ratioCell(acc.answerableFalseRejectCases, acc.answerableFalseRejectDenominator, acc.answerableFalseRejectRate), "mono"),
          text("td", diag(acc)));
      })))),
    hasContext ? text("p", "context（上下文）题为待 C1 计划项，不产生调用。", "metric-note") : null,
    text("p", "离线实验结果，非上线效果；任务完成不等于门槛通过，策略是否达标见以上指标。", "metric-note"));
}

// 用量按 operation 分列：请求/缓存命中/已知 Tokens 与完整量；USD 与 CNY 各自分行，不合并。
function expUsageLines(usage) {
  if (!Array.isArray(usage) || !usage.length) return [text("span", "用量未采集。")];
  const lines = [];
  for (const item of usage) {
    lines.push(text("span", `${item.operation} · 请求 ${number(item.requests)} · 缓存命中 ${number(item.cacheHits)} · 已报用量 ${number(item.reportedRequests)} · 已知 Tokens ${number(item.knownTokens)} · 完整 ${item.completeTokens === null || item.completeTokens === undefined ? "未知" : number(item.completeTokens)}`));
    const cost = (known, complete, symbol, code) => known === undefined && complete === undefined ? null
      : `${code}：已知 ${known === null || known === undefined ? "未知" : `${symbol}${known.toFixed(6)}`} · 完整 ${complete === null || complete === undefined ? "未知" : `${symbol}${complete.toFixed(6)}`}`;
    const cny = cost(item.knownEstimatedCostCny, item.completeEstimatedCostCny, "¥", "CNY");
    const usd = cost(item.knownEstimatedCostUsd, item.completeEstimatedCostUsd, "$", "USD");
    if (cny) lines.push(text("span", cny));
    if (usd) lines.push(text("span", usd));
  }
  return lines;
}

// 带入既有版本对比：可比性门控保持由后端判定。
function expCompare(results) {
  const [a, b] = results;
  for (const [id, result] of [["baseline", a], ["candidate", b]]) {
    const select = $(id);
    if (!select) continue;
    select.append(node("option", { value: result.runId }, `实验 · 方案 ${result.variantId} 第 ${result.repetition} 次 · ${short(result.runId)}`));
    select.value = result.runId;
  }
  setView("compare");
  compare();
}
