import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { merchantSourceKey } from "../src/after-sales.ts";
import { createBailianClient } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { createEvidenceSupportClient, evidenceSupportPromptVersion, evidenceSupportTypedPromptVersion, resolveEvidenceSupportModel, type EvidenceSupportModel, type EvidenceSupportProfile } from "../src/evidence-support.ts";
import { resolveSupportRunParameters, type SupportExperimentParameters } from "../src/support-parameters.ts";
import { createKnowledgeService, type KnowledgeService, type KnowledgeTrace } from "../src/knowledge-service.ts";
import { rankBm25, scopeDocuments, type RetrievalDocument } from "../src/retrieval-ranking.ts";
import { SupportController, type SupportResult, type TrustedPolicyTopic } from "../src/support-controller.ts";
import { parseContextSupportAction, type ContextSupportAction } from "../src/support-context-action.ts";
import { rememberOrderChoice, type TrustedAmountReference, type TrustedOrderChoices } from "../src/support-context.ts";
import { loadAcceptanceDataset } from "./acceptance-data.ts";

type Order = Awaited<ReturnType<CouponStore["getOrder"]>>;
type Topic = { kind: string; order: string | null; provenance: string; identity: QQIdentity; groupOpenid: string; priorQuery: string;
  sourceEvidence?: { docId: string; quote: string }; paymentChannel?: string; boundaryWorkingDays?: number; hoursBefore?: number; decisionMaker?: string };
type Input = { identity: QQIdentity; groupOpenid: string; focusOrder: string | null; topics: Topic[];
  amountReference?: { order: string; field: string; productId: string; provenance: string }; couponSelector?: string;
  alternatives?: string[]; alternativeSource?: string };
type Expected = { resolution: "resolved" | "resolved_no_evidence" | "clarify"; relevant: string[];
  evidence: Array<{ docId: string; quote: string }>; effectiveQueryMustInclude: string[]; reason: string; facts?: Record<string, string | number | boolean> };
type Variant = { id: string; input: Input; expected: Expected };
type Case = { id: string; originalId?: string; corpus: "online" | "reference"; originalQuery: string; queryOnlyExpected: { resolution: "clarify"; relevant: string[]; reason: string };
  contextualMeaning: string; evaluationStratum?: "direct_fact" | "boundary_question" | "direct_missing_fact"; contextContract?: "core" | "fact-support";
  labelReview?: { requestedFact: string; basis: Array<{ docId: string; quote: string }>; completeness: string }; variants: Variant[] };
type Dataset = { version: number; suiteId: string; validationPolicy: string; provenance: string; measurement: Record<string, string>;
  actor: QQIdentity; groupOpenid: string; orderFixtures: Record<string, { orderId: string; template: string; owner: string }>; cases: Case[] };
type Template = { shopId: string; status: string; totalCents: number; paidCents: number; refundedCents: number;
  items: Array<{ productId: string; quantity: number; unitPriceCents: number; totalCents: number }>;
  coupons: Array<{ status: string; expiresAfterAnchorDays: number }>; payment: { status: string; amountCents: number };
  historicalRefunds: { count: number; succeededCents: number } };
const root = new URL("../", import.meta.url), hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type C1Split = "original" | "development" | "validation-v2" | "validation-v3";
const dataPaths: Record<C1Split, string> = { original: "data/c1-context-validation.json", development: "data/c1-context-development.json", "validation-v2": "data/c1-context-validation-v2.json", "validation-v3": "data/c1-context-validation-v3.json" };
const json = async (path: string) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();

