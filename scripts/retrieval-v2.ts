import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BailianBudgetStop, BailianError, contentHash, createBailianClient, validVector, type BailianAttempt, type BailianClient } from "../src/bailian.ts";
import { scopeDocuments, rankLexical, rankBm25, rankDense, reciprocalRankFusion, serializeRetrievalDocument, resolveRetrievalParameters,
  type RetrievalExperimentParameters, type RetrievalDocument, type RetrievalScope, type RankedDocument } from "../src/retrieval-ranking.ts";
import { acceptEvidence, evidenceAcceptanceBinding, evidenceAcceptanceVersion, resolveEvidenceAcceptance, type EvidenceAcceptanceConfig, type EvidenceAcceptanceResult } from "../src/evidence-acceptance.ts";
import { createEvidenceSupportClient, verifyEvidenceSupport, validateEvidenceSupportVerification, evidenceSupportInputHash, applyEvidenceSupport, EvidenceSupportError,
  type EvidenceSupportClient, type EvidenceSupportAttempt, type EvidenceSupportCandidate, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import { loadRetrievalData } from "./retrieval-data.ts";

export const retrievalModes = ["M0", "M1", "M2", "M3", "M4", "M5", "M6"] as const;
export type RetrievalMode = typeof retrievalModes[number];
export type V2Question = { id: string; query: string; suite: "standard" | "hard" | "scope" | "no_answer" | "context"; shopId: string | null;
  productId?: string | null; deferredReason?: string; expectedBehavior?: "answer" | "abstain" | "clarify"; relevant: string[]; forbidden?: string[]; required?: string[] };
export type V2Corpus = { id: string; documents: RetrievalDocument[]; questions: V2Question[] };
export type V2Dataset = { source: unknown; corpora: V2Corpus[] };
type Call = { id: string; operation: "embedding" | "rerank"; purpose: "document" | "query" | "ranking"; cache: "hit" | "miss";
  inputHash: string; requestHash: string | null; attempts: BailianAttempt[]; status: "ok" | "failed" };
export type SupportCall = { id: string; operation: "support"; cache: "hit" | "miss"; inputHash: string;
  requestHash: string | null; attempts: EvidenceSupportAttempt[]; status: "ok" | "failed" };
type Metrics = { recallAt1: number; recallAt5: number; mrrAt5: number; mrrRecordedRanking: number; candidateRecall: number };
export type V2Result = { corpus: string; id: string; suite: V2Question["suite"]; mode: RetrievalMode; query: string; scope: RetrievalScope;
  status: "ok" | "provider_error" | "not_applicable"; candidateIds: string[]; candidateHash: string; ranking: Array<{ id: string; score: number | null }>;
  supportVerification?: EvidenceSupportVerification; relevant: string[]; metrics: Metrics | null; acceptance: EvidenceAcceptanceResult; acceptedMetrics: Metrics | null;
  acceptedScopePassed: boolean; acceptedBoundaryPassed: boolean; expectedAbstention: boolean; falseRejectEligible: boolean | null; falseRejected: boolean | null; deferredReason: string | null; scopePassed: boolean; boundaryPassed: boolean; forbiddenMatches: string[]; requiredPassed: boolean; empty: boolean | null; durationMs: number; callIds: string[];
  fallback: { mode: "M0"; ranking: string[]; metrics: Metrics | null } | null; error: string | null };
const root = fileURLToPath(new URL("../", import.meta.url));
const modesNeedingDense = new Set<RetrievalMode>(["M2", "M3", "M6"]);
const remoteMode = (mode: RetrievalMode) => mode !== "M0" && mode !== "M1";

function metrics(relevant: readonly string[], ranked: readonly string[], candidates: readonly string[]): Metrics | null {
  if (!relevant.length) return null;
  const positions = relevant.map(id => ranked.indexOf(id) + 1), first = Math.min(...positions.filter(rank => rank > 0));
  return { recallAt1: positions.filter(rank => rank === 1).length / positions.length,
    recallAt5: positions.filter(rank => rank > 0 && rank <= 5).length / positions.length,
    mrrAt5: Number.isFinite(first) && first <= 5 ? 1 / first : 0,
    mrrRecordedRanking: Number.isFinite(first) ? 1 / first : 0,
    candidateRecall: relevant.filter(id => candidates.includes(id)).length / relevant.length };
}

export function checkV2Boundaries(question: V2Question, documents: RetrievalDocument[], ranked: readonly string[]) {
  const visible = new Set(scopeDocuments(documents, question).map(doc => doc.id)), top5 = ranked.slice(0, 5);
  const forbiddenMatches = top5.filter(id => question.forbidden?.includes(id));
  const requiredPassed = (question.required ?? []).every(id => top5.includes(id));
  // A same-scope irrelevant result violates the question's boundary, not authorization.
  return { scopePassed: ranked.every(id => visible.has(id)),
    boundaryPassed: forbiddenMatches.length === 0 && requiredPassed, forbiddenMatches, requiredPassed };
}

export function validateV2Dataset(data: V2Dataset) {
  if (!data || !Array.isArray(data.corpora) || !data.corpora.length || new Set(data.corpora.map(c => c.id)).size !== data.corpora.length) throw new Error("检索 v2 corpus 无效。");
  for (const corpus of data.corpora) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(corpus.id) || !Array.isArray(corpus.questions) || !corpus.questions.length
      || new Set(corpus.questions.map(q => q.id)).size !== corpus.questions.length) throw new Error("检索 v2 题目 ID 无效。");
    scopeDocuments(corpus.documents, {});
    for (const q of corpus.questions) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(q.id) || typeof q.query !== "string" || !q.query.trim() || q.query.length > 500
        || !["standard", "hard", "scope", "no_answer", "context"].includes(q.suite)
        || (q.deferredReason !== undefined && (q.suite !== "context" || typeof q.deferredReason !== "string" || !q.deferredReason.trim() || q.deferredReason.length > 300))) throw new Error("检索 v2 问题无效。");
      const visible = scopeDocuments(corpus.documents, q);
      for (const ids of [q.relevant, q.required ?? [], q.forbidden ?? []]) {
        if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !corpus.documents.some(doc => doc.id === id)) || new Set(ids).size !== ids.length) throw new Error("检索 v2 标签无效。");
      }
      if (q.relevant.some(id => !visible.some(doc => doc.id === id)) || q.required?.some(id => !visible.some(doc => doc.id === id))
        || q.required?.some(id => q.forbidden?.includes(id)) || q.relevant.some(id => q.forbidden?.includes(id))
        || (["standard", "hard"].includes(q.suite) && !q.relevant.length) || (q.suite === "no_answer" && q.relevant.length)) throw new Error("检索 v2 标签与可见范围冲突。");
    }
  }
  return data;
}

