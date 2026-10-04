import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compareCorpora, retrieve, scoreQuestion, summarize } from "./retrieval-baseline.ts";
import { loadRetrievalData, type KnowledgeDocument, type RetrievalQuestion } from "./retrieval-data.ts";

// Offline experiment only. No caller from src/ and no changes to the production ranker or tool schema.
export const contextSchemes = ["query-only", "ctx-full", "ctx-industry", "ctx-refund"] as const;
export type ContextScheme = typeof contextSchemes[number];
type Context = NonNullable<RetrievalQuestion["context"]>;
type ContextQuery = { query: string; shopId: string | null; context?: Context };
export type ContextValidation = {
  source: string;
  expansionCases: { id: string; query: string; context?: Context; full: string[]; industry: string[]; guarded: string[] }[];
  documents: KnowledgeDocument[];
  scopeCases: (ContextQuery & { id: string; required: string[]; forbidden: string[] })[];
  noAnswerCases: (ContextQuery & { id: string; reason: string })[];
};

function validateContext(value: unknown): Context {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["industry", "sku_name", "verified"].includes(key))) throw new Error("上下文仅允许 industry、sku_name、verified 元数据。");
  const context = value as Context;
  for (const [key, max] of [["industry", 32], ["sku_name", 120]] as const) {
    const text = context[key];
    if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > max || /[\r\n\u0000-\u001f]/u.test(text))) {
      throw new Error(`上下文 ${key} 必须为 1–${max} 字单行文本。`);
    }
  }
  if (context.industry !== undefined && !["通用", "餐饮", "酒旅", "丽人", "休娱"].includes(context.industry)) throw new Error("上下文 industry 不在本实验行业枚举内。");
  if (context.verified !== undefined && typeof context.verified !== "boolean") throw new Error("上下文 verified 仅表示核销布尔状态。");
  return { ...context };
}

export function expandContextQuery(query: string, context: Context | undefined, scheme: ContextScheme) {
  if (!contextSchemes.includes(scheme)) throw new Error("未知上下文方案。");
  if (typeof query !== "string" || !query.trim() || query.length > 500) throw new Error("查询必须为 1–500 字文本。");
  const available = validateContext(context), contextUsed: Context = {}, addedTerms: string[] = [];
  if (scheme !== "query-only") {
    if (available.industry && (scheme === "ctx-full" || available.industry !== "通用")) {
      contextUsed.industry = available.industry; addedTerms.push(available.industry);
    }
    if (scheme === "ctx-full" && available.sku_name) {
      contextUsed.sku_name = available.sku_name; addedTerms.push(available.sku_name);
    }
    // Deliberately lexical, not an intent classifier: "反悔"/"撤销"/"退回" alone are ambiguous.
    const refundWords = /退款|退钱|退费|返款|拿回钱|要回钱/u.test(query);
    if (typeof available.verified === "boolean" && (scheme === "ctx-full" || (scheme === "ctx-refund" && refundWords))) {
      contextUsed.verified = available.verified; addedTerms.push(available.verified ? "已核销" : "未核销");
    }
  }
  return { originalQuery: query, effectiveQuery: [query, ...addedTerms].join(" "), contextUsed, addedTerms };
}

export function retrieveWithContext(documents: readonly KnowledgeDocument[], question: ContextQuery, scheme: ContextScheme) {
  if (question.shopId !== null && (typeof question.shopId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(question.shopId))) throw new Error("仅允许显式有效 shopId 或 null。");
  const expansion = expandContextQuery(question.query, question.context, scheme);
  // Reuse exactly the existing current ranker and explicit-shop filter; never infer scope from context.
  return { ...expansion, documents: retrieve(documents, { query: expansion.effectiveQuery, shopId: question.shopId }) };
}

export function evaluateContextCorpus(id: string, documents: readonly KnowledgeDocument[], questions: readonly RetrievalQuestion[], scheme: ContextScheme) {
  const ids = new Set(documents.map(doc => doc.id));
  if (ids.size !== documents.length || new Set(questions.map(q => q.id)).size !== questions.length
    || questions.some(q => q.relevant.some(id => !ids.has(id)))) throw new Error("比较语料或题目重复、标签悬空。");
  const cases = questions.map(question => {
    const { documents: ranked, ...expansion } = retrieveWithContext(documents, question, scheme);
    return { ...scoreQuestion(question, ranked.map(doc => doc.id)), ...expansion };
  });
  const suites = Object.fromEntries((["standard", "hard"] as const).map(suite => [suite, summarize(cases.filter(item => item.suite === suite))]));
  const hardKinds = Object.fromEntries(["口语省略", "同义替换", "场景描述"].map(kind =>
    [kind, summarize(cases.filter(item => item.suite === "hard" && item.kind === kind))]));
  return { id, documents: documents.length, suites, hardKinds, cases };
}