export async function loadC1ContextDataset(split: C1Split = "original") {
  assert.ok(Object.hasOwn(dataPaths, split));
  const path = dataPaths[split], manifest = await json(path.replace(".json", "-source.json")), bytes = await readFile(new URL(path, root));
  assert.equal(manifest.version, split === "original" ? 1 : split === "validation-v3" ? 3 : 2);
  assert.equal(manifest.stage, split === "original" ? "fixed-before-c1-execution" : split === "validation-v3" ? "fixed-before-v3-execution" : "fixed-before-v2-execution");
  assert.equal(manifest.validationPolicy, "fixed-validation-not-blind");
  assert.equal(manifest.dataset.path, path);
  assert.equal(manifest.dataset.sha256, hash(bytes)); assert.equal(manifest.dataset.bytes, bytes.length);
  for (const [path, digest] of Object.entries(manifest.baseFiles)) assert.equal(hash(await readFile(new URL(path, root))), digest, path);
  const dataset = JSON.parse(bytes.toString()) as Dataset;
  const original = await loadAcceptanceDataset("validation");
  const templates = (await json("data/support-v2-validation.json")).orderTemplates as Record<string, Template>;
  const corpora = Object.fromEntries(original.corpora.map(corpus => [corpus.id, corpus.documents])) as Record<Case["corpus"], RetrievalDocument[]>;
  assert.equal(dataset.version, manifest.version); assert.equal(dataset.validationPolicy, "fixed-validation-not-blind");
  assert.equal(dataset.cases.length, split === "development" ? 7 : split === "validation-v3" ? 12 : 6);
  assert.equal(new Set(dataset.cases.map(row => row.id)).size, dataset.cases.length);
  if (split === "original") assert.deepEqual(dataset.cases.map(row => row.id), Array.from({ length: 6 }, (_, i) => `a1-val-${String(55 + i).padStart(3, "0")}`));
  else {
    assert.equal(manifest.split, split); assert.equal(manifest.review[split === "validation-v3" ? "beforeAnyV3Execution" : "beforeAnyV2Execution"], true); assert.equal(manifest.review.isBlind, false);
    const previous: Dataset = await json(dataPaths.original);
    const oldQueries = new Set(previous.cases.map(row => row.originalQuery));
    if (split === "validation-v2" || split === "validation-v3") for (const row of (await json(dataPaths.development) as Dataset).cases) oldQueries.add(row.originalQuery);
    if (split === "validation-v3") for (const row of (await json(dataPaths["validation-v2"]) as Dataset).cases) oldQueries.add(row.originalQuery);
    assert.ok(dataset.cases.every(row => !oldQueries.has(row.originalQuery)), "New dataset must not repeat old/current-development questions");
  }
  for (const fixture of Object.values(dataset.orderFixtures)) {
    assert.match(fixture.orderId, /^COUPON-\d{4}$/); assert.ok(templates[fixture.template]); assert.ok(nonempty(fixture.owner));
  }
  for (const row of dataset.cases) {
    const old = original.corpora.flatMap(corpus => corpus.questions).find(question => question.id === (row.originalId ?? row.id))!;
    if (split === "original") assert.equal(row.originalQuery, old.query); else assert.ok(nonempty(row.originalQuery));
    assert.equal(old.suite, "context"); assert.equal(old.deferredReason, "C1");
    assert.equal(row.queryOnlyExpected.resolution, "clarify"); assert.deepEqual(row.queryOnlyExpected.relevant, []);
    assert.ok(nonempty(row.contextualMeaning)); assert.ok(row.variants.length >= (split === "validation-v3" && row.contextContract === "fact-support" ? 1 : 3));
    if (split === "validation-v3") {
      assert.ok(["direct_fact", "boundary_question", "direct_missing_fact"].includes(row.evaluationStratum!));
      assert.ok(["core", "fact-support"].includes(row.contextContract!));
      assert.ok(nonempty(row.labelReview?.requestedFact) && nonempty(row.labelReview?.completeness));
      assert.ok(row.labelReview!.basis.length > 0);
      for (const evidence of row.labelReview!.basis) assert.ok(corpora[row.corpus].find(doc => doc.id === evidence.docId)?.body.includes(evidence.quote), `${row.id} review quote`);
      const known = row.variants.find(variant => variant.id === "known")!;
      assert.ok(known); assert.equal(known.expected.resolution, row.evaluationStratum === "direct_missing_fact" ? "resolved_no_evidence" : "resolved");
      if (row.contextContract === "core") assert.deepEqual(row.variants.map(variant => variant.id), ["known", "missing", "ambiguous"]);
      else assert.deepEqual(row.variants.map(variant => variant.id), ["known"]);
    }
    assert.equal(new Set(row.variants.map(variant => variant.id)).size, row.variants.length);
    for (const variant of row.variants) {
      const input = variant.input, expected = variant.expected;
      assert.ok(nonempty(variant.id)); assert.deepEqual(input.identity, dataset.actor); assert.equal(input.groupOpenid, dataset.groupOpenid);
      assert.ok(input.focusOrder === null || dataset.orderFixtures[input.focusOrder]); assert.ok(Array.isArray(input.topics));
      for (const topic of input.topics) {
        assert.ok(nonempty(topic.kind)); assert.ok(nonempty(topic.priorQuery) && topic.priorQuery.length <= 500);
        assert.equal(topic.provenance, "successful-host-result"); assert.deepEqual(topic.identity, input.identity); assert.equal(topic.groupOpenid, input.groupOpenid);
        assert.ok(topic.order === null || dataset.orderFixtures[topic.order]);
        if (topic.order) assert.equal(dataset.orderFixtures[topic.order]!.owner, input.identity.senderId);
        if (topic.sourceEvidence) assert.ok(corpora[row.corpus].find(doc => doc.id === topic.sourceEvidence!.docId)?.body.includes(topic.sourceEvidence.quote));
      }
      if (input.amountReference) {
        const reference = input.amountReference, template = templates[dataset.orderFixtures[reference.order]!.template]!;
        assert.equal(reference.provenance, "successful-host-result"); assert.equal(reference.field, "item_paid_unit");
        assert.ok(template.items.some(item => item.productId === reference.productId));
      }
      if (input.alternatives) { assert.equal(input.alternativeSource, "successful-host-order-list"); assert.ok(input.alternatives.every(key => dataset.orderFixtures[key])); }
      assert.ok(["resolved", "resolved_no_evidence", "clarify"].includes(expected.resolution)); assert.ok(nonempty(expected.reason));
      assert.equal(new Set(expected.relevant).size, expected.relevant.length);
      assert.deepEqual(expected.evidence.map(item => item.docId).sort(), [...expected.relevant].sort());
      if (expected.resolution === "resolved") assert.ok(expected.relevant.length); else assert.equal(expected.relevant.length, 0);
      const target = expected.facts?.resolvedOrderId;
      const fixture = target ? Object.values(dataset.orderFixtures).find(item => item.orderId === target)
        : input.focusOrder ? dataset.orderFixtures[input.focusOrder] : undefined;
      const template = fixture ? templates[fixture.template] : undefined;
      const scope = { shopId: template?.shopId ?? null, productId: template?.items[0]?.productId ?? null };
      const visible = scopeDocuments(corpora[row.corpus], scope);
      for (const evidence of expected.evidence) assert.ok(visible.find(doc => doc.id === evidence.docId)?.body.includes(evidence.quote), `${row.id}/${variant.id} gold scope/quote`);
      if (row.corpus === "reference") { assert.equal(input.focusOrder, null); assert.ok(input.topics.every(topic => topic.order === null)); }
    }
  }
  const variants = dataset.cases.flatMap(row => row.variants);
  assert.deepEqual(manifest.counts, { ...(split === "original" ? { originalCases: 6 } : { cases: dataset.cases.length,
    originalCaseFamilies: new Set(dataset.cases.map(row => row.originalId)).size }), queryOnlyVariants: dataset.cases.length, contextualVariants: variants.length,
    contextualResolved: variants.filter(row => row.expected.resolution === "resolved").length,
    contextualResolvedNoEvidence: variants.filter(row => row.expected.resolution === "resolved_no_evidence").length,
    contextualClarify: variants.filter(row => row.expected.resolution === "clarify").length });
  assert.equal(variants.length, split === "validation-v2" ? 18 : split === "validation-v3" ? 24 : 21);
  if (split === "validation-v3") {
    const strata = Object.fromEntries((["direct_fact", "boundary_question", "direct_missing_fact"] as const).map(kind => [kind, dataset.cases.filter(row => row.evaluationStratum === kind).length]));
    assert.deepEqual(strata, { direct_fact: 6, boundary_question: 2, direct_missing_fact: 4 }); assert.deepEqual(manifest.strata, strata);
    assert.equal(dataset.cases.filter(row => row.contextContract === "core").length, 6);
    assert.equal(new Set(dataset.cases.filter(row => row.contextContract === "core").map(row => row.originalId)).size, 6);
    assert.deepEqual([manifest.counts.contextualResolved, manifest.counts.contextualResolvedNoEvidence, manifest.counts.contextualClarify], [8, 4, 12]);
  }
  return { dataset, manifest, corpora, templates };
}

