-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 014 — health purchase data model: Galaxy Health tables
--
--   health_galaxy_proposals  saveFullProposal: proposalNo, requestUID
--   health_galaxy_kyc        document references from uploadDocument
--   health_galaxy_payments   createOrder orders and GHI payment results,
--                            1:1 with health_payments
--   health_galaxy_policies   policy number, dates, document
--   health_galaxy_api_logs   every GHI call and inbound payment capture
--
-- Requires 008.
--
-- WHY THESE TABLES
--   Galaxy orders are kept today as JSON files on the server
--   (data/galaxy-payments/orders/*.json) and every payment redirect and
--   callback as a capture file that is rotated away (…/captures). Neither is a
--   permanent home. health_galaxy_payments replaces the order files and
--   health_galaxy_api_logs (INBOUND rows) replaces the captures, in a later
--   release. Galaxy's key store (data/galaxy-keys) holds key material, not
--   purchase data, and is outside this migration.
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
    AND TABLE_NAME IN ('health_galaxy_proposals', 'health_galaxy_kyc', 'health_galaxy_payments',
                       'health_galaxy_policies', 'health_galaxy_api_logs')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_014_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_galaxy_proposals — one per purchase. request_uid is the GHI
--    requestUID their support asks for.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_galaxy_proposals` (
  `id`              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_id`     BIGINT UNSIGNED  NOT NULL,
  `proposal_no`     VARCHAR(60)          NULL,
  `quote_ref`       VARCHAR(60)          NULL,
  `request_uid`     VARCHAR(80)          NULL COMMENT 'GHI requestUID',
  `product`         VARCHAR(60)          NULL,
  `premium`         DECIMAL(12,2)        NULL,
  `status`          ENUM('SUBMITTED','FAILED') NOT NULL DEFAULT 'SUBMITTED',
  `status_message`  VARCHAR(500)         NULL,
  `created_at`      DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hgxp_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hgxp_proposal_no` (`proposal_no`),
  KEY `idx_hgxp_request_uid` (`request_uid`),
  CONSTRAINT `fk_hgxp_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Galaxy Health proposal; see migrations/014';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_galaxy_kyc — KYC / document state. Only GHI's document ids are
--    kept (document_refs), never the uploaded file.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_galaxy_kyc` (
  `id`              BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_id`     BIGINT UNSIGNED  NOT NULL,
  `status`          ENUM('PENDING','VERIFIED','REJECTED','FAILED') NOT NULL DEFAULT 'PENDING',
  `document_refs`   JSON                 NULL COMMENT 'document type and GHI document id per upload; never the file',
  `status_message`  VARCHAR(500)         NULL,
  `verified_at`     DATETIME(3)          NULL,
  `created_at`      DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_hgxk_purchase` (`purchase_id`),
  CONSTRAINT `fk_hgxk_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Galaxy Health KYC and documents; see migrations/014';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_galaxy_payments — one per createOrder, paired 1:1 with a
--    health_payments row of the same purchase. ghi_status is GHI's word,
--    verbatim (CHARGED, PENDING_VBV, AUTHENTICATION_FAILED,
--    AUTHORIZATION_FAILED). trusted records whether the result was decrypted
--    or came on the token-authenticated callback; an untrusted status is
--    never applied to the purchase.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_galaxy_payments` (
  `id`                 BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`        BIGINT UNSIGNED   NOT NULL,
  `health_payment_id`  BIGINT UNSIGNED   NOT NULL,
  `order_id`           VARCHAR(80)       NOT NULL COMMENT 'createOrder order_id',
  `ghi_payment_id`     VARCHAR(80)           NULL,
  `bank_ref_no`        VARCHAR(80)           NULL,
  `ghi_status`         VARCHAR(40)           NULL COMMENT 'GHI payment status, verbatim',
  `decrypt_scheme`     VARCHAR(30)           NULL COMMENT 'how the result was opened',
  `trusted`            TINYINT(1)        NOT NULL DEFAULT 0,
  `callback_count`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `last_event_at`      DATETIME(3)           NULL,
  `created_at`         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hgxpy_health_payment` (`health_payment_id`),
  UNIQUE KEY `uk_hgxpy_health_payment_purchase` (`health_payment_id`, `purchase_id`),
  UNIQUE KEY `uk_hgxpy_order` (`order_id`),
  KEY `idx_hgxpy_purchase` (`purchase_id`),
  KEY `idx_hgxpy_ghi_payment` (`ghi_payment_id`),
  CONSTRAINT `fk_hgxpy_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hgxpy_health_payment`
    FOREIGN KEY (`health_payment_id`, `purchase_id`) REFERENCES `health_payments` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Galaxy Health orders and payment results; see migrations/014';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_galaxy_policies — one per purchase.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_galaxy_policies` (
  `id`                   BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_id`          BIGINT UNSIGNED  NOT NULL,
  `policy_no`            VARCHAR(80)          NULL,
  `status`               ENUM('PENDING','ISSUED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `issue_date`           DATE                 NULL,
  `start_date`           DATE                 NULL,
  `end_date`             DATE                 NULL,
  `issuance_claimed_at`  DATETIME(3)          NULL,
  `document_id`          BIGINT UNSIGNED      NULL,
  `created_at`           DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hgxpl_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hgxpl_policy_no` (`policy_no`),
  KEY `idx_hgxpl_document` (`document_id`, `purchase_id`),
  CONSTRAINT `fk_hgxpl_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hgxpl_document`
    FOREIGN KEY (`document_id`, `purchase_id`) REFERENCES `health_policy_documents` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Galaxy Health policy; see migrations/014';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_galaxy_api_logs — same shape as health_niva_api_logs (see 009).
--    Inbound payment redirects and callbacks are INBOUND rows with the raw
--    request in request_enc.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_galaxy_api_logs` (
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
  UNIQUE KEY `uk_hgxlg_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hgxlg_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hgxlg_api` (`api_name`, `created_at`),
  KEY `idx_hgxlg_correlation` (`correlation_id`),
  KEY `idx_hgxlg_payload` (`payload_sha256`),
  CONSTRAINT `fk_hgxlg_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Galaxy Health API calls and payment captures; see migrations/014';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Drops only the tables this migration created, and refuses while any of them
-- holds rows. To run it, remove the leading "-- " from each statement line
-- below, run it against the one database you mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '014_create_health_galaxy_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_galaxy_proposals`)
--            + (SELECT COUNT(*) FROM `health_galaxy_kyc`)
--            + (SELECT COUNT(*) FROM `health_galaxy_payments`)
--            + (SELECT COUNT(*) FROM `health_galaxy_policies`)
--            + (SELECT COUNT(*) FROM `health_galaxy_api_logs`);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_014_refused_tables_hold_rows`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_galaxy_api_logs`;
-- DROP TABLE IF EXISTS `health_galaxy_policies`;
-- DROP TABLE IF EXISTS `health_galaxy_payments`;
-- DROP TABLE IF EXISTS `health_galaxy_kyc`;
-- DROP TABLE IF EXISTS `health_galaxy_proposals`;
-- ═══════════════════════════════════════════════════════════════════════════
