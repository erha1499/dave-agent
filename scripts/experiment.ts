import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { experimentCatalog, resolveExperimentConfig, remoteRequired } from "../src/experiment-config.ts";

export const experimentHelp = `用法：
  node scripts/experiment.ts --list
  node scripts/experiment.ts --preset retrieval-local [--dry-run]
  node --env-file-if-exists=.env scripts/experiment.ts --config experiment.json --run
  node --env-file-if-exists=.env scripts/experiment.ts --preset support-ab --run --allow-remote

--preset 与 --config 二选一。默认仅预览，--run 才执行。
--allow-remote 显式允许本次付费模型调用；本地 M0/M1 不需要。
可从工作台下载 JSON，或复制 configs/experiments 示例调整参数。
退出码：0=执行完成或预览，1=结果含失败/缺项，2=配置/执行基础设施错误。`;
export function parseExperimentArgs(args: string[]) {
  if (!args.length || args.length === 1 && args[0] === "--help") return { action: "help" as const };
  if (args.length === 1 && args[0] === "--list") return { action: "list" as const };
  const parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: {
    preset: { type: "string" }, config: { type: "string" }, run: { type: "boolean" }, "dry-run": { type: "boolean" }, "allow-remote": { type: "boolean" },
  } });
  const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
  const { preset, config, run } = parsed.values;
  if (new Set(names).size !== names.length || Boolean(preset) === Boolean(config) || run && parsed.values["dry-run"])
    throw new Error("选择一个预设或配置文件；--run 与 --dry-run 不能同时使用。");
  return { action: run ? "run" as const : "preview" as const, preset, config, allowRemote: parsed.values["allow-remote"] };
}

async function main() {
  const options = parseExperimentArgs(process.argv.slice(2));
  if (options.action === "help") { console.log(experimentHelp); return; }
  if (options.action === "list") { console.log(experimentCatalog().presets.map(preset => `${preset.id}\t${preset.name}`).join("\n")); return; }
  let value: unknown;
  if (options.preset) {
    value = experimentCatalog().presets.find(preset => preset.id === options.preset)?.config;
    if (!value) throw new Error("没有该预设。");
  } else {
    const file = await readFile(options.config!);
    if (file.length > 32 * 1024) throw new Error("配置文件过大。");
    value = JSON.parse(file.toString("utf8"));
  }
  const config = resolveExperimentConfig(value);
  if (options.allowRemote) config.allowRemote = true;
  if (options.action === "preview") {
    console.log(JSON.stringify({ config, remoteRequired: remoteRequired(config), plannedRuns: config.repeat * config.variants.length }, null, 2)); return;
  }
  const { ExperimentJobs } = await import("../src/experiment-jobs.ts");
  const jobs = new ExperimentJobs();
  try {
    const created = await jobs.start(config);
    console.log(`实验已启动：${created.id}（${created.plannedRuns} 次运行）`);
    await jobs.close();
    const result = await jobs.get(created.id);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result?.status === "completed" ? 0 : result?.status === "completed_with_failures" ? 1 : 2;
  } finally { await jobs.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => { console.error("实验未完成，请检查配置参数及本机服务；已保存记录保留，不自动重跑。使用 --help 查看用法。"); process.exitCode = 2; });
}
