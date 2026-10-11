// Bounded, redacted diagnostics for a failed model turn. Logs keep an error
// class and the first line of a message; never request bodies, user text,
// credentials or a provider's raw response body.
export type ModelFailureSource = "assistant_error" | "prompt_error" | "transport_error" | "stream_read_error";
export type ModelFailureDetail = { source: ModelFailureSource; errorName: string | null; message: string | null };

export const modelFailureMessageLimit = 160;
const secretPatterns: RegExp[] = [
  /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{6,}/gu,
  /\bBearer\s+\S+/giu,
  /\b(api[_-]?key|token|secret|password|authorization)\b(\s*[:=]\s*)\S+/giu,
  /\b[A-Za-z0-9+/_-]{32,}={0,2}/gu,
];
const sources: ModelFailureSource[] = ["assistant_error", "prompt_error", "transport_error", "stream_read_error"];
const validName = (name: unknown) => typeof name === "string" && /^[A-Za-z_$][\w$.]{0,63}$/u.test(name) ? name : null;

function bodySummary(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    const error = value && typeof value === "object" ? (value as Record<string, unknown>).error ?? value : undefined;
    if (!error || typeof error !== "object") return "[body omitted]";
    const fields = ["type", "code", "message"].map(key => (error as Record<string, unknown>)[key])
      .filter((field): field is string | number => typeof field === "string" || typeof field === "number").map(String);
    return fields.length ? fields.join(" ") : "[body omitted]";
  } catch { return "[body omitted]"; }
}

export function redactModelFailureMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.split(/\r?\n/u, 1)[0]!.trim();
  // Provider bodies are summarized to type/code/message; the raw JSON never reaches the log.
  const brace = text.indexOf("{");
  if (brace >= 0) text = `${text.slice(0, brace)}${bodySummary(text.slice(brace))}`.trim();
  for (const pattern of secretPatterns) text = text.replace(pattern, (_match, key?: string, separator?: string) =>
    typeof key === "string" && typeof separator === "string" ? `${key}${separator}[redacted]` : "[redacted]");
  text = text.replace(/\s+/gu, " ").trim();
  if (!text) return null;
  return text.length > modelFailureMessageLimit ? `${text.slice(0, modelFailureMessageLimit - 1)}…` : text;
}

function errorName(error: unknown): string | null {
  return error instanceof Error ? validName(error.name || error.constructor?.name) : null;
}

export function summarizeModelFailure(source: ModelFailureSource, error: unknown): ModelFailureDetail {
  if (!sources.includes(source)) throw new Error("模型失败摘要来源无效。");
  const cause = error instanceof Error && error.cause instanceof Error ? `; cause ${errorName(error.cause) ?? "Error"}: ${error.cause.message}` : "";
  const message = typeof error === "string" ? error : error instanceof Error ? `${error.message}${cause}` : null;
  return { source, errorName: errorName(error), message: redactModelFailureMessage(message) };
}

// Re-checks a detail before it enters the shared ledger, so a caller-built value
// cannot bypass the bound or redaction.
export function normalizeModelFailureDetail(detail: ModelFailureDetail): ModelFailureDetail {
  if (!detail || !sources.includes(detail.source)) throw new Error("模型失败摘要来源无效。");
  return { source: detail.source, errorName: validName(detail.errorName), message: redactModelFailureMessage(detail.message) };
}
