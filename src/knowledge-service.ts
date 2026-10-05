import { BailianError, contentHash, createBailianClient, rerankInstruction, type BailianAttempt, type BailianClient } from "./bailian.ts";
import type { CouponStore } from "./coupon-store.ts";
import { acceptEvidence, resolveEvidenceAcceptance, type EvidenceAcceptanceResult, type EvidenceRanking } from "./evidence-acceptance.ts";
import { applyEvidenceSupport, createEvidenceSupportClient, EvidenceSupportError, verifyEvidenceSupport, resolveEvidenceSupportModel,
  evidenceSupportPrompt, evidenceSupportPromptVersion, evidenceSupportTypedPrompt, evidenceSupportTypedPromptVersion,
  evidenceSupportTypedV6Prompt, evidenceSupportTypedV6PromptVersion,
  type EvidenceSupportAttempt, type EvidenceSupportClient, type EvidenceSupportModel, type EvidenceSupportProfile, type EvidenceSupportFailure, type EvidenceSupportSettings, type EvidenceSupportVerification } from "./evidence-support.ts";
import { rankLexical, scopeDocuments, serializeRetrievalDocument, type RetrievalScope } from "./retrieval-ranking.ts";
import { gateKnowledgeApplicability, loadKnowledgeApplicabilitySnapshot, validateKnowledgeApplicabilitySnapshot,
  type KnowledgeApplicabilityContext, type KnowledgeApplicabilityMode, type KnowledgeApplicabilityResult,
  type KnowledgeApplicabilitySnapshot } from "./knowledge-applicability.ts";

export type KnowledgeMode = "lexical" | "m4-support";
export type KnowledgeQueryMode = "combined" | "separated";
export type KnowledgeSupportPrompt = "v5" | "v6";
export const knowledgeQueryPlanVersion = "knowledge-query-plan-v1";
export type KnowledgeStage = "read" | "rerank" | "applicability" | "support" | "recheck";
export type KnowledgeDocuments = Awaited<ReturnType<CouponStore["searchKnowledge"]>>;
export type KnowledgeCall = { operation: "rerank"; requestHash: string | null; attempts: BailianAttempt[]; status: "ok" | "unavailable" }
  | { operation: "support"; requestHash: string | null; attempts: EvidenceSupportAttempt[]; status: "ok" | "partial" | "unavailable" };
export type KnowledgeTrace = {
  mode: KnowledgeMode; threshold: number | null; query: string; originalQuery: string; scope: RetrievalScope;
  queries?: { version: typeof knowledgeQueryPlanVersion; mode: KnowledgeQueryMode; retrieval: string; evidence: string };
  status: "accepted" | "rejected" | "unavailable";
  reason: null | "invalid_input" | "aborted" | "timeout" | "database_unavailable" | "provider_unavailable" | "source_changed" | "invalid_support_decision"
    | "metadata_binding_invalid" | "applicability_facts_unknown";
  rawRanking: EvidenceRanking; acceptance: EvidenceAcceptanceResult | null;
  // Current accepted document versions, never versions carried by an earlier conversation topic.
  sources?: Array<{ sourceId: string; version: string }>;
  // Completed judgment binds to sourceHashes.before; only sources contains currently accepted versions.
  supportVerification?: EvidenceSupportVerification;
  supportFailure?: EvidenceSupportFailure;
  supportProfile?: EvidenceSupportProfile; supportModel?: EvidenceSupportModel;
  supportPrompt?: KnowledgeSupportPrompt;
  applicability?: { mode: KnowledgeApplicabilityMode; gate?: Omit<KnowledgeApplicabilityResult, "candidates"> };
  sourceHashes: { before: string | null; after: string | null }; durationMs: number; calls: KnowledgeCall[];
  usage: { rerankTokens: number | null; supportTokens: number | null; estimatedCny: number | null; estimatedUsd: number | null; incompleteCalls: number };
  pricing: { estimated: true; rerankCnyPerMillionTokens: number | null; rerankAsOf: "2026-10-05"; supportSource: "Pi model catalog" };
  settings?: { rerank?: BailianClient["settings"]; support?: EvidenceSupportSettings; serialization: "json-title-tags-body-v1";
    applicability?: ReturnType<typeof knowledgeApplicabilitySettings> };
  stages?: Array<{ name: KnowledgeStage; observedAt: string; durationMs: number }>;
};
export type KnowledgeSearchInput = { query: string; retrievalQuery?: string; originalQuery?: string; scope: RetrievalScope; applicabilityContext?: KnowledgeApplicabilityContext | null;
  signal?: AbortSignal; onStage?: (stage: KnowledgeStage) => void };
