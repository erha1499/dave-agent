import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportTypedV7PromptVersion,
  validateEvidenceSupport, validateEvidenceSupportVerification, verifyEvidenceSupport, type EvidenceSupportAttempt, type EvidenceSupportCandidate,
  type EvidenceSupportCategory, type EvidenceSupportClient, type EvidenceSupportSettings, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import { estimateModelUsage, type ModelSelection } from "../src/model-selection.ts";
import { scopeDocuments, type RetrievalScope } from "../src/retrieval-ranking.ts";
import { c1ValidationCodeFiles, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url), dataPath = "data/c1-model-support-comparison.json";
const manifestPath = "data/c1-model-support-comparison-manifest.json", scriptPath = "scripts/c1-model-support-comparison.ts";
const stage = "fresh-fixed-input-model-comparison-not-blind";
export const modelSupportComparisonLimits = { maxSupportHttp: 24, maxAgentHttp: 0, maxRerankHttp: 0, maxDatabaseRequests: 0,
  maxQqRequests: 0, maxEstimatedCostUsd: .08, maxEstimatedCostCny: .20, maxDurationMs: 600_000,
  perRequestTimeoutMs: 60_000, maxTokens: 2048, maxRetries: 0, temperature: 0 } as const;
export const modelSupportComparisonArms = { A: "deepseek-v4-pro", B: "qwen3.7-plus-2026-05-26" } as const satisfies Record<string, ModelSelection>;
const wireContracts = { A: { instructionRole: "system", outputLimitField: "max_tokens" },
  B: { instructionRole: "system", outputLimitField: "max_completion_tokens" } } as const;
type Arm = keyof typeof modelSupportComparisonArms;
type Gold = { id: string; category: EvidenceSupportCategory; supported: boolean; evidenceQuote: string; reason: string };
export type ModelSupportComparisonCase = { id: string; group: string; query: string; scope: RetrievalScope;
  candidates: EvidenceSupportCandidate[]; inputHash: string; expectedByCandidate: Gold[] };
export type ModelSupportComparisonData = { version: 1; suiteId: string; stage: string; syntheticBoundary: string;
  sources: Array<{ kind: "original-synthetic"; description: string }>;
  measurement: { plannedInputs: number; plannedArms: number; plannedHttp: number; candidateDecisionsPerArm: number;
    positiveCandidateDecisionsPerArm: number; negativeCandidateDecisionsPerArm: number;
    selections: string[]; profile: string; promptVersion: string; plannedInputsBySet: { no_answer: number; mixed: number; positive_control: number };
    scope: string; decision: string; stopCondition: string };
  limits: typeof modelSupportComparisonLimits; cases: ModelSupportComparisonCase[] };
type Output = { text: string; stopReason: string; outputHash: string; truncated: boolean };
export type ModelSupportComparisonRow = { id: string; group: string; arm: Arm; selection: ModelSelection; sequence: number;
  execution: "not_run" | "completed" | "error"; verification?: EvidenceSupportVerification; attempts?: EvidenceSupportAttempt[];
  output: Output | null; error?: string; errorOutputHash?: string | null; notRunReason?: string };
type WireUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  prompt_cache_hit_tokens?: number; cached_tokens?: number };
export type ModelSupportComparisonRequest = { index: number; operation: "support"; arm: Arm; caseId: string; inputHash: string;
  sequence: number; requestId: string; provider: string; model: string; endpoint: string; method: "POST"; body: Record<string, unknown>;
  bodyText: string; bodyHash: string; requestHash: string; settingsHash: string; sentAt: string; httpStatus: number | null;
  httpError: "network_error" | "http_error" | "response_capture_error" | null; responseHash: string | null;
  responseModels: string[]; rawUsage: WireUsage | null; durationMs: number | null; attempt: number | null;
  totalTokens: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; currency: "USD" | "CNY"; estimatedCost: number | null; usageRecorded: boolean };
type Settings = Record<Arm, EvidenceSupportSettings>;
const arms: Arm[] = ["A", "B"], groups = ["channel", "actor", "condition", "regression"];
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object"
  && Object.getPrototypeOf(value) === Object.prototype);
const token = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function checkInputs(data: ModelSupportComparisonData) {
  assert.equal(data.version, 1); assert.equal(data.stage, stage); assert.ok(data.suiteId && data.syntheticBoundary.trim());
  assert.ok(data.sources.length && data.sources.every(source => source.kind === "original-synthetic" && source.description.trim()));
  assert.deepEqual(data.limits, modelSupportComparisonLimits);
  const m = data.measurement;
  assert.deepEqual([m.plannedInputs, m.plannedArms, m.plannedHttp, m.candidateDecisionsPerArm,
    m.positiveCandidateDecisionsPerArm, m.negativeCandidateDecisionsPerArm], [12, 2, 24, 24, 12, 12]);
  assert.deepEqual(m.selections, Object.values(modelSupportComparisonArms)); assert.equal(m.profile, "typed");
  assert.equal(m.promptVersion, evidenceSupportTypedV7PromptVersion);
  assert.deepEqual(m.plannedInputsBySet, { no_answer: 4, mixed: 4, positive_control: 4 });
  assert.ok(m.scope.trim() && m.decision.trim() && m.stopCondition.trim());
  assert.equal(data.cases.length, 12); assert.equal(new Set(data.cases.map(item => item.id)).size, 12);
  assert.deepEqual(groups.map(group => data.cases.filter(item => item.group === group).length), [3, 3, 3, 3]);
  for (const [index, item] of data.cases.entries()) {
    assert.equal(item.id, `model-${String(index + 1).padStart(3, "0")}`);
    assert.ok(item.query.trim() && item.query.length <= 500); assert.equal(item.candidates.length, 2);
    assert.equal(item.inputHash, contentHash({ query: item.query, scope: item.scope, candidates: item.candidates }));
    assert.equal(scopeDocuments(item.candidates, item.scope).length, 2);
    assert.deepEqual(item.candidates.map(candidate => [candidate.rank, candidate.score]), [[1, .88], [2, .81]]);
    assert.equal(new Set(item.candidates.map(candidate => candidate.id)).size, 2);
    assert.deepEqual(item.expectedByCandidate.map(gold => gold.id).sort(), item.candidates.map(candidate => candidate.id).sort());
    for (const gold of item.expectedByCandidate) {
      assert.ok(["direct_fact", "boundary_answer", "limitation_only", "unrelated"].includes(gold.category));
      assert.equal(gold.supported, gold.category === "direct_fact" || gold.category === "boundary_answer");
      assert.ok(gold.reason.trim() && gold.evidenceQuote.trim() && item.candidates.find(candidate => candidate.id === gold.id)!.body.includes(gold.evidenceQuote));
    }
  }
  assert.deepEqual([true, false].map(supported => data.cases.flatMap(item => item.expectedByCandidate).filter(gold => gold.supported === supported).length), [12, 12]);
  for (const group of groups) assert.deepEqual(data.cases.filter(item => item.group === group)
    .map(item => item.expectedByCandidate.filter(gold => gold.supported).length), [0, 1, 2]);
}
async function loadInputs() { const data = await json(dataPath) as ModelSupportComparisonData; checkInputs(data); return data; }
const plannedRows = (data: ModelSupportComparisonData): ModelSupportComparisonRow[] => data.cases.flatMap((item, index) =>
  (index % 2 ? ["B", "A"] as Arm[] : arms).map(arm => ({ id: item.id, group: item.group, arm,
    selection: modelSupportComparisonArms[arm], sequence: index * 2 + (index % 2 ? ["B", "A"] : arms).indexOf(arm) + 1,
    execution: "not_run", output: null })));

