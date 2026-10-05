import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import { BailianError, contentHash, createBailianClient } from "../src/bailian.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportTypedV6PromptVersion } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { loadKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { currentReferenceChoices } from "../src/support-reference-selection.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { resolveSupportRunParameters } from "../src/support-parameters.ts";
import { scoreC1ReferenceEvidence } from "./c1-reference-evidence.ts";
import { knowledgeProofPassed, type C1AnswerCriterion, type C1AnswerReview, type C1ValidationActual, type C1ValidationHistory } from "./c1-session-validation-check.ts";
import { controlledStore, createC1ValidationGuard, readC1ValidationDependencies, withinTurnDeadline, type StoreRead } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url), datasetPath = "data/c1-reference-selection-development.json";
const artifactDirectory = new URL(".runtime/c1-reference-selection/", root);
export const referenceProbeLimits = { requests: { agent: 60, rerank: 20, support: 20 }, deadlineMs: 10 * 60_000,
  turnTimeoutMs: 60_000, estimatedUsd: .25, estimatedCny: .1 };
const parameters = resolveSupportRunParameters("controller", { timeoutMs: 60_000, repairBudget: 1, knowledgeMode: "m4-support",
  knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro", knowledgeSupportPrompt: "v6", knowledgeApplicability: "declared",
  knowledgeQueryMode: "separated", knowledgeThreshold: .5, knowledgeTimeoutMs: 60_000 });
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Expected = { kind: "business" | "selection"; allowedKinds?: string[]; outcome?: "ready" | "clarification";
  calls: string[]; knowledge: "none" | "evidence"; gold: Array<{ sourceId: string; quote: string }>; orderId: string | null;
  orderRef?: "explicit" | "focus" | "alternative"; questionContext?: "standalone" | "previous"; sourceTurn?: number;
  pending?: "order" | "policy"; presentation?: "order" | "policy"; answerCriteria: C1AnswerCriterion[] };
type Turn = { question?: string; selection?: { kind: "order" | "policy"; presentationTurn: number; sourceTurn: number }; expected: Expected };
type Dataset = { version: 1; suiteId: string; stage: "exposed-development"; scope: string;
  provenance: { baseFiles: Record<string, string>; corpusHashes: Record<"online" | "reference", string> };
  actor: QQIdentity; groupOpenid: string; orders: Array<{ owner: QQIdentity; order: Order }>;
  corpora: Record<"online" | "reference", RetrievalDocument[]>;
  cases: Array<{ id: string; corpus: "online" | "reference"; turns: Turn[] }> };
type Score = { engineeringPassed: boolean; knowledgePassed: boolean; referenceEvidencePassed: boolean; passed: boolean; issues: string[] };
type Row = C1ValidationActual & { question: string | null; expected: Expected; status: "passed" | "failed" | "skipped";
  reason: string | null; score: Score | null; replyHash: string | null; modelFinalText: string | null;
  sdkRetryEvents: Array<{ type: string; attempt: number }>; storeReads: StoreRead[];
  selectionMaterial?: { presentationRequestId: string; sourceRequestId: string; token: string; version: string } };

const readBytes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(new URL(path, root))])));
const hashes = (bytes: Record<string, Buffer>) => Object.fromEntries(Object.entries(bytes).map(([path, value]) => [path, contentHash(value)]));
async function sourceFiles() {
  return ["scripts/c1-reference-selection-live.ts", "scripts/c1-reference-evidence.ts", "scripts/c1-session-validation-live.ts",
    "scripts/c1-session-validation-check.ts", "scripts/c1-session-live.ts", "data/knowledge-applicability.json", datasetPath,
    "prompts/customer-service-v2.md", "skills/shop-support-v2/SKILL.md",
    ...Object.keys((await loadDataset()).provenance.baseFiles),
    ...(await readdir(new URL("src/", root))).filter(name => name.endsWith(".ts")).map(name => `src/${name}`)].sort();
}
async function loadDataset() {
  const data = JSON.parse(await readFile(new URL(datasetPath, root), "utf8")) as Dataset;
  assert.equal(data.version, 1); assert.equal(data.stage, "exposed-development");
  assert.equal(data.cases.length, 4); assert.equal(data.cases.reduce((n, item) => n + item.turns.length, 0), 19);
  assert.equal(new Set(data.cases.map(item => item.id)).size, 4);
  assert.deepEqual(hashes(await readBytes(Object.keys(data.provenance.baseFiles))), data.provenance.baseFiles);
  for (const corpus of ["online", "reference"] as const) assert.equal(contentHash(data.corpora[corpus]), data.provenance.corpusHashes[corpus]);
  for (const item of data.cases) for (const [index, turn] of item.turns.entries()) {
    const e = turn.expected; assert.equal(Boolean(turn.question), !turn.selection); assert.equal(e.kind === "selection", Boolean(turn.selection));
    if (turn.question) assert.ok(turn.question.trim() && turn.question.length <= 500);
    if (turn.selection) assert.ok(turn.selection.sourceTurn >= 1 && turn.selection.sourceTurn < turn.selection.presentationTurn && turn.selection.presentationTurn <= index);
    assert.equal(e.knowledge === "evidence", e.gold.length > 0);
    for (const gold of e.gold) assert.ok(data.corpora[item.corpus].find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote));
    assert.ok(e.answerCriteria.length > 0); assert.equal(new Set(e.answerCriteria.map(value => value.id)).size, e.answerCriteria.length);
    for (const criterion of e.answerCriteria) assert.ok(criterion.statement.trim() && criterion.basis.trim());
    if (e.sourceTurn !== undefined) assert.ok(e.sourceTurn >= 1 && e.sourceTurn <= index);
    if (e.orderId) assert.ok(data.orders.some(value => value.order.id === e.orderId && equal(value.owner, data.actor)));
  }
  return data;
}

