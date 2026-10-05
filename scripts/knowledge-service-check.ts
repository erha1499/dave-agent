import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Pool } from "mysql2/promise";
import { contentHash, createBailianClient } from "../src/bailian.ts";
import { CouponStore } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, evidenceSupportInputHash, evidenceSupportTypedPromptVersion, evidenceSupportTypedV6Prompt,
  evidenceSupportTypedV6PromptVersion, resolveEvidenceSupportModel } from "../src/evidence-support.ts";
import { createKnowledgeService, type KnowledgeServiceOptions } from "../src/knowledge-service.ts";
import { rankKnowledge } from "../src/knowledge-retrieval.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import { knowledgeProviderSpans } from "../src/knowledge-evaluation.ts";
import { summarizeEvaluation, type EvalSpan } from "../src/evaluation.ts";
import { analyzeSupportSpans } from "../src/support-evaluation.ts";
import { buildKnowledgeApplicabilityContext, knowledgeApplicabilitySourceHash, validateKnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";

const docs: RetrievalDocument[] = [
  { id: "A", title: "退款规则", body: "未使用的券可申请退款。", tags: ["退款"], shopId: null, productId: null, status: "active" },
  { id: "B", title: "到期规则", body: "具体日期以本人订单 expiresAt 为准。", tags: ["到期"], shopId: "shop-a", productId: "product-a", status: "active" },
  { id: "C", title: "其他店规则", body: "未知范围不能使用本篇。", tags: ["退款"], shopId: "shop-b", productId: null, status: "active" },
  { id: "D", title: "失效规则", body: "已失效。", tags: ["退款"], shopId: null, productId: null, status: "inactive" },
];
const scope = { shopId: "shop-a", productId: "product-a" }, query = "未使用券可以退款吗？";
let expectedRetrievalQuery = query, expectedEvidenceQuery = query;
let rows = structuredClone(docs), reads = 0, reranks = 0, judges = 0, supports = true;
let scores = [.9, .8], rerankError = false, rerankInvalid = false, supportInvalid = false;
let onRerank = async () => {}, onSupport = async () => {};
const store = { async readKnowledgeDocuments(shopId?: string, productId?: string) {
  reads++; assert.equal(shopId, scope.shopId); assert.equal(productId, scope.productId); return structuredClone(rows);
} };
const rerank = createBailianClient({ timeoutMs: 1000, retries: 0, env: { DASHSCOPE_API_KEY: "fake-key-never-sent", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
  fetch: async (_url, options) => {
    reranks++; await onRerank(); const body = JSON.parse(String(options?.body));
    assert.equal(body.query, expectedRetrievalQuery); assert.equal(body.documents.length, 2);
    assert.ok(!/gold|expectedBehavior|history|customerId/.test(JSON.stringify(body)));
    const parsed = body.documents.map((text: string) => JSON.parse(text));
    assert.deepEqual(parsed.map((doc: { title: string }) => doc.title), [docs[0]!.title, docs[1]!.title]);
    if (rerankError) throw new Error("SECRET provider error");
    return new Response(JSON.stringify({ results: rerankInvalid ? [] : scores.map((score, index) => ({ index, relevance_score: score })), usage: { total_tokens: 100 } }));
  } });
const model = { provider: "deepseek", id: resolveEvidenceSupportModel().model, api: "openai-completions", baseUrl: "https://api.deepseek.com", maxTokens: 4096,
  cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } };
const support = await createEvidenceSupportClient({ timeoutMs: 1000, runtime: { model, complete: async (context, options): Promise<AssistantMessage> => {
  judges++; await onSupport(); assert.equal(options.maxRetries, 0); assert.deepEqual(context.tools, []);
  const payload = JSON.parse(String(context.messages[0]!.content)); assert.equal(payload.query, expectedEvidenceQuery);
  assert.ok(!/gold|expectedBehavior|history|customerId/.test(JSON.stringify(payload)));
  return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    content: [{ type: "text", text: JSON.stringify({ decisions: payload.documents.map((doc: { id: string; body: string }) => ({
      id: doc.id, supported: supports, quote: supports ? supportInvalid ? "原文没有这一句" : doc.body : null, reason: "测试固定判断",
    })) }) }], usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
      cost: { input: .000003, output: .000004, cacheRead: 0, cacheWrite: 0, total: .000007 } } };
} } });
const options: KnowledgeServiceOptions = { mode: "m4-support", timeoutMs: 1000, clients: { rerank, support } };
const service = createKnowledgeService(store, options);
const stages: string[] = [];
const good = await service.search({ query, originalQuery: "那退款呢？", scope, onStage: stage => stages.push(stage) });
assert.equal(good.trace.status, "accepted"); assert.equal(good.trace.query, query); assert.equal(good.trace.originalQuery, "那退款呢？");
assert.equal(good.trace.supportModel, "configured"); assert.equal(good.trace.settings!.support!.model, model.id);
assert.equal(good.trace.threshold, .71); assert.deepEqual(stages, ["read", "rerank", "support", "recheck"]);
assert.deepEqual(good.documents.map(doc => doc.sourceId), ["A", "B"]); assert.equal(reads, 2); assert.equal(reranks, 1); assert.equal(judges, 1);
assert.equal(good.trace.sourceHashes.before, good.trace.sourceHashes.after);
assert.deepEqual(good.trace.sources, good.documents.map(doc => ({ sourceId: doc.sourceId, version: createHash("sha256").update(JSON.stringify(doc)).digest("hex") })));
assert.equal(good.trace.supportVerification!.requestHash, good.trace.calls.find(call => call.operation === "support")!.requestHash);
assert.equal(good.trace.supportVerification!.inputHash, evidenceSupportInputHash({ query, scope, settings: support.settings,
  candidates: docs.slice(0, 2).map((doc, index) => ({ ...doc, score: scores[index]!, rank: index + 1 })) }));
