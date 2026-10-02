-- Synthetic restaurant coupon data. All DATETIME values are UTC; money is integer fen.
SET NAMES utf8mb4;
USE dave_agent;

CREATE TABLE customers (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  display_name VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- Written only by the local administrator using a verified QQ sender identity.
-- QQ group membership, message text and a model-generated customer ID cannot bind an account.
CREATE TABLE qq_identities (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  app_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sender_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bound_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_qq_sender (app_id, sender_id),
  CONSTRAINT fk_identity_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE merchants (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE shops (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  merchant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  address VARCHAR(255) NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  CONSTRAINT fk_shop_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id)
);

CREATE TABLE products (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  shop_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  price_cents INT UNSIGNED NOT NULL,
  validity_days SMALLINT UNSIGNED NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_product_shop (id, shop_id),
  CONSTRAINT fk_product_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT ck_product_price CHECK (price_cents > 0),
  CONSTRAINT ck_product_validity CHECK (validity_days > 0)
);

CREATE TABLE orders (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  customer_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shop_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('pending_payment', 'paid', 'partially_redeemed', 'redeemed', 'refunded', 'closed') NOT NULL,
  total_cents INT UNSIGNED NOT NULL,
  paid_cents INT UNSIGNED NOT NULL DEFAULT 0,
  refunded_cents INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_order_shop (id, shop_id),
  KEY ix_customer_orders (customer_id, created_at),
  CONSTRAINT fk_order_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_order_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT ck_order_amount CHECK (total_cents > 0 AND paid_cents <= total_cents AND refunded_cents <= paid_cents),
  CONSTRAINT ck_order_paid_time CHECK ((paid_cents = 0 AND paid_at IS NULL) OR (paid_cents > 0 AND paid_at IS NOT NULL)),
  CONSTRAINT ck_order_refunded CHECK (status <> 'refunded' OR (paid_cents > 0 AND refunded_cents = paid_cents)),
  CONSTRAINT ck_order_pending CHECK (status <> 'pending_payment' OR (paid_cents = 0 AND refunded_cents = 0))
);

CREATE TABLE order_items (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  product_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  shop_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  unit_price_cents INT UNSIGNED NOT NULL,
  total_cents INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_item_shop (id, shop_id),
  -- Composite foreign keys prevent an item from mixing another shop's product into an order.
  CONSTRAINT fk_item_order FOREIGN KEY (order_id, shop_id) REFERENCES orders(id, shop_id),
  CONSTRAINT fk_item_product FOREIGN KEY (product_id, shop_id) REFERENCES products(id, shop_id),
  CONSTRAINT ck_item_quantity CHECK (quantity > 0),
  CONSTRAINT ck_item_amount CHECK (unit_price_cents > 0 AND total_cents = quantity * unit_price_cents)
);

CREATE TABLE coupons (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_item_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('unused', 'redeemed', 'expired', 'refunded') NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  redeemed_at DATETIME(3) NULL,
  redeemed_shop_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  CONSTRAINT fk_coupon_item FOREIGN KEY (order_item_id) REFERENCES order_items(id),
  CONSTRAINT fk_coupon_redeemed_shop FOREIGN KEY (order_item_id, redeemed_shop_id) REFERENCES order_items(id, shop_id),
  CONSTRAINT ck_coupon_redemption CHECK (
    (status = 'redeemed' AND redeemed_at IS NOT NULL AND redeemed_shop_id IS NOT NULL)
    OR (status <> 'redeemed' AND redeemed_at IS NULL AND redeemed_shop_id IS NULL)
  )
);

CREATE TABLE payments (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  paid_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT ck_payment_amount CHECK (amount_cents > 0),
  CONSTRAINT ck_payment_time CHECK ((status = 'succeeded' AND paid_at IS NOT NULL) OR (status <> 'succeeded' AND paid_at IS NULL))
);

-- Historical facts only. The Agent's database account cannot insert or update refunds.
CREATE TABLE refunds (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('pending', 'succeeded', 'failed') NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  reason VARCHAR(255) NOT NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_refund_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT ck_refund_amount CHECK (amount_cents > 0),
  CONSTRAINT ck_refund_time CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR (status <> 'succeeded' AND completed_at IS NULL))
);

CREATE TABLE knowledge_documents (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  shop_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  product_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  title VARCHAR(128) NOT NULL,
  body TEXT NOT NULL,
  tags JSON NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_knowledge_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT fk_knowledge_product FOREIGN KEY (product_id, shop_id) REFERENCES products(id, shop_id),
  CONSTRAINT ck_knowledge_product_scope CHECK (product_id IS NULL OR shop_id IS NOT NULL),
  CONSTRAINT ck_knowledge_tags CHECK (JSON_TYPE(tags) = 'ARRAY')
);
