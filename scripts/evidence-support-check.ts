import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { acceptEvidence, resolveEvidenceAcceptance } from "../src/evidence-acceptance.ts";
import { applyEvidenceSupport, createEvidenceSupportClient, EvidenceSupportError, evidenceSupportInputHash, validateEvidenceSupport,
  validateEvidenceSupportVerification, verifyEvidenceSupport, evidenceSupportPrompt, evidenceSupportTypedPromptVersion,
  evidenceSupportTypedV1Prompt, evidenceSupportTypedV1PromptHash, evidenceSupportTypedV1PromptVersion, type EvidenceSupportDecision } from "../src/evidence-support.ts";
import { contentHash } from "../src/bailian.ts";

const documents = [
  { id: "A", title: "有效期", body: "具体截止日期以本人订单 expiresAt 为准。不得从套餐名称估算日期。", tags: ["到期"], shopId: "shop-a", productId: null },
  { id: "B", title: "午市", body: "午市券仅限11:00-14:00使用。", tags: ["午市"], shopId: null, productId: null },
  { id: "C", title: "停车", body: "消费满100元停车两小时。", tags: ["停车"], shopId: "shop-other", productId: null },
];
const scope = { shopId: "shop-a", productId: null }, ranking = [{ id: "A", score: .9 }, { id: "B", score: .8 }, { id: "C", score: 1 }];
const query = "券具体哪天到期？";
const prepared = acceptEvidence({ documents, scope, ranking, query, config: { mode: "support", threshold: .2 } });
assert.equal(prepared.version, "score-support-v1"); assert.equal(prepared.status, "unavailable"); assert.deepEqual(prepared.accepted, []);
assert.deepEqual(prepared.pendingSupport!.map(doc => doc.id), ["A", "B"]);
assert.ok(prepared.rejected.some(row => row.id === "C" && row.reason === "out_of_scope"));
assert.equal(acceptEvidence({ documents, scope, ranking, config: { mode: "score", threshold: .2 } }).version, "score-gate-v1");
assert.deepEqual(resolveEvidenceAcceptance({ mode: "support", threshold: 0 }, ["M4"]), { mode: "support", threshold: 0 });
assert.throws(() => resolveEvidenceAcceptance({ mode: "support", threshold: .2 }, ["M1"]));
assert.throws(() => resolveEvidenceAcceptance({ mode: "support" }));
const candidates = prepared.pendingSupport!;
const decisions: EvidenceSupportDecision[] = [
  { id: "A", supported: false, quote: null, reason: "原文只给查订单的方法，没有具体截止日期" },
  { id: "B", supported: false, quote: null, reason: "原文是午市可用时段，没有券到期日期" },
];
const model = { provider: "deepseek", id: "mock-support", api: "openai-completions", baseUrl: "https://api.deepseek.com", maxTokens: 4096,
  cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } };
const message = (value: unknown): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: JSON.stringify(value) }],
  api: "openai-completions", provider: "deepseek", model: model.id, stopReason: "stop", timestamp: 0,
  usage: { input: 50, output: 30, cacheRead: 10, cacheWrite: 0, totalTokens: 90,
    cost: { input: .000005, output: .000006, cacheRead: .0000001, cacheWrite: 0, total: .0000111 } } });
