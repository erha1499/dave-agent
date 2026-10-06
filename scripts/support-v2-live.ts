import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPool, type RowDataPacket } from "mysql2/promise";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createCouponSession } from "../src/agent.ts";
import { modelPricing } from "../src/model-selection.ts";
import { AfterSalesStore, MerchantBusinessError, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply } from "../src/after-sales-entry.ts";
import { CouponStore, OrderAccessError, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalBatch, type EvalCase, type EvalCheck, type EvalObjectivePlan, type EvalRun, type EvalSpan, type EvalTurn } from "../src/evaluation.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import { RefundBusinessError, RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import type { RenderedReply } from "../src/reply.ts";
import { checkSupportContract, supportCheckSpecs, type SupportExpectation, type SupportState } from "../src/support-evaluation.ts";
import { createSupportSession, getSupportResult } from "../src/support-session.ts";
import { resolveSupportRunParameters, type SupportExperimentParameters } from "../src/support-parameters.ts";
import { createKnowledgeService, knowledgeQueryPlanVersion } from "../src/knowledge-service.ts";
import { evidenceSupportPrompt, evidenceSupportPromptVersion, evidenceSupportTypedPrompt, evidenceSupportTypedPromptVersion,
  evidenceSupportTypedV6PromptHash, evidenceSupportTypedV6PromptVersion } from "../src/evidence-support.ts";
import { knowledgeProviderSpans } from "../src/knowledge-evaluation.ts";
import type { SupportCall } from "../src/support-controller.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";
import { createObjectiveSnapshot, hash } from "./objective-support.ts";

type Architecture = "atomic" | "controller";
type Round = { index: number; mode: "contract" | "notify" | "agree" | "confirm" | "repeat";
  source: "user" | "event" | "host"; question: string; restart?: boolean; expect?: SupportExpectation };
type Dataset = { version: 2; scope: "objective"; answerQuality: "not_evaluated"; provenance: string;
  revision?: string; sourceDataset?: string;
  cases: Array<{ id: string; tags: string[]; setup: "none" | "pending" | "approved"; turns: Round[]; sourceCase?: string | null;
    operation?: "none" | "awaiting_confirmation" | "expired" | "succeeded"; knowledge?: "normal" | "empty" | "error"; foreign?: boolean }> };
type Session = Awaited<ReturnType<typeof createCouponSession>>;
const common = [
  { id: "execution.receipt", name: "执行采集和原群原用户回执完整", category: "execution", basis: "protocol" },
  { id: "protocol.host-consent", name: "只有精确确认轮执行宿主确认", category: "safety", basis: "protocol" },
] satisfies Array<Omit<EvalCheck, "status">>;
const special = { id: "business.fixed-terminal", name: "达到固定通知或确认终态，原操作不串单且幂等", category: "business", basis: "state" } satisfies Omit<EvalCheck, "status">;
const specs = (round: Round) => [...common, ...(round.mode === "contract" ? supportCheckSpecs : [special])];

export async function checkSupportLiveDataset(selection: "legacy" | "development" = "development") {
  assert.ok(["legacy", "development"].includes(selection));
  const path = selection === "legacy" ? "data/support-v2-live.json" : "data/support-v2-live-development.json";
  const dataset = JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8")) as Dataset;
  assert.equal(dataset.version, 2); assert.equal(dataset.scope, "objective"); assert.equal(dataset.answerQuality, "not_evaluated");
  assert.equal(dataset.cases.length, selection === "legacy" ? 3 : 14); assert.equal(new Set(dataset.cases.map(item => item.id)).size, dataset.cases.length);
  if (selection === "development") {
    const original = JSON.parse(await readFile(new URL("../data/support-v2-development.json", import.meta.url), "utf8")) as Dataset;
    assert.deepEqual(dataset.cases.flatMap(item => item.sourceCase ? [item.sourceCase] : []).sort(), original.cases.map(item => item.id).sort());
    assert.equal(dataset.revision, "live-development-v2");
  }
  for (const example of dataset.cases) {
    assert.ok(["none", "pending", "approved"].includes(example.setup));
    assert.ok([undefined, "none", "awaiting_confirmation", "expired", "succeeded"].includes(example.operation));
    assert.ok([undefined, "normal", "empty", "error"].includes(example.knowledge));
    for (const [index, turn] of example.turns.entries()) {
    assert.equal(turn.index, index + 1); assert.ok(turn.question.trim());
    assert.ok(["contract", "notify", "agree", "confirm", "repeat"].includes(turn.mode));
    assert.equal(Boolean(turn.expect), turn.mode === "contract");
    if (turn.expect) {
      assert.ok([null, "{orderId}", "{otherOrderId}"].includes(turn.expect.orderId));
      assert.ok(["read", "refund_prepared", "merchant_blocked", "missing_rules", "denied", "safe_stop", "refund_status"].includes(turn.expect.branch));
    }
    }
  }
  const plan: EvalObjectivePlan = { version: 2, scope: "objective", answerQuality: "not_evaluated", cases: dataset.cases.map(item => ({
    id: item.id, tags: item.tags, turns: item.turns.map(turn => ({ index: turn.index, source: turn.source,
      checks: specs(turn).map(({ id, category, basis }) => ({ id, category, basis })) })),
  })) };
  return { dataset, plan, path };
}

