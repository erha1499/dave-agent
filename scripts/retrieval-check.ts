import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rankKnowledge } from "../src/knowledge-retrieval.ts";
import { loadRetrievalData, validateRetrievalData, type RetrievalQuestion } from "./retrieval-data.ts";
import { evaluateBoundaries, evaluateCorpus, retrieve, scoreQuestion, summarize } from "./retrieval-baseline.ts";

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
assert.deepEqual(rankKnowledge("退款到账 abc", documents).map(d => d.id), ["C", "A", "B", "D"]);
assert.deepEqual(documents, original, "ranking must not mutate inputs");
assert.deepEqual(rankKnowledge("无匹配", documents), []);
assert.deepEqual(rankKnowledge("标题独有词", [{ id: "F", tags: ["别的"], title: "标题独有词" }]), [], "preserve tags-only baseline");
const question: RetrievalQuestion = { id: "synthetic", suite: "standard", query: "退款", relevant: ["A", "F"], shopId: null };
const sixth = scoreQuestion(question, ["A", "B", "C", "D", "E", "F"]);
assert.equal(sixth.recallAt1, .5); assert.equal(sixth.recallAt5, .5); assert.equal(sixth.reciprocalRank, 1);
const late = scoreQuestion({ ...question, relevant: ["F"] }, ["A", "B", "C", "D", "E", "F"]);
assert.equal(late.reciprocalRank, 1 / 6); assert.equal(late.reciprocalRankAt5, 0);
assert.equal(late.failure, "relevant_beyond_top5");
const miss = scoreQuestion(question, []);
assert.equal(miss.recallAt5, 0); assert.equal(miss.reciprocalRank, 0);
assert.equal(miss.failure, "no_tag_match");
assert.equal(scoreQuestion({ ...question, relevant: ["F"] }, ["A"]).failure, "relevant_not_retrieved");
assert.equal(summarize([sixth, miss]).recallAt5, .25, "macro-average per-question recall");
assert.equal(summarize([]).mrr, null, "empty slices are unknown, not zero");
assert.throws(() => scoreQuestion(question, ["A", "A"]));
assert.throws(() => evaluateCorpus("dangling", data.documents, [{ ...question, relevant: ["MISSING"] }]));

const scoped = retrieve(data.documents, { query: "暑期活动 停车", shopId: null });
assert.ok(scoped.every(doc => doc.shopId === null));
assert.ok(retrieve(data.documents, { query: "暑期活动", shopId: "shop_1001" }).some(doc => doc.id === "SH001"));
assert.ok(!retrieve(data.documents, { query: "暑期活动", shopId: "shop_other" }).some(doc => doc.id === "SH001"));
const boundaryData = JSON.parse(await readFile(new URL("../data/retrieval-boundaries.json", import.meta.url), "utf8"));
const boundaries = evaluateBoundaries(data.documents, boundaryData);
assert.equal(boundaries.scope.passed, boundaries.scope.questions);
assert.equal(boundaries.noAnswer.questions, 4);
assert.ok(boundaries.noAnswer.nonEmptyResponses > 0, "keep known no-answer failure cases visible");
assert.throws(() => evaluateBoundaries(data.documents, { ...boundaryData, scope: [{ ...boundaryData.scope[0], forbidden: ["MISSING"] }] }));
const full = evaluateCorpus("full", data.documents, data.questions);
assert.equal(full.cases.length, 212);
assert.equal(full.suites.standard!.questions + full.suites.hard!.questions, 212);
assert.equal(Object.values(full.hardKinds).reduce((n, item) => n + item.questions, 0), 76);
assert.ok(full.suites.hard!.top5MissCount > 0, "a baseline reports failures; it must not silently drop them");
console.log("PASS 检索数据与基线：固定来源、35/212完整标签、11/70子集、ctx保留、畸形/跨范围拒绝、共享排序、Recall/MRR分母及截断、未知与范围边界、失败样例保留。");
