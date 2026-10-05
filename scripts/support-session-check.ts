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
import { createSupportSession, getSupportResult, isSupportSession, prepareSupportPrompt, readSupportArchitecture, supportReply,
  type SupportFocus } from "../src/support-session.ts";
import type { SupportAction } from "../src/support-action.ts";
import type { SupportCall } from "../src/support-controller.ts";

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
function observe(context: TranscriptContext, expectedFocus?: string | null) {
  // Pi converts callback assertions into model errors; save them for independent assertions after each turn.
  try {
    assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name), ["support_action"]);
    if (expectedFocus !== undefined) {
      const reference = context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
        : message.content.filter(part => part.type === "text").map(part => part.text))
        .map(text => { try { return JSON.parse(text) as { kind?: string; orderId?: string | null }; } catch { return {}; } })
        .filter(value => value.kind === "host_order_reference").at(-1);
      assert.equal(reference?.orderId, expectedFocus, "before_agent_start must inject the current host reference");
    }
  } catch (error) { modelErrors.push(error); }
}
const choose = (action: SupportAction, expectedFocus?: string | null): FauxResponseStep => (context, _options, _state, model) => {
  observe(context, expectedFocus);
  try { assert.equal(model.maxTokens, 2048); } catch (error) { modelErrors.push(error); }
  return fauxAssistantMessage(fauxToolCall("support_action", { action }), { stopReason: "toolUse" });
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

  const beforePrepare = prepares;
  const duplicate = { kind: "refund_prepare" as const, orderRef: explicit() };
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
  console.log("[support-session] duplicate action executes once and conflicts cannot add mutations PASS");

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
  const beforeReasonRepair = prepares, beforeReasonCalls = calls.length;
  const reasonRepair = await run(`请给 ${orderId} 生成退款方案。`, [
    fauxAssistantMessage(fauxToolCall("support_action", { action: { kind: "refund_prepare", orderRef: explicit(), reason: "行程变化" } }), { stopReason: "toolUse" }),
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
