import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "mysql2/promise";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalCase, type EvalObjectivePlan, type EvalRun } from "../src/evaluation.ts";
import { analyzeBatch, analyzeEvaluation } from "../src/eval-analysis.ts";
import { createEvaluationServer } from "../src/eval-server.ts";

const config = readEvalDatabaseConfig({ EVAL_DB_PASSWORD: "synthetic-only" });
assert.equal(config.user, "dave_agent_eval");
assert.equal(config.database, "dave_agent");
assert.equal(config.port, 13306);
assert.equal(config.multipleStatements, false);
assert.throws(() => readEvalDatabaseConfig({}), /EVAL_DB_PASSWORD/);
assert.throws(() => readEvalDatabaseConfig({ EVAL_DB_PASSWORD: "synthetic-only", EVAL_DB_USER: "root;DROP" }), /DB_NAME 或 DB_USER/);
assert.throws(() => readEvalDatabaseConfig({ EVAL_DB_PASSWORD: "synthetic-only", EVAL_DB_USER: "root" }), /独立/);

const pool = createPool(readEvalDatabaseConfig());
const store = new EvalStore(pool);
const startedAt = new Date().toISOString();
const cases: EvalCase[] = [{
  id: "permission-denial", name: "工程检查：预期拒绝与未知用量", category: "safety", status: "passed",
  turns: [{ index: 1, question: "工程检查请求", reply: "订单拒绝访问", status: "passed", startedAt,
    durationMs: 125, firstTextMs: null, evidenceIds: [],
    checks: [{ id: "deny", name: "预期拒绝", category: "safety", status: "passed" }],
    steps: [{ index: 1, type: "model", name: "engineering-only", durationMs: 100, isError: false, usage: null },
      { index: 2, type: "tool", name: "get_order", durationMs: 25, isError: true, expectedDenial: true, input: { orderId: "SYNTHETIC" }, output: "工程拒绝" }],
  }],
}, {
  id: "assertion-failure", name: "工程检查：失败断言", category: "business", status: "failed", turns: [{
    index: 1, question: "工程检查失败请求", reply: "合成错误回答", status: "failed", startedAt,
    durationMs: null, firstTextMs: null, evidenceIds: [], steps: [], error: "工程断言失败",
    checks: [{ id: "amount", name: "合成金额检查", category: "business", status: "failed", reason: "工程检查故意构造失败" }],
  }],
}, { id: "not-executed", name: "工程检查：未执行", category: "business", status: "skipped", turns: [] }];
const snapshot: EvalRun["snapshot"] = {
  gitCommit: "engineering-check", gitDirty: true,
  model: { provider: "engineering", id: "no-real-model", maxTokens: 0, thinking: "off", temperature: null },
  hashes: { prompt: "engineering", skill: "engineering", tools: "engineering", dataset: "engineering", checker: "engineering", business: "engineering" },
  asOf: startedAt, content: { description: "工程检查合成记录，不属于真实模型评测" },
};