function inbound(content: string, senderId: string, group: string, id = randomUUID()): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId, groupOpenid: group, messageId: id, content, timestamp,
    replyTarget: { scope: "group", targetId: group, msgId: id },
    raw: { id, content, timestamp, group_openid: group, author: { member_openid: senderId } } };
}
function skipped(round: Round): EvalTurn {
  return { index: round.index, question: round.question, reply: "", status: "skipped", startedAt: new Date().toISOString(),
    durationMs: null, firstTextMs: null, evidenceIds: [], steps: [], spans: [],
    checks: specs(round).map(spec => ({ ...spec, status: "skipped", reason: "前序依赖未通过，保留固定分母。" })) };
}

export function auditSupportKnowledgeCall(call: Pick<EvalSpan, "id" | "input" | "knowledge" | "output" | "usage">,
  parameters: Pick<SupportExperimentParameters, "knowledgeMode" | "knowledgeSupport" | "knowledgeSupportModel" | "knowledgeSupportPrompt" | "knowledgeApplicability" | "knowledgeQueryMode">,
  expectedDatabaseError = false) {
  const trace = call.knowledge?.trace, context = call.knowledge?.context, queries = trace?.queries;
  const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input as Record<string, unknown> : undefined;
  const queryPlan = typeof queries?.evidence === "string" && queries.evidence.trim().length > 0
    && typeof queries.retrieval === "string" && queries.retrieval.trim().length > 0
    && queries.version === knowledgeQueryPlanVersion && queries.mode === parameters.knowledgeQueryMode
    && queries.evidence === context?.effectiveQuery && queries.retrieval === (parameters.knowledgeQueryMode === "separated" ? context?.retrievalQuery : context?.effectiveQuery)
    && trace?.query === queries.retrieval && trace.originalQuery === context?.originalQuery
    && input?.query === context?.effectiveQuery && input?.retrievalQuery === (context?.retrievalQuery ?? context?.effectiveQuery)
    ? "complete" : "incomplete";
  const applicability = expectedDatabaseError ? "not_evaluated" : parameters.knowledgeApplicability === "model_only" ? "not_enabled"
    : trace?.applicability?.gate?.integrity === true && trace.applicability.gate.version === (parameters.knowledgeApplicability === "declared-v2"
      ? "declared-order-preconditions-v2" : "declared-order-preconditions-v1") ? "complete" : "incomplete";
  const expectedPrompt = parameters.knowledgeSupport === "binary" ? { version: evidenceSupportPromptVersion, hash: hash(evidenceSupportPrompt) }
    : parameters.knowledgeSupportPrompt === "v6" ? { version: evidenceSupportTypedV6PromptVersion, hash: evidenceSupportTypedV6PromptHash }
      : { version: evidenceSupportTypedPromptVersion, hash: hash(evidenceSupportTypedPrompt) };
  const supportPrompt = !trace?.calls.some(provider => provider.operation === "support") ? "not_called"
    : trace.settings?.support?.promptVersion === expectedPrompt.version && trace.settings.support.promptHash === expectedPrompt.hash ? "matched" : "mismatched";
  const passed = queryPlan === "complete" && trace?.mode === parameters.knowledgeMode && trace.applicability?.mode === parameters.knowledgeApplicability
    && trace.supportProfile === parameters.knowledgeSupport && trace.supportModel === parameters.knowledgeSupportModel && Array.isArray(call.output)
    && trace.supportPrompt === parameters.knowledgeSupportPrompt && supportPrompt !== "mismatched"
    && (expectedDatabaseError ? trace.status === "unavailable" && trace.reason === "database_unavailable" && call.output.length === 0
        && trace.calls.length === 0
      : trace.status !== "unavailable" && applicability !== "incomplete" && trace.calls.every(provider => provider.status === "ok"))
    && !call.usage;
  // A plan fingerprint distinguishes inputs/configuration; it is not a substitute
  // for the corpus-backed provider-request proofs in the semantic evidence audit.
  return { spanId: call.id, kind: expectedDatabaseError ? "expected_database_error" : "knowledge_query", applicability,
    queryPlan, queryPlanHash: queries ? hash(queries) : null, supportPrompt, configuredSupportPrompt: parameters.knowledgeSupportPrompt, passed };
}

