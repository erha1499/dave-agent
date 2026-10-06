import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { readAfterSalesDatabaseConfig } from "../src/after-sales.ts";

export async function setupMerchantReferences() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const env = { ...parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8")), ...process.env };
  const config = readAfterSalesDatabaseConfig(env), database = String(config.database);
  const schema = (await readFile(new URL("../db/09-merchant-references.sql", import.meta.url), "utf8"))
    .replaceAll("USE dave_agent;", `USE \`${database}\`;`);
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4'], {
    cwd: root, input: schema, encoding: "utf8", timeout: 20_000,
  });
  if (result.error || result.status !== 0) throw new Error("任务引用迁移失败，请检查已有售后表和本机 Docker MySQL。");
  console.log("任务引用字段及索引已就绪；旧记录不回填，未修改账号、.env、订单或通知状态。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupMerchantReferences().catch(() => { console.error("任务引用迁移失败：检查本机 .env、已初始化售后表和 Docker MySQL。"); process.exitCode = 1; });
}
