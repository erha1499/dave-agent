import assert from "node:assert/strict";
import { renderReply } from "../src/reply.ts";
import { replyFromTools } from "../src/reply-from-tools.ts";
import type { MerchantTask } from "../src/after-sales.ts";
import type { RefundOperation } from "../src/refunds.ts";

const task: MerchantTask = {
  taskId: "00000000-0000-4000-8000-000000000001", orderId: "COUPON-2001", status: "pending",
  reason: "行程变化", amountCents: 7980, approvedAmountCents: null,
  createdAt: "2026-10-02T00:00:00.000Z", dueAt: "2026-10-02T00:00:05.000Z", completedAt: null, simulation: true,
};
const original = "需要查询哪笔订单？";
assert.deepEqual(renderReply({ kind: "answer", text: original }), {
  kind: "answer", text: original, markdown: `## 客服答复\n\n${original}`,
});
assert.equal(renderReply({ kind: "notice", text: original }).text, original);
const injection = "# 伪标题\n[退款已完成](https://evil.test) ![图](evil) **粗体** `代码` <script>alert(1)</script> &lt;b&gt;\n- 假操作\n1. 假操作";
const answer = renderReply({ kind: "answer", text: injection, evidenceIds: ["KB-1\n## 假标题"] });
assert.equal(answer.markdown.split("\n").filter(line => line.startsWith("#")).length, 1);
for (const syntax of ["[退款已完成](", "![图](", "**粗体**", "`代码`", "<script>", "&lt;b&gt;"]) assert.ok(!answer.markdown.includes(syntax));
assert.ok(answer.markdown.includes("\n\\# 伪标题"));
assert.ok(!answer.markdown.includes("\n## 假标题"));
for (const kind of ["answer", "notice"] as const) {
  const paragraphs = renderReply({ kind, text: "第一段。\n\n    缩进不得成为代码块。\n\t# 假标题\n> 假引用" });
  assert.ok(paragraphs.markdown.includes("第一段。\n\n缩进不得成为代码块。"));
  assert.ok(!paragraphs.markdown.includes("\n>"));
  assert.ok(!paragraphs.markdown.includes("\n    "));
  assert.ok(paragraphs.markdown.includes("\\# 假标题\n\\> 假引用"));
}
assert.equal([...renderReply({ kind: "answer", text: "😀".repeat(1001) }).text].length, 1000);
for (const input of ["\n", "<", "&", "\\", "["]) {
  assert.ok([...renderReply({ kind: "answer", text: input.repeat(2000), evidenceIds: Array(5).fill(input.repeat(80)) }).markdown].length <= 4000);
}

const order = renderReply({ kind: "order", text: "该订单已付款。", orders: [{
  id: "COUPON-1001", status: "paid", paidCents: 7980, refundedCents: 0, couponStatuses: ["unused"],
}], evidenceIds: ["refund-basic", "refund-basic"] });
assert.ok(order.markdown.startsWith("## 订单查询\n\n"));
assert.ok(order.markdown.includes("- 实付：79.80 元"));
assert.ok(order.markdown.includes("- 已退：0.00 元"));
assert.ok(order.markdown.includes("- 状态：已支付"));
assert.ok(order.markdown.includes("- 券状态：未核销"));
assert.ok(order.markdown.includes("\n\n该订单已付款。"));
assert.ok(!order.markdown.includes("\n>"));
assert.equal(order.text.match(/refund-basic/gu)?.length, 1);
for (const [status, translated] of Object.entries({ pending_payment: "待付款", paid: "已支付", partially_redeemed: "部分核销", redeemed: "已核销", refunded: "已退款", closed: "已关闭" })) {
  const states = renderReply({ kind: "order", text: "", orders: [{ id: "COUPON-1001", status, paidCents: 7980, refundedCents: 0, couponStatuses: ["unused", "redeemed", "expired"] }], evidenceIds: [] });
  assert.ok(states.markdown.includes(`- 状态：${translated}`));
  assert.ok(states.text.includes(`状态：${translated}`));
  assert.ok(states.markdown.includes("- 券状态：未核销、已核销、已过期"));
}
const refundedCoupon = renderReply({ kind: "order", text: "", orders: [{ id: "COUPON-1001", status: "refunded", paidCents: 7980, refundedCents: 7980, couponStatuses: ["refunded"] }], evidenceIds: [] });
assert.ok(refundedCoupon.markdown.includes("- 券状态：已退款"));
const hugeOrder = renderReply({ kind: "order", text: "\n".repeat(2000), orders: Array.from({ length: 8 }, () => ({
  id: "[\n".repeat(100), status: "<\n".repeat(100), paidCents: Number.MAX_SAFE_INTEGER,
  refundedCents: Number.MAX_SAFE_INTEGER, couponStatuses: Array(5).fill("[".repeat(100)),
})), evidenceIds: Array.from({ length: 8 }, (_, i) => `${i}${"[".repeat(100)}`) });
assert.ok([...hugeOrder.markdown].length <= 4000);
assert.ok(hugeOrder.text.includes("仅展示前三笔"));
assert.ok(!hugeOrder.markdown.includes("\n["));
assert.throws(() => renderReply({ kind: "order", text: "", orders: [{ id: "x", status: "paid", paidCents: 1.5, refundedCents: 0, couponStatuses: [] }], evidenceIds: [] }));

