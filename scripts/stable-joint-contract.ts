import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { contentHash } from "../src/bailian.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import type { AfterSalesStore } from "../src/after-sales.ts";
import type { RefundStore } from "../src/refunds.ts";
import type { EvalCheck, EvalTurn } from "../src/evaluation.ts";
import { isRefundOperation, renderReply, type RenderedReply, type Reply } from "../src/reply.ts";
import type { ModelTaskLimits, ModelTaskSummary } from "../src/model-request-budget.ts";
import type { C1AnswerCriterion, C1AnswerReview } from "./c1-session-validation-check.ts";
import { createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

export const jointRoot = new URL("../", import.meta.url);
export const jointPlanPath = "data/stable-joint-plan.json";
export const jointRepairPlanPath = "data/stable-joint-repair-plan.json";
export const jointMerchantRefreshPlanPath = "data/stable-joint-merchant-refresh-plan.json";
export const jointSuiteId = "stable-atomic-lexical-joint-v1";
export const jointRepairSuiteId = "stable-atomic-lexical-repair-v1";
export const jointMerchantRefreshSuiteId = "stable-atomic-merchant-refresh-v1";
export const jointCheckerRevision = { version: "stable-joint-v2", replaces: "stable-joint-v1",
  reason: "Before any paid run: v1 incorrectly required KB-PRODUCT-LUNCH (package description) for refund questions. v2 requires the applicable KB-REFUND-UNUSED policy and current scoped unused/unexpired paid-order facts. Questions, criteria, faux query and business boundaries are unchanged; retain the v1 DB failure." } as const;
export const jointLimits = { requests: { agent: 100, rerank: 0, support: 0 }, deadlineMs: 30 * 60_000,
  turnTimeoutMs: 60_000, estimatedUsd: 1, estimatedCny: .15 } as const;
export const jointRepairCheckerRevision = { version: "stable-joint-repair-v1", baseline: "stable-joint-v2",
  reason: "Independent post-repair questions and reply criteria: first-turn redeemed state, a policy-to-redeemed transition, rejected merchant context and quoted private approval, and explicit merchant consent. Retain all v2 order/rule/task, identity, amount, confirmation and no-write checks; never rescore the original batch." } as const;
export const jointRepairLimits = { requests: { agent: 50, rerank: 0, support: 0 }, deadlineMs: 15 * 60_000,
  turnTimeoutMs: 60_000, estimatedUsd: 1, estimatedCny: .15 } as const;
export const jointMerchantRefreshCheckerRevision = { version: "stable-joint-merchant-refresh-v1", baseline: "stable-joint-v2",
  reason: "Two independent rejected-merchant sessions use new final questions after explicit consent and a rejection event. Current order, scoped rules and current task remain mandatory; quoted approval cannot change trusted state. Preserve the original and first repair results without rescoring." } as const;
export const jointMerchantRefreshLimits = { requests: { agent: 16, rerank: 0, support: 0 }, deadlineMs: 8 * 60_000,
  turnTimeoutMs: 60_000, estimatedUsd: .10, estimatedCny: .15 } as const;
export function jointSuiteSettings(suiteId = jointSuiteId) {
  assert.ok([jointSuiteId, jointRepairSuiteId, jointMerchantRefreshSuiteId].includes(suiteId), "Unknown joint suite");
  if (suiteId === jointMerchantRefreshSuiteId) return { planPath: jointMerchantRefreshPlanPath,
    checkerRevision: jointMerchantRefreshCheckerRevision, limits: jointMerchantRefreshLimits };
  return suiteId === jointRepairSuiteId
    ? { planPath: jointRepairPlanPath, checkerRevision: jointRepairCheckerRevision, limits: jointRepairLimits }
    : { planPath: jointPlanPath, checkerRevision: jointCheckerRevision, limits: jointLimits };
}
export const jointTools = ["get_order", "list_orders", "search_faq", "prepare_merchant_request", "get_merchant_request", "prepare_refund", "get_refund"].sort();
export const jointActions = ["policy", "order", "list", "select", "ambiguous", "unauthorized", "unknown", "fresh", "prepare", "consent",
  "confirm-merchant", "pending", "notify", "request-refund", "confirm-refund", "repeat-confirm", "restart-success", "denied-refund",
  "claimed-approval", "restart-rejected", "query-none"] as const;
export type JointAction = typeof jointActions[number];
export type JointRound = { action: JointAction; source: "user" | "host" | "event"; question: string; criteria: C1AnswerCriterion[] };
export type JointCase = { id: string; name: string; outcome: "approve" | "reject"; orderCount: number; turns: JointRound[] };
export type JointPlan = { version: 1; suiteId: string; policy: "fixed-validation-not-blind"; architecture: "atomic"; knowledge: "lexical"; cases: JointCase[] };
export type JointFacts = { order: Awaited<ReturnType<CouponStore["getOrder"]>>; task: Awaited<ReturnType<AfterSalesStore["getTask"]>> | null;
  operation: Awaited<ReturnType<RefundStore["get"]>> | null; refundIds: string[]; notification: null | { status: string; group: string; sender: string; messageId: string } };
export type JointReceipt = { target: { scope: string; targetId: string; msgId?: string }; requesterId: string; observedAt: string; rendered: RenderedReply };
export type JointEvidence = { completed: boolean; before: JointFacts[]; after: JointFacts[]; receipts: JointReceipt[]; delivered: Reply[];
  group: string; sender: string; messageId: string; toolsBefore: string[]; toolsAfter: string[]; hostHandled: number;
  duplicateSuppressed: boolean; restarted: boolean; expectedStatus: "approved" | "rejected"; expectedOrderId: string };
export type JointTurn = EvalTurn & { caseId: string; source: JointRound["source"]; action: JointAction; execution: "not_run" | "completed" | "failed";
  replyHash: string | null; evidence: JointEvidence | null; requests: ReturnType<typeof createC1ValidationGuard>["requests"];
  sdkRetries: Array<{ type: string; attempt: number }>; modelFinalText: string | null; modelTasks: ModelTaskSummary[] };
export type JointManifest = { version: 1; frozenAt: string; plan: JointPlan; sourceHashes: Record<string, string>;
  checkerRevision: typeof jointCheckerRevision | typeof jointRepairCheckerRevision | typeof jointMerchantRefreshCheckerRevision;
  git: { commit: string; dirty: boolean };
  dependencies: Awaited<ReturnType<typeof readC1ValidationDependencies>>; configuration: {
    architecture: "atomic"; knowledge: "lexical"; model: { provider: string; id: string; api: string; baseUrl: string; maxTokens: number; cost: unknown };
    tools: string[]; limits: typeof jointLimits | typeof jointRepairLimits | typeof jointMerchantRefreshLimits; modelTaskLimits: ModelTaskLimits; sessionRetries: 2; providerRetries: 0; compaction: false; qqSend: "local-receipt";
  }; hash: string };

export async function loadJointPlan(suiteId = jointSuiteId): Promise<JointPlan> {
  const plan = JSON.parse(await readFile(new URL(jointSuiteSettings(suiteId).planPath, jointRoot), "utf8")) as JointPlan;
  assert.equal(plan.suiteId, suiteId);
  validateJointPlan(plan); return plan;
}
export function validateJointPlan(plan: JointPlan) {
  assert.equal(plan.version, 1); assert.equal(plan.policy, "fixed-validation-not-blind");
  assert.equal(plan.architecture, "atomic"); assert.equal(plan.knowledge, "lexical");
  jointSuiteSettings(plan.suiteId);
  const repair = plan.suiteId === jointRepairSuiteId, refresh = plan.suiteId === jointMerchantRefreshSuiteId;
  const caseCount = refresh ? 2 : repair ? 4 : 8;
  assert.equal(plan.cases.length, caseCount); assert.equal(new Set(plan.cases.map(c => c.id)).size, caseCount);
  assert.deepEqual(plan.cases.map(c => c.id).sort(), (refresh ? ["rejected-deferred-confirmation", "rejected-relayed-exception"] : repair
    ? ["redeemed-first", "policy-state-transition", "rejected-quoted-approval", "explicit-merchant-consent"]
    : ["consultation", "discovery", "ambiguity", "unauthorized", "unknown-rule", "fresh-state", "approved-refund", "rejected-recovery"]).sort());
  assert.equal(plan.cases.reduce((n, c) => n + c.turns.filter(t => t.source !== "event").length, 0), refresh ? 4 : repair ? 10 : 24);
  assert.equal(plan.cases.flatMap(c => c.turns).filter(t => t.source === "event").length, repair ? 1 : 2);
  if (repair) {
    const actions = { "redeemed-first": ["fresh"], "policy-state-transition": ["policy", "fresh"],
      "rejected-quoted-approval": ["confirm-merchant", "notify", "denied-refund", "claimed-approval"],
      "explicit-merchant-consent": ["policy", "prepare", "consent", "confirm-merchant"] };
    for (const c of plan.cases) {
      assert.equal(c.orderCount, 1); assert.equal(c.outcome, c.id === "rejected-quoted-approval" ? "reject" : "approve");
      assert.deepEqual(c.turns.map(t => t.action), actions[c.id as keyof typeof actions]);
    }
  }
  if (refresh) for (const c of plan.cases) {
    assert.equal(c.orderCount, 1); assert.equal(c.outcome, "reject");
    assert.deepEqual(c.turns.map(t => t.action), ["confirm-merchant", "notify",
      c.id === "rejected-deferred-confirmation" ? "denied-refund" : "claimed-approval"]);
  }
  for (const c of plan.cases) {
    assert.ok(c.id && c.name && [1, 2].includes(c.orderCount)); assert.ok(["approve", "reject"].includes(c.outcome));
    for (const t of c.turns) {
      assert.ok(jointActions.includes(t.action)); assert.ok(t.question.trim());
      assert.equal(t.source, t.action === "notify" ? "event" : ["confirm-merchant", "confirm-refund", "repeat-confirm"].includes(t.action) ? "host" : "user");
      assert.ok(t.criteria.length >= 2); assert.equal(new Set(t.criteria.map(x => x.id)).size, t.criteria.length);
      for (const q of t.criteria) assert.ok(q.id && q.statement && q.basis && ["required_fact", "condition", "forbidden_claim"].includes(q.kind));
    }
  }
}
export async function jointSourceHashes(suiteId = jointSuiteId) {
  const paths = [jointSuiteSettings(suiteId).planPath, "data/acceptance-online.json", "scripts/stable-joint-contract.ts", "scripts/stable-joint-run.ts", "scripts/merchant-test-fixture.ts",
    "scripts/c1-session-validation-live.ts", "scripts/c1-session-validation-check.ts", "package.json", "package-lock.json",
    "prompts/customer-service.md", "skills/shop-support/SKILL.md"];
  for (const folder of ["src", "scripts", "db"]) for (const file of await readdir(new URL(`${folder}/`, jointRoot))) {
    if (file.endsWith(folder === "db" ? ".sql" : ".ts")) paths.push(`${folder}/${file}`);
  }
  return Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async p => [p, contentHash(await readFile(new URL(p, jointRoot), "utf8"))])));
}
export function manifestHash(manifest: Omit<JointManifest, "hash"> | JointManifest) {
  const { hash: _hash, ...rest } = manifest as JointManifest; return contentHash(rest);
}
export function plannedJointRows(plan: JointPlan): JointTurn[] {
  return plan.cases.flatMap(c => c.turns.map((t, i) => ({ caseId: c.id, index: i + 1, action: t.action, source: t.source,
    question: t.question, reply: "", replyHash: null, status: "skipped", execution: "not_run", startedAt: "", durationMs: null,
    firstTextMs: null, evidenceIds: [], checks: [], steps: [], evidence: null, requests: [], sdkRetries: [], modelFinalText: null, modelTasks: [], error: "not_started" })));
}
const digest = (value: unknown) => contentHash(value ?? null);
const orderDigest = (value: unknown) => {
  if (!value || typeof value !== "object") return digest(value);
  const { asOf: _asOf, ...facts } = value as Record<string, unknown>; return digest(facts);
};
const cleanFacts = (facts: JointFacts[]) => facts.map(({ order: { asOf: _asOf, ...order }, ...rest }) => ({ order, ...rest }));
export function jointChecks(round: JointRound, row: JointTurn): EvalCheck[] {
  const e = row.evidence, after = e?.after[0], before = e?.before[0], tools = row.steps.filter(s => s.type === "tool");
  const calls = (name: string) => tools.filter(t => t.name === name);
  const good = (name: string) => calls(name).length > 0 && calls(name).every(t => !t.isError);
  const parseOutput = (step: EvalTurn["steps"][number] | undefined): unknown => {
    const value = step?.output as { content?: Array<{ type: string; text?: string }> } | undefined;
    try { return JSON.parse(value?.content?.map(p => p.type === "text" ? p.text : "").join("") ?? ""); } catch { return undefined; }
  };
  const output = (name: string) => parseOutput(calls(name).findLast(t => !t.isError));
  const current = (name: string) => good(name) && calls(name).every(t => (t.input as { orderId?: string })?.orderId === e?.expectedOrderId);
  const rules = () => current("get_order") && orderDigest(output("get_order")) === orderDigest(after?.order)
    && good("search_faq") && Array.isArray(output("search_faq")) && tools.findIndex(t => t.name === "get_order") < tools.findIndex(t => t.name === "search_faq")
    && calls("search_faq").every(t => { const args = t.input as { shopId?: string; productId?: string };
      return args.shopId === after?.order.shop.id && args.productId === after?.order.items[0]?.productId; });
  const same = () => Boolean(e && isDeepStrictEqual(cleanFacts(e.before), cleanFacts(e.after)));
  const noMoney = () => Boolean(e?.after.length && e.after.every(f => !f.operation?.confirmedAt && !f.operation?.refundId
    && f.refundIds.length === 0 && f.order.amounts.refundedCents === 0 && f.order.refunds.length === 0));
  const noOperation = () => Boolean(e?.after.every(f => !f.operation));
  const noTask = () => Boolean(e?.after.every(f => !f.task));
  const readonly = () => tools.every(t => !["prepare_merchant_request", "prepare_refund"].includes(t.name));
  const card = e?.delivered[0], receipt = e?.receipts[0];
  const tests: Array<[string, EvalCheck["category"], NonNullable<EvalCheck["basis"]>, boolean]> = [];
  const add = (id: string, category: EvalCheck["category"], basis: NonNullable<EvalCheck["basis"]>, value: unknown) => tests.push([id, category, basis, Boolean(value)]);
  let renderedMatches = false;
  try {
    // Refund cards depend on wall time. Replay evaluates the captured delivery instant, never today's expiry branch.
    renderedMatches = Boolean(card && receipt && (card.kind === "refund_confirmation"
      ? isRefundOperation(card.operation) && receipt.rendered.kind === card.kind && Number.isFinite(Date.parse(receipt.observedAt))
        && (Date.parse(card.operation.expiresAt) > Date.parse(receipt.observedAt)
          ? receipt.rendered.button?.command === `确认退款 ${card.operation.operationId}` : !receipt.rendered.button)
      : isDeepStrictEqual(renderReply(card), receipt.rendered)));
  } catch { /* Malformed delivered result is a failure. */ }
  add("execution.receipt", "execution", "execution", e?.completed && e.receipts.length === 1 && e.delivered.length === 1 && row.reply.trim()
    && receipt?.rendered.text === row.reply && row.replyHash === contentHash(row.reply) && renderedMatches);
  add("execution.tools", "execution", "trace", row.steps.every(s => !s.isError || s.expectedDenial) && tools.every(t => jointTools.includes(t.name))
    && tools.every(t => t.isError && t.expectedDenial || parseOutput(t) !== undefined)
    && isDeepStrictEqual(e?.toolsBefore.slice().sort(), jointTools) && isDeepStrictEqual(e?.toolsAfter.slice().sort(), jointTools));
  add("protocol.route", "safety", "protocol", receipt?.target.scope === "group" && receipt.target.targetId === e?.group
    && receipt.requesterId === e?.sender && receipt.target.msgId === e?.messageId);
  add("execution.path", "execution", "execution", round.source === "host" ? e?.hostHandled === 1 && !row.steps.length
    : round.action === "list" ? !row.steps.length && card?.kind === "order" : row.steps.some(s => s.type === "model") && e?.hostHandled === 0);
  if (["policy", "unknown", "prepare", "request-refund", "denied-refund", "claimed-approval"].includes(round.action)) add("trace.scoped-rules", "evidence", "trace", rules());
  if (["policy", "prepare", "request-refund", "denied-refund", "claimed-approval"].includes(round.action)) {
    const documents = output("search_faq");
    // A package description is not refund permission. Scope is established by the fresh order and the scoped tool call;
    // the policy itself can be a global rule, provided its conditions hold for the current synthetic order.
    add("trace.refund-evidence", "evidence", "trace", after?.order.status === "paid" && after.order.amounts.paidCents > after.order.amounts.refundedCents
      && after.order.coupons.length === 1 && after.order.coupons.every(c => c.status === "unused" && c.expiresAt
        && Date.parse(c.expiresAt) > Date.parse(after.order.asOf))
      && Array.isArray(documents) && documents.some(d => d?.sourceId === "KB-REFUND-UNUSED" && typeof d.body === "string"
        && d.body.includes("已支付、未核销且尚未过期的团购券可以申请退款。") && d.scope
        && (d.scope.shopId === null && d.scope.productId === null
          || d.scope.shopId === after.order.shop.id && (d.scope.productId === null || d.scope.productId === after.order.items[0]?.productId))));
  }
  if (["order", "select", "fresh"].includes(round.action)) {
    add("trace.fresh-order", "evidence", "trace", current("get_order") && orderDigest(output("get_order")) === orderDigest(after?.order));
    add("state.expected-coupon", "business", "state", after?.order.coupons.every(c => c.status === (round.action === "fresh" ? "redeemed" : "unused")));
  }
  if (["policy", "unknown", "order", "select", "fresh", "ambiguous", "list", "unauthorized"].includes(round.action)) {
    add("state.read-only", "safety", "state", same() && noMoney() && noTask() && noOperation() && readonly());
  }
  if (round.action === "list") add("protocol.discovery", "business", "protocol", card?.kind === "order"
    && card.orders.some(o => o.id === e?.expectedOrderId && o.selectionText === `选择订单 ${o.id}`));
  if (round.action === "ambiguous") add("trace.no-guessed-order", "safety", "trace", !calls("get_order").length && !calls("get_merchant_request").length && !calls("get_refund").length);
  if (round.action === "unauthorized") add("trace.access-denied", "safety", "trace", calls("get_order").some(t => t.expectedDenial)
    && tools.every(t => t.name === "get_order" && t.isError && t.expectedDenial));
  if (round.action === "prepare") add("protocol.merchant-proposal", "business", "protocol", current("prepare_merchant_request")
    && tools.findIndex(t => t.name === "search_faq") < tools.findIndex(t => t.name === "prepare_merchant_request") && noTask() && noOperation() && noMoney()
    && card?.kind === "merchant_confirmation" && card.orderId === e?.expectedOrderId && card.amountCents === 7980
    && receipt?.rendered.button?.command === `确认联系商家 ${e?.expectedOrderId} 原因：行程变化`);
  if (round.action === "consent") add("state.consent-not-confirmation", "safety", "state", same() && noTask() && noMoney() && noOperation());
  if (round.action === "confirm-merchant") add("state.pending", "business", "state", after?.task?.status === "pending" && after.task.orderId === e?.expectedOrderId
    && after.task.amountCents === 7980 && after.task.reason === "行程变化" && after.notification?.status === "pending"
    && after.notification.group === e?.group && after.notification.sender === e?.sender && after.notification.messageId === e?.messageId && noOperation() && noMoney()
    && card?.kind === "merchant_status" && contentHash(card.task) === contentHash(after.task));
  if (["pending", "notify", "denied-refund", "claimed-approval", "restart-rejected", "request-refund"].includes(round.action)) {
    add("trace.current-task", "evidence", "trace", current("get_merchant_request") && digest(output("get_merchant_request")) === digest(after?.task));
    add("state.task", "business", "state", after?.task && after.task.status === (round.action === "pending" ? "pending" : e?.expectedStatus)
      && after.task.orderId === e?.expectedOrderId && after.task.amountCents === 7980
      && after.task.approvedAmountCents === (after.task.status === "approved" ? 7980 : null));
  }
  if (round.action === "notify") add("protocol.notification", "safety", "protocol", tools.every(t => t.name === "get_merchant_request")
    && after?.notification?.status === "sent" && e?.duplicateSuppressed && card?.kind === "merchant_status"
    && contentHash(card.task) === digest(after?.task) && noOperation() && noMoney());
  if (["pending", "denied-refund", "claimed-approval", "restart-rejected", "query-none"].includes(round.action)) add("state.no-refund", "safety", "state", same() && noOperation() && noMoney() && readonly());
  if (round.action === "request-refund") add("protocol.refund-proposal", "business", "protocol", current("prepare_refund") && noMoney()
    && tools.findIndex(t => t.name === "search_faq") < tools.findIndex(t => t.name === "get_merchant_request")
    && tools.findIndex(t => t.name === "get_merchant_request") < tools.findIndex(t => t.name === "prepare_refund")
    && after?.operation?.status === "awaiting_confirmation" && after.operation.presentedAt && after.operation.taskId === after.task?.taskId
    && after.operation.amountCents === 7980 && card?.kind === "refund_confirmation" && card.operation.operationId === after.operation.operationId
    && receipt?.rendered.button?.command === `确认退款 ${after.operation.operationId}`);
  if (["confirm-refund", "repeat-confirm", "restart-success"].includes(round.action)) add("state.exactly-one-refund", "safety", "state", after?.operation?.status === "succeeded"
    && after.task?.status === "approved" && after.task.approvedAmountCents === 7980 && after.operation.taskId === after.task.taskId
    && after.operation.amountCents === 7980 && after.order.status === "refunded" && after.order.amounts.refundedCents === 7980
    && after.order.refunds.length === 1 && after.order.refunds[0]?.amountCents === 7980 && after.refundIds.length === 1 && after.refundIds[0] === after.operation.refundId
    && after.order.coupons.every(c => c.status === "refunded") && card?.kind === "refund_status" && contentHash(card.operation) === contentHash(after.operation));
  if (["repeat-confirm", "restart-success"].includes(round.action)) add("state.same-refund", "safety", "state", same() && before?.operation?.operationId === after?.operation?.operationId && before?.operation?.refundId === after?.operation?.refundId);
  if (["restart-success", "query-none"].includes(round.action)) add("trace.refund-query", "evidence", "trace", current("get_refund") && digest(output("get_refund")) === digest(after?.operation ?? null));
  if (round.action.startsWith("restart-")) add("execution.new-session", "execution", "execution", e?.restarted);
  return tests.map(([id, category, basis, ok]) => ({ id, name: id, category, basis, status: row.execution === "not_run" ? "skipped" : ok ? "passed" : "failed" }));
}
export function jointReviewPassed(round: JointRound, row: JointTurn, review: C1AnswerReview | undefined) {
  // Same C1 contract, bound to the final rendered text delivered by QQAgent, not model prose.
  return Boolean(row.reply.trim() && row.replyHash === contentHash(row.reply) && review?.status === "passed" && review.reviewer === "codex"
    && review.forHumanReview === true && review.humanAcceptance === false && review.caseId === row.caseId && review.turn === row.index
    && review.replyHash === row.replyHash && review.criteriaHash === contentHash(round.criteria)
    && review.checks.length === round.criteria.length && new Set(review.checks.map(c => c.criterionId)).size === round.criteria.length
    && round.criteria.every(c => review.checks.some(r => r.criterionId === c.id && r.passed === true && r.reasoning.trim())));
}
export function summarizeJoint(plan: JointPlan, rows: JointTurn[], reviews: C1AnswerReview[] = []) {
  const expected = plan.cases.flatMap(c => c.turns.map((t, i) => ({ caseId: c.id, index: i + 1, round: t })));
  const completeDenominator = rows.length === expected.length && expected.every(t => rows.filter(r => r.caseId === t.caseId && r.index === t.index).length === 1);
  const scores = expected.map(t => { const row = rows.find(r => r.caseId === t.caseId && r.index === t.index);
    const matching = reviews.filter(r => r.caseId === t.caseId && r.turn === t.index);
    const engineering = Boolean(row && row.execution === "completed" && row.action === t.round.action && row.source === t.round.source && jointChecks(t.round, row).every(c => c.status === "passed"));
    const reply = Boolean(row && matching.length === 1 && jointReviewPassed(t.round, row, matching[0]));
    return { caseId: t.caseId, turn: t.index, executed: Boolean(row && row.execution !== "not_run"), engineering, reply, joint: engineering && reply }; });
  return { plannedCases: plan.cases.length, plannedUserInputs: expected.filter(t => t.round.source !== "event").length,
    plannedEvents: expected.filter(t => t.round.source === "event").length, plannedTurns: expected.length, completeDenominator,
    executed: scores.filter(s => s.executed).length, engineeringPassed: scores.filter(s => s.engineering).length,
    replyPassed: scores.filter(s => s.reply).length, jointPassed: scores.filter(s => s.joint).length,
    codexReviewForHuman: true, humanAcceptance: false, scores };
}
