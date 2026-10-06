import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { confirmMerchantReply } from "../src/after-sales-entry.ts";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";
import { RefundStore, readRefundDatabaseConfig, type RefundOperation } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import { QQAgent } from "../src/qq-agent.ts";
import type { RenderedReply } from "../src/reply.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

type Input = { identity: QQIdentity; group: string; orderId: string };
type Mode = "complete" | "query";
type Output = { pid: number; mode: Mode; inputHash: string; order: Awaited<ReturnType<CouponStore["getOrder"]>>;
  operation: RefundOperation; tools: Array<{ name: string; value: unknown }>; modelCalls: number; remoteRequests: number; reply: RenderedReply };
type Snapshot = Record<string, RowDataPacket[]>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const root = fileURLToPath(new URL("../", import.meta.url));
function validateInput(input: Input) {
  assert.deepEqual(Object.keys(input).sort(), ["group", "identity", "orderId"]);
  assert.deepEqual(input.identity, { appId: "TEST_APP", senderId: "TEST_USER1" });
  assert.match(input.group, /^atomic-refund-[a-f0-9-]{36}$/); assert.match(input.orderId, /^COUPON-2[1-9]\d{2}$/);
}
function localConfig() {
  const configs = [readDatabaseConfig(), readAfterSalesDatabaseConfig(), readRefundDatabaseConfig()];
  for (const config of configs) assert.ok(["127.0.0.1", "localhost"].includes(String(config.host))
    && Number(config.port) === 13306 && config.database === "dave_agent", "Only the local Docker fixture database is allowed");
  return configs;
}
async function child(mode: Mode, input: Input): Promise<Output> {
  validateInput(input); assert.ok(mode === "complete" || mode === "query"); const configs = localConfig();
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const business = new CouponStore(createPool(configs[0]!)), merchant = new AfterSalesStore(createPool(configs[1]!));
  const refunds = new RefundStore(createPool(configs[2]!)), sourceKey = merchantSourceKey(input.identity, input.group);
  const originalFetch = globalThis.fetch; let remoteRequests = 0;
  globalThis.fetch = async () => { remoteRequests++; throw new Error("Remote HTTP is forbidden in this engineering check"); };
  let session: Awaited<ReturnType<typeof createCouponSession>> | undefined;
  const replies: RenderedReply[] = [], tools: Output["tools"] = [];
  const agent = new QQAgent(async () => {
    session = await createCouponSession(input.identity, business, runtime, faux.getModel(), { store: merchant, sourceKey, refunds });
    assert.deepEqual(session.getActiveToolNames().sort(), ["get_merchant_request", "get_order", "get_refund", "prepare_merchant_request", "prepare_refund", "search_faq"]);
    return session;
  }, async (target, _text, reply, requester) => {
    assert.equal(target.targetId, input.group); assert.equal(requester, input.identity.senderId); replies.push(structuredClone(reply));
  }, () => {}, 10_000, async message => await confirmRefundReply(refunds, input.identity, sourceKey, message.content)
    ?? await confirmMerchantReply(merchant, input.identity, sourceKey, message.content),
  (_message, reply) => markRefundReplyPresented(refunds, input.identity, sourceKey, reply));
  async function turn(text: string, calls: Array<{ name: string; args: Record<string, string> }> = []) {
    const before = session?.messages.length ?? 0, sent = replies.length, modelCalls = faux.state.callCount;
    faux.setResponses(calls.length ? [...calls.map(call => () => fauxAssistantMessage(fauxToolCall(call.name, call.args), { stopReason: "toolUse" })),
      () => fauxAssistantMessage("仅返回本轮工具查得的模拟业务结果。")] : []);
    const id = randomUUID(), timestamp = new Date().toISOString();
    await agent.handle({ kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: input.identity.senderId,
      groupOpenid: input.group, messageId: id, content: text, timestamp, replyTarget: { scope: "group", targetId: input.group, msgId: id },
      raw: { id, content: text, timestamp, group_openid: input.group, author: { member_openid: input.identity.senderId } } } as QQBotInboundMessage);
    assert.equal(faux.getPendingResponseCount(), 0); assert.equal(session?.agent.state.errorMessage, undefined);
    assert.equal(replies.length, sent + 1); assert.equal(faux.state.callCount - modelCalls, calls.length ? calls.length + 1 : 0);
    const results = session?.messages.slice(before).filter(message => message.role === "toolResult") ?? [];
    assert.deepEqual(results.map(result => result.toolName), calls.map(call => call.name));
    for (const result of results) {
      assert.equal(result.isError, false); tools.push({ name: result.toolName,
        value: JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join("")) });
    }
    return replies.at(-1)!;
  }
  const orderCall = { name: "get_order", args: { orderId: input.orderId } };
  const faq = { name: "search_faq", args: { query: "未核销退款", shopId: "shop-demo-1", productId: "product-demo-1" } };
  try {
    await Promise.all([business.ping(), merchant.ping(), refunds.ping()]);
    if (mode === "complete") {
      const proposal = await turn(`订单 ${input.orderId} 因行程变化，请准备联系商家。`, [orderCall, faq,
        { name: "prepare_merchant_request", args: { orderId: input.orderId, reason: "行程变化" } }]);
      assert.equal(proposal.kind, "merchant_confirmation"); assert.ok(proposal.button && proposal.text.split("\n").includes(proposal.button.command));
      assert.equal(await merchant.getTask(input.identity, sourceKey, input.orderId), undefined);
      assert.equal((await turn(proposal.button.command)).kind, "merchant_status");
      const task = await merchant.getTask(input.identity, sourceKey, input.orderId); assert.ok(task); assert.equal(task.status, "pending");
      assert.equal(await merchant.applyResult({ taskId: task.taskId, orderId: input.orderId, status: "approved", approvedAmountCents: task.amountCents }), true);
      const prepared = await turn(`订单 ${input.orderId} 请准备模拟退款方案。`, [orderCall, faq,
        { name: "get_merchant_request", args: { orderId: input.orderId } }, { name: "prepare_refund", args: { orderId: input.orderId } }]);
      assert.equal(prepared.kind, "refund_confirmation"); assert.ok(prepared.button && prepared.text.split("\n").includes(prepared.button.command));
      const awaiting = await refunds.get(input.identity, sourceKey, input.orderId); assert.equal(awaiting?.status, "awaiting_confirmation");
      assert.ok(awaiting?.presentedAt); assert.equal((await business.getOrder(input.identity, input.orderId)).amounts.refundedCents, 0);
      const receipt = await turn(prepared.button.command); assert.equal(receipt.kind, "refund_status");
      assert.deepEqual(await turn(prepared.button.command), receipt, "An exact duplicate confirmation returns the same receipt");
    } else await turn(`请查询订单 ${input.orderId} 的退款结果和订单金额。`, [orderCall, { name: "get_refund", args: { orderId: input.orderId } }]);
    const order = mode === "query" ? tools.find(item => item.name === "get_order")!.value as Output["order"] : await business.getOrder(input.identity, input.orderId);
    const operation = mode === "query" ? tools.find(item => item.name === "get_refund")!.value as RefundOperation : await refunds.get(input.identity, sourceKey, input.orderId);
    assert.ok(operation?.refundId); assert.equal(operation.status, "succeeded"); assert.equal(remoteRequests, 0);
    assert.equal(replies.at(-1)?.kind, "refund_status"); assert.ok(replies.at(-1)!.text.includes(operation.refundId));
    return { pid: process.pid, mode, inputHash: hash(input), order, operation, tools, modelCalls: faux.state.callCount, remoteRequests, reply: replies.at(-1)! };
  } finally {
    try { await agent.close(); } finally { globalThis.fetch = originalFetch; await Promise.all([business.close(), merchant.close(), refunds.close()]); }
  }
}
async function snapshot(pool: Pool, orderId: string): Promise<Snapshot> {
  const queries: Record<string, string> = { orders: "SELECT * FROM orders WHERE id=?", items: "SELECT * FROM order_items WHERE order_id=? ORDER BY id",
    coupons: "SELECT c.* FROM coupons c JOIN order_items i ON i.id=c.order_item_id WHERE i.order_id=? ORDER BY c.id",
    payments: "SELECT * FROM payments WHERE order_id=? ORDER BY id", tasks: "SELECT * FROM merchant_requests WHERE order_id=? ORDER BY task_id",
    operations: "SELECT * FROM refund_operations WHERE order_id=? ORDER BY operation_id", refunds: "SELECT * FROM refunds WHERE order_id=? ORDER BY id",
    notifications: "SELECT n.* FROM merchant_notifications n JOIN merchant_requests r ON r.task_id=n.task_id WHERE r.order_id=? ORDER BY n.task_id",
    scenarios: "SELECT * FROM merchant_demo_scenarios WHERE order_id=?" };
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, sql]) => [name, (await pool.execute<RowDataPacket[]>(sql, [orderId]))[0]])));
}
function verifyOutput(value: Output, input: Input, db: Snapshot) {
  assert.equal(value.inputHash, hash(input)); assert.equal(value.remoteRequests, 0); assert.equal(value.order.id, input.orderId);
  assert.equal(value.order.status, "refunded"); assert.equal(value.operation.status, "succeeded"); assert.equal(value.operation.orderId, input.orderId);
  assert.equal(db.orders.length, 1); assert.equal(db.tasks.length, 1); assert.equal(db.operations.length, 1); assert.equal(db.refunds.length, 1);
  assert.equal(db.notifications.length, 0, "This check neither stores a notification route nor dispatches notifications");
  const order = db.orders[0]!, operation = db.operations[0]!, refund = db.refunds[0]!;
  assert.equal(order.status, "refunded"); assert.equal(order.refunded_cents, order.paid_cents);
  assert.equal(refund.status, "succeeded"); assert.equal(refund.amount_cents, order.paid_cents); assert.equal(operation.status, "succeeded");
  assert.equal(db.tasks[0]!.status, "approved"); assert.equal(db.tasks[0]!.approved_amount_cents, refund.amount_cents);
  assert.equal(db.tasks[0]!.task_id, operation.task_id); assert.equal(db.tasks[0]!.source_key, merchantSourceKey(input.identity, input.group));
  assert.ok(db.coupons.length && db.coupons.every(coupon => coupon.status === "refunded"));
  assert.equal(value.order.amounts.refundedCents, Number(order.refunded_cents)); assert.equal(value.operation.amountCents, Number(refund.amount_cents));
  assert.equal(value.operation.operationId, operation.operation_id); assert.equal(value.operation.refundId, refund.id); assert.equal(operation.refund_id, refund.id);
  assert.equal(value.reply.kind, "refund_status"); assert.ok(value.reply.text.includes(String(refund.id)));
}
export async function checkAtomicRefundRecoveryDatabase() {
  const configs = localConfig();
  const fixture = await createMerchantFixture(["approve"], { delayMs: 5000 });
  const pool = createPool(configs[0]!);
  const input: Input = { identity: fixture.identity, group: `atomic-refund-${randomUUID()}`, orderId: fixture.orders[0]! };
  const run = (mode: Mode): Output => {
    const processResult = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--child=${mode}`], {
      cwd: root, input: JSON.stringify(input), env: process.env, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 });
    assert.equal(processResult.status, 0, `Atomic refund child failed: ${JSON.stringify({ mode, status: processResult.status,
      signal: processResult.signal, error: processResult.error?.message, stdout: processResult.stdout?.slice(-5000), stderr: processResult.stderr?.slice(-5000) })}`);
    assert.equal(processResult.signal, null); const output = JSON.parse(processResult.stdout.trim()) as Output;
    assert.ok(Number.isSafeInteger(output.pid) && output.pid !== process.pid); assert.equal(output.mode, mode); return output;
  };
  const errors: unknown[] = [];
  try {
    const first = run("complete"), completed = await snapshot(pool, input.orderId); verifyOutput(first, input, completed);
    const second = run("query"), recovered = await snapshot(pool, input.orderId); verifyOutput(second, input, recovered);
    assert.notEqual(first.pid, second.pid); assert.deepEqual(second.tools.map(tool => tool.name), ["get_order", "get_refund"]);
    assert.deepEqual(second.operation, first.operation); assert.deepEqual(recovered, completed, "The new process only reads durable results");
    console.log(JSON.stringify({ passed: true, architecture: "atomic", knowledge: "lexical", childPids: [first.pid, second.pid],
      orderId: input.orderId, refundId: second.operation.refundId, amountCents: second.operation.amountCents,
      snapshotHashBeforeQuery: hash(completed), snapshotHashAfterQuery: hash(recovered), model: "Pi faux", remoteRequests: 0,
      qq: "local send only; no merchant notification dispatcher", confirmation: "actual displayed commands, host hooks, duplicate idempotent" }));
  } catch (error) { errors.push(error); }
  finally {
    try { await fixture.cleanup(); const remaining = await snapshot(pool, input.orderId);
      assert.ok(Object.values(remaining).every(rows => rows.length === 0));
      console.log(JSON.stringify({ cleanup: true, orderId: input.orderId, remaining: Object.fromEntries(Object.entries(remaining).map(([name, rows]) => [name, rows.length])) }));
    } catch (error) { errors.push(error); }
    finally { try { await pool.end(); } catch (error) { errors.push(error); } }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Atomic refund execution and cleanup failures retained");
}
export function checkAtomicRefundRecovery() {
  const input: Input = { identity: { appId: "TEST_APP", senderId: "TEST_USER1" }, group: `atomic-refund-${randomUUID()}`, orderId: "COUPON-2101" };
  validateInput(input); assert.throws(() => validateInput({ ...input, refundId: randomUUID() } as Input));
  assert.throws(() => validateInput({ ...input, identity: { ...input.identity, senderId: "TEST_USER2" } }));
  assert.throws(() => validateInput({ ...input, orderId: "COUPON-1001" }));
  assert.throws(() => validateInput({ ...input, group: "another-group" }));
  const refundId = randomUUID(), operationId = randomUUID(), taskId = randomUUID();
  const db = { orders: [{ status: "refunded", paid_cents: 7980, refunded_cents: 7980 }], coupons: [{ status: "refunded" }],
    tasks: [{ task_id: taskId, status: "approved", approved_amount_cents: 7980, source_key: merchantSourceKey(input.identity, input.group) }],
    operations: [{ operation_id: operationId, task_id: taskId, refund_id: refundId, status: "succeeded" }],
    refunds: [{ id: refundId, status: "succeeded", amount_cents: 7980 }], notifications: [] } as unknown as Snapshot;
  const value = { inputHash: hash(input), remoteRequests: 0, order: { id: input.orderId, status: "refunded", amounts: { refundedCents: 7980 } },
    operation: { status: "succeeded", orderId: input.orderId, operationId, refundId, amountCents: 7980 },
    reply: { kind: "refund_status", text: refundId } } as Output;
  verifyOutput(value, input, db);
  for (const alter of [(copy: Snapshot) => { copy.notifications.push({} as RowDataPacket); },
    (copy: Snapshot) => { copy.refunds[0]!.amount_cents = 7979; }, (copy: Snapshot) => { copy.tasks[0]!.status = "pending"; }]) {
    const changed = structuredClone(db); alter(changed); assert.throws(() => verifyOutput(value, input, changed));
  }
  assert.throws(() => verifyOutput({ ...value, operation: { ...value.operation, refundId: randomUUID() } }, input, db));
  console.log("Atomic refund recovery pure checks passed; no DB, model or QQ requests. --db performs the two-process fixture check.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === "--check") checkAtomicRefundRecovery();
  else if (args.length === 1 && args[0] === "--db") await checkAtomicRefundRecoveryDatabase();
  else if (args.length === 1 && ["--child=complete", "--child=query"].includes(args[0]!)) {
    console.log(JSON.stringify(await child(args[0]!.slice(8) as Mode, JSON.parse(readFileSync(0, "utf8")) as Input)));
  } else throw new Error("Use --check or --db; DB execution is explicit and local only.");
}