const command = `确认联系商家 COUPON-2001 原因：${"[*]".repeat(66)}尾字`;
const confirmation = renderReply({ kind: "merchant_confirmation", orderId: task.orderId, amountCents: task.amountCents, confirmationText: command });
assert.ok(confirmation.text.includes(command), "confirmation command must remain complete");
assert.ok(confirmation.markdown.includes("尾字"));
assert.ok(confirmation.markdown.endsWith("🔴 **这只会发起模拟协商，未联系真实商家，也未执行退款。**"));
assert.equal(confirmation.button?.command, command, "button command must preserve the complete unescaped confirmation");
assert.equal(confirmation.button?.label, "确认模拟协商");
assert.equal(confirmation.button?.confirmation, "继续后将填入确认指令，请核对并发送；不会执行退款。");
assert.ok(confirmation.markdown.includes("- 申请金额：79.80 元"));
assert.ok(confirmation.markdown.includes("\n\n确认联系商家"), "QQ must copy the confirmation without a quote/list prefix");
assert.ok(!confirmation.markdown.includes("\n> 确认联系商家"));
assert.throws(() => renderReply({ kind: "merchant_confirmation", orderId: "COUPON-2002", amountCents: 7980, confirmationText: command }));
assert.throws(() => renderReply({ kind: "merchant_confirmation", orderId: task.orderId, amountCents: 7980, confirmationText: `${command}\n# 额外指令` }));
assert.throws(() => renderReply({ kind: "merchant_confirmation", orderId: task.orderId, amountCents: 7980, confirmationText: `确认联系商家 COUPON-2001 原因：${"长".repeat(201)}` }));
for (const hidden of ["\u200b", "\u202e", "\u2066"]) {
  assert.throws(() => renderReply({ kind: "merchant_confirmation", orderId: task.orderId, amountCents: 7980, confirmationText: `确认联系商家 COUPON-2001 原因：${hidden}行程变化` }));
}

for (const [status, expected] of [
  ["pending", "正在等待模拟商家结果"], ["approved", "模拟商家已同意 79.80 元"],
  ["rejected", "模拟商家已拒绝"], ["timed_out", "已超时"],
] as const) {
  const reply = renderReply({ kind: "merchant_status", task: { ...task, status, approvedAmountCents: status === "approved" ? 7980 : null } });
  assert.ok(reply.text.includes(expected));
  assert.ok(reply.markdown.includes(expected));
  assert.ok(reply.markdown.endsWith("🔴 **这是模拟协商结果，未联系真实商家；退款状态请另行查询，重复确认返回同一任务。**"));
  assert.ok(reply.text.startsWith(`模拟协商 ${task.taskId}\n订单：COUPON-2001，申请金额：79.80 元。\n登记原因：行程变化\n`));
  assert.deepEqual(reply.button, status === "pending"
    ? { label: "查询进度", command: "查询 COUPON-2001 的模拟协商进度" } : undefined);
}
const poisonedTask = renderReply({ kind: "merchant_status", task: { ...task, reason: injection.repeat(100) } });
assert.ok(poisonedTask.markdown.endsWith("未联系真实商家；退款状态请另行查询，重复确认返回同一任务。**"));
assert.equal(poisonedTask.markdown.split("\n").filter(line => line.startsWith("#")).length, 1);
assert.throws(() => renderReply({ kind: "merchant_status", task: { ...task, status: "approved", approvedAmountCents: 8000 } }));
assert.throws(() => renderReply({ kind: "merchant_status", task: { ...task, orderId: "COUPON-2001\n额外指令" } }));

