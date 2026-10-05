import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireExperimentExecution, resolveExperimentConfig, type ExperimentConfig, type RetrievalVariant, type SupportVariant } from "./experiment-config.ts";
import type { EvalRunAnalysis } from "./eval-analysis.ts";
import type { EvalBatch } from "./evaluation.ts";
import type { runRetrievalV2 } from "../scripts/retrieval-v2.ts";
import type { loadAcceptanceDataset } from "../scripts/acceptance-data.ts";

type ResultBase = { variantId: string; repetition: number; status: string; runId: string };
export type ExperimentResult = ResultBase & ({ kind: "support"; summary: EvalRunAnalysis }
  | { kind: "retrieval"; summary: Awaited<ReturnType<typeof runRetrievalV2>>["report"]["summary"] });
export type ExperimentJob = {
  id: string; status: "running" | "completed" | "completed_with_failures" | "failed" | "interrupted";
  createdAt: string; finishedAt: string | null; config: ExperimentConfig; configHash: string;
  plannedRuns: number; current: { variantId: string; repetition: number } | null; error: string | null; results: ExperimentResult[];
};
type StoredJob = ExperimentJob & { ownerPid: number };
type ExecutionBase = { jobId: string; repetition: number; batch: EvalBatch };
export type ExperimentExecution = ExecutionBase & ({ config: Extract<ExperimentConfig, { kind: "support" }>; variant: SupportVariant }
  | { config: Extract<ExperimentConfig, { kind: "retrieval" }>; variant: RetrievalVariant });
export type ExperimentExecute = (execution: ExperimentExecution) => Promise<ExperimentResult>;
export class ExperimentBusyError extends Error {
  constructor(message = "已有实验运行中，请等待完成后再启动。") { super(message); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const missing = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
const exists = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
const publicJob = ({ ownerPid: _ownerPid, ...job }: StoredJob): ExperimentJob => structuredClone(job);
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
};
const gates = new Map<string, Promise<void>>();
// Serialize metadata operations between server instances in this process; wx is the cross-process gate.
async function serialized<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = gates.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(done => { release = done; });
  gates.set(directory, current);
  await previous;
  try { return await action(); }
  finally { release(); if (gates.get(directory) === current) gates.delete(directory); }
}

type RetrievalRunner = (options: Parameters<typeof runRetrievalV2>[0]) => Promise<{
  report: Pick<Awaited<ReturnType<typeof runRetrievalV2>>["report"], "runId" | "summary" | "status">;
}>;
export async function executeExperiment(input: ExperimentExecution, dependencies: {
  runRetrieval?: RetrievalRunner; loadAcceptance?: typeof loadAcceptanceDataset;
} = {}): Promise<ExperimentResult> {
  const common = { variantId: input.variant.id, repetition: input.repetition };
  if (input.config.kind === "support" && "architecture" in input.variant) {
    const [{ runSupportV2Live }, { createPool }, { EvalStore, readEvalDatabaseConfig }, { analyzeEvaluation }] = await Promise.all([
      import("../scripts/support-v2-live.ts"), import("mysql2/promise"), import("./eval-store.ts"), import("./eval-analysis.ts"),
    ]);
    const runId = await runSupportV2Live({ architecture: input.variant.architecture, parameters: input.variant.parameters,
      label: `${input.config.label} · ${input.variant.id}`, batch: input.batch, experiment: { id: input.jobId, variantId: input.variant.id } });
    const history = new EvalStore(createPool(readEvalDatabaseConfig()));
    try {
      const detail = await history.getRun(runId);
      if (!detail) throw new Error("已完成评测没有可回读记录。");
      const summary = analyzeEvaluation(detail), counts = summary.counts;
      const passed = detail.run.status === "completed" && summary.scope === "objective" && counts !== null
        && counts.cases.planned === counts.cases.passed && counts.checks.planned === counts.checks.passed;
      return { ...common, kind: "support", runId, summary, status: passed ? "completed" : "completed_with_failures" };
    } finally { await history.close(); }
  }
  if (input.config.kind !== "retrieval" || !("modes" in input.variant)) throw new Error("实验方案类型不匹配。");
  const runRetrieval = dependencies.runRetrieval ?? (await import("../scripts/retrieval-v2.ts")).runRetrievalV2;
  let acceptanceOptions: Pick<Parameters<typeof runRetrievalV2>[0], "dataset" | "acceptance"> = {};
  if ("dataset" in input.variant) {
    const { dataset, acceptance } = input.variant;
    acceptanceOptions = { acceptance };
    // The caller selects a fixed dataset enum, never an arbitrary file or module path.
    if (dataset !== "legacy") {
      const loadAcceptance = dependencies.loadAcceptance ?? (await import("../scripts/acceptance-data.ts")).loadAcceptanceDataset;
      const split = dataset === "acceptance-development" ? "development" : dataset === "acceptance-validation" ? "validation"
        : dataset === "acceptance-support-validation" ? "support-validation" : undefined;
      if (!split) throw new Error("未知实验数据集。");
      acceptanceOptions.dataset = await loadAcceptance(split);
    }
  }
  const { report } = await runRetrieval({ label: `${input.config.label} · ${input.variant.id}`,
    modes: input.variant.modes, parameters: input.variant.parameters, allowRemote: input.config.allowRemote, ...acceptanceOptions });
  return { ...common, kind: "retrieval", runId: report.runId, summary: report.summary, status: report.status };
}

