import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { createSupportQuestionClient, SupportQuestionClientError, supportQuestionPrompt, supportQuestionPromptVersion, supportQuestionRequestHash } from "../src/support-question-client.ts";
import type { ModelSelection } from "../src/model-selection.ts";
import { supportQuestionResolutionInputHash, type SupportQuestionResolution, type SupportQuestionResolutionInput,
  type SupportQuestionSettings, type SupportQuestionTrace } from "../src/support-question-resolution.ts";

const env = { MODEL_PROVIDER: "bailian", MODEL_API_KEY: "synthetic-global-key", DEEPSEEK_API_KEY: "synthetic-deepseek-key",
  DASHSCOPE_API_KEY: "synthetic-bailian-key", DASHSCOPE_BASE_URL: "https://12345678.cn-beijing.maas.aliyuncs.com/api/v1" };
const standardUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const baseInput: SupportQuestionResolutionInput = { requestId: "question-native-1", originalQuery: "刚才说过了，我重新问这张午餐券可供几人使用？", previousTopic: null };
const answer = (input: SupportQuestionResolutionInput, decision: SupportQuestionResolution["decision"] = "current_complete") => ({
  decision, currentQuotes: decision === "needs_clarification" ? [] : [input.originalQuery],
  previousRequestId: decision === "previous_resolved" ? input.previousTopic!.requestId : null,
});
export type SupportQuestionNativeWire = { endpoint: string; method: "POST"; body: string; startedAt: string; rawResponse: string | null; status: number | null };
type Step = { text?: string; value?: unknown; usage?: Record<string, unknown> | null; model?: string | null;
  finish?: string; tool?: boolean; thinking?: boolean; status?: number; throws?: boolean; delayMs?: number; doneDelayMs?: number; cancel?: () => void };

