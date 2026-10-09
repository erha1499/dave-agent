import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Two synthetic user turns, not a model-quality benchmark. Importing never sends a request.
const questions = ["请查询我本人的订单 COUPON-1001。", "订单 COUPON-1001 的券现在是否已经核销？"];

export async function checkWebChatLiveContract() {
  assert.equal(questions.length, 2);
  assert.ok(questions.every(text => text.includes("COUPON-1001")));
}

async function run() {
  const origin = "http://127.0.0.1:3002";
  const result = { runId: randomUUID(), startedAt: new Date().toISOString(), status: "failed", planned: questions.length,
    executed: 0, passed: 0, notExecuted: questions.length, qq: "not-called", databaseWrites: "not-enabled",
    providerRequests: "not-measured", turns: [] as unknown[] };
  let cookie = "";
  async function request(path: string, body?: unknown) {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Chat-Request": "1" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
    const next = response.headers.getSetCookie();
    if (next.length) cookie = next.map(value => value.split(";")[0]!).join("; ");
    assert.equal(response.status, 200, "local chat HTTP receipt must be successful");
    return response.json();
  }
  try {
    const created = await request("/api/chat/session", { profileId: "demo-a", sessionId: null });
    assert.equal(created.session?.profileId, "demo-a");
    for (const text of questions) {
      const requestId = randomUUID(), started = performance.now();
      result.executed++; result.notExecuted--;
      const receipt = await request("/api/chat/messages", { sessionId: created.session.id, requestId, text });
      result.turns.push({ requestId, text, receipt, clientDurationMs: performance.now() - started });
      assert.equal(receipt.sessionId, created.session.id);
      assert.equal(receipt.requestId, requestId);
      assert.equal(receipt.origin, "agent");
      assert.ok(["answer", "order"].includes(receipt.reply?.kind));
      assert.ok(typeof receipt.reply.text === "string" && receipt.reply.text.trim());
      assert.ok(!receipt.reply.text.includes("COUPON-1002"), "other synthetic customer's order cannot enter the receipt");
      if (result.executed === 1) {
        assert.equal(receipt.reply.kind, "order", "structured order must come from the actual tool");
        assert.equal(receipt.reply.orders?.length, 1);
        assert.equal(receipt.reply.orders[0].id, "COUPON-1001");
        assert.ok(Number.isSafeInteger(receipt.reply.orders[0].paidCents));
      }
      result.passed++;
    }
    result.status = "passed";
  } catch {
    // Preserve failure and full planned denominator; no blind retries or extra paid turns.
    process.exitCode = 1;
  } finally {
    await mkdir(".runtime", { recursive: true });
    await writeFile(".runtime/web-chat-live-results.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ runId: result.runId, status: result.status, planned: result.planned,
      executed: result.executed, passed: result.passed, notExecuted: result.notExecuted, providerRequests: result.providerRequests }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkWebChatLiveContract();
  if (process.argv.includes("--live")) await run();
  else console.log("PASS web chat live contract: 2 synthetic turns; no HTTP/model/DB/QQ calls without --live.");
}
