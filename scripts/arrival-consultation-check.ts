import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createArrivalConsultation, type ArrivalConsultationTrace } from "../src/arrival-consultation.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { knowledgeApplicabilitySourceHash } from "../src/knowledge-applicability.ts";

export async function checkArrivalConsultation() {
  const original = JSON.parse(await readFile(new URL("../data/arrival-consultation-v1.json", import.meta.url), "utf8"));
  const owner = { appId: "TEST_APP", senderId: "TEST_USER1" };
  const order: Awaited<ReturnType<CouponStore["getOrder"]>> = {
    source: "demo-database", id: "COUPON-1001", status: "paid", asOf: "2026-10-07T00:00:00.000Z",
    amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: null, paidAt: null,
    shop: { id: "shop-demo-1", name: "合成店", merchantName: "合成商家", address: "合成地址" },
    items: [{ id: "synthetic-item", productId: "product-demo-1", productName: "合成午餐券", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
    coupons: [], payments: [], refunds: [],
  };
  function fixture(rules: unknown = structuredClone(original), read?: () => Promise<unknown>, signal?: AbortSignal) {
    const trace: ArrivalConsultationTrace[] = [], reads: Array<{ identity: QQIdentity; id: string }> = [];
    let sourceReads = 0, current = structuredClone(order);
    const state = { fault: false, afterFirstRead: () => {}, get current() { return current; }, set current(value) { current = value; } };
    const ask = createArrivalConsultation({ async getOrder(identity, id) {
      reads.push({ identity: structuredClone(identity), id });
      if (state.fault) throw new Error("SECRET database details");
      if (identity.appId !== owner.appId || identity.senderId !== owner.senderId || id !== order.id) throw new OrderAccessError();
      const result = structuredClone(current); if (reads.length === 1) state.afterFirstRead(); return result;
    } }, { readRules: async () => { sourceReads++; return read ? read() : structuredClone(rules); }, signal, onTrace: value => trace.push(value) });
    return { ask, reads, trace, state, get sourceReads() { return sourceReads; } };
  }
  const notice = async (test: ReturnType<typeof fixture>, text: string, identity = owner) => {
    const reply = await test.ask(identity, text); assert.equal(reply?.kind, "notice");
    assert.ok(!JSON.stringify(reply).includes("SECRET")); assert.deepEqual(test.trace.at(-1)!.sources, []);
    assert.deepEqual(test.trace.at(-1)!.providerCalls, { agent: 0, question: 0, rerank: 0, support: 0 });
    return reply;
  };
  let test = fixture();
  for (const text of ["退款多久到账？", "COUPON-1001 银行卡", "你好"]) assert.equal(await test.ask(owner, text), undefined);
  assert.equal(test.sourceReads, 0); assert.equal(test.reads.length, 0); assert.equal(test.trace.length, 0);
  for (const text of ["查询到账", "查询到账 COUPON-1001", "查询到账 信用卡", "查询到账 银行卡 退款", "退款；查询到账 银行卡",
    "查询到账 银行卡\n", "查询到账\n银行卡", "查询到账 COUPON-1001 COUPON-1002 银行卡", "\u200b查询到账 银行卡",
    "查\u200b询到账 银行卡", "查询到账 银\u2060行卡", "查询到账 银行卡\u0000", "查询到账 银行卡\u2028"]) {
    test = fixture(); await notice(test, text); assert.equal(test.sourceReads, 0); assert.equal(test.reads.length, 0);
  }
  test = fixture();
  const global = await test.ask(owner, "查询到账 银行卡");
  assert.equal(global?.kind, "answer"); assert.match(global!.text, /项目原创模拟规则咨询[\s\S]*假设退款已审核通过并已发起[\s\S]*3–7个工作日/);
  assert.match(global!.text, /咨询渠道不代表实际支付渠道[\s\S]*未办理退款[\s\S]*不证明这笔退款已批准、已发起或已到账/);
  assert.deepEqual(global!.evidenceIds, ["ARRIVAL-BANK-V1"]); assert.equal(test.reads.length, 0); assert.equal(test.sourceReads, 2);
  assert.equal(test.trace[0]!.sources[0]!.sourceHash, original.documents[0].coverage.sourceHash);
  assert.deepEqual(test.trace[0]!.knowledge!.calls, []); assert.equal(test.trace[0]!.originalText, "查询到账 银行卡");
  assert.equal(test.trace[0]!.canonicalQuestion, "假设退款已审核通过并已发起，银行卡渠道通常何时到账？");
  const raw = "\t 查询到账　COUPON-1001\t电子钱包　";
  const personal = await test.ask(owner, raw);
  assert.equal(personal?.kind, "answer"); assert.match(personal!.text, /1–3个工作日/);
  assert.equal(test.reads.length, 2); assert.equal(test.sourceReads, 5); assert.equal(test.trace.at(-1)!.originalText, raw);
  assert.equal(test.trace.at(-1)!.lastRulesCheck!.stage, "post_order_authorization");
  assert.equal(test.trace.at(-1)!.lastRulesCheck!.hash, test.trace.at(-1)!.rulesHash);
  assert.deepEqual(test.trace.at(-1)!.scope, { shopId: order.shop.id, productId: order.items[0]!.productId });
  assert.deepEqual(test.reads.map(read => read.identity), [owner, owner]);
  const again = await test.ask(owner, "查询到账 银行卡"); assert.equal(again?.kind, "answer"); assert.equal(test.trace.at(-1)!.orderId, null);
  assert.deepEqual(test.trace.at(-1)!.scope, { shopId: null, productId: null }); assert.equal(test.reads.length, 2, "no implicit order focus");
  for (const identity of [{ ...owner, senderId: "TEST_USER2" }, { ...owner, appId: "OTHER_APP" }, {} as QQIdentity]) {
    test = fixture(); await notice(test, "查询到账 COUPON-1001 银行卡", identity); assert.equal(test.sourceReads, 0);
  }
  test = fixture(); await notice(test, "查询到账 COUPON-9999 银行卡"); assert.equal(test.sourceReads, 0);
  test = fixture(); test.state.fault = true; await notice(test, "查询到账 COUPON-1001 银行卡"); assert.equal(test.sourceReads, 0);
  test = fixture(); test.state.current.items.push({ ...order.items[0]!, productId: "second-product" });
  await notice(test, "查询到账 COUPON-1001 银行卡"); assert.equal(test.sourceReads, 0);
  test = fixture(); test.state.afterFirstRead = () => { test.state.current.items[0]!.productId = "changed-product"; };
  await notice(test, "查询到账 COUPON-1001 银行卡"); assert.equal(test.reads.length, 2); assert.equal(test.trace.at(-1)!.reason, "scope_changed");
  test = fixture(); test.state.afterFirstRead = () => { test.state.fault = true; };
  await notice(test, "查询到账 COUPON-1001 银行卡"); assert.equal(test.reads.length, 2);
  const unknown = structuredClone(original); unknown.documents[0].source.body = "退款通常3–7个工作日到账。"; delete unknown.documents[0].coverage;
  test = fixture(unknown); await notice(test, "查询到账 银行卡"); assert.equal(test.trace.at(-1)!.reason, "coverage_unknown");
  const scoped = structuredClone(original); scoped.documents[0].source.shopId = "another-shop"; scoped.documents[0].source.productId = "another-product";
  scoped.documents[0].coverage.scope = { shopId: "another-shop", productId: "another-product" };
  scoped.documents[0].coverage.sourceHash = knowledgeApplicabilitySourceHash(scoped.documents[0].source);
  test = fixture(scoped); await notice(test, "查询到账 COUPON-1001 银行卡"); assert.equal(test.trace.at(-1)!.reason, "coverage_unknown");
  for (const mutate of [
    (data: typeof original) => { data.documents[0].source.body += "来源变更"; },
    (data: typeof original) => { data.documents[0].source.title += "来源变更"; },
    (data: typeof original) => { data.documents[0].source.tags.push("来源变更"); },
    (data: typeof original) => { data.documents[0].source.id = "changed-source"; },
    (data: typeof original) => { data.documents[0].source.status = "inactive"; },
    (data: typeof original) => { data.documents[0].coverage.sourceHash = "0".repeat(64); },
    (data: typeof original) => { data.documents[0].coverage.scope.productId = "forged-product"; },
    (data: typeof original) => { data.documents[0].coverage.prerequisites = ["refund_approved"]; },
    (data: typeof original) => { data.documents[0].coverage.businessDays.maximum = 99; },
    (data: typeof original) => { data.documents[0].coverage.channel = "电子钱包"; },
    (data: typeof original) => { data.documents[0].coverage.quote = "退款通常3–7个工作日到账。"; },
    (data: typeof original) => { data.documents[0].coverage.hidden = "unbound"; },
    (data: typeof original) => { delete data.documents[0].coverage.version; },
  ]) {
    const corrupt = structuredClone(original); mutate(corrupt); test = fixture(corrupt); await notice(test, "查询到账 银行卡");
  }
  let reads = 0;
  test = fixture(undefined, async () => { const data = structuredClone(original); if (++reads === 2) data.documents[0].coverage.version = "different-review-v2"; return data; });
  await notice(test, "查询到账 银行卡"); assert.equal(test.trace.at(-1)!.reason, "source_changed", "metadata-only updates also invalidate the completed consultation");
  reads = 0;
  test = fixture(undefined, async () => { const data = structuredClone(original); if (++reads === 2) { data.documents[0].source.body += "规则修改";
    data.documents[0].coverage.sourceHash = knowledgeApplicabilitySourceHash(data.documents[0].source); } return data; });
  await notice(test, "查询到账 银行卡"); assert.equal(test.trace.at(-1)!.reason, "source_changed");
  for (const metadataOnly of [false, true]) {
    const currentRules = structuredClone(original), traces: ArrivalConsultationTrace[] = []; let authorizations = 0, reads = 0;
    const changedDuringAuthorization = createArrivalConsultation({ async getOrder() {
      if (++authorizations === 2) {
        const row = currentRules.documents[0]; row.coverage.version = "arrival-bank-v2";
        if (!metadataOnly) { const quote = "假设退款已审核通过并已发起，银行卡渠道通常在8–10个工作日到账。";
          row.source.body = row.source.body.replace(row.coverage.quote, quote); row.coverage.quote = quote;
          row.coverage.businessDays = { minimum: 8, maximum: 10 }; row.coverage.sourceHash = knowledgeApplicabilitySourceHash(row.source); }
      }
      return structuredClone(order);
    } }, { readRules: async () => { reads++; return structuredClone(currentRules); }, onTrace: value => traces.push(value) });
    const reply = await changedDuringAuthorization(owner, "查询到账 COUPON-1001 银行卡");
    assert.equal(reply?.kind, "notice"); assert.doesNotMatch(reply!.text, /3–7|8–10/);
    assert.equal(authorizations, 2); assert.equal(reads, 3); assert.equal(traces[0]!.knowledge!.status, "accepted");
    assert.equal(traces[0]!.reason, "source_changed"); assert.deepEqual(traces[0]!.sources, []);
    assert.equal(traces[0]!.lastRulesCheck!.stage, "post_order_authorization");
    assert.notEqual(traces[0]!.lastRulesCheck!.hash, traces[0]!.rulesHash);
    assert.equal(new Date(traces[0]!.lastRulesCheck!.observedAt).toISOString(), traces[0]!.lastRulesCheck!.observedAt);
  }
  const conflict = structuredClone(original);
  for (let index = 0; index < 5; index++) {
    const row = structuredClone(original.documents[0]); row.source.id = `ARRIVAL-BANK-EXTRA-${index}`;
    if (index === 4) { row.coverage.businessDays = { minimum: 8, maximum: 10 }; row.coverage.quote = "假设退款已审核通过并已发起，银行卡渠道通常在8–10个工作日到账。";
      row.source.title = "另一模拟银行规则"; row.source.tags = []; row.source.body = row.coverage.quote; }
    row.coverage.sourceHash = knowledgeApplicabilitySourceHash(row.source); conflict.documents.push(row);
  }
  test = fixture(conflict); await notice(test, "查询到账 银行卡"); assert.equal(test.trace.at(-1)!.reason, "rule_conflict");
  assert.ok(!test.trace.at(-1)!.knowledge!.sources!.some(source => source.sourceId === "ARRIVAL-BANK-EXTRA-4"), "the conflicting source is outside lexical Top5");
  test = fixture(undefined, async () => { throw new Error("SECRET rules path"); }); await notice(test, "查询到账 银行卡");
  const stopped = new AbortController(); stopped.abort(); test = fixture(undefined, undefined, stopped.signal);
  await notice(test, "查询到账 COUPON-1001 银行卡"); assert.equal(test.trace.at(-1)!.reason, "aborted"); assert.equal(test.reads.length, 0); assert.equal(test.sourceReads, 0);
  let enter!: () => void, release!: (value: unknown) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<unknown>(resolve => { release = resolve; });
  const abort = new AbortController(); test = fixture(undefined, async () => { enter(); return pending; }, abort.signal);
  const outcome = test.ask(owner, "查询到账 银行卡"); await entered; abort.abort(); assert.equal((await outcome)?.kind, "notice");
  const frozen = JSON.stringify(test.trace); release(structuredClone(original)); await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.stringify(test.trace), frozen); assert.equal(test.sourceReads, 1); assert.equal(test.trace[0]!.reason, "aborted"); assert.deepEqual(test.trace[0]!.sources, []);
  const finalAbort = new AbortController(), finalTraces: ArrivalConsultationTrace[] = []; let authorizations = 0;
  const stopBeforeReceipt = createArrivalConsultation({ async getOrder() { if (++authorizations === 2) finalAbort.abort(); return structuredClone(order); } },
    { signal: finalAbort.signal, onTrace: value => finalTraces.push(value) });
  assert.equal((await stopBeforeReceipt(owner, "查询到账 COUPON-1001 银行卡"))?.kind, "notice");
  assert.equal(finalTraces[0]!.knowledge!.status, "accepted"); assert.equal(finalTraces[0]!.reason, "aborted"); assert.deepEqual(finalTraces[0]!.sources, []);
  const mutableIdentity = { ...owner }; const stableIdentity = fixture(undefined, async () => { mutableIdentity.senderId = "TEST_USER2"; return structuredClone(original); });
  assert.equal((await stableIdentity.ask(mutableIdentity, "查询到账 COUPON-1001 银行卡"))?.kind, "answer");
  assert.deepEqual(stableIdentity.reads.map(read => read.identity), [owner, owner], "caller mutation cannot change the authorized actor while awaiting rules");
  const observerThrows = createArrivalConsultation({ getOrder: async () => structuredClone(order) }, { onTrace() { throw new Error("observer fault"); } });
  assert.equal((await observerThrows(owner, "查询到账 银行卡"))?.kind, "answer");
  console.log("到账咨询检查通过：完整命令/缺项/原问、全篇哈希与条件覆盖、fresh授权/范围变化、Top5外冲突、来源变化、取消/故障/observer隔离；0模型/DB/QQ/资金写入。");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkArrivalConsultation();
