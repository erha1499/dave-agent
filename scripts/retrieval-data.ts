import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type KnowledgeDocument = {
  id: string; title: string; body: string; tags: string[]; shopId: string | null; industry: string;
};
export type RetrievalQuestion = {
  id: string; suite: "standard" | "hard"; query: string; relevant: string[]; shopId: string | null;
  industry?: string; kind?: string; context?: { industry?: string; sku_name?: string; verified?: boolean };
};
type Counts = { documents: number; standard: number; hard: number };
export type RetrievalSource = {
  repo: string; revision: string; files: Record<string, { sha256: string; bytes: number }>;
  counts: Counts; selection: { documentIds: string[]; counts: Counts };
};
const directory = new URL("../data/reference/kefu-harness/", import.meta.url);
const files = ["LICENSE", "NOTICE.md", "data/knowledge/docs.jsonl", "data/evalsets/retrieval.jsonl", "data/evalsets/retrieval_hard.jsonl"] as const;
function invalid(path: string, reason: string): never { throw new Error(`检索数据无效：${path} ${reason}`); }
function record(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "必须为对象");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !allowed.includes(key))) invalid(path, "包含未知字段");
  return row;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(path, "必须为非空字符串");
  return value;
}
function identifier(value: unknown, path: string): string {
  const text = string(value, path);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) invalid(path, "标识格式无效");
  return text;
}
function strings(value: unknown, path: string, nonempty = false): string[] {
  if (!Array.isArray(value) || (nonempty && !value.length)) invalid(path, "必须为有效数组");
  const result = value.map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) invalid(path, "存在重复值");
  return result;
}

// Validate the complete archive before any selection; the runner chooses subset or full-corpus mode.
export function validateRetrievalData(docs: unknown[], standard: unknown[], hard: unknown[], selectedIds: readonly string[]) {
  if (![docs, standard, hard].every(Array.isArray)) invalid("corpus", "必须为数组");
  if (!docs.length || !standard.length || !hard.length) invalid("corpus", "文档和两份题集不能为空");
  const documentIds = new Set<string>();
  const documents: KnowledgeDocument[] = docs.map((value, index) => {
    const path = `docs:${index + 1}`, row = record(value, path, ["doc_id", "title", "text", "tags", "industry", "shop_id"]);
    const id = identifier(row.doc_id, `${path}.doc_id`);
    if (documentIds.has(id)) invalid(path, "重复 doc_id");
    documentIds.add(id);
    return { id, title: string(row.title, `${path}.title`), body: string(row.text, `${path}.text`),
      tags: strings(row.tags, `${path}.tags`), industry: string(row.industry, `${path}.industry`),
      shopId: row.shop_id === undefined ? null : identifier(row.shop_id, `${path}.shop_id`) };
  });
  const selected = strings(selectedIds, "selection.documentIds", true);
  if (selected.some(id => !documentIds.has(id))) invalid("selection.documentIds", "包含未知文档");
  const byId = new Map(documents.map(document => [document.id, document])), inputs = new Set<string>();
  const questions: RetrievalQuestion[] = [];
  for (const [suite, rows] of [["standard", standard], ["hard", hard]] as const) {
    rows.forEach((value, index) => {
      const id = `${suite}-${String(index + 1).padStart(4, "0")}`;
      const row = record(value, id, suite === "standard" ? ["query", "relevant", "industry", "shop_id"] : ["query", "relevant", "kind", "ctx"]);
      const question: RetrievalQuestion = { id, suite, query: string(row.query, `${id}.query`), relevant: strings(row.relevant, `${id}.relevant`, true), shopId: null };
      if (suite === "standard") {
        question.industry = string(row.industry, `${id}.industry`);
        question.shopId = row.shop_id === null ? null : identifier(row.shop_id, `${id}.shop_id`);
      } else {
        question.kind = string(row.kind, `${id}.kind`);
        if (!["口语省略", "同义替换", "场景描述"].includes(question.kind)) invalid(id, "未知 hard.kind");
        const ctx = record(row.ctx, `${id}.ctx`, ["industry", "sku_name", "verified"]);
        question.context = {};
        if (ctx.industry !== undefined) question.context.industry = string(ctx.industry, `${id}.ctx.industry`);
        if (ctx.sku_name !== undefined) question.context.sku_name = string(ctx.sku_name, `${id}.ctx.sku_name`);
        if (ctx.verified !== undefined) {
          if (typeof ctx.verified !== "boolean") invalid(id, "ctx.verified 必须为布尔值");
          question.context.verified = ctx.verified;
        }
      }
      const industry = question.industry ?? question.context?.industry;
      for (const relevant of question.relevant) {
        const document = byId.get(relevant);
        if (!document) invalid(id, `relevant 引用了未知文档 ${relevant}`);
        if (document.shopId !== null && document.shopId !== question.shopId) invalid(id, "relevant 店铺范围不一致");
        if (industry && document.industry !== "通用" && document.industry !== industry) invalid(id, "relevant 行业范围不一致");
      }
      // Kind/labels cannot turn the same retrieval input into a second, conflicting question.
      const input = JSON.stringify([question.query.trim(), question.shopId, industry ?? null, question.context?.sku_name ?? null, question.context?.verified ?? null]);
      if (inputs.has(input)) invalid(id, "重复题目或冲突标签");
      inputs.add(input); questions.push(question);
    });
  }
  return { documents, questions, selectedIds: selected };
}

