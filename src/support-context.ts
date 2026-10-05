import { createHash } from "node:crypto";
import type { CouponStore } from "./coupon-store.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Binding = { sourceKey: string; groupOpenid: string };
export type TrustedOrderChoices = Binding & { orders: Array<{ orderId: string; requestId: string }>; overflow: boolean };
export type TrustedAmountReference = Binding & {
  requestId: string; orderId: string; itemId: string; productId: string;
  field: "item_paid_unit"; paidCents: number; orderVersion: string;
};
export type RemainingAmountComparison = {
  orderId: string; couponId: string; itemId: string; productId: string; asOf: string;
  remainingCouponCount: 1; remainingUnitPaidCents: number; referencePaidCents: number; comparisonEqual: boolean;
  referenceRequestId: string; currentOrderVersion: string; referenceOrderVersion: string; refundApproved: false;
};
export const orderVersion = (order: Order) => createHash("sha256").update(JSON.stringify(order)).digest("hex");
const bound = (value: Binding | undefined, binding: Binding) => value?.sourceKey === binding.sourceKey && value.groupOpenid === binding.groupOpenid;
export function rememberOrderChoice(previous: TrustedOrderChoices | undefined, binding: Binding, orderId: string, requestId: string): TrustedOrderChoices {
  const before = bound(previous, binding) ? previous!.orders : [];
  const orders = [...before.filter(row => row.orderId !== orderId), { orderId, requestId }];
  return { ...binding, orders: orders.slice(-3), overflow: Boolean(bound(previous, binding) && previous!.overflow) || orders.length > 3 };
}
export function selectAlternativeOrder(choices: TrustedOrderChoices | undefined, binding: Binding, focusOrderId?: string): string | undefined {
  if (!bound(choices, binding) || choices!.overflow || !focusOrderId || choices!.orders.length !== 2
    || new Set(choices!.orders.map(row => row.orderId)).size !== 2
    || choices!.orders.some(row => !row.requestId || !/^COUPON-\d{4}$/.test(row.orderId))
    || !choices!.orders.some(row => row.orderId === focusOrderId)) return undefined;
  return choices!.orders.find(row => row.orderId !== focusOrderId)!.orderId;
}
export function supportObjectReference(text: string): "remaining_amount" | "alternative_order" | "ambiguous" | null {
  const normalized = text.normalize("NFKC");
  // Independent semantic features allow either word order and intervening punctuation.
  // They only select a read-only resolver; fresh coupon cardinality and a bound paid reference decide facts.
  const unusedObject = /(?:剩下|剩余|余下|未(?:用|使用|核销|消费)|没(?:有)?(?:用|使用|核销|消费))/u.test(normalized);
  const amount = /(?:实付|实际支付|实际付款|金额|单价|价钱|价格|钱)/u.test(normalized);
  const comparison = /(?:一样|相同|相等|等于|一致|对得上|比较|对比|比对|也(?:还)?是)/u.test(normalized);
  const alternative = /(?:另(?:一|外)|其他)[^，。？！\n]{0,3}(?:张|笔|订单|券)/u.test(normalized);
  if (unusedObject && amount && comparison) return alternative ? "ambiguous" : "remaining_amount";
  if (!/COUPON-\d{4}(?!\d)/u.test(normalized) && alternative) return "alternative_order";
  return null;
}

// The schema has line prices but no discount allocation. Only exact, fully paid
// no-discount arithmetic establishes a per-coupon paid amount; never prorate a discount.
export function paidUnits(order: Order) {
  const money = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (!money(order.amounts.totalCents) || order.amounts.totalCents <= 0 || order.amounts.paidCents !== order.amounts.totalCents
    || order.items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !money(item.unitPriceCents)
      || item.unitPriceCents <= 0 || item.totalCents !== item.quantity * item.unitPriceCents
      || order.coupons.filter(coupon => coupon.orderItemId === item.id).length !== item.quantity)
    || order.items.reduce((sum, item) => sum + item.totalCents, 0) !== order.amounts.totalCents
    || order.payments.filter(payment => payment.status === "succeeded").reduce((sum, payment) => sum + payment.amountCents, 0) !== order.amounts.paidCents) return [];
  return order.items.map(item => ({ itemId: item.id, productId: item.productId, paidCents: item.unitPriceCents }));
}
export function createAmountReference(order: Order, binding: Binding, requestId: string): TrustedAmountReference | undefined {
  const units = paidUnits(order);
  if (units.length !== 1) return undefined;
  return { ...binding, requestId, orderId: order.id, ...units[0]!, field: "item_paid_unit", orderVersion: orderVersion(order) };
}
export function compareRemainingAmount(order: Order, reference: TrustedAmountReference | undefined, binding: Binding): RemainingAmountComparison | undefined {
  if (!bound(reference, binding) || reference!.orderId !== order.id || reference!.field !== "item_paid_unit"
    || !reference!.requestId || !Number.isSafeInteger(reference!.paidCents) || reference!.paidCents <= 0
    || !/^[a-f0-9]{64}$/.test(reference!.orderVersion) || order.amounts.refundedCents !== 0
    || !order.coupons.some(coupon => coupon.status === "redeemed")) return undefined;
  const remaining = order.coupons.filter(coupon => coupon.status === "unused");
  if (remaining.length !== 1 || !remaining[0]!.expiresAt || !Number.isFinite(Date.parse(order.asOf))
    || Date.parse(remaining[0]!.expiresAt) <= Date.parse(order.asOf) || !Number.isFinite(Date.parse(remaining[0]!.expiresAt))) return undefined;
  const unit = paidUnits(order).find(item => item.itemId === remaining[0]!.orderItemId);
  if (!unit || unit.itemId !== reference!.itemId || unit.productId !== reference!.productId) return undefined;
  return { orderId: order.id, couponId: remaining[0]!.id, itemId: unit.itemId, productId: unit.productId, asOf: order.asOf,
    remainingCouponCount: 1, remainingUnitPaidCents: unit.paidCents, referencePaidCents: reference!.paidCents,
    comparisonEqual: unit.paidCents === reference!.paidCents, referenceRequestId: reference!.requestId,
    currentOrderVersion: orderVersion(order), referenceOrderVersion: reference!.orderVersion, refundApproved: false };
}
