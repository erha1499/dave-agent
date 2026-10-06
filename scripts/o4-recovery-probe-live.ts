import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, MerchantBusinessError, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply } from "../src/after-sales-entry.ts";
import { contentHash } from "../src/bailian.ts";
import { ConversationStateStore } from "../src/conversation-state.ts";
import { CouponStore, OrderAccessError, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, RefundBusinessError, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import type { Reply, RenderedReply } from "../src/reply.ts";
import { currentReferenceChoices, rememberReferenceChoice } from "../src/support-reference-selection.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult } from "../src/support-session.ts";
import { createC1ValidationGuard, readC1ValidationDependencies, withinTurnDeadline } from "./c1-session-validation-live.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";
import { o4RecoveryTurns, o4RecoveryText, scoreO4RecoveryTurn, fauxO4RecoveryAction } from "./o4-recovery-probe-contract.ts";

const root = new URL("../", import.meta.url), directory = new URL(".runtime/o4-recovery-probe/", root);
export const o4RecoveryLimits = { requests: { agent: 120, rerank: 0, support: 0 }, deadlineMs: 600_000,
  turnTimeoutMs: 45_000, estimatedUsd: .35, estimatedCny: .01 };
type Mode = "memory" | "mysql";
type Mapping = Parameters<typeof scoreO4RecoveryTurn>[3];
type Actual = Parameters<typeof scoreO4RecoveryTurn>[0];
type Call = Actual["calls"][number];
type Snapshot = Actual["dbBefore"] & { payments: Record<string, unknown>[]; coupons: Record<string, unknown>[]; items: Record<string, unknown>[] };
type Send = Actual["sends"][number] & { target: ReplyTarget; rendered: RenderedReply };
type Session = Awaited<ReturnType<typeof createSupportSession>>;
type Row = Actual & { mode: Mode; reason: string | null; startedAt: number; finishedAt: number;
  score: ReturnType<typeof scoreO4RecoveryTurn> | null; requests: ReturnType<typeof createC1ValidationGuard>["requests"];
  sends: Send[]; controllerCalls: unknown[]; steps: ReturnType<ReturnType<typeof captureEvaluationTurn>["finish"]>["steps"];
  sdkRetryEvents: Array<{ type: string; attempt: number }>; hostReferences: unknown[]; transcript: unknown[];
  contextBefore: unknown; contextAfter: unknown; selectionMaterial?: unknown; rawSends: unknown[]; };
const blankDb = (): Snapshot => ({ orders: [], merchantTasks: [], refundOperations: [], refunds: [], notifications: [], payments: [], coupons: [], items: [] });
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const hashFiles = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));
async function sourceFiles() {
  return [...new Set(["scripts/o4-recovery-probe-live.ts", "scripts/o4-recovery-probe-contract.ts", "scripts/merchant-test-fixture.ts",
    "scripts/c1-session-validation-live.ts", "scripts/c1-session-validation-check.ts", "scripts/c1-session-live.ts",
    "prompts/customer-service-v2.md", "skills/shop-support-v2/SKILL.md",
    ...(await readdir(new URL("src/", root))).filter(n => n.endsWith(".ts")).map(n => `src/${n}`),
    ...(await readdir(new URL("db/", root))).filter(n => n.endsWith(".sql")).map(n => `db/${n}`)])].sort();
}
const snapshotModel = (model: Awaited<ReturnType<typeof createConfiguredModelRuntime>>["model"]) => ({ provider: model.provider,
  id: model.id, api: model.api, baseUrl: model.baseUrl, maxTokens: Math.min(2048, model.maxTokens), cost: model.cost });
async function configuration(execution: "live" | "faux") {
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash"); assert.ok(model);
  return { execution, architecture: "controller", knowledgeMode: "lexical", repairBudget: 1, model: snapshotModel(model), thinking: "disabled",
    providerRetries: 0, sessionAutomaticRetries: 2, merchantEvents: "host", limits: o4RecoveryLimits,
    dependencySnapshot: await readC1ValidationDependencies(), pricing: { estimated: true, source: "Pi model catalog, not an actual invoice" },
    planned: { modes: ["memory", "mysql"], userTurnsPerMode: 20, totalUserTurns: 40, notificationsPerMode: 1,
      later40And80TurnScenarios: "not_run" }, fixture: { delayMs: 5000, pendingHoldMs: 180000, testOnlyWaitingWindow: true } };
}
type Configuration = Awaited<ReturnType<typeof configuration>>;
type Manifest = { version: 1; stage: "exposed-development"; frozenAt: string; contractHash: string;
  sourceHashes: Record<string, string>; configuration: Configuration; configurationHash: string };