// Factories read the installed catalog and endpoint configuration only; they send no requests.
async function configuration() {
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!, judge = runtime.getModel("deepseek", "deepseek-v4-pro")!;
  assert.ok(model && judge);
  const support = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion,
    timeoutMs: parameters.knowledgeTimeoutMs, runtime: { model: judge, complete: async () => { throw new Error("Metadata only"); } } });
  const rerank = createBailianClient({ env: { DASHSCOPE_API_KEY: "metadata-only-not-a-credential", DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL },
    retries: 0, timeoutMs: parameters.knowledgeTimeoutMs });
  return { architecture: "controller" as const, parameters, limits: referenceProbeLimits,
    model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl, maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost },
    support: support.settings, rerank: rerank.settings, providerRetries: 0, sessionAutomaticRetries: 2,
    evidenceBindingVersion: "order-evidence-binding-v2" as const, referenceEvidenceRequired: true,
    dependencySnapshot: await readC1ValidationDependencies(), applicabilitySnapshot: await loadKnowledgeApplicabilitySnapshot(),
    pricing: { estimated: true, asOf: "2026-10-06", source: "Pi model catalog; Bailian region estimate, not an actual invoice",
      rerankCnyPerMillionTokens: /(?:^|\.)dashscope\.aliyuncs\.com$|\.cn-beijing\.maas\.aliyuncs\.com$/.test(new URL(rerank.settings.endpoints.origin).hostname) ? .5 : null } };
}
type Configuration = Awaited<ReturnType<typeof configuration>>;
type Manifest = { version: 1; stage: "exposed-development"; frozenAt: string; dataset: { path: string; hash: string };
  counts: { cases: 4; turns: 19 }; sourceHashes: Record<string, string>; configuration: Configuration; configurationHash: string };
export async function freezeReferenceProbe(path: string) {
  await loadDataset(); const config = await configuration(), sourceHashes = hashes(await readBytes(await sourceFiles()));
  const manifest: Manifest = { version: 1, stage: "exposed-development", frozenAt: new Date().toISOString(),
    dataset: { path: datasetPath, hash: sourceHashes[datasetPath]! }, counts: { cases: 4, turns: 19 },
    sourceHashes, configuration: config, configurationHash: contentHash(config) };
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(new URL(path, root), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ manifest: path, counts: manifest.counts, providerRequests: 0 }));
}
export async function inspectReferenceProbe(path: string) {
  const bytes = await readFile(new URL(path, root)), manifest = JSON.parse(bytes.toString()) as Manifest, data = await loadDataset();
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, "exposed-development"); assert.deepEqual(manifest.counts, { cases: 4, turns: 19 });
  assert.equal(manifest.dataset.path, datasetPath); assert.equal(manifest.dataset.hash, contentHash(await readFile(new URL(datasetPath, root))));
  assert.equal(manifest.configurationHash, contentHash(manifest.configuration)); assert.deepEqual(manifest.configuration, await configuration());
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), await sourceFiles());
  assert.deepEqual(manifest.sourceHashes, hashes(await readBytes(Object.keys(manifest.sourceHashes))));
  return { data, manifest, manifestHash: contentHash(bytes), manifestPath: path };
}

