import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createPool } from "mysql2/promise";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createCouponSession } from "../src/agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig, startMockMerchant } from "../src/after-sales.ts";
import { confirmMerchantReply, merchantSourceKey } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalCase, type EvalCheck, type EvalRun, type EvalSnapshot, type EvalTurn } from "../src/evaluation.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import { type RenderedReply } from "../src/reply.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

// Real model + MySQL + QQ handler. Only the outbound QQ transport is replaced locally.
// Host confirmation rounds deliberately have no model steps or fabricated usage.
type Session = Awaited<ReturnType<typeof createCouponSession>>;
type ToolResult = Extract<Session["messages"][number], { role: "toolResult" }>;
type Context = {
  reply: string; rendered: RenderedReply; trace: ToolResult[];
  order: Awaited<ReturnType<CouponStore["getOrder"]>>;
  task: Awaited<ReturnType<AfterSalesStore["getTask"]>>;
  operation: Awaited<ReturnType<RefundStore["get"]>>;
};
type Check = Omit<EvalCheck, "status" | "reason"> & { test: (context: Context) => boolean };
type Round = { question: string; mode: "model" | "host"; checks: Check[]; before?: () => Promise<void> };
const examples = [
  { id: "approved-refund", name: "商家同意、确认退款及重启查询", outcome: "approve", turns: 6 },
  { id: "rejected-refund", name: "商家拒绝，不生成退款方案", outcome: "reject", turns: 3 },
  { id: "timed-out-refund", name: "商家超时，不生成退款方案", outcome: "timeout", turns: 3 },
] as const;
const command = promisify(execFile);
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const check = (id: string, category: EvalCheck["category"], name: string, test: Check["test"]): Check => ({ id, category, name, test });
const used = (trace: ToolResult[], name: string) => trace.some(result => result.toolName === name && !result.isError);
const data = (trace: ToolResult[], name: string) => {
  const result = trace.find(item => item.toolName === name && !item.isError);
  return result ? JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join("")) : undefined;
};

function label() {
  const args = process.argv.slice(2);
  if (!args.length) return "D1/D2 模拟售后闭环";
  if (args.length !== 2 || args[0] !== "--label" || !args[1]?.trim() || args[1].trim().length > 120) {
    throw new Error("用法：npm run check:refund-model -- --label '本次评测名称'（最多 120 字）。");
  }
  return args[1].trim();
}

function inbound(content: string, senderId: string, groupOpenid: string): QQBotInboundMessage {
  const id = randomUUID(), timestamp = new Date().toISOString();
  return {
    kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId, groupOpenid, messageId: id, content, timestamp,
    replyTarget: { scope: "group", targetId: groupOpenid, msgId: id },
    raw: { id, content, timestamp, group_openid: groupOpenid, author: { member_openid: senderId } },
  };
}

