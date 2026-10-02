import { randomBytes, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type Outcome = "approve" | "reject" | "timeout";

function admin(sql: string) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr.includes("ERROR 1062") ? "fixture_collision" : "商家测试数据准备或清理失败；请检查本机 Docker 数据库。");
  }
  return result.stdout.trim();
}

// Administrator-only test helper. Every mutation is scoped to fresh orders plus a random payment marker.
export async function createMerchantFixture(outcomes: Outcome[], options: { delayMs?: number } = {}) {
  if (!outcomes.length || outcomes.length > 20 || outcomes.some(value => !["approve", "reject", "timeout"].includes(value))) {
    throw new Error("测试场景无效。");
  }
  const delayMs = options.delayMs ?? 100;
  function timing(delay: number) {
    if (!Number.isInteger(delay) || delay < 1 || delay > 5000) {
      throw new Error("测试延时应为 1–5000 毫秒整数。");
    }
  }
  timing(delayMs);
  const marker = `mcheck-${randomBytes(10).toString("hex")}`;
  let orders: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const numbers = new Set<number>();
    while (numbers.size < outcomes.length) numbers.add(randomInt(2100, 3000));
    orders = [...numbers].map(number => `COUPON-${number}`);
    const inserts = orders.map((orderId, index) => {
      const suffix = orderId.slice(-4);
      return `INSERT INTO orders (id, customer_id, shop_id, status, total_cents, paid_cents, refunded_cents, created_at, paid_at)
SELECT '${orderId}', customer_id, shop_id, status, total_cents, paid_cents, refunded_cents, created_at, paid_at FROM orders WHERE id = 'COUPON-2001';
INSERT INTO order_items (id, order_id, product_id, shop_id, quantity, unit_price_cents, total_cents)
SELECT '${marker}-item-${suffix}', '${orderId}', product_id, shop_id, quantity, unit_price_cents, total_cents FROM order_items WHERE order_id = 'COUPON-2001';
INSERT INTO coupons (id, order_item_id, status, expires_at, redeemed_at, redeemed_shop_id)
SELECT '${marker}-coupon-${suffix}', '${marker}-item-${suffix}', c.status, c.expires_at, c.redeemed_at, c.redeemed_shop_id FROM coupons c JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = 'COUPON-2001';
INSERT INTO payments (id, order_id, status, amount_cents, paid_at, created_at)
SELECT '${marker}-payment-${suffix}', '${orderId}', status, amount_cents, paid_at, created_at FROM payments WHERE order_id = 'COUPON-2001';
INSERT INTO merchant_demo_scenarios (order_id, outcome, delay_ms) VALUES ('${orderId}', '${outcomes[index]}', ${delayMs});`;
    }).join("\n");
    try {
      admin(`START TRANSACTION;\n${inserts}\nCOMMIT;`);
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "fixture_collision" || attempt === 7) throw error;
    }
  }
  const orderList = orders.map(id => `'${id}'`).join(", ");
  const owned = `SELECT o.id FROM orders o JOIN payments p ON p.order_id = o.id
WHERE o.id IN (${orderList}) AND p.id = CONCAT('${marker}-payment-', RIGHT(o.id, 4))`;
  let cleaned = false;
  return {
    orders,
    identity: { appId: "TEST_APP", senderId: "TEST_USER1" },
    async setTiming(orderId: string, delay: number) {
      if (!orders.includes(orderId) || cleaned) throw new Error("只能调整本次测试创建的订单。");
      timing(delay);
      admin(`UPDATE merchant_demo_scenarios SET delay_ms = ${delay}
WHERE order_id = '${orderId}' AND order_id IN (${owned});`);
    },
    async expire(orderId: string) {
      if (!orders.includes(orderId) || cleaned) throw new Error("只能调整本次测试创建的订单。");
      admin(`UPDATE merchant_requests SET due_at = created_at, deadline_at = UTC_TIMESTAMP(3)
WHERE order_id = '${orderId}' AND status = 'pending' AND order_id IN (${owned});`);
    },
    async cleanup() {
      if (cleaned) return;
      // Snapshot the nonce-verified owned IDs before deleting their child rows. Never delete by number range.
      admin(`START TRANSACTION;
CREATE TEMPORARY TABLE cleanup_merchant_orders (id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY);
INSERT INTO cleanup_merchant_orders ${owned};
DELETE r FROM merchant_requests r JOIN cleanup_merchant_orders t ON t.id = r.order_id;
DELETE s FROM merchant_demo_scenarios s JOIN cleanup_merchant_orders t ON t.id = s.order_id;
DELETE r FROM refunds r JOIN cleanup_merchant_orders t ON t.id = r.order_id;
DELETE c FROM coupons c JOIN order_items i ON i.id = c.order_item_id JOIN cleanup_merchant_orders t ON t.id = i.order_id;
DELETE i FROM order_items i JOIN cleanup_merchant_orders t ON t.id = i.order_id;
DELETE p FROM payments p JOIN cleanup_merchant_orders t ON t.id = p.order_id;
DELETE o FROM orders o JOIN cleanup_merchant_orders t ON t.id = o.id;
COMMIT;`);
      cleaned = true;
    },
  };
}