let calls = 0;
const client = await createEvidenceSupportClient({ timeoutMs: 1000, runtime: { model, complete: async (context, options) => {
  calls++; assert.deepEqual(context.tools, []); assert.equal(context.messages.length, 1);
  assert.equal(options.temperature, 0); assert.equal(options.maxRetries, 0); assert.equal(options.maxTokens, 2048);
  assert.deepEqual(options.samplingParams, { response_format: { type: "json_object" } });
  assert.deepEqual(options.onPayload({ temperature: 1, tools: [{ name: "injected" }], tool_choice: "auto" }), {
    temperature: 0, thinking: { type: "disabled" }, response_format: { type: "json_object" },
  });
  const input = JSON.parse(String(context.messages[0]!.content));
  assert.deepEqual(Object.keys(input).sort(), ["documents", "query"]);
  assert.deepEqual(Object.keys(input.documents[0]).sort(), ["body", "id", "tags", "title"]);
  assert.equal(JSON.stringify(input).includes("gold"), false);
  return message({ decisions });
} } });
const checked = await verifyEvidenceSupport({ query, scope, candidates, client });
// Frozen before typed was added: A1 default settings, prompt and serialized request remain byte-compatible.
assert.equal(contentHash(evidenceSupportPrompt), "3d254e0bca8e14fae05804a0f027c653f5f099e1b91e5fb519088b5aaa04f15a");
assert.equal(contentHash(client.settings), "265a727c8253fd59ea22a7fc9c47fe6efce5e0430b92740b364ad92aebd95e77");
assert.equal(checked.requestHash, "952b7c517f07d0ca4e729789a210db9df83e67884289b9aa581163a33231d6af");
assert.equal(client.settings.profile, undefined);
assert.equal(evidenceSupportTypedV1PromptVersion, "fact-support-v2-typed");
assert.equal(contentHash(evidenceSupportTypedV1Prompt), evidenceSupportTypedV1PromptHash);
assert.equal(evidenceSupportTypedV1PromptHash, "4223604540af3298649bb546fb14354e1bb779cf2d23626bd368448f6fd9c9dd");
const explicitBinary = await createEvidenceSupportClient({ profile: "binary", timeoutMs: 1000, runtime: { model, complete: async () => message({ decisions }) } });
assert.deepEqual(explicitBinary.settings, client.settings, "explicit binary retains the default v1 settings shape");
assert.equal(calls, 1); assert.equal(checked.attempts.length, 1); assert.equal(checked.attempts[0]!.outcome, "ok");
assert.equal(checked.attempts[0]!.totalTokens, 90); assert.equal(checked.attempts[0]!.costUsd, .0000111);
assert.match(client.settings.promptHash, /^[a-f0-9]{64}$/); assert.equal(client.settings.maxRetries, 0);
const bound = { query, scope, candidates, settings: client.settings };
assert.equal(validateEvidenceSupportVerification(checked, bound), true);
assert.equal(checked.inputHash, evidenceSupportInputHash(bound));
const declined = applyEvidenceSupport({ prepared, verification: checked, query, scope, documents, settings: client.settings });
assert.equal(declined.status, "rejected"); assert.deepEqual(declined.accepted, []); assert.equal(declined.pendingSupport, undefined);
assert.equal(declined.rejected.filter(row => row.reason === "unsupported").length, 2);

const positiveQuery = "能否从套餐名称估算截止日期？";
const positiveClient = await createEvidenceSupportClient({ runtime: { model, complete: async () => message({ decisions: [
  { id: "A", supported: true, quote: "不得从套餐名称估算日期。", reason: "原文直接禁止推断" }, decisions[1],
] }) } });
const positive = await verifyEvidenceSupport({ query: positiveQuery, scope, candidates, client: positiveClient });
const allowed = applyEvidenceSupport({ prepared, verification: positive, query: positiveQuery, scope, documents, settings: positiveClient.settings });
assert.deepEqual(allowed.accepted.map(doc => doc.id), ["A"]); assert.equal(allowed.accepted[0]!.body, documents[0]!.body);
assert.equal(applyEvidenceSupport({ prepared, verification: positive, query, scope, documents, settings: positiveClient.settings }).status, "unavailable", "cannot replay safety-boundary answer against a concrete-date question");
assert.equal(applyEvidenceSupport({ prepared, verification: null, query, scope, documents, settings: client.settings }).status, "unavailable");
const inactive = documents.map(doc => doc.id === "A" ? { ...doc, status: "inactive" as const } : doc);
assert.equal(applyEvidenceSupport({ prepared, verification: positive, query: positiveQuery, scope, documents: inactive, settings: positiveClient.settings }).accepted.length, 0);
assert.equal(applyEvidenceSupport({ prepared, verification: positive, query: positiveQuery, scope, documents: inactive, settings: positiveClient.settings }).status, "unavailable");
const edited = documents.map(doc => doc.id === "A" ? { ...doc, body: "政策已变更。" } : doc);
assert.equal(applyEvidenceSupport({ prepared, verification: positive, query: positiveQuery, scope, documents: edited, settings: positiveClient.settings }).accepted.length, 0);
assert.equal(applyEvidenceSupport({ prepared, verification: positive, query: positiveQuery, scope, documents: edited, settings: positiveClient.settings }).status, "unavailable", "stale source is not counted as a successful model rejection");
assert.equal(validateEvidenceSupportVerification(positive, { ...bound, query: positiveQuery, scope: { shopId: "other" }, settings: positiveClient.settings }), false);
assert.equal(validateEvidenceSupportVerification({ ...positive, value: [positive.value[0]] }, { ...bound, query: positiveQuery, settings: positiveClient.settings }), false);
assert.equal(validateEvidenceSupport([{ ...decisions[0], supported: true, quote: "已过期" }, decisions[1]], candidates), false);
assert.equal(validateEvidenceSupport([decisions[0], decisions[0]], candidates), false);
assert.equal(validateEvidenceSupport([{ ...decisions[0], id: "C" }, decisions[1]], candidates), false);
assert.equal(validateEvidenceSupport([{ ...decisions[0], quote: "非空拒绝引用" }, decisions[1]], candidates), false);
assert.equal(validateEvidenceSupport([{ ...decisions[0], explanation: "extra" }, decisions[1]], candidates), false);

