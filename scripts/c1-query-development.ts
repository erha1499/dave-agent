import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { contentHash, createBailianClient } from "../src/bailian.ts";
import { acceptEvidence } from "../src/evidence-acceptance.ts";
import { createEvidenceSupportClient, validateEvidenceSupportVerification } from "../src/evidence-support.ts";
import { gateKnowledgeApplicability, loadKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService, type KnowledgeQueryMode, type KnowledgeSearchResult } from "../src/knowledge-service.ts";
import { scopeDocuments, serializeRetrievalDocument } from "../src/retrieval-ranking.ts";
import { buildSupportEvidenceBinding } from "../src/support-evidence-context.ts";
import { parseContextSupportAction } from "../src/support-context-action.ts";
import { createC1ValidationGuard, c1ValidationCodeFiles, readC1ValidationDependencies, type C1ValidationSetup } from "./c1-session-validation-live.ts";
import type { C1ValidationPlan } from "./c1-session-validation-check.ts";

const root = new URL("../", import.meta.url);
const dataPath = "data/c1-query-development.json", manifestPath = "data/c1-query-development-manifest.json";
const planPath = "data/c1-session-validation.json";
const limits = { rerank: 38, support: 38, estimatedUsd: .25, estimatedCny: .10, deadlineMs: 10 * 60_000, timeoutMs: 60_000 };
type Item = { caseId: string; turn: number; corpus: "online" | "reference"; status: "ready" | "source_missing";
  scope: { shopId: string | null; productId: string | null }; builderInput: Parameters<typeof buildSupportEvidenceBinding>[0] | null };
type Dataset = { version: number; sourceRunId: string; rawSha256: string; planSha256: string; cases: Item[]; corpora: C1ValidationSetup["corpora"] };
type Row = { caseId: string; turn: number; mode: KnowledgeQueryMode; execution: "not_run" | "source_missing" | "completed" | "failed";
  result?: KnowledgeSearchResult; proofPassed?: boolean };
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const hashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));

async function loadInputs() {
  const dataset = await json(dataPath) as Dataset, plan = await json(planPath) as C1ValidationPlan;
  assert.equal(dataset.version, 1); assert.equal(dataset.planSha256, contentHash(plan));
  const expected = plan.cases.flatMap(item => item.turns.flatMap((turn, index) => turn.expected.knowledge === "none" ? [] : [`${item.id}/${index + 1}`]));
  assert.deepEqual(dataset.cases.map(item => `${item.caseId}/${item.turn}`), expected, "Keep every planned knowledge target, including absent historical calls");
  assert.equal(dataset.cases.length, 20); assert.equal(dataset.cases.filter(item => item.status === "ready").length, 19);
  for (const item of dataset.cases) {
    const scenario = plan.cases.find(row => row.id === item.caseId)!, turn = scenario.turns[item.turn - 1]!;
    assert.equal(item.corpus, scenario.corpus); assert.deepEqual(item.scope, turn.expected.scope);
    if (item.status === "source_missing") { assert.equal(item.builderInput ?? null, null); continue; }
    const input = item.builderInput!;
    assert.equal(input.originalQuery, turn.question); assert.deepEqual(parseContextSupportAction(input.action), input.action);
    assert.deepEqual(input.order ?? null, turn.expected.freshOrder);
    const binding = buildSupportEvidenceBinding(input);
    assert.ok(binding.effectiveQuery.length <= 500 && binding.retrievalQuery.length <= 500);
    for (const gold of turn.expected.gold) assert.ok(dataset.corpora[item.corpus].find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote));
  }
  return { dataset, plan };
}

