import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

export const identityDirectory = fileURLToPath(new URL("../.runtime/qq-identities/", import.meta.url));

// ponytail: local records serve this private test group; use an admin onboarding flow before public service.
export async function recordQQIdentity(appId: string, msg: QQBotInboundMessage) {
  const tag = createHash("sha256").update(JSON.stringify([appId, msg.senderId])).digest("hex");
  await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(`${identityDirectory}${tag}.json`, JSON.stringify({
      appId, senderId: msg.senderId, groupOpenid: msg.groupOpenid, seenAt: new Date().toISOString(),
    }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("无法记录待绑定测试身份。");
  }
  return tag.slice(0, 12);
}
