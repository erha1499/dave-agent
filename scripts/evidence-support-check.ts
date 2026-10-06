import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { acceptEvidence, resolveEvidenceAcceptance } from "../src/evidence-acceptance.ts";
import { applyEvidenceSupport, createEvidenceSupportClient, EvidenceSupportError, evidenceSupportInputHash, evidenceSupportRequestHash, validateEvidenceSupport,
  validateEvidenceSupportVerification, verifyEvidenceSupport, evidenceSupportPrompt, evidenceSupportTypedPrompt, evidenceSupportTypedPromptVersion,
  evidenceSupportTypedV1Prompt, evidenceSupportTypedV1PromptHash, evidenceSupportTypedV1PromptVersion,
  evidenceSupportTypedV2Prompt, evidenceSupportTypedV2PromptHash, evidenceSupportTypedV2PromptVersion,
  evidenceSupportTypedV3Prompt, evidenceSupportTypedV3PromptHash, evidenceSupportTypedV3PromptVersion,
  evidenceSupportTypedV4Prompt, evidenceSupportTypedV4PromptHash, evidenceSupportTypedV4PromptVersion,
  evidenceSupportTypedV6Prompt, evidenceSupportTypedV6PromptHash, evidenceSupportTypedV6PromptVersion,
  evidenceSupportTypedV7Prompt, evidenceSupportTypedV7PromptHash, evidenceSupportTypedV7PromptVersion, resolveEvidenceSupportModel, type EvidenceSupportDecision } from "../src/evidence-support.ts";
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
assert.equal(evidenceSupportTypedV2PromptVersion, "fact-support-typed-v2");
assert.equal(contentHash(evidenceSupportTypedV2Prompt), evidenceSupportTypedV2PromptHash);
assert.equal(evidenceSupportTypedV2PromptHash, "cd375d082eb2b5fb9b780377cad922df5d3b79dffe7568df823a06c1b3b344a3");
assert.equal(evidenceSupportTypedV3PromptVersion, "fact-support-typed-v3");
assert.equal(contentHash(evidenceSupportTypedV3Prompt), evidenceSupportTypedV3PromptHash);
assert.equal(evidenceSupportTypedV3PromptHash, "5d976a03cd880350701f65b08b7fee0397e23891807c4ccf7c5598879e8c8395");
assert.equal(evidenceSupportTypedV4PromptVersion, "fact-support-typed-v4");
assert.equal(contentHash(evidenceSupportTypedV4Prompt), evidenceSupportTypedV4PromptHash);
assert.equal(evidenceSupportTypedV4PromptHash, "2f099bedc39fcaec9b3d40e7cd3c579c3b0e2f5577d72cae45d72909bf5fe722");
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
  && error.attempts[0]!.outcome === "provider_error" && error.code === "provider_error" && error.outputHash === null && !error.message.includes("secret"));
let timeoutCalls = 0;
const timeout = await createEvidenceSupportClient({ timeoutMs: 1000, runtime: { model, complete: async (_context, options) => {
  timeoutCalls++; return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort"))));
} } });
await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: timeout }), error => error instanceof EvidenceSupportError && error.attempts[0]!.outcome === "timeout" && error.code === "timeout" && error.outputHash === null);
assert.equal(timeoutCalls, 1);
await assert.rejects(verifyEvidenceSupport({ query, scope: { shopId: "other" }, candidates, client }), /不可见/); assert.equal(calls, 1);
const empty = await verifyEvidenceSupport({ query, scope, candidates: [], client }); assert.equal(empty.attempts.length, 0); assert.equal(calls, 1);

