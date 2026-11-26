-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 011 — health purchase data model: Future Generali tables
--
--   health_fg_proposals  proposal: quote uid, preCrtTranId, proposal number, and
--                        the exact proposal payload issuance must replay
--   health_fg_kyc        CKYC create / status attempts
--   health_fg_payments   gateway attempts and callbacks (TransactionID,
--                        WS_P_ID, PGID), 1:1 with health_payments
--   health_fg_policies   policy number, issuance claim, document
--   health_fg_api_logs   every FG call, masked and encrypted
--
-- Requires 008.
--
-- WHY THESE TABLES
--   Today FG's payment token, the WS_P_ID → token map and the proposal held
--   for issuance live in process memory (services/fgPayment.service.js), so a
--   restart between payment and issuance loses them. proposal_request_enc,
--   result_token and ws_p_id give each a durable home. Nothing reads these
--   tables yet; the FG write path moves in a later release.
--
-- (fg_* without the health_ prefix belongs to the Laravel pet app:
--  fg_pet_breeds, fg_premium_rates, fg_category_mapping, fg_weight.)
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
    AND TABLE_NAME IN ('health_fg_proposals', 'health_fg_kyc', 'health_fg_payments',
                       'health_fg_policies', 'health_fg_api_logs')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_011_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_fg_proposals — one per purchase. proposal_request_enc is the
