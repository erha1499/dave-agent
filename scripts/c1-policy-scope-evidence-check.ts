import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { assertC1PolicyScopeRepairEvidence, knowledgeProofPassed, scoreC1ValidationTurn,
  type C1ValidationActual, type C1ValidationHistory, type C1ValidationKnowledgeConfiguration, type C1ValidationTurn } from "./c1-session-validation-check.ts";
import { checkSupportPolicyScopeSession } from "./support-policy-scope-session-check.ts";
import { referenceChoiceNotice } from "../src/support-reference-selection.ts";

type Capture = Awaited<ReturnType<typeof checkSupportPolicyScopeSession>>[number];
type Subject = { actual: C1ValidationActual; history: C1ValidationHistory; configuration: C1ValidationKnowledgeConfiguration };
const object = (value: unknown) => value as Record<string, unknown>;
function syncAudit(actual: C1ValidationActual) {
  const result = actual.result!;
  result.evidence.actualCalls = structuredClone(actual.calls);
  result.evidence.knowledge = actual.calls.flatMap(call => call.knowledge ? [{ callId: call.id, ...structuredClone(call.knowledge) }] : []);
  const repair = result.evidence.policyScopeRepair;
  for (const step of actual.steps.filter(step => step.type === "tool")) {
    const output = object(step.output), content = output.content as Array<{ type: string; text?: string }>;
    for (const part of content ?? []) {
      let parsed: Record<string, unknown>; try { parsed = JSON.parse(part.text ?? ""); } catch { continue; }
      if (parsed.code === "POLICY_SCOPE_CHANGED") part.text = JSON.stringify({ ...parsed, repair });
    }
  }
}
function replaceAction(actual: C1ValidationActual, kind: "initial" | "final", action: unknown) {
  const tools = actual.steps.filter(step => step.type === "tool" && step.name === "support_action");
  const target = kind === "initial" ? tools[0]! : tools.at(-1)!;
  target.input = { action };
  const model = actual.steps.filter(step => step.type === "model" && step.index < target.index).at(-1)!;
  const calls = object(model.output).content as Array<Record<string, unknown>>;
  calls.find(part => part.type === "toolCall")!.arguments = { action };
  if (kind === "initial") actual.result!.evidence.policyScopeRepair!.action = action as NonNullable<C1ValidationActual["result"]>["action"];
  else {
    actual.result!.action = action as NonNullable<C1ValidationActual["result"]>["action"];
    actual.result!.evidence.action = structuredClone(actual.result!.action);
    object(object(target.output).details).action = action;
  }
  syncAudit(actual);
}
function syncFinalNotice(actual: C1ValidationActual) {
  actual.reply = structuredClone(actual.result!.reply);
  const final = actual.steps.filter(step => step.type === "tool" && !step.isError).at(-1)!;
  for (const part of object(final.output).content as Array<{ text?: string }>) {
    const payload = JSON.parse(part.text!); payload.reply = actual.result!.reply; part.text = JSON.stringify(payload);
  }
}

