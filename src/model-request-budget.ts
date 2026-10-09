import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ModelPricing } from "./model-selection.ts";

export type ModelTaskPhase = "authorization" | "session" | "host" | "model" | "render" | "send" | "receipt";
export type ModelTaskFailure = "authorization_failed" | "session_failed" | "host_failed" | "model_failed" | "render_failed"
  | "send_unknown" | "receipt_unknown" | "canceled" | "http_limit" | "unsupported_transport" | "external_limit" | "context_limit" | "context_invalid";
export type ModelTaskLimits = { httpRequests: number; contextBudgetUnits?: number };
export type ModelTaskStatus = "completed" | "failed" | "canceled" | "http_limit" | "context_limit";
export type ModelRequestPhase = "agent" | "question" | "support" | "rerank" | "embedding";
export const contextBudgetPolicy = { version: "utf8-byte-plus-output-v1", defaultLimit: 65536, safetyUnits: 1024 } as const;
export type ContextProjection = { tokens: number | null; contextWindow: number; percent: number | null };
export type ModelContextCheck = { logicalCall: number; attempt: number; phase: ModelRequestPhase;
  policy: typeof contextBudgetPolicy.version; decision: "allowed" | "context_limit" | "context_invalid";
  payloadBytes: number | null; outputTokenField: "max_tokens" | "max_completion_tokens" | null; outputReserve: number | null;
  safetyUnits: number; requiredUnits: number | null; applicationLimit: number; catalogContextWindow: number | null;
  effectiveLimit: number | null; projection: ContextProjection | null };
type Usage = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; totalTokens: number };
export type ModelRequestAttempt = {
  logicalCall: number; attempt: number; phase: ModelRequestPhase; provider: string; model: string;
  observedAt: string; durationMs: number | null; httpStatus: number | null;
  outcome: "pending" | "completed" | "http_error" | "network_error" | "interrupted";
  usage: Usage | null; currency: "USD" | "CNY" | null; pricingSource: string | null;
  estimatedCostUsd: number | null; estimatedCostCny: number | null;
};
export type ModelTaskSummary = {
  version: "model-task-v1"; requestIdHash: string; entrypoint: "cli" | "qq" | "web" | "check";
  trigger: "user" | "event" | "confirmation"; limits: Required<ModelTaskLimits>; startedAt: string; durationMs: number;
  status: ModelTaskStatus; phase: ModelTaskPhase; failurePhase: ModelTaskPhase | null; failureReason: ModelTaskFailure | null;
  logicalCalls: number; localCalls: number; httpRequests: number; blockedRequests: number;
  knownTokens: number; unknownUsageAttempts: number; totalTokens: number | null;
  knownCostUsd: number; knownCostCny: number; unknownCostAttempts: number; attempts: ModelRequestAttempt[]; contextChecks: ModelContextCheck[];
};
export type ModelTask = {
  readonly signal: AbortSignal;
  snapshot(): ModelTaskSummary;
  setPhase(phase: ModelTaskPhase): void;
  fail(reason: ModelTaskFailure): void;
  cancel(): void;
};
type State = { task: ModelTask; controller: AbortController; summary: ModelTaskSummary; started: number; closed: boolean };
const storage = new AsyncLocalStorage<State>();
const phases: ModelTaskPhase[] = ["authorization", "session", "host", "model", "render", "send", "receipt"];
const failures: ModelTaskFailure[] = ["authorization_failed", "session_failed", "host_failed", "model_failed", "render_failed",
  "send_unknown", "receipt_unknown", "canceled", "http_limit", "unsupported_transport", "external_limit", "context_limit", "context_invalid"];

