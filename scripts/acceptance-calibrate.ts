import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { contentHash, rerankInstruction } from "../src/bailian.ts";
import { acceptEvidence, evidenceAcceptanceBinding, evidenceAcceptanceVersion, type EvidenceAcceptanceConfig } from "../src/evidence-acceptance.ts";
import { validateV2Dataset, type V2Dataset, type V2Result } from "./retrieval-v2.ts";

type CalibrationInput = { runId: string; status: string; snapshot: { dataset: V2Dataset; datasetHash: string;
  settings: { provider: { rerankModel: string; rerankInstruction: string } | null;
    acceptance: { model: string; serialization: string; version: string; corpusHashes: Record<string, string> } } };
  plan: Array<Pick<V2Result, "corpus" | "id" | "mode">>; results: V2Result[] };

// Replay a measured ranking. The production acceptance function never receives labels.
export function scoreAcceptance(report: CalibrationInput, config: EvidenceAcceptanceConfig) {
  if (config.mode === "support") throw new Error("事实支持策略必须评分实际判别结果；不能从 raw 分数重放冒充判别。");
  validateV2Dataset(report.snapshot.dataset);
  const groups = report.snapshot.dataset.corpora.map(corpus => {
    let answerable = 0, rawHits = 0, acceptedRecallSum = 0, falseRejects = 0;
    let noAnswer = 0, falseAccepts = 0, scopeCases = 0, scopeNonempty = 0, scopeViolations = 0;
    let deferred = 0, failed = 0, missing = 0, covered = 0, measured = 0;
    const cases = corpus.questions.map(question => {
      const row = report.results.find(item => item.corpus === corpus.id && item.id === question.id && item.mode === "M4");
      if (question.deferredReason) { deferred++; return { id: question.id, status: "deferred", reason: question.deferredReason }; }
      if (question.relevant.length) answerable++;
      if (!row) { missing++; return { id: question.id, status: "missing" }; }
      if (row.status !== "ok") { failed++; return { id: question.id, status: row.status }; }
      const accepted = acceptEvidence({ config, scope: question, documents: corpus.documents, ranking: row.ranking, query: question.query });
      const ids = accepted.accepted.map(item => item.id);
      measured++; if (ids.length) covered++;
      // Gold is read only here in the checker, after the policy has decided.
      const rawHit = question.relevant.some(id => row.ranking.slice(0, 5).some(item => item.id === id));
      const acceptedHit = question.relevant.some(id => ids.includes(id));
      const recall = question.relevant.length ? question.relevant.filter(id => ids.includes(id)).length / question.relevant.length : null;
      if (recall !== null) acceptedRecallSum += recall;
      if (rawHit) { rawHits++; if (!acceptedHit) falseRejects++; }
      if (question.suite === "no_answer") { noAnswer++; if (ids.length) falseAccepts++; }
      if (question.suite === "scope") { scopeCases++; if (!question.relevant.length && ids.length) scopeNonempty++; }
      if (ids.some(id => question.forbidden?.includes(id))) scopeViolations++;
      return { id: question.id, status: "measured", acceptedIds: ids, recall, falseReject: rawHit && !acceptedHit,
        falseAccept: question.suite === "no_answer" && ids.length > 0, scopeAbstentionFailure: question.suite === "scope" && !question.relevant.length && ids.length > 0 };
    });
    return { corpus: corpus.id, planned: corpus.questions.length, measured, deferred, failed, missing,
      answerable, rawHits, acceptedRecallSum, falseRejects, noAnswer, falseAccepts, scopeCases, scopeNonempty, scopeViolations, covered, cases };
  });
  const sum = (key: Exclude<keyof typeof groups[number], "corpus" | "cases">) => groups.reduce((total, group) => total + group[key], 0);
  const answerable = sum("answerable"), rawHits = sum("rawHits"), noAnswer = sum("noAnswer");
  const recall = answerable ? sum("acceptedRecallSum") / answerable : null;
  const falseRejectRate = rawHits ? sum("falseRejects") / rawHits : null;
  const incomplete = sum("failed") + sum("missing");
  return { config, groups, totals: { planned: sum("planned"), measured: sum("measured"), deferred: sum("deferred"), incomplete,
    acceptedRecallAt5: recall, answerable, falseRejects: sum("falseRejects"), falseRejectDenominator: rawHits, falseRejectRate,
    falseAccepts: sum("falseAccepts"), noAnswer, scopeAbstentionFailures: sum("scopeNonempty"), scopeCases: sum("scopeCases"),
    scopeViolations: sum("scopeViolations"), covered: sum("covered") },
    meetsApplicableTargets: incomplete === 0 && noAnswer > 0 && sum("falseAccepts") === 0 && sum("scopeViolations") === 0 && sum("scopeNonempty") === 0
      && recall !== null && recall >= .8 && falseRejectRate !== null && falseRejectRate <= .1 };
}

