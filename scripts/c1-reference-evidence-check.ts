import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { createKnowledgeService } from "../src/knowledge-service.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { evidenceBindingVersion } from "../src/support-evidence-context.ts";
import { referenceChoiceNotice, type TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import { createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { knowledgeProofPassed, scoreC1ValidationTurn, type C1ValidationActual, type C1ValidationHistory,
  type C1ValidationTurn } from "./c1-session-validation-check.ts";
import { scoreC1ReferenceEvidence } from "./c1-reference-evidence.ts";

type Row = C1ValidationHistory[number];
type Host = NonNullable<C1ValidationActual["hostReference"]> & {
  policyChoices: TrustedReferenceChoices; orderChoices: TrustedReferenceChoices; pendingReferenceKind: "policy" | "order" | null;
};
const corpus: RetrievalDocument[] = [{ id: "REF-REFUND", title: "退款到账规则", body: "退款到账时间因微信、银行卡渠道而异，请按各自渠道规则核实。",
  tags: ["退款", "到账", "时间", "微信", "银行卡", "工作日"], shopId: null, productId: null }];
const configuration = { evidenceBindingVersion, referenceEvidenceRequired: true };
const verifyPolicyTopic = (actual: C1ValidationActual, question: string, history: C1ValidationHistory) =>
  knowledgeProofPassed(actual, corpus, configuration, question, history);
const hostReference = (context: TranscriptContext): Host => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text)).flatMap(text => {
    try { const value = JSON.parse(text); return value.kind === "host_order_reference" ? [value] : []; } catch { return []; }
  }).at(-1);
const order = (id: string): Awaited<ReturnType<CouponStore["getOrder"]>> => ({ source: "demo-database", id, status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  createdAt: null, paidAt: null, amounts: { totalCents: 100, paidCents: 100, refundedCents: 0 },
  shop: { id: "reference-shop", name: "合成门店", merchantName: "合成商家", address: "合成地址" },
  items: [{ id: `${id}-item`, productId: "reference-meal", productName: "合成套餐", quantity: 1, unitPriceCents: 100, totalCents: 100 }],
  coupons: [{ id: `${id}-coupon`, orderItemId: `${id}-item`, status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 100, paidAt: null }], refunds: [] });
const standalone = (question: string): ContextSupportAction => ({ protocol: "v2.2", kind: "policy", question, questionContext: { kind: "standalone" } });
const previous = (question: string) => (host: Host): ContextSupportAction => ({ protocol: "v2.2", kind: "policy", question,
  questionContext: { kind: "previous", requestId: host.policyTopic!.requestId } });