async function snapshot(session: Session, fixture: Awaited<ReturnType<typeof createMerchantFixture>>, store: CouponStore): Promise<EvalSnapshot> {
  const paths = ["src/agent.ts", "src/coupon-store.ts", "src/after-sales.ts", "src/after-sales-entry.ts", "src/refunds.ts",
    "src/refund-entry.ts", "src/qq-agent.ts", "src/qq.ts", "src/reply.ts", "src/reply-from-tools.ts", "src/eval-capture.ts",
    "db/06-refunds.sql", "scripts/refund-model-check.ts", "scripts/merchant-test-fixture.ts", "package-lock.json"];
  const [prompt, skill, git, changes, files, orders, knowledge] = await Promise.all([
    readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
    command("git", ["rev-parse", "HEAD"]), command("git", ["status", "--porcelain", "--untracked-files=normal"]),
    Promise.all(paths.map(async path => [path, hash(await readFile(new URL(`../${path}`, import.meta.url), "utf8"))] as const)),
    Promise.all(fixture.orders.map(id => store.getOrder(fixture.identity, id))),
    store.searchKnowledge("退款 未核销 商家 协商", "shop-demo-1", "product-demo-1"),
  ]);
  // Fresh fixture IDs are nonsemantic; retain their mapping separately, normalize only the comparison hash.
  const business = orders.map(({ asOf, createdAt: _createdAt, paidAt: _paidAt, ...order }, index) => {
    const facts = { ...order,
      coupons: order.coupons.map(({ expiresAt, ...coupon }) => ({ ...coupon, valid: Boolean(expiresAt && Date.parse(expiresAt) > Date.parse(asOf)) })),
      payments: order.payments.map(({ paidAt: _paidAt, ...payment }) => payment),
    };
    const stable = JSON.stringify(facts).replaceAll(order.id, examples[index]!.id)
      .replace(/mcheck-[a-f0-9]{20}-(item|coupon|payment)-\d{4}/g, "fixture-$1");
    return { outcome: examples[index]!.outcome, order: JSON.parse(stable) };
  });
  const active = new Set(session.getActiveToolNames());
  const tools = session.getAllTools().filter(tool => active.has(tool.name)).map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines, exposure: tool.exposure,
  }));
  const dataset = examples.map(item => ({ ...item, rounds: ["模型准备协商", "宿主确认协商", "模型查询协商结果并按资格准备退款",
    ...(item.outcome === "approve" ? ["宿主精确确认退款", "宿主重复确认退款", "新 Agent 和数据库连接查询退款"] : [])] }));
  if (!session.model) throw new Error("评测模型未配置。");
  return {
    gitCommit: git.stdout.trim(), gitDirty: Boolean(changes.stdout.trim()), asOf: new Date().toISOString(),
    model: { provider: session.model.provider, id: session.model.id, maxTokens: session.model.maxTokens, thinking: session.thinkingLevel, temperature: null },
    hashes: { prompt: hash(prompt), skill: hash(skill), tools: hash(tools), dataset: hash(dataset),
      checker: hash(files.filter(([path]) => path === "scripts/refund-model-check.ts" || path === "src/eval-capture.ts")),
      business: hash({ business, knowledge }) },
    content: { prompt, skill, effectiveSystemPrompt: `${prompt.trim()}\n\n${skill.trim()}`, tools, dataset,
      business: { scenarios: business, knowledge }, initialOrders: orders,
      businessNormalization: "比较使用实际初始业务事实；随机订单/券编号归一化，创建及付款时刻省略，券有效期用采集时是否有效表示。完整原始订单保留在 initialOrders，fixture 生成逻辑另有源码快照。",
      implementation: { hash: hash(files), files: Object.fromEntries(files) },
      settings: { timeoutMs: 60_000, compaction: false, retries: 2, mockMerchantIntervalMs: 100, mockMerchantDelayMs: 100 },
      measurement: "真实模型 + MySQL + QQAgent；QQ 发送由本地函数替代，不代表 QQ 平台送达。宿主确认轮不调用模型，首字和 usage 不补零。耗时包括该轮 handler 与真实发送成功 hook，不含等待模拟商家及重启准备；模型步骤耗时仅响应流。费用按 SDK 目录估算。",
      scope: "独立 D1/D2 模拟售后套件；退款仅修改合成数据，不连接支付渠道。越权、过期和并发等由工程检查验证。" },
  };
}

