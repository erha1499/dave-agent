import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportInputHash, evidenceSupportRequestHash, evidenceSupportTypedV6PromptVersion,
  validateEvidenceSupportVerification, verifyEvidenceSupport, type EvidenceSupportCandidate } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { summarizeEvaluation, type EvalCase, type EvalSpan } from "../src/evaluation.ts";
import { knowledgeProviderSpans } from "../src/knowledge-evaluation.ts";
import type { KnowledgeTrace } from "../src/knowledge-service.ts";
import { estimateModelUsage, modelPricing } from "../src/model-selection.ts";
import type { SupportCall } from "../src/support-controller.ts";
import { cancelSupportTurn, createSupportSession, getSupportResult, prepareSupportPrompt } from "../src/support-session.ts";

const selection = "qwen3.7-plus-2026-05-26", forced = { type: "function", function: { name: "support_action" } };
type Wire = { model: string; messages: unknown[]; tools?: unknown[]; tool_choice?: unknown; enable_thinking?: boolean;
  thinking?: unknown; reasoning_effort?: unknown; response_format?: unknown; temperature?: number; max_tokens?: number; max_completion_tokens?: number };
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type Step = { text: string; usage?: Usage } | { action: unknown; usage?: Usage } | { error: true } | { cancel: () => void };
const usage: Usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, oneCost = 60 / 1_000_000;

