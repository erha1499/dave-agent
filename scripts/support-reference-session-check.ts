import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import { merchantSourceKey, type AfterSalesStore } from "../src/after-sales.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import type { SupportContextPort, SupportContextSnapshot } from "../src/conversation-state.ts";
import type { RefundStore } from "../src/refunds.ts";
import type { ContextOrderRef, ContextSupportAction } from "../src/support-context-action.ts";
import type { SupportCall, TrustedPolicyTopic } from "../src/support-controller.ts";
import type { TrustedReferenceChoices } from "../src/support-reference-selection.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";

type Host = { kind?: string; orderId?: string | null; alternativeOrderId?: string | null; policyTopic?: TrustedPolicyTopic | null;
  itemPaidUnit?: { requestId: string; orderId: string; paidCents: number } | null;
  policyChoices?: TrustedReferenceChoices; orderChoices?: TrustedReferenceChoices; pendingReferenceKind?: "order" | "policy" | null };
const hostReference = (context: TranscriptContext): Host => context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : message.content.filter(part => part.type === "text").map(part => part.text))
  .map(text => { try { return JSON.parse(text) as Host; } catch { return {}; } })
  .filter(value => value.kind === "host_order_reference").at(-1) ?? {};
const identity = { appId: "REFERENCE_SESSION", senderId: "OWNER" }, groupOpenid = "REFERENCE_GROUP";
const a = "COUPON-4201", b = "COUPON-4202", c = "COUPON-4203";
const explicit = (orderId: string) => ({ kind: "explicit" as const, orderId });
const standalone = (question: string, orderRef?: ContextOrderRef): ContextSupportAction => ({ protocol: "v2.2", kind: "policy", question,
  questionContext: { kind: "standalone" }, ...(orderRef ? { orderRef } : {}) });
const previous = (question: string, requestId: string, orderRef?: ContextOrderRef): ContextSupportAction => ({ protocol: "v2.2", kind: "policy", question,
  questionContext: { kind: "previous", requestId }, ...(orderRef ? { orderRef } : {}) });
