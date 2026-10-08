import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BailianError, createBailianClient, resolveBailianEndpoints, embeddingDimensions, validVector } from "../src/bailian.ts";
import { checkV2Boundaries, runRetrievalV2, retrievalModes, summarizeV2, validateV2Dataset, type SupportCall, type V2Dataset } from "./retrieval-v2.ts";

const env = { DASHSCOPE_API_KEY: "mock-secret-do-not-record", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1" };
const vector = (index = 0): number[] => Array.from({ length: embeddingDimensions }, (_value, i) => i === index ? 1 : 0);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const fake = (handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch => async (input, init) => handler(String(input), init!);
const normal = fake((url, init) => {
  assert.equal(init.redirect, "error"); assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${env.DASHSCOPE_API_KEY}`);
  const body = JSON.parse(String(init.body));
  if (url.endsWith("/embeddings")) return json({ data: body.input.map((_text: string, index: number) => ({ index, embedding: vector(index % 2) })), usage: { total_tokens: 12 } });
  assert.equal(body.model, "qwen3-rerank"); assert.equal(body.top_n, body.documents.length);
  return json({ id: "mock-rerank", results: body.documents.map((_doc: string, index: number) => ({ index, relevance_score: 1 - index / body.documents.length })), usage: { total_tokens: 20 } });
});
for (const base of ["https://dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com/", env.DASHSCOPE_BASE_URL,
  `${env.DASHSCOPE_BASE_URL}/embeddings`, "https://dashscope.aliyuncs.com/compatible-api/v1/reranks", "https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/"]) {
  const endpoints = resolveBailianEndpoints(base);
  assert.equal(new URL(endpoints.embedding).origin, new URL(base).origin); assert.ok(endpoints.rerank.endsWith("/compatible-api/v1/reranks"));
}
for (const base of ["http://dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com.evil.example", "https://aliyuncs.com", "https://127.0.0.1",
  "https://secret@dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com:444", "https://dashscope.aliyuncs.com/unknown", "https://dashscope.aliyuncs.com/?key=secret",
  "https://dashscope.aliyuncs.com/#secret", "https://evil.example/compatible-mode/v1"]) assert.throws(() => resolveBailianEndpoints(base), BailianError);
assert.throws(() => createBailianClient({ env: {} }), BailianError);
const client = createBailianClient({ env, fetch: normal, retries: 0 });
assert.equal((await client.embed(["a", "b"])).value.length, 2);
assert.equal((await client.rerank("query", ["a", "b"])).value.length, 2);
assert.equal(JSON.stringify(client.settings).includes(env.DASHSCOPE_API_KEY), false);
assert.equal(validVector(vector()), true); assert.equal(validVector([1]), false); assert.equal(validVector(vector().fill(0)), false);
assert.equal(validVector(vector().fill(Infinity)), false);

const rejects = async (value: unknown, kind: "embedding" | "rerank") => {
  const malformed = createBailianClient({ env, retries: 0, fetch: fake(() => json(value)) });
  await assert.rejects(kind === "embedding" ? malformed.embed(["one", "two"]) : malformed.rerank("query", ["one", "two"]), error =>
    error instanceof BailianError && error.attempts.length === 1 && error.attempts[0]!.outcome === "invalid_response");
};
await rejects({ data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] }, "embedding");
await rejects({ data: [{ index: 0, embedding: vector() }, { index: 2, embedding: vector() }] }, "embedding");
await rejects({ data: [{ index: 0, embedding: [1] }, { index: 1, embedding: vector() }] }, "embedding");
await rejects({ results: [{ index: 0, relevance_score: .9 }, { index: 0, relevance_score: .2 }] }, "rerank");
await rejects({ results: [{ index: 0, relevance_score: .1 }, { index: 1, relevance_score: .9 }] }, "rerank");
await rejects({ results: [{ index: 0, relevance_score: 1.1 }, { index: 1, relevance_score: .2 }] }, "rerank");
await rejects({ results: [{ index: 0, relevance_score: .9 }] }, "rerank");

let retryCalls = 0;
const retry = createBailianClient({ env, retries: 1, fetch: fake((url, init) => ++retryCalls === 1 ? json({ message: env.DASHSCOPE_API_KEY }, 429) : normal(url, init)) });
const retried = await retry.embed(["one"]);
assert.deepEqual(retried.attempts.map(attempt => attempt.outcome), ["http_error", "ok"]); assert.equal(retryCalls, 2);
const denied = createBailianClient({ env, retries: 2, fetch: fake(() => json({ message: env.DASHSCOPE_API_KEY }, 401)) });
await assert.rejects(denied.embed(["one"]), error => error instanceof BailianError && error.attempts.length === 1 && !error.message.includes(env.DASHSCOPE_API_KEY));
const timeout = createBailianClient({ env, retries: 0, timeoutMs: 5, fetch: fake(async () => new Promise(() => {})) });
await assert.rejects(timeout.embed(["one"]), error => error instanceof BailianError && error.attempts[0]!.outcome === "timeout");
const unreported = createBailianClient({ env, retries: 0, fetch: fake(() => json({ data: [{ index: 0, embedding: vector() }], usage: { total_tokens: 0 } })) });
assert.equal((await unreported.embed(["one"])).attempts[0]!.totalTokens, null);

const dataset: V2Dataset = { source: "public synthetic mock, not a model capability result", corpora: [{ id: "synthetic", documents: [
  { id: "A", title: "退款", body: "模拟退款规则", tags: ["退款"], shopId: null },
  { id: "B", title: "停车", body: "店甲停车规则", tags: ["停车"], shopId: "shop-a" },
  { id: "C", title: "停车", body: "店乙停车规则", tags: ["停车"], shopId: "shop-b" },
  { id: "D", title: "退款", body: "停用规则", tags: ["退款"], shopId: null, status: "inactive" },
  { id: "E", title: "退款", body: "私有套餐规则", tags: ["退款"], shopId: "shop-a", productId: "product-private" },
], questions: [
  { id: "refund", suite: "standard", query: "退款", relevant: ["A"], shopId: null },
  { id: "scope", suite: "scope", query: "停车", relevant: [], required: ["B"], forbidden: ["C", "E"], shopId: "shop-a" },
  { id: "unknown", suite: "no_answer", query: "月球面积", relevant: [], shopId: null },
] }] };
const invalid = structuredClone(dataset); invalid.corpora[0]!.questions[0]!.relevant = ["C"];
assert.throws(() => validateV2Dataset(invalid));
const boundaryQuestion = { ...dataset.corpora[0]!.questions[1]!, required: ["A"], forbidden: ["B"] };
assert.deepEqual(checkV2Boundaries(boundaryQuestion, dataset.corpora[0]!.documents, ["A", "B"]), {
  scopePassed: true, boundaryPassed: false, forbiddenMatches: ["B"], requiredPassed: true,
}, "same-scope irrelevant forbidden evidence remains a boundary failure without being labeled a scope leak");
assert.deepEqual(checkV2Boundaries(boundaryQuestion, dataset.corpora[0]!.documents, ["A", "C"]), {
  scopePassed: false, boundaryPassed: true, forbiddenMatches: [], requiredPassed: true,
}, "a real shop leak fails scope even when it is absent from the question's forbidden labels");
assert.equal(checkV2Boundaries(boundaryQuestion, dataset.corpora[0]!.documents, ["A", "D"]).scopePassed, false,
  "inactive evidence fails scope independently of the forbidden labels");
const directory = await mkdtemp(join(tmpdir(), "dave-retrieval-v2-"));
try {
  await assert.rejects(runRetrievalV2({ label: "unauthorized", modes: ["M4"], dataset, client, outputDir: directory }), /allowRemote/);
  const options = { label: "mock-calibration", dataset, client, allowRemote: true, cacheDir: join(directory, "cache"), outputDir: join(directory, "results") };
  const first = await runRetrievalV2({ ...options, modes: [...retrievalModes] });
  assert.equal(first.report.results.length, 21); assert.equal(first.report.status, "completed");
  assert.equal(first.report.version, 2); assert.equal(first.report.snapshot.checker.version, 2);
  assert.ok(first.report.results.every(row => row.scopePassed));
  assert.ok(first.report.results.every(row => row.candidateIds.every(id => !["C", "D", "E"].includes(id))));
  assert.ok(first.report.results.filter(row => row.mode === "M0").every(row => row.ranking.every(doc => doc.score === null)));
  assert.ok(first.report.summary.usage.some(row => row.requests > 0));
  assert.ok(first.report.results.filter(row => row.suite === "no_answer").every(row => row.metrics === null));
  assert.equal((await readFile(first.path, "utf8")).includes(env.DASHSCOPE_API_KEY), false);
  const partial = summarizeV2([], [], first.report.plan);
  assert.ok(partial.groups.every(group => group.planned === group.missing));
  assert.ok(partial.groups.filter(group => group.suite === "standard").every(group => group.plannedRecallAt5 === 0));
  const usd: SupportCall = { id: "usd", operation: "support", cache: "miss", inputHash: "synthetic-usd", requestHash: "synthetic-request", status: "ok",
    attempts: [{ operation: "support", provider: "deepseek", model: "synthetic", attempt: 1, durationMs: 1, outcome: "ok",
      totalTokens: 15, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: .000002 }] };
  const cny: SupportCall = { ...usd, id: "cny", inputHash: "synthetic-cny", attempts: [{ ...usd.attempts[0]!,
    provider: "bailian", model: "qwen3.7-plus-2026-05-26", costUsd: null, costCny: .0005 }] };
  const unknown: SupportCall = { ...cny, id: "unknown", status: "failed", attempts: [{ ...cny.attempts[0]!, outcome: "timeout",
    totalTokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costCny: null }] };
  // Actual attempt costs stay in their original currency; unknown and no-attempt ledgers never become zero.
  const costCases = [
    { name: "single CNY", calls: [cny], expected: [.0005, .0005, null, null, 1] },
    { name: "charged invalid response", calls: [{ ...cny, status: "failed" as const,
      attempts: [{ ...cny.attempts[0]!, outcome: "invalid_response" as const }] }], expected: [.0005, .0005, null, null, 1] },
    { name: "CNY known plus unknown", calls: [cny, unknown], expected: [.0005, null, null, null, .5] },
    { name: "legacy USD", calls: [usd], expected: [null, null, .000002, .000002, 1] },
    { name: "reported CNY zero", calls: [{ ...cny, attempts: [{ ...cny.attempts[0]!, costCny: 0 }] }], expected: [0, 0, null, null, 1] },
    { name: "reported USD zero", calls: [{ ...usd, attempts: [{ ...usd.attempts[0]!, costUsd: 0 }] }], expected: [null, null, 0, 0, 1] },
    { name: "cache only", calls: [{ ...cny, cache: "hit" as const, attempts: [] }], expected: [null, null, null, null, null] },
    { name: "mixed currencies", calls: [cny, usd], expected: [.0005, null, .000002, null, 1] },
  ];
  for (const row of costCases) {
    const usage = summarizeV2([], [], [], null, row.calls).usage.find(item => item.operation === "support");
    assert.ok(usage && "knownEstimatedCostUsd" in usage);
    assert.deepEqual([usage.knownEstimatedCostCny, usage.completeEstimatedCostCny, usage.knownEstimatedCostUsd,
      usage.completeEstimatedCostUsd, usage.costCoverage], row.expected, row.name);
    if (row.name === "charged invalid response") {
      assert.equal(usage.requests, 1); assert.equal(usage.successfulRequests, 0);
    }
    if (row.name === "cache only") {
      assert.equal(usage.requests, 0); assert.equal(usage.cacheHits, 1);
      assert.equal(usage.knownTokens, null); assert.equal(usage.completeTokens, null); assert.equal(usage.usageCoverage, null);
    }
    if (row.name === "legacy USD") assert.deepEqual(usage, {
      operation: "support", requests: 1, successfulRequests: 1, cacheHits: 0, reportedRequests: 1, usageCoverage: 1,
      knownTokens: 15, completeTokens: 15, knownEstimatedCostCny: null, completeEstimatedCostCny: null,
      knownEstimatedCostUsd: .000002, completeEstimatedCostUsd: .000002, costCoverage: 1,
    }, "old USD-only ledger preserves its exact summary shape and values");
  }
  const second = await runRetrievalV2({ ...options, modes: [...retrievalModes] });
  assert.ok(second.report.summary.usage.every(row => row.requests === 0 && row.completeTokens === null && row.cacheHits > 0));
  assert.deepEqual(second.report.results.map(row => row.ranking), first.report.results.map(row => row.ranking));
  const cacheContents = async () => Promise.all((await readdir(options.cacheDir)).sort().map(async file => [file, await readFile(join(options.cacheDir, file), "utf8")]));
  const savedCache = await cacheContents();
  const refreshed = await runRetrievalV2({ ...options, modes: ["M4"], parameters: { cache: "refresh" } });
  assert.equal(refreshed.report.summary.usage.find(row => row.operation === "rerank")!.requests, 3);
  assert.ok(refreshed.report.calls.every(call => call.cache === "miss"));
  assert.deepEqual(await cacheContents(), savedCache, "refresh bypasses both reading and writing persistent cache");
  const unusedCache = join(directory, "never-created");
  await runRetrievalV2({ ...options, modes: ["M4"], cacheDir: unusedCache, parameters: { cache: "refresh" } });
  await assert.rejects(readdir(unusedCache), { code: "ENOENT" });
  const refreshedBudget = await runRetrievalV2({ ...options, modes: ["M4"], parameters: { cache: "refresh", maxRequests: 1 } });
  assert.equal(refreshedBudget.report.status, "budget_stopped", "existing warm cache must not defeat a refresh budget");
  assert.equal(refreshedBudget.report.summary.usage.find(row => row.operation === "rerank")!.requests, 1);
  await assert.rejects(runRetrievalV2({ ...options, modes: ["M4"], maxRequests: 2, parameters: { maxRequests: 1 } }), /冲突/);
  await assert.rejects(runRetrievalV2({ ...options, modes: ["M4"], parameters: { retries: 1 } }), /实际配置冲突/);
  const narrowed: V2Dataset = { source: "candidate parameter oracle", corpora: [{ id: "candidates", documents:
    ["A", "B", "C"].map(id => ({ id, title: "alpha", body: "alpha", tags: ["alpha"], shopId: null })),
    questions: [{ id: "same-query", query: "alpha", suite: "standard", shopId: null, relevant: ["B"] }] }] };
  const payloadSizes: number[] = [];
  const recordingClient = createBailianClient({ env, timeoutMs: 2000, retries: 0, fetch: fake((url, init) => {
    payloadSizes.push(JSON.parse(String(init.body)).documents.length); return normal(url, init);
  }) });
  const candidateOptions = { ...options, dataset: narrowed, client: recordingClient, modes: ["M5"] as const };
  const narrow = await runRetrievalV2({ ...candidateOptions, modes: [...candidateOptions.modes],
    parameters: { candidateTopK: 1, timeoutMs: 2000, retries: 0, cache: "refresh" } });
  const wide = await runRetrievalV2({ ...candidateOptions, modes: [...candidateOptions.modes],
    parameters: { candidateTopK: 2, timeoutMs: 2000, retries: 0, cache: "refresh" } });
  assert.deepEqual(payloadSizes, [1, 2], "candidateTopK reaches the actual rerank request");
  assert.deepEqual(narrow.report.results[0]!.candidateIds, ["A"]); assert.deepEqual(wide.report.results[0]!.candidateIds, ["A", "B"]);
  assert.equal(narrow.report.results[0]!.metrics?.recallAt5, 0); assert.equal(wide.report.results[0]!.metrics?.recallAt5, 1);
  assert.equal(wide.report.snapshot.settings.parameters.timeoutMs, 2000);
  assert.equal(wide.report.snapshot.settings.provider!.timeoutMs, 2000);
  assert.equal(wide.report.snapshot.settings.topN, 5, "Top5 evaluation remains fixed when candidate count changes");
  const variableLengths: V2Dataset = { source: "BM25 parameter oracle", corpora: [{ id: "lengths", documents: [
    { id: "long", title: "", body: "alpha alpha alpha beta gamma delta epsilon zeta eta theta", tags: [], shopId: null },
    { id: "short", title: "", body: "alpha", tags: [], shopId: null },
  ], questions: [{ id: "alpha", query: "alpha", suite: "standard", shopId: null, relevant: ["short"] }] }] };
  const unpenalized = await runRetrievalV2({ ...options, dataset: variableLengths, modes: ["M1"], parameters: { bm25B: 0 } });
  const penalized = await runRetrievalV2({ ...options, dataset: variableLengths, modes: ["M1"], parameters: { bm25B: 1 } });
  assert.equal(unpenalized.report.results[0]!.ranking[0]!.id, "long");
  assert.equal(penalized.report.results[0]!.ranking[0]!.id, "short", "the runner passes BM25 normalization through to actual ranking");
  const saturated = await runRetrievalV2({ ...options, dataset: variableLengths, modes: ["M1"], parameters: { bm25B: 0, bm25K1: .1 } });
  assert.notEqual(saturated.report.results[0]!.ranking[0]!.score, unpenalized.report.results[0]!.ranking[0]!.score);
  const shortFusion = await runRetrievalV2({ ...options, dataset: narrowed, modes: ["M3"], parameters: { rrfWindow: 1, rrfK: 1 } });
  const longFusion = await runRetrievalV2({ ...options, dataset: narrowed, modes: ["M3"], parameters: { rrfWindow: 2, rrfK: 200 } });
  assert.deepEqual(shortFusion.report.results[0]!.ranking, [{ id: "A", score: 1 }]);
  assert.deepEqual(longFusion.report.results[0]!.ranking.map(row => row.id), ["A", "B"]);
  assert.equal(longFusion.report.results[0]!.ranking[0]!.score, 2 / 201, "the runner passes both RRF window and k to fusion");
  const boundaryDataset = structuredClone(dataset);
  boundaryDataset.corpora[0]!.questions = [{ ...boundaryQuestion, id: "same-scope-forbidden" }];
  const boundary = await runRetrievalV2({ ...options, dataset: boundaryDataset, modes: ["M4"] });
  assert.equal(boundary.report.results[0]!.scopePassed, true); assert.equal(boundary.report.results[0]!.boundaryPassed, false);
  assert.deepEqual(boundary.report.results[0]!.forbiddenMatches, ["B"]);
  assert.equal(boundary.report.summary.groups[0]!.scopeViolations, 0);
  assert.equal(boundary.report.summary.groups[0]!.boundaryFailures, 1);
  assert.equal(boundary.report.summary.groups[0]!.forbiddenHitCases, 1);
  const failing = createBailianClient({ env, retries: 0, fetch: fake(() => json({ message: "unavailable" }, 503)) });
  const failed = await runRetrievalV2({ ...options, client: failing, modes: ["M4"], cacheDir: join(directory, "failed-cache") });
  assert.equal(failed.report.status, "completed_with_errors");
  assert.ok(failed.report.results.every(row => row.status === "provider_error" && row.metrics === null && row.fallback?.mode === "M0"));
  assert.equal(failed.report.summary.groups.find(row => row.suite === "standard")!.plannedRecallAt5, 0);
  assert.equal(failed.report.summary.usage.find(row => row.operation === "rerank")!.completeTokens, null);
  const budget = await runRetrievalV2({ ...options, modes: ["M4"], maxRequests: 1, cacheDir: join(directory, "budget-cache") });
  assert.equal(budget.report.status, "budget_stopped"); assert.equal(budget.report.stopReason, "max_requests");
  assert.equal(budget.report.summary.plannedRows, 3); assert.equal(budget.report.summary.completedRows, 1); assert.equal(budget.report.summary.missingRows, 2);
  assert.equal(budget.report.summary.usage.find(row => row.operation === "rerank")!.requests, 1);
  const repeatedFailures = createBailianClient({ env, retries: 1, fetch: fake(() => json({}, 503)) });
  const stopped = await runRetrievalV2({ ...options, client: repeatedFailures, modes: ["M4"], consecutiveFailureLimit: 3, cacheDir: join(directory, "stop-cache") });
  assert.equal(stopped.report.status, "budget_stopped"); assert.equal(stopped.report.stopReason, "consecutive_provider_failures");
  assert.equal(stopped.report.summary.usage.find(row => row.operation === "rerank")!.requests, 3);
  const badKey = await runRetrievalV2({ ...options, client: denied, modes: ["M4"], cacheDir: join(directory, "auth-cache") });
  assert.equal(badKey.report.status, "budget_stopped"); assert.equal(badKey.report.stopReason, "provider_configuration");
  assert.equal(badKey.report.summary.usage.find(row => row.operation === "rerank")!.requests, 1);
  const multi = structuredClone(dataset); multi.corpora[0]!.documents.push({ id: "Z", title: "another", body: "other", tags: [], shopId: null });
  multi.corpora[0]!.questions[0]!.relevant = ["A", "Z"];
  const local = await runRetrievalV2({ ...options, dataset: multi, modes: ["M0", "M1"] });
  assert.equal(local.report.results[0]!.metrics?.recallAt5, .5); assert.equal(local.report.calls.length, 0);
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("retrieval-v2 mock checks passed: official endpoints, bounded requests, vectors/indexes, usage, cache, scope, fixed denominators and fallback separation; no external calls.");
