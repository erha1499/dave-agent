import assert from "node:assert/strict";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { acceptEvidence } from "../src/evidence-acceptance.ts";
import { applyEvidenceSupport, createEvidenceSupportClient, EvidenceSupportError, evidenceSupportInputHash, evidenceSupportRequestHash,
  evidenceSupportTypedV3PromptVersion, evidenceSupportValidationVersion, validateEvidenceSupportVerification, verifyEvidenceSupport, type EvidenceSupportVerification } from "../src/evidence-support.ts";
import { contentHash } from "../src/bailian.ts";

const documents = [
  { id: "good", title: "Rule", body: "Changes require merchant approval, not automatic approval.", tags: [], shopId: null, productId: null },
  { id: "other", title: "Related", body: "Ask the merchant, then wait for a result.", tags: [], shopId: null, productId: null },
];
const scope = { shopId: null, productId: null }, query = "Who must approve a change?";
const prepared = acceptEvidence({ documents, scope, query, config: { mode: "support", threshold: .5 },
  ranking: documents.map((doc, i) => ({ id: doc.id, score: .9 - i * .1 })) });
const candidates = prepared.pendingSupport!;
const model = { provider: "deepseek", id: "mock-isolation", api: "openai-completions", baseUrl: "https://api.deepseek.com", maxTokens: 4096,
  cost: { input: .3, output: 1.2, cacheRead: .006, cacheWrite: 0 } };
const good = { id: "good", category: "direct_fact", quote: documents[0]!.body, reason: "The explicit approval requirement answers the rule question." };
const other = { id: "other", category: "limitation_only", quote: "Ask the merchant， then wait for a result.", reason: "Only a related process." };
let rows: unknown = [good, other], calls = 0;
const payloads: Context[] = [];
const runtime = { model, complete: async (context: Context, parameters: { maxRetries: 0 }): Promise<AssistantMessage> => {
  calls++; payloads.push(structuredClone(context)); assert.equal(parameters.maxRetries, 0);
  return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
    content: [{ type: "text", text: JSON.stringify({ decisions: rows }) }],
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: .00003, output: .00006, cacheRead: 0, cacheWrite: 0, total: .00009 } } };
} };
const legacy = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV3PromptVersion, validationVersion: "typed-batch-v1", runtime });
const client = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: evidenceSupportTypedV3PromptVersion, runtime });
assert.equal(legacy.settings.validationVersion, undefined); assert.equal(client.settings.validationVersion, evidenceSupportValidationVersion);
const { validationVersion: _version, ...sameSettings } = client.settings;
assert.deepEqual(sameSettings, legacy.settings, "only the local validation version changes settings");
await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: legacy }), error => error instanceof EvidenceSupportError && error.code === "invalid_quote");
const partial = await verifyEvidenceSupport({ query, scope, candidates, client });
assert.deepEqual(payloads[0], payloads[1], "Prompt and serialized model input are unchanged");
assert.notEqual(partial.requestHash, evidenceSupportRequestHash({ query, candidates, settings: legacy.settings }));
assert.notEqual(partial.inputHash, evidenceSupportInputHash({ query, scope, candidates, settings: legacy.settings }));
assert.equal(calls, 2); assert.equal(partial.validation!.status, "partial");
assert.deepEqual(partial.validation!.invalidDecisions, [{ id: "other", code: "invalid_quote" }]);
assert.deepEqual(partial.value.map(row => row.id), ["good"]); assert.equal(partial.attempts[0]!.totalTokens, 150);
const apply = (verification: EvidenceSupportVerification, current = documents) => applyEvidenceSupport({ prepared, verification, query, scope, documents: current, settings: client.settings });
assert.deepEqual(apply(partial).accepted.map(doc => doc.id), ["good"]);
assert.deepEqual(apply(partial).rejected, [{ id: "other", rank: 2, reason: "invalid_support_decision" }]);

// A broken positive is not an unsupported judgment; a valid unrelated decision cannot make it a correct rejection.
rows = [{ ...good, quote: "not a verbatim quote" }, { ...other, category: "unrelated", quote: null }];
const badPositive = await verifyEvidenceSupport({ query, scope, candidates, client });
assert.equal(badPositive.validation!.status, "partial"); assert.equal(apply(badPositive).status, "unavailable");
assert.deepEqual(apply(badPositive).accepted, []);
assert.equal(apply(badPositive).rejected.find(row => row.id === "good")!.reason, "invalid_support_decision");

