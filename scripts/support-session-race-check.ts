import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createModelRuntime } from "../src/agent.ts";
import type { CouponStore } from "../src/coupon-store.ts";
import { cancelSupportTurn, createSupportSession, getSupportHostReceipt, getSupportResult, prepareSupportPrompt } from "../src/support-session.ts";

const identity = { appId: "RACE_CHECK", senderId: "OWNER" }, groupOpenid = "RACE_GROUP";
const command = "选择金额基准 11111111-1111-4111-8111-111111111111";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const runtime = await createModelRuntime(), faux = fauxProvider(); runtime.registerNativeProvider(faux.provider);
let reads = 0;
const store = { async getOrder() { reads++; throw new Error("unexpected business call"); }, async searchKnowledge() { throw new Error("unexpected knowledge call"); } } as unknown as CouponStore;
const hello = () => fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "non_business", reason: "greeting" } }), { stopReason: "toolUse" });
const finish = () => fauxAssistantMessage("你好。");

// A normal prompt used to await focus inside Pi's before_agent_start. Replacing
// it with a new host/normal ingress must not start the old provider or executor.
for (const replacement of ["host", "normal"] as const) for (const delayed of ["read", "write"] as const) {
  const entered = deferred(), release = deferred(); let first = true;
  const waitOnce = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid, focus: {
    read: async () => { if (delayed === "read") await waitOnce(); return undefined; },
    write: async () => { if (delayed === "write") await waitOnce(); },
  } });
  try {
    const before = faux.state.callCount;
    prepareSupportPrompt(session, { requestId: "old", groupOpenid, messageId: "old" });
    const old = session.prompt("查询 COUPON-4101").catch(error => error);
    await entered.promise;
    prepareSupportPrompt(session, { requestId: "new", groupOpenid, messageId: "new" });
    faux.setResponses(replacement === "host" ? [] : [hello(), finish()]);
    const next = session.prompt(replacement === "host" ? command : "你好");
    if (delayed === "write") {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(getSupportHostReceipt(session), undefined);
      assert.equal(getSupportResult(session), undefined);
      assert.equal(faux.state.callCount, before, "new turn waits for an already-issued context write to settle");
      release.resolve();
    }
    await next;
    const newResult = getSupportResult(session), newReceipt = getSupportHostReceipt(session);
    assert.equal(replacement === "host" ? newReceipt!.requestId : newResult!.evidence.requestId, "new");
    release.resolve(); assert.ok(await old instanceof Error);
    assert.equal(faux.state.callCount - before, replacement === "host" ? 0 : 2);
    assert.strictEqual(getSupportResult(session), newResult);
    assert.deepEqual(getSupportHostReceipt(session), newReceipt);
    assert.equal(reads, 0, "the superseded prompt cannot authorize even a fresh read");
  } finally { release.resolve(); session.dispose(); }
}

// Model cancellation cannot revoke an already-issued persistence call. A late
// initialization write applies only before the next turn's successful read/write.
{
  const entered = deferred(), release = deferred(); let firstWrite = true;
  let persisted: string | undefined = "COUPON-4100";
  const writes: Array<string | undefined> = [];
  const order = { source: "demo-database", id: "COUPON-4102", status: "paid", asOf: "2026-10-06T00:00:00.000Z",
    amounts: { totalCents: 100, paidCents: 100, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "shop", name: "门店", merchantName: "商家", address: "地址" },
    items: [{ id: "item", productId: "product", productName: "套餐", quantity: 1, unitPriceCents: 100, totalCents: 100 }],
    coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: "2027-01-01T00:00:00.000Z", redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 100, paidAt: null }], refunds: [] } as Awaited<ReturnType<CouponStore["getOrder"]>>;
  const session = await createSupportSession(identity, { ...store, async getOrder(_identity, id) { assert.equal(id, order.id); return structuredClone(order); } } as CouponStore,
    runtime, faux.getModel(), undefined, { groupOpenid, focus: {
      read: async () => persisted,
      write: async value => { if (firstWrite) { firstWrite = false; entered.resolve(); await release.promise; } persisted = value; writes.push(value); },
    } });
  try {
    prepareSupportPrompt(session, { requestId: "old-write", groupOpenid, messageId: "old-write" });
    const old = session.prompt("查询 COUPON-4101").catch(error => error); await entered.promise;
    prepareSupportPrompt(session, { requestId: "new-query", groupOpenid, messageId: "new-query" });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("support_action", { action: { protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: order.id } } }), { stopReason: "toolUse" }), finish()]);
    const next = session.prompt(`查询 ${order.id}`);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(persisted, "COUPON-4100");
    release.resolve(); await next; assert.ok(await old instanceof Error);
    assert.equal(persisted, order.id); assert.deepEqual(writes, [undefined, undefined, order.id]);
    assert.equal(getSupportResult(session)!.evidence.requestId, "new-query");
  } finally { release.resolve(); session.dispose(); }
}

