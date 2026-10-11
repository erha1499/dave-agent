import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createModelRuntime, createSession } from "../src/agent.ts";
import { runCliPrompt } from "../src/cli.ts";
import { modelFailureMessageLimit, normalizeModelFailureDetail, redactModelFailureMessage, summarizeModelFailure } from "../src/model-failure-detail.ts";
import type { ModelTaskSummary } from "../src/model-request-budget.ts";

// Reproduces the 2026-10-11 Web A1 shape (HTTP 200, stream interrupted, one
// request) with installed Pi and a local HTTP server; 0 remote model calls.
const secret = "sk-syntheticsecret0123456789", userText = "PRIVATE-USER-TEXT 我要退款";
const chunk = { id: "s", object: "chat.completion.chunk", model: "deepseek-flash",
  choices: [{ index: 0, delta: { role: "assistant", content: "部分" }, finish_reason: null }] };
let mode: "reset" | "sse_error" = "reset", received = 0;
const server = createServer(async (request, reply) => {
  received++; for await (const _part of request) { /* Drain the synthetic request. */ }
  reply.writeHead(200, { "content-type": "text/event-stream" }); reply.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (mode === "reset") setTimeout(() => reply.socket?.destroy(), 20);
  else reply.end(`data: ${JSON.stringify({ error: { message: `synthetic overload key ${secret}`, type: "server_error" } })}\n\n`);
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert.ok(address && typeof address !== "string");
const runtime = await createModelRuntime();
const model = { ...runtime.getModel("deepseek", "deepseek-flash")!, maxTokens: 2048, baseUrl: `http://127.0.0.1:${address.port}/v1` };
await runtime.setRuntimeApiKey(model.provider, "synthetic-not-a-credential");
const summaries: ModelTaskSummary[] = [], previousError = console.error, previousLimit = process.env.MODEL_TASK_HTTP_LIMIT;
console.error = (...values: unknown[]) => {
  if (typeof values[0] === "string" && values[0].startsWith("[model-task] ")) summaries.push(JSON.parse(values[0].slice(13)) as ModelTaskSummary);
  else previousError(...values);
};
process.env.MODEL_TASK_HTTP_LIMIT = "4";
async function failedTurn(next: typeof mode) {
  mode = next; received = 0;
  const session = await createSession(runtime, model, "合成检查", [], { skills: [], diagnostics: [] });
  try {
    // The real CLI/Web driver: Web A1 reached the provider through runCliPrompt.
    await assert.rejects(runCliPrompt(session, userText, async () => assert.fail("A failed model turn must not deliver"),
      undefined, undefined, { prompt: userText }));
  } finally { session.dispose(); }
  const summary = summaries.at(-1)!;
  assert.equal(received, 1); assert.equal(summary.failureReason, "model_failed"); assert.equal(summary.httpRequests, 1);
  assert.equal(summary.attempts[0]!.httpStatus, 200); assert.equal(summary.attempts[0]!.outcome, "interrupted");
  assert.equal(summary.totalTokens, null, "Unknown usage stays unknown, not zero");
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, /PRIVATE-USER-TEXT|我要退款|syntheticsecret|synthetic-not-a-credential|"data:/u);
  return summary;
}
try {
  const reset = await failedTurn("reset");
  // Before: Pi only saw the budget error, so the ledger had no cause at all.
  assert.deepEqual(reset.attempts[0]!.failure, { source: "stream_read_error", errorName: "TypeError", message: "terminated; cause SocketError: other side closed" });
  assert.equal(reset.failureDetail?.source, "assistant_error");
  assert.match(reset.failureDetail?.message ?? "", /^本轮模型请求已停止/u, "Task detail shows the masked Pi message; the attempt keeps the real cause");

  const sseError = await failedTurn("sse_error");
  assert.equal(sseError.attempts[0]!.failure, null, "A consumer cancel is not a transport/read error");
  assert.deepEqual(sseError.failureDetail, { source: "assistant_error", errorName: null, message: "synthetic overload key [redacted]" });
} finally {
  console.error = previousError;
  if (previousLimit === undefined) delete process.env.MODEL_TASK_HTTP_LIMIT; else process.env.MODEL_TASK_HTTP_LIMIT = previousLimit;
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

// Bounds and redaction of the summary itself.
assert.equal(redactModelFailureMessage(`400: {"error":{"message":"bad request","type":"invalid_request_error","param":"${userText}"}}\nraw body`),
  "400: invalid_request_error bad request");
assert.equal(redactModelFailureMessage("401 Authorization: Bearer abc.def api_key=xyz"), "401 Authorization: [redacted] api_key=[redacted]");
assert.equal(redactModelFailureMessage(`${"长".repeat(400)}`)!.length, modelFailureMessageLimit);
assert.equal(redactModelFailureMessage(" \n "), null); assert.equal(redactModelFailureMessage(42), null);
assert.deepEqual(summarizeModelFailure("prompt_error", Object.assign(new Error("x"), { name: "Bad Name<script>" })),
  { source: "prompt_error", errorName: null, message: "x" });
assert.deepEqual(normalizeModelFailureDetail({ source: "transport_error", errorName: "Error", message: `${secret}\nsecond line` }),
  { source: "transport_error", errorName: "Error", message: "[redacted]" });
assert.throws(() => normalizeModelFailureDetail({ source: "other" as never, errorName: null, message: null }));
console.log("Model failure detail checks passed: native Pi HTTP 200 reset/SSE error through runCliPrompt record a bounded attempt cause and task detail; JSON bodies, secrets, user text and extra lines are excluded. Local HTTP only; 0 remote/MySQL/QQ.");
