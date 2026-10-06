import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { analyzeBatch, analyzeEvaluation, compareEvaluations, objectivePlan, validEvalBatch } from "../src/eval-analysis.ts";
import { createEvaluationServer } from "../src/eval-server.ts";
import type { EvalObjectivePlan, EvalRunDetail } from "../src/evaluation.ts";

const batchId = randomUUID();
const plan: EvalObjectivePlan = { version: 1, scope: "objective", answerQuality: "not_evaluated", cases: [{
  id: "owned-order", tags: ["identity", "refund"], turns: [{ index: 1, source: "user", checks: [
    { id: "owner", category: "safety", basis: "state" }, { id: "fresh-order", category: "evidence", basis: "trace" },
  ] }],
}] };
function fixture(repetition = 1): EvalRunDetail {
  return {
    run: { id: randomUUID(), suiteId: "objective-check", suiteName: "客观分析工程检查", kind: "engineering", label: "合成记录",
      status: "completed", startedAt: "2026-10-05T00:00:00.000Z", finishedAt: "2026-10-05T00:00:01.000Z",
      plannedCases: 1, plannedTurns: 1, batch: { id: batchId, repetition, plannedRepetitions: 2 }, metrics: null,
      snapshot: { gitCommit: "synthetic", gitDirty: true, asOf: "2026-10-05T00:00:00.000Z",
        model: { provider: "engineering", id: "no-model", maxTokens: 0, thinking: "off", temperature: null },
        hashes: { prompt: "prompt", skill: "skill", tools: "tools", dataset: "dataset", checker: "checker", business: "business" },
        content: { evaluation: structuredClone(plan), measurement: "合成采集，不调用模型或 QQ",
          implementation: { files: { "synthetic.ts": "hash" } }, runtime: { node: "test", platform: "test", arch: "test" }, settings: {} } } },
    cases: [{ id: "owned-order", name: "合成归属检查", category: "identity", status: "passed", turns: [{
      index: 1, question: "合成请求", reply: "不评回答质量", status: "passed", startedAt: "2026-10-05T00:00:00.000Z",
      durationMs: 10, firstTextMs: null, evidenceIds: [],
      checks: plan.cases[0]!.turns[0]!.checks.map(check => ({ ...check, name: check.id, status: "passed" })),
      steps: [{ index: 1, type: "model", name: "synthetic", durationMs: 8, isError: false,
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, estimatedCostUsd: .001 } },
      { index: 2, type: "tool", name: "get_order", durationMs: 2, isError: true, expectedDenial: true }],
    }] }],
  };
}

const original = fixture();
const analysis = analyzeEvaluation(original);
assert.equal(analysis.scope, "objective");
assert.deepEqual(analysis.counts?.checks, { planned: 2, passed: 2, failed: 0, skipped: 0, missing: 0, passRate: 1 });
assert.equal(analysis.coverage.find(item => item.tag === "identity")?.cases.passed, 1);
assert.equal(analysis.categories.find(item => item.category === "safety")?.checks.passed, 1);
assert.equal(analysis.answerQuality, "not_evaluated");
assert.equal(analysis.execution.expectedDenials, 1);
assert.equal(analysis.execution.toolErrors, 0);
assert.equal(analysis.usage.completeTokens, 12);
assert.equal(analysis.usage.completeCostUsd, .001);
assert.equal(analysis.timing.durationP95Ms, 10);

const partial = fixture();
partial.cases[0]!.turns[0]!.steps.push({ index: 3, type: "model", name: "synthetic", durationMs: 1, isError: true, usage: null });
const partialAnalysis = analyzeEvaluation(partial);
assert.equal(partialAnalysis.usage.knownTokens, 12);
assert.equal(partialAnalysis.usage.completeTokens, null);
assert.equal(partialAnalysis.usage.knownCostUsd, .001);
assert.equal(partialAnalysis.usage.completeCostUsd, null);
assert.equal(partialAnalysis.usage.coverage, .5);
assert.equal(partialAnalysis.execution.modelErrors, 1);
partial.cases[0]!.turns[0]!.steps[2]!.usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, estimatedCostUsd: null };
assert.equal(analyzeEvaluation(partial).usage.completeTokens, 19);
assert.equal(analyzeEvaluation(partial).usage.completeCostUsd, null);
const host = fixture();
host.cases[0]!.turns[0]!.steps = [];
assert.deepEqual(analyzeEvaluation(host).usage, { modelRequests: 0, reportedRequests: 0, missingRequests: 0, coverage: null,
  knownTokens: null, completeTokens: null, knownCostUsd: null, completeCostUsd: null });

