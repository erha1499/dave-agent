import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defineTool, loadSkillsFromDir, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSession } from "./agent.ts";
import { merchantSourceKey, type AfterSalesStore } from "./after-sales.ts";
import type { CouponStore, QQIdentity } from "./coupon-store.ts";
import type { KnowledgeService } from "./knowledge-service.ts";
import type { RefundStore } from "./refunds.ts";
import type { SupportQuestionResolver, SupportQuestionObservation } from "./support-question-resolution.ts";
import type { SupportContextPort, SupportContextSnapshot, SupportContextValue } from "./conversation-state.ts";
import type { Reply } from "./reply.ts";
import { registerOrderDiscovery } from "./order-discovery.ts";
import { normalizeModelSupportAction, getModelSupportActionParameters, type TaskReferenceMode } from "./support-context-action.ts";
import { SupportController, SupportPolicyScopeRepairError, type SupportCall, type SupportResult, type TrustedPolicyTopic,
  type SupportPolicyScopeRepair } from "./support-controller.ts";
import { amountChoiceNotice, amountChoiceTtlMs, amountChoicesVersion, currentAmountChoices, rememberAmountChoice, rememberOrderChoice,
  resolveAmountReference, selectAmountChoice, selectAlternativeOrder, type TrustedAmountChoices, type TrustedOrderChoices } from "./support-context.ts";
import { resolveSupportParameters } from "./support-parameters.ts";
import { currentReferenceChoices, emptyReferenceChoices, referenceChoiceNotice, referenceChoiceTtlMs, rememberReferenceChoice,
  resolveReferenceChoice, selectReferenceChoice, type TrustedReferenceChoices } from "./support-reference-selection.ts";
import { refreshTaskChoices, resolveTaskReference, selectTaskChoice, taskChoiceNotice,
  type TrustedTaskChoices } from "./support-task-context.ts";

export type SupportPrompt = {
  requestId: string; groupOpenid: string; messageId: string;
  onCall?: (call: SupportCall) => void;
  onQuestionTrace?: (observation: SupportQuestionObservation) => void;
};
export type SupportFocus = {
  read: () => Promise<string | undefined>;
  write: (orderId: string | undefined) => Promise<void>;
};
type HostReceipt = {
  requestId: string; sourceKey: string;
  trustedRoute: { groupOpenid: string; messageId: string };
  outcome: "selected" | "rejected"; selectedRequestId?: string;
  historyFailed?: boolean;
  reply: Extract<Reply, { kind: "notice" }>;
};
export type SupportHostReceipt = HostReceipt & ({ version: "amount-selection-v1"; choices: TrustedAmountChoices }
  | { version: "reference-selection-v1"; choices: TrustedReferenceChoices; selectedOrderId?: string; presentationRequestId?: string }
  | { version: "task-selection-v1"; choices: TrustedTaskChoices; selectedTaskId?: string });
type State = { next?: SupportPrompt; result?: SupportResult; focusOrderId?: string; policyTopic?: TrustedPolicyTopic;
  orderChoices?: TrustedOrderChoices; amountChoices?: TrustedAmountChoices; hostReceipt?: SupportHostReceipt;
  policyChoices?: TrustedReferenceChoices; orderReferenceChoices?: TrustedReferenceChoices;
  selectedOrderId?: string; pendingReferenceKind?: "order" | "policy";
  presentations?: Partial<Record<"order" | "policy", { requestId: string; choices: TrustedReferenceChoices }>>;
  amountPresentation?: TrustedAmountChoices;
  taskChoices?: TrustedTaskChoices; taskPresentation?: TrustedTaskChoices; taskRequired?: boolean;
  policyScopeRepair?: SupportPolicyScopeRepair; scopeRepairDisallowedToolCalls?: Set<string>;
  abort?: AbortController; turnError?: boolean; focusUnavailable?: boolean; invalidActions: number; actionStarted: boolean };
const sessions = new WeakMap<AgentSession, State>();
function clearReferences(state: State) {
  state.policyTopic = undefined; state.orderChoices = undefined; state.amountChoices = undefined; state.hostReceipt = undefined;
  state.policyChoices = undefined; state.orderReferenceChoices = undefined; state.selectedOrderId = undefined;
  state.pendingReferenceKind = undefined; state.presentations = undefined; state.amountPresentation = undefined;
  state.taskChoices = undefined; state.taskPresentation = undefined; state.taskRequired = true;
}

