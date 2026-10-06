-- O4-4: keep task provenance in the business record. Legacy NULL rows stay explicit-query only.
SET NAMES utf8mb4;
USE dave_agent;

-- No identity FK: deleting a QQ binding must invalidate references without deleting business history.
SET @merchant_reference_ddl = IF(EXISTS (
  SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_requests' AND COLUMN_NAME = 'identity_id'
), 'SELECT 1', 'ALTER TABLE merchant_requests ADD COLUMN identity_id BIGINT UNSIGNED NULL AFTER customer_id');
PREPARE merchant_reference_migration FROM @merchant_reference_ddl;
EXECUTE merchant_reference_migration;
DEALLOCATE PREPARE merchant_reference_migration;

SET @merchant_reference_ddl = IF(EXISTS (
  SELECT 1 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'merchant_requests' AND INDEX_NAME = 'ix_merchant_reference_source'
), 'SELECT 1', 'CREATE INDEX ix_merchant_reference_source ON merchant_requests (source_key, identity_id, created_at)');
PREPARE merchant_reference_migration FROM @merchant_reference_ddl;
EXECUTE merchant_reference_migration;
DEALLOCATE PREPARE merchant_reference_migration;