for (const malformed of ["```json\n{}\n```", { decisions: [] }, { decisions: [{ ...decisions[0], supported: "false" }, decisions[1]] },
  { decisions: [{ ...decisions[0], supported: true, quote: "凭空引文" }, decisions[1]] }, { decisions, extra: true }]) {
  let requests = 0;
  const invalid = await createEvidenceSupportClient({ runtime: { model, complete: async () => { requests++; return message(malformed); } } });
  await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: invalid }), error => error instanceof EvidenceSupportError
    && error.attempts.length === 1 && error.attempts[0]!.outcome === "invalid_response" && error.attempts[0]!.totalTokens === 90);
  assert.equal(requests, 1, "invalid output does not trigger a hidden repair request");
}
const unreported = await createEvidenceSupportClient({ runtime: { model, complete: async () => {
  const result = message({ decisions }); result.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; return result;
} } });
assert.equal((await verifyEvidenceSupport({ query, scope, candidates, client: unreported })).attempts[0]!.costUsd, null);
const failed = await createEvidenceSupportClient({ runtime: { model, complete: async () => { throw new Error("secret-key-should-not-escape"); } } });
await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: failed }), error => error instanceof EvidenceSupportError
  && error.attempts[0]!.outcome === "provider_error" && !error.message.includes("secret"));
let timeoutCalls = 0;
const timeout = await createEvidenceSupportClient({ timeoutMs: 1000, runtime: { model, complete: async (_context, options) => {
  timeoutCalls++; return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort"))));
} } });
await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: timeout }), error => error instanceof EvidenceSupportError && error.attempts[0]!.outcome === "timeout");
assert.equal(timeoutCalls, 1);
await assert.rejects(verifyEvidenceSupport({ query, scope: { shopId: "other" }, candidates, client }), /不可见/); assert.equal(calls, 1);
const empty = await verifyEvidenceSupport({ query, scope, candidates: [], client }); assert.equal(empty.attempts.length, 0); assert.equal(calls, 1);

