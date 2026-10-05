import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { scopeDocuments, type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { loadRetrievalData } from "./retrieval-data.ts";
import type { V2Dataset, V2Question } from "./retrieval-v2.ts";

export type AcceptanceSplit = "development" | "validation" | "support-validation";
export type AcceptanceQuestion = V2Question & {
  corpus: "online" | "reference";
  expectedBehavior: "answer" | "abstain" | "clarify";
  goldRationale: string;
  evidence: Array<{ docId: string; quote: string }>;
  scopeCategory?: "cross_shop" | "cross_product" | "missing_shop" | "missing_product" | "inactive";
  relatedButInsufficient?: string[];
  contextRequirement?: string;
};
const root = new URL("../", import.meta.url);
const expectedCounts = {
  development: { total: 48, standard: 24, no_answer: 12, scope: 12, context: 0 },
  validation: { total: 60, standard: 30, no_answer: 12, scope: 12, context: 6 },
  "support-validation": { total: 60, standard: 30, no_answer: 18, scope: 12, context: 0 },
} as const;
const files = ["data/acceptance-online.json", "data/acceptance-development.json", "data/acceptance-validation.json"] as const;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fail(reason: string): never { throw new Error(`A1 数据校验失败：${reason}`); }
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uniqueStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;

// Keep source-specific metadata in the snapshot, while exposing the existing V2 dataset contract.
export function validateAcceptanceQuestions(value: unknown, split: AcceptanceSplit, documents: Record<"online" | "reference", RetrievalDocument[]>): AcceptanceQuestion[] {
  if (!object(value) || Object.keys(value).some(key => !["version", "split", "disclosure", "questions"].includes(key))
    || value.version !== 1 || value.split !== split || !text(value.disclosure) || !Array.isArray(value.questions)) fail("题集头或 split 无效");
  const rows = value.questions as unknown[];
  const keys = ["id", "corpus", "suite", "query", "shopId", "productId", "relevant", "expectedBehavior", "goldRationale", "evidence", "forbidden", "scopeCategory", "relatedButInsufficient", "contextRequirement", "deferredReason"];
  const seen = new Set<string>();
  const queries = new Set<string>();
  const questions = rows.map((raw): AcceptanceQuestion => {
    if (!object(raw) || Object.keys(raw).some(key => !keys.includes(key)) || !text(raw.id) || !/^a1-(dev|val|sup)-\d{3}$/.test(raw.id)
      || !raw.id.startsWith(`a1-${split.slice(0, 3)}-`) || seen.has(raw.id) || !text(raw.query) || raw.query.length > 500
      || (raw.corpus !== "online" && raw.corpus !== "reference") || !text(raw.suite)
      || !["standard", "no_answer", "scope", "context"].includes(raw.suite) || !text(raw.goldRationale)
      || !uniqueStrings(raw.relevant) || !Array.isArray(raw.evidence)) fail("题目、ID、审阅依据或 gold 无效");
    seen.add(raw.id);
    const queryKey = JSON.stringify([raw.corpus, raw.query.trim()]);
    if (queries.has(queryKey)) fail("题集内重复问题");
    queries.add(queryKey);
    const corpus = documents[raw.corpus];
    const scope = { shopId: raw.shopId as string | null, productId: raw.productId as string | null };
    if (raw.shopId === undefined || raw.productId === undefined) fail("必须显式标注可信 shop/product 范围");
    const visible = new Set(scopeDocuments(corpus, scope).map(doc => doc.id));
    for (const field of ["relevant", "forbidden", "relatedButInsufficient"] as const) {
      if (raw[field] === undefined && field !== "relevant") continue;
      if (!uniqueStrings(raw[field]) || raw[field].some(id => !corpus.some(doc => doc.id === id))) fail("gold 引用了未知、重复或跨语料文档");
    }
    const relevant = raw.relevant as string[];
    if (relevant.some(id => !visible.has(id) || (raw.forbidden as string[] | undefined)?.includes(id))) fail("gold 不可见或同时禁止");
    const evidence = raw.evidence.map(item => {
      if (!object(item) || Object.keys(item).some(key => !["docId", "quote"].includes(key)) || !text(item.docId) || !text(item.quote)
        || !relevant.includes(item.docId) || !corpus.find(doc => doc.id === item.docId)?.body.includes(item.quote)) fail("gold 引文不在原文或没有对应 gold");
      return { docId: item.docId, quote: item.quote };
    });
    if (new Set(evidence.map(item => item.docId)).size !== evidence.length || relevant.some(id => !evidence.some(item => item.docId === id))) fail("每个 gold 必须提供一条可核验原文");
    const expected = raw.suite === "context" ? "clarify" : relevant.length ? "answer" : "abstain";
    if (raw.expectedBehavior !== expected || (raw.suite === "standard") !== (relevant.length > 0)) fail("suite、行为和 gold 冲突");
    if (raw.suite === "no_answer" && (!uniqueStrings(raw.relatedButInsufficient) || !raw.relatedButInsufficient.length
      || raw.relatedButInsufficient.some(id => !visible.has(id)))) fail("无答案题必须标注可见但不足以回答的近似政策");
    if (raw.suite === "scope") {
      if (!text(raw.scopeCategory) || !["cross_shop", "cross_product", "missing_shop", "missing_product", "inactive"].includes(raw.scopeCategory)
        || !uniqueStrings(raw.forbidden) || !raw.forbidden.length || raw.forbidden.some(id => visible.has(id))) fail("范围题必须包含不可见干扰证据");
      if (raw.scopeCategory === "inactive" && !raw.forbidden.some(id => corpus.find(doc => doc.id === id)?.status === "inactive")) fail("失效题缺少 inactive 干扰");
      const forbidden = corpus.filter(doc => (raw.forbidden as string[]).includes(doc.id));
      if ((raw.scopeCategory === "missing_shop" && (raw.shopId !== null || !forbidden.some(doc => doc.shopId)))
        || (raw.scopeCategory === "missing_product" && (!raw.shopId || raw.productId !== null || !forbidden.some(doc => doc.productId)))
        || (raw.scopeCategory === "cross_shop" && (!raw.shopId || !forbidden.some(doc => doc.shopId && doc.shopId !== raw.shopId)))
        || (raw.scopeCategory === "cross_product" && (!raw.productId || !forbidden.some(doc => doc.shopId === raw.shopId && doc.productId && doc.productId !== raw.productId)))) fail("范围类别与文档/可信范围不符");
    } else if (raw.scopeCategory !== undefined) fail("只有 scope 题可以标记范围类别");
    if (raw.suite === "context") {
      if (raw.deferredReason !== "C1" || !text(raw.contextRequirement) || raw.shopId !== null || raw.productId !== null) fail("上下文题必须保留 C1 待实现依据，不能伪造可信范围");
    } else if (raw.contextRequirement !== undefined || raw.deferredReason !== undefined) fail("普通题不得延后，避免丢失计划分母");
    return raw as unknown as AcceptanceQuestion;
  });
  const counts = expectedCounts[split];
  if (questions.length !== counts.total || Object.entries(counts).some(([suite, count]) => suite !== "total" && questions.filter(q => q.suite === suite).length !== count)) fail("冻结分层数量不符");
  if (["online", "reference"].some(corpus => !questions.some(q => q.corpus === corpus && q.relevant.length))) fail("缺少在线或参考正例分层");
  return questions;
}

export async function loadAcceptanceDataset(split: AcceptanceSplit): Promise<V2Dataset> {
  if (split !== "development" && split !== "validation" && split !== "support-validation") fail("不支持的 split");
  const sourceText = await readFile(new URL("data/acceptance-source.json", root), "utf8");
  const source = JSON.parse(sourceText);
  if (source.version !== 1 || source.validationPolicy !== "fixed-validation-not-blind"
    || JSON.stringify(source.counts) !== JSON.stringify({ development: expectedCounts.development, validation: expectedCounts.validation }) || !object(source.files)
    || Object.keys(source.files).length !== files.length) fail("来源、冻结声明或数量无效");
  const buffers = await Promise.all(files.map(async path => {
    const buffer = await readFile(new URL(path, root)), meta = source.files[path];
    if (!meta || meta.sha256 !== hash(buffer) || meta.bytes !== buffer.length) fail(`${path} 冻结 SHA256/bytes 不符`);
    return buffer;
  }));
  const seed = await readFile(new URL("db/02-seed.sql", root), "utf8");
  const referenceManifest = await readFile(new URL("data/reference/kefu-harness/source.json", root));
  if (source.online.seedPath !== "db/02-seed.sql" || source.online.seedSha256 !== hash(seed)
    || source.reference.sourceManifestSha256 !== hash(referenceManifest)) fail("seed 或参考来源已变化；需显式审阅后更新快照");
  const archive = await loadRetrievalData();
  if (source.reference.repo !== archive.source.repo || source.reference.revision !== archive.source.revision) fail("参考来源 revision 不符");
  const saved = JSON.parse(buffers[0]!.toString());
  const online: RetrievalDocument[] = saved.documents;
  // Eight source rows are small and static. Verify exact source fields rather than inventing a second policy.
  const seedRows = [...seed.split("INSERT INTO knowledge_documents", 2)[1]!.matchAll(/\('([^']+)', (NULL|'[^']+'), (NULL|'[^']+'), '([^']+)',\s*'([^']+)',\s*JSON_ARRAY\(([^)]+)\)\)/g)].map((match) => ({
    id: match[1], shopId: match[2] === "NULL" ? null : match[2]!.slice(1, -1), productId: match[3] === "NULL" ? null : match[3]!.slice(1, -1),
    title: match[4], body: match[5], tags: [...match[6]!.matchAll(/'([^']+)'/g)].map(item => item[1]), status: "active",
  }));
  if (saved.version !== 1 || online?.length !== 8 || source.online.documents !== 8 || JSON.stringify(online) !== JSON.stringify(seedRows)
    || source.reference.documents !== 35 || archive.documents.length !== 35) fail("在线原文或基础语料数量不符");
  const documents: Record<"online" | "reference", RetrievalDocument[]> = { online, reference: archive.documents };
  if (!Array.isArray(source.fixtures) || source.fixtures.length !== 2) fail("inactive 干扰定义无效");
  for (const [index, corpus] of (["online", "reference"] as const).entries()) {
    const fixture = source.fixtures[index];
    const expectedId = corpus === "online" ? "FIX-INACTIVE-SHOP" : "FIX-INACTIVE-PARKING";
    const originalId = corpus === "online" ? "KB-SHOP-DEMO-1" : "SH002";
    if (fixture.corpus !== corpus || fixture.id !== expectedId || fixture.copyOf !== originalId || fixture.shopId !== "shop-fixture-retired"
      || fixture.productId !== null || fixture.status !== "inactive") fail("inactive 干扰只允许固定原文副本");
    const original = documents[corpus].find(doc => doc.id === originalId)!;
    documents[corpus].push({ ...original, id: expectedId, shopId: fixture.shopId, productId: null, status: "inactive" });
  }
  const development = validateAcceptanceQuestions(JSON.parse(buffers[1]!.toString()), "development", documents);
  const validation = validateAcceptanceQuestions(JSON.parse(buffers[2]!.toString()), "validation", documents);
  const developmentQueries = new Set(development.map(q => JSON.stringify([q.corpus, q.query.trim()])));
  if (validation.some(q => developmentQueries.has(JSON.stringify([q.corpus, q.query.trim()])))) fail("开发和固定验证出现完全重复问题");
  let selected = split === "development" ? development : validation;
  let selectedSource: unknown = { ...source, split, sourceManifestSha256: hash(sourceText), referenceArchive: archive.source };
  if (split === "support-validation") {
    const manifestText = await readFile(new URL("data/acceptance-support-validation-source.json", root), "utf8");
    const manifest = JSON.parse(manifestText);
    const path = "data/acceptance-support-validation.json";
    const bytes = await readFile(new URL(path, root));
    const sourceKeys = ["version", "createdDate", "split", "name", "validationPolicy", "dataset", "counts", "corpora", "baseFiles", "review"];
    if (!object(manifest) || Object.keys(manifest).some(key => !sourceKeys.includes(key)) || manifest.version !== 1
      || manifest.split !== split || manifest.validationPolicy !== "fixed-validation-not-blind" || !object(manifest.dataset)
      || Object.keys(manifest.dataset).some(key => !["path", "sha256", "bytes"].includes(key))
      || manifest.dataset.path !== path || manifest.dataset.sha256 !== hash(bytes) || manifest.dataset.bytes !== bytes.length
      || JSON.stringify(manifest.counts) !== JSON.stringify(expectedCounts[split])) fail("事实支持验证的来源、冻结哈希或数量无效");
    const baseFiles = Object.fromEntries(files.map((file, index) => [file, hash(buffers[index]!)]));
    baseFiles["data/acceptance-source.json"] = hash(sourceText);
    if (!object(manifest.baseFiles) || Object.keys(manifest.baseFiles).length !== Object.keys(baseFiles).length
      || Object.entries(baseFiles).some(([file, sha]) => (manifest.baseFiles as Record<string, unknown>)[file] !== sha)) fail("事实支持验证绑定的原政策/题集来源已变化");
    if (!object(manifest.review) || manifest.review.stage !== "frozen-before-new-verifier-evaluation"
      || manifest.review.isBlind !== false || manifest.review.newVerifierInspected !== false) fail("事实支持验证必须保留非盲测与冻结时点声明");
    selected = validateAcceptanceQuestions(JSON.parse(bytes.toString()), split, documents);
    const previous = new Set([...development, ...validation].map(q => JSON.stringify([q.corpus, q.query.trim()])));
    if (selected.some(q => previous.has(JSON.stringify([q.corpus, q.query.trim()])))) fail("事实支持验证与已有题集完全重复");
    const corpusCounts = Object.fromEntries((["online", "reference"] as const).map(corpus => {
      const rows = selected.filter(q => q.corpus === corpus);
      return [corpus, { standard: rows.filter(q => q.suite === "standard").length, no_answer: rows.filter(q => q.suite === "no_answer").length,
        scope: rows.filter(q => q.suite === "scope").length, total: rows.length }];
    }));
    if (JSON.stringify(manifest.corpora) !== JSON.stringify(corpusCounts)) fail("事实支持验证 corpus 分层数量不符");
    selectedSource = { ...manifest, sourceManifestSha256: hash(manifestText), baseSource: source, referenceArchive: archive.source };
  }
  return { source: selectedSource,
    corpora: (["online", "reference"] as const).map(id => ({ id, documents: documents[id], questions: selected.filter(q => q.corpus === id) })) };
}
