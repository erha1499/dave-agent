import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { readRefundDatabaseConfig } from "../src/refunds.ts";

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const envPath = `${root}.env`;
  const original = await readFile(envPath, "utf8");
  const env = { ...parseEnv(original), ...process.env };
  const password = env.AFTER_SALES_DB_PASSWORD || randomBytes(32).toString("hex");
  const refundPassword = env.REFUND_DB_PASSWORD || randomBytes(32).toString("hex");
  const refundConfig = readRefundDatabaseConfig({ ...env, REFUND_DB_PASSWORD: refundPassword });
  const config = readAfterSalesDatabaseConfig({ ...env, AFTER_SALES_DB_PASSWORD: password });
  const user = String(config.user);
  const database = String(config.database);
  const refundUser = String(refundConfig.user);
  if (user.length > 32 || refundUser.length > 32 || password.includes("\0") || refundPassword.includes("\0")) throw new Error("售后数据库账号或密码格式无效。");
  let updated = original;
  for (const [key, value] of [["AFTER_SALES_DB_PASSWORD", password], ["REFUND_DB_PASSWORD", refundPassword]]) {
    if (!env[key!]) updated = `${updated.replace(new RegExp(`^\\s*${key}\\s*=.*$`, "gm"), "").trimEnd()}\n${key}=${value}\n`;
  }
  if (updated !== original) await writeFile(envPath, updated, { mode: 0o600 });
  await chmod(envPath, 0o600);
  const schema = (await Promise.all(["05-merchant.sql", "06-refunds.sql", "07-merchant-notifications.sql", "08-conversation-state.sql", "09-merchant-references.sql"].map(file =>
    readFile(new URL(`../db/${file}`, import.meta.url), "utf8")))).join("\n").replaceAll("USE dave_agent;", `USE \`${database}\`;`);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const account = `${quote(user)}@'%'`;
  const reads = ["qq_identities", "orders", "order_items", "coupons", "payments", "refunds", "merchant_demo_scenarios"]
    .map(table => `GRANT SELECT ON \`${database}\`.\`${table}\` TO ${account};`).join("\n");
  const refundAccount = `${quote(refundUser)}@'%'`;
  const refundReads = ["qq_identities", "orders", "order_items", "coupons", "payments", "refunds", "merchant_demo_scenarios", "merchant_requests"]
    .map(table => `GRANT SELECT ON \`${database}\`.\`${table}\` TO ${refundAccount};`).join("\n");
  const refundGrants = `CREATE USER IF NOT EXISTS ${refundAccount} IDENTIFIED BY ${quote(refundPassword)};
ALTER USER ${refundAccount} IDENTIFIED BY ${quote(refundPassword)};
REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${refundAccount};
${refundReads}
GRANT SELECT, INSERT, UPDATE ON \`${database}\`.refund_operations TO ${refundAccount};
GRANT INSERT ON \`${database}\`.refunds TO ${refundAccount};
GRANT UPDATE (status, refunded_cents) ON \`${database}\`.orders TO ${refundAccount};
GRANT UPDATE (status) ON \`${database}\`.coupons TO ${refundAccount};`;
  const sql = `${schema}\nSET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';\nCREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${quote(password)};\nALTER USER ${account} IDENTIFIED BY ${quote(password)};\nREVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};\n${reads}\nGRANT SELECT, INSERT, UPDATE ON \`${database}\`.merchant_requests TO ${account};\nGRANT SELECT, INSERT, UPDATE ON \`${database}\`.merchant_notifications TO ${account};\nGRANT SELECT, INSERT, UPDATE ON \`${database}\`.conversation_state TO ${account};\n${refundGrants}\n`;
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4'], {
    cwd: root, input: sql, encoding: "utf8", timeout: 20_000,
  });
  if (result.error || result.status !== 0) throw new Error("售后初始化失败，请检查 Docker MySQL 和本机配置。");
  console.log("演示协商、退款和原会话通知表及两个独立受限账号已就绪；现有订单与 QQ 绑定已保留。");
}

main().catch(() => { console.error("售后初始化失败：检查本机 .env、独立售后账号和 Docker MySQL；没有重置业务数据库。"); process.exitCode = 1; });
