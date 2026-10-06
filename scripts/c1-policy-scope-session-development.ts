import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import { BailianError, contentHash, createBailianClient } from "../src/bailian.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, EvidenceSupportError, evidenceSupportTypedV6PromptVersion, validateEvidenceSupport } from "../src/evidence-support.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { loadKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import { scopeDocuments, serializeRetrievalDocument, type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportPolicyScopeRepair, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { currentReferenceChoices, resolveReferenceChoice, type TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import { resolveSupportRunParameters } from "../src/support-parameters.ts";
import { assertC1PolicyScopeRepairEvidence, scoreC1ValidationTurn, type C1AnswerReview, type C1ValidationActual, type C1ValidationTurn } from "./c1-session-validation-check.ts";
import { c1ValidationCodeFiles, controlledStore, createC1ValidationGuard, readC1ValidationDependencies, withinTurnDeadline, type C1ValidationLimits, type StoreRead } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url), datasetPath = "data/c1-policy-scope-session-development.json";
const directory = new URL(".runtime/c1-policy-scope-session-development/", root);
const arms = ["budget0", "budget1"] as const;
type Arm = typeof arms[number];
type Operation = "agent" | "rerank" | "support";
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Turn = C1ValidationTurn & { evidenceTarget: "current_order" | "rule_only"; assumptionBasis?: string;
  requiresPriorVerifiedTopic?: boolean; scopePurpose: string; inputHash: string };
type Dataset = { version: 1; suiteId: string; stage: "fresh-fixed-policy-scope-session-not-blind"; syntheticBoundary: string;
  sources: Array<{ path: string; sha256: string; bytes: number }>; corpus: RetrievalDocument[]; corpusHash: string;
  actor: QQIdentity; groupOpenid: string; limits: typeof policyScopeSessionLimits; measurement: { casesPerArm: number; turnsPerArm: number; arms: Arm[]; pairedTurns: number;
    remoteExecutionsPerManifest: number; sqlRequests: number; qqRequests: number };
  cases: Array<{ id: string; scenario: string; orders: Array<{ owner: QQIdentity; order: Order }>; turns: Turn[] }> };
export const policyScopeSessionLimits = { requests: { agent: 48, rerank: 16, support: 16 }, deadlineMs: 10 * 60_000,
  turnTimeoutMs: 75_000, estimatedUsd: .08, estimatedCny: .02 };
const parameters = (arm: Arm) => resolveSupportRunParameters("controller", { timeoutMs: policyScopeSessionLimits.turnTimeoutMs,
  repairBudget: arm === "budget0" ? 0 : 1, agentModel: "deepseek-flash", knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportModel: "deepseek-v4-pro",
  knowledgeSupportPrompt: "v6", knowledgeApplicability: "declared-v2", knowledgeQueryMode: "separated", knowledgeThreshold: .5, knowledgeTimeoutMs: 60_000 });
const readHashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));
const inputOf = ({ inputHash: _hash, ...input }: Turn) => input;

async function loadDataset() {
  const data = JSON.parse(await readFile(new URL(datasetPath, root), "utf8")) as Dataset;
  assert.equal(data.version, 1); assert.equal(data.stage, "fresh-fixed-policy-scope-session-not-blind");
  assert.equal(data.cases.length, 4); assert.equal(new Set(data.cases.map(item => item.id)).size, 4);
  assert.equal(data.cases.reduce((n, item) => n + item.turns.length, 0), 8);
  assert.deepEqual(data.limits, policyScopeSessionLimits);
  assert.deepEqual(data.measurement, { ...data.measurement, casesPerArm: 4, turnsPerArm: 8, arms: [...arms], pairedTurns: 16,
    remoteExecutionsPerManifest: 1, sqlRequests: 0, qqRequests: 0 });
  assert.equal(contentHash(data.corpus), data.corpusHash); assert.equal(data.corpus.length, 8);
  assert.deepEqual(data.corpus, JSON.parse(await readFile(new URL("data/acceptance-online.json", root), "utf8")).documents);
  for (const source of data.sources) { const bytes = await readFile(new URL(source.path, root)); assert.equal(contentHash(bytes), source.sha256); assert.equal(bytes.length, source.bytes); }
  for (const item of data.cases) {
    assert.equal(item.turns.length, 2); assert.equal(item.turns[0]!.requiresPriorVerifiedTopic === true, false);
    assert.equal(item.turns[1]!.requiresPriorVerifiedTopic, true); assert.equal(item.turns[0]!.expected.knowledge, "evidence");
    assert.ok(item.orders.length && item.orders.every(value => equal(value.owner, data.actor)));
    for (const [index, turn] of item.turns.entries()) {
      assert.equal(turn.inputHash, contentHash(inputOf(turn))); assert.ok(turn.question.trim() && turn.question.length <= 500);
      assert.ok(["current_order", "rule_only"].includes(turn.evidenceTarget));
      if (turn.evidenceTarget === "rule_only") assert.ok(turn.assumptionBasis?.trim());
      assert.equal(turn.expected.gold.length > 0, turn.expected.knowledge === "evidence");
      assert.ok(turn.expected.answerCriteria.length && new Set(turn.expected.answerCriteria.map(row => row.id)).size === turn.expected.answerCriteria.length);
      for (const gold of turn.expected.gold) assert.ok(scopeDocuments(data.corpus, turn.expected.scope).find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote));
      assert.ok(item.orders.some(row => row.order.id === turn.expected.freshOrder?.id));
      if (turn.stateChange) { assert.ok(index > 0); assert.deepEqual(turn.stateChange.before, item.turns[index - 1]!.expected.freshOrder);
        assert.deepEqual(turn.stateChange.after, turn.expected.freshOrder); assert.notEqual(turn.stateChange.before.items[0]!.productId, turn.stateChange.after?.items[0]!.productId); }
    }
  }
  assert.equal(data.cases[2]!.turns[0]!.evidenceTarget, "rule_only");
  assert.equal(data.cases[3]!.turns[1]!.expected.outcome, "clarification");
  return data;
}
async function sourceFiles() {
  return [...new Set([...(await c1ValidationCodeFiles()), "scripts/c1-session-live.ts", "scripts/c1-policy-scope-session-development.ts",
    datasetPath, "docs/c1-policy-scope-repair.md", "db/02-seed.sql", "data/knowledge-applicability.json", "data/knowledge-applicability-v2.json", ...(await loadDataset()).sources.map(row => row.path)])].sort();
}
const modelSnapshot = (model: Model<Api>) => ({ provider: model.provider,
  id: model.id, api: model.api, baseUrl: model.baseUrl, maxTokens: Math.min(model.maxTokens, 2048), cost: model.cost });

