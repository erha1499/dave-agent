import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Type, validateToolArguments, type Static, type ToolCall } from "@earendil-works/pi-ai";

const str = Type.String({ minLength: 1, maxLength: 3000 });
const ref = Type.String({ pattern: "^[a-z][a-z0-9_]*$" });
const dynamicRef = Type.String({ pattern: "^(tasks|operations)\\.[a-z][a-z0-9_]*$" });
const strings = Type.Array(str, { uniqueItems: true });
const cents = Type.Integer({ minimum: 0, maximum: 1_000_000 });
const nullableCents = Type.Union([cents, Type.Null()]);
const option = <const T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>(Type.Union(values.map(value => Type.Literal(value))));
const obj = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false });
const inputSchema = Type.Union([
  obj({ type: Type.Literal("user"), session: ref, text: str }),
  obj({ type: Type.Literal("confirmation"), session: ref, command: option(["merchant", "refund"]), text: str, orderRef: ref, operationRef: Type.Optional(dynamicRef) }),
  obj({ type: Type.Literal("merchant_result"), taskRef: dynamicRef, orderRef: ref, status: option(["approved", "rejected"]), approvedAmountCents: nullableCents }),
  obj({ type: Type.Literal("merchant_timeout"), taskRef: dynamicRef, orderRef: ref }),
  obj({ type: Type.Literal("dispatch_notifications"), sessions: Type.Array(ref, { minItems: 1, uniqueItems: true }), taskRefs: Type.Array(dynamicRef, { minItems: 1, uniqueItems: true }) }),
  obj({ type: Type.Literal("fixture_change"), orderRef: ref, change: option(["expire_refund", "invalidate_approval"]), operationRef: dynamicRef }),
  obj({ type: Type.Literal("restart"), sessions: Type.Array(ref, { minItems: 1, uniqueItems: true }), persist: strings, clear: strings }),
  obj({ type: Type.Literal("compact"), sessions: Type.Array(ref, { minItems: 1, uniqueItems: true }), preserve: strings, discardOlderMessages: Type.Literal(true) }),
]);
const service = option(["get_order", "search_faq", "prepare_merchant_request", "get_merchant_request", "prepare_refund", "get_refund", "confirm_refund", "request_merchant"]);
const expectation = obj({
  action: option(["order", "policy", "refund_eligibility", "merchant_prepare", "merchant_status", "refund_prepare", "refund_status", "clarify", "host_confirm_merchant", "host_confirm_refund", "merchant_result", "merchant_timeout", "dispatch_notifications", "fixture_change", "restart", "compact"]),
  branch: option(["read", "missing_evidence", "clarification", "denied", "merchant_confirmation", "confirmation_required", "merchant_pending", "merchant_terminal", "notification", "merchant_blocked", "refund_prepared", "refund_succeeded", "refund_idempotent", "fixture_only", "recovery"]),
  orderRef: Type.Union([ref, Type.Null()]),
  services: obj({ requiredInOrder: Type.Array(service), denied: Type.Array(service, { uniqueItems: true }), forbidden: Type.Array(service, { uniqueItems: true }) }),
  evidence: obj({ requiredPolicyIds: strings, forbiddenPolicyIds: strings, currentTurnOnly: Type.Literal(true), forbiddenClaims: Type.Optional(strings) }),
  reply: obj({ kind: option(["answer", "order", "notice", "merchant_confirmation", "merchant_status", "refund_confirmation", "refund_status", "none"]), session: Type.Union([ref, Type.Null()]), simulationLabel: Type.Literal(true) }),
  db: obj({ ordersUnchanged: Type.Boolean(), refundRowsDelta: Type.Integer({ minimum: 0, maximum: 1 }), merchantTaskRowsDelta: Type.Integer({ minimum: 0, maximum: 1 }),
    operationMutation: option(["none", "prepared", "renewed", "succeeded", "fixture_expired"]), notificationSentDelta: Type.Integer({ minimum: 0, maximum: 1 }),
    taskStatus: Type.Optional(option(["pending", "approved", "rejected", "timed_out"])), operationStatus: Type.Optional(option(["awaiting_confirmation", "succeeded"])),
    amountCents: Type.Optional(cents), approvedAmountCents: Type.Optional(cents) }),
  captures: Type.Array(obj({ ref: dynamicRef, from: option(["reply.task.taskId", "reply.operation.operationId"]), orderRef: ref })),
  expectFacts: Type.Optional(Type.Record(str, Type.Union([Type.Boolean(), cents]))),
  expectRelations: Type.Optional(Type.Array(obj({ left: dynamicRef, operator: Type.Literal("not_equal"), right: dynamicRef }))),
});
const template = obj({ seedOrderId: Type.String({ pattern: "^COUPON-\\d{4}$" }), shopId: str,
  status: option(["paid", "pending_payment", "refunded", "partially_redeemed", "redeemed"]), totalCents: cents, paidCents: cents, refundedCents: cents,
  items: Type.Array(obj({ productId: str, quantity: Type.Integer({ minimum: 1, maximum: 2 }), unitPriceCents: cents, totalCents: cents }), { minItems: 1 }),
  coupons: Type.Array(obj({ status: option(["unused", "expired", "refunded", "redeemed"]), expiresAfterAnchorDays: Type.Integer({ minimum: -30, maximum: 30 }) })),
  payment: obj({ status: option(["pending", "succeeded"]), amountCents: cents }),
  historicalRefunds: obj({ count: Type.Integer({ minimum: 0, maximum: 1 }), succeededCents: cents }),
});
// The schema is also the future runner's input contract; it does not execute these cases.
export const supportValidationSchema = obj({
  version: Type.Literal(1), suiteId: Type.Literal("support-business-fixed-validation-v1"), scope: Type.Literal("objective-and-evidence-contract"),
  answerQuality: Type.Literal("not_evaluated"), validationPolicy: Type.Literal("fixed-validation-not-blind"), provenance: str, runnerStatus: str,
  counts: obj({ readonly: Type.Literal(8), aftersales: Type.Literal(8), isolation: Type.Literal(4), recovery: Type.Literal(4), total: Type.Literal(24), readyForRunner: Type.Literal(20), deferredO4: Type.Literal(4) }),
  actorBindings: Type.Record(ref, obj({ appId: str, senderId: str, customerId: str })),
  sessions: Type.Record(ref, obj({ actor: ref, groupRef: ref })),
  fixturePolicy: obj({ creation: str, cleanup: str, preconditions: str, clock: str,
    merchantTiming: obj({ holdMethod: Type.Literal("createMerchantFixture.holdMerchant"), holdMs: Type.Literal(180000),
      apply: Type.Literal("after_request_and_before_each_turn_to_pending_owned_tasks"), ownership: Type.Literal("nonce-owned fixture orders only"),
      timeoutMethod: Type.Literal("createMerchantFixture.expire then AfterSalesStore.processDue"), productionDeadlineChanged: Type.Literal(false) }),
    qqSend: Type.Literal("local capture substitute only"), sourceKey: str, notation: str, dbDeltaScope: str, replySession: str }),
  globalInvariants: strings, orderTemplates: Type.Record(ref, template),
  cases: Type.Array(obj({ id: Type.String({ pattern: "^SV-(RO|AS|IS|RC)-\\d{2}$" }), category: option(["readonly", "aftersales", "isolation", "recovery"]), name: str,
    status: option(["ready_for_runner", "deferred"]), deferredReason: Type.Union([Type.Null(), Type.Literal("O4")]),
    fixtures: obj({ orders: Type.Array(obj({ ref, template: ref, owner: ref, merchantOutcome: option(["approve", "reject", "timeout"]) }), { minItems: 1, maxItems: 2 }),
      preconditions: Type.Array(Type.Union([
        obj({ type: Type.Literal("merchant_task"), orderRef: ref, session: ref, status: Type.Literal("approved"), reason: str, approvedAmountCents: cents, bind: dynamicRef }),
        obj({ type: Type.Literal("refund_presented"), orderRef: ref, session: ref, taskRef: dynamicRef, bind: dynamicRef, amountCents: cents }),
      ])) }),
    turns: Type.Array(obj({ index: Type.Integer({ minimum: 1 }), input: inputSchema, expect: expectation }), { minItems: 1 }),
  }), { minItems: 24, maxItems: 24 }),
});
export type SupportValidationDataset = Static<typeof supportValidationSchema>;

