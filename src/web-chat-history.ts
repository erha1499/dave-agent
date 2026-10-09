import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QQIdentityBinding } from "./coupon-store.ts";
import type { WebChatMessage, WebChatResult } from "./web-chat.ts";
import type { WebChatSettings } from "./web-chat-settings.ts";
import { renderReply } from "./reply.ts";
import { modelSelections } from "./model-selection.ts";

export class WebChatError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const chatTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
type Conversation = { id: string; owner: string; profile: string; binding: string; customer: string;
  settings: WebChatSettings; model: { provider: string; id: string }; messages: WebChatMessage[];
  createdAt: number; updatedAt: number; turns: number; state: "ready" | "busy" | "interrupted" };
type Lease = { runtime: string; token: string; conversation: string; pid: number; expires: number; busy: number };
const interruptedText = "上次咨询未完成，未收到完整答复。你可以继续提问或新建对话。";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stepsValid = (steps: unknown) => Array.isArray(steps) && steps.length <= 64 && steps.every(step => object(step)
  && typeof step.id === "string" && typeof step.label === "string" && ["running", "done", "error"].includes(String(step.status)));
function messagesValid(value: unknown): value is WebChatMessage[] {
  return Array.isArray(value) && value.length <= 40 && new Set(value.map(message => object(message) ? message.id : undefined)).size === value.length
    && value.every((message, index) => {
    if (!object(message) || Object.keys(message).some(key => !["id", "role", "text", "reply", "steps", "status", "createdAt"].includes(key))
      || typeof message.id !== "string" || typeof message.text !== "string" || message.role !== (index % 2 ? "assistant" : "user")
      || (message.createdAt !== undefined && (typeof message.createdAt !== "string" || !Number.isFinite(Date.parse(message.createdAt))))
      || (message.status !== undefined && !["pending", "interrupted"].includes(String(message.status)))
      || (message.steps !== undefined && !stepsValid(message.steps))) return false;
    if (message.role === "user") return uuid(message.id.replace(/:user$/u, "")) && message.id.endsWith(":user")
      && message.text.length <= 2000 && !!message.text.trim() && message.reply === undefined && message.steps === undefined;
    if (!message.id.endsWith(":assistant") || !uuid(message.id.replace(/:assistant$/u, "")) || message.status === "pending") return false;
    if (value[index - 1]?.id !== message.id.replace(/:assistant$/u, ":user") || value[index - 1]?.status !== message.status) return false;
    if (message.status === "interrupted") return message.reply === undefined;
    if (!object(message.reply) || !["answer", "notice", "order"].includes(String(message.reply.kind)) || typeof message.reply.text !== "string") return false;
    try { return renderReply(message.reply as WebChatMessage["reply"] & {}).text === message.text; } catch { return false; }
  });
}