export function readModelTaskLimits(env: NodeJS.ProcessEnv = process.env): Required<ModelTaskLimits> {
  const raw = env.MODEL_TASK_HTTP_LIMIT;
  if (raw !== undefined && !/^[1-9]\d*$/u.test(raw)) throw new Error("MODEL_TASK_HTTP_LIMIT 必须为 1..64 的整数。");
  const context = env.MODEL_CONTEXT_BUDGET_UNITS;
  if (context !== undefined && !/^[1-9]\d*$/u.test(context)) throw new Error("MODEL_CONTEXT_BUDGET_UNITS 必须为 4096..262144 的整数。");
  return validateLimits({ httpRequests: raw === undefined ? 12 : Number(raw), contextBudgetUnits: context === undefined ? contextBudgetPolicy.defaultLimit : Number(context) });
}
function validateLimits(value: ModelTaskLimits): Required<ModelTaskLimits> {
  if (!value || Object.keys(value).some(key => !["httpRequests", "contextBudgetUnits"].includes(key)) || !Number.isSafeInteger(value.httpRequests)
    || value.httpRequests < 1 || value.httpRequests > 64) throw new Error("模型任务 HTTP 预算必须为 1..64 的整数。");
  const contextBudgetUnits = value.contextBudgetUnits ?? contextBudgetPolicy.defaultLimit;
  if (!Number.isSafeInteger(contextBudgetUnits) || contextBudgetUnits < 4096 || contextBudgetUnits > 262144) throw new Error("本地上下文预算必须为 4096..262144 的整数。");
  return { httpRequests: value.httpRequests, contextBudgetUnits };
}
function fail(state: State, reason: ModelTaskFailure) {
  if (!failures.includes(reason)) throw new Error("模型任务失败类型无效。");
  if (state.closed) return;
  if (!state.summary.failureReason) {
    state.summary.failureReason = reason;
    state.summary.failurePhase = state.summary.phase;
  }
  if (state.summary.status === "completed") state.summary.status = "failed";
}
function stop(state: State, status: "canceled" | "http_limit" | "context_limit", reason: ModelTaskFailure) {
  if (state.closed) return;
  const alreadyFailed = state.summary.status === "failed";
  fail(state, reason);
  if (status === "http_limit" || status === "context_limit") state.summary.status = status;
  else if (!["http_limit", "context_limit"].includes(state.summary.status) && !alreadyFailed) state.summary.status = status;
  state.controller.abort();
}
function snapshot(state: State): ModelTaskSummary {
  const summary = structuredClone(state.summary);
  if (!state.closed) summary.durationMs = Math.max(0, Math.round(performance.now() - state.started));
  summary.knownTokens = summary.attempts.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0);
  summary.unknownUsageAttempts = summary.attempts.filter(row => row.usage === null).length;
  summary.totalTokens = summary.unknownUsageAttempts ? null : summary.knownTokens;
  summary.knownCostUsd = summary.attempts.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0);
  summary.knownCostCny = summary.attempts.reduce((sum, row) => sum + (row.estimatedCostCny ?? 0), 0);
  summary.unknownCostAttempts = summary.attempts.filter(row => row.estimatedCostUsd === null && row.estimatedCostCny === null).length;
  return summary;
}
export function currentModelTask(): ModelTask | undefined { return storage.getStore()?.task; }

// One accepted user message/event, not a multi-turn business saga. Nested drivers
// use the outer request identity, deadline and budget instead of resetting them.
export async function withModelTask<T>(options: {
  requestId: string; entrypoint: ModelTaskSummary["entrypoint"]; trigger?: ModelTaskSummary["trigger"];
  signal?: AbortSignal; limits?: ModelTaskLimits; onComplete?: (summary: ModelTaskSummary) => void;
}, work: (task: ModelTask) => Promise<T>): Promise<T> {
  const existing = storage.getStore();
  if (existing) {
    if (existing.closed || existing.controller.signal.aborted) throw new ModelRequestBudgetError();
    return work(existing.task);
  }
  if (typeof options.requestId !== "string" || !options.requestId || options.requestId.length > 2048
    || !["cli", "qq", "web", "check"].includes(options.entrypoint)
    || options.trigger !== undefined && !["user", "event", "confirmation"].includes(options.trigger)) throw new Error("模型任务来源无效。");
  const controller = new AbortController(), started = performance.now();
  const state = { controller, started, closed: false, summary: {
    version: "model-task-v1", requestIdHash: createHash("sha256").update(options.requestId).digest("hex"),
    entrypoint: options.entrypoint, trigger: options.trigger ?? "user", limits: validateLimits(options.limits ?? readModelTaskLimits()),
    startedAt: new Date().toISOString(), durationMs: 0, status: "completed", phase: "authorization", failurePhase: null, failureReason: null,
    logicalCalls: 0, localCalls: 0, httpRequests: 0, blockedRequests: 0, knownTokens: 0, unknownUsageAttempts: 0, totalTokens: 0,
    knownCostUsd: 0, knownCostCny: 0, unknownCostAttempts: 0, attempts: [], contextChecks: [],
  } } as Omit<State, "task"> as State;
  state.task = {
    signal: controller.signal, snapshot: () => snapshot(state),
    setPhase(phase) { if (!phases.includes(phase)) throw new Error("模型任务阶段无效。"); if (!state.closed) state.summary.phase = phase; },
    fail: reason => fail(state, reason), cancel: () => stop(state, "canceled", "canceled"),
  };
  const aborted = () => state.task.cancel();
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  return storage.run(state, async () => {
    try { controller.signal.throwIfAborted(); return await work(state.task); }
    catch (error) {
      const reason: ModelTaskFailure = state.summary.phase === "send" ? "send_unknown" : state.summary.phase === "receipt" ? "receipt_unknown"
        : `${state.summary.phase}_failed`;
      fail(state, reason); throw error;
    } finally {
      options.signal?.removeEventListener("abort", aborted);
      for (const row of state.summary.attempts) if (row.outcome === "pending") {
        row.outcome = "interrupted"; row.usage = null; row.estimatedCostUsd = null; row.estimatedCostCny = null;
      }
      state.summary.durationMs = Math.max(0, Math.round(performance.now() - started));
      state.closed = true;
      controller.abort(); // No work escaping this scope may open another request.
      try { options.onComplete?.(snapshot(state)); } catch { /* Logging must not replay business work. */ }
    }
  });
}

