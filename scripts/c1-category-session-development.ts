import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { BailianError, contentHash, createBailianClient } from "../src/bailian.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportTypedV6PromptVersion } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { loadKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import { scopeDocuments, type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { resolveSupportRunParameters } from "../src/support-parameters.ts";
import { scoreC1ValidationTurn, type C1AnswerReview, type C1ValidationActual, type C1ValidationTurn } from "./c1-session-validation-check.ts";
import { c1ValidationCodeFiles, controlledStore, createC1ValidationGuard, readC1ValidationDependencies, withinTurnDeadline, type StoreRead } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url), datasetPath = "data/c1-category-session-development.json";
const directory = new URL(".runtime/c1-category-session-development/", root);
const arms = ["declared", "declared-v2"] as const;
type Arm = typeof arms[number];
type Operation = "agent" | "rerank" | "support";
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Turn = C1ValidationTurn & { evidenceTarget: "current_order" | "rule_only"; scopePurpose: string; inputHash: string };
type Dataset = { version: 1; suiteId: string; stage: "exposed-development-category-session-ab"; syntheticBoundary: string;
  sources: Array<{ path: string; sha256: string; bytes: number }>; corpus: RetrievalDocument[]; corpusHash: string;
  actor: QQIdentity; groupOpenid: string; measurement: { casesPerArm: number; turnsPerArm: number; arms: Arm[]; pairedTurns: number;
    remoteExecutionsPerManifest: number; sqlRequests: number; qqRequests: number };
  cases: Array<{ id: string; scenario: string; orders: Array<{ owner: QQIdentity; order: Order }>; turns: Turn[] }> };
export const categorySessionLimits = { requests: { agent: 48, rerank: 16, support: 16 }, deadlineMs: 6 * 60_000,
  turnTimeoutMs: 75_000, estimatedUsd: .06, estimatedCny: .02 };
const parameters = (arm: Arm) => resolveSupportRunParameters("controller", { timeoutMs: categorySessionLimits.turnTimeoutMs,
  repairBudget: 1, knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro",
  knowledgeSupportPrompt: "v6", knowledgeApplicability: arm, knowledgeQueryMode: "separated", knowledgeThreshold: .5, knowledgeTimeoutMs: 60_000 });
const readHashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));
const inputOf = ({ inputHash: _hash, ...input }: Turn) => input;

async function loadDataset() {
  const data = JSON.parse(await readFile(new URL(datasetPath, root), "utf8")) as Dataset;
  assert.equal(data.version, 1); assert.equal(data.stage, "exposed-development-category-session-ab");
  assert.equal(data.cases.length, 6); assert.equal(new Set(data.cases.map(item => item.id)).size, 6);
  assert.equal(data.cases.reduce((n, item) => n + item.turns.length, 0), 8);
  assert.deepEqual(data.measurement, { ...data.measurement, casesPerArm: 6, turnsPerArm: 8, arms: [...arms], pairedTurns: 16,
    remoteExecutionsPerManifest: 1, sqlRequests: 0, qqRequests: 0 });
  assert.equal(contentHash(data.corpus), data.corpusHash); assert.equal(data.corpus.length, 8);
  assert.deepEqual(data.corpus, JSON.parse(await readFile(new URL("data/acceptance-online.json", root), "utf8")).documents);
  for (const source of data.sources) { const bytes = await readFile(new URL(source.path, root)); assert.equal(contentHash(bytes), source.sha256); assert.equal(bytes.length, source.bytes); }
  for (const item of data.cases) {
    assert.ok(item.orders.length && item.orders.every(value => equal(value.owner, data.actor)));
    for (const [index, turn] of item.turns.entries()) {
      assert.equal(turn.inputHash, contentHash(inputOf(turn))); assert.ok(turn.question.trim() && turn.question.length <= 500);
      assert.equal(turn.expected.gold.length > 0, turn.expected.knowledge === "evidence");
      assert.ok(turn.expected.answerCriteria.length && new Set(turn.expected.answerCriteria.map(row => row.id)).size === turn.expected.answerCriteria.length);
      for (const gold of turn.expected.gold) assert.ok(scopeDocuments(data.corpus, turn.expected.scope).find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote));
      assert.ok(item.orders.some(row => row.order.id === turn.expected.freshOrder?.id));
      if (turn.stateChange) { assert.ok(index > 0); assert.deepEqual(turn.stateChange.before, item.turns[index - 1]!.expected.freshOrder);
        assert.deepEqual(turn.stateChange.after, turn.expected.freshOrder); assert.notEqual(turn.stateChange.before.items[0]!.productId, turn.stateChange.after?.items[0]!.productId); }
    }
  }
  const known = data.cases[0]!.orders[0]!.order, unknown = data.cases[2]!.orders[0]!.order;
  assert.equal(known.items[0]!.productName, unknown.items[0]!.productName); assert.equal(unknown.items[0]!.productId, "product-demo-3");
  assert.equal(data.cases[4]!.turns[1]!.evidenceTarget, "rule_only"); assert.equal(data.cases[5]!.turns[0]!.expected.gold[0]!.sourceId, "KB-PRODUCT-LUNCH");
  return data;
}
async function sourceFiles() {
  return [...new Set([...(await c1ValidationCodeFiles()), "scripts/c1-session-live.ts", "scripts/c1-category-session-development.ts",
    datasetPath, "db/02-seed.sql", "data/knowledge-applicability.json", "data/knowledge-applicability-v2.json", ...(await loadDataset()).sources.map(row => row.path)])].sort();
}
const modelSnapshot = (model: Model<Api>) => ({ provider: model.provider,
  id: model.id, api: model.api, baseUrl: model.baseUrl, maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost });

