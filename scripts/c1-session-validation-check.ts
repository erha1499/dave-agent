import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { contentHash } from "../src/bailian.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import { buildSupportEvidenceBinding, evidenceBindingVersion } from "../src/support-evidence-context.ts";
import { acceptEvidence } from "../src/evidence-acceptance.ts";
import { applyEvidenceSupport, validateEvidenceSupportVerification, evidenceSupportInputHash, evidenceSupportRequestHash,
  evidenceSupportValidationVersion, type EvidenceSupportDecision, type EvidenceSupportSettings, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { amountChoiceTtlMs, compareRemainingAmount, createAmountReference, rememberAmountChoice, resolveAmountReference, type RemainingAmountComparison } from "../src/support-context.ts";
import type { SupportHostReceipt } from "../src/support-session.ts";
import type { SupportCall, SupportKnowledgeContext, SupportResult, TrustedPolicyTopic } from "../src/support-controller.ts";
import { applyKnowledgeApplicabilityGate, finishKnowledgeApplicabilityAcceptance, knowledgeApplicabilitySettings, type KnowledgeTrace } from "../src/knowledge-service.ts";
import { buildKnowledgeApplicabilityContext, gateKnowledgeApplicability, knowledgeApplicabilitySourceHash, validateKnowledgeApplicabilitySnapshot,
  type KnowledgeApplicabilityMode, type KnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { rankLexical, scopeDocuments, type RetrievalDocument, type RetrievalScope } from "../src/retrieval-ranking.ts";
import type { SessionTurnActual } from "./c1-session-live.ts";

// Pure contracts/scoring only. No executor, generated validation questions, I/O or model judge.
export const c1ValidationScoringVersion = "c1-session-validation-v4";
export const c1Families = ["order_state", "paid_amount", "alternative_order", "policy_followup", "refund_time", "appointment_actor"] as const;
export const c1Strata = ["known", "missing", "competing", "direct_missing_fact", "boundary"] as const;
type Family = typeof c1Families[number];
type Stratum = typeof c1Strata[number];
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type ReadKind = Extract<ContextSupportAction["kind"], "order" | "policy" | "refund_eligibility" | "paid_amount_compare" | "clarify">;
export type C1AnswerCriterion = { id: string; kind: "required_fact" | "forbidden_claim" | "condition"; statement: string; basis: string };
export type C1ValidationExpected = {
  allowedKinds: ReadKind[]; outcome: "ready" | "clarification" | "business_denial";
  knowledge: "none" | "evidence" | "rejected"; gold: Array<{ sourceId: string; quote: string }>;
  scope: RetrievalScope; freshOrder: Order | null; deniedOrderId?: string;
  reference?: "previous" | "alternative" | "amount";
  amount?: Pick<RemainingAmountComparison, "couponId" | "remainingUnitPaidCents" | "referencePaidCents" | "comparisonEqual">;
  answerCriteria: C1AnswerCriterion[];
};
export type C1ValidationTurn = { question: string; expected: C1ValidationExpected;
  // An access revocation is after=null. Applied only to the isolated store, never Session state.
  stateChange?: { orderId: string; before: Order; after: Order | null } };
export type C1ValidationCase = { id: string; family: Family | null; stratum: Stratum; corpus: "online" | "reference";
  competingCandidates?: string[]; ambiguityReason?: string; turns: C1ValidationTurn[] };
export type C1ValidationPlan = { version: 1; suiteId: string; validationPolicy: "fixed-validation-not-blind"; cases: C1ValidationCase[] };
export type C1ValidationManifest = { version: 1; frozenBeforeExecution: true; validationPolicy: C1ValidationPlan["validationPolicy"];
  dataset: { path: string; sha256: string; bytes: number }; sourceHashes: Record<string, string>; configurationHash: string;
  corpusHashes: Record<"online" | "reference", string>;
  counts: { cases: number; turns: number; strata: Record<Stratum, number> } };
// requestId is the actual ingress ID supplied to prepareSupportPrompt, not one inferred from a returned result.
export type C1ValidationActual = SessionTurnActual & { caseId: string; turn: number; requestId: string | null; execution: "completed" | "failed" | "not_run";
  // New recordings expose actual ingress; old traces remain replayable without inventing it.
  ingress?: { identity: QQIdentity; groupOpenid: string; messageId: string; requestId: string; observedAt?: string } | null;
  hostReceipt?: SupportHostReceipt };
export type C1ValidationHistory = readonly { question: string; actual: C1ValidationActual }[];
export type C1AnswerReview = { caseId: string; turn: number; reviewer: "codex"; forHumanReview: true; humanAcceptance: false;
  status: "passed" | "failed" | "unreviewed"; replyHash: string; criteriaHash: string;
  checks: Array<{ criterionId: string; passed: boolean; reasoning: string }> };
type Corpora = Record<C1ValidationCase["corpus"], readonly RetrievalDocument[]>;
// Supplied by the frozen run configuration, never inferred from the report being scored.
export type C1ValidationKnowledgeConfiguration = { applicability?: KnowledgeApplicabilityMode; applicabilitySnapshot?: KnowledgeApplicabilitySnapshot;
  // Frozen candidate requirement, independent of a trace's own version label.
  evidenceBindingVersion?: "order-evidence-binding-v2" };
const nonempty = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const equal = isDeepStrictEqual;
const byteHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const countStrata = (plan: C1ValidationPlan) => Object.fromEntries(c1Strata.map(stratum => [stratum, plan.cases.filter(item => item.stratum === stratum).length])) as Record<Stratum, number>;

export function checkC1ValidationPlan(plan: C1ValidationPlan, corpora: Corpora) {
  assert.equal(plan.version, 1); assert.ok(nonempty(plan.suiteId)); assert.equal(plan.validationPolicy, "fixed-validation-not-blind");
  assert.equal(plan.cases.length, 24); assert.equal(new Set(plan.cases.map(item => item.id)).size, 24);
  assert.deepEqual(countStrata(plan), { known: 6, missing: 6, competing: 6, direct_missing_fact: 4, boundary: 2 });
  for (const family of c1Families) for (const stratum of ["known", "missing", "competing"]) {
    assert.equal(plan.cases.filter(item => item.family === family && item.stratum === stratum).length, 1, `${family}/${stratum}`);
  }
  let changes = 0;
  for (const item of plan.cases) {
    assert.ok(nonempty(item.id)); assert.ok(c1Strata.includes(item.stratum)); assert.ok(item.corpus === "online" || item.corpus === "reference");
    assert.equal(item.family === null, ["direct_missing_fact", "boundary"].includes(item.stratum));
    assert.ok(item.turns.length > 0 && item.turns.length <= 8);
    if (item.stratum === "competing") {
      assert.ok(item.competingCandidates && item.competingCandidates.length >= 2 && item.competingCandidates.every(nonempty));
      assert.equal(new Set(item.competingCandidates).size, item.competingCandidates.length); assert.ok(nonempty(item.ambiguityReason));
    }
    for (const [index, turn] of item.turns.entries()) {
      assert.ok(nonempty(turn.question) && turn.question.length <= 500); const e = turn.expected;
      assert.ok(e.allowedKinds.length && e.allowedKinds.every(kind => ["order", "policy", "refund_eligibility", "paid_amount_compare", "clarify"].includes(kind)));
      assert.equal(new Set(e.allowedKinds).size, e.allowedKinds.length); assert.ok([undefined, "previous", "alternative", "amount"].includes(e.reference));
      assert.ok(["ready", "clarification", "business_denial"].includes(e.outcome)); assert.ok(["none", "evidence", "rejected"].includes(e.knowledge));
      assert.equal(new Set(e.gold.map(row => row.sourceId)).size, e.gold.length);
      assert.equal(e.gold.length > 0, e.knowledge === "evidence");
      const visible = scopeDocuments(corpora[item.corpus], e.scope);
      for (const gold of e.gold) assert.ok(nonempty(gold.quote) && visible.find(doc => doc.id === gold.sourceId)?.body.includes(gold.quote), `${item.id}: scoped original quote`);
      assert.ok(e.answerCriteria.length); assert.equal(new Set(e.answerCriteria.map(row => row.id)).size, e.answerCriteria.length);
      for (const criterion of e.answerCriteria) assert.ok(nonempty(criterion.id) && nonempty(criterion.statement) && nonempty(criterion.basis)
        && ["required_fact", "forbidden_claim", "condition"].includes(criterion.kind));
      if (e.freshOrder) { assert.match(e.freshOrder.id, /^COUPON-\d{4}$/); assert.equal(e.freshOrder.source, "demo-database"); }
      if (e.outcome === "business_denial") { assert.match(e.deniedOrderId ?? "", /^COUPON-\d{4}$/); assert.equal(e.freshOrder, null); assert.equal(e.knowledge, "none"); }
      if (e.amount) { assert.equal(e.reference, "amount"); assert.equal(e.knowledge, "none"); assert.ok(e.freshOrder); }
      if (turn.stateChange) {
        changes++; const change = turn.stateChange; assert.ok(index > 0 && item.corpus === "online");
        assert.equal(change.before.id, change.orderId); assert.ok(item.turns.slice(0, index).some(prior => equal(prior.expected.freshOrder, change.before)));
        if (change.after) { assert.equal(change.after.id, change.orderId); assert.ok(!equal(change.before, change.after)); assert.deepEqual(e.freshOrder, change.after); }
        else { assert.equal(e.outcome, "business_denial"); assert.equal(e.deniedOrderId, change.orderId); }
      }
    }
    const final = item.turns.at(-1)!.expected;
    if (item.stratum === "direct_missing_fact") { assert.equal(final.knowledge, "rejected"); assert.ok(final.answerCriteria.some(row => row.kind === "forbidden_claim")); }
    if (item.stratum === "boundary") assert.equal(final.knowledge, "evidence");
    if (item.stratum === "missing" || item.stratum === "competing") { assert.equal(final.outcome, "clarification"); assert.equal(final.knowledge, "none"); }
    if (item.stratum === "known") { assert.equal(final.outcome, "ready"); assert.equal(final.knowledge, item.family === "paid_amount" ? "none" : "evidence"); if (item.family === "paid_amount") assert.ok(final.amount); }
  }
  assert.ok(changes >= 1, "Declare at least one real store state change or access revocation before freezing");
  assert.ok(plan.cases.reduce((sum, item) => sum + item.turns.length, 0) <= 80, "Fixed user-turn budget");
  return { cases: plan.cases.length, turns: plan.cases.reduce((sum, item) => sum + item.turns.length, 0), strata: countStrata(plan) };
}

export function verifyC1ValidationManifest(input: { bytes: Buffer; manifest: C1ValidationManifest; sourceBytes: Record<string, Buffer>; configuration: unknown; corpora: Corpora }) {
  const { manifest } = input;
  assert.equal(manifest.version, 1); assert.equal(manifest.frozenBeforeExecution, true); assert.equal(manifest.validationPolicy, "fixed-validation-not-blind");
  assert.ok(nonempty(manifest.dataset.path)); assert.equal(manifest.dataset.bytes, input.bytes.length); assert.equal(manifest.dataset.sha256, byteHash(input.bytes));
  assert.ok(digest(manifest.configurationHash)); assert.equal(manifest.configurationHash, contentHash(input.configuration));
  for (const corpus of ["online", "reference"] as const) assert.equal(manifest.corpusHashes[corpus], contentHash(input.corpora[corpus]), `${corpus} corpus`);
  assert.ok(Object.keys(manifest.sourceHashes).length); assert.deepEqual(Object.keys(input.sourceBytes).sort(), Object.keys(manifest.sourceHashes).sort());
  for (const [path, hash] of Object.entries(manifest.sourceHashes)) { assert.ok(nonempty(path) && digest(hash)); assert.equal(byteHash(input.sourceBytes[path]!), hash, path); }
  const plan = JSON.parse(input.bytes.toString()) as C1ValidationPlan;
  assert.deepEqual(manifest.counts, checkC1ValidationPlan(plan, input.corpora));
  return plan;
}

function reviewPassed(turn: C1ValidationTurn, actual: C1ValidationActual | undefined, review: C1AnswerReview | undefined) {
  if (!actual || actual.reply === undefined || !review || review.status !== "passed" || review.reviewer !== "codex"
    || review.forHumanReview !== true || review.humanAcceptance !== false || review.caseId !== actual.caseId || review.turn !== actual.turn
    || review.replyHash !== contentHash(actual.reply) || review.criteriaHash !== contentHash(turn.expected.answerCriteria)) return false;
  return review.checks.length === turn.expected.answerCriteria.length && new Set(review.checks.map(row => row.criterionId)).size === review.checks.length
    && turn.expected.answerCriteria.every(criterion => review.checks.some(row => row.criterionId === criterion.id && row.passed === true && nonempty(row.reasoning)));
}

// Rebuild the host binding from actual ingress and completed prior results. The
// recorded context is only compared with this reconstruction, never used as input.
function reconstructKnowledgeBinding(actual: C1ValidationActual, call: SupportCall, corpus: readonly RetrievalDocument[],
  configuration: C1ValidationKnowledgeConfiguration, originalQuery: string | undefined, history: C1ValidationHistory) {
  const { context, trace } = call.knowledge!;
  if (configuration.evidenceBindingVersion) assert.equal(context.evidenceBindingVersion, configuration.evidenceBindingVersion, "Frozen binding version cannot be omitted or downgraded");
  if (!context.evidenceBindingVersion) {
    assert.equal(context.evidenceTarget, undefined); assert.equal(context.evidenceUse, undefined);
    return undefined;
  }
  assert.equal(context.evidenceBindingVersion, evidenceBindingVersion); assert.equal(context.protocol, "v2.2");
  const ingress = actual.ingress, result = actual.result;
  assert.ok(ingress && result && originalQuery !== undefined, "New binding requires actual ingress and the original planned message");
  assert.equal(ingress.requestId, actual.requestId); assert.equal(result.evidence.requestId, ingress.requestId);
  assert.deepEqual(result.evidence.trustedRoute, { groupOpenid: ingress.groupOpenid, messageId: ingress.messageId });
  assert.deepEqual(result.evidence.action, result.action);
  const action = result.action; assert.ok("protocol" in action && action.protocol === "v2.2");
  assert.equal(context.originalQuery, originalQuery); assert.equal(trace.originalQuery, originalQuery);
  assert.equal(context.modelQuestion, "question" in action ? action.question : null);
  const order = result.evidence.order;
  const priorReads = actual.calls.slice(0, actual.calls.indexOf(call)).filter(item => item.name === "get_order" && !item.isError);
  if (order) {
    assert.equal(priorReads.length, 1); const read = priorReads[0]!;
    assert.equal(read.parentSpanId, actual.requestId); assert.equal(read.input.orderId, order.id); assert.deepEqual(read.output, order);
    assert.ok("orderRef" in action && action.orderRef);
    if (action.orderRef.kind === "explicit") { assert.equal(action.orderRef.orderId, order.id); assert.ok(originalQuery.includes(order.id)); }
    else assert.equal(action.orderRef.kind === "alternative" ? actual.hostReference?.alternativeOrderId : actual.hostReference?.orderId, order.id);
    assert.equal(context.orderSource, action.orderRef.kind === "explicit" ? "current_explicit" : action.orderRef.kind === "alternative" ? "verified_alternative" : "verified_focus");
  } else { assert.equal(priorReads.length, 0); assert.equal(context.orderSource, "none"); }
  assert.equal(context.scopeSource, order ? "fresh_order" : "global");
  const scope = { shopId: order?.shop.id ?? null, productId: order?.items[0]?.productId ?? null };
  assert.deepEqual({ shopId: trace.scope.shopId ?? null, productId: trace.scope.productId ?? null }, scope);
  const sourceKey = merchantSourceKey(ingress.identity, ingress.groupOpenid);
  let topic: TrustedPolicyTopic | null = null;
  if ("questionContext" in action && action.questionContext.kind === "previous") {
    const referencedRequestId = action.questionContext.requestId;
    assert.equal(actual.hostReference?.policyTopic?.requestId, referencedRequestId);
    const donors = history.filter(row => row.actual.caseId === actual.caseId && row.actual.turn < actual.turn && row.actual.requestId === referencedRequestId);
    assert.equal(donors.length, 1, "Previous topic must come from one actual earlier Session turn");
    const donor = donors[0]!, previous = donor.actual, previousResult = previous.result;
    assert.ok(previous.execution === "completed" && previousResult?.outcome === "ready" && previousResult.verifiedPolicyTopic && previous.ingress);
    assert.deepEqual(previous.ingress.identity, ingress.identity); assert.equal(previous.ingress.groupOpenid, ingress.groupOpenid);
    assert.ok(knowledgeProofPassed(previous, corpus, configuration, donor.question, history.filter(row => row.actual.turn < previous.turn)), "Prior sources must themselves have a valid recorded proof");
    topic = previousResult.verifiedPolicyTopic;
    assert.equal(topic.requestId, previous.requestId); assert.equal(topic.sourceKey, sourceKey); assert.equal(topic.groupOpenid, ingress.groupOpenid);
    assert.ok(previousResult.action.kind === "policy" || previousResult.action.kind === "refund_eligibility");
    assert.equal(topic.intent, previousResult.action.kind); assert.equal(topic.orderId, previousResult.evidence.order?.id ?? null);
    assert.deepEqual(topic.scope, { shopId: previousResult.evidence.order?.shop.id ?? null, productId: previousResult.evidence.order?.items[0]?.productId ?? null });
    const previousContext = previousResult.evidence.knowledge[0]?.context;
    assert.ok(previousContext && previousResult.evidence.rules.length > 0);
    const priorIsAlternative = previousResult.action.orderRef?.kind === "alternative";
    assert.equal(topic.originalQuery, priorIsAlternative ? donor.question : previousContext.policyTopic?.originalQuery ?? donor.question);
    assert.deepEqual(topic.sources, previousResult.evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })));
    if (action.orderRef?.kind === "alternative") {
      assert.equal(topic.orderId, actual.hostReference?.orderId, "Alternative-order intent belongs to the actual prior focus");
      assert.notEqual(topic.orderId, order?.id);
    } else assert.deepEqual(topic.scope, scope);
  }
  assert.deepEqual(context.policyTopic, topic);
  const reconstructed = buildSupportEvidenceBinding({ action, originalQuery, order, requestId: ingress.requestId, verifiedTopic: topic,
    binding: { sourceKey, groupOpenid: ingress.groupOpenid, orderId: order?.id ?? null } });
  for (const key of ["evidenceBindingVersion", "evidenceTarget", "evidenceUse", "purpose", "facts", "effectiveQuery"] as const) assert.deepEqual(context[key], reconstructed[key], `Rebuilt ${key}`);
  assert.deepEqual(context.applicability ?? null, reconstructed.applicability ?? null);
  return reconstructed;
}

