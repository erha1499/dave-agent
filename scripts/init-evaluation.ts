import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { readEvalDatabaseConfig } from "../src/eval-store.ts";

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const envPath = `${root}.env`;
  const original = await readFile(envPath, "utf8");
  const local = parseEnv(original);
  const env = { ...local, ...process.env };
  // Hex keeps generated credentials easy to store locally; no secret is passed in process arguments or printed.
  const password = env.EVAL_DB_PASSWORD || randomBytes(32).toString("hex");
  const config = readEvalDatabaseConfig({ ...env, EVAL_DB_PASSWORD: password });
  const user = String(config.user);
  const database = String(config.database);
  if (user.length > 32 || user === "root" || user === (env.DB_USER || "dave_agent_read")) throw new Error("评测账号必须独立于 root 和业务只读账号。");
  if (password.includes("\0")) throw new Error("评测数据库密码格式无效。");
  if (!env.EVAL_DB_PASSWORD) {
    const withoutEmptyPassword = original.replace(/^\s*EVAL_DB_PASSWORD\s*=.*$/gm, "");
    await writeFile(envPath, `${withoutEmptyPassword.trimEnd()}\nEVAL_DB_PASSWORD=${password}\n`, { mode: 0o600 });
  }
  await chmod(envPath, 0o600);
  const schema = (await readFile(new URL("../db/04-evaluation.sql", import.meta.url), "utf8")).replace("USE dave_agent;", `USE \`${database}\`;`);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const account = `${quote(user)}@'%'`;
  const grants = ["eval_runs", "eval_case_results", "eval_turn_results", "eval_steps"]
    .map(table => `GRANT SELECT, INSERT, UPDATE ON \`${database}\`.\`${table}\` TO ${account};`).join("\n");
  const sql = `${schema}\nSET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\nCREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${quote(password)};\nALTER USER ${account} IDENTIFIED BY ${quote(password)};\nREVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};\n${grants}\n`;
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4'], {
    cwd: root, input: sql, encoding: "utf8", timeout: 20_000,
  });
  if (result.error || result.status !== 0) throw new Error("评测初始化失败；请检查 Docker MySQL 已就绪及本机配置。");
  console.log("评测历史表和专用账号已就绪；现有业务数据及 QQ 绑定已保留。");
}

main().catch(() => { console.error("评测初始化失败：检查本机 .env、独立评测账号和 Docker MySQL；没有重置业务数据库。"); process.exitCode = 1; });
