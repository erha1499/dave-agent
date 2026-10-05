import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimentCatalog, resolveExperimentConfig, remoteRequired, requireExperimentExecution, ExperimentInputError } from "../src/experiment-config.ts";
import { parseExperimentArgs } from "./experiment.ts";
import { createEvaluationServer } from "../src/eval-server.ts";
import { ExperimentBusyError, type ExperimentJob } from "../src/experiment-jobs.ts";

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
for (const key of ["knowledgeMode", "knowledgeSupport", "knowledgeThreshold", "knowledgeTimeoutMs"]) assert.ok(catalog.fields.support.some(field => field.key === key));
const profileAB = catalog.presets.find(preset => preset.id === "support-knowledge-profile-ab")!.config;
assert.equal(profileAB.kind, "support");
if (profileAB.kind !== "support") throw new Error("profile preset kind");
assert.deepEqual(profileAB.variants.map(variant => [variant.parameters.knowledgeMode, variant.parameters.knowledgeSupport]), [["m4-support", "binary"], ["m4-support", "typed"]]);
assert.deepEqual(resolveExperimentConfig(JSON.parse(await readFile("configs/experiments/support-knowledge-profile-ab.json", "utf8"))), profileAB);
assert.throws(() => resolveExperimentConfig({ ...support, variants: [{ id: "A", architecture: "controller", parameters: { knowledgeSupport: "typed" } }] }));
for (const entry of ["src/cli.ts", "src/qq.ts"]) {
  await assert.rejects(promisify(execFile)(process.execPath, [entry], {
    env: { SUPPORT_ARCHITECTURE: "atomic", KNOWLEDGE_MODE: "m4-support" }, timeout: 5000,
  }), (error: unknown) => {
    const failure = error as { code?: number; stderr?: string };
    assert.equal(failure.code, 1); assert.match(failure.stderr ?? "", /atomic 仅支持 lexical/);
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