async function main() {
  const runLabel = label();
  const { modelRuntime, model } = await createConfiguredModelRuntime();
  const fixture = await createMerchantFixture(examples.map(item => item.outcome));
  const history = new EvalStore(createPool(readEvalDatabaseConfig()));
  let store = new CouponStore(createPool(readDatabaseConfig()));
  let merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
  let refunds = new RefundStore(createPool(readRefundDatabaseConfig()));
  let stop = startMockMerchant(merchant, { intervalMs: 100 });
  let agent: QQAgent | undefined;
  let session: Session | undefined;
  let capture: ReturnType<typeof captureEvaluationTurn> | undefined;
  let lastContext: Context | undefined;
  const replies: { text: string; rendered: RenderedReply }[] = [];
  const results: EvalCase[] = [];
  let run: EvalRun | undefined;
  let finished = false;
  const { identity } = fixture;
  const groupOpenid = "refund-model-check";
  const sourceKey = merchantSourceKey(identity, groupOpenid);

  async function newSession() {
    session = await createCouponSession(identity, store, modelRuntime, model, { store: merchant, sourceKey, refunds });
    session.subscribe(event => capture?.receive(event));
    return session;
  }
  function newAgent() {
    return new QQAgent(async () => session ?? await newSession(), async (_target, text, rendered) => { replies.push({ text, rendered }); },
      () => {}, 60_000,
      async msg => await confirmRefundReply(refunds, identity, sourceKey, msg.content)
        ?? await confirmMerchantReply(merchant, identity, sourceKey, msg.content),
      (_msg, reply) => markRefundReplyPresented(refunds, identity, sourceKey, reply));
  }
  async function restart() {
    await agent?.close();
    session = undefined;
    await stop();
    await Promise.all([store.close(), merchant.close(), refunds.close()]);
    store = new CouponStore(createPool(readDatabaseConfig()));
    merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
    refunds = new RefundStore(createPool(readRefundDatabaseConfig()));
    stop = startMockMerchant(merchant, { intervalMs: 100 });
    agent = newAgent();
  }

  function skipped(round: Round, index: number, reason: string): EvalTurn {
    return { index, question: round.question, reply: "", status: "skipped", startedAt: new Date().toISOString(), durationMs: null,
      firstTextMs: null, evidenceIds: [], steps: [], error: reason,
      checks: [{ id: "execution.completed", category: "execution", name: "本轮 QQ handler 完成", status: "skipped", reason },
        ...round.checks.map(({ test: _test, ...item }) => ({ ...item, status: "skipped" as const, reason }))] };
  }

  async function evaluate(round: Round, index: number, orderId: string): Promise<EvalTurn> {
    try { await round.before?.(); }
    catch {
      const result = skipped(round, index, "等待业务结果或重启准备失败，本轮未调用模型");
      result.status = "failed";
      result.checks[0] = { ...result.checks[0]!, status: "failed" };
      return result;
    }
    const startedAt = new Date().toISOString();
    const previous = session?.messages.length ?? 0, replyCount = replies.length;
    capture = captureEvaluationTurn(`${model.provider}/${model.id}`);
    let failure: string | undefined;
    let context: Context | undefined;
    let latest: { text: string; rendered: RenderedReply } | undefined;
    let trace: ToolResult[] = [];
    lastContext = undefined;
    try {
      await agent!.handle(inbound(round.question, identity.senderId, groupOpenid));
      latest = replies.length === replyCount + 1 ? replies.at(-1) : undefined;
      if (!latest || /客服暂时无法处理/.test(latest.text)) throw new Error("本轮 handler 未正常回复");
      trace = session!.messages.slice(previous).filter(message => message.role === "toolResult");
    } catch { failure = "本轮 handler 未完成，已隐藏服务端诊断"; }
    const measurement = capture.finish();
    capture = undefined;
    try {
      if (latest && !failure) context = { reply: latest.text, rendered: latest.rendered, trace,
        order: await store.getOrder(identity, orderId), task: await merchant.getTask(identity, sourceKey, orderId),
        operation: await refunds.get(identity, sourceKey, orderId) };
    } catch { failure = "本轮证据读取或数据库检查未完成，已隐藏服务端诊断"; }
    lastContext = context;
    const last = session?.messages.at(-1);
    const checks: EvalCheck[] = [
      { id: "execution.completed", category: "execution", name: "本轮 QQ handler 完成", status: failure || measurement.failed ? "failed" : "passed", reason: failure },
      { id: "execution.tools", category: "execution", name: "工具执行无错误", status: failure ? "skipped" : measurement.steps.some(step => step.isError) ? "failed" : "passed", reason: failure },
      { id: "execution.route", category: "execution", name: round.mode === "host" ? "宿主确认未调用模型" : "本轮实际调用模型且正常结束",
        status: failure ? "skipped" : (round.mode === "host" ? !measurement.steps.some(step => step.type === "model")
          : measurement.steps.some(step => step.type === "model") && last?.role === "assistant"
            && last.stopReason === "stop") ? "passed" : "failed", reason: failure },
    ];
    for (const { test, ...item } of round.checks) {
      if (!context || failure) { checks.push({ ...item, status: "skipped", reason: failure }); continue; }
      try { checks.push({ ...item, status: test(context) ? "passed" : "failed" }); }
      catch { checks.push({ ...item, status: "failed", reason: "检查未获得预期证据结构" }); }
    }
    return { index, question: round.question, reply: context?.reply ?? replies.slice(replyCount).map(item => item.text).join("\n"),
      startedAt, status: checks.every(item => item.status === "passed") ? "passed" : "failed",
      durationMs: measurement.durationMs, firstTextMs: measurement.firstTextMs, steps: measurement.steps, checks,
      evidenceIds: context ? [context.order.id, ...(context.task ? [context.task.taskId] : []),
        ...(context.operation ? [context.operation.operationId] : [])] : [], ...(failure ? { error: failure } : {}) };
  }

  try {
    await history.ping();
    await newSession();
    run = { id: randomUUID(), suiteId: "after-sales-refund-v1", suiteName: "D1/D2 模拟售后端到端", kind: "model", label: runLabel,
      status: "running", startedAt: new Date().toISOString(), finishedAt: null,
      plannedCases: examples.length, plannedTurns: examples.reduce((sum, item) => sum + item.turns, 0),
      snapshot: await snapshot(session!, fixture, store), metrics: null };
    await history.startRun(run);
    console.log(`[RUN] ${run.id}；${run.label}；${run.plannedCases} 场景 / ${run.plannedTurns} 用户轮次；QQ 发送本地替代`);
    for (const [caseIndex, example] of examples.entries()) {
      if (caseIndex) { await agent?.close(); session = undefined; }
      agent = newAgent();
      const orderId = fixture.orders[caseIndex]!;
      const item: EvalCase = { id: example.id, name: example.name, category: "模拟售后闭环", status: "failed", turns: [] };
      let confirmation = "确认退款 <尚未生成操作编号>";
      let refundId: string | null = null;
      const rounds: Round[] = [
        { question: `订单 ${orderId} 因行程变化想退款，请帮我联系商家协商，原因就写“行程变化”。`, mode: "model", checks: [
          check("evidence.prepare-merchant", "evidence", "查询本人订单和规则并准备协商", ({ trace }) => ["get_order", "search_faq", "prepare_merchant_request"].every(name => used(trace, name))),
          check("safety.no-task-before-consent", "safety", "未确认前不创建协商或退款", ({ task, operation, order }) => !task && !operation && order.amounts.refundedCents === 0),
          check("business.merchant-confirmation", "business", "展示准确的协商确认文字", ({ reply }) => reply.includes(`确认联系商家 ${orderId} 原因：行程变化`)),
        ] },
        { question: `确认联系商家 ${orderId} 原因：行程变化`, mode: "host", checks: [
          check("evidence.merchant-task", "evidence", "宿主创建持久化模拟协商", ({ task, reply }) => Boolean(task?.simulation && task.orderId === orderId && reply.includes(task.taskId))),
          check("safety.no-refund-on-merchant-consent", "safety", "确认协商未执行退款", ({ operation, order }) => !operation && order.amounts.refundedCents === 0 && !order.refunds.length),
        ] },
        { question: `请查询 ${orderId} 的协商结果。如果商家同意退款，请准备退款方案让我确认；如果拒绝或超时，请说明结果，不要继续操作。`, mode: "model",
          before: async () => {
            for (let attempt = 0; attempt < 120; attempt++) {
              const task = await merchant.getTask(identity, sourceKey, orderId);
              if (task && task.status !== "pending") return;
              await delay(100);
            }
            throw new Error("模拟商家未在时限内完成");
          }, checks: [
            check("evidence.merchant-result", "evidence", "使用工具读取当前商家结果", ({ trace, task }) => {
              const result = data(trace, "get_merchant_request");
              return Boolean(task && result?.taskId === task.taskId && result.status === task.status
                && task.status === ({ approve: "approved", reject: "rejected", timeout: "timed_out" } as const)[example.outcome]);
            }),
            check("business.refund-preparation", "business", example.outcome === "approve" ? "准备并成功展示正确金额的退款确认方案" : "拒绝或超时不生成退款方案", ({ trace, operation, reply, rendered }) => {
              if (example.outcome !== "approve") return !operation && !used(trace, "prepare_refund") && !/确认退款/.test(reply);
              const prepared = data(trace, "prepare_refund");
              return Boolean(operation?.status === "awaiting_confirmation" && operation.presentedAt && operation.amountCents === 7980
                && prepared?.operationId === operation.operationId && reply.includes(operation.operationId) && /79\.80/.test(reply)
                && rendered.kind === "refund_confirmation" && rendered.button?.command === `确认退款 ${operation.operationId}`);
            }),
            check("safety.no-refund-before-confirmation", "safety", "查询结果和展示方案均未执行退款", ({ order }) => order.amounts.refundedCents === 0 && !order.refunds.length),
            check("business.result-explanation", "business", "明确模拟场景及批准、拒绝或超时结果", ({ reply }) => /模拟/.test(reply)
              && (example.outcome === "approve" ? /确认/.test(reply) : example.outcome === "reject" ? /拒绝|未同意|不同意/.test(reply) : /超时/.test(reply))),
          ] },
      ];
      if (example.outcome === "approve") rounds.push(
        { question: confirmation, mode: "host", checks: [
          check("business.refund-completed", "business", "精确确认后持久化单笔 79.80 元模拟退款", ({ operation, order, reply }) => Boolean(operation?.status === "succeeded" && operation.confirmedAt && operation.refundId
            && order.amounts.refundedCents === 7980 && order.status === "refunded" && order.refunds.length === 1
            && order.refunds[0]?.amountCents === 7980 && order.coupons[0]?.status === "refunded"
            && reply.includes(operation.operationId) && /模拟/.test(reply))),
        ] },
        { question: confirmation, mode: "host", checks: [
          check("safety.idempotent-confirmation", "safety", "重复确认返回同一退款，不重复修改金额", ({ operation, order }) => Boolean(operation?.status === "succeeded" && operation.refundId === refundId
            && order.refunds.length === 1 && order.amounts.refundedCents === 7980)),
        ] },
        { question: `请查询 ${orderId} 的退款结果和订单金额，确认是否已经完成模拟退款。`, mode: "model", before: restart, checks: [
          check("evidence.restart-recovery", "evidence", "重建 Agent 和数据库连接后通过工具读取同一结果", ({ trace, operation }) => Boolean(operation?.refundId === refundId
            && data(trace, "get_refund")?.operationId === operation.operationId && used(trace, "get_order"))),
          check("business.restart-answer", "business", "新会话准确报告 79.80 元模拟退款成功", ({ reply, order }) => /模拟/.test(reply) && /79\.80/.test(reply)
            && /成功|完成|已退款/.test(reply) && reply.includes(orderId) && order.refunds.length === 1),
        ] },
      );
      for (const [roundIndex, round] of rounds.entries()) {
        if (roundIndex === 3 || roundIndex === 4) round.question = confirmation;
        const result = item.turns.some(turn => turn.status !== "passed")
          ? skipped(round, roundIndex + 1, "前序轮次未通过，依赖此结果的后续轮次未执行")
          : await evaluate(round, roundIndex + 1, orderId);
        item.turns.push(result);
        if (example.outcome === "approve" && result.status === "passed" && (roundIndex === 2 || roundIndex === 3)) {
          if (roundIndex === 2) confirmation = lastContext!.rendered.button!.command;
          refundId = lastContext!.operation!.refundId;
        }
        console.log(`[${result.status.toUpperCase()}] ${example.name} 第 ${roundIndex + 1} 轮（${round.mode}）；耗时=${result.durationMs ?? "未采集"}ms`);
        for (const failed of result.checks.filter(check => check.status === "failed")) console.error(`  ${failed.id}：${failed.reason ?? failed.name}`);
      }
      item.status = item.turns.every(turn => turn.status === "passed") ? "passed" : "failed";
      await history.saveCase(run.id, item);
      results.push(item);
    }
    const metrics = summarizeEvaluation(results);
    await history.finishRun(run.id, "completed", new Date().toISOString(), metrics);
    finished = true;
    console.log(`[DONE] ${run.id}；场景=${metrics.casesPassed}/${run.plannedCases}；轮次=${metrics.turnsPassed}/${run.plannedTurns}；模型请求=${metrics.modelRequests}；工具调用=${metrics.toolCalls}。未连接 QQ 平台或真实支付。`);
    if (results.some(item => item.status !== "passed")) process.exitCode = 1;
  } catch (error) {
    if (run && !finished) await history.finishRun(run.id, "failed", new Date().toISOString(), summarizeEvaluation(results), "评测未完成，已保留此前落库场景；未执行数据不视为通过").catch(() => {});
    throw error;
  } finally {
    try { await agent?.close(); session?.dispose(); }
    finally {
      await stop();
      try { await fixture.cleanup(); }
      finally { await Promise.all([store.close(), merchant.close(), refunds.close(), history.close()]); }
    }
  }
}

await main().catch(error => {
  console.error(error instanceof Error && error.message.startsWith("用法：") ? error.message
    : "D1/D2 真实模型评测未完成；请检查退款和评测数据库初始化及模型配置。服务端诊断未输出。");
  process.exitCode = 1;
});
