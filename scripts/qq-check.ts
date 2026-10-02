import assert from "node:assert/strict";
import { request } from "node:http";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import {
  WebhookTransport, ed25519Sign, verifyWebhookSignature,
  type WebhookRequestHandler, type WebhookServerAdapter,
} from "@tencent-connect/qqbot-nodejs/protocol";
import { readQQConfig } from "../src/qq.ts";
import { validQQMessage } from "../src/qq-agent.ts";
import { QQWebhookServer } from "../src/qq-http.ts";

const credentials = {
  QQBOT_APP_ID: "12345",
  QQBOT_APP_SECRET: "synthetic-test-secret",
  QQ_ALLOWED_GROUPS: "group_one,group_two",
};
assert.equal(readQQConfig(credentials).options.transport, "websocket");
assert.equal(readQQConfig({ ...credentials, NODE_ENV: "production" }).options.transport, "webhook");
for (const transport of ["websocket", "webhook"] as const) {
  const config = readQQConfig({ ...credentials, NODE_ENV: "production", QQ_TRANSPORT: transport });
  assert.equal(config.options.transport, transport);
  assert.equal(config.options.intents, 1 << 25);
  assert.deepEqual(config.allowedGroups, ["group_one", "group_two"]);
}
for (const key of ["QQBOT_APP_ID", "QQBOT_APP_SECRET"] as const) {
  assert.throws(() => readQQConfig({ ...credentials, [key]: "" }));
  const absent: NodeJS.ProcessEnv = { ...credentials };
  delete absent[key];
  assert.throws(() => readQQConfig(absent));
}
assert.throws(() => readQQConfig({ ...credentials, QQ_TRANSPORT: "sse" }));
assert.throws(() => readQQConfig({ ...credentials, QQ_ALLOWED_GROUPS: "*" }));
assert.throws(() => readQQConfig({ ...credentials, QQ_ALLOWED_GROUPS: "group_one,*" }));
for (const port of ["0", "65536", "1.5", "not-a-port"]) {
  assert.throws(() => readQQConfig({ ...credentials, QQ_TRANSPORT: "webhook", QQBOT_WEBHOOK_PORT: port }));
}
for (const path of ["callback", "/callback?query=1", "/callback#fragment"]) {
  assert.throws(() => readQQConfig({ ...credentials, QQ_TRANSPORT: "webhook", QQBOT_WEBHOOK_PATH: path }));
}
const customWebhook = readQQConfig({
  ...credentials, QQ_TRANSPORT: "webhook", QQBOT_WEBHOOK_PORT: "8443", QQBOT_WEBHOOK_PATH: "/qq/callback",
});
assert.equal(customWebhook.options.webhook?.port, 8443);
assert.equal(customWebhook.options.webhook?.path, "/qq/callback");
assert.equal(readQQConfig({ ...credentials, QQBOT_WEBHOOK_PORT: "invalid", QQBOT_WEBHOOK_PATH: "invalid" }).options.webhook, undefined);

const now = Date.parse("2026-10-02T05:00:00Z");
const message: QQBotInboundMessage = {
  rawEventType: "GROUP_AT_MESSAGE_CREATE", kind: "group", senderId: "user_one",
  groupOpenid: "group_one", messageId: "message_one", content: "测试客服", timestamp: new Date(now).toISOString(),
  replyTarget: { scope: "group", targetId: "group_one", msgId: "message_one" },
  raw: {
    id: "message_one", author: { member_openid: "user_one" }, group_openid: "group_one",
    content: "测试客服", timestamp: new Date(now).toISOString(),
  },
};
assert.equal(validQQMessage(message, now), true);
for (const changes of [
  { kind: "c2c" }, { rawEventType: "GROUP_MESSAGE_CREATE" }, { senderId: "" },
  { groupOpenid: "" }, { messageId: "" }, { content: " " }, { content: "字".repeat(5001) },
  { content: undefined }, { timestamp: "invalid" },
  { timestamp: new Date(now - 5 * 60_000 - 1).toISOString() },
  { timestamp: new Date(now + 30_000 + 1).toISOString() },
  { replyTarget: { ...message.replyTarget, scope: "c2c" } },
  { replyTarget: { ...message.replyTarget, targetId: "another_group" } },
  { replyTarget: { ...message.replyTarget, msgId: "another_message" } },
  { replyTarget: undefined },
]) {
  assert.equal(validQQMessage({ ...message, ...changes } as QQBotInboundMessage, now), false,
    `invalid message unexpectedly accepted: ${JSON.stringify(changes)}`);
}

