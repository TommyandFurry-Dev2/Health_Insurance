-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 009 — health purchase data model: Niva Bupa tables
--
--   health_niva_proposals  UW decision and Data Push, keyed by SOURCING_APPNO
--   health_niva_kyc        KYC attempts (CKYC OTP flow and the hosted page)
--   health_niva_payments   gateway attempts and callbacks, 1:1 with
--                          health_payments
--   health_niva_policies   the real policy number, dates, issuance, document
--   health_niva_api_logs   every Niva Bupa call, masked and encrypted
--
-- Requires 008 (every table here points at health_purchases).
--
-- SOURCING_APPNO IS THE KEY
--   The application number the website generates is sent as SOURCING_APPNO to
--   underwriting and Data Push, as the payment's unqPolicyNumber, and as the
--   KYC application_no. So a payment callback that arrives with no journey or
--   purchase header still finds its purchase through it.
--
-- WHAT IS NOT TOUCHED
--   nivabupa_journey_*, nivabupa_kyc_requests and nivabupa_api_transactions are
--   left exactly as they are and keep receiving rows from today's code. Their
--   rows are copied here when the Niva write path moves (a later release); the
--   old tables are then frozen, never dropped.
--
--   health_niva_kyc is a NEW table beside nivabupa_kyc_requests, not a rename
--   of it. Renaming a table the live KYC step writes to, before the code moves,
--   would make that step depend on a compatibility view (and on every server
--   granting CREATE VIEW). The copy happens at cut-over instead.
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
    AND TABLE_NAME IN ('health_niva_proposals', 'health_niva_kyc', 'health_niva_payments',
                       'health_niva_policies', 'health_niva_api_logs')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_009_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_niva_proposals — one per purchase.
--
--    UW answers { APPLICATION_FORM: { STATUS, SOURCING_APPNO, UWDECISION,
--    UWREMARKMESSAGE, TELEUWREQ, … } }; Data Push answers
--    { Response: { STATUS, POLICY_NO } }. uw_decision and policy_code hold
--    those values verbatim.
--
--    datapush_body_enc keeps the exact Data Push body server-side, so issuance
--    after payment, and My Policies, no longer depend on the buyer's browser
--    still holding it.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_niva_proposals` (
  `id`                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`           BIGINT UNSIGNED   NOT NULL,
  `sourcing_app_no`       VARCHAR(40)       NOT NULL COMMENT 'SOURCING_APPNO = payment unqPolicyNumber = KYC application_no',
  `product_code`          VARCHAR(50)           NULL,
  `product_variant`       VARCHAR(50)           NULL,
  `uw_status`             ENUM('NOT_STARTED','PENDING','APPROVED','REFERRED','DECLINED','FAILED')
                                            NOT NULL DEFAULT 'NOT_STARTED',
  `uw_decision`           VARCHAR(60)           NULL COMMENT 'APPLICATION_FORM.UWDECISION, verbatim',
  `uw_remarks_enc`        BLOB                  NULL COMMENT 'UWREMARKMESSAGE; may describe health conditions',
  `tele_uw_required`      TINYINT(1)            NULL,
  `uw_decided_at`         DATETIME(3)           NULL,
  `datapush_status`       ENUM('NOT_SENT','SUCCESS','FAILED') NOT NULL DEFAULT 'NOT_SENT',
  `policy_code`           VARCHAR(40)           NULL COMMENT 'Data Push Response.POLICY_NO',
  `datapush_message`      VARCHAR(500)          NULL,
  `datapush_body_enc`     LONGBLOB              NULL COMMENT 'the exact Data Push body; issuance and My Policies read it',
  `datapush_attempts`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `datapush_sent_at`      DATETIME(3)           NULL,
  `my_policies_paid_at`   DATETIME(3)           NULL,
  `my_policies_issued_at` DATETIME(3)           NULL,
  `enc_key_version`       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hnbp_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hnbp_app_no` (`sourcing_app_no`),
  KEY `idx_hnbp_policy_code` (`policy_code`),
  CONSTRAINT `fk_hnbp_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Niva Bupa proposal: UW + Data Push; see migrations/009';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_niva_kyc — one row per KYC attempt, either flow. The columns
