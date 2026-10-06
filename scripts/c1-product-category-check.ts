import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { merchantSourceKey } from "../src/after-sales.ts";
import { contentHash, createBailianClient } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, resolveEvidenceSupportModel } from "../src/evidence-support.ts";
import { knowledgeApplicabilitySourceHash, loadKnowledgeApplicabilitySnapshot, validateKnowledgeApplicabilitySnapshot,
  type KnowledgeApplicabilitySnapshot } from "../src/knowledge-applicability.ts";
import { createKnowledgeService, type KnowledgeSearchInput } from "../src/knowledge-service.ts";
import type { RetrievalDocument } from "../src/retrieval-ranking.ts";
import type { ContextSupportAction } from "../src/support-context-action.ts";
import { SupportController, SupportServiceError, type SupportTurnContext } from "../src/support-controller.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Case = { id: string; query: string; orderId: string | null; evidenceTarget: "current_order" | "rule_only";
  basis?: string; inputHash: string; candidateIds: string[]; expectedByCandidate: Array<{ id: string; status: string; kept: boolean }> };
type Fixture = { version: 1; documents: RetrievalDocument[]; snapshot: unknown; snapshotHash: string; identity: QQIdentity;
  groupOpenid: string; orders: Order[]; cases: Case[]; sources: Array<{ path: string; sha256: string; bytes: number }> };
const root = new URL("../", import.meta.url);

