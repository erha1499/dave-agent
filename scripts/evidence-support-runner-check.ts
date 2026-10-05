import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBailianClient, contentHash } from "../src/bailian.ts";
import { createEvidenceSupportClient, type EvidenceSupportClient } from "../src/evidence-support.ts";
import { runRetrievalV2, type V2Dataset } from "./retrieval-v2.ts";
import { scoreAcceptance } from "./acceptance-calibrate.ts";
import { evaluateRecordedAcceptance } from "./acceptance-report.ts";

const dataset: V2Dataset = { source: { note: "PRIVATE_GOLD_MARKER; deterministic transport check, not a quality evaluation" }, corpora: [{
  id: "synthetic", documents: [
    { id: "hours", title: "午餐时间", body: "午餐十一点至十四点。", tags: ["午餐"], shopId: null },
    { id: "refund", title: "退款", body: "退款需要模拟商家审核。", tags: ["退款"], shopId: null },
  ], questions: [
    { id: "positive", query: "午餐时间是什么？", shopId: null, suite: "standard", relevant: ["hours"], expectedBehavior: "answer" },
    { id: "negative", query: "套餐钠含量是多少？", shopId: null, suite: "no_answer", relevant: [], expectedBehavior: "abstain" },
  ],
}] };
const oneQuestion = () => { const copy = structuredClone(dataset); copy.corpora[0]!.questions.splice(1); return copy; };
let rerankRequests = 0;
const client = createBailianClient({ env: { DASHSCOPE_API_KEY: "mock-secret", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
  timeoutMs: 1000, retries: 0, fetch: async (_url, init) => {
    rerankRequests++;
    const body = JSON.parse(String(init?.body));
    const results = body.documents.map((document: string, index: number) => ({ index,
      relevance_score: JSON.parse(document).title === "午餐时间" ? .95 : .85 })).sort((a: { relevance_score: number }, b: { relevance_score: number }) => b.relevance_score - a.relevance_score);
    return new Response(JSON.stringify({ results, usage: { total_tokens: 10 } }));
  } });
let supportRequests = 0;
async function supportClient(model = "mock-support", malformed = false): Promise<EvidenceSupportClient> {
  const base = await createEvidenceSupportClient({ timeoutMs: 1000, runtime: {
    model: { provider: "deepseek", id: model, api: "openai-completions", baseUrl: "https://api.deepseek.com", maxTokens: 2048,
      cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } },
    complete: async (context, options) => {
      supportRequests++;
      assert.deepEqual(context.tools, []); assert.equal(context.messages.length, 1); assert.equal(options.maxRetries, 0);
      const payload = JSON.parse(String(context.messages[0]!.content));
      assert.deepEqual(Object.keys(payload), ["query", "documents"]);
      assert.ok(!JSON.stringify(context).includes("PRIVATE_GOLD_MARKER"), "gold/source metadata never enter verifier context");
      for (const doc of payload.documents) assert.deepEqual(Object.keys(doc), ["id", "title", "tags", "body"]);
      const decisions = payload.documents.map((doc: { id: string; body: string }) => {
        const supported = payload.query.includes("午餐") && doc.id === "hours";
        return { id: doc.id, supported, quote: supported ? doc.body : null, reason: supported ? "原文直接说明时段" : "原文没有所问事实" };
      });
      return { role: "assistant", api: "openai-completions", provider: "deepseek", model,
        content: [{ type: "text", text: malformed ? "not JSON" : JSON.stringify({ decisions }) }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: .000001, output: .000001, cacheRead: 0, cacheWrite: 0, total: .000002 } },
        stopReason: "stop", timestamp: 0 };
    },
  } });
  return { settings: base.settings, verify: async (query, candidates) => {
    assert.equal(typeof query, "string");
    for (const candidate of candidates) {
      assert.ok(Object.keys(candidate).every(key => ["id", "title", "tags", "body", "shopId", "productId", "status", "score", "rank"].includes(key)),
        "verify receives original candidate facts, never relevant/forbidden labels, expected behavior or rationale");
    }
    return base.verify(query, candidates);
  } };
}
const directory = await mkdtemp(join(tmpdir(), "dave-support-runner-"));
const judge = await supportClient();
const options = { label: "support pipeline mock", modes: ["M4"] as Array<"M4">, dataset, client, supportClient: judge, allowRemote: true,
  outputDir: join(directory, "out"), cacheDir: join(directory, "cache"), parameters: { timeoutMs: 1000, retries: 0, maxRequests: 20 } };
