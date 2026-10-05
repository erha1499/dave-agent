import assert from "node:assert/strict";
import { rankKnowledge } from "../src/knowledge-retrieval.ts";
import { rankBm25, rankDense, rankLexical, reciprocalRankFusion, scopeDocuments, serializeRetrievalDocument,
  type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { loadRetrievalData } from "./retrieval-data.ts";

const doc = (id: string, body = "alpha", scope: Partial<RetrievalDocument> = {}): RetrievalDocument =>
  ({ id, title: "", body, tags: [], shopId: null, ...scope });
const documents = [doc("public"), doc("shop", "alpha", { shopId: "shop_a" }),
  doc("product", "alpha", { shopId: "shop_a", productId: "product_a" }),
  doc("other-product", "alpha", { shopId: "shop_a", productId: "product_b" }),
  doc("other-shop", "alpha", { shopId: "shop_b" }), doc("inactive", "alpha", { status: "inactive" })];
const original = structuredClone(documents), ids = (rows: { id: string }[]) => rows.map(row => row.id);
assert.deepEqual(ids(scopeDocuments(documents, {})), ["public"]);
assert.deepEqual(ids(scopeDocuments(documents, { shopId: "shop_a" })), ["public", "shop"]);
assert.deepEqual(ids(scopeDocuments(documents, { shopId: "shop_a", productId: "product_a" })), ["product", "public", "shop"]);
assert.deepEqual(ids(scopeDocuments(documents, { shopId: "missing" })), ["public"]);
assert.throws(() => scopeDocuments(documents, { productId: "product_a" }));
assert.throws(() => scopeDocuments(documents, { shopId: "" }));
assert.throws(() => scopeDocuments([...documents, documents[0]!], {}));
assert.throws(() => scopeDocuments([doc("bad", "", { productId: "product_a" })], {}));
assert.throws(() => scopeDocuments([doc("bad", "", { status: "expired" as "active" })], {}));
assert.deepEqual(rankLexical("alpha", documents, {}), ["public"]);
assert.deepEqual(ids(rankBm25("alpha", documents, {})), ["public"]);
assert.deepEqual(rankBm25("unmatched", documents, {}), []);
assert.deepEqual(rankBm25("这个套餐可以使用吗", documents, {}), []);

// Closed-form BM25 oracle: two equal-length documents, one term appears in just one document.
const bm25 = rankBm25("alpha", [doc("A", "alpha beta"), doc("B", "gamma delta")], {});
assert.deepEqual(ids(bm25), ["A"]);
assert.ok(Math.abs(bm25[0]!.score - Math.log(2)) < 1e-12);
assert.deepEqual(ids(rankBm25("alpha", [doc("long", "alpha beta gamma delta"), doc("short", "alpha")], {})), ["short", "long"]);
assert.deepEqual(ids(rankBm25("alpha", [doc("once", "alpha beta"), doc("twice", "alpha alpha")], {})), ["twice", "once"]);
assert.deepEqual(rankBm25("alpha alpha", documents, {}), rankBm25("alpha", documents, {}), "query terms are not spuriously boosted");
assert.deepEqual(ids(rankBm25("alpha", [doc("B"), doc("A")], {})), ["A", "B"]);
assert.deepEqual(rankBm25("alpha", [...documents].reverse(), {}), rankBm25("alpha", documents, {}));
assert.deepEqual(rankBm25("alpha", documents, {}), rankBm25("alpha", [documents[0]!], {}), "hidden documents cannot change IDF/length normalization");
for (const [query, document] of [
  ["未使用可以退费吗", doc("synonym", "未核销退款")],
  ["abc", doc("nfkc", "ＡＢＣ")],
  ["开票", doc("tag", "", { tags: ["开票"] })],
  ["到账", doc("canonical", "到账")],
] as const) assert.deepEqual(ids(rankBm25(query, [document], {})), [document.id]);
assert.deepEqual(rankBm25("退款", [doc("duplicate", "", { tags: ["退款", "退款"] })], {}),
  rankBm25("退款", [doc("duplicate", "", { tags: ["退款"] })], {}));
assert.deepEqual(rankBm25("alpha", [], {}), []);

const vectors = new Map<string, readonly number[]>([["public", [1, 0]], ["shop", [0, 1]], ["product", [-1, 0]], ["inactive", [Number.NaN]]]);
assert.deepEqual(rankDense([1, 0], documents, vectors, { shopId: "shop_a", productId: "product_a" }),
  [{ id: "public", score: 1 }, { id: "shop", score: 0 }, { id: "product", score: -1 }]);
assert.deepEqual(rankDense([1e308, 0], [doc("public")], new Map([["public", [1e-300, 0]]]), {}), [{ id: "public", score: 1 }]);
assert.deepEqual(ids(rankDense([1, 1], [doc("B"), doc("A")], new Map([["B", [1, 0]], ["A", [0, 1]]]), {})), ["A", "B"]);
assert.throws(() => rankDense([0, 0], documents, vectors, {}));
assert.throws(() => rankDense([Number.NaN, 0], documents, vectors, {}));
assert.throws(() => rankDense([1], documents, vectors, {}));
assert.throws(() => rankDense([1, 0], documents, new Map(), {}));
assert.throws(() => rankDense([1, 0], [doc("public")], new Map([["public", [0, 0]]]), {}));
assert.throws(() => rankDense([1, 0], [doc("public")], new Map([["public", [Infinity, 0]]]), {}));
assert.deepEqual(rankDense([], [], new Map(), {}), [], "no visible documents requires no query vector");

const a = [{ id: "A", score: 100 }, { id: "B", score: 3 }];
const b = [{ id: "B", score: 0.9 }, { id: "C", score: -0.1 }];
const fused = reciprocalRankFusion([a, b]);
assert.deepEqual(ids(fused), ["B", "A", "C"]);
assert.equal(fused[0]!.score, 1 / 61 + 1 / 62);
assert.deepEqual(reciprocalRankFusion([a, b]), reciprocalRankFusion([a.map(item => ({ ...item, score: item.score * 100 })), b]));
assert.deepEqual(ids(reciprocalRankFusion([[{ id: "B", score: 1 }], [{ id: "A", score: 10 }]])), ["A", "B"]);
assert.equal(reciprocalRankFusion([Array.from({ length: 21 }, (_, i) => ({ id: `A${i}`, score: 21 - i }))]).length, 20);
assert.throws(() => reciprocalRankFusion([[a[0]!, a[0]!]]));
assert.throws(() => reciprocalRankFusion([[{ id: "A", score: Number.NaN }]]));
assert.deepEqual(reciprocalRankFusion([]), []);
assert.deepEqual(documents, original, "scope and rankings cannot mutate source evidence");
const literal = doc("ignored-id", "正文\n\"原文\"", { title: "标题", tags: ["退费", "ＡＢＣ"], shopId: "private" });
assert.equal(serializeRetrievalDocument(literal), '{"title":"标题","tags":["退费","ＡＢＣ"],"body":"正文\\n\\\"原文\\\""}');

// Batch parity keeps M0 unchanged for every existing full/selected question and explicit scope.
const data = await loadRetrievalData(), selected = new Set(data.selectedIds);
let parityChecks = 0;
for (const corpus of [data.documents, data.documents.filter(document => selected.has(document.id))]) {
  for (const question of data.questions.filter(question => question.relevant.every(id => corpus.some(document => document.id === id)))) {
    const scope = { shopId: question.shopId }, visible = scopeDocuments(corpus, scope);
    assert.deepEqual(rankLexical(question.query, corpus, scope), ids(rankKnowledge(question.query, visible)), question.id);
    const result = rankBm25(question.query, corpus, scope);
    assert.equal(new Set(ids(result)).size, result.length);
    assert.ok(result.every(item => item.score > 0 && Number.isFinite(item.score) && visible.some(document => document.id === item.id)));
    parityChecks++;
  }
}
assert.equal(parityChecks, 282);
console.log(`PASS retrieval v2 ranking: ${parityChecks} M0 parity/scoped BM25 cases; closed-form BM25, cosine, RRF, serialization and invalid-input checks.`);