export async function checkC1PolicyScopeEvidence() {
  // The donor, failed action, two reads and gate are captured from the production
  // Session/Pi path with local fake HTTP. No hand-authored successful result.
  const captures = await checkSupportPolicyScopeSession(); assert.ok(captures.length >= 2);
  for (const capture of captures) {
    const budget = capture.configuration.policyScopeRepair.repairBudget; assert.ok(budget === 1 || budget === 2);
    const configuration: C1ValidationKnowledgeConfiguration = { ...capture.configuration,
      policyScopeRepair: { ...capture.configuration.policyScopeRepair, repairBudget: budget } };
    const history: C1ValidationHistory = capture.history.map(actual => ({ actual, question: actual.question }));
    const proof = assertC1PolicyScopeRepairEvidence(capture.actual, capture.originalQuery, history, capture.corpus, configuration);
    assert.deepEqual(proof.attempts.map(attempt => attempt.calls.map(call => call.name)),
      capture.actual.result!.action.kind === "clarify" ? [["get_order"], []] : [["get_order"], ["get_order", "search_faq"]]);
    assert.ok(knowledgeProofPassed(capture.actual, capture.corpus, configuration, capture.originalQuery, history));
    if (capture.actual.result!.action.kind === "clarify") {
      const firstOrder = proof.attempts[0]!.calls[0]!.output as NonNullable<C1ValidationTurn["expected"]["freshOrder"]>;
      const stopped: C1ValidationTurn = { question: capture.originalQuery, expected: { allowedKinds: ["clarify"], outcome: "clarification",
        knowledge: "none", gold: [], scope: { shopId: firstOrder.shop.id, productId: firstOrder.items[0]!.productId },
        freshOrder: firstOrder, answerCriteria: [] } };
      const score = scoreC1ValidationTurn(stopped, capture.actual, capture.corpus, undefined, configuration, history);
      assert.ok(score.engineeringPassed && score.fresh && score.knowledgePassed && score.safeStopped);
      assert.equal(score.answerPassed, false); assert.equal(score.passed, false, "A safe notice without reply review is not overall success");
      const business: C1ValidationTurn = { ...stopped, expected: { ...stopped.expected, allowedKinds: ["policy"], outcome: "ready", knowledge: "rejected" } };
      assert.equal(scoreC1ValidationTurn(business, capture.actual, capture.corpus, undefined, configuration, history).engineeringPassed, false,
        "A valid clarification does not complete a question whose frozen gold requires a business answer");
    }
  }
  const capture: Capture = captures[0]!, budget = capture.configuration.policyScopeRepair.repairBudget;
  assert.ok(budget === 1 || budget === 2);
  const original: Subject = { actual: capture.actual, history: capture.history.map(actual => ({ actual, question: actual.question })),
    configuration: { ...capture.configuration, policyScopeRepair: { ...capture.configuration.policyScopeRepair, repairBudget: budget } } };
  assert.equal(original.actual.result!.evidence.order!.items[0]!.productId, "product-demo-3");
  const turn: C1ValidationTurn = { question: capture.originalQuery, expected: { allowedKinds: ["policy"], outcome: "ready",
    knowledge: "rejected", gold: [], scope: { shopId: "shop-demo-1", productId: "product-demo-3" },
    freshOrder: original.actual.result!.evidence.order!, answerCriteria: [] } };
  const score = scoreC1ValidationTurn(turn, original.actual, capture.corpus, undefined, original.configuration, original.history);
  assert.ok(score.engineeringPassed && score.knowledgePassed && score.evidenceProofPassed && score.applicabilityIntegrityPassed);
  assert.equal(score.answerPassed, false, "Fixed fake model text has no reviewed semantic proof"); assert.equal(score.passed, false);
  const mutations: Array<[string, (subject: Subject) => void]> = [
    ["no frozen opt-in", s => { delete s.configuration.policyScopeRepair; }],
    ["wrong frozen version", s => { object(s.configuration.policyScopeRepair).version = "made-up-repair"; }],
    ["unbounded frozen repair", s => { object(s.configuration.policyScopeRepair).maxRepairs = 2; }],
    ["removed audit", s => { delete s.actual.result!.evidence.policyScopeRepair; }],
    ["wrong typed error", s => { const step = s.actual.steps.find(step => step.type === "tool" && step.isError)!;
      const parts = object(step.output).content as Array<{ text: string }>; parts[0]!.text = JSON.stringify({ code: "ORDINARY_SERVICE_ERROR" }); }],
    ["missing actual failed model action", s => { s.actual.steps.splice(0, 1); s.actual.steps.forEach((step, index) => { step.index = index + 1; }); }],
    ["missing SDK tool error", s => { s.actual.steps = s.actual.steps.filter(step => !(step.type === "tool" && step.isError));
      s.actual.steps.forEach((step, index) => { step.index = index + 1; }); }],
    ["failure falsely recorded as success", s => { s.actual.steps.find(step => step.type === "tool" && step.isError)!.isError = false; }],
    ["invented SDK call ID", s => { s.actual.result!.evidence.policyScopeRepair!.budget!.toolCallId = "not-a-real-tool-call"; syncAudit(s.actual); }],
    ["forged budget history", s => { const b = s.actual.result!.evidence.policyScopeRepair!.budget!;
      s.configuration.policyScopeRepair!.repairBudget = 2; b.limit = 2; b.usedBefore = 1; b.usedAfter = 2; syncAudit(s.actual); }],
    ["business failure relabelled as protocol repair", s => {
      const model = structuredClone(s.actual.steps[0]!), tool = structuredClone(s.actual.steps[1]!);
      const action = structuredClone(s.actual.result!.action), part = (object(model.output).content as Array<Record<string, unknown>>)
        .find(entry => entry.type === "toolCall")!;
      part.id = "forged-valid-action-error"; part.arguments = { action }; tool.input = { action };
      tool.output = { content: [{ type: "text", text: "generic execution failure" }], details: {} }; tool.isError = true;
      s.actual.steps.unshift(model, tool); s.actual.steps.forEach((step, i) => { step.index = i + 1; });
      const b = s.actual.result!.evidence.policyScopeRepair!.budget!;
      s.configuration.policyScopeRepair!.repairBudget = 2; b.limit = 2; b.usedBefore = 1; b.usedAfter = 2; syncAudit(s.actual);
    }],
    ["budget not consumed", s => { s.actual.result!.evidence.policyScopeRepair!.budget!.usedAfter = 0; syncAudit(s.actual); }],
    ["same scope presented as changed", s => { const r = s.actual.result!.evidence.policyScopeRepair!;
      r.topic.scope = { shopId: "shop-demo-1", productId: "product-demo-3" }; syncAudit(s.actual); }],
    ["false historical source hash", s => { s.actual.result!.evidence.policyScopeRepair!.topic.sources[0]!.version = "0".repeat(64); syncAudit(s.actual); }],
    ["false historical scope", s => { s.actual.result!.evidence.policyScopeRepair!.topic.scope.productId = "fake-old-sku"; syncAudit(s.actual); }],
    ["foreign actor", s => { s.actual.ingress!.identity.senderId = "OTHER_ACTOR"; }],
    ["foreign group", s => { s.actual.ingress!.groupOpenid = "OTHER_GROUP"; s.actual.result!.evidence.trustedRoute.groupOpenid = "OTHER_GROUP"; }],
    ["no real donor", s => { s.history = []; }],
    ["expired candidate", s => { const read = s.actual.calls[0]!;
      s.actual.result!.evidence.policyChoices!.candidates[0]!.expiresAt = Date.parse(read.observedAt); }],
    ["failed ownership read", s => { s.actual.calls[0]!.isError = true; s.actual.calls[0]!.errorKind = "business_denial";
      s.actual.result!.evidence.policyScopeRepair!.call = structuredClone(s.actual.calls[0]!); syncAudit(s.actual); }],
    ["first read reused as final", s => { s.actual.calls.splice(1, 1); s.actual.calls.forEach((call, i) => { call.id = `${s.actual.requestId}:${i + 1}`; }); syncAudit(s.actual); }],
    ["hidden first-attempt search", s => { const extra = structuredClone(s.actual.calls[2]!); s.actual.calls.splice(1, 0, extra);
      s.actual.calls.forEach((call, i) => { call.id = `${s.actual.requestId}:${i + 1}`; }); syncAudit(s.actual); }],
    ["duplicate call ID", s => { s.actual.calls[1]!.id = s.actual.calls[0]!.id; syncAudit(s.actual); }],
    ["wrong parent span", s => { s.actual.calls[1]!.parentSpanId = "other-request"; syncAudit(s.actual); }],
    ["reversed read order", s => { [s.actual.calls[0], s.actual.calls[1]] = [s.actual.calls[1]!, s.actual.calls[0]!]; syncAudit(s.actual); }],
    ["first rule-only use", s => { const action = structuredClone(s.actual.result!.evidence.policyScopeRepair!.action);
      object(action).evidenceTarget = { kind: "rule_only", basis: "普通周六使用规则" }; replaceAction(s.actual, "initial", action); }],
    ["final rule-only bypass", s => { const action = structuredClone(s.actual.result!.action);
      object(action).evidenceTarget = { kind: "rule_only", basis: "普通周六使用规则" }; replaceAction(s.actual, "final", action); }],
    ["final write", s => { replaceAction(s.actual, "final", { protocol: "v2.2", kind: "refund_prepare",
      orderRef: { kind: "explicit", orderId: "COUPON-9204" } }); }],
    ["final different explicit order", s => { const action = structuredClone(s.actual.result!.action);
      object(action).orderRef = { kind: "explicit", orderId: "COUPON-9201" }; replaceAction(s.actual, "final", action); }],
    ["old query transplanted", s => { s.actual.calls[2]!.knowledge!.context.effectiveQuery += `\n${s.history[0]!.question}`; syncAudit(s.actual); }],
    ["old topic transplanted", s => { s.actual.calls[2]!.knowledge!.context.policyTopic = structuredClone(s.actual.result!.evidence.policyScopeRepair!.topic); syncAudit(s.actual); }],
    ["original message replaced by model question", s => { s.actual.calls[2]!.knowledge!.context.originalQuery = "更容易回答的问题"; syncAudit(s.actual); }],
  ];
  for (const [name, mutate] of mutations) {
    const subject: Subject = structuredClone(original); mutate(subject);
    assert.throws(() => assertC1PolicyScopeRepairEvidence(subject.actual, capture.originalQuery, subject.history, capture.corpus, subject.configuration), name);
    assert.equal(knowledgeProofPassed(subject.actual, capture.corpus, subject.configuration, capture.originalQuery, subject.history), false, name);
    assert.equal(scoreC1ValidationTurn(turn, subject.actual, capture.corpus, undefined, subject.configuration, subject.history).engineeringPassed, false, name);
  }
  const clarification = captures.find(row => row.actual.result?.action.kind === "clarify"); assert.ok(clarification);
  const clarificationBudget = clarification.configuration.policyScopeRepair.repairBudget; assert.ok(clarificationBudget === 1 || clarificationBudget === 2);
  const stoppedOriginal: Subject = { actual: clarification.actual, history: clarification.history.map(actual => ({ actual, question: actual.question })),
    configuration: { ...clarification.configuration, policyScopeRepair: { ...clarification.configuration.policyScopeRepair, repairBudget: clarificationBudget } } };
  const clarificationMutations: Array<[string, (subject: Subject) => void]> = [
    ["stale selector made into an actual presentation", s => {
      const result = s.actual.result!, repair = result.evidence.policyScopeRepair!;
      result.referencePresentation = "policy"; result.evidence.policyChoices!.selectionRequired = true; delete result.evidence.policyChoices!.selectedToken;
      result.reply = { kind: "notice", text: referenceChoiceNotice("policy", result.evidence.policyChoices,
        { sourceKey: repair.topic.sourceKey, groupOpenid: s.actual.ingress!.groupOpenid }, Date.parse(s.actual.ingress!.observedAt!)) };
      syncFinalNotice(s.actual);
    }],
    ["hidden stale token without presentation flag", s => { const result = s.actual.result!;
      assert.equal(result.reply.kind, "notice"); result.reply.text += `\n选择话题 ${result.evidence.policyChoices!.candidates[0]!.token}`; syncFinalNotice(s.actual); }],
    ["missing required policy pending state", s => { delete s.actual.result!.pendingReferenceKind; }],
    ["delivered notice differs from host result", s => { s.actual.reply = { kind: "notice", text: "选择旧规则继续" }; }],
    ["SDK notice differs from actual host reply", s => { const step = s.actual.steps.filter(step => step.type === "tool" && !step.isError).at(-1)!;
      const part = (object(step.output).content as Array<{ text: string }>)[0]!, payload = JSON.parse(part.text);
      payload.reply = { kind: "notice", text: "选择旧规则继续" }; part.text = JSON.stringify(payload); }],
  ];
  for (const [name, mutate] of clarificationMutations) {
    const subject: Subject = structuredClone(stoppedOriginal); mutate(subject);
    assert.throws(() => assertC1PolicyScopeRepairEvidence(subject.actual, clarification.originalQuery, subject.history, clarification.corpus, subject.configuration), name);
    assert.equal(knowledgeProofPassed(subject.actual, clarification.corpus, subject.configuration, clarification.originalQuery, subject.history), false, name);
  }
  console.log(`[c1-policy-scope-evidence] ${captures.length} production Session captures; ${mutations.length + clarificationMutations.length} deleted/forged audit, SDK, donor, budget, scope, read and clarification mutations rejected; final-attempt/scorer proof PASS; 0 remote/DB/QQ, no model-semantic claim.`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkC1PolicyScopeEvidence();
