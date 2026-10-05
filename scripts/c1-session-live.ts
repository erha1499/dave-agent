import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { contentHash, createBailianClient } from "../src/bailian.ts";
import { createEvidenceSupportClient, evidenceSupportValidationVersion, type EvidenceSupportValidation } from "../src/evidence-support.ts";
import { OrderAccessError, type CouponStore } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { createKnowledgeService, type KnowledgeTrace } from "../src/knowledge-service.ts";
import { scopeDocuments } from "../src/retrieval-ranking.ts";
import { cancelSupportTurn, createSupportSession, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import type { SupportCall, SupportResult } from "../src/support-controller.ts";
import type { EvalStep } from "../src/evaluation.ts";
import { resolveSupportRunParameters, type SupportExperimentParameters } from "../src/support-parameters.ts";
import { fixtureOrder, loadC1ContextDataset } from "./c1-context-check.ts";

type Expect = { kind: "order" | "policy" | "refund_eligibility" | "paid_amount_compare" | "clarify";
  orderId: string | null; orderRef?: "explicit" | "focus" | "alternative"; questionContext?: "standalone" | "previous";
  knowledge: "none" | "evidence"; relevant?: string[]; produceTopic?: boolean; displayedPaidCents?: number;
  comparisonPaidCents?: number; forbiddenQueryPhrases?: string[];
  outcome?: "ready" | "clarification"; clarification?: { canonicalProductName: string } };
type Turn = { question: string; expect: Expect };
type Dataset = { version: 1; suiteId: string; stage: string; provenance: string;
  cases: Array<{ id: string; corpus: "online" | "reference"; turns: Turn[] }> };
type HostReference = { kind?: string; orderId?: string | null; policyTopic?: { requestId: string } | null;
  itemPaidUnit?: { requestId: string; paidCents: number } | null; alternativeOrderId?: string | null };
type Check = { layer: "action" | "reference" | "business" | "knowledge" | "execution" | "integrity"; name: string; passed: boolean };
type SupportIntegrity = { status: EvidenceSupportValidation["status"] | "not_applicable" | "unknown";
  applicability: "not_enabled" | "complete" | "incomplete" | "unknown";
  invalidDecisions: EvidenceSupportValidation["invalidDecisions"]; validDecisionCount: number; validUnsupportedIds: string[] };
type NetworkRequest = { operation: "agent" | "support" | "rerank"; caseId: string; turn: number; startedAt: string;
  httpStatus: number | null; error: "request_failed" | null };
type Row = { caseId: string; turn: number; phase: "preparatory" | "final"; question: string; expected: Expect;
  status: "passed" | "failed" | "skipped"; reason?: string; durationMs: number | null; checks: Check[];
  hostReference?: HostReference; result?: SupportResult; reply?: unknown; steps: EvalStep[]; calls: SupportCall[];
  requests: NetworkRequest[]; sdkRetryEvents: Array<{ type: "auto_retry_start" | "auto_retry_end"; attempt: number }>;
  rawRecall: number | null; acceptedRecall: number | null; firstActionCorrect: boolean | null;
  businessContractPassed: boolean | null; supportIntegrity: SupportIntegrity | null; semanticEvidenceCorrect: boolean | null;
  extraAcceptedIds: string[]; missingExpectedIds: string[] };
// New validation may consume the measured material without duplicating execution
// or inheriting this development set's checker-only expectation vocabulary.
export type SessionTurnActual = Pick<Row, "result" | "calls" | "steps" | "reply" | "hostReference" | "requests" | "durationMs">;
const root = new URL("../", import.meta.url);
export type C1SessionSuite = "development" | "product-clarification";
const suitePaths = (suite: C1SessionSuite) => ({ datasetPath: `data/c1-session-${suite}.json`, sourcePath: `data/c1-session-${suite}-source.json` });
const byteHash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const codeFiles = ["scripts/c1-session-live.ts", "scripts/c1-context-check.ts", "src/support-session.ts", "src/support-controller.ts",
  "src/support-context-action.ts", "src/support-action.ts", "src/support-context.ts", "src/support-evidence-context.ts", "src/agent.ts", "src/eval-capture.ts",
  "src/knowledge-service.ts", "src/knowledge-applicability.ts", "data/knowledge-applicability.json", "src/support-parameters.ts",
  "src/bailian.ts", "src/evidence-support.ts", "src/evidence-acceptance.ts", "src/retrieval-ranking.ts",
  "prompts/customer-service-v2.md", "skills/shop-support-v2/SKILL.md", "package-lock.json"];
const hashes = async (files: string[]) => Object.fromEntries(await Promise.all(files.map(async file => [file, contentHash(await readFile(new URL(file, root)))])));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function exactKeys(value: object, allowed: string[]) { assert.ok(Object.keys(value).every(key => allowed.includes(key))); }
function selectPlan(data: Dataset, caseId?: string) {
  if (caseId !== undefined) assert.ok(typeof caseId === "string" && data.cases.some(item => item.id === caseId), "Unknown development case");
  const cases = caseId === undefined ? data.cases : data.cases.filter(item => item.id === caseId);
  const plannedTurns = cases.reduce((n, item) => n + item.turns.length, 0);
  const knowledgeTurns = cases.reduce((n, item) => n + item.turns.filter(turn => turn.expect.knowledge === "evidence").length, 0);
  return { cases, plannedCases: cases.length, plannedTurns, knowledgeTurns,
    // Two Agent responses plus one permitted action repair per user turn, and
    // rerank + support for each expected knowledge query. Retries share this cap.
    maxHttpRequests: Math.min(70, plannedTurns * 3 + knowledgeTurns * 2) };
}
function parseArgs(args: string[]) {
  const options: { live: boolean; caseId?: string; suite?: C1SessionSuite; applicability?: SupportExperimentParameters["knowledgeApplicability"] } = { live: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--live") { assert.equal(options.live, false, "Duplicate --live"); options.live = true; }
    else if (args[index] === "--case") {
      assert.equal(options.caseId, undefined, "Duplicate --case");
      const caseId = args[++index]; assert.ok(caseId && !caseId.startsWith("--"), "--case needs an exact case ID"); options.caseId = caseId;
    } else if (args[index] === "--suite") {
      assert.equal(options.suite, undefined, "Duplicate --suite");
      const value = args[++index]; assert.ok(value === "development" || value === "product-clarification", "--suite needs development or product-clarification");
      options.suite = value;
    } else if (args[index] === "--applicability") {
      assert.equal(options.applicability, undefined, "Duplicate --applicability");
      const value = args[++index]; assert.ok(value === "model_only" || value === "declared", "--applicability needs model_only or declared");
      options.applicability = value;
    } else assert.fail(`Unknown argument: ${args[index]}`);
  }
  return options;
}

export async function loadC1SessionDevelopment(suite: C1SessionSuite = "development") {
  assert.ok(suite === "development" || suite === "product-clarification", "Unknown C1 Session suite");
  const { datasetPath, sourcePath } = suitePaths(suite), supplement = suite === "product-clarification";
  const bytes = await readFile(new URL(datasetPath, root));
  const data = JSON.parse(bytes.toString()) as Dataset;
  const source = JSON.parse(await readFile(new URL(sourcePath, root), "utf8"));
  assert.equal(data.version, 1); assert.equal(data.stage, supplement ? "development-contract-supplement" : "development-exposed-dialogues");
  assert.equal(source.version, 1); assert.equal(source.stage, data.stage); assert.equal(source.dataset.path, datasetPath);
  // Preserve the historical manifest algorithm; the new sidecar explicitly freezes raw bytes.
  if (supplement) assert.equal(source.hashScheme, "sha256-bytes");
  assert.equal(source.dataset.sha256, supplement ? byteHash(bytes) : contentHash(bytes)); assert.equal(source.dataset.bytes, bytes.length);
  const counts = supplement ? { cases: 1, turns: 2 } : { cases: 10, turns: 20 };
  assert.equal(data.cases.length, counts.cases); assert.equal(data.cases.reduce((n, item) => n + item.turns.length, 0), counts.turns);
  assert.deepEqual(source.counts, counts);
  assert.equal(new Set(data.cases.map(item => item.id)).size, counts.cases);
  const context = await loadC1ContextDataset("validation-v3");
  for (const [path, digest] of Object.entries(source.baseFiles)) {
    assert.equal(supplement ? byteHash(await readFile(new URL(path, root))) : (await hashes([path]))[path], digest, path);
  }
  exactKeys(data, ["version", "suiteId", "stage", "provenance", "cases"]);
  for (const item of data.cases) {
    exactKeys(item, ["id", "corpus", "turns"]); assert.ok(["online", "reference"].includes(item.corpus));
    assert.ok(item.turns.length >= 1 && item.turns.length <= 4);
    for (const turn of item.turns) {
      exactKeys(turn, ["question", "expect"]); assert.ok(turn.question.trim() && turn.question.length <= 500);
      const e = turn.expect; exactKeys(e, ["kind", "orderId", "orderRef", "questionContext", "knowledge", "relevant", "produceTopic", "displayedPaidCents", "comparisonPaidCents", "forbiddenQueryPhrases", "outcome", "clarification"]);
      assert.ok(["order", "policy", "refund_eligibility", "paid_amount_compare", "clarify"].includes(e.kind));
      assert.ok(e.orderId === null || Object.values(context.dataset.orderFixtures).some(order => order.orderId === e.orderId));
      assert.ok([undefined, "explicit", "focus", "alternative"].includes(e.orderRef));
      assert.ok([undefined, "standalone", "previous"].includes(e.questionContext));
      assert.ok(["none", "evidence"].includes(e.knowledge));
      assert.ok([undefined, "ready", "clarification"].includes(e.outcome));
      assert.ok([undefined, true, false].includes(e.produceTopic));
      if (e.clarification) {
        exactKeys(e.clarification, ["canonicalProductName"]);
        assert.ok(supplement && e.clarification.canonicalProductName.trim());
        assert.equal(e.kind, "policy"); assert.equal(e.outcome, "clarification");
        assert.ok(e.orderId); assert.equal(e.knowledge, "none"); assert.equal(e.produceTopic, false);
        const key = Object.keys(context.dataset.orderFixtures).find(key => context.dataset.orderFixtures[key]!.orderId === e.orderId)!;
        assert.ok(fixtureOrder(key, context).items.some(item => item.productName === e.clarification!.canonicalProductName));
      }
      assert.equal(Boolean(e.questionContext), e.kind === "policy" || e.kind === "refund_eligibility");
      if (e.kind === "clarify") { assert.equal(e.orderId, null); assert.equal(e.knowledge, "none"); }
      if (e.kind === "paid_amount_compare") { assert.ok(Number.isSafeInteger(e.comparisonPaidCents)); assert.equal(e.knowledge, "none"); }
      if (e.knowledge === "evidence") {
        assert.ok(e.relevant?.length); assert.equal(new Set(e.relevant).size, e.relevant!.length);
        for (const id of e.relevant!) assert.ok(context.corpora[item.corpus].some(doc => doc.id === id));
      } else assert.equal(e.relevant, undefined);
    }
  }
  if (supplement) {
    assert.equal(data.cases[0]!.corpus, "online");
    assert.equal(source.review.timing, "fixed-before-supplement-model-execution");
    assert.equal(source.review.gold.length, 1);
    for (const gold of source.review.gold) {
      assert.ok(context.corpora.online.find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote));
      assert.ok(data.cases[0]!.turns[gold.turn - 1]!.expect.relevant!.includes(gold.sourceId));
    }
  }
  return { data, source, context, datasetPath, sourcePath };
}