function plannedRows(data: Dataset): Row[] {
  return data.cases.flatMap(item => item.turns.map((turn, index) => ({ caseId: item.id, turn: index + 1, requestId: null,
    execution: "not_run", question: turn.question ?? null, expected: turn.expected, status: "skipped", reason: "not_started", score: null,
    replyHash: null, modelFinalText: null, durationMs: null, calls: [], steps: [], requests: [], sdkRetryEvents: [], storeReads: [] })));
}
function lastHost(messages: readonly unknown[]): C1ValidationActual["hostReference"] {
  return messages.flatMap(message => {
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") return [];
    try { const value = JSON.parse(message.content); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; }
  }).at(-1) ?? {};
}
function selectionCommand(turn: Turn, history: Row[]) {
  const selection = turn.selection!;
  const shown = history.find(row => row.turn === selection.presentationTurn), source = history.find(row => row.turn === selection.sourceTurn);
  assert.ok(shown?.status === "passed" && source?.status === "passed" && shown.requestId && source.requestId && shown.ingress);
  assert.equal(shown.result?.referencePresentation, selection.kind);
  assert.deepEqual(shown.reply, shown.result.reply, "Choose from the actual visible fixed reply, not model/gold metadata");
  const choices = selection.kind === "order" ? shown.result.evidence.orderReferenceChoices : shown.result.evidence.policyChoices;
  const current = currentReferenceChoices(choices, { sourceKey: merchantSourceKey(shown.ingress.identity, shown.ingress.groupOpenid), groupOpenid: shown.ingress.groupOpenid });
  const candidate = current?.candidates.find(row => (row.reference.kind === "order" ? row.reference.requestId : row.reference.topic.requestId) === source.requestId);
  assert.ok(candidate && shown.reply && typeof shown.reply === "object" && "text" in shown.reply && typeof shown.reply.text === "string");
  const command = `选择${selection.kind === "order" ? "订单" : "话题"} ${candidate.token}`;
  assert.ok(shown.reply.text.split("\n").includes(command), "The exact one-line token must have actually appeared to the user");
  return { command, material: { presentationRequestId: shown.requestId, sourceRequestId: source.requestId, token: candidate.token, version: candidate.version } };
}
const knowledgeConfiguration = (config: Configuration) => ({ applicability: config.parameters.knowledgeApplicability,
  applicabilitySnapshot: config.applicabilitySnapshot, evidenceBindingVersion: config.evidenceBindingVersion,
  queryMode: config.parameters.knowledgeQueryMode, supportPrompt: config.parameters.knowledgeSupportPrompt, supportSettings: config.support });