function counts(value: unknown, path: string, expected: Counts): Counts {
  const row = record(value, path, ["documents", "standard", "hard"]);
  for (const key of ["documents", "standard", "hard"] as const) if (row[key] !== expected[key]) invalid(path, `${key} 数量不匹配`);
  return expected;
}
function jsonl(bytes: Buffer, path: string): unknown[] {
  const lines = bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { return invalid(`${path}:${index + 1}`, "JSONL 行无效（不跳过空行或重新编号）"); }
  });
}
export async function loadRetrievalData() {
  const manifest = record(JSON.parse(await readFile(new URL("source.json", directory), "utf8")), "source", ["repo", "revision", "files", "counts", "selection"]);
  const repo = string(manifest.repo, "source.repo"), revision = string(manifest.revision, "source.revision");
  if (repo !== "https://github.com/wanglongze123/kefu-harness" || !/^[a-f0-9]{40}$/.test(revision)) invalid("source", "来源或 commit 格式无效");
  const hashes = record(manifest.files, "source.files", files);
  const checked = await Promise.all(files.map(async path => {
    const meta = record(hashes[path], `source.files.${path}`, ["sha256", "bytes"]);
    const bytes = await readFile(new URL(path, directory)), sha256 = createHash("sha256").update(bytes).digest("hex");
    if (meta.sha256 !== sha256 || meta.bytes !== bytes.length) invalid(path, "SHA256 或字节数与 source.json 不匹配");
    return { path, buffer: bytes, sha256, bytes: bytes.length };
  }));
  const buffers = checked.map(file => file.buffer);
  const archived = Object.fromEntries(checked.map(({ path, buffer: _buffer, ...meta }) => [path, meta]));
  const selection = record(manifest.selection, "source.selection", ["documentIds", "counts"]);
  const data = validateRetrievalData(jsonl(buffers[2]!, files[2]), jsonl(buffers[3]!, files[3]), jsonl(buffers[4]!, files[4]), strings(selection.documentIds, "selection.documentIds", true));
  const selected = new Set(data.selectedIds), subset = data.questions.filter(question => question.relevant.every(id => selected.has(id)));
  const source: RetrievalSource = { repo, revision, files: archived,
    counts: counts(manifest.counts, "source.counts", { documents: data.documents.length, standard: data.questions.filter(question => question.suite === "standard").length, hard: data.questions.filter(question => question.suite === "hard").length }),
    selection: { documentIds: data.selectedIds, counts: counts(selection.counts, "source.selection.counts", { documents: selected.size, standard: subset.filter(question => question.suite === "standard").length, hard: subset.filter(question => question.suite === "hard").length }) } };
  return { ...data, source };
}
