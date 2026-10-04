import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createPool } from "mysql2/promise";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalBatch, type EvalCase, type EvalObjectivePlan, type EvalRun } from "../src/evaluation.ts";
import { loadRetrievalData } from "./retrieval-data.ts";
import { evaluateBoundaries, retrieve, scoreQuestion } from "./retrieval-baseline.ts";
import { createObjectiveSnapshot, noModel } from "./objective-support.ts";

export async function runObjectiveRetrieval(options: { label: string; batch?: EvalBatch }) {
  const data = await loadRetrievalData(), selected = new Set(data.selectedIds);
  const boundary = JSON.parse(await readFile(new URL("../data/retrieval-boundaries.json", import.meta.url), "utf8"));
  const corpora = [
    { id: "selected", documents: data.documents.filter(doc => selected.has(doc.id)), questions: data.questions.filter(q => q.relevant.every(id => selected.has(id))) },
    { id: "full", documents: data.documents, questions: data.questions },
  ] as const;
  const ranking = corpora.flatMap(corpus => corpus.questions.map(question => ({ corpus, question, id: `${corpus.id}-${question.id}` })));
  // Validate boundaries before recording a plan; missing/contradictory gold is an invalid fixture, not a model failure.
  const diagnostic = evaluateBoundaries(data.documents, boundary);
  const plan: EvalObjectivePlan = { version: 1, scope: "objective", answerQuality: "not_evaluated", cases: [
    ...ranking.map(({ id, question, corpus }) => ({ id, tags: ["retrieval", `corpus_${corpus.id}`, `query_${question.suite}`], turns: [{ index: 1, source: "engineering" as const, checks: [
      { id: "ranking-valid", category: "execution" as const, basis: "execution" as const },
      { id: "explicit-scope", category: "safety" as const, basis: "trace" as const },
      { id: "recall-at-five", category: "evidence" as const, basis: "trace" as const },
    ] }] })),
    ...diagnostic.scope.cases.map(item => ({ id: `scope-${item.id}`, tags: ["retrieval", "identity"], turns: [{ index: 1, source: "engineering" as const,
      checks: [{ id: "scope-boundary", category: "safety" as const, basis: "trace" as const }] }] })),
    ...diagnostic.noAnswer.cases.map(item => ({ id: `no-answer-${item.id}`, tags: ["retrieval", "unknown_policy"], turns: [{ index: 1, source: "engineering" as const,
      checks: [{ id: "scope-valid", category: "safety" as const, basis: "trace" as const }] }] })),
  ] };
  const history = new EvalStore(createPool(readEvalDatabaseConfig()));
  const cases: EvalCase[] = [];
  let run: EvalRun | undefined;
  const scoped = (ids: string[], shopId: string | null) => ids.every(id => data.documents.some(doc => doc.id === id && (doc.shopId === null || doc.shopId === shopId)));
  try {
    await history.ping();
    run = { id: randomUUID(), suiteId: "retrieval-objective-v1", suiteName: "检索逐题客观评测", kind: "engineering", label: options.label,
      ...options.batch && { batch: options.batch }, status: "running", startedAt: new Date().toISOString(), finishedAt: null,
      plannedCases: plan.cases.length, plannedTurns: plan.cases.length, metrics: null,
      snapshot: await createObjectiveSnapshot({ plan, model: noModel, tools: [{ name: "rankKnowledge", algorithm: "current-query-only" }],
        files: ["scripts/objective-retrieval.ts", "scripts/retrieval-baseline.ts", "scripts/retrieval-data.ts", "src/knowledge-retrieval.ts", "data/retrieval-boundaries.json", "data/reference/kefu-harness/source.json"],
        business: { documents: data.documents, source: data.source }, dataset: { questions: data.questions, selectedIds: data.selectedIds, boundary }, settings: { algorithm: "current-query-only", returnLimit: 5 },
        measurement: "本地query-only检索，无模型或QQ；单题耗时仅同步排序与打分，不含数据库持久化。按全量/选集及常规/难题分别计算Recall/MRR，不合并为业务总分；无答案非空仅为召回诊断，不是回答质量。" }),
    };
    await history.startRun(run);
    console.log(`[RUN] ${run.id} retrieval ${plan.cases.length} cases`);
    for (const { corpus, question, id } of ranking) {
      const startedAt = new Date().toISOString(), start = performance.now();
      const ids = retrieve(corpus.documents, question).map(doc => doc.id), score = scoreQuestion(question, ids);
      const durationMs = performance.now() - start;
      const valid = new Set(ids).size === ids.length && ids.every(value => corpus.documents.some(doc => doc.id === value));
      const checks = [
        { id: "ranking-valid", name: "排名无重复且文档来自当前语料", category: "execution" as const, status: valid ? "passed" as const : "failed" as const },
        { id: "explicit-scope", name: "只返回通用或显式门店范围内文档", category: "safety" as const, status: scoped(ids, question.shopId) ? "passed" as const : "failed" as const },
        { id: "recall-at-five", name: "标注文档全部进入前五", category: "evidence" as const, status: score.recallAt5 === 1 ? "passed" as const : "failed" as const,
          ...score.failure && { reason: score.failure } },
      ];
      const status = checks.every(check => check.status === "passed") ? "passed" : "failed";
      const item: EvalCase = { id, name: question.query, category: `检索/${corpus.id}/${question.suite}`, status, turns: [{
        index: 1, question: question.query, reply: "", status, startedAt, durationMs, firstTextMs: null, evidenceIds: score.top5, checks,
        steps: [{ index: 1, type: "tool", name: "retrieval_rank", durationMs, isError: !valid,
          input: { query: question.query, shopId: question.shopId, corpus: corpus.id },
          output: { kind: "retrieval", corpus: corpus.id, suite: question.suite, firstRelevantRank: score.firstRelevantRank,
            recallAt1: score.recallAt1, recallAt5: score.recallAt5, reciprocalRank: score.reciprocalRank, reciprocalRankAt5: score.reciprocalRankAt5,
            rankedIds: score.rankedIds, relevant: score.relevant } }],
      }] };
      await history.saveCase(run.id, item); cases.push(item);
    }
    for (const [kind, values] of [["scope", diagnostic.scope.cases], ["no_answer", diagnostic.noAnswer.cases]] as const) {
      for (const value of values) {
        const startedAt = new Date().toISOString(), start = performance.now();
        const returned = retrieve(data.documents, value).slice(0, 5).map(doc => doc.id), durationMs = performance.now() - start;
        const isScope = "required" in value;
        const passed = isScope ? value.required.every(id => returned.includes(id)) && value.forbidden.every(id => !returned.includes(id)) : scoped(returned, value.shopId);
        const status = passed ? "passed" : "failed", id = `${isScope ? "scope" : "no-answer"}-${value.id}`;
        const item: EvalCase = { id, name: value.query, category: isScope ? "检索作用域" : "无答案召回诊断", status, turns: [{
          index: 1, question: value.query, reply: "", status, startedAt, durationMs, firstTextMs: null, evidenceIds: returned,
          checks: [{ id: isScope ? "scope-boundary" : "scope-valid", name: isScope ? "明确允许/禁止文档范围" : "范围合法（非空率另外报告）", category: "safety", status }],
          steps: [{ index: 1, type: "tool", name: `retrieval_${kind}`, durationMs, isError: false, input: { query: value.query, shopId: value.shopId },
            output: isScope ? { kind, passed, returned } : { kind, empty: returned.length === 0, returned } }],
        }] };
        await history.saveCase(run.id, item); cases.push(item);
      }
    }
    await history.finishRun(run.id, "completed", new Date().toISOString(), summarizeEvaluation(cases));
    console.log(`[DONE] ${run.id}；检索逐题结果及独立诊断已保存，召回未达标不冒充执行错误。`);
    return run.id;
  } catch (error) {
    if (run) await history.finishRun(run.id, "failed", new Date().toISOString(), summarizeEvaluation(cases), "检索评测未完整执行，保留已记录结果。").catch(() => {});
    throw error;
  } finally { await history.close(); }
}
