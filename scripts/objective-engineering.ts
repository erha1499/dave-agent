import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { EvalStore, readEvalDatabaseConfig } from "../src/eval-store.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { summarizeEvaluation, type EvalBatch, type EvalCase, type EvalObjectivePlan, type EvalRun } from "../src/evaluation.ts";
import { createObjectiveSnapshot, hash, noModel } from "./objective-support.ts";

// These are runtime inputs of the retrieval gates, including archive validation and provenance.
const dataFiles = [
  "data/retrieval-validation.json", "data/retrieval-context-validation.json", "data/retrieval-boundaries.json",
  "data/reference/kefu-harness/source.json", "data/reference/kefu-harness/LICENSE", "data/reference/kefu-harness/NOTICE.md",
  "data/reference/kefu-harness/README.md", "data/reference/kefu-harness/data/knowledge/docs.jsonl",
  "data/reference/kefu-harness/data/evalsets/retrieval.jsonl", "data/reference/kefu-harness/data/evalsets/retrieval_hard.jsonl",
];

export const engineeringGates = [
  { id: "order-database", name: "订单事实与数据库权限", tags: ["order_facts", "identity"], scripts: ["coupon-db-check.ts"] },
  { id: "order-agent", name: "订单工具与 Pi 回填", tags: ["order_facts", "identity", "retrieval"], scripts: ["coupon-agent-check.ts"] },
  { id: "merchant-database", name: "协商事务、回调与三终态", tags: ["merchant", "identity", "concurrency"], scripts: ["merchant-db-check.ts"] },
  { id: "merchant-agent", name: "协商宿主确认边界", tags: ["merchant", "confirmation"], scripts: ["merchant-agent-check.ts"] },
  { id: "refund-database", name: "退款幂等、归属、期限与整单快照", tags: ["refund", "confirmation", "identity", "recovery", "concurrency"], scripts: ["refund-db-check.ts"] },
  { id: "refund-agent", name: "退款发送、确认与回执恢复", tags: ["refund", "confirmation", "recovery"], scripts: ["refund-agent-check.ts"] },
  { id: "notification-database", name: "通知原路由、原子领取与恢复", tags: ["notification", "identity", "recovery", "concurrency"], scripts: ["merchant-notification-db-check.ts"] },
  { id: "notification-agent", name: "事件与用户串行、关闭和故障恢复", tags: ["notification", "confirmation", "recovery", "concurrency"], scripts: ["merchant-notification-agent-check.ts"] },
  { id: "two-user-isolation", name: "双用户异额退款与上下文隔离", tags: ["identity", "context", "refund", "concurrency"], scripts: ["qq-isolation-check.ts"] },
  { id: "qq-protocol", name: "QQ 双入口与事件协议", tags: ["protocol", "identity"], scripts: ["qq-check.ts"] },
  { id: "qq-queue", name: "会话队列、超时与关闭", tags: ["context", "concurrency", "recovery"], scripts: ["qq-agent-check.ts"] },
  { id: "reply-protocol", name: "宿主模板、按钮、转义及 SDK 发信", tags: ["protocol", "confirmation"], scripts: ["reply-check.ts", "qq-reply-check.ts"] },
  { id: "retrieval-engineering", name: "检索数据、排序与上下文实验边界", tags: ["retrieval"], scripts: ["retrieval-check.ts", "retrieval-context-check.ts"] },
  { id: "evaluation-integrity", name: "评测计划、聚合和只读 HTTP", tags: ["evaluation", "protocol"], scripts: ["eval-analysis-check.ts", "eval-check.ts"] },
  { id: "evaluation-database", name: "评测持久化、历史兼容及权限", tags: ["evaluation", "recovery"], scripts: ["eval-db-check.ts"] },
] as const;

export function engineeringPlan(): EvalObjectivePlan {
  return { version: 1, scope: "objective", answerQuality: "not_evaluated", cases: engineeringGates.map(gate => ({
    id: gate.id, tags: [...gate.tags], turns: [{ index: 1, source: "engineering", checks: [
      { id: "gate-completed", category: "execution", basis: "execution" },
    ] }],
  })) };
}

