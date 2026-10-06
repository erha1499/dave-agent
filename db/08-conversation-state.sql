-- O4-1 locators only. Business authorization and state stay in their existing tables.
SET NAMES utf8mb4;
USE dave_agent;

CREATE TABLE IF NOT EXISTS conversation_state (
  source_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  customer_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- No identity FK: removing a QQ binding must remain possible and invalidate old locators.
  identity_id BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  context_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_conversation_state_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT ck_conversation_state_revision CHECK (revision BETWEEN 1 AND 9007199254740991)
);
