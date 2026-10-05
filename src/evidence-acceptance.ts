import { scopeDocuments, type RetrievalDocument, type RetrievalScope } from "./retrieval-ranking.ts";

export type EvidenceAcceptanceConfig = { mode: "off" } | { mode: "score" | "support"; threshold: number };
export const evidenceAcceptanceVersion = "score-gate-v1";
export const evidenceSupportAcceptanceVersion = "score-support-v1";
export type EvidenceSupportCandidate = RetrievalDocument & { score: number | null; rank: number };
export const evidenceAcceptanceBinding = Object.freeze({ model: "qwen3-rerank", serialization: "json-title-tags-body-v1" });
export type EvidenceRanking = readonly { id: string; score: number | null }[];
export type EvidenceRejectionReason = "provider_unavailable" | "not_applicable" | "no_candidates" | "unknown_document"
  | "inactive_document" | "out_of_scope" | "duplicate_document" | "missing_score" | "invalid_score" | "below_threshold" | "top_k_limit" | "support_verification_required" | "unsupported" | "support_unavailable" | "invalid_support_decision"
  | "applicability_mismatch" | "applicability_unknown" | "applicability_unavailable";
export type EvidenceAcceptanceResult = {
  version: typeof evidenceAcceptanceVersion | typeof evidenceSupportAcceptanceVersion; config: EvidenceAcceptanceConfig; status: "accepted" | "rejected" | "unavailable";
  accepted: Array<{ id: string; title: string; body: string; tags: readonly string[]; score: number | null; rank: number }>;
  pendingSupport?: EvidenceSupportCandidate[];
  rejected: Array<{ id: string | null; rank: number | null; reason: EvidenceRejectionReason }>;
  diagnostics: { topScore: number | null; scoreGap: number | null;
    candidates: Array<{ id: string; rank: number; scoreMargin: number | null; titleMatch: boolean; matchedTags: string[] }> };
};

export function resolveEvidenceAcceptance(input: unknown = { mode: "off" }, modes?: readonly string[]): EvidenceAcceptanceConfig {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error("证据接收配置必须是对象。");
  }
  const value = input as Record<string, unknown>;
  if (!["off", "score", "support"].includes(String(value.mode)) || Reflect.ownKeys(value).some(key => key !== "mode" && (!["score", "support"].includes(String(value.mode)) || key !== "threshold"))) {
    throw new Error("证据接收配置包含未知策略或字段。");
  }
  if (value.mode === "off") return { mode: "off" };
  if ((value.mode !== "score" && value.mode !== "support") || typeof value.threshold !== "number" || !Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > 1) {
    throw new Error("证据接收 threshold 必须是 0–1 的有限数值；不提供默认阈值。");
  }
  if (modes && (!modes.length || modes.some(mode => !["M4", "M5", "M6"].includes(mode)))) {
    throw new Error("分数接收策略仅适用于 M4/M5/M6 rerank 模式。");
  }
  return { mode: value.mode, threshold: value.threshold };
}

// No labels enter this function: authorization, current document state and the configured
// score gate alone decide which original passages may become evidence. Raw ranking is never mutated.
export function acceptEvidence(input: { config?: EvidenceAcceptanceConfig; scope: RetrievalScope; documents: readonly RetrievalDocument[];
  ranking: EvidenceRanking; query?: string; status?: "ok" | "provider_error" | "not_applicable" }): EvidenceAcceptanceResult {
  const config = resolveEvidenceAcceptance(input.config), visible = new Set(scopeDocuments(input.documents, input.scope).map(doc => doc.id));
  const documents = new Map(input.documents.map(doc => [doc.id, doc])), seen = new Set<string>();
  const normalized = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  const query = normalized(input.query ?? "");
  const validScore = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const scores = input.ranking.slice(0, 2).map(row => validScore(row.score) ? row.score : null);
  const result: EvidenceAcceptanceResult = { version: config.mode === "support" ? evidenceSupportAcceptanceVersion : evidenceAcceptanceVersion, config, status: "rejected", accepted: [], rejected: [],
    diagnostics: { topScore: scores[0] ?? null, scoreGap: scores[0] != null && scores[1] != null ? scores[0] - scores[1] : null,
      candidates: input.ranking.map((row, index) => { const doc = documents.get(row.id); return { id: row.id, rank: index + 1,
        scoreMargin: config.mode !== "off" && validScore(row.score) ? row.score - config.threshold : null,
        titleMatch: Boolean(query && doc?.title.trim() && query.includes(normalized(doc.title))),
        matchedTags: doc?.tags.filter(tag => normalized(tag) && query.includes(normalized(tag))) ?? [] }; }) } };
  if (input.status && input.status !== "ok") {
    result.status = "unavailable";
    result.rejected.push({ id: null, rank: null, reason: input.status === "provider_error" ? "provider_unavailable" : "not_applicable" });
    return result;
  }
  for (const [index, row] of input.ranking.entries()) {
    const doc = documents.get(row.id); let reason: EvidenceRejectionReason | null = null;
    if (seen.has(row.id)) reason = "duplicate_document";
    else if (!doc) reason = "unknown_document";
    else if (doc.status === "inactive") reason = "inactive_document";
    else if (!visible.has(row.id)) reason = "out_of_scope";
    else if (config.mode !== "off" && row.score == null) reason = "missing_score";
    else if (config.mode !== "off" && !validScore(row.score)) reason = "invalid_score";
    else if (config.mode !== "off" && row.score! < config.threshold) reason = "below_threshold";
    else if (result.accepted.length >= 5) reason = "top_k_limit";
    seen.add(row.id);
    if (reason) result.rejected.push({ id: row.id, rank: index + 1, reason });
    else result.accepted.push({ id: row.id, title: doc!.title, body: doc!.body, tags: [...doc!.tags], score: row.score, rank: index + 1 });
  }
  if (!input.ranking.length) result.rejected.push({ id: null, rank: null, reason: "no_candidates" });
  if (result.accepted.length) result.status = "accepted";
  if (config.mode === "support") {
    result.pendingSupport = result.accepted.map(row => ({ ...documents.get(row.id)!, tags: [...documents.get(row.id)!.tags], score: row.score, rank: row.rank }));
    result.rejected.push(...result.accepted.map(row => ({ id: row.id, rank: row.rank, reason: "support_verification_required" as const })));
    result.accepted = [];
    if (result.pendingSupport.length) result.status = "unavailable";
  }
  return result;
}