export function scoreModelSupportComparison(item: ModelSupportComparisonCase, row: ModelSupportComparisonRow) {
  const candidates = item.expectedByCandidate.map(gold => {
    const invalid = Boolean(row.verification?.validation?.invalidDecisions.some(decision => decision.id === gold.id));
    const actual = row.execution === "completed" && !invalid ? row.verification?.value.find(decision => decision.id === gold.id) : undefined;
    return { id: gold.id, expectedPositive: gold.supported, state: invalid ? "invalid" : actual ? "valid" : "missing",
      category: actual?.category ?? null, supported: actual?.supported ?? null,
      passed: Boolean(actual && actual.category === gold.category && actual.supported === gold.supported),
      falseAccepted: Boolean(actual && !gold.supported && actual.supported), falseRejected: Boolean(actual && gold.supported && !actual.supported) };
  });
  const complete = row.execution === "completed" && row.verification?.validation?.status === "complete"
    && row.verification.value.length === item.candidates.length && candidates.every(candidate => candidate.state === "valid");
  return { candidates, passed: complete && candidates.every(candidate => candidate.passed),
    exactAcceptanceSet: complete && candidates.every(candidate => candidate.supported === candidate.expectedPositive) };
}
export function summarizeModelSupportComparison(data: ModelSupportComparisonData, rows: ModelSupportComparisonRow[], requests: ModelSupportComparisonRequest[] = []) {
  const summary = Object.fromEntries(arms.map(arm => {
    // Rebuild the full fixed denominator, even when a caller omitted an artifact row.
    const planned = plannedRows(data).filter(row => row.arm === arm), scored = planned.map(fallback => {
      const row = rows.find(row => row.id === fallback.id && row.arm === arm) ?? fallback;
      return { row, score: scoreModelSupportComparison(data.cases.find(item => item.id === row.id)!, row) };
    });
    const candidates = scored.flatMap(item => item.score.candidates), sent = requests.filter(request => request.arm === arm);
    const known = sent.filter(request => request.usageRecorded && request.estimatedCost !== null);
    const cost = sent.length && sent.length === known.length ? known.reduce((sum, request) => sum + request.estimatedCost!, 0) : null;
    const successes = scored.filter(item => item.score.passed).length;
    const times = sent.flatMap(request => request.durationMs === null ? [] : [request.durationMs]).sort((a, b) => a - b);
    return [arm, { selection: modelSupportComparisonArms[arm], exactInputs: { planned: planned.length,
      completed: scored.filter(item => item.row.execution === "completed").length, passed: successes,
      exactAcceptanceSet: scored.filter(item => item.score.exactAcceptanceSet).length,
      wholeNoAnswerPlanned: data.cases.filter(item => item.expectedByCandidate.every(gold => !gold.supported)).length,
      wholeNoAnswerCorrect: scored.filter(({ row, score }) => data.cases.find(item => item.id === row.id)!.expectedByCandidate.every(gold => !gold.supported)
        && score.exactAcceptanceSet).length,
      wholeNoAnswerFalseAccepted: scored.filter(({ row, score }) => data.cases.find(item => item.id === row.id)!.expectedByCandidate.every(gold => !gold.supported)
        && score.candidates.some(candidate => candidate.falseAccepted)).length,
      errors: scored.filter(item => item.row.execution === "error").length, notRun: scored.filter(item => item.row.execution === "not_run").length },
    candidates: { planned: candidates.length, positivePlanned: candidates.filter(candidate => candidate.expectedPositive).length,
      negativePlanned: candidates.filter(candidate => !candidate.expectedPositive).length,
      valid: candidates.filter(candidate => candidate.state === "valid").length, passed: candidates.filter(candidate => candidate.passed).length,
      falseAccepted: candidates.filter(candidate => candidate.falseAccepted).length, falseRejected: candidates.filter(candidate => candidate.falseRejected).length,
      invalid: candidates.filter(candidate => candidate.state === "invalid").length, missing: candidates.filter(candidate => candidate.state === "missing").length,
      newFalseRejectedKeys: [] as string[], falseRejectedKeys: scored.flatMap(({ row, score }) => score.candidates
        .filter(candidate => candidate.falseRejected).map(candidate => `${row.id}:${candidate.id}`)) },
    http: { planned: 12, sent: sent.length, knownCosts: known.length, unknownCosts: sent.length - known.length,
      currency: arm === "A" ? "USD" : "CNY", knownEstimatedCost: known.reduce((sum, request) => sum + request.estimatedCost!, 0),
      estimatedCost: cost, estimatedCostPerActualHttp: cost === null ? null : cost / sent.length,
      estimatedCostPerSuccessfulInput: cost === null || !successes ? null : cost / successes,
      totalTokens: sent.length && sent.every(request => request.usageRecorded && request.totalTokens !== null)
        ? sent.reduce((sum, request) => sum + request.totalTokens!, 0) : null },
    latency: { observed: times.length, p50Ms: times[Math.ceil(times.length * .5) - 1] ?? null,
      p95Ms: times[Math.ceil(times.length * .95) - 1] ?? null } }];
  })) as Record<Arm, { selection: ModelSelection; exactInputs: { planned: number; completed: number; passed: number; exactAcceptanceSet: number;
      wholeNoAnswerPlanned: number; wholeNoAnswerCorrect: number; wholeNoAnswerFalseAccepted: number; errors: number; notRun: number };
    candidates: { planned: number; positivePlanned: number; negativePlanned: number; valid: number; passed: number; falseAccepted: number; falseRejected: number;
      invalid: number; missing: number; newFalseRejectedKeys: string[]; falseRejectedKeys: string[] };
    http: { planned: number; sent: number; knownCosts: number; unknownCosts: number; currency: string; knownEstimatedCost: number;
      estimatedCost: number | null; estimatedCostPerActualHttp: number | null; estimatedCostPerSuccessfulInput: number | null; totalTokens: number | null };
    latency: { observed: number; p50Ms: number | null; p95Ms: number | null } }>;
  const baseline = new Set(summary.A.candidates.falseRejectedKeys);
  summary.B.candidates.newFalseRejectedKeys = summary.B.candidates.falseRejectedKeys.filter(key => !baseline.has(key));
  return summary;
}

