import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rankKnowledge } from "../src/knowledge-retrieval.ts";
import { loadRetrievalData, type KnowledgeDocument, type RetrievalQuestion } from "./retrieval-data.ts";

type Query = { query: string; shopId: string | null };
type BoundaryData = {
  source: string;
  noAnswer: (Query & { id: string; reason: string })[];
  scope: (Query & { id: string; required: string[]; forbidden: string[] })[];
};
export function retrieve(documents: readonly KnowledgeDocument[], question: Query) {
  // Only explicit shop metadata scopes this offline corpus. Industry/ctx are retained, not inferred from gold labels.
  return rankKnowledge(question.query, documents.filter(doc => doc.shopId === null || doc.shopId === question.shopId));
}

export function scoreQuestion(question: RetrievalQuestion, rankedIds: readonly string[]) {
  if (!question.relevant.length || new Set(question.relevant).size !== question.relevant.length
    || new Set(rankedIds).size !== rankedIds.length) throw new Error("评测标签或排名重复/为空。");
  const positions = question.relevant.map(id => rankedIds.indexOf(id) + 1);
  const firstRank = Math.min(...positions.filter(rank => rank > 0));
  const rank = Number.isFinite(firstRank) ? firstRank : null;
  return {
    ...question, rankedIds: [...rankedIds], top5: rankedIds.slice(0, 5), firstRelevantRank: rank,
    recallAt1: positions.filter(rank => rank === 1).length / positions.length,
    recallAt5: positions.filter(rank => rank > 0 && rank <= 5).length / positions.length,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    reciprocalRankAt5: rank === null || rank > 5 ? 0 : 1 / rank,
    failure: positions.every(rank => rank > 0 && rank <= 5) ? null
      : rankedIds.length === 0 ? "no_tag_match"
        : positions.some(rank => rank === 0) ? "relevant_not_retrieved" : "relevant_beyond_top5",
  };
}
type Result = ReturnType<typeof scoreQuestion>;
export function summarize(results: readonly Result[]) {
  const mean = (key: "recallAt1" | "recallAt5" | "reciprocalRank" | "reciprocalRankAt5") =>
    results.length ? results.reduce((sum, item) => sum + item[key], 0) / results.length : null;
  return { questions: results.length, recallAt1: mean("recallAt1"), recallAt5: mean("recallAt5"),
    mrr: mean("reciprocalRank"), mrrAt5: mean("reciprocalRankAt5"),
    noHitCount: results.filter(item => item.rankedIds.length === 0).length,
    top5MissCount: results.filter(item => item.recallAt5 < 1).length };
}

export function evaluateCorpus(id: string, documents: readonly KnowledgeDocument[], questions: readonly RetrievalQuestion[]) {
  const ids = new Set(documents.map(doc => doc.id));
  if (ids.size !== documents.length || questions.some(q => q.relevant.some(id => !ids.has(id)))) {
    throw new Error("评测语料重复或相关标签悬空。");
  }
  const cases = questions.map(question => scoreQuestion(question, retrieve(documents, question).map(doc => doc.id)));
  const suites = Object.fromEntries((["standard", "hard"] as const).map(suite => [suite, summarize(cases.filter(item => item.suite === suite))]));
  const hardKinds = Object.fromEntries(["口语省略", "同义替换", "场景描述"].map(kind =>
    [kind, summarize(cases.filter(item => item.suite === "hard" && item.kind === kind))]));
  return { id, documents: documents.length, suites, hardKinds, cases };
}

export function evaluateBoundaries(documents: readonly KnowledgeDocument[], data: BoundaryData) {
  const ids = new Set(documents.map(doc => doc.id));
  const seen = new Set<string>();
  for (const item of [...data.noAnswer, ...data.scope]) {
    if (!item.id || seen.has(item.id) || typeof item.query !== "string" || !item.query.trim()
      || (item.shopId !== null && typeof item.shopId !== "string")) throw new Error("边界样例格式无效。");
    seen.add(item.id);
  }
  const noAnswerCases = data.noAnswer.map(item => {
    if (typeof item.reason !== "string" || !item.reason.trim()) throw new Error("无答案样例需注明理由。");
    const returned = retrieve(documents, item).slice(0, 5).map(doc => doc.id);
    return { ...item, returned, empty: returned.length === 0 };
  });
  const scopeCases = data.scope.map(item => {
    if (![item.required, item.forbidden].every(values => Array.isArray(values) && values.every(id => ids.has(id)))
      || item.required.some(id => item.forbidden.includes(id))) throw new Error("范围边界标签无效。");
    const returned = retrieve(documents, item).slice(0, 5).map(doc => doc.id);
    return { ...item, returned, passed: item.required.every(id => returned.includes(id)) && item.forbidden.every(id => !returned.includes(id)) };
  });
  return { source: data.source,
    noAnswer: { questions: noAnswerCases.length, emptyResponses: noAnswerCases.filter(item => item.empty).length,
      nonEmptyResponses: noAnswerCases.filter(item => !item.empty).length, cases: noAnswerCases },
    scope: { questions: scopeCases.length, passed: scopeCases.filter(item => item.passed).length, cases: scopeCases } };
}

