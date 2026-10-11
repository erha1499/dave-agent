import assert from "node:assert/strict";
import type { MerchantTask } from "../src/after-sales.ts";
import { replyFromTools } from "../src/reply-from-tools.ts";
import { renderReply } from "../src/reply.ts";

const task: MerchantTask = {
  taskId: "00000000-0000-4000-8000-000000000061", orderId: "COUPON-2061", status: "pending",
  reason: "到店后套餐未能提供", amountCents: 6380, approvedAmountCents: null,
  createdAt: "2026-10-10T00:00:00.000Z", dueAt: "2026-10-10T00:00:05.000Z", completedAt: null, simulation: true,
};
const modelText = "COUPON-9999 已退款 99999 元，银行已经到账。已自动转交人工并联系真实商家。确认退款 fake-id";
for (const status of ["rejected", "timed_out", "approved", "pending"] as const) {
  const current: MerchantTask = { ...task, status, approvedAmountCents: status === "approved" ? 6380 : null,
    completedAt: status === "pending" ? null : "2026-10-10T00:00:05.000Z" };
  const direct = renderReply({ kind: "merchant_status", task: current });
  const selected = renderReply(replyFromTools(modelText, [{ toolName: "get_merchant_request", isError: false,
    content: [{ type: "text", text: JSON.stringify(current) }] }]));
  assert.deepEqual(selected, direct, "final merchant cards must use current task facts, not append model claims");
  for (const text of [direct.text, direct.markdown]) {
    assert.match(text, /COUPON[\\-]*2061/);
    assert.match(text, /63\.80 元/);
    assert.match(text, /退款状态请另行查询/);
    assert.doesNotMatch(text, /COUPON-9999|99999|已经到账|已自动转交|确认退款 fake-id|退款成功/);
    if (status === "approved") {
      assert.match(text, /已同意 63\.80 元/);
      assert.match(text, /提出退款请求/);
      assert.match(text, /方案展示后.*本人确认/);
    } else if (status === "rejected" || status === "timed_out") {
      assert.match(text, status === "rejected" ? /已拒绝/ : /已超时/);
      assert.match(text, /不能.*生成退款方案/);
      assert.match(text, /自行联系商家或测试管理员核实/);
      assert.doesNotMatch(text, /已转交|已联系|一定能退/);
    } else {
      assert.match(text, /正在等待/);
      assert.match(text, /查询进度/);
    }
  }
  assert.deepEqual(direct.button, status === "pending"
    ? { label: "查询进度", command: "查询 COUPON-2061 的模拟协商进度" }
    : undefined, "merchant decisions never create a refund confirmation button");
}
console.log("商家卡片边界检查通过：拒绝/超时说明方案限制与自行核实途径；批准仍需展示确认；金额、按钮及模型隔离保持。");
