import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CouponStore } from "./coupon-store.ts";
import type { EvidenceSupportCandidate } from "./evidence-acceptance.ts";
import { scopeDocuments, type RetrievalDocument, type RetrievalScope } from "./retrieval-ranking.ts";

export type KnowledgeApplicabilityMode = "model_only" | "declared" | "declared-v2";
const states = ["unused", "redeemed", "expired", "refunded"] as const;
type CouponState = typeof states[number];
type Scope = { shopId: string | null; productId: string | null };
type Purpose = "refund_eligibility" | "business_prerequisite" | "current_order";
type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
// v2 hashes JSON data: hidden fields, accessors and nonplain objects must not carry unbound declarations.
function plainJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth > 8 || !value || typeof value !== "object") return false;
  const array = Array.isArray(value), names = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)
    || array && names.length !== value.length + 1) return false;
  return names.every(name => {
    if (typeof name !== "string") return false;
    const property = Object.getOwnPropertyDescriptor(value, name)!;
    if (array && name === "length") return true;
    return property.enumerable && "value" in property && (!array || /^(0|[1-9][0-9]*)$/.test(name) && Number(name) < value.length)
      && plainJson(property.value, depth + 1);
  });
}
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const scopeEqual = (a: Scope, b: RetrievalScope) => a.shopId === (b.shopId ?? null) && a.productId === (b.productId ?? null);
const scopeValid = (value: unknown): value is Scope => object(value) && keys(value, ["shopId", "productId"])
  && (value.shopId === null || identifier(value.shopId)) && (value.productId === null || identifier(value.productId))
  && !(value.productId && !value.shopId);

export type KnowledgeApplicabilityRule = {
  sourceId: string; scope: Scope; sourceHash: string;
  minimumCouponCount?: number; atLeastOneCouponInStates?: CouponState[];
  requiredProductCategories?: string[];
  basis: Array<{ field: "minimumCouponCount" | "atLeastOneCouponInStates" | "requiredProductCategories"; quote: string }>;
  reviewNote: string;
};
export type KnowledgeApplicabilityProduct = { shopId: string; productId: string; productName: string; categories: string[]; reviewNote: string };
type KnowledgeApplicabilityManifest = { serialization: "knowledge-document-v1"; documents: KnowledgeApplicabilityRule[] }
  & ({ version: 1 } | { version: 2; productCatalog: KnowledgeApplicabilityProduct[] });
export type KnowledgeApplicabilitySnapshot = KnowledgeApplicabilityManifest & { sha256: string; sourceSha256?: string };
export const knowledgeApplicabilityVersion = (snapshot: KnowledgeApplicabilitySnapshot) => snapshot.version === 2
  ? "declared-order-preconditions-v2" as const : "declared-order-preconditions-v1" as const;