--    payload FG validated; issuance after payment must send the same one.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_fg_proposals` (
  `id`                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`           BIGINT UNSIGNED   NOT NULL,
  `quote_uid`             VARCHAR(60)           NULL COMMENT 'policy.uid from the quote',
  `pre_crt_tran_id`       VARCHAR(60)           NULL,
  `proposal_no`           VARCHAR(60)           NULL,
  `product_code`          VARCHAR(40)           NULL COMMENT 'Health Absolute …',
  `client_id`             VARCHAR(60)           NULL,
  `receipt_no`            VARCHAR(60)           NULL,
  `win_no`                VARCHAR(60)           NULL,
  `application_no`        VARCHAR(60)           NULL,
  `proposal_request_enc`  LONGBLOB              NULL COMMENT 'the payload FG validated; issuance replays it',
  `uw_check_result`       VARCHAR(255)          NULL COMMENT 'our Health Absolute UW rules outcome',
  `status`                ENUM('SUBMITTED','ACCEPTED','REJECTED','FAILED') NOT NULL DEFAULT 'SUBMITTED',
  `status_message`        VARCHAR(500)          NULL,
  `enc_key_version`       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hfgp_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hfgp_pre_crt_tran` (`pre_crt_tran_id`),
  UNIQUE KEY `uk_hfgp_proposal_no` (`proposal_no`),
  KEY `idx_hfgp_quote_uid` (`quote_uid`),
  CONSTRAINT `fk_hfgp_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Future Generali proposal; see migrations/011';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_fg_kyc — one row per CKYC create / status attempt.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_fg_kyc` (
  `id`                   BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`          BIGINT UNSIGNED   NOT NULL,
  `req_id`               VARCHAR(60)           NULL,
  `fg_kyc_proposal_id`   VARCHAR(60)           NULL COMMENT 'FG CKYC proposalId',
  `status`               ENUM('PENDING','VERIFIED','REJECTED','FAILED') NOT NULL DEFAULT 'PENDING',
  `ckyc_number_enc`      VARBINARY(128)        NULL,
  `kyc_url_enc`          VARBINARY(2048)       NULL COMMENT 'FG document-upload link',
  `status_message`       VARCHAR(500)          NULL,
  `verified_at`          DATETIME(3)           NULL,
  `enc_key_version`      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_hfgk_purchase` (`purchase_id`),
  KEY `idx_hfgk_req` (`req_id`),
  KEY `idx_hfgk_kyc_proposal` (`fg_kyc_proposal_id`),
  CONSTRAINT `fk_hfgk_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Future Generali KYC attempts; see migrations/011';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_fg_payments — one per payment attempt, paired 1:1 with a
--    health_payments row of the same purchase.
--
--    transaction_id is the TransactionID we send (FG echo it as TID);
--    ws_p_id (WS_P_ID → UniqueTranKey) and pgid (PGID → TranRefNo) arrive on
--    the callback and are what issuance needs. ws_p_id is UNIQUE, so a repeated
--    callback collapses onto the first. result_token is the opaque reference
--    the return page reads the result by. reconcile_status records FG's
--    FetchTRNDetails answer: the callback's DES key is printed in FG's kit, so
--    a success is only trusted once FG confirm it.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_fg_payments` (
  `id`                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`           BIGINT UNSIGNED   NOT NULL,
  `health_payment_id`     BIGINT UNSIGNED   NOT NULL,
  `transaction_id`        VARCHAR(40)       NOT NULL COMMENT 'TransactionID we send; FG echo it as TID',
  `ws_p_id`               VARCHAR(60)           NULL COMMENT 'WS_P_ID, goes to UniqueTranKey',
  `pgid`                  VARCHAR(60)           NULL COMMENT 'PGID, goes to TranRefNo',
  `result_token`          CHAR(32)              NULL COMMENT 'opaque reference the return page reads',
  `callback_status`       VARCHAR(40)           NULL,
  `callback_premium`      DECIMAL(12,2)         NULL,
  `callback_count`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `callback_received_at`  DATETIME(3)           NULL,
  `reconcile_status`      ENUM('NOT_CHECKED','CONFIRMED','MISMATCH','ERROR') NOT NULL DEFAULT 'NOT_CHECKED',
  `reconciled_at`         DATETIME(3)           NULL,
  `created_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hfgpy_health_payment` (`health_payment_id`),
  UNIQUE KEY `uk_hfgpy_health_payment_purchase` (`health_payment_id`, `purchase_id`),
  UNIQUE KEY `uk_hfgpy_transaction` (`transaction_id`),
  UNIQUE KEY `uk_hfgpy_ws_p_id` (`ws_p_id`),
  UNIQUE KEY `uk_hfgpy_result_token` (`result_token`),
  KEY `idx_hfgpy_purchase` (`purchase_id`),
  KEY `idx_hfgpy_pgid` (`pgid`),
  CONSTRAINT `fk_hfgpy_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hfgpy_health_payment`
    FOREIGN KEY (`health_payment_id`, `purchase_id`) REFERENCES `health_payments` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Future Generali payment attempts and callbacks; see migrations/011';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_fg_policies — one per purchase. issuance_claimed_at is set by a
--    conditional UPDATE before FG's issue call, so two callbacks for one
--    payment issue one policy.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_fg_policies` (
  `id`                   BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`          BIGINT UNSIGNED   NOT NULL,
  `policy_no`            VARCHAR(80)           NULL,
  `proposal_no`          VARCHAR(60)           NULL,
  `receipt_no`           VARCHAR(60)           NULL,
  `status`               ENUM('PENDING','ISSUED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `status_message`       VARCHAR(500)          NULL,
  `start_date`           DATE                  NULL,
  `end_date`             DATE                  NULL,
  `issued_at`            DATETIME(3)           NULL,
  `issuance_claimed_at`  DATETIME(3)           NULL,
  `document_id`          BIGINT UNSIGNED       NULL,
  `created_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`           DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hfgpl_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hfgpl_policy_no` (`policy_no`),
  KEY `idx_hfgpl_proposal_no` (`proposal_no`),
  KEY `idx_hfgpl_document` (`document_id`, `purchase_id`),
  CONSTRAINT `fk_hfgpl_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hfgpl_document`
    FOREIGN KEY (`document_id`, `purchase_id`) REFERENCES `health_policy_documents` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Future Generali policy; see migrations/011';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_fg_api_logs — same shape as health_niva_api_logs (see 009).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_fg_api_logs` (
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
  UNIQUE KEY `uk_hfglg_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hfglg_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hfglg_api` (`api_name`, `created_at`),
  KEY `idx_hfglg_correlation` (`correlation_id`),
  KEY `idx_hfglg_payload` (`payload_sha256`),
  CONSTRAINT `fk_hfglg_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Future Generali API calls and callbacks; see migrations/011';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Drops only the tables this migration created, and refuses while any of them
-- holds rows. To run it, remove the leading "-- " from each statement line
-- below, run it against the one database you mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '011_create_health_fg_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_fg_proposals`)
--            + (SELECT COUNT(*) FROM `health_fg_kyc`)
--            + (SELECT COUNT(*) FROM `health_fg_payments`)
--            + (SELECT COUNT(*) FROM `health_fg_policies`)
--            + (SELECT COUNT(*) FROM `health_fg_api_logs`);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_011_refused_tables_hold_rows`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_fg_api_logs`;
-- DROP TABLE IF EXISTS `health_fg_policies`;
-- DROP TABLE IF EXISTS `health_fg_payments`;
-- DROP TABLE IF EXISTS `health_fg_kyc`;
-- DROP TABLE IF EXISTS `health_fg_proposals`;
-- ═══════════════════════════════════════════════════════════════════════════