let typedCalls = 0;
let typedRows: unknown = [
  { id: "A", category: "limitation_only", quote: "具体截止日期以本人订单 expiresAt 为准。", reason: "只有核实路径，没有具体日期" },
  { id: "B", category: "unrelated", quote: null, reason: "不是到期事实" },
];
const typed = await createEvidenceSupportClient({ profile: "typed", validationVersion: "typed-batch-v1", timeoutMs: 1000, runtime: { model, complete: async (context, options) => {
  typedCalls++; assert.equal(options.maxRetries, 0); assert.deepEqual(context.tools, []);
  assert.equal(context.systemPrompt, evidenceSupportTypedPrompt);
  assert.deepEqual(JSON.parse(String(context.messages[0]!.content)), { query, documents: candidates.map(({ id, title, tags, body }) => ({ id, title, tags, body })) });
  return message({ decisions: typedRows });
} } });
assert.equal(typed.settings.profile, "typed"); assert.equal(typed.settings.promptVersion, evidenceSupportTypedPromptVersion);
assert.equal(typed.settings.promptVersion, "fact-support-typed-v5"); assert.notEqual(typed.settings.promptHash, evidenceSupportTypedV4PromptHash);
assert.equal(typed.settings.promptHash, "6f90373dc229648806bfa93957041bc7bb8ba7f50c76e61fe316827561b2453b");
const typedChecked = await verifyEvidenceSupport({ query, scope, candidates, client: typed });
assert.equal(typedCalls, 1); assert.notEqual(typedChecked.requestHash, checked.requestHash);
// Frozen before adding v6: both v5 parser modes keep their settings/request
// bytes. These are transport/version checks, not evidence of model accuracy.
assert.equal(evidenceSupportTypedV6PromptVersion, "fact-support-typed-v6");
assert.equal(contentHash(evidenceSupportTypedV6Prompt), evidenceSupportTypedV6PromptHash);
assert.equal(evidenceSupportTypedV6PromptHash, "889596997b27deccf91339f46b7a3825aa239a50fbcde92ce5109b67a77f19fa");
assert.ok(evidenceSupportTypedV6Prompt.endsWith(`\n\n${evidenceSupportTypedPrompt}`), "v6 adds only the preceding intent contract; the complete v5 text is unchanged");
assert.equal(evidenceSupportTypedV7PromptVersion, "fact-support-typed-v7");
assert.equal(contentHash(evidenceSupportTypedV7Prompt), evidenceSupportTypedV7PromptHash);
assert.equal(evidenceSupportTypedV7PromptHash, "c2d8e1f3de93d86ef658a0d691fe753138efcab7240c9a13f20f499d41937a9c");
assert.ok(evidenceSupportTypedV7Prompt.endsWith(`\n\n${evidenceSupportTypedV6Prompt}`), "v7 adds only the preceding condition contract; the complete v6 text is unchanged");
for (const baseline of [
  { validationVersion: "typed-batch-v1" as const, settingsHash: "c6b0ce7cd17c90c0e7f8ed2c1da11612c0a4c6cd8a33a0773a34b251c770eb0f", requestHash: "feef836bbb63fe1b0507d4d19e59c5e0dd297c8e0ac9edcb618c22d8729619dd",
    v6SettingsHash: "1aa40fbf62572d84c5ca7a84c00dbdd37f3b6f7e1fd9371f23733d3a8fa9d89c", v6RequestHash: "5f3ca43d5f339edae57ba3fe31877e44498fc60ae2107db74699cf065cdcad4b" },
  { validationVersion: undefined, settingsHash: "0aab2fd06b0438d5bb793b2da8724f57bd85deb7301da0f5b33be58f162450ec", requestHash: "77b4140e5ca414f4b299b3415843bc7aead7c53871f66942762c46b9d7121a5e",
    v6SettingsHash: "3e448092f85c781a4ef2b6fc75f94a71cf00d1f66058b7d88c0d448ed6f9a4d5", v6RequestHash: "dfa0b206f56a1d21b013b1547c230cc0fc186d0f656379e33ff147c5336b2b06" },
]) {
  let candidateCalls = 0;
  const defaultV5 = await createEvidenceSupportClient({ profile: "typed", validationVersion: baseline.validationVersion, timeoutMs: 1000,
    runtime: { model, complete: async () => { throw Error("default settings only"); } } });
  assert.equal(defaultV5.settings.promptVersion, "fact-support-typed-v5");
  assert.equal(contentHash(defaultV5.settings), baseline.settingsHash);
  assert.equal(evidenceSupportRequestHash({ query, candidates, settings: defaultV5.settings }), baseline.requestHash);
  const candidate = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV6PromptVersion,
    validationVersion: baseline.validationVersion, timeoutMs: 1000, runtime: { model, complete: async (context, options) => {
      candidateCalls++; assert.equal(context.systemPrompt, evidenceSupportTypedV6Prompt);
      assert.deepEqual(context.tools, []); assert.equal(options.maxRetries, 0);
      assert.deepEqual(JSON.parse(String(context.messages[0]!.content)), { query, documents: candidates.map(({ id, title, tags, body }) => ({ id, title, tags, body })) });
      return message({ decisions: typedRows });
    } } });
  assert.equal(candidate.settings.promptVersion, evidenceSupportTypedV6PromptVersion);
  assert.equal(candidate.settings.promptHash, evidenceSupportTypedV6PromptHash);
  assert.equal(contentHash(candidate.settings), baseline.v6SettingsHash);
  assert.deepEqual({ ...candidate.settings, promptVersion: defaultV5.settings.promptVersion, promptHash: defaultV5.settings.promptHash }, defaultV5.settings,
    "v6 changes only prompt identity/content, never parser, serialization, model or retry settings");
  const verification = await verifyEvidenceSupport({ query, scope, candidates, client: candidate });
  assert.equal(candidateCalls, 1); assert.notEqual(verification.requestHash, baseline.requestHash);
  assert.equal(verification.requestHash, baseline.v6RequestHash);
  assert.equal(validateEvidenceSupportVerification(verification, { ...bound, settings: candidate.settings }), true);
  assert.equal(validateEvidenceSupportVerification(verification, { ...bound, settings: defaultV5.settings }), false);
  assert.equal(validateEvidenceSupportVerification(typedChecked, { ...bound, settings: candidate.settings }), false);
  assert.equal(applyEvidenceSupport({ prepared, verification, query, scope, documents, settings: defaultV5.settings }).status, "unavailable");
  let v7Calls = 0;
  const v7 = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV7PromptVersion,
    validationVersion: baseline.validationVersion, timeoutMs: 1000, runtime: { model, complete: async (context, options) => {
      v7Calls++; assert.equal(context.systemPrompt, evidenceSupportTypedV7Prompt);
      assert.deepEqual(context.tools, []); assert.equal(options.maxRetries, 0);
      assert.deepEqual(JSON.parse(String(context.messages[0]!.content)), { query, documents: candidates.map(({ id, title, tags, body }) => ({ id, title, tags, body })) });
      return message({ decisions: typedRows });
    } } });
  assert.equal(v7.settings.promptVersion, evidenceSupportTypedV7PromptVersion);
  assert.equal(v7.settings.promptHash, evidenceSupportTypedV7PromptHash);
  assert.deepEqual({ ...v7.settings, promptVersion: candidate.settings.promptVersion, promptHash: candidate.settings.promptHash }, candidate.settings,
    "v7 changes only prompt identity/content, never parser, serialization, model or retry settings");
  const verifiedV7 = await verifyEvidenceSupport({ query, scope, candidates, client: v7 });
  assert.equal(v7Calls, 1); assert.notEqual(verifiedV7.requestHash, baseline.requestHash); assert.notEqual(verifiedV7.requestHash, verification.requestHash);
  assert.equal(validateEvidenceSupportVerification(verifiedV7, { ...bound, settings: v7.settings }), true);
  for (const old of [{ settings: candidate.settings, verified: verification }, { settings: defaultV5.settings, verified: typedChecked }]) {
    assert.equal(validateEvidenceSupportVerification(verifiedV7, { ...bound, settings: old.settings }), false);
    assert.equal(validateEvidenceSupportVerification(old.verified, { ...bound, settings: v7.settings }), false);
    assert.equal(applyEvidenceSupport({ prepared, verification: verifiedV7, query, scope, documents, settings: old.settings }).status, "unavailable");
  }
}
// Historical prompt and parser selections are independent; neither may silently reuse a new prompt with old hashes.
let replayCalls = 0;
const typedV3 = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV3PromptVersion,
  validationVersion: "typed-batch-v1", timeoutMs: 1000, runtime: { model, complete: async context => {
    replayCalls++; assert.equal(context.systemPrompt, evidenceSupportTypedV3Prompt);
    assert.deepEqual(JSON.parse(String(context.messages[0]!.content)), { query, documents: candidates.map(({ id, title, tags, body }) => ({ id, title, tags, body })) });
    return message({ decisions: typedRows });
  } } });
