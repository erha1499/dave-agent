import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defineTool, loadSkillsFromDir, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession } from "./agent.ts";
import { merchantSourceKey, type AfterSalesStore } from "./after-sales.ts";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";
import type { RefundStore } from "./refunds.ts";
import type { Reply } from "./reply.ts";
import { parseSupportAction, supportActionParameters } from "./support-action.ts";
import { SupportController, type SupportCall, type SupportResult } from "./support-controller.ts";

export type SupportPrompt = {
  requestId: string; groupOpenid: string; messageId: string;
  onCall?: (call: SupportCall) => void;
};
export type SupportFocus = {
  read: () => Promise<string | undefined>;
  write: (orderId: string | undefined) => Promise<void>;
};
type State = { next?: SupportPrompt; result?: SupportResult; focusOrderId?: string; abort?: AbortController; turnError?: boolean; focusUnavailable?: boolean; invalidActions: number };
const sessions = new WeakMap<AgentSession, State>();

export function readSupportArchitecture(env: NodeJS.ProcessEnv = process.env): "atomic" | "controller" {
  // Keep the measured V0 as default until the separately versioned candidate clears its gates.
  const value = env.SUPPORT_ARCHITECTURE?.trim() || "atomic";
  if (value !== "atomic" && value !== "controller") throw new Error("SUPPORT_ARCHITECTURE 仅支持 atomic 或 controller。");
  return value;
}
export function prepareSupportPrompt(session: AgentSession, prompt: SupportPrompt) {
  const state = sessions.get(session);
  if (!state) return;
  // Clear visible output before Pi can fail in preflight, before before_agent_start runs.
  state.abort?.abort();
  state.result = undefined;
  state.turnError = false;
  state.invalidActions = 0;
  state.next = prompt;
}
export const getSupportResult = (session: AgentSession) => sessions.get(session)?.result;
export const isSupportSession = (session: AgentSession) => sessions.has(session);
export function cancelSupportTurn(session: AgentSession) { sessions.get(session)?.abort?.abort(); }

// Only an in-process, successful Controller result can choose a business card.
export function supportReply(session: AgentSession, text = ""): Reply | undefined {
  const state = sessions.get(session);
  if (!state) return undefined;
  const result = state.result;
  if (!result) return { kind: "notice", text: "本轮未形成有效业务动作，请明确订单号及要处理的事项。" };
  if (result.needsAnswer && text.trim() && !state.turnError && (result.reply.kind === "answer" || result.reply.kind === "order")) {
    return { ...result.reply, text: text.trim() };
  }
  return result.reply;
}

export async function createSupportSession(
  identity: QQIdentity, store: CouponStore, runtime: ModelRuntime, model: Model<Api>,
  afterSales?: { store: AfterSalesStore; sourceKey: string; refunds?: RefundStore },
  options: { groupOpenid?: string; focus?: SupportFocus; onCall?: (call: SupportCall) => void } = {},
) {
  const groupOpenid = options.groupOpenid ?? "cli";
  const sourceKey = merchantSourceKey(identity, groupOpenid);
  if (afterSales && afterSales.sourceKey !== sourceKey) throw new Error("业务会话与可信路由不一致。");
  const [prompt, skill] = await Promise.all([
    readFile(new URL("../prompts/customer-service-v2.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support-v2/SKILL.md", import.meta.url), "utf8"),
  ]);
  const skills = loadSkillsFromDir({ dir: fileURLToPath(new URL("../skills/shop-support-v2", import.meta.url)), source: "project" });
  if (skills.skills.length !== 1 || skills.diagnostics.length) throw new Error("客服 v2 Skill 加载失败。");
  const controller = new SupportController({ store, merchant: afterSales?.store, refunds: afterSales?.refunds });
  const state: State = { invalidActions: 0 };
  let turn: ReturnType<SupportController["createTurn"]> | undefined;
  const tools = [defineTool({
    name: "support_action", label: "处理客服业务动作",
    description: "每轮选择一个业务动作。身份、权限、订单事实、金额、批准和确认均由宿主核验。订单出现在当前消息用explicit；唯一已核验历史订单用focus；指代不清用clarify。宿主完成内部查询与前置条件，不要重复执行或追加冲突动作。",
    parameters: supportActionParameters,
    execute: async (_id, { action }) => {
      if (!turn) throw new Error("业务轮次尚未初始化。");
      state.abort?.signal.throwIfAborted();
      const result = await turn.execute(action);
      state.result = result;
      if (result.verifiedOrderId) {
        state.focusOrderId = result.verifiedOrderId;
        // A failed context write must not turn a prepared operation into a retry.
        try { await options.focus?.write(result.verifiedOrderId); state.focusUnavailable = false; }
        catch { state.focusOrderId = undefined; state.focusUnavailable = true; }
      }
      const { order, rules, task, operation } = result.evidence;
      return { content: [{ type: "text", text: JSON.stringify({
        outcome: result.outcome, reply: result.reply, evidence: { order, rules, task, operation },
        needsAnswer: result.needsAnswer,
      }) }], details: { action: result.action, outcome: result.outcome } };
    },
  })];
  const session = await createSession(runtime, { ...model, maxTokens: Math.min(model.maxTokens, 2048) },
    `${prompt.trim()}\n\n${skill.trim()}`, tools, skills, async userText => {
      // Extension failures may be reported without stopping Pi. Never retain the previous executor.
      turn = undefined;
      state.abort?.abort();
      state.abort = new AbortController();
      state.result = undefined;
      state.turnError = false;
      state.invalidActions = 0;
      const current = state.next ?? { requestId: randomUUID(), groupOpenid, messageId: randomUUID() };
      state.next = undefined;
      try {
        if (current.groupOpenid !== groupOpenid) throw new Error("会话不能切换可信群路由。");
        if (options.focus && !state.focusUnavailable) {
          try { state.focusOrderId = await options.focus.read(); }
          catch { state.focusOrderId = undefined; state.focusUnavailable = true; }
        }
        const explicit = [...new Set(userText.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
        if (explicit.length > 1 || (explicit.length === 1 && explicit[0] !== state.focusOrderId)) {
          state.focusOrderId = undefined;
          try { await options.focus?.write(undefined); }
          catch { state.focusUnavailable = true; }
        }
        turn = controller.createTurn({
          requestId: current.requestId, identity, sourceKey, userText,
          trustedRoute: { groupOpenid, messageId: current.messageId },
          focusOrderId: state.focusOrderId, signal: state.abort.signal, onCall: current.onCall ?? options.onCall,
        });
        return JSON.stringify({ kind: "host_order_reference", orderId: state.focusOrderId ?? null,
          instruction: "仅用于明确的当前指代，不代表批准或确认。当前消息有订单号时优先explicit；多单/指代不清需clarify。" });
      } catch {
        turn = undefined;
        state.abort.abort();
        state.turnError = true;
        return JSON.stringify({ kind: "host_context_unavailable", instruction: "本轮宿主初始化失败，无法执行业务；请稍后重新按订单号查询。" });
      }
    });
  session.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") state.turnError = true;
    for (const part of event.message.content) {
      if (part.type !== "toolCall") continue;
      try {
        if (part.name !== "support_action" || Object.keys(part.arguments).length !== 1 || !("action" in part.arguments)) throw new Error();
        parseSupportAction(part.arguments.action);
      } catch { state.invalidActions++; }
    }
    if (state.invalidActions > 1) {
      state.turnError = true;
      state.abort?.abort();
      // Do not await settlement inside the synchronous event listener.
      void session.abort().catch(() => {});
    }
  });
  sessions.set(session, state);
  return session;
}