function wireTokens(raw: WireUsage | null) {
  if (!raw) return null;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  const values = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens, cacheRead, cacheWrite];
  if (!values.every(token) || raw.total_tokens <= 0 || raw.prompt_tokens < cacheRead + cacheWrite
    || raw.total_tokens !== raw.prompt_tokens + raw.completion_tokens) return null;
  return { input: raw.prompt_tokens - cacheRead - cacheWrite, output: raw.completion_tokens, cacheRead, cacheWrite, totalTokens: raw.total_tokens };
}
function costFromTokens(settings: EvidenceSupportSettings, tokens: NonNullable<ReturnType<typeof wireTokens>>) {
  const rates = settings.pricing.rates;
  const usd = tokens.input * (rates.input / 1_000_000) + tokens.output * (rates.output / 1_000_000)
    + tokens.cacheRead * (rates.cacheRead / 1_000_000) + tokens.cacheWrite * (rates.cacheWrite / 1_000_000);
  return estimateModelUsage({ provider: settings.provider, id: settings.model, cost: rates }, { ...tokens, cost: { total: usd } });
}
function checkWireBody(body: Record<string, unknown>, config: EvidenceSupportSettings, arm: Arm, item: ModelSupportComparisonCase) {
  assert.ok(plain(body)); assert.equal(body.model, config.model); assert.equal(body.temperature, 0);
  const limitField = wireContracts[arm].outputLimitField;
  assert.equal(body[limitField], 2048);
  assert.ok(!((limitField === "max_tokens" ? "max_completion_tokens" : "max_tokens") in body));
  assert.equal(body.stream, true); assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.ok(!("tools" in body) && !("tool_choice" in body) && !("reasoning_effort" in body));
  if (config.provider === "bailian") { assert.equal(body.enable_thinking, false); assert.ok(!("thinking" in body)); }
  else { assert.deepEqual(body.thinking, { type: "disabled" }); assert.ok(!("enable_thinking" in body)); }
  assert.ok(Array.isArray(body.messages) && body.messages.length === 2);
  const [system, user] = body.messages as Array<{ role: string; content: string }>;
  assert.equal(system!.role, wireContracts[arm].instructionRole); assert.equal(contentHash(system!.content), config.promptHash);
  assert.equal(user!.role, "user"); assert.deepEqual(JSON.parse(user!.content), { query: item.query,
    documents: item.candidates.map(candidate => ({ id: candidate.id, title: candidate.title, tags: candidate.tags, body: candidate.body })) });
}

