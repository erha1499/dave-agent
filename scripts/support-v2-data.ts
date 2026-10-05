import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseSupportAction, type SupportAction } from "../src/support-action.ts";
import type { SupportExpectation } from "../src/support-evaluation.ts";

export type DevelopmentCase = {
  id: string; tags: string[];
  setup: { task: "approved" | "pending"; rules: boolean; operation: "none" | "awaiting_confirmation" | "expired" | "succeeded"; foreign: boolean };
  turns: Array<{ index: number; question: string; action: SupportAction; expect: SupportExpectation; restart?: boolean }>;
};
export async function loadSupportDevelopment() {
  const data = JSON.parse(await readFile(new URL("../data/support-v2-development.json", import.meta.url), "utf8")) as {
    version: number; scope: string; answerQuality: string; provenance: string; cases: DevelopmentCase[];
  };
  assert.equal(data.version, 2); assert.equal(data.scope, "objective"); assert.equal(data.answerQuality, "not_evaluated");
  assert.equal(data.cases.length, 12); assert.equal(new Set(data.cases.map(item => item.id)).size, 12);
  for (const tag of ["action", "focus", "missing-evidence", "recovery"]) assert.equal(data.cases.filter(item => item.tags.includes(tag)).length, 3);
  for (const item of data.cases) {
    assert.match(item.id, /^[a-z][a-z0-9-]{0,63}$/); assert.ok(item.turns.length > 0);
    for (const [index, turn] of item.turns.entries()) {
      assert.equal(turn.index, index + 1); assert.ok(turn.question.trim()); parseSupportAction(turn.action);
      assert.ok(["read", "refund_prepared", "merchant_blocked", "missing_rules", "denied", "safe_stop", "refund_status"].includes(turn.expect.branch));
      assert.ok(turn.expect.orderId === null || /^COUPON-2\d{3}$/.test(turn.expect.orderId));
      assert.ok(turn.expect.requiredCalls.every(name => ["get_order", "search_faq", "get_merchant_request", "prepare_refund", "get_refund"].includes(name)));
    }
  }
  return data;
}