const acceptance = { mode: "support" as const, threshold: .71 };
const supportUsage = (report: Awaited<ReturnType<typeof runRetrievalV2>>["report"]) => report.summary.usage.find(row => row.operation === "support");
const contents = async (path: string) => Object.fromEntries(await Promise.all((await readdir(path)).sort().map(async name => [name, await readFile(join(path, name), "utf8")])));
try {
  const baseline = await runRetrievalV2({ ...options, acceptance: { mode: "score", threshold: .71 } });
  assert.equal(rerankRequests, 2); assert.equal(supportRequests, 0);
  const supported = await runRetrievalV2({ ...options, acceptance });
  assert.equal(rerankRequests, 2); assert.equal(supportRequests, 2, "one support request per measured query, shared raw cache reused");
  assert.equal(supported.report.status, "completed");
  assert.deepEqual(supported.report.results.map(row => [row.ranking, row.metrics]), baseline.report.results.map(row => [row.ranking, row.metrics]), "second stage preserves raw rank and metrics");
  assert.deepEqual(supported.report.results.map(row => row.acceptance.accepted.map(doc => doc.id)), [["hours"], []]);
  assert.ok(supported.report.results.every(row => row.supportVerification?.attempts.length === 1));
  assert.equal(supportUsage(supported.report)!.requests, 2); assert.equal(supportUsage(supported.report)!.knownTokens, 30);
  const measured = evaluateRecordedAcceptance(supported.report);
  assert.equal(measured.totals.acceptedRecallAt5, 1); assert.equal(measured.totals.falseAccepts, 0); assert.equal(measured.meetsApplicableTargets, true);
  assert.equal(evaluateRecordedAcceptance(baseline.report).totals.falseAccepts, 1, "same raw high score remains unsafe without actual support decisions");
  assert.throws(() => scoreAcceptance(supported.report, acceptance), /实际判别/);
  const duplicate = structuredClone(supported.report); duplicate.results.push(duplicate.results[0]!);
  assert.throws(() => evaluateRecordedAcceptance(duplicate), /重复/);
  const missing = structuredClone(supported.report); missing.results.pop();
  assert.equal(evaluateRecordedAcceptance(missing).totals.incomplete, 1);
  assert.equal(evaluateRecordedAcceptance(missing).meetsApplicableTargets, false);
  const notCompleted = structuredClone(supported.report); notCompleted.status = "failed";
  assert.equal(evaluateRecordedAcceptance(notCompleted).meetsApplicableTargets, false);
  const noProof = structuredClone(supported.report); delete noProof.results[0]!.supportVerification;
  assert.throws(() => evaluateRecordedAcceptance(noProof), /绑定/);
  const staleProof = structuredClone(supported.report); staleProof.results[0]!.supportVerification!.inputHash = contentHash("another question");
  assert.throws(() => evaluateRecordedAcceptance(staleProof), /绑定/);
  const changedPolicy = structuredClone(supported.report); changedPolicy.results[0]!.acceptance.config = { mode: "score", threshold: .71 };
  assert.throws(() => evaluateRecordedAcceptance(changedPolicy), /策略/);
  const fakeBody = structuredClone(supported.report); fakeBody.results[0]!.acceptance.accepted[0]!.body = "fabricated accepted evidence";
  assert.throws(() => evaluateRecordedAcceptance(fakeBody), /原文/);
  for (const mutate of [
    (report: typeof supported.report) => { report.snapshot.settings.provider = null; },
    (report: typeof supported.report) => { Object.assign(report.snapshot.settings.provider!, { rerankModel: "another-model" }); },
    (report: typeof supported.report) => { report.snapshot.settings.provider!.rerankInstruction = "different instruction"; },
    (report: typeof supported.report) => { Object.assign(report.snapshot.settings.acceptance, { model: "another-model" }); },
    (report: typeof supported.report) => { Object.assign(report.snapshot.settings.acceptance, { serialization: "different-serialization" }); },
    (report: typeof supported.report) => { report.snapshot.settings.acceptance.version = "score-gate-v1"; },
    (report: typeof supported.report) => { Object.assign(report.snapshot.settings.acceptance, { corpusHashes: null }); },
    (report: typeof supported.report) => { report.snapshot.settings.acceptance.corpusHashes = {}; },
    (report: typeof supported.report) => { report.snapshot.settings.acceptance.corpusHashes.synthetic = contentHash("stale corpus"); },
    (report: typeof supported.report) => { report.snapshot.settings.acceptance.corpusHashes.extra = contentHash([]); },
    (report: typeof supported.report) => {
      report.snapshot.dataset.corpora[0]!.documents[0]!.body += " changed after run";
      report.snapshot.datasetHash = contentHash(report.snapshot.dataset);
    },
  ]) {
    const unbound = structuredClone(supported.report); mutate(unbound);
    assert.throws(() => evaluateRecordedAcceptance(unbound), /绑定/, "provider, policy and corpus bindings must be checked independently of decision proofs");
  }
  const wrongScoreVersion = structuredClone(baseline.report); wrongScoreVersion.snapshot.settings.acceptance.version = "score-support-v1";
  assert.throws(() => evaluateRecordedAcceptance(wrongScoreVersion), /策略版本/);

  const warm = await runRetrievalV2({ ...options, acceptance });
  assert.equal(rerankRequests, 2); assert.equal(supportRequests, 2);
  assert.equal(supportUsage(warm.report)!.requests, 0); assert.equal(supportUsage(warm.report)!.cacheHits, 2);
  assert.equal(supportUsage(warm.report)!.knownTokens, null);
  const warmUsage = supportUsage(warm.report)!;
  assert.equal("knownEstimatedCostUsd" in warmUsage && warmUsage.knownEstimatedCostUsd, null);
  assert.ok(warm.report.results.every(row => row.supportVerification?.attempts.length === 0));
  assert.deepEqual(warm.report.results.map(row => row.acceptance), supported.report.results.map(row => row.acceptance));
  assert.equal(evaluateRecordedAcceptance(warm.report).meetsApplicableTargets, true, "validated cache provenance survives application");

  const beforeQuery = supportRequests, changedQuery = oneQuestion(); changedQuery.corpora[0]!.questions[0]!.query = "午餐具体几点开始？";
  const queryRun = await runRetrievalV2({ ...options, dataset: changedQuery, acceptance });
  assert.equal(supportRequests, beforeQuery + 1); assert.notEqual(queryRun.report.supportCalls[0]!.inputHash, supported.report.supportCalls[0]!.inputHash);
  const beforeBody = supportRequests, changedBody = oneQuestion(); changedBody.corpora[0]!.documents[0]!.body += "普通周末相同。";
  const bodyRun = await runRetrievalV2({ ...options, dataset: changedBody, acceptance });
  assert.equal(supportRequests, beforeBody + 1); assert.notEqual(bodyRun.report.supportCalls[0]!.inputHash, supported.report.supportCalls[0]!.inputHash);
  const beforeSettings = supportRequests;
  const modelRun = await runRetrievalV2({ ...options, dataset: oneQuestion(), supportClient: await supportClient("mock-support-v2"), acceptance });
  assert.equal(supportRequests, beforeSettings + 1); assert.notEqual(modelRun.report.supportCalls[0]!.inputHash, supported.report.supportCalls[0]!.inputHash);
  const previousCache = await contents(options.cacheDir), beforeRefresh = [rerankRequests, supportRequests];
  await runRetrievalV2({ ...options, acceptance, parameters: { ...options.parameters, cache: "refresh" } });
  assert.deepEqual([rerankRequests, supportRequests], [beforeRefresh[0]! + 2, beforeRefresh[1]! + 2]);
  assert.deepEqual(await contents(options.cacheDir), previousCache, "refresh neither reads nor changes the persisted reuse cache");

  const noCandidate: V2Dataset = { source: "synthetic empty scope", corpora: [{ id: "empty", documents: [
    { id: "private", title: "门店政策", body: "只有其他门店可见。", tags: [], shopId: "another-shop" },
  ], questions: [{ id: "no-visible", query: "这里的政策是什么？", suite: "no_answer", shopId: null, relevant: [] }] }] };
  const beforeEmpty = [rerankRequests, supportRequests];
  const empty = await runRetrievalV2({ ...options, dataset: noCandidate, acceptance });
  assert.deepEqual([rerankRequests, supportRequests], beforeEmpty); assert.equal(empty.report.supportCalls.length, 0);
  assert.equal(empty.report.results[0]!.acceptance.status, "rejected");
  const belowScore = await runRetrievalV2({ ...options, dataset: oneQuestion(), acceptance: { mode: "support", threshold: 1 } });
  assert.equal(supportRequests, beforeEmpty[1]); assert.equal(belowScore.report.results[0]!.acceptance.accepted.length, 0);

  const broken = await runRetrievalV2({ ...options, dataset: oneQuestion(), supportClient: await supportClient("invalid-support", true), acceptance });
  const brokenRow = broken.report.results[0]!, brokenGroup = broken.report.summary.groups[0]!;
  assert.equal(broken.report.status, "completed_with_errors"); assert.equal(brokenRow.status, "ok");
  assert.equal(brokenRow.metrics!.recallAt5, 1); assert.equal(brokenRow.acceptedMetrics, null);
  assert.equal(brokenRow.acceptance.status, "unavailable"); assert.equal(brokenRow.falseRejectEligible, null);
  assert.equal(brokenGroup.acceptance.failed, 1); assert.equal(brokenGroup.acceptance.measured, 0);
  assert.equal(brokenGroup.acceptance.plannedRecallAt5, 0); assert.equal(brokenGroup.acceptance.answerableFalseRejectDenominator, 0);
  assert.equal(supportUsage(broken.report)!.requests, 1); assert.equal(supportUsage(broken.report)!.knownTokens, 15, "invalid JSON can still incur usage");
  assert.equal(evaluateRecordedAcceptance(broken.report).meetsApplicableTargets, false);

  const repeatedFailures = structuredClone(dataset);
  repeatedFailures.corpora[0]!.questions = Array.from({ length: 4 }, (_, index) => ({
    ...structuredClone(dataset.corpora[0]!.questions[index % 2]!), id: `failure-${index}`, query: `${dataset.corpora[0]!.questions[index % 2]!.query} 第${index}次`,
  }));
  const beforeFailureGate: [number, number] = [rerankRequests, supportRequests];
  const stoppedFailures = await runRetrievalV2({ ...options, dataset: repeatedFailures, acceptance,
    supportClient: await supportClient("repeated-invalid", true), cacheDir: join(directory, "failure-gate"),
    parameters: { ...options.parameters, cache: "refresh", maxRequests: 100, consecutiveFailureLimit: 2 } });
  assert.equal(stoppedFailures.report.status, "budget_stopped"); assert.equal(stoppedFailures.report.stopReason, "consecutive_support_failures");
  assert.deepEqual([rerankRequests - beforeFailureGate[0], supportRequests - beforeFailureGate[1]], [2, 2],
    "successful intervening rerank must not reset the failing support provider's circuit breaker");
  assert.equal(stoppedFailures.report.summary.missingRows, 2); assert.equal(supportUsage(stoppedFailures.report)!.requests, 2);
  const failedNegative = stoppedFailures.report.summary.groups.find(group => group.suite === "no_answer")!;
  assert.equal(failedNegative.acceptance.failed, 1); assert.equal(failedNegative.acceptance.noAnswerPlanned, 2);
  assert.equal(failedNegative.acceptance.noAnswerDenominator, 0); assert.equal(failedNegative.acceptance.noAnswerFalseAcceptRate, null,
    "failed support decisions are not successful rejections on unknown-policy questions");
  assert.equal(evaluateRecordedAcceptance(stoppedFailures.report).meetsApplicableTargets, false);

  for (const budget of [1, 3]) {
    const beforeBudget: [number, number] = [rerankRequests, supportRequests];
    const stopped = await runRetrievalV2({ ...options, cacheDir: join(directory, `budget-${budget}`), acceptance,
      parameters: { ...options.parameters, maxRequests: budget } });
    assert.equal(stopped.report.status, "budget_stopped"); assert.equal(stopped.report.stopReason, "max_requests");
    assert.equal(rerankRequests - beforeBudget[0] + supportRequests - beforeBudget[1], budget, "raw rerank and support share one actual request budget");
    assert.equal(supportRequests - beforeBudget[1], budget === 1 ? 0 : 1);
    const last = stopped.report.results.at(-1)!;
    assert.ok(last.ranking.length > 0, "budget exhausted before support still preserves completed raw retrieval");
    assert.equal(last.status, "ok"); assert.equal(last.acceptance.status, "unavailable"); assert.equal(last.acceptedMetrics, null);
    assert.equal(stopped.report.summary.missingRows, budget === 1 ? 1 : 0);
    assert.equal(evaluateRecordedAcceptance(stopped.report).meetsApplicableTargets, false);
  }
  const withContext = structuredClone(dataset);
  withContext.corpora[0]!.questions.push({ id: "deferred", query: "它呢？", suite: "context", shopId: null,
    relevant: [], expectedBehavior: "clarify", deferredReason: "C1 context is deferred" });
  const contextual = await runRetrievalV2({ ...options, dataset: withContext, acceptance });
  const contextualScore = evaluateRecordedAcceptance(contextual.report);
  assert.equal(contextualScore.totals.deferred, 1); assert.equal(contextualScore.totals.incomplete, 0);
  assert.equal(contextualScore.meetsApplicableTargets, true);
  const missingDeferred = structuredClone(contextual.report); missingDeferred.results = missingDeferred.results.filter(row => row.id !== "deferred");
  assert.equal(evaluateRecordedAcceptance(missingDeferred).totals.incomplete, 1);
  assert.equal(evaluateRecordedAcceptance(missingDeferred).totals.deferred, 0);
  assert.equal(evaluateRecordedAcceptance(missingDeferred).meetsApplicableTargets, false, "a missing deferred row is incomplete, not an implicit valid deferral");
  const deferredRow = contextual.report.results.find(row => row.id === "deferred")!;
  for (const mutate of [
    (row: typeof deferredRow) => { row.status = "ok"; },
    (row: typeof deferredRow) => { row.acceptance.status = "rejected"; },
    (row: typeof deferredRow) => { row.acceptance.accepted.push(structuredClone(supported.report.results[0]!.acceptance.accepted[0]!)); },
    (row: typeof deferredRow) => { row.callIds.push("unexpected-call"); },
    (row: typeof deferredRow) => { row.deferredReason = "different reason"; },
  ]) {
    const invalidDeferred = structuredClone(contextual.report); mutate(invalidDeferred.results.find(row => row.id === "deferred")!);
    assert.throws(() => evaluateRecordedAcceptance(invalidDeferred), /延期结果/);
  }
  const deferredOnly = structuredClone(withContext); deferredOnly.corpora[0]!.questions = [withContext.corpora[0]!.questions.at(-1)!];
  const beforeDeferred: [number, number] = [rerankRequests, supportRequests];
  const allDeferred = await runRetrievalV2({ ...options, dataset: deferredOnly, acceptance });
  assert.deepEqual([rerankRequests, supportRequests], beforeDeferred);
  assert.equal(allDeferred.report.snapshot.settings.provider, null);
  assert.equal(evaluateRecordedAcceptance(allDeferred.report).totals.deferred, 1);
  assert.equal(evaluateRecordedAcceptance(allDeferred.report).meetsApplicableTargets, false);
  const saved = await readFile(supported.path, "utf8"); assert.ok(!saved.includes("mock-secret"));
  const cacheFile = join(options.cacheDir, `support-${supported.report.supportCalls[0]!.inputHash}.json`);
  const corrupt = JSON.parse(await readFile(cacheFile, "utf8")); corrupt.requestHash = contentHash("different query or model");
  await writeFile(cacheFile, JSON.stringify(corrupt));
  const beforeCorrupt = supportRequests;
  await assert.rejects(runRetrievalV2({ ...options, dataset: oneQuestion(), acceptance }), /执行中断/);
  assert.equal(supportRequests, beforeCorrupt, "invalid cached provenance fails closed without unbudgeted automatic retry");
  console.log("PASS support runner: preserved raw results, actual support decisions, label isolation, scoped empty path, failed/partial denominators, combined budgets, query/body/settings cache isolation, frozen snapshot bindings and explicit deferrals; mock transport only.");
} finally { await rm(directory, { recursive: true, force: true }); }