const missing = fixture();
missing.run.status = "failed";
missing.cases = [];
assert.deepEqual(analyzeEvaluation(missing).counts?.checks, { planned: 2, passed: 0, failed: 0, skipped: 0, missing: 2, passRate: 0 });
const skipped = fixture();
skipped.cases[0]!.status = "skipped";
skipped.cases[0]!.turns[0]!.status = "skipped";
for (const check of skipped.cases[0]!.turns[0]!.checks) check.status = "skipped";
assert.equal(analyzeEvaluation(skipped).counts?.checks.skipped, 2);
assert.equal(analyzeEvaluation(skipped).counts?.cases.skipped, 1);
const failed = fixture(2);
failed.cases[0]!.status = "failed";
failed.cases[0]!.turns[0]!.status = "failed";
failed.cases[0]!.turns[0]!.checks[0]!.status = "failed";
assert.equal(analyzeEvaluation(failed).counts?.checks.failed, 1);
assert.equal(analyzeEvaluation(failed).counts?.cases.passRate, 0);

const mutations: Array<(value: EvalRunDetail) => void> = [
  value => { value.run.plannedCases = 2; },
  value => { value.run.plannedTurns = 2; },
  value => { (value.run.snapshot.content.evaluation as EvalObjectivePlan).cases.push(structuredClone(plan.cases[0]!)); },
  value => { const item = (value.run.snapshot.content.evaluation as EvalObjectivePlan).cases[0]!; item.turns.push(structuredClone(item.turns[0]!)); },
  value => { const turn = (value.run.snapshot.content.evaluation as EvalObjectivePlan).cases[0]!.turns[0]!; turn.checks.push({ ...turn.checks[0]! }); },
  value => { (value.run.snapshot.content.evaluation as EvalObjectivePlan).cases[0]!.tags = ["identity", "identity"]; },
  value => { (value.run.snapshot.content.evaluation as unknown as { answerQuality: string }).answerQuality = "passed"; },
  value => { ((value.run.snapshot.content.evaluation as EvalObjectivePlan).cases[0]!.turns[0]!.checks[0] as unknown as { basis: string }).basis = "reply"; },
  value => { value.cases.push(structuredClone(value.cases[0]!)); },
  value => { value.cases[0]!.turns.push(structuredClone(value.cases[0]!.turns[0]!)); },
  value => { value.cases[0]!.turns[0]!.checks.push({ ...value.cases[0]!.turns[0]!.checks[0]! }); },
  value => { value.cases[0]!.turns[0]!.checks[0]!.category = "business"; },
  value => { value.cases[0]!.turns[0]!.checks[0]!.basis = "protocol"; },
  value => { value.cases[0]!.turns[0]!.checks[0]!.id = "unplanned"; },
  value => { value.cases[0]!.turns[0]!.checks.pop(); },
  value => { value.cases[0]!.turns = []; },
];
for (const mutate of mutations) {
  const invalid = fixture(); mutate(invalid);
  const checked = analyzeEvaluation(invalid);
  assert.equal(checked.scope, "invalid");
  assert.equal(checked.counts, null);
  assert.ok(checked.issues.length);
}
const legacy = fixture();
delete legacy.run.snapshot.content.evaluation;
assert.equal(analyzeEvaluation(legacy).scope, "legacy");
assert.equal(analyzeEvaluation(legacy).counts, null);
assert.equal(compareEvaluations(legacy, legacy).comparable, false);
assert.equal(objectivePlan(original.run).scope, "objective");
for (const batch of [undefined, {}, { id: batchId, repetition: 0, plannedRepetitions: 2 },
  { id: batchId, repetition: 3, plannedRepetitions: 2 }, { id: batchId, repetition: 1, plannedRepetitions: 21 }]) assert.equal(validEvalBatch(batch), false);

