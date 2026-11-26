-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 012 — health purchase data model: ICICI Lombard tables
--
--   health_icici_proposals  proposal: transactionId, ProposalId, premiums, dates
--   health_icici_kyc        CKYC and OVD attempts
--   health_icici_payments   payment state from policy/status, 1:1 with
--                           health_payments
--   health_icici_policies   policy number and status, COI document
--   health_icici_api_logs   every ICICI call, masked and encrypted
--
-- Requires 008.
--
-- WHY THESE TABLES
--   ICICI's hosted gateway returns the buyer straight to the website, so this
--   backend never receives the payment outcome: it only learns it by calling
--   policy/status. health_icici_payments keeps the current answer in one row
--   (icici_payment_status, poll_count) instead of one log row per poll.
--   transactionId is the same from quote to status and is the lookup key.
--
--   Production ICICI runs beside UAT on the same server; health_purchases and
--   health_icici_api_logs carry insurer_env so the two are never mixed.
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
    AND TABLE_NAME IN ('health_icici_proposals', 'health_icici_kyc', 'health_icici_payments',
                       'health_icici_policies', 'health_icici_api_logs')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_012_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_icici_proposals — one per purchase.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_icici_proposals` (
  `id`                 BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`        BIGINT UNSIGNED   NOT NULL,
  `transaction_id`     VARCHAR(60)       NOT NULL COMMENT 'the same from quote to policy/status',
  `proposal_id`        VARCHAR(60)           NULL,
  `request_id`         VARCHAR(60)           NULL,
  `pf_policy_no`       VARCHAR(80)           NULL,
  `base_pf_policy_no`  VARCHAR(80)           NULL,
  `basic_premium`      DECIMAL(12,2)         NULL,
  `gst`                DECIMAL(12,2)         NULL,
  `total_premium`      DECIMAL(12,2)         NULL,
  `emi_amount`         DECIMAL(12,2)         NULL,
  `policy_start_date`  DATE                  NULL,
  `policy_end_date`    DATE                  NULL,
  `payment_url_enc`    VARBINARY(2048)       NULL COMMENT 'ICICI hosted payment page',
  `status`             ENUM('SUBMITTED','FAILED') NOT NULL DEFAULT 'SUBMITTED',
  `status_message`     VARCHAR(500)          NULL,
  `enc_key_version`    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hicp_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hicp_transaction` (`transaction_id`),
  KEY `idx_hicp_proposal_id` (`proposal_id`),
  CONSTRAINT `fk_hicp_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] ICICI Lombard proposal; see migrations/012';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_icici_kyc — one row per CKYC or OVD attempt. OVD proofs are not
--    stored; ovd_reference is ICICI's reference for them.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_icici_kyc` (
  `id`                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`         BIGINT UNSIGNED   NOT NULL,
  `method`              ENUM('CKYC','OVD') NOT NULL,
  `kyc_transaction_id`  VARCHAR(60)           NULL,
  `status`              ENUM('PENDING','VERIFIED','REJECTED','FAILED') NOT NULL DEFAULT 'PENDING',
  `ckyc_number_enc`     VARBINARY(128)        NULL,
  `ovd_reference`       VARCHAR(100)          NULL,
  `status_message`      VARCHAR(500)          NULL,
  `verified_at`         DATETIME(3)           NULL,
  `enc_key_version`     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`          DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`          DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_hick_purchase` (`purchase_id`),
  KEY `idx_hick_transaction` (`kyc_transaction_id`),
  CONSTRAINT `fk_hick_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] ICICI Lombard KYC attempts; see migrations/012';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_icici_payments — one per payment attempt, paired 1:1 with a
--    health_payments row of the same purchase. icici_payment_status is
--    PaymentStatus from policy/status, verbatim (Paid, Pending …).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_icici_payments` (
  `id`                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`           BIGINT UNSIGNED   NOT NULL,
  `health_payment_id`     BIGINT UNSIGNED   NOT NULL,
  `transaction_id`        VARCHAR(60)       NOT NULL,
  `icici_payment_status`  VARCHAR(40)           NULL COMMENT 'policy/status PaymentStatus, verbatim',
  `last_polled_at`        DATETIME(3)           NULL,
  `poll_count`            INT UNSIGNED      NOT NULL DEFAULT 0,
  `created_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hicpy_health_payment` (`health_payment_id`),
  UNIQUE KEY `uk_hicpy_health_payment_purchase` (`health_payment_id`, `purchase_id`),
  UNIQUE KEY `uk_hicpy_transaction` (`transaction_id`),
  KEY `idx_hicpy_purchase` (`purchase_id`),
  CONSTRAINT `fk_hicpy_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hicpy_health_payment`
    FOREIGN KEY (`health_payment_id`, `purchase_id`) REFERENCES `health_payments` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] ICICI Lombard payment state; see migrations/012';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_icici_policies — one per purchase. policy_status and
--    policy_sub_status are ICICI's words, verbatim; status is ours.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_icici_policies` (
  `id`                   BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`          BIGINT UNSIGNED   NOT NULL,
  `policy_no`            VARCHAR(80)           NULL,
  `policy_status`        VARCHAR(40)           NULL COMMENT 'ICICI PolicyStatus, verbatim (DRAFT …)',
  `policy_sub_status`    VARCHAR(60)           NULL,
  `status`               ENUM('PENDING','ISSUED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `start_date`           DATE                  NULL,
  `end_date`             DATE                  NULL,
  `issuance_claimed_at`  DATETIME(3)           NULL,
  `document_id`          BIGINT UNSIGNED       NULL COMMENT 'the COI',
  `created_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hicpl_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hicpl_policy_no` (`policy_no`),
  KEY `idx_hicpl_document` (`document_id`, `purchase_id`),
  CONSTRAINT `fk_hicpl_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hicpl_document`
    FOREIGN KEY (`document_id`, `purchase_id`) REFERENCES `health_policy_documents` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] ICICI Lombard policy; see migrations/012';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_icici_api_logs — same shape as health_niva_api_logs (see 009).
--    Status polls are logged only when the answer changes (payload_sha256).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_icici_api_logs` (
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
  UNIQUE KEY `uk_hiclg_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hiclg_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hiclg_api` (`api_name`, `created_at`),
  KEY `idx_hiclg_correlation` (`correlation_id`),
  KEY `idx_hiclg_payload` (`payload_sha256`),
  CONSTRAINT `fk_hiclg_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] ICICI Lombard API calls; see migrations/012';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Drops only the tables this migration created, and refuses while any of them
-- holds rows. To run it, remove the leading "-- " from each statement line
-- below, run it against the one database you mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '012_create_health_icici_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_icici_proposals`)
--            + (SELECT COUNT(*) FROM `health_icici_kyc`)
--            + (SELECT COUNT(*) FROM `health_icici_payments`)
--            + (SELECT COUNT(*) FROM `health_icici_policies`)
--            + (SELECT COUNT(*) FROM `health_icici_api_logs`);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_012_refused_tables_hold_rows`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_icici_api_logs`;
-- DROP TABLE IF EXISTS `health_icici_policies`;
-- DROP TABLE IF EXISTS `health_icici_payments`;
-- DROP TABLE IF EXISTS `health_icici_kyc`;
-- DROP TABLE IF EXISTS `health_icici_proposals`;
-- ═══════════════════════════════════════════════════════════════════════════