const typedV3Isolated = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV3PromptVersion,
  timeoutMs: 1000, runtime: { model, complete: async () => { throw Error("settings check only"); } } });
assert.equal(contentHash(typedV3.settings), "a5ea9bbb677a856af836efa84c70318139f357ae29267af873aa47b319145728");
assert.equal(contentHash(typedV3Isolated.settings), "289694dfff885e6b3569e2bea599af80911f6f986f6b7a40e1a430b95f16e26b");
const replayedV3 = await verifyEvidenceSupport({ query, scope, candidates, client: typedV3 });
assert.equal(replayCalls, 1); assert.notEqual(replayedV3.requestHash, typedChecked.requestHash);
assert.equal(validateEvidenceSupportVerification(replayedV3, { ...bound, settings: typed.settings }), false, "v3 result cannot satisfy a current request");
assert.equal(validateEvidenceSupportVerification(typedChecked, { ...bound, settings: typedV3.settings }), false, "current result cannot be attributed to v3");
assert.equal(applyEvidenceSupport({ prepared, verification: replayedV3, query, scope, documents, settings: typed.settings }).status, "unavailable");
// Captured before the v5 edit: both old parser branches retain their exact v4 settings and request bytes.
for (const legacy of [
  { validationVersion: "typed-batch-v1" as const, settingsHash: "ea035edf059e1b53d5a09f32c4861c750bcdf59d10f9359b8f196bfe350eecf9", requestHash: "6505edb748407246502bf251d27cfb4b12c452171e67c6a23c1e41c0c261513c" },
  { validationVersion: undefined, settingsHash: "9307a1df38a4f9d0721db8f0c52dc48df405162975a71a003111fb9979842a83", requestHash: "78a88d68d6d409fada8605a17910b904160a4c2d42ec504a7f6994eb8ac54fe8" },
]) {
  let v4Calls = 0;
  const v4 = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV4PromptVersion,
    validationVersion: legacy.validationVersion, timeoutMs: 1000, runtime: { model, complete: async (context, options) => {
      v4Calls++; assert.equal(context.systemPrompt, evidenceSupportTypedV4Prompt); assert.equal(options.maxRetries, 0);
      assert.deepEqual(JSON.parse(String(context.messages[0]!.content)), { query, documents: candidates.map(({ id, title, tags, body }) => ({ id, title, tags, body })) });
      return message({ decisions: typedRows });
    } } });
  assert.equal(contentHash(v4.settings), legacy.settingsHash);
  const replayed = await verifyEvidenceSupport({ query, scope, candidates, client: v4 });
  assert.equal(v4Calls, 1); assert.equal(replayed.requestHash, legacy.requestHash); assert.equal(replayed.attempts[0]!.totalTokens, 90);
  assert.equal(validateEvidenceSupportVerification(replayed, { ...bound, settings: typed.settings }), false);
  assert.equal(validateEvidenceSupportVerification(typedChecked, { ...bound, settings: v4.settings }), false);
  assert.equal(applyEvidenceSupport({ prepared, verification: replayed, query, scope, documents, settings: typed.settings }).status, "unavailable");
}
for (const options of [{ profile: "binary", typedPromptVersion: evidenceSupportTypedV3PromptVersion },
  { profile: "binary", typedPromptVersion: evidenceSupportTypedV6PromptVersion },
  { profile: "binary", typedPromptVersion: evidenceSupportTypedV7PromptVersion },
  { typedPromptVersion: evidenceSupportTypedV7PromptVersion },
  { profile: "typed", typedPromptVersion: "fact-support-typed-invalid" },
  { profile: "typed", typedPromptVersion: "fact-support-typed-v8" },
  { profile: "typed", typedPromptVersion: null }] as const) {
  await assert.rejects(createEvidenceSupportClient({ ...options, typedPromptVersion: options.typedPromptVersion as typeof evidenceSupportTypedV3PromptVersion,
    runtime: { model, complete: async () => { throw Error("must not run"); } } }), /提示词版本无效/);
}
assert.deepEqual(typedChecked.value.map(row => [row.category, row.supported]), [["limitation_only", false], ["unrelated", false]]);
assert.equal(applyEvidenceSupport({ prepared, verification: typedChecked, query, scope, documents, settings: typed.settings }).status, "rejected");
assert.equal(validateEvidenceSupportVerification(typedChecked, bound), false, "typed cannot be replayed as binary");
assert.equal(validateEvidenceSupportVerification(checked, { ...bound, settings: typed.settings }), false, "binary cannot be replayed as typed");
assert.equal(validateEvidenceSupport(typedChecked.value, candidates), false);
assert.equal(validateEvidenceSupport(decisions, candidates, "typed"), false);
assert.equal(validateEvidenceSupport([{ ...typedChecked.value[0], supported: true }, typedChecked.value[1]], candidates, "typed"), false, "limitation_only can never self-authorize acceptance");
const typedPositive = await createEvidenceSupportClient({ profile: "typed", validationVersion: "typed-batch-v1", runtime: { model, complete: async () => message({ decisions: [
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

// Model selection changes only support; foreign-provider credentials are rejected before runtime creation.
assert.deepEqual(resolveEvidenceSupportModel("configured", {}), { provider: "deepseek", model: "deepseek-flash" });
const configuredEnv = { MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash", MODEL_API_KEY: "fake-never-sent" };
assert.deepEqual(resolveEvidenceSupportModel("deepseek-v4-pro", configuredEnv), { provider: "deepseek", model: "deepseek-v4-pro" });
assert.equal(configuredEnv.MODEL_ID, "deepseek-flash");
assert.deepEqual(resolveEvidenceSupportModel("deepseek-v4-pro", { MODEL_PROVIDER: "openai" }), { provider: "deepseek", model: "deepseek-v4-pro" });
await assert.rejects(createEvidenceSupportClient({ modelSelection: "deepseek-v4-pro", env: { MODEL_PROVIDER: "openai", MODEL_API_KEY: "fake-wrong-provider" } }), /DEEPSEEK_API_KEY/);
await assert.rejects(createEvidenceSupportClient({ modelSelection: "deepseek-v4-pro", env: {}, runtime: { model, complete: async () => { throw Error("must not run"); } } }), /模型不一致/);
const selectedDefault = await createEvidenceSupportClient({ modelSelection: "configured", timeoutMs: 1000, env: { MODEL_PROVIDER: "deepseek", MODEL_ID: model.id }, runtime: { model, complete: async () => message({ decisions }) } });
assert.deepEqual(selectedDefault.settings, client.settings, "configured selection preserves the A1 settings and prompt bytes");

// Failure diagnostics are bounded and do not relax any existing acceptance rule.
const validTyped = [{ id: "A", category: "direct_fact", quote: documents[0]!.body, reason: "已有事实" },
  { id: "B", category: "unrelated", quote: null, reason: "无关" }];
const diagnosticCases: Array<{ code: string; profile?: "binary" | "typed"; raw?: string; value?: unknown; stopReason?: AssistantMessage["stopReason"]; nonText?: boolean }> = [
  { code: "invalid_json", raw: "{broken-json" },
  { code: "invalid_shape", value: { decisions, extra: "must-not-leak" } },
  { code: "invalid_id", value: { decisions: [decisions[0]] } },
  { code: "invalid_id", value: { decisions: [decisions[0], decisions[0]] } },
  { code: "invalid_id", value: { decisions: [{ ...decisions[0], id: "foreign" }, decisions[1]] } },
  { code: "invalid_quote", value: { decisions: [{ ...decisions[0], supported: true, quote: "made-up-text" }, decisions[1]] } },
  { code: "invalid_reason", value: { decisions: [{ ...decisions[0], reason: "x".repeat(121) }, decisions[1]] } },
  { code: "invalid_reason", value: { decisions: [{ ...decisions[0], reason: " " }, decisions[1]] } },
  { code: "invalid_supported", value: { decisions: [{ ...decisions[0], supported: "yes" }, decisions[1]] } },
  { code: "invalid_category", profile: "typed", value: { decisions: [{ ...validTyped[0], category: "unknown" }, validTyped[1]] } },
  { code: "invalid_shape", profile: "typed", value: { decisions: [{ ...validTyped[0], supported: true }, validTyped[1]] } },
  { code: "invalid_quote", profile: "typed", value: { decisions: [{ ...validTyped[0], quote: "not-in-source" }, validTyped[1]] } },
  { code: "response_limit", raw: "x".repeat(20_001) },
  { code: "unfinished_response", value: { decisions }, stopReason: "length" },
  { code: "unexpected_content", value: { decisions }, nonText: true },
];
for (const test of diagnosticCases) {
  let requests = 0, observed = 0;
  const raw = test.raw ?? JSON.stringify(test.value);
  const diagnostic = await createEvidenceSupportClient({ profile: test.profile, validationVersion: test.profile === "typed" ? "typed-batch-v1" : undefined, observeResponseForTest: response => {
    observed++; assert.equal(response.text, raw.slice(0, 20_000)); assert.equal(response.outputHash, contentHash(raw));
    assert.equal(response.truncated, raw.length > 20_000);
    assert.deepEqual(Object.keys(response).sort(), ["outputHash", "stopReason", "text", "truncated"]);
  }, runtime: { model, complete: async () => {
    requests++; const response = message(test.value); response.content = [{ type: "text", text: raw }];
    if (test.nonText) response.content.push({ type: "thinking", thinking: "hidden-test-reasoning" });
    response.stopReason = test.stopReason ?? "stop"; return response;
  } } });
  await assert.rejects(diagnostic.verify(query, candidates), error => {
    assert.ok(error instanceof EvidenceSupportError); assert.equal(error.code, test.code); assert.equal(error.outputHash, contentHash(raw));
    assert.equal(error.attempts.length, 1); assert.ok(!JSON.stringify(error).includes(raw), "failure has no raw response"); return true;
  });
  assert.equal(requests, 1); assert.equal(observed, 1);
}
let observerRequests = 0;
const throwingObserver = await createEvidenceSupportClient({ observeResponseForTest: () => { throw Error("observer-only-failure"); },
  runtime: { model, complete: async () => { observerRequests++; return message({ decisions }); } } });
assert.deepEqual((await throwingObserver.verify(query, candidates)).value, decisions); assert.equal(observerRequests, 1);

await import("./evidence-support-isolation-check.ts");
