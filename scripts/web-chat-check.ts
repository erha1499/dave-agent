import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";
import { createWebChatAgentFactory, createWebChatSettingsCatalog, validateWebChatSettings, type WebChatSettings } from "../src/web-chat-settings.ts";

export async function checkWebChat() {
  const runtime = await createModelRuntime(), faux = fauxProvider({ models: [{ id: "web-faux", reasoning: true }] }); runtime.registerNativeProvider(faux.provider);
  let factories = 0, requests = 0, block: Promise<void> | undefined, onRead: (() => void) | undefined;
  const reads: Array<{ identity: QQIdentity; orderId: string }> = [];
  const store = {
    async resolveBinding(identity: QQIdentity) { return { bindingId: `binding-${identity.senderId}`, customerId: `customer-${identity.senderId}` }; },
    async listOrders() { return { source: "demo-database", asOf: new Date().toISOString(), orders: [], hasMore: false }; },
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
  const catalog = createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic-key", DASHSCOPE_API_KEY: "synthetic-bailian-key" });
  const chat = new WebChatSessions(store, async (identity, _id, settings) => {
    factories++;
    const session = await createCouponSession(identity, store, runtime, { ...faux.getModel(), maxTokens: settings.maxTokens });
    session.setThinkingLevel(settings.thinkingLevel); return session;
  }, 2000, catalog);
  const server = createWebChatServer(chat);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  const owners = new Map<string, string>();
  const combinedCookie = (cookie: string) => owners.has(cookie) ? `${cookie}; ${owners.get(cookie)}` : cookie;
  async function http(path: string, method = "GET", body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return new Promise<{ status: number; data: any; bytes: Buffer; cookie?: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method, headers: {
        ...(method === "POST" ? { "Content-Type": "application/json", "X-Chat-Request": "1" } : {}),
        ...(cookie ? { Cookie: combinedCookie(cookie) } : {}), ...headers,
      } }, res => {
        const chunks: Buffer[] = []; res.on("data", data => chunks.push(data));
        res.once("end", () => {
          const cookies = res.headers["set-cookie"]?.map(value => value.split(";")[0]!) ?? [];
          if (cookies[0] && cookies[1]) owners.set(cookies[0], cookies[1]);
          const buffer = Buffer.concat(chunks), text = buffer.toString("utf8"); resolve({ status: res.statusCode!, bytes: buffer,
          data: res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : text,
          cookie: res.headers["set-cookie"]?.[0]?.split(";")[0], headers: res.headers }); });
      });
      req.once("error", reject); req.end(bytes);
    });
  }
  const send = async (cookie: string, text: string, requestId = randomUUID()) => http("/api/chat/messages", "POST",
    { sessionId: (await chat.get(cookie.split("=")[1])).session?.id ?? randomUUID(), requestId, text }, cookie);
  try {
    const sharedCss = await readFile(new URL("../web/evaluation/style.css", import.meta.url));
    const sharedCssHash = createHash("sha256").update(sharedCss).digest("hex");
    const ui = await http("/ui.css");
    assert.equal(ui.status, 200); assert.deepEqual(ui.bytes, sharedCss, "chat serves the exact evaluation stylesheet instead of copying a theme");
    assert.equal(ui.headers["content-type"], "text/css; charset=utf-8"); assert.equal(ui.headers["cache-control"], "no-store");
    assert.match(String(ui.headers["content-security-policy"]), /style-src 'self'.*frame-ancestors 'none'/);
    for (const path of ["/.env", "/web/evaluation/style.css", "/../evaluation/style.css", "/%2e%2e/evaluation/style.css", "/ui.css/more"])
      assert.equal((await http(path)).status, 404, "only fixed static assets are public");
    assert.equal((await http("/ui.css?path=.env")).status, 400);
    assert.equal((await http("/ui.css", "GET", undefined, undefined, { Host: "evil.test" })).status, 403);
    assert.equal((await http("/ui.css", "GET", undefined, undefined, { Origin: "https://evil.test" })).status, 403);
    assert.equal(createHash("sha256").update(await readFile(new URL("../web/evaluation/style.css", import.meta.url))).digest("hex"), sharedCssHash);
    const config = await http("/api/chat/config"); assert.equal(config.status, 200); assert.equal(config.data.readOnly, true);
    assert.equal(config.data.version, 2); assert.deepEqual(config.data.defaults, { modelSelection: "configured", thinkingLevel: "off", maxTokens: 2048 });
    assert.deepEqual(config.data.options, { thinkingLevels: ["off", "high"], maxTokens: [512, 1024, 2048] });
    assert.equal(config.data.evaluationUrl, "http://127.0.0.1:3001/"); assert.equal(config.data.models.length, 4);
    assert.ok(config.data.models.every((row: any) => row.available && row.supportsThinking));
    assert.doesNotMatch(JSON.stringify(config.data), /synthetic-key|synthetic-bailian-key|apiKey|metadata/);
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
    const a = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null });
    const b = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: null });
    assert.equal(a.status, 200); assert.ok(a.cookie && b.cookie); assert.notEqual(a.data.session.id, b.data.session.id);
    for (const body of [{ profileId: "demo-a" }, { profileId: "demo-a", sessionId: "bad" }, { profileId: "demo-a", sessionId: 0 }])
      assert.equal((await http("/api/chat/session", "POST", body, b.cookie)).status, 400);
    const liveNull = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null }, b.cookie);
    assert.equal(liveNull.status, 401); assert.equal(liveNull.headers["set-cookie"], undefined);
    assert.equal((await chat.get(b.cookie.split("=")[1])).session?.id, b.data.session.id);
    assert.match(a.headers["set-cookie"]![0]!, /HttpOnly; SameSite=Strict; Path=\//);
    assert.doesNotMatch(a.headers["set-cookie"]![0]!, /Max-Age=/, "server idle expiry must not become a fixed cookie lifetime");
    const runtimeOnly = a.cookie, ownerOnly = owners.get(a.cookie)!;
    const legacyGet = await http("/api/chat/session", "GET", undefined, undefined, { Cookie: runtimeOnly });
    assert.deepEqual(legacyGet.data, { session: null, messages: [] }); assert.equal(legacyGet.headers["set-cookie"], undefined);
    const legacyNonNull = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: a.data.session.id }, undefined, { Cookie: runtimeOnly });
    assert.equal(legacyNonNull.status, 401); assert.equal(legacyNonNull.headers["set-cookie"], undefined);
    const upgraded = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null }, undefined, { Cookie: runtimeOnly });
    assert.equal(upgraded.status, 200, "an explicit null create upgrades a browser without owner capability instead of trapping it in 401");
    assert.equal(upgraded.headers["set-cookie"]?.length, 2); assert.notEqual(upgraded.cookie, a.cookie);
    assert.notEqual(owners.get(upgraded.cookie!), ownerOnly); assert.notEqual(upgraded.data.session.conversationId, a.data.session.conversationId);
    assert.deepEqual(upgraded.data.messages, []); assert.equal(upgraded.data.session.turns, 0);
    const missingOwnerMessage = { sessionId: a.data.session.id, requestId: randomUUID(), text: "旧能力不能发送消息" };
    for (const path of ["/api/chat/messages", "/api/chat/messages/stream"]) {
      const refused = await http(path, "POST", missingOwnerMessage, undefined, { Cookie: runtimeOnly });
      assert.equal(refused.status, 401); assert.equal(refused.headers["set-cookie"], undefined);
    }
    const wrongPair = `${upgraded.cookie}; ${ownerOnly}`;
    assert.deepEqual((await http("/api/chat/session", "GET", undefined, undefined, { Cookie: wrongPair })).data, { session: null, messages: [] });
    assert.equal((await http("/api/chat/messages", "POST", { ...missingOwnerMessage, sessionId: upgraded.data.session.id }, undefined, { Cookie: wrongPair })).status, 401);
    assert.equal((await http("/api/chat/session", "GET", undefined, a.cookie)).data.session.id, a.data.session.id,
      "missing owner upgrade creates independent authority without reading, adopting or invalidating an existing owner history");
    assert.deepEqual(a.data.session.settings, config.data.defaults); assert.deepEqual(a.data.session.model, { provider: "deepseek", id: "deepseek-flash" });
    for (const settings of [null, {}, { modelSelection: "configured", thinkingLevel: "off" },
      { modelSelection: "arbitrary", thinkingLevel: "off", maxTokens: 512 },
      { modelSelection: "configured", thinkingLevel: "max", maxTokens: 512 },
      { modelSelection: "configured", thinkingLevel: "off", maxTokens: "512" },
      { modelSelection: "configured", thinkingLevel: "off", maxTokens: 513 },
      { modelSelection: "configured", thinkingLevel: "off", maxTokens: 512, apiKey: "bad" }]) {
      const invalid = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: a.data.session.id, settings }, a.cookie);
      assert.equal(invalid.status, 400); assert.equal(invalid.cookie, undefined);
      assert.equal((await http("/api/chat/session", "GET", undefined, a.cookie)).data.session.id, a.data.session.id);
    }
    for (const body of [{ requestId: randomUUID(), text: " " }, { requestId: "bad", text: "咨询" }, { requestId: randomUUID(), text: "a".repeat(2001) },
      { requestId: randomUUID(), text: "咨询", customerId: "other" }, { text: "咨询" }])
      assert.equal((await http("/api/chat/messages", "POST", { sessionId: a.data.session.id, ...body }, a.cookie)).status, 400);

    const id = randomUUID(), raw = " 查询到账 COUPON-1001 银行卡 ";
    const first = await send(a.cookie, raw, id); assert.equal(first.status, 200); assert.equal(first.data.origin, "host");
    assert.equal(first.headers["set-cookie"], undefined, "message responses cannot overwrite a newer cookie");
    assert.equal((await http("/api/chat/messages", "POST", { requestId: randomUUID(), text: raw }, a.cookie)).status, 400,
      "the old two-field contract cannot bypass the page session precondition");
    assert.equal(first.data.sessionId, a.data.session.id); assert.equal(first.data.requestId, id); assert.match(first.data.reply.text, /3–7/);
    assert.equal(factories, 0); assert.equal(requests, 0); const count = reads.length;
    assert.deepEqual((await send(a.cookie, raw, id)).data, first.data); assert.equal(reads.length, count);
    const staleReplay = await http("/api/chat/messages", "POST", { sessionId: randomUUID(), requestId: id, text: raw }, a.cookie);
    assert.equal(staleReplay.status, 401); assert.equal(staleReplay.headers["set-cookie"], undefined);
    assert.equal(reads.length, count, "session precondition is checked before replaying an already cached result");
    assert.equal((await send(a.cookie, raw.trim(), id)).status, 400);
    assert.equal((await send(b.cookie, "查询到账 COUPON-1001 银行卡")).data.reply.kind, "notice");
    assert.equal(reads.at(-1)!.identity.senderId, "TEST_USER2");
    const history = (await http("/api/chat/session", "GET", undefined, a.cookie)).data.messages;
    assert.equal(history[0].text, raw); assert.deepEqual(history[1].reply, first.data.reply);
    const chosen = { modelSelection: "qwen3.7-plus-2026-05-26", thinkingLevel: "high", maxTokens: 512 };
    const tuned = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null, settings: chosen });
    assert.equal(tuned.status, 200); assert.ok(tuned.cookie); assert.deepEqual(tuned.data.session.settings, chosen);
    assert.deepEqual(tuned.data.session.model, { provider: "bailian", id: chosen.modelSelection });
    assert.deepEqual((await http("/api/chat/session", "GET", undefined, tuned.cookie)).data.session.settings, chosen);
    const tunedOther = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: tuned.data.session.id, settings: chosen }, tuned.cookie);
    assert.equal(tunedOther.status, 200); assert.ok(tunedOther.cookie); assert.deepEqual(tunedOther.data.session.settings, chosen);
    assert.equal((await send(tunedOther.cookie, "查询到账 银行卡")).data.origin, "host"); assert.equal(factories, 0);

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
    assert.equal(reads.at(-1)!.identity.senderId, "TEST_USER1"); assert.deepEqual(declarations, ["get_order", "list_orders", "search_faq"]);
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

    const switchToB = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: a.data.session.id }, a.cookie); assert.equal(switchToB.status, 200); assert.ok(switchToB.cookie);
    assert.equal((await http("/api/chat/session", "GET", undefined, a.cookie)).data.session, null);
    assert.equal((await send(a.cookie, "旧身份")).status, 401); assert.deepEqual(switchToB.data.messages, []);
    const beforeStale = { reads: reads.length, requests, factories };
    const stalePage = await http("/api/chat/messages", "POST", { sessionId: a.data.session.id, requestId: id, text: raw }, switchToB.cookie);
    assert.equal(stalePage.status, 401); assert.equal(stalePage.headers["set-cookie"], undefined);
    await assert.rejects(chat.send(switchToB.cookie.split("=")[1], id, raw, a.data.session.id),
      error => error instanceof Error && Reflect.get(error, "status") === 401);
    assert.deepEqual({ reads: reads.length, requests, factories }, beforeStale, "stale page is rejected before host reads or Pi creation/prompt");
    assert.deepEqual((await http("/api/chat/session", "GET", undefined, switchToB.cookie)).data.messages, []);

    // Old page A now carries the shared replacement cookie B; reset must preserve B and its history.
    const historyA = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null });
    const historyB = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: historyA.data.session.id }, historyA.cookie);
    assert.ok(historyB.cookie); await send(historyB.cookie, "查询到账 电子钱包");
    const beforeReset = (await chat.get(historyB.cookie.split("=")[1]));
    const staleReset = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: historyA.data.session.id }, historyB.cookie);
    assert.equal(staleReset.status, 401); assert.equal(staleReset.headers["set-cookie"], undefined);
    await assert.rejects(chat.create(historyB.cookie.split("=")[1], "demo-a", undefined, historyA.data.session.id),
      error => error instanceof Error && Reflect.get(error, "status") === 401);
    assert.deepEqual((await chat.get(historyB.cookie.split("=")[1])), beforeReset);
    const resetOld = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null });
    const resetEntered = new Promise<void>(resolve => server.once("request", () => resolve()));
    const resetSplit = request({ hostname: "127.0.0.1", port, path: "/api/chat/session", method: "POST",
      headers: { "Content-Type": "application/json", "X-Chat-Request": "1", Cookie: combinedCookie(resetOld.cookie!) } });
    const resetReceipt = new Promise<{ status: number; cookie?: string[] }>((resolve, reject) => {
      resetSplit.once("error", reject); resetSplit.once("response", res => { res.resume(); res.once("end", () => resolve({ status: res.statusCode!, cookie: res.headers["set-cookie"] })); });
    });
    resetSplit.write("{"); await resetEntered;
    const resetNew = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: resetOld.data.session.id }, resetOld.cookie);
    assert.equal(resetNew.status, 200);
    resetSplit.end(JSON.stringify({ profileId: "demo-a", sessionId: resetOld.data.session.id }).slice(1));
    const lateReset = await resetReceipt; assert.equal(lateReset.status, 401); assert.equal(lateReset.cookie, undefined);
    assert.equal((await chat.get(resetNew.cookie!.split("=")[1])).session?.id, resetNew.data.session.id);
    const racing = await chat.create(undefined, "demo-a");
    const competitors = await Promise.allSettled([
      chat.create(racing.token, "demo-b", undefined, racing.session.id),
      chat.create(racing.token, "demo-a", undefined, racing.session.id),
    ]);
    assert.equal(competitors.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(competitors.filter(row => row.status === "rejected" && Reflect.get(row.reason, "status") === 401).length, 1);
    console.log("PASS web reset preconditions: stale page/history preserved, incomplete body rejected, await competitors accept once, live null and malformed contracts rejected.");

    // Cookie is captured before readBody; a replacement may be created while the old body is incomplete.
    const splitOld = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: null });
    const splitEntered = new Promise<void>(resolve => server.once("request", () => resolve()));
    const split = request({ hostname: "127.0.0.1", port, path: "/api/chat/messages", method: "POST",
      headers: { "Content-Type": "application/json", "X-Chat-Request": "1", Cookie: combinedCookie(splitOld.cookie!) } });
    const splitReceipt = new Promise<{ status: number; cookie?: string[] }>((resolve, reject) => {
      split.once("error", reject); split.once("response", res => { res.resume(); res.once("end", () => resolve({ status: res.statusCode!, cookie: res.headers["set-cookie"] })); });
    });
    split.write("{"); await splitEntered;
    const splitNew = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: splitOld.data.session.id }, splitOld.cookie);
    assert.equal(splitNew.status, 200); assert.ok(splitNew.cookie);
    split.end(JSON.stringify({ sessionId: splitOld.data.session.id, requestId: randomUUID(), text: "查询到账 银行卡" }).slice(1));
    const lateInvalid = await splitReceipt;
    assert.equal(lateInvalid.status, 401); assert.equal(lateInvalid.cookie, undefined, "old 401 cannot clear the replacement cookie");
    assert.equal((await http("/api/chat/session", "GET", undefined, splitNew.cookie)).data.session.id, splitNew.data.session.id);
    console.log("PASS web cross-session: stale page rejected before reads/Pi/history; incomplete old body returns 401 without replacing/clearing the new cookie.");
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
    assert.equal(failure.headers["set-cookie"], undefined, "a failed old request cannot clear a newer cookie");
    assert.equal((await http("/api/chat/session", "GET", undefined, switchToB.cookie)).data.session, null);
    const recoveredFailure = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: null }, switchToB.cookie);
    assert.equal(recoveredFailure.status, 200); assert.equal(recoveredFailure.data.session.profileId, "demo-b");
    assert.equal((await send(switchToB.cookie, "供应商失败检查", failureId)).status, 401);

    let release!: () => void; block = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { onRead = resolve; });
    const pendingId = randomUUID(), pending = send(b.cookie, "查询到账 COUPON-1002 银行卡", pendingId);
    await entered; onRead = undefined;
    assert.equal((await send(b.cookie, "查询到账 电子钱包")).status, 409);
    assert.equal((await send(b.cookie, "查询到账 COUPON-1002 银行卡", pendingId)).status, 409);
    const resetBusy = await http("/api/chat/session", "POST", { profileId: "demo-a", sessionId: b.data.session.id }, b.cookie);
    assert.equal(resetBusy.status, 409); assert.equal(resetBusy.cookie, undefined);
    const settingsBusy = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: b.data.session.id,
      settings: { modelSelection: "deepseek-v4-pro", thinkingLevel: "high", maxTokens: 512 } }, b.cookie);
    assert.equal(settingsBusy.status, 409); assert.equal(settingsBusy.cookie, undefined);
    assert.deepEqual((await http("/api/chat/session", "GET", undefined, b.cookie)).data.session.settings, config.data.defaults);
    release(); block = undefined; assert.equal((await pending).status, 200);
    // A disconnected browser cannot know whether delivery completed; replay its exact UUID instead of rerunning a turn.
    block = new Promise<void>(resolve => { release = resolve; });
    const droppedEntered = new Promise<void>(resolve => { onRead = resolve; });
    const droppedId = randomUUID(), droppedText = "查询到账 COUPON-1002 电子钱包";
    const dropped = request({ hostname: "127.0.0.1", port, path: "/api/chat/messages", method: "POST",
      headers: { "Content-Type": "application/json", "X-Chat-Request": "1", Cookie: combinedCookie(b.cookie) } });
    dropped.on("error", () => {}); dropped.end(JSON.stringify({ sessionId: b.data.session.id, requestId: droppedId, text: droppedText }));
    await droppedEntered; onRead = undefined; dropped.destroy(); release(); block = undefined;
    let replay = await send(b.cookie, droppedText, droppedId);
    // The first reattachment may meet the still-running readonly continuation, whose busy reply is safe.
    if (replay.status === 409) { await new Promise<void>(resolve => setTimeout(resolve, 10)); replay = await send(b.cookie, droppedText, droppedId); }
    assert.equal(replay.status, 200); assert.equal(replay.data.requestId, droppedId); assert.equal(replay.data.sessionId, b.data.session.id);
    const afterDropped = reads.length; assert.deepEqual((await send(b.cookie, droppedText, droppedId)).data, replay.data);
    assert.equal(reads.length, afterDropped);
    const reset = await http("/api/chat/session", "POST", { profileId: "demo-b", sessionId: b.data.session.id }, b.cookie);
    assert.equal(reset.status, 200); assert.ok(reset.cookie); assert.notEqual(reset.data.session.id, b.data.session.id); assert.deepEqual(reset.data.messages, []);

    const timeoutChat = new WebChatSessions(store, async () => { throw new Error("must remain host"); }, 25, catalog);
    const old = await timeoutChat.create(undefined, "demo-a");
    block = new Promise<void>(resolve => { release = resolve; });
    await assert.rejects(timeoutChat.send(old.token, randomUUID(), "查询到账 COUPON-1001 银行卡", old.session.id), error => error instanceof Error && Reflect.get(error, "status") === 503);
    assert.equal((await timeoutChat.get(old.token)).session, null);
    const replacement = await timeoutChat.create(undefined, "demo-b"); release(); block = undefined;
    await new Promise<void>(resolve => setTimeout(resolve, 10)); assert.deepEqual((await timeoutChat.get(replacement.token)).messages, []);
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
    }, 30, catalog);
    const lateFactorySession = await factoryChat.create(undefined, "demo-a");
    const lateFactoryTurn = factoryChat.send(lateFactorySession.token, randomUUID(), "旧会话创建迟到", lateFactorySession.session.id);
    await factoryEntered;
    await assert.rejects(lateFactoryTurn, error => error instanceof Error && Reflect.get(error, "status") === 503);
    const newFactorySession = await factoryChat.create(undefined, "demo-b");
    faux.setResponses([() => { requests++; return fauxAssistantMessage("新身份的独立回复"); }]);
    assert.equal((await factoryChat.send(newFactorySession.token, randomUUID(), "新身份正常问题", newFactorySession.session.id)).reply.text, "新身份的独立回复");
    releaseFactory(); await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal(lateDisposals, 1); assert.equal((await factoryChat.get(lateFactorySession.token)).session, null);
    assert.deepEqual((await factoryChat.get(newFactorySession.token)).messages.map(row => row.text), ["新身份正常问题", "新身份的独立回复"]);
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
    }, 30, catalog);
    faux.setResponses([async (_context, options) => {
      requests++; providerSignal = options?.signal; enteredProvider(); await providerGate; return fauxAssistantMessage("迟到的旧身份回复");
    }]);
    const latePromptSession = await promptChat.create(undefined, "demo-a");
    const latePromptTurn = promptChat.send(latePromptSession.token, randomUUID(), "旧身份正在生成", latePromptSession.session.id);
    await providerEntered;
    await assert.rejects(latePromptTurn, error => error instanceof Error && Reflect.get(error, "status") === 503);
    assert.ok(abortedNative >= 1); assert.equal(disposedNative, 1); assert.equal(providerSignal?.aborted, true);
    const newPromptSession = await promptChat.create(undefined, "demo-b");
    faux.setResponses([() => { requests++; return fauxAssistantMessage("当前身份的回复"); }]);
    assert.equal((await promptChat.send(newPromptSession.token, randomUUID(), "当前身份的问题", newPromptSession.session.id)).reply.text, "当前身份的回复");
    releaseProvider(); await new Promise<void>(resolve => setTimeout(resolve, 10));
    assert.equal((await promptChat.get(latePromptSession.token)).session, null);
    assert.deepEqual((await promptChat.get(newPromptSession.token)).messages.map(row => row.text), ["当前身份的问题", "当前身份的回复"]);
    promptChat.close();

    for (let turn = 0; turn < 20; turn++) assert.equal((await send(reset.cookie, "查询到账 银行卡")).status, 200);
    assert.equal((await send(reset.cookie, "查询到账 银行卡")).status, 429);
    assert.equal((await http("/api/chat/session", "GET", undefined, reset.cookie)).data.messages.length, 40);
    const idleChat = new WebChatSessions(store, async () => { throw new Error("idle recovery must not prompt"); }, 2000, catalog);
    const idle = await idleChat.create(undefined, "demo-a"), realNow = Date.now, idleNow = realNow();
    try {
      Date.now = () => idleNow + 30 * 60_000;
      assert.equal((await idleChat.get(idle.token)).session, null);
      await assert.rejects(idleChat.create(idle.token, "demo-a", undefined, idle.session.id),
        error => error instanceof Error && Reflect.get(error, "status") === 401);
      const idleRecovered = await idleChat.create(idle.token, "demo-a", undefined, null);
      assert.equal(idleRecovered.session.profileId, "demo-a"); assert.notEqual(idleRecovered.session.id, idle.session.id);
    } finally { Date.now = realNow; idleChat.close(); }
    const full = new WebChatSessions(store, async () => { throw new Error("unused"); });
    for (let row = 0; row < 20; row++) await full.create(undefined, "demo-a");
    await assert.rejects(full.create(undefined, "demo-b"), error => error instanceof Error && Reflect.get(error, "status") === 429); full.close();
    console.log(`网页客服检查通过：实际 Node HTTP / Pi faux，身份与只读工具、原文去重、实际 Reply、换身份/新会话、忙碌、超时及有界历史；${requests} 次本地 faux 调用，0 远程/DB/QQ。`);
  } finally { chat.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await checkWebChatSettings();
}

