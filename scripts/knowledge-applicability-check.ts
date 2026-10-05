import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildKnowledgeApplicabilityContext, gateKnowledgeApplicability, knowledgeApplicabilitySourceHash,
  loadKnowledgeApplicabilitySnapshot, validateKnowledgeApplicabilitySnapshot,
  type KnowledgeApplicabilityContext } from "../src/knowledge-applicability.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import type { EvidenceSupportCandidate } from "../src/evidence-acceptance.ts";

const root = new URL("../", import.meta.url);
const onlineBytes = await readFile(new URL("data/acceptance-online.json", root));
const seedBytes = await readFile(new URL("db/02-seed.sql", root));
const source = JSON.parse(await readFile(new URL("data/acceptance-source.json", root), "utf8"));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(onlineBytes), source.files["data/acceptance-online.json"].sha256);
assert.equal(hash(seedBytes), source.online.seedSha256);
const documents: RetrievalDocument[] = JSON.parse(onlineBytes.toString()).documents;
const snapshot = await loadKnowledgeApplicabilitySnapshot();
assert.equal(snapshot.sha256, hash(await readFile(new URL("data/knowledge-applicability.json", root))));
assert.equal(snapshot.documents.length, 8);
assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.documents) && Object.isFrozen(snapshot.documents[0]!.basis));
for (const document of documents) {
  const rule = snapshot.documents.find(rule => rule.sourceId === document.id)!;
  assert.ok(rule, `all eight source rows reviewed: ${document.id}`);
  assert.equal(rule.sourceHash, knowledgeApplicabilitySourceHash(document));
  assert.deepEqual(rule.scope, { shopId: document.shopId, productId: document.productId ?? null });
  for (const basis of rule.basis) assert.ok(document.body.includes(basis.quote), `${document.id} literal basis`);
}
assert.equal(knowledgeApplicabilitySourceHash({ ...documents[0]!, status: undefined, productId: undefined }),
  knowledgeApplicabilitySourceHash({ ...documents[0]!, status: "active", productId: null }));

