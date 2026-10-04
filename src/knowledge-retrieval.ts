// ponytail: keyword retrieval covers the small synthetic corpus; measure recall before adding BM25 or vectors.
export function rankKnowledge<T extends { id: string; tags: readonly string[] }>(query: string, documents: readonly T[]): T[] {
  const normalized = query.toLocaleLowerCase();
  return documents.map(document => ({
    document,
    score: document.tags.filter(tag => tag && normalized.includes(tag.toLocaleLowerCase())).length,
  })).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .map(({ document }) => document);
}
