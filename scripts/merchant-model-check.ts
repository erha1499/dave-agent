import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "mysql2/promise";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createConfiguredModelRuntime, createCouponSession } from "../src/agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig, startMockMerchant } from "../src/after-sales.ts";
import { confirmMerchantMessage, merchantSourceKey } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

// Actual model + MySQL + QQ handler; outgoing QQ messages are captured locally.
async function main() {
  const { modelRuntime, model } = await createConfiguredModelRuntime();
  const fixture = await createMerchantFixture(["approve"], { delayMs: 5000 });
  const store = new CouponStore(createPool(readDatabaseConfig()));
  const merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
  const stop = startMockMerchant(merchant);
  const { identity } = fixture;
  const orderId = fixture.orders[0]!;
  const groupOpenid = "merchant-model-check";
  const sourceKey = merchantSourceKey(identity, groupOpenid);
  let session: Awaited<ReturnType<typeof createCouponSession>> | undefined;
  let modelCalls = 0;
  const replies: string[] = [];
  const agent = new QQAgent(async () => {
    session = await createCouponSession(identity, store, modelRuntime, model, { store: merchant, sourceKey });
    session.subscribe(event => { if (event.type === "turn_start") modelCalls++; });
    return session;
  }, async (_target, text) => { replies.push(text); }, () => {}, 60_000,
  msg => confirmMerchantMessage(merchant, identity, sourceKey, msg.content));

  async function turn(content: string, host = false) {
    const id = randomUUID(), timestamp = new Date().toISOString();
    const msg: QQBotInboundMessage = {
      kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId,
      groupOpenid, messageId: id, content, timestamp,
      replyTarget: { scope: "group", targetId: groupOpenid, msgId: id },
      raw: { id, content, timestamp, group_openid: groupOpenid, author: { member_openid: identity.senderId } },
    };
    const before = session?.messages.length ?? 0;
    const count = replies.length;
    await agent.handle(msg);
    assert.equal(replies.length, count + 1, "每轮应产生一条 QQ 回复");
    assert.ok(session, "QQ 会话未建立");
    const reply = replies.at(-1)!;
    assert.doesNotMatch(reply, /客服暂时无法处理/);
    const trace = session.messages.slice(before).filter(item => item.role === "toolResult");
    assert.ok(trace.every(item => !item.isError), "不应发生工具执行错误");
    if (!host) {
      const last = session.messages.at(-1);
      assert.ok(last?.role === "assistant" && last.stopReason === "stop", "模型未正常结束");
    }
    console.log(`通过：${host ? "宿主确认" : "模型回复"}；工具=${trace.map(item => item.toolName).join(",") || "无"}`);
    return { reply, trace };
  }

  try {
    const before = await store.getOrder(identity, orderId);
    const confirmation = `确认联系商家 ${orderId} 原因：行程变化`;
    const prepared = await turn(`订单 ${orderId} 因行程变化想退款，请帮我联系商家协商，原因就写“行程变化”。`);
    for (const name of ["get_order", "search_faq", "prepare_merchant_request"]) {
      assert.ok(prepared.trace.some(item => item.toolName === name), `准备阶段缺少 ${name} 证据`);
    }
    assert.ok(prepared.reply.includes(confirmation), "应展示完整确认文字");
    assert.equal(await merchant.getTask(identity, sourceKey, orderId), undefined, "模型准备不得创建任务");
    const calls = modelCalls;
    await turn(confirmation, true);
    assert.equal(modelCalls, calls, "宿主确认不应启动模型");
    const task = await merchant.getTask(identity, sourceKey, orderId);
    assert.equal(task?.status, "pending");
    const faq = await turn("等商家回复期间，先告诉我团购券未核销退款的一般规则。");
    assert.ok(faq.trace.some(item => item.toolName === "search_faq"), "等待期间应能继续查询规则");
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await merchant.getTask(identity, sourceKey, orderId))?.status !== "pending") break;
      await delay(100);
    }
    assert.equal((await merchant.getTask(identity, sourceKey, orderId))?.status, "approved");
    const progress = await turn("刚才那笔协商现在有结果了吗？钱退了吗？");
    const result = progress.trace.find(item => item.toolName === "get_merchant_request");
    assert.ok(result, "应通过回执上下文找回订单并查询进度");
    const evidence = JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
    assert.equal(evidence.taskId, task!.taskId);
    assert.equal(evidence.status, "approved");
    assert.ok(progress.reply.includes(orderId));
    assert.match(progress.reply, /模拟/);
    assert.match(progress.reply, /79\.80/);
    assert.match(progress.reply, /退款状态请另行查询/);
    const after = await store.getOrder(identity, orderId);
    assert.deepEqual(after.amounts, before.amounts);
    assert.deepEqual(after.refunds, before.refunds);
    assert.deepEqual(after.coupons, before.coupons);
    console.log(`PASS ${model.provider}/${model.id}：3 轮真实模型 + 1 轮宿主确认，模拟协商、期间咨询、原会话查询闭环。未连接 QQ 平台，未退款。`);
  } finally {
    try { await agent.close(); }
    finally {
      await stop();
      try { await fixture.cleanup(); }
      finally { await Promise.all([merchant.close(), store.close()]); }
    }
  }
}

main().catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message : "商家模型检查失败；已隐藏模型或数据库诊断。");
  process.exitCode = 1;
});