const repeat = fixture(2);
assert.equal(compareEvaluations(original, repeat).repeatCompatible, true);
assert.equal(compareEvaluations(original, failed).cases[0]!.change, "regressed");
assert.equal(compareEvaluations(failed, original).cases[0]!.change, "improved");
const different = fixture(2);
different.run.snapshot.hashes.business = "changed";
assert.equal(compareEvaluations(original, different).comparable, false);
assert.equal(compareEvaluations(original, different).cases[0]!.change, "incomplete");
const candidate = fixture(2);
candidate.run.snapshot.hashes.prompt = "candidate";
assert.equal(compareEvaluations(original, candidate).comparable, true);
assert.equal(compareEvaluations(original, candidate).repeatCompatible, false);
for (const mutate of [
  (detail: EvalRunDetail) => { detail.run.snapshot.content.settings = { retries: 99 }; },
  (detail: EvalRunDetail) => { detail.run.snapshot.content.runtime = { node: "other", platform: "test", arch: "test" }; },
  (detail: EvalRunDetail) => { detail.run.snapshot.content.implementation = { files: { "synthetic.ts": "other-hash" } }; },
  (detail: EvalRunDetail) => { detail.run.snapshot.hashes.checker = "other-checker"; },
]) {
  const changed = fixture(2); mutate(changed);
  assert.equal(compareEvaluations(original, changed).repeatCompatible, false);
  assert.equal(analyzeBatch(batchId, [original, changed]).compatible, false);
}
for (const key of ["implementation", "runtime", "measurement", "settings"]) {
  const unknown = fixture(); delete unknown.run.snapshot.content[key];
  const comparison = compareEvaluations(unknown, unknown);
  assert.equal(comparison.repeatCompatible, false);
  assert.equal([...comparison.conditions, ...comparison.configuration].find(item => item.key === key)?.status, "unknown");
}

assert.equal(analyzeBatch(batchId, [original, repeat]).cases[0]!.status, "always_passed");
assert.equal(analyzeBatch(batchId, [original, failed]).cases[0]!.status, "mixed");
const onlyOne = analyzeBatch(batchId, [original]);
assert.equal(onlyOne.compatible, true);
assert.equal(onlyOne.missingRuns, 1);
assert.equal(onlyOne.cases[0]!.status, "incomplete");
assert.equal(onlyOne.cases[0]!.missing, 1);
assert.equal(onlyOne.usage.completeTokens, null);
assert.equal(analyzeBatch(batchId, [original, fixture(1)]).compatible, false);
assert.deepEqual(analyzeBatch(batchId, [original, candidate]).cases, []);
const interrupted = fixture(2); interrupted.run.status = "failed";
assert.equal(analyzeBatch(batchId, [original, interrupted]).cases[0]!.status, "incomplete");
assert.equal(analyzeBatch(batchId, [original, interrupted]).usage.completeCostUsd, null);

const large = fixture();
const largePlan = large.run.snapshot.content.evaluation as EvalObjectivePlan;
largePlan.cases = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(plan.cases[0]!), id: `case-${index}` }));
largePlan.cases[0]!.turns[0]!.checks = Array.from({ length: 2000 }, (_, index) => ({ id: `check-${index}`, category: "execution", basis: "execution" }));
large.run.plannedCases = 500; large.run.plannedTurns = 500;
assert.equal(objectivePlan(large.run).scope, "objective");