// A bounded experiment ledger, not a reusable transport/framework. Only the final
// native HTTP boundary can spend a request; rejected calls never increment it.
export function createModelSupportComparisonLedger(settings: Settings, send: typeof fetch = fetch, now: () => number = Date.now) {
  const requests: ModelSupportComparisonRequest[] = [], started = now();
  let active: { row: ModelSupportComparisonRow; item: ModelSupportComparisonCase; runId: string; signal: AbortSignal; started: number } | null = null;
  let stopReason: string | null = null, sealed = false;
  const stop = (reason: string) => { stopReason ??= reason; return stopReason; };
  const stopped = () => {
    if (now() - started >= modelSupportComparisonLimits.maxDurationMs) stop("run_deadline");
    for (const currency of ["USD", "CNY"] as const) {
      const total = requests.filter(request => request.currency === currency).reduce((sum, request) => sum + (request.estimatedCost ?? 0), 0);
      if (total >= (currency === "USD" ? modelSupportComparisonLimits.maxEstimatedCostUsd : modelSupportComparisonLimits.maxEstimatedCostCny)) {
        stop(`cost_soft_limit:${currency}`);
      }
    }
    return stopReason;
  };
  const assertOpen = () => {
    if (sealed) throw new Error(stop("ledger_sealed"));
    if (stopped()) throw new Error(stopReason!);
    assert.ok(active, "No active fixed case/arm"); active.signal.throwIfAborted();
    if (now() - active.started >= modelSupportComparisonLimits.perRequestTimeoutMs) throw new Error(stop("request_deadline"));
  };
  return { requests, stopped, stop, seal: () => { sealed = true; active = null; },
    setActive(row: ModelSupportComparisonRow, item: ModelSupportComparisonCase, runId: string, signal: AbortSignal) {
      assert.ok(!active, "Previous case must finish before selecting another arm");
      active = { row, item, runId, signal, started: now() };
    },
    fetch: (async (url, init) => {
      assertOpen(); const current = active!, { row, item, runId } = current, config = settings[row.arm];
      try {
        assert.equal(requests.length < modelSupportComparisonLimits.maxSupportHttp, true, "support_request_limit");
        assert.equal(requests.filter(request => request.arm === row.arm).length < 12, true, "arm_request_limit");
        assert.equal(requests.filter(request => request.sequence === row.sequence).length, 0, "native_retry_forbidden");
        assert.equal(row.selection, modelSupportComparisonArms[row.arm]); assert.equal(String(url), `${config.endpoint.replace(/\/$/, "")}/chat/completions`);
        assert.equal(init?.method?.toUpperCase(), "POST"); assert.ok(typeof init?.body === "string" && init.body.length <= 100_000);
        const body = JSON.parse(init.body) as Record<string, unknown>; checkWireBody(body, config, row.arm, item);
        const context = { arm: row.arm, caseId: item.id, inputHash: item.inputHash, sequence: row.sequence,
          requestId: `${runId}:${item.id}:${row.arm}`, settingsHash: contentHash(config) };
        const request: ModelSupportComparisonRequest = { index: requests.length, operation: "support", ...context,
          provider: config.provider, model: config.model, endpoint: String(url), method: "POST", body,
          bodyText: init.body, bodyHash: contentHash(init.body), requestHash: contentHash({ ...context, endpoint: String(url), method: "POST", body: init.body }),
          sentAt: new Date(now()).toISOString(), httpStatus: null, httpError: null, responseHash: null, responseModels: [], rawUsage: null,
          durationMs: null, attempt: null, totalTokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
          currency: config.pricing.currency, estimatedCost: null, usageRecorded: false };
        requests.push(request);
        try {
          const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), current.signal]);
          const response = await send(url, { ...init, signal, redirect: "error" }); request.httpStatus = response.status;
          if (!response.ok) request.httpError = "http_error";
          // Keep raw usage and a response digest, never provider reasoning blocks.
          const raw = await response.clone().text(); assert.ok(raw.length <= 200_000, "response_capture_limit");
          request.responseHash = contentHash(raw);
          for (const line of raw.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue; const value = line.slice(5).trim(); if (!value || value === "[DONE]") continue;
            const chunk = JSON.parse(value) as Record<string, unknown>;
            if (typeof chunk.model === "string" && !request.responseModels.includes(chunk.model)) request.responseModels.push(chunk.model);
            if (plain(chunk.usage)) {
              const usage = chunk.usage, details = plain(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
              request.rawUsage = { prompt_tokens: usage.prompt_tokens as number, completion_tokens: usage.completion_tokens as number,
                total_tokens: usage.total_tokens as number,
                ...(details ? { prompt_tokens_details: { ...(details.cached_tokens !== undefined ? { cached_tokens: details.cached_tokens as number } : {}),
                  ...(details.cache_write_tokens !== undefined ? { cache_write_tokens: details.cache_write_tokens as number } : {}) } } : {}),
                ...(usage.prompt_cache_hit_tokens !== undefined ? { prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens as number } : {}),
                ...(usage.cached_tokens !== undefined ? { cached_tokens: usage.cached_tokens as number } : {}) };
            }
          }
          return response;
        } catch {
          request.httpError ??= request.httpStatus === null ? "network_error" : "response_capture_error";
          throw new Error(stop("http_or_capture_failure"));
        }
      } catch (error) { stopReason ??= "wire_integrity_failure"; throw error; }
    }) as typeof fetch,
    finish(attempts: EvidenceSupportAttempt[]) {
      assert.ok(active); const row = active.row, sent = requests.filter(request => request.sequence === row.sequence), config = settings[row.arm];
      try {
        assert.equal(sent.length, 1, "Exactly one native HTTP per attempted input"); assert.equal(attempts.length, 1);
        const request = sent[0]!, attempt = attempts[0]!; request.attempt = attempt.attempt; request.durationMs = attempt.durationMs;
        assert.equal(attempt.attempt, 1); assert.equal(attempt.operation, "support");
        assert.equal(attempt.provider, config.provider); assert.equal(attempt.model, config.model);
        const tokens = wireTokens(request.rawUsage); assert.ok(tokens, "unknown_or_invalid_wire_usage");
        assert.deepEqual([attempt.inputTokens, attempt.outputTokens, attempt.cacheReadTokens, attempt.cacheWriteTokens, attempt.totalTokens],
          [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.totalTokens]);
        const estimate = costFromTokens(config, tokens), amount = config.pricing.currency === "USD" ? estimate.estimatedCostUsd : estimate.estimatedCostCny;
        assert.ok(amount !== null && Number.isFinite(amount) && amount >= 0, "unknown_cost");
        assert.equal(attempt.costUsd, estimate.estimatedCostUsd);
        if (config.pricing.currency === "CNY") assert.equal(attempt.costCny, estimate.estimatedCostCny);
        assert.ok(request.httpStatus !== null && request.httpStatus >= 200 && request.httpStatus < 300 && !request.httpError);
        assert.ok(request.responseModels.length > 0 && request.responseModels.every(model => model === config.model), "response_model_missing_or_mismatch");
        Object.assign(request, { totalTokens: tokens.totalTokens, inputTokens: tokens.input, outputTokens: tokens.output,
          cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite, estimatedCost: amount, usageRecorded: true });
      } catch { stop("usage_or_attempt_integrity_failure"); }
      finally { active = null; }
    } };
}

async function clients(env: NodeJS.ProcessEnv, ledger?: ReturnType<typeof createModelSupportComparisonLedger>, observe?: (arm: Arm, output: Output) => void) {
  const values = await Promise.all(arms.map(async arm => {
    const selection = modelSupportComparisonArms[arm], runtime = await createConfiguredModelRuntime(env, selection);
    const client = await createEvidenceSupportClient({ modelSelection: selection, profile: "typed", typedPromptVersion: evidenceSupportTypedV7PromptVersion,
      timeoutMs: modelSupportComparisonLimits.perRequestTimeoutMs, observeResponseForTest: output => observe?.(arm, output),
      runtime: { model: runtime.model, complete: (context, options) => {
        assert.equal(options.maxRetries, 0); assert.equal(options.maxTokens, 2048); assert.equal(options.temperature, 0);
        assert.equal(options.timeoutMs, 60_000); assert.deepEqual(context.tools, []);
        return runtime.modelRuntime.complete(runtime.model, context, { ...options, ...(ledger ? { fetch: ledger.fetch } : {}) });
      } } });
    return [arm, client] as const;
  }));
  return Object.fromEntries(values) as Record<Arm, EvidenceSupportClient>;
}
function settingsFor(variants: Record<Arm, EvidenceSupportClient>): Settings {
  const settings = { A: variants.A.settings, B: variants.B.settings };
  for (const arm of arms) {
    const value = settings[arm]; assert.equal(value.model, modelSupportComparisonArms[arm]);
    assert.equal(value.provider, arm === "A" ? "deepseek" : "bailian"); assert.equal(value.pricing.currency, arm === "A" ? "USD" : "CNY");
    assert.equal(value.profile, "typed"); assert.equal(value.promptVersion, evidenceSupportTypedV7PromptVersion);
    assert.deepEqual([value.timeoutMs, value.maxTokens, value.maxRetries, value.temperature], [60_000, 2048, 0, 0]);
  }
  const common = ({ provider: _provider, model: _model, endpoint: _endpoint, pricing: _pricing, ...value }: EvidenceSupportSettings) => value;
  assert.deepEqual(common(settings.A), common(settings.B), "Only model/provider/endpoint/price may differ"); return settings;
}
async function snapshot() {
  const data = await loadInputs(), settings = settingsFor(await clients(process.env));
  const paths = [...new Set([...(await c1ValidationCodeFiles()), scriptPath, dataPath, "docs/model-selection.md"])].sort();
  const files = await Promise.all(paths.map(async path => { const bytes = await readFile(new URL(path, root));
    return [path, { sha256: contentHash(bytes), bytes: bytes.length }] as const; }));
  return { version: 1, suiteId: data.suiteId, stage, arms: modelSupportComparisonArms, limits: modelSupportComparisonLimits,
    executionOrder: plannedRows(data).map(row => ({ caseId: row.id, arm: row.arm, sequence: row.sequence })),
    settings, wireContracts, sourceHashes: Object.fromEntries(files), dependencies: await readC1ValidationDependencies() };
}

