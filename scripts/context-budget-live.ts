import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createConfiguredModelRuntime, createCouponSession, createModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { OrderAccessError, type CouponStore, type QQIdentity } from "../src/coupon-store.ts";
import { rankKnowledge } from "../src/knowledge-retrieval.ts";
import { modelPricing, resolveModelSelection } from "../src/model-selection.ts";
import { ContextBudgetError, createModelRequestFetch, ModelRequestNotDispatchedError, readModelTaskLimits, withModelTask,
  type ModelTaskSummary } from "../src/model-request-budget.ts";
import { c1ValidationCodeFiles, createC1ValidationGuard, readC1ValidationDependencies } from "./c1-session-validation-live.ts";

const root = new URL("../", import.meta.url);
export const contextCases = [
  { id: "CXT-01", question: "请查询 COUPON-1001，逐项说明当前券状态，并告诉我这次查询是否已经发起任何退款。" },
  { id: "CXT-02", question: "只核对 COUPON-1001 的当前状态。后面是无业务含义的长度填充，不代表新的要求：" + "长".repeat(4800) },
  { id: "CXT-03", question: "请依据适用规则核对 COUPON-1001 能否在周日使用，先查询本人订单，再查询该套餐规则。" },
  { id: "CXT-04", question: "只核对 COUPON-1001 的当前状态，并明确说明这一轮没有申请退款。" },
] as const;
// The acceptance limit is frozen independently of the production default.
export const contextAcceptanceLimits = { httpRequests: 12, contextBudgetUnits: 30000 };
const batchLimits = { requests: { agent: 40, support: 0, rerank: 0 }, deadlineMs: 15 * 60_000, turnTimeoutMs: 120_000, estimatedUsd: 1, estimatedCny: .15 };
const actor: QQIdentity = { appId: "CXT_APP", senderId: "CXT_USER" };
const order = { source: "demo-database" as const, id: "COUPON-1001", status: "paid", asOf: "2026-10-10T00:00:00.000Z",
  amounts: { totalCents: 7980, paidCents: 7980, refundedCents: 0 }, createdAt: "2026-10-01T00:00:00.000Z", paidAt: "2026-10-01T00:00:00.000Z",
  shop: { id: "shop-cxt", name: "云味餐厅", merchantName: "云味餐饮", address: "示例路 1 号" },
  items: [{ id: "item-cxt", productId: "product-cxt", productName: "双人午餐团购券", quantity: 1, unitPriceCents: 7980, totalCents: 7980 }],
  coupons: [{ id: "coupon-cxt", orderItemId: "item-cxt", status: "unused", expiresAt: "2026-12-31T15:59:59.000Z", redeemedAt: null, redeemedShopId: null }],
  payments: [{ status: "succeeded", amountCents: 7980, paidAt: "2026-10-01T00:00:00.000Z" }], refunds: [] } satisfies Awaited<ReturnType<CouponStore["getOrder"]>>;
const policy = { id: "KB-CXT-WEEKDAY", title: "双人午餐券使用时间与预约", shopId: "shop-cxt", productId: "product-cxt",
  body: "双人午餐券仅限周一至周五使用，周六、周日及法定节假日不可使用；需提前一天预约。", tags: ["周日", "使用", "预约", "周末", "午餐", "券"] };