function scoreTurn(row: Row, prior: Row[], data: Dataset, corpus: RetrievalDocument[], config: Configuration): Score {
  const issues: string[] = [], require = (condition: unknown, name: string) => { if (!condition) issues.push(name); };
  const history: C1ValidationHistory = prior.map(actual => ({ question: actual.question!, actual })), e = row.expected, result = row.result;
  require(row.execution === "completed", "execution_failed");
  require(row.requestId && row.ingress?.requestId === row.requestId && equal(row.ingress.identity, data.actor) && row.ingress.groupOpenid === data.groupOpenid, "trusted_ingress");
  require(row.calls.every(call => call.parentSpanId === row.requestId && !call.isError), "fresh_call_binding");
  require(equal(row.calls.map(call => call.name), e.calls), "actual_call_sequence");
  require(row.storeReads.every(read => read.requestId === row.requestId && read.allowed && equal(read.identity, data.actor) && equal(read.owner, data.actor)
    && row.calls.some(call => call.name === "get_order" && call.input.orderId === read.orderId && contentHash(call.output) === read.outputHash)), "actual_owner_and_output");
  if (e.kind === "selection") {
    const receipt = row.hostReceipt;
    require(!result && receipt?.version === "reference-selection-v1" && receipt.outcome === "selected" && !receipt.historyFailed, "host_only_selection");
    require(row.requests.length === 0 && row.steps.length === 0, "zero_model_selection");
    require(receipt?.version === "reference-selection-v1" && receipt.presentationRequestId === row.selectionMaterial?.presentationRequestId
      && receipt.selectedRequestId === row.selectionMaterial?.sourceRequestId, "selection_source");
  } else {
    require(result && e.allowedKinds?.includes(result.action.kind) && result.outcome === e.outcome, "business_action_and_outcome");
    require((result?.evidence.order?.id ?? null) === e.orderId, "expected_order");
    if (e.orderId) require(equal(result?.evidence.order, data.orders.find(value => value.order.id === e.orderId)?.order), "fresh_order_snapshot");
    if (e.orderRef) require(result && "orderRef" in result.action && result.action.orderRef?.kind === e.orderRef, "order_reference_kind");
    if (e.questionContext) require(result && "questionContext" in result.action && result.action.questionContext.kind === e.questionContext, "question_reference_kind");
    if (e.sourceTurn) require(result && "questionContext" in result.action && result.action.questionContext.kind === "previous"
      && result.action.questionContext.requestId === prior.find(value => value.turn === e.sourceTurn)?.requestId, "actual_previous_source");
    require(result?.pendingReferenceKind === e.pending, "pending_preserved_or_resolved");
    require(result?.referencePresentation === e.presentation, "actual_candidate_presentation");
  }
  const engineeringPassed = issues.length === 0;
  const gold = e.gold.map(value => value.sourceId).sort(), accepted = (result?.evidence.rules ?? []).map(rule => rule.sourceId).sort();
  const proof = knowledgeProofPassed(row, corpus, knowledgeConfiguration(config), row.question!, history);
  const complete = (result?.evidence.knowledge ?? []).every(entry => entry.trace.status !== "unavailable"
    && entry.trace.calls.every(call => call.status === "ok") && entry.trace.applicability?.gate?.integrity === true
    && (!entry.trace.supportVerification || entry.trace.supportVerification.validation?.status === "complete"));
  const knowledgePassed = proof && complete && equal(accepted, gold);
  if (!knowledgePassed) issues.push("knowledge_proof_gold_or_integrity");
  const reference = scoreC1ReferenceEvidence(row, row.question!, history, { required: true,
    verifyPolicyTopic: (actual, query, preceding) => knowledgeProofPassed(actual, corpus, knowledgeConfiguration(config), query, preceding) });
  issues.push(...reference.issues);
  return { engineeringPassed, knowledgePassed, referenceEvidencePassed: reference.passed,
    passed: engineeringPassed && knowledgePassed && reference.passed, issues };
}
function reviewInputs(rows: Row[]) {
  return rows.map(row => ({ caseId: row.caseId, turn: row.turn, question: row.question, actualReply: row.reply ?? null,
    criteria: row.expected.answerCriteria, review: { caseId: row.caseId, turn: row.turn, reviewer: "codex", forHumanReview: true, humanAcceptance: false,
      status: "unreviewed", replyHash: row.replyHash ?? contentHash(null), criteriaHash: contentHash(row.expected.answerCriteria), checks: [] } satisfies C1AnswerReview }));
}

