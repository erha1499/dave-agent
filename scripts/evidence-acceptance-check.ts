import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptEvidence, resolveEvidenceAcceptance } from "../src/evidence-acceptance.ts";
import { createBailianClient } from "../src/bailian.ts";
import { runRetrievalV2, summarizeV2, type V2Dataset } from "./retrieval-v2.ts";

const documents = [
  { id: "hours", title: "午餐时间", tags: ["午餐"], body: "午餐十一点至十四点。", shopId: null },
  { id: "refund", title: "退款", tags: ["退款"], body: "模拟商家审核退款。", shopId: null },
  { id: "inactive", title: "停车", tags: [], body: "已停用停车规则。", shopId: null, status: "inactive" as const },
  { id: "private", title: "停车", tags: [], body: "另一门店停车规则。", shopId: "other" },
];
const input = { scope: {}, documents, ranking: [{ id: "hours", score: .8 }, { id: "refund", score: .3 }], query: "午餐时间" };
const raw = structuredClone(input);
assert.deepEqual(acceptEvidence(input).accepted.map(doc => doc.id), ["hours", "refund"]);
const gated = acceptEvidence({ ...input, config: { mode: "score", threshold: .8 } });
assert.deepEqual(gated.accepted, [{ id: "hours", title: "午餐时间", tags: ["午餐"], body: "午餐十一点至十四点。", score: .8, rank: 1 }]);
assert.equal(gated.rejected[0]!.reason, "below_threshold");
assert.equal(gated.diagnostics.scoreGap, .5);
assert.deepEqual(gated.diagnostics.candidates[0]!.matchedTags, ["午餐"]);
assert.deepEqual(input, raw, "acceptance cannot mutate raw ranking or original documents");
const unsafe = acceptEvidence({ ...input, config: { mode: "score", threshold: .5 }, ranking: [
  { id: "unknown", score: 1 }, { id: "inactive", score: 1 }, { id: "private", score: 1 },
  { id: "hours", score: null }, { id: "refund", score: Infinity }, { id: "hours", score: .99 },
] });
assert.deepEqual(unsafe.accepted, []);
assert.deepEqual(unsafe.rejected.map(doc => doc.reason), ["unknown_document", "inactive_document", "out_of_scope", "missing_score", "invalid_score", "duplicate_document"]);
const capped = acceptEvidence({ ...input, documents: Array.from({ length: 6 }, (_, i) => ({ ...documents[0]!, id: String(i) })),
  ranking: Array.from({ length: 6 }, (_, i) => ({ id: String(i), score: 1 })) });
assert.equal(capped.accepted.length, 5); assert.equal(capped.rejected[0]!.reason, "top_k_limit");
for (const status of ["provider_error", "not_applicable"] as const) {
  const result = acceptEvidence({ ...input, status });
  assert.equal(result.status, "unavailable"); assert.equal(result.accepted.length, 0, "diagnostic fallback never becomes accepted evidence");
}
assert.equal(acceptEvidence({ ...input, ranking: [] }).rejected[0]!.reason, "no_candidates");
assert.throws(() => acceptEvidence({ ...input, scope: { productId: "orphan" } }), /scope/);
assert.equal(acceptEvidence({ ...input, config: { mode: "off" }, ranking: [{ id: "private", score: 1 }] }).accepted.length, 0);
assert.deepEqual(resolveEvidenceAcceptance(), { mode: "off" });
for (const invalid of [null, [], { mode: ["off"] }, { mode: "off", threshold: .5 }, { mode: "score" },
  { mode: "score", threshold: NaN }, { mode: "score", threshold: -1 }, { mode: "score", threshold: 1.1 }, { mode: "score", threshold: ".5" },
  { mode: "score", threshold: .5, allowInactive: true }]) assert.throws(() => resolveEvidenceAcceptance(invalid));
assert.throws(() => resolveEvidenceAcceptance({ mode: "score", threshold: .4 }, ["M4", "M1"]), /M4\/M5\/M6/);

