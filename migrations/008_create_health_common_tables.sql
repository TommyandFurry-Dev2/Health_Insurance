-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 008 — health purchase data model: the common tables
--
-- The hybrid model. These six tables give ONE view of every health purchase
-- across all insurers; migrations 009–014 add a dedicated set of five tables
-- per insurer. Every table in both sets carries the same Purchase ID.
--
--   health_customers         the proposer / policyholder
--   health_purchases         one row per purchase attempt with one insurer.
--                            purchase_ref is THE Purchase ID: a ULID generated
--                            by the backend and exchanged as X-Purchase-Id
--   health_purchase_members  insured members, the nominee and the appointee
--   health_payments          one row per payment attempt, any gateway
--   health_purchase_events   append-only status history
--   health_policy_documents  policy schedule / COI / CIS, encrypted bytes
--
-- WHAT WRITES HERE
--   Nothing yet. This migration only creates tables. No controller, service or
--   API flow changes with it, and every existing table is left exactly as it
--   is. Each insurer's write path moves onto these tables in a later release.
--
-- CONVENTIONS (008–014)
--   *_enc     AES-256-GCM ciphertext written by the application. The key never
--             reaches the database; enc_key_version records which key wrote it.
--   *_hash    HMAC-SHA256 (hex) of the normalised value: lookup and
--             de-duplication without decrypting.
--   *_masked  display form for ops screens (XXXXX1234X, 98XXXXXX10).
--   Money is DECIMAL(12,2) in INR; times are DATETIME(3).
--   Foreign keys are ON DELETE RESTRICT: an insurance record must outlive
--   anything that tries to delete what it points at.
--   Status columns only ever move forward; the application changes them with
--   compare-and-set UPDATEs and records every change in health_purchase_events.
--
-- RE-RUNNABLE, BUT NEVER SILENTLY SKIPPED
--   Like every migration here, a partially applied file can be re-run: each
--   table is CREATE TABLE IF NOT EXISTS. But IF NOT EXISTS would also skip a
--   table that ANOTHER application created under the same name (this schema is
--   shared with the Laravel host app), and the code would later write to a
--   table of the wrong shape. So every table created here carries the marker
--   [health-hybrid] in its comment, and the guard below stops the migration if
--   one of these names is already taken by a table without that marker. The
--   error then reads: Table '<db>.migration_008_stopped_a_table_name_is_taken'
--   doesn't exist.
--
-- ROLLBACK
--   Manual, at the end of this file, commented out so scripts/migrate.js never
--   runs it. Roll back 014 … 009 first: their foreign keys point here.
--
-- Additive only: no existing table is touched.
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