const retrieval = fixture();
retrieval.run.suiteId = "retrieval-objective-v1";
retrieval.cases = []; retrieval.run.plannedCases = 4; retrieval.run.plannedTurns = 4;
const retrievalPlan = retrieval.run.snapshot.content.evaluation as EvalObjectivePlan;
retrievalPlan.cases = [];
for (const [index, measurement] of [
  { name: "retrieval_rank", output: { kind: "retrieval", corpus: "full", suite: "hard", firstRelevantRank: 6,
    recallAt1: 0, recallAt5: 0, reciprocalRank: 1 / 6, reciprocalRankAt5: 0, rankedIds: ["a", "b", "c", "d", "e", "f"], relevant: ["f"] } },
  { name: "retrieval_rank", output: { kind: "retrieval", corpus: "selected", suite: "standard", firstRelevantRank: 1,
    recallAt1: 1, recallAt5: 1, reciprocalRank: 1, reciprocalRankAt5: 1, rankedIds: ["f"], relevant: ["f"] } },
  { name: "retrieval_no_answer", output: { kind: "no_answer", empty: false, returned: ["a"] } },
  { name: "retrieval_scope", output: { kind: "scope", passed: true, returned: [] } },
].entries()) {
  const planned = structuredClone(plan.cases[0]!); planned.id = `retrieval-${index}`; planned.turns[0]!.source = "engineering";
  retrievalPlan.cases.push(planned);
  const observed = structuredClone(original.cases[0]!); observed.id = planned.id;
  observed.turns[0]!.steps = [{ index: 1, type: "tool", name: measurement.name, output: measurement.output, durationMs: 1, isError: false }];
  retrieval.cases.push(observed);
}
const retrievalSummary = analyzeEvaluation(retrieval);
assert.deepEqual(retrievalSummary.retrieval, { groups: [
  { corpus: "full", suite: "hard", samples: 1, recallAt1: 0, recallAt5: 0, mrr: 1 / 6, mrrAt5: 0 },
  { corpus: "selected", suite: "standard", samples: 1, recallAt1: 1, recallAt5: 1, mrr: 1, mrrAt5: 1 },
], noAnswer: { samples: 1, empty: 0, nonempty: 1 }, scope: { samples: 1, passed: 1, failed: 0 } });
for (const mutate of [
  (output: Record<string, unknown>) => { output.firstRelevantRank = 1; },
  (output: Record<string, unknown>) => { output.reciprocalRank = 0; },
  (output: Record<string, unknown>) => { output.relevant = []; },
  (output: Record<string, unknown>) => { output.rankedIds = ["f", "f"]; },
]) {
  const bad = structuredClone(retrieval); mutate(bad.cases[0]!.turns[0]!.steps[0]!.output as Record<string, unknown>);
  const summary = analyzeEvaluation(bad);
  assert.equal(summary.retrieval, null); assert.ok(summary.issues.length); assert.equal(summary.scope, "invalid");
}
const wrongSuite = structuredClone(retrieval); wrongSuite.run.kind = "model";
assert.equal(analyzeEvaluation(wrongSuite).retrieval, null);
const multiRelevant = structuredClone(retrieval);
multiRelevant.cases[0]!.turns[0]!.steps[0]!.output = { kind: "retrieval", corpus: "full", suite: "hard", firstRelevantRank: 1,
  recallAt1: .5, recallAt5: .5, reciprocalRank: 1, reciprocalRankAt5: 1, rankedIds: ["a", "b", "c", "d", "e", "f"], relevant: ["a", "f"] };
const multiSummary = analyzeEvaluation(multiRelevant);
assert.equal(multiSummary.scope, "objective");
assert.deepEqual(multiSummary.retrieval?.groups[0], { corpus: "full", suite: "hard", samples: 1, recallAt1: .5, recallAt5: .5, mrr: 1, mrrAt5: 1 });
(multiRelevant.cases[0]!.turns[0]!.steps[0]!.output as { recallAt5: number }).recallAt5 = 1;
assert.equal(analyzeEvaluation(multiRelevant).scope, "invalid", "one relevant hit is not complete multi-document recall");

const unavailableId = randomUUID();
const providerDetail = fixture();
const providerTurn = providerDetail.cases[0]!.turns[0]!;
const spanBase = { parentSpanId: "provider-turn", trigger: "user" as const, name: "request", observedAt: providerTurn.startedAt,
  durationMs: 1, outcome: "ok" as const };
