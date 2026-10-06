import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildKnowledgeApplicabilityContext, gateKnowledgeApplicability, knowledgeApplicabilitySourceHash,
  loadKnowledgeApplicabilitySnapshot, validateKnowledgeApplicabilitySnapshot,
  type KnowledgeApplicabilityContext, type KnowledgeApplicabilityRule, type KnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
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

const categorySource: EvidenceSupportCandidate = { id: "synthetic-category-rule", title: "原创合成类别规则",
  body: "常规午餐与晚餐套餐可在普通周六、周日使用，包场套餐需重新确认使用范围。", tags: ["合成类别"], shopId: null, productId: null, rank: 1, score: .9 };
const categoryManifest = { version: 2, serialization: "knowledge-document-v1", documents: [{ sourceId: categorySource.id,
  sourceHash: knowledgeApplicabilitySourceHash(categorySource), scope: { shopId: null, productId: null }, requiredProductCategories: ["regular_lunch", "regular_dinner"],
  basis: [{ field: "requiredProductCategories", quote: "常规午餐与晚餐套餐可在普通周六、周日使用" }], reviewNote: "作者声明的两类合成套餐前提，不证明外部商品类别或实例使用许可。" }],
  productCatalog: [{ shopId: scope.shopId, productId: scope.productId, productName: "作者命名的合成商品", categories: ["regular_lunch"], reviewNote: "按合成商品ID审阅，名称不参与推断。" },
    { shopId: scope.shopId, productId: "product-demo-2", productName: "作者命名的合成包场商品", categories: ["private"], reviewNote: "合成受限类别。" }] };
const categorySnapshot = validateKnowledgeApplicabilitySnapshot(categoryManifest);
assert.equal(categorySnapshot.version, 2); assert.equal(categorySnapshot.sha256, hash(JSON.stringify(categoryManifest)));
assert.ok(categorySnapshot.version === 2 && Object.isFrozen(categorySnapshot.productCatalog) && Object.isFrozen(categorySnapshot.productCatalog[0]!.categories));
const categoryGate = (context = build(), value: KnowledgeApplicabilitySnapshot = categorySnapshot, source = categorySource, currentScope = context.scope) =>
  gateKnowledgeApplicability({ snapshot: value, context, scope: currentScope, candidates: [source] });
const matchedCategory = categoryGate();
assert.equal(matchedCategory.version, "declared-order-preconditions-v2"); assert.equal(matchedCategory.decisions[0]!.status, "matched");
assert.equal(matchedCategory.candidates[0], categorySource, "One matching declared category suffices, with no candidate or rank rewrite");
const anotherProduct = order(); anotherProduct.items[0]!.productId = "product-demo-2";
anotherProduct.items[0]!.productName = "常规午餐套餐"; anotherProduct.id = "COUPON-1002";
const mismatchedCategory = categoryGate(build(anotherProduct));
assert.equal(mismatchedCategory.decisions[0]!.status, "mismatched"); assert.equal(mismatchedCategory.decisions[0]!.reason, "product_category_mismatch");
assert.equal(mismatchedCategory.candidates.length, 0); assert.equal(mismatchedCategory.integrity, true);
anotherProduct.items[0]!.productId = "product-demo-unknown";
const unknownCategory = categoryGate(build(anotherProduct));
assert.equal(unknownCategory.decisions[0]!.status, "unknown"); assert.equal(unknownCategory.decisions[0]!.reason, "product_category_unknown");
assert.equal(unknownCategory.candidates.length, 0); assert.equal(unknownCategory.status, "ready"); assert.equal(unknownCategory.integrity, true);
assert.equal(unknownCategory.reason, null, "A valid catalog with an unknown product is not metadata corruption or a proven mismatch");
const anotherShop = order(); anotherShop.shop.id = "other-shop";
assert.equal(categoryGate(build(anotherShop)).decisions[0]!.reason, "product_category_unknown", "Lookup binds both authorized shop and product ID");
assert.equal(categoryGate(build(missing)).decisions[0]!.reason, "facts_unknown");
const ruleOnlyCategory = gateKnowledgeApplicability({ snapshot: categorySnapshot, context: null, scope: {}, candidates: [categorySource] });
assert.equal(ruleOnlyCategory.decisions[0]!.status, "not_checked"); assert.deepEqual(ruleOnlyCategory.candidates, [categorySource]);
const anotherDeclaredSource = { ...categorySource, id: "synthetic-other-source" };
const missingCategoryMetadata = validateKnowledgeApplicabilitySnapshot({ ...categoryManifest, documents: [{ sourceId: anotherDeclaredSource.id,
  scope: { shopId: null, productId: null }, sourceHash: knowledgeApplicabilitySourceHash(anotherDeclaredSource), basis: [], reviewNote: "另一篇完整审阅的合成来源。" }] });
