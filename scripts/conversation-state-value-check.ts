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

  for (const bad of [null, [], {}, { ...v2, version: 3 }, { ...v2, requiresRestatement: 1 }, { ...v2, token: "old-token" },
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkConversationStateValue(); console.log("Conversation state value checks passed (no database or API calls)");
}
