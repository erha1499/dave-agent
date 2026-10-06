import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import { BailianError, contentHash, createBailianClient } from "../src/bailian.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportTypedV6PromptVersion } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { loadKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import { scopeDocuments, type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { createSupportQuestionClient } from "../src/support-question-client.ts";
import type { SupportQuestionResolution, SupportQuestionResolver } from "../src/support-question-resolution.ts";
import { currentReferenceChoices, resolveReferenceChoice, type TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportPolicyScopeRepair, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { resolveSupportRunParameters } from "../src/support-parameters.ts";
import { assertC1QuestionEvidence, scoreC1ValidationTurn, type C1AnswerReview, type C1QuestionCall, type C1ValidationActual,
  type C1ValidationKnowledgeConfiguration, type C1ValidationTurn } from "./c1-session-validation-check.ts";
import { c1ValidationCodeFiles, controlledStore, createC1ValidationGuard, readC1ValidationDependencies, withinTurnDeadline, type StoreRead } from "./c1-session-validation-live.ts";
import { measuredPolicyScopeGuard, policyScopeWireBindingPassed } from "./c1-policy-scope-session-development.ts";

const root = new URL("../", import.meta.url), datasetPath = "data/c1-question-session-development.json";
const directory = new URL(".runtime/c1-question-session-development/", root), arms = ["v2", "v3"] as const;
type Arm = typeof arms[number];
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Turn = C1ValidationTurn & { evidenceTarget: "current_order"; requiresPriorVerifiedTopic?: true; requiresPriorClarification?: true;
  scopePurpose: string; inputHash: string };
export const questionSessionLimits = { requests: { agent: 72, rerank: 24, support: 24, question: 12 }, deadlineMs: 10 * 60_000,
  turnTimeoutMs: 75_000, estimatedUsd: .15, estimatedCny: .05 };
type Dataset = { version: 1; suiteId: string; stage: "fresh-fixed-question-session-not-blind"; syntheticBoundary: string;
  sources: Array<{ path: string; sha256: string; bytes: number }>; corpus: RetrievalDocument[]; corpusHash: string;
  actor: QQIdentity; groupOpenid: string; limits: typeof questionSessionLimits;
  measurement: { casesPerArm: number; turnsPerArm: number; arms: Arm[]; pairedTurns: number; remoteExecutionsPerManifest: number; sqlRequests: number; qqRequests: number };
  cases: Array<{ id: string; scenario: string; orders: Array<{ owner: QQIdentity; order: Order }>; turns: Turn[] }> };
const inputOf = ({ inputHash: _hash, ...input }: Turn) => input;
const hashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));
async function loadDataset() {
  const data = JSON.parse(await readFile(new URL(datasetPath, root), "utf8")) as Dataset;
  assert.equal(data.version, 1); assert.equal(data.stage, "fresh-fixed-question-session-not-blind");
  assert.equal(data.cases.length, 6); assert.equal(new Set(data.cases.map(row => row.id)).size, 6);
  assert.deepEqual(data.cases.map(row => row.turns.length), [1, 2, 2, 2, 3, 2]);
  assert.deepEqual(data.limits, questionSessionLimits);
  assert.deepEqual(data.measurement, { ...data.measurement, casesPerArm: 6, turnsPerArm: 12, arms: [...arms], pairedTurns: 24,
    remoteExecutionsPerManifest: 1, sqlRequests: 0, qqRequests: 0 });
  assert.equal(contentHash(data.corpus), data.corpusHash);
  assert.deepEqual(data.corpus, JSON.parse(await readFile(new URL("data/acceptance-online.json", root), "utf8")).documents);
  for (const source of data.sources) { const bytes = await readFile(new URL(source.path, root)); assert.equal(contentHash(bytes), source.sha256); assert.equal(bytes.length, source.bytes); }
  for (const item of data.cases) {
    assert.ok(item.orders.length && item.orders.every(row => equal(row.owner, data.actor)));
    assert.equal(new Set(item.orders.map(row => row.order.id)).size, item.orders.length);
    for (const [index, turn] of item.turns.entries()) {
      assert.equal(contentHash(inputOf(turn)), turn.inputHash); assert.ok(turn.question.trim() && turn.question.length <= 500);
      assert.equal(turn.evidenceTarget, "current_order"); assert.ok(turn.scopePurpose.trim());
      assert.ok(index > 0 || !turn.requiresPriorVerifiedTopic && !turn.requiresPriorClarification);
      assert.ok(!turn.requiresPriorVerifiedTopic || !turn.requiresPriorClarification);
      assert.equal(turn.expected.gold.length > 0, turn.expected.knowledge === "evidence");
      assert.ok(turn.expected.answerCriteria.length && new Set(turn.expected.answerCriteria.map(row => row.id)).size === turn.expected.answerCriteria.length);
      for (const gold of turn.expected.gold) assert.ok(scopeDocuments(data.corpus, turn.expected.scope).find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote));
      assert.ok(item.orders.some(row => row.order.id === turn.expected.freshOrder?.id));
      if (turn.stateChange) { assert.ok(index > 0); assert.deepEqual(turn.stateChange.before, item.turns[index - 1]!.expected.freshOrder);
        assert.deepEqual(turn.stateChange.after, turn.expected.freshOrder); assert.notEqual(turn.stateChange.before.items[0]!.productId, turn.stateChange.after?.items[0]!.productId); }
    }
  }
  return data;
}
const parameters = () => resolveSupportRunParameters("controller", { timeoutMs: questionSessionLimits.turnTimeoutMs, repairBudget: 1,
  agentModel: "deepseek-flash", knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro",
  knowledgeSupportPrompt: "v6", knowledgeApplicability: "declared-v2", knowledgeQueryMode: "separated", knowledgeThreshold: .5, knowledgeTimeoutMs: 60_000 });
const modelSnapshot = (model: Model<Api>) => ({ provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
  maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost });
