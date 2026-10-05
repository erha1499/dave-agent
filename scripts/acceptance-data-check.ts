import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadAcceptanceDataset, validateAcceptanceQuestions, type AcceptanceQuestion, type AcceptanceSplit } from "./acceptance-data.ts";
import { scopeDocuments, type RetrievalDocument } from "../src/retrieval-ranking.ts";

const splits = ["development", "validation", "support-validation"] as const;
const datasets = await Promise.all(splits.map(loadAcceptanceDataset));
for (const [index, split] of splits.entries()) {
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
assert.equal(new Set(allQueries).size, 168);
const freshPayload = JSON.parse(await readFile(new URL("../data/acceptance-support-validation.json", import.meta.url), "utf8"));
const fresh = datasets[2]!.corpora.flatMap(c => c.questions);
assert.deepEqual(["standard", "no_answer", "scope", "context"].map(suite => fresh.filter(q => q.suite === suite).length), [30, 18, 12, 0]);
assert.ok(fresh.every(q => q.deferredReason === undefined));
assert.deepEqual(fresh.find(q => q.id === "a1-sup-010")?.relevant, ["KB-PRODUCT-LUNCH", "KB-REFUND-PAYMENT"], "both independent price/payment boundary documents are gold");
assert.deepEqual(fresh.find(q => q.id === "a1-sup-022")?.relevant, ["CY003", "MC001"], "both independent real-time merchant capability policies are gold");
assert.deepEqual(fresh.find(q => q.id === "a1-sup-008")?.relevant, ["KB-SHOP-DEMO-1"], "explicitly documented absence of policy is an answer to a policy-availability question");
const missingQuote = structuredClone(freshPayload); missingQuote.questions.find((q: { id: string }) => q.id === "a1-sup-010").evidence.pop();
assert.throws(() => validateAcceptanceQuestions(missingQuote, "support-validation", docs), /每个 gold/);
const deferred = structuredClone(freshPayload); deferred.questions[0].deferredReason = "C1";
assert.throws(() => validateAcceptanceQuestions(deferred, "support-validation", docs), /普通题不得延后/);
assert.throws(() => validateAcceptanceQuestions(freshPayload, "validation", docs), /split/);
console.log("A1 data checks passed: 48 development + 60 original fixed validation + 60 fresh fact-support validation; frozen 8/35 policies, scope fixtures, complete gold quotations, unchanged old split hashes and six original C1 cases; no model calls.");