export function validateSupportValidationDataset(value: unknown): SupportValidationDataset {
  const args = { dataset: value };
  const parsed = validateToolArguments({ name: "fixed_validation", description: "validate frozen synthetic business cases", parameters: Type.Object({ dataset: supportValidationSchema }) },
    { type: "toolCall", id: "validate-support-data", name: "fixed_validation", arguments: args as ToolCall["arguments"] });
  assert.ok(isDeepStrictEqual(parsed, args), "schema must not coerce fixed evidence");
  const data = parsed.dataset as SupportValidationDataset;
  assert.ok(isDeepStrictEqual(data.actorBindings, { alice: { appId: "TEST_APP", senderId: "TEST_USER1", customerId: "customer-demo-1" }, bob: { appId: "TEST_APP", senderId: "TEST_USER2", customerId: "customer-demo-2" } }));
  assert.ok(isDeepStrictEqual(data.sessions, { alice_main: { actor: "alice", groupRef: "main" }, bob_main: { actor: "bob", groupRef: "main" }, alice_other: { actor: "alice", groupRef: "other" } }));
  assert.deepEqual(data.globalInvariants, ["trusted_identity_only", "current_scope_evidence_only", "host_confirmation_only", "no_cross_order_mutation", "refund_at_most_once", "no_live_qq_delivery", "fixed_planned_denominator"]);
  assert.equal(new Set(data.cases.map(c => c.id)).size, 24);
  for (const category of ["readonly", "aftersales", "isolation", "recovery"] as const) assert.equal(data.cases.filter(c => c.category === category).length, data.counts[category]);
  for (const session of Object.values(data.sessions)) assert.ok(data.actorBindings[session.actor], "session actor must be trusted fixture binding");
  for (const state of Object.values(data.orderTemplates)) {
    assert.equal(state.items.reduce((n, item) => n + item.totalCents, 0), state.totalCents);
    assert.ok(state.items.every(item => item.totalCents === item.unitPriceCents * item.quantity));
    assert.ok(state.refundedCents <= state.paidCents && state.paidCents <= state.totalCents);
    assert.equal(state.historicalRefunds.succeededCents, state.refundedCents);
    assert.equal(state.payment.amountCents, state.totalCents);
    assert.equal(state.payment.status === "pending", state.paidCents === 0);
    assert.ok(state.coupons.every(c => c.status !== "expired" || c.expiresAfterAnchorDays < 0));
  }
  for (const example of data.cases) {
    assert.equal(example.status === "deferred", example.category === "recovery");
    assert.equal(example.deferredReason, example.category === "recovery" ? "O4" : null);
    assert.equal(example.turns.some(t => t.input.type === "restart" || t.input.type === "compact"), example.category === "recovery");
    const prefix = { readonly: "RO", aftersales: "AS", isolation: "IS", recovery: "RC" }[example.category];
    assert.ok(example.id.startsWith(`SV-${prefix}-`));
    const orders = new Map(example.fixtures.orders.map(o => [o.ref, o]));
    assert.equal(orders.size, example.fixtures.orders.length);
    const refs = new Map(example.fixtures.orders.map(o => [`orders.${o.ref}`, o.ref]));
    const ownedBy = (orderRef: string, session: string) => {
      assert.ok(orders.has(orderRef)); assert.ok(data.sessions[session]);
      return orders.get(orderRef)!.owner === data.sessions[session]!.actor;
    };
    for (const order of orders.values()) assert.ok(data.orderTemplates[order.template] && data.actorBindings[order.owner]);
    for (const setup of example.fixtures.preconditions) {
      assert.ok(ownedBy(setup.orderRef, setup.session), "fixture setup cannot create another actor's operation");
      assert.equal(data.orderTemplates[orders.get(setup.orderRef)!.template]!.status, "paid");
      assert.ok(!refs.has(setup.bind), "fixture bindings are unique");
      assert.equal(setup.bind.startsWith("tasks."), setup.type === "merchant_task");
      const amount = data.orderTemplates[orders.get(setup.orderRef)!.template]!.paidCents;
      if (setup.type === "refund_presented") {
        assert.equal(refs.get(setup.taskRef), setup.orderRef, "refund setup requires the already-bound task");
        assert.equal(setup.amountCents, amount);
      } else assert.equal(setup.approvedAmountCents, amount);
      refs.set(setup.bind, setup.orderRef);
    }
    const taskSession = new Map(example.fixtures.preconditions.filter(s => s.type === "merchant_task").map(s => [s.orderRef, s.session]));
    const operationSession = new Map(example.fixtures.preconditions.filter(s => s.type === "refund_presented").map(s => [s.bind, s.session]));
    for (const [index, round] of example.turns.entries()) {
      assert.equal(round.index, index + 1);
      const { input, expect } = round;
      if ("session" in input) assert.ok(data.sessions[input.session]);
      if ("sessions" in input) assert.ok(input.sessions.every(session => !!data.sessions[session]));
      if (expect.orderRef !== null) assert.ok(orders.has(expect.orderRef));
      if ("orderRef" in input) assert.equal(input.orderRef, expect.orderRef);
      const inputJson = JSON.stringify(input);
      const needed = [...inputJson.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1]!);
      assert.ok(!inputJson.replace(/\{\{[^{}]+\}\}/g, "").includes("{{"), "malformed runtime placeholder");
      if ("taskRef" in input) needed.push(input.taskRef);
      if ("operationRef" in input && input.operationRef) needed.push(input.operationRef);
      if ("taskRefs" in input) needed.push(...input.taskRefs);
      for (const token of needed) assert.ok(refs.has(token), `undefined or forward reference: ${example.id}/${round.index} ${token}`);
      if ("operationRef" in input && input.operationRef) assert.equal(refs.get(input.operationRef), input.orderRef);
      if ("taskRef" in input) assert.equal(refs.get(input.taskRef), input.orderRef);
      if (input.type === "merchant_result") assert.equal(input.approvedAmountCents, input.status === "approved"
        ? data.orderTemplates[orders.get(input.orderRef)!.template]!.paidCents : null);
      assert.equal(expect.reply.kind === "none", expect.reply.session === null);
      if ("session" in input) assert.equal(expect.reply.session, input.session);
      if (expect.reply.session) assert.ok(data.sessions[expect.reply.session]);
      assert.ok(expect.services.denied.every(call => expect.services.requiredInOrder.includes(call)));
      assert.ok(expect.services.forbidden.every(call => !expect.services.requiredInOrder.includes(call)));
      assert.ok(expect.evidence.requiredPolicyIds.every(id => !expect.evidence.forbiddenPolicyIds.includes(id)));
      if (input.type === "user") {
        assert.ok(expect.services.forbidden.includes("confirm_refund") && expect.services.forbidden.includes("request_merchant"));
        if (expect.orderRef && !ownedBy(expect.orderRef, input.session)) assert.equal(expect.branch, "denied");
      }
      if (input.type === "confirmation") {
        assert.equal(expect.action, input.command === "refund" ? "host_confirm_refund" : "host_confirm_merchant");
        if (input.command === "refund") {
          assert.ok(input.operationRef?.startsWith("operations."));
          assert.equal(input.text, `确认退款 {{${input.operationRef}}}`);
          if (!ownedBy(input.orderRef, input.session) || operationSession.get(input.operationRef!) !== input.session) assert.equal(expect.branch, "denied", "cross actor or route confirmation must be denied");
        } else {
          assert.equal(input.operationRef, undefined);
          assert.ok(input.text.startsWith(`确认联系商家 {{orders.${input.orderRef}}} 原因：`) && !/[\r\n]/.test(input.text));
          assert.ok(ownedBy(input.orderRef, input.session)); taskSession.set(input.orderRef, input.session);
        }
      }
      if (input.type === "dispatch_notifications" && expect.reply.kind !== "none") {
        assert.equal(expect.reply.session, taskSession.get(expect.orderRef!));
        assert.ok(input.sessions.includes(expect.reply.session!));
      }
      if (input.type === "restart" || input.type === "compact") assert.equal(example.deferredReason, "O4");
      if (expect.db.refundRowsDelta > 0 || !expect.db.ordersUnchanged || expect.db.operationMutation === "succeeded") {
        assert.equal(input.type, "confirmation"); assert.equal(expect.action, "host_confirm_refund"); assert.equal(expect.branch, "refund_succeeded");
      }
      if (expect.db.merchantTaskRowsDelta > 0) assert.equal(expect.action, "host_confirm_merchant");
      if (expect.branch === "denied") assert.ok(expect.db.ordersUnchanged && expect.db.refundRowsDelta === 0 && expect.db.operationMutation === "none");
      if (example.category === "readonly") assert.ok(expect.db.ordersUnchanged && expect.db.refundRowsDelta === 0 && expect.db.merchantTaskRowsDelta === 0 && expect.db.operationMutation === "none");
      for (const capture of expect.captures) {
        assert.ok(!refs.has(capture.ref)); assert.equal(capture.orderRef, expect.orderRef);
        assert.equal(capture.from.startsWith("reply.task"), capture.ref.startsWith("tasks."));
        assert.equal(expect.action, capture.ref.startsWith("tasks.") ? "host_confirm_merchant" : "refund_prepare");
        refs.set(capture.ref, capture.orderRef);
        if (capture.ref.startsWith("operations.")) operationSession.set(capture.ref, expect.reply.session!);
      }
      for (const relation of expect.expectRelations ?? []) {
        assert.ok(refs.has(relation.left) && refs.has(relation.right));
        assert.notEqual(relation.left, relation.right);
      }
    }
  }
  return data;
}

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const implementationContractPath = "data/support-v2-validation-contract-v2.json";
const implementationContractSha256 = "d6e2e9a898428979a1aa3c8f59e71199eb4389d5786119876902ec01c83a30cf";

