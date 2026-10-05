import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { contentHash, rerankInstruction } from "../src/bailian.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { acceptEvidence } from "../src/evidence-acceptance.ts";
import { applyEvidenceSupport, evidenceSupportInputHash, evidenceSupportRequestHash, evidenceSupportValidationVersion,
  validateEvidenceSupportVerification, type EvidenceSupportSettings, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import type { EvalRunDetail, EvalSpan, EvalTurn } from "../src/evaluation.ts";
import { buildKnowledgeApplicabilityContext, gateKnowledgeApplicability, knowledgeApplicabilitySourceHash,
  validateKnowledgeApplicabilitySnapshot, type KnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { applyKnowledgeApplicabilityGate, finishKnowledgeApplicabilityAcceptance, knowledgeApplicabilitySettings, type KnowledgeTrace } from "../src/knowledge-service.ts";
import { scopeDocuments, serializeRetrievalDocument, type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { buildSupportEvidenceBinding, evidenceBindingVersion } from "../src/support-evidence-context.ts";
import type { SupportKnowledgeContext } from "../src/support-controller.ts";
import { parseContextSupportAction } from "../src/support-context-action.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Contract = { caseId: string; turn: number; purpose: "refund_eligibility" | "business_prerequisite" | "user_policy";
  kind: "evidence" | "empty" | "unknown" | "database_error" };
export const businessEvidenceContracts: readonly Contract[] = [
  { caseId: "consult-without-application", turn: 1, purpose: "refund_eligibility", kind: "evidence" },
  { caseId: "approved-prepare-repeat", turn: 2, purpose: "business_prerequisite", kind: "evidence" },
  { caseId: "approved-prepare-repeat", turn: 3, purpose: "business_prerequisite", kind: "evidence" },
  { caseId: "unique-focus-followup", turn: 2, purpose: "refund_eligibility", kind: "evidence" },
  { caseId: "claimed-approval", turn: 1, purpose: "business_prerequisite", kind: "evidence" },
  { caseId: "missing-policy-evidence", turn: 1, purpose: "business_prerequisite", kind: "empty" },
  { caseId: "unknown-policy-fact", turn: 1, purpose: "user_policy", kind: "unknown" },
  { caseId: "knowledge-service-unavailable", turn: 1, purpose: "business_prerequisite", kind: "database_error" },
];
const checkerVersion = "c1-business-evidence-v4";
type EvidenceBindingVersion = "order-evidence-binding-v2";
type QueryMode = "combined" | "separated";
const registryPath = "data/knowledge-applicability.json";
const checkNames = ["coverage", "trusted_context", "recorded_evidence", "applicability", "semantic_contract"] as const;
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected an object"); return value as Record<string, unknown>;
};
const normalizeScope = (scope: { shopId?: string | null; productId?: string | null }) => ({ shopId: scope.shopId ?? null, productId: scope.productId ?? null });

function corpusFromSnapshot(business: Record<string, unknown>): RetrievalDocument[] {
  assert.ok(Array.isArray(business.knowledge));
  const documents = business.knowledge.map(raw => {
    const row = object(raw);
    return { id: row.id, tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags, title: row.title, body: row.body,
      shopId: row.shop_id, productId: row.product_id ?? null, status: row.status } as RetrievalDocument;
  });
  scopeDocuments(documents, {}); // Validate every document, including documents outside the current scope.
  return documents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function trustedContext(turn: EvalTurn, call: EvalSpan, contract: Contract, expectedEvidenceBindingVersion?: EvidenceBindingVersion, queryMode?: QueryMode) {
  const spans = turn.spans!, { context, trace } = call.knowledge!, protocol = object(turn.observations?.protocol);
  const action = parseContextSupportAction(protocol.action);
  if (expectedEvidenceBindingVersion) assert.equal(context.evidenceBindingVersion, expectedEvidenceBindingVersion, "Frozen binding version cannot be omitted or downgraded");
  const modern = context.evidenceBindingVersion !== undefined;
  if (queryMode !== undefined) assert.ok(modern, "Query plan requires reconstructable current host context");
  if (modern) assert.equal(context.evidenceBindingVersion, evidenceBindingVersion);
  else { assert.equal(context.evidenceTarget, undefined); assert.equal(context.evidenceUse, undefined); }
  const purpose = action.kind === "refund_eligibility" ? "refund_eligibility"
    : ["refund_prepare", "merchant_prepare"].includes(action.kind) ? "business_prerequisite" : action.kind === "policy" ? "user_policy" : null;
  // The fixed unknown-fact fixture requires a read-only consultation, not a
  // particular classifier label. Its actual action still determines the gate.
  if (contract.kind === "unknown" || modern && contract.purpose === "refund_eligibility") assert.ok(purpose === "user_policy" || purpose === "refund_eligibility");
  else assert.equal(purpose, contract.purpose);
  if (!modern) assert.equal(context.purpose, purpose);
  assert.equal(context.protocol, "v2.2");
  assert.equal(context.originalQuery, turn.question); assert.equal(trace.originalQuery, turn.question);
  assert.equal(object(call.input).query, context.effectiveQuery);
  if (queryMode === undefined) assert.equal(context.effectiveQuery, trace.query);
  assert.deepEqual(normalizeScope(object(call.input)), normalizeScope(trace.scope));
  const parent = spans.filter(span => span.id === call.parentSpanId);
  assert.equal(parent.length, 1); assert.equal(parent[0]!.name, "turn"); assert.equal(parent[0]!.component, "qq-ingress");
  const reads = spans.slice(0, spans.indexOf(call)).filter(span => span.name === "get_order" && span.component === "business-service"
    && span.outcome === "ok" && span.parentSpanId === call.parentSpanId);
  assert.equal(reads.length, 1, "Exactly one successful current-request order read must precede knowledge");
  const order = reads[0]!.output as Order;
  assert.equal(object(reads[0]!.input).orderId, order.id);
  assert.ok("orderRef" in action && action.orderRef, "Order-bound consultation must have an actual order reference");
  if (action.orderRef.kind === "explicit") assert.equal(action.orderRef.orderId, order.id);
  assert.equal(context.scopeSource, "fresh_order"); assert.equal(context.facts?.orderId, order.id);
  assert.equal(context.facts.asOf, order.asOf); assert.equal(context.facts.status, order.status);
  assert.equal(order.items.length, 1); assert.equal(order.items[0]!.quantity, 1); assert.equal(order.coupons.length, 1);
  assert.equal(order.coupons[0]!.status, "unused"); assert.equal(order.coupons[0]!.orderItemId, order.items[0]!.id);
  assert.equal(order.status, "paid"); assert.ok(order.amounts.paidCents > 0); assert.equal(order.amounts.refundedCents, 0);
  assert.ok(order.coupons[0]!.expiresAt);
  assert.ok(Date.parse(order.coupons[0]!.expiresAt) > Date.parse(order.asOf), "Single unused coupon must also be unexpired");
  assert.equal(context.facts.productId, order.items[0]!.productId); assert.equal(context.facts.productName, order.items[0]!.productName);
  assert.deepEqual(context.facts.couponCounts, { total: 1, unused: 1, redeemed: 0, expired: 0, refunded: 0 });
  assert.deepEqual(normalizeScope(trace.scope), { shopId: order.shop.id, productId: order.items[0]!.productId });
  let rebuilt: ReturnType<typeof buildSupportEvidenceBinding> | undefined;
  if (modern) {
    // These fixed DB probes do not carry prior-topic provenance. Do not invent
    // actor/history authority from the trace; a new previous-topic input fails.
    if ("questionContext" in action) assert.equal(action.questionContext.kind, "standalone", "Business audit lacks independently recorded previous-topic history");
    assert.equal(context.policyTopic, null); assert.equal(context.objectReference, null);
    if (action.orderRef.kind === "explicit") assert.ok(turn.question.includes(order.id), "Explicit current order must occur in the real input");
    assert.equal(context.orderSource, action.orderRef.kind === "explicit" ? "current_explicit" : "verified_focus");
    assert.notEqual(action.orderRef.kind, "alternative", "Fixed DB probes do not establish competing-order provenance");
    assert.equal(context.modelQuestion, "question" in action ? action.question : null);
    rebuilt = buildSupportEvidenceBinding({ action, originalQuery: turn.question, requestId: call.parentSpanId!, order,
      // No output field depends on this unavailable identity for standalone
      // targets. Previous-topic targets were rejected above, before replay.
      binding: { sourceKey: "not-collected-in-business-recording", groupOpenid: "", orderId: order.id } });
    for (const key of ["evidenceBindingVersion", "evidenceTarget", "evidenceUse", "purpose", "facts", "effectiveQuery"] as const) assert.deepEqual(context[key], rebuilt[key], `Rebuilt ${key}`);
    assert.deepEqual(context.applicability ?? null, rebuilt.applicability ?? null);
    if (queryMode !== undefined) {
      assert.ok(queryMode === "combined" || queryMode === "separated");
      assert.equal(context.retrievalQuery, rebuilt.retrievalQuery);
      const queries = { version: "knowledge-query-plan-v1", mode: queryMode,
        retrieval: queryMode === "separated" ? rebuilt.retrievalQuery : rebuilt.effectiveQuery, evidence: rebuilt.effectiveQuery };
      assert.deepEqual(trace.queries, queries, "Both provider questions must match fresh host reconstruction and frozen mode");
      assert.equal(trace.query, queries.retrieval);
      assert.equal(object(call.input).retrievalQuery, rebuilt.retrievalQuery);
    }
  }
  if (contract.kind === "unknown") {
    assert.ok(action.kind === "policy" || action.kind === "refund_eligibility");
    assert.equal(action.questionContext.kind, "standalone");
    assert.equal(context.modelQuestion, action.question); assert.equal(context.policyTopic, null); assert.equal(context.objectReference, null);
    // Verify the actual provider question, not just an originalQuery label or
    // self-consistent request hashes. Only current authorized facts may follow it.
    const expectedQuery = rebuilt?.effectiveQuery ?? (turn.question.trim() + `\n已核实订单商品：${order.items[0]!.productName}。`
      + (purpose === "refund_eligibility" ? "\n订单状态对应的规则条件：未核销退款。"
        + "\n已核实本单券数：共1张，未核销1张、已核销0张、已过期0张、已退款0张（按券状态字段计数）。" : ""))
      .replaceAll(`订单 ${order.id}`, "该订单").replaceAll(`订单${order.id}`, "该订单").replaceAll(order.id, "该订单");
    assert.equal(context.effectiveQuery, expectedQuery, "Unknown-fact consultation must retain the complete original question and only fresh authorized context");
    assert.deepEqual(turn.observations?.before, turn.observations?.after);
    assert.ok(spans.every(span => span.component !== "business-service" || ["get_order", "search_faq"].includes(span.name)),
      "Unknown-fact consultation cannot initiate business writes");
  }
  if (rebuilt) return rebuilt.applicability ?? null;
  return purpose === "user_policy" ? null : buildKnowledgeApplicabilityContext({ order, requestId: call.parentSpanId!, purpose: purpose! });
}

function recordedEvidence(turn: EvalTurn, call: EvalSpan, contract: Contract, corpus: RetrievalDocument[], mode: "model_only" | "declared",
  registry: KnowledgeApplicabilitySnapshot | undefined, configuration: Record<string, unknown>, expectedEvidenceBindingVersion?: EvidenceBindingVersion) {
  const { trace, context } = call.knowledge!;
  const evidenceQuery = configuration.knowledgeQueryMode === undefined ? trace.query : context.effectiveQuery;
  assert.equal(call.name, "search_faq"); assert.equal(call.component, "business-service"); assert.equal(call.outcome, "ok");
  assert.equal(trace.mode, "m4-support"); assert.equal(trace.threshold, configuration.knowledgeThreshold);
  assert.equal(trace.supportProfile, configuration.knowledgeSupport); assert.equal(trace.supportModel, configuration.knowledgeSupportModel);
  assert.equal(trace.applicability?.mode ?? "model_only", mode); assert.equal(call.usage, undefined);
  if (contract.kind === "database_error") {
    assert.equal(trace.status, "unavailable"); assert.equal(trace.reason, "database_unavailable");
    assert.deepEqual(call.output, []); assert.deepEqual(trace.calls, []); assert.deepEqual(trace.rawRanking, []);
    assert.deepEqual(trace.sourceHashes, { before: null, after: null }); assert.deepEqual(trace.sources, []); assert.equal(trace.acceptance, null);
    assert.equal(trace.applicability?.gate, undefined); assert.equal(trace.settings?.applicability, undefined); assert.equal(trace.supportVerification, undefined);
    assert.ok(!trace.stages?.some(stage => stage.name === "applicability" || stage.name === "support"));
    assert.ok(turn.spans!.every(span => !["knowledge-rerank", "knowledge-support"].includes(span.component)
      && (span.component !== "business-service" || ["get_order", "search_faq"].includes(span.name))), "Database fault cannot start providers or writes");
    assert.deepEqual(turn.observations?.before, turn.observations?.after);
    return { gate: "not_evaluated" as const, support: "not_evaluated" as const };
  }
  const documents = contract.kind === "empty" ? [] : scopeDocuments(corpus, trace.scope), originalRanking = contentHash(trace.rawRanking);
  assert.equal(trace.sourceHashes.before, contentHash(documents)); assert.equal(trace.sourceHashes.after, contentHash(documents));
  assert.equal(trace.reason, null); assert.equal(trace.rawRanking.length, documents.length);
  assert.equal(new Set(trace.rawRanking.map(row => row.id)).size, documents.length);
  assert.ok(trace.rawRanking.every((row, index) => documents.some(doc => doc.id === row.id) && typeof row.score === "number"
    && Number.isFinite(row.score) && row.score >= 0 && row.score <= 1 && (!index || row.score <= trace.rawRanking[index - 1]!.score!)));
  const rerank = trace.calls.filter(item => item.operation === "rerank");
  assert.equal(rerank.length, documents.length ? 1 : 0);
  if (documents.length) {
    const settings = trace.settings?.rerank; assert.ok(settings); assert.equal(settings.rerankModel, "qwen3-rerank");
    assert.equal(settings.rerankInstruction, rerankInstruction); assert.equal(settings.retries, 0);
    assert.equal(trace.settings?.serialization, "json-title-tags-body-v1");
    assert.equal(rerank[0]!.requestHash, contentHash({ endpoint: settings.endpoints.rerank, body: { model: "qwen3-rerank", query: trace.query,
      documents: documents.map(serializeRetrievalDocument), top_n: documents.length, instruct: rerankInstruction } }));
    assert.equal(rerank[0]!.status, "ok"); assert.equal(rerank[0]!.attempts.length, 1); assert.equal(rerank[0]!.attempts[0]!.outcome, "ok");
    assert.equal(rerank[0]!.attempts[0]!.model, "qwen3-rerank"); assert.equal(rerank[0]!.attempts[0]!.attempt, 1);
  }
  let prepared = acceptEvidence({ query: trace.query, scope: trace.scope, documents, ranking: trace.rawRanking, config: { mode: "support", threshold: trace.threshold! } });
  let gate;
  if (mode === "declared") {
    assert.ok(registry, "Declared audit requires the exact independently frozen registry");
    const fresh = trustedContext(turn, call, contract, expectedEvidenceBindingVersion, configuration.knowledgeQueryMode as QueryMode | undefined);
    assert.deepEqual(context.applicability ?? null, fresh);
    gate = gateKnowledgeApplicability({ snapshot: registry, context: fresh, scope: trace.scope, candidates: prepared.pendingSupport ?? [] });
    const { candidates: _candidates, ...audit } = gate;
    assert.deepEqual(trace.applicability?.gate, audit); assert.deepEqual(trace.settings?.applicability, knowledgeApplicabilitySettings(registry));
    prepared = applyKnowledgeApplicabilityGate(prepared, gate);
  } else { assert.equal(trace.applicability?.gate, undefined); assert.equal(trace.settings?.applicability, undefined); }
  const support = trace.calls.filter(item => item.operation === "support");
  if (prepared.pendingSupport?.length) {
    const settings = trace.settings?.support, verification = trace.supportVerification;
    assert.ok(settings && verification);
    assert.equal(settings.profile ?? "binary", configuration.knowledgeSupport);
    if (configuration.knowledgeSupportModel === "deepseek-v4-pro") { assert.equal(settings.provider, "deepseek"); assert.equal(settings.model, "deepseek-v4-pro"); }
    assert.ok(validateEvidenceSupportVerification(verification, { query: evidenceQuery, scope: trace.scope, candidates: prepared.pendingSupport, settings }), "Support input, candidate bodies, ranks and settings must bind");
    assert.equal(support.length, 1); assert.equal(support[0]!.requestHash, verification.requestHash); assert.deepEqual(support[0]!.attempts, verification.attempts);
    assert.equal(support[0]!.status, "ok"); assert.equal(verification.attempts.length, 1);
    assert.equal(verification.validation?.status, "complete"); assert.deepEqual(verification.validation.invalidDecisions, []);
    prepared = applyEvidenceSupport({ prepared, verification, query: evidenceQuery, scope: trace.scope, documents, settings });
  } else { assert.equal(support.length, 0); assert.equal(trace.supportVerification, undefined); }
  if (contract.kind === "unknown") assert.equal(support.length, 1, "Unknown-fact rejection must include a complete actual support judgment");
  if (contract.kind === "empty") assert.deepEqual(trace.calls, [], "Injected empty corpus has no provider calls");
  assert.equal(trace.calls.length, rerank.length + support.length);
  const providerSpans = turn.spans!.filter(span => ["knowledge-rerank", "knowledge-support"].includes(span.component));
  assert.equal(providerSpans.length, trace.calls.length);
  for (const provider of trace.calls) {
    const recorded = providerSpans.filter(span => span.parentSpanId === call.id && span.component === `knowledge-${provider.operation}` && span.name === provider.operation);
    assert.equal(recorded.length, 1); assert.equal(recorded[0]!.outcome, "ok"); assert.equal(object(recorded[0]!.input).requestHash, provider.requestHash);
  }
  prepared = finishKnowledgeApplicabilityAcceptance(prepared, gate);
  assert.deepEqual(trace.acceptance, prepared); assert.equal(trace.status, prepared.status); assert.notEqual(trace.status, "unavailable");
  const output = prepared.accepted.map(entry => {
    const doc = documents.find(item => item.id === entry.id)!;
    return { source: "demo-knowledge", sourceId: doc.id, title: doc.title, body: doc.body, scope: { shopId: doc.shopId, productId: doc.productId ?? null } };
  });
  assert.deepEqual(call.output, output); assert.deepEqual(trace.sources, output.map(doc => ({ sourceId: doc.sourceId, version: contentHash(doc) })));
  assert.equal(contentHash(trace.rawRanking), originalRanking, "Gate/replay must not rewrite the raw ranking");
  return { gate: mode === "declared" ? gate!.integrity ? "complete" as const : "incomplete" as const
    : trace.applicability ? "not_enabled" as const : "not_recorded" as const, support: "complete" as const };
}

export function auditC1BusinessEvidence(artifact: EvalRunDetail, artifactHash: string, registry?: KnowledgeApplicabilitySnapshot,
  expectedEvidenceBindingVersion?: EvidenceBindingVersion, expectedQueryMode?: QueryMode) {
  const snapshot = artifact.run.snapshot, configuration = object(snapshot.content.settings), business = object(snapshot.content.business);
  const globalIssues: string[] = [];
  const attempt = (fn: () => void) => { try { fn(); } catch (error) { globalIssues.push(error instanceof Error ? error.message : "Invalid snapshot"); } };
  attempt(() => assert.equal(snapshot.hashes.business, contentHash(business), "Business snapshot hash mismatch"));
  attempt(() => assert.equal(snapshot.hashes.dataset, contentHash({ plan: snapshot.content.evaluation, dataset: snapshot.content.dataset }), "Dataset snapshot hash mismatch"));
  attempt(() => assert.equal(artifact.run.suiteId, "support-business-live-development-v2"));
  attempt(() => assert.equal(artifact.run.status, "completed"));
  const mode = configuration.knowledgeApplicability ?? "model_only";
  attempt(() => assert.ok(mode === "model_only" || mode === "declared"));
  const queryMode = expectedQueryMode ?? configuration.knowledgeQueryMode as QueryMode | undefined;
  attempt(() => assert.ok(queryMode === undefined || queryMode === "combined" || queryMode === "separated"));
  if (expectedQueryMode !== undefined) attempt(() => assert.equal(configuration.knowledgeQueryMode, expectedQueryMode, "Run query mode differs from the independently frozen candidate"));
  if (mode === "declared") attempt(() => {
    assert.ok(registry, "Missing frozen declaration registry");
    assert.equal(object(object(snapshot.content.implementation).files)[registryPath], registry.sha256, "Registry must match the run's frozen sidecar hash");
    const { sha256, ...manifest } = registry; validateKnowledgeApplicabilitySnapshot(manifest, sha256);
  });
  let corpus: RetrievalDocument[] = []; attempt(() => { corpus = corpusFromSnapshot(business); });
  const all = artifact.cases.flatMap(item => item.turns.map(turn => ({ caseId: item.id, turn })));
  const unexpected = all.filter(item => (item.turn.spans ?? []).some(span => span.knowledge || span.name === "search_faq")
    && !businessEvidenceContracts.some(row => row.caseId === item.caseId && row.turn === item.turn.index))
    .map(item => ({ caseId: item.caseId, turn: item.turn.index, actualKnowledgeCalls: item.turn.spans!.filter(span => span.knowledge || span.name === "search_faq").length }));
  const rows = businessEvidenceContracts.map(contract => {
    const matching = all.filter(row => row.caseId === contract.caseId && row.turn.index === contract.turn), turn = matching[0]?.turn;
    const calls = turn?.spans?.filter(span => span.knowledge || span.name === "search_faq") ?? [], call = calls[0];
    const checks: Array<{ name: typeof checkNames[number]; passed: boolean; issue?: string }> = [];
    const check = (name: typeof checkNames[number], fn: () => void) => {
      try { fn(); checks.push({ name, passed: true }); }
      catch (error) { checks.push({ name, passed: false, issue: error instanceof Error ? error.message : "Invalid evidence" }); }
    };
    let proof: ReturnType<typeof recordedEvidence> | undefined;
    check("coverage", () => { assert.equal(matching.length, 1); assert.equal(calls.length, 1); assert.ok(call?.knowledge); assert.notEqual(turn?.status, "skipped");
      assert.equal(new Set(turn!.spans!.map(span => span.id)).size, turn!.spans!.length);
      const fixtureCases = object(snapshot.content.dataset).cases; assert.ok(Array.isArray(fixtureCases));
      const declared = fixtureCases.filter(item => object(item).id === contract.caseId); assert.equal(declared.length, 1);
      assert.equal(object(declared[0]).knowledge, contract.kind === "empty" ? "empty" : contract.kind === "database_error" ? "error" : "normal",
        "Only the frozen explicit fixture may inject an empty corpus or database fault"); });
    check("trusted_context", () => { assert.ok(call?.knowledge && turn); trustedContext(turn, call, contract, expectedEvidenceBindingVersion, queryMode); });
    check("recorded_evidence", () => { assert.ok(call?.knowledge && turn); proof = recordedEvidence(turn, call, contract, corpus, mode as "model_only" | "declared", registry, configuration, expectedEvidenceBindingVersion); });
    check("applicability", () => { assert.ok(proof); if (mode === "declared" && contract.kind !== "database_error") assert.equal(proof.gate, "complete"); });
    const expected = contract.kind === "evidence" ? ["KB-REFUND-UNUSED"] : [];
    const accepted = Array.isArray(call?.output) ? call.output.map(doc => object(doc).sourceId) : [];
    check("semantic_contract", () => { assert.ok(call?.knowledge); assert.deepEqual([...accepted].sort(), expected);
      assert.deepEqual(call.knowledge.trace.acceptance?.accepted.map(doc => doc.id).sort() ?? [], expected);
      assert.equal(call.knowledge.trace.status, contract.kind === "database_error" ? "unavailable" : expected.length ? "accepted" : "rejected"); });
    return { caseId: contract.caseId, turn: contract.turn, kind: contract.kind, passed: checks.every(row => row.passed), checks,
      acceptedIds: accepted, extraAcceptedIds: accepted.filter(id => !expected.includes(String(id))), missingExpectedIds: expected.filter(id => !accepted.includes(id)),
      applicability: proof?.gate ?? (call?.knowledge?.trace.applicability ? "incomplete" : "not_recorded"),
      supportCompleteness: proof?.support ?? "incomplete", actualKnowledgeCalls: calls.length };
  });
  return { checkerVersion, runId: artifact.run.id, artifactHash, scope: "Additional development evidence audit; original business checks and historical scores are unchanged",
    authority: "Frozen corpus and registry hashes plus recorded host spans; standalone DB probes only, no prior-topic/actor replay or claim of final-answer quality",
    evidenceBindingVersion: expectedEvidenceBindingVersion ?? null, applicabilityMode: mode, queryMode: queryMode ?? null,
    passed: !globalIssues.length && !unexpected.length && rows.every(row => row.passed), globalIssues, unexpected,
    counts: { plannedTurns: 8, presentTurns: rows.filter(row => row.actualKnowledgeCalls > 0).length, passedTurns: rows.filter(row => row.passed).length,
      plannedChecks: 8 * checkNames.length, passedChecks: rows.reduce((n, row) => n + row.checks.filter(check => check.passed).length, 0),
      actualKnowledgeCalls: all.reduce((n, item) => n + (item.turn.spans ?? []).filter(span => span.knowledge || span.name === "search_faq").length, 0),
      knowledgeIntegrity: { planned: 7, passed: rows.filter(row => row.kind !== "database_error" && row.checks.filter(check => check.name !== "semantic_contract").every(check => check.passed)).length },
    controlledDatabaseFault: { planned: 1, passed: rows.filter(row => row.kind === "database_error" && row.passed).length, applicability: "not_evaluated" } }, rows };
}

export function checkC1BusinessEvidenceAudit() {
  // In-memory protocol probes, not model judgments or persisted validation examples.
  const documents: RetrievalDocument[] = [
    { id: "KB-REFUND-PARTIAL", tags: [], title: "unit", body: "Two coupons required.", shopId: null, productId: null, status: "active" },
    { id: "KB-REFUND-UNUSED", tags: [], title: "unit", body: "Unused paid coupon rule.", shopId: null, productId: null, status: "active" },
  ];
  const registry = validateKnowledgeApplicabilitySnapshot({ version: 1, serialization: "knowledge-document-v1", documents: documents.map(doc => ({
    sourceId: doc.id, scope: { shopId: null, productId: null }, sourceHash: knowledgeApplicabilitySourceHash(doc),
    ...(doc.id.endsWith("PARTIAL") ? { minimumCouponCount: 2, basis: [{ field: "minimumCouponCount", quote: "Two coupons required." }] }
      : { atLeastOneCouponInStates: ["unused"], basis: [{ field: "atLeastOneCouponInStates", quote: "Unused paid coupon rule." }] }), reviewNote: "Synthetic unit fixture" })) });
  const order: Order = { source: "demo-database", id: "COUPON-9999", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
    amounts: { totalCents: 100, paidCents: 100, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "unit-shop", name: "unit", merchantName: "unit", address: "unit" },
    items: [{ id: "unit-item", productId: "unit-product", productName: "unit", quantity: 1, unitPriceCents: 100, totalCents: 100 }],
    coupons: [{ id: "unit-coupon", orderItemId: "unit-item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 100, paidAt: null }], refunds: [] };
  const supportSettings: EvidenceSupportSettings = { provider: "deepseek", model: "deepseek-v4-pro", api: "openai-completions", endpoint: "https://api.deepseek.com",
    timeoutMs: 1000, temperature: 0, maxTokens: 2048, maxRetries: 0, promptVersion: "unit", promptHash: contentHash("unit"),
    serialization: "unit", serializationHash: contentHash("unit"), profile: "typed", validationVersion: evidenceSupportValidationVersion,
    pricing: { currency: "USD", estimated: true, source: "Pi model catalog", rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  const business = { knowledge: documents.map(doc => ({ id: doc.id, title: doc.title, body: doc.body, tags: doc.tags,
    shop_id: doc.shopId, product_id: doc.productId, status: doc.status })) };
  const dataset = { cases: [...new Map(businessEvidenceContracts.map(contract => [contract.caseId, { id: contract.caseId,
    knowledge: contract.kind === "empty" ? "empty" : contract.kind === "database_error" ? "error" : "normal" }])).values()] };
  const plan = { unit: true };
  function fixtureArtifact(modern = false, queryMode?: QueryMode) {
  const artifact = { run: { id: "unit-only", suiteId: "support-business-live-development-v2", status: "completed", snapshot: {
    hashes: { business: contentHash(business), dataset: contentHash({ plan, dataset }) }, content: { business, dataset, evaluation: plan, settings: { knowledgeMode: "m4-support", knowledgeSupport: "typed",
      knowledgeSupportModel: "deepseek-v4-pro", knowledgeThreshold: .5, knowledgeApplicability: "declared", ...(queryMode ? { knowledgeQueryMode: queryMode } : {}) },
    implementation: { files: { [registryPath]: registry.sha256 } } } } }, cases: [] } as unknown as EvalRunDetail;
  for (const [index, contract] of businessEvidenceContracts.entries()) {
    const requestId = `request-${index}`, question = contract.kind === "unknown" ? "COUPON-9999 这张券会额外扣几元服务费？请给出明确金额。" : modern ? "订单 COUPON-9999 退款资格咨询" : "Synthetic input",
      scope = { shopId: order.shop.id, productId: order.items[0]!.productId };
    let query = contract.kind === "unknown" ? "该订单 这张券会额外扣几元服务费？请给出明确金额。\n已核实订单商品：unit。" : question;
    const action = { protocol: "v2.2", kind: contract.purpose === "refund_eligibility" ? "refund_eligibility"
      : contract.purpose === "business_prerequisite" ? "refund_prepare" : "policy", orderRef: { kind: "explicit", orderId: order.id },
      ...(contract.purpose !== "business_prerequisite" ? { question, questionContext: { kind: "standalone" } } : {}) };
    const rebuilt = modern ? buildSupportEvidenceBinding({ action: parseContextSupportAction(action), originalQuery: question, order, requestId,
      binding: { sourceKey: "not-collected-in-business-recording", groupOpenid: "", orderId: order.id } }) : undefined;
    if (rebuilt) query = rebuilt.effectiveQuery;
    const rankingQuery = queryMode === "separated" ? rebuilt!.retrievalQuery : query;
    const trace: KnowledgeTrace = { mode: "m4-support", supportProfile: "typed", supportModel: "deepseek-v4-pro", threshold: .5,
      applicability: { mode: "declared" }, query: rankingQuery, originalQuery: question, scope, status: "unavailable", reason: null,
      ...(queryMode ? { queries: { version: "knowledge-query-plan-v1", mode: queryMode, retrieval: rankingQuery, evidence: query } } as const : {}),
      rawRanking: [], acceptance: null, sources: [], sourceHashes: { before: null, after: null }, durationMs: 1, calls: [],
      usage: { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
      pricing: { estimated: true, rerankCnyPerMillionTokens: .5, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" } };
    const context: SupportKnowledgeContext = { protocol: "v2.2" as const, originalQuery: question, modelQuestion: modern && contract.purpose !== "business_prerequisite" || contract.kind === "unknown" ? question : null, effectiveQuery: query, purpose: contract.purpose,
      orderSource: "current_explicit" as const, scopeSource: "fresh_order" as const, facts: { orderId: order.id, asOf: order.asOf, status: order.status,
        productId: order.items[0]!.productId, productName: order.items[0]!.productName, refundState: "未核销退款",
        couponCounts: { total: 1, unused: 1, redeemed: 0, expired: 0, refunded: 0 } }, policyTopic: null, objectReference: null,
      ...(contract.purpose === "user_policy" ? {} : { applicability: buildKnowledgeApplicabilityContext({ order, requestId, purpose: contract.purpose }) }), ...rebuilt };
    const common = { actor: "host" as const, trigger: "user" as const, observedAt: order.asOf, durationMs: 1, outcome: "ok" as const };
    const call: EvalSpan = { ...common, id: `${requestId}:knowledge`, parentSpanId: requestId, component: "business-service", name: "search_faq",
      input: { query, ...(queryMode ? { retrievalQuery: rebuilt!.retrievalQuery } : {}), ...scope }, output: [], knowledge: { context, trace } };
    if (contract.kind === "database_error") trace.reason = "database_unavailable";
    else {
      const corpus = contract.kind === "empty" ? [] : documents;
      trace.sourceHashes = { before: contentHash(corpus), after: contentHash(corpus) };
      trace.rawRanking = [...corpus].reverse().map((doc, rank) => ({ id: doc.id, score: .9 - rank * .1 }));
      const rerankSettings = { endpoints: { origin: "https://unit.invalid", embedding: "https://unit.invalid/embedding", rerank: "https://unit.invalid/rerank" },
        timeoutMs: 1000, retries: 0, embeddingModel: "text-embedding-v4", dimensions: 1024, rerankModel: "qwen3-rerank", rerankInstruction };
      trace.settings = { serialization: "json-title-tags-body-v1", ...(corpus.length ? { rerank: rerankSettings } : {}), applicability: knowledgeApplicabilitySettings(registry) };
      if (corpus.length) trace.calls.push({ operation: "rerank", status: "ok", requestHash: contentHash({ endpoint: rerankSettings.endpoints.rerank,
        body: { model: "qwen3-rerank", query: rankingQuery, documents: corpus.map(serializeRetrievalDocument), top_n: corpus.length, instruct: rerankInstruction } }),
        attempts: [{ kind: "rerank", model: "qwen3-rerank", attempt: 1, durationMs: 1, httpStatus: 200, outcome: "ok", totalTokens: 1, requestId: null }] });
      const initial = acceptEvidence({ query: rankingQuery, scope, documents: corpus, ranking: trace.rawRanking, config: { mode: "support", threshold: .5 } });
      const gate = gateKnowledgeApplicability({ snapshot: registry, context: context.applicability ?? null, scope, candidates: initial.pendingSupport ?? [] });
      const { candidates: _candidates, ...audit } = gate; trace.applicability!.gate = audit;
      let prepared = applyKnowledgeApplicabilityGate(initial, gate);
      if (prepared.pendingSupport?.length) {
        trace.settings.support = supportSettings;
        const input = { query, scope, candidates: prepared.pendingSupport, settings: supportSettings };
        const value = input.candidates.map(doc => ({ id: doc.id, supported: contract.kind === "evidence", category: contract.kind === "evidence" ? "direct_fact" as const : "unrelated" as const,
          quote: contract.kind === "evidence" ? doc.body : null, reason: "Synthetic checker probe" }));
        const verification: EvidenceSupportVerification = { value, inputHash: evidenceSupportInputHash(input), requestHash: evidenceSupportRequestHash(input),
          attempts: [{ operation: "support", provider: supportSettings.provider, model: supportSettings.model, attempt: 1, durationMs: 1,
            outcome: "ok", totalTokens: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null }],
          validation: { status: "complete", outputHash: contentHash(value), invalidDecisions: [] } };
        trace.supportVerification = verification; trace.calls.push({ operation: "support", status: "ok", requestHash: verification.requestHash, attempts: verification.attempts });
        prepared = applyEvidenceSupport({ prepared, verification, query, scope, documents: corpus, settings: supportSettings });
      }
      trace.acceptance = finishKnowledgeApplicabilityAcceptance(prepared, gate); trace.status = trace.acceptance.status;
      call.output = trace.acceptance.accepted.map(doc => ({ source: "demo-knowledge", sourceId: doc.id, title: doc.title, body: doc.body, scope: { shopId: null, productId: null } }));
      trace.sources = (call.output as Array<{ sourceId: string }>).map(doc => ({ sourceId: doc.sourceId, version: contentHash(doc) }));
    }
    const turn = { index: contract.turn, question, status: "passed", observations: { before: {}, after: {}, protocol: { action } }, spans: [
      { ...common, id: requestId, parentSpanId: null, name: "turn", component: "qq-ingress" },
      { ...common, id: `${requestId}:order`, parentSpanId: requestId, name: "get_order", component: "business-service", input: { orderId: order.id }, output: order }, call,
      ...trace.calls.map(provider => ({ ...common, id: `${call.id}:${provider.operation}`, parentSpanId: call.id,
        component: `knowledge-${provider.operation}`, name: provider.operation, input: { requestHash: provider.requestHash } })),
    ] } as EvalTurn;
    const previous = artifact.cases.find(item => item.id === contract.caseId);
    if (previous) previous.turns.push(turn); else artifact.cases.push({ id: contract.caseId, name: "unit", category: "unit", status: "passed", turns: [turn] });
  }
  return artifact;
  }
  const artifact = fixtureArtifact();
  const score = (value = artifact, manifest = registry) => auditC1BusinessEvidence(value, contentHash(value), manifest);
  assert.equal(score().passed, true, JSON.stringify(score())); assert.equal(score().counts.plannedChecks, 40);
  const tamper = (fn: (value: EvalRunDetail) => void) => { const changed = structuredClone(artifact); fn(changed); assert.equal(score(changed).passed, false); };
  tamper(value => value.cases.shift());
  tamper(value => value.cases[0]!.turns.push(structuredClone(value.cases[0]!.turns[0]!)));
  tamper(value => value.cases.push({ ...structuredClone(value.cases[0]!), id: "unexpected-query" }));
  tamper(value => { value.cases[0]!.turns[0]!.spans![1]!.parentSpanId = "previous-request"; });
  tamper(value => { (value.cases[0]!.turns[0]!.spans![1]!.output as Order).coupons[0]!.status = "redeemed"; });
  tamper(value => { value.cases[0]!.turns[0]!.spans![2]!.knowledge!.trace.applicability!.gate!.decisions = []; });
  tamper(value => { const trace = value.cases[0]!.turns[0]!.spans![2]!.knowledge!.trace; trace.rawRanking = [...trace.rawRanking].reverse(); });
  tamper(value => { value.cases[0]!.turns[0]!.spans![2]!.knowledge!.trace.supportVerification!.value[0]!.quote = "invented"; });
  tamper(value => { value.cases[0]!.turns[0]!.spans![2]!.knowledge!.trace.supportVerification!.validation!.status = "partial"; });
  tamper(value => { (value.run.snapshot.content.business as typeof business).knowledge[0]!.body += " changed"; });
  tamper(value => { (value.run.snapshot.content.dataset as typeof dataset).cases.find(item => item.knowledge === "empty")!.knowledge = "normal"; });
  tamper(value => { (value.run.snapshot.content.implementation as { files: Record<string, string> }).files[registryPath] = "0".repeat(64); });
  tamper(value => { (value.cases[0]!.turns[0]!.spans![2]!.output as unknown[]).push({ sourceId: "KB-REFUND-PARTIAL" }); });
  tamper(value => { const t = value.cases.at(-1)!.turns[0]!; t.spans!.push({ ...t.spans![1]!, id: "late-write", name: "prepare_refund" }); });
  tamper(value => { value.cases[0]!.turns[0]!.spans!.pop(); });
  assert.equal(auditC1BusinessEvidence(artifact, contentHash(artifact)).passed, false, "Declared mode cannot audit itself without the frozen registry");
  const unknownTurn = (value: EvalRunDetail) => value.cases.find(item => item.id === "unknown-policy-fact")!.turns[0]!;
  // Rebuild every binding for an alternative read-only route. This is also used
  // to show that consistent source/gate/provider proofs cannot excuse a swapped question.
  const recordUnknownRefundQuestion = (value: EvalRunDetail, query: string) => {
    const turn = unknownTurn(value), call = turn.spans![2]!, { context, trace } = call.knowledge!;
    object(object(turn.observations!.protocol).action).kind = "refund_eligibility";
    context.purpose = "refund_eligibility"; context.effectiveQuery = query; trace.query = query; object(call.input).query = query;
    context.applicability = buildKnowledgeApplicabilityContext({ order, requestId: call.parentSpanId!, purpose: "refund_eligibility" });
    const rerank = trace.calls.find(item => item.operation === "rerank")!;
    rerank.requestHash = contentHash({ endpoint: trace.settings!.rerank!.endpoints.rerank,
      body: { model: "qwen3-rerank", query, documents: documents.map(serializeRetrievalDocument), top_n: documents.length, instruct: rerankInstruction } });
    const initial = acceptEvidence({ query, scope: trace.scope, documents, ranking: trace.rawRanking, config: { mode: "support", threshold: .5 } });
    const gate = gateKnowledgeApplicability({ snapshot: registry, context: context.applicability, scope: trace.scope, candidates: initial.pendingSupport! });
    const { candidates: _candidates, ...audit } = gate; trace.applicability!.gate = audit;
    const prepared = applyKnowledgeApplicabilityGate(initial, gate);
    const input = { query, scope: trace.scope, candidates: prepared.pendingSupport!, settings: supportSettings };
    const verification = trace.supportVerification!;
    verification.value = input.candidates.map(doc => ({ id: doc.id, supported: false, category: "unrelated", quote: null, reason: "Synthetic no-answer probe" }));
    verification.inputHash = evidenceSupportInputHash(input); verification.requestHash = evidenceSupportRequestHash(input);
    verification.validation!.outputHash = contentHash(verification.value);
    trace.calls.find(item => item.operation === "support")!.requestHash = verification.requestHash;
    for (const provider of trace.calls) turn.spans!.find(span => span.component === `knowledge-${provider.operation}`)!.input = { requestHash: provider.requestHash };
    assert.equal(validateEvidenceSupportVerification(verification, input), true, "Tamper probe itself must retain a complete valid support proof");
    trace.acceptance = finishKnowledgeApplicabilityAcceptance(applyEvidenceSupport({ prepared, verification, query, scope: trace.scope, documents, settings: supportSettings }), gate);
    trace.status = trace.acceptance.status; assert.deepEqual(trace.acceptance.accepted, []);
  };
  const equivalent = structuredClone(artifact);
  recordUnknownRefundQuestion(equivalent, "该订单 这张券会额外扣几元服务费？请给出明确金额。\n已核实订单商品：unit。"
    + "\n订单状态对应的规则条件：未核销退款。\n已核实本单券数：共1张，未核销1张、已核销0张、已过期0张、已退款0张（按券状态字段计数）。");
  assert.equal(score(equivalent).passed, true, "Actual refund_eligibility consultation is permitted with its own fresh gate and unchanged unknown question");
  const substituted = structuredClone(equivalent);
  recordUnknownRefundQuestion(substituted, "未核销退款需要满足什么条件？\n已核实订单商品：unit。"
    + "\n订单状态对应的规则条件：未核销退款。\n已核实本单券数：共1张，未核销1张、已核销0张、已过期0张、已退款0张（按券状态字段计数）。");
  const substitutedRow = score(substituted).rows.find(row => row.kind === "unknown")!;
  assert.equal(substitutedRow.passed, false);
  assert.match(substitutedRow.checks.find(row => row.name === "trusted_context")!.issue!, /complete original question/);
  const wrongPurpose = structuredClone(equivalent); unknownTurn(wrongPurpose).spans![2]!.knowledge!.context.purpose = "user_policy";
  assert.equal(score(wrongPurpose).passed, false, "Recorded purpose must follow the actual action");
  tamper(value => { const turn = unknownTurn(value); turn.spans!.push({ ...turn.spans![1]!, id: "unknown-write", name: "prepare_refund" }); });
  // A fully self-consistent model-only recording can still be semantically wrong.
  // Reconstruct the extra accepted source, rather than merely corrupting an output ID.
  const extra = structuredClone(artifact), firstTurn = extra.cases[0]!.turns[0]!, call = firstTurn.spans![2]!, trace = call.knowledge!.trace;
  delete object(extra.run.snapshot.content.settings).knowledgeApplicability; delete trace.applicability; delete trace.settings!.applicability;
  const prepared = acceptEvidence({ query: trace.query, scope: trace.scope, documents, ranking: trace.rawRanking, config: { mode: "support", threshold: .5 } });
  const input = { query: trace.query, scope: trace.scope, candidates: prepared.pendingSupport!, settings: supportSettings };
  const verification = trace.supportVerification!;
  verification.value = input.candidates.map(doc => ({ id: doc.id, supported: true, category: "direct_fact", quote: doc.body, reason: "Synthetic semantic mistake" }));
  verification.inputHash = evidenceSupportInputHash(input); verification.requestHash = evidenceSupportRequestHash(input);
  verification.validation!.outputHash = contentHash(verification.value);
  trace.calls.find(item => item.operation === "support")!.requestHash = verification.requestHash;
  firstTurn.spans!.find(span => span.name === "support")!.input = { requestHash: verification.requestHash };
  trace.acceptance = applyEvidenceSupport({ prepared, verification, query: trace.query, scope: trace.scope, documents, settings: supportSettings });
  call.output = trace.acceptance.accepted.map(doc => ({ source: "demo-knowledge", sourceId: doc.id, title: doc.title, body: doc.body, scope: { shopId: null, productId: null } }));
  trace.sources = (call.output as Array<{ sourceId: string }>).map(doc => ({ sourceId: doc.sourceId, version: contentHash(doc) }));
  const extraRow = score(extra).rows[0]!;
  assert.equal(extraRow.applicability, "not_recorded"); assert.equal(extraRow.passed, false);
  assert.deepEqual(extraRow.checks.filter(check => !check.passed).map(check => check.name), ["semantic_contract"]);
  assert.deepEqual(extraRow.extraAcceptedIds, ["KB-REFUND-PARTIAL"]);
  const modern = fixtureArtifact(true);
  const modernScore = (value = modern) => auditC1BusinessEvidence(value, contentHash(value), registry, evidenceBindingVersion);
  assert.equal(modernScore().passed, true, JSON.stringify(modernScore()));
  assert.equal(modernScore(artifact).passed, false, "A frozen new candidate cannot downgrade to an old trace");
  const modernPolicy = structuredClone(modern), modernFirst = modernPolicy.cases[0]!.turns[0]!;
  object(object(modernFirst.observations!.protocol).action).kind = "policy";
  assert.equal(modernScore(modernPolicy).passed, true, "Current-order policy and eligibility share the same reconstructed gate");
  for (const mutate of [
    (turn: EvalTurn) => { delete turn.spans![2]!.knowledge!.context.evidenceBindingVersion; },
    (turn: EvalTurn) => { turn.spans![2]!.knowledge!.context.purpose = "user_policy"; },
    (turn: EvalTurn) => { turn.spans![2]!.knowledge!.context.evidenceUse = "explanation"; },
    (turn: EvalTurn) => { turn.spans![2]!.knowledge!.context.facts!.couponDates![0]!.expiredAtAsOf = true; },
    (turn: EvalTurn) => { turn.spans![2]!.knowledge!.context.evidenceTarget!.basis = "invented condition"; },
    (turn: EvalTurn) => { turn.spans![1]!.parentSpanId = "another-request"; },
    (turn: EvalTurn) => { turn.question = "a different actual original question"; },
    (turn: EvalTurn) => { object(object(turn.observations!.protocol).action).questionContext = { kind: "previous", requestId: "unproved-history" }; },
  ]) { const changed = structuredClone(modern); mutate(changed.cases[0]!.turns[0]!); assert.equal(modernScore(changed).passed, false); }
  for (const queryMode of ["combined", "separated"] as const) {
    const planned = fixtureArtifact(true, queryMode);
    const scorePlanned = (value = planned) => auditC1BusinessEvidence(value, contentHash(value), registry, evidenceBindingVersion, queryMode);
    assert.equal(scorePlanned().passed, true, JSON.stringify(scorePlanned()));
    assert.equal(scorePlanned().counts.passedChecks, 40);
    assert.equal(scorePlanned(modern).passed, false, "An externally frozen new candidate cannot drop queryMode and replay the legacy contract");
    const original = planned.cases[0]!.turns[0]!.spans![2]!.knowledge!;
    assert.notEqual(original.context.retrievalQuery, original.context.effectiveQuery);
    const initial = acceptEvidence({ query: original.trace.query, scope: original.trace.scope, documents, ranking: original.trace.rawRanking,
      config: { mode: "support", threshold: .5 } });
    const candidates = gateKnowledgeApplicability({ snapshot: registry, context: original.context.applicability!,
      scope: original.trace.scope, candidates: initial.pendingSupport! }).candidates;
    for (const mutate of [
      (value: EvalRunDetail) => { delete object(value.run.snapshot.content.settings).knowledgeQueryMode; },
      (value: EvalRunDetail) => { object(value.run.snapshot.content.settings).knowledgeQueryMode = queryMode === "combined" ? "separated" : "combined"; },
      (value: EvalRunDetail) => { delete value.cases[0]!.turns[0]!.spans![2]!.knowledge!.trace.queries; },
      (value: EvalRunDetail) => { value.cases[0]!.turns[0]!.spans![2]!.knowledge!.trace.queries!.mode = queryMode === "combined" ? "separated" : "combined"; },
      (value: EvalRunDetail) => { const { context, trace } = value.cases[0]!.turns[0]!.spans![2]!.knowledge!;
        [trace.queries!.retrieval, trace.queries!.evidence] = [context.effectiveQuery, context.retrievalQuery!]; },
      (value: EvalRunDetail) => { delete object(value.cases[0]!.turns[0]!.spans![2]!.input).retrievalQuery; },
      (value: EvalRunDetail) => { value.cases[0]!.turns[0]!.spans![2]!.knowledge!.context.retrievalQuery = "Model substituted request"; },
      (value: EvalRunDetail) => {
        const turn = value.cases[0]!.turns[0]!, call = turn.spans![2]!, { context, trace } = call.knowledge!;
        context.effectiveQuery = context.retrievalQuery!; object(call.input).query = context.effectiveQuery; trace.queries!.evidence = context.effectiveQuery;
        const input = { query: context.effectiveQuery, scope: trace.scope, candidates, settings: trace.settings!.support! }, verification = trace.supportVerification!;
        verification.inputHash = evidenceSupportInputHash(input); verification.requestHash = evidenceSupportRequestHash(input);
        trace.calls.find(row => row.operation === "support")!.requestHash = verification.requestHash;
        turn.spans!.find(row => row.component === "knowledge-support")!.input = { requestHash: verification.requestHash };
        assert.equal(validateEvidenceSupportVerification(verification, input), true, "Forged shorter input has consistent hashes but lacks full facts/date context");
      },
    ]) { const changed = structuredClone(planned); mutate(changed); assert.equal(scorePlanned(changed).passed, false); }
    if (queryMode === "separated") {
      const wrongRanking = structuredClone(planned), turn = wrongRanking.cases[0]!.turns[0]!, trace = turn.spans![2]!.knowledge!.trace;
      const requestHash = contentHash({ endpoint: trace.settings!.rerank!.endpoints.rerank, body: { model: "qwen3-rerank", query: trace.queries!.evidence,
        documents: documents.map(serializeRetrievalDocument), top_n: documents.length, instruct: rerankInstruction } });
      trace.calls.find(row => row.operation === "rerank")!.requestHash = requestHash;
      turn.spans!.find(row => row.component === "knowledge-rerank")!.input = { requestHash };
      assert.equal(scorePlanned(wrongRanking).passed, false, "A request hash for the full query cannot masquerade as the compact rerank request");
    }
  }
  return { checkerVersion, status: "passed", scope: "In-memory mutation checks only; no DB/API", plannedTurns: 8, plannedChecks: 40 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rawArgs = process.argv.slice(2), bindingArgument = "--evidence-binding=order-evidence-binding-v2";
  const expectedEvidenceBindingVersion: EvidenceBindingVersion | undefined = rawArgs.includes(bindingArgument) ? "order-evidence-binding-v2" : undefined;
  const queryArguments = rawArgs.filter(arg => arg.startsWith("--query-mode="));
  assert.ok(queryArguments.length <= 1);
  const expectedQueryMode = queryArguments[0]?.slice("--query-mode=".length) as QueryMode | undefined;
  assert.ok(expectedQueryMode === undefined || expectedQueryMode === "combined" || expectedQueryMode === "separated");
  const args = rawArgs.filter(arg => arg !== bindingArgument && !queryArguments.includes(arg));
  assert.ok(rawArgs.filter(arg => arg === bindingArgument).length <= 1);
  if (args.length === 1 && args[0] === "--check") console.log(JSON.stringify(checkC1BusinessEvidenceAudit(), null, 2));
  else {
    assert.ok(args.length === 2 && args[0] === "--file", "Use --check or --file <synthetic-run-artifact.json> [--evidence-binding=order-evidence-binding-v2] [--query-mode=combined|separated]");
    const bytes = await readFile(args[1]!), artifact = JSON.parse(bytes.toString()) as EvalRunDetail;
    const mode = object(artifact.run.snapshot.content.settings).knowledgeApplicability;
    const registryBytes = mode === "declared" ? await readFile(new URL(`../${registryPath}`, import.meta.url)) : undefined;
    const registry = registryBytes ? validateKnowledgeApplicabilitySnapshot(JSON.parse(registryBytes.toString()), contentHash(registryBytes)) : undefined;
    const result = auditC1BusinessEvidence(artifact, contentHash(bytes), registry, expectedEvidenceBindingVersion, expectedQueryMode);
    console.log(JSON.stringify({ ...result, checkerHash: contentHash(await readFile(fileURLToPath(import.meta.url))) }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
