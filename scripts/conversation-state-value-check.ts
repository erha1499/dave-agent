import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { Pool } from "mysql2/promise";
import { ConversationStateError, ConversationStateStore, validateSupportContextValue, type SupportContextValue } from "../src/conversation-state.ts";

export async function checkConversationStateValue() {
  const now = 1_800_000_000_000, ttl = 15 * 60_000;
  const focus = { orderId: "COUPON-4701", requestId: "request-a", source: "explicit" as const, selectedAt: now - 1000, expiresAt: now + 60_000 };
  const a = { requestId: "request-a", orderId: "COUPON-4701", expiresAt: now + 60_000 };
  const b = { requestId: "request-b", orderId: "COUPON-4702", expiresAt: now + 120_000 };
  const choices = { candidates: [a, b], overflow: false, selectionRequired: false, pending: true };
  const v1 = { version: 1 as const, requiresRestatement: false, focus };
  const v2 = { version: 2 as const, requiresRestatement: false, orderChoices: choices };
  const validate = (value: unknown, at = now, read = false) => validateSupportContextValue(value, { now: at, allowExpiredFocus: read });
  const invalid = (value: unknown) => assert.throws(() => validate(value), ConversationStateError);
  assert.deepEqual(validate(v1), v1);
  assert.deepEqual(validate({ version: 1, requiresRestatement: true }), { version: 1, requiresRestatement: true });
  assert.deepEqual(validate(v1, focus.expiresAt, true), { version: 1, requiresRestatement: true });
  assert.throws(() => validate(v1, focus.expiresAt), ConversationStateError, "expired v1 focus still cannot be written");
  invalid({ ...v1, orderChoices: choices });
  const normalized = validate(v2);
  assert.deepEqual(normalized, { ...v2, orderChoices: { ...choices, selectionRequired: true } });
  assert.deepEqual(validate({ version: 2, requiresRestatement: true }), { version: 2, requiresRestatement: true });
  assert.deepEqual(validate({ ...v2, focus }), { ...normalized, focus });
  assert.notEqual(normalized, v2);
  assert.ok(normalized.version === 2);
  assert.notEqual(normalized.orderChoices, choices); assert.notEqual(normalized.orderChoices!.candidates[0], a);

  // Aging removes locators, never ambiguity. It cannot turn two orders into an implicit choice.
  const oneExpired = validate(v2, a.expiresAt);
  assert.deepEqual(oneExpired, { version: 2, requiresRestatement: true, orderChoices: { ...choices, candidates: [b], selectionRequired: true } });
  const allExpired = validate(oneExpired, b.expiresAt);
  assert.deepEqual(allExpired, { version: 2, requiresRestatement: true, orderChoices: { ...choices, candidates: [], selectionRequired: true } });
  const liveFocus = { ...focus, expiresAt: now + 180_000 };
  assert.deepEqual(validate({ ...v2, focus: liveFocus }, a.expiresAt), { ...oneExpired, requiresRestatement: false, focus: liveFocus });
  const expiredFocus = validate({ ...v2, focus }, focus.expiresAt, true);
  assert.deepEqual(expiredFocus, oneExpired, "an expired v2 focus cannot discard the remaining candidate or disagreement flags");
  assert.deepEqual(validate({ ...v2, orderChoices: { ...choices, candidates: [a], overflow: true, pending: false } }),
    { ...v2, orderChoices: { ...choices, candidates: [a], overflow: true, pending: false, selectionRequired: true } });
  const boundary = { ...a, expiresAt: now + ttl };
  assert.deepEqual(validate({ ...v2, orderChoices: { ...choices, candidates: [boundary] } }),
    { ...v2, orderChoices: { ...choices, candidates: [boundary] } }, "normalization must not renew expiry");

  for (const bad of [null, [], {}, { ...v2, version: 4 }, { ...v2, requiresRestatement: 1 }, { ...v2, token: "old-token" },
    { ...v2, presentation: {} }, { ...v2, amount: 7980 }, { ...v2, identity: "forged" }, { ...v2, history: [] },
    { ...v2, orderChoices: { ...choices, token: "old-token" } }, { ...v2, orderChoices: { ...choices, pending: "true" } },
    { ...v2, orderChoices: { ...choices, overflow: 1 } }, { ...v2, orderChoices: { ...choices, selectionRequired: null } },
    { ...v1, focus: { ...focus, selectedAt: now + 1 } }, { ...v1, focus: { ...focus, expiresAt: focus.selectedAt + ttl + 1 } }]) invalid(bad);
  for (const candidates of [[a, b, { ...a, requestId: "request-c", orderId: "COUPON-4703" }, { ...a, requestId: "request-d", orderId: "COUPON-4704" }],
    [a, { ...b, orderId: a.orderId }], [a, { ...b, requestId: a.requestId }],
    [{ ...a, expiresAt: now - 1 }, { ...a, expiresAt: now - 2 }], [undefined], new Array(1)]) {
    invalid({ ...v2, orderChoices: { ...choices, candidates } });
  }
  for (const badRequest of ["", " leading", "trailing ", "line\nbreak", "\u0000", "\u007f", "x".repeat(513), 7]) {
    invalid({ ...v2, orderChoices: { ...choices, candidates: [{ ...a, requestId: badRequest }] } });
    invalid({ ...v1, focus: { ...focus, requestId: badRequest } });
  }
  for (const patch of [{ orderId: "COUPON-1" }, { orderId: "COUPON-4701 OR 1=1" }, { expiresAt: NaN }, { expiresAt: Infinity },
    { expiresAt: 0 }, { expiresAt: -1 }, { expiresAt: now + 0.5 }, { expiresAt: now + ttl + 1 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: String(now) }, { token: "not-persistable" }, { customerId: "other" }]) {
    invalid({ ...v2, orderChoices: { ...choices, candidates: [{ ...a, ...patch }] } });
  }

  const topic = { requestId: "policy-a", originalQuery: "超过刚才的时间还未到账怎么办？", orderId: a.orderId,
    scope: { shopId: "shop", productId: "meal" }, sources: [{ sourceId: "RULE-A", version: "a".repeat(64) }], intent: "policy" as const,
    priorQueries: [{ requestId: "policy-prior", originalQuery: "信用卡退款需要几个工作日到账？" }] };
  const otherTopic = { ...topic, requestId: "policy-b", orderId: null, priorQueries: [], originalQuery: "预约改期需要谁同意？" };
  const amount = { requestId: "amount-a", orderId: a.orderId, itemId: "item-a", productId: "meal", field: "item_paid_unit" as const,
    paidCents: 7980, orderVersion: "b".repeat(64) };
  const otherAmount = { ...amount, requestId: "amount-b", orderId: b.orderId, itemId: "item-b", paidCents: 5980 };
  const policyChoices = { candidates: [{ topic, expiresAt: a.expiresAt }, { topic: otherTopic, expiresAt: b.expiresAt }],
    overflow: false, selectionRequired: false, selectedRequestId: topic.requestId };
  const amountChoices = { candidates: [{ reference: amount, expiresAt: a.expiresAt }, { reference: otherAmount, expiresAt: b.expiresAt }],
    overflow: false, selectionRequired: false, selectedRequestId: amount.requestId };
  const v3 = { ...v2, version: 3 as const, pendingReferenceKind: "order" as const, policyChoices, amountChoices };
  const normalized3 = validate(v3);
  assert.deepEqual(normalized3, { ...v3, orderChoices: { ...choices, selectionRequired: true },
    policyChoices: { ...policyChoices, selectionRequired: true }, amountChoices: { ...amountChoices, selectionRequired: true } });
  assert.deepEqual(validate(normalized3), normalized3, "normalization is stable and does not renew candidate deadlines");
  assert.ok(normalized3.version === 3);
  assert.notEqual(normalized3.policyChoices?.candidates[0]?.topic.sources, topic.sources);
  assert.notEqual(normalized3.amountChoices?.candidates[0]?.reference, amount);
  for (const priorVersion of [1, 2]) for (const field of ["policyChoices", "amountChoices", "pendingReferenceKind"] as const) {
    invalid({ version: priorVersion, requiresRestatement: false, [field]: v3[field] });
  }
  for (const pendingReferenceKind of [undefined, "policy", "amount", "invalid"]) invalid({ ...v3, pendingReferenceKind });
  invalid({ ...v3, orderChoices: { ...choices, pending: false } });
  for (const pendingReferenceKind of ["policy", undefined] as const) {
    assert.equal(validate({ ...v3, pendingReferenceKind, orderChoices: { ...choices, pending: false } }).version, 3);
  }
  assert.deepEqual(validate({ version: 3, requiresRestatement: true, pendingReferenceKind: "order" }),
    { version: 3, requiresRestatement: true, pendingReferenceKind: "order" });
  assert.equal(validate({ version: 3, requiresRestatement: true, pendingReferenceKind: "policy" }).version, 3);

  const expired3 = validate(v3, a.expiresAt);
  assert.ok(expired3.version === 3);
  assert.deepEqual(expired3.policyChoices, { candidates: [policyChoices.candidates[1]], overflow: false, selectionRequired: true });
  assert.deepEqual(expired3.amountChoices, { candidates: [amountChoices.candidates[1]], overflow: false, selectionRequired: true });
  assert.equal(expired3.pendingReferenceKind, "order"); assert.equal(expired3.requiresRestatement, true);
  const gone3 = validate(expired3, b.expiresAt);
  assert.ok(gone3.version === 3);
  assert.deepEqual(gone3.policyChoices, { candidates: [], overflow: false, selectionRequired: true });
  assert.deepEqual(gone3.amountChoices, { candidates: [], overflow: false, selectionRequired: true });
  for (const field of ["policyChoices", "amountChoices"] as const) {
    const original = v3[field], single = { ...original, candidates: [original.candidates[0]] };
    const aged = validate({ version: 3, requiresRestatement: false, [field]: single }, a.expiresAt);
    assert.ok(aged.version === 3); assert.equal(aged[field]?.selectedRequestId, undefined);
    assert.equal(aged[field]?.selectionRequired, true, "an expired selected singleton must not silently choose a future candidate");
    const overflow = validate({ version: 3, requiresRestatement: false, [field]: { ...single, overflow: true } });
    assert.ok(overflow.version === 3); assert.equal(overflow[field]?.selectionRequired, true);
    for (const patch of [{ selectedRequestId: "unlisted" }, { selectedRequestId: " leading" }, { selectedRequestId: 7 },
      { token: "discarded" }, { selectedToken: "discarded" }, { presentation: {} }, { overflow: "true" }, { selectionRequired: 1 },
      { candidates: new Array(1) }, { candidates: [original.candidates[0], original.candidates[0]] }]) invalid({ ...v3, [field]: { ...original, ...patch } });
    for (const expiresAt of [now + ttl + 1, Number.MAX_SAFE_INTEGER + 1, now + 0.5, 0, NaN]) {
      invalid({ ...v3, [field]: { ...single, candidates: [{ ...original.candidates[0], expiresAt }] } });
    }
  }
  const kept = validate({ ...v3, focus: liveFocus }, a.expiresAt);
  assert.equal(kept.requiresRestatement, false); assert.deepEqual(kept.focus, liveFocus);
  assert.deepEqual(validate({ ...v3, focus }, a.expiresAt, true), expired3, "expired focus must not delete either independent reference group");
  const independent = validate({ ...v3, amountChoices: { ...amountChoices,
    candidates: amountChoices.candidates.map(candidate => ({ ...candidate, expiresAt: b.expiresAt })) } }, a.expiresAt);
  assert.ok(independent.version === 3); assert.equal(independent.amountChoices?.selectedRequestId, amount.requestId);
  assert.equal(independent.policyChoices?.selectedRequestId, undefined, "one group's expiry must not clear another live selection");
  invalid({ ...v3, policyChoices: { ...policyChoices, selectedRequestId: undefined,
    candidates: [0, 1, 2, 3].map(i => ({ topic: { ...topic, requestId: `policy-${i}` }, expiresAt: a.expiresAt })) } });
  invalid({ ...v3, amountChoices: { ...amountChoices, selectedRequestId: undefined,
    candidates: [0, 1, 2].map(i => ({ reference: { ...amount, requestId: `amount-${i}`, itemId: `item-${i}` }, expiresAt: a.expiresAt })) } });
  invalid({ ...v3, amountChoices: { ...amountChoices, candidates: [amountChoices.candidates[0], { reference: { ...amount, requestId: "amount-distinct" }, expiresAt: now - 1 }] } });
  for (const patch of [{ sourceKey: "forged" }, { groupOpenid: "forged" }, { requestId: "bad\nrequest" }, { orderId: "COUPON-12" },
    { originalQuery: "x".repeat(501) }, { originalQuery: "x".repeat(490) }, { scope: { ...topic.scope, extra: true } },
    { sources: [] }, { sources: [{ sourceId: "RULE-A", version: "not-a-hash" }] }, { sources: [topic.sources[0], topic.sources[0]] },
    { sources: [{ ...topic.sources[0], approved: true }] }, { sources: new Array(1) },
    { priorQueries: [{ requestId: topic.requestId, originalQuery: "重复本轮来源" }] }, { priorQueries: new Array(1) },
    { priorQueries: [{ requestId: "bad\nrequest", originalQuery: "过去问题" }] },
    { priorQueries: [{ requestId: "prior", originalQuery: "过去问题", answer: "不保存回答" }] },
    { priorQueries: Array.from({ length: 5 }, (_, i) => ({ requestId: `prior-${i}`, originalQuery: "过去问题" })) }]) {
    invalid({ ...v3, policyChoices: { ...policyChoices, candidates: [{ topic: { ...topic, ...patch }, expiresAt: a.expiresAt }] } });
  }
  for (const patch of [{ sourceKey: "forged" }, { groupOpenid: "forged" }, { requestId: "bad\nrequest" }, { itemId: "" },
    { productId: "x".repeat(513) }, { orderId: "COUPON-12" }, { paidCents: 0 }, { paidCents: -1 }, { paidCents: 79.8 },
    { paidCents: Number.MAX_SAFE_INTEGER + 1 }, { field: "refund_approved" }, { refundApproved: true }, { orderVersion: "not-a-hash" }]) {
    invalid({ ...v3, amountChoices: { ...amountChoices, candidates: [{ reference: { ...amount, ...patch }, expiresAt: a.expiresAt }] } });
  }

  // Exercise the store read boundary without a database: malformed stored JSON fails closed.
  const row = { bound_customer_id: "synthetic", bound_identity_id: "41", recorded_customer_id: "synthetic",
    recorded_identity_id: "41", revision: 7, context_json: "" };
  const readStore = new ConversationStateStore({ execute: async () => [[row]] } as unknown as Pool);
  const port = readStore.bind({ appId: "STATE_VALUE_CHECK", senderId: "OWNER" }, "GROUP");
  for (const stored of ["{bad json", JSON.stringify({ ...v2, unexpected: true }), JSON.stringify({ ...v2, version: 0 })]) {
    row.context_json = stored;
    assert.deepEqual(await port.read(), { revision: 7, customerId: "synthetic", bindingId: "41", value: { version: 1, requiresRestatement: true } });
  }
  row.context_json = JSON.stringify({ version: 1, requiresRestatement: true });
  assert.deepEqual((await port.read()).value, { version: 1, requiresRestatement: true });
  const storedAt = Date.now(), stored3 = { ...v3,
    focus: { ...focus, selectedAt: storedAt, expiresAt: storedAt + 60_000 },
    orderChoices: { ...choices, candidates: choices.candidates.map(candidate => ({ ...candidate, expiresAt: storedAt + 60_000 })) },
    policyChoices: { ...policyChoices, candidates: policyChoices.candidates.map(candidate => ({ ...candidate, expiresAt: storedAt + 60_000 })) },
    amountChoices: { ...amountChoices, candidates: amountChoices.candidates.map(candidate => ({ ...candidate, expiresAt: storedAt + 60_000 })) } };
  row.context_json = JSON.stringify(stored3);
  assert.deepEqual((await port.read()).value, validateSupportContextValue(stored3));
  row.context_json = JSON.stringify({ ...stored3, amountChoices: { ...stored3.amountChoices, selectedRequestId: "missing" } });
  assert.deepEqual((await port.read()).value, { version: 1, requiresRestatement: true }, "one malformed v3 group invalidates the whole stored record");
  row.recorded_identity_id = "40";
  assert.deepEqual(await port.read(), { revision: 7, customerId: "synthetic", bindingId: "41" }, "same-customer rebinding cannot recover the old value");

  // The transaction must authorize every distinct live order, including candidates not in focus.
  const authorized: string[] = []; let written: SupportContextValue | undefined, denied: string | undefined, rolledBack = 0;
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => { rolledBack++; }, release: () => {},
    execute: async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM qq_identities")) return [[{ customer_id: "synthetic", binding_id: "41" }]];
      if (sql.includes("SELECT revision")) return [[{ revision: 7 }]];
      if (sql.includes("FROM orders")) { const id = String(params[0]); authorized.push(id); assert.equal(params[1], "synthetic"); return [id === denied ? [] : [{ id }]]; }
      assert.ok(sql.includes("UPDATE conversation_state")); written = JSON.parse(String(params[3])) as SupportContextValue; return [{ affectedRows: 1 }];
    } };
  const writeStore = new ConversationStateStore({ getConnection: async () => connection } as unknown as Pool);
  const writePort = writeStore.bind({ appId: "STATE_VALUE_CHECK", senderId: "OWNER" }, "GROUP");
  const at = Date.now(), input: SupportContextValue = { ...v2, focus: { ...focus, selectedAt: at, expiresAt: at + 60_000 },
    orderChoices: { ...choices, candidates: [a, b].map(candidate => ({ ...candidate, expiresAt: at + 60_000 })) } };
  const expected = { revision: 7, customerId: "synthetic", bindingId: "41" };
  const saved = await writePort.write(expected, input);
  assert.deepEqual(authorized, [a.orderId, b.orderId]); assert.deepEqual(saved.value, written); assert.equal(saved.revision, 8);
  authorized.length = 0; written = undefined; denied = b.orderId;
  await assert.rejects(writePort.write(expected, input), ConversationStateError);
  assert.deepEqual(authorized, [a.orderId, b.orderId]); assert.equal(written, undefined); assert.equal(rolledBack, 1);
  const input3: SupportContextValue = { version: 3, requiresRestatement: false, focus: input.focus,
    policyChoices: { ...policyChoices, candidates: [{ topic: { ...topic, orderId: "COUPON-4703" }, expiresAt: at + 60_000 },
      { topic: otherTopic, expiresAt: at + 60_000 }] },
    amountChoices: { ...amountChoices, candidates: [{ reference: amount, expiresAt: at + 60_000 },
      { reference: { ...otherAmount, orderId: "COUPON-4704" }, expiresAt: at + 60_000 }] } };
  authorized.length = 0; denied = undefined;
  const saved3 = await writePort.write(expected, input3);
  assert.deepEqual(authorized, [a.orderId, "COUPON-4703", "COUPON-4704"], "null global policy skips order authorization; other policy/amount orders do not");
  assert.deepEqual(saved3.value, written);
  for (const unauthorized of ["COUPON-4703", "COUPON-4704"]) {
    denied = unauthorized; authorized.length = 0; written = undefined;
    await assert.rejects(writePort.write(expected, input3), ConversationStateError);
    assert.ok(authorized.includes(unauthorized)); assert.equal(written, undefined);
  }
  assert.equal(rolledBack, 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkConversationStateValue(); console.log("Conversation state value checks passed (no database or API calls)");
}