function prepareKnowledgeEvidence(actual: C1ValidationActual, call: SupportCall, documents: readonly RetrievalDocument[], configuration: C1ValidationKnowledgeConfiguration,
  originalQuery?: string, history: C1ValidationHistory = [], corpus: readonly RetrievalDocument[] = documents) {
  const { trace, context } = call.knowledge!;
  const binding = reconstructKnowledgeBinding(actual, call, corpus, configuration, originalQuery, history);
  let prepared = acceptEvidence({ query: trace.query, scope: trace.scope, documents, ranking: trace.rawRanking,
    config: trace.mode === "lexical" ? { mode: "off" } : { mode: "support", threshold: trace.threshold! } });
  const mode = configuration.applicability ?? "model_only";
  assert.equal(trace.applicability?.mode ?? "model_only", mode);
  if (mode === "model_only") {
    assert.equal(trace.applicability?.gate, undefined); assert.equal(trace.settings?.applicability, undefined);
    return { prepared, gate: undefined };
  }
  assert.equal(mode, "declared"); assert.equal(trace.mode, "m4-support");
  const snapshot = configuration.applicabilitySnapshot;
  assert.ok(snapshot, "Declared mode requires an externally frozen metadata snapshot");
  const { sha256, ...manifest } = snapshot;
  const frozen = validateKnowledgeApplicabilitySnapshot(manifest, sha256);
  let trustedContext = binding?.applicability ?? null;
  assert.equal(context.protocol, "v2.2", "Declared validation requires the frozen current host protocol");
  if (!binding && context.protocol === "v2.2") {
    const action = actual.result!.action;
    assert.ok("protocol" in action && action.protocol === "v2.2");
    const purpose = action.kind === "refund_eligibility" ? "refund_eligibility"
      : action.kind === "merchant_prepare" || action.kind === "refund_prepare" ? "business_prerequisite" : "user_policy";
    assert.equal(context.purpose, purpose, "Current-object classification cannot bypass declared applicability");
    if (purpose !== "user_policy") {
      const order = actual.result?.evidence.order;
      assert.ok(order && actual.requestId);
      assert.ok(actual.calls.slice(0, actual.calls.indexOf(call)).some(prior => prior.name === "get_order" && !prior.isError
        && prior.parentSpanId === actual.requestId && prior.input.orderId === order.id && equal(prior.output, order)), "Fresh authorized facts must precede the knowledge call");
      trustedContext = buildKnowledgeApplicabilityContext({ order, requestId: actual.requestId, purpose });
    }
  } else if (!binding) assert.ok(!actual.result || !("protocol" in actual.result.action), "Current protocol cannot omit its host context version");
  assert.deepEqual(context.applicability ?? null, trustedContext);
  const gate = gateKnowledgeApplicability({ snapshot: frozen, context: trustedContext, scope: trace.scope, candidates: prepared.pendingSupport ?? [] });
  const { candidates: _candidates, ...audit } = gate;
  assert.deepEqual(trace.applicability?.gate, audit);
  assert.deepEqual(trace.settings?.applicability, knowledgeApplicabilitySettings(frozen));
  prepared = applyKnowledgeApplicabilityGate(prepared, gate);
  return { prepared, gate };
}

// Reuse the production acceptance/binding checks against the frozen corpus; IDs alone are not evidence.
function knowledgeProofPassed(actual: C1ValidationActual | undefined, corpus: readonly RetrievalDocument[], configuration: C1ValidationKnowledgeConfiguration = {},
  originalQuery?: string, history: C1ValidationHistory = []): boolean {
  if (!actual) return false;
  try {
    const result = actual.result, calls = actual.calls, knowledgeCalls = calls.filter(call => call.knowledge);
    if (new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => call.name === "search_faq" && !call.knowledge)) return false;
    if (!result) return knowledgeCalls.length === 0;
    if (!equal(calls, result.evidence.actualCalls) || !equal(knowledgeCalls.map(call => ({ callId: call.id, ...call.knowledge! })), result.evidence.knowledge)) return false;
    const rules: SupportResult["evidence"]["rules"] = [];
    for (const call of knowledgeCalls) {
      const { context, trace } = call.knowledge!;
      if (call.name !== "search_faq" || call.isError || trace.status === "unavailable" || trace.reason !== null
        || call.input.query !== trace.query || context.effectiveQuery !== trace.query || context.originalQuery !== trace.originalQuery
        || !equal({ shopId: call.input.shopId ?? null, productId: call.input.productId ?? null },
          { shopId: trace.scope.shopId ?? null, productId: trace.scope.productId ?? null })) return false;
      const documents = scopeDocuments(corpus, trace.scope), sourceHash = contentHash(documents);
      if (trace.sourceHashes.before !== sourceHash || trace.sourceHashes.after !== sourceHash) return false;
      if (trace.mode !== "lexical" && trace.mode !== "m4-support") return false;
      if (trace.mode === "lexical" && !equal(trace.rawRanking, rankLexical(trace.query, documents, trace.scope).map(id => ({ id, score: null })))) return false;
      if (trace.mode === "m4-support" && (trace.rawRanking.length !== documents.length || new Set(trace.rawRanking.map(row => row.id)).size !== documents.length
        || trace.rawRanking.some((row, index) => !documents.some(doc => doc.id === row.id) || typeof row.score !== "number" || !Number.isFinite(row.score)
          || row.score < 0 || row.score > 1 || index > 0 && row.score > trace.rawRanking[index - 1]!.score!))) return false;
      const { prepared, gate } = prepareKnowledgeEvidence(actual, call, documents, configuration, originalQuery, history, corpus);
      let acceptance = prepared;
      const supportCalls = trace.calls.filter(item => item.operation === "support");
      if (prepared.pendingSupport?.length) {
        const settings = trace.settings?.support, verification = trace.supportVerification;
        if (!settings || !verification || !validateEvidenceSupportVerification(verification,
          { query: trace.query, scope: trace.scope, candidates: prepared.pendingSupport, settings })) return false;
        if (supportCalls.length !== 1 || supportCalls[0]!.requestHash !== verification.requestHash
          || !equal(supportCalls[0]!.attempts, verification.attempts)
          || supportCalls[0]!.status !== (verification.validation?.status === "partial" ? "partial" : verification.validation?.status === "unavailable" ? "unavailable" : "ok")) return false;
        acceptance = applyEvidenceSupport({ prepared, verification, query: trace.query, scope: trace.scope, documents, settings });
      } else if (trace.supportVerification || supportCalls.length) return false;
      acceptance = finishKnowledgeApplicabilityAcceptance(acceptance, gate);
      if (!equal(trace.acceptance, acceptance) || trace.status !== acceptance.status) return false;
      const output = acceptance.accepted.map(entry => {
        const doc = documents.find(item => item.id === entry.id)!;
        return { source: "demo-knowledge" as const, sourceId: doc.id, title: doc.title, body: doc.body,
          scope: { shopId: doc.shopId, productId: doc.productId ?? null } };
      });
      if (!equal(call.output, output) || !equal(trace.sources, output.map(doc => ({ sourceId: doc.sourceId, version: contentHash(doc) })))) return false;
      for (const doc of output) if (!rules.some(rule => rule.sourceId === doc.sourceId)) rules.push({ ...doc, version: contentHash(doc) });
    }
    return equal(result.evidence.rules, rules);
  } catch { return false; }
}