assert.notEqual(missingCategoryMetadata.sha256, categorySnapshot.sha256, "Missing-metadata test uses a valid newly bound snapshot");
const missingRuleOnlyMetadata = gateKnowledgeApplicability({ snapshot: missingCategoryMetadata, context: null, scope: {}, candidates: [categorySource] });
assert.equal(missingRuleOnlyMetadata.status, "unavailable"); assert.equal(missingRuleOnlyMetadata.integrity, false);
assert.equal(missingRuleOnlyMetadata.reason, "metadata_binding_invalid"); assert.deepEqual(missingRuleOnlyMetadata.candidates, []);
assert.equal(gate([reference], null).decisions[0]!.status, "not_checked", "v1 reference-source rule-only exemption remains compatible");
const categoryTampered = structuredClone(categorySnapshot);
assert.ok(categoryTampered.version === 2); categoryTampered.productCatalog[0]!.categories = ["private"];
assert.equal(categoryGate(build(), categoryTampered).reason, "metadata_binding_invalid", "Changed catalog cannot reuse the old snapshot hash");
const categoryUnknownField = structuredClone(categoryManifest) as Record<string, unknown>; categoryUnknownField.allowUserClaim = true;
assert.throws(() => validateKnowledgeApplicabilitySnapshot(categoryUnknownField));
const duplicateProduct = structuredClone(categoryManifest); duplicateProduct.productCatalog.push(duplicateProduct.productCatalog[0]!);
assert.throws(() => validateKnowledgeApplicabilitySnapshot(duplicateProduct));
const duplicateCategory = structuredClone(categoryManifest); duplicateCategory.productCatalog[0]!.categories = ["regular_lunch", "regular_lunch"];
assert.throws(() => validateKnowledgeApplicabilitySnapshot(duplicateCategory));
const emptyCategories = structuredClone(categoryManifest); emptyCategories.documents[0]!.requiredProductCategories = [];
assert.throws(() => validateKnowledgeApplicabilitySnapshot(emptyCategories));
const categoryNoBasis = structuredClone(categoryManifest); categoryNoBasis.documents[0]!.basis = [];
assert.throws(() => validateKnowledgeApplicabilitySnapshot(categoryNoBasis));
const categoryNoQuote = structuredClone(categoryManifest); categoryNoQuote.documents[0]!.basis[0]!.quote = "原文未写的商品类别";
assert.equal(categoryGate(build(), validateKnowledgeApplicabilitySnapshot(categoryNoQuote)).reason, "metadata_binding_invalid");
assert.throws(() => validateKnowledgeApplicabilitySnapshot(categoryManifest, "0".repeat(64)), "v2 canonical content and declared hash must bind");
const versionOneCategory = { ...categoryManifest, version: 1 };
assert.throws(() => validateKnowledgeApplicabilitySnapshot(versionOneCategory), "v2 declarations cannot hide under historical v1");
for (const location of ["root", "rule", "catalog", "categories"] as const) for (const hidden of ["symbol", "nonenumerable", "prototype"] as const) {
  const changed = structuredClone(categoryManifest), object = location === "root" ? changed : location === "rule" ? changed.documents[0]!
    : location === "catalog" ? changed.productCatalog[0]! : changed.productCatalog[0]!.categories;
  if (hidden === "prototype") Object.setPrototypeOf(object, { allowUserClaim: true });
  else Object.defineProperty(object, hidden === "symbol" ? Symbol("allowUserClaim") : "allowUserClaim", { value: true, enumerable: hidden === "symbol" });
  assert.throws(() => validateKnowledgeApplicabilitySnapshot(changed), `v2 rejects ${location} ${hidden} data outside its hash`);
}
assert.equal(snapshot.version, 1); assert.equal(single.version, "declared-order-preconditions-v1", "Historical metadata and gate version remain unchanged");

