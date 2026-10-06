import { modelSelections, type ModelSelection } from "./model-selection.ts";

export type SupportExperimentParameters = {
  timeoutMs: number;
  repairBudget: number;
  agentModel: ModelSelection;
  merchantEvents: "architecture" | "host" | "model";
  knowledgeMode: "lexical" | "m4-support";
  knowledgeSupport: "binary" | "typed";
  knowledgeSupportModel: ModelSelection;
  knowledgeSupportPrompt: "v5" | "v6";
  knowledgeApplicability: "model_only" | "declared" | "declared-v2";
  knowledgeQueryMode: "combined" | "separated";
  knowledgeThreshold: number;
  knowledgeTimeoutMs: number;
};

export function resolveSupportParameters(input: Partial<SupportExperimentParameters> = {}): SupportExperimentParameters {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["timeoutMs", "repairBudget", "agentModel", "merchantEvents", "knowledgeMode", "knowledgeSupport", "knowledgeSupportModel", "knowledgeSupportPrompt", "knowledgeApplicability", "knowledgeQueryMode", "knowledgeThreshold", "knowledgeTimeoutMs"].includes(key))) {
    throw new Error("业务实验参数仅支持 timeoutMs、repairBudget、agentModel、merchantEvents、knowledgeMode、knowledgeSupport、knowledgeSupportModel、knowledgeSupportPrompt、knowledgeApplicability、knowledgeQueryMode、knowledgeThreshold、knowledgeTimeoutMs。");
  }
  const parameters = { timeoutMs: 60_000, repairBudget: 1, agentModel: "configured" as const, merchantEvents: "architecture" as const,
    knowledgeMode: "lexical" as const, knowledgeSupport: "binary" as const, knowledgeSupportModel: "configured" as const, knowledgeSupportPrompt: "v5" as const,
    knowledgeApplicability: "model_only" as const, knowledgeQueryMode: "combined" as const, knowledgeThreshold: .71, knowledgeTimeoutMs: 15_000, ...input };
  if (!Number.isInteger(parameters.timeoutMs) || parameters.timeoutMs < 10_000 || parameters.timeoutMs > 120_000) {
    throw new Error("timeoutMs 必须为 10000..120000 的整数。");
  }
  if (!Number.isInteger(parameters.repairBudget) || parameters.repairBudget < 0 || parameters.repairBudget > 2) {
    throw new Error("repairBudget 必须为 0..2 的整数。");
  }
  if (!modelSelections.includes(parameters.agentModel)) throw new Error(`agentModel 仅支持 ${modelSelections.join("、")}。`);
  if (!["architecture", "host", "model"].includes(parameters.merchantEvents)) {
    throw new Error("merchantEvents 仅支持 architecture、host 或 model。");
  }
  if (!["lexical", "m4-support"].includes(parameters.knowledgeMode)) throw new Error("knowledgeMode 仅支持 lexical 或 m4-support。");
  if (!["binary", "typed"].includes(parameters.knowledgeSupport)) throw new Error("knowledgeSupport 仅支持 binary 或 typed。");
  if (parameters.knowledgeMode === "lexical" && parameters.knowledgeSupport !== "binary") throw new Error("knowledgeSupport typed 仅适用于 m4-support。");
  if (!["v5", "v6"].includes(parameters.knowledgeSupportPrompt)) throw new Error("knowledgeSupportPrompt 仅支持 v5 或 v6。");
  if (parameters.knowledgeSupportPrompt === "v6" && (parameters.knowledgeMode !== "m4-support" || parameters.knowledgeSupport !== "typed")) throw new Error("knowledgeSupportPrompt v6 仅适用于 m4-support + typed。");
  if (!modelSelections.includes(parameters.knowledgeSupportModel)) throw new Error(`knowledgeSupportModel 仅支持 ${modelSelections.join("、")}。`);
  if (parameters.knowledgeMode === "lexical" && parameters.knowledgeSupportModel !== "configured") throw new Error(`knowledgeSupportModel ${parameters.knowledgeSupportModel} 仅适用于 m4-support。`);
  if (!["model_only", "declared", "declared-v2"].includes(parameters.knowledgeApplicability)) throw new Error("knowledgeApplicability 仅支持 model_only、declared 或 declared-v2。");
  if (parameters.knowledgeMode !== "m4-support" && parameters.knowledgeApplicability !== "model_only") throw new Error(`knowledgeApplicability ${parameters.knowledgeApplicability} 仅适用于 m4-support。`);
  if (!["combined", "separated"].includes(parameters.knowledgeQueryMode)) throw new Error("knowledgeQueryMode 仅支持 combined 或 separated。");
  if (parameters.knowledgeQueryMode === "separated" && parameters.knowledgeMode !== "m4-support") throw new Error("knowledgeQueryMode separated 仅适用于 m4-support。");
  if (!Number.isFinite(parameters.knowledgeThreshold) || parameters.knowledgeThreshold < 0 || parameters.knowledgeThreshold > 1) {
    throw new Error("knowledgeThreshold 必须为 0..1 的数值。");
  }
  if (!Number.isInteger(parameters.knowledgeTimeoutMs) || parameters.knowledgeTimeoutMs < 1000 || parameters.knowledgeTimeoutMs > 60_000) {
    throw new Error("knowledgeTimeoutMs 必须为 1000..60000 的整数。");
  }
  return parameters;
}

