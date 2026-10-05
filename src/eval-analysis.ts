import type { EvalCase, EvalObjectivePlan, EvalRun, EvalRunDetail, EvalStep, EvalTurn, EvalUsage } from "./evaluation.ts";
import { analyzeSupportSpans, type SupportTraceAnalysis } from "./support-evaluation.ts";

type Outcome = "passed" | "failed" | "skipped" | "missing";
export type EvalCounts = { planned: number; passed: number; failed: number; skipped: number; missing: number; passRate: number | null };
export type EvalUsageAnalysis = {
  modelRequests: number; reportedRequests: number; missingRequests: number; coverage: number | null;
  knownTokens: number | null; completeTokens: number | null; knownCostUsd: number | null; completeCostUsd: number | null;
};
export type EvalCaseAnalysis = { id: string; tags: string[]; status: Outcome; turns: EvalCounts; checks: EvalCounts };
export type EvalRetrievalAnalysis = {
  groups: Array<{ corpus: "selected" | "full"; suite: "standard" | "hard"; samples: number; recallAt1: number; recallAt5: number; mrr: number; mrrAt5: number }>;
  noAnswer: { samples: number; empty: number; nonempty: number };
  scope: { samples: number; passed: number; failed: number };
};
export type EvalRunAnalysis = {
  runId: string; scope: "objective" | "legacy" | "invalid"; answerQuality: "not_evaluated"; issues: string[];
  counts: { cases: EvalCounts; turns: EvalCounts; checks: EvalCounts } | null;
  categories: Array<{ category: string; checks: EvalCounts }>;
  coverage: Array<{ tag: string; cases: EvalCounts }>;
  cases: EvalCaseAnalysis[];
  usage: EvalUsageAnalysis;
  execution: { toolCalls: number; toolErrors: number; expectedDenials: number; modelErrors: number };
  timing: { samples: number; durationP50Ms: number | null; durationP95Ms: number | null; measurement: string | null };
  retrieval: EvalRetrievalAnalysis | null;
  attribution: SupportTraceAnalysis | null;
};
export type EvalCondition = { key: string; status: "equal" | "different" | "unknown" };
export type EvalComparison = {
  baseline: string; candidate: string; comparable: boolean; repeatCompatible: boolean;
  conditions: EvalCondition[]; configuration: EvalCondition[]; issues: string[];
  analyses: { baseline: EvalRunAnalysis; candidate: EvalRunAnalysis };
  cases: Array<{ id: string; baseline: Outcome; candidate: Outcome; change: "same" | "improved" | "regressed" | "incomplete" }>;
};
export type EvalBatchAnalysis = {
  batchId: string; compatible: boolean; issues: string[]; plannedRepetitions: number | null;
  startedRuns: number; completedRuns: number; missingRuns: number | null; runIds: string[];
  cases: Array<{ id: string; planned: number; passed: number; failed: number; skipped: number; missing: number;
    status: "always_passed" | "always_failed" | "mixed" | "incomplete" }>;
  usage: EvalUsageAnalysis;
};

