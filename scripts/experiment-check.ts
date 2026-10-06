import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readKnowledgeParameters, resolveSupportRunParameters } from "../src/support-parameters.ts";
import { experimentCatalog, resolveExperimentConfig, remoteRequired, requireExperimentExecution, ExperimentInputError } from "../src/experiment-config.ts";
import { parseExperimentArgs } from "./experiment.ts";
import { auditSupportKnowledgeCall, type runSupportV2Live } from "./support-v2-live.ts";
import { knowledgeQueryPlanVersion, type KnowledgeTrace } from "../src/knowledge-service.ts";
import { createEvidenceSupportClient, evidenceSupportTypedV6PromptVersion } from "../src/evidence-support.ts";
import { createEvaluationServer } from "../src/eval-server.ts";
import { executeExperiment, ExperimentBusyError, type ExperimentJob } from "../src/experiment-jobs.ts";

const catalog = experimentCatalog(), local = catalog.presets.find(p => p.id === "retrieval-local")!.config;
assert.equal(local.kind, "retrieval");
assert.equal(remoteRequired(local), false);
assert.equal(local.variants[0]!.parameters.candidateTopK, 20);
assert.doesNotThrow(() => requireExperimentExecution(local));
const support = catalog.presets[0]!.config;
assert.equal(remoteRequired(support), true);
assert.throws(() => requireExperimentExecution(support), ExperimentInputError);
assert.doesNotThrow(() => requireExperimentExecution({ ...support, allowRemote: true }));
const knowledgeAB = catalog.presets.find(preset => preset.id === "support-knowledge-ab")!.config;
assert.equal(knowledgeAB.kind, "support");
if (knowledgeAB.kind !== "support") throw new Error("knowledge preset kind");
assert.deepEqual(knowledgeAB.variants.map(variant => [variant.architecture, variant.parameters.knowledgeMode]),
  [["controller", "lexical"], ["controller", "m4-support"]]);
assert.ok(knowledgeAB.variants.every(variant => variant.parameters.knowledgeThreshold === .71 && variant.parameters.knowledgeTimeoutMs === 15_000));
assert.deepEqual(resolveExperimentConfig(JSON.parse(await readFile("configs/experiments/support-knowledge-ab.json", "utf8"))), knowledgeAB);
assert.throws(() => requireExperimentExecution(knowledgeAB));
assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "atomic", parameters: { knowledgeMode: "m4-support" } }] }));
for (const key of ["knowledgeMode", "knowledgeSupport", "knowledgeSupportModel", "knowledgeSupportPrompt", "knowledgeApplicability", "knowledgeQueryMode", "knowledgeThreshold", "knowledgeTimeoutMs"]) assert.ok(catalog.fields.support.some(field => field.key === key));
const profileAB = catalog.presets.find(preset => preset.id === "support-knowledge-profile-ab")!.config;
assert.equal(profileAB.kind, "support");
if (profileAB.kind !== "support") throw new Error("profile preset kind");
assert.deepEqual(profileAB.variants.map(variant => [variant.parameters.knowledgeMode, variant.parameters.knowledgeSupport]), [["m4-support", "binary"], ["m4-support", "typed"]]);
assert.deepEqual(resolveExperimentConfig(JSON.parse(await readFile("configs/experiments/support-knowledge-profile-ab.json", "utf8"))), profileAB);
assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "controller", parameters: { knowledgeSupport: "typed" } }] }));
const modelAB = catalog.presets.find(preset => preset.id === "support-knowledge-model-ab")!.config;
if (modelAB.kind !== "support") throw new Error("model preset kind");
assert.deepEqual(modelAB.variants.map(v => [v.architecture, v.parameters.knowledgeMode, v.parameters.knowledgeSupport, v.parameters.knowledgeSupportModel, v.parameters.knowledgeThreshold]),
  [["controller", "m4-support", "typed", "configured", .5], ["controller", "m4-support", "typed", "deepseek-v4-pro", .5]]);