--    mirror nivabupa_kyc_requests (migrations 003/004), with PAN and mobile
--    moved to encrypted columns plus lookup hashes.
--
--    purchase_id is NULL only for attempts copied from before purchases
--    existed and that cannot be linked; every new attempt has one.
--    (legacy_source, legacy_id) makes that copy safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_niva_kyc` (
  `id`                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`           BIGINT UNSIGNED       NULL,
  `kyc_reference_id`      VARCHAR(40)       NOT NULL COMMENT 'ours; sent to UW and Data Push as X-NivaBupa-Kyc-Request-Id',
  `application_no`        VARCHAR(40)       NOT NULL COMMENT 'SOURCING_APPNO',
  `flow`                  ENUM('CKYC_OTP','HOSTED') NOT NULL,
  `partner_request_id`    VARCHAR(40)           NULL COMMENT 'PartnerRequestId sent to RedirectionLinkEnc',
  `nbhi_reference_no`     VARCHAR(40)           NULL,
  `ckyc_request_id`       VARCHAR(40)           NULL COMMENT 'CYCRequestId',
  `ckyc_transaction_id`   VARCHAR(40)           NULL COMMENT 'CKYCTransactionID',
  `redirect_url_enc`      VARBINARY(1024)       NULL COMMENT 'hosted KYC page, active 72h',
  `status`                ENUM('PENDING','OTP_SENT','LINK_ISSUED','VERIFIED','FAILED') NOT NULL DEFAULT 'PENDING',
  `ckyc_status`           VARCHAR(60)           NULL,
  `status_message`        VARCHAR(255)          NULL,
  `ckyc_number_enc`       VARBINARY(128)        NULL,
  `pan_hash`              CHAR(64)              NULL,
  `pan_enc`               VARBINARY(128)        NULL,
  `mobile_hash`           CHAR(64)              NULL,
  `mobile_enc`            VARBINARY(128)        NULL,
  `verify_attempts`       INT UNSIGNED      NOT NULL DEFAULT 0,
  `verified_response_enc` LONGBLOB              NULL COMMENT 'Niva Bupa verified KYC response; the source of PROPOSER.KYC in Data Push',
  `verified_at`           DATETIME(3)           NULL,
  `legacy_source`         VARCHAR(40)           NULL COMMENT 'nivabupa_kyc_requests | nivabupa_journey_kyc',
  `legacy_id`             BIGINT UNSIGNED       NULL,
  `enc_key_version`       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hnbk_reference` (`kyc_reference_id`),
  UNIQUE KEY `uk_hnbk_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hnbk_purchase` (`purchase_id`),
  KEY `idx_hnbk_application` (`application_no`),
  KEY `idx_hnbk_partner_request` (`partner_request_id`),
  KEY `idx_hnbk_status` (`status`),
  KEY `idx_hnbk_pan` (`pan_hash`),
  CONSTRAINT `fk_hnbk_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Niva Bupa KYC attempts; see migrations/009';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_niva_payments — one per payment attempt, paired 1:1 with a
--    health_payments row of the same purchase.
--
--    unq_policy_number is UNIQUE: the gateway's callback carries nothing but
--    the encrypted returnMessage, and this is how it is matched. raw_callback_body
--    is that ciphertext as received (already encrypted by the gateway); the
--    decrypted message, which carries the buyer's details, is return_message_enc.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_niva_payments` (
  `id`                          BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`                 BIGINT UNSIGNED   NOT NULL,
  `health_payment_id`           BIGINT UNSIGNED   NOT NULL,
  `unq_policy_number`           VARCHAR(80)       NOT NULL COMMENT 'our reference; the callback echoes it as uniqueReferenceId',
  `payment_type`                VARCHAR(60)           NULL,
  `is_juspay`                   VARCHAR(10)           NULL,
  `querystring_enc`             BLOB                  NULL COMMENT 'pipe string before encryption; carries mobile and email',
  `gateway_url`                 VARCHAR(500)          NULL,
  `payment_status_code`         VARCHAR(20)           NULL COMMENT 'M001 = success',
  `payment_status_description`  VARCHAR(40)           NULL,
  `gateway_txn_id`              VARCHAR(100)          NULL COMMENT 'paymentTransactionId',
  `payable_premium`             DECIMAL(12,2)         NULL,
  `transaction_date_time_raw`   VARCHAR(50)           NULL,
  `failed_reason`               VARCHAR(500)          NULL,
  `standing_instruction_taken`  VARCHAR(10)           NULL,
  `standing_instruction_no`     VARCHAR(60)           NULL,
  `payment_gateway_used`        VARCHAR(60)           NULL,
  `return_message_enc`          BLOB                  NULL COMMENT 'the decrypted returnMessage',
  `raw_callback_body`           MEDIUMTEXT            NULL COMMENT 'the encrypted returnMessage exactly as received',
  `callback_count`              SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `callback_received_at`        DATETIME(3)           NULL,
  `enc_key_version`             SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`                  DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`                  DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hnbpy_health_payment` (`health_payment_id`),
  UNIQUE KEY `uk_hnbpy_health_payment_purchase` (`health_payment_id`, `purchase_id`),
  UNIQUE KEY `uk_hnbpy_unq_policy_number` (`unq_policy_number`),
  KEY `idx_hnbpy_purchase` (`purchase_id`),
  KEY `idx_hnbpy_gateway_txn` (`gateway_txn_id`),
  CONSTRAINT `fk_hnbpy_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hnbpy_health_payment`
    FOREIGN KEY (`health_payment_id`, `purchase_id`) REFERENCES `health_payments` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Niva Bupa payment attempts and callbacks; see migrations/009';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_niva_policies — one per purchase.