providerTurn.spans = [
  { ...spanBase, id: "provider-turn", parentSpanId: null, actor: "host", component: "qq-ingress" },
  { ...spanBase, id: "provider-agent", actor: "agent", component: "model", usage: { provider: "deepseek", model: "flash", kind: "llm",
    currency: "USD", inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: { currency: "USD", amount: .001, source: "sdk_estimate" } } },
  { ...spanBase, id: "provider-parser", actor: "host", component: "support-question", outcome: "error", usage: {
    provider: "bailian", model: "qwen", kind: "llm", currency: "CNY", inputTokens: null, outputTokens: null, totalTokens: null, cost: null } },
];
assert.equal(analyzeEvaluation(original).attribution, null, "No spans in historical record cannot prove zero provider costs");
const byId = new Map([original, repeat, legacy, providerDetail].map(detail => [detail.run.id, detail]));
const server = createEvaluationServer({ ping: async () => {}, listRuns: async () => [],
  getRun: async id => { if (id === unavailableId) throw new Error("synthetic database error"); return byId.get(id); },
  getBatch: async id => id === batchId ? [original, repeat] : [] });
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const providerResponse = await (await fetch(`${base}/api/runs/${providerDetail.run.id}/analysis`)).json() as ReturnType<typeof analyzeEvaluation>;
  assert.equal(providerResponse.usage.modelRequests, 1, "Existing summary remains Agent-only");
  assert.equal(providerResponse.attribution?.providerTotals.requests, 2, "Provider summary counts spans once, not plus model steps");
  assert.equal(providerResponse.attribution?.providerTotals.currencies[0]!.completeAmount, .001);
  assert.equal(providerResponse.attribution?.providerTotals.currencies[1]!.unknownRequests, 1);
  assert.equal(providerResponse.attribution?.providerTotals.currencies[1]!.knownAmount, null);
  assert.equal(providerResponse.attribution?.providerTotals.currencies[1]!.completeAmount, null);
  assert.deepEqual(await (await fetch(`${base}/api/runs/${original.run.id}/analysis`)).json(), analyzeEvaluation(original));
  assert.deepEqual(await (await fetch(`${base}/api/compare?baseline=${original.run.id}&candidate=${repeat.run.id}`)).json(), compareEvaluations(original, repeat));
  assert.deepEqual(await (await fetch(`${base}/api/batches/${batchId}`)).json(), analyzeBatch(batchId, [original, repeat]));
  assert.equal((await fetch(`${base}/api/runs/${legacy.run.id}/analysis`).then(response => response.json()) as { scope: string }).scope, "legacy");
  for (const path of ["/api/runs/bad/analysis", `/api/runs/${original.run.id}/analysis?unknown=1`, "/api/batches/bad",
    `/api/batches/${batchId}?limit=1`, "/api/compare", `/api/compare?baseline=${original.run.id}&candidate=${original.run.id}`,
    `/api/compare?baseline=${original.run.id}&candidate=${repeat.run.id}&candidate=${repeat.run.id}`,
    `/api/compare?baseline=${original.run.id}&candidate=${repeat.run.id}&other=1`]) assert.equal((await fetch(`${base}${path}`)).status, 400, path);
  for (const path of [`/api/runs/${randomUUID()}/analysis`, `/api/batches/${randomUUID()}`,
    `/api/compare?baseline=${original.run.id}&candidate=${randomUUID()}`]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  const failedResponse = await fetch(`${base}/api/runs/${unavailableId}/analysis`);
  assert.equal(failedResponse.status, 503);
  assert.doesNotMatch(await failedResponse.text(), /synthetic database error/);
  assert.equal((await fetch(`${base}/api/batches/${batchId}`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/api/runs/${original.run.id}/analysis`, { headers: { Origin: "https://untrusted.test" } })).status, 403);
} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
console.log("PASS 客观计划、缺失/跳过、分维度覆盖、完整用量、可比性、批次稳定性与新增只读 API。");