export async function checkC1ReferenceEvidence() {
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const identity = { appId: "REF_AUDIT", senderId: "SYNTHETIC_OWNER" }, groupOpenid = "REF_AUDIT_GROUP";
  const store = { async getOrder(actor: typeof identity, id: string) { assert.deepEqual(actor, identity); return order(id); },
    async readKnowledgeDocuments() { return structuredClone(corpus); } } as unknown as CouponStore;
  const options = { required: true, verifyPolicyTopic };
  const score = (rows: Row[]) => { const last = rows.at(-1)!; return scoreC1ReferenceEvidence(last.actual, last.question, rows.slice(0, -1), options); };
  const assertPassed = (rows: Row[]) => { const result = score(rows); assert.equal(result.passed, true, result.issues.join("\n")); };
  let mutations = 0;
  const rejects = (rows: Row[], mutate: (rows: Row[]) => void, message: string) => {
    const changed = structuredClone(rows); mutate(changed); const result = score(changed);
    assert.equal(result.passed, false, message); assert.ok(result.issues.length); mutations++;
  };
  async function harness(caseId: string) {
    const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined,
      { groupOpenid, knowledge: createKnowledgeService(store, { mode: "lexical" }) });
    const rows: Row[] = [];
    async function run(question: string, action?: ContextSupportAction | ((host: Host) => ContextSupportAction)) {
      const turn = rows.length + 1, requestId = `${caseId}-${turn}`, start = Date.now();
      const actual: C1ValidationActual = { caseId, turn, requestId, execution: "completed", durationMs: null,
        ingress: { identity, groupOpenid, messageId: requestId, requestId, observedAt: new Date(start).toISOString() }, calls: [], steps: [], requests: [] };
      const measured = captureEvaluationTurn("faux"), unsubscribe = session.subscribe(measured.receive), count = faux.state.callCount;
      prepareSupportPrompt(session, { requestId, groupOpenid, messageId: requestId, onCall: call => actual.calls.push(call) });
      faux.setResponses(action ? [context => {
        const host = hostReference(context); actual.hostReference = structuredClone(host);
        return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(host) : action }), { stopReason: "toolUse" });
      }, () => fauxAssistantMessage("按本轮合成规则完成说明。")] : []);
      try { await session.prompt(question, { expandPromptTemplates: false }); }
      finally { actual.durationMs = Date.now() - start; unsubscribe(); }
      assert.equal(faux.getPendingResponseCount(), 0); assert.ok(!session.agent.state.errorMessage, session.agent.state.errorMessage ?? "Unexpected faux model failure");
      actual.steps = measured.finish().steps; actual.result = structuredClone(getSupportResult(session));
      const receipt = getSupportHostReceipt(session); if (receipt) actual.hostReceipt = receipt;
      actual.reply = structuredClone(supportReply(session, session.getLastAssistantText() ?? ""));
      if (!action) assert.equal(faux.state.callCount, count, "Host selection must not invoke the faux model");
      rows.push({ question, actual }); assertPassed(rows); return actual;
    }
    return { session, rows, run };
  }
  const command = (actual: C1ValidationActual, kind: "order" | "policy", index = 0) => {
    const choices = kind === "order" ? actual.result!.evidence.orderReferenceChoices! : actual.result!.evidence.policyChoices!;
    const value = `选择${kind === "order" ? "订单" : "话题"} ${choices.candidates[index]!.token}`;
    assert.ok((actual.reply as { text: string }).text.split("\n").includes(value)); return value;
  };
  const policies = await harness("policy");
  try {
    await policies.run("微信退款到账时间是什么？", standalone("微信退款到账时间是什么？"));
    await policies.run("银行卡退款到账时间是什么？", standalone("银行卡退款到账时间是什么？"));
    const shown = await policies.run("那个时间是工作日吗？", { protocol: "v2.2", kind: "clarify", field: "time_channel", reason: "ambiguous" });
    await policies.run(command(shown, "policy"));
    await policies.run("那微信退款到账时间按工作日吗？", previous("那微信退款到账时间按工作日吗？"));
    await policies.run("退款到账时间还要看什么？", previous("退款到账时间还要看什么？"));
    const rows = policies.rows;
    assert.equal(rows[4]!.actual.result!.verifiedPolicyTopic!.priorQueries!.length, 1);
    assert.equal(rows[5]!.actual.result!.verifiedPolicyTopic!.priorQueries!.length, 2);
    const candidates = (rows[5]!.actual.hostReference as Host).policyChoices;
    assert.equal(candidates.candidates.length, 2, "A selected continuation replaces one branch rather than creating a third competitor");
    assert.ok(candidates.selectedToken);
    for (const [name, mutate] of [
      ["missing real presentation", (changed: Row[]) => { delete changed[2]!.actual.result!.referencePresentation; }],
      ["hidden token", (changed: Row[]) => { (changed[2]!.actual.reply as { text: string }).text = "请明确话题。"; }],
      ["wrong presentation request", (changed: Row[]) => { const receipt = changed[3]!.actual.hostReceipt!; if (receipt.version === "reference-selection-v1") receipt.presentationRequestId = "invented"; }],
      ["extra user text", (changed: Row[]) => { changed[3]!.question += " 以及另一个问题"; }],
      ["multiline command", (changed: Row[]) => { changed[3]!.question += "\n"; }],
      ["wrong selected source", (changed: Row[]) => { changed[3]!.actual.hostReceipt!.selectedRequestId = "policy-2"; }],
      ["wrong receipt actor", (changed: Row[]) => { changed[3]!.actual.hostReceipt!.sourceKey = "someone-else"; }],
      ["wrong source actor", (changed: Row[]) => { changed[0]!.actual.ingress!.identity.senderId = "someone-else"; }],
      ["wrong source group", (changed: Row[]) => { changed[0]!.actual.ingress!.groupOpenid = "another-group"; }],
      ["host selection secretly calls model", (changed: Row[]) => { changed[3]!.actual.steps = structuredClone(changed[0]!.actual.steps); }],
      ["failed history append", (changed: Row[]) => { changed[3]!.actual.hostReceipt!.historyFailed = true; }],
      ["reference receipt downgraded to amount", (changed: Row[]) => { Object.assign(changed[3]!.actual.hostReceipt!, { version: "amount-selection-v1" }); }],
      ["missing policy proof", (changed: Row[]) => { changed[0]!.actual.result!.evidence.rules[0]!.body = "invented knowledge"; }],
      ["topic without actual knowledge", (changed: Row[]) => { const value = changed[0]!.actual;
        value.calls = []; value.result!.evidence.actualCalls = []; value.result!.evidence.rules = []; value.result!.evidence.knowledge = []; }],
      ["topic source self-assertion", (changed: Row[]) => { changed[0]!.actual.result!.verifiedPolicyTopic!.sources[0]!.version = "0".repeat(64); }],
      ["wrong continuation source", (changed: Row[]) => { const action = changed[4]!.actual.result!.action; if ("questionContext" in action) action.questionContext = { kind: "previous", requestId: "policy-2" }; }],
      ["forged migrated selection", (changed: Row[]) => { const choices = (changed[5]!.actual.hostReference as Host).policyChoices; choices.selectedToken = choices.candidates[0]!.token; }],
      ["removed live competitor", (changed: Row[]) => { const choices = (changed[2]!.actual.hostReference as Host).policyChoices; choices.candidates.pop(); choices.selectionRequired = false; }],
      ["source failure", (changed: Row[]) => { changed[0]!.actual.execution = "failed"; }],
      ["missing source history", (changed: Row[]) => { changed.splice(0, 1); }],
    ] as const) rejects(rows, mutate, name);
    rejects(rows, changed => {
      const choices = (changed[2]!.actual.hostReference as Host).policyChoices, candidate = choices.candidates[0]!;
      assert.equal(candidate.reference.kind, "policy"); if (candidate.reference.kind === "policy") candidate.reference.topic.originalQuery = "伪造但自洽的问题";
      candidate.version = createHash("sha256").update(JSON.stringify(candidate.reference)).digest("hex");
    }, "Self-consistent source hashes cannot replace the original successful question");
    rejects(rows, changed => {
      const choices = (changed[5]!.actual.hostReference as Host).policyChoices;
      choices.candidates[1]!.token = randomUUID(); choices.selectedToken = choices.candidates[1]!.token;
    }, "A new random token cannot impersonate a migrated user selection");
    rejects(rows, changed => { changed[3]!.actual.ingress!.observedAt = new Date(Date.parse(changed[3]!.actual.ingress!.observedAt!) + 16 * 60_000).toISOString(); },
      "An expired selected token cannot be revived");
    const independent = await policies.run("我完整重问银行卡退款到账时间。", standalone("我完整重问银行卡退款到账时间。"));
    assert.equal(independent.result!.verifiedPolicyTopic!.priorQueries!.length, 0);
    const rejected = await policies.run(`选择话题 ${randomUUID()}`);
    assert.equal(rejected.hostReceipt?.outcome, "rejected");
    const receipt = rejected.hostReceipt!; assert.equal(receipt.version, "reference-selection-v1");
    await policies.run(`选择话题 ${receipt.choices.candidates[0]!.token}`);
    await policies.run("退款到账时间有哪些条件？", previous("退款到账时间有哪些条件？"));
    rejects(policies.rows, changed => { const selected = changed[8]!.actual.hostReceipt!;
      if (selected.version === "reference-selection-v1") selected.presentationRequestId = "policy-3"; }, "A redisplayed selection cannot use an overwritten presentation");
    const withoutCallback = rows.at(-1)!;
    assert.equal(scoreC1ReferenceEvidence(withoutCallback.actual, withoutCallback.question, rows.slice(0, -1), { required: true }).passed, false);
  } finally { policies.session.dispose(); }

  const pending = await harness("pending");
  try {
    await pending.run("微信退款到账时间是什么？", standalone("微信退款到账时间是什么？"));
    await pending.run("银行卡退款到账时间是什么？", standalone("银行卡退款到账时间是什么？"));
    const shown = await pending.run("那个时间呢？", { protocol: "v2.2", kind: "clarify", field: "time_channel", reason: "ambiguous" });
    const independent = await pending.run("我重新完整咨询支付宝退款到账时间。", standalone("我重新完整咨询支付宝退款到账时间。"));
    assert.equal(independent.result!.pendingReferenceKind, "policy"); assert.equal(independent.result!.referencePresentation, undefined);
    const selected = await pending.run(command(shown, "policy"));
    assert.equal(selected.hostReceipt?.version, "reference-selection-v1");
    if (selected.hostReceipt?.version === "reference-selection-v1") assert.equal(selected.hostReceipt.presentationRequestId, shown.requestId);
    await pending.run("那微信退款到账时间还需要什么条件？", previous("那微信退款到账时间还需要什么条件？"));
    rejects(pending.rows, changed => { const receipt = changed[4]!.actual.hostReceipt!;
      if (receipt.version === "reference-selection-v1") receipt.presentationRequestId = changed[3]!.actual.requestId!; },
    "Inherited pending in a successful standalone turn is not a new actual presentation");
    rejects(pending.rows, changed => { changed[3]!.actual.result!.referencePresentation = "policy"; },
      "Self-asserted presentation on an independent answer cannot authorize an undisplayed candidate");
  } finally { pending.session.dispose(); }

  const orders = await harness("orders");
  try {
    for (const id of ["COUPON-4201", "COUPON-4202", "COUPON-4203"]) await orders.run(`查询 ${id}`,
      { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: id } });
    const shown = await orders.run("另一笔是哪单？", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
    await orders.run(command(shown, "order"));
    await orders.run("查看刚选定订单。", { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } });
    assert.equal(orders.rows.at(-1)!.actual.result!.evidence.order!.id, "COUPON-4201");
    rejects(orders.rows, changed => { changed[0]!.actual.calls[0]!.output = order("COUPON-4999"); }, "The order candidate needs its original successful read");
    rejects(orders.rows, changed => { changed[0]!.actual.reply = { kind: "notice", text: "未展示订单" }; }, "A hidden order result is not a delivered order source");
    rejects(orders.rows, changed => { const choices = (changed[3]!.actual.hostReference as Host).orderChoices; choices.candidates[0]!.expiresAt += 60_000; },
      "Candidate expiry cannot exceed its measured creation window");
    const legacy = structuredClone(orders.rows[0]!.actual); delete legacy.ingress; delete legacy.hostReference;
    delete legacy.result!.evidence.orderReferenceChoices; delete legacy.result!.evidence.policyChoices;
    assert.equal(scoreC1ReferenceEvidence(legacy, orders.rows[0]!.question, [], { required: false }).passed, true);
    assert.equal(scoreC1ReferenceEvidence(legacy, orders.rows[0]!.question, [], { required: true }).passed, false);
    const expected: C1ValidationTurn = { question: orders.rows[0]!.question, expected: { allowedKinds: ["order"], outcome: "ready", knowledge: "none", gold: [],
      scope: { shopId: null, productId: null }, freshOrder: order("COUPON-4201"), answerCriteria: [] } };
    assert.equal(scoreC1ValidationTurn(expected, legacy, corpus).referenceEvidenceProofPassed, true);
    const downgraded = scoreC1ValidationTurn(expected, legacy, corpus, undefined, configuration);
    assert.equal(downgraded.referenceEvidenceProofPassed, false); assert.equal(downgraded.engineeringPassed, false); assert.equal(downgraded.passed, false);
  } finally { orders.session.dispose(); }
  console.log(`C1 reference evidence PASS: actual Pi/faux + lexical knowledge proofs, order/policy display-selection-recovery, branch migration, ${mutations} tampering checks, frozen downgrade guard and legacy replay; 0 network.`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkC1ReferenceEvidence();
