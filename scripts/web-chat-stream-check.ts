import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";

type Frame = { event: string; data: any };
const deadline = <T>(value: Promise<T>) => Promise.race([value, new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("stream check deadline")), 5000); timer.unref();
})]);

export async function checkWebChatStream() {
  const runtime = await createModelRuntime();
  const faux = fauxProvider({ models: [{ id: "web-stream-faux", reasoning: true }], tokensPerSecond: 8000, tokenSize: { min: 1, max: 1 } });
  runtime.registerNativeProvider(faux.provider);
  let blocked: Promise<void> | undefined, reads = 0;
  const store = {
    async listOrders(identity: QQIdentity) {
      return { source: "demo-database", asOf: new Date().toISOString(), hasMore: false,
        orders: identity.senderId === "TEST_USER1" ? [{ id: "COUPON-1001", status: "paid", paidCents: 7980, refundedCents: 0,
          couponStatuses: ["unused"], productName: "合成套餐", shopName: "合成门店", createdAt: new Date().toISOString() }] : [] };
    },
    async getOrder(identity: QQIdentity, orderId: string) {
      reads++; await blocked;
      if (identity.senderId !== "TEST_USER1" || orderId !== "COUPON-1001") throw new Error("未找到当前客户可查询的订单");
      return { source: "demo-database", id: orderId, status: "paid", asOf: new Date().toISOString(),
        amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
        shop: { id: "shop-1", name: "合成门店" }, items: [{ productId: "product-1", productName: "合成套餐" }],
        coupons: [{ status: "unused" }], payments: [], refunds: [] };
    },
    async searchKnowledge() { return []; },
  } as unknown as CouponStore;
  const factory = (identity: QQIdentity) => createCouponSession(identity, store, runtime, faux.getModel());
  const chat = new WebChatSessions(store, factory, 2000), server = createWebChatServer(chat);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  function http(path: string, body?: unknown, cookie?: string, observe?: (frame: Frame) => void) {
    const frames: Frame[] = [];
    let onHeaders!: (value: { status: number; headers: IncomingHttpHeaders }) => void;
    const headers = new Promise<{ status: number; headers: IncomingHttpHeaders }>(resolve => { onHeaders = resolve; });
    let finish!: (value: { status: number; data: any; headers: IncomingHttpHeaders }) => void, fail!: (error: unknown) => void;
    const finished = new Promise<{ status: number; data: any; headers: IncomingHttpHeaders }>((resolve, reject) => { finish = resolve; fail = reject; });
    const req = request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Chat-Request": "1" }), ...(cookie ? { Cookie: cookie } : {}),
    } }, res => {
      onHeaders({ status: res.statusCode!, headers: res.headers });
      const decoder = new TextDecoder(); let pending = "", text = "";
      res.on("data", chunk => {
        const next = decoder.decode(chunk, { stream: true }); text += next; pending += next;
        if (!res.headers["content-type"]?.includes("text/event-stream")) return;
        let end: number;
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const lines = pending.slice(0, end).split("\n"); pending = pending.slice(end + 2);
          const frame = { event: lines.find(line => line.startsWith("event: "))!.slice(7),
            data: JSON.parse(lines.find(line => line.startsWith("data: "))!.slice(6)) };
          frames.push(frame); observe?.(frame);
        }
      });
      res.once("end", () => finish({ status: res.statusCode!, headers: res.headers,
        data: res.headers["content-type"]?.includes("application/json") ? JSON.parse(text) : text }));
      res.once("error", fail);
    });
    req.once("error", fail); req.end(body === undefined ? undefined : JSON.stringify(body));
    return { frames, headers, finished, req };
  }
  async function create(profileId = "demo-a") {
    const response = await http("/api/chat/session", { profileId, sessionId: null }).finished;
    assert.equal(response.status, 200);
    return { cookie: response.headers["set-cookie"]![0]!.split(";")[0]!, sessionId: response.data.session.id as string };
  }
  const message = (sessionId: string, text: string, requestId = randomUUID()) => ({ sessionId, text, requestId });
  try {
    const client = await create(), body = message(client.sessionId, "合成流式订单凭证问题 COUPON-1001");
    for (const invalid of [
      { ...body, sessionId: randomUUID() }, { ...body, requestId: "bad" }, { ...body, text: " " }, { ...body, extra: true },
    ]) {
      const result = await http("/api/chat/messages/stream", invalid, client.cookie).finished;
      assert.equal(result.status, invalid.sessionId !== client.sessionId ? 401 : 400);
      assert.match(String(result.headers["content-type"]), /application\/json/); assert.equal(result.headers["set-cookie"], undefined);
    }
    assert.equal(faux.state.callCount, 0); assert.equal(reads, 0);
    let release!: () => void, reached!: () => void;
    blocked = new Promise<void>(resolve => { release = resolve; });
    const reachedTool = new Promise<void>(resolve => { reached = resolve; });
    const finalText = "这是流式最终答复。\n<img src=x onerror=alert(1)>";
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("PRIVATE_REASONING_SENTINEL"), fauxText("先核对订单。"),
        fauxToolCall("get_order", { orderId: "COUPON-1001" }, { id: "PRIVATE_TOOL_ID" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(finalText),
    ]);
    const streaming = http("/api/chat/messages/stream", body, client.cookie, frame => {
      if (frame.event === "step" && frame.data.label === "查询订单详情" && frame.data.status === "running") reached();
    });
    await deadline(reachedTool);
    assert.equal((await streaming.headers).status, 200);
    assert.equal(streaming.frames[0]!.event, "start"); assert.equal(streaming.frames[0]!.data.replayed, false);
    assert.ok(streaming.frames.some(frame => frame.event === "delta"));
    assert.ok(!streaming.frames.some(frame => frame.event === "result"), "real text arrives while the actual tool is still blocked");
    assert.equal(streaming.frames.filter(frame => frame.event === "delta").map(frame => frame.data.text).join(""), "先核对订单。");
    assert.doesNotMatch(JSON.stringify(streaming.frames), /PRIVATE_|get_order|COUPON-1001|args|thinking/);
    const busy = await http("/api/chat/messages/stream", body, client.cookie).finished;
    assert.equal(busy.status, 409); assert.match(String(busy.headers["content-type"]), /application\/json/);
    release(); blocked = undefined;
    const complete = await deadline(streaming.finished);
    assert.equal(complete.headers["set-cookie"], undefined); assert.equal(complete.headers["cache-control"], "no-store");
    assert.match(String(complete.headers["content-type"]), /text\/event-stream/);
    assert.equal(streaming.frames.at(-1)!.event, "result");
    for (const frame of streaming.frames) {
      assert.equal(frame.data.sessionId, client.sessionId); assert.equal(frame.data.requestId, body.requestId);
    }
    const deltas = streaming.frames.filter(frame => frame.event === "delta");
    assert.deepEqual([...new Set(deltas.map(frame => frame.data.messageId))], ["assistant-1", "assistant-2"]);
    assert.equal(deltas.filter(frame => frame.data.messageId === "assistant-2").map(frame => frame.data.text).join(""), finalText);
    const result = streaming.frames.at(-1)!.data;
    assert.equal(result.reply.kind, "order"); assert.equal(result.reply.text, finalText); assert.equal(result.reply.orders[0].paidCents, 7980);
    assert.ok(result.steps.some((row: any) => row.label === "查询订单详情" && row.status === "done"));
    assert.ok(result.steps.every((row: any) => row.status === "done")); assert.ok(result.steps.length <= 64);
    assert.doesNotMatch(JSON.stringify(result.steps), /PRIVATE_|get_order|COUPON-1001|args|thinking/);
    const count = faux.state.callCount, readCount = reads;
    const replay = http("/api/chat/messages/stream", body, client.cookie); await replay.finished;
    assert.deepEqual(replay.frames.map(frame => frame.event), ["start", "result"]);
    assert.equal(replay.frames[0]!.data.replayed, true); assert.deepEqual(replay.frames[1]!.data, result);
    assert.deepEqual((await http("/api/chat/messages", body, client.cookie).finished).data, result);
    assert.equal(faux.state.callCount, count); assert.equal(reads, readCount);
    const saved = await http("/api/chat/session", undefined, client.cookie).finished;
    assert.equal(saved.data.messages.length, 2); assert.deepEqual(saved.data.messages[1].steps, result.steps);
    assert.equal(saved.data.messages[0].text, body.text);
    assert.equal((await http("/api/chat/messages/stream", { ...body, text: body.text + " " }, client.cookie).finished).status, 400);

    const host = http("/api/chat/messages/stream", message(client.sessionId, "查询到账 银行卡"), client.cookie);
    await host.finished; assert.equal(host.frames.at(-1)!.data.origin, "host");
    assert.ok(!host.frames.some(frame => frame.event === "delta"), "host receipts never invent text deltas");
    assert.equal(faux.state.callCount, count);

    const droppedBody = message(client.sessionId, "合成断流问题 COUPON-1001");
    blocked = new Promise<void>(resolve => { release = resolve; });
    const droppedTool = new Promise<void>(resolve => { reached = resolve; });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("断开页面后保存同一回复。"),
    ]);
    const dropped = http("/api/chat/messages/stream", droppedBody, client.cookie, frame => {
      if (frame.event === "step" && frame.data.label === "查询订单详情" && frame.data.status === "running") reached();
    });
    void dropped.finished.catch(() => {});
    await deadline(droppedTool); dropped.req.destroy(); release(); blocked = undefined;
    let recovered;
    for (let attempt = 0; attempt < 100; attempt++) {
      recovered = await http("/api/chat/messages", droppedBody, client.cookie).finished;
      if (recovered.status !== 409) break;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(recovered!.status, 200); assert.equal(recovered!.data.requestId, droppedBody.requestId);
    const droppedCount = faux.state.callCount;
    const droppedReplay = http("/api/chat/messages/stream", droppedBody, client.cookie); await droppedReplay.finished;
    assert.deepEqual(droppedReplay.frames.map(frame => frame.event), ["start", "result"]);
    assert.equal(faux.state.callCount, droppedCount);

    const denied = await create("demo-b");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("无法读取该订单。"),
    ]);
    const refusal = http("/api/chat/messages/stream", message(denied.sessionId, "合成越权问题 COUPON-1001"), denied.cookie);
    await refusal.finished;
    assert.ok(refusal.frames.some(frame => frame.event === "step" && frame.data.label === "查询订单详情" && frame.data.status === "error"));
    assert.doesNotMatch(JSON.stringify(refusal.frames), /7980|paidCents/);
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "PRIVATE_PROVIDER_DIAGNOSTIC" })]);
    const failed = http("/api/chat/messages/stream", message(denied.sessionId, "合成供应商失败问题"), denied.cookie);
    const failure = await failed.finished;
    assert.equal(failure.status, 200); assert.equal(failed.frames.at(-1)!.event, "error"); assert.equal(failed.frames.at(-1)!.data.status, 503);
    assert.ok(!failed.frames.some(frame => frame.event === "result")); assert.doesNotMatch(JSON.stringify(failed.frames), /PRIVATE_/);
    assert.equal((await http("/api/chat/session", undefined, denied.cookie).finished).data.session, null);
    assert.equal(failure.headers["set-cookie"], undefined);

    const pending = await create(), refundBody = message(pending.sessionId, "我要退款");
    const discovery = http("/api/chat/messages/stream", refundBody, pending.cookie); await discovery.finished;
    const listed = discovery.frames.at(-1)!.data;
    assert.equal(listed.origin, "host"); assert.equal(listed.reply.kind, "order");
    assert.equal(listed.reply.orders[0].selectionText, "选择订单 COUPON-1001");
    assert.ok(listed.steps.some((row: any) => row.label === "查询最近订单" && row.status === "done"));
    assert.ok(!discovery.frames.some(frame => frame.event === "delta"));
    let resumedPrompt = "";
    faux.setResponses([
      context => {
        const last = context.messages.filter(row => row.role === "user").at(-1);
        resumedPrompt = typeof last?.content === "string" ? last.content
          : last?.content.map(part => part.type === "text" ? part.text : "").join("") ?? "";
        return fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("已核对所选订单；当前入口不办理退款。"),
    ]);
    const selectionBody = message(pending.sessionId, listed.reply.orders[0].selectionText);
    const selected = http("/api/chat/messages/stream", selectionBody, pending.cookie); await selected.finished;
    assert.equal(selected.frames.at(-1)!.event, "result"); assert.equal(selected.frames.at(-1)!.data.origin, "agent");
    assert.match(resumedPrompt, /我要退款\n订单：COUPON-1001/);
    const selectedHistory = await http("/api/chat/session", undefined, pending.cookie).finished;
    assert.equal(selectedHistory.data.messages[2].text, selectionBody.text, "host continuation preserves the clicked user text in public history");

    const timeoutChat = new WebChatSessions(store, factory, 80);
    try {
      const old = await timeoutChat.create(undefined, "demo-a"), progress: unknown[] = [];
      blocked = new Promise<void>(resolve => { release = resolve; });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" })]);
      await assert.rejects(deadline(timeoutChat.send(old.token, randomUUID(), "合成超时问题 COUPON-1001", old.session.id,
        event => { progress.push(event); })), error => error instanceof Error && Reflect.get(error, "status") === 503);
      assert.equal(timeoutChat.get(old.token).session, null);
      const published = progress.length, replacement = await timeoutChat.create(undefined, "demo-b");
      const replacementReply = await timeoutChat.send(replacement.token, randomUUID(), "查询到账 电子钱包", replacement.session.id);
      assert.equal(replacementReply.origin, "host");
      release(); blocked = undefined;
      await new Promise<void>(resolve => setTimeout(resolve, 15));
      assert.equal(progress.length, published, "a timed-out native turn cannot publish late progress into its old response");
      assert.equal(timeoutChat.get(replacement.token).messages.length, 2);
    } finally { blocked = undefined; timeoutChat.close(); }
    console.log(`网页流式检查通过：实际 HTTP / Pi faux 增量、公开步骤、私有信息过滤、最终事实卡/历史、预校验、回放、断流重试、宿主无伪增量、越权及模型失败；${faux.state.callCount} 次本地调用，0 远程/DB/QQ。`);
  } finally { chat.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChatStream();
