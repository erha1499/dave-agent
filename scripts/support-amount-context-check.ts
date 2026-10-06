import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { amountChoiceTtlMs, createAmountReference, currentAmountChoices, rememberAmountChoice, resolveAmountReference,
  selectAmountChoice, type TrustedAmountChoices } from "../src/support-context.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, type SupportCall } from "../src/support-controller.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
const identity = { appId: "AMOUNT_TEST", senderId: "ACTOR" }, groupOpenid = "AMOUNT_GROUP";
const binding = { sourceKey: merchantSourceKey(identity, groupOpenid), groupOpenid };
function makeOrder(id: string, cents = 7980): Order {
  return { source: "demo-database", id, status: "partially_redeemed", asOf: "2026-10-06T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", paidAt: "2026-10-01T00:00:00Z",
    amounts: { totalCents: cents * 2, paidCents: cents * 2, refundedCents: 0 },
    shop: { id: "shop", name: "门店", merchantName: "商家", address: "地址" },
    items: [{ id: id + "-item", productId: "meal", productName: "套餐", quantity: 2, unitPriceCents: cents, totalCents: cents * 2 }],
    coupons: [{ id: id + "-used", orderItemId: id + "-item", status: "redeemed", expiresAt: "2027-01-01T00:00:00Z", redeemedAt: "2026-10-05T00:00:00Z", redeemedShopId: "shop" },
      { id: id + "-unused", orderItemId: id + "-item", status: "unused", expiresAt: "2027-01-01T00:00:00Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: cents * 2, paidAt: "2026-10-01T00:00:00Z" }], refunds: [] };
}
type Host = { kind?: string; itemPaidUnit?: { requestId: string } | null; amountChoices?: TrustedAmountChoices };
const hostReference = (context: TranscriptContext): Host => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text)).map(text => { try { return JSON.parse(text) as Host; } catch { return {}; } })
  .filter(value => value.kind === "host_order_reference").at(-1) ?? {};

export async function checkSupportAmountContext() {
  const a = makeOrder("COUPON-4101"), b = makeOrder("COUPON-4102"), c = makeOrder("COUPON-4103", 5990);
  const referenceA = createAmountReference(a, binding, "a")!, referenceB = createAmountReference(b, binding, "b")!;
  let choices = rememberAmountChoice(undefined, binding, referenceA, 1000)!;
  const firstToken = choices.candidates[0]!.token;
  assert.deepEqual(resolveAmountReference(choices, binding, 1001), referenceA);
  for (let index = 0; index < 5; index++) choices = rememberAmountChoice(choices, binding,
    createAmountReference({ ...a, asOf: `2026-10-06T00:00:0${index}Z` }, binding, `a-${index}`)!, 1002 + index)!;
  assert.equal(choices.candidates.length, 1); assert.equal(choices.overflow, false);
  assert.equal(selectAmountChoice(choices, binding, firstToken, 1010), undefined, "updating a source invalidates its old token/version");
  choices = rememberAmountChoice(choices, binding, referenceB, 1011)!;
  assert.equal(choices.candidates.length, 2); assert.equal(choices.selectionRequired, true);
  assert.equal(resolveAmountReference(choices, binding, 1012), undefined, "same cents from distinct sources do not merge");
  const selected = selectAmountChoice(choices, binding, choices.candidates[0]!.token, 1012)!;
  assert.equal(resolveAmountReference(selected, binding, 1012)!.orderId, a.id);
  assert.equal(currentAmountChoices(selected, { ...binding, groupOpenid: "other" }, 1012), undefined);
  assert.equal(currentAmountChoices(selected, { ...binding, sourceKey: "other" }, 1012), undefined);
  assert.equal(resolveAmountReference(selected, binding, 1012 + amountChoiceTtlMs), undefined);
  const forged = structuredClone(selected); forged.candidates[0]!.reference.paidCents++;
  assert.equal(resolveAmountReference(forged, binding, 1012), undefined);
  choices = rememberAmountChoice(choices, binding, createAmountReference(c, binding, "c")!, 1013)!;
  assert.equal(choices.candidates.length, 2); assert.equal(choices.overflow, true);
  assert.equal(resolveAmountReference(choices, binding, 1013), undefined);
  assert.equal(resolveAmountReference(selectAmountChoice(choices, binding, choices.candidates[0]!.token, 1013), binding, 1013)!.orderId, b.id);
  const survivor = structuredClone(choices); survivor.candidates[0]!.expiresAt = 1014;
  assert.equal(currentAmountChoices(survivor, binding, 1015)!.candidates.length, 1);
  assert.equal(resolveAmountReference(survivor, binding, 1015), undefined, "expiry cannot silently resolve a previously ambiguous list");
  const empty = currentAmountChoices(survivor, binding, 1015 + amountChoiceTtlMs)!;
  assert.equal(empty.candidates.length, 0); assert.equal(empty.selectionRequired, true); assert.equal(empty.overflow, true);
  const repopulated = rememberAmountChoice(empty, binding, referenceA, 1016 + amountChoiceTtlMs)!;
  assert.equal(resolveAmountReference(repopulated, binding, 1017 + amountChoiceTtlMs), undefined,
    "repopulating an expired ambiguous list cannot manufacture a selection");

  let reads = 0, knowledge = 0, failReads = false, focus: string | undefined;
  const store = { getOrder: async (_identity: typeof identity, id: string) => {
    assert.deepEqual(_identity, identity); reads++; if (failReads) throw new Error("synthetic failure");
    const order = [a, b, c].find(row => row.id === id); assert.ok(order); return structuredClone(order);
  }, searchKnowledge: async () => { knowledge++; return []; } } as unknown as CouponStore;
  const controller = new SupportController({ store });
  const liveChoices = rememberAmountChoice(rememberAmountChoice(undefined, binding, referenceA), binding, referenceB)!;
  const denied = await controller.createTurn({ requestId: "malicious-model", identity, sourceKey: binding.sourceKey,
    trustedRoute: { groupOpenid, messageId: "malicious-model" }, userText: "剩下那张的实付一样吗？", focusOrderId: b.id,
    amountReference: referenceB, amountChoices: liveChoices }).execute({ protocol: "v2.2", kind: "paid_amount_compare",
      orderRef: { kind: "focus" }, amountRef: { requestId: referenceB.requestId } });
  assert.equal(denied.outcome, "clarification"); assert.equal(reads, 0); assert.equal(knowledge, 0);
  assert.ok("text" in denied.reply && denied.reply.text.includes("选择金额基准"));

  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const calls: SupportCall[] = []; let sequence = 0, modelResponses = 0;
  const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, {
    groupOpenid, focus: { read: async () => focus, write: async next => { focus = next; } },
  });
  const choose = (action: ContextSupportAction | ((host: Host) => ContextSupportAction)): FauxResponseStep => context => {
    modelResponses++; return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(hostReference(context)) : action }), { stopReason: "toolUse" });
  };
  const finish: FauxResponseStep = () => { modelResponses++; return fauxAssistantMessage("完成。"); };
  const prompt = async (text: string, responses: FauxResponseStep[] = [], route = groupOpenid) => {
    const requestId = `amount-${++sequence}`;
    prepareSupportPrompt(session, { requestId, groupOpenid: route, messageId: requestId, onCall: call => calls.push(call) });
    faux.setResponses(responses); await session.prompt(text, { expandPromptTemplates: false });
    assert.equal(faux.getPendingResponseCount(), 0); return requestId;
  };
  const query = (id: string) => prompt(`查询 ${id} 实付`, [choose({ protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: id } }), finish]);
  const compare = () => prompt("剩下那张的实付和前面一样吗？", [choose(host => ({ protocol: "v2.2", kind: "paid_amount_compare",
    orderRef: { kind: "focus" }, amountRef: { requestId: host.itemPaidUnit?.requestId ?? "model-guesses-a-valid-old-id" } })), finish]);
  const clarify = () => prompt("请明确金额基准", [choose({ protocol: "v2.2", kind: "clarify", field: "amount_basis", reason: "ambiguous" }), finish]);
  const exposed = () => getSupportResult(session)!.evidence.amountChoices!;
  try {
    await query(a.id); await compare();
    assert.equal(getSupportResult(session)!.evidence.amountComparison!.comparisonEqual, true);
    assert.equal(knowledge, 0);
    await query(b.id); await compare();
    assert.equal(getSupportResult(session)!.outcome, "clarification"); assert.equal(exposed().candidates.length, 2);
    assert.equal(exposed().overflow, false); assert.equal(exposed().selectedToken, undefined);
    const bCandidate = exposed().candidates.find(row => row.reference.orderId === b.id)!;
    const aCandidate = exposed().candidates.find(row => row.reference.orderId === a.id)!;
    const before = { reads, knowledge, calls: calls.length, modelResponses, messages: session.messages.length };
    const selectedIngress = await prompt(`选择金额基准 ${bCandidate.token}`);
    const receipt = getSupportHostReceipt(session)!;
    assert.equal(receipt.requestId, selectedIngress); assert.equal(receipt.outcome, "selected");
    assert.deepEqual(receipt.trustedRoute, { groupOpenid, messageId: selectedIngress });
    assert.equal(getSupportResult(session), undefined); assert.equal(session.messages.length, before.messages + 1);
    assert.deepEqual({ reads, knowledge, calls: calls.length, modelResponses }, { reads: before.reads, knowledge: before.knowledge, calls: before.calls, modelResponses: before.modelResponses });
    assert.match((supportReply(session) as { text: string }).text, /仅支持同一订单/);
    const otherActor = await createSupportSession({ ...identity, senderId: "OTHER" }, store, runtime, faux.getModel(), undefined, { groupOpenid });
    try {
      await otherActor.prompt(`选择金额基准 ${bCandidate.token}`);
      assert.equal(getSupportHostReceipt(otherActor)!.outcome, "rejected");
      assert.equal(reads, before.reads); assert.equal(modelResponses, before.modelResponses);
    } finally { otherActor.dispose(); }
    const append = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async () => { throw new Error("synthetic history failure"); };
    try {
      await prompt(`选择金额基准 ${bCandidate.token}`);
      assert.equal(getSupportHostReceipt(session)!.outcome, "selected");
      assert.equal(getSupportHostReceipt(session)!.historyFailed, true);
      assert.match((supportReply(session) as { text: string }).text, /已选择/);
    } finally { session.sendCustomMessage = append; }
    await compare(); assert.equal(getSupportHostReceipt(session), undefined);
    assert.equal(getSupportResult(session)!.evidence.amountComparison!.referenceRequestId, bCandidate.reference.requestId);
    await prompt(`选择金额基准 ${bCandidate.token}`); assert.equal(getSupportHostReceipt(session)!.outcome, "rejected", "new display invalidates the old token");
    await clarify();
    const updatedA = exposed().candidates.find(row => row.reference.orderId === a.id)!;
    await prompt(`选择金额基准 ${updatedA.token}`); await compare();
    assert.equal(getSupportResult(session)!.evidence.amountComparison, undefined);
    assert.match((supportReply(session) as { text: string }).text, /暂不支持跨订单/);
    await prompt(`选择金额基准 ${updatedA.token}\n并且退款`); assert.equal(getSupportHostReceipt(session)!.outcome, "rejected");
    await query(c.id); await clarify(); assert.equal(exposed().overflow, true); assert.equal(exposed().candidates.length, 2);
    assert.ok(!exposed().candidates.some(row => row.token === aCandidate.token));
    const token = exposed().candidates.at(-1)!.token;
    cancelSupportTurn(session); await prompt(`选择金额基准 ${token}`);
    assert.equal(getSupportHostReceipt(session)!.outcome, "rejected"); assert.equal(getSupportHostReceipt(session)!.choices.candidates.length, 0);
    await query(a.id); await clarify(); const externalToken = exposed().candidates[0]!.token;
    focus = c.id; await prompt(`选择金额基准 ${externalToken}`); assert.equal(getSupportHostReceipt(session)!.outcome, "rejected");
    await query(a.id); await clarify(); const failureToken = exposed().candidates[0]!.token;
    failReads = true; await query(a.id); failReads = false;
    await prompt(`选择金额基准 ${failureToken}`); assert.equal(getSupportHostReceipt(session)!.outcome, "rejected");
    await query(a.id); await clarify(); const modelErrorToken = exposed().candidates[0]!.token;
    await prompt("模型失败", [() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic model failure" })]);
    assert.ok(session.agent.state.errorMessage);
    await prompt(`选择金额基准 ${modelErrorToken}`); assert.equal(getSupportHostReceipt(session)!.outcome, "rejected");
    assert.ok(supportReply(session)); assert.equal(getSupportResult(session), undefined);
    await assert.rejects(prompt(`选择金额基准 ${modelErrorToken}`, [], "other-group"), /可信群路由/);
    assert.equal(getSupportHostReceipt(session), undefined); assert.equal(knowledge, 0);
    for (const bad of [{ requestId: "", messageId: "valid" }, { requestId: "valid", messageId: "" },
      { requestId: "x".repeat(513), messageId: "valid" }, { requestId: "valid", messageId: "x".repeat(513) }]) {
      prepareSupportPrompt(session, { ...bad, groupOpenid });
      await assert.rejects(session.prompt(`选择金额基准 ${modelErrorToken}`), /请求标识/);
      assert.equal(getSupportHostReceipt(session), undefined);
    }
  } finally { session.dispose(); }
  let release!: () => void, entered!: () => void, firstRead = true;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const race = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid,
    focus: { read: async () => { if (firstRead) { firstRead = false; entered(); await blocked; throw new Error("late old focus failure"); } return undefined; }, write: async () => {} } });
  try {
    const text = "选择金额基准 11111111-1111-4111-8111-111111111111";
    prepareSupportPrompt(race, { requestId: "old", messageId: "old", groupOpenid });
    const old = race.prompt(text).catch(error => error);
    await entering;
    prepareSupportPrompt(race, { requestId: "new", messageId: "new", groupOpenid });
    await race.prompt(text); assert.equal(getSupportHostReceipt(race)!.requestId, "new");
    release(); assert.ok(await old instanceof Error);
    assert.equal(getSupportHostReceipt(race)!.requestId, "new", "an old asynchronous focus failure cannot clear a newer host receipt");
    cancelSupportTurn(race); assert.equal(getSupportHostReceipt(race), undefined);
  } finally { release(); race.dispose(); }
  console.log("[support-amount] bounded source candidates, explicit host selection, stale/actor/group/cancel guards and zero-model receipt PASS");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportAmountContext();