function order(statuses = ["unused"]): Parameters<typeof buildKnowledgeApplicabilityContext>[0]["order"] {
  return { source: "demo-database", id: "COUPON-1001", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
    amounts: { totalCents: 7980 * statuses.length, paidCents: 7980 * statuses.length, refundedCents: 0 },
    createdAt: "2026-10-01T00:00:00.000Z", paidAt: "2026-10-01T00:00:00.000Z",
    shop: { id: "shop-demo-1", name: "演示门店", merchantName: "演示商家", address: "演示地址" },
    items: [{ id: "item-a", productId: "product-demo-1", productName: "双人午餐团购券", quantity: statuses.length, unitPriceCents: 7980, totalCents: 7980 * statuses.length }],
    coupons: statuses.map((status, index) => ({ id: `coupon-${index}`, orderItemId: "item-a", status,
      expiresAt: "2026-11-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null })), payments: [], refunds: [] };
}
const build = (value = order(), requestId = "actual-request-1") => buildKnowledgeApplicabilityContext({ order: value, requestId, purpose: "refund_eligibility" });
const scope = { shopId: "shop-demo-1", productId: "product-demo-1" };
const candidate = (id: string, rank: number): EvidenceSupportCandidate => ({ ...documents.find(document => document.id === id)!, rank, score: .9 - rank / 100 });
const unused = candidate("KB-REFUND-UNUSED", 1), partial = candidate("KB-REFUND-PARTIAL", 4), redeemed = candidate("KB-REFUND-REDEEMED", 5);
const gate = (candidates: EvidenceSupportCandidate[], context: KnowledgeApplicabilityContext | null = build()) =>
  gateKnowledgeApplicability({ snapshot, context, scope, candidates });
const original = [unused, partial, redeemed], originalText = JSON.stringify(original);
const single = gate(original);
assert.deepEqual(single.candidates.map(row => [row.id, row.rank]), [[unused.id, 1]]);
assert.deepEqual(single.decisions.map(row => row.status), ["matched", "mismatched", "mismatched"]);
assert.equal(single.integrity, true); assert.equal(single.status, "ready");
assert.equal(JSON.stringify(original), originalText, "raw candidates immutable; no refill from rank 6");
assert.equal(single.candidates[0], original[0], "keep exact candidate including original rank");
const multi = gate(original, build(order(["unused", "redeemed"])));
assert.deepEqual(multi.candidates.map(row => row.rank), [1, 4, 5]);
assert.ok(multi.decisions.every(row => row.status === "matched"));
assert.equal(gate([partial], build(order(["unused", "unused"]))).decisions[0]!.status, "matched", "body does not require a redeemed coupon");
assert.equal(gate([unused, redeemed], build(order(["refunded"]))).candidates.length, 0);
assert.equal(gate([partial]).candidates.length, 0, "all excluded: caller must make zero support requests");

const expired = candidate("KB-REFUND-EXPIRED", 2), oldDate = order();
oldDate.coupons[0]!.expiresAt = "2026-10-01T00:00:00.000Z";
assert.deepEqual(build(oldDate).facts, build(order()).facts, "raw status is not a computed date transition");
assert.equal(gate([expired], build(oldDate)).decisions[0]!.status, "matched");
assert.equal(gate([expired], build(order())).decisions[0]!.status, "matched", "necessary status match does not prove expiry");
assert.equal(gate([expired], build(order(["expired"]))).decisions[0]!.status, "matched");
assert.equal(gate([expired], build(order(["redeemed"]))).decisions[0]!.status, "mismatched");

const unknownOrders: Array<ReturnType<typeof order>> = [];
const missing = order(["unused", "unused"]); missing.coupons.pop(); unknownOrders.push(missing);
const orphan = order(); orphan.coupons[0]!.orderItemId = "other-order-item"; unknownOrders.push(orphan);
const duplicate = order(["unused", "unused"]); duplicate.coupons[1]!.id = duplicate.coupons[0]!.id; unknownOrders.push(duplicate);
const invalidState = order(["new-unrecognized-state"]); unknownOrders.push(invalidState);
const mixed = order(["unused", "unused"]);
mixed.items[0]!.quantity = 1; mixed.items.push({ ...mixed.items[0]!, id: "item-b", productId: "product-demo-2" });
mixed.coupons[1]!.orderItemId = "item-b"; unknownOrders.push(mixed);
const invalidDate = order(); invalidDate.asOf = "not-a-date"; unknownOrders.push(invalidDate);
for (const value of unknownOrders) {
  const context = build(value); assert.equal(context.facts, null); assert.ok(context.unknownReason);
  const result = gate([unused, partial], context);
  assert.equal(result.integrity, false); assert.equal(result.reason, "facts_unknown");
  assert.equal(result.candidates.length, 0); assert.ok(result.decisions.every(row => row.status === "unknown"));
}
assert.equal(build(order(), " ").facts, null);
const sameProduct = order(["unused", "redeemed"]);
sameProduct.items[0]!.quantity = 1; sameProduct.items.push({ ...sameProduct.items[0]!, id: "item-b" });
sameProduct.coupons[1]!.orderItemId = "item-b";
assert.equal(build(sameProduct).facts!.couponCount, 2, "same SKU multiple items only with complete per-item coupon links");
sameProduct.coupons[1]!.orderItemId = "item-a";
assert.equal(build(sameProduct).facts, null, "equal total does not excuse missing per-item inventory");

const stale = structuredClone(build()); stale.facts!.couponCount = 2; stale.facts!.couponStates.unused = 2;
assert.equal(gate([partial], stale).decisions[0]!.status, "unknown", "self-consistent forged counts fail facts hash");
const badTotal = structuredClone(build()); badTotal.facts!.couponStates.unused = 2;
assert.equal(gate([partial], badTotal).decisions[0]!.status, "unknown");
const otherScope = { shopId: "shop-demo-1", productId: "product-demo-2" };
assert.equal(gateKnowledgeApplicability({ snapshot, context: build(), scope: otherScope, candidates: [partial] }).integrity, false);
const switched = order(["redeemed"]); switched.id = "COUPON-1002";
assert.notEqual(build(switched, "actual-request-2").factsHash, build().factsHash);
assert.deepEqual(gate([unused, redeemed], build(switched, "actual-request-2")).candidates.map(row => row.id), [redeemed.id]);

const product = candidate("KB-PRODUCT-LUNCH", 3);
assert.equal(gate([product]).decisions[0]!.status, "none_declared");
assert.equal(gate([product], build(missing)).integrity, false, "none_declared cannot hide invalid fact context");
assert.deepEqual(gate(original, null).candidates, original, "generic/hypothetical must not use an instance to filter policy");
assert.ok(gate(original, null).decisions.every(row => row.status === "not_checked"));
const reference: EvidenceSupportCandidate = { id: "reference-document", title: "参考规则", body: "参考原文", tags: [], shopId: null, rank: 1, score: .9 };
assert.equal(gate([reference], null).decisions[0]!.status, "not_checked");
assert.equal(gate([reference]).reason, "metadata_binding_invalid", "current object cannot silently exempt missing online metadata");
for (const context of [build(), null]) {
  const changed = { ...partial, body: `${partial.body} 原文已变更。` };
  const result = gate([unused, changed], context);
  assert.equal(result.status, "unavailable"); assert.equal(result.integrity, false); assert.equal(result.candidates.length, 0);
  assert.equal(result.reason, "metadata_binding_invalid");
}
assert.equal(gate([{ ...partial, shopId: "other-shop" }]).status, "unavailable");
const brokenQuote = JSON.parse(await readFile(new URL("data/knowledge-applicability.json", root), "utf8"));
brokenQuote.documents.find((row: { sourceId: string }) => row.sourceId === partial.id).basis[0].quote = "原文没有的前提";
assert.equal(gateKnowledgeApplicability({ snapshot: validateKnowledgeApplicabilitySnapshot(brokenQuote), context: build(), scope, candidates: [partial] }).status, "unavailable");
const brokenShape = structuredClone(brokenQuote); brokenShape.documents[0].arbitraryOperator = "allow";
assert.throws(() => validateKnowledgeApplicabilitySnapshot(brokenShape));
const brokenBasis = structuredClone(brokenQuote); brokenBasis.documents[0].basis = [];
assert.throws(() => validateKnowledgeApplicabilitySnapshot(brokenBasis));
assert.equal(gate([{ ...unused, rank: 0 }]).status, "unavailable");
console.log("Knowledge applicability checks passed: 8 unchanged sources, explicit necessary predicates, unknown/identity/scope/inventory guards, no-refill ranks, generic/reference and binding failures; 0 API calls.");