export async function loadV2Dataset(): Promise<V2Dataset> {
  const data = await loadRetrievalData(), selected = new Set(data.selectedIds);
  const boundary = JSON.parse(await readFile(join(root, "data/retrieval-boundaries.json"), "utf8"));
  return validateV2Dataset({ source: data.source, corpora: [
    { id: "selected", documents: data.documents.filter(doc => selected.has(doc.id)), questions: data.questions.filter(q => q.relevant.every(id => selected.has(id))) },
    { id: "full", documents: data.documents, questions: [...data.questions,
      ...boundary.scope.map((q: V2Question) => ({ ...q, id: `scope-${q.id}`, relevant: [], suite: "scope" })),
      ...boundary.noAnswer.map((q: V2Question) => ({ ...q, id: `no-answer-${q.id}`, relevant: [], suite: "no_answer" })),
    ] },
  ] });
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path);
}

function validRanks(value: unknown, length: number): value is Array<{ index: number; score: number }> {
  return Array.isArray(value) && value.length === length && value.every((row, index) => row && Number.isSafeInteger(row.index) && row.index >= 0 && row.index < length
    && Number.isFinite(row.score) && row.score >= 0 && row.score <= 1 && (index === 0 || row.score <= value[index - 1].score))
    && new Set(value.map(row => row.index)).size === length;
}

