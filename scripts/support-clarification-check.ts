import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { parseSupportAction } from "../src/support-action.ts";
import { parseContextSupportAction, type ContextClarificationField } from "../src/support-context-action.ts";
import { createSupportSession, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";

// Exercise Pi validation, host rendering and a real follow-up dispatch; faux only
// supplies the selected action. This does not measure natural-language selection.
const runtime = await createModelRuntime(), faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const identity = { appId: "clarification-app", senderId: "clarification-user" }, group = "clarification-group";
let reads = 0, searches = 0;
const orderId = "COUPON-9901", timestamp = "2026-10-06T00:00:00.000Z";
const store = { async getOrder(actor: typeof identity, id: string) {
  reads++; assert.deepEqual(actor, identity); assert.equal(id, orderId);
  return { source: "demo-database", id, status: "paid", asOf: timestamp, createdAt: timestamp, paidAt: timestamp,
    amounts: { totalCents: 5980, paidCents: 5980, refundedCents: 0 },
    shop: { id: "shop", name: "模拟门店", merchantName: "模拟商家", address: "模拟地址" },
    items: [{ id: "item", productId: "product", productName: "双人套餐", quantity: 1, unitPriceCents: 5980, totalCents: 5980 }],
    coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 5980, paidAt: timestamp }], refunds: [] };
}, async searchKnowledge() { searches++; throw new Error("clarification must not retrieve"); } } as unknown as CouponStore;
const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid: group });
let request = 0;
async function run(question: string, action: unknown) {
  const requestId = `clarification-${++request}`;
  prepareSupportPrompt(session, { requestId, groupOpenid: group, messageId: requestId });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("support_action", { action: parseContextSupportAction(action) }), { stopReason: "toolUse" }),
    fauxAssistantMessage("已批准退款99元，确认链接：https://example.invalid"),
  ]);
  await session.prompt(question, { expandPromptTemplates: false });
  assert.equal(faux.getPendingResponseCount(), 0);
  return supportReply(session, "已批准退款99元，确认链接：https://example.invalid")!;
}
try {
  const cases: Array<{ field: ContextClarificationField; question: string; required: RegExp[] }> = [
    { field: "amount_basis", question: "剩下这张和先前那个数一样吗？", required: [/实付/, /(?:查询|展示|选择)/] },
    { field: "time_channel", question: "超过那个时间该怎么办？", required: [/支付渠道/, /审核/, /到账/] },
    { field: "actor", question: "这个也需要他同意吗？", required: [/操作/, /商家/, /平台/] },
    { field: "policy_topic", question: "能按之前那种方式分开使用吗？", required: [/规则/, /哪一种/] },
  ];
  for (const item of cases) {
    const action = { protocol: "v2.2", kind: "clarify", field: item.field, reason: "missing" };
    assert.deepEqual(parseContextSupportAction(action), action);
    assert.throws(() => parseSupportAction({ kind: "clarify", field: item.field, reason: "missing" }), "legacy schema remains unchanged");
    assert.throws(() => parseContextSupportAction({ ...action, text: "商家已同意" }));
    const reply = await run(item.question, action);
    assert.equal(reply.kind, "notice");
    if (reply.kind !== "notice") throw new Error("expected fixed clarification");
    item.required.forEach(pattern => assert.match(reply.text, pattern));
    assert.doesNotMatch(reply.text, /99元|https:|已批准/);
    assert.equal(getSupportResult(session)?.outcome, "clarification");
    assert.deepEqual(getSupportResult(session)?.evidence.actualCalls, []);
  }
  assert.equal(reads, 0); assert.equal(searches, 0);
  const reply = await run(`请查询 ${orderId}，展示每券实付`, { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId } });
  assert.equal(reply.kind, "order"); assert.equal(reads, 1); assert.equal(searches, 0);
  assert.equal(getSupportResult(session)?.evidence.displayedPaidUnit?.paidCents, 5980);
  assert.equal(getSupportResult(session)?.outcome, "ready");
  console.log("[support-clarification] bounded missing-field prompts, fixed replies, zero premature calls and clarified follow-up PASS");
} finally { session.dispose(); }
