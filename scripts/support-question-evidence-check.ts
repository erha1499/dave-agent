import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import { createSupportQuestionClient } from "../src/support-question-client.ts";
import type { SupportQuestionResolution, SupportQuestionResolver } from "../src/support-question-resolution.ts";
import type { TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import { cancelSupportTurn, createSupportSession, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { assertC1PolicyScopeRepairEvidence, assertC1QuestionEvidence, knowledgeProofPassed, scoreC1ValidationTurn,
  type C1QuestionCall, type C1ValidationActual, type C1ValidationHistory, type C1ValidationKnowledgeConfiguration, type C1ValidationTurn } from "./c1-session-validation-check.ts";
import { scoreC1ReferenceEvidence } from "./c1-reference-evidence.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Step = { action: unknown } | { text: string };
type Captured = C1ValidationActual & { question: string };
const finish: Step = { text: "固定工程回复只验证出处、执行和费用，不证明模型理解正确。" };
// Original synthetic documents, never inserted into the online corpus or a DB.
const corpus: RetrievalDocument[] = [
  { id: "QUESTION-PROOF-LUNCH", title: "模拟午餐规则", body: "此模拟午餐券每张对应两位顾客。普通周六可以使用，法定节假日须另行确认。未核销券的退款申请须由商家审核，本规则不证明已经获批。", tags: ["午餐", "两位", "周六"], shopId: "question-proof-shop", productId: "question-proof-lunch", status: "active" },
  { id: "QUESTION-PROOF-DINNER", title: "模拟晚餐规则", body: "此模拟晚餐券每张对应三位顾客。普通周六可以使用，法定节假日须另行确认。", tags: ["晚餐", "三位", "周六"], shopId: "question-proof-shop", productId: "question-proof-dinner", status: "active" },
];
const initial: Order = { source: "demo-database", id: "COUPON-9901", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: "question-proof-shop", name: "咨询出处演示店", merchantName: "合成商家", address: "合成地址" },
  items: [{ id: "question-proof-item", productId: "question-proof-lunch", productName: "演示午餐券", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
  coupons: [{ id: "question-proof-coupon", orderItemId: "question-proof-item", status: "unused", expiresAt: "2026-12-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 7980, paidAt: null }], refunds: [] };
function lastHost(messages: readonly unknown[]): C1ValidationActual["hostReference"] {
  return messages.flatMap(message => {
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; }
  }).at(-1) ?? {};
}
function sse(model: string, delta: object, tool = false, usage = true, promptTokens = 20) {
  const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "question-proof", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } } : {}) })}\n\n`;
  return chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n";
}

// Actual Pi Session and actual Pi complete consume fake native SSE. Decisions
// are fixed engineering inputs; this check has no remote transport or DB.
async function harness(name: string, qwen = false) {
  const agentRuntime = await createModelRuntime(), model = agentRuntime.getModel("deepseek", "deepseek-flash")!;
  await agentRuntime.setRuntimeApiKey("deepseek", "synthetic-not-a-credential");
  const configured = await createConfiguredModelRuntime(qwen ? { DASHSCOPE_API_KEY: "synthetic-not-a-credential" }
    : { DEEPSEEK_API_KEY: "synthetic-not-a-credential" }, qwen ? "qwen3.7-plus-2026-05-26" : "deepseek-flash");
  const identity = { appId: "QUESTION_EVIDENCE_CHECK", senderId: name }, groupOpenid = `question-evidence-${name}`;
  let active: Captured | undefined, order = structuredClone(initial), steps: Step[] = [], ordinal = 0;
  const alternative: Order = { ...structuredClone(initial), id: "COUPON-9902",
    items: initial.items.map(item => ({ ...item, id: "question-proof-alternative-item" })),
    coupons: initial.coupons.map(coupon => ({ ...coupon, id: "question-proof-alternative-coupon", orderItemId: "question-proof-alternative-item" })) };
  let decision: SupportQuestionResolution["decision"] = "current_complete", failure: "extra" | "unknown-usage" | "http400" | "abort" | "over-tier" | undefined;
  let pending: Omit<C1QuestionCall, "trace" | "observedAt"> | undefined;
  const questionFetch: typeof fetch = async (url, init) => {
    assert.ok(active && pending); init?.signal?.throwIfAborted();
    const startedAt = new Date().toISOString(), body = String(init?.body), payload = JSON.parse(body);
    const input = JSON.parse(payload.messages.at(-1).content);
    const value = { decision, currentQuotes: decision === "needs_clarification" ? [] : [input.originalQuery],
      previousRequestId: decision === "previous_resolved" ? input.previousTopic?.requestId ?? null : null,
      ...(failure === "extra" ? { inventedQuestion: "未经用户提出的退款诉求" } : {}) };
    const status = failure === "http400" ? 400 : 200;
    const rawResponse = status === 400 ? JSON.stringify({ error: { message: "synthetic provider failure", type: "invalid_request_error" } })
      : sse(payload.model, { role: "assistant", content: JSON.stringify(value) }, false, failure !== "unknown-usage", failure === "over-tier" ? 300000 : 20);
    pending.wire = { endpoint: String(url), method: "POST", body, startedAt, rawResponse, status };
    active.requests.push({ operation: "question", caseId: name, turn: active.turn, startedAt, httpStatus: status, error: null });
    if (failure === "abort") {
      pending.wire.rawResponse = null; pending.wire.status = null;
      active.requests.at(-1)!.httpStatus = null; active.requests.at(-1)!.error = "request_failed";
      queueMicrotask(() => cancelSupportTurn(session));
      await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }
    return new Response(rawResponse, { status, headers: { "content-type": status === 400 ? "application/json" : "text/event-stream" } });
  };
  const client = await createSupportQuestionClient({ modelSelection: qwen ? "qwen3.7-plus-2026-05-26" : "deepseek-flash", timeoutMs: 1000,
    fetch: questionFetch, runtime: { model: configured.model, complete: async (context, options) => {
      const response = await configured.modelRuntime.complete(configured.model, context, options);
      assert.ok(pending);
      // A response after the sealed callback is late, not the actual consumed
      // SDK completion. It must not replace unknown usage in the published row.
      if (!active?.questionCalls?.length) pending.response = structuredClone(response); return response;
    } } });
  const resolver: SupportQuestionResolver = { settings: client.settings, resolve(input, options) {
    pending = { input: structuredClone(input), wire: null, response: null }; return client.resolve(input, options);
  } };
  const fakeAgent: typeof fetch = async (_url, init) => {
    assert.ok(active); init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body)), next = steps.shift();
    assert.ok(next, "Unexpected native Agent HTTP or retry");
    active.requests.push({ operation: "agent", caseId: name, turn: active.turn, startedAt: new Date().toISOString(), httpStatus: 200, error: null });
    const tool = "action" in next, delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `question-proof-${ordinal}-${active.requests.length}`,
      type: "function", function: { name: "support_action", arguments: JSON.stringify({ action: next.action }) } }] } : { role: "assistant", content: next.text };
    return new Response(sse(body.model, delta, tool), { headers: { "content-type": "text/event-stream" } });
  };
  const originalStream = agentRuntime.streamSimple.bind(agentRuntime);
  agentRuntime.streamSimple = (selected, context, options) => originalStream(selected, context, { ...options, maxRetries: 0, fetch: fakeAgent });
  const knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(corpus) }, { mode: "lexical", queryMode: "combined" });
  const store = { async getOrder(actor: typeof identity, id: string) {
    if (!active || actor.appId !== identity.appId || actor.senderId !== identity.senderId || ![order.id, alternative.id].includes(id)) throw new OrderAccessError("Synthetic ownership denied");
    return structuredClone(id === order.id ? order : alternative);
  }, async searchKnowledge() { throw new Error("Actual knowledge service required"); } } as unknown as CouponStore;
  const session = await createSupportSession(identity, store, agentRuntime, model, undefined, { groupOpenid, knowledge, repairBudget: 1,
    questionContract: "v3", questionResolver: resolver, onQuestionTrace(observation) {
      assert.ok(active && pending); assert.equal(observation.requestId, active.requestId); assert.deepEqual(observation.input, pending.input);
      active.questionCalls!.push({ ...structuredClone(pending), trace: structuredClone(observation.trace), observedAt: observation.observedAt });
    } });
  session.setAutoRetryEnabled(false);
  const configuration: C1ValidationKnowledgeConfiguration = { evidenceBindingVersion: "order-evidence-binding-v3", questionSettings: client.settings,
    queryMode: "combined", referenceEvidenceRequired: true, policyScopeRepair: { version: "policy-scope-repair-v1", maxRepairs: 1, repairBudget: 1 } };
  const history: C1ValidationHistory[number][] = [];
  const policy = (question: string, previous?: string) => ({ kind: "policy", question, orderRef: { kind: "explicit", orderId: order.id },
    questionContext: previous ? { kind: "previous", requestId: previous } : { kind: "standalone" } });
  async function run(question: string, responses: Step[], options: { decision?: typeof decision; failure?: typeof failure } = {}) {
    decision = options.decision ?? "current_complete"; failure = options.failure; pending = undefined; steps = [...responses];
    const requestId = `question-evidence-${name}-${++ordinal}`;
    const row: Captured = { caseId: name, turn: ordinal, requestId, question, execution: "not_run", durationMs: null, calls: [], steps: [], requests: [], questionCalls: [],
      ingress: { identity, groupOpenid, messageId: requestId, requestId, observedAt: new Date().toISOString() } }; active = row;
    const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), before = session.messages.length;
    prepareSupportPrompt(session, { requestId, messageId: requestId, groupOpenid, onCall: call => row.calls.push(structuredClone(call)) });
    const unsubscribe = session.subscribe(capture.receive); let failed = false;
    try { await session.prompt(question, { expandPromptTemplates: false }); } catch { failed = true; } finally { unsubscribe(); }
    const measured = capture.finish(); row.durationMs = measured.durationMs; row.steps = measured.steps; row.execution = failed || measured.failed ? "failed" : "completed";
    const result = getSupportResult(session); if (result) row.result = structuredClone(result);
    row.reply = supportReply(session, session.getLastAssistantText() ?? ""); row.hostReference = lastHost(session.messages.slice(before));
    assert.equal(steps.length, 0); return row;
  }
  return { run, policy, history, configuration, currentOrder: () => structuredClone(order), alternativeOrder: () => structuredClone(alternative), change() {
    order.items[0] = { ...order.items[0]!, productId: "question-proof-dinner", productName: "演示晚餐券" };
  }, dispose() { cancelSupportTurn(session); session.dispose(); agentRuntime.streamSimple = originalStream; } };
}

function expected(actual: Captured, order: Order): C1ValidationTurn {
  const rules = actual.result!.evidence.rules;
  return { question: actual.question, expected: { allowedKinds: ["policy", "clarify"], outcome: actual.result!.outcome as "ready" | "clarification",
    knowledge: rules.length ? "evidence" : "none", gold: rules.map(rule => ({ sourceId: rule.sourceId, quote: rule.body })),
    scope: { shopId: order.shop.id, productId: order.items[0]!.productId }, freshOrder: order,
    answerCriteria: [{ id: "engineering-only", kind: "condition", statement: "工程固定输入不计真实答案质量", basis: "本检查不含真实模型语义验收" }] } };
}

export async function checkSupportQuestionEvidence() {
  const captures: Array<{ actual: Captured; history: C1ValidationHistory; configuration: C1ValidationKnowledgeConfiguration }> = [];
  const h = await harness("native");
  try {
    const baseQuestion = "请核对 COUPON-9901 的演示午餐券，一张券对应的人数是多少？";
    const first = await h.run(baseQuestion, [{ action: h.policy(baseQuestion) }, finish]);
    assert.ok(first.result?.verifiedPolicyTopic); assert.ok(knowledgeProofPassed(first, corpus, h.configuration, first.question));
    const firstScore = scoreC1ValidationTurn(expected(first, h.currentOrder()), first, corpus, undefined, h.configuration);
    assert.equal(firstScore.engineeringPassed, true); assert.equal(firstScore.knowledgePassed, true); assert.equal(firstScore.passed, false);
    captures.push({ actual: first, history: [], configuration: h.configuration }); h.history.push({ question: first.question, actual: first });
    const followQuestion = "仍是 COUPON-9901，我刚才问的这张券普通周六呢？";
    const follow = await h.run(followQuestion, [{ action: h.policy(followQuestion, first.requestId!) }, finish], { decision: "previous_resolved" });
    assert.ok(knowledgeProofPassed(follow, corpus, h.configuration, follow.question, h.history));
    captures.push({ actual: follow, history: [...h.history], configuration: h.configuration }); h.history.push({ question: follow.question, actual: follow });
    h.change(); const restated = "重新按 COUPON-9901 当前演示晚餐券核对，一张券按规则对应几位顾客？";
    const repaired = await h.run(restated, [{ action: h.policy(restated, follow.requestId!) }, { action: h.policy(restated) }, finish]);
    assert.ok(repaired.result?.evidence.policyScopeRepair); assert.equal(repaired.questionCalls!.length, 1);
    assertC1PolicyScopeRepairEvidence(repaired, repaired.question, h.history, corpus, h.configuration);
    assert.ok(knowledgeProofPassed(repaired, corpus, h.configuration, repaired.question, h.history));
    captures.push({ actual: repaired, history: [...h.history], configuration: h.configuration }); h.history.push({ question: repaired.question, actual: repaired });
    const omitted = "COUPON-9901，刚才那个问题还怎么算呢？";
    const stopped = await h.run(omitted, [{ action: h.policy(omitted) }, finish], { decision: "needs_clarification" });
    assertC1QuestionEvidence(stopped, stopped.question, h.history, corpus, h.configuration);
    const stopScore = scoreC1ValidationTurn(expected(stopped, h.currentOrder()), stopped, corpus, undefined, h.configuration, h.history);
    assert.equal(stopScore.engineeringPassed, true, JSON.stringify(stopScore)); assert.equal(stopScore.knowledgePassed, true); assert.equal(stopScore.passed, false);
    assert.deepEqual(stopped.calls.map(call => call.name), ["get_order"]);
    captures.push({ actual: stopped, history: [...h.history], configuration: h.configuration }); h.history.push({ question: stopped.question, actual: stopped });
    const invalid = await h.run(restated, [{ action: h.policy(restated) }, finish], { failure: "extra" });
    assertC1QuestionEvidence(invalid, invalid.question, h.history, corpus, h.configuration);
    assert.equal(invalid.questionCalls![0]!.trace.failure, "invalid_response");
    assert.ok(invalid.questionCalls![0]!.trace.attempts[0]!.costUsd! > 0, "Billed invalid output retains actual known usage");
    assert.ok(knowledgeProofPassed(invalid, corpus, h.configuration, invalid.question, h.history));
    const invalidScore = scoreC1ValidationTurn(expected(invalid, h.currentOrder()), invalid, corpus, undefined, h.configuration, h.history);
    assert.equal(invalidScore.engineeringPassed, true); assert.equal(invalidScore.knowledgePassed, true); assert.equal(invalidScore.passed, false);
    captures.push({ actual: invalid, history: [...h.history], configuration: h.configuration }); h.history.push({ question: invalid.question, actual: invalid });
    const unknown = await h.run(restated, [{ action: h.policy(restated) }, finish], { failure: "unknown-usage" });
    assertC1QuestionEvidence(unknown, unknown.question, h.history, corpus, h.configuration);
    assert.equal(unknown.questionCalls![0]!.trace.attempts[0]!.totalTokens, null); assert.equal(unknown.questionCalls![0]!.trace.attempts[0]!.costUsd, null);
    captures.push({ actual: unknown, history: [...h.history], configuration: h.configuration }); h.history.push({ question: unknown.question, actual: unknown });
    const denied = await h.run(restated, [{ action: h.policy(restated) }, finish], { failure: "http400" });
    assertC1QuestionEvidence(denied, denied.question, h.history, corpus, h.configuration); assert.equal(denied.questionCalls![0]!.trace.failure, "provider_error");
    captures.push({ actual: denied, history: [...h.history], configuration: h.configuration });
  } finally { h.dispose(); }
  const cny = await harness("cny", true);
  try {
    const question = "COUPON-9901 的演示午餐套餐，规则写明每券对应多少位？";
    const actual = await cny.run(question, [{ action: cny.policy(question) }, finish]);
    assertC1QuestionEvidence(actual, question, [], corpus, cny.configuration);
    assert.equal(actual.questionCalls![0]!.trace.attempts[0]!.costUsd, null);
    assert.equal(actual.questionCalls![0]!.trace.attempts[0]!.costCny, .00012);
    assert.ok(knowledgeProofPassed(actual, corpus, cny.configuration, question));
    captures.push({ actual, history: [], configuration: cny.configuration });
  } finally { cny.dispose(); }
  const repairStop = await harness("repair-clarify");
  try {
    const firstQuestion = "COUPON-9901 这份演示午餐券，券面人数怎样规定？";
    const first = await repairStop.run(firstQuestion, [{ action: repairStop.policy(firstQuestion) }, finish]);
    repairStop.history.push({ question: firstQuestion, actual: first }); repairStop.change();
    const question = "完整核对 COUPON-9901 现在的演示晚餐券，每券对应的人数如何规定？";
    const actual = await repairStop.run(question, [{ action: repairStop.policy(question, first.requestId!) }, { action: { kind: "clarify", field: "policy_topic", reason: "ambiguous" } }, finish]);
    assertC1PolicyScopeRepairEvidence(actual, question, repairStop.history, corpus, repairStop.configuration);
    assert.ok(knowledgeProofPassed(actual, corpus, repairStop.configuration, question, repairStop.history));
    const score = scoreC1ValidationTurn(expected(actual, repairStop.currentOrder()), actual, corpus, undefined, repairStop.configuration, repairStop.history);
    assert.equal(score.engineeringPassed, true, JSON.stringify(score)); assert.equal(score.knowledgePassed, true); assert.equal(score.passed, false);
    captures.push({ actual, history: [...repairStop.history], configuration: repairStop.configuration });
  } finally { repairStop.dispose(); }
  const aborted = await harness("aborted");
  try {
    const question = "COUPON-9901 演示午餐券每券允许多少人？";
    const actual = await aborted.run(question, [{ action: aborted.policy(question) }], { failure: "abort" });
    assert.equal(actual.result, undefined); assert.equal(actual.questionCalls!.length, 1);
    assert.equal(actual.questionCalls![0]!.trace.failure, "aborted");
    assertC1QuestionEvidence(actual, question, [], corpus, aborted.configuration);
    assert.equal(actual.questionCalls![0]!.trace.attempts[0]!.costUsd, null);
    captures.push({ actual, history: [], configuration: aborted.configuration });
  } finally { aborted.dispose(); }
  const alt = await harness("alternative");
  try {
    for (const id of ["COUPON-9902", "COUPON-9901"]) {
      const question = `查看本人订单 ${id} 的当前状态。`;
      const actual = await alt.run(question, [{ action: { kind: "order", orderRef: { kind: "explicit", orderId: id } } }, finish]);
      assert.equal(actual.execution, "completed"); assert.ok(actual.result?.evidence.order);
      alt.history.push({ question, actual });
    }
    const oldQuestion = "COUPON-9901 的未核销午餐券申请退款需先由谁审核？只咨询规则。";
    const donor = await alt.run(oldQuestion, [{ action: { ...alt.policy(oldQuestion), kind: "refund_eligibility" } }, finish]);
    assert.ok(donor.result?.verifiedPolicyTopic); alt.history.push({ question: oldQuestion, actual: donor });
    const question = "请核对另一张订单的演示午餐券，一张券按规则对应多少人？";
    const actual = await alt.run(question, [{ action: { kind: "policy", question, orderRef: { kind: "alternative" }, questionContext: { kind: "standalone" } } }, finish]);
    assertC1QuestionEvidence(actual, question, alt.history, corpus, alt.configuration);
    assert.ok(knowledgeProofPassed(actual, corpus, alt.configuration, question, alt.history));
    assert.equal(actual.result!.evidence.order!.id, "COUPON-9902"); assert.equal(actual.questionCalls![0]!.input.previousTopic, null);
    assert.doesNotMatch(actual.calls.find(call => call.knowledge)!.knowledge!.context.retrievalQuery!, /退款/u);
    const score = scoreC1ValidationTurn(expected(actual, alt.alternativeOrder()), actual, corpus, undefined, alt.configuration, alt.history);
    assert.equal(score.engineeringPassed, true, JSON.stringify(score)); assert.equal(score.knowledgePassed, true);
    captures.push({ actual, history: [...alt.history], configuration: alt.configuration });
  } finally { alt.dispose(); }
  const hypothesis = await harness("hypothesis");
  try {
    const basis = "假设商品属于演示午餐券", question = `订单 COUPON-9901，${basis}，请只解释这类券对应的人数，不判断本单是否适用。`;
    const actual = await hypothesis.run(question, [{ action: { ...hypothesis.policy(question), evidenceTarget: { kind: "rule_only", basis } } }, finish]);
    assertC1QuestionEvidence(actual, question, [], corpus, hypothesis.configuration);
    assert.ok(knowledgeProofPassed(actual, corpus, hypothesis.configuration, question));
    assert.equal(actual.calls.find(call => call.knowledge)!.knowledge!.context.evidenceTarget!.kind, "rule_only");
    assert.doesNotMatch(actual.calls.find(call => call.knowledge)!.knowledge!.context.effectiveQuery, /已核实订单状态/u);
    captures.push({ actual, history: [], configuration: hypothesis.configuration });
  } finally { hypothesis.dispose(); }
  const recovery = await harness("recovery");
  try {
    const omitted = "COUPON-9901，那个问题呢？";
    const stopped = await recovery.run(omitted, [{ action: recovery.policy(omitted) }, finish], { decision: "needs_clarification" });
    const question = "我完整说明：COUPON-9901 的演示午餐券，每券规则人数是多少？";
    const restored = await recovery.run(question, [{ action: recovery.policy(question) }, finish]);
    const follow = "COUPON-9901，刚才问的券普通周六的使用规则呢？";
    const continued = await recovery.run(follow, [{ action: recovery.policy(follow, restored.requestId!) }, finish], { decision: "previous_resolved" });
    for (const actual of [stopped, restored, continued]) {
      assertC1QuestionEvidence(actual, actual.question, recovery.history, corpus, recovery.configuration);
      const score = scoreC1ValidationTurn(expected(actual, recovery.currentOrder()), actual, corpus, undefined, recovery.configuration, recovery.history);
      assert.equal(score.engineeringPassed, true, JSON.stringify(score)); assert.equal(score.knowledgePassed, true); assert.equal(score.passed, false);
      captures.push({ actual, history: [...recovery.history], configuration: recovery.configuration }); recovery.history.push({ question: actual.question, actual });
    }
    assert.equal((continued.hostReference as unknown as { pendingReferenceKind?: string }).pendingReferenceKind, null);
  } finally { recovery.dispose(); }
  const overTier = await harness("cny-tier", true);
  try {
    const question = "COUPON-9901 的演示午餐券，请核对每券允许人数。";
    const actual = await overTier.run(question, [{ action: overTier.policy(question) }, finish], { failure: "over-tier" });
    assertC1QuestionEvidence(actual, question, [], corpus, overTier.configuration);
    assert.equal(actual.questionCalls![0]!.trace.attempts[0]!.totalTokens, 300010);
    assert.equal(actual.questionCalls![0]!.trace.attempts[0]!.costCny, null, "Usage outside the reviewed pricing tier has unknown CNY, not zero");
    captures.push({ actual, history: [], configuration: overTier.configuration });
  } finally { overTier.dispose(); }
  let mutations = 0;
  const base = captures[0]!;
  const rejects = (label: string, mutate: (value: Captured) => void, example = base) => {
    const actual = structuredClone(example.actual); mutate(actual);
    assert.equal(knowledgeProofPassed(actual, corpus, example.configuration, actual.question, example.history), false, label); mutations++;
  };
  const sync = (actual: Captured) => { actual.result!.evidence.questionTrace = structuredClone(actual.questionCalls![0]!.trace); };
  rejects("missing raw parser recording", actual => { delete actual.questionCalls; });
  rejects("missing actual callback evidence trace", actual => { delete actual.result!.evidence.questionTrace; });
  rejects("missing question HTTP", actual => { actual.requests = actual.requests.filter(row => row.operation !== "question"); });
  rejects("duplicate question HTTP", actual => { actual.requests.push(structuredClone(actual.requests.find(row => row.operation === "question")!)); });
  rejects("model action not tied to parser", actual => { actual.steps.find(step => step.type === "tool")!.input = { action: { kind: "clarify", field: "policy_topic" } }; });
  rejects("raw model action changed but SDK tool unchanged", actual => {
    const output = actual.steps.find(step => step.type === "model")!.output as { content: Array<{ type: string; arguments?: unknown }> };
    output.content.find(part => part.type === "toolCall")!.arguments = { action: { kind: "order", orderRef: { kind: "explicit", orderId: "COUPON-9901" } } };
  });
  rejects("SDK step sequence removed", actual => { actual.steps[1]!.index = 99; });
  rejects("SDK successful tool replaced with invented clarification", actual => {
    actual.steps.find(step => step.type === "tool" && step.name === "support_action")!.output = {
      details: { action: { protocol: "v2.2", kind: "clarify", field: "policy_topic", reason: "ambiguous" }, outcome: "clarification" },
      content: [{ type: "text", text: JSON.stringify({ outcome: "clarification", reply: { kind: "notice", text: "虚构澄清" }, evidence: {}, needsAnswer: false }) }] };
    assert.throws(() => assertC1QuestionEvidence(actual, actual.question, base.history, corpus, base.configuration),
      "The independently reproduced SDK-output substitution must fail the question helper itself");
  });
  const editSdk = (actual: Captured, mutate: (payload: { evidence: Record<string, unknown>; reply: unknown }) => void) => {
    const output = actual.steps.find(step => step.type === "tool" && step.name === "support_action")!.output as { content: Array<{ text: string }> };
    const payload = JSON.parse(output.content[0]!.text); mutate(payload); output.content[0]!.text = JSON.stringify(payload);
  };
  rejects("SDK parser resolution omitted", actual => editSdk(actual, payload => { delete payload.evidence.questionResolution; }));
  rejects("SDK host reply replaced", actual => editSdk(actual, payload => { payload.reply = { kind: "notice", text: "虚构回复" }; }));
  rejects("SDK business data replaced", actual => editSdk(actual, payload => { payload.evidence.order = { id: "COUPON-9902", source: "demo-database" }; }));
  rejects("SDK full question trace leaked into model payload", actual => editSdk(actual, payload => { payload.evidence.questionTrace = actual.result!.evidence.questionTrace; }));
  rejects("SDK success marked error", actual => { actual.steps.find(step => step.type === "tool" && step.name === "support_action")!.isError = true; });
  rejects("SDK model output gone", actual => { actual.questionCalls![0]!.response = null; });
  rejects("wire body user replacement with recalculated hash", actual => {
    const row = actual.questionCalls![0]!, body = JSON.parse(row.wire!.body); body.messages[1].content = JSON.stringify({ ...row.input, originalQuery: "自动问退款" });
    row.wire!.body = JSON.stringify(body); row.trace.attempts[0]!.wireHash = contentHash({ endpoint: row.wire!.endpoint, method: "POST", body: row.wire!.body }); sync(actual);
  });
  rejects("edited SDK usage and trace", actual => { const row = actual.questionCalls![0]!; row.response!.usage.input++;
    row.trace.attempts[0]!.inputTokens = row.response!.usage.input; sync(actual); });
  rejects("invented zero cost", actual => { actual.questionCalls![0]!.trace.attempts[0]!.costUsd = 0; sync(actual); });
  rejects("changed native echo", actual => { actual.questionCalls![0]!.wire!.rawResponse = actual.questionCalls![0]!.wire!.rawResponse!.replaceAll("deepseek-flash", "another-model"); });
  rejects("changed request hash", actual => { actual.questionCalls![0]!.trace.requestHash = "a".repeat(64); sync(actual); });
  rejects("unfrozen parser settings", actual => { actual.questionCalls![0]!.trace.settings.temperature = 1 as 0; sync(actual); });
  rejects("extra parser attempt", actual => { actual.questionCalls![0]!.trace.attempts.push(structuredClone(actual.questionCalls![0]!.trace.attempts[0]!)); sync(actual); });
  rejects("native HTTP method changed", actual => { actual.questionCalls![0]!.wire!.method = "GET" as "POST"; });
  rejects("native response not completed", actual => { actual.questionCalls![0]!.wire!.rawResponse = actual.questionCalls![0]!.wire!.rawResponse!.replace("data: [DONE]", ""); });
  rejects("edited parser decision while raw JSON unchanged", actual => { actual.questionCalls![0]!.trace.value!.decision = "needs_clarification"; sync(actual); });
  rejects("relabel valid raw output as failure", actual => { const row = actual.questionCalls![0]!; row.trace.value = null; row.trace.failure = "invalid_response";
    row.trace.attempts[0]!.outcome = "invalid_response"; delete actual.result!.evidence.questionResolution; sync(actual); });
  rejects("old refund extension poisons ranking", actual => {
    const call = actual.calls.find(call => call.knowledge)!, context = call.knowledge!.context; context.retrievalQuery += "\n未核销退款";
    actual.result!.evidence.knowledge[0]!.context.retrievalQuery = context.retrievalQuery;
  });
  rejects("deleted 0FAQ parser proof", actual => { actual.questionCalls = []; actual.requests = actual.requests.filter(row => row.operation !== "question");
    delete actual.result!.evidence.questionTrace; delete actual.result!.evidence.questionResolution; }, captures[3]!);
  rejects("0FAQ native usage invented", actual => { actual.questionCalls![0]!.trace.attempts[0]!.totalTokens = 0; sync(actual); }, captures[3]!);
  rejects("false stale-selector presentation", actual => { actual.result!.referencePresentation = "policy"; }, captures[3]!);
  rejects("discard old topic without empty snapshot", actual => { actual.result!.evidence.policyChoices = structuredClone((actual.hostReference as unknown as { policyChoices: TrustedReferenceChoices }).policyChoices); }, captures[3]!);
  rejects("parsed previous raw question transplanted", actual => { actual.questionCalls![0]!.input.previousTopic!.queries[0]!.originalQuery = "把历史条件改成退款"; }, captures[1]!);
  rejects("old donor scope mismatched", actual => {
    const reference = (actual.hostReference as unknown as { policyChoices: TrustedReferenceChoices }).policyChoices.candidates[0]!.reference;
    assert.ok(reference.kind === "policy"); reference.topic.scope.productId = "different-product";
  }, captures[1]!);
  rejects("scope repair cached parser deleted", actual => { delete actual.result!.evidence.policyScopeRepair!.questionTrace; }, captures[2]!);
  rejects("scope error exposes host-only parser trace", actual => {
    const error = actual.steps.find(step => step.type === "tool" && step.name === "support_action" && step.isError)!;
    const output = error.output as { content: Array<{ text: string }> }, payload = JSON.parse(output.content[0]!.text);
    payload.repair.questionTrace = actual.result!.evidence.policyScopeRepair!.questionTrace; output.content[0]!.text = JSON.stringify(payload);
  }, captures[2]!);
  rejects("scope repair substitutes first read as final", actual => { actual.calls[1]!.id = actual.calls[0]!.id;
    actual.result!.evidence.actualCalls = structuredClone(actual.calls); }, captures[2]!);
  rejects("scope repair carries old hypothesis in new parser input", actual => {
    actual.questionCalls![0]!.input.previousTopic = { requestId: "forged-donor", queries: [{ requestId: "forged-donor", originalQuery: "旧退款假设" }] };
  }, captures[2]!);
  const wrongActorHistory = structuredClone(captures[1]!.history);
  wrongActorHistory[0]!.actual.ingress!.identity.senderId = "another-user";
  assert.equal(knowledgeProofPassed(captures[1]!.actual, corpus, captures[1]!.configuration, captures[1]!.actual.question, wrongActorHistory), false); mutations++;
  const wrongGroupHistory = structuredClone(captures[1]!.history); wrongGroupHistory[0]!.actual.ingress!.groupOpenid = "another-group";
  assert.equal(knowledgeProofPassed(captures[1]!.actual, corpus, captures[1]!.configuration, captures[1]!.actual.question, wrongGroupHistory), false); mutations++;
  const discarded = captures[3]!;
  assert.equal(scoreC1ReferenceEvidence(discarded.actual, discarded.actual.question, discarded.history, { required: true,
    verifyPolicyTopic: (value, question, before) => knowledgeProofPassed(value, corpus, discarded.configuration, question, before) }).passed,
  false, "The old reference contract cannot implicitly accept a v3 discard without the independently verified opt-in callback"); mutations++;
  const continued = captures.find(example => example.actual.caseId === "recovery" && example.actual.turn === 3)!;
  assert.equal(scoreC1ReferenceEvidence(continued.actual, continued.actual.question, continued.history, { required: true,
    verifyQuestionDiscard: (value, question, before) => Boolean(assertC1QuestionEvidence(value, question, before, corpus, continued.configuration)),
    verifyPolicyTopic: (value, question, before) => knowledgeProofPassed(value, corpus, continued.configuration, question, before) }).passed,
  false, "Clearing a pending policy question requires its explicit independently verified completion hook"); mutations++;
  rejects("CNY turned into USD", actual => { actual.questionCalls![0]!.trace.attempts[0]!.costUsd = .00012; sync(actual); }, captures[7]!);
  rejects("unknown usage invented as zero", actual => { actual.questionCalls![0]!.trace.attempts[0]!.costUsd = 0; sync(actual); }, captures[5]!);
  rejects("unreviewed CNY tier replaced with zero", actual => { actual.questionCalls![0]!.trace.attempts[0]!.costCny = 0; sync(actual); }, captures.at(-1)!);
  rejects("rule_only basis not in actual user question", actual => {
    const action = actual.result!.action as { evidenceTarget: { kind: "rule_only"; basis: string } }; action.evidenceTarget.basis = "假设已退款也允许再次退款";
  }, captures[11]!);
  const v2 = { ...base.configuration, evidenceBindingVersion: "order-evidence-binding-v2" as const }; delete v2.questionSettings;
  assert.equal(knowledgeProofPassed(base.actual, corpus, v2, base.actual.question), false, "An unversioned v3 recording cannot pass the old v2 proof"); mutations++;
  console.log(`Question v3 independent evidence checks passed: ${captures.length} native captures, ${mutations} mutations; Pi fake HTTP only, 0 remote/DB/QQ; no semantic-effect claim.`);
  return { captures, mutations };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportQuestionEvidence();