assert.deepEqual(resolveExperimentConfig(JSON.parse(await readFile("configs/experiments/support-knowledge-model-ab.json", "utf8"))), modelAB);
assert.equal(readKnowledgeParameters({}).knowledgeSupportModel, "configured");
assert.equal(readKnowledgeParameters({}).knowledgeApplicability, "model_only");
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_APPLICABILITY: "declared" }).knowledgeApplicability, "declared");
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_APPLICABILITY: "declared-v2" }).knowledgeApplicability, "declared-v2");
for (const KNOWLEDGE_APPLICABILITY of ["typo", "0", "DECLARED"]) assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_APPLICABILITY }), /knowledgeApplicability/);
assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_APPLICABILITY: "declared" }), /仅适用于/);
assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_APPLICABILITY: "declared-v2" }), /仅适用于/);
const applicabilityAB = catalog.presets.find(preset => preset.id === "support-knowledge-applicability-ab")!.config;
if (applicabilityAB.kind !== "support") throw new Error("applicability preset kind");
assert.deepEqual(applicabilityAB.variants.map(v => v.parameters.knowledgeApplicability), ["model_only", "declared"]);
assert.deepEqual(resolveExperimentConfig(JSON.parse(await readFile("configs/experiments/support-knowledge-applicability-ab.json", "utf8"))), applicabilityAB);
const declaredParameters = applicabilityAB.variants[1]!.parameters;
const categoryAB = catalog.presets.find(preset => preset.id === "support-knowledge-category-ab")!.config;
if (categoryAB.kind !== "support") throw new Error("category preset kind");
assert.deepEqual(categoryAB.variants.map(v => v.parameters.knowledgeApplicability), ["declared", "declared-v2"]);
assert.deepEqual(categoryAB.variants.map(v => ({ ...v.parameters, knowledgeApplicability: "same" }))[0],
  categoryAB.variants.map(v => ({ ...v.parameters, knowledgeApplicability: "same" }))[1], "Category A/B changes only the applicability contract");
assert.ok(catalog.fields.support.find(field => field.key === "knowledgeApplicability")!.options!.some(option => option.value === "declared-v2"));
const queryAB = catalog.presets.find(preset => preset.id === "support-knowledge-query-ab")!.config;
if (queryAB.kind !== "support") throw new Error("query preset kind");
assert.deepEqual(queryAB.variants.map(v => v.parameters.knowledgeQueryMode), ["combined", "separated"]);
assert.deepEqual(queryAB.variants.map(v => ({ ...v.parameters, knowledgeQueryMode: "same" }))[0],
  queryAB.variants.map(v => ({ ...v.parameters, knowledgeQueryMode: "same" }))[1], "query A/B changes one parameter only");
assert.ok(queryAB.variants.every(v => v.architecture === "controller" && v.parameters.knowledgeMode === "m4-support"
  && v.parameters.knowledgeSupport === "typed" && v.parameters.knowledgeSupportModel === "deepseek-v4-pro"
  && v.parameters.knowledgeThreshold === .5 && v.parameters.knowledgeApplicability === "declared"));
assert.equal(queryAB.allowRemote, false); assert.throws(() => requireExperimentExecution(queryAB));
assert.equal(readKnowledgeParameters({}).knowledgeQueryMode, "combined");
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_QUERY_MODE: "separated" }).knowledgeQueryMode, "separated");
for (const KNOWLEDGE_QUERY_MODE of ["typo", "0", "SEPARATED"]) assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_QUERY_MODE }), /knowledgeQueryMode/);
assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_QUERY_MODE: "separated" }), /仅适用于/);
for (const parameters of [{ knowledgeQueryMode: "separated" }, { knowledgeMode: "m4-support", knowledgeQueryMode: "typo" },
  { knowledgeMode: "m4-support", knowledgeQueryMode: null }, { knowledgeMode: "m4-support", knowledgeQueryMode: undefined }]) {
  assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "controller", parameters }] }));
}
assert.throws(() => resolveSupportRunParameters("atomic", { knowledgeMode: "m4-support", knowledgeQueryMode: "separated" }), /atomic/);
const promptAB = catalog.presets.find(preset => preset.id === "support-knowledge-prompt-ab")!.config;
if (promptAB.kind !== "support") throw new Error("prompt preset kind");
assert.deepEqual(promptAB.variants.map(v => v.parameters.knowledgeSupportPrompt), ["v5", "v6"]);
assert.deepEqual({ ...promptAB.variants[0]!.parameters, knowledgeSupportPrompt: "same" },
  { ...promptAB.variants[1]!.parameters, knowledgeSupportPrompt: "same" }, "prompt A/B changes one parameter only");
assert.ok(promptAB.variants.every(v => v.architecture === "controller" && v.parameters.knowledgeMode === "m4-support"
  && v.parameters.knowledgeSupport === "typed" && v.parameters.knowledgeSupportModel === "deepseek-v4-pro"
  && v.parameters.knowledgeThreshold === .5 && v.parameters.knowledgeApplicability === "declared" && v.parameters.knowledgeQueryMode === "combined"));
