import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contentHash } from "./bailian.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "./coupon-store.ts";
import { knowledgeApplicabilitySourceHash } from "./knowledge-applicability.ts";
import { createKnowledgeService, type KnowledgeTrace } from "./knowledge-service.ts";
import { scopeDocuments, type RetrievalDocument } from "./retrieval-ranking.ts";
import type { Reply } from "./reply.ts";

type Channel = "银行卡" | "电子钱包";
type Scope = { shopId: string | null; productId: string | null };
type Coverage = { version: string; channel: Channel; prerequisites: ["refund_approved", "refund_initiated"];
  businessDays: { minimum: number; maximum: number }; quote: string; sourceHash: string; scope: Scope };
type Rule = { source: RetrievalDocument; coverage?: Coverage | null };
export type ArrivalConsultationTrace = {
  version: "arrival-consultation-v1"; requestId: string; identity: QQIdentity; originalText: string;
  orderId: string | null; channel: Channel | null; scope: Scope; canonicalQuestion: string | null;
  assumptions: ["refund_approved", "refund_initiated"];
  status: "accepted" | "rejected" | "unavailable"; reason: string | null;
  sources: Array<Coverage & { evidenceId: string }>;
  rulesHash: string | null; lastRulesCheck: { stage: "knowledge_recheck" | "post_order_authorization"; observedAt: string; hash: string } | null;
  knowledge: KnowledgeTrace | null;
  providerCalls: { agent: 0; question: 0; rerank: 0; support: 0 };
};
type Options = { readRules?: () => Promise<unknown>; signal?: AbortSignal; onTrace?: (trace: ArrivalConsultationTrace) => void };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const sameScope = (a: Scope, b: Scope) => a.shopId === b.shopId && a.productId === b.productId;
const quoteFor = (channel: Channel, minimum: number, maximum: number) =>
  `假设退款已审核通过并已发起，${channel}渠道通常在${minimum}–${maximum}个工作日到账。`;
const disclaimer = "这是项目原创模拟规则的假设咨询，咨询渠道不代表实际支付渠道；未办理退款，也不证明这笔退款已批准、已发起或已到账，不涉及真实资金。";
const instruction = "请完整发送单行指令：查询到账 [COUPON-xxxx] 银行卡或电子钱包；每次只咨询一个渠道，可省略订单号。";
const scopeOf = (order: Awaited<ReturnType<CouponStore["getOrder"]>>, orderId: string): Scope => {
  const products = new Set(order?.items?.map(item => item.productId));
  if (order?.source !== "demo-database" || order.id !== orderId || !id(order.shop?.id)
    || products.size !== 1 || !id([...products][0])) throw new Error("scope_changed");
  return { shopId: order.shop.id, productId: [...products][0]! };
};