// Catalog/settings factories are offline. Credentials are neither required nor serialized.
async function configuration() {
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!, judge = runtime.getModel("deepseek", "deepseek-v4-pro")!;
  assert.ok(model && judge);
  const support = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 60_000,
    runtime: { model: judge, complete: async () => { throw new Error("Metadata only"); } } });
  const rerank = createBailianClient({ retries: 0, timeoutMs: 60_000, env: { DASHSCOPE_API_KEY: "metadata-only-not-a-credential",
    DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com" } });
  const snapshots = { declared: await loadKnowledgeApplicabilitySnapshot(1), "declared-v2": await loadKnowledgeApplicabilitySnapshot(2) };
  assert.equal(snapshots.declared.version, 1); assert.equal(snapshots["declared-v2"].version, 2);
  assert.deepEqual({ ...parameters("declared"), knowledgeApplicability: null }, { ...parameters("declared-v2"), knowledgeApplicability: null });
  return { architecture: "controller" as const, arms: arms.map(arm => ({ arm, parameters: parameters(arm), applicabilitySnapshot: snapshots[arm] })),
    model: modelSnapshot(model), support: support.settings, rerank: rerank.settings, limits: categorySessionLimits,
    providerRetries: 0, sessionAutomaticRetries: 2, operationStop: "per-operation" as const, evidenceBindingVersion: "order-evidence-binding-v2" as const, referenceEvidenceRequired: true,
    dependencySnapshot: await readC1ValidationDependencies(), pricing: { estimated: true, asOf: "2026-10-06",
      source: "Pi catalog and Bailian Beijing token estimate, not an invoice", rerankCnyPerMillionTokens:
      /(?:^|\.)dashscope\.aliyuncs\.com$|\.cn-beijing\.maas\.aliyuncs\.com$/.test(new URL(rerank.settings.endpoints.origin).hostname) ? .5 : null } };
}
type Configuration = Awaited<ReturnType<typeof configuration>>;
type Manifest = { version: 1; stage: Dataset["stage"]; frozenAt: string; frozenBeforeExecution: true; remoteExecutions: 1;
  dataset: { path: string; sha256: string }; counts: { casesPerArm: 6; turnsPerArm: 8; pairedTurns: 16 };
  sourceHashes: Record<string, string>; configuration: Configuration; configurationHash: string };
export async function freezeCategorySession(path: string) {
  await loadDataset(); const config = await configuration(), sourceHashes = await readHashes(await sourceFiles());
  const manifest: Manifest = { version: 1, stage: "exposed-development-category-session-ab", frozenAt: new Date().toISOString(),
    frozenBeforeExecution: true, remoteExecutions: 1, dataset: { path: datasetPath, sha256: sourceHashes[datasetPath]! },
    counts: { casesPerArm: 6, turnsPerArm: 8, pairedTurns: 16 }, sourceHashes, configuration: config, configurationHash: contentHash(config) };
  await mkdir(directory, { recursive: true }); await writeFile(new URL(path, root), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ manifest: path, counts: manifest.counts, limits: config.limits, providerRequests: 0 }));
}
export async function inspectCategorySession(path: string) {
  const bytes = await readFile(new URL(path, root)), manifest = JSON.parse(bytes.toString()) as Manifest, data = await loadDataset();
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, data.stage); assert.equal(manifest.frozenBeforeExecution, true); assert.equal(manifest.remoteExecutions, 1);
  assert.deepEqual(manifest.counts, { casesPerArm: 6, turnsPerArm: 8, pairedTurns: 16 });
  assert.deepEqual(manifest.dataset, { path: datasetPath, sha256: contentHash(await readFile(new URL(datasetPath, root))) });
  assert.equal(manifest.configurationHash, contentHash(manifest.configuration)); assert.deepEqual(manifest.configuration, await configuration());
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), await sourceFiles()); assert.deepEqual(manifest.sourceHashes, await readHashes(await sourceFiles()));
  return { manifest, data, manifestHash: contentHash(bytes) };
}
type Score = ReturnType<typeof scoreC1ValidationTurn>;
type Row = C1ValidationActual & { arm: Arm; question: string; inputHash: string; reason: string | null; score: Score | null;
  replyHash: string | null; modelFinalText: string | null; ingressIntegrityPassed: boolean | null; storeReads: StoreRead[];
  sdkRetryEvents: Array<{ type: string; attempt: number }>; stateChange: { applied: boolean; beforeHash: string; afterHash: string | null } | null };
