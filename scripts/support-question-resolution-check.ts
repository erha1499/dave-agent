import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { TrustedPolicyTopic } from "../src/support-controller.ts";
import { policyTopicQueries } from "../src/support-evidence-context.ts";
import { buildSupportQuestionResolutionInput, requireSupportQuestionResolution, supportQuestionResolutionInputHash,
  supportQuestionResolutionVersion, validateSupportQuestionResolution, validateSupportQuestionResolutionInput,
  type SupportQuestionResolution, type SupportQuestionResolutionInput, type SupportQuestionResolver } from "../src/support-question-resolution.ts";

const topic = (): TrustedPolicyTopic => ({ requestId: "previous-2", sourceKey: "synthetic-source", groupOpenid: "synthetic-group",
  originalQuery: "假设商品属于常规午餐，普通周六使用的规则是什么？", orderId: "COUPON-1001",
  scope: { shopId: "synthetic-shop", productId: "synthetic-product" }, intent: "policy",
  priorQueries: [{ requestId: "previous-1", originalQuery: "我只咨询门店规则，不申请退款。" }],
  sources: [{ sourceId: "synthetic-rule", version: "a".repeat(64) }] });
const resolution = (input: SupportQuestionResolutionInput, decision: SupportQuestionResolution["decision"] = "current_complete",
  currentQuotes: string[] = [input.originalQuery], previousRequestId: string | null = null): SupportQuestionResolution => ({
  version: supportQuestionResolutionVersion, inputHash: supportQuestionResolutionInputHash(input), decision, currentQuotes, previousRequestId });

