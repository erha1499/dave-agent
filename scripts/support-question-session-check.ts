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
import { referenceChoiceTtlMs } from "../src/support-reference-selection.ts";
import { requireSupportQuestionResolution, supportQuestionResolutionInputHash, supportQuestionResolutionVersion,
  type SupportQuestionResolution, type SupportQuestionResolutionInput, type SupportQuestionResolver } from "../src/support-question-resolution.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportPolicyScopeRepair, getSupportResult,
  prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import type { SupportCall, SupportPolicyScopeRepair, SupportResult } from "../src/support-controller.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Step = { action: unknown } | { text: string };
type Captured = { requestId: string; question: string; calls: SupportCall[]; steps: ReturnType<ReturnType<typeof captureEvaluationTurn>["finish"]>["steps"];
  result?: SupportResult; repair?: SupportPolicyScopeRepair; receipt?: ReturnType<typeof getSupportHostReceipt>; reply: ReturnType<typeof supportReply>;
  remainingResponses: number; native: Array<{ operation: "agent" | "rerank" | "support"; body: Record<string, unknown> }>; failed: boolean };
const root = new URL("../", import.meta.url);
const finish: Step = { text: "工程固定回复，仅用于检查接线，不证明真实模型理解。" };
const initial: Order = { source: "demo-database", id: "COUPON-9801", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: "shop-demo-1", name: "云味餐厅演示店", merchantName: "演示商家", address: "虚拟市演示路1号" },
  items: [{ id: "question-item", productId: "product-demo-1", productName: "双人午餐团购券", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
  coupons: [{ id: "question-coupon", orderItemId: "question-item", status: "unused", expiresAt: "2026-12-01T00:00:00.000Z",
    redeemedAt: null, redeemedShopId: null }], payments: [{ status: "succeeded", amountCents: 7980, paidAt: null }], refunds: [] };
const completeQuestion = "我重新确认 COUPON-9801 目前套餐的规则：一张券对应几位，核销一次是否整张都算使用？";
const weekendQuestion = "COUPON-9801 这张当前套餐按规则能否在普通周六使用？我避开节假日并自行确认接待。";
const omittedQuestion = "仍是 COUPON-9801，刚才那件事现在呢？";
const hypothesis = "假设商品属于常规午餐套餐";
const resolved = (input: SupportQuestionResolutionInput, decision: SupportQuestionResolution["decision"]): SupportQuestionResolution =>
  requireSupportQuestionResolution({ version: supportQuestionResolutionVersion, inputHash: supportQuestionResolutionInputHash(input), decision,
    currentQuotes: decision === "needs_clarification" ? [] : [input.originalQuery],
    previousRequestId: decision === "previous_resolved" ? input.previousTopic?.requestId ?? null : null }, input);

// Decisions and ranking are hard fixtures. Only the actual native Pi lifecycle,
// authorization, query construction, gate, provenance and host behavior are tested.
async function harness(name: string, contract: "v2" | "v3" = "v3", repairBudget = 2) {
  const documents = JSON.parse(await readFile(new URL("data/acceptance-online.json", root), "utf8")).documents as RetrievalDocument[];
  const snapshot = await loadKnowledgeApplicabilitySnapshot(2), identity = { appId: "QUESTION_SESSION_CHECK", senderId: name }, groupOpenid = `question-${name}`;
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!, judge = runtime.getModel("deepseek", "deepseek-v4-pro")!;
  await runtime.setRuntimeApiKey("deepseek", "synthetic-not-a-credential");
  let order = structuredClone(initial), ordinal = 0, responses: Step[] = [], active: Captured | undefined;
  let acceptedIds = ["KB-PRODUCT-LUNCH"], mode: SupportQuestionResolution["decision"] | "bad-hash" | "extra-output" | "throw" = "current_complete";
  const reads: Array<{ requestId: string; identity: typeof identity; order: Order }> = [], inputs: Array<{ input: SupportQuestionResolutionInput; signal?: AbortSignal }> = [];
  let resolverOverride: ((input: SupportQuestionResolutionInput, options?: { signal?: AbortSignal }) => Promise<SupportQuestionResolution>) | undefined;
  const resolver: SupportQuestionResolver = { async resolve(input, options) {
    inputs.push({ input: structuredClone(input), signal: options?.signal });
    if (resolverOverride) return resolverOverride(input, options);
    if (mode === "throw") throw new Error("Synthetic resolver unavailable");
    const value = resolved(input, ["bad-hash", "extra-output"].includes(mode) ? "current_complete" : mode as SupportQuestionResolution["decision"]);
    return mode === "bad-hash" ? { ...value, inputHash: "0".repeat(64) }
      : mode === "extra-output" ? { ...value, inventedQuestion: "自动补写退款" } as SupportQuestionResolution : value;
  } };
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.ok(active); init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body));
    const operation = body.documents ? "rerank" : body.model === judge.id ? "support" : "agent";
    active.native.push({ operation, body });
    if (operation === "rerank") return new Response(JSON.stringify({ results: body.documents.map((text: string, index: number) => ({ index,
      relevance_score: acceptedIds.some(id => documents.find(doc => doc.id === id)!.title === JSON.parse(text).title) ? .95
        : JSON.parse(text).title === documents.find(doc => doc.id === "KB-REFUND-UNUSED")!.title ? .85 : .1 }))
      .sort((a: { relevance_score: number }, b: { relevance_score: number }) => b.relevance_score - a.relevance_score), usage: { total_tokens: 100 } }));
    let next: Step;
    if (operation === "support") {
      const input = JSON.parse(body.messages.at(-1).content);
      next = { text: JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({ id: doc.id,
        category: acceptedIds.includes(doc.id) ? "direct_fact" : "limitation_only", quote: doc.body,
        reason: "工程固定分类器，不证明真实判别效果" })) }) };
    } else { assert.equal(body.thinking.type, "disabled"); next = responses.shift()!; assert.ok(next, "Unexpected native Agent request or retry"); }
    const tool = "action" in next, delta = "action" in next ? { role: "assistant", tool_calls: [{ index: 0, id: `question-tool-${ordinal}-${active.native.length}`,
      type: "function", function: { name: "support_action", arguments: JSON.stringify({ action: next.action }) } }] } : { role: "assistant", content: next.text };
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `question-${ordinal}-${active!.native.length}`,
      object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const originalStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (selected, context, options) => originalStream(selected, context, { ...options, maxRetries: 0, fetch: fakeFetch });
  const rerank = createBailianClient({ env: { DASHSCOPE_API_KEY: "synthetic-not-a-credential", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
    retries: 0, timeoutMs: 1000, fetch: fakeFetch });
  const support = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 1000,
    runtime: { model: judge, complete: (context, options) => runtime.complete(judge, context, { ...options, fetch: fakeFetch }) } });
  const knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(documents) }, { mode: "m4-support", threshold: .5,
    timeoutMs: 1000, supportProfile: "typed", supportModel: "deepseek-v4-pro", supportPrompt: "v6", queryMode: "separated",
    applicability: "declared-v2", applicabilitySnapshot: snapshot, clients: { rerank, support } });
  const store = { async getOrder(actor: typeof identity, id: string) {
    if (!active || actor.appId !== identity.appId || actor.senderId !== identity.senderId || id !== order.id) throw new OrderAccessError("Synthetic ownership denied");
    reads.push({ requestId: active.requestId, identity: structuredClone(actor), order: structuredClone(order) }); return structuredClone(order);
  }, async searchKnowledge() { throw new Error("The actual knowledge service is required"); } } as unknown as CouponStore;
  const options = { groupOpenid, repairBudget, knowledge, questionContract: contract, ...(contract === "v3" ? { questionResolver: resolver } : {}) };
  const session = await createSupportSession(identity, store, runtime, model, undefined, options);
  session.setAutoRetryEnabled(false);
  const captures: Captured[] = [];
  const policy = (question: string, context: object = { kind: "standalone" }, extras: object = {}) => ({ kind: "policy", question,
    questionContext: context, orderRef: { kind: "explicit", orderId: initial.id }, ...extras });
  const run = async (question: string, steps: Step[] = []) => {
    const requestId = `question-session-${name}-${++ordinal}`, row: Captured = { requestId, question, calls: [], steps: [], reply: undefined,
      remainingResponses: 0, native: [], failed: false }; active = row; responses = [...steps];
    const capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
    prepareSupportPrompt(session, { requestId, messageId: requestId, groupOpenid, onCall: call => row.calls.push(structuredClone(call)) });
    const unsubscribe = session.subscribe(capture.receive);
    try { await session.prompt(question, { expandPromptTemplates: false }); } catch { row.failed = true; } finally { unsubscribe(); }
    const measured = capture.finish(); row.steps = measured.steps; row.failed ||= measured.failed;
    const result = getSupportResult(session); if (result) row.result = structuredClone(result);
    row.repair = getSupportPolicyScopeRepair(session); row.receipt = getSupportHostReceipt(session);
    row.reply = supportReply(session, session.getLastAssistantText() ?? ""); row.remainingResponses = responses.length;
    assert.ok(row.calls.every(call => call.parentSpanId === requestId && ["get_order", "search_faq"].includes(call.name)));
    assert.equal(new Set(row.calls.map(call => call.id)).size, row.calls.length); captures.push(row); return row;
  };
  return { session, runtime, model, store, knowledge, identity, groupOpenid, captures, inputs, reads, documents, run, policy,
    mode(value: typeof mode) { mode = value; }, ranked(ids: string[]) { acceptedIds = [...ids]; }, resolverOverride(value: typeof resolverOverride) { resolverOverride = value; },
    change(productId: string, productName = "双人午餐团购券") { order = { ...structuredClone(order), items: order.items.map(item => ({ ...item, productId, productName })) }; },
    dispose() { cancelSupportTurn(session); session.dispose(); runtime.streamSimple = originalStream; } };
}

