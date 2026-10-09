import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool } from "mysql2/promise";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { createWebChatAgentFactory, createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";
import { replyFromTools } from "../src/reply-from-tools.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const planned = ["A 本人最近订单", "A 缺单退款", "A 选择后退款咨询", "A 省略订单续问", "B 本人最近订单", "B 选择后查询", "B 越权拒绝", "Pi 原生订单列表"];
const freshPlan = ["B 新缺单退款", "B 裸订单号退款咨询", "B 当前核销数量", "Pi 新订单列表问法"];
export function checkOrderChatLiveContract() {
  assert.equal(planned.length, 8);
  assert.equal(new Set(planned).size, 8);
  assert.equal(freshPlan.length, 4);
  assert.equal(new Set(freshPlan).size, 4);
}
async function run(fresh = false) {
  const plan = fresh ? freshPlan : planned;
  const limits = { turns: plan.length, providerRequests: fresh ? 12 : 24, elapsedMinutes: fresh ? 10 : 15, providerSdkRetries: 0 };
  const directory = `.runtime/business-chat-20261009${fresh ? "/fresh-v2" : ""}`;
  await mkdir(directory, { recursive: true });
  // One execution of this fixed probe; a new paid batch needs a new P0 contract.
  await (await open(`${directory}/live.attempt`, "wx")).close();
  const db = readDatabaseConfig();
  assert.ok(db.host === "127.0.0.1" && db.port === 13306 && db.database === "dave_agent" && db.user === "dave_agent_read", "Use the local synthetic read-only database");
  const store = new CouponStore(createPool(db));
  const env = { ...process.env }, factory = createWebChatAgentFactory(store, env);
  const deadline = AbortSignal.timeout(limits.elapsedMinutes * 60_000), runtimes = new WeakSet<object>(), sessions: AgentSession[] = [];
  let active = -1, requests = 0;
  const rows = plan.map(label => ({ label, status: "not-executed", text: "", events: [] as unknown[], receipt: undefined as unknown,
    firstDeltaMs: null as number | null, providerRequests: [] as { status: number | null }[], modelMessages: [] as unknown[] }));
  const files = ["src/agent.ts", "src/order-discovery.ts", "src/coupon-store.ts", "src/reply.ts", "src/reply-from-tools.ts", "src/web-chat.ts", "src/web-chat-server.ts", "src/web-chat-settings.ts", "src/cli.ts", "prompts/customer-service.md", "skills/shop-support/SKILL.md", "scripts/order-chat-live-check.ts", "package-lock.json"];
  const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  const before = await hashes();
  const result = { version: fresh ? "fresh-v2" : "entry-v1", runId: randomUUID(), startedAt: new Date().toISOString(), planned: plan.length, status: "failed", requests: 0,
    limits, databaseWrites: 0, qqSends: 0,
    sourceHashes: before, finalHashes: undefined as unknown, configuration: undefined as unknown, piRetrySettings: [] as unknown[], rows };
  const save = async () => { result.requests = requests; await writeFile(`${directory}/live-results.json`, JSON.stringify(result, null, 2)); };
  const makeAgent: typeof factory = async (...args) => {
    const session = await factory(...args); sessions.push(session);
    result.piRetrySettings.push(session.settingsManager.getRetrySettings());
    const runtime = session.modelRuntime;
    if (!runtimes.has(runtime)) {
      runtimes.add(runtime);
      const stream = runtime.streamSimple.bind(runtime);
      runtime.streamSimple = (model, context, options) => stream(model, context, { ...options, maxRetries: 0,
        fetch: async (url, init) => {
          deadline.throwIfAborted(); assert.ok(requests < limits.providerRequests, "Provider request budget exhausted"); requests++;
          const request = { status: null as number | null }; rows[active]!.providerRequests.push(request);
          const response = await fetch(url, { ...init, signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]) });
          request.status = response.status; return response;
        } });
    }
    session.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant" && active >= 0) {
        const m = event.message;
        const reported = m.usage.totalTokens > 0 && [m.usage.input, m.usage.output, m.usage.cacheRead, m.usage.cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0);
        rows[active]!.modelMessages.push({ model: m.model, provider: m.provider, stopReason: m.stopReason, reported, usage: reported ? m.usage : null });
      }
    });
    return session;
  };
  const chat = new WebChatSessions(store, makeAgent, 90_000, createWebChatSettingsCatalog(env));
  const server = createWebChatServer(chat);
  try {
    await store.ping();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    let cookie = "", sessionId = "";
    async function create(profileId: string) {
      cookie = "";
      const response = await fetch(`${origin}/api/chat/session`, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Request": "1" },
        body: JSON.stringify({ profileId, sessionId: null }), signal: deadline });
      assert.equal(response.status, 200);
      cookie = response.headers.getSetCookie().map(value => value.split(";")[0]!).join("; ");
      const body = await response.json(); sessionId = body.session.id; result.configuration = { settings: body.session.settings, model: body.session.model };
    }
    async function send(index: number, text: string) {
      active = index; const row = rows[index]!; row.status = "failed"; row.text = text;
      const started = performance.now();
      const requestId = randomUUID(), response = await fetch(`${origin}/api/chat/messages/stream`, { method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", "X-Chat-Request": "1" },
        body: JSON.stringify({ sessionId, requestId, text }), signal: deadline });
      assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.ok(response.body);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", finished = false;
      for (;;) {
        const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          assert.ok(!finished, "No events after the final receipt");
          const name = /^event: (.+)$/mu.exec(frame)?.[1], raw = /^data: (.+)$/mu.exec(frame)?.[1];
          assert.ok(name && raw);
          const data = JSON.parse(raw); assert.equal(data.sessionId, sessionId); assert.equal(data.requestId, requestId);
          if (name === "delta") {
            assert.equal(typeof data.messageId, "string"); assert.equal(typeof data.text, "string");
            row.firstDeltaMs ??= performance.now() - started;
          }
          row.events.push({ name, data }); if (name === "result") { row.receipt = data; finished = true; }
          assert.notEqual(name, "error", "SSE must finish successfully");
        }
        if (chunk.done) break;
      }
      assert.equal(buffer.trim(), "", "EOF must not leave an incomplete frame");
      assert.ok(finished && row.receipt); await save(); return row.receipt as { reply: { kind: string; text: string; orders?: { id: string; selectionText?: string }[]; evidenceIds?: string[] }; origin: string; steps: {label: string; status: string}[] };
    }
    const aIdentity = { appId: "TEST_APP", senderId: "TEST_USER1" }, bIdentity = { appId: "TEST_APP", senderId: "TEST_USER2" };
    const aOrders = await store.listOrders(aIdentity), bOrders = await store.listOrders(bIdentity);
    if (fresh) {
      await create("demo-b");
      const list = await send(0, "我想要退款"); assert.equal(list.origin, "host");
      assert.deepEqual(list.reply.orders?.map(o => o.id), bOrders.orders.map(o => o.id)); rows[0]!.status = "passed";
      const choice = list.reply.orders![0]!;
      const advisory = await send(1, choice.id); assert.equal(advisory.origin, "agent");
      assert.ok(advisory.reply.orders?.some(o => o.id === choice.id)); assert.ok(advisory.reply.evidenceIds?.length); rows[1]!.status = "passed";
      const state = await send(2, "刚刚选择的订单现在有几张券已经核销？");
      assert.ok(state.reply.orders?.some(o => o.id === choice.id));
      assert.ok(state.steps.some(step => step.label === "查询订单详情" && step.status === "done")); rows[2]!.status = "passed";
      active = 3; const row = rows[3]!; row.status = "failed"; row.text = "能帮我看看本人近期购买的券单，列出最近三笔吗？";
      const native = await makeAgent(bIdentity, randomUUID(), { modelSelection: "configured", thinkingLevel: "off", maxTokens: 2048 });
      await native.prompt(row.text, { expandPromptTemplates: false });
      const tools = native.messages.flatMap(m => m.role === "toolResult" ? [m] : []);
      assert.ok(tools.some(t => t.toolName === "list_orders" && !t.isError));
      row.receipt = replyFromTools(native.getLastAssistantText() ?? "", tools);
      const nativeReply = row.receipt as { kind: string; orders?: { id: string }[] };
      assert.equal(nativeReply.kind, "order"); assert.deepEqual(nativeReply.orders?.map(o => o.id), bOrders.orders.map(o => o.id)); row.status = "passed";
    } else {
    await create("demo-a");
    const aList = await send(0, "我有哪些订单"); assert.equal(aList.origin, "host"); assert.deepEqual(aList.reply.orders?.map(o => o.id), aOrders.orders.map(o => o.id)); rows[0]!.status = "passed";
    const refundList = await send(1, "我要退款"); assert.equal(refundList.origin, "host"); assert.ok(refundList.reply.orders?.length); rows[1]!.status = "passed";
    const choice = refundList.reply.orders![0]!; assert.ok(choice.selectionText);
    const advisory = await send(2, choice.selectionText); assert.equal(advisory.origin, "agent"); assert.ok(advisory.reply.orders?.some(o => o.id === choice.id)); assert.ok(advisory.reply.evidenceIds?.length); rows[2]!.status = "passed";
    const followup = await send(3, "这张券现在有没有核销？"); assert.equal(followup.origin, "agent"); assert.ok(followup.reply.orders?.some(o => o.id === choice.id)); rows[3]!.status = "passed";
    await create("demo-b");
    const bList = await send(4, "我有哪些订单"); assert.deepEqual(bList.reply.orders?.map(o => o.id), bOrders.orders.map(o => o.id)); rows[4]!.status = "passed";
    const bChoice = bList.reply.orders![0]!; assert.ok(bChoice.selectionText);
    const bReply = await send(5, bChoice.selectionText); assert.ok(bReply.reply.orders?.some(o => o.id === bChoice.id)); rows[5]!.status = "passed";
    const denied = await send(6, "请查询订单 COUPON-1001。"); assert.ok(!denied.reply.orders?.length); assert.match(denied.reply.text, /未找到|无法|不能|归属|权限|本人|核对/u); rows[6]!.status = "passed";
    active = 7; const row = rows[7]!; row.status = "failed"; row.text = "帮我看看最近买的三笔券单，列出订单。";
    const native = await makeAgent(aIdentity, randomUUID(), { modelSelection: "configured", thinkingLevel: "off", maxTokens: 2048 });
    await native.prompt(row.text, { expandPromptTemplates: false });
    const tools = native.messages.flatMap(m => m.role === "toolResult" ? [m] : []);
    assert.ok(tools.some(t => t.toolName === "list_orders" && !t.isError));
    row.receipt = replyFromTools(native.getLastAssistantText() ?? "", tools);
    const nativeReply = row.receipt as { kind: string; orders?: { id: string }[] };
    assert.equal(nativeReply.kind, "order"); assert.deepEqual(nativeReply.orders?.map(o => o.id), aOrders.orders.map(o => o.id)); row.status = "passed";
    }
    result.finalHashes = await hashes(); assert.deepEqual(result.finalHashes, before); result.status = "passed";
  } catch (error) {
    await save(); console.error(error instanceof Error ? error.message : "Live probe failed"); process.exitCode = 1;
  } finally {
    chat.close(); for (const session of sessions) session.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await store.close();
    await save(); console.log(JSON.stringify({ runId: result.runId, status: result.status, planned: plan.length,
      executed: rows.filter(r => r.status !== "not-executed").length, passed: rows.filter(r => r.status === "passed").length, requests }));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assert.ok(process.argv.slice(2).every(arg => ["--live", "--live-fresh"].includes(arg)) && process.argv.length <= 3, "Use no argument, --live or --live-fresh");
  checkOrderChatLiveContract();
  const fresh = process.argv.includes("--live-fresh"), plan = fresh ? freshPlan : planned;
  if (process.argv.length === 3) await run(fresh).catch(async error => {
    const directory = `.runtime/business-chat-20261009${fresh ? "/fresh-v2" : ""}`; await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/startup-failure-${randomUUID()}.json`, JSON.stringify({ status: "startup-failed", planned: plan.length,
      rows: plan.map(label => ({ label, status: "not-executed" })), reason: error instanceof Error ? error.message : "Unknown failure" }, null, 2));
    console.error(error instanceof Error ? error.message : "Live startup failed"); process.exitCode = 1;
  }); else console.log("PASS order/chat live contract: 8 planned turns; no requests without --live.");
}
