// One frozen offline retrieval comparison. This file never changes runtime defaults.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { contentHash, createBailianClient, BailianBudgetStop, type BailianClient } from "../src/bailian.ts";
import { createEvidenceSupportClient, evidenceSupportInputHash, evidenceSupportRequestHash,
  evidenceSupportTypedV6PromptVersion, evidenceSupportValidationVersion, type EvidenceSupportClient,
  type EvidenceSupportResult } from "../src/evidence-support.ts";
import { runRetrievalV2, validateV2Dataset, type V2Dataset, type V2Question } from "../scripts/retrieval-v2.ts";
import { evaluateRecordedAcceptance } from "../scripts/acceptance-report.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureFile = "data/rag-intent-profile-probe-20261009.json", freezeFile = "data/rag-intent-profile-freeze-20261009.json";
const documentsFile = "data/acceptance-online.json", methodFile = "scripts/rag-intent-profile-probe.ts";
const runDirectory = join(root, ".runtime/rag-intent-profile-probe-20261009-run");
const deadline = Date.parse("2026-10-08T22:20:00Z"); // Beijing 2026-10-09 06:20.
const arms = [
  { id: "development-A", split: "development", profile: "binary", threshold: .71, maxRequests: 16 },
  { id: "development-B", split: "development", profile: "typed", threshold: .71, maxRequests: 8 },
  { id: "validation-A", split: "validation", profile: "binary", threshold: .71, maxRequests: 24 },
  { id: "validation-B", split: "validation", profile: "typed", threshold: .71, maxRequests: 12 },
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
const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function validSupport(result: EvidenceSupportResult, typed: boolean) {
  return (!typed || result.validation?.status === "complete" && result.validation.invalidDecisions.length === 0)
    && result.attempts.every(attempt => attempt.outcome === "ok" && Number.isSafeInteger(attempt.totalTokens) && attempt.totalTokens! > 0
      && [attempt.inputTokens, attempt.outputTokens, attempt.cacheReadTokens, attempt.cacheWriteTokens].every(value => Number.isSafeInteger(value) && value! >= 0)
      && (known(attempt.costUsd) || known(attempt.costCny)));
}
function complete(report: Report, assessment: Assessment) {
  return report.status === "completed" && assessment.totals.incomplete === 0
    && assessment.totals.measured === report.plan.length && assessment.totals.deferred === 0
    && [...report.calls, ...report.supportCalls].every(call => call.status === "ok"
      && call.attempts.length === (call.cache === "hit" ? 0 : 1)
      && call.attempts.every(attempt => attempt.outcome === "ok" && Number.isSafeInteger(attempt.totalTokens) && attempt.totalTokens! > 0))
    && report.results.every(row => !row.acceptance.rejected.some(rejected => rejected.reason === "invalid_support_decision")
      && (!row.supportVerification || validSupport(row.supportVerification, report.snapshot.settings.acceptance.support?.profile === "typed")))
    && report.summary.usage.every(usage => usage.requests === 0 || usage.usageCoverage === 1 && known(usage.completeTokens)
      && (known(usage.completeEstimatedCostCny) || "completeEstimatedCostUsd" in usage && known(usage.completeEstimatedCostUsd)));
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
async function supportClients(env: NodeJS.ProcessEnv = process.env) {
  const shared = { env, timeoutMs: parameters.timeoutMs, modelSelection: "deepseek-flash" as const };
  const binary = await createEvidenceSupportClient({ ...shared, profile: "binary" });
  const typed = await createEvidenceSupportClient({ ...shared, profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion });
  for (const client of [binary, typed]) {
    assert.equal(client.settings.provider, "deepseek"); assert.equal(client.settings.model, "deepseek-flash");
    assert.equal(client.settings.timeoutMs, 15_000); assert.equal(client.settings.maxRetries, 0);
    assert.equal(client.settings.temperature, 0); assert.equal(client.settings.maxTokens, 2048);
  }
  assert.equal(binary.settings.promptVersion, "fact-support-v1"); assert.equal(binary.settings.profile, undefined);
  assert.equal(typed.settings.promptVersion, "fact-support-typed-v6"); assert.equal(typed.settings.profile, "typed");
  assert.equal(typed.settings.validationVersion, evidenceSupportValidationVersion);
  assert.notEqual(binary.settings.promptHash, typed.settings.promptHash);
  return { binary, typed };
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
    // The actual factory resolves both profiles and catalog pricing; metadata only, no verify/transport.
    const support = await supportClients({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-no-request" });
    const input = { query: "边界问题", scope: {}, candidates: [] };
    assert.notEqual(evidenceSupportInputHash({ ...input, settings: support.binary.settings }),
      evidenceSupportInputHash({ ...input, settings: support.typed.settings }), "Profiles must have separate support cache keys");
    assert.notEqual(evidenceSupportRequestHash({ ...input, settings: support.binary.settings }),
      evidenceSupportRequestHash({ ...input, settings: support.typed.settings }));
    const verification = { value: [], requestHash: "synthetic", attempts: [],
      validation: { status: "complete", outputHash: null, invalidDecisions: [] } } as EvidenceSupportResult;
    const measured = { totals: { measured: 1, incomplete: 0, deferred: 0 } } as Assessment;
    const report = { status: "completed", plan: [1], calls: [], supportCalls: [], summary: { usage: [] },
      snapshot: { settings: { acceptance: { support: support.typed.settings } } },
      results: [{ acceptance: { rejected: [] }, supportVerification: verification }] } as unknown as Report;
    assert.equal(complete(report, measured), true);
    verification.validation!.status = "partial";
    assert.equal(complete(report, measured), false, "Partial remains incomplete even if recorded assessment accepts gold");
    verification.validation!.status = "complete";
    verification.validation!.invalidDecisions = [{ id: "bad", code: "invalid_quote" }];
    assert.equal(complete(report, measured), false);
    verification.validation!.invalidDecisions = [];
    report.calls = [{ cache: "miss", status: "ok", attempts: [{ outcome: "ok", totalTokens: null }] }] as unknown as Report["calls"];
    assert.equal(complete(report, measured), false, "Unknown actual attempt usage forbids promotion");
    report.calls = [];
    report.summary.usage = [{ requests: 1, usageCoverage: 1, completeTokens: 10,
      completeEstimatedCostCny: null, completeEstimatedCostUsd: null }] as Report["summary"]["usage"];
    assert.equal(complete(report, measured), false, "Unknown actual attempt cost forbids promotion");
  }
  console.log(JSON.stringify({ mode, remoteCalls: 0, plan, arms, files: await hashFiles(),
    datasetHashes: Object.fromEntries(Object.entries(datasets).map(([key, value]) => [key, contentHash(value)])) }, null, 2));
} else {
  const client = createBailianClient({ timeoutMs: parameters.timeoutMs, retries: 0 });
  const support = await supportClients();
  assert.ok(client.settings.endpoints.origin === "https://dashscope.aliyuncs.com"
    || client.settings.endpoints.origin.endsWith(".cn-beijing.maas.aliyuncs.com"), "Only known Beijing rerank pricing");
  const identity = { version: 1, files: await hashFiles(), datasetHashes: Object.fromEntries(Object.entries(datasets).map(([key, value]) => [key, contentHash(value)])),
    arms, plan, parameters, settings: { rerank: client.settings, support: { binary: support.binary.settings, typed: support.typed.settings } },
    comparison: "binary v1 versus typed v6 including Prompt, schema and candidate isolation; not pure Prompt causality",
    deadline: new Date(deadline).toISOString(), maxRequests: 60 };
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
        if (output.stopReason) throw new BailianBudgetStop([]);
        if (Date.now() + parameters.timeoutMs + 1000 >= end) { output.stopReason = "deadline"; throw new BailianBudgetStop([]); }
      };
      const timedClient: BailianClient = { ...client, rerank: async (...args) => {
        stopped(); const result = await client.rerank(...args);
        if (result.attempts.some(attempt => !Number.isSafeInteger(attempt.totalTokens) || attempt.totalTokens! <= 0)) output.stopReason = "unknown_attempt_usage";
        return result;
      } };
      const selected = support[arm.profile];
      const timedSupport: EvidenceSupportClient = { settings: selected.settings, verify: async (...args) => {
        stopped(); const result = await selected.verify(...args);
        if (!validSupport(result, arm.profile === "typed")) output.stopReason = "invalid_partial_or_unknown_support";
        return result;
      } };
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