assert.deepEqual(good.trace.supportVerification!.value, good.documents.map(doc => ({ id: doc.sourceId, supported: true, quote: doc.body, reason: "测试固定判断" })));
assert.deepEqual(good.trace.supportVerification!.attempts, good.trace.calls.find(call => call.operation === "support")!.attempts);
assert.deepEqual(good.trace.usage, { rerankTokens: 100, supportTokens: 50, estimatedCny: .00005, estimatedUsd: .000007, incompleteCalls: 0 });
assert.equal(good.trace.settings!.support!.promptVersion, "fact-support-v1"); assert.ok(!JSON.stringify(good).includes("fake-key"));
const faqSpan: EvalSpan = { id: "faq", parentSpanId: null, actor: "host", trigger: "user", component: "business-service", name: "search_faq",
  observedAt: new Date().toISOString(), durationMs: good.trace.durationMs, outcome: "ok", output: good.documents,
  knowledge: { trace: good.trace, context: { originalQuery: "那退款呢？", modelQuestion: null, effectiveQuery: query,
    purpose: "user_policy", orderSource: "current_explicit", scopeSource: "fresh_order", facts: null, policyTopic: null, objectReference: null } } };
const providerSpans = knowledgeProviderSpans(faqSpan), analysis = analyzeSupportSpans([faqSpan, ...providerSpans]);
assert.deepEqual(analysis.issues, []); assert.equal(providerSpans.length, 2); assert.equal(faqSpan.usage, undefined);
assert.equal(analysis.providers.reduce((sum, provider) => sum + provider.requests, 0), 2);
assert.equal(providerSpans[0]!.usage!.cost!.source, "price_estimate"); assert.equal(providerSpans[0]!.usage!.cost!.currency, "CNY");
assert.equal(providerSpans[1]!.usage!.cost!.currency, "USD");
assert.equal(summarizeEvaluation([{ id: "c", name: "c", category: "test", status: "passed", turns: [{ index: 1, question: query, reply: "",
  status: "passed", startedAt: faqSpan.observedAt, durationMs: 1, firstTextMs: null, evidenceIds: [], checks: [], steps: [], spans: [faqSpan, ...providerSpans] }] }]).modelRequests, 0,
  "knowledge requests do not inflate Agent model steps");
const unreported = structuredClone(faqSpan); unreported.knowledge!.trace.calls[0]!.attempts = [];
const uncertain = knowledgeProviderSpans(unreported)[0]!; assert.equal(uncertain.usage!.totalTokens, null); assert.equal(uncertain.usage!.cost, null); assert.equal(uncertain.durationMs, null);
const partialUsage = analyzeSupportSpans([unreported, ...knowledgeProviderSpans(unreported)]);
assert.deepEqual(partialUsage.issues, []); assert.equal(partialUsage.providers.reduce((sum, item) => sum + item.requests, 0), 2);
assert.equal(partialUsage.providers.reduce((sum, item) => sum + item.usageReported, 0), 1, "unreported requests remain in usage coverage denominator");
assert.equal(partialUsage.providers.find(item => item.model === "qwen3-rerank")!.knownTokens, null);
delete unreported.knowledge!.trace.settings;
const unknownUsage = analyzeSupportSpans([unreported, ...knowledgeProviderSpans(unreported)]).providers.find(item => item.provider === "unknown")!;
assert.equal(unknownUsage.requests, 1); assert.equal(unknownUsage.usageReported, 0); assert.deepEqual(unknownUsage.costs, []);
assert.deepEqual(knowledgeProviderSpans({ ...faqSpan, knowledge: undefined }), []);
await service.search({ query, scope }); assert.equal(reads, 4); assert.equal(reranks, 2); assert.equal(judges, 2, "no result cache");

const beforeLexical = { reranks, judges };
const lexical = await createKnowledgeService(store).search({ query, scope });
assert.equal(lexical.trace.threshold, null); assert.deepEqual(lexical.documents.map(doc => doc.sourceId), rankKnowledge(query, docs.slice(0, 2)).slice(0, 5).map(doc => doc.id));
assert.deepEqual({ reranks, judges }, beforeLexical); assert.deepEqual(lexical.trace.calls, []);
assert.equal(lexical.trace.supportVerification, undefined);
assert.deepEqual(lexical.trace.usage, { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 });

