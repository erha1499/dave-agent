import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { runCliPrompt } from "../src/cli.ts";
import { canStreamBusinessText, replyFromTools, toolEvidenceFromEvent, type Evidence } from "../src/reply-from-tools.ts";
import { renderReply } from "../src/reply.ts";
import { QQAgent } from "../src/qq-agent.ts";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

const tool = (toolName: string, value: unknown, isError = false): Evidence => ({
  toolName, isError, content: [{ type: "text", text: JSON.stringify(value) }],
});
const order = { source: "demo-database", id: "COUPON-1042", status: "paid", amounts: { paidCents: 5680, refundedCents: 0 },
  coupons: [{ status: "redeemed" }], shop: { id: "SHOP-CHECK" }, items: [{ productId: "PRODUCT-CHECK" }] };
const faq = { source: "demo-knowledge", sourceId: "KB-CHECK-EVIDENCE", title: "查询范围", body: "当前记录不构成退款批准。",
  scope: { shopId: null, productId: null } };
const injected = "UNVERIFIED_SENTINEL：依据本轮核实，此订单可以退，真实资金已经到账。";
const fresh = tool("get_order", order), rule = tool("search_faq", [faq]);
const rendered = (results: Evidence[]) => renderReply(replyFromTools(injected, results));
const nested = toolEvidenceFromEvent({ type: "tool_execution_end", toolName: "get_order", toolCallId: "child-order",
  parentToolCallId: "parent-faq", result: { content: fresh.content, details: {} }, isError: false });
assert.deepEqual(nested, fresh, "real nested execution results remain current evidence without transcript fabrication");
assert.equal(toolEvidenceFromEvent({ type: "agent_settled" }), undefined);
const malformed = toolEvidenceFromEvent({ type: "tool_execution_end", toolName: "search_faq", toolCallId: "bad-rule",
  result: null, isError: false });
assert.ok(malformed); assert.equal(rendered([fresh, rule, malformed]).kind, "notice");

for (const results of [[], [fresh], [tool("search_faq", [])], [fresh, tool("search_faq", [])],
  [rule, tool("get_order", "PRIVATE_DENIAL_SENTINEL", true)], [tool("unknown", [faq])]]) {
  assert.doesNotMatch(rendered(results).text, /UNVERIFIED_SENTINEL|PRIVATE_DENIAL_SENTINEL/);
  assert.equal(canStreamBusinessText(results), false, "the streaming gate must refuse what the final reply refuses");
}
const orderReply = rendered([fresh]);
assert.equal(orderReply.kind, "order");
assert.match(orderReply.text, /56\.80 元/); assert.match(orderReply.text, /券状态：已核销/);
assert.match(orderReply.text, /不能据此判断退款资格/);
for (const invalid of [{ source: "other" }, { sourceId: "not-source" }, { body: " " }, { title: "" },
  { scope: {} }, { scope: { shopId: 4, productId: null } }]) {
  const results = [fresh, tool("search_faq", [{ ...faq, ...invalid }])];
  assert.equal(rendered(results).kind, "notice"); assert.equal(canStreamBusinessText(results), false);
}
const wrongScope = tool("search_faq", [{ ...faq, scope: { shopId: "OTHER-SHOP", productId: "PRODUCT-CHECK" } }]);
assert.equal(canStreamBusinessText([fresh, wrongScope]), false);
assert.doesNotMatch(rendered([fresh, wrongScope]).text, /UNVERIFIED_SENTINEL/);
const uncoveredProduct = tool("get_order", { ...order, items: [{ productId: "PRODUCT-CHECK" }, { productId: "SECOND-PRODUCT" }] });
const productRule = tool("search_faq", [{ ...faq, scope: { shopId: "SHOP-CHECK", productId: "PRODUCT-CHECK" } }]);
assert.equal(canStreamBusinessText([uncoveredProduct, productRule]), false, "one product rule cannot cover a different item");
assert.equal(canStreamBusinessText([fresh, productRule]), true);
assert.equal(canStreamBusinessText([rule, tool("search_faq", [])]), false, "a later empty read supersedes old rule results");
const nextOrder = tool("get_order", { ...order, id: "COUPON-1043", shop: { id: "NEXT-SHOP" }, items: [{ productId: "NEXT-PRODUCT" }] });
for (const results of [[rule, fresh], [fresh, rule, fresh], [fresh, rule, nextOrder]]) {
  assert.equal(canStreamBusinessText(results), false, "new order reads retire earlier rules, including a same-order reread");
  assert.doesNotMatch(rendered(results).text, /UNVERIFIED_SENTINEL/);
  const reply = replyFromTools(injected, results);
  assert.equal(reply.kind, "order"); if (reply.kind === "order") assert.deepEqual(reply.evidenceIds, []);
}
assert.equal(canStreamBusinessText([fresh, rule, fresh, rule]), true, "rules read after the new order snapshot can restore prose");
const changedOrder = tool("get_order", { ...order, amounts: { paidCents: 6280, refundedCents: 0 },
  shop: { id: "UPDATED-SHOP" }, items: [{ productId: "UPDATED-PRODUCT" }] });