// All three provider paths use this guard at the actual HTTP boundary. Retries
// also consume the same fixed request budget; no credential/header/body is logged.
function requestGuard(limit: number, fetcher: typeof fetch = fetch) {
  const requests: NetworkRequest[] = [];
  let active: { caseId: string; turn: number; signal: AbortSignal } | undefined;
  let exhausted = false;
  return { requests, get exhausted() { return exhausted; }, setActive(value: typeof active) { active = value; },
    fetchFor(operation: NetworkRequest["operation"]): typeof fetch { return async (url, init) => {
      if (!active) throw new Error("No active measured turn");
      const signals = [active.signal, init?.signal, url instanceof Request ? url.signal : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
      const signal = AbortSignal.any(signals); signal.throwIfAborted();
      if (requests.length >= limit) { exhausted = true; throw new Error("Global request budget exhausted before sending"); }
      const request: NetworkRequest = { operation, caseId: active.caseId, turn: active.turn, startedAt: new Date().toISOString(), httpStatus: null, error: null };
      requests.push(request);
      try { const response = await fetcher(url, { ...init, signal }); request.httpStatus = response.status; return response; }
      catch { request.error = "request_failed"; throw new Error("Measured provider request failed"); }
    }; } };
}
function lastHost(messages: readonly unknown[]): HostReference {
  return messages.flatMap(value => {
    if (!value || typeof value !== "object" || !("content" in value) || typeof value.content !== "string") return [];
    try { const data = JSON.parse(value.content) as HostReference; return data.kind === "host_order_reference" ? [data] : []; } catch { return []; }
  }).at(-1) ?? {};
}
function actionCorrect(action: unknown, e: Expect, host: HostReference) {
  if (!action || typeof action !== "object") return false;
  const value = action as { protocol?: string; kind?: string; orderRef?: { kind: string; orderId?: string };
    questionContext?: { kind: string; requestId?: string }; amountRef?: { requestId?: string } };
  return value.protocol === "v2.2" && value.kind === e.kind
    && (e.orderRef === undefined ? value.orderRef === undefined : value.orderRef?.kind === e.orderRef)
    && (e.orderRef !== "explicit" || value.orderRef?.orderId === e.orderId)
    && (e.questionContext === undefined ? value.questionContext === undefined : value.questionContext?.kind === e.questionContext)
    && (e.questionContext !== "previous" || Boolean(host.policyTopic?.requestId) && value.questionContext?.requestId === host.policyTopic!.requestId)
    && (e.kind !== "paid_amount_compare" || Boolean(host.itemPaidUnit?.requestId) && value.amountRef?.requestId === host.itemPaidUnit!.requestId);
}
function supportIntegrity(trace: KnowledgeTrace | undefined): SupportIntegrity {
  const verification = trace?.supportVerification, validation = verification?.validation;
  const supportCalled = trace?.calls.some(call => call.operation === "support");
  let status: SupportIntegrity["status"] = !trace ? "unknown" : !supportCalled ? trace.status === "unavailable" ? "unavailable" : "not_applicable"
    : validation ? validation.status : trace.status === "unavailable" ? "unavailable" : "unknown";
  const invalidIds = new Set(validation?.invalidDecisions.map(item => item.id));
  if (validation && (validation.status === "complete" && invalidIds.size !== 0
    || validation.status !== "complete" && invalidIds.size === 0
    || verification?.value.some(item => invalidIds.has(item.id)))) status = "unknown";
  const valid = verification?.value.filter(item => !invalidIds.has(item.id)) ?? [];
  const applicability: SupportIntegrity["applicability"] = trace?.applicability?.mode !== "declared" ? "not_enabled"
    : !trace.applicability.gate ? "unknown" : trace.applicability.gate.integrity ? "complete" : "incomplete";
  return { status, applicability, invalidDecisions: structuredClone(validation?.invalidDecisions ?? []),
    validDecisionCount: valid.length,
    // These are syntactically valid negative decisions, not automatically correct
    // rejections. Invalid candidates are absent from value and never count here.
    validUnsupportedIds: valid.filter(value => !value.supported).map(value => value.id) };
}
function knowledgeCoverage(rows: Row[]) {
  const traces = rows.flatMap(row => row.calls.flatMap(call => call.knowledge ? [call.knowledge.trace] : []));
  return { measuredTurns: rows.filter(row => row.calls.some(call => call.knowledge)).length, actualQueries: traces.length,
    actualSupportCalls: traces.reduce((n, trace) => n + trace.calls.filter(call => call.operation === "support").length, 0),
    expectedUnmeasuredTurns: rows.filter(row => row.expected.knowledge === "evidence" && !row.calls.some(call => call.knowledge)).length,
    integrityCounts: Object.fromEntries((["complete", "partial", "unavailable", "unknown", "not_applicable"] as const)
      .map(status => [status, traces.filter(trace => supportIntegrity(trace).status === status).length])),
    applicabilityIntegrityCounts: Object.fromEntries((["not_enabled", "complete", "incomplete", "unknown"] as const)
      .map(status => [status, traces.filter(trace => supportIntegrity(trace).applicability === status).length])) };
}
function evaluate(row: Row, executed: boolean, applicability: SupportExperimentParameters["knowledgeApplicability"] = "model_only") {
  const e = row.expected, result = row.result, host = row.hostReference ?? {};
  const check = (layer: Check["layer"], name: string, passed: boolean) => row.checks.push({ layer, name, passed });
  check("execution", "turn completed within deadline without provider failure", executed);
  check("action", "executed action and semantic reference match expectation", actionCorrect(result?.action, e, host));
  check("business", "no side-effecting service calls", row.calls.every(call => ["get_order", "search_faq"].includes(call.name)));
  check("business", "expected terminal outcome", result?.outcome === (e.outcome ?? (e.kind === "clarify" ? "clarification" : "ready")));
  check("reference", "fresh authorization or no-order path", e.orderId === null ? !row.calls.some(call => call.name === "get_order")
    : result?.evidence.order?.id === e.orderId && row.calls.some(call => call.name === "get_order" && !call.isError
      && call.parentSpanId === result.evidence.requestId && call.input.orderId === e.orderId && isDeepStrictEqual(call.output, result.evidence.order)));
  if (e.kind === "clarify") check("reference", "clarification does not access business services", row.calls.length === 0);
  if (e.questionContext === "previous") check("reference", "knowledge uses actual visible prior topic", Boolean(host.policyTopic?.requestId)
    && result?.evidence.knowledge[0]?.context.policyTopic?.requestId === host.policyTopic!.requestId);
  if (e.orderRef === "alternative") check("reference", "only the actual host alternative is selected", host.alternativeOrderId === e.orderId
    && result?.verifiedOrderId === e.orderId);
  if (e.produceTopic) check("reference", "successful source-backed topic produced", result?.verifiedPolicyTopic?.requestId === result?.evidence.requestId
    && Boolean(result?.verifiedPolicyTopic?.sources.length));
  if (e.produceTopic === false) check("reference", "clarification creates no successful policy topic", result?.verifiedPolicyTopic === undefined);
  if (e.clarification) {
    const reply = row.reply && typeof row.reply === "object" && "text" in row.reply && typeof row.reply.text === "string" ? row.reply.text : "";
    check("business", "host clarification displays fresh canonical product and order", result?.needsAnswer === false
      && result.reply.kind === "notice" && isDeepStrictEqual(row.reply, result.reply)
      && result.evidence.order?.items.some(item => item.productName === e.clarification!.canonicalProductName) === true
      && reply.includes(e.clarification.canonicalProductName) && reply.includes(e.orderId!));
    check("knowledge", "product clarification publishes no evidence", result?.evidence.rules.length === 0 && result.evidence.knowledge.length === 0);
  }
  if (e.displayedPaidCents !== undefined) check("business", "host displayed paid amount produced", result?.verifiedAmountReference?.paidCents === e.displayedPaidCents);
  if (e.comparisonPaidCents !== undefined) {
    const amount = result?.evidence.amountComparison;
    check("business", "unique remaining coupon paid comparison is factual and not approval", amount?.remainingCouponCount === 1
      && amount.remainingUnitPaidCents === e.comparisonPaidCents && amount.referencePaidCents === e.comparisonPaidCents
      && amount.comparisonEqual === true && amount.refundApproved === false && result?.needsAnswer === false
      && amount.referenceRequestId === host.itemPaidUnit?.requestId);
  }
  const traces = row.calls.flatMap(call => call.knowledge ? [call.knowledge.trace] : []);
  const accepted = result?.evidence.rules.map(rule => rule.sourceId) ?? [], relevant = e.relevant ?? [];
  row.extraAcceptedIds = accepted.filter(id => !relevant.includes(id));
  row.missingExpectedIds = relevant.filter(id => !accepted.includes(id));
  if (traces.length || e.knowledge === "evidence") {
    row.supportIntegrity = supportIntegrity(traces.length === 1 ? traces[0] : undefined);
    check("integrity", "candidate judgments are complete; invalid is not a correct rejection",
      ["complete", "not_applicable"].includes(row.supportIntegrity.status)
      && ["not_enabled", "complete"].includes(row.supportIntegrity.applicability));
  }
  if (e.knowledge === "none") check("knowledge", "no knowledge or knowledge-provider requests", traces.length === 0
    && !row.calls.some(call => call.name === "search_faq") && row.requests.every(request => request.operation === "agent"));
  else {
    check("knowledge", "one actual two-stage knowledge query", traces.length === 1 && traces[0]!.mode === "m4-support"
      && traces[0]!.supportProfile === "typed" && traces[0]!.supportModel === "deepseek-v4-pro" && traces[0]!.threshold === .5 && traces[0]!.status !== "unavailable"
      && traces[0]!.applicability?.mode === applicability);
    check("knowledge", "accepted evidence equals frozen expected sources", same([...accepted].sort(), [...relevant].sort()));
    check("knowledge", "original current question remains auditable", traces[0]?.originalQuery === row.question);
    for (const phrase of e.forbiddenQueryPhrases ?? []) check("reference", `no historical assumption in query: ${phrase}`,
      Boolean(traces[0]) && !traces[0]!.query.includes(phrase));
    row.rawRecall = traces[0]?.calls.some(call => call.operation === "rerank" && call.status === "ok")
      ? relevant.filter(id => traces[0]!.rawRanking.slice(0, 5).some(doc => doc.id === id)).length / relevant.length : null;
    row.acceptedRecall = traces[0] && traces[0].status !== "unavailable"
      ? relevant.filter(id => accepted.includes(id)).length / relevant.length : null;
    const complete = ["complete", "not_applicable"].includes(row.supportIntegrity!.status)
      && ["not_enabled", "complete"].includes(row.supportIntegrity!.applicability);
    row.semanticEvidenceCorrect = complete && traces[0]?.status !== "unavailable"
      ? row.extraAcceptedIds.length === 0 && row.missingExpectedIds.length === 0 : null;
  }
  const first = row.steps.find(step => step.type === "tool" && step.name === "support_action")?.input as { action?: unknown } | undefined;
  row.firstActionCorrect = actionCorrect(first?.action, e, host);
  row.businessContractPassed = row.checks.filter(check => check.layer !== "integrity").every(check => check.passed);
  row.status = row.checks.every(check => check.passed) ? "passed" : "failed";
}

export async function checkC1SessionRunner(caseId?: string, applicability: SupportExperimentParameters["knowledgeApplicability"] = "model_only", suite: C1SessionSuite = "development") {
  resolveSupportRunParameters("controller", { knowledgeMode: "m4-support", knowledgeApplicability: applicability });
  const old = await loadC1SessionDevelopment(), supplement = await loadC1SessionDevelopment("product-clarification");
  const { data } = suite === "development" ? old : supplement;
  const all = selectPlan(old.data), appointment = selectPlan(old.data, "session-appointment-topic"), selected = selectPlan(data, caseId);
  assert.deepEqual([all.plannedCases, all.plannedTurns, all.knowledgeTurns, all.maxHttpRequests], [10, 20, 8, 70]);
  assert.deepEqual([appointment.plannedCases, appointment.plannedTurns, appointment.knowledgeTurns, appointment.maxHttpRequests], [1, 2, 2, 10]);
  assert.equal(selectPlan(old.data, "session-paid-comparison").maxHttpRequests, 6);
  const productPlan = selectPlan(supplement.data);
  assert.deepEqual([productPlan.plannedCases, productPlan.plannedTurns, productPlan.knowledgeTurns, productPlan.maxHttpRequests], [1, 2, 1, 8]);
  assert.throws(() => selectPlan(data, "unknown"));
  assert.deepEqual(parseArgs(["--live", "--case", "session-appointment-topic"]), { live: true, caseId: "session-appointment-topic" });
  assert.deepEqual(parseArgs(["--applicability", "declared"]), { live: false, applicability: "declared" });
  assert.deepEqual(parseArgs(["--suite", "product-clarification", "--applicability", "declared"]), { live: false, suite: "product-clarification", applicability: "declared" });
  for (const args of [["--suite"], ["--suite", "validation"], ["--suite", "development", "--suite", "product-clarification"]]) assert.throws(() => parseArgs(args));
  for (const args of [["--applicability"], ["--applicability", "typo"], ["--applicability", "declared", "--applicability", "model_only"]]) assert.throws(() => parseArgs(args));
  for (const args of [["--case"], ["--case", "--live"], ["--live", "--live"], ["--case", "one", "--case", "two"], ["--repeat", "2"]]) assert.throws(() => parseArgs(args));
  const guard = requestGuard(1, async () => new Response("{}"));
  guard.setActive({ caseId: "guard", turn: 1, signal: new AbortController().signal });
  await guard.fetchFor("agent")("https://example.invalid");
  await assert.rejects(guard.fetchFor("support")("https://example.invalid"), /budget exhausted/);
  assert.equal(guard.requests.length, 1); assert.equal(guard.exhausted, true);
  const stopped = requestGuard(70, async () => { throw new Error("must not send"); });
  stopped.setActive({ caseId: "guard", turn: 1, signal: AbortSignal.abort() });
  await assert.rejects(stopped.fetchFor("rerank")("https://example.invalid")); assert.equal(stopped.requests.length, 0);
  stopped.setActive({ caseId: "guard", turn: 1, signal: new AbortController().signal });
  await assert.rejects(stopped.fetchFor("support")("https://example.invalid", { signal: AbortSignal.abort() })); assert.equal(stopped.requests.length, 0);
  assert.equal(actionCorrect({ protocol: "v2.2", kind: "policy", questionContext: { kind: "previous", requestId: "invented" } },
    { kind: "policy", orderId: null, knowledge: "evidence", questionContext: "previous" }, { policyTopic: { requestId: "actual" } }), false);
  for (const item of data.cases) for (const [index, turn] of item.turns.entries()) {
    const row: Row = { caseId: item.id, turn: index + 1, phase: "final", question: turn.question, expected: turn.expect,
      status: "failed", durationMs: null, checks: [], steps: [], calls: [], requests: [], sdkRetryEvents: [], rawRecall: null, acceptedRecall: null, firstActionCorrect: null,
      businessContractPassed: null, supportIntegrity: null, semanticEvidenceCorrect: null, extraAcceptedIds: [], missingExpectedIds: [] };
    evaluate(row, false); assert.equal(row.status, "failed", "missing execution cannot pass any planned turn");
  }
  // Scorer probes only. No fabricated result is persisted as a live run.
  const trace = { mode: "m4-support", supportProfile: "typed", supportModel: "deepseek-v4-pro", threshold: .5, applicability: { mode: "model_only" },
    query: "工程问题", originalQuery: "工程问题", status: "accepted", rawRanking: [{ id: "GOOD", score: .9 }],
    calls: [{ operation: "rerank", status: "ok" }, { operation: "support", status: "partial" }],
    supportVerification: { value: [{ id: "GOOD", supported: true }, { id: "VALID-NEGATIVE", supported: false }],
      validation: { status: "partial", outputHash: "a".repeat(64), invalidDecisions: [{ id: "INVALID", code: "invalid_quote" }] } } } as unknown as KnowledgeTrace;
  const scorerRow = (): Row => ({ caseId: "scorer-only", turn: 1, phase: "preparatory", question: "工程问题",
    expected: { kind: "policy", orderId: null, questionContext: "standalone", knowledge: "evidence", relevant: ["GOOD"] },
    status: "failed", durationMs: 1, checks: [], calls: [{ name: "search_faq", knowledge: { trace } } as SupportCall], steps: [], requests: [], sdkRetryEvents: [],
    result: { action: { protocol: "v2.2", kind: "policy", question: "工程问题", questionContext: { kind: "standalone" } }, outcome: "ready",
      evidence: { requestId: "actual-request", rules: [{ sourceId: "GOOD" }] } } as SupportResult,
    rawRecall: null, acceptedRecall: null, firstActionCorrect: null, businessContractPassed: null,
    supportIntegrity: null, semanticEvidenceCorrect: null, extraAcceptedIds: [], missingExpectedIds: [] });
  const partial = scorerRow(); evaluate(partial, true);
  assert.equal(partial.businessContractPassed, true); assert.equal(partial.status, "failed");
  assert.equal(partial.semanticEvidenceCorrect, null); assert.equal(partial.acceptedRecall, 1);
  assert.deepEqual(partial.supportIntegrity?.validUnsupportedIds, ["VALID-NEGATIVE"]);
  assert.deepEqual(partial.supportIntegrity?.invalidDecisions, [{ id: "INVALID", code: "invalid_quote" }]);
  const unexpectedKnowledge = scorerRow(); unexpectedKnowledge.expected = { kind: "clarify", orderId: null, knowledge: "none" };
  evaluate(unexpectedKnowledge, true);
  assert.equal(unexpectedKnowledge.businessContractPassed, false);
  assert.deepEqual(unexpectedKnowledge.extraAcceptedIds, ["GOOD"]);
  assert.deepEqual(unexpectedKnowledge.supportIntegrity?.invalidDecisions, [{ id: "INVALID", code: "invalid_quote" }],
    "unexpected provider work still contributes its invalid judgments and cost");
  const invalidAsNegative = structuredClone(trace);
  invalidAsNegative.supportVerification!.value.push({ id: "INVALID", supported: false, quote: null, reason: "cannot convert invalid to a rejection" });
  assert.equal(supportIntegrity(invalidAsNegative).status, "unknown");
  assert.deepEqual(supportIntegrity(invalidAsNegative).validUnsupportedIds, ["VALID-NEGATIVE"]);
  const complete = scorerRow(); complete.calls = structuredClone(complete.calls);
  complete.calls[0]!.knowledge!.trace.supportVerification!.validation = { status: "complete", invalidDecisions: [], outputHash: "a".repeat(64) };
  complete.calls[0]!.knowledge!.trace.calls.find(call => call.operation === "support")!.status = "ok";
  evaluate(complete, true); assert.equal(complete.status, "passed"); assert.equal(complete.semanticEvidenceCorrect, true);
  const gateIncomplete = scorerRow(); gateIncomplete.calls = structuredClone(complete.calls);
  gateIncomplete.calls[0]!.knowledge!.trace.applicability = { mode: "declared", gate: {
    version: "declared-order-preconditions-v1", snapshotHash: "a".repeat(64), contextHash: "b".repeat(64),
    status: "ready", integrity: false, reason: "facts_unknown", decisions: [{ id: "UNKNOWN", rank: 2, status: "unknown", reason: "missing fact" }],
  } };
  evaluate(gateIncomplete, true, "declared");
  assert.equal(gateIncomplete.businessContractPassed, true); assert.equal(gateIncomplete.status, "failed");
  assert.equal(gateIncomplete.semanticEvidenceCorrect, null, "unknown applicability is not a correct rejection or a complete semantic judgment");
  assert.equal(gateIncomplete.supportIntegrity?.status, "complete", "provider response completeness remains separate from applicability completeness");
  assert.equal(gateIncomplete.supportIntegrity?.applicability, "incomplete");
  const noQuery = scorerRow(); noQuery.calls = []; evaluate(noQuery, true);
  const measured = knowledgeCoverage([complete, gateIncomplete, noQuery]);
  assert.deepEqual([measured.measuredTurns, measured.actualQueries, measured.actualSupportCalls, measured.expectedUnmeasuredTurns], [2, 2, 2, 1]);
  assert.equal(measured.integrityCounts.unknown, 0, "an unmeasured expected query is not a provider failure");
  assert.equal(measured.applicabilityIntegrityCounts.incomplete, 1);
  const knownMismatch = structuredClone(gateIncomplete.calls[0]!.knowledge!.trace);
  knownMismatch.status = "rejected"; knownMismatch.calls = []; delete knownMismatch.supportVerification;
  knownMismatch.applicability!.gate!.integrity = true;
  knownMismatch.applicability!.gate!.reason = null;
  knownMismatch.applicability!.gate!.decisions[0]!.status = "mismatched";
  assert.equal(supportIntegrity(knownMismatch).status, "not_applicable");
  assert.deepEqual(supportIntegrity(knownMismatch).validUnsupportedIds, [], "a deterministic mismatch is not an LLM supported=false decision");
  const unavailable = scorerRow(); unavailable.calls = structuredClone(unavailable.calls);
  unavailable.calls[0]!.knowledge!.trace.status = "unavailable";
  unavailable.calls[0]!.knowledge!.trace.supportVerification!.validation!.status = "unavailable";
  unavailable.calls[0]!.knowledge!.trace.supportVerification!.value = [];
  evaluate(unavailable, false); assert.equal(unavailable.businessContractPassed, false); assert.equal(unavailable.semanticEvidenceCorrect, null);
  const order = scorerRow(); order.expected = { kind: "order", orderId: "COUPON-1001", orderRef: "explicit", knowledge: "none" };
  order.result!.action = { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: "COUPON-1001" } };
  order.result!.evidence.rules = [];
  order.result!.evidence.order = { id: "COUPON-1001", amounts: { paidCents: 100 } } as SupportResult["evidence"]["order"];
  order.calls = [{ id: "actual-call", name: "get_order", parentSpanId: "actual-request", actor: "host", trigger: "user", component: "support-controller",
    observedAt: "2026-10-06T00:00:00.000Z", durationMs: 1, isError: false,
    input: { orderId: "COUPON-1001" }, output: structuredClone(order.result!.evidence.order) }];
  evaluate(order, true); assert.equal(order.businessContractPassed, true);
  for (const mutate of [(row: Row) => { row.calls[0]!.parentSpanId = "earlier-request"; },
    (row: Row) => { row.calls[0]!.output = { id: "COUPON-1001", amounts: { paidCents: 999 } }; }]) {
    const stale = structuredClone(order); stale.checks = []; mutate(stale); evaluate(stale, true);
    assert.equal(stale.businessContractPassed, false, "current ID alone cannot substitute for fresh, matching authorized output");
  }
  const productTurn = supplement.data.cases[0]!.turns[0]!;
  const productFixtureKey = Object.keys(supplement.context.dataset.orderFixtures)
    .find(key => supplement.context.dataset.orderFixtures[key]!.orderId === productTurn.expect.orderId)!;
  const freshOrder = fixtureOrder(productFixtureKey, supplement.context);
  assert.equal(freshOrder.id, productTurn.expect.orderId);
  const productAction: SupportResult["action"] = { protocol: "v2.2", kind: "policy", question: productTurn.question,
    orderRef: { kind: "explicit", orderId: freshOrder.id }, questionContext: { kind: "standalone" }, productMention: "常规午餐套餐" };
  const productCall: SupportCall = { id: "canonical-order-call", parentSpanId: "canonical-request", name: "get_order", actor: "host", trigger: "user",
    component: "support-controller", observedAt: "2026-10-06T00:00:00.000Z", durationMs: 1, isError: false,
    input: { orderId: freshOrder.id }, output: structuredClone(freshOrder) };
  const productResult: SupportResult = { action: productAction, outcome: "clarification", needsAnswer: false,
    reply: { kind: "notice", text: "本轮查到订单 COUPON-1001 的商品为「双人午餐团购券」，请使用订单号、规范商品名和问题完整重述。" },
    evidence: { version: 1, requestId: "canonical-request", trustedRoute: { groupOpenid: "engineering", messageId: "engineering" },
      action: productAction, actualCalls: [productCall], order: freshOrder, rules: [], knowledge: [] } };
  const productRow: Row = { ...scorerRow(), caseId: supplement.data.cases[0]!.id, expected: productTurn.expect,
    question: productTurn.question, result: productResult, reply: productResult.reply, calls: [productCall] };
  evaluate(productRow, true, applicability);
  assert.equal(productRow.status, "passed");
  assert.equal(productRow.businessContractPassed, true, "a completed expected host clarification allows the next real user turn");
  assert.equal(productRow.firstActionCorrect, false, "scorer fixture does not invent an observed model tool call");
  for (const mutate of [
    (row: Row) => { row.reply = { kind: "notice", text: "请明确商品。" }; },
    (row: Row) => { row.result!.outcome = "ready"; },
    (row: Row) => { row.calls[0]!.parentSpanId = "prior-turn"; },
    (row: Row) => { row.calls[0]!.output = { ...freshOrder, id: "COUPON-1004" }; },
    (row: Row) => { row.result!.verifiedPolicyTopic = { requestId: "canonical-request", sourceKey: "forged", groupOpenid: "engineering",
      originalQuery: row.question, orderId: freshOrder.id, scope: { shopId: freshOrder.shop.id, productId: freshOrder.items[0]!.productId },
      intent: "policy", sources: [{ sourceId: "KB-SHOP-DEMO-1", version: "fake" }] }; },
    (row: Row) => { row.requests.push({ operation: "rerank", caseId: row.caseId, turn: 1, startedAt: freshOrder.asOf, httpStatus: 200, error: null }); },
  ]) {
    const invalid = structuredClone(productRow); invalid.checks = []; mutate(invalid); evaluate(invalid, true, applicability);
    assert.equal(invalid.status, "failed", "canonical clarification requires the real fixed receipt, fresh order, no topic and no knowledge requests");
    assert.equal(invalid.businessContractPassed, false);
  }
  const legacyWeekend = structuredClone(productRow);
  legacyWeekend.checks = []; legacyWeekend.expected = old.data.cases.find(item => item.id === "session-weekend-topic")!.turns[0]!.expect;
  evaluate(legacyWeekend, true, applicability); assert.equal(legacyWeekend.status, "failed", "supplement must not rewrite the original first-turn knowledge contract");
  console.log(`C1 Session runner engineering checks passed: old frozen 10/20 plus independent product clarification 1/2; suite ${suite}, selection ${selected.plannedCases} cases / ${selected.plannedTurns} turns / max ${selected.maxHttpRequests} HTTP. Strict selection, dynamic denominator, cancellation, fresh canonical receipt and missing-execution rejection. No live model.`);
}