// Catalog/settings factories are offline. Credentials are neither required nor serialized.
async function configuration(env: NodeJS.ProcessEnv = process.env) {
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!, judge = runtime.getModel("deepseek", "deepseek-v4-pro")!;
  assert.ok(model && judge);
  const support = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 60_000,
    runtime: { model: judge, complete: async () => { throw new Error("Metadata only"); } } });
  const rerank = createBailianClient({ retries: 0, timeoutMs: 60_000, env: { DASHSCOPE_API_KEY: "metadata-only-not-a-credential",
    DASHSCOPE_BASE_URL: env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com" } });
  const snapshot = await loadKnowledgeApplicabilitySnapshot(2); assert.equal(snapshot.version, 2);
  assert.deepEqual({ ...parameters("budget0"), repairBudget: null }, { ...parameters("budget1"), repairBudget: null });
  return { architecture: "controller" as const, arms: arms.map(arm => ({ arm, parameters: parameters(arm), applicabilitySnapshot: snapshot,
    ...(arm === "budget1" ? { policyScopeRepair: { version: "policy-scope-repair-v1" as const, maxRepairs: 1 as const, repairBudget: 1 as const } } : {}) })),
    model: modelSnapshot(model), support: support.settings, rerank: rerank.settings, limits: policyScopeSessionLimits,
    agentSelection: "deepseek-flash" as const, supportSelection: "deepseek-v4-pro" as const,
    providerRetries: 0, sessionAutomaticRetries: 0, operationStop: "per-operation" as const, evidenceBindingVersion: "order-evidence-binding-v2" as const, referenceEvidenceRequired: true,
    dependencySnapshot: await readC1ValidationDependencies(), pricing: { estimated: true, asOf: "2026-10-06",
      source: "Pi catalog and Bailian Beijing token estimate, not an invoice", rerankCnyPerMillionTokens:
      /(?:^|\.)dashscope\.aliyuncs\.com$|\.cn-beijing\.maas\.aliyuncs\.com$/.test(new URL(rerank.settings.endpoints.origin).hostname) ? .5 : null } };
}
type Configuration = Awaited<ReturnType<typeof configuration>>;
// Other fixed Session experiments can reuse primary request measurement; the
// reviewed wire/provider rules below stay unchanged.
export type PolicyScopeMeasurementConfiguration = Pick<Configuration, "model" | "support" | "rerank" | "pricing">;
type Manifest = { version: 1; stage: Dataset["stage"]; frozenAt: string; frozenBeforeExecution: true; remoteExecutions: 1;
  dataset: { path: string; sha256: string }; counts: { casesPerArm: 4; turnsPerArm: 8; pairedTurns: 16 };
  sourceHashes: Record<string, string>; configuration: Configuration; configurationHash: string };
export async function freezePolicyScopeSession(path: string) {
  await loadDataset(); const config = await configuration(), sourceHashes = await readHashes(await sourceFiles());
  const manifest: Manifest = { version: 1, stage: "fresh-fixed-policy-scope-session-not-blind", frozenAt: new Date().toISOString(),
    frozenBeforeExecution: true, remoteExecutions: 1, dataset: { path: datasetPath, sha256: sourceHashes[datasetPath]! },
    counts: { casesPerArm: 4, turnsPerArm: 8, pairedTurns: 16 }, sourceHashes, configuration: config, configurationHash: contentHash(config) };
  await mkdir(directory, { recursive: true }); await writeFile(new URL(path, root), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ manifest: path, counts: manifest.counts, limits: config.limits, providerRequests: 0 }));
}
export async function inspectPolicyScopeSession(path: string) {
  const bytes = await readFile(new URL(path, root)), manifest = JSON.parse(bytes.toString()) as Manifest, data = await loadDataset();
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, data.stage); assert.equal(manifest.frozenBeforeExecution, true); assert.equal(manifest.remoteExecutions, 1);
  assert.deepEqual(manifest.counts, { casesPerArm: 4, turnsPerArm: 8, pairedTurns: 16 });
  assert.deepEqual(manifest.dataset, { path: datasetPath, sha256: contentHash(await readFile(new URL(datasetPath, root))) });
  assert.equal(manifest.configurationHash, contentHash(manifest.configuration)); assert.deepEqual(manifest.configuration, await configuration());
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), await sourceFiles()); assert.deepEqual(manifest.sourceHashes, await readHashes(await sourceFiles()));
  return { manifest, data, manifestHash: contentHash(bytes) };
}
type Score = ReturnType<typeof scoreC1ValidationTurn>;
type Row = C1ValidationActual & { arm: Arm; question: string; inputHash: string; reason: string | null; score: Score | null;
  replyHash: string | null; modelFinalText: string | null; ingressIntegrityPassed: boolean | null; storeReads: StoreRead[];
  sdkRetryEvents: Array<{ type: string; attempt: number }>; stateChange: { applied: boolean; beforeHash: string; afterHash: string | null } | null;
  observedRepair?: ReturnType<typeof getSupportPolicyScopeRepair>; priorTopicPassed?: boolean; priorHostPassed?: boolean;
  diagnostics?: ReturnType<typeof scopeDiagnostics> };
const plannedRows = (data: Dataset): Row[] => data.cases.flatMap(item => arms.flatMap(arm => item.turns.map((turn, index) => ({
  caseId: item.id, arm, turn: index + 1, question: turn.question, inputHash: turn.inputHash, requestId: null, execution: "not_run" as const,
  reason: "not_started", score: null, replyHash: null, modelFinalText: null, ingressIntegrityPassed: null, ingress: null, durationMs: null,
  calls: [], steps: [], requests: [], storeReads: [], sdkRetryEvents: [], stateChange: null }))));
const proofConfiguration = (config: Configuration, arm: Arm) => ({ applicability: "declared-v2" as const,
  applicabilitySnapshot: config.arms.find(item => item.arm === arm)!.applicabilitySnapshot, evidenceBindingVersion: config.evidenceBindingVersion,
    referenceEvidenceRequired: config.referenceEvidenceRequired, queryMode: "separated" as const, supportPrompt: "v6" as const, supportSettings: config.support,
    ...(config.arms.find(item => item.arm === arm)!.policyScopeRepair ? { policyScopeRepair: config.arms.find(item => item.arm === arm)!.policyScopeRepair } : {}) });