const empty = await createKnowledgeService({ readKnowledgeDocuments: async () => [] }, { mode: "m4-support" }).search({ query, scope });
assert.equal(empty.trace.status, "rejected"); assert.deepEqual(empty.trace.calls, [], "empty sources never create provider clients/read keys");
assert.deepEqual(knowledgeProviderSpans({ ...faqSpan, knowledge: { ...faqSpan.knowledge!, trace: empty.trace } }), [], "a source read without provider calls creates no request denominator");
scores = [.7, .6]; const judgeCount = judges;
const below = await createKnowledgeService(store, { ...options, clients: { rerank } }).search({ query, scope });
assert.equal(below.trace.status, "rejected"); assert.equal(judges, judgeCount); assert.equal(below.trace.calls.length, 1, "below-score candidates never create support client");
assert.equal(below.trace.supportVerification, undefined);
scores = [.9, .8]; supports = false;
const unsupported = await service.search({ query, scope }); assert.equal(unsupported.trace.status, "rejected"); assert.deepEqual(unsupported.documents, []);
assert.deepEqual(unsupported.trace.sources, []);
assert.deepEqual(unsupported.trace.supportVerification!.value, ["A", "B"].map(id => ({ id, supported: false, quote: null, reason: "测试固定判断" })));
supports = true;
for (const mutate of [() => { rows[0]!.body = "规则已修改"; }, () => { rows[0]!.status = "inactive"; },
  () => { rows[0]!.shopId = "different-shop"; }, () => { rows = []; }]) {
  rows = structuredClone(docs); onSupport = async () => mutate();
  const stale = await service.search({ query, scope });
  assert.equal(stale.trace.status, "unavailable"); assert.equal(stale.trace.reason, "source_changed"); assert.deepEqual(stale.documents, []);
  assert.deepEqual(stale.trace.acceptance!.accepted, []); assert.notEqual(stale.trace.sourceHashes.before, stale.trace.sourceHashes.after);
  assert.deepEqual(stale.trace.sources, [], "changed sources are never presented as current accepted versions");
  assert.deepEqual(stale.trace.supportVerification!.value, good.trace.supportVerification!.value, "completed judgment remains an audit of the original input, never current accepted evidence");
}
rows = structuredClone(docs); onSupport = async () => {};
rows[0]!.body = "更新后的未使用券退款规则。";
const revised = await service.search({ query, scope });
assert.equal(revised.trace.status, "accepted");
assert.notEqual(revised.trace.sources![0]!.version, good.trace.sources![0]!.version, "current accepted content has a new version");
assert.equal(revised.trace.sources![1]!.version, good.trace.sources![1]!.version, "unchanged accepted content retains its version");
rows = structuredClone(docs);
rerankError = true; const startCalls = reranks;
const providerFailed = await service.search({ query, scope });
assert.equal(reranks, startCalls + 1, "no retry"); assert.equal(providerFailed.trace.status, "unavailable"); assert.deepEqual(providerFailed.documents, []);
assert.equal(providerFailed.trace.usage.rerankTokens, null); assert.equal(providerFailed.trace.usage.estimatedCny, null); assert.equal(providerFailed.trace.usage.incompleteCalls, 1);
assert.ok(!JSON.stringify(providerFailed).includes("SECRET")); rerankError = false;
rerankInvalid = true; const badRerank = await service.search({ query, scope });
assert.equal(badRerank.trace.status, "unavailable"); assert.equal(badRerank.trace.usage.rerankTokens, 100, "invalid response still bills reported tokens"); rerankInvalid = false;
supportInvalid = true; const badSupport = await service.search({ query, scope });
assert.equal(badSupport.trace.status, "unavailable"); assert.deepEqual(badSupport.documents, []); assert.equal(badSupport.trace.usage.supportTokens, 50); supportInvalid = false;
assert.equal(badSupport.trace.supportVerification, undefined, "invalid provider output is not presented as verified decisions");
assert.equal(badSupport.trace.supportFailure!.code, "invalid_quote"); assert.match(badSupport.trace.supportFailure!.outputHash!, /^[a-f0-9]{64}$/);
assert.deepEqual(Object.keys(badSupport.trace.supportFailure!).sort(), ["code", "outputHash"]);

const cancelled = new AbortController(); cancelled.abort(); const callsBeforeAbort = reranks;
assert.equal((await service.search({ query, scope, signal: cancelled.signal })).trace.reason, "aborted"); assert.equal(reranks, callsBeforeAbort);
const controller = new AbortController(); onRerank = async () => { controller.abort(); await delay(20); };
const readingBeforeAbort = reads, judgeBeforeAbort = judges;
const abortResult = await service.search({ query, scope, signal: controller.signal }); const frozenAbort = JSON.stringify(abortResult);
assert.equal(abortResult.trace.reason, "aborted"); assert.equal(abortResult.trace.usage.rerankTokens, null);
await delay(40); assert.equal(reads, readingBeforeAbort + 1); assert.equal(judges, judgeBeforeAbort); assert.equal(JSON.stringify(abortResult), frozenAbort, "late provider completion cannot mutate returned trace");
onRerank = async () => {};
const supportAbort = new AbortController(); onSupport = async () => { supportAbort.abort(); await delay(20); };
const readsBeforeSupportAbort = reads;
const stoppedSupport = await service.search({ query, scope, signal: supportAbort.signal });
assert.equal(stoppedSupport.trace.reason, "aborted"); assert.equal(stoppedSupport.trace.usage.supportTokens, null);
assert.equal(stoppedSupport.trace.usage.estimatedUsd, null); assert.deepEqual(stoppedSupport.documents, []);
assert.equal(stoppedSupport.trace.supportVerification, undefined, "unfinished support has no fabricated judgment");
await delay(40); assert.equal(reads, readsBeforeSupportAbort + 1, "aborted support never continues to recheck/delivery"); onSupport = async () => {};
const six = Array.from({ length: 6 }, (_, index) => ({ ...docs[0]!, id: `source-${index}` }));
const sixRerank = { settings: rerank.settings, rerank: async () => ({
  value: six.map((_, index) => ({ index, score: .99 - index * .01 })), requestHash: "mock-request",
  attempts: [{ kind: "rerank" as const, model: "qwen3-rerank", attempt: 1, durationMs: 1, httpStatus: 200,
    outcome: "ok" as const, totalTokens: 600, requestId: null }],
}) };
const topFive = await createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(six) },
  { ...options, clients: { rerank: sixRerank, support } }).search({ query, scope });