async function configuration(env: NodeJS.ProcessEnv = process.env) {
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!, judge = runtime.getModel("deepseek", "deepseek-v4-pro")!;
  const metadata = async () => { throw new Error("Offline metadata, no provider request"); };
  const support = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion,
    timeoutMs: 60_000, runtime: { model: judge, complete: metadata } });
  const question = await createSupportQuestionClient({ modelSelection: "deepseek-flash", timeoutMs: 10_000, runtime: { model, complete: metadata } });
  const rerank = createBailianClient({ retries: 0, timeoutMs: 60_000, env: { DASHSCOPE_API_KEY: "synthetic-metadata-only",
    DASHSCOPE_BASE_URL: env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com" } });
  const snapshot = await loadKnowledgeApplicabilitySnapshot(2);
  return { architecture: "controller" as const, arms: arms.map(arm => ({ arm, parameters: parameters(), applicabilitySnapshot: snapshot,
    questionContract: arm, evidenceBindingVersion: arm === "v3" ? "order-evidence-binding-v3" as const : "order-evidence-binding-v2" as const,
    policyScopeRepair: { version: "policy-scope-repair-v1" as const, maxRepairs: 1 as const, repairBudget: 1 as const } })),
    model: modelSnapshot(model), support: support.settings, rerank: rerank.settings, question: question.settings, limits: questionSessionLimits,
    agentSelection: "deepseek-flash" as const, supportSelection: "deepseek-v4-pro" as const, questionSelection: "deepseek-flash" as const,
    providerRetries: 0, sessionAutomaticRetries: 0, operationStop: "per-operation" as const, referenceEvidenceRequired: true,
    dependencySnapshot: await readC1ValidationDependencies(), pricing: { estimated: true, asOf: "2026-10-06",
      source: "Pi catalog and Bailian Beijing token estimate, not an invoice", rerankCnyPerMillionTokens:
        /(?:^|\.)dashscope\.aliyuncs\.com$|\.cn-beijing\.maas\.aliyuncs\.com$/.test(new URL(rerank.settings.endpoints.origin).hostname) ? .5 : null } };
}
type Configuration = Awaited<ReturnType<typeof configuration>>;
async function sourceFiles() {
  return [...new Set([...(await c1ValidationCodeFiles()), "scripts/c1-session-live.ts", "scripts/c1-policy-scope-session-development.ts",
    "scripts/c1-question-session-development.ts", datasetPath, "docs/c1-policy-scope-repair.md", "db/02-seed.sql",
    "data/knowledge-applicability.json", "data/knowledge-applicability-v2.json", ...(await loadDataset()).sources.map(row => row.path)])].sort();
}
type Manifest = { version: 1; stage: Dataset["stage"]; frozenAt: string; frozenBeforeExecution: true; remoteExecutions: 1;
  dataset: { path: string; sha256: string }; counts: { casesPerArm: 6; turnsPerArm: 12; pairedTurns: 24 };
  sourceHashes: Record<string, string>; configuration: Configuration; configurationHash: string };
export async function freezeQuestionSession(path: string) {
  await loadDataset(); const config = await configuration(), sourceHashes = await hashes(await sourceFiles());
  const manifest: Manifest = { version: 1, stage: "fresh-fixed-question-session-not-blind", frozenAt: new Date().toISOString(), frozenBeforeExecution: true,
    remoteExecutions: 1, dataset: { path: datasetPath, sha256: sourceHashes[datasetPath]! }, counts: { casesPerArm: 6, turnsPerArm: 12, pairedTurns: 24 },
    sourceHashes, configuration: config, configurationHash: contentHash(config) };
  await mkdir(directory, { recursive: true }); await writeFile(new URL(path, root), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ manifest: path, counts: manifest.counts, limits: config.limits, providerRequests: 0 }));
}
export async function inspectQuestionSession(path: string) {
  const bytes = await readFile(new URL(path, root)), manifest = JSON.parse(bytes.toString()) as Manifest, data = await loadDataset();
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, data.stage); assert.equal(manifest.frozenBeforeExecution, true); assert.equal(manifest.remoteExecutions, 1);
  assert.deepEqual(manifest.counts, { casesPerArm: 6, turnsPerArm: 12, pairedTurns: 24 });
  assert.deepEqual(manifest.dataset, { path: datasetPath, sha256: contentHash(await readFile(new URL(datasetPath, root))) });
  assert.equal(manifest.configurationHash, contentHash(manifest.configuration)); assert.deepEqual(manifest.configuration, await configuration());
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), await sourceFiles()); assert.deepEqual(manifest.sourceHashes, await hashes(await sourceFiles()));
  return { manifest, data, manifestHash: contentHash(bytes) };
}
type MeasuredRequest = Omit<ReturnType<typeof createC1ValidationGuard>["requests"][number], "operation"> & { operation: "agent" | "support" | "rerank" | "question" };
type Row = Omit<C1ValidationActual, "requests"> & { requests: MeasuredRequest[]; arm: Arm; question: string; inputHash: string; reason: string | null;
  score: ReturnType<typeof scoreC1ValidationTurn> | null; replyHash: string | null; modelFinalText: string | null;
  ingressIntegrityPassed: boolean | null; storeReads: StoreRead[]; sdkRetryEvents: Array<{ type: string; attempt: number }>;
  stateChange: { applied: boolean; beforeHash: string; afterHash: string | null } | null; priorTopicPassed?: boolean; priorClarificationPassed?: boolean;
  priorHostPassed?: boolean; observedRepair?: ReturnType<typeof getSupportPolicyScopeRepair> };
const plannedRows = (data: Dataset): Row[] => data.cases.flatMap(item => arms.flatMap(arm => item.turns.map((turn, index) => ({
  caseId: item.id, arm, turn: index + 1, question: turn.question, inputHash: turn.inputHash, requestId: null, execution: "not_run" as const,
  reason: "not_started", score: null, replyHash: null, modelFinalText: null, ingressIntegrityPassed: null, ingress: null, durationMs: null,
  calls: [], steps: [], requests: [], storeReads: [], sdkRetryEvents: [], stateChange: null, ...(arm === "v3" ? { questionCalls: [] } : {}) }))));
const proofConfiguration = (config: Configuration, arm: Arm): C1ValidationKnowledgeConfiguration => ({ applicability: "declared-v2",
  applicabilitySnapshot: config.arms.find(row => row.arm === arm)!.applicabilitySnapshot,
  evidenceBindingVersion: config.arms.find(row => row.arm === arm)!.evidenceBindingVersion, referenceEvidenceRequired: true,
  queryMode: "separated", supportPrompt: "v6", supportSettings: config.support,
  policyScopeRepair: config.arms.find(row => row.arm === arm)!.policyScopeRepair, ...(arm === "v3" ? { questionSettings: config.question } : {}) });
