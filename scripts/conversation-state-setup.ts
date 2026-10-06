import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { readAfterSalesDatabaseConfig } from "../src/after-sales.ts";

export async function setupConversationState() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const env = { ...parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8")), ...process.env };
  const config = readAfterSalesDatabaseConfig(env), user = String(config.user), database = String(config.database);
  if (user.length > 32) throw new Error("售后数据库账号格式无效。");
  const schema = (await readFile(new URL("../db/08-conversation-state.sql", import.meta.url), "utf8"))
    .replaceAll("USE dave_agent;", `USE \`${database}\`;`);
  // The existing account must already exist. Preserve its password and all other grants.
  const sql = `${schema}\nGRANT SELECT, INSERT, UPDATE ON \`${database}\`.conversation_state TO '${user}'@'%';\n`;
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4'], {
    cwd: root, input: sql, encoding: "utf8", timeout: 20_000,
  });
  if (result.error || result.status !== 0) throw new Error("会话定位表初始化失败，请检查已有售后账号和本机 Docker MySQL。");
  console.log("会话定位表已就绪；仅为已有售后受限账号增加该表 SELECT/INSERT/UPDATE 权限，未修改账号密码、.env 或业务记录。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupConversationState().catch(() => { console.error("会话定位初始化失败：检查本机 .env、已初始化的售后账号和 Docker MySQL。"); process.exitCode = 1; });
}