export function calibrateAcceptance(report: CalibrationInput) {
  const source = report.snapshot.dataset.source as { split?: string } | null;
  if (source?.split !== "development") throw new Error("只允许开发集校准；验证集不能用于选择阈值。");
  if (report.snapshot.datasetHash !== contentHash(report.snapshot.dataset)) throw new Error("数据快照哈希不符。");
  const { provider, acceptance } = report.snapshot.settings;
  const corpusHashes = Object.fromEntries(report.snapshot.dataset.corpora.map(c => [c.id, contentHash(c.documents)]));
  if (provider?.rerankModel !== evidenceAcceptanceBinding.model || provider.rerankInstruction !== rerankInstruction
    || acceptance?.model !== evidenceAcceptanceBinding.model || acceptance.serialization !== evidenceAcceptanceBinding.serialization
    || acceptance.version !== evidenceAcceptanceVersion || !acceptance.corpusHashes
    || Object.keys(acceptance.corpusHashes).length !== Object.keys(corpusHashes).length
    || Object.entries(corpusHashes).some(([id, hash]) => acceptance.corpusHashes[id] !== hash)) {
    throw new Error("校准原始报告的模型、指令、文本格式或语料绑定不匹配。");
  }
  const expected = report.snapshot.dataset.corpora.flatMap(corpus => corpus.questions.map(q => `${corpus.id}:${q.id}:M4`)).sort();
  const key = (row: Pick<V2Result, "corpus" | "id" | "mode">) => `${row.corpus}:${row.id}:${row.mode}`;
  if (report.status !== "completed" || JSON.stringify(report.plan.map(key).sort()) !== JSON.stringify(expected)
    || JSON.stringify(report.results.map(key).sort()) !== JSON.stringify(expected) || report.results.some(row => row.status !== "ok")) {
    throw new Error("校准需要完整且无重复的 M4 开发原始结果，失败/缺项/延后不能参与选阈值。");
  }
  const baseline = scoreAcceptance(report, { mode: "off" });
  // Fixed, declared grid; the validation split is never consulted to refine it.
  const trials = Array.from({ length: 101 }, (_, i) => scoreAcceptance(report, { mode: "score", threshold: i / 100 }));
  const eligible = trials.filter(trial => trial.meetsApplicableTargets);
  const selected = eligible[0] ?? null;
  const diagnostic = [...trials].sort((a, b) => a.totals.falseAccepts - b.totals.falseAccepts
    || (b.totals.acceptedRecallAt5 ?? 0) - (a.totals.acceptedRecallAt5 ?? 0)
    || (a.config.mode === "score" ? a.config.threshold : 0) - (b.config.mode === "score" ? b.config.threshold : 0))[0]!;
  return { version: 1, createdAt: new Date().toISOString(), sourceRunId: report.runId, sourceReportHash: contentHash(report), datasetHash: report.snapshot.datasetHash,
    binding: { ...evidenceAcceptanceBinding, policyVersion: evidenceAcceptanceVersion,
      corpusHashes: Object.fromEntries(report.snapshot.dataset.corpora.map(c => [c.id, contentHash(c.documents)])) },
    selectionRule: "M4 development only; fixed 0.00..1.00 grid step 0.01; choose smallest threshold meeting all applicable targets including abstention on scope negatives. If none, retain failed diagnostic only; do not promote.",
    selected: selected?.config ?? null, diagnostic: diagnostic.config, eligibleCount: eligible.length,
    decision: selected ? "development_candidate_only" : "no_eligible_score_threshold",
    baseline, candidate: selected ?? diagnostic,
    trials: trials.map(({ config, totals, meetsApplicableTargets }) => ({ config, totals, meetsApplicableTargets })),
    limitations: "Offline cache replay, not an independent model repetition or latency measurement. Scope abstention is reported separately from authorization. A development candidate does not pass fixed validation or deferred C1 cases." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { report: { type: "string" }, output: { type: "string" } }, strict: true, allowPositionals: false });
  if (!values.report || !values.output) throw new Error("用法：node scripts/acceptance-calibrate.ts --report RAW_REPORT.json --output CALIBRATION.json");
  const result = calibrateAcceptance(JSON.parse(await readFile(values.report, "utf8")));
  await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ output: values.output, decision: result.decision, selected: result.selected, diagnostic: result.diagnostic,
    totals: result.candidate.totals }));
}
