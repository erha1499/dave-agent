import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import { BailianError, contentHash, createBailianClient, type BailianClient } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportTypedPromptVersion, evidenceSupportTypedV6PromptVersion,
  resolveEvidenceSupportModel, type EvidenceSupportSettings } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { loadKnowledgeApplicabilitySnapshot, type KnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { resolveSupportRunParameters, type SupportExperimentParameters } from "../src/support-parameters.ts";
import { checkC1ValidationScoring, scoreC1ValidationTurn, summarizeC1Validation, verifyC1ValidationManifest,
  type C1AnswerReview, type C1ValidationActual, type C1ValidationManifest, type C1ValidationPlan, type C1ValidationTurn } from "./c1-session-validation-check.ts";

const root = new URL("../", import.meta.url);
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Operation = "agent" | "rerank" | "support";
const operations: Operation[] = ["agent", "rerank", "support"];
export const c1ValidationLimits = { requests: { agent: 120, rerank: 60, support: 60 }, deadlineMs: 45 * 60_000,
  turnTimeoutMs: 60_000, estimatedUsd: 1, estimatedCny: .15 } as const;
export type C1ValidationLimits = { requests: Record<Operation, number>; deadlineMs: number; turnTimeoutMs: number;
  estimatedUsd: number; estimatedCny: number };
type ModelSnapshot = { provider: string; id: string; api: string; baseUrl: string; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } };
export type C1ValidationSetup = {
  version: 1;
  configuration: { architecture: "controller"; parameters: SupportExperimentParameters; model: ModelSnapshot;
    evidenceBindingVersion: "order-evidence-binding-v2"; referenceEvidenceRequired: true;
    dataUse: "fixed-validation-not-blind" | "exposed-development";
    support: EvidenceSupportSettings; rerank: BailianClient["settings"];
    pricing: { estimated: true; asOf: string; source: "Pi catalog and Bailian published estimate"; rerankCnyPerMillionTokens: number | null };
    dependencySnapshot: Awaited<ReturnType<typeof readC1ValidationDependencies>>;
    limits: typeof c1ValidationLimits; sessionAutomaticRetries: 2; providerRetries: 0 };
  corpora: Record<"online" | "reference", RetrievalDocument[]>;
  applicabilitySnapshot?: KnowledgeApplicabilitySnapshot;
  fixtures: Array<{ caseId: string; actor: QQIdentity; groupOpenid: string; orders: Array<{ owner: QQIdentity; order: Order }> }>;
};
type Request = { operation: Operation; caseId: string; turn: number; requestId: string; startedAt: string;
  httpStatus: number | null; error: "request_failed" | null; totalTokens: number | null; estimatedCost: number | null;
  currency: "USD" | "CNY"; usageRecorded: boolean };
type Active = { caseId: string; turn: number; requestId: string; signal: AbortSignal };
type Actual = C1ValidationActual & { reason: string | null; replyHash: string | null; modelFinalText: string | null;
  ingress: { identity: QQIdentity; groupOpenid: string; messageId: string; requestId: string; observedAt: string } | null;
  ingressIntegrityPassed: boolean | null;
  sdkRetryEvents: Array<{ type: string; attempt: number }>; storeReads: StoreRead[];
  stateChange: { applied: boolean; beforeHash: string; afterHash: string | null } | null };
export type StoreRead = { requestId: string; identity: QQIdentity; orderId: string; owner: QQIdentity | null; allowed: boolean; outputHash: string | null };