-- ── Guard: stop if a name is taken by a table this migration did not create ─
SET @taken := (
  SELECT GROUP_CONCAT(TABLE_NAME) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('health_customers', 'health_purchases', 'health_purchase_members',
                       'health_payments', 'health_purchase_events', 'health_policy_documents')
    AND TABLE_COMMENT NOT LIKE '%[health-hybrid]%'
);
SET @sql := IF(@taken IS NULL, 'DO 0',
  'SELECT 1 FROM `migration_008_stopped_a_table_name_is_taken`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. health_customers — the proposer / policyholder.
--
--    One row per PAN (uk_hcus_pan; NULLs allowed until a PAN is known). Mobile
--    is indexed but NOT unique: an agent buys for many customers from their own
--    number, and a family shares one. No foreign key into the host app's users
--    table: a health buyer is not a website account.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_customers` (
  `id`               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `customer_ref`     CHAR(26)          NOT NULL COMMENT 'ULID, safe to show outside the database',
  `pan_hash`         CHAR(64)              NULL,
  `mobile_hash`      CHAR(64)              NULL,
  `email_hash`       CHAR(64)              NULL,
  `pan_enc`          VARBINARY(128)        NULL,
  `mobile_enc`       VARBINARY(128)        NULL,
  `email_enc`        VARBINARY(400)        NULL,
  `full_name_enc`    VARBINARY(400)        NULL,
  `dob_enc`          VARBINARY(128)        NULL,
  `address_enc`      BLOB                  NULL,
  `pan_masked`       VARCHAR(10)           NULL,
  `mobile_masked`    VARCHAR(15)           NULL,
  `name_masked`      VARCHAR(120)          NULL,
  `gender`           CHAR(1)               NULL,
  `pincode`          VARCHAR(10)           NULL,
  `city`             VARCHAR(100)          NULL,
  `state`            VARCHAR(100)          NULL,
  `enc_key_version`  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hcus_ref` (`customer_ref`),
  UNIQUE KEY `uk_hcus_pan` (`pan_hash`),
  KEY `idx_hcus_mobile` (`mobile_hash`),
  KEY `idx_hcus_email` (`email_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] proposer / policyholder; see migrations/008';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. health_purchases — the hub. One row per purchase attempt with one
--    insurer, created at the first proposal-stage call (KYC or proposal), not
--    at quote: the search page quotes every insurer at once.
--
--    proposal_number / application_number / policy_number and the policy dates
--    are the unified view. The insurer's own table is their source; both are
--    written in the same transaction, so they cannot disagree.
--
--    insurer_env: production ICICI runs beside UAT on the same server, so a
--    production and a UAT purchase can land in one database.
--
--    legacy_ref is UNIQUE so the recovery scripts can be re-run without
--    creating a purchase twice.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_purchases` (
  `id`                 BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_ref`       CHAR(26)         NOT NULL COMMENT 'the Purchase ID (ULID), sent as X-Purchase-Id',
  `customer_id`        BIGINT UNSIGNED      NULL COMMENT 'set once the proposer is known',
  `insurer_code`       ENUM('NIVA_BUPA','IFFCO_TOKIO','FUTURE_GENERALI',
                            'ICICI_LOMBARD','CHOLA_MS','GALAXY') NOT NULL,
  `insurer_env`        ENUM('UAT','PROD')   NOT NULL,
  `product_code`       VARCHAR(50)          NULL,
  `product_name`       VARCHAR(150)         NULL,
  `plan_variant`       VARCHAR(100)         NULL,
  `cover_type`         ENUM('INDIVIDUAL','FLOATER') NULL,
  `sum_insured`        DECIMAL(14,2)        NULL,
  `tenure_years`       TINYINT UNSIGNED     NULL,
  `payment_frequency`  VARCHAR(20)          NULL,
  `adults`             TINYINT UNSIGNED     NULL,
  `children`           TINYINT UNSIGNED     NULL,
  `quoted_premium`     DECIMAL(12,2)        NULL COMMENT 'shown when the plan was chosen',
  `final_premium`      DECIMAL(12,2)        NULL COMMENT 'charged by the insurer, GST included',
  `gst_amount`         DECIMAL(12,2)        NULL,
  `proposal_number`    VARCHAR(80)          NULL,
  `application_number` VARCHAR(80)          NULL,
  `policy_number`      VARCHAR(80)          NULL,
  `policy_issue_date`  DATE                 NULL,
  `policy_start_date`  DATE                 NULL,
  `policy_end_date`    DATE                 NULL,
  `status`             ENUM('STARTED','KYC_PENDING','KYC_DONE','PROPOSAL_SUBMITTED','UW_REFERRED',
                            'PAYMENT_PENDING','PAID','ISSUED','DECLINED','PAYMENT_FAILED',
                            'ISSUANCE_FAILED','ABANDONED','CANCELLED') NOT NULL DEFAULT 'STARTED',
  `kyc_status`         ENUM('NOT_STARTED','PENDING','VERIFIED','REJECTED','FAILED')
                                            NOT NULL DEFAULT 'NOT_STARTED',
  `proposal_status`    ENUM('NOT_STARTED','SUBMITTED','ACCEPTED','REFERRED','DECLINED','FAILED')
                                            NOT NULL DEFAULT 'NOT_STARTED',
  `payment_status`     ENUM('NOT_STARTED','INITIATED','PENDING','SUCCESS','FAILED','REFUNDED')
                                            NOT NULL DEFAULT 'NOT_STARTED',
  `policy_status`      ENUM('NOT_ISSUED','PENDING','ISSUED','REJECTED','CANCELLED')
                                            NOT NULL DEFAULT 'NOT_ISSUED',
  `needs_review`       TINYINT(1)       NOT NULL DEFAULT 0,
  `review_reason`      VARCHAR(255)         NULL,
  `channel`            ENUM('D2C','AGENT','OPS') NULL,
  `agent_code`         VARCHAR(50)          NULL,
  `frontend_app`       VARCHAR(20)          NULL COMMENT 'CRA | NEW_UI | OPS',
  `source`             ENUM('LIVE','RECOVERED') NOT NULL DEFAULT 'LIVE',
  `legacy_ref`         VARCHAR(120)         NULL COMMENT 'where a recovered purchase came from',
  `version`            INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'optimistic lock',
  `created_at`         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `completed_at`       DATETIME(3)          NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hpur_ref` (`purchase_ref`),
  UNIQUE KEY `uk_hpur_legacy` (`legacy_ref`),
  KEY `idx_hpur_customer` (`customer_id`),
  KEY `idx_hpur_insurer_status` (`insurer_code`, `status`, `created_at`),
  KEY `idx_hpur_policy_no` (`policy_number`),
  KEY `idx_hpur_application` (`application_number`),
  KEY `idx_hpur_proposal` (`proposal_number`),
  KEY `idx_hpur_review` (`needs_review`, `created_at`),
  CONSTRAINT `fk_hpur_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `health_customers` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] one row per purchase attempt; purchase_ref is the Purchase ID; see migrations/008';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. health_purchase_members — the people on the policy: every insured member,
--    the nominee and (for a minor nominee) the appointee. Medical answers,
--    height and weight are health data and live only in medical_enc.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_purchase_members` (
  `id`               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`      BIGINT UNSIGNED   NOT NULL,
  `role`             ENUM('INSURED','NOMINEE','APPOINTEE') NOT NULL,
  `member_seq`       SMALLINT UNSIGNED NOT NULL,
  `relation`         VARCHAR(30)           NULL COMMENT 'SELF, SPOUSE, SON ... (one vocabulary for all insurers)',
  `insurer_relation` VARCHAR(30)           NULL COMMENT 'the code the insurer was sent',
  `full_name_enc`    VARBINARY(400)        NULL,
  `name_masked`      VARCHAR(120)          NULL,
  `dob_enc`          VARBINARY(128)        NULL,
  `age_at_purchase`  TINYINT UNSIGNED      NULL,
  `gender`           CHAR(1)               NULL,
  `occupation`       VARCHAR(100)          NULL,
  `nominee_share`    DECIMAL(5,2)          NULL,
  `medical_enc`      BLOB                  NULL COMMENT 'height, weight, PED and declarations (JSON)',
  `uw_loading_pct`   DECIMAL(6,2)          NULL,
  `enc_key_version`  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hpm_seq` (`purchase_id`, `role`, `member_seq`),
  CONSTRAINT `fk_hpm_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] insured members, nominee, appointee; see migrations/008';


-- ───────────────────────────────────────────────────────────────────────────
-- 4. health_payments — one row per payment attempt, whatever the insurer or
--    gateway. Each insurer's *_payments row points at exactly one of these.
--
--    uk_hpay_ref: our reference to the gateway (Niva unqPolicyNumber, FG
--    TransactionID, Freecharge merchantTxnId …) is unique per insurer.
--    uk_hpay_gateway_txn: a replayed callback cannot add a second row for the
--    same gateway transaction.
--    uk_hpay_id_purchase: lets each insurer's *_payments table reference
--    (id, purchase_id) together, so an insurer row can never point at another
--    purchase's payment.
--
--    A second SUCCESS for the same purchase (a double payment) is allowed and
--    flagged for refund by the application; a constraint must never reject a
--    record of money that moved.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_payments` (
  `id`                  BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`         BIGINT UNSIGNED   NOT NULL,
  `insurer_code`        ENUM('NIVA_BUPA','IFFCO_TOKIO','FUTURE_GENERALI',
                             'ICICI_LOMBARD','CHOLA_MS','GALAXY') NOT NULL,
  `payment_ref`         VARCHAR(40)       NOT NULL COMMENT 'our reference to the gateway',
  `attempt_no`          SMALLINT UNSIGNED NOT NULL,
  `gateway`             VARCHAR(30)       NOT NULL COMMENT 'NIVA_PG | FG_PG | ITGI_PG | ICICI_PG | FREECHARGE | CHOLA_PG | CHOLA_APD | GALAXY_PG',
  `amount`              DECIMAL(12,2)     NOT NULL,
  `currency`            CHAR(3)           NOT NULL DEFAULT 'INR',
  `paid_amount`         DECIMAL(12,2)         NULL,
  `status`              ENUM('INITIATED','PENDING','SUCCESS','FAILED','CANCELLED',
                             'REFUND_PENDING','REFUNDED','NEEDS_REVIEW') NOT NULL DEFAULT 'INITIATED',
  `gateway_txn_id`      VARCHAR(100)          NULL COMMENT 'PGID, paymentTransactionId, FCPG txnReferenceId, GHI payment_id',
  `bank_ref_no`         VARCHAR(100)          NULL,
  `payment_method`      VARCHAR(30)           NULL,
  `failure_reason`      VARCHAR(500)          NULL,
  `verified_via`        ENUM('CALLBACK','STATUS_API','RECONCILE','OPS','RECOVERY') NULL,
  `verified_at`         DATETIME(3)           NULL,
  `callback_count`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `frontend_return_url` VARCHAR(500)          NULL COMMENT 'where the buyer is sent back to; replaces data/nivabupa-return-targets',
  `refund_ref`          VARCHAR(60)           NULL,
  `refund_amount`       DECIMAL(12,2)         NULL,
  `refunded_at`         DATETIME(3)           NULL,
  `initiated_at`        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at`        DATETIME(3)           NULL,
  `created_at`          DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`          DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hpay_ref` (`insurer_code`, `payment_ref`),
  UNIQUE KEY `uk_hpay_attempt` (`purchase_id`, `attempt_no`),
  UNIQUE KEY `uk_hpay_gateway_txn` (`gateway`, `gateway_txn_id`),
  UNIQUE KEY `uk_hpay_id_purchase` (`id`, `purchase_id`),
  KEY `idx_hpay_status` (`status`, `created_at`),
  CONSTRAINT `fk_hpay_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] one row per payment attempt, any insurer; see migrations/008';


-- ───────────────────────────────────────────────────────────────────────────
-- 5. health_purchase_events — append-only status history. Every status change
--    on a purchase, payment, KYC, proposal, policy or document writes one row
--    here, in the same transaction as the change.
--
--    idempotency_key is UNIQUE: a repeated callback or a retried step writes
--    the same key (e.g. FUTURE_GENERALI:<WS_P_ID>:SUCCESS) and is refused, so
--    it is applied once. api_log_table/api_log_id point at the insurer log row
--    that caused the change (no foreign key: it can be any of six tables).
--
--    No updated_at and no deleted_at: an audit row that can be edited is not
--    an audit row. The application user should hold INSERT and SELECT only.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_purchase_events` (
  `id`               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `purchase_id`      BIGINT UNSIGNED  NOT NULL,
  `entity`           ENUM('PURCHASE','KYC','PROPOSAL','PAYMENT','POLICY','DOCUMENT') NOT NULL,
  `entity_id`        BIGINT UNSIGNED      NULL COMMENT 'row id in the insurer table or health_payments',
  `event_type`       VARCHAR(40)      NOT NULL COMMENT 'STATUS_CHANGED | CALLBACK_RECEIVED | DUPLICATE_CALLBACK | CONFLICT | API_ERROR | NOTE',
  `from_status`      VARCHAR(30)          NULL,
  `to_status`        VARCHAR(30)          NULL,
  `source`           ENUM('API_RESPONSE','CALLBACK','STATUS_POLL','RECONCILE','OPS','RECOVERY','SYSTEM') NOT NULL,
  `api_log_table`    VARCHAR(40)          NULL,
  `api_log_id`       BIGINT UNSIGNED      NULL,
  `idempotency_key`  VARCHAR(150)         NULL,
  `message`          VARCHAR(500)         NULL,
  `details`          JSON                 NULL COMMENT 'masked; never raw customer data',
  `actor`            VARCHAR(60)          NULL,
  `created_at`       DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hpe_idempotency` (`idempotency_key`),
  KEY `idx_hpe_purchase` (`purchase_id`, `created_at`),
  KEY `idx_hpe_type` (`event_type`, `created_at`),
  CONSTRAINT `fk_hpe_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] append-only status history; see migrations/008';


-- ───────────────────────────────────────────────────────────────────────────
-- 6. health_policy_documents — policy schedule, COI, CIS and similar, stored
--    as encrypted bytes (content_enc) with a checksum. A fetch that fails is
--    kept as FAILED with next_retry_at instead of being lost; Chola's schedule
--    links time out today.
--
--    content_enc is a LONGBLOB: list queries must name their columns and never
--    select it. storage/storage_key let a document move to object storage later
--    without a schema change.
--
--    uk_hpd_id_purchase lets each insurer's *_policies table reference
--    (id, purchase_id) together, so a policy can never point at another
--    purchase's document.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `health_policy_documents` (
  `id`               BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `purchase_id`      BIGINT UNSIGNED   NOT NULL,
  `insurer_code`     ENUM('NIVA_BUPA','IFFCO_TOKIO','FUTURE_GENERALI',
                          'ICICI_LOMBARD','CHOLA_MS','GALAXY') NOT NULL,
  `document_type`    ENUM('POLICY_SCHEDULE','POLICY_PDF','COI','CIS','PROPOSAL_FORM','RECEIPT') NOT NULL,
  `policy_number`    VARCHAR(80)           NULL,
  `status`           ENUM('PENDING','STORED','FAILED','LINK_ONLY') NOT NULL DEFAULT 'PENDING',
  `source_url_enc`   VARBINARY(2048)       NULL COMMENT 'the insurer link; it may carry a token',
  `storage`          ENUM('DB','OBJECT_STORE') NOT NULL DEFAULT 'DB',
  `storage_key`      VARCHAR(300)          NULL,
  `content_enc`      LONGBLOB              NULL COMMENT 'encrypted document bytes; never selected by list queries',
  `mime_type`        VARCHAR(60)           NULL,
  `size_bytes`       INT UNSIGNED          NULL,
  `sha256`           CHAR(64)              NULL COMMENT 'of the plain document',
  `fetch_attempts`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `last_error`       VARCHAR(500)          NULL,
  `next_retry_at`    DATETIME              NULL,
  `fetched_at`       DATETIME(3)           NULL,
  `enc_key_version`  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `created_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hpd_doc` (`purchase_id`, `document_type`, `sha256`),
  UNIQUE KEY `uk_hpd_id_purchase` (`id`, `purchase_id`),
  KEY `idx_hpd_retry` (`status`, `next_retry_at`),
  KEY `idx_hpd_policy_no` (`policy_number`),
  CONSTRAINT `fk_hpd_purchase`
    FOREIGN KEY (`purchase_id`) REFERENCES `health_purchases` (`id`)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='[health-hybrid] policy documents, encrypted; see migrations/008';


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK — manual; scripts/migrate.js never runs this (it is commented out).
--
-- Roll back 014, 013, 012, 011, 010 and 009 first: their foreign keys point at
-- these tables, and DROP TABLE refuses while they exist. The guard refuses to
-- drop anything that holds rows. To run it, remove the leading "-- " from each
-- statement line below, run it against the one database you mean, and then:
--   DELETE FROM nivabupa_schema_migrations WHERE filename = '008_create_health_common_tables.sql';
--
-- SET @rows := (SELECT COUNT(*) FROM `health_purchases`)
--            + (SELECT COUNT(*) FROM `health_customers`)
--            + (SELECT COUNT(*) FROM `health_purchase_members`)
--            + (SELECT COUNT(*) FROM `health_payments`)
--            + (SELECT COUNT(*) FROM `health_purchase_events`)
--            + (SELECT COUNT(*) FROM `health_policy_documents`);
-- SET @sql := IF(@rows = 0, 'DO 0', 'SELECT 1 FROM `rollback_008_refused_tables_hold_rows`');
-- PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- DROP TABLE IF EXISTS `health_policy_documents`;
-- DROP TABLE IF EXISTS `health_purchase_events`;
-- DROP TABLE IF EXISTS `health_payments`;
-- DROP TABLE IF EXISTS `health_purchase_members`;
-- DROP TABLE IF EXISTS `health_purchases`;
-- DROP TABLE IF EXISTS `health_customers`;
-- ═══════════════════════════════════════════════════════════════════════════
