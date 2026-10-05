import { rankKnowledge } from "./knowledge-retrieval.ts";

export type RetrievalDocument = {
  id: string; title: string; body: string; tags: readonly string[];
  shopId: string | null; productId?: string | null; status?: "active" | "inactive";
};
export type RetrievalScope = { shopId?: string | null; productId?: string | null };
export type RankedDocument = { id: string; score: number };

export type RetrievalExperimentParameters = {
  candidateTopK: number; bm25K1: number; bm25B: number; rrfK: number; rrfWindow: number;
  cache: "reuse" | "refresh"; timeoutMs: number; retries: number; maxRequests: number; consecutiveFailureLimit: number;
};
const parameterDefaults: Readonly<RetrievalExperimentParameters> = Object.freeze({ candidateTopK: 20, bm25K1: 1.2, bm25B: .75,
  rrfK: 60, rrfWindow: 20, cache: "reuse", timeoutMs: 15_000, retries: 1, maxRequests: 1200, consecutiveFailureLimit: 5 });

export function resolveRetrievalParameters(input: Partial<RetrievalExperimentParameters> = {}): RetrievalExperimentParameters {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => typeof key !== "string" || !Object.hasOwn(parameterDefaults, key))) {
    throw new Error("检索实验参数包含未知字段或无效对象。");
  }
  const parameters = { ...parameterDefaults, ...input };
  const ranges = { candidateTopK: [1, 100], bm25K1: [.1, 3], bm25B: [0, 1], rrfK: [1, 200], rrfWindow: [1, 100],
    timeoutMs: [1000, 60_000], retries: [0, 2], maxRequests: [1, 10_000], consecutiveFailureLimit: [1, 20] } as const;
  for (const name of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const value = parameters[name], [minimum, maximum] = ranges[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum
      || (!["bm25K1", "bm25B"].includes(name) && !Number.isSafeInteger(value))) throw new Error(`检索实验参数 ${name} 无效。`);
  }
  if (parameters.cache !== "reuse" && parameters.cache !== "refresh") throw new Error("检索实验参数 cache 无效。");
  return parameters;
}

export const retrievalRankingSettings = Object.freeze({ bm25: Object.freeze({ k1: parameterDefaults.bm25K1, b: parameterDefaults.bm25B }),
  rrf: Object.freeze({ k: parameterDefaults.rrfK, topK: parameterDefaults.rrfWindow }),
  tokenizer: "lexical-normalization-icu-domain-terms-v1", serialization: "json-title-tags-body-v1" });

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ranked = (items: RankedDocument[]) => items.sort((a, b) => b.score - a.score || compareId(a.id, b.id));
const scopeId = (value: unknown) => value === undefined || value === null
  || (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value));

// Match search_faq's document predicate before calculating corpus statistics or similarity.
// Parent shop/product active status must already be validated by the caller, as in CouponStore.
export function scopeDocuments<T extends RetrievalDocument>(documents: readonly T[], scope: RetrievalScope): T[] {
  if (!scope || !scopeId(scope.shopId) || !scopeId(scope.productId) || (scope.productId && !scope.shopId)) {
    throw new Error("Invalid retrieval scope: product requires an explicit shop.");
  }
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document.id !== "string" || !document.id.trim() || ids.has(document.id)
      || typeof document.title !== "string" || typeof document.body !== "string"
      || !Array.isArray(document.tags) || document.tags.some(tag => typeof tag !== "string")
      || document.shopId === undefined || !scopeId(document.shopId) || !scopeId(document.productId)
      || (document.productId && !document.shopId)
      || (document.status !== undefined && document.status !== "active" && document.status !== "inactive")) {
      throw new Error("Invalid or duplicate retrieval document.");
    }
    ids.add(document.id);
  }
  return documents.filter(document => document.status !== "inactive"
    && (document.shopId === null || document.shopId === (scope.shopId ?? null))
    && (document.productId == null || document.productId === (scope.productId ?? null)))
    .sort((a, b) => compareId(a.id, b.id));
}

// Preserve exact title/tags/body and their order; the same bytes feed embedding and reranking.
export function serializeRetrievalDocument(document: RetrievalDocument): string {
  return JSON.stringify({ title: document.title, tags: document.tags, body: document.body });
}

// M0 retains upstream ordering without inventing numeric lexical scores unavailable from that API.
export function rankLexical(query: string, documents: readonly RetrievalDocument[], scope: RetrievalScope): string[] {
  return rankKnowledge(query, scopeDocuments(documents, scope)).map(document => document.id);
}

// Copied from the frozen M0 tokenizer, which deliberately does not export these internals.
// BM25 retains occurrences instead of M0's query Set; it applies no field-specific score boosts.
const synonyms: Record<string, string[]> = {
  退款: ["退钱", "退费", "返款", "返还", "拿回钱"],
  未核销: ["未消费", "未使用", "没用过", "没去用", "还没用", "没使用", "没去过"],
  已核销: ["已消费", "已使用", "用过了", "消费过"],
  到账: ["到帐"], 过期: ["作废", "到期"], 改期: ["改时间", "换时间", "变更时间"],
  预约: ["预订", "预定"], 排队: ["候位", "等位", "干等"], 外带: ["带回家", "带走"],
};
const aliases = new Map(Object.entries(synonyms).flatMap(([word, variants]) => variants.map(value => [value, word] as const)));
const pattern = new RegExp([...aliases.keys()].sort((a, b) => b.length - a.length).join("|"), "gu");
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(pattern, word => aliases.get(word)!);
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopwords = new Set("规则 使用 订单 团购 团购券 套餐 商家 商品 支持 需要 是否 可以 怎么 如何 什么 哪个 多少 有没有 建议 具体 申请 部分 说明 确认 相关 本店 演示 问题 查询 查看 当前 我们 你们 这个 那个 一般 通常 不能 不支持".split(" "));