--
--    policy_number is the real number from proposal-status. It is NEVER our
--    payment reference (nivabupa_journey_policies stored unqPolicyNumber there;
--    the copy moves that value out). policy_code is Data Push's POLICY_NO.
--
--    issuance_claimed_at is set by a conditional UPDATE before Data Push is
--    sent, so a retried or parallel callback issues once.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_niva_policies` (
  `id`                    BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`           BIGINT UNSIGNED   NOT NULL,
  `policy_number`         VARCHAR(80)           NULL COMMENT 'from proposal-status; never our payment reference',
  `policy_code`           VARCHAR(40)           NULL COMMENT 'Data Push POLICY_NO',
  `application_number`    VARCHAR(80)           NULL,
  `status`                ENUM('PENDING','UNDER_REVIEW','ISSUED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `pre_issuance_status`   VARCHAR(80)           NULL,
  `pre_issuance_message`  VARCHAR(500)          NULL,
  `issue_date`            DATE                  NULL,
  `start_date`            DATE                  NULL,
  `end_date`              DATE                  NULL,
  `status_checked_at`     DATETIME(3)           NULL,
  `status_check_count`    INT UNSIGNED      NOT NULL DEFAULT 0,
  `issuance_claimed_at`   DATETIME(3)           NULL,
  `document_id`           BIGINT UNSIGNED       NULL,
  `created_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hnbpl_purchase` (`purchase_id`),
  UNIQUE KEY `uk_hnbpl_policy_number` (`policy_number`),
  KEY `idx_hnbpl_application` (`application_number`),
  KEY `idx_hnbpl_document` (`document_id`, `purchase_id`),
  CONSTRAINT `fk_hnbpl_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_hnbpl_document`
    FOREIGN KEY (`document_id`, `purchase_id`) REFERENCES `health_policy_documents` (`id`, `purchase_id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Niva Bupa policy; see migrations/009';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_niva_api_logs — one row per Niva Bupa call or inbound callback.
--    The same shape for every insurer (009–014).
--
--    outcome is whether the call, or our handling of it, worked; insurer_status
--    is what Niva Bupa said (M001, Success …). Keeping them apart stops a paid
--    callback that we failed to match from reading as a failed payment.
--    purchase_id is NULL for quotes and anything before the purchase exists.
--    request_enc/response_enc hold the exact bytes for the retention period;
--    the masked JSON is kept. (legacy_source, legacy_id) makes the copy from
--    nivabupa_api_transactions safe to re-run.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_niva_api_logs` (
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
  UNIQUE KEY `uk_hnblg_legacy` (`legacy_source`, `legacy_id`),
  KEY `idx_hnblg_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hnblg_api` (`api_name`, `created_at`),
  KEY `idx_hnblg_correlation` (`correlation_id`),
  KEY `idx_hnblg_payload` (`payload_sha256`),
  CONSTRAINT `fk_hnblg_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] Niva Bupa API calls and callbacks; see migrations/009';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Drops only the tables this migration created, and refuses while any of them
-- holds rows. nivabupa_* tables are not touched. To run it, remove the leading
-- "-- " from each statement line below, run it against the one database you
-- mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '009_create_health_niva_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_niva_proposals`)
--            + (SELECT COUNT(*) FROM `health_niva_kyc`)
--            + (SELECT COUNT(*) FROM `health_niva_payments`)
--            + (SELECT COUNT(*) FROM `health_niva_policies`)
--            + (SELECT COUNT(*) FROM `health_niva_api_logs`);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_009_refused_tables_hold_rows`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_niva_api_logs`;
-- DROP TABLE IF EXISTS `health_niva_policies`;
-- DROP TABLE IF EXISTS `health_niva_payments`;
-- DROP TABLE IF EXISTS `health_niva_kyc`;
-- DROP TABLE IF EXISTS `health_niva_proposals`;
-- ═══════════════════════════════════════════════════════════════════════════