try {
  await store.ping();
  const ids: string[] = [];
  for (const label of ["工程数据库检查 A", "工程数据库检查 B"]) {
    const run: EvalRun = { id: randomUUID(), suiteId: "evaluation-db-check", suiteName: "工程数据库检查", kind: "engineering", label,
      status: "running", startedAt, finishedAt: null, plannedCases: 3, plannedTurns: 2, snapshot, metrics: null };
    ids.push(run.id);
    await store.startRun(run);
    const invalid: EvalCase = { ...cases[0]!, id: "transaction-rollback", turns: [{ ...cases[0]!.turns[0]!,
      steps: [cases[0]!.turns[0]!.steps[0]!, cases[0]!.turns[0]!.steps[0]!],
    }] };
    await assert.rejects(store.saveCase(run.id, invalid));
    assert.deepEqual((await store.getRun(run.id))?.cases, []);
    for (const item of cases) await store.saveCase(run.id, item);
    await store.finishRun(run.id, "completed", new Date().toISOString(), summarizeEvaluation(cases));
    const saved = await store.getRun(run.id);
    assert.ok(saved);
    assert.deepEqual(saved.cases, cases);
    assert.deepEqual(saved.run.snapshot, snapshot);
    assert.equal(saved.run.status, "completed");
    assert.equal(saved.run.metrics?.casesPassed, 1);
    assert.equal(saved.run.metrics?.casesFailed, 1);
    assert.equal(saved.run.metrics?.casesSkipped, 1);
    assert.equal(saved.run.metrics?.expectedDenials, 1);
    assert.equal(saved.run.metrics?.totalTokens, null);
    assert.equal(saved.run.metrics?.estimatedCostUsd, null);
    await assert.rejects(store.saveCase(run.id, cases[0]!));
  }
  const list = await store.listRuns(50, "engineering");
  for (const id of ids) {
    const item = list.find(run => run.id === id);
    assert.ok(item);
    assert.ok(!("content" in item.snapshot));
  }
  assert.deepEqual((await store.getRun(ids[0]!))?.cases.map(item => item.id), (await store.getRun(ids[1]!))?.cases.map(item => item.id));
  assert.ok((await store.listRuns()).every(run => run.kind === "model"));
  const failedRun: EvalRun = { id: randomUUID(), suiteId: "evaluation-db-check", suiteName: "工程数据库检查", kind: "engineering", label: "工程运行中断检查",
    status: "running", startedAt, finishedAt: null, plannedCases: 3, plannedTurns: 2, snapshot, metrics: null };
  await store.startRun(failedRun);
  await store.finishRun(failedRun.id, "failed", new Date().toISOString(), summarizeEvaluation([]), "工程检查合成中断");
  assert.equal((await store.getRun(failedRun.id))?.run.status, "failed");
  assert.equal((await store.getRun(failedRun.id))?.run.error, "工程检查合成中断");
  await assert.rejects(store.finishRun(failedRun.id, "completed", new Date().toISOString(), summarizeEvaluation([])));
  assert.equal(await store.getRun(randomUUID()), undefined);
  await assert.rejects(store.listRuns(0));
  await assert.rejects(store.getRun("invalid';DROP"));
  const batchId = randomUUID();
  const plan: EvalObjectivePlan = { version: 1, scope: "objective", answerQuality: "not_evaluated", cases: [{
    id: cases[0]!.id, tags: ["identity"], turns: [{ index: 1, source: "engineering", checks: [{ id: "deny", category: "safety", basis: "protocol" }] }],
  }] };
  const objectiveSnapshot: EvalRun["snapshot"] = { ...snapshot, content: { ...snapshot.content, evaluation: plan,
    measurement: "工程合成记录，只验证落库与只读 API", runtime: { node: process.version, platform: process.platform, arch: process.arch },
    implementation: { files: { "synthetic-check.ts": "engineering-only" } }, settings: {} } };
  const objectiveIds: string[] = [];
  for (const repetition of [1, 2]) {
    const run: EvalRun = { id: randomUUID(), suiteId: "evaluation-objective-db-check", suiteName: "客观评测落库检查", kind: "engineering",
      label: "工程客观计划往返", status: "running", startedAt, finishedAt: null, plannedCases: 1, plannedTurns: 1,
      snapshot: objectiveSnapshot, metrics: null, batch: { id: batchId, repetition, plannedRepetitions: 2 } };
    const malformed = structuredClone(run);
    (malformed.snapshot.content.evaluation as EvalObjectivePlan).cases[0]!.turns[0]!.checks.push({ ...plan.cases[0]!.turns[0]!.checks[0]! });
    await assert.rejects(store.startRun(malformed), /客观评测计划/);
    assert.equal(await store.getRun(malformed.id), undefined);
    await store.startRun(run);
    objectiveIds.push(run.id);
    const unplanned = structuredClone(cases[0]!); unplanned.turns[0]!.checks[0]!.id = "unplanned";
    await assert.rejects(store.saveCase(run.id, unplanned));
    assert.deepEqual((await store.getRun(run.id))?.cases, []);
    await store.saveCase(run.id, cases[0]!);
    await store.finishRun(run.id, "completed", new Date().toISOString(), summarizeEvaluation([cases[0]!]));
    const saved = (await store.getRun(run.id))!;
    assert.deepEqual(saved.run.batch, run.batch);
    assert.deepEqual(saved.run.snapshot.content.evaluation, plan);
    assert.equal(analyzeEvaluation(saved).counts?.checks.passed, 1);
    assert.equal(analyzeEvaluation(saved).usage.completeTokens, null);
  }
  const batch = await store.getBatch(batchId);
  assert.deepEqual(new Set(batch.map(detail => detail.run.id)), new Set(objectiveIds));
  assert.equal(analyzeBatch(batchId, batch).compatible, true);
  assert.equal(analyzeBatch(batchId, batch).cases[0]!.status, "always_passed");
  assert.deepEqual(await store.getBatch(randomUUID()), []);
  await assert.rejects(store.getBatch("invalid"));
  const server = createEvaluationServer(store);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(await (await fetch(`${base}/api/batches/${batchId}`)).json(), analyzeBatch(batchId, batch));
    assert.deepEqual(await (await fetch(`${base}/api/runs/${objectiveIds[0]}/analysis`)).json(), analyzeEvaluation(batch.find(detail => detail.run.id === objectiveIds[0])!));
    assert.equal((await fetch(`${base}/api/compare?baseline=${objectiveIds[0]}&candidate=${objectiveIds[1]}`).then(response => response.json()) as { repeatCompatible: boolean }).repeatCompatible, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const denied = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ER_TABLEACCESS_DENIED_ERROR";
  // Zero matching rows prevents mutations even if privileges were accidentally broadened.
  await assert.rejects(pool.execute("UPDATE orders SET status = status WHERE 1 = 0"), denied);
  await assert.rejects(pool.execute("SELECT * FROM qq_identities LIMIT 0"), denied);
  await assert.rejects(pool.execute("DELETE FROM eval_runs WHERE 1 = 0"), denied);
  console.log("评测 MySQL 检查通过：历史、失败/跳过/预期拒绝、未知用量、客观计划与批次、严格落库、分析/对比 HTTP 回读及受限权限。");
} finally { await store.close(); }
