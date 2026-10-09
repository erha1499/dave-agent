import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fauxAssistantMessage, fauxProvider, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, createSession } from "../src/agent.ts";
import { createBailianClient } from "../src/bailian.ts";
import { createSupportQuestionClient } from "../src/support-question-client.ts";
import { createEvidenceSupportClient } from "../src/evidence-support.ts";
import { createModelRequestFetch, currentModelTask, ModelRequestNotDispatchedError, readModelTaskLimits, withModelTask,
  type ModelRequestInfo, type ModelTask, type ModelTaskSummary } from "../src/model-request-budget.ts";

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const info: ModelRequestInfo = { phase: "agent", provider: "deepseek", model: "deepseek-flash", format: "openai-sse",
  context: { contextWindow: 1000000, maxOutputTokens: 2048, outputTokenField: "max_tokens" },
  pricing: { currency: "USD", estimated: true, source: "Pi model catalog", rates: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1 } } };
function sse(text = "完成", options: { model?: string; usage?: unknown; done?: boolean; tools?: boolean } = {}) {
  const delta = options.tools ? { role: "assistant", tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "lookup", arguments: "{}" } }] }
    : { role: "assistant", content: text };
  const value = { id: "synthetic", object: "chat.completion.chunk", model: options.model ?? info.model,
    choices: [{ index: 0, delta, finish_reason: options.tools ? "tool_calls" : "stop" }], usage: Object.hasOwn(options, "usage") ? options.usage : usage };
  return `data: ${JSON.stringify(value)}\n\n${options.done === false ? "" : "data: [DONE]\n\n"}`;
}
const response = (text = sse()) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const request = { method: "POST", body: JSON.stringify({ model: info.model, messages: [{ role: "user", content: "PRIVATE" }], max_tokens: 2048 }) };
const summaries: ModelTaskSummary[] = [];
async function task(work: (task: ModelTask) => Promise<unknown>, limit = 12) {
  await withModelTask({ requestId: `synthetic-${summaries.length}`, entrypoint: "check", limits: { httpRequests: limit }, onComplete: row => summaries.push(row) }, work);
  return summaries.at(-1)!;
}

assert.deepEqual(readModelTaskLimits({}), { httpRequests: 12, contextBudgetUnits: 65536 });
for (const raw of ["", "0", "65", "01", "2.5", " 2", "Infinity", "-1"]) assert.throws(() => readModelTaskLimits({ MODEL_TASK_HTTP_LIMIT: raw }));
assert.equal((await task(async () => {})).httpRequests, 0);
const nested = await task(async outer => {
  let innerLog = 0;
  await withModelTask({ requestId: "must-not-replace-outer", entrypoint: "web", limits: { httpRequests: 64 }, onComplete: () => innerLog++ }, async inner => {
    assert.equal(inner, outer); assert.equal(currentModelTask(), outer);
    await (await createModelRequestFetch(info, async () => response())("https://synthetic.invalid", { ...request, headers: { Authorization: "SECRET" } })).text();
  });
  assert.equal(innerLog, 0);
}, 1);
assert.equal(nested.httpRequests, 1); assert.equal(nested.limits.httpRequests, 1); assert.equal(nested.totalTokens, 15);
assert.equal(nested.knownCostUsd, .00002); assert.equal(nested.unknownUsageAttempts, 0);
assert.ok(!JSON.stringify(nested).includes("PRIVATE") && !JSON.stringify(nested).includes("SECRET"));

let dispatched = 0;
const retry = await task(async () => {
  const send = createModelRequestFetch(info, async () => ++dispatched === 1 ? new Response("retry", { status: 429 }) : response());
  await (await send("https://synthetic.invalid", request)).text(); await (await send("https://synthetic.invalid", request)).text();
  await assert.rejects(send("https://synthetic.invalid", request)); await assert.rejects(send("https://synthetic.invalid", request));
}, 2);
assert.equal(dispatched, 2); assert.equal(retry.status, "http_limit"); assert.equal(retry.httpRequests, 2);
assert.equal(retry.logicalCalls, 1); assert.equal(retry.blockedRequests, 1); assert.deepEqual(retry.attempts.map(row => row.attempt), [1, 2]);
assert.equal(retry.unknownUsageAttempts, 1); assert.equal(retry.totalTokens, null);

