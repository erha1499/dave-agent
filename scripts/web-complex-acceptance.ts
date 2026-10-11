import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPool, type RowDataPacket } from "mysql2/promise";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../src/bailian.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import type { EvalStep } from "../src/evaluation.ts";
import { modelPricing } from "../src/model-selection.ts";
import { createModelRequestFetch, currentModelTask, ModelRequestNotDispatchedError, readModelTaskLimits, type ModelTaskSummary } from "../src/model-request-budget.ts";
import { renderReply } from "../src/reply.ts";
import { WebChatSessions, type WebChatResult } from "../src/web-chat.ts";
import { createWebChatAgentFactory, createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";
import { createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const repair = ["--repair-check", "--repair-live"].includes(process.argv[2] ?? "");
const batchName = repair ? "web-order-scope-repair" : "web-complex";
const root = new URL("../", import.meta.url), planPath = `data/${batchName}-plan-20261011.json`;
const directory = new URL(`.runtime/${repair ? batchName : "web-complex-acceptance"}-20261011/`, root);
const freezePath = repair ? "data/web-order-scope-repair-freeze-20261011.json" : "data/web-demo-freeze-20261011.json";
const frozenLimits = { scenarios: repair ? 3 : 4, turns: repair ? 6 : 8, providerRequests: repair ? 24 : 32,
  deadlineMs: repair ? 600000 : 900000, turnTimeoutMs: 90000, estimatedUsd: repair ? .10 : .20, providerRetries: 0 };
const frozenSettings = { modelSelection: "configured", thinkingLevel: "off", maxTokens: 2048 } as const;
const frozenTaskLimits = { httpRequests: 12, contextBudgetUnits: 65536 };
const actors = { "demo-a": { appId: "TEST_APP", senderId: "TEST_USER1" }, "demo-b": { appId: "TEST_APP", senderId: "TEST_USER2" } };
type Planned = { id: string; question: string; orderId: string | null; requiresCurrentOrder: boolean; requiredSources: string[]; criteria: string[]; deltaExpectation?: "none" | "required" | "optional" };
type Scenario = { id: string; title: string; profile: keyof typeof actors; turns: Planned[] };
type Precondition = { status: string; paidCents: number; refundedCents: number; productId: string; couponStatuses: string[] };
type Plan = { version: "web-complex-v1" | "web-order-scope-repair-v1"; baselineCommit: string; dataUse: string; limits: typeof frozenLimits;
  settings: typeof frozenSettings; expectedModel: { provider: string; id: string; api: string }; taskLimits: typeof frozenTaskLimits;
  cases: Scenario[]; commonCriteria: string[]; dependencyPolicy: string; costPolicy: string; statePolicy: string; preconditions: Record<string, Precondition> };
type Facts = { orders: Record<string, Awaited<ReturnType<CouponStore["getOrder"]>>>; lists: Record<string, Awaited<ReturnType<CouponStore["listOrders"]>>> };
type Snapshot = { facts: Facts; knowledge: RowDataPacket[] };
type Event = { name: string; data: Record<string, unknown> };
type Check = { id: string; passed: boolean };
type Row = { id: string; caseId: string; turn: number; profile: keyof typeof actors; question: string;
  execution: "not_run" | "completed" | "failed"; reason: string | null; requestId: string | null; sessionId: string | null;
  events: Event[]; receipt: WebChatResult | null; finalRenderedReply: string | null; firstDeltaMs: number | null;
  nativeDeltas: string[]; steps: EvalStep[]; retries: unknown[]; modelTasks: ModelTaskSummary[];
  before: Snapshot | null; after: Snapshot | null; checks: Check[];
  review: { status: "unreviewed"; forHumanReview: true; humanAcceptance: false; criteria: string[] } };
const hashRequest = (id: string) => createHash("sha256").update(id).digest("hex");
const stableFacts = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === "asOf" ? undefined : item));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const input = (step: EvalStep) => step.input as { orderId?: string; shopId?: string; productId?: string } | undefined;
function output(step: EvalStep): unknown {
  const result = step.output as { content?: Array<{ type: string; text?: string }> } | undefined;
  try { return JSON.parse(result?.content?.filter(part => part.type === "text").map(part => part.text).join("") ?? ""); } catch { return null; }
}
function validatePlan(value: unknown): asserts value is Plan {
  assert.ok(object(value));
  assert.equal(value.version, repair ? "web-order-scope-repair-v1" : "web-complex-v1"); assert.match(String(value.baselineCommit), /^[a-f0-9]{40}$/u);
  assert.deepEqual(value.limits, frozenLimits); assert.deepEqual(value.settings, frozenSettings); assert.deepEqual(value.taskLimits, frozenTaskLimits);
  assert.deepEqual(value.expectedModel, { provider: "deepseek", id: "deepseek-flash", api: "openai-completions" });
  assert.ok(Array.isArray(value.cases) && value.cases.length === frozenLimits.scenarios && Array.isArray(value.commonCriteria) && value.commonCriteria.length >= 2);
  const ids = new Set<string>(), owners = new Map<string, string>();
  for (const scenario of value.cases) {
    assert.ok(object(scenario) && typeof scenario.id === "string" && !ids.has(scenario.id)
      && typeof scenario.title === "string" && ["demo-a", "demo-b"].includes(String(scenario.profile))
      && Array.isArray(scenario.turns) && scenario.turns.length === 2);
    ids.add(scenario.id);
    for (const turn of scenario.turns) {
      assert.ok(object(turn) && typeof turn.id === "string" && !ids.has(turn.id) && typeof turn.question === "string"
        && turn.question.trim() && turn.question.length <= 2000 && typeof turn.requiresCurrentOrder === "boolean"
        && (turn.orderId === null || typeof turn.orderId === "string" && /^COUPON-\d{4}$/u.test(turn.orderId))
        && (!turn.requiresCurrentOrder || turn.orderId !== null) && Array.isArray(turn.requiredSources)
        && turn.requiredSources.every(id => typeof id === "string" && /^KB-[A-Z0-9-]+$/u.test(id))
        && new Set(turn.requiredSources).size === turn.requiredSources.length && Array.isArray(turn.criteria) && turn.criteria.length >= 2
        && turn.criteria.every(text => typeof text === "string" && text.trim()));
      assert.ok(repair ? ["none", "required", "optional"].includes(String(turn.deltaExpectation)) : turn.deltaExpectation === undefined);
      ids.add(turn.id);
      if (turn.orderId) {
        assert.ok(!owners.has(turn.orderId) || owners.get(turn.orderId) === scenario.profile, "A frozen order has one trusted owner");
        owners.set(turn.orderId, String(scenario.profile));
      }
    }
  }
  assert.ok(value.commonCriteria.every(text => typeof text === "string" && text.trim()));
  for (const key of ["dataUse", "dependencyPolicy", "costPolicy", "statePolicy"]) assert.equal(typeof value[key], "string");
  assert.ok(object(value.preconditions)); assert.deepEqual(Object.keys(value.preconditions).sort(), [...owners.keys()].sort());
  for (const expected of Object.values(value.preconditions)) {
    assert.ok(object(expected) && typeof expected.status === "string" && typeof expected.productId === "string"
      && Number.isSafeInteger(expected.paidCents) && Number(expected.paidCents) >= 0
      && Number.isSafeInteger(expected.refundedCents) && Number(expected.refundedCents) >= 0
      && Array.isArray(expected.couponStatuses) && expected.couponStatuses.length > 0
      && expected.couponStatuses.every(status => typeof status === "string"));
  }
}
async function loadPlan() { const plan: unknown = JSON.parse(await readFile(new URL(planPath, root), "utf8")); validatePlan(plan); return plan; }
const rowsForPlan = (plan: Plan): Row[] => plan.cases.flatMap(scenario => scenario.turns.map((turn, index) => ({
  id: turn.id, caseId: scenario.id, turn: index + 1, profile: scenario.profile, question: turn.question, execution: "not_run", reason: null,
  requestId: null, sessionId: null, events: [], receipt: null, finalRenderedReply: null, firstDeltaMs: null, nativeDeltas: [], steps: [], retries: [], modelTasks: [],
  before: null, after: null, checks: [], review: { status: "unreviewed", forHumanReview: true, humanAcceptance: false, criteria: [...turn.criteria, ...plan.commonCriteria] },
})));
const engineeringPassed = (row: Row) => row.execution === "completed" && row.reason === null && row.checks.length > 0 && row.checks.every(check => check.passed);
function priorSatisfied(rows: Row[], row: Row) {
  return row.turn === 1 || rows.some(prior => prior.caseId === row.caseId && prior.turn === row.turn - 1 && engineeringPassed(prior));
}
function summary(plan: Plan, rows: Row[]) {
  assert.deepEqual(rows.map(row => row.id), plan.cases.flatMap(scenario => scenario.turns.map(turn => turn.id)), "Keep the complete frozen denominator");
  return { plannedScenarios: plan.cases.length, planned: rows.length, executed: rows.filter(row => row.execution !== "not_run").length,
    engineeringPassed: rows.filter(engineeringPassed).length, answerReviewed: 0, jointPassed: 0, admitted: false, humanAcceptance: false };
}
function parseFrame(frame: string): Event {
  const name = /^event: (.+)$/mu.exec(frame)?.[1], raw = /^data: (.+)$/mu.exec(frame)?.[1];
  assert.ok(name && raw); const data: unknown = JSON.parse(raw); assert.ok(object(data)); return { name, data };
}
function assertPreconditions(plan: Plan, facts: Facts) {
  for (const [id, expected] of Object.entries(plan.preconditions)) {
    const order = facts.orders[id]; assert.ok(order, `Missing frozen order ${id}`);
    assert.deepEqual({ status: order.status, paidCents: order.amounts.paidCents, refundedCents: order.amounts.refundedCents,
      productId: order.items[0]?.productId, couponStatuses: order.coupons.map(coupon => coupon.status) }, expected, `Precondition changed for ${id}`);
    assert.ok(order.items.every(item => item.productId === expected.productId), `Unexpected product in ${id}`);
  }
}
function sourceApplies(document: unknown, order: Facts["orders"][string] | undefined) {
  if (!order || !object(document) || !object(document.scope)) return false;
  const scope = document.scope;
  return (scope.shopId === null || scope.shopId === order.shop.id)
    && (scope.productId === null || order.items.some(item => item.productId === scope.productId));
}
function requireProviderSuccess(response: Response, stop: () => void) {
  if (!response.ok) { stop(); throw new Error(`Provider HTTP failed: ${response.status}`); }
  return response;
}
function checksFor(plan: Planned, row: Row): Check[] {
  const checks: Check[] = [], check = (id: string, passed: boolean) => checks.push({ id, passed });
  const tools = row.steps.filter(step => step.type === "tool"), good = tools.filter(step => !step.isError);
  const orders = row.receipt?.reply.kind === "order" ? row.receipt.reply.orders : [];
  const deltas = row.events.filter(event => event.name === "delta").map(event => event.data.text);
  let cursor = 0;
  const genuine = deltas.every(delta => {
    if (typeof delta !== "string") return false;
    const index = row.nativeDeltas.indexOf(delta, cursor); cursor = index + 1; return index >= 0;
  });
  check("transport.completed", row.execution === "completed" && !!row.receipt && row.events.filter(event => event.name === "result").length === 1);
  check("capture.complete", row.reason === null);
  check("transport.real-delta", genuine);
  if (plan.deltaExpectation === "none") check("transport.no-free-delta", deltas.length === 0);
  if (plan.deltaExpectation === "required") check("transport.native-delta-present", genuine && deltas.length > 0);
  check("tools.read-only", tools.every(step => ["get_order", "list_orders", "search_faq"].includes(step.name)));
  check("state.unchanged", !!row.before && !!row.after && isDeepStrictEqual(stableFacts(row.before.facts), stableFacts(row.after.facts)));
  check("rules.unchanged", !!row.before && !!row.after && isDeepStrictEqual(row.before.knowledge, row.after.knowledge));
  const expected = plan.orderId ? row.before?.facts.orders[plan.orderId] : undefined;
  const current = good.filter(step => step.name === "get_order" && input(step)?.orderId === plan.orderId);
  if (plan.requiresCurrentOrder) {
    check("trace.current-order", !!expected && current.some(step => isDeepStrictEqual(stableFacts(output(step)), stableFacts(expected))));
    check("reply.current-order", !!expected && orders.length === 1 && orders[0]!.id === expected.id && orders[0]!.status === expected.status
      && orders[0]!.paidCents === expected.amounts.paidCents && orders[0]!.refundedCents === expected.amounts.refundedCents
      && isDeepStrictEqual(orders[0]!.couponStatuses, expected.coupons.map(coupon => coupon.status)));
  }
  const rules = good.filter(step => step.name === "search_faq");
  const sources = new Set<string>();
  for (const step of rules) {
    const documents = output(step);
    if (!Array.isArray(documents)) continue;
    const currentFirst = !plan.requiresCurrentOrder || !!expected && current.some(order => order.index < step.index);
    if (currentFirst) for (const document of documents)
      if (object(document) && typeof document.sourceId === "string" && (!plan.requiresCurrentOrder || sourceApplies(document, expected))) sources.add(document.sourceId);
  }
  if (plan.requiredSources.length) {
    check("trace.required-sources", plan.requiredSources.every(id => sources.has(id)));
    check("reply.required-sources", plan.requiredSources.every(id => row.receipt?.reply.evidenceIds?.includes(id)));
  }
  check("rules.frozen-corpus", !!row.before && rules.every(step => {
    const documents = output(step);
    return Array.isArray(documents) && documents.every(document => object(document) && object(document.scope)
      && row.before!.knowledge.some(source => source.id === document.sourceId && source.title === document.title && source.body === document.body
        && source.shop_id === (document.scope as Record<string, unknown>).shopId && source.product_id === (document.scope as Record<string, unknown>).productId));
  }));
  check("trace.frozen-orders", !!row.before && good.filter(step => step.name === "get_order").every(step => {
    const value = output(step); return object(value) && typeof value.id === "string" && !!row.before!.facts.orders[value.id]
      && isDeepStrictEqual(stableFacts(value), stableFacts(row.before!.facts.orders[value.id]));
  }));
  if (plan.orderId === null) {
    check("trace.no-auto-selection", !tools.some(step => step.name === "get_order"));
    check("reply.no-auto-selection", orders.length === 0 || good.some(step => step.name === "list_orders") || row.receipt?.origin === "host");
  }
  return checks;
}
async function sourceHashes() {
  const frozen = JSON.parse(await readFile(new URL(freezePath, root), "utf8"));
  const paths = Object.keys(frozen.runtimeHashes).sort(); assert.equal(paths.length, repair ? 212 : 211);
  const hashes = Object.fromEntries(await Promise.all(paths.map(async file => [file, contentHash(await readFile(new URL(file, root)))])));
  assert.deepEqual(hashes, frozen.runtimeHashes, "All frozen runtime files must stay unchanged");
  for (const file of [planPath, "scripts/web-complex-acceptance.ts", freezePath])
    hashes[file] = contentHash(await readFile(new URL(file, root)));
  return hashes;
}