function lastHost(messages: readonly unknown[]): C1ValidationActual["hostReference"] {
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
export function priorTopicValid(row: Row | undefined, data: Dataset) {
  const score = row?.score, topic = row?.result?.verifiedPolicyTopic;
  return Boolean(row?.execution === "completed" && row.ingressIntegrityPassed && score?.engineeringPassed && score.knowledgePassed
    && score.evidenceProofPassed && score.referenceEvidenceProofPassed && score.supportIntegrityPassed && score.applicabilityIntegrityPassed
    && !row.sdkRetryEvents.length && topic && topic.requestId === row.requestId && topic.originalQuery === row.question
    && topic.sourceKey === merchantSourceKey(data.actor, data.groupOpenid) && topic.groupOpenid === data.groupOpenid
    && topic.orderId === row.result!.evidence.order?.id && topic.sources.length && topic.sources.every(source => row.result!.evidence.rules
      .some(rule => rule.sourceId === source.sourceId && rule.version === source.version)));
}
function scopeDiagnostics(row: Row, turn: Turn) {
  const tools = row.steps.filter(step => step.type === "tool" && step.name === "support_action");
  const first = tools[0]?.input as { action?: { questionContext?: unknown; kind?: string } } | undefined;
  const errors = tools.filter(step => step.isError).map(step => {
    const output = step.output as { content?: Array<{ type: string; text?: string }> };
    const machine = output?.content?.flatMap(part => { try { return part.type === "text" && part.text ? [JSON.parse(part.text)] : []; } catch { return []; } })
      .find(value => value.code === "POLICY_SCOPE_CHANGED");
    return { code: machine?.code ?? "protocol_or_action_error", repair: machine?.repair ?? null };
  });
  const contexts = row.calls.flatMap(call => call.knowledge ? [call.knowledge.context] : []), repair = row.result?.evidence.policyScopeRepair;
  return { firstQuestionContext: first?.action?.questionContext ?? null, firstActionKind: first?.action?.kind ?? null,
    otherToolErrors: errors.filter(error => error.code !== "POLICY_SCOPE_CHANGED").length,
    scopeChangedMessages: errors.filter(error => error.code === "POLICY_SCOPE_CHANGED"), observedRepair: row.observedRepair ?? null,
    finalAction: row.result?.action ?? null, repairCompleted: Boolean(repair && row.score?.evidenceProofPassed && row.result?.action.kind === "policy"),
    unnecessaryClarification: turn.expected.outcome === "ready" && row.result?.outcome === "clarification",
    currentFreshReads: row.calls.filter(call => call.name === "get_order" && !call.isError).map(call => ({ id: call.id, outputHash: contentHash(call.output) })),
    finalKnowledge: contexts.map(context => ({ query: context.effectiveQuery,
      question: context.originalQuery, modelQuestion: context.modelQuestion, retrievalQuery: context.retrievalQuery ?? null,
      priorQueries: context.policyTopic?.priorQueries ?? [], evidenceUse: context.evidenceUse, evidenceTarget: context.evidenceTarget ?? null })) };
}
const reviewInputs = (data: Dataset, rows: Row[]) => rows.map(row => {
  const criteria = data.cases.find(item => item.id === row.caseId)!.turns[row.turn - 1]!.expected.answerCriteria;
  return { arm: row.arm, caseId: row.caseId, turn: row.turn, question: row.question, actualReply: row.reply ?? null, modelFinalText: row.modelFinalText,
    criteria, review: { caseId: row.caseId, turn: row.turn, reviewer: "codex", forHumanReview: true, humanAcceptance: false, status: "unreviewed",
      replyHash: row.replyHash ?? contentHash(null), criteriaHash: contentHash(criteria), checks: [] } satisfies C1AnswerReview };
});
export function summarizePolicyScopeSession(rows: Row[], data: Dataset) {
  const completeRows = plannedRows(data).map(fallback => rows.find(row => row.arm === fallback.arm && row.caseId === fallback.caseId && row.turn === fallback.turn) ?? fallback);
  return { plannedTurns: 16, arms: Object.fromEntries(arms.map(arm => { const items = completeRows.filter(row => row.arm === arm);
    return [arm, { plannedCases: 4, plannedTurns: 8, completed: items.filter(row => row.execution === "completed").length,
      failed: items.filter(row => row.execution === "failed").length, skipped: items.filter(row => row.execution === "not_run").length,
      engineeringPassed: items.filter(row => row.score?.engineeringPassed).length, knowledgePassed: items.filter(row => row.score?.knowledgePassed).length,
      invalidDecisions: items.flatMap(row => row.score?.invalidDecisionIds ?? []), unknownCategoryIds: items.flatMap(row => row.score?.applicabilityUnknownIds ?? []),
      extraAcceptedIds: items.flatMap(row => row.score?.extraAcceptedIds ?? []), scopeChanged: items.filter(row => row.diagnostics?.scopeChangedMessages.length).length,
      repaired: items.filter(row => row.diagnostics?.repairCompleted).length, unnecessaryClarification: items.filter(row => row.diagnostics?.unnecessaryClarification).length,
      scopeRepairObserved: items.some(row => row.diagnostics?.scopeChangedMessages.length), repliesReviewed: 0, fullyPassed: 0 }]; })) };
}

// Permit the final allowed rerank to finish its support/final Agent calls;
// every operation still stops before its own cap+1 HTTP request.
type Wire = { index: number; operation: Operation; requestId: string; provider: string; model: string; endpoint: string;
  bodyText: string; bodyHash: string; hash: string; responseHash: string | null; models: string[]; rawUsage: Record<string, unknown> | null;
  sdkUsage: unknown; attempt: number | null; known: boolean; outputText: string | null; outputHash: string | null; finishReason: string | null };
export function measuredPolicyScopeGuard(fetcher: typeof fetch, config: PolicyScopeMeasurementConfiguration, data: Pick<Dataset, "corpus">,
  beforeAgent: (body: Record<string, unknown>) => void = () => {}, sourceCheck: () => Promise<void> = async () => {}, now = Date.now,
  limits: C1ValidationLimits = policyScopeSessionLimits) {
  const guard = createC1ValidationGuard(fetcher, now, limits, "per-operation"), wires: Wire[] = [];
  let extraStop: string | null = null, sealed = false;
  const stop = (reason: string) => { extraStop ??= reason; return extraStop; };
  const stopped = () => extraStop ?? guard.stopped();
  const fetchFor = (operation: Operation): typeof fetch => async (url, init) => {
    if (stopped()) throw new Error(stopped()!);
    if (guard.requests.some(request => !request.usageRecorded)) throw new Error(stop("unrecorded_or_retry_request"));
    try {
      await sourceCheck(); assert.ok(!sealed); assert.equal(init?.method?.toUpperCase(), "POST");
      assert.ok(typeof init?.body === "string" && init.body.length <= 250_000);
      const body = JSON.parse(init.body), model = operation === "agent" ? config.model.id : operation === "support" ? config.support.model : config.rerank.rerankModel;
      const provider = operation === "rerank" ? "bailian" : "deepseek";
      const endpoint = operation === "rerank" ? config.rerank.endpoints.rerank : `${(operation === "agent" ? config.model.baseUrl : config.support.endpoint).replace(/\/$/, "")}/chat/completions`;
      assert.equal(String(url), endpoint); assert.equal(body.model, model);
      if (operation === "rerank") {
        assert.ok(typeof body.query === "string" && body.query.trim()); assert.equal(body.instruct, config.rerank.rerankInstruction);
        assert.ok(Array.isArray(body.documents) && body.documents.length && body.documents.every((value: unknown) => typeof value === "string"
          && data.corpus.some(document => serializeRetrievalDocument(document) === value)));
        assert.equal(new Set(body.documents).size, body.documents.length); assert.equal(body.top_n, body.documents.length);
      } else {
        assert.equal(body.max_tokens, 2048); assert.ok(!("max_completion_tokens" in body)); assert.deepEqual(body.thinking, { type: "disabled" });
        assert.ok(!("enable_thinking" in body) && !("reasoning_effort" in body)); assert.equal(body.stream, true);
        assert.deepEqual(body.stream_options, { include_usage: true }); assert.ok(Array.isArray(body.messages));
        if (operation === "agent") {
          assert.equal(body.tools?.length, 1); assert.equal(body.tools[0].function.name, "support_action");
          assert.ok(equal(body.tool_choice, { type: "function", function: { name: "support_action" } }) || body.tool_choice === "auto");
          beforeAgent(body);
        } else {
          assert.ok(!("tools" in body) && !("tool_choice" in body)); assert.equal(body.temperature, 0);
          assert.deepEqual(body.response_format, { type: "json_object" });
          assert.equal(contentHash(body.messages[0].content), config.support.promptHash);
          assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, "system"); assert.equal(body.messages[1].role, "user");
          const payload = JSON.parse(body.messages[1].content); assert.deepEqual(Object.keys(payload).sort(), ["documents", "query"]);
          assert.ok(typeof payload.query === "string" && payload.query.trim() && Array.isArray(payload.documents) && payload.documents.length);
          for (const document of payload.documents) { assert.deepEqual(Object.keys(document).sort(), ["body", "id", "tags", "title"]);
            const source = data.corpus.find(value => value.id === document.id); assert.ok(source);
            assert.deepEqual(document, { id: source.id, title: source.title, tags: source.tags, body: source.body }); }
        }
      }
      const index = guard.requests.length, wire: Wire = { index, operation, requestId: "", provider, model, endpoint,
        bodyText: init.body, bodyHash: contentHash(init.body), hash: contentHash({ endpoint, method: "POST", body: init.body }),
        responseHash: null, models: [], rawUsage: null, sdkUsage: null, attempt: null, known: false,
        outputText: operation === "support" ? "" : null, outputHash: null, finishReason: null };
      let response: Response;
      try { response = await guard.fetchFor(operation)(url, { ...init, redirect: "error" }); }
      finally { const sent = guard.requests[index]; if (sent) { assert.equal(sent.operation, operation); wire.requestId = sent.requestId; wires.push(wire); } }
      const raw = await response.clone().text(); assert.ok(raw.length <= 500_000); wire.responseHash = contentHash(raw);
      if (operation === "rerank") {
        const parsed = JSON.parse(raw); wire.rawUsage = parsed.usage ?? null;
      } else for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue; const payload = line.slice(5).trim(); if (!payload || payload === "[DONE]") continue;
        const chunk = JSON.parse(payload); if (typeof chunk.model === "string" && !wire.models.includes(chunk.model)) wire.models.push(chunk.model);
        for (const choice of chunk.choices ?? []) {
          assert.ok(!choice.delta?.reasoning_content && !choice.delta?.reasoning, "Thinking output is outside this frozen run");
          if (operation === "support") {
            assert.equal(choice.index, 0); assert.ok(!choice.delta?.tool_calls);
            if (choice.delta?.content !== undefined && choice.delta.content !== null) { assert.equal(typeof choice.delta.content, "string");
              wire.outputText += choice.delta.content; assert.ok(wire.outputText!.length <= 20_000); }
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) wire.finishReason = choice.finish_reason;
          }
        }
        if (chunk.usage) { const u = chunk.usage;
          wire.rawUsage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens,
            ...(u.prompt_cache_hit_tokens !== undefined ? { prompt_cache_hit_tokens: u.prompt_cache_hit_tokens } : {}),
            ...(u.prompt_tokens_details ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens ?? 0,
              cache_write_tokens: u.prompt_tokens_details.cache_write_tokens ?? 0 } } : {}) };
        }
      }
      if (operation === "support") wire.outputHash = contentHash(wire.outputText);
      if (!response.ok) stop("provider_http_failure"); return response;
    } catch { throw new Error(stop("wire_source_or_http_contract_failure")); }
  };
  const record = (index: number, tokens: number | null, cost: number | null, detail?: Record<string, unknown>) => {
    if (sealed) return;
    const wire = wires.find(wire => wire.index === index), request = guard.requests[index];
    try {
      assert.ok(wire && request && wire.rawUsage && (wire.operation === "rerank" || wire.models.length && wire.models.every(model => model === wire.model)));
      const u = wire.rawUsage, safe = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
      let expectedTokens: number, expectedCost: number;
      if (wire.operation === "rerank") {
        assert.ok(safe(u.total_tokens) && Number(u.total_tokens) > 0 && config.pricing.rerankCnyPerMillionTokens !== null);
        expectedTokens = Number(u.total_tokens); expectedCost = expectedTokens * config.pricing.rerankCnyPerMillionTokens / 1_000_000;
      } else {
        const d = u.prompt_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined;
        const cached = d?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, write = d?.cache_write_tokens ?? 0;
        assert.ok([u.prompt_tokens, u.completion_tokens, u.total_tokens, cached, write].every(safe));
        expectedTokens = Number(u.total_tokens); assert.ok(expectedTokens > 0 && expectedTokens === Number(u.prompt_tokens) + Number(u.completion_tokens));
        const input = Number(u.prompt_tokens) - Number(cached) - Number(write); assert.ok(input >= 0);
        const rates = wire.operation === "agent" ? config.model.cost : config.support.pricing.rates;
        expectedCost = input * (rates.input / 1_000_000) + Number(u.completion_tokens) * (rates.output / 1_000_000)
          + Number(cached) * (rates.cacheRead / 1_000_000) + Number(write) * (rates.cacheWrite / 1_000_000);
        if (detail) assert.deepEqual([detail.input, detail.output, detail.cacheRead, detail.cacheWrite], [input, u.completion_tokens, cached, write]);
      }
      assert.equal(tokens, expectedTokens); assert.equal(cost, expectedCost);
      wire.sdkUsage = { tokens, cost, ...(detail ?? {}) }; wire.attempt = 1; wire.known = true; guard.record(index, tokens, cost);
    } catch { if (request && !request.usageRecorded) guard.record(index, null, null); stop("unknown_or_mismatched_usage"); }
  };
  return { ...guard, stopped, stop, fetchFor, record, wires, seal() { sealed = true; guard.seal(); } };
}

