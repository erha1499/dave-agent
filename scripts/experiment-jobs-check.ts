import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeExperiment, ExperimentBusyError, ExperimentJobs, type ExperimentExecute, type ExperimentExecution, type ExperimentResult } from "../src/experiment-jobs.ts";

import { experimentCatalog } from "../src/experiment-config.ts";
import type { runRetrievalV2, V2Dataset } from "./retrieval-v2.ts";
import type { runSupportV2Live } from "./support-v2-live.ts";

const config = { version: 1, kind: "retrieval", label: "serial synthetic experiment", repeat: 2, allowRemote: false,
  variants: [{ id: "A", modes: ["M0"] }, { id: "B", modes: ["M1"] }] };
const result = (input: ExperimentExecution, status = "completed"): ExperimentResult => ({ variantId: input.variant.id,
  repetition: input.repetition, kind: "retrieval", runId: randomUUID(), status,
  summary: { plannedRows: 1, completedRows: 1, missingRows: 0, groups: [], usage: [] } });
const root = await mkdtemp(join(tmpdir(), "dave-experiment-jobs-"));
const services: ExperimentJobs[] = [];
function service(name: string, execute?: ExperimentExecute) {
  const jobs = new ExperimentJobs({ directory: join(root, name), ...(execute ? { execute } : {}) }); services.push(jobs); return jobs;
}
try {
  const applicabilityConfig = experimentCatalog().presets.find(p => p.id === "support-knowledge-applicability-ab")!.config;
  if (applicabilityConfig.kind !== "support") throw new Error("support applicability preset expected");
  for (const variant of applicabilityConfig.variants) {
    let actual: Parameters<typeof runSupportV2Live>[0] | undefined;
    const runId = randomUUID(), jobId = randomUUID();
    await assert.rejects(executeExperiment({ config: { ...applicabilityConfig, allowRemote: true }, variant,
      jobId, repetition: 1, batch: { id: jobId, repetition: 1, plannedRepetitions: 1 } }, {
      runSupport: async options => { actual = structuredClone(options); return runId; },
      readSupport: async id => { assert.equal(id, runId); return undefined; },
    }), /没有可回读记录/);
    assert.deepEqual(actual?.parameters, variant.parameters, "actual business runner receives the resolved applicability variant; no DB/API in this check");
  }
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const order: ExperimentExecution[] = []; let executing = 0, maxExecuting = 0;
  const jobs = service("serial", async input => {
    order.push(structuredClone(input)); maxExecuting = Math.max(maxExecuting, ++executing);
    if (order.length === 1) await blocked;
    input.config.label = "mutation must not escape the runner";
    executing--; return result(input);
  });
  assert.deepEqual(await jobs.list(), []);
  await assert.rejects(jobs.start({ ...config, command: "not-accepted" }));
  await assert.rejects(jobs.start({ ...config, variants: [{ id: "A", modes: ["M4"] }] }), /付费模型/);
  const started = await jobs.start(config);
  assert.equal(started.status, "running"); assert.equal(started.plannedRuns, 4); assert.equal(started.results.length, 0);
  started.config.label = "consumer mutation";
  assert.equal((await jobs.get(started.id))!.config.label, config.label);
  assert.equal(Object.hasOwn((await jobs.get(started.id))!, "ownerPid"), false);
  assert.equal((await stat(join(jobs.directory, `${started.id}.json`))).mode & 0o777, 0o600);
  const competing = service("serial", async input => result(input));
  await assert.rejects(competing.start(config), ExperimentBusyError);
  assert.equal((await jobs.list())[0]!.id, started.id);
  let closed = false;
  const closing = jobs.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false, "close waits for active experiment cleanup");
  unblock(); await closing;
  assert.equal(maxExecuting, 1);
  assert.deepEqual(order.map(item => [item.repetition, item.variant.id]), [[1, "A"], [1, "B"], [2, "A"], [2, "B"]]);
  assert.equal(order[0]!.batch.id, order[2]!.batch.id); assert.equal(order[1]!.batch.id, order[3]!.batch.id);
  assert.notEqual(order[0]!.batch.id, order[1]!.batch.id);
  assert.ok(order.every(item => item.batch.plannedRepetitions === 2 && item.config.label === config.label));
  const finished = (await jobs.get(started.id))!;
  assert.equal(finished.status, "completed"); assert.equal(finished.results.length, 4); assert.equal(finished.current, null);
  assert.equal(finished.configHash, started.configHash); assert.match(finished.configHash, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(join(jobs.directory, "active.json")), { code: "ENOENT" });
  await assert.rejects(jobs.start(config), /已关闭/);
  const next = await competing.start({ ...config, repeat: 1 }); await competing.close();
  assert.equal((await competing.get(next.id))!.status, "completed", "a released directory can execute another experiment");

  // Exercise the real executor adapter with injected provider-free runner and fixed-enum dataset loader.
  const seenOptions: Parameters<typeof runRetrievalV2>[0][] = [], loaded: string[] = [];
  const datasets: Record<string, V2Dataset> = { development: { source: { split: "development" }, corpora: [] }, validation: { source: { split: "validation" }, corpora: [] },
    "support-validation": { source: { split: "support-validation" }, corpora: [] } };
  const executeA1: ExperimentExecute = input => executeExperiment(input, {
    loadAcceptance: async split => { loaded.push(split); return datasets[split]!; },
    runRetrieval: async options => {
      seenOptions.push(structuredClone(options));
      return { path: "mock-only", report: { runId: randomUUID(), status: "completed", summary: {
        plannedRows: 1, completedRows: 1, missingRows: 0, groups: [], usage: [],
      } } };
    },
  });
  const a1Config = { ...experimentCatalog().presets.find(p => p.id === "acceptance-development")!.config, repeat: 2, allowRemote: true };
  const a1 = service("acceptance-adapter", executeA1);
  await assert.rejects(a1.start({ ...a1Config, variants: [{ id: "A", modes: ["M1"], dataset: "acceptance-development", acceptance: { mode: "score", threshold: .8 } }] }));
  assert.equal(seenOptions.length, 0, "incompatible acceptance/mode never reaches runner or credentials");
  assert.equal(loaded.length, 0, "invalid config is rejected before reading any dataset");
  const a1Started = await a1.start(a1Config); await a1.close();
  assert.deepEqual(loaded, ["development", "development", "development", "development"]);
  const expectedConditions = a1Config.variants.map(variant => "acceptance" in variant ? variant.acceptance : undefined);
  assert.deepEqual(seenOptions.map(options => options.acceptance), [...expectedConditions, ...expectedConditions]);
  assert.ok(seenOptions.every(options => options.allowRemote === true && JSON.stringify(options.dataset) === JSON.stringify(datasets.development)));
  const a1Saved = (await a1.get(a1Started.id))!;
  assert.deepEqual(a1Saved.config, a1Started.config);
  assert.equal(a1Saved.results.length, 4);
  assert.deepEqual(JSON.parse(await readFile(join(a1.directory, `${a1Saved.id}.json`), "utf8")).config, a1Saved.config, "manifest keeps actual split and each acceptance condition");
  const otherDataset = service("acceptance-validation", executeA1);
  const validationConfig = { ...a1Config, repeat: 1, variants: [{ id: "A", modes: ["M4"], dataset: "acceptance-validation", acceptance: { mode: "score", threshold: .75 } }] };
  const validationJob = await otherDataset.start(validationConfig); await otherDataset.close();
  assert.equal(loaded.at(-1), "validation"); assert.deepEqual(seenOptions.at(-1)!.dataset, datasets.validation);
  const changedThreshold = service("acceptance-threshold", executeA1);
  const thresholdJob = await changedThreshold.start({ ...validationConfig, variants: [{ ...validationConfig.variants[0], acceptance: { mode: "score", threshold: .9 } }] }); await changedThreshold.close();
  assert.notEqual(thresholdJob.configHash, validationJob.configHash, "threshold changes are represented by the persisted condition hash");
  const changedDataset = service("acceptance-dataset", executeA1);
  const datasetJob = await changedDataset.start({ ...validationConfig, variants: [{ ...validationConfig.variants[0], dataset: "acceptance-development" }] }); await changedDataset.close();
  assert.notEqual(datasetJob.configHash, validationJob.configHash, "dataset changes are represented by the persisted condition hash");
  const legacyV2 = service("acceptance-legacy", executeA1), loadedBeforeLegacy = loaded.length;
  await legacyV2.start({ ...a1Config, repeat: 1, variants: [{ id: "A", modes: ["M0"], dataset: "legacy", acceptance: { mode: "off" } }] }); await legacyV2.close();
  assert.equal(loaded.length, loadedBeforeLegacy); assert.equal(Object.hasOwn(seenOptions.at(-1)!, "dataset"), false);
  assert.deepEqual(seenOptions.at(-1)!.acceptance, { mode: "off" });
  const legacyV1 = service("legacy-adapter", executeA1);
  await legacyV1.start({ ...config, repeat: 1 }); await legacyV1.close();
  assert.equal(loaded.length, loadedBeforeLegacy);
  assert.equal(Object.hasOwn(seenOptions.at(-1)!, "dataset"), false);
  assert.equal(Object.hasOwn(seenOptions.at(-1)!, "acceptance"), false, "v1 retains the original runner call semantics");
  const supportConfig = { ...experimentCatalog().presets.find(p => p.id === "support-validation")!.config, repeat: 2, allowRemote: true };
  const supportVerifier = service("support-verifier", executeA1), beforeSupportCalls = seenOptions.length, beforeSupportLoads = loaded.length;
  await assert.rejects(supportVerifier.start({ ...supportConfig, variants: [{ id: "A", modes: ["M0"], dataset: "acceptance-support-validation", acceptance: { mode: "support", threshold: .71 } }] }));
  assert.equal(seenOptions.length, beforeSupportCalls); assert.equal(loaded.length, beforeSupportLoads);
  const supportStarted = await supportVerifier.start(supportConfig); await supportVerifier.close();
  const supportOptions = seenOptions.slice(beforeSupportCalls);
  assert.deepEqual(loaded.slice(beforeSupportLoads), Array(4).fill("support-validation"));
  assert.deepEqual(supportOptions.map(options => options.acceptance), [
    { mode: "score", threshold: .71 }, { mode: "support", threshold: .71 }, { mode: "score", threshold: .71 }, { mode: "support", threshold: .71 },
  ]);
  assert.ok(supportOptions.every(options => JSON.stringify(options.dataset) === JSON.stringify(datasets["support-validation"])
    && options.parameters?.maxRequests === 160 && options.parameters.timeoutMs === 60000 && options.parameters.retries === 0));
  const supportSaved = (await supportVerifier.get(supportStarted.id))!;
  assert.equal(supportSaved.status, "completed"); assert.equal(supportSaved.results.length, 4);
  assert.deepEqual(supportSaved.config, supportStarted.config, "the persisted config preserves support mode and the new split");
  const scoreOnly = service("support-score-only", executeA1), supportOnly = service("support-only", executeA1);
  const sameVariant = { id: "A", modes: ["M4"], dataset: "acceptance-support-validation", parameters: { maxRequests: 160, timeoutMs: 60000, retries: 0 } };
  const scoreJob = await scoreOnly.start({ ...supportConfig, repeat: 1, variants: [{ ...sameVariant, acceptance: { mode: "score", threshold: .71 } }] }); await scoreOnly.close();
  const supportJob = await supportOnly.start({ ...supportConfig, repeat: 1, variants: [{ ...sameVariant, acceptance: { mode: "support", threshold: .71 } }] }); await supportOnly.close();
  assert.notEqual(supportJob.configHash, scoreJob.configHash, "changing only acceptance strategy changes the condition hash");

  let calls = 0;
  const failures = service("failure", async input => { if (++calls === 2) throw new Error("synthetic-secret-must-not-leak"); return result(input); });
  const failing = await failures.start(config); await failures.close();
  const stopped = (await failures.get(failing.id))!;
  assert.equal(calls, 2); assert.equal(stopped.status, "failed"); assert.equal(stopped.plannedRuns, 4); assert.equal(stopped.results.length, 1);
  assert.equal(JSON.stringify(stopped).includes("synthetic-secret"), false);
  await assert.rejects(readFile(join(failures.directory, "active.json")), { code: "ENOENT" });

  const partial = service("partial", async input => result(input, input.variant.id === "A" ? "completed_with_errors" : "completed"));
  const partialJob = await partial.start(config); await partial.close();
  assert.equal((await partial.get(partialJob.id))!.status, "completed_with_failures");
  assert.equal((await partial.get(partialJob.id))!.results.length, 4, "declared run failures retain subsequent repetitions");

  let resumeConcurrent!: () => void;
  const concurrentGate = new Promise<void>(resolve => { resumeConcurrent = resolve; });
  const concurrent = service("concurrent", async input => { await concurrentGate; return result(input); });
  const contenders = await Promise.allSettled([concurrent.start(config), concurrent.start(config)]);
  assert.equal(contenders.filter(item => item.status === "fulfilled").length, 1);
  assert.ok(contenders.some(item => item.status === "rejected" && item.reason instanceof ExperimentBusyError));
  resumeConcurrent(); await concurrent.close();

  const recovery = service("recovery", async input => result(input));
  const completedBeforeCrash = await recovery.start({ ...config, repeat: 1 }); await recovery.close();
  const crashed = JSON.parse(await readFile(join(recovery.directory, `${completedBeforeCrash.id}.json`), "utf8"));
  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  Object.assign(crashed, { status: "running", finishedAt: null, ownerPid: deadPid, current: { variantId: "A", repetition: 2 } });
  await writeFile(join(recovery.directory, `${crashed.id}.json`), JSON.stringify(crashed));
  await writeFile(join(recovery.directory, "active.json"), JSON.stringify({ pid: deadPid, jobId: crashed.id }));
  const restarted = service("recovery", async input => result(input));
  const recovered = (await restarted.get(crashed.id))!;
  assert.equal(recovered.status, "interrupted"); assert.equal(recovered.current, null); assert.deepEqual(recovered.results, crashed.results);
  await assert.rejects(readFile(join(recovery.directory, "active.json")), { code: "ENOENT" });
  const restartRun = await restarted.start({ ...config, repeat: 1 }); await restarted.close();
  assert.equal((await restarted.get(restartRun.id))!.status, "completed");
  // Recover an actual guarded generation, including a crash after active.json was removed.
  const guard = join(recovery.directory, "active.lock");
  await mkdir(guard);
  await writeFile(join(guard, `${crashed.id}.${deadPid}.json`), JSON.stringify({ pid: deadPid, jobId: crashed.id }));
  await writeFile(join(recovery.directory, `${crashed.id}.json`), JSON.stringify(crashed));
  assert.equal((await restarted.get(crashed.id))!.status, "interrupted");
  await assert.rejects(stat(guard), { code: "ENOENT" });
  await mkdir(guard);
  await writeFile(join(guard, `${crashed.id}.${process.pid}.json`), JSON.stringify({ pid: deadPid, jobId: crashed.id }));
  await writeFile(join(recovery.directory, "active.json"), JSON.stringify({ pid: deadPid, jobId: crashed.id }));
  await assert.rejects(restarted.get(crashed.id), ExperimentBusyError, "a live process already reclaiming a dead generation retains ownership");
  assert.equal(JSON.parse(await readFile(join(recovery.directory, "active.json"), "utf8")).jobId, crashed.id);
  await rm(guard, { recursive: true }); await rm(join(recovery.directory, "active.json"));
  // A crash can leave the manifest after the lock has already been released.
  await writeFile(join(recovery.directory, `${crashed.id}.json`), JSON.stringify(crashed));
  assert.equal((await restarted.list()).find(job => job.id === crashed.id)!.status, "interrupted");
  for (let index = 0; index < 31; index++) {
    const id = randomUUID();
    await writeFile(join(recovery.directory, `${id}.json`), JSON.stringify({ ...crashed, id, status: "completed", ownerPid: process.pid,
      createdAt: `2099-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }));
  }
  const recent = await restarted.list();
  assert.equal(recent.length, 30); assert.equal(recent[0]!.createdAt, "2099-01-31T00:00:00.000Z");
  assert.equal(recent[29]!.createdAt, "2099-01-02T00:00:00.000Z");

  const busy = service("partial-lock", async input => result(input));
  await busy.list();
  await mkdir(busy.directory, { recursive: true });
  await writeFile(join(busy.directory, "active.json"), "{\"pid\":");
  await assert.rejects(busy.start(config), ExperimentBusyError);
  assert.equal(await readFile(join(busy.directory, "active.json"), "utf8"), "{\"pid\":", "a partial lock is not treated as stale");
  await writeFile(join(busy.directory, "active.json"), JSON.stringify({ pid: process.pid, jobId: randomUUID() }));
  await assert.rejects(busy.start(config), ExperimentBusyError);
  assert.equal(JSON.parse(await readFile(join(busy.directory, "active.json"), "utf8")).pid, process.pid);
  assert.equal(await jobs.get("../active"), undefined);
} finally {
  await Promise.all(services.map(service => service.close()));
  await rm(root, { recursive: true, force: true });
}
console.log("experiment jobs checks passed: serial A/B repeats, immutable snapshots, busy locks, fixed missing runs, cleanup and dead-process recovery; no external calls.");