function rawOutputMatches(item: ModelSupportComparisonCase, row: ModelSupportComparisonRow) {
  try {
    assert.ok(row.output && !row.output.truncated && row.output.stopReason === "stop");
    const parsed = JSON.parse(row.output.text); assert.ok(plain(parsed)); assert.deepEqual(Object.keys(parsed), ["decisions"]);
    assert.ok(Array.isArray(parsed.decisions)); assert.equal(parsed.decisions.length, item.candidates.length);
    const decisions = parsed.decisions.map((value: unknown): Record<string, unknown> & { supported: boolean } => { assert.ok(plain(value));
      assert.deepEqual(Object.keys(value).sort(), ["id", "category", "quote", "reason"].sort());
      return { ...value, supported: value.category === "direct_fact" || value.category === "boundary_answer" }; });
    assert.deepEqual(decisions.map(decision => decision.id).sort(), item.candidates.map(candidate => candidate.id).sort());
    const invalid = new Set(row.verification!.validation!.invalidDecisions.map(decision => decision.id));
    for (const decision of decisions.filter(decision => invalid.has(String(decision.id)))) {
      assert.equal(validateEvidenceSupport([decision], item.candidates.filter(candidate => candidate.id === decision.id), "typed"), false);
    }
    assert.deepEqual(decisions.filter(decision => !invalid.has(String(decision.id))), row.verification!.value);
    return true;
  } catch { return false; }
}

export function modelSupportComparisonRecordingComplete(data: ModelSupportComparisonData, rows: ModelSupportComparisonRow[], requests: ModelSupportComparisonRequest[], runId: string, settings: Settings) {
  const expected = plannedRows(data);
  return rows.length === 24 && new Set(rows.map(row => `${row.id}:${row.arm}`)).size === 24 && expected.every(item => rows.some(row => row.id === item.id
    && row.arm === item.arm && row.sequence === item.sequence && row.group === item.group && row.selection === item.selection))
    && rows.every(row => { const sent = requests.filter(request => request.sequence === row.sequence);
      if (row.execution === "not_run") return sent.length === 0 && Boolean(row.notRunReason) && !row.verification && !row.attempts && row.output === null;
      if (sent.length !== 1 || !row.attempts || row.attempts.length !== 1) return false;
      if (row.execution === "error") return Boolean(row.error);
      const item = data.cases.find(item => item.id === row.id)!;
      return Boolean(row.verification && validateEvidenceSupportVerification(row.verification, { ...item, settings: settings[row.arm] })
        && row.output && !row.output.truncated && contentHash(row.output.text) === row.output.outputHash
        && row.verification.validation?.outputHash === row.output.outputHash && rawOutputMatches(item, row)); })
    && requests.length <= 24 && arms.every(arm => requests.filter(request => request.arm === arm).length <= 12)
    && requests.every((request, index) => {
      const config = settings[request.arm], item = data.cases.find(item => item.id === request.caseId);
      if (!config || !item || (index && requests[index - 1]!.sequence >= request.sequence)) return false;
      const context = { arm: request.arm, caseId: item.id, inputHash: item.inputHash, sequence: request.sequence,
        requestId: `${runId}:${item.id}:${request.arm}`, settingsHash: contentHash(config) };
      try {
        checkWireBody(request.body, config, request.arm, item);
        if (request.bodyHash !== contentHash(request.bodyText) || contentHash(JSON.parse(request.bodyText)) !== contentHash(request.body)
          || request.requestHash !== contentHash({ ...context, endpoint: request.endpoint, method: "POST", body: request.bodyText })
          || request.inputHash !== item.inputHash || request.endpoint !== `${config.endpoint.replace(/\/$/, "")}/chat/completions`
          || request.method !== "POST" || request.body.model !== config.model) return false;
        if (request.usageRecorded) {
          const tokens = wireTokens(request.rawUsage); if (!tokens) return false; const cost = costFromTokens(config, tokens);
          const attempt = rows.find(row => row.sequence === request.sequence)?.attempts?.[0];
          if (!attempt || attempt.provider !== config.provider || attempt.model !== config.model || attempt.attempt !== 1
            || attempt.costUsd !== cost.estimatedCostUsd || (config.pricing.currency === "CNY" && attempt.costCny !== cost.estimatedCostCny)
            || attempt.durationMs !== request.durationMs || request.responseModels.length === 0
            || !request.responseModels.every(model => model === config.model)) return false;
          if (request.estimatedCost !== (config.pricing.currency === "USD" ? cost.estimatedCostUsd : cost.estimatedCostCny)
            || request.estimatedCost === null || request.attempt !== 1
            || contentHash([request.inputTokens, request.outputTokens, request.cacheReadTokens, request.cacheWriteTokens, request.totalTokens])
              !== contentHash([tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.totalTokens])) return false;
        } else if (request.estimatedCost !== null) return false;
      } catch { return false; }
      return request.index === index && request.operation === "support"
      && request.requestId === `${runId}:${request.caseId}:${request.arm}` && request.settingsHash === contentHash(settings[request.arm])
      && request.model === settings[request.arm].model && request.provider === settings[request.arm].provider
      && request.currency === settings[request.arm].pricing.currency && rows.some(row => row.sequence === request.sequence && row.id === request.caseId && row.arm === request.arm);
    });
}