export async function freezeO4RecoveryProbe(path: string, execution: "live" | "faux" = "live") {
  assert.equal(o4RecoveryTurns.length, 20); const config = await configuration(execution);
  const manifest: Manifest = { version: 1, stage: "exposed-development", frozenAt: new Date().toISOString(),
    contractHash: contentHash(o4RecoveryTurns), sourceHashes: await hashFiles(await sourceFiles()), configuration: config, configurationHash: contentHash(config) };
  await mkdir(directory, { recursive: true }); await writeFile(new URL(path, root), json(manifest), { flag: "wx" });
  console.log(json({ manifest: path, execution, planned: config.planned, databaseCalls: 0, providerRequests: 0 }));
}
export async function inspectO4RecoveryProbe(path: string) {
  const bytes = await readFile(new URL(path, root)), manifest = JSON.parse(bytes.toString()) as Manifest;
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, "exposed-development");
  assert.ok(["live", "faux"].includes(manifest.configuration.execution)); assert.equal(manifest.contractHash, contentHash(o4RecoveryTurns));
  assert.equal(manifest.configurationHash, contentHash(manifest.configuration));
  assert.deepEqual(manifest.configuration, await configuration(manifest.configuration.execution));
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), await sourceFiles());
  assert.deepEqual(manifest.sourceHashes, await hashFiles(await sourceFiles()));
  return { manifest, manifestHash: contentHash(bytes) };
}
function plannedRows(): Row[] {
  return (["memory", "mysql"] as const).flatMap(mode => o4RecoveryTurns.map(turn => ({ mode, id: turn.id, status: "skipped",
    requestId: "", messageId: "", text: "", generation: 0, modelRequests: 0, modelActions: [], renderedText: "", calls: [],
    dbBefore: blankDb(), dbAfter: blankDb(), reason: "not_started", startedAt: 0, finishedAt: 0, score: null,
    requests: [], sends: [], controllerCalls: [], steps: [], sdkRetryEvents: [], hostReferences: [], transcript: [],
    contextBefore: null, contextAfter: null, rawSends: [] })));
}
function hostReferences(context: Pick<TranscriptContext, "messages">): unknown[] {
  return context.messages.flatMap(m => typeof m.content === "string" ? [m.content] : m.content.filter(p => p.type === "text").map(p => p.text))
    .flatMap(text => { try { const v = JSON.parse(text); return v.kind === "host_order_reference" ? [v] : []; } catch { return []; } });
}
function commandFromPrior(turn: typeof o4RecoveryTurns[number], prior: Row[], mapping: Mapping) {
  if (turn.kind === "merchant_confirmation") {
    const source = prior.find(r => r.id === 3); assert.ok(source?.score?.passed && source.reply?.kind === "merchant_confirmation");
    const command = source.reply.confirmationText;
    assert.equal(source.reply.orderId, mapping.orders.A); assert.ok(source.sends.some(s => s.renderedText.split("\n").includes(command)));
    return { text: command, material: { kind: turn.kind, sourceRequestId: source.requestId, sourceTurn: 3, command } };
  }
  if (turn.kind === "order_selection") {
    const shown = prior.find(r => r.id === 7); assert.ok(shown?.score?.passed && shown.result?.referencePresentation === "order");
    const source = prior.findLast(r => r.id < 7 && r.result?.evidence.order?.id === mapping.orders.B);
    assert.ok(source?.requestId); const choices = currentReferenceChoices(shown.result.evidence.orderReferenceChoices, mapping);
    const chosen = choices?.candidates.find(c => c.reference.kind === "order" && c.reference.orderId === mapping.orders.B && c.reference.requestId === source.requestId);
    assert.ok(chosen); const command = `选择订单 ${chosen.token}`;
    assert.ok(shown.sends.some(s => s.renderedText.split("\n").includes(command)), "Selection comes from the actual displayed reply");
    return { text: command, material: { kind: turn.kind, presentationRequestId: shown.requestId, sourceRequestId: source.requestId, token: chosen.token } };
  }
  return { text: o4RecoveryText(turn, mapping), material: undefined };
}
function inbound(content: string, mapping: Mapping, id: string): QQBotInboundMessage {
  const timestamp = new Date().toISOString(); return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: mapping.identity.senderId,
    groupOpenid: mapping.groupOpenid, messageId: id, content, timestamp,
    replyTarget: { scope: "group", targetId: mapping.groupOpenid, msgId: id },
    raw: { id, content, timestamp, group_openid: mapping.groupOpenid, author: { member_openid: mapping.identity.senderId } } };
}
function cleanContext(sourceKey: string) {
  assert.match(sourceKey, /^[a-f0-9]{64}$/);
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(root), input: `DELETE FROM conversation_state WHERE source_key='${sourceKey}';`, encoding: "utf8", timeout: 15000 });
  if (result.error || result.status !== 0) throw new Error("probe_context_cleanup_failed");
}
async function databaseSnapshot(read: Pool, refund: Pool, mapping: Mapping): Promise<Snapshot> {
  const ids = Object.values(mapping.orders), marks = ids.map(() => "?").join(",");
  const q = async (pool: Pool, sql: string, values: string[] = ids) => structuredClone((await pool.execute<RowDataPacket[]>({ sql, timeout: 5000 }, values))[0]);
  const [orders, merchantTasks, refundOperations, refunds, notifications, payments, coupons, items] = await Promise.all([
    q(read, `SELECT * FROM orders WHERE id IN (${marks}) ORDER BY id`),
    q(read, `SELECT * FROM merchant_requests WHERE order_id IN (${marks}) ORDER BY order_id`),
    q(refund, `SELECT * FROM refund_operations WHERE order_id IN (${marks}) ORDER BY order_id`),
    q(read, `SELECT * FROM refunds WHERE order_id IN (${marks}) ORDER BY order_id`),
    q(read, `SELECT n.* FROM merchant_notifications n JOIN merchant_requests r ON r.task_id=n.task_id WHERE r.order_id IN (${marks}) ORDER BY n.task_id`),
    q(read, `SELECT * FROM payments WHERE order_id IN (${marks}) ORDER BY order_id`),
    q(read, `SELECT c.* FROM coupons c JOIN order_items i ON i.id=c.order_item_id WHERE i.order_id IN (${marks}) ORDER BY c.id`),
    q(read, `SELECT * FROM order_items WHERE order_id IN (${marks}) ORDER BY id`),
  ]); return { orders, merchantTasks, refundOperations, refunds, notifications, payments, coupons, items };
}