// Counters sit at fetch(), so automatic retries and failed HTTP requests count too.
// Prices only aggregate reported usage; an unknown request never becomes zero cost.
export function createC1ValidationGuard(fetcher: typeof fetch = fetch, now = Date.now, requestedLimits: C1ValidationLimits = c1ValidationLimits,
  operationStop: "global" | "per-operation" = "global") {
  const limits = structuredClone(requestedLimits);
  assert.ok(operations.every(operation => Number.isSafeInteger(limits.requests[operation]) && limits.requests[operation] >= 0)
    && operations.some(operation => limits.requests[operation] > 0), "Request limits must be nonnegative safe integers with an enabled operation");
  assert.ok([limits.deadlineMs, limits.turnTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0), "Time limits must be positive safe integers");
  assert.ok([limits.estimatedUsd, limits.estimatedCny].every(value => Number.isFinite(value) && value > 0), "Cost limits must be positive and finite");
  assert.ok(["global", "per-operation"].includes(operationStop), "Invalid operation limit strategy");
  const started = now(), requests: Request[] = [];
  let active: Active | undefined, stopReason: string | null = null, sealed = false;
  const usage = () => Object.fromEntries(operations.map(operation => {
    const rows = requests.filter(row => row.operation === operation), known = rows.filter(row => row.estimatedCost !== null);
    return [operation, { requests: rows.length, unknownCosts: rows.length - known.length,
      knownEstimatedCost: known.reduce((n, row) => n + row.estimatedCost!, 0),
      estimatedCost: rows.length === known.length ? known.reduce((n, row) => n + row.estimatedCost!, 0) : null,
      totalTokens: rows.every(row => row.totalTokens !== null) ? rows.reduce((n, row) => n + row.totalTokens!, 0) : null }];
  })) as Record<Operation, { requests: number; unknownCosts: number; knownEstimatedCost: number; estimatedCost: number | null; totalTokens: number | null }>;
  const stopped = () => {
    if (stopReason) return stopReason;
    const costs = usage();
    if (now() - started >= limits.deadlineMs) stopReason = "run_deadline";
    else if (costs.agent.knownEstimatedCost + costs.support.knownEstimatedCost >= limits.estimatedUsd) stopReason = "usd_soft_stop";
    else if (costs.rerank.knownEstimatedCost >= limits.estimatedCny) stopReason = "cny_soft_stop";
    else if (operationStop === "global" && operations.some(operation => limits.requests[operation] > 0 && costs[operation].requests >= limits.requests[operation])) stopReason = "operation_request_limit";
    return stopReason;
  };
  return { requests, usage, stopped, remainingMs: () => Math.max(0, limits.deadlineMs - (now() - started)),
    setActive(value: Active | undefined) { active = value; }, seal() { sealed = true; active = undefined; },
    record(index: number, tokens: number | null, cost: number | null) {
      if (sealed) return; // A late completion cannot rewrite the saved accounting after teardown.
      const row = requests[index]; assert.ok(row && !row.usageRecorded, "Usage must bind once to an actual HTTP request");
      row.usageRecorded = true;
      row.totalTokens = tokens !== null && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
      row.estimatedCost = row.totalTokens !== null && cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : null;
    },
    fetchFor(operation: Operation): typeof fetch { return async (url, init) => {
      assert.ok(active && !sealed, "No active validation ingress");
      const current = active, signal = AbortSignal.any([current.signal, init?.signal, url instanceof globalThis.Request ? url.signal : undefined]
        .filter((value): value is AbortSignal => Boolean(value)));
      signal.throwIfAborted();
      const reason = stopped(); if (reason) throw new Error(`Validation stopped before HTTP: ${reason}`);
      if (limits.requests[operation] === 0) throw new Error(`Validation stopped before HTTP: operation_disabled:${operation}`);
      if (requests.filter(request => request.operation === operation).length >= limits.requests[operation]) throw new Error(`Validation stopped before HTTP: operation_request_limit:${operation}`);
      const request: Request = { operation, caseId: current.caseId, turn: current.turn, requestId: current.requestId,
        startedAt: new Date(now()).toISOString(), httpStatus: null, error: null, totalTokens: null, estimatedCost: null,
        currency: operation === "rerank" ? "CNY" : "USD", usageRecorded: false };
      requests.push(request);
      try { const response = await fetcher(url, { ...init, signal }); if (!sealed) request.httpStatus = response.status; return response; }
      catch { if (!sealed) request.error = "request_failed"; throw new Error("Measured validation provider request failed"); }
    }; } };
}

export function controlledStore(fixture: C1ValidationSetup["fixtures"][number]) {
  const orders = new Map(fixture.orders.map(value => [value.order.id, structuredClone(value)]));
  let active: { ingress: Active; reads: StoreRead[] } | undefined;
  return { orders, setActive(value: typeof active) { active = value; },
    change(change: NonNullable<C1ValidationTurn["stateChange"]>) {
      const before = orders.get(change.orderId); assert.ok(before); assert.deepEqual(before.order, change.before, "State transition must start from actual store state");
      if (change.after) orders.set(change.orderId, { owner: before.owner, order: structuredClone(change.after) });
      else orders.delete(change.orderId);
      return { applied: true, beforeHash: contentHash(before.order), afterHash: change.after ? contentHash(orders.get(change.orderId)!.order) : null };
    },
    store: { async getOrder(identity: QQIdentity, id: string) {
      assert.ok(active); active.ingress.signal.throwIfAborted();
      const value = orders.get(id), allowed = isDeepStrictEqual(identity, fixture.actor) && Boolean(value && isDeepStrictEqual(value.owner, identity));
      active.reads.push({ requestId: active.ingress.requestId, identity: structuredClone(identity), orderId: id,
        owner: value ? structuredClone(value.owner) : null, allowed, outputHash: allowed ? contentHash(value!.order) : null });
      if (!allowed) throw new OrderAccessError("Controlled validation fixture ownership denied");
      return structuredClone(value!.order);
    }, async searchKnowledge() { throw new Error("Measured knowledge service required"); } } as unknown as CouponStore };
}