async function run() {
  const frozen = await json(manifestPath), before = await snapshot(); assert.deepEqual(before, frozen, "Frozen code/data/settings/dependencies must match before HTTP");
  const data = await loadInputs(), runId = randomUUID(), rows = plannedRows(data);
  const dir = new URL(".runtime/c1-model-support-comparison/", root); await mkdir(dir, { recursive: true });
  const output = new URL(`${runId}.json`, dir), manifestHash = contentHash(frozen);
  await writeFile(new URL(`attempt-${manifestHash}.json`, dir), JSON.stringify({ runId, manifestHash, output: output.pathname }) + "\n", { flag: "wx" });
  const ledger = createModelSupportComparisonLedger(before.settings), deadline = AbortSignal.timeout(modelSupportComparisonLimits.maxDurationMs);
  let current: ModelSupportComparisonRow | null = null;
  const artifact = { version: 1, runId, manifestHash, stage, scope: "Support-only fixed synthetic inputs; no Agent, retrieval/rerank, database, QQ, writes or final reply evaluation.",
    manifest: frozen, actualSettings: null as Settings | null, startedAt: new Date().toISOString(), finishedAt: null as string | null,
    rows, requests: ledger.requests, summary: summarizeModelSupportComparison(data, rows), stopReason: null as string | null,
    codeStable: false, recordingComplete: false, executionComplete: false, usageComplete: false, integrityPassed: false,
    nextSessionCandidateEligible: false, newPositiveFalseRejectedKeys: [] as string[], artifactContentHash: "" };
  const save = async () => { artifact.summary = summarizeModelSupportComparison(data, rows, ledger.requests);
    const baseline = new Set(artifact.summary.A.candidates.falseRejectedKeys);
    artifact.newPositiveFalseRejectedKeys = artifact.summary.B.candidates.falseRejectedKeys.filter(key => !baseline.has(key));
    artifact.summary.B.candidates.newFalseRejectedKeys = artifact.newPositiveFalseRejectedKeys;
    const { artifactContentHash: _hash, ...bound } = artifact; artifact.artifactContentHash = contentHash(bound);
    await writeFile(output, JSON.stringify(artifact, null, 2) + "\n"); };
  await save();
  try {
    const variants = await clients(process.env, ledger, (arm, raw) => { if (current?.arm === arm) current.output = raw; });
    artifact.actualSettings = settingsFor(variants); assert.deepEqual(artifact.actualSettings, before.settings);
    for (const row of rows) {
      if (ledger.stopped() || deadline.aborted) break;
      current = row; const item = data.cases.find(item => item.id === row.id)!;
      ledger.setActive(row, item, runId, deadline);
      try {
        row.verification = await verifyEvidenceSupport({ ...item, client: variants[row.arm], beforeAttempt: () => !deadline.aborted });
        row.attempts = row.verification.attempts; row.execution = "completed";
        assert.ok(validateEvidenceSupportVerification(row.verification, { ...item, settings: variants[row.arm].settings }));
        if (!row.output || row.output.truncated || row.output.stopReason !== "stop" || contentHash(row.output.text) !== row.output.outputHash
          || row.verification.validation?.outputHash !== row.output.outputHash) ledger.stop("output_integrity_failure");
      } catch (error) {
        row.execution = "error"; row.error = error instanceof EvidenceSupportError ? error.code : "executor_integrity_failure";
        row.errorOutputHash = error instanceof EvidenceSupportError ? error.outputHash : null;
        row.attempts = error instanceof EvidenceSupportError ? error.attempts : row.verification?.attempts ?? [];
        // Known-usage malformed/category/quote responses consume their one planned
        // request and remain failures. They do not cancel the remaining comparison.
        if (!(error instanceof EvidenceSupportError) || error.code === "invalid_binding") ledger.stop("support_response_integrity_failure");
      } finally {
        ledger.finish(row.attempts ?? []); current = null;
        if (!ledger.requests.some(request => request.sequence === row.sequence)) {
          row.execution = "not_run"; row.notRunReason = ledger.stopped() ?? "rejected_before_http";
          delete row.verification; delete row.attempts; row.output = null;
        }
      }
      await save(); console.log(`${row.id} ${row.arm}: ${row.execution}; exact=${scoreModelSupportComparison(item, row).passed}`);
    }
  } finally {
    artifact.stopReason = ledger.stopped() ?? (deadline.aborted ? "run_deadline" : rows.some(row => row.execution === "not_run") ? "execution_interrupted" : null);
    for (const row of rows) if (row.execution === "not_run") row.notRunReason = artifact.stopReason!;
    ledger.seal(); artifact.finishedAt = new Date().toISOString();
    try { artifact.codeStable = contentHash(await snapshot()) === contentHash(before); } catch { artifact.codeStable = false; }
    artifact.recordingComplete = modelSupportComparisonRecordingComplete(data, rows, ledger.requests, runId, before.settings);
    artifact.executionComplete = rows.every(row => row.execution !== "not_run") && ledger.requests.length === 24;
    artifact.usageComplete = ledger.requests.length === 24 && ledger.requests.every(request => request.usageRecorded && request.estimatedCost !== null);
    artifact.integrityPassed = artifact.codeStable && artifact.recordingComplete && contentHash(artifact.actualSettings) === contentHash(before.settings)
      && !rows.some(row => row.error === "executor_integrity_failure") && !["wire_integrity_failure", "usage_or_attempt_integrity_failure", "output_integrity_failure"].includes(artifact.stopReason ?? "");
    await save();
    artifact.nextSessionCandidateEligible = artifact.integrityPassed && artifact.executionComplete && artifact.usageComplete
      && rows.every(row => row.execution === "completed" && row.verification?.validation?.status === "complete")
      && artifact.summary.B.candidates.falseAccepted === 0 && artifact.newPositiveFalseRejectedKeys.length === 0
      && artifact.summary.B.exactInputs.exactAcceptanceSet > artifact.summary.A.exactInputs.exactAcceptanceSet;
    await save(); console.log(JSON.stringify({ runId, integrityPassed: artifact.integrityPassed, executionComplete: artifact.executionComplete,
      usageComplete: artifact.usageComplete, stopReason: artifact.stopReason, nextSessionCandidateEligible: artifact.nextSessionCandidateEligible,
      summary: artifact.summary }));
  }
}