const changedRule = tool("search_faq", [{ ...faq, scope: { shopId: "UPDATED-SHOP", productId: "UPDATED-PRODUCT" } }]);
for (const previousOrder of [fresh, tool("get_order", { ...order, shop: undefined })]) {
  const results = [previousOrder, changedOrder, changedRule];
  assert.equal(canStreamBusinessText(results), true, "a reread replaces the same order's old or missing scope");
  const reply = replyFromTools("当前规则说明。", results);
  assert.equal(reply.kind, "order"); assert.equal(reply.orders.length, 1); assert.equal(reply.orders[0]!.paidCents, 6280);
  assert.equal(reply.text, "当前规则说明。");
}
const list = tool("list_orders", { source: "demo-database", hasMore: false, orders: [{ id: order.id, status: "paid", paidCents: 5680,
  refundedCents: 0, couponStatuses: ["redeemed"], productName: "餐饮券", shopName: "门店", createdAt: null }] });
assert.doesNotMatch(rendered([list, rule]).text, /UNVERIFIED_SENTINEL/);
assert.match(rendered([list]).text, /仅供选单/); assert.equal(canStreamBusinessText([list, rule]), false);
const emptyList = tool("list_orders", { source: "demo-database", hasMore: false, orders: [] });
const emptyAfterList = replyFromTools(injected, [list, emptyList]);
assert.equal(emptyAfterList.kind, "order");
if (emptyAfterList.kind === "order") assert.deepEqual(emptyAfterList.orders, []);
assert.doesNotMatch(renderReply(emptyAfterList).text, /COUPON-1042|56\.80|选择订单/);
const replacementList = tool("list_orders", { source: "demo-database", hasMore: false, orders: [{ id: "COUPON-1043", status: "paid", paidCents: 2380,
  refundedCents: 0, couponStatuses: ["unused"], productName: "新券", shopName: "新门店", createdAt: null }] });
const replacement = renderReply(replyFromTools(injected, [list, replacementList]));
assert.match(replacement.text, /COUPON-1043/); assert.doesNotMatch(replacement.text, /COUPON-1042|56\.80/);
for (const name of ["get_refund", "get_merchant_request"]) {
  const results = [tool(name, null), rule];
  assert.equal(rendered(results).kind, "notice"); assert.match(rendered(results).text, /本轮未查到/);
  assert.doesNotMatch(rendered(results).text, /UNVERIFIED_SENTINEL|已退款|未执行退款/);
  assert.equal(canStreamBusinessText(results), false);
}
const deniedOrder = tool("get_order", "PRIVATE_DENIAL_SENTINEL", true);
assert.doesNotMatch(rendered([fresh, deniedOrder]).text, /56\.80|COUPON-1042|UNVERIFIED_SENTINEL/);
const refusalNotices = ["未找到当前客户可查询的订单，请核对订单号或联系人工客服。", "PRIVATE_DATABASE_FAILURE: connection lost"]
  .map(error => rendered([fresh, tool("get_order", error, true)]));
