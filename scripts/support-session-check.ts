import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import { runCliPrompt } from "../src/cli.ts";
import { merchantSourceKey, type AfterSalesStore, type MerchantTask } from "../src/after-sales.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import type { RefundOperation, RefundStore } from "../src/refunds.ts";
import { markRefundReplyPresented } from "../src/refund-entry.ts";
import { cancelSupportTurn, createSupportSession, getSupportResult, isSupportSession, prepareSupportPrompt, readSupportArchitecture, supportReply,
  type SupportFocus } from "../src/support-session.ts";
import type { SupportAction } from "../src/support-action.ts";
import { modelSupportActionParameters, normalizeModelSupportAction, parseContextSupportAction, type ContextOrderRef, type ContextSupportAction } from "../src/support-context-action.ts";
import type { SupportCall } from "../src/support-controller.ts";
import { readKnowledgeParameters, resolveSupportParameters, resolveSupportRunParameters, type SupportExperimentParameters } from "../src/support-parameters.ts";
import { runSupportV2Live } from "./support-v2-live.ts";

const knowledgeDefaults = { knowledgeMode: "lexical", knowledgeSupport: "binary", knowledgeSupportModel: "configured", knowledgeSupportPrompt: "v5", knowledgeApplicability: "model_only", knowledgeQueryMode: "combined", knowledgeThreshold: .71, knowledgeTimeoutMs: 15_000 };
assert.deepEqual(resolveSupportParameters(), { agentModel: "configured", timeoutMs: 60_000, repairBudget: 1, merchantEvents: "architecture", ...knowledgeDefaults });
assert.deepEqual(resolveSupportParameters({ timeoutMs: 10_000, repairBudget: 0, merchantEvents: "host" }),
  { agentModel: "configured", timeoutMs: 10_000, repairBudget: 0, merchantEvents: "host", ...knowledgeDefaults });
assert.deepEqual(resolveSupportParameters({ timeoutMs: 120_000, repairBudget: 2, merchantEvents: "model" }),
  { agentModel: "configured", timeoutMs: 120_000, repairBudget: 2, merchantEvents: "model", ...knowledgeDefaults });
assert.deepEqual(resolveSupportRunParameters("atomic"), { agentModel: "configured", timeoutMs: 60_000, repairBudget: null, merchantEvents: "model", ...knowledgeDefaults });
assert.deepEqual(resolveSupportRunParameters("controller"), { agentModel: "configured", timeoutMs: 60_000, repairBudget: 1, merchantEvents: "host", ...knowledgeDefaults });
assert.deepEqual(resolveSupportRunParameters("atomic", { merchantEvents: "host", repairBudget: 2 }),
  { agentModel: "configured", timeoutMs: 60_000, repairBudget: null, merchantEvents: "host", ...knowledgeDefaults });
assert.deepEqual(readKnowledgeParameters({}), knowledgeDefaults);
assert.deepEqual(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_THRESHOLD: "0.8", KNOWLEDGE_TIMEOUT_MS: "12000" }),
  { knowledgeMode: "m4-support", knowledgeSupport: "binary", knowledgeSupportModel: "configured", knowledgeSupportPrompt: "v5", knowledgeApplicability: "model_only", knowledgeQueryMode: "combined", knowledgeThreshold: .8, knowledgeTimeoutMs: 12_000 });
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT: "typed" }).knowledgeSupport, "typed");
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT: "typed", KNOWLEDGE_SUPPORT_PROMPT: "v6" }).knowledgeSupportPrompt, "v6");
for (const env of [{ KNOWLEDGE_MODE: "typo" }, { KNOWLEDGE_THRESHOLD: "NaN" }, { KNOWLEDGE_THRESHOLD: "1.01" },
  { KNOWLEDGE_THRESHOLD: "0x1" }, { KNOWLEDGE_TIMEOUT_MS: "0" }, { KNOWLEDGE_TIMEOUT_MS: "1.1" }, { KNOWLEDGE_TIMEOUT_MS: "60001" },
  { KNOWLEDGE_SUPPORT: "typed" }, { KNOWLEDGE_SUPPORT: "invalid" }, { KNOWLEDGE_SUPPORT_PROMPT: "v6" },
  { KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT_PROMPT: "v6" }, { KNOWLEDGE_SUPPORT_PROMPT: "typo" }]) {
  assert.throws(() => readKnowledgeParameters(env));
}
assert.throws(() => resolveSupportRunParameters("atomic", { knowledgeMode: "m4-support" }), /atomic 仅支持 lexical/);
for (const knowledgeSupport of ["binary", "typed"] as const) assert.equal(resolveSupportRunParameters("controller",
  { knowledgeMode: "m4-support", knowledgeSupport, knowledgeApplicability: "declared" }).knowledgeApplicability, "declared");
for (const knowledgeSupport of ["binary", "typed"] as const) assert.equal(resolveSupportRunParameters("controller",
  { knowledgeMode: "m4-support", knowledgeSupport, knowledgeApplicability: "declared-v2" }).knowledgeApplicability, "declared-v2");
