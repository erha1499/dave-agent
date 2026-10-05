import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import { contentHash } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { renderReply, type Reply } from "../src/reply.ts";
import { amountChoiceNotice, compareRemainingAmount, createAmountReference, type TrustedAmountChoices } from "../src/support-context.ts";
import type { SupportCall, SupportResult } from "../src/support-controller.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply,
  type SupportHostReceipt } from "../src/support-session.ts";
import { resolveSupportRunParameters } from "../src/support-parameters.ts";
import { c1ValidationCodeFiles, createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url);
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Runtime = Awaited<ReturnType<typeof createConfiguredModelRuntime>>;
const actor = { appId: "C1_AMOUNT_DEVELOPMENT", senderId: "OWNER" }, groupOpenid = "C1_AMOUNT_DEVELOPMENT_GROUP";
const binding = { sourceKey: merchantSourceKey(actor, groupOpenid), groupOpenid };
function fixture(id: string, unitPaidCents: number): Order {
  return { source: "demo-database", id, status: "partially_redeemed", asOf: "2026-10-06T00:00:00.000Z", createdAt: null, paidAt: null,
    shop: { id: "amount-shop", name: "合成门店", merchantName: "合成商家", address: "合成地址" },
    amounts: { totalCents: unitPaidCents * 2, paidCents: unitPaidCents * 2, refundedCents: 0 },
    items: [{ id: `${id}-item`, productId: "amount-meal", productName: "双券演示套餐", quantity: 2, unitPriceCents: unitPaidCents, totalCents: unitPaidCents * 2 }],
    coupons: [{ id: `${id}-used`, orderItemId: `${id}-item`, status: "redeemed", expiresAt: "2030-12-31T00:00:00.000Z", redeemedAt: "2026-10-01T00:00:00.000Z", redeemedShopId: "amount-shop" },
      { id: `${id}-unused`, orderItemId: `${id}-item`, status: "unused", expiresAt: "2030-12-31T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: unitPaidCents * 2, paidAt: null }], refunds: [] };
}
export const amountSelectionProbePlan = {
  version: "amount-selection-development-v1", dataUse: "synthetic-exposed-development", actor, groupOpenid,
  fixtures: [{ owner: actor, order: fixture("COUPON-7701", 7980) }, { owner: actor, order: fixture("COUPON-7702", 5990) }],
  model: { provider: "deepseek", id: "deepseek-flash" },
  limits: { maxHttpRequests: 20, totalTimeoutMs: 300_000, turnTimeoutMs: 60_000, estimatedUsd: 1 },
  turns: [
    { question: "请查询 COUPON-7701，告诉我每张券的实付金额。", intent: "order_a", criteria: "准确展示A每券实付79.80元；不声称退款获批。" },
    { question: "再查一下 COUPON-7702，也告诉我每张券实际付了多少钱。", intent: "order_b", criteria: "准确展示B每券实付59.90元；不合并两个订单的金额来源。" },
    { question: "剩下那张券的实付，和前面那个金额一样吗？", intent: "ambiguous_basis", criteria: "说明比较基准不唯一，列出两个真实来源及其选择指令；不得替用户选最近或某个金额。" },
    { question: null, intent: "host_select_b", criteria: "固定回执确认选择实际展示的B基准，说明只支持同订单比较且不代表退款批准。无模型或业务调用。" },
    { question: "就用刚选定的基准，帮我核对当前这单剩下未使用的券，实付是不是相同。", intent: "compare_selected", criteria: "基于本轮B订单事实，说明唯一未使用券实付59.90元与已选59.90元相同；不声称可退款上限、获批或已退款。" },
  ],
} as const;
type Read = { requestId: string; identity: QQIdentity; orderId: string; owner: QQIdentity | null; allowed: boolean; outputHash: string | null };
type Guard = ReturnType<typeof createAmountProbeGuard>;
type Row = { turn: number; intent: string; question: string | null; status: "not_run" | "passed" | "failed" | "skipped"; reason: string | null;
  ingress: { requestId: string; messageId: string; identity: QQIdentity; groupOpenid: string } | null;
  durationMs: number | null; calls: SupportCall[]; reads: Read[]; requests: Guard["requests"];
  steps: ReturnType<ReturnType<typeof captureEvaluationTurn>["finish"]>["steps"]; retryEvents: Array<{ type: string; attempt: number }>;
  result?: SupportResult; hostReceipt?: SupportHostReceipt; actualReply?: Reply; actualReplyText: string | null; replyHash: string | null;
  hostReference: Record<string, unknown>; modelFinalText: string | null; knowledgeAttempts: number; engineeringChecks: Record<string, boolean>;
  selection?: { fromTurn: 3; sourceOrderId: string; sourceRequestId: string; candidateVersion: string; token: string; sourceReplyHash: string } };
type ProbeExecution = { rows: Row[]; cleanup: { sessionDisposed: boolean; remainingOrders: number }; failure: string | null };
const plannedExecution = (): ProbeExecution => ({ rows: amountSelectionProbePlan.turns.map((turn, index) => ({ turn: index + 1,
  intent: turn.intent, question: turn.question, status: "not_run", reason: "not_started", ingress: null, durationMs: null,
  calls: [], reads: [], requests: [], steps: [], retryEvents: [], actualReplyText: null, replyHash: null,
  hostReference: {}, modelFinalText: null, knowledgeAttempts: 0, engineeringChecks: {} })),
  cleanup: { sessionDisposed: false, remainingOrders: 0 }, failure: null });

// Reuse the final executor's accounting, add only this probe's tighter transport
// and elapsed-time limits. Every SDK automatic retry passes this same fetch.
export function createAmountProbeGuard(fetcher: typeof fetch = fetch, now = Date.now) {
  const guard = createC1ValidationGuard(fetcher, now), started = now(), send = guard.fetchFor("agent");
  const stopped = () => now() - started >= amountSelectionProbePlan.limits.totalTimeoutMs ? "probe_deadline"
    : guard.requests.length >= amountSelectionProbePlan.limits.maxHttpRequests ? "probe_http_limit" : guard.stopped();
  return { ...guard, stopped, remainingMs: () => Math.max(0, amountSelectionProbePlan.limits.totalTimeoutMs - (now() - started)),
    fetch: (async (url, init) => { const reason = stopped(); if (reason) throw new Error(`Probe stopped before HTTP: ${reason}`); return send(url, init); }) as typeof fetch };
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sourceSnapshot = async () => Object.fromEntries(await Promise.all([...await c1ValidationCodeFiles(), "scripts/c1-amount-selection-live.ts"]
  .map(async path => [path, sha256(await readFile(new URL(path, root)))])));
const packageSnapshot = async () => Object.fromEntries(await Promise.all(["package.json", "package-lock.json"]
  .map(async path => [path, sha256(await readFile(new URL(path, root)))])));
const modelSnapshot = (model: Runtime["model"]) => ({ provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
  maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost });
export async function inspectAmountSelectionProbe() {
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash"); assert.ok(model);
  return { plan: structuredClone(amountSelectionProbePlan), planHash: contentHash(amountSelectionProbePlan),
    configuration: { architecture: "controller", parameters: resolveSupportRunParameters("controller"), model: modelSnapshot(model),
      knowledge: "forbidden", businessWrites: "unavailable", sql: false, qq: false, sessionAutomaticRetries: 2, providerRetries: 0,
      pricing: { estimated: true, source: "Pi catalog USD estimate; not actual billing" } },
    sources: await sourceSnapshot(), dependencies: await readC1ValidationDependencies(), packageHashes: await packageSnapshot() };
}
function lastHost(messages: readonly unknown[]): Record<string, unknown> {
  return messages.flatMap(message => {
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; }
  }).at(-1) ?? {};
}
function candidateB(row: Row) {
  const choices = row.result?.evidence.amountChoices;
  assert.ok(choices && choices.candidates.length === 2 && !choices.overflow && choices.selectionRequired && !choices.selectedToken);
  assert.deepEqual(choices.candidates.map(candidate => candidate.reference.orderId).sort(), ["COUPON-7701", "COUPON-7702"]);
  assert.ok(row.actualReply?.kind === "notice");
  assert.equal(row.actualReply.text, amountChoiceNotice(choices, binding), "Token must come from the actual fixed host reply");
  const b = choices.candidates.find(candidate => candidate.reference.orderId === "COUPON-7702")!;
  assert.ok(row.actualReply.text.split("\n").includes(`选择金额基准 ${b.token}`));
  return b;
}
function scoreRow(row: Row, rows: Row[], completed: boolean) {
  const result = row.result, ingress = row.ingress!, before = rows.slice(0, row.turn - 1);
  const checks: Record<string, boolean> = { execution: completed, noKnowledge: row.knowledgeAttempts === 0
    && !row.calls.some(call => call.name === "search_faq") && !(result?.evidence.rules.length || result?.evidence.knowledge.length),
    noWrites: row.calls.every(call => call.name === "get_order") && !result?.evidence.operation && !result?.evidence.task,
    ingress: isDeepStrictEqual(ingress.identity, actor) && ingress.groupOpenid === groupOpenid && ingress.messageId === ingress.requestId
      && row.requests.every(request => request.requestId === ingress.requestId && request.turn === row.turn)
      && row.reads.every(read => read.requestId === ingress.requestId && isDeepStrictEqual(read.identity, actor) && read.allowed && isDeepStrictEqual(read.owner, actor))
      && row.calls.every(call => call.parentSpanId === ingress.requestId && (call.name !== "get_order" || !call.isError
        && row.reads.some(read => read.orderId === call.input.orderId && read.outputHash === contentHash(call.output)))),
    freshOrder: row.reads.length === 0 || Boolean(result?.evidence.order && row.calls.some(call => call.name === "get_order"
      && !call.isError && isDeepStrictEqual(call.output, result.evidence.order))) };
  if (row.turn === 4) {
    const receipt = row.hostReceipt, source = candidateB(rows[2]!);
    checks.hostSelection = !result && row.requests.length === 0 && row.steps.length === 0 && row.calls.length === 0 && row.reads.length === 0
      && receipt?.outcome === "selected" && receipt.sourceKey === binding.sourceKey && receipt.requestId === ingress.requestId
      && isDeepStrictEqual(receipt.trustedRoute, { groupOpenid, messageId: ingress.messageId }) && receipt.selectedRequestId === source.reference.requestId
      && receipt.choices.selectedToken === source.token && isDeepStrictEqual(receipt.choices.candidates, rows[2]!.result!.evidence.amountChoices!.candidates)
      && isDeepStrictEqual(row.actualReply, receipt.reply) && !receipt.historyFailed;
  } else {
    checks.actualAction = Boolean(result && !row.hostReceipt && row.requests.length > 0
      && result.evidence.requestId === ingress.requestId && isDeepStrictEqual(result.evidence.trustedRoute, { groupOpenid, messageId: ingress.messageId })
      && isDeepStrictEqual(result.evidence.actualCalls, row.calls));
    if (row.turn <= 2) {
      const expectedOrder = amountSelectionProbePlan.fixtures[row.turn - 1]!.order;
      checks.display = Boolean(result?.action.kind === "order" && result.outcome === "ready" && result.reply.kind === "order" && !result.needsAnswer
        && result.evidence.order?.id === expectedOrder.id && row.calls.length === 1 && row.reads.length === 1
        && isDeepStrictEqual(result.verifiedAmountReference, createAmountReference(result.evidence.order, binding, ingress.requestId))
        && result.verifiedAmountReference?.paidCents === expectedOrder.items[0]!.unitPriceCents && isDeepStrictEqual(row.actualReply, result.reply));
    } else if (row.turn === 3) {
      checks.clarification = result?.action.kind === "clarify" && result.action.field === "amount_basis" && result.outcome === "clarification"
        && row.calls.length === 0 && row.reads.length === 0;
      try { const b = candidateB(row); checks.displayedCandidates = b.reference.requestId === before[1]!.ingress!.requestId
        && row.result!.evidence.amountChoices!.candidates.every(candidate => before.some(prior => isDeepStrictEqual(candidate.reference, prior.result?.verifiedAmountReference))); }
      catch { checks.displayedCandidates = false; }
    } else {
      const source = candidateB(rows[2]!), expected = result?.evidence.order ? compareRemainingAmount(result.evidence.order, source.reference, binding) : undefined;
      checks.selectedComparison = result?.action.kind === "paid_amount_compare" && result.action.amountRef.requestId === source.reference.requestId
        && result.outcome === "ready" && result.evidence.order?.id === "COUPON-7702" && row.calls.length === 1 && row.reads.length === 1
        && Boolean(expected) && isDeepStrictEqual(result.evidence.amountComparison, expected)
        && result.evidence.amountComparison?.referencePaidCents === 5990 && result.evidence.amountComparison.comparisonEqual === true
        && result.evidence.amountChoices?.selectedToken === source.token && isDeepStrictEqual(row.actualReply, result.reply);
    }
  }
  row.engineeringChecks = checks; row.status = Object.values(checks).every(Boolean) ? "passed" : "failed";
  if (row.status === "failed" && !row.reason) row.reason = "engineering_contract_failed";
}

async function executeProbe(runtime: Runtime, guard: Guard, save: () => Promise<void>, runId: string, execution = plannedExecution()) {
  const rows = execution.rows;
  const orders = new Map(amountSelectionProbePlan.fixtures.map(value => [value.order.id, structuredClone(value)]));
  let active: { row: Row; signal: AbortSignal } | undefined, focus: string | undefined;
  const store = { async getOrder(identity: QQIdentity, id: string) {
    assert.ok(active); active.signal.throwIfAborted(); const value = orders.get(id);
    const allowed = Boolean(value && isDeepStrictEqual(identity, actor) && isDeepStrictEqual(value.owner, identity));
    const output = allowed ? { ...structuredClone(value!.order), asOf: new Date().toISOString() } : undefined;
    active.row.reads.push({ requestId: active.row.ingress!.requestId, identity: structuredClone(identity), orderId: id,
      owner: value?.owner ?? null, allowed, outputHash: output ? contentHash(output) : null });
    if (!output) throw new OrderAccessError("Synthetic fixture ownership denied"); return output;
  }, async searchKnowledge() { assert.ok(active); active.row.knowledgeAttempts++; throw new Error("Knowledge calls are forbidden in the amount probe"); } } as unknown as CouponStore;
  const originalStream = runtime.modelRuntime.streamSimple.bind(runtime.modelRuntime);
  runtime.modelRuntime.streamSimple = (model, transcript, options) => originalStream(model, transcript, { ...options, maxRetries: 0, fetch: guard.fetch });
  let session: Awaited<ReturnType<typeof createSupportSession>> | undefined, cleanup = false;
  execution.cleanup.remainingOrders = orders.size;
  await save();
  try {
    session = await createSupportSession(actor, store, runtime.modelRuntime, runtime.model, undefined, { groupOpenid,
      focus: { read: async () => focus, write: async value => { focus = value; } } });
    let priorPassed = true;
    for (const row of rows) {
      if (!priorPassed || guard.stopped()) { row.status = "skipped"; row.reason = !priorPassed ? "required_prior_failed" : guard.stopped(); continue; }
      if (row.turn === 4) {
        const source = candidateB(rows[2]!); row.question = `选择金额基准 ${source.token}`;
        row.selection = { fromTurn: 3, sourceOrderId: source.reference.orderId, sourceRequestId: source.reference.requestId,
          candidateVersion: source.version, token: source.token, sourceReplyHash: rows[2]!.replyHash! };
      }
      const requestId = `${runId}:amount:${row.turn}`, abort = new AbortController();
      row.ingress = { identity: structuredClone(actor), groupOpenid, requestId, messageId: requestId };
      active = { row, signal: abort.signal }; guard.setActive({ caseId: "amount-selection", turn: row.turn, requestId, signal: abort.signal });
      const requestStart = guard.requests.length, messageStart = session.messages.length;
      const capture = captureEvaluationTurn(`${runtime.model.provider}/${runtime.model.id}`); let cursor = requestStart, collecting = true;
      prepareSupportPrompt(session, { requestId, groupOpenid, messageId: requestId, onCall: call => { if (collecting) row.calls.push(structuredClone(call)); } });
      const unsubscribe = session.subscribe(event => {
        if (!collecting) return; capture.receive(event);
        if (event.type === "auto_retry_start" || event.type === "auto_retry_end") row.retryEvents.push({ type: event.type, attempt: event.attempt });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const sent = guard.requests.map((request, index) => ({ request, index })).filter(value => value.index >= cursor && value.request.requestId === requestId);
          if (sent.length === 1) { const usage = event.message.usage; guard.record(sent[0]!.index, usage?.totalTokens ?? null, usage?.cost?.total ?? null); }
          cursor = guard.requests.length;
        }
      });
      let timer: NodeJS.Timeout | undefined, failed = false;
      try {
        await Promise.race([session.prompt(row.question!, { expandPromptTemplates: false }), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { row.reason = "turn_timeout"; abort.abort(); cancelSupportTurn(session!); void session!.abort().catch(() => {}); reject(new Error("turn_timeout")); },
            Math.min(amountSelectionProbePlan.limits.turnTimeoutMs, guard.remainingMs()));
        })]);
      } catch { failed = true; row.reason ??= "session_failed"; }
      finally { clearTimeout(timer); collecting = false; unsubscribe(); abort.abort(); }
      const measured = capture.finish(); row.steps = measured.steps; row.durationMs = measured.durationMs;
      row.requests = structuredClone(guard.requests.slice(requestStart)); row.hostReference = lastHost(session.messages.slice(messageStart));
      const result = getSupportResult(session); if (result) row.result = structuredClone(result);
      const hostReceipt = getSupportHostReceipt(session); if (hostReceipt) row.hostReceipt = hostReceipt;
      const final = session.messages.slice(messageStart).findLast(message => message.role === "assistant");
      row.modelFinalText = final?.role === "assistant" ? final.content.filter(part => part.type === "text").map(part => part.text).join("") : null;
      row.actualReply = supportReply(session, row.modelFinalText ?? ""); row.replyHash = row.actualReply ? contentHash(row.actualReply) : null;
      row.actualReplyText = row.actualReply ? renderReply(row.actualReply).text : null;
      scoreRow(row, rows, !failed && !measured.failed && !row.steps.some(step => step.isError));
      priorPassed = row.status === "passed"; active = undefined; guard.setActive(undefined); await save();
    }
  } catch { execution.failure = "probe_setup_or_execution_failed"; }
  finally {
    guard.seal(); active = undefined; if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); session.dispose(); cleanup = true; }
    orders.clear(); runtime.modelRuntime.streamSimple = originalStream;
    execution.cleanup = { sessionDisposed: cleanup, remainingOrders: orders.size };
    for (const row of rows) if (row.status === "not_run") { row.status = "skipped"; row.reason = execution.failure ?? "not_executed"; }
  }
  return execution;
}
export async function runAmountSelectionProbe() {
  const before = await inspectAmountSelectionProbe(), runId = randomUUID(), startedAt = new Date().toISOString();
  const directory = new URL(".runtime/c1-amount-selection/", root); await mkdir(directory, { recursive: true });
  const path = new URL(`${runId}.json`, directory), guard = createAmountProbeGuard();
  const artifact = { version: 1, runId, startedAt, finishedAt: null as string | null, mode: "real-model-synthetic-store-no-SQL-no-QQ",
    before, after: null as Awaited<ReturnType<typeof inspectAmountSelectionProbe>> | null,
    codeStable: false, dependenciesStable: false, configurationStable: false, execution: plannedExecution(),
    requests: guard.requests, usage: guard.usage(), failure: null as string | null, answerReviews: [] as unknown[], summary: {} as Record<string, unknown>, admitted: false };
  const save = async () => { await writeFile(path, JSON.stringify(artifact, null, 2) + "\n"); };
  await save();
  try {
    const runtime = await createConfiguredModelRuntime();
    assert.deepEqual(modelSnapshot(runtime.model), before.configuration.model, "Live model must match the frozen catalog configuration");
    await executeProbe(runtime, guard, save, runId, artifact.execution);
  } catch { artifact.failure = "model_configuration_or_execution_failed"; }
  finally {
    guard.seal(); artifact.finishedAt = new Date().toISOString(); artifact.usage = guard.usage();
    try { artifact.after = await inspectAmountSelectionProbe(); artifact.codeStable = isDeepStrictEqual(before.sources, artifact.after.sources);
      artifact.dependenciesStable = isDeepStrictEqual(before.dependencies, artifact.after.dependencies);
      artifact.configurationStable = isDeepStrictEqual(before.configuration, artifact.after.configuration); }
    catch { artifact.failure = "after_snapshot_failed"; }
    const rows = artifact.execution.rows;
    for (const row of rows) if (row.status === "not_run") { row.status = "skipped"; row.reason = artifact.failure ?? "not_executed"; }
    artifact.answerReviews = amountSelectionProbePlan.turns.map((turn, index) => ({ turn: index + 1,
      question: rows[index]?.question ?? turn.question, actualReply: rows[index]?.actualReply ?? null, actualReplyText: rows[index]?.actualReplyText ?? null,
      replyHash: rows[index]?.replyHash ?? null, criteria: turn.criteria, criteriaHash: contentHash(turn.criteria), status: "unreviewed",
      reviewer: "codex", forHumanReview: true, humanAcceptance: false }));
    artifact.summary = { planned: 5, executed: rows.filter(row => row.status === "passed" || row.status === "failed").length,
      engineeringPassed: rows.filter(row => row.status === "passed").length, failed: rows.filter(row => row.status === "failed").length,
      skipped: 5 - rows.filter(row => row.status === "passed" || row.status === "failed").length, reviewedReplies: 0,
      knownEstimatedUsd: artifact.usage.agent.knownEstimatedCost, estimatedUsd: artifact.usage.agent.estimatedCost,
      unknownCostRequests: artifact.usage.agent.unknownCosts, actualHttpRequests: guard.requests.length, stopReason: guard.stopped(),
      runIntegrityPassed: rows.length === 5 && rows.every(row => row.status === "passed") && artifact.codeStable && artifact.dependenciesStable
        && artifact.configurationStable && !artifact.failure && !artifact.execution?.failure && !guard.stopped()
        && artifact.usage.agent.unknownCosts === 0 && artifact.execution?.cleanup.sessionDisposed && artifact.execution.cleanup.remainingOrders === 0 };
    await save();
  }
  console.log(JSON.stringify({ artifact: path.pathname, runId, summary: artifact.summary, admitted: false })); return path.pathname;
}