export async function c1ValidationCodeFiles() {
  // Freeze all local production modules, including transitive authorization/reply helpers.
  return ["scripts/c1-session-validation-live.ts", "scripts/c1-session-validation-check.ts", "scripts/c1-reference-evidence.ts",
    ...(await readdir(new URL("src/", root))).filter(file => file.endsWith(".ts")).map(file => `src/${file}`),
    "prompts/customer-service-v2.md", "skills/shop-support-v2/SKILL.md"].sort();
}
export async function readC1ValidationDependencies() {
  const names = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "mysql2"];
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const paths = Object.keys(lock.packages).filter(path => names.some(name => path.endsWith(`node_modules/${name}`))).sort();
  const packages = await Promise.all(paths.map(async path => {
    const actual = JSON.parse(await readFile(new URL(`${path}/package.json`, root), "utf8")), locked = lock.packages[path];
    assert.ok(names.includes(actual.name)); assert.equal(actual.version, locked.version, `Installed ${actual.name} differs from lock`);
    const declarations = Object.fromEntries(names.filter(name => actual.dependencies?.[name]).map(name => [name, actual.dependencies[name]]));
    return { path, name: actual.name as string, installedVersion: actual.version as string, lockedVersion: locked.version as string,
      lockIntegrity: (locked.integrity ?? null) as string | null, dependencyDeclarations: declarations as Record<string, string> };
  }));
  for (const name of names) assert.ok(packages.some(value => value.name === name), `Missing installed runtime dependency ${name}`);
  return { version: 1 as const, rootDeclarations: Object.fromEntries(names.map(name => [name, packageJson.dependencies?.[name] ?? null])) as Record<string, string | null>, packages };
}
const bytesFor = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => {
  assert.ok(path && !path.startsWith("/") && !path.split("/").includes("..") && !path.split("/").some(part => part.startsWith(".")), "Only public repository snapshot paths");
  return [path, await readFile(new URL(path, root))] as const;
})));
const hashes = (values: Record<string, Buffer>) => Object.fromEntries(Object.entries(values).map(([path, value]) => [path, contentHash(value)]));

export async function loadC1ValidationExecution(planPath: string, manifestPath: string, setupPath: string) {
  const input = await bytesFor([planPath, manifestPath, setupPath]);
  const manifest = JSON.parse(input[manifestPath]!.toString()) as C1ValidationManifest;
  const setup = JSON.parse(input[setupPath]!.toString()) as C1ValidationSetup;
  assert.equal(setup.version, 1); assert.equal(setup.configuration.architecture, "controller");
  const configuration = setup.configuration, parameters = configuration.parameters;
  assert.equal(configuration.evidenceBindingVersion, "order-evidence-binding-v2", "Freeze the current evidence binding contract explicitly");
  assert.equal(configuration.referenceEvidenceRequired, true, "New Session runs must freeze mandatory reference provenance checks");
  assert.ok(["fixed-validation-not-blind", "exposed-development"].includes(configuration.dataUse), "Declare whether the questions were exposed");
  assert.deepEqual(configuration.dependencySnapshot, await readC1ValidationDependencies(), "Actual runtime dependencies differ from frozen candidate");
  assert.deepEqual(configuration.limits, c1ValidationLimits);
  assert.deepEqual(resolveSupportRunParameters("controller", parameters), parameters, "Freeze resolved parameters, not implicit defaults");
  assert.ok(parameters.knowledgeQueryMode === "combined" || parameters.knowledgeQueryMode === "separated", "Freeze the query mode explicitly for this candidate");
  assert.ok(parameters.knowledgeSupportPrompt === "v5" || parameters.knowledgeSupportPrompt === "v6", "Freeze the support prompt explicitly for this candidate");
  assert.equal(parameters.timeoutMs, c1ValidationLimits.turnTimeoutMs); assert.equal(parameters.knowledgeMode, "m4-support");
  assert.equal(configuration.providerRetries, 0); assert.equal(configuration.sessionAutomaticRetries, 2);
  assert.equal(configuration.rerank.retries, 0); assert.equal(configuration.rerank.timeoutMs, parameters.knowledgeTimeoutMs);
  assert.equal(configuration.support.timeoutMs, parameters.knowledgeTimeoutMs); assert.equal(configuration.support.maxRetries, 0);
  if (parameters.knowledgeSupport === "typed") assert.equal(configuration.support.promptVersion,
    parameters.knowledgeSupportPrompt === "v6" ? evidenceSupportTypedV6PromptVersion : evidenceSupportTypedPromptVersion);
  assert.equal(configuration.model.provider, "deepseek"); assert.equal(configuration.model.api, "openai-completions");
  assert.equal(configuration.pricing.estimated, true); assert.ok(configuration.pricing.asOf);
  const rate = configuration.pricing.rerankCnyPerMillionTokens;
  assert.ok(rate === null || Number.isFinite(rate) && rate >= 0);
  const origin = new URL(configuration.rerank.endpoints.origin);
  assert.equal(rate, origin.hostname === "dashscope.aliyuncs.com" || origin.hostname.endsWith(".cn-beijing.maas.aliyuncs.com") ? .5 : null,
    "Rerank estimate must match the production region pricing contract");
  const required = [...await c1ValidationCodeFiles(), setupPath];
  if (parameters.knowledgeApplicability !== "model_only") required.push(parameters.knowledgeApplicability === "declared-v2" ? "data/knowledge-applicability-v2.json" : "data/knowledge-applicability.json");
  for (const path of required) assert.ok(manifest.sourceHashes[path], `Missing frozen source: ${path}`);
  assert.equal(manifest.dataset.path, planPath);
  const sourceBytes = await bytesFor(Object.keys(manifest.sourceHashes));
  assert.deepEqual(sourceBytes[setupPath], input[setupPath], "Setup changed while reading frozen inputs");
  const plan = verifyC1ValidationManifest({ bytes: input[planPath]!, manifest, sourceBytes, configuration, corpora: setup.corpora });
  assert.equal(new Set(setup.fixtures.map(value => value.caseId)).size, plan.cases.length);
  assert.deepEqual(setup.fixtures.map(value => value.caseId).sort(), plan.cases.map(value => value.id).sort());
  for (const fixture of setup.fixtures) {
    assert.ok(fixture.actor.appId && fixture.actor.senderId && fixture.groupOpenid);
    assert.equal(new Set(fixture.orders.map(value => value.order.id)).size, fixture.orders.length);
    for (const value of fixture.orders) { assert.ok(value.owner.appId && value.owner.senderId); assert.equal(value.order.source, "demo-database"); assert.match(value.order.id, /^COUPON-\d{4}$/); }
    const store = controlledStore(fixture);
    for (const turn of plan.cases.find(value => value.id === fixture.caseId)!.turns) if (turn.stateChange) store.change(turn.stateChange);
    store.orders.clear();
  }
  if (parameters.knowledgeApplicability !== "model_only") assert.deepEqual(setup.applicabilitySnapshot, await loadKnowledgeApplicabilitySnapshot(parameters.knowledgeApplicability === "declared-v2" ? 2 : 1));
  else assert.equal(setup.applicabilitySnapshot, undefined);
  return { plan, setup, manifest, snapshotFiles: [...new Set([...Object.keys(manifest.sourceHashes), planPath, manifestPath, setupPath])],
    before: hashes({ ...sourceBytes, ...input }) };
}