export class ExperimentJobs {
  readonly directory: string;
  private execute: ExperimentExecute;
  private active?: Promise<void>;
  private closing = false;
  constructor(options: { directory?: string; execute?: ExperimentExecute } = {}) {
    this.directory = resolve(options.directory ?? fileURLToPath(new URL("../.runtime/experiments/", import.meta.url)));
    this.execute = options.execute ?? executeExperiment;
  }
  private async save(job: StoredJob) {
    const temporary = join(this.directory, `${job.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(job, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, `${job.id}.json`));
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  private async read(id: string): Promise<StoredJob | undefined> {
    if (!uuid.test(id)) return undefined;
    try {
      const job = JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")) as StoredJob;
      if (job.id !== id || !Number.isSafeInteger(job.ownerPid) || job.ownerPid < 1 || !Array.isArray(job.results)) throw new Error("实验记录无效。");
      return job;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  private async interrupt(job: StoredJob) {
    if (job.status !== "running" || alive(job.ownerPid)) return;
    job.status = "interrupted"; job.finishedAt = new Date().toISOString(); job.current = null;
    job.error = "执行进程已退出，未执行部分保留为缺失；不会自动重跑。";
    await this.save(job);
  }
  private async readLock(): Promise<{ pid: number; jobId: string } | undefined> {
    try {
      let contents: string;
      try { contents = await readFile(join(this.directory, "active.json"), "utf8"); }
      catch (error) {
        if (!missing(error)) throw error;
        let owners: string[];
        try { owners = await readdir(join(this.directory, "active.lock")); }
        catch (error) { if (missing(error)) return undefined; throw error; }
        if (owners.length !== 1) throw new ExperimentBusyError();
        contents = await readFile(join(this.directory, "active.lock", owners[0]!), "utf8");
      }
      const lock = JSON.parse(contents);
      if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid < 1 || typeof lock.jobId !== "string" || !uuid.test(lock.jobId)) throw new ExperimentBusyError();
      return lock;
    } catch (error) { if (missing(error)) return undefined; throw new ExperimentBusyError(); }
  }
  private async release(jobId: string) {
    const lock = await this.readLock();
    if (lock?.jobId !== jobId || lock.pid !== process.pid) return;
    await unlink(join(this.directory, "active.json")).catch(error => { if (!missing(error)) throw error; });
    await unlink(join(this.directory, "active.lock", `${jobId}.${process.pid}.json`));
    await rmdir(join(this.directory, "active.lock"));
  }
  private async recoverLock() {
    const lock = await this.readLock();
    if (!lock || alive(lock.pid)) return;
    const guard = join(this.directory, "active.lock"), owner = join(guard, `${lock.jobId}.${process.pid}.json`);
    let created = false;
    try { await mkdir(guard); created = true; } catch (error) { if (!exists(error)) throw error; }
    if (created) await writeFile(owner, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
    else {
      const owners = await readdir(guard);
      const previous = owners.length === 1 ? owners[0] : undefined;
      const match = previous?.match(/^([a-f0-9-]{36})\.([1-9]\d*)\.json$/i);
      if (!match || match[1] !== lock.jobId || alive(Number(match[2]))) throw new ExperimentBusyError();
      // Only the process that atomically renames this unique owner can recover the generation.
      // A competing recovery cannot unlink a new lock after this directory has been replaced.
      try { await rename(join(guard, previous!), owner); }
      catch (error) { if (missing(error)) throw new ExperimentBusyError(); throw error; }
    }
    const current = await this.readLock();
    if (current?.jobId !== lock.jobId || current.pid !== lock.pid || alive(current.pid)) throw new ExperimentBusyError();
    const job = await this.read(lock.jobId);
    if (job) await this.interrupt(job);
    await unlink(join(this.directory, "active.json")).catch(error => { if (!missing(error)) throw error; });
    await unlink(owner); await rmdir(guard);
  }
  async get(id: string): Promise<ExperimentJob | undefined> {
    return serialized(this.directory, async () => {
      await this.recoverLock();
      const job = await this.read(id);
      if (job) await this.interrupt(job);
      return job ? publicJob(job) : undefined;
    });
  }
  async list(): Promise<ExperimentJob[]> {
    return serialized(this.directory, async () => {
      await this.recoverLock();
      let files: string[];
      try { files = await readdir(this.directory); } catch (error) { if (missing(error)) return []; throw error; }
      const jobs: StoredJob[] = [];
      for (const file of files.filter(file => file.endsWith(".json") && uuid.test(file.slice(0, -5)))) {
        const job = await this.read(file.slice(0, -5));
        if (job) { await this.interrupt(job); jobs.push(job); }
      }
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 30).map(publicJob);
    });
  }
  async start(input: unknown): Promise<ExperimentJob> {
    const config = resolveExperimentConfig(input);
    requireExperimentExecution(config);
    if (this.closing) throw new Error("实验执行服务已关闭。");
    const job: StoredJob = { id: randomUUID(), ownerPid: process.pid, status: "running", createdAt: new Date().toISOString(), finishedAt: null,
      config, configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"), plannedRuns: config.repeat * config.variants.length,
      current: null, error: null, results: [] };
    await serialized(this.directory, async () => {
      await mkdir(this.directory, { recursive: true });
      await this.recoverLock();
      const guard = join(this.directory, "active.lock"), owner = join(guard, `${job.id}.${process.pid}.json`);
      await mkdir(guard).catch(error => { if (exists(error)) throw new ExperimentBusyError(); throw error; });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await writeFile(owner, JSON.stringify({ pid: process.pid, jobId: job.id }), { flag: "wx", mode: 0o600 });
        handle = await open(join(this.directory, "active.json"), "wx", 0o600).catch(error => { if (exists(error)) throw new ExperimentBusyError(); throw error; });
        await handle.writeFile(JSON.stringify({ pid: process.pid, jobId: job.id }));
        await handle.close();
        if (this.closing) throw new Error("实验执行服务已关闭。");
        await this.save(job);
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          await unlink(join(this.directory, "active.json")).catch(error => { if (!missing(error)) throw error; });
        }
        await unlink(owner).catch(error => { if (!missing(error)) throw error; });
        await rmdir(guard);
        throw error;
      }
      // Assign while holding the metadata gate so close/start cannot miss the active work.
      this.active = this.run(job).catch(() => {});
    });
    return publicJob(job);
  }
  private async run(job: StoredJob) {
    const batches = new Map(job.config.variants.map(variant => [variant.id, randomUUID()]));
    try {
      for (let repetition = 1; repetition <= job.config.repeat; repetition++) for (const variant of job.config.variants) {
        job.current = { variantId: variant.id, repetition }; await this.save(job);
        const batch = { id: batches.get(variant.id)!, repetition, plannedRepetitions: job.config.repeat };
        const execution = { jobId: job.id, config: structuredClone(job.config), variant: structuredClone(variant), repetition, batch } as ExperimentExecution;
        const result = await this.execute(execution);
        if (result.variantId !== variant.id || result.repetition !== repetition || result.kind !== job.config.kind || !uuid.test(result.runId)) {
          throw new Error("实验返回记录与执行计划不一致。");
        }
        job.results.push(structuredClone(result)); await this.save(job);
      }
      job.status = job.results.every(result => result.status === "completed") ? "completed" : "completed_with_failures";
    } catch {
      job.status = "failed"; job.error = "实验执行或结果保存失败，后续运行已停止；已保存结果保留，不会自动重跑。";
    } finally {
      job.finishedAt = new Date().toISOString(); job.current = null;
      try { await this.save(job); }
      finally { await serialized(this.directory, () => this.release(job.id)); }
    }
  }
  async close() {
    this.closing = true;
    await serialized(this.directory, async () => {});
    await this.active;
  }
}
