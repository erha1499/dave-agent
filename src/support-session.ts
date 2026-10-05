import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defineTool, loadSkillsFromDir, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession } from "./agent.ts";
import { merchantSourceKey, type AfterSalesStore } from "./after-sales.ts";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";
import type { KnowledgeService } from "./knowledge-service.ts";
import type { RefundStore } from "./refunds.ts";
import type { Reply } from "./reply.ts";
import { parseContextSupportAction, contextSupportActionParameters } from "./support-context-action.ts";
import { SupportController, type SupportCall, type SupportResult, type TrustedPolicyTopic } from "./support-controller.ts";
import { rememberOrderChoice, selectAlternativeOrder, type TrustedAmountReference, type TrustedOrderChoices } from "./support-context.ts";
import { resolveSupportParameters } from "./support-parameters.ts";

export type SupportPrompt = {
  requestId: string; groupOpenid: string; messageId: string;
  onCall?: (call: SupportCall) => void;
};
export type SupportFocus = {
  read: () => Promise<string | undefined>;
  write: (orderId: string | undefined) => Promise<void>;
};
type State = { next?: SupportPrompt; result?: SupportResult; focusOrderId?: string; policyTopic?: TrustedPolicyTopic;
  orderChoices?: TrustedOrderChoices; amountReference?: TrustedAmountReference;
  abort?: AbortController; turnError?: boolean; focusUnavailable?: boolean; invalidActions: number };
