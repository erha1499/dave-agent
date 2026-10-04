import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { rankKnowledge, rankKnowledgeBaseline } from "../src/knowledge-retrieval.ts";
import { loadRetrievalData, type KnowledgeDocument, type RetrievalQuestion } from "./retrieval-data.ts";

type Query = { query: string; shopId: string | null };
type Algorithm = "baseline" | "current";
type BoundaryData = {
  source: string;
  noAnswer: (Query & { id: string; reason: string })[];
  scope: (Query & { id: string; required: string[]; forbidden: string[] })[];
};
export function retrieve(documents: readonly KnowledgeDocument[], question: Query, algorithm: Algorithm = "current") {
  // Only explicit shop metadata scopes this offline corpus. Industry/ctx are retained, not inferred from gold labels.
  const rank = algorithm === "baseline" ? rankKnowledgeBaseline : rankKnowledge;
  return rank(question.query, documents.filter(doc => doc.shopId === null || doc.shopId === question.shopId));
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
      : rankedIds.length === 0 ? "no_match"
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

export function evaluateCorpus(id: string, documents: readonly KnowledgeDocument[], questions: readonly RetrievalQuestion[], algorithm: Algorithm = "current") {
  const ids = new Set(documents.map(doc => doc.id));
  if (ids.size !== documents.length || questions.some(q => q.relevant.some(id => !ids.has(id)))) {
    throw new Error("评测语料重复或相关标签悬空。");
  }
  const cases = questions.map(question => scoreQuestion(question, retrieve(documents, question, algorithm).map(doc => doc.id)));
  const suites = Object.fromEntries((["standard", "hard"] as const).map(suite => [suite, summarize(cases.filter(item => item.suite === suite))]));
  const hardKinds = Object.fromEntries(["口语省略", "同义替换", "场景描述"].map(kind =>
    [kind, summarize(cases.filter(item => item.suite === "hard" && item.kind === kind))]));
  return { id, documents: documents.length, suites, hardKinds, cases };
}

export function compareCorpora(baseline: ReturnType<typeof evaluateCorpus>, current: ReturnType<typeof evaluateCorpus>) {
  const before = new Map(baseline.cases.map(item => [item.id, item]));
  if (baseline.id !== current.id || baseline.documents !== current.documents || before.size !== baseline.cases.length
    || before.size !== current.cases.length || new Set(current.cases.map(item => item.id)).size !== before.size) {
    throw new Error("比较语料或题目不一致。");
  }
  const delta = (a: ReturnType<typeof summarize>, b: ReturnType<typeof summarize>) => Object.fromEntries(
    (["recallAt1", "recallAt5", "mrr", "mrrAt5"] as const).map(key =>
      [key, a[key] === null || b[key] === null ? null : b[key] - a[key]]));
  const input = (q: Result) => [q.id, q.suite, q.query, q.relevant, q.shopId, q.industry, q.kind, q.context];
  const cases = current.cases.map(item => {
    const previous = before.get(item.id);
    if (!previous || JSON.stringify(input(previous)) !== JSON.stringify(input(item))) throw new Error("比较题目输入或标签不一致。");
    return { id: item.id, suite: item.suite, query: item.query,
      status: item.reciprocalRank > previous.reciprocalRank ? "improved"
        : item.reciprocalRank < previous.reciprocalRank ? "regressed" : "unchanged",
      baseline: { firstRelevantRank: previous.firstRelevantRank, top5: previous.top5, ...summarize([previous]) },
      current: { firstRelevantRank: item.firstRelevantRank, top5: item.top5, ...summarize([item]) },
      delta: delta(summarize([previous]), summarize([item])),
    };
  });
  const suites = Object.fromEntries((["standard", "hard"] as const).map(suite => [suite, {
    questions: baseline.suites[suite]!.questions,
    delta: delta(baseline.suites[suite]!, current.suites[suite]!),
    improved: cases.filter(item => item.suite === suite && item.status === "improved").length,
    regressed: cases.filter(item => item.suite === suite && item.status === "regressed").length,
    unchanged: cases.filter(item => item.suite === suite && item.status === "unchanged").length,
  }]));
  return { id: baseline.id, documents: baseline.documents, suites, cases };
}

export function evaluateBoundaries(documents: readonly KnowledgeDocument[], data: BoundaryData, algorithm: Algorithm = "current") {
  const ids = new Set(documents.map(doc => doc.id));
  const seen = new Set<string>();
  for (const item of [...data.noAnswer, ...data.scope]) {
    if (!item.id || seen.has(item.id) || typeof item.query !== "string" || !item.query.trim()
      || (item.shopId !== null && typeof item.shopId !== "string")) throw new Error("边界样例格式无效。");
    seen.add(item.id);
  }
  const noAnswerCases = data.noAnswer.map(item => {
    if (typeof item.reason !== "string" || !item.reason.trim()) throw new Error("无答案样例需注明理由。");
    const returned = retrieve(documents, item, algorithm).slice(0, 5).map(doc => doc.id);
    return { ...item, returned, empty: returned.length === 0 };
  });
  const scopeCases = data.scope.map(item => {
    if (![item.required, item.forbidden].every(values => Array.isArray(values) && values.every(id => ids.has(id)))
      || item.required.some(id => item.forbidden.includes(id))) throw new Error("范围边界标签无效。");
    const returned = retrieve(documents, item, algorithm).slice(0, 5).map(doc => doc.id);
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
  const datasets = [
    { id: "restaurant-refund-v1", documents: data.documents.filter(doc => selected.has(doc.id)),
      questions: data.questions.filter(question => question.relevant.every(id => selected.has(id))) },
    { id: "reference-full-v1", documents: data.documents, questions: data.questions },
  ];
  const boundaryData = JSON.parse(boundaryBytes.toString("utf8")) as BoundaryData;
  const algorithms = (["baseline", "current"] as const).map(id => ({ id,
    description: id === "baseline" ? "tags 子串命中计数；零分排除；分数降序、ID 同分排序。"
      : "NFKC/小写与业务同义归一；zh-CN 分词去通用词/单字，并补完整命中标签；词权重 1+ln((N+1)/(df+1))，标签全等5/包含2、标题2、正文1；零分排除，分数降序、ID 同分排序。",
    corpora: datasets.map(corpus => evaluateCorpus(corpus.id, corpus.documents, corpus.questions, id)),
    boundaries: evaluateBoundaries(data.documents, boundaryData, id),
  }));
  const comparison = { corpora: algorithms[0]!.corpora.map((corpus, index) => compareCorpora(corpus, algorithms[1]!.corpora[index]!)) };
  const git = (args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(root), encoding: "utf8" }).trim();
  const report = {
    schemaVersion: 2, generatedAt: new Date().toISOString(), kind: "offline-retrieval-baseline",
    source: data.source, git: { commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])) },
    runtime: { node: process.version, icu: process.versions.icu, locale: Intl.DateTimeFormat().resolvedOptions().locale },
    hashes: {
      ranker: hash(await readFile(new URL("src/knowledge-retrieval.ts", root))),
      checker: hash(await readFile(new URL("scripts/retrieval-baseline.ts", root))),
      importer: hash(await readFile(new URL("scripts/retrieval-data.ts", root))),
      boundaries: hash(boundaryBytes),
    },
    measurement: {
      inputs: "两算法使用相同 query、显式 shopId、语料与题目；保留 industry/kind/ctx 供审查，不扩写上下文，不用 gold 推断查询范围。",
      metrics: "每题 Recall@k 后宏平均；MRR 使用完整正分排名，MRR@5 截断到业务返回上限5；无命中记0。",
      comparison: "delta 为 current - baseline；逐题 improved/regressed 按完整 reciprocalRank 增减，当前原题均为单相关文档，等价于相关文档名次改善/退步；同题同时保留四项指标变化。",
      boundaries: "无答案样例单独报告空/非空召回，不计入 Recall/MRR；非空召回不等于模型编造。范围检查只验证参考文档元数据过滤，QQ身份授权另由数据库回归验证。",
      limitation: "参考语料的构造规则不是本项目门店政策；不写业务数据库、不调用模型或QQ，不代表端到端客服效果或上游原检索器成绩。",
    }, algorithms, comparison,
  };
  const rate = (value: number | null) => value === null ? "—" : value.toFixed(4);
  const rows = algorithms.flatMap(algorithm => algorithm.corpora.flatMap(corpus => Object.entries(corpus.suites).map(([suite, result]) =>
    `| ${algorithm.id} | ${corpus.id} | ${suite} | ${corpus.documents} | ${result.questions} | ${rate(result.recallAt1)} | ${rate(result.recallAt5)} | ${rate(result.mrr)} | ${rate(result.mrrAt5)} | ${result.noHitCount} |`)));
  const changes = comparison.corpora.flatMap(corpus => Object.entries(corpus.suites).map(([suite, result]) =>
    `| ${corpus.id} | ${suite} | ${rate(result.delta.recallAt1!)} | ${rate(result.delta.recallAt5!)} | ${rate(result.delta.mrr!)} | ${rate(result.delta.mrrAt5!)} | ${result.improved} | ${result.regressed} | ${result.unchanged} |`));
  const failures = algorithms.flatMap(algorithm => algorithm.corpora.flatMap(corpus => ["standard", "hard"].map(suite => `### ${algorithm.id} / ${corpus.id} / ${suite}\n\n`
    + corpus.cases.filter(item => item.suite === suite && item.failure).slice(0, 5)
      .map(item => `- ${item.id} ${item.query}：相关 ${item.relevant.join(", ")}；前5 ${item.top5.join(", ") || "空"}；${item.failure}`).join("\n")))).join("\n\n");
  const boundarySummary = algorithms.map(({ id, boundaries }) => `${id}：无答案空返回 ${boundaries.noAnswer.emptyResponses}/${boundaries.noAnswer.questions}；范围 ${boundaries.scope.passed}/${boundaries.scope.questions}。`).join("\n\n");
  const unknowns = algorithms.flatMap(({ id, boundaries }) => boundaries.noAnswer.cases.map(item =>
    `- ${id} / ${item.query}：前5 ${item.returned.join(", ") || "空"}。${item.reason}`)).join("\n");
  const changedCases = comparison.corpora.flatMap(corpus => corpus.cases.filter(item => item.status !== "unchanged").map(item =>
    `- ${corpus.id} / ${item.id} ${item.query}：${item.status}；名次 ${item.baseline.firstRelevantRank ?? "未召回"} → ${item.current.firstRelevantRank ?? "未召回"}`)).join("\n");
  const markdown = `# 检索基线\n\n${report.generatedAt}；固定语料版本 ${String(data.source.revision)}。\n\n`
    + `| 算法 | 语料 | 题集 | 文档 | 题数 | Recall@1 | Recall@5 | MRR | MRR@5 | 空召回 |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n`
    + algorithms.map(item => `${item.id}：${item.description}`).join("\n\n") + "\n\n" + Object.values(report.measurement).join("\n\n")
    + `\n\n## 同题变化（current - baseline）\n\n| 语料 | 题集 | ΔRecall@1 | ΔRecall@5 | ΔMRR | ΔMRR@5 | improved | regressed | unchanged |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n${changes.join("\n")}\n\n${changedCases || "无名次变化。"}`
    + `\n\n## 独立边界\n\n${boundarySummary}\n\n${unknowns}\n\n## 部分失败案例\n\n${failures}\n\n完整逐题结果、hard类型分组及版本哈希见同目录 retrieval-baseline.json。\n`;
  await mkdir(new URL(".runtime/", root), { recursive: true });
  await writeFile(new URL(".runtime/retrieval-baseline.json", root), JSON.stringify(report, null, 2) + "\n");
  await writeFile(new URL(".runtime/retrieval-baseline.md", root), markdown);
  console.log(rows.join("\n"));
  console.log(changes.join("\n"));
  console.log(`${boundarySummary}\n报告：.runtime/retrieval-baseline.json / .md`);
  if (algorithms.some(({ boundaries }) => boundaries.scope.passed !== boundaries.scope.questions)) throw new Error("参考文档范围检查失败，见报告。");
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : "检索基线运行失败。");
  process.exitCode = 1;
});