export async function checkWebComplexAcceptance() {
  const plan = await loadPlan(), rows = rowsForPlan(plan);
  assert.equal(summary(plan, rows).planned, frozenLimits.turns); assert.equal(summary(plan, rows).executed, 0);
  assert.throws(() => summary(plan, rows.slice(1)));
  assert.equal(priorSatisfied(rows, rows[1]!), false); rows[0]!.execution = "completed"; rows[0]!.checks = [{ id: "receipt", passed: false }];
  assert.equal(priorSatisfied(rows, rows[1]!), false); rows[0]!.checks[0]!.passed = true; assert.equal(priorSatisfied(rows, rows[1]!), true);
  assert.equal(priorSatisfied(rows, rows[2]!), true, "Independent cases do not inherit another case's failure");
  const noTrace = rowsForPlan(plan)[0]!; noTrace.execution = "completed";
  noTrace.events = [{ name: "delta", data: { text: "fabricated" } }];
  const checks = checksFor(plan.cases[0]!.turns[0]!, noTrace);
  for (const id of ["trace.current-order", "trace.required-sources", "transport.real-delta"]) assert.ok(checks.some(check => check.id === id && !check.passed));
  if (!repair) {
    const clarify = rowsForPlan(plan)[6]!;
    assert.ok(checksFor(plan.cases[3]!.turns[0]!, clarify).filter(check => check.id === "trace.no-auto-selection").every(check => check.passed));
  }
  assert.equal(checksFor({ ...plan.cases[0]!.turns[0]!, deltaExpectation: "none" }, noTrace)
    .find(check => check.id === "transport.no-free-delta")!.passed, false);
  assert.equal(checksFor({ ...plan.cases[0]!.turns[0]!, deltaExpectation: "required" }, rowsForPlan(plan)[0]!)
    .find(check => check.id === "transport.native-delta-present")!.passed, false);
  assert.deepEqual(parseFrame('event: delta\ndata: {"text":"中文"}'), { name: "delta", data: { text: "中文" } });
  assert.throws(() => parseFrame("event: delta\ndata: null"));
  const order: Facts["orders"][string] = { source: "demo-database", id: "COUPON-1001", status: "paid", asOf: "2026-10-11T00:00:00.000Z",
    amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "shop-demo-1", name: "Offline", merchantName: "Offline", address: "Offline" },
    items: [{ id: "item", productId: "product-demo-1", productName: "Offline", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: null, redeemedAt: null, redeemedShopId: null }], payments: [], refunds: [] };
  assert.equal(sourceApplies({ scope: { shopId: null, productId: null } }, order), true, "A generic rule applies after current-order evidence");
  assert.equal(sourceApplies({ scope: { shopId: order.shop.id, productId: "product-demo-2" } }, order), false, "Another product is not applicable evidence");
  assert.equal(sourceApplies({ scope: { shopId: "other-shop", productId: null } }, order), false);
  const documents = plan.cases[0]!.turns[0]!.requiredSources.map(sourceId => ({ sourceId, title: sourceId, body: "offline",
    scope: { shopId: null as string | null, productId: null as string | null } }));
  const sourceRow = rowsForPlan(plan)[0]!;
  sourceRow.before = { facts: { orders: { [order.id]: order }, lists: {} }, knowledge: documents.map(document => ({
    id: document.sourceId, title: document.title, body: document.body, shop_id: null, product_id: null })) as RowDataPacket[] };
  sourceRow.steps = [
    { index: 0, type: "tool", name: "get_order", input: { orderId: order.id }, output: { content: [{ type: "text", text: JSON.stringify(order) }] }, isError: false, durationMs: 0 },
    { index: 1, type: "tool", name: "search_faq", input: { query: "offline" }, output: { content: [{ type: "text", text: JSON.stringify(documents) }] }, isError: false, durationMs: 0 },
  ];
  const sourcesPassed = () => checksFor(plan.cases[0]!.turns[0]!, sourceRow).find(check => check.id === "trace.required-sources")!.passed;
  assert.equal(sourcesPassed(), true, "Current order plus generic rules needs no artificial FAQ argument constraint");
  sourceRow.steps[1]!.output = { content: [{ type: "text", text: JSON.stringify(documents.slice(1)) }] };
  assert.equal(sourcesPassed(), false, "Removing one required source must fail");
  documents[0]!.scope.productId = "product-demo-2";
  sourceRow.steps[1]!.output = { content: [{ type: "text", text: JSON.stringify(documents) }] };
  assert.equal(sourcesPassed(), false, "The required ID alone cannot authorize another product's rule");
  documents[0]!.scope.productId = null; sourceRow.steps[1]!.output = { content: [{ type: "text", text: JSON.stringify(documents) }] };
  sourceRow.steps[0]!.index = 2; assert.equal(sourcesPassed(), false, "Current order must precede rule retrieval");
  const fixturePlan = { ...plan, preconditions: { [order.id]: plan.preconditions[order.id]! } }, fixtureFacts = { orders: { [order.id]: order }, lists: {} };
  assertPreconditions(fixturePlan, fixtureFacts); assert.throws(() => assertPreconditions(fixturePlan, { ...fixtureFacts,
    orders: { [order.id]: { ...order, amounts: { ...order.amounts, paidCents: 1 } } } }));
  let sends = 0;
  const guard = createC1ValidationGuard(async () => { sends++; return new Response("{}"); }, () => 0,
    { requests: { agent: 1, rerank: 0, support: 0 }, deadlineMs: 1000, turnTimeoutMs: 1000, estimatedUsd: .20, estimatedCny: .01 });
  guard.setActive({ caseId: "offline", turn: 1, requestId: "offline", signal: new AbortController().signal });
  await guard.fetchFor("agent")("https://offline.invalid"); await assert.rejects(guard.fetchFor("agent")("https://offline.invalid"));
  assert.equal(sends, 1); assert.equal(guard.usage().agent.estimatedCost, null); guard.seal();
  const costGuard = createC1ValidationGuard(async () => { sends++; return new Response("{}"); }, () => 0,
    { requests: { agent: 3, rerank: 0, support: 0 }, deadlineMs: 1000, turnTimeoutMs: 1000, estimatedUsd: .20, estimatedCny: .01 });
  costGuard.setActive({ caseId: "offline", turn: 1, requestId: "offline-cost", signal: new AbortController().signal });
  await costGuard.fetchFor("agent")("https://offline.invalid"); costGuard.record(0, 1, .21);
  await assert.rejects(costGuard.fetchFor("agent")("https://offline.invalid")); assert.equal(sends, 2); costGuard.seal();
  let failedTransportStopped = false;
  const failedGuard = createC1ValidationGuard(async () => new Response("unavailable", { status: 503 }), () => 0,
    { requests: { agent: 3, rerank: 0, support: 0 }, deadlineMs: 1000, turnTimeoutMs: 1000, estimatedUsd: .20, estimatedCny: .01 });
  failedGuard.setActive({ caseId: "offline", turn: 1, requestId: "offline-failure", signal: new AbortController().signal });
  const failedResponse = await failedGuard.fetchFor("agent")("https://offline.invalid");
  assert.throws(() => requireProviderSuccess(failedResponse, () => { failedTransportStopped = true; }));
  assert.equal(failedTransportStopped, true); assert.equal(failedGuard.requests.length, 1); assert.equal(failedGuard.requests[0]!.httpStatus, 503);
  assert.equal(failedGuard.usage().agent.estimatedCost, null); failedGuard.seal();
  await sourceHashes(); await readC1ValidationDependencies();
  console.log(`PASS ${batchName} contract: ${frozenLimits.scenarios} cases/${frozenLimits.turns} rows, prior dependency, source scope, required/forbidden native delta, budget and frozen provenance; zero DB/provider requests.`);
}

