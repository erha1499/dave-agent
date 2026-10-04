import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { EvalObjectivePlan, EvalSnapshot } from "../src/evaluation.ts";

const root = new URL("../", import.meta.url);
const command = promisify(execFile);
export const hash = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");

// Every suite records its actual planned assertions before it starts; results never define the denominator.
export async function createObjectiveSnapshot(input: {
  plan: EvalObjectivePlan; files: string[]; model: EvalSnapshot["model"];
  tools: unknown; business: unknown; measurement: string; dataset?: unknown; settings: Record<string, unknown>;
}): Promise<EvalSnapshot> {
  const paths = [...new Set(["scripts/objective-support.ts", "src/evaluation.ts", "src/eval-capture.ts", "package-lock.json", ...input.files])].sort();
  if (paths.some(path => !/^(?:src|scripts|data|db|prompts|skills)\/[A-Za-z0-9_./-]+$|^package-lock\.json$/.test(path)
    || path.split("/").includes(".."))) throw new Error("评测源码快照路径无效。");
  const [prompt, skill, commit, changes, files] = await Promise.all([
    readFile(new URL("prompts/customer-service.md", root), "utf8"),
    readFile(new URL("skills/shop-support/SKILL.md", root), "utf8"),
    command("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(root) }),
    command("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: fileURLToPath(root) }),
    Promise.all(paths.map(async path => [path, hash(await readFile(new URL(path, root)))] as const)),
  ]);
  return {
    gitCommit: commit.stdout.trim(), gitDirty: Boolean(changes.stdout.trim()), asOf: new Date().toISOString(), model: input.model,
    hashes: { prompt: hash(prompt), skill: hash(skill), tools: hash(input.tools), dataset: hash({ plan: input.plan, dataset: input.dataset ?? null }),
      checker: hash(files.filter(([path]) => path.startsWith("scripts/") || path === "src/evaluation.ts")), business: hash(input.business) },
    content: {
      evaluation: input.plan, dataset: input.dataset ?? null, prompt, skill, tools: input.tools, business: input.business,
      measurement: input.measurement,
      implementation: { hash: hash(files), files: Object.fromEntries(files) },
      runtime: { node: process.version, platform: process.platform, arch: process.arch, icu: process.versions.icu },
      settings: input.settings,
      answerQuality: "not_evaluated",
    },
  };
}

export const noModel: EvalSnapshot["model"] = {
  provider: "none", id: "not-applicable", maxTokens: 0, thinking: "off", temperature: null,
};
