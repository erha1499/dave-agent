import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { contentHash, rerankInstruction } from "../src/bailian.ts";
import { acceptEvidence, evidenceAcceptanceBinding, evidenceAcceptanceVersion, evidenceSupportAcceptanceVersion, resolveEvidenceAcceptance } from "../src/evidence-acceptance.ts";
import { applyEvidenceSupport } from "../src/evidence-support.ts";
import { scopeDocuments } from "../src/retrieval-ranking.ts";
import { validateV2Dataset, type runRetrievalV2 } from "./retrieval-v2.ts";

type Report = Awaited<ReturnType<typeof runRetrievalV2>>["report"];

// Score recorded decisions against frozen labels. Never rerun a policy or ask the
// support model to judge its own answers; provider failures stay in the plan.
export function evaluateRecordedAcceptance(report: Report) {
  const dataset = validateV2Dataset(report.snapshot.dataset);
  if (contentHash(dataset) !== report.snapshot.datasetHash) throw new Error("数据快照哈希不符。");
  const key = (row: { corpus: string; id: string; mode: string }) => JSON.stringify([row.corpus, row.id, row.mode]);
  const expected = dataset.corpora.flatMap(corpus => corpus.questions.map(question => key({ corpus: corpus.id, id: question.id, mode: "M4" })));
  if (report.snapshot.settings.modes.length !== 1 || report.snapshot.settings.modes[0] !== "M4"
    || report.plan.length !== expected.length || new Set(report.plan.map(key)).size !== expected.length
    || expected.some(item => !report.plan.some(row => key(row) === item))
    || new Set(report.results.map(key)).size !== report.results.length || report.results.some(row => !expected.includes(key(row)))) {
    throw new Error("验收要求完整唯一的 M4 计划，不接受重复/额外结果。");
  }
  const settings = report.snapshot.settings.acceptance;
  const config = resolveEvidenceAcceptance(settings.mode === "off" ? { mode: "off" } : { mode: settings.mode, threshold: settings.threshold });
  const provider = report.snapshot.settings.provider;
  const hasApplicableCases = dataset.corpora.some(corpus => corpus.questions.some(question => !question.deferredReason));
  const corpusHashes = Object.fromEntries(dataset.corpora.map(corpus => [corpus.id, contentHash(corpus.documents)]));
  if ((hasApplicableCases || provider !== null) && (provider?.rerankModel !== evidenceAcceptanceBinding.model || provider.rerankInstruction !== rerankInstruction)
    || !hasApplicableCases && (report.calls.length > 0 || report.supportCalls.length > 0)
    || settings.model !== evidenceAcceptanceBinding.model || settings.serialization !== evidenceAcceptanceBinding.serialization
    || settings.version !== (config.mode === "support" ? evidenceSupportAcceptanceVersion : evidenceAcceptanceVersion)
    || !settings.corpusHashes || typeof settings.corpusHashes !== "object" || Array.isArray(settings.corpusHashes)
    || Object.keys(settings.corpusHashes).length !== Object.keys(corpusHashes).length
    || Object.entries(corpusHashes).some(([id, hash]) => settings.corpusHashes[id] !== hash)) {
    throw new Error("报告的模型、指令、文本格式、策略版本或语料绑定不匹配。");
  }
  const groups = dataset.corpora.map(corpus => {
    const cases = corpus.questions.map(question => {
      const row = report.results.find(item => item.corpus === corpus.id && item.id === question.id);
      const answerable = question.relevant.length > 0;
      const base = { id: question.id, suite: question.suite, answerable };
      if (!row) return { ...base, status: "missing" as const };
      if (contentHash(row.acceptance.config) !== contentHash(config) || row.acceptance.version !== settings.version) throw new Error("结果策略与快照不符。");
      if (question.deferredReason) {
        if (row.status !== "not_applicable" || row.acceptance.status !== "unavailable" || row.acceptance.accepted.length > 0
          || row.callIds.length > 0 || row.deferredReason !== question.deferredReason) throw new Error("延期结果的状态、接收证据、调用记录或原因不匹配。");
        return { ...base, status: "deferred" as const };
      }
      if (row.status !== "ok" || row.acceptance.status === "unavailable") return { ...base, status: "failed" as const };
      const prepared = acceptEvidence({ config, query: question.query, scope: question, documents: corpus.documents, ranking: row.ranking });
      const expectedAcceptance = config.mode === "support" && prepared.pendingSupport?.length
        ? settings.support && row.supportVerification ? applyEvidenceSupport({ prepared, verification: row.supportVerification,
          query: question.query, scope: question, documents: corpus.documents, settings: settings.support }) : null
        : prepared;
      if (!expectedAcceptance || expectedAcceptance.status === "unavailable" || expectedAcceptance.status !== row.acceptance.status
        || contentHash(expectedAcceptance.accepted) !== contentHash(row.acceptance.accepted)) throw new Error("结果缺少绑定有效的实际判别记录，或接收原文不符。");
      const ids = row.acceptance.accepted.map(document => document.id);
      const visible = new Set(scopeDocuments(corpus.documents, question).map(document => document.id));
      if (ids.length > 5 || new Set(ids).size !== ids.length) throw new Error("接收结果不符合 Top5 合同。");
      const recall = answerable ? question.relevant.filter(id => ids.includes(id)).length / question.relevant.length : null;
      const rawHit = answerable && row.ranking.slice(0, 5).some(item => question.relevant.includes(item.id));
      return { ...base, status: "measured" as const, acceptedIds: ids, recall, rawHit,
        falseReject: rawHit && !ids.some(id => question.relevant.includes(id)),
        falseAccept: question.suite === "no_answer" && ids.length > 0,
        scopeAbstentionFailure: question.suite === "scope" && !answerable && ids.length > 0,
        scopeViolation: ids.some(id => !visible.has(id)),
        boundaryFailure: ids.some(id => question.forbidden?.includes(id)) || (question.required ?? []).some(id => !ids.includes(id)) };
    });
    const measured = cases.filter(row => row.status === "measured");
    const answerable = cases.filter(row => row.answerable && row.status !== "deferred").length;
    const rawHits = measured.filter(row => row.rawHit).length;
    return { corpus: corpus.id, planned: cases.length, measured: measured.length,
      deferred: cases.filter(row => row.status === "deferred").length,
      incomplete: cases.filter(row => row.status === "missing" || row.status === "failed").length,
      answerable, rawHits, acceptedRecallSum: measured.reduce((sum, row) => sum + (row.recall ?? 0), 0),
      falseRejects: measured.filter(row => row.falseReject).length,
      noAnswer: measured.filter(row => row.suite === "no_answer").length,
      noAnswerPlanned: cases.filter(row => row.suite === "no_answer").length,
      falseAccepts: measured.filter(row => row.falseAccept).length,
      scopeCases: measured.filter(row => row.suite === "scope").length,
      scopeAbstentionFailures: measured.filter(row => row.scopeAbstentionFailure).length,
      scopeViolations: measured.filter(row => row.scopeViolation).length,
      boundaryFailures: measured.filter(row => row.boundaryFailure).length,
      covered: measured.filter(row => row.acceptedIds.length).length, cases };
  });
  const sum = (key: Exclude<keyof typeof groups[number], "corpus" | "cases">) => groups.reduce((total, group) => total + group[key], 0);
  const answerable = sum("answerable"), rawHits = sum("rawHits");
  const totals = { planned: sum("planned"), measured: sum("measured"), deferred: sum("deferred"), incomplete: sum("incomplete"),
    answerable, acceptedRecallAt5: answerable ? sum("acceptedRecallSum") / answerable : null,
    falseRejects: sum("falseRejects"), falseRejectDenominator: rawHits, falseRejectRate: rawHits ? sum("falseRejects") / rawHits : null,
    falseAccepts: sum("falseAccepts"), noAnswer: sum("noAnswer"), noAnswerPlanned: sum("noAnswerPlanned"),
    scopeCases: sum("scopeCases"), scopeAbstentionFailures: sum("scopeAbstentionFailures"),
    scopeViolations: sum("scopeViolations"), boundaryFailures: sum("boundaryFailures"), covered: sum("covered") };
  return { runId: report.runId, datasetHash: report.snapshot.datasetHash, config: report.snapshot.settings.acceptance, groups, totals,
    meetsApplicableTargets: report.status === "completed" && totals.incomplete === 0 && totals.noAnswer > 0 && totals.falseAccepts === 0
      && totals.scopeViolations === 0 && totals.boundaryFailures === 0 && totals.scopeAbstentionFailures === 0
      && totals.acceptedRecallAt5 !== null && totals.acceptedRecallAt5 >= .8 && totals.falseRejectRate !== null && totals.falseRejectRate <= .1 };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { report: { type: "string" } }, strict: true, allowPositionals: false });
  if (!values.report) throw new Error("用法：node scripts/acceptance-report.ts --report REPORT.json");
  console.log(JSON.stringify(evaluateRecordedAcceptance(JSON.parse(await readFile(values.report, "utf8"))), null, 2));
}