function assertSource(row: Captured, id: string, v3 = true) {
  assert.ok(row.result, JSON.stringify({ requestId: row.requestId, calls: row.calls.map(call => call.name),
    errors: row.steps.filter(step => step.type === "tool" && step.isError).map(step => step.output) }));
  assert.equal(row.failed, false); assert.equal(row.remainingResponses, 0); assert.equal(row.result!.outcome, "ready");
  assert.deepEqual(row.calls.map(call => call.name), ["get_order", "search_faq"]);
  assert.deepEqual(row.result!.evidence.actualCalls, row.calls); assert.deepEqual(row.result!.evidence.rules.map(rule => rule.sourceId), [id]);
  assert.ok(row.result!.verifiedPolicyTopic?.sources.some(source => source.sourceId === id && source.version === row.result!.evidence.rules[0]!.version));
  assert.equal(row.result!.evidence.rules[0]!.version, contentHash({ source: row.result!.evidence.rules[0]!.source,
    sourceId: id, title: row.result!.evidence.rules[0]!.title, body: row.result!.evidence.rules[0]!.body, scope: row.result!.evidence.rules[0]!.scope }));
  assert.ok(row.reply && "evidenceIds" in row.reply && row.reply.evidenceIds?.includes(id));
  const evidence = row.calls[1]!.knowledge!;
  assert.equal(evidence.context.originalQuery, row.question); assert.equal(evidence.context.modelQuestion, row.question.trim());
  assert.equal(evidence.context.evidenceBindingVersion, v3 ? "order-evidence-binding-v3" : "order-evidence-binding-v2");
  if (v3) { for (const query of [evidence.context.effectiveQuery, evidence.context.retrievalQuery!, evidence.trace.query])
    assert.doesNotMatch(query, /未核销退款|状态对应条件|订单状态对应的规则条件/u); }
  assert.equal(evidence.trace.status, "accepted"); assert.ok(evidence.trace.supportVerification);
  const inputs = row.native.filter(value => value.operation === "support").map(value => JSON.parse((value.body.messages as Array<{ content: string }>)[1]!.content));
  assert.equal(inputs.length, 1); assert.equal(inputs[0].query, evidence.context.effectiveQuery);
  assert.ok(inputs[0].documents.some((doc: { id: string }) => doc.id === id));
  if (id !== "KB-REFUND-UNUSED") assert.ok(inputs[0].documents.some((doc: { id: string }) => doc.id === "KB-REFUND-UNUSED"),
    "A refund competitor remains visible to the fixed engineering classifier");
}
function assertClarified(row: Captured) {
  assert.equal(row.failed, false); assert.equal(row.result!.outcome, "clarification"); assert.equal(row.result!.discardPolicyTopic, true);
  assert.equal(row.result!.pendingReferenceKind, "policy"); assert.equal(row.result!.referencePresentation, undefined);
  assert.equal(row.calls.filter(call => call.name === "search_faq").length, 0);
  assert.equal(row.native.filter(value => value.operation !== "agent").length, 0);
  assert.ok(row.reply && "text" in row.reply); assert.match(row.reply.text, /完整重述当前对象、条件和要确认的内容/u);
  assert.doesNotMatch(row.reply.text, /选择话题 [a-f0-9-]{36}/u);
}
function machineErrors(row: Captured) {
  return row.steps.filter(step => step.type === "tool" && step.isError).flatMap(step =>
    ((step.output as { content?: Array<{ type: string; text?: string }> })?.content ?? []).flatMap(part => {
      try { return part.type === "text" && part.text ? [JSON.parse(part.text)] : []; } catch { return []; }
    })).filter(value => value.code === "POLICY_SCOPE_CHANGED");
}

