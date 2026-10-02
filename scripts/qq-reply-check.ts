import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { QQBot, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { renderReply } from "../src/reply.ts";
import { readQQReplyButtons, readQQReplyFormat, sendQQReply } from "../src/qq-reply.ts";

assert.equal(readQQReplyFormat({}), "markdown");
assert.equal(readQQReplyFormat({ QQ_REPLY_FORMAT: " markdown " }), "markdown");
assert.equal(readQQReplyFormat({ QQ_REPLY_FORMAT: "text" }), "text");
for (const invalid of ["html", "Markdown", "0"]) {
  assert.throws(() => readQQReplyFormat({ QQ_REPLY_FORMAT: invalid }), /QQ_REPLY_FORMAT/);
}
assert.equal(readQQReplyButtons({}), false);
assert.equal(readQQReplyButtons({ QQ_REPLY_BUTTONS: " true " }), true);
assert.equal(readQQReplyButtons({ QQ_REPLY_BUTTONS: "false" }), false);
for (const invalid of ["True", "1", "yes"]) assert.throws(() => readQQReplyButtons({ QQ_REPLY_BUTTONS: invalid }), /QQ_REPLY_BUTTONS/);

// Exercise the installed SDK against localhost. No real credentials, model or QQ API.
let outcome: "success" | "no_id" | "api_error" | "network_error" = "success";
const received: { path: string | undefined; body: Record<string, unknown> }[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (req.url === "/app/getAppAccessToken") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }));
    return;
  }
  received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
  if (outcome === "network_error") { req.socket.destroy(); return; }
  res.setHeader("Content-Type", "application/json");
  res.statusCode = outcome === "api_error" ? 403 : 200;
  res.end(JSON.stringify(outcome === "success" ? { id: "synthetic-reply" }
    : outcome === "api_error" ? { code: 40034025, message: "synthetic API rejection" } : {}));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
const options = { appId: "12345", appSecret: "synthetic-secret", baseUrl, tokenBaseUrl: baseUrl };
const bot = new QQBot({ ...options, markdownSupport: false });
const markdownBot = new QQBot({ ...options, markdownSupport: true });
const target: ReplyTarget = { scope: "group", targetId: "synthetic-group", msgId: "synthetic-inbound" };
const reply = renderReply({ kind: "answer", text: "这是一条测试答复。" });
const requesterId = "synthetic-user";
const command = "确认联系商家 COUPON-2001 原因：行程变化[*]";
const confirmation = renderReply({ kind: "merchant_confirmation", orderId: "COUPON-2001", amountCents: 7980, confirmationText: command });
const pending = renderReply({ kind: "merchant_status", task: {
  taskId: "00000000-0000-4000-8000-000000000001", orderId: "COUPON-2001", status: "pending",
  reason: "行程变化", amountCents: 7980, approvedAmountCents: null,
  createdAt: "2026-10-02T00:00:00.000Z", dueAt: "2026-10-02T00:00:05.000Z", completedAt: null, simulation: true,
} });
const refund = {
  operationId: "00000000-0000-4000-8000-000000000002", orderId: "COUPON-2001",
  taskId: "00000000-0000-4000-8000-000000000001", status: "prepared" as const,
  amountCents: 7980, expiresAt: "2099-01-01T00:15:00.000Z", presentedAt: null,
  confirmedAt: null, refundId: null, simulation: true as const,
};
const refundConfirmation = renderReply({ kind: "refund_confirmation", operation: refund });
const refundSuccess = renderReply({ kind: "refund_status", operation: { ...refund, status: "succeeded",
  presentedAt: "2099-01-01T00:00:00.000Z", confirmedAt: "2099-01-01T00:01:00.000Z",
  refundId: "00000000-0000-4000-8000-000000000003" } });
