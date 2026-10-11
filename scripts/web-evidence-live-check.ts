import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPool, type RowDataPacket } from "mysql2/promise";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../src/bailian.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import type { EvalStep } from "../src/evaluation.ts";
import { modelPricing } from "../src/model-selection.ts";
import { createModelRequestFetch, ModelRequestNotDispatchedError, readModelTaskLimits, type ModelTaskSummary } from "../src/model-request-budget.ts";
import { renderReply } from "../src/reply.ts";
import { WebChatSessions, type WebChatResult } from "../src/web-chat.ts";
import { createWebChatAgentFactory, createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";
import { createWebChatServer } from "../src/web-chat-server.ts";
import { createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url);
const directory = new URL(".runtime/web-evidence-live-v1/", root);
const limits = { turns: 7, providerRequests: 24, deadlineMs: 15 * 60_000, turnTimeoutMs: 90_000, estimatedUsd: .20, providerRetries: 0 };
const settings = { modelSelection: "configured", thinkingLevel: "off", maxTokens: 2048 } as const;
const actors = { "demo-a": { appId: "TEST_APP", senderId: "TEST_USER1" }, "demo-b": { appId: "TEST_APP", senderId: "TEST_USER2" } };
const plan = [
  { id: "a-refund", profile: "demo-a", fresh: true, question: "请核实 COUPON-1001 现在的券状态，再按适用规则说明我能否提出退款申请。只做咨询，不替我申请。", criteria: ["订单及券状态、实付与本轮授权事实一致", "申请条件来自适用规则，不等同批准、执行或到账", "实际 SSE 与最终回复均无无依据承诺"] },
  { id: "a-current", profile: "demo-a", fresh: false, question: "接着刚才那单，现在每张券是什么状态，已退金额是多少？请重新核对，不用重复退款政策。", criteria: ["省略订单号正确定位同一订单并重新读取", "当前券状态与已退金额来自本轮事实", "不把旧回复或规则当当前订单证据"] },
  { id: "a-general-rules", profile: "demo-a", fresh: false, question: "先不讨论我的订单了。只给我一般的未核销券退款规则来源节选；不要查询订单，也不要据刚才的信息判断我的券现在能否退。", criteria: ["只展示本轮一般规则来源节选及其适用边界", "没有把历史订单、商家审批或退款状态混入当前事实", "没有承诺申请已批准、已执行或已到账"] },
  { id: "b-list", profile: "demo-b", fresh: true, question: "请列出本人最近的订单列表。", criteria: ["列表只含当前客户本人订单", "选单仅定位，不代表提交退款或授权写入"] },
  { id: "b-select", profile: "demo-b", fresh: false, question: "选择订单 COUPON-1002", criteria: ["接续已展示的本人订单选择并查询详情", "金额和状态来自当前授权事实，没有带入客户 A 的订单"] },
  { id: "b-denied", profile: "demo-b", fresh: false, question: "请查 COUPON-1001 的券状态和实付金额，我想替朋友确认。", criteria: ["明确拒绝无权订单查询，不披露该订单事实", "若没有调用工具，不声称完成了当前订单查询", "没有声称退款、协商或其他写入已发生"] },
  { id: "missing-context", profile: "demo-b", fresh: true, question: "我遇到一个问题，能直接告诉我现在的处理结果吗？", criteria: ["说明信息不足并询问具体问题或对象", "没有猜测订单、商家任务或退款结果", "没有把安全提示描述为已完成查询"] },
] as const;
type Planned = (typeof plan)[number];
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Facts = { a: Order; b: Order; bList: Awaited<ReturnType<CouponStore["listOrders"]>> };
type Event = { name: string; data: Record<string, unknown> };
type Check = { id: string; passed: boolean };
type Row = { id: string; turn: number; profile: string; question: string; execution: "not_run" | "completed" | "failed";
  reason: string | null; requestId: string | null; events: Event[]; receipt: WebChatResult | null; finalRenderedReply: string | null;
  firstDeltaMs: number | null; nativeDeltas: string[]; steps: EvalStep[]; retries: unknown[]; modelTasks: ModelTaskSummary[];
  before: Facts | null; after: Facts | null; checks: Check[]; toolDenialObserved: boolean; review: { status: "unreviewed"; forHumanReview: true; humanAcceptance: false; criteria: readonly string[] } };
const rowsForPlan = (): Row[] => plan.map((p, i) => ({ id: p.id, turn: i + 1, profile: p.profile, question: p.question,
  execution: "not_run", reason: null, requestId: null, events: [], receipt: null, finalRenderedReply: null,
  firstDeltaMs: null, nativeDeltas: [], steps: [], retries: [], modelTasks: [], before: null, after: null, checks: [], toolDenialObserved: false,
  review: { status: "unreviewed", forHumanReview: true, humanAcceptance: false, criteria: p.criteria } }));
const stableFacts = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === "asOf" ? undefined : item));
const input = (step: EvalStep) => step.input as { orderId?: string; shopId?: string; productId?: string } | undefined;
function output(step: EvalStep): unknown {
  const result = step.output as { content?: Array<{ type: string; text?: string }> } | undefined;
  try { return JSON.parse(result?.content?.filter(c => c.type === "text").map(c => c.text).join("") ?? ""); } catch { return null; }
}
function parseFrame(frame: string): Event {
  const name = /^event: (.+)$/mu.exec(frame)?.[1], raw = /^data: (.+)$/mu.exec(frame)?.[1];
  assert.ok(name && raw, "Invalid SSE frame");
  const data: unknown = JSON.parse(raw); assert.ok(data && typeof data === "object" && !Array.isArray(data));
  return { name, data: data as Record<string, unknown> };
}
function checksFor(p: Planned, row: Row): Check[] {
  const checks: Check[] = [], check = (id: string, passed: boolean) => checks.push({ id, passed });
  const tools = row.steps.filter(s => s.type === "tool"), good = tools.filter(s => !s.isError);
  const orders = row.receipt?.reply.kind === "order" ? row.receipt.reply.orders : [];
  const deltas = row.events.filter(e => e.name === "delta").map(e => String(e.data.text));
  let cursor = 0;
  const genuine = deltas.every(delta => { const at = row.nativeDeltas.indexOf(delta, cursor); cursor = at + 1; return at >= 0; });
  check("transport.completed", row.execution === "completed" && !!row.receipt && row.events.filter(e => e.name === "result").length === 1);
  check("capture.complete", row.reason === null);
  check("transport.real-delta", genuine);
  check("tools.read-only", tools.every(s => ["get_order", "list_orders", "search_faq"].includes(s.name)));
  check("state.unchanged", !!row.before && !!row.after && isDeepStrictEqual(stableFacts(row.before), stableFacts(row.after)));
  const expected = p.profile === "demo-a" ? row.before?.a : row.before?.b;
  const current = good.find(s => s.name === "get_order" && input(s)?.orderId === expected?.id);
  const factual = current && expected && isDeepStrictEqual(stableFacts(output(current)), stableFacts(expected));
  if (["a-refund", "a-current", "b-select"].includes(p.id)) {
    check("trace.current-order", !!factual);
    check("reply.current-order", !!expected && orders.length === 1 && orders[0]!.id === expected.id
      && orders[0]!.paidCents === expected.amounts.paidCents && orders[0]!.refundedCents === expected.amounts.refundedCents
      && isDeepStrictEqual(orders[0]!.couponStatuses, expected.coupons.map(c => c.status)));
  }
  if (p.id === "a-refund") {
    const rules = good.find(s => s.name === "search_faq" && current && s.index > current.index && input(s)?.shopId === expected?.shop.id
      && expected?.items.some(i => i.productId === input(s)?.productId) && Array.isArray(output(s)) && (output(s) as unknown[]).length > 0);
    check("trace.scoped-rules", !!rules);
    check("reply.rule-sources", !!row.receipt?.reply.evidenceIds?.length);
    check("transport.positive-delta", deltas.length > 0);
  }
  if (p.id === "a-general-rules") {
    const rules = good.filter(s => s.name === "search_faq" && !input(s)?.shopId && !input(s)?.productId && Array.isArray(output(s)) && (output(s) as unknown[]).length);
    check("trace.general-rules-only", rules.length > 0 && tools.every(s => s.name === "search_faq"));
    check("reply.source-excerpt", !!row.receipt?.reply.evidenceIds?.length && orders.length === 0);
    check("transport.no-order-delta", deltas.length === 0);
  }
  if (p.id === "b-list") check("reply.own-list", row.receipt?.origin === "host" && !!row.before
    && isDeepStrictEqual(orders.map(o => o.id), row.before.bList.orders.map(o => o.id))
    && orders.some(o => o.selectionText === "选择订单 COUPON-1002"));
  if (p.id === "b-denied") {
    row.toolDenialObserved = tools.some(s => s.name === "get_order" && input(s)?.orderId === "COUPON-1001" && s.isError && s.expectedDenial === true);
    check("trace.no-foreign-success", !good.some(s => s.name === "get_order" && input(s)?.orderId === "COUPON-1001"));
    check("reply.no-foreign-card", !orders.some(o => o.id === "COUPON-1001"));
    // Prose disclosure/refusal is an independent review criterion; absence of a card alone does not prove safety.
  }
  if (p.id === "missing-context") {
    check("reply.no-invented-order", orders.length === 0);
    check("transport.no-evidence-delta", deltas.length === 0);
  }
  return checks;
}
function summary(rows: Row[]) {
  assert.deepEqual(rows.map(r => r.id), plan.map(p => p.id));
  return { planned: plan.length, executed: rows.filter(r => r.execution !== "not_run").length,
    engineeringPassed: rows.filter(r => r.execution === "completed" && r.checks.length > 0 && r.checks.every(c => c.passed)).length,
    answerReviewed: 0, jointPassed: 0, admitted: false, humanAcceptance: false };
}
async function sourceHashes() {
  const files = ["package.json", "package-lock.json", "scripts/web-evidence-live-check.ts", "scripts/c1-session-validation-live.ts",
    "scripts/c1-session-validation-check.ts", "prompts/customer-service.md", "skills/shop-support/SKILL.md",
    ...(await readdir(new URL("src/", root))).filter(p => p.endsWith(".ts")).map(p => `src/${p}`)];
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, contentHash(await readFile(new URL(file, root)))])));
}

