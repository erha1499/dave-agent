import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime } from "../src/agent.ts";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { ConversationStateStore } from "../src/conversation-state.ts";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

type Port = ReturnType<ConversationStateStore["bind"]>;
type Value = NonNullable<Awaited<ReturnType<Port["read"]>>["value"]>;
type Session = Awaited<ReturnType<typeof createSupportSession>>;
type Candidate = { requestId: string; orderId: string; expiresAt: number };
type ChildMode = "write" | "recover" | "policy-write" | "policy-continue" | "policy-select" | "policy-restore" | "amount-write" | "amount-compare";
type ChildInput = { identity: QQIdentity; channel: string; orders: [string, string]; oldCommand?: string; expectedPaidCents?: number;
  referenceRequestId?: string; referenceOrderVersion?: string };
type ChildOutput = { pid: number; command?: string; candidates?: Candidate[]; selectedOrderId?: string; paidCents?: number;
  referenceRequestId?: string; referenceOrderVersion?: string; sourceIds?: string[] };
type ChildHost = { kind?: string; orderId?: string | null; policyTopic?: { requestId: string; originalQuery: string } | null;
  itemPaidUnit?: { requestId: string; paidCents: number } | null };
const policyQuestion = "这份午餐套餐普通周末可以使用吗？", policyFollowup = "周日也能使用吗？";
const policyOther = "这份午餐套餐一张券对应几人用餐？";
const hostReference = (context: TranscriptContext): ChildHost => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text))
  .map(text => { try { return JSON.parse(text) as ChildHost; } catch { return {}; } }).filter(value => value.kind === "host_order_reference").at(-1) ?? {};

function displayedCommand(reply: ReturnType<typeof supportReply>, label: string, kind = "订单") {
  assert.equal(reply?.kind, "notice");
  const lines = (reply as { text: string }).text.split("\n"), index = lines.indexOf(label);
  assert.ok(index >= 0, "The reference must actually be displayed before extracting its selection command");
  const command = lines[index + 1];
  assert.match(command ?? "", new RegExp(`^选择${kind} [0-9a-f-]{36}$`));
  return command!;
}