function frequencies(value: string, domainTerms: ReadonlySet<string>): Map<string, number> {
  const normalized = normalize(value), result = new Map<string, number>();
  for (const part of segmenter.segment(normalized)) {
    if (part.isWordLike && part.segment.length > 1 && !stopwords.has(part.segment)) {
      result.set(part.segment, (result.get(part.segment) ?? 0) + 1);
    }
  }
  // M0 preserves canonical terms and intact tags even if ICU splits them. Count each occurrence
  // once for that term, including those already emitted whole by ICU.
  for (const term of domainTerms) {
    const count = normalized.split(term).length - 1;
    if (count) result.set(term, Math.max(count, result.get(term) ?? 0));
  }
  return result;
}

export function rankBm25(query: string, documents: readonly RetrievalDocument[], scope: RetrievalScope,
  options: { k1?: number; b?: number } = {}): RankedDocument[] {
  const { bm25K1: k1, bm25B: b } = resolveRetrievalParameters({ bm25K1: options.k1 ?? parameterDefaults.bm25K1, bm25B: options.b ?? parameterDefaults.bm25B });
  const visible = scopeDocuments(documents, scope);
  if (!visible.length) return [];
  const domainTerms = new Set([...Object.keys(synonyms), ...visible.flatMap(document => document.tags.map(normalize))]
    .filter(term => term.length > 1 && !stopwords.has(term)));
  const terms = [...frequencies(query, domainTerms).keys()];
  if (!terms.length) return [];
  const corpus = visible.map(document => {
    const counts = frequencies([document.title, ...new Set(document.tags.map(normalize)), document.body].join("\n"), domainTerms);
    return { id: document.id, counts, length: [...counts.values()].reduce((sum, count) => sum + count, 0) };
  });
  const averageLength = corpus.reduce((sum, document) => sum + document.length, 0) / corpus.length;
  if (!averageLength) return [];
  const idf = new Map(terms.map(term => {
    const frequency = corpus.filter(document => document.counts.has(term)).length;
    return [term, Math.log(1 + (corpus.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  return ranked(corpus.map(document => ({ id: document.id, score: terms.reduce((score, term) => {
    const tf = document.counts.get(term) ?? 0;
    return score + idf.get(term)! * tf * (k1 + 1) / (tf + k1 * (1 - b + b * document.length / averageLength));
  }, 0) })).filter(document => document.score > 0));
}

function unitVector(vector: readonly number[], dimension?: number): number[] {
  if (!Array.isArray(vector) || !vector.length || (dimension !== undefined && vector.length !== dimension)
    || vector.some(value => !Number.isFinite(value))) throw new Error("Invalid embedding dimension or value.");
  // Scale first so finite very large/small coordinates do not overflow/underflow the norm.
  const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (!scale) throw new Error("Zero embedding vector.");
  const scaled = vector.map(value => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map(value => value / norm);
}

export function rankDense(queryVector: readonly number[], documents: readonly RetrievalDocument[],
  embeddings: ReadonlyMap<string, readonly number[]>, scope: RetrievalScope): RankedDocument[] {
  const visible = scopeDocuments(documents, scope);
  if (!visible.length) return [];
  const query = unitVector(queryVector);
  return ranked(visible.map(document => {
    const embedding = embeddings.get(document.id);
    if (!embedding) throw new Error(`Missing embedding for document ${document.id}.`);
    const vector = unitVector(embedding, query.length);
    const cosine = query.reduce((sum, value, index) => sum + value * vector[index]!, 0);
    return { id: document.id, score: Math.max(-1, Math.min(1, cosine)) };
  }));
}

// Input order is the ranking, including each route's deterministic tie order. Scores are validated
// but not blended. Defaults use the first 20 positions per route, with 1-based ranks and k=60.
export function reciprocalRankFusion(rankings: readonly (readonly RankedDocument[])[], options: { k?: number; topK?: number } = {}): RankedDocument[] {
  const { rrfK: k, rrfWindow: topK } = resolveRetrievalParameters({ rrfK: options.k ?? parameterDefaults.rrfK, rrfWindow: options.topK ?? parameterDefaults.rrfWindow });
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const ids = new Set<string>();
    ranking.forEach((document, index) => {
      if (!document || typeof document.id !== "string" || !document.id.trim()
        || ids.has(document.id) || !Number.isFinite(document.score)) throw new Error("Invalid or duplicate ranked document.");
      ids.add(document.id);
      if (index < topK) scores.set(document.id, (scores.get(document.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return ranked([...scores].map(([id, score]) => ({ id, score })));
}