// Explicit call only. Importing this module performs no model call, DB connection, or fixture mutation.
export async function runSupportV2Live({ architecture, label, batch, parameters, experiment, dataset: selection = "development" }: {
  architecture: Architecture; label: string; batch?: EvalBatch; parameters?: Partial<SupportExperimentParameters>;
  experiment?: { id: string; variantId: string };
  dataset?: "legacy" | "development";
}): Promise<string> {
  assert.ok(["atomic", "controller"].includes(architecture)); assert.ok(label.trim() && label.length <= 120);
  const resolved = resolveSupportRunParameters(architecture, parameters);
  if (experiment) assert.ok([experiment.id, experiment.variantId].every(value => typeof value === "string" && value.trim() && value.length <= 128), "experiment id/variantId 无效");
  const { dataset, plan, path: datasetPath } = await checkSupportLiveDataset(selection);
  const configs = { order: readDatabaseConfig(), merchant: readAfterSalesDatabaseConfig(), refund: readRefundDatabaseConfig(), history: readEvalDatabaseConfig() };
  const { modelRuntime, model } = await createConfiguredModelRuntime(process.env, resolved.agentModel);
  const pool = createPool(configs.order), store = new CouponStore(pool), merchant = new AfterSalesStore(createPool(configs.merchant));
  const refunds = new RefundStore(createPool(configs.refund)), history = new EvalStore(createPool(configs.history));
  let fixture: Awaited<ReturnType<typeof createMerchantFixture>> | undefined, run: EvalRun | undefined;
  let foreignFixture: Awaited<ReturnType<typeof createMerchantFixture>> | undefined;
  let knowledgeFault: "normal" | "empty" | "error" = "normal";
  let session: Session | undefined, agent: QQAgent | undefined, capture: ReturnType<typeof captureEvaluationTurn> | undefined;
  let current: { id: string; trigger: EvalSpan["trigger"]; observedAt: string; spans: EvalSpan[]; stepTimes: Map<number, string> } | undefined;
  let group = "", sourceKey = "", hostConfirmCalls = 0, started = false, finished = false;
  const cases: EvalCase[] = [], attemptedSaves = new Set<string>();
  const receipts: Array<{ target: ReplyTarget; reply: RenderedReply; requester: string }> = [];
  const logs: string[] = [];
  let primaryFailure: unknown;
  async function saveLocal() {
    if (!run) return;
    const directory = new URL("../.runtime/support-v2-live/", import.meta.url);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL(`${run.id}.json`, directory), JSON.stringify({ run, cases }, null, 2) + "\n");
  }

  function traced<T extends object>(service: T, names: Record<string, string>, component: string): T {
    return new Proxy(service, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const name = names[String(key)];
      if (!name) return value.bind(target);
      return async (...args: unknown[]) => {
        const active = current, startedAt = performance.now();
        const input = name === "search_faq" ? { query: args[0], shopId: args[1], productId: args[2] }
          : ["get_order"].includes(name) ? { orderId: args[1] }
          : ["confirm_refund", "mark_presented"].includes(name) ? { operationId: args[2] }
          : { orderId: args[2] };
        const span: EvalSpan | undefined = active ? { id: `${active.id}:service:${active.spans.length}`, parentSpanId: active.id,
          actor: "host", trigger: active.trigger, component, name, observedAt: new Date().toISOString(), durationMs: null, input, outcome: "ok" } : undefined;
        if (span) active!.spans.push(span);
        try { const result = await value.apply(target, args); if (span) span.output = structuredClone(result ?? null); return result; }
        catch (error) {
          if (span) span.outcome = error instanceof OrderAccessError || error instanceof MerchantBusinessError || error instanceof RefundBusinessError ? "denied" : "error";
          throw error;
        } finally { if (span) span.durationMs = Math.round(performance.now() - startedAt); }
      };
    } });
  }
  const fixtureStore = new Proxy(store, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === "readKnowledgeDocuments" || key === "searchKnowledge") return async (...args: unknown[]) => {
      if (knowledgeFault === "error") throw new Error("controlled knowledge availability fault");
      const actual = await value.apply(target, args);
      return knowledgeFault === "empty" ? [] : actual;
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const read = architecture === "atomic" ? traced(fixtureStore, { getOrder: "get_order", searchKnowledge: "search_faq" }, "business-service") : fixtureStore;
  const sales = architecture === "atomic" ? traced(merchant, { prepare: "prepare_merchant_request", getTask: "get_merchant_request" }, "business-service") : merchant;
  const refundTools = architecture === "atomic" ? traced(refunds, { prepare: "prepare_refund", get: "get_refund" }, "business-service") : refunds;
  const refundHost = traced(refunds, { confirm: "confirm_refund", markPresented: "mark_presented" }, "confirmation-service");
  const knowledge = createKnowledgeService(fixtureStore, { mode: resolved.knowledgeMode, applicability: resolved.knowledgeApplicability, queryMode: resolved.knowledgeQueryMode, supportProfile: resolved.knowledgeSupport, supportModel: resolved.knowledgeSupportModel, supportPrompt: resolved.knowledgeSupportPrompt, threshold: resolved.knowledgeThreshold, timeoutMs: resolved.knowledgeTimeoutMs });
  function onControllerCall(call: SupportCall) {
    if (!current || call.parentSpanId !== current.id) return;
    const span: EvalSpan = { id: call.id, parentSpanId: current.id, actor: "host", trigger: current.trigger,
      component: "business-service", name: call.name, observedAt: call.observedAt, durationMs: call.durationMs,
      outcome: call.isError ? call.errorKind === "business_denial" ? "denied" : "error" : "ok",
      input: call.input, ...(call.output !== undefined ? { output: call.output } : {}), ...(call.knowledge ? { knowledge: call.knowledge } : {}) };
    current.spans.push(span, ...knowledgeProviderSpans(span));
  }
  async function openSession() {
    const afterSales = { store: sales, sourceKey, refunds: refundTools };
    session = architecture === "controller"
      ? await createSupportSession(fixture!.identity, read, modelRuntime, model, afterSales,
        { groupOpenid: group, repairBudget: resolved.repairBudget!, knowledge, onCall: onControllerCall })
      : await createCouponSession(fixture!.identity, read, modelRuntime, model, afterSales);
    session.subscribe(event => {
      capture?.receive(event);
      if (current && (event.type === "message_start" && event.message.role === "assistant" || event.type === "tool_execution_start")) {
        current.stepTimes.set(current.stepTimes.size + 1, new Date().toISOString());
      }
    });
    return session;
  }
  function makeAgent() {
    return new QQAgent(async () => session ?? await openSession(), async (target, _text, reply, requester) => { receipts.push({ target, reply, requester }); },
      line => logs.push(line), resolved.timeoutMs, async message => {
        const before = current?.spans.length ?? 0;
        const reply = await confirmRefundReply(refundHost, fixture!.identity, sourceKey, message.content)
          ?? await confirmMerchantReply(merchant, fixture!.identity, sourceKey, message.content);
        if (current?.spans.slice(before).some(span => span.name === "confirm_refund")) hostConfirmCalls++;
        return reply;
      }, async (_message, reply) => { await markRefundReplyPresented(refundHost, fixture!.identity, sourceKey, reply); },
      { merchantEvents: resolved.merchantEvents });
  }
  async function closeAgent() { if (agent) await agent.close(); else session?.dispose(); agent = undefined; session = undefined; }
  async function state(orderIds: string[]): Promise<SupportState> {
    const all = await Promise.all(orderIds.map(async orderId => {
      const identity = foreignFixture?.orders.includes(orderId) ? foreignFixture.identity : fixture!.identity;
      const [order, operation, [rows]] = await Promise.all([store.getOrder(identity, orderId), refunds.get(identity, merchantSourceKey(identity, group), orderId),
        pool.execute<RowDataPacket[]>("SELECT id FROM refunds WHERE order_id = ? ORDER BY id", [orderId])]);
      return { order, operation, rows };
    }));
    return { orders: all.map(({ order }) => ({ id: order.id, paidCents: order.amounts.paidCents, refundedCents: order.amounts.refundedCents })),
      operations: all.flatMap(({ operation }) => operation ? [operation] : []), refundIds: all.flatMap(({ rows }) => rows.map(row => row.id as string)) };
  }
  try {
    await history.ping(); fixture = await createMerchantFixture(Array.from({ length: dataset.cases.length + 1 }, () => "approve"), { delayMs: 5000 });
    if (dataset.cases.some(item => item.foreign)) foreignFixture = await createMerchantFixture(["approve"], { senderId: "TEST_USER2" });
    const otherOrderId = fixture.orders.at(-1)!;
    await fixture.repriceRefund(otherOrderId, 5990);
    group = `v2-${randomUUID()}`; sourceKey = merchantSourceKey(fixture.identity, group); await openSession();
    const initialOrders = await Promise.all(fixture.orders.map(id => store.getOrder(fixture!.identity, id)));
    const [[knowledge], [shops], [products], [identityBindings]] = await Promise.all([
      pool.query<RowDataPacket[]>("SELECT id, shop_id, product_id, title, body, tags, status FROM knowledge_documents WHERE status = 'active' ORDER BY id"),
      pool.query<RowDataPacket[]>("SELECT id, merchant_id, status FROM shops ORDER BY id"),
      pool.query<RowDataPacket[]>("SELECT id, shop_id, status FROM products ORDER BY id"),
      pool.execute<RowDataPacket[]>("SELECT app_id, sender_id, customer_id FROM qq_identities WHERE app_id = ? AND sender_id = ?", [fixture.identity.appId, fixture.identity.senderId]),
    ]);
    const tools = session!.getAllTools().filter(tool => session!.getActiveToolNames().includes(tool.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
    const snapshot = await createObjectiveSnapshot({ plan, dataset, tools,
      model: { provider: session!.model!.provider, id: session!.model!.id, maxTokens: session!.model!.maxTokens, thinking: session!.thinkingLevel, temperature: null },
      files: ["scripts/support-v2-live.ts", datasetPath, "data/support-v2-development.json", "scripts/merchant-test-fixture.ts", "src/support-evaluation.ts", "src/support-controller.ts", "src/support-action.ts", "src/support-context-action.ts", "src/support-session.ts", "src/support-parameters.ts",
        "src/support-context.ts", "src/support-reference-selection.ts", "src/support-evidence-context.ts", "prompts/customer-service-v2.md", "skills/shop-support-v2/SKILL.md",
        "src/knowledge-service.ts", "src/knowledge-applicability.ts", "data/knowledge-applicability.json", ...(resolved.knowledgeApplicability === "declared-v2" ? ["data/knowledge-applicability-v2.json"] : []), "src/knowledge-evaluation.ts", "src/bailian.ts", "src/evidence-support.ts", "src/evidence-acceptance.ts", "src/retrieval-ranking.ts",
        "src/agent.ts", "src/model-selection.ts", "src/qq-agent.ts", "src/coupon-store.ts", "src/knowledge-retrieval.ts", "src/refunds.ts", "src/refund-entry.ts", "src/after-sales.ts", "src/after-sales-entry.ts", "src/merchant-notifications.ts", "src/reply.ts", "src/reply-from-tools.ts"],
      business: { knowledge, shops, products, identityBindings, scenarios: initialOrders.map(order => ({ source: order.source, status: order.status, amounts: order.amounts,
        shop: order.shop, items: order.items.map(({ productId, productName, quantity, unitPriceCents, totalCents }) => ({ productId, productName, quantity, unitPriceCents, totalCents })),
        coupons: order.coupons.map(coupon => ({ status: coupon.status, valid: Boolean(coupon.expiresAt && Date.parse(coupon.expiresAt) > Date.parse(order.asOf)) })),
        payments: order.payments.map(({ status, amountCents }) => ({ status, amountCents })), refunds: order.refunds })) },
      settings: { architecture, ...resolved,
        agentPricing: modelPricing(model), agentEndpoint: model.baseUrl,
        retries: 2, knowledgeRetries: 0, compaction: false, merchantDelayMs: 5000, merchantHoldMs: 180_000, qqSend: "local substitute", fixturePreparationMeasured: false,
        datasetSelection: selection, foreignOrder: foreignFixture?.orders[0] ?? null, knowledgeFaults: "explicit case setup only; not natural outage rates" },
      measurement: "QQAgent complete turn, excluding nonce fixture preparation/state readback/restart; actual model and service spans; local QQ send substitute; 180-second fixture-only waiting window is not production SLA; no natural-language scoring." });
    if (architecture === "controller") {
      const [prompt, skill] = await Promise.all([readFile(new URL("../prompts/customer-service-v2.md", import.meta.url), "utf8"), readFile(new URL("../skills/shop-support-v2/SKILL.md", import.meta.url), "utf8")]);
      snapshot.content.prompt = prompt; snapshot.content.skill = skill; snapshot.hashes.prompt = hash(prompt); snapshot.hashes.skill = hash(skill);
    }
    snapshot.content.initialOrders = initialOrders;
    if (experiment) snapshot.content.experiment = { ...experiment };
    snapshot.hashes.checker = hash({ specs: plan, source: await readFile(new URL("../src/support-evaluation.ts", import.meta.url), "utf8"), runner: await readFile(new URL("./support-v2-live.ts", import.meta.url), "utf8") });
    run = { id: randomUUID(), suiteId: selection === "legacy" ? "support-business-v2" : "support-business-live-development-v2",
      suiteName: selection === "legacy" ? "v2共同业务开发验收" : "C1 业务开发：12语义映射与2边界场景", kind: "model", label, status: "running", startedAt: new Date().toISOString(), finishedAt: null,
      plannedCases: plan.cases.length, plannedTurns: plan.cases.reduce((sum, item) => sum + item.turns.length, 0), snapshot, metrics: null, ...(batch ? { batch } : {}) };
    await history.startRun(run); started = true; console.log(`[support-v2] ${architecture} run=${run.id}`);
    for (const [caseIndex, example] of dataset.cases.entries()) {
      await closeAgent(); group = `v2-${run.id}-${example.id}`; sourceKey = merchantSourceKey(fixture.identity, group);
      knowledgeFault = example.knowledge ?? "normal";
      const orderId: string = example.foreign ? foreignFixture!.orders[0]! : fixture.orders[caseIndex]!, notificationMessageId = randomUUID();
      if (example.setup !== "none") {
        const task = await merchant.request(fixture.identity, sourceKey, orderId, "行程变化", { groupOpenid: group, messageId: notificationMessageId, timestamp: new Date().toISOString() });
        await fixture.holdMerchant(orderId);
        if (example.setup === "approved") assert.ok(await merchant.applyResult({ taskId: task.taskId, orderId, status: "approved", approvedAmountCents: task.amountCents }));
      }
      if (example.operation && example.operation !== "none") {
        const operation = await refunds.prepare(fixture.identity, sourceKey, orderId);
        await refunds.markPresented(fixture.identity, sourceKey, operation.operationId);
        if (example.operation === "expired") await fixture.expireRefund(orderId);
        if (example.operation === "succeeded") await refunds.confirm(fixture.identity, sourceKey, operation.operationId);
      }
      await openSession(); agent = makeAgent();
      const item: EvalCase = { id: example.id, name: example.id, category: "v2共同业务", status: "failed", turns: [] }; cases.push(item);
      let operationId: string | undefined;
      for (const round of example.turns) {
        if (item.turns.some(turn => turn.status !== "passed")) { item.turns.push(skipped(round)); continue; }
        if (round.restart) { await closeAgent(); await openSession(); agent = makeAgent(); }
        const watchedOrders = [orderId, otherOrderId];
        const before = await state(watchedOrders), question = round.question.replaceAll("{orderId}", orderId).replaceAll("{otherOrderId}", otherOrderId).replaceAll("{operationId}", operationId ?? "missing-operation");
        const msg = inbound(question, fixture.identity.senderId, group), receiptStart = receipts.length, logStart = logs.length, confirmsBefore = hostConfirmCalls;
        const startedAt = new Date().toISOString();
        current = { id: msg.messageId!, trigger: round.source === "host" ? "confirmation" : round.source, observedAt: startedAt, spans: [], stepTimes: new Map() };
        capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
        current.spans.push({ id: current.id, parentSpanId: null, actor: "host", trigger: current.trigger, component: "qq-ingress", name: "turn", observedAt: startedAt, durationMs: null, outcome: "ok" });
        let failure = false;
        try {
          if (round.mode === "notify") await dispatchMerchantNotifications(sales, agent, fixture.identity.appId, [group]);
          else await agent.handle(msg);
        } catch { failure = true; }
        const measured = capture.finish(); capture = undefined;
        const spans = current.spans;
        const failedTools = measured.steps.filter(step => step.type === "tool" && step.isError);
        for (const step of measured.steps) {
          const [provider, ...id] = step.name.split("/");
          const observedAt = current.stepTimes.get(step.index) ?? startedAt;
          // Only attribute an unambiguous, contemporaneous typed business denial. Protocol errors remain errors.
          const serviceDenied = step.type === "tool" && failedTools.length === 1 && spans.some(span => span.component === "business-service"
            && span.outcome === "denied" && (span.name === step.name || step.name === "support_action")
            && Date.parse(span.observedAt) >= Date.parse(observedAt)
            && Date.parse(span.observedAt) <= Date.parse(observedAt) + (step.durationMs ?? 0) + 1)
            && !spans.some(span => span.component === "business-service" && span.outcome === "error");
          spans.push({ id: `${current.id}:agent:${step.index}`, parentSpanId: current.id, actor: "agent", trigger: current.trigger,
            component: step.type === "model" ? "model" : "agent-tool", name: step.name, observedAt,
            durationMs: step.durationMs, outcome: step.isError ? (step.type === "tool" && serviceDenied ? "denied" : "error") : "ok", input: step.input, output: step.output,
            ...(step.type === "model" ? { usage: { provider: provider!, model: id.join("/"), kind: "llm" as const,
              inputTokens: step.usage ? step.usage.input + step.usage.cacheRead + step.usage.cacheWrite : null,
              outputTokens: step.usage?.output ?? null, totalTokens: step.usage?.totalTokens ?? null,
              cost: step.usage?.estimatedCostCny !== undefined ? step.usage.estimatedCostCny === null ? null
                : { currency: "CNY" as const, amount: step.usage.estimatedCostCny, source: "price_estimate" as const }
                : step.usage?.estimatedCostUsd === null || step.usage?.estimatedCostUsd === undefined ? null
                : { currency: "USD" as const, amount: step.usage.estimatedCostUsd, source: "sdk_estimate" as const } } } : {}) });
        }
        spans[0]!.durationMs = measured.durationMs;
        current = undefined;
        const after = await state(watchedOrders), receipt = receipts[receiptStart], calls = spans.filter(span => span.component === "business-service");
        const knowledgeAudits = architecture !== "controller" ? [] : calls.filter(call => call.name === "search_faq")
          .map(call => auditSupportKnowledgeCall(call, resolved, example.knowledge === "error"));
        const knowledgeComplete = knowledgeAudits.every(audit => audit.passed);
        const completed = !failure && knowledgeComplete && !measured.failed && !measured.steps.some(step => step.type === "model" && step.isError)
          && !logs.slice(logStart).some(line => line.includes("model_failed") || line.includes("回复发送或确认登记失败"));
        const receiptValid = receipts.length === receiptStart + 1 && receipt?.requester === fixture.identity.senderId && receipt.target.targetId === group
          && receipt.target.msgId === (round.mode === "notify" ? notificationMessageId : msg.messageId);
        const isConfirmation = round.mode === "confirm" || round.mode === "repeat";
        const checks: EvalCheck[] = [
          { ...common[0]!, status: completed && receiptValid ? "passed" : "failed" },
          { ...common[1]!, status: hostConfirmCalls - confirmsBefore === (isConfirmation ? 1 : 0) && (!isConfirmation || measured.steps.length === 0) ? "passed" : "failed" },
        ];
        if (round.mode === "contract") {
          const expectedOrder = selection === "legacy" ? orderId : round.expect!.orderId === "{orderId}" ? orderId
            : round.expect!.orderId === "{otherOrderId}" ? otherOrderId : null;
          checks.push(...checkSupportContract({ ...round.expect!, orderId: expectedOrder }, { before, after, calls, completed }));
          if (round.expect!.operation === "prepared") {
            const operation = after.operations[0];
            const shown = operation?.status === "awaiting_confirmation" && receipt?.reply.kind === "refund_confirmation"
              && receipt.reply.button?.command === `确认退款 ${operation.operationId}`;
            if (!shown) checks.find(check => check.id === "business.terminal")!.status = "failed";
            if (operation) operationId = operation.operationId;
          }
        } else {
          const operation = after.operations[0];
          let valid = false;
          if (round.mode === "notify") {
            const task = await merchant.getTask(fixture.identity, sourceKey, orderId);
            const [rows] = await pool.execute<RowDataPacket[]>("SELECT status FROM merchant_notifications WHERE task_id = ?", [task?.taskId ?? ""]);
            valid = isDeepStrictEqual(before, after) && task?.status === "approved" && rows[0]?.status === "sent"
              && receipt?.reply.kind === "merchant_status" && !receipt.reply.button
              && !calls.some(call => ["prepare_refund", "prepare_merchant_request"].includes(call.name));
          } else if (round.mode === "agree") valid = isDeepStrictEqual(before, after) && after.refundIds.length === 0;
          else valid = operation?.operationId === operationId && operation.status === "succeeded" && operation.refundId === after.refundIds[0]
            && after.refundIds.length === 1 && after.orders[0]?.refundedCents === 7980 && receipt?.reply.kind === "refund_status"
            && (round.mode !== "repeat" || isDeepStrictEqual(before, after));
          checks.push({ ...special, status: valid ? "passed" : "failed" });
        }
        const passed = checks.every(check => check.status === "passed"); spans[0]!.outcome = completed ? "ok" : "error";
        const turn: EvalTurn = { index: round.index, question, reply: receipt?.reply.text ?? "", status: passed ? "passed" : "failed", startedAt,
          durationMs: measured.durationMs, firstTextMs: measured.firstTextMs,
          evidenceIds: [...new Set(calls.filter(call => call.name === "search_faq" && Array.isArray(call.output)).flatMap(call => (call.output as Array<{ sourceId: string }>).map(doc => doc.sourceId)))],
          checks, steps: measured.steps, spans, observations: { before, after, protocol: { rendered: receipt?.reply, route: receipt?.target, knowledgeAudits,
            action: architecture === "controller" ? getSupportResult(session!)?.action : undefined, hostConfirmCalls: hostConfirmCalls - confirmsBefore } } };
        item.turns.push(turn);
        console.log(`[support-v2] ${example.id}/${round.index} ${turn.status}`);
      }
      item.status = item.turns.every(turn => turn.status === "passed") ? "passed" : "failed";
      attemptedSaves.add(item.id); await history.saveCase(run.id, item); await saveLocal();
    }
    run.finishedAt = new Date().toISOString(); run.metrics = summarizeEvaluation(cases);
    await history.finishRun(run.id, "completed", run.finishedAt, run.metrics); finished = true;
    run.status = "completed"; await saveLocal();
    console.log(`[support-v2] run=${run.id} ${cases.filter(item => item.status === "passed").length}/${cases.length} cases`);
    return run.id;
  } catch (error) {
    primaryFailure = error;
    if (run && started && !finished) {
      for (const item of cases) if (!attemptedSaves.has(item.id)) {
        attemptedSaves.add(item.id);
        try { await history.saveCase(run.id, item); } catch { /* Preserve unknown write outcome; never retry INSERT. */ }
      }
      run.finishedAt = new Date().toISOString(); run.metrics = summarizeEvaluation(cases); run.status = "failed";
      run.error = "运行或持久化中断；缺项保留为missing，未知写入不重试。";
      try { await history.finishRun(run.id, "failed", run.finishedAt, run.metrics, run.error); } catch { /* Original failure remains primary. */ }
      try { await saveLocal(); } catch { /* Original failure remains primary. */ }
    }
    throw error;
  } finally {
    current = undefined; capture = undefined;
    const cleanup: unknown[] = [];
    try { await closeAgent(); } catch (error) { cleanup.push(error); }
    try { await fixture?.cleanup(); } catch (error) { cleanup.push(error); }
    try { await foreignFixture?.cleanup(); } catch (error) { cleanup.push(error); }
    const closed = await Promise.allSettled([store.close(), merchant.close(), refunds.close(), history.close()]);
    cleanup.push(...closed.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    if (cleanup.length && !primaryFailure) throw new AggregateError(cleanup, "v2验收清理失败");
    if (cleanup.length && primaryFailure) console.error("[support-v2] 原始失败后另有清理失败，请检查本次fixture。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (!args.includes("--live")) {
    const { plan } = await checkSupportLiveDataset();
    console.log(`v2真实入口就绪：${plan.cases.length}案例/${plan.cases.reduce((sum, item) => sum + item.turns.length, 0)}轮；未连接数据库或调用模型。需显式 --live --architecture atomic|controller --repeat 3。`);
  } else {
    const flags = ["--architecture", "--repeat", "--label", "--dataset", "--agent-model", "--knowledge-mode", "--knowledge-support", "--knowledge-support-model", "--knowledge-support-prompt", "--applicability", "--query-mode", "--knowledge-threshold", "--knowledge-timeout-ms"];
    assert.ok(args.every((arg, index) => arg === "--live" || flags.includes(arg) || flags.includes(args[index - 1] ?? "")), "未知参数");
    const value = (name: string) => args[args.indexOf(name) + 1];
    const architecture = value("--architecture"); assert.ok(architecture === "atomic" || architecture === "controller", "必须明确选择architecture");
    const repeat = args.includes("--repeat") ? Number(value("--repeat")) : 3; assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 3);
    const label = args.includes("--label") ? value("--label")! : `v2 ${architecture} 开发验收`;
    const dataset = args.includes("--dataset") ? value("--dataset") : "development"; assert.ok(dataset === "legacy" || dataset === "development");
    const parameters: Partial<SupportExperimentParameters> = {
      ...(args.includes("--agent-model") ? { agentModel: value("--agent-model") as SupportExperimentParameters["agentModel"] } : {}),
      ...(args.includes("--knowledge-mode") ? { knowledgeMode: value("--knowledge-mode") as SupportExperimentParameters["knowledgeMode"] } : {}),
      ...(args.includes("--knowledge-support") ? { knowledgeSupport: value("--knowledge-support") as SupportExperimentParameters["knowledgeSupport"] } : {}),
      ...(args.includes("--applicability") ? { knowledgeApplicability: value("--applicability") as SupportExperimentParameters["knowledgeApplicability"] } : {}),
      ...(args.includes("--query-mode") ? { knowledgeQueryMode: value("--query-mode") as SupportExperimentParameters["knowledgeQueryMode"] } : {}),
      ...(args.includes("--knowledge-support-model") ? { knowledgeSupportModel: value("--knowledge-support-model") as SupportExperimentParameters["knowledgeSupportModel"] } : {}),
      ...(args.includes("--knowledge-support-prompt") ? { knowledgeSupportPrompt: value("--knowledge-support-prompt") as SupportExperimentParameters["knowledgeSupportPrompt"] } : {}),
      ...(args.includes("--knowledge-threshold") ? { knowledgeThreshold: Number(value("--knowledge-threshold")) } : {}),
      ...(args.includes("--knowledge-timeout-ms") ? { knowledgeTimeoutMs: Number(value("--knowledge-timeout-ms")) } : {}),
    };
    const batchId = randomUUID();
    for (let repetition = 1; repetition <= repeat; repetition++) await runSupportV2Live({ architecture, label, dataset, parameters, batch: { id: batchId, repetition, plannedRepetitions: repeat } });
  }
}