const permission = { type: 0, specify_user_ids: [requesterId] };
const commonAction = { type: 2, permission, enter: false, reply: false, unsupport_tips: "请复制消息中的文字，@机器人后发送。" };
const confirmationKeyboard = { content: { rows: [{ buttons: [{
  id: "merchant_confirmation",
  render_data: { label: "确认模拟协商", visited_label: "确认模拟协商", style: 1 },
  action: { ...commonAction, data: command, modal: {
    content: "继续后将填入确认指令，请核对并发送；不会执行退款。", confirm_text: "继续", cancel_text: "返回",
  } },
}] }] } };
assert.notEqual(reply.markdown, reply.text, "transport must receive a rendered template");
try {
  await sendQQReply(bot, target, reply, readQQReplyFormat({}), requesterId);
  assert.deepEqual(received[0], {
    path: "/v2/groups/synthetic-group/messages",
    body: { msg_id: target.msgId, msg_type: 2, markdown: { content: reply.markdown }, msg_seq: received[0]?.body.msg_seq },
  });
  // Explicit text also overrides the SDK's markdownSupport setting.
  await sendQQReply(markdownBot, target, reply, "text");
  assert.deepEqual(received[1], {
    path: "/v2/groups/synthetic-group/messages",
    body: { msg_id: target.msgId, msg_type: 0, content: reply.text, msg_seq: received[1]?.body.msg_seq },
  });
  await sendQQReply(bot, target, confirmation, "markdown", requesterId);
  assert.deepEqual(received.at(-1)?.body.keyboard, confirmationKeyboard, "SDK must preserve restricted blue-outline confirmation button and modal");
  assert.equal(received.at(-1)?.body.msg_id, target.msgId);
  assert.deepEqual(received.at(-1)?.body.markdown, { content: confirmation.markdown });
  await sendQQReply(bot, target, pending, "markdown", requesterId);
  assert.deepEqual(received.at(-1)?.body.keyboard, { content: { rows: [{ buttons: [{
    id: "merchant_status", render_data: { label: "查询进度", visited_label: "查询进度", style: 1 },
    action: { ...commonAction, data: "查询 COUPON-2001 的模拟协商进度" },
  }] }] } }, "pending query uses a blue button without confirmation modal");
  await sendQQReply(bot, target, refundConfirmation, "markdown", requesterId);
  assert.deepEqual(received.at(-1)?.body.keyboard, { content: { rows: [{ buttons: [{
    id: "refund_confirmation", render_data: { label: "确认模拟退款", visited_label: "确认模拟退款", style: 1 },
    action: { ...commonAction, data: `确认退款 ${refund.operationId}`, modal: {
      content: "继续后将填入确认指令，请核对订单与金额后发送；仅操作演示数据，不涉及真实资金。",
      confirm_text: "继续", cancel_text: "返回",
    } },
  }] }] } }, "refund confirmation remains user-restricted, fills the exact command, and requires sending");
  assert.deepEqual(received.at(-1)?.body.markdown, { content: refundConfirmation.markdown });
  await sendQQReply(bot, target, refundConfirmation, "text", requesterId);
  assert.equal(received.at(-1)?.body.keyboard, undefined);
  assert.ok(String(received.at(-1)?.body.content).includes(`\n确认退款 ${refund.operationId}\n`));
  await sendQQReply(bot, target, refundSuccess, "markdown", requesterId);
  assert.equal(received.at(-1)?.body.keyboard, undefined, "successful refund receipts cannot trigger a repeat action");
  assert.deepEqual(received.at(-1)?.body.markdown, { content: refundSuccess.markdown });
  // Missing identity means buttons are disabled, never a button open to everyone.
  await sendQQReply(bot, target, confirmation, "markdown");
  assert.equal(received.at(-1)?.body.keyboard, undefined);
  await sendQQReply(bot, target, confirmation, "text", requesterId);
  assert.equal(received.at(-1)?.body.keyboard, undefined);
  assert.equal(received.at(-1)?.body.msg_type, 0);
  await sendQQReply(bot, { scope: "c2c", targetId: "synthetic-user", msgId: "synthetic-inbound" }, confirmation, "markdown", requesterId);
  assert.equal(received.at(-1)?.body.keyboard, undefined, "this button implementation only targets group messages");
  for (const invalid of ["", "user two", "<all>", "x".repeat(129)]) {
    const before = received.length;
    await assert.rejects(sendQQReply(bot, target, confirmation, "markdown", invalid), /QQ 按钮缺少有效的当前用户/);
    assert.equal(received.length, before, "invalid requester cannot send a button with broadened permissions");
  }
  for (const { body } of received) {
    assert.ok(Number.isInteger(body.msg_seq) && Number(body.msg_seq) >= 0 && Number(body.msg_seq) < 65_536);
  }
  for (const failure of ["no_id", "api_error", "network_error"] as const) {
    outcome = failure;
    const before = received.length;
    await assert.rejects(sendQQReply(bot, target, confirmation, "markdown", requesterId),
      failure === "no_id" ? /QQ 未返回消息 ID/ : failure === "api_error" ? /API Error/ : /Network error/);
    assert.equal(received.length, before + 1, `${failure}: must not retry or send a text fallback`);
    assert.equal(received.at(-1)?.body.msg_type, 2);
    assert.deepEqual(received.at(-1)?.body.markdown, { content: confirmation.markdown });
    assert.deepEqual(received.at(-1)?.body.keyboard, confirmationKeyboard);
  }
} finally {
  bot.stop();
  markdownBot.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log("QQ 回复检查通过：真实 SDK 固定模板 Markdown、指定用户确认/查询按钮、显式禁用/纯文本/非群无按钮、无效用户拒绝、原群/消息关联、无 ID/API/网络失败不重复发送。");
