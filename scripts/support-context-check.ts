import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime } from "../src/agent.ts";
import { validateSupportContextValue, type SupportContextPort, type SupportContextSnapshot, type SupportContextValue } from "../src/conversation-state.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { QQAgent } from "../src/qq-agent.ts";
import type { ContextOrderRef, ContextSupportAction } from "../src/support-context-action.ts";
import type { TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt,
  readSupportContextMode, supportReply } from "../src/support-session.ts";

const identity = { appId: "CONTEXT_CHECK", senderId: "OWNER" }, groupOpenid = "CONTEXT_GROUP";
const a = "COUPON-4601", b = "COUPON-4602";
const explicit = (orderId: string) => ({ kind: "explicit" as const, orderId });
const orderAction = (orderRef: Exclude<ContextOrderRef, { kind: "alternative" }> = { kind: "focus" }): ContextSupportAction => ({ protocol: "v2.2", kind: "order", orderRef });
type Host = { kind?: string; orderId?: string | null; policyTopic?: { requestId: string } | null;
  itemPaidUnit?: { requestId: string } | null; orderChoices?: TrustedReferenceChoices;
  amountChoices?: { candidates: Array<{ token: string; requestId: string }>; selectionRequired: boolean; selectedToken: string | null };
  policyChoices?: TrustedReferenceChoices; pendingReferenceKind?: string | null };
const hostReference = (context: TranscriptContext): Host => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text))
  .map(text => { try { return JSON.parse(text) as Host; } catch { return {}; } }).filter(value => value.kind === "host_order_reference").at(-1) ?? {};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function memoryContext() {
  let snapshot: SupportContextSnapshot = { revision: 0, customerId: "synthetic-customer", bindingId: "31" };
  const committed: SupportContextSnapshot[] = [];
  let beforeWrite: ((value: SupportContextValue) => Promise<void>) | undefined;
  let beforeReadReturns: ((value: SupportContextSnapshot) => void) | undefined;
  const port: SupportContextPort = {
    read: async () => { const value = structuredClone(snapshot); beforeReadReturns?.(value); return value; },
    async write(expected, input) {
      const value = structuredClone(input);
      await beforeWrite?.(value);
      assert.deepEqual([expected.revision, expected.customerId, expected.bindingId], [snapshot.revision, snapshot.customerId, snapshot.bindingId], "CAS and binding must match at commit");
      snapshot = { revision: snapshot.revision + 1, customerId: snapshot.customerId, bindingId: snapshot.bindingId, value };
      committed.push(structuredClone(snapshot)); return structuredClone(snapshot);
    },
  };
  return { port, committed, value: () => structuredClone(snapshot), intercept: (hook?: typeof beforeWrite) => { beforeWrite = hook; },
    interceptRead: (hook?: typeof beforeReadReturns) => { beforeReadReturns = hook; },
    replace: (value: SupportContextSnapshot) => { snapshot = structuredClone(value); } };
}
function makeOrder(id: string, status: "paid" | "refunded" | "partially_redeemed" = "paid", unitCents = 7980): Awaited<ReturnType<CouponStore["getOrder"]>> {
  const now = new Date().toISOString();
  const quantity = status === "partially_redeemed" ? 2 : 1, paidCents = unitCents * quantity;
  return { source: "demo-database", id, status, asOf: now, createdAt: now, paidAt: now,
    amounts: { totalCents: paidCents, paidCents, refundedCents: status === "refunded" ? paidCents : 0 },
    shop: { id: "shop", name: "合成门店", merchantName: "合成商家", address: "合成地址" },
    items: [{ id: `${id}-item`, productId: "meal", productName: "套餐", quantity, unitPriceCents: unitCents, totalCents: paidCents }],
    coupons: [{ id: `${id}-coupon`, orderItemId: `${id}-item`, status: status === "refunded" ? "refunded" : "unused",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), redeemedAt: null, redeemedShopId: null },
      ...(quantity === 2 ? [{ id: `${id}-used`, orderItemId: `${id}-item`, status: "redeemed", expiresAt: null, redeemedAt: now, redeemedShopId: "shop" }] : [])],
    payments: [{ status: "succeeded", amountCents: paidCents, paidAt: now }], refunds: [] };
}