// Each mode owns its pools and Pi session; the parent waits for process exit before starting the next one.
async function contextChild(mode: string, input: ChildInput) {
  assert.ok(["write", "recover", "policy-write", "policy-continue", "policy-select", "policy-restore", "amount-write", "amount-compare"].includes(mode));
  assert.match(input.identity.appId, /^CS_DB_[a-f0-9]{16}$/);
  const nonce = input.identity.appId.slice(6);
  assert.equal(input.identity.senderId, `owner_${nonce}`);
  assert.equal(input.channel, `cs-${nonce}-${mode.startsWith("policy-") ? "policy" : mode.startsWith("amount-") ? "amount" : "process"}`);
  assert.equal(input.orders.length, 2); for (const id of input.orders) assert.match(id, /^COUPON-2\d{3}$/);
  const contextPool = createPool(readAfterSalesDatabaseConfig()), businessPool = createPool(readDatabaseConfig());
  const contexts = new ConversationStateStore(contextPool), business = new CouponStore(businessPool);
  const port = contexts.bind(input.identity, input.channel), reads: string[] = [];
  const queries: Array<{ query: string; shopId?: string; productId?: string; documents: Awaited<ReturnType<CouponStore["searchKnowledge"]>> }> = [];
  const observed = { async getOrder(who: QQIdentity, orderId: string) { reads.push(orderId); return business.getOrder(who, orderId); },
    async searchKnowledge(query: string, shopId?: string, productId?: string) {
      const documents = await business.searchKnowledge(query, shopId, productId);
      queries.push({ query, shopId, productId, documents }); return documents;
    } } as unknown as CouponStore;
  let session: Session | undefined;
  try {
    const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
    session = await createSupportSession(input.identity, observed, runtime, faux.getModel(), undefined, { groupOpenid: input.channel, context: port });
    let request = 0;
    async function turn(text: string, action?: ContextSupportAction | ((host: ChildHost) => ContextSupportAction)) {
      const requestId = `cs-child-${process.pid}-${++request}`;
      prepareSupportPrompt(session!, { requestId, groupOpenid: input.channel, messageId: requestId });
      let host: ChildHost | undefined;
      faux.setResponses(action ? [context => {
        host = hostReference(context);
        return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(host) : action }), { stopReason: "toolUse" });
      },
        () => fauxAssistantMessage("仅按本轮模拟业务结果回复。")] : []);
      const calls = faux.state.callCount, before = reads.length, beforeQueries = queries.length;
      await session!.prompt(text, { expandPromptTemplates: false });
      assert.equal(session!.agent.state.errorMessage, undefined); assert.equal(faux.getPendingResponseCount(), 0);
      if (!action) { assert.equal(faux.state.callCount, calls, "Host selection cannot invoke a model"); assert.equal(reads.length, before); assert.equal(queries.length, beforeQueries); }
      return { requestId, host, reply: supportReply(session!), result: getSupportResult(session!), receipt: getSupportHostReceipt(session!) };
    }
    const [orderA, orderB] = input.orders;
    function checkPolicy(checked: Awaited<ReturnType<typeof turn>>, question: string, previous?: string) {
      assert.equal(checked.result?.outcome, "ready");
      const topic = checked.result?.verifiedPolicyTopic, query = queries.at(-1);
      assert.ok(topic && query); assert.equal(topic.requestId, checked.requestId); assert.equal(topic.originalQuery, question);
      assert.equal(query.shopId, "shop-demo-1"); assert.equal(query.productId, "product-demo-1");
      assert.equal(checked.result?.evidence.knowledge.length, 1);
      assert.equal(checked.result.evidence.knowledge[0]?.trace.mode, "lexical");
      assert.equal(checked.result.evidence.knowledge[0]?.context.originalQuery, question);
      assert.ok(query.query.includes(question.replaceAll(orderA, "该订单")), "Retrieval may normalize only the authorized order locator");
      assert.ok(query.documents.length > 0);
      assert.deepEqual(topic.sources, query.documents.map(document => ({ sourceId: document.sourceId,
        version: createHash("sha256").update(JSON.stringify(document)).digest("hex") })));
      if (previous) {
        assert.equal(checked.host?.policyTopic?.requestId, previous);
        assert.equal(checked.result.evidence.knowledge[0]?.context.policyTopic?.requestId, previous);
        assert.ok(query.query.includes(policyQuestion), "The actual fresh retrieval retains the original policy question");
        assert.ok(topic.priorQueries?.some(row => row.requestId === previous));
      }
      return topic;
    }
    const previousPolicy = (question: string) => (host: ChildHost): ContextSupportAction => ({ protocol: "v2.2", kind: "policy",
      orderRef: { kind: "focus" }, question, questionContext: { kind: "previous", requestId: host.policyTopic?.requestId ?? "missing-host-topic" },
      evidenceTarget: { kind: "rule_only", basis: question } });
    if (mode === "policy-write") {
      const first = await turn(`${orderA} ${policyQuestion}`, { protocol: "v2.2", kind: "policy", orderRef: { kind: "explicit", orderId: orderA },
        question: policyQuestion, questionContext: { kind: "standalone" }, evidenceTarget: { kind: "rule_only", basis: policyQuestion } });
      const topic = checkPolicy(first, `${orderA} ${policyQuestion}`), saved = (await port.read()).value;
      assert.ok(topic.sources.some(source => source.sourceId === "KB-SHOP-DEMO-1"));
      assert.ok(saved?.version === 3 && saved.policyChoices?.candidates.length === 1);
      assert.equal(saved.policyChoices.selectedRequestId, undefined, "A unique topic is not an explicit user selection");
      assert.doesNotMatch(JSON.stringify(saved.policyChoices), /token|presentation|sourceKey|groupOpenid|reply/);
      assert.deepEqual(reads, [orderA]); assert.equal(queries.length, 1);
      return { pid: process.pid, referenceRequestId: first.requestId, sourceIds: topic.sources.map(source => source.sourceId) };
    }
    if (mode === "policy-continue") {
      assert.ok(input.referenceRequestId);
      const continued = await turn(policyFollowup, previousPolicy(policyFollowup));
      checkPolicy(continued, policyFollowup, input.referenceRequestId);
      const other = await turn(policyOther, { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" },
        question: policyOther, questionContext: { kind: "standalone" }, evidenceTarget: { kind: "rule_only", basis: policyOther } });
      const topic = checkPolicy(other, policyOther); assert.ok(topic.sources.some(source => source.sourceId === "KB-PRODUCT-LUNCH"));
      const shown = await turn("请列出刚才的两个话题", { protocol: "v2.2", kind: "clarify", field: "policy_topic", reason: "ambiguous" });
      const saved = (await port.read()).value;
      assert.ok(saved?.version === 3 && saved.policyChoices?.candidates.length === 2);
      assert.equal(saved.pendingReferenceKind, "policy"); assert.equal(saved.policyChoices.selectedRequestId, undefined);
      assert.equal(queries.length, 2); assert.deepEqual(reads, [orderA, orderA]);
      return { pid: process.pid, command: displayedCommand(shown.reply, `${orderA}：${policyFollowup}`, "话题"),
        referenceRequestId: continued.requestId, sourceIds: continued.result!.verifiedPolicyTopic!.sources.map(source => source.sourceId) };
    }
    if (mode === "policy-select") {
      assert.ok(input.oldCommand && input.referenceRequestId);
      const before = (await port.read()).value;
      assert.ok(before?.version === 3 && before.policyChoices);
      const rejected = await turn(input.oldCommand); assert.equal(rejected.receipt?.outcome, "rejected");
      const command = displayedCommand(rejected.reply, `${orderA}：${policyFollowup}`, "话题"); assert.notEqual(command, input.oldCommand);
      const selected = await turn(command); assert.equal(selected.receipt?.outcome, "selected");
      assert.equal(selected.receipt?.version, "reference-selection-v1");
      if (selected.receipt?.version !== "reference-selection-v1") throw new Error("Missing policy receipt");
      assert.equal(selected.receipt.presentationRequestId, rejected.requestId); assert.equal(selected.receipt.selectedRequestId, input.referenceRequestId);
      const saved = (await port.read()).value;
      assert.ok(saved?.version === 3 && saved.policyChoices);
      assert.equal(saved.policyChoices.selectedRequestId, input.referenceRequestId);
      assert.deepEqual(saved.policyChoices.candidates, before.policyChoices.candidates, "Selection does not renew policy TTL or rewrite source questions");
      assert.equal(queries.length, 0); assert.deepEqual(reads, []);
      return { pid: process.pid, referenceRequestId: input.referenceRequestId };
    }
    if (mode === "policy-restore") {
      assert.ok(input.referenceRequestId);
      const before = (await port.read()).value;
      assert.ok(before?.version === 3 && before.policyChoices?.selectedRequestId === input.referenceRequestId);
      const question = "再确认一下周日的使用安排。", continued = await turn(question, previousPolicy(question));
      const topic = checkPolicy(continued, question, input.referenceRequestId);
      assert.ok(queries[0]?.query.includes(policyFollowup)); assert.ok(!queries[0]?.query.includes(policyOther));
      assert.equal(queries.length, 1); assert.deepEqual(reads, [orderA]);
      const saved = (await port.read()).value;
      assert.ok(saved?.version === 3 && saved.policyChoices?.selectedRequestId === continued.requestId);
      return { pid: process.pid, referenceRequestId: continued.requestId, sourceIds: topic.sources.map(source => source.sourceId) };
    }
    if (mode === "amount-write") {
      const shown = await turn(`查看 ${orderA} 的每券实付`, { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: orderA } });
      const reference = shown.result?.verifiedAmountReference;
      assert.ok(reference); assert.equal(reference.paidCents, 7980);
      assert.ok(shown.reply && "text" in shown.reply); assert.match(shown.reply.text, /每券实付 79\.80 元/);
      const saved = (await port.read()).value;
      assert.ok(saved?.version === 3 && saved.amountChoices?.candidates.length === 1);
      assert.equal(saved.amountChoices.candidates[0]!.reference.paidCents, 7980);
      assert.equal(saved.amountChoices.candidates[0]!.reference.requestId, shown.requestId);
      assert.equal(saved.amountChoices.selectedRequestId, undefined);
      assert.doesNotMatch(JSON.stringify(saved.amountChoices), /token|presentation|sourceKey|groupOpenid|approval|confirmation/);
      assert.deepEqual(reads, [orderA]); assert.equal(queries.length, 0);
      return { pid: process.pid, referenceRequestId: shown.requestId, referenceOrderVersion: reference.orderVersion, paidCents: reference.paidCents };
    }
    if (mode === "amount-compare") {
      assert.ok(input.referenceRequestId && input.referenceOrderVersion);
      const compared = await turn("剩下未核销的那张券，实付和前面展示的一样吗？", host => ({ protocol: "v2.2", kind: "paid_amount_compare",
        orderRef: { kind: "focus" }, amountRef: { requestId: host.itemPaidUnit?.requestId ?? "missing-host-amount" } }));
      assert.equal(compared.result?.outcome, "ready"); assert.equal(compared.host?.itemPaidUnit?.requestId, input.referenceRequestId);
      assert.equal(compared.host?.itemPaidUnit?.paidCents, 7980);
      const comparison = compared.result?.evidence.amountComparison;
      assert.ok(comparison); assert.equal(comparison.referencePaidCents, 7980); assert.equal(comparison.remainingUnitPaidCents, 6543);
      assert.equal(comparison.comparisonEqual, false); assert.equal(comparison.refundApproved, false);
      assert.equal(comparison.referenceRequestId, input.referenceRequestId); assert.equal(comparison.referenceOrderVersion, input.referenceOrderVersion);
      assert.notEqual(comparison.currentOrderVersion, input.referenceOrderVersion);
      assert.equal(compared.result?.evidence.order?.amounts.paidCents, 13086); assert.equal(compared.result?.evidence.operation, undefined);
      assert.ok(compared.reply && "text" in compared.reply); assert.match(compared.reply.text, /65\.43 元.*79\.80 元不同/);
      assert.match(compared.reply.text, /不代表.*批准.*未生成或提交退款/);
      assert.deepEqual(reads, [orderA]); assert.equal(queries.length, 0);
      const [rows] = await businessPool.execute<RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM merchant_requests WHERE order_id = ?) AS tasks, (SELECT COUNT(*) FROM refund_operations WHERE order_id = ?) AS operations, (SELECT COUNT(*) FROM refunds WHERE order_id = ?) AS refunds", [orderA, orderA, orderA]);
      assert.deepEqual([Number(rows[0]!.tasks), Number(rows[0]!.operations), Number(rows[0]!.refunds)], [0, 0, 0]);
      return { pid: process.pid, referenceRequestId: comparison.referenceRequestId, paidCents: comparison.remainingUnitPaidCents };
    }
    if (mode === "write") {
      for (const orderId of input.orders) await turn(`查看 ${orderId}`, { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId } });
      const shown = await turn("刚才提到的那笔订单呢？", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const command = displayedCommand(shown.reply, orderB), saved = (await port.read()).value;
      assert.ok(saved && saved.version !== 1 && saved.orderChoices?.pending);
      assert.deepEqual(saved.orderChoices.candidates.map(row => row.orderId).sort(), [orderA, orderB].sort());
      assert.equal(saved.requiresRestatement, true); assert.doesNotMatch(JSON.stringify(saved), /token|presentation/);
      assert.doesNotMatch(JSON.stringify(saved.orderChoices), /amountCents|paidCents/);
      assert.deepEqual(reads, [orderA, orderB]);
      return { pid: process.pid, command, candidates: saved.orderChoices.candidates };
    }
    assert.ok(input.oldCommand); assert.ok(Number.isSafeInteger(input.expectedPaidCents));
    const before = (await port.read()).value;
    assert.ok(before && before.version !== 1 && before.orderChoices?.pending);
    const rejected = await turn(input.oldCommand);
    assert.equal(rejected.receipt?.version, "reference-selection-v1"); assert.equal(rejected.receipt?.outcome, "rejected");
    assert.equal(rejected.result, undefined);
    const command = displayedCommand(rejected.reply, orderB); assert.notEqual(command, input.oldCommand);
    const selected = await turn(command);
    assert.equal(selected.receipt?.version, "reference-selection-v1"); assert.equal(selected.receipt?.outcome, "selected");
    if (selected.receipt?.version !== "reference-selection-v1") throw new Error("Missing reference receipt");
    assert.equal(selected.receipt.selectedOrderId, orderB); assert.equal(selected.receipt.presentationRequestId, rejected.requestId);
    const selectedValue = (await port.read()).value;
    assert.ok(selectedValue && selectedValue.version !== 1 && selectedValue.orderChoices);
    assert.deepEqual(selectedValue.orderChoices.candidates, before.orderChoices.candidates,
      "Restart, redisplay and selection preserve the original candidate expiry");
    const fresh = await turn("这笔订单当前情况呢？", { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } });
    assert.deepEqual(reads, [orderB]); assert.equal(fresh.result?.evidence.order?.id, orderB);
    assert.equal(fresh.result?.evidence.order?.amounts.paidCents, input.expectedPaidCents);
    const after = (await port.read()).value; assert.equal(after?.focus?.orderId, orderB);
    assert.equal(after?.focus?.source, "selection"); assert.equal(after?.focus?.requestId, selected.requestId);
    return { pid: process.pid, selectedOrderId: orderB, paidCents: fresh.result?.evidence.order?.amounts.paidCents,
      candidates: selectedValue.orderChoices.candidates };
  } finally { session?.dispose(); await Promise.all([contextPool.end(), businessPool.end()]); }
}

