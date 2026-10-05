import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createEvidenceSupportClient, EvidenceSupportError, verifyEvidenceSupport, type EvidenceSupportCategory,
  type EvidenceSupportClient, type EvidenceSupportAttempt, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import { scopeDocuments, type RetrievalScope } from "../src/retrieval-ranking.ts";
import { loadAcceptanceDataset } from "./acceptance-data.ts";

const root = new URL("../", import.meta.url), hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
type Case = { id: string; pair: string; corpus: string; sourceId: string; query: string; scope: RetrievalScope;
  expected: { category: EvidenceSupportCategory; supported: boolean; evidenceQuote: string; reason: string } };

export async function loadC1SupportDevelopment() {
  const path = "data/c1-support-development.json", manifest = await json(path.replace(".json", "-source.json"));
  const bytes = await readFile(new URL(path, root));
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, "fixed-before-support-development-execution");
  assert.deepEqual(manifest.dataset, { path, sha256: hash(bytes), bytes: bytes.length });
  for (const [path, expected] of Object.entries(manifest.baseFiles)) assert.equal(hash(await readFile(new URL(path, root))), expected, path);
  const data = JSON.parse(bytes.toString()) as { version: number; stage: string; cases: Case[] };
  assert.equal(data.version, 1); assert.equal(data.stage, "development-not-validation");
  const corpora = (await loadAcceptanceDataset("validation")).corpora;
  assert.deepEqual(data.cases.map(row => row.id), Array.from({ length: 6 }, (_, n) => `c1-pair-${String(n + 1).padStart(3, "0")}`));
  assert.equal(new Set(data.cases.map(row => row.query)).size, 6);
  const pairs = new Set(data.cases.map(row => row.pair)); assert.equal(pairs.size, 3);
  for (const pair of pairs) {
    const rows = data.cases.filter(row => row.pair === pair); assert.equal(rows.length, 2);
    assert.equal(rows[0]!.corpus, rows[1]!.corpus); assert.equal(rows[0]!.sourceId, rows[1]!.sourceId); assert.deepEqual(rows[0]!.scope, rows[1]!.scope);
    assert.deepEqual(rows.map(row => row.expected.supported), [true, false]);
  }
  for (const row of data.cases) {
    assert.ok(row.query.trim() && row.query.length <= 500 && row.expected.reason.trim());
    assert.ok(["direct_fact", "boundary_answer", "limitation_only"].includes(row.expected.category));
    assert.equal(row.expected.supported, row.expected.category === "direct_fact" || row.expected.category === "boundary_answer");
    const docs = corpora.find(corpus => corpus.id === row.corpus)?.documents ?? [];
    assert.ok(scopeDocuments(docs, row.scope).find(doc => doc.id === row.sourceId)?.body.includes(row.expected.evidenceQuote), `${row.id} scope/quote`);
  }
  assert.deepEqual(manifest.counts, { pairs: 3, questions: 6, direct_fact: 2, boundary_answer: 1, limitation_only: 3, accepted: 3, rejected: 3 });
  for (const category of ["direct_fact", "boundary_answer", "limitation_only"] as const) assert.equal(data.cases.filter(row => row.expected.category === category).length, manifest.counts[category]);
  return { data, manifest, corpora };
}

export async function runC1SupportDevelopment() {
  const data = await loadC1SupportDevelopment(), runId = randomUUID();
  const codePaths = ["scripts/c1-support-check.ts", "src/evidence-support.ts", "src/evidence-acceptance.ts", "src/retrieval-ranking.ts", "src/agent.ts"];
  const codeHashes = async () => Object.fromEntries(await Promise.all(codePaths.map(async path => [path, hash(await readFile(new URL(path, root)))])));
  const before = await codeHashes();
  let client: EvidenceSupportClient | null = null;
  try { client = await createEvidenceSupportClient({ profile: "typed", timeoutMs: 60_000 }); } catch { /* Every planned row remains an error below. */ }
  const rows: Array<{ input: Case; status: "passed" | "failed" | "error"; error?: string; verification?: EvidenceSupportVerification; attempts: EvidenceSupportAttempt[] }> = [];
  for (const input of data.data.cases) {
    const row: typeof rows[number] = { input, status: "error", attempts: [] }; rows.push(row);
    if (!client) { row.error = "Support client unavailable before requests"; continue; }
    const document = data.corpora.find(corpus => corpus.id === input.corpus)!.documents.find(doc => doc.id === input.sourceId)!;
    try {
      // Fixed score/rank only satisfy the support client schema; no ranking or threshold experiment is claimed.
      row.verification = await verifyEvidenceSupport({ client, query: input.query, scope: input.scope, candidates: [{ ...document, rank: 1, score: 1 }] });
      row.attempts = row.verification.attempts;
      const decision = row.verification.value[0]!;
      row.status = decision.category === input.expected.category && decision.supported === input.expected.supported ? "passed" : "failed";
    } catch (error) {
      row.attempts = error instanceof EvidenceSupportError ? error.attempts : [];
      row.error = error instanceof EvidenceSupportError ? error.message : "Support verification unavailable";
    }
  }
  const after = await codeHashes(), attempts = rows.flatMap(row => row.attempts);
  const codeStable = JSON.stringify(before) === JSON.stringify(after), errors = rows.filter(row => row.status === "error").length;
  const summary = { planned: 6, passed: rows.filter(row => row.status === "passed").length, failed: rows.filter(row => row.status === "failed").length, errors,
    providerRequests: attempts.length, usage: { supportTokens: errors || attempts.some(attempt => attempt.totalTokens === null) ? null : attempts.reduce((n, attempt) => n + attempt.totalTokens!, 0),
      estimatedUsd: errors || attempts.some(attempt => attempt.costUsd === null) ? null : attempts.reduce((n, attempt) => n + attempt.costUsd!, 0), rerankRequests: 0, estimatedCny: 0 } };
  const artifact = { version: 1, runId, executedAt: new Date().toISOString(), mode: "direct-support-unit-development", source: data.manifest,
    settings: client?.settings ?? null, codeStable, codeHashes: { before, after }, thresholdEvaluated: false, retrievalEvaluated: false,
    contextResolutionEvaluated: false, modelActionSelectionEvaluated: false, finalAnswerQualityEvaluated: false, summary, rows };
  const dir = new URL(".runtime/c1-context/", root); await mkdir(dir, { recursive: true });
  const path = new URL(`support-development-${runId}.json`, dir); await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ artifact: fileURLToPath(path), codeStable, promptVersion: client?.settings.promptVersion, ...summary }));
  return artifact;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every(arg => arg === "--live") && process.argv.slice(2).length <= 1, "Use --live only; default is schema-only and no network");
  if (!process.argv.includes("--live")) { const data = await loadC1SupportDevelopment(); console.log(JSON.stringify({ sha256: data.manifest.dataset.sha256, counts: data.manifest.counts, providerRequests: 0 })); }
  else { const result = await runC1SupportDevelopment(); if (!result.codeStable || result.summary.failed || result.summary.errors) process.exitCode = 1; }
}