async function checkWebChatSettings() {
  const originalFetch = globalThis.fetch;
  const env = { DEEPSEEK_API_KEY: "synthetic-deepseek", DASHSCOPE_API_KEY: "synthetic-bailian", EVAL_PORT: "3011" };
  const wires: Array<Record<string, any>> = [];
  const store = { async resolveBinding(identity: QQIdentity) { return { bindingId: `binding-${identity.senderId}`, customerId: `customer-${identity.senderId}` }; }, async getOrder() { throw new Error("unexpected DB read"); }, async searchKnowledge() { throw new Error("unexpected DB read"); } } as unknown as CouponStore;
  globalThis.fetch = async (url, init) => {
    assert.ok(["https://api.deepseek.com/chat/completions", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"].includes(String(url)), "unknown endpoint never reaches a network");
    const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    assert.equal(headers.get("authorization"), `Bearer ${String(url).includes("dashscope") ? env.DASHSCOPE_API_KEY : env.DEEPSEEK_API_KEY}`);
    wires.push(body);
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `web_wire_${wires.length}`, object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "本地替代 HTTP 回复，不代表模型质量。" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  };
  let chat: WebChatSessions | undefined;
  try {
    const catalog = createWebChatSettingsCatalog(env), resolved = await catalog;
    assert.equal(wires.length, 0, "offline catalog never discovers models remotely");
    assert.equal(resolved.evaluationUrl, "http://127.0.0.1:3011/");
    for (const port of ["", " 3001", "3001 ", "100", "65536", "https://bad"])
      await assert.rejects(createWebChatSettingsCatalog({ EVAL_PORT: port }), /EVAL_PORT/);
    const nonReasoning = await createWebChatSettingsCatalog({ MODEL_PROVIDER: "openai", MODEL_ID: "gpt-4.1-mini", MODEL_API_KEY: "synthetic-openai" });
    assert.equal(nonReasoning.models[0]!.supportsThinking, false);
    assert.throws(() => validateWebChatSettings({ modelSelection: "configured", thinkingLevel: "high", maxTokens: 512 }, nonReasoning), /不支持开启推理/);
    const absentModel = await createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic", MODEL_ID: "missing-model" });
    assert.equal(absentModel.models[0]!.available, false);
    assert.throws(() => validateWebChatSettings({ modelSelection: "configured", thinkingLevel: "off", maxTokens: 512 }, absentModel), /不支持所选输出/);

    const noKeys = await createWebChatSettingsCatalog();
    assert.ok(noKeys.models.every(model => !model.available));
    const hostOnly = new WebChatSessions(store, async () => { throw new Error("no model should initialize"); }, 2000, Promise.resolve(noKeys));
    const host = await hostOnly.create(undefined, "demo-a");
    assert.equal((await hostOnly.send(host.token, randomUUID(), "查询到账 银行卡", host.session.id)).origin, "host");
    await assert.rejects(hostOnly.create(host.token, "demo-b", noKeys.defaults, host.session.id), /当前不可用/);
    assert.equal((await hostOnly.get(host.token)).session?.id, host.session.id);
    const nextHost = await hostOnly.create(host.token, "demo-b", undefined, host.session.id);
    assert.deepEqual(nextHost.session.settings, noKeys.defaults); hostOnly.close();
    assert.equal(wires.length, 0);

    const factory = createWebChatAgentFactory(store, env);
    const actualSessions: Awaited<ReturnType<typeof factory>>[] = [];
    chat = new WebChatSessions(store, async (...args) => { const session = await factory(...args); actualSessions.push(session); return session; }, 2000, catalog);
    const cases: WebChatSettings[] = [
      { modelSelection: "configured", thinkingLevel: "off", maxTokens: 512 },
      { modelSelection: "deepseek-flash", thinkingLevel: "high", maxTokens: 1024 },
      { modelSelection: "deepseek-v4-pro", thinkingLevel: "off", maxTokens: 2048 },
      { modelSelection: "deepseek-v4-pro", thinkingLevel: "high", maxTokens: 512 },
      { modelSelection: "qwen3.7-plus-2026-05-26", thinkingLevel: "off", maxTokens: 1024 },
      { modelSelection: "qwen3.7-plus-2026-05-26", thinkingLevel: "high", maxTokens: 2048 },
    ];
    let cookie: string | undefined;
    for (const settings of cases) {
      const before: number = wires.length;
      const created = await chat.create(cookie, "demo-a", settings, (await chat.get(cookie)).session?.id ?? null); cookie = created.token;
      assert.equal(wires.length, before, "creating/resetting settings does not prompt the model");
      assert.deepEqual((await chat.get(cookie)).session?.settings, settings, "refresh exposes the actually applied snapshot");
      assert.equal((await chat.send(cookie, randomUUID(), "查询到账 电子钱包", created.session.id)).origin, "host");
      assert.equal(wires.length, before, "host consultation never initializes a selected generation model");
      const result = await chat.send(cookie, randomUUID(), "普通合成问答，不查询任何订单", created.session.id);
      assert.equal(result.origin, "agent"); assert.equal(wires.length, before + 1);
      const wire = wires.at(-1)!, qwen = settings.modelSelection === "qwen3.7-plus-2026-05-26";
      assert.equal(wire.model, created.session.model.id); assert.deepEqual(created.session.model,
        { provider: qwen ? "bailian" : "deepseek", id: settings.modelSelection === "configured" ? "deepseek-flash" : settings.modelSelection });
      assert.equal(wire[qwen ? "max_completion_tokens" : "max_tokens"], settings.maxTokens);
      assert.equal(wire[qwen ? "max_tokens" : "max_completion_tokens"], undefined);
      if (qwen) { assert.equal(wire.enable_thinking, settings.thinkingLevel === "high"); assert.equal(wire.reasoning_effort, undefined); assert.equal(wire.thinking, undefined); }
      else { assert.deepEqual(wire.thinking, { type: settings.thinkingLevel === "high" ? "enabled" : "disabled" });
        assert.equal(wire.reasoning_effort, settings.thinkingLevel === "high" ? "high" : undefined); }
      const native = actualSessions.at(-1)!;
      assert.deepEqual(native.getActiveToolNames().sort(), ["get_order", "list_orders", "search_faq"]);
      assert.equal(native.thinkingLevel, settings.thinkingLevel); assert.equal(native.model?.maxTokens, settings.maxTokens);
    }
    const preserved = await chat.create(cookie, "demo-b", cases.at(-1), (await chat.get(cookie)).session?.id ?? null); cookie = preserved.token;
    assert.deepEqual(preserved.session.settings, cases.at(-1)); assert.deepEqual(preserved.messages, []);
    assert.equal(wires.length, 6);
    console.log("网页参数检查通过：4 个目录选项、完整配置快照、默认无密钥宿主兼容、坏设置保留旧会话；6 次原生 Pi 替代 HTTP 验证模型、off/high 与 512/1024/2048 实际请求；0 远程/DB/QQ。");
  } finally { chat?.close(); globalThis.fetch = originalFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChat();