function runContextChild(mode: ChildMode, input: ChildInput) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--context-child=${mode}`], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: JSON.stringify(input), encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  // This output contains only synthetic identifiers/assertions; environment values are never serialized.
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout.trim()) as ChildOutput;
  assert.equal(output.pid, child.pid); assert.notEqual(output.pid, process.pid);
  return output;
}

// Administrator access is only for fresh fixture identities, deliberate corruption and cleanup.
// Business/session reads and writes below use the existing restricted database accounts.
function admin(sql: string) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("独立会话状态 fixture 准备或清理失败。");
  return result.stdout.trim();
}

export async function checkConversationStateDatabase() {
  const nonce = randomBytes(8).toString("hex"), app = `CS_DB_${nonce}`;
  const identity: QQIdentity = { appId: app, senderId: `owner_${nonce}` };
  const otherUser = { ...identity, senderId: `peer_${nonce}` }, otherApp = { ...identity, appId: `CS_ALT_${nonce}` };
  const fixture = await createMerchantFixture(Array.from({ length: 8 }, () => "approve" as const), { delayMs: 5000 });
  const [orderA, orderB, writeOrder, noticeOrder, childA, childB, policyOrder, amountOrder] = fixture.orders as [string, string, string, string, string, string, string, string];
  const sessions: Session[] = [], sourceKeys = new Set<string>();
  const reads: string[] = [];
  let contexts!: ConversationStateStore, contextPool!: Pool, business!: CouponStore, merchant!: AfterSalesStore, refunds!: RefundStore;
  let pools: Pool[] = [], request = 0, refundPrepares = 0, qq: QQAgent | undefined;
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  const explicit = (orderId: string) => ({ kind: "explicit" as const, orderId });
  const focus = { kind: "focus" as const };
  const group = (label: string) => `cs-${nonce}-${label}`;
  const value = (orderId = orderA, requestId = `selection-${++request}`, selectedAt = Date.now()): Value => ({ version: 1,
    focus: { orderId, requestId, source: "explicit", selectedAt, expiresAt: selectedAt + 15 * 60_000 }, requiresRestatement: false });
  const bind = (channel: string, who = identity) => { sourceKeys.add(merchantSourceKey(who, channel)); return contexts.bind(who, channel); };
  async function open() {
    contextPool = createPool(readAfterSalesDatabaseConfig());
    const businessPool = createPool(readDatabaseConfig()), merchantPool = createPool(readAfterSalesDatabaseConfig()), refundPool = createPool(readRefundDatabaseConfig());
    pools = [contextPool, businessPool, merchantPool, refundPool];
    contexts = new ConversationStateStore(contextPool); business = new CouponStore(businessPool);
    merchant = new AfterSalesStore(merchantPool); refunds = new RefundStore(refundPool);
    await Promise.all([contexts.ping(), business.ping(), merchant.ping(), refunds.ping()]);
  }
  async function close() {
    for (const session of sessions.splice(0)) session.dispose();
    await Promise.all(pools.splice(0).map(pool => pool.end()));
  }
  // Spies record actual service invocations; each delegates to the real restricted MySQL store.
  const observedBusiness = {
    async getOrder(who: QQIdentity, id: string) { reads.push(`order:${id}`); return business.getOrder(who, id); },
    searchKnowledge: (...args: Parameters<CouponStore["searchKnowledge"]>) => business.searchKnowledge(...args),
  } as unknown as CouponStore;
  const observedMerchant = {
    async getTask(...args: Parameters<AfterSalesStore["getTask"]>) { reads.push(`merchant:${args[2]}`); return merchant.getTask(...args); },
    prepare: (...args: Parameters<AfterSalesStore["prepare"]>) => merchant.prepare(...args),
  } as unknown as AfterSalesStore;
  const observedRefunds = {
    async get(...args: Parameters<RefundStore["get"]>) { reads.push(`refund:${args[2]}`); return refunds.get(...args); },
    async prepare(...args: Parameters<RefundStore["prepare"]>) { refundPrepares++; return refunds.prepare(...args); },
  } as unknown as RefundStore;
  async function create(channel: string, context = bind(channel), who = identity) {
    const session = await createSupportSession(who, observedBusiness, runtime, faux.getModel(), {
      store: observedMerchant, refunds: observedRefunds, sourceKey: merchantSourceKey(who, channel),
    }, { groupOpenid: channel, context });
    sessions.push(session); return session;
  }
  function responses(action: ContextSupportAction, repeats = 1): FauxResponseStep[] {
    return [...Array.from({ length: repeats }, () => () => fauxAssistantMessage(fauxToolCall("support_action", { action }), { stopReason: "toolUse" })),
      () => fauxAssistantMessage("仅按本轮模拟业务结果回复。")];
  }
  async function turn(session: Session, channel: string, text: string, action: ContextSupportAction, repeats = 1) {
    const id = `cs-request-${++request}`, before = reads.length;
    prepareSupportPrompt(session, { requestId: id, groupOpenid: channel, messageId: id });
    faux.setResponses(responses(action, repeats));
    await session.prompt(text, { expandPromptTemplates: false });
    assert.equal(session.agent.state.errorMessage, undefined);
    // A deterministic context failure may stop before invoking Pi. It must not perform a business read.
    if (faux.getPendingResponseCount()) assert.equal(reads.length, before);
    faux.setResponses([]);
    return { result: getSupportResult(session), reply: supportReply(session), reads: reads.slice(before), requestId: id };
  }
  const action = (kind: "order" | "merchant_status" | "refund_status" | "refund_prepare",
    orderRef: typeof focus | ReturnType<typeof explicit> = focus): ContextSupportAction => kind === "merchant_status"
      ? { protocol: "v2.2", kind: "merchant_status", orderRef } : { protocol: "v2.2", kind, orderRef };
  async function expectBlocked(channel: string, context = bind(channel), who = identity, storageFailure = false) {
    const session = await create(channel, context, who), before = reads.length;
    if (storageFailure) {
      const modelCalls = faux.state.callCount;
      await assert.rejects(turn(session, channel, "这笔订单的退款进度如何？", action("refund_status")));
      faux.setResponses([]);
      assert.equal(reads.length, before); assert.equal(faux.state.callCount, modelCalls, "Context preflight failure stops before Pi and business calls");
      assert.doesNotMatch(JSON.stringify(supportReply(session)), /synthetic-private/); return;
    }
    const checked = await turn(session, channel, "这笔订单的退款进度如何？", action("refund_status"));
    assert.equal(reads.length, before, "Untrusted or unavailable context cannot trigger an old business reference");
    assert.ok(checked.reply?.kind === "notice");
    assert.ok(!checked.result || checked.result.outcome === "clarification" || checked.result.outcome === "blocked");
  }
  function corrupt(channel: string, corrupted: unknown, who = identity) {
    const key = merchantSourceKey(who, channel); assert.ok(sourceKeys.has(key));
    const hex = Buffer.from(JSON.stringify(corrupted)).toString("hex");
    admin(`UPDATE conversation_state SET context_json = CAST(CONVERT(0x${hex} USING utf8mb4) AS JSON) WHERE source_key = '${key}';`);
  }
  function message(channel: string, text: string): QQBotInboundMessage {
    const id = `cs-qq-${++request}`, timestamp = new Date().toISOString();
    return { rawEventType: "GROUP_AT_MESSAGE_CREATE", kind: "group", senderId: identity.senderId, groupOpenid: channel, messageId: id,
      content: text, timestamp, replyTarget: { scope: "group", targetId: channel, msgId: id },
      raw: { id, content: text, timestamp, group_openid: channel, author: { member_openid: identity.senderId } } };
  }
  try {
    for (const who of [identity, otherUser, otherApp]) admin(`INSERT INTO qq_identities (app_id, sender_id, customer_id)
      SELECT '${who.appId}', '${who.senderId}', customer_id FROM qq_identities WHERE app_id = 'TEST_APP' AND sender_id = 'TEST_USER1';`);
    await open();
    const restoredGroup = group("restore"), first = await create(restoredGroup);
    const selected = await turn(first, restoredGroup, `查看 ${orderA}`, action("order", explicit(orderA)));
    assert.equal(selected.result?.evidence.order?.id, orderA);
    const persisted = await bind(restoredGroup).read();
    assert.equal(persisted.value?.focus?.orderId, orderA); assert.equal(persisted.value?.focus?.requestId, selected.requestId);
    assert.equal(persisted.value?.focus?.source, "explicit"); assert.equal(persisted.value?.requiresRestatement, false);
    assert.equal(persisted.value.focus.expiresAt - persisted.value.focus.selectedAt, 15 * 60_000);
    assert.doesNotMatch(JSON.stringify(persisted.value), /amountCents|approved|confirmation|policyTopic|selectedToken/);
    const task = await merchant.request(identity, merchantSourceKey(identity, restoredGroup), orderA, "独立恢复工程验收");
    await close(); await open();
    const rebuilt = await create(restoredGroup);
    const pending = await turn(rebuilt, restoredGroup, "刚才那笔协商进度呢？", action("merchant_status"));
    assert.deepEqual(pending.reads, [`order:${orderA}`, `merchant:${orderA}`]); assert.equal(pending.result?.evidence.task?.status, "pending");
    assert.equal(await merchant.applyResult({ taskId: task.taskId, orderId: orderA, status: "approved", approvedAmountCents: 7980 }), true);
    const approved = await turn(rebuilt, restoredGroup, "再查这笔协商当前结果", action("merchant_status"));
    assert.deepEqual(approved.reads, [`order:${orderA}`, `merchant:${orderA}`]); assert.equal(approved.result?.evidence.task?.status, "approved");
    const operation = await refunds.prepare(identity, merchantSourceKey(identity, restoredGroup), orderA);
    await close(); await open();
    const refundSession = await create(restoredGroup);
    const prepared = await turn(refundSession, restoredGroup, "这笔退款准备到哪一步了？", action("refund_status"));
    assert.deepEqual(prepared.reads, [`order:${orderA}`, `refund:${orderA}`]); assert.equal(prepared.result?.evidence.operation?.status, "prepared");
    await refunds.markPresented(identity, merchantSourceKey(identity, restoredGroup), operation.operationId);
    await refunds.confirm(identity, merchantSourceKey(identity, restoredGroup), operation.operationId);
    const succeeded = await turn(refundSession, restoredGroup, "再查当前退款进度", action("refund_status"));
    assert.equal(succeeded.result?.evidence.order?.status, "refunded"); assert.equal(succeeded.result?.evidence.operation?.status, "succeeded");
    assert.deepEqual(succeeded.reads, [`order:${orderA}`, `refund:${orderA}`]);
    assert.deepEqual((await bind(restoredGroup).read()).value?.focus, persisted.value.focus, "Follow-up reads must not renew the original selection TTL");
    console.log("[conversation-state] destroyed pools/Session, fresh order/task/refund recovery, state changes and fixed selection TTL PASS");

    for (const [who, channel] of [[identity, group("other")], [otherUser, restoredGroup], [otherApp, restoredGroup]] as const) {
      assert.equal((await bind(channel, who).read()).value, undefined);
      await expectBlocked(channel, bind(channel, who), who);
    }
    const casGroup = group("cas"), cas = bind(casGroup), empty = await cas.read();
    assert.equal(empty.revision, 0); assert.ok(empty.customerId);
    const winners = await Promise.allSettled([cas.write(empty, value(orderB)), cas.write(empty, value(writeOrder))]);
    assert.equal(winners.filter(result => result.status === "fulfilled").length, 1, "Initial INSERT also obeys CAS");
    const current = await cas.read(); assert.equal(current.revision, 1);
    const next = await cas.write(current, value(orderB)); assert.equal(next.revision, current.revision + 1);
    await assert.rejects(cas.write(current, value(writeOrder)));
    assert.equal((await cas.read()).value?.focus?.orderId, orderB);
    await assert.rejects(cas.write({ ...next, customerId: "not-the-bound-customer" }, value(orderB)));
    await assert.rejects(cas.write(next, { ...value(orderB), version: 99 } as unknown as Value));
    await assert.rejects(cas.write(next, { ...value(orderB), amountCents: 7980 } as unknown as Value));
    await assert.rejects(cas.write(next, value("COUPON-1002")), "A context locator never authorizes another customer's order");
    await assert.rejects(contextPool.execute("DELETE FROM conversation_state WHERE source_key = ?", [merchantSourceKey(identity, casGroup)]),
      error => Boolean(error && typeof error === "object" && "code" in error && String(error.code).includes("ACCESS_DENIED")));
    console.log("[conversation-state] app/group/user isolation, restricted account and create/update CAS PASS");

    const beforeRebind = await bind(restoredGroup).read();
    admin(`DELETE FROM qq_identities WHERE app_id = '${identity.appId}' AND sender_id = '${identity.senderId}';`);
    assert.equal((await bind(restoredGroup).read()).value, undefined); await expectBlocked(restoredGroup, bind(restoredGroup), identity, true);
    await assert.rejects(bind(restoredGroup).write(beforeRebind, value(orderB)));
    admin(`INSERT INTO qq_identities (app_id, sender_id, customer_id)
      SELECT '${identity.appId}', '${identity.senderId}', customer_id FROM qq_identities WHERE app_id = 'TEST_APP' AND sender_id = 'TEST_USER1';`);
    assert.equal((await bind(restoredGroup).read()).value, undefined, "Unbind/rebind to the same customer cannot resurrect a previous binding's context");
    await assert.rejects(bind(restoredGroup).write(beforeRebind, value(orderB)));
    const rebound = await bind(restoredGroup).write(await bind(restoredGroup).read(), value(orderB));
    admin(`UPDATE qq_identities SET customer_id = (SELECT customer_id FROM (SELECT customer_id FROM qq_identities
      WHERE app_id = 'TEST_APP' AND sender_id = 'TEST_USER2') q) WHERE app_id = '${identity.appId}' AND sender_id = '${identity.senderId}';`);
    assert.equal((await bind(restoredGroup).read()).value, undefined); await expectBlocked(restoredGroup);
    await assert.rejects(bind(restoredGroup).write(rebound, value(orderB)));
    admin(`UPDATE qq_identities SET customer_id = (SELECT customer_id FROM (SELECT customer_id FROM qq_identities
      WHERE app_id = 'TEST_APP' AND sender_id = 'TEST_USER1') q) WHERE app_id = '${identity.appId}' AND sender_id = '${identity.senderId}';`);
    console.log("[conversation-state] unbound, same-customer new binding and changed-customer rejection PASS");

    for (const [label, bad] of [["expired", value(orderB, "expired", Date.now() - 16 * 60_000)],
      ["version", { version: 77, focus: value(orderB).focus, requiresRestatement: false }],
      ["ambiguous", { version: 1, requiresRestatement: true }]] as const) {
      const channel = group(label), port = bind(channel); await port.write(await port.read(), value(orderB));
      corrupt(channel, bad); const blocked = await port.read();
      assert.equal(blocked.value?.requiresRestatement, true); assert.equal(blocked.value?.focus, undefined);
      await expectBlocked(channel);
    }
    const ambiguityGroup = group("actual-ambiguity"), ambiguitySession = await create(ambiguityGroup);
    await turn(ambiguitySession, ambiguityGroup, `查看 ${orderB}`, action("order", explicit(orderB)));
    await turn(ambiguitySession, ambiguityGroup, `${orderB} 和 ${writeOrder} 的那个退款呢？`,
      { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
    assert.equal((await bind(ambiguityGroup).read()).value?.requiresRestatement, true);
    ambiguitySession.dispose(); await expectBlocked(ambiguityGroup);
    console.log("[conversation-state] expired/corrupt state and actual unresolved ambiguity never restore one order PASS");

    const candidatesValue = (candidates: Candidate[], overrides: Partial<{ overflow: boolean; selectionRequired: boolean; pending: boolean }> = {}): Value => ({
      version: 2, requiresRestatement: true, orderChoices: { candidates, overflow: false, selectionRequired: false, pending: true, ...overrides } });
    const expiresAt = Date.now() + 14 * 60_000;
    const candidates: Candidate[] = [orderB, writeOrder].map((orderId, index) => ({ orderId, requestId: `cs-candidate-${index}`, expiresAt }));
    const choicesGroup = group("choices"), choicesPort = bind(choicesGroup), choicesEmpty = await choicesPort.read();
    const choicesWritten = await choicesPort.write(choicesEmpty, candidatesValue(candidates));
    assert.equal(choicesWritten.value?.version, 2);
    assert.ok(choicesWritten.value?.version === 2 && choicesWritten.value.orderChoices?.selectionRequired,
      "Two candidates require a choice even if an input flag was false");
    assert.deepEqual(choicesWritten.value.orderChoices.candidates, candidates);
    assert.doesNotMatch(JSON.stringify(choicesWritten.value), /token|presentation/);
    await assert.rejects(choicesPort.write(choicesEmpty, candidatesValue(candidates)), "Candidate snapshots obey the same CAS");
    for (const bad of [
      candidatesValue([{ ...candidates[0]!, orderId: "COUPON-1002" }]),
      candidatesValue([{ ...candidates[0]!, expiresAt: Date.now() + 16 * 60_000 }]),
      candidatesValue([candidates[0]!, candidates[1]!, { ...candidates[0]!, requestId: "third", orderId: childA },
        { ...candidates[0]!, requestId: "fourth", orderId: childB }]),
      { ...candidatesValue(candidates), orderChoices: { candidates, overflow: false, selectionRequired: true, pending: true, token: "forged" } },
    ]) await assert.rejects(choicesPort.write(choicesWritten, bad as Value));
    assert.deepEqual((await choicesPort.read()).value, choicesWritten.value, "Rejected writes cannot alter the saved candidate set");
    for (const [who, channel] of [[identity, group("choices-other")], [otherUser, choicesGroup], [otherApp, choicesGroup]] as const) {
      assert.equal((await bind(channel, who).read()).value, undefined);
      await expectBlocked(channel, bind(channel, who), who);
      const reply = JSON.stringify(supportReply(sessions.at(-1)!));
      for (const candidate of candidates) assert.ok(!reply.includes(candidate.orderId), "Another trusted route cannot expose saved candidate labels");
    }
    for (const remaining of [1, 0]) {
      const channel = group(`choices-expired-${remaining}`), port = bind(channel);
      await port.write(await port.read(), candidatesValue(candidates));
      corrupt(channel, candidatesValue(candidates.map((candidate, index) => ({ ...candidate, expiresAt: index < remaining ? expiresAt : Date.now() - 1 })),
        { pending: false, selectionRequired: false }));
      const saved = (await port.read()).value;
      assert.ok(saved?.version === 2 && saved.orderChoices);
      assert.equal(saved.orderChoices.candidates.length, remaining); assert.equal(saved.orderChoices.selectionRequired, true);
      assert.equal(saved.requiresRestatement, true); await expectBlocked(channel);
    }
    const expiredFocusGroup = group("choices-expired-focus"), expiredFocusPort = bind(expiredFocusGroup);
    await expiredFocusPort.write(await expiredFocusPort.read(), candidatesValue(candidates));
    corrupt(expiredFocusGroup, { ...candidatesValue(candidates), requiresRestatement: false,
      focus: value(orderB, "expired-focus", Date.now() - 16 * 60_000).focus });
    const withoutFocus = (await expiredFocusPort.read()).value;
    assert.ok(withoutFocus?.version === 2 && withoutFocus.orderChoices);
    assert.equal(withoutFocus.focus, undefined); assert.equal(withoutFocus.requiresRestatement, true);
    assert.deepEqual(withoutFocus.orderChoices.candidates, candidates);
    for (const [label, bad] of [["shape", { ...candidatesValue(candidates), orderChoices: { candidates, pending: "yes" } }],
      ["token", { ...candidatesValue(candidates), selectedToken: "forged" }]] as const) {
      const channel = group(`choices-bad-${label}`), port = bind(channel);
      await port.write(await port.read(), candidatesValue(candidates)); corrupt(channel, bad);
      const saved = (await port.read()).value;
      assert.equal(saved?.requiresRestatement, true); assert.equal(saved?.focus, undefined);
      assert.ok(saved?.version !== 2 || !saved.orderChoices); await expectBlocked(channel);
    }
    console.log("[conversation-state] v2 candidate CAS/ownership, route isolation, malformed data and expiry keep ambiguity PASS");

    const processGroup = group("process"); bind(processGroup);
    const childInput: ChildInput = { identity, channel: processGroup, orders: [childA, childB] };
    const writer = runContextChild("write", childInput); assert.ok(writer.command);
    await fixture.repriceRefund(childB, 6543);
    const reader = runContextChild("recover", { ...childInput, oldCommand: writer.command, expectedPaidCents: 6543 });
    assert.notEqual(writer.pid, reader.pid); assert.equal(reader.selectedOrderId, childB); assert.equal(reader.paidCents, 6543);
    for (const original of writer.candidates ?? []) {
      const currentCandidate = reader.candidates?.find(candidate => candidate.orderId === original.orderId);
      assert.ok(currentCandidate); assert.equal(currentCandidate.expiresAt, original.expiresAt, "A process restart and selection cannot renew candidate expiry");
    }
    console.log(`[conversation-state] synthetic child ${writer.pid} exit -> child ${reader.pid}: old command rejected, actual new command selected, B fresh read PASS`);

    const policyGroup = group("policy"); bind(policyGroup);
    const policyInput: ChildInput = { identity, channel: policyGroup, orders: [policyOrder, amountOrder] };
    const policyWriter = runContextChild("policy-write", policyInput); assert.ok(policyWriter.referenceRequestId);
    const policyContinued = runContextChild("policy-continue", { ...policyInput, referenceRequestId: policyWriter.referenceRequestId });
    assert.notEqual(policyWriter.pid, policyContinued.pid); assert.ok(policyContinued.command && policyContinued.referenceRequestId);
    assert.ok(policyWriter.sourceIds?.includes("KB-SHOP-DEMO-1"));
    console.log(`[conversation-state] policy child ${policyWriter.pid} exit -> ${policyContinued.pid}: single-topic previous performs fresh MySQL seed lexical retrieval PASS`);
    const policySelected = runContextChild("policy-select", { ...policyInput, oldCommand: policyContinued.command,
      referenceRequestId: policyContinued.referenceRequestId });
    const policySnapshot = await bind(policyGroup).read();
    assert.ok(policySnapshot.value?.version === 3 && policySnapshot.value.policyChoices?.selectedRequestId === policyContinued.referenceRequestId);
    const policyRestored = runContextChild("policy-restore", { ...policyInput, referenceRequestId: policyContinued.referenceRequestId });
    assert.equal(new Set([policyWriter.pid, policyContinued.pid, policySelected.pid, policyRestored.pid]).size, 4);
    assert.ok(policyRestored.sourceIds?.includes("KB-SHOP-DEMO-1"));
    console.log(`[conversation-state] policy children ${policyContinued.pid} -> ${policySelected.pid} -> ${policyRestored.pid}: old command rejected, actual new selection survives another process, selected branch re-retrieved PASS`);

    const amountGroup = group("amount"); bind(amountGroup);
    assert.ok(fixture.orders.includes(amountOrder));
    // Only this fresh fixture is expanded to two separately redeemable coupons. Cleanup already follows its owned order.
    admin(`START TRANSACTION;
