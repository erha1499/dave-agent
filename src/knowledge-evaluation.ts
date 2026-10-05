import type { EvalSpan } from "./evaluation.ts";
import type { EvidenceSupportAttempt } from "./evidence-support.ts";

// Usage belongs only to provider children, never to both the service parent and Agent steps.
export function knowledgeProviderSpans(parent: EvalSpan): EvalSpan[] {
  const trace = parent.knowledge?.trace;
  if (!trace) return [];
  return trace.calls.flatMap<EvalSpan>((call, callIndex) => {
    const stage = trace.stages?.find(stage => stage.name === call.operation);
    const base = { parentSpanId: parent.id, actor: "host" as const, trigger: parent.trigger,
      component: `knowledge-${call.operation}`, name: call.operation, observedAt: stage?.observedAt ?? parent.observedAt,
      input: { requestHash: call.requestHash, timing: stage ? "stage-start/request-duration" : "parent-start/request-duration" } };
    if (!call.attempts.length) return [{ ...base, id: `${parent.id}:knowledge:${callIndex}:unreported`, durationMs: null,
      outcome: "error" as const, output: { status: call.status, requestAccounting: "unreported", note: "请求未形成完整 attempt，不能补造用量或声称零费用。" },
      usage: { provider: call.operation === "support" ? trace.settings?.support?.provider ?? "unknown" : trace.settings?.rerank ? "bailian" : "unknown",
        model: call.operation === "support" ? trace.settings?.support?.model ?? "unknown" : trace.settings?.rerank?.rerankModel ?? "unknown",
        kind: call.operation === "support" ? "llm" as const : "rerank" as const,
        inputTokens: null, outputTokens: null, totalTokens: null, cost: null } }];
    return call.attempts.map((attempt, index) => {
      const support = call.operation === "support" ? attempt as EvidenceSupportAttempt : null;
      const cnyRate = trace.pricing.rerankCnyPerMillionTokens;
      const cost = support ? support.costUsd === null ? null : { currency: "USD" as const, amount: support.costUsd, source: "sdk_estimate" as const }
        : cnyRate === null || attempt.totalTokens === null ? null : { currency: "CNY" as const,
          amount: attempt.totalTokens * cnyRate / 1_000_000, source: "price_estimate" as const };
      return { ...base, id: `${parent.id}:knowledge:${callIndex}:${index + 1}`, durationMs: attempt.durationMs,
        outcome: attempt.outcome === "ok" ? "ok" as const : "error" as const, output: { status: call.status, attempt: structuredClone(attempt) },
        usage: { provider: support?.provider ?? "bailian", model: attempt.model, kind: support ? "llm" as const : "rerank" as const,
          inputTokens: support && [support.inputTokens, support.cacheReadTokens, support.cacheWriteTokens].every(value => value !== null)
            ? support.inputTokens! + support.cacheReadTokens! + support.cacheWriteTokens! : null,
          outputTokens: support?.outputTokens ?? null, totalTokens: attempt.totalTokens, cost } };
    });
  });
}
