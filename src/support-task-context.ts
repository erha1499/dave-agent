import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { merchantReasonControls, type MerchantTaskReference } from "./after-sales.ts";
import type { ReferenceBinding } from "./support-reference-selection.ts";

export const taskReferenceTtlMs = 15 * 60_000;
export type TaskSelection = { taskId: string; orderId: string; requestId: string; selectedAt: number; expiresAt: number };
export type TaskContext = { selectionRequired: boolean; overflow: boolean; selected?: TaskSelection };
export type TrustedTaskChoices = ReferenceBinding & TaskContext & {
  candidates: Array<{ token: string; reference: MerchantTaskReference }>;
};
type TaskListing = { candidates: MerchantTaskReference[]; overflow: boolean };
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max = 512): v is string => typeof v === "string" && Boolean(v) && v.trim() === v && v.length <= max && !merchantReasonControls.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const order = (v: unknown): v is string => typeof v === "string" && /^COUPON-\d{4}$/.test(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 8_640_000_000_000_000;
const interval = (start: unknown, end: unknown, now: number) => time(start) && time(end) && start <= now && end > start && end - start <= taskReferenceTtlMs;
const clock = (now: number) => time(now) && Number.isSafeInteger(now + taskReferenceTtlMs);
const validSelection = (v: unknown, now: number): v is TaskSelection => record(v)
  && keys(v, ["taskId", "orderId", "requestId", "selectedAt", "expiresAt"]) && uuid(v.taskId) && order(v.orderId)
  && text(v.requestId) && interval(v.selectedAt, v.expiresAt, now);
const validReference = (v: unknown, now: number): v is MerchantTaskReference => record(v)
  && keys(v, ["taskId", "orderId", "origin", "anchorAt", "expiresAt"]) && uuid(v.taskId) && order(v.orderId)
  && (v.origin === "confirmed" || v.origin === "sent") && interval(v.anchorAt, v.expiresAt, now);

// This is a historical selection, not a cached task state or authorization.
export function validateTaskContext(value: unknown, now = Date.now()): TaskContext | undefined {
  if (!clock(now) || !record(value) || !keys(value, ["selectionRequired", "overflow", "selected"])
    || typeof value.selectionRequired !== "boolean" || typeof value.overflow !== "boolean"
    || value.selected !== undefined && !validSelection(value.selected, now)) return undefined;
  const selected = value.selected as TaskSelection | undefined;
  return { selectionRequired: value.selectionRequired || value.overflow || Boolean(selected && selected.expiresAt <= now), overflow: value.overflow,
    ...(selected && selected.expiresAt > now ? { selected: structuredClone(selected) } : {}) };
}
function validChoices(choices: TrustedTaskChoices | undefined, binding: ReferenceBinding, now: number): choices is TrustedTaskChoices {
  return clock(now) && text(binding.sourceKey) && text(binding.groupOpenid, 256) && record(choices)
    && keys(choices, ["sourceKey", "groupOpenid", "candidates", "overflow", "selectionRequired", "selected"])
    && choices.sourceKey === binding.sourceKey && choices.groupOpenid === binding.groupOpenid
    && Boolean(validateTaskContext({ selectionRequired: choices.selectionRequired, overflow: choices.overflow, selected: choices.selected }, now))
    && Array.isArray(choices.candidates) && choices.candidates.length <= 3
    && choices.candidates.every(row => record(row) && keys(row, ["token", "reference"]) && uuid(row.token) && validReference(row.reference, now))
    && new Set(choices.candidates.map(row => row.token)).size === choices.candidates.length
    && new Set(choices.candidates.map(row => row.reference.taskId)).size === choices.candidates.length;
}
const matches = (reference: MerchantTaskReference, selected: TaskSelection) => reference.taskId === selected.taskId && reference.orderId === selected.orderId;
export function currentTaskChoices(choices: TrustedTaskChoices | undefined, binding: ReferenceBinding, now = Date.now()): TrustedTaskChoices | undefined {
  if (!validChoices(choices, binding, now)) return undefined;
  const state = validateTaskContext({ selectionRequired: choices.selectionRequired, overflow: choices.overflow, selected: choices.selected }, now)!;
  const candidates = choices.candidates.filter(row => row.reference.expiresAt > now);
  const selected = state.selected && candidates.some(row => matches(row.reference, state.selected!)) ? state.selected : undefined;
  return { ...binding, candidates: structuredClone(candidates), overflow: state.overflow,
    selectionRequired: state.selectionRequired || choices.candidates.length > 1 || Boolean(choices.selected && !selected), ...(selected ? { selected } : {}) };
}
export function refreshTaskChoices(previous: TrustedTaskChoices | undefined, listing: TaskListing,
  binding: ReferenceBinding, now = Date.now()): TrustedTaskChoices | undefined {
  if (!clock(now) || !text(binding.sourceKey) || !text(binding.groupOpenid, 256)
    || previous !== undefined && !validChoices(previous, binding, now)
    || !record(listing) || !keys(listing, ["candidates", "overflow"]) || typeof listing.overflow !== "boolean"
    || !Array.isArray(listing.candidates) || listing.candidates.length > 3 || !listing.candidates.every(row => validReference(row, now))
    || new Set(listing.candidates.map(row => row.taskId)).size !== listing.candidates.length) return undefined;
  const candidates = listing.candidates.filter(reference => reference.expiresAt > now).map(reference => ({
    token: previous?.candidates.find(row => isDeepStrictEqual(row.reference, reference))?.token ?? randomUUID(), reference: structuredClone(reference),
  }));
  // Restored selections have no old ephemeral candidates. Match the new DB list
  // directly, keeping the user's original deadline even if a newer notification arrived.
  const oldSelected = previous?.selected;
  const selected = oldSelected && oldSelected.expiresAt > now && candidates.some(row => matches(row.reference, oldSelected)) ? structuredClone(oldSelected) : undefined;
  const overflow = Boolean(previous?.overflow || listing.overflow);
  return { ...binding, candidates, overflow,
    selectionRequired: Boolean(previous?.selectionRequired || overflow || (previous?.candidates.length ?? 0) > 1
      || listing.candidates.length > 1 || oldSelected && !selected), ...(selected ? { selected } : {}) };
}
export function resolveTaskReference(choices: TrustedTaskChoices | undefined, binding: ReferenceBinding, now = Date.now()): MerchantTaskReference | undefined {
  const current = currentTaskChoices(choices, binding, now);
  const candidate = current?.selected ? current.candidates.find(row => matches(row.reference, current.selected!))
    : current && !current.selectionRequired && !current.overflow && current.candidates.length === 1 ? current.candidates[0] : undefined;
  return candidate ? structuredClone(candidate.reference) : undefined;
}
export function selectTaskChoice(choices: TrustedTaskChoices | undefined, binding: ReferenceBinding, token: string,
  requestId: string, now = Date.now()): TrustedTaskChoices | undefined {
  const current = currentTaskChoices(choices, binding, now), candidate = current?.candidates.find(row => row.token === token);
  return current && candidate && text(requestId) && uuid(token) ? { ...current,
    selected: { taskId: candidate.reference.taskId, orderId: candidate.reference.orderId, requestId, selectedAt: now, expiresAt: candidate.reference.expiresAt } } : undefined;
}
export function taskChoiceNotice(choices: TrustedTaskChoices | undefined, binding: ReferenceBinding, now = Date.now()): string {
  const current = currentTaskChoices(choices, binding, now);
  if (!current?.candidates.length) return "没有仍有效的协商任务引用，请提供本人订单号查询协商进度；不会自动沿用旧任务。";
  return "请明确选择所指协商任务，模型不能代替你选择。\n" + current.candidates.map(row =>
    `${row.reference.orderId}，任务 ${row.reference.taskId}（${row.reference.origin === "sent" ? "平台已接受通知投递，不代表你已读" : "已确认发起协商"}）\n选择任务 ${row.token}`).join("\n")
    + (current.overflow ? "\n近期任务超过三个，其他任务请提供订单号重新查询。" : "")
    + "\n请单独发送一行“选择任务 编号”，下一条消息再继续查询。选择不会切换订单焦点，也不代表退款批准或确认；查询仍重新核验。";
}
