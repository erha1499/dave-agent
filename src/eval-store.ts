import type { Pool, PoolOptions, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { readDatabaseConfig } from "./coupon-store.ts";
import type { EvalCase, EvalMetrics, EvalRun, EvalRunDetail, EvalRunSummary, EvalStep, EvalTurn } from "./evaluation.ts";
import { analyzeEvaluation, objectivePlan, validEvalBatch } from "./eval-analysis.ts";

const databaseFailure = "评测数据库操作失败，请检查本机数据库和 eval:init 配置。";
const validRunId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const decode = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export function readEvalDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolOptions {
  if (!env.EVAL_DB_PASSWORD) throw new Error("请先运行 eval:init 配置本机 EVAL_DB_PASSWORD。");
  const user = env.EVAL_DB_USER?.trim() || "dave_agent_eval";
  if (user === "root" || user === (env.DB_USER?.trim() || "dave_agent_read") || user.length > 32) throw new Error("评测账号必须独立于 root 和业务只读账号。");
  return readDatabaseConfig({ ...env, DB_USER: user, DB_PASSWORD: env.EVAL_DB_PASSWORD });
}

export class EvalStore {
  private pool: Pool;

  constructor(pool: Pool) { this.pool = pool; }

  async ping() {
    try { await this.pool.execute("SELECT id FROM eval_runs LIMIT 1"); } catch { throw new Error(databaseFailure); }
  }

  async close() {
    try { await this.pool.end(); } catch { throw new Error(databaseFailure); }
  }

  async startRun(run: EvalRun) {
    if (!validRunId(run.id) || run.status !== "running" || run.finishedAt !== null || !Number.isFinite(Date.parse(run.startedAt))) {
      throw new Error("评测运行标识或初始状态无效。");
    }
    if (objectivePlan(run).scope === "invalid" || (run.batch !== undefined && !validEvalBatch(run.batch))) {
      throw new Error("客观评测计划或批次元数据无效。");
    }
    try {
      await this.pool.execute("INSERT INTO eval_runs (id, kind, started_at, record) VALUES (?, ?, ?, ?)",
        [run.id, run.kind, new Date(run.startedAt), JSON.stringify(run)]);
    } catch { throw new Error(databaseFailure); }
  }

  async saveCase(runId: string, item: EvalCase) {
    if (!validRunId(runId) || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) throw new Error("评测运行或案例标识无效。");
    const connection = await this.pool.getConnection().catch(() => { throw new Error(databaseFailure); });
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT record FROM eval_runs WHERE id = ? FOR UPDATE", [runId]);
      const run = rows[0] ? decode<EvalRun>(rows[0].record) : undefined;
      if (run?.status !== "running") throw new Error("运行已结束或不存在。");
      if (analyzeEvaluation({ run, cases: [item] }).scope === "invalid") throw new Error("结果与客观评测计划不一致。");
      const { turns, ...caseRecord } = item;
      await connection.execute("INSERT INTO eval_case_results (run_id, case_id, record) VALUES (?, ?, ?)", [runId, item.id, JSON.stringify(caseRecord)]);
      for (const turn of turns) {
        const { steps, ...turnRecord } = turn;
        await connection.execute("INSERT INTO eval_turn_results (run_id, case_id, turn_index, record) VALUES (?, ?, ?, ?)",
          [runId, item.id, turn.index, JSON.stringify(turnRecord)]);
        for (const step of steps) {
          await connection.execute("INSERT INTO eval_steps (run_id, case_id, turn_index, step_index, record) VALUES (?, ?, ?, ?, ?)",
            [runId, item.id, turn.index, step.index, JSON.stringify(step)]);
        }
      }
      await connection.commit();
    } catch {
      await connection.rollback().catch(() => {});
      throw new Error(databaseFailure);
    } finally { connection.release(); }
  }

  async finishRun(runId: string, status: "completed" | "failed", finishedAt: string, metrics: EvalMetrics, error?: string) {
    if (!validRunId(runId) || !Number.isFinite(Date.parse(finishedAt))) throw new Error("评测运行标识或结束时间无效。");
    const record = "JSON_SET(record, '$.status', ?, '$.finishedAt', ?, '$.metrics', CAST(? AS JSON))";
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE eval_runs SET record = ${error === undefined ? `JSON_REMOVE(${record}, '$.error')` : `JSON_SET(${record}, '$.error', ?)`}
        WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(record, '$.status')) = 'running'`,
      [status, finishedAt, JSON.stringify(metrics), ...(error === undefined ? [] : [error]), runId]);
      if (result.affectedRows !== 1) throw new Error("运行已结束或不存在。");
    } catch { throw new Error(databaseFailure); }
  }

  async listRuns(limit = 50, kind: "model" | "engineering" = "model"): Promise<EvalRunSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !["model", "engineering"].includes(kind)) throw new Error("评测列表参数无效。");
    try {
      // LIMIT is interpolated only after integer validation; mysql2 prepares it inconsistently across MySQL releases.
      const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT JSON_REMOVE(record, '$.snapshot.content') AS record FROM eval_runs
        WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT ${limit}`, [kind]);
      return rows.map(row => decode<EvalRunSummary>(row.record));
    } catch { throw new Error(databaseFailure); }
  }

  async getRun(id: string): Promise<EvalRunDetail | undefined> {
    if (!validRunId(id)) throw new Error("评测运行标识无效。");
    const connection = await this.pool.getConnection().catch(() => { throw new Error(databaseFailure); });
    try {
      // One read snapshot prevents a running evaluator from changing the case set halfway through a detail response.
      await connection.query("START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT");
      const [runs] = await connection.execute<RowDataPacket[]>("SELECT record FROM eval_runs WHERE id = ?", [id]);
      if (!runs.length) { await connection.commit(); return undefined; }
      const [cases] = await connection.execute<RowDataPacket[]>("SELECT case_id, record FROM eval_case_results WHERE run_id = ? ORDER BY sequence_id", [id]);
      const [turns] = await connection.execute<RowDataPacket[]>("SELECT case_id, turn_index, record FROM eval_turn_results WHERE run_id = ? ORDER BY turn_index", [id]);
      const [steps] = await connection.execute<RowDataPacket[]>("SELECT case_id, turn_index, record FROM eval_steps WHERE run_id = ? ORDER BY step_index", [id]);
      await connection.commit();
      return {
        run: decode<EvalRun>(runs[0]!.record),
        // ponytail: suites are bounded to 500 cases; add assembly maps if history-detail profiling warrants it.
        cases: cases.map(row => ({ ...decode<Omit<EvalCase, "turns">>(row.record), turns: turns
          .filter(turn => turn.case_id === row.case_id).map(turn => ({ ...decode<Omit<EvalTurn, "steps">>(turn.record),
            steps: steps.filter(step => step.case_id === row.case_id && step.turn_index === turn.turn_index).map(step => decode<EvalStep>(step.record)),
          })),
        })),
      };
    } catch {
      await connection.rollback().catch(() => {});
      throw new Error(databaseFailure);
    } finally { connection.release(); }
  }

  async getBatch(id: string): Promise<EvalRunDetail[]> {
    if (!validRunId(id)) throw new Error("评测批次标识无效。");
    try {
      // Batches contain at most 20 runs; query the batch directly, never infer it from the recent-runs page.
      const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT id FROM eval_runs
        WHERE JSON_UNQUOTE(JSON_EXTRACT(record, '$.batch.id')) = ? ORDER BY started_at, id LIMIT 21`, [id]);
      if (rows.length > 20) throw new Error("批次运行数量超限。");
      const runs = await Promise.all(rows.map(row => this.getRun(row.id as string)));
      if (runs.some(run => !run)) throw new Error("批次记录不完整。");
      return runs as EvalRunDetail[];
    } catch { throw new Error(databaseFailure); }
  }
}