// Only HTTP and response content are fixtures. Pi registration, request generation,
// SSE parsing, price calculation and production client all execute. This is not a
// measurement of a real model's semantic judgment.
async function nativeFixture(input: SupportQuestionResolutionInput, step: Step = {}, options: {
  selection?: ModelSelection; timeoutMs?: number; signal?: AbortSignal; onTrace?: (trace: SupportQuestionTrace) => void;
  mutateResponse?: (response: AssistantMessage) => void;
  mutatePayload?: (value: Record<string, unknown>) => void; retry?: boolean; ignoreSignal?: boolean;
} = {}) {
  const selection = options.selection ?? "deepseek-flash", configured = await createConfiguredModelRuntime(env, selection);
  const questionRequests: SupportQuestionNativeWire[] = [];
  let response: AssistantMessage | null = null, observerCount = 0, trace: SupportQuestionTrace | null = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${configured.model.provider === "bailian" ? env.DASHSCOPE_API_KEY : env.DEEPSEEK_API_KEY}`);
    assert.equal(init?.redirect, "error");
    const wire: SupportQuestionNativeWire = { endpoint: String(url), method: "POST", body: String(init?.body), startedAt: new Date().toISOString(), rawResponse: null, status: null };
    questionRequests.push(wire); step.cancel?.();
    if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs)); // Deliberately ignores cancellation.
    if (step.throws) throw new Error("synthetic transport error");
    wire.status = step.status ?? 200;
    if (wire.status !== 200) { wire.rawResponse = JSON.stringify({ error: { message: "synthetic provider error" } }); return new Response(wire.rawResponse, { status: wire.status }); }
    const text = step.text ?? JSON.stringify(step.value ?? answer(input));
    const delta = step.tool ? { role: "assistant", tool_calls: [{ index: 0, id: "synthetic_tool", type: "function", function: { name: "forbidden", arguments: "{}" } }] }
      : { role: "assistant", content: text, ...(step.thinking ? { reasoning_content: "synthetic private reasoning must not be emitted" } : {}) };
    const chunk = (delta: object, finish_reason: string | null, usage?: Record<string, unknown> | null) => `data: ${JSON.stringify({
      id: "synthetic_question", object: "chat.completion.chunk", created: 1, ...(step.model === null ? {} : { model: step.model ?? configured.model.id }),
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`;
    const usage = Object.hasOwn(step, "usage") ? step.usage : standardUsage;
    wire.rawResponse = chunk(delta, null) + chunk({}, step.finish ?? (step.tool ? "tool_calls" : "stop"), usage);
    if (step.doneDelayMs) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode(wire.rawResponse!));
        setTimeout(() => { wire.rawResponse += "data: [DONE]\n\n"; controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }, step.doneDelayMs);
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    wire.rawResponse += "data: [DONE]\n\n";
    return new Response(wire.rawResponse, { headers: { "content-type": "text/event-stream" } });
  };
  type NativeRuntime = NonNullable<NonNullable<Parameters<typeof createSupportQuestionClient>[0]>["runtime"]>;
  const runtime: NativeRuntime = { model: configured.model, async complete(context, parameters) {
    const nativeOptions = { ...parameters, ...(options.ignoreSignal ? { signal: undefined } : {}), onPayload: (payload: unknown) => {
      const value = parameters.onPayload(payload) as Record<string, unknown>; options.mutatePayload?.(value); return value;
    } };
    const result = await configured.modelRuntime.complete(configured.model, context, nativeOptions);
    response = structuredClone(result); options.mutateResponse?.(result);
    if (options.retry) {
      const first = questionRequests[0]!;
      try { await parameters.fetch(first.endpoint, { method: "POST", body: first.body }); } catch { /* The production wrapper still marks the forbidden retry. */ }
    }
    return result;
  } };
  const client = await createSupportQuestionClient({ env, modelSelection: selection, timeoutMs: options.timeoutMs, fetch: fakeFetch, runtime });
  let value: SupportQuestionResolution | null = null, error: unknown = null;
  try { value = await client.resolve(input, { signal: options.signal, onTrace(value) {
    observerCount++; trace = value; options.onTrace?.(value);
  } }); } catch (failure) { error = failure; }
  return { input, settings: client.settings, client, value, error, get response() { return response; }, questionRequests,
    get trace() { return trace; }, get observerCount() { return observerCount; } };
}

// Independent proof checks can reuse native records instead of trusting hashes in
// the client trace. No provider headers or credentials enter this capture.
export async function captureSupportQuestionClientForTest(input: SupportQuestionResolutionInput,
  decision: SupportQuestionResolution["decision"] = "current_complete", selection: ModelSelection = "deepseek-flash") {
  const captured = await nativeFixture(input, { value: answer(input, decision) }, { selection });
  assert.equal(captured.error, null); assert.ok(captured.trace && captured.response && captured.questionRequests.length === 1);
  return { input: structuredClone(input), settings: captured.settings, trace: captured.trace,
    response: captured.response, questionRequests: captured.questionRequests };
}

function known(capture: Awaited<ReturnType<typeof nativeFixture>>, outcome: "ok" | "invalid_response" = "ok") {
  assert.equal(capture.observerCount, 1); assert.ok(capture.trace); assert.equal(capture.questionRequests.length, 1);
  const attempt = capture.trace.attempts[0]!;
  assert.equal(attempt.attempt, 1); assert.equal(attempt.httpRequests, 1); assert.equal(attempt.outcome, outcome);
  assert.equal(attempt.totalTokens, 15); assert.equal(attempt.inputTokens, 10); assert.equal(attempt.outputTokens, 5);
  assert.equal(attempt.cacheReadTokens, 0); assert.equal(attempt.cacheWriteTokens, 0);
  const wire = capture.questionRequests[0]!;
  assert.equal(attempt.wireHash, contentHash({ endpoint: wire.endpoint, method: wire.method, body: wire.body }));
  assert.equal(capture.trace.inputHash, supportQuestionResolutionInputHash(capture.input));
  assert.equal(capture.trace.requestHash, supportQuestionRequestHash({ input: capture.input, settings: capture.settings }));
  if (capture.settings.pricing.currency === "USD") { assert.equal(attempt.costUsd, .000009); assert.equal(attempt.costCny, undefined); }
  else { assert.equal(attempt.costUsd, null); assert.equal(attempt.costCny, .00006); }
  assert.equal(attempt.outputHash, contentHash(capture.response!.content.map(part => part.type === "text" ? part.text : "").join("")));
  if (outcome === "invalid_response") { assert.ok(capture.error instanceof SupportQuestionClientError); assert.deepEqual(capture.error.trace, capture.trace); assert.equal(capture.value, null); }
}
export async function checkSupportQuestionClient() {
  let controls = 0;
  const positive = await nativeFixture(baseInput); known(positive); controls++;
  assert.equal(positive.settings.provider, "deepseek"); assert.equal(positive.settings.model, "deepseek-flash", "Question default is independent of global Bailian provider");
  assert.equal(positive.settings.promptVersion, supportQuestionPromptVersion); assert.equal(positive.settings.promptHash, contentHash(supportQuestionPrompt));
  assert.equal(positive.settings.maxTokens, 1024); assert.equal(positive.settings.maxRetries, 0); assert.equal(positive.settings.timeoutMs, 10_000);
  const body = JSON.parse(positive.questionRequests[0]!.body);
  assert.equal(body.max_tokens, 1024); assert.equal(body.max_completion_tokens, undefined); assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.temperature, 0); assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.response_format, { type: "json_object" }); assert.equal(body.messages.length, 2);
  assert.deepEqual(JSON.parse(body.messages[1].content), baseInput); assert.equal(body.messages[0].content, supportQuestionPrompt);
  assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)), ["requestId", "originalQuery", "previousTopic"]);
  const previous: SupportQuestionResolutionInput = { requestId: "question-native-2", originalQuery: "还是这张券，那个问题现在呢？", previousTopic: {
    requestId: "old-native-1", queries: [{ requestId: "old-native-1", originalQuery: "假设属于常规午餐，普通周六使用有什么规则？" }] } };
  const continued = await nativeFixture(previous, { value: answer(previous, "previous_resolved") }); known(continued); controls++;
  assert.equal(continued.value!.previousRequestId, previous.previousTopic!.requestId);
  const clarification = await nativeFixture(previous, { value: { ...answer(previous, "needs_clarification"), previousRequestId: previous.previousTopic!.requestId } }); known(clarification); controls++;
  const withoutPrevious = await nativeFixture({ ...baseInput, originalQuery: "刚才那个呢？" }, { value: { decision: "needs_clarification", currentQuotes: [], previousRequestId: null } }); known(withoutPrevious); controls++;
  const qwen = await nativeFixture(baseInput, {}, { selection: "qwen3.7-plus-2026-05-26" }); known(qwen); controls++;
  const qwenBody = JSON.parse(qwen.questionRequests[0]!.body);
  assert.equal(qwenBody.max_completion_tokens, 1024); assert.equal(qwenBody.max_tokens, undefined); assert.equal(qwenBody.enable_thinking, false);
  assert.equal(qwenBody.thinking, undefined); assert.equal(qwen.settings.pricing.currency, "CNY");
  assert.equal(qwen.settings.endpoint, "https://12345678.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");

  const invalid: Step[] = [{ text: "not JSON" }, { value: { ...answer(baseInput), extra: "not allowed" } }, { value: null, text: "null" },
    { value: { ...answer(baseInput), currentQuotes: ["前序规则不属于本轮"] } }, { value: { ...answer(baseInput), decision: "previous_resolved", previousRequestId: "fake-previous" } },
    { value: { ...answer(baseInput), currentQuotes: [] } }, { value: { ...answer(baseInput), decision: true } },
    { value: { ...answer(baseInput), version: "host-field-forged", inputHash: contentHash(baseInput) } }, { finish: "length" }, { tool: true }, { thinking: true }];
  for (const step of invalid) { const result = await nativeFixture(baseInput, step); known(result, "invalid_response"); controls++; }
  const invalidCny = await nativeFixture(baseInput, { text: "bad known CNY response" }, { selection: "qwen3.7-plus-2026-05-26" }); known(invalidCny, "invalid_response"); controls++;
  for (const step of [{ status: 429 }, { throws: true }, { model: null }, { model: "foreign-model" }, { usage: { ...standardUsage, total_tokens: 16 } }]) {
    const failed = await nativeFixture(baseInput, step); assert.ok(failed.error instanceof SupportQuestionClientError); assert.equal(failed.trace!.failure, "provider_error");
    assert.equal(failed.questionRequests.length, 1); assert.equal(failed.trace!.attempts.length, 1); assert.equal(failed.observerCount, 1);
    assert.equal(failed.trace!.attempts[0]!.costUsd, null); assert.equal(failed.trace!.attempts[0]!.totalTokens, null); controls++;
  }
  const missing = await nativeFixture(baseInput, { usage: null }); assert.equal(missing.error, null); assert.equal(missing.trace!.attempts[0]!.totalTokens, null);
  assert.equal(missing.trace!.attempts[0]!.costUsd, null); controls++;
  const cache = await nativeFixture(baseInput, { usage: { ...standardUsage, prompt_cache_hit_tokens: 4 } });
  assert.equal(cache.trace!.attempts[0]!.inputTokens, 6); assert.equal(cache.trace!.attempts[0]!.cacheReadTokens, 4);
  assert.equal(cache.trace!.attempts[0]!.costUsd, (6 * .3 + 5 * 1.2 + 4 * .006) / 1_000_000); controls++;
  const expensive = await nativeFixture(baseInput, { usage: { prompt_tokens: 256001, completion_tokens: 5, total_tokens: 256006 } }, { selection: "qwen3.7-plus-2026-05-26" });
  assert.equal(expensive.error, null); assert.equal(expensive.trace!.attempts[0]!.costCny, null); assert.equal(expensive.trace!.attempts[0]!.costUsd, null); controls++;

  const pre = new AbortController(); pre.abort();
  const preAborted = await nativeFixture(baseInput, {}, { signal: pre.signal });
  assert.ok(preAborted.error instanceof SupportQuestionClientError); assert.equal(preAborted.trace!.failure, "aborted"); assert.deepEqual(preAborted.trace!.attempts, []);
  assert.equal(preAborted.questionRequests.length, 0); assert.equal(preAborted.observerCount, 1); controls++;
  const cancel = new AbortController();
  const canceled = await nativeFixture(baseInput, { cancel: () => cancel.abort(), delayMs: 40 }, { signal: cancel.signal, ignoreSignal: true });
  assert.equal(canceled.trace!.failure, "aborted"); assert.equal(canceled.trace!.attempts[0]!.httpRequests, 1); assert.equal(canceled.trace!.attempts[0]!.costUsd, null);
  const canceledSnapshot = structuredClone(canceled.trace); await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(canceled.observerCount, 1); assert.deepEqual(canceled.trace, canceledSnapshot); assert.equal(canceled.value, null); controls++;
  const timeout = await nativeFixture(baseInput, { delayMs: 1050 }, { timeoutMs: 1000, ignoreSignal: true });
  assert.equal(timeout.trace!.failure, "timeout"); assert.equal(timeout.trace!.attempts[0]!.httpRequests, 1); assert.equal(timeout.trace!.attempts[0]!.costUsd, null);
  const timeoutSnapshot = structuredClone(timeout.trace); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(timeout.observerCount, 1); assert.deepEqual(timeout.trace, timeoutSnapshot); controls++;
  // Raw usage can arrive before a complete SDK result. It is evidence of an
  // observed chunk, not a closed final native usage record or an actual bill.
  const partial = await nativeFixture(baseInput, { doneDelayMs: 1050 }, { timeoutMs: 1000, ignoreSignal: true });
  assert.equal(partial.trace!.failure, "timeout"); assert.equal(partial.response, null); assert.equal(partial.value, null);
  assert.equal(partial.questionRequests.length, 1); assert.equal(partial.trace!.attempts[0]!.httpRequests, 1);
  assert.ok(partial.questionRequests[0]!.rawResponse!.includes('"total_tokens":15'));
  assert.equal(partial.questionRequests[0]!.rawResponse!.includes("[DONE]"), false);
  assert.equal(partial.trace!.attempts[0]!.totalTokens, null); assert.equal(partial.trace!.attempts[0]!.costUsd, null);
  const partialTrace = structuredClone(partial.trace); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(partial.observerCount, 1); assert.deepEqual(partial.trace, partialTrace); controls++;
  const observer = await nativeFixture(baseInput, {}, { onTrace() { throw new Error("synthetic observer failure"); } }); known(observer); controls++;
  assert.ok(Object.isFrozen(observer.settings) && Object.isFrozen(observer.settings.pricing) && Object.isFrozen(observer.settings.pricing.rates));
  assert.ok(Object.isFrozen(observer.trace) && Object.isFrozen(observer.trace!.attempts) && Object.isFrozen(observer.trace!.attempts[0]));
  assert.throws(() => { observer.settings.maxTokens = 1; }, TypeError); assert.throws(() => observer.value!.currentQuotes.push("changed"), TypeError); controls++;
  const invalidInput = await nativeFixture({ ...baseInput, originalQuery: "问".repeat(501) }); assert.ok(invalidInput.error); assert.equal(invalidInput.questionRequests.length, 0);
  assert.equal(invalidInput.observerCount, 0, "No valid-source hash or trace is fabricated for malformed source input"); controls++;

  // Native request contract tampering is rejected before external transport.
  for (const mutatePayload of [(value: Record<string, unknown>) => { value.model = "wrong-model"; },
    (value: Record<string, unknown>) => { value.max_completion_tokens = 1024; },
    (value: Record<string, unknown>) => { value.tools = []; },
    (value: Record<string, unknown>) => { value.messages = [{ role: "system", content: "wrong prompt" }, { role: "user", content: "{}" }]; },
    (value: Record<string, unknown>) => { value.temperature = 1; }]) {
    const failed = await nativeFixture(baseInput, {}, { mutatePayload }); assert.ok(failed.error instanceof SupportQuestionClientError);
    assert.equal(failed.trace!.attempts[0]!.httpRequests, 0); assert.equal(failed.trace!.attempts[0]!.wireHash, null); assert.equal(failed.questionRequests.length, 0); controls++;
  }
  const retry = await nativeFixture(baseInput, {}, { retry: true }); assert.equal(retry.questionRequests.length, 1); assert.equal(retry.trace!.attempts[0]!.httpRequests, 1);
  assert.ok(retry.error instanceof SupportQuestionClientError); assert.equal(retry.trace!.failure, "provider_error");
  assert.equal(retry.value, null); assert.equal(retry.trace!.attempts[0]!.totalTokens, 15); assert.equal(retry.trace!.attempts[0]!.costUsd, .000009);
  assert.equal(retry.trace!.attempts[0]!.outputHash, contentHash(JSON.stringify(answer(baseInput)))); controls++;
  const retryCny = await nativeFixture(baseInput, {}, { retry: true, selection: "qwen3.7-plus-2026-05-26" });
  assert.ok(retryCny.error instanceof SupportQuestionClientError); assert.equal(retryCny.questionRequests.length, 1); assert.equal(retryCny.value, null);
  assert.equal(retryCny.trace!.attempts[0]!.totalTokens, 15); assert.equal(retryCny.trace!.attempts[0]!.costUsd, null);
  assert.equal(retryCny.trace!.attempts[0]!.costCny, .00006); controls++;
  const costForgery = await nativeFixture(baseInput, {}, { mutateResponse(response) { response.usage.cost.total = 0; } });
  assert.ok(costForgery.error instanceof SupportQuestionClientError); assert.equal(costForgery.trace!.attempts[0]!.costUsd, null); controls++;
  const configured = await createConfiguredModelRuntime(env, "deepseek-flash");
  let logicalCalls = 0;
  const logical = await createSupportQuestionClient({ env, runtime: { model: configured.model, async complete() { logicalCalls++; return positive.response!; } } });
  let logicalTrace: SupportQuestionTrace | undefined;
  await assert.rejects(logical.resolve(baseInput, { onTrace: value => { logicalTrace = value; } }), SupportQuestionClientError);
  assert.equal(logicalCalls, 1); assert.equal(logicalTrace!.attempts[0]!.httpRequests, 0); assert.equal(logicalTrace!.attempts[0]!.costUsd, null); controls++;
  for (const changedModel of [{ ...configured.model, provider: "bailian" }, { ...configured.model, id: "deepseek-v4-pro" },
    { ...configured.model, baseUrl: "https://foreign.invalid" }, { ...configured.model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]) {
    await assert.rejects(createSupportQuestionClient({ env, runtime: { model: changedModel, complete: async () => { throw new Error("must not execute"); } } })); controls++;
  }
  for (const timeoutMs of [0, 999, 15001, NaN, 1.5]) { await assert.rejects(createSupportQuestionClient({ env, timeoutMs })); controls++; }
  await assert.rejects(createSupportQuestionClient({ env: { MODEL_PROVIDER: "bailian", MODEL_API_KEY: "synthetic-global-only" } }), /DEEPSEEK_API_KEY/); controls++;
  await assert.rejects(createSupportQuestionClient({ env: { MODEL_API_KEY: "synthetic-global-only" }, modelSelection: "qwen3.7-plus-2026-05-26" }), /DASHSCOPE_API_KEY/); controls++;
  const allowedGlobal = await createSupportQuestionClient({ env: { MODEL_PROVIDER: "deepseek", MODEL_API_KEY: "synthetic-local-global" }, fetch: async () => { throw new Error("unused"); } });
  assert.equal(allowedGlobal.settings.model, "deepseek-flash"); controls++;
  const capture = await captureSupportQuestionClientForTest(baseInput); assert.ok(capture.response && capture.questionRequests[0]!.rawResponse); controls++;
  return { controls, boundary: "Native Pi + synthetic HTTP only; 0 remote/DB/QQ; fixture classifications do not demonstrate model semantics" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await checkSupportQuestionClient()));