assert.equal(promptAB.allowRemote, false); assert.throws(() => requireExperimentExecution(promptAB));
assert.equal(readKnowledgeParameters({}).knowledgeSupportPrompt, "v5");
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT: "typed", KNOWLEDGE_SUPPORT_PROMPT: "v6" }).knowledgeSupportPrompt, "v6");
for (const knowledgeSupportPrompt of ["typo", "V6", null, undefined]) assert.throws(() => resolveExperimentConfig({ ...support,
  variants: [{ id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportPrompt } }] }));
for (const parameters of [{ knowledgeSupportPrompt: "v6" as const }, { knowledgeMode: "m4-support" as const, knowledgeSupportPrompt: "v6" as const }])
  assert.throws(() => resolveSupportRunParameters("controller", parameters), /knowledgeSupportPrompt v6 仅适用于/);
assert.throws(() => resolveSupportRunParameters("atomic", { knowledgeMode: "m4-support", knowledgeSupport: "typed", knowledgeSupportPrompt: "v6" }), /atomic/);
for (const config of [queryAB, promptAB, categoryAB]) for (const variant of config.variants) {
  let actual: Parameters<typeof runSupportV2Live>[0] | undefined;
  await assert.rejects(executeExperiment({ config: { ...config, allowRemote: true }, variant, jobId: "query-check", repetition: 1,
    batch: { id: "query-check", repetition: 1, plannedRepetitions: 1 } }, {
    runSupport: async options => { actual = structuredClone(options); return "query-run-check"; }, readSupport: async () => undefined,
  }), /没有可回读记录/);
  assert.deepEqual(actual?.parameters, variant.parameters, "actual job adapter passes resolved query/prompt modes to the runner (no services)");
}
const auditTrace: KnowledgeTrace = { mode: "m4-support", supportProfile: "typed", supportModel: "deepseek-v4-pro", supportPrompt: "v5", threshold: .5,
  applicability: { mode: "declared" }, query: "synthetic check", originalQuery: "synthetic check", scope: { shopId: null, productId: null },
  queries: { version: knowledgeQueryPlanVersion, mode: "combined", retrieval: "synthetic check", evidence: "synthetic check" },
  status: "accepted", reason: null, rawRanking: [], acceptance: null, sourceHashes: { before: null, after: null }, durationMs: 0, calls: [],
  usage: { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
  pricing: { estimated: true, rerankCnyPerMillionTokens: null, rerankAsOf: "2026-10-05", supportSource: "Pi model catalog" } };
const auditCall = { id: "synthetic-knowledge", input: { query: "synthetic check", retrievalQuery: "short question" }, output: [], knowledge: { trace: auditTrace, context: {
  originalQuery: auditTrace.originalQuery, modelQuestion: null, effectiveQuery: auditTrace.query, retrievalQuery: "short question", purpose: "user_policy" as const,
  orderSource: "none" as const, scopeSource: "global" as const, facts: null, policyTopic: null, objectReference: null } } };
assert.equal(auditSupportKnowledgeCall(auditCall, declaredParameters).passed, false, "missing gate is incomplete");
auditTrace.applicability!.gate = { version: "declared-order-preconditions-v1", snapshotHash: "a".repeat(64), contextHash: null,
  status: "ready", integrity: false, reason: "facts_unknown", decisions: [] };
assert.equal(auditSupportKnowledgeCall(auditCall, declaredParameters).passed, false, "positive evidence cannot hide unknown necessary facts");
auditTrace.applicability!.gate.integrity = true;
assert.equal(auditSupportKnowledgeCall(auditCall, declaredParameters).passed, true);
assert.equal(auditSupportKnowledgeCall(auditCall, declaredParameters).supportPrompt, "not_called", "configured prompt is not proof that a provider ran");
const versionTwoAudit = structuredClone(auditCall), versionTwoParameters = { ...declaredParameters, knowledgeApplicability: "declared-v2" as const };
versionTwoAudit.knowledge.trace.applicability!.mode = "declared-v2";
assert.equal(auditSupportKnowledgeCall(versionTwoAudit, versionTwoParameters).passed, false, "v2 mode cannot relabel a v1 gate");
versionTwoAudit.knowledge.trace.applicability!.gate!.version = "declared-order-preconditions-v2";
assert.equal(auditSupportKnowledgeCall(versionTwoAudit, versionTwoParameters).passed, true);
const promptModel = { provider: "deepseek", id: "deepseek-v4-pro", api: "openai-completions", baseUrl: "https://api.deepseek.com", maxTokens: 2048,
  cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } };
for (const knowledgeSupportPrompt of ["v5", "v6"] as const) {
  const proof = structuredClone(auditCall), parameters = { ...declaredParameters, knowledgeSupportPrompt };
  proof.knowledge.trace.supportPrompt = knowledgeSupportPrompt;
  const configured = await createEvidenceSupportClient({ profile: "typed", typedPromptVersion: knowledgeSupportPrompt === "v6" ? evidenceSupportTypedV6PromptVersion : undefined,
    runtime: { model: promptModel, complete: async () => { throw new Error("settings-only check must never call a model"); } } });
  proof.knowledge.trace.settings = { serialization: "json-title-tags-body-v1", support: configured.settings };
  assert.equal(auditSupportKnowledgeCall(proof, parameters).supportPrompt, "not_called");
  proof.knowledge.trace.calls.push({ operation: "support", status: "ok", requestHash: "synthetic", attempts: [] });
  assert.equal(auditSupportKnowledgeCall(proof, parameters).passed, true);
  assert.equal(auditSupportKnowledgeCall(proof, parameters).supportPrompt, "matched");
  for (const field of ["promptHash", "promptVersion"] as const) {
    const changed = structuredClone(proof); changed.knowledge.trace.settings!.support![field] = "mismatch";
    assert.equal(auditSupportKnowledgeCall(changed, parameters).passed, false, "actual support settings bind both version and hash");
  }
  proof.knowledge.trace.supportPrompt = knowledgeSupportPrompt === "v5" ? "v6" : "v5";
  assert.equal(auditSupportKnowledgeCall(proof, parameters).passed, false, "trace configuration must match the run, not just compatible settings");
}
const binaryProof = structuredClone(auditCall);
binaryProof.knowledge.trace.supportProfile = "binary";
binaryProof.knowledge.trace.settings = { serialization: "json-title-tags-body-v1", support: (await createEvidenceSupportClient({ profile: "binary",
  runtime: { model: promptModel, complete: async () => { throw new Error("settings only"); } } })).settings };
binaryProof.knowledge.trace.calls.push({ operation: "support", status: "ok", requestHash: "synthetic", attempts: [] });
assert.equal(binaryProof.knowledge.trace.settings.support!.promptVersion, "fact-support-v1");
assert.equal(auditSupportKnowledgeCall(binaryProof, { ...declaredParameters, knowledgeSupport: "binary" }).passed, true,
  "the default v5 selection never relabels binary's actual v1 prompt");
const separatedCall = structuredClone(auditCall), separatedParameters = { ...declaredParameters, knowledgeQueryMode: "separated" as const };
separatedCall.knowledge.trace.queries!.mode = "separated";
separatedCall.knowledge.trace.queries!.retrieval = separatedCall.knowledge.trace.query = "short question";
const separatedAudit = auditSupportKnowledgeCall(separatedCall, separatedParameters);
assert.equal(separatedAudit.passed, true); assert.equal(separatedAudit.queryPlan, "complete");
assert.notEqual(separatedAudit.queryPlanHash, auditSupportKnowledgeCall(auditCall, declaredParameters).queryPlanHash,
  "ranking/evidence input and mode produce distinct audit fingerprints");
for (const mutate of [
  (call: typeof separatedCall) => { delete call.knowledge.trace.queries; },
  (call: typeof separatedCall) => { call.knowledge.trace.queries!.mode = "combined"; },
  (call: typeof separatedCall) => { call.knowledge.trace.query = "synthetic check"; },
  (call: typeof separatedCall) => { call.knowledge.trace.queries!.evidence = "short question"; },
  (call: typeof separatedCall) => { call.knowledge.trace.queries!.retrieval = "different question"; },
  (call: typeof separatedCall) => { call.input.query = "short question"; },
  (call: typeof separatedCall) => { call.input.retrievalQuery = "synthetic check"; },
]) {
  const tampered = structuredClone(separatedCall); mutate(tampered);
  assert.equal(auditSupportKnowledgeCall(tampered, separatedParameters).passed, false, "no silent query-plan mismatch or full-facts removal");
}
delete auditTrace.applicability!.gate; auditTrace.status = "unavailable"; auditTrace.reason = "database_unavailable";
const expectedFault = auditSupportKnowledgeCall(auditCall, declaredParameters, true);
assert.equal(expectedFault.passed, true); assert.equal(expectedFault.applicability, "not_evaluated");
assert.equal(auditSupportKnowledgeCall(auditCall, declaredParameters).passed, false, "unplanned database faults are not exempt");
auditTrace.calls.push({ operation: "support", status: "ok", requestHash: null, attempts: [] });
assert.equal(auditSupportKnowledgeCall(auditCall, declaredParameters, true).passed, false, "controlled read failure must stop before providers");
for (const knowledgeSupport of ["binary", "typed"]) assert.doesNotThrow(() => resolveExperimentConfig({ ...support,
  variants: [{ id: "A", architecture: "controller", parameters: { knowledgeMode: "m4-support", knowledgeSupport, knowledgeApplicability: "declared" } }] }));
