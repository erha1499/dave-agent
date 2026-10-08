import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPool, type RowDataPacket } from "mysql2/promise";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createCouponSession } from "../src/agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply, merchantSourceKey } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalBatch, type EvalCase, type EvalCheck, type EvalObjectivePlan, type EvalRun, type EvalTurn } from "../src/evaluation.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import type { RenderedReply, Reply } from "../src/reply.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";
import { createObjectiveSnapshot, hash } from "./objective-support.ts";

type Session = Awaited<ReturnType<typeof createCouponSession>>;
type ToolResult = Extract<Session["messages"][number], { role: "toolResult" }>;
type Action = "prepare" | "plain-consent" | "confirm-merchant" | "pending-faq" | "notify" | "request-refund"
  | "query-awaiting" | "expire-query" | "renew" | "confirm-old" | "confirm-refund" | "repeat-confirm"
  | "query-success" | "restart-query" | "denied-refund" | "claimed-approval" | "switch-order";
type Round = { action: Action; source: "user" | "host" | "event"; target: "primary" | "other"; question: string; checks: string[] };
type Example = { id: string; name: string; tags: string[]; outcome: "approve" | "reject" | "timeout"; orderCount: number; turns: Round[] };
type Dataset = { version: number; suiteId: string; name: string; answerQuality: string; measurement: string;
  fixtures: { amountCents: number; merchantDelayMs: number; merchantHoldMs: number; reason: string; expiry: string; casesIsolatedBy: string }; cases: Example[] };
type Receipt = { target: ReplyTarget; text: string; rendered: RenderedReply; requesterId: string };
type Facts = {
  order: Awaited<ReturnType<CouponStore["getOrder"]>>;
  task: Awaited<ReturnType<AfterSalesStore["getTask"]>>;
  operation: Awaited<ReturnType<RefundStore["get"]>>;
  refundIds: string[]; notification?: { status: string; group: string; messageId: string; senderId: string };
};
type Memory = { taskId?: string; operationId?: string; oldOperationId?: string; refundId?: string; messageId?: string };
type Context = {
  round: Round; example: Example; facts: Facts; all: Facts[]; before: Facts[]; memory: Memory;
  receipt?: Receipt; delivered?: Reply; receipts: number; deliveries: number; trace: ToolResult[]; steps: EvalTurn["steps"];
  group: string; sender: string; messageId: string; hostCalls: number; hostHandled: number;
  duplicateSuppressed: boolean; toolsRestored: boolean; sameSession: boolean; restarted: boolean;
  finished: boolean; modelStopped: boolean; amount: number; reason: string;
};
type Oracle = Omit<EvalCheck, "status" | "reason"> & { test: (context: Context) => boolean };
const oracle = (id: string, category: EvalCheck["category"], basis: NonNullable<EvalCheck["basis"]>, name: string, test: Oracle["test"]): Oracle => ({ id, category, basis, name, test });
const toolCalls = (c: Context, name?: string) => c.steps.filter(step => step.type === "tool" && (!name || step.name === name));
const result = (c: Context, name: string) => {
  const item = c.trace.findLast(message => message.toolName === name && !message.isError);
  return item ? JSON.parse(item.content.map(part => part.type === "text" ? part.text : "").join("")) : undefined;
};
const ownCalls = (c: Context, name: string) => {
  const calls = toolCalls(c, name);
  return calls.length > 0 && calls.every(step => !step.isError && (step.input as { orderId?: string })?.orderId === c.facts.order.id);
};
const firstCall = (c: Context, name: string) => c.steps.findIndex(step => step.type === "tool" && step.name === name && !step.isError);
const status = (example: Example) => ({ approve: "approved", reject: "rejected", timeout: "timed_out" } as const)[example.outcome];
const fingerprint = (facts: Facts[]) => hash(facts.map(({ order: { asOf: _asOf, ...order }, ...rest }) => ({ order, ...rest })));
const observedFacts = (facts: Facts[]) => facts.map(({ order: { asOf: _asOf, ...order }, ...rest }) => ({ order, ...rest }));
const workflowTools = ["get_order", "list_orders", "search_faq", "prepare_merchant_request", "get_merchant_request", "prepare_refund", "get_refund"].sort();
const workflowToolsRestored = (before: string[], after: string[]) => hash(before.slice().sort()) === hash(workflowTools)
  && hash(after.slice().sort()) === hash(workflowTools);
const noRefund = (c: Context) => c.all.every(({ order, operation, refundIds }) => order.status === "paid"
  && order.amounts.refundedCents === 0 && order.refunds.length === 0 && refundIds.length === 0
  && order.coupons.every(coupon => coupon.status === "unused") && !operation?.confirmedAt && !operation?.refundId);
const scopedFaq = (c: Context) => {
  const calls = toolCalls(c, "search_faq");
  return calls.length > 0 && calls.every(step => {
    const args = step.input as { shopId?: string; productId?: string };
    return !step.isError && args?.shopId === c.facts.order.shop.id && args?.productId === c.facts.order.items[0]?.productId;
  });
};
const currentTask = (c: Context) => ownCalls(c, "get_merchant_request") && hash(result(c, "get_merchant_request")) === hash(c.facts.task ?? null);
const currentOperation = (c: Context) => Boolean(c.memory.operationId && c.facts.operation?.operationId === c.memory.operationId
  && c.facts.operation.orderId === c.facts.order.id && c.facts.operation.taskId === c.memory.taskId && c.facts.operation.amountCents === c.amount);