export type KnowledgeSearchResult = { documents: KnowledgeDocuments; trace: KnowledgeTrace };
export type KnowledgeService = { search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> };
export type KnowledgeServiceOptions = { mode?: KnowledgeMode; threshold?: number; timeoutMs?: number; supportProfile?: EvidenceSupportProfile; supportModel?: EvidenceSupportModel;
  supportPrompt?: KnowledgeSupportPrompt;
  queryMode?: KnowledgeQueryMode;
  applicability?: KnowledgeApplicabilityMode; applicabilitySnapshot?: KnowledgeApplicabilitySnapshot;
  clients?: { rerank?: Pick<BailianClient, "settings" | "rerank">; support?: EvidenceSupportClient } };

export function knowledgeApplicabilitySettings(snapshot: KnowledgeApplicabilitySnapshot) {
  return { version: "declared-order-preconditions-v1" as const, snapshotHash: snapshot.sha256, serialization: snapshot.serialization };
}

// Shared with the offline scorer. Filtering applies only to the score gate's original Top5.
// Exclusions and unknown facts remain separate from a model's valid unsupported decision.
export function applyKnowledgeApplicabilityGate(prepared: EvidenceAcceptanceResult, gate: KnowledgeApplicabilityResult): EvidenceAcceptanceResult {
  if (prepared.config.mode !== "support") throw new Error("声明前提门控仅适用于支持判别候选。");
  const result = structuredClone(prepared), kept = new Set(gate.candidates.map(candidate => candidate.id));
  result.pendingSupport = gate.status === "ready" ? structuredClone(gate.candidates) : [];
  result.rejected = result.rejected.filter(row => row.reason !== "support_verification_required" || kept.has(row.id!));
  for (const candidate of prepared.pendingSupport ?? []) {
    if (gate.status === "unavailable") result.rejected.push({ id: candidate.id, rank: candidate.rank, reason: "applicability_unavailable" });
    else if (!kept.has(candidate.id)) result.rejected.push({ id: candidate.id, rank: candidate.rank,
      reason: gate.decisions.find(row => row.id === candidate.id)?.status === "mismatched" ? "applicability_mismatch" : "applicability_unknown" });
  }
  result.accepted = [];
  result.status = result.pendingSupport.length || gate.status === "unavailable" || !gate.integrity ? "unavailable" : "rejected";
  return result;
}

export function finishKnowledgeApplicabilityAcceptance(acceptance: EvidenceAcceptanceResult, gate?: KnowledgeApplicabilityResult): EvidenceAcceptanceResult {
  return gate && (gate.status === "unavailable" || !gate.integrity && !acceptance.accepted.length)
    ? { ...acceptance, accepted: [], status: "unavailable" } : acceptance;
}