type ActionAdapter = { kind: "policy" | "refund_eligibility" | "paid_amount_compare" | "clarify";
  orderRef: "focus" | "alternative" | null; questionContext: "standalone" | "previous" | null;
  contract: "knowledge" | "paid_facts_only" | "unsupported_refund_limit"; productMention?: string };
async function loadActionAdapter() {
  const path = "data/c1-context-action-adapter.json", manifest = await json(path.replace(".json", "-source.json"));
  const bytes = await readFile(new URL(path, root));
  assert.deepEqual(manifest.dataset, { path, sha256: hash(bytes), bytes: bytes.length });
  const data = JSON.parse(bytes.toString()) as { version: number; protocol: string; originalDatasets: Record<string, string>; cases: Record<string, ActionAdapter> };
  assert.equal(data.version, 1); assert.equal(data.protocol, "v2.2"); assert.equal(Object.keys(data.cases).length, 31);
  assert.deepEqual(data.originalDatasets, manifest.originalDatasets);
  for (const [path, digest] of Object.entries(data.originalDatasets)) {
    const bytes = await readFile(new URL(path, root)); assert.equal(hash(bytes), digest);
    for (const row of (JSON.parse(bytes.toString()) as Dataset).cases) {
      const action = data.cases[row.id]; assert.ok(action, `${row.id} supplied action`);
      if (action.productMention) assert.ok(row.originalQuery.includes(action.productMention));
      assert.ok(["knowledge", "paid_facts_only", "unsupported_refund_limit"].includes(action.contract));
      assert.equal(action.kind === "paid_amount_compare", action.contract === "paid_facts_only");
    }
  }
  return { data, manifest };
}

function assertFreshOrder(result: SupportResult | undefined, expectedId: string): Order {
  assert.ok(result, "Controller result required");
  const order = result.evidence.order; assert.ok(order, "Current evidence.order required"); assert.equal(order.id, expectedId);
  const call = result.evidence.actualCalls.find(call => call.name === "get_order" && !call.isError && call.input.orderId === expectedId
    && call.parentSpanId === result.evidence.requestId);
  assert.ok(call, "Current successful authorized get_order required"); assert.deepEqual(call.output, order, "Evidence must be actual fresh get_order output");
  return order;
}

export function fixtureOrder(key: string, data: Awaited<ReturnType<typeof loadC1ContextDataset>>): Order {
  const fixture = data.dataset.orderFixtures[key]!, template = data.templates[fixture.template]!;
  const at = new Date("2026-10-05T00:00:00.000Z");
  const names: Record<string, string> = { "product-demo-1": "双人午餐团购券", "product-demo-2": "单人晚餐团购券", "product-demo-3": "私享套餐团购券" };
  return { source: "demo-database", id: fixture.orderId, status: template.status, asOf: at.toISOString(),
    amounts: { totalCents: template.totalCents, paidCents: template.paidCents, refundedCents: template.refundedCents },
    createdAt: at.toISOString(), paidAt: at.toISOString(), shop: { id: template.shopId, name: "云味餐厅", merchantName: "演示商家", address: "演示地址" },
    items: template.items.map((item, index) => ({ ...item, id: `${fixture.orderId}-item-${index}`, productName: names[item.productId]! })),
    coupons: template.coupons.map((coupon, index) => ({ id: `${fixture.orderId}-coupon-${index}`, orderItemId: `${fixture.orderId}-item-0`, status: coupon.status,
      expiresAt: new Date(at.getTime() + coupon.expiresAfterAnchorDays * 86400000).toISOString(),
      redeemedAt: coupon.status === "redeemed" ? at.toISOString() : null, redeemedShopId: coupon.status === "redeemed" ? template.shopId : null })),
    payments: [{ ...template.payment, paidAt: at.toISOString() }],
    refunds: Array.from({ length: template.historicalRefunds.count }, () => ({ status: "succeeded", amountCents: template.historicalRefunds.succeededCents, completedAt: at.toISOString() })) };
}