assert.throws(() => resolveSupportRunParameters("controller", { knowledgeApplicability: "declared" }), /仅适用于/);
assert.throws(() => resolveSupportRunParameters("atomic", { knowledgeMode: "m4-support", knowledgeApplicability: "declared" }), /atomic/);
assert.throws(() => resolveSupportRunParameters("controller", { knowledgeApplicability: "declared-v2" }), /仅适用于/);
assert.throws(() => resolveSupportRunParameters("atomic", { knowledgeMode: "m4-support", knowledgeApplicability: "declared-v2" }), /atomic/);
assert.equal(resolveSupportRunParameters("controller", { knowledgeMode: "m4-support" }).knowledgeMode, "m4-support");
assert.equal(resolveSupportRunParameters("controller", { knowledgeMode: "m4-support", knowledgeSupport: "typed" }).knowledgeSupport, "typed");
assert.throws(() => resolveSupportRunParameters("unknown" as "atomic"), /业务架构/);
assert.throws(() => resolveSupportRunParameters("controller", { merchantEvents: "model" }), /controller 仅支持宿主/);
const originalEnv = process.env;
let credentialReads = 0;
process.env = new Proxy(originalEnv, { get(target, key) {
  if (typeof key === "string" && /DB_|API_KEY/.test(key)) { credentialReads++; throw new Error("preflight unexpectedly read service credentials"); }
  return Reflect.get(target, key);
} });
try {
  await assert.rejects(runSupportV2Live({ architecture: "controller", label: "invalid combination preflight", parameters: { merchantEvents: "model" } }), /controller 仅支持宿主/);
  await assert.rejects(runSupportV2Live({ architecture: "atomic", label: "invalid knowledge preflight", parameters: { knowledgeMode: "m4-support" } }), /atomic 仅支持 lexical/);
  await assert.rejects(runSupportV2Live({ architecture: "controller", label: "invalid applicability", parameters: { knowledgeApplicability: "declared" } }), /仅适用于/);
  await assert.rejects(runSupportV2Live({ architecture: "controller", label: "invalid support prompt", parameters: { knowledgeMode: "m4-support", knowledgeSupportPrompt: "v6" } }), /knowledgeSupportPrompt v6 仅适用于/);
  await assert.rejects(runSupportV2Live({ architecture: "atomic", label: "invalid applicability architecture", parameters: { knowledgeMode: "m4-support", knowledgeApplicability: "declared" } }), /atomic/);
  assert.equal(credentialReads, 0);
} finally { process.env = originalEnv; }
for (const input of [null, [], { timeoutMs: 9999 }, { timeoutMs: 120001 }, { timeoutMs: 60_000.5 }, { timeoutMs: "60000" },
  { timeoutMs: Infinity }, { repairBudget: -1 }, { repairBudget: 3 }, { repairBudget: 0.5 }, { repairBudget: null },
  { merchantEvents: "typo" }, { merchantEvents: undefined }, { unauthorized: true }, { knowledgeMode: "typo" }, { knowledgeSupport: "typo" }, { knowledgeSupport: "typed" },
  { knowledgeSupportPrompt: "typo" }, { knowledgeSupportPrompt: null }, { knowledgeSupportPrompt: undefined },
  { knowledgeThreshold: NaN }, { knowledgeThreshold: -1 }, { knowledgeThreshold: 1.01 }, { knowledgeThreshold: "0.71" },
  { knowledgeTimeoutMs: 0 }, { knowledgeTimeoutMs: 60001 }, { knowledgeTimeoutMs: 1000.1 }]) {
  const parameters = input as Partial<SupportExperimentParameters>;
  assert.throws(() => resolveSupportParameters(parameters));
  await assert.rejects(runSupportV2Live({ architecture: "controller", label: "invalid preflight", parameters }), /业务实验参数|timeoutMs|repairBudget|merchantEvents|knowledge/);
}
console.log("[support-session] experiment defaults, bounds and invalid runner preflight without services PASS");

// Real Pi lifecycle and tool validation; business spies do not connect to a database or a live model.
const runtime = await createModelRuntime(), faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const identity = { appId: "SESSION_TEST", senderId: "session_user" };
const group = "support_session_group", sourceKey = merchantSourceKey(identity, group);
const orderId = "COUPON-2001", otherId = "COUPON-2002";
const taskId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const now = new Date().toISOString(), expires = new Date(Date.now() + 60_000).toISOString();
const expectedPrompt = (await Promise.all([
  readFile(new URL("../prompts/customer-service-v2.md", import.meta.url), "utf8"),
  readFile(new URL("../skills/shop-support-v2/SKILL.md", import.meta.url), "utf8"),
])).map(text => text.trim()).join("\n\n");
const modelErrors: unknown[] = [], trace: SupportCall[] = [];
const calls: string[] = [], focusWrites: Array<string | undefined> = [];
let focus: string | undefined, failOrder: string | undefined, failFocus = false, prepares = 0;
let requests = 0;
function makeOrder(id: string): Awaited<ReturnType<CouponStore["getOrder"]>> {
  return { source: "demo-database", id, status: "paid", asOf: now, createdAt: now, paidAt: now,
    amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
    shop: { id: "shop-test", name: "门店", merchantName: "商家", address: "地址" },
    items: [{ id: `${id}-item`, productId: "product-test", productName: "套餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [{ id: `${id}-coupon`, orderItemId: `${id}-item`, status: "unused", expiresAt: expires, redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
}
const task: MerchantTask = { taskId, orderId, status: "approved", reason: "行程变化", amountCents: 7980,
  approvedAmountCents: 7980, createdAt: now, dueAt: now, completedAt: now, simulation: true };
const operation: RefundOperation = { operationId, orderId, taskId, status: "prepared", amountCents: 7980,
  expiresAt: expires, presentedAt: null, confirmedAt: null, refundId: null, simulation: true };
const store = {
  async getOrder(who: QQIdentity, id: string) {
    assert.deepEqual(who, identity); calls.push(`order:${id}`);
    if (id === failOrder) throw new Error("synthetic private database detail");
    return makeOrder(id);
  },
  async searchKnowledge(_query: string, shopId?: string, productId?: string) {
    calls.push("faq");
    return [{ source: "demo-knowledge", sourceId: "KB-PRODUCT-TEST", title: "套餐说明", body: "这是单人餐，过敏原未录入。",
      scope: { shopId: shopId ?? null, productId: productId ?? null } }];
  },
} as unknown as CouponStore;
const merchant = {
  async getTask(who: QQIdentity, key: string, id: string) {
    assert.deepEqual(who, identity); assert.equal(key, sourceKey); calls.push(`task:${id}`); return { ...task, orderId: id };
  },
} as unknown as AfterSalesStore;
const refunds = {
  async prepare(who: QQIdentity, key: string, id: string) {
    assert.deepEqual(who, identity); assert.equal(key, sourceKey); prepares++; calls.push(`prepare:${id}`);
    return { ...operation, orderId: id };
  },
  async get(who: QQIdentity, key: string, id: string) {
    assert.deepEqual(who, identity); assert.equal(key, sourceKey); calls.push(`refund:${id}`); return { ...operation, orderId: id };
  },
} as unknown as RefundStore;
const focusStore: SupportFocus = {
  async read() { if (failFocus) throw new Error("focus offline"); return focus; },
  async write(value) { focusWrites.push(value); if (failFocus) throw new Error("focus offline"); focus = value; },
};
const explicit = (id = orderId) => ({ kind: "explicit" as const, orderId: id });
type HostReference = { kind?: string; protocol?: string; orderId?: string | null;
  policyTopic?: { requestId: string; originalQuery: string } | null;
  itemPaidUnit?: { requestId: string; orderId: string; paidCents: number } | null; alternativeOrderId?: string | null };
const hostReference = (context: TranscriptContext) => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text))
  .map(text => { try { return JSON.parse(text) as HostReference; } catch { return {}; } })
  .filter(value => value.kind === "host_order_reference").at(-1) ?? {};
const currentAction = (action: SupportAction | ContextSupportAction): ContextSupportAction => "protocol" in action ? action
  : { ...action, protocol: "v2.2", ...(action.kind === "policy" || action.kind === "refund_eligibility"
    ? { questionContext: { kind: "standalone" as const } } : {}) } as ContextSupportAction;
const previous = (question: string, kind: "policy" | "refund_eligibility" = "policy", orderRef: ContextOrderRef = { kind: "focus" }) =>
  (host: HostReference): ContextSupportAction => ({ protocol: "v2.2", kind, question, orderRef,
    questionContext: { kind: "previous", requestId: host.policyTopic?.requestId ?? "unavailable-topic" } });
const comparePaid = (host: HostReference): ContextSupportAction => ({ protocol: "v2.2", kind: "paid_amount_compare",
  orderRef: { kind: "focus" }, amountRef: { requestId: host.itemPaidUnit?.requestId ?? "unavailable-amount" } });
function observe(context: TranscriptContext, expectedFocus?: string | null) {
  // Pi converts callback assertions into model errors; save them for independent assertions after each turn.
  try {
    assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
    const tools = getCurrentTools(context.messages);
    assert.deepEqual(tools.map(tool => tool.name), ["support_action"]);
    assert.deepEqual(JSON.parse(JSON.stringify(tools[0]!.parameters)), JSON.parse(JSON.stringify(modelSupportActionParameters)),
      "the real session exposes current business fields with only the host protocol constant optional");
    if (expectedFocus !== undefined) {
      const reference = hostReference(context);
      assert.equal(reference?.orderId, expectedFocus, "before_agent_start must inject the current host reference");
    }
  } catch (error) { modelErrors.push(error); }
}
// Default adaptation is only for legacy fixed faux scripts. Reference tests below
// explicitly choose new semantic slots using IDs from the actual current host message.
const choose = (action: SupportAction | ContextSupportAction | ((host: HostReference) => ContextSupportAction), expectedFocus?: string | null): FauxResponseStep => (context, _options, _state, model) => {
  observe(context, expectedFocus);
  try { assert.equal(model.maxTokens, 2048); } catch (error) { modelErrors.push(error); }
  return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(hostReference(context)) : currentAction(action) }), { stopReason: "toolUse" });
};
const finish: FauxResponseStep = context => { observe(context); return fauxAssistantMessage("工程验证：按当前证据答复。"); };
let session = await createSupportSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey, refunds }, { groupOpenid: group, focus: focusStore });
async function run(text: string, responses: FauxResponseStep[], expectedPending = 0) {
  const before = session.messages.length;
  const requestId = `session-request-${++requests}`;
  prepareSupportPrompt(session, { requestId, groupOpenid: group, messageId: requestId, onCall: call => trace.push(call) });
  faux.setResponses(responses);
  await session.prompt(text, { expandPromptTemplates: false });
  assert.equal(faux.getPendingResponseCount(), expectedPending);
  assert.deepEqual(modelErrors, []);
  return session.messages.slice(before).filter(message => message.role === "toolResult");
}