const plannedRows = (data: Dataset): Row[] => data.cases.flatMap(item => arms.flatMap(arm => item.turns.map((turn, index) => ({
  caseId: item.id, arm, turn: index + 1, question: turn.question, inputHash: turn.inputHash, requestId: null, execution: "not_run" as const,
  reason: "not_started", score: null, replyHash: null, modelFinalText: null, ingressIntegrityPassed: null, ingress: null, durationMs: null,
  calls: [], steps: [], requests: [], storeReads: [], sdkRetryEvents: [], stateChange: null }))));
const proofConfiguration = (config: Configuration, arm: Arm) => ({ applicability: arm,
  applicabilitySnapshot: config.arms.find(item => item.arm === arm)!.applicabilitySnapshot, evidenceBindingVersion: config.evidenceBindingVersion,
  referenceEvidenceRequired: config.referenceEvidenceRequired, queryMode: "separated" as const, supportPrompt: "v6" as const, supportSettings: config.support });
function lastHost(messages: readonly unknown[]): C1ValidationActual["hostReference"] {
  return messages.flatMap(message => { if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; } }).at(-1) ?? {};
}
function ingressIntegrity(row: Row, data: Dataset) {
  return Boolean(row.ingress && row.requestId === row.ingress.requestId && equal(row.ingress.identity, data.actor) && row.ingress.groupOpenid === data.groupOpenid
    && row.calls.every(call => call.parentSpanId === row.requestId && (call.name !== "get_order" || call.isError || row.storeReads.some(read => read.allowed
      && read.requestId === row.requestId && equal(read.identity, data.actor) && equal(read.owner, data.actor) && read.orderId === call.input.orderId && read.outputHash === contentHash(call.output))))
    && row.storeReads.every(read => read.requestId === row.requestId && equal(read.identity, data.actor) && (!read.allowed || equal(read.owner, data.actor))));
}
const reviewInputs = (data: Dataset, rows: Row[]) => rows.map(row => {
  const criteria = data.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!.expected.answerCriteria;
  return { arm: row.arm, caseId: row.caseId, turn: row.turn, question: row.question, actualReply: row.reply ?? null, modelFinalText: row.modelFinalText,
    criteria, review: { caseId: row.caseId, turn: row.turn, reviewer: "codex", forHumanReview: true, humanAcceptance: false, status: "unreviewed",
      replyHash: row.replyHash ?? contentHash(null), criteriaHash: contentHash(criteria), checks: [] } satisfies C1AnswerReview };
});
function summary(rows: Row[]) {
  return { plannedTurns: 16, arms: Object.fromEntries(arms.map(arm => { const items = rows.filter(row => row.arm === arm);
    return [arm, { plannedCases: 6, plannedTurns: 8, completed: items.filter(row => row.execution === "completed").length,
      failed: items.filter(row => row.execution === "failed").length, skipped: items.filter(row => row.execution === "not_run").length,
      engineeringPassed: items.filter(row => row.score?.engineeringPassed).length, knowledgePassed: items.filter(row => row.score?.knowledgePassed).length,
      invalidDecisions: items.flatMap(row => row.score?.invalidDecisionIds ?? []), unknownCategoryIds: items.flatMap(row => row.score?.applicabilityUnknownIds ?? []),
      extraAcceptedIds: items.flatMap(row => row.score?.extraAcceptedIds ?? []), repliesReviewed: 0, fullyPassed: 0 }]; })) };
}

