import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime } from "../src/agent.ts";
import { parseCliInput, runCliPrompt } from "../src/cli.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import type { RefundStore } from "../src/refunds.ts";
import type { AfterSalesStore } from "../src/after-sales.ts";
import { confirmRefundReply } from "../src/refund-entry.ts";
import { confirmMerchantReply } from "../src/after-sales-entry.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { createSupportSession, getSupportHostReceipt } from "../src/support-session.ts";

// Exercise the CLI classification before both real confirmation parsers. Unicode
// padding must never become a valid confirmation through entry-point trimming.
assert.deepEqual(parseCliInput(" \t/exit \t"), { kind: "exit" });
assert.deepEqual(parseCliInput(" \t\u00a0"), { kind: "empty" });
let confirmed = 0;
const refunds = { async confirm() { confirmed++; return {}; } } as unknown as RefundStore;
const merchant = { async request() { confirmed++; return {}; } } as unknown as AfterSalesStore;
const inputIdentity = { appId: "cli-input-app", senderId: "cli-input-user" };
for (const command of ["确认退款 00000000-0000-4000-8000-000000000001", "确认联系商家 COUPON-2001 原因：行程变化"]) {
  for (const padding of ["\u00a0", "\ufeff", "\u200b", "\n"]) {
    for (const raw of [padding + command, command + padding]) {
      const line = parseCliInput(raw); assert.equal(line.kind, "message");
      if (line.kind !== "message") throw new Error("confirmation unexpectedly became a control command");
      await confirmRefundReply(refunds, inputIdentity, "source", line.text);
      await confirmMerchantReply(merchant, inputIdentity, "source", line.text);
      assert.equal(confirmed, 0, "CLI must not normalize malformed user text into business authorization");
    }
  }
}
for (const command of ["确认退款 00000000-0000-4000-8000-000000000001", "确认联系商家 COUPON-2001 原因：行程变化"]) {
  const line = parseCliInput(` \t${command}\t `); assert.equal(line.kind, "message");
  if (line.kind !== "message") throw new Error("confirmation unexpectedly became a control command");
  await confirmRefundReply(refunds, inputIdentity, "source", line.text);
  await confirmMerchantReply(merchant, inputIdentity, "source", line.text);
}
assert.equal(confirmed, 2, "confirmation parsers retain ASCII horizontal-padding compatibility");
console.log("[support-host-entry] CLI preserves raw business input; Unicode/newline wrappers never authorize, ASCII padding remains compatible PASS");

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
