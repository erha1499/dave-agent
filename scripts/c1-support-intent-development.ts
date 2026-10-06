import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { createEvidenceSupportClient, EvidenceSupportError, validateEvidenceSupportVerification, verifyEvidenceSupport,
  type EvidenceSupportAttempt, type EvidenceSupportCandidate, type EvidenceSupportCategory, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import { scopeDocuments, type RetrievalScope } from "../src/retrieval-ranking.ts";
import { c1ValidationCodeFiles, createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url);
const suites = {
  intent: { versions: ["fact-support-typed-v5", "fact-support-typed-v6"], inputs: 20,
    limits: { requests: 40, estimatedUsd: .15, deadlineMs: 8 * 60_000, timeoutMs: 60_000 } },
  conditions: { versions: ["fact-support-typed-v6", "fact-support-typed-v7"], inputs: 12,
    limits: { requests: 24, estimatedUsd: .06, deadlineMs: 5 * 60_000, timeoutMs: 60_000 } },
} as const;
type Suite = keyof typeof suites;
type Version = typeof suites[Suite]["versions"][number];
type Expected = { category: EvidenceSupportCategory; acceptableCategories?: EvidenceSupportCategory[]; supported: boolean; evidenceQuote: string };
type Case = { id: string; group: string; query: string; scope: RetrievalScope; candidates: EvidenceSupportCandidate[]; inputHash: string;
  expected?: Expected; expectedByCandidate?: Array<Expected & { id: string }> };
type Dataset = { version: number; cases: Case[]; sources?: Array<{ path: string; sha256: string; bytes?: number }> };
type Row = { id: string; group: string; version: Version; execution: "not_run" | "completed" | "error";
  passed: boolean; verification?: EvidenceSupportVerification; attempts?: EvidenceSupportAttempt[]; error?: string; notRunReason?: string };
type Request = ReturnType<typeof createC1ValidationGuard>["requests"][number];
const dataPath = (suite: Suite) => `data/c1-support-${suite}-development.json`;
const manifestPath = (suite: Suite) => `data/c1-support-${suite}-development-manifest.json`;
const expectedFor = (item: Case) => item.expectedByCandidate ?? [{ id: item.candidates[0]!.id, ...item.expected! }];
const plannedRows = (data: Dataset, suite: Suite): Row[] => data.cases.flatMap(item => suites[suite].versions.map(version =>
  ({ id: item.id, group: item.group, version, execution: "not_run", passed: false })));
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const hashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));