// Only HTTP is replaced. Runtime registration, native SSE parsing, Controller,
// verifier integrity and usage capture execute their production implementations.
export async function checkBailianModelWire() {
  const env = { MODEL_PROVIDER: "deepseek", MODEL_API_KEY: "synthetic-wrong-global-key", DEEPSEEK_API_KEY: "synthetic-deepseek-key",
    DASHSCOPE_API_KEY: "synthetic-bailian-key", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/api/v1" };
  const originalFetch = globalThis.fetch, wires: Wire[] = [];
  let plan: Step[] = [], session: Awaited<ReturnType<typeof createSupportSession>> | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${env.DASHSCOPE_API_KEY}`, "Role-specific key is sent, never MODEL_API_KEY");
    init?.signal?.throwIfAborted();
    const body = JSON.parse(String(init?.body)) as Wire;
    assert.equal(body.model, selection); assert.equal(body.enable_thinking, false);
    assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, undefined);
    assert.equal((body.messages[0] as { role: string }).role, "system");
    assert.equal(body.max_completion_tokens, 2048); assert.equal(body.max_tokens, undefined);
    wires.push(body); const next = plan.shift(); assert.ok(next, "Unexpected native retry or model fallback");
    if ("cancel" in next) { next.cancel(); init?.signal?.throwIfAborted(); throw new Error("Synthetic canceled transport"); }
    if ("error" in next) return new Response(JSON.stringify({ error: { message: "synthetic request failure", type: "invalid_request_error" } }), { status: 400 });
    const tool = "action" in next, delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `wire_${wires.length}`,
      type: "function", function: { name: "support_action", arguments: JSON.stringify({ action: next.action }) } }] }
      : { role: "assistant", content: next.text };
    const chunk = (delta: object, finish_reason: string | null, reported?: Usage) => `data: ${JSON.stringify({
      id: `synthetic_${wires.length}`, object: "chat.completion.chunk", created: 1, model: selection,
      choices: [{ index: 0, delta, finish_reason }], ...(reported ? { usage: reported } : {}),
    })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop", next.usage) + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const { modelRuntime, model } = await createConfiguredModelRuntime(env, selection);
    assert.equal(model.provider, "bailian"); assert.ok(Object.values(model.cost).every(Number.isNaN));
    assert.equal(modelPricing(model).currency, "CNY");
    const judge = await createEvidenceSupportClient({ env, modelSelection: selection, profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion });
    assert.equal(judge.settings.maxRetries, 0); assert.equal(judge.settings.pricing.currency, "CNY");
    assert.ok(Object.values(judge.settings.pricing.rates).every(value => typeof value === "number" && Number.isFinite(value)));
    const query = "资料是否说明必须预约？", scope = { shopId: "synthetic-shop", productId: "synthetic-product" };
    const candidates: EvidenceSupportCandidate[] = [{ id: "WIRE-POLICY", title: "合成预约规则", body: "【工程合成规则】使用前须预约。",
      tags: ["预约"], ...scope, status: "active", score: .9, rank: 1 }];
    const answer = JSON.stringify({ decisions: [{ id: candidates[0]!.id, category: "direct_fact", quote: "使用前须预约。", reason: "原文明确预约前提" }] });
    plan = [{ text: answer, usage }];
    const input = { query, scope, candidates, client: judge }, proofInput = { query, scope, candidates, settings: judge.settings };
    const verification = await verifyEvidenceSupport(input), attempt = verification.attempts[0]!;
    assert.equal(plan.length, 0); assert.equal(wires.length, 1);
    assert.equal(wires[0]!.tools, undefined); assert.equal(wires[0]!.tool_choice, undefined);
    assert.deepEqual(wires[0]!.response_format, { type: "json_object" }); assert.equal(wires[0]!.temperature, 0);
    assert.equal(attempt.totalTokens, 15); assert.equal(attempt.costUsd, null); assert.equal(attempt.costCny, oneCost);
    assert.ok(validateEvidenceSupportVerification(verification, proofInput));
    for (const field of ["costCny", "costUsd"] as const) {
      const forged = structuredClone(verification); forged.attempts[0]![field] = field === "costCny" ? oneCost + 1 : 0;
      assert.equal(validateEvidenceSupportVerification(forged, proofInput), false, "Currency/cost must rebuild from actual usage");
      const before: number = wires.length;
      await assert.rejects(verifyEvidenceSupport({ ...input, client: { settings: judge.settings, verify: async () => forged } }),
        error => error instanceof EvidenceSupportError && error.code === "invalid_binding");
      assert.equal(wires.length, before, "Forged cached cost does not cause another model call");
    }
    // Hashes bind a declared price; they cannot make an unreviewed price valid.
    type MutableSettings = { pricing: Record<string, unknown>; endpoint: string };
    const priceMutations: Array<{ name: string; mutate: (settings: MutableSettings) => void }> = [
      { name: "usd-zero", mutate: settings => { settings.pricing = { currency: "USD", estimated: true,
        source: "Pi model catalog", rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; } },
      { name: "region", mutate: settings => { settings.pricing.region = "ap-southeast-1"; } },
      { name: "rates", mutate: settings => { settings.pricing.rates = { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 }; } },
      { name: "version", mutate: settings => { settings.pricing.version = "unreviewed-price-v2"; } },
      { name: "cache-discount", mutate: settings => { settings.pricing.cacheDiscounts = true; } },
      { name: "endpoint", mutate: settings => { settings.endpoint = "https://foreign.invalid/compatible-mode/v1"; } },
    ];
    const beforePriceMutations: number = wires.length;
    for (const mutation of priceMutations) {
      const changed = structuredClone(proofInput), forged = structuredClone(verification);
      mutation.mutate(changed.settings as unknown as MutableSettings);
      if (mutation.name === "usd-zero") { forged.attempts[0]!.costUsd = 0; delete forged.attempts[0]!.costCny; }
      forged.inputHash = evidenceSupportInputHash(changed); forged.requestHash = evidenceSupportRequestHash(changed);
      assert.notEqual(forged.requestHash, verification.requestHash);
      assert.equal(validateEvidenceSupportVerification(forged, changed), false, `Rebound ${mutation.name} remains unreviewed`);
      await assert.rejects(verifyEvidenceSupport({ ...input, client: { settings: changed.settings, verify: async () => forged } }),
        error => error instanceof EvidenceSupportError && error.code === "invalid_binding");
    }
    let injectedCompletions = 0;
    await assert.rejects(createEvidenceSupportClient({ modelSelection: selection, runtime: {
      model: { ...model, baseUrl: "https://foreign.invalid/compatible-mode/v1" },
      complete: async () => { injectedCompletions++; throw new Error("Foreign injected runtime must never execute"); },
    } }), /北京 endpoint 与价格合同不一致/);
    assert.equal(injectedCompletions, 0); assert.equal(wires.length, beforePriceMutations, "Price/endpoint rejection causes no HTTP");
    const trace: KnowledgeTrace = { mode: "m4-support", threshold: .5, query, originalQuery: query, scope, status: "accepted", reason: null,
      rawRanking: [], acceptance: null, sourceHashes: { before: null, after: null }, durationMs: 0,
      calls: [{ operation: "support", requestHash: verification.requestHash, attempts: verification.attempts, status: "ok" }],
      usage: { rerankTokens: 0, supportTokens: 15, estimatedCny: oneCost, estimatedUsd: 0, incompleteCalls: 0 },
      pricing: { estimated: true, rerankCnyPerMillionTokens: null, rerankAsOf: "2026-10-05", supportSource: judge.settings.pricing.source },
      settings: { support: judge.settings, serialization: "json-title-tags-body-v1" } };
    const parent: EvalSpan = { id: "wire-knowledge", parentSpanId: null, actor: "host", trigger: "user", component: "knowledge-service",
      name: "search_faq", observedAt: new Date().toISOString(), durationMs: 0, outcome: "ok", knowledge: { trace, context: {
        originalQuery: query, modelQuestion: null, effectiveQuery: query, purpose: "user_policy", orderSource: "none", scopeSource: "global",
        facts: null, policyTopic: null, objectReference: null } } };
    assert.deepEqual(knowledgeProviderSpans(parent)[0]!.usage?.cost, { currency: "CNY", amount: oneCost, source: "price_estimate" });

    // Native missing and out-of-reviewed-tier usage remains unknown, not free.
    for (const reported of [undefined, { prompt_tokens: 256001, completion_tokens: 5, total_tokens: 256006 }]) {
      plan = [{ text: answer, ...(reported ? { usage: reported } : {}) }];
      const value = await verifyEvidenceSupport(input);
      assert.equal(value.attempts[0]!.costUsd, null); assert.equal(value.attempts[0]!.costCny, null);
      if (!reported) assert.equal(value.attempts[0]!.totalTokens, null);
    }
    const beforeFailure = wires.length; plan = [{ error: true }];
    await assert.rejects(verifyEvidenceSupport(input), error => error instanceof EvidenceSupportError
      && error.attempts.length === 1 && error.attempts[0]!.costUsd === null && error.attempts[0]!.costCny === null);
    assert.equal(wires.length, beforeFailure + 1); assert.equal(plan.length, 0, "Verifier error is not retried");
    const beforeAbort = wires.length;
    await assert.rejects(verifyEvidenceSupport({ ...input, beforeAttempt: () => false }),
      error => error instanceof EvidenceSupportError && error.code === "aborted");
    assert.equal(wires.length, beforeAbort);

    const fixture = JSON.parse(await readFile(new URL("../data/c1-category-session-development.json", import.meta.url), "utf8")) as {
      cases: Array<{ orders: Array<{ order: Awaited<ReturnType<CouponStore["getOrder"]>> }> }> };
    const order = fixture.cases[0]!.orders[0]!.order, identity = { appId: "BAILIAN_WIRE", senderId: "OWNER" }, groupOpenid = "BAILIAN_WIRE_GROUP";
    let reads = 0;
    const calls: SupportCall[] = [], store = { getOrder: async (who: typeof identity, id: string) => {
      assert.deepEqual(who, identity); assert.equal(id, order.id); reads++; return structuredClone(order);
    }, searchKnowledge: async () => { throw new Error("Order fact action must not invent a knowledge call"); } } as unknown as CouponStore;
    session = await createSupportSession(identity, store, modelRuntime, model, undefined, { groupOpenid });
    const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), nativeCosts: number[] = [], start = wires.length;
    const unsubscribe = session.subscribe(event => {
      capture.receive(event);
      if (event.type === "message_end" && event.message.role === "assistant") nativeCosts.push(event.message.usage.cost.total);
    });
    plan = [{ action: { kind: "order", orderRef: { kind: "explicit", orderId: order.id } }, usage }, { text: "固定工程回执，不代表模型质量。", usage }];
    prepareSupportPrompt(session, { requestId: "bailian-wire-order", messageId: "bailian-wire-order", groupOpenid, onCall: call => calls.push(call) });
    try { await session.prompt(`查询订单 ${order.id}`, { expandPromptTemplates: false }); } finally { unsubscribe(); }
    const measured = capture.finish(), result = getSupportResult(session);
    assert.equal(plan.length, 0); assert.equal(reads, 1); assert.deepEqual(calls.map(call => call.name), ["get_order"]);
    assert.equal(result?.action.kind, "order"); assert.equal(result?.evidence.actualCalls.length, 1);
    assert.deepEqual(wires.slice(start).map(wire => wire.tool_choice), [forced, "auto"]);
    const modelSteps = measured.steps.filter(step => step.type === "model");
    assert.equal(nativeCosts.length, 2); assert.ok(nativeCosts.every(Number.isNaN), "Pi preserves unknown USD before project CNY accounting");
    assert.equal(modelSteps.length, 2); assert.ok(modelSteps.every(step => step.usage?.estimatedCostUsd === null && step.usage.estimatedCostCny === oneCost));
    const cases: EvalCase[] = [{ id: "wire", name: "Native Qwen engineering", category: "engineering", status: "passed", turns: [{ index: 1,
      question: "合成订单查询", reply: "工程回执", status: "passed", startedAt: new Date().toISOString(), durationMs: measured.durationMs,
      firstTextMs: measured.firstTextMs, evidenceIds: [], checks: [], steps: measured.steps }] }];
    const metrics = summarizeEvaluation(cases);
    assert.equal(metrics.estimatedCostUsd, null); assert.equal(metrics.estimatedCostCny, oneCost * 2); assert.equal(metrics.totalTokens, 30);
    for (const missing of ["one", "all"] as const) {
      const incomplete = structuredClone(cases), requests = incomplete[0]!.turns[0]!.steps.filter(step => step.type === "model");
      requests.forEach((step, index) => { if (missing === "all" || index === 0) step.usage = null; });
      const unknown = summarizeEvaluation(incomplete);
      assert.equal(unknown.modelRequests, 2); assert.equal(unknown.usageRequests, missing === "all" ? 0 : 1);
      assert.equal(unknown.estimatedCostCny, null, "Every planned model request contributes to the CNY fee denominator");
      assert.equal(unknown.estimatedCostUsd, null);
      if (missing === "all") assert.equal(unknown.totalTokens, null);
    }
    assert.deepEqual(estimateModelUsage(model, null), { estimatedCostUsd: null, estimatedCostCny: null });
    const beforeCancel = wires.length, readsBeforeCancel = reads;
    plan = [{ cancel: () => { cancelSupportTurn(session!); void session!.abort(); } }];
    prepareSupportPrompt(session, { requestId: "bailian-wire-cancel", messageId: "bailian-wire-cancel", groupOpenid });
    await session.prompt(`查询订单 ${order.id}`, { expandPromptTemplates: false }).catch(() => {});
    assert.equal(wires.length, beforeCancel + 1); assert.equal(reads, readsBeforeCancel); assert.equal(getSupportResult(session), undefined);
    assert.equal(plan.length, 0, "Abort must not produce a follow-up Agent request");
    return { remoteRequests: 0, fakeRequests: wires.length, databaseRequests: 0, qqRequests: 0 };
  } finally { session?.dispose(); globalThis.fetch = originalFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("Bailian native model wire checks passed", await checkBailianModelWire());
}
