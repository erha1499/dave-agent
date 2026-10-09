import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CouponStore } from "../src/coupon-store.ts";
import { runCliPrompt } from "../src/cli.ts";
import { createModelRequestFetch, currentModelTask, type ModelTaskSummary } from "../src/model-request-budget.ts";
import { WebChatSessions } from "../src/web-chat.ts";
import { WebChatHistory } from "../src/web-chat-history.ts";
import { createWebChatSettingsCatalog } from "../src/web-chat-settings.ts";

// A host/entrypoint contract check, not a Pi/provider-quality test. Existing
// qq-agent and web-chat checks exercise real Pi with faux/native fake HTTP.
function sessionDouble(prompt: () => Promise<void> = async () => { assert.fail("Host-only path must not prompt"); }): AgentSession {
  return { messages: [], agent: { state: {} }, prompt, abort: async () => {}, dispose() {},
    getLastAssistantText: () => "合成答复", getActiveToolNames: () => ["get_order", "list_orders", "search_faq"],
    subscribe: () => () => {}, sendCustomMessage: async () => {} } as unknown as AgentSession;
}
function storeDouble(hostFailure = false): Pick<CouponStore, "getOrder" | "listOrders" | "resolveBinding"> {
  return {
    resolveBinding: async () => ({ bindingId: "entry-check-binding", customerId: "entry-check-customer" }),
    getOrder: async () => { throw new Error("Unexpected detail read"); },
    listOrders: async () => {
      if (hostFailure) throw new Error("synthetic-private-host-failure");
      return { source: "demo-database", asOf: new Date().toISOString(), orders: [], hasMore: false };
    },
  };
}
const requestHash = (id: string) => createHash("sha256").update(id).digest("hex");