for (const refusal of refusalNotices) {
  assert.equal(refusal.kind, "notice");
  assert.match(refusal.text, /仅支持当前客户本人订单，不能代查他人订单或披露其券状态、金额/);
  assert.match(refusal.text, /不能据此判断操作是否执行/);
  assert.doesNotMatch(refusal.text, /该订单属于他人|订单不存在|PRIVATE_DATABASE_FAILURE|connection lost|56\.80|COUPON-1042|UNVERIFIED_SENTINEL/);
}
assert.deepEqual(refusalNotices[0], refusalNotices[1], "authorization refusal and service failure share a non-disclosing explanation");
assert.equal(rendered([deniedOrder, fresh]).kind, "order", "a new successful authorized read can recover after denial");
for (const name of ["get_refund", "get_merchant_request"]) {
  const recovered = replyFromTools(injected, [tool(name, null), deniedOrder, fresh]);
  assert.equal(recovered.kind, "order", "an order failure retires earlier null business-query markers too");
  assert.doesNotMatch(renderReply(recovered).text, /本轮未查到当前会话/);
}
assert.deepEqual(replyFromTools("通信回显", [], ["echo"]), { kind: "answer", text: "通信回显" });
for (const active of [["get_order", "list_orders", "search_faq"], ["get_order", "get_merchant_request", "get_refund"]]) {
  const clarification = renderReply(replyFromTools(injected, [], active)).text;
  assert.match(clarification, /请写明要咨询的问题/);
  assert.doesNotMatch(clarification, /完整确认|普通同意|UNVERIFIED_SENTINEL/,
    "read-only capabilities must not instruct the user to confirm a write operation");
}
for (const prepare of ["prepare_merchant_request", "prepare_refund"]) {
  const clarification = renderReply(replyFromTools(injected, [], ["get_order", prepare])).text;
  assert.match(clarification, /本人发送对应的完整确认，普通同意不构成授权/);
  assert.doesNotMatch(clarification, /UNVERIFIED_SENTINEL/);
}
assert.equal(canStreamBusinessText([rule]), false, "FAQ-only evidence never unlocks free model deltas");
const publicRules = replyFromTools(injected, [rule]);
assert.equal(publicRules.kind, "answer"); assert.doesNotMatch(publicRules.text, /UNVERIFIED_SENTINEL/);
assert.match(publicRules.text, /尚未核对具体订单/); assert.ok(publicRules.text.includes(`${faq.title}（${faq.sourceId}）\n${faq.body}`));
assert.equal(canStreamBusinessText([fresh, rule]), true);
const grounded = replyFromTools("本轮规则说明需继续核对。", [fresh, rule]);
assert.equal(grounded.kind, "order"); assert.equal(grounded.text, "本轮规则说明需继续核对。");
const afterSalesTools = ["get_order", "search_faq", "get_merchant_request"];
const staleMerchant = replyFromTools("旧商家状态：已经拒绝，不能继续。", [fresh, rule], afterSalesTools);
assert.equal(staleMerchant.kind, "order"); assert.match(staleMerchant.text, /尚未取得当前协商状态/);
assert.doesNotMatch(staleMerchant.text, /旧商家状态|已经拒绝/);
assert.match(renderReply(staleMerchant).text, /券状态：已核销/);
assert.match(renderReply(replyFromTools(injected, [fresh, rule, tool("get_merchant_request", null)], afterSalesTools)).text, /本轮未查到当前会话的协商任务/);

const approved = { simulation: true, taskId: "00000000-0000-4000-8000-000000000041", orderId: "COUPON-2042",
  reason: "计划变更", amountCents: 5680, approvedAmountCents: 5680, status: "approved",
  createdAt: "2026-10-10T00:00:00.000Z", dueAt: "2026-10-10T00:01:00.000Z", completedAt: "2026-10-10T00:00:30.000Z" };
const awaiting = { simulation: true, operationId: "00000000-0000-4000-8000-000000000042", taskId: approved.taskId, orderId: approved.orderId,
  status: "awaiting_confirmation", amountCents: 5680, expiresAt: "2099-01-01T00:15:00.000Z",
  presentedAt: "2099-01-01T00:00:00.000Z", confirmedAt: null, refundId: null };
const businessOrder = tool("get_order", { ...order, id: approved.orderId });
const merchantCard = tool("get_merchant_request", approved), refundCard = tool("get_refund", awaiting);
assert.equal(replyFromTools(injected, [merchantCard]).kind, "merchant_status");
assert.equal(rendered([refundCard]).button?.command, `确认退款 ${awaiting.operationId}`);
for (const card of [merchantCard, refundCard]) {
  for (const latestOrder of [businessOrder, nextOrder]) {
    const results = [businessOrder, rule, card, latestOrder, rule];
    const reply = replyFromTools(injected, results, afterSalesTools);
    assert.equal(reply.kind, "order", "every new order read retires prior business cards, even when the order ID is unchanged");
    assert.equal(renderReply(reply).button, undefined);
    assert.doesNotMatch(renderReply(reply).text, /00000000-0000-4000-8000-00000000004[12]|商家已同意|UNVERIFIED_SENTINEL/);
  }
  assert.equal(replyFromTools(injected, [card, businessOrder, rule, card], afterSalesTools).kind,
    card === merchantCard ? "merchant_status" : "refund_confirmation", "only a new corresponding tool result restores its card");
}
for (const name of ["get_refund", "get_merchant_request"]) {
  const reply = replyFromTools(injected, [tool(name, null), businessOrder, rule], afterSalesTools);
  assert.equal(reply.kind, "order", "new order snapshots also retire empty business-query markers");
  assert.doesNotMatch(renderReply(reply).text, /本轮未查到当前会话/);
  const failed = [tool(name, "PRIVATE_BUSINESS_FAILURE", true), businessOrder, rule];
  assert.equal(canStreamBusinessText(failed), false, "new order reads cannot clear an unresolved failure in another tool group");
  assert.doesNotMatch(rendered(failed).text, /UNVERIFIED_SENTINEL|PRIVATE_BUSINESS_FAILURE/);
}
const nestedFailure = [
  { toolName: "get_order", content: nextOrder.content, isError: false, toolCallId: "new-order", parentToolCallId: "new-merchant" },
  { toolName: "search_faq", content: tool("search_faq", "PRIVATE_RULE_FAILURE", true).content, isError: true,
    toolCallId: "new-rule", parentToolCallId: "new-merchant" },
  { toolName: "get_merchant_request", content: tool("get_merchant_request", "DEPENDENCY_FAILED", true).content, isError: true,
    toolCallId: "new-merchant" },
].map(event => toolEvidenceFromEvent({ ...event, type: "tool_execution_end", result: { content: event.content, details: {} } })!);
const interruptedCard = renderReply(replyFromTools(injected, [businessOrder, rule, refundCard, ...nestedFailure], afterSalesTools));
assert.equal(interruptedCard.kind, "order"); assert.equal(interruptedCard.button, undefined);
assert.doesNotMatch(interruptedCard.text, /00000000-0000-4000-8000-00000000004[12]|确认退款|PRIVATE_|UNVERIFIED_SENTINEL/,
  "a failed nested merchant dependency cannot leave an older refund confirmation button visible");