export function summarizeQueryComparison(plan: C1ValidationPlan, rows: Row[]) {
  return Object.fromEntries((["combined", "separated"] as const).map(mode => {
    const group = rows.filter(row => row.mode === mode), known = group.filter(row => plan.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!.expected.knowledge === "evidence");
    const gold = (row: Row) => plan.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!.expected.gold.map(value => value.sourceId);
    const accepted = (row: Row) => row.result?.documents.map(doc => doc.sourceId) ?? [];
    const valid = (row: Row) => row.execution === "completed" && row.proofPassed === true && row.result?.trace.status !== "unavailable";
    const exact = (row: Row) => valid(row) && contentHash([...accepted(row)].sort()) === contentHash([...gold(row)].sort());
    const duration = group.flatMap(row => row.result ? [row.result.trace.durationMs] : []).sort((a, b) => a - b);
    return [mode, { planned: group.length, completed: group.filter(valid).length, sourceMissing: group.filter(row => row.execution === "source_missing").length,
      failedOrNotRun: group.filter(row => row.execution !== "source_missing" && !valid(row)).length,
      exactEvidenceSet: group.filter(exact).length, known: known.length,
      rawGoldAt5: known.filter(row => row.result?.trace.calls.some(call => call.operation === "rerank" && call.status === "ok")
        && gold(row).every(id => row.result!.trace.rawRanking.slice(0, 5).some(doc => doc.id === id))).length,
      acceptedGold: known.filter(row => valid(row) && gold(row).every(id => accepted(row).includes(id))).length,
      extraEvidence: group.filter(row => accepted(row).some(id => !gold(row).includes(id))).length,
      noAnswer: group.length - known.length, noAnswerRejected: group.filter(row => !gold(row).length && exact(row)).length,
      noAnswerFalseAccepted: group.filter(row => !gold(row).length && accepted(row).length > 0).length,
      invalidSupportDecisions: group.reduce((sum, row) => sum + (row.result?.trace.supportVerification?.validation?.invalidDecisions.length ?? 0), 0),
      p50Ms: duration[Math.ceil(duration.length * .5) - 1] ?? null, p95Ms: duration[Math.ceil(duration.length * .95) - 1] ?? null }];
  }));
}