const isolated = await Promise.all(["one", "two"].map(requestId => withModelTask({ requestId, entrypoint: "check", limits: { httpRequests: 1 } }, async () => {
  const send = createModelRequestFetch(info, async () => response()); await Promise.resolve();
  await (await send("https://synthetic.invalid", request)).text(); return currentModelTask()!.snapshot();
})));
assert.ok(isolated.every(row => row.httpRequests === 1)); assert.notEqual(isolated[0]!.requestIdHash, isolated[1]!.requestIdHash);

for (const raw of [sse("ok", { usage: null }), sse("ok", { usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 15 } }),
  sse("ok", { done: false }), sse("ok", { model: "different" })]) {
  const row = await task(async () => { await (await createModelRequestFetch(info, async () => response(raw))("https://synthetic.invalid", request)).text(); });
  assert.equal(row.unknownUsageAttempts, 1); assert.equal(row.knownCostUsd, 0); assert.equal(row.totalTokens, null);
}
const explicitZero = await task(async () => { await (await createModelRequestFetch(info, async () => response(sse("", { usage: {
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })))("https://synthetic.invalid", request)).text(); });
assert.equal(explicitZero.unknownUsageAttempts, 0, "Explicit wire zero differs from an absent SDK usage default");

let late: typeof fetch | undefined;
const ended = await task(async () => { late = createModelRequestFetch(info, async () => { throw new Error("must not dispatch"); }); });
await assert.rejects(late!("https://synthetic.invalid", request)); assert.equal(ended.httpRequests, 0);
const failure = await task(async current => {
  current.setPhase("send"); current.fail("send_unknown"); current.setPhase("receipt"); current.fail("receipt_unknown"); current.setPhase("host"); current.cancel();
});
assert.equal(failure.status, "failed"); assert.equal(failure.failurePhase, "send"); assert.equal(failure.failureReason, "send_unknown");

let canceledBody = false;
const canceled = await task(async current => {
  const send = createModelRequestFetch(info, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(sse("partial", { done: false }))); }, cancel() { canceledBody = true; },
  })));
  const body = (await send("https://synthetic.invalid", request)).body!.getReader(); await body.read();
  const waiting = body.read(); current.cancel(); await assert.rejects(waiting);
});
assert.equal(canceled.status, "canceled"); assert.equal(canceled.totalTokens, null); assert.ok(canceledBody);

const external = await task(async () => {
  const send = createModelRequestFetch(info, async () => { throw new ModelRequestNotDispatchedError(); });
  await assert.rejects(send("https://synthetic.invalid", request));
});
assert.equal(external.httpRequests, 0); assert.equal(external.attempts.length, 0); assert.equal(external.blockedRequests, 1);
assert.equal(external.failureReason, "external_limit");
const replacement = await task(async () => {
  createModelRequestFetch(info, async () => { throw new Error("discarded session wrapper"); });
  await (await createModelRequestFetch(info, async () => response())("https://synthetic.invalid", request)).text();
});
assert.equal(replacement.logicalCalls, 1, "A runtime adapter replacing an unused wrapper counts one actual logical request");

