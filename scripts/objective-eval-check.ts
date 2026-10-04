import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { executeEvaluationBatches, objectiveSuites, parseEvaluationArgs } from "./evaluate.ts";
import { checkReadonlyDataset } from "./objective-readonly.ts";
import { checkWorkflowDataset } from "./objective-workflow.ts";
import { engineeringPlan } from "./objective-engineering.ts";
import { objectivePlan } from "../src/eval-analysis.ts";
import type { EvalBatch, EvalObjectivePlan, EvalRunDetail } from "../src/evaluation.ts";

assert.equal(parseEvaluationArgs(["--help"]), "help");
assert.deepEqual(parseEvaluationArgs(["--suite", "readonly"]), { suite: "readonly", repeat: 1, label: "客观评测" });
assert.deepEqual(parseEvaluationArgs(["--suite=all", "--repeat=20", "--label", " 固定名称 "]), { suite: "all", repeat: 20, label: "固定名称" });
for (const suite of objectiveSuites) assert.equal((parseEvaluationArgs(["--suite", suite]) as { suite: string }).suite, suite);
for (const args of [[], ["--help", "--suite", "readonly"], ["--suite", "unknown"], ["--repeat", "2"], ["--suite"],
  ["--suite", "readonly", "--suite", "workflow"], ["--suite", "readonly", "--repeat", "1", "--repeat", "2"],
  ["--suite", "readonly", "--label", "a", "--label", "b"], ["--suite", "readonly", "--unknown", "x"],
  ["--suite", "readonly", "position"], ["--suite", "readonly", "--label", " "], ["--suite", "readonly", "--label", "x".repeat(121)],
  ["--suite", "readonly", "--label", "line\nline"], ...["0", "21", "-1", "01", "1.5", "2e1", "NaN", ""].map(value => ["--suite", "readonly", "--repeat", value])])
  assert.throws(() => parseEvaluationArgs(args), /用法/);
assert.equal((parseEvaluationArgs(["--suite", "readonly", "--label", "x".repeat(120)]) as { label: string }).label.length, 120);

const calibration = await checkReadonlyDataset();
// These helpers execute real oracle calibrations, including deliberate wrong IDs/scopes/amounts/routes/state.
// They do not modify dataset files, invoke a model, initialize a fixture or connect to MySQL.
const workflow = await checkWorkflowDataset();
assert.deepEqual(calibration, { cases: 20, turns: 26, checks: 218 });
assert.deepEqual({ cases: workflow.cases, turns: workflow.turns, checks: workflow.checks }, { cases: 5, turns: 30, checks: 293 });
assert.ok(workflow.calibrationChecks >= 21);
assert.deepEqual(workflow.plan.cases.map(item => item.id), ["approved-lifecycle", "reject-notification", "timeout-notification", "claimed-approval", "switch-order"]);
const readonly = JSON.parse(await readFile(new URL("../data/evaluation/readonly.json", import.meta.url), "utf8")) as { cases: Array<{ id: string }> };
assert.deepEqual(readonly.cases.map(item => item.id), ["order-unused", "order-second-customer", "order-expired", "order-refunded", "order-partial",
  "order-unpaid", "order-redeemed", "order-private-product", "identity-foreign", "identity-unbound", "identity-other-app", "clarify-no-order",
  "switch-order-omit", "ambiguous-two-orders", "missing-holiday-policy", "missing-allergen-policy", "faq-no-answer", "pretend-admin-identity",
  "readonly-fake-confirmation", "redeemed-omitted-followup"]);
const engineering = engineeringPlan();
assert.equal(engineering.cases.length, 15);
assert.equal(engineering.cases.flatMap(item => item.turns).flatMap(item => item.checks).length, 15);
assert.deepEqual(engineering.cases.map(item => item.id), ["order-database", "order-agent", "merchant-database", "merchant-agent", "refund-database",
  "refund-agent", "notification-database", "notification-agent", "two-user-isolation", "qq-protocol", "qq-queue", "reply-protocol", "retrieval-engineering",
  "evaluation-integrity", "evaluation-database"]);

const plan: EvalObjectivePlan = { version: 1, scope: "objective", answerQuality: "not_evaluated", cases: [{ id: "synthetic-case", tags: ["execution"],
  turns: [{ index: 1, source: "engineering", checks: [{ id: "execution", category: "execution", basis: "execution" }] }] }] };