const sessions = new WeakMap<AgentSession, State>();
function clearReferences(state: State) { state.policyTopic = undefined; state.orderChoices = undefined; state.amountReference = undefined; }

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
export function cancelSupportTurn(session: AgentSession) {
  const state = sessions.get(session);
  // Keep an already published host receipt for model-failure recovery. A new
  // ingress clears it; cancellation cannot undo an operation already completed.
  if (state) { state.abort?.abort(); state.turnError = true; clearReferences(state); }
}

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
  options: { groupOpenid?: string; focus?: SupportFocus; onCall?: (call: SupportCall) => void; repairBudget?: number; knowledge?: KnowledgeService } = {},
) {
  const { repairBudget } = resolveSupportParameters(options.repairBudget === undefined ? {} : { repairBudget: options.repairBudget });
  const groupOpenid = options.groupOpenid ?? "cli";
  const sourceKey = merchantSourceKey(identity, groupOpenid);
  if (afterSales && afterSales.sourceKey !== sourceKey) throw new Error("业务会话与可信路由不一致。");
  const [prompt, skill] = await Promise.all([
    readFile(new URL("../prompts/customer-service-v2.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support-v2/SKILL.md", import.meta.url), "utf8"),
  ]);
  const skills = loadSkillsFromDir({ dir: fileURLToPath(new URL("../skills/shop-support-v2", import.meta.url)), source: "project" });
  if (skills.skills.length !== 1 || skills.diagnostics.length) throw new Error("客服 v2 Skill 加载失败。");
  const controller = new SupportController({ store, merchant: afterSales?.store, refunds: afterSales?.refunds, knowledge: options.knowledge });
  const state: State = { invalidActions: 0 };
  let turn: ReturnType<SupportController["createTurn"]> | undefined;
  const tools = [defineTool({
    name: "support_action", label: "处理客服业务动作",
    description: "每轮选择一个 protocol=v2.2 的业务动作。模型判断语义，宿主验证引用和事实：当前写明订单用explicit，唯一当前订单用focus，另一笔只读订单用alternative；政策问题区分standalone/previous，previous必须带宿主话题requestId。实付比较用paid_amount_compare及宿主amountRef。不接收身份、范围、金额或批准；缺引用或多义用clarify。",
    parameters: contextSupportActionParameters,
    execute: async (_id, { action }) => {
      if (!turn) throw new Error("业务轮次尚未初始化。");
      const executingTurn = turn, executingAbort = state.abort;
      const isCurrent = () => turn === executingTurn && state.abort === executingAbort && !executingAbort?.signal.aborted;
      const assertCurrent = () => {
        executingAbort?.signal.throwIfAborted();
        if (!isCurrent()) throw new Error("业务轮次已切换，不能发布旧轮次结果。");
      };
      assertCurrent();
      let result: SupportResult;
      try { result = await executingTurn.execute(action); }
      catch (error) { if (isCurrent()) clearReferences(state); throw error; }
      assertCurrent();
      let focusWriteFailed = false;
      if (result.verifiedOrderId) {
        // A write already started cannot be rolled back by cancellation. Wait
        // before publishing local state, and never let a late failure clear a new turn.
        try { await options.focus?.write(result.verifiedOrderId); }
        catch { focusWriteFailed = true; }
        assertCurrent();
      }
      state.result = result;
      state.policyTopic = result.verifiedPolicyTopic;
      state.amountReference = result.verifiedAmountReference;
      if (result.outcome === "ready" && result.reply.kind === "order" && result.evidence.order) {
        state.orderChoices = rememberOrderChoice(state.orderChoices, { sourceKey, groupOpenid }, result.evidence.order.id, result.evidence.requestId);
      } else state.orderChoices = undefined;
      if (result.verifiedOrderId) {
        state.focusOrderId = focusWriteFailed ? undefined : result.verifiedOrderId;
        state.focusUnavailable = focusWriteFailed;
        // A failed context write must not turn a prepared operation into a retry.
        if (focusWriteFailed) clearReferences(state);
      }
      const { order, rules, task, operation, amountComparison, displayedPaidUnit } = result.evidence;
      return { content: [{ type: "text", text: JSON.stringify({
        outcome: result.outcome, reply: result.reply, evidence: { order, rules, task, operation,
          amountComparison: amountComparison ? { remainingCouponCount: amountComparison.remainingCouponCount,
            remainingUnitPaidCents: amountComparison.remainingUnitPaidCents, referencePaidCents: amountComparison.referencePaidCents,
            comparisonEqual: amountComparison.comparisonEqual, refundApproved: false } : undefined,
          displayedPaidUnit: displayedPaidUnit ? { field: displayedPaidUnit.field, paidCents: displayedPaidUnit.paidCents, productId: displayedPaidUnit.productId } : undefined },
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
          try {
            const focus = await options.focus.read();
            if (focus !== state.focusOrderId) clearReferences(state);
            state.focusOrderId = focus;
          } catch { state.focusOrderId = undefined; clearReferences(state); state.focusUnavailable = true; }
        }
        const explicit = [...new Set(userText.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
        // Semantic references are selected by the one model action. Only an
        // explicit locator changes these host references before fresh execution.
        if (explicit.length > 1 || (explicit.length === 1 && explicit[0] !== state.focusOrderId)) {
          state.focusOrderId = undefined;
          state.policyTopic = undefined;
          state.amountReference = undefined;
          if (explicit.length > 1) state.orderChoices = undefined;
          try { await options.focus?.write(undefined); }
          catch { state.focusUnavailable = true; }
        }
        turn = controller.createTurn({
          requestId: current.requestId, identity, sourceKey, userText,
          trustedRoute: { groupOpenid, messageId: current.messageId },
          focusOrderId: state.focusOrderId, policyTopic: state.policyTopic, orderChoices: state.orderChoices, amountReference: state.amountReference,
          signal: state.abort.signal, onCall: current.onCall ?? options.onCall,
        });
        return JSON.stringify({ kind: "host_order_reference", protocol: "v2.2", orderId: state.focusOrderId ?? null,
          policyTopic: state.policyTopic ? { requestId: state.policyTopic.requestId, originalQuery: state.policyTopic.originalQuery,
            intent: state.policyTopic.intent, orderId: state.policyTopic.orderId } : null,
          itemPaidUnit: state.amountReference ? { requestId: state.amountReference.requestId, orderId: state.amountReference.orderId,
            field: state.amountReference.field, paidCents: state.amountReference.paidCents } : null,
          alternativeOrderId: selectAlternativeOrder(state.orderChoices, { sourceKey, groupOpenid }, state.focusOrderId) ?? null,
          instruction: "使用protocol=v2.2。这些是有界定位引用，不代表批准或确认。当前有订单号用explicit；当前单用focus；唯一另一单用alternative且仅只读。依赖前文的话题用previous与policyTopic.requestId；独立完整问题用standalone。只读实付比较用paid_amount_compare与itemPaidUnit.requestId。引用为空、多义或不匹配先clarify，禁止从历史聊天自造引用或把旧状态带到新单；宿主每轮重新授权取证。" });
      } catch {
        turn = undefined;
        state.abort.abort();
        state.turnError = true;
        clearReferences(state);
        return JSON.stringify({ kind: "host_context_unavailable", instruction: "本轮宿主初始化失败，无法执行业务；请稍后重新按订单号查询。" });
      }
    });
  session.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") { state.turnError = true; clearReferences(state); }
    if (event.message.stopReason !== "toolUse" && !state.result) clearReferences(state);
    for (const part of event.message.content) {
      if (part.type !== "toolCall") continue;
      try {
        if (part.name !== "support_action" || Object.keys(part.arguments).length !== 1 || !("action" in part.arguments)) throw new Error();
        // Count pure reference/protocol failures in the same bounded repair budget as schema errors.
        const action = parseContextSupportAction(part.arguments.action);
        if (turn) turn.validate(action);
      } catch { state.invalidActions++; }
    }
    if (state.invalidActions > repairBudget) {
      state.turnError = true;
      clearReferences(state);
      state.abort?.abort();
      // Do not await settlement inside the synchronous event listener.
      void session.abort().catch(() => {});
    }
  });
  sessions.set(session, state);
  return session;
}
