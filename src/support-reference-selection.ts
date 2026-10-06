import { createHash, randomUUID } from "node:crypto";
import type { TrustedPolicyTopic } from "./support-controller.ts";

export type ReferenceBinding = { sourceKey: string; groupOpenid: string };
export type TrustedReference = { kind: "order"; requestId: string; orderId: string }
  | { kind: "policy"; topic: TrustedPolicyTopic };
export const referenceChoicesVersion = "reference-choices-v1" as const;
export const referenceChoiceTtlMs = 15 * 60_000;
export type TrustedReferenceChoices = ReferenceBinding & {
  version: typeof referenceChoicesVersion; kind: TrustedReference["kind"];
  candidates: Array<{ token: string; version: string; expiresAt: number; reference: TrustedReference }>;
  overflow: boolean; selectionRequired: boolean; selectedToken?: string;
};
export const emptyReferenceChoices = (kind: TrustedReference["kind"], binding: ReferenceBinding): TrustedReferenceChoices =>
  ({ ...binding, version: referenceChoicesVersion, kind, candidates: [], overflow: false, selectionRequired: false });

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max = 512): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const orderId = (value: unknown) => typeof value === "string" && /^COUPON-\d{4}$/.test(value);
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = (reference: TrustedReference) => createHash("sha256").update(JSON.stringify(reference)).digest("hex");
const requestId = (reference: TrustedReference) => reference.kind === "order" ? reference.requestId : reference.topic.requestId;
const bound = (value: ReferenceBinding, binding: ReferenceBinding) => value.sourceKey === binding.sourceKey && value.groupOpenid === binding.groupOpenid;

function validReference(value: unknown, binding: ReferenceBinding): value is TrustedReference {
  if (!record(value)) return false;
  if (value.kind === "order") return keys(value, ["kind", "requestId", "orderId"]) && text(value.requestId) && orderId(value.orderId);
  if (value.kind !== "policy" || !keys(value, ["kind", "topic"]) || !record(value.topic)) return false;
  const { sourceKey, groupOpenid, ...topic } = value.topic;
  return sourceKey === binding.sourceKey && groupOpenid === binding.groupOpenid && validPolicyTopicFields(topic);
}

// Storage carries no routing claims; the Session supplies its trusted binding again on recovery.
export function validPolicyTopicFields(topic: unknown): topic is Omit<TrustedPolicyTopic, "sourceKey" | "groupOpenid"> {
  if (!record(topic)) return false;
  const prior = topic.priorQueries;
  if (prior !== undefined && (!Array.isArray(prior) || prior.length > 4
    || prior.some(query => !record(query) || !keys(query, ["requestId", "originalQuery"])
      || !text(query.requestId) || !text(query.originalQuery, 500))
    || new Set([...prior.map(query => query.requestId), topic.requestId]).size !== prior.length + 1)) return false;
  if (!text(topic.originalQuery, 500) || topic.originalQuery.length
    + (Array.isArray(prior) ? prior.reduce((sum, query) => sum + query.originalQuery.length, 0) : 0) > 500) return false;
  return keys(topic, ["requestId", "originalQuery", "orderId", "scope", "sources", "intent", "priorQueries"])
    && text(topic.requestId)
    && text(topic.originalQuery, 500) && (topic.orderId === null || orderId(topic.orderId))
    && record(topic.scope) && keys(topic.scope, ["shopId", "productId"])
    && (topic.scope.shopId === null || text(topic.scope.shopId)) && (topic.scope.productId === null || text(topic.scope.productId))
    && (topic.intent === undefined || topic.intent === "policy" || topic.intent === "refund_eligibility")
    && Array.isArray(topic.sources) && topic.sources.length > 0 && topic.sources.length <= 5
    && topic.sources.every(source => record(source) && keys(source, ["sourceId", "version"]) && text(source.sourceId)
      && typeof source.version === "string" && /^[a-f0-9]{64}$/.test(source.version))
    && new Set(topic.sources.map(source => source.sourceId)).size === topic.sources.length;
}

export function currentReferenceChoices(choices: TrustedReferenceChoices | undefined, binding: ReferenceBinding,
  now = Date.now()): TrustedReferenceChoices | undefined {
  if (!text(binding.sourceKey) || !text(binding.groupOpenid) || !Number.isSafeInteger(now) || now < 0
    || !record(choices) || !keys(choices, ["sourceKey", "groupOpenid", "version", "kind", "candidates", "overflow", "selectionRequired", "selectedToken"])
    || !bound(choices, binding) || choices.version !== referenceChoicesVersion || !["order", "policy"].includes(choices.kind)
    || !Array.isArray(choices.candidates) || choices.candidates.length > 3
    || typeof choices.overflow !== "boolean" || typeof choices.selectionRequired !== "boolean"
    || choices.candidates.some(row => !record(row) || !keys(row, ["token", "version", "expiresAt", "reference"])
      || !uuid(row.token) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0
      || !validReference(row.reference, binding) || row.reference.kind !== choices.kind || row.version !== hash(row.reference))
    || new Set(choices.candidates.map(row => row.token)).size !== choices.candidates.length
    || new Set(choices.candidates.map(row => requestId(row.reference))).size !== choices.candidates.length
    || choices.kind === "order" && new Set(choices.candidates.map(row => row.reference.kind === "order" ? row.reference.orderId : undefined)).size !== choices.candidates.length
    || choices.selectedToken !== undefined && (!uuid(choices.selectedToken) || !choices.candidates.some(row => row.token === choices.selectedToken))) return undefined;
  const candidates = choices.candidates.filter(row => row.expiresAt > now);
  const selectedToken = candidates.some(row => row.token === choices.selectedToken) ? choices.selectedToken : undefined;
  // An empty expired list retains the earlier ambiguity; remembering one fresh
  // candidate must not silently resolve a choice the user never made.
  return { ...structuredClone(choices), candidates: structuredClone(candidates),
    selectionRequired: choices.selectionRequired || choices.overflow || choices.candidates.length > 1
      || Boolean(choices.selectedToken && !selectedToken), selectedToken };
}

