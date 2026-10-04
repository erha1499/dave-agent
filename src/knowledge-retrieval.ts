type Document = { id: string; tags: readonly string[]; title?: string; body?: string };

// Frozen P0 comparator; keep its normalization and scoring unchanged for offline comparisons.
export function rankKnowledgeBaseline<T extends Document>(query: string, documents: readonly T[]): T[] {
  const normalized = query.toLocaleLowerCase();
  return documents.map(document => ({
    document,
    score: document.tags.filter(tag => tag && normalized.includes(tag.toLocaleLowerCase())).length,
  })).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .map(({ document }) => document);
}

// Candidate retrieval only: synonyms never establish order state, approval or answerability.
const synonyms: Record<string, string[]> = {
  退款: ["退钱", "退费", "返款", "返还", "拿回钱"],
  未核销: ["未消费", "未使用", "没用过", "没去用", "还没用", "没使用", "没去过"],
  已核销: ["已消费", "已使用", "用过了", "消费过"],
  到账: ["到帐"],
  过期: ["作废", "到期"],
  改期: ["改时间", "换时间", "变更时间"],
  预约: ["预订", "预定"],
  排队: ["候位", "等位", "干等"],
  外带: ["带回家", "带走"],
};
const aliases = new Map(Object.entries(synonyms).flatMap(([word, variants]) => variants.map(value => [value, word] as const)));
const pattern = new RegExp([...aliases.keys()].sort((a, b) => b.length - a.length).join("|"), "gu");
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(pattern, word => aliases.get(word)!);
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopwords = new Set("规则 使用 订单 团购 团购券 套餐 商家 商品 支持 需要 是否 可以 怎么 如何 什么 哪个 多少 有没有 建议 具体 申请 部分 说明 确认 相关 本店 演示 问题 查询 查看 当前 我们 你们 这个 那个 一般 通常 不能 不支持".split(" "));
const words = (value: string) => new Set([...segmenter.segment(value)]
  .filter(part => part.isWordLike && part.segment.length > 1 && !stopwords.has(part.segment)).map(part => part.segment));

// ponytail: bounded in-memory lexical ranking; evaluate semantic misses before adding embeddings or a service.
export function rankKnowledge<T extends Document>(query: string, documents: readonly T[]): T[] {
  const normalized = normalize(query), terms = words(normalized);
  // Synonym targets must survive ICU splitting even when they appear only in title/body.
  for (const term of Object.keys(synonyms)) if (normalized.includes(term)) terms.add(term);
  const candidates = documents.map(document => {
    const tags = [...new Set(document.tags.map(normalize))];
    // Keep explicit domain tags intact even when ICU splits them into single characters.
    for (const tag of tags) if (tag.length > 1 && !stopwords.has(tag) && normalized.includes(tag)) terms.add(tag);
    return { document, tags, title: normalize(document.title ?? ""), body: normalize(document.body ?? "") };
  });
  // Rare terms (e.g. invoice vs refund) should outrank boilerplate shared by many rules.
  const weights = new Map([...terms].map(term => [term, 1 + Math.log((documents.length + 1) /
    (1 + candidates.filter(item => item.tags.some(tag => tag.includes(term)) || item.title.includes(term) || item.body.includes(term)).length))]));
  return candidates.map(({ document, tags, title, body }) => {
    let score = 0;
    for (const term of terms) score += weights.get(term)! * ((tags.includes(term) ? 5 : tags.some(tag => tag.includes(term)) ? 2 : 0)
      + (title.includes(term) ? 2 : 0) + (body.includes(term) ? 1 : 0));
    return { document, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .map(({ document }) => document);
}
