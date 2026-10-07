import { randomBytes, randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";
import { createArrivalConsultation } from "./arrival-consultation.ts";
import { runCliPrompt } from "./cli.ts";
import { renderReply, type Reply } from "./reply.ts";
import { createWebChatSettingsCatalog, validateWebChatSettings, type WebChatSettings, type WebChatSettingsCatalog } from "./web-chat-settings.ts";

export const webChatProfiles = [
  { id: "demo-a", label: "客户 A", orderHints: ["COUPON-1001"], examples: ["查询我的订单 COUPON-1001", "团购券需要预约吗？", "查询到账 银行卡"] },
  { id: "demo-b", label: "客户 B", orderHints: ["COUPON-1002"], examples: ["查询我的订单 COUPON-1002", "团购券需要预约吗？", "查询到账 电子钱包"] },
] as const;
const identities: Record<string, QQIdentity> = {
  "demo-a": { appId: "TEST_APP", senderId: "TEST_USER1" },
  "demo-b": { appId: "TEST_APP", senderId: "TEST_USER2" },
};
type ReadReply = Extract<Reply, { kind: "answer" | "notice" | "order" }>;
export type WebChatMessage = { id: string; role: "user" | "assistant"; text: string; reply?: ReadReply };
type PublicSession = { id: string; profileId: string; label: string; settings: WebChatSettings; model: { provider: string; id: string } };
export type WebChatResult = { sessionId: string; requestId: string; reply: ReadReply; durationMs: number; origin: "host" | "agent" };
type Entry = { public: PublicSession; identity: QQIdentity; messages: WebChatMessage[]; touched: number;
  agent?: AgentSession; busy: boolean; active: boolean; abort?: AbortController;
  requests: Map<string, { text: string; result?: WebChatResult }>; turns: number };

export class WebChatError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class WebChatSessions {
  private entries = new Map<string, Entry>();
  private closed = false;
  private store: Pick<CouponStore, "getOrder">;
  private createAgent: (identity: QQIdentity, id: string, settings: WebChatSettings) => Promise<AgentSession>;
  private timeoutMs: number;
  private catalog: Promise<WebChatSettingsCatalog>;
  constructor(store: Pick<CouponStore, "getOrder">, createAgent: (identity: QQIdentity, id: string, settings: WebChatSettings) => Promise<AgentSession>,
    timeoutMs = 60_000, catalog: Promise<WebChatSettingsCatalog> = createWebChatSettingsCatalog()) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("网页处理超时无效。");
    this.store = store; this.createAgent = createAgent; this.timeoutMs = timeoutMs; this.catalog = catalog;
  }
  private invalidate(token: string, entry: Entry) {
    this.entries.delete(token); entry.active = false; entry.abort?.abort();
    if (entry.agent) { void entry.agent.abort().catch(() => {}); entry.agent.dispose(); entry.agent = undefined; }
  }
  private prune() {
    for (const [token, entry] of this.entries) if (!entry.busy && Date.now() - entry.touched >= 30 * 60_000) this.invalidate(token, entry);
  }
  private find(token: string | undefined) {
    this.prune();
    const entry = token ? this.entries.get(token) : undefined;
    if (entry && !this.closed) { entry.touched = Date.now(); return entry; }
    return undefined;
  }
  get(token: string | undefined) {
    const entry = this.find(token);
    return entry ? structuredClone({ session: entry.public, messages: entry.messages }) : { session: null, messages: [] };
  }
  async config() {
    const { metadata: _metadata, ...settings } = await this.catalog;
    return { version: 2, simulation: true, readOnly: true, profiles: webChatProfiles, limits: { messageCharacters: 2000 }, ...structuredClone(settings) };
  }
  async create(token: string | undefined, profileId: string, input?: unknown) {
    if (this.closed) throw new WebChatError(503, "客服服务已停止。");
    const profile = webChatProfiles.find(row => row.id === profileId);
    if (!profile) throw new WebChatError(400, "请选择有效的客户。");
    const catalog = await this.catalog;
    if (this.closed) throw new WebChatError(503, "客服服务已停止。");
    let settings: WebChatSettings;
    try { settings = validateWebChatSettings(input, catalog); }
    catch (error) { throw new WebChatError(400, error instanceof Error ? error.message : "模型设置无效。"); }
    const model = catalog.models.find(row => row.id === settings.modelSelection)!;
    const previous = this.find(token);
    if (previous?.busy) throw new WebChatError(409, "当前消息仍在处理中，请等待后再新建对话。");
    // ponytail: 20 ephemeral local demo sessions; require login/persistence before public or long-lived use.
    if (!previous && this.entries.size >= 20) throw new WebChatError(429, "当前会话数量已达上限，请稍后重试。");
    if (previous) this.invalidate(token!, previous);
    const capability = randomBytes(32).toString("base64url");
    const entry: Entry = { public: { id: randomUUID(), profileId, label: profile.label, settings, model: { provider: model.provider, id: model.modelId } }, identity: { ...identities[profileId]! },
      messages: [], touched: Date.now(), busy: false, active: true, requests: new Map(), turns: 0 };
    this.entries.set(capability, entry);
    return { token: capability, ...structuredClone({ session: entry.public, messages: entry.messages }) };
  }
  async send(token: string | undefined, requestId: string, text: string): Promise<WebChatResult> {
    if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(requestId)
      || typeof text !== "string" || !text.trim() || text.length > 2000) throw new WebChatError(400, "消息须为 1..2000 字及有效的 UUID 请求编号。");
    const entry = this.find(token);
    if (!entry) throw new WebChatError(401, "会话已失效，请新建对话。");
    const previous = entry.requests.get(requestId);
    if (previous && previous.text !== text) throw new WebChatError(400, "同一请求编号不能用于不同原文。");
    if (previous?.result) return structuredClone(previous.result);
    if (entry.busy) throw new WebChatError(409, "消息仍在处理中，请等待回复。");
    if (entry.turns >= 20) throw new WebChatError(429, "本次对话已达 20 轮，请新建对话。");
    entry.busy = true; entry.turns++; entry.requests.set(requestId, { text });
    const abort = new AbortController(); entry.abort = abort;
    const assertActive = () => { if (!entry.active || abort.signal.aborted) throw new Error("网页会话已失效"); };
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const processing = async (): Promise<WebChatResult> => {
      const hostReply = await createArrivalConsultation(this.store, { signal: abort.signal })(entry.identity, text);
      assertActive();
      let reply: Reply;
      if (hostReply !== undefined) {
        reply = hostReply;
        if (entry.agent) await entry.agent.sendCustomMessage({ customType: "web-consultation", display: false,
          content: JSON.stringify({ userText: text, reply }) }, { triggerTurn: false });
      } else {
        if (!entry.agent) {
          const agent = await this.createAgent({ ...entry.identity }, entry.public.id, { ...entry.public.settings });
          if (!entry.active || abort.signal.aborted) { agent.dispose(); throw new Error("网页会话已失效"); }
          entry.agent = agent;
          if (agent.getActiveToolNames().sort().join(",") !== "get_order,search_faq") throw new Error("网页工具必须只读");
          if (entry.messages.length) await agent.sendCustomMessage({ customType: "web-consultation-history", display: false,
            content: JSON.stringify(entry.messages) }, { triggerTurn: false });
        }
        assertActive();
        // The existing atomic CLI driver owns the Pi prompt and actual tool-to-Reply conversion.
        reply = await runCliPrompt(entry.agent, text, async () => {});
      }
      assertActive();
      if (!["answer", "notice", "order"].includes(reply.kind)) throw new Error("网页仅支持只读回复");
      const actual = reply as ReadReply;
      const result: WebChatResult = { sessionId: entry.public.id, requestId, reply: actual,
        durationMs: Date.now() - started, origin: hostReply === undefined ? "agent" : "host" };
      entry.messages.push({ id: requestId, role: "user", text },
        { id: randomUUID(), role: "assistant", text: renderReply(actual).text, reply: actual });
      entry.requests.set(requestId, { text, result }); entry.touched = Date.now();
      return structuredClone(result);
    };
    try {
      return await Promise.race([processing(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("网页处理超时")), this.timeoutMs);
      })]);
    } catch {
      // A failed/late provider turn is never retried or allowed to publish into a replacement conversation.
      this.invalidate(token!, entry);
      throw new WebChatError(503, "本轮未能完成，会话已清空。请新建对话后重试。");
    } finally { clearTimeout(timer); entry.busy = false; }
  }
  close() {
    this.closed = true;
    for (const [token, entry] of this.entries) this.invalidate(token, entry);
  }
}
