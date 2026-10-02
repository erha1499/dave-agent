import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { EvalStep, EvalUsage } from "./evaluation.ts";

const denial = "未找到当前客户可查询的订单，请核对订单号或联系人工客服。";

// Subscription callbacks only collect memory. Database writes happen after prompt() settles.
export function captureEvaluationTurn(modelName: string, expectedDeniedOrder?: string) {
  const started = performance.now();
  const steps: EvalStep[] = [];
  const pendingTools = new Map<string, { step: EvalStep; started: number }>();
  let pendingModel: { step: EvalStep; started: number } | undefined;
  let firstTextMs: number | null = null;
  let failed = false;

  function receive(event: AgentSessionEvent) {
    try {
      if (event.type === "message_start" && event.message.role === "assistant") {
        const step: EvalStep = { index: steps.length + 1, type: "model", name: modelName, durationMs: null, isError: false, usage: null };
        steps.push(step);
        pendingModel = { step, started: performance.now() };
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
        && event.assistantMessageEvent.delta && firstTextMs === null) {
        // First text from any model response in this user turn, before possible tool calls.
        firstTextMs = Math.round(performance.now() - started);
      } else if (event.type === "message_end" && event.message.role === "assistant" && pendingModel) {
        const message = event.message;
        const step = pendingModel.step;
        step.durationMs = Math.round(performance.now() - pendingModel.started);
        step.name = `${message.provider}/${message.model}`;
        step.isError = message.stopReason === "error" || message.stopReason === "aborted";
        step.output = { content: message.content, stopReason: message.stopReason };
        const usage = message.usage;
        // Pi initializes absent provider usage to zeros. A real request here has nonempty input;
        // treat a zero/invalid total as unreported, rather than showing invented zero tokens.
        if (usage && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
          && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(value => Number.isFinite(value) && value >= 0)) {
          const price = usage.cost?.total;
          step.usage = {
            input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
            estimatedCostUsd: Number.isFinite(price) && price >= 0 ? price : null,
          } satisfies EvalUsage;
        }
        pendingModel = undefined;
      } else if (event.type === "tool_execution_start") {
        const step: EvalStep = {
          index: steps.length + 1, type: "tool", name: event.toolName,
          durationMs: null, input: event.args, isError: false,
        };
        steps.push(step);
        pendingTools.set(event.toolCallId, { step, started: performance.now() });
      } else if (event.type === "tool_execution_end") {
        const pending = pendingTools.get(event.toolCallId);
        if (!pending) { failed = true; return; }
        pending.step.durationMs = Math.round(performance.now() - pending.started);
        pending.step.output = event.result;
        pending.step.isError = event.isError;
        const args = pending.step.input as { orderId?: string } | undefined;
        const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
        pending.step.expectedDenial = Boolean(event.isError && event.toolName === "get_order"
          && expectedDeniedOrder && args?.orderId === expectedDeniedOrder
          && result?.content?.some(part => part.type === "text" && part.text?.includes(denial)));
        pendingTools.delete(event.toolCallId);
      }
    } catch {
      // Never let a diagnostic listener interrupt the Agent's control flow.
      failed = true;
    }
  }

  return {
    receive,
    finish() {
      for (const pending of [...pendingTools.values(), ...(pendingModel ? [pendingModel] : [])]) {
        pending.step.durationMs = Math.round(performance.now() - pending.started);
        pending.step.isError = true;
        pending.step.output = { error: "执行未正常完成" };
      }
      return { steps, firstTextMs, failed, durationMs: Math.round(performance.now() - started) };
    },
  };
}