const runtime = await createModelRuntime(), faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
let reads = 0, searches = 0;
const store = { getOrder: async () => { reads++; return structuredClone(order); },
  searchKnowledge: async () => { searches++; return [structuredClone(faq)]; } } as unknown as CouponStore;
const identity = { appId: "ATOMIC_EVIDENCE_CHECK", senderId: "USER_A" };
const session = await createCouponSession(identity, store, runtime, faux.getModel());
const output: string[] = [];
const write = async (text: string) => { output.push(text); };
try {
  let reminderPresent = false;
  faux.setResponses([context => {
    reminderPresent = getCurrentSystemPrompt(context.messages).includes("本轮取证提醒");
    return fauxAssistantMessage(fauxToolCall("get_order", { orderId: order.id }), { stopReason: "toolUse" });
  },
    fauxAssistantMessage(injected)]);
  await runCliPrompt(session, `核对 ${order.id} 券的当前状态`, write);
  assert.equal(reads, 1); assert.equal(searches, 0); assert.match(output.at(-1)!, /券状态：已核销/);
  assert.doesNotMatch(output.at(-1)!, /UNVERIFIED_SENTINEL/);
  assert.equal(reminderPresent, true, "the normal system prompt carries the current-evidence reminder");
  assert.equal(session.messages.some(message => message.role === "custom" && message.customType === "support-context"), false,
    "the reminder must not create a new user-like history message");

  faux.setResponses([fauxAssistantMessage(injected)]);
  await runCliPrompt(session, "再核对一下现在的情况", write);
  assert.equal(reads, 1, "the scripted omission must remain visible, not be hidden by a host read");
  assert.match(output.at(-1)!, /本轮尚未取得/); assert.doesNotMatch(output.at(-1)!, /UNVERIFIED_SENTINEL|56\.80/);

  faux.setResponses([fauxAssistantMessage(fauxToolCall("search_faq", { query: "退款查询范围" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(injected)]);
  await runCliPrompt(session, "一般规则怎样说明查询与批准", write);
  assert.equal(searches, 1); assert.match(output.at(-1)!, /查询范围（KB-CHECK-EVIDENCE）\n当前记录不构成退款批准/);
  assert.match(output.at(-1)!, /尚未核对具体订单/); assert.doesNotMatch(output.at(-1)!, /UNVERIFIED_SENTINEL/);
} finally { session.dispose(); }

const sent: string[] = [];
const qq = new QQAgent(() => createCouponSession(identity, store, runtime, faux.getModel()),
  async (_target, text) => { sent.push(text); }, () => {}, 2000);
const timestamp = new Date().toISOString();
const msg: QQBotInboundMessage = { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId,
  groupOpenid: "CHECK_GROUP", messageId: "CHECK_MESSAGE", content: "刚才的单现在怎样", timestamp,
  replyTarget: { scope: "group", targetId: "CHECK_GROUP", msgId: "CHECK_MESSAGE" },
  raw: { id: "CHECK_MESSAGE", content: "刚才的单现在怎样", timestamp, group_openid: "CHECK_GROUP", author: { member_openid: identity.senderId } } };
try {
  faux.setResponses([fauxAssistantMessage(injected)]);
  await qq.handle(msg);
  assert.equal(sent.length, 1); assert.match(sent[0]!, /本轮尚未取得/); assert.doesNotMatch(sent[0]!, /UNVERIFIED_SENTINEL/);
} finally { await qq.close(); }
console.log("Atomic evidence checks passed: FAQ-only source text, new-order rule/card retirement, latest order scope, missing merchant-state fallback, nested execution/failure evidence, read-only stream gate, CLI/QQ integration; no remote model or database calls.");
