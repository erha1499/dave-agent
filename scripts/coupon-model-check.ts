import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createPool } from "mysql2/promise";
import { createConfiguredModelRuntime, createCouponSession } from "../src/agent.ts";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";

// Live DeepSeek + Docker MySQL acceptance. These are bounded scenario checks, not a general model score.
type Session = Awaited<ReturnType<typeof createCouponSession>>;
type ToolResult = Extract<Session["messages"][number], { role: "toolResult" }>;
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Knowledge = Awaited<ReturnType<CouponStore["searchKnowledge"]>>;
type Round = { question: string; verify: (reply: string, trace: ToolResult[]) => void };
type Example = { name: string; identity: QQIdentity; rounds: Round[] };
const user: QQIdentity = { appId: "TEST_APP", senderId: "TEST_USER1" };
const timeout = Symbol("single-round-timeout");
const records: Array<{ question: string; reply: string; tools: string[]; evidenceIds: string[] }> = [];
const text = (result: ToolResult) => result.content.map(part => part.type === "text" ? part.text : "").join("");

function evidenceIds(trace: ToolResult[]) {
  return [...new Set(trace.filter(result => !result.isError).flatMap(result => {
    const data = JSON.parse(text(result));
    return result.toolName === "get_order" ? [String(data.id)]
      : (data as Knowledge).map(document => document.sourceId);
  }))];
}
function orderEvidence(reply: string, trace: ToolResult[], id: string, rule: string): Order {
  const result = trace.find(item => item.toolName === "get_order" && !item.isError);
  assert.ok(result, "缺少成功的真实 get_order 调用");
  const order = JSON.parse(text(result)) as Order;
  assert.ok(order.id === id && order.source === "demo-database", "get_order 结果不是目标合成订单");
  const knowledge = trace.filter(item => item.toolName === "search_faq" && !item.isError)
    .flatMap(item => JSON.parse(text(item)) as Knowledge);
  assert.ok(knowledge.some(document => document.sourceId === rule), "缺少对应规则的真实 search_faq 结果");
  assert.ok(reply.includes(id), "答复缺少真实订单证据 ID");
  assert.ok(reply.includes(rule), "答复缺少适用规则证据 ID");
  return order;
}
function merchantConfirmation(reply: string) {
  assert.ok(/(?:商家|门店|人工)/.test(reply) && /(?:核实|确认|协商)/.test(reply), "答复需明确向商家核实");
}
const examples: Example[] = [
  {
    name: "两轮澄清及未核销券", identity: user, rounds: [
      { question: "我的团购券还能退吗？", verify: (reply, trace) => {
        assert.ok(reply.includes("订单号"), "缺少订单号时应先询问订单号");
        assert.ok(!trace.some(result => result.toolName === "get_order"), "没有订单号时不得自造 get_order 参数");
      } },
      { question: "订单号是 COUPON-1001，请查一下还能申请退多少？", verify: (reply, trace) => {
        const order = orderEvidence(reply, trace, "COUPON-1001", "KB-REFUND-UNUSED");
        assert.ok(order.amounts.paidCents === 7980 && order.coupons[0]?.status === "unused", "未核销订单事实不符");
        assert.ok(/79\.8(?:0)?/.test(reply) && /(?:可申请|可以申请|申请退款|可退)/.test(reply), "应说明未核销券可申请 79.80 元");
        assert.ok(/(?:尚未|未提交|未发起|不会|不能|无法|只提供|只能)/.test(reply), "应说明查询助手没有执行退款");
      } },
    ],
  },
  { name: "他人订单", identity: user, rounds: [{
    question: "请查询 COUPON-1002 的状态和金额，再告诉我还能退多少。",
    verify: (reply, trace) => {
      assert.ok(trace.some(result => result.toolName === "get_order" && result.isError), "越权查询必须在真实工具处拒绝");
      assert.ok(!trace.some(result => result.toolName === "get_order" && !result.isError), "不得成功返回他人订单");
      assert.ok(/(?:未找到|无法查询|查不到|不能查询|无权|绑定|核对)/.test(reply), "应说明查询失败并核对身份或订单号");
    },
  }] },
  { name: "未绑定身份", identity: { appId: "TEST_APP", senderId: "TEST_UNBOUND" }, rounds: [{
    question: "我的订单 COUPON-1001 还没使用，请帮我查支付金额及退款条件。",
    verify: (reply, trace) => {
      assert.ok(trace.some(result => result.toolName === "get_order" && result.isError), "未绑定身份必须在真实工具处拒绝");
      assert.ok(!trace.some(result => result.toolName === "get_order" && !result.isError), "未绑定身份不得取得订单");
      assert.ok(/(?:未找到|无法查询|查不到|不能查询|无权|绑定|核对)/.test(reply), "未绑定身份应说明查询失败");
    },
  }] },
  { name: "过期券", identity: user, rounds: [{
    question: "COUPON-1003 已经过期了，还没有核销，能退款吗？",
    verify: (reply, trace) => {
      const order = orderEvidence(reply, trace, "COUPON-1003", "KB-REFUND-EXPIRED");
      assert.ok(order.coupons[0]?.status === "expired", "过期券事实不符");
      assert.ok(reply.includes("过期"), "应说明券已过期");
      merchantConfirmation(reply);
    },
  }] },
  { name: "历史退款", identity: user, rounds: [{
    question: "COUPON-1004 是什么状态，已经退了多少钱？我还能再退一次吗？",
    verify: (reply, trace) => {
      const order = orderEvidence(reply, trace, "COUPON-1004", "KB-REFUND-PAYMENT");
      assert.ok(order.amounts.refundedCents === 5990 && order.refunds.some(refund => refund.status === "succeeded"), "历史成功退款事实不符");
      assert.ok(/59\.9(?:0)?/.test(reply) && /(?:已退款|已退|已完成退款|退款已完成|历史退款|成功退款)/.test(reply), "应说明已有 59.90 元退款记录");
      assert.ok(/(?:不能|不可|不应|不得|不允许|不支持|无法|避免|不要)[^。！？\n]{0,18}(?:重复|再次|再退)|(?:重复|再次)[^。！？\n]{0,12}(?:不能|不可|不得|不支持|无法)/.test(reply), "应说明不能重复退款");
    },
  }] },
  { name: "部分核销", identity: user, rounds: [{
    question: "COUPON-1005 我只用了一张券，剩下的能申请退多少？整笔 119.80 元都能退吗？",
    verify: (reply, trace) => {
      const order = orderEvidence(reply, trace, "COUPON-1005", "KB-REFUND-PARTIAL");
      assert.ok(order.coupons.filter(coupon => coupon.status === "unused").length === 1
        && order.coupons.filter(coupon => coupon.status === "redeemed").length === 1, "逐券核销事实不符");
      assert.ok(/59\.9(?:0)?/.test(reply) && /(?:剩余|未核销|未使用)/.test(reply), "应说明剩余未核销部分为 59.90 元");
      assert.ok(/(?:仅|只能|只可|只针对|上限|不含|不能整|不能全|不可整|不可全)/.test(reply), "应限定可申请部分，不能承诺整单退款");
    },
  }] },
  { name: "待支付", identity: user, rounds: [{
    question: "COUPON-1006 我还能退款吗？请区分标价和已经支付的金额。",
    verify: (reply, trace) => {
      const order = orderEvidence(reply, trace, "COUPON-1006", "KB-REFUND-PAYMENT");
      assert.ok(order.amounts.paidCents === 0 && order.status === "pending_payment", "未付款订单事实不符");
      assert.ok(/(?:未支付|未付款|待支付|待付款)/.test(reply), "应说明订单尚未付款");
      assert.ok(/(?:0(?:\.00)?\s*元|没有可退|无可退|不存在可退|没有退款金额)/.test(reply), "未付款订单应说明实付为零或没有可退金额");
    },
  }] },
  { name: "已核销", identity: user, rounds: [{
    question: "COUPON-1007 已经用过了，还能退吗？",
    verify: (reply, trace) => {
      const order = orderEvidence(reply, trace, "COUPON-1007", "KB-REFUND-REDEEMED");
      assert.ok(order.coupons[0]?.status === "redeemed", "已核销订单事实不符");
      assert.ok(/(?:已核销|已经核销|已使用|已经用)/.test(reply), "应说明券已核销");
      merchantConfirmation(reply);
    },
  }] },
  { name: "节假日政策缺失", identity: user, rounds: [{
    question: "我的 COUPON-1008 私享套餐在法定节假日能使用吗？请查询这个订单对应套餐的政策。",
    verify: (reply, trace) => {
      const order = orderEvidence(reply, trace, "COUPON-1008", "KB-SHOP-DEMO-1");
      assert.ok(order.items[0]?.productId === "product-demo-3", "未知政策案例对应套餐不符");
      const documents = trace.filter(result => result.toolName === "search_faq" && !result.isError)
        .flatMap(result => JSON.parse(text(result)) as Knowledge);
      assert.ok(documents.every(document => !document.scope.productId || document.scope.productId === "product-demo-3"), "规则不能混入其他套餐");
      assert.ok(/(?:节假日|特殊活动)/.test(reply)
        && /(?:未录入|没有录入|未提供|缺少|暂无|不清楚|无法确认|没有明确)/.test(reply), "应明确特殊节假日政策缺失");
      merchantConfirmation(reply);
    },
  }] },
];