function checkInputs(data: Dataset, suite: Suite) {
  assert.equal(data.version, 1); assert.equal(data.cases.length, suites[suite].inputs);
  assert.equal(new Set(data.cases.map(row => row.id)).size, suites[suite].inputs);
  if (suite === "intent") {
    assert.deepEqual(["expanded", "language", "contextual"].map(group => data.cases.filter(row => row.group === group).length), [10, 8, 2]);
    assert.equal(data.cases.filter(row => row.expected?.supported).length, 10);
  } else {
    assert.deepEqual(["target", "regression"].map(group => data.cases.filter(row => row.group === group).length), [6, 6]);
    assert.deepEqual([true, false].map(supported => data.cases.flatMap(expectedFor).filter(item => item.supported === supported).length), [9, 6]);
  }
  for (const row of data.cases) {
    assert.equal(row.inputHash, contentHash({ query: row.query, scope: row.scope, candidates: row.candidates }));
    assert.ok(row.query.trim() && row.query.length <= 500 && row.candidates.length >= 1 && row.candidates.length <= 5);
    assert.equal(scopeDocuments(row.candidates, row.scope).length, row.candidates.length, "Every frozen candidate is visible in the actual scope");
    assert.equal(new Set(row.candidates.map(candidate => candidate.id)).size, row.candidates.length);
    assert.ok(Boolean(row.expected) !== Boolean(row.expectedByCandidate), "Exactly one expected format is required");
    if (suite === "intent" || row.expected) assert.equal(row.candidates.length, 1, "Legacy gold remains single-candidate");
    const expected = expectedFor(row);
    assert.deepEqual(expected.map(item => item.id).sort(), row.candidates.map(item => item.id).sort(), "Gold covers every candidate exactly once");
    for (const item of expected) {
      const candidate = row.candidates.find(candidate => candidate.id === item.id)!;
      assert.ok(item.evidenceQuote && candidate.body.includes(item.evidenceQuote));
      assert.ok(["direct_fact", "boundary_answer", "limitation_only", "unrelated"].includes(item.category));
      assert.equal(item.supported, item.category === "direct_fact" || item.category === "boundary_answer");
      for (const category of item.acceptableCategories ?? [item.category]) {
        assert.ok(["direct_fact", "boundary_answer", "limitation_only", "unrelated"].includes(category));
        assert.equal(item.supported, category === "direct_fact" || category === "boundary_answer");
      }
      if (item.acceptableCategories) assert.ok(item.acceptableCategories.includes(item.category));
    }
  }
}
async function loadInputs(suite: Suite) {
  const data = await json(dataPath(suite)) as Dataset; checkInputs(data, suite); return data;
}
function guardLimits(suite: Suite) {
  const { limits } = suites[suite];
  return { requests: { agent: 1, rerank: 1, support: limits.requests }, estimatedUsd: limits.estimatedUsd,
    estimatedCny: .1, deadlineMs: limits.deadlineMs, turnTimeoutMs: limits.timeoutMs };
}
async function clients(suite: Suite, guard?: ReturnType<typeof createC1ValidationGuard>) {
  const runtime = await createConfiguredModelRuntime({ ...process.env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-v4-pro" });
  return Object.fromEntries(await Promise.all(suites[suite].versions.map(async version => [version, await createEvidenceSupportClient({ profile: "typed",
    typedPromptVersion: version, modelSelection: "deepseek-v4-pro", timeoutMs: suites[suite].limits.timeoutMs,
    runtime: { model: runtime.model, complete: (context, options) => runtime.modelRuntime.complete(runtime.model, context,
      { ...options, ...(guard ? { fetch: guard.fetchFor("support") } : {}) }) } })]))) as Record<Version, Awaited<ReturnType<typeof createEvidenceSupportClient>>>;
}

async function snapshot(suite: Suite) {
  const data = await loadInputs(suite), variants = await clients(suite), { versions, limits } = suites[suite];
  for (const source of data.sources ?? []) {
    const bytes = await readFile(new URL(source.path, root));
    assert.equal(contentHash(bytes), source.sha256, `Frozen dataset provenance changed: ${source.path}`);
    if (source.bytes !== undefined) assert.equal(bytes.length, source.bytes);
  }
  const files = [...new Set([...(await c1ValidationCodeFiles()), "scripts/c1-support-intent-development.ts", dataPath(suite),
    ...(data.sources ?? []).map(source => source.path)])].sort();
  const settings = Object.fromEntries(versions.map(version => [version, variants[version].settings]));
  const stripPrompt = (version: Version) => { const { promptVersion: _version, promptHash: _hash, ...other } = variants[version].settings; return other; };
  assert.deepEqual(stripPrompt(versions[0]), stripPrompt(versions[1]), "Prompt content/version are the only settings variable");
  for (const version of versions) assert.equal(variants[version].settings.maxRetries, 0);
  return { version: 1, stage: "exposed-development-fixed-input-support-prompt-ablation", suite, limits, versions, settings,
    sourceHashes: await hashes(files), dependencies: await readC1ValidationDependencies() };
}

export function summarizeIntentComparison(data: Dataset, rows: Row[]) {
  return Object.fromEntries(suites.intent.versions.map(version => {
    const group = rows.filter(row => row.version === version), complete = group.filter(row => row.execution === "completed");
    const truth = (row: Row) => data.cases.find(item => item.id === row.id)!.expected!.supported;
    const times = complete.flatMap(row => row.verification!.attempts.map(attempt => attempt.durationMs)).sort((a, b) => a - b);
    return [version, { planned: group.length, completed: complete.length, passed: group.filter(row => row.passed).length,
      failed: complete.filter(row => !row.passed).length, errorsOrNotRun: group.length - complete.length,
      positivePlanned: group.filter(truth).length, negativePlanned: group.filter(row => !truth(row)).length,
      falseAccepted: complete.filter(row => !truth(row) && row.verification!.value.some(decision => decision.supported)).length,
      falseRejected: complete.filter(row => truth(row) && row.verification!.value.every(decision => !decision.supported)).length,
      invalidDecisions: group.reduce((n, row) => n + (row.verification?.validation?.invalidDecisions.length ?? 0), 0),
      p50Ms: times[Math.ceil(times.length * .5) - 1] ?? null, p95Ms: times[Math.ceil(times.length * .95) - 1] ?? null }];
  }));
}

function candidateResults(item: Case, row: Row) {
  return expectedFor(item).map(expected => {
    const invalid = row.verification?.validation?.invalidDecisions.some(decision => decision.id === expected.id) ?? false;
    const actual = invalid ? undefined : row.verification?.value.find(decision => decision.id === expected.id);
    return { id: expected.id, expectedPositive: expected.supported, state: invalid ? "invalid" : actual ? "valid" : "missing",
      passed: Boolean(actual && (expected.acceptableCategories ?? [expected.category]).includes(actual.category!) && actual.supported === expected.supported),
      falseAccepted: Boolean(actual && !expected.supported && actual.supported), falseRejected: Boolean(actual && expected.supported && !actual.supported) };
  });
}
function casePassed(item: Case, row: Row) {
  return row.verification?.validation?.status === "complete" && row.verification.value.length === item.candidates.length
    && candidateResults(item, row).every(candidate => candidate.passed);
}
export function summarizeConditionsComparison(data: Dataset, rows: Row[], requests: Request[] = []) {
  return Object.fromEntries(suites.conditions.versions.map(version => {
    const group = rows.filter(row => row.version === version), complete = group.filter(row => row.execution === "completed");
    const candidates = group.flatMap(row => candidateResults(data.cases.find(item => item.id === row.id)!, row));
    const sent = requests.filter(request => request.caseId.endsWith(`:${version}`));
    const known = sent.filter(request => request.estimatedCost !== null);
    const times = group.flatMap(row => (row.attempts ?? row.verification?.attempts ?? []).map(attempt => attempt.durationMs)).sort((a, b) => a - b);
    return [version, { exactInputs: { planned: group.length, completed: complete.length, passed: complete.filter(row => row.passed).length,
      failed: complete.filter(row => !row.passed).length, errors: group.filter(row => row.execution === "error").length,
      notRun: group.filter(row => row.execution === "not_run").length },
      candidates: { planned: candidates.length, positivePlanned: candidates.filter(candidate => candidate.expectedPositive).length,
        negativePlanned: candidates.filter(candidate => !candidate.expectedPositive).length,
        positiveEvaluated: candidates.filter(candidate => candidate.expectedPositive && candidate.state === "valid").length,
        negativeEvaluated: candidates.filter(candidate => !candidate.expectedPositive && candidate.state === "valid").length,
        passed: candidates.filter(candidate => candidate.passed).length,
        falseAccepted: candidates.filter(candidate => candidate.falseAccepted).length, falseRejected: candidates.filter(candidate => candidate.falseRejected).length,
        invalid: candidates.filter(candidate => candidate.state === "invalid").length, missing: candidates.filter(candidate => candidate.state === "missing").length },
      http: { requests: sent.length, unknownCosts: sent.length - known.length, knownEstimatedUsd: known.reduce((sum, request) => sum + request.estimatedCost!, 0),
        estimatedUsd: sent.length === known.length ? known.reduce((sum, request) => sum + request.estimatedCost!, 0) : null,
        totalTokens: sent.every(request => request.totalTokens !== null) ? sent.reduce((sum, request) => sum + request.totalTokens!, 0) : null },
      latency: { observed: times.length, p50Ms: times[Math.ceil(times.length * .5) - 1] ?? null, p95Ms: times[Math.ceil(times.length * .95) - 1] ?? null } }];
  }));
}
function recordingComplete(data: Dataset, suite: Suite, rows: Row[], requests: Request[], runId: string) {
  const expected = plannedRows(data, suite);
  return rows.length === expected.length && new Set(rows.map(row => `${row.id}:${row.version}`)).size === expected.length
    && expected.every(item => rows.some(row => row.id === item.id && row.version === item.version && row.group === item.group))
    && rows.every(row => {
      const sent = requests.filter(request => request.caseId === `${row.id}:${row.version}`).length;
      return row.execution === "completed" ? Boolean(row.verification) && sent === 1 : row.execution === "error" ? Boolean(row.error) && sent <= 1
        : Boolean(row.notRunReason) && !row.verification && !row.passed && sent === 0;
    })
    && requests.every(request => request.operation === "support" && request.turn === 1 && request.requestId === `${runId}:${request.caseId}`
      && rows.some(row => `${row.id}:${row.version}` === request.caseId && row.execution !== "not_run"))
    && requests.length <= suites[suite].limits.requests;
}

async function run(suite: Suite) {
  const frozen = await json(manifestPath(suite)), before = await snapshot(suite); assert.deepEqual(before, frozen, "Code, inputs, settings and dependencies must match before HTTP");
  const data = await loadInputs(suite), { versions, limits } = suites[suite], runId = randomUUID();
  const dir = new URL(`.runtime/c1-support-${suite}-development/`, root); await mkdir(dir, { recursive: true });
  const output = new URL(`${runId}.json`, dir);
  await writeFile(new URL(`attempt-${contentHash(frozen)}.json`, dir), JSON.stringify({ runId, manifestHash: contentHash(frozen), output: output.pathname }) + "\n", { flag: "wx" });
  const guard = createC1ValidationGuard(fetch, Date.now, guardLimits(suite));
  const deadline = AbortSignal.timeout(limits.deadlineMs), rows = plannedRows(data, suite);
  const summary = () => suite === "intent" ? summarizeIntentComparison(data, rows) : summarizeConditionsComparison(data, rows, guard.requests);
  const artifact = { version: 1, runId, suite, stage: before.stage, scope: "Real fixed-input support classification; no retrieval, Agent, SQL, QQ, business actions or final reply evaluation.",
    manifest: frozen, actualSettings: null as typeof before.settings | null,
    startedAt: new Date().toISOString(), finishedAt: null as string | null, rows, requests: guard.requests,
    usage: guard.usage(), summary: summary(), codeStable: false, integrityPassed: false,
    recordingComplete: false, executionComplete: false, usageComplete: false, stopReason: null as string | null };
  const save = async () => { artifact.usage = guard.usage(); artifact.summary = summary(); await writeFile(output, JSON.stringify(artifact, null, 2) + "\n"); };
  await save();
  try {
    const variants = await clients(suite, guard);
    artifact.actualSettings = Object.fromEntries(versions.map(version => [version, variants[version].settings]));
    assert.deepEqual(artifact.actualSettings, frozen.settings, "Actual execution clients must match the frozen settings before HTTP");
    planned: for (const [index, item] of data.cases.entries()) for (const version of index % 2 ? [...versions].reverse() : versions) {
      if (deadline.aborted || guard.stopped()) break planned;
      const row = rows.find(row => row.id === item.id && row.version === version)!, client = variants[version], start = guard.requests.length;
      guard.setActive({ caseId: `${item.id}:${version}`, turn: 1, requestId: `${runId}:${item.id}:${version}`, signal: deadline });
      let attempts: EvidenceSupportAttempt[] = [];
      try {
        row.verification = await verifyEvidenceSupport({ client, query: item.query, scope: item.scope, candidates: item.candidates });
        attempts = row.verification.attempts;
        assert.ok(validateEvidenceSupportVerification(row.verification, { query: item.query, scope: item.scope, candidates: item.candidates, settings: client.settings }));
        assert.equal(attempts.length, 1);
        if (suite === "intent") assert.equal(row.verification.validation!.status, "complete");
        row.passed = casePassed(item, row); row.execution = "completed";
      } catch (error) {
        if (error instanceof EvidenceSupportError) attempts = error.attempts;
        row.execution = "error"; row.error = error instanceof EvidenceSupportError ? error.code : "verification_incomplete";
      }
      row.attempts = attempts;
      const sent = guard.requests.map((request, i) => ({ request, i })).filter(value => value.i >= start && value.request.operation === "support");
      if (sent.length === attempts.length) attempts.forEach((attempt, i) => guard.record(sent[i]!.i, attempt.totalTokens, attempt.costUsd));
      await save(); console.log(`${item.id} ${version}: ${row.execution}; ${row.passed ? "passed" : "not_passed"}; ${row.verification?.value.map(decision => `${decision.id}:${decision.category}`).join(",") ?? row.error}`);
    }
  } finally {
    artifact.stopReason = rows.some(row => row.execution === "not_run") ? guard.stopped() ?? (deadline.aborted ? "run_deadline" : "execution_interrupted") : null;
    for (const row of rows) if (row.execution === "not_run") row.notRunReason = artifact.stopReason!;
    guard.seal(); artifact.finishedAt = new Date().toISOString();
    try { artifact.codeStable = contentHash(await snapshot(suite)) === contentHash(before); } catch { artifact.codeStable = false; }
    artifact.recordingComplete = recordingComplete(data, suite, rows, guard.requests, runId);
    artifact.executionComplete = rows.every(row => row.execution !== "not_run");
    artifact.usageComplete = guard.requests.every(request => request.usageRecorded && request.estimatedCost !== null && request.totalTokens !== null);
    // Retain legacy integrity semantics; conditions separates faithful recording from execution and known usage.
    artifact.integrityPassed = artifact.codeStable && artifact.recordingComplete && contentHash(artifact.actualSettings) === contentHash(frozen.settings) && (suite === "conditions" ||
      (rows.every(row => row.execution === "completed") && guard.requests.length === limits.requests && artifact.usageComplete));
    await save(); console.log(JSON.stringify({ runId, integrityPassed: artifact.integrityPassed, executionComplete: artifact.executionComplete,
      usageComplete: artifact.usageComplete, summary: artifact.summary, usage: artifact.usage }));
  }
}

export async function checkSupportIntentDevelopment(suite: Suite = "intent") {
  const data = await loadInputs(suite), rows = plannedRows(data, suite);
  assert.equal(rows.length, suites[suite].limits.requests);
  const item = data.cases.find(item => expectedFor(item).some(expected => !expected.supported))!;
  if (suite === "intent") {
    const summary = summarizeIntentComparison(data, [{ id: item.id, group: item.group, version: suites.intent.versions[0], execution: "not_run", passed: false }])[suites.intent.versions[0]]!;
    assert.equal(summary.planned, 1); assert.equal(summary.completed, 0); assert.equal(summary.passed, 0); assert.equal(summary.errorsOrNotRun, 1);
    assert.equal(summary.p50Ms, null);
  } else {
    const version = suites.conditions.versions[0], summary = summarizeConditionsComparison(data, rows)[version]!;
    assert.equal(summary.exactInputs.planned, 12); assert.equal(summary.exactInputs.notRun, 12);
    assert.equal(summary.candidates.falseAccepted, 0); assert.equal(summary.candidates.falseRejected, 0);
    assert.equal(summary.candidates.positiveEvaluated + summary.candidates.negativeEvaluated, 0);
    assert.equal(summary.candidates.missing, data.cases.reduce((sum, row) => sum + row.candidates.length, 0));
    assert.equal(summary.latency.p50Ms, null);
    const multi = data.cases.find(row => row.candidates.length > 1)!; assert.ok(multi, "The conditions suite must exercise independent multi-candidate decisions");
    const verification = { value: expectedFor(multi).map(expected => ({ id: expected.id, category: expected.category, supported: expected.supported,
      quote: expected.supported ? expected.evidenceQuote : null, reason: "测试原文依据" })).reverse(), attempts: [], requestHash: "synthetic", inputHash: "synthetic",
      validation: { status: "complete" as const, outputHash: null, invalidDecisions: [] } };
    const row: Row = { id: multi.id, group: multi.group, version, execution: "completed", passed: true, verification };
    assert.equal(casePassed(multi, row), true, "Candidate order cannot change scoring");
    const swapped = structuredClone(row);
    for (const decision of swapped.verification!.value) {
      decision.supported = !decision.supported; decision.category = decision.supported ? "direct_fact" : "limitation_only";
    }
    swapped.passed = casePassed(multi, swapped); assert.equal(swapped.passed, false);
    const wrong = summarizeConditionsComparison(data, [swapped])[version]!.candidates;
    assert.equal(wrong.falseAccepted, expectedFor(multi).filter(expected => !expected.supported).length);
    assert.equal(wrong.falseRejected, expectedFor(multi).filter(expected => expected.supported).length);
    assert.equal(wrong.positiveEvaluated + wrong.negativeEvaluated, multi.candidates.length);
    const invalidId = row.verification!.value.pop()!.id;
    row.verification!.validation = { status: "partial", outputHash: null, invalidDecisions: [{ id: invalidId, code: "invalid_quote" }] };
    row.passed = casePassed(multi, row); assert.equal(row.passed, false);
    const partial = summarizeConditionsComparison(data, [row])[version]!.candidates;
    assert.equal(partial.invalid, 1); assert.equal(partial.falseAccepted, 0); assert.equal(partial.falseRejected, 0);
    assert.equal(partial.positiveEvaluated + partial.negativeEvaluated, multi.candidates.length - 1);
    const malformed = structuredClone(data); malformed.cases[0]!.expectedByCandidate = [];
    assert.throws(() => checkInputs(malformed, suite));
  }
  const runId = "synthetic", guard = createC1ValidationGuard(async () => new Response("{}", { status: 200 }), Date.now, guardLimits(suite));
  const row = rows[0]!; guard.setActive({ caseId: `${row.id}:${row.version}`, turn: 1, requestId: `${runId}:${row.id}:${row.version}`, signal: new AbortController().signal });
  await guard.fetchFor("support")("https://synthetic.invalid/support");
  assert.equal(guard.usage().support.estimatedCost, null); assert.equal(guard.usage().support.unknownCosts, 1);
  if (suite === "conditions") assert.equal(summarizeConditionsComparison(data, rows, guard.requests)[row.version]!.http.estimatedUsd, null);
  guard.record(0, null, null); guard.seal();
  row.execution = "error"; row.error = "provider_error";
  for (const skipped of rows.filter(row => row.execution === "not_run")) skipped.notRunReason = "run_deadline";
  assert.equal(recordingComplete(data, suite, rows, guard.requests, runId), true, "Recorded failures and budget skips retain the full denominator");
  assert.equal(recordingComplete(data, suite, rows.slice(1), guard.requests, runId), false);
  assert.equal(rows.every(row => row.execution !== "not_run"), false);
  let sent = 0;
  const budget = createC1ValidationGuard(async () => { sent++; return new Response("{}"); }, Date.now, guardLimits(suite));
  budget.setActive({ caseId: "budget", turn: 1, requestId: "budget", signal: new AbortController().signal });
  for (let i = 0; i < suites[suite].limits.requests; i++) await budget.fetchFor("support")("https://synthetic.invalid/support");
  await assert.rejects(budget.fetchFor("support")("https://synthetic.invalid/support"), /operation_request_limit/);
  assert.equal(sent, suites[suite].limits.requests);
  assert.equal(budget.usage().support.estimatedCost, null, "Missing usage cannot become free requests");
  budget.seal();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), suiteIndex = args.indexOf("--suite"), suite = suiteIndex < 0 ? "intent" : args[suiteIndex + 1];
  if (suiteIndex >= 0) args.splice(suiteIndex, 2);
  assert.ok(suite === "intent" || suite === "conditions", "--suite must be intent or conditions");
  assert.equal(args.length, 1, "Use [--suite intent|conditions] --check|--freeze|--inspect|--live");
  const mode = args[0];
  if (mode === "--freeze") { await writeFile(new URL(manifestPath(suite), root), JSON.stringify(await snapshot(suite), null, 2) + "\n", { flag: "wx" }); console.log("Frozen without HTTP"); }
  else if (mode === "--inspect") { assert.deepEqual(await snapshot(suite), await json(manifestPath(suite))); console.log("Frozen inputs/settings/code/dependencies match; HTTP=0"); }
  else if (mode === "--live") await run(suite);
  else if (mode === "--check") { await checkSupportIntentDevelopment(suite); console.log(`${suite}: input coverage, candidate scoring, unknown usage and preserved denominator passed; HTTP=0`); }
  else throw new Error("Use --check, --freeze, --inspect or --live. Live requires matching frozen inputs and code.");
}
