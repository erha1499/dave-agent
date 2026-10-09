import assert from "node:assert/strict";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { createModelRuntime, createQQSession } from "../src/agent.ts";
import { QQAgent } from "../src/qq-agent.ts";
import { sanitizeQQContent } from "../src/qq.ts";
import { confirmMerchantMessage } from "../src/after-sales-entry.ts";
import type { AfterSalesStore } from "../src/after-sales.ts";
import type { RenderedReply } from "../src/reply.ts";

const expectedPrompt = "你是 QQ 通信联调助手。用简洁中文纯文本自然回复用户，每次回复最多 500 字，不输出网址。\n"
  + "当前只验证 QQ 通信和 Agent 工具循环。用户要求回显或测试工具时，调用 echo 并按结果回复。\n"
  + "唯一工具是 echo，它只原样返回文本。不要声称可以查询订单、修改数据或执行系统命令。";
const runtime = await createModelRuntime();
const faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const sessions: Awaited<ReturnType<typeof createQQSession>>[] = [];
const sent: Array<{ target: ReplyTarget; text: string; requesterId?: string }> = [];
const logs: string[] = [];
const create = async () => {
  const session = await createQQSession(runtime, faux.getModel());
  sessions.push(session);
  return session;
};
const send = async (target: ReplyTarget, text: string, _reply?: RenderedReply, requesterId?: string) => { sent.push({ target, text, requesterId }); };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function within(pending: Promise<unknown>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：等待超过 5 秒。`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitBlocked(started: Promise<void>, pending: Promise<void>, label: string) {
  await within(Promise.race([started, pending.then(() => { throw new Error(`${label}：本轮提前结束，未进入阻塞点。`); })]), label);
}
async function observePending(pending: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending.then(() => { throw new Error(`${label}：释放前已提前结束。`); }), new Promise<void>(resolve => {
      timer = setTimeout(resolve, 100);
    })]);
  } finally { clearTimeout(timer); }
}
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

const agent = new QQAgent(async (msg) => {
  assert.equal(msg.senderId, "user_one", "session factory must receive the trusted SDK sender");
  assert.equal(msg.groupOpenid, "group_one");
  assert.equal(msg.rawEventType, "GROUP_AT_MESSAGE_CREATE");
  return create();
}, send, (text) => logs.push(text));
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
  assert.equal(sent.at(-1)?.requesterId, "user_one", "button permissions must use the actual inbound sender");
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
  assert.equal(sent.find(item => item.target.msgId === "other-user")?.requesterId, "user_two", "concurrent users must not share button permissions");
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
  assert.ok(logs.some((text) => text.startsWith("[qq] 回复发送或确认登记失败")));
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

// Actual Pi must settle a noncooperative provider before replacing its session.
const providerStarted = deferred(), providerRelease = deferred(), providerFallback = deferred();
const providerSessions = sessions.length, providerCalls = faux.state.callCount;
let providerSignal: AbortSignal | undefined, providerSettled = false, lateToolStarts = 0;
let providerRecoveryInputs: string[] | undefined;
const noncooperative = new QQAgent(async () => {
  const session = await create();
  session.subscribe(event => { if (event.type === "tool_execution_start") lateToolStarts++; });
  return session;
}, async (target, text) => {
  await send(target, text);
  if (target.msgId === "held-provider") providerFallback.resolve();
}, (text) => logs.push(text), 50);
faux.setResponses([
  async (_context, options) => {
    providerSignal = options?.signal;
    providerStarted.resolve();
    await providerRelease.promise; // Deliberately ignores abort.
    return fauxAssistantMessage(fauxToolCall("echo", { text: "旧供应商迟到工具" }), { stopReason: "toolUse" });
  },
  context => { providerRecoveryInputs = inputs(context); return fauxAssistantMessage("供应商释放后恢复"); },
]);
const heldProvider = noncooperative.handle(message("held-provider", "供应商阻塞测试")).finally(() => { providerSettled = true; });
let providerRetry: Promise<void> | undefined;
try {
  await waitBlocked(providerStarted.promise, heldProvider, "供应商启动");
  await waitBlocked(providerFallback.promise, heldProvider, "供应商超时回执");
  assert.equal(providerSignal?.aborted, true);
  providerRetry = noncooperative.handle(message("held-provider-retry", "供应商恢复测试"));
  await observePending(heldProvider, "忽略取消的供应商");
  assert.equal(providerSettled, false);
  assert.equal(sessions.length, providerSessions + 1);
  assert.equal(faux.state.callCount, providerCalls + 1, "queued retry must not start while the old provider is held");
  assert.deepEqual(sent.filter(item => item.target.msgId === "held-provider").map(item => item.text), ["客服暂时无法处理这条消息，请稍后重试。"]);
  providerRelease.resolve();
  await within(Promise.all([heldProvider, providerRetry]), "供应商释放与恢复");
  assert.equal(sessions.length, providerSessions + 2);
  assert.equal(faux.state.callCount, providerCalls + 2);
  assert.deepEqual(providerRecoveryInputs, ["供应商恢复测试"]);
  assert.equal(lateToolStarts, 0, "aborted provider's late echo tool call must never execute");
  assert.equal(sent.at(-1)?.text, "供应商释放后恢复");
  assert.equal(sent.filter(item => item.target.msgId === "held-provider").length, 1);
  assert.equal(faux.getPendingResponseCount(), 0);
} finally {
  providerRelease.resolve();
  await within(Promise.allSettled([heldProvider, ...(providerRetry ? [providerRetry] : [])]), "供应商清理");
  await within(noncooperative.close(), "供应商会话关闭");
}

// The actual Pi tool executor is held after start. Its fake completion is not a DB rollback check.
const toolStarted = deferred(), toolRelease = deferred(), toolFallback = deferred();
const toolSessions = sessions.length, toolCalls = faux.state.callCount;
let toolSignal: AbortSignal | undefined, toolSettled = false, fakeCompletions = 0;
let toolRecoveryInputs: string[] | undefined;
const executingTool = new QQAgent(async () => {
  const session = await create();
  if (sessions.length === toolSessions + 1) {
    const echo = session.agent.state.tools.find(tool => tool.name === "echo");
    assert.ok(echo);
    echo.execute = async (_id, _params, signal) => {
      toolSignal = signal;
      toolStarted.resolve();
      await toolRelease.promise; // Work that already started can still complete after abort.
      fakeCompletions++;
      return { content: [{ type: "text", text: "已开始工具的迟到结果" }], details: {} };
    };
  }
  return session;
}, async (target, text) => {
  await send(target, text);
  if (target.msgId === "held-tool") toolFallback.resolve();
}, (text) => logs.push(text), 50);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("echo", { text: "工具阻塞测试" }), { stopReason: "toolUse" }),
  context => { toolRecoveryInputs = inputs(context); return fauxAssistantMessage("工具释放后恢复"); },
]);
const heldTool = executingTool.handle(message("held-tool", "已开始工具测试")).finally(() => { toolSettled = true; });
let toolRetry: Promise<void> | undefined;
try {
  await waitBlocked(toolStarted.promise, heldTool, "工具启动");
  await waitBlocked(toolFallback.promise, heldTool, "工具超时回执");
  assert.equal(toolSignal?.aborted, true);
  toolRetry = executingTool.handle(message("held-tool-retry", "工具恢复测试"));
  await observePending(heldTool, "已经开始的工具");
  assert.equal(toolSettled, false);
  assert.equal(fakeCompletions, 0);
  assert.equal(sessions.length, toolSessions + 1);
  assert.equal(faux.state.callCount, toolCalls + 1);
  assert.deepEqual(sent.filter(item => item.target.msgId === "held-tool").map(item => item.text), ["客服暂时无法处理这条消息，请稍后重试。"]);
  toolRelease.resolve();
  await within(Promise.all([heldTool, toolRetry]), "工具释放与恢复");
  assert.equal(fakeCompletions, 1, "abort does not undo an already started fake tool execution");
  assert.equal(sessions.length, toolSessions + 2);
  assert.equal(faux.state.callCount, toolCalls + 2, "aborted tool result must not trigger another old-session provider call");
  assert.deepEqual(toolRecoveryInputs, ["工具恢复测试"]);
  assert.equal(sent.at(-1)?.text, "工具释放后恢复");
  assert.equal(sent.filter(item => item.target.msgId === "held-tool").length, 1, "late tool result must not be sent");
  assert.equal(faux.getPendingResponseCount(), 0);
} finally {
  toolRelease.resolve();
  await within(Promise.allSettled([heldTool, ...(toolRetry ? [toolRetry] : [])]), "工具清理");
  await within(executingTool.close(), "工具会话关闭");
}

// Pi can be idle while a Controller's prompt wrapper is still publishing host context.
const publishStarted = deferred(), publishRelease = deferred(), publishFallback = deferred();
const publishSessions = sessions.length, publishCalls = faux.state.callCount;
let publishSettled = false, hostCompletions = 0, nativeIdle = false;
let publishRecoveryInputs: string[] | undefined;
const publishingHost = new QQAgent(async () => {
  const session = await create();
  if (sessions.length === publishSessions + 1) {
    const nativePrompt = session.prompt.bind(session);
    session.prompt = async (...args) => {
      await nativePrompt(...args);
      nativeIdle = session.isIdle;
      publishStarted.resolve();
      await publishRelease.promise;
      hostCompletions++;
    };
  }
  return session;
}, async (target, text) => {
  await send(target, text);
  if (target.msgId === "held-publish") publishFallback.resolve();
}, (text) => logs.push(text), 50);
faux.setResponses([
  fauxAssistantMessage("旧宿主发布的迟到文本"),
  context => { publishRecoveryInputs = inputs(context); return fauxAssistantMessage("宿主发布释放后恢复"); },
]);
const heldPublish = publishingHost.handle(message("held-publish", "宿主发布阻塞测试")).finally(() => { publishSettled = true; });
let publishRetry: Promise<void> | undefined;
try {
  await waitBlocked(publishStarted.promise, heldPublish, "宿主发布启动");
  assert.equal(nativeIdle, true, "native Pi must be idle before the host publish barrier");
  await waitBlocked(publishFallback.promise, heldPublish, "宿主发布超时回执");
  publishRetry = publishingHost.handle(message("held-publish-retry", "宿主发布恢复测试"));
  await observePending(heldPublish, "Pi idle 后的宿主发布");
  assert.equal(publishSettled, false);
  assert.equal(hostCompletions, 0);
  assert.equal(sessions.length, publishSessions + 1);
  assert.equal(faux.state.callCount, publishCalls + 1, "retry must wait for the complete prompt wrapper, not only Pi abort");
  assert.deepEqual(sent.filter(item => item.target.msgId === "held-publish").map(item => item.text), ["客服暂时无法处理这条消息，请稍后重试。"]);
  publishRelease.resolve();
  await within(Promise.all([heldPublish, publishRetry]), "宿主发布释放与恢复");
  assert.equal(hostCompletions, 1);
  assert.equal(sessions.length, publishSessions + 2);
  assert.equal(faux.state.callCount, publishCalls + 2);
  assert.deepEqual(publishRecoveryInputs, ["宿主发布恢复测试"]);
  assert.equal(sent.at(-1)?.text, "宿主发布释放后恢复");
  assert.equal(sent.filter(item => item.target.msgId === "held-publish").length, 1, "old native text must not be sent after host publication settles");
  assert.equal(faux.getPendingResponseCount(), 0);
} finally {
  publishRelease.resolve();
  await within(Promise.allSettled([heldPublish, ...(publishRetry ? [publishRetry] : [])]), "宿主发布清理");
  await within(publishingHost.close(), "宿主发布会话关闭");
}
console.log("QQ→Pi 取消边界回归通过：3/3 工程控制，超时各一次回执、100ms 内等待旧供应商/工具/宿主发布结束、释放后新会话恢复；假工具完成不代表数据库回滚。");

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

const hostStarted = deferred();
const hostRelease = deferred();
let hostActions = 0;
const hostReceipt = "模拟协商 COUPON-2001 已受理，任务 TEST-TASK，当前处理中，未执行退款。";
const hostAgent = new QQAgent(create, send, (text) => logs.push(text), 1000, async msg => {
  if (msg.content !== "确认联系商家 COUPON-2001 原因：行程变化") return undefined;
  assert.equal(msg.senderId, "user_one");
  assert.equal(msg.groupOpenid, "group_one");
  hostActions++;
  hostStarted.resolve();
  await hostRelease.promise;
  return hostReceipt;
});
try {
  const modelCalls = faux.state.callCount;
  const confirming = hostAgent.handle(message("host-confirm", "确认联系商家 COUPON-2001 原因：行程变化"));
  await hostStarted.promise;
  faux.setResponses([context => {
    assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name), ["echo"]);
    assert.ok(JSON.stringify(context.messages).includes(hostReceipt), "next normal prompt must see the actual host receipt");
    return fauxAssistantMessage("工程检查：按原订单查询持久化任务。");
  }]);
  const querying = hostAgent.handle(message("host-query", "进度如何？"));
  assert.equal(faux.state.callCount, modelCalls, "queued query cannot overtake the trusted host command");
  hostRelease.resolve();
  await Promise.all([confirming, querying]);
  assert.equal(hostActions, 1);
  assert.equal(faux.state.callCount, modelCalls + 1, "host receipt must not trigger a model call");
  assert.deepEqual(sent.filter(item => item.target.msgId?.startsWith("host-")).map(item => item.target.msgId), ["host-confirm", "host-query"]);
  assert.ok(sent.some(item => item.target.msgId === "host-confirm" && item.text === hostReceipt));
  assert.equal(sent.find(item => item.target.msgId === "host-confirm")?.requesterId, "user_one", "host receipts must retain trusted button identity");
  faux.setResponses([context => {
    assert.ok(!JSON.stringify(context.messages).includes(hostReceipt), "host receipts cannot leak to another QQ user");
    return fauxAssistantMessage("独立会话");
  }]);
  await hostAgent.handle(message("independent-host", "进度如何？", "user_two"));
} finally {
  hostRelease.resolve();
  await hostAgent.close();
}
assert.equal(faux.getPendingResponseCount(), 0);

let confirmationWrites = 0;
let confirmationArgumentsValid = true;
const confirmationStore = { request: async (_identity: unknown, _sourceKey: string, orderId: string, reason: string) => {
  confirmationArgumentsValid &&= orderId === "COUPON-2001" && reason === "行程变化";
  confirmationWrites++; throw new Error("synthetic request stop");
} } as unknown as AfterSalesStore;
for (const separator of ["\n", "\r\n", "\u2028"]) {
  const malformed = message("multiline-confirm", `<@!123> 确认联系商家 COUPON-2001${separator}原因：行程变化`);
  const context = { bot: { appId: "123" }, message: malformed } as Parameters<typeof sanitizeQQContent>[0];
  await sanitizeQQContent(context, async () => {});
  assert.match((await confirmMerchantMessage(confirmationStore, { appId: "TEST_APP", senderId: "TEST_USER1" }, "0".repeat(64), malformed.content))!, /完整发送单行确认文字/);
}
assert.equal(confirmationWrites, 0, "SDK sanitization must not turn a multiline message into an executable confirmation");
const merchantCommand = "确认联系商家 COUPON-2001 原因：行程变化";
for (const text of [`\n${merchantCommand}`, `${merchantCommand} \n`, `${merchantCommand}\n\t`,
  `${merchantCommand}\n额外内容`, `${merchantCommand}\u2028`, `${merchantCommand}\u200b`, `${merchantCommand}\u00a0`,
  merchantCommand.replace("商家 ", "商家\t"), merchantCommand.replace("行程变化", "行程\t变化")]) {
  await confirmMerchantMessage(confirmationStore, { appId: "TEST_APP", senderId: "TEST_USER1" }, "0".repeat(64), text);
  const malformed = message("padded-malformed", `<@!123> ${text}`);
  await sanitizeQQContent({ bot: { appId: "123" }, message: malformed } as Parameters<typeof sanitizeQQContent>[0], async () => {});
  await confirmMerchantMessage(confirmationStore, { appId: "TEST_APP", senderId: "TEST_USER1" }, "0".repeat(64), malformed.content);
}
assert.equal(confirmationWrites, 0, "horizontal padding normalization must preserve malformed command rejection");
for (const padding of ["", " ", "\t", " \t "]) {
  const text = `${padding}${merchantCommand}${padding}`;
  await confirmMerchantMessage(confirmationStore, { appId: "TEST_APP", senderId: "TEST_USER1" }, "0".repeat(64), text);
  const validConfirmation = message("valid-confirm", `<@!123> ${text}`);
  await sanitizeQQContent({ bot: { appId: "123" }, message: validConfirmation } as Parameters<typeof sanitizeQQContent>[0], async () => {});
  await confirmMerchantMessage(confirmationStore, { appId: "TEST_APP", senderId: "TEST_USER1" }, "0".repeat(64), validConfirmation.content);
}
assert.equal(confirmationWrites, 8, "exact commands accept outer ASCII space/tab padding before or after QQ mention removal");
assert.equal(confirmationArgumentsValid, true, "padding normalization preserves the exact order and reason");

const originalNow = Date.now;
let simulatedNow = originalNow();
let expiredHostActions = 0;
const expiredSendCount = sent.length;
const expiredModelCalls = faux.state.callCount;
const expiresDuringCreate = new QQAgent(async () => {
  const session = await create();
  simulatedNow += 10_000;
  return session;
}, send, (text) => logs.push(text), 1000, async () => { expiredHostActions++; return "不应执行的确认回执"; });
try {
  Date.now = () => simulatedNow;
  const expiring = message("expires-during-create", "确认联系商家 COUPON-2001 原因：行程变化");
  expiring.timestamp = new Date(simulatedNow - 265_000).toISOString();
  await expiresDuringCreate.handle(expiring);
  assert.equal(expiredHostActions, 0, "a confirmation expiring during session initialization must not write business state");
  assert.equal(faux.state.callCount, expiredModelCalls);
  assert.equal(sent.length, expiredSendCount);
} finally {
  Date.now = originalNow;
  await expiresDuringCreate.close();
}
console.log("QQ→Pi 离线检查通过：工具循环、专用上下文、隔离/队列、宿主确认串行与回执上下文、真实 SDK 清洗后确认边界、初始化期间过期拒绝、可控失败、发送不重试、超时恢复和安全关闭。");
await (await import("./qq-binding-check.ts")).checkQQBinding();

// A caught host/delivery error must remain distinct from a provider failure in the final ledger.
for (const failure of ["session", "host", "send", "receipt"] as const) {
  const diagnostics: string[] = [];
  let sendCount = 0;
  const privateDetail = "synthetic-private-credential-and-message";
  const checked = new QQAgent(async () => {
    if (failure === "session") throw new Error(privateDetail);
    return create();
  }, async () => { sendCount++; if (failure === "send") throw new Error(privateDetail); }, text => diagnostics.push(text), 1000,
  async () => { if (failure === "host") throw new Error(privateDetail); return "当前业务状态已查询，请按订单继续。"; },
  async () => { if (failure === "receipt") throw new Error(privateDetail); });
  try {
    const callsBefore = faux.state.callCount;
    await checked.handle(message(`phase-${failure}`, privateDetail));
    assert.equal(faux.state.callCount, callsBefore, "host handling and its failures need no model call");
    assert.equal(sendCount, 1, "ambiguous delivery must not be retried");
    const summaries = diagnostics.filter(line => line.startsWith("[model-task] ")).map(line => JSON.parse(line.slice(13)));
    assert.equal(summaries.length, 1, "one final redacted ledger per accepted queue item");
    assert.equal(summaries[0].failurePhase, failure);
    assert.equal(summaries[0].failureReason, failure === "send" ? "send_unknown" : failure === "receipt" ? "receipt_unknown" : `${failure}_failed`);
    assert.equal(summaries[0].httpRequests, 0);
    assert.ok(summaries[0].queueMs >= 0);
    assert.doesNotMatch(JSON.stringify(summaries), /synthetic-private|user_one|group_one|phase-session|phase-host/);
    assert.doesNotMatch(diagnostics.join("\n"), /synthetic-private/);
  } finally { await checked.close(); }
}
console.log("QQ 请求记录检查通过：宿主/会话/发送未知/回执未知独立归因，零模型请求与脱敏边界保持。");