const categories = ["business", "safety", "evidence", "execution"] as const;
const bases = ["trace", "state", "protocol", "execution"];
const sources = ["user", "host", "event", "engineering"];
const statuses = ["passed", "failed", "skipped"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const array = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length > 0 && value.length <= max;
const positiveInteger = (value: unknown, max: number): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= max;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const unique = (values: unknown[]) => new Set(values).size === values.length;
const validUuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function validEvalBatch(value: unknown): value is NonNullable<EvalRun["batch"]> {
  return record(value) && exactKeys(value, ["id", "repetition", "plannedRepetitions"]) && validUuid(value.id)
    && positiveInteger(value.plannedRepetitions, 20) && positiveInteger(value.repetition, value.plannedRepetitions);
}

// A missing manifest is legacy, not a retroactive assertion about old answer checks.
export function objectivePlan(run: EvalRun): { scope: EvalRunAnalysis["scope"]; issues: string[]; plan?: EvalObjectivePlan } {
  const value = run.snapshot.content.evaluation;
  if (value === undefined) return { scope: "legacy", issues: ["该历史运行没有客观检查计划。"] };
  const invalid = (reason: string) => ({ scope: "invalid" as const, issues: [reason] });
  if (!record(value) || !exactKeys(value, ["version", "scope", "answerQuality", "cases"])
    || ![1, 2].includes(Number(value.version)) || typeof value.version !== "number" || value.scope !== "objective" || value.answerQuality !== "not_evaluated" || !array(value.cases, 500))
    return invalid("客观计划版本、范围或案例集合无效。");
  let turns = 0;
  const ids: string[] = [];
  for (const item of value.cases) {
    if (!record(item) || !exactKeys(item, ["id", "tags", "turns"]) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)
      || !array(item.tags, 30) || !unique(item.tags) || item.tags.some(tag => typeof tag !== "string" || tag.trim() !== tag || !tag.length || tag.length > 64 || /[\p{Cc}\p{Cf}]/u.test(tag))
      || !array(item.turns, 100)) return invalid("客观案例的 ID、标签或轮次计划无效。");
    ids.push(item.id);
    const indexes: number[] = [];
    for (const turn of item.turns) {
      if (!record(turn) || !exactKeys(turn, ["index", "source", "checks"]) || !positiveInteger(turn.index, 10_000)
        || typeof turn.source !== "string" || !sources.includes(turn.source) || !array(turn.checks, 2000)) return invalid("客观轮次来源、索引或检查集合无效。");
      indexes.push(turn.index);
      const checks: string[] = [];
      for (const check of turn.checks) {
        if (!record(check) || !exactKeys(check, ["id", "category", "basis"]) || !identifier(check.id)
          || !categories.includes(check.category as typeof categories[number]) || typeof check.basis !== "string" || !bases.includes(check.basis))
          return invalid("客观检查标识、维度或依据无效；不接受回答质量检查。");
        checks.push(check.id);
      }
      if (!unique(checks)) return invalid("同轮检查 ID 重复。");
    }
    if (!unique(indexes)) return invalid("案例轮次索引重复。");
    turns += item.turns.length;
  }
  if (!unique(ids)) return invalid("案例 ID 重复。");
  if (value.cases.length !== run.plannedCases || turns !== run.plannedTurns) return invalid("客观计划与运行计划分母不一致。");
  return { scope: "objective", issues: [], plan: value as unknown as EvalObjectivePlan };
}

function counts(outcomes: Outcome[]): EvalCounts {
  return { planned: outcomes.length, passed: outcomes.filter(value => value === "passed").length,
    failed: outcomes.filter(value => value === "failed").length, skipped: outcomes.filter(value => value === "skipped").length,
    missing: outcomes.filter(value => value === "missing").length,
    passRate: outcomes.length ? outcomes.filter(value => value === "passed").length / outcomes.length : null };
}
function outcome(status: "passed" | "failed" | "skipped" | undefined, children: Outcome[]): Outcome {
  if (status === undefined) return "missing";
  if (status === "failed" || children.includes("failed")) return "failed";
  if (children.includes("missing")) return "missing";
  if (status === "skipped" || children.includes("skipped")) return "skipped";
  return "passed";
}
function validUsage(value: EvalUsage | null | undefined): value is EvalUsage {
  return Boolean(value && Number.isFinite(value.totalTokens) && value.totalTokens > 0
    && [value.input, value.output, value.cacheRead, value.cacheWrite].every(item => Number.isFinite(item) && item >= 0));
}
function usageAnalysis(steps: EvalStep[]): EvalUsageAnalysis {
  const models = steps.filter(step => step.type === "model");
  const reported = models.flatMap(step => validUsage(step.usage) ? [step.usage] : []);
  const priced = reported.filter(value => value.estimatedCostUsd !== null && Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd >= 0);
  const knownTokens = reported.length ? reported.reduce((sum, value) => sum + value.totalTokens, 0) : null;
  const knownCostUsd = priced.length ? priced.reduce((sum, value) => sum + value.estimatedCostUsd!, 0) : null;
  return { modelRequests: models.length, reportedRequests: reported.length, missingRequests: models.length - reported.length,
    coverage: models.length ? reported.length / models.length : null, knownTokens,
    completeTokens: models.length && models.length === reported.length ? knownTokens : null, knownCostUsd,
    completeCostUsd: models.length && models.length === priced.length ? knownCostUsd : null };
}

