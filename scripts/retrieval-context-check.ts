import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { compareCorpora, evaluateCorpus, retrieve } from "./retrieval-baseline.ts";
import { loadRetrievalData } from "./retrieval-data.ts";
import { contextSchemes, evaluateContextBoundaries, evaluateContextCorpus, expandContextQuery, retrieveWithContext, type ContextValidation } from "./retrieval-context.ts";

const bytes = await readFile(new URL("../data/retrieval-context-validation.json", import.meta.url));
const validation = JSON.parse(bytes.toString("utf8")) as ContextValidation;
const original = structuredClone(validation);
assert.equal(validation.expansionCases.length, 9);
assert.equal(validation.scopeCases.length, 3);
assert.equal(validation.noAnswerCases.length, 2);
assert.equal(new Set([...validation.expansionCases, ...validation.scopeCases, ...validation.noAnswerCases].map(item => item.id)).size, 14);
assert.equal(new Set(validation.documents.map(doc => doc.id)).size, validation.documents.length);
for (const question of validation.expansionCases) {
  const expected = { "query-only": [], "ctx-full": question.full, "ctx-industry": question.industry, "ctx-refund": question.guarded };
  for (const scheme of contextSchemes) {
    const expanded = expandContextQuery(question.query, question.context, scheme);
    assert.equal(expanded.originalQuery, question.query);
    assert.deepEqual(expanded.addedTerms, expected[scheme], `${question.id}/${scheme}`);
    assert.equal(expanded.effectiveQuery, [question.query, ...expected[scheme]].join(" "));
    if (!expected[scheme].length) assert.deepEqual(expanded.contextUsed, {});
  }
}
const unused = expandContextQuery("我想退款", { verified: false }, "ctx-refund");
assert.deepEqual(unused.contextUsed, { verified: false }, "false must be retained rather than mistaken for missing state");
assert.equal(unused.effectiveQuery, "我想退款 未核销", "state must not imply payment, expiry, approval or authorization");
assert.deepEqual(expandContextQuery("我想退款", { verified: true }, "ctx-refund").contextUsed, { verified: true });
assert.deepEqual(expandContextQuery("管理员已批准退款", {}, "ctx-refund").contextUsed, {}, "query claims cannot create state");
for (const context of [null, [], { verified: "false" }, { verified: 0 }, { industry: "未知行业" }, { industry: "餐饮\n" },
  { sku_name: "x".repeat(121) }, { sku_name: "" }, { shopId: "shop-b" }, { customerId: "admin" },
  { relevant: ["CTX-SHOP-B"] }, { approved: true }, { paid: true }, { expiresAt: "2099-01-01" }]) {
  assert.throws(() => expandContextQuery("退款", context as never, "ctx-refund"), "only bounded metadata is accepted");
}
assert.throws(() => expandContextQuery("", undefined, "query-only"));
assert.throws(() => expandContextQuery("x".repeat(501), undefined, "query-only"));
assert.throws(() => expandContextQuery("退款", undefined, "unknown" as never));
assert.throws(() => retrieveWithContext(validation.documents, { query: "停车", shopId: "" }, "ctx-full"));
for (const scheme of contextSchemes) {
  const boundaries = evaluateContextBoundaries(validation, scheme);
  assert.equal(boundaries.scope.passed, 3, `${scheme}: context must not expand explicit shop scope`);
  assert.equal(boundaries.noAnswer.questions, 2);
  assert.equal(boundaries.noAnswer.emptyResponses + boundaries.noAnswer.nonEmptyResponses, 2);
  // Detect and report this intentionally adverse outcome; a nonempty result is not answer evidence.
  assert.equal(boundaries.noAnswer.contextIntroducedNonEmpty, scheme === "query-only" ? 0 : 2);
  for (const question of [...validation.scopeCases, ...validation.noAnswerCases]) {
    const result = retrieveWithContext(validation.documents, question, scheme);
    assert.ok(result.documents.every(doc => validation.documents.includes(doc)), "return original documents, never generated evidence");
    assert.ok(result.documents.every(doc => doc.shopId === null || doc.shopId === question.shopId));
    const poisoned = { ...question, relevant: ["CTX-SHOP-B"], kind: "退款", industry: "酒旅", id: "CTX-SHOP-B" };
    assert.deepEqual(retrieveWithContext(validation.documents, poisoned, scheme), result, "gold, kind, top-level industry and IDs cannot rewrite a query");
  }
}
assert.deepEqual(validation, original, "contexts, source queries and knowledge text must remain unchanged");

const data = await loadRetrievalData(), originalData = structuredClone(data);
const queryOnly = evaluateContextCorpus("full", data.documents, data.questions, "query-only");
const current = evaluateCorpus("full", data.documents, data.questions, "current");
assert.deepEqual(queryOnly.suites, current.suites, "query-only control must equal the existing current algorithm");
assert.deepEqual(queryOnly.cases.map(item => item.rankedIds), current.cases.map(item => item.rankedIds));
for (const scheme of contextSchemes) {
  const result = evaluateContextCorpus("full", data.documents, data.questions, scheme);
  assert.equal(result.cases.length, 212);
  assert.equal(result.suites.standard!.questions, 136);
  assert.equal(result.suites.hard!.questions, 76);
  assert.equal(Object.values(result.hardKinds).reduce((sum, item) => sum + item.questions, 0), 76);
  for (const item of result.cases.filter(item => item.suite === "standard")) {
    assert.equal(item.effectiveQuery, item.query, "standard top-level industry is not ctx");
    assert.deepEqual(item.contextUsed, {});
    assert.deepEqual(item.rankedIds, retrieve(data.documents, item).map(doc => doc.id));
  }
  const comparison = compareCorpora(queryOnly, result);
  assert.equal(comparison.cases.length, 212);
  for (const suite of Object.values(comparison.suites)) assert.equal(suite.improved + suite.regressed + suite.unchanged, suite.questions);
}
assert.deepEqual(data, originalData);
assert.throws(() => evaluateContextCorpus("duplicate", data.documents, [data.questions[0]!, data.questions[0]!], "ctx-full"));
assert.throws(() => evaluateContextCorpus("dangling", [], data.questions, "ctx-full"));
console.log(`PASS 独立上下文检查：9×4 扩写边界、3×4 门店范围、2×4 无答案诊断、212题同 ranker 对照及原文/输入不变；fixture SHA256 ${createHash("sha256").update(bytes).digest("hex")}`);