export async function checkSupportQuestionResolution() {
  const originalQuery = "刚才讨论过时间了。我重新问 COUPON-1001：这张当前午餐券按规则服务几位？", donor = topic();
  const input = buildSupportQuestionResolutionInput({ requestId: "current-1", originalQuery, previousTopic: donor });
  assert.deepEqual(Object.keys(input), ["requestId", "originalQuery", "previousTopic"]);
  assert.deepEqual(input.previousTopic!.queries, policyTopicQueries(donor));
  assert.equal(input.originalQuery, originalQuery);
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.previousTopic) && Object.isFrozen(input.previousTopic!.queries)
    && input.previousTopic!.queries.every(Object.isFrozen));
  donor.originalQuery = "修改原始话题不应改已冻结输入"; donor.priorQueries![0]!.originalQuery = "修改旧链";
  assert.equal(input.previousTopic!.queries[1]!.originalQuery, topic().originalQuery);
  assert.equal(input.previousTopic!.queries[0]!.originalQuery, topic().priorQueries![0]!.originalQuery);
  const valid = resolution(input, "current_complete", ["这张当前午餐券按规则服务几位？"]);
  assert.equal(validateSupportQuestionResolution(valid, input), true);
  const saved = requireSupportQuestionResolution(valid, input);
  valid.currentQuotes[0] = "改变返回对象";
  assert.deepEqual(saved.currentQuotes, ["这张当前午餐券按规则服务几位？"]);
  assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.currentQuotes));
  assert.throws(() => saved.currentQuotes.push("不能写入"), TypeError);
  const noPrevious = buildSupportQuestionResolutionInput({ requestId: "current-2", originalQuery });
  assert.equal(noPrevious.previousTopic, null);
  assert.equal(validateSupportQuestionResolution(resolution(noPrevious), noPrevious), true);
  assert.equal(supportQuestionResolutionInputHash({ previousTopic: input.previousTopic, originalQuery, requestId: input.requestId }), supportQuestionResolutionInputHash(input));

  // Classification is supplied by engineering fixtures, never inferred from text
  // equality, the word “刚才”, an order status, or the existence of a source quote.
  const omitted = buildSupportQuestionResolutionInput({ requestId: "omitted-1", originalQuery: "还是 COUPON-1001，刚才那个问题现在呢？", previousTopic: topic() });
  const shorter = buildSupportQuestionResolutionInput({ requestId: "omitted-2", originalQuery: "这个呢？", previousTopic: topic() });
  const fixtures = new Map<string, SupportQuestionResolution>([
    [input.requestId, saved], [omitted.requestId, resolution(omitted, "needs_clarification", [], omitted.previousTopic!.requestId)],
    [shorter.requestId, resolution(shorter, "needs_clarification", ["这个"], null)],
  ]);
  const fixtureResolver: SupportQuestionResolver = { async resolve(value, options) {
    options?.signal?.throwIfAborted(); return structuredClone(fixtures.get(value.requestId)!);
  } };
  for (const value of [input, omitted, shorter]) assert.equal(validateSupportQuestionResolution(await fixtureResolver.resolve(value), value), true);
  assert.equal((await fixtureResolver.resolve(input)).decision, "current_complete");
  assert.equal((await fixtureResolver.resolve(omitted)).decision, "needs_clarification");
  assert.equal((await fixtureResolver.resolve(shorter)).decision, "needs_clarification");
  // Deliberate limit: legal provenance does NOT prove semantic completeness.
  assert.equal(validateSupportQuestionResolution(resolution(omitted, "current_complete", ["刚才那个问题"]), omitted), true,
    "A source validator cannot detect a resolver's wrong completeness judgment");
  const previous = resolution(omitted, "previous_resolved", ["刚才那个问题"], omitted.previousTopic!.requestId);
  assert.equal(validateSupportQuestionResolution(previous, omitted), true);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fixtureResolver.resolve(input, { signal: aborted.signal }), { name: "AbortError" });

  const rejected: unknown[] = [null, [], 0, "current_complete", {},
    { ...saved, version: "support-question-resolution-v2" }, { ...saved, inputHash: "a".repeat(64) },
    { ...saved, requestId: input.requestId }, { ...saved, decision: "complete" }, { ...saved, decision: 1 },
    { ...saved, currentQuotes: null }, { ...saved, currentQuotes: [] }, { ...saved, currentQuotes: Array(6).fill("午餐券") },
    { ...saved, currentQuotes: [null] }, { ...saved, currentQuotes: [1] }, { ...saved, currentQuotes: [""] }, { ...saved, currentQuotes: ["  "] },
    { ...saved, currentQuotes: ["午餐券 服务几位"] }, { ...saved, currentQuotes: [topic().originalQuery] },
    { ...saved, currentQuotes: ["未核销支持自动退款"] }, { ...saved, previousRequestId: input.previousTopic!.requestId },
    { ...previous, previousRequestId: input.previousTopic!.queries[0]!.requestId }, { ...previous, previousRequestId: "forged-previous" },
    { ...previous, previousRequestId: null }, { ...previous, currentQuotes: [] },
    { ...resolution(input, "needs_clarification", []), previousRequestId: undefined },
    { ...resolution(input, "needs_clarification", []), previousRequestId: "unknown-topic" },
  ];
  for (const value of rejected) assert.equal(validateSupportQuestionResolution(value, value && typeof value === "object" && "decision" in value
    && value.decision === "previous_resolved" ? omitted : input), false);
  assert.equal(validateSupportQuestionResolution({ ...previous, inputHash: supportQuestionResolutionInputHash(noPrevious) }, noPrevious), false);
  assert.equal(validateSupportQuestionResolution(saved, { ...input, requestId: "forged-current" }), false);
  assert.equal(validateSupportQuestionResolution(saved, { ...input, originalQuery: "另一个原问" }), false);
  const changedPrior = structuredClone(input); changedPrior.previousTopic!.queries[0]!.originalQuery += "已改变";
  assert.equal(validateSupportQuestionResolution(saved, changedPrior), false);
  const coercing = { toString() { throw new Error("Must not coerce a decision"); } };
  assert.equal(validateSupportQuestionResolution({ ...saved, decision: coercing }, input), false);
  assert.throws(() => requireSupportQuestionResolution({ ...saved, previousRequestId: "unknown" }, input));

  const badInputs: unknown[] = [null, [], {}, { ...input, requestId: "" }, { ...input, requestId: " " }, { ...input, requestId: 1 },
    { ...input, requestId: "x".repeat(513) }, { ...input, originalQuery: "" }, { ...input, originalQuery: " " },
    { ...input, originalQuery: 1 }, { ...input, originalQuery: "问".repeat(501) }, { ...input, originalQuery: null },
    { ...input, previousTopic: undefined }, { ...input, previousTopic: false }, { ...input, modelQuestion: "模型改写" },
    { ...input, previousTopic: { ...input.previousTopic, queries: [] } },
    { ...input, previousTopic: { ...input.previousTopic, requestId: "not-last" } },
    { ...input, previousTopic: { ...input.previousTopic, queries: [input.previousTopic!.queries[1]!, input.previousTopic!.queries[1]!] } },
    { ...input, previousTopic: { requestId: input.requestId, queries: [{ requestId: input.requestId, originalQuery: "自指循环" }] } },
    { ...input, previousTopic: { requestId: "long", queries: [{ requestId: "long", originalQuery: "旧".repeat(501) }] } },
    { ...input, previousTopic: { requestId: "p-5", queries: Array.from({ length: 6 }, (_, index) => ({ requestId: `p-${index}`, originalQuery: "问题" })) } },
    { ...input, previousTopic: { requestId: "p-4", queries: Array.from({ length: 5 }, (_, index) => ({ requestId: `p-${index}`, originalQuery: "问".repeat(101) })) } },
  ];
  for (const value of badInputs) assert.equal(validateSupportQuestionResolutionInput(value), false);
  assert.throws(() => buildSupportQuestionResolutionInput({ requestId: "bad", originalQuery: "问".repeat(501) }));
  assert.throws(() => buildSupportQuestionResolutionInput({ requestId: "bad", originalQuery, previousTopic: false as unknown as TrustedPolicyTopic }));
  assert.throws(() => buildSupportQuestionResolutionInput({ requestId: "bad", originalQuery, previousTopic: { ...topic(), priorQueries: Array(5).fill(topic().priorQueries![0]) } }));
  assert.throws(() => supportQuestionResolutionInputHash({ ...input, requestId: input.previousTopic!.requestId }));
  const fullChain: SupportQuestionResolutionInput = { requestId: "current-full", originalQuery: "这个规则呢？", previousTopic: {
    requestId: "p-4", queries: Array.from({ length: 5 }, (_, index) => ({ requestId: `p-${index}`, originalQuery: "问".repeat(100) })) } };
  assert.equal(validateSupportQuestionResolutionInput(fullChain), true);
  assert.equal(validateSupportQuestionResolution(resolution(fullChain, "current_complete"), fullChain), true);
  assert.equal(validateSupportQuestionResolution(resolution(fullChain, "previous_resolved", ["规则"], "p-4"), fullChain), false);
  const combinedLimit = structuredClone(fullChain); combinedLimit.previousTopic!.queries.pop(); combinedLimit.previousTopic!.requestId = "p-3";
  combinedLimit.originalQuery = "问".repeat(101);
  assert.equal(validateSupportQuestionResolutionInput(combinedLimit), true);
  assert.equal(validateSupportQuestionResolution(resolution(combinedLimit, "previous_resolved", ["问"], "p-3"), combinedLimit), false);
  const boundary = buildSupportQuestionResolutionInput({ requestId: "x".repeat(512), originalQuery: "问".repeat(500) });
  assert.equal(validateSupportQuestionResolution(resolution(boundary), boundary), true);

  for (const [name, decorate] of [
    ["extra", (value: object) => Object.defineProperty(value, "extra", { value: true })],
    ["symbol", (value: object) => Object.defineProperty(value, Symbol("extra"), { value: true })],
    ["prototype", (value: object) => Object.setPrototypeOf(value, { inherited: true })],
  ] as const) {
    const value = structuredClone(saved); decorate(value); assert.equal(validateSupportQuestionResolution(value, input), false, name);
    const raw = structuredClone(input); decorate(raw); assert.equal(validateSupportQuestionResolutionInput(raw), false, name);
    const previousInput = structuredClone(input); decorate(previousInput.previousTopic!);
    assert.equal(validateSupportQuestionResolutionInput(previousInput), false, name);
  }
  for (const decorate of [
    (value: unknown[]) => Object.defineProperty(value, "extra", { value: true }),
    (value: unknown[]) => Object.defineProperty(value, Symbol("extra"), { value: true }),
    (value: unknown[]) => { delete value[0]; Object.defineProperty(value, "extra", { value: true }); },
    (value: unknown[]) => Object.defineProperty(value, "0", { enumerable: true, get() { throw new Error("Getter must not execute"); } }),
  ]) {
    const value = structuredClone(saved); decorate(value.currentQuotes); assert.equal(validateSupportQuestionResolution(value, input), false);
    const raw = structuredClone(input); decorate(raw.previousTopic!.queries); assert.equal(validateSupportQuestionResolutionInput(raw), false);
  }
  const accessor = structuredClone(saved); Object.defineProperty(accessor, "decision", { enumerable: true, get() { throw new Error("Do not read getter"); } });
  assert.equal(validateSupportQuestionResolution(accessor, input), false);
  console.log("Support question resolution checks: bounded literal provenance, hash/replay/chain/source/shape controls and frozen copies; injected classifications are not semantic validation; remote/DB/QQ=0.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportQuestionResolution();