async function execute(data: Dataset, config: Configuration, fake = false, save: (value: unknown) => Promise<void> = async () => {}, runId = randomUUID(),
  sourceCheck: () => Promise<void> = async () => {}) {
  const startedAt = new Date().toISOString(), rows = plannedRows(data);
  let active: Row | undefined, responseSteps: Array<{ action: unknown } | { text: string }> = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    assert.ok(fake && active); init?.signal?.throwIfAborted(); const body = JSON.parse(String(init?.body));
    if (body.documents) return new Response(JSON.stringify({ results: body.documents.map((text: string, index: number) => ({ index,
      relevance_score: data.cases.find(item => item.id === active!.caseId)!.turns[active!.turn - 1]!.expected.gold
        .some(gold => data.corpus.find(doc => doc.id === gold.sourceId)!.title === JSON.parse(text).title)
          || !data.cases.find(item => item.id === active!.caseId)!.turns[active!.turn - 1]!.expected.gold.length
            && JSON.parse(text).title === data.corpus.find(doc => doc.id === "KB-SHOP-DEMO-1")!.title ? .95 : .1 }))
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
  const guard = measuredPolicyScopeGuard(fake ? fakeFetch : fetch, config, data, body => {
    if (!active || active.turn === 1) return;
    const prior = rows.find(row => row.arm === active!.arm && row.caseId === active!.caseId && row.turn === 1)!;
    assert.ok(priorTopicValid(prior, data));
    const host = lastHost(body.messages as unknown[]) as { policyChoices?: TrustedReferenceChoices };
    const binding = { sourceKey: merchantSourceKey(data.actor, data.groupOpenid), groupOpenid: data.groupOpenid };
    const choices = currentReferenceChoices(host.policyChoices, binding), selected = resolveReferenceChoice(choices, binding);
    assert.ok(choices && choices.candidates.length === 1 && !choices.selectionRequired && !choices.overflow
      && selected?.kind === "policy" && equal(selected.topic, prior.result!.verifiedPolicyTopic), "Current native host must expose the unique actual verified donor topic");
    active.priorHostPassed = true;
  }, sourceCheck), cleanup: Array<{ arm: Arm; caseId: string; disposed: boolean; remainingOrders: number }> = [];
  const artifact = { version: 1, runId, startedAt, finishedAt: null as string | null, stage: data.stage, data, rows, requests: guard.requests,
    wires: guard.wires, limits: config.limits, operationStop: config.operationStop, actualSettings: null as unknown,
    cleanup, usage: guard.usage(), stopReason: null as string | null, failure: null as string | null, summary: summarizePolicyScopeSession(rows, data), answerReviewInputs: reviewInputs(data, rows),
    admitted: false, realProviderRequests: !fake, sqlRequests: 0, qqRequests: 0 };
  await save(artifact);
  let restore: (() => void) | undefined;
  try {
    const modelRuntime = fake ? await createModelRuntime() : (await createConfiguredModelRuntime(process.env, config.agentSelection)).modelRuntime;
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
      if (sent.length !== 1 || attempts.length !== 1 || (attempts[0] as { attempt?: number }).attempt !== 1) { guard.stop("provider_retry_or_attempt_mismatch"); return; }
      const attempt = attempts[0]! as typeof attempts[number] & Partial<import("../src/evidence-support.ts").EvidenceSupportAttempt>;
      if (operation === "support" && (attempt.provider !== config.support.provider || attempt.model !== config.support.model)) { guard.stop("support_identity_mismatch"); return; }
      guard.record(sent[0]!.index, attempt.totalTokens, operation === "support" ? attempt.costUsd ?? null
        : attempt.totalTokens !== null && config.pricing.rerankCnyPerMillionTokens !== null ? attempt.totalTokens * config.pricing.rerankCnyPerMillionTokens / 1_000_000 : null,
        operation === "support" ? { input: attempt.inputTokens, output: attempt.outputTokens, cacheRead: attempt.cacheReadTokens, cacheWrite: attempt.cacheWriteTokens } : undefined);
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
          supportModel: p.knowledgeSupportModel, supportPrompt: p.knowledgeSupportPrompt, queryMode: p.knowledgeQueryMode, applicability: "declared-v2",
          applicabilitySnapshot: config.arms.find(value => value.arm === arm)!.applicabilitySnapshot, clients: { rerank, support } });
        session = await createSupportSession(data.actor, controlled.store, modelRuntime, model, undefined, { groupOpenid: data.groupOpenid, repairBudget: p.repairBudget ?? undefined, knowledge });
        session.setAutoRetryEnabled(false); assert.equal(session.autoRetryEnabled, false);
        for (const [index, turn] of item.turns.entries()) {
          const row = rows.find(row => row.arm === arm && row.caseId === item.id && row.turn === index + 1)!;
          if (guard.stopped()) { row.reason = guard.stopped(); continue; }
          if (turn.requiresPriorVerifiedTopic) {
            row.priorTopicPassed = priorTopicValid(rows.find(value => value.arm === arm && value.caseId === item.id && value.turn === 1), data);
            if (!row.priorTopicPassed) { row.reason = "prior_verified_topic_not_established"; continue; }
          }
          if (turn.stateChange) row.stateChange = controlled.change(turn.stateChange);
          active = row;
          if (fake) {
            const policy = { kind: "policy", question: turn.question, questionContext: { kind: "standalone" },
              orderRef: { kind: "explicit", orderId: turn.expected.freshOrder!.id }, evidenceTarget: turn.evidenceTarget === "current_order"
                ? { kind: "current_order" } : { kind: "rule_only", basis: turn.assumptionBasis! } };
            const prior = rows.find(value => value.arm === arm && value.caseId === item.id && value.turn === 1);
            responseSteps = index === 0 ? [{ action: policy }] : [{ action: { ...policy, questionContext: { kind: "previous", requestId: prior!.result!.verifiedPolicyTopic!.requestId } } },
              ...(arm === "budget1" ? [{ action: turn.expected.outcome === "clarification" ? { kind: "clarify", field: "policy_topic", reason: "ambiguous" } : policy }] : [])];
            responseSteps.push({ text: "工程固定回答，尚未审阅。" });
          }
          const abort = new AbortController(), requestId = `${runId}:${arm}:${item.id}:${index + 1}`, ingress = { caseId: item.id, turn: index + 1, requestId, signal: abort.signal };
          row.requestId = requestId; row.reason = null; row.ingress = { identity: data.actor, groupOpenid: data.groupOpenid, messageId: requestId, requestId, observedAt: new Date().toISOString() };
          guard.setActive(ingress); controlled.setActive({ ingress, reads: row.storeReads });
          let collecting = true; prepareSupportPrompt(session, { requestId, groupOpenid: data.groupOpenid, messageId: requestId,
            onCall: call => { if (collecting) row.calls.push(structuredClone(call)); } });
          const capture = captureEvaluationTurn(`${model.provider}/${model.id}`), startMessages = session.messages.length, startRequests = guard.requests.length;
          let cursor = startRequests;
          const unsubscribe = session.subscribe(event => { if (!collecting) return;
            if (event.type === "message_end" && event.message.role === "assistant" && event.message.content.some(part => part.type === "thinking")) {
              guard.stop("unexpected_thinking_content"); capture.receive({ ...event, message: { ...event.message,
                content: event.message.content.filter(part => part.type !== "thinking") } }); abort.abort(); cancelSupportTurn(session!); void session!.abort().catch(() => {});
            } else capture.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") { row.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
              guard.stop("sdk_auto_retry_forbidden"); abort.abort(); cancelSupportTurn(session!); void session!.abort().catch(() => {}); }
            if (event.type === "message_end" && event.message.role === "assistant") { const sent = guard.requests.map((request, index) => ({ request, index }))
              .filter(value => value.index >= cursor && value.request.operation === "agent" && value.request.requestId === requestId);
              if (sent.length === 1 && event.message.provider === config.model.provider && event.message.model === config.model.id) {
                const usage = event.message.usage;
                guard.record(sent[0]!.index, usage?.totalTokens ?? null, usage?.cost?.total ?? null,
                  usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : undefined);
              } else guard.stop("agent_attempt_or_identity_mismatch"); cursor = guard.requests.length; }
          });
          let failed = false, timedOut = false; const current = session;
          try { await withinTurnDeadline(session.prompt(turn.question, { expandPromptTemplates: false }), Math.min(policyScopeSessionLimits.turnTimeoutMs, guard.remainingMs()), () => {
            timedOut = true; abort.abort(); cancelSupportTurn(current); void current.abort().catch(() => {}); }); }
          catch { failed = true; } finally { collecting = false; unsubscribe(); abort.abort(); }
          const measured = capture.finish(); row.durationMs = measured.durationMs; row.steps = measured.steps; row.requests = structuredClone(guard.requests.slice(startRequests));
          row.hostReference = lastHost(session.messages.slice(startMessages)); const result = getSupportResult(session); if (result) row.result = structuredClone(result);
          row.observedRepair = getSupportPolicyScopeRepair(session);
          const receipt = getSupportHostReceipt(session); if (receipt) row.hostReceipt = receipt;
          const final = session.messages.slice(startMessages).findLast(message => message.role === "assistant");
          row.modelFinalText = final?.role === "assistant" ? final.content.filter(part => part.type === "text").map(part => part.text).join("") : null;
          row.reply = supportReply(session, row.modelFinalText ?? ""); row.replyHash = row.reply === undefined ? null : contentHash(row.reply);
          row.ingressIntegrityPassed = ingressIntegrity(row, data);
          if (!row.ingressIntegrityPassed) { guard.stop("ingress_identity_or_ownership_binding_failed");
            cancelSupportTurn(session); void session.abort().catch(() => {}); }
          row.execution = !failed && !timedOut && !measured.failed && row.ingressIntegrityPassed && !row.steps.some(step => step.type === "model" && step.isError) ? "completed" : "failed";
          row.reason = timedOut ? "turn_timeout" : row.execution === "failed" ? guard.stopped() ?? "session_failed" : null;
          const history = rows.filter(prior => prior.arm === arm && prior.caseId === item.id && prior.turn < row.turn).map(actual => ({ question: actual.question, actual }));
          row.score = scoreC1ValidationTurn(turn, row, data.corpus, undefined, proofConfiguration(config, arm), history);
          row.diagnostics = scopeDiagnostics(row, turn);
          guard.setActive(undefined); controlled.setActive(undefined); await save(artifact);
          if (fake) assert.equal(responseSteps.length, 0, JSON.stringify({ caseId: row.caseId, arm, turn: row.turn, reason: row.reason, stop: guard.stopped() }));
          // Standalone restatements remain executable after a semantic failure;
          // a timeout/failed Session cannot safely establish the next turn.
          if (row.execution === "failed") { for (const later of rows.filter(value => value.arm === arm && value.caseId === item.id && value.turn > row.turn)) later.reason = "prior_session_execution_failed"; break; }
        }
      } finally { if (session) { cancelSupportTurn(session); void session.abort().catch(() => {}); session.dispose(); }
        controlled.setActive(undefined); controlled.orders.clear(); guard.setActive(undefined); cleanup.push({ arm, caseId: item.id, disposed: Boolean(session), remainingOrders: controlled.orders.size }); }
    }
  } catch (error) { artifact.failure = "configuration_or_execution_contract_failed"; if (fake) throw error; }
  finally { guard.seal(); restore?.(); artifact.finishedAt = new Date().toISOString(); artifact.stopReason = guard.stopped();
    for (const row of rows) if (row.reason === "not_started") row.reason = artifact.stopReason ?? artifact.failure ?? "not_executed";
    artifact.usage = guard.usage(); artifact.summary = summarizePolicyScopeSession(rows, data); artifact.answerReviewInputs = reviewInputs(data, rows); await save(artifact); }
  return artifact;
}