for (const parameters of [{ knowledgeApplicability: "declared" }, { knowledgeMode: "m4-support", knowledgeApplicability: "typo" },
  { knowledgeMode: "m4-support", knowledgeApplicability: null }, { knowledgeMode: "m4-support", knowledgeApplicability: undefined }]) {
  assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "controller", parameters }] }));
}
assert.equal(readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT_MODEL: "deepseek-v4-pro" }).knowledgeSupportModel, "deepseek-v4-pro");
assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_SUPPORT_MODEL: "deepseek-v4-pro" }), /仅适用于/);
assert.throws(() => readKnowledgeParameters({ KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT_MODEL: "typo" }), /knowledgeSupportModel/);
assert.throws(() => resolveSupportRunParameters("atomic", { knowledgeMode: "m4-support", knowledgeSupportModel: "deepseek-v4-pro" }), /atomic/);
for (const parameters of [{ knowledgeSupportModel: "deepseek-v4-pro" }, { knowledgeMode: "m4-support", knowledgeSupportModel: "typo" }]) {
  assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "controller", parameters }] }));
}
await assert.rejects(promisify(execFile)(process.execPath, ["scripts/support-v2-live.ts", "--live", "--architecture", "controller", "--repeat", "1", "--applicability", "declared"],
  { env: {}, timeout: 5000 }), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr ?? "", /knowledgeApplicability declared 仅适用于/);
    assert.doesNotMatch(failure.stderr ?? "", /未知参数|DB_PASSWORD|API_KEY|QQBOT_APP_SECRET/); return true;
  });
for (const [args, errorPattern] of [
  [["--query-mode", "separated"], /knowledgeQueryMode separated 仅适用于/],
  [["--knowledge-mode", "m4-support", "--query-mode", "typo"], /knowledgeQueryMode 仅支持/],
  [["--knowledge-mode", "m4-support", "--knowledge-support-prompt", "v6"], /knowledgeSupportPrompt v6 仅适用于/],
  [["--knowledge-mode", "m4-support", "--knowledge-support", "typed", "--knowledge-support-prompt", "typo"], /knowledgeSupportPrompt 仅支持/],
] as const) await assert.rejects(promisify(execFile)(process.execPath,
  ["scripts/support-v2-live.ts", "--live", "--architecture", "controller", "--repeat", "1", ...args], { env: {}, timeout: 5000 }),
  (error: unknown) => { const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr ?? "", errorPattern);
    assert.doesNotMatch(failure.stderr ?? "", /未知参数|DB_PASSWORD|API_KEY|QQBOT_APP_SECRET/); return true; });
