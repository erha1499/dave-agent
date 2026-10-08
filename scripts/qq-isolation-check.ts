import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import type { RenderedReply } from "../src/reply.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

// Engineering integration: real Pi, MySQL and production hooks; scripted model and local QQ sends.
type Fixture = Awaited<ReturnType<typeof createMerchantFixture>>;
type Session = Awaited<ReturnType<typeof createCouponSession>>;
type Call = { name: string; args: Record<string, string>; denied?: boolean };
const fixtures: Fixture[] = [], modelErrors: unknown[] = [];
const group = `isolation-${randomUUID()}`, allTools = ["get_merchant_request", "get_order", "get_refund", "list_orders", "prepare_merchant_request", "prepare_refund", "search_faq"];
const orderPool = createPool(readDatabaseConfig()), store = new CouponStore(orderPool);
const merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
const refunds = new RefundStore(createPool(readRefundDatabaseConfig()));
const sent: { target: ReplyTarget; reply: RenderedReply; requester: string }[] = [];
let agent: QQAgent | undefined;
let pendingA: Promise<unknown> | undefined;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const started = deferred(), release = deferred();
let blockedA = false;
try {
  for (const senderId of ["invalid", null, 123]) {
    await assert.rejects(createMerchantFixture(["approve"], { senderId: senderId as "TEST_USER1" }), /合成测试客户/);
  }
  for (const senderId of ["TEST_USER1", "TEST_USER2"] as const) fixtures.push(await createMerchantFixture(["approve"], { senderId, delayMs: 5000 }));
  await fixtures[1]!.repriceRefund(fixtures[1]!.orders[0]!, 5990);
  const users = await Promise.all(fixtures.map(async (fixture, index) => {
    const runtime = await createModelRuntime(), faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    return { fixture, identity: fixture.identity, orderId: fixture.orders[0]!, amount: index ? 5990 : 7980,
      key: merchantSourceKey(fixture.identity, group), marker: `私有上下文_${index}_${randomUUID()}`, runtime, faux, sessions: [] as Session[] };
  }));
  type User = typeof users[number];
  const [a, b] = users as [User, User];
  assert.equal(await store.resolveCustomer(a.identity), "customer-demo-1");
  assert.equal(await store.resolveCustomer(b.identity), "customer-demo-2");
  const userFor = (msg: QQBotInboundMessage) => {
    assert.equal(msg.groupOpenid, group);
    const user = users.find(item => item.identity.senderId === msg.senderId);
    assert.ok(user); return user;
  };
  const message = (user: User, content: string): QQBotInboundMessage => {
    const id = randomUUID(), timestamp = new Date().toISOString();
    return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: user.identity.senderId, groupOpenid: group,
      messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: group, msgId: id },
      raw: { id, content, timestamp, group_openid: group, author: { member_openid: user.identity.senderId } } };
  };
  const createAgent = () => new QQAgent(async msg => {
    const user = userFor(msg);
    const session = await createCouponSession(user.identity, store, user.runtime, user.faux.getModel(), { store: merchant, sourceKey: user.key, refunds });
    user.sessions.push(session); return session;
  }, async (target, _text, reply, requester) => { sent.push({ target, reply, requester }); }, () => {}, 10_000,
  async msg => {
    const user = userFor(msg);
    return await confirmRefundReply(refunds, user.identity, user.key, msg.content)
      ?? await confirmMerchantReply(merchant, user.identity, user.key, msg.content, { groupOpenid: group, messageId: msg.messageId, timestamp: msg.timestamp });
  }, (msg, reply) => { const user = userFor(msg); return markRefundReplyPresented(refunds, user.identity, user.key, reply); });
  function program(user: User, calls: Call[], event = false, block = false) {
    function inspect(context: TranscriptContext, previous?: Call) {
      try {
        const transcript = JSON.stringify(context.messages);
        assert.ok(transcript.includes(user.marker));
        assert.ok(!transcript.includes(users.find(item => item !== user)!.marker), "another user's context entered this session");
        assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), event ? ["get_merchant_request"] : allTools);
        if (previous) {
          const result = context.messages.findLast(item => item.role === "toolResult");
          assert.ok(result?.role === "toolResult"); assert.equal(result.toolName, previous.name);
          assert.equal(result.isError, Boolean(previous.denied), `${previous.name}: ${JSON.stringify(result.content)}`);
          if (previous.denied) assert.ok(!JSON.stringify(result).includes("paidCents"), "denied order query disclosed private facts");
        }
      } catch (error) { modelErrors.push(error); throw error; }
    }
    user.faux.setResponses([
      ...calls.map((call, index) => async (context: TranscriptContext) => {
        inspect(context, calls[index - 1]);
        if (block && index === 0) { blockedA = true; started.resolve(); await release.promise; }
        return fauxAssistantMessage(fauxToolCall(call.name, call.args), { stopReason: "toolUse" });
      }),
      context => { inspect(context, calls.at(-1)); return fauxAssistantMessage("工程检查：按工具事实返回模拟结果。"); },
    ]);
  }
  async function handle(user: User, content: string) {
    const msg = message(user, content);
    await agent!.handle(msg);
    const receipt = sent.find(item => item.target.msgId === msg.messageId);
    assert.ok(receipt); assert.equal(receipt.requester, user.identity.senderId); assert.equal(receipt.target.targetId, group);
    assert.ok(!receipt.reply.text.includes("客服暂时无法处理"));
    return receipt;
  }
  const query = (user: User): Call => ({ name: "get_order", args: { orderId: user.orderId } });
  const faq: Call = { name: "search_faq", args: { query: "未核销退款", shopId: "shop-demo-1", productId: "product-demo-1" } };
  const task = (user: User): Call => ({ name: "get_merchant_request", args: { orderId: user.orderId } });
  const facts = (user: User) => Promise.all([store.getOrder(user.identity, user.orderId), refunds.get(user.identity, user.key, user.orderId)]);
  agent = createAgent();
  for (const user of users) program(user, [query(user), faq, { name: "prepare_merchant_request", args: { orderId: user.orderId, reason: "行程变化" } }], false, user === a);
  pendingA = handle(a, `${a.marker}；订单 ${a.orderId} 请联系商家，原因行程变化。`);
  void pendingA.catch(() => {}); // Observe immediately; the original promise still rejects when awaited below.
  const timer = setTimeout(() => started.resolve(), 5000);
  await started.promise; clearTimeout(timer); assert.ok(blockedA, "A must enter the scripted barrier");
  await handle(b, `${b.marker}；订单 ${b.orderId} 请联系商家，原因行程变化。`);
  assert.equal(sent.length, 1); assert.equal(sent[0]!.requester, b.identity.senderId, "B must finish while A remains blocked");
  release.resolve(); await pendingA;
  assert.equal(a.sessions.length, 1); assert.equal(b.sessions.length, 1); assert.notEqual(a.sessions[0], b.sessions[0]);
  for (const [user, other] of [[a, b], [b, a]] as const) {
    program(user, [{ name: "get_order", args: { orderId: other.orderId }, denied: true }]);
    await handle(user, `请查询 ${other.orderId}`);
    await assert.rejects(store.getOrder(user.identity, other.orderId));
  }
  const confirmations = await Promise.all(users.map(user => handle(user, `确认联系商家 ${user.orderId} 原因：行程变化`)));
  for (const user of users) {
    const current = await merchant.getTask(user.identity, user.key, user.orderId); assert.ok(current);
    assert.equal(current.amountCents, user.amount);
    assert.ok(await merchant.applyResult({ taskId: current.taskId, orderId: user.orderId, status: "approved", approvedAmountCents: user.amount }));
    program(user, [task(user)], true);
  }
  const beforeNotifications = sent.length;
  await dispatchMerchantNotifications(merchant, agent, "TEST_APP", [group]);
  assert.equal(sent.length, beforeNotifications + 2);
  for (const [index, user] of users.entries()) {
    const receipt = sent.slice(beforeNotifications).find(item => item.requester === user.identity.senderId);
    const current = await merchant.getTask(user.identity, user.key, user.orderId); assert.ok(receipt && current);
    assert.equal(receipt.target.msgId, confirmations[index]!.target.msgId); assert.equal(receipt.target.targetId, group);
    assert.equal(receipt.reply.kind, "merchant_status"); assert.ok(receipt.reply.text.includes(current.taskId));
    assert.ok(receipt.reply.text.includes(user.orderId)); assert.ok(receipt.reply.text.includes((user.amount / 100).toFixed(2)));
    assert.equal((await facts(user))[1], undefined, "result notifications must not prepare refunds");
  }
  const modelCalls = () => users.map(user => user.faux.state.callCount);
  const callsAfterNotification = modelCalls();
  await dispatchMerchantNotifications(merchant, agent, "TEST_APP", [group]);
  assert.equal(sent.length, beforeNotifications + 2); assert.deepEqual(modelCalls(), callsAfterNotification);
  for (const user of users) program(user, [query(user), faq, task(user), { name: "prepare_refund", args: { orderId: user.orderId } }]);
  const proposals = await Promise.all(users.map(user => handle(user, "那就帮我退款")));
  for (const [index, user] of users.entries()) {
    const [order, operation] = await facts(user); assert.ok(operation);
    assert.equal(operation.status, "awaiting_confirmation"); assert.ok(operation.presentedAt); assert.equal(operation.amountCents, user.amount);
    assert.equal(order.amounts.refundedCents, 0); assert.equal(order.refunds.length, 0);
    assert.equal(proposals[index]!.reply.button?.command, `确认退款 ${operation.operationId}`);
    assert.ok(proposals[index]!.reply.text.includes(user.orderId)); assert.ok(proposals[index]!.reply.text.includes((user.amount / 100).toFixed(2)));
  }
  const beforeAttack = await Promise.all(users.map(facts)), hostCalls = modelCalls();
  const attacks = await Promise.all(users.map((user, index) => handle(user, proposals[1 - index]!.reply.button!.command)));
  assert.ok(attacks.every(receipt => receipt.reply.kind === "notice"));
  assert.deepEqual((await Promise.all(users.map(facts))).map(([{ asOf: _asOf, ...order }, operation]) => [order, operation]),
    beforeAttack.map(([{ asOf: _asOf, ...order }, operation]) => [order, operation]));
  assert.deepEqual(modelCalls(), hostCalls);
  const successes = await Promise.all(users.map((user, index) => handle(user, proposals[index]!.reply.button!.command)));
  const completed = await Promise.all(users.map(facts));
  const repeats = await Promise.all(users.map((user, index) => handle(user, proposals[index]!.reply.button!.command)));
  for (const [index, user] of users.entries()) {
    const [order, operation] = await facts(user); assert.ok(operation?.refundId);
    assert.equal(operation.status, "succeeded"); assert.deepEqual(operation, completed[index]![1]);
    assert.equal(successes[index]!.reply.kind, "refund_status"); assert.deepEqual(repeats[index]!.reply, successes[index]!.reply);
    assert.ok(successes[index]!.reply.text.includes(user.orderId)); assert.ok(successes[index]!.reply.text.includes((user.amount / 100).toFixed(2)));
    assert.equal(order.amounts.refundedCents, user.amount); assert.equal(order.refunds.length, 1); assert.equal(order.coupons[0]!.status, "refunded");
    const [rows] = await orderPool.execute<RowDataPacket[]>("SELECT id, amount_cents FROM refunds WHERE order_id = ?", [user.orderId]);
    assert.deepEqual(rows.map(row => [row.id, row.amount_cents]), [[operation.refundId, user.amount]]);
  }
  assert.notEqual(completed[0]![1]!.refundId, completed[1]![1]!.refundId); assert.deepEqual(modelCalls(), hostCalls);
  await agent.close(); agent = createAgent();
  for (const user of users) program(user, [query(user), { name: "get_refund", args: { orderId: user.orderId } }]);
  const recovered = await Promise.all(users.map(user => handle(user, `${user.marker} 查询 ${user.orderId} 退款结果。`)));
  for (const [index, user] of users.entries()) {
    assert.equal(user.sessions.length, 2); assert.equal(recovered[index]!.reply.kind, "refund_status");
    assert.ok(recovered[index]!.reply.text.includes(completed[index]![1]!.refundId!));
    assert.equal(user.faux.getPendingResponseCount(), 0);
  }
  assert.deepEqual(modelErrors, []);
  console.log("[PASS] 双用户工程集成：真实 MySQL + Pi/QQAgent；阻塞隔离、独立上下文、互查拒绝、原路通知、异额方案、越权确认不变、各自幂等退款及新会话查询。模型为脚本、QQ 发送为本地记录，不代表真实模型或 QQ 客户端验收。");
} catch (error) {
  if (modelErrors.length) throw new AggregateError(modelErrors, "脚本模型内断言失败");
  throw error;
} finally {
  release.resolve();
  try { await agent?.close(); }
  finally {
    await pendingA?.catch(() => {}); // A may reject during shutdown after another assertion already failed.
    const cleanup = await Promise.allSettled(fixtures.map(fixture => fixture.cleanup()));
    await Promise.all([store.close(), merchant.close(), refunds.close()]);
    assert.ok(cleanup.every(result => result.status === "fulfilled"), "temporary fixture cleanup failed");
  }
}
