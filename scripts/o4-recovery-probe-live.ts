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
import { getModelSupportActionParameters, taskReferenceContractVersion, type TaskReferenceMode } from "../src/support-context-action.ts";
import { currentReferenceChoices, rememberReferenceChoice } from "../src/support-reference-selection.ts";
import { currentTaskChoices, refreshTaskChoices } from "../src/support-task-context.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult } from "../src/support-session.ts";
import { createC1ValidationGuard, readC1ValidationDependencies, withinTurnDeadline } from "./c1-session-validation-live.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";
import { o4RecoveryTurns, o4RecoveryText, scoreO4RecoveryTurn, fauxO4RecoveryAction } from "./o4-recovery-probe-contract.ts";
import { rotationTurns, freshRotationTurns, rotationText, scoreRotationTurn, fauxRotationAction, type RotationWording } from "./o4-rotation-probe-contract.ts";

const root = new URL("../", import.meta.url), directory = new URL(".runtime/o4-recovery-probe/", root);
export const o4RecoveryLimits = { requests: { agent: 120, rerank: 0, support: 0 }, deadlineMs: 600_000,
  turnTimeoutMs: 45_000, estimatedUsd: .35, estimatedCny: .01 };
export const o4RotationLimits = { requests: { agent: 240, rerank: 0, support: 0 }, deadlineMs: 900_000,
  turnTimeoutMs: 45_000, estimatedUsd: .70, estimatedCny: .01 };
type SuiteName = "recovery20" | "rotation40" | "rotation40fresh";
type ProbeTurn = typeof o4RecoveryTurns[number] | typeof rotationTurns[number];
const isRotationSuite = (value: string) => value === "rotation40" || value === "rotation40fresh";
const validSuite = (value: string): value is SuiteName => value === "recovery20" || isRotationSuite(value);
function taskReferenceSettings(suite: SuiteName, mode: TaskReferenceMode) {
  assert.ok(mode === "id" || mode === "current", "--task-reference must be id or current");
  assert.ok(mode === "id" || isRotationSuite(suite), "current task references are limited to rotation40 or rotation40fresh");
  return { taskReferenceMode: mode, taskReferenceContractVersion,
    taskReferenceSchemaHash: contentHash(getModelSupportActionParameters(mode)) };
}
function suiteDefinition(name: SuiteName, taskReferenceMode: TaskReferenceMode = "id") {
  assert.ok(validSuite(name));
  taskReferenceSettings(name, taskReferenceMode);
  const wording: RotationWording = name === "rotation40fresh" ? "fresh-v1" : "original";
  return isRotationSuite(name)
    ? { name, wording, turns: name === "rotation40fresh" ? freshRotationTurns : rotationTurns, limits: o4RotationLimits, contractPath: "scripts/o4-rotation-probe-contract.ts",
      text: (turn: ProbeTurn, mapping: Mapping) => rotationText(turn as typeof rotationTurns[number], mapping),
      score: (actual: Actual, history: Actual[], mode: Mode, mapping: Mapping) => scoreRotationTurn(actual, history, mode, mapping, taskReferenceMode, wording),
      fauxAction: (id: number, mode: Mode, mapping: Mapping) => fauxRotationAction(id, mode, mapping, taskReferenceMode) }
    : { name, wording, turns: o4RecoveryTurns, limits: o4RecoveryLimits, contractPath: "scripts/o4-recovery-probe-contract.ts",
      text: (turn: ProbeTurn, mapping: Mapping) => o4RecoveryText(turn as typeof o4RecoveryTurns[number], mapping), score: scoreO4RecoveryTurn, fauxAction: fauxO4RecoveryAction };
}
function wordingSettings(suite: ReturnType<typeof suiteDefinition>) {
  return { wording: suite.wording, wordingVersion: "o4-wording-v1",
    wordingHash: contentHash(suite.turns.map(({ id, kind, text }) => ({ id, kind, text }))) };
}
type Mode = "memory" | "mysql";
type Mapping = Parameters<typeof scoreO4RecoveryTurn>[3] & { taskB?: string };
type Actual = Parameters<typeof scoreO4RecoveryTurn>[0];
type Call = Actual["calls"][number];
type Snapshot = Actual["dbBefore"] & { payments: Record<string, unknown>[]; coupons: Record<string, unknown>[]; items: Record<string, unknown>[] };
type Send = Actual["sends"][number] & { target: ReplyTarget; rendered: RenderedReply };
type Session = Awaited<ReturnType<typeof createSupportSession>>;
type FactoryEvent = { agentInstanceId: string; generation: number; messageId: string; trigger: "user" | "host_event"; createdAt: string };
type Row = Actual & { mode: Mode; reason: string | null; startedAt: number; finishedAt: number;
  score: ReturnType<typeof scoreO4RecoveryTurn> | null; requests: ReturnType<typeof createC1ValidationGuard>["requests"];
  sends: Send[]; controllerCalls: unknown[]; steps: ReturnType<ReturnType<typeof captureEvaluationTurn>["finish"]>["steps"];
  sdkRetryEvents: Array<{ type: string; attempt: number }>; hostReferences: unknown[]; transcript: unknown[];
  contextBefore: unknown; contextAfter: unknown; selectionMaterial?: unknown; rawSends: unknown[];
  generationBefore: number; factoryEvents: FactoryEvent[]; };
