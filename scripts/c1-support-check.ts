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
  expected: { category: EvidenceSupportCategory; acceptableCategories?: EvidenceSupportCategory[]; supported: boolean; evidenceQuote: string; reason: string } };
type Selection = "original" | "expanded" | "language";

export async function loadC1SupportDevelopment(selection: Selection = "original") {
  assert.ok(["original", "expanded", "language"].includes(selection));
  const path = selection === "language" ? "data/c1-language-support-development.json"
    : selection === "expanded" ? "data/c1-support-development-v2.json" : "data/c1-support-development.json", manifest = await json(path.replace(".json", "-source.json"));
  const bytes = await readFile(new URL(path, root));
  assert.equal(manifest.version, 1); assert.equal(manifest.stage, "fixed-before-support-development-execution");
  assert.deepEqual(manifest.dataset, { path, sha256: hash(bytes), bytes: bytes.length });
  if (selection === "language") {
    assert.equal(manifest.dataset.sha256, "925c5ce543c40192d85a36f46df4cc1545a3c99250f2522b1923eba950169163", "Language diagnostic inputs and gold frozen before execution");
    assert.equal(hash(await readFile(new URL(path.replace(".json", "-source.json"), root))), "9a6bbe566aa756e259fe22334d8d94db746f690056bab93d727c4d271e246d48", "Language provenance and scope frozen before execution");
  }
  for (const [path, expected] of Object.entries(manifest.baseFiles)) assert.equal(hash(await readFile(new URL(path, root))), expected, path);
  const data = JSON.parse(bytes.toString()) as { version: number; stage: string; cases: Case[] };
  assert.equal(data.version, selection === "expanded" ? 2 : 1); assert.equal(data.stage, "development-not-validation");
  const count = selection === "language" ? 8 : selection === "expanded" ? 10 : 6;
  if (selection === "expanded") assert.deepEqual(data.cases.slice(0, 6), (await json("data/c1-support-development.json")).cases, "original six questions and gold remain unchanged");
  const corpora = (await loadAcceptanceDataset("validation")).corpora;
  assert.deepEqual(data.cases.map(row => row.id), Array.from({ length: count }, (_, n) => `c1-${selection === "language" ? "language" : "pair"}-${String(n + 1).padStart(3, "0")}`));
  assert.equal(new Set(data.cases.map(row => row.query)).size, count);
  const pairs = new Set(data.cases.map(row => row.pair)); assert.equal(pairs.size, count / 2);
  for (const pair of pairs) {
    const rows = data.cases.filter(row => row.pair === pair); assert.equal(rows.length, 2);
    assert.equal(rows[0]!.corpus, rows[1]!.corpus); assert.equal(rows[0]!.sourceId, rows[1]!.sourceId); assert.deepEqual(rows[0]!.scope, rows[1]!.scope);
    assert.deepEqual(rows.map(row => row.expected.supported), [true, false]);
  }
  for (const row of data.cases) {
    assert.ok(row.query.trim() && row.query.length <= 500 && row.expected.reason.trim());
    assert.ok(["direct_fact", "boundary_answer", "limitation_only"].includes(row.expected.category));
    assert.equal(row.expected.supported, row.expected.category === "direct_fact" || row.expected.category === "boundary_answer");
    if (row.expected.acceptableCategories) {
      assert.equal(selection, "expanded"); assert.equal(row.expected.category, "boundary_answer");
      assert.deepEqual(row.expected.acceptableCategories, ["boundary_answer", "direct_fact"]);
    }
    const docs = corpora.find(corpus => corpus.id === row.corpus)?.documents ?? [];
    assert.ok(scopeDocuments(docs, row.scope).find(doc => doc.id === row.sourceId)?.body.includes(row.expected.evidenceQuote), `${row.id} scope/quote`);
  }
  assert.deepEqual(manifest.counts, { pairs: count / 2, questions: count, direct_fact: selection === "language" ? 3 : 2,
    boundary_answer: selection === "language" ? 1 : count / 2 - 2, limitation_only: count / 2, accepted: count / 2, rejected: count / 2 });
  for (const category of ["direct_fact", "boundary_answer", "limitation_only"] as const) assert.equal(data.cases.filter(row => row.expected.category === category).length, manifest.counts[category]);
  return { data, manifest, corpora };
}

