import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import type { EvalSpan } from "../src/evaluation.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import { analyzeSupportSpans } from "../src/support-evaluation.ts";
import type { SupportCall } from "../src/support-controller.ts";
import type { SupportQuestionObservation } from "../src/support-question-resolution.ts";
import { cancelSupportTurn, createSupportSession, getSupportResult, prepareSupportPrompt } from "../src/support-session.ts";
import { resolveSupportRunParameters } from "../src/support-parameters.ts";
import { createObjectiveSnapshot, hash } from "./objective-support.ts";
import { auditSupportKnowledgeCall, createQuestionExperimentBridge, readSupportQuestionFlags } from "./support-v2-live.ts";

type Turn = { id: string; trigger: "user"; spans: EvalSpan[]; questionObservations: SupportQuestionObservation[] };
const turn = (id: string): Turn => ({ id, trigger: "user", questionObservations: [], spans: [{ id, parentSpanId: null, actor: "host", trigger: "user",
  component: "qq-ingress", name: "turn", observedAt: new Date().toISOString(), durationMs: null, outcome: "ok" }] });
const order: Awaited<ReturnType<CouponStore["getOrder"]>> = { source: "demo-database", id: "COUPON-9901", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 6000, paidCents: 6000, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: "question-experiment-shop", name: "合成门店", merchantName: "合成商家", address: "合成地址" },
  items: [{ id: "question-experiment-item", productId: "question-experiment-lunch", productName: "演示午餐券", quantity: 1, unitPriceCents: 6000, totalCents: 6000 }],
  coupons: [{ id: "question-experiment-coupon", orderItemId: "question-experiment-item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 6000, paidAt: null }], refunds: [] };
const question = "COUPON-9901 这张演示午餐券，一张券包含几位用餐者？";
function sse(model: string, delta: object, tool = false, usage = true) {
  const chunk = (part: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "question-experiment-check", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: part, finish_reason }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`;
  return chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n";
}

// Actual Pi streams, Controller and knowledge service consume native fake HTTP.
// Fixed actions/decisions verify wiring and accounting, never model semantics.
async function harness(contract: "v2" | "v3", initialMode: "success" | "invalid" | "unknown" | "cancel" = "success") {
  const env = { DEEPSEEK_API_KEY: "synthetic-not-a-credential", MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash" };
  const agent = await createConfiguredModelRuntime(env, "deepseek-flash"), parser = await createConfiguredModelRuntime(env, "deepseek-flash");
  const parameters = resolveSupportRunParameters("controller", contract === "v3" ? { questionContract: "v3", questionTimeoutMs: 1000 } : {});
  let active: Turn | undefined, mode = initialMode, dispatched: (() => void) | undefined, release: (() => void) | undefined, agentCalls = 0, totalAgentCalls = 0;
  const sent = new Promise<void>(resolve => { dispatched = resolve; });
  const questionBodies: Array<Record<string, unknown>> = [], agentBodies: Array<Record<string, unknown>> = [], calls: SupportCall[] = [];
  const bridge = await createQuestionExperimentBridge(parameters, () => active, { env, runtime: { model: parser.model,
    complete: (context, options) => parser.modelRuntime.complete(parser.model, context, options) }, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.messages[1].content); questionBodies.push(body);
      assert.equal(body.max_tokens, 1024); assert.equal(body.temperature, 0); assert.equal(body.tools, undefined);
      assert.equal(input.originalQuery, question); assert.equal(input.previousTopic, null); dispatched?.();
      if (mode === "cancel") await new Promise<void>(resolve => { release = resolve; }); // Deliberately ignore abort; late SDK cannot publish.
      const content = mode === "invalid" ? "{invalid" : JSON.stringify({ decision: "current_complete", currentQuotes: [input.originalQuery], previousRequestId: null });
      return new Response(sse(body.model, { role: "assistant", content }, false, mode !== "unknown"), { headers: { "content-type": "text/event-stream" } });
    } });
  const action = { kind: "policy", question, questionContext: { kind: "standalone" }, orderRef: { kind: "explicit", orderId: order.id }, evidenceTarget: { kind: "current_order" } };
  const original = agent.modelRuntime.streamSimple.bind(agent.modelRuntime);
  agent.modelRuntime.streamSimple = (model, context, options) => original(model, context, { ...options, maxRetries: 0, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); agentBodies.push(body); const tool = agentCalls++ % 2 === 0; totalAgentCalls++;
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `question-experiment-tool-${totalAgentCalls}`, type: "function",
      function: { name: "support_action", arguments: JSON.stringify({ action }) } }] } : { role: "assistant", content: "固定工程回复，不表示真实模型理解。" };
    return new Response(sse(body.model, delta, tool), { headers: { "content-type": "text/event-stream" } });
  } });
  const identity = { appId: "QUESTION_EXPERIMENT_CHECK", senderId: contract }, groupOpenid = "question-experiment-check";
  let reads = 0, knowledgeReads = 0;
  const store = { async getOrder(actor: typeof identity, id: string) { reads++; assert.deepEqual(actor, identity); assert.equal(id, order.id); return structuredClone(order); } } as unknown as CouponStore;
  const knowledge = createKnowledgeService({ async readKnowledgeDocuments() { knowledgeReads++; return [{ id: "QUESTION-EXPERIMENT-LUNCH",
    title: "演示午餐人数", body: "演示午餐券每张包含两位用餐者。", tags: ["午餐", "人数"], shopId: order.shop.id, productId: order.items[0]!.productId }]; } });
  const session = await createSupportSession(identity, store, agent.modelRuntime, agent.model, undefined, { groupOpenid, knowledge,
    ...bridge.sessionOptions, onCall: call => calls.push(structuredClone(call)) }); session.setAutoRetryEnabled(false);
  async function run(id: string) {
    active = turn(id); const captured = active, capture = captureEvaluationTurn(`${agent.model.provider}/${agent.model.id}`);
    const unsubscribe = session.subscribe(capture.receive); prepareSupportPrompt(session, { requestId: id, messageId: id, groupOpenid });
    try { await session.prompt(question, { expandPromptTemplates: false }); } finally { unsubscribe(); }
    const result = getSupportResult(session); return { captured, result, steps: capture.finish().steps };
  }
  return { bridge, parameters, parser, session, calls, questionBodies, agentBodies, run, sent,
    current: () => active, setCurrent(value: Turn | undefined) { active = value; },
    release() { release?.(); }, reset() { mode = "success"; agentCalls = 0; },
    counts: () => ({ reads, knowledgeReads }), dispose() { cancelSupportTurn(session); session.dispose(); agent.modelRuntime.streamSimple = original; } };
}

export async function checkSupportQuestionExperiment() {
  const legacy = await harness("v2");
  try {
    const actual = await legacy.run("experiment-v2"); assert.equal(actual.result?.outcome, "ready"); assert.equal(legacy.questionBodies.length, 0);
    assert.equal(actual.captured.questionObservations.length, 0); assert.equal(actual.captured.spans.filter(span => span.component === "support-question").length, 0);
    assert.deepEqual(legacy.bridge.snapshot, { questionContract: "v2", questionModel: null, questionTimeoutMs: null, questionSettings: null });
    assert.equal(actual.result?.evidence.knowledge[0]?.context.evidenceBindingVersion, "order-evidence-binding-v2");
  } finally { legacy.dispose(); }
  const candidate = await harness("v3");
  try {
    const actual = await candidate.run("experiment-v3"), snapshotSettings = candidate.bridge.snapshot.questionSettings;
    assert.equal(actual.result?.outcome, "ready"); assert.equal(candidate.questionBodies.length, 1); assert.ok(snapshotSettings);
    assert.equal(snapshotSettings.model, "deepseek-flash"); assert.equal(snapshotSettings.maxTokens, 1024); assert.equal(snapshotSettings.timeoutMs, 1000);
    assert.equal(candidate.bridge.snapshot.questionModel, "configured", "Requested selection and actual model are both recorded");
    assert.equal(actual.captured.questionObservations.length, 1); assert.equal(actual.captured.questionObservations[0]!.requestId, actual.captured.id);
    const providers = actual.captured.spans.filter(span => span.component === "support-question"); assert.equal(providers.length, 1);
    assert.equal(providers[0]!.parentSpanId, actual.captured.id); assert.equal(providers[0]!.outcome, "ok"); assert.ok(providers[0]!.usage?.cost?.amount! > 0);
    assert.equal(analyzeSupportSpans(actual.captured.spans).providers[0]!.requests, 1, "Placeholder and completed attempt never double-count");
    const call = candidate.calls.find(call => call.name === "search_faq")!;
    const value = { id: call.id, input: call.input, output: call.output, knowledge: call.knowledge };
    const proof = { settings: snapshotSettings, evidence: actual.result!.evidence };
    assert.equal(auditSupportKnowledgeCall(value, candidate.parameters, false, proof).passed, true);
    assert.equal(auditSupportKnowledgeCall(value, candidate.parameters, false, proof).questionBinding, "matched");
    const v2Context = structuredClone(value); v2Context.knowledge!.context.evidenceBindingVersion = "order-evidence-binding-v2";
    assert.equal(auditSupportKnowledgeCall(v2Context, candidate.parameters, false, proof).passed, false);
    assert.equal(auditSupportKnowledgeCall(value, candidate.parameters).passed, false, "v3 cannot omit its actual parser evidence");
    const replaced = structuredClone(proof); replaced.evidence.questionResolution!.input.originalQuery = "伪造当前问题";
    assert.equal(auditSupportKnowledgeCall(value, candidate.parameters, false, replaced).passed, false);
    assert.equal(auditSupportKnowledgeCall(value, resolveSupportRunParameters("controller")).passed, false, "v2 cannot silently relabel a v3 query");
    assert.doesNotMatch(call.knowledge!.context.retrievalQuery!, /订单状态对应的规则条件：未核销退款/);
    for (const body of candidate.agentBodies) for (const message of body.messages as Array<{ role: string; content?: string }>) if (message.role === "tool") {
      assert.doesNotMatch(message.content ?? "", /questionTrace|wireHash|costUsd|support-question-trace-v1/, "Full parser/fee trace stays outside main Agent context");
    }
    const snapshot = await createObjectiveSnapshot({ plan: { version: 2, scope: "objective", answerQuality: "not_evaluated", cases: [] }, tools: [], business: { synthetic: true },
      files: ["scripts/support-v2-live.ts", "src/support-question-client.ts", "src/support-question-resolution.ts", "src/knowledge-evaluation.ts"],
      model: { provider: "deepseek", id: "deepseek-flash", maxTokens: 2048, thinking: "off", temperature: null },
      settings: { ...candidate.parameters, ...candidate.bridge.snapshot }, measurement: "Native fake HTTP engineering; no semantic result" });
    const settings = snapshot.content.settings as typeof candidate.parameters & typeof candidate.bridge.snapshot;
    assert.deepEqual(settings.questionSettings, snapshotSettings); assert.equal(settings.questionContract, "v3");
    const implementation = snapshot.content.implementation as { files: Record<string, string> };
    for (const path of ["src/support-question-client.ts", "src/support-question-resolution.ts", "scripts/support-v2-live.ts"]) {
      assert.equal(implementation.files[path], hash(await readFile(new URL(`../${path}`, import.meta.url))));
    }
    assert.throws(() => { snapshotSettings.maxTokens = 2; }, TypeError, "Actual client settings cannot be modified after snapshot");
    assert.equal(snapshotSettings.maxTokens, 1024);
  } finally { candidate.dispose(); }
  for (const mode of ["invalid", "unknown"] as const) {
    const h = await harness("v3", mode);
    try {
      const actual = await h.run(`experiment-${mode}`), provider = actual.captured.spans.find(span => span.component === "support-question")!;
      assert.equal(h.questionBodies.length, 1); assert.equal(actual.result?.outcome, mode === "invalid" ? "clarification" : "ready");
      assert.equal(provider.usage?.currency, "USD");
      if (mode === "invalid") { assert.equal(provider.outcome, "error"); assert.ok(provider.usage?.cost?.amount! > 0); assert.equal(h.counts().knowledgeReads, 0); }
      else { assert.equal(provider.usage?.cost, null); assert.equal(provider.usage?.totalTokens, null); }
      assert.equal(analyzeSupportSpans(actual.captured.spans).providers[0]!.requests, 1);
    } finally { h.dispose(); }
  }
  const cancelled = await harness("v3", "cancel");
  try {
    const work = cancelled.run("experiment-cancelled"); await cancelled.sent;
    const old = cancelled.current()!, next = turn("experiment-next"); cancelled.setCurrent(next);
    assert.equal(old.spans.filter(span => span.component === "support-question").length, 1, "Actual dispatch already records an unknown request");
    assert.equal(old.spans.find(span => span.component === "support-question")!.usage?.cost, null);
    cancelSupportTurn(cancelled.session); await cancelled.session.abort(); await Promise.allSettled([work]);
    assert.equal(getSupportResult(cancelled.session), undefined); assert.equal(cancelled.counts().knowledgeReads, 0);
    assert.equal(old.questionObservations.length, 1); assert.equal(old.questionObservations[0]!.trace.failure, "aborted");
    assert.equal(old.spans.filter(span => span.component === "support-question").length, 1); assert.equal(next.spans.length, 1); assert.equal(next.questionObservations.length, 0);
    assert.equal(analyzeSupportSpans(old.spans).providers[0]!.requests, 1); assert.equal(analyzeSupportSpans(old.spans).providers[0]!.usageReported, 0);
    cancelled.release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(getSupportResult(cancelled.session), undefined); assert.equal(old.questionObservations.length, 1); assert.equal(next.spans.length, 1);
    cancelled.reset(); const fresh = await cancelled.run("experiment-after-cancel");
    assert.equal(fresh.result?.outcome, "ready"); assert.equal(fresh.captured.questionObservations.length, 1); assert.equal(old.questionObservations.length, 1);
    assert.equal(cancelled.questionBodies.length, 2); assert.equal(fresh.captured.spans.filter(span => span.component === "support-question").length, 1);
  } finally { cancelled.release(); cancelled.dispose(); }
  assert.deepEqual(readSupportQuestionFlags([]), {});
  const flags = readSupportQuestionFlags(["--live", "--question-contract", "v3", "--question-model", "deepseek-v4-pro", "--question-timeout-ms", "1000"]);
  assert.deepEqual(flags, { questionContract: "v3", questionModel: "deepseek-v4-pro", questionTimeoutMs: 1000 });
  assert.equal(resolveSupportRunParameters("controller", flags).questionModel, "deepseek-v4-pro");
  for (const args of [["--question-model"], ["--question-contract", "--live"], ["--question-contract", "v3", "--question-contract", "v2"],
    ["--question-timeout-ms", "1e4"], ["--question-timeout-ms", "NaN"]]) assert.throws(() => readSupportQuestionFlags(args));
  console.log("Question experiment checks passed: shared actual runner bridge, native Pi HTTP v2/v3, config/code/settings snapshots, invalid/unknown fee, cancel old-ledger retention and late-result isolation, v3 consultation audit and CLI flags; remote/DB/QQ=0.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportQuestionExperiment();