for (const entry of ["src/cli.ts", "src/qq.ts"]) {
  await assert.rejects(promisify(execFile)(process.execPath, [entry], {
    env: { SUPPORT_ARCHITECTURE: "atomic", KNOWLEDGE_MODE: "m4-support" }, timeout: 5000,
  }), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr ?? "", /atomic 仅支持 lexical/);
    assert.doesNotMatch(failure.stderr ?? "", /DB_PASSWORD|API_KEY|QQBOT_APP_SECRET/); return true;
  });
  await assert.rejects(promisify(execFile)(process.execPath, [entry], {
    env: { SUPPORT_ARCHITECTURE: "controller", KNOWLEDGE_MODE: "m4-support", KNOWLEDGE_SUPPORT_PROMPT: "v6" }, timeout: 5000,
  }), (error: unknown) => { const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr ?? "", /knowledgeSupportPrompt v6 仅适用于/);
    assert.doesNotMatch(failure.stderr ?? "", /DB_PASSWORD|API_KEY|QQBOT_APP_SECRET/); return true;
  });
}
for (const change of [
  { version: 2 }, { kind: ["retrieval"] }, { repeat: 0 }, { repeat: 4 }, { repeat: "1" }, { allowRemote: "true" }, { label: "\nsecret" },
  { env: { DASHSCOPE_API_KEY: "must-not-be-accepted" } }, { command: "touch forbidden" },
  { variants: [] }, { variants: [local.variants[0], local.variants[0]] },
  { variants: [{ id: "../invalid", modes: ["M0"] }] }, { variants: [{ id: "A", modes: ["M9"] }] },
  { variants: [{ id: "A", modes: ["M0"], parameters: { candidateTopK: 0 } }] },
  { variants: [{ id: "A", modes: ["M0"], parameters: { threshold: .5 } }] },
]) assert.throws(() => resolveExperimentConfig({ ...local, ...change }), ExperimentInputError);
assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "controller", parameters: { merchantEvents: "model" } }] }));
assert.deepEqual(resolveExperimentConfig(local), local);
assert.equal(local.version, 1);
assert.equal(Object.hasOwn(local.variants[0]!, "dataset"), false, "v1 resolver must not silently migrate historical JSON");
assert.equal(Object.hasOwn(local.variants[0]!, "acceptance"), false);
assert.equal(JSON.stringify(resolveExperimentConfig(local)), JSON.stringify(local), "v1 serialized output remains stable");
const acceptance = catalog.presets.find(p => p.id === "acceptance-development")!.config;
assert.equal(acceptance.version, 2); assert.equal(acceptance.kind, "retrieval");
assert.deepEqual(resolveExperimentConfig(acceptance), acceptance);
assert.equal(remoteRequired(acceptance), true);
assert.throws(() => requireExperimentExecution(acceptance), /付费模型/);
assert.equal(catalog.datasets.length, 4);
assert.deepEqual(catalog.acceptanceFields.map(field => field.key), ["mode", "threshold"]);
assert.ok(catalog.fields.retrieval.every(field => !["dataset", "acceptance", "threshold"].includes(field.key)));
const newVariant = { id: "A", modes: ["M4"], dataset: "acceptance-development", acceptance: { mode: "score", threshold: .8 } };
for (const change of [
  { dataset: "../.env" }, { dataset: "validation" }, { dataset: ["legacy"] }, { dataset: undefined },
  { acceptance: undefined }, { acceptance: null }, { acceptance: {} }, { acceptance: { mode: "off", threshold: .8 } },
  { acceptance: { mode: ["off"] } }, { acceptance: { mode: "score" } }, { acceptance: { mode: "score", threshold: "0.8" } },
  { acceptance: { mode: "score", threshold: -1 } }, { acceptance: { mode: "score", threshold: 1.01 } },
  { acceptance: { mode: "score", threshold: NaN } }, { acceptance: { mode: "score", threshold: Infinity } },
  { acceptance: { mode: "score", threshold: .8, apiKey: "must-not-be-accepted" } },
  { modes: ["M0"] }, { modes: ["M1", "M4"] }, { modes: ["M3", "M6"] },
  { parameters: { acceptance: { mode: "off" } } },
]) assert.throws(() => resolveExperimentConfig({ ...acceptance, variants: [{ ...newVariant, ...change }] }), ExperimentInputError);
assert.throws(() => resolveExperimentConfig({ ...support, version: 2 }), ExperimentInputError);
assert.throws(() => resolveExperimentConfig({ ...local, variants: [newVariant] }), ExperimentInputError, "v1 rejects newly meaningful fields");
for (const threshold of [0, 1]) assert.doesNotThrow(() => resolveExperimentConfig({ ...acceptance,
  variants: [{ ...newVariant, modes: ["M4", "M5", "M6"], acceptance: { mode: "score", threshold } }] }));
