import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime } from "../src/agent.ts";
import { runCliPrompt } from "../src/cli.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { createSupportSession, getSupportHostReceipt } from "../src/support-session.ts";

// A deterministic host command must still be delivered after Pi retains a
// previous provider error. Both real entry paths use the same Session wrapper.
const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
const identity = { appId: "host-entry-app", senderId: "host-entry-user" };
const store = { async getOrder() { throw new Error("unexpected business query"); }, async searchKnowledge() { throw new Error("unexpected knowledge query"); } } as unknown as CouponStore;
const command = "选择金额基准 00000000-0000-4000-8000-000000000001";
const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic terminal provider failure" });
const cli = await createSupportSession(identity, store, runtime, faux.getModel());
try {
  faux.setResponses([failure()]);
  await assert.rejects(runCliPrompt(cli, "你好", async () => {}), /模型请求失败/);
  assert.ok(cli.agent.state.errorMessage);
  faux.setResponses([]);
  const delivered: string[] = [];
  const reply = await runCliPrompt(cli, command, async text => { delivered.push(text); });
  assert.equal(reply.kind, "notice"); assert.match(delivered[0]!, /选择未生效/);
  assert.equal(getSupportHostReceipt(cli)?.outcome, "rejected");
  assert.equal(faux.getPendingResponseCount(), 0);
} finally { cli.dispose(); }

const groupOpenid = "host-entry-group", delivered: string[] = [];
const qqSession = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid });
const qq = new QQAgent(async () => qqSession, async (_target, text) => { delivered.push(text); }, () => {});
function incoming(id: string, content: string): QQBotInboundMessage {
  return { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: identity.senderId,
    groupOpenid, messageId: id, content, timestamp: new Date().toISOString(),
    replyTarget: { scope: "group", targetId: groupOpenid, msgId: id } } as QQBotInboundMessage;
}
try {
  faux.setResponses([failure()]); await qq.handle(incoming("first", "你好"));
  assert.ok(qqSession.agent.state.errorMessage);
  faux.setResponses([]); await qq.handle(incoming("second", command));
  assert.equal(delivered.length, 2); assert.match(delivered[1]!, /选择未生效/);
  assert.equal(getSupportHostReceipt(qqSession)?.trustedRoute.messageId, "second");
  assert.equal(faux.getPendingResponseCount(), 0);
  console.log("[support-host-entry] CLI and local QQ handler deliver zero-model host receipt after previous model error PASS");
} finally { await qq.close(); }
