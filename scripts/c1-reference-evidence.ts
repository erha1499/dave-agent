import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { merchantSourceKey } from "../src/after-sales.ts";
import { currentReferenceChoices, referenceChoiceNotice, referenceChoiceTtlMs, type TrustedReference,
  type TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import type { C1ValidationActual, C1ValidationHistory } from "./c1-session-validation-check.ts";

export type C1ReferenceEvidenceOptions = {
  required?: boolean;
  verifyPolicyTopic?: (actual: C1ValidationActual, question: string, history: C1ValidationHistory) => boolean;
};
type Kind = TrustedReference["kind"];
type Candidate = TrustedReferenceChoices["candidates"][number];
type Source = { reference: TrustedReference; earliestExpiry: number; latestExpiry: number; observed?: Candidate };
type State = { sources: Source[]; overflow: boolean; selectionRequired: boolean; selectedRequestId?: string };
const empty = (): State => ({ sources: [], overflow: false, selectionRequired: false });
const sourceId = (reference: TrustedReference) => reference.kind === "order" ? reference.requestId : reference.topic.requestId;
const equal = isDeepStrictEqual;
const hasNewFields = (actual: C1ValidationActual) => Boolean(actual.result?.evidence.policyChoices || actual.result?.evidence.orderReferenceChoices
  || actual.hostReceipt?.version === "reference-selection-v1"
  || actual.hostReference && ("policyChoices" in actual.hostReference || "orderChoices" in actual.hostReference));
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected recorded object"); return value as Record<string, unknown>;
};

