import { createHash, randomUUID } from "node:crypto";
import type { CouponStore } from "./coupon-store.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Binding = { sourceKey: string; groupOpenid: string };
export type TrustedOrderChoices = Binding & { orders: Array<{ orderId: string; requestId: string }>; overflow: boolean };
export type TrustedAmountReference = Binding & {
  requestId: string; orderId: string; itemId: string; productId: string;
  field: "item_paid_unit"; paidCents: number; orderVersion: string;
};
export const amountChoicesVersion = "amount-choices-v1" as const;
export const amountChoiceTtlMs = 15 * 60_000;
export type TrustedAmountChoices = Binding & {
  version: typeof amountChoicesVersion;
  candidates: Array<{ token: string; version: string; expiresAt: number; reference: TrustedAmountReference }>;
  overflow: boolean;
  // Expiry must not silently choose the survivor of an earlier ambiguous list.
  selectionRequired: boolean;
  selectedToken?: string;
};
export type RemainingAmountComparison = {
  orderId: string; couponId: string; itemId: string; productId: string; asOf: string;
  remainingCouponCount: 1; remainingUnitPaidCents: number; referencePaidCents: number; comparisonEqual: boolean;
  referenceRequestId: string; currentOrderVersion: string; referenceOrderVersion: string; refundApproved: false;
};
export const orderVersion = (order: Order) => createHash("sha256").update(JSON.stringify(order)).digest("hex");
const bound = (value: Binding | undefined, binding: Binding) => value?.sourceKey === binding.sourceKey && value.groupOpenid === binding.groupOpenid;
const amountVersion = (reference: TrustedAmountReference) => createHash("sha256").update(JSON.stringify(reference)).digest("hex");
const amountSource = (reference: TrustedAmountReference) => JSON.stringify([reference.orderId, reference.itemId, reference.productId]);
const validAmount = (reference: TrustedAmountReference, binding: Binding) => bound(reference, binding)
  && /^COUPON-\d{4}$/.test(reference.orderId) && Boolean(reference.requestId && reference.itemId && reference.productId)
  && reference.field === "item_paid_unit" && Number.isSafeInteger(reference.paidCents) && reference.paidCents > 0
  && /^[a-f0-9]{64}$/.test(reference.orderVersion);
export function currentAmountChoices(choices: TrustedAmountChoices | undefined, binding: Binding, now = Date.now()): TrustedAmountChoices | undefined {
  if (!bound(choices, binding) || choices!.version !== amountChoicesVersion || !Array.isArray(choices!.candidates)
    || choices!.candidates.length > 2 || typeof choices!.overflow !== "boolean" || typeof choices!.selectionRequired !== "boolean"
    || new Set(choices!.candidates.map(row => row.token)).size !== choices!.candidates.length
    || new Set(choices!.candidates.map(row => amountSource(row.reference))).size !== choices!.candidates.length
    || choices!.candidates.some(row => !/^[a-f0-9-]{36}$/.test(row.token) || !validAmount(row.reference, binding)
      || row.version !== amountVersion(row.reference) || !Number.isSafeInteger(row.expiresAt))) return undefined;
  const candidates = choices!.candidates.filter(row => row.expiresAt > now);
  if (!candidates.length) return undefined;
  const selectedToken = candidates.some(row => row.token === choices!.selectedToken) ? choices!.selectedToken : undefined;
  return { ...structuredClone(choices!), candidates: structuredClone(candidates), selectedToken,
    selectionRequired: choices!.selectionRequired || choices!.overflow || choices!.candidates.length > 1 };
}
export function rememberAmountChoice(previous: TrustedAmountChoices | undefined, binding: Binding,
  reference: TrustedAmountReference, now = Date.now()): TrustedAmountChoices | undefined {
  if (!validAmount(reference, binding)) return undefined;
  const before = currentAmountChoices(previous, binding, now);
  const candidates = [...(before?.candidates ?? []).filter(row => amountSource(row.reference) !== amountSource(reference)),
    { token: randomUUID(), version: amountVersion(reference), expiresAt: now + amountChoiceTtlMs, reference: structuredClone(reference) }];
  return { ...binding, version: amountChoicesVersion, candidates: candidates.slice(-2),
    overflow: Boolean(before?.overflow) || candidates.length > 2,
    selectionRequired: Boolean(before?.selectionRequired) || candidates.length > 1 };
}
export function selectAmountChoice(choices: TrustedAmountChoices | undefined, binding: Binding, token: string,
  now = Date.now()): TrustedAmountChoices | undefined {
  const current = currentAmountChoices(choices, binding, now);
  return current?.candidates.some(row => row.token === token) ? { ...current, selectedToken: token } : undefined;
}
export function resolveAmountReference(choices: TrustedAmountChoices | undefined, binding: Binding,
  now = Date.now()): TrustedAmountReference | undefined {
  const current = currentAmountChoices(choices, binding, now);
  const selected = current?.selectedToken ? current.candidates.find(row => row.token === current.selectedToken)
    : current && !current.selectionRequired && !current.overflow && current.candidates.length === 1 ? current.candidates[0] : undefined;
  return selected ? structuredClone(selected.reference) : undefined;
}
export function amountChoiceNotice(choices: TrustedAmountChoices | undefined, binding: Binding): string {
  const current = currentAmountChoices(choices, binding);
  if (!current) return "缺少仍有效的历史实付展示。请先查询要作基准的订单，取得每券实付展示；用户提供的数字不能代替支付记录。";
  return "请明确选择用于比较的历史实付基准，订单焦点或模型引用不能代替你的选择。\n"
    + current.candidates.map(row => `${row.reference.orderId} / 商品 ${row.reference.productId}：每券实付 ${(row.reference.paidCents / 100).toFixed(2)} 元。\n选择金额基准 ${row.token}`).join("\n")
    + (current.overflow ? "\n历史展示超过两个，这里只列最近两个来源；如需其他来源，请重新查询该订单。" : "")
    + "\n请单独发送一行选择指令。当前只支持同一订单的实付比较，选择其他订单不会执行跨订单比较；这不表示退款批准。";
}
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