type PlannedCase = Pick<V2Result, "corpus" | "id" | "suite" | "mode"> & { answerable?: boolean; expectedAbstention?: boolean; relevant?: string[]; deferredReason?: string | null };
export function summarizeV2(results: V2Result[], calls: Call[], plan: PlannedCase[] = results, pricePerMillionCny: number | null = null, supportCalls: SupportCall[] = []) {
  const groups = [...new Set(plan.map(row => JSON.stringify([row.mode, row.corpus, row.suite])))].map(key => {
    const [mode, corpus, suite] = JSON.parse(key) as string[], rows = results.filter(row => row.mode === mode && row.corpus === corpus && row.suite === suite);
    const planned = plan.filter(row => row.mode === mode && row.corpus === corpus && row.suite === suite).length;
    const scored = rows.filter(row => row.metrics), successful = rows.filter(row => row.status === "ok");
    const mean = (field: keyof Metrics) => scored.length ? scored.reduce((sum, row) => sum + row.metrics![field], 0) / scored.length : null;
    const latency = successful.map(row => row.durationMs).sort((a, b) => a - b);
    const plannedRows = plan.filter(row => row.mode === mode && row.corpus === corpus && row.suite === suite);
    const applicablePlan = plannedRows.filter(row => !row.deferredReason);
    const plannedAnswerable = applicablePlan.filter(row => row.answerable ?? (row.relevant ? row.relevant.length > 0 : ["standard", "hard"].includes(row.suite))).length;
    const acceptedScored = successful.filter(row => row.acceptedMetrics), acceptedMeasured = successful.filter(row => row.acceptance && row.acceptance.status !== "unavailable");
    const coveredCases = acceptedMeasured.filter(row => row.acceptance.accepted.length > 0).length;
    const falseRejectDenominator = acceptedMeasured.filter(row => row.falseRejectEligible === true).length;
    const falseRejectCases = acceptedMeasured.filter(row => row.falseRejected === true).length;
    const noAnswerDenominator = suite === "no_answer" ? acceptedMeasured.length : 0;
    const noAnswerFalseAcceptCases = suite === "no_answer" ? coveredCases : 0;
    const abstentionRows = acceptedMeasured.filter(row => row.expectedAbstention ?? row.suite === "no_answer");
    const abstentionFalseAcceptCases = abstentionRows.filter(row => row.acceptance.accepted.length > 0).length;
    return { mode, corpus, suite, planned, missing: planned - rows.length, succeeded: successful.length, failed: rows.filter(row => row.status === "provider_error").length,
      notApplicable: rows.filter(row => row.status === "not_applicable").length, measured: scored.length,
      recallAt1: mean("recallAt1"), recallAt5: mean("recallAt5"), mrrAt5: mean("mrrAt5"), candidateRecall: mean("candidateRecall"),
      // End-to-end planned denominator: failed calls cannot disappear and improve the success-only mean.
      plannedRecallAt5: ["standard", "hard"].includes(suite!) ? scored.reduce((sum, row) => sum + row.metrics!.recallAt5, 0) / planned : null,
      scopeViolations: successful.filter(row => !row.scopePassed).length,
      boundaryFailures: successful.filter(row => !row.boundaryPassed).length,
      forbiddenHitCases: successful.filter(row => row.forbiddenMatches.length > 0).length,
      requiredEvidenceMisses: successful.filter(row => !row.requiredPassed).length,
      noAnswerNonempty: suite === "no_answer" ? successful.filter(row => !row.empty).length : null,
      acceptance: { planned: plannedRows.length, applicablePlanned: applicablePlan.length, measured: acceptedMeasured.length,
        missing: planned - rows.length, failed: rows.filter(row => row.status === "provider_error" || (row.status === "ok" && row.acceptance?.status === "unavailable")).length,
        notApplicable: rows.filter(row => row.status === "not_applicable").length, deferred: rows.filter(row => row.deferredReason).length,
        plannedAnswerable, answerableMeasured: acceptedScored.length,
        recallAt5: acceptedScored.length ? acceptedScored.reduce((sum, row) => sum + row.acceptedMetrics!.recallAt5, 0) / acceptedScored.length : null,
        plannedRecallAt5: plannedAnswerable ? acceptedScored.reduce((sum, row) => sum + row.acceptedMetrics!.recallAt5, 0) / plannedAnswerable : null,
        mrrAt5: acceptedScored.length ? acceptedScored.reduce((sum, row) => sum + row.acceptedMetrics!.mrrAt5, 0) / acceptedScored.length : null,
        coveredCases, coverage: acceptedMeasured.length ? coveredCases / acceptedMeasured.length : null,
        plannedCoverage: applicablePlan.length ? coveredCases / applicablePlan.length : null,
        noAnswerFalseAcceptCases, noAnswerDenominator, noAnswerPlanned: suite === "no_answer" ? applicablePlan.length : 0,
        noAnswerFalseAcceptRate: noAnswerDenominator ? noAnswerFalseAcceptCases / noAnswerDenominator : null,
        abstentionFalseAcceptCases, abstentionDenominator: abstentionRows.length,
        abstentionPlanned: applicablePlan.filter(row => row.expectedAbstention ?? row.suite === "no_answer").length,
        abstentionFalseAcceptRate: abstentionRows.length ? abstentionFalseAcceptCases / abstentionRows.length : null,
        answerableFalseRejectCases: falseRejectCases, answerableFalseRejectDenominator: falseRejectDenominator,
        answerableFalseRejectRate: falseRejectDenominator ? falseRejectCases / falseRejectDenominator : null,
        scopeViolations: acceptedMeasured.filter(row => !row.acceptedScopePassed).length,
        boundaryFailures: acceptedMeasured.filter(row => !row.acceptedBoundaryPassed).length },
      durationP50Ms: latency.length ? latency[Math.ceil(latency.length * .5) - 1]! : null, durationP95Ms: latency.length ? latency[Math.ceil(latency.length * .95) - 1]! : null };
  });
  const usage = (["embedding", "rerank"] as const).map(operation => {
    const selected = calls.filter(call => call.operation === operation), attempts = selected.flatMap(call => call.attempts), known = attempts.filter(attempt => attempt.totalTokens !== null);
    const knownTokens = known.length ? known.reduce((sum, attempt) => sum + attempt.totalTokens!, 0) : null;
    return { operation, requests: attempts.length, successfulRequests: attempts.filter(attempt => attempt.outcome === "ok").length,
      cacheHits: selected.filter(call => call.cache === "hit").length, reportedRequests: known.length,
      usageCoverage: attempts.length ? known.length / attempts.length : null, knownTokens,
      completeTokens: attempts.length && attempts.length === known.length ? knownTokens : null,
      knownEstimatedCostCny: knownTokens !== null && pricePerMillionCny !== null ? knownTokens * pricePerMillionCny / 1_000_000 : null,
      completeEstimatedCostCny: attempts.length && attempts.length === known.length && pricePerMillionCny !== null ? knownTokens! * pricePerMillionCny / 1_000_000 : null };
  });
  const attempts = supportCalls.flatMap(call => call.attempts), known = attempts.filter(attempt => attempt.totalTokens !== null);
  const costs = attempts.filter(attempt => attempt.costUsd !== null), costsCny = attempts.filter(attempt => attempt.costCny != null);
  const knownTokens = known.length ? known.reduce((sum, attempt) => sum + attempt.totalTokens!, 0) : null;
  const knownCost = costs.length ? costs.reduce((sum, attempt) => sum + attempt.costUsd!, 0) : null;
  const knownCostCny = costsCny.length ? costsCny.reduce((sum, attempt) => sum + attempt.costCny!, 0) : null;
  const supportUsage = { operation: "support", requests: attempts.length, successfulRequests: attempts.filter(attempt => attempt.outcome === "ok").length,
    cacheHits: supportCalls.filter(call => call.cache === "hit").length, reportedRequests: known.length, usageCoverage: attempts.length ? known.length / attempts.length : null,
    knownTokens, completeTokens: attempts.length && known.length === attempts.length ? knownTokens : null,
    knownEstimatedCostCny: knownCostCny,
    completeEstimatedCostCny: attempts.length && costsCny.length === attempts.length ? knownCostCny : null, knownEstimatedCostUsd: knownCost,
    completeEstimatedCostUsd: attempts.length && costs.length === attempts.length ? knownCost : null,
    costCoverage: attempts.length ? attempts.filter(attempt => attempt.costUsd !== null || attempt.costCny != null).length / attempts.length : null };
  return { plannedRows: plan.length, completedRows: results.length, missingRows: plan.length - results.length, groups,
    usage: [...usage, ...(supportCalls.length ? [supportUsage] : [])] };
}

