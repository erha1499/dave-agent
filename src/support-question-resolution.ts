import { contentHash } from "./bailian.ts";
import type { TrustedPolicyTopic } from "./support-controller.ts";
import { policyTopicQueries } from "./support-evidence-context.ts";
import type { ModelPricing } from "./model-selection.ts";

export const supportQuestionResolutionVersion = "support-question-resolution-v1" as const;
export type SupportQuestionResolutionInput = {
  requestId: string; originalQuery: string;
  previousTopic: null | { requestId: string; queries: Array<{ requestId: string; originalQuery: string }> };
};
export type SupportQuestionResolution = {
  version: typeof supportQuestionResolutionVersion; inputHash: string;
  decision: "current_complete" | "previous_resolved" | "needs_clarification";
  currentQuotes: string[]; previousRequestId: string | null;
};
export type SupportQuestionSettings = {
  provider: string; model: string; api: string; endpoint: string; timeoutMs: number;
  temperature: 0; maxTokens: number; maxRetries: 0;
  promptVersion: "support-question-prompt-v1"; promptHash: string;
  serialization: "json-question-resolution-v1"; pricing: ModelPricing;
};
export type SupportQuestionAttempt = {
  operation: "question"; provider: string; model: string; attempt: 1; durationMs: number;
  outcome: "ok" | "invalid_response" | "provider_error" | "aborted" | "timeout";
  httpRequests: 0 | 1; wireHash: string | null; outputHash: string | null;
  totalTokens: number | null; inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
  costUsd: number | null; costCny?: number | null;
};
export type SupportQuestionTrace = {
  version: "support-question-trace-v1"; inputHash: string; requestHash: string;
  settings: SupportQuestionSettings; attempts: SupportQuestionAttempt[];
  value: SupportQuestionResolution | null;
  failure: "invalid_response" | "provider_error" | "aborted" | "timeout" | null;
};
export type SupportQuestionObservation = {
  requestId: string; observedAt: string; input: SupportQuestionResolutionInput; trace: SupportQuestionTrace;
};
// The resolver judges semantics. These helpers verify only shape and provenance.
export type SupportQuestionResolver = {
  settings?: SupportQuestionSettings;
  resolve(input: SupportQuestionResolutionInput, options?: {
    signal?: AbortSignal; onTrace?: (trace: SupportQuestionTrace) => void;
  }): Promise<SupportQuestionResolution>;
};

const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
function array(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) return false;
  const indices = Array.from({ length: value.length }, (_item, index) => String(index));
  return Reflect.ownKeys(value).length === value.length + 1 && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && indices.includes(key))
    && indices.every(index => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    return Boolean(descriptor?.enumerable && "value" in descriptor);
  });
}
export function validateSupportQuestionResolutionInput(value: unknown): value is SupportQuestionResolutionInput {
  if (!keys(value, ["requestId", "originalQuery", "previousTopic"]) || !text(value.requestId, 512) || !text(value.originalQuery, 500)) return false;
  const previous = value.previousTopic;
  if (previous === null) return true;
  if (!keys(previous, ["requestId", "queries"]) || !text(previous.requestId, 512) || !array(previous.queries, 1, 5)) return false;
  const queries = previous.queries;
  if (!queries.every(query => keys(query, ["requestId", "originalQuery"]) && text(query.requestId, 512) && text(query.originalQuery, 500))) return false;
  const rows = queries as Array<{ requestId: string; originalQuery: string }>;
  return rows.at(-1)!.requestId === previous.requestId && new Set(rows.map(row => row.requestId)).size === rows.length
    && !rows.some(row => row.requestId === value.requestId) && rows.reduce((sum, row) => sum + row.originalQuery.length, 0) <= 500;
}
function freezeInput(input: SupportQuestionResolutionInput): SupportQuestionResolutionInput {
  if (input.previousTopic) {
    input.previousTopic.queries.forEach(Object.freeze); Object.freeze(input.previousTopic.queries); Object.freeze(input.previousTopic);
  }
  return Object.freeze(input);
}
// The caller must select and authorize the topic first, including fresh scope.
// No order facts, model rewrite, documents, or answers enter the resolver input.
export function buildSupportQuestionResolutionInput(input: {
  requestId: string; originalQuery: string; previousTopic?: TrustedPolicyTopic | null;
}): SupportQuestionResolutionInput {
  const previous = input.previousTopic;
  if (previous !== undefined && previous !== null && (typeof previous !== "object" || Array.isArray(previous))) throw new Error("咨询问题解析的前序话题无效。");
  const queries = previous ? policyTopicQueries(previous) : undefined;
  if (previous && !queries) throw new Error("咨询问题解析的前序原问链无效或超出恢复预算。");
  const value = { requestId: input.requestId, originalQuery: input.originalQuery,
    previousTopic: previous ? { requestId: previous.requestId, queries: queries! } : null };
  if (!validateSupportQuestionResolutionInput(value)) throw new Error("咨询问题解析输入无效或超出恢复预算。");
  return freezeInput(value);
}
export function supportQuestionResolutionInputHash(input: SupportQuestionResolutionInput): string {
  if (!validateSupportQuestionResolutionInput(input)) throw new Error("咨询问题解析输入无效或超出恢复预算。");
  return contentHash({ requestId: input.requestId, originalQuery: input.originalQuery, previousTopic: input.previousTopic
    ? { requestId: input.previousTopic.requestId, queries: input.previousTopic.queries.map(query => ({ requestId: query.requestId, originalQuery: query.originalQuery })) } : null });
}
export function validateSupportQuestionResolution(value: unknown, input: SupportQuestionResolutionInput): value is SupportQuestionResolution {
  if (!validateSupportQuestionResolutionInput(input) || !keys(value, ["version", "inputHash", "decision", "currentQuotes", "previousRequestId"])
    || value.version !== supportQuestionResolutionVersion || value.inputHash !== supportQuestionResolutionInputHash(input)
    || typeof value.decision !== "string" || !["current_complete", "previous_resolved", "needs_clarification"].includes(value.decision)
    || !array(value.currentQuotes, value.decision === "needs_clarification" ? 0 : 1, 5)
    || !value.currentQuotes.every(quote => text(quote, 500) && input.originalQuery.includes(quote))) return false;
  if (value.decision === "current_complete") return value.previousRequestId === null;
  if (value.decision === "needs_clarification") return value.previousRequestId === null
    || Boolean(input.previousTopic && value.previousRequestId === input.previousTopic.requestId);
  // Appending this current question must still yield a valid existing topic chain.
  return Boolean(input.previousTopic && value.previousRequestId === input.previousTopic.requestId && input.previousTopic.queries.length < 5
    && input.previousTopic.queries.reduce((sum, row) => sum + row.originalQuery.length, input.originalQuery.length) <= 500);
}
export function requireSupportQuestionResolution(value: unknown, input: SupportQuestionResolutionInput): SupportQuestionResolution {
  if (!validateSupportQuestionResolution(value, input)) throw new Error("咨询问题解析结果未通过原文及引用校验。");
  const copy = structuredClone(value); Object.freeze(copy.currentQuotes); return Object.freeze(copy);
}