function validateRules(value: unknown): Rule[] {
  function fail(): never { throw new Error("metadata_invalid"); }
  if (!object(value) || !keys(value, ["version", "simulation", "documents"]) || value.version !== 1 || value.simulation !== true
    || !Array.isArray(value.documents) || !value.documents.length || value.documents.length > 20) fail();
  const rules: Rule[] = [];
  for (const raw of value.documents) {
    if (!object(raw) || !keys(raw, ["source", "coverage"]) || !object(raw.source)
      || !keys(raw.source, ["id", "title", "body", "tags", "shopId", "productId", "status"])
      || !id(raw.source.id) || typeof raw.source.title !== "string" || !raw.source.title.trim() || raw.source.title.length > 256
      || typeof raw.source.body !== "string" || !raw.source.body.trim() || raw.source.body.length > 4096
      || !Array.isArray(raw.source.tags) || raw.source.tags.length > 16 || raw.source.tags.some(tag => typeof tag !== "string" || tag.length > 64)
      || raw.source.productId === undefined || !["active", "inactive"].includes(String(raw.source.status))) fail();
    const source = raw.source as RetrievalDocument;
    try { scopeDocuments([source], {}); } catch { fail(); }
    const coverage = raw.coverage;
    if (coverage !== undefined && coverage !== null) {
      if (!object(coverage) || !keys(coverage, ["version", "channel", "prerequisites", "businessDays", "quote", "sourceHash", "scope"])
        || !id(coverage.version) || !["银行卡", "电子钱包"].includes(String(coverage.channel))
        || !Array.isArray(coverage.prerequisites) || coverage.prerequisites.length !== 2
        || coverage.prerequisites[0] !== "refund_approved" || coverage.prerequisites[1] !== "refund_initiated"
        || !object(coverage.businessDays) || !keys(coverage.businessDays, ["minimum", "maximum"])
        || !Number.isSafeInteger(coverage.businessDays.minimum) || !Number.isSafeInteger(coverage.businessDays.maximum)
        || Number(coverage.businessDays.minimum) < 1 || Number(coverage.businessDays.maximum) < Number(coverage.businessDays.minimum)
        || Number(coverage.businessDays.maximum) > 30 || !object(coverage.scope) || !keys(coverage.scope, ["shopId", "productId"])
        || coverage.scope.shopId !== source.shopId || coverage.scope.productId !== source.productId
        || coverage.sourceHash !== knowledgeApplicabilitySourceHash(source)
        || coverage.quote !== quoteFor(coverage.channel as Channel, Number(coverage.businessDays.minimum), Number(coverage.businessDays.maximum))
        || !source.body.includes(String(coverage.quote))) fail();
    }
    rules.push({ source, ...(coverage !== undefined ? { coverage: coverage as Coverage | null } : {}) });
  }
  try { scopeDocuments(rules.map(rule => rule.source), {}); } catch { fail(); }
  return rules;
}