function retrievalAnalysis(turns: EvalTurn[]): EvalRetrievalAnalysis {
  const groups = new Map<string, { corpus: "selected" | "full"; suite: "standard" | "hard";
    scores: Array<{ recallAt1: number; recallAt5: number; reciprocalRank: number; reciprocalRankAt5: number }> }>();
  const noAnswer = { samples: 0, empty: 0, nonempty: 0 }, scope = { samples: 0, passed: 0, failed: 0 };
  const names = ["retrieval_rank", "retrieval_no_answer", "retrieval_scope"];
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000 && value.every(nonempty) && unique(value);
  for (const turn of turns) {
    const measurements = turn.steps.filter(step => step.type === "tool" && names.includes(step.name));
    if (measurements.length > 1) throw new Error("同一检索轮次重复记录测量。");
    for (const step of measurements) {
      const value = step.output;
      if (step.isError || !record(value)) throw new Error("检索测量步骤缺少有效结果。");
      if (step.name === "retrieval_rank") {
        if (value.kind !== "retrieval" || !["selected", "full"].includes(String(value.corpus)) || !["standard", "hard"].includes(String(value.suite))
          || !strings(value.rankedIds) || !strings(value.relevant) || !value.relevant.length) throw new Error("检索排名、标签或分组无效。");
        const position = value.rankedIds.findIndex(id => (value.relevant as string[]).includes(id));
        const rank = position < 0 ? null : position + 1;
        const positions = value.relevant.map(id => (value.rankedIds as string[]).indexOf(id) + 1);
        const expected = { recallAt1: positions.filter(position => position === 1).length / positions.length,
          recallAt5: positions.filter(position => position > 0 && position <= 5).length / positions.length,
          reciprocalRank: rank === null ? 0 : 1 / rank, reciprocalRankAt5: rank !== null && rank <= 5 ? 1 / rank : 0 };
        if (value.firstRelevantRank !== rank || Object.entries(expected).some(([key, number]) => typeof value[key] !== "number"
          || !Number.isFinite(value[key]) || Math.abs(value[key] as number - number) > 1e-10)) throw new Error("检索排名与数值指标不一致。");
        const key = `${value.corpus}/${value.suite}`;
        const group = groups.get(key) ?? { corpus: value.corpus as "selected" | "full", suite: value.suite as "standard" | "hard", scores: [] };
        group.scores.push(expected); groups.set(key, group);
      } else if (step.name === "retrieval_no_answer") {
        if (value.kind !== "no_answer" || !strings(value.returned) || typeof value.empty !== "boolean" || value.empty !== (value.returned.length === 0))
          throw new Error("无答案检索诊断无效。");
        noAnswer.samples++; value.empty ? noAnswer.empty++ : noAnswer.nonempty++;
      } else {
        if (value.kind !== "scope" || !strings(value.returned) || typeof value.passed !== "boolean") throw new Error("知识范围隔离诊断无效。");
        scope.samples++; value.passed ? scope.passed++ : scope.failed++;
      }
    }
  }
  return { groups: [...groups.values()].map(group => {
    const mean = (key: keyof typeof group.scores[number]) => group.scores.reduce((sum, score) => sum + score[key], 0) / group.scores.length;
    return { corpus: group.corpus, suite: group.suite, samples: group.scores.length,
      recallAt1: mean("recallAt1"), recallAt5: mean("recallAt5"), mrr: mean("reciprocalRank"), mrrAt5: mean("reciprocalRankAt5") };
  }), noAnswer, scope };
}

