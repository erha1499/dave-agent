import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createCouponSession, createModelRuntime } from "../src/agent.ts";
import { contentHash } from "../src/bailian.ts";
import { contextBudgetPolicy } from "../src/model-request-budget.ts";

// Replays recorded synthetic content through the installed provider serializer.
// No tool executes and fetch is always replaced with a local SSE response.
export async function calibrateRecordedHistory(path: string) {
  const bytes = await readFile(path), artifact = JSON.parse(bytes.toString());
  assert.equal(artifact.mode, "live"); assert.ok(Array.isArray(artifact.rows));
  const runtime = await createModelRuntime(), model = { ...runtime.getModel("deepseek", "deepseek-flash")!, maxTokens: 2048 };
  await runtime.setRuntimeApiKey(model.provider, "local-calibration-only");
  const session = await createCouponSession({ appId: "CALIBRATION", senderId: "CALIBRATION" }, {} as Parameters<typeof createCouponSession>[1], runtime, model,
    { store: {} as NonNullable<Parameters<typeof createCouponSession>[4]>["store"], sourceKey: "calibration",
      refunds: {} as NonNullable<NonNullable<Parameters<typeof createCouponSession>[4]>["refunds"]> });
  const samples: Array<{ caseId: string; turn: number; hop: number; payloadBytes: number; requiredUnits: number }> = [];
  const tools = session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  assert.equal(tools.length, 7);
  try {
    for (const caseId of ["approved-refund", "rejected-recovery"]) {
      let messages: Message[] = []; const rows = artifact.rows.filter((row: { caseId: string }) => row.caseId === caseId); assert.equal(rows.length, 8);
      for (const row of rows) {
        if (row.execution === "not_run") continue;
        if (row.evidence.restarted) messages = [];
        messages.push({ role: "user", content: row.question, timestamp: 0 });
        let hop = 0;
        for (const step of row.steps) {
          if (step.type === "model") {
            hop++;
            await runtime.complete(model, { systemPrompt: session.systemPrompt, messages, tools }, { maxTokens: 2048, maxRetries: 0,
              fetch: async (_input, init) => {
                const body = String(init?.body), payload = JSON.parse(body), output = payload.max_tokens ?? payload.max_completion_tokens;
                assert.ok(Number.isSafeInteger(output) && output > 0 && output <= 2048);
                samples.push({ caseId, turn: row.index, hop, payloadBytes: Buffer.byteLength(body), requiredUnits: Buffer.byteLength(body) + output + contextBudgetPolicy.safetyUnits });
                return new Response(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", model: model.id,
                  choices: [{ index: 0, delta: { content: "本地测量" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
              } });
            messages.push({ ...fauxAssistantMessage(""), api: model.api, provider: model.provider, model: model.id,
              content: step.output.content as AssistantMessage["content"], stopReason: step.output.stopReason, timestamp: 0 });
          } else if (step.type === "tool") {
            const call = messages.flatMap(message => message.role === "assistant" ? message.content.filter(item => item.type === "toolCall") : [])
              .findLast(item => item.name === step.name && contentHash(item.arguments) === contentHash(step.input));
            assert.ok(call, "Recorded tool must bind to an actual recorded call");
            messages.push({ role: "toolResult", toolCallId: call.id, toolName: step.name, content: step.output.content, isError: step.isError, timestamp: 0 });
          }
        }
        // Host-only receipts are included conservatively as explicit user/reply text.
        if (!hop && row.reply) messages.push({ ...fauxAssistantMessage(row.reply), api: model.api, provider: model.provider, model: model.id, timestamp: 0 });
      }
    }
  } finally { session.dispose(); }
  return { sourceArtifactHash: contentHash(bytes), sourceRun: artifact.run.id, sourceRunIntegrityPassed: artifact.runIntegrityPassed, model: model.id, tools: tools.map(tool => tool.name),
    omittedNotRun: artifact.rows.filter((row: { caseId: string; execution: string }) => ["approved-refund", "rejected-recovery"].includes(row.caseId) && row.execution === "not_run").map((row: { caseId: string; index: number }) => ({ caseId: row.caseId, turn: row.index })),
    scope: "Native serialization replay of recorded synthetic M1 tool/answer content, host receipts represented as plain conversation text, observed restart retained. Not an exact historic wire replay or another model-quality run.",
    remoteHttp: 0, database: 0, samples, maximumRequiredUnits: Math.max(...samples.map(row => row.requiredUnits)) };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assert.ok(process.argv[2], "Pass the local frozen M1 live artifact path");
  console.log(JSON.stringify(await calibrateRecordedHistory(process.argv[2]!), null, 2));
}
