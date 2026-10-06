import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "mysql2/promise";
import { AfterSalesStore, merchantSourceKey, type MerchantTask, type MerchantTaskReference } from "../src/after-sales.ts";
import { OrderAccessError } from "../src/coupon-store.ts";
import { SupportProtocolError } from "../src/support-action.ts";
import { normalizeModelSupportAction, parseContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, type SupportServices, type SupportTurnContext } from "../src/support-controller.ts";
import { currentTaskChoices, refreshTaskChoices, resolveTaskReference, selectTaskChoice, taskChoiceNotice,
  taskReferenceTtlMs, validateTaskContext, type TrustedTaskChoices } from "../src/support-task-context.ts";

export async function checkSupportTaskContext() {
  let migrated = true;
  const readiness = new AfterSalesStore({ query: async (sql: string) => {
    assert.equal(sql, "SELECT identity_id FROM merchant_requests LIMIT 0");
    if (!migrated) throw new Error("database detail that must not escape");
    return [[], []];
  } } as unknown as Pool);
  await readiness.ping(); migrated = false;
  await assert.rejects(readiness.ping(), { message: "演示商家协商暂时不可用，请稍后重试。" });
  const identity = { appId: "TASK_CHECK", senderId: "OWNER" }, groupOpenid = "task-context-check";
  const binding = { sourceKey: merchantSourceKey(identity, groupOpenid), groupOpenid }, now = Date.now();
  const a: MerchantTaskReference = { taskId: "10000000-0000-4000-8000-000000000001", orderId: "COUPON-2401",
    origin: "confirmed", anchorAt: now - 10_000, expiresAt: now + 100_000 };
  const b: MerchantTaskReference = { ...a, taskId: "10000000-0000-4000-8000-000000000002", orderId: "COUPON-2402", expiresAt: now + 200_000 };
  const single = refreshTaskChoices(undefined, { candidates: [a], overflow: false }, binding, now)!;
  assert.deepEqual(resolveTaskReference(single, binding, now), a);
  assert.equal(refreshTaskChoices(single, { candidates: [a], overflow: false }, binding, now + 1)!.candidates[0]!.token,
    single.candidates[0]!.token, "unchanged DB locator keeps its displayed token");
  const multi = refreshTaskChoices(single, { candidates: [a, b], overflow: false }, binding, now)!;
  assert.equal(resolveTaskReference(multi, binding, now), undefined);
  assert.equal(resolveTaskReference(refreshTaskChoices(multi, { candidates: [b], overflow: false }, binding, now), binding, now), undefined);
  assert.equal(resolveTaskReference(currentTaskChoices(multi, binding, a.expiresAt), binding, a.expiresAt), undefined, "expiry must not resolve ambiguity");
  const selected = selectTaskChoice(multi, binding, multi.candidates[0]!.token, "user-selection", now)!;
  assert.deepEqual(resolveTaskReference(selected, binding, now), a);
  const restored = refreshTaskChoices({ ...selected, candidates: [] }, { candidates: [a, b], overflow: false }, binding, now)!;
  assert.deepEqual(restored.selected, selected.selected, "persisted selection is matched against the fresh listing");
  const newer = { ...a, origin: "sent" as const, anchorAt: now + 1, expiresAt: now + 1 + taskReferenceTtlMs };
  const updated = refreshTaskChoices(selected, { candidates: [newer, b], overflow: false }, binding, now + 1)!;
  assert.equal(updated.selected!.expiresAt, a.expiresAt, "a fresh notification does not extend a user's selected locator");
  assert.notEqual(updated.candidates[0]!.token, selected.candidates[0]!.token);
  assert.equal(resolveTaskReference(updated, binding, a.expiresAt), undefined);
  assert.equal(refreshTaskChoices(updated, { candidates: [newer], overflow: false }, binding, a.expiresAt)!.selectionRequired, true);
  const lost = refreshTaskChoices(selected, { candidates: [b], overflow: false }, binding, now)!;
  assert.equal(lost.selected, undefined); assert.equal(lost.selectionRequired, true);
  assert.equal(resolveTaskReference(refreshTaskChoices(lost, { candidates: [a], overflow: false }, binding, now), binding, now), undefined);
  assert.equal(selectTaskChoice(single, binding, "invented-token", "selection", now), undefined);
  assert.equal(selectTaskChoice(single, binding, single.candidates[0]!.token, "bad\nrequest", now), undefined);
  for (const badBinding of [{ ...binding, groupOpenid: "another" }, { ...binding, sourceKey: "other" }]) {
    assert.equal(currentTaskChoices(selected, badBinding, now), undefined);
    assert.equal(refreshTaskChoices(selected, { candidates: [a], overflow: false }, badBinding, now), undefined);
  }
  assert.equal(refreshTaskChoices(undefined, { candidates: [a, a], overflow: false }, binding, now), undefined);
  assert.equal(refreshTaskChoices(undefined, { candidates: [{ ...a, expiresAt: a.anchorAt + taskReferenceTtlMs + 1 }], overflow: false }, binding, now), undefined);
  assert.equal(validateTaskContext({ selectionRequired: false, overflow: false, selected: { ...selected.selected, amountCents: 1 } }, now), undefined);
  assert.deepEqual(validateTaskContext({ selectionRequired: false, overflow: false, selected: selected.selected }, a.expiresAt), { selectionRequired: true, overflow: false });
  assert.equal(validateTaskContext({ selectionRequired: false, overflow: true }, now)!.selectionRequired, true);
  assert.match(taskChoiceNotice(updated, binding, now + 1), /不代表你已读/);
  assert.match(taskChoiceNotice(multi, binding, now), /选择任务 [a-f0-9-]+/);

  const taskAction = { protocol: "v2.2" as const, kind: "merchant_status" as const, taskRef: { taskId: a.taskId } };
  assert.deepEqual(parseContextSupportAction(taskAction), taskAction);
  assert.deepEqual(normalizeModelSupportAction({ kind: "merchant_status", taskRef: { taskId: a.taskId } }), taskAction);
  for (const invalid of [
    { ...taskAction, orderRef: { kind: "focus" } }, { ...taskAction, taskRef: { taskId: a.taskId, orderId: a.orderId } },
    { ...taskAction, taskRef: { taskId: "bad" } }, { ...taskAction, protocol: "v3" },
    { ...taskAction, kind: "refund_prepare" }, { ...taskAction, kind: "merchant_prepare", reason: "测试" },
    { ...taskAction, approved: true }, { ...taskAction, amountCents: 100 }, { ...taskAction, senderId: "other" },
  ]) assert.throws(() => parseContextSupportAction(invalid), SupportProtocolError);

  const order: Awaited<ReturnType<SupportServices["store"]["getOrder"]>> = {
    source: "demo-database", id: a.orderId, status: "paid", asOf: new Date(now).toISOString(),
    amounts: { totalCents: 6000, paidCents: 6000, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "shop", name: "餐厅", merchantName: "商家", address: "模拟地址" },
    items: [{ id: "item", productId: "product", productName: "午餐券", quantity: 1, unitPriceCents: 6000, totalCents: 6000 }],
    coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: null, redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 6000, paidAt: null }], refunds: [],
  };
  let task: MerchantTask | undefined = { taskId: a.taskId, orderId: a.orderId, status: "pending", reason: "行程变化",
    amountCents: 6000, approvedAmountCents: null, createdAt: new Date(now).toISOString(), dueAt: new Date(now + 10000).toISOString(), completedAt: null, simulation: true };
  let denial = false, outage = false, afterOrder: (() => void) | undefined;
  const calls: string[] = [], taskOptions: unknown[] = [];
  const controller = new SupportController({ store: {
    async getOrder(who, id) { calls.push("order"); assert.deepEqual(who, identity); assert.equal(id, a.orderId);
      if (denial) throw new OrderAccessError("不可读取"); afterOrder?.(); return structuredClone(order); },
    async searchKnowledge() { assert.fail("Task status must not retrieve policy"); },
  }, merchant: {
    async getTask(who, source, id, options) { calls.push("task"); assert.deepEqual(who, identity); assert.equal(source, binding.sourceKey); assert.equal(id, a.orderId);
      taskOptions.push(structuredClone(options));
      if (options) assert.deepEqual(options, { referenceTaskId: a.taskId });
      if (outage) throw new Error("private SQL details"); return structuredClone(task); },
    async prepare() { assert.fail("Task reference must never prepare a mutation"); },
  } });
  let count = 0;
  const context = (choices: TrustedTaskChoices | undefined = single, userText = "刚才通知的协商现在怎么样？"): SupportTurnContext => ({
    identity, sourceKey: binding.sourceKey, trustedRoute: { groupOpenid, messageId: `message-${++count}` }, requestId: `turn-${count}`,
    userText, focusOrderId: b.orderId, taskChoices: choices,
  });
  const firstTurn = controller.createTurn(context());
  const first = await firstTurn.execute(taskAction);
  assert.equal(first.outcome, "ready"); assert.equal(first.reply.kind, "merchant_status"); assert.deepEqual(calls, ["order", "task"]);
  assert.deepEqual(taskOptions, [{ referenceTaskId: a.taskId }], "task references use the store's current-binding and exact-task guard");
  assert.equal(first.evidence.order!.id, a.orderId); assert.equal(first.evidence.task!.status, "pending");
  assert.equal(first.verifiedOrderId, undefined); assert.equal(first.verifiedPolicyTopic, undefined); assert.equal(first.verifiedAmountReference, undefined);
  assert.deepEqual(first.evidence.rules, []); assert.deepEqual(first.evidence.knowledge, []);
  assert.equal(await firstTurn.execute(taskAction), first, "same turn is cached, including task query");
  assert.deepEqual(calls, ["order", "task"]);
  assert.throws(() => firstTurn.execute({ protocol: "v2.2", kind: "refund_prepare", orderRef: { kind: "focus" } }), SupportProtocolError);
  task = { ...task!, status: "approved", approvedAmountCents: 6000 };
  assert.equal((await controller.createTurn(context(selected)).execute(taskAction)).evidence.task!.status, "approved", "read fresh task status rather than historic notification");

  for (const choices of [multi, { ...single, selectionRequired: true }, { ...single, groupOpenid: "other" },
    { ...single, candidates: [] }]) {
    calls.length = 0;
    const response = await controller.createTurn(context(choices)).execute(taskAction);
    assert.equal(response.outcome, "clarification"); assert.deepEqual(calls, []);
    if (choices === multi) { assert.equal(response.referencePresentation, "task"); assert.ok("text" in response.reply); assert.match(response.reply.text, /选择任务/); }
  }
  calls.length = 0;
  const explicit = controller.createTurn(context(single, `查询 ${a.orderId} 的协商状态`));
  await assert.rejects(explicit.execute(taskAction), SupportProtocolError); assert.deepEqual(calls, []);
  assert.equal((await explicit.execute({ protocol: "v2.2", kind: "merchant_status", orderRef: { kind: "explicit", orderId: a.orderId } })).verifiedOrderId, a.orderId,
    "pure task preflight rejection allows repair to the current explicit order");
  const pending = await controller.createTurn({ ...context(multi), pendingReferenceKind: "order" }).execute({ protocol: "v2.2", kind: "clarify", field: "task", reason: "ambiguous" });
  assert.equal(pending.pendingReferenceKind, "order"); assert.equal(pending.referencePresentation, "task");
  for (const failure of ["denial", "outage", "replacement", "missing"] as const) {
    denial = failure === "denial"; outage = failure === "outage";
    task = failure === "missing" ? undefined : { ...first.evidence.task!, taskId: failure === "replacement" ? b.taskId : a.taskId };
    calls.length = 0;
    const response = await controller.createTurn(context()).execute(taskAction);
    assert.equal(response.outcome, "blocked"); assert.equal(response.reply.kind, "notice"); assert.equal(response.evidence.task ?? null, null);
    assert.ok(!JSON.stringify(response.reply).includes("SQL"));
    assert.deepEqual(calls, failure === "denial" ? ["order"] : ["order", "task"]);
  }
  denial = false; outage = false;
  const realNow = Date.now;
  try {
    afterOrder = () => { Date.now = () => a.expiresAt; }; calls.length = 0;
    const expiredDuringRead = await controller.createTurn(context()).execute(taskAction);
    assert.equal(expiredDuringRead.outcome, "clarification"); assert.equal(expiredDuringRead.evidence.task, undefined);
    assert.deepEqual(calls, ["order"], "a locator expiring during authorization cannot start the task read");
  } finally { Date.now = realNow; afterOrder = undefined; }
  const abort = new AbortController(); afterOrder = () => abort.abort(); calls.length = 0;
  await assert.rejects(controller.createTurn({ ...context(), signal: abort.signal }).execute(taskAction));
  assert.deepEqual(calls, ["order"], "cancelled task read cannot continue to the next service"); afterOrder = undefined;
  console.log("support-task-context-check: helper selection/expiry + strict read-only Controller checks passed (0 API/DB)");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkSupportTaskContext();
