import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPool, type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Api, type Model } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createCouponSession, createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply, merchantSourceKey } from "../src/after-sales-entry.ts";
import { contentHash } from "../src/bailian.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalCase, type EvalRun } from "../src/evaluation.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { rankKnowledge, rankKnowledgeBaseline } from "../src/knowledge-retrieval.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import { modelPricing, resolveModelSelection } from "../src/model-selection.ts";
import { createModelRequestFetch, ModelRequestNotDispatchedError, readModelTaskLimits, withModelTask, type ModelTaskSummary } from "../src/model-request-budget.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import { renderReply, type Reply } from "../src/reply.ts";
import type { C1AnswerReview } from "./c1-session-validation-check.ts";
import { createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";
import { jointCheckerRevision, jointChecks, jointLimits, jointPlanPath, jointRoot, jointSourceHashes, jointTools, loadJointPlan, manifestHash,
  plannedJointRows, summarizeJoint, validateJointPlan, jointReviewPassed,
  type JointCase, type JointEvidence, type JointFacts, type JointManifest, type JointReceipt, type JointRound, type JointTurn } from "./stable-joint-contract.ts";

const modelSnapshot = (model: Model<Api>) => ({ provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
  maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost });
export function checkJointDatabaseTargets(configs: PoolOptions[]) {
  assert.ok(configs.length >= 3);
  for (const config of configs) assert.ok(["127.0.0.1", "localhost"].includes(String(config.host)) && Number(config.port) === 13306
    && config.database === "dave_agent" && !config.socketPath && config.multipleStatements === false,
  "M1 only allows local Docker :13306/dave_agent; target validation precedes fixture writes/live markers");
}
async function databasePreflight(configs: { merchant: PoolOptions; history: PoolOptions }, owned: string[] = []) {
  const merchant = createPool(configs.merchant), history = createPool(configs.history);
  try {
    const scope = owned.length ? ` AND r.order_id NOT IN (${owned.map(() => "?").join(",")})` : "";
    const [[tasks], [notices], [runs]] = await Promise.all([
      merchant.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM merchant_requests r WHERE r.status = 'pending'${scope}`, owned),
      merchant.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM merchant_notifications n JOIN merchant_requests r ON r.task_id = n.task_id
        WHERE n.status = 'pending' AND r.status <> 'pending'${scope}`, owned),
      history.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM eval_runs WHERE JSON_UNQUOTE(JSON_EXTRACT(record, '$.status')) = 'running'"),
    ]);
    const counts = { pendingTasks: Number(tasks[0]!.n), terminalNotifications: Number(notices[0]!.n), evaluationRunning: Number(runs[0]!.n) };
    assert.ok(Object.values(counts).every(n => n === 0), "M1 requires an idle local DB: unrelated pending tasks, ready notifications and running evaluations must all be zero");
    return { observedAt: new Date().toISOString(), ...counts };
  } finally { await Promise.all([merchant.end(), history.end()]); }
}
export async function freezeStableJoint(path: string) {
  const runtime = await createModelRuntime(), selected = resolveModelSelection();
  const model = runtime.getModel(selected.provider, selected.modelId);
  assert.ok(model && model.provider === "deepseek" && model.api === "openai-completions", "M1 freezes the current DeepSeek atomic default; model comparisons are a separate slice");
  const base: Omit<JointManifest, "hash"> = { version: 1, frozenAt: new Date().toISOString(), checkerRevision: jointCheckerRevision, plan: await loadJointPlan(), sourceHashes: await jointSourceHashes(),
    git: { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: jointRoot, encoding: "utf8" }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: jointRoot, encoding: "utf8" }).trim()) },
    dependencies: await readC1ValidationDependencies(), configuration: { architecture: "atomic", knowledge: "lexical", model: modelSnapshot(model),
      tools: jointTools, limits: jointLimits, modelTaskLimits: readModelTaskLimits(), sessionRetries: 2, providerRetries: 0, compaction: false, qqSend: "local-receipt" } };
  const manifest: JointManifest = { ...base, hash: manifestHash(base) };
  await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ manifest: resolve(path), hash: manifest.hash, userInputs: 24, events: 2, actualHttp: 0 }));
}
async function loadManifest(path: string) {
  const manifest = JSON.parse(await readFile(path, "utf8")) as JointManifest;
  assert.equal(manifest.version, 1); assert.equal(manifest.hash, manifestHash(manifest)); validateJointPlan(manifest.plan);
  assert.deepEqual(manifest.checkerRevision, jointCheckerRevision, "Freeze a new manifest for this explicitly revised checker; preserve the old result");
  assert.deepEqual(manifest.plan, await loadJointPlan(), "Questions/rubric changed after freeze");
  assert.deepEqual(manifest.sourceHashes, await jointSourceHashes(), "Runtime, rubric or dependency declaration changed after freeze");
  assert.deepEqual(manifest.dependencies, await readC1ValidationDependencies(), "Installed runtime changed after freeze");
  assert.deepEqual(manifest.configuration.limits, jointLimits); assert.deepEqual(manifest.configuration.tools, jointTools);
  assert.deepEqual(manifest.configuration.modelTaskLimits, readModelTaskLimits(), "Production per-message HTTP budget changed after freeze");
  assert.equal(manifest.configuration.architecture, "atomic"); assert.equal(manifest.configuration.knowledge, "lexical");
  return manifest;
}
function jointModelFetch(guard: ReturnType<typeof createC1ValidationGuard>, model: Model<Api>): typeof fetch {
  // Replace the Session's wrapper rather than wrapping it again. Both counters see the same permitted transport.
  const guarded = guard.fetchFor("agent");
  const transport: typeof fetch = async (input, init) => {
    const prior = guard.requests.length;
    try { return await guarded(input, init); }
    catch (error) {
      // This runner is serial. Only a refusal before the guard appends an actual send can retract M2's reservation.
      if (guard.requests.length === prior) throw new ModelRequestNotDispatchedError();
      throw error; // A real send/network failure must keep its request and unknown charge.
    }
  };
  return createModelRequestFetch({ phase: "agent", provider: model.provider, model: model.id, format: "openai-sse", pricing: modelPricing(model),
    context: { contextWindow: model.contextWindow, maxOutputTokens: Math.min(model.maxTokens, 2048), outputTokenField: model.compat && "maxTokensField" in model.compat ? model.compat.maxTokensField : undefined } }, transport);
}
function inbound(content: string, group: string, messageId = randomUUID()): QQBotInboundMessage {
  const timestamp = new Date().toISOString(), senderId = "TEST_USER1";
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId, groupOpenid: group, messageId, content, timestamp,
    replyTarget: { scope: "group", targetId: group, msgId: messageId },
    raw: { id: messageId, content, timestamp, group_openid: group, author: { member_openid: senderId } } };
}
const fauxRefundQuery = "未核销 退款";
function scriptFaux(faux: ReturnType<typeof fauxProvider>, round: JointRound, facts: JointFacts) {
  const id = facts.order.id, scope = { shopId: facts.order.shop.id, productId: facts.order.items[0]!.productId };
  const sequence: Array<[string, Record<string, string>]> = [];
  const call = (name: string, args: Record<string, string> = { orderId: id }) => sequence.push([name, args]);
  if (["policy", "unknown", "prepare", "request-refund", "denied-refund", "claimed-approval"].includes(round.action)) {
    call("get_order"); call("search_faq", { query: round.action === "unknown" ? "停车 免费 几小时" : fauxRefundQuery, ...scope });
  }
  if (["order", "select", "fresh", "unauthorized"].includes(round.action)) call("get_order");
  if (round.action === "prepare") call("prepare_merchant_request", { orderId: id, reason: "行程变化" });
  if (["pending", "notify", "request-refund", "denied-refund", "claimed-approval", "restart-rejected"].includes(round.action)) call("get_merchant_request");
  if (round.action === "request-refund") call("prepare_refund");
  if (["restart-success", "query-none"].includes(round.action)) { call("get_refund"); call("get_order"); }
  const prose: Partial<Record<JointRound["action"], string>> = {
    policy: "此订单实付79.80元、已退0.00元，券未核销。请按本轮适用规则申请，申请不等于批准或完成退款。",
    unknown: "现有适用规则无法确认停车权益及免费时长，请自行向商家核实。",
    ambiguous: "两筆订单都是未核销，您要查询哪一个订单号？",
    unauthorized: "当前身份无法查询该订单，请核对订单号或联系人工。",
    fresh: "本轮查询券已经核销，订单主状态仍是已支付，请区分订单和券状态。",
    consent: `普通同意没有创建任务，请本人另发：确认联系商家 ${id} 原因：行程变化`,
    "query-none": "本轮未查到当前会话的退款方案，已退金额0.00元，没有退款成功或真实到账依据。",
  };
  faux.setResponses([...sequence.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })),
    fauxAssistantMessage(prose[round.action] ?? "请查看本轮查询得到的订单与处理结果；未执行真实商家联系或资金操作。")]);
}
export function reviewInputs(plan: JointManifest["plan"], rows: JointTurn[]) {
  return rows.map(row => { const round = plan.cases.find(c => c.id === row.caseId)!.turns[row.index - 1]!;
    return { caseId: row.caseId, turn: row.index, execution: row.execution, question: row.question, finalRenderedReply: row.reply,
      modelFinalText: row.modelFinalText, criteria: round.criteria, replyHash: row.replyHash,
      review: { caseId: row.caseId, turn: row.index, reviewer: "codex", forHumanReview: true, humanAcceptance: false,
        status: "unreviewed", replyHash: row.replyHash ?? contentHash(null), criteriaHash: contentHash(round.criteria), checks: [] } satisfies C1AnswerReview };
  });
}
export async function runStableJoint(mode: "db" | "live", manifestPath: string) {
  const manifest = await loadManifest(manifestPath), plan = manifest.plan;
  const configs = { order: readDatabaseConfig(), merchant: readAfterSalesDatabaseConfig(), refund: readRefundDatabaseConfig(), history: readEvalDatabaseConfig() };
  checkJointDatabaseTargets(Object.values(configs));
  const preflight = await databasePreflight(configs);
  // One live attempt per frozen manifest. Failures remain evidence; do not spend the remaining budget chasing a score.
  if (mode === "live") await writeFile(`${manifestPath}.live-started`, new Date().toISOString(), { flag: "wx" });
  const runId = randomUUID(), startedAt = new Date().toISOString();
  const guard = createC1ValidationGuard(fetch, Date.now, jointLimits), rows = plannedJointRows(plan);
  const directory = new URL(".runtime/stable-joint/", jointRoot); await mkdir(directory, { recursive: true });
  const output = new URL(`${runId}-${mode}.json`, directory);
  const run: EvalRun = { id: runId, suiteId: plan.suiteId, suiteName: "稳定atomic+lexical联合验收", kind: mode === "live" ? "model" : "engineering",
    label: `M1-${mode}`, status: "running", startedAt, finishedAt: null, plannedCases: plan.cases.length, plannedTurns: rows.length, metrics: null,
    snapshot: { gitCommit: manifest.git.commit, gitDirty: manifest.git.dirty, asOf: manifest.frozenAt,
      model: { provider: manifest.configuration.model.provider, id: manifest.configuration.model.id, maxTokens: manifest.configuration.model.maxTokens, thinking: "off", temperature: null },
      hashes: { prompt: manifest.sourceHashes["prompts/customer-service.md"]!, skill: manifest.sourceHashes["skills/shop-support/SKILL.md"]!,
        tools: contentHash(jointTools), dataset: contentHash(plan), checker: manifest.sourceHashes["scripts/stable-joint-contract.ts"]!, business: "captured-per-case" },
      content: { manifest, answerQuality: "separate-hash-bound-codex-review-for-human", defaultConfiguration: true,
        scope: mode === "live" ? "真实模型+真实MySQL合成fixture+正式QQAgent，本地送达代替真实QQ" : "Pi faux模型+真实MySQL合成fixture+正式QQAgent，无真实模型或QQ",
        measurement: "最终实际rendered reply；26计划轮含24用户输入及2事件；modelRequests为Pi assistant迭代，actualHttp由fetch边界单独记录；宿主轮无模型用量。重建对象和连接不等于OS崩溃恢复。" } } };
  const artifact = { version: 1, mode, run, manifest, preflight, dispatchPreflights: [] as Array<{ caseId: string; pendingTasks: number; terminalNotifications: number; evaluationRunning: number; observedAt: string }>,
    rows, requests: guard.requests, cleanup: [] as Array<{ caseId: string; ok: boolean }>,
    fixtures: [] as Array<{ caseId: string; orders: string[]; identity: { appId: string; senderId: string }; initial: JointFacts[] }>,
    knowledge: [] as unknown[], knowledgeStable: true, knowledgeHashes: [] as Array<{ caseId: string; before: string; after: string | null }>,
    pricing: null as unknown, actualModel: null as unknown, sourceHashesAfter: {} as Record<string, string>,
    dependenciesAfter: null as Awaited<ReturnType<typeof readC1ValidationDependencies>> | null, codeStable: false, stopReason: null as string | null,
    failure: null as string | null, usage: guard.usage(), summary: summarizeJoint(plan, rows), answerReviewInputs: reviewInputs(plan, rows),
    productionAccountingComplete: false, runIntegrityPassed: false, humanAcceptance: false, admitted: false };
  const cases = (): EvalCase[] => plan.cases.map(c => { const turns = rows.filter(r => r.caseId === c.id);
    return { id: c.id, name: c.name, category: "稳定主线联合验收", status: turns.every(t => t.status === "passed") ? "passed" : turns.every(t => t.status === "skipped") ? "skipped" : "failed", turns }; });
  async function save() {
    artifact.usage = guard.usage(); artifact.summary = summarizeJoint(plan, rows); artifact.answerReviewInputs = reviewInputs(plan, rows);
    run.metrics = summarizeEvaluation(cases());
    await writeFile(output, `${JSON.stringify({ ...artifact, cases: cases() }, null, 2)}\n`);
  }
  await save();
  let restoreStream: (() => void) | undefined;
  try {
    const runtimeConfig = mode === "live" ? await createConfiguredModelRuntime() : { modelRuntime: await createModelRuntime(), model: undefined };
    const modelRuntime = runtimeConfig.modelRuntime, faux = mode === "db" ? fauxProvider({ tokensPerSecond: 0 }) : undefined;
    if (faux) modelRuntime.registerNativeProvider(faux.provider);
    const model = runtimeConfig.model ?? faux!.getModel(); artifact.actualModel = modelSnapshot(model);
    if (mode === "live") {
      assert.deepEqual(modelSnapshot(model), manifest.configuration.model); artifact.pricing = modelPricing(model);
      const original = modelRuntime.streamSimple.bind(modelRuntime);
      modelRuntime.streamSimple = (selected, transcript, options) => original(selected, transcript, { ...options, maxRetries: 0, fetch: jointModelFetch(guard, selected) });
      restoreStream = () => { modelRuntime.streamSimple = original; };
    }
    for (const example of plan.cases) {
      if (guard.stopped()) break;
      let fixture: Awaited<ReturnType<typeof createMerchantFixture>> | undefined;
      let orderPool: Pool | undefined, merchantPool: Pool | undefined, store: CouponStore | undefined, merchant: AfterSalesStore | undefined, refunds: RefundStore | undefined;
      let session: Awaited<ReturnType<typeof createCouponSession>> | undefined, agent: QQAgent | undefined;
      let capture: ReturnType<typeof captureEvaluationTurn> | undefined, activeRow: JointTurn | undefined;
      let receipts: JointReceipt[] = [], delivered: Reply[] = [], handled = 0, agentUsageCursor = 0;
      const identity = { appId: "TEST_APP", senderId: "TEST_USER1" }, group = `joint-${runId}-${example.id}`, sourceKey = merchantSourceKey(identity, group);
      function connect() {
        orderPool = createPool(configs.order); merchantPool = createPool(configs.merchant);
        store = new CouponStore(orderPool); merchant = new AfterSalesStore(merchantPool); refunds = new RefundStore(createPool(configs.refund));
      }
      async function closeAgent() { if (agent) await agent.close(); else session?.dispose(); agent = undefined; session = undefined; }
      async function closeStores() {
        const settled = await Promise.allSettled([store?.close(), merchant?.close(), refunds?.close()]);
        assert.ok(settled.every(r => r.status === "fulfilled"), "fixture_connections_close_failed");
      }
      async function createAgent() {
        session = await createCouponSession(identity, store!, modelRuntime, model, { store: merchant!, sourceKey, refunds });
        session.subscribe(event => {
          capture?.receive(event);
          if (activeRow && (event.type === "auto_retry_start" || event.type === "auto_retry_end")) activeRow.sdkRetries.push({ type: event.type, attempt: event.attempt });
          if (mode === "live" && activeRow && event.type === "message_end" && event.message.role === "assistant") {
            const sends = guard.requests.map((request, i) => ({ request, i })).filter(x => x.i >= agentUsageCursor && x.request.requestId === `${runId}:${activeRow!.caseId}:${activeRow!.index}`);
            // Map each assistant completion separately. Provider retries are disabled; SDK retries create separate completions.
            // Ambiguous/missing provider usage never becomes invented zero-cost or reassigned retry usage.
            if (sends.length === 1) {
              const usage = event.message.usage, consistent = usage && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens > 0
                && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)
                && usage.input + usage.output + usage.cacheRead + usage.cacheWrite === usage.totalTokens;
              guard.record(sends[0]!.i, consistent ? usage.totalTokens : null, consistent && Number.isFinite(usage.cost?.total) && usage.cost.total >= 0 ? usage.cost.total : null);
            }
            agentUsageCursor = guard.requests.length;
          }
        });
        agent = new QQAgent(async () => session!, async (target, text, rendered, requesterId) => {
          assert.equal(text, rendered.text); receipts.push({ target, requesterId, observedAt: new Date().toISOString(), rendered: structuredClone(rendered) });
        }, text => {
          if (activeRow && text.startsWith("[model-task] ")) {
            const summary = JSON.parse(text.slice("[model-task] ".length)) as ModelTaskSummary;
            if (summary.version === "model-task-v1") activeRow.modelTasks.push(summary);
          }
        }, jointLimits.turnTimeoutMs, async msg => {
          const reply = await confirmRefundReply(refunds!, identity, sourceKey, msg.content)
            ?? await confirmMerchantReply(merchant!, identity, sourceKey, msg.content, { groupOpenid: group, messageId: msg.messageId, timestamp: msg.timestamp });
          if (reply !== undefined) handled++; return reply;
        }, async (_msg, reply) => { await markRefundReplyPresented(refunds!, identity, sourceKey, reply); delivered.push(structuredClone(reply)); },
        { resolveBinding: () => store!.resolveBinding(identity) });
      }
      async function facts(): Promise<JointFacts[]> {
        return Promise.all(fixture!.orders.map(async orderId => {
          // Unauthorized case uses owner only for the evaluator's synthetic DB evidence, never for Agent identity.
          const [order, task, operation, [refundRows]] = await Promise.all([store!.getOrder(fixture!.identity, orderId), merchant!.getTask(identity, sourceKey, orderId),
            refunds!.get(identity, sourceKey, orderId), orderPool!.execute<RowDataPacket[]>("SELECT id FROM refunds WHERE order_id = ? ORDER BY id", [orderId])]);
          const [notifications] = await merchantPool!.execute<RowDataPacket[]>("SELECT status, group_openid, sender_id, message_id FROM merchant_notifications WHERE task_id = ?", [task?.taskId ?? ""]);
          const notice = notifications[0];
          return { order, task: task ?? null, operation: operation ?? null, refundIds: refundRows.map(r => r.id as string),
            notification: notice ? { status: notice.status as string, group: notice.group_openid as string, sender: notice.sender_id as string, messageId: notice.message_id as string } : null };
        }));
      }
      async function readKnowledge() {
        const [knowledge] = await orderPool!.query<RowDataPacket[]>("SELECT id, shop_id, product_id, title, body, tags, status FROM knowledge_documents WHERE status = 'active' ORDER BY id");
        return knowledge;
      }
      let cleanupOkay = true;
      try {
        await databasePreflight(configs);
        fixture = await createMerchantFixture(Array.from({ length: example.orderCount }, () => example.outcome),
          { delayMs: 5000, senderId: example.id === "unauthorized" ? "TEST_USER2" : "TEST_USER1" });
        connect(); const initial = await facts();
        artifact.fixtures.push({ caseId: example.id, orders: fixture.orders, identity: fixture.identity, initial });
        const knowledge = await readKnowledge(); assert.ok(knowledge.length);
        if (!artifact.knowledge.length) {
          artifact.knowledge = knowledge;
          const targetOrder = initial[0]!.order;
          assert.ok(!knowledge.filter(d => (d.shop_id === null || d.shop_id === targetOrder.shop.id)
            && (d.product_id === null || d.product_id === targetOrder.items[0]!.productId)).some(d => /停车/u.test(String(d.body))),
          "Unknown-rule fixture now has matching parking policy; revise/version before another batch");
          run.snapshot.hashes.business = contentHash(knowledge);
        }
        artifact.knowledgeHashes.push({ caseId: example.id, before: contentHash(knowledge), after: null });
        if (!isDeepStrictEqual(knowledge, artifact.knowledge)) { artifact.knowledgeStable = false; throw new Error("knowledge_changed"); }
        await save(); // Corpus, fixture and frozen parameters are persisted before this case can call a provider.
        await createAgent(); let dependencyPassed = true;
        for (const [index, round] of example.turns.entries()) {
          const row = rows.find(r => r.caseId === example.id && r.index === index + 1)!;
          if (artifact.failure || !dependencyPassed || guard.stopped()) { row.error = artifact.failure ?? guard.stopped() ?? "prior_case_contract_failed"; continue; }
          const target: string = fixture.orders[0]!;
          try {
            if (round.action === "fresh") await fixture.invalidateRefund(target, "redeemed");
            if (round.action.startsWith("restart-")) { await closeAgent(); await closeStores(); connect(); await createAgent(); }
            // Keep the synthetic merchant waiting while model replies run; no claim about external merchant timing/SLA.
            const currentTask = await merchant!.getTask(identity, sourceKey, target);
            if (currentTask?.status === "pending") await fixture.holdMerchant(target, 180_000);
            if (round.action === "notify") {
              try { artifact.dispatchPreflights.push({ caseId: example.id, ...await databasePreflight(configs, fixture.orders) }); }
              catch { artifact.failure = "dispatch_preflight_failed"; throw new Error("dispatch_preflight_failed"); }
              assert.ok(currentTask); assert.ok(await merchant!.applyResult({ taskId: currentTask.taskId, orderId: target,
                status: example.outcome === "approve" ? "approved" : "rejected", approvedAmountCents: example.outcome === "approve" ? 7980 : null }));
            }
            const before = await facts(), operationId = before[0]!.operation?.operationId;
            row.question = round.question.replaceAll("{orderId}", target).replaceAll("{operationId}", operationId ?? "{operationId}");
            assert.ok(!/\{[^{}]+\}/.test(row.question), "Missing required persisted operation ID");
            receipts = []; delivered = []; handled = 0; activeRow = row;
            capture = captureEvaluationTurn(`${model.provider}/${model.id}`, round.action === "unauthorized" ? target : undefined);
            const previousMessages = session!.messages.length, toolsBefore = session!.getActiveToolNames().slice(), requestStart = guard.requests.length;
            agentUsageCursor = requestStart;
            const abort = new AbortController(), requestId = `${runId}:${example.id}:${index + 1}`;
            guard.setActive({ caseId: example.id, turn: index + 1, requestId, signal: abort.signal });
            const timer = setTimeout(() => { abort.abort(); void session?.abort().catch(() => {}); }, Math.min(jointLimits.turnTimeoutMs, guard.remainingMs()));
            row.startedAt = new Date().toISOString(); row.execution = "failed"; delete row.error;
            let failure: string | undefined, duplicateSuppressed = false;
            const message = inbound(row.question, group);
            try {
              if (faux) scriptFaux(faux, round, before[0]!);
              if (round.source === "event") {
                await dispatchMerchantNotifications(merchant!, agent!, identity.appId, [group]);
                const sends = receipts.length, calls = guard.requests.length, messages = session!.messages.length;
                await dispatchMerchantNotifications(merchant!, agent!, identity.appId, [group]);
                duplicateSuppressed = receipts.length === sends && guard.requests.length === calls && session!.messages.length === messages;
              } else await agent!.handle(message);
              if (abort.signal.aborted) failure = "turn_deadline";
            } catch { failure = "agent_or_dispatch_failed"; }
            finally { clearTimeout(timer); abort.abort(); guard.setActive(undefined); }
            const measured = capture.finish(); capture = undefined; activeRow = undefined;
            row.steps = measured.steps; if (mode === "db") for (const step of row.steps) if (step.type === "model") step.usage = null;
            row.durationMs = measured.durationMs; row.firstTextMs = measured.firstTextMs; row.requests = structuredClone(guard.requests.slice(requestStart));
            const last = session!.messages.slice(previousMessages).findLast(m => m.role === "assistant");
            row.modelFinalText = last?.role === "assistant" ? last.content.filter(p => p.type === "text").map(p => p.text).join("") : null;
            row.reply = receipts.map(r => r.rendered.text).join("\n"); row.replyHash = row.reply ? contentHash(row.reply) : null;
            const after = await facts();
            row.evidence = { completed: !failure && !measured.failed && (!row.steps.some(s => s.type === "model") || last?.stopReason === "stop"), before, after,
              receipts: structuredClone(receipts), delivered: structuredClone(delivered), group, sender: identity.senderId,
              messageId: round.source === "event" ? before[0]!.notification!.messageId : message.messageId,
              toolsBefore, toolsAfter: session!.getActiveToolNames().slice(), hostHandled: handled, duplicateSuppressed,
              restarted: round.action.startsWith("restart-"), expectedStatus: example.outcome === "approve" ? "approved" : "rejected", expectedOrderId: target };
            row.execution = row.evidence.completed ? "completed" : "failed";
            row.checks = jointChecks(round, row); row.status = row.checks.every(c => c.status === "passed") ? "passed" : "failed";
            if (failure) row.error = failure;
            dependencyPassed = row.status === "passed";
            console.log(`[stable-joint:${mode}] ${example.id}/${index + 1}: ${row.status}; ${row.checks.filter(c => c.status === "failed").map(c => c.id).join(",")}`);
            await save();
          } catch { row.execution = "failed"; row.status = "failed"; row.error = "setup_or_evidence_failed"; dependencyPassed = false; await save(); }
        }
      } catch { artifact.failure = "case_setup_or_persistence_failed"; }
      finally {
        capture = undefined; activeRow = undefined; guard.setActive(undefined);
        try { await closeAgent(); } catch { cleanupOkay = false; }
        try {
          if (orderPool) {
            const knowledge = await readKnowledge(), snapshot = artifact.knowledgeHashes.find(h => h.caseId === example.id);
            if (snapshot) snapshot.after = contentHash(knowledge);
            if (!isDeepStrictEqual(knowledge, artifact.knowledge)) { artifact.knowledgeStable = false; artifact.failure = "knowledge_changed"; }
          }
        } catch { artifact.knowledgeStable = false; artifact.failure = "knowledge_recheck_failed"; }
        const settled = await Promise.allSettled([closeStores(), fixture?.cleanup()]);
        if (settled.some(r => r.status === "rejected")) cleanupOkay = false;
        artifact.cleanup.push({ caseId: example.id, ok: cleanupOkay });
        if (!cleanupOkay) artifact.failure = "cleanup_failed";
        await save();
      }
      if (artifact.failure) break;
    }
  } catch { artifact.failure ??= "configuration_or_execution_failed"; }
  finally {
    guard.seal(); restoreStream?.(); artifact.stopReason = guard.stopped();
    for (const row of rows) if (row.error === "not_started") row.error = artifact.stopReason ?? artifact.failure ?? "not_executed";
    try {
      artifact.sourceHashesAfter = await jointSourceHashes(); artifact.dependenciesAfter = await readC1ValidationDependencies();
      artifact.codeStable = isDeepStrictEqual(manifest.sourceHashes, artifact.sourceHashesAfter) && isDeepStrictEqual(manifest.dependencies, artifact.dependenciesAfter);
    } catch { artifact.failure ??= "post_snapshot_failed"; }
    artifact.usage = guard.usage(); artifact.summary = summarizeJoint(plan, rows);
    artifact.productionAccountingComplete = rows.filter(r => r.execution !== "not_run").every(r => r.modelTasks.length === 1
      && isDeepStrictEqual(r.modelTasks[0]!.limits, manifest.configuration.modelTaskLimits)
      && r.modelTasks[0]!.httpRequests === r.requests.length
      && (mode === "db" || r.modelTasks[0]!.unknownUsageAttempts === 0 && r.modelTasks[0]!.unknownCostAttempts === 0));
    artifact.runIntegrityPassed = artifact.codeStable && artifact.knowledgeStable && artifact.productionAccountingComplete && !artifact.failure && rows.every(r => r.execution !== "not_run")
      && artifact.cleanup.length === plan.cases.length && artifact.cleanup.every(c => c.ok)
      && (mode === "db" || artifact.usage.agent.unknownCosts === 0 && artifact.usage.agent.totalTokens !== null)
      && (!artifact.stopReason || rows.every(r => r.execution === "completed") && artifact.stopReason === "operation_request_limit");
    run.status = artifact.runIntegrityPassed && artifact.summary.engineeringPassed === rows.length ? "completed" : "failed";
    run.finishedAt = new Date().toISOString(); await save();
  }
  console.log(JSON.stringify({ artifact: fileURLToPath(output), mode, summary: artifact.summary, usage: artifact.usage,
    integrity: artifact.runIntegrityPassed, stopReason: artifact.stopReason, failure: artifact.failure, admitted: false }));
  return { path: fileURLToPath(output), passed: run.status === "completed" };
}