export async function runRetrievalV2(options: { label: string; modes?: RetrievalMode[]; dataset?: V2Dataset; client?: BailianClient;
  allowRemote?: boolean; cacheDir?: string; outputDir?: string; maxRequests?: number; consecutiveFailureLimit?: number;
  parameters?: Partial<RetrievalExperimentParameters>; acceptance?: EvidenceAcceptanceConfig; supportClient?: EvidenceSupportClient }) {
  const modes = options.modes ?? ["M0", "M1"];
  if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => !retrievalModes.includes(mode))
    || !options.label.trim() || options.label.length > 120) throw new Error("检索实验模式或 label 无效。");
  const acceptanceConfig = resolveEvidenceAcceptance(options.acceptance, modes);
  if (modes.some(remoteMode) && !options.allowRemote) throw new Error("远程实验必须显式设置 allowRemote。");
  // Validate before spreading so arrays, unknown keys and explicitly undefined values cannot be silently accepted.
  resolveRetrievalParameters(options.parameters);
  for (const name of ["maxRequests", "consecutiveFailureLimit"] as const) {
    if (options[name] !== undefined && options.parameters?.[name] !== undefined && options[name] !== options.parameters[name]) {
      throw new Error(`检索实验参数 ${name} 与旧预算选项冲突。`);
    }
  }
  const injectedClient = modes.some(remoteMode) ? options.client : undefined;
  for (const name of ["timeoutMs", "retries"] as const) {
    if (injectedClient && options.parameters?.[name] !== undefined && options.parameters[name] !== injectedClient.settings[name]) {
      throw new Error(`检索实验参数 ${name} 与注入 client 的实际配置冲突。`);
    }
  }
  const parameters = resolveRetrievalParameters({
    ...(injectedClient ? { timeoutMs: injectedClient.settings.timeoutMs, retries: injectedClient.settings.retries } : {}),
    ...options.parameters,
    ...(options.maxRequests !== undefined ? { maxRequests: options.maxRequests } : {}),
    ...(options.consecutiveFailureLimit !== undefined ? { consecutiveFailureLimit: options.consecutiveFailureLimit } : {}),
  });
  const dataset = validateV2Dataset(options.dataset ?? await loadV2Dataset());
  const needsRemote = modes.some(remoteMode) && dataset.corpora.some(corpus => corpus.questions.some(question => !question.deferredReason));
  const client = needsRemote ? injectedClient ?? createBailianClient({ timeoutMs: parameters.timeoutMs, retries: parameters.retries }) : undefined;
  const supportClient = needsRemote && acceptanceConfig.mode === "support"
    ? options.supportClient ?? await createEvidenceSupportClient({ timeoutMs: parameters.timeoutMs }) : undefined;
  if (supportClient && supportClient.settings.timeoutMs !== parameters.timeoutMs) throw new Error("支持性判别 timeoutMs 与实际 client 不符。");
  const { maxRequests, consecutiveFailureLimit } = parameters;
  let networkRequests = 0, consecutiveFailures = 0, supportConsecutiveFailures = 0, fatalProviderStatus: number | null = null, stopReason: string | null = null;
  const controls = {
    beforeAttempt: () => {
      if (fatalProviderStatus !== null || networkRequests >= maxRequests || consecutiveFailures >= consecutiveFailureLimit || supportConsecutiveFailures >= consecutiveFailureLimit) {
        stopReason = fatalProviderStatus !== null ? "provider_configuration" : networkRequests >= maxRequests ? "max_requests" : supportConsecutiveFailures >= consecutiveFailureLimit ? "consecutive_support_failures" : "consecutive_provider_failures"; return false;
      }
      networkRequests++; return true;
    },
    onAttempt: (attempt: BailianAttempt) => {
      consecutiveFailures = attempt.outcome === "ok" ? 0 : consecutiveFailures + 1;
      if (attempt.httpStatus === 401 || attempt.httpStatus === 403) fatalProviderStatus = attempt.httpStatus;
    },
  };
  const origin = client?.settings.endpoints.origin ?? "";
  const pricePerMillionCny = origin === "https://dashscope.aliyuncs.com" || origin.endsWith(".cn-beijing.maas.aliyuncs.com") ? .5 : null;
  const cacheDir = options.cacheDir ?? join(root, ".runtime/retrieval-v2-cache"), outputDir = options.outputDir ?? join(root, ".runtime/retrieval-v2");
  const runId = randomUUID(), calls: Call[] = [], supportCalls: SupportCall[] = [], results: V2Result[] = [];
  const plan = dataset.corpora.flatMap(corpus => corpus.questions.flatMap(question => modes.map(mode => ({ corpus: corpus.id, id: question.id, suite: question.suite, mode, answerable: question.relevant.length > 0, expectedAbstention: question.expectedBehavior === "abstain" || question.suite === "no_answer", deferredReason: question.deferredReason ?? null }))));
  // Deferred questions are materialized before any provider work, even when the request budget stops early.
  for (const corpus of dataset.corpora) for (const question of corpus.questions.filter(question => question.deferredReason)) {
    const scope = { shopId: question.shopId, productId: question.productId ?? null };
        for (const mode of modes) results.push({ corpus: corpus.id, id: question.id, suite: question.suite, mode, query: question.query, scope,
          status: "not_applicable", candidateIds: [], candidateHash: contentHash([]), ranking: [], relevant: question.relevant, metrics: null,
          acceptance: acceptEvidence({ config: acceptanceConfig, documents: corpus.documents, scope, ranking: [], status: "not_applicable", query: question.query }),
          acceptedMetrics: null, acceptedScopePassed: true, acceptedBoundaryPassed: false, expectedAbstention: false, falseRejectEligible: null, falseRejected: null,
          deferredReason: question.deferredReason!, ...checkV2Boundaries(question, corpus.documents, []), empty: null, durationMs: 0,
          callIds: [], fallback: null, error: question.deferredReason! });
  }
  const settings = { modes, parameters, provider: client?.settings ?? null, bm25: { k1: parameters.bm25K1, b: parameters.bm25B },
    rrf: { k: parameters.rrfK, window: parameters.rrfWindow }, topN: 5,
    budget: { maxRequests, consecutiveFailureLimit }, pricing: { currency: "CNY", asOf: "2026-10-05", region: "China Beijing", estimated: true,
      perMillionInputTokens: pricePerMillionCny, source: "https://help.aliyun.com/zh/model-studio/model-pricing", note: "Only configured Beijing endpoint; reported total_tokens, not an invoice; other region prices unknown." },
    context: "query-only", acceptance: { ...acceptanceConfig, version: acceptanceConfig.mode === "support" ? "score-support-v1" : evidenceAcceptanceVersion, ...evidenceAcceptanceBinding,
      support: supportClient?.settings ?? null,
      corpusHashes: Object.fromEntries(dataset.corpora.map(corpus => [corpus.id, contentHash(corpus.documents)])) }, fallback: "diagnostic lexical; excluded from rerank score" };
  const files = ["src/bailian.ts", "src/evidence-acceptance.ts", "src/evidence-support.ts", "src/retrieval-ranking.ts", "src/knowledge-retrieval.ts", "scripts/retrieval-v2.ts", "scripts/retrieval-data.ts", "package-lock.json"];
  const snapshot = { datasetHash: contentHash(dataset), dataset, settings,
    checker: { version: 2, scopePassed: "Every ranked document is active and visible to the question scope.",
      boundaryPassed: "No forbidden document in Top5 and every required document in Top5; independent of scopePassed.",
      acceptanceVersion: 1, acceptedRecall: "Relevant IDs found in accepted original evidence, maximum 5. Planned denominator includes failed/missing applicable answerable cases.",
      falseReject: "Applicable successful answerable cases with relevant evidence in raw Top5, but no relevant accepted evidence.",
      noAnswerFalseAccept: "Applicable successful no_answer cases with any accepted evidence; failures/missing are reported separately, never successful rejections." },
    runtime: { node: process.version, icu: process.versions.icu },
    implementation: Object.fromEntries(await Promise.all(files.map(async file => [file, contentHash(await readFile(join(root, file), "utf8"))]))) };
  const report = { version: 2, runId, label: options.label.trim(), startedAt: new Date().toISOString(), finishedAt: null as string | null,
    status: "running", stopReason: null as string | null, answerQuality: "not_evaluated", snapshot, plan, calls, supportCalls, results, summary: summarizeV2(results, calls, plan, pricePerMillionCny, supportCalls),
    measurement: "Offline retrieval development experiment. MRR@5 is comparable; full MRR is only within recorded ranking depth. Candidate recall uses configured candidateTopK except M4's complete scoped input. Timings reuse measured shared query stages and exclude document indexing; cache hits are identified in call ledger. Ledger usage is the actual experiment cost, not independent per-mode production cost. Cache replay is not an independent model repetition. Version 1 scopeViolations mixed authorization scope with forbidden Top5 hits; version 2 separates scopeViolations from boundaryFailures/forbiddenHitCases without removing forbidden or required checks. No answer nonempty is diagnostic. API failures stay in planned denominator. Acceptance off is the scoped raw Top5 diagnostic baseline; score uses the frozen model and serialization binding plus per-corpus hashes. Acceptance never reads labels. Context cases with deferredReason remain planned and not_applicable without provider calls. Support uses one bounded additional model call per nonempty score-gated candidate set; original scores remain unchanged and support failures are excluded from successful acceptance denominators, with planned recall retained. Support usage and cache are separate; costUsd is an estimate from the pinned Pi model catalog, not an invoice. No live business or QQ changes." };
  const path = join(outputDir, `${runId}.json`);
  await atomicJson(path, report);

  async function cached<T>(operation: "embedding" | "rerank", purpose: Call["purpose"], input: unknown, validate: (value: unknown) => value is T,
    execute: () => Promise<{ value: T; requestHash: string; attempts: BailianAttempt[] }>): Promise<{ value: T; callId: string }> {
    const inputHash = contentHash({ operation, provider: client!.settings, input }), cachePath = join(cacheDir, `${inputHash}.json`), id = randomUUID();
    if (parameters.cache === "reuse") try {
      const saved = JSON.parse(await readFile(cachePath, "utf8"));
      if (saved.version !== 1 || saved.inputHash !== inputHash || saved.valueHash !== contentHash(saved.value) || !validate(saved.value)) throw new Error("检索缓存校验失败；未自动覆盖。");
      calls.push({ id, operation, purpose, cache: "hit", inputHash, requestHash: saved.requestHash, attempts: [], status: "ok" });
      return { value: saved.value, callId: id };
    } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    try {
      const response = await execute();
      if (!validate(response.value)) throw new Error("检索 provider 返回值无效。");
      calls.push({ id, operation, purpose, cache: "miss", inputHash, requestHash: response.requestHash, attempts: response.attempts, status: "ok" });
      if (parameters.cache === "reuse") await atomicJson(cachePath, { version: 1, inputHash, requestHash: response.requestHash, createdAt: new Date().toISOString(), value: response.value, valueHash: contentHash(response.value) });
      return { value: response.value, callId: id };
    } catch (error) {
      if (!calls.some(call => call.id === id)) calls.push({ id, operation, purpose, cache: "miss", inputHash, requestHash: null,
        attempts: error instanceof BailianError ? error.attempts : [], status: "failed" });
      throw error;
    }
  }

  async function supported(query: string, scope: RetrievalScope, candidates: EvidenceSupportCandidate[]) {
    const input = { query, scope, candidates, settings: supportClient!.settings };
    const inputHash = evidenceSupportInputHash(input);
    const cachePath = join(cacheDir, `support-${inputHash}.json`), id = randomUUID();
    if (parameters.cache === "reuse") try {
      const saved = JSON.parse(await readFile(cachePath, "utf8"));
      const verification = { value: saved.value, requestHash: saved.requestHash, attempts: [] as EvidenceSupportAttempt[], inputHash };
      if (saved.version !== 1 || saved.inputHash !== inputHash || saved.valueHash !== contentHash(saved.value)
        || !validateEvidenceSupportVerification(verification, input)) throw new Error("支持性缓存校验失败；未自动覆盖。");
      supportCalls.push({ id, operation: "support", cache: "hit", inputHash, requestHash: saved.requestHash, attempts: [], status: "ok" });
      return { verification, callId: id };
    } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    if (!controls.beforeAttempt()) throw new BailianBudgetStop([]);
    try {
      const response = await verifyEvidenceSupport({ query, scope, candidates, client: supportClient! });
      if (!validateEvidenceSupportVerification(response, input)) throw new Error("支持性响应校验失败。");
      supportCalls.push({ id, operation: "support", cache: "miss", inputHash, requestHash: response.requestHash, attempts: response.attempts, status: "ok" });
      supportConsecutiveFailures = 0;
      if (parameters.cache === "reuse") await atomicJson(cachePath, { version: 1, inputHash, requestHash: response.requestHash,
        createdAt: new Date().toISOString(), value: response.value, valueHash: contentHash(response.value) });
      return { verification: response, callId: id };
    } catch (error) {
      if (!supportCalls.some(call => call.id === id)) supportCalls.push({ id, operation: "support", cache: "miss", inputHash,
        requestHash: null, attempts: error instanceof EvidenceSupportError ? error.attempts : [], status: "failed" });
      supportConsecutiveFailures++;
      throw error;
    }
  }

  const documentVectors = new Map<string, number[]>(), documentCalls = new Set<string>();
  let embeddingSetupError: string | null = null;
  try {
    if (modes.some(mode => modesNeedingDense.has(mode))) {
      const unique = [...new Map(dataset.corpora.flatMap(corpus => corpus.questions.filter(question => !question.deferredReason).flatMap(question => scopeDocuments(corpus.documents, question)))
        .map(doc => [contentHash(serializeRetrievalDocument(doc)), doc])).values()];
      // Stable batches are reusable between full/subset runs. Scope is applied again before every ranking and rerank request.
      for (let offset = 0; offset < unique.length; offset += 10) {
        const chunk = unique.slice(offset, offset + 10), texts = chunk.map(serializeRetrievalDocument);
        const before = calls.length;
        try {
          const result = await cached("embedding", "document", texts, (value): value is number[][] => Array.isArray(value) && value.length === texts.length && value.every(item => validVector(item)), () => client!.embed(texts, controls));
          documentCalls.add(result.callId); chunk.forEach((doc, index) => documentVectors.set(contentHash(serializeRetrievalDocument(doc)), result.value[index]!));
        } catch (error) { if (!(error instanceof BailianError) || error instanceof BailianBudgetStop) throw error; calls.slice(before).forEach(call => documentCalls.add(call.id)); embeddingSetupError = error.message; break; }
      }
    }
    for (const corpus of dataset.corpora) for (const question of corpus.questions) {
      const scope = { shopId: question.shopId, productId: question.productId ?? null }, visible = scopeDocuments(corpus.documents, scope);
      if (question.deferredReason) continue;
      let start = performance.now(); const lexical = rankLexical(question.query, corpus.documents, scope); const lexicalMs = performance.now() - start;
      start = performance.now(); const bm25 = rankBm25(question.query, corpus.documents, scope, { k1: parameters.bm25K1, b: parameters.bm25B }); const bm25Ms = performance.now() - start;
      let dense: RankedDocument[] | undefined, fused: RankedDocument[] | undefined, denseError = embeddingSetupError;
      const sharedCalls = [...documentCalls];
      const denseStarted = performance.now();
      if (visible.length && modes.some(mode => modesNeedingDense.has(mode)) && !denseError) {
        const before = calls.length;
        try {
          const query = await cached("embedding", "query", [question.query], (value): value is number[][] => Array.isArray(value) && value.length === 1 && validVector(value[0]), () => client!.embed([question.query], controls));
          sharedCalls.push(query.callId);
          const vectors = new Map(visible.map(doc => [doc.id, documentVectors.get(contentHash(serializeRetrievalDocument(doc)))!]));
          dense = rankDense(query.value[0]!, corpus.documents, vectors, scope);
        } catch (error) { if (!(error instanceof BailianError) || error instanceof BailianBudgetStop) throw error; denseError = error.message; sharedCalls.push(...calls.slice(before).map(call => call.id)); }
      }
      const denseMs = performance.now() - denseStarted;
      start = performance.now(); fused = dense ? reciprocalRankFusion([bm25, dense], { k: parameters.rrfK, topK: parameters.rrfWindow }) : []; const fusionMs = performance.now() - start;
      for (const mode of modes) {
        const started = performance.now(), callIds = modesNeedingDense.has(mode) ? [...sharedCalls] : [];
        let candidates: string[] = [], ranking: V2Result["ranking"] = [], status: V2Result["status"] = "ok", errorMessage: string | null = null;
        try {
          if (modesNeedingDense.has(mode) && denseError) throw new BailianError(denseError);
          const lexicalRanks = lexical.map(id => ({ id, score: null }));
          if (mode === "M0") ranking = lexicalRanks;
          if (mode === "M1") ranking = bm25;
          if (mode === "M2") ranking = dense ?? [];
          if (mode === "M3") ranking = fused ?? [];
          if (["M0", "M1", "M2", "M3"].includes(mode)) candidates = ranking.slice(0, parameters.candidateTopK).map(row => row.id);
          else {
            candidates = (mode === "M4" ? visible.map(doc => doc.id) : mode === "M5" ? lexical.slice(0, parameters.candidateTopK) : (fused ?? []).slice(0, parameters.candidateTopK).map(row => row.id));
            if (candidates.length > 500) { status = "not_applicable"; errorMessage = "单次 rerank 候选超过 500，不分批拼接不可比的分数。"; }
            else if (candidates.length) {
              // Canonical request order avoids introducing upstream rank order as a hidden input difference.
              candidates.sort();
              const documents = candidates.map(id => serializeRetrievalDocument(visible.find(doc => doc.id === id)!));
              const before = calls.length;
              try {
                const reranked = await cached("rerank", "ranking", { query: question.query, documents }, (value): value is Array<{ index: number; score: number }> => validRanks(value, candidates.length),
                  () => client!.rerank(question.query, documents, controls));
                callIds.push(reranked.callId); ranking = reranked.value.map(row => ({ id: candidates[row.index]!, score: row.score }));
              } catch (error) { callIds.push(...calls.slice(before).map(call => call.id)); throw error; }
            }
          }
        } catch (error) { if (!(error instanceof BailianError) || error instanceof BailianBudgetStop) throw error; status = "provider_error"; errorMessage = error.message; }
        const ranked = ranking.map(row => row.id);
        let supportVerification: EvidenceSupportVerification | undefined;
        let supportBudgetStop: BailianBudgetStop | undefined;
        let acceptance = acceptEvidence({ config: acceptanceConfig, scope, documents: corpus.documents, ranking, query: question.query, status });
        if (status === "ok" && acceptanceConfig.mode === "support" && acceptance.pendingSupport?.length) {
          const before = supportCalls.length;
          try {
            const { verification, callId } = await supported(question.query, scope, acceptance.pendingSupport);
            callIds.push(callId); supportVerification = verification;
            acceptance = applyEvidenceSupport({ prepared: acceptance, verification, query: question.query, settings: supportClient!.settings, scope, documents: corpus.documents });
          } catch (error) {
            callIds.push(...supportCalls.slice(before).map(call => call.id));
            if (error instanceof BailianBudgetStop) supportBudgetStop = error;
            else if (!(error instanceof EvidenceSupportError)) throw error;
            acceptance = applyEvidenceSupport({ prepared: acceptance, verification: null, query: question.query, settings: supportClient!.settings, scope, documents: corpus.documents });
            errorMessage = error.message;
          }
        }
        const acceptanceMeasured = status === "ok" && acceptance.status !== "unavailable";
        const acceptedIds = acceptance.accepted.map(row => row.id), acceptedBoundary = checkV2Boundaries(question, corpus.documents, acceptedIds);
        const falseRejectEligible = acceptanceMeasured && question.relevant.length ? ranked.slice(0, 5).some(id => question.relevant.includes(id)) : null;
        results.push({ corpus: corpus.id, id: question.id, suite: question.suite, mode, query: question.query, scope, status,
          candidateIds: candidates, candidateHash: contentHash(candidates.map(id => [id, serializeRetrievalDocument(visible.find(doc => doc.id === id)!)])),
          ranking, relevant: question.relevant, acceptance, ...(supportVerification ? { supportVerification } : {}),
          acceptedMetrics: acceptanceMeasured ? metrics(question.relevant, acceptedIds, candidates) : null,
          acceptedScopePassed: acceptedBoundary.scopePassed, acceptedBoundaryPassed: acceptedBoundary.boundaryPassed,
          expectedAbstention: question.expectedBehavior === "abstain" || question.suite === "no_answer",
          falseRejectEligible, falseRejected: falseRejectEligible === null ? null : falseRejectEligible && !acceptedIds.some(id => question.relevant.includes(id)), deferredReason: null,
          metrics: status === "ok" ? metrics(question.relevant, ranked, candidates) : null,
          ...checkV2Boundaries(question, corpus.documents, ranked),
          empty: status === "ok" ? !ranking.length : null,
          durationMs: performance.now() - started + (mode === "M0" || mode === "M5" ? lexicalMs : mode === "M1" ? bm25Ms : mode === "M2" ? denseMs : mode === "M3" || mode === "M6" ? denseMs + bm25Ms + fusionMs : 0), callIds,
          fallback: status === "provider_error" ? { mode: "M0", ranking: lexical, metrics: metrics(question.relevant, lexical, lexical.slice(0, parameters.candidateTopK)) } : null, error: errorMessage });
        if (supportBudgetStop) throw supportBudgetStop;
      }
      report.summary = summarizeV2(results, calls, plan, pricePerMillionCny, supportCalls); await atomicJson(path, report);
    }
    report.status = results.some(row => !row.deferredReason && (row.status !== "ok" || row.acceptance.status === "unavailable")) ? "completed_with_errors" : "completed";
  } catch (error) {
    if (error instanceof BailianBudgetStop) { report.status = "budget_stopped"; report.stopReason = stopReason; }
    else { report.status = "failed"; throw new Error(`检索 v2 执行中断；已记录报告 ${runId}，未自动重跑。`); }
  } finally { report.finishedAt = new Date().toISOString(); report.summary = summarizeV2(results, calls, plan, pricePerMillionCny, supportCalls); await atomicJson(path, report); }
  return { path, report };
}