const root = new URL("../", import.meta.url);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function main() {
  if (process.argv.length !== 2) throw new Error("用法：node scripts/retrieval-baseline.ts（本地离线运行，无参数）。");
  const data = await loadRetrievalData();
  const boundaryBytes = await readFile(new URL("data/retrieval-boundaries.json", root));
  const selected = new Set(data.selectedIds);
  const corpora = [
    evaluateCorpus("restaurant-refund-v1", data.documents.filter(doc => selected.has(doc.id)),
      data.questions.filter(question => question.relevant.every(id => selected.has(id)))),
    evaluateCorpus("reference-full-v1", data.documents, data.questions),
  ];
  const boundaries = evaluateBoundaries(data.documents, JSON.parse(boundaryBytes.toString("utf8")) as BoundaryData);
  const git = (args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(root), encoding: "utf8" }).trim();
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), kind: "offline-retrieval-baseline",
    source: data.source, git: { commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])) },
    runtime: { node: process.version, icu: process.versions.icu, locale: Intl.DateTimeFormat().resolvedOptions().locale },
    hashes: {
      ranker: hash(await readFile(new URL("src/knowledge-retrieval.ts", root))),
      checker: hash(await readFile(new URL("scripts/retrieval-baseline.ts", root))),
      importer: hash(await readFile(new URL("scripts/retrieval-data.ts", root))),
      boundaries: hash(boundaryBytes),
    },
    measurement: {
      algorithm: "现有 tags 子串命中计数；零分排除；分数降序、ID 同分排序；不做分词/改写。",
      inputs: "只使用 query 与显式 shopId；保留 industry/kind/ctx 供审查，本基线不扩写上下文，不用 gold 推断查询范围。",
      metrics: "每题 Recall@k 后宏平均；MRR 使用完整正分排名，MRR@5 截断到业务返回上限5；无命中记0。",
      boundaries: "无答案样例单独报告空/非空召回，不计入 Recall/MRR；非空召回不等于模型编造。范围检查只验证参考文档元数据过滤，QQ身份授权另由数据库回归验证。",
      limitation: "参考语料的构造规则不是本项目门店政策；不写业务数据库、不调用模型或QQ，不代表端到端客服效果或上游原检索器成绩。",
    }, corpora, boundaries,
  };
  const rate = (value: number | null) => value === null ? "—" : value.toFixed(4);
  const rows = corpora.flatMap(corpus => Object.entries(corpus.suites).map(([suite, result]) =>
    `| ${corpus.id} | ${suite} | ${corpus.documents} | ${result.questions} | ${rate(result.recallAt1)} | ${rate(result.recallAt5)} | ${rate(result.mrr)} | ${rate(result.mrrAt5)} | ${result.noHitCount} |`));
  const failures = corpora.flatMap(corpus => ["standard", "hard"].map(suite => `### ${corpus.id} / ${suite}\n\n`
    + corpus.cases.filter(item => item.suite === suite && item.failure).slice(0, 5)
      .map(item => `- ${item.id} ${item.query}：相关 ${item.relevant.join(", ")}；前5 ${item.top5.join(", ") || "空"}；${item.failure}`).join("\n"))).join("\n\n");
  const unknowns = boundaries.noAnswer.cases.map(item => `- ${item.query}：前5 ${item.returned.join(", ") || "空"}。${item.reason}`).join("\n");
  const markdown = `# 检索基线\n\n${report.generatedAt}；固定语料版本 ${String(data.source.revision)}。\n\n`
    + `| 语料 | 题集 | 文档 | 题数 | Recall@1 | Recall@5 | MRR | MRR@5 | 空召回 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n`
    + Object.values(report.measurement).join("\n\n")
    + `\n\n无答案样例：${boundaries.noAnswer.emptyResponses}/${boundaries.noAnswer.questions} 空返回；范围检查：${boundaries.scope.passed}/${boundaries.scope.questions} 通过。\n\n${unknowns}\n\n## 部分失败案例\n\n${failures}\n\n完整逐题结果、hard类型分组及版本哈希见同目录 retrieval-baseline.json。\n`;
  await mkdir(new URL(".runtime/", root), { recursive: true });
  await writeFile(new URL(".runtime/retrieval-baseline.json", root), JSON.stringify(report, null, 2) + "\n");
  await writeFile(new URL(".runtime/retrieval-baseline.md", root), markdown);
  console.log(rows.join("\n"));
  console.log(`边界：无答案空返回 ${boundaries.noAnswer.emptyResponses}/${boundaries.noAnswer.questions}；范围 ${boundaries.scope.passed}/${boundaries.scope.questions}。报告：.runtime/retrieval-baseline.json / .md`);
  if (boundaries.scope.passed !== boundaries.scope.questions) throw new Error("参考文档范围检查失败，见报告。");
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "检索基线运行失败。");
  process.exitCode = 1;
});
