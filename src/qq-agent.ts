import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { renderReply, type Reply, type RenderedReply } from "./reply.ts";
import { replyFromTools } from "./reply-from-tools.ts";
import type { MerchantTask } from "./after-sales.ts";
import { cancelSupportTurn, isSupportSession, prepareSupportPrompt, supportReply } from "./support-session.ts";

export type ContinuationOutcome = "busy" | "sent" | "deferred" | "unknown";

export function validQQMessage(msg: QQBotInboundMessage, now = Date.now()) {
  if (msg.kind !== "group" || msg.rawEventType !== "GROUP_AT_MESSAGE_CREATE"
    || typeof msg.senderId !== "string" || !msg.senderId || msg.senderId.length > 128
    || typeof msg.groupOpenid !== "string" || !msg.groupOpenid || msg.groupOpenid.length > 128
    || typeof msg.messageId !== "string" || !msg.messageId || msg.messageId.length > 512
    || msg.replyTarget?.scope !== "group" || msg.replyTarget.targetId !== msg.groupOpenid
    || msg.replyTarget.msgId !== msg.messageId
    || typeof msg.content !== "string" || !msg.content.trim() || msg.content.length > 5000
    || typeof msg.timestamp !== "string") return false;
  const age = now - Date.parse(msg.timestamp);
  return Number.isFinite(age) && age >= -30_000 && age < 5 * 60_000 - 30_000;
}

type Conversation = { session?: AgentSession; tail: Promise<void>; pending: number; turns: number; touched: number };

export class QQAgent {
  private conversations = new Map<string, Conversation>();
  private closed = false;
  private sweep = setInterval(() => this.prune(), 5 * 60_000).unref();
  private createSession: (msg: QQBotInboundMessage) => Promise<AgentSession>;
  private send: (target: ReplyTarget, text: string, reply: RenderedReply, requesterId: string) => Promise<unknown>;
  private log: (text: string) => void;
  private timeoutMs: number;
  private beforePrompt?: (msg: QQBotInboundMessage) => Promise<string | Reply | undefined>;
  private afterDeliver?: (msg: QQBotInboundMessage, reply: Reply) => Promise<void>;
  private merchantEvents: "model" | "host";

  constructor(
    createSession: (msg: QQBotInboundMessage) => Promise<AgentSession>,
    send: (target: ReplyTarget, text: string, reply: RenderedReply, requesterId: string) => Promise<unknown>,
    log: (text: string) => void = console.log,
    timeoutMs = 60_000,
    beforePrompt?: (msg: QQBotInboundMessage) => Promise<string | Reply | undefined>,
    afterDeliver?: (msg: QQBotInboundMessage, reply: Reply) => Promise<void>,
    options: { merchantEvents?: "model" | "host" } = {},
  ) {
    this.createSession = createSession;
    this.send = send;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.beforePrompt = beforePrompt;
    this.afterDeliver = afterDeliver;
    this.merchantEvents = options.merchantEvents ?? "model";
  }

  private prune() {
    for (const [key, entry] of this.conversations) {
      if (!entry.pending && Date.now() - entry.touched >= 30 * 60_000) {
        entry.session?.dispose();
        this.conversations.delete(key);
      }
    }
  }

  async handle(msg: QQBotInboundMessage) {
    await this.enqueue(msg);
  }

  // Only the host supplies this resolver; business events never enter the user-confirmation hook.
  async resumeMerchant(msg: QQBotInboundMessage, resolve: () => Promise<MerchantTask | undefined>): Promise<ContinuationOutcome> {
    return this.enqueue(msg, resolve);
  }