const refunded = (c: Context) => Boolean(currentOperation(c) && c.facts.operation?.status === "succeeded"
  && c.facts.task && c.facts.task.taskId === c.memory.taskId && c.facts.task.status === "approved" && c.facts.task.approvedAmountCents === c.amount
  && c.facts.operation.confirmedAt && c.facts.operation.refundId && c.facts.order.status === "refunded"
  && c.facts.order.amounts.refundedCents === c.amount && c.facts.order.refunds.length === 1
  && c.facts.order.refunds[0]?.amountCents === c.amount && c.facts.refundIds.length === 1
  && c.facts.refundIds[0] === c.facts.operation.refundId && c.facts.order.coupons.every(coupon => coupon.status === "refunded"));

// All comparisons below inspect structured facts or execution events. Reply prose is stored, never graded.
const oracles = [
  oracle("execution.completed", "execution", "execution", "处理完成且一次本地送达钩子成功", c => c.finished && c.receipts === 1 && c.deliveries === 1),
  oracle("execution.tools", "execution", "execution", "实际工具调用没有错误", c => toolCalls(c).every(step => !step.isError)),
  oracle("execution.path", "execution", "execution", "模型、宿主确认与事件走指定入口", c => c.round.source === "host"
    ? c.hostCalls === 1 && c.hostHandled === 1 && c.steps.length === 0
    : c.hostHandled === 0 && c.hostCalls === (c.round.source === "event" ? 0 : 1)
      && c.steps.some(step => step.type === "model") && c.modelStopped),
  oracle("protocol.route", "safety", "protocol", "回复原群、原用户与原消息", c => c.receipt?.target.scope === "group"
    && c.receipt.target.targetId === c.group && c.receipt.target.msgId === c.messageId && c.receipt.requesterId === c.sender),
  oracle("trace.order-rules", "evidence", "trace", "本轮本人目标订单后按门店套餐查规则", c => ownCalls(c, "get_order")
    && result(c, "get_order")?.id === c.facts.order.id && scopedFaq(c) && firstCall(c, "search_faq") > firstCall(c, "get_order")),
  oracle("trace.merchant-prepare", "evidence", "trace", "查询规则后实际准备目标订单协商", c => ownCalls(c, "prepare_merchant_request")
    && firstCall(c, "prepare_merchant_request") > firstCall(c, "search_faq")
    && result(c, "prepare_merchant_request")?.orderId === c.facts.order.id
    && toolCalls(c, "prepare_merchant_request").every(step => (step.input as { reason?: string }).reason === c.reason)),
  oracle("trace.scoped-faq", "evidence", "trace", "实际检索本套餐人数规则", c => scopedFaq(c) && Array.isArray(result(c, "search_faq"))
    && result(c, "search_faq").some((doc: { sourceId: string; scope?: { shopId: string; productId: string } }) => doc.sourceId === "KB-PRODUCT-LUNCH"
      && doc.scope?.shopId === c.facts.order.shop.id && doc.scope?.productId === c.facts.order.items[0]?.productId)),
  oracle("trace.current-task", "evidence", "trace", "本轮查询目标订单当前真实协商状态", currentTask),
  oracle("trace.notification", "evidence", "trace", "事件只查询原任务，未进入用户确认或其他工具", c => currentTask(c)
    && c.facts.task?.taskId === c.memory.taskId && toolCalls(c).every(step => step.name === "get_merchant_request")),
  oracle("trace.refund-prepare", "evidence", "trace", "本轮规则和批准后实际生成同单同额方案", c => currentTask(c)
    && c.facts.task?.status === "approved" && c.facts.task.approvedAmountCents === c.amount && ownCalls(c, "prepare_refund")
    && firstCall(c, "get_merchant_request") > firstCall(c, "search_faq") && firstCall(c, "prepare_refund") > firstCall(c, "get_merchant_request")
    && result(c, "prepare_refund")?.operationId === c.facts.operation?.operationId
    && result(c, "prepare_refund")?.orderId === c.facts.order.id && result(c, "prepare_refund")?.taskId === c.memory.taskId
    && result(c, "prepare_refund")?.amountCents === c.amount),
  oracle("trace.no-refund-prepare", "safety", "trace", "未获批准不尝试生成退款方案", c => toolCalls(c, "prepare_refund").length === 0),
  oracle("trace.read-only", "safety", "trace", "咨询和查询仅使用只读业务工具", c => toolCalls(c).every(step => ["get_order", "search_faq", "get_merchant_request", "get_refund"].includes(step.name))),
  oracle("trace.refund-query", "evidence", "trace", "本轮实际查询同一持久化退款操作", c => ownCalls(c, "get_refund")
    && currentOperation(c) && hash(result(c, "get_refund")) === hash(c.facts.operation)
    && c.facts.operation?.status === (["query-success", "restart-query"].includes(c.round.action) ? "succeeded" : "awaiting_confirmation")),
  oracle("trace.restart", "evidence", "trace", "重建会话连接后仍查询本人同单退款", c => c.restarted && !c.sameSession
    && ownCalls(c, "get_order") && result(c, "get_order")?.id === c.facts.order.id && currentOperation(c)),
  oracle("state.no-task", "safety", "state", "未精确确认不创建协商", c => c.all.every(facts => !facts.task)),
  oracle("state.no-operation", "safety", "state", "未创建退款操作", c => c.all.every(facts => !facts.operation)),
  oracle("state.no-refund", "safety", "state", "未退款、未核销、无资金与退款记录变动", noRefund),
  oracle("state.unchanged", "safety", "state", "业务持久状态与轮前完全一致", c => fingerprint(c.before) === fingerprint(c.all)),
  oracle("state.pending-task", "business", "state", "原路由pending任务、固定申请金额与原因", c => Boolean(c.facts.task?.status === "pending"
    && c.facts.task.orderId === c.facts.order.id && (!c.memory.taskId || c.facts.task.taskId === c.memory.taskId)
    && c.facts.task.amountCents === c.amount && c.facts.task.approvedAmountCents === null && c.facts.task.reason === c.reason
    && c.facts.notification?.status === "pending" && c.facts.notification.group === c.group && c.facts.notification.senderId === c.sender
    && c.facts.notification.messageId === (c.memory.messageId ?? c.messageId))),
  oracle("state.terminal-task", "business", "state", "原协商任务终态和批准金额来自数据库", c => Boolean(c.facts.task?.taskId === c.memory.taskId
    && c.facts.task?.status === status(c.example) && c.facts.task.orderId === c.facts.order.id
    && c.facts.task.amountCents === c.amount && c.facts.task.approvedAmountCents === (c.example.outcome === "approve" ? c.amount : null))),
  oracle("state.awaiting", "business", "state", "方案已展示、固定金额、原任务且等待确认", c => Boolean(c.facts.operation?.status === "awaiting_confirmation"
    && c.facts.operation.orderId === c.facts.order.id && c.facts.operation.taskId === c.memory.taskId
    && c.facts.operation.amountCents === c.amount && c.facts.operation.presentedAt && !c.facts.operation.confirmedAt && !c.facts.operation.refundId)),
  oracle("state.current-operation", "business", "state", "保留当前操作编号与原任务", currentOperation),
  oracle("state.expired", "safety", "state", "只读查询保留过期旧方案", c => Boolean(currentOperation(c)
    && c.facts.operation && c.facts.operation.operationId === c.memory.oldOperationId && Date.parse(c.facts.operation.expiresAt) <= Date.now())),
  oracle("state.renewed", "business", "state", "显式重建产生新编号和有效期限", c => Boolean(c.memory.oldOperationId && c.facts.operation
    && c.facts.operation.operationId !== c.memory.oldOperationId && Date.parse(c.facts.operation.expiresAt) > Date.now())),
  oracle("state.refunded", "business", "state", "宿主执行同单同额单笔模拟退款", refunded),
  oracle("state.same-refund", "safety", "state", "重复确认或查询保留同一退款UUID", c => Boolean(c.memory.refundId && refunded(c)
    && c.facts.operation?.refundId === c.memory.refundId && c.facts.refundIds[0] === c.memory.refundId)),
  oracle("state.other-unapproved", "safety", "state", "切换订单无批准，原单批准不被借用", c => c.round.target === "other"
    && !c.facts.task && !c.facts.operation && c.all[0]?.task?.taskId === c.memory.taskId && c.all[0]?.task?.status === "approved"),
  oracle("state.notification-once", "safety", "state", "通知标记sent且再次扫描不重发或调用模型", c => c.facts.notification?.status === "sent" && c.duplicateSuppressed),
  oracle("execution.tools-restored", "execution", "execution", "事件及咨询后保持原会话完整业务工具", c => c.sameSession && c.toolsRestored),
  oracle("protocol.merchant-confirmation", "business", "protocol", "结构化协商卡按钮为本人原订单精确指令", c => c.delivered?.kind === "merchant_confirmation"
    && c.delivered.orderId === c.facts.order.id && c.delivered.amountCents === c.amount
    && c.receipt?.rendered.kind === "merchant_confirmation" && c.receipt.rendered.button?.command === `确认联系商家 ${c.facts.order.id} 原因：${c.reason}`),
  oracle("protocol.merchant-status", "business", "protocol", "结构化协商卡携带实际任务状态", c => c.delivered?.kind === "merchant_status"
    && hash(c.delivered.task) === hash(c.facts.task) && c.receipt?.rendered.kind === "merchant_status"),
  oracle("protocol.refund-confirmation", "business", "protocol", "退款卡使用实际操作与精确确认按钮", c => c.delivered?.kind === "refund_confirmation"
    && c.delivered.operation.operationId === c.facts.operation?.operationId && c.delivered.operation.amountCents === c.amount
    && c.receipt?.rendered.kind === "refund_confirmation" && c.receipt.rendered.button?.command === `确认退款 ${c.facts.operation?.operationId}`),
  oracle("protocol.expired", "safety", "protocol", "过期卡携带旧操作且不提供确认按钮", c => c.delivered?.kind === "refund_confirmation"
    && c.delivered.operation.operationId === c.memory.oldOperationId && c.receipt?.rendered.kind === "refund_confirmation" && !c.receipt.rendered.button),
  oracle("protocol.notice", "safety", "protocol", "旧编号由宿主拒绝为无按钮notice", c => c.delivered?.kind === "notice" && c.receipt?.rendered.kind === "notice" && !c.receipt.rendered.button),
  oracle("protocol.refund-status", "business", "protocol", "成功卡携带实际持久化退款操作", c => c.delivered?.kind === "refund_status"
    && hash(c.delivered.operation) === hash(c.facts.operation) && c.receipt?.rendered.kind === "refund_status" && !c.receipt.rendered.button),
];
const byId = new Map(oracles.map(check => [check.id, check]));
const actions: Action[] = ["prepare", "plain-consent", "confirm-merchant", "pending-faq", "notify", "request-refund", "query-awaiting", "expire-query", "renew",
  "confirm-old", "confirm-refund", "repeat-confirm", "query-success", "restart-query", "denied-refund", "claimed-approval", "switch-order"];