function plannedRows(plan: C1ValidationPlan): Actual[] {
  return plan.cases.flatMap(item => item.turns.map((_turn, index) => ({ caseId: item.id, turn: index + 1, requestId: null,
    execution: "not_run", reason: "not_started", durationMs: null, steps: [], calls: [], requests: [], replyHash: null,
    modelFinalText: null, ingress: null, ingressIntegrityPassed: null, sdkRetryEvents: [], storeReads: [], stateChange: null })));
}
function ingressIntegrity(row: Actual) {
  const ingress = row.ingress;
  return Boolean(ingress && row.requestId === ingress.requestId && (!row.result || row.result.evidence.requestId === ingress.requestId
    && row.result.evidence.trustedRoute.groupOpenid === ingress.groupOpenid && row.result.evidence.trustedRoute.messageId === ingress.messageId)
    && (!row.hostReceipt || row.hostReceipt.requestId === ingress.requestId
      && row.hostReceipt.sourceKey === merchantSourceKey(ingress.identity, ingress.groupOpenid)
      && row.hostReceipt.trustedRoute.groupOpenid === ingress.groupOpenid && row.hostReceipt.trustedRoute.messageId === ingress.messageId)
    && row.requests.every(request => request.caseId === row.caseId && request.turn === row.turn)
    && row.storeReads.every(read => read.requestId === ingress.requestId && isDeepStrictEqual(read.identity, ingress.identity)
      && (!read.allowed || isDeepStrictEqual(read.owner, ingress.identity)))
    && row.calls.every(call => call.parentSpanId === ingress.requestId && (call.name !== "get_order" || call.isError
      || row.storeReads.some(read => read.allowed && read.orderId === call.input.orderId && read.outputHash === contentHash(call.output)))));
}
function lastHost(messages: readonly unknown[]): C1ValidationActual["hostReference"] {
  return messages.flatMap(message => {
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; }
  }).at(-1) ?? {};
}
function reviewInputs(plan: C1ValidationPlan, rows: Actual[]) {
  return rows.map(row => { const turn = plan.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!;
    return { caseId: row.caseId, turn: row.turn, execution: row.execution, question: turn.question, supportReply: row.reply ?? null,
      modelFinalText: row.modelFinalText, replyHash: row.replyHash, criteria: turn.expected.answerCriteria,
      review: { caseId: row.caseId, turn: row.turn, reviewer: "codex", forHumanReview: true, humanAcceptance: false,
        status: "unreviewed", replyHash: row.replyHash ?? contentHash(null), criteriaHash: contentHash(turn.expected.answerCriteria), checks: [] } satisfies C1AnswerReview };
  });
}

export async function withinTurnDeadline(work: Promise<unknown>, milliseconds: number, cancel: () => void) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    cancel(); reject(new Error("turn_timeout"));
  }, milliseconds); })]); } finally { clearTimeout(timer); }
}

