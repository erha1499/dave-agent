import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { merchantSourceKey } from "../src/after-sales.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { SupportProtocolError } from "../src/support-action.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, SupportPolicyScopeRepairError, SupportServiceError,
  type SupportCall, type SupportTurnContext } from "../src/support-controller.ts";
import { rememberReferenceChoice, type TrustedReferenceChoices } from "../src/support-reference-selection.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
const identity: QQIdentity = { appId: "POLICY_SCOPE_REPAIR_CHECK", senderId: "OWNER" }, groupOpenid = "scope-repair-controller";
const binding = { sourceKey: merchantSourceKey(identity, groupOpenid), groupOpenid }, orderId = "COUPON-9601";
const initial: Order = { source: "demo-database", id: orderId, status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: "scope-shop", name: "演示门店", merchantName: "模拟商家", address: "模拟地址" },
  items: [{ id: "scope-item", productId: "known-lunch", productName: "相同套餐名", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
  coupons: [{ id: "scope-coupon", orderItemId: "scope-item", status: "unused", expiresAt: "2026-11-04T00:00:00.000Z",
    redeemedAt: null, redeemedShopId: null }], payments: [{ status: "succeeded", amountCents: 7980, paidAt: null }], refunds: [] };
const currentQuestion = `订单 ${orderId} 当前商品的普通周日规则是什么？`;
const policy = (questionContext: { kind: "standalone" } | { kind: "previous"; requestId: string }, extra: Record<string, unknown> = {}): ContextSupportAction =>
  ({ protocol: "v2.2", kind: "policy", question: "模型改写不能替换当前原文", questionContext,
    orderRef: { kind: "explicit", orderId }, evidenceTarget: { kind: "current_order" }, ...extra }) as ContextSupportAction;
let sequence = 0;

async function harness() {
  const state = { order: structuredClone(initial), owner: { ...identity }, calls: [] as SupportCall[], reads: [] as Order[], queries: [] as string[],
    beforeRead: undefined as (() => Promise<void>) | undefined, afterRead: undefined as (() => void) | undefined,
    readError: undefined as Error | undefined };
  const controller = new SupportController({ store: {
    async getOrder(who, id) {
      await state.beforeRead?.();
      if (state.readError) throw state.readError;
      if (id !== state.order.id || who.appId !== state.owner.appId || who.senderId !== state.owner.senderId) throw new OrderAccessError("模拟归属拒绝");
      const fresh = structuredClone(state.order); state.reads.push(fresh); state.afterRead?.(); return fresh;
    },
    async searchKnowledge(query) { state.queries.push(query); return [{ source: "demo-knowledge", sourceId: "SCOPE-RULE", title: "合成普通周末规则",
      body: "常规午餐与晚餐套餐允许普通周末使用，到店前需要向商家核实接待。", scope: { shopId: null, productId: null } }]; },
  } });
  const oldQuestion = `订单 ${orderId} 仅在常规套餐的假设下，普通周日的规则是什么？`;
  const donor = await controller.createTurn({ requestId: `scope-donor-${++sequence}`, identity, sourceKey: binding.sourceKey,
    trustedRoute: { groupOpenid, messageId: `donor-message-${sequence}` }, userText: oldQuestion }).execute(policy({ kind: "standalone" },
    { evidenceTarget: { kind: "rule_only", basis: "仅在常规套餐的假设下" } }));
  assert.ok(donor.verifiedPolicyTopic);
  const topic = donor.verifiedPolicyTopic, choices = rememberReferenceChoice(undefined, binding, { kind: "policy", topic })!;
  state.reads.length = 0; state.queries.length = 0;
  state.order.items[0]!.productId = "unknown-same-name";
  const context = (extra: Partial<SupportTurnContext> = {}): SupportTurnContext => ({ requestId: `scope-current-${++sequence}`, identity,
    sourceKey: binding.sourceKey, trustedRoute: { groupOpenid, messageId: `current-message-${sequence}` }, userText: currentQuestion,
    focusOrderId: orderId, policyTopic: topic, policyChoices: choices, allowPolicyScopeRepair: true,
    onCall: call => state.calls.push(structuredClone(call)), ...extra });
  return { state, controller, topic, choices, oldQuestion, context,
    previous: policy({ kind: "previous", requestId: topic.requestId }), standalone: policy({ kind: "standalone" }) };
}
async function rejection(value: Promise<unknown>) {
  let error: unknown;
  try { await value; } catch (failure) { error = failure; }
  assert.ok(error instanceof SupportPolicyScopeRepairError, "Only the dedicated scope rejection permits this repair");
  return error;
}

export async function checkSupportPolicyScopeController() {
  const main = await harness(), turn = main.controller.createTurn(main.context()), first = turn.execute(main.previous);
  assert.equal(turn.execute(main.previous), first, "Concurrent duplicates share the original Promise");
  assert.throws(() => turn.execute(main.standalone), SupportProtocolError, "A conflict cannot unlock an in-flight action");
  const error = await rejection(first), machine = JSON.parse(error.message);
  assert.equal(machine.code, "POLICY_SCOPE_CHANGED"); assert.deepEqual(machine.repair, error.repair); assert.match(machine.instruction, /standalone/);
  assert.equal(error.repair.version, "policy-scope-repair-v1"); assert.equal(error.repair.budget, undefined);
  assert.deepEqual(error.repair.action, main.previous); assert.deepEqual(error.repair.topic, main.topic);
  assert.equal(main.state.reads.length, 1); assert.equal(main.state.queries.length, 0);
  assert.deepEqual(main.state.calls.map(call => call.name), ["get_order"]);
  assert.ok(Object.isFrozen(error.repair) && Object.isFrozen(error.repair.action) && Object.isFrozen(error.repair.topic.scope)
    && Object.isFrozen(error.repair.call.output));
  assert.throws(() => { error.repair.topic.scope.productId = "forged"; }, TypeError);
  for (const action of [main.previous, policy({ kind: "standalone" }, { orderRef: { kind: "explicit", orderId: "COUPON-9602" } }),
    policy({ kind: "standalone" }, { evidenceTarget: { kind: "rule_only", basis: currentQuestion } }),
    { protocol: "v2.2", kind: "refund_prepare", orderRef: { kind: "explicit", orderId } },
    { protocol: "v2.2", kind: "merchant_prepare", orderRef: { kind: "explicit", orderId }, reason: "行程变化" },
    { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId } },
    { protocol: "v2.2", kind: "clarify", field: "order", reason: "missing" }]) {
    assert.throws(() => turn.validate(action), SupportProtocolError);
    await assert.rejects(turn.execute(action), SupportProtocolError);
  }
  assert.equal(main.state.reads.length, 1, "Forbidden repairs never perform another read");
  main.state.order.items[0]!.productId = "changed-again-dinner";
  main.state.order.status = "redeemed"; main.state.order.coupons[0]!.status = "redeemed";
  main.state.order.coupons[0]!.redeemedAt = "2026-10-06T00:01:00.000Z";
  main.state.order.asOf = "2026-10-06T00:02:00.000Z";
  const terminal = turn.execute(main.standalone), result = await terminal;
  assert.equal(turn.execute(main.standalone), terminal); assert.throws(() => turn.execute(main.previous), SupportProtocolError);
  assert.equal(main.state.reads.length, 2); assert.equal(main.state.queries.length, 1);
  assert.equal(result.evidence.order!.items[0]!.productId, "changed-again-dinner"); assert.equal(result.evidence.order!.status, "redeemed");
  assert.deepEqual(result.evidence.policyScopeRepair, error.repair);
  assert.deepEqual(result.evidence.actualCalls, main.state.calls, "The first read is preserved but never emitted twice");
  assert.deepEqual(result.evidence.actualCalls.map(call => call.name), ["get_order", "get_order", "search_faq"]);
  assert.equal(new Set(result.evidence.actualCalls.map(call => call.id)).size, 3);
  assert.deepEqual(result.evidence.actualCalls[1]!.output, result.evidence.order);
  const evidence = result.evidence.knowledge[0]!.context;
  assert.equal(evidence.policyTopic, null); assert.equal(evidence.facts!.productId, "changed-again-dinner");
  assert.equal(evidence.facts!.status, "redeemed"); assert.equal(evidence.applicability!.requestId, result.evidence.requestId);
  assert.ok(!evidence.effectiveQuery.includes(main.oldQuestion) && !evidence.effectiveQuery.includes("仅在常规套餐的假设下"));
  assert.ok(evidence.effectiveQuery.includes("当前商品的普通周日规则是什么") && evidence.effectiveQuery.includes("已核销退款"));
  assert.deepEqual(result.verifiedPolicyTopic!.priorQueries, []);

  const omitted = await harness(), omittedTurn = omitted.controller.createTurn(omitted.context());
  const withoutTarget = { ...omitted.previous }; delete (withoutTarget as { evidenceTarget?: unknown }).evidenceTarget;
  await rejection(omittedTurn.execute(withoutTarget));
  assert.equal((await omittedTurn.execute(omitted.standalone)).evidence.knowledge[0]!.context.evidenceUse, "current_order");

  const clarify = await harness(), clarifyTurn = clarify.controller.createTurn(clarify.context());
  await rejection(clarifyTurn.execute(clarify.previous));
  const clarification = await clarifyTurn.execute({ protocol: "v2.2", kind: "clarify", field: "policy_topic", reason: "missing" });
  assert.equal(clarification.outcome, "clarification"); assert.ok(clarification.evidence.policyScopeRepair);
  assert.equal(clarification.pendingReferenceKind, "policy"); assert.equal(clarification.referencePresentation, undefined);
  assert.equal(clarification.needsAnswer, false); assert.equal(clarification.reply.kind, "notice");
  assert.match(clarification.reply.text, /范围已变化.*完整重述.*旧话题不能直接沿用/);
  assert.ok(!clarification.reply.text.includes(clarify.topic.originalQuery) && !clarification.reply.text.includes("选择话题"));
  assert.deepEqual(clarification.evidence.policyChoices, clarify.choices, "Choices stay auditable without presenting stale selection instructions");
  assert.deepEqual(clarification.evidence.actualCalls, clarify.state.calls); assert.equal(clarify.state.reads.length, 1); assert.equal(clarify.state.queries.length, 0);

  for (const change of [{ allowPolicyScopeRepair: false }, { allowPolicyScopeRepair: undefined }, { policyChoices: undefined }]) {
    const legacy = await harness(), legacyTurn = legacy.controller.createTurn(legacy.context(change));
    const result = await legacyTurn.execute(legacy.previous);
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.policyScopeRepair, undefined);
    assert.throws(() => legacyTurn.execute(legacy.standalone), SupportProtocolError); assert.equal(legacy.state.reads.length, 1);
  }
  for (const kind of ["refund_eligibility", "rule_only", "focus"] as const) {
    const outside = await harness(); let action: unknown = outside.previous, context = outside.context();
    if (kind === "refund_eligibility") action = { ...outside.previous, kind };
    if (kind === "rule_only") action = { ...outside.previous, evidenceTarget: { kind, basis: "仅在常规套餐的假设下" } };
    if (kind === "focus") { action = { ...outside.previous, orderRef: { kind } }; context.userText = "这张券当前普通周日能用吗？"; }
    const outTurn = outside.controller.createTurn(context), result = await outTurn.execute(action);
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.policyScopeRepair, undefined);
    assert.throws(() => outTurn.execute(outside.standalone), SupportProtocolError); assert.equal(outside.state.queries.length, 0);
  }

  for (const change of ["foreign", "expired", "tampered", "competing"] as const) {
    const invalid = await harness(); let choices: TrustedReferenceChoices = structuredClone(invalid.choices);
    if (change === "foreign") choices.groupOpenid = "other-group";
    if (change === "expired") choices.candidates[0]!.expiresAt = 1;
    if (change === "tampered") choices.candidates[0]!.version = "0".repeat(64);
    if (change === "competing") choices = rememberReferenceChoice(choices, binding,
      { kind: "policy", topic: { ...invalid.topic, requestId: "other-real-question", originalQuery: "一般工作日规则是什么？" } })!;
    const result = await invalid.controller.createTurn(invalid.context({ policyChoices: choices })).execute(invalid.previous);
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.policyScopeRepair, undefined);
    assert.equal(invalid.state.reads.length, 0); assert.equal(invalid.state.queries.length, 0);
  }
  const realNow = Date.now;
  try {
    const expired = await harness(); let now = realNow(); Date.now = () => now;
    expired.state.afterRead = () => { now = expired.choices.candidates[0]!.expiresAt; };
    const result = await expired.controller.createTurn(expired.context()).execute(expired.previous);
    assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.policyScopeRepair, undefined);
    assert.equal(expired.state.reads.length, 1); assert.equal(expired.state.queries.length, 0);
  } finally { Date.now = realNow; }

  const denied = await harness(), deniedTurn = denied.controller.createTurn(denied.context());
  await rejection(deniedTurn.execute(denied.previous)); denied.state.owner = { ...identity, senderId: "OTHER" };
  const denial = deniedTurn.execute(denied.standalone);
  await assert.rejects(denial, error => error instanceof SupportServiceError && error.errorKind === "business_denial");
  assert.equal(deniedTurn.execute(denied.standalone), denial); assert.equal(denied.state.reads.length, 1); assert.equal(denied.state.queries.length, 0);
  for (const failure of [new Error("模拟读取服务失败"), new OrderAccessError("模拟读取拒绝"), error]) {
    const failed = await harness(); failed.state.readError = failure;
    const failedTurn = failed.controller.createTurn(failed.context()), promise = failedTurn.execute(failed.previous);
    await assert.rejects(promise, SupportServiceError);
    assert.equal(failedTurn.execute(failed.previous), promise); assert.throws(() => failedTurn.execute(failed.standalone), SupportProtocolError);
    assert.equal(failed.state.reads.length, 0); assert.equal(failed.state.queries.length, 0);
  }
  const lost = await harness(), lostTurn = lost.controller.createTurn(lost.context({ onCall() { throw new Error("模拟审计投递失败"); } }));
  const lostResult = await lostTurn.execute(lost.previous);
  assert.equal(lostResult.outcome, "clarification"); assert.equal(lostResult.evidence.traceDeliveryFailed, true);
  assert.equal(lostResult.evidence.policyScopeRepair, undefined); assert.throws(() => lostTurn.execute(lost.standalone), SupportProtocolError);

  const cancelled = await harness(), abort = new AbortController(); let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  cancelled.state.beforeRead = async () => { started(); await wait; };
  const cancelledTurn = cancelled.controller.createTurn(cancelled.context({ signal: abort.signal })), pending = cancelledTurn.execute(cancelled.previous);
  await entered; assert.equal(cancelledTurn.execute(cancelled.previous), pending); abort.abort(); release();
  await assert.rejects(pending, failure => !(failure instanceof SupportPolicyScopeRepairError));
  assert.equal(cancelledTurn.execute(cancelled.previous), pending); assert.throws(() => cancelledTurn.execute(cancelled.standalone), SupportProtocolError);
  assert.equal(cancelled.state.reads.length, 1); assert.equal(cancelled.state.queries.length, 0);
  const lateAbort = await harness(), lateSignal = new AbortController(), lateTurn = lateAbort.controller.createTurn(lateAbort.context({ signal: lateSignal.signal }));
  await rejection(lateTurn.execute(lateAbort.previous)); lateSignal.abort();
  await assert.rejects(lateTurn.execute(lateAbort.standalone)); assert.equal(lateAbort.state.reads.length, 1); assert.equal(lateAbort.state.queries.length, 0);

  const unchanged = await harness(); unchanged.state.order = structuredClone(initial);
  const unchangedResult = await unchanged.controller.createTurn(unchanged.context()).execute(unchanged.previous);
  assert.equal(unchangedResult.outcome, "ready"); assert.equal(unchangedResult.evidence.policyScopeRepair, undefined);
  assert.deepEqual(unchanged.state.calls.map(call => call.name), ["get_order", "search_faq"]);
  assert.equal(unchangedResult.evidence.knowledge[0]!.context.policyTopic!.requestId, unchanged.topic.requestId);
  for (const flag of ["true", null, 1]) assert.throws(() => unchanged.controller.createTurn(unchanged.context({ allowPolicyScopeRepair: flag as never })), SupportProtocolError);
  console.log("Policy scope Controller checks passed: opt-in one-time typed repair, original action/read retained, unique call IDs, fresh reauthorization after another state change, same-order current-only or clarification, failed/expired/foreign/concurrent/cancelled/write boundaries; 0 remote/SQL/QQ.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--check", "Use no arguments or --check");
  await checkSupportPolicyScopeController();
}