export async function scoreStableJoint(resultPath: string, reviewPath: string) {
  const artifact = JSON.parse(await readFile(resultPath, "utf8")) as JointArtifactForReview;
  const reviews = JSON.parse(await readFile(reviewPath, "utf8")) as { artifactHash: string; reviews: C1AnswerReview[] };
  assert.equal(reviews.artifactHash, contentHash(artifact), "Review must bind the entire executed artifact, not just one reply");
  assert.equal(artifact.manifest.hash, manifestHash(artifact.manifest)); validateJointPlan(artifact.manifest.plan);
  assert.deepEqual(artifact.manifest.checkerRevision, jointCheckerRevision, "Do not silently rescore a historical run with another checker revision");
  const summary = summarizeJoint(artifact.manifest.plan, artifact.rows, reviews.reviews);
  const result = { artifact: resolve(resultPath), artifactHash: contentHash(artifact), summary, mode: artifact.mode,
    humanAcceptance: false, admitted: artifact.mode === "live" && artifact.runIntegrityPassed && summary.completeDenominator && summary.jointPassed === summary.plannedTurns };
  const path = `${reviewPath}.score.json`; await writeFile(path, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify({ path, ...result }));
  return result;
}
type JointArtifactForReview = { mode: "db" | "live"; manifest: JointManifest; rows: JointTurn[]; runIntegrityPassed: boolean };
async function writeReviewTemplate(resultPath: string, reviewPath: string) {
  const artifact = JSON.parse(await readFile(resultPath, "utf8")) as JointArtifactForReview;
  const inputs = reviewInputs(artifact.manifest.plan, artifact.rows);
  await writeFile(reviewPath, `${JSON.stringify({ artifactHash: contentHash(artifact), reviews: inputs.map(i => i.review) }, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ reviews: resolve(reviewPath), count: inputs.length, humanAcceptance: false }));
}

export async function checkStableJoint() {
  const db = { host: "127.0.0.1", port: 13306, database: "dave_agent", multipleStatements: false };
  checkJointDatabaseTargets([db, db, db]);
  for (const wrong of [{ ...db, host: "remote.example" }, { ...db, port: 3306 }, { ...db, database: "production" }, { ...db, socketPath: "/tmp/mysql.sock" }]) {
    assert.throws(() => checkJointDatabaseTargets([db, wrong, db]), /local Docker/);
  }
  const plan = await loadJointPlan(), rows = plannedJointRows(plan);
  const seed = JSON.parse(await readFile(new URL("data/acceptance-online.json", jointRoot), "utf8")) as { documents: RetrievalDocument[] };
  const scopedSeed = seed.documents.filter(d => d.status === "active" && (d.shopId === null || d.shopId === "shop-demo-1")
    && (d.productId === null || d.productId === "product-demo-1"));
  for (const rank of [rankKnowledgeBaseline, rankKnowledge]) {
    const ids = rank(fauxRefundQuery, scopedSeed).slice(0, 5).map(d => d.id);
    assert.ok(ids.includes("KB-REFUND-UNUSED"), "The unchanged faux refund query retrieves the applicable refund policy");
  }
  assert.ok(!rankKnowledge(fauxRefundQuery, scopedSeed).slice(0, 5).some(d => d.id === "KB-PRODUCT-LUNCH"),
    "Reproduce the v1 current-lexical false negative: applicable refund evidence without a package-description hit");
  const refundPolicy = seed.documents.find(d => d.id === "KB-REFUND-UNUSED")!;
  assert.ok(refundPolicy.body.includes("已支付、未核销且尚未过期的团购券可以申请退款。"));
  const refundEvidence = { sourceId: refundPolicy.id, body: refundPolicy.body, scope: { shopId: refundPolicy.shopId, productId: refundPolicy.productId } };
  assert.equal(rows.length, 26); assert.equal(summarizeJoint(plan, rows).executed, 0);
  assert.equal(summarizeJoint(plan, rows.slice(1)).completeDenominator, false);
  const round = plan.cases[0]!.turns[0]!, row = rows[0]!;
  row.reply = "仍需本人确认，尚未退款。"; row.replyHash = contentHash(row.reply);
  const review: C1AnswerReview = { caseId: row.caseId, turn: row.index, reviewer: "codex", forHumanReview: true, humanAcceptance: false,
    status: "passed", replyHash: row.replyHash, criteriaHash: contentHash(round.criteria),
    checks: round.criteria.map(c => ({ criterionId: c.id, passed: true, reasoning: "pure synthetic scorer calibration; never real acceptance" })) };
  assert.equal(jointReviewPassed(round, row, review), true);
  assert.equal(jointReviewPassed(round, { ...row, reply: "已退款99999元并真实到账" }, review), false, "Correct tools cannot approve a different wrong final reply");
  assert.equal(jointReviewPassed(round, { ...row, reply: "", replyHash: null }, review), false);
  assert.equal(jointReviewPassed(round, row, { ...review, replyHash: "0".repeat(64) }), false);
  assert.equal(jointReviewPassed(round, row, { ...review, criteriaHash: "0".repeat(64) }), false);
  assert.equal(jointReviewPassed(round, row, { ...review, checks: review.checks.slice(1) }), false);
  assert.equal(jointReviewPassed(round, row, { ...review, checks: review.checks.map(c => ({ ...c, passed: false })) }), false);
  assert.equal(summarizeJoint(plan, rows, [review]).jointPassed, 0, "Reply review cannot replace missing execution evidence");
  const missing = { ...row, execution: "completed" as const, evidence: null };
  assert.ok(jointChecks(round, missing).some(c => c.status === "failed"));
  // A passing tool/DB trace is intentionally insufficient to certify arbitrary answer prose.
  const facts = { order: { source: "demo-database", id: "COUPON-2101", asOf: "2026-10-10T00:00:00.000Z", status: "paid",
    amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, shop: { id: "shop-test" },
    items: [{ productId: "product-test" }], coupons: [{ status: "unused", expiresAt: "2099-01-01T00:00:00.000Z" }], refunds: [] }, task: null, operation: null, refundIds: [], notification: null } as unknown as JointFacts;
  const delivered: Reply = { kind: "order", text: "本轮可按适用规则申请，尚未退款。", orders: [{ id: facts.order.id, status: "paid", paidCents: 7980, refundedCents: 0, couponStatuses: ["unused"] }], evidenceIds: ["KB-UNIT"] };
  const rendered = renderReply(delivered);
  const valid: JointTurn = { ...row, execution: "completed", reply: rendered.text, replyHash: contentHash(rendered.text),
    steps: [{ index: 1, type: "model", name: "synthetic", durationMs: 1, isError: false, usage: null },
      { index: 2, type: "tool", name: "get_order", durationMs: 1, isError: false, input: { orderId: facts.order.id }, output: { content: [{ type: "text", text: JSON.stringify(facts.order) }] } },
      { index: 3, type: "tool", name: "search_faq", durationMs: 1, isError: false, input: { query: "退款", shopId: "shop-test", productId: "product-test" }, output: { content: [{ type: "text", text: JSON.stringify([refundEvidence]) }] } }],
    evidence: { completed: true, before: [facts], after: [structuredClone(facts)], delivered: [delivered],
      receipts: [{ rendered, target: { scope: "group", targetId: "synthetic-group", msgId: "synthetic-message" }, requesterId: "synthetic-actor", observedAt: "2026-10-10T00:00:00.000Z" }],
      group: "synthetic-group", sender: "synthetic-actor", messageId: "synthetic-message", toolsBefore: jointTools, toolsAfter: jointTools, hostHandled: 0,
      duplicateSuppressed: false, restarted: false, expectedOrderId: facts.order.id, expectedStatus: "approved" } };
  assert.ok(jointChecks(round, valid).every(c => c.status === "passed"));
  const onlyPackage = structuredClone(valid), packageDoc = seed.documents.find(d => d.id === "KB-PRODUCT-LUNCH")!;
  onlyPackage.steps[2]!.output = { content: [{ type: "text", text: JSON.stringify([{ sourceId: packageDoc.id, body: packageDoc.body,
    scope: { shopId: packageDoc.shopId, productId: packageDoc.productId } }]) }] };
  assert.equal(jointChecks(round, onlyPackage).find(c => c.id === "trace.refund-evidence")?.status, "failed", "Package description cannot establish refund permission");
  const wrongScope = structuredClone(valid);
  wrongScope.steps[2]!.output = { content: [{ type: "text", text: JSON.stringify([{ ...refundEvidence, scope: { shopId: "other-shop", productId: "other-product" } }]) }] };
  assert.equal(jointChecks(round, wrongScope).find(c => c.id === "trace.refund-evidence")?.status, "failed");
  for (const change of ["redeemed", "expired"] as const) {
    const inapplicable = structuredClone(valid), coupon = inapplicable.evidence!.after[0]!.order.coupons[0]!;
    if (change === "redeemed") coupon.status = "redeemed"; else coupon.expiresAt = "2020-01-01T00:00:00.000Z";
    assert.equal(jointChecks(round, inapplicable).find(c => c.id === "trace.refund-evidence")?.status, "failed", `${change} cannot borrow the unused/unexpired policy`);
  }
  const boundReview = { ...review, replyHash: valid.replyHash! };
  assert.equal(jointReviewPassed(round, valid, boundReview), true);
  const wrong = structuredClone(valid), wrongCard = wrong.evidence!.delivered[0]!;
  assert.equal(wrongCard.kind, "order"); if (wrongCard.kind === "order") wrongCard.text = "已经退款99999元，真实资金到账。";
  wrong.evidence!.receipts[0]!.rendered = renderReply(wrongCard); wrong.reply = wrong.evidence!.receipts[0]!.rendered.text; wrong.replyHash = contentHash(wrong.reply);
  assert.ok(jointChecks(round, wrong).every(c => c.status === "passed"), "Objective facts deliberately do not judge free prose");
  assert.equal(jointReviewPassed(round, wrong, boundReview), false, "Prior passing reply review must not be reused for changed/wrong prose");
  const absent = structuredClone(valid); delete absent.steps[1]!.output;
  assert.ok(jointChecks(round, absent).some(c => c.status === "failed"), "A successful tool flag without its result is insufficient");
  let sends = 0, clock = 0;
  const active = { caseId: "retry-calibration", turn: 1, requestId: "unit", signal: new AbortController().signal };
  const limits = { ...jointLimits, requests: { agent: 1, support: 0, rerank: 0 } };
  const guard = createC1ValidationGuard(async () => { sends++; return new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } }); }, () => clock, limits);
  guard.setActive(active);
  // Use the installed native provider's real retry loop against a local fetch substitute. No API key or network is used.
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash"); assert.ok(model);
  await runtime.setRuntimeApiKey("deepseek", "synthetic-local-only");
  let boundaries = 0, taskSummary: ModelTaskSummary | undefined;
  await withModelTask({ requestId: "joint-retry-unit", entrypoint: "check", limits: { httpRequests: 2 }, onComplete: summary => { taskSummary = summary; } }, async () => {
    const fetcher = jointModelFetch(guard, model);
    await runtime.complete(model, { messages: [{ role: "user", content: "local retry calibration", timestamp: 0 }] },
      { maxTokens: 2048, maxRetries: 2, fetch: (...args) => { boundaries++; return fetcher(...args); } });
  });
  assert.ok(boundaries >= 2, "Native provider retries must revisit the same HTTP gate"); assert.equal(sends, 1); assert.equal(guard.requests.length, 1);
  assert.equal(taskSummary?.httpRequests, 1, "M1 refusal must not create a phantom production HTTP attempt");
  assert.equal(taskSummary?.blockedRequests, 1); assert.equal(taskSummary?.logicalCalls, 1);
  assert.equal(guard.usage().agent.estimatedCost, null); assert.equal(guard.usage().agent.unknownCosts, 1);
  const deadline = createC1ValidationGuard(async () => { sends++; return new Response("{}"); }, () => clock, jointLimits); deadline.setActive(active);
  clock = jointLimits.deadlineMs; await assert.rejects(deadline.fetchFor("agent")("https://example.invalid"), /run_deadline/); assert.equal(sends, 1);
  console.log("stable-joint checks passed: 8 cases / 24 inputs + 2 events, C1 hash-bound final reply review, missing evidence/full denominator, native provider retry HTTP cap, unknown usage/deadline; zero DB, QQ or provider network.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [action, path, other, ...rest] = process.argv.slice(2); assert.equal(rest.length, 0);
  if ((action === "--check" || action === undefined) && !path && !other) await checkStableJoint();
  else if (action === "--freeze" && path && !other) await freezeStableJoint(path);
  else if ((action === "--db" || action === "--live") && path && !other) { const result = await runStableJoint(action === "--db" ? "db" : "live", path); if (!result.passed) process.exitCode = 1; }
  else if (action === "--score" && path && other) { const result = await scoreStableJoint(path, other); if (!result.admitted) process.exitCode = 1; }
  else if (action === "--review-template" && path && other) await writeReviewTemplate(path, other);
  else throw new Error("Use --check | --freeze MANIFEST | --db MANIFEST | --live MANIFEST | --review-template RESULT REVIEWS | --score RESULT REVIEWS");
}
