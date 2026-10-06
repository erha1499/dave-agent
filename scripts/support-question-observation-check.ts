import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { merchantSourceKey } from "../src/after-sales.ts";
import { readCliQuestionOptions } from "../src/cli.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { summarizeEvaluation, type EvalSpan } from "../src/evaluation.ts";
import { questionProviderSpans } from "../src/knowledge-evaluation.ts";
import { analyzeSupportSpans } from "../src/support-evaluation.ts";
import { SupportController } from "../src/support-controller.ts";
import type { SupportQuestionObservation, SupportQuestionTrace } from "../src/support-question-resolution.ts";
import { captureSupportQuestionClientForTest } from "./support-question-client-check.ts";

// Native fake HTTP establishes the happy-path ledger. Mutated traces below test
// only span projection; error/cancellation execution is covered by the client
// and native Session checks. None of these fixed decisions measure semantics.
export async function checkSupportQuestionObservation() {
  let controls = 0;
  const input = { requestId: "question-observation", originalQuery: "COUPON-9911 的午餐券一张对应多少人？", previousTopic: null };
  const native = await captureSupportQuestionClientForTest(input);
  const observation = (trace: SupportQuestionTrace, suffix: string): SupportQuestionObservation => ({
    requestId: `${input.requestId}-${suffix}`, observedAt: new Date().toISOString(), input, trace,
  });
  const project = (trace: SupportQuestionTrace, suffix: string) => {
    const event = observation(trace, suffix), children = questionProviderSpans(event);
    const parent: EvalSpan = { id: event.requestId, parentSpanId: null, actor: "host", trigger: "user", component: "support",
      name: "turn", observedAt: event.observedAt, durationMs: null, outcome: "ok" };
    const analysis = analyzeSupportSpans([parent, ...children]); assert.deepEqual(analysis.issues, []);
    assert.ok(children.every(span => span.parentSpanId === event.requestId && span.actor === "host"));
    assert.ok(!JSON.stringify(children).includes(input.originalQuery), "Provider spans store source hashes, not user text");
    return { children, analysis };
  };
  const good = project(native.trace, "success");
  assert.equal(good.children[0]!.outcome, "ok"); assert.equal(good.analysis.providers[0]!.requests, 1);
  assert.equal(good.analysis.providers[0]!.usageReported, 1); assert.equal(good.analysis.providers[0]!.knownTokens, 15);
  assert.deepEqual(good.analysis.providers[0]!.costs, [{ currency: "USD", source: "sdk_estimate", reportedRequests: 1, knownAmount: .000009 }]); controls++;

  const invalid = structuredClone(native.trace); invalid.failure = "invalid_response"; invalid.value = null;
  invalid.attempts[0]!.outcome = "invalid_response";
  const billedFailure = project(invalid, "invalid");
  assert.equal(billedFailure.children[0]!.outcome, "error"); assert.deepEqual(billedFailure.analysis.providers, good.analysis.providers); controls++;
  const unknown = structuredClone(invalid);
  Object.assign(unknown.attempts[0]!, { inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null });
  const missing = project(unknown, "unknown");
  assert.equal(missing.analysis.providers[0]!.requests, 1); assert.equal(missing.analysis.providers[0]!.usageReported, 0);
  assert.equal(missing.analysis.providers[0]!.knownTokens, null); assert.deepEqual(missing.analysis.providers[0]!.costs, []); controls++;
  const noDispatch = structuredClone(unknown); noDispatch.attempts[0]!.httpRequests = 0; noDispatch.attempts[0]!.wireHash = null;
  assert.deepEqual(project(noDispatch, "not-sent").analysis.providers, []); controls++;
  const preflight = structuredClone(noDispatch); preflight.attempts = []; preflight.failure = "aborted";
  const pre = project(preflight, "preflight"); assert.deepEqual(pre.analysis.providers, []); assert.equal(pre.children[0]!.outcome, "error"); controls++;

  const cny = await captureSupportQuestionClientForTest(input, "current_complete", "qwen3.7-plus-2026-05-26");
  const priced = project(cny.trace, "cny");
  assert.deepEqual(priced.analysis.providers[0]!.costs, [{ currency: "CNY", source: "price_estimate", reportedRequests: 1, knownAmount: .00006 }]); controls++;
  const oldSummary = summarizeEvaluation([{ id: "projection", name: "projection", category: "engineering", status: "passed", turns: [{
    index: 1, question: input.originalQuery, reply: "固定工程回复", status: "passed", startedAt: new Date().toISOString(), durationMs: 1,
    firstTextMs: null, evidenceIds: [], checks: [], steps: [], spans: good.children,
  }] }]);
  assert.equal(oldSummary.modelRequests, 0); assert.equal(oldSummary.estimatedCostUsd, null, "Legacy Agent-step summary is not total provider cost"); controls++;

  // A broken recorder cannot cause a second parser request or business retry.
  const identity = { appId: "QUESTION_OBSERVATION", senderId: "SYNTHETIC_OWNER" }, groupOpenid = "QUESTION_OBSERVATION_GROUP";
  const order: Awaited<ReturnType<CouponStore["getOrder"]>> = { source: "demo-database", id: "COUPON-9911", status: "paid",
    asOf: "2026-10-06T00:00:00.000Z", amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "observation-shop", name: "合成门店", merchantName: "合成商家", address: "合成地址" },
    items: [{ id: "observation-item", productId: "observation-lunch", productName: "合成午餐券", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [{ id: "observation-coupon", orderItemId: "observation-item", status: "unused", expiresAt: "2026-12-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 7980, paidAt: null }], refunds: [] };
  let parserCalls = 0, faqCalls = 0, observations = 0;
  const controller = new SupportController({ store: { async getOrder(actor, id) {
    assert.deepEqual(actor, identity); assert.equal(id, order.id); return structuredClone(order);
  }, async searchKnowledge() { faqCalls++; return [{ source: "demo-knowledge", sourceId: "OBSERVATION-RULE", title: "合成人数规则",
    body: "合成午餐券每张对应两人。", scope: { shopId: order.shop.id, productId: order.items[0]!.productId } }]; } },
    questionContract: "v3", questionResolver: { settings: native.settings, async resolve(source, options) {
      parserCalls++; const captured = await captureSupportQuestionClientForTest(source);
      options?.onTrace?.(captured.trace); return captured.trace.value!;
    } } });
  const turn = controller.createTurn({ identity, sourceKey: merchantSourceKey(identity, groupOpenid), requestId: input.requestId,
    userText: input.originalQuery, trustedRoute: { groupOpenid, messageId: input.requestId }, onQuestionTrace(event) {
      observations++; assert.equal(event.requestId, input.requestId); assert.deepEqual(event.input, input);
      assert.ok(Number.isFinite(Date.parse(event.observedAt))); throw new Error("Synthetic recorder unavailable");
    } });
  const action = { protocol: "v2.2" as const, kind: "policy" as const, question: input.originalQuery,
    questionContext: { kind: "standalone" as const }, orderRef: { kind: "explicit" as const, orderId: order.id } };
  const [first, duplicate] = await Promise.all([turn.execute(action), turn.execute(structuredClone(action))]);
  assert.deepEqual(first, duplicate); assert.equal(first.outcome, "ready"); assert.equal(first.evidence.traceDeliveryFailed, true);
  assert.ok(first.evidence.questionTrace?.attempts[0]!.costUsd! > 0);
  assert.deepEqual({ parserCalls, faqCalls, observations }, { parserCalls: 1, faqCalls: 1, observations: 1 }); controls++;

  for (const architecture of ["atomic", "controller"] as const) {
    assert.deepEqual(readCliQuestionOptions(architecture, {}), { questionContract: "v2" }); controls++;
  }
  assert.deepEqual(readCliQuestionOptions("controller", { CLI_QUESTION_CONTRACT: "v3" }), {
    questionContract: "v3", modelSelection: "deepseek-flash", timeoutMs: 10000 }); controls++;
  assert.deepEqual(readCliQuestionOptions("controller", { CLI_QUESTION_CONTRACT: " v3 ", CLI_QUESTION_MODEL: "qwen3.7-plus-2026-05-26", CLI_QUESTION_TIMEOUT_MS: "15000" }), {
    questionContract: "v3", modelSelection: "qwen3.7-plus-2026-05-26", timeoutMs: 15000 }); controls++;
  for (const env of [{ CLI_QUESTION_CONTRACT: "v4" }, { CLI_QUESTION_MODEL: "deepseek-flash" }, { CLI_QUESTION_TIMEOUT_MS: "10000" },
    { CLI_QUESTION_CONTRACT: "v3", CLI_QUESTION_MODEL: "unknown" },
    ...["999", "15001", "1.5", "NaN", "-1", "1e4"].map(CLI_QUESTION_TIMEOUT_MS => ({ CLI_QUESTION_CONTRACT: "v3", CLI_QUESTION_TIMEOUT_MS }))]) {
    assert.throws(() => readCliQuestionOptions("controller", env)); controls++;
  }
  assert.throws(() => readCliQuestionOptions("atomic", { CLI_QUESTION_CONTRACT: "v3" })); controls++;
  console.log(`support question observation checks passed (${controls} projection, recorder and CLI controls; 0 remote/DB/QQ)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkSupportQuestionObservation();