assert.equal(topFive.trace.rawRanking.length, 6); assert.equal(topFive.documents.length, 5);
assert.equal(topFive.trace.acceptance!.rejected.find(row => row.id === "source-5")!.reason, "top_k_limit");
const invalid = await service.search({ query, scope: { productId: "product-a" } });
assert.equal(invalid.trace.reason, "invalid_input"); assert.deepEqual(invalid.trace.calls, []);
const databaseFailed = await createKnowledgeService({ readKnowledgeDocuments: async () => { throw new Error("SECRET DATABASE"); } }).search({ query, scope });
assert.equal(databaseFailed.trace.reason, "database_unavailable"); assert.ok(!JSON.stringify(databaseFailed).includes("SECRET"));
const hang = createKnowledgeService({ readKnowledgeDocuments: () => delay(1200).then(() => []) }, { timeoutMs: 1000 });
const timedOut = await hang.search({ query, scope }); assert.equal(timedOut.trace.reason, "timeout"); assert.ok(timedOut.trace.durationMs < 1150);
assert.throws(() => createKnowledgeService(store, { threshold: NaN })); assert.throws(() => createKnowledgeService(store, { timeoutMs: 0 }));
assert.throws(() => createKnowledgeService(store, { mode: "lexical", supportProfile: "typed" }));
assert.throws(() => createKnowledgeService(store, { ...options, supportProfile: "typed" }), /profile 不一致/);
let typedJudges = 0;
let typedCorruption: "none" | "positive" | "negative" | "all" = "none";
const typedClient = await createEvidenceSupportClient({ profile: "typed", timeoutMs: 1000, runtime: { model, complete: async (context, parameters) => {
  typedJudges++; assert.equal(parameters.maxRetries, 0);
  const input = JSON.parse(String(context.messages[0]!.content));
  assert.ok(!/gold|expectedBehavior/.test(JSON.stringify(input)));
  return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    content: [{ type: "text", text: JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({
      id: doc.id, category: doc.id === "A" ? "direct_fact" : "limitation_only",
      quote: typedCorruption === "all" || typedCorruption === "positive" && doc.id === "A" || typedCorruption === "negative" && doc.id === "B" ? "非原文引文" : doc.body,
      reason: "固定工程分类",
    })) }) }], usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
      cost: { input: .000003, output: .000004, cacheRead: 0, cacheWrite: 0, total: .000007 } } };
} } });
assert.throws(() => createKnowledgeService(store, { ...options, clients: { rerank, support: typedClient } }), /profile 不一致/);
const typedService = createKnowledgeService(store, { ...options, supportProfile: "typed", clients: { rerank, support: typedClient } });
const typedResult = await typedService.search({ query, scope });
assert.equal(typedJudges, 1); assert.equal(typedResult.trace.supportProfile, "typed");
assert.deepEqual(typedResult.documents.map(doc => doc.sourceId), ["A"], "only direct facts are accepted; limitation remains an auditable rejection");
assert.deepEqual(typedResult.trace.supportVerification!.value.map(row => [row.category, row.supported]), [["direct_fact", true], ["limitation_only", false]]);
assert.equal(typedResult.trace.settings!.support!.promptVersion, evidenceSupportTypedPromptVersion);
assert.deepEqual(typedResult.trace.sources!.map(source => source.sourceId), ["A"]);

typedCorruption = "negative";
const partialKnowledge = await typedService.search({ query, scope });
assert.equal(partialKnowledge.trace.status, "accepted"); assert.deepEqual(partialKnowledge.documents.map(doc => doc.sourceId), ["A"]);
assert.equal(partialKnowledge.trace.supportVerification!.validation!.status, "partial");
assert.deepEqual(partialKnowledge.trace.supportVerification!.validation!.invalidDecisions, [{ id: "B", code: "invalid_quote" }]);
assert.equal(partialKnowledge.trace.calls.find(call => call.operation === "support")!.status, "partial");
const partialSpans = knowledgeProviderSpans({ ...faqSpan, knowledge: { ...faqSpan.knowledge!, trace: partialKnowledge.trace } });
assert.equal(partialSpans[1]!.outcome, "error"); assert.equal(partialSpans[1]!.usage!.totalTokens, 50);
assert.equal(partialKnowledge.trace.usage.supportTokens, 50);
assert.equal(analyzeSupportSpans(partialSpans).providers.find(provider => provider.model === model.id)!.usageReported, 1);
typedCorruption = "positive";
const invalidPositive = await typedService.search({ query, scope });
assert.equal(invalidPositive.trace.status, "unavailable"); assert.equal(invalidPositive.trace.reason, "invalid_support_decision");
assert.deepEqual(invalidPositive.documents, []); assert.equal(invalidPositive.trace.supportVerification!.validation!.status, "partial");
assert.ok(invalidPositive.trace.acceptance!.rejected.some(row => row.id === "A" && row.reason === "invalid_support_decision"));
typedCorruption = "all";
const invalidAll = await typedService.search({ query, scope });
assert.equal(invalidAll.trace.status, "unavailable"); assert.equal(invalidAll.trace.reason, "invalid_support_decision");
assert.equal(invalidAll.trace.supportVerification!.validation!.status, "unavailable");
assert.equal(invalidAll.trace.supportVerification!.attempts[0]!.outcome, "invalid_response");
assert.equal(invalidAll.trace.supportVerification!.validation!.invalidDecisions.length, 2); assert.equal(invalidAll.trace.usage.supportTokens, 50);
assert.ok(invalidAll.trace.acceptance!.rejected.every(row => row.reason !== "unsupported"));
typedCorruption = "none";