// Reconstruct wire-to-SDK-to-knowledge binding independently of reported scores.
export function policyScopeWireBindingPassed(artifact: { requests: ReturnType<typeof createC1ValidationGuard>["requests"]; wires: Wire[];
  rows: C1ValidationActual[]; data: Pick<Dataset, "corpus">; actualSettings: unknown },
  config: PolicyScopeMeasurementConfiguration & { arms: unknown }) {
  try {
    assert.deepEqual(artifact.actualSettings, { model: config.model, rerank: config.rerank, support: config.support, arms: config.arms });
    assert.equal(artifact.wires.length, artifact.requests.length);
    assert.equal(new Set(artifact.wires.map(wire => wire.index)).size, artifact.requests.length);
    for (const row of artifact.rows) assert.deepEqual(row.requests, artifact.requests.filter(request => request.requestId === row.requestId));
    for (const [index, request] of artifact.requests.entries()) {
      const wire = artifact.wires.find(wire => wire.index === index)!;
      const row = artifact.rows.find(row => row.requestId === request.requestId);
      assert.ok(row && row.caseId === request.caseId && row.turn === request.turn && row.execution !== "not_run");
      assert.equal(wire.requestId, request.requestId); assert.equal(wire.operation, request.operation);
      assert.equal(wire.provider, wire.operation === "rerank" ? "bailian" : "deepseek");
      const endpoint = wire.operation === "rerank" ? config.rerank.endpoints.rerank
        : `${(wire.operation === "agent" ? config.model.baseUrl : config.support.endpoint).replace(/\/$/, "")}/chat/completions`;
      assert.equal(wire.endpoint, endpoint); assert.equal(wire.bodyHash, contentHash(wire.bodyText));
      assert.equal(wire.hash, contentHash({ endpoint, method: "POST", body: wire.bodyText }));
      const body = JSON.parse(wire.bodyText), model = wire.operation === "agent" ? config.model.id
        : wire.operation === "support" ? config.support.model : config.rerank.rerankModel;
      assert.equal(body.model, model); assert.equal(wire.model, model);
      assert.ok(wire.known && wire.attempt === 1 && request.usageRecorded && wire.rawUsage && wire.responseHash?.match(/^[a-f0-9]{64}$/));
      const sdk = wire.sdkUsage as { tokens: number; cost: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      assert.equal(request.totalTokens, sdk.tokens); assert.equal(request.estimatedCost, sdk.cost);
      assert.equal(request.currency, wire.operation === "rerank" ? "CNY" : "USD");
      if (wire.operation === "agent") {
        assert.ok(wire.models.length && wire.models.every(value => value === model));
        const agentWires = artifact.wires.filter(value => value.requestId === row.requestId && value.operation === "agent");
        const step = row.steps.filter(step => step.type === "model")[agentWires.indexOf(wire)]!;
        assert.ok(step && step.name === `${wire.provider}/${model}` && step.usage);
        assert.deepEqual(step.usage, { input: sdk.input, output: sdk.output, cacheRead: sdk.cacheRead, cacheWrite: sdk.cacheWrite,
          totalTokens: sdk.tokens, estimatedCostUsd: sdk.cost });
      } else {
        const knowledge = row.calls.flatMap(call => call.knowledge ? [call.knowledge] : []);
        const matching = knowledge.filter(value => value.trace.calls.some(call => call.operation === wire.operation));
        assert.equal(matching.length, 1); const { context, trace } = matching[0]!;
        const call = trace.calls.find(call => call.operation === wire.operation)!;
        assert.equal(call.attempts.length, 1); assert.equal(call.attempts[0]!.attempt, 1); assert.equal(call.attempts[0]!.totalTokens, sdk.tokens);
        if (wire.operation === "rerank") {
          assert.deepEqual(trace.settings?.rerank, config.rerank);
          assert.deepEqual(body, { model, query: trace.query, documents: scopeDocuments(artifact.data.corpus, trace.scope).map(serializeRetrievalDocument),
            top_n: scopeDocuments(artifact.data.corpus, trace.scope).length, instruct: config.rerank.rerankInstruction });
          assert.equal(call.requestHash, contentHash({ endpoint, body }));
          assert.equal(sdk.tokens, wire.rawUsage.total_tokens);
          assert.equal(sdk.cost, sdk.tokens * config.pricing.rerankCnyPerMillionTokens! / 1_000_000);
        } else {
          assert.ok(wire.models.length && wire.models.every(value => value === model));
          assert.deepEqual(trace.settings?.support, config.support);
          const attempt = call.attempts[0] as import("../src/evidence-support.ts").EvidenceSupportAttempt;
          assert.equal(attempt.provider, wire.provider); assert.equal(attempt.model, wire.model); assert.equal(attempt.costUsd, sdk.cost);
          assert.deepEqual([attempt.inputTokens, attempt.outputTokens, attempt.cacheReadTokens, attempt.cacheWriteTokens],
            [sdk.input, sdk.output, sdk.cacheRead, sdk.cacheWrite]);
          assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, "system"); assert.equal(body.messages[1].role, "user");
          assert.equal(contentHash(body.messages[0].content), config.support.promptHash);
          const payload = JSON.parse(body.messages[1].content);
          assert.deepEqual(Object.keys(payload).sort(), ["documents", "query"]); assert.equal(payload.query, context.effectiveQuery);
          for (const doc of payload.documents) { const source = scopeDocuments(artifact.data.corpus, trace.scope).find(value => value.id === doc.id)!;
            assert.ok(source); assert.deepEqual(doc, { id: source.id, title: source.title, tags: source.tags, body: source.body }); }
          assert.equal(wire.outputHash, contentHash(wire.outputText));
          if (trace.supportVerification) {
            const verification = trace.supportVerification;
            assert.equal(call.requestHash, contentHash({ settings: config.support, payload }));
            assert.equal(verification.requestHash, call.requestHash);
            assert.equal(wire.finishReason, "stop"); assert.equal(verification.validation?.outputHash, wire.outputHash);
            const parsed = JSON.parse(wire.outputText!); assert.deepEqual(Object.keys(parsed), ["decisions"]);
            assert.ok(Array.isArray(parsed.decisions)); assert.equal(parsed.decisions.length, payload.documents.length);
            const decisions = parsed.decisions.map((decision: Record<string, unknown>) => { assert.deepEqual(Object.keys(decision).sort(), ["category", "id", "quote", "reason"]);
              return { ...decision, supported: decision.category === "direct_fact" || decision.category === "boundary_answer" }; });
            assert.deepEqual(decisions.map((decision: Record<string, unknown>) => decision.id).sort(), payload.documents.map((doc: { id: string }) => doc.id).sort());
            const invalidIds = new Set(verification.validation?.invalidDecisions.map(value => value.id));
            for (const decision of decisions) { const source = artifact.data.corpus.find(value => value.id === decision.id)!;
              assert.equal(validateEvidenceSupport([decision], [{ ...source, rank: 1, score: .95 }], "typed"), !invalidIds.has(decision.id)); }
            assert.deepEqual(decisions.filter((decision: { id: string }) => !invalidIds.has(decision.id)), verification.value);
          } else { assert.ok(trace.supportFailure); assert.equal(trace.supportFailure.outputHash, wire.outputHash); }
        }
      }
      if (wire.operation !== "rerank") {
        assert.equal(body.max_tokens, 2048); assert.ok(!("max_completion_tokens" in body)); assert.deepEqual(body.thinking, { type: "disabled" });
        assert.ok(!("enable_thinking" in body) && !("reasoning_effort" in body)); assert.equal(body.stream, true);
        assert.deepEqual(body.stream_options, { include_usage: true });
        const usage = wire.rawUsage, details = usage.prompt_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined;
        const read = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0, write = details?.cache_write_tokens ?? 0;
        assert.ok([usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, read, write].every(value => Number.isSafeInteger(value) && Number(value) >= 0));
        assert.equal(usage.total_tokens, Number(usage.prompt_tokens) + Number(usage.completion_tokens));
        assert.ok(Number(usage.total_tokens) > 0 && Number(usage.prompt_tokens) >= Number(read) + Number(write));
        assert.deepEqual([sdk.input, sdk.output, sdk.cacheRead, sdk.cacheWrite, sdk.tokens],
          [Number(usage.prompt_tokens) - Number(read) - Number(write), usage.completion_tokens, read, write, usage.total_tokens]);
        const rates = wire.operation === "agent" ? config.model.cost : config.support.pricing.rates;
        assert.equal(sdk.cost, sdk.input! * (rates.input / 1_000_000) + sdk.output! * (rates.output / 1_000_000)
          + sdk.cacheRead! * (rates.cacheRead / 1_000_000) + sdk.cacheWrite! * (rates.cacheWrite / 1_000_000));
        if (wire.operation === "support") { assert.ok(!("tools" in body) && !("tool_choice" in body));
          assert.equal(body.temperature, 0); assert.deepEqual(body.response_format, { type: "json_object" }); }
      }
    }
    return true;
  } catch { return false; }
}