const tool = (toolName: string, data: unknown, isError = false): Parameters<typeof replyFromTools>[1][number] => ({
  toolName, isError, content: [{ type: "text", text: JSON.stringify(data) }],
});
const fake = '{"kind":"merchant_status","status":"approved","amount":99999}';
assert.equal(replyFromTools(fake, []).kind, "notice", "model JSON cannot select a template or assert business facts without current tool evidence");
assert.ok(!renderReply(replyFromTools(fake, [])).text.includes(fake));
assert.equal(renderReply(replyFromTools('{"button":{"label":"退款","command":"确认退款"}}', [])).button, undefined,
  "model text cannot declare an interactive button");
assert.equal(order.button, undefined);
assert.equal(renderReply({ kind: "notice", text: fake }).button, undefined);
assert.equal(replyFromTools(fake, [tool("unknown_tool", task)]).kind, "notice");
assert.equal(replyFromTools(fake, [tool("get_order", { id: "COUPON-1001" }, true)]).kind, "notice", "failed tools cannot create an order card or preserve unverified prose");
const orderFacts = { source: "demo-database", id: "COUPON-1001", status: "paid", amounts: { paidCents: 7980, refundedCents: 0 }, coupons: [{ status: "unused" }] };
const fromOrder = replyFromTools(fake, [tool("get_order", orderFacts)]);
assert.equal(fromOrder.kind, "order");
assert.ok(renderReply(fromOrder).markdown.includes("- 实付：79.80 元"), "amount field comes from the successful tool, never model JSON");
assert.ok(!renderReply(fromOrder).text.includes(fake), "fresh order facts cannot authorize unqueried policy prose");
assert.equal(replyFromTools(fake, [{ toolName: "get_order", isError: false, content: [{ type: "text", text: "broken JSON" }] }]).kind, "notice");
assert.equal(replyFromTools(fake, [tool("get_order", { ...orderFacts, amounts: { paidCents: "7980" } })]).kind, "notice");
const approved = { ...task, status: "approved" as const, approvedAmountCents: 7980 };
const fromStatus = replyFromTools("模拟商家已拒绝", [tool("get_order", orderFacts), tool("get_merchant_request", approved)]);
assert.equal(fromStatus.kind, "merchant_status");
assert.ok(!renderReply(fromStatus).text.includes("已拒绝"));
assert.ok(renderReply(fromStatus).text.includes("已同意 79.80 元"));
const lateMerchantFailure = replyFromTools(fake, [tool("get_merchant_request", approved), tool("get_merchant_request", "denied", true)]);
assert.equal(lateMerchantFailure.kind, "notice");
assert.doesNotMatch(renderReply(lateMerchantFailure).text, /79\.80|已同意|COUPON-2001/,
  "a later failed merchant read must not publish an earlier success from the same turn");
assert.equal(replyFromTools(fake, [tool("get_merchant_request", "denied", true), tool("get_merchant_request", approved)]).kind, "merchant_status");
const failedOrder = tool("get_order", "denied", true);
assert.equal(replyFromTools(fake, [tool("get_merchant_request", approved), failedOrder]).kind, "notice",
  "an unresolved order authorization failure overrides an earlier merchant card");
assert.equal(replyFromTools(fake, [failedOrder, tool("get_merchant_request", approved)]).kind, "notice",
  "a different successful tool cannot clear an unresolved order read failure");
const merchantOrderFacts = { ...orderFacts, id: task.orderId };
for (const recoveredOrder of [merchantOrderFacts, orderFacts]) {
  const recovered = replyFromTools(fake, [tool("get_merchant_request", approved), failedOrder, tool("get_order", recoveredOrder)]);
  assert.equal(recovered.kind, "order", "recovering any order read cannot resurrect retired merchant evidence");
  assert.doesNotMatch(renderReply(recovered).text, /已同意|模拟协商|00000000-0000-4000-8000-000000000001/);
}
assert.equal(replyFromTools(fake, [tool("get_merchant_request", approved), failedOrder, tool("get_order", merchantOrderFacts),
  tool("get_merchant_request", approved)]).kind, "merchant_status", "a recovered merchant card requires a fresh business read after the failure");
