import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createPool, type RowDataPacket } from "mysql2/promise";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createCouponSession } from "../src/agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply, merchantSourceKey } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalCase, type EvalCheck, type EvalRun, type EvalSnapshot, type EvalTurn } from "../src/evaluation.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import type { RenderedReply } from "../src/reply.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

// Real model, MySQL and production dispatcher; only outbound QQ sends are replaced.
type Session = Awaited<ReturnType<typeof createCouponSession>>;
type ToolResult = Extract<Session["messages"][number], { role: "toolResult" }>;
type Receipt = { text: string; rendered: RenderedReply; target: ReplyTarget; requesterId: string };
type Context = Receipt & {
  trace: ToolResult[]; steps: EvalTurn["steps"]; refundIds: string[]; hostCalls: number; duplicateSuppressed: boolean; notificationStatus?: string;
  toolsRestored: boolean; order: Awaited<ReturnType<CouponStore["getOrder"]>>;
  task: Awaited<ReturnType<AfterSalesStore["getTask"]>>; operation: Awaited<ReturnType<RefundStore["get"]>>;
};
type Check = Omit<EvalCheck, "status" | "reason"> & { test: (context: Context) => boolean };
type Round = { question: string; mode: "model" | "host" | "event"; checks: Check[]; before?: () => Promise<void>;
  confirmation?: "current" | "expired"; captureOperation?: "initial" | "renewal";
  purpose?: "pending-faq" | "expired-query" | "restart" };
const examples = [
  { id: "approved-notification", name: "等待中咨询、商家同意通知、方案过期恢复及重启查询", outcome: "approve", status: "approved", turns: 13 },
  { id: "rejected-notification", name: "商家拒绝通知后阻止退款", outcome: "reject", status: "rejected", turns: 4 },
  { id: "timed-out-notification", name: "商家超时通知后阻止退款", outcome: "timeout", status: "timed_out", turns: 4 },
] as const;
const command = promisify(execFile);
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const check = (id: string, category: EvalCheck["category"], name: string, test: Check["test"]): Check => ({ id, category, name, test });
const used = (trace: ToolResult[], name: string) => trace.some(result => result.toolName === name && !result.isError);