assert.doesNotThrow(() => resolveExperimentConfig({ ...acceptance, variants: [{ ...newVariant, modes: ["M0"], acceptance: { mode: "off" } }] }));
const example = resolveExperimentConfig(JSON.parse(await readFile(new URL("../configs/experiments/acceptance-development.json", import.meta.url), "utf8")));
assert.deepEqual(example.variants, acceptance.variants);
const supportDevelopment = catalog.presets.find(p => p.id === "support-development")!.config;
const supportValidation = catalog.presets.find(p => p.id === "support-validation")!.config;
for (const [presetId, config, dataset] of [["support-development", supportDevelopment, "acceptance-development"],
  ["support-validation", supportValidation, "acceptance-support-validation"]] as const) {
  assert.equal(config.version, 2); assert.equal(config.kind, "retrieval"); assert.equal(config.allowRemote, false);
  assert.equal(remoteRequired(config), true); assert.throws(() => requireExperimentExecution(config), /付费模型/);
  assert.deepEqual(resolveExperimentConfig(config), config);
  assert.deepEqual(config.variants.map(variant => "acceptance" in variant ? variant.acceptance : undefined), [
    { mode: "score", threshold: .71 }, { mode: "support", threshold: .71 },
  ]);
  assert.ok(config.variants.every(variant => "dataset" in variant && variant.dataset === dataset));
  assert.ok(config.variants.every(variant => variant.parameters.timeoutMs === 60000 && "maxRequests" in variant.parameters
    && variant.parameters.maxRequests === 160 && variant.parameters.retries === 0));
  const saved = JSON.parse(await readFile(new URL(`../configs/experiments/${presetId}.json`, import.meta.url), "utf8"));
  assert.deepEqual(resolveExperimentConfig(saved), config, "CLI file and catalog describe the same experiment");
}
assert.deepEqual(catalog.acceptanceFields[0]!.options!.map(option => option.value), ["off", "score", "support"]);
const supportVariant = { id: "A", modes: ["M4"], dataset: "acceptance-support-validation", acceptance: { mode: "support", threshold: .71 } };
for (const change of [
  { dataset: "support-validation" }, { dataset: "../data/acceptance-support-validation.json" },
  { modes: ["M0"] }, { modes: ["M2", "M4"] },
  { acceptance: { mode: "support" } }, { acceptance: { mode: "support", threshold: "0.71" } },
  { acceptance: { mode: "support", threshold: -.01 } }, { acceptance: { mode: "support", threshold: 1.01 } },
  { acceptance: { mode: "support", threshold: NaN } }, { acceptance: { mode: "support", threshold: Infinity } },
  { acceptance: { mode: "support", threshold: .71, model: "arbitrary-model" } },
  { acceptance: { mode: "support", threshold: .71, prompt: "arbitrary-prompt" } },
]) assert.throws(() => resolveExperimentConfig({ ...supportValidation, variants: [{ ...supportVariant, ...change }] }), ExperimentInputError);
for (const threshold of [0, 1]) assert.doesNotThrow(() => resolveExperimentConfig({ ...supportValidation,
  variants: [{ ...supportVariant, modes: ["M4", "M5", "M6"], acceptance: { mode: "support", threshold } }] }));
assert.throws(() => resolveExperimentConfig({ ...local, variants: [supportVariant] }), ExperimentInputError, "v1 never silently enables support verification");
const oldValidationFile = JSON.parse(await readFile(new URL("../configs/experiments/acceptance-validation.json", import.meta.url), "utf8"));
const oldValidation = resolveExperimentConfig(oldValidationFile);
assert.deepEqual(oldValidation.variants.map(variant => "acceptance" in variant ? variant.acceptance : undefined), [{ mode: "off" }, { mode: "score", threshold: .71 }], "old failed validation retains the original off/score comparison");
assert.ok(oldValidation.variants.every(variant => "dataset" in variant && variant.dataset === "acceptance-validation"));


assert.equal(parseExperimentArgs([]).action, "help");
assert.equal(parseExperimentArgs(["--preset", "retrieval-local"]).action, "preview");
for (const args of [["--run"], ["--preset", "x", "--config", "x"], ["--preset", "x", "--run", "--dry-run"], ["--preset", "x", "--preset", "y"], ["--shell", "x"]])
  assert.throws(() => parseExperimentArgs(args));
const cli = await promisify(execFile)(process.execPath, ["scripts/experiment.ts", "--preset", "support-ab", "--dry-run"], {
  env: { PATH: process.env.PATH }, maxBuffer: 100_000,
});
assert.equal(JSON.parse(cli.stdout).remoteRequired, true, "dry-run works without DB or model credentials");
const acceptanceCli = await promisify(execFile)(process.execPath, ["scripts/experiment.ts", "--preset", "acceptance-development", "--dry-run"], {
  env: { PATH: process.env.PATH }, maxBuffer: 100_000,
});
assert.deepEqual(JSON.parse(acceptanceCli.stdout).config, acceptance, "A1 preview resolves without credentials");
const supportCli = await promisify(execFile)(process.execPath, ["scripts/experiment.ts", "--preset", "support-validation", "--dry-run"], {
  env: { PATH: process.env.PATH }, maxBuffer: 100_000,
});
assert.deepEqual(JSON.parse(supportCli.stdout).config, supportValidation, "support verifier preview does not read model credentials");
const queryCli = await promisify(execFile)(process.execPath, ["scripts/experiment.ts", "--preset", "support-knowledge-query-ab", "--dry-run"], {
  env: { PATH: process.env.PATH }, maxBuffer: 100_000,
});
assert.deepEqual(JSON.parse(queryCli.stdout).config, queryAB, "query A/B preview resolves without model/DB credentials");
const promptCli = await promisify(execFile)(process.execPath, ["scripts/experiment.ts", "--preset", "support-knowledge-prompt-ab", "--dry-run"], {
  env: { PATH: process.env.PATH }, maxBuffer: 100_000,
});
assert.deepEqual(JSON.parse(promptCli.stdout).config, promptAB, "prompt A/B preview resolves without model/DB credentials");

