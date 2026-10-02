-- D3 simulation only: original QQ reply route and one notification attempt per task.
SET NAMES utf8mb4;
USE dave_agent;

CREATE TABLE IF NOT EXISTS merchant_notifications (
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  app_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sender_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_at DATETIME(3) NOT NULL,
  status ENUM('pending', 'claimed', 'sent', 'deferred', 'unknown') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  KEY ix_merchant_notification_pending (app_id, status),
  CONSTRAINT fk_merchant_notification_task FOREIGN KEY (task_id) REFERENCES merchant_requests(task_id),
  CONSTRAINT ck_merchant_notification_state CHECK (
    (status = 'pending' AND claimed_at IS NULL AND finished_at IS NULL)
    OR (status = 'claimed' AND claimed_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('sent', 'deferred', 'unknown') AND claimed_at IS NOT NULL AND finished_at IS NOT NULL)
  )
);
