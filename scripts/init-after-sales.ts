import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { readAfterSalesDatabaseConfig } from "../src/after-sales.ts";

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const envPath = `${root}.env`;
  const original = await readFile(envPath, "utf8");
  const env = { ...parseEnv(original), ...process.env };
  const password = env.AFTER_SALES_DB_PASSWORD || randomBytes(32).toString("hex");
  const config = readAfterSalesDatabaseConfig({ ...env, AFTER_SALES_DB_PASSWORD: password });
  const user = String(config.user);
  const database = String(config.database);
  if (user.length > 32 || password.includes("\0")) throw new Error("售后数据库账号或密码格式无效。");
  if (!env.AFTER_SALES_DB_PASSWORD) {
    const withoutEmptyPassword = original.replace(/^\s*AFTER_SALES_DB_PASSWORD\s*=.*$/gm, "");
    await writeFile(envPath, `${withoutEmptyPassword.trimEnd()}\nAFTER_SALES_DB_PASSWORD=${password}\n`, { mode: 0o600 });
  }
  await chmod(envPath, 0o600);
  const schema = (await readFile(new URL("../db/05-merchant.sql", import.meta.url), "utf8")).replace("USE dave_agent;", `USE \`${database}\`;`);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const account = `${quote(user)}@'%'`;
  const reads = ["qq_identities", "orders", "order_items", "coupons", "payments", "refunds", "merchant_demo_scenarios"]
    .map(table => `GRANT SELECT ON \`${database}\`.\`${table}\` TO ${account};`).join("\n");
  const sql = `${schema}\nSET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\nCREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${quote(password)};\nALTER USER ${account} IDENTIFIED BY ${quote(password)};\nREVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};\n${reads}\nGRANT SELECT, INSERT, UPDATE ON \`${database}\`.merchant_requests TO ${account};\n`;
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4'], {
    cwd: root, input: sql, encoding: "utf8", timeout: 20_000,
  });
  if (result.error || result.status !== 0) throw new Error("售后初始化失败，请检查 Docker MySQL 和本机配置。");
  console.log("演示商家协商表、三张独立演示订单和专用受限账号已就绪；现有订单与 QQ 绑定已保留。");
}

main().catch(() => { console.error("售后初始化失败：检查本机 .env、独立售后账号和 Docker MySQL；没有重置业务数据库。"); process.exitCode = 1; });