export function resolveReferenceChoice(choices: TrustedReferenceChoices | undefined, binding: ReferenceBinding,
  now = Date.now()): TrustedReference | undefined {
  const current = currentReferenceChoices(choices, binding, now);
  const selected = current?.selectedToken ? current.candidates.find(row => row.token === current.selectedToken)
    : current && !current.selectionRequired && !current.overflow && current.candidates.length === 1 ? current.candidates[0] : undefined;
  return selected ? structuredClone(selected.reference) : undefined;
}

export function rememberReferenceChoice(previous: TrustedReferenceChoices | undefined, binding: ReferenceBinding,
  reference: TrustedReference, options: { continueRequestId?: string } = {}, now = Date.now()): TrustedReferenceChoices | undefined {
  if (!text(binding.sourceKey) || !text(binding.groupOpenid) || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(now + referenceChoiceTtlMs) || !validReference(reference, binding)
    || !record(options) || !keys(options, ["continueRequestId"])
    || options.continueRequestId !== undefined && !text(options.continueRequestId)) return undefined;
  const before = currentReferenceChoices(previous, binding, now);
  if (previous && (!before || before.kind !== reference.kind)) return undefined;
  const continued = options.continueRequestId;
  if (continued !== undefined) {
    const resolved = resolveReferenceChoice(before, binding, now);
    if (reference.kind !== "policy" || resolved?.kind !== "policy" || resolved.topic.requestId !== continued
      || reference.topic.requestId === continued) return undefined;
  }
  const retained = (before?.candidates ?? []).filter(row => reference.kind === "order"
    ? row.reference.kind !== "order" || row.reference.orderId !== reference.orderId : requestId(row.reference) !== continued);
  if (retained.some(row => requestId(row.reference) === requestId(reference))) return undefined;
  const candidate = { token: randomUUID(), version: hash(reference), expiresAt: now + referenceChoiceTtlMs, reference: structuredClone(reference) };
  const candidates = [...retained, candidate];
  return { ...binding, version: referenceChoicesVersion, kind: reference.kind, candidates: candidates.slice(-3),
    overflow: Boolean(before?.overflow) || candidates.length > 3,
    selectionRequired: Boolean(before?.selectionRequired) || Boolean(before?.overflow) || candidates.length > 1,
    // Only an already selected, host-validated continuation migrates selection.
    // A standalone question never dismisses the unresolved prior choice.
    ...(continued !== undefined && before?.selectedToken ? { selectedToken: candidate.token } : {}) };
}

export function selectReferenceChoice(choices: TrustedReferenceChoices | undefined, binding: ReferenceBinding, token: string,
  now = Date.now()): TrustedReferenceChoices | undefined {
  const current = currentReferenceChoices(choices, binding, now);
  return uuid(token) && current?.candidates.some(row => row.token === token) ? { ...current, selectedToken: token } : undefined;
}

export function referenceChoiceNotice(kind: TrustedReference["kind"], choices: TrustedReferenceChoices | undefined,
  binding: ReferenceBinding, now = Date.now()): string {
  const current = currentReferenceChoices(choices, binding, now), label = kind === "order" ? "订单" : "话题";
  if (!current || current.kind !== kind || !current.candidates.length) return kind === "order"
    ? "没有仍有效的订单候选，请完整提供本人订单号和本次需求；不会自动沿用旧订单。"
    : "没有仍有效的话题候选，请完整重述具体规则、渠道或主体及本次问题；不会自动沿用旧话题。";
  const lines = current.candidates.map(row => {
    const reference = row.reference;
    const summary = reference.kind === "order" ? reference.orderId
      : `${reference.topic.orderId ?? "一般政策"}：${reference.topic.originalQuery.replace(/\s+/gu, " ").trim()}`;
    return `${summary}\n选择${label} ${row.token}`;
  });
  return `请明确选择本轮所指${label}，模型不能代替你选择。\n` + lines.join("\n")
    + (current.overflow ? "\n历史候选超过三个，这里仅列最近三个；其他对象请完整重新查询。" : "")
    + `\n请单独发送一行“选择${label} 编号”，下一条消息再继续提问。选择不代表授权、商家批准或退款确认；下一轮仍重新核验。`;
}