UPDATE orders SET status = 'partially_redeemed', total_cents = 15960, paid_cents = 15960 WHERE id = '${amountOrder}';
UPDATE order_items SET quantity = 2, unit_price_cents = 7980, total_cents = 15960 WHERE order_id = '${amountOrder}';
UPDATE payments SET amount_cents = 15960 WHERE order_id = '${amountOrder}';
INSERT INTO coupons (id, order_item_id, status, expires_at, redeemed_at, redeemed_shop_id)
  SELECT CONCAT(c.id, '-used'), c.order_item_id, 'redeemed', c.expires_at, UTC_TIMESTAMP(3), i.shop_id
  FROM coupons c JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = '${amountOrder}';
COMMIT;`);
    const amountInput: ChildInput = { identity, channel: amountGroup, orders: [amountOrder, policyOrder] };
    const amountWriter = runContextChild("amount-write", amountInput);
    assert.equal(amountWriter.paidCents, 7980); assert.ok(amountWriter.referenceRequestId && amountWriter.referenceOrderVersion);
    const amountSnapshot = await bind(amountGroup).read();
    assert.ok(amountSnapshot.value?.version === 3 && amountSnapshot.value.amountChoices?.candidates.length === 1);
    admin(`START TRANSACTION;
UPDATE orders SET total_cents = 13086, paid_cents = 13086 WHERE id = '${amountOrder}';
UPDATE order_items SET unit_price_cents = 6543, total_cents = 13086 WHERE order_id = '${amountOrder}';
UPDATE payments SET amount_cents = 13086 WHERE order_id = '${amountOrder}';
COMMIT;`);
    const amountCompared = runContextChild("amount-compare", { ...amountInput, referenceRequestId: amountWriter.referenceRequestId,
      referenceOrderVersion: amountWriter.referenceOrderVersion });
    assert.notEqual(amountWriter.pid, amountCompared.pid); assert.equal(amountCompared.paidCents, 6543);
    console.log(`[conversation-state] amount child ${amountWriter.pid} exit -> ${amountCompared.pid}: actual historical 7980 vs fresh 6543, unequal, refundApproved=false and zero refund writes PASS`);

    for (const [channel, snapshot] of [[policyGroup, policySnapshot], [amountGroup, amountSnapshot]] as const) {
      const port = bind(channel), current = await port.read();
      await assert.rejects(port.write(snapshot, snapshot.value!), "v3 snapshots also reject revisions superseded by a later child");
      for (const [who, otherChannel] of [[otherUser, channel], [otherApp, channel], [identity, `${channel}-other`]] as const) {
        assert.equal((await bind(otherChannel, who).read()).value, undefined, "Policy questions and historical amounts cannot cross a trusted route");
      }
      const forged = structuredClone(snapshot.value!);
      assert.ok(forged.version === 3);
      const policyCandidate = forged.policyChoices?.candidates[0], amountCandidate = forged.amountChoices?.candidates[0];
      assert.ok(policyCandidate || amountCandidate);
      if (policyCandidate) policyCandidate.topic.orderId = "COUPON-1002";
      if (amountCandidate) amountCandidate.reference.orderId = "COUPON-1002";
      await assert.rejects(port.write(current, forged), "Every persisted policy/amount order is subject to current ownership");
      await assert.rejects(port.write(current, { ...snapshot.value, selectedToken: "forged" } as unknown as Value));
      assert.deepEqual(await port.read(), current);
    }
    const expiredPolicyGroup = group("policy-expired"), expiredPolicyPort = bind(expiredPolicyGroup);
    const expiredPolicy = structuredClone(policySnapshot.value);
    assert.ok(expiredPolicy?.version === 3 && expiredPolicy.policyChoices);
    const selectedPolicyRequest = expiredPolicy.policyChoices.selectedRequestId; assert.ok(selectedPolicyRequest);
    await expiredPolicyPort.write(await expiredPolicyPort.read(), expiredPolicy);
    for (const candidate of expiredPolicy.policyChoices.candidates) if (candidate.topic.requestId === selectedPolicyRequest) candidate.expiresAt = Date.now() - 1;
    corrupt(expiredPolicyGroup, expiredPolicy);
    const expiredPolicyRead = (await expiredPolicyPort.read()).value;
    assert.ok(expiredPolicyRead?.version === 3 && expiredPolicyRead.policyChoices);
    assert.equal(expiredPolicyRead.policyChoices.selectedRequestId, undefined); assert.equal(expiredPolicyRead.policyChoices.candidates.length, 1);
    assert.equal(expiredPolicyRead.policyChoices.selectionRequired, true, "Expired selected policy must not silently select the survivor");
    const expiredPolicyTurn = await turn(await create(expiredPolicyGroup), expiredPolicyGroup, policyFollowup, {
      protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question: policyFollowup,
      questionContext: { kind: "previous", requestId: selectedPolicyRequest } });
    assert.equal(expiredPolicyTurn.result?.outcome, "clarification"); assert.equal(expiredPolicyTurn.result?.evidence.knowledge.length, 0);
    assert.deepEqual(expiredPolicyTurn.reads, []);
    const expiredAmountGroup = group("amount-expired"), expiredAmountPort = bind(expiredAmountGroup);
    const expiredAmount = structuredClone(amountSnapshot.value);
    assert.ok(expiredAmount?.version === 3 && expiredAmount.amountChoices);
    await expiredAmountPort.write(await expiredAmountPort.read(), expiredAmount);
    expiredAmount.amountChoices.candidates[0]!.expiresAt = Date.now() - 1; corrupt(expiredAmountGroup, expiredAmount);
    const expiredAmountRead = (await expiredAmountPort.read()).value;
    assert.ok(expiredAmountRead?.version === 3 && expiredAmountRead.amountChoices);
    assert.equal(expiredAmountRead.amountChoices.candidates.length, 0); assert.equal(expiredAmountRead.amountChoices.selectedRequestId, undefined);
    const expiredCompare = await turn(await create(expiredAmountGroup), expiredAmountGroup, "剩下那张和之前实付一样吗？", {
      protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" }, amountRef: { requestId: amountWriter.referenceRequestId } });
    assert.equal(expiredCompare.result?.outcome, "clarification"); assert.equal(expiredCompare.result?.evidence.amountComparison, undefined);
    assert.deepEqual(expiredCompare.reads, []);
    console.log("[conversation-state] v3 CAS/identity/ownership, expired selection and expired amount fail closed PASS");

    const transferredGroup = group("changed-ownership"), transferredPort = bind(transferredGroup);
    await transferredPort.write(await transferredPort.read(), { ...candidatesValue([{ orderId: childA, requestId: "formerly-owned", expiresAt }],
      { selectionRequired: false, pending: false }), requiresRestatement: false, focus: value(childA).focus });
    // Transfer only a fresh fixture order after a valid snapshot was saved, without forging stored context.
    admin(`UPDATE orders SET customer_id = (SELECT customer_id FROM qq_identities WHERE app_id = 'TEST_APP' AND sender_id = 'TEST_USER2')
      WHERE id = '${childA}' AND customer_id = (SELECT customer_id FROM qq_identities WHERE app_id = '${identity.appId}' AND sender_id = '${identity.senderId}');`);
    try {
      const previousPrepares = refundPrepares, changed = await turn(await create(transferredGroup), transferredGroup, "这笔订单当前情况呢？", action("order"));
      assert.deepEqual(changed.reads, [`order:${childA}`], "Restored locators must reach the current authorization check");
      assert.equal(changed.result?.evidence.order, undefined); assert.notEqual(changed.result?.outcome, "ready");
      assert.equal(changed.reply?.kind, "notice"); assert.equal(refundPrepares, previousPrepares);
      const saved = (await transferredPort.read()).value;
      assert.equal(saved?.requiresRestatement, true); assert.equal(saved?.focus, undefined);
      assert.ok(!saved || saved.version === 1 || !saved.orderChoices?.candidates.length);
    } finally {
      admin(`UPDATE orders SET customer_id = (SELECT customer_id FROM qq_identities WHERE app_id = '${identity.appId}' AND sender_id = '${identity.senderId}') WHERE id = '${childA}';`);
    }
    console.log("[conversation-state] formerly owned candidate/focus loses access after ownership changes; fresh authorization rejects PASS");

    const faultGroup = group("fault"), good = bind(faultGroup); await good.write(await good.read(), value(writeOrder));
    await expectBlocked(faultGroup, { ...good, read: async () => { throw new Error("synthetic-private-read-failure"); } }, identity, true);
    const writeTask = await merchant.request(identity, merchantSourceKey(identity, faultGroup), writeOrder, "持久化写入失败不能重做业务");
    await merchant.applyResult({ taskId: writeTask.taskId, orderId: writeOrder, status: "approved", approvedAmountCents: 7980 });
    let failedWrites = 0;
    const badWrite: Port = { ...good, async write(expected, proposed) {
      if (proposed.focus) { failedWrites++; throw new Error("synthetic-private-write-failure"); }
      return good.write(expected, proposed);
    } };
    const faultSession = await create(faultGroup, badWrite), preparesBefore = refundPrepares;
    const once = await turn(faultSession, faultGroup, `准备 ${writeOrder} 的退款方案`, action("refund_prepare", explicit(writeOrder)), 2);
    assert.equal(refundPrepares - preparesBefore, 1, "Repeated model actions in one turn cannot repeat a committed business preparation after context failure");
    assert.ok(failedWrites > 0); assert.equal(once.result?.evidence.operation?.status, "prepared");
    assert.equal(once.reply?.kind, "refund_confirmation"); assert.doesNotMatch(JSON.stringify(once.reply), /synthetic-private/);
    const [operations] = await pools[1]!.execute<RowDataPacket[]>("SELECT COUNT(*) AS n FROM refund_operations WHERE order_id = ?", [writeOrder]);
    assert.equal(Number(operations[0]!.n), 1);
    const stale = await turn(faultSession, faultGroup, "这笔退款状态呢？", action("refund_status"));
    assert.deepEqual(stale.reads, [], "Failed persistence cannot silently reuse the old locator");
    console.log("[conversation-state] read/write faults fail closed and preserve one committed preparation PASS");

    const qqGroup = group("qq"), delivered: string[] = []; let created = 0;
    qq = new QQAgent(async () => { created++; return create(qqGroup); }, async (_target, text) => { delivered.push(text); }, () => {}, 10_000,
      undefined, undefined, { merchantEvents: "host" });
    faux.setResponses(responses(action("order", explicit(orderB)))); await qq.handle(message(qqGroup, `查看 ${orderB}`));
    const qqSelected = await bind(qqGroup).read(); assert.equal(qqSelected.value?.focus?.orderId, orderB);
    for (let index = 1; index < 20; index++) {
      faux.setResponses(responses(action("order"))); await qq.handle(message(qqGroup, "查看这笔订单"));
    }
    assert.equal(created, 1); const beforeRotate = reads.length;
    faux.setResponses(responses(action("order"))); await qq.handle(message(qqGroup, "轮换后查看这笔订单"));
    assert.equal(created, 2); assert.deepEqual(reads.slice(beforeRotate), [`order:${orderB}`]);
    assert.equal(delivered.length, 21); assert.equal(faux.getPendingResponseCount(), 0);
    assert.deepEqual((await bind(qqGroup).read()).value?.focus, qqSelected.value?.focus);
    const noticeTask = await merchant.request(identity, merchantSourceKey(identity, qqGroup), noticeOrder, "同群另一订单的模拟通知");
    await merchant.applyResult({ taskId: noticeTask.taskId, orderId: noticeOrder, status: "approved", approvedAmountCents: 7980 });
    const modelCalls = faux.state.callCount, beforeNotification = reads.length;
    assert.equal(await qq.resumeMerchant(message(qqGroup, "宿主旧订单结果通知"),
      () => merchant.getTask(identity, merchantSourceKey(identity, qqGroup), noticeOrder)), "sent");
    assert.equal(faux.state.callCount, modelCalls); assert.equal(reads.length, beforeNotification);
    assert.deepEqual((await bind(qqGroup).read()).value?.focus, qqSelected.value?.focus, "An A task notification cannot replace B's persisted user selection");
    faux.setResponses(responses(action("order"))); await qq.handle(message(qqGroup, "继续查看这笔订单"));
    assert.equal(getSupportResult(sessions.at(-1)!)?.evidence.order?.id, orderB);
    console.log("[conversation-state] real QQAgent local transport, 20-turn replacement and A-notification/B-focus isolation PASS");
    console.log("PASS conversation state: real MySQL + Pi/faux, including independent synthetic CLI processes; no paid model or QQ platform requests. Full O4 model/history recovery remains unverified.");
  } finally {
    await qq?.close();
    try {
      if (sourceKeys.size) admin(`DELETE FROM conversation_state WHERE source_key IN (${[...sourceKeys].map(key => `'${key}'`).join(",")});`);
      for (const who of [identity, otherUser, otherApp]) admin(`DELETE FROM qq_identities WHERE app_id = '${who.appId}' AND sender_id = '${who.senderId}';`);
    } finally { try { await fixture.cleanup(); } finally { await close(); } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const childMode = process.argv.find(value => value.startsWith("--context-child="))?.split("=")[1];
  if (childMode) console.log(JSON.stringify(await contextChild(childMode, JSON.parse(readFileSync(0, "utf8")) as ChildInput)));
  else await checkConversationStateDatabase();
}