export async function checkSupportContext() {
  assert.equal(readSupportContextMode("controller", {}), "memory"); assert.equal(readSupportContextMode("atomic", {}), "memory");
  assert.equal(readSupportContextMode("controller", { SUPPORT_CONTEXT_MODE: "mysql", AFTER_SALES_DB_PASSWORD: "synthetic" }), "mysql");
  for (const mode of ["invalid", "MYSQL"]) assert.throws(() => readSupportContextMode("controller", { SUPPORT_CONTEXT_MODE: mode }));
  assert.throws(() => readSupportContextMode("controller", { SUPPORT_CONTEXT_MODE: "mysql" }));
  assert.throws(() => readSupportContextMode("atomic", { SUPPORT_CONTEXT_MODE: "mysql", AFTER_SALES_DB_PASSWORD: "synthetic" }));
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  let sequence = 0;
  async function harness(memory = memoryContext()) {
    const reads: string[] = [], queries: string[] = [];
    let status: "paid" | "refunded" | "partially_redeemed" = "paid", onRead: (() => void) | undefined;
    let price = 7980, body = "套餐有效期内周一至周日均可使用。周末和法定假日遵循同一安排。";
    const store = { async getOrder(who: QQIdentity, id: string) {
      assert.deepEqual(who, identity); assert.ok([a, b].includes(id)); reads.push(id); onRead?.(); return makeOrder(id, status, price);
    }, async searchKnowledge(query: string, shopId?: string, productId?: string) {
      queries.push(query); return [{ source: "demo-knowledge", sourceId: "SYNTHETIC_RULE", title: "合成使用规则",
        body, scope: { shopId: shopId ?? null, productId: productId ?? null } }];
    } } as unknown as CouponStore;
    const open = () => createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid, context: memory.port });
    let session = await open();
    async function run(question: string, action?: ContextSupportAction | ((host: Host) => ContextSupportAction), ending: "ok" | "error" | "no_action" = "ok", checkPending = true) {
      const requestId = `context-${++sequence}`, hosts: Host[] = [], transcripts: Array<TranscriptContext["messages"]> = [];
      prepareSupportPrompt(session, { requestId, groupOpenid, messageId: requestId });
      const final: FauxResponseStep = context => {
        transcripts.push(structuredClone(context.messages));
        return ending === "error" ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic final failure" }) : fauxAssistantMessage("本轮查询已经完成。");
      };
      faux.setResponses(ending === "no_action" ? [final] : action ? [context => {
        transcripts.push(structuredClone(context.messages));
        const host = hostReference(context); hosts.push(structuredClone(host));
        return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(host) : action }), { stopReason: "toolUse" });
      }, final] : []);
      await session.prompt(question, { expandPromptTemplates: false });
      if (checkPending) assert.equal(faux.getPendingResponseCount(), 0);
      return { requestId, host: hosts[0], transcripts, result: getSupportResult(session), receipt: getSupportHostReceipt(session), reply: supportReply(session, session.getLastAssistantText() ?? "") };
    }
    return { memory, reads, queries, store, open, session: () => session, run,
      onRead: (hook?: () => void) => { onRead = hook; },
      status: (value: typeof status) => { status = value; },
      price: (value: number) => { price = value; }, policy: (value: string) => { body = value; },
      restart: async () => { session.dispose(); session = await open(); }, dispose: () => session.dispose() };
  }

  // Real native Session recreation, fresh business data, and a non-sliding selection TTL.
  {
    const h = await harness();
    try {
      const first = await h.run(`查询 ${a}`, orderAction(explicit(a)));
      assert.equal(first.result?.outcome, "ready");
      const saved = h.memory.value(); assert.equal(saved.value?.requiresRestatement, false); assert.equal(saved.value.focus?.requestId, first.requestId);
      assert.deepEqual(h.memory.committed[0]!.value, { version: 1, requiresRestatement: true });
      h.dispose(); assert.deepEqual(h.memory.value(), saved, "normal dispose cannot erase a completed locator");
      saved.value!.focus!.selectedAt -= 10_000; saved.value!.focus!.expiresAt -= 10_000; h.memory.replace(saved);
      await h.restart(); h.status("refunded");
      const next = await h.run("查询这笔订单现在的状态", orderAction());
      assert.equal(next.host?.orderId, a); assert.equal(next.result?.evidence.order?.status, "refunded");
      assert.deepEqual(h.reads, [a, a]); assert.deepEqual(h.memory.value().value?.focus, saved.value!.focus, "following focus must not renew selection timestamps or source request");
    } finally { h.dispose(); }
  }

  // A changed customer binding resets Pi's native branch, not only its current agent message array.
  {
    const h = await harness();
    try {
      const original = await h.run(`查询 ${a}`, orderAction(explicit(a)));
      assert.ok(JSON.stringify(original.transcripts).includes(a), "the old branch must actually contain the old order");
      const previous = h.memory.value();
      h.memory.replace({ revision: previous.revision + 1, customerId: "replacement-customer", bindingId: "32" });
      for (const [question, action] of [[`查询 ${b}`, orderAction(explicit(b))], ["再查询这笔订单的状态", orderAction()]] as const) {
        const turn = await h.run(question, action);
        assert.equal(turn.result?.evidence.order?.id, b); assert.equal(turn.transcripts.length, 2);
        for (const transcript of turn.transcripts) assert.ok(!JSON.stringify(transcript).includes(a), "provider input cannot resurrect old customer tools or facts");
        assert.ok(!JSON.stringify(h.session().messages).includes(a), "native finalized context cannot restore the abandoned customer branch");
      }
      assert.deepEqual(h.reads, [a, b, b]);
    } finally { h.dispose(); }
  }

  // Own blocked writes are crash guards, not external state changes: in-process references stay usable.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a)));
      const first = await h.run("这份套餐周末可以用吗？", { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" },
        question: "这份套餐周末可以用吗？", questionContext: { kind: "standalone" } });
      assert.equal(first.result?.outcome, "ready"); assert.equal(h.memory.value().value?.requiresRestatement, false);
      const second = await h.run("法定假日也按刚才的安排吗？", host => ({ protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" },
        question: "法定假日也按刚才的安排吗？", questionContext: { kind: "previous", requestId: host.policyTopic?.requestId ?? "missing" } }));
      assert.equal(second.host?.policyTopic?.requestId, first.requestId); assert.equal(second.result?.outcome, "ready");
      assert.equal(second.result?.evidence.knowledge[0]?.context.policyTopic?.requestId, first.requestId);
      const offered = await h.run("请显示刚才可选的话题", { protocol: "v2.2", kind: "clarify", field: "policy_topic", reason: "ambiguous" });
      const candidate = offered.result?.evidence.policyChoices?.candidates.find(row => row.reference.kind === "policy" && row.reference.topic.requestId === second.requestId);
      assert.ok(candidate); assert.ok(offered.reply && "text" in offered.reply);
      const command = offered.reply.text.split("\n").find(line => line === `选择话题 ${candidate.token}`); assert.ok(command);
      const before = faux.state.callCount, selected = await h.run(command);
      assert.equal(selected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, before);
      const continued = await h.run("那星期天也按选中的规则吗？", host => ({ protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" },
        question: "那星期天也按选中的规则吗？", questionContext: { kind: "previous", requestId: host.policyTopic?.requestId ?? "missing" } }));
      assert.equal(continued.host?.orderId, a); assert.equal(continued.host?.policyTopic?.requestId, second.requestId);
      assert.equal(continued.result?.outcome, "ready"); assert.deepEqual(h.reads, [a, a, a, a]); assert.equal(h.queries.length, 3);
    } finally { h.dispose(); }
  }
  {
    const h = await harness();
    try {
      h.status("partially_redeemed");
      const first = await h.run(`查询 ${a} 的实付金额`, orderAction(explicit(a)));
      const offered = await h.run("请列出实付金额基准", { protocol: "v2.2", kind: "clarify", field: "amount_basis", reason: "ambiguous" });
      const amount = offered.result?.evidence.amountChoices?.candidates.find(row => row.reference.requestId === first.requestId);
      assert.ok(amount); assert.ok(offered.reply && "text" in offered.reply);
      const command = offered.reply.text.split("\n").find(line => line === `选择金额基准 ${amount.token}`); assert.ok(command);
      const before = faux.state.callCount, selected = await h.run(command);
      assert.equal(selected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, before);
      let referenceRequestId = first.requestId;
      for (let i = 0; i < 2; i++) {
        const compared = await h.run("未使用的这张和刚才展示的实付单价一样吗？", host => ({ protocol: "v2.2", kind: "paid_amount_compare",
          orderRef: { kind: "focus" }, amountRef: { requestId: host.itemPaidUnit?.requestId ?? "missing" } }));
        assert.equal(compared.host?.orderId, a); assert.equal(compared.host?.itemPaidUnit?.requestId, referenceRequestId);
        assert.equal(compared.result?.evidence.amountComparison?.comparisonEqual, true);
        assert.equal(compared.result.evidence.amountComparison.referenceRequestId, referenceRequestId);
        referenceRequestId = compared.result.verifiedAmountReference?.requestId ?? referenceRequestId;
      }
      assert.equal(h.queries.length, 0); assert.equal(h.reads.length, 3);
    } finally { h.dispose(); }
  }
  // Rejecting an old amount token revokes even a previously selected singleton's implicit fallback.
  {
    const h = await harness();
    try {
      h.status("partially_redeemed"); const first = await h.run(`查询 ${a} 的实付金额`, orderAction(explicit(a)));
      const offered = await h.run("请列出实付金额基准", { protocol: "v2.2", kind: "clarify", field: "amount_basis", reason: "ambiguous" });
      const amount = offered.result?.evidence.amountChoices?.candidates.find(row => row.reference.requestId === first.requestId);
      assert.ok(amount); assert.ok(offered.reply && "text" in offered.reply);
      const command = offered.reply.text.split("\n").find(line => line === `选择金额基准 ${amount.token}`); assert.ok(command);
      const before = faux.state.callCount, selected = await h.run(command);
      assert.equal(selected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, before);
      const chosen = h.memory.value().value;
      assert.ok(chosen?.version === 3 && chosen.amountChoices?.selectedRequestId === first.requestId);
      assert.equal(chosen.amountChoices.selectionRequired, false, "start with a selected singleton, not an already ambiguous list");
      await h.restart();
      const rejected = await h.run(command); assert.equal(rejected.receipt?.outcome, "rejected");
      assert.equal(faux.state.callCount, before); assert.equal(h.reads.length, 1);
      const direct = await h.run("剩下的这张与刚才基准一样吗？", { protocol: "v2.2", kind: "paid_amount_compare",
        orderRef: { kind: "focus" }, amountRef: { requestId: first.requestId } });
      assert.equal(direct.host?.itemPaidUnit, null); assert.equal(direct.result?.outcome, "clarification");
      assert.equal(direct.result?.evidence.amountComparison, undefined); assert.equal(h.reads.length, 1);
      const replacement = direct.result?.evidence.amountChoices?.candidates.find(row => row.reference.requestId === first.requestId);
      assert.ok(replacement); assert.notEqual(replacement.token, amount.token); assert.equal(replacement.expiresAt, amount.expiresAt);
      assert.ok(direct.reply && "text" in direct.reply);
      const freshCommand = direct.reply.text.split("\n").find(line => line === `选择金额基准 ${replacement.token}`); assert.ok(freshCommand);
      const beforeReselect = faux.state.callCount, reselected = await h.run(freshCommand);
      assert.equal(reselected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, beforeReselect); assert.equal(h.reads.length, 1);
      const compared = await h.run("未使用的这张和选中的实付一样吗？", host => ({ protocol: "v2.2", kind: "paid_amount_compare",
        orderRef: { kind: "focus" }, amountRef: { requestId: host.itemPaidUnit?.requestId ?? "missing" } }));
      assert.equal(compared.host?.itemPaidUnit?.requestId, first.requestId);
      assert.equal(compared.result?.evidence.amountComparison?.comparisonEqual, true);
      assert.equal(compared.result?.evidence.amountComparison?.referenceRequestId, first.requestId);
      assert.equal(h.reads.length, 2); assert.equal(h.queries.length, 0);
    } finally { h.dispose(); }
  }
  {
    const h = await harness();
    try {
      const first = await h.run(`查询 ${a}`, orderAction(explicit(a))); await h.run(`查询 ${b}`, orderAction(explicit(b)));
      const offered = await h.run("请列出可选订单", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const candidate = offered.result?.evidence.orderReferenceChoices?.candidates.find(row => row.reference.kind === "order" && row.reference.requestId === first.requestId);
      assert.ok(candidate); assert.ok(offered.reply && "text" in offered.reply);
      const command = offered.reply.text.split("\n").find(line => line === `选择订单 ${candidate.token}`); assert.ok(command);
      const before = faux.state.callCount, selected = await h.run(command);
      assert.equal(selected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, before);
      assert.equal(h.memory.value().value?.focus?.source, "selection"); assert.equal(h.memory.value().value?.requiresRestatement, false);
      await h.restart();
      const recovered = await h.run("查我选中这笔的状态", orderAction());
      assert.equal(recovered.result?.evidence.order?.id, a); assert.deepEqual(h.reads, [a, b, a]);
    } finally { h.dispose(); }
  }

  // Recovered policy questions supply intent, while the current query retrieves new evidence.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a)));
      const question = "这份套餐周末能用吗？";
      const prior = await h.run(question, { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question, questionContext: { kind: "standalone" } });
      const saved = h.memory.value().value; assert.ok(saved?.version === 3 && saved.policyChoices);
      assert.equal(saved.policyChoices.selectedRequestId, undefined, "a unique implicit topic is not an explicit user choice");
      assert.equal(saved.policyChoices.candidates[0]!.topic.requestId, prior.requestId);
      const oldVersion = saved.policyChoices.candidates[0]!.topic.sources[0]!.version;
      h.policy("合成新规则：周末使用需提前预约。法定假日同样需预约。"); await h.restart();
      const resumed = await h.run("那法定假日呢？", host => ({ protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question: "那法定假日呢？",
        questionContext: { kind: "previous", requestId: host.policyTopic?.requestId ?? "missing" } }));
      assert.equal(resumed.host?.orderId, a); assert.equal(resumed.host?.policyTopic?.requestId, prior.requestId);
      assert.equal(resumed.result?.outcome, "ready"); assert.equal(h.queries.length, 2); assert.deepEqual(h.reads, [a, a, a]);
      assert.ok(h.queries[1]!.includes(question)); assert.ok(h.queries[1]!.includes("法定假日"));
      assert.notEqual(resumed.result.evidence.rules[0]!.version, oldVersion); assert.ok(resumed.result.evidence.rules[0]!.body.includes("合成新规则"));
    } finally { h.dispose(); }
  }
  // Policy ambiguity, fresh presentation and a real prior choice survive separate Session replacements.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a)));
      const questions = ["这份套餐周末可用吗？", "这份套餐假日需要预约吗？"];
      const first = await h.run(questions[0]!, { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question: questions[0]!, questionContext: { kind: "standalone" } });
      await h.run(questions[1]!, { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question: questions[1]!, questionContext: { kind: "standalone" } });
      const offered = await h.run("请列出话题", { protocol: "v2.2", kind: "clarify", field: "policy_topic", reason: "ambiguous" });
      const old = offered.result?.evidence.policyChoices?.candidates.find(row => row.reference.kind === "policy" && row.reference.topic.requestId === first.requestId); assert.ok(old);
      const saved = h.memory.value().value; assert.ok(saved?.version === 3 && saved.policyChoices);
      assert.equal(saved.pendingReferenceKind, "policy"); assert.equal(saved.requiresRestatement, false);
      await h.restart(); const before = faux.state.callCount;
      const rejected = await h.run(`选择话题 ${old.token}`); assert.equal(rejected.receipt?.outcome, "rejected");
      assert.ok(rejected.receipt?.version === "reference-selection-v1");
      const fresh = rejected.receipt.choices.candidates.find(row => row.reference.kind === "policy" && row.reference.topic.requestId === first.requestId); assert.ok(fresh);
      assert.notEqual(fresh.token, old.token); assert.equal(fresh.expiresAt, old.expiresAt);
      assert.ok(rejected.reply && "text" in rejected.reply && rejected.reply.text.includes(`选择话题 ${fresh.token}`));
      const selected = await h.run(`选择话题 ${fresh.token}`); assert.equal(selected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, before);
      const chosen = h.memory.value().value; assert.ok(chosen?.version === 3); assert.equal(chosen.policyChoices?.selectedRequestId, first.requestId);
      await h.restart();
      const resumed = await h.run("那周日也一样吗？", host => ({ protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question: "那周日也一样吗？",
        questionContext: { kind: "previous", requestId: host.policyTopic?.requestId ?? "missing" } }));
      assert.equal(resumed.host?.policyTopic?.requestId, first.requestId); assert.equal(resumed.result?.outcome, "ready");
      assert.ok(h.queries.at(-1)!.includes(questions[0]!)); assert.ok(!h.queries.at(-1)!.includes(questions[1]!));
    } finally { h.dispose(); }
  }
  // A persisted display is historical evidence: compare it to fresh facts without inventing refund authority.
  {
    const h = await harness();
    try {
      h.status("partially_redeemed"); const prior = await h.run(`查询 ${a} 实付`, orderAction(explicit(a)));
      const saved = h.memory.value().value; assert.ok(saved?.version === 3 && saved.amountChoices);
      assert.equal(saved.amountChoices.candidates[0]!.reference.paidCents, 7980); assert.equal(saved.amountChoices.selectedRequestId, undefined);
      h.price(6543); await h.restart();
      const compared = await h.run("剩下这张和刚才展示的单价一样吗？", host => ({ protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" },
        amountRef: { requestId: host.itemPaidUnit?.requestId ?? "missing" } }));
      const comparison = compared.result?.evidence.amountComparison; assert.ok(comparison);
      assert.equal(comparison.referenceRequestId, prior.requestId); assert.equal(comparison.referencePaidCents, 7980);
      assert.equal(comparison.remainingUnitPaidCents, 6543); assert.equal(comparison.comparisonEqual, false); assert.equal(comparison.refundApproved, false);
      assert.notEqual(comparison.currentOrderVersion, comparison.referenceOrderVersion); assert.deepEqual(h.reads, [a, a]); assert.equal(h.queries.length, 0);
    } finally { h.dispose(); }
  }
  // A newly generated amount token is not a presentation proof; actual redisplay is required before choosing it.
  {
    const h = await harness();
    try {
      h.status("partially_redeemed"); await h.run(`查询 ${a}`, orderAction(explicit(a))); await h.restart();
      const asked = await h.run("这份套餐周末能用吗？", { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question: "这份套餐周末能用吗？", questionContext: { kind: "standalone" } });
      const hidden = asked.host?.amountChoices?.candidates[0]; assert.ok(hidden);
      const before = faux.state.callCount, reads = h.reads.length;
      const rejected = await h.run(`选择金额基准 ${hidden.token}`); assert.equal(rejected.receipt?.outcome, "rejected");
      assert.ok(rejected.reply && "text" in rejected.reply && rejected.reply.text.includes(`选择金额基准 ${hidden.token}`));
      const selected = await h.run(`选择金额基准 ${hidden.token}`); assert.equal(selected.receipt?.outcome, "selected");
      assert.equal(faux.state.callCount, before); assert.equal(h.reads.length, reads);
      const saved = h.memory.value().value; assert.ok(saved?.version === 3 && saved.amountChoices?.selectedRequestId === hidden.requestId);
      await h.restart();
      const next = await h.run("剩下这张的实付和基准一样吗？", host => ({ protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" },
        amountRef: { requestId: host.itemPaidUnit?.requestId ?? "missing" } }));
      assert.equal(next.host?.itemPaidUnit?.requestId, hidden.requestId); assert.equal(next.result?.evidence.amountComparison?.comparisonEqual, true);
    } finally { h.dispose(); }
  }

  // A selection can expire after the store validated it but before Session hydration.
  // A later legitimate query may add a candidate, but cannot make that candidate the old user's choice.
  for (const kind of ["policy", "amount"] as const) {
    const h = await harness(), originalNow = Date.now;
    let clock = originalNow(); Date.now = () => clock;
    try {
      h.status("partially_redeemed");
      const order = await h.run(`查询 ${a}`, orderAction(explicit(a)));
      const question = "这份套餐周末能用吗？";
      const policyAction: ContextSupportAction = { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" }, question,
        questionContext: { kind: "standalone" } };
      const prior = kind === "policy" ? await h.run(question, policyAction) : order;
      const snapshot = h.memory.value(); assert.ok(snapshot.value?.version === 3);
      const choices = kind === "policy" ? snapshot.value.policyChoices : snapshot.value.amountChoices;
      assert.ok(choices); assert.equal(choices.candidates.length, 1);
      choices.candidates[0]!.expiresAt = clock + 1;
      choices.selectedRequestId = prior.requestId; choices.selectionRequired = false;
      h.memory.replace(snapshot); await h.restart();
      h.memory.interceptRead(value => {
        value.value = validateSupportContextValue(value.value, { now: clock, allowExpiredFocus: true });
        assert.ok(value.value.version === 3);
        const validated = kind === "policy" ? value.value.policyChoices : value.value.amountChoices;
        assert.equal(validated?.selectedRequestId, prior.requestId); assert.equal(validated?.selectionRequired, false);
        clock++; h.memory.interceptRead();
      });
      const hydrate = await h.run("我需要先确认本次需求", { protocol: "v2.2", kind: "clarify", field: "intent", reason: "missing" });
      const hydrated = kind === "policy" ? hydrate.host?.policyChoices : hydrate.host?.amountChoices;
      assert.equal(hydrated?.candidates.length, 0); assert.equal(hydrated?.selectionRequired, true);
      assert.ok(!hydrated?.selectedToken); assert.equal(kind === "policy" ? hydrate.host?.policyTopic : hydrate.host?.itemPaidUnit, null);
      const added = kind === "policy" ? await h.run(question, policyAction) : await h.run(`查询 ${a} 的实付`, orderAction(explicit(a)));
      assert.equal(added.result?.outcome, "ready");
      const saved = h.memory.value().value; assert.ok(saved?.version === 3);
      const retained = kind === "policy" ? saved.policyChoices : saved.amountChoices;
      assert.equal(retained?.candidates.length, 1); assert.equal(retained?.selectionRequired, true); assert.equal(retained?.selectedRequestId, undefined);
      const reads = h.reads.length, queries = h.queries.length;
      const followup = kind === "policy"
        ? await h.run("那周日也按前面的规则吗？", { protocol: "v2.2", kind: "policy", orderRef: { kind: "focus" },
          question: "那周日也按前面的规则吗？", questionContext: { kind: "previous", requestId: added.requestId } })
        : await h.run("剩余的实付和基准一样吗？", { protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" },
          amountRef: { requestId: added.requestId } });
      assert.equal(followup.result?.outcome, "clarification");
      assert.equal(h.reads.length, reads); assert.equal(h.queries.length, queries);
    } finally { h.memory.interceptRead(); h.dispose(); Date.now = originalNow; }
  }

  // A restart keeps the conflict, but old selection commands and presentation proofs expire with the Session.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a))); await h.run(`查询 ${b}`, orderAction(explicit(b)));
      const offered = await h.run("选哪笔订单？", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const old = offered.result?.evidence.orderReferenceChoices?.candidates.find(row => row.reference.kind === "order" && row.reference.orderId === b);
      assert.ok(old); assert.ok(offered.reply && "text" in offered.reply && offered.reply.text.includes(`选择订单 ${old.token}`));
      const saved = h.memory.value(); assert.equal(saved.value?.version, 3);
      assert.ok(saved.value?.version === 3 && saved.value.orderChoices?.pending);
      const deadlines = saved.value.orderChoices.candidates.map(row => row.expiresAt);
      assert.doesNotMatch(JSON.stringify(saved.value.orderChoices), /token|presentation|paidCents|approved/);
      await h.restart(); const modelCalls = faux.state.callCount, readCount = h.reads.length;
      const rejected = await h.run(`选择订单 ${old.token}`);
      assert.equal(rejected.receipt?.outcome, "rejected"); assert.equal(faux.state.callCount, modelCalls); assert.equal(h.reads.length, readCount);
      assert.ok(rejected.receipt?.version === "reference-selection-v1");
      const fresh = rejected.receipt.choices.candidates.find(row => row.reference.kind === "order" && row.reference.orderId === b);
      assert.ok(fresh); assert.notEqual(fresh.token, old.token);
      assert.deepEqual(rejected.receipt.choices.candidates.map(row => row.expiresAt), deadlines);
      assert.ok(rejected.reply && "text" in rejected.reply && rejected.reply.text.includes(`选择订单 ${fresh.token}`));
      const selected = await h.run(`选择订单 ${fresh.token}`);
      assert.equal(selected.receipt?.outcome, "selected"); assert.equal(faux.state.callCount, modelCalls); assert.equal(h.reads.length, readCount);
      h.status("refunded"); await h.restart();
      const current = await h.run("查选中这笔的当前状态", orderAction());
      assert.equal(current.result?.evidence.order?.id, b); assert.equal(current.result?.evidence.order?.status, "refunded");
      assert.deepEqual(h.reads, [a, b, b]);
    } finally { h.dispose(); }
  }
  // Losing one expired candidate must not resolve a pending choice in favor of the survivor.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a))); await h.run(`查询 ${b}`, orderAction(explicit(b)));
      await h.run("这笔是哪单？", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const snapshot = h.memory.value(); assert.ok(snapshot.value && snapshot.value.version !== 1 && snapshot.value.orderChoices);
      snapshot.value.orderChoices.candidates[0]!.expiresAt = Date.now() - 1;
      h.memory.replace(snapshot); await h.restart(); const before = h.reads.length;
      const resumed = await h.run("查它的状态", orderAction());
      assert.equal(resumed.host?.orderId, null); assert.equal(resumed.host?.pendingReferenceKind, "order");
      assert.equal(resumed.result?.outcome, "clarification"); assert.equal(h.reads.length, before);
      assert.equal(resumed.result.evidence.orderReferenceChoices?.candidates.length, 1);
      assert.ok(resumed.result.evidence.orderReferenceChoices?.selectionRequired);
    } finally { h.dispose(); }
  }
  // The non-sliding focus may expire while a more recent authorized query still supplies a live candidate.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a)));
      const snapshot = h.memory.value(); assert.ok(snapshot.value?.focus && snapshot.value.version !== 1 && snapshot.value.orderChoices);
      snapshot.value.focus.selectedAt = Date.now() - 16 * 60_000; snapshot.value.focus.expiresAt = Date.now() - 60_000;
      const expiry = snapshot.value.orderChoices.candidates[0]!.expiresAt;
      h.memory.replace(snapshot); const before = h.reads.length;
      const resumed = await h.run("这笔现在怎样？", orderAction());
      assert.equal(resumed.host?.orderId, null); assert.equal(resumed.result?.outcome, "clarification"); assert.equal(h.reads.length, before);
      assert.equal(resumed.result.evidence.orderReferenceChoices?.candidates[0]?.expiresAt, expiry);
      assert.ok(resumed.result.evidence.orderReferenceChoices?.selectionRequired);
    } finally { h.dispose(); }
  }

  // A candidate-only publication also contains recoverable context, even though it still requires a choice.
  {
    const h = await harness(), entered = deferred(), release = deferred();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a))); await h.run(`查询 ${b}`, orderAction(explicit(b)));
      h.memory.intercept(async value => { if (value.version !== 1 && value.orderChoices?.pending) { entered.resolve(); await release.promise; } });
      const old = h.run("让我选单", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      await entered.promise; cancelSupportTurn(h.session()); release.resolve(); await old;
      assert.deepEqual(h.memory.value().value, { version: 1, requiresRestatement: true });
      h.memory.intercept(); await h.restart(); const reads = h.reads.length;
      const resumed = await h.run("继续处理它", orderAction());
      assert.equal(resumed.result?.outcome, "clarification"); assert.equal(h.reads.length, reads);
      assert.equal(resumed.host?.orderChoices?.candidates.length, 0);
    } finally { release.resolve(); h.dispose(); }
  }

  for (const ending of ["error", "no_action"] as const) {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a)));
      await h.run("再查这笔的状态", orderAction(), ending);
      assert.deepEqual(h.memory.value().value, { version: 1, requiresRestatement: true });
      await h.restart(); const reads = h.reads.length;
      const resumed = await h.run("再查这笔", orderAction());
      assert.equal(resumed.host?.orderId, null); assert.equal(resumed.result?.outcome, "clarification"); assert.equal(h.reads.length, reads);
    } finally { h.dispose(); }
  }
  {
    const h = await harness();
    try {
      h.memory.intercept(async () => { throw new Error("synthetic pre-write failure"); });
      const before = faux.state.callCount;
      await assert.rejects(h.run(`查询 ${a}`, orderAction(explicit(a))), /本轮尚未处理业务/);
      assert.equal(faux.state.callCount, before); assert.equal(h.reads.length, 0); assert.equal(h.queries.length, 0);
      assert.equal(getSupportResult(h.session()), undefined); faux.setResponses([]);
    } finally { h.dispose(); }
  }

  // Pi can resolve a canceled prompt normally: no exception is required for invalidation.
  {
    const h = await harness();
    try {
      await h.run(`查询 ${a}`, orderAction(explicit(a)));
      h.onRead(() => { cancelSupportTurn(h.session()); void h.session().abort().catch(() => {}); });
      prepareSupportPrompt(h.session(), { requestId: "normal-resolve-cancel", groupOpenid, messageId: "normal-resolve-cancel" });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("support_action", { action: orderAction() }), { stopReason: "toolUse" })]);
      await h.session().prompt("再查这笔订单", { expandPromptTemplates: false });
      assert.deepEqual(h.memory.value().value, { version: 1, requiresRestatement: true });
      h.onRead(); const before = h.reads.length;
      const resumed = await h.run("查一下它现在怎样", orderAction());
      assert.equal(resumed.host?.orderId, null); assert.equal(resumed.result?.outcome, "clarification"); assert.equal(h.reads.length, before);
    } finally { h.dispose(); }
  }

  for (const replace of [false, true]) {
    const h = await harness(), entered = deferred(), release = deferred(); let once = true;
    h.memory.intercept(async value => { if (once && !value.requiresRestatement) { once = false; entered.resolve(); await release.promise; } });
    try {
      // The replaced turn may settle while the next turn's faux responses are still queued.
      const old = h.run(`查询 ${a}`, orderAction(explicit(a)), "ok", false); await entered.promise;
      const before = faux.state.callCount; assert.deepEqual(h.memory.value().value, { version: 1, requiresRestatement: true });
      if (!replace) {
        cancelSupportTurn(h.session()); release.resolve(); await old;
        assert.deepEqual(h.memory.value().value, { version: 1, requiresRestatement: true });
        assert.equal(h.memory.committed.at(-2)!.value?.focus?.orderId, a);
      } else {
        const next = h.run(`查询 ${b}`, orderAction(explicit(b)));
        await new Promise<void>(done => setImmediate(done)); assert.equal(faux.state.callCount, before); assert.deepEqual(h.reads, [a]);
        release.resolve(); const [, resumed] = await Promise.all([old, next]);
        assert.equal(resumed.result?.evidence.order?.id, b); assert.equal(getSupportResult(h.session())?.evidence.requestId, resumed.requestId);
        assert.equal(h.memory.value().value?.focus?.orderId, b);
        assert.deepEqual(h.memory.committed[2]!.value, { version: 1, requiresRestatement: true }, "late final focus is invalidated before the next ingress reads it");
        assert.deepEqual(h.reads, [a, b]); assert.equal(faux.state.callCount, before + 2);
      }
    } finally { release.resolve(); h.dispose(); }
  }

  // A policy-only context also needs cancellation invalidation even without an order focus.
  {
    const h = await harness(), entered = deferred(), release = deferred();
    try {
      h.memory.intercept(async value => { if (value.version === 3 && value.policyChoices?.candidates.length) { entered.resolve(); await release.promise; } });
      const old = h.run("周末有什么使用规则？", { protocol: "v2.2", kind: "policy", question: "周末有什么使用规则？", questionContext: { kind: "standalone" } });
      await entered.promise; cancelSupportTurn(h.session()); release.resolve(); await old;
      assert.deepEqual(h.memory.value().value, { version: 1, requiresRestatement: true });
      h.memory.intercept(); await h.restart(); const queries = h.queries.length;
      const resumed = await h.run("那周日呢？", { protocol: "v2.2", kind: "policy", question: "那周日呢？", questionContext: { kind: "previous", requestId: "expired" } });
      assert.equal(resumed.host?.policyTopic, null); assert.equal(resumed.result?.outcome, "clarification"); assert.equal(h.queries.length, queries);
    } finally { release.resolve(); h.dispose(); }
  }

  // QQ close cancels idle native sessions but must not revoke a successfully committed selection.
  {
    const h = await harness(); let delivered = 0;
    const qq = new QQAgent(async () => h.session(), async () => { delivered++; }, () => {}, 2000, undefined, undefined, { merchantEvents: "host" });
    try {
      const id = "context-qq-close", content = `查询 ${a}`, timestamp = new Date().toISOString();
      const message: QQBotInboundMessage = { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId, groupOpenid,
        messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: groupOpenid, msgId: id },
        raw: { id, content, timestamp, group_openid: groupOpenid, author: { member_openid: identity.senderId } } };
      faux.setResponses([fauxAssistantMessage(fauxToolCall("support_action", { action: orderAction(explicit(a)) }), { stopReason: "toolUse" }), fauxAssistantMessage("已核实当前订单。")]);
      await qq.handle(message); assert.equal(delivered, 1); assert.equal(h.memory.value().value?.requiresRestatement, false);
      const saved = h.memory.value(); await qq.close(); assert.deepEqual(h.memory.value(), saved);
    } finally { await qq.close(); h.dispose(); }
  }
  console.log("[support-context] real Pi/faux: fresh recovery, fixed TTL, invalid selection and hydration expiry, same-session references, failed-turn blocking, pre-write stop, canceled publication ordering and idle close PASS (0 SQL/API)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkSupportContext();
