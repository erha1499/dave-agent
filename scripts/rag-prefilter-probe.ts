// One frozen offline retrieval comparison. This file never changes runtime defaults.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { contentHash, createBailianClient, BailianBudgetStop, type BailianClient } from "../src/bailian.ts";
import { createEvidenceSupportClient } from "../src/evidence-support.ts";
import { runRetrievalV2, validateV2Dataset, type V2Dataset, type V2Question } from "../scripts/retrieval-v2.ts";
import { evaluateRecordedAcceptance } from "../scripts/acceptance-report.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureFile = "data/rag-prefilter-probe-20261009.json", freezeFile = "data/rag-prefilter-freeze-20261009.json";
const documentsFile = "data/acceptance-online.json", methodFile = "scripts/rag-prefilter-probe.ts";
const runDirectory = join(root, ".runtime/rag-prefilter-probe-20261009-run");
const deadline = Date.parse("2026-10-08T21:27:00Z"); // Beijing 2026-10-09 05:27.
const arms = [
  { id: "development-A", split: "development", threshold: .71, maxRequests: 16 },
  { id: "development-B", split: "development", threshold: .60, maxRequests: 8 },
  { id: "validation-A", split: "validation", threshold: .71, maxRequests: 24 },
  { id: "validation-B", split: "validation", threshold: .60, maxRequests: 12 },
] as const;
const files = [methodFile, fixtureFile, documentsFile, "src/bailian.ts", "src/evidence-support.ts",
  "src/evidence-acceptance.ts", "src/retrieval-ranking.ts", "src/agent.ts", "src/model-selection.ts",
  "src/knowledge-retrieval.ts", "scripts/retrieval-data.ts", "scripts/retrieval-v2.ts", "scripts/acceptance-report.ts", "package-lock.json"];
const parameters = { timeoutMs: 15_000, retries: 0, cache: "reuse" as const, consecutiveFailureLimit: 1 };
type Split = typeof arms[number]["split"];
type Report = Awaited<ReturnType<typeof runRetrievalV2>>["report"];
type Assessment = ReturnType<typeof evaluateRecordedAcceptance>;
const fixture: { status: string; development: { questions: V2Question[] }; validation: { questions: V2Question[] } }
  = JSON.parse(await readFile(join(root, fixtureFile), "utf8"));
const documents = JSON.parse(await readFile(join(root, documentsFile), "utf8")).documents;
assert.equal(documents.length, 8);
function dataset(split: Split): V2Dataset {
  const questions = fixture[split].questions.map((q: V2Question) => ({ id: q.id, query: q.query, suite: q.suite,
    shopId: q.shopId, productId: q.productId ?? null, relevant: q.relevant,
    ...(q.expectedBehavior ? { expectedBehavior: q.expectedBehavior } : {}),
    ...(q.forbidden ? { forbidden: q.forbidden } : {}), ...(q.required ? { required: q.required } : {}) }));
  return validateV2Dataset({ source: { fixture: fixtureFile, split }, corpora: [{ id: "online", documents, questions }] });
}
const datasets = { development: dataset("development"), validation: dataset("validation") };
for (const [split, counts] of [["development", [4, 3, 1]], ["validation", [6, 4, 2]]] as const) {
  const questions = datasets[split].corpora[0]!.questions;
  assert.deepEqual([questions.filter(q => q.relevant.length).length, questions.filter(q => q.suite === "no_answer").length,
    questions.filter(q => q.suite === "scope").length], counts);
  assert.ok(questions.every(q => !q.deferredReason));
}
assert.equal(new Set([...fixture.development.questions, ...fixture.validation.questions].map(q => q.id)).size, 20);
assert.equal(new Set([...fixture.development.questions, ...fixture.validation.questions].map(q => q.query)).size, 20);
const plan = arms.flatMap(arm => datasets[arm.split].corpora[0]!.questions.map(q => ({ arm: arm.id, split: arm.split,
  id: q.id, suite: q.suite, answerable: q.relevant.length > 0 })));
const hashFiles = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, contentHash(await readFile(join(root, file)))])));
function cacheOnly(client: BailianClient): BailianClient {
  return { ...client, async rerank() { throw new BailianBudgetStop([]); } };
}
function complete(report: Report, assessment: Assessment) {
  return report.status === "completed" && assessment.totals.incomplete === 0
    && assessment.totals.measured === report.plan.length && assessment.totals.deferred === 0;
}
function improvement(a: Assessment, b: Assessment) {
  const safe = (x: Assessment) => x.totals.falseAccepts === 0 && x.totals.scopeAbstentionFailures === 0
    && x.totals.scopeViolations === 0 && x.totals.boundaryFailures === 0;
  const correct = (x: Assessment) => new Set(x.groups.flatMap(group => group.cases)
    .filter(row => row.status === "measured" && row.answerable && row.recall === 1).map(row => row.id));
  const ca = correct(a), cb = correct(b), gained = [...cb].filter(id => !ca.has(id)), lost = [...ca].filter(id => !cb.has(id));
  return { pass: safe(a) && safe(b) && gained.length >= 1 && lost.length === 0,
    gained, lost, aSafe: safe(a), bSafe: safe(b), aRecall: a.totals.acceptedRecallAt5, bRecall: b.totals.acceptedRecallAt5 };
}

