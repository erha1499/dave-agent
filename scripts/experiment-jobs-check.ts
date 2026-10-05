import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExperimentBusyError, ExperimentJobs, type ExperimentExecute, type ExperimentExecution, type ExperimentResult } from "../src/experiment-jobs.ts";

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
