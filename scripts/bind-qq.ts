import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identityDirectory } from "../src/qq-identity.ts";

async function main() {
  const [tag, customerId, extra] = process.argv.slice(2);
  if (!tag || !/^[a-f0-9]{12}$/.test(tag) || !customerId || !/^[a-z0-9-]{1,64}$/.test(customerId) || extra) {
    throw new Error("用法：npm run qq:bind -- <日志中的12位identity代号> <模拟客户ID>");
  }
  const names = (await readdir(identityDirectory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && name.startsWith(tag));
  if (names.length !== 1) throw new Error("身份代号未找到或不唯一；请先在白名单群中真实 @机器人。");
  const identity: unknown = JSON.parse(await readFile(`${identityDirectory}${names[0]}`, "utf8"));
  if (!identity || typeof identity !== "object") throw new Error("测试身份记录无效。");
  const { appId, senderId, groupOpenid } = identity as Record<string, unknown>;
  const groups = (process.env.QQ_ALLOWED_GROUPS ?? "").split(",").map(text => text.trim());
  if (typeof appId !== "string" || !/^\d{1,32}$/.test(appId) || appId !== process.env.QQBOT_APP_ID
    || typeof senderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(senderId)
    || typeof groupOpenid !== "string" || !groups.includes(groupOpenid)) throw new Error("身份不属于当前机器人和白名单测试群。");
  // All SQL literals above are restricted to digits/alphanumerics/hyphens; the model never runs this administrator script.
  // Existing bindings cannot be reassigned by repeating this command.
  const sql = `START TRANSACTION;
INSERT INTO qq_identities (app_id, sender_id, customer_id)
SELECT '${appId}', '${senderId}', id FROM customers
WHERE id = '${customerId}' AND NOT EXISTS (SELECT 1 FROM qq_identities WHERE app_id = '${appId}' AND sender_id = '${senderId}');
SELECT customer_id FROM qq_identities WHERE app_id = '${appId}' AND sender_id = '${senderId}';
COMMIT;`;
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("绑定失败，请检查本机 Docker 数据库和客户记录。");
  if (result.stdout.trim() !== customerId) throw new Error("客户不存在或该身份已绑定其他客户；未更改已有绑定。");
  console.log(`已将测试身份 ${tag} 绑定到 ${customerId}，无需重启 QQ 会话。`);
}

main().catch(() => { console.error("QQ 模拟身份绑定失败：检查参数、可信事件记录及数据库；已有绑定不会被覆盖。"); process.exitCode = 1; });