// No document/result cache: every business request reads and rechecks the current authorized source.
export function createKnowledgeService(store: Pick<CouponStore, "readKnowledgeDocuments">, options: KnowledgeServiceOptions = {}): KnowledgeService {
  const mode = options.mode ?? "lexical", threshold = options.threshold ?? .71, timeoutMs = options.timeoutMs ?? 60_000;
  const supportProfile = options.supportProfile ?? "binary", supportModel = options.supportModel ?? "configured";
  const supportPrompt = options.supportPrompt ?? "v5";
  if (!["v5", "v6"].includes(supportPrompt) || supportPrompt === "v6" && (mode !== "m4-support" || supportProfile !== "typed")) throw new Error("v6 支持提示词仅适用于 m4-support + typed。");
  const typedPromptVersion = supportPrompt === "v6" ? evidenceSupportTypedV6PromptVersion : evidenceSupportTypedPromptVersion;
  const promptMatches = (client: EvidenceSupportClient) => client.settings.promptVersion === (supportProfile === "typed" ? typedPromptVersion : evidenceSupportPromptVersion)
    && client.settings.promptHash === contentHash(supportProfile === "binary" ? evidenceSupportPrompt : supportPrompt === "v6" ? evidenceSupportTypedV6Prompt : evidenceSupportTypedPrompt);
  const queryMode = options.queryMode ?? "combined";
  if (!["combined", "separated"].includes(queryMode) || queryMode === "separated" && mode !== "m4-support") throw new Error("查询分离仅适用于 m4-support 知识检索。");
  const applicability = options.applicability ?? "model_only";
  if (!["model_only", "declared"].includes(applicability) || applicability === "declared" && mode !== "m4-support") throw new Error("声明前提门控仅适用于 m4-support 知识检索。");
  if (mode === "lexical" && supportModel !== "configured") throw new Error("固定支持判别模型仅适用于 m4-support 知识检索。");
  const selectedModel = resolveEvidenceSupportModel(supportModel);
  const modelMatches = (client: EvidenceSupportClient) => client.settings.provider === selectedModel.provider && client.settings.model === selectedModel.model;
  if (options.clients?.support && !modelMatches(options.clients.support)) throw new Error("知识配置与注入的支持判别模型不一致。");
  if (!["binary", "typed"].includes(supportProfile) || mode === "lexical" && supportProfile !== "binary") throw new Error("typed 支持判别仅适用于 m4-support 知识检索。");
  if (options.clients?.support && (options.clients.support.settings.profile ?? "binary") !== supportProfile) throw new Error("知识配置与注入的支持判别 profile 不一致。");
  if (options.clients?.support && !promptMatches(options.clients.support)) throw new Error("知识配置与注入的支持判别 Prompt 版本或内容不一致。");
  if (!["lexical", "m4-support"].includes(mode) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new Error("知识服务模式或超时配置无效。");
  resolveEvidenceAcceptance({ mode: "support", threshold }, ["M4"]);
  let rerankClient = options.clients?.rerank, supportClient = options.clients?.support;
  let supportLoading: Promise<EvidenceSupportClient> | undefined;
  let applicabilityLoading: Promise<KnowledgeApplicabilitySnapshot> | undefined;
  const loadApplicability = () => applicabilityLoading ??= options.applicabilitySnapshot ? Promise.resolve().then(() => {
    const { sha256, ...manifest } = options.applicabilitySnapshot!;
    return validateKnowledgeApplicabilitySnapshot(manifest, sha256);
  }) : loadKnowledgeApplicabilitySnapshot();
  return { async search(input) {
    // The host builds both inputs. Shortening retrieval never removes facts
    // from support verification, nor adds an LLM rewrite stage.
    const retrievalQuery = queryMode === "separated" ? input.retrievalQuery : input.query;
    const started = performance.now(), deadline = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const trace: KnowledgeTrace = { mode, supportProfile, supportModel, supportPrompt, applicability: { mode: applicability }, threshold: mode === "lexical" ? null : threshold, query: retrievalQuery ?? "",
      originalQuery: input.originalQuery ?? input.query, scope: { shopId: input.scope?.shopId ?? null, productId: input.scope?.productId ?? null },
      status: "unavailable", reason: null, rawRanking: [], acceptance: null, sources: [], sourceHashes: { before: null, after: null }, durationMs: 0, calls: [],
      usage: { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
      pricing: { estimated: true, rerankCnyPerMillionTokens: null, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" }, stages: [] };
    let stage: KnowledgeStage = "read";
    let stageStarted = started;
    const endStage = () => { const last = trace.stages!.at(-1); if (last) last.durationMs = performance.now() - stageStarted; };
    const enter = (next: KnowledgeStage) => {
      signal.throwIfAborted(); endStage(); stage = next; stageStarted = performance.now();
      trace.stages!.push({ name: next, observedAt: new Date().toISOString(), durationMs: 0 });
      input.onStage?.(next); signal.throwIfAborted();
    };
    async function wait<T>(operation: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      let abort: () => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
      try { const value = await Promise.race([operation(), stopped]); signal.throwIfAborted(); return value; }
      finally { signal.removeEventListener("abort", abort); }
    }
    const read = async () => scopeDocuments(await wait(() => store.readKnowledgeDocuments(trace.scope.shopId ?? undefined, trace.scope.productId ?? undefined)), trace.scope);
    let documents: KnowledgeDocuments = [];
    try {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 500
        || typeof retrievalQuery !== "string" || !retrievalQuery.trim() || retrievalQuery.length > 500
        || input.retrievalQuery !== undefined && (typeof input.retrievalQuery !== "string" || !input.retrievalQuery.trim() || input.retrievalQuery.length > 500)
        || typeof trace.originalQuery !== "string" || trace.originalQuery.length > 5000 || !input.scope) {
        trace.reason = "invalid_input"; throw new Error();
      }
      try { scopeDocuments([], input.scope); } catch { trace.reason = "invalid_input"; throw new Error(); }
      trace.queries = { version: knowledgeQueryPlanVersion, mode: queryMode, retrieval: retrievalQuery, evidence: input.query };
      enter("read");
      const before = await read(); trace.sourceHashes.before = contentHash(before);
      if (mode === "lexical") trace.rawRanking = rankLexical(retrievalQuery, before, trace.scope).map(id => ({ id, score: null }));
      else if (before.length) {
        enter("rerank");
        rerankClient ??= createBailianClient({ timeoutMs, retries: 0 });
        if (rerankClient.settings.retries !== 0 || rerankClient.settings.rerankModel !== "qwen3-rerank"
          || rerankClient.settings.rerankInstruction !== rerankInstruction) throw new Error();
        trace.settings = { rerank: structuredClone(rerankClient.settings), serialization: "json-title-tags-body-v1" };
        const origin = new URL(rerankClient.settings.endpoints.origin);
        trace.pricing.rerankCnyPerMillionTokens = origin.hostname === "dashscope.aliyuncs.com" || origin.hostname.endsWith(".cn-beijing.maas.aliyuncs.com") ? .5 : null;
        const call: Extract<KnowledgeCall, { operation: "rerank" }> = { operation: "rerank", requestHash: null, attempts: [], status: "unavailable" };
        const recordCall = () => { if (!trace.calls.includes(call)) trace.calls.push(call); };
        try {
          let attempts = 0;
          const result = await wait(() => rerankClient!.rerank(retrievalQuery, before.map(serializeRetrievalDocument), { beforeAttempt: () => {
            if (signal.aborted || attempts++ !== 0) return false;
            recordCall(); return true;
          } }));
          call.requestHash = result.requestHash; call.attempts = result.attempts;
          if (call.attempts.length) recordCall(); // An injected transport may report completed attempts without using the hook.
          if (result.value.length !== before.length || new Set(result.value.map(row => row.index)).size !== before.length
            || result.value.some((row, index) => !Number.isSafeInteger(row.index) || !before[row.index] || typeof row.score !== "number"
              || !Number.isFinite(row.score) || row.score < 0 || row.score > 1 || index > 0 && row.score > result.value[index - 1]!.score)
            || result.attempts.length !== 1 || result.attempts[0]!.attempt !== 1 || result.attempts[0]!.outcome !== "ok") throw new Error();
          call.status = "ok";
          trace.rawRanking = result.value.map(row => ({ id: before[row.index]!.id, score: row.score }));
        } catch (error) {
          if (error instanceof BailianError) {
            call.attempts = error.attempts;
            if (call.attempts.length) recordCall();
            else if (!trace.calls.includes(call) && !signal.aborted) trace.reason = "invalid_input";
          }
          throw error;
        }
      }
      trace.acceptance = acceptEvidence({ config: mode === "lexical" ? { mode: "off" } : { mode: "support", threshold },
        query: retrievalQuery, documents: before, scope: trace.scope, ranking: trace.rawRanking });
      let applicabilityGate: KnowledgeApplicabilityResult | undefined;
      if (applicability === "declared") {
        enter("applicability");
        try {
          const snapshot = await wait(loadApplicability);
          applicabilityGate = gateKnowledgeApplicability({ snapshot, context: input.applicabilityContext ?? null,
            scope: trace.scope, candidates: trace.acceptance.pendingSupport ?? [] });
          const { candidates: _candidates, ...audit } = applicabilityGate;
          trace.applicability!.gate = structuredClone(audit);
          trace.settings = { ...trace.settings, serialization: "json-title-tags-body-v1", applicability: knowledgeApplicabilitySettings(snapshot) };
          trace.acceptance = applyKnowledgeApplicabilityGate(trace.acceptance, applicabilityGate);
        } catch (error) { if (!signal.aborted) trace.reason = "metadata_binding_invalid"; throw error; }
        if (applicabilityGate.status === "unavailable") trace.reason = "metadata_binding_invalid";
      }
      let verification: Awaited<ReturnType<typeof verifyEvidenceSupport>> | null = null;
      if (trace.acceptance.pendingSupport?.length) {
        enter("support");
        if (!supportClient) {
          supportLoading ??= createEvidenceSupportClient({ timeoutMs, profile: supportProfile, modelSelection: supportModel,
            ...(supportProfile === "typed" ? { typedPromptVersion } : {}),
            env: { ...process.env, MODEL_PROVIDER: selectedModel.provider, MODEL_ID: selectedModel.model } }).catch(error => { supportLoading = undefined; throw error; });
          supportClient = await wait(() => supportLoading!);
        }
        if (!modelMatches(supportClient) || !promptMatches(supportClient) || supportClient.settings.maxRetries !== 0 || (supportClient.settings.profile ?? "binary") !== supportProfile) throw new Error();
        trace.settings!.support = structuredClone(supportClient.settings);
        const call: Extract<KnowledgeCall, { operation: "support" }> = { operation: "support", requestHash: null, attempts: [], status: "unavailable" };
        try {
          verification = await wait(() => verifyEvidenceSupport({ query: input.query, scope: trace.scope,
            candidates: trace.acceptance!.pendingSupport!, client: supportClient!, beforeAttempt: () => {
              if (signal.aborted) return false;
              trace.calls.push(call); return true;
            } }));
          call.requestHash = verification.requestHash; call.attempts = verification.attempts;
          if (verification.attempts.length !== 1) throw new Error();
          trace.supportVerification = structuredClone(verification);
          call.status = verification.validation?.status === "partial" ? "partial" : verification.validation?.status === "unavailable" ? "unavailable" : "ok";
        } catch (error) {
          if (error instanceof EvidenceSupportError) {
            call.attempts = error.attempts;
            trace.supportFailure = { code: error.code, outputHash: error.outputHash };
          }
          if (!trace.calls.includes(call) && !signal.aborted) trace.reason = "invalid_input";
          throw error;
        }
      }
      enter("recheck");
      const after = await read(); trace.sourceHashes.after = contentHash(after);
      if (trace.sourceHashes.before !== trace.sourceHashes.after) { trace.reason = "source_changed"; throw new Error(); }
      if (verification) trace.acceptance = applyEvidenceSupport({ prepared: trace.acceptance, verification, query: input.query,
        scope: trace.scope, documents: after, settings: supportClient!.settings });
      trace.acceptance = finishKnowledgeApplicabilityAcceptance(trace.acceptance, applicabilityGate);
      signal.throwIfAborted();
      trace.status = trace.acceptance.status;
      if (trace.status === "unavailable") {
        if (applicabilityGate?.reason === "facts_unknown") trace.reason = "applicability_facts_unknown";
        else if (verification?.validation?.invalidDecisions.length) trace.reason = "invalid_support_decision";
        throw new Error();
      }
      const current = new Map(after.map(doc => [doc.id, doc]));
      documents = trace.acceptance.accepted.map(entry => {
        const doc = current.get(entry.id)!;
        return { source: "demo-knowledge", sourceId: doc.id, title: doc.title, body: doc.body,
          scope: { shopId: doc.shopId, productId: doc.productId ?? null } };
      });
      trace.sources = documents.map(doc => ({ sourceId: doc.sourceId, version: contentHash(doc) }));
    } catch {
      trace.status = "unavailable";
      trace.reason ??= input.signal?.aborted ? "aborted" : deadline.aborted ? "timeout"
        : stage === "read" || stage === "recheck" ? "database_unavailable" : "provider_unavailable";
      if (trace.acceptance) {
        trace.acceptance.accepted = []; delete trace.acceptance.pendingSupport; trace.acceptance.status = "unavailable";
        if (!["invalid_support_decision", "metadata_binding_invalid", "applicability_facts_unknown"].includes(trace.reason)) {
          trace.acceptance.rejected.push({ id: null, rank: null, reason: "provider_unavailable" });
        }
      }
    }
    for (const operation of ["rerank", "support"] as const) {
      const calls = trace.calls.filter(call => call.operation === operation), attempts = calls.flatMap<BailianAttempt | EvidenceSupportAttempt>(call => call.attempts);
      const complete = calls.every(call => call.attempts.length === 1 && call.attempts[0]!.totalTokens !== null);
      const tokens = complete ? attempts.reduce((sum, attempt) => sum + attempt.totalTokens!, 0) : null;
      trace.usage.incompleteCalls += calls.filter(call => !call.attempts.length || call.attempts.some(attempt => attempt.totalTokens === null)).length;
      if (operation === "rerank") {
        trace.usage.rerankTokens = tokens;
        trace.usage.estimatedCny = !calls.length ? 0 : tokens !== null && trace.pricing.rerankCnyPerMillionTokens !== null
          ? tokens * trace.pricing.rerankCnyPerMillionTokens / 1_000_000 : null;
      } else {
        trace.usage.supportTokens = tokens;
        trace.usage.estimatedUsd = calls.every(call => call.attempts.length === 1 && (call.attempts[0] as EvidenceSupportAttempt).costUsd !== null)
          ? calls.reduce((sum, call) => sum + (call.attempts[0] as EvidenceSupportAttempt).costUsd!, 0) : null;
      }
    }
    endStage(); trace.durationMs = performance.now() - started;
    return structuredClone({ documents, trace });
  } };
}
