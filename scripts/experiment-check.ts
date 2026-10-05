import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
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
assert.equal(parseExperimentArgs([]).action, "help");
assert.equal(parseExperimentArgs(["--preset", "retrieval-local"]).action, "preview");
for (const args of [["--run"], ["--preset", "x", "--config", "x"], ["--preset", "x", "--run", "--dry-run"], ["--preset", "x", "--preset", "y"], ["--shell", "x"]])
  assert.throws(() => parseExperimentArgs(args));
const cli = await promisify(execFile)(process.execPath, ["scripts/experiment.ts", "--preset", "support-ab", "--dry-run"], {
  env: { PATH: process.env.PATH }, maxBuffer: 100_000,
});
assert.equal(JSON.parse(cli.stdout).remoteRequired, true, "dry-run works without DB or model credentials");

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
  assert.equal(starts, 1, "invalid or cross-origin requests never reach execution");
} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
console.log("PASS 实验配置/CLI预览与HTTP执行边界：白名单、组合、远程许可、body上限、同源、串行忙态及历史只读。");