  private async enqueue(msg: QQBotInboundMessage, resolve?: () => Promise<MerchantTask | undefined>): Promise<ContinuationOutcome> {
    if (this.closed || !validQQMessage(msg)) return "deferred";
    this.prune();
    const key = JSON.stringify([msg.groupOpenid, msg.senderId]);
    let entry = this.conversations.get(key);
    if (!entry) {
      // ponytail: 20 in-memory conversations cover a test group; persist sessions before production recovery.
      if (this.conversations.size >= 20) {
        if (resolve) return "busy";
        await this.deliver(msg, "当前接待人数较多，请稍后再试。");
        return "busy";
      }
      entry = { tail: Promise.resolve(), pending: 0, turns: 0, touched: Date.now() };
      this.conversations.set(key, entry);
    }
    if (entry.pending >= 3) {
      if (resolve) return "busy";
      await this.deliver(msg, "你的消息仍在处理中，请等待回复后再发送。");
      return "busy";
    }
    entry.pending++;
    const conversation = entry;
    let outcome: ContinuationOutcome = "deferred";
    const task = entry.tail.then(async () => {
      if (this.closed || !validQQMessage(msg)) return;
      const started = Date.now();
      const tag = createHash("sha256").update(key).digest("hex").slice(0, 12);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let aborting: Promise<void> | undefined;
      let failed = false;
      let merchant: MerchantTask | undefined;
      let activeTools: string[] | undefined;
      let supportRun = false;
      try {
        if (resolve) {
          merchant = await resolve();
          if (!merchant || merchant.status === "pending") return;
        }
        // ponytail: restart after 20 turns instead of coding-specific compaction; add business summaries for long chats.
        if (conversation.turns >= 20) {
          conversation.session?.dispose();
          conversation.session = undefined;
          conversation.turns = 0;
        }
        conversation.session ??= await this.createSession(msg);
        if (this.closed || !validQQMessage(msg)) return;
        const session = conversation.session;
        if (merchant && this.merchantEvents === "host") {
          const reply: Reply = { kind: "merchant_status", task: merchant };
          const delivered = await this.deliver(msg, reply);
          outcome = delivered ? "sent" : "unknown";
          conversation.turns++;
          // A business event records a fact, never user consent or a new order selection.
          await session.sendCustomMessage({ customType: "merchant-result", content: renderReply(reply).text, display: true }, { triggerTurn: false });
          this.log(`[agent] session=${tag} host_event reply_sent=${delivered} duration_ms=${Date.now() - started}`);
          return;
        }
        // Only trusted ingress text reaches this host action. Tools cannot invent consent.
        const hostReply = resolve ? undefined : await this.beforePrompt?.(msg);
        if (hostReply !== undefined) {
          const delivered = await this.deliver(msg, hostReply);
          outcome = delivered ? "sent" : "unknown";
          conversation.turns++;
          try {
            // Remember the receipt without triggering another model turn; the next normal prompt uses the business system prompt.
            await session.sendCustomMessage({ customType: "merchant-receipt", content: typeof hostReply === "string" ? hostReply : renderReply(hostReply).text, display: true }, { triggerTurn: false });
          } catch {
            this.log("[agent] 业务回执未加入会话，可按订单号重新查询持久化结果。");
          }
          this.log(`[agent] session=${tag} host_reply sent=${delivered} duration_ms=${Date.now() - started}`);
          return;
        }
        const previousMessageCount = session.messages.length;
        if (merchant) {
          // A result notification can read its task, but cannot prepare another action from conversation history.
          activeTools = session.getActiveToolNames();
          session.setActiveToolsByName(activeTools.filter(name => name === "get_merchant_request"));
        }
        const prompt = merchant
          ? `宿主业务事件：模拟商家任务 ${merchant.taskId}（订单 ${merchant.orderId}）已结束。这不是用户消息，也不是用户授权。请调用 get_merchant_request 查询该订单的当前结果，只通知这一任务的结果，说明下一步需用户提出请求并确认。不得确认、创建协商或准备/执行退款，不得用对话中的其他订单替代。`
          : msg.content;
        supportRun = isSupportSession(session);
        if (supportRun) prepareSupportPrompt(session, {
          requestId: msg.messageId, groupOpenid: msg.groupOpenid!, messageId: msg.messageId,
        });
        await Promise.race([
          session.prompt(prompt, { expandPromptTemplates: false }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("模型处理超时")), this.timeoutMs);
          }),
        ]);
        clearTimeout(timer);
        if (session.agent.state.errorMessage) throw new Error("模型请求失败");
        const text = session.getLastAssistantText()?.trim();
        if (!text && !supportRun) throw new Error("模型未生成回复");
        conversation.turns++;
        const results = session.messages.slice(previousMessageCount).flatMap(message =>
          message.role === "toolResult" && session.getActiveToolNames().includes(message.toolName) ? [message] : []);
        // The host reloaded this exact task after dequeue; a model cannot redirect a notification to another order.
        const reply: Reply = merchant ? { kind: "merchant_status", task: merchant }
          : supportReply(session, text) ?? replyFromTools(text!, results);
        if (!validQQMessage(msg) || this.closed) return;
        const delivered = await this.deliver(msg, reply);
        outcome = delivered ? "sent" : "unknown";
        if (merchant) {
          await session.sendCustomMessage({ customType: "merchant-result", content: renderReply(reply).text, display: true }, { triggerTurn: false });
        }
        const tools = results.filter(result => !result.isError).map(result => result.toolName);
        const toolErrors = results.filter(result => result.isError).map(result => result.toolName);
        this.log(`[agent] session=${tag} ${merchant ? "merchant_event" : "model_ok"} tools=${tools.join(",") || "none"} tool_errors=${toolErrors.join(",") || "none"} reply_sent=${delivered} duration_ms=${Date.now() - started}`);
      } catch {
        failed = true;
        clearTimeout(timer);
        if (conversation.session) cancelSupportTurn(conversation.session);
        // Signal cancellation before waiting on QQ's network send.
        aborting = conversation.session?.abort();
        this.log(`[agent] session=${tag} model_failed duration_ms=${Date.now() - started}`);
        if (!resolve || merchant) {
          // Known durable business facts remain usable when the model fails. Never retry an attempted send.
          if (outcome === "deferred" && validQQMessage(msg) && !this.closed) {
            const delivered = await this.deliver(msg, merchant ? { kind: "merchant_status", task: merchant }
              : supportRun && conversation.session ? supportReply(conversation.session)!
              : "客服暂时无法处理这条消息，请稍后重试。");
            outcome = delivered ? "sent" : "unknown";
          }
        }
      } finally {
        clearTimeout(timer);
        if (activeTools && conversation.session && !failed) conversation.session.setActiveToolsByName(activeTools);
        if (failed && conversation.session) {
          try { await aborting; } finally {
            conversation.session.dispose();
            conversation.session = undefined;
            conversation.turns = 0;
          }
        }
      }
    }).finally(() => {
      conversation.pending--;
      conversation.touched = Date.now();
    });
    // Keep a failed task from poisoning the next turn, while reporting only a controlled diagnostic.
    entry.tail = task.catch(() => { this.log("[agent] 会话处理失败"); });
    await entry.tail;
    return outcome;
  }

  private async deliver(msg: QQBotInboundMessage, reply: string | Reply): Promise<boolean> {
    if (this.closed || !validQQMessage(msg)) return false;
    try {
      const structured: Reply = typeof reply === "string" ? { kind: "notice", text: reply } : reply;
      const rendered = renderReply(structured);
      await this.send(msg.replyTarget, rendered.text, rendered, msg.senderId);
      // A refund proposal becomes confirmable only after the platform accepts this exact summary.
      await this.afterDeliver?.(msg, structured);
      return true;
    } catch {
      // Do not blindly retry an ambiguous send: QQ may already have accepted it.
      this.log("[qq] 回复发送或确认登记失败，请查询状态后重试；未自动重发。");
      return false;
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    await Promise.all([...this.conversations.values()].map(async (entry) => {
      if (entry.session) cancelSupportTurn(entry.session);
      await entry.session?.abort();
      await entry.tail;
      entry.session?.dispose();
    }));
    this.conversations.clear();
  }
}
