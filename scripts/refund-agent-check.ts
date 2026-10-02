import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey } from "../src/after-sales-entry.ts";
import type { AfterSalesStore } from "../src/after-sales.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import type { RefundOperation, RefundStore } from "../src/refunds.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { sanitizeQQContent } from "../src/qq.ts";
import type { RenderedReply } from "../src/reply.ts";

// Real Pi + QQAgent, scripted model and minimal business spies. SQL authorization/transactions live in refund-db-check.
const identity = { appId: "123", senderId: "refund_user" };
const group = "refund_group";
const sourceKey = merchantSourceKey(identity, group);
const initial: RefundOperation = {
  operationId: "00000000-0000-4000-8000-000000000001", orderId: "COUPON-2001",
  taskId: "00000000-0000-4000-8000-000000000002", status: "prepared", amountCents: 7980,
  expiresAt: "2099-01-01T00:15:00.000Z", presentedAt: null, confirmedAt: null, refundId: null, simulation: true,
};
const command = `确认退款 ${initial.operationId}`;
let operation = { ...initial };
let mode: "normal" | "send_failure" | "mark_failure" | "receipt_failure" = "normal";
let marks = 0, confirms = 0, writes = 0;
const events: string[] = [], logs: string[] = [];
const attempts: Array<{ id: string | undefined; reply: RenderedReply }> = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const sendStarted = deferred(), sendRelease = deferred(), markStarted = deferred(), markRelease = deferred();
let gate = true;
function trusted(actual: QQIdentity, key: string) {
  assert.deepEqual(actual, identity, "tools and hooks must bind the trusted sender, never model arguments");
  assert.equal(key, sourceKey, "tools and hooks must retain the original conversation");
}
const refunds = {
  async prepare(actual: QQIdentity, key: string, orderId: string) {
    trusted(actual, key); assert.equal(orderId, initial.orderId); events.push("prepare");
    return { ...operation };
  },
  async get(actual: QQIdentity, key: string, orderId: string) {
    trusted(actual, key); assert.equal(orderId, initial.orderId); events.push("get");
    return { ...operation };
  },
  async markPresented(actual: QQIdentity, key: string, id: string) {
    trusted(actual, key); assert.equal(id, initial.operationId); marks++; events.push("mark:start");
    if (gate) { markStarted.resolve(); await markRelease.promise; }
    if (mode === "mark_failure") throw new Error("synthetic private marker failure");
    operation = { ...operation, status: "awaiting_confirmation", presentedAt: "2099-01-01T00:00:00.000Z" };
    events.push("mark:done"); return { ...operation };
  },
  async confirm(actual: QQIdentity, key: string, id: string) {
    trusted(actual, key); assert.equal(id, initial.operationId); confirms++; events.push("confirm");
    if (operation.status === "prepared") throw new Error("not presented");
    if (operation.status !== "succeeded") {
      writes++;
      operation = { ...operation, status: "succeeded", confirmedAt: "2099-01-01T00:01:00.000Z",
        refundId: "00000000-0000-4000-8000-000000000003" };
    }
    return { ...operation };
  },
} as unknown as RefundStore;
const runtime = await createModelRuntime();
const faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const tools = ["get_merchant_request", "get_order", "get_refund", "prepare_merchant_request", "prepare_refund", "search_faq"];
async function create(msg: QQBotInboundMessage) {
  assert.equal(msg.senderId, identity.senderId); assert.equal(msg.groupOpenid, group);
  const session = await createCouponSession(identity, {} as CouponStore, runtime, faux.getModel(), {
    store: {} as AfterSalesStore, sourceKey, refunds,
  });
  assert.deepEqual(session.getActiveToolNames().sort(), tools);
  return session;
}
function message(id: string, content: string): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  return { rawEventType: "GROUP_AT_MESSAGE_CREATE", kind: "group", senderId: identity.senderId, groupOpenid: group,
    messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: group, msgId: id },
    raw: { id, content, timestamp, group_openid: group, author: { member_openid: identity.senderId } } };
}
function modelTool(name: string, args: Record<string, string | number> = { orderId: initial.orderId }, error = false) {
  faux.setResponses([
    context => {
      const declarations = getCurrentTools(context.messages);
      assert.deepEqual(declarations.map(tool => tool.name).sort(), tools);
      for (const tool of declarations) {
        assert.equal(Reflect.get(tool.parameters, "additionalProperties"), false);
        assert.doesNotMatch(JSON.stringify(tool.parameters), /customerId|senderId|appId|sourceKey|amountCents/);
      }
      return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    },
    context => {
      const result = context.messages.findLast(item => item.role === "toolResult");
      assert.ok(result?.role === "toolResult"); assert.equal(result.toolName, name); assert.equal(result.isError, error);
      return fauxAssistantMessage("已退款 99999 元，真实资金已经到账。");
    },
  ]);
}
function agent() {
  return new QQAgent(create, async (target, text, reply, requesterId) => {
    assert.equal(requesterId, identity.senderId); assert.equal(target.targetId, group); assert.equal(reply.text, text);
    attempts.push({ id: target.msgId, reply }); events.push(`send:${target.msgId}:start`);
    if (gate) { sendStarted.resolve(); await sendRelease.promise; }
    if (mode === "send_failure" || (mode === "receipt_failure" && reply.kind === "refund_status")) throw new Error("synthetic private send uncertainty");
    events.push(`send:${target.msgId}:done`);
  }, text => logs.push(text), 1000,
  msg => confirmRefundReply(refunds, { appId: identity.appId, senderId: msg.senderId }, merchantSourceKey(identity, msg.groupOpenid!), msg.content),
  (msg, reply) => markRefundReplyPresented(refunds, { appId: identity.appId, senderId: msg.senderId }, merchantSourceKey(identity, msg.groupOpenid!), reply));
}