try {
  assert.equal(readSupportArchitecture({}), "atomic");
  assert.equal(readSupportArchitecture({ SUPPORT_ARCHITECTURE: "controller" }), "controller");
  assert.throws(() => readSupportArchitecture({ SUPPORT_ARCHITECTURE: "typo" }));
  assert.ok(isSupportSession(session));
  assert.deepEqual(session.getActiveToolNames(), ["support_action"]);

  await run(`查询 ${orderId}`, [choose({ kind: "order", orderRef: explicit() }, null), finish]);
  assert.equal(focus, orderId); assert.equal(getSupportResult(session)?.verifiedOrderId, orderId);
  assert.equal(trace[0]?.parentSpanId, "session-request-1"); assert.equal(trace[0]?.actor, "host");
  await run("这个套餐几个人用？", [choose({ kind: "policy", question: "这个套餐几个人用？", orderRef: { kind: "focus" } }, orderId), finish]);
  assert.equal(getSupportResult(session)?.evidence.order?.id, orderId);
  const answer = supportReply(session, "仅供一人使用。依据 KB-PRODUCT-TEST。");
  assert.equal(answer?.kind, "order"); assert.ok(answer && "text" in answer && answer.text.includes("仅供一人"));
  const latestTool = session.messages.findLast(message => message.role === "toolResult");
  assert.ok(latestTool?.role === "toolResult");
  assert.doesNotMatch(JSON.stringify(latestTool.content), /trustedRoute|groupOpenid|session_user|SESSION_TEST|actualCalls/);
  console.log("[support-session] real before-start, one typed tool, focus and private host trace PASS");

  const beforeReferenceRepair = calls.length;
  const referenceRepair = await run("它还没用过，可以退款吗？只咨询。", [
    choose({ kind: "refund_eligibility", orderRef: explicit(), question: "退款资格" }, orderId),
    choose({ kind: "refund_eligibility", orderRef: { kind: "focus" }, question: "它还没用过，可以退款吗？只咨询。" }, orderId), finish,
  ]);
  assert.deepEqual(referenceRepair.map(result => result.isError), [true, false]);
  assert.deepEqual(calls.slice(beforeReferenceRepair), [`order:${orderId}`, "faq"]);
  assert.equal(getSupportResult(session)?.outcome, "ready");
  const beforeBadReferences = calls.length, modelBeforeBadReferences = faux.state.callCount;
  const badReference = choose({ kind: "order", orderRef: explicit() }, orderId);
  const exhaustedReferences = await run("再查一下这张券。", [badReference, badReference, choose({ kind: "order", orderRef: { kind: "focus" } }), finish], 2);
  assert.ok(exhaustedReferences.every(result => result.isError));
  assert.equal(calls.length, beforeBadReferences); assert.equal(faux.state.callCount, modelBeforeBadReferences + 2);
  assert.equal(getSupportResult(session), undefined, "invalid reference repairs consume the same per-turn budget as schema repairs");
  faux.setResponses([]);
  console.log("[support-session] current-text reference error repairs to focus once; repeated invalid references exhaust budget before services PASS");

  const beforePrepare = prepares;
  const duplicate = currentAction({ kind: "refund_prepare" as const, orderRef: explicit() });
  const duplicateResults = await run(`请给 ${orderId} 生成退款方案`, [context => {
    observe(context);
    return fauxAssistantMessage([fauxToolCall("support_action", { action: duplicate }), fauxToolCall("support_action", { action: duplicate })], { stopReason: "toolUse" });
  }, finish]);
  assert.equal(duplicateResults.length, 2); assert.ok(duplicateResults.every(result => !result.isError));
  assert.equal(prepares, beforePrepare + 1);
  assert.equal(supportReply(session, "已退999999元")?.kind, "refund_confirmation");
  const conflicts = await run(`查询 ${orderId}`, [choose({ kind: "order", orderRef: explicit() }), choose({ kind: "refund_prepare", orderRef: explicit() }), finish]);
  assert.deepEqual(conflicts.map(result => result.isError), [false, true]);
  assert.equal(prepares, beforePrepare + 1); assert.equal(getSupportResult(session)?.action.kind, "order");
  const beforePreparedConflict = prepares, callsBeforePreparedConflict = calls.length;
  const preparedConflict = await run(`为 ${orderId} 生成退款方案。`, [
    choose({ kind: "refund_prepare", orderRef: explicit() }), choose({ kind: "refund_status", orderRef: explicit() }), finish,
  ]);
  assert.deepEqual(preparedConflict.map(result => result.isError), [false, true]);
  assert.equal(prepares, beforePreparedConflict + 1);
  assert.deepEqual(calls.slice(callsBeforePreparedConflict), [`order:${orderId}`, "faq", `task:${orderId}`, `prepare:${orderId}`]);
  assert.equal(supportReply(session)?.kind, "refund_confirmation", "conflicting correction cannot replace or rerun a prepared operation");
  console.log("[support-session] duplicate action executes once and conflicts cannot add mutations PASS");

  const originalRefundGet = refunds.get;
  refunds.get = async (...args) => {
    const found = await originalRefundGet(...args); assert.ok(found);
    return { ...found, expiresAt: "2000-01-01T00:00:00.000Z" };
  };
  const beforeExpiredStatus = calls.length, preparationsBeforeStatus = prepares;
  await run(`查询 ${orderId} 已过期的退款方案，不要重建。`, [choose({ kind: "refund_status", orderRef: explicit() }), finish]);
  assert.deepEqual(calls.slice(beforeExpiredStatus), [`order:${orderId}`, `refund:${orderId}`]);
  assert.equal(getSupportResult(session)?.evidence.operation?.expiresAt, "2000-01-01T00:00:00.000Z"); assert.equal(prepares, preparationsBeforeStatus);
  refunds.get = originalRefundGet;
  const beforeOrderStatus = calls.length;
  await run(`查询 ${orderId} 订单和券的状态。`, [choose({ kind: "order", orderRef: explicit() }), finish]);
  assert.deepEqual(calls.slice(beforeOrderStatus), [`order:${orderId}`]);
  const beforeRebuild = calls.length;
  await run(`请重新生成 ${orderId} 的退款方案。`, [choose({ kind: "refund_prepare", orderRef: explicit() }), finish]);
  assert.deepEqual(calls.slice(beforeRebuild), [`order:${orderId}`, "faq", `task:${orderId}`, `prepare:${orderId}`]);
  assert.equal(prepares, preparationsBeforeStatus + 1);
  console.log("[support-session] expired refund-operation lookup, order lookup and explicit rebuild use distinct service paths PASS (faux actions; not model classification)");

  failOrder = otherId;
  const failed = await run(`查询 ${otherId}`, [choose({ kind: "order", orderRef: explicit(otherId) }, null), finish]);
  assert.equal(failed[0]?.isError, true); assert.equal(focus, undefined);
  assert.equal(getSupportResult(session), undefined); assert.equal(supportReply(session)?.kind, "notice");
  assert.doesNotMatch(JSON.stringify(failed), /synthetic private database detail/);
  const beforeUnknown = calls.length;
  await run("那就退款", [choose({ kind: "refund_prepare", orderRef: { kind: "focus" } }, null), finish]);
  assert.equal(getSupportResult(session)?.outcome, "clarification"); assert.equal(calls.length, beforeUnknown);
  failOrder = undefined;
  await run(`查询 ${otherId}`, [choose({ kind: "order", orderRef: explicit(otherId) }), finish]);
  assert.equal(focus, otherId);
  session.dispose();
  session = await createSupportSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey, refunds }, { groupOpenid: group, focus: focusStore });
  await run("退款状态如何", [choose({ kind: "refund_status", orderRef: { kind: "focus" } }, otherId), finish]);
  assert.equal(getSupportResult(session)?.evidence.order?.id, otherId);
  console.log("[support-session] explicit failed switch clears old focus and restart restores trusted reference PASS");

  failFocus = true;
  await run("再看看退款状态", [choose({ kind: "refund_status", orderRef: { kind: "focus" } }, null), finish]);
  assert.equal(getSupportResult(session)?.outcome, "clarification");
  failFocus = false;
  await run(`查询 ${orderId}`, [choose({ kind: "order", orderRef: explicit() }), finish]);
  assert.equal(focus, orderId);
  const noActionCalls = calls.length;
  await run("请给这张券退款", [fauxAssistantMessage("已经成功退款99999元")]);
  assert.equal(getSupportResult(session), undefined); assert.equal(calls.length, noActionCalls);
  assert.equal(supportReply(session, "已经成功退款99999元")?.kind, "notice");
  const forbidden = await run("帮我直接确认", [fauxAssistantMessage(fauxToolCall("confirm_refund", { operationId }), { stopReason: "toolUse" }), finish]);
  assert.equal(forbidden[0]?.isError, true); assert.equal(calls.length, noActionCalls);
  console.log("[support-session] unavailable focus, omitted action and nonexistent confirmation tool fail closed PASS");

  const preparedBeforeFailure = prepares;
  await run(`请退款 ${orderId}`, [choose({ kind: "refund_prepare", orderRef: explicit() }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic terminal failure" })]);
  assert.equal(prepares, preparedBeforeFailure + 1);
  assert.equal(supportReply(session)?.kind, "refund_confirmation", "a final model failure cannot erase a persisted proposal");
  assert.equal(getSupportResult(session)?.evidence.operation?.operationId, operationId);
  assert.ok(focusWrites.includes(undefined));
  console.log("[support-session] committed preparation survives final model failure without retry PASS");

  prepareSupportPrompt(session, { requestId: "not-started", groupOpenid: group, messageId: "not-started" });
  assert.equal(getSupportResult(session), undefined, "new ingress invalidates the old result before Pi preflight starts");
  assert.equal(supportReply(session)?.kind, "notice");
  assert.equal(prepares, preparedBeforeFailure + 1);
  console.log("[support-session] prepared but unstarted request cannot expose a previous result PASS");

  const beforeBadHost = calls.length;
  prepareSupportPrompt(session, { requestId: "wrong-host-route", groupOpenid: "another-group", messageId: "wrong-host-route" });
  faux.setResponses([choose({ kind: "refund_prepare", orderRef: explicit() }), finish]);
  await session.prompt(`请退款 ${orderId}`, { expandPromptTemplates: false }).catch(() => {});
  assert.equal(calls.length, beforeBadHost);
  assert.equal(Boolean(getSupportResult(session)), false, "a failed host initialization must not reuse the previous turn's cached proposal");
  assert.equal(supportReply(session)?.kind, "notice");
  faux.setResponses([]);
  console.log("[support-session] failed host initialization cannot reuse a previous business result PASS");

  await run("这个套餐几个人用？", [choose({ kind: "policy", question: "这个套餐几个人用？", orderRef: { kind: "focus" } }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic answer failure" })]);
  const policyFallback = supportReply(session, "模型出错后的文本不可使用");
  assert.ok(policyFallback?.kind === "order");
  assert.match(policyFallback.text, /已查到相关规则.*稍后重新咨询/);
  assert.doesNotMatch(policyFallback.text, /请根据本轮|模型出错后的文本/);
  console.log("[support-session] failed policy expression uses a customer-facing fallback PASS");

  const malformed = () => fauxAssistantMessage(fauxToolCall("support_action", { action: { kind: "not_a_kind" } }), { stopReason: "toolUse" });
  const repaired = await run(`查询 ${orderId}`, [malformed, choose({ kind: "order", orderRef: explicit() }), finish]);
  assert.deepEqual(repaired.map(result => result.isError), [true, false], "one correction is permitted");
  assert.equal(getSupportResult(session)?.action.kind, "order");
  const omitted = { kind: "order", orderRef: explicit() };
  assert.throws(() => parseContextSupportAction(omitted), /业务动作格式无效/, "internal parser remains strict");
  assert.deepEqual(normalizeModelSupportAction(omitted), { ...omitted, protocol: "v2.2" });
  assert.equal(Object.hasOwn(omitted, "protocol"), false, "normalization must not rewrite the recorded raw model input");
  for (const invalid of [
    ...["v2.1", "v3", null, undefined].map(protocol => ({ ...omitted, protocol })),
    { kind: "order" }, { kind: "policy", question: "能退款吗？" },
    { kind: "refund_eligibility", question: "能退款吗？", questionContext: { kind: "standalone" } },
    ...["identity", "scope", "amountCents", "approved"].map(field => ({ ...omitted, [field]: "untrusted" })),
    { kind: "paid_amount_compare", orderRef: explicit(), amountRef: { requestId: "source", amountCents: 100 } },
  ]) assert.throws(() => normalizeModelSupportAction(invalid), /业务动作格式无效/, "only an absent protocol can be filled");
  const omittedProtocol = () => fauxAssistantMessage(fauxToolCall("support_action", { action: omitted }), { stopReason: "toolUse" });
  const beforeOmitted = calls.length;
  const normalized = await run(`查询 ${orderId}`, [omittedProtocol, finish]);
  assert.deepEqual(normalized.map(result => result.isError), [false]);
  assert.deepEqual(calls.slice(beforeOmitted), [`order:${orderId}`]);
  assert.deepEqual(getSupportResult(session)!.action, { ...omitted, protocol: "v2.2" });
  const wrongProtocol = () => fauxAssistantMessage(fauxToolCall("support_action", { action: { ...omitted, protocol: "v2.1" } }), { stopReason: "toolUse" });
  const beforeProtocolRepair = calls.length;
  const protocolRepair = await run(`查询 ${orderId}`, [wrongProtocol, choose({ kind: "order", orderRef: explicit() }), finish]);
  assert.deepEqual(protocolRepair.map(result => result.isError), [true, false]);
  assert.deepEqual(calls.slice(beforeProtocolRepair), [`order:${orderId}`]);
  assert.equal((getSupportResult(session)!.action as ContextSupportAction).protocol, "v2.2");
  const beforeOldProtocol = calls.length, beforeOldModel = faux.state.callCount;
  const exhaustedProtocol = await run(`查询 ${orderId}`, [wrongProtocol, wrongProtocol, choose({ kind: "order", orderRef: explicit() }), finish], 2);
  assert.ok(exhaustedProtocol.every(result => result.isError)); assert.equal(calls.length, beforeOldProtocol);
  assert.equal(faux.state.callCount, beforeOldModel + 2); assert.equal(getSupportResult(session), undefined);
  faux.setResponses([]);
  console.log("[support-session] host fills only omitted protocol; internal schema, business fields and bounded invalid-version repair stay strict PASS");
  const beforeReasonRepair = prepares, beforeReasonCalls = calls.length;
  const reasonRepair = await run(`请给 ${orderId} 生成退款方案。`, [
    fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "refund_prepare", orderRef: explicit(), reason: "行程变化" } }), { stopReason: "toolUse" }),
    choose({ kind: "refund_prepare", orderRef: explicit() }), finish,
  ]);
  assert.deepEqual(reasonRepair.map(result => result.isError), [true, false], "obsolete reason must be rejected, not silently stripped");
  assert.equal(prepares, beforeReasonRepair + 1);
  assert.deepEqual(calls.slice(beforeReasonCalls), [`order:${orderId}`, "faq", `task:${orderId}`, `prepare:${orderId}`]);
  assert.equal(getSupportResult(session)?.evidence.task?.reason, "行程变化");
  assert.equal(supportReply(session)?.kind, "refund_confirmation");
  console.log("[support-session] obsolete refund reason is rejected and one explicit repair uses the approved task PASS");
  const beforeMalformed = calls.length, modelCalls = faux.state.callCount;
  const results = await run(`查询 ${orderId}`, [malformed, malformed, choose({ kind: "order", orderRef: explicit() }), finish], 2);
  assert.ok(results.every(result => result.isError), "after the one allowed format repair also fails, later actions must not execute");
  assert.equal(faux.state.callCount, modelCalls + 2, "the unconsumed valid action and final answer must never reach the model");
  assert.equal(calls.length, beforeMalformed);
  assert.equal(getSupportResult(session), undefined);
  faux.setResponses([]);
  await run("你好", [choose({ kind: "non_business", reason: "greeting" }), finish]);
  assert.equal(getSupportResult(session)?.outcome, "non_business", "a new request gets a fresh bounded repair budget");
  console.log("[support-session] format repair budget blocks later execution after repeated invalid arguments PASS");

  for (const repairBudget of [0, 2]) {
    session.dispose();
    session = await createSupportSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey, refunds },
      { groupOpenid: group, focus: focusStore, repairBudget });
    const normalizedAtBudget = await run(`查询 ${orderId}`, [omittedProtocol, finish]);
    assert.deepEqual(normalizedAtBudget.map(result => result.isError), [false], "omitted host constant consumes no schema or event repair budget");
    assert.deepEqual(getSupportResult(session)!.action, { ...omitted, protocol: "v2.2" });
    const allowed = await run(`查询 ${orderId}`, [
      ...Array.from({ length: repairBudget }, () => malformed), choose({ kind: "order", orderRef: explicit() }), finish,
    ]);
    assert.deepEqual(allowed.map(result => result.isError), [...Array.from({ length: repairBudget }, () => true), false]);
    assert.equal(getSupportResult(session)?.action.kind, "order");
    const before = calls.length, modelBefore = faux.state.callCount;
    const aborted = await run(`查询 ${orderId}`, [
      ...Array.from({ length: repairBudget + 1 }, () => malformed), choose({ kind: "order", orderRef: explicit() }), finish,
    ], 2);
    assert.ok(aborted.every(result => result.isError));
    assert.equal(faux.state.callCount, modelBefore + repairBudget + 1);
    assert.equal(calls.length, before, "aborting at the selected repair budget must block every later business action");
    assert.equal(getSupportResult(session), undefined);
    faux.setResponses([]);
    await run("你好", [choose({ kind: "non_business", reason: "greeting" }), finish]);
    assert.equal(getSupportResult(session)?.outcome, "non_business");
  }
  await assert.rejects(createSupportSession(identity, store, runtime, faux.getModel(), undefined, { repairBudget: 3 }), /repairBudget/);
  console.log("[support-session] repairBudget 0 and 2 enforce actual model abort, valid repairs and per-turn reset PASS");

  const knowledgeInputs: string[] = [];
  let knowledgeUnavailable = false;
  const knowledge: NonNullable<Parameters<typeof createSupportSession>[5]>["knowledge"] = { async search(input) {
    knowledgeInputs.push(input.query);
    return { documents: knowledgeUnavailable ? [] : [{ source: "demo-knowledge", sourceId: "KB-CALENDAR", title: "可用日期", body: "平日与周末均可用。",
      scope: { shopId: input.scope.shopId ?? null, productId: input.scope.productId ?? null } }],
      trace: { mode: "m4-support", threshold: .71, query: input.query, originalQuery: input.originalQuery!, scope: input.scope,
        status: knowledgeUnavailable ? "unavailable" : "accepted", reason: knowledgeUnavailable ? "provider_unavailable" : null,
        rawRanking: [{ id: "KB-CALENDAR", score: .95 }], acceptance: null, sourceHashes: { before: "fixture-version", after: "fixture-version" },
        durationMs: 1, calls: [], usage: { rerankTokens: 20, supportTokens: 40, estimatedCny: .00001, estimatedUsd: .00002, incompleteCalls: 0 },
        pricing: { estimated: true, rerankCnyPerMillionTokens: .5, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" } } };
  } };
  session.dispose();
  session = await createSupportSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey, refunds },
    { groupOpenid: group, focus: focusStore, knowledge });
  const calendarQuestion = `${orderId} 的套餐平日可用吗？`;
  await run(calendarQuestion, [choose({ kind: "policy", orderRef: explicit(), question: "模型简化的问题" }), finish]);
  assert.equal(getSupportResult(session)!.verifiedPolicyTopic!.originalQuery, calendarQuestion);
  await run("周末也这样吗？", [choose(previous("周末也这样吗？")), finish]);
  assert.equal(getSupportResult(session)!.outcome, "ready");
  assert.ok(knowledgeInputs.at(-1)!.includes(calendarQuestion.replaceAll(orderId, "该订单")));
  const knowledgeStep = trace.findLast(step => step.name === "search_faq")!;
  assert.equal(knowledgeStep.knowledge!.trace.mode, "m4-support"); assert.equal(knowledgeStep.knowledge!.trace.usage.supportTokens, 40);
  const beforeAmbiguous = knowledgeInputs.length;
  await run("换成另一张呢？", [choose({ kind: "clarify", field: "order", reason: "ambiguous" }, orderId), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(focus, orderId, "semantic clarification does not imply the host forgot an authorized order");
  await run("那刚才的使用规则还能适用吗？", [choose(previous("那刚才的使用规则还能适用吗？"), orderId), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(knowledgeInputs.length, beforeAmbiguous);
  await run(calendarQuestion, [choose({ kind: "policy", orderRef: explicit(), question: "可用日期" }), finish]);
  session.dispose();
  session = await createSupportSession(identity, store, runtime, faux.getModel(), { store: merchant, sourceKey, refunds },
    { groupOpenid: group, focus: focusStore, knowledge });
  await run("周末也这样吗？", [choose(previous("周末也这样吗？"), orderId), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification", "a restored order focus does not restore a policy topic across sessions");
  await run(calendarQuestion, [choose({ kind: "policy", orderRef: explicit(), question: "可用日期" }), finish]);
  knowledgeUnavailable = true;
  await run("周末也这样吗？", [choose(previous("周末也这样吗？")), finish]);
  assert.equal(getSupportResult(session)!.needsAnswer, false); assert.equal(getSupportResult(session)!.verifiedPolicyTopic, undefined);
  knowledgeUnavailable = false;
  const beforeNoTopic = knowledgeInputs.length;
  await run("周末也这样吗？", [choose(previous("周末也这样吗？")), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(knowledgeInputs.length, beforeNoTopic);
  await run(calendarQuestion, [choose({ kind: "policy", orderRef: explicit(), question: "可用日期" }), finish]);
  await run("接下来呢？", [fauxAssistantMessage("本轮没有产生业务动作。")]);
  const beforeOmission = knowledgeInputs.length;
  await run("周末也这样吗？", [choose(previous("周末也这样吗？")), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(knowledgeInputs.length, beforeOmission);
  console.log("[support-session] injected knowledge trace, bounded policy context and ambiguity/failure/restart invalidation PASS");

  const partialOrder = makeOrder(orderId);
  partialOrder.status = "partially_redeemed";
  partialOrder.amounts = { totalCents: 10480, paidCents: 10480, refundedCents: 0 };
  Object.assign(partialOrder.items[0]!, { quantity: 2, unitPriceCents: 5240, totalCents: 10480 });
  partialOrder.payments[0]!.amountCents = 10480;
  partialOrder.coupons = [{ ...partialOrder.coupons[0]!, id: "session-used", status: "redeemed", redeemedAt: now, redeemedShopId: "shop-test" },
    { ...partialOrder.coupons[0]!, id: "session-left" }];
  const contextStore = { ...store, async getOrder(who: QQIdentity, id: string) {
    assert.deepEqual(who, identity); calls.push(`order:${id}`);
    if (id === orderId) return structuredClone(partialOrder);
    const other = makeOrder(id);
    if (id === otherId) { other.status = "refunded"; other.amounts.refundedCents = other.amounts.paidCents; }
    return other;
  } } as unknown as CouponStore;
  session.dispose();
  session = await createSupportSession(identity, contextStore, runtime, faux.getModel(), { store: merchant, sourceKey, refunds },
    { groupOpenid: group, focus: focusStore, knowledge });
  const beforeReadOnly = prepares;
  await run(`查询订单 ${orderId} 的实付。`, [choose({ kind: "order", orderRef: explicit() }), finish]);
  assert.equal(getSupportResult(session)!.verifiedAmountReference!.paidCents, 5240);
  const shownAmountId = getSupportResult(session)!.verifiedAmountReference!.requestId;
  const beforeComparedKnowledge = knowledgeInputs.length, beforeComparedCalls = calls.length;
  await run("剩下那个也是这个金额吗？", [choose(comparePaid), finish]);
  assert.equal(getSupportResult(session)!.evidence.amountComparison!.comparisonEqual, true);
  assert.equal(getSupportResult(session)!.evidence.amountComparison!.referenceRequestId, shownAmountId);
  assert.equal(knowledgeInputs.length, beforeComparedKnowledge); assert.deepEqual(calls.slice(beforeComparedCalls), [`order:${orderId}`]);
  const paidReply = supportReply(session, "商家已经批准9999元")!;
  assert.ok(paidReply.kind === "order"); assert.match(paidReply.text, /52.40.*相同/); assert.doesNotMatch(paidReply.text, /9999/);
  assert.equal(getSupportResult(session)!.needsAnswer, false, "the host renders money facts independently of final model language");
  const otherAmountWording = "还没有使用过的那张券，实付也和前面显示的一样吗？";
  await run(otherAmountWording, [choose(comparePaid), finish]);
  assert.equal(getSupportResult(session)!.evidence.amountComparison!.remainingUnitPaidCents, 5240);
  assert.equal(getSupportResult(session)!.evidence.amountComparison!.refundApproved, false);

  await run(`查询 ${otherId}`, [choose({ kind: "order", orderRef: explicit(otherId) }), finish]);
  await run(`${orderId} 的退款申请资格是什么？`, [choose({ kind: "refund_eligibility", orderRef: explicit(), question: "退款资格" }), finish]);
  await run("换成另一张呢？", [choose(previous("换成另一张呢？", "refund_eligibility", { kind: "alternative" })), finish]);
  assert.equal(getSupportResult(session)!.verifiedOrderId, otherId); assert.equal(focus, otherId);
  assert.equal(getSupportResult(session)!.evidence.order!.status, "refunded");
  assert.equal(getSupportResult(session)!.evidence.knowledge[0]!.context.orderSource, "verified_alternative");
  assert.equal(prepares, beforeReadOnly, "both context capabilities are read-only across actual Pi session turns");

  const thirdId = "COUPON-2099";
  await run(`查询 ${thirdId}`, [choose({ kind: "order", orderRef: explicit(thirdId) }), finish]);
  await run(`${orderId} 的退款申请资格是什么？`, [choose({ kind: "refund_eligibility", orderRef: explicit(), question: "退款资格" }), finish]);
  const beforeMany = calls.length;
  await run("换成另一张呢？", [choose(previous("换成另一张呢？", "refund_eligibility", { kind: "alternative" }), orderId), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(calls.length, beforeMany);
  await run(`查询 ${orderId}`, [choose({ kind: "order", orderRef: explicit() }), finish]);
  session.dispose();
  session = await createSupportSession(identity, contextStore, runtime, faux.getModel(), { store: merchant, sourceKey, refunds },
    { groupOpenid: group, focus: focusStore, knowledge });
  const beforeLostReference = calls.length;
  await run("剩下那个也是这个金额吗？", [choose(comparePaid, orderId), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(calls.length, beforeLostReference);
  await run(otherAmountWording, [choose(comparePaid), finish]);
  assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(calls.length, beforeLostReference,
    "alternative amount wording cannot retrieve generic rules when its trusted reference was lost");
  console.log("[support-session] actual-turn paid references and alternative orders, fixed money reply and missing/multiple/restart guards PASS");

  const cliSource = merchantSourceKey(identity, "cli"), delivery: string[] = [];
  let cliPrepares = 0, markFailure = false;
  const cliMerchant = {
    async getTask(who: QQIdentity, key: string, id: string) {
      assert.deepEqual(who, identity); assert.equal(key, cliSource); assert.equal(id, orderId); return task;
    },
  } as unknown as AfterSalesStore;
  const cliRefunds = {
    async prepare(who: QQIdentity, key: string, id: string) {
      assert.deepEqual(who, identity); assert.equal(key, cliSource); assert.equal(id, orderId);
      cliPrepares++; delivery.push("prepare"); return operation;
    },
    async markPresented(who: QQIdentity, key: string, id: string) {
      assert.deepEqual(who, identity); assert.equal(key, cliSource); assert.equal(id, operationId);
      assert.equal(delivery.at(-1), "write"); delivery.push("mark");
      if (markFailure) throw new Error("synthetic presentation failure");
    },
  } as unknown as RefundStore;
  const cliSession = await createSupportSession(identity, store, runtime, faux.getModel(), { store: cliMerchant, sourceKey: cliSource, refunds: cliRefunds });
  const failAfterPrepare = () => faux.setResponses([choose({ kind: "refund_prepare", orderRef: explicit() }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic terminal failure" })]);
  const write = async (output: string) => {
    assert.match(output, /模拟退款待确认/); assert.ok(output.includes(operationId));
    assert.doesNotMatch(output, /synthetic terminal failure/); delivery.push("write");
  };
  const mark = (reply: Parameters<typeof markRefundReplyPresented>[3]) => markRefundReplyPresented(cliRefunds, identity, cliSource, reply);
  try {
    failAfterPrepare();
    const recovered = await runCliPrompt(cliSession, `请退款 ${orderId}`, write, mark);
    assert.equal(recovered.kind, "refund_confirmation"); assert.equal(cliPrepares, 1);
    assert.deepEqual(delivery, ["prepare", "write", "mark"]);
    const evidence = getSupportResult(cliSession)?.evidence;
    assert.equal(evidence?.trustedRoute.groupOpenid, "cli");
    assert.match(evidence?.requestId ?? "", /^[a-f0-9-]{36}$/);
    assert.equal(evidence?.trustedRoute.messageId, evidence?.requestId);

    delivery.length = 0;
    const previousPrompt = cliSession.prompt;
    cliSession.prompt = async () => { throw new Error("synthetic preflight failure"); };
    try {
      await assert.rejects(runCliPrompt(cliSession, `查询 ${otherId}`, write, mark), /模型请求失败/);
    } finally { cliSession.prompt = previousPrompt; }
    assert.equal(getSupportResult(cliSession), undefined); assert.equal(delivery.length, 0);
    assert.equal(cliPrepares, 1, "preflight failure cannot reuse or repeat the previous preparation");

    failAfterPrepare();
    await assert.rejects(runCliPrompt(cliSession, `请退款 ${orderId}`, async () => {
      delivery.push("write-failed"); throw new Error("synthetic stdout failure");
    }, mark), /synthetic stdout failure/);
    assert.deepEqual(delivery, ["prepare", "write-failed"]); assert.equal(cliPrepares, 2);

    delivery.length = 0; markFailure = true;
    failAfterPrepare();
    await assert.rejects(runCliPrompt(cliSession, `请退款 ${orderId}`, write, mark), /synthetic presentation failure/);
    assert.deepEqual(delivery, ["prepare", "write", "mark"]); assert.equal(cliPrepares, 3);
    assert.equal(faux.getPendingResponseCount(), 0); assert.deepEqual(modelErrors, []);
    console.log("[support-session] CLI fixed-card recovery, fresh ingress and delivery failure without retry PASS");
  } finally { cliSession.dispose(); }
} finally {
  session.dispose();
}

{
  // Actual Pi tool callback with deterministic business delays; no remote model.
  const seenCalls: SupportCall[] = [], writes: Array<string | undefined> = [];
  let mode: "normal" | "cancel-read" | "cancel-write" | "late-failure" = "normal", persisted: string | undefined;
  let rejectOld: ((error: Error) => void) | undefined;
  let raceSession: Awaited<ReturnType<typeof createSupportSession>>;
  const raceStore = { getOrder: async (_identity: QQIdentity, id: string) => {
    if (mode === "cancel-read") { cancelSupportTurn(raceSession); void raceSession.abort(); }
    if (mode === "late-failure" && id === orderId) return new Promise<ReturnType<typeof makeOrder>>((_resolve, reject) => { rejectOld = reject; });
    return makeOrder(id);
  }, searchKnowledge: async () => [] } as unknown as CouponStore;
  raceSession = await createSupportSession(identity, raceStore, runtime, faux.getModel(), undefined, {
    groupOpenid: group, focus: { read: async () => persisted, write: async id => {
      if (id && mode === "cancel-write") { cancelSupportTurn(raceSession); void raceSession.abort(); }
      // This commit already started; cancellation cannot claim to undo it.
      writes.push(id); persisted = id;
    } },
  });
  const raceModelErrors: unknown[] = [];
  raceSession.subscribe(event => {
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") raceModelErrors.push(event.message.errorMessage);
  });
  const select = (id: string): FauxResponseStep => () => fauxAssistantMessage(fauxToolCall("support_action", {
    action: { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: id } },
  }), { stopReason: "toolUse" });
  const prompt = async (requestId: string, text: string, responses: FauxResponseStep[]) => {
    prepareSupportPrompt(raceSession, { requestId, groupOpenid: group, messageId: requestId, onCall: call => seenCalls.push(call) });
    const before = raceModelErrors.length;
    faux.setResponses(responses); await raceSession.prompt(text, { expandPromptTemplates: false });
    const errors = raceModelErrors.slice(before);
    if (mode === "cancel-read" || mode === "cancel-write") assert.ok(errors.every(error => error === "This operation was aborted"));
    else assert.deepEqual(errors, []);
  };
  try {
    mode = "cancel-read";
    await prompt("cancel-read", `查询 ${orderId}`, [select(orderId)]);
    assert.equal(getSupportResult(raceSession), undefined); assert.equal(supportReply(raceSession)?.kind, "notice");
    assert.ok(!writes.includes(orderId), "canceled read must never start a focus write");
    assert.equal(seenCalls.at(-1)!.name, "get_order"); assert.equal(seenCalls.at(-1)!.isError, false);
    mode = "normal";
    await prompt("after-cancel", `查询 ${otherId}`, [context => {
      const host = hostReference(context); assert.equal(host?.orderId, null); assert.equal(host?.itemPaidUnit, null);
      assert.equal(host?.policyTopic, null); assert.equal(host?.alternativeOrderId, null);
      return fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: otherId } } }), { stopReason: "toolUse" });
    }, () => fauxAssistantMessage("查询完成。")]);
    assert.equal(getSupportResult(raceSession)?.verifiedOrderId, otherId);
    const completed = getSupportResult(raceSession);
    cancelSupportTurn(raceSession);
    assert.equal(getSupportResult(raceSession), completed, "cancellation preserves a host receipt published before cancellation");

    mode = "cancel-write";
    await prompt("cancel-write", `查询 ${orderId}`, [select(orderId)]);
    assert.equal(persisted, orderId, "a write started before cancellation may already have committed");
    assert.equal(getSupportResult(raceSession), undefined); assert.equal(supportReply(raceSession)?.kind, "notice");
    mode = "normal";
    await prompt("after-write-cancel", "你好", [context => {
      const host = hostReference(context); assert.equal(host?.itemPaidUnit, null); assert.equal(host?.policyTopic, null);
      return fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "non_business", reason: "greeting" } }), { stopReason: "toolUse" });
    }, () => fauxAssistantMessage("你好。")]);

    // Keep an old actual tool invocation pending while a new Pi turn succeeds.
    await prompt("old-pending", `查询 ${orderId}`, [() => fauxAssistantMessage("待处理。")]);
    mode = "late-failure";
    const tool = raceSession.agent.state.tools.find(tool => tool.name === "support_action")!;
    const old = tool.execute("old-tool", { action: { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId } } }, new AbortController().signal).catch(error => error);
    assert.ok(rejectOld);
    await prompt("new-success", `查询 ${otherId}`, [select(otherId), () => fauxAssistantMessage("完成。")]);
    const latest = getSupportResult(raceSession)!; assert.equal(latest.verifiedAmountReference?.requestId, "new-success");
    rejectOld(new Error("old read failed after the next turn")); await old;
    assert.equal(getSupportResult(raceSession), latest, "old failure must not replace the new result");
    mode = "normal";
    await prompt("check-new-reference", "你好", [context => {
      assert.equal(hostReference(context)?.itemPaidUnit?.requestId, "new-success", "old failure must not clear the new amount reference");
      return fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "non_business", reason: "greeting" } }), { stopReason: "toolUse" });
    }, () => fauxAssistantMessage("你好。")]);
  } finally { raceSession.dispose(); }
}
console.log("[support-session] canceled reads/writes suppress cards and new references; late old failure preserves the new turn PASS");
await (await import("./support-tool-choice-check.ts")).checkSupportToolChoice();