const dataset: V2Dataset = { source: "synthetic A1 behavior check, not a quality evaluation", corpora: [{ id: "synthetic", documents, questions: [
  { id: "answerable", query: "午餐时间", suite: "standard", shopId: null, relevant: ["hours"] },
  { id: "negative", query: "钠含量", suite: "no_answer", shopId: null, relevant: [] },
  { id: "context", query: "它几点开", suite: "context", shopId: null, relevant: [], deferredReason: "等待 C1 可信上下文合同" },
] }] };
const env = { DASHSCOPE_API_KEY: "mock-secret", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" };
let network = 0;
const client = createBailianClient({ env, retries: 0, fetch: async (_url, init) => {
  network++;
  const body = JSON.parse(String(init?.body));
  const values = body.documents.map((document: string, index: number) => ({ index, relevance_score: body.query === "钠含量" ? .1
    : JSON.parse(document).title === "午餐时间" ? .8 : .3 })).sort((a: { relevance_score: number }, b: { relevance_score: number }) => b.relevance_score - a.relevance_score);
  return new Response(JSON.stringify({ results: values, usage: { total_tokens: 10 } }), { headers: { "Content-Type": "application/json" } });
} });
const directory = await mkdtemp(join(tmpdir(), "dave-acceptance-"));
try {
  const options = { label: "A1 mock", modes: ["M4"] as Array<"M4">, dataset, client, allowRemote: true,
    outputDir: join(directory, "out"), cacheDir: join(directory, "cache") };
  // Incompatible mode is rejected before touching credentials or creating a report.
  await assert.rejects(runRetrievalV2({ label: "invalid", modes: ["M1"], acceptance: { mode: "score", threshold: .4 }, outputDir: directory }), /M4\/M5\/M6/);
  assert.deepEqual(await readdir(directory), []);
  const baseline = await runRetrievalV2(options);
  assert.equal(network, 2, "deferred context must not call rerank");
  assert.equal(baseline.report.status, "completed", "intentional deferral is not a provider failure");
  assert.equal(baseline.report.plan.length, 3); assert.equal(baseline.report.results.length, 3);
  const calibrated = await runRetrievalV2({ ...options, acceptance: { mode: "score", threshold: .6 } });
  assert.equal(network, 2, "policy replay reuses raw cached ranking");
  assert.deepEqual(calibrated.report.results.map(row => row.ranking), baseline.report.results.map(row => row.ranking));
  const answer = calibrated.report.summary.groups.find(group => group.suite === "standard")!;
  const negative = calibrated.report.summary.groups.find(group => group.suite === "no_answer")!;
  assert.equal(answer.recallAt5, 1); assert.equal(answer.acceptance.recallAt5, 1);
  assert.equal(answer.acceptance.plannedRecallAt5, 1);
  assert.equal(answer.acceptance.answerableFalseRejectDenominator, 1); assert.equal(answer.acceptance.answerableFalseRejectCases, 0);
  assert.equal(negative.noAnswerNonempty, 1); assert.equal(negative.acceptance.noAnswerFalseAcceptCases, 0); assert.equal(negative.acceptance.noAnswerDenominator, 1);
  const context = calibrated.report.results.find(row => row.suite === "context")!;
  assert.equal(context.status, "not_applicable"); assert.deepEqual(context.callIds, []); assert.equal(context.acceptance.status, "unavailable");
  assert.equal(calibrated.report.summary.groups.find(group => group.suite === "context")!.acceptance.deferred, 1);
  assert.equal(calibrated.report.snapshot.settings.acceptance.model, "qwen3-rerank");
  assert.match(calibrated.report.snapshot.settings.acceptance.corpusHashes.synthetic!, /^[0-9a-f]{64}$/);
  assert.equal(calibrated.report.snapshot.settings.acceptance.serialization, "json-title-tags-body-v1");
  const strict = await runRetrievalV2({ ...options, acceptance: { mode: "score", threshold: .9 } });
  const rejected = strict.report.summary.groups.find(group => group.suite === "standard")!;
  assert.equal(rejected.acceptance.answerableFalseRejectCases, 1); assert.equal(rejected.acceptance.recallAt5, 0);
  const missing = summarizeV2([], [], calibrated.report.plan).groups;
  assert.equal(missing.find(group => group.suite === "standard")!.acceptance.plannedRecallAt5, 0);
  assert.equal(missing.find(group => group.suite === "no_answer")!.acceptance.noAnswerDenominator, 0);
  assert.equal(missing.find(group => group.suite === "no_answer")!.acceptance.noAnswerFalseAcceptRate, null);
  const failing = createBailianClient({ env, retries: 0, fetch: async () => new Response("{}", { status: 503 }) });
  const failure = await runRetrievalV2({ ...options, client: failing, cacheDir: join(directory, "failed"), acceptance: { mode: "score", threshold: 0 } });
  const failureRow = failure.report.results.find(row => row.suite === "standard")!;
  assert.equal(failureRow.status, "provider_error"); assert.ok(failureRow.fallback!.ranking.length);
  assert.equal(failureRow.acceptance.accepted.length, 0); assert.equal(failureRow.acceptedMetrics, null);
  const failureSummary = failure.report.summary.groups.find(group => group.suite === "standard")!;
  assert.equal(failureSummary.acceptance.failed, 1); assert.equal(failureSummary.acceptance.plannedRecallAt5, 0);
  assert.equal(failureSummary.acceptance.answerableFalseRejectDenominator, 0);
  assert.equal((await readFile(failure.path, "utf8")).includes(env.DASHSCOPE_API_KEY), false);
  const budget = await runRetrievalV2({ ...options, cacheDir: join(directory, "budget"), maxRequests: 1,
    acceptance: { mode: "score", threshold: .6 } });
  assert.equal(budget.report.status, "budget_stopped");
  assert.equal(budget.report.results.find(row => row.suite === "context")!.status, "not_applicable",
    "deferred context remains explicit even when an earlier provider request hits the budget");
  assert.equal(budget.report.summary.missingRows, 1);
  const onlyDeferred = structuredClone(dataset); onlyDeferred.corpora[0]!.questions = [dataset.corpora[0]!.questions[2]!];
  const deferred = await runRetrievalV2({ label: "deferred without credentials", modes: ["M6"], dataset: onlyDeferred,
    allowRemote: true, outputDir: directory, acceptance: { mode: "score", threshold: .6 } });
  assert.equal(deferred.report.calls.length, 0); assert.equal(deferred.report.snapshot.settings.provider, null);
  const scopeOnly = structuredClone(dataset);
  scopeOnly.corpora[0]!.questions = [{ id: "scoped-abstention", query: "停车", suite: "scope", shopId: "another",
    relevant: [], forbidden: ["private"], expectedBehavior: "abstain" }];
  const scoped = await runRetrievalV2({ ...options, dataset: scopeOnly, acceptance: { mode: "score", threshold: .6 } });
  const scopeSummary = scoped.report.summary.groups[0]!;
  assert.equal(scopeSummary.scopeViolations, 0); assert.equal(scopeSummary.acceptance.scopeViolations, 0);
  assert.equal(scopeSummary.acceptance.noAnswerDenominator, 0);
  assert.equal(scopeSummary.acceptance.abstentionPlanned, 1); assert.equal(scopeSummary.acceptance.abstentionDenominator, 1);
  assert.equal(scopeSummary.acceptance.abstentionFalseAcceptCases, 1,
    "scope checks passing must not hide accepting visible but insufficient evidence on an abstention case");
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("A1 acceptance checks passed: raw preservation, threshold behavior, original evidence, scope/active gate, deferred cases, failure isolation, cache replay and explicit denominators; no external calls.");
