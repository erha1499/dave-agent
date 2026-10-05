import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const embeddingModel = "text-embedding-v4";
export const embeddingDimensions = 1024;
export const rerankModel = "qwen3-rerank";
export const rerankInstruction = "Given a web search query, retrieve relevant passages that answer the query.";
export const contentHash = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
type Kind = "embedding" | "rerank";
export type BailianAttempt = {
  kind: Kind; model: string; attempt: number; durationMs: number; httpStatus: number | null;
  outcome: "ok" | "http_error" | "network_error" | "timeout" | "invalid_response";
  totalTokens: number | null; requestId: string | null;
};
export type BailianResult<T> = { value: T; requestHash: string; attempts: BailianAttempt[] };
export class BailianError extends Error {
  readonly attempts: BailianAttempt[];
  constructor(message: string, attempts: BailianAttempt[] = []) { super(message); this.name = "BailianError"; this.attempts = attempts; }
}
export class BailianBudgetStop extends BailianError {
  constructor(attempts: BailianAttempt[]) { super("百炼实验达到请求或连续失败预算；未继续发送。", attempts); this.name = "BailianBudgetStop"; }
}
export type BailianRequestControls = { beforeAttempt?: () => boolean; onAttempt?: (attempt: BailianAttempt) => void };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

// Only the explicitly configured official origin receives credentials. Never follow redirects.
export function resolveBailianEndpoints(base: string) {
  let url: URL;
  try { url = new URL(base); } catch { throw new BailianError("DASHSCOPE_BASE_URL 必须是完整的官方 HTTPS 地址。"); }
  const host = url.hostname;
  const official = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(host)
    || /^[a-z0-9][a-z0-9-]{0,62}\.(cn-beijing|cn-hongkong|ap-southeast-1|us-east-1)\.maas\.aliyuncs\.com$/.test(host);
  const path = url.pathname.replace(/\/$/, "");
  if (url.protocol !== "https:" || !official || url.port || url.username || url.password || url.search || url.hash
    || !["", "/compatible-mode/v1", "/compatible-mode/v1/embeddings", "/compatible-api/v1", "/compatible-api/v1/reranks"].includes(path)) {
    throw new BailianError("DASHSCOPE_BASE_URL 仅允许官方主机及已支持的根地址、compatible-mode/v1 或 compatible-api/v1 接口路径。");
  }
  return { origin: url.origin, embedding: `${url.origin}/compatible-mode/v1/embeddings`, rerank: `${url.origin}/compatible-api/v1/reranks` };
}

function usage(value: unknown) {
  return record(value) && Number.isSafeInteger(value.total_tokens) && Number(value.total_tokens) > 0 ? Number(value.total_tokens) : null;
}
function requestId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}
function texts(values: readonly string[], max: number) {
  if (!Array.isArray(values) || !values.length || values.length > max || values.some(value => typeof value !== "string" || !value.trim() || value.length > 32_768)) {
    throw new BailianError(`输入必须包含 1–${max} 条非空、长度有界的文本。`);
  }
}
export function validVector(value: unknown, dimensions = embeddingDimensions): value is number[] {
  return Array.isArray(value) && value.length === dimensions && value.every(item => typeof item === "number" && Number.isFinite(item))
    && Number.isFinite(value.reduce((sum, item) => sum + item * item, 0)) && value.some(item => item !== 0);
}

