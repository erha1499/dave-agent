import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import type { CouponStore, QQIdentity } from "../src/coupon-store.ts";
import { replyFromTools, type Evidence } from "../src/reply-from-tools.ts";
import { WebChatSessions, type WebChatProgress } from "../src/web-chat.ts";
import { createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";

// Regression for the 2026-10-11 Web batch B1: a read-only channel offered a merchant negotiation.
const webTools = ["get_order", "list_orders", "search_faq"];
const b1Offer = "如需我帮您发起模拟商家协商，请告诉我具体原因，我再为您准备。";
const b1Text = "您的订单 COUPON-1001 实付 79.80 元，已支付，券未核销。法定节假日能否使用目前无法确认，建议您联系商家确认。" + b1Offer;
const honestTexts = [
  "按《合成退款规则》说明，这张券可以申请退款，上限 79.80 元，这不等于批准或已退款。本次未提交申请、未联系商家，没有资金变动。",
  "法定节假日能否使用目前无法确认，建议您联系商家核实。",
  "我无法帮您发起商家协商，也不能代为申请退款；可以自行联系商家。",
  "已为您整理了以下退款规则说明，供您参考。",
];
const offerTexts = [b1Text, "需要的话我可以帮您申请退款。", "我来为您联系商家核实节假日安排。", "我已为您提交退款申请。"];

const tool = (toolName: string, value: unknown): Evidence => ({ toolName, isError: false, content: [{ type: "text", text: JSON.stringify(value) }] });
const order = { source: "demo-database", id: "COUPON-1001", status: "paid", amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 },
  shop: { id: "shop-1", name: "合成门店" }, items: [{ productId: "product-1", productName: "合成套餐" }], coupons: [{ status: "unused" }], payments: [], refunds: [] };
const rule = { source: "demo-knowledge", sourceId: "KB-OFFER-CHECK", title: "合成退款规则", body: "未核销且未过期的券可以申请退款。", scope: { shopId: "shop-1", productId: "product-1" } };
const evidence = [tool("get_order", order), tool("search_faq", [rule])];
const context = { previousOrderIds: [], requestedOrderIds: ["COUPON-1001"], allowOrderList: false };

function checkFinalReply() {
  for (const text of offerTexts) {
    const reply = replyFromTools(text, evidence, webTools, context);
    assert.equal(reply.kind, "order");
    assert.notEqual(reply.text, text, `read-only reply must not release an unavailable offer: ${text}`);
    assert.match(reply.text, /当前渠道只能查询订单和规则/); assert.match(reply.text, /本次未办理退款、核销、延期、预约或联系商家/);
    assert.doesNotMatch(reply.text, /其他订单的历史记录/, "a single-order offer fallback does not talk about switched orders");
    assert.match(reply.text, /合成退款规则\n未核销且未过期的券可以申请退款。/);
  }
  for (const text of honestTexts) {
    const reply = replyFromTools(text, evidence, webTools, context);
    assert.ok(reply.kind === "order" && reply.text === text, `honest statements stay: ${text}`);
  }
}

async function checkWebStream() {
  const runtime = await createModelRuntime();
  const faux = fauxProvider({ models: [{ id: "offer-faux" }], tokensPerSecond: 8000, tokenSize: { min: 1, max: 2 } });
  runtime.registerNativeProvider(faux.provider);
  const store = {
    async resolveBinding(identity: QQIdentity) { return { bindingId: `binding-${identity.senderId}`, customerId: `customer-${identity.senderId}` }; },
    async listOrders() { return { source: "demo-database", asOf: new Date().toISOString(), orders: [], hasMore: false }; },
    async getOrder(_identity: QQIdentity, orderId: string) { return { ...structuredClone(order), id: orderId, asOf: new Date().toISOString() }; },
    async searchKnowledge() { return [structuredClone(rule)]; },
  } as unknown as CouponStore;
  const chat = new WebChatSessions(store, identity => createCouponSession(identity, store, runtime, faux.getModel()), 2000,
    createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic-offer-key" }));
  try {
    for (const [finalText, offered] of [[b1Text, true], [honestTexts[0]!, false]] as const) {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("get_order", { orderId: "COUPON-1001" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("search_faq", { query: "节假日使用", shopId: "shop-1", productId: "product-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(finalText),
      ]);
      const { token, session } = await chat.create(undefined, "demo-a");
      const events: WebChatProgress[] = [];
      const result = await chat.send(token, randomUUID(), "COUPON-1001 节假日能用吗", session.id, event => events.push(event));
      const streamed = events.flatMap(event => event.type === "delta" ? [event.text] : []).join("");
      if (offered) {
        assert.doesNotMatch(streamed, /协商|为您准备/, "the offer clause never reaches SSE");
        assert.ok(finalText.startsWith(streamed), "only verified leading clauses stream");
        assert.match(result.reply.text, /当前渠道只能查询订单和规则/); assert.doesNotMatch(result.reply.text, /协商，请告诉我/);
      } else {
        assert.equal(streamed, finalText, "honest prose still streams in full"); assert.equal(result.reply.text, finalText);
      }
    }
  } finally { chat.close(); }
}

export async function checkChannelOffer() {
  checkFinalReply();
  await checkWebStream();
  // Capability is read from the session's actual tools, not from the channel name.
  const { offersUnavailableAction } = await import("../src/channel-offer.ts");
  assert.equal(offersUnavailableAction(b1Offer, webTools), true);
  assert.equal(offersUnavailableAction(b1Offer, [...webTools, "prepare_merchant_request"]), false);
  assert.equal(offersUnavailableAction("我可以帮您申请退款。", [...webTools, "prepare_merchant_request"]), true);
  assert.equal(offersUnavailableAction("我可以帮您申请退款。", [...webTools, "prepare_merchant_request", "prepare_refund"]), false);
  for (const text of honestTexts) assert.equal(offersUnavailableAction(text, webTools), false, text);
  console.log("渠道能力邀约检查通过：只读渠道的协商/退款邀约退回模板且不进 SSE，如实说明与否定句不误伤。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkChannelOffer();