// Dedicated local history: SQLite owns atomic receipts and owner CAS, never business authorization.
export class WebChatHistory {
  private db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (this.db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("会话记录库损坏。");
      this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, profile TEXT NOT NULL, binding TEXT NOT NULL, customer TEXT NOT NULL,
        settings TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, turns INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'ready');
        CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(owner, profile, updated_at);
        CREATE TABLE IF NOT EXISTS owners (owner TEXT PRIMARY KEY, runtime TEXT NOT NULL, token TEXT NOT NULL,
          conversation TEXT NOT NULL REFERENCES conversations(id), pid INTEGER NOT NULL, expires INTEGER NOT NULL, busy INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (conversation TEXT NOT NULL REFERENCES conversations(id), runtime TEXT NOT NULL,
          request TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, result TEXT,
          PRIMARY KEY(conversation, runtime, request));`);
      if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try { chmodSync(file, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private conversation(id: string): Conversation | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    if (!row) return undefined;
    const saved: Conversation = { id: String(row.id), owner: String(row.owner), profile: String(row.profile), binding: String(row.binding), customer: String(row.customer),
      settings: JSON.parse(String(row.settings)), model: JSON.parse(String(row.model)), messages: JSON.parse(String(row.messages)),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), turns: Number(row.turns), state: row.state as Conversation["state"] };
    if (!uuid(saved.id) || !/^[a-f0-9]{64}$/u.test(saved.owner) || !["demo-a", "demo-b"].includes(saved.profile)
      || !saved.binding || !saved.customer || !object(saved.settings) || Object.keys(saved.settings).sort().join(",") !== "maxTokens,modelSelection,thinkingLevel"
      || !modelSelections.includes(saved.settings.modelSelection)
      || !["off", "high"].includes(saved.settings.thinkingLevel) || ![512, 1024, 2048].includes(saved.settings.maxTokens)
      || !object(saved.model) || Object.keys(saved.model).sort().join(",") !== "id,provider" || typeof saved.model.id !== "string" || typeof saved.model.provider !== "string"
      || !Number.isSafeInteger(saved.turns) || saved.turns < 0 || saved.turns > 20 || !["ready", "busy", "interrupted"].includes(saved.state)
      || !Number.isSafeInteger(saved.createdAt) || !Number.isSafeInteger(saved.updatedAt) || saved.updatedAt < saved.createdAt
      || !messagesValid(saved.messages) || Math.ceil(saved.messages.length / 2) !== saved.turns)
      throw new WebChatError(503, "会话记录无法读取，请检查本机记录存储。");
    const pending = saved.messages.filter(message => message.status === "pending");
    if (saved.state === "busy" ? pending.length !== 1 || saved.messages.at(-1) !== pending[0] || pending[0]!.role !== "user"
      : pending.length !== 0) throw new WebChatError(503, "会话记录状态不一致，请检查本机记录存储。");
    return saved;
  }
  private lease(owner: string): Lease | undefined {
    const row = this.db.prepare("SELECT * FROM owners WHERE owner=?").get(owner);
    return row ? { runtime: String(row.runtime), token: String(row.token), conversation: String(row.conversation),
      pid: Number(row.pid), expires: Number(row.expires), busy: Number(row.busy) } : undefined;
  }
  private interrupt(lease: Lease) {
    const conversation = this.conversation(lease.conversation)!;
    const requests = this.db.prepare("SELECT request FROM requests WHERE conversation=? AND runtime=? AND status='pending'").all(conversation.id, lease.runtime);
    if (requests.length) {
      for (const message of conversation.messages) if (message.status === "pending") message.status = "interrupted";
      conversation.messages.push({ id: `${requests[0]!.request}:assistant`, role: "assistant", text: interruptedText, status: "interrupted", createdAt: new Date().toISOString() });
      this.db.prepare("UPDATE requests SET status='interrupted' WHERE conversation=? AND runtime=? AND status='pending'").run(conversation.id, lease.runtime);
      this.db.prepare("UPDATE conversations SET messages=?,state='interrupted',updated_at=? WHERE id=?")
        .run(JSON.stringify(conversation.messages), Date.now(), conversation.id);
    }
    this.db.prepare("DELETE FROM owners WHERE runtime=?").run(lease.runtime);
    this.db.prepare("DELETE FROM conversations WHERE id=? AND turns=0 AND messages='[]' AND state='ready' AND NOT EXISTS(SELECT 1 FROM requests WHERE conversation=conversations.id) AND NOT EXISTS(SELECT 1 FROM owners WHERE conversation=conversations.id)")
      .run(lease.conversation);
  }
  private recover(owner: string) {
    const lease = this.lease(owner);
    if (!lease) return;
    let dead = false;
    try { process.kill(lease.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (dead || lease.expires <= Date.now()) this.interrupt(lease);
  }
  current(owner: string) {
    return this.transaction(() => { this.recover(owner); return this.lease(owner); });
  }
  active(owner: string, runtime: string, token: string) {
    const lease = this.lease(owner);
    return !!lease && lease.runtime === runtime && lease.token === token && lease.expires > Date.now();
  }
  private expect(owner: string, expected: string | null) {
    this.recover(owner);
    const lease = this.lease(owner);
    if ((lease?.runtime ?? null) !== expected) throw new WebChatError(401, "页面会话已失效，请重新连接。");
    if (lease?.busy) throw new WebChatError(409, "当前消息仍在处理中，请等待回复。");
  }
  activate(owner: string, profile: string, binding: QQIdentityBinding, expected: string | null,
    runtime: string, token: string, settings?: WebChatSettings, model?: Conversation["model"], id?: string) {
    return this.transaction(() => {
      this.expect(owner, expected);
      // Unsubmitted shells carry no server history; never discard a claimed request or the open target.
      for (const row of this.db.prepare("SELECT id FROM conversations WHERE owner=? AND turns=0 AND id<>? AND NOT EXISTS(SELECT 1 FROM requests WHERE conversation=conversations.id)").all(owner, id ?? ""))
        this.conversation(String(row.id));
      this.db.prepare("DELETE FROM owners WHERE owner=?").run(owner);
      this.db.prepare("DELETE FROM conversations WHERE owner=? AND id<>? AND turns=0 AND messages='[]' AND state='ready' AND NOT EXISTS(SELECT 1 FROM requests WHERE conversation=conversations.id) AND NOT EXISTS(SELECT 1 FROM owners WHERE conversation=conversations.id)")
        .run(owner, id ?? "");
      let conversation: Conversation;
      if (id) {
        const saved = this.conversation(id);
        if (!saved || saved.owner !== owner || saved.profile !== profile || saved.binding !== binding.bindingId || saved.customer !== binding.customerId)
          throw new WebChatError(404, "找不到当前客户的会话记录。");
        conversation = saved;
      } else {
        const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE owner=? AND profile=?").get(owner, profile)!.count);
        const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM conversations").get()!.count);
        if (count >= 100 || total >= 1000) throw new WebChatError(429, "会话记录数量已达上限，已有记录仍可查看。");
        const now = Date.now();
        conversation = { id: randomUUID(), owner, profile, binding: binding.bindingId, customer: binding.customerId,
          settings: settings!, model: model!, messages: [], createdAt: now, updatedAt: now, turns: 0, state: "ready" };
        this.db.prepare("INSERT INTO conversations(id,owner,profile,binding,customer,settings,model,messages,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(conversation.id, owner, profile, binding.bindingId, binding.customerId, JSON.stringify(settings), JSON.stringify(model), "[]", now, now);
      }
      this.db.prepare("INSERT OR REPLACE INTO owners VALUES(?,?,?,?,?,?,0)").run(owner, runtime, token, conversation.id, process.pid, Date.now() + 30 * 60_000);
      return conversation;
    });
  }
  read(id: string) { return this.conversation(id); }
  list(owner: string, profile: string, binding: QQIdentityBinding) {
    const lease = this.current(owner);
    return this.db.prepare("SELECT id FROM conversations WHERE owner=? AND profile=? AND binding=? AND customer=? AND turns>0 ORDER BY updated_at DESC,created_at DESC,id DESC")
      .all(owner, profile, binding.bindingId, binding.customerId).map(row => {
        const saved = this.conversation(String(row.id))!;
        const title = saved.messages.find(message => message.role === "user")?.text.trim().slice(0, 60) || "新对话";
        return { id: saved.id, profileId: profile, title, createdAt: new Date(saved.createdAt).toISOString(), updatedAt: new Date(saved.updatedAt).toISOString(),
          turns: saved.turns, status: saved.state === "busy" ? "busy" : saved.turns >= 20 ? "limit" : saved.state,
          current: lease?.conversation === saved.id };
      });
  }
  receipt(conversation: string, runtime: string, request: string) {
    const row = this.db.prepare("SELECT text,status,result FROM requests WHERE conversation=? AND runtime=? AND request=?").get(conversation, runtime, request);
    if (!row) return undefined;
    const result = row.result ? JSON.parse(String(row.result)) as WebChatResult : undefined;
    if (typeof row.text !== "string" || !row.text.trim() || row.text.length > 2000 || !["pending", "completed", "interrupted"].includes(String(row.status))
      || (row.status === "completed" ? !result || result.sessionId !== runtime || result.requestId !== request
        || !["host", "agent"].includes(result.origin) || !Number.isFinite(result.durationMs) || result.durationMs < 0 || !stepsValid(result.steps)
        || !object(result.reply) || !["answer", "notice", "order"].includes(result.reply.kind) || typeof result.reply.text !== "string" : result !== undefined))
      throw new WebChatError(503, "会话回执无法读取，请检查本机记录存储。");
    return { text: row.text, status: String(row.status), result };
  }
  claim(owner: string, runtime: string, token: string, request: string, text: string, timeout: number) {
    return this.transaction(() => {
      this.expect(owner, runtime);
      const lease = this.lease(owner)!;
      if (lease.token !== token) throw new WebChatError(401, "会话已失效，请重新连接。");
      const conversation = this.conversation(lease.conversation)!;
      if (conversation.turns >= 20) throw new WebChatError(429, "本次对话已达 20 轮，请新建对话。已有记录仍可查看。");
      if (this.db.prepare("SELECT 1 FROM requests WHERE conversation=? AND request=?").get(conversation.id, request))
        throw new WebChatError(400, "此请求编号已用于以前的运行会话，请使用新编号继续咨询。");
      this.db.prepare("INSERT INTO requests VALUES(?,?,?,?,'pending',NULL)").run(conversation.id, runtime, request, text);
      conversation.messages.push({ id: `${request}:user`, role: "user", text, status: "pending", createdAt: new Date().toISOString() });
      this.db.prepare("UPDATE conversations SET messages=?,turns=turns+1,state='busy',updated_at=? WHERE id=?")
        .run(JSON.stringify(conversation.messages), Date.now(), conversation.id);
      this.db.prepare("UPDATE owners SET busy=1,expires=? WHERE owner=?").run(Date.now() + timeout + 5000, owner);
      return { ...conversation, turns: conversation.turns + 1 };
    });
  }
  complete(owner: string, runtime: string, token: string, request: string, result: WebChatResult, assistant: WebChatMessage) {
    return this.transaction(() => {
      if (!this.active(owner, runtime, token)) throw new WebChatError(401, "会话已失效，请重新连接。");
      const lease = this.lease(owner)!, saved = this.conversation(lease.conversation)!;
      const receipt = this.receipt(saved.id, runtime, request);
      if (receipt?.status !== "pending") throw new Error("本轮记录状态无效。");
      const user = saved.messages.find(message => message.id === `${request}:user` && message.status === "pending");
      if (!user) throw new Error("本轮原文记录缺失。");
      delete user.status; saved.messages.push(assistant);
      this.db.prepare("UPDATE requests SET status='completed',result=? WHERE conversation=? AND runtime=? AND request=?")
        .run(JSON.stringify(result), saved.id, runtime, request);
      this.db.prepare("UPDATE conversations SET messages=?,state='ready',updated_at=? WHERE id=?").run(JSON.stringify(saved.messages), Date.now(), saved.id);
      this.db.prepare("UPDATE owners SET busy=0,expires=? WHERE owner=?").run(Date.now() + 30 * 60_000, owner);
      return saved.messages;
    });
  }
  release(owner: string, runtime: string) {
    if (this.lease(owner)?.runtime !== runtime) return;
    this.transaction(() => { const lease = this.lease(owner); if (lease?.runtime === runtime) this.interrupt(lease); });
  }
  touch(owner: string, runtime: string) {
    this.db.prepare("UPDATE owners SET expires=? WHERE owner=? AND runtime=? AND busy=0").run(Date.now() + 30 * 60_000, owner, runtime);
  }
  close() { this.db.close(); }
}