// The sidecar is an explicit implementation revision, not an equivalence claim.
// Pin its bytes so changing source + manifest together still requires a reviewed checker update.
function readImplementationContract(bytes: Buffer, sourceBytes: Buffer) {
  assert.equal(hash(bytes), implementationContractSha256, "implementation revision drift");
  const revision = JSON.parse(bytes.toString()), source = JSON.parse(sourceBytes.toString());
  assert.equal(revision.version, 2);
  assert.equal(revision.baselineSource.path, "data/support-v2-validation-source.json");
  assert.equal(revision.baselineSource.sha256, hash(sourceBytes), "frozen source manifest drift");
  assert.deepEqual(revision.dataset, source.dataset, "fixed gold must not change with implementation");
  assert.equal(revision.change.path, "src/after-sales.ts");
  assert.equal(revision.change.fromSha256, source.contracts[revision.change.path]);
  assert.equal(revision.change.byteEquivalent, false);
  assert.equal(revision.migration.path, "db/09-merchant-references.sql");
  return revision;
}

// This reviewed attribution revision is separate from the frozen business oracle.
// The first 7651 bytes end at supportObjectivePlan and match the original source exactly.
// Pin both ranges and the full new file: changing source + manifest still needs review.
const attributionRevision = Object.freeze({
  contract: "docs/experiment-controls.md#本轮工作台接线合同2026-10-06实施前",
  frozenSha256: "216410320baf42fe24ce033780885342f486e810033e08c8e2295c1866bcb558",
  actualSha256: "4bbedc28c9179bb902629a32d787b3330415dc93e70ac658fc5edede0b5614de",
  businessOracleBytes: 7651,
  businessOracleSha256: "10c4fbff6ca81e0ba46bb0d11808c68a830077b083749e9c54584a890dc373ba",
  attributionSha256: "0bfb076f286a4952bd3a69bec52c315a047478aca105bdbf0e591552a80e1e0c",
});