export function resolveSupportRunParameters(architecture: "atomic" | "controller", input?: Partial<SupportExperimentParameters>) {
  if (architecture !== "atomic" && architecture !== "controller") throw new Error("业务架构仅支持 atomic 或 controller。");
  const parameters = resolveSupportParameters(input);
  if (architecture === "atomic" && parameters.knowledgeMode !== "lexical") throw new Error("atomic 仅支持 lexical 知识检索；m4-support 请使用 controller。");
  if (architecture === "controller" && parameters.merchantEvents === "model") {
    throw new Error("controller 仅支持宿主处理商家通知，merchantEvents 请选择 architecture 或 host。");
  }
  return { ...parameters, merchantEvents: parameters.merchantEvents === "architecture"
    ? architecture === "controller" ? "host" as const : "model" as const : parameters.merchantEvents,
    repairBudget: architecture === "controller" ? parameters.repairBudget : null };
}

export function readKnowledgeParameters(env: NodeJS.ProcessEnv = process.env): Pick<SupportExperimentParameters, "knowledgeMode" | "knowledgeSupport" | "knowledgeSupportModel" | "knowledgeSupportPrompt" | "knowledgeApplicability" | "knowledgeQueryMode" | "knowledgeThreshold" | "knowledgeTimeoutMs"> {
  const threshold = env.KNOWLEDGE_THRESHOLD?.trim(), timeout = env.KNOWLEDGE_TIMEOUT_MS?.trim();
  if (threshold && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(threshold)) throw new Error("KNOWLEDGE_THRESHOLD 应为 0..1 的数值。");
  if (timeout && !/^\d+$/.test(timeout)) throw new Error("KNOWLEDGE_TIMEOUT_MS 应为 1000..60000 的整数。");
  const { knowledgeMode, knowledgeSupport, knowledgeSupportModel, knowledgeSupportPrompt, knowledgeApplicability, knowledgeQueryMode, knowledgeThreshold, knowledgeTimeoutMs } = resolveSupportParameters({
    knowledgeMode: (env.KNOWLEDGE_MODE?.trim() || "lexical") as SupportExperimentParameters["knowledgeMode"],
    knowledgeSupport: (env.KNOWLEDGE_SUPPORT?.trim() || "binary") as SupportExperimentParameters["knowledgeSupport"],
    knowledgeSupportModel: (env.KNOWLEDGE_SUPPORT_MODEL?.trim() || "configured") as SupportExperimentParameters["knowledgeSupportModel"],
    knowledgeSupportPrompt: (env.KNOWLEDGE_SUPPORT_PROMPT?.trim() || "v5") as SupportExperimentParameters["knowledgeSupportPrompt"],
    knowledgeApplicability: (env.KNOWLEDGE_APPLICABILITY?.trim() || "model_only") as SupportExperimentParameters["knowledgeApplicability"],
    knowledgeQueryMode: (env.KNOWLEDGE_QUERY_MODE?.trim() || "combined") as SupportExperimentParameters["knowledgeQueryMode"],
    knowledgeThreshold: threshold ? Number(threshold) : .71, knowledgeTimeoutMs: timeout ? Number(timeout) : 15_000,
  });
  return { knowledgeMode, knowledgeSupport, knowledgeSupportModel, knowledgeSupportPrompt, knowledgeApplicability, knowledgeQueryMode, knowledgeThreshold, knowledgeTimeoutMs };
}
