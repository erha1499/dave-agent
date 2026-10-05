// Shared contract for the CLI evaluator, MySQL history and local read-only workbench.
import type { SupportCall } from "./support-controller.ts";
export type EvalStatus = "passed" | "failed" | "skipped";
export type EvalCheck = {
  id: string;
  name: string;
  category: "business" | "safety" | "evidence" | "execution";
  status: EvalStatus;
  reason?: string;
  basis?: "trace" | "state" | "protocol" | "execution";
};
export type EvalObjectivePlan = {
  version: 1 | 2;
  scope: "objective";
  answerQuality: "not_evaluated";
  cases: Array<{
    id: string;
    tags: string[];
    turns: Array<{
      index: number;
      source: "user" | "host" | "event" | "engineering";
      checks: Array<{ id: string; category: EvalCheck["category"]; basis: NonNullable<EvalCheck["basis"]> }>;
    }>;
  }>;
};
export type EvalBatch = { id: string; repetition: number; plannedRepetitions: number };
export type EvalUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  estimatedCostUsd: number | null;
};
// v2 attribution is additive: old model/tool steps retain their original meaning.
export type EvalSpan = {
  id: string; parentSpanId: string | null;
  actor: "agent" | "host"; trigger: "user" | "event" | "confirmation";
  component: string; name: string; observedAt: string; durationMs: number | null;
  outcome: "ok" | "denied" | "error";
  input?: unknown; output?: unknown;
  knowledge?: SupportCall["knowledge"];
  usage?: {
    provider: string; model: string; kind: "llm" | "embedding" | "rerank";
    inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
    cost: { currency: "USD" | "CNY"; amount: number; source: "sdk_estimate" | "provider" | "price_estimate" } | null;
  };
};
export type EvalStep = {
  index: number;
  type: "model" | "tool";
  name: string;
  durationMs: number | null;
  input?: unknown;
  output?: unknown;
  isError: boolean;
  expectedDenial?: boolean;
  usage?: EvalUsage | null;
};
export type EvalTurn = {
  index: number;
  question: string;
  reply: string;
  status: EvalStatus;
  startedAt: string;
  durationMs: number | null;
  firstTextMs: number | null;
  evidenceIds: string[];
  checks: EvalCheck[];
  steps: EvalStep[];
  spans?: EvalSpan[];
  observations?: { before?: unknown; after?: unknown; protocol?: unknown };
  error?: string;
};
export type EvalCase = {
  id: string; name: string; category: string; status: EvalStatus; turns: EvalTurn[];
};
export type EvalSnapshot = {
  gitCommit: string;
  gitDirty: boolean;
  model: { provider: string; id: string; maxTokens: number; thinking: string; temperature: number | null };
  hashes: { prompt: string; skill: string; tools: string; dataset: string; checker: string; business: string };
  asOf: string;
  // Only synthetic evaluation inputs, instructions and business facts; never runtime credentials/QQ identities.
  content: Record<string, unknown>;
};
export type EvalMetrics = {
  casesPassed: number; casesFailed: number; casesSkipped: number;
  turnsPassed: number; turnsFailed: number; turnsSkipped: number;
  checksPassed: number; checksFailed: number; checksSkipped: number;
  durationP50Ms: number | null; durationP95Ms: number | null;
  modelRequests: number; toolCalls: number; toolErrors: number; expectedDenials: number;
  usageRequests: number; totalTokens: number | null; inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; estimatedCostUsd: number | null;
};
export type EvalRun = {
  id: string; suiteId: string; suiteName: string; kind: "model" | "engineering";
  label: string; status: "running" | "completed" | "failed";
  startedAt: string; finishedAt: string | null;
  plannedCases: number; plannedTurns: number;
  snapshot: EvalSnapshot; metrics: EvalMetrics | null; error?: string;
  batch?: EvalBatch;
};
export type EvalRunDetail = { run: EvalRun; cases: EvalCase[] };
export type EvalRunSummary = Omit<EvalRun, "snapshot"> & { snapshot: Omit<EvalSnapshot, "content"> };

export function summarizeEvaluation(cases: EvalCase[]): EvalMetrics {
  const turns = cases.flatMap(item => item.turns);
  const checks = turns.flatMap(turn => turn.checks);
  const steps = turns.flatMap(turn => turn.steps);
  const models = steps.filter(step => step.type === "model");
  const tools = steps.filter(step => step.type === "tool");
  const usage = models.flatMap(step => step.usage ? [step.usage] : []);
  const durations = turns.flatMap(turn => turn.durationMs === null ? [] : [turn.durationMs]).sort((a, b) => a - b);
  const count = (items: { status: EvalStatus }[], status: EvalStatus) => items.filter(item => item.status === status).length;
  const percentile = (p: number) => durations.length ? durations[Math.ceil(p * durations.length) - 1]! : null;
  const sum = (key: Exclude<keyof EvalUsage, "estimatedCostUsd">) => usage.length ? usage.reduce((total, item) => total + item[key], 0) : null;
  return {
    casesPassed: count(cases, "passed"), casesFailed: count(cases, "failed"), casesSkipped: count(cases, "skipped"),
    turnsPassed: count(turns, "passed"), turnsFailed: count(turns, "failed"), turnsSkipped: count(turns, "skipped"),
    checksPassed: count(checks, "passed"), checksFailed: count(checks, "failed"), checksSkipped: count(checks, "skipped"),
    durationP50Ms: percentile(.5), durationP95Ms: percentile(.95),
    modelRequests: models.length, toolCalls: tools.length, toolErrors: tools.filter(step => step.isError && !step.expectedDenial).length,
    expectedDenials: tools.filter(step => step.isError && step.expectedDenial).length,
    usageRequests: usage.length, totalTokens: sum("totalTokens"), inputTokens: sum("input"), outputTokens: sum("output"),
    cacheReadTokens: sum("cacheRead"), cacheWriteTokens: sum("cacheWrite"),
    estimatedCostUsd: usage.length && usage.every(item => item.estimatedCostUsd !== null)
      ? usage.reduce((total, item) => total + item.estimatedCostUsd!, 0) : null,
  };
}