export async function runPolicyScopeSession(path: string) {
  const loaded = await inspectPolicyScopeSession(path), { manifest, data, manifestHash } = loaded;
  await mkdir(directory, { recursive: true }); const runId = randomUUID(), target = new URL(`${runId}.json`, directory);
  await writeFile(new URL(`${manifestHash}.attempt.json`, directory), JSON.stringify({ runId, manifestHash, startedAt: new Date().toISOString() }), { flag: "wx" });
  const beforePackages = await readHashes(["package.json", "package-lock.json"]);
  const save = (artifact: unknown) => { const content = { ...artifact as object, manifest, manifestHash };
    return writeFile(target, JSON.stringify({ ...content, artifactHash: contentHash(content) }, null, 2) + "\n"); };
  const artifact = await execute(data, manifest.configuration, false, save, runId, async () => {
    assert.deepEqual(manifest.sourceHashes, await readHashes(Object.keys(manifest.sourceHashes)));
    assert.deepEqual(manifest.configuration.dependencySnapshot, await readC1ValidationDependencies());
    assert.deepEqual(beforePackages, await readHashes(["package.json", "package-lock.json"]));
  });
  const after = await readHashes(Object.keys(manifest.sourceHashes)), afterPackages = await readHashes(["package.json", "package-lock.json"]);
  const codeStable = equal(manifest.sourceHashes, after), dependenciesStable = equal(manifest.configuration.dependencySnapshot, await readC1ValidationDependencies());
  const executionComplete = artifact.rows.every(row => row.execution !== "not_run"), usageComplete = Object.values(artifact.usage).every(value => value.unknownCosts === 0);
  const requestBindingPassed = policyScopeWireBindingPassed(artifact, manifest.configuration);
  const runIntegrityPassed = codeStable && dependenciesStable && equal(beforePackages, afterPackages) && !artifact.failure && !artifact.stopReason
    && executionComplete && usageComplete && requestBindingPassed && artifact.rows.length === 16 && artifact.rows.every(row => row.ingressIntegrityPassed)
    && artifact.cleanup.length === 8 && artifact.cleanup.every(row => row.disposed && row.remainingOrders === 0);
  await save({ ...artifact, codeHashes: { before: manifest.sourceHashes, after }, codeStable, dependenciesStable,
    localPackageHashes: { before: beforePackages, after: afterPackages }, executionComplete, usageComplete, requestBindingPassed, runIntegrityPassed });
  console.log(JSON.stringify({ artifact: target.pathname, summary: artifact.summary, usage: artifact.usage, codeStable, runIntegrityPassed, admitted: false }));
  return target.pathname;
}

