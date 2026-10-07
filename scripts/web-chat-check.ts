import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";

export async function checkWebChat() {
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  let factories = 0, requests = 0, block: Promise<void> | undefined, onRead: (() => void) | undefined;
  const reads: Array<{ identity: QQIdentity; orderId: string }> = [];
  const store = {
    async getOrder(identity: QQIdentity, orderId: string) {
      reads.push({ identity: { ...identity }, orderId }); onRead?.(); await block;
      if (identity.appId !== "TEST_APP" || (identity.senderId === "TEST_USER1" ? "COUPON-1001" : "COUPON-1002") !== orderId)
        throw new Error("未找到当前客户可查询的订单");
      const now = new Date().toISOString();
      return { source: "demo-database", id: orderId, status: "paid", asOf: now, createdAt: now, paidAt: now,
        amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, shop: { id: "shop-demo-1", name: "模拟门店", merchantName: "模拟商家", address: "合成地址" },
        items: [{ id: `${orderId}-item`, productId: "product-demo-1", productName: "模拟套餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
        coupons: [{ id: `${orderId}-coupon`, orderItemId: `${orderId}-item`, status: "unused", expiresAt: now, redeemedAt: null, redeemedShopId: null }],
        payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
    },
    async searchKnowledge() { return [{ source: "demo-knowledge", sourceId: "KB-WEB-SYNTHETIC", title: "合成规则", body: "仅演示只读咨询", scope: { shopId: null, productId: null } }]; },
  } as unknown as CouponStore;
  const chat = new WebChatSessions(store, async identity => { factories++; return createCouponSession(identity, store, runtime, faux.getModel()); }, 2000);
  const server = createWebChatServer(chat);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  async function http(path: string, method = "GET", body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return new Promise<{ status: number; data: any; cookie?: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method, headers: {
        ...(method === "POST" ? { "Content-Type": "application/json", "X-Chat-Request": "1" } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers,
      } }, res => {
        const chunks: Buffer[] = []; res.on("data", data => chunks.push(data));
        res.once("end", () => { const text = Buffer.concat(chunks).toString("utf8"); resolve({ status: res.statusCode!,
          data: res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : text,
          cookie: res.headers["set-cookie"]?.[0]?.split(";")[0], headers: res.headers }); });
      });
      req.once("error", reject); req.end(bytes);
    });
  }
  const send = (cookie: string, text: string, requestId = randomUUID()) => http("/api/chat/messages", "POST", { requestId, text }, cookie);
  try {
    const config = await http("/api/chat/config"); assert.equal(config.status, 200); assert.equal(config.data.readOnly, true);
    assert.deepEqual(config.data.profiles.map((row: any) => row.id), ["demo-a", "demo-b"]);
    assert.match(String(config.headers["content-security-policy"]), /script-src 'self'.*frame-ancestors 'none'/);
    assert.deepEqual((await http("/api/chat/session")).data, { session: null, messages: [] });
    assert.equal((await http("/api/chat/config?identity=bad")).status, 400);
    for (const headers of [{ Host: "evil.test" }, { Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: `http://localhost:${port}` }] as Array<Record<string, string>>)
      assert.equal((await http("/api/chat/config", "GET", undefined, undefined, headers)).status, 403);
    for (const [body, headers] of [
      [{ profileId: "demo-a" }, { "X-Chat-Request": "0" }], [{ profileId: "demo-a" }, { "Content-Type": "text/plain" }],
      ["broken JSON", {}], [[], {}], [{ profileId: "demo-a", senderId: "TEST_USER2" }, {}], [{ profileId: "bad" }, {}],
      [Buffer.alloc(8193, 97), {}], [Buffer.from([0xff]), {}],
    ] as const) assert.equal((await http("/api/chat/session", "POST", body, undefined, headers)).status, 400);
    assert.equal((await send("dave_chat=invalid", "查询到账 银行卡")).status, 401);
    const a = await http("/api/chat/session", "POST", { profileId: "demo-a" });
    const b = await http("/api/chat/session", "POST", { profileId: "demo-b" });
    assert.equal(a.status, 200); assert.ok(a.cookie && b.cookie); assert.notEqual(a.data.session.id, b.data.session.id);
    assert.match(a.headers["set-cookie"]![0]!, /HttpOnly; SameSite=Strict; Path=\//);
    for (const body of [{ requestId: randomUUID(), text: " " }, { requestId: "bad", text: "咨询" }, { requestId: randomUUID(), text: "a".repeat(2001) },
      { requestId: randomUUID(), text: "咨询", customerId: "other" }, { text: "咨询" }])
      assert.equal((await http("/api/chat/messages", "POST", body, a.cookie)).status, 400);

    const id = randomUUID(), raw = " 查询到账 COUPON-1001 银行卡 ";
    const first = await send(a.cookie, raw, id); assert.equal(first.status, 200); assert.equal(first.data.origin, "host");
    assert.equal(first.data.sessionId, a.data.session.id); assert.equal(first.data.requestId, id); assert.match(first.data.reply.text, /3–7/);
    assert.equal(factories, 0); assert.equal(requests, 0); const count = reads.length;
    assert.deepEqual((await send(a.cookie, raw, id)).data, first.data); assert.equal(reads.length, count);
    assert.equal((await send(a.cookie, raw.trim(), id)).status, 400);
    assert.equal((await send(b.cookie, "查询到账 COUPON-1001 银行卡")).data.reply.kind, "notice");
    assert.equal(reads.at(-1)!.identity.senderId, "TEST_USER2");
    const history = (await http("/api/chat/session", "GET", undefined, a.cookie)).data.messages;
    assert.equal(history[0].text, raw); assert.deepEqual(history[1].reply, first.data.reply);

    let declarations: string[] = [], userTexts: string[] = [], hostHistory = "";
    faux.setResponses([
      context => { requests++; declarations = getCurrentTools(context.messages).map(row => row.name).sort();
        userTexts = context.messages.filter(row => row.role === "user").map(row => typeof row.content === "string" ? row.content
          : row.content.map(part => part.type === "text" ? part.text : "").join(""));
        hostHistory = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }); },
      () => { requests++; return fauxAssistantMessage("已查询本人合成订单。"); },
    ]);
    const order = await send(a.cookie, "查询 COUPON-1001"); assert.equal(order.status, 200); assert.equal(order.data.origin, "agent");
    assert.equal(order.data.reply.kind, "order"); assert.equal(order.data.reply.orders[0].paidCents, 7980);
    assert.equal(reads.at(-1)!.identity.senderId, "TEST_USER1"); assert.deepEqual(declarations, ["get_order", "search_faq"]);
    assert.match(hostHistory, /假设/); assert.doesNotMatch(userTexts.join(" "), /COUPON-1002/);
    const xss = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";
    faux.setResponses([() => { requests++; return fauxAssistantMessage(xss); }]);
    const untrusted = await send(a.cookie, "文字显示测试"); assert.equal(untrusted.data.reply.text, xss);
    assert.match(String(untrusted.headers["content-type"]), /application\/json/); assert.equal(untrusted.headers["x-content-type-options"], "nosniff");
    const beforeForbiddenTool = reads.length;
    faux.setResponses([
      () => { requests++; return fauxAssistantMessage(fauxToolCall("prepare_refund", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }); },
      () => { requests++; return fauxAssistantMessage("此页面仅支持只读咨询，未执行退款。"); },
    ]);
    const forbidden = await send(a.cookie, "直接执行退款"); assert.equal(forbidden.status, 200); assert.equal(forbidden.data.reply.kind, "notice");
    assert.equal(reads.length, beforeForbiddenTool, "an undeclared refund tool cannot reach any store");

    const switchToB = await http("/api/chat/session", "POST", { profileId: "demo-b" }, a.cookie); assert.equal(switchToB.status, 200); assert.ok(switchToB.cookie);
    assert.equal((await http("/api/chat/session", "GET", undefined, a.cookie)).data.session, null);
    assert.equal((await send(a.cookie, "旧身份")).status, 401); assert.deepEqual(switchToB.data.messages, []);
    faux.setResponses([
      context => { requests++; userTexts = context.messages.filter(row => row.role === "user").map(row => typeof row.content === "string" ? row.content
          : row.content.map(part => part.type === "text" ? part.text : "").join(""));
        hostHistory = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }); },
      () => { requests++; return fauxAssistantMessage("未找到当前客户可查询的订单，未执行退款。"); },
    ]);
    const denied = await send(switchToB.cookie, "查询他人订单 COUPON-1001"); assert.equal(denied.status, 200);
    assert.equal(denied.data.reply.kind, "answer"); assert.doesNotMatch(JSON.stringify(denied.data.reply), /7980|79\.80|paidCents/);
    assert.equal(reads.at(-1)!.identity.senderId, "TEST_USER2"); assert.deepEqual(userTexts, ["查询他人订单 COUPON-1001"]);
    assert.doesNotMatch(hostHistory, /web-consultation-history|文字显示测试|3–7个工作日|查询到账 COUPON-1001 银行卡/);

    const failureId = randomUUID();
    faux.setResponses([() => { requests++; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic-private-provider-diagnostic" }); }]);
    const failure = await send(switchToB.cookie, "供应商失败检查", failureId);
    assert.equal(failure.status, 503); assert.doesNotMatch(JSON.stringify(failure.data), /synthetic-private-provider/);
    assert.match(failure.headers["set-cookie"]![0]!, /Max-Age=0/);
    assert.equal((await http("/api/chat/session", "GET", undefined, switchToB.cookie)).data.session, null);
    assert.equal((await send(switchToB.cookie, "供应商失败检查", failureId)).status, 401);

    let release!: () => void; block = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { onRead = resolve; });
    const pendingId = randomUUID(), pending = send(b.cookie, "查询到账 COUPON-1002 银行卡", pendingId);
    await entered; onRead = undefined;
    assert.equal((await send(b.cookie, "查询到账 电子钱包")).status, 409);
    assert.equal((await send(b.cookie, "查询到账 COUPON-1002 银行卡", pendingId)).status, 409);
    const resetBusy = await http("/api/chat/session", "POST", { profileId: "demo-a" }, b.cookie);
    assert.equal(resetBusy.status, 409); assert.equal(resetBusy.cookie, undefined);
    release(); block = undefined; assert.equal((await pending).status, 200);
    // A disconnected browser cannot know whether delivery completed; replay its exact UUID instead of rerunning a turn.
    block = new Promise<void>(resolve => { release = resolve; });
    const droppedEntered = new Promise<void>(resolve => { onRead = resolve; });
    const droppedId = randomUUID(), droppedText = "查询到账 COUPON-1002 电子钱包";
    const dropped = request({ hostname: "127.0.0.1", port, path: "/api/chat/messages", method: "POST",
      headers: { "Content-Type": "application/json", "X-Chat-Request": "1", Cookie: b.cookie } });
    dropped.on("error", () => {}); dropped.end(JSON.stringify({ requestId: droppedId, text: droppedText }));
    await droppedEntered; onRead = undefined; dropped.destroy(); release(); block = undefined;
    let replay = await send(b.cookie, droppedText, droppedId);
    // The first reattachment may meet the still-running readonly continuation, whose busy reply is safe.
    if (replay.status === 409) { await new Promise<void>(resolve => setTimeout(resolve, 10)); replay = await send(b.cookie, droppedText, droppedId); }
    assert.equal(replay.status, 200); assert.equal(replay.data.requestId, droppedId); assert.equal(replay.data.sessionId, b.data.session.id);
    const afterDropped = reads.length; assert.deepEqual((await send(b.cookie, droppedText, droppedId)).data, replay.data);
    assert.equal(reads.length, afterDropped);
    const reset = await http("/api/chat/session", "POST", { profileId: "demo-b" }, b.cookie);
    assert.equal(reset.status, 200); assert.ok(reset.cookie); assert.notEqual(reset.data.session.id, b.data.session.id); assert.deepEqual(reset.data.messages, []);

    const timeoutChat = new WebChatSessions(store, async () => { throw new Error("must remain host"); }, 25);
    const old = timeoutChat.create(undefined, "demo-a");
    block = new Promise<void>(resolve => { release = resolve; });
    await assert.rejects(timeoutChat.send(old.token, randomUUID(), "查询到账 COUPON-1001 银行卡"), error => error instanceof Error && Reflect.get(error, "status") === 503);
    assert.equal(timeoutChat.get(old.token).session, null);
    const replacement = timeoutChat.create(undefined, "demo-b"); release(); block = undefined;
    await new Promise<void>(resolve => setTimeout(resolve, 10)); assert.deepEqual(timeoutChat.get(replacement.token).messages, []);
    timeoutChat.close();

    // Creating a native Pi session may finish after the request deadline; dispose it before any provider prompt.
    const lateCreated = await createCouponSession({ appId: "TEST_APP", senderId: "TEST_USER1" }, store, runtime, faux.getModel());
    let lateDisposals = 0;
    const disposeLate = lateCreated.dispose.bind(lateCreated);
    lateCreated.dispose = () => { lateDisposals++; disposeLate(); };
    let releaseFactory!: () => void, enteredFactory!: () => void;
    const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve; });
    const factoryEntered = new Promise<void>(resolve => { enteredFactory = resolve; });
    const factoryChat = new WebChatSessions(store, async identity => {
      if (identity.senderId === "TEST_USER1") { enteredFactory(); await factoryGate; return lateCreated; }
      return createCouponSession(identity, store, runtime, faux.getModel());
    }, 30);
    const lateFactorySession = factoryChat.create(undefined, "demo-a");
    const lateFactoryTurn = factoryChat.send(lateFactorySession.token, randomUUID(), "旧会话创建迟到");
    await factoryEntered;
    await assert.rejects(lateFactoryTurn, error => error instanceof Error && Reflect.get(error, "status") === 503);
    const newFactorySession = factoryChat.create(undefined, "demo-b");
    faux.setResponses([() => { requests++; return fauxAssistantMessage("新身份的独立回复"); }]);
    assert.equal((await factoryChat.send(newFactorySession.token, randomUUID(), "新身份正常问题")).reply.text, "新身份的独立回复");
    releaseFactory(); await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(lateDisposals, 1); assert.equal(factoryChat.get(lateFactorySession.token).session, null);
    assert.deepEqual(factoryChat.get(newFactorySession.token).messages.map(row => row.text), ["新身份正常问题", "新身份的独立回复"]);
    factoryChat.close();

    // An already-running native Pi prompt is aborted/disposed; even an ignored provider signal cannot publish its late answer.
    let releaseProvider!: () => void, enteredProvider!: () => void, providerSignal: AbortSignal | undefined;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    const providerEntered = new Promise<void>(resolve => { enteredProvider = resolve; });
    let abortedNative = 0, disposedNative = 0;
    const promptChat = new WebChatSessions(store, async identity => {
      const session = await createCouponSession(identity, store, runtime, faux.getModel());
      if (identity.senderId === "TEST_USER1") {
        const abortNative = session.abort.bind(session), disposeNative = session.dispose.bind(session);
        session.abort = async () => { abortedNative++; await abortNative(); };
        session.dispose = () => { disposedNative++; disposeNative(); };
      }
      return session;
    }, 30);
    faux.setResponses([async (_context, options) => {
      requests++; providerSignal = options?.signal; enteredProvider(); await providerGate; return fauxAssistantMessage("迟到的旧身份回复");
    }]);
    const latePromptSession = promptChat.create(undefined, "demo-a");
    const latePromptTurn = promptChat.send(latePromptSession.token, randomUUID(), "旧身份正在生成");
    await providerEntered;
    await assert.rejects(latePromptTurn, error => error instanceof Error && Reflect.get(error, "status") === 503);
    assert.ok(abortedNative >= 1); assert.equal(disposedNative, 1); assert.equal(providerSignal?.aborted, true);
    const newPromptSession = promptChat.create(undefined, "demo-b");
    faux.setResponses([() => { requests++; return fauxAssistantMessage("当前身份的回复"); }]);
    assert.equal((await promptChat.send(newPromptSession.token, randomUUID(), "当前身份的问题")).reply.text, "当前身份的回复");
    releaseProvider(); await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(promptChat.get(latePromptSession.token).session, null);
    assert.deepEqual(promptChat.get(newPromptSession.token).messages.map(row => row.text), ["当前身份的问题", "当前身份的回复"]);
    promptChat.close();

    for (let turn = 0; turn < 20; turn++) assert.equal((await send(reset.cookie, "查询到账 银行卡")).status, 200);
    assert.equal((await send(reset.cookie, "查询到账 银行卡")).status, 429);
    assert.equal((await http("/api/chat/session", "GET", undefined, reset.cookie)).data.messages.length, 40);
    const full = new WebChatSessions(store, async () => { throw new Error("unused"); });
    for (let row = 0; row < 20; row++) full.create(undefined, "demo-a");
    assert.throws(() => full.create(undefined, "demo-b"), error => error instanceof Error && Reflect.get(error, "status") === 429); full.close();
    console.log(`网页客服检查通过：实际 Node HTTP / Pi faux，身份与只读工具、原文去重、实际 Reply、换身份/新会话、忙碌、超时及有界历史；${requests} 次本地 faux 调用，0 远程/DB/QQ。`);
  } finally { chat.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChat();