// Permit the final allowed rerank to finish its support/final Agent calls;
// every operation still stops before its own cap+1 HTTP request.
function measuredGuard(fetcher: typeof fetch) {
  const guard = createC1ValidationGuard(fetcher, Date.now, categorySessionLimits, "per-operation"), requestHashes: Array<{ index: number; operation: Operation; requestId: string; hash: string }> = [];
  const fetchFor = (operation: Operation): typeof fetch => async (url, init) => {
    const index = guard.requests.length, hash = contentHash({ endpoint: String(url), method: init?.method ?? "GET", body: init?.body ?? null });
    try { return await guard.fetchFor(operation)(url, init); }
    finally { const sent = guard.requests[index]; if (sent?.operation === operation) requestHashes.push({ index, operation, requestId: sent.requestId, hash }); }
  };
  return { ...guard, fetchFor, requestHashes };
}

async function execute(data: Dataset, config: Configuration, fake = false, save: (value: unknown) => Promise<void> = async () => {}, runId = randomUUID()) {
  const startedAt = new Date().toISOString(), rows = plannedRows(data);
  let active: Row | undefined, responseSteps: Array<{ action: unknown } | { text: string }> = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.ok(fake && active); init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body));
    if (body.documents) return new Response(JSON.stringify({ results: body.documents.map((text: string, index: number) => ({ index,
      relevance_score: JSON.parse(text).title === data.corpus.find(doc => doc.id === (active!.caseId.endsWith("006") ? "KB-PRODUCT-LUNCH" : "KB-SHOP-DEMO-1"))!.title ? .95 : .1 }))
      .sort((left: { relevance_score: number }, right: { relevance_score: number }) => right.relevance_score - left.relevance_score), usage: { total_tokens: 100 } }));
    if (body.model === "deepseek-v4-pro") {
      const input = JSON.parse(body.messages.at(-1).content);
      const text = JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({
        id: doc.id, category: "direct_fact", quote: doc.body, reason: "工程固定接受器，不能证明真实模型语义正确" })) });
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fake-support", object: "chat.completion.chunk", created: 1,
        model: "deepseek-v4-pro", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`;
      return new Response(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(body.thinking.type, "disabled"); const step = responseSteps.shift(); assert.ok(step, "Unexpected Agent HTTP");
    const tool = "action" in step, delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `fake-${randomUUID()}`, type: "function",
      function: { name: "support_action", arguments: JSON.stringify({ action: step.action }) } }] } : { role: "assistant", content: step.text };
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fake-agent", object: "chat.completion.chunk", created: 1,
      model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const guard = measuredGuard(fake ? fakeFetch : fetch), cleanup: Array<{ arm: Arm; caseId: string; disposed: boolean; remainingOrders: number }> = [];
  const artifact = { version: 1, runId, startedAt, finishedAt: null as string | null, stage: data.stage, data, rows, requests: guard.requests,
    requestHashes: guard.requestHashes, limits: config.limits, operationStop: config.operationStop, actualSettings: null as unknown,
    cleanup, usage: guard.usage(), stopReason: null as string | null, failure: null as string | null, summary: summary(rows), answerReviewInputs: reviewInputs(data, rows),
    admitted: false, realProviderRequests: !fake, sqlRequests: 0, qqRequests: 0 };
  await save(artifact);
  let restore: (() => void) | undefined;
  try {
    const modelRuntime = fake ? await createModelRuntime() : (await createConfiguredModelRuntime({ ...process.env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash" })).modelRuntime;
    if (fake) await modelRuntime.setRuntimeApiKey("deepseek", "synthetic-not-a-credential");
    const model = modelRuntime.getModel("deepseek", "deepseek-flash")!, judge = modelRuntime.getModel("deepseek", "deepseek-v4-pro")!;
    assert.deepEqual(modelSnapshot(model), config.model);
    const original = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (model, transcript, options) => original(model, transcript, { ...options, maxRetries: 0, fetch: guard.fetchFor("agent") });
    restore = () => { modelRuntime.streamSimple = original; };
    const rerankBase = createBailianClient({ retries: 0, timeoutMs: 60_000, fetch: guard.fetchFor("rerank"), ...(fake ? { env: {
      DASHSCOPE_API_KEY: "synthetic-not-a-credential", DASHSCOPE_BASE_URL: config.rerank.endpoints.origin } } : {}) });
    const supportBase = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 60_000,
      runtime: { model: judge, complete: (context, options) => modelRuntime.complete(judge, context, { ...options, fetch: guard.fetchFor("support") }) } });
    assert.deepEqual(rerankBase.settings, config.rerank); assert.deepEqual(supportBase.settings, config.support);
    artifact.actualSettings = { model: modelSnapshot(model), rerank: rerankBase.settings, support: supportBase.settings, arms: config.arms };
    const record = (operation: "rerank" | "support", start: number, attempts: Array<{ totalTokens: number | null; costUsd?: number | null }>) => {
      const sent = guard.requests.map((row, index) => ({ row, index })).filter(value => value.index >= start && value.row.operation === operation);
      if (sent.length !== attempts.length) return;
      attempts.forEach((attempt, index) => guard.record(sent[index]!.index, attempt.totalTokens, operation === "support" ? attempt.costUsd ?? null
        : attempt.totalTokens !== null && config.pricing.rerankCnyPerMillionTokens !== null ? attempt.totalTokens * config.pricing.rerankCnyPerMillionTokens / 1_000_000 : null));
    };
    const rerank = { settings: rerankBase.settings, async rerank(...args: Parameters<typeof rerankBase.rerank>) { const start = guard.requests.length;
      try { const result = await rerankBase.rerank(...args); record("rerank", start, result.attempts); return result; }
      catch (error) { if (error instanceof BailianError) record("rerank", start, error.attempts); throw error; } } };
    const support = { settings: supportBase.settings, async verify(...args: Parameters<typeof supportBase.verify>) { const start = guard.requests.length;
      try { const result = await supportBase.verify(...args); record("support", start, result.attempts); return result; }
      catch (error) { if (error instanceof EvidenceSupportError) record("support", start, error.attempts); throw error; } } };
    for (const [caseIndex, item] of data.cases.entries()) for (const arm of caseIndex % 2 ? [...arms].reverse() : arms) {
      if (guard.stopped()) break;
      const controlled = controlledStore({ caseId: item.id, actor: data.actor, groupOpenid: data.groupOpenid, orders: item.orders });
      let session: Awaited<ReturnType<typeof createSupportSession>> | undefined;
      try {
        const p = parameters(arm), knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(data.corpus) }, {
          mode: p.knowledgeMode, threshold: p.knowledgeThreshold, timeoutMs: p.knowledgeTimeoutMs, supportProfile: p.knowledgeSupport,
          supportModel: p.knowledgeSupportModel, supportPrompt: p.knowledgeSupportPrompt, queryMode: p.knowledgeQueryMode, applicability: arm,
          applicabilitySnapshot: config.arms.find(value => value.arm === arm)!.applicabilitySnapshot, clients: { rerank, support } });
        session = await createSupportSession(data.actor, controlled.store, modelRuntime, model, undefined, { groupOpenid: data.groupOpenid, repairBudget: p.repairBudget ?? undefined, knowledge });
        for (const [index, turn] of item.turns.entries()) {
          const row = rows.find(row => row.arm === arm && row.caseId === item.id && row.turn === index + 1)!;
          if (guard.stopped()) { row.reason = guard.stopped(); continue; }
          if (turn.stateChange) row.stateChange = controlled.change(turn.stateChange);
          active = row;
          if (fake) responseSteps = [{ action: { kind: "policy", question: turn.question, questionContext: { kind: "standalone" },
            orderRef: { kind: "explicit", orderId: turn.expected.freshOrder!.id }, evidenceTarget: turn.evidenceTarget === "current_order"
              ? { kind: "current_order" } : { kind: "rule_only", basis: "假设商品属于常规午餐套餐" } } }, { text: "工程固定回答，尚未审阅。" }];
          const abort = new AbortController(), requestId = `${runId}:${arm}:${item.id}:${index + 1}`, ingress = { caseId: item.id, turn: index + 1, requestId, signal: abort.signal };
          row.requestId = requestId; row.reason = null; row.ingress = { identity: data.actor, groupOpenid: data.groupOpenid, messageId: requestId, requestId, observedAt: new Date().toISOString() };
          guard.setActive(ingress); controlled.setActive({ ingress, reads: row.storeReads });
          let collecting = true; prepareSupportPrompt(session, { requestId, groupOpenid: data.groupOpenid, messageId: requestId,
            onCall: call => { if (collecting) row.calls.push(structuredClone(call)); } });
          const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), startMessages = session.messages.length, startRequests = guard.requests.length;
          let cursor = startRequests;
          const unsubscribe = session.subscribe(event => { if (!collecting) return; capture.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") row.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
            if (event.type === "message_end" && event.message.role === "assistant") { const sent = guard.requests.map((request, index) => ({ request, index }))
              .filter(value => value.index >= cursor && value.request.operation === "agent" && value.request.requestId === requestId);
              if (sent.length === 1) guard.record(sent[0]!.index, event.message.usage?.totalTokens ?? null, event.message.usage?.cost?.total ?? null); cursor = guard.requests.length; }
          });
          let failed = false, timedOut = false; const current = session;
          try { await withinTurnDeadline(session.prompt(turn.question, { expandPromptTemplates: false }), Math.min(categorySessionLimits.turnTimeoutMs, guard.remainingMs()), () => {
            timedOut = true; abort.abort(); cancelSupportTurn(current); void current.abort().catch(() => {}); }); }
          catch { failed = true; } finally { collecting = false; unsubscribe(); abort.abort(); }
          const measured = capture.finish(); row.durationMs = measured.durationMs; row.steps = measured.steps; row.requests = structuredClone(guard.requests.slice(startRequests));
          row.hostReference = lastHost(session.messages.slice(startMessages)); const result = getSupportResult(session); if (result) row.result = structuredClone(result);
          const receipt = getSupportHostReceipt(session); if (receipt) row.hostReceipt = receipt;
          const final = session.messages.slice(startMessages).findLast(message => message.role === "assistant");
          row.modelFinalText = final?.role === "assistant" ? final.content.filter(part => part.type === "text").map(part => part.text).join("") : null;
          row.reply = supportReply(session, row.modelFinalText ?? ""); row.replyHash = row.reply === undefined ? null : contentHash(row.reply);
          row.ingressIntegrityPassed = ingressIntegrity(row, data);
          row.execution = !failed && !timedOut && !measured.failed && row.ingressIntegrityPassed && !row.steps.some(step => step.type === "model" && step.isError) ? "completed" : "failed";
          row.reason = timedOut ? "turn_timeout" : row.execution === "failed" ? guard.stopped() ?? "session_failed" : null;
          const history = rows.filter(prior => prior.arm === arm && prior.caseId === item.id && prior.turn < row.turn).map(actual => ({ question: actual.question, actual }));
          row.score = scoreC1ValidationTurn(turn, row, data.corpus, undefined, proofConfiguration(config, arm), history);
          guard.setActive(undefined); controlled.setActive(undefined); await save(artifact);
          if (fake) assert.equal(responseSteps.length, 0);
          // Standalone restatements remain executable after a semantic failure;
          // a timeout/failed Session cannot safely establish the next turn.
          if (row.execution === "failed") { for (const later of rows.filter(value => value.arm === arm && value.caseId === item.id && value.turn > row.turn)) later.reason = "prior_session_execution_failed"; break; }
        }
      } finally { if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); session.dispose(); }
        controlled.setActive(undefined); controlled.orders.clear(); guard.setActive(undefined); cleanup.push({ arm, caseId: item.id, disposed: Boolean(session), remainingOrders: controlled.orders.size }); }
    }
  } catch { artifact.failure = "configuration_or_execution_contract_failed"; }
  finally { guard.seal(); restore?.(); artifact.finishedAt = new Date().toISOString(); artifact.stopReason = rows.every(row => row.execution !== "not_run") ? null : guard.stopped();
    for (const row of rows) if (row.reason === "not_started") row.reason = artifact.stopReason ?? artifact.failure ?? "not_executed";
    artifact.usage = guard.usage(); artifact.summary = summary(rows); artifact.answerReviewInputs = reviewInputs(data, rows); await save(artifact); }
  return artifact;
}

export async function runCategorySession(path: string) {
  const loaded = await inspectCategorySession(path), { manifest, data, manifestHash } = loaded;
  await mkdir(directory, { recursive: true }); const runId = randomUUID(), target = new URL(`${runId}.json`, directory);
  await writeFile(new URL(`${manifestHash}.attempt.json`, directory), JSON.stringify({ runId, manifestHash, startedAt: new Date().toISOString() }), { flag: "wx" });
  const beforePackages = await readHashes(["package.json", "package-lock.json"]);
  const save = (artifact: unknown) => writeFile(target, JSON.stringify({ ...artifact as object, manifest, manifestHash }, null, 2) + "\n");
  const artifact = await execute(data, manifest.configuration, false, save, runId);
  const after = await readHashes(Object.keys(manifest.sourceHashes)), afterPackages = await readHashes(["package.json", "package-lock.json"]);
  const codeStable = equal(manifest.sourceHashes, after), dependenciesStable = equal(manifest.configuration.dependencySnapshot, await readC1ValidationDependencies());
  const executionComplete = artifact.rows.every(row => row.execution !== "not_run"), usageComplete = Object.values(artifact.usage).every(value => value.unknownCosts === 0);
  const requestBindingPassed = artifact.requests.every((request, index) => artifact.rows.some(row => row.requestId === request.requestId && row.caseId === request.caseId && row.turn === request.turn)
    && artifact.requestHashes.filter(value => value.index === index && value.requestId === request.requestId && value.operation === request.operation).length === 1);
  const runIntegrityPassed = codeStable && dependenciesStable && equal(beforePackages, afterPackages) && !artifact.failure && !artifact.stopReason
    && executionComplete && usageComplete && requestBindingPassed && artifact.rows.length === 16 && artifact.rows.every(row => row.ingressIntegrityPassed)
    && artifact.cleanup.length === 12 && artifact.cleanup.every(row => row.disposed && row.remainingOrders === 0);
  await save({ ...artifact, codeHashes: { before: manifest.sourceHashes, after }, codeStable, dependenciesStable,
    localPackageHashes: { before: beforePackages, after: afterPackages }, executionComplete, usageComplete, requestBindingPassed, runIntegrityPassed });
  console.log(JSON.stringify({ artifact: target.pathname, summary: artifact.summary, usage: artifact.usage, codeStable, runIntegrityPassed, admitted: false }));
  return target.pathname;
}

export async function checkCategorySession() {
  const data = await loadDataset(), config = await configuration(), artifact = await execute(data, config, true);
  assert.equal(artifact.failure, null); assert.equal(artifact.stopReason, null); assert.equal(artifact.rows.length, 16);
  assert.ok(artifact.rows.every(row => row.execution === "completed" && row.ingressIntegrityPassed && row.score?.evidenceProofPassed), JSON.stringify(artifact.rows
    .filter(row => row.execution !== "completed" || !row.score?.evidenceProofPassed).map(row => ({ id: row.caseId, arm: row.arm, turn: row.turn,
      execution: row.execution, reason: row.reason, calls: row.calls.map(call => ({ name: call.name, reason: call.knowledge?.trace.reason })), score: row.score }))));
  assert.equal(artifact.usage.rerank.requests, 16, "The last permitted rerank must finish its support/final Agent calls");
  for (const arm of arms) assert.equal(artifact.rows.filter(row => row.arm === arm).length, 8);
  const unknown = artifact.rows.find(row => row.arm === "declared-v2" && row.caseId.endsWith("003"))!;
  assert.ok(unknown.score?.applicabilityUnknownIds.includes("KB-SHOP-DEMO-1")); assert.equal(unknown.requests.filter(row => row.operation === "support").length, 0);
  assert.equal(unknown.score?.knowledgePassed, true);
  const changed = artifact.rows.find(row => row.arm === "declared-v2" && row.caseId.endsWith("004") && row.turn === 2)!;
  assert.equal(changed.result?.evidence.order?.items[0]!.productId, "product-demo-3"); assert.ok(changed.stateChange?.applied);
  for (const arm of arms) for (const suffix of ["005", "006"]) {
    const row = artifact.rows.find(row => row.arm === arm && row.caseId.endsWith(suffix) && row.turn === (suffix === "005" ? 2 : 1))!;
    assert.equal(row.score?.knowledgePassed, true);
    if (suffix === "005") assert.equal(row.result?.evidence.knowledge[0]!.trace.applicability?.gate?.contextHash, null);
  }
  assert.ok(artifact.rows.every(row => row.score?.answerPassed === false), "Fake answers are never automatically reviewed");
  const positive = artifact.rows.find(row => row.arm === "declared-v2" && row.caseId.endsWith("001"))!, invalid = structuredClone(positive);
  invalid.result!.evidence.knowledge[0]!.trace.supportVerification!.value[0]!.quote = "并非来源原文";
  assert.equal(scoreC1ValidationTurn(data.cases[0]!.turns[0]!, invalid, data.corpus, undefined, proofConfiguration(config, "declared-v2")).evidenceProofPassed, false);
  const errored = { ...positive, execution: "failed" as const };
  assert.equal(scoreC1ValidationTurn(data.cases[0]!.turns[0]!, errored, data.corpus, undefined, proofConfiguration(config, "declared-v2")).knowledgePassed, false);
  let sends = 0; const bounded = measuredGuard(async () => { sends++; return new Response("{}"); });
  bounded.setActive({ caseId: "guard", turn: 1, requestId: "guard", signal: new AbortController().signal });
  for (let i = 0; i < 16; i++) await bounded.fetchFor("rerank")("https://example.invalid");
  await bounded.fetchFor("support")("https://example.invalid"); await assert.rejects(bounded.fetchFor("rerank")("https://example.invalid"), /operation_request_limit/);
  assert.equal(sends, 17); assert.equal(bounded.usage().rerank.unknownCosts, 16); assert.equal(bounded.usage().rerank.estimatedCost, null);
  for (const operation of ["agent", "support"] as const) {
    const own = measuredGuard(async () => new Response("{}")); own.setActive({ caseId: "guard", turn: 1, requestId: "guard", signal: new AbortController().signal });
    for (let i = 0; i < categorySessionLimits.requests[operation]; i++) await own.fetchFor(operation)("https://example.invalid");
    await assert.rejects(own.fetchFor(operation)("https://example.invalid"), /operation_request_limit/);
    assert.equal(own.requests.length, categorySessionLimits.requests[operation]);
  }
  const unexecuted = plannedRows(data); unexecuted[0]!.execution = "failed";
  assert.equal(summary(unexecuted).arms.declared.plannedTurns, 8); assert.equal(summary(unexecuted).arms["declared-v2"].skipped, 8);
  console.log("Category Session development checks passed: six new scenarios, paired 16-turn denominator, actual Pi/support_action/owned fresh store/typed fake HTTP, SKU change and unknown gate, legal rule-only positives, exact HTTP caps; 0 remote/SQL/QQ. Fake classifications and replies do not establish semantic success.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") await checkCategorySession();
  else { assert.ok(args.length === 2 && ["--freeze", "--inspect", "--live"].includes(args[0]!), "Use --check or --freeze|--inspect|--live MANIFEST");
    if (args[0] === "--freeze") await freezeCategorySession(args[1]!);
    else if (args[0] === "--inspect") { const result = await inspectCategorySession(args[1]!); console.log(JSON.stringify({ counts: result.manifest.counts, providerRequests: 0 })); }
    else await runCategorySession(args[1]!); }
}
