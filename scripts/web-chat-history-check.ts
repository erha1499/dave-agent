import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore, QQIdentity, QQIdentityBinding } from "../src/coupon-store.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { WebChatHistory } from "../src/web-chat-history.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";
import { createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";

const catalog = () => createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic-history-key" });
function fixture() {
  const bindings = new Map<string, QQIdentityBinding>([1, 2].map(id => [`TEST_USER${id}`, { bindingId: `binding-${id}`, customerId: `customer-${id}` }]));
  let reads = 0, onRead: (() => void) | undefined, block: Promise<void> | undefined;
  let bindingGate: Promise<void> | undefined, bindingEntered: (() => void) | undefined, bindingFailed = false;
  const store = {
    async resolveBinding(identity: QQIdentity) {
      if (bindingFailed) throw new Error("synthetic binding unavailable");
      const gate = bindingGate; bindingGate = undefined;
      bindingEntered?.(); bindingEntered = undefined; await gate;
      return structuredClone(bindings.get(identity.senderId));
    },
    async listOrders(identity: QQIdentity) {
      return { source: "demo-database", asOf: new Date().toISOString(), orders: identity.senderId === "TEST_USER1" ? [{ id: "COUPON-1001", status: "paid",
        paidCents: 7980, refundedCents: 0, couponStatuses: ["unused"], productName: "合成套餐", shopName: "合成门店", createdAt: new Date().toISOString() }] : [], hasMore: false };
    },
    async getOrder(identity: QQIdentity, orderId: string) {
      reads++; onRead?.(); await block;
      if (identity.senderId !== "TEST_USER1" || orderId !== "COUPON-1001") throw new Error("未找到当前客户可查询的订单");
      return { source: "demo-database", id: orderId, status: "paid", asOf: new Date().toISOString(),
        amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, shop: { id: "shop-1", name: "合成门店" },
        items: [{ productId: "product-1", productName: "合成套餐" }], coupons: [{ status: "unused" }], payments: [], refunds: [] };
    },
    async searchKnowledge() { return []; },
  } as unknown as CouponStore;
  return { store, bindings, get reads() { return reads; }, set onRead(value: (() => void) | undefined) { onRead = value; },
    set block(value: Promise<void> | undefined) { block = value; }, set bindingGate(value: Promise<void> | undefined) { bindingGate = value; },
    set bindingEntered(value: (() => void) | undefined) { bindingEntered = value; }, set bindingFailed(value: boolean) { bindingFailed = value; } };
}
const isStatus = (status: number) => (error: unknown) => error instanceof Error && Reflect.get(error, "status") === status;
const deadline = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("history check deadline")), 5000); timer.unref();
})]);
async function child(path: string, mode: string) {
  const business = fixture();
  const chat = new WebChatSessions(business.store, async () => { throw new Error("child only uses host consultation"); }, 2000, catalog(), new WebChatHistory(path));
  const created = await chat.create(undefined, "demo-a"), requestId = randomUUID();
  if (mode === "empty") {
    process.stdout.write(`${JSON.stringify(created)}\n`); setInterval(() => {}, 1000); await new Promise(() => {});
  } else if (mode === "pending") {
    business.block = new Promise(() => {});
    business.onRead = () => process.stdout.write(`${JSON.stringify({ ...created, requestId })}\n`);
    setInterval(() => {}, 1000);
    await chat.send(created.token, requestId, "查询到账 COUPON-1001 银行卡", created.session.id);
  } else {
    const result = await chat.send(created.token, requestId, " 查询到账 银行卡 ", created.session.id);
    process.stdout.write(`${JSON.stringify({ ...created, requestId, result, history: await chat.get(created.token) })}\n`);
    chat.close();
  }
}
async function startChild(path: string, mode = "seed") {
  const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", path, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let text = "", diagnostic = "";
  processChild.stderr.on("data", chunk => { diagnostic += chunk; });
  const finished = new Promise<number | null>((resolve, reject) => { processChild.once("error", reject); processChild.once("exit", resolve); });
  const data = await deadline(new Promise<any>((resolve, reject) => {
    processChild.stdout.on("data", chunk => { text += chunk; const end = text.indexOf("\n"); if (end >= 0) resolve(JSON.parse(text.slice(0, end))); });
    processChild.once("exit", code => { if (!text.includes("\n")) reject(new Error(`history child ${code}: ${diagnostic}`)); });
  }));
  return { processChild, data, finished };
}
async function httpFixture(chat: WebChatSessions) {
  const server = createWebChatServer(chat);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const http = async (path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<any>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method: body === undefined ? "GET" : "POST", headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Chat-Request": "1" }), ...headers,
    } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.once("end", () => resolve({ status: res.statusCode, data: JSON.parse(text), headers: res.headers,
        cookie: res.headers["set-cookie"]?.map(value => value.split(";")[0]).join("; ") }));
    });
    req.once("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { http, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export async function checkWebChatHistory() {
  const directory = await mkdtemp(join(tmpdir(), "dave-web-history-")), path = join(directory, "history.sqlite");
  const runtime = await createModelRuntime(), faux = fauxProvider({ models: [{ id: "history-faux", reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  let factories = 0;
  const business = fixture(), makeAgent = async (identity: QQIdentity) => { factories++; return createCouponSession(identity, business.store, runtime, faux.getModel()); };
  let chat: WebChatSessions | undefined, endpoint: Awaited<ReturnType<typeof httpFixture>> | undefined;
  try {
    await checkEmptyShells(directory);
    // A different process commits a real host turn, then exits. No in-memory transcript is reused.
    const seeded = await startChild(path); assert.equal(await seeded.finished, 0);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const original = seeded.data, ownerCookie = `dave_chat_owner=${original.ownerToken}`;
    chat = new WebChatSessions(business.store, makeAgent, 2000, catalog(), new WebChatHistory(path));
    endpoint = await httpFixture(chat); const http = endpoint.http;
    assert.equal((await http("/api/chat/session", `${ownerCookie}; dave_chat=${original.token}`)).data.session, null);
    for (const invalid of ["/api/chat/sessions", "/api/chat/sessions?profileId=bad", "/api/chat/sessions?profileId=demo-a&profileId=demo-a",
      "/api/chat/sessions?profileId=demo-a&customerId=other", "/api/chat/config?profileId=demo-a"])
      assert.equal((await http(invalid, ownerCookie)).status, 400);
    const listed = await http("/api/chat/sessions?profileId=demo-a", ownerCookie);
    assert.equal(listed.status, 200); assert.equal(listed.data.limit, 100); assert.equal(listed.data.conversations.length, 1);
    assert.equal(listed.data.conversations[0].id, original.session.conversationId); assert.equal(listed.data.conversations[0].title, "查询到账 银行卡");
    assert.equal(listed.data.conversations[0].turns, 1); assert.equal(listed.data.conversations[0].current, false);
    assert.equal((await http("/api/chat/sessions?profileId=demo-b", ownerCookie)).data.conversations.length, 0);
    for (const invalidOwner of ["dave_chat_owner=bad", `${ownerCookie}; ${ownerCookie}`, "dave_chat_owner=" + "a".repeat(43)]) {
      const hidden = await http("/api/chat/sessions?profileId=demo-a", invalidOwner);
      assert.equal(hidden.status, 200); assert.deepEqual(hidden.data.conversations, []); assert.equal(hidden.headers["set-cookie"], undefined);
    }
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", ownerCookie, undefined, { Host: "evil.test" })).status, 403);
    assert.equal((await http("/api/chat/session/open", ownerCookie, { conversationId: original.session.conversationId, profileId: "demo-a", sessionId: null },
      { Origin: "https://evil.test" })).status, 403);
    const other = await http("/api/chat/session", undefined, { profileId: "demo-a", sessionId: null });
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", other.cookie)).data.conversations.length, 0);
    const openBody = { conversationId: original.session.conversationId, profileId: "demo-a", sessionId: null };
    assert.equal((await http("/api/chat/session/open", other.cookie, { ...openBody, sessionId: other.data.session.id })).status, 404);
    assert.equal((await http("/api/chat/session/open", ownerCookie, { ...openBody, profileId: "demo-b" })).status, 404);
    for (const extra of [{ identity: { senderId: "TEST_USER1" } }, { messages: original.history.messages }, { settings: {} }])
      assert.equal((await http("/api/chat/session/open", ownerCookie, { ...openBody, ...extra })).status, 400);
    const opened = await http("/api/chat/session/open", ownerCookie, openBody);
    assert.equal(opened.status, 200); assert.notEqual(opened.data.session.id, original.session.id);
    assert.equal(opened.data.session.conversationId, original.session.conversationId); assert.deepEqual(opened.data.messages, original.history.messages);
    assert.equal(opened.data.session.turns, 1); assert.equal(opened.data.session.busy, false);
    const beforeReplay = { reads: business.reads, factories, calls: faux.state.callCount };
    assert.equal((await http("/api/chat/messages", opened.cookie, { sessionId: original.session.id, requestId: original.requestId, text: " 查询到账 银行卡 " })).status, 401);
    assert.deepEqual({ reads: business.reads, factories, calls: faux.state.callCount }, beforeReplay);
    assert.equal((await http("/api/chat/session", `dave_chat=${opened.cookie.split(";")[0].split("=")[1]}`)).data.session, null, "runtime alone is not browser ownership");
    const wrongOwner = other.cookie.split(";")[1].trim();
    assert.equal((await http("/api/chat/messages", `${opened.cookie.split(";")[0]}; ${wrongOwner}`, { sessionId: opened.data.session.id, requestId: randomUUID(), text: "越权" })).status, 401);
    let historyContext = "";
    faux.setResponses([context => { historyContext = JSON.stringify(context.messages); return fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }); }, fauxAssistantMessage("重新核对本人订单后的回复。")]);
    const continuedId = randomUUID(), continuedBody = { sessionId: opened.data.session.id, requestId: continuedId, text: "接着查我的订单 COUPON-1001" };
    const continued = await http("/api/chat/messages", opened.cookie, continuedBody);
    assert.equal(continued.status, 200); assert.equal(continued.data.origin, "agent"); assert.equal(business.reads, 1);
    assert.match(historyContext, /web-consultation-history|查询到账 银行卡/); assert.doesNotMatch(historyContext, /COUPON-1002/);
    const replayReads = business.reads, replayCalls = faux.state.callCount;
    assert.deepEqual((await http("/api/chat/messages", opened.cookie, continuedBody)).data, continued.data);
    assert.equal(business.reads, replayReads); assert.equal(faux.state.callCount, replayCalls);
    assert.equal((await http("/api/chat/messages", opened.cookie, { ...continuedBody, text: continuedBody.text + " " })).status, 400);
    assert.equal((await http("/api/chat/session", opened.cookie)).data.messages[0].id, `${original.requestId}:user`);
    assert.equal((await http("/api/chat/session", opened.cookie)).data.messages[1].id, `${original.requestId}:assistant`);
    assert.equal((await http("/api/chat/session", opened.cookie)).data.session.turns, 2);

    // New/switch preserves the first conversation, but reopening rotates runtime authority (including ABA).
    const changed = await http("/api/chat/session", opened.cookie, { profileId: "demo-b", sessionId: opened.data.session.id });
    assert.equal(changed.status, 200); assert.deepEqual(changed.data.messages, []);
    const back = await http("/api/chat/session/open", changed.cookie, { ...openBody, sessionId: changed.data.session.id });
    assert.equal(back.status, 200); assert.notEqual(back.data.session.id, opened.data.session.id); assert.equal(back.data.messages.length, 4);
    assert.equal((await http("/api/chat/messages", back.cookie, continuedBody)).status, 401);
    assert.equal((await http("/api/chat/messages", back.cookie, { ...continuedBody, sessionId: back.data.session.id })).status, 400,
      "a completed request from the older runtime cannot create duplicate persistent message IDs");
    assert.equal((await http("/api/chat/session/open", back.cookie, { ...openBody, sessionId: opened.data.session.id })).status, 401);
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", back.cookie)).data.conversations[0].current, true);
    const cards = await http("/api/chat/messages", back.cookie, { sessionId: back.data.session.id, requestId: randomUUID(), text: "我要退款" });
    assert.equal(cards.data.reply.kind, "order"); assert.equal(cards.data.reply.orders[0].selectionText, "选择订单 COUPON-1001");
    const newA = await http("/api/chat/session", back.cookie, { profileId: "demo-a", sessionId: back.data.session.id });
    const restoredCard = await http("/api/chat/session/open", newA.cookie, { ...openBody, sessionId: newA.data.session.id });
    const noOldCardCalls = faux.state.callCount;
    const staleCard = await http("/api/chat/messages", restoredCard.cookie, { sessionId: restoredCard.data.session.id, requestId: randomUUID(), text: "选择订单 COUPON-1001" });
    assert.equal(staleCard.data.reply.kind, "notice"); assert.match(staleCard.data.reply.text, /选择已失效/); assert.equal(faux.state.callCount, noOldCardCalls);

    // A delayed authorized GET must not return a transcript after its runtime was replaced.
    let releaseBinding!: () => void, enteredBinding!: () => void;
    business.bindingGate = new Promise<void>(resolve => { releaseBinding = resolve; });
    const readEntered = new Promise<void>(resolve => { enteredBinding = resolve; }); business.bindingEntered = enteredBinding;
    const delayedRead = http("/api/chat/session", restoredCard.cookie); await deadline(readEntered);
    const replacement = await http("/api/chat/session", restoredCard.cookie, { profileId: "demo-b", sessionId: restoredCard.data.session.id });
    releaseBinding(); assert.deepEqual((await delayedRead).data, { session: null, messages: [] });
    assert.equal((await http("/api/chat/session", replacement.cookie)).data.session.profileId, "demo-b");
    const boundA = await http("/api/chat/session/open", replacement.cookie, { ...openBody, sessionId: replacement.data.session.id });
    const boundBody = { sessionId: boundA.data.session.id, requestId: randomUUID(), text: "查询到账 银行卡" };
    assert.equal((await http("/api/chat/messages", boundA.cookie, boundBody)).status, 200);
    business.bindings.set("TEST_USER1", { bindingId: "binding-new", customerId: "customer-1" });
    assert.equal((await http("/api/chat/session", boundA.cookie)).status, 401);
    assert.equal((await http("/api/chat/messages", boundA.cookie, boundBody)).status, 401, "binding changes deny even completed receipt replays");
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", boundA.cookie)).data.conversations.length, 0);
    assert.equal((await http("/api/chat/session/open", boundA.cookie, openBody)).status, 404);
    business.bindings.set("TEST_USER1", { bindingId: "binding-1", customerId: "customer-new" });
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", boundA.cookie)).data.conversations.length, 0);
    business.bindings.set("TEST_USER1", { bindingId: "binding-1", customerId: "customer-1" });
    business.bindingFailed = true;
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", boundA.cookie)).status, 503);
    business.bindingFailed = false;
    business.bindings.delete("TEST_USER1");
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", boundA.cookie)).status, 401);
    business.bindings.set("TEST_USER1", { bindingId: "binding-1", customerId: "customer-1" });
    const active = await http("/api/chat/session/open", boundA.cookie, openBody); assert.equal(active.status, 200);
    // Busy survives page refresh; new/open/settings do not discard an accepted pending request.
    let release!: () => void, entered!: () => void;
    business.block = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; }); business.onRead = entered;
    const pendingId = randomUUID(), pendingBody = { sessionId: active.data.session.id, requestId: pendingId, text: "查询到账 COUPON-1001 银行卡" };
    const pending = http("/api/chat/messages", active.cookie, pendingBody); await deadline(reached); business.onRead = undefined;
    const busy = await http("/api/chat/session", active.cookie);
    assert.equal(busy.data.session.busy, true); assert.equal(busy.data.messages.at(-1).status, "pending"); assert.equal(busy.data.messages.at(-1).text, pendingBody.text);
    assert.equal((await http("/api/chat/session", active.cookie, { profileId: "demo-b", sessionId: active.data.session.id })).status, 409);
    assert.equal((await http("/api/chat/session/open", active.cookie, { ...openBody, sessionId: active.data.session.id })).status, 409);
    assert.equal((await http("/api/chat/messages", active.cookie, pendingBody)).status, 409);
    release(); business.block = undefined; assert.equal((await pending).status, 200);
    assert.equal((await http("/api/chat/session", active.cookie)).data.session.busy, false);
    // Reauthorization after the actual business read also protects the final persisted Reply.
    business.block = new Promise<void>(resolve => { release = resolve; });
    const finalRead = new Promise<void>(resolve => { entered = resolve; }); business.onRead = entered;
    const finalBody = { sessionId: active.data.session.id, requestId: randomUUID(), text: "查询到账 COUPON-1001 银行卡" };
    const bindingChangedTurn = http("/api/chat/messages", active.cookie, finalBody); await deadline(finalRead); business.onRead = undefined;
    business.bindings.set("TEST_USER1", { bindingId: "binding-1", customerId: "customer-after-read" });
    release(); business.block = undefined;
    const finalDenied = await bindingChangedTurn; assert.equal(finalDenied.status, 503); assert.equal(finalDenied.headers["set-cookie"], undefined);
    assert.equal((await http("/api/chat/sessions?profileId=demo-a", active.cookie)).data.conversations.length, 0);
    business.bindings.set("TEST_USER1", { bindingId: "binding-1", customerId: "customer-1" });
    const failedHistory = await http("/api/chat/session/open", active.cookie, openBody);
    assert.equal(failedHistory.status, 200); assert.equal(failedHistory.data.messages.at(-1).status, "interrupted");
    assert.equal(failedHistory.data.messages.at(-1).reply, undefined);
    await endpoint.close(); endpoint = undefined; chat.close(); chat = undefined;

    // Killed process: the accepted raw text remains interrupted; opening does not run it again.
    const unfinished = await startChild(path, "pending"); unfinished.processChild.kill("SIGKILL"); await unfinished.finished;
    chat = new WebChatSessions(business.store, makeAgent, 2000, catalog(), new WebChatHistory(path));
    const noRestartCalls = faux.state.callCount;
    const interruptedList = await chat.list(unfinished.data.ownerToken, "demo-a");
    assert.equal(interruptedList.conversations[0]?.status, "interrupted"); assert.equal(interruptedList.conversations[0]?.turns, 1);
    const recovered = await chat.open(undefined, unfinished.data.ownerToken, unfinished.data.session.conversationId, "demo-a", null);
    assert.equal(recovered.messages[0]?.status, "interrupted"); assert.equal(recovered.messages[0]?.text, "查询到账 COUPON-1001 银行卡");
    assert.equal(recovered.messages[1]?.status, "interrupted"); assert.equal(recovered.messages[1]?.reply, undefined); assert.match(recovered.messages[1]!.text, /未收到完整答复/);
    assert.equal(faux.state.callCount, noRestartCalls);
    await assert.rejects(chat.send(recovered.token, unfinished.data.requestId, "查询到账 COUPON-1001 银行卡", unfinished.data.session.id), isStatus(401));
    assert.equal((await chat.send(recovered.token, randomUUID(), "查询到账 银行卡", recovered.session.id)).origin, "host");
    assert.equal((await chat.get(recovered.token)).session?.turns, 2);
    chat.close(); chat = undefined;

    // Independent writers use the same actual disk file without overwriting another owner.
    const writers = await Promise.all([startChild(path), startChild(path)]);
    for (const writer of writers) assert.equal(await writer.finished, 0);
    const first = new WebChatSessions(business.store, makeAgent, 2000, catalog(), new WebChatHistory(path));
    const second = new WebChatSessions(business.store, makeAgent, 2000, catalog(), new WebChatHistory(path));
    try {
      for (const writer of writers) assert.equal((await first.list(writer.data.ownerToken, "demo-a")).conversations.length, 1);
      const race = await Promise.allSettled([first.create(undefined, "demo-a", undefined, null, original.ownerToken), second.create(undefined, "demo-b", undefined, null, original.ownerToken)]);
      assert.equal(race.filter(row => row.status === "fulfilled").length, 1);
      assert.equal(race.filter(row => row.status === "rejected" && isStatus(401)(row.reason)).length, 1);
      assert.ok((await first.list(original.ownerToken, "demo-a")).conversations.some(row => row.id === original.session.conversationId));
    } finally { first.close(); second.close(); }
    await checkStorageFailures(directory, business.store, makeAgent, faux);
    await checkHistoryLimits(directory, business.store);
    await checkUnavailableModels(directory, business.store);
    await checkReplacementCleanupLock(directory, business.store);
    console.log(`网页持久历史检查通过：真实临时SQLite/跨进程提交与SIGKILL恢复、owner/profile/binding隔离、实际Pi上下文续聊与重新读订单、CAS/ABA/busy/回执、旧卡失效、原子失败/损坏与显式容量；${faux.state.callCount} 次本地faux，0远程/业务DB/QQ。`);
  } finally { if (endpoint) await endpoint.close(); chat?.close(); await rm(directory, { recursive: true, force: true }); }
}

