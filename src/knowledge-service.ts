import { BailianError, contentHash, createBailianClient, rerankInstruction, type BailianAttempt, type BailianClient } from "./bailian.ts";
import type { CouponStore } from "./coupon-store.ts";
import { acceptEvidence, resolveEvidenceAcceptance, type EvidenceAcceptanceResult, type EvidenceRanking } from "./evidence-acceptance.ts";
import { applyEvidenceSupport, createEvidenceSupportClient, EvidenceSupportError, verifyEvidenceSupport, resolveEvidenceSupportModel,
  type EvidenceSupportAttempt, type EvidenceSupportClient, type EvidenceSupportModel, type EvidenceSupportProfile, type EvidenceSupportFailure, type EvidenceSupportSettings, type EvidenceSupportVerification } from "./evidence-support.ts";
import { rankLexical, scopeDocuments, serializeRetrievalDocument, type RetrievalScope } from "./retrieval-ranking.ts";

export type KnowledgeMode = "lexical" | "m4-support";
export type KnowledgeStage = "read" | "rerank" | "support" | "recheck";
export type KnowledgeDocuments = Awaited<ReturnType<CouponStore["searchKnowledge"]>>;
export type KnowledgeCall = { operation: "rerank"; requestHash: string | null; attempts: BailianAttempt[]; status: "ok" | "unavailable" }
  | { operation: "support"; requestHash: string | null; attempts: EvidenceSupportAttempt[]; status: "ok" | "unavailable" };
export type KnowledgeTrace = {
  mode: KnowledgeMode; threshold: number | null; query: string; originalQuery: string; scope: RetrievalScope;
  status: "accepted" | "rejected" | "unavailable";
  reason: null | "invalid_input" | "aborted" | "timeout" | "database_unavailable" | "provider_unavailable" | "source_changed";
  rawRanking: EvidenceRanking; acceptance: EvidenceAcceptanceResult | null;
  // Current accepted document versions, never versions carried by an earlier conversation topic.
  sources?: Array<{ sourceId: string; version: string }>;
  // Completed judgment binds to sourceHashes.before; only sources contains currently accepted versions.
  supportVerification?: EvidenceSupportVerification;
  supportFailure?: EvidenceSupportFailure;
  supportProfile?: EvidenceSupportProfile; supportModel?: EvidenceSupportModel;
  sourceHashes: { before: string | null; after: string | null }; durationMs: number; calls: KnowledgeCall[];
  usage: { rerankTokens: number | null; supportTokens: number | null; estimatedCny: number | null; estimatedUsd: number | null; incompleteCalls: number };
  pricing: { estimated: true; rerankCnyPerMillionTokens: number | null; rerankAsOf: "2026-10-05"; supportSource: "Pi model catalog" };
  settings?: { rerank?: BailianClient["settings"]; support?: EvidenceSupportSettings; serialization: "json-title-tags-body-v1" };
  stages?: Array<{ name: KnowledgeStage; observedAt: string; durationMs: number }>;
};
export type KnowledgeSearchInput = { query: string; originalQuery?: string; scope: RetrievalScope; signal?: AbortSignal; onStage?: (stage: KnowledgeStage) => void };
export type KnowledgeSearchResult = { documents: KnowledgeDocuments; trace: KnowledgeTrace };
export type KnowledgeService = { search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> };
export type KnowledgeServiceOptions = { mode?: KnowledgeMode; threshold?: number; timeoutMs?: number; supportProfile?: EvidenceSupportProfile; supportModel?: EvidenceSupportModel;
  clients?: { rerank?: Pick<BailianClient, "settings" | "rerank">; support?: EvidenceSupportClient } };

// No document/result cache: every business request reads and rechecks the current authorized source.
export function createKnowledgeService(store: Pick<CouponStore, "readKnowledgeDocuments">, options: KnowledgeServiceOptions = {}): KnowledgeService {
  const mode = options.mode ?? "lexical", threshold = options.threshold ?? .71, timeoutMs = options.timeoutMs ?? 60_000;
  const supportProfile = options.supportProfile ?? "binary", supportModel = options.supportModel ?? "configured";
  if (mode === "lexical" && supportModel !== "configured") throw new Error("固定支持判别模型仅适用于 m4-support 知识检索。");
  const selectedModel = resolveEvidenceSupportModel(supportModel);
  const modelMatches = (client: EvidenceSupportClient) => client.settings.provider === selectedModel.provider && client.settings.model === selectedModel.model;
  if (options.clients?.support && !modelMatches(options.clients.support)) throw new Error("知识配置与注入的支持判别模型不一致。");
  if (!["binary", "typed"].includes(supportProfile) || mode === "lexical" && supportProfile !== "binary") throw new Error("typed 支持判别仅适用于 m4-support 知识检索。");
  if (options.clients?.support && (options.clients.support.settings.profile ?? "binary") !== supportProfile) throw new Error("知识配置与注入的支持判别 profile 不一致。");
  if (!["lexical", "m4-support"].includes(mode) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new Error("知识服务模式或超时配置无效。");
  resolveEvidenceAcceptance({ mode: "support", threshold }, ["M4"]);
  let rerankClient = options.clients?.rerank, supportClient = options.clients?.support;
  let supportLoading: Promise<EvidenceSupportClient> | undefined;
  return { async search(input) {
    const started = performance.now(), deadline = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const trace: KnowledgeTrace = { mode, supportProfile, supportModel, threshold: mode === "lexical" ? null : threshold, query: input.query,
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
        || typeof trace.originalQuery !== "string" || trace.originalQuery.length > 5000 || !input.scope) {
        trace.reason = "invalid_input"; throw new Error();
      }
      try { scopeDocuments([], input.scope); } catch { trace.reason = "invalid_input"; throw new Error(); }
      enter("read");
      const before = await read(); trace.sourceHashes.before = contentHash(before);
      if (mode === "lexical") trace.rawRanking = rankLexical(input.query, before, trace.scope).map(id => ({ id, score: null }));
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
          const result = await wait(() => rerankClient!.rerank(input.query, before.map(serializeRetrievalDocument), { beforeAttempt: () => {
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
        query: input.query, documents: before, scope: trace.scope, ranking: trace.rawRanking });
      let verification: Awaited<ReturnType<typeof verifyEvidenceSupport>> | null = null;
      if (trace.acceptance.pendingSupport?.length) {
        enter("support");
        if (!supportClient) {
          supportLoading ??= createEvidenceSupportClient({ timeoutMs, profile: supportProfile, modelSelection: supportModel,
            env: { ...process.env, MODEL_PROVIDER: selectedModel.provider, MODEL_ID: selectedModel.model } }).catch(error => { supportLoading = undefined; throw error; });
          supportClient = await wait(() => supportLoading!);
        }
        if (!modelMatches(supportClient) || supportClient.settings.maxRetries !== 0 || (supportClient.settings.profile ?? "binary") !== supportProfile) throw new Error();
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
          call.status = "ok";
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
      signal.throwIfAborted();
      trace.status = trace.acceptance.status;
      if (trace.status === "unavailable") throw new Error();
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
        trace.acceptance.rejected.push({ id: null, rank: null, reason: "provider_unavailable" });
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