const mode = process.argv[2] ?? "--dry-run";
assert.ok(["--dry-run", "--self-check", "--freeze-input", "--run"].includes(mode) && process.argv.length === 3,
  "Use exactly one of --dry-run, --self-check, --freeze-input, --run");
if (mode === "--dry-run" || mode === "--self-check") {
  assert.equal(plan.length, 40); assert.equal(arms.reduce((sum, arm) => sum + arm.maxRequests, 0), 60);
  if (mode === "--self-check") {
    let misses = 0;
    const mock = { settings: {}, rerank: async () => { misses++; }, embed: async () => { misses++; } } as unknown as BailianClient;
    const blocked = cacheOnly(mock); assert.equal(blocked.settings, mock.settings);
    await assert.rejects(blocked.rerank("q", ["d"]), BailianBudgetStop); assert.equal(misses, 0);
    const score = (ids: string[], unsafe = false) => ({ totals: { falseAccepts: unsafe ? 1 : 0, scopeAbstentionFailures: 0,
      scopeViolations: 0, boundaryFailures: 0, acceptedRecallAt5: ids.length / 4 }, groups: [{ cases: ids.map(id => ({ id,
      status: "measured", answerable: true, recall: 1 })) }] }) as unknown as Assessment;
    assert.equal(improvement(score(["a"]), score(["a", "b"])).pass, true);
    assert.equal(improvement(score(["a"]), score(["a"])).pass, false);
    assert.equal(improvement(score(["a"]), score(["b", "c"])).pass, false);
    assert.equal(improvement(score(["a"]), score(["a", "b"], true)).pass, false);
    assert.equal(complete({ status: "completed_with_errors", plan: [1] } as unknown as Report,
      { totals: { measured: 1, incomplete: 0, deferred: 0 } } as Assessment), false);
  }
  console.log(JSON.stringify({ mode, remoteCalls: 0, plan, arms, files: await hashFiles(),
    datasetHashes: Object.fromEntries(Object.entries(datasets).map(([key, value]) => [key, contentHash(value)])) }, null, 2));
} else {
  const client = createBailianClient({ timeoutMs: parameters.timeoutMs, retries: 0 });
  const support = await createEvidenceSupportClient({ timeoutMs: parameters.timeoutMs, profile: "binary", modelSelection: "deepseek-flash" });
  assert.equal(support.settings.promptVersion, "fact-support-v1"); assert.equal(support.settings.maxRetries, 0);
  assert.equal(support.settings.provider, "deepseek"); assert.equal(support.settings.model, "deepseek-flash");
  const identity = { version: 1, files: await hashFiles(), datasetHashes: Object.fromEntries(Object.entries(datasets).map(([key, value]) => [key, contentHash(value)])),
    arms, plan, parameters, settings: { rerank: client.settings, support: support.settings }, deadline: new Date(deadline).toISOString(), maxRequests: 60 };
  if (mode === "--freeze-input") console.log(JSON.stringify(identity, null, 2));
  else {
    assert.ok(String(fixture.status).startsWith("frozen"), "Fixture must be frozen before remote execution");
    const frozen = JSON.parse(await readFile(join(root, freezeFile), "utf8"));
    assert.deepEqual(frozen.identity, identity, "Frozen method, data, settings or full plan changed");
    assert.ok(Date.now() < deadline, "Probe business deadline has passed");
    await mkdir(runDirectory, { mode: 0o700 }); // Exclusive one-shot guard; existing directory rejects reruns.
    const output = { startedAt: new Date().toISOString(), finishedAt: null as string | null, freezeHash: contentHash(frozen),
      plan: plan.map(row => ({ ...row, status: "not_executed", reason: "prerequisite_not_met" })),
      arms: [] as Array<{ arm: string; path: string | null; report: Report | null; assessment: Assessment | null; error: string | null }>,
      developmentGate: null as ReturnType<typeof improvement> | null, validationGate: null as ReturnType<typeof improvement> | null,
      status: "running", actualNetworkAttemptsObserved: 0, stopReason: null as string | null };
    const save = () => writeFile(join(runDirectory, "summary.json"), JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
    await save();
    const end = Math.min(deadline, Date.now() + 60 * 60_000);
    async function runArm(arm: typeof arms[number]) {
      assert.deepEqual(await hashFiles(), identity.files, "Frozen inputs changed before an arm");
      if (Date.now() >= end) { output.stopReason = "deadline"; return null; }
      const armDirectory = join(runDirectory, arm.id); await mkdir(armDirectory, { mode: 0o700 });
      const stopped = () => {
        if (Date.now() + parameters.timeoutMs + 1000 >= end) { output.stopReason = "deadline"; throw new BailianBudgetStop([]); }
      };
      const timedClient: BailianClient = { ...client, rerank: async (...args) => { stopped(); return client.rerank(...args); } };
      const timedSupport = { settings: support.settings, verify: async (...args: Parameters<typeof support.verify>) => { stopped(); return support.verify(...args); } };
      const entry = { arm: arm.id, path: null as string | null, report: null as Report | null,
        assessment: null as Assessment | null, error: null as string | null };
      output.arms.push(entry);
      for (const row of output.plan.filter(row => row.arm === arm.id)) { row.status = "missing"; row.reason = "arm_started"; }
      try {
        const observed = await runRetrievalV2({ label: arm.id, modes: ["M4"], dataset: datasets[arm.split], allowRemote: true,
          client: arm.id.endsWith("-B") ? cacheOnly(timedClient) : timedClient, supportClient: timedSupport,
          cacheDir: join(runDirectory, "cache"), outputDir: armDirectory,
          parameters: { ...parameters, maxRequests: arm.maxRequests }, acceptance: { mode: "support", threshold: arm.threshold } });
        entry.path = observed.path; entry.report = observed.report;
      } catch {
        entry.error = "runner_failed_no_retry";
        const reports = (await readdir(armDirectory)).filter(file => file.endsWith(".json"));
        if (reports.length === 1) { entry.path = join(armDirectory, reports[0]!); entry.report = JSON.parse(await readFile(entry.path, "utf8")); }
      }
      if (entry.report) {
        try { entry.assessment = evaluateRecordedAcceptance(entry.report); }
        catch { entry.error = "recorded_acceptance_audit_failed"; }
        for (const row of output.plan.filter(row => row.arm === arm.id)) {
          const scored = entry.assessment?.groups.flatMap(group => group.cases).find(item => item.id === row.id);
          row.status = scored?.status ?? "failed"; row.reason = entry.error ?? (scored?.status === "measured" ? "observed" : "incomplete");
        }
      }
      output.actualNetworkAttemptsObserved = output.arms.reduce((sum, arm) => sum + (arm.report?.calls.reduce((n, call) => n + call.attempts.length, 0) ?? 0)
        + (arm.report?.supportCalls.reduce((n, call) => n + call.attempts.length, 0) ?? 0), 0);
      assert.ok(output.actualNetworkAttemptsObserved <= 60);
      await save();
      return entry.report && entry.assessment && !entry.error && complete(entry.report, entry.assessment) ? entry.assessment : null;
    }
    try {
      const da = await runArm(arms[0]);
      const db = da ? await runArm(arms[1]) : null;
      output.developmentGate = da && db ? improvement(da, db) : null;
      if (output.developmentGate?.pass) {
        const va = await runArm(arms[2]); const vb = va ? await runArm(arms[3]) : null;
        output.validationGate = va && vb ? improvement(va, vb) : null;
        output.status = va && vb ? output.validationGate?.pass ? "candidate_evidence_only" : "not_promoted" : "incomplete";
        if (!va || !vb) output.stopReason ??= "validation_incomplete";
      } else {
        output.status = da && db ? "development_not_improved" : "incomplete";
        if (!da || !db) output.stopReason ??= "development_incomplete";
      }
    } catch { output.status = "failed_no_retry"; output.stopReason ??= "wrapper_failure"; process.exitCode = 1; }
    finally {
      try { assert.deepEqual(await hashFiles(), identity.files); }
      catch { output.status = "integrity_changed"; output.stopReason = "frozen_inputs_changed"; process.exitCode = 1; }
      output.finishedAt = new Date().toISOString();
      assert.equal(output.plan.length, 40); await save();
      console.log(JSON.stringify({ status: output.status, planned: 40, measured: output.plan.filter(row => row.status === "measured").length,
        notExecuted: output.plan.filter(row => row.status === "not_executed").length,
        actualNetworkAttemptsObserved: output.actualNetworkAttemptsObserved, summary: resolve(runDirectory, "summary.json") }));
    }
  }
}
