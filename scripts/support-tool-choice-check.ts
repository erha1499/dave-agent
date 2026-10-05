import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createCouponSession, createModelRuntime, createQQSession } from "../src/agent.ts";
import { OrderAccessError, type CouponStore } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, verifyEvidenceSupport } from "../src/evidence-support.ts";
import { cancelSupportTurn, createSupportSession, getSupportResult, prepareSupportPrompt, supportReply } from "../src/support-session.ts";
import type { SupportCall } from "../src/support-controller.ts";

// Real Pi lifecycle, schema validation and OpenAI-compatible adapter. Only the
// final HTTP transport is synthetic; no credentials, database or paid API.
export async function checkSupportToolChoice() {
  type Payload = { tool_choice?: unknown; thinking?: { type: string }; messages: unknown[]; tools?: unknown[] };
  type ResponseStep = { action: unknown } | { text: string };
  const runtime = await createModelRuntime(), model = runtime.getModel("deepseek", "deepseek-flash")!;
  assert.ok(model); assert.equal(model.api, "openai-completions");
  await runtime.setRuntimeApiKey("deepseek", "synthetic-key-not-a-credential");
  const originalStream = runtime.streamSimple.bind(runtime), bodies: Payload[] = [];
  let responses: ResponseStep[] = [], onFetch: (() => void) | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    init?.signal?.throwIfAborted();
    bodies.push(JSON.parse(String(init?.body)) as Payload); onFetch?.(); init?.signal?.throwIfAborted();
    const next = responses.shift(); assert.ok(next, "unexpected extra model request");
    const isTool = "action" in next;
    const delta = isTool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function",
      function: { name: "support_action", arguments: JSON.stringify({ action: next.action }) } }] }
      : { role: "assistant", content: next.text };
    const chunk = (delta: object, finish_reason: string | null, usage?: object) => `data: ${JSON.stringify({
      id: `chatcmpl_${bodies.length}`, object: "chat.completion.chunk", created: 1, model: model.id,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, isTool ? "tool_calls" : "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  runtime.streamSimple = (selected, transcript, options) => originalStream(selected, transcript, { ...options, fetch: fakeFetch });
  const identity = { appId: "TOOL_CHOICE_TEST", senderId: "ACTOR" }, groupOpenid = "TOOL_CHOICE_GROUP", orderId = "COUPON-3101";
  const now = "2026-10-06T00:00:00Z", expires = "2027-01-01T00:00:00Z";
  const order: Awaited<ReturnType<CouponStore["getOrder"]>> = { source: "demo-database", id: orderId, status: "paid", asOf: now,
    createdAt: now, paidAt: now, amounts: { totalCents: 6900, paidCents: 6900, refundedCents: 0 },
    shop: { id: "shop", name: "店", merchantName: "商家", address: "地址" },
    items: [{ id: "item", productId: "product", productName: "午餐", quantity: 1, unitPriceCents: 6900, totalCents: 6900 }],
    coupons: [{ id: "coupon", orderItemId: "item", status: "unused", expiresAt: expires, redeemedAt: null, redeemedShopId: null }],
    payments: [{ status: "succeeded", amountCents: 6900, paidAt: now }], refunds: [] };
  let reads = 0, readMode: "ok" | "denied" | "error" | "cancel" = "ok";
  const calls: SupportCall[] = [];
  const store = { getOrder: async (who: typeof identity, id: string) => {
    assert.deepEqual(who, identity); assert.equal(id, orderId); reads++;
    if (readMode === "denied") throw new OrderAccessError("synthetic denial");
    if (readMode === "error") throw new Error("synthetic service failure");
    if (readMode === "cancel") { cancelSupportTurn(session); void session.abort(); }
    return structuredClone(order);
  }, searchKnowledge: async () => [] } as unknown as CouponStore;
  let session = await createSupportSession(identity, store, runtime, model, undefined, { groupOpenid });
  const forced = { type: "function", function: { name: "support_action" } };
  const select = (kind = "explicit"): ResponseStep => ({ action: { protocol: "v2.2", kind: "order",
    orderRef: kind === "explicit" ? { kind, orderId } : { kind } } });
  const hello: ResponseStep = { action: { protocol: "v2.2", kind: "non_business", reason: "greeting" } };
  const finish: ResponseStep = { text: "完成。" };
  let ingress = 0;
  const prompt = async (text: string, steps: ResponseStep[], route = groupOpenid) => {
    const requestId = `tool-choice-${++ingress}`, before = bodies.length;
    responses = [...steps]; prepareSupportPrompt(session, { requestId, messageId: requestId, groupOpenid: route, onCall: call => calls.push(call) });
    await session.prompt(text, { expandPromptTemplates: false });
    return { requestId, payloads: bodies.slice(before), choices: bodies.slice(before).map(body => body.tool_choice) };
  };
  try {
    const first = await prompt(`查 ${orderId}`, [select(), finish]);
    assert.deepEqual(first.choices, [forced, "auto"]);
    assert.ok(first.payloads.every(body => body.thinking?.type === "disabled"), "actual DeepSeek wire stays non-thinking");
    assert.equal(getSupportResult(session)!.evidence.requestId, first.requestId);
    assert.ok(calls.every(call => call.parentSpanId === first.requestId));

    const omitted = { kind: "order", orderRef: { kind: "explicit", orderId } };
    const normalized = await prompt(`查 ${orderId}`, [{ action: omitted }, finish]);
    assert.deepEqual(normalized.choices, [forced, "auto"], "an omitted host constant succeeds without another forced repair request");
    assert.deepEqual(getSupportResult(session)!.action, { ...omitted, protocol: "v2.2" });
    const recorded = (normalized.payloads[1]!.messages as Array<{ tool_calls?: Array<{ function: { name: string; arguments: string } }> }>)
      .flatMap(message => message.tool_calls ?? []).filter(call => call.function.name === "support_action").at(-1)!;
    assert.deepEqual(JSON.parse(recorded.function.arguments), { action: omitted }, "raw model arguments remain auditable beside the normalized result");
    const wireTool = normalized.payloads[0]!.tools![0] as { function: { parameters: { properties: {
      action: { anyOf: Array<{ properties: { protocol: { const: string } }; required: string[]; additionalProperties: boolean }> }
    } } } };
    assert.ok(wireTool.function.parameters.properties.action.anyOf.every(branch => branch.properties.protocol.const === "v2.2"
      && !branch.required.includes("protocol") && branch.additionalProperties === false), "actual provider schema omits only the required protocol constant");
    const schema = await prompt(`查 ${orderId}`, [{ action: { ...omitted, protocol: "v2.1" } }, select(), finish]);
    assert.deepEqual(schema.choices, [forced, forced, "auto"], "a supplied invalid version still requires a bounded repair before business execution");
    assert.equal(getSupportResult(session)!.evidence.requestId, schema.requestId);
    assert.equal(reads, 3);
    const preflight = await prompt("再看这笔", [select(), select("focus"), finish]);
    assert.deepEqual(preflight.choices, [forced, forced, "auto"], "current-message reference repair keeps the same forced tool");
    assert.equal(getSupportResult(session)!.evidence.requestId, preflight.requestId); assert.equal(reads, 4);

    for (const mode of ["denied", "error"] as const) {
      readMode = mode; const readsBefore: number = reads;
      const failed = await prompt(`查 ${orderId}`, [select(), select(), finish]);
      assert.deepEqual(failed.choices, [forced, "auto", "auto"], "started business refusal/error must never force a retry");
      assert.equal(reads, readsBefore + 1, "Controller caches the first business failure");
      assert.equal(getSupportResult(session), undefined);
    }
    readMode = "ok";
    const malformed = { action: { kind: "order" } };
    const exhausted = await prompt(`查 ${orderId}`, [malformed, malformed, select(), finish]);
    assert.deepEqual(exhausted.choices, [forced, forced]); assert.equal(responses.length, 2);
    assert.equal(getSupportResult(session), undefined);
    const next = await prompt("你好", [hello, finish]); assert.deepEqual(next.choices, [forced, "auto"]);
    assert.equal(getSupportResult(session)!.evidence.requestId, next.requestId);

    const missed = await prompt("需要补充什么？", [{ text: "请补充具体问题。" }]);
    assert.deepEqual(missed.choices, [forced]); assert.equal(getSupportResult(session), undefined);
    const missedReply = supportReply(session)!; assert.equal(missedReply.kind, "notice");
    assert.ok("text" in missedReply && /未形成有效业务动作/.test(missedReply.text));
    assert.ok(!calls.some(call => call.parentSpanId === missed.requestId), "ignored tool choice cannot create a synthetic successful action");
    const beforeBadInit = bodies.length;
    await assert.rejects(prompt("你好", [finish], "wrong-group"), /可信群路由/);
    assert.equal(bodies.length, beforeBadInit, "invalid trusted ingress stops before native Pi/provider entry");
    assert.equal(getSupportResult(session), undefined);

    readMode = "cancel";
    const canceled = await prompt(`查 ${orderId}`, [select()]);
    assert.deepEqual(canceled.choices, [forced]); assert.equal(getSupportResult(session), undefined);
    readMode = "ok";
    const recovered = await prompt("你好", [hello, finish]); assert.deepEqual(recovered.choices, [forced, "auto"]);
    assert.equal(getSupportResult(session)!.evidence.requestId, recovered.requestId);

    onFetch = () => { onFetch = undefined; cancelSupportTurn(session); void session.abort(); };
    const aborted = await prompt("你好", [hello]);
    assert.deepEqual(aborted.choices, [forced]); assert.equal(getSupportResult(session), undefined);
    const afterAbort = await prompt("你好", [hello, finish]); assert.deepEqual(afterAbort.choices, [forced, "auto"]);

    session.setThinkingLevel("low");
    const thinking = await prompt("你好", [finish]);
    assert.equal(thinking.payloads[0]!.thinking?.type, "enabled");
    assert.deepEqual(thinking.choices, ["auto"], "never send a named required function with opposite thinking settings");
    session.setThinkingLevel("off");
  } finally { session.dispose(); }

  let cancelDuringInit = true;
  session = await createSupportSession(identity, store, runtime, model, undefined, { groupOpenid, focus: {
    read: async () => { if (cancelDuringInit) cancelSupportTurn(session); return undefined; }, write: async () => {},
  } });
  try {
    const beforeCanceledInit = bodies.length;
    await assert.rejects(prompt("你好", [finish]), /aborted/);
    assert.equal(bodies.length, beforeCanceledInit, "cancellation during async initialization now prevents the HTTP request entirely");
    assert.equal(getSupportResult(session), undefined);
    cancelDuringInit = false;
    const initialized = await prompt("你好", [hello, finish]);
    assert.deepEqual(initialized.choices, [forced, "auto"]);
  } finally { session.dispose(); }

  // This is a per-Session extension, not a shared runtime rewrite. Atomic, echo
  // and the independent support verifier retain their original wire options.
  for (const create of [() => createCouponSession(identity, store, runtime, model), () => createQQSession(runtime, model)]) {
    const plain = await create();
    try { const before = bodies.length; responses = [finish]; await plain.prompt("你好", { expandPromptTemplates: false });
      assert.equal(bodies.length, before + 1); assert.equal(bodies[before]!.tool_choice, undefined);
    } finally { plain.dispose(); }
  }
  const support = await createEvidenceSupportClient({ profile: "typed", runtime: { model,
    complete: (context, options) => runtime.complete(model, context, { ...options, fetch: fakeFetch }) } });
  const before = bodies.length;
  responses = [{ text: JSON.stringify({ decisions: [{ id: "RULE", category: "direct_fact", quote: "周一开放。", reason: "原文直接回答。" }] }) }];
  const verification = await verifyEvidenceSupport({ query: "周一开放吗？", scope: { shopId: null, productId: null },
    candidates: [{ id: "RULE", title: "开放时间", body: "周一开放。", tags: [], shopId: null, productId: null, score: .9, rank: 1 }], client: support });
  assert.equal(verification.value[0]!.supported, true); assert.equal(bodies.length, before + 1);
  assert.equal(bodies[before]!.tool_choice, undefined); assert.equal(bodies[before]!.tools, undefined);
  console.log("[support-session] native payload forced/auto, repair, business failure, abort and provider/session isolation PASS (fake HTTP only)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkSupportToolChoice();
