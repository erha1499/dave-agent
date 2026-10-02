import assert from "node:assert/strict";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime, createQQSession } from "../src/agent.ts";
import { QQAgent } from "../src/qq-agent.ts";

const expectedPrompt = "你是 QQ 通信联调助手。用简洁中文纯文本自然回复用户，每次回复最多 500 字，不输出网址。\n"
  + "当前只验证 QQ 通信和 Agent 工具循环。用户要求回显或测试工具时，调用 echo 并按结果回复。\n"
  + "唯一工具是 echo，它只原样返回文本。不要声称可以查询订单、修改数据或执行系统命令。";
const runtime = await createModelRuntime();
const faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const sessions: Awaited<ReturnType<typeof createQQSession>>[] = [];
const sent: Array<{ target: ReplyTarget; text: string }> = [];
const logs: string[] = [];
const create = async () => {
  const session = await createQQSession(runtime, faux.getModel());
  sessions.push(session);
  return session;
};
const send = async (target: ReplyTarget, text: string) => { sent.push({ target, text }); };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
function message(id: string, content: string, senderId = "user_one", groupOpenid = "group_one"): QQBotInboundMessage {
  const timestamp = new Date().toISOString();
  return {
    rawEventType: "GROUP_AT_MESSAGE_CREATE", kind: "group", senderId, groupOpenid,
    messageId: id, content, timestamp,
    replyTarget: { scope: "group", targetId: groupOpenid, msgId: id },
    raw: { id, content, timestamp, group_openid: groupOpenid, author: { member_openid: senderId } },
  };
}
function inputs(context: TranscriptContext) {
  assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
  assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["echo"]);
  return context.messages.filter((item) => item.role === "user").map((item) => {
    if (typeof item.content === "string") return item.content;
    return item.content.map((part) => part.type === "text" ? part.text : "").join("");
  });
}

const agent = new QQAgent(create, send, (text) => logs.push(text));
try {
  faux.setResponses([
    (context, _options, _state, model) => {
      assert.equal(model.maxTokens, 2048);
      assert.deepEqual(inputs(context), ["/skill:shop-support 请回显工具测试"]);
      return fauxAssistantMessage(fauxToolCall("echo", { text: "工具测试" }), { stopReason: "toolUse" });
    },
    (context) => {
      inputs(context);
      const result = context.messages.findLast((item) => item.role === "toolResult");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.toolName, "echo");
      assert.equal(result.isError, false);
      assert.deepEqual(result.content, [{ type: "text", text: "工具测试" }]);
      return fauxAssistantMessage("已回显：工具测试");
    },
  ]);
  await agent.handle(message("echo", "/skill:shop-support 请回显工具测试"));
  assert.equal(sent.at(-1)?.text, "已回显：工具测试");
  assert.ok(logs.some(text => text.includes("tools=echo")), "trace must record the actual successful tool result");
  assert.deepEqual(sessions[0]?.getActiveToolNames(), ["echo"]);
  assert.equal(faux.getPendingResponseCount(), 0);

  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic private service detail" })]);
  await agent.handle(message("failure", "失败测试"));
  assert.equal(sent.at(-1)?.text, "客服暂时无法处理这条消息，请稍后重试。");
  assert.ok(!logs.join("\n").includes("synthetic private service detail"));
  faux.setResponses([(context) => {
    assert.deepEqual(inputs(context), ["恢复测试"]);
    return fauxAssistantMessage("已恢复");
  }]);
  await agent.handle(message("recovery", "恢复测试"));
  assert.equal(sent.at(-1)?.text, "已恢复");
  assert.equal(sessions.length, 2, "failed sessions must be replaced before recovery");
} finally {
  await agent.close();
}
const countAfterClose = sent.length;
await agent.handle(message("after-close", "关闭之后"));
assert.equal(sent.length, countAfterClose);