// Reconstruct the two small Session candidate lists from actual earlier turns.
// Runtime helpers validate shape/hash only; successful reads, original questions,
// actual presentations and host selections establish provenance independently.
export function scoreC1ReferenceEvidence(actual: C1ValidationActual, originalQuery: string, history: C1ValidationHistory,
  options: C1ReferenceEvidenceOptions = {}): { passed: boolean; issues: string[] } {
  const rows = [...history.filter(row => row.actual.caseId === actual.caseId && row.actual.turn < actual.turn), { actual, question: originalQuery }]
    .sort((a, b) => a.actual.turn - b.actual.turn);
  if (!options.required && !rows.some(row => hasNewFields(row.actual))) return { passed: true, issues: [] };
  let location = "history";
  try {
    assert.ok(actual.ingress, "Actual trusted ingress is required");
    const identity = actual.ingress.identity, groupOpenid = actual.ingress.groupOpenid;
    const binding = { sourceKey: merchantSourceKey(identity, groupOpenid), groupOpenid };
    const states: Record<Kind, State> = { order: empty(), policy: empty() };
    const presentations: Partial<Record<Kind, { requestId: string; choices: TrustedReferenceChoices }>> = {};
    let pending: Kind | undefined, focus: string | undefined, selectedOrder: string | undefined;
    const clear = () => { states.order = empty(); states.policy = empty(); delete presentations.order; delete presentations.policy;
      pending = undefined; selectedOrder = undefined; };
    const ids = new Set<string>();
    const checkChoices = (value: unknown, kind: Kind, now: number, mode: "before" | "presentation" | "selection", selectedToken?: string) => {
      const recorded = value as TrustedReferenceChoices;
      const normalized = currentReferenceChoices(recorded, binding, now);
      assert.ok(normalized && recorded.kind === kind, `${kind}: invalid candidate shape, binding, hash or token`);
      assert.deepEqual({ ...normalized, selectedToken: normalized.selectedToken }, { ...recorded, selectedToken: recorded.selectedToken },
        `${kind}: expired candidates or unnormalized ambiguity cannot be reused`);
      const state = states[kind];
      state.selectionRequired ||= state.overflow || state.sources.length > 1;
      // Expiry is bounded by the measured source turn. No wall-clock time enters replay.
      const expected = state.sources.filter(source => (source.observed?.expiresAt ?? source.latestExpiry) > now);
      const presentIds = recorded.candidates.map(candidate => sourceId(candidate.reference));
      const surviving = expected.filter(source => presentIds.includes(sourceId(source.reference)));
      assert.ok(expected.filter(source => !surviving.includes(source)).every(source => source.earliestExpiry <= now),
        `${kind}: a still-live source disappeared from the candidate set`);
      assert.deepEqual(presentIds, surviving.map(source => sourceId(source.reference)), `${kind}: candidates were invented, reordered or revived`);
      for (const [index, candidate] of recorded.candidates.entries()) {
        const source = surviving[index]!;
        assert.deepEqual(candidate.reference, source.reference, `${kind}: candidate must equal the real successful source`);
        assert.equal(candidate.version, createHash("sha256").update(JSON.stringify(source.reference)).digest("hex"));
        assert.ok(candidate.expiresAt >= source.earliestExpiry && candidate.expiresAt <= source.latestExpiry,
          `${kind}: expiry must originate inside the real source turn`);
        if (source.observed) assert.deepEqual(candidate, source.observed, `${kind}: an existing candidate token/version/expiry changed`);
        else source.observed = structuredClone(candidate);
      }
      state.sources = surviving;
      if (!surviving.some(source => sourceId(source.reference) === state.selectedRequestId)) delete state.selectedRequestId;
      assert.equal(recorded.overflow, state.overflow, `${kind}: overflow cannot be erased`);
      assert.equal(recorded.selectionRequired, mode === "presentation" ? true : state.selectionRequired,
        `${kind}: unresolved ambiguity cannot be erased`);
      const expectedToken = mode === "presentation" ? undefined : mode === "selection" ? selectedToken
        : surviving.find(source => sourceId(source.reference) === state.selectedRequestId)?.observed?.token;
      assert.equal(recorded.selectedToken, expectedToken, `${kind}: selection has no verified host receipt or continuation`);
      return recorded;
    };
    const append = (kind: Kind, reference: TrustedReference, start: number, end: number, continued?: string) => {
      const state = states[kind], selected = state.selectedRequestId;
      const retained = state.sources.filter(source => kind === "order"
        ? source.reference.kind !== "order" || source.reference.orderId !== (reference as Extract<TrustedReference, { kind: "order" }>).orderId
        : sourceId(source.reference) !== continued);
      assert.ok(!retained.some(source => sourceId(source.reference) === sourceId(reference)), "Duplicate source request");
      const next = [...retained, { reference: structuredClone(reference), earliestExpiry: start + referenceChoiceTtlMs,
        latestExpiry: end + referenceChoiceTtlMs }];
      state.sources = next.slice(-3); state.overflow ||= next.length > 3;
      state.selectionRequired ||= state.overflow || next.length > 1;
      state.selectedRequestId = continued !== undefined && selected === continued ? sourceId(reference) : undefined;
    };
    for (const [index, row] of rows.entries()) {
      const value = row.actual, result = value.result, receipt = value.hostReceipt, ingress = value.ingress;
      location = `${value.caseId}:${value.turn}`;
      assert.equal(value.turn, index + 1, "Complete chronological history from the fresh Session is required");
      assert.ok(value.requestId && !ids.has(value.requestId), "Ingress IDs must be unique"); ids.add(value.requestId);
      assert.ok(ingress && ingress.requestId === value.requestId, "Recorded ingress must match the actual request");
      assert.deepEqual(ingress.identity, identity, "Cross-actor history cannot establish a candidate");
      assert.equal(ingress.groupOpenid, groupOpenid, "Cross-group history cannot establish a candidate");
      const start = Date.parse(ingress.observedAt ?? "");
      assert.ok(Number.isFinite(start) && value.durationMs !== null && Number.isFinite(value.durationMs) && value.durationMs >= 0,
        "Observed ingress time and measured duration are required for expiry proof");
      const end = start + value.durationMs;
      if (value.execution !== "completed") { clear(); assert.notEqual(value, actual, "Unfinished turn cannot pass reference proof"); continue; }
      assert.ok(!value.steps.some(step => step.type === "model" && step.isError), "A failed model turn cannot establish references");
      if (receipt?.version === "reference-selection-v1") {
        assert.equal(result, undefined); assert.deepEqual(value.calls, []); assert.deepEqual(value.requests, []); assert.deepEqual(value.steps, []);
        assert.notEqual(receipt.historyFailed, true, "A failed host-history write is not a completed selection");
        assert.equal(receipt.requestId, value.requestId); assert.equal(receipt.sourceKey, binding.sourceKey);
        assert.deepEqual(receipt.trustedRoute, { groupOpenid, messageId: ingress.messageId }); assert.deepEqual(value.reply, receipt.reply);
        const kind = receipt.choices.kind, state = states[kind]; assert.ok(state, "Unknown reference kind");
        const label = kind === "order" ? "订单" : "话题", match = new RegExp(`^选择${label} ([a-f0-9-]{36})$`).exec(row.question.trim());
        assert.ok(row.question.trimStart().startsWith(`选择${label}`), "Receipt kind must match the actual user command");
        if (receipt.outcome === "selected") {
          assert.ok(match && !/[\r\n]/.test(row.question), "Selection must be an actual exact single-line command");
          const choices = checkChoices(receipt.choices, kind, start, "selection", match[1]);
          const candidate = choices.candidates.find(item => item.token === match[1]); assert.ok(candidate && candidate.expiresAt > end, "Selected token expired during the recorded turn");
          const presentation = presentations[kind];
          assert.ok(presentation && presentation.requestId === receipt.presentationRequestId, "Selection must bind the latest actual presentation");
          assert.deepEqual(presentation.choices.candidates.find(item => item.token === candidate.token), candidate,
            "Selected token was not actually displayed with this source, version and expiry");
          assert.equal(receipt.selectedRequestId, sourceId(candidate.reference));
          assert.equal(receipt.selectedOrderId, candidate.reference.kind === "order" ? candidate.reference.orderId : undefined);
          state.selectedRequestId = sourceId(candidate.reference);
          if (kind === "order") selectedOrder = receipt.selectedOrderId;
          if (pending === kind) pending = undefined;
        } else {
          assert.equal(receipt.outcome, "rejected"); assert.equal(receipt.selectedRequestId, undefined);
          assert.equal(receipt.selectedOrderId, undefined); assert.equal(receipt.presentationRequestId, undefined);
          delete state.selectedRequestId; state.selectionRequired = true;
          const choices = checkChoices(receipt.choices, kind, start, "presentation");
          assert.ok(receipt.reply.text.endsWith(referenceChoiceNotice(kind, choices, binding, start)), "Rejected receipt must actually redisplay its exact current candidates");
          presentations[kind] = { requestId: value.requestId, choices: structuredClone(choices) };
          if (kind === "order") selectedOrder = undefined;
          pending ??= kind;
        }
        continue;
      }
      if (receipt?.version === "amount-selection-v1") {
        assert.ok(row.question.trimStart().startsWith("选择金额基准"), "A reference command cannot downgrade itself to an unrelated amount receipt");
        continue;
      }
      const host = object(value.hostReference), explicit = [...new Set(row.question.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
      if (explicit.length && (explicit.length !== 1 || explicit[0] !== selectedOrder)) selectedOrder = undefined;
      if (explicit.length > 1 || explicit.length === 1 && explicit[0] !== focus) { focus = undefined; selectedOrder = undefined; }
      const before = { order: checkChoices(host.orderChoices, "order", start, "before"), policy: checkChoices(host.policyChoices, "policy", start, "before") };
      assert.equal(host.orderId ?? null, selectedOrder ?? focus ?? null, "Host focus must come from an actual read or verified user selection");
      assert.equal(host.pendingReferenceKind ?? null, pending ?? null, "Pending ambiguity cannot be cleared by trace metadata");
      const policy = states.policy;
      const chosen = policy.selectedRequestId ? policy.sources.find(source => sourceId(source.reference) === policy.selectedRequestId)
        : !policy.selectionRequired && !policy.overflow && policy.sources.length === 1 ? policy.sources[0] : undefined;
      const topic = !pending && chosen?.reference.kind === "policy" ? chosen.reference.topic : undefined;
      assert.deepEqual(host.policyTopic ?? null, topic ? { requestId: topic.requestId, originalQuery: topic.originalQuery,
        ...(topic.priorQueries !== undefined ? { priorQueries: topic.priorQueries } : {}), intent: topic.intent, orderId: topic.orderId } : null,
      "Host policy topic must resolve from real candidates and completed selections");
      if (!result) { clear(); continue; }
      assert.equal(result.evidence.requestId, value.requestId); assert.deepEqual(result.evidence.action, result.action);
      assert.deepEqual(result.evidence.trustedRoute, { groupOpenid, messageId: ingress.messageId });
      assert.deepEqual(value.calls, result.evidence.actualCalls); assert.ok(value.calls.every(call => call.parentSpanId === value.requestId));
      for (const kind of ["order", "policy"] as const) {
        const recorded: TrustedReferenceChoices | undefined = kind === "order" ? result.evidence.orderReferenceChoices : result.evidence.policyChoices;
        if (result.referencePresentation === kind) {
          assert.equal(result.outcome, "clarification"); assert.equal(result.needsAnswer, false); assert.deepEqual(value.reply, result.reply);
          const choices = checkChoices(recorded, kind, start, "presentation");
          const text = object(value.reply).text; assert.ok(typeof text === "string" && choices.candidates.length > 0);
          assert.ok(text.endsWith(referenceChoiceNotice(kind, choices, binding, start)), "Presentation must be the actual fixed reply containing exact selection lines");
          states[kind].selectionRequired = true; delete states[kind].selectedRequestId;
          presentations[kind] = { requestId: value.requestId, choices: structuredClone(choices) };
        } else {
          assert.ok(recorded, `${kind}: Controller candidate snapshot is required`);
          assert.deepEqual({ ...recorded, selectedToken: recorded.selectedToken }, { ...before[kind], selectedToken: before[kind].selectedToken },
            `${kind}: Controller input must equal the actual host snapshot`);
        }
      }
      if (result.pendingReferenceKind) {
        assert.ok(pending !== "order" || result.pendingReferenceKind === "order", "Another clarification cannot dismiss a pending order selection");
        pending = result.pendingReferenceKind;
      }
      const action = result.action, order = result.evidence.order;
      if (order) {
        assert.ok(value.calls.some(call => call.name === "get_order" && !call.isError && call.input.orderId === order.id && equal(call.output, order)),
          "An order source requires this turn's real successful authorized read");
      }
      if (result.verifiedPolicyTopic) {
        assert.equal(result.outcome, "ready"); assert.ok(value.reply !== undefined && (action.kind === "policy" || action.kind === "refund_eligibility"));
        assert.ok(result.evidence.rules.length > 0 && result.evidence.knowledge.length > 0
          && value.calls.some(call => call.name === "search_faq" && !call.isError && call.knowledge), "A policy source requires actual successful knowledge evidence");
        const produced = result.verifiedPolicyTopic;
        assert.equal(produced.requestId, value.requestId); assert.equal(produced.sourceKey, binding.sourceKey); assert.equal(produced.groupOpenid, groupOpenid);
        assert.equal(produced.orderId, order?.id ?? null); assert.equal(produced.intent, action.kind);
        assert.deepEqual(produced.scope, { shopId: order?.shop.id ?? null, productId: order?.items[0]?.productId ?? null });
        assert.deepEqual(produced.sources, result.evidence.rules.map(rule => ({ sourceId: rule.sourceId, version: rule.version })));
        if (options.required) assert.ok(produced.priorQueries !== undefined, "New runs cannot downgrade a topic to the legacy single-anchor format");
        if (produced.priorQueries !== undefined) assert.equal(produced.originalQuery, row.question);
        assert.ok(options.verifyPolicyTopic?.(value, row.question, rows.slice(0, index)), "Policy source lacks independent knowledge and original-question proof");
        const continued = "questionContext" in action && action.questionContext.kind === "previous" && action.orderRef?.kind !== "alternative"
          ? action.questionContext.requestId : undefined;
        if (continued) assert.ok(topic && topic.requestId === continued, "Continuation must use the actually resolved prior branch");
        if (produced.priorQueries !== undefined) {
          const queries = continued && topic ? [...(topic.priorQueries ?? []), { requestId: topic.requestId, originalQuery: topic.originalQuery }] : [];
          assert.deepEqual(produced.priorQueries, queries, "A continuation must carry the complete proven original-question chain");
          assert.ok(queries.length <= 4 && queries.reduce((sum, query) => sum + query.originalQuery.length, row.question.length) <= 500,
            "A successful policy source cannot truncate or exceed the bounded question chain");
        }
        append("policy", { kind: "policy", topic: result.verifiedPolicyTopic }, start, end, continued);
      } else if (["blocked", "non_business"].includes(result.outcome)
        || result.outcome === "ready" && (action.kind === "policy" || action.kind === "refund_eligibility")) states.policy = empty();
      if (result.outcome === "ready" && result.reply.kind === "order" && order) {
        const delivered = object(value.reply);
        assert.equal(delivered.kind, "order"); assert.deepEqual(delivered.orders, result.reply.orders, "Order source must have an actual delivered order card");
        append("order", { kind: "order", orderId: order.id, requestId: value.requestId }, start, end);
      } else if (["blocked", "non_business"].includes(result.outcome)) states.order = empty();
      const nextFocus = result.verifiedOrderId ?? (selectedOrder && order?.id === selectedOrder ? selectedOrder : undefined);
      if (nextFocus) { assert.equal(order?.id, nextFocus); focus = nextFocus; selectedOrder = undefined; }
      if (order && result.outcome === "ready" && "orderRef" in action && action.orderRef?.kind === "explicit" && pending === "order") pending = undefined;
    }
    return { passed: true, issues: [] };
  } catch (error) { return { passed: false, issues: [`${location}: ${error instanceof Error ? error.message : String(error)}`] }; }
}
