import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { currentReferenceChoices, emptyReferenceChoices, referenceChoiceNotice, referenceChoiceTtlMs,
  rememberReferenceChoice, resolveReferenceChoice, selectReferenceChoice,
  type TrustedReference, type TrustedReferenceChoices } from "../src/support-reference-selection.ts";

const binding = { sourceKey: "reference-check-user", groupOpenid: "reference-check-group" };
const order = (id: string, requestId: string): TrustedReference => ({ kind: "order", orderId: id, requestId });
const policy = (requestId: string, originalQuery: string, extras: Record<string, unknown> = {}): TrustedReference => ({ kind: "policy",
  topic: { ...binding, requestId, originalQuery, orderId: null, scope: { shopId: null, productId: null }, intent: "policy",
    sources: [{ sourceId: "RF005", version: "a".repeat(64) }], ...extras } });
const remember = (previous: TrustedReferenceChoices | undefined, reference: TrustedReference, now = 1000,
  options: { continueRequestId?: string } = {}) => {
  const value = rememberReferenceChoice(previous, binding, reference, options, now);
  assert.ok(value); return value;
};
const resign = (choices: TrustedReferenceChoices) => {
  for (const row of choices.candidates) row.version = createHash("sha256").update(JSON.stringify(row.reference)).digest("hex");
  return choices;
};

