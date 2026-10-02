import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { QQBot, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { renderReply } from "../src/reply.ts";
import { readQQReplyFormat, sendQQReply } from "../src/qq-reply.ts";

assert.equal(readQQReplyFormat({}), "markdown");
assert.equal(readQQReplyFormat({ QQ_REPLY_FORMAT: " markdown " }), "markdown");
assert.equal(readQQReplyFormat({ QQ_REPLY_FORMAT: "text" }), "text");
for (const invalid of ["html", "Markdown", "0"]) {
  assert.throws(() => readQQReplyFormat({ QQ_REPLY_FORMAT: invalid }), /QQ_REPLY_FORMAT/);
}

// Exercise the installed SDK against localhost. No real credentials, model or QQ API.
let outcome: "success" | "no_id" | "api_error" | "network_error" = "success";
const received: { path: string | undefined; body: Record<string, unknown> }[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (req.url === "/app/getAppAccessToken") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }));
    return;
  }
  received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
  if (outcome === "network_error") { req.socket.destroy(); return; }
  res.setHeader("Content-Type", "application/json");
  res.statusCode = outcome === "api_error" ? 403 : 200;
  res.end(JSON.stringify(outcome === "success" ? { id: "synthetic-reply" }
    : outcome === "api_error" ? { code: 40034025, message: "synthetic API rejection" } : {}));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;
const options = { appId: "12345", appSecret: "synthetic-secret", baseUrl, tokenBaseUrl: baseUrl };
const bot = new QQBot({ ...options, markdownSupport: false });
const markdownBot = new QQBot({ ...options, markdownSupport: true });
const target: ReplyTarget = { scope: "group", targetId: "synthetic-group", msgId: "synthetic-inbound" };
const reply = renderReply({ kind: "answer", text: "这是一条测试答复。" });
assert.notEqual(reply.markdown, reply.text, "transport must receive a rendered template");
try {
  await sendQQReply(bot, target, reply, readQQReplyFormat({}));
  assert.deepEqual(received[0], {
    path: "/v2/groups/synthetic-group/messages",
    body: { msg_id: target.msgId, msg_type: 2, markdown: { content: reply.markdown }, msg_seq: received[0]?.body.msg_seq },
  });
  // Explicit text also overrides the SDK's markdownSupport setting.
  await sendQQReply(markdownBot, target, reply, "text");
  assert.deepEqual(received[1], {
    path: "/v2/groups/synthetic-group/messages",
    body: { msg_id: target.msgId, msg_type: 0, content: reply.text, msg_seq: received[1]?.body.msg_seq },
  });
  for (const { body } of received) {
    assert.ok(Number.isInteger(body.msg_seq) && Number(body.msg_seq) >= 0 && Number(body.msg_seq) < 65_536);
  }
  for (const failure of ["no_id", "api_error", "network_error"] as const) {
    outcome = failure;
    const before = received.length;
    await assert.rejects(sendQQReply(bot, target, reply, "markdown"),
      failure === "no_id" ? /QQ 未返回消息 ID/ : failure === "api_error" ? /API Error/ : /Network error/);
    assert.equal(received.length, before + 1, `${failure}: must not retry or send a text fallback`);
    assert.equal(received.at(-1)?.body.msg_type, 2);
    assert.deepEqual(received.at(-1)?.body.markdown, { content: reply.markdown });
  }
} finally {
  bot.stop();
  markdownBot.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log("QQ 回复检查通过：真实 SDK 固定模板 Markdown、显式纯文本、原群/消息关联、无 ID/API/网络失败不重复发送。");