let v6Judges = 0;
const v6Client = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion, timeoutMs: 1000,
  runtime: { model, complete: async (context, parameters) => {
    v6Judges++; assert.equal(context.systemPrompt, evidenceSupportTypedV6Prompt); assert.equal(parameters.maxRetries, 0);
    const input = JSON.parse(String(context.messages[0]!.content)); assert.equal(input.query, query);
    return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
      content: [{ type: "text", text: JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({
        id: doc.id, category: doc.id === "A" ? "direct_fact" : "limitation_only", quote: doc.body, reason: "固定工程分类",
      })) }) }], usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
        cost: { input: .000003, output: .000004, cacheRead: 0, cacheWrite: 0, total: .000007 } } };
  } } });
const v6Options: KnowledgeServiceOptions = { ...options, supportProfile: "typed", supportPrompt: "v6", clients: { rerank, support: v6Client } };
const v6Result = await createKnowledgeService(store, v6Options).search({ query, scope });
assert.equal(v6Judges, 1); assert.equal(v6Result.trace.supportPrompt, "v6");
assert.equal(v6Result.trace.settings!.support!.promptVersion, evidenceSupportTypedV6PromptVersion);
assert.deepEqual(v6Result.documents, typedResult.documents); assert.equal(typedResult.trace.supportPrompt, "v5");
assert.notEqual(v6Result.trace.supportVerification!.requestHash, typedResult.trace.supportVerification!.requestHash);
assert.throws(() => createKnowledgeService(store, { ...v6Options, clients: { rerank, support: typedClient } }), /Prompt/);
assert.throws(() => createKnowledgeService(store, { ...v6Options, supportPrompt: "v5" }), /Prompt/);
assert.throws(() => createKnowledgeService(store, { ...v6Options, clients: { rerank, support: {
  ...v6Client, settings: { ...v6Client.settings, promptHash: typedClient.settings.promptHash },
} } }), /Prompt/);
assert.throws(() => createKnowledgeService(store, { supportPrompt: "v6" }));
assert.throws(() => createKnowledgeService(store, { ...options, supportPrompt: "v6" }));
assert.throws(() => createKnowledgeService(store, { ...options, supportPrompt: "v7" as "v5" }));

// Only the support judge changes model; mismatched injected clients cannot make the switch a no-op.
assert.throws(() => createKnowledgeService(store, { supportModel: "deepseek-v4-pro" }), /仅适用于/);
assert.throws(() => createKnowledgeService(store, { ...options, supportModel: "deepseek-v4-pro" }), /模型不一致/);
const proClient = await createEvidenceSupportClient({ modelSelection: "deepseek-v4-pro", profile: "typed", timeoutMs: 1000,
  env: { MODEL_PROVIDER: "deepseek" }, runtime: { model: { ...model, id: "deepseek-v4-pro" }, complete: async context => {
    const input = JSON.parse(String(context.messages[0]!.content));
    return { role: "assistant", api: "openai-completions", provider: "deepseek", model: "deepseek-v4-pro", stopReason: "stop", timestamp: 0,
      content: [{ type: "text", text: JSON.stringify({ decisions: input.documents.map((doc: { id: string; body: string }) => ({
        id: doc.id, category: "direct_fact", quote: doc.body, reason: "工程模型切换检查",
      })) }) }], usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
        cost: { input: .000003, output: .000004, cacheRead: 0, cacheWrite: 0, total: .000007 } } };
  } } });
assert.throws(() => createKnowledgeService(store, { ...options, supportProfile: "typed", clients: { rerank, support: proClient } }), /模型不一致/);
const proResult = await createKnowledgeService(store, { ...options, supportProfile: "typed", supportModel: "deepseek-v4-pro",
  clients: { rerank, support: proClient } }).search({ query, scope });
assert.equal(proResult.trace.status, "accepted"); assert.equal(proResult.trace.supportModel, "deepseek-v4-pro");
assert.equal(proResult.trace.settings!.support!.model, "deepseek-v4-pro");
assert.equal(proResult.trace.settings!.rerank!.rerankModel, good.trace.settings!.rerank!.rerankModel);
assert.equal(proResult.trace.supportVerification!.attempts[0]!.model, "deepseek-v4-pro");

// Actual Bailian input validation happens before its send hook: a local refusal is not a provider request.
const oversized = [{ ...docs[0]!, body: "长".repeat(33_000) }];
let localFetches = 0;
const localRerank = createBailianClient({ timeoutMs: 1000, retries: 0,
  env: { DASHSCOPE_API_KEY: "fake-never-sent", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
  fetch: async () => { localFetches++; throw new Error("should never send oversized input"); } });
const refusedLocally = await createKnowledgeService({ readKnowledgeDocuments: async () => oversized },
  { mode: "m4-support", timeoutMs: 1000, clients: { rerank: localRerank } }).search({ query, scope });
assert.equal(localFetches, 0); assert.equal(refusedLocally.trace.status, "unavailable"); assert.equal(refusedLocally.trace.reason, "invalid_input");
assert.deepEqual(refusedLocally.trace.calls, []); assert.equal(refusedLocally.trace.usage.incompleteCalls, 0);
assert.equal(refusedLocally.trace.usage.estimatedCny, 0);
assert.deepEqual(knowledgeProviderSpans({ ...faqSpan, knowledge: { ...faqSpan.knowledge!, trace: refusedLocally.trace } }), []);

// A synthetic rerank result isolates support's own preflight; no support completion starts for invalid candidates.
const judgesBeforeLocal = judges;
const supportPreflight = await createKnowledgeService({ readKnowledgeDocuments: async () => oversized }, { ...options,
  clients: { support, rerank: { settings: rerank.settings, rerank: async () => ({ requestHash: "fixed-rerank-test",
    value: [{ index: 0, score: .9 }], attempts: [{ kind: "rerank", model: "qwen3-rerank", attempt: 1, durationMs: 0,
      httpStatus: 200, outcome: "ok", totalTokens: 100, requestId: null }] }) } } }).search({ query, scope });
assert.equal(judges, judgesBeforeLocal); assert.equal(supportPreflight.trace.reason, "invalid_input");
assert.deepEqual(supportPreflight.trace.calls.map(call => call.operation), ["rerank"]);
assert.equal(supportPreflight.trace.usage.supportTokens, 0); assert.equal(supportPreflight.trace.usage.estimatedUsd, 0);

// Once fetch has started, an earlier host deadline must retain the unknown request in cost coverage.
let sentFetches = 0;
const hangingRerank = createBailianClient({ timeoutMs: 1500, retries: 0,
  env: { DASHSCOPE_API_KEY: "fake-only", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
  fetch: async (_url, request) => { sentFetches++; return new Promise((_resolve, reject) => request!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true })); } });