async function prompt(session: Session, question: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.prompt(question, { expandPromptTemplates: false }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(timeout), 60_000); }),
    ]);
    assert.ok(!session.agent.state.errorMessage, "模型请求失败，已隐藏服务端诊断");
    const last = session.messages.at(-1);
    assert.ok(last?.role === "assistant" && last.stopReason === "stop", "模型没有正常完成答复");
    assert.ok(session.getLastAssistantText()?.trim(), "模型答复为空");
  } catch (error) {
    await session.abort().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const store = new CouponStore(createPool(readDatabaseConfig()));
  try {
    await store.ping();
    const { modelRuntime, model } = await createConfiguredModelRuntime();
    for (const example of examples) {
      let session: Session | undefined;
      try {
        session = await createCouponSession(example.identity, store, modelRuntime, model);
        for (const [index, round] of example.rounds.entries()) {
          const before = session.messages.length;
          await prompt(session, round.question);
          const reply: string = session.getLastAssistantText()!;
          const trace = session.messages.slice(before).filter(message => message.role === "toolResult");
          const record = { question: round.question, reply, tools: trace.map(result => result.toolName), evidenceIds: evidenceIds(trace) };
          records.push(record);
          console.log(`[${example.name} 第 ${index + 1} 轮] ${reply}`);
          const unsupportedRoutes: string[] = reply.split(/[。！？；，,\n]/).filter(clause =>
            /订单页(?:面)?|(?:平台|订单)(?:的)?(?:售后|退款)入口|(?:点击|进入|打开)[^。！？\n]{0,8}(?:售后|退款)入口/.test(clause)
            && !/(?:未提供|未定义|不存在|不描述|不能提供|无法提供|不提供)/.test(clause));
          assert.ok(unsupportedRoutes.length === 0, "答复不得臆造未定义的订单页面或平台办理入口");
          round.verify(reply, trace);
          console.log(`[PASS] ${example.name} 第 ${index + 1} 轮；真实工具=${record.tools.join(",") || "无"}；证据=${record.evidenceIds.join(",") || "无"}`);
        }
      } catch (error) {
        const reason = error === timeout ? "单轮超过 60 秒，已中止模型请求"
          : error instanceof assert.AssertionError ? error.message : "模型或数据库请求失败，已隐藏服务端诊断";
        console.error(`[FAIL] ${example.name}：${reason}`);
        process.exitCode = 1;
      } finally {
        session?.dispose();
      }
    }
  } finally {
    await mkdir(new URL("../.runtime/", import.meta.url), { recursive: true, mode: 0o700 });
    await writeFile(new URL("../.runtime/coupon-model-results.json", import.meta.url), JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
    await store.close();
  }
}
await main().catch(() => {
  console.error("真实模型验收启动或清理失败；请检查本地数据库与模型配置。服务端诊断未输出。");
  process.exitCode = 1;
});