export function createBailianClient(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number; retries?: number } = {}) {
  const env = options.env ?? process.env, key = env.DASHSCOPE_API_KEY?.trim();
  if (!key || /[\r\n]/.test(key)) throw new BailianError("请在本机环境中配置 DASHSCOPE_API_KEY。");
  if (!env.DASHSCOPE_BASE_URL) throw new BailianError("请在本机环境中配置 DASHSCOPE_BASE_URL。");
  const endpoints = resolveBailianEndpoints(env.DASHSCOPE_BASE_URL);
  const fetcher = options.fetch ?? fetch, timeoutMs = options.timeoutMs ?? 15_000, retries = options.retries ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(retries) || retries < 0 || retries > 2) {
    throw new BailianError("百炼超时或重试配置无效。");
  }
  async function request<T>(kind: Kind, body: Record<string, unknown>, parse: (value: unknown) => T, controls: BailianRequestControls = {}): Promise<BailianResult<T>> {
    const attempts: BailianAttempt[] = [], requestHash = contentHash({ endpoint: endpoints[kind], body });
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (controls.beforeAttempt && !controls.beforeAttempt()) throw new BailianBudgetStop(attempts);
      const started = performance.now(), controller = new AbortController();
      let timedOut = false, retryable = false;
      const entry: BailianAttempt = { kind, model: String(body.model), attempt, durationMs: 0, httpStatus: null, outcome: "network_error", totalTokens: null, requestId: null };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("timeout")); }, timeoutMs); });
      try {
        const value = await Promise.race([(async () => {
          const response = await fetcher(endpoints[kind], { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(body), redirect: "error", signal: controller.signal });
          if (timedOut) throw new Error("timeout");
          entry.httpStatus = response.status;
          if (!response.ok) { entry.outcome = "http_error"; retryable = [408, 429, 500, 502, 503, 504].includes(response.status); throw new Error("http"); }
          entry.outcome = "invalid_response";
          const data: unknown = await response.json();
          if (timedOut) throw new Error("timeout");
          if (record(data)) { entry.totalTokens = usage(data.usage); entry.requestId = requestId(data.request_id ?? data.id); }
          return parse(data);
        })(), timeout]);
        entry.outcome = "ok"; entry.durationMs = Math.round(performance.now() - started); attempts.push(entry);
        controls.onAttempt?.(entry);
        return { value, requestHash, attempts };
      } catch {
        if (timedOut) entry.outcome = "timeout";
        if (["network_error", "timeout"].includes(entry.outcome)) retryable = true;
        entry.durationMs = Math.round(performance.now() - started); attempts.push(entry);
        controls.onAttempt?.(entry);
        if (!retryable || attempt > retries) throw new BailianError(`百炼 ${kind} 请求未完成：${entry.outcome}。`, attempts);
      } finally { if (timer) clearTimeout(timer); }
      await delay(Math.min(250 * 2 ** (attempt - 1), 1000));
    }
    throw new BailianError("百炼请求未完成。", attempts);
  }
  return {
    settings: { endpoints, timeoutMs, retries, embeddingModel, dimensions: embeddingDimensions, rerankModel, rerankInstruction },
    async embed(input: readonly string[], controls?: BailianRequestControls): Promise<BailianResult<number[][]>> {
      texts(input, 10);
      return request("embedding", { model: embeddingModel, input, dimensions: embeddingDimensions, encoding_format: "float" }, value => {
        if (!record(value) || !Array.isArray(value.data) || value.data.length !== input.length) throw new Error("embedding response");
        const vectors: number[][] = new Array(input.length), seen = new Set<number>();
        for (const row of value.data) {
          if (!record(row) || !Number.isSafeInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= input.length
            || seen.has(Number(row.index)) || !validVector(row.embedding)) throw new Error("embedding vector");
          vectors[Number(row.index)] = row.embedding; seen.add(Number(row.index));
        }
        return vectors;
      }, controls);
    },
    async rerank(query: string, documents: readonly string[], controls?: BailianRequestControls): Promise<BailianResult<Array<{ index: number; score: number }>>> {
      texts([query], 1); texts(documents, 500);
      // Request every candidate's rank for diagnostics; delivery still takes top 5. Provider enforces token limits without silent truncation.
      return request("rerank", { model: rerankModel, query, documents, top_n: documents.length, instruct: rerankInstruction }, value => {
        if (!record(value) || !Array.isArray(value.results) || value.results.length !== documents.length) throw new Error("rerank response");
        const seen = new Set<number>();
        const ranks = value.results.map(row => {
          if (!record(row) || !Number.isSafeInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= documents.length || seen.has(Number(row.index))
            || typeof row.relevance_score !== "number" || !Number.isFinite(row.relevance_score) || row.relevance_score < 0 || row.relevance_score > 1) throw new Error("rerank index or score");
          seen.add(Number(row.index)); return { index: Number(row.index), score: row.relevance_score };
        });
        if (ranks.some((item, index) => index > 0 && item.score > ranks[index - 1]!.score)) throw new Error("rerank order");
        return ranks;
      }, controls);
    },
  };
}
export type BailianClient = ReturnType<typeof createBailianClient>;