const blankDb = (): Snapshot => ({ orders: [], merchantTasks: [], refundOperations: [], refunds: [], notifications: [], payments: [], coupons: [], items: [] });
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const hashFiles = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));
async function sourceFiles() {
  return [...new Set(["scripts/o4-recovery-probe-live.ts", "scripts/o4-recovery-probe-contract.ts", "scripts/o4-rotation-probe-contract.ts", "scripts/o4-task-reference-wording.ts", "scripts/merchant-test-fixture.ts",
    "scripts/c1-session-validation-live.ts", "scripts/c1-session-validation-check.ts", "scripts/c1-session-live.ts",
    "prompts/customer-service-v2.md", "skills/shop-support-v2/SKILL.md",
    ...(await readdir(new URL("src/", root))).filter(n => n.endsWith(".ts")).map(n => `src/${n}`),
    ...(await readdir(new URL("db/", root))).filter(n => n.endsWith(".sql")).map(n => `db/${n}`)])].sort();
}
const snapshotModel = (model: Awaited<ReturnType<typeof createConfiguredModelRuntime>>["model"]) => ({ provider: model.provider,
  id: model.id, api: model.api, baseUrl: model.baseUrl, maxTokens: Math.min(2048, model.maxTokens), cost: model.cost });
async function configuration(execution: "live" | "faux", suiteName: SuiteName, taskReferenceMode: TaskReferenceMode) {
  const suite = suiteDefinition(suiteName, taskReferenceMode);
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash"); assert.ok(model);
  return { execution, suite: suiteName, ...taskReferenceSettings(suiteName, taskReferenceMode), ...wordingSettings(suite), architecture: "controller", knowledgeMode: "lexical", repairBudget: 1, model: snapshotModel(model), thinking: "disabled",
    providerRetries: 0, sessionAutomaticRetries: 2, merchantEvents: "host", limits: suite.limits,
    dependencySnapshot: await readC1ValidationDependencies(), pricing: { estimated: true, source: "Pi model catalog, not an actual invoice" },
    planned: { modes: ["memory", "mysql"], userTurnsPerMode: suite.turns.length, totalUserTurns: suite.turns.length * 2,
      notificationsPerMode: suite.turns.filter(turn => turn.before === "notifyA").length,
      laterScenarios: suiteName === "recovery20" ? "40/80 not run in this artifact" : "80 not run in this artifact" }, fixture: { delayMs: 5000, pendingHoldMs: 180000, testOnlyWaitingWindow: true } };
}
type Configuration = Awaited<ReturnType<typeof configuration>>;
type Manifest = { version: 4; suite: SuiteName; contractPath: string; stage: "exposed-development"; frozenAt: string; contractHash: string;
  sourceHashes: Record<string, string>; configuration: Configuration; configurationHash: string };