const sentTimeout = await createKnowledgeService({ readKnowledgeDocuments: async () => [docs[0]!] },
  { mode: "m4-support", timeoutMs: 1000, clients: { rerank: hangingRerank } }).search({ query, scope });
assert.equal(sentFetches, 1); assert.equal(sentTimeout.trace.reason, "timeout"); assert.equal(sentTimeout.trace.calls.length, 1);
assert.deepEqual(sentTimeout.trace.calls[0]!.attempts, []); assert.equal(sentTimeout.trace.usage.incompleteCalls, 1);
assert.equal(sentTimeout.trace.usage.rerankTokens, null); assert.equal(sentTimeout.trace.usage.estimatedCny, null);
const timeoutParent = { ...faqSpan, knowledge: { ...faqSpan.knowledge!, trace: sentTimeout.trace } };
const timeoutAnalysis = analyzeSupportSpans([timeoutParent, ...knowledgeProviderSpans(timeoutParent)]);
assert.equal(timeoutAnalysis.providers[0]!.requests, 1); assert.equal(timeoutAnalysis.providers[0]!.usageReported, 0);
const frozenTimeout = JSON.stringify(sentTimeout); await delay(600);
assert.equal(JSON.stringify(sentTimeout), frozenTimeout, "late provider completion cannot change returned accounting");

// Original store adapter retains the existing result shape, ranking and scoped SQL predicates.
const sqls: string[] = [];
const pool = { execute: async ({ sql }: { sql: string }, values: unknown[]) => {
  sqls.push(sql);
  if (sql.includes("FROM shops")) { assert.deepEqual(values, ["shop-a", "product-a", "product-a"]); return [[{ id: "shop-a" }]]; }
  assert.ok(sql.includes("status = 'active'")); assert.deepEqual(values, ["shop-a", "product-a"]);
  return [docs.slice(0, 2).map(doc => ({ id: doc.id, title: doc.title, body: doc.body, tags: JSON.stringify(doc.tags), shop_id: doc.shopId, product_id: doc.productId }))];
} } as unknown as Pool;
const couponStore = new CouponStore(pool);
const raw = await couponStore.readKnowledgeDocuments("shop-a", "product-a"); assert.deepEqual(raw, docs.slice(0, 2));
const legacy = await couponStore.searchKnowledge(query, "shop-a", "product-a"); assert.deepEqual(legacy, lexical.documents);
assert.equal(sqls.length, 4); await assert.rejects(couponStore.readKnowledgeDocuments(undefined, "product-a"));
assert.deepEqual(await new CouponStore({ execute: async () => [[]] } as unknown as Pool).readKnowledgeDocuments("inactive-shop"), []);

// Declared host facts filter the original score/Top5 candidates, independently of model semantics.
const gateDocs: RetrievalDocument[] = ["multi", "redeemed", "unused", "general", "other", "sixth"].map(id => ({
  id: `gate-${id}`, title: id, body: `${id} original rule.`, tags: [], shopId: null, productId: null, status: "active" }));
const gateSnapshot = validateKnowledgeApplicabilitySnapshot({ version: 1, serialization: "knowledge-document-v1", documents: gateDocs.map((doc, index) => ({
  sourceId: doc.id, sourceHash: knowledgeApplicabilitySourceHash(doc), scope: { shopId: null, productId: null },
  ...(index === 0 ? { minimumCouponCount: 2 } : index < 3 ? { atLeastOneCouponInStates: [index === 1 ? "redeemed" : "unused"] } : {}),
  basis: index < 3 ? [{ field: index === 0 ? "minimumCouponCount" : "atLeastOneCouponInStates", quote: doc.body }] : [], reviewNote: "Synthetic necessary prerequisite" })) });