export function evaluateContextBoundaries(data: ContextValidation, scheme: ContextScheme) {
  const scopeCases = data.scopeCases.map(question => {
    const { documents, ...expansion } = retrieveWithContext(data.documents, question, scheme);
    const returned = documents.slice(0, 5).map(doc => doc.id);
    return { ...question, ...expansion, returned,
      passed: question.required.every(id => returned.includes(id)) && question.forbidden.every(id => !returned.includes(id)) };
  });
  const noAnswerCases = data.noAnswerCases.map(question => {
    const { documents, ...expansion } = retrieveWithContext(data.documents, question, scheme);
    const returned = documents.slice(0, 5).map(doc => doc.id);
    const queryOnly = retrieveWithContext(data.documents, question, "query-only").documents.slice(0, 5).map(doc => doc.id);
    return { ...question, ...expansion, returned, empty: returned.length === 0, queryOnly,
      contextIntroducedNonEmpty: queryOnly.length === 0 && returned.length > 0 };
  });
  return { source: data.source, scope: { questions: scopeCases.length, passed: scopeCases.filter(item => item.passed).length, cases: scopeCases },
    noAnswer: { questions: noAnswerCases.length, emptyResponses: noAnswerCases.filter(item => item.empty).length,
      nonEmptyResponses: noAnswerCases.filter(item => !item.empty).length,
      contextIntroducedNonEmpty: noAnswerCases.filter(item => item.contextIntroducedNonEmpty).length, cases: noAnswerCases } };
}

