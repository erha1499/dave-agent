import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { OrderAccessError, type CouponStore, type QQIdentity } from "./coupon-store.ts";
import type { Reply } from "./reply.ts";

type OrderReply = Extract<Reply, { kind: "order" }>;
type DiscoveryStore = Pick<CouponStore, "getOrder" | "listOrders">;
type Pending = { text: string; orderIds: string[]; expiresAt: number };
const sessions = new WeakMap<AgentSession, ReturnType<typeof createOrderDiscovery>>();
const selection = /^选择订单[ \t]+(COUPON-\d{4})$/u;
const listQuestion = /^(?:请|麻烦)?(?:帮我|给我)?(?:查(?:询|一下)?|看(?:看|一下)?|列出|显示)?(?:一下)?(?:我(?:的)?|本人)(?:最近(?:的)?|所有(?:的)?|有哪些)?订单(?:有哪些|列表)?[。！？?]?$/u;
const refundRequest = /^(?:请|麻烦)?(?:帮我|给我|我想|我要|我想要|我需要|申请)?(?:申请)?退(?:款|钱)(?:一下)?[。！？?]?$/u;
const normalize = (text: string) => text.replace(/^[ \t]+|[ \t]+$/gu, "");

export function recentOrderReply(list: Awaited<ReturnType<CouponStore["listOrders"]>>, text: string): OrderReply {
  return { kind: "order", text: list.orders.length
    ? `${refundRequest.test(normalize(text)) ? "请先选择要退款的订单，我会继续核对订单及适用规则。" : "这是你的最近订单，请选择一笔继续查询。"}\n选择订单只用于定位，不会提交退款。`
    : "当前客户没有订单记录。", evidenceIds: [], hasMore: list.hasMore,
    orders: list.orders.map(order => ({ ...order, selectionText: `选择订单 ${order.id}` })) };
}

export function createOrderDiscovery(store: DiscoveryStore, identity: QQIdentity) {
  const trustedIdentity = { ...identity };
  let pending: Pending | undefined;
  let prepared: { reply: Reply; pending: Pending } | undefined;
  let focus: string | undefined;
  return {
    async prepare(text: string): Promise<{ prompt: string; reply?: Reply }> {
      prepared = undefined;
      const value = normalize(text);
      const chosen = selection.exec(value);
      const bare = pending && /^(?:订单号(?:是)?[：:]?[ \t]*)?(COUPON-\d{4})$/u.exec(value);
      if (chosen || bare) {
        const current = pending;
        pending = undefined;
        const orderId = (chosen ?? bare)![1]!;
        if (!current || current.expiresAt <= Date.now() || !current.orderIds.includes(orderId)) {
          focus = undefined;
          return { prompt: text, reply: { kind: "notice", text: "该订单选择已失效，请重新查询最近订单，或直接写明订单号和要处理的事项。" } };
        }
        try { await store.getOrder(trustedIdentity, orderId); }
        catch (error) {
          focus = undefined;
          if (!(error instanceof OrderAccessError)) throw error;
          return { prompt: text, reply: { kind: "notice", text: error.message } };
        }
        focus = orderId;
        return { prompt: listQuestion.test(normalize(current.text))
          ? `查询订单 ${orderId} 的详细信息`
          : `${current.text}\n订单：${orderId}` };
      }
      // A new request retires old cards, so a later click cannot revive an old refund request.
      pending = undefined;
      if (listQuestion.test(value) || refundRequest.test(value) && !focus) {
        focus = undefined;
        const list = await store.listOrders(trustedIdentity);
        const reply = recentOrderReply(list, text);
        prepared = { reply, pending: { text, orderIds: list.orders.map(order => order.id), expiresAt: Date.now() + 15 * 60_000 } };
        return { prompt: text, reply };
      }
      if (refundRequest.test(value) && focus) return { prompt: `${text}\n订单：${focus}` };
      if (/COUPON-\d{4}/u.test(text)) focus = undefined;
      return { prompt: text };
    },
    present(reply: Reply, text?: string) {
      if (prepared?.reply === reply) {
        pending = prepared.pending;
        prepared = undefined;
      } else {
        pending = undefined;
        prepared = undefined;
        if (reply.kind === "order") {
          const selectable = reply.orders.filter(order => order.selectionText === `选择订单 ${order.id}`);
          if (selectable.length && text) {
            focus = undefined;
            pending = { text, orderIds: selectable.map(order => order.id), expiresAt: Date.now() + 15 * 60_000 };
          } else focus = reply.orders.length === 1 ? reply.orders[0]!.id : undefined;
        } else if (text && /COUPON-\d{4}/u.test(text)) focus = undefined;
      }
    },
  };
}

export function registerOrderDiscovery(session: AgentSession, store: DiscoveryStore, identity: QQIdentity) {
  // A host with only an order-detail port keeps its existing prompt path.
  if (typeof store.listOrders === "function") sessions.set(session, createOrderDiscovery(store, identity));
}
export function prepareOrderDiscoveryPrompt(session: AgentSession, text: string) {
  return sessions.get(session)?.prepare(text) ?? Promise.resolve({ prompt: text });
}
export function presentOrderDiscoveryReply(session: AgentSession, reply: Reply, text?: string) { sessions.get(session)?.present(reply, text); }
