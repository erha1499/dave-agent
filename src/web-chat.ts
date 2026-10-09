import { randomBytes, randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CouponStore, QQIdentity, QQIdentityBinding } from "./coupon-store.ts";
import { createArrivalConsultation } from "./arrival-consultation.ts";
import { runCliPrompt } from "./cli.ts";
import { withModelTask, readModelTaskLimits } from "./model-request-budget.ts";
import { renderReply, type Reply } from "./reply.ts";
import { createOrderDiscovery } from "./order-discovery.ts";
import { createWebChatSettingsCatalog, validateWebChatSettings, type WebChatSettings, type WebChatSettingsCatalog } from "./web-chat-settings.ts";
import { chatTokenHash, WebChatError, WebChatHistory } from "./web-chat-history.ts";
export { WebChatError } from "./web-chat-history.ts";

export const webChatProfiles = [
  { id: "demo-a", label: "客户 A", orderHints: ["COUPON-1001"], examples: ["我有哪些订单", "团购券需要预约吗？", "我要退款"] },
  { id: "demo-b", label: "客户 B", orderHints: ["COUPON-1002"], examples: ["我有哪些订单", "团购券需要预约吗？", "我要退款"] },
] as const;
const identities: Record<string, QQIdentity> = {
  "demo-a": { appId: "TEST_APP", senderId: "TEST_USER1" },
  "demo-b": { appId: "TEST_APP", senderId: "TEST_USER2" },
};
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
type ReadReply = Extract<Reply, { kind: "answer" | "notice" | "order" }>;
export type WebChatStep = { id: string; label: string; status: "running" | "done" | "error" };
export type WebChatMessage = { id: string; role: "user" | "assistant"; text: string; reply?: ReadReply; steps?: WebChatStep[];
  status?: "pending" | "interrupted"; createdAt?: string };
type PublicSession = { id: string; conversationId: string; turns: number; busy: boolean; modelAvailable: boolean; modelUnavailableReason?: string;
  profileId: string; label: string; settings: WebChatSettings; model: { provider: string; id: string } };
export type WebChatResult = { sessionId: string; requestId: string; reply: ReadReply; durationMs: number; origin: "host" | "agent"; steps: WebChatStep[] };
type Progress = { type: "start"; replayed: boolean }
  | { type: "step" } & WebChatStep
  | { type: "delta"; messageId: string; text: string };
export type WebChatProgress = { sessionId: string; requestId: string } & Progress;
const toolLabels: Record<string, string> = { get_order: "查询订单详情", list_orders: "查询最近订单", search_faq: "查阅服务规则" };
type Entry = { public: PublicSession; identity: QQIdentity; messages: WebChatMessage[]; touched: number;
  ownerToken: string; owner: string; tokenHash: string; binding: QQIdentityBinding;
  agent?: AgentSession; busy: boolean; active: boolean; abort?: AbortController;
  discovery: ReturnType<typeof createOrderDiscovery>;
  turns: number };