export async function checkPolicyScopeSession() {
  const data = await loadDataset(), config = await configuration({}), artifact = await execute(data, config, true);
  assert.equal(artifact.failure, null); assert.equal(artifact.stopReason, null); assert.equal(artifact.rows.length, 16);
  assert.ok(artifact.rows.every(row => row.execution === "completed" && row.ingressIntegrityPassed && row.score?.evidenceProofPassed), JSON.stringify(artifact.rows
    .filter(row => row.execution !== "completed" || !row.score?.evidenceProofPassed).map(row => ({ id: row.caseId, arm: row.arm, turn: row.turn,
      execution: row.execution, reason: row.reason, score: row.score }))));
  for (const arm of arms) {
    assert.equal(artifact.rows.filter(row => row.arm === arm).length, 8);
    assert.ok(artifact.rows.filter(row => row.arm === arm && row.turn === 1).every(row => priorTopicValid(row, data)));
    assert.ok(artifact.rows.filter(row => row.arm === arm && row.turn === 2).every(row => row.priorTopicPassed && row.priorHostPassed));
  }
  for (const row of artifact.rows.filter(row => row.arm === "budget1" && row.turn === 2)) {
    const item = data.cases.find(item => item.id === row.caseId)!, history = artifact.rows.filter(prior => prior.arm === row.arm && prior.caseId === row.caseId && prior.turn < row.turn)
      .map(actual => ({ question: actual.question, actual }));
    const proof = assertC1PolicyScopeRepairEvidence(row, row.question, history, data.corpus, proofConfiguration(config, row.arm));
    assert.equal(proof.attempts.length, 2); assert.equal(row.diagnostics!.scopeChangedMessages.length, 1);
    assert.equal(row.diagnostics!.scopeChangedMessages[0]!.repair.budget.usedBefore, 0);
    assert.equal(row.result!.evidence.policyScopeRepair!.budget!.usedAfter, 1);
    assert.ok(row.score!.engineeringPassed && row.score!.knowledgePassed);
    if (item.turns[1]!.expected.outcome === "ready") {
      assert.equal(row.calls.filter(call => call.name === "get_order" && !call.isError).length, 2);
      assert.equal(row.result!.evidence.knowledge[0]!.context.policyTopic, null);
      assert.deepEqual(row.diagnostics!.finalKnowledge[0]!.priorQueries, []);
    }
    const removed = structuredClone(row); removed.steps = removed.steps.filter(step => !(step.type === "tool" && step.isError));
    assert.equal(scoreC1ValidationTurn(item.turns[1]!, removed, data.corpus, undefined, proofConfiguration(config, row.arm), history).evidenceProofPassed, false);
    const undeclared = proofConfiguration(config, "budget0");
    assert.equal(scoreC1ValidationTurn(item.turns[1]!, row, data.corpus, undefined, undeclared, history).evidenceProofPassed, false);
  }
  assert.ok(artifact.rows.filter(row => row.arm === "budget0").every(row => !row.result?.evidence.policyScopeRepair && !row.observedRepair));
  assert.ok(artifact.rows.every(row => row.score?.answerPassed === false && row.score.passed === false), "Fake text is never answer-reviewed success");
  assert.ok(artifact.rows.every(row => row.sdkRetryEvents.length === 0));
  const donor = artifact.rows[0]!; const fakeDonor = structuredClone(donor); fakeDonor.result!.verifiedPolicyTopic = undefined;
  assert.equal(priorTopicValid(fakeDonor, data), false);
  const badProof = structuredClone(donor); badProof.score!.evidenceProofPassed = false; assert.equal(priorTopicValid(badProof, data), false);
  const badIngress = structuredClone(donor); badIngress.ingressIntegrityPassed = false; assert.equal(priorTopicValid(badIngress, data), false);
  const empty = summarizePolicyScopeSession([], data); assert.equal(empty.arms.budget0.plannedTurns, 8); assert.equal(empty.arms.budget1.skipped, 8);
  assert.equal(artifact.cleanup.length, 8); assert.ok(artifact.cleanup.every(row => row.disposed && row.remainingOrders === 0));
  assert.ok(artifact.requests.every(request => request.usageRecorded && request.estimatedCost !== null));
  assert.equal(policyScopeWireBindingPassed(artifact, config), true);
  const changedWire = structuredClone(artifact); const support = changedWire.wires.find(wire => wire.operation === "support")!;
  const body = JSON.parse(support.bodyText); const input = JSON.parse(body.messages[1].content); input.query += "伪造查询";
  body.messages[1].content = JSON.stringify(input); support.bodyText = JSON.stringify(body); support.bodyHash = contentHash(support.bodyText);
  support.hash = contentHash({ endpoint: support.endpoint, method: "POST", body: support.bodyText });
  assert.equal(policyScopeWireBindingPassed(changedWire, config), false, "Actual wire payload must match independently verified knowledge input");
  const changedDecision = structuredClone(artifact), decision = changedDecision.rows.find(row => row.calls.some(call => call.knowledge?.trace.supportVerification))!
    .calls.find(call => call.knowledge?.trace.supportVerification)!.knowledge!.trace.supportVerification!.value[0]!;
  decision.category = "limitation_only"; decision.supported = false;
  assert.equal(policyScopeWireBindingPassed(changedDecision, config), false, "Self-consistent verification cannot replace the actual native typed output");
  let sends = 0; const raw = artifact.wires.find(wire => wire.operation === "agent")!;
  const unknown = measuredPolicyScopeGuard(async () => { sends++; return new Response(`data: ${JSON.stringify({model:config.model.id,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`); }, config, data);
  unknown.setActive({ caseId: "guard", turn: 1, requestId: "guard", signal: new AbortController().signal });
  await unknown.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText }); unknown.record(0, null, null);
  assert.equal(unknown.stopped(), "unknown_or_mismatched_usage");
  await assert.rejects(unknown.fetchFor("agent")(raw.endpoint, {method:"POST",body:raw.bodyText})); assert.equal(sends, 1);
  const cost = 10 * (config.model.cost.input / 1_000_000) + 5 * (config.model.cost.output / 1_000_000);
  const missingIdentity = measuredPolicyScopeGuard(async () => new Response(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`), config, data);
  missingIdentity.setActive({ caseId: "identity", turn: 1, requestId: "identity", signal: new AbortController().signal });
  await missingIdentity.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText });
  missingIdentity.record(0, 15, cost, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.equal(missingIdentity.stopped(), "unknown_or_mismatched_usage"); assert.equal(missingIdentity.requests[0]!.estimatedCost, null);
  let cappedSends = 0;
  const capped = measuredPolicyScopeGuard(async (url, init) => { cappedSends++;
    if (String(url) === config.rerank.endpoints.rerank) return new Response(JSON.stringify({ usage: { total_tokens: 100 } }));
    return new Response(`data: ${JSON.stringify({ model: JSON.parse(String(init?.body)).model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
  }, config, data);
  capped.setActive({ caseId: "caps", turn: 1, requestId: "caps", signal: new AbortController().signal });
  const rerankWire = artifact.wires.find(wire => wire.operation === "rerank")!, supportWire = artifact.wires.find(wire => wire.operation === "support")!;
  for (let index = 0; index < 16; index++) { await capped.fetchFor("rerank")(rerankWire.endpoint, { method: "POST", body: rerankWire.bodyText });
    capped.record(index, 100, 100 * config.pricing.rerankCnyPerMillionTokens! / 1_000_000); }
  assert.equal(capped.stopped(), null);
  // Support and final Agent remain available after the sixteenth rerank.
  await capped.fetchFor("support")(supportWire.endpoint, { method: "POST", body: supportWire.bodyText });
  capped.record(16, 15, 10 * (config.support.pricing.rates.input / 1_000_000) + 5 * (config.support.pricing.rates.output / 1_000_000),
    { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  await capped.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText });
  capped.record(17, 15, cost, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.equal(capped.stopped(), null); assert.equal(cappedSends, 18);
  await assert.rejects(capped.fetchFor("rerank")(rerankWire.endpoint, { method: "POST", body: rerankWire.bodyText }));
  assert.equal(cappedSends, 18); assert.equal(capped.requests.filter(request => request.operation === "rerank").length, 16);
  let sourceSends = 0;
  const changedSource = measuredPolicyScopeGuard(async () => { sourceSends++; return new Response(); }, config, data, () => {},
    async () => { throw new Error("Frozen source changed"); });
  changedSource.setActive({ caseId: "source", turn: 1, requestId: "source", signal: new AbortController().signal });
  await assert.rejects(changedSource.fetchFor("support")(supportWire.endpoint, { method: "POST", body: supportWire.bodyText }));
  assert.equal(sourceSends, 0); assert.equal(changedSource.requests.length, 0); assert.equal(changedSource.stopped(), "wire_source_or_http_contract_failure");
  let unrecordedSends = 0;
  const unrecorded = measuredPolicyScopeGuard(async () => { unrecordedSends++; return new Response(`data: ${JSON.stringify({ model: config.model.id,
    choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`); }, config, data);
  unrecorded.setActive({ caseId: "retry", turn: 1, requestId: "retry", signal: new AbortController().signal });
  await unrecorded.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText });
  await assert.rejects(unrecorded.fetchFor("agent")(raw.endpoint, { method: "POST", body: raw.bodyText }));
  assert.equal(unrecordedSends, 1); assert.equal(unrecorded.stopped(), "unrecorded_or_retry_request");
  console.log("Policy scope Session checks: 16 planned native Pi turns, real donor topics and store changes, paired bounded repair/source proof, omission control, unknown usage stop; remote/DB/QQ=0; fake answers remain unreviewed.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") await checkPolicyScopeSession();
  else { assert.ok(args.length === 2 && ["--freeze", "--inspect", "--live"].includes(args[0]!), "Use --check or --freeze|--inspect|--live MANIFEST");
    if (args[0] === "--freeze") await freezePolicyScopeSession(args[1]!);
    else if (args[0] === "--inspect") { const result = await inspectPolicyScopeSession(args[1]!); console.log(JSON.stringify({ counts: result.manifest.counts, providerRequests: 0 })); }
    else await runPolicyScopeSession(args[1]!); }
}