// A bounded, explicit consultation command. Natural-language arrival questions remain on the existing route.
export function createArrivalConsultation(store: Pick<CouponStore, "getOrder">, options: Options = {}) {
  const readRules = options.readRules ?? (async () => JSON.parse(await readFile(new URL("../data/arrival-consultation-v1.json", import.meta.url), "utf8")));
  return async (identity: QQIdentity, originalText: string): Promise<Reply | undefined> => {
    if (typeof originalText !== "string" || !originalText.replace(/[\p{C}\s]/gu, "").includes("查询到账")) return undefined;
    const trusted = { appId: identity?.appId, senderId: identity?.senderId };
    const trace: ArrivalConsultationTrace = { version: "arrival-consultation-v1", requestId: randomUUID(), identity: trusted, originalText,
      orderId: null, channel: null, scope: { shopId: null, productId: null }, canonicalQuestion: null,
      assumptions: ["refund_approved", "refund_initiated"], status: "rejected", reason: "invalid_input", sources: [], rulesHash: null, lastRulesCheck: null, knowledge: null,
      providerCalls: { agent: 0, question: 0, rerank: 0, support: 0 } };
    const finish = (reply: Reply): Reply => {
      // Observers receive a detached host audit and cannot break a safe user receipt.
      try { options.onTrace?.(structuredClone(trace)); } catch { /* Observer failure is not business authority. */ }
      return reply;
    };
    const notice = (text: string): Reply => ({ kind: "notice", text: `${text}\n${disclaimer}` });
    const command = /^[\p{Zs}\t]*查询到账[\p{Zs}\t]+(?:(COUPON-\d{4})[\p{Zs}\t]+)?(银行卡|电子钱包)[\p{Zs}\t]*$/u.exec(originalText);
    if (!command || originalText.length > 200 || /[\p{C}\p{Zl}\p{Zp}]/u.test(originalText.replace(/\t/g, ""))) return finish(notice(instruction));
    trace.orderId = command[1] ?? null; trace.channel = command[2] as Channel;
    trace.canonicalQuestion = `假设退款已审核通过并已发起，${trace.channel}渠道通常何时到账？`;
    const deadline = AbortSignal.timeout(10_000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    async function wait<T>(operation: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      let abort = () => {};
      const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
      try { const result = await Promise.race([operation(), stopped]); signal.throwIfAborted(); return result; }
      finally { signal.removeEventListener("abort", abort); }
    }
    try {
      if (typeof trusted.appId !== "string" || typeof trusted.senderId !== "string"
        || !/^[A-Za-z0-9_-]{1,32}$/.test(trusted.appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(trusted.senderId)) throw new OrderAccessError();
      if (trace.orderId) trace.scope = scopeOf(await wait(() => store.getOrder(trusted, trace.orderId!)), trace.orderId);
      const snapshots: Rule[][] = [];
      const service = createKnowledgeService({ async readKnowledgeDocuments() {
        const rules = validateRules(await wait(readRules)); snapshots.push(structuredClone(rules));
        return rules.map(rule => rule.source);
      } }, { mode: "lexical" });
      const result = await service.search({ query: trace.canonicalQuestion, originalQuery: originalText, scope: trace.scope, signal });
      trace.knowledge = result.trace;
      if (signal.aborted) throw signal.reason;
      if (result.trace.status === "unavailable" || snapshots.length !== 2) throw new Error(result.trace.reason ?? "source_unavailable");
      trace.rulesHash = contentHash(snapshots[0]);
      trace.lastRulesCheck = { stage: "knowledge_recheck", observedAt: new Date().toISOString(), hash: contentHash(snapshots[1]) };
      if (trace.rulesHash !== trace.lastRulesCheck.hash) throw new Error("source_changed");
      if (trace.orderId) {
        if (!sameScope(trace.scope, scopeOf(await wait(() => store.getOrder(trusted, trace.orderId!)), trace.orderId))) throw new Error("scope_changed");
        // Sequential final source check after awaited authorization, not a filesystem/DB atomic transaction.
        const currentRules = validateRules(await wait(readRules));
        trace.lastRulesCheck = { stage: "post_order_authorization", observedAt: new Date().toISOString(), hash: contentHash(currentRules) };
        if (trace.rulesHash !== trace.lastRulesCheck.hash) throw new Error("source_changed");
      }
      const visible = new Set(scopeDocuments(snapshots[1]!.map(rule => rule.source), trace.scope).map(source => source.id));
      const candidates = snapshots[1]!.filter(rule => visible.has(rule.source.id) && rule.coverage?.channel === trace.channel);
      if (!candidates.length) { trace.reason = "coverage_unknown"; return finish(notice("当前来源没有覆盖此渠道及完整前提的审阅规则，请向人工核实；不能使用通用到账数字代替。")); }
      const claims = new Set(candidates.map(rule => JSON.stringify(rule.coverage!.businessDays)));
      if (claims.size !== 1) { trace.reason = "rule_conflict"; return finish(notice("当前适用的模拟规则存在时限冲突，请人工核实；本次不承诺到账时限。")); }
      const accepted = new Set(result.documents.map(source => source.sourceId));
      if (candidates.length > 5 || candidates.some(rule => !accepted.has(rule.source.id))) throw new Error("coverage_incomplete");
      trace.sources = candidates.map(rule => ({ ...structuredClone(rule.coverage!), evidenceId: rule.source.id }));
      trace.status = "accepted"; trace.reason = null;
      const quote = trace.sources[0]!.quote;
      return finish({ kind: "answer", text: `【项目原创模拟规则咨询】\n${trace.orderId ? `仅以本人订单 ${trace.orderId} 的当前商品范围查阅规则。\n` : "未绑定订单，仅咨询全局演示规则。\n"}${quote}\n实际处理异常需要另行核实。\n${disclaimer}`,
        evidenceIds: trace.sources.map(source => source.evidenceId) });
    } catch (error) {
      trace.status = "unavailable"; trace.sources = [];
      trace.reason = signal.aborted ? options.signal?.aborted ? "aborted" : "timeout" : error instanceof OrderAccessError ? "unauthorized"
        : error instanceof Error && ["scope_changed", "source_changed", "coverage_incomplete"].includes(error.message) ? error.message : "source_or_order_unavailable";
      return finish(notice("当前订单或渠道规则无法安全核实，请核对本人订单或稍后重试；本次不承诺到账时限。"));
    }
  };
}
