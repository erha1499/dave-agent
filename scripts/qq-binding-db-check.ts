import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool } from "mysql2/promise";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { CouponStore, readDatabaseConfig } from "../src/coupon-store.ts";
import { QQAgent } from "../src/qq-agent.ts";

// Every write uses this run's fresh synthetic identity; shared bindings and orders are read-only.
const nonce = randomBytes(8).toString("hex");
const identity = { appId: `BIND_${nonce}`, senderId: `owner_${nonce}` }, group = `binding-${nonce}`;
const scope = `app_id = '${identity.appId}' AND sender_id = '${identity.senderId}'`;
function admin(sql: string) {
  const result = spawnSync("docker", ["compose", "-p", "dave-agent", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("专属绑定夹具准备或清理失败。");
}
const config = readDatabaseConfig();
assert.equal(config.host, "127.0.0.1"); assert.equal(config.port, 13306); assert.equal(config.database, "dave_agent");
const store = new CouponStore(createPool(config));
const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
const sessions: Awaited<ReturnType<typeof createCouponSession>>[] = [], sent: string[] = [];
let accepted = 0, ownsIdentity = false, release!: () => void;
const agent = new QQAgent(async () => {
  const session = await createCouponSession(identity, store, runtime, faux.getModel());
  sessions.push(session); return session;
}, async (_target, text) => { sent.push(text); }, () => {}, 10_000, undefined,
async () => { accepted++; }, { resolveBinding: () => store.resolveBinding(identity) });
function message(content: string): QQBotInboundMessage {
  const id = randomUUID(), timestamp = new Date().toISOString();
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId, groupOpenid: group,
    messageId: id, content, timestamp, replyTarget: { scope: "group", targetId: group, msgId: id },
    raw: { id, content, timestamp, group_openid: group, author: { member_openid: identity.senderId } } };
}
const unbind = () => {
  if (ownsIdentity) { admin(`DELETE FROM qq_identities WHERE ${scope};`); ownsIdentity = false; }
};
const bind = (customer: "customer-demo-1" | "customer-demo-2") => {
  admin(`INSERT INTO qq_identities (app_id,sender_id,customer_id) VALUES ('${identity.appId}','${identity.senderId}','${customer}');`);
  ownsIdentity = true;
};
const toolFacts = (context: TranscriptContext) => context.messages.filter(item => item.role === "toolResult")
  .flatMap(item => typeof item.content === "string" ? [item.content] : item.content.filter(part => part.type === "text").map(part => part.text)).join("\n");
async function turn(question: string, oldFacts: boolean, orderId?: string) {
  const contexts: string[] = [];
  const capture = (context: TranscriptContext) => { contexts.push(toolFacts(context)); };
  faux.setResponses(orderId ? [context => {
    capture(context); return fauxAssistantMessage(fauxToolCall("get_order", { orderId }), { stopReason: "toolUse" });
  }, context => { capture(context); return fauxAssistantMessage(`本轮读取 ${orderId}。`); }]
    : [context => { capture(context); return fauxAssistantMessage("仅解释公开规则。"); }]);
  const count = sent.length;
  await agent.handle(message(question));
  assert.equal(contexts.length, orderId ? 2 : 1); assert.equal(sent.length, count + 1);
  assert.equal(contexts[0]!.includes("COUPON-1001"), oldFacts, "provider input must follow the current binding generation");
  if (orderId) {
    const result = sessions.at(-1)!.messages.findLast(item => item.role === "toolResult");
    assert.ok(result?.role === "toolResult" && !result.isError);
    assert.ok(JSON.stringify(result.content).includes(orderId), "the order fact must come from the real database");
  }
  assert.equal(faux.getPendingResponseCount(), 0);
}
try {
  await store.ping(); assert.equal(await store.resolveBinding(identity), undefined);
  bind("customer-demo-1"); const first = await store.resolveBinding(identity);
  assert.ok(first); assert.match(first.bindingId, /^\d+$/); assert.equal(first.customerId, "customer-demo-1");
  assert.equal(await store.resolveCustomer(identity), first.customerId);
  await turn("查询 COUPON-1001", false, "COUPON-1001");
  await turn("继续解释公开退款规则", true); assert.equal(sessions.length, 1);
  unbind(); assert.equal(await store.resolveBinding(identity), undefined);
  await turn("解释公开退款规则", false); assert.equal(sessions.length, 2);
  bind("customer-demo-1"); const second = await store.resolveBinding(identity);
  assert.ok(second); assert.notEqual(second.bindingId, first.bindingId);
  await turn("查询 COUPON-1001", false, "COUPON-1001"); assert.equal(sessions.length, 3);
  unbind(); bind("customer-demo-1"); const third = await store.resolveBinding(identity);
  assert.ok(third); assert.notEqual(third.bindingId, second.bindingId); assert.equal(third.customerId, second.customerId);
  await turn("继续解释公开规则", false); assert.equal(sessions.length, 4);
  admin(`UPDATE qq_identities SET customer_id = 'customer-demo-2' WHERE ${scope};`);
  assert.deepEqual(await store.resolveBinding(identity), { bindingId: third.bindingId, customerId: "customer-demo-2" });
  await turn("查询 COUPON-1002", false, "COUPON-1002"); assert.equal(sessions.length, 5);
  await assert.rejects(store.getOrder(identity, "COUPON-1001"));
  admin(`UPDATE qq_identities SET customer_id = 'customer-demo-1' WHERE ${scope};`);
  await turn("查询 COUPON-1001", false, "COUPON-1001"); assert.equal(sessions.length, 6);
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
  let blockedContext = "";
  faux.setResponses([async context => {
    blockedContext = toolFacts(context); entered(); await held;
    return fauxAssistantMessage("旧私有订单 COUPON-1001 的回答。");
  }]);
  const sendsBefore = sent.length, acceptedBefore = accepted, pending = agent.handle(message("等我核对一下"));
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, pending.then(() => { throw new Error("未进入预期模型阻塞点。"); }),
      new Promise<never>((_resolve, reject) => { startupTimer = setTimeout(() => reject(new Error("阻塞点启动超时。")), 15_000); })]);
    clearTimeout(startupTimer); assert.ok(blockedContext.includes("COUPON-1001")); unbind(); release(); await pending;
    assert.equal(sent.length, sendsBefore, "a revoked in-flight answer must not be sent");
    assert.equal(accepted, acceptedBefore, "a refused answer must not run the delivery hook");
  } finally { clearTimeout(startupTimer); release(); }
  bind("customer-demo-2");
  await turn("查询 COUPON-1002", false, "COUPON-1002"); assert.equal(sessions.length, 7);
  console.log(JSON.stringify({ result: "PASS", scenarios: 8, sessions: sessions.length, localFauxProviderCalls: faux.state.callCount,
    database: "real MySQL; fresh synthetic app/sender only", remoteModel: 0, realQQ: 0 }));
} finally {
  release?.();
  // Remove the owned binding before lifecycle waits, so a hung close cannot retain the fixture.
  try { unbind(); assert.equal(await store.resolveBinding(identity), undefined); }
  finally { try { await agent.close(); } finally { await store.close(); } }
}