function amountProofPassed(actual: C1ValidationActual | undefined, originalQuery: string, history: C1ValidationHistory, configuration: C1ValidationKnowledgeConfiguration) {
  const result = actual?.result;
  if (!result?.evidence.amountComparison || !configuration.evidenceBindingVersion && !result.evidence.amountChoices) return true;
  try {
    assert.ok(actual?.ingress && result.action.kind === "paid_amount_compare" && result.evidence.order);
    const ingress = actual.ingress, order = result.evidence.order, choices = result.evidence.amountChoices;
    assert.equal(ingress.requestId, actual.requestId); assert.deepEqual(result.evidence.trustedRoute, { groupOpenid: ingress.groupOpenid, messageId: ingress.messageId });
    if (result.action.orderRef.kind === "explicit") { assert.equal(result.action.orderRef.orderId, order.id); assert.ok(originalQuery.includes(order.id)); }
    else assert.equal(actual.hostReference?.orderId, order.id);
    const binding = { sourceKey: merchantSourceKey(ingress.identity, ingress.groupOpenid), groupOpenid: ingress.groupOpenid };
    const read = actual.calls.find(call => call.name === "get_order" && !call.isError && call.parentSpanId === actual.requestId && equal(call.output, order));
    assert.ok(read && read.input.orderId === order.id && Number.isFinite(Date.parse(read.observedAt)) && choices);
    // Replays use the recorded observation time, never today's wall clock.
    const reference = resolveAmountReference(choices, binding, Date.parse(read.observedAt));
    assert.ok(reference, "Competing amounts require a real user selection; latest is not unique");
    assert.equal(result.action.amountRef.requestId, reference.requestId); assert.equal(actual.hostReference?.itemPaidUnit?.requestId, reference.requestId);
    for (const candidate of choices.candidates) {
      const donors: C1ValidationHistory = history.filter(row => row.actual.caseId === actual.caseId && row.actual.turn < actual.turn && row.actual.requestId === candidate.reference.requestId);
      assert.equal(donors.length, 1); const donor = donors[0]!.actual, previous = donor.result;
      assert.ok(donor.execution === "completed" && donor.ingress && previous?.outcome === "ready" && previous.needsAnswer === false
        && previous.reply.kind === "order" && previous.evidence.order);
      const visibleReply = previous.evidence.knowledge.some(entry => entry.context.evidenceUse === "explanation")
        ? { ...previous.reply, text: "以下仅解释所问条件，不表示当前订单已满足，也不构成退款批准。\n" + previous.reply.text } : previous.reply;
      assert.deepEqual(donor.reply, visibleReply, "A tool result alone does not establish an actually delivered paid-unit display");
      assert.deepEqual(donor.ingress.identity, ingress.identity); assert.equal(donor.ingress.groupOpenid, ingress.groupOpenid);
      assert.equal(donor.ingress.requestId, donor.requestId); assert.equal(previous.evidence.requestId, donor.requestId);
      assert.deepEqual(previous.evidence.trustedRoute, { groupOpenid: donor.ingress.groupOpenid, messageId: donor.ingress.messageId });
      assert.ok(donor.calls.some(call => call.name === "get_order" && !call.isError && call.parentSpanId === donor.requestId
        && call.input.orderId === previous.evidence.order!.id && equal(call.output, previous.evidence.order)));
      const rebuilt = createAmountReference(previous.evidence.order, binding, donor.requestId!);
      assert.deepEqual(previous.verifiedAmountReference, rebuilt); assert.deepEqual(previous.evidence.displayedPaidUnit, rebuilt);
      assert.deepEqual(candidate.reference, rebuilt);
      const displayedAt = Date.parse(donor.ingress.observedAt ?? "");
      assert.ok(Number.isFinite(displayedAt) && donor.durationMs !== null && Number.isFinite(donor.durationMs) && donor.durationMs >= 0);
      assert.ok(candidate.expiresAt >= displayedAt + amountChoiceTtlMs && candidate.expiresAt <= displayedAt + donor.durationMs + amountChoiceTtlMs,
        "Recorded expiry must originate within the actual display turn's TTL window");
    }
    if (choices.selectedToken) {
      assert.equal(actual.hostReference?.orderId, order.id, "Changing an explicit target cannot preserve an old selection");
      const selections = history.filter(row => row.actual.caseId === actual.caseId && row.actual.turn < actual.turn && row.actual.hostReceipt?.outcome === "selected"
        && row.actual.hostReceipt.choices.selectedToken === choices.selectedToken);
      const selected = selections.at(-1); assert.ok(selected?.actual.ingress, "Selected token needs a real host receipt");
      const receipt = selected.actual.hostReceipt!;
      assert.equal(selected.question.trim(), `选择金额基准 ${choices.selectedToken}`); assert.equal(selected.actual.execution, "completed");
      assert.equal(selected.actual.result, undefined); assert.deepEqual(selected.actual.calls, []); assert.deepEqual(selected.actual.requests, []);
      assert.equal(receipt.version, "amount-selection-v1"); assert.notEqual(receipt.historyFailed, true); assert.equal(receipt.requestId, selected.actual.requestId);
      assert.equal(selected.actual.ingress.requestId, receipt.requestId); assert.deepEqual(selected.actual.ingress.identity, ingress.identity);
      assert.equal(receipt.sourceKey, binding.sourceKey); assert.deepEqual(receipt.trustedRoute, { groupOpenid: ingress.groupOpenid, messageId: selected.actual.ingress.messageId });
      assert.deepEqual(selected.actual.reply, receipt.reply); assert.equal(receipt.selectedRequestId, reference.requestId);
      assert.deepEqual(receipt.choices.candidates.find(row => row.token === choices.selectedToken), choices.candidates.find(row => row.token === choices.selectedToken));
      assert.ok(!history.some(row => row.actual.turn > selected.actual.turn && row.actual.turn < actual.turn
        && (row.actual.result?.verifiedAmountReference || row.actual.hostReceipt)), "New displays or later selection receipts invalidate an earlier explicit selection");
    }
    assert.deepEqual(result.evidence.amountComparison, compareRemainingAmount(order, reference, binding));
    return true;
  } catch { return false; }
}

export function scoreC1ValidationTurn(turn: C1ValidationTurn, actual: C1ValidationActual | undefined, corpus: readonly RetrievalDocument[], review?: C1AnswerReview,
  configuration: C1ValidationKnowledgeConfiguration = {}, history: C1ValidationHistory = []) {
  const e = turn.expected, result = actual?.result, calls = actual?.calls ?? [], host = actual?.hostReference;
  const traces = calls.flatMap(call => call.knowledge ? [call.knowledge.trace] : []);
  const bound = Boolean(actual && nonempty(actual.requestId) && (!result || result.evidence.requestId === actual.requestId)
    && calls.every(call => call.parentSpanId === actual.requestId));
  const complete = actual?.execution === "completed" && bound && actual.durationMs !== null && Number.isFinite(actual.durationMs)
    && actual.durationMs >= 0 && !actual.steps.some(step => step.type === "model" && step.isError) && traces.every(trace => trace.status !== "unavailable");
  const accepted = [...new Set([...(result?.evidence.rules.map(row => row.sourceId) ?? []), ...traces.flatMap(trace => trace.acceptance?.accepted.map(row => row.id) ?? [])])];
  const gold = e.gold.map(row => row.sourceId), extra = accepted.filter(id => !gold.includes(id));
  const raw = traces.at(-1)?.rawRanking.slice(0, 5).map(row => row.id) ?? [];
  const invalid = traces.flatMap(trace => trace.supportVerification?.validation?.invalidDecisions.map(row => row.id) ?? []);
  const validDecisions = calls.flatMap(call => {
    if (!call.knowledge || !actual) return [];
    const trace = call.knowledge.trace;
    try {
      const settings = trace.settings?.support, verification = trace.supportVerification;
      const { prepared } = prepareKnowledgeEvidence(actual, call, scopeDocuments(corpus, trace.scope), configuration, turn.question, history, corpus);
      return settings && verification && validateEvidenceSupportVerification(verification,
        { query: trace.query, scope: trace.scope, candidates: prepared.pendingSupport ?? [], settings }) ? verification.value : [];
    } catch { return []; }
  });
  const unavailable = !complete || traces.some(trace => trace.supportFailure || trace.status === "unavailable");
  const evidenceProofPassed = knowledgeProofPassed(actual, corpus, configuration, turn.question, history);
  const applicabilityGates = calls.flatMap(call => {
    if (!call.knowledge || !actual) return [];
    try {
      const { gate } = prepareKnowledgeEvidence(actual, call, scopeDocuments(corpus, call.knowledge.trace.scope), configuration, turn.question, history, corpus);
      return gate ? [gate] : [];
    } catch { return []; }
  });
  const applicabilityDecisions = applicabilityGates.flatMap(gate => gate.decisions);
  const applicabilityDeclared = (configuration.applicability ?? "model_only") === "declared";
  const applicabilityIntegrityPassed = evidenceProofPassed && (!applicabilityDeclared || applicabilityGates.length === traces.length && applicabilityGates.every(gate => gate.integrity));
  const visible = new Set(scopeDocuments(corpus, e.scope).map(doc => doc.id));
  const scopeViolations = accepted.filter(id => !visible.has(id));
  const scoped = traces.every(trace => equal({ shopId: trace.scope.shopId ?? null, productId: trace.scope.productId ?? null },
    { shopId: e.scope.shopId ?? null, productId: e.scope.productId ?? null }) && trace.originalQuery === turn.question);
  const freshCalls = calls.filter(call => call.name === "get_order" && !call.isError);
  const fresh = e.freshOrder ? Boolean(e.outcome === "clarification" && !calls.some(call => call.name === "get_order") && !result?.evidence.order
    || result && equal(result.evidence.order, e.freshOrder) && freshCalls.some(call => call.parentSpanId === actual?.requestId
    && call.input.orderId === e.freshOrder!.id && equal(call.output, result.evidence.order)))
    : e.deniedOrderId ? freshCalls.length === 0 && calls.some(call => call.name === "get_order" && call.input.orderId === e.deniedOrderId && call.isError && call.errorKind === "business_denial")
    : !calls.some(call => call.name === "get_order");
  let reference = true;
  if (e.reference === "previous") reference = Boolean(result && "questionContext" in result.action && result.action.questionContext.kind === "previous"
    && host?.policyTopic?.requestId && result.action.questionContext.requestId === host.policyTopic.requestId
    && result.evidence.knowledge[0]?.context.policyTopic?.requestId === host.policyTopic.requestId);
  if (e.reference === "alternative") reference = Boolean(result && "orderRef" in result.action && result.action.orderRef?.kind === "alternative"
    && e.freshOrder && host?.alternativeOrderId === e.freshOrder.id && result.evidence.order?.id === e.freshOrder.id);
  if (e.reference === "amount") reference = Boolean(result?.action.kind === "paid_amount_compare" && host?.itemPaidUnit?.requestId
    && result.action.amountRef.requestId === host.itemPaidUnit.requestId && result.evidence.amountComparison?.referenceRequestId === host.itemPaidUnit.requestId);
  const noSideEffects = calls.every(call => ["get_order", "search_faq"].includes(call.name));
  const outcome = e.outcome === "business_denial" ? !result && calls.some(call => call.isError && call.errorKind === "business_denial") : result?.outcome === e.outcome;
  const actionCorrect = Boolean(result && e.allowedKinds.includes(result.action.kind as ReadKind) && reference);
  const first = actual?.steps.find(step => step.type === "tool" && step.name === "support_action")?.input as { action?: { kind?: ReadKind } } | undefined;
  const firstActionKindCorrect = Boolean(first?.action?.kind && e.allowedKinds.includes(first.action.kind));
  const noKnowledge = traces.length === 0 && !calls.some(call => call.name === "search_faq") && actual?.requests.every(request => request.operation === "agent");
  const knowledge = e.knowledge === "none" ? Boolean(noKnowledge && !accepted.length)
    : e.knowledge === "rejected" ? evidenceProofPassed && traces.length === 1 && traces[0]!.status === "rejected" && !accepted.length && !invalid.length && !unavailable
    : evidenceProofPassed && traces.length === 1 && !unavailable && accepted.some(id => gold.includes(id)) && !extra.length;
  const amountEvidenceProofPassed = amountProofPassed(actual, turn.question, history, configuration);
  const amount = amountEvidenceProofPassed && (!e.amount || Boolean(result?.evidence.amountComparison && result.evidence.amountComparison.remainingCouponCount === 1
    && result.evidence.amountComparison.refundApproved === false && result.needsAnswer === false && noKnowledge
    && Object.entries(e.amount).every(([key, value]) => equal(result.evidence.amountComparison![key as keyof RemainingAmountComparison], value))));
  // Host-safe refusal and model classification are different measures.
  const actionGate = e.outcome === "clarification" || e.outcome === "business_denial" ? true : actionCorrect;
  const engineeringPassed = Boolean(complete && evidenceProofPassed && outcome && actionGate && fresh && noSideEffects && scoped && !scopeViolations.length && amount);
  const answerPassed = reviewPassed(turn, actual, review);
  const supportIntegrityPassed = !unavailable && evidenceProofPassed && invalid.length === 0;
  return { engineeringPassed, knowledgePassed: knowledge, supportIntegrityPassed, applicabilityIntegrityPassed,
    semanticEvidenceCorrect: supportIntegrityPassed && applicabilityIntegrityPassed ? knowledge : null,
    answerPassed, passed: engineeringPassed && knowledge && supportIntegrityPassed && applicabilityIntegrityPassed && answerPassed,
    actionCorrect, firstActionKindCorrect, safeStopped: engineeringPassed && e.outcome !== "ready" && knowledge,
    observedStop: result?.action.kind === "clarify" ? "model_clarify" : outcome && e.outcome !== "ready" ? "host_denial" : null,
    fresh, reference, amount, amountEvidenceProofPassed, requestBound: bound, evidenceProofPassed, scopeMatched: scoped, extraAcceptedIds: extra, scopeViolationIds: scopeViolations, invalidDecisionIds: invalid,
    applicabilityExcludedIds: applicabilityDecisions.filter(row => row.status === "mismatched").map(row => row.id),
    applicabilityUnknownIds: applicabilityDecisions.filter(row => row.status === "unknown").map(row => row.id),
    applicabilityUncheckedIds: applicabilityDecisions.filter(row => row.status === "not_checked").map(row => row.id),
    applicabilityNoneDeclaredIds: applicabilityDecisions.filter(row => row.status === "none_declared").map(row => row.id),
    applicabilityDeclared, applicabilityRecorded: traces.some(trace => trace.applicability?.mode === "declared"),
    validDecisionCount: validDecisions.length, validUnsupportedIds: validDecisions.filter(row => !row.supported).map(row => row.id),
    unavailable, correctlyRejected: e.knowledge === "rejected" && knowledge, rawHasGold: raw.some(id => gold.includes(id)),
    rawRecall: gold.length ? actual?.execution === "completed" ? gold.filter(id => raw.includes(id)).length / gold.length : 0 : null,
    acceptedRecall: gold.length ? complete && evidenceProofPassed ? gold.filter(id => accepted.includes(id)).length / gold.length : 0 : null,
    missingGold: gold.filter(id => !accepted.includes(id)), reviewStatus: review?.status ?? "unreviewed" };
}