async function clients(guard?: ReturnType<typeof createC1ValidationGuard>) {
  const runtime = await createConfiguredModelRuntime({ ...process.env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-v4-pro" });
  const fetchFor = (operation: "rerank" | "support"): typeof fetch => async (url, init) => {
    assert.ok(guard); const usage = guard.usage();
    if (usage[operation].requests >= limits[operation] || usage.support.knownEstimatedCost >= limits.estimatedUsd
      || usage.rerank.knownEstimatedCost >= limits.estimatedCny) throw new Error("Query comparison budget exhausted");
    return guard.fetchFor(operation)(url, init);
  };
  const rerank = createBailianClient({ timeoutMs: limits.timeoutMs, retries: 0, ...(guard ? { fetch: fetchFor("rerank") } : {}) });
  const support = await createEvidenceSupportClient({ timeoutMs: limits.timeoutMs, profile: "typed", modelSelection: "deepseek-v4-pro",
    runtime: { model: runtime.model, complete: (context, options) => runtime.modelRuntime.complete(runtime.model, context,
      { ...options, ...(guard ? { fetch: fetchFor("support") } : {}) }) } });
  return { rerank, support };
}

async function snapshot() {
  await loadInputs();
  const providers = await clients(), applicability = await loadKnowledgeApplicabilitySnapshot();
  const files = [...new Set([...(await c1ValidationCodeFiles()), "scripts/c1-query-development.ts", dataPath, planPath, "data/knowledge-applicability.json"])].sort();
  return { version: 1, stage: "exposed-development-fixed-input-provider-ablation", limits,
    parameters: { modes: ["combined", "separated"], support: "typed", model: "deepseek-v4-pro", threshold: .5, applicability: "declared", retries: 0 },
    sourceHashes: await hashes(files), dependencies: await readC1ValidationDependencies(),
    providers: { rerank: providers.rerank.settings, support: providers.support.settings }, applicabilityHash: applicability.sha256 };
}

async function run() {
  const frozen = await json(manifestPath), before = await snapshot(); assert.deepEqual(before, frozen, "Freeze exact code, inputs, settings and dependencies before HTTP");
  const { dataset, plan } = await loadInputs(), applicabilitySnapshot = await loadKnowledgeApplicabilitySnapshot();
  const guard = createC1ValidationGuard(), providers = await clients(guard), deadline = AbortSignal.timeout(limits.deadlineMs), runId = randomUUID();
  const rows: Row[] = dataset.cases.flatMap(item => (["combined", "separated"] as const).map(mode => ({ caseId: item.caseId, turn: item.turn, mode,
    execution: item.status === "source_missing" ? "source_missing" : "not_run" })));
  const artifact = { version: 1, runId, stage: before.stage, startedAt: new Date().toISOString(), finishedAt: null as string | null,
    scope: "Fixed synthetic inputs and production knowledge service; real rerank/support; no Agent, SQL, QQ, reply or business authorization validation.",
    manifest: frozen, rows, requests: guard.requests, usage: guard.usage(), summary: summarizeQueryComparison(plan, rows), codeStable: false, integrityPassed: false };
  const dir = new URL(".runtime/c1-query-development/", root); await mkdir(dir, { recursive: true });
  const output = new URL(`${runId}.json`, dir);
  const save = async () => { artifact.usage = guard.usage(); artifact.summary = summarizeQueryComparison(plan, rows); await writeFile(output, JSON.stringify(artifact, null, 2) + "\n"); };
  await save();
  try {
    for (const [index, item] of dataset.cases.entries()) {
      if (item.status === "source_missing") continue;
      const input = item.builderInput!, binding = buildSupportEvidenceBinding(input);
      const documents = dataset.corpora[item.corpus], scoped = scopeDocuments(documents, item.scope);
      // Alternate first position; both variants always issue new requests, including unchanged rule-only controls.
      const modes: KnowledgeQueryMode[] = index % 2 ? ["separated", "combined"] : ["combined", "separated"];
      for (const mode of modes) {
        if (deadline.aborted || guard.stopped()) break;
        const row = rows.find(row => row.caseId === item.caseId && row.turn === item.turn && row.mode === mode)!;
        const start = guard.requests.length;
        guard.setActive({ caseId: `${item.caseId}:${mode}`, turn: item.turn, requestId: `${runId}:${item.caseId}:${item.turn}:${mode}`, signal: deadline });
        const service = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(documents) }, { mode: "m4-support", queryMode: mode,
          timeoutMs: limits.timeoutMs, threshold: .5, supportProfile: "typed", supportModel: "deepseek-v4-pro", applicability: "declared", applicabilitySnapshot, clients: providers });
        row.result = await service.search({ query: binding.effectiveQuery, retrievalQuery: binding.retrievalQuery, originalQuery: input.originalQuery,
          scope: item.scope, applicabilityContext: binding.applicability, signal: deadline });
        const trace = row.result.trace;
        for (const operation of ["rerank", "support"] as const) {
          const sent = guard.requests.map((request, i) => ({ request, i })).filter(value => value.i >= start && value.request.operation === operation);
          const attempts = trace.calls.filter(call => call.operation === operation).flatMap<{ totalTokens: number | null; costUsd?: number | null }>(call => call.attempts);
          if (sent.length === attempts.length) attempts.forEach((attempt, i) => guard.record(sent[i]!.i, attempt.totalTokens,
            operation === "support" ? attempt.costUsd ?? null : trace.pricing.rerankCnyPerMillionTokens !== null && attempt.totalTokens !== null
              ? attempt.totalTokens * trace.pricing.rerankCnyPerMillionTokens / 1_000_000 : null));
        }
        try {
          const retrieval = mode === "combined" ? binding.effectiveQuery : binding.retrievalQuery;
          assert.deepEqual(trace.queries, { version: "knowledge-query-plan-v1", mode, retrieval, evidence: binding.effectiveQuery });
          assert.equal(trace.query, retrieval); assert.deepEqual(trace.scope, item.scope);
          assert.equal(trace.sourceHashes.before, contentHash(scoped)); assert.equal(trace.sourceHashes.after, contentHash(scoped));
          assert.equal(trace.calls.find(call => call.operation === "rerank")?.requestHash, contentHash({ endpoint: providers.rerank.settings.endpoints.rerank,
            body: { model: providers.rerank.settings.rerankModel, query: retrieval, documents: scoped.map(serializeRetrievalDocument), top_n: scoped.length, instruct: providers.rerank.settings.rerankInstruction } }));
          const prepared = acceptEvidence({ config: { mode: "support", threshold: .5 }, query: retrieval, documents, scope: item.scope, ranking: trace.rawRanking });
          const gated = gateKnowledgeApplicability({ snapshot: applicabilitySnapshot, context: binding.applicability ?? null, scope: item.scope, candidates: prepared.pendingSupport ?? [] });
          assert.equal(gated.integrity, true);
          if (gated.candidates.length) {
            assert.ok(validateEvidenceSupportVerification(trace.supportVerification,
              { query: binding.effectiveQuery, scope: item.scope, candidates: gated.candidates, settings: providers.support.settings }));
            assert.equal(trace.supportVerification!.validation!.status, "complete", "Partial/invalid decisions remain visible but cannot satisfy the strict comparison gate");
          }
          row.proofPassed = true;
        } catch { row.proofPassed = false; }
        row.execution = trace.status === "unavailable" || !row.proofPassed ? "failed" : "completed";
        await save(); console.log(`${item.caseId}/${item.turn} ${mode}: ${row.execution}; ${row.result.documents.map(doc => doc.sourceId).join(",") || "none"}`);
      }
    }
  } finally {
    guard.seal(); artifact.finishedAt = new Date().toISOString();
    artifact.codeStable = contentHash(await snapshot()) === contentHash(before);
    artifact.integrityPassed = artifact.codeStable && rows.every(row => row.execution === "completed" || row.execution === "source_missing")
      && guard.requests.every(request => request.usageRecorded && request.estimatedCost !== null) && guard.usage().agent.requests === 0;
    await save(); console.log(JSON.stringify({ runId, integrityPassed: artifact.integrityPassed, summary: artifact.summary, usage: artifact.usage }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "--check") {
    const { plan } = await loadInputs();
    const missing: Row = { caseId: "c1-session-fixed-021", turn: 1, mode: "combined", execution: "source_missing" };
    let summary = summarizeQueryComparison(plan, [missing]).combined!;
    assert.equal(summary.planned, 1); assert.equal(summary.sourceMissing, 1); assert.equal(summary.exactEvidenceSet, 0);
    assert.equal(summary.noAnswerRejected, 0); assert.equal(summary.p50Ms, null);
    const failed: Row = { caseId: "c1-session-fixed-001", turn: 2, mode: "combined", execution: "failed", proofPassed: false,
      result: { documents: [], trace: { status: "unavailable", durationMs: 1, rawRanking: [{ id: "KB-REFUND-PAYMENT", score: .9 }],
        calls: [{ operation: "rerank", status: "ok" }] } } as unknown as KnowledgeSearchResult };
    summary = summarizeQueryComparison(plan, [failed]).combined!;
    assert.equal(summary.rawGoldAt5, 1); assert.equal(summary.acceptedGold, 0); assert.equal(summary.exactEvidenceSet, 0); assert.equal(summary.failedOrNotRun, 1);
    console.log("Fixed inputs and summary boundaries passed; missing/failed are not successes; HTTP=0");
  }
  else if (mode === "--freeze") { await writeFile(new URL(manifestPath, root), JSON.stringify(await snapshot(), null, 2) + "\n", { flag: "wx" }); console.log("Frozen without HTTP"); }
  else if (mode === "--inspect") { assert.deepEqual(await snapshot(), await json(manifestPath)); console.log("Frozen code/input/settings/dependencies match; HTTP=0"); }
  else if (mode === "--live") await run();
  else throw new Error("Use --check, --freeze, --inspect or --live. Live requires a matching frozen manifest.");
}