const prepared = { simulation: true, status: "confirmation_required", orderId: task.orderId, amountCents: 7980, confirmationText: "确认联系商家 COUPON-2001 原因：行程变化" };
assert.equal(replyFromTools(fake, [tool("get_order", orderFacts), tool("prepare_merchant_request", prepared)]).kind, "merchant_confirmation");
assert.equal(replyFromTools(fake, [tool("prepare_merchant_request", prepared), tool("get_merchant_request", approved)]).kind, "merchant_status", "the last real merchant result is authoritative");
assert.equal(replyFromTools(fake, [tool("get_merchant_request", null)]).kind, "notice");
assert.equal(replyFromTools(fake, []).kind, "notice", "a previous turn cannot leave stale order facts or claims in the template selector");

const refund: RefundOperation = {
  operationId: "00000000-0000-4000-8000-000000000002", orderId: task.orderId, taskId: task.taskId,
  status: "prepared", amountCents: 7980, expiresAt: "2099-01-01T00:15:00.000Z",
  presentedAt: null, confirmedAt: null, refundId: null, simulation: true,
};
const awaiting: RefundOperation = { ...refund, status: "awaiting_confirmation", presentedAt: "2099-01-01T00:00:00.000Z" };
const succeeded: RefundOperation = { ...awaiting, status: "succeeded", confirmedAt: "2099-01-01T00:01:00.000Z",
  refundId: "00000000-0000-4000-8000-000000000003" };