export async function runReferenceProbe(path: string) {
  const loaded = await inspectReferenceProbe(path), { data, manifest } = loaded, config = manifest.configuration;
  await mkdir(artifactDirectory, { recursive: true });
  const runId = randomUUID(), startedAt = new Date().toISOString(), target = new URL(`${runId}.json`, artifactDirectory);
  // One explicit execution per manifest; failures remain the recorded outcome.
  await writeFile(new URL(`${loaded.manifestHash}.attempt.json`, artifactDirectory), JSON.stringify({ runId, startedAt, manifestHash: loaded.manifestHash }), { flag: "wx" });
  const guard = createC1ValidationGuard(fetch, Date.now, referenceProbeLimits), rows = plannedRows(data);
  const cleanup: Array<{ caseId: string; sessionDisposed: boolean; remainingOrders: number }> = [];
  const startedCases: string[] = [];
  const artifact = { version: 1, runId, startedAt, finishedAt: null as string | null, stage: data.stage, manifest, manifestHash: loaded.manifestHash,
    data, rows, requests: guard.requests, usage: guard.usage(), startedCases, cleanup, stopReason: null as string | null, failure: null as string | null,
    actualSettings: null as unknown, codeHashes: { before: manifest.sourceHashes, after: {} as Record<string, string> }, codeStable: false,
    dependenciesStable: false, localPackageHashes: hashes(await readBytes(["package.json", "package-lock.json"])),
    localPackageHashesAfter: {} as Record<string, string>, localPackagesStable: false, runIntegrityPassed: false, executionComplete: false, usageComplete: false,
    summary: {} as Record<string, unknown>, answerReviewInputs: reviewInputs(rows), admitted: false };
  const save = () => writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
  await save(); let restore: (() => void) | undefined;
  try {
    const { modelRuntime, model } = await createConfiguredModelRuntime({ ...process.env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash" });
    const modelSnapshot = { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
      maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost };
    assert.deepEqual(modelSnapshot, config.model, "Actual Agent runtime must equal the frozen catalog/configuration");
    const judge = modelRuntime.getModel("deepseek", "deepseek-v4-pro")!; assert.ok(judge);
    const original = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (m, transcript, options) => original(m, transcript, { ...options, maxRetries: 0, fetch: guard.fetchFor("agent") });
    restore = () => { modelRuntime.streamSimple = original; };
    const rerankBase = createBailianClient({ retries: 0, timeoutMs: 60_000, fetch: guard.fetchFor("rerank") });
    const supportBase = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 60_000,
      runtime: { model: judge, complete: (transcript, options) => modelRuntime.complete(judge, transcript, { ...options, fetch: guard.fetchFor("support") }) } });
    assert.deepEqual(rerankBase.settings, config.rerank); assert.deepEqual(supportBase.settings, config.support);
    artifact.actualSettings = { model: modelSnapshot, rerank: rerankBase.settings, support: supportBase.settings };
    const recordAttempts = (operation: "rerank" | "support", start: number, attempts: Array<{ totalTokens: number | null; costUsd?: number | null }>) => {
      const sent = guard.requests.map((request, index) => ({ request, index })).filter(value => value.index >= start && value.request.operation === operation);
      if (sent.length !== attempts.length) return; // Uncertain mappings retain unknown usage instead of invented zeroes.
      attempts.forEach((attempt, index) => guard.record(sent[index]!.index, attempt.totalTokens,
        operation === "support" ? attempt.costUsd ?? null : attempt.totalTokens !== null && config.pricing.rerankCnyPerMillionTokens !== null
          ? attempt.totalTokens * config.pricing.rerankCnyPerMillionTokens / 1_000_000 : null));
    };
    const rerank = { settings: rerankBase.settings, async rerank(...args: Parameters<typeof rerankBase.rerank>) {
      const start = guard.requests.length;
      try { const result = await rerankBase.rerank(...args); recordAttempts("rerank", start, result.attempts); return result; }
      catch (error) { if (error instanceof BailianError) recordAttempts("rerank", start, error.attempts); throw error; }
    } };
    const support = { settings: supportBase.settings, async verify(...args: Parameters<typeof supportBase.verify>) {
      const start = guard.requests.length;
      try { const result = await supportBase.verify(...args); recordAttempts("support", start, result.attempts); return result; }
      catch (error) { if (error instanceof EvidenceSupportError) recordAttempts("support", start, error.attempts); throw error; }
    } };
    for (const item of data.cases) {
      if (guard.stopped()) break;
      startedCases.push(item.id);
      const controlled = controlledStore({ caseId: item.id, actor: data.actor, groupOpenid: data.groupOpenid, orders: data.orders });
      let session: Awaited<ReturnType<typeof createSupportSession>> | undefined;
      try {
        const knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(data.corpora[item.corpus]) }, {
          mode: "m4-support", threshold: .5, timeoutMs: 60_000, supportProfile: "typed", supportModel: "deepseek-v4-pro", supportPrompt: "v6",
          applicability: "declared", applicabilitySnapshot: config.applicabilitySnapshot, queryMode: "separated", clients: { rerank, support } });
        session = await createSupportSession(data.actor, controlled.store, modelRuntime, model, undefined,
          { groupOpenid: data.groupOpenid, repairBudget: parameters.repairBudget!, knowledge });
        let priorPassed = true;
        for (const [index, turn] of item.turns.entries()) {
          const row = rows.find(value => value.caseId === item.id && value.turn === index + 1)!, prior = rows.filter(value => value.caseId === item.id && value.turn < row.turn);
          if (!priorPassed || guard.stopped()) { row.reason = !priorPassed ? "required_prior_failed" : guard.stopped(); continue; }
          try { if (turn.selection) { const selected = selectionCommand(turn, prior); row.question = selected.command; row.selectionMaterial = selected.material; } }
          catch { row.status = "failed"; row.reason = "actual_selection_not_available"; priorPassed = false; await save(); continue; }
          const abort = new AbortController(), requestId = `${runId}:${item.id}:${row.turn}`, observedAt = new Date().toISOString();
          row.requestId = requestId; row.ingress = { identity: data.actor, groupOpenid: data.groupOpenid, messageId: requestId, requestId, observedAt };
          const active = { caseId: item.id, turn: row.turn, requestId, signal: abort.signal };
          guard.setActive(active); controlled.setActive({ ingress: active, reads: row.storeReads });
          let collecting = true, timedOut = false, failed = false;
          prepareSupportPrompt(session, { requestId, groupOpenid: data.groupOpenid, messageId: requestId,
            onCall: call => { if (collecting) row.calls.push(structuredClone(call)); } });
          const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), messageStart = session.messages.length, requestStart = guard.requests.length;
          let cursor = requestStart;
          const unsubscribe = session.subscribe(event => {
            if (!collecting) return; capture.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") row.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
            if (event.type === "message_end" && event.message.role === "assistant") {
              const sent = guard.requests.map((request, index) => ({ request, index })).filter(value => value.index >= cursor
                && value.request.operation === "agent" && value.request.requestId === requestId);
              if (sent.length === 1) guard.record(sent[0]!.index, event.message.usage?.totalTokens ?? null, event.message.usage?.cost?.total ?? null);
              cursor = guard.requests.length;
            }
          });
          const currentSession = session;
          try { await withinTurnDeadline(session.prompt(row.question!, { expandPromptTemplates: false }), Math.min(60_000, guard.remainingMs()), () => {
            timedOut = true; abort.abort(); cancelSupportTurn(currentSession); void currentSession.abort().catch(() => {});
          }); } catch { failed = true; }
          finally { collecting = false; unsubscribe(); abort.abort(); }
          const captured = capture.finish(); row.durationMs = Date.now() - Date.parse(observedAt); row.steps = captured.steps;
          row.requests = structuredClone(guard.requests.slice(requestStart)); row.hostReference = lastHost(session.messages.slice(messageStart));
          const result = getSupportResult(session); if (result) row.result = structuredClone(result);
          const receipt = getSupportHostReceipt(session); if (receipt) row.hostReceipt = receipt;
          const last = session.messages.slice(messageStart).findLast(message => message.role === "assistant");
          row.modelFinalText = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("") : null;
          row.reply = supportReply(session, row.modelFinalText ?? ""); row.replyHash = row.reply === undefined ? null : contentHash(row.reply);
          row.execution = failed || timedOut || captured.failed || row.steps.some(step => step.type === "model" && step.isError) ? "failed" : "completed";
          row.score = scoreTurn(row, prior, data, data.corpora[item.corpus], config);
          row.status = row.score.passed ? "passed" : "failed"; row.reason = timedOut ? "turn_timeout" : row.status === "failed" ? "development_contract_failed" : null;
          priorPassed = row.score.passed; guard.setActive(undefined); controlled.setActive(undefined);
          await save(); console.log(`[reference-probe] ${item.id}/${row.turn}: ${row.status}`);
        }
      } catch {
        artifact.failure = "case_setup_or_execution_error";
        for (const row of rows.filter(value => value.caseId === item.id && value.status === "skipped")) {
          row.reason = "case_setup_or_execution_error";
          if (row.requestId) { row.execution = "failed"; row.status = "failed"; }
        }
      }
      finally {
        if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); session.dispose(); }
        controlled.setActive(undefined); controlled.orders.clear(); guard.setActive(undefined);
        cleanup.push({ caseId: item.id, sessionDisposed: Boolean(session), remainingOrders: controlled.orders.size });
      }
    }
  } catch { artifact.failure = "configuration_or_execution_error"; }
  finally {
    guard.seal(); restore?.(); artifact.finishedAt = new Date().toISOString(); artifact.stopReason = guard.stopped();
    for (const row of rows) if (row.reason === "not_started") row.reason = artifact.stopReason ?? artifact.failure ?? "not_executed";
    try {
      artifact.codeHashes.after = hashes(await readBytes(Object.keys(manifest.sourceHashes)));
      artifact.codeStable = equal(artifact.codeHashes.before, artifact.codeHashes.after)
        && contentHash(await readFile(new URL(path, root))) === loaded.manifestHash;
      artifact.dependenciesStable = equal(config.dependencySnapshot, await readC1ValidationDependencies());
      artifact.localPackageHashesAfter = hashes(await readBytes(["package.json", "package-lock.json"]));
      artifact.localPackagesStable = equal(artifact.localPackageHashes, artifact.localPackageHashesAfter);
    } catch { artifact.failure = "snapshot_recheck_failed"; }
    artifact.usage = guard.usage(); artifact.answerReviewInputs = reviewInputs(rows);
    artifact.executionComplete = rows.every(row => row.execution !== "not_run");
    artifact.usageComplete = Object.values(artifact.usage).every(value => value.unknownCosts === 0);
    const skippedReasons = ["required_prior_failed", "actual_selection_not_available", "run_deadline", "usd_soft_stop", "cny_soft_stop",
      "operation_request_limit", "case_setup_or_execution_error", "configuration_or_execution_error"];
    artifact.runIntegrityPassed = artifact.codeStable && artifact.dependenciesStable && artifact.localPackagesStable
      && Boolean(artifact.actualSettings) && rows.length === 19 && new Set(rows.map(row => `${row.caseId}:${row.turn}`)).size === 19
      && rows.every(row => row.execution === "not_run" ? skippedReasons.includes(row.reason ?? "") && row.requestId === null
        && !row.ingress && !row.calls.length && !row.requests.length && !row.steps.length && !row.result && !row.hostReceipt
        : row.requestId === row.ingress?.requestId && row.status !== "skipped")
      && guard.requests.every(request => rows.some(row => row.requestId === request.requestId && row.caseId === request.caseId && row.turn === request.turn))
      && equal(cleanup.map(value => value.caseId), startedCases) && cleanup.every(value => value.remainingOrders === 0
        && (value.sessionDisposed || rows.filter(row => row.caseId === value.caseId).every(row => row.execution === "not_run")));
    artifact.summary = { plannedCases: 4, plannedTurns: 19, completed: rows.filter(row => row.execution === "completed").length,
      passed: rows.filter(row => row.status === "passed").length, failed: rows.filter(row => row.status === "failed").length,
      skipped: rows.filter(row => row.status === "skipped").length, actualHttp: guard.requests.length, answersReviewed: 0,
      unknownCosts: Object.values(artifact.usage).reduce((n, usage) => n + usage.unknownCosts, 0),
      supportInvalidDecisions: rows.flatMap(row => row.result?.evidence.knowledge ?? []).reduce((n, entry) => n + (entry.trace.supportVerification?.validation?.invalidDecisions.length ?? 0), 0) };
    await save(); console.log(JSON.stringify({ artifact: target.pathname, summary: artifact.summary, codeStable: artifact.codeStable, admitted: false }));
  }
  return target.pathname;
}