function lastHost(messages: readonly unknown[]): NonNullable<C1ValidationActual["hostReference"]> & { policyChoices?: TrustedReferenceChoices; pendingReferenceKind?: string } {
  return messages.flatMap(message => { if (!message || typeof message !== "object" || !("content" in message)) return [];
    const texts = typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
      ? message.content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []) : [];
    return texts.flatMap(text => { try { const value = JSON.parse(text); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; } }); }).at(-1) ?? {};
}
function ingressIntegrity(row: Row, data: Dataset) {
  return Boolean(row.ingress && row.requestId === row.ingress.requestId && equal(row.ingress.identity, data.actor) && row.ingress.groupOpenid === data.groupOpenid
    && row.calls.every(call => call.parentSpanId === row.requestId && (call.name !== "get_order" || call.isError || row.storeReads.some(read => read.allowed
      && read.requestId === row.requestId && equal(read.identity, data.actor) && equal(read.owner, data.actor) && read.orderId === call.input.orderId && read.outputHash === contentHash(call.output))))
    && row.storeReads.every(read => read.requestId === row.requestId && equal(read.identity, data.actor) && (!read.allowed || equal(read.owner, data.actor))));
}
function priorTopicValid(row: Row | undefined, data: Dataset) {
  const score = row?.score, topic = row?.result?.verifiedPolicyTopic;
  return Boolean(row?.execution === "completed" && row.ingressIntegrityPassed && score?.engineeringPassed && score.knowledgePassed
    && score.evidenceProofPassed && score.referenceEvidenceProofPassed && score.supportIntegrityPassed && score.applicabilityIntegrityPassed
    && !row.sdkRetryEvents.length && topic && topic.requestId === row.requestId && topic.originalQuery === row.question
    && topic.sourceKey === merchantSourceKey(data.actor, data.groupOpenid) && topic.groupOpenid === data.groupOpenid
    && topic.orderId === row.result!.evidence.order?.id && topic.sources.length && topic.sources.every(source => row.result!.evidence.rules
      .some(rule => rule.sourceId === source.sourceId && rule.version === source.version)));
}
function priorClarificationValid(row: Row | undefined) {
  return Boolean(row?.execution === "completed" && row.ingressIntegrityPassed && row.score?.engineeringPassed && row.score.knowledgePassed
    && row.score.evidenceProofPassed && row.score.referenceEvidenceProofPassed && !row.sdkRetryEvents.length
    && row.result?.outcome === "clarification" && row.result.pendingReferenceKind === "policy"
    && !row.result.verifiedPolicyTopic && !row.calls.some(call => call.name === "search_faq"));
}
const reviewInputs = (data: Dataset, rows: Row[]) => rows.map(row => {
  const criteria = data.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!.expected.answerCriteria;
  return { arm: row.arm, caseId: row.caseId, turn: row.turn, question: row.question, actualReply: row.reply ?? null, modelFinalText: row.modelFinalText, criteria,
    review: { caseId: row.caseId, turn: row.turn, reviewer: "codex", forHumanReview: true, humanAcceptance: false, status: "unreviewed",
      replyHash: row.replyHash ?? contentHash(null), criteriaHash: contentHash(criteria), checks: [] } satisfies C1AnswerReview };
});
export function summarizeQuestionSession(rows: Row[], data: Dataset) {
  const complete = plannedRows(data).map(fallback => rows.find(row => row.arm === fallback.arm && row.caseId === fallback.caseId && row.turn === fallback.turn) ?? fallback);
  const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]! : null;
  return { plannedTurns: 24, arms: Object.fromEntries(arms.map(arm => { const items = complete.filter(row => row.arm === arm), durations = items.flatMap(row => row.durationMs === null ? [] : [row.durationMs]);
    return [arm, { plannedCases: 6, plannedTurns: 12, completed: items.filter(row => row.execution === "completed").length,
      failed: items.filter(row => row.execution === "failed").length, skipped: items.filter(row => row.execution === "not_run").length,
      engineeringPassed: items.filter(row => row.score?.engineeringPassed).length, knowledgePassed: items.filter(row => row.score?.knowledgePassed).length,
      extraAcceptedIds: items.flatMap(row => row.score?.extraAcceptedIds ?? []), repaired: items.filter(row => row.result?.evidence.policyScopeRepair).length,
      unnecessaryClarification: items.filter(row => data.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!.expected.outcome === "ready" && row.result?.outcome === "clarification").length,
      parserInvocations: items.reduce((n, row) => n + (row.questionCalls?.length ?? 0), 0), timing: "whole executed turn including failed turns; unexecuted excluded",
      durationSamples: durations.length, p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95),
      repliesReviewed: 0, fullyPassed: 0 }]; })) };
}

// Reuse the old measured native wire/SDK guard for its three roles. Question
// uses the existing support counter slot, exposed only as a separate question
// ledger; both guards share one stop, USD/CNY allowance and absolute deadline.
function guards(fetcher: typeof fetch, config: Configuration, data: Dataset, beforeAgent: (body: Record<string, unknown>) => void,
  sourceCheck: () => Promise<void>, now = Date.now) {
  const primary = measuredPolicyScopeGuard(fetcher, config, data, beforeAgent, sourceCheck, now, {
    ...config.limits, requests: { agent: config.limits.requests.agent, rerank: config.limits.requests.rerank, support: config.limits.requests.support } });
  const question = createC1ValidationGuard(fetcher, now, { ...config.limits, requests: { agent: 0, rerank: 0, support: config.limits.requests.question } }, "per-operation");
  let reason: string | null = null;
  const stop = (value: string) => reason ??= value;
  const usage = () => ({ ...primary.usage(), question: question.usage().support });
  const stopped = () => {
    const used = usage();
    return reason ?? primary.stopped() ?? question.stopped() ?? (used.agent.knownEstimatedCost + used.support.knownEstimatedCost + used.question.knownEstimatedCost >= config.limits.estimatedUsd
      ? stop("combined_usd_soft_stop") : null);
  };
  const before = async (checkSource = true) => {
    if (stopped()) throw new Error(stopped()!);
    if ([...primary.requests, ...question.requests].some(row => !row.usageRecorded)) throw new Error(stop("unrecorded_or_retry_request"));
    if (checkSource) try { await sourceCheck(); } catch { throw new Error(stop("source_or_dependency_changed")); }
  };
  return { primary, question, usage, stopped, stop, before,
    requests: () => [...primary.requests, ...question.requests.map(row => ({ ...row, operation: "question" as const }))],
    remainingMs: () => Math.min(primary.remainingMs(), question.remainingMs()),
    setActive(value: Parameters<typeof primary.setActive>[0]) { primary.setActive(value); question.setActive(value); },
    seal() { primary.seal(); question.seal(); },
    fetchFor(operation: "agent" | "rerank" | "support"): typeof fetch { return async (url, init) => { await before(false); return primary.fetchFor(operation)(url, init); }; },
    questionFetch: (async (url, init) => { await before(); return question.fetchFor("support")(url, init); }) as typeof fetch };
}