// Bounded wording check for this one FAQ, not a general semantic or factuality judge.
function answersLunchPartySize(text: string) {
  const sentences = text.replace(/[*`]/g, "").split(/[。！？；\n]/u);
  const singleCoupon = /(?:(?:一|每|每一|1)张(?:双人午餐团购|双人午餐|午餐|团购)?券|(?:双人午餐团购|双人午餐|午餐|团购)?券(?:一|每|每一|1)张)/u;
  const twoPeople = new RegExp(`${singleCoupon.source}(?:可以|可|仅|只)?(?:对应|供|适用于?)(?:的是|为)?(?:两|2)\\s*(?:人|位)`, "u");
  const uncertain = /不是|并非|不能|不适用|无法|不确定|尚未|未知|未录入|不清楚|可能|假如|如果/u;
  return text.includes("KB-PRODUCT-LUNCH")
    && sentences.some(sentence => twoPeople.test(sentence) && !uncertain.test(sentence))
    && !sentences.some(sentence => (singleCoupon.test(sentence) || /人数/u.test(sentence))
      && (/(?:人数|两人|2\s*人)/u.test(sentence) && uncertain.test(sentence)
        || /(?:只能|仅限|只供|仅供)(?:一|1)\s*人/u.test(sentence)));
}

function checkPendingFaqAssertions() {
  const examples: Array<[string, boolean]> = [
    ["一张券对应两人午餐套餐，核销一次即视为整张券已使用（规则来源：KB-PRODUCT-LUNCH）。", true],
    ["依据 KB-PRODUCT-LUNCH：双人午餐团购券一张对应两人午餐套餐，核销一次即视为整张券已使用。", true],
    ["每张券可供2人用餐。依据：KB-PRODUCT-LUNCH。", true],
    ["一张午餐券适用于两人。菜品及过敏原未录入，无法确认。依据：KB-PRODUCT-LUNCH。", true],
    ["根据 KB-PRODUCT-LUNCH，这张券只能一人用，不是两人。", false],
    ["这是双人午餐套餐，但目前无法确认每张券人数。依据 KB-PRODUCT-LUNCH。", false],
    ["一张券不是对应两人。依据 KB-PRODUCT-LUNCH。", false],
    ["如果一张券对应两人，就可以一起用餐。依据 KB-PRODUCT-LUNCH。", false],
    ["一张券对应两人，但具体人数尚未确认。依据 KB-PRODUCT-LUNCH。", false],
    ["一张券对应两人。实际每张券只能一人用。依据 KB-PRODUCT-LUNCH。", false],
    ["双人午餐团购券。依据 KB-PRODUCT-LUNCH。", false],
    ["一张券对应两人午餐套餐。", false],
  ];
  for (const [text, expected] of examples) assert.equal(answersLunchPartySize(text), expected, text);
  return examples.length;
}

const data = (trace: ToolResult[], name: string) => {
  const result = trace.findLast(item => item.toolName === name && !item.isError);
  return result ? JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join("")) : undefined;
};
function questions(example: typeof examples[number], orderId: string): Pick<Round, "question" | "mode" | "confirmation" | "purpose">[] {
  return [
    { question: `订单 ${orderId} 因行程变化想退款，请帮我联系商家协商，原因就写“行程变化”。`, mode: "model" },
    { question: `确认联系商家 ${orderId} 原因：行程变化`, mode: "host" },
    ...(example.outcome === "approve" ? [{ question: "商家处理期间我先问个套餐问题：请查一下这张午餐券，一张对应几个人用餐？",
      mode: "model" as const, purpose: "pending-faq" as const }] : []),
    { question: `[商家结果事件] ${orderId} → ${example.status}`, mode: "event" },
    { question: "那就帮我退款", mode: "model" },
    ...(example.outcome === "approve" ? [
      { question: "钱退了吗", mode: "model" as const },
      { question: "钱退了吗", mode: "model" as const, purpose: "expired-query" as const },
      { question: "方案已过期，请重新生成退款方案", mode: "model" as const },
      { question: "确认退款 <已过期的旧 operationId>", mode: "host" as const, confirmation: "expired" as const },
      { question: "确认退款 <重新展示的新 operationId>", mode: "host" as const, confirmation: "current" as const },
      { question: "确认退款 <同一新 operationId>", mode: "host" as const, confirmation: "current" as const },
      { question: "钱退了吗", mode: "model" as const },
      { question: `请查询 ${orderId} 的退款结果和订单金额，确认是否已经完成模拟退款。`, mode: "model" as const, purpose: "restart" as const },
    ] : []),
  ];
}

function label() {
  const args = process.argv.slice(2);
  if (!args.length) return "D2/D3 商家通知至模拟退款完整闭环";
  if (args.length !== 2 || args[0] !== "--label" || !args[1]?.trim() || args[1].trim().length > 120) {
    throw new Error("用法：npm run check:notification-model -- --label '本次评测名称'（最多 120 字）。");
  }
  return args[1].trim();
}

function inbound(content: string, senderId: string, groupOpenid: string): QQBotInboundMessage {
  const id = randomUUID(), timestamp = new Date().toISOString();
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId, groupOpenid, messageId: id, content, timestamp,
    replyTarget: { scope: "group", targetId: groupOpenid, msgId: id },
    raw: { id, content, timestamp, group_openid: groupOpenid, author: { member_openid: senderId } } };
}

async function snapshot(session: Session, fixture: Awaited<ReturnType<typeof createMerchantFixture>>, store: CouponStore): Promise<EvalSnapshot> {
  const paths = ["src/agent.ts", "src/coupon-store.ts", "src/knowledge-retrieval.ts", "src/after-sales.ts", "src/after-sales-entry.ts", "src/refunds.ts", "src/refund-entry.ts",
    "src/merchant-notifications.ts", "src/qq-agent.ts", "src/qq.ts", "src/qq-reply.ts", "src/reply.ts", "src/reply-from-tools.ts", "src/eval-capture.ts",
    "db/06-refunds.sql", "db/07-merchant-notifications.sql", "scripts/merchant-notification-model-check.ts", "scripts/merchant-test-fixture.ts", "package-lock.json"];
  const [prompt, skill, git, changes, files, orders, knowledge] = await Promise.all([
    readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
    command("git", ["rev-parse", "HEAD"]), command("git", ["status", "--porcelain", "--untracked-files=normal"]),
    Promise.all(paths.map(async path => [path, hash(await readFile(new URL(`../${path}`, import.meta.url), "utf8"))] as const)),
    Promise.all(fixture.orders.map(id => store.getOrder(fixture.identity, id))),
    Promise.all([store.searchKnowledge("退款 未核销 商家 协商", "shop-demo-1", "product-demo-1"),
      store.searchKnowledge("午餐 套餐 两人", "shop-demo-1", "product-demo-1")])
      .then(groups => [...new Map(groups.flat().map(rule => [rule.sourceId, rule])).values()]),
  ]);
  const business = orders.map(({ asOf, createdAt: _createdAt, paidAt: _paidAt, ...order }, index) => {
    const facts = { ...order,
      coupons: order.coupons.map(({ expiresAt, ...coupon }) => ({ ...coupon, valid: Boolean(expiresAt && Date.parse(expiresAt) > Date.parse(asOf)) })),
      payments: order.payments.map(({ paidAt: _paidAt, ...payment }) => payment),
    };
    return { outcome: examples[index]!.outcome, order: JSON.parse(JSON.stringify(facts).replaceAll(order.id, examples[index]!.id)
      .replace(/mcheck-[a-f0-9]{20}-(item|coupon|payment)-\d{4}/g, "fixture-$1")) };
  });
  const active = new Set(session.getActiveToolNames());
  const tools = session.getAllTools().filter(tool => active.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description,
    parameters: tool.parameters, promptGuidelines: tool.promptGuidelines, exposure: tool.exposure }));
  const dataset = examples.map(item => {
    const rounds = questions(item, "<本场景订单号>");
    return { ...item, rounds: rounds.map(round => ({ ...round,
      ...(round.purpose === "expired-query" ? { before: "仅本次合成方案的 created_at/expires_at/presented_at 同步前移16分钟，保持时间顺序，模拟方案自然到期" } : {}),
      ...(round.purpose === "restart" ? { before: "重建 Agent、Session 和业务数据库连接" } : {}) })) };
  });
  if (!session.model) throw new Error("评测模型未配置。");
  return { gitCommit: git.stdout.trim(), gitDirty: Boolean(changes.stdout.trim()), asOf: new Date().toISOString(),
    model: { provider: session.model.provider, id: session.model.id, maxTokens: session.model.maxTokens, thinking: session.thinkingLevel, temperature: null },
    hashes: { prompt: hash(prompt), skill: hash(skill), tools: hash(tools), dataset: hash(dataset),
      checker: hash(files.filter(([path]) => path === "scripts/merchant-notification-model-check.ts" || path === "src/eval-capture.ts")),
      business: hash({ business, knowledge }) },
    content: { prompt, skill, effectiveSystemPrompt: `${prompt.trim()}\n\n${skill.trim()}`, tools, dataset,
      business: { scenarios: business, knowledge }, initialOrders: orders,
      businessNormalization: "随机订单/券编号归一化，创建和付款时刻省略，券有效期按采集时是否有效比较；保留实际初始订单及 fixture 源码哈希。",
      implementation: { hash: hash(files), files: Object.fromEntries(files) },
      settings: { timeoutMs: 60_000, compaction: false, retries: 2, mockMerchantDelayMs: 5000,
        caseRouting: "每案例独立合成群路由和sourceKey；切换前关闭原Agent，再创建当前案例Session，避免前例未完成通知进入后例",
        merchantResult: "模型事件前通过真实 store.applyResult 写入同意/拒绝；timeout 场景仅将本次临时任务 deadline 推到当前时间后调用 store.processDue",
        refundExpiry: "过期查询前仅同步前移合成方案的创建、有效期及已有展示时间16分钟，不改系统时钟、订单、券、商家批准或退款记录" },
      measurement: "真实模型 + MySQL + QQAgent + 正式通知 dispatcher；仅 QQ 发送替换为本地函数，不代表平台送达。21 个处理轮次含 18 次用户发言和 3 次宿主业务事件，其中6轮宿主精确确认。首字与 usage 取自真实模型流，宿主确认轮为空。耗时不含事件前终态准备、fixture过期准备或重启准备，费用按 SDK 目录估算。",
      scope: "三种商家终态都续接正常 prompt、固定原 task/order 通知，事件不代替用户授权。同意场景先在原协商仍pending时咨询套餐人数，六项工具保持启用，只查适用规则不创建业务动作。通知后同一会话省略订单请求退款：同意场景展示方案，在待确认、过期及成功状态下省略订单询问钱退了吗，均须重新调用 get_refund。过期只读查询不得生成新方案；用户明确要求重建时重新取证并生成新编号，旧编号宿主拒绝，新编号精确确认执行模拟退款、重复确认幂等、新 Agent 和数据库连接查询同一退款。拒绝和超时场景不准备或执行退款。发送前 prepared、回复窗口、并发、串用户与网络失败另有工程检查。" } };
}

async function main() {
  const runLabel = label();
  const { modelRuntime, model } = await createConfiguredModelRuntime();
  const fixture = await createMerchantFixture(examples.map(item => item.outcome), { delayMs: 5000 });
  const history = new EvalStore(createPool(readEvalDatabaseConfig()));
  let orderPool = createPool(readDatabaseConfig());
  let store = new CouponStore(orderPool);
  let merchantPool = createPool(readAfterSalesDatabaseConfig());
  let merchant = new AfterSalesStore(merchantPool);
  let refunds = new RefundStore(createPool(readRefundDatabaseConfig()));
  const { identity } = fixture;
  const groupPrefix = `notification-model-${randomUUID()}`;
  let groupOpenid = `${groupPrefix}-${examples[0].id}`;
  let sourceKey = merchantSourceKey(identity, groupOpenid);
  const receipts: Receipt[] = [], cases: EvalCase[] = [];
  let session: Session | undefined, agent: QQAgent | undefined;
  let capture: ReturnType<typeof captureEvaluationTurn> | undefined;
  let hostCalls = 0, run: EvalRun | undefined, finished = false;
  let lastContext: Context | undefined;

  async function createSession() {
    session = await createCouponSession(identity, store, modelRuntime, model, { store: merchant, sourceKey, refunds });
    session.subscribe(event => capture?.receive(event));
    return session;
  }
  function createAgent() {
    return new QQAgent(async () => session ?? await createSession(), async (target, text, rendered, requesterId) => { receipts.push({ target, text, rendered, requesterId }); },
      () => {}, 60_000, async msg => {
        hostCalls++;
        return await confirmRefundReply(refunds, identity, sourceKey, msg.content)
          ?? await confirmMerchantReply(merchant, identity, sourceKey, msg.content, { groupOpenid, messageId: msg.messageId, timestamp: msg.timestamp });
      }, (_msg, reply) => markRefundReplyPresented(refunds, identity, sourceKey, reply));
  }
  async function restart() {
    await agent?.close();
    session = undefined;
    await Promise.all([store.close(), merchant.close(), refunds.close()]);
    orderPool = createPool(readDatabaseConfig());
    store = new CouponStore(orderPool);
    merchantPool = createPool(readAfterSalesDatabaseConfig());
    merchant = new AfterSalesStore(merchantPool);
    refunds = new RefundStore(createPool(readRefundDatabaseConfig()));
    await createSession();
    agent = createAgent();
  }
  function skipped(round: Round, index: number, reason: string): EvalTurn {
    return { index, question: round.question, reply: "", status: "skipped", startedAt: new Date().toISOString(), durationMs: null,
      firstTextMs: null, evidenceIds: [], steps: [], error: reason,
      checks: [{ id: "execution.completed", category: "execution", name: "本轮 handler 完成", status: "skipped", reason },
        { id: "execution.tools", category: "execution", name: "工具执行无错误", status: "skipped", reason },
        { id: "execution.route", category: "execution", name: round.mode === "host" ? "精确确认未调用模型" : "实际调用模型并正常结束", status: "skipped", reason },
        ...round.checks.map(({ test: _test, ...item }) => ({ ...item, status: "skipped" as const, reason }))] };
  }
  async function evaluate(round: Round, index: number, orderId: string): Promise<EvalTurn> {
    lastContext = undefined;
    try { await round.before?.(); }
    catch {
      const turn = skipped(round, index, "轮前 fixture 或重启准备失败，本轮未调用模型。");
      turn.status = "failed";
      turn.checks[0] = { ...turn.checks[0]!, status: "failed" };
      return turn;
    }
    if (round.mode === "event") {
      // The ordinary worker uses these same durable transitions; the event payload cannot supply a result.
      try {
        const example = examples[fixture.orders.indexOf(orderId)]!;
        if (example.outcome === "timeout") { await fixture.expire(orderId); await merchant.processDue(); }
        else {
          const task = await merchant.getTask(identity, sourceKey, orderId);
          if (!task || !await merchant.applyResult({ taskId: task.taskId, orderId, status: example.status,
            approvedAmountCents: example.outcome === "approve" ? task.amountCents : null })) throw new Error("模拟商家结果未登记。");
        }
        if ((await merchant.getTask(identity, sourceKey, orderId))?.status !== example.status) throw new Error("模拟商家终态未完成。");
      } catch {
        const turn = skipped(round, index, "事件前持久化业务终态准备失败，本轮未调用模型。");
        turn.status = "failed";
        turn.checks[0] = { ...turn.checks[0]!, status: "failed" };
        return turn;
      }
    }
    const startedAt = new Date().toISOString(), previous = session?.messages.length ?? 0;
    const replyCount = receipts.length, hostCount = hostCalls, toolsBefore = session!.getActiveToolNames().slice().sort();
    capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
    let context: Context | undefined, failure: string | undefined, duplicateSuppressed = false;
    try {
      if (round.mode === "event") {
        await dispatchMerchantNotifications(merchant, agent!, identity.appId, [groupOpenid]);
        const messageCount = session!.messages.length, sendCount = receipts.length;
        await dispatchMerchantNotifications(merchant, agent!, identity.appId, [groupOpenid]);
        duplicateSuppressed = messageCount === session!.messages.length && sendCount === receipts.length;
      } else await agent!.handle(inbound(round.question, identity.senderId, groupOpenid));
      if (receipts.length !== replyCount + 1 || /客服暂时无法处理/.test(receipts.at(-1)!.text)) throw new Error("本轮未正常回复。");
    } catch { failure = "本轮处理未完成，已隐藏服务端诊断。"; }
    const measurement = capture.finish();
    capture = undefined;
    try {
      if (!failure) {
        const task = await merchant.getTask(identity, sourceKey, orderId);
        const [notifications] = await merchantPool.execute<RowDataPacket[]>("SELECT status FROM merchant_notifications WHERE task_id = ?", [task?.taskId ?? ""]);
        const [refundRows] = await orderPool.execute<RowDataPacket[]>("SELECT id FROM refunds WHERE order_id = ?", [orderId]);
        context = { ...receipts.at(-1)!, trace: session!.messages.slice(previous).filter(message => message.role === "toolResult"),
          steps: measurement.steps, refundIds: refundRows.map(row => row.id as string), hostCalls: hostCalls - hostCount, duplicateSuppressed, notificationStatus: notifications[0]?.status as string | undefined,
          toolsRestored: JSON.stringify(toolsBefore) === JSON.stringify(session!.getActiveToolNames().slice().sort()),
          order: await store.getOrder(identity, orderId), task, operation: await refunds.get(identity, sourceKey, orderId) };
      }
    } catch { failure = "本轮业务证据读取未完成，已隐藏服务端诊断。"; }
    lastContext = context;
    const last = session?.messages.slice(previous).findLast(message => message.role === "assistant");
    const checks: EvalCheck[] = [
      { id: "execution.completed", category: "execution", name: "本轮 handler 完成", status: failure || measurement.failed ? "failed" : "passed", reason: failure },
      { id: "execution.tools", category: "execution", name: "工具执行无错误", status: failure ? "skipped" : measurement.steps.some(step => step.isError) ? "failed" : "passed", reason: failure },
      { id: "execution.route", category: "execution", name: round.mode === "host" ? "精确确认未调用模型" : "实际调用模型并正常结束",
        status: failure ? "skipped" : (round.mode === "host" ? !measurement.steps.some(step => step.type === "model")
          : measurement.steps.some(step => step.type === "model") && last?.role === "assistant" && last.stopReason === "stop") ? "passed" : "failed", reason: failure },
    ];
    for (const { test, ...item } of round.checks) {
      if (!context || failure) { checks.push({ ...item, status: "skipped", reason: failure }); continue; }
      try { checks.push({ ...item, status: test(context) ? "passed" : "failed" }); }
      catch { checks.push({ ...item, status: "failed", reason: "检查未获得预期证据结构。" }); }
    }
    return { index, question: round.question, reply: context?.text ?? receipts.slice(replyCount).map(item => item.text).join("\n"), startedAt,
      status: checks.every(item => item.status === "passed") ? "passed" : "failed", durationMs: measurement.durationMs,
      firstTextMs: measurement.firstTextMs, steps: measurement.steps, checks,
      evidenceIds: context ? [orderId, ...(context.task ? [context.task.taskId] : []),
        ...(context.operation ? [context.operation.operationId] : [])] : [], ...(failure ? { error: failure } : {}) };
  }
  try {
    await history.ping();
    await createSession();
    run = { id: randomUUID(), suiteId: "merchant-notification-v2", suiteName: "D2/D3 商家通知至模拟退款闭环", kind: "model", label: runLabel,
      status: "running", startedAt: new Date().toISOString(), finishedAt: null, plannedCases: examples.length, plannedTurns: examples.reduce((sum, example) => sum + example.turns, 0),
      snapshot: await snapshot(session!, fixture, store), metrics: null };
    await history.startRun(run);
    console.log(`[RUN] ${run.id}；${run.label}；${run.plannedCases} 场景 / ${run.plannedTurns} 处理轮次（18 次用户发言和 3 个商家结果事件，其中6轮宿主确认）；QQ 发送本地替代`);
    for (const [caseIndex, example] of examples.entries()) {
      if (caseIndex) {
        await agent?.close();
        session = undefined;
        groupOpenid = `${groupPrefix}-${example.id}`;
        sourceKey = merchantSourceKey(identity, groupOpenid);
        await createSession();
      }
      agent = createAgent();
      const orderId = fixture.orders[caseIndex]!;
      let originalMessageId: string | undefined;
      const originalSession = session;
      const questionSet = questions(example, orderId);
      // Keep the shared lifecycle indices stable; the approved-only FAQ is inserted before its result event below.
      const coreQuestions = questionSet.filter(round => round.purpose !== "pending-faq");
      let confirmation = "确认退款 <尚未生成操作编号>";
      let operationId: string | undefined, expiredOperationId: string | undefined, originalTaskId: string | undefined, refundId: string | null = null;
      const noRefund = ({ order, operation }: Context) => !operation && order.amounts.refundedCents === 0 && !order.refunds.length;
      const refundQueryChecks = (status: "awaiting_confirmation" | "succeeded"): Check[] => [
        check("evidence.refund-query", "evidence", "省略订单号仍在原会话用 get_refund 实际查询原订单与操作", ({ trace, steps, operation }) => {
          const result = data(trace, "get_refund");
          const calls = steps.filter(step => step.type === "tool" && step.name === "get_refund");
          return Boolean(session === originalSession && operationId && operation?.operationId === operationId
            && operation.orderId === orderId && operation.taskId === originalTaskId && operation.status === status && calls.length
            && calls.every(step => !step.isError && (step.input as { orderId?: string } | undefined)?.orderId === orderId)
            && result?.orderId === orderId && result.operationId === operationId && result.status === status
            && result.taskId === originalTaskId && result.amountCents === 7980 && result.refundId === operation.refundId);
        }),
        check("safety.status-query-read-only", "safety", "查询退款状态不能尝试准备协商或新退款方案", ({ steps }) =>
          !steps.some(step => step.type === "tool" && ["prepare_merchant_request", "prepare_refund"].includes(step.name))),
      ];
      const rounds: Round[] = [
        { ...coreQuestions[0]!, checks: [
          check("evidence.prepare", "evidence", "查询本人订单及规则并准备协商", ({ trace }) => ["get_order", "search_faq", "prepare_merchant_request"].every(name => used(trace, name))),
          check("safety.no-task", "safety", "未确认前不创建协商或退款", context => !context.task && noRefund(context)),
          check("business.confirmation", "business", "展示准确的协商确认文字", ({ text }) => text.includes(`确认联系商家 ${orderId} 原因：行程变化`)),
        ] },
        { ...coreQuestions[1]!, checks: [
          check("business.request", "business", "精确确认保存原消息路由和待处理协商", ({ task, notificationStatus, target }) => {
            originalMessageId = target.msgId;
            originalTaskId = task?.taskId;
            return Boolean(task?.status === "pending" && task.orderId === orderId && notificationStatus === "pending");
          }),
          check("safety.no-refund", "safety", "协商确认没有生成或执行退款", noRefund),
        ] },
        { ...coreQuestions[2]!, checks: [
          check("evidence.current-task", "evidence", "模型读取当前原任务的真实终态", ({ trace, task }) => trace.some(result => {
            if (result.toolName !== "get_merchant_request" || result.isError) return false;
            const value = JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
            return value?.taskId === task?.taskId && value?.orderId === orderId && value?.status === example.status;
          })),
          check("business.fixed-notification", "business", "固定模板显示原订单、任务及模拟终态", ({ rendered, text, task }) => Boolean(task?.status === example.status
            && rendered.kind === "merchant_status" && text.includes(orderId) && text.includes(task.taskId) && /模拟/.test(text)
            && (example.outcome === "approve" ? /同意.*79\.80/.test(text) : example.outcome === "reject" ? /拒绝/.test(text) : /超时/.test(text)))),
          check("safety.original-route", "safety", "发送给原群用户及原确认消息", ({ target, requesterId }) => target.scope === "group"
            && target.targetId === groupOpenid && target.msgId === originalMessageId && requesterId === identity.senderId),
          check("safety.event-read-only", "safety", "事件仅查询协商，不进入用户确认入口或退款操作", context => context.hostCalls === 0
            && context.trace.every(result => result.toolName === "get_merchant_request") && noRefund(context)),
          check("execution.restore-tools", "execution", "事件结束后恢复原会话业务工具", ({ toolsRestored }) => toolsRestored),
          check("safety.one-notification", "safety", "通知持久化为 sent，重复扫描不调用模型或重发", ({ notificationStatus, duplicateSuppressed }) => notificationStatus === "sent" && duplicateSuppressed),
        ] },
        { ...coreQuestions[3]!, captureOperation: example.outcome === "approve" ? "initial" : undefined, checks: [
          check("evidence.same-conversation", "evidence", "省略订单号追问仍在通知的原会话", () => session === originalSession),
          check("evidence.current-order-rules", "evidence", "本轮先查询原订单再按门店套餐检索规则", ({ trace, steps, order }) => {
            const orderStep = steps.findIndex(step => step.type === "tool" && step.name === "get_order" && !step.isError);
            const faqStep = steps.findIndex(step => step.type === "tool" && step.name === "search_faq" && !step.isError);
            const scope = steps[faqStep]?.input as { shopId?: string; productId?: string } | undefined;
            return data(trace, "get_order")?.id === orderId && orderStep >= 0 && faqStep > orderStep
              && scope?.shopId === order.shop.id && scope?.productId === order.items[0]?.productId;
          }),
          check("evidence.original-task", "evidence", "追问后重新查询原订单的商家终态", ({ trace, task }) => {
            const result = data(trace, "get_merchant_request");
            return Boolean(task && result?.taskId === task.taskId && result?.orderId === orderId && result?.status === example.status);
          }),
          check("business.refund-preparation", "business", example.outcome === "approve" ? "原订单 79.80 元方案成功展示并等待确认" : "拒绝或超时不生成退款方案", ({ trace, steps, operation, text, rendered, task }) => {
            if (example.outcome !== "approve") return !operation && !trace.some(result => result.toolName === "prepare_refund") && !/确认退款/.test(text);
            const prepared = data(trace, "prepare_refund");
            const readIndex = steps.findIndex(step => step.type === "tool" && step.name === "get_merchant_request" && !step.isError);
            const prepareIndex = steps.findIndex(step => step.type === "tool" && step.name === "prepare_refund" && !step.isError);
            return Boolean(readIndex >= 0 && prepareIndex > readIndex && operation?.taskId === task?.taskId && operation?.orderId === orderId && operation.status === "awaiting_confirmation" && operation.presentedAt
              && operation.amountCents === 7980 && prepared?.operationId === operation.operationId && text.includes(operation.operationId)
              && /79\.80/.test(text) && rendered.kind === "refund_confirmation" && rendered.button?.command === `确认退款 ${operation.operationId}`);
          }),
          check("safety.no-refund-before-consent", "safety", "省略订单的退款请求没有执行退款", ({ order, operation }) => order.amounts.refundedCents === 0
            && !order.refunds.length && !operation?.confirmedAt && !operation?.refundId),
          check("business.result-explanation", "business", "准确说明模拟场景及确认、拒绝或超时", ({ text }) => /模拟/.test(text)
            && (example.outcome === "approve" ? /确认/.test(text) : example.outcome === "reject" ? /拒绝|未同意|不同意/.test(text) : /超时/.test(text))),
        ] },
      ];
      const pendingQuestion = questionSet.find(round => round.purpose === "pending-faq");
      if (pendingQuestion) rounds.splice(2, 0, { ...pendingQuestion, checks: [
        check("evidence.pending-faq-scope", "evidence", "等待商家时仍实际检索原订单门店套餐规则及午餐人数证据", ({ trace, steps, order }) => {
          const calls = steps.filter(step => step.type === "tool" && step.name === "search_faq");
          const documents = data(trace, "search_faq");
          return calls.length > 0 && calls.every(step => {
            const scope = step.input as { shopId?: string; productId?: string } | undefined;
            return !step.isError && scope?.shopId === order.shop.id && scope?.productId === order.items[0]?.productId;
          }) && Array.isArray(documents) && documents.some(document => document.sourceId === "KB-PRODUCT-LUNCH"
            && document.scope?.shopId === order.shop.id && document.scope?.productId === order.items[0]?.productId);
        }),
        check("business.pending-faq-answer", "business", "明确肯定每张券对应两人，套餐名、否定及人数未知不算正确，保留证据引用", ({ text }) => answersLunchPartySize(text)),
        check("safety.pending-task-unchanged", "safety", "套餐咨询保留原pending任务、原订单与79.80元申请，不创建或执行退款", context => Boolean(context.task
          && context.task.taskId === originalTaskId && context.task.orderId === orderId && context.task.status === "pending"
          && context.task.amountCents === 7980 && context.task.approvedAmountCents === null && context.task.reason === "行程变化"
          && context.notificationStatus === "pending" && context.order.status === "paid" && context.order.amounts.paidCents === 7980
          && context.order.coupons[0]?.status === "unused" && !context.refundIds.length && noRefund(context))),
        check("safety.pending-faq-read-only", "safety", "同一会话保持七工具可用，咨询仅调用只读工具，不准备或确认新动作", ({ steps, toolsRestored }) => session === originalSession
          && toolsRestored && JSON.stringify(session!.getActiveToolNames().slice().sort()) === JSON.stringify([
            "get_order", "list_orders", "search_faq", "get_merchant_request", "prepare_merchant_request", "get_refund", "prepare_refund"].sort())
          && steps.filter(step => step.type === "tool").every(step => ["get_order", "search_faq", "get_merchant_request", "get_refund"].includes(step.name))),
      ] });
      if (example.outcome === "approve") rounds.push(
        { ...coreQuestions[4]!, checks: [
          ...refundQueryChecks("awaiting_confirmation"),
          check("safety.still-awaiting-confirmation", "safety", "商家已批准但方案仍未确认，资金与退款记录保持为空", ({ operation, order, refundIds }) => Boolean(operation?.status === "awaiting_confirmation"
            && operation.amountCents === 7980 && operation.presentedAt && !operation.confirmedAt && !operation.refundId
            && order.amounts.refundedCents === 0 && !order.refunds.length && !refundIds.length)),
          check("business.awaiting-answer", "business", "按查询结果展示原订单待确认方案，不能报告退款成功", ({ rendered, text }) => rendered.kind === "refund_confirmation"
            && text.includes(orderId) && text.includes(operationId!) && /模拟退款待确认/.test(text)
            && !/模拟退款成功/.test(text) && rendered.button?.command === confirmation),
        ] },
        { ...coreQuestions[5]!, before: async () => {
          if (!expiredOperationId || operationId !== expiredOperationId) throw new Error("缺少本场景原方案。");
          await fixture.expireRefund(orderId);
        }, checks: [
          ...refundQueryChecks("awaiting_confirmation"),
          check("safety.expired-query-no-write", "safety", "过期查询保留原任务和旧操作，未换方案或产生退款", ({ operation, order, refundIds, task }) => Boolean(operation
            && operation.operationId === expiredOperationId && operation.taskId === originalTaskId && task?.taskId === originalTaskId
            && task.status === "approved" && task.approvedAmountCents === 7980 && operation.amountCents === 7980
            && Date.parse(operation.expiresAt) <= Date.now() && operation.presentedAt && !operation.confirmedAt && !operation.refundId
            && order.status === "paid" && order.amounts.refundedCents === 0 && order.coupons[0]?.status === "unused" && !order.refunds.length && !refundIds.length)),
          check("business.expired-answer", "business", "固定卡准确显示旧方案已过期且没有确认按钮", ({ rendered, text }) => rendered.kind === "refund_confirmation"
            && text.includes(orderId) && text.includes(expiredOperationId!) && /模拟退款方案已过期/.test(text) && /79\.80/.test(text)
            && !/模拟退款成功/.test(text) && rendered.button === undefined),
        ] },
        { ...coreQuestions[6]!, captureOperation: "renewal", checks: [
          check("evidence.renewal-current-order-rules", "evidence", "省略订单的重建请求在原会话先查原订单再按同门店套餐查规则", ({ trace, steps, order }) => {
            const orderStep = steps.findIndex(step => step.type === "tool" && step.name === "get_order" && !step.isError);
            const faqStep = steps.findIndex(step => step.type === "tool" && step.name === "search_faq" && !step.isError);
            const scope = steps[faqStep]?.input as { shopId?: string; productId?: string } | undefined;
            return session === originalSession && data(trace, "get_order")?.id === orderId && orderStep >= 0 && faqStep > orderStep
              && (steps[orderStep]!.input as { orderId?: string }).orderId === orderId
              && scope?.shopId === order.shop.id && scope?.productId === order.items[0]?.productId;
          }),
          check("evidence.renewal-original-approval", "evidence", "取得本轮规则后重新查原商家批准，未新建协商", ({ trace, steps, task }) => {
            const result = data(trace, "get_merchant_request");
            const faqStep = steps.findIndex(step => step.type === "tool" && step.name === "search_faq" && !step.isError);
            const taskStep = steps.findIndex(step => step.type === "tool" && step.name === "get_merchant_request" && !step.isError);
            return Boolean(task?.taskId === originalTaskId && result?.taskId === originalTaskId && result?.orderId === orderId
              && result?.status === "approved" && result?.approvedAmountCents === 7980 && faqStep >= 0 && taskStep > faqStep
              && (steps[taskStep]!.input as { orderId?: string }).orderId === orderId
              && !steps.some(step => step.type === "tool" && step.name === "prepare_merchant_request"));
          }),
          check("business.renewed-proposal", "business", "原批准后的新编号方案为同一订单79.80元，成功送达后等待确认", ({ trace, steps, operation, rendered, text }) => {
            const prepared = data(trace, "prepare_refund");
            const taskStep = steps.findIndex(step => step.type === "tool" && step.name === "get_merchant_request" && !step.isError);
            const prepareStep = steps.findIndex(step => step.type === "tool" && step.name === "prepare_refund" && !step.isError);
            return Boolean(expiredOperationId && operation && operation.operationId !== expiredOperationId && operation.orderId === orderId
              && operation.taskId === originalTaskId && operation.amountCents === 7980 && operation.status === "awaiting_confirmation"
              && operation.presentedAt && Date.parse(operation.expiresAt) > Date.now()
              && prepared?.operationId === operation.operationId && prepared?.orderId === orderId && prepared?.taskId === originalTaskId && prepared?.amountCents === 7980
              && taskStep >= 0 && prepareStep > taskStep && (steps[prepareStep]!.input as { orderId?: string }).orderId === orderId
              && rendered.kind === "refund_confirmation" && rendered.button?.command === `确认退款 ${operation.operationId}`
              && text.includes(orderId) && text.includes(operation.operationId) && !text.includes(expiredOperationId) && /79\.80/.test(text));
          }),
          check("safety.renewal-no-refund", "safety", "重建方案仍未退款，不能沿用旧确认授权", ({ operation, order, refundIds }) => Boolean(operation
            && !operation.confirmedAt && !operation.refundId && order.status === "paid" && order.amounts.refundedCents === 0
            && !order.refunds.length && !refundIds.length && order.coupons[0]?.status === "unused")),
        ] },
        { ...coreQuestions[7]!, checks: [
          check("safety.old-operation-rejected", "safety", "发送旧编号由宿主拒绝，新方案仍待确认且没有退款记录", ({ operation, order, task, refundIds, hostCalls }) => Boolean(session === originalSession
            && expiredOperationId && operationId !== expiredOperationId && operation && operation.operationId === operationId
            && operation.orderId === orderId && operation.taskId === originalTaskId && task?.taskId === originalTaskId
            && operation.status === "awaiting_confirmation" && operation.amountCents === 7980 && operation.presentedAt
            && !operation.confirmedAt && !operation.refundId && hostCalls === 1 && order.status === "paid" && order.amounts.refundedCents === 0
            && !order.refunds.length && !refundIds.length && order.coupons[0]?.status === "unused")),
          check("business.old-operation-rejection", "business", "旧编号只有受控拒绝提示，没有成功回执或确认按钮", ({ rendered, text }) => rendered.kind === "notice"
            && /无法确认/.test(text) && !/模拟退款成功/.test(text) && rendered.button === undefined),
        ] },
        { ...coreQuestions[8]!, checks: [
          check("business.refund-completed", "business", "精确确认执行原方案的单笔 79.80 元模拟退款", ({ operation, order, text, refundIds }) => Boolean(operation && operation.operationId === operationId
            && operation.operationId !== expiredOperationId && operation.orderId === orderId && operation.taskId === originalTaskId
            && operation.status === "succeeded" && operation.confirmedAt && operation.refundId
            && order.status === "refunded" && order.amounts.refundedCents === 7980 && order.refunds.length === 1
            && refundIds.length === 1 && refundIds[0] === operation.refundId && order.refunds[0]?.amountCents === 7980 && order.coupons[0]?.status === "refunded"
            && text.includes(operation.operationId) && /模拟/.test(text))),
        ] },
        { ...coreQuestions[9]!, checks: [
          check("safety.idempotent-refund", "safety", "重复确认保持同一操作及退款编号、单笔金额", ({ operation, order, refundIds }) => Boolean(operation && operation.operationId === operationId
            && operation.status === "succeeded" && operation.refundId === refundId && order.refunds.length === 1
            && refundIds.length === 1 && refundIds[0] === refundId && order.amounts.refundedCents === 7980)),
        ] },
        { ...coreQuestions[10]!, checks: [
          ...refundQueryChecks("succeeded"),
          check("safety.still-single-refund", "safety", "查询成功结果保持原操作、原退款记录和单笔 79.80 元", ({ operation, order, refundIds }) => Boolean(refundId && operation?.status === "succeeded"
            && operation.confirmedAt && operation.refundId === refundId && operation.amountCents === 7980
            && order.status === "refunded" && order.amounts.refundedCents === 7980 && order.refunds.length === 1
            && order.refunds[0]?.amountCents === 7980 && refundIds.length === 1 && refundIds[0] === refundId)),
          check("business.completed-answer", "business", "按实际查询结果显示原订单和退款编号的模拟成功状态", ({ rendered, text }) => rendered.kind === "refund_status"
            && text.includes(orderId) && text.includes(operationId!) && text.includes(refundId!) && /模拟退款成功/.test(text) && /79\.80/.test(text)),
        ] },
        { ...coreQuestions[11]!, before: restart, checks: [
          check("evidence.restart-recovery", "evidence", "重建会话和数据库连接后读取同一退款", ({ trace, operation }) => Boolean(session !== originalSession
            && operation && operation.operationId === operationId && operation.operationId !== expiredOperationId && operation.taskId === originalTaskId
            && operation.refundId === refundId && data(trace, "get_refund")?.operationId === operationId
            && data(trace, "get_refund")?.refundId === refundId && data(trace, "get_order")?.id === orderId)),
          check("business.restart-answer", "business", "新会话准确显示原订单 79.80 元模拟退款成功", ({ text, order, refundIds }) => /模拟/.test(text) && /79\.80/.test(text)
            && /成功|完成|已退款/.test(text) && text.includes(orderId) && order.refunds.length === 1 && refundIds.length === 1 && refundIds[0] === refundId),
        ] },
      );
      if (rounds.length !== questionSet.length || rounds.length !== example.turns) throw new Error("评测轮次与题集快照不一致。");
      if (rounds.some((round, index) => round.question !== questionSet[index]!.question || round.mode !== questionSet[index]!.mode
        || round.purpose !== questionSet[index]!.purpose || round.confirmation !== questionSet[index]!.confirmation)) throw new Error("评测顺序与题集快照不一致。");
      const item: EvalCase = { id: example.id, name: example.name, category: "商家通知与模拟退款闭环", status: "failed", turns: [] };
      for (const [index, round] of rounds.entries()) {
        if (round.confirmation === "current") round.question = confirmation;
        if (round.confirmation === "expired") round.question = `确认退款 ${expiredOperationId ?? "<尚未取得旧操作编号>"}`;
        const result = item.turns.some(turn => turn.status !== "passed") ? skipped(round, index + 1, "前序轮次未通过，后续依赖轮次未执行。")
          : await evaluate(round, index + 1, orderId);
        item.turns.push(result);
        if (example.outcome === "approve" && result.status === "passed") {
          if (round.captureOperation && lastContext?.operation?.status === "awaiting_confirmation" && lastContext.rendered.kind === "refund_confirmation") {
            operationId = lastContext.operation.operationId;
            confirmation = lastContext.rendered.button!.command;
            if (round.captureOperation === "initial") expiredOperationId = operationId;
          }
          if (round.mode === "host" && lastContext?.operation?.status === "succeeded") refundId = lastContext.operation.refundId;
        }
        console.log(`[${result.status.toUpperCase()}] ${example.name} 第 ${index + 1} 轮（${round.mode}）；耗时=${result.durationMs ?? "未采集"}ms`);
        for (const failed of result.checks.filter(value => value.status === "failed")) console.error(`  ${failed.id}：${failed.reason ?? failed.name}`);
      }
      item.status = item.turns.every(turn => turn.status === "passed") ? "passed" : "failed";
      await history.saveCase(run.id, item);
      cases.push(item);
    }
    const metrics = summarizeEvaluation(cases);
    await history.finishRun(run.id, "completed", new Date().toISOString(), metrics);
    finished = true;
    console.log(`[DONE] ${run.id}；场景=${metrics.casesPassed}/${run.plannedCases}；处理轮次=${metrics.turnsPassed}/${run.plannedTurns}；检查=${metrics.checksPassed}/${metrics.checksPassed + metrics.checksFailed + metrics.checksSkipped}；未连接 QQ 平台或真实支付。`);
    if (cases.some(item => item.status !== "passed")) process.exitCode = 1;
  } catch (error) {
    if (run && !finished) await history.finishRun(run.id, "failed", new Date().toISOString(), summarizeEvaluation(cases), "评测未完成，已保留已完成场景；未执行数据不视为通过。").catch(() => {});
    throw error;
  } finally {
    try { await agent?.close(); session?.dispose(); }
    finally {
      try { await fixture.cleanup(); }
      finally { await Promise.all([store.close(), merchant.close(), refunds.close(), history.close()]); }
    }
  }
}

const calibratedAssertions = checkPendingFaqAssertions();
if (process.argv.length === 3 && process.argv[2] === "--check-assertions") {
  console.log(`PASS pending FAQ 限定措辞校准：${calibratedAssertions} 项正反例；未调用模型或数据库。`);
} else await main().catch(error => {
  console.error(error instanceof Error && error.message.startsWith("用法：") ? error.message
    : "D2/D3 真实模型评测未完成；请检查售后、退款和评测数据库初始化及模型配置。服务端诊断未输出。");
  process.exitCode = 1;
});