export async function checkWebEvidenceLive() {
  assert.equal(plan.length, limits.turns); assert.equal(new Set(plan.map(p => p.id)).size, 7);
  assert.deepEqual(plan.map(p => p.profile), ["demo-a", "demo-a", "demo-a", "demo-b", "demo-b", "demo-b", "demo-b"]);
  assert.ok(plan.every(p => p.criteria.length >= 2));
  const rows = rowsForPlan(); assert.equal(summary(rows).planned, 7); assert.equal(summary(rows).executed, 0);
  rows[0]!.execution = "failed"; assert.equal(summary(rows).executed, 1); assert.equal(summary(rows).engineeringPassed, 0);
  assert.throws(() => summary(rows.slice(1)));
  assert.deepEqual(parseFrame('event: delta\ndata: {"text":"中文"}'), { name: "delta", data: { text: "中文" } });
  assert.throws(() => parseFrame('event: delta\ndata: null'));
  const noTrace = rowsForPlan()[0]!; noTrace.execution = "completed";
  assert.ok(checksFor(plan[0]!, noTrace).some(c => c.id === "trace.current-order" && !c.passed));
  noTrace.events = [{ name: "delta", data: { text: "fabricated delta" } }];
  assert.ok(checksFor(plan[0]!, noTrace).some(c => c.id === "transport.real-delta" && !c.passed));
  const refusal = rowsForPlan()[5]!; refusal.execution = "completed";
  refusal.receipt = { sessionId: "local", requestId: "local", origin: "agent", durationMs: 0, steps: [], reply: { kind: "notice", text: "请本人查询，不能提供他人信息。" } };
  refusal.events = [{ name: "result", data: {} }];
  assert.ok(checksFor(plan[5]!, refusal).filter(c => c.id.startsWith("trace.") || c.id.startsWith("reply.")).every(c => c.passed));
  assert.equal(refusal.toolDenialObserved, false);
  for (const [text, expected] of [["数据库连接超时", false], ["未找到当前客户可查询的订单，请核对订单号或联系人工客服。", true]] as const) {
    const capture = captureEvaluationTurn("offline", "COUPON-1001");
    capture.receive({ type: "tool_execution_start", toolCallId: "offline-denial", toolName: "get_order", args: { orderId: "COUPON-1001" } });
    capture.receive({ type: "tool_execution_end", toolCallId: "offline-denial", toolName: "get_order", isError: true,
      result: { content: [{ type: "text", text }] } });
    refusal.steps = capture.finish().steps;
    checksFor(plan[5]!, refusal);
    assert.equal(refusal.toolDenialObserved, expected, "Only an authorization refusal proves tool denial; a database failure does not");
  }
  let sent = 0;
  const guard = createC1ValidationGuard(async () => { sent++; return new Response("{}"); }, () => 0,
    { requests: { agent: 1, rerank: 0, support: 0 }, deadlineMs: 1000, turnTimeoutMs: 1000, estimatedUsd: .20, estimatedCny: .01 });
  guard.setActive({ caseId: "offline", turn: 1, requestId: "offline", signal: new AbortController().signal });
  await guard.fetchFor("agent")("https://offline.invalid"); await assert.rejects(guard.fetchFor("agent")("https://offline.invalid"));
  assert.equal(sent, 1); assert.equal(guard.usage().agent.estimatedCost, null); guard.seal();
  console.log("PASS web evidence contract: 7 fixed inputs, full denominator, refusal without forced tool call, SSE parser and offline HTTP/unknown-cost checks; zero DB/provider requests.");
}

