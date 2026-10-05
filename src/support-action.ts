import { isDeepStrictEqual } from "node:util";
import { Type, validateToolArguments, type Static, type ToolCall } from "@earendil-works/pi-ai";

const orderRef = Type.Union([
  Type.Object({ kind: Type.Literal("explicit"), orderId: Type.String({ pattern: "^COUPON-\\d{4}$" }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("focus") }, { additionalProperties: false }),
]);
const question = Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" });
const reason = Type.String({ minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$" });

export const supportActionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("policy"), question, orderRef: Type.Optional(orderRef) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("order"), orderRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refund_eligibility"), orderRef, question }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("merchant_prepare"), orderRef, reason }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("merchant_status"), orderRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refund_prepare"), orderRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("refund_status"), orderRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("clarify"),
    field: Type.Union([Type.Literal("order"), Type.Literal("reason"), Type.Literal("intent")]),
    reason: Type.Union([Type.Literal("missing"), Type.Literal("ambiguous"), Type.Literal("multiple_intents")]),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("non_business"), reason: Type.Union([Type.Literal("greeting"), Type.Literal("unsupported")]) }, { additionalProperties: false }),
]);

// A root object is accepted by Pi's providers; the discriminated union is its action property.
export const supportActionParameters = Type.Object({ action: supportActionSchema }, { additionalProperties: false });
export type SupportAction = Static<typeof supportActionSchema>;
export type SupportOrderRef = Static<typeof orderRef>;

export class SupportProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "SupportProtocolError"; }
}

export function parseSupportAction(value: unknown): SupportAction {
  try {
    const args = { action: value };
    const parsed = validateToolArguments({ name: "support_action", description: "客服业务动作", parameters: supportActionParameters },
      { type: "toolCall", id: "validate-support-action", name: "support_action", arguments: args as ToolCall["arguments"] });
    // Pi may coerce optional nulls or numbers. The host contract accepts the declared JSON types only.
    if (!isDeepStrictEqual(parsed, args)) throw new Error();
    return parsed.action as SupportAction;
  } catch {
    throw new SupportProtocolError("业务动作格式无效，请按 support_action schema 提交一个动作；不得传身份、金额或确认状态。");
  }
}
