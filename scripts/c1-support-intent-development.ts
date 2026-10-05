import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createConfiguredModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { createEvidenceSupportClient, EvidenceSupportError, validateEvidenceSupportVerification, verifyEvidenceSupport,
  type EvidenceSupportCandidate, type EvidenceSupportCategory, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import type { RetrievalScope } from "../src/retrieval-ranking.ts";
import { c1ValidationCodeFiles, createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url), dataPath = "data/c1-support-intent-development.json", manifestPath = "data/c1-support-intent-development-manifest.json";
const versions = ["fact-support-typed-v5", "fact-support-typed-v6"] as const;
type Version = typeof versions[number];
const limits = { requests: 40, estimatedUsd: .15, deadlineMs: 8 * 60_000, timeoutMs: 60_000 };
type Case = { id: string; group: string; query: string; scope: RetrievalScope; candidates: EvidenceSupportCandidate[]; inputHash: string;
  expected: { category: EvidenceSupportCategory; acceptableCategories?: EvidenceSupportCategory[]; supported: boolean; evidenceQuote: string } };
type Dataset = { version: number; cases: Case[] };
type Row = { id: string; group: string; version: Version; execution: "not_run" | "completed" | "error";
  passed: boolean; verification?: EvidenceSupportVerification; error?: string };
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const hashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));

async function loadInputs() {
  const data = await json(dataPath) as Dataset;
  assert.equal(data.version, 1); assert.equal(data.cases.length, 20); assert.equal(new Set(data.cases.map(row => row.id)).size, 20);
  assert.deepEqual(["expanded", "language", "contextual"].map(group => data.cases.filter(row => row.group === group).length), [10, 8, 2]);
  assert.equal(data.cases.filter(row => row.expected.supported).length, 10);
  for (const row of data.cases) {
    assert.equal(row.inputHash, contentHash({ query: row.query, scope: row.scope, candidates: row.candidates }));
    assert.equal(row.candidates.length, 1, "All frozen classification pairs have one source; never silently expand the comparison");
    assert.ok(row.query.trim() && row.query.length <= 500 && row.candidates[0]!.body.includes(row.expected.evidenceQuote));
  }
  return data;
}

