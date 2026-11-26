-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 013 — health purchase data model: Chola MS tables
--
--   health_chola_proposals  EXISTING (migration 005). Gains five nullable
--                           columns; nothing else about it changes
--   health_chola_kyc        CKYC verify / query attempts
--   health_chola_payments   every Chola payment, whatever the channel
--                           (Freecharge, Chola's hosted page, APD deposit),
--                           1:1 with health_payments
--   health_chola_policies   the issued policy, its schedule and document
--   health_chola_api_logs   every Chola call, masked and encrypted
--
-- Requires 005 and 008.
--
-- WHY health_chola_proposals IS EXTENDED, NOT REPLACED OR RENAMED
--   It was first created by the standalone integrations service (its own
--   migration 002) and the two services can share it. Its UNIQUE key on
--   gencon_proposal_number is the claim that refuses a second PolicyGeneration
--   for one proposal, across both services. PolicyGeneration is not
--   idempotent, and under APD a second success debits the deposit twice. So the
--   table keeps its name, its rows and every existing column; this migration
--   only ADDS nullable columns, each guarded so a re-run is harmless.
--   Both services' INSERTs name their columns, so new nullable columns cannot
--   break them.
--
--   For the later code change, not this migration: when ProposalSave starts
--   writing a row here before PolicyGeneration, the claim logic in
--   repositories/chola.repository.js must treat that pre-claim state as
--   claimable, or the first PolicyGeneration would be refused.
--
-- WHAT ELSE IS NOT TOUCHED
--   health_chola_policy_generation_logs stays the exact-bytes PolicyGeneration
--   evidence; health_chola_api_logs.pg_log_id points at its rows, deliberately
--   without a foreign key, because the other service may own that table.
--   health_chola_freecharge_payments (007) is left as it is and keeps receiving
--   rows from today's code; health_chola_payments is a new table its rows are
--   copied into at cut-over (legacy_id), not a rename of it.
--
-- Same conventions, guard and marker as 008. Rollback at the end of the file.
-- Additive only: no existing column, key or row is changed.
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

-- ── Guard: stop if a name is taken by a table this migration did not create ─
SET @taken := (
  SELECT GROUP_CONCAT(TABLE_NAME) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('health_chola_kyc', 'health_chola_payments',
                       'health_chola_policies', 'health_chola_api_logs')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_013_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_chola_proposals — five nullable columns, each added only if it is
--    not already there (MySQL has no ADD COLUMN IF NOT EXISTS).
-- ───────────────────────────────────────────────────────────────────────────

-- ── purchase_id ────────────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND COLUMN_NAME = 'purchase_id'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD COLUMN `purchase_id` BIGINT UNSIGNED NULL
     COMMENT ''health_purchases.id; NULL for rows written before purchases existed'' AFTER `id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── app_ref_no ─────────────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND COLUMN_NAME = 'app_ref_no'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD COLUMN `app_ref_no` VARCHAR(40) NULL
     COMMENT ''appRefNo used by CKYC and ProposalSave'' AFTER `gencon_proposal_number`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── proposal_premium ───────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND COLUMN_NAME = 'proposal_premium'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD COLUMN `proposal_premium` DECIMAL(12,2) NULL
     COMMENT ''the premium ProposalSave re-priced to'' AFTER `amount`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── proposal_saved_at ──────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND COLUMN_NAME = 'proposal_saved_at'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD COLUMN `proposal_saved_at` DATETIME(3) NULL AFTER `proposal_premium`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── quote_ref ──────────────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND COLUMN_NAME = 'quote_ref'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD COLUMN `quote_ref` VARCHAR(60) NULL AFTER `proposal_saved_at`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── index on purchase_id ───────────────────────────────────────────────────
SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND INDEX_NAME = 'idx_health_chola_proposals_purchase'
);
SET @sql := IF(@index_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD KEY `idx_health_chola_proposals_purchase` (`purchase_id`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── foreign key purchase_id → health_purchases ─────────────────────────────
-- NULL in every existing row, so adding it checks nothing that can fail.
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'health_chola_proposals'
    AND CONSTRAINT_NAME = 'fk_hch_proposals_purchase'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `health_chola_proposals`
     ADD CONSTRAINT `fk_hch_proposals_purchase`
     FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
     ON DELETE RESTRICT',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_chola_kyc — one row per CKYC verify or query attempt.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_chola_kyc` (
  `id`                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`       BIGINT UNSIGNED   NOT NULL,
  `app_ref_no`        VARCHAR(40)           NULL,
  `method`            ENUM('VERIFY','QUERY') NOT NULL,
  `status`            ENUM('PENDING','VERIFIED','REJECTED','FAILED') NOT NULL DEFAULT 'PENDING',
  `ckyc_number_enc`   VARBINARY(128)        NULL,
  `redirect_url_enc`  VARBINARY(2048)       NULL COMMENT 'Chola CKYC redirect, when one is issued',
  `status_message`    VARCHAR(500)          NULL,
  `verified_at`       DATETIME(3)           NULL,
  `enc_key_version`   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_hchk_purchase` (`purchase_id`),
  KEY `idx_hchk_app_ref` (`app_ref_no`),
  CONSTRAINT `fk_hchk_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Chola MS KYC attempts; see migrations/013';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_chola_payments — one per payment attempt, paired 1:1 with a
--    health_payments row of the same purchase, for every channel:
--      FREECHARGE  FCPG checkout and callback (the columns of
--                  health_chola_freecharge_payments, with the raw callback and
--                  FCPG answers encrypted)
--      CHOLA_PG    Chola's own hosted payment page (payment_url_enc, payzapp_id)
--      APD         NovaCred's advance-premium deposit (UAT only)
--    merchant_txn_id and return_token are UNIQUE, as in 007; they are NULL for
--    the channels that have none.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_chola_payments` (
  `id`                      BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`             BIGINT UNSIGNED   NOT NULL,
  `health_payment_id`       BIGINT UNSIGNED   NOT NULL,
  `payment_channel`         ENUM('FREECHARGE','CHOLA_PG','APD') NOT NULL,
  `gencon_proposal_number`  VARCHAR(30)       NOT NULL,
  `product`                 VARCHAR(20)       NOT NULL,
  `merchant_txn_id`         VARCHAR(30)           NULL COMMENT 'ours, sent to FCPG',
  `return_token`            CHAR(32)              NULL COMMENT 'opaque reference the return page reads',
  `amount`                  DECIMAL(12,2)     NOT NULL,
  `currency`                CHAR(3)           NOT NULL DEFAULT 'INR',
  `status`                  ENUM('INITIATED','PENDING','SUCCESS','FAILED','NEEDS_REVIEW') NOT NULL DEFAULT 'INITIATED',
  `status_code`             VARCHAR(20)           NULL,
  `status_message`          VARCHAR(1000)         NULL,
  `txn_reference_id`        VARCHAR(64)           NULL COMMENT 'FCPG transaction id: PGID on PolicyGeneration, the refund key',
  `paid_amount`             DECIMAL(12,2)         NULL,
  `txn_mode`                VARCHAR(20)           NULL,
  `txn_sub_mode`            VARCHAR(20)           NULL,
  `payment_url_enc`         VARBINARY(2048)       NULL COMMENT 'Chola hosted payment page (CHOLA_PG)',
  `payzapp_id`              VARCHAR(64)           NULL,
  `callback_count`          INT UNSIGNED      NOT NULL DEFAULT 0,
  `callback_body_enc`       LONGBLOB              NULL COMMENT 'the callback exactly as received',
  `callback_decrypted_enc`  LONGBLOB              NULL,
  `status_response_enc`     LONGBLOB              NULL COMMENT 'the last txn/status answer',
  `last_checked_at`         DATETIME(3)           NULL,
  `issue_status`            ENUM('IN_PROGRESS','POLICY_ISSUED','ISSUE_FAILED','NEEDS_REVIEW') NULL,
  `gencon_policy_number`    VARCHAR(40)           NULL,
  `issue_message`           TEXT                  NULL,
  `refund_txn_id`           VARCHAR(30)           NULL,
  `refund_status_code`      VARCHAR(20)           NULL,
  `refund_status_message`   VARCHAR(1000)         NULL,
  `refund_response_enc`     LONGBLOB              NULL,
  `legacy_id`               BIGINT UNSIGNED       NULL COMMENT 'health_chola_freecharge_payments.id it was copied from',
  `enc_key_version`         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`              DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`              DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hchpy_health_payment` (`health_payment_id`),
  UNIQUE KEY `uk_hchpy_health_payment_purchase` (`health_payment_id`, `purchase_id`),
  UNIQUE KEY `uk_hchpy_merchant_txn` (`merchant_txn_id`),
  UNIQUE KEY `uk_hchpy_return_token` (`return_token`),
  UNIQUE KEY `uk_hchpy_legacy` (`legacy_id`),
  KEY `idx_hchpy_purchase` (`purchase_id`),
  KEY `idx_hchpy_proposal` (`gencon_proposal_number`),
  KEY `idx_hchpy_txn_reference` (`txn_reference_id`),
  KEY `idx_hchpy_status` (`status`),
  CONSTRAINT `fk_hchpy_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hchpy_health_payment`
    FOREIGN KEY (`health_payment_id`, `purchase_id`) REFERENCES `health_payments` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Chola MS payments, every channel; see migrations/013';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_chola_policies — one per purchase. The policy columns of
--    health_chola_proposals (gencon_policy_number, schedule_url, cis_url) are
--    copied here at cut-over; that table keeps them for the other service.
--    The PDF itself goes to health_policy_documents, where a failed fetch is
--    retried instead of lost (UAT schedule links point at Chola-internal
--    addresses and time out).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_chola_policies` (
  `id`                      BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`             BIGINT UNSIGNED   NOT NULL,
  `gencon_policy_number`    VARCHAR(40)           NULL,
  `gencon_proposal_number`  VARCHAR(30)       NOT NULL,
  `issued_via`              ENUM('WEBSITE','OPS','FREECHARGE','APD') NULL,
  `status`                  ENUM('PENDING','ISSUED','FAILED','NEEDS_REVIEW') NOT NULL DEFAULT 'PENDING',
  `status_message`          VARCHAR(500)          NULL,
  `schedule_url_enc`        VARBINARY(2048)       NULL,
  `cis_url_enc`             VARBINARY(2048)       NULL,
  `start_date`              DATE                  NULL,
  `end_date`                DATE                  NULL,
  `issued_at`               DATETIME(3)           NULL,
  `issuance_claimed_at`     DATETIME(3)           NULL,
  `document_id`             BIGINT UNSIGNED       NULL,
  `enc_key_version`         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`              DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`              DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hchpl_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hchpl_policy_number` (`gencon_policy_number`),
  KEY `idx_hchpl_proposal` (`gencon_proposal_number`),
  KEY `idx_hchpl_document` (`document_id`, `purchase_id`),
  CONSTRAINT `fk_hchpl_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hchpl_document`
    FOREIGN KEY (`document_id`, `purchase_id`) REFERENCES `health_policy_documents` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Chola MS policy; see migrations/013';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_chola_api_logs — same shape as health_niva_api_logs (see 009),
--    plus pg_log_id for PolicyGeneration calls (no foreign key; see header).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_chola_api_logs` (
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
  `pg_log_id`        BIGINT UNSIGNED       NULL COMMENT 'health_chola_policy_generation_logs.id for PolicyGeneration calls',
  `error_code`       VARCHAR(60)           NULL,
  `error_message`    TEXT                  NULL,
  `is_test`          TINYINT(1)        NOT NULL DEFAULT 0,
  `legacy_source`    VARCHAR(40)           NULL,
  `legacy_id`        BIGINT UNSIGNED       NULL,
  `enc_key_version`  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hchlg_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hchlg_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hchlg_api` (`api_name`, `created_at`),
  KEY `idx_hchlg_correlation` (`correlation_id`),
  KEY `idx_hchlg_payload` (`payload_sha256`),
  KEY `idx_hchlg_pg_log` (`pg_log_id`),
  CONSTRAINT `fk_hchlg_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Chola MS API calls and callbacks; see migrations/013';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Drops the four tables this migration created and removes the five columns it
-- added to health_chola_proposals. Refuses while any new table holds rows or
-- any added column holds a value. Existing health_chola_proposals rows and
-- columns are never touched. To run it, remove the leading "-- " from each
-- statement line below, run it against the one database you mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '013_create_health_chola_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_chola_kyc`)
--            + (SELECT COUNT(*) FROM `health_chola_payments`)
--            + (SELECT COUNT(*) FROM `health_chola_policies`)
--            + (SELECT COUNT(*) FROM `health_chola_api_logs`)
--            + (SELECT COUNT(*) FROM `health_chola_proposals`
--               WHERE `purchase_id` IS NOT NULL OR `app_ref_no` IS NOT NULL
--                  OR `proposal_premium` IS NOT NULL OR `proposal_saved_at` IS NOT NULL
--                  OR `quote_ref` IS NOT NULL);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_013_refused_data_present`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_chola_api_logs`;
-- DROP TABLE IF EXISTS `health_chola_policies`;
-- DROP TABLE IF EXISTS `health_chola_payments`;
-- DROP TABLE IF EXISTS `health_chola_kyc`;
-- ALTER TABLE `health_chola_proposals` DROP FOREIGN KEY `fk_hch_proposals_purchase`;
-- ALTER TABLE `health_chola_proposals`
--   DROP COLUMN `quote_ref`,
--   DROP COLUMN `proposal_saved_at`,
--   DROP COLUMN `proposal_premium`,
--   DROP COLUMN `app_ref_no`,
--   DROP COLUMN `purchase_id`;
-- ═══════════════════════════════════════════════════════════════════════════
