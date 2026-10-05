import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBailianClient, contentHash } from "../src/bailian.ts";
import { runRetrievalV2, type V2Dataset } from "./retrieval-v2.ts";
import { calibrateAcceptance, scoreAcceptance } from "./acceptance-calibrate.ts";

const dataset: V2Dataset = { source: { split: "development" }, corpora: [{ id: "synthetic", documents: [
  { id: "hours", title: "营业时间", body: "午餐十一点至十四点。", tags: [], shopId: null },
], questions: [
  { id: "positive", query: "午餐时间", shopId: null, suite: "standard", relevant: ["hours"] },
  { id: "negative", query: "钠含量", shopId: null, suite: "no_answer", relevant: [] },
] }] };
const client = createBailianClient({ env: { DASHSCOPE_API_KEY: "mock", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
  fetch: async (_url, init) => { const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: body.query === "午餐时间" ? .8 : .4 }], usage: { total_tokens: 10 } })); } });
const directory = await mkdtemp(join(tmpdir(), "dave-calibration-"));
try {
  const { report } = await runRetrievalV2({ label: "mock calibration", dataset, modes: ["M4"], allowRemote: true, client,
    cacheDir: join(directory, "cache"), outputDir: join(directory, "out") });
  const before = structuredClone(report);
  const calibration = calibrateAcceptance(report);
  assert.deepEqual(calibration.selected, { mode: "score", threshold: .41 });
  assert.equal(calibration.candidate.totals.acceptedRecallAt5, 1);
  assert.equal(calibration.candidate.totals.falseAccepts, 0);
  assert.equal(calibration.baseline.totals.falseAccepts, 1);
  assert.equal(calibration.trials.length, 101);
  assert.deepEqual(report, before, "calibration cannot rewrite raw evidence");
  const tooStrict = scoreAcceptance(report, { mode: "score", threshold: .81 });
  assert.equal(tooStrict.totals.falseRejectRate, 1);
  assert.equal(tooStrict.meetsApplicableTargets, false, "rejecting every answer cannot meet the gate");
  const overlap = structuredClone(report);
  overlap.results.find(row => row.id === "negative")!.ranking[0]!.score = .9;
  const failed = calibrateAcceptance(overlap);
  assert.equal(failed.selected, null);
  assert.equal(failed.decision, "no_eligible_score_threshold");
  assert.equal(failed.candidate.totals.falseRejectRate, 1);
  const validation = structuredClone(report); validation.snapshot.dataset.source = { split: "validation" };
  validation.snapshot.datasetHash = contentHash(validation.snapshot.dataset);
  assert.throws(() => calibrateAcceptance(validation), /开发集/);
  const missing = structuredClone(report); missing.results.pop();
  assert.throws(() => calibrateAcceptance(missing), /完整/);
  const duplicate = structuredClone(report); duplicate.results[1] = duplicate.results[0]!;
  assert.throws(() => calibrateAcceptance(duplicate), /完整/);
  const badHash = structuredClone(report); badHash.snapshot.datasetHash = "wrong";
  assert.throws(() => calibrateAcceptance(badHash), /哈希/);
  const otherModel = structuredClone(report); otherModel.snapshot.settings.provider!.rerankModel = "other";
  assert.throws(() => calibrateAcceptance(otherModel), /绑定/);
  const otherFormat = structuredClone(report); (otherFormat.snapshot.settings.acceptance as { serialization: string }).serialization = "other";
  assert.throws(() => calibrateAcceptance(otherFormat), /绑定/);
  const otherCorpus = structuredClone(report); otherCorpus.snapshot.settings.acceptance.corpusHashes.synthetic = "other";
  assert.throws(() => calibrateAcceptance(otherCorpus), /绑定/);
  assert.equal(calibration.sourceReportHash, contentHash(report));
  console.log("PASS A1 calibration: fixed development grid, no validation tuning, replay preservation, missing/duplicate rejection, reject-all cannot pass; mock only.");
} finally { await rm(directory, { recursive: true, force: true }); }
