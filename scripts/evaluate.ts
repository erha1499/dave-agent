import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { analyzeBatch, analyzeEvaluation } from "../src/eval-analysis.ts";
import type { EvalBatch, EvalRunDetail } from "../src/evaluation.ts";

export const objectiveSuites = ["engineering", "retrieval", "readonly", "workflow"] as const;
export type ObjectiveSuite = typeof objectiveSuites[number];
export type EvaluationOptions = { suite: ObjectiveSuite | "all"; repeat: number; label: string };
const usage = "用法：node --env-file-if-exists=.env scripts/evaluate.ts --suite readonly|workflow|engineering|retrieval|all [--repeat 1..20] [--label '名称']";
export const evaluationHelp = `${usage}\n\n必须显式选择套件；readonly、workflow 和 all 会调用真实模型并产生费用。\nengineering、retrieval 不调用付费模型，但需要本机评测数据库。\n所有套件及重复运行均串行；默认重复1次。不评回答质量，不使用LLM judge。\n退出码：0=全部计划客观检查通过，1=完整执行后有失败/跳过/不可比，2=参数或基础设施失败。\n无参数和非法参数均不运行评测；--help 不连接数据库。`;

export function parseEvaluationArgs(args: string[]): EvaluationOptions | "help" {
  if (args.length === 1 && args[0] === "--help") return "help";
  try {
    const parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true,
      options: { suite: { type: "string" }, repeat: { type: "string" }, label: { type: "string" } } });
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error();
    const suite = parsed.values.suite, repeatText = parsed.values.repeat ?? "1", label = (parsed.values.label ?? "客观评测").trim();
    if (!suite || ![...objectiveSuites, "all"].includes(suite) || !/^(?:[1-9]|1\d|20)$/.test(repeatText)
      || !label || label.length > 120 || /[\p{Cc}]/u.test(label)) throw new Error();
    return { suite: suite as EvaluationOptions["suite"], repeat: Number(repeatText), label };
  } catch { throw new Error(usage); }
}

// The callback keeps orchestration testable without starting MySQL, subprocesses or a paid model.
export async function executeEvaluationBatches(options: EvaluationOptions,
  run: (suite: ObjectiveSuite, options: { label: string; batch: EvalBatch }) => Promise<EvalRunDetail>,
  report: (message: string) => void = console.log): Promise<0 | 1> {
  const suites = options.suite === "all" ? objectiveSuites : [options.suite];
  let failed = false;
  for (const suite of suites) {
    const batchId = randomUUID();
    const details: EvalRunDetail[] = [];
    report(`[BATCH START] ${JSON.stringify({ suite, batchId, plannedRepetitions: options.repeat })}`);
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      const batch = { id: batchId, repetition, plannedRepetitions: options.repeat };
      const detail = await run(suite, { label: options.label, batch });
      if (detail.run.batch?.id !== batchId || detail.run.batch.repetition !== repetition || detail.run.batch.plannedRepetitions !== options.repeat)
        throw new Error("运行没有保存正确的批次身份；停止后续重复，已完成历史仍保留。");
      details.push(detail);
      const analysis = analyzeEvaluation(detail);
      const allPassed = detail.run.status === "completed" && analysis.scope === "objective" && analysis.counts !== null
        && analysis.counts.cases.passed === analysis.counts.cases.planned && analysis.counts.checks.passed === analysis.counts.checks.planned;
      failed ||= !allPassed;
      report(`[RUN ANALYSIS] ${JSON.stringify({ suite, repetition, runId: detail.run.id, status: detail.run.status,
        scope: analysis.scope, answerQuality: analysis.answerQuality,
        ...(suite === "retrieval" ? { retrieval: analysis.retrieval } : { counts: analysis.counts }),
        usage: analysis.usage, execution: analysis.execution, issues: analysis.issues })}`);
      // Failed deterministic assertions do not suppress subsequent predeclared repetitions.
    }
    const summary = analyzeBatch(batchId, details);
    failed ||= !summary.compatible || summary.cases.some(item => item.status !== "always_passed");
    report(`[BATCH ANALYSIS] ${JSON.stringify({ suite, batchId, compatible: summary.compatible, issues: summary.issues,
      plannedRepetitions: summary.plannedRepetitions, startedRuns: summary.startedRuns, completedRuns: summary.completedRuns, missingRuns: summary.missingRuns,
      runIds: summary.runIds, stability: Object.fromEntries(["always_passed", "always_failed", "mixed", "incomplete"].map(status =>
        [status, summary.cases.filter(item => item.status === status).length])), usage: summary.usage })}`);
  }
  return failed ? 1 : 0;
}

async function runSuite(suite: ObjectiveSuite, options: { label: string; batch: EvalBatch }) {
  switch (suite) {
    case "readonly": return (await import("./objective-readonly.ts")).runObjectiveReadonly(options);
    case "workflow": return (await import("./objective-workflow.ts")).runObjectiveWorkflow(options);
    case "engineering": return (await import("./objective-engineering.ts")).runObjectiveEngineering(options);
    case "retrieval": return (await import("./objective-retrieval.ts")).runObjectiveRetrieval(options);
  }
}

async function main() {
  let options: EvaluationOptions | "help";
  try { options = parseEvaluationArgs(process.argv.slice(2)); }
  catch { console.error(usage); process.exitCode = 2; return; }
  if (options === "help") { console.log(evaluationHelp); return; }
  // Argument validation and help complete before any database configuration or runner import.
  const [{ createPool }, { EvalStore, readEvalDatabaseConfig }] = await Promise.all([import("mysql2/promise"), import("../src/eval-store.ts")]);
  const history = new EvalStore(createPool(readEvalDatabaseConfig()));
  try {
    await history.ping();
    process.exitCode = await executeEvaluationBatches(options, async (suite, configuration) => {
      const id = await runSuite(suite, configuration);
      const detail = await history.getRun(id);
      if (!detail) throw new Error("已执行运行没有可回读的持久化记录。");
      return detail;
    });
  } finally { await history.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    console.error("客观评测遇到配置、执行或持久化错误，已停止后续运行；已保存记录保留，缺失次数不算通过。底层诊断未输出。");
    process.exitCode = 2;
  });
}