let typedCalls = 0;
let typedRows: unknown = [
  { id: "A", category: "limitation_only", quote: "具体截止日期以本人订单 expiresAt 为准。", reason: "只有核实路径，没有具体日期" },
  { id: "B", category: "unrelated", quote: null, reason: "不是到期事实" },
];
const typed = await createEvidenceSupportClient({ profile: "typed", timeoutMs: 1000, runtime: { model, complete: async (context, options) => {
  typedCalls++; assert.equal(options.maxRetries, 0); assert.deepEqual(context.tools, []);
  assert.notEqual(contentHash(context.systemPrompt), contentHash(evidenceSupportPrompt));
  assert.deepEqual(JSON.parse(String(context.messages[0]!.content)), { query, documents: candidates.map(({ id, title, tags, body }) => ({ id, title, tags, body })) });
  return message({ decisions: typedRows });
} } });
assert.equal(typed.settings.profile, "typed"); assert.equal(typed.settings.promptVersion, evidenceSupportTypedPromptVersion);
assert.equal(typed.settings.promptVersion, "fact-support-typed-v2"); assert.notEqual(typed.settings.promptHash, evidenceSupportTypedV1PromptHash);
const typedChecked = await verifyEvidenceSupport({ query, scope, candidates, client: typed });
assert.equal(typedCalls, 1); assert.notEqual(typedChecked.requestHash, checked.requestHash);
assert.deepEqual(typedChecked.value.map(row => [row.category, row.supported]), [["limitation_only", false], ["unrelated", false]]);
assert.equal(applyEvidenceSupport({ prepared, verification: typedChecked, query, scope, documents, settings: typed.settings }).status, "rejected");
assert.equal(validateEvidenceSupportVerification(typedChecked, bound), false, "typed cannot be replayed as binary");
assert.equal(validateEvidenceSupportVerification(checked, { ...bound, settings: typed.settings }), false, "binary cannot be replayed as typed");
assert.equal(validateEvidenceSupport(typedChecked.value, candidates), false);
assert.equal(validateEvidenceSupport(decisions, candidates, "typed"), false);
assert.equal(validateEvidenceSupport([{ ...typedChecked.value[0], supported: true }, typedChecked.value[1]], candidates, "typed"), false, "limitation_only can never self-authorize acceptance");
const typedPositive = await createEvidenceSupportClient({ profile: "typed", runtime: { model, complete: async () => message({ decisions: [
  { id: "A", category: "boundary_answer", quote: "不得从套餐名称估算日期。", reason: "明确回答是否允许该推断" },
  { id: "B", category: "unrelated", quote: null, reason: "无关" },
] }) } });
const typedBoundary = await verifyEvidenceSupport({ query: positiveQuery, scope, candidates, client: typedPositive });
assert.deepEqual(applyEvidenceSupport({ prepared, verification: typedBoundary, query: positiveQuery, scope, documents, settings: typedPositive.settings }).accepted.map(row => row.id), ["A"]);
assert.equal(applyEvidenceSupport({ prepared, verification: typedBoundary, query, scope, documents, settings: typedPositive.settings }).status, "unavailable");
assert.equal(applyEvidenceSupport({ prepared, verification: typedBoundary, query: positiveQuery, scope, documents: edited, settings: typedPositive.settings }).status, "unavailable");
for (const invalidRows of [[], [
  { id: "A", category: "limitation_only", supported: true, quote: documents[0]!.body, reason: "试图绕过宿主" },
  { id: "B", category: "unrelated", quote: null, reason: "无关" },
], [{ ...typedChecked.value[0], category: "direct_fact" }, typedChecked.value[1]], [
  { id: "A", category: "limitation_only", quote: "伪造引文", reason: "无依据" },
  { id: "B", category: "unrelated", quote: null, reason: "无关" },
], [
  { id: "A", category: ["limitation_only"], quote: documents[0]!.body, reason: "类别必须为字符串" },
  { id: "B", category: "unrelated", quote: null, reason: "无关" },
]]) {
  typedRows = invalidRows; const before: number = typedCalls;
  await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: typed }), error => error instanceof EvidenceSupportError && error.attempts[0]!.outcome === "invalid_response");
  assert.equal(typedCalls, before + 1, "invalid typed schema does not retry");
}
await assert.rejects(createEvidenceSupportClient({ profile: "unknown" as "typed", runtime: { model, complete: async () => message({ decisions }) } }));
console.log("Evidence support checks passed: pending is not accepted, one tool-free JSON request, exact complete decisions, input-bound cache, safe failure/timeout, usage, and post-call source scope recheck; no external calls.");