let starts = 0, busy = false;
const job: ExperimentJob = {
  id: "10000000-0000-4000-8000-000000000001", status: "running", createdAt: new Date().toISOString(), finishedAt: null,
  config: local, configHash: "test", plannedRuns: 1, current: null, error: null, results: [],
};
const server = createEvaluationServer({ ping: async () => {}, listRuns: async () => [], getRun: async () => undefined, getBatch: async () => [] }, {
  list: async () => [job], get: async id => id === job.id ? job : undefined,
  start: async input => { const config = resolveExperimentConfig(input); requireExperimentExecution(config); if (busy) throw new ExperimentBusyError("已有活动实验。"); starts++; return job; },
});
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/experiments`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Experiment-Request": "1", ...headers,
  }, body });
  assert.equal((await fetch(`${base}/api/experiments/catalog`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/experiments`)).json(), { jobs: [job] });
  assert.equal((await fetch(`${base}/api/experiments/${job.id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/experiments/nope`)).status, 400);
  assert.equal((await fetch(`${base}/api/experiments?token=not-allowed`)).status, 400);
  assert.equal((await fetch(`${base}/api/experiments/10000000-0000-4000-8000-000000000002`)).status, 404);
  assert.equal((await post(JSON.stringify(local))).status, 202);
  busy = true; assert.equal((await post(JSON.stringify(local))).status, 409); busy = false;
  assert.equal((await post(JSON.stringify(support))).status, 400, "paid runs require explicit local opt-in");
  assert.equal((await post(JSON.stringify(acceptance))).status, 400, "A1 rerank requires the same explicit opt-in");
  assert.equal((await post(JSON.stringify({ ...acceptance, variants: [{ ...newVariant, modes: ["M1"] }], allowRemote: true }))).status, 400);
  assert.equal((await post(JSON.stringify({ ...acceptance, allowRemote: true }))).status, 202);
  assert.equal((await post(JSON.stringify(supportValidation))).status, 400);
  assert.equal((await post(JSON.stringify({ ...supportValidation, allowRemote: true }))).status, 202);
  assert.equal((await post(JSON.stringify({ ...supportValidation, allowRemote: true, variants: [{ ...supportVariant, modes: ["M0"] }] }))).status, 400);
  assert.equal((await post(JSON.stringify(local), { "X-Experiment-Request": "" })).status, 400);
  assert.equal((await post(JSON.stringify(local), { "Content-Type": "text/plain" })).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post(JSON.stringify({ ...local, command: "must-not-run" }))).status, 400);
  assert.equal((await post(" ".repeat(33 * 1024))).status, 400);
  assert.equal((await post(JSON.stringify(local), { Origin: "https://untrusted.test" })).status, 403);
  assert.equal((await post(JSON.stringify(local), { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/api/experiments`, { method: "POST", headers: { Host: `evil.test:${address.port}`, "Content-Type": "application/json", "X-Experiment-Request": "1" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject).end(JSON.stringify(local));
  });
  assert.equal(wrongHost, 403);
  const malformedUrl = await new Promise<string>((resolve, reject) => {
    let response = "";
    const socket = connect(address.port, "127.0.0.1", () => socket.write(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`));
    socket.setEncoding("utf8"); socket.on("data", chunk => { response += chunk; }); socket.once("end", () => resolve(response)); socket.once("error", reject);
  });
  assert.match(malformedUrl, /^HTTP\/1.1 400 /, "malformed URL is rejected without exiting the server");
  assert.equal((await fetch(`${base}/api/experiments`)).status, 200);
  assert.equal((await fetch(`${base}/api/runs`, { method: "POST" })).status, 405);
  assert.equal(starts, 3, "only valid v1/v2 requests reach execution; invalid or cross-origin requests never do");
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log("PASS 实验配置/CLI预览与HTTP执行边界：白名单、组合、远程许可、body上限、同源、串行忙态及历史只读。");