async function clients(guard?: ReturnType<typeof createC1ValidationGuard>) {
  const runtime = await createConfiguredModelRuntime({ ...process.env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-v4-pro" });
  const guardedFetch: typeof fetch = async (url, init) => {
    assert.ok(guard); const usage = guard.usage().support;
    if (usage.requests >= limits.requests || usage.knownEstimatedCost >= limits.estimatedUsd) throw new Error("Support intent experiment budget exhausted");
    return guard.fetchFor("support")(url, init);
  };
  return Object.fromEntries(await Promise.all(versions.map(async version => [version, await createEvidenceSupportClient({ profile: "typed",
    typedPromptVersion: version, modelSelection: "deepseek-v4-pro", timeoutMs: limits.timeoutMs,
    runtime: { model: runtime.model, complete: (context, options) => runtime.modelRuntime.complete(runtime.model, context,
      { ...options, ...(guard ? { fetch: guardedFetch } : {}) }) } })]))) as Record<Version, Awaited<ReturnType<typeof createEvidenceSupportClient>>>;
}

async function snapshot() {
  await loadInputs(); const variants = await clients();
  const files = [...new Set([...(await c1ValidationCodeFiles()), "scripts/c1-support-intent-development.ts", dataPath,
    "data/c1-support-development-v2.json", "data/c1-language-support-development.json", "data/c1-query-development.json",
    "data/c1-query-development-results.json", "data/c1-session-validation.json"])].sort();
  const settings = Object.fromEntries(versions.map(version => [version, variants[version].settings]));
  const stripPrompt = (version: Version) => { const { promptVersion: _version, promptHash: _hash, ...other } = variants[version].settings; return other; };
  assert.deepEqual(stripPrompt(versions[0]), stripPrompt(versions[1]), "Prompt content/version are the only settings variable");
  return { version: 1, stage: "exposed-development-fixed-input-support-prompt-ablation", limits, versions, settings,
    sourceHashes: await hashes(files), dependencies: await readC1ValidationDependencies() };
}

export function summarizeIntentComparison(data: Dataset, rows: Row[]) {
  return Object.fromEntries(versions.map(version => {
    const group = rows.filter(row => row.version === version), complete = group.filter(row => row.execution === "completed");
    const truth = (row: Row) => data.cases.find(item => item.id === row.id)!.expected.supported;
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

async function run() {
  const frozen = await json(manifestPath), before = await snapshot(); assert.deepEqual(before, frozen, "Code, inputs, settings and dependencies must match before HTTP");
  const data = await loadInputs(), guard = createC1ValidationGuard(), variants = await clients(guard), runId = randomUUID();
  const deadline = AbortSignal.timeout(limits.deadlineMs);
  const rows: Row[] = data.cases.flatMap(item => versions.map(version => ({ id: item.id, group: item.group, version, execution: "not_run", passed: false })));
  const artifact = { version: 1, runId, stage: before.stage, scope: "Real fixed-input support classification; no retrieval, Agent, SQL, QQ, business actions or final reply evaluation.",
    manifest: frozen, startedAt: new Date().toISOString(), finishedAt: null as string | null, rows, requests: guard.requests,
    usage: guard.usage(), summary: summarizeIntentComparison(data, rows), codeStable: false, integrityPassed: false };
  const dir = new URL(".runtime/c1-support-intent-development/", root); await mkdir(dir, { recursive: true });
  const output = new URL(`${runId}.json`, dir);
  const save = async () => { artifact.usage = guard.usage(); artifact.summary = summarizeIntentComparison(data, rows); await writeFile(output, JSON.stringify(artifact, null, 2) + "\n"); };
  await save();
  try {
    for (const [index, item] of data.cases.entries()) for (const version of index % 2 ? [...versions].reverse() : versions) {
      if (deadline.aborted || guard.stopped()) break;
      const row = rows.find(row => row.id === item.id && row.version === version)!, client = variants[version], start = guard.requests.length;
      guard.setActive({ caseId: `${item.id}:${version}`, turn: 1, requestId: `${runId}:${item.id}:${version}`, signal: deadline });
      let attempts: Array<{ totalTokens: number | null; costUsd: number | null }> = [];
      try {
        row.verification = await verifyEvidenceSupport({ client, query: item.query, scope: item.scope, candidates: item.candidates });
        attempts = row.verification.attempts;
        assert.ok(validateEvidenceSupportVerification(row.verification, { query: item.query, scope: item.scope, candidates: item.candidates, settings: client.settings }));
        assert.equal(row.verification.validation!.status, "complete"); assert.equal(attempts.length, 1);
        const decision = row.verification.value[0]!;
        row.passed = (item.expected.acceptableCategories ?? [item.expected.category]).includes(decision.category!) && decision.supported === item.expected.supported;
        row.execution = "completed";
      } catch (error) {
        if (error instanceof EvidenceSupportError) attempts = error.attempts;
        row.execution = "error"; row.error = error instanceof EvidenceSupportError ? error.code : "verification_incomplete";
      }
      const sent = guard.requests.map((request, i) => ({ request, i })).filter(value => value.i >= start && value.request.operation === "support");
      if (sent.length === attempts.length) attempts.forEach((attempt, i) => guard.record(sent[i]!.i, attempt.totalTokens, attempt.costUsd));
      await save(); console.log(`${item.id} ${version}: ${row.execution}; ${row.passed ? "passed" : "not_passed"}; ${row.verification?.value[0]?.category ?? row.error}`);
    }
  } finally {
    guard.seal(); artifact.finishedAt = new Date().toISOString(); artifact.codeStable = contentHash(await snapshot()) === contentHash(before);
    artifact.integrityPassed = artifact.codeStable && rows.every(row => row.execution === "completed")
      && guard.requests.length === 40 && guard.requests.every(request => request.usageRecorded && request.estimatedCost !== null)
      && guard.usage().agent.requests === 0 && guard.usage().rerank.requests === 0;
    await save(); console.log(JSON.stringify({ runId, integrityPassed: artifact.integrityPassed, summary: artifact.summary, usage: artifact.usage }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "--freeze") { await writeFile(new URL(manifestPath, root), JSON.stringify(await snapshot(), null, 2) + "\n", { flag: "wx" }); console.log("Frozen without HTTP"); }
  else if (mode === "--inspect") { assert.deepEqual(await snapshot(), await json(manifestPath)); console.log("Frozen inputs/settings/code/dependencies match; HTTP=0"); }
  else if (mode === "--live") await run();
  else if (mode === "--check") {
    const data = await loadInputs(), item = data.cases.find(item => !item.expected.supported)!;
    const summary = summarizeIntentComparison(data, [{ id: item.id, group: item.group, version: versions[0], execution: "not_run", passed: false }])[versions[0]]!;
    assert.equal(summary.planned, 1); assert.equal(summary.completed, 0); assert.equal(summary.passed, 0); assert.equal(summary.errorsOrNotRun, 1);
    assert.equal(summary.p50Ms, null); console.log("Input coverage and unknown-row scoring passed; HTTP=0");
  } else throw new Error("Use --check, --freeze, --inspect or --live. Live requires matching frozen inputs and code.");
}
