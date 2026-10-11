import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";
import { createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";

type Frame = { event: string; data: any };
const deadline = <T>(value: Promise<T>) => Promise.race([value, new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("stream check deadline")), 5000); timer.unref();
})]);

export async function checkWebChatStream() {
  const runtime = await createModelRuntime();
  const faux = fauxProvider({ models: [{ id: "web-stream-faux", reasoning: true }], tokensPerSecond: 8000, tokenSize: { min: 1, max: 1 } });
  runtime.registerNativeProvider(faux.provider);
  let blocked: Promise<void> | undefined, reads = 0, listBothOrders = false;
  const store = {
    async resolveBinding(identity: QQIdentity) { return { bindingId: `binding-${identity.senderId}`, customerId: `customer-${identity.senderId}` }; },
    async listOrders(identity: QQIdentity) {
      return { source: "demo-database", asOf: new Date().toISOString(), hasMore: false,
        orders: identity.senderId === "TEST_USER1" ? [{ id: "COUPON-1001", status: "paid", paidCents: 7980, refundedCents: 0,
          couponStatuses: ["unused"], productName: "合成套餐", shopName: "合成门店", createdAt: new Date().toISOString() },
          ...(listBothOrders ? [{ id: "COUPON-2001", status: "paid", paidCents: 5990, refundedCents: 0,
            couponStatuses: ["unused"], productName: "乙套餐", shopName: "合成门店", createdAt: new Date().toISOString() }] : [])] : [] };
    },
    async getOrder(identity: QQIdentity, orderId: string) {
      reads++; await blocked;
      if (identity.senderId !== "TEST_USER1" || !["COUPON-1001", "COUPON-2001"].includes(orderId)) throw new Error("未找到当前客户可查询的订单");
      const second = orderId === "COUPON-2001", paidCents = second ? 5990 : 7980;
      return { source: "demo-database", id: orderId, status: "paid", asOf: new Date().toISOString(),
        amounts: { totalCents: paidCents, paidCents, refundedCents: 0 },
        shop: { id: "shop-1", name: "合成门店" }, items: [{ productId: second ? "product-2" : "product-1", productName: second ? "乙套餐" : "合成套餐" }],
        coupons: [{ status: "unused" }], payments: [], refunds: [] };
    },
    async searchKnowledge(_query: string, _shopId?: string, productId?: string) {
      return productId === "product-2"
        ? [{ source: "demo-knowledge", sourceId: "KB-SECOND", title: "乙套餐规则", body: "乙套餐一张供一人，只能核销一次。", scope: { shopId: "shop-1", productId: "product-2" } }]
        : [{ source: "demo-knowledge", sourceId: "KB-STREAM", title: "测试规则", body: "本入口仅提供只读咨询。", scope: { shopId: null, productId: null } }];
    },
  } as unknown as CouponStore;
  const factory = (identity: QQIdentity) => createCouponSession(identity, store, runtime, faux.getModel());
  const catalog = createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic-stream-key" });
  const chat = new WebChatSessions(store, factory, 2000, catalog), server = createWebChatServer(chat);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
  const owners = new Map<string, string>();
  function http(path: string, body?: unknown, cookie?: string, observe?: (frame: Frame) => void) {
    const frames: Frame[] = [];
    let onHeaders!: (value: { status: number; headers: IncomingHttpHeaders }) => void;
    const headers = new Promise<{ status: number; headers: IncomingHttpHeaders }>(resolve => { onHeaders = resolve; });
    let finish!: (value: { status: number; data: any; headers: IncomingHttpHeaders }) => void, fail!: (error: unknown) => void;
    const finished = new Promise<{ status: number; data: any; headers: IncomingHttpHeaders }>((resolve, reject) => { finish = resolve; fail = reject; });
    const req = request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Chat-Request": "1" }), ...(cookie ? { Cookie: owners.has(cookie) ? `${cookie}; ${owners.get(cookie)}` : cookie } : {}),
    } }, res => {
      const cookies = res.headers["set-cookie"]?.map(value => value.split(";")[0]!) ?? [];
      if (cookies[0] && cookies[1]) owners.set(cookies[0], cookies[1]);
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
      fauxAssistantMessage(fauxToolCall("search_faq", { query: "只读咨询规则", shopId: "shop-1", productId: "product-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(finalText),
    ]);
    const streaming = http("/api/chat/messages/stream", body, client.cookie, frame => {
      if (frame.event === "delta") assert.ok(!streaming.frames.some(item => item.event === "result"), "eligible native deltas arrive before the final result");
      if (frame.event === "step" && frame.data.label === "查询订单详情" && frame.data.status === "running") reached();
    });
    await deadline(reachedTool);
    assert.equal((await streaming.headers).status, 200);
    assert.equal(streaming.frames[0]!.event, "start"); assert.equal(streaming.frames[0]!.data.replayed, false);
    assert.ok(!streaming.frames.some(frame => frame.event === "delta"), "unverified pre-tool text must never stream");
    assert.ok(!streaming.frames.some(frame => frame.event === "result"), "progress is visible while the actual tool is blocked");
    assert.equal(streaming.frames.filter(frame => frame.event === "delta").map(frame => frame.data.text).join(""), "");
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
    assert.deepEqual([...new Set(deltas.map(frame => frame.data.messageId))], ["assistant-3"]);
    assert.equal(deltas.filter(frame => frame.data.messageId === "assistant-3").map(frame => frame.data.text).join(""), finalText);
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

    // Prior FAQ/order history must not unlock this turn's unverified prose.
    for (const evidence of ["none", "order", "faq", "reread"] as const) {
      const poison = "本轮核实已退款99999元；已核销政策允许直接退款。";
      faux.setResponses([
        ...(["order", "reread"].includes(evidence) ? [fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" })] : []),
        ...(["faq", "reread"].includes(evidence) ? [fauxAssistantMessage(fauxToolCall("search_faq", { query: "只读咨询规则" }), { stopReason: "toolUse" })] : []),
        ...(evidence === "reread" ? [fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" })] : []),
        fauxAssistantMessage(poison),
      ]);
      const ungrounded = http("/api/chat/messages/stream", message(client.sessionId,
        evidence === "faq" ? "讲一下通用只读咨询规则" : "只看COUPON-1001当前状态，不需要解释政策"), client.cookie);
      await ungrounded.finished;
      assert.equal(ungrounded.frames.at(-1)!.event, "result");
      assert.ok(!ungrounded.frames.some(frame => frame.event === "delta"), "history, FAQ-only, order-only and rules before a new order cannot unlock free prose");
      assert.doesNotMatch(JSON.stringify(ungrounded.frames), /99999|政策允许|本轮核实已退款/);
      const reply = ungrounded.frames.at(-1)!.data.reply;
      if (["order", "reread"].includes(evidence)) assert.equal(reply.orders[0].paidCents, 7980);
      if (evidence === "faq") {
        assert.equal(reply.kind, "answer"); assert.match(reply.text, /尚未核对具体订单/);
        assert.match(reply.text, /测试规则\n本入口仅提供只读咨询。/);
      }
      const history = await http("/api/chat/session", undefined, client.cookie).finished;
      assert.doesNotMatch(history.data.messages.at(-1).text, /99999|政策允许|本轮核实已退款/);
    }

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

    const grounded = (orderId: string, text: string) => [
      fauxAssistantMessage(fauxToolCall("get_order", { orderId }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("search_faq", { query: "本轮套餐规则", shopId: "shop-1",
        productId: orderId === "COUPON-2001" ? "product-2" : "product-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(text),
    ];
    async function scopeTurn(client: Awaited<ReturnType<typeof create>>, text: string) {
      const response = http("/api/chat/messages/stream", message(client.sessionId, text), client.cookie);
      await deadline(response.finished); assert.equal(response.frames.at(-1)!.event, "result");
      return response;
    }
    function boundedSecond(response: Awaited<ReturnType<typeof scopeTurn>>, label: string) {
      assert.ok(!response.frames.some(frame => frame.event === "delta"), `${label}: no free prose after another order entered history`);
      const reply = response.frames.at(-1)!.data.reply;
      assert.equal(reply.kind, "order"); assert.deepEqual(reply.orders.map((order: any) => order.id), ["COUPON-2001"]);
      assert.equal(reply.orders[0].paidCents, 5990); assert.deepEqual(reply.evidenceIds, ["KB-SECOND"]);
      assert.deepEqual(reply.sources, [{ id: "KB-SECOND", title: "乙套餐规则" }], `${label}: customer view names the current rule by title`);
      assert.match(reply.text, /乙套餐一张供一人，只能核销一次。/);
      assert.doesNotMatch(JSON.stringify(response.frames), /旧甲事实|一张覆盖两人|COUPON-1001/);
    }
    const scoped = await create();
    faux.setResponses(grounded("COUPON-1001", "甲订单本轮依据完整。"));
    await scopeTurn(scoped, "请查COUPON-1001的套餐规则");
    const sameReads = reads, sameText = "同单续问重新查单后仍能原生流式答复。";
    faux.setResponses(grounded("COUPON-1001", sameText));
    const sameOrder = await scopeTurn(scoped, "刚才那单请重新核对并解释规则");
    assert.equal(reads, sameReads + 1, "same-order shorthand still rereads the order this turn");
    assert.equal(sameOrder.frames.filter(frame => frame.event === "delta").map(frame => frame.data.text).join(""), sameText);
    assert.equal(sameOrder.frames.at(-1)!.data.reply.text, sameText);
    assert.deepEqual(sameOrder.frames.at(-1)!.data.reply.sources, [{ id: "KB-STREAM", title: "测试规则" }],
      "prose that names no rule keeps the granted rule titles");
    for (const [question, poison] of [
      ["现在换成COUPON-2001，请说明这单规则", "COUPON-1001旧甲事实：一张覆盖两人。"],
      ["还是COUPON-2001这单，再解释一次规则", "旧甲事实：一张覆盖两人。"],
    ]) {
      // tokenSize=1 splits even the order ID and old fact; filtering a completed string is too late.
      faux.setResponses(grounded("COUPON-2001", poison!));
      boundedSecond(await scopeTurn(scoped, question!), "A to B and B again");
    }
    const beforeAmbiguousFollowup = faux.state.callCount;
    const unclearFollowup = await scopeTurn(scoped, "还是这单，再解释一次规则");
    assert.equal(unclearFollowup.frames.at(-1)!.data.reply.kind, "notice");
    assert.equal(faux.state.callCount, beforeAmbiguousFollowup, "multiple history orders require an explicit reference before dispatch");
    assert.ok(!unclearFollowup.frames.some(frame => frame.event === "delta"));
    const early = await create();
    faux.setResponses(grounded("COUPON-1001", "甲订单本轮依据完整。"));
    await scopeTurn(early, "请查COUPON-1001的套餐规则");
    faux.setResponses([
      ...grounded("COUPON-1001", "unused").slice(0, 2),
      fauxAssistantMessage([fauxText("旧甲事实：一张覆盖两人。"), fauxToolCall("get_order", { orderId: "COUPON-2001" })], { stopReason: "toolUse" }),
      ...grounded("COUPON-2001", "旧甲事实：一张覆盖两人。").slice(1),
    ]);
    const wrongThenRight = await scopeTurn(early, "现在只查COUPON-2001的套餐规则");
    assert.ok(!wrongThenRight.frames.some(frame => frame.event === "delta"), "old-order evidence cannot open a stream before the requested order is read");
    assert.equal(wrongThenRight.frames.at(-1)!.data.reply.kind, "notice", "mixed current-turn order evidence is clarified safely");
    assert.doesNotMatch(JSON.stringify(wrongThenRight.frames), /旧甲事实|一张覆盖两人/);

    for (const previous of ["fresh", "single-order"]) {
      const naturalList = await create();
      if (previous === "single-order") {
        faux.setResponses(grounded("COUPON-1001", "甲订单本轮依据完整。"));
        await scopeTurn(naturalList, "请查COUPON-1001的套餐规则");
      }
      listBothOrders = true;
      try {
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("list_orders", {}), { stopReason: "toolUse" }),
          fauxAssistantMessage("列表注入：已经替你退款99999元。"),
        ]);
        const beforeList: number = faux.state.callCount;
        const listing = await scopeTurn(naturalList, "能帮我找出最近三笔订单吗？");
        assert.equal(listing.frames.at(-1)!.data.origin, "agent", "natural-language listing must exercise the model tool path");
        assert.equal(faux.state.callCount, beforeList + 2);
        const reply = listing.frames.at(-1)!.data.reply;
        assert.equal(reply.kind, "order", `${previous}: successful list_orders must retain fixed selection cards`);
        assert.deepEqual(reply.orders.map((order: any) => [order.id, order.selectionText]),
          [["COUPON-1001", "选择订单 COUPON-1001"], ["COUPON-2001", "选择订单 COUPON-2001"]]);
        assert.ok(!listing.frames.some(frame => frame.event === "delta"));
        assert.doesNotMatch(JSON.stringify(listing.frames), /列表注入|退款99999/);
      } finally { listBothOrders = false; }
      faux.setResponses(grounded("COUPON-2001", "旧甲事实：一张覆盖两人。"));
      boundedSecond(await scopeTurn(naturalList, "请查COUPON-2001的套餐规则"), `${previous} model list history`);
    }
    const explicitList = await create(); listBothOrders = true;
    try {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("list_orders", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("COUPON-1001旧甲事实：实付79.80元，一张覆盖两人。"),
      ]);
      const beforeExplicitList: number = faux.state.callCount;
      const listedInstead = await scopeTurn(explicitList, "只查COUPON-2001的套餐规则");
      assert.equal(faux.state.callCount, beforeExplicitList + 2, "explicit-order request must exercise the model's list-only path");
      assert.equal(listedInstead.frames.at(-1)!.data.origin, "agent");
      assert.equal(listedInstead.frames.at(-1)!.data.reply.kind, "notice", "an explicit order request cannot be replaced by a multi-order list");
      assert.ok(!listedInstead.frames.some(frame => frame.event === "delta"));
      assert.doesNotMatch(JSON.stringify(listedInstead.frames), /COUPON-1001|paidCents|7980|79\.80|旧甲事实|一张覆盖两人/);
    } finally { listBothOrders = false; }
    const mixedList = await create(); listBothOrders = true;
    try {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("list_orders", {}), { stopReason: "toolUse" }),
        ...grounded("COUPON-2001", "COUPON-1001旧甲事实：实付79.80元，一张覆盖两人。"),
      ]);
      const beforeMixedList: number = faux.state.callCount;
      const mixed = await scopeTurn(mixedList, "只查COUPON-2001的套餐规则");
      assert.equal(faux.state.callCount, beforeMixedList + 4, "mixed list and detail evidence must exercise both successful tool reads");
      assert.equal(mixed.frames.at(-1)!.data.origin, "agent");
      assert.equal(mixed.frames.at(-1)!.data.reply.kind, "notice", "a list cannot exempt mixed current-turn order evidence from clarification");
      assert.ok(!mixed.frames.some(frame => frame.event === "delta"), "list then detail must not unlock free prose for mixed current-turn evidence");
      assert.doesNotMatch(JSON.stringify(mixed.frames), /COUPON-1001|paidCents|7980|79\.80|旧甲事实|一张覆盖两人/);
    } finally { listBothOrders = false; }
    const listedClient = await create(); listBothOrders = true;
    try {
      const listing = await scopeTurn(listedClient, "查询本人最近订单");
      assert.equal(listing.frames.at(-1)!.data.origin, "host");
      assert.equal(listing.frames.at(-1)!.data.reply.orders.length, 2);
    } finally { listBothOrders = false; }
    faux.setResponses(grounded("COUPON-2001", "旧甲事实：一张覆盖两人。"));
    boundedSecond(await scopeTurn(listedClient, "请查COUPON-2001的套餐规则"), "host multi-order list history");
    const ambiguous = await create();
    faux.setResponses(grounded("COUPON-2001", "擅自替用户选中乙订单。"));
    const multiple = await scopeTurn(ambiguous, "COUPON-1001和COUPON-2001，我要问其中一张的套餐规则");
    assert.ok(!multiple.frames.some(frame => frame.event === "delta"), "multiple explicit order IDs cannot authorize the model to choose one");
    assert.equal(multiple.frames.at(-1)!.data.reply.kind, "notice");
    assert.doesNotMatch(JSON.stringify(multiple.frames), /擅自替用户选中/);

    const timeoutChat = new WebChatSessions(store, factory, 80, catalog);
    try {
      const old = await timeoutChat.create(undefined, "demo-a"), progress: unknown[] = [];
      blocked = new Promise<void>(resolve => { release = resolve; });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" })]);
      await assert.rejects(deadline(timeoutChat.send(old.token, randomUUID(), "合成超时问题 COUPON-1001", old.session.id,
        event => { progress.push(event); })), error => error instanceof Error && Reflect.get(error, "status") === 503);
      assert.equal((await timeoutChat.get(old.token)).session, null);
      const published = progress.length, replacement = await timeoutChat.create(undefined, "demo-b");
      const replacementReply = await timeoutChat.send(replacement.token, randomUUID(), "查询到账 电子钱包", replacement.session.id);
      assert.equal(replacementReply.origin, "host");
      release(); blocked = undefined;
      await new Promise<void>(resolve => setTimeout(resolve, 15));
      assert.equal(progress.length, published, "a timed-out native turn cannot publish late progress into its old response");
      assert.equal((await timeoutChat.get(replacement.token)).messages.length, 2);
    } finally { blocked = undefined; timeoutChat.close(); }
    console.log(`网页流式检查通过：实际 HTTP / Pi faux 增量、公开步骤、私有信息过滤、跨单和多单历史范围、同单省略续問正控、最终事实卡/历史、预校验、回放、断流重试、宿主无伪增量、越权及模型失败；${faux.state.callCount} 次本地调用，0 远程/DB/QQ。`);
  } finally { chat.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkWebChatStream();
