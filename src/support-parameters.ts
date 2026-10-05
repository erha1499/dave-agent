export type SupportExperimentParameters = {
  timeoutMs: number;
  repairBudget: number;
  merchantEvents: "architecture" | "host" | "model";
};

export function resolveSupportParameters(input: Partial<SupportExperimentParameters> = {}): SupportExperimentParameters {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["timeoutMs", "repairBudget", "merchantEvents"].includes(key))) {
    throw new Error("业务实验参数仅支持 timeoutMs、repairBudget、merchantEvents。");
  }
  const parameters = { timeoutMs: 60_000, repairBudget: 1, merchantEvents: "architecture" as const, ...input };
  if (!Number.isInteger(parameters.timeoutMs) || parameters.timeoutMs < 10_000 || parameters.timeoutMs > 120_000) {
    throw new Error("timeoutMs 必须为 10000..120000 的整数。");
  }
  if (!Number.isInteger(parameters.repairBudget) || parameters.repairBudget < 0 || parameters.repairBudget > 2) {
    throw new Error("repairBudget 必须为 0..2 的整数。");
  }
  if (!["architecture", "host", "model"].includes(parameters.merchantEvents)) {
    throw new Error("merchantEvents 仅支持 architecture、host 或 model。");
  }
  return parameters;
}

export function resolveSupportRunParameters(architecture: "atomic" | "controller", input?: Partial<SupportExperimentParameters>) {
  if (architecture !== "atomic" && architecture !== "controller") throw new Error("业务架构仅支持 atomic 或 controller。");
  const parameters = resolveSupportParameters(input);
  if (architecture === "controller" && parameters.merchantEvents === "model") {
    throw new Error("controller 仅支持宿主处理商家通知，merchantEvents 请选择 architecture 或 host。");
  }
  return { ...parameters, merchantEvents: parameters.merchantEvents === "architecture"
    ? architecture === "controller" ? "host" as const : "model" as const : parameters.merchantEvents,
    repairBudget: architecture === "controller" ? parameters.repairBudget : null };
}