const abort = new AbortController();
let handler: WebhookRequestHandler | undefined;
let signalReady!: () => void;
let releaseWork!: () => void;
const ready = new Promise<void>((resolve) => { signalReady = resolve; });
const work = new Promise<void>((resolve) => { releaseWork = resolve; });
let finished = false;
let closed = false;
const received: unknown[] = [];
const server: WebhookServerAdapter = {
  async listen(port, path, callback) {
    assert.equal(port, 8080);
    assert.equal(path, "/qq/callback");
    handler = callback;
  },
  close() { closed = true; },
};
const transport = new WebhookTransport({
  appId: credentials.QQBOT_APP_ID, appSecret: credentials.QQBOT_APP_SECRET,
  port: 8080, path: "/qq/callback", server, abortSignal: abort.signal,
}, {
  onReady: signalReady,
  onMessage: async (msg) => { received.push(msg); await work; finished = true; },
});
const started = transport.start();
try {
  await ready;
  assert.ok(handler);
  const validation = await handler({
    body: Buffer.from(JSON.stringify({ op: 13, d: { plain_token: "synthetic-challenge", event_ts: "123" } })), headers: {},
  });
  assert.equal(validation.status, 200);
  const challenge = JSON.parse(validation.body);
  assert.equal(challenge.plain_token, "synthetic-challenge");
  assert.ok(verifyWebhookSignature({
    body: Buffer.from(challenge.plain_token), timestamp: "123", signature: challenge.signature,
    botSecret: credentials.QQBOT_APP_SECRET,
  }));
  assert.equal((await handler({ body: Buffer.from("invalid json"), headers: {} })).status, 400);
  const body = Buffer.from(JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: message.raw }));
  assert.equal((await handler({ body, headers: {} })).status, 401);
  const timestamp = String(now / 1000);
  const signature = ed25519Sign(credentials.QQBOT_APP_SECRET, Buffer.concat([Buffer.from(timestamp), body]));
  const headers = { "x-signature-timestamp": timestamp, "x-signature-ed25519": signature };
  assert.equal((await handler({ body: Buffer.concat([body, Buffer.from(" ")]), headers })).status, 401);
  assert.equal(received.length, 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      handler({ body, headers }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Webhook ACK waited for unfinished business handler")), 1000);
      }),
    ]);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { op: 12, d: 0 });
    assert.equal(finished, false);
    assert.equal(received.length, 1);
    assert.equal((received[0] as { senderId: string }).senderId, "user_one");
  } finally {
    clearTimeout(timer);
  }
} finally {
  releaseWork();
  abort.abort();
  await started;
}
assert.equal(closed, true);

// Exercise the real HTTP adapter, including oversized chunked requests without Content-Length.
const bounded = new QQWebhookServer();
const rawBody = Buffer.from('{"text":"测试"}\n');
let handled = 0;
try {
  await bounded.listen(0, "/qq/callback", async (req) => {
    handled++;
    assert.deepEqual(req.body, rawBody);
    return { status: 200, body: '{"ok":true}' };
  });
  const address = bounded.server?.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/qq/callback`)).status, 404);
  assert.equal((await fetch(`${base}/wrong`, { method: "POST", body: rawBody })).status, 404);
  const accepted = await fetch(`${base}/qq/callback`, { method: "POST", body: rawBody });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });
  assert.equal((await fetch(`${base}/qq/callback`, { method: "POST", body: Buffer.alloc(65_537) })).status, 413);
  const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${base}/qq/callback`, { method: "POST" }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.write(Buffer.alloc(32_768));
    req.end(Buffer.alloc(32_769));
  });
  assert.equal(chunkedStatus, 413);
  assert.equal(handled, 1);
} finally {
  bounded.close();
}
console.log("QQ 离线检查通过：双模式配置、群消息输入校验、握手验签、篡改拒绝、快速 ACK、HTTP 请求上限。");
