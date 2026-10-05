import { isDeepStrictEqual } from "node:util";
import { Type, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { parseSupportAction, supportActionSchema, SupportProtocolError, type SupportAction, type SupportOrderRef } from "./support-action.ts";

const protocol = Type.Literal("v2.2");
const requestId = Type.String({ minLength: 1, maxLength: 512, pattern: "\\S" });
const currentOrderRef = Type.Union([
  Type.Object({ kind: Type.Literal("explicit"), orderId: Type.String({ pattern: "^COUPON-\\d{4}$" }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("focus") }, { additionalProperties: false }),
]);
const readOrderRef = Type.Union([...currentOrderRef.anyOf,
  Type.Object({ kind: Type.Literal("alternative") }, { additionalProperties: false })]);
const questionContext = Type.Union([
  Type.Object({ kind: Type.Literal("standalone") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("previous"), requestId }, { additionalProperties: false }),
]);
const question = Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" });
const productMention = Type.Optional(Type.String({ minLength: 2, maxLength: 80, pattern: "\\S" }));
const common = supportActionSchema.anyOf.filter(schema => !["policy", "refund_eligibility"].includes(schema.properties.kind.const))
  .map(schema => Type.Object({ ...schema.properties, protocol }, { additionalProperties: false }));

// The historical v2.1 schema is immutable: current sessions expose only this version.
export const contextSupportActionSchema = Type.Union([...common,
  Type.Object({ protocol, kind: Type.Literal("policy"), question, questionContext,
    orderRef: Type.Optional(readOrderRef), productMention }, { additionalProperties: false }),
  Type.Object({ protocol, kind: Type.Literal("refund_eligibility"), question, questionContext,
    orderRef: readOrderRef, productMention }, { additionalProperties: false }),
  Type.Object({ protocol, kind: Type.Literal("paid_amount_compare"), orderRef: currentOrderRef,
    amountRef: Type.Object({ requestId }, { additionalProperties: false }), productMention }, { additionalProperties: false }),
]);
export const contextSupportActionParameters = Type.Object({ action: contextSupportActionSchema }, { additionalProperties: false });
export type ContextQuestionRef = { kind: "standalone" } | { kind: "previous"; requestId: string };
export type ContextOrderRef = SupportOrderRef | { kind: "alternative" };
export type ContextSupportAction = { protocol: "v2.2" } & (
  Exclude<SupportAction, { kind: "policy" | "refund_eligibility" }>
  | { kind: "policy"; question: string; questionContext: ContextQuestionRef; orderRef?: ContextOrderRef; productMention?: string }
  | { kind: "refund_eligibility"; question: string; questionContext: ContextQuestionRef; orderRef: ContextOrderRef; productMention?: string }
  | { kind: "paid_amount_compare"; orderRef: SupportOrderRef; amountRef: { requestId: string }; productMention?: string }
);
export type AnySupportAction = SupportAction | ContextSupportAction;
export const isContextSupportAction = (action: AnySupportAction): action is ContextSupportAction => "protocol" in action;

export function parseContextSupportAction(value: unknown): ContextSupportAction {
  try {
    const args = { action: value };
    const parsed = validateToolArguments({ name: "support_action", description: "有界客服动作", parameters: contextSupportActionParameters },
      { type: "toolCall", id: "validate-context-action", name: "support_action", arguments: args as ToolCall["arguments"] });
    if (!isDeepStrictEqual(parsed, args)) throw new Error();
    return parsed.action as ContextSupportAction;
  } catch {
    throw new SupportProtocolError("业务动作格式无效：请使用 v2.2 动作及宿主给出的引用，不得传身份、范围、金额或批准状态。");
  }
}
export function parseAnySupportAction(value: unknown): AnySupportAction {
  return value && typeof value === "object" && "protocol" in value ? parseContextSupportAction(value) : parseSupportAction(value);
}