export function analyzeEvaluation(detail: EvalRunDetail): EvalRunAnalysis {
  const { run, cases } = detail;
  const turns = cases.flatMap(item => item.turns);
  const steps = turns.flatMap(turn => turn.steps);
  const durations = turns.flatMap(turn => turn.durationMs !== null && Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? [turn.durationMs] : []).sort((a, b) => a - b);
  const parsed = objectivePlan(run);
  const result: EvalRunAnalysis = {
    runId: run.id, scope: parsed.scope, answerQuality: "not_evaluated", issues: parsed.issues, counts: null, categories: [], coverage: [], cases: [], retrieval: null,
    attribution: turns.some(turn => turn.spans !== undefined) ? analyzeSupportSpans(turns.flatMap(turn => Array.isArray(turn.spans) ? turn.spans : [])) : null,
    usage: usageAnalysis(steps),
    execution: { toolCalls: steps.filter(step => step.type === "tool").length,
      toolErrors: steps.filter(step => step.type === "tool" && step.isError && !step.expectedDenial).length,
      expectedDenials: steps.filter(step => step.type === "tool" && step.isError && step.expectedDenial).length,
      modelErrors: steps.filter(step => step.type === "model" && step.isError).length },
    timing: { samples: durations.length, durationP50Ms: durations.length ? durations[Math.ceil(.5 * durations.length) - 1]! : null,
      durationP95Ms: durations.length ? durations[Math.ceil(.95 * durations.length) - 1]! : null,
      measurement: nonempty(run.snapshot.content.measurement) ? run.snapshot.content.measurement : null },
  };
  if (turns.some(turn => turn.spans !== undefined && !Array.isArray(turn.spans))) result.issues.push("v2 span 集合无效。");
  if (result.attribution?.issues.length) result.issues.push(...result.attribution.issues);
  if (!parsed.plan) return result;
  const plannedCases = new Map(parsed.plan.cases.map(item => [item.id, item]));
  const foundCases = new Map<string, EvalCase>();
  for (const item of cases) {
    if (foundCases.has(item.id) || !plannedCases.has(item.id) || !statuses.includes(item.status)) result.issues.push(`案例结果重复、未规划或状态无效：${item.id}`);
    foundCases.set(item.id, item);
    const plannedTurns = new Map(plannedCases.get(item.id)?.turns.map(turn => [turn.index, turn]));
    const foundTurns = new Set<number>();
    for (const turn of item.turns) {
      if (foundTurns.has(turn.index) || !plannedTurns.has(turn.index) || !statuses.includes(turn.status)) result.issues.push(`轮次结果重复、未规划或状态无效：${item.id}/${turn.index}`);
      foundTurns.add(turn.index);
      const plannedChecks = new Map(plannedTurns.get(turn.index)?.checks.map(check => [check.id, check]));
      const foundChecks = new Set<string>();
      for (const check of turn.checks) {
        const expected = plannedChecks.get(check.id);
        if (foundChecks.has(check.id) || !expected || expected.category !== check.category || (check.basis !== undefined && check.basis !== expected.basis)
          || !statuses.includes(check.status)) result.issues.push(`检查结果重复、未规划或声明不符：${item.id}/${turn.index}/${check.id}`);
        foundChecks.add(check.id);
      }
    }
  }
  const allTurns: Outcome[] = [], allChecks: Outcome[] = [];
  const byCategory = new Map<string, Outcome[]>(categories.map(category => [category, []]));
  const byTag = new Map<string, Outcome[]>();
  for (const expected of parsed.plan.cases) {
    const found = foundCases.get(expected.id);
    const turnOutcomes: Outcome[] = [], checkOutcomes: Outcome[] = [];
    for (const expectedTurn of expected.turns) {
      const foundTurn = found?.turns.find(turn => turn.index === expectedTurn.index);
      const current = expectedTurn.checks.map(check => {
        const status = foundTurn?.checks.find(item => item.id === check.id)?.status ?? "missing";
        byCategory.get(check.category)!.push(status);
        return status;
      });
      const status = outcome(foundTurn?.status, current);
      if (foundTurn?.status === "passed" && status !== "passed") result.issues.push(`轮次标记通过但计划检查未全通过：${expected.id}/${expectedTurn.index}`);
      checkOutcomes.push(...current);
      turnOutcomes.push(status);
    }
    const status = outcome(found?.status, turnOutcomes);
    if (found?.status === "passed" && status !== "passed") result.issues.push(`案例标记通过但计划轮次未全通过：${expected.id}`);
    result.cases.push({ id: expected.id, tags: expected.tags, status, turns: counts(turnOutcomes), checks: counts(checkOutcomes) });
    allTurns.push(...turnOutcomes);
    allChecks.push(...checkOutcomes);
    for (const tag of expected.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), status]);
  }
  if (result.issues.length) return { ...result, scope: "invalid", cases: [] };
  result.counts = { cases: counts(result.cases.map(item => item.status)), turns: counts(allTurns), checks: counts(allChecks) };
  result.categories = [...byCategory].map(([category, values]) => ({ category, checks: counts(values) }));
  result.coverage = [...byTag].sort(([a], [b]) => a.localeCompare(b)).map(([tag, values]) => ({ tag, cases: counts(values) }));
  if (run.kind === "engineering" && run.suiteId === "retrieval-objective-v1") {
    try { result.retrieval = retrievalAnalysis(turns); }
    catch (error) {
      result.issues.push(error instanceof Error ? error.message : "检索测量无效。");
      return { ...result, scope: "invalid", counts: null, categories: [], coverage: [], cases: [] };
    }
  }
  return result;
}