export async function runObjectiveEngineering(options: { label: string; batch?: EvalBatch }) {
  const root = new URL("../", import.meta.url), plan = engineeringPlan();
  const files = ["scripts/objective-engineering.ts", ...dataFiles, ...engineeringGates.flatMap(gate => gate.scripts.map(script => `scripts/${script}`))];
  // Include imported source and fixture dependencies, not just the top-level gate names.
  for (const directory of ["src", "scripts", "db"]) for (const file of await readdir(new URL(`${directory}/`, root))) {
    if (/\.(?:ts|sql)$/.test(file)) files.push(`${directory}/${file}`);
  }
  const history = new EvalStore(createPool(readEvalDatabaseConfig()));
  const businessPool = createPool(readDatabaseConfig());
  const orders = new CouponStore(businessPool);
  const cases: EvalCase[] = [];
  let run: EvalRun | undefined;
  try {
    await history.ping();
    const initialOrders = [];
    for (const number of [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 2001, 2002, 2003]) {
      const { asOf, ...order } = await orders.getOrder({ appId: "TEST_APP", senderId: number === 1002 ? "TEST_USER2" : "TEST_USER1" }, `COUPON-${number}`);
      initialOrders.push({ ...order, coupons: order.coupons.map(coupon => ({ ...coupon,
        valid: coupon.expiresAt === null ? null : Date.parse(coupon.expiresAt) > Date.parse(asOf) })) });
    }
    const [knowledgeDocuments] = await businessPool.execute<RowDataPacket[]>(
      "SELECT id,shop_id,product_id,title,body,tags,status FROM knowledge_documents WHERE status = 'active' ORDER BY id");
    const dataHashes = Object.fromEntries(await Promise.all(dataFiles.map(async path => [path, hash(await readFile(new URL(path, root)))] as const)));
    run = { id: randomUUID(), suiteId: "engineering-objective-v1", suiteName: "既有业务工程覆盖", kind: "engineering", label: options.label,
      ...options.batch && { batch: options.batch }, status: "running", startedAt: new Date().toISOString(), finishedAt: null,
      plannedCases: plan.cases.length, plannedTurns: plan.cases.length, metrics: null,
      snapshot: await createObjectiveSnapshot({ plan, files, model: noModel, tools: [], business: { fixtures: "owned synthetic fixtures with per-script cleanup", initialOrders, knowledgeDocuments, seed: await readFile(new URL("db/02-seed.sql", root), "utf8") },
        dataset: { gates: engineeringGates, dataHashes }, settings: { childProcessTimeoutMs: 180_000, maxBufferBytes: 1024 * 1024, order: "sequential" },
        measurement: "真实MySQL、Pi脚本模型与本地QQ协议工程gate；每个gate为一个检查单元，耗时含独立Node进程及fixture准备清理，不代表真实模型或QQ平台送达。脚本内部断言未单独计分。" }),
    };
    await history.startRun(run);
    const logDirectory = new URL(`.runtime/objective-gates/${run.id}/`, root);
    await mkdir(logDirectory, { recursive: true });
    console.log(`[RUN] ${run.id} engineering ${plan.cases.length} gates`);
    for (const gate of engineeringGates) {
      const startedAt = new Date().toISOString(), start = performance.now();
      const outcomes: { script: string; exitCode: number | null; signal: string | null; timedOut: boolean }[] = [];
      for (const script of gate.scripts) {
        const result = await new Promise<{ code: number | null; signal: string | null; timedOut: boolean; log: string }>(resolve => {
          execFile(process.execPath, ["--env-file-if-exists=.env", `scripts/${script}`], {
            cwd: fileURLToPath(root), timeout: 180_000, maxBuffer: 1024 * 1024,
          }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0,
            signal: error?.signal ?? null, timedOut: Boolean(error?.killed), log: `${stdout}\n${stderr}` }));
        });
        await writeFile(new URL(`${script}.log`, logDirectory), result.log, { mode: 0o600 });
        outcomes.push({ script, exitCode: result.code, signal: result.signal, timedOut: result.timedOut });
      }
      const passed = outcomes.every(outcome => outcome.exitCode === 0 && !outcome.signal && !outcome.timedOut);
      const status = passed ? "passed" : "failed", durationMs = Math.round(performance.now() - start);
      const item: EvalCase = { id: gate.id, name: gate.name, category: "工程检查", status, turns: [{
        index: 1, question: gate.scripts.map(script => `node scripts/${script}`).join("\n"), reply: "", status, startedAt, durationMs,
        firstTextMs: null, evidenceIds: [], checks: [{ id: "gate-completed", name: "固定工程 gate 完整执行通过", category: "execution", status,
          ...!passed && { reason: "至少一个工程脚本失败、超时或被终止；受控退出信息见步骤，本地原始日志位于 .runtime/objective-gates。" } }],
        steps: [{ index: 1, type: "tool", name: "engineering_gate", durationMs, isError: !passed,
          input: { scripts: [...gate.scripts] }, output: { outcomes, logs: "local-only", assertionGranularity: "gate" } }],
      }] };
      await history.saveCase(run.id, item); cases.push(item);
      console.log(`[${status.toUpperCase()}] ${gate.id}`);
    }
    await history.finishRun(run.id, "completed", new Date().toISOString(), summarizeEvaluation(cases));
    return run.id;
  } catch (error) {
    if (run) await history.finishRun(run.id, "failed", new Date().toISOString(), summarizeEvaluation(cases), "工程评测执行未完成，计划内缺失项不得计为通过。").catch(() => {});
    throw error;
  } finally { await Promise.all([history.close(), orders.close()]); }
}
