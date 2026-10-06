import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createModelRuntime } from "../src/agent.ts";
import { contentHash, createBailianClient } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, evidenceSupportTypedV6PromptVersion } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { loadKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import type { SupportPolicyScopeRepair } from "../src/support-controller.ts";
import { cancelSupportTurn, createSupportSession, getSupportPolicyScopeRepair, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import type { C1ValidationActual } from "./c1-session-validation-check.ts";

const root = new URL("../", import.meta.url), forced = { type: "function", function: { name: "support_action" } };
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Step = { action: unknown } | { actions: unknown[] } | { text: string };
type Payload = { model: string; thinking?: { type: string }; tool_choice?: unknown; messages: Array<{ content: string }>; documents?: string[] };
type Captured = C1ValidationActual & { question: string; repair?: SupportPolicyScopeRepair; payloads: Payload[]; remainingResponses: number };
const finish: Step = { text: "固定工程回答，不能证明模型语义正确。" };

function lastHost(messages: readonly unknown[]): C1ValidationActual["hostReference"] {
  return messages.flatMap(message => {
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; }
  }).at(-1) ?? {};
}
function scopeError(actual: Captured) {
  const errors = actual.steps.filter(step => step.type === "tool" && step.name === "support_action" && step.isError);
  const machine = errors.flatMap(step => ((step.output as { content?: Array<{ type: string; text?: string }> })?.content ?? []).flatMap(part => {
    try { return part.type === "text" && part.text ? [JSON.parse(part.text)] : []; } catch { return []; }
  })).filter(value => value.code === "POLICY_SCOPE_CHANGED");
  assert.equal(machine.length, 1, "One typed scope error, not a guessed Chinese message");
  assert.deepEqual(machine[0]!.repair, actual.repair);
  const toolCallId = actual.repair?.budget?.toolCallId;
  const raw = actual.steps.filter(step => step.type === "model").flatMap(step =>
    (step.output as { content?: Array<{ type: string; id?: string; arguments?: { action?: unknown } }> })?.content ?? []);
  const original = raw.filter(part => part.type === "toolCall" && (toolCallId ? part.id === toolCallId
    : contentHash({ ...part.arguments?.action as object, protocol: "v2.2" }) === contentHash(actual.repair!.action)));
  assert.equal(original.length, 1); assert.deepEqual({ ...original[0]!.arguments!.action as object, protocol: "v2.2" }, actual.repair!.action);
  return machine[0]!;
}

async function harness(name: string, repairBudget = 1, initialHypothesis = false) {
  const fixture = JSON.parse(await readFile(new URL("data/c1-category-session-development.json", root), "utf8")) as {
    corpus: RetrievalDocument[]; cases: Array<{ orders: Array<{ order: Order }> }> };
  const documents = fixture.corpus, snapshot = await loadKnowledgeApplicabilitySnapshot(2);
  const base = fixture.cases[3]!.orders[0]!.order, orderId = base.id;
  const identity = { appId: "POLICY_SCOPE_SESSION", senderId: name }, groupOpenid = `POLICY_SCOPE_${name}`;
  let order = structuredClone(base), denied = false, sourceUnavailable = false, responses: Step[] = [], row: Captured | undefined, requestCount = 0;
  let onRead: ((read: number) => void) | undefined, onAgent: ((index: number) => void) | undefined;
  let reads = 0, supports = 0, reranks = 0, ordinal = 0;
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!, judge = runtime.getModel("deepseek", "deepseek-v4-pro")!;
  await runtime.setRuntimeApiKey("deepseek", "synthetic-not-a-credential");
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.ok(row); init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body)) as Payload;
    const operation = body.documents ? "rerank" : body.model === judge.id ? "support" : "agent";
    row.requests.push({ operation, caseId: name, turn: row.turn, startedAt: new Date().toISOString(), httpStatus: 200, error: null }); requestCount++;
    if (operation === "rerank") {
      reranks++;
      return new Response(JSON.stringify({ results: body.documents!.map((text, index) => ({ index,
        relevance_score: JSON.parse(text).title === documents.find(doc => doc.id === "KB-SHOP-DEMO-1")!.title ? .95 : .1 }))
        .sort((a, b) => b.relevance_score - a.relevance_score), usage: { total_tokens: 100 } }));
    }
    let next: Step;
    if (operation === "support") {
      supports++; const input = JSON.parse(body.messages.at(-1)!.content);
      next = { text: JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({
        id: doc.id, category: "direct_fact", quote: doc.body, reason: "固定工程接受器，仅验证执行与证据绑定" })) }) };
    } else {
      row.payloads.push(body); onAgent?.(row.payloads.length); init?.signal?.throwIfAborted();
      next = responses.shift()!; assert.ok(next, "Unexpected native Agent HTTP, including any unbounded repair");
      assert.equal(body.thinking?.type, "disabled");
    }
    const tool = "action" in next || "actions" in next, delta = "text" in next ? { role: "assistant", content: next.text }
      : { role: "assistant", tool_calls: ("actions" in next ? next.actions : [next.action]).map((action, index) => ({ index,
        id: `scope-call-${requestCount}-${index}`, type: "function", function: { name: "support_action", arguments: JSON.stringify({ action }) } })) };
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `scope-${requestCount}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const originalStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (selected, context, options) => originalStream(selected, context, { ...options, maxRetries: 0, fetch: fakeFetch });
  const rerank = createBailianClient({ env: { DASHSCOPE_API_KEY: "synthetic-not-a-credential", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" }, retries: 0, timeoutMs: 1000, fetch: fakeFetch });
  const support = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 1000,
    runtime: { model: judge, complete: (context, options) => runtime.complete(judge, context, { ...options, fetch: fakeFetch }) } });
  const knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => { if (sourceUnavailable) throw new Error("synthetic source unavailable"); return structuredClone(documents); } }, { mode: "m4-support", threshold: .5,
    timeoutMs: 1000, supportProfile: "typed", supportModel: "deepseek-v4-pro", supportPrompt: "v6", queryMode: "separated",
    applicability: "declared-v2", applicabilitySnapshot: snapshot, clients: { rerank, support } });
  const store = { async getOrder(actor: typeof identity, id: string) {
    assert.deepEqual(actor, identity); assert.equal(id, orderId); reads++; onRead?.(reads);
    if (denied) throw new OrderAccessError("synthetic ownership revoked"); return structuredClone(order);
  }, async searchKnowledge() { throw new Error("The real knowledge service is required"); } } as unknown as CouponStore;
  const session = await createSupportSession(identity, store, runtime, model, undefined, { groupOpenid, repairBudget, knowledge });
  const history: Captured[] = [];
  const policy = (question: string, context: object = { kind: "standalone" }, extras: object = {}) => ({ kind: "policy", question,
    questionContext: context, orderRef: { kind: "explicit", orderId }, ...extras });
  const run = async (question: string, steps: Step[], route = groupOpenid) => {
    const requestId = `scope-session-${name}-${++ordinal}`;
    row = { caseId: name, turn: ordinal, question, requestId, execution: "not_run", durationMs: null, calls: [], steps: [], requests: [], payloads: [], remainingResponses: 0,
      ingress: { identity, groupOpenid: route, messageId: requestId, requestId, observedAt: new Date().toISOString() } };
    const actual = row, startMessages = session.messages.length, capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
    responses = [...steps]; prepareSupportPrompt(session, { requestId, messageId: requestId, groupOpenid: route, onCall: call => actual.calls.push(structuredClone(call)) });
    const unsubscribe = session.subscribe(capture.receive); let failed = false;
    try { await session.prompt(question, { expandPromptTemplates: false }); } catch { failed = true; } finally { unsubscribe(); }
    const measured = capture.finish(); actual.steps = measured.steps; actual.durationMs = measured.durationMs; actual.execution = failed || measured.failed ? "failed" : "completed";
    const result = getSupportResult(session); if (result) actual.result = structuredClone(result);
    const repair = getSupportPolicyScopeRepair(session); if (repair) actual.repair = structuredClone(repair);
    actual.hostReference = lastHost(session.messages.slice(startMessages)); actual.reply = supportReply(session, session.getLastAssistantText() ?? "");
    actual.remainingResponses = responses.length; history.push(actual);
    assert.ok(actual.calls.every(call => call.parentSpanId === requestId)); assert.equal(new Set(actual.calls.map(call => call.id)).size, actual.calls.length);
    assert.ok(actual.calls.every(call => ["get_order", "search_faq"].includes(call.name)), "No write or task service is called");
    return actual;
  };
  const oldQuestion = initialHypothesis ? `订单 ${orderId}，假设这份商品属于常规午餐套餐，请只解释普通周日的一般规则，旧假设不证明当前券可用。`
    : `订单 ${orderId} 当前这张券普通周日能使用吗？旧问只涉及普通周末，不是节假日。`;
  const old = await run(oldQuestion, [{ action: policy(oldQuestion, undefined, initialHypothesis ? { evidenceTarget: { kind: "rule_only", basis: "假设这份商品属于常规午餐套餐" } } : {}) }, finish]);
  assert.ok(old.result?.verifiedPolicyTopic && old.result.evidence.rules.some(rule => rule.sourceId === "KB-SHOP-DEMO-1"), "The old topic originates in real successful tool evidence");
  const topic = old.result.verifiedPolicyTopic, question = `请重新查询订单 ${orderId} 当前这张券的普通周六使用规则，不考虑节假日或实时接待。`;
  const previous = policy(question, { kind: "previous", requestId: topic.requestId }), standalone = policy(question, undefined, { evidenceTarget: { kind: "current_order" } });
  return { session, history, old, topic, question, previous, standalone, policy, run, orderId, documents,
    configuration: { applicability: "declared-v2" as const, applicabilitySnapshot: snapshot, evidenceBindingVersion: "order-evidence-binding-v2" as const,
      referenceEvidenceRequired: true, queryMode: "separated" as const, supportPrompt: "v6" as const, supportSettings: support.settings,
      policyScopeRepair: { version: "policy-scope-repair-v1" as const, maxRepairs: 1 as const, repairBudget } },
    get counts() { return { reads, supports, reranks }; },
    change(productId: string) { order = { ...structuredClone(order), asOf: new Date().toISOString(), items: order.items.map(item => ({ ...item, productId })) }; },
    revoke() { denied = true; }, failSource() { sourceUnavailable = true; }, onRead(fn: (read: number) => void) { onRead = fn; },
    onAgent(fn: (index: number) => void) { onAgent = fn; }, dispose() { session.dispose(); } };
}

function assertRepaired(actual: Captured, old: Captured, productId: string, known = false, protocolFailures = 0) {
  assert.ok(actual.result && actual.repair); scopeError(actual);
  assert.equal(actual.repair.version, "policy-scope-repair-v1"); assert.equal(actual.repair.reason, "scope_changed");
  assert.deepEqual(actual.result.evidence.policyScopeRepair, actual.repair); assert.deepEqual(actual.repair.topic, old.result!.verifiedPolicyTopic);
  assert.equal(actual.repair.budget!.usedAfter, actual.repair.budget!.usedBefore + 1);
  assert.deepEqual(actual.calls.map(call => call.name), ["get_order", "get_order", "search_faq"]);
  assert.deepEqual(actual.result.evidence.actualCalls, actual.calls); assert.deepEqual(actual.repair.call, actual.calls[0]);
  assert.deepEqual(actual.payloads.map(body => body.tool_choice), [...Array(protocolFailures + 2).fill(forced), "auto"]);
  assert.equal(actual.result.evidence.order!.items[0]!.productId, productId);
  const knowledge = actual.result.evidence.knowledge[0]!;
  const oldNormalized = old.question.replaceAll(`订单 ${old.result!.evidence.order!.id}`, "该订单");
  assert.equal(knowledge.context.policyTopic, null); assert.ok(!knowledge.context.effectiveQuery.includes(oldNormalized));
  assert.ok(!knowledge.context.effectiveQuery.includes("假设这份商品属于常规午餐套餐"));
  assert.equal(knowledge.context.applicability!.scope.productId, productId);
  assert.equal(knowledge.trace.applicability!.gate!.decisions.find(value => value.id === "KB-SHOP-DEMO-1")!.status, known ? "matched" : "unknown");
  assert.equal(knowledge.trace.status, known ? "accepted" : "rejected");
  assert.equal(actual.requests.filter(request => request.operation === "support").length, known ? 1 : 0);
}

export async function checkSupportPolicyScopeSession() {
  const captures: Array<{ history: Captured[]; actual: Captured; configuration: Awaited<ReturnType<typeof harness>>["configuration"]; corpus: RetrievalDocument[]; originalQuery: string }> = [];
  for (const hypothesis of [false, true]) {
    const h = await harness(hypothesis ? "old-hypothesis" : "unknown-current", 1, hypothesis);
    try {
      h.change("product-demo-3"); const actual = await h.run(h.question, [{ action: h.previous }, { action: h.standalone }, finish]);
      assertRepaired(actual, h.old, "product-demo-3"); assert.equal(h.counts.reads, 3, "One old read, then exactly two current reads");
      captures.push({ history: [h.old], actual, configuration: h.configuration, corpus: h.documents, originalQuery: h.question });
      const hello = await h.run("你好", [{ action: { kind: "non_business", reason: "greeting" } }, finish]);
      assert.equal(hello.repair, undefined, "A new ingress clears the failed-action audit");
    } finally { h.dispose(); }
  }
  for (const mode of ["same-scope", "known-latest", "fresh-changes-again", "revoked", "cancel"] as const) {
    const h = await harness(mode);
    try {
      if (mode !== "same-scope") h.change(mode === "known-latest" ? "product-demo-2" : "product-demo-3");
      if (mode === "fresh-changes-again") h.onRead(read => { if (read === 3) h.change("product-demo-2"); });
      if (mode === "revoked") h.onRead(read => { if (read === 3) h.revoke(); });
      if (mode === "cancel") h.onAgent(index => { if (index === 2) { cancelSupportTurn(h.session); void h.session.abort(); } });
      const actual = await h.run(h.question, [{ action: h.previous }, ...(mode === "same-scope" ? [] : [{ action: h.standalone }]), finish]);
      if (mode === "same-scope") { assert.equal(actual.repair, undefined); assert.deepEqual(actual.calls.map(call => call.name), ["get_order", "search_faq"]);
        assert.deepEqual(actual.result!.evidence.knowledge[0]!.context.policyTopic, h.topic); }
      else if (mode === "revoked") { scopeError(actual); assert.equal(actual.result, undefined); assert.equal(actual.calls.length, 2);
        assert.equal(actual.calls[1]!.errorKind, "business_denial"); assert.equal(actual.requests.filter(request => request.operation !== "agent").length, 0); }
      else if (mode === "cancel") { assert.equal(actual.result, undefined); assert.equal(actual.calls.length, 1); assert.equal(h.counts.reads, 2); }
      else { assertRepaired(actual, h.old, "product-demo-2", true);
        captures.push({ history: [h.old], actual, configuration: h.configuration, corpus: h.documents, originalQuery: h.question }); }
    } finally { h.dispose(); }
  }
  for (const mode of ["budget-zero", "schema-exhausted", "repeated-previous", "write", "switch-order", "rule-only", "clarify"] as const) {
    const h = await harness(mode, mode === "budget-zero" ? 0 : 1);
    try {
      h.change("product-demo-3");
      const next = mode === "repeated-previous" ? h.previous : mode === "write" ? { kind: "refund_prepare", orderRef: { kind: "explicit", orderId: h.orderId } }
        : mode === "switch-order" ? { ...h.standalone, orderRef: { kind: "explicit", orderId: "COUPON-9201" } }
        : mode === "rule-only" ? { ...h.standalone, evidenceTarget: { kind: "rule_only", basis: "普通周六使用规则" } }
        : mode === "clarify" ? { kind: "clarify", field: "policy_topic", reason: "ambiguous" } : h.standalone;
      const steps: Step[] = [...(mode === "schema-exhausted" ? [{ action: { kind: "policy" } }] : []), { action: h.previous }, { action: next }, finish];
      const actual = await h.run(h.question, steps);
      if (mode === "budget-zero") { assert.equal(actual.repair, undefined); assert.equal(actual.result!.outcome, "clarification");
        assert.deepEqual(actual.payloads.map(body => body.tool_choice), [forced, "auto", "auto"]); }
      else if (mode === "schema-exhausted") { assert.ok(actual.repair); assert.equal(actual.repair.budget, undefined); }
      else scopeError(actual);
      assert.equal(actual.calls.length, 1, "A blocked replacement must not re-read, query knowledge or write"); assert.equal(h.counts.reads, 2);
      if (mode === "schema-exhausted") { assert.equal(actual.result, undefined); assert.ok(actual.remainingResponses >= 2,
        JSON.stringify({ choices: actual.payloads.map(body => body.tool_choice), remaining: actual.remainingResponses, steps: actual.steps.map(step => ({ type: step.type, name: step.name, isError: step.isError })) })); }
      else if (mode === "budget-zero") assert.equal(actual.result!.outcome, "clarification");
      else if (mode === "clarify") { assert.equal(actual.result!.action.kind, "clarify"); assert.equal(actual.result!.outcome, "clarification");
        assert.equal(actual.result!.referencePresentation, undefined); assert.equal(actual.result!.pendingReferenceKind, "policy");
        assert.ok(!JSON.stringify(actual.reply).includes("选择话题"));
        captures.push({ history: [h.old], actual, configuration: h.configuration, corpus: h.documents, originalQuery: h.question }); }
      else assert.equal(actual.result, undefined);
    } finally { h.dispose(); }
  }
  for (const mode of ["budget-two-success", "budget-two-repeat", "same-message-guesses"] as const) {
    const h = await harness(mode, 2);
    try {
      h.change("product-demo-3");
      const steps: Step[] = mode === "same-message-guesses" ? [{ actions: [h.previous, h.standalone] }, finish]
        : [...(mode === "budget-two-success" ? [{ action: { kind: "policy" } }] : []), { action: h.previous },
          { action: mode === "budget-two-repeat" ? h.previous : h.standalone }, finish];
      const actual = await h.run(h.question, steps);
      if (mode === "budget-two-success") {
        // The preceding protocol error and scope error consume the same budget.
        assertRepaired(actual, h.old, "product-demo-3", false, 1);
        assert.equal(actual.repair!.budget!.usedBefore, 1); assert.equal(actual.repair!.budget!.usedAfter, 2);
        captures.push({ history: [h.old], actual, configuration: h.configuration, corpus: h.documents, originalQuery: h.question });
      } else { assert.equal(actual.result, undefined); assert.equal(actual.calls.length, 1); assert.equal(h.counts.reads, 2);
        if (mode === "same-message-guesses") { assert.ok(actual.repair); assert.equal(actual.repair.budget, undefined); assert.equal(actual.payloads.length, 1); }
        else { scopeError(actual); assert.equal(actual.repair!.budget!.usedAfter, 1); } }
    } finally { h.dispose(); }
  }
  // Seeing the first failure does not authorize a later batch of guessed
  // replacements. Neither candidate in that second response may re-read.
  for (const mode of ["second-batch-clarify", "second-batch-duplicate"] as const) {
    const h = await harness(mode, 2);
    try {
      h.change("product-demo-3");
      const other = mode === "second-batch-clarify" ? { kind: "clarify", field: "policy_topic", reason: "ambiguous" } : h.standalone;
      const actual = await h.run(h.question, [{ action: h.previous }, { actions: [h.standalone, other] }, finish]);
      scopeError(actual); assert.equal(actual.result, undefined);
      assert.deepEqual(actual.calls.map(call => call.name), ["get_order"]); assert.equal(h.counts.reads, 2);
      assert.equal(actual.requests.filter(request => request.operation !== "agent").length, 0);
      assert.deepEqual(actual.payloads.map(body => body.tool_choice), [forced, forced]);
      assert.equal(actual.remainingResponses, 1, "Abort before the next native Agent HTTP");
    } finally { h.dispose(); }
  }
  for (const mode of ["source-unavailable", "first-read-denied", "expired-topic", "wrong-group"] as const) {
    const h = await harness(mode);
    try {
      h.change("product-demo-3");
      if (mode === "source-unavailable") h.failSource();
      if (mode === "first-read-denied") h.revoke();
      const originalNow = Date.now;
      if (mode === "expired-topic") Date.now = () => originalNow() + 16 * 60_000;
      let actual: Captured;
      try { actual = await h.run(h.question, [{ action: h.previous }, { action: h.standalone }, finish], mode === "wrong-group" ? "FOREIGN_GROUP" : undefined); }
      finally { Date.now = originalNow; }
      if (mode === "source-unavailable") { scopeError(actual); assert.equal(actual.result!.evidence.knowledge[0]!.trace.status, "unavailable");
        assert.equal(actual.result!.evidence.rules.length, 0); assert.equal(actual.calls.length, 3); }
      else if (mode === "expired-topic") { assert.equal(actual.repair, undefined); assert.equal(actual.calls.length, 0);
        assert.equal(actual.requests.filter(request => request.operation !== "agent").length, 0); }
      else { assert.equal(actual.repair, undefined); assert.equal(actual.requests.filter(request => request.operation !== "agent").length, 0);
        assert.ok(actual.calls.length <= 1); if (mode === "wrong-group") assert.equal(actual.requests.length, 0); }
    } finally { h.dispose(); }
  }
  console.log("[support-session] policy scope repair: real Pi/native DeepSeek fake HTTP; real old-topic evidence and v2 fresh-SKU gate; one shared-budget repair, two owned reads, raw failed/final actions, no old query/basis, budget/cache/write/switch/use/cancel/revocation PASS; 0 remote/DB/QQ.");
  return captures;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportPolicyScopeSession();
