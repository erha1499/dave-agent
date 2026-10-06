import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { ConversationStateStore } from "../src/conversation-state.ts";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { readRefundDatabaseConfig } from "../src/refunds.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

type Input = { identity: QQIdentity; group: string; orderA: string; orderB: string; taskId: string; oldCommand?: string; expiresAt?: number };
type Output = { pid: number; command?: string; expiresAt?: number };
type Host = { kind?: string; orderId?: string; taskReference?: { taskId: string } | null };
const hostReference = (context: TranscriptContext): Host => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text))
  .map(text => { try { return JSON.parse(text) as Host; } catch { return {}; } }).filter(value => value.kind === "host_order_reference").at(-1) ?? {};

function admin(sql: string) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("独立任务恢复 fixture 准备或清理失败。");
}

async function child(mode: string, input: Input): Promise<Output> {
  assert.ok(["focus", "recover", "choose", "rechoose", "selected"].includes(mode));
  const business = new CouponStore(createPool(readDatabaseConfig()));
  const merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
  const contexts = new ConversationStateStore(createPool(readAfterSalesDatabaseConfig()));
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const sourceKey = merchantSourceKey(input.identity, input.group), port = contexts.bind(input.identity, input.group);
  const reads: string[] = [];
  const session = await createSupportSession(input.identity, {
    getOrder: async (who: QQIdentity, id: string) => { reads.push(`order:${id}`); return business.getOrder(who, id); },
    searchKnowledge: async () => { throw new Error("Task/status recovery cannot require FAQ retrieval"); },
  } as unknown as CouponStore, runtime, faux.getModel(), { sourceKey, store: {
    listTaskReferences: (...args: Parameters<AfterSalesStore["listTaskReferences"]>) => merchant.listTaskReferences(...args),
    getTask: async (...args: Parameters<AfterSalesStore["getTask"]>) => {
      reads.push(`task:${args[2]}`); return merchant.getTask(...args);
    },
    prepare: async () => { throw new Error("No task preparation is authorized in this check"); },
  } as unknown as AfterSalesStore }, { groupOpenid: input.group, context: port });
  let sequence = 0;
  async function turn(text: string, action?: ContextSupportAction | ((host: Host) => ContextSupportAction)) {
    const requestId = `task-child-${process.pid}-${++sequence}`;
    let host: Host | undefined;
    prepareSupportPrompt(session, { requestId, groupOpenid: input.group, messageId: requestId });
    faux.setResponses(action ? [context => {
      host = hostReference(context);
      return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(host) : action }), { stopReason: "toolUse" });
    }, () => fauxAssistantMessage("仅展示本轮已核验的模拟任务结果。")] : []);
    const before = faux.state.callCount, beforeReads = reads.length;
    await session.prompt(text, { expandPromptTemplates: false });
    assert.equal(session.agent.state.errorMessage, undefined); assert.equal(faux.getPendingResponseCount(), 0);
    if (!action) { assert.equal(faux.state.callCount, before); assert.equal(reads.length, beforeReads); }
    return { requestId, host, result: getSupportResult(session), receipt: getSupportHostReceipt(session), reply: supportReply(session) };
  }
  const taskAction = (host: Host): ContextSupportAction => ({ protocol: "v2.2", kind: "merchant_status",
    taskRef: { taskId: host.taskReference?.taskId ?? "missing-host-reference" } });
  function command(checked: Awaited<ReturnType<typeof turn>>) {
    const choices = checked.result?.evidence.taskChoices;
    const candidate = choices?.candidates.find(row => row.reference.taskId === input.taskId);
    assert.ok(candidate); assert.ok(checked.reply && "text" in checked.reply);
    assert.ok(checked.reply.text.includes(input.orderA));
    const value = checked.reply.text.split("\n").find(line => line === `选择任务 ${candidate.token}`);
    assert.ok(value, "Select only a command in the actual reply");
    return { command: value, expiresAt: candidate.reference.expiresAt };
  }
  async function verifyFocus() {
    assert.equal((await port.read()).value?.focus?.orderId, input.orderB, "Task selection/query must preserve the B order focus");
  }
  try {
    if (mode === "focus") {
      const queried = await turn(`查询 ${input.orderB}`, { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: input.orderB } });
      assert.equal(queried.result?.evidence.order?.id, input.orderB); await verifyFocus();
      return { pid: process.pid };
    }
    await verifyFocus();
    if (mode === "choose" || mode === "rechoose") {
      if (mode === "rechoose") {
        assert.ok(input.oldCommand);
        const rejected = await turn(input.oldCommand); assert.equal(rejected.receipt?.outcome, "rejected");
      }
      const attempted = await turn("之前那笔商家协商到哪一步了？", { protocol: "v2.2", kind: "merchant_status", taskRef: { taskId: input.taskId } });
      assert.equal(attempted.host?.taskReference, null); assert.equal(attempted.result?.outcome, "clarification");
      assert.deepEqual(reads, [], "A model-supplied candidate cannot bypass task ambiguity");
      const offered = command(attempted);
      if (input.oldCommand) assert.notEqual(offered.command, input.oldCommand);
      if (input.expiresAt) assert.equal(offered.expiresAt, input.expiresAt, "Rebuilding/redisplaying cannot renew the task source TTL");
      const selected = await turn(offered.command); assert.equal(selected.receipt?.outcome, "selected");
      await verifyFocus();
      const saved = (await port.read()).value;
      assert.ok(saved?.version === 4 && saved.taskContext?.selected?.taskId === input.taskId);
      assert.equal(saved.taskContext.selected.orderId, input.orderA);
      return { pid: process.pid, ...offered };
    }
    const followed = await turn("刚才商家任务现在处理到哪了？", taskAction);
    assert.equal(followed.host?.orderId, input.orderB); assert.equal(followed.host?.taskReference?.taskId, input.taskId);
    assert.equal(followed.result?.outcome, "ready"); assert.equal(followed.result?.evidence.order?.id, input.orderA);
    assert.equal(followed.result.evidence.task?.taskId, input.taskId); assert.equal(followed.result.evidence.task.status, "approved");
    assert.equal(followed.result.verifiedOrderId, undefined); await verifyFocus();
    assert.deepEqual(reads, [`order:${input.orderA}`, `task:${input.orderA}`]);
    const ordinary = await turn("继续看这笔订单的当前状态", { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } });
    assert.equal(ordinary.result?.evidence.order?.id, input.orderB); await verifyFocus();
    assert.deepEqual(reads, [`order:${input.orderA}`, `task:${input.orderA}`, `order:${input.orderB}`]);
    return { pid: process.pid };
  } finally {
    session.dispose(); await Promise.allSettled([business.close(), merchant.close(), contexts.close()]);
  }
}