export function summarizeC1Validation(plan: C1ValidationPlan, actuals: C1ValidationActual[], corpora: Corpora, reviews: C1AnswerReview[] = [],
  configuration: C1ValidationKnowledgeConfiguration = {}) {
  checkC1ValidationPlan(plan, corpora);
  const key = (row: { caseId: string; turn: number }) => `${row.caseId}:${row.turn}`;
  const planned = new Set(plan.cases.flatMap(item => item.turns.map((_, index) => `${item.id}:${index + 1}`)));
  for (const records of [actuals, reviews]) { assert.equal(new Set(records.map(key)).size, records.length); assert.ok(records.every(row => planned.has(key(row)))); }
  const rows = plan.cases.flatMap(item => item.turns.map((turn, index) => {
    const actual = actuals.find(row => row.caseId === item.id && row.turn === index + 1);
    const history = actuals.filter(row => row.caseId === item.id && row.turn < index + 1).map(row => ({ question: item.turns[row.turn - 1]!.question, actual: row }));
    const score = scoreC1ValidationTurn(turn, actual, corpora[item.corpus], reviews.find(row => row.caseId === item.id && row.turn === index + 1), configuration, history);
    const prior = actuals.filter(row => row.caseId === item.id && row.turn < index + 1 && row.execution === "completed");
    let stateChangePassed = true;
    if (turn.stateChange) {
      const beforeSeen = prior.some(row => row.result?.evidence.requestId === row.requestId && row.calls.some(call => call.name === "get_order" && !call.isError
        && call.parentSpanId === row.requestId && equal(call.output, turn.stateChange!.before)));
      stateChangePassed = beforeSeen && score.fresh;
    }
    // Host references must originate in an actual completed earlier turn in the same Session.
    let referenceProvenancePassed = true;
    if (turn.expected.reference === "previous") referenceProvenancePassed = prior.some(row => {
      const topic = row.result?.verifiedPolicyTopic, current = actual?.result?.evidence.knowledge[0]?.context.policyTopic;
      return Boolean(topic && row.requestId === actual?.hostReference?.policyTopic?.requestId && topic.requestId === row.requestId
        && row.result!.outcome === "ready" && row.result!.evidence.rules.length > 0 && knowledgeProofPassed(row, corpora[item.corpus], configuration, item.turns[row.turn - 1]!.question, history.filter(entry => entry.actual.turn < row.turn))
        && equal(topic.sources, row.result!.evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })))
        && topic.groupOpenid === row.result!.evidence.trustedRoute.groupOpenid && topic.groupOpenid === actual?.result?.evidence.trustedRoute.groupOpenid
        && equal(current, topic));
    });
    if (turn.expected.reference === "amount") referenceProvenancePassed = prior.some(row => row.requestId === actual?.hostReference?.itemPaidUnit?.requestId
      && row.result?.verifiedAmountReference?.requestId === row.requestId && row.result.evidence.displayedPaidUnit?.requestId === row.requestId);
    if (turn.expected.reference === "alternative") referenceProvenancePassed = prior.some(row => row.result?.evidence.order?.id === turn.expected.freshOrder?.id
      && row.calls.some(call => call.name === "get_order" && !call.isError && call.parentSpanId === row.requestId && equal(call.output, row.result?.evidence.order)));
    return { caseId: item.id, turn: index + 1, stratum: item.stratum, family: item.family, final: index === item.turns.length - 1,
      knowledge: turn.expected.knowledge, execution: actual?.execution ?? "not_run", ...score, stateChangePassed, referenceProvenancePassed,
      passed: score.passed && stateChangePassed && referenceProvenancePassed };
  }));
  const finals = rows.filter(row => row.final), answerable = finals.filter(row => row.knowledge === "evidence"), rawHasGold = answerable.filter(row => row.rawHasGold);
  const casePassed = (id: string) => rows.filter(row => row.caseId === id).every(row => row.passed);
  return { scoringVersion: c1ValidationScoringVersion, plannedCases: plan.cases.length, plannedTurns: rows.length,
    completedTurns: rows.filter(row => row.execution === "completed").length, passedCases: plan.cases.filter(item => casePassed(item.id)).length,
    strata: Object.fromEntries(c1Strata.map(stratum => [stratum, { planned: finals.filter(row => row.stratum === stratum).length,
      passed: finals.filter(row => row.stratum === stratum && casePassed(row.caseId)).length }])),
    contextStops: Object.fromEntries((["missing", "competing"] as const).map(stratum => [stratum, {
      planned: 6, safe: finals.filter(row => row.stratum === stratum && row.safeStopped).length,
      modelClarify: finals.filter(row => row.stratum === stratum && row.safeStopped && row.observedStop === "model_clarify").length,
      hostDenial: finals.filter(row => row.stratum === stratum && row.safeStopped && row.observedStop === "host_denial").length }])),
    coreEngineering: { planned: 6, passed: finals.filter(row => row.stratum === "known" && row.engineeringPassed && row.stateChangePassed && row.referenceProvenancePassed
      && rows.filter(prior => prior.caseId === row.caseId && !prior.final).every(prior => prior.engineeringPassed && prior.knowledgePassed
        && prior.supportIntegrityPassed && prior.applicabilityIntegrityPassed && prior.stateChangePassed && prior.referenceProvenancePassed)).length },
    knowledgeTargets: { planned: answerable.length, withoutEvidence: answerable.filter(row => !row.acceptedRecall).length },
    rawRecall: answerable.reduce((sum, row) => sum + (row.rawRecall ?? 0), 0) / answerable.length,
    acceptedRecall: answerable.reduce((sum, row) => sum + (row.acceptedRecall ?? 0), 0) / answerable.length,
    falseRejection: { denominator: rawHasGold.length, count: rawHasGold.filter(row => row.acceptedRecall === 0).length },
    directMissing: { planned: 4, correctRejections: finals.filter(row => row.stratum === "direct_missing_fact" && row.correctlyRejected).length,
      falseAccepts: finals.filter(row => row.stratum === "direct_missing_fact" && row.extraAcceptedIds.length).length },
    extraEvidenceTurns: rows.filter(row => row.extraAcceptedIds.length).length, invalidDecisionTurns: rows.filter(row => row.invalidDecisionIds.length).length,
    supportDecisions: { valid: rows.reduce((sum, row) => sum + row.validDecisionCount, 0),
      validUnsupported: rows.reduce((sum, row) => sum + row.validUnsupportedIds.length, 0), invalid: rows.reduce((sum, row) => sum + row.invalidDecisionIds.length, 0) },
    applicability: { recordedTurns: rows.filter(row => row.applicabilityRecorded).length,
      incompleteTurns: rows.filter(row => row.applicabilityRecorded && !row.applicabilityIntegrityPassed).length,
      excluded: rows.reduce((sum, row) => sum + row.applicabilityExcludedIds.length, 0), unknown: rows.reduce((sum, row) => sum + row.applicabilityUnknownIds.length, 0),
      notChecked: rows.reduce((sum, row) => sum + row.applicabilityUncheckedIds.length, 0), noneDeclared: rows.reduce((sum, row) => sum + row.applicabilityNoneDeclaredIds.length, 0) },
    scopeViolationTurns: rows.filter(row => row.scopeViolationIds.length || !row.scopeMatched).length, unavailableTurns: rows.filter(row => row.unavailable).length,
    evidenceProofFailedTurns: rows.filter(row => !row.evidenceProofPassed).length,
    unreviewedReplies: rows.filter(row => !row.answerPassed && row.reviewStatus === "unreviewed").length,
    reviewMethod: "Codex per-case review for human verification; not human acceptance or an online LLM judge",
    runIntegrityStillRequired: "Caller must verify frozen source/config hashes, budgets, usage coverage and code stability before admission", rows };
}