async function runLive() {
  const plan = await loadPlan(), config = readDatabaseConfig();
  assert.ok(config.host === "127.0.0.1" && config.port === 13306 && config.database === "dave_agent"
    && config.user === "dave_agent_read" && !config.socketPath && config.multipleStatements === false, "Only local synthetic read-only DB is permitted");
  assert.deepEqual(readModelTaskLimits(), plan.taskLimits, "Use frozen M2/M4 limits");
  const hashes = await sourceHashes(), dependencies = await readC1ValidationDependencies();
  assert.equal(execFileSync("git", ["rev-parse", plan.baselineCommit], { cwd: root, encoding: "utf8" }).trim(), plan.baselineCommit);
  await mkdir(directory, { recursive: true });
  await (await open(new URL("live.attempt", directory), "wx")).close();
  const rows = rowsForPlan(plan), runId = randomUUID(), env = { ...process.env }, pool = createPool(config), store = new CouponStore(pool);
  const guard = createC1ValidationGuard(fetch, Date.now, { requests: { agent: plan.limits.providerRequests, rerank: 0, support: 0 },
    deadlineMs: plan.limits.deadlineMs, turnTimeoutMs: plan.limits.turnTimeoutMs, estimatedUsd: plan.limits.estimatedUsd, estimatedCny: .01 });
  const batch = new AbortController(), deadline = AbortSignal.any([batch.signal, AbortSignal.timeout(plan.limits.deadlineMs)]);
  const artifact = { version: plan.version, runId, startedAt: new Date().toISOString(), completedAt: null as string | null,
    status: "failed", failure: null as string | null, stopReason: null as string | null, manifest: null as unknown, manifestHash: null as string | null,
    sourceHashesAfter: null as unknown, dependenciesAfter: null as unknown, knowledgeAfter: null as unknown,
    codeStable: false, knowledgeStable: false, runIntegrityPassed: false, actualConfigurations: [] as unknown[], modelConfigurations: [] as unknown[],
    attributionFailures: [] as string[], rows, requests: guard.requests, usage: guard.usage(), summary: summary(plan, rows), answerReviewInputs: [] as unknown[],
    databaseWrites: 0, qqSends: 0, scope: "Real local Web HTTP/SSE, DeepSeek and read-only synthetic MySQL; in-memory SQLite history. No browser/QQ/commercial acceptance." };
  const stop = (reason: string) => { artifact.stopReason ??= reason; batch.abort(); };
  const attributionFailure = (reason: string) => { artifact.attributionFailures.push(reason); stop("accounting_or_event_attribution_failed"); };
  const save = async () => {
    artifact.usage = guard.usage(); artifact.summary = summary(plan, rows);
    artifact.answerReviewInputs = rows.map(row => ({ id: row.id, caseId: row.caseId, turn: row.turn, execution: row.execution, question: row.question,
      finalRenderedReply: row.finalRenderedReply,
      finalWebReply: row.receipt?.reply ?? null, finalWebText: row.receipt?.reply.text ?? null,
      replyHash: row.receipt ? contentHash(row.receipt.reply) : null,
      channel: "Actual SSE result.reply is the Web answer; finalRenderedReply is a retained generic 500-codepoint order proxy.",
      sentDeltaText: row.events.filter(event => event.name === "delta").map(event => event.data.text).join(""),
      criteria: row.review.criteria, criteriaHash: contentHash(row.review.criteria), review: row.review }));
    await writeFile(new URL("live-results.json", directory), JSON.stringify(artifact, null, 2));
  };
  const requestRows = new Map<string, Row>(), sealedRows = new Set<string>(), runtimes = new WeakSet<object>();
  let active: { row: Row; capture: ReturnType<typeof captureEvaluationTurn>; usageCursor: number } | undefined;
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    const value = values[0];
    if (typeof value !== "string" || !value.startsWith("[model-task] ")) { originalError(...values); return; }
    try {
      const task = JSON.parse(value.slice(13)) as ModelTaskSummary, row = requestRows.get(task.requestIdHash);
      if (!row || sealedRows.has(row.id) || row.modelTasks.length) { attributionFailure("unknown_late_or_duplicate_model_task"); return; }
      row.modelTasks.push(task);
    } catch { attributionFailure("malformed_model_task"); }
  };
  const orderOwners = new Map(plan.cases.flatMap(scenario => scenario.turns.flatMap(turn => turn.orderId ? [[turn.orderId, scenario.profile] as const] : [])));
  const knowledge = async () => (await pool.execute<RowDataPacket[]>({ sql: "SELECT /*+ MAX_EXECUTION_TIME(3000) */ id,shop_id,product_id,title,body,tags,status FROM knowledge_documents ORDER BY id", timeout: 5000 }))[0];
  const snapshot = async (): Promise<Snapshot> => ({ facts: {
    orders: Object.fromEntries(await Promise.all([...orderOwners].map(async ([id, profile]) => [id, await store.getOrder(actors[profile], id)]))),
    lists: Object.fromEntries(await Promise.all([...new Set(plan.cases.map(scenario => scenario.profile))].map(async profile => [profile, await store.listOrders(actors[profile])]))),
  }, knowledge: await knowledge() });
  let baseline: Snapshot | undefined;
  try {
    await save();
    const [grantRows] = await pool.query<RowDataPacket[]>({ sql: "SHOW GRANTS FOR CURRENT_USER()", timeout: 5000 });
    const grants = grantRows.map(row => String(Object.values(row)[0]));
    assert.ok(grants.length && grants.every(line => /^GRANT (?:USAGE ON \*\.\*|SELECT ON `[^`]+`\.\*) TO /u.test(line) && !/WITH GRANT OPTION/u.test(line))
      && grants.some(line => /^GRANT SELECT /u.test(line)), "The database account must actually have only USAGE/SELECT");
    await store.ping(); baseline = await snapshot(); assertPreconditions(plan, baseline.facts);
    for (const scenario of plan.cases) for (const turn of scenario.turns)
      assert.ok(turn.requiredSources.every(id => baseline!.knowledge.some(source => source.id === id && source.status === "active")), "Required source missing from frozen corpus");
    const catalog = await createWebChatSettingsCatalog(env), selected = catalog.metadata.configured;
    assert.ok(selected && selected.provider === plan.expectedModel.provider && selected.id === plan.expectedModel.id && selected.api === plan.expectedModel.api);
    assert.deepEqual(await sourceHashes(), hashes, "Freeze unchanged source and plan before the first provider request");
    artifact.manifest = { frozenAt: new Date().toISOString(), baselineCommit: plan.baselineCommit,
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), plan, planHash: contentHash(plan), sourceHashes: hashes, dependencies,
      configuration: { architecture: "atomic", knowledge: "lexical", settings: plan.settings, taskLimits: plan.taskLimits,
        model: { provider: selected.provider, id: selected.id, api: selected.api, baseUrl: selected.baseUrl, contextWindow: selected.contextWindow,
          maxTokens: plan.settings.maxTokens, cost: selected.cost }, sessionAutomaticRetries: 2, providerRetries: 0,
        database: { host: config.host, port: config.port, database: config.database, user: config.user, grants }, tools: ["get_order", "list_orders", "search_faq"] }, baseline };
    artifact.manifestHash = contentHash(artifact.manifest);
    await writeFile(new URL("manifest.json", directory), JSON.stringify({ hash: artifact.manifestHash, ...artifact.manifest as object }, null, 2), { flag: "wx" }); await save();
    const factory = createWebChatAgentFactory(store, env);
    for (const scenario of plan.cases) {
      if (guard.stopped() || deadline.aborted) { artifact.stopReason ??= guard.stopped() ?? "run_deadline"; break; }
      const sessions: AgentSession[] = [], unsubscribe: Array<() => void> = [];
      let chat: WebChatSessions | undefined, server: ReturnType<typeof createWebChatServer> | undefined;
      try {
        const makeAgent: typeof factory = async (...args) => {
          const session = await factory(...args), boundSessionId = args[1]; sessions.push(session);
          assert.equal(session.model?.id, plan.expectedModel.id); assert.equal(session.model?.provider, plan.expectedModel.provider);
          assert.equal(session.model?.maxTokens, 2048); assert.equal(session.thinkingLevel, "off");
          assert.deepEqual(session.getActiveToolNames().sort(), ["get_order", "list_orders", "search_faq"]);
          const retry = session.settingsManager.getRetrySettings(); assert.equal(retry.enabled, true); assert.equal(retry.maxRetries, 2);
          artifact.modelConfigurations.push({ caseId: scenario.id, sessionId: boundSessionId, model: session.model, retry, tools: session.getActiveToolNames() });
          const runtime = session.modelRuntime;
          if (!runtimes.has(runtime)) {
            runtimes.add(runtime); const stream = runtime.streamSimple.bind(runtime);
            runtime.streamSimple = (model, context, options) => stream(model, context, { ...options, maxRetries: 0,
              fetch: createModelRequestFetch({ phase: "agent", provider: model.provider, model: model.id, format: "openai-sse", pricing: modelPricing(model),
                context: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
                  outputTokenField: model.compat && "maxTokensField" in model.compat ? model.compat.maxTokensField : undefined } }, async (url, init) => {
                const task = currentModelTask(), row = task && requestRows.get(task.snapshot().requestIdHash);
                if (!row || active?.row !== row || sealedRows.has(row.id)) { attributionFailure("unbound_provider_request"); throw new ModelRequestNotDispatchedError(); }
                const count = guard.requests.length;
                try { return requireProviderSuccess(await guard.fetchFor("agent")(url, init), () => stop("provider_http_failed")); }
                catch (error) { if (guard.requests.length === count) throw new ModelRequestNotDispatchedError(); stop("provider_transport_failed"); throw error; }
              }) });
          }
          unsubscribe.push(session.subscribe(event => {
            const relevant = event.type.startsWith("tool_execution_") || event.type === "auto_retry_start" || event.type === "auto_retry_end"
              || (event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant"
              || event.type === "message_update" && event.assistantMessageEvent.type === "text_delta";
            if (!relevant) return;
            const current = active, task = currentModelTask();
            if (!current || current.row.caseId !== scenario.id || current.row.sessionId !== boundSessionId || sealedRows.has(current.row.id)
              || task?.snapshot().requestIdHash !== hashRequest(current.row.requestId!)) { attributionFailure("unbound_session_event"); return; }
            const row = current.row; current.capture.receive(event);
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") row.nativeDeltas.push(event.assistantMessageEvent.delta);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") row.retries.push({ type: event.type, attempt: event.attempt });
            if (event.type === "message_end" && event.message.role === "assistant") {
              const sends = guard.requests.map((request, index) => ({ request, index })).filter(entry => entry.index >= current.usageCursor && entry.request.requestId === row.requestId);
              const usage = event.message.usage, valid = usage.totalTokens > 0
                && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)
                && usage.input + usage.output + usage.cacheRead + usage.cacheWrite === usage.totalTokens && Number.isFinite(usage.cost?.total) && usage.cost.total >= 0;
              if (sends.length === 1) { guard.record(sends[0]!.index, valid ? usage.totalTokens : null, valid ? usage.cost.total : null); if (!valid) stop("unknown_provider_usage_or_cost"); }
              else if (sends.length || !["error", "aborted"].includes(event.message.stopReason)) attributionFailure("ambiguous_assistant_http_usage");
              current.usageCursor = guard.requests.length;
            }
          }));
          return session;
        };
        chat = new WebChatSessions(store, makeAgent, plan.limits.turnTimeoutMs, Promise.resolve(catalog)); server = createWebChatServer(chat);
        await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
        const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
        const creation = await fetch(`${origin}/api/chat/session`, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Request": "1" },
          body: JSON.stringify({ profileId: scenario.profile, sessionId: null, settings: plan.settings }), signal: deadline });
        assert.equal(creation.status, 200); const created = await creation.json();
        const cookie = creation.headers.getSetCookie().map(value => value.split(";")[0]!).join("; "), sessionId: string = created.session.id;
        assert.deepEqual(created.session.settings, plan.settings); artifact.actualConfigurations.push({ caseId: scenario.id, session: created.session });
        for (const planned of scenario.turns) {
          const row = rows.find(value => value.id === planned.id)!;
          if (!priorSatisfied(rows, row)) { row.reason = "required_prior_contract_failed"; await save(); continue; }
          if (guard.stopped() || deadline.aborted) { artifact.stopReason ??= guard.stopped() ?? "run_deadline"; break; }
          try {
            row.before = await snapshot();
            if (!isDeepStrictEqual(stableFacts(row.before.facts), stableFacts(baseline.facts)) || !isDeepStrictEqual(row.before.knowledge, baseline.knowledge)) {
              stop("database_or_knowledge_changed"); throw new Error("Frozen database or knowledge changed before turn");
            }
            row.execution = "failed"; row.sessionId = sessionId; row.requestId = randomUUID(); requestRows.set(hashRequest(row.requestId), row);
            active = { row, capture: captureEvaluationTurn(`${selected.provider}/${selected.id}`), usageCursor: guard.requests.length };
            guard.setActive({ caseId: row.caseId, turn: row.turn, requestId: row.requestId, signal: deadline });
            const started = performance.now(), response = await fetch(`${origin}/api/chat/messages/stream`, { method: "POST",
              headers: { Cookie: cookie, "Content-Type": "application/json", "X-Chat-Request": "1" },
              body: JSON.stringify({ sessionId, requestId: row.requestId, text: row.question }), signal: deadline });
            assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u); assert.ok(response.body);
            const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", finished = false;
            for (;;) {
              const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done }); let boundary: RegExpExecArray | null;
              while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
                const event = parseFrame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
                assert.ok(!finished); assert.equal(event.data.sessionId, sessionId); assert.equal(event.data.requestId, row.requestId);
                row.events.push(event);
                if (event.name === "delta") { assert.equal(typeof event.data.text, "string"); row.firstDeltaMs ??= performance.now() - started; }
                if (event.name === "result") { row.receipt = event.data as WebChatResult; finished = true; }
                assert.notEqual(event.name, "error", "SSE returned an error");
              }
              if (chunk.done) break;
            }
            assert.equal(buffer.trim(), ""); assert.ok(finished && row.receipt);
            row.finalRenderedReply = renderReply(row.receipt.reply).text; row.execution = "completed";
          } catch (error) {
            row.reason = error instanceof Error ? error.message : "Turn execution failed";
            stop("turn_transport_or_snapshot_failed"); await Promise.allSettled(sessions.map(session => session.abort()));
          } finally {
            if (active?.row === row) { const captured = active.capture.finish(); row.steps = captured.steps; if (captured.failed) { row.reason ??= "Capture failed"; attributionFailure("capture_failed"); } }
            try { row.after = await snapshot(); } catch { row.reason ??= "Post-turn snapshot failed"; stop("post_turn_snapshot_failed"); }
            row.checks = checksFor(planned, row);
            const tasks = row.modelTasks, sends = guard.requests.filter(request => request.requestId === row.requestId);
            const accounting = tasks.length === 1 && tasks[0]!.entrypoint === "web" && tasks[0]!.requestIdHash === hashRequest(row.requestId ?? "")
              && tasks[0]!.status === "completed" && isDeepStrictEqual(tasks[0]!.limits, plan.taskLimits)
              && tasks[0]!.httpRequests === sends.length && tasks[0]!.unknownUsageAttempts === 0 && tasks[0]!.unknownCostAttempts === 0
              && sends.every(send => send.totalTokens !== null && send.estimatedCost !== null)
              && tasks[0]!.totalTokens === sends.reduce((n, send) => n + (send.totalTokens ?? 0), 0)
              && Math.abs(tasks[0]!.knownCostUsd - sends.reduce((n, send) => n + (send.estimatedCost ?? 0), 0)) < 1e-10 && tasks[0]!.knownCostCny === 0;
            row.checks.push({ id: "accounting.production", passed: accounting });
            if (!accounting) stop("accounting_incomplete_or_mismatched");
            if (row.checks.some(check => ["tools.read-only", "state.unchanged", "rules.unchanged", "rules.frozen-corpus", "trace.frozen-orders", "transport.real-delta"].includes(check.id) && !check.passed)) stop("safety_or_provenance_failed");
            sealedRows.add(row.id); active = undefined; guard.setActive(undefined); await save();
          }
          if (deadline.aborted) break;
        }
      } finally {
        await Promise.allSettled(sessions.map(session => session.abort()));
        unsubscribe.forEach(stopListening => stopListening()); chat?.close(); sessions.forEach(session => session.dispose());
        if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
      }
    }
  } catch (error) { artifact.failure = error instanceof Error ? error.message : "Live setup failed"; stop("setup_or_case_failed"); }
  finally {
    artifact.stopReason ??= guard.stopped(); guard.seal();
    for (const row of rows) if (row.execution === "not_run" && row.reason === null) row.reason = artifact.stopReason ?? "batch_not_completed";
    try {
      artifact.sourceHashesAfter = await sourceHashes(); artifact.dependenciesAfter = await readC1ValidationDependencies(); artifact.knowledgeAfter = await knowledge();
      artifact.codeStable = isDeepStrictEqual(hashes, artifact.sourceHashesAfter) && isDeepStrictEqual(dependencies, artifact.dependenciesAfter);
      artifact.knowledgeStable = !!baseline && isDeepStrictEqual(baseline.knowledge, artifact.knowledgeAfter);
      artifact.runIntegrityPassed = !artifact.failure && !artifact.stopReason && artifact.codeStable && artifact.knowledgeStable && !artifact.attributionFailures.length
        && rows.every(row => row.execution === "completed" && row.reason === null) && guard.usage().agent.unknownCosts === 0 && guard.usage().agent.totalTokens !== null;
      artifact.status = artifact.runIntegrityPassed && summary(plan, rows).engineeringPassed === rows.length ? "engineering-passed-review-pending" : "failed";
    } catch { artifact.failure ??= "Final source/dependency/knowledge verification failed"; }
    try { await store.close(); } catch { artifact.failure ??= "Database close failed"; artifact.status = "failed"; artifact.runIntegrityPassed = false; }
    console.error = originalError; artifact.completedAt = new Date().toISOString(); await save();
  }
  console.log(JSON.stringify({ path: new URL("live-results.json", directory).pathname, status: artifact.status, ...artifact.summary, usage: artifact.usage }));
  if (artifact.status === "failed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assert.ok(process.argv.length <= 3 && [undefined, "--check", "--live", "--repair-check", "--repair-live"].includes(process.argv[2]), "Use --check/--live for the closed original contract or --repair-check/--repair-live for this repair");
  if (["--live", "--repair-live"].includes(process.argv[2] ?? "")) await runLive(); else await checkWebComplexAcceptance();
}