export async function runO4RecoveryProbe(path: string, execution: "live" | "faux") {
  const { manifest, manifestHash } = await inspectO4RecoveryProbe(path); assert.equal(manifest.configuration.execution, execution);
  for (const config of [readDatabaseConfig(), readAfterSalesDatabaseConfig(), readRefundDatabaseConfig()]) {
    assert.ok(["localhost", "127.0.0.1"].includes(String(config.host)) && config.database === "dave_agent" && Number(config.port) === 13306,
      "This fixture runner is restricted to the local Docker database");
  }
  await mkdir(directory, { recursive: true }); const runId = randomUUID(), target = new URL(`${runId}.json`, directory);
  await writeFile(new URL(`${manifestHash}.attempt.json`, directory), json({ runId, manifestHash, execution, startedAt: new Date().toISOString() }), { flag: "wx" });
  const rows = plannedRows(); let active: Row | undefined, activeEvent: Extract<NonNullable<Actual["beforeEvent"]>, { kind: "notifyA" }> | undefined;
  let capture: ReturnType<typeof captureEvaluationTurn> | undefined, cursor = 0;
  const wire: unknown[] = [];
  const guard = createC1ValidationGuard(async (url, init) => {
    const body = JSON.parse(String(init?.body)); wire.push({ requestId: active?.requestId ?? "host-event", model: body.model,
      thinking: body.thinking, toolChoice: body.tool_choice, maxTokens: body.max_tokens, stream: body.stream });
    assert.equal(body.thinking?.type, "disabled"); assert.ok(body.max_tokens <= 2048);
    return fetch(url, init);
  }, Date.now, o4RecoveryLimits);
  const arms: Array<{ mode: Mode; mapping?: Mapping; startedAt: string; finishedAt: string | null; initial?: Snapshot; final?: Snapshot;
    failure?: string; cleanup: { attempted: boolean; remaining?: Snapshot; contextRemaining?: number; passed: boolean };
    pendingWindowExtensions: Array<{ beforeInput: number; milliseconds: number }>; contextSnapshots: unknown[] }> = [];
  const artifact = { version: 1, stage: "exposed-development", runId, execution, manifest, manifestHash,
    startedAt: new Date().toISOString(), finishedAt: null as string | null, rows, arms, requests: guard.requests, wire,
    usage: guard.usage(), actualSettings: null as unknown, sourceHashes: { before: manifest.sourceHashes, after: {} as Record<string, string> },
    localPackageHashes: { before: await hashFiles(["package.json", "package-lock.json"]), after: {} as Record<string, string> },
    codeStable: false, dependenciesStable: false, packagesStable: false, recordingComplete: false, executionComplete: false,
    runIntegrityPassed: false, usageComplete: false, stopReason: null as string | null, failure: null as string | null,
    diagnostics: [] as Array<{ stage: string; mode?: Mode; turn?: number; name: string; code: string | null; frames: string[] }>,
    summary: {} as Record<string, unknown>, answerReview: "unreviewed", admitted: false };
  const diagnose = (stage: string, error: unknown, mode?: Mode, turn?: number) => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    artifact.diagnostics.push({ stage, mode, turn, name: error instanceof Error ? error.name : "UnknownError",
      code: /^[A-Z0-9_]+$/.test(code) ? code : null,
      // Keep code locations, never provider messages, SQL text, credentials or response bodies.
      frames: error instanceof Error ? (error.stack ?? "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 6) : [] });
  };
  const save = () => { artifact.usage = guard.usage(); return writeFile(target, json(artifact)); };
  await save(); let restore: (() => void) | undefined;
  try {
    const configured = execution === "live" ? await createConfiguredModelRuntime({ ...process.env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash" }) : undefined;
    const runtime = configured?.modelRuntime ?? await createModelRuntime(), faux = execution === "faux" ? fauxProvider() : undefined;
    if (faux) runtime.registerNativeProvider(faux.provider);
    const model = configured?.model ?? faux!.getModel();
    if (configured) assert.deepEqual(snapshotModel(configured.model), manifest.configuration.model);
    artifact.actualSettings = { model: snapshotModel(model), configuredModel: manifest.configuration.model, knowledgeMode: "lexical",
      thinking: "disabled", repairBudget: 1, providerRetries: 0, sessionAutomaticRetries: 2, transport: execution === "live" ? "remote" : "Pi faux provider; no remote model" };
    const original = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (selected, transcript, options) => {
      if (active) { active.modelRequests++; active.hostReferences.push(...structuredClone(hostReferences(transcript)));
        active.transcript.push(structuredClone(transcript)); }
      if (activeEvent) activeEvent.modelRequests++;
      return original(selected, transcript, { ...options, maxRetries: 0, fetch: guard.fetchFor("agent") });
    };
    restore = () => { runtime.streamSimple = original; };
    for (const mode of ["memory", "mysql"] as const) {
      if (guard.stopped()) break;
      const arm: typeof arms[number] = { mode, startedAt: new Date().toISOString(), finishedAt: null,
        cleanup: { attempted: false, passed: false }, pendingWindowExtensions: [], contextSnapshots: [] }; arms.push(arm);
      let fixture: Awaited<ReturnType<typeof createMerchantFixture>> | undefined, foreign: typeof fixture;
      let business: CouponStore | undefined, merchant: AfterSalesStore | undefined, refunds: RefundStore | undefined,
        contexts: ConversationStateStore | undefined, read: Pool | undefined, refundRead: Pool | undefined, agent: QQAgent | undefined,
        session: Session | undefined, mapping: Mapping | undefined;
      let generation = 0; const logs: string[] = [];
      try {
        fixture = await createMerchantFixture(["approve", "approve"], { delayMs: 5000 });
        foreign = await createMerchantFixture(["approve"], { delayMs: 5000, senderId: "TEST_USER2" });
        const groupOpenid = `O4_PROBE_${runId.replaceAll("-", "")}_${mode}`, identity = fixture.identity;
        mapping = { identity, groupOpenid, sourceKey: merchantSourceKey(identity, groupOpenid), orders: { A: fixture.orders[0]!, B: fixture.orders[1]!, F: foreign.orders[0]! } };
        arm.mapping = mapping; read = createPool(readAfterSalesDatabaseConfig()); refundRead = createPool(readRefundDatabaseConfig());
        business = new CouponStore(createPool(readDatabaseConfig())); merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
        refunds = new RefundStore(createPool(readRefundDatabaseConfig())); contexts = new ConversationStateStore(createPool(readAfterSalesDatabaseConfig()));
        await Promise.all([business.ping(), merchant.ping(), refunds.ping(), contexts.ping()]);
        const port = contexts.bind(identity, groupOpenid), state = () => databaseSnapshot(read!, refundRead!, mapping!);
        arm.initial = await state(); assert.equal(arm.initial.orders.length, 3); assert.equal(arm.initial.merchantTasks.length, 0);
        const methodNames: Record<string, string> = { getOrder: "get_order", prepare: "prepare_merchant_request", getTask: "get_merchant_request",
          request: "request_merchant", listTaskReferences: "list_task_references", get: "get_refund", confirm: "confirm_refund", markPresented: "mark_refund_presented" };
        function trace<T extends object>(service: T, refund = false): T {
          return new Proxy(service, { get(target, key) {
            const value = Reflect.get(target, key); if (typeof value !== "function") return value;
            if (key === "listNotifications") return async (...args: unknown[]) => {
              const all = await value.apply(target, args), scoped = all.filter((item: { sourceKey: string; groupOpenid: string }) => item.sourceKey === mapping!.sourceKey && item.groupOpenid === groupOpenid);
              arm.contextSnapshots.push({ kind: "notification_scope_filter", actualCount: all.length, scopedCount: scoped.length }); return scoped;
            };
            if (["applyResult", "claimNotification", "finishNotification"].includes(String(key))) return async (...args: unknown[]) => {
              const call: Call = { name: String(key), input: { arguments: structuredClone(args) }, isError: false };
              activeEvent?.calls.push(call);
              try { const output = await value.apply(target, args); call.output = structuredClone(output ?? null); return output; }
              catch (error) { call.isError = true; call.errorKind = "service_error"; throw error; }
            };
            const name = refund && key === "prepare" ? "prepare_refund" : methodNames[String(key)];
            if (!name) return value.bind(target);
            return async (...args: unknown[]) => {
              const owner = active, event = activeEvent;
              const input: Record<string, unknown> = { identity: args[0], ...(key === "getOrder" ? { orderId: args[1] } : { sourceKey: args[1],
                ...(key === "listTaskReferences" ? { groupOpenid: args[2] } : { orderId: args[2] }),
                ...(key === "getTask" && args[3] !== undefined ? { options: args[3] } : {}),
                ...(["prepare", "request"].includes(String(key)) && !refund ? { reason: args[3], ...(args[4] ? { route: args[4] } : {}) } : {}) }) };
              const call: Call = { name, input: structuredClone(input), isError: false }; (event?.calls ?? owner?.calls)?.push(call);
              try {
                if (name === "request_merchant") assert.ok(owner?.id === 4 && owner.text === (owner.selectionMaterial as { command?: string })?.command,
                  "Only the actual input-4 copied confirmation is authorized to create a task");
                const result = await value.apply(target, args); call.output = structuredClone(result ?? null);
                if (name === "request_merchant") { await fixture!.holdMerchant(mapping!.orders.A, 180000); arm.pendingWindowExtensions.push({ beforeInput: 4, milliseconds: 180000 }); }
                return result;
              } catch (error) { call.isError = true; call.errorKind = error instanceof OrderAccessError || error instanceof MerchantBusinessError || error instanceof RefundBusinessError ? "business_denial" : "service_error"; throw error; }
            };
          } });
        }
        const store = trace(business), sales = trace(merchant), refundStore = trace(refunds, true), knowledgeBase = createKnowledgeService(store, { mode: "lexical" });
        const knowledge: typeof knowledgeBase = { ...knowledgeBase, async search(input) {
          const owner = active, call: Call = { name: "search_faq", input: { query: input.query, retrievalQuery: input.retrievalQuery, originalQuery: input.originalQuery, scope: structuredClone(input.scope), applicabilityContext: structuredClone(input.applicabilityContext ?? null) }, isError: false };
          owner?.calls.push(call);
          try { const result = await knowledgeBase.search(input); call.output = structuredClone(result.documents); return result; }
          catch (error) { call.isError = true; call.errorKind = "service_error"; throw error; }
        } };
        const makeAgent = () => new QQAgent(async () => {
          generation++;
          session = await createSupportSession(identity, store, runtime, model, { sourceKey: mapping!.sourceKey, store: sales, refunds: refundStore }, {
            groupOpenid, repairBudget: 1, knowledge, ...(mode === "mysql" ? { context: port } : {}),
            onCall: call => { if (active && call.parentSpanId === active.requestId) active.controllerCalls.push(structuredClone(call)); },
          });
          session.subscribe(event => {
            if (!active) return; capture?.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") active.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
            if (event.type === "message_end" && event.message.role === "assistant") {
              for (const part of event.message.content) if (part.type === "toolCall" && part.name === "support_action") active.modelActions.push(structuredClone(part.arguments.action));
              const sent = guard.requests.map((request, index) => ({ request, index })).filter(v => v.index >= cursor && v.request.requestId === active!.requestId);
              if (sent.length === 1) guard.record(sent[0]!.index, event.message.usage?.totalTokens ?? null, event.message.usage?.cost?.total ?? null);
              cursor = guard.requests.length;
            }
          });
          return session;
        }, async (target, text, rendered, requester) => {
          const raw = { target: structuredClone(target), text, rendered: structuredClone(rendered), requester };
          active?.rawSends.push(raw); pendingSend = raw;
        }, line => logs.push(line), 45000, async message => {
          return await confirmRefundReply(refundStore, identity, mapping!.sourceKey, message.content)
            ?? await confirmMerchantReply(sales, identity, mapping!.sourceKey, message.content, {
              groupOpenid, messageId: message.messageId!, timestamp: message.timestamp! });
        }, async (message, reply) => {
          assert.ok(pendingSend); const raw = pendingSend; pendingSend = undefined;
          const sent: Send = { reply: structuredClone(reply), renderedText: raw.text, groupOpenid: message.groupOpenid!, messageId: message.messageId!,
            requesterId: raw.requester, target: raw.target, rendered: raw.rendered };
          (activeEvent?.sends ?? active?.sends)?.push(sent);
          await markRefundReplyPresented(refundStore, identity, mapping!.sourceKey, reply);
        }, { merchantEvents: "host" });
        let pendingSend: { target: ReplyTarget; text: string; rendered: RenderedReply; requester: string } | undefined;
        agent = makeAgent();
        for (const turn of o4RecoveryTurns) {
          const row = rows.find(r => r.mode === mode && r.id === turn.id)!, prior = rows.filter(r => r.mode === mode && r.id < turn.id);
          if (guard.stopped() || turn.dependsOn.some(id => !prior.find(r => r.id === id)?.score?.passed)) {
            row.reason = guard.stopped() ?? "required_prior_failed"; await save(); continue;
          }
          if (turn.id === 14) {
            const restart = prior.find(r => r.id === 13)?.beforeEvent;
            if (restart?.kind !== "restart" || restart.nextGeneration <= restart.previousGeneration || generation !== restart.nextGeneration) {
              row.reason = "restart_not_observed"; await save(); continue;
            }
          }
          try {
            const prepared = commandFromPrior(turn, prior, mapping); row.text = prepared.text; row.selectionMaterial = prepared.material;
            if (turn.id > 4 && turn.id <= 11 && mapping.taskA) { await fixture.holdMerchant(mapping.orders.A, 180000); arm.pendingWindowExtensions.push({ beforeInput: turn.id, milliseconds: 180000 }); }
            if (turn.before === "restart") {
              const previousGeneration = generation; await agent.close(); agent = makeAgent(); session = undefined;
              row.beforeEvent = { kind: "restart", previousGeneration, nextGeneration: 0 };
            }
            if (turn.before === "notifyA") {
              const dbBefore = await state(); activeEvent = { kind: "notifyA", modelRequests: 0, calls: [], sends: [], dbBefore, dbAfter: blankDb() };
              row.beforeEvent = activeEvent;
              assert.ok(mapping.taskA); const task = dbBefore.merchantTasks.find(v => v.task_id === mapping!.taskA); assert.ok(task);
              assert.ok(await sales.applyResult({ taskId: mapping.taskA, orderId: mapping.orders.A, status: "approved", approvedAmountCents: Number(task.amount_cents) }));
              await dispatchMerchantNotifications(sales, agent, identity.appId, [groupOpenid]);
              activeEvent.dbAfter = await state(); activeEvent = undefined;
            }
            row.dbBefore = await state(); row.contextBefore = mode === "mysql" ? await port.read() : null;
            row.requestId = `${runId}:${mode}:${turn.id}`; row.messageId = row.requestId; row.startedAt = Date.now();
            const abort = new AbortController(); guard.setActive({ caseId: mode, turn: turn.id, requestId: row.requestId, signal: abort.signal });
            active = row; cursor = guard.requests.length; const requestStart = cursor; capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
            if (faux) {
              const action = fauxO4RecoveryAction(turn.id, mode, mapping);
              faux.setResponses(action ? [() => fauxAssistantMessage(fauxToolCall("support_action", { action }), { stopReason: "toolUse" }),
                () => fauxAssistantMessage("已按本轮实际工具结果处理；这是工程替身回复，不代表真实模型质量。")] : []);
            }
            try { await withinTurnDeadline(agent.handle(inbound(row.text, mapping, row.messageId)), Math.min(45000, guard.remainingMs()), () => {
              abort.abort(); if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); }
            }); } catch (error) { diagnose("turn_execution", error, mode, turn.id); row.error = "turn_timeout_or_transport_failure"; }
            finally { abort.abort(); guard.setActive(undefined); }
            if (faux && faux.getPendingResponseCount()) row.error ??= "faux_unconsumed_responses";
            const measured = capture.finish(); capture = undefined; row.steps = measured.steps;
            row.modelFailed = measured.failed || row.steps.some(s => s.type === "model" && s.isError);
            row.requests = structuredClone(guard.requests.slice(requestStart)); row.generation = generation;
            if (session) {
              const result = getSupportResult(session); if (result?.evidence.requestId === row.requestId) row.result = structuredClone(result);
              const receipt = getSupportHostReceipt(session); if (receipt?.requestId === row.requestId) row.hostReceipt = structuredClone(receipt);
            }
            if (row.sends[0]) { row.reply = structuredClone(row.sends[0].reply); row.renderedText = row.sends[0].renderedText; }
            active = undefined;
            row.dbAfter = await state(); row.contextAfter = mode === "mysql" ? await port.read() : null; row.finishedAt = Date.now();
            if (row.beforeEvent?.kind === "restart") row.beforeEvent.nextGeneration = generation;
            if (turn.id === 4) { const task = row.dbAfter.merchantTasks.find(v => v.order_id === mapping!.orders.A); if (typeof task?.task_id === "string") mapping.taskA = task.task_id; }
            row.status = row.error ? "failed" : "completed"; row.reason = row.error ?? null;
            row.score = scoreO4RecoveryTurn(row, prior, mode, mapping);
            const unchanged = equal((row.dbBefore as Snapshot).payments, (row.dbAfter as Snapshot).payments) && equal((row.dbBefore as Snapshot).coupons, (row.dbAfter as Snapshot).coupons) && equal((row.dbBefore as Snapshot).items, (row.dbAfter as Snapshot).items);
            if (!unchanged) { row.score.passed = false; row.score.safetyPassed = false; row.score.issues.push("payment_coupon_or_item_facts_changed"); }
            await save(); console.log(`[o4-recovery] ${execution}/${mode}/${turn.id}: ${row.score.passed ? "passed" : "failed"}`);
            if (row.score.safetyPassed === false) { artifact.stopReason = "safety_contract_failed"; break; }
            if (row.error) { artifact.stopReason = row.error; break; }
          } catch (error) { diagnose("turn_setup_or_evidence", error, mode, turn.id); active = undefined; activeEvent = undefined; row.status = "failed"; row.reason = "turn_setup_or_evidence_failure"; row.finishedAt = Date.now(); await save(); }
        }
        arm.final = await state();
        assert.ok(["orders", "payments", "coupons", "items", "refunds", "refundOperations"].every(key => equal((arm.initial as unknown as Record<string, unknown>)[key], (arm.final as unknown as Record<string, unknown>)[key])), "Unexpected immutable fixture facts changed");
        arm.contextSnapshots.push({ kind: "end", snapshot: await port.read(), logs });
      } catch (error) { diagnose("arm_setup_or_runtime", error, mode); arm.failure = "arm_setup_or_runtime_failure"; }
      finally {
        active = undefined; activeEvent = undefined; capture = undefined;
        try { await agent?.close(); } catch (error) { diagnose("qq_close", error, mode); arm.failure ??= "qq_close_failure"; }
        arm.cleanup.attempted = true;
        try {
          if (mapping) cleanContext(mapping.sourceKey);
          await fixture?.cleanup(); await foreign?.cleanup();
          if (mapping && read && refundRead) {
            arm.cleanup.remaining = await databaseSnapshot(read, refundRead, mapping);
            const [count] = await read.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM conversation_state WHERE source_key=?", [mapping.sourceKey]);
            arm.cleanup.contextRemaining = Number(count[0]!.n);
            arm.cleanup.passed = Object.values(arm.cleanup.remaining).every(v => Array.isArray(v) && v.length === 0) && arm.cleanup.contextRemaining === 0;
          }
        } catch (error) { diagnose("fixture_cleanup", error, mode); arm.failure ??= "fixture_cleanup_failed"; }
        await Promise.allSettled([business?.close(), merchant?.close(), refunds?.close(), contexts?.close(), read?.end(), refundRead?.end()]);
        arm.finishedAt = new Date().toISOString(); await save();
      }
      if (artifact.stopReason === "safety_contract_failed" || arm.failure) break;
    }
  } catch (error) { diagnose("runner_setup_or_runtime", error); artifact.failure = "runner_setup_or_runtime_failure"; }
  finally {
    active = undefined; activeEvent = undefined; guard.seal(); restore?.();
    for (const row of rows) if (row.reason === "not_started") row.reason = artifact.stopReason ?? guard.stopped() ?? "run_stopped_before_input";
    artifact.stopReason ??= guard.stopped(); artifact.finishedAt = new Date().toISOString();
    artifact.sourceHashes.after = await hashFiles(Object.keys(manifest.sourceHashes)); artifact.codeStable = equal(artifact.sourceHashes.before, artifact.sourceHashes.after);
    artifact.localPackageHashes.after = await hashFiles(["package.json", "package-lock.json"]); artifact.packagesStable = equal(artifact.localPackageHashes.before, artifact.localPackageHashes.after);
    artifact.dependenciesStable = equal(await readC1ValidationDependencies(), manifest.configuration.dependencySnapshot);
    artifact.recordingComplete = rows.length === 40 && rows.every(r => r.status === "skipped" ? Boolean(r.reason) && !r.requestId && !r.calls.length
      : r.finishedAt > 0 && (r.status === "failed" || r.requestId === r.messageId && r.generation > 0));
    artifact.executionComplete = rows.every(r => r.status === "completed");
    artifact.usageComplete = execution === "live" && guard.requests.every(r => r.totalTokens !== null && r.estimatedCost !== null);
    artifact.runIntegrityPassed = artifact.recordingComplete && artifact.codeStable && artifact.packagesStable && artifact.dependenciesStable
      && arms.length === 2 && arms.every(arm => !arm.failure && arm.cleanup.passed) && !artifact.failure;
    artifact.summary = Object.fromEntries((["memory", "mysql"] as const).map(mode => {
      const selected = rows.filter(r => r.mode === mode); return [mode, { planned: 20, completed: selected.filter(r => r.status === "completed").length,
        passed: selected.filter(r => r.score?.passed).length, failed: selected.filter(r => r.status === "failed" || r.status === "completed" && !r.score?.passed).length,
        skipped: selected.filter(r => r.status === "skipped").length, recoveryApplicable: selected.filter(r => r.score?.recoveryApplicable).length,
        recoveryPassed: selected.filter(r => r.score?.recoveryPassed).length,
        recoveryByContract: Object.fromEntries(["task", "focus", "safe_restatement"].map(kind => {
          const matching = selected.filter(r => o4RecoveryTurns.find(t => t.id === r.id)!.expected[mode].recovery === kind);
          return [kind, { planned: matching.length, passed: matching.filter(r => r.score?.passed).length,
            note: kind === "safe_restatement" ? "Safe lack of a locator is not successful focus recovery" : "Bound current re-read required" }];
        })), firstActionPassed: selected.filter(r => r.score?.firstActionPassed).length,
        finalActionPassed: selected.filter(r => r.score?.finalActionPassed).length,
        repaired: selected.filter(r => r.score?.repairRequired).length,
        modelRequests: selected.reduce((n, r) => n + r.modelRequests, 0),
        http: (() => { const requests = guard.requests.filter(r => r.caseId === mode), known = requests.filter(r => r.estimatedCost !== null);
          return { requests: requests.length, unknownCosts: requests.length - known.length,
            knownEstimatedUsd: known.reduce((n, r) => n + r.estimatedCost!, 0),
            estimatedUsd: known.length === requests.length ? known.reduce((n, r) => n + r.estimatedCost!, 0) : null }; })() }];
    }));
    await save(); console.log(json({ runId, artifact: fileURLToPath(target), summary: artifact.summary, runIntegrityPassed: artifact.runIntegrityPassed,
      executionComplete: artifact.executionComplete, usageComplete: artifact.usageComplete, usage: artifact.usage }));
  }
  return artifact;
}

export async function checkO4RecoveryProbe() {
  const rows = plannedRows(); assert.equal(rows.length, 40);
  for (const mode of ["memory", "mysql"] as const) assert.deepEqual(rows.filter(r => r.mode === mode).map(r => r.id), Array.from({ length: 20 }, (_, i) => i + 1));
  let sent = 0;
  const guard = createC1ValidationGuard(async () => { sent++; return new Response("{}"); }, () => 1, o4RecoveryLimits);
  guard.setActive({ caseId: "check", turn: 1, requestId: "check", signal: new AbortController().signal });
  await assert.rejects(guard.fetchFor("rerank")("https://example.invalid"), /operation_disabled/);
  await assert.rejects(guard.fetchFor("support")("https://example.invalid"), /operation_disabled/); assert.equal(sent, 0);
  await guard.fetchFor("agent")("https://example.invalid"); assert.equal(guard.usage().agent.estimatedCost, null);
  guard.record(0, 15, .001); assert.equal(guard.usage().agent.estimatedCost, .001); guard.seal();
  await assert.rejects(guard.fetchFor("agent")("https://example.invalid"));
  const identity = { appId: "TEST_APP", senderId: "TEST_USER1" }, groupOpenid = "O4_PURE_CHECK";
  const mapping: Mapping = { identity, groupOpenid, sourceKey: merchantSourceKey(identity, groupOpenid), orders: { A: "COUPON-2101", B: "COUPON-2102", F: "COUPON-2103" } };
  assert.equal(commandFromPrior(o4RecoveryTurns[0]!, [], mapping).text, `查询订单 ${mapping.orders.B} 的当前状态。`);
  const score = { passed: true, issues: [], safetyPassed: true, recoveryApplicable: false, recoveryPassed: null, firstActionPassed: true, finalActionPassed: true, firstActionError: null, repairRequired: false };
  const confirmation: Reply = { kind: "merchant_confirmation", orderId: mapping.orders.A, amountCents: 7980, confirmationText: `确认联系商家 ${mapping.orders.A} 原因：行程变化` };
  const shown = { ...rows[2]!, requestId: "shown3", score, reply: confirmation, sends: [{ reply: confirmation,
    renderedText: confirmation.confirmationText, groupOpenid, messageId: "shown3", requesterId: identity.senderId,
    target: { scope: "group", targetId: groupOpenid, msgId: "shown3" }, rendered: { kind: "merchant_confirmation", text: confirmation.confirmationText,
      markdown: "", button: { label: "confirm", command: confirmation.confirmationText } } }] } as Row;
  assert.equal(commandFromPrior(o4RecoveryTurns[3]!, [shown], mapping).text, confirmation.confirmationText);
  const hidden = structuredClone(shown); hidden.sends[0]!.renderedText = "没有确认指令";
  assert.throws(() => commandFromPrior(o4RecoveryTurns[3]!, [hidden], mapping));
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [], mapping));
  const binding = { sourceKey: mapping.sourceKey, groupOpenid: mapping.groupOpenid };
  let choices = rememberReferenceChoice(undefined, binding, { kind: "order", requestId: "source5", orderId: mapping.orders.A })!;
  choices = rememberReferenceChoice(choices, binding, { kind: "order", requestId: "source6", orderId: mapping.orders.B })!;
  const token = choices.candidates.find(c => c.reference.kind === "order" && c.reference.orderId === mapping.orders.B)!.token;
  const candidateSource = { ...rows[5]!, requestId: "source6", score,
    result: { evidence: { order: { id: mapping.orders.B } } } } as unknown as Row;
  const presentation = { ...rows[6]!, requestId: "shown7", score,
    result: { referencePresentation: "order", evidence: { orderReferenceChoices: choices } },
    sends: [{ renderedText: `订单 B\n选择订单 ${token}` }] } as unknown as Row;
  assert.equal(commandFromPrior(o4RecoveryTurns[7]!, [candidateSource, presentation], mapping).text, `选择订单 ${token}`);
  const absent = structuredClone(presentation); absent.sends[0]!.renderedText = "只展示订单号，没有选择指令";
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [candidateSource, absent], mapping));
  const replacedSource = { ...candidateSource, requestId: "invented-source" };
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [replacedSource, presentation], mapping));
  // Prebuilt rows preserve both arms and the full denominator even if nothing starts.
  assert.equal(rows.filter(r => r.status === "skipped").length, 40);
  console.log("O4 probe runner checks passed: 40 planned rows, exact displayed-command prerequisite, disabled remote stages and unknown-cost accounting; no database/network.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === "--check") await checkO4RecoveryProbe();
  else {
    assert.ok(args.length === 2 && ["--freeze", "--freeze-faux", "--inspect", "--live", "--faux"].includes(args[0]!),
      "Use --check, --freeze|--freeze-faux|--inspect|--live|--faux MANIFEST; --faux uses the real local database");
    if (args[0] === "--freeze" || args[0] === "--freeze-faux") await freezeO4RecoveryProbe(args[1]!, args[0] === "--freeze" ? "live" : "faux");
    else if (args[0] === "--inspect") { const value = await inspectO4RecoveryProbe(args[1]!); console.log(json({ frozen: true, execution: value.manifest.configuration.execution, providerRequests: 0, databaseCalls: 0 })); }
    else {
      const result = await runO4RecoveryProbe(args[1]!, args[0] === "--live" ? "live" : "faux");
      process.exitCode = result.runIntegrityPassed && result.executionComplete && result.rows.every(row => row.score?.passed) ? 0 : 1;
    }
  }
}
