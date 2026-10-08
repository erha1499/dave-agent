import { randomBytes, randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";
import { createArrivalConsultation } from "./arrival-consultation.ts";
import { runCliPrompt } from "./cli.ts";
import { renderReply, type Reply } from "./reply.ts";
import { createOrderDiscovery } from "./order-discovery.ts";
import { createWebChatSettingsCatalog, validateWebChatSettings, type WebChatSettings, type WebChatSettingsCatalog } from "./web-chat-settings.ts";

export const webChatProfiles = [
  { id: "demo-a", label: "客户 A", orderHints: ["COUPON-1001"], examples: ["查询我的订单 COUPON-1001", "团购券需要预约吗？", "查询到账 银行卡"] },
  { id: "demo-b", label: "客户 B", orderHints: ["COUPON-1002"], examples: ["查询我的订单 COUPON-1002", "团购券需要预约吗？", "查询到账 电子钱包"] },
] as const;
const identities: Record<string, QQIdentity> = {
  "demo-a": { appId: "TEST_APP", senderId: "TEST_USER1" },
  "demo-b": { appId: "TEST_APP", senderId: "TEST_USER2" },
};
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
type ReadReply = Extract<Reply, { kind: "answer" | "notice" | "order" }>;
export type WebChatStep = { id: string; label: string; status: "running" | "done" | "error" };
export type WebChatMessage = { id: string; role: "user" | "assistant"; text: string; reply?: ReadReply; steps?: WebChatStep[] };
type PublicSession = { id: string; profileId: string; label: string; settings: WebChatSettings; model: { provider: string; id: string } };
export type WebChatResult = { sessionId: string; requestId: string; reply: ReadReply; durationMs: number; origin: "host" | "agent"; steps: WebChatStep[] };
type Progress = { type: "start"; replayed: boolean }
  | { type: "step" } & WebChatStep
  | { type: "delta"; messageId: string; text: string };
export type WebChatProgress = { sessionId: string; requestId: string } & Progress;
const toolLabels: Record<string, string> = { get_order: "查询订单详情", list_orders: "查询最近订单", search_faq: "查阅服务规则" };
type Entry = { public: PublicSession; identity: QQIdentity; messages: WebChatMessage[]; touched: number;
  agent?: AgentSession; busy: boolean; active: boolean; abort?: AbortController;
  discovery: ReturnType<typeof createOrderDiscovery>;
  requests: Map<string, { text: string; result?: WebChatResult }>; turns: number };

export class WebChatError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class WebChatSessions {
  private entries = new Map<string, Entry>();
  private closed = false;
  private store: Pick<CouponStore, "getOrder" | "listOrders">;
  private createAgent: (identity: QQIdentity, id: string, settings: WebChatSettings) => Promise<AgentSession>;
  private timeoutMs: number;
  private catalog: Promise<WebChatSettingsCatalog>;
  constructor(store: Pick<CouponStore, "getOrder" | "listOrders">, createAgent: (identity: QQIdentity, id: string, settings: WebChatSettings) => Promise<AgentSession>,
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
  async create(token: string | undefined, profileId: string, input?: unknown, sessionId: unknown = null) {
    if (this.closed) throw new WebChatError(503, "客服服务已停止。");
    if (sessionId !== null && (typeof sessionId !== "string" || !uuidPattern.test(sessionId)))
      throw new WebChatError(400, "新对话须声明有效的页面会话编号或 null。");
    const profile = webChatProfiles.find(row => row.id === profileId);
    if (!profile) throw new WebChatError(400, "请选择有效的客户。");
    const catalog = await this.catalog;
    if (this.closed) throw new WebChatError(503, "客服服务已停止。");
    let settings: WebChatSettings;
    try { settings = validateWebChatSettings(input, catalog); }
    catch (error) { throw new WebChatError(400, error instanceof Error ? error.message : "模型设置无效。"); }
    const model = catalog.models.find(row => row.id === settings.modelSelection)!;
    const previous = this.find(token);
    if ((previous?.public.id ?? null) !== sessionId) throw new WebChatError(401, "页面会话已失效，请重新连接。");
    if (previous?.busy) throw new WebChatError(409, "当前消息仍在处理中，请等待后再新建对话。");
    // ponytail: 20 ephemeral local demo sessions; require login/persistence before public or long-lived use.
    if (!previous && this.entries.size >= 20) throw new WebChatError(429, "当前会话数量已达上限，请稍后重试。");
    if (previous) this.invalidate(token!, previous);
    const capability = randomBytes(32).toString("base64url");
    const identity = { ...identities[profileId]! };
    const entry: Entry = { public: { id: randomUUID(), profileId, label: profile.label, settings, model: { provider: model.provider, id: model.modelId } }, identity,
      discovery: createOrderDiscovery(this.store, identity),
      messages: [], touched: Date.now(), busy: false, active: true, requests: new Map(), turns: 0 };
    this.entries.set(capability, entry);
    return { token: capability, ...structuredClone({ session: entry.public, messages: entry.messages }) };
  }
  async send(token: string | undefined, requestId: string, text: string, sessionId: string,
    onProgress?: (event: WebChatProgress) => void): Promise<WebChatResult> {
    if (![requestId, sessionId].every(id => typeof id === "string" && uuidPattern.test(id))
      || typeof text !== "string" || !text.trim() || text.length > 2000) throw new WebChatError(400, "消息须为 1..2000 字及有效的 UUID 请求编号。");
    const entry = this.find(token);
    if (!entry) throw new WebChatError(401, "会话已失效，请新建对话。");
    if (entry.public.id !== sessionId) throw new WebChatError(401, "页面会话已失效，请重新连接。");
    const previous = entry.requests.get(requestId);
    if (previous && previous.text !== text) throw new WebChatError(400, "同一请求编号不能用于不同原文。");
    const emit = (event: Progress) => {
      if (!entry.active) return;
      // A disconnected progress observer cannot change the read-only turn or its cached receipt.
      try { onProgress?.({ ...event, sessionId, requestId }); } catch { /* Progress is not delivery authority. */ }
    };
    if (previous?.result) { emit({ type: "start", replayed: true }); return structuredClone(previous.result); }
    if (entry.busy) throw new WebChatError(409, "消息仍在处理中，请等待回复。");
    if (entry.turns >= 20) throw new WebChatError(429, "本次对话已达 20 轮，请新建对话。");
    entry.busy = true; entry.turns++; entry.requests.set(requestId, { text });
    const abort = new AbortController(); entry.abort = abort;
    const assertActive = () => { if (!entry.active || abort.signal.aborted) throw new Error("网页会话已失效"); };
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const steps: WebChatStep[] = [];
    const step = (id: string, label: string, status: WebChatStep["status"]) => {
      const previous = steps.find(row => row.id === id);
      if (previous) previous.status = status;
      // ponytail: retain at most 64 public steps; a longer loop needs a separate bounded trace contract.
      else if (steps.length < 64) steps.push({ id, label, status });
      else return;
      emit({ type: "step", id, label, status });
    };
    emit({ type: "start", replayed: false });
    step("request", "受理咨询", "running");
    const processing = async (): Promise<WebChatResult> => {
      const arrivalReply = await createArrivalConsultation(this.store, { signal: abort.signal })(entry.identity, text);
      assertActive();
      const prepared = arrivalReply === undefined ? await entry.discovery.prepare(text) : { prompt: text, reply: arrivalReply };
      const hostReply = prepared.reply;
      assertActive();
      if (hostReply?.kind === "order") step("orders", "查询最近订单", "done");
      step("request", "受理咨询", "done");
      let reply: Reply;
      if (hostReply !== undefined) {
        step("reply", "整理答复", "running");
        reply = hostReply;
        if (entry.agent) await entry.agent.sendCustomMessage({ customType: "web-consultation", display: false,
          content: JSON.stringify({ userText: text, reply }) }, { triggerTurn: false });
        step("reply", "整理答复", "done");
      } else {
        if (!entry.agent) {
          const agent = await this.createAgent({ ...entry.identity }, entry.public.id, { ...entry.public.settings });
          if (!entry.active || abort.signal.aborted) { agent.dispose(); throw new Error("网页会话已失效"); }
          entry.agent = agent;
          if (agent.getActiveToolNames().sort().join(",") !== "get_order,list_orders,search_faq") throw new Error("网页工具必须只读");
          if (entry.messages.length) await agent.sendCustomMessage({ customType: "web-consultation-history", display: false,
            content: JSON.stringify(entry.messages) }, { triggerTurn: false });
        }
        assertActive();
        let messageId = "", messages = 0, calls = 0;
        const pendingTools = new Map<string, { id: string; label: string }>();
        unsubscribe = entry.agent.subscribe(event => {
          if (!entry.active || abort.signal.aborted) return;
          if (event.type === "message_start" && event.message.role === "assistant") {
            messageId = `assistant-${++messages}`;
            step(messageId, "整理答复", "running");
          } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && messageId) {
            emit({ type: "delta", messageId, text: event.assistantMessageEvent.delta });
          } else if (event.type === "message_end" && event.message.role === "assistant" && messageId) {
            step(messageId, "整理答复", ["error", "aborted"].includes(event.message.stopReason) ? "error" : "done");
          } else if (event.type === "tool_execution_start" && Object.hasOwn(toolLabels, event.toolName)) {
            const pending = { id: `tool-${++calls}`, label: toolLabels[event.toolName]! };
            pendingTools.set(event.toolCallId, pending);
            step(pending.id, pending.label, "running");
          } else if (event.type === "tool_execution_end") {
            const pending = pendingTools.get(event.toolCallId);
            if (pending) { step(pending.id, pending.label, event.isError ? "error" : "done"); pendingTools.delete(event.toolCallId); }
          }
        });
        // The existing atomic CLI driver owns the Pi prompt and actual tool-to-Reply conversion.
        reply = await runCliPrompt(entry.agent, text, async () => {}, undefined, undefined, prepared);
      }
      assertActive();
      if (!["answer", "notice", "order"].includes(reply.kind)) throw new Error("网页仅支持只读回复");
      const actual = reply as ReadReply;
      const result: WebChatResult = { sessionId: entry.public.id, requestId, reply: actual,
        durationMs: Date.now() - started, origin: hostReply === undefined ? "agent" : "host", steps: structuredClone(steps) };
      entry.messages.push({ id: requestId, role: "user", text },
        { id: randomUUID(), role: "assistant", text: renderReply(actual).text, reply: actual, steps: structuredClone(steps) });
      entry.requests.set(requestId, { text, result }); entry.touched = Date.now();
      entry.discovery.present(actual, text);
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
    } finally { clearTimeout(timer); unsubscribe?.(); entry.busy = false; }
  }
  close() {
    this.closed = true;
    for (const [token, entry] of this.entries) this.invalidate(token, entry);
  }
}
