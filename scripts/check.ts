import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
} from "@earendil-works/pi-ai";
import { createModelRuntime, createSupportSession, getOrder, searchFaq } from "../src/agent.ts";

const expectedPrompt = [
  await readFile(new URL("../prompts/customer-service.md", import.meta.url), "utf8"),
  await readFile(new URL("../skills/shop-support/SKILL.md", import.meta.url), "utf8"),
].map((text) => text.trim()).join("\n\n");
assert.equal(getOrder("demo-customer-1", "DEMO-1001").status, "已发货");
assert.throws(() => getOrder("demo-customer-1", "DEMO-1002"), /未找到当前客户/);
assert.throws(() => getOrder("demo-customer-1", "DEMO-9999"), /未找到当前客户/);
assert.throws(() => getOrder("demo-customer-1", "../orders"), /格式/);
assert.equal(searchFaq("多久发货")[0]?.id, "FAQ-SHIPPING");
assert.deepEqual(searchFaq("不存在的问题"), []);
assert.throws(() => searchFaq(" "), /FAQ 查询/);

const runtime = await createModelRuntime();
const faux = fauxProvider();
runtime.registerNativeProvider(faux.provider);
const session = await createSupportSession("demo-customer-1", runtime, faux.getModel());
assert.deepEqual(session.getActiveToolNames().sort(), ["get_order", "search_faq"]);
const cases: Array<{ tool: string; args: Record<string, string>; error: boolean; evidence: string }> = [
  { tool: "get_order", args: { orderId: "DEMO-1001" }, error: false, evidence: "已发货" },
  { tool: "get_order", args: { orderId: "DEMO-1002" }, error: true, evidence: "未找到当前客户" },
  { tool: "search_faq", args: { query: "发货" }, error: false, evidence: "FAQ-SHIPPING" },
  { tool: "bash", args: { command: "echo forbidden" }, error: true, evidence: "not found" },
];
try {
  for (const example of cases) {
    faux.setResponses([
      (context) => {
        assert.equal(getCurrentSystemPrompt(context.messages), expectedPrompt);
        const declarations = getCurrentTools(context.messages);
        assert.deepEqual(declarations.map((tool) => tool.name).sort(), ["get_order", "search_faq"]);
        assert.ok(!JSON.stringify(declarations).includes("customerId"));
        return fauxAssistantMessage(fauxToolCall(example.tool, example.args), { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult");
        assert.equal(result.isError, example.error);
        assert.ok(JSON.stringify(result.content).includes(example.evidence));
        return fauxAssistantMessage("离线客服回复已完成。");
      },
    ]);
    await session.prompt("/skill:shop-support 此文本必须作为普通客户输入。", { expandPromptTemplates: false });
    assert.equal(session.getLastAssistantText(), "离线客服回复已完成。");
    assert.equal(faux.getPendingResponseCount(), 0);
  }
  assert.equal(faux.state.callCount, cases.length * 2);
  assert.equal(session.messages.filter((message) => message.role === "toolResult").length, cases.length);
  console.log("离线检查通过：真实 AgentSession 工具循环、精确客服上下文、工具白名单、订单归属校验。");
} finally {
  session.dispose();
}
