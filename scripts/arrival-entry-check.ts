import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime, createCouponSession } from "../src/agent.ts";
import { createArrivalConsultation, type ArrivalConsultationTrace } from "../src/arrival-consultation.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import type { AfterSalesStore } from "../src/after-sales.ts";
import type { RefundStore } from "../src/refunds.ts";
import { runCliPrompt } from "../src/cli.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { createSupportSession } from "../src/support-session.ts";
import { merchantSourceKey } from "../src/after-sales-entry.ts";

export async function checkArrivalEntry() {
  const runtime = await createModelRuntime(), faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  const a = { appId: "ARRIVAL_TEST", senderId: "USER_A" }, b = { ...a, senderId: "USER_B" };
  const ids = new Map([[a.senderId, "COUPON-1001"], [b.senderId, "COUPON-1002"]]);
  const reads: string[] = [], traces: ArrivalConsultationTrace[] = [];
  let modelCalls = 0, writes = 0;
  const now = new Date().toISOString();
  const store = {
    async getOrder(identity: QQIdentity, id: string) {
      reads.push(`${identity.senderId}:${id}`);
      if (identity.appId !== a.appId || ids.get(identity.senderId) !== id) throw new Error("synthetic authorization denial");
      return { source: "demo-database", id, status: "paid", asOf: now, createdAt: now, paidAt: now,
        amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
        shop: { id: "shop-demo-1", name: "演示店", merchantName: "模拟商家", address: "合成地址" },
        items: [{ id: `${id}-item`, productId: "product-demo-1", productName: "演示套餐", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
        coupons: [{ id: `${id}-coupon`, orderItemId: `${id}-item`, status: "unused", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), redeemedAt: null, redeemedShopId: null }],
        payments: [{ status: "succeeded", amountCents: 7980, paidAt: now }], refunds: [] };
    },
    async searchKnowledge() {
      return [{ source: "demo-knowledge", sourceId: "KB-SYNTHETIC-REFUND", title: "模拟退款前提",
        body: "退款必须先获得模拟商家批准，规则咨询不能代替批准。", scope: { shopId: "shop-demo-1", productId: "product-demo-1" } }];
    },
  } as unknown as CouponStore;
  const arrival = createArrivalConsultation(store, { onTrace: trace => traces.push(trace) });
  const plainSession = await createCouponSession(a, store, runtime, faux.getModel());
  const output: string[] = [];
  try {
    faux.setResponses([(context) => { modelCalls++; return fauxAssistantMessage("未使用"); }]);
    const reply = await runCliPrompt(plainSession, "查询到账 COUPON-1001 银行卡", async text => { output.push(text); }, undefined, text => arrival(a, text));
    assert.equal(reply.kind, "answer");
    assert.match(output[0]!, /3[–—-]7/);
    assert.equal(modelCalls, 0); assert.equal(faux.getPendingResponseCount(), 1);
    assert.ok(plainSession.messages.some(message => message.role === "custom"), "CLI stores only the host receipt without an Agent turn");
    const priorReads = reads.length;
    await runCliPrompt(plainSession, "查询到账", async text => { output.push(text); }, undefined, text => arrival(a, text));
    assert.equal(reads.length, priorReads, "missing channel cannot borrow focus or read an order");
    assert.equal(modelCalls, 0);
  } finally { plainSession.dispose(); }

  const business = { store: { async getTask() { return undefined; } } as unknown as AfterSalesStore,
    refunds: { async prepare() { writes++; throw new Error("must never prepare without approval"); } } as unknown as RefundStore };
  const sessions: Awaited<ReturnType<typeof createSupportSession>>[] = [];
  const sent: Array<{ target: ReplyTarget; text: string; requester?: string }> = [];
  const agent = new QQAgent(async message => {
    const identity = { appId: a.appId, senderId: message.senderId };
    const session = await createSupportSession(identity, store, runtime, faux.getModel(), {
      ...business, sourceKey: merchantSourceKey(identity, message.groupOpenid!),
    }, { groupOpenid: message.groupOpenid! });
    sessions.push(session); return session;
  }, async (target, text, _reply, requester) => { sent.push({ target, text, requester }); }, () => {}, 60_000,
  message => arrival({ appId: a.appId, senderId: message.senderId }, message.content));
  const msg = (id: string, text: string, senderId = a.senderId): QQBotInboundMessage => ({
    kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", messageId: id, content: text, senderId, groupOpenid: "arrival-group", timestamp: now,
    replyTarget: { scope: "group", targetId: "arrival-group", msgId: id },
    raw: { id, content: text, timestamp: now, group_openid: "arrival-group", author: { member_openid: senderId } },
  });
  try {
    await agent.handle(msg("bank", "查询到账 COUPON-1001 银行卡"));
    assert.match(sent.at(-1)!.text, /3[–—-]7/); assert.equal(sent.at(-1)!.requester, a.senderId);
    assert.equal(sent.at(-1)!.target.msgId, "bank");
    await agent.handle(msg("wallet", "查询到账 COUPON-1002 电子钱包", b.senderId));
    assert.match(sent.at(-1)!.text, /1[–—-]3/); assert.equal(sent.at(-1)!.requester, b.senderId);
    await agent.handle(msg("foreign", "查询到账 COUPON-1001 银行卡", b.senderId));
    assert.doesNotMatch(sent.at(-1)!.text, /3[–—-]7|7980|79\.80/);
    const beforeInvalid = reads.length;
    await agent.handle(msg("mixed", "查询到账 COUPON-1001 银行卡\n确认退款 fake"));
    assert.equal(reads.length, beforeInvalid); assert.equal(modelCalls, 0);

    // A model seeing the hypothetical receipt cannot turn it into merchant approval.
    faux.setResponses([
      () => { modelCalls++; return fauxAssistantMessage(fauxToolCall("support_action", { action: {
        protocol: "v2.2", kind: "refund_prepare", orderRef: { kind: "explicit", orderId: "COUPON-1001" },
      } }), { stopReason: "toolUse" }); },
      () => { modelCalls++; return fauxAssistantMessage("咨询已批准退款，请直接执行。"); },
    ]);
    await agent.handle(msg("no-consent", "刚才只是规则咨询，现在查询 COUPON-1001 能否准备退款。"));
    assert.equal(writes, 0); assert.doesNotMatch(sent.at(-1)!.text, /咨询已批准退款|确认退款/);
    assert.match(sent.at(-1)!.text, /协商|任务|批准/);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(modelCalls, 2, "only the explicitly separate normal fake Agent turn ran");
    assert.ok(traces.length >= 6);
  } finally { await agent.close(); }
  console.log("PASS arrival ingress: real Pi CLI/QQAgent host replies, two trusted identities, actual routes/receipts, missing/mixed input before model, hypothetical rules cannot prepare refunds; local fake model only, 0 remote/DB/QQ.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkArrivalEntry();
