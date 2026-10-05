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
import { normalizeModelSupportAction, modelSupportActionParameters } from "./support-context-action.ts";
import { SupportController, type SupportCall, type SupportResult, type TrustedPolicyTopic } from "./support-controller.ts";
import { amountChoiceNotice, amountChoicesVersion, currentAmountChoices, rememberAmountChoice, rememberOrderChoice,
  resolveAmountReference, selectAmountChoice, selectAlternativeOrder, type TrustedAmountChoices, type TrustedOrderChoices } from "./support-context.ts";
import { resolveSupportParameters } from "./support-parameters.ts";

export type SupportPrompt = {
  requestId: string; groupOpenid: string; messageId: string;
  onCall?: (call: SupportCall) => void;
};
export type SupportFocus = {
  read: () => Promise<string | undefined>;
  write: (orderId: string | undefined) => Promise<void>;
};
export type SupportHostReceipt = {
  version: "amount-selection-v1"; requestId: string; sourceKey: string;
  trustedRoute: { groupOpenid: string; messageId: string };
  outcome: "selected" | "rejected"; selectedRequestId?: string;
  historyFailed?: boolean;
  choices: TrustedAmountChoices; reply: Extract<Reply, { kind: "notice" }>;
};
type State = { next?: SupportPrompt; result?: SupportResult; focusOrderId?: string; policyTopic?: TrustedPolicyTopic;
  orderChoices?: TrustedOrderChoices; amountChoices?: TrustedAmountChoices; hostReceipt?: SupportHostReceipt;
  abort?: AbortController; turnError?: boolean; focusUnavailable?: boolean; invalidActions: number; actionStarted: boolean };
const sessions = new WeakMap<AgentSession, State>();
function clearReferences(state: State) { state.policyTopic = undefined; state.orderChoices = undefined; state.amountChoices = undefined; state.hostReceipt = undefined; }

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
  state.hostReceipt = undefined;
  state.turnError = false;
  state.invalidActions = 0;
  state.actionStarted = false;
  state.next = prompt;
}
export const getSupportResult = (session: AgentSession) => sessions.get(session)?.result;
export const getSupportHostReceipt = (session: AgentSession) => {
  const receipt = sessions.get(session)?.hostReceipt;
  return receipt ? structuredClone(receipt) : undefined;
};
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
  if (state.hostReceipt && !state.turnError) return structuredClone(state.hostReceipt.reply);
  const result = state.result;
  if (!result) return { kind: "notice", text: "本轮未形成有效业务动作，请明确订单号及要处理的事项。" };
  const reply = result.needsAnswer && text.trim() && !state.turnError && (result.reply.kind === "answer" || result.reply.kind === "order")
    ? { ...result.reply, text: text.trim() } : result.reply;
  const explanation = result.evidence.knowledge.some(entry => entry.context.evidenceUse === "explanation");
  return explanation && (reply.kind === "answer" || reply.kind === "order" || reply.kind === "notice")
    ? { ...reply, text: "以下仅解释所问条件，不表示当前订单已满足，也不构成退款批准。\n" + reply.text } : reply;
}

