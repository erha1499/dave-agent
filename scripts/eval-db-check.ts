import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "mysql2/promise";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { summarizeEvaluation, type EvalCase, type EvalRun } from "../src/evaluation.ts";

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
  const denied = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ER_TABLEACCESS_DENIED_ERROR";
  // Zero matching rows prevents mutations even if privileges were accidentally broadened.
  await assert.rejects(pool.execute("UPDATE orders SET status = status WHERE 1 = 0"), denied);
  await assert.rejects(pool.execute("SELECT * FROM qq_identities LIMIT 0"), denied);
  await assert.rejects(pool.execute("DELETE FROM eval_runs WHERE 1 = 0"), denied);
  console.log("评测 MySQL 检查通过：两轮历史、稳定案例 ID、失败/跳过/预期拒绝、未知用量、快照、模型与工程隔离及受限权限。");
} finally { await store.close(); }