export async function runC1SessionValidation(planPath: string, manifestPath: string, setupPath: string) {
  const loaded = await loadC1ValidationExecution(planPath, manifestPath, setupPath);
  const { plan, setup, manifest } = loaded, config = setup.configuration, p = config.parameters;
  const runId = randomUUID(), startedAt = new Date().toISOString(), guard = createC1ValidationGuard();
  const rows = plannedRows(plan), cleanup: Array<{ caseId: string; sessionDisposed: boolean; remainingOrders: number }> = [];
  const directory = new URL(".runtime/c1-session-validation/", root); await mkdir(directory, { recursive: true });
  const path = new URL(`${runId}.json`, directory);
  const artifact = { version: 1, runId, startedAt, finishedAt: null as string | null, stage: config.dataUse,
    scope: "Real production Pi Session and providers; isolated synthetic in-memory orders; no SQL, QQ transport or money transfer.",
    manifest, plan, setup, actualSettings: null as null | { model: ModelSnapshot; support: EvidenceSupportSettings; rerank: BailianClient["settings"] },
    rows, requests: guard.requests, cleanup, codeHashes: { before: loaded.before, after: {} as Record<string, string> }, codeStable: false,
    localRuntime: { node: process.version, packageHashes: hashes(await bytesFor(["package.json", "package-lock.json"])),
      packageHashesAfter: {} as Record<string, string>, dependenciesAfter: null as C1ValidationSetup["configuration"]["dependencySnapshot"] | null,
      dependenciesStable: false },
    usage: guard.usage(), stopReason: null as string | null, failure: null as string | null, summary: {} as Record<string, unknown>,
    answerReviewInputs: reviewInputs(plan, rows), reviews: [] as C1AnswerReview[], runIntegrityPassed: false, admitted: false };
  const save = () => writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  const knowledgeConfiguration = { applicability: p.knowledgeApplicability, applicabilitySnapshot: setup.applicabilitySnapshot,
    evidenceBindingVersion: config.evidenceBindingVersion, queryMode: p.knowledgeQueryMode,
    supportPrompt: p.knowledgeSupportPrompt, supportSettings: config.support, referenceEvidenceRequired: config.referenceEvidenceRequired };
  await save();
  let restoreStream: (() => void) | undefined;
  try {
    const { modelRuntime, model } = await createConfiguredModelRuntime();
    const modelSnapshot = { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
      maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost };
    assert.deepEqual(modelSnapshot, config.model, "Actual Agent catalog model must match frozen candidate");
    const selected = resolveEvidenceSupportModel(p.knowledgeSupportModel), supportModel = modelRuntime.getModel(selected.provider, selected.model); assert.ok(supportModel);
    const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (selectedModel, transcript, options) => originalStream(selectedModel, transcript, { ...options, maxRetries: 0, fetch: guard.fetchFor("agent") });
    restoreStream = () => { modelRuntime.streamSimple = originalStream; };
    const rerankBase = createBailianClient({ retries: 0, timeoutMs: p.knowledgeTimeoutMs, fetch: guard.fetchFor("rerank") });
    const supportBase = await createEvidenceSupportClient({ profile: p.knowledgeSupport, modelSelection: p.knowledgeSupportModel,
      ...(p.knowledgeSupport === "typed" ? { typedPromptVersion: p.knowledgeSupportPrompt === "v6" ? evidenceSupportTypedV6PromptVersion : evidenceSupportTypedPromptVersion } : {}),
      timeoutMs: p.knowledgeTimeoutMs, runtime: { model: supportModel,
        complete: (transcript, options) => modelRuntime.complete(supportModel, transcript, { ...options, fetch: guard.fetchFor("support") }) } });
    assert.deepEqual(rerankBase.settings, config.rerank); assert.deepEqual(supportBase.settings, config.support);
    artifact.actualSettings = { model: modelSnapshot, support: supportBase.settings, rerank: rerankBase.settings };
    const recordAttempt = (operation: "rerank" | "support", start: number, attempts: Array<{ totalTokens: number | null; costUsd?: number | null }>) => {
      const indices = guard.requests.map((request, index) => ({ request, index })).filter(value => value.index >= start && value.request.operation === operation);
      // A send can time out without an attempt, or transport can retry internally.
      // Only an exact mapping receives reported usage; all other sends stay unknown.
      if (indices.length !== attempts.length) return;
      attempts.forEach((attempt, index) => guard.record(indices[index]!.index, attempt.totalTokens,
        operation === "support" ? attempt.costUsd ?? null : attempt.totalTokens !== null && config.pricing.rerankCnyPerMillionTokens !== null
          ? attempt.totalTokens * config.pricing.rerankCnyPerMillionTokens / 1_000_000 : null));
    };
    const rerank = { settings: rerankBase.settings, async rerank(...args: Parameters<BailianClient["rerank"]>) {
      const start = guard.requests.length;
      try { const result = await rerankBase.rerank(...args); recordAttempt("rerank", start, result.attempts); return result; }
      catch (error) { if (error instanceof BailianError) recordAttempt("rerank", start, error.attempts); throw error; }
    } };
    const support = { settings: supportBase.settings, async verify(...args: Parameters<typeof supportBase.verify>) {
      const start = guard.requests.length;
      try { const result = await supportBase.verify(...args); recordAttempt("support", start, result.attempts); return result; }
      catch (error) { if (error instanceof EvidenceSupportError) recordAttempt("support", start, error.attempts); throw error; }
    } };
    for (const item of plan.cases) {
      if (guard.stopped()) break;
      const fixture = setup.fixtures.find(value => value.caseId === item.id)!, controlled = controlledStore(fixture);
      let session: Awaited<ReturnType<typeof createSupportSession>> | undefined;
      try {
        const knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(setup.corpora[item.corpus]) },
          { mode: p.knowledgeMode, threshold: p.knowledgeThreshold, timeoutMs: p.knowledgeTimeoutMs, supportProfile: p.knowledgeSupport,
            supportModel: p.knowledgeSupportModel, supportPrompt: p.knowledgeSupportPrompt, queryMode: p.knowledgeQueryMode,
            applicability: p.knowledgeApplicability, applicabilitySnapshot: setup.applicabilitySnapshot, clients: { rerank, support } });
        session = await createSupportSession(fixture.actor, controlled.store, modelRuntime, model, undefined,
          { groupOpenid: fixture.groupOpenid, repairBudget: p.repairBudget, knowledge });
        let priorPassed = true;
        for (const [index, turn] of item.turns.entries()) {
          const row = rows.find(value => value.caseId === item.id && value.turn === index + 1)!;
          if (!priorPassed || guard.stopped()) { row.reason = !priorPassed ? "required_prior_contract_failed" : guard.stopped(); continue; }
          if (turn.stateChange) row.stateChange = controlled.change(turn.stateChange);
          const abort = new AbortController(), requestId = `${runId}:${item.id}:${index + 1}`;
          const active = { caseId: item.id, turn: index + 1, requestId, signal: abort.signal };
          row.ingress = { identity: structuredClone(fixture.actor), groupOpenid: fixture.groupOpenid, messageId: requestId, requestId,
            observedAt: new Date().toISOString() };
          row.requestId = requestId; row.reason = null;
          guard.setActive(active); controlled.setActive({ ingress: active, reads: row.storeReads });
          let collecting = true;
          prepareSupportPrompt(session, { requestId, groupOpenid: fixture.groupOpenid, messageId: requestId,
            onCall: call => { if (collecting) row.calls.push(structuredClone(call)); } });
          const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), messagesBefore = session.messages.length, requestStart = guard.requests.length;
          let agentRecordCursor = requestStart;
          const unsubscribe = session.subscribe(event => {
            if (!collecting) return;
            capture.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") row.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
            if (event.type === "message_end" && event.message.role === "assistant") {
              const sent = guard.requests.map((request, index) => ({ request, index })).filter(value => value.index >= agentRecordCursor
                && value.request.operation === "agent" && value.request.requestId === requestId);
              if (sent.length === 1) { const usage = event.message.usage;
                const priced = Object.values(model.cost).every(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
                guard.record(sent[0]!.index, usage?.totalTokens ?? null, priced ? usage?.cost?.total ?? null : null); }
              agentRecordCursor = guard.requests.length;
            }
          });
          let timedOut = false, failed = false;
          const currentSession = session;
          try { await withinTurnDeadline(session.prompt(turn.question, { expandPromptTemplates: false }),
            Math.min(c1ValidationLimits.turnTimeoutMs, guard.remainingMs()), () => {
              timedOut = true; abort.abort(); cancelSupportTurn(currentSession); void currentSession.abort().catch(() => {});
            }); }
          catch { failed = true; }
          finally { collecting = false; unsubscribe(); abort.abort(); }
          const measured = capture.finish(); row.durationMs = measured.durationMs; row.steps = measured.steps;
          row.requests = structuredClone(guard.requests.slice(requestStart)); row.hostReference = lastHost(session.messages.slice(messagesBefore));
          const result = getSupportResult(session); if (result) row.result = structuredClone(result);
          const hostReceipt = getSupportHostReceipt(session); if (hostReceipt) row.hostReceipt = hostReceipt;
          const finalMessage = session.messages.slice(messagesBefore).findLast(message => message.role === "assistant");
          row.modelFinalText = finalMessage?.role === "assistant" ? finalMessage.content.filter(part => part.type === "text").map(part => part.text).join("") : null;
          row.reply = supportReply(session, row.modelFinalText ?? ""); row.replyHash = row.reply === undefined ? null : contentHash(row.reply);
          row.ingressIntegrityPassed = ingressIntegrity(row);
          row.execution = !failed && !timedOut && !measured.failed && !row.steps.some(step => step.type === "model" && step.isError) ? "completed" : "failed";
          if (!row.ingressIntegrityPassed) row.execution = "failed";
          row.reason = timedOut ? "turn_timeout" : row.execution === "failed" ? guard.stopped() ?? "session_failed" : null;
          const history = item.turns.slice(0, index).map((prior, priorIndex) => ({ question: prior.question,
            actual: rows.find(value => value.caseId === item.id && value.turn === priorIndex + 1)! }));
          const score = scoreC1ValidationTurn(turn, row, setup.corpora[item.corpus], undefined, knowledgeConfiguration, history);
          // Reply review happens later. Only a real, correct prior business result can establish context;
          // valid evidence may survive an invalid sibling without pretending integrity passed.
          priorPassed = score.engineeringPassed && score.knowledgePassed;
          guard.setActive(undefined); controlled.setActive(undefined); await save();
          console.log(`[c1-validation] ${item.id}/${index + 1}: ${row.execution}; engineering=${score.engineeringPassed}; knowledge=${score.knowledgePassed}`);
        }
      } catch { artifact.failure = "case_setup_or_store_contract_failed"; break; }
      finally {
        if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); session.dispose(); }
        controlled.setActive(undefined); controlled.orders.clear(); guard.setActive(undefined);
        cleanup.push({ caseId: item.id, sessionDisposed: Boolean(session), remainingOrders: controlled.orders.size });
      }
    }
  } catch { artifact.failure = "frozen_configuration_or_execution_failed"; }
  finally {
    guard.seal(); restoreStream?.(); artifact.finishedAt = new Date().toISOString(); artifact.stopReason = guard.stopped();
    for (const row of rows) if (row.reason === "not_started") row.reason = artifact.stopReason ?? artifact.failure ?? "not_executed";
    try {
      artifact.codeHashes.after = hashes(await bytesFor(loaded.snapshotFiles)); artifact.codeStable = isDeepStrictEqual(artifact.codeHashes.before, artifact.codeHashes.after);
      artifact.localRuntime.packageHashesAfter = hashes(await bytesFor(["package.json", "package-lock.json"]));
      artifact.localRuntime.dependenciesAfter = await readC1ValidationDependencies();
      artifact.localRuntime.dependenciesStable = isDeepStrictEqual(config.dependencySnapshot, artifact.localRuntime.dependenciesAfter);
    } catch { artifact.failure = "post_run_snapshot_failed"; }
    artifact.usage = guard.usage(); artifact.summary = summarizeC1Validation(plan, rows, setup.corpora, [], knowledgeConfiguration);
    artifact.answerReviewInputs = reviewInputs(plan, rows);
    artifact.runIntegrityPassed = artifact.codeStable && artifact.localRuntime.dependenciesStable && !artifact.failure && !artifact.stopReason && rows.every(row => row.execution !== "not_run")
      && rows.every(row => row.ingressIntegrityPassed === true)
      && cleanup.length === plan.cases.length && cleanup.every(row => row.sessionDisposed && row.remainingOrders === 0)
      && operations.every(operation => artifact.usage[operation].unknownCosts === 0);
    // An execution cannot self-approve natural-language answers. Hash-bound reviews are a separate, offline artifact.
    await save(); console.log(JSON.stringify({ artifact: path.pathname, codeStable: artifact.codeStable, usage: artifact.usage,
      stopReason: artifact.stopReason, runIntegrityPassed: artifact.runIntegrityPassed, finalRepliesReviewed: 0, admitted: false }));
  }
  return path.pathname;
}