export async function createSupportSession(
  identity: QQIdentity, store: CouponStore, runtime: ModelRuntime, model: Model<Api>,
  afterSales?: { store: AfterSalesStore; sourceKey: string; refunds?: RefundStore },
  options: { groupOpenid?: string; focus?: SupportFocus; onCall?: (call: SupportCall) => void; repairBudget?: number; knowledge?: KnowledgeService } = {},
) {
  const { repairBudget } = resolveSupportParameters(options.repairBudget === undefined ? {} : { repairBudget: options.repairBudget });
  const groupOpenid = options.groupOpenid ?? "cli";
  const sourceKey = merchantSourceKey(identity, groupOpenid);
  const binding = { sourceKey, groupOpenid };
  const emptyAmountChoices = (): TrustedAmountChoices => ({ ...binding, version: amountChoicesVersion,
    candidates: [], overflow: false, selectionRequired: false });
  if (afterSales && afterSales.sourceKey !== sourceKey) throw new Error("业务会话与可信路由不一致。");
  const [prompt, skill] = await Promise.all([
    readFile(new URL("../prompts/customer-service-v2.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support-v2/SKILL.md", import.meta.url), "utf8"),
  ]);
  const skills = loadSkillsFromDir({ dir: fileURLToPath(new URL("../skills/shop-support-v2", import.meta.url)), source: "project" });
  if (skills.skills.length !== 1 || skills.diagnostics.length) throw new Error("客服 v2 Skill 加载失败。");
  const controller = new SupportController({ store, merchant: afterSales?.store, refunds: afterSales?.refunds, knowledge: options.knowledge });
  const state: State = { invalidActions: 0, actionStarted: false };
  let turn: ReturnType<SupportController["createTurn"]> | undefined;
  let activeRun: { abort: AbortController; contextText: string; promise?: Promise<void> } | undefined;
  let pendingFocusWrite: Promise<void> | undefined;
  const tools = [defineTool({
    name: "support_action", label: "处理客服业务动作",
    description: "每轮选择一个业务动作。宿主固定协议v2.2，protocol可省略，如提供只能为v2.2。模型判断语义，宿主验证引用和事实：当前写明订单用explicit，唯一当前订单用focus，另一笔只读订单用alternative；政策问题区分standalone/previous，previous必须带宿主话题requestId。实付比较只可用当前宿主itemPaidUnit的requestId；金额候选多义时clarify amount_basis，禁止模型代替用户选择候选。不接收身份、范围、金额或批准；缺引用或多义用clarify。",
    parameters: modelSupportActionParameters,
    execute: async (_id, { action }) => {
      if (!turn) throw new Error("业务轮次尚未初始化。");
      const executingTurn = turn, executingAbort = state.abort;
      const isCurrent = () => turn === executingTurn && state.abort === executingAbort && !executingAbort?.signal.aborted;
      const assertCurrent = () => {
        executingAbort?.signal.throwIfAborted();
        if (!isCurrent()) throw new Error("业务轮次已切换，不能发布旧轮次结果。");
      };
      assertCurrent();
      // Schema/current-message errors may be repaired before any business action
      // starts. A started action (including a refusal or exception) is terminal
      // for request forcing; the Controller still caches its result or failure.
      const validated = executingTurn.validate(normalizeModelSupportAction(action));
      state.actionStarted = true;
      let result: SupportResult;
      try { result = await executingTurn.execute(validated); }
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
      if (result.verifiedAmountReference && !result.needsAnswer && result.reply.kind === "order") {
        state.amountChoices = rememberAmountChoice(state.amountChoices, binding, result.verifiedAmountReference);
      } else if (result.outcome === "blocked" || result.outcome === "non_business") state.amountChoices = undefined;
      if (result.outcome === "ready" && result.reply.kind === "order" && result.evidence.order) {
        state.orderChoices = rememberOrderChoice(state.orderChoices, { sourceKey, groupOpenid }, result.evidence.order.id, result.evidence.requestId);
      } else state.orderChoices = undefined;
      if (result.verifiedOrderId) {
        state.focusOrderId = focusWriteFailed ? undefined : result.verifiedOrderId;
        state.focusUnavailable = focusWriteFailed;
        // A failed context write must not turn a prepared operation into a retry.
        if (focusWriteFailed) clearReferences(state);
      }
      const { order, rules, task, operation, amountComparison, displayedPaidUnit, knowledge } = result.evidence;
      return { content: [{ type: "text", text: JSON.stringify({
        outcome: result.outcome, reply: result.reply, evidence: { order, rules, task, operation,
          knowledgeUse: knowledge.map(entry => ({ evidenceBindingVersion: entry.context.evidenceBindingVersion, evidenceUse: entry.context.evidenceUse })),
          amountComparison: amountComparison ? { remainingCouponCount: amountComparison.remainingCouponCount,
            remainingUnitPaidCents: amountComparison.remainingUnitPaidCents, referencePaidCents: amountComparison.referencePaidCents,
            comparisonEqual: amountComparison.comparisonEqual, refundApproved: false } : undefined,
          displayedPaidUnit: displayedPaidUnit ? { field: displayedPaidUnit.field, paidCents: displayedPaidUnit.paidCents, productId: displayedPaidUnit.productId } : undefined },
        needsAnswer: result.needsAnswer,
      }) }], details: { action: result.action, outcome: result.outcome } };
    },
  })];
  const session = await createSession(runtime, { ...model, maxTokens: Math.min(model.maxTokens, 2048) },
    `${prompt.trim()}\n\n${skill.trim()}`, tools, skills, async () =>
      activeRun && activeRun.abort === state.abort && !activeRun.abort.signal.aborted ? activeRun.contextText : undefined,
    (payload, api) => {
      // Pi's native payload hook is per Session and per request. The current
      // DeepSeek OpenAI-compatible wire format supports a named function choice;
      // other adapters and independent verifier requests keep their own options.
      if (api !== "openai-completions" || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
      const request = payload as { tools?: Array<{ type?: string; function?: { name?: string } }>;
        thinking?: { type?: string }; reasoning_effort?: unknown };
      if (!Array.isArray(request.tools) || !request.tools.some(tool => tool?.type === "function" && tool.function?.name === "support_action")) return payload;
      const requireAction = Boolean(turn && state.abort && !state.abort.signal.aborted && !state.turnError
        && !state.actionStarted && !state.result && state.invalidActions <= repairBudget
        && request.thinking?.type !== "enabled" && !request.reasoning_effort);
      return { ...payload, tool_choice: requireAction ? { type: "function", function: { name: "support_action" } } : "auto" };
    });
  session.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant"
      || !activeRun || activeRun.abort !== state.abort || activeRun.abort.signal.aborted) return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") { state.turnError = true; clearReferences(state); }
    if (event.message.stopReason !== "toolUse" && !state.result) clearReferences(state);
    for (const part of event.message.content) {
      if (part.type !== "toolCall") continue;
      try {
        if (part.name !== "support_action" || Object.keys(part.arguments).length !== 1 || !("action" in part.arguments)) throw new Error();
        // Count pure reference/protocol failures in the same bounded repair budget as schema errors.
        const action = normalizeModelSupportAction(part.arguments.action);
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
  const modelPrompt = session.prompt.bind(session);
  session.prompt = async (text, promptOptions) => {
    const hostSelection = text.trimStart().startsWith("选择金额基准");
    const current = state.next ?? { requestId: randomUUID(), groupOpenid, messageId: randomUUID() };
    state.next = undefined;
    turn = undefined;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    state.result = undefined;
    state.hostReceipt = undefined;
    state.turnError = false;
    state.invalidActions = 0;
    state.actionStarted = false;
    const assertCurrent = () => {
      abort.signal.throwIfAborted();
      if (state.abort !== abort) throw new Error("业务轮次已切换。");
    };
    // Pi marks streaming only after its asynchronous preflight. Track the whole
    // native prompt promise, including preflight, before allowing a new host receipt.
    const previousRun = activeRun;
    if (previousRun) {
      await session.abort(); assertCurrent();
      await previousRun.promise?.catch(() => {}); assertCurrent();
    }
    // A context write already sent cannot be canceled. Let it finish before a
    // new read/write, otherwise its delayed commit could erase the newer focus.
    if (pendingFocusWrite) {
      await pendingFocusWrite.catch(() => {}); assertCurrent();
    }
    if (current.groupOpenid !== groupOpenid || !current.requestId || current.requestId.length > 512
      || !current.messageId || current.messageId.length > 512 || text.length > 5000) {
      clearReferences(state); state.turnError = true; throw new Error("业务请求标识或可信群路由无效。");
    }
    if (options.focus && !state.focusUnavailable) {
      try {
        const focus = await options.focus.read();
        assertCurrent();
        if (focus !== state.focusOrderId) clearReferences(state);
        state.focusOrderId = focus;
      } catch {
        assertCurrent();
        clearReferences(state); state.focusOrderId = undefined; state.focusUnavailable = true;
      }
    }
    assertCurrent();
    if (!hostSelection) {
      const explicit = [...new Set(text.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
      if (explicit.length > 1 || (explicit.length === 1 && explicit[0] !== state.focusOrderId)) {
        state.focusOrderId = undefined;
        state.policyTopic = undefined;
        if (state.amountChoices) state.amountChoices.selectedToken = undefined;
        if (explicit.length > 1) state.orderChoices = undefined;
        const writing = options.focus?.write(undefined);
        pendingFocusWrite = writing;
        try { await writing; assertCurrent(); }
        catch { assertCurrent(); state.focusUnavailable = true; }
        finally { if (pendingFocusWrite === writing) pendingFocusWrite = undefined; }
      }
      state.amountChoices = currentAmountChoices(state.amountChoices, binding) ?? emptyAmountChoices();
      const amountReference = resolveAmountReference(state.amountChoices, binding);
      try {
        turn = controller.createTurn({ requestId: current.requestId, identity, sourceKey, userText: text,
          trustedRoute: { groupOpenid, messageId: current.messageId }, focusOrderId: state.focusOrderId,
          policyTopic: state.policyTopic, orderChoices: state.orderChoices, amountChoices: state.amountChoices,
          signal: abort.signal, onCall: current.onCall ?? options.onCall });
      } catch (error) {
        assertCurrent(); turn = undefined; state.turnError = true; clearReferences(state); throw error;
      }
      const contextText = JSON.stringify({ kind: "host_order_reference", protocol: "v2.2", orderId: state.focusOrderId ?? null,
          policyTopic: state.policyTopic ? { requestId: state.policyTopic.requestId, originalQuery: state.policyTopic.originalQuery,
            intent: state.policyTopic.intent, orderId: state.policyTopic.orderId } : null,
          itemPaidUnit: amountReference ? { requestId: amountReference.requestId, orderId: amountReference.orderId,
            field: amountReference.field, paidCents: amountReference.paidCents } : null,
          amountChoices: { version: state.amountChoices.version, overflow: state.amountChoices.overflow,
            selectionRequired: state.amountChoices.selectionRequired, selectedToken: state.amountChoices.selectedToken ?? null,
            candidates: state.amountChoices.candidates.map(row => ({ token: row.token, version: row.version,
              requestId: row.reference.requestId, orderId: row.reference.orderId, field: row.reference.field, paidCents: row.reference.paidCents })) },
          alternativeOrderId: selectAlternativeOrder(state.orderChoices, { sourceKey, groupOpenid }, state.focusOrderId) ?? null,
          instruction: "宿主固定协议v2.2，protocol可省略，如提供只能为v2.2。这些是有界定位引用，不代表批准或确认。当前有订单号用explicit；当前单用focus；唯一另一单用alternative且仅只读。依赖前文的话题用previous与policyTopic.requestId；独立完整问题用standalone。只读实付比较仅可用paid_amount_compare与当前非空itemPaidUnit.requestId；amountChoices只是曾展示候选，模型不得自行挑选其中requestId。金额基准为空或多义用clarify amount_basis，宿主会列出单行选择指令，由用户下一轮选择。引用不匹配先clarify，禁止从历史聊天自造引用或把旧状态带到新单；宿主每轮重新授权取证。" });
      assertCurrent();
      const run: NonNullable<typeof activeRun> = { abort, contextText };
      activeRun = run;
      // Unlike extension hooks, this native preflight callback is invoked directly
      // just before _runAgentPrompt. Throwing here stops a canceled preflight from
      // starting a new provider request whose internal abort state Pi would reset.
      run.promise = modelPrompt(text, { ...promptOptions, preflightResult: disposition => {
        assertCurrent(); promptOptions?.preflightResult?.(disposition); assertCurrent();
      } });
      try { await run.promise; }
      finally { if (activeRun === run) activeRun = undefined; }
      return;
    }
    const match = /^选择金额基准 ([a-f0-9-]{36})$/.exec(text.trim());
    const selected = match && !promptOptions?.images?.length ? selectAmountChoice(state.amountChoices, binding, match[1]!) : undefined;
    // An invalid new choice invalidates the old selection; it cannot silently reuse it.
    state.amountChoices = selected ?? currentAmountChoices(state.amountChoices, binding) ?? emptyAmountChoices();
    if (!selected) state.amountChoices.selectedToken = undefined;
    const reference = selected ? resolveAmountReference(selected, binding) : undefined;
    const reply: SupportHostReceipt["reply"] = { kind: "notice", text: reference
      ? `已选择 ${reference.orderId} 商品 ${reference.productId} 的每券实付 ${(reference.paidCents / 100).toFixed(2)} 元作为基准。请在下一条消息继续比较。仅支持同一订单；其他订单作为基准的比较尚不支持。此次选择不代表退款批准，也未提交退款。`
      : "选择未生效：请使用本会话仍有效的单行选择指令。\n" + amountChoiceNotice(state.amountChoices, binding) };
    const receipt: SupportHostReceipt = { version: "amount-selection-v1", requestId: current.requestId, sourceKey,
      trustedRoute: { groupOpenid, messageId: current.messageId }, outcome: reference ? "selected" : "rejected",
      ...(reference ? { selectedRequestId: reference.requestId } : {}), choices: structuredClone(state.amountChoices), reply };
    state.hostReceipt = receipt;
    // Native non-triggering custom messages preserve the host event for the next
    // turn without asking the model to acknowledge a deterministic selection.
    try {
      await session.sendCustomMessage({ customType: "host_amount_selection", display: false,
        content: JSON.stringify({ kind: "host_amount_selection", requestId: current.requestId,
          outcome: receipt.outcome, selectedRequestId: reference?.requestId ?? null, text: reply.text }) }, { triggerTurn: false });
    } catch { receipt.historyFailed = true; }
  };
  return session;
}