// JSON object key order is not an evaluation condition. Array order remains significant.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const known = (value: unknown) => value !== undefined && value !== null && value !== "";
const condition = (key: string, a: unknown, b: unknown): EvalCondition => ({ key,
  status: !known(a) || !known(b) ? "unknown" : canonical(a) === canonical(b) ? "equal" : "different" });
const implementation = (run: EvalRun) => {
  const value = run.snapshot.content.implementation;
  return record(value) && record(value.files) && Object.keys(value.files).length && Object.values(value.files).every(nonempty) ? value.files : undefined;
};
const runtime = (run: EvalRun) => {
  const value = run.snapshot.content.runtime;
  return record(value) && [value.node, value.platform, value.arch].every(nonempty) ? value : undefined;
};
const settings = (run: EvalRun) => record(run.snapshot.content.settings) ? run.snapshot.content.settings : undefined;
const model = (run: EvalRun) => {
  const value = run.snapshot.model;
  return value && nonempty(value.provider) && nonempty(value.id) && Number.isFinite(value.maxTokens) && nonempty(value.thinking)
    && (value.temperature === null || Number.isFinite(value.temperature)) ? value : undefined;
};

export function compareEvaluations(a: EvalRunDetail, b: EvalRunDetail): EvalComparison {
  const baseline = analyzeEvaluation(a), candidate = analyzeEvaluation(b);
  const conditions = [condition("scope", baseline.scope === "objective" ? `objective-v${objectivePlan(a.run).plan?.version}` : undefined, candidate.scope === "objective" ? `objective-v${objectivePlan(b.run).plan?.version}` : undefined),
    condition("suite", a.run.suiteId, b.run.suiteId), condition("kind", a.run.kind, b.run.kind),
    ...["dataset", "checker", "business"].map(key => condition(key, a.run.snapshot.hashes[key as keyof EvalRun["snapshot"]["hashes"]], b.run.snapshot.hashes[key as keyof EvalRun["snapshot"]["hashes"]])),
    condition("manifest", a.run.snapshot.content.evaluation, b.run.snapshot.content.evaluation),
    condition("measurement", baseline.timing.measurement, candidate.timing.measurement)];
  const configuration = [condition("model", model(a.run), model(b.run)),
    ...["prompt", "skill", "tools"].map(key => condition(key, a.run.snapshot.hashes[key as keyof EvalRun["snapshot"]["hashes"]], b.run.snapshot.hashes[key as keyof EvalRun["snapshot"]["hashes"]])),
    condition("implementation", implementation(a.run), implementation(b.run)), condition("runtime", runtime(a.run), runtime(b.run)),
    condition("settings", settings(a.run), settings(b.run))];
  const comparable = conditions.every(item => item.status === "equal");
  const ids = new Set([...baseline.cases, ...candidate.cases].map(item => item.id));
  return { baseline: a.run.id, candidate: b.run.id, comparable,
    repeatCompatible: comparable && configuration.every(item => item.status === "equal"), conditions, configuration,
    issues: [...conditions, ...configuration].filter(item => item.status !== "equal").map(item => `${item.key}: ${item.status}`),
    analyses: { baseline, candidate },
    cases: [...ids].map(id => {
      const left = baseline.cases.find(item => item.id === id)?.status ?? "missing";
      const right = candidate.cases.find(item => item.id === id)?.status ?? "missing";
      const comparableResult = comparable && [left, right].every(status => status === "passed" || status === "failed");
      return { id, baseline: left, candidate: right, change: !comparableResult ? "incomplete" : left === right ? "same" : right === "passed" ? "improved" : "regressed" };
    }) };
}

