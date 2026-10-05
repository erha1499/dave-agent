import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAcceptanceDataset, validateAcceptanceQuestions, type AcceptanceQuestion, type AcceptanceSplit } from "./acceptance-data.ts";
import { scopeDocuments, type RetrievalDocument } from "../src/retrieval-ranking.ts";

const datasets = await Promise.all((["development", "validation"] as const).map(loadAcceptanceDataset));
for (const [index, split] of (["development", "validation"] as const).entries()) {
  const data = datasets[index]!;
  assert.deepEqual(data.corpora.map(c => c.id), ["online", "reference"]);
  assert.deepEqual(data.corpora.map(c => c.documents.length), [9, 36], "8/35 frozen policies plus one inactive fixture per corpus");
  assert.equal(data.corpora.reduce((n, c) => n + c.questions.length, 0), split === "development" ? 48 : 60);
  for (const corpus of data.corpora) {
    assert.equal(corpus.documents.filter(doc => doc.status === "inactive").length, 1);
    for (const question of corpus.questions as AcceptanceQuestion[]) {
      const visible = scopeDocuments(corpus.documents, question);
      assert.ok(question.goldRationale.trim().length >= 10, question.id);
      for (const evidence of question.evidence) {
        assert.ok(visible.find(doc => doc.id === evidence.docId)?.body.includes(evidence.quote), question.id);
      }
      if (question.suite === "no_answer") {
        assert.equal(question.relevant.length, 0);
        assert.ok(question.relatedButInsufficient?.length, "negative has a reviewable near-miss policy, not only an unrelated query");
      }
    }
  }
}

const validation = datasets[1]!;
const docs = Object.fromEntries(validation.corpora.map(c => [c.id, c.documents])) as Record<"online" | "reference", RetrievalDocument[]>;
const payload = JSON.parse(await readFile(new URL("../data/acceptance-validation.json", import.meta.url), "utf8"));
function rejected(mutate: (value: typeof payload) => void, pattern: RegExp) {
  const edited = structuredClone(payload); mutate(edited);
  assert.throws(() => validateAcceptanceQuestions(edited, "validation", docs), pattern);
}
rejected(value => { value.questions[0].relevant = ["SH002"]; }, /跨语料/);
rejected(value => { value.questions[0].evidence[0].quote = "退款后额外补偿十倍金额"; }, /引文/);
rejected(value => { value.questions[0].evidence = []; }, /每个 gold/);
rejected(value => { value.questions[0].shopId = null; value.questions[0].productId = "product-demo-1"; }, /product requires/);
rejected(value => {
  const question = value.questions.find((row: { id: string }) => row.id === "a1-val-007");
  assert.ok(question); assert.equal(question.shopId, "shop-demo-1"); assert.equal(question.productId, "product-demo-1");
  question.productId = "product-demo-2";
}, /gold 不可见/);
rejected(value => { value.questions[30].relatedButInsufficient = []; }, /近似政策/);
rejected(value => { value.questions[42].forbidden = ["KB-REFUND-UNUSED"]; }, /不可见干扰/);
rejected(value => { value.questions[42].scopeCategory = "inactive"; }, /缺少 inactive/);
rejected(value => { value.questions[54].deferredReason = undefined; }, /C1/);
rejected(value => { value.questions[54].suite = "no_answer"; }, /冲突|近似政策/);
rejected(value => { value.questions.pop(); }, /数量/);
rejected(value => { value.questions[1].query = value.questions[0].query; }, /重复问题/);
rejected(value => { value.questions[0].acceptAll = true; }, /题目/);
await assert.rejects(() => loadAcceptanceDataset("unknown" as AcceptanceSplit), /split/);

const contexts = validation.corpora.flatMap(c => c.questions).filter(q => q.suite === "context");
assert.equal(contexts.length, 6, "deferred C1 cases remain visible in the full dataset");
assert.ok(contexts.every(q => q.deferredReason === "C1" && q.relevant.length === 0));
// Conflicting upstream and online expired-coupon policy must stay in separate corpora.
assert.ok(docs.online.find(doc => doc.id === "KB-REFUND-EXPIRED")!.body.includes("未提供过期自动退款"));
assert.ok(docs.reference.find(doc => doc.id === "RF001")!.body.includes("同样支持过期退"));
assert.ok(!docs.online.some(doc => doc.id === "RF001"));
const allQueries = datasets.flatMap(data => data.corpora.flatMap(c => c.questions.map(q => `${c.id}:${q.query.trim()}`)));
assert.equal(new Set(allQueries).size, 108);
console.log("A1 data checks passed: 48 development + 60 fixed validation, 8/35 separate policies, exact gold quotations, scope/retired fixtures, freeze hashes and six C1 cases; no model calls.");