export async function checkSupportTaskRecoveryDatabase() {
  const fixture = await createMerchantFixture(["approve", "approve", "approve"], { delayMs: 5000 });
  const [orderA, orderB, orderC] = fixture.orders as [string, string, string];
  const nonce = randomBytes(8).toString("hex"), identity = { appId: `TASK_${nonce}`, senderId: `OWNER_${nonce}` }, group = `task_recovery_${nonce}`;
  const sourceKey = merchantSourceKey(identity, group);
  const merchant = new AfterSalesStore(createPool(readAfterSalesDatabaseConfig()));
  const contexts = new ConversationStateStore(createPool(readAfterSalesDatabaseConfig()));
  const business = new CouponStore(createPool(readDatabaseConfig()));
  const query = createPool(readRefundDatabaseConfig());
  let qq: QQAgent | undefined;
  function run(mode: string, input: Input): Output {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--task-child=${mode}`], {
      input: JSON.stringify(input), encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000,
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env,
    });
    assert.equal(result.status, 0, `Synthetic task child ${mode} failed: ${result.stderr.slice(-6000)}`);
    assert.equal(result.signal, null); const output = JSON.parse(result.stdout.trim()) as Output;
    assert.ok(Number.isSafeInteger(output.pid)); return output;
  }
  try {
    admin(`INSERT INTO qq_identities (app_id,sender_id,customer_id) SELECT '${identity.appId}','${identity.senderId}',customer_id
      FROM qq_identities WHERE app_id='TEST_APP' AND sender_id='TEST_USER1';`);
    const task = await merchant.request(identity, sourceKey, orderA, "独立任务恢复检查", {
      groupOpenid: group, messageId: `confirmation_${nonce}`, timestamp: new Date().toISOString(),
    });
    const input: Input = { identity, group, orderA, orderB, taskId: task.taskId };
    const first = run("focus", input), beforeEvent = await contexts.bind(identity, group).read();
    assert.equal(await merchant.applyResult({ taskId: task.taskId, orderId: orderA, status: "approved", approvedAmountCents: 7980 }), true);
    const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
    let sends = 0;
    qq = new QQAgent(() => createSupportSession(identity, business, runtime, faux.getModel(), { sourceKey, store: merchant }, {
      groupOpenid: group, context: contexts.bind(identity, group),
    }), async (_target, _text, reply, requester) => {
      sends++; assert.equal(requester, identity.senderId); assert.equal(reply.kind, "merchant_status"); assert.ok(reply.text.includes(orderA));
    }, () => {}, 5000, undefined, undefined, { merchantEvents: "host" });
    await dispatchMerchantNotifications(merchant, qq, identity.appId, [group]);
    assert.equal(sends, 1); assert.equal(faux.state.callCount, 0);
    assert.deepEqual(await contexts.bind(identity, group).read(), beforeEvent, "The host event never writes a user focus/choice");
    const refs = await merchant.listTaskReferences(identity, sourceKey, group);
    assert.equal(refs.candidates.length, 1); assert.equal(refs.candidates[0]?.origin, "sent");
    await qq.close(); qq = undefined;
    const second = run("recover", input); assert.notEqual(first.pid, second.pid);
    console.log(`[task-recovery] child ${first.pid} exit -> host notification -> child ${second.pid}: fresh task A and preserved focus B PASS`);
    const other = await merchant.request(identity, sourceKey, orderC, "第二个独立恢复任务");
    assert.notEqual(other.taskId, task.taskId);
    const chosen = run("choose", input);
    const reselected = run("rechoose", { ...input, oldCommand: chosen.command, expiresAt: chosen.expiresAt });
    const final = run("selected", input);
    assert.equal(new Set([first.pid, second.pid, chosen.pid, reselected.pid, final.pid]).size, 5);
    console.log(`[task-recovery] children ${chosen.pid} -> ${reselected.pid} -> ${final.pid}: ambiguity, actual selection, old-token rejection, restored exact task PASS`);
    const [rows] = await query.execute<RowDataPacket[]>(`SELECT
      (SELECT COUNT(*) FROM merchant_requests WHERE order_id IN (?,?,?)) AS tasks,
      (SELECT COUNT(*) FROM refund_operations WHERE order_id IN (?,?,?)) AS operations,
      (SELECT COUNT(*) FROM refunds WHERE order_id IN (?,?,?)) AS refunds`,
    [orderA, orderB, orderC, orderA, orderB, orderC, orderA, orderB, orderC]);
    assert.deepEqual([Number(rows[0]?.tasks), Number(rows[0]?.operations), Number(rows[0]?.refunds)], [2, 0, 0]);
    console.log("PASS task recovery: real MySQL + five independent Pi/faux processes + local QQ transport; no extra task/refund writes, paid model or QQ platform requests.");
  } finally {
    await qq?.close();
    try { admin(`DELETE FROM conversation_state WHERE source_key='${sourceKey}';`); await fixture.cleanup(); }
    finally {
      try { admin(`DELETE FROM qq_identities WHERE app_id='${identity.appId}' AND sender_id='${identity.senderId}';`); }
      finally { await Promise.allSettled([merchant.close(), contexts.close(), business.close(), query.end()]); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.find(value => value.startsWith("--task-child="))?.split("=")[1];
  if (mode) console.log(JSON.stringify(await child(mode, JSON.parse(readFileSync(0, "utf8")) as Input)));
  else await checkSupportTaskRecoveryDatabase();
}