export function analyzeBatch(batchId: string, details: EvalRunDetail[]): EvalBatchAnalysis {
  const runs = [...details].sort((a, b) => (a.run.batch?.repetition ?? 0) - (b.run.batch?.repetition ?? 0));
  const first = runs[0];
  const issues: string[] = [];
  if (!validUuid(batchId) || !first) issues.push("批次不存在或标识无效。");
  const planned = first && validEvalBatch(first.run.batch) ? first.run.batch.plannedRepetitions : null;
  const repetitions = new Set<number>(), runIds = new Set<string>();
  const analyses = runs.map(detail => analyzeEvaluation(detail));
  for (const detail of runs) {
    const batch = detail.run.batch;
    if (!validEvalBatch(batch) || batch.id !== batchId || batch.plannedRepetitions !== planned) issues.push("批次元数据无效或计划次数不一致。");
    if (batch && repetitions.has(batch.repetition)) issues.push("批次重复序号冲突。");
    if (runIds.has(detail.run.id)) issues.push("批次运行 ID 重复。");
    if (batch) repetitions.add(batch.repetition);
    runIds.add(detail.run.id);
    if (first && !compareEvaluations(first, detail).repeatCompatible) issues.push(`运行不属于同一完整配置：${detail.run.id}`);
  }
  const compatible = issues.length === 0;
  const completedRuns = runs.filter(detail => detail.run.status === "completed").length;
  const missingRuns = planned === null ? null : Math.max(0, planned - runs.length);
  const usage = usageAnalysis(runs.flatMap(detail => detail.cases.flatMap(item => item.turns.flatMap(turn => turn.steps))));
  if (!compatible || missingRuns || runs.some(detail => detail.run.status !== "completed")) { usage.completeTokens = null; usage.completeCostUsd = null; }
  return { batchId, compatible, issues: [...new Set(issues)], plannedRepetitions: planned,
    startedRuns: runs.length, completedRuns, missingRuns, runIds: runs.map(detail => detail.run.id), usage,
    cases: !compatible || planned === null ? [] : analyses[0]!.cases.map(item => {
      const states = analyses.map(analysis => analysis.cases.find(value => value.id === item.id)?.status ?? "missing");
      states.push(...Array<Outcome>(missingRuns ?? 0).fill("missing"));
      const aggregate = counts(states);
      const incomplete = Boolean(aggregate.missing || aggregate.skipped || runs.some(detail => detail.run.status !== "completed"));
      return { id: item.id, planned, passed: aggregate.passed, failed: aggregate.failed, skipped: aggregate.skipped, missing: aggregate.missing,
        status: incomplete ? "incomplete" : aggregate.passed === planned ? "always_passed" : aggregate.failed === planned ? "always_failed" : "mixed" };
    }) };
}