export async function checkSupportQuestionSession() {
  const controls: string[] = [];
  for (const [name, question, id, kind] of [
    ["standalone-people", completeQuestion, "KB-PRODUCT-LUNCH", "policy"],
    ["standalone-weekend", weekendQuestion, "KB-SHOP-DEMO-1", "policy"],
    ["standalone-qualification", "COUPON-9801 的本人券已支付未消费，我要了解申请退款的资格与核实步骤。", "KB-REFUND-UNUSED", "refund_eligibility"],
  ] as const) {
    const h = await harness(name);
    try { h.ranked([id]); const row = await h.run(question, [{ action: { ...h.policy(question), kind } }, finish]);
      assertSource(row, id); assert.equal(h.reads.length, 1); assert.equal(h.inputs.length, 1);
      assert.equal(h.inputs[0]!.input.previousTopic, null); assert.equal(h.inputs[0]!.input.originalQuery, question); controls.push(name);
    } finally { h.dispose(); }
  }
  for (const product of ["product-demo-2", "product-demo-3"]) {
    const h = await harness(`scope-complete-${product}`);
    try {
      const old = await h.run(completeQuestion, [{ action: h.policy(completeQuestion) }, finish]); assertSource(old, "KB-PRODUCT-LUNCH");
      h.change(product, product === "product-demo-2" ? "单人晚餐团购券" : "双人午餐团购券"); h.ranked(product === "product-demo-2" ? ["KB-PRODUCT-DINNER"] : ["KB-SHOP-DEMO-1"]);
      const question = product === "product-demo-2" ? "刚才只谈午餐。请重新按 COUPON-9801 当前套餐规则说明一张券供几人以及核销方式。" : weekendQuestion;
      const row = await h.run(question, [{ action: h.policy(question, { kind: "previous", requestId: old.requestId }) },
        { action: h.policy(question, undefined, { evidenceTarget: { kind: "current_order" } }) }, finish]);
      assert.equal(machineErrors(row).length, 1); assert.ok(row.repair); assert.equal(row.repair.budget!.usedAfter, 1);
      assert.deepEqual(machineErrors(row)[0]!.repair.questionResolution, row.result!.evidence.questionResolution);
      assert.deepEqual(row.repair.questionResolution, row.result!.evidence.questionResolution);
      assert.deepEqual(row.calls.map(call => call.name), ["get_order", "get_order", "search_faq"]);
      assert.deepEqual(row.result!.evidence.actualCalls, row.calls);
      assert.equal(h.inputs.length, 2, "One old turn and exactly one cached resolution across the two current attempts");
      assert.equal(h.inputs[1]!.input.previousTopic, null); assert.equal(h.inputs[1]!.input.originalQuery, question);
      const context = row.result!.evidence.knowledge[0]!.context;
      assert.equal(context.policyTopic, null); assert.equal(context.evidenceBindingVersion, "order-evidence-binding-v3");
      assert.doesNotMatch(context.effectiveQuery, /未核销退款|状态对应条件/u); assert.equal(h.reads.length, 3);
      assert.ok(h.reads.slice(1).every(read => read.order.items[0]!.productId === product));
      assert.equal(row.result!.evidence.rules.length, product === "product-demo-2" ? 1 : 0);
      if (product === "product-demo-2") assert.equal(row.result!.evidence.rules[0]!.sourceId, "KB-PRODUCT-DINNER");
      else assert.equal(row.result!.evidence.knowledge[0]!.trace.applicability!.gate!.decisions.find(value => value.id === "KB-SHOP-DEMO-1")!.status, "unknown");
      controls.push(`scope-complete-${product}`);
    } finally { h.dispose(); }
  }
  for (const copied of [false, true]) {
    const h = await harness(copied ? "omission-copied" : "omission-current");
    try {
      const old = await h.run(completeQuestion, [{ action: h.policy(completeQuestion) }, finish]); assertSource(old, "KB-PRODUCT-LUNCH");
      h.change("product-demo-2", "单人晚餐团购券"); h.mode("needs_clarification");
      const current = h.policy(omittedQuestion, { kind: "previous", requestId: old.requestId });
      const row = await h.run(omittedQuestion, [...(copied ? [{ action: { ...current, question: completeQuestion } }] : []), { action: current }, finish]);
      assertClarified(row); assert.equal(row.calls.filter(call => call.name === "get_order").length, 1); assert.equal(machineErrors(row).length, 0);
      assert.equal(h.inputs.length, 2); assert.equal(h.inputs[1]!.input.previousTopic, null);
      assert.equal(row.steps.filter(step => step.type === "tool" && step.isError).length, copied ? 1 : 0);
      controls.push(copied ? "omission-copied-source-repair" : "omission-current-source");
      if (!copied) {
        h.mode("current_complete"); h.ranked(["KB-PRODUCT-DINNER"]);
        const restate = "我完整重述 COUPON-9801 的问题：当前这张晚餐券按规则供几位使用？";
        const restored = await h.run(restate, [{ action: h.policy(restate) }, finish]); assertSource(restored, "KB-PRODUCT-DINNER");
        h.mode("previous_resolved"); const follow = "那核销一次是否整张就用完了？";
        const followed = await h.run(follow, [{ action: h.policy(follow, { kind: "previous", requestId: restored.requestId }, { orderRef: { kind: "focus" } }) }, finish]);
        assertSource(followed, "KB-PRODUCT-DINNER"); assert.equal(h.inputs.at(-1)!.input.previousTopic!.requestId, restored.requestId);
        controls.push("omission-restated-then-valid-previous");
      }
    } finally { h.dispose(); }
  }
  for (const ending of ["budget0", "repair-clarify"] as const) {
    const h = await harness(ending, "v3", ending === "budget0" ? 0 : 1);
    try {
      const old = await h.run(completeQuestion, [{ action: h.policy(completeQuestion) }, finish]); assertSource(old, "KB-PRODUCT-LUNCH");
      h.change("product-demo-2", "单人晚餐团购券");
      const row = await h.run(completeQuestion, [{ action: h.policy(completeQuestion, { kind: "previous", requestId: old.requestId }) },
        ...(ending === "repair-clarify" ? [{ action: { kind: "clarify", field: "policy_topic", reason: "ambiguous" } }] : []), finish]);
      assertClarified(row); assert.equal(row.calls.length, 1); assert.equal(h.inputs.length, 2);
      assert.equal(row.result!.evidence.questionResolution!.input.previousTopic, null);
      assert.equal(machineErrors(row).length, ending === "budget0" ? 0 : 1);
      if (ending === "repair-clarify") assert.deepEqual(row.result!.evidence.questionResolution, row.repair!.questionResolution);
      controls.push(`${ending}-scope-discards-old-topic`);
    } finally { h.dispose(); }
  }
  for (const assume of [false, true]) {
    const h = await harness(assume ? "previous-hypothesis" : "previous-same-scope");
    try {
      h.ranked(["KB-SHOP-DEMO-1"]);
      const question = assume ? `COUPON-9801，${hypothesis}，普通周日规则是什么？这里只解释假设。` : weekendQuestion;
      const target = assume ? { evidenceTarget: { kind: "rule_only", basis: hypothesis } } : {};
      const old = await h.run(question, [{ action: h.policy(question, undefined, target) }, finish]); assertSource(old, "KB-SHOP-DEMO-1");
      h.mode("previous_resolved"); const next = "那普通周六也包括吗？";
      const row = await h.run(next, [{ action: h.policy(next, { kind: "previous", requestId: old.requestId }, { ...target, orderRef: { kind: "focus" } }) }, finish]);
      assertSource(row, "KB-SHOP-DEMO-1"); assert.equal(h.inputs[1]!.input.previousTopic!.requestId, old.requestId);
      assert.deepEqual(h.inputs[1]!.input.previousTopic!.queries, [{ requestId: old.requestId, originalQuery: question }]);
      const context = row.result!.evidence.knowledge[0]!.context;
      assert.equal(context.policyTopic!.requestId, old.requestId);
      if (assume) { assert.equal(context.evidenceTarget!.basisSource, "previous_policy_topic"); assert.equal(context.evidenceTarget!.basisRequestId, old.requestId);
        assert.ok(row.reply && "text" in row.reply && row.reply.text.startsWith("以下仅解释所问条件")); }
      controls.push(assume ? "same-scope-rule-only-basis" : "same-scope-previous-resolved");
    } finally { h.dispose(); }
  }
  const pending = await harness("pending-cleared");
  try {
    const old = await pending.run(completeQuestion, [{ action: pending.policy(completeQuestion) }, finish]); assertSource(old, "KB-PRODUCT-LUNCH");
    const presentation = await pending.run("请先列出之前的话题。", [{ action: { kind: "clarify", field: "policy_topic", reason: "ambiguous" } }, finish]);
    assert.ok(presentation.reply && "text" in presentation.reply); const token = /选择话题 ([a-f0-9-]{36})/u.exec(presentation.reply.text)![1]!;
    const selected = await pending.run(`选择话题 ${token}`); assert.equal(selected.receipt!.outcome, "selected"); assert.equal(selected.native.length, 0);
    const restate = "刚才的内容先放下。COUPON-9801 当前这张午餐券按规则服务几人？";
    const inconsistent = await pending.run(restate, [{ action: pending.policy(restate, { kind: "previous", requestId: old.requestId }) }, finish]);
    assertClarified(inconsistent); assert.equal(pending.inputs.at(-1)!.input.previousTopic!.requestId, old.requestId);
    const success = await pending.run(restate, [{ action: pending.policy(restate) }, finish]); assertSource(success, "KB-PRODUCT-LUNCH");
    pending.mode("previous_resolved"); const next = "那核销一次是整张都用完吗？";
    const follow = await pending.run(next, [{ action: pending.policy(next, { kind: "previous", requestId: success.requestId }, { orderRef: { kind: "focus" } }) }, finish]);
    assertSource(follow, "KB-PRODUCT-LUNCH"); assert.equal(pending.inputs.at(-1)!.input.previousTopic!.requestId, success.requestId);
    const stale = await pending.run(`选择话题 ${token}`); assert.equal(stale.receipt!.outcome, "rejected"); assert.equal(stale.native.length, 0);
    controls.push("same-scope-context-mismatch"); controls.push("successful-restatement-clears-pending"); controls.push("discarded-old-choice-command-rejected");
  } finally { pending.dispose(); }
  for (const mode of ["bad-hash", "extra-output", "throw"] as const) {
    const h = await harness(`resolver-${mode}`);
    try { h.mode(mode); const row = await h.run(completeQuestion, [{ action: h.policy(completeQuestion) }, finish]);
      assertClarified(row); assert.equal(row.calls.length, 1); assert.equal(h.inputs.length, 1); assert.equal(row.result!.evidence.questionResolution, undefined);
      controls.push(`resolver-${mode}-no-fallback`);
    } finally { h.dispose(); }
  }
  const expired = await harness("expires-during-parser"), realNow = Date.now;
  try {
    const old = await expired.run(completeQuestion, [{ action: expired.policy(completeQuestion) }, finish]); assertSource(old, "KB-PRODUCT-LUNCH");
    expired.resolverOverride(async input => { Date.now = () => realNow() + referenceChoiceTtlMs + 1; return resolved(input, "previous_resolved"); });
    const question = "COUPON-9801，那刚才说的整张核销规则是什么意思？";
    const row = await expired.run(question, [{ action: expired.policy(question, { kind: "previous", requestId: old.requestId }) }, finish]);
    assertClarified(row); assert.equal(row.calls.length, 1); controls.push("prior-reference-expires-during-parser");
  } finally { Date.now = realNow; expired.dispose(); }
  const late = await harness("late-parser");
  try {
    let started!: () => void, release!: (value: SupportQuestionResolution) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<SupportQuestionResolution>(resolve => { release = resolve; });
    late.resolverOverride(async () => { started(); return delayed; });
    const first = late.run(completeQuestion, [{ action: late.policy(completeQuestion) }, finish]);
    await entered; const oldInput = late.inputs[0]!.input; cancelSupportTurn(late.session); await late.session.abort();
    const cancelled = await first; assert.equal(cancelled.result, undefined); assert.equal(cancelled.calls.length, 1);
    assert.equal(late.inputs[0]!.signal!.aborted, true); assert.equal(cancelled.native.filter(row => row.operation !== "agent").length, 0);
    late.resolverOverride(undefined); late.ranked(["KB-SHOP-DEMO-1"]);
    const fresh = await late.run(weekendQuestion, [{ action: late.policy(weekendQuestion) }, finish]);
    const published = getSupportResult(late.session)!; assertSource(fresh, "KB-SHOP-DEMO-1");
    release(resolved(oldInput, "current_complete")); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(getSupportResult(late.session), published); assert.equal(getSupportResult(late.session)!.evidence.requestId, fresh.requestId);
    assert.equal(cancelled.calls.length, 1); assert.equal(late.reads.length, 2); controls.push("ignored-abort-late-resolution-suppressed");
  } finally { late.dispose(); }
  const baseline = await harness("v2-baseline", "v2");
  try {
    await assert.rejects(createSupportSession(baseline.identity, baseline.store, baseline.runtime, baseline.model, undefined,
      { groupOpenid: baseline.groupOpenid, questionContract: "v3", knowledge: baseline.knowledge }), /必须提供独立解析端口/u);
    const row = await baseline.run(completeQuestion, [{ action: baseline.policy(completeQuestion) }, finish]); assertSource(row, "KB-PRODUCT-LUNCH", false);
    assert.equal(baseline.inputs.length, 0); assert.equal(row.result!.evidence.questionResolution, undefined);
    assert.match(row.result!.evidence.knowledge[0]!.context.effectiveQuery, /未核销退款/u);
    controls.push("v3-missing-port-rejected"); controls.push("v2-baseline-compatible");
  } finally { baseline.dispose(); }
  console.log(`Support question Session checks: ${controls.length} controls; real Pi/native fake HTTP, isolated owned reads, v3 query/source/repair/parser/cancel/pending boundaries; fixture semantics are not model effectiveness; remote/DB/QQ=0.`);
  return controls;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportQuestionSession();