export function readSupportArchitecture(env: NodeJS.ProcessEnv = process.env): "atomic" | "controller" {
  // Keep the measured V0 as default until the separately versioned candidate clears its gates.
  const value = env.SUPPORT_ARCHITECTURE?.trim() || "atomic";
  if (value !== "atomic" && value !== "controller") throw new Error("SUPPORT_ARCHITECTURE 仅支持 atomic 或 controller。");
  return value;
}
export function readSupportContextMode(architecture: "atomic" | "controller", env: NodeJS.ProcessEnv = process.env): "memory" | "mysql" {
  const mode = env.SUPPORT_CONTEXT_MODE?.trim() || "memory";
  if (mode !== "memory" && mode !== "mysql") throw new Error("SUPPORT_CONTEXT_MODE 仅支持 memory 或 mysql。");
  if (mode === "mysql" && (architecture !== "controller" || !env.AFTER_SALES_DB_PASSWORD)) {
    throw new Error("持久会话定位需要 Controller 和已初始化的售后数据库账号。");
  }
  return mode;
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
  state.policyScopeRepair = undefined;
  state.scopeRepairDisallowedToolCalls = undefined;
  state.next = prompt;
}
export const getSupportResult = (session: AgentSession) => sessions.get(session)?.result;
// Current-turn diagnostics survive a failed repair, but are never a reusable
// conversation reference or authorization for the next request.
export const getSupportPolicyScopeRepair = (session: AgentSession) => {
  const repair = sessions.get(session)?.policyScopeRepair;
  return repair ? structuredClone(repair) : undefined;
};
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
  options: { groupOpenid?: string; focus?: SupportFocus; context?: SupportContextPort; onCall?: (call: SupportCall) => void; repairBudget?: number; knowledge?: KnowledgeService; taskReferenceMode?: TaskReferenceMode;
    questionContract?: "v2" | "v3"; questionResolver?: SupportQuestionResolver;
    onQuestionTrace?: (observation: SupportQuestionObservation) => void } = {},
) {
  if (options.focus && options.context) throw new Error("会话定位只能使用一个存储来源。");
  const taskReferenceMode = options.taskReferenceMode === undefined ? "id" : options.taskReferenceMode;
  const modelActionParameters = getModelSupportActionParameters(taskReferenceMode);
  const taskReferenceText = (text: string) => taskReferenceMode === "id" ? text : text
    .replaceAll('taskRef={"taskId":"宿主taskReference.taskId"}', 'taskRef={"kind":"current"}（由宿主解析当前任务，不传taskId）')
    .replaceAll("taskRef.taskId", 'taskRef={"kind":"current"}')
    .replace("与非空宿主taskReference的taskId", '与taskRef={"kind":"current"}（仅当宿主taskReference非空，由宿主解析）')
    .replace("只有非空taskReference可供merchant_status的taskRef使用", '只有非空taskReference时可用merchant_status与taskRef={"kind":"current"}，由宿主解析，不传taskId');
  const { repairBudget } = resolveSupportParameters(options.repairBudget === undefined ? {} : { repairBudget: options.repairBudget });
  const groupOpenid = options.groupOpenid ?? "cli";
  const sourceKey = merchantSourceKey(identity, groupOpenid);
  const binding = { sourceKey, groupOpenid };
  const taskReferencesEnabled = typeof afterSales?.store.listTaskReferences === "function";
  const emptyAmountChoices = (): TrustedAmountChoices => ({ ...binding, version: amountChoicesVersion,
    candidates: [], overflow: false, selectionRequired: false });
  if (afterSales && afterSales.sourceKey !== sourceKey) throw new Error("业务会话与可信路由不一致。");
  const [prompt, skill] = await Promise.all([
    readFile(new URL("../prompts/customer-service-v2.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/shop-support-v2/SKILL.md", import.meta.url), "utf8"),
  ]);
  const skills = loadSkillsFromDir({ dir: fileURLToPath(new URL("../skills/shop-support-v2", import.meta.url)), source: "project" });
  if (skills.skills.length !== 1 || skills.diagnostics.length) throw new Error("客服 v2 Skill 加载失败。");
  const controller = new SupportController({ store, merchant: afterSales?.store, refunds: afterSales?.refunds, knowledge: options.knowledge,
    questionContract: options.questionContract, questionResolver: options.questionResolver });
  const state: State = { invalidActions: 0, actionStarted: false };
  let turn: ReturnType<SupportController["createTurn"]> | undefined;
  let activeRun: { abort: AbortController; contextText: string; promise?: Promise<void> } | undefined;
  let pendingFocusWrite: Promise<void> | undefined;
  let contextSnapshot: SupportContextSnapshot | undefined;
  let contextFocus: SupportContextValue["focus"];
  let contextOrderConfirmed = false;
  const forgetContextFocus = () => {
    clearReferences(state); state.focusOrderId = undefined; contextFocus = undefined; contextOrderConfirmed = false;
  };
  const blockedContext = (): SupportContextValue => ({ version: 1, requiresRestatement: true });
  async function saveContext(value: SupportContextValue, abort: AbortController) {
    if (!options.context || !contextSnapshot) return;
    const expected = contextSnapshot;
    const writing = (async () => {
      contextSnapshot = await options.context!.write(expected, value);
      // A final publication already in flight may finish after cancellation.
      // Serialize its invalidation before a new prompt can read the record.
      if ((value.focus || value.version !== 1 && value.orderChoices
        || (value.version === 3 || value.version === 4) && (value.policyChoices || value.amountChoices)
        || value.version === 4 && value.taskContext) && (abort.signal.aborted || state.abort !== abort)) {
        contextSnapshot = await options.context!.write(contextSnapshot, blockedContext());
      }
    })();
    pendingFocusWrite = writing;
    try { await writing; }
    finally { if (pendingFocusWrite === writing) pendingFocusWrite = undefined; }
  }
  async function publishContext(abort: AbortController, requestId: string, selectedAt: number) {
    if (!options.context) return;
    if (abort.signal.aborted || state.abort !== abort) {
      if (state.abort === abort) forgetContextFocus();
      return;
    }
    const result = state.result, receipt = state.hostReceipt;
    const taskAction = result?.action.kind === "merchant_status" && "taskRef" in result.action
      || result?.action.kind === "clarify" && result.action.field === "task";
    const selected = receipt?.version === "reference-selection-v1" && receipt.outcome === "selected" ? receipt.selectedOrderId : undefined;
    const explicit = result?.outcome === "ready" && result.action.kind !== "clarify" && result.action.kind !== "non_business"
      && "orderRef" in result.action && result.action.orderRef?.kind === "explicit" ? result.verifiedOrderId : undefined;
    if (selected || explicit) {
      contextFocus = { orderId: (selected ?? explicit)!, requestId, source: selected ? "selection" : "explicit",
        selectedAt, expiresAt: selectedAt + 15 * 60_000 };
    }
    if (selected) contextOrderConfirmed = true;
    if (state.pendingReferenceKind === "order") contextOrderConfirmed = false;
    // Ordinary order cards also contain an amount reference. Their presence alone
    // must not prevent the basic order -> restart -> fresh status path.
    const ambiguousOrders = !contextOrderConfirmed && Boolean(state.orderReferenceChoices?.overflow || state.orderReferenceChoices?.selectionRequired
      || (state.orderReferenceChoices?.candidates.length ?? 0) > 1);
    if (state.turnError || !result && !receipt || contextFocus && (contextFocus.expiresAt <= Date.now()
      || !taskAction && result?.evidence.order && result.evidence.order.id !== contextFocus.orderId)) {
      contextFocus = undefined; state.focusOrderId = undefined;
    }
    const needsRestatement = state.turnError || !result && !receipt || !contextFocus || contextFocus.expiresAt <= Date.now()
      || state.pendingReferenceKind === "order" || ambiguousOrders
      || Boolean(!taskAction && result && result.outcome !== "ready" && result.outcome !== "clarification");
    const completed = !state.turnError && Boolean(result || receipt);
    const choices = completed ? currentReferenceChoices(state.orderReferenceChoices, binding) : undefined;
    const policies = completed ? currentReferenceChoices(state.policyChoices, binding) : undefined;
    const amounts = completed ? currentAmountChoices(state.amountChoices, binding) : undefined;
    const base = { requiresRestatement: needsRestatement,
      ...(contextFocus && contextFocus.expiresAt > Date.now() ? { focus: contextFocus } : {}) };
    const orderChoices = choices ? { candidates: choices.candidates.flatMap(row => row.reference.kind === "order"
        ? [{ requestId: row.reference.requestId, orderId: row.reference.orderId, expiresAt: row.expiresAt }] : []),
      overflow: choices.overflow, selectionRequired: choices.selectionRequired, pending: state.pendingReferenceKind === "order" } : undefined;
    const selectedPolicy = policies?.candidates.find(row => row.token === policies.selectedToken)?.reference;
    const selectedAmount = amounts?.candidates.find(row => row.token === amounts.selectedToken)?.reference;
    let value: SupportContextValue = policies || amounts || completed && state.pendingReferenceKind === "policy"
      ? { version: 3, ...base, ...(orderChoices ? { orderChoices } : {}),
        ...(state.pendingReferenceKind ? { pendingReferenceKind: state.pendingReferenceKind } : {}),
        ...(policies ? { policyChoices: { candidates: policies.candidates.flatMap(row => {
          if (row.reference.kind !== "policy") return [];
          const { sourceKey: _source, groupOpenid: _group, ...topic } = row.reference.topic;
          return [{ topic, expiresAt: row.expiresAt }];
        }), overflow: policies.overflow, selectionRequired: policies.selectionRequired,
        ...(selectedPolicy?.kind === "policy" ? { selectedRequestId: selectedPolicy.topic.requestId } : {}) } } : {}),
        ...(amounts ? { amountChoices: { candidates: amounts.candidates.map(row => {
          const { sourceKey: _source, groupOpenid: _group, ...reference } = row.reference;
          return { reference, expiresAt: row.expiresAt };
        }), overflow: amounts.overflow, selectionRequired: amounts.selectionRequired,
        ...(selectedAmount ? { selectedRequestId: selectedAmount.requestId } : {}) } } : {}) }
      : orderChoices ? { version: 2, ...base, orderChoices } : { version: 1, ...base };
    const tasks = completed ? state.taskChoices : undefined;
    if (tasks && (tasks.candidates.length || tasks.selectionRequired || tasks.overflow || tasks.selected)) {
      value = { ...value, version: 4, ...(state.pendingReferenceKind ? { pendingReferenceKind: state.pendingReferenceKind } : {}),
        taskContext: { selectionRequired: tasks.selectionRequired, overflow: tasks.overflow,
        ...(tasks.selected ? { selected: structuredClone(tasks.selected) } : {}) } };
    }
    try { await saveContext(value, abort); }
    catch {
      if (state.abort === abort) {
        // A completed business action must retain its receipt and must never run
        // again just because its optional context publication failed.
        clearReferences(state); state.focusOrderId = undefined; state.focusUnavailable = true;
        contextFocus = undefined;
      }
    }
    finally { if (abort.signal.aborted && state.abort === abort) forgetContextFocus(); }
  }
  const tools = [defineTool({
    name: "support_action", label: "处理客服业务动作",
    description: taskReferenceText("每轮选择一个业务动作。宿主固定协议v2.2，protocol可省略，如提供只能为v2.2。模型判断语义，宿主验证引用和事实：当前写明订单用explicit，唯一当前订单用focus，另一笔只读订单用alternative；政策问题区分standalone/previous，previous必须带宿主话题requestId。实付比较只可用当前宿主itemPaidUnit的requestId；金额候选多义时clarify amount_basis。协商任务用merchant_status与非空宿主taskReference的taskId，不得同时给orderRef；taskReference为空或多义用clarify task，禁止模型代替用户选择候选。不接收身份、范围、金额或批准；缺引用或多义用clarify。"),
    parameters: modelActionParameters,
    execute: async (toolCallId, { action }) => {
      if (!turn) throw new Error("业务轮次尚未初始化。");
      const executingTurn = turn, executingAbort = state.abort;
      const isCurrent = () => turn === executingTurn && state.abort === executingAbort && !executingAbort?.signal.aborted;
      const assertCurrent = () => {
        executingAbort?.signal.throwIfAborted();
        if (!isCurrent()) throw new Error("业务轮次已切换，不能发布旧轮次结果。");
      };
      assertCurrent();
      if (state.policyScopeRepair && state.scopeRepairDisallowedToolCalls?.has(toolCallId)) {
        state.turnError = true;
        clearReferences(state);
        executingAbort?.abort();
        void session.abort().catch(() => {});
        throw new Error("范围修复须看到失败结果后只选择一个动作，不能批量猜测或重复执行。");
      }
      // Schema/current-message errors are repairable before an action starts.
      // The only later exception is a host-signed, read-only scope failure;
      // ordinary refusals and uncertain service/mutation results stay terminal.
      const validated = executingTurn.validate(normalizeModelSupportAction(action, taskReferenceMode));
      state.actionStarted = true;
      let result: SupportResult;
      try { result = await executingTurn.execute(validated); }
      catch (error) {
        if (error instanceof SupportPolicyScopeRepairError) {
          assertCurrent();
          const repair = structuredClone(error.repair);
          state.policyScopeRepair = repair;
          // The provider must see this failure before choosing a repair. A batch
          // of guessed tool calls cannot consume the special continuation.
          if (state.invalidActions >= repairBudget || state.scopeRepairDisallowedToolCalls?.has(toolCallId)) {
            state.turnError = true;
            clearReferences(state);
            executingAbort?.abort();
            // The host signal does not stop Pi's native loop on its own. Do
            // not await settlement from inside the tool that must settle first.
            void session.abort().catch(() => {});
            throw error;
          }
          repair.budget = { limit: repairBudget, usedBefore: state.invalidActions,
            usedAfter: ++state.invalidActions, toolCallId };
          state.policyScopeRepair = repair;
          state.actionStarted = false;
          // Pi receives the business repair evidence and budget. Parser fees
          // stay in host audit; no second loop or automatic rewrite.
          throw new SupportPolicyScopeRepairError(repair);
        }
        if (isCurrent()) clearReferences(state);
        throw error;
      }
      assertCurrent();
      if (state.policyScopeRepair?.budget) {
        const { budget: _budget, ...signedRepair } = state.policyScopeRepair;
        if (!isDeepStrictEqual(result.evidence.policyScopeRepair, signedRepair)) {
          clearReferences(state);
          throw new Error("只读范围修复证据不匹配，不能发布本轮结果。");
        }
        result.evidence.policyScopeRepair = structuredClone(state.policyScopeRepair);
      }
      if (options.context && state.pendingReferenceKind === "order" && result.outcome === "ready"
        && result.action.kind !== "clarify" && result.action.kind !== "non_business"
        && "orderRef" in result.action && result.action.orderRef?.kind === "explicit" && result.verifiedOrderId) contextOrderConfirmed = true;
      let focusWriteFailed = false;
      const taskAction = result.action.kind === "merchant_status" && "taskRef" in result.action
        || result.action.kind === "clarify" && result.action.field === "task";
      const nextFocus = taskAction ? undefined : result.verifiedOrderId
        ?? (state.selectedOrderId && result.evidence.order?.id === state.selectedOrderId ? state.selectedOrderId : undefined);
      if (nextFocus && options.focus) {
        // A write already started cannot be rolled back by cancellation. Wait
        // before publishing local state, and never let a late failure clear a new turn.
        try { await options.focus?.write(nextFocus); }
        catch { focusWriteFailed = true; }
        assertCurrent();
      }
      state.result = result;
      if (taskAction && state.taskChoices && (result.referencePresentation === "task" || result.outcome !== "ready")) {
        state.taskChoices = { ...state.taskChoices, selected: undefined, selectionRequired: true };
        result.evidence.taskChoices = structuredClone(state.taskChoices);
        if (result.referencePresentation === "task") state.taskPresentation = structuredClone(state.taskChoices);
      }
      if (!taskAction) {
        if (result.discardPolicyTopic) {
          state.policyTopic = undefined;
          state.policyChoices = emptyReferenceChoices("policy", binding);
          if (state.presentations) delete state.presentations.policy;
        }
        state.policyTopic = result.verifiedPolicyTopic;
        if (result.verifiedPolicyTopic) {
          const action = result.action;
          const continueRequestId = "questionContext" in action && action.questionContext.kind === "previous"
            && action.orderRef?.kind !== "alternative" ? action.questionContext.requestId : undefined;
          state.policyChoices = rememberReferenceChoice(state.policyChoices, binding,
            { kind: "policy", topic: result.verifiedPolicyTopic }, { continueRequestId });
        } else if (result.outcome === "blocked" || result.outcome === "non_business"
          || result.outcome === "ready" && (result.action.kind === "policy" || result.action.kind === "refund_eligibility")) {
          // A failed or unsupported follow-up cannot silently fall back to an older success.
          state.policyChoices = emptyReferenceChoices("policy", binding);
          state.policyTopic = undefined;
        }
        if (result.verifiedAmountReference && !result.needsAnswer && result.reply.kind === "order") {
          state.amountChoices = rememberAmountChoice(state.amountChoices, binding, result.verifiedAmountReference);
        } else if (result.outcome === "blocked" || result.outcome === "non_business") state.amountChoices = undefined;
        const replyText = "text" in result.reply ? result.reply.text : "";
        if (state.amountChoices && state.amountChoices.candidates.some(row =>
          replyText.includes(`选择金额基准 ${row.token}`))) state.amountPresentation = structuredClone(state.amountChoices);
        if (result.outcome === "ready" && result.reply.kind === "order" && result.evidence.order) {
          state.orderChoices = rememberOrderChoice(state.orderChoices, { sourceKey, groupOpenid }, result.evidence.order.id, result.evidence.requestId);
          state.orderReferenceChoices = rememberReferenceChoice(state.orderReferenceChoices, binding,
            { kind: "order", orderId: result.evidence.order.id, requestId: result.evidence.requestId });
        } else if (result.outcome === "blocked" || result.outcome === "non_business") {
          state.orderChoices = undefined; state.orderReferenceChoices = undefined;
        }
        if (result.pendingReferenceKind) {
          state.pendingReferenceKind = result.pendingReferenceKind;
        }
        if (options.questionContract === "v3" && result.outcome === "ready"
          && result.evidence.questionResolution && result.evidence.questionResolution.value.decision !== "needs_clarification"
          && state.pendingReferenceKind === "policy") state.pendingReferenceKind = undefined;
        if (result.referencePresentation && result.referencePresentation !== "task") {
          const choices = result.referencePresentation === "order" ? state.orderReferenceChoices : state.policyChoices;
          if (choices) {
            choices.selectedToken = undefined; choices.selectionRequired = true;
            if (result.referencePresentation === "order") result.evidence.orderReferenceChoices = structuredClone(choices);
            else result.evidence.policyChoices = structuredClone(choices);
            state.presentations ??= {};
            state.presentations[result.referencePresentation] = { requestId: result.evidence.requestId, choices: structuredClone(choices) };
          }
        }
        if (result.evidence.order && result.outcome === "ready"
          && (result.action.kind !== "clarify" && result.action.kind !== "non_business")
          && "orderRef" in result.action && result.action.orderRef?.kind === "explicit" && state.pendingReferenceKind === "order") state.pendingReferenceKind = undefined;
        if (nextFocus) {
          // A selected order is only a locator until this turn's fresh authorized read.
          state.selectedOrderId = undefined;
          state.focusOrderId = focusWriteFailed ? undefined : nextFocus;
          state.focusUnavailable = focusWriteFailed;
          // A failed context write must not turn a prepared operation into a retry.
          if (focusWriteFailed) clearReferences(state);
        }
      }
      const { order, rules, task, operation, amountComparison, displayedPaidUnit, knowledge } = result.evidence;
      return { content: [{ type: "text", text: JSON.stringify({
        outcome: result.outcome, reply: result.reply, evidence: { order, rules, task, operation,
          ...(result.evidence.questionResolution ? { questionResolution: result.evidence.questionResolution } : {}),
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
    taskReferenceText(`${prompt.trim()}\n\n${skill.trim()}`
      + (options.questionContract === "v3" ? "\n\n候选v3咨询合同：question必须是本轮用户原文（仅可去掉首尾空白），历史原问由宿主按引用取得，不可补写。订单状态、实付及券状态用order；商品人数、核销方式、使用日期或套餐限制用policy取规则，不能凭商品名推断。宿主独立解析当前完整问题或合法续问；无法解析将要求完整重述，订单状态不是新的退款诉求。" : "")), tools, skills, async () =>
      activeRun && activeRun.abort === state.abort && !activeRun.abort.signal.aborted ? activeRun.contextText : undefined,
    (payload, api) => {
      // Pi's native payload hook is per Session and per request. The current
      // DeepSeek OpenAI-compatible wire format supports a named function choice;
      // other adapters and independent verifier requests keep their own options.
      if (api !== "openai-completions" || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
      const request = payload as { tools?: Array<{ type?: string; function?: { name?: string } }>;
        thinking?: { type?: string }; reasoning_effort?: unknown; enable_thinking?: boolean };
      if (!Array.isArray(request.tools) || !request.tools.some(tool => tool?.type === "function" && tool.function?.name === "support_action")) return payload;
      const requireAction = Boolean(turn && state.abort && !state.abort.signal.aborted && !state.turnError
        && !state.actionStarted && !state.result && state.invalidActions <= repairBudget
        && request.thinking?.type !== "enabled" && !request.reasoning_effort && request.enable_thinking !== true);
      return { ...payload, tool_choice: requireAction ? { type: "function", function: { name: "support_action" } } : "auto" };
    });
  session.subscribe(event => {
    if (event.type !== "message_end" || event.message.role !== "assistant"
      || !activeRun || activeRun.abort !== state.abort || activeRun.abort.signal.aborted) return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") { state.turnError = true; clearReferences(state); }
    if (event.message.stopReason !== "toolUse" && !state.result) clearReferences(state);
    const toolCalls = event.message.content.filter(part => part.type === "toolCall");
    if (toolCalls.length > 1) {
      state.scopeRepairDisallowedToolCalls ??= new Set();
      for (const part of toolCalls) state.scopeRepairDisallowedToolCalls.add(part.id);
    }
    for (const part of event.message.content) {
      if (part.type !== "toolCall") continue;
      try {
        if (part.name !== "support_action" || Object.keys(part.arguments).length !== 1 || !("action" in part.arguments)) throw new Error();
        // Count pure reference/protocol failures in the same bounded repair budget as schema errors.
        const action = normalizeModelSupportAction(part.arguments.action, taskReferenceMode);
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
    const selectedAt = Date.now();
    const hostSelection = /^(?:选择金额基准|选择订单|选择话题|选择任务)/u.test(text.trimStart());
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
    state.policyScopeRepair = undefined;
    state.scopeRepairDisallowedToolCalls = undefined;
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
      if (options.context) forgetContextFocus();
    }
    // A context write already sent cannot be canceled. Let it finish before a
    // new read/write, otherwise its delayed commit could erase the newer focus.
    if (pendingFocusWrite) {
      await pendingFocusWrite.catch(() => {}); assertCurrent();
      if (options.context) forgetContextFocus();
    }
    if (current.groupOpenid !== groupOpenid || !current.requestId || current.requestId.length > 512
      || !current.messageId || current.messageId.length > 512 || text.length > 5000) {
      clearReferences(state); state.turnError = true; throw new Error("业务请求标识或可信群路由无效。");
    }
    if (options.context) {
      try {
        const next = await options.context.read(); assertCurrent();
        const changed = !contextSnapshot || next.revision !== contextSnapshot.revision
          || next.customerId !== contextSnapshot.customerId || next.bindingId !== contextSnapshot.bindingId
          // MySQL may reorder JSON object keys without changing the saved state.
          || !isDeepStrictEqual(next.value, contextSnapshot.value);
        if (changed) {
          if (contextSnapshot) {
            // Pi can rebuild finalized messages from its branch. Clear that
            // projection too, so an old customer's messages cannot reappear.
            session.sessionManager.resetLeaf();
            session.agent.reset();
          }
          clearReferences(state);
          const savedTasks = next.value?.version === 4 ? next.value.taskContext : undefined;
          state.taskRequired = savedTasks?.selectionRequired ?? Boolean(next.value?.requiresRestatement);
          if (savedTasks) state.taskChoices = { ...binding, ...structuredClone(savedTasks), candidates: [] };
          contextFocus = next.value?.requiresRestatement ? undefined : next.value?.focus;
          contextOrderConfirmed = Boolean(contextFocus);
          state.focusOrderId = contextFocus?.orderId;
          if (next.value && next.value.version !== 1 && next.value.orderChoices) {
            const saved = next.value.orderChoices;
            let choices = emptyReferenceChoices("order", binding);
            // Reuse the existing selector and original deadlines, but issue new
            // tokens. Old presentation proofs cannot survive Session replacement.
            for (const row of saved.candidates) {
              if (row.expiresAt <= Date.now()) continue;
              choices = rememberReferenceChoice(choices, binding,
                { kind: "order", orderId: row.orderId, requestId: row.requestId }, {}, row.expiresAt - referenceChoiceTtlMs)!;
            }
            state.orderReferenceChoices = { ...choices, overflow: saved.overflow,
              selectionRequired: saved.selectionRequired || saved.overflow || saved.candidates.length > 1 };
            if (saved.pending || !contextFocus && (saved.selectionRequired || saved.overflow)) state.pendingReferenceKind = "order";
          }
          if (next.value?.version === 3 || next.value?.version === 4) {
            const savedPolicies = next.value.policyChoices, savedAmounts = next.value.amountChoices;
            if (savedPolicies) {
              let choices = emptyReferenceChoices("policy", binding);
              for (const row of savedPolicies.candidates) {
                if (row.expiresAt <= Date.now()) continue;
                choices = rememberReferenceChoice(choices, binding, { kind: "policy", topic: { ...row.topic, ...binding } },
                  {}, row.expiresAt - referenceChoiceTtlMs)!;
              }
              const selectedToken = choices.candidates.find(row => row.reference.kind === "policy"
                && row.reference.topic.requestId === savedPolicies.selectedRequestId)?.token;
              state.policyChoices = { ...choices, overflow: savedPolicies.overflow,
                selectionRequired: savedPolicies.selectionRequired || savedPolicies.overflow || savedPolicies.candidates.length > 1
                  || Boolean(savedPolicies.selectedRequestId && !selectedToken), selectedToken };
            }
            if (savedAmounts) {
              let choices = emptyAmountChoices();
              for (const row of savedAmounts.candidates) {
                if (row.expiresAt <= Date.now()) continue;
                choices = rememberAmountChoice(choices, binding, { ...row.reference, ...binding }, row.expiresAt - amountChoiceTtlMs)!;
              }
              const selectedToken = choices.candidates.find(row => row.reference.requestId === savedAmounts.selectedRequestId)?.token;
              state.amountChoices = { ...choices, overflow: savedAmounts.overflow,
                selectionRequired: savedAmounts.selectionRequired || savedAmounts.overflow || savedAmounts.candidates.length > 1
                  || Boolean(savedAmounts.selectedRequestId && !selectedToken), selectedToken };
            }
            if (state.pendingReferenceKind !== "order") state.pendingReferenceKind = next.value.pendingReferenceKind;
          }
        }
        if (contextFocus && contextFocus.expiresAt <= Date.now()) {
          const choices = currentReferenceChoices(state.orderReferenceChoices, binding);
          const policies = currentReferenceChoices(state.policyChoices, binding), amounts = currentAmountChoices(state.amountChoices, binding);
          const tasks = state.taskChoices, taskPresentation = state.taskPresentation, taskRequired = state.taskRequired;
          clearReferences(state); state.focusOrderId = undefined; contextFocus = undefined; contextOrderConfirmed = false;
          state.policyChoices = policies; state.amountChoices = amounts;
          state.taskChoices = tasks; state.taskPresentation = taskPresentation; state.taskRequired = taskRequired;
          // A recent authorized query may have produced candidates newer than
          // the original focus. Keep their deadlines, but require a new choice.
          if (choices) {
            state.orderReferenceChoices = { ...choices, selectedToken: undefined, selectionRequired: true };
            state.pendingReferenceKind = "order";
          }
        }
        contextSnapshot = next;
        state.focusUnavailable = false;
        // Do not let a crash, error or failed final write resurrect an older
        // locator. The in-memory references remain usable during this turn.
        await saveContext(blockedContext(), abort); assertCurrent();
      } catch {
        assertCurrent(); clearReferences(state); state.focusOrderId = undefined;
        contextFocus = undefined; state.focusUnavailable = true; state.turnError = true;
        throw new Error("会话定位暂时不可用，本轮尚未处理业务，请稍后重试。");
      }
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
    if (taskReferencesEnabled) {
      try {
        const listing = await afterSales!.store.listTaskReferences(identity, sourceKey, groupOpenid); assertCurrent();
        const previous = state.taskChoices ?? { ...binding, candidates: [], overflow: false, selectionRequired: Boolean(state.taskRequired) };
        const choices = refreshTaskChoices(previous, listing, binding);
        if (!choices) throw new Error("任务引用无效");
        state.taskChoices = choices;
      } catch {
        assertCurrent(); clearReferences(state); state.turnError = true;
        throw new Error("协商任务引用暂时不可用，本轮尚未处理业务，请稍后重试。");
      }
    }
    if (!hostSelection) {
      const explicit = [...new Set(text.match(/COUPON-\d{4}(?!\d)/g) ?? [])];
      if (options.context && explicit.length && (explicit.length !== 1 || explicit[0] !== contextFocus?.orderId)) {
        contextFocus = undefined; contextOrderConfirmed = false;
      }
      if (explicit.length && (explicit.length !== 1 || explicit[0] !== state.selectedOrderId)) state.selectedOrderId = undefined;
      if (explicit.length > 1 || (explicit.length === 1 && explicit[0] !== state.focusOrderId)) {
        if (options.context) { contextFocus = undefined; contextOrderConfirmed = false; }
        state.focusOrderId = undefined;
        state.selectedOrderId = undefined;
        state.policyTopic = undefined;
        // A user-selected amount source names its own order independently of
        // focus. Preserve it only for that explicit order; Controller reauthorizes.
        if (state.amountChoices && (explicit.length !== 1 || !state.amountChoices.selectedToken
          || resolveAmountReference(state.amountChoices, binding)?.orderId !== explicit[0])) state.amountChoices.selectedToken = undefined;
        if (explicit.length > 1) state.orderChoices = undefined;
        const writing = options.focus?.write(undefined);
        pendingFocusWrite = writing;
        try { await writing; assertCurrent(); }
        catch { assertCurrent(); state.focusUnavailable = true; }
        finally { if (pendingFocusWrite === writing) pendingFocusWrite = undefined; }
      }
      state.amountChoices = currentAmountChoices(state.amountChoices, binding) ?? emptyAmountChoices();
      const amountReference = resolveAmountReference(state.amountChoices, binding);
      state.policyChoices = currentReferenceChoices(state.policyChoices, binding) ?? emptyReferenceChoices("policy", binding);
      state.orderReferenceChoices = currentReferenceChoices(state.orderReferenceChoices, binding) ?? emptyReferenceChoices("order", binding);
      state.orderChoices = { ...binding, overflow: state.orderReferenceChoices.overflow,
        orders: state.orderReferenceChoices.candidates.flatMap(row => row.reference.kind === "order"
          ? [{ requestId: row.reference.requestId, orderId: row.reference.orderId }] : []) };
      const policyReference = resolveReferenceChoice(state.policyChoices, binding);
      const policyTopic = !state.pendingReferenceKind && policyReference?.kind === "policy" ? policyReference.topic : undefined;
      const focusOrderId = state.selectedOrderId ?? state.focusOrderId;
      try {
        turn = controller.createTurn({ requestId: current.requestId, identity, sourceKey, userText: text,
          trustedRoute: { groupOpenid, messageId: current.messageId }, focusOrderId,
          policyTopic, orderChoices: state.orderChoices, amountChoices: state.amountChoices,
          taskChoices: state.taskChoices,
          policyChoices: state.policyChoices, orderReferenceChoices: state.orderReferenceChoices, pendingReferenceKind: state.pendingReferenceKind,
          allowPolicyScopeRepair: repairBudget > 0,
          signal: abort.signal, onCall: current.onCall ?? options.onCall,
          onQuestionTrace: current.onQuestionTrace ?? options.onQuestionTrace });
      } catch (error) {
        assertCurrent(); turn = undefined; state.turnError = true; clearReferences(state); throw error;
      }
      const contextText = JSON.stringify({ kind: "host_order_reference", protocol: "v2.2", orderId: focusOrderId ?? null,
          policyTopic: policyTopic ? { requestId: policyTopic.requestId, originalQuery: policyTopic.originalQuery,
            priorQueries: policyTopic.priorQueries, intent: policyTopic.intent, orderId: policyTopic.orderId } : null,
          policyChoices: state.policyChoices, orderChoices: state.orderReferenceChoices,
          taskChoices: state.taskChoices, taskReference: resolveTaskReference(state.taskChoices, binding) ?? null,
          pendingReferenceKind: state.pendingReferenceKind ?? null,
          itemPaidUnit: amountReference ? { requestId: amountReference.requestId, orderId: amountReference.orderId,
            field: amountReference.field, paidCents: amountReference.paidCents } : null,
          amountChoices: { version: state.amountChoices.version, overflow: state.amountChoices.overflow,
            selectionRequired: state.amountChoices.selectionRequired, selectedToken: state.amountChoices.selectedToken ?? null,
            candidates: state.amountChoices.candidates.map(row => ({ token: row.token, version: row.version,
              requestId: row.reference.requestId, orderId: row.reference.orderId, field: row.reference.field, paidCents: row.reference.paidCents })) },
          alternativeOrderId: state.pendingReferenceKind === "order" ? null : selectAlternativeOrder(state.orderChoices, binding, focusOrderId) ?? null,
          instruction: taskReferenceText("宿主固定协议v2.2，protocol可省略，如提供只能为v2.2。这些是有界定位引用，不代表批准或确认。当前有订单号用explicit；当前单用focus；唯一另一单用alternative且仅只读。依赖前文的话题用previous与policyTopic.requestId；独立完整问题用standalone。只读实付比较仅可用paid_amount_compare与当前非空itemPaidUnit.requestId；amountChoices只是曾展示候选，模型不得自行挑选其中requestId。金额基准为空或多义用clarify amount_basis。协商任务独立于当前订单：只有非空taskReference可供merchant_status的taskRef使用；taskChoices不得由模型代选，缺少引用用clarify task。任务查询不能切换当前订单或产生退款权限。宿主会列出单行选择指令，由用户下一轮选择。引用不匹配先clarify，禁止从历史聊天自造引用或把旧状态带到新单；宿主每轮重新授权取证。") });
      assertCurrent();
      const run: NonNullable<typeof activeRun> = { abort, contextText };
      activeRun = run;
      // Unlike extension hooks, this native preflight callback is invoked directly
      // just before _runAgentPrompt. Throwing here stops a canceled preflight from
      // starting a new provider request whose internal abort state Pi would reset.
      run.promise = modelPrompt(text, { ...promptOptions, preflightResult: disposition => {
        assertCurrent(); promptOptions?.preflightResult?.(disposition); assertCurrent();
      } });
      try { await run.promise; await publishContext(abort, current.requestId, selectedAt); }
      catch (error) {
        if (options.context && state.abort === abort) {
          clearReferences(state); state.focusOrderId = undefined; contextFocus = undefined;
        }
        throw error;
      }
      finally {
        if (options.context && abort.signal.aborted && state.abort === abort) forgetContextFocus();
        if (activeRun === run) activeRun = undefined;
      }
      return;
    }
    if (text.trimStart().startsWith("选择任务")) {
      const match = /^选择任务 ([a-f0-9-]{36})$/.exec(text.trim());
      const choices = state.taskChoices ?? { ...binding, candidates: [], overflow: false, selectionRequired: true };
      const offered = match && state.taskPresentation?.candidates.find(row => row.token === match[1]);
      const candidate = match && choices.candidates.find(row => row.token === match[1]);
      const selected = offered && candidate && JSON.stringify(offered.reference) === JSON.stringify(candidate.reference)
        && !promptOptions?.images?.length ? selectTaskChoice(choices, binding, match![1]!, current.requestId) : undefined;
      state.taskChoices = selected ?? { ...choices, selected: undefined, selectionRequired: true };
      const reference = selected ? resolveTaskReference(selected, binding) : undefined;
      const reply: HostReceipt["reply"] = { kind: "notice", text: reference
        ? `已选择订单 ${reference.orderId} 的协商任务 ${reference.taskId}。请在下一条消息查询任务，届时重新核验归属和最新状态。本次选择未改变当前订单，也不代表退款批准或确认。`
        : "选择未生效：请使用本会话仍有效且已经展示的单行指令。\n" + taskChoiceNotice(state.taskChoices, binding) };
      const receipt: SupportHostReceipt = { version: "task-selection-v1", requestId: current.requestId, sourceKey,
        trustedRoute: { groupOpenid, messageId: current.messageId }, outcome: reference ? "selected" : "rejected",
        ...(reference ? { selectedTaskId: reference.taskId, selectedRequestId: current.requestId } : {}),
        choices: structuredClone(state.taskChoices), reply };
      state.hostReceipt = receipt;
      if (!reference) state.taskPresentation = structuredClone(state.taskChoices);
      try {
        await session.sendCustomMessage({ customType: "host_task_selection", display: false,
          content: JSON.stringify({ kind: "host_task_selection", requestId: current.requestId,
            outcome: receipt.outcome, selectedTaskId: reference?.taskId ?? null, text: reply.text }) }, { triggerTurn: false });
      } catch { receipt.historyFailed = true; }
      await publishContext(abort, current.requestId, selectedAt);
      return;
    }
    if (!text.trimStart().startsWith("选择金额基准")) {
      const kind = text.trimStart().startsWith("选择订单") ? "order" : "policy";
      const match = /^选择(?:订单|话题) ([a-f0-9-]{36})$/.exec(text.trim());
      const choices = currentReferenceChoices(kind === "order" ? state.orderReferenceChoices : state.policyChoices, binding)
        ?? emptyReferenceChoices(kind, binding);
      const presentation = state.presentations?.[kind];
      const offered = match && presentation?.choices.candidates.find(row => row.token === match[1]);
      const candidate = match && choices.candidates.find(row => row.token === match[1]);
      const selected = offered && candidate && offered.version === candidate.version && offered.expiresAt === candidate.expiresAt
        && !promptOptions?.images?.length ? selectReferenceChoice(choices, binding, match![1]!) : undefined;
      const next = selected ?? { ...choices, selectedToken: undefined, selectionRequired: true };
      const reference = selected ? resolveReferenceChoice(selected, binding) : undefined;
      if (kind === "order") {
        state.orderReferenceChoices = next;
        state.selectedOrderId = reference?.kind === "order" ? reference.orderId : undefined;
      } else state.policyChoices = next;
      if (reference) {
        if (state.pendingReferenceKind === kind) state.pendingReferenceKind = undefined;
      } else state.pendingReferenceKind ??= kind;
      const selectedRequestId = reference?.kind === "order" ? reference.requestId : reference?.topic.requestId;
      const reply: HostReceipt["reply"] = { kind: "notice", text: reference
        ? reference.kind === "order"
          ? `已选择订单 ${reference.orderId}。请在下一条消息继续提问，届时会重新核验订单归属和状态。本次选择未申请或提交退款。`
          : `已选择话题：${reference.topic.originalQuery.replace(/\s+/gu, " ")}。${reference.topic.orderId ? `对应订单 ${reference.topic.orderId}；若当前不是该订单，请完整写明订单号和问题。` : ""}请在下一条消息继续提问。本次选择不代表商家批准或退款确认。`
        : "选择未生效：请使用本会话仍有效且已经展示的单行指令。\n" + referenceChoiceNotice(kind, next, binding) };
      const receipt: SupportHostReceipt = { version: "reference-selection-v1", requestId: current.requestId, sourceKey,
        trustedRoute: { groupOpenid, messageId: current.messageId }, outcome: reference ? "selected" : "rejected",
        ...(selectedRequestId ? { selectedRequestId, presentationRequestId: presentation!.requestId } : {}),
        ...(reference?.kind === "order" ? { selectedOrderId: reference.orderId } : {}), choices: structuredClone(next), reply };
      state.hostReceipt = receipt;
      // A rejected command displays the current candidates again, without running an Agent turn.
      if (!reference) {
        state.presentations ??= {};
        state.presentations[kind] = { requestId: current.requestId, choices: structuredClone(next) };
      }
      try {
        await session.sendCustomMessage({ customType: "host_reference_selection", display: false,
          content: JSON.stringify({ kind: "host_reference_selection", requestId: current.requestId,
            outcome: receipt.outcome, selectedRequestId: selectedRequestId ?? null, text: reply.text }) }, { triggerTurn: false });
      } catch { receipt.historyFailed = true; }
      await publishContext(abort, current.requestId, selectedAt);
      return;
    }
    const match = /^选择金额基准 ([a-f0-9-]{36})$/.exec(text.trim());
    const offered = match && state.amountPresentation?.candidates.find(row => row.token === match[1]);
    const candidate = match && state.amountChoices?.candidates.find(row => row.token === match[1]);
    const selected = offered && candidate && offered.version === candidate.version && offered.expiresAt === candidate.expiresAt
      && !promptOptions?.images?.length ? selectAmountChoice(state.amountChoices, binding, match![1]!) : undefined;
    // An invalid new choice invalidates the old selection; it cannot silently reuse it.
    state.amountChoices = selected ?? currentAmountChoices(state.amountChoices, binding) ?? emptyAmountChoices();
    if (!selected) { state.amountChoices.selectedToken = undefined; state.amountChoices.selectionRequired = true; }
    const reference = selected ? resolveAmountReference(selected, binding) : undefined;
    const reply: SupportHostReceipt["reply"] = { kind: "notice", text: reference
      ? `已选择 ${reference.orderId} 商品 ${reference.productId} 的每券实付 ${(reference.paidCents / 100).toFixed(2)} 元作为基准。请在下一条消息继续比较。仅支持同一订单；其他订单作为基准的比较尚不支持。此次选择不代表退款批准，也未提交退款。`
      : "选择未生效：请使用本会话仍有效的单行选择指令。\n" + amountChoiceNotice(state.amountChoices, binding) };
    const receipt: SupportHostReceipt = { version: "amount-selection-v1", requestId: current.requestId, sourceKey,
      trustedRoute: { groupOpenid, messageId: current.messageId }, outcome: reference ? "selected" : "rejected",
      ...(reference ? { selectedRequestId: reference.requestId } : {}), choices: structuredClone(state.amountChoices), reply };
    state.hostReceipt = receipt;
    if (!reference) state.amountPresentation = structuredClone(state.amountChoices);
    // Native non-triggering custom messages preserve the host event for the next
    // turn without asking the model to acknowledge a deterministic selection.
    try {
      await session.sendCustomMessage({ customType: "host_amount_selection", display: false,
        content: JSON.stringify({ kind: "host_amount_selection", requestId: current.requestId,
          outcome: receipt.outcome, selectedRequestId: reference?.requestId ?? null, text: reply.text }) }, { triggerTurn: false });
    } catch { receipt.historyFailed = true; }
    await publishContext(abort, current.requestId, selectedAt);
  };
  registerOrderDiscovery(session, store, identity);
  return session;
}