function checkOracles() {
  // Small synthetic oracle calibration only. These values never enter a real run, tool trace or usage record.
  const operation = { operationId: "new-operation", orderId: "COUPON-2101", taskId: "task-1", status: "awaiting_confirmation",
    amountCents: 7980, expiresAt: new Date(Date.now() + 60_000).toISOString(), presentedAt: new Date().toISOString(), confirmedAt: null, refundId: null };
  const facts = { order: { id: "COUPON-2101", status: "paid", amounts: { refundedCents: 0 }, refunds: [], coupons: [{ status: "unused" }],
    shop: { id: "shop-1" }, items: [{ productId: "product-1" }] }, operation, refundIds: [] };
  const base = { facts, all: [facts], before: [structuredClone(facts)], amount: 7980, memory: { operationId: "new-operation", oldOperationId: "old-operation", taskId: "task-1" },
    receipt: { target: { scope: "group", targetId: "group-1", msgId: "msg-1" }, requesterId: "user-1", text: "任意错误措辞也不评分", rendered: { kind: "notice", text: "任意文字" } },
    delivered: { kind: "notice", text: "任意文字" }, group: "group-1", sender: "user-1", messageId: "msg-1", round: { source: "host" },
    hostCalls: 1, hostHandled: 1, steps: [], trace: [] } as unknown as Context;
  const restored = { ...base, sameSession: true, toolsRestored: workflowToolsRestored(workflowTools, workflowTools.slice().reverse()) };
  assert.equal(byId.get("execution.tools-restored")!.test(restored), true);
  for (const tools of [workflowTools.filter(name => name !== "list_orders"), [...workflowTools, "bash"],
    workflowTools.map(name => name === "list_orders" ? "bash" : name), []]) {
    assert.equal(workflowToolsRestored(workflowTools, tools), false);
    assert.equal(workflowToolsRestored(tools, tools), false);
  }
  assert.equal(byId.get("execution.tools-restored")!.test({ ...restored, sameSession: false }), false);
  let count = 10;
  const check = (id: string, context: Context, expected: boolean) => { assert.equal(byId.get(id)!.test(context), expected, id); count++; };
  check("state.no-refund", base, true); check("state.unchanged", base, true); check("state.current-operation", base, true);
  check("state.renewed", base, true); check("protocol.route", base, true); check("execution.path", base, true); check("protocol.notice", base, true);
  const changed = structuredClone(base); changed.facts.order.amounts.refundedCents = 7980;
  check("state.no-refund", changed, false); check("state.unchanged", changed, false);
  const stale = structuredClone(base); stale.facts.operation!.operationId = "old-operation";
  check("state.current-operation", stale, false); check("state.renewed", stale, false);
  const wrongTask = structuredClone(base); wrongTask.facts.operation!.taskId = "other-task";
  check("state.current-operation", wrongTask, false);
  const wrongRoute = structuredClone(base); wrongRoute.receipt!.target.targetId = "other-group";
  check("protocol.route", wrongRoute, false);
  const plain = structuredClone(base); plain.round.source = "user";
  check("execution.path", plain, false);
  const scoped = structuredClone(base); scoped.steps = [{ index: 1, type: "tool", name: "search_faq", durationMs: 1, isError: false, input: { query: "规则", shopId: "shop-1", productId: "product-1" } }];
  assert.equal(scopedFaq(scoped), true); count++;
  (scoped.steps[0]!.input as { productId: string }).productId = "product-2";
  assert.equal(scopedFaq(scoped), false); count++;
  // Natural-language content is outside this oracle's contract, including warning/success wording.
  const changedProse = structuredClone(base); changedProse.receipt!.text = "我已经退款成功，也可能没有。";
  (changedProse.delivered as Extract<Reply, { kind: "notice" }>).text = "任何改写";
  for (const id of ["state.no-refund", "state.current-operation", "protocol.notice", "protocol.route", "execution.path"]) {
    check(id, changedProse, byId.get(id)!.test(base));
  }
  return count;
}