export async function checkModelSupportComparison() {
  const data = await loadInputs(), rows = plannedRows(data), env = { MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-deepseek",
    DASHSCOPE_API_KEY: "synthetic-bailian", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/api/v1" };
  const variants = await clients(env), settings = settingsFor(variants);
  assert.equal(rows.length, 24); assert.deepEqual(rows.slice(0, 4).map(row => row.arm), ["A", "B", "B", "A"]);
  const empty = summarizeModelSupportComparison(data, []);
  for (const arm of arms) { assert.equal(empty[arm].candidates.planned, 24); assert.equal(empty[arm].candidates.missing, 24);
    assert.equal(empty[arm].exactInputs.notRun, 12); assert.equal(empty[arm].http.estimatedCost, null); }
  const item = data.cases.find(item => item.expectedByCandidate.filter(gold => gold.supported).length === 1)!, row = rows.find(row => row.id === item.id && row.arm === "A")!, decisions = item.expectedByCandidate.map(gold => ({ id: gold.id, category: gold.category,
    supported: gold.supported, quote: gold.category === "unrelated" ? null : gold.evidenceQuote, reason: "合成工程检查" }));
  const verification: EvidenceSupportVerification = { value: decisions, inputHash: "synthetic", requestHash: "synthetic", attempts: [],
    validation: { status: "complete", outputHash: contentHash("synthetic"), invalidDecisions: [] } };
  const correct = { ...row, execution: "completed" as const, verification };
  assert.equal(scoreModelSupportComparison(item, correct).passed, true);
  const flipped = structuredClone(correct); flipped.verification.value.forEach(decision => { decision.supported = !decision.supported;
    decision.category = decision.supported ? "direct_fact" : "limitation_only"; });
  const wrong = scoreModelSupportComparison(item, flipped); assert.equal(wrong.passed, false);
  assert.equal(wrong.candidates.filter(candidate => candidate.falseAccepted).length, 1);
  assert.equal(wrong.candidates.filter(candidate => candidate.falseRejected).length, 1);
  const invalid = structuredClone(flipped); invalid.verification.validation = { status: "unavailable", outputHash: contentHash("synthetic"),
    invalidDecisions: item.candidates.map(candidate => ({ id: candidate.id, code: "invalid_quote" })) };
  assert.equal(scoreModelSupportComparison(item, invalid).candidates.filter(candidate => candidate.state === "invalid").length, 2);
  assert.ok(scoreModelSupportComparison(item, invalid).candidates.every(candidate => !candidate.passed && !candidate.falseAccepted && !candidate.falseRejected));
  const errored = { ...correct, execution: "error" as const, error: "invalid_binding" };
  assert.ok(scoreModelSupportComparison(item, errored).candidates.every(candidate => candidate.state === "missing" && !candidate.passed));
  const other = data.cases.filter(item => item.expectedByCandidate.filter(gold => gold.supported).length === 1)[1]!;
  const reject = (target: ModelSupportComparisonCase, arm: Arm): ModelSupportComparisonRow => ({
    ...rows.find(row => row.id === target.id && row.arm === arm)!, execution: "completed", verification: { ...verification,
      value: target.expectedByCandidate.map(gold => ({ id: gold.id, supported: false, category: "limitation_only", quote: gold.evidenceQuote, reason: "合成工程反例" })) } });
  const newRejections = summarizeModelSupportComparison(data, [reject(item, "A"), reject(other, "B")]);
  assert.equal(newRejections.A.candidates.falseRejected, 1); assert.equal(newRejections.B.candidates.falseRejected, 1);
  assert.equal(newRejections.B.candidates.newFalseRejectedKeys.length, 1, "Equal totals cannot hide a new positive false rejection");
  const malformed = structuredClone(data); malformed.cases[0]!.expectedByCandidate.pop(); assert.throws(() => checkInputs(malformed));
  let fakeHttp = 0;
  let wireUsage: WireUsage | undefined = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, includeResponseModel = true;
  const text = JSON.stringify({ decisions: decisions.map(({ supported: _supported, ...decision }) => decision) });
  const fake: typeof fetch = async (_url, init) => { fakeHttp++; const model = JSON.parse(String(init?.body)).model;
    const chunk = (delta: object, finish_reason: string | null, usage?: WireUsage) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk",
      created: 1, ...(includeResponseModel ? { model } : {}), choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
    return new Response(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop", wireUsage) + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }); };
  const ledger = createModelSupportComparisonLedger(settings, fake), bound = await clients(env, ledger);
  for (const arm of arms) {
    const planned = rows.find(row => row.id === item.id && row.arm === arm)!;
    ledger.setActive(planned, item, "synthetic", new AbortController().signal);
    const actual = await verifyEvidenceSupport({ ...item, client: bound[arm] }); ledger.finish(actual.attempts);
    assert.equal(ledger.stopped(), null); assert.equal(ledger.requests.at(-1)!.currency, arm === "A" ? "USD" : "CNY");
    assert.equal(ledger.requests.at(-1)!.usageRecorded, true); assert.equal(ledger.requests.at(-1)!.totalTokens, 15);
    assert.equal(actual.attempts[0]!.costUsd === null, arm === "B");
  }
  assert.equal(fakeHttp, 2); ledger.seal();
  const blocked = createModelSupportComparisonLedger(settings, fake);
  blocked.setActive(row, item, "synthetic", new AbortController().signal);
  await assert.rejects(blocked.fetch("https://foreign.invalid/chat/completions", { method: "POST", body: "{}" }));
  assert.equal(fakeHttp, 2); assert.equal(blocked.requests.length, 0); assert.equal(blocked.stopped(), "wire_integrity_failure");
  const missing = createModelSupportComparisonLedger(settings, async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
  const missingClient = await clients(env, missing); missing.setActive(row, item, "synthetic", new AbortController().signal);
  let attempts: EvidenceSupportAttempt[] = [];
  try { await verifyEvidenceSupport({ ...item, client: missingClient.A }); } catch (error) { assert.ok(error instanceof EvidenceSupportError); attempts = error.attempts; }
  missing.finish(attempts); assert.equal(missing.stopped(), "usage_or_attempt_integrity_failure");
  assert.equal(missing.requests[0]!.usageRecorded, false); assert.equal(missing.requests[0]!.estimatedCost, null);
  await assert.rejects(missing.fetch("https://foreign.invalid"), /usage_or_attempt_integrity_failure/);
  // Hard limits apply before send, independently per arm, with no cap+1.
  const capped = createModelSupportComparisonLedger(settings, fake), recordedRows = plannedRows(data);
  let recording: ModelSupportComparisonRow | null = null;
  const native = await clients(env, capped, (arm, output) => { if (recording?.arm === arm) recording.output = output; });
  for (const planned of recordedRows) {
    const target = data.cases.find(item => item.id === planned.id)!;
    recording = planned;
    capped.setActive(planned, target, "synthetic", new AbortController().signal);
    // The synthetic reply may have unrelated IDs for later cases; only transport/usage are under test here.
    let result: EvidenceSupportAttempt[];
    try { planned.verification = await verifyEvidenceSupport({ ...target, client: native[planned.arm] });
      result = planned.verification.attempts; planned.execution = "completed"; }
    catch (error) { assert.ok(error instanceof EvidenceSupportError); result = error.attempts; planned.execution = "error"; planned.error = error.code; }
    planned.attempts = result;
    capped.finish(result); assert.equal(capped.stopped(), null);
  }
  recording = null;
  assert.equal(capped.requests.length, 24); assert.equal(fakeHttp, 26);
  assert.equal(modelSupportComparisonRecordingComplete(data, recordedRows, capped.requests, "synthetic", settings), true,
    "Known-usage model format failures remain faithful failed rows and do not stop the fixed denominator");
  assert.equal(modelSupportComparisonRecordingComplete(data, recordedRows.slice(1), capped.requests, "synthetic", settings), false);
  const forged = structuredClone(recordedRows), completed = forged.find(row => row.execution === "completed")!;
  const decision = completed.verification!.value[0]!;
  decision.category = decision.supported ? "boundary_answer" : "direct_fact";
  decision.supported = true;
  assert.equal(modelSupportComparisonRecordingComplete(data, forged, capped.requests, "synthetic", settings), false,
    "Changing verified decisions while preserving raw output/hash cannot change the grade");
  capped.setActive({ ...row, sequence: 25 }, item, "synthetic", new AbortController().signal);
  await assert.rejects(capped.fetch(`${settings.A.endpoint}/chat/completions`, { method: "POST", body: "{}" }), /support_request_limit/);
  assert.equal(fakeHttp, 26); assert.equal(capped.requests.length, 24);
  // Soft budget is observed before choosing another row, rather than generating
  // an SDK attempt for a request that never crossed the HTTP boundary.
  for (const arm of arms) {
    wireUsage = { prompt_tokens: 200_000, completion_tokens: 5, total_tokens: 200_005 };
    const budget = createModelSupportComparisonLedger(settings, fake), budgetClients = await clients(env, budget);
    const planned = rows.find(row => row.id === item.id && row.arm === arm)!;
    budget.setActive(planned, item, "synthetic", new AbortController().signal);
    const result = await verifyEvidenceSupport({ ...item, client: budgetClients[arm] }); budget.finish(result.attempts);
    assert.equal(budget.requests.length, 1); assert.equal(budget.stopped(), `cost_soft_limit:${arm === "A" ? "USD" : "CNY"}`);
    const before: number = fakeHttp;
    await assert.rejects(budget.fetch(`${settings[arm].endpoint}/chat/completions`), /cost_soft_limit/);
    assert.equal(fakeHttp, before); assert.equal(budget.requests.length, 1);
    assert.equal(rows.filter(row => row.execution === "not_run").length, 24, "Ledger checks never create a fictitious next row attempt");
  }
  wireUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const retry = createModelSupportComparisonLedger(settings, fake), retryClients = await clients(env, retry);
  retry.setActive(row, item, "synthetic", new AbortController().signal);
  const result = await verifyEvidenceSupport({ ...item, client: retryClients.A }), beforeRetry = fakeHttp;
  await assert.rejects(retry.fetch(`${settings.A.endpoint}/chat/completions`, { method: "POST", body: "{}" }), /native_retry_forbidden/);
  assert.equal(fakeHttp, beforeRetry); assert.equal(retry.requests.length, 1); retry.finish(result.attempts);
  includeResponseModel = false;
  const identity = createModelSupportComparisonLedger(settings, fake), identityClients = await clients(env, identity);
  identity.setActive(row, item, "synthetic", new AbortController().signal);
  const noIdentity = await verifyEvidenceSupport({ ...item, client: identityClients.A }); identity.finish(noIdentity.attempts);
  assert.equal(identity.stopped(), "usage_or_attempt_integrity_failure"); assert.equal(identity.requests[0]!.usageRecorded, false);
  includeResponseModel = true;
  // SDK can synthesize zero usage; the raw wire ledger must keep it unknown.
  wireUsage = undefined;
  const unknown = createModelSupportComparisonLedger(settings, fake), unknownClients = await clients(env, unknown);
  unknown.setActive(rows.find(row => row.id === item.id && row.arm === "B")!, item, "synthetic", new AbortController().signal);
  const noUsage = await verifyEvidenceSupport({ ...item, client: unknownClients.B }); unknown.finish(noUsage.attempts);
  assert.equal(unknown.stopped(), "usage_or_attempt_integrity_failure"); assert.equal(unknown.requests[0]!.estimatedCost, null);
  let time = 0;
  const elapsed = createModelSupportComparisonLedger(settings, fake, () => time); elapsed.setActive(row, item, "synthetic", new AbortController().signal);
  time = 60_000; const beforeDeadline = fakeHttp;
  await assert.rejects(elapsed.fetch(`${settings.A.endpoint}/chat/completions`), /request_deadline/);
  assert.equal(elapsed.requests.length, 0); assert.equal(fakeHttp, beforeDeadline);
  const overall = createModelSupportComparisonLedger(settings, fake, () => time); time += 600_000;
  assert.equal(overall.stopped(), "run_deadline"); assert.equal(overall.requests.length, 0);
  console.log("Model comparison checks: fixed 24-row/48-candidate denominator, native fake wire, currencies, unknown usage and pre-send hard limit; remote HTTP=0");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); assert.equal(args.length, 1, "Use --check|--freeze|--inspect|--live");
  if (args[0] === "--check") await checkModelSupportComparison();
  else if (args[0] === "--freeze") { await writeFile(new URL(manifestPath, root), JSON.stringify(await snapshot(), null, 2) + "\n", { flag: "wx" }); console.log("Frozen without HTTP"); }
  else if (args[0] === "--inspect") { assert.deepEqual(await snapshot(), await json(manifestPath)); console.log("Frozen data/settings/code/dependencies match; HTTP=0"); }
  else if (args[0] === "--live") await run();
  else throw new Error("Use --check|--freeze|--inspect|--live; live requires a matching one-attempt manifest.");
}