export async function runC1SupportDevelopment(selection: Selection = "original") {
  const data = await loadC1SupportDevelopment(selection), runId = randomUUID();
  const codePaths = ["scripts/c1-support-check.ts", "src/evidence-support.ts", "src/evidence-acceptance.ts", "src/retrieval-ranking.ts", "src/agent.ts",
    data.manifest.dataset.path, data.manifest.dataset.path.replace(".json", "-source.json"),
    ...(selection === "language" ? Object.keys(data.manifest.baseFiles) : [])];
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
      if (row.verification.validation?.status !== undefined && row.verification.validation.status !== "complete") {
        row.error = "Support candidate validation incomplete; invalid decisions are not correct rejections"; continue;
      }
      const decision = row.verification.value[0]!;
      row.status = (input.expected.acceptableCategories ?? [input.expected.category]).includes(decision.category!)
        && decision.supported === input.expected.supported ? "passed" : "failed";
    } catch (error) {
      row.attempts = error instanceof EvidenceSupportError ? error.attempts : [];
      row.error = error instanceof EvidenceSupportError ? error.message : "Support verification unavailable";
    }
  }
  const after = await codeHashes(), attempts = rows.flatMap(row => row.attempts);
  const codeStable = JSON.stringify(before) === JSON.stringify(after), errors = rows.filter(row => row.status === "error").length;
  const summary = { planned: data.data.cases.length, passed: rows.filter(row => row.status === "passed").length, failed: rows.filter(row => row.status === "failed").length, errors,
    providerRequests: attempts.length,
    supportValidation: { partialRows: rows.filter(row => row.verification?.validation?.status === "partial").length,
      unavailableRows: rows.filter(row => row.verification?.validation?.status === "unavailable").length,
      invalidDecisions: rows.reduce((sum, row) => sum + (row.verification?.validation?.invalidDecisions.length ?? 0), 0) }, usage: { supportTokens: attempts.length !== data.data.cases.length || attempts.some(attempt => attempt.totalTokens === null) ? null : attempts.reduce((n, attempt) => n + attempt.totalTokens!, 0),
      estimatedUsd: attempts.length !== data.data.cases.length || attempts.some(attempt => attempt.costUsd === null) ? null : attempts.reduce((n, attempt) => n + attempt.costUsd!, 0), rerankRequests: 0, estimatedCny: 0 } };
  const artifact = { version: selection === "expanded" ? 2 : 1, runId, executedAt: new Date().toISOString(), mode: "direct-support-unit-development", datasetSelection: selection, source: data.manifest,
    settings: client?.settings ?? null, codeStable, codeHashes: { before, after }, thresholdEvaluated: false, retrievalEvaluated: false,
    contextResolutionEvaluated: false, modelActionSelectionEvaluated: false, finalAnswerQualityEvaluated: false, summary, rows };
  const dir = new URL(".runtime/c1-context/", root); await mkdir(dir, { recursive: true });
  const path = new URL(`support-development-${runId}.json`, dir); await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ artifact: fileURLToPath(path), codeStable, promptVersion: client?.settings.promptVersion, ...summary }));
  return artifact;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => ["--live", "--expanded", "--language"].includes(arg)) && new Set(args).size === args.length
    && !(args.includes("--expanded") && args.includes("--language")), "Use --live and one optional --expanded/--language selection; default is schema-only and no network");
  const selection = args.includes("--language") ? "language" : args.includes("--expanded") ? "expanded" : "original";
  if (!args.includes("--live")) { const data = await loadC1SupportDevelopment(selection); console.log(JSON.stringify({ sha256: data.manifest.dataset.sha256, counts: data.manifest.counts, providerRequests: 0 })); }
  else { const result = await runC1SupportDevelopment(selection); if (!result.codeStable || result.summary.failed || result.summary.errors) process.exitCode = 1; }
}
