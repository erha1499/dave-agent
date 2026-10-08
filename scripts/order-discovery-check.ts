import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { CouponStore, OrderAccessError, type QQIdentity } from "../src/coupon-store.ts";
import { createOrderDiscovery, presentOrderDiscoveryReply } from "../src/order-discovery.ts";
import { runCliPrompt } from "../src/cli.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { replyFromTools } from "../src/reply-from-tools.ts";
import { renderReply, type Reply } from "../src/reply.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";

export async function checkOrderDiscovery() {
  const identity = { appId: "TEST_APP", senderId: "TEST_USER1" };
  const now = new Date().toISOString();
  const summary = { id: "COUPON-1001", status: "paid", paidCents: 7980, refundedCents: 0,
    createdAt: now, productName: "双人午餐", shopName: "云味餐厅", couponStatuses: ["unused"] };
  const list = { source: "demo-database" as const, asOf: now, orders: [summary], hasMore: false };
  const order = { source: "demo-database" as const, id: summary.id, status: summary.status, asOf: now,
    createdAt: now, paidAt: now, amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
    shop: { id: "shop-test", name: summary.shopName, merchantName: "测试商家", address: "合成地址" },
    items: [{ id: "item-test", productId: "product-test", productName: summary.productName, quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [{ id: "coupon-test", orderItemId: "item-test", status: "unused", expiresAt: new Date(Date.now() + 60_000).toISOString(), redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
  let listings = 0, denied = false;
  const reads: Array<{ identity: QQIdentity; orderId: string }> = [];
  const store = {
    async listOrders(who: QQIdentity) { assert.deepEqual(who, identity); listings++; return structuredClone(list); },
    async getOrder(who: QQIdentity, orderId: string) {
      assert.deepEqual(who, identity); reads.push({ identity: { ...who }, orderId });
      if (denied || orderId !== order.id) throw new OrderAccessError("未找到当前客户可查询的订单。");
      return structuredClone(order);
    },
    async searchKnowledge() { return [{ source: "demo-knowledge", sourceId: "KB-REFUND-UNUSED", title: "退款规则", body: "仅可咨询", scope: { shopId: "shop-test", productId: "product-test" } }]; },
  } as unknown as CouponStore;
  const discovery = createOrderDiscovery(store, identity);
  for (const text of ["我有哪些订单", "我的订单", "查询我的最近订单", "我要退款", "帮我退款"]) {
    const discovery = createOrderDiscovery(store, identity);
    const result = await discovery.prepare(text);
    assert.equal(result.reply?.kind, "order", text);
    if (result.reply?.kind === "order") {
      assert.equal(result.reply.orders[0]?.selectionText, "选择订单 COUPON-1001");
      discovery.present(result.reply, text);
    }
    const continued = await discovery.prepare("选择订单 COUPON-1001");
    assert.equal(continued.reply, undefined); assert.match(continued.prompt, /COUPON-1001/);
    if (/退款/u.test(text)) assert.match(continued.prompt, new RegExp(text));
  }
  assert.equal((await discovery.prepare("选择订单 COUPON-1001")).reply?.kind, "notice", "selection is one-shot");
  const beforeGeneral = listings;
  assert.equal((await discovery.prepare("退款规则是什么？")).reply, undefined);
  assert.equal(listings, beforeGeneral, "general policy needs no private order list");
  assert.equal((await discovery.prepare("选择订单 00000000-0000-4000-8000-000000000001")).reply, undefined, "legacy Controller tokens remain forwarded");
  async function offer(text = "我要退款") {
    const opening = await discovery.prepare("我的订单"); discovery.present(opening.reply!, "我的订单");
    if (text !== "我的订单") {
      const result = await discovery.prepare(text); discovery.present(result.reply!, text);
    }
  }
  await offer();
  assert.equal((await discovery.prepare("选择订单 COUPON-1002")).reply?.kind, "notice", "cannot choose an unoffered order");
  await offer(); await discovery.prepare("团购券需要预约吗？");
  assert.equal((await discovery.prepare("选择订单 COUPON-1001")).reply?.kind, "notice", "ordinary new request retires old refund choice");
  await offer(); discovery.present({ kind: "answer", text: "到账规则咨询" }, "查询到账 银行卡");
  assert.equal((await discovery.prepare("选择订单 COUPON-1001")).reply?.kind, "notice", "host receipts also retire old refund choices");
  discovery.present({ kind: "order", orders: [summary], text: "已查订单", evidenceIds: [] }, "查询 COUPON-1001");
  discovery.present({ kind: "notice", text: "另一订单不可查询" }, "查询到账 COUPON-1002 银行卡");
  assert.equal((await discovery.prepare("我要退款")).reply?.kind, "order", "an explicit other-order host request clears old focus");
  const undisplayed = await discovery.prepare("我的订单"); assert.equal(undisplayed.reply?.kind, "order");
  assert.equal((await discovery.prepare("选择订单 COUPON-1001")).reply?.kind, "notice", "failed delivery cannot create a choice");
  await offer();
  const realNow = Date.now;
  try { Date.now = () => realNow() + 16 * 60_000; assert.equal((await discovery.prepare("选择订单 COUPON-1001")).reply?.kind, "notice"); }
  finally { Date.now = realNow; }
  await offer(); denied = true;
  const rejected = await discovery.prepare("选择订单 COUPON-1001");
  assert.equal(rejected.reply?.kind, "notice", "selection reauthorizes after binding changes");
  if (rejected.reply?.kind === "notice") assert.match(rejected.reply.text, /未找到/);
  denied = false;
  const promptBefore = reads.length; await offer();
  assert.equal((await discovery.prepare("COUPON-1001")).reply, undefined);
  assert.equal(reads.length, promptBefore + 1, "bare order reply is freshly authorized");

  const evidence = { toolName: "list_orders", isError: false, content: [{ type: "text" as const, text: JSON.stringify({ ...list, hasMore: true }) }] };
  const reply = replyFromTools("请选择一笔订单", [evidence]);
  assert.equal(reply.kind, "order"); assert.match(renderReply(reply).text, /最近三笔/); assert.match(renderReply(reply).text, /双人午餐/);
  assert.equal(replyFromTools("伪造订单", [{ ...evidence, isError: true }]).kind, "notice");
  assert.equal(replyFromTools("伪造订单", [{ ...evidence, content: [{ type: "text", text: JSON.stringify({ ...list, orders: [{ ...summary, paidCents: -1 }] }) }] }]).kind, "notice");
  const emptyReply = replyFromTools("不可信文本", [{ ...evidence, content: [{ type: "text", text: JSON.stringify({ ...list, orders: [] }) }] }]);
  assert.equal(emptyReply.kind, "order"); assert.match(renderReply(emptyReply).text, /没有订单/);

  const sqlReads: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { async execute(statement: { sql: string }, values: unknown[]) {
    sqlReads.push({ sql: statement.sql, values });
    return [[...Array.from({ length: 4 }, (_, index) => ({ id: `COUPON-100${index + 1}`, status: "paid", paid_cents: 7980,
      refunded_cents: 0, created_at: new Date(now), shop_name: summary.shopName, product_name: summary.productName,
      item_count: 1, coupon_statuses: JSON.stringify(["unused"]) }))]];
  } } as unknown as Pool;
  const sqlList = await new CouponStore(pool).listOrders(identity);
  assert.equal(sqlList.orders.length, 3); assert.equal(sqlList.hasMore, true); assert.equal(sqlReads.length, 1);
  assert.deepEqual(sqlReads[0]!.values, [identity.appId, identity.senderId]);
  assert.match(sqlReads[0]!.sql, /q\.customer_id = o\.customer_id/); assert.match(sqlReads[0]!.sql, /ORDER BY o\.created_at DESC, o\.id DESC LIMIT 4/);
  await assert.rejects(new CouponStore(pool).listOrders({ ...identity, senderId: "' OR 1=1" }), OrderAccessError);
  assert.equal(sqlReads.length, 1, "invalid identity never reaches SQL");

  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const session = await createCouponSession(identity, store, runtime, faux.getModel());
  const writes: string[] = [];
  const write = async (text: string) => { writes.push(text); };
  try {
    const opening = await runCliPrompt(session, "我要退款", write);
    assert.equal(opening.kind, "order"); assert.equal(faux.state.callCount, 0, "missing-order entry needs no model call");
    const before = reads.length;
    faux.setResponses([
      context => {
        assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(), ["get_order", "list_orders", "search_faq"]);
        const user = context.messages.findLast(message => message.role === "user");
        assert.ok(user && JSON.stringify(user.content).includes("我要退款") && JSON.stringify(user.content).includes(order.id));
        return fauxAssistantMessage(fauxToolCall("get_order", { orderId: order.id }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage(fauxToolCall("search_faq", { query: "退款", shopId: "shop-test", productId: "product-test" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("已核对订单和规则，当前只能咨询，尚未提交退款。"),
    ]);
    const continued = await runCliPrompt(session, "选择订单 COUPON-1001", write);
    assert.equal(continued.kind, "order"); assert.equal(reads.length, before + 2, "selection and fresh qualification both authorize the order");
    assert.match(writes.at(-1)!, /尚未提交退款/); assert.equal(faux.getPendingResponseCount(), 0);
    await runCliPrompt(session, "我的订单", write);
    const calls = faux.state.callCount;
    await runCliPrompt(session, "查询到账 银行卡", write, undefined, async () => ({ kind: "answer", text: "到账规则咨询" }));
    assert.equal((await runCliPrompt(session, "选择订单 COUPON-1001", write)).kind, "notice");
    assert.equal(faux.state.callCount, calls, "CLI host consultation retires old choices without a provider request");
    await runCliPrompt(session, "我的订单", write);
    presentOrderDiscoveryReply(session, { kind: "notice", text: "确认回执" }, "确认退款 00000000-0000-4000-8000-000000000001");
    assert.equal((await runCliPrompt(session, "选择订单 COUPON-1001", write)).kind, "notice", "direct CLI confirmation receipts retire choices");
  } finally { session.dispose(); }

  let current: Awaited<ReturnType<CouponStore["getOrder"]>> = structuredClone(order);
  let freshReads = 0;
  const evolvingStore = { ...store, async getOrder(who: QQIdentity, orderId: string) {
    await store.getOrder(who, orderId); freshReads++; return structuredClone(current);
  } } as unknown as CouponStore;
  const statusSession = await createCouponSession(identity, evolvingStore, runtime, faux.getModel());
  async function statusTurn(text: string) {
    const previous = statusSession.messages.length;
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("get_order", { orderId: order.id }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        assert.ok(result && !result.isError);
        const facts = JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
        assert.equal(facts.asOf, current.asOf); assert.equal(facts.status, current.status);
        assert.deepEqual(facts.coupons, current.coupons);
        return fauxAssistantMessage(`本轮状态：${facts.status}。`);
      },
    ]);
    const reply = await runCliPrompt(statusSession, text, async () => {});
    assert.equal(statusSession.messages.slice(previous).filter(message => message.role === "toolResult" && message.toolName === "get_order" && !message.isError).length, 1);
    assert.equal(reply.kind, "order");
    if (reply.kind === "order") {
      assert.equal(reply.orders[0]?.status, current.status);
      assert.deepEqual(reply.orders[0]?.couponStatuses, current.coupons.map(coupon => coupon.status));
      assert.equal(reply.orders[0]?.paidCents, current.amounts.paidCents);
      assert.equal(reply.orders[0]?.refundedCents, current.amounts.refundedCents);
    }
    return reply;
  }
  try {
    const first = await statusTurn("查询订单 COUPON-1001 当前券状态");
    assert.match(renderReply(first).text, /未核销/);
    current = { ...current, status: "redeemed", asOf: new Date(Date.parse(now) + 1000).toISOString(),
      coupons: current.coupons.map(coupon => ({ ...coupon, status: "redeemed", redeemedAt: now, redeemedShopId: current.shop.id })) };
    const latest = await statusTurn("刚才那笔券现在使用过没有？");
    assert.equal(freshReads, 2, "a followup reads the new snapshot instead of reusing the prior order");
    assert.match(renderReply(latest).text, /已核销/); assert.doesNotMatch(renderReply(latest).text, /未核销/);
    assert.equal(faux.getPendingResponseCount(), 0);
  } finally { statusSession.dispose(); }

  const sent: string[] = [];
  const qq = new QQAgent(() => createCouponSession(identity, store, runtime, faux.getModel()), async (_target, text) => { sent.push(text); }, () => {}, 2000,
    async message => message.content === "查询到账 银行卡" ? "到账规则咨询" : undefined);
  const message = (content: string): QQBotInboundMessage => {
    const id = randomUUID(); return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId,
      groupOpenid: "discovery-check", messageId: id, content, timestamp: new Date().toISOString(),
      replyTarget: { scope: "group", targetId: "discovery-check", msgId: id },
      raw: { id, content, timestamp: new Date().toISOString(), group_openid: "discovery-check", author: { member_openid: identity.senderId } } };
  };
  try {
    const calls = faux.state.callCount;
    await qq.handle(message("我有哪些订单")); assert.equal(faux.state.callCount, calls); assert.match(sent.at(-1)!, /选择订单 COUPON-1001/);
    faux.setResponses([() => fauxAssistantMessage("正在查询所选订单。")]);
    await qq.handle(message("选择订单 COUPON-1001")); assert.equal(faux.state.callCount, calls + 1); assert.match(sent.at(-1)!, /所选订单/);
    await qq.handle(message("我的订单"));
    await qq.handle(message("查询到账 银行卡"));
    await qq.handle(message("选择订单 COUPON-1001"));
    assert.equal(faux.state.callCount, calls + 1, "QQ string host receipts retire old choices without a provider request");
    assert.match(sent.at(-1)!, /选择已失效/);
  } finally { await qq.close(); }
  const chat = new WebChatSessions(store, who => createCouponSession(who, store, runtime, faux.getModel()), 2000,
    createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic-key" }));
  try {
    const client = await chat.create(undefined, "demo-a");
    const send = (text: string) => chat.send(client.token, randomUUID(), text, client.session.id);
    const calls = faux.state.callCount;
    assert.equal((await send("我要退款")).reply.kind, "order");
    assert.equal((await send("查询到账 银行卡")).origin, "host");
    const oldChoice = await send("选择订单 COUPON-1001");
    assert.equal(oldChoice.reply.kind, "notice"); assert.equal(oldChoice.origin, "host");
    assert.equal(faux.state.callCount, calls, "Web host consultation retires old refund cards without starting an agent");
    faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("list_orders", {}), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("请选择订单。"),
    ]);
    assert.equal((await send("帮我看看最近买的券单")).reply.kind, "order");
    assert.equal((await send("查询到账 银行卡")).origin, "host");
    let observed = "";
    faux.setResponses([context => {
      const user = context.messages.findLast(message => message.role === "user");
      observed = !user ? "" : typeof user.content === "string" ? user.content : user.content.map(part => part.type === "text" ? part.text : "").join("");
      return fauxAssistantMessage("仅处理本条明确订单查询。");
    }]);
    await send("COUPON-1001");
    assert.equal(observed, "COUPON-1001", "Web bare IDs cannot revive an inner stale discovery request");
  } finally { chat.close(); }
  console.log("最近订单专项通过：可信身份/最近三笔/更多提示、成功展示后选单、未展示/旧卡/超时/异单拒绝、重新授权、CLI与QQ同轮续问、只读工具与解析边界。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkOrderDiscovery();