export class ModelRequestBudgetError extends Error {
  constructor() { super("本轮模型请求已停止，请重新说明需求后再试。"); this.name = "ModelRequestBudgetError"; }
}
export class ContextBudgetError extends Error {
  constructor() { super("本次上下文已超过当前处理范围，请新开对话并写明订单号及完整问题。"); this.name = "ContextBudgetError"; }
}
// A composing batch guard may attest that it rejected before calling its actual
// transport. Never use this for a network failure or an uncertain dispatch.
export class ModelRequestNotDispatchedError extends Error {
  constructor() { super("外层运行预算已停止，本次请求未发送。"); this.name = "ModelRequestNotDispatchedError"; }
}
export function recordLocalModelCall() {
  const state = storage.getStore();
  if (!state) return;
  if (state.closed || state.controller.signal.aborted) throw new ModelRequestBudgetError();
  state.summary.logicalCalls++; state.summary.localCalls++;
}
export function rejectUnsupportedModelTransport(): never {
  const state = storage.getStore();
  if (state) { fail(state, "unsupported_transport"); state.controller.abort(); }
  throw new Error("当前请求预算仅支持已接入的 HTTP 模型接口，不支持此传输方式。");
}
type Pricing = ModelPricing | { currency: "CNY"; source: "Alibaba Cloud Model Studio"; ratePerMillionTokens: number };
export type ModelRequestInfo = { phase: ModelRequestPhase; provider: string; model: string; format: "openai-sse" | "bailian-json"; pricing?: Pricing;
  context?: { contextWindow?: number; maxOutputTokens: number; outputTokenField?: "max_tokens" | "max_completion_tokens"; projection?: ContextProjection } };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function inspectContext(info: ModelRequestInfo, body: BodyInit | null | undefined, applicationLimit: number,
  logicalCall: number, attempt: number): ModelContextCheck {
  const metadata = info.context;
  const contextWindow = count(metadata?.contextWindow) && metadata.contextWindow > 0 ? metadata.contextWindow : null;
  const projection = metadata?.projection;
  const result: ModelContextCheck = { logicalCall, attempt, phase: info.phase, policy: contextBudgetPolicy.version, decision: "context_invalid",
    payloadBytes: typeof body === "string" ? Buffer.byteLength(body, "utf8") : null, outputTokenField: null, outputReserve: null,
    safetyUnits: contextBudgetPolicy.safetyUnits, requiredUnits: null, applicationLimit, catalogContextWindow: contextWindow,
    effectiveLimit: contextWindow ? Math.min(applicationLimit, contextWindow) : null,
    projection: projection && (projection.tokens === null || count(projection.tokens)) && count(projection.contextWindow) && projection.contextWindow > 0
      && (projection.percent === null || Number.isFinite(projection.percent) && projection.percent >= 0)
      ? { tokens: projection.tokens, contextWindow: projection.contextWindow, percent: projection.percent } : null };
  if (typeof body !== "string" || !metadata || !contextWindow || !count(metadata.maxOutputTokens) || !metadata.maxOutputTokens) return result;
  let payload: unknown; try { payload = JSON.parse(body); } catch { return result; }
  if (!object(payload) || !Array.isArray(payload.messages) || !payload.messages.length || payload.model !== info.model) return result;
  const fields = ["max_tokens", "max_completion_tokens"].filter(key => Object.hasOwn(payload, key));
  if (fields.length !== 1 || ["max_output_tokens", "max_new_tokens", "maxTokens"].some(key => Object.hasOwn(payload, key))) return result;
  const field = fields[0] as "max_tokens" | "max_completion_tokens", output = payload[field];
  result.outputTokenField = field;
  if (!count(output) || !output || output > metadata.maxOutputTokens || metadata.outputTokenField !== undefined && metadata.outputTokenField !== field) return result;
  result.outputReserve = output;
  const required = result.payloadBytes! + output + contextBudgetPolicy.safetyUnits;
  if (!Number.isSafeInteger(required)) return result;
  result.requiredUnits = required;
  result.decision = required <= result.effectiveLimit! ? "allowed" : "context_limit";
  return result;
}
function wireUsage(value: unknown, format: ModelRequestInfo["format"]): Usage | null {
  if (!object(value) || !count(value.total_tokens)) return null;
  if (format === "bailian-json") return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: value.total_tokens };
  const input = value.prompt_tokens, output = value.completion_tokens;
  const details = object(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const cacheRead = details.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cached_tokens ?? 0;
  const cacheWrite = details.cache_write_tokens ?? 0;
  if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite) || input + output !== value.total_tokens || input < cacheRead + cacheWrite) return null;
  return { inputTokens: input - cacheRead - cacheWrite, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: value.total_tokens };
}
function estimate(row: ModelRequestAttempt, pricing?: Pricing) {
  if (!row.usage || !pricing) return;
  let cost: number;
  if ("ratePerMillionTokens" in pricing) cost = row.usage.totalTokens * pricing.ratePerMillionTokens / 1_000_000;
  else {
    const { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } = row.usage;
    if (input === null || output === null || cacheRead === null || cacheWrite === null
      || pricing.currency === "CNY" && input + cacheRead + cacheWrite > pricing.inputTierMaxTokens) return;
    cost = (input * pricing.rates.input + output * pricing.rates.output + cacheRead * pricing.rates.cacheRead + cacheWrite * pricing.rates.cacheWrite) / 1_000_000;
  }
  if (Number.isFinite(cost) && cost >= 0) {
    if (pricing.currency === "CNY") row.estimatedCostCny = cost; else row.estimatedCostUsd = cost;
  }
}

