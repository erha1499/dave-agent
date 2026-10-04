import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { rankKnowledge, rankKnowledgeBaseline } from "../src/knowledge-retrieval.ts";
import { loadRetrievalData, validateRetrievalData, type KnowledgeDocument, type RetrievalQuestion } from "./retrieval-data.ts";
import { compareCorpora, evaluateBoundaries, evaluateCorpus, retrieve, scoreQuestion, summarize } from "./retrieval-baseline.ts";

const data = await loadRetrievalData();
assert.equal(data.documents.length, 35);
assert.equal(data.questions.filter(q => q.suite === "standard").length, 136);
assert.equal(data.questions.filter(q => q.suite === "hard").length, 76);
assert.equal(data.selectedIds.length, 11);
const selected = new Set(data.selectedIds);
const selectedQuestions = data.questions.filter(q => q.relevant.every(id => selected.has(id)));
assert.equal(selectedQuestions.filter(q => q.suite === "standard").length, 44);
assert.equal(selectedQuestions.filter(q => q.suite === "hard").length, 26);
assert.equal(data.questions.filter(q => q.context?.verified === false).length, 11);
assert.equal(data.questions.filter(q => q.context?.verified === true).length, 10);

const folder = new URL("../data/reference/kefu-harness/", import.meta.url);
const jsonl = async (path: string) => (await readFile(new URL(path, folder), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const [docs, standard, hard] = await Promise.all([
  jsonl("data/knowledge/docs.jsonl"), jsonl("data/evalsets/retrieval.jsonl"), jsonl("data/evalsets/retrieval_hard.jsonl"),
]);
const validate = (d = docs, s = standard, h = hard, ids = data.selectedIds) => validateRetrievalData(d, s, h, ids);
assert.throws(() => validate([...docs, docs[0]]), "duplicate document IDs");
assert.throws(() => validate(docs.slice(1)), "dangling labels");
assert.throws(() => validate(docs, [...standard, standard[0]]), "duplicate questions");
assert.throws(() => validate(docs, [{ ...standard[0], relevant: [] }, ...standard.slice(1)]), "empty labels");
assert.throws(() => validate(docs, [{ ...standard[0], relevant: [standard[0].relevant[0], standard[0].relevant[0]] }, ...standard.slice(1)]), "duplicate labels");
assert.throws(() => validate([{ ...docs[0], tags: [1] }, ...docs.slice(1)]), "invalid tag type");
assert.throws(() => validate(docs, standard, [{ ...hard[0], ctx: { verified: "false" } }, ...hard.slice(1)]), "invalid ctx type");
assert.throws(() => validate(docs, standard, hard, [...data.selectedIds, "MISSING"]), "unknown selection");
assert.throws(() => validate(docs, standard, hard, [...data.selectedIds, data.selectedIds[0]!]), "duplicate selection");
assert.throws(() => validate(docs, [...standard, { industry: "餐饮", query: "合成跨店范围反例", shop_id: "shop_other", relevant: ["SH001"] }]), "cross-shop gold");
assert.throws(() => validate(docs, [...standard, { industry: "餐饮", query: "合成缺失门店反例", shop_id: null, relevant: ["SH001"] }]), "missing shop scope");

const documents = [
  { id: "B", tags: ["退款"], title: "无关" },
  { id: "C", tags: ["退款", "到账"] },
  { id: "A", tags: ["退款"] },
  { id: "D", tags: ["ABC"] },
  { id: "E", tags: [""], title: "退款到账" },
];
const original = structuredClone(documents);
assert.deepEqual(rankKnowledgeBaseline("退款到账 abc", documents).map(d => d.id), ["C", "A", "B", "D"]);
rankKnowledge("退款到账 abc", documents);
assert.deepEqual(documents, original, "ranking must not mutate inputs");
for (const rank of [rankKnowledgeBaseline, rankKnowledge]) assert.deepEqual(rank("无匹配", documents), []);
assert.deepEqual(rankKnowledgeBaseline("标题独有词", [{ id: "F", tags: ["别的"], title: "标题独有词" }]), [], "preserve tags-only baseline");
assert.deepEqual(rankKnowledge("健身", [{ id: "F", tags: [], title: "健身" }]).map(doc => doc.id), ["F"]);
assert.deepEqual(rankKnowledge("停车", [{ id: "G", tags: [], body: "免费停车" }]).map(doc => doc.id), ["G"]);
const fullWidth = { id: "latin", tags: ["ＡＢＣ"] };
assert.equal(rankKnowledge("abc", [fullWidth])[0], fullWidth, "NFKC and case normalization preserve the source object");
assert.deepEqual(rankKnowledgeBaseline("abc", [fullWidth]), [], "baseline must not acquire NFKC normalization");
const refundDocument = { id: "refund", tags: ["未核销", "退款"], title: "未核销退款", body: "需要商家审批，不代表已经退款。" };
const originalRefund = structuredClone(refundDocument);
assert.equal(rankKnowledge("未使用可以退费吗", [refundDocument])[0], refundDocument, "synonyms retrieve existing evidence rather than rewrite it");
assert.deepEqual(refundDocument, originalRefund);
assert.deepEqual(rankKnowledge("这个套餐可以使用吗", [refundDocument, { id: "generic", tags: ["套餐"], body: "这个套餐可以使用" }]), [], "generic terms alone do not retrieve documents");
const duplicateTags = [{ id: "A", tags: ["退款"] }, { id: "B", tags: ["退款", "退款"] }];
const originalDuplicates = structuredClone(duplicateTags);
assert.deepEqual(rankKnowledge("退款", duplicateTags).map(doc => doc.id), ["A", "B"], "duplicate tags must not increase current ranking");
assert.deepEqual(rankKnowledgeBaseline("退款", duplicateTags).map(doc => doc.id), ["B", "A"], "baseline preserves its original duplicate-tag scoring");
assert.deepEqual(duplicateTags, originalDuplicates);
assert.deepEqual(rankKnowledge("开票", [{ id: "invoice", tags: ["开票"] }]).map(doc => doc.id), ["invoice"], "preserve domain tags even when ICU splits them");

const validationBytes = await readFile(new URL("../data/retrieval-validation.json", import.meta.url));
const validation = JSON.parse(validationBytes.toString("utf8")) as {
  source: string; canonicalTerms: string[]; documents: KnowledgeDocument[];
  cases: { id: string; query: string; shopId: string | null; required: string[]; forbidden: string[]; empty?: boolean; baselineEmpty?: boolean }[];
};
assert.equal(validation.documents.length, 5);
assert.equal(new Set(validation.documents.map(doc => doc.id)).size, validation.documents.length);
assert.equal(validation.cases.length, 8);
assert.ok(validation.documents.every(doc => doc.tags.length === 0), "new title/body cases must not be rescued by tags");
const originalValidation = structuredClone(validation.documents);
const validationResults = evaluateBoundaries(validation.documents, {
  source: validation.source,
  noAnswer: validation.cases.filter(item => item.empty).map(item => ({ ...item, reason: "原创小语料不含该事实。" })),
  scope: validation.cases.filter(item => !item.empty),
});
assert.equal(validationResults.noAnswer.questions, 1);
assert.equal(validationResults.noAnswer.emptyResponses, 1);
assert.equal(validationResults.scope.passed, validationResults.scope.questions,
  JSON.stringify(validationResults.scope.cases.filter(item => !item.passed)));
for (const item of validation.cases) {
  if (item.baselineEmpty) assert.deepEqual(retrieve(validation.documents, item, "baseline"), [], `${item.id}: preserve the known tags-only miss`);
  assert.ok(retrieve(validation.documents, item).every(doc => validation.documents.includes(doc)), `${item.id}: return original evidence objects`);
}
assert.deepEqual(validation.documents, originalValidation, "do not rewrite fixture evidence");
assert.equal(validation.canonicalTerms.length, 9);
assert.equal(new Set(validation.canonicalTerms).size, 9);
for (const word of validation.canonicalTerms) for (const field of ["title", "body"] as const) {
  const document = { id: `${field}-${word}`, tags: [], [field]: word };
  assert.equal(rankKnowledge(word, [document])[0], document, `${word}: retain canonical terms in ${field} without tags`);
}
console.log(`PASS 预先固定新问法验证（非盲测）：8/8 问法，18/18 canonical 工程检查；SHA256 ${createHash("sha256").update(validationBytes).digest("hex")}`);

const question: RetrievalQuestion = { id: "synthetic", suite: "standard", query: "退款", relevant: ["A", "F"], shopId: null };
const sixth = scoreQuestion(question, ["A", "B", "C", "D", "E", "F"]);
assert.equal(sixth.recallAt1, .5); assert.equal(sixth.recallAt5, .5); assert.equal(sixth.reciprocalRank, 1);
const late = scoreQuestion({ ...question, relevant: ["F"] }, ["A", "B", "C", "D", "E", "F"]);
assert.equal(late.reciprocalRank, 1 / 6); assert.equal(late.reciprocalRankAt5, 0);
assert.equal(late.failure, "relevant_beyond_top5");
const miss = scoreQuestion(question, []);
assert.equal(miss.recallAt5, 0); assert.equal(miss.reciprocalRank, 0);
assert.equal(miss.failure, "no_match");
assert.equal(scoreQuestion({ ...question, relevant: ["F"] }, ["A"]).failure, "relevant_not_retrieved");
assert.equal(summarize([sixth, miss]).recallAt5, .25, "macro-average per-question recall");
assert.equal(summarize([]).mrr, null, "empty slices are unknown, not zero");
assert.throws(() => scoreQuestion(question, ["A", "A"]));
assert.throws(() => evaluateCorpus("dangling", data.documents, [{ ...question, relevant: ["MISSING"] }]));

const boundaryData = JSON.parse(await readFile(new URL("../data/retrieval-boundaries.json", import.meta.url), "utf8"));
const fullRuns = (["baseline", "current"] as const).map(algorithm => {
  assert.ok(retrieve(data.documents, { query: "暑期活动 停车", shopId: null }, algorithm).every(doc => doc.shopId === null));
  assert.ok(retrieve(data.documents, { query: "暑期活动", shopId: "shop_1001" }, algorithm).some(doc => doc.id === "SH001"));
  assert.ok(!retrieve(data.documents, { query: "暑期活动", shopId: "shop_other" }, algorithm).some(doc => doc.id === "SH001"));
  const poisonedContext = { ...data.questions[0]!, industry: "酒旅", context: { industry: "丽人", sku_name: "美容", verified: true }, relevant: ["LR001"] };
  assert.deepEqual(retrieve(data.documents, poisonedContext, algorithm), retrieve(data.documents, data.questions[0]!, algorithm), "ctx/industry/gold must not alter retrieval inputs");
  const boundaries = evaluateBoundaries(data.documents, boundaryData, algorithm);
  assert.equal(boundaries.scope.passed, boundaries.scope.questions);
  assert.equal(boundaries.noAnswer.questions, 4);
  assert.equal(boundaries.noAnswer.emptyResponses + boundaries.noAnswer.nonEmptyResponses, 4, "retain every no-answer result without imposing a quality outcome");
  assert.throws(() => evaluateBoundaries(data.documents, { ...boundaryData, scope: [{ ...boundaryData.scope[0], forbidden: ["MISSING"] }] }, algorithm));
  const full = evaluateCorpus("full", data.documents, data.questions, algorithm);
  assert.equal(full.cases.length, 212);
  assert.equal(full.suites.standard!.questions + full.suites.hard!.questions, 212);
  assert.equal(Object.values(full.hardKinds).reduce((n, item) => n + item.questions, 0), 76);
  const subset = evaluateCorpus("selected", data.documents.filter(doc => selected.has(doc.id)), selectedQuestions, algorithm);
  assert.equal(subset.cases.length, 70);
  assert.equal(subset.suites.standard!.questions, 44);
  assert.equal(subset.suites.hard!.questions, 26);
  return full;
});
assert.equal(fullRuns[0]!.suites.standard!.recallAt5, 76 / 136, "original full tags-only baseline anchor");
assert.equal(fullRuns[0]!.suites.hard!.recallAt5, 9 / 76, "original hard tags-only baseline anchor");
const comparison = compareCorpora(fullRuns[0]!, fullRuns[1]!);
assert.equal(comparison.cases.length, 212);
for (const suite of Object.values(comparison.suites)) assert.equal(suite.improved + suite.regressed + suite.unchanged, suite.questions);
const comparisonFixture = (ranks: string[][]) => {
  const cases = ranks.map((rank, i) => scoreQuestion({ ...question, id: String(i), relevant: ["A"] }, rank));
  return { ...evaluateCorpus("synthetic", [], []), cases, suites: { standard: summarize(cases), hard: summarize([]) } };
};
const before = comparisonFixture([["B", "A"], ["A"], []]);
const after = comparisonFixture([["A"], ["B", "A"], []]);
const changes = compareCorpora(before, after);
assert.deepEqual(changes.cases.map(item => item.status), ["improved", "regressed", "unchanged"]);
assert.equal(changes.cases[0]!.delta.mrr, .5);
assert.equal(changes.cases[1]!.delta.mrr, -.5);
assert.equal(changes.suites.hard!.delta.mrr, null, "empty comparison slices stay unknown");
assert.equal(compareCorpora(before, { ...after, cases: [...after.cases].reverse() }).cases[0]!.id, "2", "align comparisons by stable question ID");
assert.throws(() => compareCorpora(before, { ...after, cases: after.cases.slice(1) }), "refuse different question sets");
assert.throws(() => compareCorpora(before, { ...after, cases: after.cases.map(item => ({ ...item, relevant: ["B"] })) }), "refuse changed gold");
assert.throws(() => compareCorpora(before, { ...after, cases: after.cases.map(item => ({ ...item, context: { verified: false } })) }), "refuse changed ctx");
console.log("PASS 检索数据与对比：固定来源、35/212完整标签、11/70子集、ctx保留、畸形/跨范围拒绝、两算法同题同范围、旧基线锚点、Recall/MRR分母及截断、独立边界、逐题改善/退步与输入一致性。");