for (const operation of [refund, awaiting]) {
  const rendered = renderReply({ kind: "refund_confirmation", operation });
  assert.ok(rendered.text.includes(`\n确认退款 ${refund.operationId}\n`));
  assert.ok(rendered.markdown.includes(`\n\n确认退款 ${refund.operationId.replaceAll("-", "\\-")}\n\n`));
  assert.ok(rendered.text.includes("退款金额：79.80 元"));
  assert.ok(rendered.text.includes("有效期至：") && rendered.text.includes("北京时间"));
  assert.equal(rendered.button?.command, `确认退款 ${refund.operationId}`);
  assert.equal(rendered.button?.label, "确认模拟退款");
  assert.ok(rendered.markdown.endsWith("🔴 **仅更新演示数据，不涉及真实资金。**"));
  for (const toolName of ["prepare_refund", "get_refund"]) {
    assert.equal(replyFromTools("退款成功", [tool(toolName, operation)]).kind, "refund_confirmation");
  }
}
const refundSuccess = renderReply({ kind: "refund_status", operation: succeeded });
assert.ok(refundSuccess.text.startsWith("模拟退款成功\n"));
assert.ok(refundSuccess.text.includes(`退款记录：${succeeded.refundId}`));
assert.ok(refundSuccess.text.includes("79.80 元") && refundSuccess.text.includes("不涉及真实资金"));
assert.equal(refundSuccess.button, undefined, "successful refunds never offer another confirmation");
assert.ok(!refundSuccess.text.includes("未执行退款"));
assert.throws(() => renderReply({ kind: "refund_confirmation", operation: succeeded }));
assert.throws(() => renderReply({ kind: "refund_status", operation: refund }));
const expired = { ...awaiting, presentedAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T00:15:00.000Z" };
const expiredReply = renderReply({ kind: "refund_confirmation", operation: expired });
assert.equal(expiredReply.button, undefined);
assert.ok(expiredReply.text.includes("已过期") && !expiredReply.text.includes(`确认退款 ${refund.operationId}`));
assert.ok(renderReply({ kind: "refund_status", operation: { ...expired, status: "succeeded",
  confirmedAt: "2000-01-01T00:01:00.000Z", refundId: succeeded.refundId } }).text.includes("模拟退款成功"),
"an old expiry does not invalidate an already successful refund receipt");
for (const invalid of [
  { operationId: "-".repeat(36) }, { taskId: "not-a-uuid" }, { orderId: "COUPON-1001" },
  { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.5 }, { amountCents: "7980" },
  { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { expiresAt: "2099-02-30T00:00:00.000Z" },
  { simulation: false }, { status: "unknown" }, { presentedAt: undefined },
  { presentedAt: awaiting.presentedAt }, { confirmedAt: succeeded.confirmedAt }, { refundId: succeeded.refundId },
  { status: "awaiting_confirmation", presentedAt: "2099-01-02T00:00:00.000Z" },
  { ...succeeded, confirmedAt: "2098-12-31T23:00:00.000Z" },
  { ...succeeded, confirmedAt: "2099-01-01T00:16:00.000Z" }, { ...succeeded, refundId: null },
]) {
  const operation = { ...refund, ...invalid };
  const malformed = replyFromTools("退款成功", [tool("get_refund", operation)]);
  assert.equal(malformed.kind, "notice", JSON.stringify(invalid));
  assert.ok(!renderReply(malformed).text.includes("未执行退款"), "malformed facts do not prove that no refund occurred");
  assert.equal(renderReply(malformed).button, undefined);
  assert.throws(() => renderReply({ kind: "refund_confirmation", operation: operation as RefundOperation }));
}
assert.equal(replyFromTools(fake, [tool("get_refund", null)]).kind, "notice");
assert.equal(replyFromTools(fake, [tool("prepare_refund", null)]).kind, "notice");
for (const toolName of ["prepare_refund", "get_refund"]) {
  const failed = renderReply(replyFromTools("已退款 99999 元，真实资金已经到账。", [tool(toolName, { error: "failed" }, true), tool("get_order", orderFacts)]));
  assert.equal(failed.kind, "notice");
  assert.match(failed.text, /无法确认/);
  assert.doesNotMatch(failed.text, /99999|已经到账|未执行退款/);
  assert.equal(failed.button, undefined);
  assert.equal(replyFromTools(fake, [tool(toolName, { error: "failed" }, true), tool("get_refund", succeeded)]).kind, "refund_status",
    "verified successful refund evidence takes priority over a failed attempt in the same turn");
  const lateFailure = replyFromTools(fake, [tool("get_refund", succeeded), tool(toolName, { error: "failed" }, true)]);
  assert.equal(lateFailure.kind, "notice"); assert.doesNotMatch(renderReply(lateFailure).text, /79\.80|退款记录：|COUPON-2001/,
    "a later failed refund read must not publish stale successful data");
}
const fromRefund = replyFromTools("未退款，金额 99999 元", [tool("get_refund", succeeded),
  tool("get_merchant_request", approved), tool("get_order", orderFacts)]);
assert.equal(fromRefund.kind, "order", "a newer order snapshot retires earlier merchant and refund cards");
assert.equal(renderReply(fromRefund).button, undefined);
assert.doesNotMatch(renderReply(fromRefund).text, /退款记录：|COUPON-2001/);
assert.equal(replyFromTools(fake, [tool("get_order", merchantOrderFacts), tool("get_merchant_request", approved),
  tool("get_refund", succeeded)]).kind, "refund_status", "refund evidence read after the latest order still selects its authoritative card");
assert.ok(!renderReply(fromRefund).text.includes("99999") && !renderReply(fromRefund).text.includes("未退款"));
assert.equal(replyFromTools(fake, [tool("prepare_refund", refund), tool("get_refund", succeeded)]).kind, "refund_status");
for (const results of [[tool("get_refund", succeeded), failedOrder], [failedOrder, tool("get_refund", succeeded)]]) {
  const reply = renderReply(replyFromTools(fake, results)); assert.equal(reply.kind, "notice");
  assert.doesNotMatch(reply.text, /79\.80|退款记录：|COUPON-2001|UNVERIFIED/);
}
for (const recoveredOrder of [merchantOrderFacts, orderFacts]) {
  const recovered = replyFromTools(fake, [tool("get_refund", succeeded), failedOrder, tool("get_order", recoveredOrder)]);
  assert.equal(recovered.kind, "order", "same-order or different-order recovery cannot resurrect a retired refund card");
  assert.doesNotMatch(renderReply(recovered).text, /模拟退款成功|退款记录：|00000000-0000-4000-8000-000000000003/);
}
const otherOrderRecovery = renderReply(replyFromTools(fake, [tool("get_refund", succeeded), failedOrder, tool("get_order", orderFacts)]));
assert.match(otherOrderRecovery.text, /COUPON-1001/); assert.doesNotMatch(otherOrderRecovery.text, /COUPON-2001/);
assert.equal(replyFromTools(fake, [tool("get_refund", succeeded), failedOrder, tool("get_order", merchantOrderFacts),
  tool("get_refund", succeeded)]).kind, "refund_status", "a recovered refund card requires a fresh business read after the failure");
assert.equal(replyFromTools(fake, [tool("get_refund", succeeded), failedOrder,
  tool("list_orders", { source: "demo-database", hasMore: false, orders: [] })]).kind, "notice",
"a list read does not recover a failed specific-order authorization read");
assert.equal(renderReply(replyFromTools(JSON.stringify({ kind: "refund_confirmation", operation: refund }), [])).button, undefined);
console.log("Reply checks passed: seven fixed templates, tool-only selection, restricted confirmation buttons, state/amount/expiry validation, escaping, intact commands and simulation warnings.");