export async function freezeO4RecoveryProbe(path: string, execution: "live" | "faux" = "live", suiteName: SuiteName = "recovery20", taskReferenceMode: TaskReferenceMode = "id") {
  const suite = suiteDefinition(suiteName, taskReferenceMode), config = await configuration(execution, suiteName, taskReferenceMode);
  const manifest: Manifest = { version: 4, suite: suiteName, contractPath: suite.contractPath, stage: "exposed-development", frozenAt: new Date().toISOString(),
    contractHash: contentHash(suite.turns), sourceHashes: await hashFiles(await sourceFiles()), configuration: config, configurationHash: contentHash(config) };
  await mkdir(directory, { recursive: true }); await writeFile(new URL(path, root), json(manifest), { flag: "wx" });
  console.log(json({ manifest: path, execution, taskReferenceMode, ...wordingSettings(suite), planned: config.planned, databaseCalls: 0, providerRequests: 0 }));
}
export async function inspectO4RecoveryProbe(path: string, suiteName: SuiteName = "recovery20", taskReferenceMode: TaskReferenceMode = "id") {
  const suite = suiteDefinition(suiteName, taskReferenceMode);
  const bytes = await readFile(new URL(path, root)), manifest = JSON.parse(bytes.toString()) as Manifest;
  assert.equal(manifest.version, 4, "Historical v1/v2/v3 manifests must be reproduced with their original commit; hashes, wording and task-reference semantics are never rebased");
  assert.equal(manifest.suite, suiteName);
  assert.equal(manifest.contractPath, suite.contractPath); assert.equal(manifest.stage, "exposed-development");
  assert.ok(["live", "faux"].includes(manifest.configuration.execution)); assert.equal(manifest.contractHash, contentHash(suite.turns));
  assert.equal(manifest.configurationHash, contentHash(manifest.configuration));
  assert.deepEqual(manifest.configuration, await configuration(manifest.configuration.execution, suiteName, taskReferenceMode));
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), await sourceFiles());
  assert.deepEqual(manifest.sourceHashes, await hashFiles(await sourceFiles()));
  return { manifest, manifestHash: contentHash(bytes) };
}
function plannedRows(suiteName: SuiteName = "recovery20"): Row[] {
  return (["memory", "mysql"] as const).flatMap(mode => suiteDefinition(suiteName).turns.map(turn => ({ mode, id: turn.id, status: "skipped",
    requestId: "", messageId: "", text: "", generation: 0, modelRequests: 0, modelActions: [], renderedText: "", calls: [],
    dbBefore: blankDb(), dbAfter: blankDb(), reason: "not_started", startedAt: 0, finishedAt: 0, score: null,
    requests: [], sends: [], controllerCalls: [], steps: [], sdkRetryEvents: [], hostReferences: [], transcript: [],
    contextBefore: null, contextAfter: null, rawSends: [], generationBefore: 0, factoryEvents: [] })));
}
function hostReferences(context: Pick<TranscriptContext, "messages">): unknown[] {
  return context.messages.flatMap(m => typeof m.content === "string" ? [m.content] : m.content.filter(p => p.type === "text").map(p => p.text))
    .flatMap(text => { try { const v = JSON.parse(text); return v.kind === "host_order_reference" ? [v] : []; } catch { return []; } });
}
function observedNaturalRotation(row: Row | undefined, previous: FactoryEvent | undefined, currentGeneration: number) {
  const created = row?.factoryEvents[0];
  return Boolean(row && previous && row.requestId && row.factoryEvents.length === 1 && created?.trigger === "user"
    && created.messageId === row.messageId && row.messageId === row.requestId && created.agentInstanceId === previous.agentInstanceId
    && row.generationBefore === previous.generation && created.generation === previous.generation + 1
    && row.generation === created.generation && currentGeneration === created.generation);
}
function commandTarget(turn: ProbeTurn): "A" | "B" {
  const target = "target" in turn ? turn.target : turn.expected.memory.order;
  assert.ok(target === "A" || target === "B"); return target;
}
function commandFromPrior(turn: ProbeTurn, prior: Row[], mapping: Mapping, suiteName: SuiteName = "recovery20") {
  if (turn.kind === "user") return { text: suiteDefinition(suiteName).text(turn, mapping), material: undefined };
  assert.ok(turn.fromTurn && turn.fromTurn < turn.id);
  const shown = prior.find(r => r.id === turn.fromTurn), target = commandTarget(turn);
  const binding = { sourceKey: mapping.sourceKey, groupOpenid: mapping.groupOpenid };
  assert.ok(shown?.score?.passed && shown.requestId, "The declared source must actually complete before a host command");
  if (turn.kind === "merchant_confirmation") {
    assert.equal(shown.reply?.kind, "merchant_confirmation"); assert.ok(shown.reply?.kind === "merchant_confirmation");
    const command = shown.reply.confirmationText;
    assert.equal(shown.reply.orderId, mapping.orders[target]); assert.ok(shown.sends.some(s => s.renderedText.split("\n").includes(command)));
    return { text: command, material: { kind: turn.kind, target, sourceRequestId: shown.requestId, sourceTurn: shown.id, command } };
  }
  if (turn.kind === "order_selection") {
    assert.ok(shown.result?.referencePresentation === "order");
    const choices = currentReferenceChoices(shown.result.evidence.orderReferenceChoices, binding);
    const chosen = choices?.candidates.find(c => c.reference.kind === "order" && c.reference.orderId === mapping.orders[target]);
    assert.ok(chosen?.reference.kind === "order");
    // A later merchant preparation may read the same order without producing
    // an order-choice source. Follow the displayed candidate's exact request.
    const reference = chosen.reference;
    const source = prior.find(r => r.id < shown.id && r.requestId === reference.requestId);
    assert.ok(source?.result?.outcome === "ready" && source.result.reply.kind === "order"
      && source.result.evidence.requestId === source.requestId && source.result.evidence.order?.id === mapping.orders[target]
      && source.reply?.kind === "order" && source.sends.some(sent => sent.reply.kind === "order"
        && sent.reply.orders.some(order => order.id === mapping.orders[target]))
      && source.calls.some(call => call.name === "get_order" && !call.isError && equal(call.input.identity, mapping.identity)
        && call.input.orderId === mapping.orders[target] && equal(call.output, source.result!.evidence.order)),
    "The displayed candidate must come from its actual successful order card and fresh authorized read");
    const command = `选择订单 ${chosen.token}`;
    assert.ok(shown.sends.some(s => s.renderedText.split("\n").includes(command)), "Selection comes from the actual displayed reply");
    return { text: command, material: { kind: turn.kind, target, presentationRequestId: shown.requestId, sourceRequestId: source.requestId, token: chosen.token } };
  }
  const choices = shown.hostReceipt?.version === "task-selection-v1" ? shown.hostReceipt.choices
    : shown.result?.referencePresentation === "task" ? shown.result.evidence.taskChoices : undefined;
  // A deliberate old-token replay copies the old display, never current candidates.
  // Fresh selections additionally require that the displayed DB reference is still unexpired.
  const current = turn.kind === "old_task_selection" ? choices : currentTaskChoices(choices, binding);
  assert.ok(current && current.sourceKey === mapping.sourceKey && current.groupOpenid === mapping.groupOpenid);
  const taskId = target === "A" ? mapping.taskA : mapping.taskB;
  assert.ok(taskId); const chosen = current.candidates.find(c => c.reference.taskId === taskId && c.reference.orderId === mapping.orders[target]);
  assert.ok(chosen); const command = `选择任务 ${chosen.token}`;
  assert.ok(shown.sends.some(s => s.renderedText.split("\n").includes(command)), "A task command must have really been displayed");
  return { text: command, material: { kind: turn.kind, target, presentationRequestId: shown.requestId, sourceTurn: shown.id,
    token: chosen.token, taskId, reference: structuredClone(chosen.reference) } };
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

export async function runO4RecoveryProbe(path: string, execution: "live" | "faux", suiteName: SuiteName = "recovery20", taskReferenceMode: TaskReferenceMode = "id") {
  const suite = suiteDefinition(suiteName, taskReferenceMode);
  const { manifest, manifestHash } = await inspectO4RecoveryProbe(path, suiteName, taskReferenceMode); assert.equal(manifest.configuration.execution, execution);
  for (const config of [readDatabaseConfig(), readAfterSalesDatabaseConfig(), readRefundDatabaseConfig()]) {
    assert.ok(["localhost", "127.0.0.1"].includes(String(config.host)) && config.database === "dave_agent" && Number(config.port) === 13306,
      "This fixture runner is restricted to the local Docker database");
  }
  await mkdir(directory, { recursive: true }); const runId = randomUUID(), target = new URL(`${runId}.json`, directory);
  await writeFile(new URL(`${manifestHash}.attempt.json`, directory), json({ runId, manifestHash, execution, startedAt: new Date().toISOString() }), { flag: "wx" });
  const rows = plannedRows(suiteName); let active: Row | undefined, activeEvent: Extract<NonNullable<Actual["beforeEvent"]>, { kind: "notifyA" }> | undefined;
  let capture: ReturnType<typeof captureEvaluationTurn> | undefined, cursor = 0;
  const wire: unknown[] = [];
  const guard = createC1ValidationGuard(async (url, init) => {
    const body = JSON.parse(String(init?.body)); wire.push({ requestId: active?.requestId ?? "host-event", model: body.model,
      thinking: body.thinking, toolChoice: body.tool_choice, maxTokens: body.max_tokens, stream: body.stream });
    assert.equal(body.thinking?.type, "disabled"); assert.ok(body.max_tokens <= 2048);
    return fetch(url, init);
  }, Date.now, suite.limits);
  const arms: Array<{ mode: Mode; mapping?: Mapping; startedAt: string; finishedAt: string | null; initial?: Snapshot; final?: Snapshot;
    failure?: string; cleanup: { attempted: boolean; remaining?: Snapshot; contextRemaining?: number; passed: boolean };
    pendingWindowExtensions: Array<{ beforeInput: number; orderId: string; milliseconds: number }>; contextSnapshots: unknown[];
    factoryEvents: FactoryEvent[]; }> = [];
  const artifact = { version: 4, suite: suiteName, stage: "exposed-development", runId, execution, manifest, manifestHash,
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
    const actualTaskReference = taskReferenceSettings(suiteName, taskReferenceMode);
    assert.deepEqual(actualTaskReference, { taskReferenceMode: manifest.configuration.taskReferenceMode,
      taskReferenceContractVersion: manifest.configuration.taskReferenceContractVersion,
      taskReferenceSchemaHash: manifest.configuration.taskReferenceSchemaHash });
    const actualWording = wordingSettings(suite);
    assert.deepEqual(actualWording, { wording: manifest.configuration.wording,
      wordingVersion: manifest.configuration.wordingVersion, wordingHash: manifest.configuration.wordingHash });
    artifact.actualSettings = { ...actualTaskReference, ...actualWording, model: snapshotModel(model), configuredModel: manifest.configuration.model, knowledgeMode: "lexical",
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
        cleanup: { attempted: false, passed: false }, pendingWindowExtensions: [], contextSnapshots: [], factoryEvents: [] }; arms.push(arm);
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
                if (name === "request_merchant") {
                  const specified = suite.turns.find(turn => turn.id === owner?.id);
                  assert.ok(owner && specified?.kind === "merchant_confirmation" && owner.text === (owner.selectionMaterial as { command?: string })?.command,
                    "Only a declared confirmation with its actual displayed command may create a task");
                  assert.equal(args[2], mapping!.orders[commandTarget(specified)], "The exact confirmation cannot target a different order");
                }
                const result = await value.apply(target, args); call.output = structuredClone(result ?? null);
                if (name === "request_merchant") { const orderId = String(args[2]); await fixture!.holdMerchant(orderId, 180000);
                  arm.pendingWindowExtensions.push({ beforeInput: owner!.id, orderId, milliseconds: 180000 }); }
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
        const makeAgent = () => { const agentInstanceId = randomUUID(); return new QQAgent(async message => {
          session = await createSupportSession(identity, store, runtime, model, { sourceKey: mapping!.sourceKey, store: sales, refunds: refundStore }, {
            groupOpenid, repairBudget: 1, knowledge, taskReferenceMode, ...(mode === "mysql" ? { context: port } : {}),
            onCall: call => { if (active && call.parentSpanId === active.requestId) active.controllerCalls.push(structuredClone(call)); },
          });
          generation++;
          arm.factoryEvents.push({ agentInstanceId, generation, messageId: message.messageId!, trigger: activeEvent ? "host_event" : "user", createdAt: new Date().toISOString() });
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
        }, line => logs.push(line), suite.limits.turnTimeoutMs, async message => {
          return await confirmRefundReply(refundStore, identity, mapping!.sourceKey, message.content)
            ?? await confirmMerchantReply(sales, identity, mapping!.sourceKey, message.content, {
              groupOpenid, messageId: message.messageId!, timestamp: message.timestamp! });
        }, async (message, reply) => {
          assert.ok(pendingSend); const raw = pendingSend; pendingSend = undefined;
          const sent: Send = { reply: structuredClone(reply), renderedText: raw.text, groupOpenid: message.groupOpenid!, messageId: message.messageId!,
            requesterId: raw.requester, target: raw.target, rendered: raw.rendered };
          (activeEvent?.sends ?? active?.sends)?.push(sent);
          await markRefundReplyPresented(refundStore, identity, mapping!.sourceKey, reply);
        }, { merchantEvents: "host" }); };
        let pendingSend: { target: ReplyTarget; text: string; rendered: RenderedReply; requester: string } | undefined;
        agent = makeAgent();
        for (const turn of suite.turns) {
          const row = rows.find(r => r.mode === mode && r.id === turn.id)!, prior = rows.filter(r => r.mode === mode && r.id < turn.id);
          if (guard.stopped() || turn.dependsOn.some(id => !prior.find(r => r.id === id)?.score?.passed)) {
            row.reason = guard.stopped() ?? "required_prior_failed"; await save(); continue;
          }
          if (suiteName === "recovery20" && turn.id === 14) {
            const restart = prior.find(r => r.id === 13)?.beforeEvent;
            if (restart?.kind !== "restart" || restart.nextGeneration <= restart.previousGeneration || generation !== restart.nextGeneration) {
              row.reason = "restart_not_observed"; await save(); continue;
            }
          }
          if (isRotationSuite(suiteName) && [22, 25, 33].includes(turn.id)
            && !observedNaturalRotation(prior.find(row => row.id === 21), arm.factoryEvents[0], generation)) {
            row.reason = "natural_rotation_not_observed"; await save(); continue;
          }
          const factoryStart = arm.factoryEvents.length;
          try {
            const prepared = commandFromPrior(turn, prior, mapping, suiteName); row.text = prepared.text; row.selectionMaterial = prepared.material;
            const beforeWait = await state();
            for (const task of beforeWait.merchantTasks) if (task.status === "pending" && fixture.orders.includes(String(task.order_id))) {
              await fixture.holdMerchant(String(task.order_id), 180000);
              arm.pendingWindowExtensions.push({ beforeInput: turn.id, orderId: String(task.order_id), milliseconds: 180000 });
            }
            if (turn.before === "restart") {
              assert.equal(suiteName, "recovery20", "Rotation suites must use production automatic rotation");
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
            row.requestId = `${runId}:${mode}:${turn.id}`; row.messageId = row.requestId; row.startedAt = Date.now(); row.generationBefore = generation;
            const abort = new AbortController(); guard.setActive({ caseId: mode, turn: turn.id, requestId: row.requestId, signal: abort.signal });
            active = row; cursor = guard.requests.length; const requestStart = cursor; capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
            if (faux) {
              const action = suite.fauxAction(turn.id, mode, mapping);
              faux.setResponses(action ? [() => fauxAssistantMessage(fauxToolCall("support_action", { action }), { stopReason: "toolUse" }),
                () => fauxAssistantMessage("已按本轮实际工具结果处理；这是工程替身回复，不代表真实模型质量。")] : []);
            }
            try { await withinTurnDeadline(agent.handle(inbound(row.text, mapping, row.messageId)), Math.min(suite.limits.turnTimeoutMs, guard.remainingMs()), () => {
              abort.abort(); if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); }
            }); } catch (error) { diagnose("turn_execution", error, mode, turn.id); row.error = "turn_timeout_or_transport_failure"; }
            finally { abort.abort(); guard.setActive(undefined); }
            if (faux && faux.getPendingResponseCount()) row.error ??= "faux_unconsumed_responses";
            const measured = capture.finish(); capture = undefined; row.steps = measured.steps;
            row.modelFailed = measured.failed || row.steps.some(s => s.type === "model" && s.isError);
            row.requests = structuredClone(guard.requests.slice(requestStart)); row.generation = generation;
            row.factoryEvents = structuredClone(arm.factoryEvents.slice(factoryStart));
            if (session) {
              const result = getSupportResult(session); if (result?.evidence.requestId === row.requestId) row.result = structuredClone(result);
              const receipt = getSupportHostReceipt(session); if (receipt?.requestId === row.requestId) row.hostReceipt = structuredClone(receipt);
            }
            if (row.sends[0]) { row.reply = structuredClone(row.sends[0].reply); row.renderedText = row.sends[0].renderedText; }
            active = undefined;
            row.dbAfter = await state(); row.contextAfter = mode === "mysql" ? await port.read() : null; row.finishedAt = Date.now();
            if (row.beforeEvent?.kind === "restart") row.beforeEvent.nextGeneration = generation;
            if (turn.kind === "merchant_confirmation") {
              const target = commandTarget(turn), task = row.dbAfter.merchantTasks.find(v => v.order_id === mapping!.orders[target] && v.source_key === mapping!.sourceKey);
              if (typeof task?.task_id === "string") { if (target === "A") mapping.taskA = task.task_id; else mapping.taskB = task.task_id; }
            }
            row.status = row.error ? "failed" : "completed"; row.reason = row.error ?? null;
            row.score = suite.score(row, prior, mode, mapping);
            const unchanged = equal((row.dbBefore as Snapshot).payments, (row.dbAfter as Snapshot).payments) && equal((row.dbBefore as Snapshot).coupons, (row.dbAfter as Snapshot).coupons) && equal((row.dbBefore as Snapshot).items, (row.dbAfter as Snapshot).items);
            if (!unchanged) { row.score.passed = false; row.score.safetyPassed = false; row.score.issues.push("payment_coupon_or_item_facts_changed"); }
            await save(); console.log(`[o4-recovery] ${execution}/${mode}/${turn.id}: ${row.score.passed ? "passed" : "failed"}`);
            if (row.score.safetyPassed === false) { artifact.stopReason = "safety_contract_failed"; break; }
            if (row.error) { artifact.stopReason = row.error; break; }
          } catch (error) { diagnose("turn_setup_or_evidence", error, mode, turn.id); active = undefined; activeEvent = undefined;
            row.factoryEvents = structuredClone(arm.factoryEvents.slice(factoryStart));
            row.status = "failed"; row.reason = "turn_setup_or_evidence_failure"; row.finishedAt = Date.now(); await save(); }
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
    artifact.recordingComplete = rows.length === suite.turns.length * 2 && rows.every(r => r.status === "skipped" ? Boolean(r.reason) && !r.requestId && !r.calls.length
      : r.finishedAt > 0 && (r.status === "failed" || r.requestId === r.messageId && r.generation > 0));
    artifact.executionComplete = rows.every(r => r.status === "completed");
    artifact.usageComplete = execution === "live" && guard.requests.every(r => r.totalTokens !== null && r.estimatedCost !== null);
    artifact.runIntegrityPassed = artifact.recordingComplete && artifact.codeStable && artifact.packagesStable && artifact.dependenciesStable
      && arms.length === 2 && arms.every(arm => !arm.failure && arm.cleanup.passed) && !artifact.failure;
    artifact.summary = Object.fromEntries((["memory", "mysql"] as const).map(mode => {
      const selected = rows.filter(r => r.mode === mode); return [mode, { planned: suite.turns.length, completed: selected.filter(r => r.status === "completed").length,
        passed: selected.filter(r => r.score?.passed).length, failed: selected.filter(r => r.status === "failed" || r.status === "completed" && !r.score?.passed).length,
        skipped: selected.filter(r => r.status === "skipped").length, recoveryApplicable: selected.filter(r => r.score?.recoveryApplicable).length,
        recoveryPassed: selected.filter(r => r.score?.recoveryPassed).length,
        recoveryByContract: Object.fromEntries(["task", "focus", "safe_restatement"].map(kind => {
          const matching = selected.filter(r => suite.turns.find(t => t.id === r.id)!.expected[mode].recovery === kind);
          return [kind, { planned: matching.length, passed: matching.filter(r => r.score?.passed).length,
            note: kind === "safe_restatement" ? "Safe lack of a locator is not successful focus recovery" : "Bound current re-read required" }];
        })), firstActionPassed: selected.filter(r => r.score?.firstActionPassed).length,
        finalActionPassed: selected.filter(r => r.score?.finalActionPassed).length,
        repaired: selected.filter(r => r.score?.repairRequired).length,
        commandsByKind: Object.fromEntries(["merchant_confirmation", "order_selection", "task_selection", "old_task_selection"].map(kind => {
          const matching = selected.filter(row => suite.turns.find(turn => turn.id === row.id)!.kind === kind);
          return [kind, { planned: matching.length, executed: matching.filter(row => row.status !== "skipped").length,
            passed: matching.filter(row => row.score?.passed).length }];
        })),
        sessionFactories: arms.find(arm => arm.mode === mode)?.factoryEvents.length ?? 0,
        automaticRotations: (() => { const events = arms.find(arm => arm.mode === mode)?.factoryEvents ?? [];
          return events.length - new Set(events.map(event => event.agentInstanceId)).size; })(),
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
  const rotationRows = plannedRows("rotation40"); assert.equal(rotationRows.length, 80);
  for (const mode of ["memory", "mysql"] as const) assert.deepEqual(rotationRows.filter(r => r.mode === mode).map(r => r.id), Array.from({ length: 40 }, (_, i) => i + 1));
  const freshRows = plannedRows("rotation40fresh"); assert.equal(freshRows.length, 80);
  for (const mode of ["memory", "mysql"] as const) assert.deepEqual(freshRows.filter(r => r.mode === mode).map(r => r.id), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(suiteDefinition("recovery20").limits.requests.agent, 120);
  assert.equal(suiteDefinition("rotation40").limits.requests.agent, 240);
  const freshSuite = suiteDefinition("rotation40fresh", "current");
  assert.deepEqual(freshSuite.limits, o4RotationLimits);
  assert.deepEqual(freshSuite.turns.map(({ text: _text, ...turn }) => turn), rotationTurns.map(({ text: _text, ...turn }) => turn),
    "Fresh wording must not change scenarios, dependencies, expected states or the oracle");
  assert.equal(freshSuite.turns.filter((turn, index) => turn.text !== rotationTurns[index]!.text).length, 31);
  assert.ok(isRotationSuite("rotation40fresh"), "Fresh wording retains natural-rotation prerequisites");
  const freshConfig = await configuration("faux", "rotation40fresh", "current");
  assert.equal(freshConfig.planned.totalUserTurns, 80); assert.equal(freshConfig.wording, "fresh-v1");
  assert.deepEqual(wordingSettings(freshSuite), { wording: freshConfig.wording,
    wordingVersion: freshConfig.wordingVersion, wordingHash: freshConfig.wordingHash });
  assert.notEqual(freshConfig.wordingHash, wordingSettings(suiteDefinition("rotation40")).wordingHash);
  assert.ok((await sourceFiles()).includes("scripts/o4-task-reference-wording.ts"));
  const firstFactory: FactoryEvent = { agentInstanceId: "real-agent", generation: 1, messageId: "first", trigger: "user", createdAt: new Date().toISOString() };
  const rotated: Row = { ...rotationRows[20]!, status: "completed", requestId: "actual21", messageId: "actual21", generationBefore: 1, generation: 2,
    factoryEvents: [{ ...firstFactory, messageId: "actual21", generation: 2 }] };
  assert.ok(observedNaturalRotation(rotated, firstFactory, 2), "Actual factory boundary is independent of semantic score");
  assert.equal(observedNaturalRotation({ ...rotated, factoryEvents: [] }, firstFactory, 2), false);
  assert.equal(observedNaturalRotation({ ...rotated, factoryEvents: [{ ...rotated.factoryEvents[0]!, agentInstanceId: "manual-restart" }] }, firstFactory, 2), false);
  assert.equal(observedNaturalRotation(rotated, firstFactory, 1), false);
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
  const freshText = commandFromPrior(freshRotationTurns[0]!, [], mapping, "rotation40fresh").text;
  assert.equal(freshText, rotationText(freshRotationTurns[0]!, mapping));
  assert.notEqual(freshText, rotationText(rotationTurns[0]!, mapping));
  const freshScoringProbe = { ...freshRows[0]!, status: "completed" as const, text: freshText };
  assert.ok(!freshSuite.score(freshScoringProbe, [], "memory", mapping).issues.includes("frozen user input changed"));
  assert.ok(suiteDefinition("rotation40", "current").score(freshScoringProbe, [], "memory", mapping).issues.includes("frozen user input changed"),
    "The runner must pass fresh-v1 to the scorer instead of scoring new text against the original wording");
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
  const sourceOrder = { id: mapping.orders.B };
  const sourceReply: Reply = { kind: "order", text: "当前本人订单", orders: [{ id: mapping.orders.B, status: "paid",
    paidCents: 7980, refundedCents: 0, couponStatuses: ["unused"] }], evidenceIds: [] };
  const candidateSource = { ...rows[5]!, requestId: "source6", score, reply: sourceReply,
    calls: [{ name: "get_order", input: { identity, orderId: mapping.orders.B }, output: sourceOrder, isError: false }],
    sends: [{ reply: sourceReply }], result: { outcome: "ready", reply: sourceReply,
      evidence: { requestId: "source6", order: sourceOrder } } } as unknown as Row;
  const presentation = { ...rows[6]!, requestId: "shown7", score,
    result: { referencePresentation: "order", evidence: { orderReferenceChoices: choices } },
    sends: [{ renderedText: `订单 B\n选择订单 ${token}` }] } as unknown as Row;
  assert.equal(commandFromPrior(o4RecoveryTurns[7]!, [candidateSource, presentation], mapping).text, `选择订单 ${token}`);
  const absent = structuredClone(presentation); absent.sends[0]!.renderedText = "只展示订单号，没有选择指令";
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [candidateSource, absent], mapping));
  const replacedSource = { ...candidateSource, requestId: "invented-source" };
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [replacedSource, presentation], mapping));
  const earlierCard = { ...candidateSource, id: 5 };
  const laterPreparation = { ...candidateSource, requestId: "merchant6", result: { ...candidateSource.result!,
    reply: confirmation, evidence: { ...candidateSource.result!.evidence, requestId: "merchant6" } }, reply: confirmation };
  assert.equal(commandFromPrior(o4RecoveryTurns[7]!, [earlierCard, laterPreparation, presentation], mapping).text, `选择订单 ${token}`,
    "A newer merchant read cannot replace the displayed order-card request ID");
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [laterPreparation, presentation], mapping));
  const notACard = { ...candidateSource, result: { ...candidateSource.result!, reply: confirmation }, reply: confirmation };
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [notACard, presentation], mapping));
  const noFreshRead = { ...candidateSource, calls: [] };
  assert.throws(() => commandFromPrior(o4RecoveryTurns[7]!, [noFreshRead, presentation], mapping));
  assert.equal(commandFromPrior(rotationTurns[0]!, [], mapping, "rotation40").text, `查询订单 ${mapping.orders.A} 的当前状态。`);
  // The second confirmation is still copied from its actual B reply, not a new command assembled from the plan.
  const shownB = structuredClone(shown); shownB.id = 6; shownB.requestId = "prepare-b";
  assert.ok(shownB.reply?.kind === "merchant_confirmation"); shownB.reply.orderId = mapping.orders.B;
  shownB.reply.confirmationText = `确认联系商家 ${mapping.orders.B} 原因：行程变化`;
  shownB.sends[0]!.renderedText = shownB.reply.confirmationText;
  assert.equal(commandFromPrior(rotationTurns[6]!, [shownB], mapping, "rotation40").text, shownB.reply.confirmationText);
  assert.throws(() => commandFromPrior(rotationTurns[6]!, [shown], mapping, "rotation40"));
  mapping.taskA = randomUUID(); mapping.taskB = randomUUID(); const now = Date.now();
  const taskChoices = refreshTaskChoices(undefined, { candidates: ["A", "B"].map(alias => ({
    taskId: alias === "A" ? mapping.taskA! : mapping.taskB!, orderId: mapping.orders[alias as "A" | "B"],
    origin: "confirmed" as const, anchorAt: now - 1000, expiresAt: now + 899000 })), overflow: false }, binding, now)!;
  assert.ok(taskChoices);
  const taskPresentation = { ...rotationRows[7]!, requestId: "shown8", score,
    result: { referencePresentation: "task", evidence: { taskChoices } },
    sends: [{ renderedText: taskChoices.candidates.map(candidate => `选择任务 ${candidate.token}`).join("\n") }] } as unknown as Row;
  const aToken = taskChoices.candidates[0]!.token, bToken = taskChoices.candidates[1]!.token;
  assert.equal(commandFromPrior(rotationTurns[8]!, [taskPresentation], mapping, "rotation40").text, `选择任务 ${aToken}`);
  const replay = commandFromPrior(rotationTurns[21]!, [taskPresentation], mapping, "rotation40");
  assert.equal(replay.text, `选择任务 ${aToken}`);
  assert.equal(replay.material?.sourceTurn, 8);
  const taskHidden = structuredClone(taskPresentation); taskHidden.sends[0]!.renderedText = "只展示任务名，没有选择指令";
  assert.throws(() => commandFromPrior(rotationTurns[8]!, [taskHidden], mapping, "rotation40"));
  assert.throws(() => commandFromPrior(rotationTurns[8]!, [taskPresentation], { ...mapping, groupOpenid: "OTHER_GROUP" }, "rotation40"));
  const expired = structuredClone(taskPresentation);
  for (const candidate of expired.result!.evidence.taskChoices!.candidates) {
    candidate.reference.anchorAt = now - 901000; candidate.reference.expiresAt = now - 1000;
  }
  assert.throws(() => commandFromPrior(rotationTurns[8]!, [expired], mapping, "rotation40"));
  assert.equal(commandFromPrior(rotationTurns[21]!, [expired], mapping, "rotation40").text, `选择任务 ${aToken}`,
    "A deliberate stale-token replay must preserve the original actual display");
  const redisplayed = { ...rotationRows[21]!, requestId: "rejected22", score,
    hostReceipt: { version: "task-selection-v1", outcome: "rejected", choices: taskChoices },
    sends: taskPresentation.sends } as unknown as Row;
  assert.equal(commandFromPrior(rotationTurns[22]!, [redisplayed], mapping, "rotation40").text, `选择任务 ${bToken}`);
  assert.deepEqual(parseCli(["--suite", "rotation40", "--check"]), { suite: "rotation40", taskReferenceMode: "id", args: ["--check"] });
  assert.deepEqual(parseCli(["--freeze-faux", "manifest.json", "--suite", "rotation40"]), { suite: "rotation40", taskReferenceMode: "id", args: ["--freeze-faux", "manifest.json"] });
  assert.deepEqual(parseCli(["--check"]), { suite: "recovery20", taskReferenceMode: "id", args: ["--check"] });
  assert.deepEqual(parseCli(["--task-reference", "current", "--suite", "rotation40", "--check"]),
    { suite: "rotation40", taskReferenceMode: "current", args: ["--check"] });
  assert.deepEqual(parseCli(["--freeze", "manifest.json", "--suite", "rotation40", "--task-reference", "current"]),
    { suite: "rotation40", taskReferenceMode: "current", args: ["--freeze", "manifest.json"] });
  assert.deepEqual(parseCli(["--suite", "rotation40fresh", "--task-reference", "current", "--freeze", "fresh.json"]),
    { suite: "rotation40fresh", taskReferenceMode: "current", args: ["--freeze", "fresh.json"] });
  assert.deepEqual(parseCli(["--inspect", "fresh.json", "--suite", "rotation40fresh"]),
    { suite: "rotation40fresh", taskReferenceMode: "id", args: ["--inspect", "fresh.json"] });
  assert.throws(() => parseCli(["--suite", "rotation80", "--check"]));
  assert.throws(() => parseCli(["--suite", "rotation40", "--suite", "recovery20", "--check"]));
  assert.throws(() => parseCli(["--task-reference", "current", "--check"]));
  assert.throws(() => parseCli(["--task-reference", "selected", "--check"]));
  assert.throws(() => parseCli(["--task-reference"]));
  assert.throws(() => parseCli(["--task-reference", "id", "--task-reference", "id", "--check"]));
  assert.throws(() => suiteDefinition("recovery20", "current"));
  const idSettings = taskReferenceSettings("rotation40", "id"), currentSettings = taskReferenceSettings("rotation40", "current");
  assert.equal(idSettings.taskReferenceContractVersion, "task-reference-mode-v1");
  assert.equal(idSettings.taskReferenceSchemaHash, contentHash(getModelSupportActionParameters("id")));
  assert.equal(currentSettings.taskReferenceSchemaHash, contentHash(getModelSupportActionParameters("current")));
  assert.notEqual(idSettings.taskReferenceSchemaHash, currentSettings.taskReferenceSchemaHash);
  assert.notEqual(contentHash(idSettings), contentHash(currentSettings));
  const idAction = suiteDefinition("rotation40").fauxAction(18, "mysql", mapping);
  const currentAction = suiteDefinition("rotation40", "current").fauxAction(18, "mysql", mapping);
  assert.ok(idAction?.kind === "merchant_status" && "taskRef" in idAction);
  assert.ok(currentAction?.kind === "merchant_status" && "taskRef" in currentAction);
  assert.deepEqual(idAction.taskRef, { taskId: mapping.taskA });
  assert.deepEqual(currentAction.taskRef, { kind: "current" });
  assert.deepEqual(freshSuite.fauxAction(18, "mysql", mapping), currentAction);
  assert.deepEqual(taskReferenceSettings("rotation40fresh", "current"), currentSettings);
  // Prebuilt rows preserve both arms and the full denominator even if nothing starts.
  assert.equal(rows.filter(r => r.status === "skipped").length, 40);
  assert.equal(rotationRows.filter(r => r.status === "skipped").length, 80);
  assert.equal(freshRows.filter(r => r.status === "skipped").length, 80);
  console.log("O4 probe runner checks passed: original/fresh 40/80 planned rows and wording-bound scoring, explicit id/current schema snapshots, actual order/task/confirmation display binding, stale-token replay and redisplay, disabled remote stages and unknown-cost accounting; no database/network.");
}
function parseCli(input: string[]): { suite: SuiteName; taskReferenceMode: TaskReferenceMode; args: string[] } {
  const args = [...input]; let suite: SuiteName = "recovery20", taskReferenceMode: TaskReferenceMode = "id";
  const suiteIndex = args.indexOf("--suite");
  if (suiteIndex >= 0) {
    const value = args[suiteIndex + 1]; assert.ok(value && validSuite(value), "--suite must be recovery20, rotation40 or rotation40fresh");
    suite = value; args.splice(suiteIndex, 2); assert.ok(!args.includes("--suite"), "--suite may be provided only once");
  }
  const taskIndex = args.indexOf("--task-reference");
  if (taskIndex >= 0) {
    const value = args[taskIndex + 1]; assert.ok(value === "id" || value === "current", "--task-reference must be id or current");
    taskReferenceMode = value; args.splice(taskIndex, 2); assert.ok(!args.includes("--task-reference"), "--task-reference may be provided only once");
  }
  taskReferenceSettings(suite, taskReferenceMode);
  return { suite, taskReferenceMode, args };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { suite, taskReferenceMode, args } = parseCli(process.argv.slice(2));
  if (!args.length || args.length === 1 && args[0] === "--check") await checkO4RecoveryProbe();
  else {
    assert.ok(args.length === 2 && ["--freeze", "--freeze-faux", "--inspect", "--live", "--faux"].includes(args[0]!),
      "Use [--suite recovery20|rotation40|rotation40fresh] [--task-reference id|current] --check|--freeze|--freeze-faux|--inspect|--live|--faux MANIFEST; current requires a rotation suite; --faux uses the real local database");
    if (args[0] === "--freeze" || args[0] === "--freeze-faux") await freezeO4RecoveryProbe(args[1]!, args[0] === "--freeze" ? "live" : "faux", suite, taskReferenceMode);
    else if (args[0] === "--inspect") { const value = await inspectO4RecoveryProbe(args[1]!, suite, taskReferenceMode); console.log(json({ frozen: true, suite, taskReferenceMode, execution: value.manifest.configuration.execution, providerRequests: 0, databaseCalls: 0 })); }
    else {
      const result = await runO4RecoveryProbe(args[1]!, args[0] === "--live" ? "live" : "faux", suite, taskReferenceMode);
      process.exitCode = result.runIntegrityPassed && result.executionComplete && result.rows.every(row => row.score?.passed) ? 0 : 1;
    }
  }
}
