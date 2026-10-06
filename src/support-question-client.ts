import { isDeepStrictEqual } from "node:util";
import { calculateCost, type Api, type Model, type Usage, type AssistantMessage, type Context, type ModelCost } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createModelRuntime } from "./agent.ts";
import { contentHash } from "./bailian.ts";
import { estimateModelUsage, modelPricing, normalizeBailianGenerationBaseUrl, resolveModelSelection, type ModelSelection } from "./model-selection.ts";
import { requireSupportQuestionResolution, supportQuestionResolutionInputHash, supportQuestionResolutionVersion,
  validateSupportQuestionResolutionInput, type SupportQuestionAttempt, type SupportQuestionResolutionInput,
  type SupportQuestionResolver, type SupportQuestionSettings, type SupportQuestionTrace } from "./support-question-resolution.ts";

export const supportQuestionPromptVersion = "support-question-prompt-v1" as const;
export const supportQuestionPrompt = `你是客服咨询原问的有界语义解析器，只判断本轮问题是否完整、是否依赖获准的前序原问，或是否需要澄清；不回答业务问题，不改写问题，不推断订单、商品类别、政策或事实。
输入 JSON 仅有 requestId、originalQuery、previousTopic。previousTopic 为 null 时，前序来源不可用；非 null 时只允许使用其中逐字原问链。
返回且只返回 JSON 对象 {"decision":"current_complete|previous_resolved|needs_clarification","currentQuotes":["本轮原文连续片段"],"previousRequestId":null}，不得增加字段。
current_complete：本轮已说明足够明确的对象/条件/问题，不需要前序原问；previousRequestId 必须 null。完整句即使含“刚才”也可属于此类，不能按关键词判定依赖。
previous_resolved：本轮确有省略，且获准的 previousTopic 原问链足以唯一补齐；previousRequestId 必须逐字等于 previousTopic.requestId。不得依赖输入以外的历史、回答或模型改写。
needs_clarification：当前省略、歧义或缺来源导致无法确定问题。previousRequestId 只能为 null 或真实 previousTopic.requestId，仅用于来源审计，不授权恢复。
currentQuotes 是 1 至 5 个本轮 originalQuery 内逐字连续片段；needs_clarification 可为空。引文只证明出处，不能把摘到片段当成语义完整。不要把前序原文抄成 currentQuotes。
例如“刚才查询的 COUPON-1001 双人午餐券周日能预约吗？”是完整重述；“刚才那个呢？”在 previousTopic=null 时需要澄清。不要输出解释、Markdown、工具调用或推理。`;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
export function supportQuestionRequestHash(input: { input: SupportQuestionResolutionInput; settings: SupportQuestionSettings }): string {
  if (!validateSupportQuestionResolutionInput(input.input)) throw new Error("咨询问题解析输入无效。");
  return contentHash({ settings: input.settings, payload: input.input });
}
export class SupportQuestionClientError extends Error {
  readonly trace: SupportQuestionTrace;
  constructor(trace: SupportQuestionTrace) {
    super("咨询问题解析未完成，需安全澄清。"); this.name = "SupportQuestionClientError"; this.trace = freeze(structuredClone(trace));
  }
}
type CompletionOptions = { signal: AbortSignal; timeoutMs: number; temperature: 0; maxTokens: number; maxRetries: 0;
  fetch: typeof globalThis.fetch; samplingParams: { response_format: { type: "json_object" } }; onPayload: (payload: unknown) => unknown };
type Runtime = { model: { provider: string; id: string; api: string; baseUrl: string; maxTokens: number; cost: ModelCost };
  complete: (context: Context, options: CompletionOptions) => Promise<AssistantMessage> };
type WireUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
function wireUsage(value: unknown): WireUsage | null {
  if (!plain(value)) return null;
  const prompt = value.prompt_tokens, output = value.completion_tokens, total = value.total_tokens;
  const details = plain(value.prompt_tokens_details) ? value.prompt_tokens_details : undefined;
  const cacheRead = details?.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cached_tokens ?? 0;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  const values = [prompt, output, total, cacheRead, cacheWrite];
  if (!values.every((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    || !total || Number(prompt) < Number(cacheRead) + Number(cacheWrite) || Number(prompt) + Number(output) !== total) return null;
  return { input: Number(prompt) - Number(cacheRead) - Number(cacheWrite), output: Number(output), cacheRead: Number(cacheRead),
    cacheWrite: Number(cacheWrite), totalTokens: Number(total) };
}

// This is a single native completion, not an Agent loop. Only transport is injectable.
export async function createSupportQuestionClient(options: { env?: NodeJS.ProcessEnv; modelSelection?: ModelSelection;
  timeoutMs?: number; fetch?: typeof globalThis.fetch; runtime?: Runtime } = {}): Promise<SupportQuestionResolver & { settings: SupportQuestionSettings }> {
  const timeoutMs = options.timeoutMs ?? 10_000, selection = options.modelSelection ?? "deepseek-flash";
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15_000) throw new Error("咨询问题解析超时须为 1000..15000 毫秒。");
  const selected = resolveModelSelection(selection, options.env);
  const runtime: Runtime = options.runtime ?? await (async () => {
    const { modelRuntime, model } = await createConfiguredModelRuntime(options.env, selection);
    return { model, complete: (context: Context, parameters: CompletionOptions) => modelRuntime.complete(model, context, parameters) };
  })();
  const model = freeze(structuredClone(runtime.model));
  if (model.provider !== selected.provider || model.id !== selected.modelId || model.api !== "openai-completions"
    || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) throw new Error("咨询问题解析模型配置不一致。");
  if (model.provider === "deepseek") {
    const catalog = (await createModelRuntime()).getModel(model.provider, model.id);
    if (!catalog || model.baseUrl !== catalog.baseUrl || !isDeepStrictEqual(model.cost, catalog.cost)) throw new Error("咨询问题解析模型 endpoint 或价格未审阅。");
  } else if (model.provider === "bailian") {
    if (model.id !== "qwen3.7-plus-2026-05-26" || normalizeBailianGenerationBaseUrl(model.baseUrl) !== model.baseUrl
      || ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(Number.isNaN)) throw new Error("咨询问题解析百炼 endpoint 或价格未审阅。");
  } else throw new Error("咨询问题解析仅支持已审阅的 DeepSeek 或北京百炼模型。");
  const settings: SupportQuestionSettings = freeze({ provider: model.provider, model: model.id, api: model.api, endpoint: model.baseUrl,
    timeoutMs, temperature: 0, maxTokens: Math.min(model.maxTokens, 1024), maxRetries: 0, promptVersion: supportQuestionPromptVersion,
    promptHash: contentHash(supportQuestionPrompt), serialization: "json-question-resolution-v1", pricing: modelPricing(model) });
  const transport = options.fetch ?? globalThis.fetch;
  const endpoint = `${settings.endpoint.replace(/\/$/u, "")}/chat/completions`;
  return { settings, async resolve(rawInput, resolveOptions = {}) {
    // Invalid source input never enters a model request or receives a fabricated hash.
    if (!validateSupportQuestionResolutionInput(rawInput)) throw new Error("咨询问题解析输入无效。");
    const input = freeze(structuredClone(rawInput)), inputHash = supportQuestionResolutionInputHash(input);
    const trace: SupportQuestionTrace = { version: "support-question-trace-v1", inputHash,
      requestHash: supportQuestionRequestHash({ input, settings }), settings, attempts: [], value: null, failure: null };
    let sealed = false;
    const publish = () => {
      if (sealed) return; sealed = true;
      try { resolveOptions.onTrace?.(freeze(structuredClone(trace))); } catch { /* Observers do not alter decisions or trigger another request. */ }
    };
    if (resolveOptions.signal?.aborted) { trace.failure = "aborted"; publish(); throw new SupportQuestionClientError(trace); }
    const started = performance.now(), controller = new AbortController();
    const attempt: SupportQuestionAttempt = { operation: "question", provider: model.provider, model: model.id, attempt: 1,
      durationMs: 0, outcome: "provider_error", httpRequests: 0, wireHash: null, outputHash: null,
      totalTokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null,
      ...(settings.pricing.currency === "CNY" ? { costCny: null } : {}) };
    trace.attempts.push(attempt);
    let timer: NodeJS.Timeout | undefined, rejectStop: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const stop = (kind: "aborted" | "timeout") => {
      if (sealed || trace.failure) return; trace.failure = kind; controller.abort(); rejectStop(new Error(kind));
    };
    const abort = () => stop("aborted");
    resolveOptions.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    let wireInvalid = false, retryBlocked = false, unexpectedContent = false, rawText = "", rawModels: string[] = [], sawDone = false;
    const observed: { usage: WireUsage | null } = { usage: null };
    const measuredFetch: typeof globalThis.fetch = async (url, init) => {
      if (sealed || controller.signal.aborted) throw new Error("question request canceled");
      // A forbidden retry invalidates the decision, not the first closed usage ledger.
      if (attempt.httpRequests) { retryBlocked = true; throw new Error("question retry blocked"); }
      const actualEndpoint = String(url), body = init?.body;
      const payload = typeof body === "string" ? JSON.parse(body) as unknown : null;
      const tokenField = model.provider === "bailian" ? "max_completion_tokens" : "max_tokens";
      const thinkingField = model.provider === "bailian" ? "enable_thinking" : "thinking";
      if (actualEndpoint !== endpoint || init?.method !== "POST" || !exact(payload,
        ["model", "messages", "stream", "stream_options", "temperature", tokenField, thinkingField, "response_format"])
        || payload.model !== model.id || payload.stream !== true || !isDeepStrictEqual(payload.stream_options, { include_usage: true })
        || payload.temperature !== 0 || payload[tokenField] !== settings.maxTokens
        || !isDeepStrictEqual(payload[thinkingField], model.provider === "bailian" ? false : { type: "disabled" })
        || !isDeepStrictEqual(payload.response_format, { type: "json_object" })
        || !isDeepStrictEqual(payload.messages, [{ role: "system", content: supportQuestionPrompt }, { role: "user", content: JSON.stringify(input) }])) {
        wireInvalid = true; throw new Error("question wire contract invalid");
      }
      attempt.httpRequests = 1; attempt.wireHash = contentHash({ endpoint: actualEndpoint, method: "POST", body });
      const response = await transport(url, { ...init, redirect: "error", signal: controller.signal });
      if (sealed || controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error("question request canceled"); }
      if (!response.ok || !response.body) return response;
      // Inspect the actual SSE rather than trusting SDK's normalized model ID.
      const decoder = new TextDecoder(); let pending = "", bytes = 0;
      const inspect = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim(); if (data === "[DONE]") { sawDone = true; return; }
        if (!data) return;
        try {
          const chunk = JSON.parse(data) as Record<string, unknown>;
          if (typeof chunk.model === "string") rawModels.push(chunk.model);
          if (chunk.usage !== undefined && chunk.usage !== null) { observed.usage = wireUsage(chunk.usage); if (!observed.usage) wireInvalid = true; }
          if (Array.isArray(chunk.choices)) for (const choice of chunk.choices) {
            if (!plain(choice) || !plain(choice.delta)) continue;
            if (typeof choice.delta.content === "string") rawText += choice.delta.content;
            if (choice.delta.reasoning_content || choice.delta.reasoning || choice.delta.tool_calls) unexpectedContent = true;
          }
          if (rawText.length > 20_000) unexpectedContent = true;
        } catch { wireInvalid = true; }
      };
      const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, sink) {
          if (!sealed) {
            bytes += chunk.byteLength;
            if (bytes > 200_000) { wireInvalid = true; throw new Error("question response limit"); }
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split(/\r?\n/u); pending = lines.pop()!; lines.forEach(inspect);
          }
          sink.enqueue(chunk);
        }, flush() { if (!sealed) { pending += decoder.decode(); if (pending) inspect(pending); } },
      }));
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    try {
      const complete = runtime.complete({ systemPrompt: supportQuestionPrompt,
        messages: [{ role: "user", content: JSON.stringify(input), timestamp: 0 }], tools: [] }, {
        signal: controller.signal, timeoutMs, temperature: 0, maxTokens: settings.maxTokens, maxRetries: 0, fetch: measuredFetch,
        samplingParams: { response_format: { type: "json_object" } }, onPayload: payload => {
          if (!plain(payload)) throw new Error("question payload invalid");
          const { tools: _tools, tool_choice: _choice, thinking: _thinking, reasoning_effort: _effort, enable_thinking: _enabled, store: _store, ...rest } = payload;
          return { ...rest, temperature: 0, ...(model.provider === "bailian" ? { enable_thinking: false } : { thinking: { type: "disabled" } }), response_format: { type: "json_object" } };
        },
      });
      const response = await Promise.race([complete, stopped]);
      if (trace.failure || controller.signal.aborted) throw new Error("question request canceled");
      const text = response.content.map(item => item.type === "text" ? item.text : "").join("");
      attempt.outputHash = contentHash(text);
      // Partial SSE usage alone is not a completed native SDK usage record.
      const usage = response.usage, rawUsage = observed.usage;
      if (!wireInvalid && attempt.httpRequests === 1 && rawModels.length > 0 && rawModels.every(value => value === model.id) && rawUsage
        && usage && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => usage[key as keyof typeof usage] === rawUsage![key as keyof WireUsage])) {
        attempt.totalTokens = rawUsage.totalTokens; attempt.inputTokens = rawUsage.input; attempt.outputTokens = rawUsage.output;
        attempt.cacheReadTokens = rawUsage.cacheRead; attempt.cacheWriteTokens = rawUsage.cacheWrite;
        const reviewedUsage: Usage = { ...rawUsage, reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        calculateCost(model as Model<Api>, reviewedUsage);
        const costs = estimateModelUsage(model, reviewedUsage);
        if (settings.pricing.currency === "USD" && !isDeepStrictEqual(usage.cost, reviewedUsage.cost)) wireInvalid = true;
        attempt.costUsd = wireInvalid ? null : costs.estimatedCostUsd;
        if (settings.pricing.currency === "CNY") attempt.costCny = costs.estimatedCostCny;
      }
      if (response.stopReason === "error" || response.stopReason === "aborted" || wireInvalid || retryBlocked || attempt.httpRequests !== 1
        || rawModels.length === 0 || rawModels.some(value => value !== model.id) || response.provider !== model.provider || response.model !== model.id || response.api !== model.api
        || !sawDone || rawText !== text) throw new Error("question provider contract invalid");
      attempt.outcome = "invalid_response";
      if (response.stopReason !== "stop" || unexpectedContent || response.content.some(item => item.type !== "text") || text.length > 20_000) throw new Error("question output invalid");
      const value = JSON.parse(text) as unknown;
      if (!exact(value, ["decision", "currentQuotes", "previousRequestId"])) throw new Error("question output shape invalid");
      trace.value = requireSupportQuestionResolution({ version: supportQuestionResolutionVersion, inputHash, ...value }, input);
      attempt.outcome = "ok"; return trace.value;
    } catch {
      trace.failure ??= attempt.outcome === "invalid_response" ? "invalid_response" : "provider_error";
      attempt.outcome = trace.failure;
      attempt.durationMs = Math.max(0, performance.now() - started); publish();
      throw new SupportQuestionClientError(trace);
    } finally {
      if (timer) clearTimeout(timer); resolveOptions.signal?.removeEventListener("abort", abort);
      if (!sealed) { attempt.durationMs = Math.max(0, performance.now() - started); publish(); }
    }
  } };
}