// Explicit online-data v2 candidate: category assignments are the author's synthetic
// business definition, while exact SKU identity and every source retain old bytes.
const onlineV2Bytes = await readFile(new URL("data/knowledge-applicability-v2.json", root));
const onlineV2Manifest = JSON.parse(onlineV2Bytes.toString());
const onlineV2 = await loadKnowledgeApplicabilitySnapshot(2);
assert.equal(onlineV2.version, 2);
if (onlineV2.version !== 2) throw new Error("Explicit v2 loader did not return reviewed categories.");
assert.equal(onlineV2.sha256, hash(JSON.stringify(onlineV2Manifest)));
assert.equal(onlineV2.sourceSha256, hash(onlineV2Bytes), "v2 canonical content and raw-file provenance are distinct");
assert.notEqual(onlineV2.sha256, onlineV2.sourceSha256);
assert.equal(onlineV2.documents.length, 8);
assert.deepEqual(onlineV2.documents.map(rule => rule.sourceId), snapshot.documents.map(rule => rule.sourceId));
for (const document of documents) {
  const reviewedRule: KnowledgeApplicabilityRule = onlineV2.documents.find(entry => entry.sourceId === document.id)!;
  assert.equal(reviewedRule.sourceHash, knowledgeApplicabilitySourceHash(document));
  assert.deepEqual(reviewedRule.scope, { shopId: document.shopId, productId: document.productId ?? null });
  for (const basis of reviewedRule.basis) assert.ok(document.body.includes(basis.quote), `${document.id}: literal v2 basis`);
  if (document.id !== "KB-SHOP-DEMO-1") assert.deepEqual(reviewedRule, snapshot.documents.find(entry => entry.sourceId === document.id),
    "All seven non-shop declarations remain byte-equivalent JSON data");
}
const reviewedShop = onlineV2.documents.find(rule => rule.sourceId === "KB-SHOP-DEMO-1")!;
assert.deepEqual(reviewedShop.requiredProductCategories, ["regular_lunch", "regular_dinner"]);
assert.deepEqual(reviewedShop.basis, [{ field: "requiredProductCategories", quote: "常规午餐与晚餐套餐允许普通周末使用" }]);
const priorShop = snapshot.documents.find(rule => rule.sourceId === reviewedShop.sourceId)!;
const { requiredProductCategories: _newCategories, reviewNote: _newReview, basis: _newBasis, ...reviewedShopBinding } = reviewedShop;
const { reviewNote: _oldReview, basis: _oldBasis, ...priorShopBinding } = priorShop;
assert.deepEqual(reviewedShopBinding, priorShopBinding, "Adding a necessary category never rewrites shop source/scope or prior predicates");
assert.deepEqual(onlineV2.productCatalog.map(({ shopId, productId, productName, categories }) => ({ shopId, productId, productName, categories })), [
  { shopId: "shop-demo-1", productId: "product-demo-1", productName: "双人午餐团购券", categories: ["regular_lunch"] },
  { shopId: "shop-demo-1", productId: "product-demo-2", productName: "单人晚餐团购券", categories: ["regular_dinner"] },
]);
const v1FileBytes = await readFile(new URL("data/knowledge-applicability.json", root));
for (const product of onlineV2.productCatalog) {
  assert.ok(seedBytes.toString().includes(`('${product.productId}', '${product.shopId}', '${product.productName}',`),
    "Catalog identity is exactly present in the immutable seed, without a name-similarity lookup");
  assert.ok(product.reviewNote.includes("作者赋类") && product.reviewNote.includes("没有精确SKU") && product.reviewNote.includes("不是按名称相似度推断"));
  for (const bytes of [seedBytes, onlineBytes, v1FileBytes]) assert.ok(product.reviewNote.includes(hash(bytes)), "Review note binds every provenance file");
}
assert.ok(!onlineV2.productCatalog.some(product => product.productId === "product-demo-3"), "Unreviewed private SKU remains unknown, not an invented known mismatch");
assert.ok(Object.isFrozen(onlineV2.productCatalog) && Object.isFrozen(onlineV2.productCatalog[0]!.categories));
const defaultAgain = await loadKnowledgeApplicabilitySnapshot();
assert.equal(defaultAgain.version, 1); assert.equal(defaultAgain.sha256, hash(v1FileBytes));
assert.deepEqual(defaultAgain.documents, snapshot.documents, "Explicit v2 reads do not change the installed historical default");
console.log("Knowledge applicability checks passed: 8 unchanged v1 sources; opted-in v2 reviews 8 sources and 2 exact seed products with author-assigned categories; unknown/mismatch, content binding, strict JSON, identity/scope/inventory, no-refill and rule-only guards; 0 API calls.");