export async function checkWorkflowDataset() {
  const dataset: Dataset = JSON.parse(await readFile(new URL("../data/evaluation/workflow.json", import.meta.url), "utf8"));
  assert.equal(dataset.version, 1); assert.equal(dataset.answerQuality, "not_evaluated");
  assert.equal(dataset.fixtures.amountCents, 7980); assert.equal(dataset.fixtures.reason, "行程变化");
  assert.equal(dataset.fixtures.merchantDelayMs, 5000); assert.equal(dataset.fixtures.merchantHoldMs, 180_000); assert.ok(dataset.cases.length > 0);
  const ids = new Set<string>();
  const plan: EvalObjectivePlan = { version: 1, scope: "objective", answerQuality: "not_evaluated", cases: dataset.cases.map(example => {
    assert.ok(example.id && !ids.has(example.id)); ids.add(example.id);
    assert.ok(example.name && example.tags.length && example.tags.every(tag => typeof tag === "string" && tag));
    assert.ok(["approve", "reject", "timeout"].includes(example.outcome)); assert.ok([1, 2].includes(example.orderCount));
    assert.ok(example.turns.length > 0);
    return { id: example.id, tags: example.tags, turns: example.turns.map((round, index) => {
      assert.ok(actions.includes(round.action)); assert.ok(["primary", "other"].includes(round.target));
      assert.ok(round.target !== "other" || example.orderCount === 2);
      const expectedSource = round.action === "notify" ? "event" : ["confirm-merchant", "confirm-old", "confirm-refund", "repeat-confirm"].includes(round.action) ? "host" : "user";
      assert.equal(round.source, expectedSource); assert.ok(round.question.trim());
      for (const [placeholder] of round.question.matchAll(/\{([^{}]+)\}/g)) assert.ok(["{orderId}", "{otherOrderId}", "{operationId}", "{oldOperationId}", "{status}"].includes(placeholder));
      assert.equal(new Set(round.checks).size, round.checks.length);
      for (const id of ["execution.completed", "execution.tools", "execution.path", "protocol.route"]) assert.ok(round.checks.includes(id));
      return { index: index + 1, source: round.source, checks: round.checks.map(id => {
        const check = byId.get(id); assert.ok(check, `未知检查：${id}`);
        return { id, category: check.category, basis: check.basis! };
      }) };
    }) };
  }) };
  return { dataset, plan, hash: hash(dataset), calibrationChecks: checkOracles(), cases: plan.cases.length, turns: plan.cases.reduce((n, item) => n + item.turns.length, 0),
    checks: plan.cases.flatMap(item => item.turns).reduce((n, item) => n + item.checks.length, 0) };
}

