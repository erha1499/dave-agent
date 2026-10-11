import assert from "node:assert/strict";
import { request } from "node:http";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { captureEvaluationTurn } from "../src/eval-capture.ts";
import { createEvaluationServer } from "../src/eval-server.ts";
import { summarizeEvaluation, type EvalTurn } from "../src/evaluation.ts";

const turn: EvalTurn = {
  index: 1, question: "合成评测检查", reply: "", status: "passed", startedAt: new Date().toISOString(),
  durationMs: 100, firstTextMs: null, evidenceIds: [],
  checks: [{ id: "owner", name: "归属拒绝", category: "safety", status: "passed" }],
  steps: [
    { index: 1, type: "model", name: "test", durationMs: 80, isError: false, usage: null },
    { index: 2, type: "tool", name: "get_order", durationMs: 20, isError: true, expectedDenial: true },
  ],
};
const metrics = summarizeEvaluation([
  { id: "safe", name: "预期拒绝", category: "安全", status: "passed", turns: [turn] },
  { id: "failure", name: "意外错误", category: "执行", status: "failed", turns: [{ ...turn, status: "failed", durationMs: 300,
    checks: [{ id: "request", name: "请求失败", category: "execution", status: "failed" }],
    steps: [{ index: 1, type: "tool", name: "get_order", durationMs: 3, isError: true }],
  }] },
  { id: "skip", name: "尚未执行", category: "执行", status: "skipped", turns: [{ ...turn, status: "skipped", durationMs: null, checks: [], steps: [] }] },
]);
assert.equal(metrics.casesPassed, 1);
assert.equal(metrics.casesFailed, 1);
assert.equal(metrics.casesSkipped, 1);
assert.equal(metrics.expectedDenials, 1);
assert.equal(metrics.toolErrors, 1);
assert.equal(metrics.totalTokens, null);
assert.equal(metrics.estimatedCostUsd, null);
assert.equal(metrics.durationP50Ms, 100);
assert.equal(metrics.durationP95Ms, 300);

const capture = captureEvaluationTurn("test", "COUPON-1002");
const message: AssistantMessage = {
  role: "assistant", api: "openai-completions", provider: "test", model: "test", content: [], stopReason: "stop", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
capture.receive({ type: "message_start", message });
capture.receive({ type: "message_end", message });
for (const orderId of ["COUPON-1002", "COUPON-1001"]) {
  capture.receive({ type: "tool_execution_start", toolName: "get_order", toolCallId: orderId, args: { orderId } });
  capture.receive({ type: "tool_execution_end", toolName: "get_order", toolCallId: orderId, isError: true,
    result: { content: [{ type: "text", text: "未找到当前客户可查询的订单，请核对订单号或联系人工客服。" }] } });
}
capture.receive({ type: "tool_execution_start", toolName: "search_faq", toolCallId: "unfinished", parentToolCallId: "parent-merchant", args: { query: "退款" } });
const collected = capture.finish();
assert.equal(collected.steps[0]?.usage, null);
assert.equal(collected.steps[1]?.expectedDenial, true);
assert.equal(collected.steps[2]?.expectedDenial, false);
assert.equal(collected.steps[3]?.isError, true);
assert.equal(collected.steps[3]?.toolCallId, "unfinished");
assert.equal(collected.steps[3]?.parentToolCallId, "parent-merchant");
assert.equal(collected.steps[1]?.parentToolCallId, undefined);
assert.equal(collected.failed, false);
const reported = captureEvaluationTurn("test");
const withUsage = { ...message, usage: { ...message.usage, input: 10, output: 5, cacheRead: 2, totalTokens: 17,
  cost: { ...message.usage.cost, total: .001 } } };
reported.receive({ type: "message_start", message: withUsage });
reported.receive({ type: "message_end", message: withUsage });
assert.equal(reported.finish().steps[0]?.usage?.totalTokens, 17);
assert.equal(reported.finish().steps[0]?.usage?.estimatedCostUsd, .001);
const malformed = captureEvaluationTurn("test", "COUPON-1002");
malformed.receive({ type: "tool_execution_start", toolName: "get_order", toolCallId: "malformed", args: { orderId: "COUPON-1002" } });
assert.doesNotThrow(() => malformed.receive({ type: "tool_execution_end", toolName: "get_order", toolCallId: "malformed", isError: true, result: { content: 1 } }));
assert.equal(malformed.finish().failed, true);

const mockStore = { ping: async () => {}, listRuns: async () => [], getRun: async () => undefined, getBatch: async () => [] };
const navigationRequest = (url: string, headers: Record<string, string>) => new Promise<{ status?: number; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
  request(url, { headers }, response => { response.resume(); resolve({ status: response.statusCode, headers: response.headers }); }).on("error", reject).end();
});
for (const invalid of ["", " 3002", "3002 ", "1023", "65536", "https://evil.test", "3002/path"])
  assert.throws(() => createEvaluationServer(mockStore, undefined, invalid), /CHAT_PORT/);