export async function checkModelTaskEntries() {
  const previousInfo = console.error, previousFetch = globalThis.fetch, previousLimit = process.env.MODEL_TASK_HTTP_LIMIT;
  const summaries: ModelTaskSummary[] = []; let unexpectedRemote = 0;
  const catalog = createWebChatSettingsCatalog({ DEEPSEEK_API_KEY: "synthetic-private-key" });
  console.error = (...values: unknown[]) => {
    if (typeof values[0] === "string" && values[0].startsWith("[model-task] ")) summaries.push(JSON.parse(values[0].slice(13)) as ModelTaskSummary);
  };
  globalThis.fetch = async () => { unexpectedRemote++; throw new Error("Remote HTTP is forbidden in this pure check"); };
  process.env.MODEL_TASK_HTTP_LIMIT = "1";
  try {
    for (const failure of ["host", "session", "receipt"] as const) {
      const before = summaries.length, history = new WebChatHistory(":memory:");
      if (failure === "receipt") history.complete = () => { throw new Error("synthetic-private-receipt-failure"); };
      const chat = new WebChatSessions(storeDouble(failure === "host"), async () => {
        throw new Error("synthetic-private-session-failure");
      }, 1000, catalog, history);
      try {
        const created = await chat.create(undefined, "demo-a"), id = randomUUID();
        await assert.rejects(chat.send(created.token, id, failure === "session" ? "你好" : "我有哪些订单", created.session.id));
        assert.equal(summaries.length, before + 1, "One final summary per accepted web request");
        const summary = summaries.at(-1)!;
        assert.equal(summary.entrypoint, "web"); assert.equal(summary.requestIdHash, requestHash(id));
        assert.equal(summary.status, "failed", `Cleanup cancellation cannot replace the ${failure} failure status`);
        assert.equal(summary.failurePhase, failure);
        assert.equal(summary.failureReason, failure === "receipt" ? "receipt_unknown" : `${failure}_failed`);
        assert.equal(summary.httpRequests, 0); assert.equal(summary.logicalCalls, 0);
      } finally { chat.close(); }
    }

    {
      const before = summaries.length, sent: string[] = []; let receipts = 0;
      const reply = await runCliPrompt(sessionDouble(), "宿主咨询", async value => { sent.push(value); },
        async () => { receipts++; }, async () => ({ kind: "notice", text: "已按宿主规则查询。" }));
      assert.equal(reply.kind, "notice"); assert.equal(sent.length, 1); assert.equal(receipts, 1);
      assert.equal(summaries.length, before + 1);
      const summary = summaries.at(-1)!;
      assert.equal(summary.entrypoint, "cli"); assert.equal(summary.status, "completed");
      assert.equal(summary.httpRequests, 0); assert.equal(summary.logicalCalls, 0); assert.equal(summary.localCalls, 0);
    }
    {
      const before = summaries.length;
      const chat = new WebChatSessions(storeDouble(), async () => { assert.fail("Host-only web reply must not create a model session"); }, 1000, catalog);
      try {
        const created = await chat.create(undefined, "demo-a");
        const result = await chat.send(created.token, randomUUID(), "我有哪些订单", created.session.id);
        assert.equal(result.origin, "host"); assert.equal(result.reply.kind, "order");
        assert.equal(summaries.length, before + 1);
        const summary = summaries.at(-1)!;
        assert.equal(summary.entrypoint, "web"); assert.equal(summary.status, "completed");
        assert.equal(summary.httpRequests, 0); assert.equal(summary.logicalCalls, 0); assert.equal(summary.localCalls, 0);
      } finally { chat.close(); }
    }

    {
      const before = summaries.length, id = randomUUID(); let dispatched = 0;
      let escapedFetch: typeof fetch | undefined;
      const fakeFetch: typeof fetch = async () => {
        dispatched++; return new Response(JSON.stringify({ usage: { total_tokens: 1 } }), { headers: { "content-type": "application/json" } });
      };
      const chat = new WebChatSessions(storeDouble(), async () => sessionDouble(async () => {
        // This prompt is reached via WebChatSessions -> the real runCliPrompt.
        // A nested CLI wrapper must not reset web identity, limit or ledger.
        const task = currentModelTask(); assert.ok(task);
        assert.equal(task.snapshot().entrypoint, "web"); assert.equal(task.snapshot().requestIdHash, requestHash(id));
        assert.equal(task.snapshot().limits.httpRequests, 1);
        escapedFetch = createModelRequestFetch({ phase: "rerank", provider: "entry-check", model: "entry-check", format: "bailian-json" }, fakeFetch);
        await (await escapedFetch("https://entry-check.invalid/first")).text();
        await escapedFetch("https://entry-check.invalid/second");
      }), 1000, catalog);
      try {
        const created = await chat.create(undefined, "demo-a");
        // Entrypoint config is already captured; an inner driver must not read a new budget.
        process.env.MODEL_TASK_HTTP_LIMIT = "64";
        await assert.rejects(chat.send(created.token, id, "你好", created.session.id));
        assert.equal(summaries.length, before + 1, "Nested CLI does not emit a second final ledger");
        const summary = summaries.at(-1)!;
        assert.equal(summary.entrypoint, "web"); assert.equal(summary.requestIdHash, requestHash(id));
        assert.equal(summary.limits.httpRequests, 1); assert.equal(summary.httpRequests, 1); assert.equal(summary.blockedRequests, 1);
        assert.equal(summary.status, "http_limit"); assert.equal(summary.failureReason, "http_limit"); assert.equal(dispatched, 1);
        assert.ok(escapedFetch); await assert.rejects(escapedFetch("https://entry-check.invalid/late"));
        assert.equal(dispatched, 1, "The finalized entrypoint scope rejects late dispatch");
        assert.equal(currentModelTask(), undefined, "Entrypoint scope must not leak into its caller");
      } finally { process.env.MODEL_TASK_HTTP_LIMIT = "1"; chat.close(); }
    }
    assert.equal(summaries.length, 6);
    assert.equal(unexpectedRemote, 0);
    assert.doesNotMatch(JSON.stringify(summaries), /synthetic-private|entry-check-customer|entry-check-binding|宿主咨询|我有哪些订单|你好/);
  } finally {
    console.error = previousInfo; globalThis.fetch = previousFetch;
    if (previousLimit === undefined) delete process.env.MODEL_TASK_HTTP_LIMIT; else process.env.MODEL_TASK_HTTP_LIMIT = previousLimit;
  }
  console.log("Model task entry checks passed: web host/session/receipt failure attribution; CLI/web host zero-call paths; web-to-CLI scope, frozen HTTP budget, one final ledger and late-dispatch rejection. In-memory history and fake transport only; 0 remote/MySQL/QQ.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkModelTaskEntries();
