import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { renderReply, type Reply, type RenderedReply } from "./reply.ts";
import { replyFromTools } from "./reply-from-tools.ts";

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

  constructor(
    createSession: (msg: QQBotInboundMessage) => Promise<AgentSession>,
    send: (target: ReplyTarget, text: string, reply: RenderedReply, requesterId: string) => Promise<unknown>,
    log: (text: string) => void = console.log,
    timeoutMs = 60_000,
    beforePrompt?: (msg: QQBotInboundMessage) => Promise<string | Reply | undefined>,
  ) {
    this.createSession = createSession;
    this.send = send;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.beforePrompt = beforePrompt;
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
    if (this.closed || !validQQMessage(msg)) return;
    this.prune();
    const key = JSON.stringify([msg.groupOpenid, msg.senderId]);
    let entry = this.conversations.get(key);
    if (!entry) {
      // ponytail: 20 in-memory conversations cover a test group; persist sessions before production recovery.
      if (this.conversations.size >= 20) {
        await this.deliver(msg, "当前接待人数较多，请稍后再试。");
        return;
      }
      entry = { tail: Promise.resolve(), pending: 0, turns: 0, touched: Date.now() };
      this.conversations.set(key, entry);
    }
    if (entry.pending >= 3) {
      await this.deliver(msg, "你的消息仍在处理中，请等待回复后再发送。");
      return;
    }
    entry.pending++;
    const conversation = entry;
    const task = entry.tail.then(async () => {
      if (this.closed || !validQQMessage(msg)) return;
      const started = Date.now();
      const tag = createHash("sha256").update(key).digest("hex").slice(0, 12);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let aborting: Promise<void> | undefined;
      let failed = false;
      try {
        // ponytail: restart after 20 turns instead of coding-specific compaction; add business summaries for long chats.
        if (conversation.turns >= 20) {
          conversation.session?.dispose();
          conversation.session = undefined;
          conversation.turns = 0;
        }
        conversation.session ??= await this.createSession(msg);
        if (this.closed || !validQQMessage(msg)) return;
        const session = conversation.session;
        // Only trusted ingress text reaches this host action. Tools cannot invent consent.
        const hostReply = await this.beforePrompt?.(msg);
        if (hostReply !== undefined) {
          const delivered = await this.deliver(msg, hostReply);
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
        await Promise.race([
          session.prompt(msg.content, { expandPromptTemplates: false }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("模型处理超时")), this.timeoutMs);
          }),
        ]);
        clearTimeout(timer);
        if (session.agent.state.errorMessage) throw new Error("模型请求失败");
        const text = session.getLastAssistantText()?.trim();
        if (!text) throw new Error("模型未生成回复");
        conversation.turns++;
        const results = session.messages.slice(previousMessageCount).flatMap(message =>
          message.role === "toolResult" && session.getActiveToolNames().includes(message.toolName) ? [message] : []);
        const delivered = await this.deliver(msg, replyFromTools(text, results));
        const tools = results.filter(result => !result.isError).map(result => result.toolName);
        const toolErrors = results.filter(result => result.isError).map(result => result.toolName);
        this.log(`[agent] session=${tag} model_ok tools=${tools.join(",") || "none"} tool_errors=${toolErrors.join(",") || "none"} reply_sent=${delivered} duration_ms=${Date.now() - started}`);
      } catch {
        failed = true;
        clearTimeout(timer);
        // Signal cancellation before waiting on QQ's network send.
        aborting = conversation.session?.abort();
        this.log(`[agent] session=${tag} model_failed duration_ms=${Date.now() - started}`);
        await this.deliver(msg, "客服暂时无法处理这条消息，请稍后重试。");
      } finally {
        clearTimeout(timer);
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
  }

  private async deliver(msg: QQBotInboundMessage, reply: string | Reply): Promise<boolean> {
    if (this.closed || !validQQMessage(msg)) return false;
    try {
      const rendered = renderReply(typeof reply === "string" ? { kind: "notice", text: reply } : reply);
      await this.send(msg.replyTarget, rendered.text, rendered, msg.senderId);
      return true;
    } catch {
      // Do not blindly retry an ambiguous send: QQ may already have accepted it.
      this.log("[qq] 回复发送失败，请检查机器人权限、出口 IP 和网络。");
      return false;
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    await Promise.all([...this.conversations.values()].map(async (entry) => {
      await entry.session?.abort();
      await entry.tail;
      entry.session?.dispose();
    }));
    this.conversations.clear();
  }
}