export class WebChatSessions {
  private entries = new Map<string, Entry>();
  private closed = false;
  private taskLimits = readModelTaskLimits();
  private store: Pick<CouponStore, "getOrder" | "listOrders" | "resolveBinding">;
  private createAgent: (identity: QQIdentity, id: string, settings: WebChatSettings) => Promise<AgentSession>;
  private timeoutMs: number;
  private catalog: Promise<WebChatSettingsCatalog>;
  private history: WebChatHistory;
  constructor(store: Pick<CouponStore, "getOrder" | "listOrders" | "resolveBinding">, createAgent: (identity: QQIdentity, id: string, settings: WebChatSettings) => Promise<AgentSession>,
    timeoutMs = 60_000, catalog: Promise<WebChatSettingsCatalog> = createWebChatSettingsCatalog(), history = new WebChatHistory()) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("网页处理超时无效。");
    this.store = store; this.createAgent = createAgent; this.timeoutMs = timeoutMs; this.catalog = catalog; this.history = history;
  }
  private invalidate(token: string, entry: Entry) {
    this.entries.delete(token); entry.active = false; entry.abort?.abort();
    if (entry.agent) { void entry.agent.abort().catch(() => {}); entry.agent.dispose(); entry.agent = undefined; }
    this.history.release(entry.owner, entry.public.id);
  }
  private prune() {
    for (const [token, entry] of this.entries) if (!entry.busy && Date.now() - entry.touched >= 30 * 60_000) this.invalidate(token, entry);
  }
  private find(token: string | undefined) {
    this.prune();
    const entry = token ? this.entries.get(token) : undefined;
    if (entry && !this.closed && this.history.active(entry.owner, entry.public.id, entry.tokenHash)) {
      entry.touched = Date.now(); this.history.touch(entry.owner, entry.public.id); return entry;
    }
    if (entry) this.invalidate(token!, entry);
    return undefined;
  }
  private async binding(profileId: string) {
    if (!identities[profileId]) throw new WebChatError(400, "请选择有效的客户。");
    let binding: QQIdentityBinding | undefined;
    try { binding = await this.store.resolveBinding({ ...identities[profileId]! }); }
    catch { throw new WebChatError(503, "暂时无法核对客户身份，请稍后重试。"); }
    if (!binding?.bindingId || !binding.customerId) throw new WebChatError(401, "客户身份已失效，请重新连接。");
    return binding;
  }
  private async authorize(token: string | undefined, ownerToken?: string) {
    const entry = this.find(token);
    if (!entry || (ownerToken && chatTokenHash(ownerToken) !== entry.owner)) return undefined;
    const binding = await this.binding(entry.public.profileId);
    if (this.find(token) !== entry || !entry.active) return undefined;
    if (binding.bindingId !== entry.binding.bindingId || binding.customerId !== entry.binding.customerId) {
      this.invalidate(token!, entry); throw new WebChatError(401, "客户绑定已变化，请重新连接。");
    }
    return entry;
  }
  async get(token: string | undefined, ownerToken?: string) {
    const entry = await this.authorize(token, ownerToken);
    return entry && this.find(token) === entry ? structuredClone({ session: entry.public, messages: this.history.read(entry.public.conversationId)!.messages }) : { session: null, messages: [] };
  }
  async list(ownerToken: string | undefined, profileId: string) {
    const binding = await this.binding(profileId);
    return { conversations: ownerToken ? this.history.list(chatTokenHash(ownerToken), profileId, binding) : [], limit: 100 };
  }
  async config() {
    const { metadata: _metadata, ...settings } = await this.catalog;
    return { version: 2, simulation: true, readOnly: true, profiles: webChatProfiles,
      limits: { messageCharacters: 2000, conversationTurns: 20, historyPerProfile: 100 }, ...structuredClone(settings) };
  }
  async create(token: string | undefined, profileId: string, input?: unknown, sessionId: unknown = null, ownerToken?: string) {
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
    const previous = await this.authorize(token, ownerToken);
    if ((previous?.public.id ?? null) !== sessionId) throw new WebChatError(401, "页面会话已失效，请重新连接。");
    if (previous?.busy) throw new WebChatError(409, "当前消息仍在处理中，请等待后再新建对话。");
    const binding = await this.binding(profileId);
    // Runtime capacity does not evict durable conversations.
    if (!previous && this.entries.size >= 20) throw new WebChatError(429, "当前会话数量已达上限，请稍后重试。");
    const ownerCapability = ownerToken ?? previous?.ownerToken ?? randomBytes(32).toString("base64url");
    const owner = chatTokenHash(ownerCapability), runtime = randomUUID();
    const capability = randomBytes(32).toString("base64url");
    const saved = this.history.activate(owner, profileId, binding, sessionId as string | null, runtime, chatTokenHash(capability), settings, { provider: model.provider, id: model.modelId });
    if (previous) this.invalidate(token!, previous);
    const identity = { ...identities[profileId]! };
    const entry: Entry = { public: { id: runtime, conversationId: saved.id, turns: saved.turns, busy: false, modelAvailable: model.available,
      ...(model.available ? {} : { modelUnavailableReason: "此对话的模型设置当前不可用，可查看记录、查询订单或新建对话选择模型。" }),
      profileId, label: profile.label, settings, model: saved.model }, identity,
      ownerToken: ownerCapability, owner, tokenHash: chatTokenHash(capability), binding,
      discovery: createOrderDiscovery(this.store, identity),
      messages: [], touched: Date.now(), busy: false, active: true, turns: 0 };
    this.entries.set(capability, entry);
    return { token: capability, ownerToken: ownerCapability, ...structuredClone({ session: entry.public, messages: entry.messages }) };
  }
  async open(token: string | undefined, ownerToken: string | undefined, conversationId: unknown, profileId: string, sessionId: unknown) {
    if (this.closed) throw new WebChatError(503, "客服服务已停止。");
    if (typeof conversationId !== "string" || !uuidPattern.test(conversationId)
      || (sessionId !== null && (typeof sessionId !== "string" || !uuidPattern.test(sessionId)))) throw new WebChatError(400, "打开对话需要有效的会话编号。");
    if (!ownerToken) throw new WebChatError(404, "找不到当前客户的会话记录。");
    const previous = await this.authorize(token, ownerToken), catalog = await this.catalog;
    if ((previous?.public.id ?? null) !== sessionId) throw new WebChatError(401, "页面会话已失效，请重新连接。");
    const binding = await this.binding(profileId), owner = chatTokenHash(ownerToken);
    const saved = this.history.read(conversationId);
    if (!saved || saved.owner !== owner || saved.profile !== profileId || saved.binding !== binding.bindingId || saved.customer !== binding.customerId)
      throw new WebChatError(404, "找不到当前客户的会话记录。");
    const settings = saved.settings, model = catalog.models.find(row => row.id === settings.modelSelection);
    let modelAvailable = false;
    try { validateWebChatSettings(settings, catalog); modelAvailable = !!model?.available && model.provider === saved.model.provider && model.modelId === saved.model.id; }
    catch { /* Stored metadata remains readable even when the current model cannot run it. */ }
    if (!previous && this.entries.size >= 20) throw new WebChatError(429, "当前会话数量已达上限，请稍后重试。");
    const runtime = randomUUID(), capability = randomBytes(32).toString("base64url");
    const active = this.history.activate(owner, profileId, binding, sessionId as string | null, runtime, chatTokenHash(capability), undefined, undefined, conversationId);
    if (previous) this.invalidate(token!, previous);
    const identity = { ...identities[profileId]! };
    const entry: Entry = { public: { id: runtime, conversationId, turns: active.turns, busy: false, modelAvailable,
      ...(modelAvailable ? {} : { modelUnavailableReason: "此对话的模型设置当前不可用或已变化，可查看记录、查询订单或新建对话选择模型。" }),
      profileId, label: webChatProfiles.find(row => row.id === profileId)!.label, settings, model: active.model },
      ownerToken, owner, tokenHash: chatTokenHash(capability), binding, identity, discovery: createOrderDiscovery(this.store, identity),
      messages: active.messages, touched: Date.now(), busy: false, active: true, turns: active.turns };
    this.entries.set(capability, entry);
    return { token: capability, ownerToken, ...structuredClone({ session: entry.public, messages: entry.messages }) };
  }
  async send(token: string | undefined, requestId: string, text: string, sessionId: string,
    onProgress?: (event: WebChatProgress) => void, ownerToken?: string): Promise<WebChatResult> {
    if (![requestId, sessionId].every(id => typeof id === "string" && uuidPattern.test(id))
      || typeof text !== "string" || !text.trim() || text.length > 2000) throw new WebChatError(400, "消息须为 1..2000 字及有效的 UUID 请求编号。");
    const entry = await this.authorize(token, ownerToken);
    if (!entry || this.find(token) !== entry) throw new WebChatError(401, "会话已失效，请新建对话。");
    if (entry.public.id !== sessionId) throw new WebChatError(401, "页面会话已失效，请重新连接。");
    const previous = this.history.receipt(entry.public.conversationId, sessionId, requestId);
    if (previous && previous.text !== text) throw new WebChatError(400, "同一请求编号不能用于不同原文。");
    const emit = (event: Progress) => {
      if (!entry.active || !this.history.active(entry.owner, sessionId, entry.tokenHash)) return;
      // A disconnected progress observer cannot change the read-only turn or its cached receipt.
      try { onProgress?.({ ...event, sessionId, requestId }); } catch { /* Progress is not delivery authority. */ }
    };
    if (previous?.result) { emit({ type: "start", replayed: true }); return structuredClone(previous.result); }
    if (previous?.status === "interrupted") throw new WebChatError(503, "本轮结果未知，未自动重发。请继续咨询或新建对话。");
    if (entry.busy) throw new WebChatError(409, "消息仍在处理中，请等待回复。");
    if (entry.turns >= 20) throw new WebChatError(429, "本次对话已达 20 轮，请新建对话。");
    let preflight: Awaited<ReturnType<Entry["discovery"]["prepare"]>> | undefined;
    if (!entry.public.modelAvailable) {
      entry.busy = true; entry.public.busy = true;
      let preflightTimer: ReturnType<typeof setTimeout> | undefined;
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        preflight = await Promise.race([(async () => {
          const arrival = await createArrivalConsultation(this.store, { signal })(entry.identity, text);
          return arrival === undefined ? entry.discovery.prepare(text) : { prompt: text, reply: arrival };
        })(), new Promise<never>((_resolve, reject) => { preflightTimer = setTimeout(() => reject(new Error("网页处理超时")), this.timeoutMs); })]);
        if (this.find(token) !== entry || signal.aborted) throw new Error("网页会话已失效");
        if (!preflight.reply) throw new WebChatError(400, "此咨询需要模型，原模型设置当前不可用或已变化。消息未发送，请新建对话选择可用模型。");
      } catch (error) {
        if (error instanceof WebChatError) throw error;
        try { this.invalidate(token!, entry); } catch { /* No pending request was accepted. */ }
        throw new WebChatError(503, "暂时无法完成咨询读取，消息未发送。请重新连接后重试。");
      } finally { clearTimeout(preflightTimer); entry.busy = false; entry.public.busy = false; }
    }
    let claimed: ReturnType<WebChatHistory["claim"]>;
    try { claimed = this.history.claim(entry.owner, sessionId, entry.tokenHash, requestId, text, this.timeoutMs); }
    catch (error) { if (error instanceof WebChatError) throw error; throw new WebChatError(503, "本轮未能保存，消息未发送。请稍后重试。"); }
    const abort = new AbortController();
    return withModelTask({ requestId, entrypoint: "web", signal: abort.signal, limits: this.taskLimits,
      onComplete: summary => console.error(`[model-task] ${JSON.stringify(summary)}`) }, async task => {
      entry.busy = true; entry.public.busy = true; entry.turns = claimed.turns; entry.public.turns = claimed.turns;
      entry.abort = abort;
      const assertActive = () => { if (!entry.active || abort.signal.aborted || !this.history.active(entry.owner, sessionId, entry.tokenHash)) throw new Error("网页会话已失效"); };
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
        task.setPhase("host");
        const arrivalReply = preflight ? undefined : await createArrivalConsultation(this.store, { signal: abort.signal })(entry.identity, text);
        assertActive();
        const prepared = preflight ?? (arrivalReply === undefined ? await entry.discovery.prepare(text) : { prompt: text, reply: arrivalReply });
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
            task.setPhase("session");
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
          task.setPhase("model");
          reply = await runCliPrompt(entry.agent, text, async () => {}, undefined, undefined, prepared);
        }
        assertActive();
        task.setPhase("render");
        if (!["answer", "notice", "order"].includes(reply.kind)) throw new Error("网页仅支持只读回复");
        const actual = reply as ReadReply;
        const result: WebChatResult = { sessionId: entry.public.id, requestId, reply: actual,
          durationMs: Date.now() - started, origin: hostReply === undefined ? "agent" : "host", steps: structuredClone(steps) };
        task.setPhase("authorization");
        const binding = await this.binding(entry.public.profileId);
        assertActive();
        if (binding.bindingId !== entry.binding.bindingId || binding.customerId !== entry.binding.customerId) throw new Error("客户绑定已变化");
        task.setPhase("receipt");
        entry.messages = this.history.complete(entry.owner, sessionId, entry.tokenHash, requestId, result,
          { id: `${requestId}:assistant`, role: "assistant", text: renderReply(actual).text, reply: actual, steps: structuredClone(steps), createdAt: new Date().toISOString() });
        entry.touched = Date.now();
        entry.discovery.present(actual, text);
        return structuredClone(result);
      };
      try {
        return await Promise.race([processing(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { task.cancel(); reject(new Error("网页处理超时")); }, this.timeoutMs);
        })]);
      } catch {
        const phase = task.snapshot().phase;
        task.fail(phase === "send" ? "send_unknown" : phase === "receipt" ? "receipt_unknown" : `${phase}_failed`);
        // A failed/late provider turn is never retried or allowed to publish into a replacement conversation.
        try { this.invalidate(token!, entry); } catch { /* Keep the durable pending receipt unknown if interruption cannot be saved. */ }
        throw new WebChatError(503, task.snapshot().failureReason === "context_limit"
          ? "本次对话内容已超过当前处理范围，记录已保留。请新建对话并重新写明订单号及完整问题；重开原记录不会缩短上下文。"
          : "本轮未收到完整答复，会话已失效，记录已保留。请重新连接后查看。");
      } finally { clearTimeout(timer); unsubscribe?.(); entry.busy = false; entry.public.busy = false; }
    });
  }
  close() {
    this.closed = true;
    for (const [token, entry] of this.entries) {
      try { this.invalidate(token, entry); } catch { /* A pending receipt remains unknown when storage is unavailable. */ }
    }
    this.history.close();
  }
}