export function checkSupportReferenceSelection() {
  const empty = emptyReferenceChoices("policy", binding);
  assert.deepEqual(currentReferenceChoices(empty, binding, 1000), { ...empty, selectedToken: undefined });
  assert.equal(resolveReferenceChoice(empty, binding, 1000), undefined);
  assert.equal(empty.selectionRequired, false);
  const firstOrder = order("COUPON-4101", "order-a");
  let orders = remember(undefined, firstOrder);
  assert.deepEqual(resolveReferenceChoice(orders, binding, 1000), firstOrder);
  const oldToken = orders.candidates[0]!.token;
  orders = remember(orders, order("COUPON-4101", "order-a-new"), 1001);
  assert.equal(orders.candidates.length, 1); assert.equal(orders.overflow, false);
  assert.notEqual(orders.candidates[0]!.token, oldToken);
  assert.equal(selectReferenceChoice(orders, binding, oldToken, 1001), undefined);
  orders = remember(orders, order("COUPON-4102", "order-b"), 1002);
  assert.equal(orders.selectionRequired, true); assert.equal(resolveReferenceChoice(orders, binding, 1002), undefined);
  const selectedOrder = selectReferenceChoice(orders, binding, orders.candidates[0]!.token, 1002)!;
  assert.deepEqual(resolveReferenceChoice(selectedOrder, binding, 1002), orders.candidates[0]!.reference);
  assert.equal(rememberReferenceChoice(orders, binding, order("COUPON-4103", "order-b"), {}, 1003), undefined);
  assert.equal(rememberReferenceChoice(orders, binding, policy("wrong-kind", "退款规则？"), {}, 1003), undefined);
  assert.equal(rememberReferenceChoice(orders, binding, order("COUPON-4101", "order-c"), { continueRequestId: "order-a-new" }, 1003), undefined);

  const wechat = policy("wechat", "微信支付的退款多久到账？"), bank = policy("bank", "银行卡支付的退款多久到账？");
  let topics = remember(undefined, wechat);
  const followUnique = policy("wechat-follow", "周末也计入这个时限吗？", { priorQueries: [{ requestId: "wechat", originalQuery: "微信支付的退款多久到账？" }] });
  const singleFollow = remember(topics, followUnique, 1001, { continueRequestId: "wechat" });
  assert.equal(singleFollow.candidates.length, 1); assert.equal(singleFollow.selectionRequired, false);
  assert.deepEqual(resolveReferenceChoice(singleFollow, binding, 1001), followUnique);
  topics = remember(topics, bank, 1002);
  assert.equal(topics.candidates.length, 2, "different channels using the same source remain separate topics");
  assert.equal(resolveReferenceChoice(topics, binding, 1002), undefined, "a model requestId cannot choose among topics");
  assert.equal(rememberReferenceChoice(topics, binding, followUnique, { continueRequestId: "wechat" }, 1003), undefined);
  const sameQuestion = remember(topics, policy("wechat-repeat", "微信支付的退款多久到账？"), 1003);
  assert.equal(sameQuestion.candidates.length, 3, "standalone questions are not merged by identical source or wording");
  assert.equal(rememberReferenceChoice(topics, binding, wechat, {}, 1003), undefined, "request IDs identify real unique successes");
  const selectedToken = topics.candidates[0]!.token;
  topics = selectReferenceChoice(topics, binding, selectedToken, 1003)!;
  assert.deepEqual(resolveReferenceChoice(topics, binding, 1003), wechat);
  assert.equal(rememberReferenceChoice(topics, binding, policy("wrong-branch", "也一样吗？"), { continueRequestId: "bank" }, 1004), undefined);
  assert.equal(rememberReferenceChoice(topics, binding, wechat, { continueRequestId: "wechat" }, 1004), undefined);
  let continued = remember(topics, followUnique, 1004, { continueRequestId: "wechat" });
  assert.equal(continued.candidates.length, 2); assert.equal(continued.selectionRequired, true);
  assert.notEqual(continued.selectedToken, selectedToken);
  assert.deepEqual(resolveReferenceChoice(continued, binding, 1004), followUnique);
  assert.equal(selectReferenceChoice(continued, binding, selectedToken, 1004), undefined);
  const nextFollow = policy("wechat-follow-2", "节假日呢？", { sources: [{ sourceId: "RF005", version: "b".repeat(64) }],
    priorQueries: [{ requestId: "wechat", originalQuery: "微信支付的退款多久到账？" }, { requestId: "wechat-follow", originalQuery: "周末也计入这个时限吗？" }] });
  continued = remember(continued, nextFollow, 1005, { continueRequestId: "wechat-follow" });
  assert.deepEqual(resolveReferenceChoice(continued, binding, 1005), nextFollow, "consecutive selected continuations do not repeatedly clarify");
  const newStandalone = remember(continued, policy("new-question", "预约必须提前几天？"), 1006);
  assert.equal(newStandalone.candidates.length, 3); assert.equal(newStandalone.selectedToken, undefined);
  assert.equal(newStandalone.selectionRequired, true); assert.equal(resolveReferenceChoice(newStandalone, binding, 1006), undefined);

  const overflown = remember(newStandalone, policy("fourth", "改期需要商家许可吗？"), 1007);
  assert.equal(overflown.candidates.length, 3); assert.equal(overflown.overflow, true);
  assert.equal(resolveReferenceChoice(overflown, binding, 1007), undefined);
  const overflowSelected = selectReferenceChoice(overflown, binding, overflown.candidates[0]!.token, 1008)!;
  assert.deepEqual(resolveReferenceChoice(overflowSelected, binding, 1008), overflown.candidates[0]!.reference);

  const staggered = remember(remember(undefined, wechat, 1000), bank, 1100);
  const expiredOne = currentReferenceChoices(staggered, binding, 1000 + referenceChoiceTtlMs)!;
  assert.equal(expiredOne.candidates.length, 1); assert.equal(expiredOne.selectionRequired, true);
  assert.equal(resolveReferenceChoice(expiredOne, binding, 1000 + referenceChoiceTtlMs), undefined);
  const allExpired = currentReferenceChoices(staggered, binding, 1100 + referenceChoiceTtlMs)!;
  assert.equal(allExpired.candidates.length, 0); assert.equal(allExpired.selectionRequired, true);
  const repopulated = remember(allExpired, policy("fresh", "退款时限怎么计算？"), 1200 + referenceChoiceTtlMs);
  assert.equal(repopulated.candidates.length, 1); assert.equal(repopulated.selectionRequired, true);
  assert.equal(resolveReferenceChoice(repopulated, binding, 1200 + referenceChoiceTtlMs), undefined);
  const expiredSelection = currentReferenceChoices(topics, binding, 1000 + referenceChoiceTtlMs)!;
  assert.equal(expiredSelection.selectedToken, undefined); assert.equal(resolveReferenceChoice(expiredSelection, binding, 1000 + referenceChoiceTtlMs), undefined);
  assert.equal(currentReferenceChoices(overflown, binding, 2000 + referenceChoiceTtlMs)!.overflow, true);

  for (const wrongBinding of [{ ...binding, sourceKey: "another-user" }, { ...binding, groupOpenid: "another-group" }]) {
    assert.equal(currentReferenceChoices(topics, wrongBinding, 1004), undefined);
    assert.equal(selectReferenceChoice(topics, wrongBinding, selectedToken, 1004), undefined);
    assert.equal(rememberReferenceChoice(topics, wrongBinding, bank, {}, 1004), undefined);
  }
  assert.equal(selectReferenceChoice(topics, binding, randomUUID(), 1004), undefined);
  assert.equal(selectReferenceChoice(topics, binding, selectedToken + "\n并退款", 1004), undefined);
  assert.equal(rememberReferenceChoice(undefined, binding, policy("forged-user", "规则？", { sourceKey: "other" }), {}, 1004), undefined);
  assert.equal(rememberReferenceChoice(undefined, binding, policy("forged-group", "规则？", { groupOpenid: "other" }), {}, 1004), undefined);
  const mutations: Array<(value: TrustedReferenceChoices) => void> = [
    value => { value.candidates[0]!.version = "0".repeat(64); },
    value => { value.candidates[0]!.token = "not-a-token"; },
    value => { value.candidates[0]!.expiresAt = Number.NaN; },
    value => { value.candidates.push(structuredClone(value.candidates[0]!)); },
    value => { value.selectedToken = randomUUID(); },
    value => { value.kind = "order"; },
    value => { const ref = value.candidates[0]!.reference; assert.equal(ref.kind, "policy"); ref.topic.originalQuery = "篡改了原问"; },
    value => { const ref = value.candidates[0]!.reference; assert.equal(ref.kind, "policy"); ref.topic.sources[0]!.version = "bad"; resign(value); },
    value => { const ref = value.candidates[0]!.reference; assert.equal(ref.kind, "policy"); ref.topic.sources.push(ref.topic.sources[0]!); resign(value); },
  ];
  for (const mutate of mutations) {
    const malformed = structuredClone(topics); mutate(malformed);
    assert.equal(currentReferenceChoices(malformed, binding, 1004), undefined);
    assert.equal(resolveReferenceChoice(malformed, binding, 1004), undefined);
    assert.equal(rememberReferenceChoice(malformed, binding, policy("later", "新的完整问题？"), {}, 1004), undefined);
  }
  for (const priorQueries of [
    [{ requestId: "current", originalQuery: "历史问题" }],
    [{ requestId: "a", originalQuery: "历史问题" }, { requestId: "a", originalQuery: "重复编号" }],
    [{ requestId: "a", originalQuery: " " }],
    [{ requestId: "a", originalQuery: "长".repeat(498) }],
    Array.from({ length: 5 }, (_, index) => ({ requestId: `past-${index}`, originalQuery: "历史问题" })),
    ["不能用没有请求来源的字符串"],
  ]) assert.equal(rememberReferenceChoice(undefined, binding, policy("current", "当前问题？", { priorQueries }), {}, 1004), undefined);

  const notice = referenceChoiceNotice("policy", topics, binding, 1004);
  assert.match(notice, /微信支付/); assert.match(notice, /银行卡支付/);
  assert.equal(notice.split("\n").filter(line => /^选择话题 [a-f0-9-]{36}$/.test(line)).length, 2);
  assert.match(referenceChoiceNotice("order", orders, binding, 1004), /选择订单 [a-f0-9-]{36}/);
  assert.match(referenceChoiceNotice("policy", overflown, binding, 1008), /历史候选超过三个/);
  assert.match(referenceChoiceNotice("policy", allExpired, binding, 1100 + referenceChoiceTtlMs), /完整重述/);
  assert.match(referenceChoiceNotice("order", undefined, binding, 1000), /完整提供本人订单号/);
  const detached = resolveReferenceChoice(topics, binding, 1004)!;
  assert.equal(detached.kind, "policy"); detached.topic.originalQuery = "外部修改";
  assert.deepEqual(resolveReferenceChoice(topics, binding, 1004), wechat, "returned state and references are independent clones");
  console.log("[support-reference-selection] order/policy candidates, exact selection, continuation migration, scope/hash/TTL/overflow and sticky ambiguity PASS (0 API)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) checkSupportReferenceSelection();