function result(suite: string, batch: EvalBatch, failed = false): EvalRunDetail {
  const status = failed ? "failed" as const : "passed" as const;
  return { run: { id: randomUUID(), suiteId: suite, suiteName: suite, kind: "engineering", label: "synthetic", status: "completed",
    startedAt: "2026-10-05T00:00:00.000Z", finishedAt: "2026-10-05T00:00:00.000Z", plannedCases: 1, plannedTurns: 1, batch, metrics: null,
    snapshot: { gitCommit: "test", gitDirty: false, asOf: "2026-10-05T00:00:00.000Z",
      model: { provider: "none", id: "not-applicable", maxTokens: 0, thinking: "off", temperature: null },
      hashes: { prompt: "test", skill: "test", tools: "test", dataset: "test", checker: "test", business: "test" },
      content: { evaluation: plan, measurement: "synthetic", implementation: { files: { "test.ts": "test" } },
        runtime: { node: "test", platform: "test", arch: "test" }, settings: {} } } },
    cases: [{ id: "synthetic-case", name: "synthetic", category: "execution", status, turns: [{ index: 1, question: "synthetic", reply: "",
      startedAt: "2026-10-05T00:00:00.000Z", durationMs: 1, firstTextMs: null, evidenceIds: [], status, steps: [],
      checks: [{ id: "execution", name: "synthetic", category: "execution", status }] }] }] };
}
for (const fixed of [workflow.plan, engineering]) {
  const run = result("check", { id: randomUUID(), repetition: 1, plannedRepetitions: 1 }).run;
  run.snapshot.content.evaluation = fixed; run.plannedCases = fixed.cases.length; run.plannedTurns = fixed.cases.reduce((sum, item) => sum + item.turns.length, 0);
  assert.equal(objectivePlan(run).scope, "objective");
}

const calls: Array<{ suite: string; batch: EvalBatch; id: string }> = [], lines: string[] = [];
let active = 0;
const exitCode = await executeEvaluationBatches({ suite: "all", repeat: 2, label: "合成编排" }, async (suite, options) => {
  assert.equal(active++, 0, "suites and repeats must not overlap");
  await new Promise<void>(resolve => setImmediate(resolve));
  const detail = result(suite, options.batch, suite === "engineering" && options.batch.repetition === 1);
  calls.push({ suite, batch: options.batch, id: detail.run.id }); active--;
  return detail;
}, line => lines.push(line));
assert.equal(exitCode, 1, "a failed objective check is reported only after all planned repetitions");
assert.deepEqual(calls.map(call => `${call.suite}/${call.batch.repetition}`), objectiveSuites.flatMap(suite => [`${suite}/1`, `${suite}/2`]));
assert.equal(new Set(calls.map(call => call.batch.id)).size, 4);
assert.equal(new Set(calls.map(call => call.id)).size, 8);
assert.ok(calls.every(call => call.batch.plannedRepetitions === 2));
assert.equal(lines.filter(line => line.startsWith("[BATCH ANALYSIS]")).length, 4);
assert.equal(await executeEvaluationBatches({ suite: "engineering", repeat: 2, label: "合成通过" }, async (suite, options) => result(suite, options.batch), () => {}), 0);
let attempts = 0;
await assert.rejects(executeEvaluationBatches({ suite: "readonly", repeat: 3, label: "合成中断" }, async (suite, options) => {
  attempts++;
  if (attempts === 2) throw new Error("synthetic infrastructure error");
  return result(suite, options.batch);
}, () => {}), /synthetic infrastructure error/);
assert.equal(attempts, 2, "infrastructure error stops, never silently restarts the same run");
await assert.rejects(executeEvaluationBatches({ suite: "engineering", repeat: 1, label: "缺失批次元数据" }, async (suite, options) => {
  const detail = result(suite, options.batch); delete detail.run.batch; return detail;
}, () => {}), /批次身份/);

// Child processes have no env-file or credentials. Help/invalid input must finish before configuration reads.
const command = promisify(execFile);
const cleanEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME };
const help = await command(process.execPath, ["scripts/evaluate.ts", "--help"], { env: cleanEnvironment });
assert.match(help.stdout, /readonly.*workflow/);
assert.doesNotMatch(help.stdout, /\[RUN\]|\[BATCH START\]/);
for (const args of [[], ["--suite", "readonly", "--repeat", "0"]]) {
  await assert.rejects(command(process.execPath, ["scripts/evaluate.ts", ...args], { env: cleanEnvironment }), error => {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    assert.equal(failure.code, 2); assert.match(failure.stderr ?? "", /用法/);
    assert.doesNotMatch(`${failure.stdout}${failure.stderr}`, /\[RUN\]|\[BATCH START\]|EVAL_DB_PASSWORD/);
    return true;
  });
}
console.log("PASS 客观数据集与负例oracle校准、固定计划ID/分母、CLI边界、串行复跑、失败保留与无凭据help。");