async function checkStorageFailures(directory: string, store: CouponStore, factory: (identity: QQIdentity) => ReturnType<typeof createCouponSession>, faux: ReturnType<typeof fauxProvider>) {
  const path = join(directory, "failures.sqlite"), chat = new WebChatSessions(store, factory, 2000, catalog(), new WebChatHistory(path));
  const db = new DatabaseSync(path);
  try {
    const created = await chat.create(undefined, "demo-a"), requestId = randomUUID(), calls = faux.state.callCount;
    db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END;");
    await assert.rejects(chat.send(created.token, requestId, "不会发出的咨询", created.session.id), isStatus(503));
    assert.equal(faux.state.callCount, calls); assert.equal((await chat.get(created.token)).messages.length, 0);
    assert.equal((await chat.get(created.token)).session?.turns, 0); db.exec("DROP TRIGGER reject_claim;");
    const settings = db.prepare("SELECT settings FROM conversations WHERE id=?").get(created.session.conversationId)!.settings;
    db.prepare("UPDATE conversations SET settings='{}' WHERE id=?").run(created.session.conversationId);
    await assert.rejects(chat.create(created.token, "demo-b", undefined, created.session.id), isStatus(503));
    assert.equal(db.prepare("SELECT settings FROM conversations WHERE id=?").get(created.session.conversationId)!.settings, "{}",
      "empty-shell cleanup does not silently overwrite a corrupt record");
    db.prepare("UPDATE conversations SET settings=? WHERE id=?").run(settings!, created.session.conversationId);
    db.exec("CREATE TRIGGER reject_complete BEFORE UPDATE ON conversations WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'synthetic complete failure'); END;");
    faux.setResponses([fauxAssistantMessage("不能被误报已保存的成功答复")]);
    await assert.rejects(chat.send(created.token, requestId, "完成保存失败检查", created.session.id), isStatus(503));
    assert.equal(faux.state.callCount, calls + 1); assert.equal((await chat.get(created.token)).session, null);
    const receipt = db.prepare("SELECT status,result FROM requests WHERE request=?").get(requestId)!;
    assert.equal(receipt.status, "interrupted"); assert.equal(receipt.result, null, "receipt update rolled back with the failed transcript commit");
    const saved = await chat.open(undefined, created.ownerToken, created.session.conversationId, "demo-a", null);
    assert.equal(saved.messages[0]?.text, "完成保存失败检查"); assert.equal(saved.messages[1]?.reply, undefined);
    assert.doesNotMatch(JSON.stringify(saved.messages), /不能被误报已保存/); db.exec("DROP TRIGGER reject_complete;");
    const raw = db.prepare("SELECT messages FROM conversations WHERE id=?").get(saved.session.conversationId)!.messages;
    const invalid = JSON.stringify([{ id: "not-uuid", role: "assistant", text: "corrupt but valid JSON" }]);
    db.prepare("UPDATE conversations SET messages=? WHERE id=?").run(invalid, saved.session.conversationId);
    await assert.rejects(chat.list(created.ownerToken, "demo-a"), isStatus(503));
    await assert.rejects(chat.get(saved.token), isStatus(503));
    assert.equal(db.prepare("SELECT messages FROM conversations WHERE id=?").get(saved.session.conversationId)!.messages, invalid);
    db.prepare("UPDATE conversations SET messages=? WHERE id=?").run(raw!, saved.session.conversationId);
    const messages = JSON.parse(String(raw));
    for (const [changed, state] of [
      [[{ ...messages[0], status: "pending" }, messages[1]], "ready"],
      [messages, "busy"],
      [[messages[0], { ...messages[1], id: messages[0].id }], "interrupted"],
    ] as const) {
      const invalidState = JSON.stringify(changed);
      db.prepare("UPDATE conversations SET messages=?,state=? WHERE id=?").run(invalidState, state, saved.session.conversationId);
      await assert.rejects(chat.list(created.ownerToken, "demo-a"), isStatus(503));
      assert.equal(db.prepare("SELECT messages FROM conversations WHERE id=?").get(saved.session.conversationId)!.messages, invalidState);
    }
    db.prepare("UPDATE conversations SET messages=?,state='interrupted' WHERE id=?").run(raw!, saved.session.conversationId);
  } finally { chat.close(); db.close(); }
  const broken = join(directory, "broken.sqlite"), bytes = Buffer.from("synthetic invalid SQLite database");
  await writeFile(broken, bytes); assert.throws(() => new WebChatHistory(broken)); assert.deepEqual(await readFile(broken), bytes, "corruption is not silently replaced by an empty history");
}
async function checkHistoryLimits(directory: string, store: CouponStore) {
  const path = join(directory, "limits.sqlite"), chat = new WebChatSessions(store, async () => { throw new Error("limits check remains host-only"); }, 2000, catalog(), new WebChatHistory(path));
  try {
    let created = await chat.create(undefined, "demo-a");
    for (let turn = 0; turn < 20; turn++) await chat.send(created.token, randomUUID(), "查询到账 银行卡", created.session.id);
    const reopened = await chat.open(created.token, created.ownerToken, created.session.conversationId, "demo-a", created.session.id);
    assert.equal(reopened.session.turns, 20); assert.equal(reopened.messages.length, 40);
    await assert.rejects(chat.send(reopened.token, randomUUID(), "查询到账 银行卡", reopened.session.id), isStatus(429));
    const realNow = Date.now, now = realNow();
    try { Date.now = () => now + 30 * 60_000; assert.equal((await chat.get(reopened.token)).session, null);
      assert.equal((await chat.list(reopened.ownerToken, "demo-a")).conversations[0]?.status, "limit");
    } finally { Date.now = realNow; }
    created = await chat.open(undefined, reopened.ownerToken, reopened.session.conversationId, "demo-a", null);
    for (let index = 1; index < 100; index++) {
      created = await chat.create(created.token, "demo-a", undefined, created.session.id);
      await chat.send(created.token, randomUUID(), "查询到账 银行卡", created.session.id);
    }
    await assert.rejects(chat.create(created.token, "demo-a", undefined, created.session.id), isStatus(429));
    assert.equal((await chat.list(created.ownerToken, "demo-a")).conversations.length, 100);
    assert.equal((await chat.get(created.token)).session?.id, created.session.id, "failed capacity increase retains the current runtime");
    const db = new DatabaseSync(path);
    try {
      const empty = db.prepare("SELECT * FROM conversations LIMIT 1").get()!;
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
      for (let index = 100; index < 1000; index++) insert.run(randomUUID(), "a".repeat(64), "demo-b", "binding-2", "customer-2", empty.settings!, empty.model!, "[]", empty.created_at!, empty.updated_at!, 0, "ready");
      db.exec("COMMIT");
      await assert.rejects(chat.create(undefined, "demo-b"), isStatus(429));
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 1000);
      assert.equal((await chat.get(created.token)).session?.id, created.session.id);
    } finally { db.close(); }
  } finally { chat.close(); }
}
async function checkUnavailableModels(directory: string, store: CouponStore) {
  const path = join(directory, "model-metadata.sqlite");
  const original = new WebChatSessions(store, async () => { throw new Error("original remains host-only"); }, 2000, catalog(), new WebChatHistory(path));
  const created = await original.create(undefined, "demo-a");
  await original.send(created.token, randomUUID(), "查询到账 银行卡", created.session.id);
  original.close();
  for (const env of [{}, { DEEPSEEK_API_KEY: "synthetic-history-key", MODEL_ID: "deepseek-v4-pro" }]) {
    let factories = 0;
    const chat = new WebChatSessions(store, async () => { factories++; throw new Error("unavailable/drift model must not initialize"); }, 2000,
      createWebChatSettingsCatalog(env), new WebChatHistory(path));
    const db = new DatabaseSync(path);
    try {
      const opened = await chat.open(undefined, created.ownerToken, created.session.conversationId, "demo-a", null);
      assert.equal(opened.session.modelAvailable, false); assert.match(opened.session.modelUnavailableReason!, /模型设置/);
      assert.deepEqual(opened.session.settings, created.session.settings); assert.deepEqual(opened.session.model, created.session.model);
      const before = await chat.get(opened.token), requests = db.prepare("SELECT COUNT(*) AS count FROM requests").get()!.count;
      await assert.rejects(chat.send(opened.token, randomUUID(), "预约的规则是什么？", opened.session.id), isStatus(400));
      assert.equal(factories, 0); assert.deepEqual(await chat.get(opened.token), before);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM requests").get()!.count, requests, "unavailable model does not accept a pending request or consume a turn");
      assert.equal((await chat.send(opened.token, randomUUID(), "我有哪些订单", opened.session.id)).reply.kind, "order");
      assert.equal(factories, 0); assert.equal((await chat.get(opened.token)).session?.turns, opened.session.turns + 1);
      assert.deepEqual((await chat.get(opened.token)).session?.model, created.session.model);
    } finally { chat.close(); db.close(); }
  }
}
async function checkEmptyShells(directory: string) {
  const path = join(directory, "empty-shells.sqlite"), business = fixture();
  let chat = new WebChatSessions(business.store, async () => { throw new Error("empty shell check remains host-only"); }, 2000, catalog(), new WebChatHistory(path));
  const db = new DatabaseSync(path);
  try {
    let current = await chat.create(undefined, "demo-a");
    assert.deepEqual((await chat.list(current.ownerToken, "demo-a")).conversations, [], "empty current shells are not consultation history");
    for (let index = 0; index < 6; index++) current = await chat.create(current.token, index % 2 ? "demo-b" : "demo-a", undefined, current.session.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 1, "repeated empty new/customer changes retain only the current shell");
    current = await chat.create(current.token, "demo-a", undefined, current.session.id);
    await chat.send(current.token, randomUUID(), "查询到账 银行卡", current.session.id);
    const submitted = current;
    let blank = await chat.create(current.token, "demo-b", undefined, current.session.id);
    for (let index = 0; index < 3; index++) blank = await chat.create(blank.token, "demo-b", undefined, blank.session.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 2);
    assert.equal((await chat.list(blank.ownerToken, "demo-a")).conversations[0]?.id, submitted.session.conversationId);
    assert.deepEqual((await chat.list(blank.ownerToken, "demo-b")).conversations, []);
    current = await chat.open(blank.token, blank.ownerToken, submitted.session.conversationId, "demo-a", blank.session.id);
    assert.equal(current.messages.length, 2); assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 1);
    let release!: () => void;
    business.block = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { business.onRead = resolve; });
    const pending = chat.send(current.token, randomUUID(), "查询到账 COUPON-1001 银行卡", current.session.id); await deadline(entered); business.onRead = undefined;
    await assert.rejects(chat.create(current.token, "demo-b", undefined, current.session.id), isStatus(409));
    assert.equal((await chat.get(current.token)).messages.at(-1)?.status, "pending");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 1, "accepted pending records cannot be purged");
    release(); business.block = undefined; await pending;
    blank = await chat.create(current.token, "demo-a", undefined, current.session.id);
    const realNow = Date.now, now = realNow();
    try { Date.now = () => now + 30 * 60_000; assert.equal((await chat.get(blank.token)).session, null); }
    finally { Date.now = realNow; }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 1, "idle empty shell is removed while accepted history remains");
    chat.close();
    const emptyProcess = await startChild(path, "empty"); emptyProcess.processChild.kill("SIGKILL"); await emptyProcess.finished;
    chat = new WebChatSessions(business.store, async () => { throw new Error("empty restart remains host-only"); }, 2000, catalog(), new WebChatHistory(path));
    assert.deepEqual((await chat.list(emptyProcess.data.ownerToken, "demo-a")).conversations, []);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count, 1, "dead-process empty shell does not accumulate or delete another owner's submitted history");
    const afterRestart = await chat.create(undefined, "demo-a", undefined, null, emptyProcess.data.ownerToken);
    const sameEmpty = await chat.open(afterRestart.token, afterRestart.ownerToken, afterRestart.session.conversationId, "demo-a", afterRestart.session.id);
    assert.equal(sameEmpty.session.conversationId, afterRestart.session.conversationId, "explicit open target is excluded from empty-shell cleanup");
    assert.notEqual(sameEmpty.session.id, afterRestart.session.id);
    assert.equal((await chat.list(submitted.ownerToken, "demo-a")).conversations.length, 1);
    assert.equal((await chat.open(sameEmpty.token, sameEmpty.ownerToken, submitted.session.conversationId, "demo-a", sameEmpty.session.id).catch(error => error)).status, 404);
  } finally { chat.close(); db.close(); }
}
async function checkReplacementCleanupLock(directory: string, store: CouponStore) {
  const path = join(directory, "replacement-lock.sqlite"), history = new WebChatHistory(path);
  const locker = new DatabaseSync(path), activate = history.activate.bind(history);
  let armed = false, locked = false;
  history.activate = (...args) => {
    const saved = activate(...args);
    if (armed) { locker.exec("BEGIN IMMEDIATE"); locked = true; armed = false; }
    return saved;
  };
  const chat = new WebChatSessions(store, async () => { throw new Error("cleanup check remains host-only"); }, 2000, catalog(), history);
  try {
    const original = await chat.create(undefined, "demo-a");
    await chat.send(original.token, randomUUID(), "查询到账 银行卡", original.session.id);
    let current = original;
    for (const action of ["new", "open"] as const) {
      armed = true;
      try {
        current = action === "new" ? await chat.create(current.token, "demo-b", undefined, current.session.id)
          : await chat.open(current.token, current.ownerToken, original.session.conversationId, "demo-a", current.session.id);
        assert.equal(locked, true, "a second real SQLite connection holds the writer lock after activation committed");
        assert.notEqual(current.session.id, original.session.id);
      } finally { if (locked) { locker.exec("ROLLBACK"); locked = false; } }
      assert.equal((await chat.get(current.token)).session?.id, current.session.id, "successful replacement returns usable authority despite cleanup contention");
      assert.equal((await chat.get(original.token)).session, null);
    }
    assert.equal(current.session.conversationId, original.session.conversationId); assert.equal(current.messages.length, 2);
    assert.equal((await chat.list(current.ownerToken, "demo-a")).conversations[0]?.id, original.session.conversationId);
  } finally { if (locked) locker.exec("ROLLBACK"); chat.close(); locker.close(); }
}
if (process.argv[2] === "--child") await child(process.argv[3]!, process.argv[4]!);
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChatHistory();