// A failing old focus read must not overwrite current context either.
{
  const entered = deferred(), release = deferred(); let first = true;
  const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid, focus: {
    read: async () => { if (first) { first = false; entered.resolve(); await release.promise; throw new Error("late failure"); } return undefined; }, write: async () => {},
  } });
  try {
    prepareSupportPrompt(session, { requestId: "old-failing", groupOpenid, messageId: "old-failing" });
    const old = session.prompt("你好").catch(error => error); await entered.promise;
    prepareSupportPrompt(session, { requestId: "new-host", groupOpenid, messageId: "new-host" });
    await session.prompt(command); release.resolve(); assert.ok(await old instanceof Error);
    assert.equal(getSupportHostReceipt(session)!.requestId, "new-host");
  } finally { release.resolve(); session.dispose(); }
}

// A provider already in flight must settle after abort before the new receipt
// is visible. Late assistant events cannot erase that receipt or create reads.
{
  const entered = deferred(), aborted = deferred(), release = deferred();
  let observedAbort = false, settled = false;
  const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid });
  const response: FauxResponseStep = async (_context, options) => {
    entered.resolve();
    await new Promise<void>(resolve => options!.signal!.addEventListener("abort", () => { observedAbort = true; aborted.resolve(); resolve(); }, { once: true }));
    await release.promise;
    return fauxAssistantMessage("", { stopReason: "aborted" });
  };
  session.subscribe(event => { if (event.type === "agent_end") { settled = true; assert.equal(getSupportHostReceipt(session), undefined); } });
  try {
    const before = faux.state.callCount; faux.setResponses([response]);
    prepareSupportPrompt(session, { requestId: "streaming", groupOpenid, messageId: "streaming" });
    const old = session.prompt("你好"); await entered.promise;
    prepareSupportPrompt(session, { requestId: "after-stream", groupOpenid, messageId: "after-stream" });
    const next = session.prompt(command); await aborted.promise;
    assert.equal(getSupportHostReceipt(session), undefined); assert.equal(settled, false);
    release.resolve(); await Promise.all([old, next]);
    assert.equal(observedAbort, true); assert.equal(settled, true);
    assert.equal(getSupportHostReceipt(session)!.requestId, "after-stream");
    assert.equal(faux.state.callCount, before + 1); assert.equal(reads, 0);
  } finally { release.resolve(); session.dispose(); }
}

// Pi itself has async preflight after the host wrapper. Its native disposition
// callback is the last cancellable boundary before _runAgentPrompt resets abort.
{
  const session = await createSupportSession(identity, store, runtime, faux.getModel(), undefined, { groupOpenid });
  try {
    const before = faux.state.callCount; faux.setResponses([]);
    prepareSupportPrompt(session, { requestId: "native-preflight", groupOpenid, messageId: "native-preflight" });
    await assert.rejects(session.prompt("你好", { preflightResult: disposition => { assert.equal(disposition, "started"); cancelSupportTurn(session); } }), /aborted/);
    assert.equal(faux.state.callCount, before); assert.equal(getSupportResult(session), undefined);
    prepareSupportPrompt(session, { requestId: "recovered", groupOpenid, messageId: "recovered" });
    faux.setResponses([hello(), finish()]); await session.prompt("你好");
    assert.equal(getSupportResult(session)!.evidence.requestId, "recovered");
  } finally { session.dispose(); }
}
console.log("[support-session-race] canceled initialization read/write, normal/host replacement, native preflight and active-provider settlement PASS (0 API)");