export function checkC1ValidationScoring() {
  const doc = { id: "unit-source", title: "unit", body: "unit fact", tags: [], shopId: null, productId: null };
  const turn: C1ValidationTurn = { question: "unit input, not a validation question", expected: { allowedKinds: ["policy"], outcome: "ready", knowledge: "rejected", gold: [],
    scope: {}, freshOrder: null, answerCriteria: [{ id: "no-fabrication", kind: "forbidden_claim", statement: "Do not invent a fact", basis: "unit corpus" }] } };
  const trace: KnowledgeTrace = { mode: "m4-support", threshold: .5, query: turn.question, originalQuery: turn.question, scope: {}, status: "rejected", reason: null,
    rawRanking: [{ id: doc.id, score: .9 }], acceptance: { version: "score-support-v1", config: { mode: "support", threshold: .5 }, status: "rejected", accepted: [],
      rejected: [{ id: doc.id, rank: 1, reason: "unsupported" }], diagnostics: { topScore: .9, scoreGap: null, candidates: [] } },
    sourceHashes: { before: contentHash([doc]), after: contentHash([doc]) }, durationMs: 1, calls: [],
    usage: { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
    pricing: { estimated: true, rerankCnyPerMillionTokens: .5, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" } };
  const context: SupportKnowledgeContext = { originalQuery: turn.question, modelQuestion: turn.question, effectiveQuery: turn.question,
    purpose: "user_policy", orderSource: "none", scopeSource: "global", facts: null, policyTopic: null, objectReference: null, protocol: "v2.2" };
  const call: SupportCall = { id: "unit-call", parentSpanId: "unit-request", actor: "host", trigger: "user", component: "support-controller",
    name: "search_faq", input: { query: turn.question }, isError: false, observedAt: "2026-10-06T00:00:00.000Z", durationMs: 1, knowledge: { context, trace } };
  const action: ContextSupportAction = { protocol: "v2.2", kind: "policy", question: turn.question, questionContext: { kind: "standalone" } };
  const result: SupportResult = { action, outcome: "ready", reply: { kind: "notice", text: "unknown" }, evidence: { version: 1, requestId: "unit-request",
    trustedRoute: { groupOpenid: "unit-group", messageId: "unit-message" }, action, rules: [], knowledge: [{ callId: call.id, context, trace }], actualCalls: [call] }, needsAnswer: false };
  const actual: C1ValidationActual = { caseId: "unit", turn: 1, requestId: "unit-request", execution: "completed", durationMs: 1, result, calls: [call], steps: [], requests: [], reply: { kind: "notice", text: "unknown" } };
  const review: C1AnswerReview = { caseId: "unit", turn: 1, reviewer: "codex", forHumanReview: true, humanAcceptance: false, status: "passed",
    replyHash: contentHash(actual.reply), criteriaHash: contentHash(turn.expected.answerCriteria), checks: [{ criterionId: "no-fabrication", passed: true, reasoning: "Synthetic contract check only" }] };
  const settings: EvidenceSupportSettings = { provider: "deepseek", model: "unit", api: "openai-completions", endpoint: "https://api.deepseek.com",
    timeoutMs: 1000, temperature: 0, maxTokens: 2048, maxRetries: 0, promptVersion: "unit", promptHash: contentHash("unit prompt"),
    serialization: "unit", serializationHash: contentHash("unit"), profile: "typed", validationVersion: evidenceSupportValidationVersion,
    pricing: { currency: "USD", estimated: true, source: "Pi model catalog", rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  const negative: EvidenceSupportDecision = { id: doc.id, supported: false, category: "limitation_only", quote: doc.body, reason: "Synthetic insufficient fact" };
  const positiveDecision: EvidenceSupportDecision = { ...negative, supported: true, category: "direct_fact", reason: "Synthetic sufficient fact" };
  const setKnowledge = (value: EvidenceSupportDecision[], documents: RetrievalDocument[] = [doc], invalid: NonNullable<EvidenceSupportVerification["validation"]>["invalidDecisions"] = []) => {
    const scopedDocuments = scopeDocuments(documents, trace.scope);
    trace.rawRanking = scopedDocuments.map((entry, index) => ({ id: entry.id, score: .9 - index * .1 }));
    trace.sourceHashes = { before: contentHash(scopedDocuments), after: contentHash(scopedDocuments) };
    trace.settings = { serialization: "json-title-tags-body-v1", support: settings };
    const prepared = acceptEvidence({ config: { mode: "support", threshold: .5 }, query: trace.query, scope: trace.scope, documents: scopedDocuments, ranking: trace.rawRanking });
    const input = { query: trace.query, scope: trace.scope, candidates: prepared.pendingSupport!, settings };
    const validationStatus = !invalid.length ? "complete" : value.length ? "partial" : "unavailable";
    const verification: EvidenceSupportVerification = { value, inputHash: evidenceSupportInputHash(input), requestHash: evidenceSupportRequestHash(input),
      attempts: [{ operation: "support", provider: settings.provider, model: settings.model, attempt: 1, durationMs: 1,
        outcome: validationStatus === "unavailable" ? "invalid_response" : "ok", totalTokens: null, inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, costUsd: null }],
      validation: { status: validationStatus, outputHash: contentHash({ value, invalid }), invalidDecisions: invalid } };
    assert.ok(validateEvidenceSupportVerification(verification, input));
    trace.supportVerification = verification;
    trace.calls = [{ operation: "support", requestHash: verification.requestHash, attempts: verification.attempts,
      status: validationStatus === "complete" ? "ok" : validationStatus }];
    trace.acceptance = applyEvidenceSupport({ prepared, verification, query: trace.query, scope: trace.scope, documents: scopedDocuments, settings });
    trace.status = trace.acceptance.status; trace.reason = trace.status === "unavailable" ? "invalid_support_decision" : null;
    const output = trace.acceptance.accepted.map(entry => ({ source: "demo-knowledge" as const, sourceId: entry.id, title: entry.title, body: entry.body,
      scope: { shopId: null, productId: null } }));
    call.output = output; trace.sources = output.map(entry => ({ sourceId: entry.sourceId, version: contentHash(entry) }));
    result.evidence.rules = output.map(entry => ({ ...entry, version: contentHash(entry) }));
  };
  setKnowledge([negative]);
  assert.equal(scoreC1ValidationTurn(turn, undefined, [doc]).passed, false);
  assert.equal(scoreC1ValidationTurn(turn, actual, [doc]).passed, false, "unreviewed is never final-answer success");
  assert.equal(scoreC1ValidationTurn(turn, actual, [doc], review).passed, true);
  setKnowledge([], [doc], [{ id: doc.id, code: "invalid_quote" }]);
  assert.equal(scoreC1ValidationTurn(turn, actual, [doc], review).correctlyRejected, false, "invalid is not unsupported");
  delete trace.supportVerification; trace.status = "unavailable";
  assert.equal(scoreC1ValidationTurn(turn, actual, [doc], review).passed, false);
  setKnowledge([positiveDecision]);
  assert.deepEqual(scoreC1ValidationTurn(turn, actual, [doc], review).extraAcceptedIds, [doc.id]);
  assert.equal(scoreC1ValidationTurn(turn, { ...actual, reply: "changed" }, [doc], review).answerPassed, false, "review binds to actual delivered reply");
  assert.equal(scoreC1ValidationTurn(turn, { ...actual, requestId: "different" }, [doc], review).engineeringPassed, false, "ingress binding cannot be inferred from the result");

  // In-memory scoring/schema probes only. These strings are never saved as validation questions.
  const order: Order = { source: "demo-database", id: "COUPON-9999", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
    amounts: { totalCents: 100, paidCents: 100, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "unit-shop", name: "unit", merchantName: "unit", address: "unit" },
    items: [{ id: "unit-item", productId: "unit-product", productName: "unit", quantity: 1, unitPriceCents: 100, totalCents: 100 }],
    coupons: [{ id: "unit-coupon", orderItemId: "unit-item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 100, paidAt: null }], refunds: [] };
  const updated: Order = { ...structuredClone(order), status: "refunded", amounts: { ...order.amounts, refundedCents: 100 } };
  const orderAction: ContextSupportAction = { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: order.id } };
  const orderCall: SupportCall = { ...call, id: "unit-get-order", name: "get_order", input: { orderId: order.id }, output: order }; delete orderCall.knowledge;
  const orderResult: SupportResult = { action: orderAction, outcome: "ready", reply: { kind: "notice", text: "unit paid" }, needsAnswer: false,
    evidence: { ...result.evidence, action: orderAction, actualCalls: [orderCall], order, rules: [], knowledge: [] } };
  const orderActual: C1ValidationActual = { ...actual, result: orderResult, calls: [orderCall], reply: orderResult.reply };
  const orderTurn: C1ValidationTurn = { question: turn.question, expected: { ...turn.expected, allowedKinds: ["order"], knowledge: "none", freshOrder: order } };
  const reviewed = (input: C1ValidationActual, expected: C1ValidationTurn): C1AnswerReview => ({ ...review, caseId: input.caseId, turn: input.turn,
    replyHash: contentHash(input.reply), criteriaHash: contentHash(expected.expected.answerCriteria) });
  assert.equal(scoreC1ValidationTurn(orderTurn, orderActual, [doc], reviewed(orderActual, orderTurn)).passed, true);
  for (const change of [{ parentSpanId: "old-request" }, { output: updated }]) assert.equal(scoreC1ValidationTurn(orderTurn,
    { ...orderActual, calls: [{ ...orderCall, ...change }] }, [doc], reviewed(orderActual, orderTurn)).passed, false, "fresh output and current parent both matter");
  const deniedTurn: C1ValidationTurn = { question: turn.question, expected: { ...orderTurn.expected, outcome: "business_denial", freshOrder: null, deniedOrderId: order.id } };
  const deniedActual: C1ValidationActual = { ...orderActual, result: undefined, calls: [{ ...orderCall, output: undefined, isError: true, errorKind: "business_denial" }] };
  assert.equal(scoreC1ValidationTurn(deniedTurn, deniedActual, [doc], reviewed(deniedActual, deniedTurn)).passed, true, "expected authorization denial needs no knowledge proof");
  const evidenceTurn = (): C1ValidationTurn => ({ question: turn.question, expected: { ...structuredClone(turn.expected), knowledge: "evidence", gold: [{ sourceId: doc.id, quote: doc.body }] } });
  const positive = evidenceTurn();
  const invalidDoc = { ...doc, id: "invalid-unit", body: "Another real pending candidate" };
  setKnowledge([positiveDecision], [doc, invalidDoc], [{ id: invalidDoc.id, code: "invalid_quote" }]);
  const partial = scoreC1ValidationTurn(positive, actual, [doc, invalidDoc], reviewed(actual, positive));
  assert.equal(partial.evidenceProofPassed, true);
  assert.equal(partial.engineeringPassed, true); assert.equal(partial.knowledgePassed, true); assert.equal(partial.acceptedRecall, 1);
  assert.equal(partial.supportIntegrityPassed, false); assert.equal(partial.semanticEvidenceCorrect, null); assert.equal(partial.passed, false);
  assert.deepEqual(partial.validUnsupportedIds, [], "an invalid candidate never becomes a valid negative");
  setKnowledge([negative], [doc, invalidDoc], [{ id: invalidDoc.id, code: "invalid_quote" }]);
  const unavailablePartial = scoreC1ValidationTurn(turn, actual, [doc, invalidDoc], reviewed(actual, turn));
  assert.equal(unavailablePartial.correctlyRejected, false); assert.deepEqual(unavailablePartial.validUnsupportedIds, [doc.id]);
  setKnowledge([positiveDecision]);
  for (const mutate of [
    (value: C1ValidationActual) => { delete value.calls[0]!.knowledge!.trace.supportVerification; },
    (value: C1ValidationActual) => { value.calls[0]!.knowledge!.trace.supportVerification!.value[0]!.quote = "not in source"; },
    (value: C1ValidationActual) => { value.calls[0]!.knowledge!.trace.supportVerification!.inputHash = "0".repeat(64); },
    (value: C1ValidationActual) => { value.calls[0]!.knowledge!.trace.supportVerification!.requestHash = "0".repeat(64); },
    (value: C1ValidationActual) => { value.calls[0]!.knowledge!.trace.sourceHashes.after = "0".repeat(64); },
    (value: C1ValidationActual) => { value.calls[0]!.knowledge!.trace.sources![0]!.version = "0".repeat(64); },
    (value: C1ValidationActual) => { value.result!.evidence.rules[0]!.body = "forged original"; },
    (value: C1ValidationActual) => { (value.calls[0]!.output as Array<{ body: string }>)[0]!.body = "forged tool output"; },
    (value: C1ValidationActual) => { value.calls[0]!.knowledge!.context.effectiveQuery = "different input"; },
  ]) {
    const forged = structuredClone(actual); mutate(forged);
    const score = scoreC1ValidationTurn(positive, forged, [doc], reviewed(forged, positive));
    assert.equal(score.evidenceProofPassed, false); assert.equal(score.passed, false); assert.equal(score.acceptedRecall, 0);
  }
  const noRanking = structuredClone(actual);
  const emptyTrace = noRanking.calls[0]!.knowledge!.trace;
  emptyTrace.rawRanking = []; delete emptyTrace.supportVerification; emptyTrace.calls = [];
  emptyTrace.acceptance = acceptEvidence({ config: { mode: "support", threshold: .5 }, query: emptyTrace.query, scope: {}, documents: [doc], ranking: [] });
  emptyTrace.status = "rejected"; emptyTrace.sources = []; noRanking.calls[0]!.output = []; noRanking.result!.evidence.rules = [];
  assert.equal(scoreC1ValidationTurn(turn, noRanking, [doc], reviewed(noRanking, turn)).correctlyRejected, false, "missing rerank output is not a completed negative judgment");
  const clarificationTurn = (): C1ValidationTurn => ({ question: turn.question, expected: { ...structuredClone(turn.expected), allowedKinds: ["clarify"], outcome: "clarification", knowledge: "none" } });
  const cases: C1ValidationCase[] = c1Families.flatMap(family => (["known", "missing", "competing"] as const).map(stratum => ({
    id: `unit-${family}-${stratum}`, family, stratum, corpus: "online" as const,
    ...(stratum === "competing" ? { competingCandidates: ["unit-a", "unit-b"], ambiguityReason: "Synthetic competing inputs" } : {}),
    turns: [stratum === "known" ? evidenceTurn() : clarificationTurn()] })));
  const paid = cases.find(item => item.family === "paid_amount" && item.stratum === "known")!.turns[0]!.expected;
  Object.assign(paid, { allowedKinds: ["paid_amount_compare"], knowledge: "none", gold: [], reference: "amount", freshOrder: order,
    amount: { couponId: "unit-coupon", remainingUnitPaidCents: 100, referencePaidCents: 100, comparisonEqual: true } });
  const stateCase = cases[0]!;
  stateCase.turns = [orderTurn, { ...evidenceTurn(), expected: { ...evidenceTurn().expected, freshOrder: updated }, stateChange: { orderId: order.id, before: order, after: updated } }];
  for (let index = 0; index < 6; index++) cases.push({ id: `unit-extra-${index}`, family: null, stratum: index < 4 ? "direct_missing_fact" : "boundary",
    corpus: "reference", turns: [index < 4 ? structuredClone(turn) : evidenceTurn()] });
  const plan: C1ValidationPlan = { version: 1, suiteId: "unit-scoring-only", validationPolicy: "fixed-validation-not-blind", cases };
  const corpora: Corpora = { online: [doc], reference: [doc] }, bytes = Buffer.from(JSON.stringify(plan)), sourceBytes = { "unit-source": Buffer.from(doc.body) };
  const manifest: C1ValidationManifest = { version: 1, frozenBeforeExecution: true, validationPolicy: plan.validationPolicy,
    dataset: { path: "unit-in-memory.json", bytes: bytes.length, sha256: byteHash(bytes) }, sourceHashes: { "unit-source": byteHash(sourceBytes["unit-source"]) },
    corpusHashes: { online: contentHash(corpora.online), reference: contentHash(corpora.reference) }, configurationHash: contentHash({ mode: "unit" }), counts: checkC1ValidationPlan(plan, corpora) };
  const manifestInput = { bytes, manifest, sourceBytes, configuration: { mode: "unit" }, corpora };
  assert.deepEqual(verifyC1ValidationManifest(manifestInput), plan);
  assert.throws(() => verifyC1ValidationManifest({ ...manifestInput, bytes: Buffer.from(bytes.toString() + " ") }));
  assert.throws(() => verifyC1ValidationManifest({ ...manifestInput, sourceBytes: { "unit-source": Buffer.from("changed") } }));
  assert.throws(() => verifyC1ValidationManifest({ ...manifestInput, corpora: { ...corpora, online: [{ ...doc, body: "changed" }] } }));
  const empty = summarizeC1Validation(plan, [], corpora);
  assert.deepEqual([empty.plannedCases, empty.plannedTurns, empty.passedCases, empty.completedTurns, empty.unreviewedReplies], [24, 25, 0, 0, 25]);
  assert.deepEqual([empty.strata.missing.planned, empty.strata.competing.planned, empty.directMissing.planned], [6, 6, 4]);
  assert.equal(empty.acceptedRecall, 0); assert.equal(empty.knowledgeTargets.planned, 7);
  assert.throws(() => summarizeC1Validation({ ...plan, cases: cases.slice(1) }, [], corpora));
  const before: C1ValidationActual = { ...orderActual, caseId: stateCase.id, turn: 1 };
  const after: C1ValidationActual = { ...orderActual, caseId: stateCase.id, turn: 2, requestId: "unit-next",
    calls: [{ ...orderCall, parentSpanId: "unit-next", output: updated }],
    result: { ...orderResult, evidence: { ...orderResult.evidence, requestId: "unit-next", order: updated } } };
  assert.equal(summarizeC1Validation(plan, [before, after], corpora).rows.find(row => row.caseId === stateCase.id && row.turn === 2)!.stateChangePassed, true);
  assert.equal(summarizeC1Validation(plan, [after], corpora).rows.find(row => row.caseId === stateCase.id && row.turn === 2)!.stateChangePassed, false, "new snapshot alone does not prove a transition");
  const topicPlan = structuredClone(plan), topicCase = topicPlan.cases.find(item => item.family === "refund_time" && item.stratum === "known")!;
  topicCase.turns = [evidenceTurn(), { ...evidenceTurn(), expected: { ...evidenceTurn().expected, reference: "previous" } }];
  const priorTopic: C1ValidationActual = { ...structuredClone(actual), caseId: topicCase.id, turn: 1 };
  const topic = { requestId: priorTopic.requestId!, sourceKey: contentHash("unit actor"), groupOpenid: "unit-group", originalQuery: turn.question,
    orderId: null, scope: { shopId: null, productId: null }, intent: "policy" as const,
    sources: priorTopic.result!.evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })) };
  priorTopic.result!.verifiedPolicyTopic = topic;
  const topicActual: C1ValidationActual = { ...structuredClone(actual), caseId: topicCase.id, turn: 2, requestId: "topic-next", hostReference: { policyTopic: { requestId: topic.requestId } } };
  topicActual.result!.evidence.requestId = topicActual.requestId!;
  topicActual.calls.forEach(item => { item.parentSpanId = topicActual.requestId!; item.knowledge!.context.policyTopic = structuredClone(topic); });
  topicActual.result!.action = { protocol: "v2.2", kind: "policy", question: turn.question, questionContext: { kind: "previous", requestId: topic.requestId } };
  topicActual.result!.evidence.action = topicActual.result!.action;
  const topicScore = (value: C1ValidationActual) => summarizeC1Validation(topicPlan, [priorTopic, value], corpora,
    [reviewed(priorTopic, topicCase.turns[0]!), reviewed(value, topicCase.turns[1]!)]).rows.find(row => row.caseId === topicCase.id && row.turn === 2)!;
  assert.equal(topicScore(topicActual).passed, true, "a real completed prior topic remains usable");
  for (const change of [{ originalQuery: "invented earlier request" }, { sourceKey: "another actor" }, { groupOpenid: "another group" },
    { scope: { shopId: "other-shop", productId: null } }, { orderId: "COUPON-8888" }, { intent: "refund_eligibility" as const },
    { sources: [{ sourceId: doc.id, version: "0".repeat(64) }] }]) {
    const forged = structuredClone(topicActual);
    Object.assign(forged.calls[0]!.knowledge!.context.policyTopic!, change);
    assert.equal(topicScore(forged).referenceProvenancePassed, false); assert.equal(topicScore(forged).passed, false, "same requestId cannot authenticate changed topic content");
  }
  const noPrior = summarizeC1Validation(topicPlan, [topicActual], corpora, [reviewed(topicActual, topicCase.turns[1]!)]);
  assert.equal(noPrior.rows.find(row => row.caseId === topicCase.id && row.turn === 2)!.referenceProvenancePassed, false);

  // The scorer independently rebuilds declared candidates from real preceding get_order output.
  const multiDoc = { ...doc, id: "unit-multi", body: "A rule with a declared multi-coupon prerequisite" };
  const generalDoc = { ...doc, id: "unit-general", body: "A rule without a declared quantity or state prerequisite" };
  const declaredSnapshot = validateKnowledgeApplicabilitySnapshot({ version: 1, serialization: "knowledge-document-v1", documents: [doc, multiDoc, generalDoc].map((entry, index) => ({
    sourceId: entry.id, sourceHash: knowledgeApplicabilitySourceHash(entry), scope: { shopId: null, productId: null },
    ...(index === 0 ? { atLeastOneCouponInStates: ["unused"] } : index === 1 ? { minimumCouponCount: 2 } : {}),
    basis: index < 2 ? [{ field: index === 0 ? "atLeastOneCouponInStates" : "minimumCouponCount", quote: entry.body }] : [], reviewNote: "Synthetic prerequisite only" })) });
  const declaredConfiguration: C1ValidationKnowledgeConfiguration = { applicability: "declared", applicabilitySnapshot: declaredSnapshot };
  function declaredActual(freshOrder: Order, documents: RetrievalDocument[]): C1ValidationActual {
    const value = structuredClone(actual), knowledgeCall = value.calls[0]!, t = knowledgeCall.knowledge!.trace, ctx = knowledgeCall.knowledge!.context;
    const r = value.result!, currentScope = { shopId: freshOrder.shop.id, productId: freshOrder.items[0]!.productId };
    r.action = { protocol: "v2.2", kind: "refund_eligibility", question: turn.question, questionContext: { kind: "standalone" }, orderRef: { kind: "explicit", orderId: freshOrder.id } };
    r.evidence.action = r.action; r.evidence.order = freshOrder;
    value.calls = [{ ...structuredClone(orderCall), output: freshOrder }, knowledgeCall]; r.evidence.actualCalls = value.calls;
    Object.assign(ctx, { purpose: "refund_eligibility", orderSource: "current_explicit", scopeSource: "fresh_order", protocol: "v2.2",
      applicability: buildKnowledgeApplicabilityContext({ order: freshOrder, requestId: value.requestId!, purpose: "refund_eligibility" }) });
    knowledgeCall.input = { query: t.query, ...currentScope }; t.scope = currentScope;
    const visibleDocs = scopeDocuments(documents, currentScope);
    t.sourceHashes = { before: contentHash(visibleDocs), after: contentHash(visibleDocs) };
    t.rawRanking = visibleDocs.map((entry, index) => ({ id: entry.id, score: .9 - index * .1 }));
    const prepared = acceptEvidence({ query: t.query, scope: currentScope, documents: visibleDocs, ranking: t.rawRanking, config: { mode: "support", threshold: .5 } });
    const gate = gateKnowledgeApplicability({ snapshot: declaredSnapshot, context: ctx.applicability!, scope: currentScope, candidates: prepared.pendingSupport! });
    const filtered = applyKnowledgeApplicabilityGate(prepared, gate), { candidates: _candidates, ...audit } = gate;
    t.applicability = { mode: "declared", gate: audit };
    t.settings = { serialization: "json-title-tags-body-v1", support: settings, applicability: knowledgeApplicabilitySettings(declaredSnapshot) };
    if (filtered.pendingSupport!.length) {
      const supportInput = { query: t.query, scope: currentScope, candidates: filtered.pendingSupport!, settings };
      const value = filtered.pendingSupport!.map(entry => ({ id: entry.id, supported: true, category: "direct_fact" as const, quote: entry.body, reason: "Synthetic supported fact" }));
      const verification: EvidenceSupportVerification = { value, inputHash: evidenceSupportInputHash(supportInput), requestHash: evidenceSupportRequestHash(supportInput),
        attempts: structuredClone(trace.supportVerification!.attempts), validation: { status: "complete", outputHash: contentHash(value), invalidDecisions: [] } };
      t.supportVerification = verification; t.calls = [{ operation: "support", requestHash: verification.requestHash, attempts: verification.attempts, status: "ok" }];
      t.acceptance = applyEvidenceSupport({ prepared: filtered, verification, query: t.query, scope: currentScope, documents: visibleDocs, settings });
    } else { delete t.supportVerification; t.calls = []; t.acceptance = filtered; }
    t.acceptance = finishKnowledgeApplicabilityAcceptance(t.acceptance, gate); t.status = t.acceptance.status;
    t.reason = t.status === "unavailable" ? gate.reason === "facts_unknown" ? "applicability_facts_unknown" : "metadata_binding_invalid" : null;
    const output = t.acceptance.accepted.map(entry => ({ source: "demo-knowledge" as const, sourceId: entry.id, title: entry.title, body: entry.body, scope: { shopId: null, productId: null } }));
    knowledgeCall.output = output; t.sources = output.map(entry => ({ sourceId: entry.sourceId, version: contentHash(entry) }));
    r.evidence.rules = output.map(entry => ({ ...entry, version: contentHash(entry) }));
    r.evidence.knowledge = [{ callId: knowledgeCall.id, context: ctx, trace: t }];
    return value;
  }
  const declaredTurn: C1ValidationTurn = { question: turn.question, expected: { ...positive.expected, allowedKinds: ["refund_eligibility"], freshOrder: order,
    scope: { shopId: order.shop.id, productId: order.items[0]!.productId } } };
  const declaredValue = declaredActual(order, [doc, multiDoc]);
  const scoreDeclared = (value: C1ValidationActual, expected = declaredTurn, documents: RetrievalDocument[] = [doc, multiDoc], configuration = declaredConfiguration) =>
    scoreC1ValidationTurn(expected, value, documents, reviewed(value, expected), configuration);
  assert.equal(scoreDeclared(declaredValue).passed, true);
  assert.deepEqual(scoreDeclared(declaredValue).applicabilityExcludedIds, [multiDoc.id]);
  assert.deepEqual(scoreDeclared(declaredValue).validUnsupportedIds, [], "Host exclusion is not a model's valid negative");
  assert.equal(scoreDeclared(declaredValue, declaredTurn, [doc, multiDoc], { applicability: "declared" }).evidenceProofPassed, false, "A self-reported snapshot is not authority");
  assert.equal(scoreDeclared(declaredValue, declaredTurn, [doc, multiDoc], {}).evidenceProofPassed, false, "Frozen mode must match actual mode");
  for (const mutate of [
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.trace.applicability!.gate!.decisions.find(row => row.id === multiDoc.id)!.status = "matched"; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.trace.applicability!.gate!.snapshotHash = "0".repeat(64); },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.trace.settings!.applicability!.snapshotHash = "0".repeat(64); },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.applicability!.facts!.couponCount = 2; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.purpose = "user_policy"; },
    (value: C1ValidationActual) => { delete value.calls[1]!.knowledge!.context.applicability; },
    (value: C1ValidationActual) => { delete value.calls[1]!.knowledge!.context.protocol; },
    (value: C1ValidationActual) => { value.calls[0]!.parentSpanId = "old-request"; },
    (value: C1ValidationActual) => { value.calls.reverse(); value.result!.evidence.actualCalls = value.calls; },
    (value: C1ValidationActual) => { value.calls[0]!.output = { ...order, coupons: [] }; },
  ]) {
    const forged = structuredClone(declaredValue); mutate(forged);
    assert.equal(scoreDeclared(forged).evidenceProofPassed, false); assert.equal(scoreDeclared(forged).passed, false);
  }
  const incomplete = structuredClone(order); incomplete.items[0]!.quantity = 2;
  const unknownPositive = declaredActual(incomplete, [doc, generalDoc]);
  const unknownTurn = { ...declaredTurn, expected: { ...declaredTurn.expected, freshOrder: incomplete, gold: [{ sourceId: generalDoc.id, quote: generalDoc.body }] } };
  const unknownScore = scoreDeclared(unknownPositive, unknownTurn, [doc, generalDoc]);
  assert.equal(unknownScore.evidenceProofPassed, true); assert.equal(unknownScore.acceptedRecall, 1);
  assert.equal(unknownScore.knowledgePassed, true); assert.equal(unknownScore.supportIntegrityPassed, true);
  assert.equal(unknownScore.applicabilityIntegrityPassed, false); assert.equal(unknownScore.semanticEvidenceCorrect, null); assert.equal(unknownScore.passed, false);
  assert.deepEqual(unknownScore.applicabilityUnknownIds, [doc.id]); assert.deepEqual(unknownScore.validUnsupportedIds, []);
  const rejectedTurn = { ...declaredTurn, expected: { ...declaredTurn.expected, knowledge: "rejected" as const, gold: [] } };
  const mismatchScore = scoreDeclared(declaredActual(order, [multiDoc]), rejectedTurn, [multiDoc]);
  assert.equal(mismatchScore.correctlyRejected, true); assert.equal(mismatchScore.validDecisionCount, 0);
  const unknownOnly = scoreDeclared(declaredActual(incomplete, [doc]), { ...rejectedTurn, expected: { ...rejectedTurn.expected, freshOrder: incomplete } }, [doc]);
  assert.equal(unknownOnly.correctlyRejected, false); assert.equal(unknownOnly.unavailable, true);
  // New host-binding replay is independent of the model's policy/refund label,
  // and remains mandatory when metadata gating is disabled.
  const bindingConfiguration = { ...declaredConfiguration, evidenceBindingVersion };
  function boundActual(input: { question: string; action: ContextSupportAction; order?: Order; topic?: TrustedPolicyTopic;
    requestId?: string; turn?: number; mode?: "model_only" | "declared" }, documents: RetrievalDocument[] = [doc, multiDoc]) {
    const value = structuredClone(actual), r = value.result!, knowledgeCall = value.calls[0]!, t = knowledgeCall.knowledge!.trace, ctx = knowledgeCall.knowledge!.context;
    value.requestId = input.requestId ?? "bound-request"; value.turn = input.turn ?? 1;
    value.ingress = { requestId: value.requestId, identity: { appId: "unit-app", senderId: "unit-user" }, groupOpenid: "unit-group", messageId: value.requestId + "-message" };
    const sourceKey = merchantSourceKey(value.ingress.identity, value.ingress.groupOpenid);
    r.action = input.action; r.evidence.action = input.action; r.evidence.requestId = value.requestId;
    r.evidence.trustedRoute = { groupOpenid: value.ingress.groupOpenid, messageId: value.ingress.messageId };
    if (input.order) r.evidence.order = input.order; else delete r.evidence.order;
    knowledgeCall.parentSpanId = value.requestId;
    value.calls = input.order ? [{ ...structuredClone(orderCall), parentSpanId: value.requestId, input: { orderId: input.order.id }, output: input.order }, knowledgeCall] : [knowledgeCall];
    r.evidence.actualCalls = value.calls;
    const scope = { shopId: input.order?.shop.id ?? null, productId: input.order?.items[0]?.productId ?? null };
    Object.assign(ctx, { originalQuery: input.question, modelQuestion: "question" in input.action ? input.action.question : null,
      scopeSource: input.order ? "fresh_order" : "global", orderSource: input.order ? "current_explicit" : "none", policyTopic: input.topic ?? null,
      ...buildSupportEvidenceBinding({ action: input.action, originalQuery: input.question, order: input.order, requestId: value.requestId,
        verifiedTopic: input.topic, binding: { sourceKey, groupOpenid: value.ingress.groupOpenid, orderId: input.order?.id ?? null } }) });
    if (input.topic) value.hostReference = { policyTopic: { requestId: input.topic.requestId } };
    const query = ctx.effectiveQuery, visibleDocs = scopeDocuments(documents, scope);
    knowledgeCall.input = { query, ...scope }; Object.assign(t, { query, originalQuery: input.question, scope,
      sourceHashes: { before: contentHash(visibleDocs), after: contentHash(visibleDocs) }, rawRanking: visibleDocs.map((entry, index) => ({ id: entry.id, score: .9 - index * .1 })) });
    let prepared = acceptEvidence({ query, scope, documents: visibleDocs, ranking: t.rawRanking, config: { mode: "support", threshold: .5 } });
    const gate = input.mode === "model_only" ? undefined : gateKnowledgeApplicability({ snapshot: declaredSnapshot, context: ctx.applicability ?? null, scope, candidates: prepared.pendingSupport! });
    t.settings = { serialization: "json-title-tags-body-v1", support: settings };
    if (gate) { const { candidates: _candidates, ...audit } = gate; t.applicability = { mode: "declared", gate: audit };
      t.settings.applicability = knowledgeApplicabilitySettings(declaredSnapshot); prepared = applyKnowledgeApplicabilityGate(prepared, gate); }
    else t.applicability = { mode: "model_only" };
    const supportInput = { query, scope, candidates: prepared.pendingSupport!, settings };
    const decisions = supportInput.candidates.map(entry => ({ id: entry.id, supported: true, category: "direct_fact" as const, quote: entry.body, reason: "Synthetic source proof" }));
    const verification: EvidenceSupportVerification = { value: decisions, inputHash: evidenceSupportInputHash(supportInput), requestHash: evidenceSupportRequestHash(supportInput),
      attempts: structuredClone(trace.supportVerification!.attempts), validation: { status: "complete", outputHash: contentHash(decisions), invalidDecisions: [] } };
    t.supportVerification = verification; t.calls = [{ operation: "support", requestHash: verification.requestHash, attempts: verification.attempts, status: "ok" }];
    t.acceptance = finishKnowledgeApplicabilityAcceptance(applyEvidenceSupport({ prepared, verification, query, scope, documents: visibleDocs, settings }), gate);
    t.status = t.acceptance.status; t.reason = null;
    const output = t.acceptance.accepted.map(entry => ({ source: "demo-knowledge" as const, sourceId: entry.id, title: entry.title, body: entry.body, scope: { shopId: null, productId: null } }));
    knowledgeCall.output = output; t.sources = output.map(entry => ({ sourceId: entry.sourceId, version: contentHash(entry) }));
    r.evidence.rules = output.map(entry => ({ ...entry, version: contentHash(entry) })); r.evidence.knowledge = [{ callId: knowledgeCall.id, context: ctx, trace: t }];
    return value;
  }
  const boundQuestion = `订单 ${order.id} 是否符合退款条件？`;
  const boundAction: ContextSupportAction = { protocol: "v2.2", kind: "policy", question: boundQuestion, questionContext: { kind: "standalone" }, orderRef: { kind: "explicit", orderId: order.id } };
  const boundTurn = { ...declaredTurn, question: boundQuestion, expected: { ...declaredTurn.expected, allowedKinds: ["policy", "refund_eligibility"] as ReadKind[] } };
  const scoreBound = (value: C1ValidationActual, expected = boundTurn, configuration = bindingConfiguration, history: C1ValidationHistory = [], documents = [doc, multiDoc]) =>
    scoreC1ValidationTurn(expected, value, documents, reviewed(value, expected), configuration, history);
  const boundPolicy = boundActual({ question: boundQuestion, action: boundAction, order });
  const boundRefund = boundActual({ question: boundQuestion, action: { ...boundAction, kind: "refund_eligibility", orderRef: { kind: "explicit", orderId: order.id } }, order });
  assert.equal(scoreBound(boundPolicy).passed, true); assert.equal(scoreBound(boundRefund).passed, true);
  assert.deepEqual(boundPolicy.calls[1]!.knowledge!.trace.applicability, boundRefund.calls[1]!.knowledge!.trace.applicability);
  for (const mutate of [
    (value: C1ValidationActual) => { delete value.calls[1]!.knowledge!.context.evidenceBindingVersion; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.evidenceUse = "explanation"; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.purpose = "user_policy"; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.facts!.couponCounts!.total = 2; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.facts!.couponDates![0]!.expiredAtAsOf = true; },
    (value: C1ValidationActual) => { value.calls[1]!.knowledge!.context.evidenceTarget!.basis = "invented"; },
    (value: C1ValidationActual) => { value.calls[0]!.parentSpanId = "old-request"; },
    (value: C1ValidationActual) => { value.calls[0]!.output = { ...order, coupons: [] }; },
    (value: C1ValidationActual) => { value.ingress!.groupOpenid = "other-group"; },
  ]) { const forged = structuredClone(boundPolicy); mutate(forged); assert.equal(scoreBound(forged).evidenceProofPassed, false); }
  const modelOnly = boundActual({ question: boundQuestion, action: boundAction, order, mode: "model_only" }, [doc]);
  const modelConfiguration = { evidenceBindingVersion };
  assert.equal(scoreC1ValidationTurn(boundTurn, modelOnly, [doc], reviewed(modelOnly, boundTurn), modelConfiguration).passed, true);
  modelOnly.calls[1]!.knowledge!.context.facts!.status = "refunded";
  assert.equal(scoreC1ValidationTurn(boundTurn, modelOnly, [doc], undefined, modelConfiguration).evidenceProofPassed, false);
  const hypothetical = `订单 ${order.id}，假设有两张未核销券，规则是什么？`;
  const ruleAction: ContextSupportAction = { ...boundAction, question: hypothetical, evidenceTarget: { kind: "rule_only", basis: "假设有两张未核销券" } };
  const ruleOnly = boundActual({ question: hypothetical, action: ruleAction, order });
  const hypotheticalTurn = { ...boundTurn, question: hypothetical, expected: { ...boundTurn.expected, gold: [doc, multiDoc].map(entry => ({ sourceId: entry.id, quote: entry.body })) } };
  assert.equal(scoreBound(ruleOnly, hypotheticalTurn).passed, true); assert.equal(ruleOnly.calls[1]!.knowledge!.context.applicability, undefined);
  assert.deepEqual(scoreBound(ruleOnly, hypotheticalTurn).applicabilityUncheckedIds, [multiDoc.id, doc.id]);
  const previousQuestion = "假设有两张未核销券，规则是什么？";
  const previousAction: ContextSupportAction = { protocol: "v2.2", kind: "policy", question: previousQuestion, questionContext: { kind: "standalone" } };
  const previous = boundActual({ question: previousQuestion, action: previousAction, requestId: "prior-rule" }, [doc]);
  const prior: TrustedPolicyTopic = { requestId: previous.requestId!, sourceKey: merchantSourceKey(previous.ingress!.identity, previous.ingress!.groupOpenid),
    groupOpenid: previous.ingress!.groupOpenid, originalQuery: previousQuestion, orderId: null, scope: { shopId: null, productId: null }, intent: "policy",
    sources: previous.result!.evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })) };
  previous.result!.verifiedPolicyTopic = prior;
  const followQuestion = "那这种情况呢？", followAction: ContextSupportAction = { ...previousAction, question: followQuestion,
    questionContext: { kind: "previous", requestId: prior.requestId }, evidenceTarget: { kind: "rule_only", basis: "假设有两张未核销券" } };
  const follow = boundActual({ question: followQuestion, action: followAction, requestId: "follow-rule", turn: 2, topic: prior }, [doc]);
  const followTurn = { ...positive, question: followQuestion };
  const priorHistory = [{ question: previousQuestion, actual: previous }];
  assert.equal(scoreBound(follow, followTurn, bindingConfiguration, priorHistory, [doc]).passed, true);
  assert.equal(scoreBound(follow, followTurn, bindingConfiguration, [], [doc]).evidenceProofPassed, false);
  for (const mutate of [
    (value: C1ValidationActual) => { value.result!.verifiedPolicyTopic!.originalQuery = "invented earlier condition"; },
    (value: C1ValidationActual) => { value.ingress!.identity.senderId = "other-user"; },
    (value: C1ValidationActual) => { value.result!.verifiedPolicyTopic!.sources[0]!.version = "0".repeat(64); },
  ]) { const forgedPrior = structuredClone(previous); mutate(forgedPrior);
    assert.equal(scoreBound(follow, followTurn, bindingConfiguration, [{ question: previousQuestion, actual: forgedPrior }], [doc]).evidenceProofPassed, false); }
  const changedQuestion = { ...followTurn, question: "different actual input" };
  assert.equal(scoreBound(follow, changedQuestion, bindingConfiguration, priorHistory, [doc]).evidenceProofPassed, false);
  // Amount candidates are real host displays; a model-written latest requestId
  // or selectedToken must not impersonate a user's deterministic selection.
  const amountOrder = structuredClone(order); amountOrder.status = "partially_redeemed";
  amountOrder.items[0]!.quantity = 2; amountOrder.items[0]!.totalCents = 200;
  amountOrder.amounts = { totalCents: 200, paidCents: 200, refundedCents: 0 }; amountOrder.payments[0]!.amountCents = 200;
  amountOrder.coupons.push({ ...amountOrder.coupons[0]!, id: "unit-redeemed", status: "redeemed" });
  const now = Date.parse(order.asOf), identity = { appId: "unit-app", senderId: "unit-user" }, groupOpenid = "unit-group";
  const amountBinding = { sourceKey: merchantSourceKey(identity, groupOpenid), groupOpenid };
  const display = (fresh: Order, requestId: string, turnIndex: number): C1ValidationActual => {
    const value = structuredClone(orderActual), r = value.result!, reference = createAmountReference(fresh, amountBinding, requestId)!;
    value.requestId = requestId; value.turn = turnIndex; value.ingress = { identity, requestId, groupOpenid, messageId: requestId + "-message", observedAt: order.asOf };
    r.action = { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: fresh.id } }; r.evidence.action = r.action;
    r.evidence.requestId = requestId; r.evidence.trustedRoute = { groupOpenid, messageId: value.ingress.messageId }; r.evidence.order = fresh;
    value.calls[0]!.parentSpanId = requestId; value.calls[0]!.input = { orderId: fresh.id }; value.calls[0]!.output = fresh; r.evidence.actualCalls = value.calls;
    r.reply = { kind: "order", text: "Synthetic actual paid-unit display", orders: [{ id: fresh.id, status: fresh.status,
      paidCents: fresh.amounts.paidCents, refundedCents: fresh.amounts.refundedCents, couponStatuses: fresh.coupons.map(coupon => coupon.status) }], evidenceIds: [] };
    value.reply = r.reply; r.verifiedAmountReference = reference; r.evidence.displayedPaidUnit = reference;
    return value;
  };
  const displayed = display(amountOrder, "amount-display", 1), amountReference = displayed.result!.verifiedAmountReference!;
  const comparison = display(amountOrder, "amount-compare", 3);
  comparison.result!.action = { protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" }, amountRef: { requestId: amountReference.requestId } };
  comparison.result!.evidence.action = comparison.result!.action;
  comparison.result!.evidence.amountChoices = rememberAmountChoice(undefined, amountBinding, amountReference, now)!;
  comparison.result!.evidence.amountComparison = compareRemainingAmount(amountOrder, amountReference, amountBinding)!;
  comparison.hostReference = { orderId: amountOrder.id, itemPaidUnit: { requestId: amountReference.requestId, paidCents: amountReference.paidCents } };
  const amountTurn: C1ValidationTurn = { question: "当前剩余券实付和之前显示的一样吗？", expected: { ...orderTurn.expected,
    allowedKinds: ["paid_amount_compare"], reference: "amount", freshOrder: amountOrder,
    amount: { couponId: amountOrder.coupons[0]!.id, remainingUnitPaidCents: 100, referencePaidCents: 100, comparisonEqual: true } } };
  const amountHistory: C1ValidationHistory = [{ question: `查询 ${amountOrder.id}`, actual: displayed }];
  const scoreAmount = (value: C1ValidationActual, history = amountHistory) => scoreC1ValidationTurn(amountTurn, value, [doc], reviewed(value, amountTurn), { evidenceBindingVersion }, history);
  assert.equal(scoreAmount(comparison).passed, true); assert.equal(scoreAmount(comparison, []).amountEvidenceProofPassed, false);
  const notDelivered = structuredClone(displayed); notDelivered.reply = { kind: "notice", text: "未能展示金额" };
  assert.equal(scoreAmount(comparison, [{ question: amountHistory[0]!.question, actual: notDelivered }]).amountEvidenceProofPassed, false,
    "A hidden fixed tool result cannot become a delivered amount reference");
  const secondOrder = { ...structuredClone(amountOrder), id: "COUPON-8888" }, secondDisplay = display(secondOrder, "second-display", 2);
  const competingAmount = structuredClone(comparison);
  competingAmount.result!.evidence.amountChoices = rememberAmountChoice(comparison.result!.evidence.amountChoices, amountBinding, secondDisplay.result!.verifiedAmountReference!, now)!;
  const twoDisplays = [...amountHistory, { question: `查询 ${secondOrder.id}`, actual: secondDisplay }];
  assert.equal(scoreAmount(competingAmount, twoDisplays).amountEvidenceProofPassed, false, "Two displays cannot silently become the most recent reference");
  const selectedAmount = structuredClone(competingAmount), choices = selectedAmount.result!.evidence.amountChoices!;
  choices.selectedToken = choices.candidates[0]!.token; selectedAmount.turn = 4;
  assert.equal(scoreAmount(selectedAmount, twoDisplays).amountEvidenceProofPassed, false, "A forged selectedToken has no user receipt");
  const receipt: SupportHostReceipt = { version: "amount-selection-v1", requestId: "amount-selection", sourceKey: amountBinding.sourceKey,
    trustedRoute: { groupOpenid, messageId: "selection-message" }, outcome: "selected", selectedRequestId: amountReference.requestId,
    choices: structuredClone(choices), reply: { kind: "notice", text: "Synthetic selected host receipt" } };
  const selection: C1ValidationActual = { caseId: selectedAmount.caseId, turn: 3, requestId: receipt.requestId, execution: "completed", durationMs: 1,
    ingress: { identity, groupOpenid, messageId: receipt.trustedRoute.messageId, requestId: receipt.requestId, observedAt: order.asOf },
    hostReceipt: receipt, reply: receipt.reply, calls: [], steps: [], requests: [] };
  const selectedHistory = [...twoDisplays, { question: `选择金额基准 ${choices.selectedToken}`, actual: selection }];
  assert.equal(scoreAmount(selectedAmount, selectedHistory).passed, true);
  for (const mutate of [
    (value: C1ValidationActual) => { value.hostReceipt!.sourceKey = "another actor"; },
    (value: C1ValidationActual) => { value.hostReceipt!.selectedRequestId = "forged-display"; },
    (value: C1ValidationActual) => { value.hostReceipt!.historyFailed = true; },
  ]) { const forged = structuredClone(selection); mutate(forged);
    assert.equal(scoreAmount(selectedAmount, [...twoDisplays, { question: selectedHistory[2]!.question, actual: forged }]).amountEvidenceProofPassed, false); }
  assert.equal(scoreAmount(selectedAmount, [...twoDisplays, { question: "请你帮我选最新的金额", actual: selection }]).amountEvidenceProofPassed, false);
  const afterRejected = structuredClone(selectedAmount); afterRejected.turn = 5;
  const rejectedSelection = structuredClone(selection); rejectedSelection.turn = 4; rejectedSelection.requestId = "rejected-selection";
  rejectedSelection.hostReceipt!.outcome = "rejected"; delete rejectedSelection.hostReceipt!.selectedRequestId;
  assert.equal(scoreAmount(afterRejected, [...selectedHistory, { question: "选择金额基准 invalid", actual: rejectedSelection }]).amountEvidenceProofPassed, false,
    "A later rejected selection must not revive an earlier selected token");
  const expired = structuredClone(comparison); expired.result!.evidence.amountChoices!.candidates[0]!.expiresAt = now;
  assert.equal(scoreAmount(expired).amountEvidenceProofPassed, false, "TTL is checked at the actual read time");
  const extended = structuredClone(comparison); extended.result!.evidence.amountChoices!.candidates[0]!.expiresAt += 60_000;
  assert.equal(scoreAmount(extended).amountEvidenceProofPassed, false, "A trace cannot invent a later expiry");
  console.log("C1 pure scoring checks passed: schema/manifest, planned denominators, fresh authorization and declared metadata replay, unknown/invalid/extra evidence, reply/topic bindings; no final dataset or API.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) checkC1ValidationScoring();
