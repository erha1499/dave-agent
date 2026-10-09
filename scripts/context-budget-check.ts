import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createModelRuntime, createSession } from "../src/agent.ts";
import { createEvidenceSupportClient } from "../src/evidence-support.ts";
import { createSupportQuestionClient, SupportQuestionClientError } from "../src/support-question-client.ts";
import { ContextBudgetError, createModelRequestFetch, ModelRequestNotDispatchedError, readModelTaskLimits, withModelTask,
  type ModelRequestInfo, type ModelTaskSummary } from "../src/model-request-budget.ts";

export async function checkContextBudget() {
  const info: ModelRequestInfo = { phase: "agent", provider: "deepseek", model: "deepseek-flash", format: "openai-sse",
    context: { contextWindow: 1000000, maxOutputTokens: 2048, outputTokenField: "max_tokens" } };
  const base = { model: info.model, messages: [{ role: "user", content: "短问题" }], max_tokens: 512 };
  let sent = 0;
  const transport: typeof fetch = async () => { sent++; return new Response("ok"); };
  async function probe(payload: unknown, expected: "allowed" | "context_limit" | "context_invalid", metadata = info, limit = 4096) {
    let result: ModelTaskSummary | undefined; const before = sent;
    await withModelTask({ requestId: "context-pure", entrypoint: "check", limits: { httpRequests: 12, contextBudgetUnits: limit }, onComplete: row => { result = row; } }, async task => {
      task.setPhase("model"); const send = createModelRequestFetch(metadata, transport);
      const promise = send("https://context.invalid", { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) });
      if (expected === "allowed") await (await promise).text();
      else { await assert.rejects(promise, expected === "context_limit" ? ContextBudgetError : Error); await assert.rejects(send("https://context.invalid")); }
    });
    assert.ok(result); assert.equal(result.contextChecks.at(-1)?.decision, expected);
    assert.equal(sent - before, expected === "allowed" ? 1 : 0); assert.equal(result.httpRequests, sent - before);
    assert.equal(result.attempts.length, sent - before);
    if (expected !== "allowed") { assert.equal(result.failureReason, expected); assert.equal(result.failurePhase, "model"); assert.equal(result.unknownUsageAttempts, 0); }
    return result;
  }
  for (const value of ["", "4095", "262145", "04096", "1.5", " 4096", "Infinity", "-1"]) assert.throws(() => readModelTaskLimits({ MODEL_CONTEXT_BUDGET_UNITS: value }));
  assert.equal(readModelTaskLimits({ MODEL_CONTEXT_BUDGET_UNITS: "4096" }).contextBudgetUnits, 4096);
  const normal = await probe(base, "allowed");
  assert.equal(normal.contextChecks[0]!.outputReserve, 512);
  assert.equal(normal.contextChecks[0]!.requiredUnits, Buffer.byteLength(JSON.stringify(base)) + 512 + 1024);
  const exact = { ...base, messages: [{ role: "user", content: "x".repeat(4096 - 512 - 1024 - Buffer.byteLength(JSON.stringify({ ...base, messages: [{ role: "user", content: "" }] }))) }] };
  await probe(exact, "allowed"); await probe({ ...exact, messages: [{ role: "user", content: exact.messages[0]!.content + "x" }] }, "context_limit");
  for (const payload of [
    { ...base, messages: [{ role: "system", content: "系".repeat(1600) }, ...base.messages] },
    { ...base, messages: [{ role: "user", content: "用".repeat(1600) }] },
    { ...base, messages: [...base.messages, { role: "tool", tool_call_id: "lookup", content: "结".repeat(1600) }] },
    { ...base, tools: [{ type: "function", function: { name: "lookup", description: "规".repeat(1600), parameters: { type: "object" } } }] },
  ]) await probe(payload, "context_limit");
  const { max_tokens: _output, ...missing } = base;
  for (const payload of [missing, { ...base, max_completion_tokens: 512 }, { ...base, max_output_tokens: 512 }, { ...base, max_tokens: 0 },
    { ...base, max_tokens: -1 }, { ...base, max_tokens: 1.5 }, { ...base, max_tokens: "512" }, { ...base, max_tokens: 2049 }, "malformed"]) await probe(payload, "context_invalid");
  await probe(base, "context_invalid", { ...info, context: undefined });
  await probe(base, "context_invalid", { ...info, context: { ...info.context!, contextWindow: NaN } });
  await probe(base, "context_limit", { ...info, context: { ...info.context!, contextWindow: 1024 } });
  await probe({ ...missing, max_completion_tokens: 512 }, "allowed", { ...info, context: { ...info.context!, outputTokenField: "max_completion_tokens" } });
  const projected = await probe(base, "allowed", { ...info, context: { ...info.context!, projection: { tokens: 123, contextWindow: 1000000, percent: .0123 } } });
  assert.deepEqual(projected.contextChecks[0]!.projection, { tokens: 123, contextWindow: 1000000, percent: .0123 });
  const privateProjection = { tokens: 123, contextWindow: 1000000, percent: .0123, privateText: "SECRET_PROJECTION" };
  const redacted = await probe(base, "allowed", { ...info, context: { ...info.context!, projection: privateProjection } });
  assert.deepEqual(redacted.contextChecks[0]!.projection, { tokens: 123, contextWindow: 1000000, percent: .0123 });
  assert.ok(!JSON.stringify(redacted).includes("SECRET_PROJECTION"));
  let bodyReads = 0;
  await withModelTask({ requestId: "accessor-init", entrypoint: "check" }, async () => {
    await (await createModelRequestFetch(info, async (_input, init) => {
      assert.equal(init?.body, JSON.stringify(base)); return new Response("ok");
    })("https://context.invalid", { get body() { return ++bodyReads === 1 ? JSON.stringify(base) : JSON.stringify({ ...base, extra: "x".repeat(100000) }); } })).text();
  });
  assert.equal(bodyReads, 1, "The final body is materialized once, checked and sent unchanged");
  await withModelTask({ requestId: "invalid-format", entrypoint: "check" }, async () => {
    assert.throws(() => createModelRequestFetch({ ...info, format: "bailian-json" }, transport));
  });

  // Installed native Pi catches extension failures. The transport guard must still refuse.
  const runtime = await createModelRuntime(); await runtime.setRuntimeApiKey("deepseek", "local-fake-key");
  const model = { ...runtime.getModel("deepseek", "deepseek-flash")!, maxTokens: 512 };
  const stream = runtime.streamSimple.bind(runtime); let nativeSent = 0, hooks = 0;
  runtime.streamSimple = (selected, context, options) => stream(selected, context, { ...options, maxRetries: 0,
    fetch: createModelRequestFetch({ ...info, context: { ...info.context!, maxOutputTokens: 512 } }, async () => { nativeSent++; throw new Error("must not send"); }) });
  const session = await createSession(runtime, model, "长系统".repeat(4000), [], { skills: [], diagnostics: [] }, undefined, () => { hooks++; throw new Error("extension failed"); });
  let nativeSummary: ModelTaskSummary | undefined;
  try { await withModelTask({ requestId: "native-context", entrypoint: "check", limits: { httpRequests: 12, contextBudgetUnits: 32768 }, onComplete: row => { nativeSummary = row; } }, async () => { await session.prompt("你好"); }); }
  finally { await session.abort(); session.dispose(); }
  assert.ok(hooks > 0); assert.equal(nativeSent, 0); assert.equal(nativeSummary!.failureReason, "context_limit"); assert.equal(nativeSummary!.status, "context_limit");

  const env = { MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "local-fake-key" }; let candidateSent = 0;
  const candidateFetch: typeof fetch = async () => { candidateSent++; throw new Error("must not send"); };
  const question = await createSupportQuestionClient({ env, fetch: candidateFetch });
  let candidateSummary: ModelTaskSummary | undefined;
  await withModelTask({ requestId: "question-context", entrypoint: "check", limits: { httpRequests: 12, contextBudgetUnits: 4096 }, onComplete: row => { candidateSummary = row; } }, async () => {
    try { await question.resolve({ requestId: "question-guard", originalQuery: "周".repeat(500), previousTopic: null }); assert.fail("expected local refusal"); }
    catch (error) { assert.ok(error instanceof SupportQuestionClientError); assert.equal(error.trace.attempts[0]!.httpRequests, 0); assert.equal(error.trace.attempts[0]!.wireHash, null); }
  });
  assert.equal(candidateSummary!.failureReason, "context_limit"); assert.equal(candidateSummary!.httpRequests, 0);
  const support = await createEvidenceSupportClient({ env, fetch: candidateFetch });
  await withModelTask({ requestId: "support-context", entrypoint: "check", limits: { httpRequests: 12, contextBudgetUnits: 4096 }, onComplete: row => { candidateSummary = row; } }, async () => {
    await assert.rejects(support.verify("周日可以使用吗？", [{ id: "fixture", title: "使用时间", body: "周日可用。".repeat(800), tags: [], shopId: "shop", productId: "product", score: 1, rank: 1 }]));
  });
  assert.equal(candidateSent, 0); assert.equal(candidateSummary!.failureReason, "context_limit"); assert.equal(candidateSummary!.httpRequests, 0);
  for (const notDispatched of [true, false]) {
    const client = await createSupportQuestionClient({ env, fetch: async () => { throw notDispatched ? new ModelRequestNotDispatchedError() : new Error("network failed after dispatch"); } });
    await withModelTask({ requestId: "question-dispatch-trace", entrypoint: "check", onComplete: row => { candidateSummary = row; } }, async () => {
      try { await client.resolve({ requestId: "question-dispatch", originalQuery: "周日可以使用吗？", previousTopic: null }); assert.fail("Expected transport failure"); }
      catch (error) {
        assert.ok(error instanceof SupportQuestionClientError); assert.equal(error.trace.attempts[0]!.httpRequests, notDispatched ? 0 : 1);
        assert.equal(error.trace.attempts[0]!.wireHash === null, notDispatched);
      }
    });
    assert.equal(candidateSummary!.httpRequests, notDispatched ? 0 : 1);
  }
  console.log("Context budget checks passed: complete body, exact boundary, real output reserve, metadata/format failure, SDK hook/wrapper failure, candidate zero-dispatch trace; remote/DB/QQ=0.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkContextBudget();