export async function checkReferenceProbe() {
  const data = await loadDataset(), rows = plannedRows(data);
  assert.equal(rows.length, 19); rows[0]!.status = "failed"; rows[0]!.execution = "failed";
  assert.equal(rows.filter(row => row.status === "skipped").length, 18, "Failures never remove unexecuted turns from the denominator");
  assert.throws(() => selectionCommand(data.cases[1]!.turns[4]!, rows.filter(row => row.caseId === data.cases[1]!.id)), /assert|expression/i);
  let sends = 0;
  const fake: typeof fetch = async () => { sends++; return new Response("{}"); };
  const guard = createC1ValidationGuard(fake, () => 0, referenceProbeLimits);
  guard.setActive({ caseId: "fake", turn: 1, requestId: "fake-request", signal: new AbortController().signal });
  await guard.fetchFor("support")("https://example.invalid"); assert.equal(guard.usage().support.estimatedCost, null);
  assert.equal(guard.usage().support.unknownCosts, 1); guard.record(0, 100, .25);
  await assert.rejects(guard.fetchFor("agent")("https://example.invalid"), /soft_stop/); assert.equal(sends, 1);
  const bounded = createC1ValidationGuard(fake, () => 0, referenceProbeLimits); bounded.setActive({ caseId: "fake", turn: 1, requestId: "capped", signal: new AbortController().signal });
  for (let i = 0; i < 20; i++) await bounded.fetchFor("rerank")("https://example.invalid");
  await assert.rejects(bounded.fetchFor("rerank")("https://example.invalid")); assert.equal(bounded.requests.length, 20);
  // Installed Pi and production Session with synthetic final HTTP, not a fake action executor.
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!;
  await runtime.setRuntimeApiKey("deepseek", "synthetic-key-not-a-credential");
  const original = runtime.streamSimple.bind(runtime); let responses = 0, activeRow: Row | undefined;
  let responseSteps: Array<{ action: unknown } | { text: string }> = [];
  runtime.streamSimple = (selected, transcript, options) => original(selected, transcript, { ...options, maxRetries: 0, fetch: async (_url, init) => {
    init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body)); assert.equal(body.thinking.type, "disabled"); responses++;
    const step = responseSteps.shift(); assert.ok(step && activeRow, "No unexpected model request, including host-only selection");
    activeRow.requests.push({ operation: "agent", caseId: "fake", turn: activeRow.turn, startedAt: new Date().toISOString(), httpStatus: 200, error: null });
    const first = "action" in step, delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: `test-call-${responses}`, type: "function", function: {
      name: "support_action", arguments: JSON.stringify({ action: step.action }) } }] } : { role: "assistant", content: step.text };
    const chunk = (d: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta: d, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const store = controlledStore({ caseId: "fake", actor: data.actor, groupOpenid: data.groupOpenid, orders: data.orders });
  const session = await createSupportSession(data.actor, store.store, runtime, model, undefined, { groupOpenid: data.groupOpenid });
  try {
    const actual: Row[] = [];
    const run = async (question: string, action?: unknown) => {
      const row: Row = { ...structuredClone(plannedRows(data)[0]!), caseId: "fake", turn: actual.length + 1, requestId: `fake-ingress-${actual.length + 1}`,
        question, status: "passed", execution: "completed", reason: null };
      activeRow = row; responseSteps = action ? [{ action }, { text: "已核对当前订单。" }] : [];
      row.ingress = { identity: data.actor, groupOpenid: data.groupOpenid, messageId: row.requestId!, requestId: row.requestId!, observedAt: new Date().toISOString() };
      store.setActive({ ingress: { caseId: "fake", turn: row.turn, requestId: row.requestId!, signal: new AbortController().signal }, reads: row.storeReads });
      prepareSupportPrompt(session, { requestId: row.requestId!, groupOpenid: data.groupOpenid, messageId: row.requestId!, onCall: call => row.calls.push(call) });
      const capture = captureEvaluationTurn("fake-http"), messageStart = session.messages.length, unsubscribe = session.subscribe(capture.receive);
      try { await session.prompt(question, { expandPromptTemplates: false }); } finally { unsubscribe(); }
      assert.equal(responseSteps.length, 0); row.durationMs = Date.now() - Date.parse(row.ingress.observedAt!);
      row.steps = capture.finish().steps; row.hostReference = lastHost(session.messages.slice(messageStart));
      const result = getSupportResult(session); if (result) row.result = structuredClone(result);
      const receipt = getSupportHostReceipt(session); if (receipt) row.hostReceipt = receipt;
      row.reply = supportReply(session, session.getLastAssistantText() ?? "");
      const proof = scoreC1ReferenceEvidence(row, question, actual.map(actual => ({ actual, question: actual.question! })), { required: true, verifyPolicyTopic: () => false });
      assert.deepEqual(proof, { passed: true, issues: [] }); actual.push(row); return row;
    };
    const orderId = data.orders[0]!.order.id;
    const first = await run(`查询 ${orderId} 的状态`, { kind: "order", orderRef: { kind: "explicit", orderId } });
    assert.equal(first.result?.evidence.order?.id, orderId); assert.equal(first.storeReads.length, 1);
    await run("请列出当前可选订单", { kind: "clarify", field: "order", reason: "ambiguous" });
    const selection: Turn = { selection: { kind: "order", presentationTurn: 2, sourceTurn: 1 }, expected: data.cases[2]!.turns[4]!.expected };
    const chosen = selectionCommand(selection, actual), before = responses;
    const receipt = await run(chosen.command);
    assert.equal(receipt.hostReceipt?.outcome, "selected"); assert.equal(responses, before);
    const recovered = await run("我选中的这笔订单当前状态呢？", { kind: "order", orderRef: { kind: "focus" } });
    assert.equal(recovered.result?.evidence.order?.id, orderId); assert.equal(recovered.storeReads.length, 1);
    const corrupted = structuredClone(actual.slice(0, 2)); corrupted[1]!.reply = { kind: "notice", text: "未向用户展示候选。" };
    assert.throws(() => selectionCommand(selection, corrupted), /actual visible fixed reply/);
    assert.equal(responses, 6, "Selection recovers through the host without an extra model request");
  } finally { session.dispose(); store.orders.clear(); }
  console.log("Reference development probe checks passed: 4/19 fixed denominator, real Pi/fake HTTP, actual candidate extraction/host selection/recovery, controlled ownership, HTTP caps and unknown costs; 0 real API.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === "--check") await checkReferenceProbe();
  else {
    assert.ok(args.length === 2 && ["--freeze", "--inspect", "--live"].includes(args[0]!), "Use --check or --freeze|--inspect|--live MANIFEST");
    if (args[0] === "--freeze") await freezeReferenceProbe(args[1]!);
    else if (args[0] === "--inspect") { const result = await inspectReferenceProbe(args[1]!); console.log(JSON.stringify({ counts: result.manifest.counts, frozen: true, providerRequests: 0 })); }
    else await runReferenceProbe(args[1]!);
  }
}