// Other files remain frozen. Retain the earlier normalized price-label compatibility;
// the provider ledger is an explicit reviewed change, never whole-file equivalence.
function assertFrozenContract(path: string, bytes: Buffer, expected: string) {
  const actual = hash(bytes);
  if (actual === expected) return null;
  assert.equal(path, "src/support-evaluation.ts", `contract drift: ${path}`);
  const text = bytes.toString();
  if (text.includes("export type ProviderUsageSummary = {")) {
    assert.equal(expected, attributionRevision.frozenSha256, "attribution revision must name the original implementation");
    assert.equal(hash(bytes.subarray(0, attributionRevision.businessOracleBytes)), attributionRevision.businessOracleSha256, "frozen business oracle drift");
    assert.equal(hash(bytes.subarray(attributionRevision.businessOracleBytes)), attributionRevision.attributionSha256, "reviewed attribution drift");
    assert.equal(actual, attributionRevision.actualSha256, "reviewed attribution implementation drift");
    return { path, frozenSha256: expected, actualSha256: actual, byteEquivalent: false,
      businessOracle: { bytes: attributionRevision.businessOracleBytes, sha256: attributionRevision.businessOracleSha256, byteEquivalent: true },
      attributionRevision: { contract: attributionRevision.contract, sha256: attributionRevision.attributionSha256 },
      change: "reviewed provider role/currency ledger analysis; fixed business oracle bytes unchanged, not executed" };
  }
  const previous = '["sdk_estimate", "provider"].includes(cost.source)';
  const current = '["sdk_estimate", "provider", "price_estimate"].includes(cost.source)';
  assert.equal(text.split(current).length, 2, `contract drift: ${path}`);
  assert.equal(hash(text.replace(current, previous)), expected, `business contract drift: ${path}`);
  return { path, frozenSha256: expected, actualSha256: actual, byteEquivalent: false,
    change: "additive price_estimate cost source; business oracle unchanged, attribution revised" };
}