for (const [change, code] of [[{ quote: "bad" }, "invalid_quote"], [{ reason: "x".repeat(121) }, "invalid_reason"],
  [{ category: "maybe" }, "invalid_category"]] as const) {
  rows = [{ ...good, ...change }, { ...other, category: "unrelated", quote: null }];
  const result = await verifyEvidenceSupport({ query, scope, candidates, client });
  assert.deepEqual(result.validation!.invalidDecisions, [{ id: "good", code }]); assert.equal(result.value.length, 1);
}
rows = [{ ...good, reason: "" }, { ...other, category: "invalid" }];
const allInvalid = await verifyEvidenceSupport({ query, scope, candidates, client });
assert.equal(allInvalid.validation!.status, "unavailable"); assert.equal(allInvalid.value.length, 0);
assert.equal(allInvalid.attempts[0]!.outcome, "invalid_response"); assert.equal(allInvalid.attempts[0]!.costUsd, .00009);
assert.equal(apply(allInvalid).status, "unavailable"); assert.ok(apply(allInvalid).rejected.every(row => row.reason === "invalid_support_decision"));

// Unknown, duplicated, missing IDs and extra/missing row fields remain whole-batch failures.
for (const [value, code] of [
  [[good], "invalid_id"], [[good, good], "invalid_id"], [[good, { ...other, id: "unknown" }], "invalid_id"],
  [[good, { ...other, extra: true }], "invalid_shape"], [[good, { id: "other", quote: null, reason: "no category" }], "invalid_shape"],
] as const) {
  rows = value; const before: number = calls;
  await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client }), error => error instanceof EvidenceSupportError && error.code === code && error.attempts.length === 1);
  assert.equal(calls, before + 1);
}

const bound = { query, scope, candidates, settings: client.settings };
assert.equal(validateEvidenceSupportVerification(partial, bound), true);
for (const tamper of [
  (v: EvidenceSupportVerification) => { v.validation!.invalidDecisions = []; },
  (v: EvidenceSupportVerification) => { v.validation!.status = "complete"; },
  (v: EvidenceSupportVerification) => { v.validation!.invalidDecisions[0]!.id = "good"; },
  (v: EvidenceSupportVerification) => { v.validation!.invalidDecisions.push({ id: "unknown", code: "invalid_quote" }); },
  (v: EvidenceSupportVerification) => { v.value.push({ ...v.value[0]!, id: "other", quote: documents[1]!.body }); },
  (v: EvidenceSupportVerification) => { v.inputHash = contentHash("other query"); },
  (v: EvidenceSupportVerification) => { delete v.validation; },
  (v: EvidenceSupportVerification) => { v.attempts = []; },
]) {
  const forged = structuredClone(partial); tamper(forged);
  assert.equal(validateEvidenceSupportVerification(forged, bound), false);
  assert.equal(apply(forged).status, "unavailable"); assert.deepEqual(apply(forged).accepted, []);
}
const { inputHash: _hash, ...injected } = partial;
await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: { settings: client.settings, verify: async () => ({ ...injected,
  validation: { ...injected.validation!, invalidDecisions: [] } }) } }), error => error instanceof EvidenceSupportError && error.code === "invalid_binding");
assert.equal(validateEvidenceSupportVerification(partial, { ...bound, settings: legacy.settings }), false, "new partial records cannot be accepted by the legacy contract");
assert.equal(apply(partial, documents.map(doc => doc.id === "other" ? { ...doc, body: "changed source" } : doc)).status, "unavailable",
  "even an invalid candidate must still pass the final source recheck");
const revoked = documents.map(doc => doc.id === "good" ? { ...doc, shopId: "other-shop" } : doc);
assert.equal(applyEvidenceSupport({ prepared, verification: partial, query, scope, documents: revoked, settings: client.settings }).status, "unavailable");
const { inputHash: _boundHash, ...zeroAttemptResult } = partial;
await assert.rejects(verifyEvidenceSupport({ query, scope, candidates, client: { settings: client.settings,
  verify: async () => ({ ...zeroAttemptResult, attempts: [] }) } }), error => error instanceof EvidenceSupportError && error.code === "invalid_binding");
const empty = await verifyEvidenceSupport({ query, scope, candidates: [], client });
assert.deepEqual(empty.validation, { status: "complete", outputHash: null, invalidDecisions: [] }); assert.deepEqual(empty.attempts, []);
assert.equal(validateEvidenceSupportVerification({ ...empty, attempts: partial.attempts }, { ...bound, candidates: [] }), false);
console.log("PASS typed candidate isolation: strict full IDs, invalid is unavailable, valid evidence survives, legacy wire unchanged, complete usage, binding and source rechecks; no remote calls.");