// Separate from model serialization and old corpus hashes. Missing defaults have one representation.
export function knowledgeApplicabilitySourceHash(document: RetrievalDocument): string {
  scopeDocuments([document], {});
  return hash(JSON.stringify({ id: document.id, title: document.title, body: document.body, tags: [...document.tags],
    shopId: document.shopId, productId: document.productId ?? null, status: document.status ?? "active" }));
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function validateKnowledgeApplicabilitySnapshot(value: unknown, sourceSha256?: string, rawSourceSha256?: string): KnowledgeApplicabilitySnapshot {
  function fail(): never { throw new Error("知识适用前提文件无效，未启用声明门控。"); }
  if (!object(value) || !keys(value, ["version", "serialization", "documents", ...(value.version === 2 ? ["productCatalog"] : [])])
    || value.version !== 1 && value.version !== 2
    || value.serialization !== "knowledge-document-v1" || !Array.isArray(value.documents)
    || !value.documents.length || value.documents.length > 200 || sourceSha256 !== undefined && !sha(sourceSha256)) fail();
  if (value.version === 2 && !plainJson(value)) fail();
  if (rawSourceSha256 !== undefined && (value.version !== 2 || !sha(rawSourceSha256))) fail();
  const categoriesValid = (categories: unknown): categories is string[] => Array.isArray(categories) && categories.length >= 1 && categories.length <= 20
    && new Set(categories).size === categories.length && categories.every(identifier);
  if (value.version === 2) {
    if (!Array.isArray(value.productCatalog) || !value.productCatalog.length || value.productCatalog.length > 200) fail();
    const products = new Set<string>();
    for (const product of value.productCatalog) {
      if (!object(product) || !keys(product, ["shopId", "productId", "productName", "categories", "reviewNote"])
        || !identifier(product.shopId) || !identifier(product.productId) || !text(product.productName) || product.productName.length > 256
        || !categoriesValid(product.categories) || !text(product.reviewNote) || product.reviewNote.length > 4096) fail();
      const key = `${product.shopId}:${product.productId}`;
      if (products.has(key)) fail(); products.add(key);
    }
  }
  const ids = new Set<string>();
  for (const raw of value.documents) {
    if (!object(raw) || !keys(raw, ["sourceId", "scope", "sourceHash", "minimumCouponCount", "atLeastOneCouponInStates", "basis", "reviewNote",
      ...(value.version === 2 ? ["requiredProductCategories"] : [])])
      || !identifier(raw.sourceId) || ids.has(raw.sourceId) || !scopeValid(raw.scope) || !sha(raw.sourceHash)
      || !text(raw.reviewNote) || !Array.isArray(raw.basis)) fail();
    ids.add(raw.sourceId);
    if (raw.minimumCouponCount !== undefined && (typeof raw.minimumCouponCount !== "number"
      || !Number.isSafeInteger(raw.minimumCouponCount) || raw.minimumCouponCount < 1 || raw.minimumCouponCount > 100)) fail();
    if (raw.atLeastOneCouponInStates !== undefined && (!Array.isArray(raw.atLeastOneCouponInStates)
      || !raw.atLeastOneCouponInStates.length || new Set(raw.atLeastOneCouponInStates).size !== raw.atLeastOneCouponInStates.length
      || raw.atLeastOneCouponInStates.some((state: unknown) => typeof state !== "string" || !states.includes(state as CouponState)))) fail();
    if (raw.requiredProductCategories !== undefined && !categoriesValid(raw.requiredProductCategories)) fail();
    const fields = ["minimumCouponCount", "atLeastOneCouponInStates", ...(value.version === 2 ? ["requiredProductCategories"] : [])]
      .filter(field => raw[field] !== undefined);
    if (raw.basis.length !== fields.length || new Set(raw.basis.map((row: unknown) => object(row) ? row.field : null)).size !== fields.length) fail();
    for (const basis of raw.basis) if (!object(basis) || !keys(basis, ["field", "quote"])
      || !fields.includes(String(basis.field)) || !text(basis.quote)) fail();
  }
  const manifest = structuredClone(value) as KnowledgeApplicabilityManifest, canonicalHash = hash(JSON.stringify(value));
  // v1 retains historical raw-file hashes; v2 binds the full declaration and product catalog to its JSON content.
  if (value.version === 2 && sourceSha256 !== undefined && sourceSha256 !== canonicalHash) fail();
  return freeze({ ...manifest, sha256: sourceSha256 ?? canonicalHash, ...(rawSourceSha256 === undefined ? {} : { sourceSha256: rawSourceSha256 }) });
}

export function revalidateKnowledgeApplicabilitySnapshot(snapshot: KnowledgeApplicabilitySnapshot): KnowledgeApplicabilitySnapshot {
  if (snapshot.version === 2 && !plainJson(snapshot)) throw new Error("知识适用前提文件无效，未启用声明门控。");
  const { sha256, sourceSha256, ...manifest } = snapshot;
  return validateKnowledgeApplicabilitySnapshot(manifest, sha256, sourceSha256);
}

// Call only for the declared candidate. No corpus/seed mutation or model/API dependency.
export async function loadKnowledgeApplicabilitySnapshot(version: 1 | 2 = 1): Promise<KnowledgeApplicabilitySnapshot> {
  if (version !== 1 && version !== 2) throw new Error("知识适用前提版本仅支持 1 或 2。");
  const bytes = await readFile(new URL(version === 2 ? "../data/knowledge-applicability-v2.json" : "../data/knowledge-applicability.json", import.meta.url));
  const snapshot = validateKnowledgeApplicabilitySnapshot(JSON.parse(bytes.toString()), version === 1 ? hash(bytes) : undefined, version === 2 ? hash(bytes) : undefined);
  if (snapshot.version !== version || snapshot.documents.length !== 8) throw new Error("在线适用前提必须按所选版本完整审阅现有 8 篇规则。");
  return snapshot;
}

export type KnowledgeApplicabilityContext = {
  version: "order-coupon-facts-v1"; purpose: Purpose; requestId: string; orderId: string | null; asOf: string | null;
  scope: Scope; facts: { couponCount: number; couponStates: Record<CouponState, number> } | null;
  factsHash: string; unknownReason: string | null;
};
function contextHash(context: Omit<KnowledgeApplicabilityContext, "factsHash">): string {
  return hash(JSON.stringify({ version: context.version, purpose: context.purpose, requestId: context.requestId,
    orderId: context.orderId, asOf: context.asOf, scope: { shopId: context.scope.shopId, productId: context.scope.productId },
    facts: context.facts ? { couponCount: context.facts.couponCount,
      couponStates: Object.fromEntries(states.map(state => [state, context.facts!.couponStates[state]])) } : null,
    unknownReason: context.unknownReason }));
}

// Caller supplies the successful authorized get_order output, never action arguments or historical prose.
// These are order-level necessary conditions at asOf, not selected-coupon facts or permission to refund.
export function buildKnowledgeApplicabilityContext(input: { order: Order; requestId: string; purpose: Purpose }): KnowledgeApplicabilityContext {
  const order = input.order;
  const scope: Scope = { shopId: identifier(order?.shop?.id) ? order.shop.id : null, productId: null };
  const base: Omit<KnowledgeApplicabilityContext, "factsHash"> = { version: "order-coupon-facts-v1", purpose: input.purpose,
    requestId: input.requestId, orderId: identifier(order?.id) ? order.id : null, asOf: timestamp(order?.asOf) ? order.asOf : null,
    scope, facts: null, unknownReason: null };
  const finish = (reason: string | null) => { base.unknownReason = reason; return freeze({ ...base, factsHash: contextHash(base) }); };
  if (!text(input.requestId) || input.requestId.length > 512 || !["refund_eligibility", "business_prerequisite", "current_order"].includes(input.purpose)
    || order?.source !== "demo-database" || !base.orderId || !base.asOf || !scope.shopId) return finish("invalid_order_binding");
  if (!Array.isArray(order.items) || !order.items.length || order.items.length > 100 || !Array.isArray(order.coupons) || order.coupons.length > 100) return finish("incomplete_order_items");
  const items = new Map<string, { productId: string; quantity: number; observed: number }>();
  for (const item of order.items) {
    if (!identifier(item?.id) || !identifier(item?.productId) || items.has(item.id)
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) return finish("invalid_order_item");
    items.set(item.id, { productId: item.productId, quantity: item.quantity, observed: 0 });
  }
  const products = new Set([...items.values()].map(item => item.productId));
  if (products.size !== 1) return finish("ambiguous_product_scope");
  scope.productId = [...products][0]!;
  const counts: Record<CouponState, number> = { unused: 0, redeemed: 0, expired: 0, refunded: 0 }, seen = new Set<string>();
  for (const coupon of order.coupons) {
    if (!identifier(coupon?.id) || seen.has(coupon.id) || !identifier(coupon.orderItemId) || !items.has(coupon.orderItemId)
      || !states.includes(coupon.status as CouponState)) return finish("invalid_coupon_binding_or_state");
    seen.add(coupon.id); items.get(coupon.orderItemId)!.observed++; counts[coupon.status as CouponState]++;
  }
  if ([...items.values()].some(item => item.observed !== item.quantity)) return finish("incomplete_coupon_inventory");
  // status remains the stored enum: unused + past expiresAt is NOT rewritten to expired.
  base.facts = { couponCount: order.coupons.length, couponStates: counts };
  return finish(null);
}

function validContext(context: KnowledgeApplicabilityContext, scope: RetrievalScope): boolean {
  if (!object(context) || !keys(context, ["version", "purpose", "requestId", "orderId", "asOf", "scope", "facts", "factsHash", "unknownReason"])
    || context.version !== "order-coupon-facts-v1" || !["refund_eligibility", "business_prerequisite", "current_order"].includes(context.purpose)
    || !text(context.requestId) || context.requestId.length > 512 || !identifier(context.orderId) || !timestamp(context.asOf)
    || !scopeValid(context.scope) || !context.scope.shopId || !context.scope.productId || !scopeEqual(context.scope, scope)
    || !sha(context.factsHash) || context.unknownReason !== null || !object(context.facts)
    || !keys(context.facts, ["couponCount", "couponStates"]) || !object(context.facts.couponStates)
    || !keys(context.facts.couponStates, states) || !Number.isSafeInteger(context.facts.couponCount)
    || context.facts.couponCount < 1 || context.facts.couponCount > 100
    || states.some(state => !Number.isSafeInteger(context.facts!.couponStates[state]) || context.facts!.couponStates[state] < 0)
    || states.reduce((sum, state) => sum + context.facts!.couponStates[state], 0) !== context.facts.couponCount) return false;
  return contextHash(context) === context.factsHash;
}

export type KnowledgeApplicabilityDecision = { id: string; rank: number;
  status: "matched" | "mismatched" | "unknown" | "not_checked" | "none_declared"; reason: string };
export type KnowledgeApplicabilityResult = {
  version: ReturnType<typeof knowledgeApplicabilityVersion>; snapshotHash: string; contextHash: string | null;
  status: "ready" | "unavailable"; integrity: boolean; reason: null | "metadata_binding_invalid" | "facts_unknown";
  decisions: KnowledgeApplicabilityDecision[]; candidates: EvidenceSupportCandidate[];
};

// Run after the original score/Top5 preparation. Do not refill, rewrite, or renumber raw candidates.
export function gateKnowledgeApplicability(input: { snapshot: KnowledgeApplicabilitySnapshot; context: KnowledgeApplicabilityContext | null;
  scope: RetrievalScope; candidates: readonly EvidenceSupportCandidate[] }): KnowledgeApplicabilityResult {
  const result: KnowledgeApplicabilityResult = { version: knowledgeApplicabilityVersion(input.snapshot), snapshotHash: input.snapshot.sha256,
    contextHash: input.context?.factsHash ?? null, status: "ready", integrity: true, reason: null, decisions: [], candidates: [] };
  const decide = (candidate: EvidenceSupportCandidate, status: KnowledgeApplicabilityDecision["status"], reason: string) => {
    result.decisions.push({ id: candidate.id, rank: candidate.rank, status, reason });
    if (["matched", "not_checked", "none_declared"].includes(status)) result.candidates.push(candidate);
  };
  const metadata = new Map<string, KnowledgeApplicabilityRule>();
  // Source mismatch is configuration/integrity failure, never a correct semantic rejection.
  try {
    if (input.snapshot.version === 2) {
      revalidateKnowledgeApplicabilitySnapshot(input.snapshot);
    }
    for (const rule of input.snapshot.documents) metadata.set(rule.sourceId, rule);
    if (input.candidates.length > 5 || new Set(input.candidates.map(candidate => candidate.rank)).size !== input.candidates.length
      || input.candidates.some(candidate => !Number.isSafeInteger(candidate.rank) || candidate.rank < 1
        || typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1)) throw new Error();
    if (scopeDocuments(input.candidates, input.scope).length !== input.candidates.length) throw new Error();
    for (const candidate of input.candidates) {
      const rule = metadata.get(candidate.id);
      if (!rule && !input.context && input.snapshot.version === 1) continue; // Retain the historical v1 reference-source exemption only.
      if (!rule || !scopeEqual(rule.scope, { shopId: candidate.shopId, productId: candidate.productId })
        || rule.sourceHash !== knowledgeApplicabilitySourceHash(candidate)
        || rule.basis.some(basis => !candidate.body.includes(basis.quote))) throw new Error();
    }
  } catch {
    result.status = "unavailable"; result.integrity = false; result.reason = "metadata_binding_invalid";
    input.candidates.forEach(candidate => decide(candidate, "unknown", "metadata_binding_invalid"));
    return result;
  }
  if (!input.context) {
    input.candidates.forEach(candidate => decide(candidate, "not_checked", "no_current_order_context"));
    return result;
  }
  const known = validContext(input.context, input.scope);
  if (!known) { result.integrity = false; result.reason = "facts_unknown"; }
  // The reviewed synthetic catalog proves only the author's declared category, never a name-based inference or permission.
  const product = input.snapshot.version === 2 && known ? input.snapshot.productCatalog.find(product =>
    product.shopId === input.context!.scope.shopId && product.productId === input.context!.scope.productId) : undefined;
  for (const candidate of input.candidates) {
    const rule = metadata.get(candidate.id)!;
    if (rule.minimumCouponCount === undefined && rule.atLeastOneCouponInStates === undefined && rule.requiredProductCategories === undefined) {
      decide(candidate, "none_declared", "no_declared_quantity_or_state_precondition");
    } else if (!known) decide(candidate, "unknown", "facts_unknown");
    else if (rule.minimumCouponCount !== undefined && input.context.facts!.couponCount < rule.minimumCouponCount) {
      decide(candidate, "mismatched", "minimum_coupon_count");
    } else if (rule.atLeastOneCouponInStates && !rule.atLeastOneCouponInStates.some(state => input.context!.facts!.couponStates[state] > 0)) {
      decide(candidate, "mismatched", "coupon_state_absent");
    } else if (rule.requiredProductCategories && !product) {
      decide(candidate, "unknown", "product_category_unknown");
    } else if (rule.requiredProductCategories && !rule.requiredProductCategories.some(category => product!.categories.includes(category))) {
      decide(candidate, "mismatched", "product_category_mismatch");
    } else decide(candidate, "matched", "declared_necessary_preconditions_only");
  }
  return result;
}