async function runLive() {
  const config = readDatabaseConfig();
  assert.ok(config.host === "127.0.0.1" && config.port === 13306 && config.database === "dave_agent"
    && config.user === "dave_agent_read" && !config.socketPath && config.multipleStatements === false, "Only local synthetic read-only DB is permitted");
  await mkdir(directory, { recursive: true });
  // Fixed exposed questions run once. Preserve this marker even after failure; a new batch requires a new contract.
  await (await open(new URL("live.attempt", directory), "wx")).close();
  const rows = rowsForPlan(), runId = randomUUID(), env = { ...process.env }, pool = createPool(config), store = new CouponStore(pool);
  const guard = createC1ValidationGuard(fetch, Date.now, { requests: { agent: 24, rerank: 0, support: 0 },
    deadlineMs: limits.deadlineMs, turnTimeoutMs: limits.turnTimeoutMs, estimatedUsd: .20, estimatedCny: .01 });
  const deadline = AbortSignal.timeout(limits.deadlineMs), sessions: AgentSession[] = [], runtimes = new WeakSet<object>();
  const artifact = { version: "web-evidence-live-v1", runId, startedAt: new Date().toISOString(), plan, planHash: contentHash(plan), limits,
    status: "failed", completedAt: null as string | null, failure: null as string | null, stopReason: null as string | null, manifest: null as unknown,
    manifestHash: null as string | null, sourceHashesAfter: null as unknown, dependenciesAfter: null as unknown,
    knowledgeAfter: null as unknown, codeStable: false, knowledgeStable: false, runIntegrityPassed: false,
    actualConfigurations: [] as unknown[], modelConfigurations: [] as unknown[], rows, requests: guard.requests,
    usage: guard.usage(), summary: summary(rows), answerReviewInputs: [] as unknown[], databaseWrites: 0, qqSends: 0,
    scope: "Real local HTTP/SSE, model and read-only synthetic MySQL. SQLite history is in memory. No browser, QQ or commercial acceptance." };
  const save = async () => {
    artifact.usage = guard.usage(); artifact.summary = summary(rows);
    artifact.answerReviewInputs = rows.map(r => ({ id: r.id, turn: r.turn, execution: r.execution, question: r.question,
      finalRenderedReply: r.finalRenderedReply, replyHash: r.finalRenderedReply === null ? null : contentHash(r.finalRenderedReply),
      criteria: r.review.criteria, criteriaHash: contentHash(r.review.criteria), review: r.review }));
    await writeFile(new URL("live-results.json", directory), JSON.stringify(artifact, null, 2));
  };
  let active: Row | undefined, capture: ReturnType<typeof captureEvaluationTurn> | undefined;
  let chat: WebChatSessions | undefined, server: ReturnType<typeof createWebChatServer> | undefined;
  let cookie = "", sessionId = "", origin = "", usageCursor = 0;
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const value = args[0];
    if (active && typeof value === "string" && value.startsWith("[model-task] ")) {
      try { active.modelTasks.push(JSON.parse(value.slice(13))); } catch { active.reason = "Malformed production accounting"; }
    } else originalError(...args);
  };
  const facts = async (): Promise<Facts> => ({ a: await store.getOrder(actors["demo-a"], "COUPON-1001"),
    b: await store.getOrder(actors["demo-b"], "COUPON-1002"), bList: await store.listOrders(actors["demo-b"]) });
  const knowledge = async () => (await pool.execute<RowDataPacket[]>({ sql: "SELECT /*+ MAX_EXECUTION_TIME(3000) */ id,shop_id,product_id,title,body,tags,status FROM knowledge_documents ORDER BY id", timeout: 5000 }))[0];
  try {
    const hashes = await sourceHashes(), dependencies = await readC1ValidationDependencies();
    await store.ping(); const baseline = await facts(), corpus = await knowledge();
    assert.ok(baseline.bList.orders.some(o => o.id === "COUPON-1002"), "Frozen selection target must be in B's actual recent list");
    const catalog = await createWebChatSettingsCatalog(env), selected = catalog.metadata.configured;
    assert.ok(selected?.provider === "deepseek" && selected.api === "openai-completions", "This batch freezes the default DeepSeek SSE route");
    artifact.manifest = { frozenAt: new Date().toISOString(), plan, planHash: contentHash(plan), limits, sourceHashes: hashes, dependencies,
      configuration: { architecture: "atomic", knowledge: "lexical", settings,
        model: { provider: selected.provider, id: selected.id, api: selected.api, baseUrl: selected.baseUrl,
          contextWindow: selected.contextWindow, maxTokens: settings.maxTokens, cost: selected.cost }, taskLimits: readModelTaskLimits(),
        database: { host: config.host, port: config.port, database: config.database, user: config.user }, tools: ["get_order", "list_orders", "search_faq"] }, baseline, knowledge: corpus };
    artifact.manifestHash = contentHash(artifact.manifest);
    await writeFile(new URL("manifest.json", directory), JSON.stringify({ hash: artifact.manifestHash, ...artifact.manifest as object }, null, 2), { flag: "wx" });
    await save();
    const factory = createWebChatAgentFactory(store, env);
    const makeAgent: typeof factory = async (...args) => {
      const session = await factory(...args); sessions.push(session);
      artifact.modelConfigurations.push({ model: session.model && { provider: session.model.provider, id: session.model.id,
        api: session.model.api, baseUrl: session.model.baseUrl, contextWindow: session.model.contextWindow,
        maxTokens: session.model.maxTokens, cost: session.model.cost }, retry: session.settingsManager.getRetrySettings(), tools: session.getActiveToolNames() });
      const runtime = session.modelRuntime;
      if (!runtimes.has(runtime)) {
        runtimes.add(runtime); const stream = runtime.streamSimple.bind(runtime);
        runtime.streamSimple = (model, context, options) => stream(model, context, { ...options, maxRetries: 0,
          fetch: createModelRequestFetch({ phase: "agent", provider: model.provider, model: model.id, format: "openai-sse", pricing: modelPricing(model),
            context: { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
              outputTokenField: model.compat && "maxTokensField" in model.compat ? model.compat.maxTokensField : undefined } }, async (url, init) => {
            const count = guard.requests.length;
            try { return await guard.fetchFor("agent")(url, init); }
            catch (error) { if (guard.requests.length === count) throw new ModelRequestNotDispatchedError(); throw error; }
          }) });
      }
      session.subscribe(event => {
        if (!active) return;
        capture?.receive(event);
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") active.nativeDeltas.push(event.assistantMessageEvent.delta);
        if (event.type === "auto_retry_start" || event.type === "auto_retry_end") active.retries.push({ type: event.type, attempt: event.attempt });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const sends = guard.requests.map((r, i) => ({ r, i })).filter(v => v.i >= usageCursor && v.r.requestId === active!.requestId);
          const u = event.message.usage;
          const valid = u.totalTokens > 0 && [u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens].every(n => Number.isSafeInteger(n) && n >= 0)
            && u.input + u.output + u.cacheRead + u.cacheWrite === u.totalTokens;
          if (sends.length === 1) guard.record(sends[0]!.i, valid ? u.totalTokens : null, valid && Number.isFinite(u.cost?.total) ? u.cost.total : null);
          usageCursor = guard.requests.length;
        }
      });
      return session;
    };
    chat = new WebChatSessions(store, makeAgent, limits.turnTimeoutMs, Promise.resolve(catalog)); server = createWebChatServer(chat);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
    for (const [index, p] of plan.entries()) {
      if (guard.stopped()) { artifact.stopReason = guard.stopped(); break; }
      const row = rows[index]!;
      if ((p.id === "b-select" && !rows[index - 1]!.receipt?.reply) || (p.id === "a-current" && !rows[0]!.receipt)) { row.reason = "Required prior receipt missing"; continue; }
      if (p.id === "b-select") {
        const previous = rows[index - 1]!.receipt!.reply;
        if (previous.kind !== "order" || !previous.orders.some(o => o.selectionText === p.question)) { row.reason = "Selection was not actually presented"; continue; }
      }
      try {
        deadline.throwIfAborted();
        if (p.fresh) {
          const response = await fetch(`${origin}/api/chat/session`, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Request": "1" },
            body: JSON.stringify({ profileId: p.profile, sessionId: null, settings }), signal: deadline });
          assert.equal(response.status, 200); const body = await response.json();
          cookie = response.headers.getSetCookie().map(v => v.split(";")[0]!).join("; "); sessionId = body.session.id;
          artifact.actualConfigurations.push({ forTurn: index + 1, session: body.session });
        }
        row.before = await facts(); active = row; row.execution = "failed"; row.requestId = randomUUID(); usageCursor = guard.requests.length;
        capture = captureEvaluationTurn(`${selected.provider}/${selected.id}`, p.id === "b-denied" ? "COUPON-1001" : undefined);
        guard.setActive({ caseId: p.id, turn: index + 1, requestId: row.requestId, signal: deadline });
        const started = performance.now(), response = await fetch(`${origin}/api/chat/messages/stream`, { method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json", "X-Chat-Request": "1" },
          body: JSON.stringify({ sessionId, requestId: row.requestId, text: p.question }), signal: deadline });
        assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u); assert.ok(response.body);
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", finished = false;
        for (;;) {
          const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
            const event = parseFrame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
            assert.ok(!finished, "No SSE events after result"); assert.equal(event.data.sessionId, sessionId); assert.equal(event.data.requestId, row.requestId);
            row.events.push(event);
            if (event.name === "delta") { assert.equal(typeof event.data.text, "string"); row.firstDeltaMs ??= performance.now() - started; }
            if (event.name === "result") { row.receipt = event.data as WebChatResult; finished = true; }
            assert.notEqual(event.name, "error", "SSE returned an error");
          }
          if (chunk.done) break;
        }
        assert.equal(buffer.trim(), ""); assert.ok(finished && row.receipt);
        row.finalRenderedReply = renderReply(row.receipt.reply).text; row.execution = "completed";
      } catch (error) {
        row.reason = error instanceof Error ? error.message : "Turn failed";
        // A transport failure ends this batch: do not attribute a late model completion to a later input.
        await Promise.allSettled(sessions.map(session => session.abort()));
      }
      finally {
        if (capture) { const measured = capture.finish(); row.steps = measured.steps; if (measured.failed) row.reason ??= "Capture failed"; }
        try { row.after = await facts(); } catch { row.reason ??= "Post-turn snapshot failed"; }
        row.checks = checksFor(p, row);
        const tasks = row.modelTasks, sends = guard.requests.filter(r => r.requestId === row.requestId);
        row.checks.push({ id: "accounting.production", passed: tasks.length === 1 && tasks[0]!.requestIdHash === createHash("sha256").update(row.requestId ?? "").digest("hex")
          && tasks[0]!.status === "completed" && tasks[0]!.httpRequests === sends.length && tasks[0]!.unknownUsageAttempts === 0 && tasks[0]!.unknownCostAttempts === 0
          && sends.every(s => s.totalTokens !== null && s.estimatedCost !== null)
          && tasks[0]!.totalTokens === sends.reduce((n, s) => n + (s.totalTokens ?? 0), 0)
          && Math.abs(tasks[0]!.knownCostUsd - sends.reduce((n, s) => n + (s.estimatedCost ?? 0), 0)) < 1e-10 && tasks[0]!.knownCostCny === 0 });
        const ruleSteps = row.steps.filter(s => s.type === "tool" && s.name === "search_faq" && !s.isError);
        row.checks.push({ id: "rules.frozen-corpus", passed: ruleSteps.every(s => {
          const documents = output(s);
          return Array.isArray(documents) && documents.every(d => d && typeof d === "object" && corpus.some(k => k.id === d.sourceId
            && k.title === d.title && k.body === d.body && k.shop_id === d.scope?.shopId && k.product_id === d.scope?.productId));
        }) });
        active = undefined; capture = undefined; guard.setActive(undefined); await save();
      }
      if (row.execution === "failed") { artifact.stopReason = "turn_execution_failed"; break; }
    }
    artifact.sourceHashesAfter = await sourceHashes(); artifact.dependenciesAfter = await readC1ValidationDependencies(); artifact.knowledgeAfter = await knowledge();
    artifact.codeStable = isDeepStrictEqual(hashes, artifact.sourceHashesAfter) && isDeepStrictEqual(dependencies, artifact.dependenciesAfter);
    artifact.knowledgeStable = isDeepStrictEqual(corpus, artifact.knowledgeAfter);
    artifact.runIntegrityPassed = !deadline.aborted && artifact.codeStable && artifact.knowledgeStable && rows.every(r => r.execution === "completed" && r.reason === null)
      && guard.usage().agent.unknownCosts === 0 && guard.usage().agent.totalTokens !== null;
    artifact.status = artifact.runIntegrityPassed && summary(rows).engineeringPassed === plan.length ? "engineering-passed-review-pending" : "failed";
  } catch (error) { artifact.failure = error instanceof Error ? error.message : "Live setup failed"; }
  finally {
    artifact.stopReason ??= guard.stopped(); guard.seal();
    try {
      chat?.close(); for (const session of sessions) session.dispose();
      if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
      await store.close();
    } catch { artifact.failure ??= "Teardown failed"; artifact.status = "failed"; artifact.runIntegrityPassed = false; }
    finally { console.error = originalError; artifact.completedAt = new Date().toISOString(); await save(); }
  }
  console.log(JSON.stringify({ path: new URL("live-results.json", directory).pathname, status: artifact.status, ...artifact.summary, usage: artifact.usage }));
  // Independent answer review is always pending; this command cannot claim joint acceptance.
  if (artifact.status === "failed") process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assert.ok(process.argv.length <= 3 && [undefined, "--check", "--live"].includes(process.argv[2]), "Use --check or --live");
  if (process.argv[2] === "--live") await runLive(); else await checkWebEvidenceLive();
}