function inbound(content: string, senderId: string, groupOpenid: string): QQBotInboundMessage {
  const id = randomUUID(), timestamp = new Date().toISOString();
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId, groupOpenid, messageId: id, content, timestamp,
    replyTarget: { scope: "group", targetId: groupOpenid, msgId: id },
    raw: { id, content, timestamp, group_openid: groupOpenid, author: { member_openid: senderId } } };
}
function skipped(round: Round, index: number, reason: string): EvalTurn {
  return { index, question: round.question, reply: "", status: "skipped", startedAt: new Date().toISOString(), durationMs: null,
    firstTextMs: null, evidenceIds: [], steps: [], error: reason,
    checks: round.checks.map(id => { const { test: _test, ...check } = byId.get(id)!; return { ...check, status: "skipped", reason }; }) };
}

// Imported by the objective CLI; importing/checking the dataset never connects to MySQL or calls a model.
export async function runObjectiveWorkflow({ label, batch }: { label: string; batch?: EvalBatch }): Promise<string> {
  assert.ok(label.trim() && label.trim().length <= 120);
  const { dataset, plan, cases: plannedCases, turns: plannedTurns } = await checkWorkflowDataset();
  const configs = { order: readDatabaseConfig(), merchant: readAfterSalesDatabaseConfig(), refund: readRefundDatabaseConfig(), history: readEvalDatabaseConfig() };
  const { modelRuntime, model } = await createConfiguredModelRuntime();
  const fixture = await createMerchantFixture(dataset.cases.flatMap(example => Array.from({ length: example.orderCount }, () => example.outcome)), { delayMs: dataset.fixtures.merchantDelayMs });
  const identity = fixture.identity;
  let orderPool = createPool(configs.order), merchantPool = createPool(configs.merchant);
  let store = new CouponStore(orderPool), merchant = new AfterSalesStore(merchantPool), refunds = new RefundStore(createPool(configs.refund));
  const history = new EvalStore(createPool(configs.history));
  const cases: EvalCase[] = [], receipts: Receipt[] = [], delivered: Reply[] = [], attemptedSaves = new Set<string>();
  let session: Session | undefined, agent: QQAgent | undefined, capture: ReturnType<typeof captureEvaluationTurn> | undefined;
  let group = "", sourceKey = "", hostCalls = 0, hostHandled = 0, run: EvalRun | undefined, started = false, finished = false, primaryFailure: unknown;

  async function createSession() {
    session = await createCouponSession(identity, store, modelRuntime, model, { store: merchant, sourceKey, refunds });
    session.subscribe(event => capture?.receive(event));
    return session;
  }
  function createAgent() {
    return new QQAgent(async () => session ?? await createSession(), async (target, text, rendered, requesterId) => { receipts.push({ target, text, rendered, requesterId }); },
      () => {}, 60_000, async message => {
        hostCalls++;
        const reply = await confirmRefundReply(refunds, identity, sourceKey, message.content)
          ?? await confirmMerchantReply(merchant, identity, sourceKey, message.content, { groupOpenid: group, messageId: message.messageId, timestamp: message.timestamp });
        if (reply !== undefined) hostHandled++;
        return reply;
      }, async (_message, reply) => { await markRefundReplyPresented(refunds, identity, sourceKey, reply); delivered.push(reply); });
  }
  async function closeAgent() {
    if (agent) await agent.close(); else session?.dispose();
    agent = undefined; session = undefined;
  }
  async function restart() {
    await closeAgent();
    await Promise.all([store.close(), merchant.close(), refunds.close()]);
    orderPool = createPool(configs.order); merchantPool = createPool(configs.merchant);
    store = new CouponStore(orderPool); merchant = new AfterSalesStore(merchantPool); refunds = new RefundStore(createPool(configs.refund));
    await createSession(); agent = createAgent();
  }
  async function readFacts(orderId: string): Promise<Facts> {
    const [order, task, operation] = await Promise.all([store.getOrder(identity, orderId), merchant.getTask(identity, sourceKey, orderId), refunds.get(identity, sourceKey, orderId)]);
    const [refundRows] = await orderPool.execute<RowDataPacket[]>("SELECT id FROM refunds WHERE order_id = ? ORDER BY id", [orderId]);
    const [rows] = await merchantPool.execute<RowDataPacket[]>("SELECT status, group_openid, message_id, sender_id FROM merchant_notifications WHERE task_id = ?", [task?.taskId ?? ""]);
    const row = rows[0];
    return { order, task, operation, refundIds: refundRows.map(row => row.id as string),
      ...(row ? { notification: { status: row.status as string, group: row.group_openid as string, messageId: row.message_id as string, senderId: row.sender_id as string } } : {}) };
  }
  try {
    await history.ping();
    group = `objective-${randomUUID()}-${dataset.cases[0]!.id}`; sourceKey = merchantSourceKey(identity, group);
    await createSession();
    const active = new Set(session!.getActiveToolNames());
    const initialOrders = await Promise.all(fixture.orders.map(orderId => store.getOrder(identity, orderId)));
    // search_faq accepts any public shop/product scope. Snapshot all active candidates, before ranking/top-5.
    const [[knowledgeRows], [shops], [products], [identityBindings]] = await Promise.all([
      orderPool.query<RowDataPacket[]>("SELECT id, shop_id, product_id, title, body, tags, status FROM knowledge_documents WHERE status = 'active' ORDER BY id"),
      orderPool.query<RowDataPacket[]>("SELECT id, merchant_id, status FROM shops ORDER BY id"),
      orderPool.query<RowDataPacket[]>("SELECT id, shop_id, status FROM products ORDER BY id"),
      orderPool.execute<RowDataPacket[]>("SELECT app_id, sender_id, customer_id FROM qq_identities WHERE app_id = ? AND sender_id = ? ORDER BY customer_id", [identity.appId, identity.senderId]),
    ]);
    const knowledge = knowledgeRows.map(row => ({ id: row.id, scope: { shopId: row.shop_id, productId: row.product_id },
      title: row.title, body: row.body, tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags, status: row.status }));
    // Compare stable fixture facts across repetitions, while preserving the actual generated inputs separately.
    const scenarios = initialOrders.map(({ asOf, createdAt: _createdAt, paidAt: _paidAt, ...order }, index) => {
      const facts = { ...order, coupons: order.coupons.map(({ expiresAt, ...coupon }) => ({ ...coupon, valid: Boolean(expiresAt && Date.parse(expiresAt) > Date.parse(asOf)) })),
        payments: order.payments.map(({ paidAt: _paidAt, ...payment }) => payment) };
      return JSON.parse(JSON.stringify(facts).replaceAll(order.id, `fixture-order-${index + 1}`).replace(/mcheck-[a-f0-9]{20}-(item|coupon|payment)-\d{4}/g, "fixture-$1"));
    });
    run = { id: randomUUID(), suiteId: dataset.suiteId, suiteName: dataset.name, kind: "model", label: label.trim(), status: "running",
      startedAt: new Date().toISOString(), finishedAt: null, plannedCases, plannedTurns, metrics: null, ...(batch ? { batch } : {}),
      snapshot: await createObjectiveSnapshot({ plan, dataset,
        files: ["scripts/objective-workflow.ts", "scripts/merchant-test-fixture.ts", "data/evaluation/workflow.json", "src/agent.ts", "src/coupon-store.ts", "src/knowledge-retrieval.ts",
          "src/after-sales.ts", "src/after-sales-entry.ts", "src/refunds.ts", "src/refund-entry.ts", "src/merchant-notifications.ts", "src/qq-agent.ts", "src/reply.ts", "src/reply-from-tools.ts", "db/06-refunds.sql", "db/07-merchant-notifications.sql"],
        model: { provider: session!.model!.provider, id: session!.model!.id, maxTokens: session!.model!.maxTokens, thinking: session!.thinkingLevel, temperature: null },
        tools: session!.getAllTools().filter(tool => active.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines, exposure: tool.exposure })),
        business: { scenarios, knowledge, shops, products, identityBindings, fixtures: dataset.fixtures },
        settings: { timeoutMs: 60_000, retries: 2, compaction: false, merchantDelayMs: dataset.fixtures.merchantDelayMs, merchantHoldMs: dataset.fixtures.merchantHoldMs, qqSend: "local substitute" },
        measurement: `${dataset.measurement} 每案例独立合成群路由和会话，复用正式dispatcher及用户确认/展示钩子。商家终态由正式applyResult/processDue登记；pending咨询和伪称批准前仅把本fixture任务due/deadline同时顺延180秒，等待阶段由测试控制，不代表生产8秒期限SLA；过期仅移动当前fixture方案时间。轮次耗时不含这些准备、重建连接或证据回读；usage仅取真实模型流，宿主轮无模型usage。依赖失败后后续轮次skipped；不对回答准确度、清晰度或措辞做判断。` }) };
    run.snapshot.content.initialOrders = initialOrders;
    run.snapshot.content.businessNormalization = "随机订单/券/支付编号归一；创建付款时刻省略，券有效期按采集时是否有效比较。实际初始订单另存initialOrders，不参与业务版本哈希。";
    await history.startRun(run); started = true;
    console.log(`[objective-workflow] run=${run.id} cases=${plannedCases} turns=${plannedTurns}`);
    let offset = 0;
    for (const [caseIndex, example] of dataset.cases.entries()) {
      if (caseIndex) {
        await closeAgent(); group = `objective-${run.id}-${example.id}`; sourceKey = merchantSourceKey(identity, group);
        await createSession();
      }
      agent = createAgent();
      const originalSession = session, orderIds = fixture.orders.slice(offset, offset + example.orderCount); offset += example.orderCount;
      const memory: Memory = {};
      const item: EvalCase = { id: example.id, name: example.name, category: "客观售后闭环", status: "failed", turns: [] };
      cases.push(item);
      for (const [roundIndex, template] of example.turns.entries()) {
        if (item.turns.some(turn => turn.status !== "passed")) { item.turns.push(skipped(template, roundIndex + 1, "前序依赖轮次未通过。")); continue; }
        const variables: Record<string, string | undefined> = { orderId: orderIds[0], otherOrderId: orderIds[1], operationId: memory.operationId, oldOperationId: memory.oldOperationId, status: status(example) };
        const round = { ...template, question: template.question.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => variables[key] ?? placeholder) };
        const targetId = orderIds[round.target === "other" ? 1 : 0]!;
        let before: Facts[] = [], setupError: string | undefined;
        try {
          assert.ok(!/\{[^{}]+\}/.test(round.question), "缺少前轮已持久化的动态标识。");
          if (["pending-faq", "claimed-approval"].includes(round.action)) await fixture.holdMerchant(targetId, dataset.fixtures.merchantHoldMs);
          if (round.action === "expire-query") await fixture.expireRefund(targetId);
          if (round.action === "restart-query") await restart();
          if (round.action === "notify") {
            const task = await merchant.getTask(identity, sourceKey, targetId); assert.equal(task?.taskId, memory.taskId); assert.ok(task);
            if (example.outcome === "timeout") { await fixture.expire(targetId); await merchant.processDue(); }
            else assert.ok(await merchant.applyResult({ taskId: task.taskId, orderId: targetId, status: example.outcome === "approve" ? "approved" : "rejected", approvedAmountCents: example.outcome === "approve" ? task.amountCents : null }));
            assert.equal((await merchant.getTask(identity, sourceKey, targetId))?.status, status(example));
          }
          before = await Promise.all(orderIds.map(readFacts));
        } catch { setupError = "轮前临时数据、动态标识或重启准备失败；本轮未调用模型。"; }
        if (setupError) {
          const turn = skipped(round, roundIndex + 1, setupError); turn.status = "failed"; turn.checks[0]!.status = "failed";
          item.turns.push(turn); continue;
        }
        const previous = session!.messages.length, receiptStart = receipts.length, deliveredStart = delivered.length, gateStart = hostCalls, handledStart = hostHandled;
        const toolsBefore = session!.getActiveToolNames().slice().sort(), message = inbound(round.question, identity.senderId, group);
        const startedAt = new Date().toISOString(); capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
        let failure: string | undefined, duplicateSuppressed = false;
        try {
          if (round.source === "event") {
            await dispatchMerchantNotifications(merchant, agent!, identity.appId, [group]);
            const messages = session!.messages.length, count = receipts.length;
            await dispatchMerchantNotifications(merchant, agent!, identity.appId, [group]);
            duplicateSuppressed = messages === session!.messages.length && count === receipts.length;
          } else await agent!.handle(message);
        } catch { failure = "本轮QQAgent或dispatcher执行未完成。"; }
        const measured = capture.finish(); capture = undefined;
        let context: Context | undefined;
        try {
          const all = await Promise.all(orderIds.map(readFacts)), messages = session!.messages.slice(previous);
          const last = messages.findLast(message => message.role === "assistant");
          context = { round, example, facts: all[round.target === "other" ? 1 : 0]!, all, before, memory,
            receipt: receipts.slice(receiptStart)[0], delivered: delivered.slice(deliveredStart)[0], receipts: receipts.length - receiptStart, deliveries: delivered.length - deliveredStart,
            trace: messages.filter(message => message.role === "toolResult"), steps: measured.steps, group, sender: identity.senderId,
            messageId: round.source === "event" ? memory.messageId! : message.messageId, hostCalls: hostCalls - gateStart, hostHandled: hostHandled - handledStart,
            duplicateSuppressed, toolsRestored: workflowToolsRestored(toolsBefore, session!.getActiveToolNames()),
            sameSession: session === originalSession, restarted: round.action === "restart-query", finished: !failure && !measured.failed,
            modelStopped: last?.stopReason === "stop" && measured.steps.every(step => step.type !== "model" || !step.isError),
            amount: dataset.fixtures.amountCents, reason: dataset.fixtures.reason };
        } catch { failure ??= "本轮持久化证据读取失败。"; }
        const checks = round.checks.map(id => {
          const { test, ...check } = byId.get(id)!;
          if (!context) return { ...check, status: id === "execution.completed" ? "failed" as const : "skipped" as const, reason: failure };
          try { return { ...check, status: test(context) ? "passed" as const : "failed" as const }; }
          catch { return { ...check, status: "failed" as const, reason: "缺少预期结构化证据。" }; }
        });
        const turn: EvalTurn = { index: roundIndex + 1, question: round.question, reply: receipts.slice(receiptStart).map(item => item.text).join("\n"),
          status: checks.every(check => check.status === "passed") ? "passed" : "failed", startedAt, durationMs: measured.durationMs, firstTextMs: measured.firstTextMs,
          evidenceIds: [...new Set(context?.trace.flatMap(tool => { try {
            const value = JSON.parse(tool.content.map(part => part.type === "text" ? part.text : "").join(""));
            return tool.isError ? [] : (Array.isArray(value) ? value.map(doc => doc.sourceId).filter(Boolean) : [value?.id, value?.orderId, value?.taskId, value?.operationId, value?.refundId].filter(Boolean));
          } catch { return []; } }) ?? [])] as string[], checks, steps: measured.steps, ...(failure ? { error: failure } : {}) };
        turn.observations = { before: observedFacts(before), ...(context ? { after: observedFacts(context.all), protocol: {
          source: round.source, target: context.receipt?.target, requesterId: context.receipt?.requesterId,
          renderedKind: context.receipt?.rendered.kind, buttonCommand: context.receipt?.rendered.button?.command ?? null,
          delivered: context.delivered && "operation" in context.delivered ? { kind: context.delivered.kind, operation: context.delivered.operation }
            : context.delivered?.kind === "merchant_status" ? { kind: context.delivered.kind, task: context.delivered.task }
            : context.delivered?.kind === "merchant_confirmation" ? context.delivered : { kind: context.delivered?.kind },
          receipts: context.receipts, completedDeliveries: context.deliveries, hostGateCalls: context.hostCalls, hostHandled: context.hostHandled,
          toolsRestored: context.toolsRestored, sameSession: context.sameSession, duplicateSuppressed: context.duplicateSuppressed,
        } } : {}) };
        item.turns.push(turn);
        if (turn.status === "passed" && context) {
          if (round.action === "confirm-merchant") { memory.taskId = context.facts.task!.taskId; memory.messageId = message.messageId; }
          if (["request-refund", "renew"].includes(round.action)) { memory.operationId = context.facts.operation!.operationId; memory.oldOperationId ??= memory.operationId; }
          if (round.action === "confirm-refund") memory.refundId = context.facts.operation!.refundId!;
        }
        console.log(`[objective-workflow] ${example.id}/${roundIndex + 1} ${turn.status}${checks.some(check => check.status === "failed") ? ` ${checks.filter(check => check.status === "failed").map(check => check.id).join(",")}` : ""}`);
      }
      item.status = item.turns.every(turn => turn.status === "passed") ? "passed" : "failed";
      attemptedSaves.add(item.id);
      await history.saveCase(run.id, item);
    }
    await history.finishRun(run.id, "completed", new Date().toISOString(), summarizeEvaluation(cases)); finished = true;
    return run.id;
  } catch (error) {
    const errors: unknown[] = [error];
    if (run && started && !finished) {
      for (const example of dataset.cases) {
        // A lost commit acknowledgement has an unknown outcome. Never blindly repeat an INSERT.
        if (attemptedSaves.has(example.id)) continue;
        let item = cases.find(item => item.id === example.id);
        if (!item) { item = { id: example.id, name: example.name, category: "客观售后闭环", status: "skipped", turns: [] }; cases.push(item); }
        for (let index = item.turns.length; index < example.turns.length; index++) item.turns.push(skipped(example.turns[index]!, index + 1, "运行中断，未执行依赖轮次。"));
        item.status = item.turns.some(turn => turn.status === "failed") ? "failed" : item.turns.every(turn => turn.status === "passed") ? "passed" : "skipped";
        attemptedSaves.add(item.id);
        try { await history.saveCase(run.id, item); } catch (persistenceError) { errors.push(persistenceError); }
      }
      try { await history.finishRun(run.id, "failed", new Date().toISOString(), summarizeEvaluation(cases), "执行或持久化中断；已尝试保留完成轮次，缺失记录按计划分母显示missing，不重试结果未知的写入。"); }
      catch (persistenceError) { errors.push(persistenceError); }
    }
    primaryFailure = errors.length === 1 ? error : new AggregateError(errors, "评测执行和失败记录均有异常。");
    throw primaryFailure;
  } finally {
    // An Agent must settle before deleting its fixtures. Cleanup attempts all resources even if one close fails.
    let closeFailure: unknown;
    try { await closeAgent(); } catch (error) { closeFailure = error; }
    const cleanup = await Promise.allSettled([store.close(), merchant.close(), refunds.close(), history.close(), fixture.cleanup()]);
    const failures = cleanup.flatMap(item => item.status === "rejected" ? [item.reason] : []);
    if (closeFailure) failures.unshift(closeFailure);
    if (failures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...failures], "评测资源或临时fixture清理失败；保留原始失败。");
  }
}