export async function checkC1ValidationExecutor() {
  checkC1ValidationScoring();
  const dependencies = await readC1ValidationDependencies();
  assert.equal(Object.hasOwn(dependencies.rootDeclarations, "playwright-core"), false);
  assert.ok(dependencies.packages.every(value => value.name !== "playwright-core"));
  assert.ok(!(await c1ValidationCodeFiles()).some(path => path === "package.json" || path === "package-lock.json"));
  let sent = 0, now = 0;
  const fake: typeof fetch = async () => { sent++; return new Response("{}"); };
  const active = { caseId: "engineering-fixture", turn: 1, requestId: "actual-ingress", signal: new AbortController().signal };
  const guard = createC1ValidationGuard(fake, () => now); guard.setActive(active);
  for (let index = 0; index < 120; index++) await guard.fetchFor("agent")("https://example.invalid");
  await assert.rejects(guard.fetchFor("agent")("https://example.invalid"), /before HTTP/); assert.equal(sent, 120);
  assert.equal(guard.usage().agent.unknownCosts, 120); assert.equal(guard.usage().agent.estimatedCost, null);
  for (const operation of ["rerank", "support"] as const) {
    const own = createC1ValidationGuard(fake, () => 0); own.setActive(active);
    for (let index = 0; index < 60; index++) await own.fetchFor(operation)("https://example.invalid");
    await assert.rejects(own.fetchFor(operation)("https://example.invalid"), /before HTTP/); assert.equal(own.requests.length, 60);
  }
  for (const [operation, cost] of [["support", 1], ["rerank", .15]] as const) {
    const own = createC1ValidationGuard(fake, () => 0); own.setActive(active);
    await own.fetchFor(operation)("https://example.invalid"); own.record(0, 100, cost);
    await assert.rejects(own.fetchFor("agent")("https://example.invalid"), /soft_stop/); assert.equal(own.requests.length, 1);
    assert.throws(() => own.record(0, 1, 0), /once/);
  }
  const deadline = createC1ValidationGuard(fake, () => now); deadline.setActive(active); now += c1ValidationLimits.deadlineMs;
  await assert.rejects(deadline.fetchFor("agent")("https://example.invalid"), /run_deadline/); assert.equal(deadline.requests.length, 0);
  const aborted = createC1ValidationGuard(fake); aborted.setActive({ ...active, signal: AbortSignal.abort() });
  await assert.rejects(aborted.fetchFor("agent")("https://example.invalid")); assert.equal(aborted.requests.length, 0);
  let cancelled = false;
  await assert.rejects(withinTurnDeadline(new Promise(() => {}), 1, () => { cancelled = true; }), /turn_timeout/); assert.equal(cancelled, true);
  const late = createC1ValidationGuard(fake); late.setActive(active); await late.fetchFor("support")("https://example.invalid");
  late.seal(); late.record(0, 42, .5); assert.equal(late.usage().support.unknownCosts, 1);
  const combined = createC1ValidationGuard(fake); combined.setActive(active);
  await combined.fetchFor("agent")("https://example.invalid"); combined.record(0, 1, .6);
  await combined.fetchFor("support")("https://example.invalid"); combined.record(1, 1, .4);
  await assert.rejects(combined.fetchFor("agent")("https://example.invalid"), /usd_soft_stop/);
  const small: C1ValidationLimits = { requests: { agent: 2, rerank: 1, support: 1 }, deadlineMs: 100,
    turnTimeoutMs: 50, estimatedUsd: .02, estimatedCny: .01 };
  const isolatedLimits = structuredClone(small), bounded = createC1ValidationGuard(fake, () => 0, isolatedLimits);
  bounded.setActive(active); isolatedLimits.requests.agent = 999;
  await bounded.fetchFor("agent")("https://example.invalid"); await bounded.fetchFor("agent")("https://example.invalid");
  await assert.rejects(bounded.fetchFor("agent")("https://example.invalid"), /operation_request_limit/);
  assert.equal(bounded.requests.length, 2); assert.equal(bounded.usage().agent.estimatedCost, null);
  const agentOnly = createC1ValidationGuard(fake, () => 0, { ...small, requests: { agent: 2, rerank: 0, support: 0 } });
  agentOnly.setActive(active); const sentBeforeDisabled = sent;
  assert.equal(agentOnly.stopped(), null, "Disabled operations must not stop an enabled experiment");
  for (const operation of ["rerank", "support"] as const) {
    await assert.rejects(agentOnly.fetchFor(operation)("https://example.invalid"), /operation_disabled/);
  }
  assert.equal(sent, sentBeforeDisabled); assert.equal(agentOnly.requests.length, 0);
  await agentOnly.fetchFor("agent")("https://example.invalid"); await agentOnly.fetchFor("agent")("https://example.invalid");
  await assert.rejects(agentOnly.fetchFor("agent")("https://example.invalid"), /operation_request_limit/);
  assert.equal(agentOnly.requests.length, 2);
  for (const [operation, cost, reason] of [["support", .02, "usd_soft_stop"], ["rerank", .01, "cny_soft_stop"]] as const) {
    const own = createC1ValidationGuard(fake, () => 0, small); own.setActive(active);
    await own.fetchFor(operation)("https://example.invalid"); own.record(0, 10, cost);
    await assert.rejects(own.fetchFor("agent")("https://example.invalid"), new RegExp(reason));
  }
  let smallNow = 0;
  const shortDeadline = createC1ValidationGuard(fake, () => smallNow, small); shortDeadline.setActive(active);
  smallNow = 100; assert.equal(shortDeadline.remainingMs(), 0);
  await assert.rejects(shortDeadline.fetchFor("agent")("https://example.invalid"), /run_deadline/);
  assert.equal(shortDeadline.requests.length, 0);
  for (const invalid of [{ ...small, deadlineMs: 0 }, { ...small, turnTimeoutMs: 1.5 }, { ...small, estimatedUsd: NaN },
    { ...small, estimatedCny: Infinity }, { ...small, requests: { ...small.requests, agent: -1 } },
    { ...small, requests: { agent: 0, rerank: 0, support: 0 } }]) {
    assert.throws(() => createC1ValidationGuard(fake, () => 0, invalid), /limits must be/);
  }
  const actor = { appId: "unit-app", senderId: "unit-owner" }, order = { source: "demo-database", id: "COUPON-9999", status: "paid" } as Order;
  const store = controlledStore({ caseId: active.caseId, actor, groupOpenid: "unit-group", orders: [{ owner: actor, order }] }), reads: StoreRead[] = [];
  store.setActive({ ingress: active, reads }); assert.deepEqual(await store.store.getOrder(actor, order.id), order);
  await assert.rejects(store.store.getOrder({ ...actor, senderId: "other" }, order.id), OrderAccessError);
  await assert.rejects(store.store.getOrder({ ...actor, appId: "other-app" }, order.id), OrderAccessError);
  assert.throws(() => store.change({ orderId: order.id, before: { ...order, status: "wrong" }, after: null }));
  store.change({ orderId: order.id, before: order, after: null }); await assert.rejects(store.store.getOrder(actor, order.id), OrderAccessError);
  assert.deepEqual(reads.map(row => row.allowed), [true, false, false, false]); assert.ok(reads.every(row => row.requestId === active.requestId));
  store.orders.clear(); assert.equal(store.orders.size, 0);
  const unitPlan = { cases: [{ id: "unit", turns: [{}, {}] }] } as C1ValidationPlan;
  const rows = plannedRows(unitPlan); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.execution === "not_run" && row.requestId === null));
  const row = rows[0]!; row.requestId = active.requestId; row.ingress = { identity: actor, groupOpenid: "unit-group", messageId: "unit-message", requestId: active.requestId,
    observedAt: new Date().toISOString() };
  row.storeReads = [reads[0]!]; assert.equal(ingressIntegrity(row), true);
  row.storeReads[0] = { ...reads[0]!, owner: { ...actor, senderId: "other" } }; assert.equal(ingressIntegrity(row), false);
  console.log("C1 validation executor engineering checks passed: per-operation HTTP caps, soft costs, unknown usage, deadline/abort, actual actor/ownership/state transition, complete placeholders; no API or final questions.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (!args.length) await checkC1ValidationExecutor();
  else {
    assert.ok(args.length === 4 && args[0] === "--inspect" || args.length === 4 && args[0] === "--live", "Use --inspect|--live PLAN MANIFEST SETUP");
    if (args[0] === "--live") await runC1SessionValidation(args[1]!, args[2]!, args[3]!);
    else { const value = await loadC1ValidationExecution(args[1]!, args[2]!, args[3]!); console.log(JSON.stringify({ counts: value.manifest.counts, frozen: true, providerRequests: 0 })); }
  }
}