export async function checkAmountSelectionProbe() {
  const inspected = await inspectAmountSelectionProbe(); assert.equal(inspected.plan.turns.length, 5);
  assert.equal(inspected.configuration.knowledge, "forbidden"); assert.ok(inspected.sources["src/support-session.ts"]);
  let now = 100, sent = 0;
  const limited = createAmountProbeGuard(async () => { sent++; return new Response("{}"); }, () => now);
  limited.setActive({ caseId: "test", turn: 1, requestId: "request", signal: new AbortController().signal });
  for (let index = 0; index < 20; index++) await limited.fetch("https://example.invalid");
  await assert.rejects(limited.fetch("https://example.invalid"), /probe_http_limit/); assert.equal(sent, 20);
  assert.equal(limited.usage().agent.estimatedCost, null); assert.equal(limited.usage().agent.unknownCosts, 20);
  const budget = createAmountProbeGuard(async () => new Response("{}"), () => now);
  budget.setActive({ caseId: "test", turn: 1, requestId: "request", signal: new AbortController().signal });
  await budget.fetch("https://example.invalid"); budget.record(0, 100, 1);
  await assert.rejects(budget.fetch("https://example.invalid"), /usd_soft_stop/);
  const late = createAmountProbeGuard(async () => new Response("{}"), () => now);
  late.setActive({ caseId: "test", turn: 1, requestId: "request", signal: new AbortController().signal });
  await late.fetch("https://example.invalid"); late.seal(); late.record(0, 100, .1); assert.equal(late.usage().agent.estimatedCost, null);
  now += 300_000; assert.equal(budget.stopped(), "probe_deadline");
  const canceled = createAmountProbeGuard(async () => { throw new Error("Aborted request cannot reach HTTP"); });
  canceled.setActive({ caseId: "test", turn: 1, requestId: "cancel", signal: AbortSignal.abort() });
  await assert.rejects(canceled.fetch("https://example.invalid")); assert.equal(canceled.requests.length, 0);
  const modelRuntime = await createModelRuntime(), model = modelRuntime.getModel("deepseek", "deepseek-flash")!;
  await modelRuntime.setRuntimeApiKey("deepseek", "synthetic-not-a-credential");
  let responseIndex = 0, forceKnowledge = false;
  const fake: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const host = body.messages.flatMap((message: { content?: string | Array<{ text?: string }> }) => typeof message.content === "string"
      ? [message.content] : (message.content ?? []).flatMap(part => part.text ? [part.text] : [])).flatMap((text: string) => {
      const start = text.indexOf('{"kind":"host_order_reference"');
      if (start < 0) return [];
      try { return [JSON.parse(text.slice(start, text.lastIndexOf("}") + 1))]; } catch { return []; }
    }).at(-1);
    const index = responseIndex++, tool = index % 2 === 0;
    const actions = [{ protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: "COUPON-7701" } },
      { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: "COUPON-7702" } },
      { protocol: "v2.2", kind: "clarify", field: "amount_basis", reason: "ambiguous" },
      { protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" }, amountRef: { requestId: host?.itemPaidUnit?.requestId ?? "missing" } }];
    assert.ok(index < 8, "Unexpected extra model call in five-turn probe");
    const action = forceKnowledge && index === 0 ? { protocol: "v2.2", kind: "policy", question: "套餐规则",
      questionContext: { kind: "standalone" }, orderRef: { kind: "explicit", orderId: "COUPON-7701" } } : actions[Math.floor(index / 2)];
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function",
      function: { name: "support_action", arguments: JSON.stringify({ action }) } }] } : { role: "assistant", content: "完成。" };
    const chunk = (value: object, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id: `chat_${index}`, object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta: value, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 })
      + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const guard = createAmountProbeGuard(fake), result = await executeProbe({ modelRuntime, model }, guard, async () => {}, "engineering");
  assert.deepEqual(result.rows.map(row => row.status), ["passed", "passed", "passed", "passed", "passed"],
    JSON.stringify(result.rows.map(row => ({ turn: row.turn, checks: row.engineeringChecks, action: row.result?.action }))));
  assert.equal(result.rows[3]!.requests.length, 0); assert.equal(result.rows[3]!.result, undefined); assert.equal(result.rows[3]!.hostReceipt?.outcome, "selected");
  assert.equal(guard.requests.length, 8); assert.equal(guard.usage().agent.unknownCosts, 0);
  assert.equal(result.cleanup.remainingOrders, 0); assert.equal(result.cleanup.sessionDisposed, true);
  const tampered = structuredClone(result.rows); tampered[3]!.hostReceipt!.selectedRequestId = "not-displayed";
  scoreRow(tampered[3]!, tampered, true); assert.equal(tampered[3]!.status, "failed");
  const fakeOrder = structuredClone(result.rows); fakeOrder[4]!.result!.evidence.order!.shop.name = "forged-read";
  scoreRow(fakeOrder[4]!, fakeOrder, true); assert.equal(fakeOrder[4]!.engineeringChecks.freshOrder, false);
  forceKnowledge = true; responseIndex = 0;
  const forbiddenGuard = createAmountProbeGuard(fake), forbidden = await executeProbe({ modelRuntime, model }, forbiddenGuard, async () => {}, "forbidden-knowledge");
  assert.equal(forbidden.rows[0]!.knowledgeAttempts, 1); assert.equal(forbidden.rows[0]!.engineeringChecks.noKnowledge, false);
  assert.equal(forbidden.rows[0]!.status, "failed"); assert.ok(forbidden.rows.slice(1).every(row => row.status === "skipped"));
  assert.ok(forbiddenGuard.requests.every(request => request.operation === "agent"), "No knowledge provider exists even when the model asks for it");
  // A failed first model response keeps all five rows and skips the four dependents.
  const noAction = createAmountProbeGuard(async () => new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"请补充"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } }));
  const failure = await executeProbe({ modelRuntime, model }, noAction, async () => {}, "failed-engineering");
  assert.equal(failure.rows.length, 5); assert.equal(failure.rows[0]!.status, "failed");
  assert.ok(failure.rows.slice(1).every(row => row.status === "skipped"));
  console.log("Amount selection probe engineering PASS: actual five-turn Session with fake HTTP, live guards, host-only selection, complete denominator and cleanup; 0 network.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2); assert.ok(args.length <= 1 && (!args.length || ["--live", "--inspect"].includes(args[0]!)), "Use --inspect, --live or no arguments");
  if (args[0] === "--live") await runAmountSelectionProbe();
  else { if (!args.length) await checkAmountSelectionProbe(); const snapshot = await inspectAmountSelectionProbe();
    console.log(JSON.stringify({ version: snapshot.plan.version, planHash: snapshot.planHash, turns: 5, fixtureOrders: snapshot.plan.fixtures.length,
      model: snapshot.configuration.model, limits: snapshot.plan.limits, network: false, dataUse: snapshot.plan.dataUse })); }
}