const started = deferred();
const release = deferred();
const queued = new QQAgent(create, send, (text) => logs.push(text));
const firstContext = ["同会话第一条"];
faux.setResponses([
  async (context) => {
    assert.deepEqual(inputs(context), firstContext);
    started.resolve();
    await release.promise;
    return fauxAssistantMessage("第一条完成");
  },
  ...(Array.from({ length: 2 }, () => (context: TranscriptContext) => {
    const userInputs = inputs(context);
    assert.equal(userInputs.length, 1);
    assert.ok(["另一用户", "另一群"].includes(userInputs[0]!));
    return fauxAssistantMessage(`独立回复：${userInputs[0]}`);
  })),
  (context) => {
    assert.deepEqual(inputs(context), [...firstContext, "同会话第二条"]);
    return fauxAssistantMessage("第二条完成");
  },
  (context) => {
    assert.deepEqual(inputs(context), [...firstContext, "同会话第二条", "同会话第三条"]);
    return fauxAssistantMessage("第三条完成");
  },
]);
try {
  const first = queued.handle(message("first", firstContext[0]!));
  await started.promise;
  const second = queued.handle(message("second", "同会话第二条"));
  const third = queued.handle(message("third", "同会话第三条"));
  await queued.handle(message("fourth", "同会话第四条"));
  assert.equal(sent.at(-1)?.text, "你的消息仍在处理中，请等待回复后再发送。");
  await Promise.all([
    queued.handle(message("other-user", "另一用户", "user_two")),
    queued.handle(message("other-group", "另一群", "user_one", "group_two")),
  ]);
  assert.ok(sent.some((item) => item.target.msgId === "other-user" && item.text === "独立回复：另一用户"));
  assert.ok(sent.some((item) => item.target.msgId === "other-group" && item.text === "独立回复：另一群"));
  assert.ok(!sent.some((item) => item.target.msgId === "first"), "other conversations must complete while first is waiting");
  release.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(sent.filter((item) => ["first", "second", "third"].includes(item.target.msgId!)).map((item) => item.target.msgId), ["first", "second", "third"]);
  assert.equal(faux.getPendingResponseCount(), 0);
} finally {
  release.resolve();
  await queued.close();
}

let sendAttempts = 0;
const failedSend = new QQAgent(create, async () => { sendAttempts++; throw new Error("synthetic send uncertainty"); }, (text) => logs.push(text));
try {
  faux.setResponses([fauxAssistantMessage("只发送一次")]);
  await failedSend.handle(message("send-failure", "发送失败测试"));
  assert.equal(sendAttempts, 1, "ambiguous QQ send must not be retried or replaced with another reply");
  assert.ok(logs.some((text) => text.startsWith("[qq] 回复发送失败")));
  assert.ok(!logs.join("\n").includes("synthetic send uncertainty"));
} finally {
  await failedSend.close();
}

let requestAborted = false;
let timeoutSignal: AbortSignal | undefined;
const timed = new QQAgent(create, async (target, text) => {
  if (target.msgId === "timeout") assert.equal(timeoutSignal?.aborted, true, "cancellation must precede fallback send");
  await send(target, text);
}, (text) => logs.push(text), 100);
try {
  faux.setResponses([async (_context, options) => {
    const signal = options?.signal;
    assert.ok(signal, "real Pi request must expose its cancellation signal");
    timeoutSignal = signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    requestAborted = signal.aborted;
    return fauxAssistantMessage("超时后的迟到文本");
  }]);
  const beforeTimeout = sent.length;
  await timed.handle(message("timeout", "超时测试"));
  assert.equal(requestAborted, true);
  assert.equal(sent.length, beforeTimeout + 1);
  assert.equal(sent.at(-1)?.text, "客服暂时无法处理这条消息，请稍后重试。");
  assert.ok(!sent.some((item) => item.text === "超时后的迟到文本"));
  faux.setResponses([(context) => {
    assert.deepEqual(inputs(context), ["超时恢复"]);
    return fauxAssistantMessage("超时后已恢复");
  }]);
  await timed.handle(message("timeout-recovery", "超时恢复"));
  assert.equal(sent.at(-1)?.text, "超时后已恢复");
} finally {
  await timed.close();
}

const creating = deferred();
const releaseCreate = deferred();
const shutdownSendCount = sent.length;
const shutdownCallCount = faux.state.callCount;
const shuttingDown = new QQAgent(async () => {
  const session = await create();
  creating.resolve();
  await releaseCreate.promise;
  return session;
}, send, (text) => logs.push(text));
try {
  const pending = shuttingDown.handle(message("shutdown-create", "创建会话期间关闭"));
  await creating.promise;
  const closing = shuttingDown.close();
  releaseCreate.resolve();
  await Promise.all([pending, closing]);
  assert.equal(faux.state.callCount, shutdownCallCount, "closing must not start a model request after session creation");
  assert.equal(sent.length, shutdownSendCount, "closing must not send a late reply");
} finally {
  releaseCreate.resolve();
  await shuttingDown.close();
}
assert.equal(faux.getPendingResponseCount(), 0);
console.log("QQ→Pi 离线检查通过：真实 echo 工具循环、精确上下文、群与用户隔离、串行队列、可控失败、发送不重试、超时中止与恢复、安全关闭。");