const root = new URL("../", import.meta.url);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function main() {
  if (process.argv.length !== 2) throw new Error("用法：node scripts/retrieval-context.ts（仅本地离线比较）。");
  const data = await loadRetrievalData(), selected = new Set(data.selectedIds);
  const validationBytes = await readFile(new URL("data/retrieval-context-validation.json", root));
  const validation = JSON.parse(validationBytes.toString("utf8")) as ContextValidation;
  const datasets = [
    { id: "restaurant-refund-v1", documents: data.documents.filter(doc => selected.has(doc.id)),
      questions: data.questions.filter(q => q.relevant.every(id => selected.has(id))) },
    { id: "reference-full-v1", documents: data.documents, questions: data.questions },
  ];
  const descriptions: Record<ContextScheme, string> = {
    "query-only": "仅原始 query，不使用 ctx；与原 current 算法输入相同。",
    "ctx-full": "直接拼全部已提供 ctx：industry（包括通用）、sku_name、verified→已核销/未核销；作为污染风险对照。",
    "ctx-industry": "仅拼显式非通用 industry，不使用 SKU 或核销状态。",
    "ctx-refund": "拼显式非通用 industry；原 query 包含退款/退钱/退费/返款/拿回钱/要回钱时才拼核销状态，不使用 SKU。",
  };
  const schemes = contextSchemes.map(id => ({ id, description: descriptions[id],
    corpora: datasets.map(corpus => evaluateContextCorpus(corpus.id, corpus.documents, corpus.questions, id)),
    boundaries: evaluateContextBoundaries(validation, id),
  }));
  const comparisons = schemes.slice(1).map(scheme => ({ scheme: scheme.id,
    corpora: scheme.corpora.map((corpus, index) => compareCorpora(schemes[0]!.corpora[index]!, corpus)) }));
  const git = (args: string[]) => execFileSync("git", args, { cwd: fileURLToPath(root), encoding: "utf8" }).trim();
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), kind: "offline-retrieval-context-comparison",
    source: data.source, git: { commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])) },
    runtime: { node: process.version, icu: process.versions.icu, locale: Intl.DateTimeFormat().resolvedOptions().locale },
    hashes: { ranker: hash(await readFile(new URL("src/knowledge-retrieval.ts", root))),
      experiment: hash(await readFile(new URL("scripts/retrieval-context.ts", root))),
      checker: hash(await readFile(new URL("scripts/retrieval-context-check.ts", root))),
      comparator: hash(await readFile(new URL("scripts/retrieval-baseline.ts", root))),
      importer: hash(await readFile(new URL("scripts/retrieval-data.ts", root))), validation: hash(validationBytes) },
    measurement: {
      inputs: "四方案使用同一 current ranker、语料、原始题目和显式 shopId；仅 hard 题原有 ctx 参与扩写。standard 的顶层 industry 不作为 ctx，因此四方案 standard 输入相同。保留 originalQuery/effectiveQuery/contextUsed；gold/kind/doc_id 不参与扩写。",
      difference: "这是增加元数据输入的对照，不是相同 query 输入下更换排序算法的提升。原 baseline/current 报告与生产 ranker 不变，未接入线上工具、数据库或会话。",
      metrics: "复用原 Recall@1/@5、完整 MRR、MRR@5 与逐题改善/退步计法。选集和全量、standard/hard 分开；无答案非空及其相对 query-only 的增加单独统计，不计入 Recall/MRR。",
      trust: "ctx.verified 仅为参考题的核销元数据，不证明身份、授权、支付、有效期、审批或可退金额；上下文仅补检索词，不创造事实。店铺仅用显式 shopId；行业不是权限范围。",
      limitations: "已阅读参考开发集和探索性试算；原创边界在实现前固定但已披露，不是盲测或独立泛化验证。退款词门控是词面实验，不理解否定、复合意图或矛盾上下文；追加行业也可能强行召回无答案。召回不等于可回答，本实验不调用模型/QQ，不代表端到端效果。",
    }, schemes, comparisons,
  };
  const rate = (value: number | null) => value === null ? "—" : value.toFixed(4);
  const rows = schemes.flatMap(scheme => scheme.corpora.flatMap(corpus => Object.entries(corpus.suites).map(([suite, r]) =>
    `| ${scheme.id} | ${corpus.id} | ${suite} | ${r.questions} | ${rate(r.recallAt1)} | ${rate(r.recallAt5)} | ${rate(r.mrr)} | ${rate(r.mrrAt5)} | ${r.noHitCount} |`)));
  const changes = comparisons.flatMap(comparison => comparison.corpora.map(corpus => `### ${comparison.scheme} / ${corpus.id}\n\n`
    + corpus.cases.filter(item => item.status !== "unchanged").map(item =>
      `- ${item.id} ${item.query}：${item.status}，相关名次 ${item.baseline.firstRelevantRank ?? "未召回"} → ${item.current.firstRelevantRank ?? "未召回"}。`).join("\n"))).join("\n\n");
  const boundaries = schemes.map(({ id, boundaries: b }) => `${id}：范围 ${b.scope.passed}/${b.scope.questions}；无答案空返回 ${b.noAnswer.emptyResponses}/${b.noAnswer.questions}，上下文新增非空 ${b.noAnswer.contextIntroducedNonEmpty}。\n\n`
    + b.noAnswer.cases.map(item => `- ${item.id}：${item.effectiveQuery} → ${item.returned.join(", ") || "空"}。${item.reason}`).join("\n")).join("\n\n");
  const markdown = `# 独立离线上下文比较\n\n${report.generatedAt}；固定参考版本 ${data.source.revision}。\n\n`
    + `| 方案 | 语料 | 题集 | 题数 | Recall@1 | Recall@5 | MRR | MRR@5 | 空召回 |\n|---|---|---|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n`
    + schemes.map(item => `${item.id}：${item.description}`).join("\n\n") + "\n\n" + Object.values(report.measurement).join("\n\n")
    + `\n\n## 相对 query-only 的逐题变化\n\n${changes}\n\n## 原创独立边界\n\n${boundaries}\n\n完整逐题 effectiveQuery/contextUsed、失败类型、分组、版本与文件哈希见 retrieval-context.json。\n`;
  await mkdir(new URL(".runtime/", root), { recursive: true });
  await writeFile(new URL(".runtime/retrieval-context.json", root), JSON.stringify(report, null, 2) + "\n");
  await writeFile(new URL(".runtime/retrieval-context.md", root), markdown);
  console.log(rows.join("\n"));
  console.log("独立报告：.runtime/retrieval-context.json / .md；未修改原基线或生产行为。");
  if (schemes.some(scheme => scheme.boundaries.scope.passed !== scheme.boundaries.scope.questions)) throw new Error("上下文实验范围检查失败，见独立报告。");
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "上下文比较失败。"); process.exitCode = 1; });