// Deliberately semantic-free substitutes. Rank one lexical candidate and accept its actual text;
// only --live can score gold retrieval/support. No case IDs, labels or gold enter either transport.
async function mockClients(profile: EvidenceSupportProfile, supportModel: EvidenceSupportModel) {
  const rerank = createBailianClient({ retries: 0, timeoutMs: 1000,
    env: { DASHSCOPE_API_KEY: "offline-never-sent", DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com" },
    fetch: async (_url, options) => {
      const payload = JSON.parse(String(options?.body));
      const documents: RetrievalDocument[] = payload.documents.map((text: string, index: number) => ({ ...JSON.parse(text), id: String(index), shopId: null }));
      const order = rankBm25(payload.query, documents, {}).map(doc => Number(doc.id));
      const indices = [...order, ...documents.map((_, index) => index).filter(index => !order.includes(index))];
      return new Response(JSON.stringify({ results: indices.map((index, position) => ({ index, relevance_score: position === 0 ? .9 : .1 })), usage: { total_tokens: 1 } }));
    } });
  const selected = resolveEvidenceSupportModel(supportModel);
  const model = { provider: selected.provider, id: selected.model, api: "openai-completions", baseUrl: "https://api.deepseek.com", maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const support = await createEvidenceSupportClient({ profile, modelSelection: supportModel, timeoutMs: 1000, runtime: { model,
    complete: async (context): Promise<AssistantMessage> => {
      const payload = JSON.parse(String(context.messages[0]!.content));
      return { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
        content: [{ type: "text", text: JSON.stringify({ decisions: payload.documents.map((doc: { id: string; body: string }) => ({
          id: doc.id, ...(profile === "typed" ? { category: "direct_fact" } : { supported: true }), quote: doc.body, reason: "Offline transport contract only; not factual support judgment." })) }) }],
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    } } });
  return { rerank, support };
}

type Row = { caseId: string; variantId: string; partition: "query_only" | "contextual"; corpus: string; evaluationStratum?: Case["evaluationStratum"]; contextContract?: Case["contextContract"];
  expected: Expected; status: "passed" | "failed" | "unimplemented" | "error";
  errors: string[]; originalQuery: string; effectiveQuery?: string; observedResolution?: string; acceptedIds?: string[];
  warmups: SupportResult[]; contextSources?: { focusRequestId?: string; amountReferenceRequestId?: string; amountReferenceSource?: "order_display" | "policy_display"; policyTopicRequestId?: string; orderChoicesRequestIds?: string[] }; factChecks?: Record<string, string | number | boolean>; controller?: SupportResult; traces: KnowledgeTrace[]; semanticScored: boolean; contextContractPassed?: boolean; actionContract?: ActionAdapter["contract"];
  legacyDiagnostics?: { version: "frozen-lexical-oracle-v1"; missingEffectivePhrases: string[]; topLevelVerifiedOrderId?: string; originalRetrievalContract: string };
  fixturePreparation?: { declaredTopics: number; attemptedTopics: number; establishedTopics: number; currentTopicSelected: boolean };
  suppliedAction?: ContextSupportAction; referenceProbe?: { kind: "missing_or_ambiguous" | "nonexistent"; passed: boolean; result?: SupportResult } };

export async function runC1ContextCheck(live = false, split: C1Split = "original", threshold = .71, knowledgeSupport: EvidenceSupportProfile = "binary", knowledgeSupportModel: EvidenceSupportModel = "configured", knowledgeApplicability: SupportExperimentParameters["knowledgeApplicability"] = "model_only") {
  resolveSupportRunParameters("controller", { knowledgeMode: "m4-support", knowledgeApplicability });
  assert.ok(Number.isFinite(threshold) && threshold >= 0 && threshold <= 1, "threshold must be 0..1");
  assert.ok(knowledgeSupport === "binary" || knowledgeSupport === "typed", "knowledgeSupport must be binary or typed");
  resolveEvidenceSupportModel(knowledgeSupportModel);
  const data = await loadC1ContextDataset(split), adapter = await loadActionAdapter(), clients = live ? undefined : await mockClients(knowledgeSupport, knowledgeSupportModel), runId = randomUUID();
  const rows: Row[] = [];
  const codeFiles = ["scripts/c1-context-check.ts", "src/support-controller.ts", "src/support-context.ts", "src/support-evidence-context.ts", "src/support-context-action.ts", "src/knowledge-service.ts", "src/knowledge-applicability.ts", "data/knowledge-applicability.json", "src/support-parameters.ts", "src/evidence-support.ts", "src/evidence-acceptance.ts", "src/retrieval-ranking.ts", "src/bailian.ts"];
  const codeHashes = async () => Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, hash(await readFile(new URL(file, root)))])));
  const codeBefore = await codeHashes();
  for (const test of data.dataset.cases) {
    const supplied = adapter.data.cases[test.id]!;
    const queryOnly: Variant = { id: "query_only", input: { identity: data.dataset.actor, groupOpenid: data.dataset.groupOpenid, focusOrder: null, topics: [] },
      expected: { ...test.queryOnlyExpected, evidence: [], effectiveQueryMustInclude: [] } };
    for (const variant of [queryOnly, ...test.variants]) {
      const row: Row = { caseId: test.id, variantId: variant.id, partition: variant.id === "query_only" ? "query_only" : "contextual", corpus: test.corpus, evaluationStratum: test.evaluationStratum, contextContract: test.contextContract,
        expected: variant.expected, actionContract: supplied.contract, status: "failed", errors: [], originalQuery: test.originalQuery, warmups: [], traces: [], semanticScored: live };
      rows.push(row);
      const input = variant.input, sourceKey = merchantSourceKey(input.identity, input.groupOpenid);
      const rawService = createKnowledgeService({ readKnowledgeDocuments: async () => structuredClone(data.corpora[test.corpus]) },
        { mode: "m4-support", applicability: knowledgeApplicability, supportProfile: knowledgeSupport, supportModel: knowledgeSupportModel, threshold, timeoutMs: live ? 60_000 : 1000, clients });
      const knowledge: KnowledgeService = { search: async request => { const result = await rawService.search(request); row.traces.push(result.trace); return result; } };
      const store = {
        getOrder: async (identity: QQIdentity, id: string) => {
          const entry = Object.entries(data.dataset.orderFixtures).find(([, fixture]) => fixture.orderId === id);
          if (!entry || identity.appId !== data.dataset.actor.appId || entry[1].owner !== identity.senderId) throw new OrderAccessError("Fixture order denied");
          return fixtureOrder(entry[0], data);
        },
        searchKnowledge: async () => { throw new Error("Knowledge service must be injected"); },
      };
      const controller = new SupportController({ store, knowledge });
      const context = (query: string, suffix: string, focus?: string, policyTopic?: TrustedPolicyTopic) => ({ requestId: `${runId}:${rows.length}:${suffix}`,
        identity: input.identity, sourceKey, trustedRoute: { groupOpenid: input.groupOpenid, messageId: `${runId}:${rows.length}:${suffix}` },
        userText: query, focusOrderId: focus, policyTopic });
      try {
        // Establish focus by an actual authorized order read, independently of policy retrieval.
        const authorized = new Map<string, string>();
        let focus: string | undefined, orderChoices: TrustedOrderChoices | undefined, amountReference: TrustedAmountReference | undefined;
        if (test.corpus === "online" && input.focusOrder) {
          const choices = [...(input.alternatives ?? []).filter(key => key !== input.focusOrder), input.focusOrder];
          for (const [index, key] of choices.entries()) {
            const id = data.dataset.orderFixtures[key]!.orderId;
            const selected = await controller.createTurn(context(`查询订单 ${id}`, `focus-${index}`)).execute({ protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: id } });
            row.warmups.push(selected); assertFreshOrder(selected, id); authorized.set(key, id); focus = id;
            row.contextSources = { ...row.contextSources, focusRequestId: selected.evidence.requestId };
            if (input.amountReference && key === input.amountReference.order && selected.verifiedAmountReference) {
              amountReference = selected.verifiedAmountReference;
              row.contextSources.amountReferenceRequestId = selected.evidence.requestId;
              row.contextSources.amountReferenceSource = "order_display";
            }
            if (input.alternatives) orderChoices = rememberOrderChoice(orderChoices, { sourceKey, groupOpenid: input.groupOpenid }, id, selected.evidence.requestId);
          }
        }
        // Replay declared prerequisites before the tested action. The SUT never decides which fixture history exists.
        const preparedTopics: TrustedPolicyTopic[] = [];
        row.fixturePreparation = { declaredTopics: input.topics.length, attemptedTopics: 0, establishedTopics: 0, currentTopicSelected: false };
        for (const [index, prior] of input.topics.entries()) {
          const fixture = prior.order ? data.dataset.orderFixtures[prior.order] : undefined;
          const explicit = fixture && [...prior.priorQuery.matchAll(/COUPON-\d{4}(?!\d)/g)].some(match => match[0] === fixture.orderId);
          let priorFocus = prior.order ? authorized.get(prior.order) : undefined;
          if (fixture && !explicit && !priorFocus) {
            const selected = await controller.createTurn(context(`查询订单 ${fixture.orderId}`, `prior-focus-${index}`)).execute({ protocol: "v2.2", kind: "order", orderRef: { kind: "explicit", orderId: fixture.orderId } });
            row.warmups.push(selected); assertFreshOrder(selected, fixture.orderId); priorFocus = fixture.orderId; authorized.set(prior.order!, priorFocus);
          }
          const priorAction = parseContextSupportAction({ protocol: "v2.2", kind: prior.kind === "refund_eligibility" || prior.kind === "remaining_coupon_refund" ? "refund_eligibility" : "policy",
            question: prior.priorQuery, questionContext: { kind: "standalone" },
            ...(fixture ? { orderRef: explicit ? { kind: "explicit", orderId: fixture.orderId } : { kind: "focus" } } : {}) });
          row.fixturePreparation.attemptedTopics++;
          const warmup = await controller.createTurn(context(prior.priorQuery, `prior-${index}`, priorFocus)).execute(priorAction);
          row.warmups.push(warmup);
          if (fixture) assertFreshOrder(warmup, fixture.orderId);
          if (!warmup.verifiedPolicyTopic) throw new Error("Declared successful prior did not produce a verified policy topic");
          if (live && prior.sourceEvidence && !warmup.verifiedPolicyTopic.sources.some(source => source.sourceId === prior.sourceEvidence!.docId)) throw new Error("Prior topic lacks frozen source evidence");
          preparedTopics.push(warmup.verifiedPolicyTopic); row.fixturePreparation.establishedTopics++;
          if (input.amountReference && !amountReference && warmup.verifiedAmountReference) {
            amountReference = warmup.verifiedAmountReference;
            row.contextSources = { ...row.contextSources, amountReferenceRequestId: warmup.evidence.requestId, amountReferenceSource: "policy_display" };
          }
        }
        const topic = preparedTopics.length === 1 ? preparedTopics[0] : undefined;
        row.fixturePreparation.currentTopicSelected = Boolean(topic);
        row.contextSources = { ...row.contextSources, policyTopicRequestId: topic?.requestId, orderChoicesRequestIds: orderChoices?.orders.map(choice => choice.requestId) };
        if (input.amountReference && amountReference) assert.equal(amountReference.productId, input.amountReference.productId);
        const missingReferenceId = `${runId}:${rows.length}:nonexistent-reference`;
        const action = parseContextSupportAction(supplied.kind === "clarify"
          ? { protocol: "v2.2", kind: "clarify", field: "intent", reason: "ambiguous" }
          : supplied.kind === "paid_amount_compare"
          ? { protocol: "v2.2", kind: "paid_amount_compare", orderRef: { kind: "focus" }, amountRef: { requestId: amountReference?.requestId ?? missingReferenceId } }
          : { protocol: "v2.2", kind: supplied.kind, question: test.originalQuery,
            questionContext: supplied.questionContext === "previous" ? { kind: "previous", requestId: topic?.requestId ?? missingReferenceId } : { kind: "standalone" },
            ...(supplied.orderRef ? { orderRef: { kind: supplied.orderRef } } : {}), ...(supplied.productMention ? { productMention: supplied.productMention } : {}) });
        row.suppliedAction = action;
        const currentContext = { ...context(test.originalQuery, "current", focus, topic), orderChoices, amountReference };
        // Explicit invalid-ID probes prove host rejection, rather than handing every negative row a clarify action.
        if ((action.kind === "policy" || action.kind === "refund_eligibility") && action.questionContext.kind === "previous" || action.kind === "paid_amount_compare") {
          const hasReference = action.kind === "paid_amount_compare" ? Boolean(amountReference) : Boolean(topic);
          row.referenceProbe = { kind: hasReference ? "nonexistent" : "missing_or_ambiguous", passed: false };
          if (hasReference) {
            const probe = action.kind === "paid_amount_compare" ? { ...action, amountRef: { requestId: missingReferenceId } }
              : { ...action, questionContext: { kind: "previous" as const, requestId: missingReferenceId } };
            const rejected = await controller.createTurn({ ...currentContext, requestId: `${currentContext.requestId}:probe` }).execute(probe);
            row.referenceProbe.result = rejected; assert.equal(rejected.outcome, "clarification");
            assert.equal(rejected.evidence.knowledge.length, 0); assert.equal(rejected.evidence.rules.length, 0);
            assert.ok(rejected.evidence.actualCalls.every(call => call.name === "get_order"), "Invalid reference cannot request knowledge or side effects");
            row.referenceProbe.passed = true;
          }
        }
        const result = await controller.createTurn(currentContext).execute(action);
        row.controller = result; row.effectiveQuery = result.evidence.knowledge[0]?.context.effectiveQuery;
        row.acceptedIds = result.evidence.rules.map(rule => rule.sourceId);
        row.observedResolution = result.outcome === "clarification" ? "clarify" : result.evidence.amountComparison ? "resolved_facts" : row.acceptedIds.length ? "resolved" : "resolved_no_evidence";
        row.legacyDiagnostics = { version: "frozen-lexical-oracle-v1", missingEffectivePhrases: variant.expected.effectiveQueryMustInclude.filter(phrase => !row.effectiveQuery?.includes(phrase)),
          topLevelVerifiedOrderId: result.verifiedOrderId,
          originalRetrievalContract: supplied.contract === "paid_facts_only" && variant.expected.relevant.length ? "original PARTIAL gold remains unmet: business contract now requires zero knowledge calls"
            : supplied.contract === "unsupported_refund_limit" && variant.expected.resolution !== "clarify" ? "original resolved amount-limit contract remains unsupported" : live ? "scored against unchanged gold" : "not semantically scored offline" };
        if (row.referenceProbe?.kind === "missing_or_ambiguous") {
          assert.equal(result.outcome, "clarification"); assert.equal(result.evidence.knowledge.length, 0); row.referenceProbe.passed = true;
        }
        if (row.traces.some(trace => trace.status === "unavailable")) throw new Error("Knowledge service unavailable; see sanitized traces");
        if (row.traces.some(trace => trace.applicability?.mode !== knowledgeApplicability
          || knowledgeApplicability === "declared" && trace.applicability?.gate?.integrity !== true)) {
          throw new Error("Knowledge applicability audit incomplete; retained accepted evidence is not a complete judgment");
        }
        if (variant.expected.resolution === "clarify" || supplied.contract === "unsupported_refund_limit") {
          assert.equal(row.observedResolution, "clarify"); assert.equal(row.controller?.evidence.knowledge.length ?? 0, 0);
        } else {
          assert.notEqual(row.observedResolution, "clarify");
          if (test.corpus === "online" && input.focusOrder) {
            const expectedOrder = String(variant.expected.facts?.resolvedOrderId ?? data.dataset.orderFixtures[input.focusOrder]!.orderId);
            const fresh = assertFreshOrder(row.controller, expectedOrder);
            for (const item of row.controller!.evidence.knowledge) {
              assert.equal(item.context.scopeSource, "fresh_order"); assert.equal(item.context.facts?.orderId, fresh.id);
              assert.equal(item.trace.scope.shopId, fresh.shop.id); assert.ok(fresh.items.some(product => product.productId === item.trace.scope.productId));
            }
          }
          if (variant.expected.facts) {
            row.factChecks = {};
            for (const [field, expected] of Object.entries(variant.expected.facts)) {
              const actual: unknown = field === "resolvedOrderId" ? row.controller?.evidence.order?.id
                : row.controller?.evidence.amountComparison?.[field as keyof NonNullable<SupportResult["evidence"]["amountComparison"]>];
              assert.equal(actual, expected, field); row.factChecks[field] = actual as string | number | boolean;
            }
            if (row.controller?.evidence.amountComparison) {
              assert.equal(row.controller.evidence.amountComparison.refundApproved, false);
              row.factChecks.refundApproved = false;
            }
          }
          for (const item of row.controller!.evidence.knowledge) {
            assert.equal(item.context.originalQuery, test.originalQuery); assert.equal(item.trace.query, item.context.effectiveQuery);
            if (supplied.questionContext === "previous") assert.equal(item.context.policyTopic?.requestId, topic?.requestId, "Declared prior must actually bind to current knowledge");
          }
          if (supplied.contract === "paid_facts_only") {
            assert.equal(row.observedResolution, "resolved_facts"); assert.equal(row.controller!.evidence.knowledge.length, 0);
            assert.equal(row.controller!.evidence.rules.length, 0); assert.equal(row.controller!.evidence.amountComparison?.referenceRequestId, amountReference?.requestId);
          }
          row.contextContractPassed = true; // Resolution and trusted facts are independent of policy recall.
          if (live && supplied.contract === "knowledge") { assert.equal(row.observedResolution, variant.expected.resolution); assert.deepEqual([...(row.acceptedIds ?? [])].sort(), [...variant.expected.relevant].sort()); }
        }
        row.status = "passed";
      } catch (error) { row.status = error instanceof assert.AssertionError ? "failed" : "error"; row.errors.push(error instanceof assert.AssertionError ? error.message : error instanceof Error ? error.message : "Unknown failure"); }
    }
  }
  const summarize = (selected: Row[]) => ({ planned: selected.length, passed: selected.filter(row => row.status === "passed").length,
    unimplemented: selected.filter(row => row.status === "unimplemented").length, errors: selected.filter(row => row.status === "error").length,
    failed: selected.filter(row => row.status === "failed").length });
  const traces = rows.flatMap(row => row.traces);
  const summarizeUsage = (items: KnowledgeTrace[]) => Object.fromEntries((["rerankTokens", "supportTokens", "estimatedCny", "estimatedUsd", "incompleteCalls"] as const).map(field =>
    [field, items.some(trace => trace.usage[field] === null) ? null : items.reduce((sum, trace) => sum + trace.usage[field]!, 0)]));
  const warmupTraces = rows.flatMap(row => row.warmups.flatMap(warmup => warmup.evidence.knowledge.map(item => item.trace)));
  const currentTraces = rows.flatMap(row => row.traces.slice(row.warmups.reduce((n, warmup) => n + warmup.evidence.knowledge.length, 0)));
  const usage = summarizeUsage(traces);
  const contextual = rows.filter(row => row.partition === "contextual");
  const answerable = contextual.filter(row => row.expected.resolution === "resolved");
  const noAnswer = contextual.filter(row => row.expected.resolution === "resolved_no_evidence");
  const currentRanking = (row: Row) => row.traces.slice(row.warmups.reduce((n, warmup) => n + warmup.evidence.knowledge.length, 0)).at(-1)?.rawRanking.slice(0, 5).map(item => item.id) ?? [];
  const recall = (row: Row, ids: string[]) => row.expected.relevant.filter(id => ids.includes(id)).length / row.expected.relevant.length;
  const rawHasGold = answerable.filter(row => currentRanking(row).some(id => row.expected.relevant.includes(id)));
  const falseRejects = rawHasGold.filter(row => !row.acceptedIds?.some(id => row.expected.relevant.includes(id))).length;
  const scopeViolations = rows.reduce((count, row) => count + row.traces.reduce((n, trace) => {
    const visible = new Set(scopeDocuments(data.corpora[row.corpus as Case["corpus"]], trace.scope).map(doc => doc.id));
    return n + (trace.acceptance?.accepted.filter(doc => !visible.has(doc.id)).length ?? 0);
  }, 0), 0);
  const boundaryRows = rows.filter(row => row.expected.resolution === "clarify");
  const coreKnown = contextual.filter(row => row.contextContract === "core" && row.variantId === "known");
  const coreContextContracts = coreKnown.length ? { planned: coreKnown.length, passed: coreKnown.filter(row => row.contextContractPassed === true).length } : null;
  const metrics = live ? {
    version: "c1-admission-v1", answerablePlanned: answerable.length, noAnswerPlanned: noAnswer.length,
    rawRecallAt5: answerable.reduce((sum, row) => sum + recall(row, currentRanking(row)), 0) / answerable.length,
    acceptedRecallAt5: answerable.reduce((sum, row) => sum + recall(row, (row.acceptedIds ?? []).slice(0, 5)), 0) / answerable.length,
    falseAccepts: noAnswer.filter(row => (row.acceptedIds?.length ?? 0) > 0).length,
    falseAcceptRate: noAnswer.filter(row => (row.acceptedIds?.length ?? 0) > 0).length / noAnswer.length,
    falseRejects, falseRejectDenominator: rawHasGold.length, falseRejectRate: rawHasGold.length ? falseRejects / rawHasGold.length : null,
    scopeViolations, boundaryPlanned: boundaryRows.length, boundaryPassed: boundaryRows.filter(row => row.status === "passed").length,
    incomplete: rows.filter(row => row.status === "error" || row.status === "unimplemented").length,
    coreContextContracts,
    contextContractPassed: contextual.filter(row => row.status === "passed").length, contextContractPlanned: contextual.length,
    knownPassedByFamily: Object.fromEntries(data.dataset.cases.map(test => [test.id, rows.some(row => row.caseId === test.id && row.variantId === "known" && row.status === "passed")]))
  } : null;
  const codeAfter = await codeHashes(), codeStable = JSON.stringify(codeBefore) === JSON.stringify(codeAfter);
  const admission = metrics ? { legacyDiagnosticStatus: codeStable && metrics.incomplete === 0 && metrics.acceptedRecallAt5 >= .8
    && metrics.falseAccepts === 0 && metrics.scopeViolations === 0 && (metrics.falseRejectRate === null || metrics.falseRejectRate <= .1)
    && metrics.boundaryPassed === metrics.boundaryPlanned && (!coreContextContracts || coreContextContracts.passed === coreContextContracts.planned) ? "metrics_met" : "not_met",
    status: "not_applicable_to_original_validation",
    limits: { acceptedRecallAt5Minimum: .8, falseRejectRateMaximum: .1, falseAcceptsMaximum: 0, scopeViolationsMaximum: 0, incompleteMaximum: 0, clarificationBoundaryRequired: "all", coreTrustedReferenceContractsRequired: split === "validation-v3" ? "all (policy recall scored separately)" : "not separately declared in earlier datasets" },
    allKnownContextContractsPassed: Object.values(metrics.knownPassedByFamily).every(Boolean),
    note: "Passing retrieval metrics alone does not prove every contextual capability or final answer quality; inspect known contracts and all failures." } : null;
  const artifact = { version: 3, codeStable, configuration: { threshold, knowledgeSupport, knowledgeSupportModel, knowledgeApplicability, observedSupportSettings: [...new Map(traces.flatMap(trace => trace.settings?.support ? [[JSON.stringify(trace.settings.support), trace.settings.support] as const] : [])).values()], supportPrompt: knowledgeSupport === "typed" ? evidenceSupportTypedPromptVersion : evidenceSupportPromptVersion, observedSupportPrompts: [...new Set(traces.flatMap(trace => trace.settings?.support ? [trace.settings.support.promptVersion] : []))], timeoutMs: live ? 60_000 : 1000, retries: 0 }, runnerVersion: "c1-context-runner-v3.3-adapter", scoringVersion: "c1-supplied-action-scoring-v3-applicability", split, runId, executedAt: new Date().toISOString(), mode: live ? "live-supplied-action-development" : "offline-adapter-engineering",
    scope: "v2.2 Controller host-contract development with frozen supplied actions and controlled order snapshots; no natural-language action selection, MySQL or QQ.",
    validationPolicy: "exposed-development-adapter-not-new-validation", originalValidationPolicy: data.dataset.validationPolicy, source: data.manifest, actionAdapter: adapter.manifest, semanticScored: live,
    fixtureActionsAreOracle: true, naturalLanguageUnderstandingEvaluated: false, originalAdmissionNotApplicable: "v2.2 supplied actions and paid-amount zero-knowledge contract differ from original runs; frozen data/gold/report retained",
    modelActionSelectionEvaluated: false, finalAnswerQualityEvaluated: false,
    mockPolicy: live ? null : "Semantic-free one-candidate lexical rerank and accept-text substitute. Passed measures resolution/wiring only, never retrieval factual quality.",
    codeHashes: { before: codeBefore, after: codeAfter },
    summary: { metrics, admission, originalContractChanges: { paidAmountFactsOnly: rows.filter(row => row.actionContract === "paid_facts_only").length, unsupportedRefundLimit: rows.filter(row => row.actionContract === "unsupported_refund_limit").length },
      amountFactsContract: { planned: rows.filter(row => row.actionContract === "paid_facts_only" && row.expected.resolution === "resolved").length,
        passed: rows.filter(row => row.actionContract === "paid_facts_only" && row.expected.resolution === "resolved" && row.status === "passed").length,
        originalGoldContract: "Original knowledge gold is unchanged and not passed by the new zero-knowledge amount action" },
      originalPositiveContractsNotPassedByAdapter: rows.filter(row => row.actionContract !== "knowledge" && row.expected.resolution === "resolved").map(row => ({ caseId: row.caseId, variantId: row.variantId, reason: row.actionContract })),
      referenceProbes: { planned: rows.filter(row => row.referenceProbe).length, passed: rows.filter(row => row.referenceProbe?.passed).length },
      lexicalDiagnosticFailures: rows.filter(row => row.legacyDiagnostics?.missingEffectivePhrases.length).length, caseGroups: data.dataset.cases.length, originalCases: new Set(data.dataset.cases.map(row => row.originalId ?? row.id)).size, queryOnly: summarize(rows.filter(row => row.partition === "query_only")),
      contextual: summarize(rows.filter(row => row.partition === "contextual")),
      contextualByStratum: split === "validation-v3" ? Object.fromEntries((["direct_fact", "boundary_question", "direct_missing_fact"] as const).map(stratum => [stratum, summarize(contextual.filter(row => row.evaluationStratum === stratum && row.variantId === "known"))])) : null,
      contextualByExpectation: Object.fromEntries((["resolved", "resolved_no_evidence", "clarify"] as const).map(resolution => [resolution,
        summarize(rows.filter(row => row.partition === "contextual" && row.expected.resolution === resolution))])),
      usage: live ? usage : { rerankTokens: 0, supportTokens: 0, estimatedCny: 0, estimatedUsd: 0, incompleteCalls: 0 },
      usageByPhase: live ? { warmup: summarizeUsage(warmupTraces), current: summarizeUsage(currentTraces) } : null,
      mockReportedUsage: live ? null : usage, providerRequests: live ? traces.reduce((n, trace) => n + trace.calls.length, 0) : 0,
      providerAttemptRecords: live ? traces.reduce((n, trace) => n + trace.calls.reduce((m, call) => m + call.attempts.length, 0), 0) : 0,
      mockRequests: live ? 0 : traces.reduce((n, trace) => n + trace.calls.reduce((m, call) => m + call.attempts.length, 0), 0) }, rows };
  const directory = new URL(".runtime/c1-context/", root); await mkdir(directory, { recursive: true });
  const path = new URL(`${live ? "live" : "offline"}-${split}-${runId}.json`, directory); await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ artifact: fileURLToPath(path), mode: artifact.mode, codeStable: artifact.codeStable, configuration: artifact.configuration, ...artifact.summary }));
  return artifact;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.slice(2).every(arg => arg === "--live" || arg === "--schema-only" || /^--split=(original|development|validation-v2|validation-v3)$/.test(arg) || /^--applicability=(model_only|declared)$/.test(arg) || /^--knowledge-support=(binary|typed)$/.test(arg) || /^--knowledge-support-model=(configured|deepseek-v4-pro)$/.test(arg) || /^--threshold=(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(arg)), "Use --live, --schema-only, --split=original|development|validation-v2|validation-v3, --threshold=0..1, --knowledge-support=binary|typed, --knowledge-support-model=configured|deepseek-v4-pro, --applicability=model_only|declared only");
  const split = (process.argv.find(arg => arg.startsWith("--split="))?.slice(8) ?? "original") as C1Split;
  const threshold = Number(process.argv.find(arg => arg.startsWith("--threshold="))?.slice(12) ?? ".71");
  assert.ok(process.argv.filter(arg => arg.startsWith("--threshold=")).length <= 1, "Only one threshold is allowed");
  const knowledgeSupport = (process.argv.find(arg => arg.startsWith("--knowledge-support="))?.slice(20) ?? "binary") as EvidenceSupportProfile;
  assert.ok(process.argv.filter(arg => arg.startsWith("--knowledge-support=")).length <= 1, "Only one knowledge support profile is allowed");
  const knowledgeSupportModel = (process.argv.find(arg => arg.startsWith("--knowledge-support-model="))?.slice(26) ?? "configured") as EvidenceSupportModel;
  assert.ok(process.argv.filter(arg => arg.startsWith("--knowledge-support-model=")).length <= 1, "Only one knowledge support model is allowed");
  const knowledgeApplicability = (process.argv.find(arg => arg.startsWith("--applicability="))?.slice(16) ?? "model_only") as SupportExperimentParameters["knowledgeApplicability"];
  assert.ok(process.argv.filter(arg => arg.startsWith("--applicability=")).length <= 1, "Only one applicability mode is allowed");
  resolveSupportRunParameters("controller", { knowledgeMode: "m4-support", knowledgeApplicability });
  resolveEvidenceSupportModel(knowledgeSupportModel);
  if (process.argv.includes("--schema-only")) { const data = await loadC1ContextDataset(split), adapter = await loadActionAdapter(); console.log(JSON.stringify({ split, sha256: data.manifest.dataset.sha256, counts: data.manifest.counts, adapterSha256: adapter.manifest.dataset.sha256 })); }
  else { const result = await runC1ContextCheck(process.argv.includes("--live"), split, threshold, knowledgeSupport, knowledgeSupportModel, knowledgeApplicability); if (!result.codeStable || result.summary.queryOnly.errors || result.summary.contextual.errors || result.summary.queryOnly.failed || result.summary.contextual.failed) process.exitCode = 1; }
}