export async function smokeBailian() {
  const client = createBailianClient({ retries: 0 }), calls: Array<{ operation: string; attempts: BailianAttempt[] }> = [];
  const documents = ["未使用的演示餐券需要联系模拟商家审核退款。", "餐厅午餐营业时间为十一点至十四点。"];
  for (const [operation, invoke] of [["embedding-documents", () => client.embed(documents)], ["embedding-query", () => client.embed(["午餐什么时候营业？"])],
    ["rerank-hours", () => client.rerank("午餐什么时候营业？", documents)], ["rerank-unknown", () => client.rerank("套餐含多少毫克钠？", documents)]] as const) {
    try { const result = await invoke(); calls.push({ operation, attempts: result.attempts }); }
    catch (error) { if (error instanceof BailianError) calls.push({ operation, attempts: error.attempts }); else throw error; }
  }
  return { success: calls.every(call => call.attempts.every(attempt => attempt.outcome === "ok")), calls };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--smoke") smokeBailian().then(result => { console.log(JSON.stringify(result, null, 2)); if (!result.success) process.exitCode = 1; })
    .catch(() => { console.error("百炼 smoke 未完成；请检查本机配置（凭据不会输出）。"); process.exitCode = 2; });
  else if (args[0] === "--run" && args.length <= 2) {
    const modes = args[1] ? args[1].split(",") as RetrievalMode[] : [...retrievalModes];
    runRetrievalV2({ label: "M0–M6 development comparison", modes, allowRemote: true }).then(({ path, report }) => {
      console.log(JSON.stringify({ path, status: report.status, summary: report.summary }, null, 2)); if (report.status !== "completed") process.exitCode = 1;
    }).catch(error => { console.error(error instanceof BailianError ? error.message : "检索 v2 未完成；检查配置和本地报告。"); process.exitCode = 2; });
  } else { console.log("用法：node --env-file-if-exists=.env scripts/retrieval-v2.ts --run [M0,M1,...,M6] 或 --smoke。远程模式产生模型费用，默认不执行。"); if (args.length) process.exitCode = 2; }
}