function assertRevisedContract(path: string, bytes: Buffer, expected: string, revision: ReturnType<typeof readImplementationContract>) {
  if (path !== revision.change.path) return assertFrozenContract(path, bytes, expected);
  assert.equal(expected, revision.change.fromSha256, "revision must name the original implementation");
  assert.equal(hash(bytes), revision.change.toSha256, `implementation v2 drift: ${path}`);
  return { path, frozenSha256: expected, actualSha256: hash(bytes), revision: 2, byteEquivalent: false,
    change: "task binding generation and strict automatic references/notifications; fixed gold unchanged, not executed" };
}

export async function loadSupportValidationData() {
  const bytes = await readFile(new URL("../data/support-v2-validation.json", import.meta.url));
  const sourceBytes = await readFile(new URL("../data/support-v2-validation-source.json", import.meta.url));
  const source = JSON.parse(sourceBytes.toString());
  const revision = readImplementationContract(await readFile(new URL(`../${implementationContractPath}`, import.meta.url)), sourceBytes);
  assert.equal(hash(await readFile(new URL(`../${revision.migration.path}`, import.meta.url))), revision.migration.sha256, "implementation migration drift");
  assert.equal(source.version, 1); assert.equal(source.validationPolicy, "fixed-validation-not-blind");
  assert.equal(source.dataset.path, "data/support-v2-validation.json"); assert.equal(source.dataset.sha256, hash(bytes)); assert.equal(source.dataset.bytes, bytes.length);
  const contracts = ["db/02-seed.sql", "db/05-merchant.sql", "src/support-action.ts", "src/support-evaluation.ts", "src/after-sales-entry.ts", "src/refund-entry.ts", "src/refunds.ts", "src/after-sales.ts", "scripts/merchant-test-fixture.ts"];
  assert.deepEqual(Object.keys(source.contracts), contracts);
  const compatibility = [];
  for (const path of contracts) {
    const allowed = assertRevisedContract(path, await readFile(new URL(`../${path}`, import.meta.url)), source.contracts[path], revision);
    if (allowed) compatibility.push(allowed);
  }
  const data = validateSupportValidationDataset(JSON.parse(bytes.toString()));
  assert.equal(source.dataset.cases, data.cases.length); assert.equal(source.dataset.turns, data.cases.reduce((n, c) => n + c.turns.length, 0));
  const seed = await readFile(new URL("../db/02-seed.sql", import.meta.url), "utf8");
  for (const state of Object.values(data.orderTemplates)) assert.ok(seed.includes(`('${state.seedOrderId}'`) && seed.includes(state.items[0]!.productId));
  const knownPolicies = new Set([...seed.matchAll(/\('(KB-[A-Z0-9-]+)'/g)].map(m => m[1]));
  for (const c of data.cases) for (const t of c.turns) for (const id of [...t.expect.evidence.requiredPolicyIds, ...t.expect.evidence.forbiddenPolicyIds]) assert.ok(knownPolicies.has(id), `unknown policy ${id}`);
  return { data, source, compatibility, revision };
}

const { data, source, compatibility, revision } = await loadSupportValidationData();
const checkerPath = "src/support-evaluation.ts";
const checkerBytes = await readFile(new URL(`../${checkerPath}`, import.meta.url));
assert.throws(() => assertFrozenContract(checkerPath, Buffer.concat([checkerBytes, Buffer.from("\n// unexpected drift")]), source.contracts[checkerPath]));
assert.throws(() => assertFrozenContract("src/refunds.ts", checkerBytes, source.contracts["src/refunds.ts"]));
const businessDrift = Buffer.from(checkerBytes);
businessDrift[0] = businessDrift[0]! ^ 1;
assert.throws(() => assertFrozenContract(checkerPath, businessDrift, source.contracts[checkerPath]), /frozen business oracle drift/);
assert.throws(() => assertFrozenContract(checkerPath,
  Buffer.from(checkerBytes.toString().replace('"support-question" ? "question"', '"support-question" ? "other"')),
  source.contracts[checkerPath]), /reviewed attribution drift/);
assert.throws(() => assertFrozenContract(checkerPath, checkerBytes, "0".repeat(64)), /must name the original implementation/);
const revisedBytes = await readFile(new URL(`../${revision.change.path}`, import.meta.url));
assert.throws(() => assertRevisedContract(revision.change.path, Buffer.concat([revisedBytes, Buffer.from("\n// unexpected drift")]), source.contracts[revision.change.path], revision));
assert.throws(() => assertRevisedContract(revision.change.path, revisedBytes, "0".repeat(64), revision));
const sourceBytes = await readFile(new URL("../data/support-v2-validation-source.json", import.meta.url));
const revisionBytes = await readFile(new URL(`../${implementationContractPath}`, import.meta.url));
assert.throws(() => readImplementationContract(revisionBytes, Buffer.concat([sourceBytes, Buffer.from("\n")])));
for (const mutate of [
  (copy: typeof revision) => { copy.version = 3; },
  (copy: typeof revision) => { copy.change.path = "src/refunds.ts"; },
  (copy: typeof revision) => { copy.change.fromSha256 = "0".repeat(64); },
  (copy: typeof revision) => { copy.change.toSha256 = "0".repeat(64); },
  (copy: typeof revision) => { delete copy.migration; },
  (copy: typeof revision) => { copy.migration.extraPath = "src/refunds.ts"; },
]) {
  const copy = structuredClone(revision); mutate(copy);
  assert.throws(() => readImplementationContract(Buffer.from(`${JSON.stringify(copy, null, 2)}\n`), sourceBytes));
}
assert.equal(compatibility.filter(item => "revision" in item).length, 1);
const ledgerCompatibility = compatibility.find(item => "attributionRevision" in item);
assert.ok(ledgerCompatibility && "businessOracle" in ledgerCompatibility && ledgerCompatibility.businessOracle
  && "attributionRevision" in ledgerCompatibility && ledgerCompatibility.attributionRevision);
assert.equal(ledgerCompatibility.byteEquivalent, false);
assert.equal(ledgerCompatibility.businessOracle.byteEquivalent, true);
assert.equal(ledgerCompatibility.attributionRevision.contract, attributionRevision.contract);
console.log("Support validation keeps original gold/source hashes; implementation v2 changes task binding/notification semantics. Business oracle bytes remain frozen; provider role/currency ledger is a reviewed hash-pinned attribution revision, not whole-file equivalence or business execution.");
function rejects(mutate: (copy: SupportValidationDataset) => void) {
  const copy = structuredClone(data); mutate(copy); assert.throws(() => validateSupportValidationDataset(copy));
}
rejects(copy => { copy.cases.pop(); });
rejects(copy => { copy.cases[0]!.turns[0]!.index = 2; });
rejects(copy => { copy.cases[0]!.turns[0]!.input = { type: "confirmation", session: "alice_main", command: "refund", text: "确认退款 {{operations.future}}", operationRef: "operations.future", orderRef: "primary" }; });
rejects(copy => { copy.cases.find(c => c.id === "SV-IS-02")!.turns[0]!.expect.branch = "refund_succeeded"; });
rejects(copy => { copy.cases[0]!.turns[0]!.expect.db.refundRowsDelta = 1; });
rejects(copy => { copy.cases.find(c => c.category === "recovery")!.deferredReason = null; });
rejects(copy => { copy.cases[0]!.fixtures.orders[0]!.owner = "unknown_actor"; });
rejects(copy => { copy.orderTemplates.paid_lunch!.paidCents = 9999; });
assert.throws(() => validateSupportValidationDataset({ ...data,
  fixturePolicy: { ...data.fixturePolicy, merchantTiming: { ...data.fixturePolicy.merchantTiming, holdMs: 8000 } } }));
assert.throws(() => validateSupportValidationDataset({ ...data,
  fixturePolicy: { ...data.fixturePolicy, merchantTiming: { ...data.fixturePolicy.merchantTiming, productionDeadlineChanged: true } } }));
console.log("Support fixed-validation data checks passed: 24 cases / 79 turns, actor/route scopes, runtime ID dependencies, confirmation-only mutations, versioned implementation contract; 4 O4 cases deferred, no DB/model/QQ execution.");