export async function checkC1ProductCategory() {
  const data = JSON.parse(await readFile(new URL("data/c1-product-category-development.json", root), "utf8")) as Fixture;
  assert.equal(data.version, 1); assert.equal(data.cases.length, 6);
  for (const source of data.sources) {
    const bytes = await readFile(new URL(source.path, root));
    assert.equal(contentHash(bytes), source.sha256); assert.equal(bytes.length, source.bytes);
  }
  const origin = JSON.parse(await readFile(new URL("data/c1-support-environment-development.json", root), "utf8")) as {
    cases: Array<{ candidates: RetrievalDocument[] }> };
  const originalById = new Map(origin.cases.flatMap(item => item.candidates).map(doc => [doc.id, doc]));
  const reused = data.documents.filter(doc => originalById.has(doc.id));
  assert.equal(reused.length, 3);
  for (const document of reused) assert.deepEqual(document, originalById.get(document.id), "The three exposed source shapes remain unchanged");
  const snapshot = validateKnowledgeApplicabilitySnapshot(data.snapshot);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.sha256, data.snapshotHash);
  if (snapshot.version !== 2) throw new Error("The category fixture must use explicit v2 declarations.");
  const originalSnapshot = JSON.stringify(snapshot), originalDocuments = JSON.stringify(data.documents);
  const identity = data.identity, groupOpenid = data.groupOpenid, sourceKey = merchantSourceKey(identity, groupOpenid);
  const modelIdentity = resolveEvidenceSupportModel();
  const model = { provider: modelIdentity.provider, id: modelIdentity.model, api: "openai-completions", baseUrl: "https://synthetic.invalid",
    maxTokens: 4096, cost: { input: .1, output: .2, cacheRead: .01, cacheWrite: 0 } };
  let sequence = 0;

  async function execute(item: Case, changes: { snapshot?: KnowledgeApplicabilitySnapshot; documents?: RetrievalDocument[];
    order?: Order; identity?: QQIdentity; onSupport?: (documents: RetrievalDocument[]) => void } = {}) {
    let documents = structuredClone(changes.documents ?? data.documents.filter(doc => item.candidateIds.includes(doc.id)));
    const order = structuredClone(changes.order ?? data.orders.find(order => order.id === item.orderId));
    const authorized: Array<{ identity: QQIdentity; orderId: string; productId: string; asOf: string }> = [];
    const observed: KnowledgeSearchInput[] = [];
    let reranks = 0, supports = 0;
    const supportIds: string[][] = [];
    const rerank = createBailianClient({ timeoutMs: 1000, retries: 0,
      env: { DASHSCOPE_API_KEY: "synthetic-never-sent", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
      fetch: async (_url, init) => {
        reranks++;
        const request = JSON.parse(String(init?.body));
        assert.equal(request.documents.length, documents.length);
        return new Response(JSON.stringify({ results: documents.map((_, index) => ({ index, relevance_score: .9 - index * .01 })),
          usage: { total_tokens: 100 } }));
      } });
    // Deliberately accepts every candidate reaching it: an unsupported model
    // judgment cannot bypass the host's declared necessary category condition.
    const support = await createEvidenceSupportClient({ profile: "typed", timeoutMs: 1000, runtime: { model,
      complete: async (context): Promise<AssistantMessage> => {
        supports++;
        const request = JSON.parse(String(context.messages[0]!.content));
        supportIds.push(request.documents.map((doc: { id: string }) => doc.id));
        assert.equal(request.query, observed.at(-1)!.query);
        assert.ok(!/desiredClaims|expectedByCandidate|productCatalog/.test(JSON.stringify(request)));
        changes.onSupport?.(documents);
        return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
          content: [{ type: "text", text: JSON.stringify({ decisions: request.documents.map((doc: { id: string; body: string }) => ({
            id: doc.id, category: "direct_fact", quote: doc.body, reason: "固定工程接受器，非真实语义判别",
          })) }) }], usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
            cost: { input: .000003, output: .000004, cacheRead: 0, cacheWrite: 0, total: .000007 } } };
      } } });
    const service = createKnowledgeService({ async readKnowledgeDocuments(shopId, productId) {
      assert.equal(shopId ?? null, order?.shop.id ?? null); assert.equal(productId ?? null, order?.items[0]!.productId ?? null);
      assert.equal(authorized.length, order ? 1 : 0, "Order-bound knowledge runs only after this turn's authorized read");
      return structuredClone(documents);
    } }, { mode: "m4-support", timeoutMs: 1000, applicability: "declared", applicabilitySnapshot: changes.snapshot ?? snapshot,
      supportProfile: "typed", clients: { rerank, support } });
    const controller = new SupportController({ store: { async getOrder(who, id) {
      if (!order || id !== order.id || who.appId !== identity.appId || who.senderId !== identity.senderId) throw new OrderAccessError("Synthetic fixture ownership denied");
      authorized.push({ identity: structuredClone(who), orderId: id, productId: order.items[0]!.productId, asOf: order.asOf });
      return structuredClone(order);
    }, async searchKnowledge() { throw new Error("The actual injected knowledge service is required"); } }, knowledge: { async search(input) {
      observed.push(structuredClone(input)); return service.search(input);
    } } });
    const actualIdentity = changes.identity ?? identity;
    const context: SupportTurnContext = { requestId: `category-${++sequence}`, identity: actualIdentity,
      sourceKey: merchantSourceKey(actualIdentity, groupOpenid), trustedRoute: { groupOpenid, messageId: `message-${sequence}` }, userText: item.query };
    const action: ContextSupportAction = { protocol: "v2.2", kind: "policy", question: "模型声称所有商品属于自由场次，不可替换原问",
      questionContext: { kind: "standalone" }, ...(item.orderId ? { orderRef: { kind: "explicit", orderId: item.orderId } } : {}),
      ...(item.evidenceTarget === "rule_only" ? { evidenceTarget: { kind: "rule_only", basis: item.basis ?? item.query } } : {}) };
    const result = await controller.createTurn(context).execute(action).catch(error => {
      assert.notDeepEqual(actualIdentity, identity, "Only the deliberate foreign-identity fixture should fail before knowledge");
      assert.equal(authorized.length, 0); assert.equal(observed.length, 0); assert.equal(reranks + supports, 0);
      throw error;
    });
    const knowledge = result.evidence.knowledge[0];
    if (knowledge) {
      assert.equal(knowledge.context.originalQuery, item.query);
      assert.ok(!knowledge.context.effectiveQuery.includes(action.question));
      assert.equal(knowledge.context.evidenceUse, item.evidenceTarget === "current_order" ? "current_order" : "explanation");
      assert.equal(knowledge.context.scopeSource, order ? "fresh_order" : "global");
      if (item.evidenceTarget === "current_order") {
        assert.deepEqual(observed[0]!.applicabilityContext!.scope, { shopId: order!.shop.id, productId: authorized[0]!.productId });
        assert.equal(observed[0]!.applicabilityContext!.asOf, authorized[0]!.asOf);
        assert.equal(observed[0]!.applicabilityContext!.requestId, context.requestId);
        assert.equal(knowledge.context.facts!.productId, authorized[0]!.productId);
      } else assert.equal(observed[0]!.applicabilityContext, null, "An explicit hypothetical is not promoted to current-order applicability");
      assert.deepEqual(knowledge.trace.rawRanking.map(row => row.id), documents.map(doc => doc.id));
    }
    return { result, knowledge, authorized, observed, reranks, supports, supportIds, documents };
  }

  for (const item of data.cases) {
    assert.equal(item.inputHash, contentHash({ query: item.query, orderId: item.orderId, evidenceTarget: item.evidenceTarget,
      ...(item.basis ? { basis: item.basis } : {}), candidateIds: item.candidateIds }));
    const run = await execute(item), gate = run.knowledge!.trace.applicability!.gate!;
    assert.equal(gate.version, "declared-order-preconditions-v2"); assert.equal(gate.snapshotHash, snapshot.sha256);
    assert.equal(gate.status, "ready"); assert.equal(gate.integrity, true); assert.equal(gate.reason, null);
    assert.deepEqual(gate.decisions.map(row => ({ id: row.id, status: row.status })), item.expectedByCandidate.map(row => ({ id: row.id, status: row.status })));
    assert.deepEqual(run.result.evidence.rules.map(rule => rule.sourceId), item.expectedByCandidate.filter(row => row.kept).map(row => row.id));
    assert.equal(run.reranks, 1); assert.equal(run.supports, item.expectedByCandidate.some(row => row.kept) ? 1 : 0);
    assert.deepEqual(run.supportIds, run.supports ? [item.expectedByCandidate.filter(row => row.kept).map(row => row.id)] : [],
      "Blocked category targets never reach support; other undeclared sources still require semantic verification");
    assert.equal(run.knowledge!.trace.calls.filter(call => call.operation === "support").length, run.supports);
    assert.equal(run.authorized.length, item.orderId ? 1 : 0);
    assert.deepEqual(run.result.evidence.actualCalls.map(call => call.name), item.orderId ? ["get_order", "search_faq"] : ["search_faq"]);
    for (const [index, decision] of gate.decisions.entries()) assert.equal(decision.rank, index + 1, "Filtering does not renumber original ranks");
    for (const expected of item.expectedByCandidate.filter(row => !row.kept)) {
      assert.equal(run.knowledge!.trace.acceptance!.rejected.find(row => row.id === expected.id)!.reason,
        expected.status === "mismatched" ? "applicability_mismatch" : "applicability_unknown");
    }
  }

  const matched = data.cases.find(item => item.expectedByCandidate.some(row => row.status === "matched"))!;
  const unknown = data.cases.find(item => item.expectedByCandidate.some(row => row.status === "unknown"))!;
  const restricted = data.documents.find(doc => snapshot.documents.find(rule => rule.sourceId === doc.id)?.requiredProductCategories)!;
  const ordinary = data.documents.find(doc => !snapshot.documents.find(rule => rule.sourceId === doc.id)?.requiredProductCategories)!;
  const limited = data.orders.find(order => snapshot.productCatalog.find(product => product.productId === order.items[0]!.productId)?.categories
    .every(category => !snapshot.documents.find(rule => rule.sourceId === restricted.id)!.requiredProductCategories!.includes(category)))!;
  assert.ok(limited);
  const unknownOnly = await execute({ ...unknown, candidateIds: [restricted.id] });
  assert.equal(unknownOnly.supports, 0); assert.equal(unknownOnly.knowledge!.trace.applicability!.gate!.decisions[0]!.reason, "product_category_unknown");
  const freshChanged = structuredClone(limited); freshChanged.id = matched.orderId!;
  assert.equal(freshChanged.items[0]!.productName, data.orders.find(order => order.id === matched.orderId)!.items[0]!.productName,
    "Two distinct category IDs intentionally share the same product name");
  const changed = await execute(matched, { order: freshChanged });
  assert.equal(changed.supports, 0); assert.equal(changed.knowledge!.trace.applicability!.gate!.decisions[0]!.reason, "product_category_mismatch",
    "A fresh product ID, not the same product name or previous lookup, determines the declared category");
  const foreignShop = structuredClone(data.orders.find(order => order.id === matched.orderId)!); foreignShop.shop.id = "other-category-shop";
  const otherScope = await execute(matched, { order: foreignShop });
  assert.equal(otherScope.supports, 0); assert.equal(otherScope.knowledge!.trace.applicability!.gate!.decisions[0]!.reason, "product_category_unknown",
    "A catalog entry for the same product ID in another shop cannot establish this shop's category");

  await assert.rejects(execute(matched, { identity: { ...identity, senderId: "OTHER" } }),
    error => error instanceof SupportServiceError && error.errorKind === "business_denial",
    "Foreign ownership fails before knowledge and provider work");

  const changedSource = await execute(matched, { documents: [{ ...restricted, body: restricted.body + "规则已更新。" }] });
  assert.equal(changedSource.knowledge!.trace.reason, "metadata_binding_invalid"); assert.equal(changedSource.supports, 0);
  assert.equal(changedSource.knowledge!.trace.status, "unavailable"); assert.deepEqual(changedSource.result.evidence.rules, []);
  const changedCatalog = structuredClone(snapshot); changedCatalog.productCatalog[0]!.categories = ["tampered_category"];
  const unboundCatalog = await execute(matched, { snapshot: changedCatalog });
  assert.equal(unboundCatalog.knowledge!.trace.reason, "metadata_binding_invalid"); assert.equal(unboundCatalog.supports, 0);
  assert.deepEqual(unboundCatalog.result.evidence.rules, []);
  const duringSupport = await execute(matched, { onSupport(documents) { documents[0]!.body += "支持判别期间变更。"; } });
  assert.equal(duringSupport.supports, 1); assert.equal(duringSupport.knowledge!.trace.reason, "source_changed");
  assert.deepEqual(duringSupport.result.evidence.rules, []); assert.equal(duringSupport.knowledge!.trace.status, "unavailable");
  const ruleOnly = data.cases.find(item => item.evidenceTarget === "rule_only" && item.orderId)!;
  const missingMetadata = validateKnowledgeApplicabilitySnapshot({ version: 2, serialization: snapshot.serialization,
    productCatalog: snapshot.productCatalog, documents: snapshot.documents.filter(rule => rule.sourceId !== restricted.id) });
  const undeclared = await execute(ruleOnly, { snapshot: missingMetadata });
  assert.equal(undeclared.knowledge!.trace.reason, "metadata_binding_invalid"); assert.equal(undeclared.supports, 0);
  assert.equal(undeclared.knowledge!.trace.status, "unavailable"); assert.deepEqual(undeclared.result.evidence.rules, []);
  for (const mutation of ["body", "scope"] as const) {
    const documents = structuredClone(data.documents.filter(doc => ruleOnly.candidateIds.includes(doc.id)));
    if (mutation === "body") documents[0]!.body += "规则解释原文更新。";
    else documents[0]!.shopId = data.orders.find(order => order.id === ruleOnly.orderId)!.shop.id;
    const invalidExplanation = await execute(ruleOnly, { documents });
    assert.equal(invalidExplanation.knowledge!.trace.reason, "metadata_binding_invalid"); assert.equal(invalidExplanation.supports, 0);
    assert.equal(invalidExplanation.knowledge!.trace.status, "unavailable"); assert.deepEqual(invalidExplanation.result.evidence.rules, []);
  }

  const six = [...Array.from({ length: 5 }, (_, index) => ({ ...restricted, id: `CATEGORY-TOP-${index}` })), { ...ordinary, id: "UNIVERSAL-SIXTH" }];
  const expanded = validateKnowledgeApplicabilitySnapshot({ version: 2, serialization: "knowledge-document-v1", productCatalog: snapshot.productCatalog,
    documents: six.map(doc => ({ ...snapshot.documents.find(rule => rule.sourceId === (doc.id === "UNIVERSAL-SIXTH" ? ordinary.id : restricted.id))!,
      sourceId: doc.id, sourceHash: knowledgeApplicabilitySourceHash(doc) })) });
  const noRefill = await execute({ ...unknown, candidateIds: six.map(doc => doc.id) }, { documents: six, snapshot: expanded });
  assert.equal(noRefill.supports, 0); assert.deepEqual(noRefill.result.evidence.rules, []);
  assert.equal(noRefill.knowledge!.trace.rawRanking.length, 6);
  assert.equal(noRefill.knowledge!.trace.applicability!.gate!.decisions.length, 5);
  assert.equal(noRefill.knowledge!.trace.acceptance!.rejected.find(row => row.id === "UNIVERSAL-SIXTH")!.reason, "top_k_limit",
    "Blocked Top5 candidates do not promote an unjudged sixth source");

  const v1 = validateKnowledgeApplicabilitySnapshot({ version: 1, serialization: "knowledge-document-v1", documents: snapshot.documents.map(rule => {
    const { requiredProductCategories: _category, ...rest } = rule;
    return { ...rest, basis: rest.basis.filter(basis => basis.field !== "requiredProductCategories") };
  }) });
  const legacy = await execute(matched, { snapshot: v1, order: freshChanged });
  assert.equal(legacy.supports, 1); assert.equal(legacy.knowledge!.trace.applicability!.gate!.version, "declared-order-preconditions-v1");
  const v1Missing = validateKnowledgeApplicabilitySnapshot({ version: 1, serialization: v1.serialization,
    documents: v1.documents.filter(rule => rule.sourceId !== restricted.id) });
  const legacyExplanation = await execute(ruleOnly, { snapshot: v1Missing });
  assert.equal(legacyExplanation.supports, 1, "Historical v1 rule-only reference exceptions remain compatible");
  assert.equal((await loadKnowledgeApplicabilitySnapshot()).version, 1, "The installed default remains the historical v1 declaration");
  assert.equal(JSON.stringify(snapshot), originalSnapshot); assert.equal(JSON.stringify(data.documents), originalDocuments);
  assert.equal(merchantSourceKey(identity, groupOpenid), sourceKey);
  console.log("C1 product category checks passed: authorized Controller→fresh product ID→declared v2 service, blocked targets excluded from support, rule-only/universal positives, integrity/source changes and Top5/no-refill; 0 remote/DB/QQ calls.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkC1ProductCategory();