const server = createEvaluationServer(mockStore);
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /评测/);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), { runs: [] });
  assert.equal((await fetch(`${base}/api/runs?limit=101`)).status, 400);
  assert.equal((await fetch(`${base}/api/runs?kind=qq`)).status, 400);
  assert.equal((await fetch(`${base}/api/runs?limit=1&limit=2`)).status, 400);
  assert.equal((await fetch(`${base}/api/runs/not-a-uuid`)).status, 400);
  assert.equal((await fetch(`${base}/api/runs/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs`, { method: "POST" })).status, 405);
  for (const hostname of ["127.0.0.1", "localhost"]) {
    const navigation: Awaited<ReturnType<typeof navigationRequest>> = await navigationRequest(`${base}/chat`, { Host: `${hostname}:${address.port}` });
    assert.equal(navigation.status, 302); assert.equal(navigation.headers.location, `http://${hostname}:3002/`);
    assert.equal(navigation.headers["cache-control"], "no-store");
    assert.match(String(navigation.headers["content-security-policy"]), /frame-ancestors 'none'/);
  }
  assert.equal((await fetch(`${base}/chat?target=https://evil.test`, { redirect: "manual" })).status, 400);
  assert.equal((await fetch(`${base}/chat`, { method: "POST", body: "target=https://evil.test", redirect: "manual" })).status, 405);
  assert.equal((await navigationRequest(`${base}/chat`, { Host: "evil.test" })).status, 403);
  assert.equal((await fetch(`${base}/chat`, { headers: { Origin: "https://evil.test" }, redirect: "manual" })).status, 403);
  assert.equal((await fetch(`${base}/chat`, { headers: { "Sec-Fetch-Site": "cross-site" }, redirect: "manual" })).status, 403);
  const bodyNavigation = await new Promise<number | undefined>((resolve, reject) => {
    const body = "target=https://evil.test";
    request(`${base}/chat`, { method: "GET", headers: { "Content-Length": Buffer.byteLength(body) } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject).end(body);
  });
  assert.equal(bodyNavigation, 400);
  const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
    request(base, { headers: { Host: `untrusted.test:${address.port}` } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject).end();
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch(base, { headers: { Origin: "https://untrusted.test" } })).status, 403);
  console.log("PASS 评测口径、缺失 usage、安全拒绝与只读 HTTP 边界。");
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

const customPortServer = createEvaluationServer(mockStore, undefined, "3102");
try {
  await new Promise<void>(resolve => customPortServer.listen(0, "127.0.0.1", resolve));
  const address = customPortServer.address(); assert.ok(address && typeof address === "object");
  for (const hostname of ["127.0.0.1", "localhost"]) {
    const navigation: Awaited<ReturnType<typeof navigationRequest>> = await navigationRequest(`http://127.0.0.1:${address.port}/chat`, { Host: `${hostname}:${address.port}` });
    assert.equal(navigation.status, 302); assert.equal(navigation.headers.location, `http://${hostname}:3102/`);
  }
  console.log("PASS 本机双向导航：固定默认/自定义端口、保持hostname，来源/参数/正文拒绝；0 真实模型/DB/QQ。");
} finally { await new Promise<void>(resolve => customPortServer.close(() => resolve())); }

await import("./eval-analysis-check.ts");
await import("./objective-eval-check.ts");
await import("./experiment-check.ts");
await import("./experiment-jobs-check.ts");
await import("./experiment-ui-check.ts");
await import("./acceptance-data-check.ts");
await import("./evidence-acceptance-check.ts");
await import("./acceptance-calibrate-check.ts");
await import("./support-validation-data-check.ts");

await import("./evidence-support-check.ts");
await import("./evidence-support-runner-check.ts");
await import("./knowledge-service-check.ts");