function makeOrder(id: string): Awaited<ReturnType<CouponStore["getOrder"]>> {
  const now = "2026-10-06T00:00:00.000Z";
  return { source: "demo-database", id, status: "paid", asOf: now, createdAt: now, paidAt: now,
    amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
    shop: { id: "shop", name: "门店", merchantName: "商家", address: "地址" },
    items: [{ id: `${id}-item`, productId: "meal", productName: "套餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [{ id: `${id}-coupon`, orderItemId: `${id}-item`, status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
}

export async function checkSupportReferenceSession() {
  const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
  let sequence = 0;
  async function harness(label: string, who: QQIdentity = identity, group = groupOpenid, context?: SupportContextPort, readOrder = makeOrder) {
    const reads: Array<{ identity: QQIdentity; id: string }> = [], queries: string[] = [], calls: SupportCall[] = [], focusWrites: Array<string | undefined> = [];
    let writes = 0, failReads = false, focus: string | undefined;
    const store = { async getOrder(actor: QQIdentity, id: string) {
      assert.deepEqual(actor, who); reads.push({ identity: structuredClone(actor), id });
      if (failReads) throw new Error("synthetic failed order lookup");
      assert.ok([a, b, c].includes(id)); return readOrder(id);
    }, async searchKnowledge(query: string, shopId?: string, productId?: string) {
      queries.push(query);
      return [{ source: "demo-knowledge", sourceId: "RF005", title: "合成咨询规则", body: "微信与银行卡按各自渠道时限处理；套餐有效期内可按规则使用，具体条件以本次查询为准。",
        scope: { shopId: shopId ?? null, productId: productId ?? null } }];
    } } as unknown as CouponStore;
    const unexpectedWrite = async () => { writes++; throw new Error("unexpected business write"); };
    const session = await createSupportSession(who, store, runtime, faux.getModel(), {
      sourceKey: merchantSourceKey(who, group), store: { prepare: unexpectedWrite, getTask: async () => null } as unknown as AfterSalesStore,
      refunds: { prepare: unexpectedWrite, get: async () => null } as unknown as RefundStore,
    }, { groupOpenid: group, ...(context ? { context } : {
      focus: { read: async () => focus, write: async (value: string | undefined) => { focusWrites.push(value); focus = value; } } }) });
    const snapshot = () => ({ reads: reads.length, queries: queries.length, writes, providerCalls: faux.state.callCount, focusWrites: focusWrites.length });
    async function run(question: string, action?: ContextSupportAction | ((host: Host) => ContextSupportAction),
      options: { images?: Array<{ type: "image"; mimeType: string; data: string }>; failure?: boolean } = {}) {
      const requestId = `${label}-${++sequence}`, hosts: Host[] = [];
      prepareSupportPrompt(session, { requestId, groupOpenid: group, messageId: requestId, onCall: call => calls.push(call) });
      const steps: FauxResponseStep[] = options.failure
        ? [() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic provider failure" })]
        : action ? [context => {
          const host = hostReference(context); hosts.push(structuredClone(host));
          return fauxAssistantMessage(fauxToolCall("support_action", { action: typeof action === "function" ? action(host) : action }), { stopReason: "toolUse" });
        }, () => fauxAssistantMessage("已按本轮证据完成说明。")]
          : [];
      faux.setResponses(steps);
      await session.prompt(question, { expandPromptTemplates: false, ...(options.images ? { images: options.images } : {}) });
      assert.equal(faux.getPendingResponseCount(), 0, `${label}: all planned faux responses consumed`);
      const receipt = getSupportHostReceipt(session);
      if (!options.failure && !receipt) assert.ok(!session.agent.state.errorMessage, session.agent.state.errorMessage ?? "unexpected model failure");
      return { requestId, question, host: hosts[0], result: getSupportResult(session), receipt, reply: supportReply(session, session.getLastAssistantText() ?? "") };
    }
    const queryOrder = (id: string) => run(`查询 ${id}`, { protocol: "v2.2", kind: "order", orderRef: explicit(id) });
    const select = async (command: string, images?: Array<{ type: "image"; mimeType: string; data: string }>) => {
      const before = snapshot(), result = await run(command, undefined, { images });
      assert.deepEqual(snapshot(), before, "host selection cannot invoke a model, read business data, write focus or prepare operations");
      assert.equal(result.result, undefined); assert.ok(result.receipt); return result;
    };
    return { session, reads, queries, calls, focusWrites, snapshot, run, queryOrder, select, failReads: (value: boolean) => { failReads = value; } };
  }
  type Turn = Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["run"]>>;
  const replyText = (turn: Turn) => { assert.ok(turn.reply && "text" in turn.reply); return turn.reply.text; };
  const commandFor = (turn: Turn, kind: "order" | "policy", sourceRequestId: string) => {
    const choices = kind === "order" ? turn.result?.evidence.orderReferenceChoices : turn.result?.evidence.policyChoices;
    const candidate = choices?.candidates.find(row => (row.reference.kind === "order" ? row.reference.requestId : row.reference.topic.requestId) === sourceRequestId);
    assert.ok(candidate, "the candidate must come from the actual evidence snapshot");
    const command = replyText(turn).split("\n").find(line => line === `选择${kind === "order" ? "订单" : "话题"} ${candidate.token}`);
    assert.ok(command, "only a full command actually shown in the reply may be selected"); return command;
  };
  const assertReady = (turn: Turn) => { assert.equal(turn.result?.outcome, "ready"); assert.ok(turn.result?.verifiedPolicyTopic); };
  const assertNoBusinessWrite = (fixture: Awaited<ReturnType<typeof harness>>) => {
    assert.equal(fixture.snapshot().writes, 0); assert.ok(fixture.calls.every(call => ["get_order", "search_faq"].includes(call.name)));
  };

  // A single policy branch follows actual current questions through fresh order reads.
  {
    const h = await harness("single");
    try {
      const first = await h.run(`${a} 的入店使用日期有什么要求？`, standalone(`${a} 的入店使用日期有什么要求？`, explicit(a)));
      const second = await h.run("周末也按这个安排吗？", host => previous("周末也按这个安排吗？", host.policyTopic?.requestId ?? "missing", { kind: "focus" }));
      const third = await h.run("法定假日也一样吗？", host => previous("法定假日也一样吗？", host.policyTopic?.requestId ?? "missing", { kind: "focus" }));
      for (const turn of [first, second, third]) assertReady(turn);
      assert.equal(second.result!.verifiedPolicyTopic!.originalQuery, second.question);
      assert.equal(third.result!.verifiedPolicyTopic!.originalQuery, third.question);
      assert.deepEqual(third.result!.verifiedPolicyTopic!.priorQueries, [first, second].map(turn => ({ requestId: turn.requestId, originalQuery: turn.question })));
      assert.equal(third.host?.policyChoices?.candidates.length, 1);
      assert.equal(third.result!.evidence.knowledge[0]!.context.policyTopic?.requestId, second.requestId);
      assert.deepEqual(h.reads.map(read => read.id), [a, a, a]); assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // Same source, two channels: a valid historical request ID is not user selection.
  {
    const h = await harness("policy");
    try {
      const first = await h.run("微信支付的退款多久能到账？", standalone("微信支付的退款多久能到账？"));
      const second = await h.run("银行卡支付的退款多久能到账？", standalone("银行卡支付的退款多久能到账？"));
      assertReady(first); assertReady(second);
      assert.deepEqual(first.result!.verifiedPolicyTopic!.sources, second.result!.verifiedPolicyTopic!.sources);
      const before = h.queries.length;
      const disputed = await h.run("周末也算在这个时间内吗？", previous("周末也算在这个时间内吗？", first.requestId));
      assert.equal(disputed.result?.outcome, "clarification"); assert.equal(h.queries.length, before);
      assert.equal(disputed.host?.policyTopic, null); assert.equal(disputed.result?.evidence.policyChoices?.candidates.length, 2);
      assert.match(replyText(disputed), /微信支付/); assert.match(replyText(disputed), /银行卡支付/);
      const command = commandFor(disputed, "policy", first.requestId), selected = await h.select(command);
      assert.equal(selected.receipt?.outcome, "selected"); assert.equal(selected.receipt?.version, "reference-selection-v1");
      assert.ok(selected.receipt?.version === "reference-selection-v1");
      assert.equal(selected.receipt.presentationRequestId, disputed.requestId); assert.equal(selected.receipt.selectedRequestId, first.requestId);
      assert.deepEqual(selected.receipt.trustedRoute, { groupOpenid, messageId: selected.requestId });
      const follow1 = await h.run("周末也计入吗？", host => previous("周末也计入吗？", host.policyTopic?.requestId ?? "missing"));
      const follow2 = await h.run("法定假日呢？", host => previous("法定假日呢？", host.policyTopic?.requestId ?? "missing"));
      assertReady(follow1); assertReady(follow2);
      assert.equal(follow1.host?.pendingReferenceKind, null); assert.equal(follow2.host?.pendingReferenceKind, null);
      assert.equal(follow2.host?.policyChoices?.candidates.length, 2);
      assert.deepEqual(follow2.result!.verifiedPolicyTopic!.priorQueries, [first, follow1].map(turn => ({ requestId: turn.requestId, originalQuery: turn.question })));
      assert.equal(follow2.result!.verifiedPolicyTopic!.originalQuery, follow2.question);
      assert.equal((await h.select(command)).receipt?.outcome, "rejected", "successful continuation rotates the selected source token");
      assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // A complete new question remains available while an old selection is unresolved.
  {
    const h = await harness("pending");
    try {
      const first = await h.run("微信支付退款多久能到账？", standalone("微信支付退款多久能到账？"));
      await h.run("银行卡退款多久到账？", standalone("银行卡退款多久到账？"));
      await h.run("这个期限也算周末吗？", previous("这个期限也算周末吗？", first.requestId));
      const independent = await h.run("到店使用团购券必须提前预约吗？", standalone("到店使用团购券必须提前预约吗？"));
      assertReady(independent); assert.equal(independent.result!.evidence.knowledge[0]!.context.policyTopic, null);
      const before = h.queries.length;
      const unresolved = await h.run("那还需要等吗？", previous("那还需要等吗？", independent.requestId));
      assert.equal(unresolved.host?.pendingReferenceKind, "policy"); assert.equal(unresolved.host?.policyTopic, null);
      assert.equal(unresolved.result?.outcome, "clarification"); assert.equal(h.queries.length, before);
      assert.equal(unresolved.result?.evidence.policyChoices?.candidates.length, 3); assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // Keep the two-order shortcut, then require an exact selection among three.
  {
    const h = await harness("orders");
    try {
      const first = await h.queryOrder(a); await h.queryOrder(b);
      const alternative = await h.run("另一笔的退款条件是什么？", { protocol: "v2.2", kind: "refund_eligibility", question: "另一笔的退款条件是什么？",
        questionContext: { kind: "standalone" }, orderRef: { kind: "alternative" } });
      assertReady(alternative); assert.equal(alternative.host?.alternativeOrderId, a); assert.equal(h.reads.at(-1)?.id, a);
      const third = await h.queryOrder(c), before = h.reads.length;
      const disputed = await h.run("另一笔的退款条件呢？", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      assert.equal(disputed.result?.outcome, "clarification"); assert.equal(h.reads.length, before);
      assert.equal(disputed.result?.evidence.orderReferenceChoices?.candidates.length, 3);
      assert.match(replyText(disputed), new RegExp(a)); assert.match(replyText(disputed), new RegExp(b)); assert.match(replyText(disputed), new RegExp(c));
      // A was freshly reread by the alternative action, so its old first token is not the current candidate.
      assert.notEqual(first.requestId, alternative.requestId);
      const selected = await h.select(commandFor(disputed, "order", alternative.requestId));
      assert.equal(selected.receipt?.outcome, "selected");
      assert.ok(selected.receipt?.version === "reference-selection-v1"); assert.equal(selected.receipt.presentationRequestId, disputed.requestId);
      assert.equal(h.focusWrites.at(-1), c, "host selection leaves the last verified focus intact until a fresh read");
      const refreshed = await h.run("现在是什么状态？", { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } });
      assert.equal(refreshed.host?.orderId, a); assert.equal(refreshed.result?.outcome, "ready"); assert.equal(refreshed.result?.evidence.order?.id, a);
      assert.deepEqual(h.reads.at(-1), { identity, id: a }); assert.equal(h.focusWrites.at(-1), a);
      assert.ok(third.result?.verifiedOrderId === c); assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // Invalid selection in another category cannot replace the unresolved dispute.
  {
    const h = await harness("cross-kind-order");
    try {
      await h.queryOrder(a); await h.queryOrder(b); await h.queryOrder(c);
      await h.run("另一笔是哪笔？", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      assert.equal((await h.select(`选择话题 ${randomUUID()}`)).receipt?.outcome, "rejected");
      const before = h.reads.length;
      const stillPending = await h.run("那现在是什么状态？", { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } });
      assert.equal(stillPending.host?.pendingReferenceKind, "order", "a rejected policy command cannot overwrite an unresolved order choice");
      assert.equal(stillPending.result?.outcome, "clarification"); assert.equal(h.reads.length, before);
      assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }
  {
    const h = await harness("cross-kind-policy");
    try {
      const first = await h.run("微信退款到账需要多久？", standalone("微信退款到账需要多久？"));
      await h.run("银行卡退款到账需要多久？", standalone("银行卡退款到账需要多久？"));
      await h.run("这个时间算上周末吗？", previous("这个时间算上周末吗？", first.requestId));
      assert.equal((await h.select(`选择订单 ${randomUUID()}`)).receipt?.outcome, "rejected");
      const before = h.queries.length;
      const stillPending = await h.run("那节假日呢？", previous("那节假日呢？", first.requestId));
      assert.equal(stillPending.host?.pendingReferenceKind, "policy", "a rejected order command cannot overwrite an unresolved policy choice");
      assert.equal(stillPending.result?.outcome, "clarification"); assert.equal(h.queries.length, before);
      assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // An explicit message cancels a different selected locator even without a read.
  {
    const h = await harness("explicit-locator");
    try {
      await h.queryOrder(a); const second = await h.queryOrder(b); await h.queryOrder(a);
      const display = await h.run("先列出订单让我选", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const selection = await h.select(commandFor(display, "order", second.requestId));
      assert.ok(selection.receipt?.version === "reference-selection-v1"); assert.equal(selection.receipt.selectedOrderId, b);
      assert.equal(h.focusWrites.at(-1), a);
      const before = h.reads.length;
      const explicitClarification = await h.run(`${a} 的事项还需要补充什么？`, { protocol: "v2.2", kind: "clarify", field: "intent", reason: "missing" });
      assert.equal(explicitClarification.result?.outcome, "clarification"); assert.equal(h.reads.length, before);
      const next = await h.run("现在是什么状态？", { protocol: "v2.2", kind: "order", orderRef: { kind: "focus" } });
      assert.equal(next.host?.orderId, a, "the next omission must not revive B after an explicit A message");
      assert.equal(next.result?.evidence.order?.id, a); assert.deepEqual(h.reads.at(-1), { identity, id: a });
      assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // Host-only rejection paths use actual tokens exposed in host context and replies.
  {
    const h = await harness("rejection");
    try {
      await h.run("微信退款到账时限是什么？", standalone("微信退款到账时限是什么？"));
      const second = await h.run("银行卡退款到账时限是什么？", standalone("银行卡退款到账时限是什么？"));
      const hiddenToken = second.host!.policyChoices!.candidates[0]!.token;
      const unshown = await h.select(`选择话题 ${hiddenToken}`);
      assert.equal(unshown.receipt?.outcome, "rejected", "host context exposure is not a user-visible presentation");
      const offered = replyText(unshown).split("\n").find(line => /^选择话题 [a-f0-9-]{36}$/.test(line)); assert.ok(offered);
      for (const bad of ["选择话题 " + randomUUID(), offered + "\n并且确认退款", offered + " 额外文字"]) {
        assert.equal((await h.select(bad)).receipt?.outcome, "rejected");
      }
      assert.equal((await h.select(offered, [{ type: "image", mimeType: "image/png", data: "AA==" }])).receipt?.outcome, "rejected");
      for (const [suffix, who, group] of [
        ["new-session", identity, groupOpenid], ["other-user", { ...identity, senderId: "OTHER" }, groupOpenid], ["other-group", identity, "OTHER_GROUP"],
      ] as const) {
        const other = await harness(suffix, who, group);
        try { assert.equal((await other.select(offered)).receipt?.outcome, "rejected"); assertNoBusinessWrite(other); }
        finally { other.session.dispose(); }
      }
      assert.equal((await h.select(offered)).receipt?.outcome, "selected");
      await h.run("模拟失败", undefined, { failure: true });
      assert.equal((await h.select(offered)).receipt?.outcome, "rejected");
      const before = h.queries.length;
      const missing = await h.run("那个规则仍然适用吗？", previous("那个规则仍然适用吗？", second.requestId));
      assert.equal(missing.result?.outcome, "clarification"); assert.equal(missing.host?.policyTopic, null); assert.equal(h.queries.length, before);
      assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }

  // Failed authorization and explicit cancellation invalidate historical choices.
  {
    const h = await harness("failure");
    try {
      const first = await h.queryOrder(a); await h.queryOrder(b);
      const display = await h.run("要查另一笔", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const command = commandFor(display, "order", first.requestId);
      h.failReads(true); await h.queryOrder(a); h.failReads(false);
      assert.equal((await h.select(command)).receipt?.outcome, "rejected");
      await h.queryOrder(a);
      const shownAgain = await h.run("请列出订单对象", { protocol: "v2.2", kind: "clarify", field: "order", reason: "ambiguous" });
      const commandAgain = replyText(shownAgain).split("\n").find(line => /^选择订单 [a-f0-9-]{36}$/.test(line)); assert.ok(commandAgain);
      cancelSupportTurn(h.session); assert.equal((await h.select(commandAgain)).receipt?.outcome, "rejected");
      assertNoBusinessWrite(h);
    } finally { h.session.dispose(); }
  }
  // A restored, explicit amount selection is independent of an unavailable order
  // focus. Only the user's same-order request may retain that selected source.
  {
    const partialOrder = (id: string) => {
      const order = makeOrder(id); order.status = "partially_redeemed";
      order.amounts.totalCents = order.amounts.paidCents = 15960;
      order.items[0]!.quantity = 2; order.items[0]!.totalCents = 15960; order.payments[0]!.amountCents = 15960;
      order.coupons.push({ ...order.coupons[0]!, id: `${id}-used`, status: "redeemed", redeemedAt: order.asOf, redeemedShopId: order.shop.id });
      return order;
    };
    const memoryPort = (initial: SupportContextSnapshot = { revision: 0, customerId: "synthetic", bindingId: "1" }) => {
      let saved = structuredClone(initial);
      return { async read() { return structuredClone(saved); }, async write(expected, value) {
        assert.equal(expected.revision, saved.revision); assert.equal(expected.bindingId, saved.bindingId);
        saved = { ...saved, revision: saved.revision + 1, value: structuredClone(value) }; return structuredClone(saved);
      } } satisfies SupportContextPort;
    };
    const port = memoryPort(), first = await harness("amount-source", identity, groupOpenid, port, partialOrder);
    let sourceId: string, command: string, saved: SupportContextSnapshot, unselected: SupportContextSnapshot;
    try {
      const source = await first.queryOrder(a); sourceId = source.requestId; await first.queryOrder(b);
      const shown = await first.run("请列出历史实付基准让我选择", { protocol: "v2.2", kind: "clarify", field: "amount_basis", reason: "ambiguous" });
      const candidate = shown.result?.evidence.amountChoices?.candidates.find(row => row.reference.requestId === sourceId);
      assert.ok(candidate); command = `选择金额基准 ${candidate.token}`;
      assert.ok(replyText(shown).split("\n").includes(command));
      unselected = await port.read();
      assert.equal((await first.select(command)).receipt?.selectedRequestId, sourceId);
      saved = await port.read(); assert.equal(saved.value?.requiresRestatement, true);
      assert.ok(saved.value?.version === 3 && saved.value.amountChoices?.selectedRequestId === sourceId);
      assertNoBusinessWrite(first);
    } finally { first.session.dispose(); }
    const restored = await harness("amount-restored", identity, groupOpenid, memoryPort(saved), partialOrder);
    try {
      const comparison = await restored.run(`比较 ${a} 唯一未使用券的实付和刚才选中的基准`, host => {
        assert.ok(host.itemPaidUnit, "The actual host must retain the user's selected same-order amount source");
        return { protocol: "v2.2", kind: "paid_amount_compare", orderRef: explicit(a), amountRef: { requestId: host.itemPaidUnit.requestId } };
      });
      assert.equal(comparison.host?.orderId, null, "Restatement-required order focus must remain unavailable");
      assert.equal(comparison.result?.outcome, "ready", "An actual same-order selected amount remains usable after focus loss");
      assert.equal(comparison.host?.itemPaidUnit?.requestId, sourceId);
      assert.equal(comparison.result?.evidence.amountComparison?.referenceRequestId, sourceId);
      assert.equal(comparison.result?.evidence.amountComparison?.refundApproved, false);
      assert.deepEqual(restored.reads, [{ identity, id: a }]); assertNoBusinessWrite(restored);
    } finally { restored.session.dispose(); }
    const originalNow = Date.now;
    for (const scenario of ["other-order", "unselected", "expired", "other-route"] as const) {
      let next: Awaited<ReturnType<typeof harness>> | undefined;
      try {
        if (scenario === "expired") {
          assert.ok(saved.value?.version === 3 && saved.value.amountChoices);
          const expiredAt = Math.max(...saved.value.amountChoices.candidates.map(row => row.expiresAt)) + 1;
          Date.now = () => expiredAt;
        }
        next = await harness(`amount-${scenario}`, identity, scenario === "other-route" ? "OTHER_GROUP" : groupOpenid,
          scenario === "other-route" ? memoryPort() : memoryPort(scenario === "unselected" ? unselected : saved), partialOrder);
        if (scenario === "other-route") assert.equal((await next.select(command)).receipt?.outcome, "rejected");
        const target = scenario === "other-order" ? b : a;
        const comparison = await next.run(`比较 ${target} 的实付和之前基准`, { protocol: "v2.2", kind: "paid_amount_compare",
          orderRef: explicit(target), amountRef: { requestId: sourceId } });
        assert.equal(comparison.host?.itemPaidUnit, null); assert.equal(comparison.result?.outcome, "clarification");
        assert.equal(comparison.result?.evidence.amountComparison, undefined);
        assert.equal(next.reads.length, 0); assertNoBusinessWrite(next);
      } finally { next?.session.dispose(); Date.now = originalNow; }
    }
  }
  console.log("[support-reference-session] actual Pi/faux continuation, presentation-bound selection, pending preservation, fresh-order recovery and rejection paths PASS (0 API, 0 DB)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportReferenceSession();
