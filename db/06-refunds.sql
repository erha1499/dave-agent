-- D2 simulation only. The original read-only account and D1 account receive no new writes.
SET NAMES utf8mb4;
USE dave_agent;

CREATE TABLE IF NOT EXISTS refund_operations (
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sender_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('prepared', 'awaiting_confirmation', 'succeeded') NOT NULL DEFAULT 'prepared',
  amount_cents INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  presented_at DATETIME(3) NULL,
  confirmed_at DATETIME(3) NULL,
  refund_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  UNIQUE KEY uq_refund_operation_order (order_id),
  UNIQUE KEY uq_refund_operation_result (refund_id),
  CONSTRAINT fk_refund_operation_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_refund_operation_task FOREIGN KEY (task_id) REFERENCES merchant_requests(task_id),
  CONSTRAINT fk_refund_operation_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_refund_operation_result FOREIGN KEY (refund_id) REFERENCES refunds(id),
  CONSTRAINT ck_refund_operation_amount CHECK (amount_cents > 0),
  CONSTRAINT ck_refund_operation_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_refund_operation_state CHECK (
    (status = 'prepared' AND presented_at IS NULL AND confirmed_at IS NULL AND refund_id IS NULL)
    OR (status = 'awaiting_confirmation' AND presented_at IS NOT NULL AND confirmed_at IS NULL AND refund_id IS NULL)
    OR (status = 'succeeded' AND presented_at IS NOT NULL AND confirmed_at IS NOT NULL AND refund_id IS NOT NULL)
  )
);
