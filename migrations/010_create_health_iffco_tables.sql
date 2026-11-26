-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 010 — health purchase data model: IFFCO Tokio tables
--
--   health_iffco_proposals  proposal: uniqueReferenceNo, orderNo, traceNo
--   health_iffco_kyc        CKYC fetch / create attempts and document references
--   health_iffco_payments   gateway attempts and the payment-return callback,
--                           1:1 with health_payments
--   health_iffco_policies   policy number (from the callback), dates, document
--   health_iffco_api_logs   every IFFCO Tokio call, masked and encrypted
--
-- Requires 008.
--
-- WHY THESE TABLES
--   Until now an IFFCO Tokio purchase was recorded only as JSON inside
--   nivabupa_api_transactions; the policy number existed nowhere else in the
--   database. Those rows stay where they are and are copied here when the ITGI
--   write path moves (a later release).
--
-- KYC DOCUMENTS
--   CKYC create uploads PAN, address proof and a photograph. Only the document
--   type and ITGI's reference are kept (document_refs); never the file.
--
-- Same conventions, guard and marker as 008. Rollback at the end of the file.
-- Additive only: no existing table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

-- ── Guard: stop if a name is taken by a table this migration did not create ─
SET @taken := (
  SELECT GROUP_CONCAT(TABLE_NAME) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('health_iffco_proposals', 'health_iffco_kyc', 'health_iffco_payments',
                       'health_iffco_policies', 'health_iffco_api_logs')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_010_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_iffco_proposals — one per purchase. unique_reference_no is ours
--    (sent from premium onwards); order_no is ITGI's, returned by the proposal
--    and echoed on the payment return.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_iffco_proposals` (
  `id`                       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_id`              BIGINT UNSIGNED  NOT NULL,
  `unique_reference_no`      VARCHAR(60)      NOT NULL COMMENT 'ours; sent from premium onwards',
  `order_no`                 VARCHAR(60)          NULL COMMENT 'ITGI orderNo',
  `trace_no`                 VARCHAR(60)          NULL,
  `ptnr_transaction_log_id`  VARCHAR(60)          NULL,
  `contract_type`            VARCHAR(30)          NULL,
  `siebel_row_id`            VARCHAR(60)          NULL,
  `product`                  VARCHAR(60)          NULL,
  `premium_payable`          DECIMAL(12,2)        NULL,
  `status`                   ENUM('SUBMITTED','ACCEPTED','FAILED') NOT NULL DEFAULT 'SUBMITTED',
  `status_message`           VARCHAR(500)         NULL,
  `created_at`               DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`               DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hitp_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hitp_unique_reference` (`unique_reference_no`),
  UNIQUE KEY `uk_hitp_order_no` (`order_no`),
  CONSTRAINT `fk_hitp_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] IFFCO Tokio proposal; see migrations/010';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_iffco_kyc — one row per CKYC fetch or create attempt.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_iffco_kyc` (
  `id`               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`      BIGINT UNSIGNED   NOT NULL,
  `kyc_action`       ENUM('FETCH','CREATE') NOT NULL,
  `status`           ENUM('PENDING','VERIFIED','REJECTED','FAILED') NOT NULL DEFAULT 'PENDING',
  `itgi_kyc_ref`     VARCHAR(100)          NULL,
  `ckyc_number_enc`  VARBINARY(128)        NULL,
  `document_refs`    JSON                  NULL COMMENT 'document type and ITGI reference per upload; never the file',
  `status_message`   VARCHAR(500)          NULL,
  `verified_at`      DATETIME(3)           NULL,
  `enc_key_version`  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_hitk_purchase` (`purchase_id`),
  KEY `idx_hitk_ref` (`itgi_kyc_ref`),
  CONSTRAINT `fk_hitk_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] IFFCO Tokio KYC attempts; see migrations/010';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_iffco_payments — one per payment attempt, paired 1:1 with a
--    health_payments row of the same purchase. ITGI redirect the buyer to
--    /iffcotokio/payment/return with orderNo and, on success, the policyNo:
--    the callback_* columns hold what arrived. (order_no, trace_no) is unique,
--    so a repeated return for the same attempt cannot add a row.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_iffco_payments` (
  `id`                   BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`          BIGINT UNSIGNED   NOT NULL,
  `health_payment_id`    BIGINT UNSIGNED   NOT NULL,
  `order_no`             VARCHAR(60)       NOT NULL,
  `trace_no`             VARCHAR(60)           NULL,
  `payment_url_enc`      VARBINARY(2048)       NULL,
  `callback_policy_no`   VARCHAR(80)           NULL,
  `callback_premium`     DECIMAL(12,2)         NULL,
  `callback_message`     VARCHAR(500)          NULL,
  `callback_succeeded`   TINYINT(1)            NULL,
  `callback_count`       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `callback_received_at` DATETIME(3)           NULL,
  `confirmation_status`  VARCHAR(40)           NULL COMMENT 'payment/confirmation answer, when support runs it',
  `confirmed_at`         DATETIME(3)           NULL,
  `enc_key_version`      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hitpy_health_payment` (`health_payment_id`),
  UNIQUE KEY `uk_hitpy_health_payment_purchase` (`health_payment_id`, `purchase_id`),
  UNIQUE KEY `uk_hitpy_order_trace` (`order_no`, `trace_no`),
  KEY `idx_hitpy_purchase` (`purchase_id`),
  KEY `idx_hitpy_policy_no` (`callback_policy_no`),
  CONSTRAINT `fk_hitpy_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hitpy_health_payment`
    FOREIGN KEY (`health_payment_id`, `purchase_id`) REFERENCES `health_payments` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] IFFCO Tokio payment attempts and returns; see migrations/010';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_iffco_policies — one per purchase. ITGI issue the policy
--    themselves on payment; its number arrives on the payment return.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_iffco_policies` (
  `id`                   BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`          BIGINT UNSIGNED   NOT NULL,
  `policy_no`            VARCHAR(80)           NULL,
  `policy_download_no`   VARCHAR(80)           NULL,
  `download_url_enc`     VARBINARY(2048)       NULL COMMENT 'ITGI document link',
  `status`               ENUM('PENDING','ISSUED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `issue_date`           DATE                  NULL,
  `start_date`           DATE                  NULL,
  `end_date`             DATE                  NULL,
  `issuance_claimed_at`  DATETIME(3)           NULL,
  `document_id`          BIGINT UNSIGNED       NULL,
  `enc_key_version`      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hitpl_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hitpl_policy_no` (`policy_no`),
  KEY `idx_hitpl_document` (`document_id`, `purchase_id`),
  CONSTRAINT `fk_hitpl_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hitpl_document`
    FOREIGN KEY (`document_id`, `purchase_id`) REFERENCES `health_policy_documents` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] IFFCO Tokio policy; see migrations/010';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_iffco_api_logs — same shape as health_niva_api_logs (see 009).
--    Rows copied from test hosts (*.invalid, undefined/…) get is_test = 1.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_iffco_api_logs` (
  `id`               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`      BIGINT UNSIGNED       NULL,
  `api_name`         VARCHAR(60)       NOT NULL,
  `direction`        ENUM('OUTBOUND','INBOUND') NOT NULL,
  `insurer_env`      ENUM('UAT','PROD')   NOT NULL,
  `http_method`      VARCHAR(10)           NULL,
  `endpoint`         VARCHAR(300)          NULL COMMENT 'scheme, host and path; never the query string',
  `http_status`      SMALLINT UNSIGNED     NULL,
  `outcome`          ENUM('SUCCESS','FAILED','TIMEOUT') NOT NULL,
  `insurer_status`   VARCHAR(80)           NULL COMMENT 'the insurer verdict, verbatim',
  `correlation_type` VARCHAR(30)           NULL,
  `correlation_id`   VARCHAR(100)          NULL,
  `duration_ms`      INT UNSIGNED          NULL,
  `request_masked`   JSON                  NULL,
  `response_masked`  JSON                  NULL,
  `request_enc`      LONGBLOB              NULL COMMENT 'exact bytes, encrypted; purged after the retention period',
  `response_enc`     LONGBLOB              NULL,
  `payload_sha256`   CHAR(64)              NULL COMMENT 'spots a repeated callback or an unchanged status poll',
  `error_code`       VARCHAR(60)           NULL,
  `error_message`    TEXT                  NULL,
  `is_test`          TINYINT(1)        NOT NULL DEFAULT 0,
  `legacy_source`    VARCHAR(40)           NULL,
  `legacy_id`        BIGINT UNSIGNED       NULL,
  `enc_key_version`  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hitlg_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hitlg_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hitlg_api` (`api_name`, `created_at`),
  KEY `idx_hitlg_correlation` (`correlation_id`),
  KEY `idx_hitlg_payload` (`payload_sha256`),
  CONSTRAINT `fk_hitlg_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] IFFCO Tokio API calls and callbacks; see migrations/010';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Drops only the tables this migration created, and refuses while any of them
-- holds rows. To run it, remove the leading "-- " from each statement line
-- below, run it against the one database you mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '010_create_health_iffco_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_iffco_proposals`)
--            + (SELECT COUNT(*) FROM `health_iffco_kyc`)
--            + (SELECT COUNT(*) FROM `health_iffco_payments`)
--            + (SELECT COUNT(*) FROM `health_iffco_policies`)
--            + (SELECT COUNT(*) FROM `health_iffco_api_logs`);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_010_refused_tables_hold_rows`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_iffco_api_logs`;
-- DROP TABLE IF EXISTS `health_iffco_policies`;
-- DROP TABLE IF EXISTS `health_iffco_payments`;
-- DROP TABLE IF EXISTS `health_iffco_kyc`;
-- DROP TABLE IF EXISTS `health_iffco_proposals`;
-- ═══════════════════════════════════════════════════════════════════════════
