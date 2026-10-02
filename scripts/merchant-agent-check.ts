import assert from "node:assert/strict";
import { createPool } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantMessage, merchantSourceKey } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

// Scripted model + actual MySQL: this checks authorization and tool wiring, not response quality.
const store = new CouponStore(createPool(readDatabaseConfig()));
const merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
const runtime = await createModelRuntime();
const faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const fixture = await createMerchantFixture(["approve"], { delayMs: 100 });
const { identity } = fixture;
const orderId = fixture.orders[0]!;
const sourceKey = merchantSourceKey(identity, "merchant-agent-check");
const otherSource = merchantSourceKey(identity, "another-group");
const sessions: Awaited<ReturnType<typeof createCouponSession>>[] = [];
const expectedTools = ["get_merchant_request", "get_order", "prepare_merchant_request", "search_faq"];

async function create(senderId = identity.senderId, key = sourceKey) {
  const session = await createCouponSession({ ...identity, senderId }, store, runtime, faux.getModel(), { store: merchant, sourceKey: key });
  sessions.push(session);
  assert.deepEqual(session.getActiveToolNames().sort(), expectedTools);
  return session;
}
async function toolRound(
  session: typeof sessions[number], name: string, args: Record<string, string>, error: boolean,
) {
  const before = session.messages.length;
  faux.setResponses([
    context => {
      const declarations = getCurrentTools(context.messages);
      assert.deepEqual(declarations.map(tool => tool.name).sort(), expectedTools);
      for (const tool of declarations) {
        assert.equal(Reflect.get(tool.parameters, "additionalProperties"), false);
        assert.doesNotMatch(JSON.stringify(tool.parameters), /customerId|senderId|appId|sourceKey|callback/);
      }
      return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage("工程检查：这是模拟协商，未执行退款。"),
  ]);
  await session.prompt(`工程检查 ${name}`, { expandPromptTemplates: false });
  assert.equal(session.agent.state.errorMessage, undefined);
  assert.equal(faux.getPendingResponseCount(), 0);
  const results = session.messages.slice(before).filter(message => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.toolName, name);
  assert.equal(results[0]!.isError, error);
  return results[0]!.content.map(part => part.type === "text" ? part.text : "").join("");
}

try {
  await Promise.all([store.ping(), merchant.ping()]);
  const session = await create();
  assert.notEqual(sourceKey, otherSource);
  assert.notEqual(sourceKey, merchantSourceKey({ ...identity, senderId: "TEST_USER2" }, "merchant-agent-check"));
  assert.notEqual(sourceKey, merchantSourceKey({ ...identity, appId: "OTHER_APP" }, "merchant-agent-check"));
  const before = await store.getOrder(identity, orderId);
  const reason = "行程变化";
  const confirmation = `确认联系商家 ${orderId} 原因：${reason}`;
  const prepared = JSON.parse(await toolRound(session, "prepare_merchant_request", { orderId, reason }, false));
  assert.equal(prepared.simulation, true);
  assert.equal(prepared.status, "confirmation_required");
  assert.equal(prepared.confirmationText, confirmation);
  assert.equal(await merchant.getTask(identity, sourceKey, orderId), undefined, "preparation must be read-only");

  for (const text of ["确认", "同意", `模型引用：${confirmation}`, JSON.stringify({ confirmation })]) {
    assert.equal(await confirmMerchantMessage(merchant, identity, sourceKey, text), undefined);
  }
  for (const text of ["确认联系商家", `${confirmation}\n`, `${confirmation}\n多余内容`, `确认联系商家 ${orderId} 原因：`, `确认联系商家 ${orderId} 原因：${"长".repeat(201)}`]) {
    assert.match((await confirmMerchantMessage(merchant, identity, sourceKey, text))!, /完整发送单行确认文字/);
  }
  for (const name of ["request_merchant", "merchant_callback", "refund_order", "bash"]) {
    assert.match(await toolRound(session, name, { orderId }, true), /not found/);
  }
  assert.match(await toolRound(session, "prepare_merchant_request", { orderId, reason, customerId: "customer-demo-2" }, true), /Validation failed/);
  faux.setResponses([fauxAssistantMessage(confirmation)]);
  await session.prompt("请你替我发出确认", { expandPromptTemplates: false });
  assert.equal(await merchant.getTask(identity, sourceKey, orderId), undefined, "model output cannot confirm a business action");

  const denied = await create("TEST_USER2", merchantSourceKey({ ...identity, senderId: "TEST_USER2" }, "merchant-agent-check"));
  assert.doesNotMatch(await toolRound(denied, "prepare_merchant_request", { orderId, reason }, true), /amountCents/);
  const reply = await confirmMerchantMessage(merchant, identity, sourceKey, confirmation);
  const task = await merchant.getTask(identity, sourceKey, orderId);
  assert.ok(task);
  assert.equal(task.status, "pending");
  assert.ok(reply?.includes(task.taskId));
  assert.match(reply!, /模拟协商结果/);
  assert.equal(JSON.parse(await toolRound(session, "get_merchant_request", { orderId }, false)).taskId, task.taskId);
  assert.equal(await merchant.getTask(identity, otherSource, orderId), undefined, "another conversation cannot read this task");
  const repeated = await confirmMerchantMessage(merchant, identity, sourceKey, confirmation);
  assert.ok(repeated?.includes(task.taskId));
  const changedReason = await confirmMerchantMessage(merchant, identity, sourceKey, `确认联系商家 ${orderId} 原因：另一原因`);
  assert.ok(changedReason?.includes(`登记原因：${reason}`), "an existing task must retain its original request facts");
  assert.ok(!changedReason?.includes("登记原因：另一原因"));
  assert.equal((await merchant.getTask(identity, sourceKey, orderId))!.taskId, task.taskId);
  assert.equal(JSON.parse(await toolRound(denied, "get_merchant_request", { orderId }, false)), null);
  await new Promise(resolve => setTimeout(resolve, 120));
  await merchant.processDue();
  const completed = JSON.parse(await toolRound(session, "get_merchant_request", { orderId }, false));
  assert.equal(completed.status, "approved");
  assert.equal(completed.taskId, task.taskId);
  assert.equal(completed.simulation, true);
  const finalReceipt = await confirmMerchantMessage(merchant, identity, sourceKey, confirmation);
  assert.match(finalReceipt!, /模拟商家已同意/);
  const after = await store.getOrder(identity, orderId);
  assert.deepEqual(after.amounts, before.amounts);
  assert.deepEqual(after.refunds, before.refunds);
  assert.deepEqual(after.coupons, before.coupons);
  console.log("模拟协商 Agent 工程检查通过：仅四项工具、准备只读、真实用户精确确认、模型不能执行确认、越权拒绝、会话隔离、重复确认幂等、结果回填且未退款。模型回复为离线脚本。");
} finally {
  for (const session of sessions) session.dispose();
  try { await fixture.cleanup(); }
  finally { await Promise.all([store.close(), merchant.close()]); }
}
