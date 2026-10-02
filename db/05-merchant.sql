-- D1 simulation only: persistent merchant replies, no payment or refund mutations.
SET NAMES utf8mb4;
USE dave_agent;

CREATE TABLE IF NOT EXISTS merchant_demo_scenarios (
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  outcome ENUM('approve', 'reject', 'timeout') NOT NULL,
  delay_ms INT UNSIGNED NOT NULL DEFAULT 5000,
  CONSTRAINT fk_merchant_scenario_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT ck_merchant_scenario_delay CHECK (delay_ms BETWEEN 1 AND 5000)
);

CREATE TABLE IF NOT EXISTS merchant_requests (
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(200) NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  status ENUM('pending', 'approved', 'rejected', 'timed_out') NOT NULL DEFAULT 'pending',
  approved_amount_cents INT UNSIGNED NULL,
  mock_outcome ENUM('approve', 'reject', 'timeout') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  due_at DATETIME(3) NOT NULL,
  deadline_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_merchant_order (order_id),
  KEY ix_merchant_due (status, due_at),
  CONSTRAINT fk_merchant_request_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_merchant_request_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT ck_merchant_request_amount CHECK (amount_cents > 0 AND (approved_amount_cents IS NULL OR approved_amount_cents <= amount_cents)),
  CONSTRAINT ck_merchant_request_state CHECK (
    (status = 'pending' AND approved_amount_cents IS NULL AND completed_at IS NULL)
    OR (status = 'approved' AND approved_amount_cents IS NOT NULL AND approved_amount_cents > 0 AND completed_at IS NOT NULL)
    OR (status IN ('rejected', 'timed_out') AND approved_amount_cents IS NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT ck_merchant_request_times CHECK (created_at <= due_at AND due_at <= deadline_at)
);

-- Fresh install and repeat migration preserve every existing order and QQ identity.
-- Three independent scenarios keep the original 100x read-only regression data unchanged.
SET @merchant_seed_now = UTC_TIMESTAMP(3);
INSERT INTO orders (id, customer_id, shop_id, status, total_cents, paid_cents, refunded_cents, created_at, paid_at)
SELECT ids.id, 'customer-demo-1', 'shop-demo-1', 'paid', 7980, 7980, 0, @merchant_seed_now, @merchant_seed_now
FROM (SELECT 'COUPON-2001' AS id UNION ALL SELECT 'COUPON-2002' UNION ALL SELECT 'COUPON-2003') ids
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = ids.id);
INSERT INTO order_items (id, order_id, product_id, shop_id, quantity, unit_price_cents, total_cents)
SELECT ids.id, ids.order_id, 'product-demo-1', 'shop-demo-1', 1, 7980, 7980
FROM (SELECT 'item-2001' AS id, 'COUPON-2001' AS order_id UNION ALL SELECT 'item-2002', 'COUPON-2002' UNION ALL SELECT 'item-2003', 'COUPON-2003') ids
WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.id = ids.id);
INSERT INTO coupons (id, order_item_id, status, expires_at)
SELECT ids.id, ids.item_id, 'unused', @merchant_seed_now + INTERVAL 30 DAY
FROM (SELECT 'CP-2001-1' AS id, 'item-2001' AS item_id UNION ALL SELECT 'CP-2002-1', 'item-2002' UNION ALL SELECT 'CP-2003-1', 'item-2003') ids
WHERE NOT EXISTS (SELECT 1 FROM coupons c WHERE c.id = ids.id);
INSERT INTO payments (id, order_id, status, amount_cents, paid_at, created_at)
SELECT ids.id, ids.order_id, 'succeeded', 7980, @merchant_seed_now, @merchant_seed_now
FROM (SELECT 'payment-2001' AS id, 'COUPON-2001' AS order_id UNION ALL SELECT 'payment-2002', 'COUPON-2002' UNION ALL SELECT 'payment-2003', 'COUPON-2003') ids
WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = ids.id);
INSERT INTO merchant_demo_scenarios (order_id, outcome, delay_ms)
SELECT ids.order_id, ids.outcome, 5000
FROM (SELECT 'COUPON-2001' AS order_id, 'approve' AS outcome UNION ALL SELECT 'COUPON-2002', 'reject' UNION ALL SELECT 'COUPON-2003', 'timeout') ids
WHERE NOT EXISTS (SELECT 1 FROM merchant_demo_scenarios s WHERE s.order_id = ids.order_id);