const gateOrder: Awaited<ReturnType<CouponStore["getOrder"]>> = { source: "demo-database", id: "COUPON-9999", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
  amounts: { totalCents: 100, paidCents: 100, refundedCents: 0 }, createdAt: null, paidAt: null,
  shop: { id: scope.shopId, name: "unit", merchantName: "unit", address: "unit" },
  items: [{ id: "unit-item", productId: scope.productId, productName: "unit", quantity: 1, unitPriceCents: 100, totalCents: 100 }],
  coupons: [{ id: "unit-coupon", orderItemId: "unit-item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }], payments: [], refunds: [] };
const gateContext = buildKnowledgeApplicabilityContext({ order: gateOrder, requestId: "gate-request", purpose: "refund_eligibility" });
let gateRows = structuredClone(gateDocs), gateJudgments = 0, gateRequests = 0, onGateSupport = () => {};
let observedCandidateIds: string[] = [];
const gateRerank = createBailianClient({ timeoutMs: 1000, retries: 0, env: { DASHSCOPE_API_KEY: "fake-local", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
  fetch: async (_url, options) => { gateRequests++; const payload = JSON.parse(String(options!.body));
    const results = payload.documents.map((doc: string, index: number) => ({ index,
      relevance_score: .96 - gateDocs.findIndex(source => source.title === JSON.parse(doc).title) * .02 }))
      .sort((left: { relevance_score: number }, right: { relevance_score: number }) => right.relevance_score - left.relevance_score);
    return new Response(JSON.stringify({ results, usage: { total_tokens: 100 } })); } });
const gateSupport = await createEvidenceSupportClient({ timeoutMs: 1000, runtime: { model, complete: async (context): Promise<AssistantMessage> => {
  gateJudgments++; const payload = JSON.parse(String(context.messages[0]!.content));
  observedCandidateIds = payload.documents.map((doc: { id: string }) => doc.id); onGateSupport();
  return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    content: [{ type: "text", text: JSON.stringify({ decisions: payload.documents.map((doc: { id: string; body: string }) => ({ id: doc.id, supported: true, quote: doc.body, reason: "Synthetic supported fact" })) }) }],
    usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { input: .000003, output: .000004, cacheRead: 0, cacheWrite: 0, total: .000007 } } };
} } });
const gateStore = { readKnowledgeDocuments: async () => structuredClone(gateRows) };
const declaredOptions: KnowledgeServiceOptions = { mode: "m4-support", threshold: .5, timeoutMs: 1000, applicability: "declared",
  applicabilitySnapshot: gateSnapshot, clients: { rerank: gateRerank, support: gateSupport } };
const declaredService = createKnowledgeService(gateStore, declaredOptions);
const declared = await declaredService.search({ query, scope, applicabilityContext: gateContext });
assert.equal(declared.trace.status, "accepted"); assert.equal(declared.trace.applicability!.gate!.integrity, true);
assert.deepEqual(declared.trace.rawRanking.map(row => row.id), gateDocs.map(doc => doc.id));
assert.deepEqual(observedCandidateIds, gateDocs.slice(2, 5).map(doc => doc.id));
assert.deepEqual(declared.trace.acceptance!.accepted.map(doc => doc.rank), [3, 4, 5], "Never refill or renumber after host exclusions");
assert.equal(declared.trace.acceptance!.rejected.filter(row => row.reason === "applicability_mismatch").length, 2);
assert.ok(declared.trace.acceptance!.rejected.some(row => row.id === "gate-sixth" && row.reason === "top_k_limit"));
assert.equal(declared.trace.settings!.applicability!.snapshotHash, gateSnapshot.sha256);
assert.equal(declared.trace.applicability!.gate!.contextHash, gateContext.factsHash);
assert.deepEqual(declared.trace.usage, good.trace.usage, "Local host gating adds neither model calls nor fees");
const declaredRequests = gateRequests, declaredJudgments = gateJudgments;
gateRows = gateDocs.slice(0, 2);
const allExcluded = await declaredService.search({ query, scope, applicabilityContext: gateContext });
assert.equal(allExcluded.trace.status, "rejected"); assert.deepEqual(allExcluded.documents, []);
assert.equal(gateJudgments, declaredJudgments); assert.equal(gateRequests, declaredRequests + 1);
assert.deepEqual(allExcluded.trace.calls.map(call => call.operation), ["rerank"]);
assert.equal(allExcluded.trace.usage.estimatedUsd, 0); assert.equal(allExcluded.trace.supportVerification, undefined);
assert.ok(allExcluded.trace.acceptance!.rejected.every(row => row.reason === "applicability_mismatch"), "Gate mismatch is not model unsupported");

gateRows = structuredClone(gateDocs);
const incompleteOrder = structuredClone(gateOrder); incompleteOrder.items[0]!.quantity = 2;
const unknownContext = buildKnowledgeApplicabilityContext({ order: incompleteOrder, requestId: "gate-request", purpose: "refund_eligibility" });
const unknown = await declaredService.search({ query, scope, applicabilityContext: unknownContext });
assert.equal(unknown.trace.status, "accepted"); assert.equal(unknown.trace.applicability!.gate!.integrity, false);
assert.deepEqual(unknown.documents.map(doc => doc.sourceId), ["gate-general", "gate-other"]);
assert.equal(unknown.trace.applicability!.gate!.decisions.filter(row => row.status === "unknown").length, 3);
gateRows = gateDocs.slice(0, 3);
const onlyUnknown = await declaredService.search({ query, scope, applicabilityContext: unknownContext });
assert.equal(onlyUnknown.trace.status, "unavailable"); assert.equal(onlyUnknown.trace.reason, "applicability_facts_unknown");
assert.deepEqual(onlyUnknown.trace.calls.map(call => call.operation), ["rerank"]);
assert.ok(onlyUnknown.trace.acceptance!.rejected.every(row => row.reason === "applicability_unknown"));

gateRows = [{ ...gateDocs[0]!, body: "changed current original" }];
for (const applicabilityContext of [gateContext, null]) {
  const stale = await declaredService.search({ query, scope, applicabilityContext });
  assert.equal(stale.trace.status, "unavailable"); assert.equal(stale.trace.reason, "metadata_binding_invalid");
  assert.deepEqual(stale.trace.calls.map(call => call.operation), ["rerank"]);
  assert.equal(stale.trace.applicability!.gate!.integrity, false);
}
gateRows = [{ ...gateDocs[0]!, id: "reference-unannotated" }];
const reference = await declaredService.search({ query, scope });
assert.equal(reference.trace.status, "accepted"); assert.equal(reference.trace.applicability!.gate!.decisions[0]!.status, "not_checked");
const missingMetadata = await declaredService.search({ query, scope, applicabilityContext: gateContext });
assert.equal(missingMetadata.trace.status, "unavailable"); assert.equal(missingMetadata.trace.reason, "metadata_binding_invalid");
gateRows = structuredClone(gateDocs);
const generic = await declaredService.search({ query, scope });
assert.equal(generic.documents.length, 5); assert.ok(generic.trace.applicability!.gate!.decisions.every(row => row.status === "not_checked"));
onGateSupport = () => { gateRows[0]!.body = "Excluded source changed during support"; };
const changedExcluded = await declaredService.search({ query, scope, applicabilityContext: gateContext });
assert.equal(changedExcluded.trace.status, "unavailable"); assert.equal(changedExcluded.trace.reason, "source_changed");
assert.deepEqual(changedExcluded.documents, []); onGateSupport = () => {};
gateRows = structuredClone(gateDocs);
const malformedSnapshot = { ...gateSnapshot, documents: [] };
const modelOnly = await createKnowledgeService(gateStore, { ...declaredOptions, applicability: "model_only", applicabilitySnapshot: malformedSnapshot }).search({ query, scope, applicabilityContext: gateContext });
assert.equal(modelOnly.trace.status, "accepted"); assert.equal(modelOnly.documents.length, 5, "model_only neither reads nor validates metadata");
assert.deepEqual(modelOnly.trace.applicability, { mode: "model_only" }); assert.equal(modelOnly.trace.settings!.applicability, undefined);
assert.equal(contentHash(modelOnly.trace.rawRanking), contentHash(declared.trace.rawRanking));
assert.throws(() => createKnowledgeService(gateStore, { applicability: "declared" }));

// The actual provider requests must diverge only at ranking; fact verification
// and its hash still bind the complete host evidence, including dates/counts.
rows = structuredClone(docs); scores = [.9, .8]; supports = true;
const compactQuery = "未使用券可以退款吗？\n已核实订单商品：午餐套餐。\n订单状态对应的规则条件：未核销退款。";
const fullQuery = `${compactQuery}\n本单共1张，未核销1张、已核销0张。有效期截至2027-01-01。`;
expectedEvidenceQuery = fullQuery;
const queryRuns = [];
for (const queryMode of ["combined", "separated"] as const) {
  expectedRetrievalQuery = queryMode === "combined" ? fullQuery : compactQuery;
  const before: { reads: number; reranks: number; judges: number } = { reads, reranks, judges };
  const result = await createKnowledgeService(store, { ...options, queryMode }).search({
    query: fullQuery, retrievalQuery: compactQuery, originalQuery: query, scope,
  });
  assert.equal(result.trace.status, "accepted");
  assert.deepEqual(result.trace.queries, { version: "knowledge-query-plan-v1", mode: queryMode, retrieval: expectedRetrievalQuery, evidence: fullQuery });
  assert.equal(result.trace.query, expectedRetrievalQuery);
  assert.equal(result.trace.originalQuery, query);
  assert.deepEqual({ reads: reads - before.reads, reranks: reranks - before.reranks, judges: judges - before.judges }, { reads: 2, reranks: 1, judges: 1 });
  const candidates = docs.slice(0, 2).map((doc, index) => ({ ...doc, score: scores[index]!, rank: index + 1 }));
  assert.equal(result.trace.supportVerification!.inputHash, evidenceSupportInputHash({ query: fullQuery, scope, settings: support.settings, candidates }));
  assert.notEqual(result.trace.supportVerification!.inputHash, evidenceSupportInputHash({ query: compactQuery, scope, settings: support.settings, candidates }));
  queryRuns.push(result);
}
assert.deepEqual(queryRuns[0]!.documents, queryRuns[1]!.documents);
assert.notEqual(queryRuns[0]!.trace.calls[0]!.requestHash, queryRuns[1]!.trace.calls[0]!.requestHash);
assert.equal(queryRuns[0]!.trace.supportVerification!.requestHash, queryRuns[1]!.trace.supportVerification!.requestHash);
const splitService = createKnowledgeService(store, { ...options, queryMode: "separated" });
const beforeInvalidQuery = { reads, reranks, judges };
for (const retrievalQuery of [undefined, "", "  ", "x".repeat(501)]) {
  const result = await splitService.search({ query: fullQuery, retrievalQuery, scope });
  assert.equal(result.trace.status, "unavailable"); assert.equal(result.trace.reason, "invalid_input");
  assert.deepEqual(result.trace.calls, []); assert.deepEqual(result.documents, []);
}
assert.deepEqual({ reads, reranks, judges }, beforeInvalidQuery, "Missing/invalid compact queries never silently fall back or call providers");
assert.throws(() => createKnowledgeService(store, { queryMode: "separated" }));
assert.throws(() => createKnowledgeService(store, { ...options, queryMode: "typo" as "combined" }));
console.log("Knowledge service checks passed: ranking/evidence query separation, compatible lexical/model_only, declared Top5 filtering/unknown/bindings, scope/source recheck, cancellation, timeout and honest usage.");