// Real installed Pi request building/stream consumption; transport is synthetic.
const env = { MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-not-a-credential", DASHSCOPE_API_KEY: "synthetic-not-a-credential", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" };
const question = await createSupportQuestionClient({ env, modelSelection: "deepseek-flash", fetch: async (_url, init) => {
  const body = JSON.parse(String(init!.body)); const input = JSON.parse(body.messages[1].content);
  return response(sse(JSON.stringify({ decision: "current_complete", currentQuotes: [input.originalQuery], previousRequestId: null })));
} });
const support = await createEvidenceSupportClient({ env, modelSelection: "deepseek-flash", fetch: async () => response(sse(JSON.stringify({
  decisions: [{ id: "faq-1", supported: true, quote: "支持预约", reason: "直接说明" }],
}))) });
const rerank = createBailianClient({ env, retries: 0, fetch: async () => Response.json({ results: [{ index: 0, relevance_score: .9 }], usage: { total_tokens: 8 } }) });
const candidates = await task(async () => {
  await question.resolve({ requestId: "question-1", originalQuery: "可以预约吗？", previousTopic: null });
  await support.verify("可以预约吗？", [{ id: "faq-1", title: "预约", body: "支持预约", tags: [], shopId: "shop-1", productId: "product-1", score: .9, rank: 1 }]);
  await rerank.rerank("可以预约吗？", ["支持预约"]);
});
assert.deepEqual(candidates.attempts.map(row => row.phase), ["question", "support", "rerank"]);
assert.equal(candidates.httpRequests, 3); assert.equal(candidates.unknownUsageAttempts, 0); assert.equal(candidates.knownTokens, 38);
assert.ok(candidates.knownCostUsd > 0 && candidates.knownCostCny > 0);

const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
const local = await createSession(runtime, faux.getModel(), "本地检查", [], { skills: [], diagnostics: [] });
faux.setResponses([fauxAssistantMessage("本地完成")]);
try { const row = await task(async () => { await local.prompt("hello"); }); assert.equal(row.localCalls, 1); assert.equal(row.httpRequests, 0); }
finally { local.dispose(); }

// Native HTTP proves that AgentSession's own automatic retry and post-tool calls
// pass the same dispatch boundary, without patching global fetch or Pi internals.
let received = 0, mode: "normal" | "retry" | "tool" = "normal", toolRuns = 0;
const server = createServer(async (request, reply) => {
  received++; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (mode === "retry" && received === 1) { reply.writeHead(429, { "content-type": "application/json", "retry-after": "0" }); reply.end(JSON.stringify({ error: { message: "synthetic retry", type: "rate_limit_error" } })); return; }
  reply.writeHead(200, { "content-type": "text/event-stream" }); reply.end(sse("完成", { model: body.model, tools: mode === "tool" }));
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert.ok(address && typeof address !== "string");
const model = { ...runtime.getModel("deepseek", "deepseek-flash")!, maxTokens: 2048, baseUrl: `http://127.0.0.1:${address.port}/v1` };
await runtime.setRuntimeApiKey(model.provider, "synthetic-not-a-credential");
const session = await createSession(runtime, model, "使用工具后回答。", [defineTool({ name: "lookup", label: "查询", description: "本地查询",
  parameters: Type.Object({}, { additionalProperties: false }), execute: async () => { toolRuns++; return { content: [{ type: "text", text: "已查到" }], details: {} }; } })],
{ skills: [], diagnostics: [] });
try {
  const normal = await task(async () => { await session.prompt("正常回答"); });
  assert.equal(normal.httpRequests, 1); assert.equal(normal.unknownUsageAttempts, 0, "Native SDK normal [DONE] cancellation closes known usage");
  received = 0; mode = "retry";
  const nativeRetry = await task(async () => { await session.prompt("重试回答"); }, 3);
  assert.equal(received, 2); assert.equal(nativeRetry.httpRequests, 2); assert.equal(nativeRetry.unknownUsageAttempts, 1);
  received = 0; mode = "tool";
  const limited = await task(async () => { await session.prompt("先查再回答"); }, 1);
  assert.equal(received, 1); assert.equal(limited.status, "http_limit"); assert.equal(limited.httpRequests, 1); assert.equal(toolRuns, 1);
} finally { session.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log("Model task budget checks passed: scope isolation/nesting, host0/faux, native Pi HTTP/SSE/retry/tool loop, all candidate phases, blocked/late dispatch, first failure, unknown usage, CNY/USD, redaction; remote model/DB/QQ=0.");