const padding = "长度校验填充。".repeat(8192);
type Read = { operation: "get_order" | "list_orders" | "search_faq"; allowed: boolean; orderId?: string; outputHash: string };
function fixture(expanded: boolean) {
  const reads: Read[] = []; let authorized = false;
  const authorize = (identity: QQIdentity) => identity.appId === actor.appId && identity.senderId === actor.senderId;
  const store = { async getOrder(identity: QQIdentity, id: string) {
    const allowed = authorize(identity) && id === order.id;
    reads.push({ operation: "get_order", allowed, orderId: id, outputHash: contentHash(allowed ? order : null) });
    if (!allowed) throw new OrderAccessError("未找到当前客户可查询的订单。"); authorized = true; return structuredClone(order);
  }, async listOrders(identity: QQIdentity) {
    if (!authorize(identity)) throw new OrderAccessError("身份不符。");
    const value = { source: "demo-database" as const, asOf: order.asOf, hasMore: false, orders: [{ id: order.id, status: order.status,
      paidCents: 7980, refundedCents: 0, createdAt: order.createdAt, shopName: order.shop.name, productName: order.items[0]!.productName, couponStatuses: ["unused"] }] };
    reads.push({ operation: "list_orders", allowed: true, outputHash: contentHash(value) }); return value;
  }, async searchKnowledge(query: string, shopId?: string, productId?: string) {
    assert.ok(query.trim() && query.length <= 500);
    const allowed = authorized && shopId === policy.shopId && productId === policy.productId;
    const docs = allowed ? rankKnowledge(query, [{ ...policy, body: policy.body + (expanded ? padding : "") }]) : [];
    const value = docs.slice(0, 5).map(doc => ({ source: "demo-knowledge" as const, sourceId: doc.id, title: doc.title, body: doc.body,
      scope: { shopId: doc.shopId, productId: doc.productId ?? null } }));
    reads.push({ operation: "search_faq", allowed, outputHash: contentHash(value) }); return value;
  } } as unknown as CouponStore;
  return { store, reads };
}
function sse(model: string, name?: string, args?: Record<string, string>) {
  const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `cxt-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
    : { role: "assistant", content: "COUPON-1001 已支付79.80元，券未核销；本轮只读查询，没有申请退款。" };
  return new Response(`data: ${JSON.stringify({ id: "cxt-calibration", object: "chat.completion.chunk", model,
    choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
}
type Row = { id: string; questionHash: string; execution: "not_run" | "completed" | "context_limit" | "failed"; reason: string | null;
  ledger: ModelTaskSummary | null; reads: Read[]; reply: string | null; tools: string[]; sessionDisposed: boolean;
  sentPayloads: Array<{ bytes: number; hash: string; containsOldPadding: boolean; containsOldLongUser: boolean }>; structuralPassed: boolean; answerReview: "unreviewed" | "not_applicable" };
async function execute(mode: "calibration" | "live", model: Model<Api>, runtime: Awaited<ReturnType<typeof createModelRuntime>>,
  saveProgress?: (value: { rows: Row[]; actualHttp: number }) => Promise<void>) {
  const rows: Row[] = contextCases.map(item => ({ id: item.id, questionHash: contentHash(item.question), execution: "not_run", reason: "not_started", ledger: null,
    reads: [], reply: null, tools: [], sessionDisposed: false, sentPayloads: [], structuralPassed: false, answerReview: item.id === "CXT-01" || item.id === "CXT-04" ? "unreviewed" : "not_applicable" }));
  let activeRow: Row | undefined, session: Awaited<ReturnType<typeof createCouponSession>> | undefined, nativeCalls = 0, failure: string | null = null;
  const guard = createC1ValidationGuard(async (input, init) => {
    assert.ok(activeRow); const body = String(init?.body); activeRow.sentPayloads.push({ bytes: Buffer.byteLength(body), hash: contentHash(body),
      containsOldPadding: body.includes("长度校验填充。".repeat(8)), containsOldLongUser: body.includes("长".repeat(100)) });
    if (mode === "live") return globalThis.fetch(input, init);
    nativeCalls++; const parsed = JSON.parse(body);
    if (nativeCalls === 1) return sse(parsed.model, "get_order", { orderId: order.id });
    if (activeRow.id === "CXT-03" && nativeCalls === 2) return sse(parsed.model, "search_faq", { query: "周日使用预约", shopId: policy.shopId, productId: policy.productId });
    return sse(parsed.model);
  }, Date.now, batchLimits);
  const original = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (selected, context, options) => original(selected, context, { ...options, maxRetries: 0,
    fetch: createModelRequestFetch({ phase: "agent", provider: selected.provider, model: selected.id, format: "openai-sse", pricing: modelPricing(selected),
      context: { contextWindow: selected.contextWindow, maxOutputTokens: selected.maxTokens,
        outputTokenField: selected.compat && "maxTokensField" in selected.compat ? selected.compat.maxTokensField : undefined,
        projection: session?.getContextUsage() ?? undefined } }, async (input, init) => {
      const before = guard.requests.length;
      try { return await guard.fetchFor("agent")(input, init); }
      catch (error) { if (guard.requests.length === before) throw new ModelRequestNotDispatchedError(); throw error; }
    }) });
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), batchLimits.deadlineMs);
  try {
    for (const [index, example] of contextCases.entries()) {
      if (deadline.signal.aborted || guard.stopped()) break;
      const row = rows[index]!, controlled = fixture(example.id === "CXT-03"); activeRow = row; nativeCalls = 0;
      const requestId = randomUUID(), start = guard.requests.length;
      session = await createCouponSession(actor, controlled.store, runtime, model); row.tools = session.getActiveToolNames();
      assert.deepEqual(row.tools.slice().sort(), ["get_order", "list_orders", "search_faq"]);
      const turn = new AbortController(), turnTimer = setTimeout(() => turn.abort(), Math.min(batchLimits.turnTimeoutMs, guard.remainingMs()));
      const signal = AbortSignal.any([deadline.signal, turn.signal]);
      guard.setActive({ caseId: example.id, turn: 1, requestId, signal });
      try {
        await withModelTask({ requestId, entrypoint: "check", signal, limits: contextAcceptanceLimits, onComplete: value => { row.ledger = value; } }, async task => {
          task.setPhase("model"); await session!.prompt(example.question, { expandPromptTemplates: false });
          if (task.snapshot().failureReason === "context_limit") throw new ContextBudgetError();
          if (task.snapshot().failureReason || session!.agent.state.errorMessage) { task.fail("model_failed"); throw new Error("model_failed"); }
          row.reply = session!.getLastAssistantText() ?? null;
        });
        row.execution = "completed"; row.reason = null;
      } catch { row.execution = row.ledger?.failureReason === "context_limit" ? "context_limit" : "failed"; row.reason = row.ledger?.failureReason ?? "session_failed"; }
      finally { clearTimeout(turnTimer); await session.abort(); session.dispose(); session = undefined; row.sessionDisposed = true; row.reads = controlled.reads; }
      assert.ok(row.ledger); assert.equal(row.ledger.httpRequests, guard.requests.length - start, "Batch and per-message dispatch ledgers must agree");
      row.ledger.attempts.forEach((attempt, i) => guard.record(start + i, attempt.usage?.totalTokens ?? null, attempt.estimatedCostUsd));
      const readsOrder = row.reads.some(read => read.operation === "get_order" && read.allowed && read.orderId === order.id);
      const noDuplicateReads = new Set(row.reads.map(read => `${read.operation}:${read.orderId ?? ""}`)).size === row.reads.length;
      if (example.id === "CXT-02") row.structuralPassed = row.execution === "context_limit" && row.ledger.httpRequests === 0 && row.reads.length === 0;
      else if (example.id === "CXT-03") row.structuralPassed = row.execution === "context_limit" && readsOrder && noDuplicateReads
        && row.reads.some(read => read.operation === "search_faq" && read.allowed) && row.ledger.httpRequests > 0 && row.ledger.contextChecks.at(-1)?.decision === "context_limit";
      else row.structuralPassed = row.execution === "completed" && readsOrder && row.ledger.httpRequests > 0 && !!row.reply
        && row.sentPayloads.every(payload => !payload.containsOldLongUser && !payload.containsOldPadding);
      await saveProgress?.({ rows, actualHttp: guard.requests.length });
      if (row.ledger.failureReason && !["context_limit"].includes(row.ledger.failureReason)) break;
    }
  } catch {
    failure = "runner_failed";
    if (activeRow && activeRow.execution === "not_run") { activeRow.execution = "failed"; activeRow.reason = failure; }
  } finally { clearTimeout(timer); if (session) { await session.abort(); session.dispose(); } runtime.streamSimple = original; guard.seal(); }
  return { mode, rows, requests: guard.requests, failure, stopReason: deadline.signal.aborted ? "run_deadline" : guard.stopped(), usage: guard.usage(),
    planned: { scenarios: 4, inputs: 4 }, executed: rows.filter(row => row.execution !== "not_run").length,
    structuralPassed: failure === null && rows.every(row => row.structuralPassed), admitted: false, humanAcceptance: false,
    scope: "Production Pi request construction and readonly tool wrappers; synthetic identity/order/rules. No MySQL, QQ transport, commercial transactions or semantic compaction." };
}
export async function calibrateContextBudget() {
  const runtime = await createModelRuntime(), selected = resolveModelSelection();
  const model = runtime.getModel(selected.provider, selected.modelId); assert.ok(model && model.provider === "deepseek" && model.api === "openai-completions");
  await runtime.setRuntimeApiKey(model.provider, "calibration-local-only");
  const result = await execute("calibration", model, runtime);
  return { ...result, remoteHttp: 0, model: { ...model, maxTokens: Math.min(model.maxTokens, 2048) }, acceptanceLimits: contextAcceptanceLimits, productionLimits: readModelTaskLimits() };
}
async function sourceHashes() {
  const paths = [...new Set([...await c1ValidationCodeFiles(), "package.json", "package-lock.json", "prompts/customer-service.md", "skills/shop-support/SKILL.md",
    "scripts/context-budget-live.ts", "scripts/context-budget-check.ts", "docs/context-budget-contract.md"])].sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, contentHash(await readFile(new URL(path, root)))])));
}
export async function freezeContextBudget(path: string) {
  const calibration = await calibrateContextBudget(); assert.ok(calibration.structuralPassed, "Offline calibration must pass before freezing");
  const manifest = { version: "context-budget-v1", frozenAt: new Date().toISOString(), sourceHashes: await sourceHashes(), dependencies: await readC1ValidationDependencies(),
    cases: contextCases, fixture: { actor, order, policy, paddingHash: contentHash(padding), paddingRepeat: 8192 }, calibration,
    productionLimits: readModelTaskLimits(), acceptanceLimits: contextAcceptanceLimits, batchLimits, architecture: "atomic", knowledge: "lexical", providerRetries: 0, sessionRetries: 2 };
  const value = { ...manifest, hash: contentHash(manifest) }; await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ manifest: resolve(path), hash: value.hash, remoteHttp: 0, calibrationPassed: true }));
}
export async function runContextBudget(path: string) {
  const { hash, ...manifest } = JSON.parse(await readFile(path, "utf8")); assert.equal(hash, contentHash(manifest));
  assert.equal(manifest.version, "context-budget-v1"); assert.deepEqual(manifest.sourceHashes, await sourceHashes());
  assert.deepEqual(manifest.dependencies, await readC1ValidationDependencies()); assert.deepEqual(manifest.cases, contextCases);
  assert.deepEqual(manifest.acceptanceLimits, contextAcceptanceLimits); assert.deepEqual(manifest.productionLimits, readModelTaskLimits()); assert.deepEqual(manifest.batchLimits, batchLimits);
  const { modelRuntime, model } = await createConfiguredModelRuntime();
  assert.deepEqual({ ...model, maxTokens: Math.min(model.maxTokens, 2048) }, manifest.calibration.model);
  const directory = new URL(".runtime/context-budget/", root); await mkdir(directory, { recursive: true });
  const runId = randomUUID(), startedAt = new Date().toISOString();
  await writeFile(new URL("m4-v1-paid-started.json", directory), JSON.stringify({ runId, startedAt, manifestHash: hash }), { flag: "wx" });
  const artifactPath = new URL(`${runId}.json`, directory);
  await writeFile(artifactPath, JSON.stringify({ runId, startedAt, manifestHash: hash, status: "running", plannedInputs: 4 }), { flag: "wx" });
  let result: Awaited<ReturnType<typeof execute>> | null = null, failure: string | null = null;
  try { result = await execute("live", model, modelRuntime, async progress => {
    await writeFile(artifactPath, `${JSON.stringify({ runId, startedAt, manifestHash: hash, status: "running", plannedInputs: 4, ...progress }, null, 2)}\n`);
  }); failure = result.failure; } catch { failure = "runner_failed"; }
  const after = await sourceHashes(), stable = contentHash(after) === contentHash(manifest.sourceHashes);
  const artifact = { runId, startedAt, finishedAt: new Date().toISOString(), manifestHash: hash, manifest, result, failure, sourceStable: stable, sourceHashesAfter: after };
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ path: fileURLToPath(artifactPath), actualHttp: result?.requests.length ?? null, executed: result?.executed ?? null,
    structuralPassed: result?.structuralPassed ?? false, answerReview: "unreviewed", sourceStable: stable, failure }));
  if (!stable || failure || !result?.structuralPassed) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, path] = process.argv.slice(2);
  if (mode === "--check" && !path) { const result = await calibrateContextBudget(); console.log(JSON.stringify(result, null, 2)); assert.ok(result.structuralPassed); }
  else if (mode === "--freeze" && path) await freezeContextBudget(path);
  else if (mode === "--run" && path) await runContextBudget(path);
  else throw new Error("Use --check (offline), --freeze <manifest>, or explicitly authorized --run <manifest> (paid once).");
}