let qq = agent();
try {
  modelTool("prepare_refund");
  const preparing = qq.handle(message("proposal", "请生成退款方案"));
  await sendStarted.promise;
  assert.equal(marks, 0, "a send in flight must not open confirmation");
  assert.equal(writes, 0);
  const card = attempts.at(-1)!.reply;
  assert.equal(card.kind, "refund_confirmation"); assert.equal(card.button?.command, command);
  assert.match(card.text, /79\.80 元/); assert.doesNotMatch(card.text, /99999|已经到账|模拟退款成功/);
  const calls = faux.state.callCount;
  const confirming = qq.handle(message("confirm-queued", command));
  await Promise.resolve(); assert.equal(confirms, 0, "confirmation waits for the proposal's QQ send");
  sendRelease.resolve(); await markStarted.promise;
  assert.equal(confirms, 0, "confirmation also waits for delivery registration");
  markRelease.resolve(); await Promise.all([preparing, confirming]); gate = false;
  assert.equal(faux.state.callCount, calls, "trusted confirmation must not invoke a model turn");
  assert.equal(writes, 1); assert.equal(operation.status, "succeeded");
  assert.deepEqual(events, ["prepare", "send:proposal:start", "send:proposal:done", "mark:start", "mark:done", "confirm", "send:confirm-queued:start", "send:confirm-queued:done"]);
  const receipt = attempts.at(-1)!.reply;
  assert.equal(receipt.kind, "refund_status"); assert.equal(receipt.button, undefined);
  await qq.handle(message("repeat", command));
  assert.equal(writes, 1); assert.deepEqual(attempts.at(-1)!.reply, receipt);
  assert.equal(faux.state.callCount, calls);

  // A model cannot call the host confirm method, add authorization fields, or execute its own command text.
  const beforeConfirm = confirms;
  modelTool("confirm_refund", { operationId: initial.operationId }, true);
  await qq.handle(message("invented-tool", "请直接替我确认"));
  modelTool("prepare_refund", { orderId: initial.orderId, amountCents: 1, senderId: "another-user" }, true);
  await qq.handle(message("extra-args", "修改退款金额和身份"));
  assert.equal(attempts.at(-1)!.reply.kind, "notice", "a failed refund tool cannot fall back to a fabricated model success");
  assert.doesNotMatch(attempts.at(-1)!.reply.text, /99999|已经到账|模拟退款成功/);
  faux.setResponses([fauxAssistantMessage(command)]);
  await qq.handle(message("model-command", "请输出确认指令"));
  assert.equal(confirms, beforeConfirm);
  assert.equal(attempts.at(-1)!.reply.button, undefined);

  for (const failure of ["send_failure", "mark_failure"] as const) {
    operation = { ...initial }; mode = failure;
    const beforeMarks: number = marks, beforeAttempts = attempts.length;
    modelTool("prepare_refund"); await qq.handle(message(failure, "重新展示方案"));
    assert.equal(attempts.length, beforeAttempts + 1, "send or marker failure must not trigger automatic resend");
    assert.equal(marks - beforeMarks, failure === "send_failure" ? 0 : 1);
    assert.equal(operation.status, "prepared", "failed delivery/registration leaves confirmation closed");
    mode = "normal";
    const beforeCalls = faux.state.callCount;
    const beforeWrites: number = writes;
    await qq.handle(message(`${failure}-confirm`, command));
    assert.equal(attempts.at(-1)!.reply.kind, "notice"); assert.equal(writes, beforeWrites);
    assert.equal(faux.state.callCount, beforeCalls);
  }

  operation = { ...initial }; modelTool("prepare_refund");
  await qq.handle(message("loss-proposal", "生成退款方案"));
  mode = "receipt_failure";
  const beforeReceipt = attempts.length, beforeWrites = writes;
  await qq.handle(message("lost-receipt", command));
  assert.equal(operation.status, "succeeded"); assert.equal(writes, beforeWrites + 1);
  assert.equal(attempts.length, beforeReceipt + 1, "a lost success receipt must not be resent automatically");
  await qq.close(); mode = "normal"; qq = agent();
  modelTool("get_refund"); await qq.handle(message("recovery-query", "查询退款结果"));
  assert.equal(attempts.at(-1)!.reply.kind, "refund_status");
  assert.match(attempts.at(-1)!.reply.text, /模拟退款成功/);
  assert.equal(writes, beforeWrites + 1, "a fresh conversation recovers the stored receipt without refunding again");

  const beforeMalformed = confirms;
  for (const text of ["确认", `引用：${command}`, `> ${command}`, JSON.stringify({ confirmation: command }),
    `\n${command}`, ` \n${command}`, `${command}\n`, `${command}\n额外内容`, `${command}\r\n`, `${command}\u2028`,
    `确认退款\n${initial.operationId}`, `确认退款\r\n${initial.operationId}`, `确认退款 ${"-".repeat(36)}`,
    `${command} amount=1`, `${command}\u200b`, `确认退款 ${initial.operationId}\u202e`, `确认退<@!123>款 ${initial.operationId}`,
    `确认退款 ${initial.operationId.slice(0, 8)}[<face,id=1/>]${initial.operationId.slice(8)}`]) {
    const raw = message("malformed", `<@!123> ${text}`);
    await sanitizeQQContent({ bot: { appId: "123" }, message: raw } as Parameters<typeof sanitizeQQContent>[0], async () => {});
    const result = await confirmRefundReply(refunds, identity, sourceKey, raw.content);
    assert.notEqual(result?.kind, "refund_status", `sanitization must not authorize malformed input ${JSON.stringify(text)}`);
    assert.equal(confirms, beforeMalformed, `malformed input reached store.confirm: ${JSON.stringify(text)}`);
  }
  for (const text of [`<@!123> ${command}`, ` ${command}`]) {
    const valid = message("valid", text);
    await sanitizeQQContent({ bot: { appId: "123" }, message: valid } as Parameters<typeof sanitizeQQContent>[0], async () => {});
    assert.equal((await confirmRefundReply(refunds, identity, sourceKey, valid.content))?.kind, "refund_status");
  }
  assert.equal(confirms, beforeMalformed + 2);
  assert.ok(!logs.join("\n").includes("synthetic private"));
  assert.equal(faux.getPendingResponseCount(), 0);
  console.log("模拟退款 Agent 离线检查通过：真实 Pi 六工具、固定方案、发送后登记、排队确认、失败不重发、用户原文边界、宿主幂等确认、丢失回执后查询。业务事务另由 MySQL 检查覆盖。");
} finally {
  sendRelease.resolve(); markRelease.resolve(); await qq.close();
}