// A wrapper belongs to one logical model call; each invocation is an actual HTTP
// attempt. Only the single consumer stream is observed: no clone/tee/background read.
export function createModelRequestFetch(info: ModelRequestInfo, transport: typeof fetch = globalThis.fetch): typeof fetch {
  const state = storage.getStore();
  if (!state) return transport;
  info = structuredClone(info);
  if (!(info.format === "openai-sse" && ["agent", "question", "support"].includes(info.phase)
    || info.format === "bailian-json" && ["rerank", "embedding"].includes(info.phase))) return rejectUnsupportedModelTransport();
  if (!/^[A-Za-z0-9._:/-]{1,128}$/u.test(info.provider) || !/^[A-Za-z0-9._:/-]{1,256}$/u.test(info.model)) throw new Error("模型请求元信息无效。");
  if (state.closed || state.controller.signal.aborted) throw new ModelRequestBudgetError();
  // Runtime adapters may replace a never-used wrapper with their own guarded
  // transport. Count only when this logical call reaches the dispatch boundary.
  let logicalCall: number | undefined;
  let attempts = 0;
  return async (input, init) => {
    // Materialize accessor-backed RequestInit once: inspect and send the same body.
    init = { ...init };
    if (state.closed || state.controller.signal.aborted) throw new ModelRequestBudgetError();
    logicalCall ??= ++state.summary.logicalCalls;
    if (state.summary.httpRequests >= state.summary.limits.httpRequests) {
      state.summary.blockedRequests++; stop(state, "http_limit", "http_limit"); throw new ModelRequestBudgetError();
    }
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = inherited ? AbortSignal.any([state.controller.signal, inherited]) : state.controller.signal;
    signal.throwIfAborted();
    if (info.format === "openai-sse") {
      const check = inspectContext(info, init?.body, state.summary.limits.contextBudgetUnits, logicalCall, attempts + 1);
      state.summary.contextChecks.push(check);
      if (check.decision !== "allowed") {
        state.summary.blockedRequests++;
        if (check.decision === "context_limit") { stop(state, "context_limit", "context_limit"); throw new ContextBudgetError(); }
        fail(state, "context_invalid"); state.controller.abort(); throw new Error("模型请求上下文或输出预留配置无效，未发送请求。");
      }
    }
    const started = performance.now();
    const row: ModelRequestAttempt = { logicalCall, attempt: ++attempts, phase: info.phase, provider: info.provider, model: info.model,
      observedAt: new Date().toISOString(), durationMs: null, httpStatus: null, outcome: "pending", usage: null,
      currency: info.pricing?.currency ?? null, pricingSource: info.pricing?.source ?? null, estimatedCostUsd: null, estimatedCostCny: null };
    state.summary.httpRequests++; state.summary.attempts.push(row);
    const finish = (outcome: ModelRequestAttempt["outcome"], usage: Usage | null = null) => {
      if (state.closed || row.outcome !== "pending") return;
      row.durationMs = Math.max(0, Math.round(performance.now() - started)); row.outcome = outcome;
      if (outcome === "completed") { row.usage = usage; estimate(row, info.pricing); }
    };
    try {
      const response = await transport(input, { ...init, signal, redirect: "error" });
      if (state.closed || signal.aborted) { void response.body?.cancel().catch(() => {}); throw new ModelRequestBudgetError(); }
      row.httpStatus = response.status;
      if (!response.body) { finish(response.ok ? "completed" : "http_error"); return response; }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", invalid = false, done = false, finishedChoice = false, sawModel = false, observed: Usage | null = null;
      const inspect = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; return; }
        if (!data) return;
        try {
          const value: unknown = JSON.parse(data);
          if (!object(value) || value.error || done) { invalid = true; return; }
          if (value.model !== undefined) { sawModel = true; if (value.model !== info.model) invalid = true; }
          if (Array.isArray(value.choices) && value.choices.some(choice => object(choice) && typeof choice.finish_reason === "string")) finishedChoice = true;
          if (value.usage !== undefined && value.usage !== null) { observed = wireUsage(value.usage, info.format); if (!observed) invalid = true; }
        } catch { invalid = true; }
      };
      const parse = (text: string) => {
        if (invalid || !response.ok) return;
        buffer += text;
        if (buffer.length > (info.format === "openai-sse" ? 65_536 : 1_048_576)) { invalid = true; buffer = ""; return; }
        if (info.format === "openai-sse") {
          const lines = buffer.split(/\r?\n/u); buffer = lines.pop()!; lines.forEach(inspect);
        }
      };
      let ended = false;
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => { if (!ended) { ended = true; finish("interrupted"); void reader.cancel().catch(() => {}); cleanup(); } };
      signal.addEventListener("abort", abort, { once: true });
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (ended || signal.aborted || state.closed) { abort(); controller.error(new ModelRequestBudgetError()); return; }
            const chunk = await reader.read();
            if (ended || signal.aborted || state.closed) { abort(); controller.error(new ModelRequestBudgetError()); return; }
            if (chunk.done) {
              ended = true; cleanup(); parse(decoder.decode());
              if (info.format === "openai-sse") { if (buffer) inspect(buffer); if (!done || !finishedChoice || !sawModel) invalid = true; }
              else { try { const value: unknown = JSON.parse(buffer); observed = object(value) ? wireUsage(value.usage, info.format) : null; } catch { invalid = true; } }
              finish(response.ok ? "completed" : "http_error", response.ok && !invalid ? observed : null); controller.close(); reader.releaseLock(); return;
            }
            parse(decoder.decode(chunk.value, { stream: true })); controller.enqueue(chunk.value);
          } catch { ended = true; cleanup(); finish("interrupted"); void reader.cancel().catch(() => {}); controller.error(new ModelRequestBudgetError()); }
        },
        async cancel() {
          ended = true; cleanup();
          // OpenAI's native SSE consumer cancels its reader after [DONE], without
          // asking for another EOF. A task/user abort is never this normal close.
          const complete = response.ok && !signal.aborted && !state.closed && info.format === "openai-sse" && done && finishedChoice && sawModel && !invalid;
          finish(!response.ok && !signal.aborted ? "http_error" : complete ? "completed" : "interrupted", complete ? observed : null);
          await reader.cancel().catch(() => {});
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (error instanceof ModelRequestNotDispatchedError && !state.closed) {
        state.summary.attempts.splice(state.summary.attempts.indexOf(row), 1);
        state.summary.httpRequests--; state.summary.blockedRequests++;
        fail(state, "external_limit"); state.controller.abort();
      } else finish(signal.aborted ? "interrupted" : "network_error");
      throw error;
    }
  };
}