export async function runC1SessionDevelopment(caseId?: string, applicability: SupportExperimentParameters["knowledgeApplicability"] = "model_only", suite: C1SessionSuite = "development") {
  resolveSupportRunParameters("controller", { knowledgeMode: "m4-support", knowledgeApplicability: applicability });
  const { data, source, context, datasetPath, sourcePath } = await loadC1SessionDevelopment(suite);
  const plan = selectPlan(data, caseId);
  const snapshotFiles = [...new Set([...codeFiles, datasetPath, sourcePath, ...Object.keys(source.baseFiles)])];
  const runId = randomUUID(), startedAt = new Date().toISOString(), codeBefore = await hashes(snapshotFiles);
  const directory = new URL(".runtime/c1-session/", root); await mkdir(directory, { recursive: true });
  const path = new URL(`live-${suite}-${runId}.json`, directory);
  const guard = requestGuard(plan.maxHttpRequests), rows: Row[] = [], cleanup: Array<{ caseId: string; sessionDisposed: boolean; remainingOrders: number }> = [];
  const { modelRuntime, model } = await createConfiguredModelRuntime();
  assert.equal(model.provider, "deepseek"); assert.equal(model.api, "openai-completions");
  const supportModel = modelRuntime.getModel("deepseek", "deepseek-v4-pro"); assert.ok(supportModel);
  const originalStream = modelRuntime.streamSimple.bind(modelRuntime);
  modelRuntime.streamSimple = (selected, transcript, options) => originalStream(selected, transcript, { ...options, fetch: guard.fetchFor("agent") });
  const rerank = createBailianClient({ retries: 0, timeoutMs: 60_000, fetch: guard.fetchFor("rerank") });
  const support = await createEvidenceSupportClient({ profile: "typed", modelSelection: "deepseek-v4-pro", timeoutMs: 60_000, runtime: { model: supportModel,
    complete: (transcript, options) => modelRuntime.complete(supportModel, transcript, { ...options, fetch: guard.fetchFor("support") }) } });
  assert.equal(support.settings.validationVersion, evidenceSupportValidationVersion);
  const artifact = { version: 4, runId, startedAt, finishedAt: null as string | null, stage: data.stage, suite, suiteId: data.suiteId,
    modelActionSelectionEvaluated: true, finalAnswerQualityEvaluated: false, source,
    selection: { caseId: caseId ?? null, selectedCaseIds: plan.cases.map(item => item.id),
      sourceCases: data.cases.length, sourceTurns: data.cases.reduce((n, item) => n + item.turns.length, 0),
      plannedCases: plan.plannedCases, plannedTurns: plan.plannedTurns },
    scope: "Real Pi Session / DeepSeek action selection and real Bailian rerank / typed support; isolated in-memory synthetic orders and corpus per case; no SQL or QQ.",
    settings: { maxHttpRequests: plan.maxHttpRequests, requestBudgetFormula: "min(70, plannedTurns * 3 + expectedKnowledgeTurns * 2)",
      turnTimeoutMs: 60_000, knowledgeTimeoutMs: 60_000, supportProfile: "typed", supportModel: "deepseek-v4-pro", threshold: .5, knowledgeApplicability: applicability,
      sdkSessionAutomaticRetries: 2, sdkProviderRetries: 0, knowledgeRetries: 0, businessRetries: 0, repairBudget: 1,
      model: { provider: model.provider, id: model.id, api: model.api, maxTokens: Math.min(model.maxTokens, 2048), thinking: "off", cost: model.cost },
      support: support.settings, rerank: rerank.settings },
    corpusHashes: { online: contentHash(context.corpora.online), reference: contentHash(context.corpora.reference) },
    codeHashes: { before: codeBefore, after: {} as Record<string, string> }, codeStable: false,
    rows, requests: guard.requests, cleanup, summary: {} as Record<string, unknown> };
  const save = async () => writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  await save();
  try {
    for (const item of plan.cases) {
      const orders = new Map(Object.keys(context.dataset.orderFixtures).map(key => [context.dataset.orderFixtures[key]!.orderId, fixtureOrder(key, context)]));
      const store = { getOrder: async (identity: Parameters<CouponStore["getOrder"]>[0], id: string) => {
        const owner = Object.values(context.dataset.orderFixtures).find(order => order.orderId === id)?.owner;
        if (identity.appId !== context.dataset.actor.appId || identity.senderId !== owner || !orders.has(id)) throw new OrderAccessError("Controlled fixture ownership denied");
        return structuredClone(orders.get(id)!);
      }, searchKnowledge: async () => { throw new Error("The measured knowledge service must be used"); } } as unknown as CouponStore;
      const knowledge = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(context.corpora[item.corpus]) },
        { mode: "m4-support", supportProfile: "typed", supportModel: "deepseek-v4-pro", applicability, threshold: .5, timeoutMs: 60_000, clients: { rerank, support } });
      const session = await createSupportSession(context.dataset.actor, store, modelRuntime, model, undefined,
        { groupOpenid: `${runId}:${item.id}`, knowledge, repairBudget: 1 });
      let dependencyFailed = false;
      try {
        for (const [index, turn] of item.turns.entries()) {
          const row: Row = { caseId: item.id, turn: index + 1, phase: index === item.turns.length - 1 ? "final" : "preparatory",
            question: turn.question, expected: turn.expect, status: "skipped", durationMs: null, checks: [], steps: [], calls: [], requests: [], sdkRetryEvents: [],
            rawRecall: null, acceptedRecall: null, firstActionCorrect: null,
            businessContractPassed: null, supportIntegrity: null, semanticEvidenceCorrect: null, extraAcceptedIds: [], missingExpectedIds: [] };
          rows.push(row);
          if (dependencyFailed || guard.exhausted || guard.requests.length >= plan.maxHttpRequests) { row.reason = dependencyFailed ? "Required prior turn failed; denominator retained" : "Global request budget reached"; continue; }
          const controller = new AbortController(), capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
          guard.setActive({ caseId: item.id, turn: index + 1, signal: controller.signal });
          prepareSupportPrompt(session, { requestId: `${runId}:${item.id}:${index + 1}`, groupOpenid: `${runId}:${item.id}`,
            messageId: `${runId}:${item.id}:${index + 1}`, onCall: call => row.calls.push(structuredClone(call)) });
          const messagesBefore = session.messages.length, unsubscribe = session.subscribe(event => {
            capture.receive(event);
            if (event.type === "auto_retry_start" || event.type === "auto_retry_end") row.sdkRetryEvents.push({ type: event.type, attempt: event.attempt });
          }), requestStart = guard.requests.length;
          let timedOut = false, failed = false;
          const timer = setTimeout(() => { timedOut = true; controller.abort(); cancelSupportTurn(session); void session.abort().catch(() => {}); }, 60_000);
          try { await session.prompt(turn.question, { expandPromptTemplates: false }); }
          catch { failed = true; }
          finally { clearTimeout(timer); unsubscribe(); controller.abort(); }
          const measured = capture.finish(); row.durationMs = measured.durationMs; row.steps = measured.steps;
          row.requests = structuredClone(guard.requests.slice(requestStart)); row.hostReference = lastHost(session.messages.slice(messagesBefore));
          const result = getSupportResult(session); if (result) row.result = structuredClone(result);
          const finalMessage = session.messages.findLast(message => message.role === "assistant");
          const finalText = finalMessage?.role === "assistant" ? finalMessage.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
          row.reply = supportReply(session, finalText);
          const traces = row.calls.flatMap(call => call.knowledge ? [call.knowledge.trace] : []);
          evaluate(row, !failed && !timedOut && !measured.failed && !row.steps.some(step => step.type === "model" && step.isError)
            && traces.every(trace => trace.status !== "unavailable"), applicability);
          const scopeValid = traces.every(trace => {
            const visible = new Set(scopeDocuments(context.corpora[item.corpus], trace.scope).map(doc => doc.id));
            return trace.acceptance?.accepted.every(doc => visible.has(doc.id)) ?? true;
          });
          row.checks.push({ layer: "knowledge", name: "accepted sources remain inside trusted scope", passed: scopeValid });
          if (!scopeValid) { row.status = "failed"; row.businessContractPassed = false; }
          // Continue only when the actual prior action established its expected
          // host facts and evidence. Never synthesize the missing reference.
          // A usable, validated source may create the real topic even if another
          // candidate was invalid. Continue that business path while retaining
          // the invalid judgment as an incomplete overall result.
          dependencyFailed = row.businessContractPassed !== true;
          console.log(`[c1-session] ${item.id}/${index + 1} ${row.status}; business=${row.businessContractPassed}; integrity=${row.supportIntegrity?.status ?? "not_applicable"}; HTTP=${guard.requests.length}/${plan.maxHttpRequests}`);
          guard.setActive(undefined); await save();
        }
      } finally { cancelSupportTurn(session); await session.abort().catch(() => {}); session.dispose(); orders.clear();
        cleanup.push({ caseId: item.id, sessionDisposed: true, remainingOrders: orders.size }); guard.setActive(undefined); }
    }
  } finally {
    artifact.finishedAt = new Date().toISOString(); artifact.codeHashes.after = await hashes(snapshotFiles);
    artifact.codeStable = same(artifact.codeHashes.before, artifact.codeHashes.after);
    const modelSteps = rows.flatMap(row => row.steps.filter(step => step.type === "model"));
    const traces: KnowledgeTrace[] = rows.flatMap(row => row.calls.flatMap(call => call.knowledge ? [call.knowledge.trace] : []));
    const agentRequests = guard.requests.filter(request => request.operation === "agent").length;
    const agentReported = modelSteps.filter(step => step.usage !== null && step.usage !== undefined);
    const providerCoverage = Object.fromEntries((["rerank", "support"] as const).map(operation => [operation, {
      actualHttpRequests: guard.requests.filter(request => request.operation === operation).length,
      traceCalls: traces.reduce((n, trace) => n + trace.calls.filter(call => call.operation === operation).length, 0),
    }]));
    const knowledgeSum = (field: "rerankTokens" | "supportTokens" | "estimatedCny" | "estimatedUsd") => {
      const coverage = providerCoverage[field === "rerankTokens" || field === "estimatedCny" ? "rerank" : "support"]!;
      return coverage.actualHttpRequests !== coverage.traceCalls || traces.some(trace => trace.usage[field] === null)
        ? null : traces.reduce((n, trace) => n + trace.usage[field]!, 0);
    };
    const layer = (name: Check["layer"]) => ({ checkedTurns: rows.filter(row => row.checks.some(check => check.layer === name)).length,
      passedTurns: rows.filter(row => row.checks.some(check => check.layer === name) && row.checks.filter(check => check.layer === name).every(check => check.passed)).length });
    artifact.summary = { plannedCases: plan.plannedCases, plannedTurns: plan.plannedTurns,
      passedCases: plan.cases.filter(item => rows.filter(row => row.caseId === item.id).length === item.turns.length
        && rows.filter(row => row.caseId === item.id).every(row => row.status === "passed")).length,
      businessContractPassedCases: plan.cases.filter(item => rows.filter(row => row.caseId === item.id).length === item.turns.length
        && rows.filter(row => row.caseId === item.id).every(row => row.businessContractPassed === true)).length,
      businessContractPassedTurns: rows.filter(row => row.businessContractPassed === true).length,
      passedTurns: rows.filter(row => row.status === "passed").length, failedTurns: rows.filter(row => row.status === "failed").length,
      skippedTurns: rows.filter(row => row.status === "skipped").length, missingTurns: plan.plannedTurns - rows.length,
      finalTurns: rows.filter(row => row.phase === "final").map(row => ({ caseId: row.caseId, status: row.status, businessContractPassed: row.businessContractPassed,
        supportIntegrity: row.supportIntegrity?.status ?? null, semanticEvidenceCorrect: row.semanticEvidenceCorrect })),
      layers: Object.fromEntries((["action", "reference", "business", "knowledge", "execution", "integrity"] as const).map(name => [name, layer(name)])),
      firstActionCorrect: rows.filter(row => row.firstActionCorrect === true).length,
      httpRequests: guard.requests.length, agentHttpRequests: agentRequests, modelResponses: modelSteps.length, agentUsageReported: agentReported.length,
      agentTotalTokens: agentReported.length === agentRequests ? agentReported.reduce((n, step) => n + step.usage!.totalTokens, 0) : null,
      agentEstimatedUsd: agentReported.length === agentRequests && agentReported.every(step => step.usage!.estimatedCostUsd !== null)
        ? agentReported.reduce((n, step) => n + step.usage!.estimatedCostUsd!, 0) : null,
      sdkRetryStarts: rows.reduce((n, row) => n + row.sdkRetryEvents.filter(event => event.type === "auto_retry_start").length, 0),
      knowledge: { providerCoverage, rerankTokens: knowledgeSum("rerankTokens"), supportTokens: knowledgeSum("supportTokens"),
        estimatedCny: knowledgeSum("estimatedCny"), estimatedUsd: knowledgeSum("estimatedUsd"), incompleteCalls: traces.reduce((n, trace) => n + trace.usage.incompleteCalls, 0),
        plannedTurns: plan.knowledgeTurns, ...knowledgeCoverage(rows),
        invalidCandidatesKnown: traces.reduce((n, trace) => n + (trace.supportVerification?.validation?.invalidDecisions.length ?? 0), 0),
        semanticCorrectTurns: rows.filter(row => row.semanticEvidenceCorrect === true).length,
        semanticIncorrectTurns: rows.filter(row => row.semanticEvidenceCorrect === false).length,
        semanticUnscoredTurns: rows.filter(row => row.expected.knowledge === "evidence" && row.semanticEvidenceCorrect === null).length,
        extraAcceptedIds: rows.flatMap(row => row.extraAcceptedIds), missingExpectedIds: rows.flatMap(row => row.missingExpectedIds) },
      budgetExhausted: guard.exhausted || guard.requests.length >= plan.maxHttpRequests, cleanupsCompleted: cleanup.length,
      conclusion: "Development evidence only. Business contract satisfaction is separate from complete candidate judgments. Invalid candidates are neither correct rejections nor semantically correct decisions. Partial judgments prevent an overall pass even when usable evidence completes the business action. Final answer quality is not scored." };
    await save();
    console.log(JSON.stringify({ artifact: path.pathname, codeStable: artifact.codeStable, ...artifact.summary }));
  }
  return path.pathname;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.live) await runC1SessionDevelopment(options.caseId, options.applicability, options.suite);
  else await checkC1SessionRunner(options.caseId, options.applicability, options.suite);
}