type Step = { action: unknown } | { text: string };
function sse(model: string, delta: object, tool = false, usage = true) {
  const chunk = (part: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "question-session-engineering", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: part, finish_reason }], ...(usage ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}) })}\n\n`;
  return chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n";
}
async function execute(data: Dataset, config: Configuration, fake = false, save: (value: unknown) => Promise<void> = async () => {}, runId = randomUUID(),
  sourceCheck: () => Promise<void> = async () => {}, fault?: "unknown-question" | "invalid-question" | "cancel-question") {
  const rows = plannedRows(data), startedAt = new Date().toISOString();
  let active: Row | undefined, responseSteps: Step[] = [], pending: Omit<C1QuestionCall, "trace" | "observedAt"> | undefined;
  let questionDecision: SupportQuestionResolution["decision"] = "current_complete", cancelledOnce = false;
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.ok(fake && active); init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body));
    const turn = data.cases.find(item => item.id === active!.caseId)!.turns[active.turn - 1]!;
    if (body.documents) return new Response(JSON.stringify({ results: body.documents.map((text: string, index: number) => ({ index,
      relevance_score: turn.expected.gold.some(gold => data.corpus.find(doc => doc.id === gold.sourceId)!.title === JSON.parse(text).title) ? .95 : .1 }))
      .sort((left: { relevance_score: number }, right: { relevance_score: number }) => right.relevance_score - left.relevance_score), usage: { total_tokens: 100 } }));
    if (body.max_tokens === 1024) {
      if (fault === "cancel-question" && !cancelledOnce) { cancelledOnce = true;
        queueMicrotask(() => cancelSupportTurn(currentSession!));
        await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })); }
      const input = JSON.parse(body.messages[1].content), value = { decision: questionDecision, currentQuotes: questionDecision === "needs_clarification" ? [] : [input.originalQuery],
        previousRequestId: questionDecision === "previous_resolved" ? input.previousTopic.requestId : null };
      return new Response(sse(body.model, { role: "assistant", content: fault === "invalid-question" ? "{invalid" : JSON.stringify(value) }, false,
        fault !== "unknown-question"), { headers: { "content-type": "text/event-stream" } });
    }
    if (body.model === config.support.model) {
      const input = JSON.parse(body.messages[1].content), text = JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({
        id: doc.id, category: "direct_fact", quote: doc.body, reason: "固定工程分类，只证明原生接线" })) });
      return new Response(sse(body.model, { role: "assistant", content: text }), { headers: { "content-type": "text/event-stream" } });
    }
    const step = responseSteps.shift(); assert.ok(step, "Unexpected native Agent HTTP");
    const tool = "action" in step, delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `engineering-${randomUUID()}`, type: "function",
      function: { name: "support_action", arguments: JSON.stringify({ action: step.action }) } }] } : { role: "assistant", content: step.text };
    return new Response(sse(body.model, delta, tool), { headers: { "content-type": "text/event-stream" } });
  };
  let currentSession: Awaited<ReturnType<typeof createSupportSession>> | undefined;
  const guard = guards(async (url, init) => {
    if (pending?.wire && String(url) === `${config.question.endpoint.replace(/\/$/, "")}/chat/completions`
      && JSON.parse(String(init?.body)).max_tokens === 1024) {
      const request = guard.question.requests.at(-1); assert.ok(request && request.requestId === active?.requestId);
      pending.wire.startedAt = request.startedAt;
    }
    return (fake ? fakeFetch : fetch)(url, init);
  }, config, data, body => {
    assert.ok(active); const turn = data.cases.find(item => item.id === active!.caseId)!.turns[active.turn - 1]!;
    const prior = rows.find(row => row.arm === active!.arm && row.caseId === active!.caseId && row.turn === active!.turn - 1);
    if (!turn.requiresPriorVerifiedTopic && !turn.requiresPriorClarification) return;
    const host = lastHost(body.messages as unknown[]), binding = { sourceKey: merchantSourceKey(data.actor, data.groupOpenid), groupOpenid: data.groupOpenid };
    if (turn.requiresPriorVerifiedTopic) {
      assert.ok(priorTopicValid(prior, data));
      // Only the first Agent request carries the donor. A safe scope repair
      // or clarification may intentionally remove it before the final reply.
      if (!guard.primary.requests.some(row => row.requestId === active!.requestId && row.operation === "agent")) {
        const choices = currentReferenceChoices(host?.policyChoices as TrustedReferenceChoices | undefined, binding), selected = resolveReferenceChoice(choices, binding);
        assert.ok(choices && choices.candidates.length === 1 && !choices.selectionRequired && !choices.overflow
          && selected?.kind === "policy" && equal(selected.topic, prior!.result!.verifiedPolicyTopic)); active.priorHostPassed = true;
      }
    } else {
      assert.ok(priorClarificationValid(prior));
      if (!guard.primary.requests.some(row => row.requestId === active!.requestId && row.operation === "agent")) {
        assert.equal(host.pendingReferenceKind, "policy"); assert.ok(!host.policyTopic && !host.policyChoices?.candidates.length); active.priorHostPassed = true;
      }
    }
  }, sourceCheck);
  const cleanup: Array<{ arm: Arm; caseId: string; disposed: boolean; remainingOrders: number }> = [];
  const artifact = { version: 1, runId, startedAt, finishedAt: null as string | null, stage: data.stage, data, rows, requests: guard.requests(),
    wires: guard.primary.wires, limits: config.limits, operationStop: config.operationStop, actualSettings: null as unknown,
    cleanup, usage: guard.usage(), stopReason: null as string | null, failure: null as string | null, summary: summarizeQuestionSession(rows, data),
    answerReviewInputs: reviewInputs(data, rows), admitted: false, realProviderRequests: !fake, sqlRequests: 0, qqRequests: 0 };
  const flush = async () => { artifact.requests = guard.requests(); artifact.usage = guard.usage(); await save(artifact); };
  await flush(); let restore: (() => void) | undefined;
  try {
    const env = fake ? { DEEPSEEK_API_KEY: "synthetic-not-a-credential", DASHSCOPE_API_KEY: "synthetic-not-a-credential", DASHSCOPE_BASE_URL: config.rerank.endpoints.origin } : process.env;
    const configured = await createConfiguredModelRuntime(env, config.agentSelection), modelRuntime = configured.modelRuntime, model = configured.model;
    const judge = await createConfiguredModelRuntime(env, config.supportSelection), parser = await createConfiguredModelRuntime(env, config.questionSelection);
    assert.deepEqual(modelSnapshot(model), config.model);
    const original = modelRuntime.streamSimple.bind(modelRuntime);
    modelRuntime.streamSimple = (selected, context, options) => original(selected, context, { ...options, maxRetries: 0, fetch: guard.fetchFor("agent") });
    restore = () => { modelRuntime.streamSimple = original; };
    const rerankBase = createBailianClient({ retries: 0, timeoutMs: 60_000, fetch: guard.fetchFor("rerank"), env });
    const supportBase = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 60_000,
      runtime: { model: judge.model, complete: (context, options) => judge.modelRuntime.complete(judge.model, context, { ...options, fetch: guard.fetchFor("support") }) } });
    const questionClient = await createSupportQuestionClient({ modelSelection: config.questionSelection, timeoutMs: config.question.timeoutMs,
      fetch: async (url, init) => {
        assert.ok(active && pending); const target = pending;
        const wire: NonNullable<C1QuestionCall["wire"]> = { endpoint: String(url), method: "POST", body: String(init?.body), startedAt: new Date().toISOString(), rawResponse: null, status: null };
        assert.equal(init?.method, "POST"); target.wire = wire;
        const response = await guard.questionFetch(url, { ...init, redirect: "error" }); wire.status = response.status;
        wire.rawResponse = await response.clone().text(); assert.ok(wire.rawResponse.length <= 200_000); return response;
      }, runtime: { model: parser.model, complete: async (context, options) => {
        assert.ok(pending); const target = pending, response = await parser.modelRuntime.complete(parser.model, context, options);
        if (pending === target && active && !active.questionCalls?.length) target.response = structuredClone(response); return response;
      } } });
    assert.deepEqual(rerankBase.settings, config.rerank); assert.deepEqual(supportBase.settings, config.support); assert.deepEqual(questionClient.settings, config.question);
    const resolver: SupportQuestionResolver = { settings: questionClient.settings, resolve(input, options) {
      assert.equal(pending, undefined, "Only one parser invocation per fixed Controller input");
      pending = { input: structuredClone(input), wire: null, response: null }; return questionClient.resolve(input, options);
    } };
    artifact.actualSettings = { model: modelSnapshot(model), rerank: rerankBase.settings, support: supportBase.settings, question: questionClient.settings, arms: config.arms };
    const record = (operation: "rerank" | "support", start: number, attempts: Array<{ totalTokens: number | null; costUsd?: number | null }>) => {
      const sent = guard.primary.requests.map((row, index) => ({ row, index })).filter(value => value.index >= start && value.row.operation === operation);
      if (sent.length !== 1 || attempts.length !== 1 || (attempts[0] as { attempt?: number }).attempt !== 1) { guard.stop("provider_retry_or_attempt_mismatch"); return; }
      const attempt = attempts[0]! as typeof attempts[number] & Partial<import("../src/evidence-support.ts").EvidenceSupportAttempt>;
      if (operation === "support" && (attempt.provider !== config.support.provider || attempt.model !== config.support.model)) { guard.stop("support_identity_mismatch"); return; }
      guard.primary.record(sent[0]!.index, attempt.totalTokens, operation === "support" ? attempt.costUsd ?? null
        : attempt.totalTokens !== null && config.pricing.rerankCnyPerMillionTokens !== null ? attempt.totalTokens * config.pricing.rerankCnyPerMillionTokens / 1_000_000 : null,
        operation === "support" ? { input: attempt.inputTokens, output: attempt.outputTokens, cacheRead: attempt.cacheReadTokens, cacheWrite: attempt.cacheWriteTokens } : undefined);
    };
    const rerank = { settings: rerankBase.settings, async rerank(...args: Parameters<typeof rerankBase.rerank>) { const start = guard.primary.requests.length;
      try { const result = await rerankBase.rerank(...args); record("rerank", start, result.attempts); return result; }
      catch (error) { if (error instanceof BailianError) record("rerank", start, error.attempts); throw error; } } };
    const support = { settings: supportBase.settings, async verify(...args: Parameters<typeof supportBase.verify>) { const start = guard.primary.requests.length;
      try { const result = await supportBase.verify(...args); record("support", start, result.attempts); return result; }
      catch (error) { if (error instanceof EvidenceSupportError) record("support", start, error.attempts); throw error; } } };
    for (const [caseIndex, item] of data.cases.entries()) for (const arm of caseIndex % 2 ? [...arms].reverse() : arms) {
      if (guard.stopped()) break;
      const controlled = controlledStore({ caseId: item.id, actor: data.actor, groupOpenid: data.groupOpenid, orders: item.orders });
      try {
        const p = parameters(), knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(data.corpus) }, {
          mode: p.knowledgeMode, threshold: p.knowledgeThreshold, timeoutMs: p.knowledgeTimeoutMs, supportProfile: p.knowledgeSupport,
          supportModel: p.knowledgeSupportModel, supportPrompt: p.knowledgeSupportPrompt, queryMode: p.knowledgeQueryMode, applicability: "declared-v2",
          applicabilitySnapshot: config.arms.find(row => row.arm === arm)!.applicabilitySnapshot, clients: { rerank, support } });
        currentSession = await createSupportSession(data.actor, controlled.store, modelRuntime, model, undefined, { groupOpenid: data.groupOpenid, repairBudget: 1, knowledge,
          questionContract: arm, ...(arm === "v3" ? { questionResolver: resolver } : {}) });
        const session = currentSession; session.setAutoRetryEnabled(false); assert.equal(session.autoRetryEnabled, false);
        for (const [index, turn] of item.turns.entries()) {
          const row = rows.find(row => row.arm === arm && row.caseId === item.id && row.turn === index + 1)!, prior = rows.find(row => row.arm === arm && row.caseId === item.id && row.turn === index);
          if (guard.stopped()) { row.reason = guard.stopped(); continue; }
          if (turn.requiresPriorVerifiedTopic) { row.priorTopicPassed = priorTopicValid(prior, data); if (!row.priorTopicPassed) { row.reason = "prior_verified_topic_not_established"; continue; } }
          if (turn.requiresPriorClarification) { row.priorClarificationPassed = priorClarificationValid(prior); if (!row.priorClarificationPassed) { row.reason = "prior_clarification_not_established"; continue; } }
          if (turn.stateChange) row.stateChange = controlled.change(turn.stateChange);
          active = row; pending = undefined;
          if (fake) {
            const policy = { kind: "policy", question: turn.question, questionContext: { kind: "standalone" },
              orderRef: turn.question.includes(turn.expected.freshOrder!.id) ? { kind: "explicit", orderId: turn.expected.freshOrder!.id } : { kind: "focus" }, evidenceTarget: { kind: "current_order" } };
            const clarify = { kind: "clarify", field: "policy_topic", reason: "ambiguous" };
            questionDecision = turn.expected.outcome === "clarification" ? "needs_clarification"
              : turn.expected.reference === "previous" ? "previous_resolved" : "current_complete";
            responseSteps = turn.stateChange ? [{ action: { ...policy, questionContext: { kind: "previous", requestId: prior!.result!.verifiedPolicyTopic!.requestId } } },
              ...(arm === "v2" || turn.expected.outcome === "ready" ? [{ action: turn.expected.outcome === "ready" ? policy : clarify }] : [])]
              : [{ action: turn.expected.outcome === "clarification" && arm === "v2" ? clarify : turn.expected.reference === "previous"
                ? { ...policy, questionContext: { kind: "previous", requestId: prior!.result!.verifiedPolicyTopic!.requestId } } : policy }];
            responseSteps.push({ text: "固定工程回复未进行语义验收或答案审阅。" });
          }
          const abort = new AbortController(), requestId = `${runId}:${arm}:${item.id}:${index + 1}`, ingress = { caseId: item.id, turn: index + 1, requestId, signal: abort.signal };
          row.requestId = requestId; row.reason = null; row.ingress = { identity: data.actor, groupOpenid: data.groupOpenid, messageId: requestId, requestId, observedAt: new Date().toISOString() };
          guard.setActive(ingress); controlled.setActive({ ingress, reads: row.storeReads });
          let collecting = true;
          prepareSupportPrompt(session, { requestId, groupOpenid: data.groupOpenid, messageId: requestId, onCall: call => { if (collecting) row.calls.push(structuredClone(call)); },
            onQuestionTrace: observation => {
              assert.ok(collecting && pending && arm === "v3" && observation.requestId === requestId); assert.deepEqual(observation.input, pending.input);
              row.questionCalls!.push({ ...structuredClone(pending), trace: structuredClone(observation.trace), observedAt: observation.observedAt });
              const sent = guard.question.requests.map((request, index) => ({ request, index })).filter(value => value.request.requestId === requestId), attempt = observation.trace.attempts[0];
              if (!attempt || observation.trace.attempts.length !== 1 || sent.length !== attempt.httpRequests || attempt.httpRequests !== 1
                || attempt.provider !== config.question.provider || attempt.model !== config.question.model || attempt.attempt !== 1) { guard.stop("question_attempt_or_identity_mismatch"); return; }
              guard.question.record(sent[0]!.index, attempt.totalTokens, attempt.costUsd);
              if (attempt.totalTokens === null || attempt.costUsd === null) guard.stop("unknown_question_usage");
            } });
          const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), startMessages = session.messages.length;
          let cursor = guard.primary.requests.length;
          const unsubscribe = session.subscribe(event => {
            if (!collecting) return; capture.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") { row.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
              guard.stop("sdk_auto_retry_forbidden"); abort.abort(); cancelSupportTurn(session); void session.abort().catch(() => {}); }
            if (event.type === "message_end" && event.message.role === "assistant") {
              if (event.message.content.some(part => part.type === "thinking")) { guard.stop("unexpected_thinking_content"); abort.abort(); cancelSupportTurn(session); void session.abort().catch(() => {}); }
              const sent = guard.primary.requests.map((request, index) => ({ request, index })).filter(value => value.index >= cursor && value.request.operation === "agent" && value.request.requestId === requestId);
              if (sent.length === 1 && event.message.provider === config.model.provider && event.message.model === config.model.id) {
                const usage = event.message.usage; guard.primary.record(sent[0]!.index, usage?.totalTokens ?? null, usage?.cost?.total ?? null,
                  usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : undefined);
              } else guard.stop("agent_attempt_or_identity_mismatch"); cursor = guard.primary.requests.length;
            }
          });
          let failed = false, timedOut = false;
          try { await withinTurnDeadline(session.prompt(turn.question, { expandPromptTemplates: false }), Math.min(config.limits.turnTimeoutMs, guard.remainingMs()), () => {
            timedOut = true; abort.abort(); cancelSupportTurn(session); void session.abort().catch(() => {}); }); }
          catch { failed = true; } finally { collecting = false; unsubscribe(); abort.abort(); }
          const measured = capture.finish(); row.durationMs = Math.max(0, Date.now() - Date.parse(row.ingress!.observedAt!)); row.steps = measured.steps;
          row.requests = structuredClone(guard.requests().filter(request => request.requestId === requestId));
          row.hostReference = lastHost(session.messages.slice(startMessages)); const result = getSupportResult(session); if (result) row.result = structuredClone(result);
          row.observedRepair = getSupportPolicyScopeRepair(session); const receipt = getSupportHostReceipt(session); if (receipt) row.hostReceipt = receipt;
          const final = session.messages.slice(startMessages).findLast(message => message.role === "assistant");
          row.modelFinalText = final?.role === "assistant" ? final.content.filter(part => part.type === "text").map(part => part.text).join("") : null;
          row.reply = supportReply(session, row.modelFinalText ?? ""); row.replyHash = row.reply === undefined ? null : contentHash(row.reply);
          row.ingressIntegrityPassed = ingressIntegrity(row, data); if (!row.ingressIntegrityPassed) guard.stop("ingress_identity_or_ownership_binding_failed");
          row.execution = !failed && !timedOut && !measured.failed && row.ingressIntegrityPassed && !row.steps.some(step => step.type === "model" && step.isError) ? "completed" : "failed";
          row.reason = timedOut ? "turn_timeout" : row.execution === "failed" ? guard.stopped() ?? "session_failed" : null;
          const history = rows.filter(prior => prior.arm === arm && prior.caseId === item.id && prior.turn < row.turn).map(actual => ({ question: actual.question, actual }));
          row.score = scoreC1ValidationTurn(turn, row, data.corpus, undefined, proofConfiguration(config, arm), history);
          if (arm === "v3") try { assertC1QuestionEvidence(row, row.question, history, data.corpus, proofConfiguration(config, arm)); }
          catch (error) { guard.stop("question_native_evidence_binding_failed"); if (fake && !fault) throw new Error(`${row.caseId}/${arm}/${row.turn}: parser evidence`, { cause: error }); }
          guard.setActive(undefined); controlled.setActive(undefined); await flush();
          if (fake && !fault) assert.equal(responseSteps.length, 0, `${row.caseId}/${arm}/${row.turn}`);
          if (row.execution === "failed") { for (const later of rows.filter(value => value.arm === arm && value.caseId === item.id && value.turn > row.turn)) later.reason = "prior_session_execution_failed"; break; }
        }
      } finally { if (currentSession) { cancelSupportTurn(currentSession); void currentSession.abort().catch(() => {}); currentSession.dispose(); }
        controlled.setActive(undefined); controlled.orders.clear(); guard.setActive(undefined); cleanup.push({ arm, caseId: item.id, disposed: Boolean(currentSession), remainingOrders: controlled.orders.size }); currentSession = undefined; }
    }
  } catch (error) { artifact.failure = "configuration_or_execution_contract_failed"; if (fake) throw error; }
  finally { guard.seal(); restore?.(); active = undefined; pending = undefined; artifact.finishedAt = new Date().toISOString(); artifact.stopReason = guard.stopped();
    for (const row of rows) if (row.reason === "not_started") row.reason = artifact.stopReason ?? artifact.failure ?? "not_executed";
    artifact.summary = summarizeQuestionSession(rows, data); artifact.answerReviewInputs = reviewInputs(data, rows); await flush(); }
  return artifact;
}

function primaryBinding(artifact: Awaited<ReturnType<typeof execute>>, config: Configuration) {
  if (!artifact.actualSettings || typeof artifact.actualSettings !== "object") return false;
  const { question: _question, ...actualSettings } = artifact.actualSettings as Record<string, unknown>;
  return policyScopeWireBindingPassed({ ...artifact, requests: artifact.requests.filter(row => row.operation !== "question"),
    rows: artifact.rows.map(row => ({ ...row, requests: row.requests.filter(request => request.operation !== "question") })), actualSettings }, config);
}
function questionBinding(artifact: Awaited<ReturnType<typeof execute>>, config: Configuration) {
  try {
    const settings = artifact.actualSettings as { question?: unknown }; assert.deepEqual(settings.question, config.question);
    const expected = artifact.rows.flatMap(row => row.requests.filter(request => request.operation === "question"));
    assert.deepEqual(expected, artifact.requests.filter(request => request.operation === "question"));
    for (const row of artifact.rows) {
      if (row.arm === "v2") { assert.equal(row.questionCalls, undefined); assert.ok(!row.requests.some(request => request.operation === "question")); continue; }
      if (row.execution === "not_run") { assert.equal(row.questionCalls?.length, 0); continue; }
      const history = artifact.rows.filter(prior => prior.arm === row.arm && prior.caseId === row.caseId && prior.turn < row.turn).map(actual => ({ question: actual.question, actual }));
      assertC1QuestionEvidence(row, row.question, history, artifact.data.corpus, proofConfiguration(config, row.arm));
      const requests = row.requests.filter(request => request.operation === "question"), call = row.questionCalls?.[0];
      for (const request of requests) { const attempt = call!.trace.attempts[0]!;
        assert.equal(request.totalTokens, attempt.totalTokens); assert.equal(request.estimatedCost, attempt.costUsd); assert.equal(request.currency, "USD"); assert.equal(request.usageRecorded, true);
      }
    }
    return true;
  } catch { return false; }
}
async function claim(manifestHash: string, runId: string, claimDirectory = directory) {
  assert.match(manifestHash, /^[a-f0-9]{64}$/); await mkdir(claimDirectory, { recursive: true });
  await writeFile(new URL(`${manifestHash}.attempt.json`, claimDirectory), JSON.stringify({ runId, manifestHash, startedAt: new Date().toISOString() }), { flag: "wx" });
}
export async function runQuestionSession(path: string) {
  const { manifest, data, manifestHash } = await inspectQuestionSession(path);
  await mkdir(directory, { recursive: true }); const runId = randomUUID(), target = new URL(`${runId}.json`, directory);
  await claim(manifestHash, runId);
  const beforePackages = await hashes(["package.json", "package-lock.json"]);
  const save = (artifact: unknown) => { const content = { ...artifact as object, manifest, manifestHash };
    return writeFile(target, JSON.stringify({ ...content, artifactHash: contentHash(content) }, null, 2) + "\n"); };
  const artifact = await execute(data, manifest.configuration, false, save, runId, async () => {
    assert.deepEqual(manifest.sourceHashes, await hashes(Object.keys(manifest.sourceHashes)));
    assert.deepEqual(manifest.configuration.dependencySnapshot, await readC1ValidationDependencies());
    assert.deepEqual(beforePackages, await hashes(["package.json", "package-lock.json"]));
  });
  const after = await hashes(Object.keys(manifest.sourceHashes)), afterPackages = await hashes(["package.json", "package-lock.json"]);
  const codeStable = equal(manifest.sourceHashes, after), dependenciesStable = equal(manifest.configuration.dependencySnapshot, await readC1ValidationDependencies());
  const executionComplete = artifact.rows.every(row => row.execution === "completed"), usageComplete = Object.values(artifact.usage).every(value => value.unknownCosts === 0);
  const primaryRequestBindingPassed = primaryBinding(artifact, manifest.configuration), questionRequestBindingPassed = questionBinding(artifact, manifest.configuration);
  const runIntegrityPassed = codeStable && dependenciesStable && equal(beforePackages, afterPackages) && !artifact.failure && !artifact.stopReason && executionComplete && usageComplete
    && primaryRequestBindingPassed && questionRequestBindingPassed && artifact.rows.length === 24 && artifact.rows.every(row => row.ingressIntegrityPassed)
    && artifact.cleanup.length === 12 && artifact.cleanup.every(row => row.disposed && row.remainingOrders === 0);
  await save({ ...artifact, codeHashes: { before: manifest.sourceHashes, after }, codeStable, dependenciesStable, localPackageHashes: { before: beforePackages, after: afterPackages },
    executionComplete, usageComplete, primaryRequestBindingPassed, questionRequestBindingPassed, runIntegrityPassed });
  console.log(JSON.stringify({ artifact: target.pathname, summary: artifact.summary, usage: artifact.usage, codeStable, runIntegrityPassed, admitted: false }));
  return target.pathname;
}

export async function checkQuestionSession() {
  const data = await loadDataset(), config = await configuration({}), artifact = await execute(data, config, true);
  assert.equal(artifact.failure, null); assert.equal(artifact.stopReason, null); assert.equal(artifact.rows.length, 24);
  const retainedV2Pending = artifact.rows.find(row => row.arm === "v2" && row.caseId === "C1-QUESTION-SESSION-005" && row.turn === 3)!;
  assert.equal(retainedV2Pending.score?.engineeringPassed, false); assert.equal(retainedV2Pending.score?.knowledgePassed, false);
  assert.equal(retainedV2Pending.result?.outcome, "clarification"); assert.equal(retainedV2Pending.result?.pendingReferenceKind, "policy");
  assert.equal(retainedV2Pending.calls.length, 0);
  assert.equal((retainedV2Pending.hostReference as { pendingReferenceKind?: unknown }).pendingReferenceKind, "policy");
  assert.ok(retainedV2Pending.result?.referencePresentation === "policy", "v2 retains pending policy after standalone; preserve this baseline failure");
  assert.ok(artifact.rows.every(row => row.score?.evidenceProofPassed), "All 24 native turns retain independent evidence proof, including the v2 business failure");
  assert.ok(artifact.rows.every(row => row.execution === "completed" && row.ingressIntegrityPassed
    && (row === retainedV2Pending || row.score?.engineeringPassed && row.score.knowledgePassed)), JSON.stringify(artifact.rows
    .filter(row => row.execution !== "completed" || !row.score?.engineeringPassed || !row.score.knowledgePassed).map(row => ({ caseId: row.caseId, arm: row.arm, turn: row.turn, reason: row.reason, score: row.score }))));
  assert.equal(primaryBinding(artifact, config), true); assert.equal(questionBinding(artifact, config), true);
  assert.equal(artifact.cleanup.length, 12); assert.ok(artifact.cleanup.every(row => row.disposed && row.remainingOrders === 0));
  assert.ok(artifact.rows.every(row => !row.sdkRetryEvents.length && !row.score?.answerPassed && !row.score?.passed));
  assert.ok(artifact.rows.filter(row => row.arm === "v2").every(row => !row.questionCalls && !row.requests.some(request => request.operation === "question")));
  assert.equal(artifact.requests.filter(row => row.operation === "question").length, 12, JSON.stringify(artifact.rows.filter(row => row.arm === "v3")
    .map(row => ({ id: row.caseId, turn: row.turn, parser: row.questionCalls?.length, outcome: row.result?.outcome, action: row.result?.action, calls: row.calls.map(call => call.name),
      ...(row.questionCalls?.length ? {} : { steps: row.steps, score: row.score }) }))));
  assert.ok(artifact.rows.filter(row => row.priorTopicPassed).every(row => row.priorHostPassed));
  assert.ok(artifact.rows.filter(row => row.priorClarificationPassed).every(row => row.priorHostPassed));
  const blank = summarizeQuestionSession([], data); assert.equal(blank.plannedTurns, 24); assert.equal(blank.arms.v3.skipped, 12);
  const parserMutation = structuredClone(artifact), parserRow = parserMutation.rows.find(row => row.questionCalls?.length)!;
  parserRow.questionCalls![0]!.wire!.body += " "; assert.equal(questionBinding(parserMutation, config), false);
  const charged = structuredClone(artifact); charged.requests.find(row => row.operation === "question")!.estimatedCost = 0; assert.equal(questionBinding(charged, config), false);
  const primaryMutation = structuredClone(artifact); primaryMutation.wires[0]!.bodyText += " "; assert.equal(primaryBinding(primaryMutation, config), false);
  for (const key of ["model", "support", "rerank", "arms"]) {
    const changed = structuredClone(artifact); (changed.actualSettings as Record<string, unknown>)[key] = null; assert.equal(primaryBinding(changed, config), false);
  }
  const missingTopic = structuredClone(artifact.rows.find(row => row.result?.verifiedPolicyTopic)!); delete missingTopic.result!.verifiedPolicyTopic;
  assert.equal(priorTopicValid(missingTopic, data), false);
  const unknown = await execute(data, config, true, undefined, undefined, undefined, "unknown-question");
  assert.equal(unknown.stopReason, "unknown_question_usage"); assert.equal(unknown.requests.filter(row => row.operation === "question").length, 1);
  assert.ok(unknown.rows.some(row => row.execution === "not_run")); assert.equal(unknown.usage.question.estimatedCost, null); assert.equal(unknown.rows.length, 24);
  const invalid = await execute(data, config, true, undefined, undefined, undefined, "invalid-question");
  const invalidRow = invalid.rows.find(row => row.questionCalls?.length)!;
  assert.equal(invalidRow.questionCalls![0]!.trace.failure, "invalid_response"); assert.ok(invalidRow.questionCalls![0]!.trace.attempts[0]!.costUsd! > 0);
  assert.equal(invalidRow.calls.filter(call => call.name === "search_faq").length, 0);
  assert.equal(invalid.usage.question.unknownCosts, 0);
  assert.equal(invalid.usage.question.knownEstimatedCost, invalid.rows.reduce((n, row) => n + (row.questionCalls?.[0]?.trace.attempts[0]?.costUsd ?? 0), 0));
  const clarification = artifact.rows.find(row => row.arm === "v3" && row.priorClarificationPassed)!, clarificationDonor = artifact.rows.find(row => row.arm === "v3"
    && row.caseId === clarification.caseId && row.turn === clarification.turn - 1)!;
  assert.equal(priorClarificationValid(clarificationDonor), true);
  const wrongPending = structuredClone(clarificationDonor); delete wrongPending.result!.pendingReferenceKind; assert.equal(priorClarificationValid(wrongPending), false);
  const failedDonor = structuredClone(clarificationDonor); failedDonor.execution = "failed"; assert.equal(priorClarificationValid(failedDonor), false);
  const unprovenDonor = structuredClone(clarificationDonor); unprovenDonor.score!.evidenceProofPassed = false; assert.equal(priorClarificationValid(unprovenDonor), false);
  const cancelled = await execute(data, config, true, undefined, undefined, undefined, "cancel-question");
  assert.ok(cancelled.stopReason); assert.equal(cancelled.requests.filter(row => row.operation === "question").length, 1);
  assert.equal(cancelled.rows.find(row => row.questionCalls?.length)?.questionCalls![0]!.trace.failure, "aborted");
  let sent = 0, tick = 0;
  const active = { caseId: "guard", turn: 1, requestId: "guard", signal: new AbortController().signal }, raw = artifact.wires.find(row => row.operation === "agent")!;
  const fixture: typeof fetch = async () => { sent++; return new Response(sse(config.model.id, { role: "assistant", content: "工程输入" })); };
  const bounded = guards(fixture, config, data, () => {}, async () => {}, () => tick); bounded.setActive(active);
  await bounded.questionFetch(config.question.endpoint, { method: "POST", body: "{}" }); bounded.question.record(0, 30, .074995);
  await bounded.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText });
  const cost = 20 * config.model.cost.input / 1_000_000 + 10 * config.model.cost.output / 1_000_000;
  bounded.primary.record(0, 30, cost, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 });
  await bounded.questionFetch(config.question.endpoint, { method: "POST", body: "{}" }); bounded.question.record(1, 30, .074995);
  assert.equal(bounded.stopped(), "combined_usd_soft_stop"); await assert.rejects(bounded.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText })); assert.equal(sent, 3);
  const drift = guards(fixture, config, data, () => {}, async () => { throw new Error("changed frozen source"); }); drift.setActive(active);
  await assert.rejects(drift.questionFetch(config.question.endpoint, { method: "POST", body: "{}" })); assert.equal(drift.requests().length, 0); assert.equal(sent, 3);
  const deadline = guards(fixture, config, data, () => {}, async () => {}, () => tick); deadline.setActive(active); tick = config.limits.deadlineMs;
  await assert.rejects(deadline.questionFetch(config.question.endpoint, { method: "POST", body: "{}" })); assert.equal(deadline.requests().length, 0);
  const aborted = guards(fixture, config, data, () => {}, async () => {}); aborted.setActive({ ...active, signal: AbortSignal.abort() });
  await assert.rejects(aborted.questionFetch(config.question.endpoint, { method: "POST", body: "{}" })); assert.equal(aborted.requests().length, 0);
  const quota = guards(fixture, config, data, () => {}, async () => {}); quota.setActive(active);
  for (let index = 0; index < 12; index++) { await quota.questionFetch(config.question.endpoint, { method: "POST", body: "{}" }); quota.question.record(index, 30, .00001); }
  assert.equal(quota.stopped(), null);
  await quota.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText }); quota.primary.record(0, 30, cost, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 });
  await assert.rejects(quota.questionFetch(config.question.endpoint, { method: "POST", body: "{}" })); assert.equal(quota.question.requests.length, 12); assert.equal(quota.primary.requests.length, 1);
  const pendingUsage = guards(fixture, config, data, () => {}, async () => {}); pendingUsage.setActive(active);
  await pendingUsage.questionFetch(config.question.endpoint, { method: "POST", body: "{}" });
  await assert.rejects(pendingUsage.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText })); assert.equal(pendingUsage.primary.requests.length, 0);
  assert.equal(pendingUsage.stopped(), "unrecorded_or_retry_request");
  const claimDirectory = new URL(`check-claim-${randomUUID()}/`, directory), manifestHash = contentHash("synthetic once manifest");
  let claimSends = 0;
  try {
    await claim(manifestHash, randomUUID(), claimDirectory); claimSends++;
    await assert.rejects(async () => { await claim(manifestHash, randomUUID(), claimDirectory); claimSends++; }, { code: "EEXIST" });
    assert.equal(claimSends, 1);
  } finally { await rm(claimDirectory, { recursive: true, force: true }); }
  console.log("Question Session engineering checks: 24 native Pi turns, v2/v3 roles, actual prerequisites, one parser/repair, native wire/SDK/fee binding, unknown/invalid/cancel and shared budget/source/deadline controls; remote/DB/QQ=0; fake answers unreviewed.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") await checkQuestionSession();
  else { assert.ok(args.length === 2 && ["--freeze", "--inspect", "--live"].includes(args[0]!), "Use --check or --freeze|--inspect|--live MANIFEST");
    if (args[0] === "--freeze") await freezeQuestionSession(args[1]!);
    else if (args[0] === "--inspect") { const value = await inspectQuestionSession(args[1]!); console.log(JSON.stringify({ counts: value.manifest.counts, providerRequests: 0 })); }
    else await runQuestionSession(args[1]!); }
}
