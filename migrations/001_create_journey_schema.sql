-- ═══════════════════════════════════════════════════════════════════════════
-- NivaBupa (Reassure 3.0) — journey break / resume journey schema
-- Migration 001
--
-- Derived strictly from the eight endpoints this backend actually exposes:
--   POST /nivabupa/premium          → nivabupa_journey_quotes (+ _members)
--   POST /nivabupa/uw-decision      → nivabupa_journey_proposals.uw_*
--   POST /nivabupa/datapush         → nivabupa_journey_proposals.datapush_*
--   POST /nivabupa/payment/initiate → nivabupa_journey_payments (request side)
--   POST /nivabupa/payment/return   → nivabupa_journey_payments (callback side)
--   POST /nivabupa/proposal-status  → nivabupa_journey_policies.pre_issuance_*
--   POST /nivabupa/policy-download  → nivabupa_journey_policies.document_*
--   GET  /nivabupa/token/test       → nivabupa_api_transactions only (infra)
--
-- ── Why every table is prefixed `nivabupa_` ────────────────────────────────
-- policy_db is NOT a dedicated database. It already holds ~90 tables belonging
-- to a Laravel motor-insurance application (vehicle_master, zuno_quotes,
-- shriram_payments, sessions, wallets, users, …). Unprefixed names collide with
-- it, and the failure is silent rather than loud: CREATE TABLE IF NOT EXISTS
-- skips a name that already exists, so a table called `users` or
-- `api_transactions` would appear to have been created while the code went on
-- to query columns that do not exist. The prefix makes every table in this
-- feature unambiguously owned by this service.
--
-- The one deliberate exception is `users`: journeys attach to the database's
-- EXISTING users table (Laravel auth — name / email / password /
-- remember_token) rather than to a nivabupa-owned copy, so a buyer is one
-- person across both applications. That table has no `mobile` column, which
-- journeys need as their identity key, so migration 002 adds it — additively
-- and nullably, isolated in its own file because it touches a table this
-- service does not own.
--
-- ── Deliberately NOT created ───────────────────────────────────────────────
--   * a vehicle/motor table — Reassure 3.0 is a health product; the journey
--     carries member[] (insured persons), not a vehicle. Such a table would
--     never receive a row.
--   * a separate error_logs table — API failures already carry full error
--     detail on nivabupa_api_transactions (the origin of ~every failure in a
--     pass-through integration), and non-API errors are recorded on
--     nivabupa_journey_events with event_type='ERROR'. A third table would
--     duplicate both.
--
-- Engine/charset: InnoDB + utf8mb4 everywhere (FK support; names/addresses
-- may contain non-BMP characters).
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE DATABASE IF NOT EXISTS `policy_db`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `policy_db`;


-- ───────────────────────────────────────────────────────────────────────────
-- 1. users — NOT created here. Journeys attach to the database's existing
--    users table so a buyer is one person across this service and the host
--    application. Migration 002 adds the `mobile` column journeys identify
--    buyers by; nothing else about that table is altered.
--
--    Its relevant shape (unchanged by this feature):
--      id                BIGINT UNSIGNED  PK
--      name              VARCHAR(255)     NOT NULL
--      email             VARCHAR(255)     NOT NULL, UNIQUE
--      password          VARCHAR(255)     NOT NULL
--      created_at/updated_at TIMESTAMP    NULL
--
--    `name` and `password` being NOT NULL with no default is why
--    user.repository.js supplies both when it creates a buyer row — see the
--    comment there about the deliberately unusable password placeholder.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- 2. nivabupa_journeys — the resume spine. One row per purchase attempt; a
--    user may have many (requirement: multiple journeys per user).
--
--    resume_token is the credential the SPA presents to pick a journey back
--    up after a break. It is a 64-char random hex value, unique, and carries
--    its own expiry so an abandoned journey cannot be resumed indefinitely.
--
--    last_completed_step is stored explicitly rather than derived by scanning
--    nivabupa_journey_events: restore has to be a single indexed row read even
--    when a journey has hundreds of events, and it must survive a server
--    restart with no replay step.
--
--    step_data holds transient UI form state that has no typed home yet (a
--    half-filled proposer form the buyer never submitted). Anything the
--    backend has actually sent upstream is promoted to a typed table — this
--    column is a staging area, not a second copy.
--
--    selected_quote_id lives here rather than as an `is_selected` flag on
--    nivabupa_journey_quotes: a single FK column enforces "exactly one
--    selected quote" structurally, whereas a boolean flag would need
--    application logic to stop two rows both claiming selection (MySQL has no
--    partial unique index). This is also the "selected insurer" record,
--    together with insurer_code.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journeys` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                CHAR(36)        NOT NULL COMMENT 'public journey id used by the SPA',
  `user_id`             BIGINT UNSIGNED NOT NULL,
  `resume_token`        CHAR(64)        NOT NULL COMMENT 'random hex; presented to resume after a break',
  `current_step`        VARCHAR(40)     NOT NULL DEFAULT 'JOURNEY_STARTED',
  `last_completed_step` VARCHAR(40)         NULL COMMENT 'restore target; the furthest step fully persisted',
  `status`              ENUM('IN_PROGRESS','COMPLETED','ABANDONED','EXPIRED','FAILED')
                                        NOT NULL DEFAULT 'IN_PROGRESS',
  `insurer_code`        VARCHAR(50)     NOT NULL DEFAULT 'NIVA_BUPA',
  `insurer_name`        VARCHAR(100)    NOT NULL DEFAULT 'Niva Bupa Health Insurance',
  `product_code`        VARCHAR(50)     NOT NULL DEFAULT 'REASSURE30',
  `product_variant`     VARCHAR(50)         NULL COMMENT 'Diamond / Platinum / Titanium',
  `selected_quote_id`   BIGINT UNSIGNED     NULL COMMENT 'FK added after the quotes table exists (circular reference)',
  `channel`             VARCHAR(50)         NULL,
  `subchannel`          VARCHAR(50)         NULL,
  `sourcing_system`     VARCHAR(50)         NULL,
  `agent_id`            VARCHAR(50)         NULL,
  `step_data`           JSON                NULL COMMENT 'un-submitted UI form state only; never a copy of a typed table',
  `resume_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_activity_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`          DATETIME            NULL,
  `completed_at`        DATETIME            NULL,
  `abandoned_at`        DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_journeys_uuid`         (`uuid`),
  UNIQUE KEY `uk_nb_journeys_resume_token` (`resume_token`),
  KEY `idx_nb_journeys_user_status`   (`user_id`, `status`, `deleted_at`),
  KEY `idx_nb_journeys_status_expiry` (`status`, `expires_at`) COMMENT 'sweeper: expire stale IN_PROGRESS journeys',
  KEY `idx_nb_journeys_last_activity` (`last_activity_at`),
  KEY `idx_nb_journeys_deleted_at`    (`deleted_at`),
  -- References the host application's existing users table. RESTRICT, not
  -- CASCADE: deleting a user must not silently destroy the journeys and issued
  -- policies attached to them — an insurance audit trail has to outlive an
  -- account deletion, so the delete fails loudly instead.
  CONSTRAINT `fk_nb_journeys_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. nivabupa_journey_quotes — one row per POST /nivabupa/premium call. Many
--    per journey: the buyer compares sum insured / variant / term combinations
--    before choosing one, and every comparison must survive a break.
--
--    Typed columns cover exactly what restore and reporting need. The full
--    request/response stay in JSON because /nivabupa/premium is a documented
--    pass-through — the caller may legitimately send fields from the Premium
--    Data Dictionary that this schema does not model, and losing them would
--    make the quote non-replayable. That is intentional retention, not a
--    duplicate of the typed columns.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_quotes` (
  `id`                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                     CHAR(36)        NOT NULL,
  `journey_id`               BIGINT UNSIGNED NOT NULL,
  `status`                   ENUM('PENDING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
  -- request (typed subset used to rebuild the quote screen)
  `product_code`             VARCHAR(50)         NULL,
  `product_variant`          VARCHAR(50)         NULL,
  `policy_term`              VARCHAR(10)         NULL,
  `coverage_type`            VARCHAR(10)         NULL COMMENT 'I = Individual, F = Floater',
  `sum_insured`              DECIMAL(14,2)       NULL,
  `payment_frequency`        VARCHAR(10)         NULL COMMENT 'A = Annual',
  `premium_calculation`      VARCHAR(20)         NULL COMMENT 'New / Renewal',
  `premium_calculation_date` VARCHAR(20)         NULL COMMENT 'NivaBupa DD/Mon/YYYY string, kept verbatim for replay',
  `adult_covered`            TINYINT UNSIGNED    NULL,
  `child_covered`            TINYINT UNSIGNED    NULL,
  `city`                     VARCHAR(100)        NULL,
  `state`                    VARCHAR(100)        NULL,
  `zone`                     VARCHAR(20)         NULL,
  `is_port`                  CHAR(1)             NULL,
  `flexi_payment`            CHAR(1)             NULL,
  `policy_number_if_renewal` VARCHAR(80)         NULL,
  -- response
  `base_premium`             DECIMAL(14,2)       NULL,
  `gst_amount`               DECIMAL(14,2)       NULL,
  `discount_amount`          DECIMAL(14,2)       NULL,
  `total_premium`            DECIMAL(14,2)       NULL,
  `request_payload`          JSON            NOT NULL COMMENT 'exact body forwarded to NivaBupa',
  `response_payload`         JSON                NULL COMMENT 'exact NivaBupa premium response',
  `error_message`            TEXT                NULL,
  `api_transaction_id`       BIGINT UNSIGNED     NULL,
  `created_at`               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`               DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_quotes_uuid` (`uuid`),
  KEY `idx_nb_quotes_journey`    (`journey_id`, `status`, `deleted_at`),
  KEY `idx_nb_quotes_created`    (`created_at`),
  KEY `idx_nb_quotes_deleted_at` (`deleted_at`),
  CONSTRAINT `fk_nb_quotes_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Circular reference resolved here: nivabupa_journeys.selected_quote_id →
-- nivabupa_journey_quotes. ON DELETE SET NULL so cascading a quote away never
-- destroys the journey row.
--
-- Guarded by a catalogue check because MySQL has no ADD CONSTRAINT IF NOT
-- EXISTS, and this migration must stay re-runnable after a partial failure
-- (DDL is not transactional — see scripts/migrate.js).
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = 'policy_db'
    AND TABLE_NAME = 'nivabupa_journeys'
    AND CONSTRAINT_NAME = 'fk_nb_journeys_selected_quote'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `nivabupa_journeys`
     ADD CONSTRAINT `fk_nb_journeys_selected_quote`
     FOREIGN KEY (`selected_quote_id`) REFERENCES `nivabupa_journey_quotes` (`id`)
     ON DELETE SET NULL ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 4. nivabupa_journey_quote_members — the premium request's member[] array,
--    one row per insured person, instead of leaving it buried in
--    request_payload. Needed as rows because the member set is what the buyer
--    edits between quotes (add a child, correct a DOB) and the resume screen
--    has to render and diff it.
--
--    date_of_birth_raw keeps NivaBupa's '06/Aug/1998' format verbatim so a
--    replayed request is byte-identical; date_of_birth is the parsed value
--    for age/query logic. Two representations of one fact, but the raw form
--    is contractual with the partner API and reformatting is lossy.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_quote_members` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quote_id`            BIGINT UNSIGNED NOT NULL,
  `member_seq_no`       SMALLINT UNSIGNED NOT NULL COMMENT 'NivaBupa mbrShpNo',
  `insured_type`        CHAR(1)             NULL COMMENT 'A = Adult, C = Child',
  `date_of_birth_raw`   VARCHAR(20)         NULL COMMENT 'DD/Mon/YYYY exactly as sent upstream',
  `date_of_birth`       DATE                NULL COMMENT 'parsed form, for age and reporting',
  `gender`              CHAR(1)             NULL,
  `dia_ped_tenure`      SMALLINT UNSIGNED   NULL COMMENT 'diabetes pre-existing-disease tenure (years)',
  `htn_ped_tenure`      SMALLINT UNSIGNED   NULL COMMENT 'hypertension PED tenure (years)',
  `port_coverage_years` SMALLINT UNSIGNED   NULL,
  `uw_loading`          JSON                NULL COMMENT 'uwLoading[] as sent; shape is UW-driven and open-ended',
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_quote_member_seq` (`quote_id`, `member_seq_no`),
  CONSTRAINT `fk_nb_quote_members_quote`
    FOREIGN KEY (`quote_id`) REFERENCES `nivabupa_journey_quotes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- No deleted_at: rows are owned by their quote and cascade with it. Soft-
-- deleting a child row independently of its parent has no meaning here.


-- ───────────────────────────────────────────────────────────────────────────
-- 5. nivabupa_journey_proposals — proposer + policy + nominee details, and the
--    two upstream calls that consume them: uwDecision and datapush. Kept as
--    ONE table because UW and Data Push operate on the same proposal document
--    at two moments in its life, not on two different entities; splitting them
--    would force a join for every restore and duplicate the proposer block.
--
--    application_number is datapush's POLICY_CODE — the key
--    /nivabupa/proposal-status is later queried by.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_proposals` (
  `id`                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                        CHAR(36)        NOT NULL,
  `journey_id`                  BIGINT UNSIGNED NOT NULL,
  `quote_id`                    BIGINT UNSIGNED     NULL COMMENT 'quote this proposal was built from',
  -- PROPOSER block
  `proposer_first_name`         VARCHAR(100)        NULL,
  `proposer_last_name`          VARCHAR(100)        NULL,
  `proposer_date_of_birth`      DATE                NULL,
  `proposer_gender`             CHAR(1)             NULL,
  `proposer_mobile`             VARCHAR(15)         NULL,
  `proposer_email`              VARCHAR(255)        NULL,
  `proposer_pan`                VARCHAR(20)         NULL,
  `proposer_marital_status`     VARCHAR(20)         NULL,
  `proposer_occupation`         VARCHAR(100)        NULL,
  `proposer_address_line1`      VARCHAR(255)        NULL,
  `proposer_address_line2`      VARCHAR(255)        NULL,
  `proposer_city`               VARCHAR(100)        NULL,
  `proposer_state`              VARCHAR(100)        NULL,
  `proposer_pincode`            VARCHAR(10)         NULL,
  -- POLICY block
  `policy_start_date`           DATE                NULL,
  `policy_end_date`             DATE                NULL,
  `policy_term`                 VARCHAR(10)         NULL,
  `payment_frequency`           VARCHAR(10)         NULL,
  `sum_insured`                 DECIMAL(14,2)       NULL,
  `total_premium`               DECIMAL(14,2)       NULL,
  -- NOMINEE block
  `nominee_name`                VARCHAR(150)        NULL,
  `nominee_date_of_birth`       DATE                NULL,
  `nominee_gender`              CHAR(1)             NULL,
  `nominee_relation`            VARCHAR(50)         NULL,
  -- uwDecision
  `uw_status`                   ENUM('NOT_STARTED','PENDING','APPROVED','REFERRED','DECLINED','FAILED')
                                                NOT NULL DEFAULT 'NOT_STARTED',
  `uw_decision_code`            VARCHAR(40)         NULL,
  `uw_decision_message`         TEXT                NULL,
  `uw_reference_no`             VARCHAR(80)         NULL,
  `uw_request_payload`          JSON                NULL,
  `uw_response_payload`         JSON                NULL,
  `uw_submitted_at`             DATETIME            NULL,
  -- datapush
  `datapush_status`             ENUM('NOT_STARTED','PENDING','SUCCESS','FAILED')
                                                NOT NULL DEFAULT 'NOT_STARTED',
  `application_number`          VARCHAR(80)         NULL COMMENT 'datapush POLICY_CODE; input to proposal-status',
  `datapush_status_code`        VARCHAR(40)         NULL,
  `datapush_status_message`     TEXT                NULL,
  `datapush_request_payload`    JSON                NULL,
  `datapush_response_payload`   JSON                NULL,
  `datapush_submitted_at`       DATETIME            NULL,
  `created_at`                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`                  DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_proposals_uuid` (`uuid`),
  KEY `idx_nb_proposals_journey`     (`journey_id`, `deleted_at`),
  KEY `idx_nb_proposals_application` (`application_number`),
  KEY `idx_nb_proposals_mobile`      (`proposer_mobile`),
  KEY `idx_nb_proposals_uw_status`   (`uw_status`),
  KEY `idx_nb_proposals_deleted_at`  (`deleted_at`),
  CONSTRAINT `fk_nb_proposals_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_nb_proposals_quote`
    FOREIGN KEY (`quote_id`) REFERENCES `nivabupa_journey_quotes` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- 6. nivabupa_journey_proposal_members — the MEMBER[] block of the UW / data
--    push payload. Separate from nivabupa_journey_quote_members rather than
--    one shared table: quote members carry no PII (DOB, gender, PED tenure
--    only) while proposal members carry names, relations, medical answers, and
--    hang off a different parent. Merging them would produce a half-empty
--    table with two mutually exclusive FKs.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_proposal_members` (
  `id`                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `proposal_id`              BIGINT UNSIGNED NOT NULL,
  `member_seq_no`            SMALLINT UNSIGNED NOT NULL,
  `insured_type`             CHAR(1)             NULL,
  `relation_to_proposer`     VARCHAR(50)         NULL,
  `first_name`               VARCHAR(100)        NULL,
  `last_name`                VARCHAR(100)        NULL,
  `date_of_birth_raw`        VARCHAR(20)         NULL,
  `date_of_birth`            DATE                NULL,
  `gender`                   CHAR(1)             NULL,
  `height_cm`                DECIMAL(5,2)        NULL,
  `weight_kg`                DECIMAL(5,2)        NULL,
  `occupation`               VARCHAR(100)        NULL,
  `marital_status`           VARCHAR(20)         NULL,
  `has_pre_existing_disease` TINYINT(1)      NOT NULL DEFAULT 0,
  `medical_details`          JSON                NULL COMMENT 'declaration answers; question set is product-driven',
  `uw_loading_percent`       DECIMAL(6,2)        NULL,
  `uw_remarks`               TEXT                NULL,
  `created_at`               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_proposal_member_seq` (`proposal_id`, `member_seq_no`),
  CONSTRAINT `fk_nb_proposal_members_proposal`
    FOREIGN KEY (`proposal_id`) REFERENCES `nivabupa_journey_proposals` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- 7. nivabupa_journey_kyc — KYC state, one row per journey (UNIQUE on
--    journey_id).
--
--    No NivaBupa KYC endpoint exists in the current API kit, so nothing in
--    this backend calls out to a KYC provider yet. The table exists because
--    KYC is a blocking step of the real purchase journey: without persisting
--    its outcome, a buyer who breaks after verification would be sent through
--    it again. request_payload/response_payload are ready for whichever
--    provider gets wired in; attempt_count supports retry after rejection.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_kyc` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `journey_id`        BIGINT UNSIGNED NOT NULL,
  `status`            ENUM('NOT_STARTED','PENDING','IN_PROGRESS','VERIFIED','REJECTED','MANUAL_REVIEW','FAILED')
                                      NOT NULL DEFAULT 'NOT_STARTED',
  `method`            ENUM('CKYC','PAN','AADHAAR','DIGILOCKER','OVD','MANUAL') NULL,
  `ckyc_number`       VARCHAR(30)         NULL,
  `pan_number`        VARCHAR(20)         NULL,
  `document_type`     VARCHAR(40)         NULL,
  `document_number`   VARCHAR(60)         NULL,
  `reference_id`      VARCHAR(100)        NULL COMMENT 'provider-side reference for reconciliation',
  `attempt_count`     INT UNSIGNED    NOT NULL DEFAULT 0,
  `rejection_reason`  TEXT                NULL,
  `request_payload`   JSON                NULL,
  `response_payload`  JSON                NULL,
  `verified_at`       DATETIME            NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`        DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_kyc_journey` (`journey_id`),
  KEY `idx_nb_kyc_status`     (`status`),
  KEY `idx_nb_kyc_reference`  (`reference_id`),
  KEY `idx_nb_kyc_deleted_at` (`deleted_at`),
  CONSTRAINT `fk_nb_kyc_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- 8. nivabupa_journey_payments — the single most important table for resume,
--    and the reason this feature cannot work without a database.
--
--    NivaBupa's gateway POSTs /nivabupa/payment/return from its own servers
--    with nothing but an encrypted `returnMessage`. There is no cookie, no
--    session, no journey id on that request. The ONLY way to attach the
--    payment outcome back to a journey is to have stored, at initiate time,
--    the unqPolicyNumber we generated — the callback echoes it back as
--    uniqueReferenceId. unq_policy_number is therefore UNIQUE and indexed:
--    it is the correlation key the callback is looked up by.
--
--    Many attempts per journey (retry after a failed payment), ordered by
--    attempt_no, which is unique per journey so a double-submit cannot create
--    two rows claiming the same attempt.
--
--    plaintext_querystring is retained because decrypt failures on this
--    integration are diagnosed by comparing the pipe string that went in
--    against what comes back (see the decryption-key note in .env).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_payments` (
  `id`                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                        CHAR(36)        NOT NULL,
  `journey_id`                  BIGINT UNSIGNED NOT NULL,
  `proposal_id`                 BIGINT UNSIGNED     NULL,
  `attempt_no`                  INT UNSIGNED    NOT NULL DEFAULT 1,
  `unq_policy_number`           VARCHAR(80)     NOT NULL COMMENT 'our reference; callback correlation key',
  `status`                      ENUM('INITIATED','PENDING','SUCCESS','FAILED','CANCELLED','ERROR')
                                                NOT NULL DEFAULT 'INITIATED',
  -- request side (payment/initiate querystring fields)
  `premium_value`               DECIMAL(14,2)   NOT NULL,
  `payment_type`                VARCHAR(60)         NULL,
  `is_juspay`                   VARCHAR(10)         NULL,
  `channel`                     VARCHAR(50)         NULL,
  `subchannel`                  VARCHAR(50)         NULL,
  `sourcing_system`             VARCHAR(50)         NULL,
  `product_name`                VARCHAR(100)        NULL,
  `policy_number_if_renewal`    VARCHAR(80)         NULL,
  `mobile`                      VARCHAR(15)         NULL,
  `email`                       VARCHAR(255)        NULL,
  `agent_id`                    VARCHAR(50)         NULL,
  `sum_insured`                 DECIMAL(14,2)       NULL,
  `tenure`                      VARCHAR(10)         NULL,
  `zone`                        VARCHAR(20)         NULL,
  `other_param`                 VARCHAR(255)        NULL,
  `additional_comment`          VARCHAR(255)        NULL,
  `return_path`                 VARCHAR(500)        NULL,
  `plaintext_querystring`       TEXT                NULL COMMENT 'pipe string pre-encryption; needed to debug decrypt failures',
  `encparam`                    TEXT                NULL COMMENT 'encrypted value handed to the SPA for the gateway form POST',
  `gateway_url`                 VARCHAR(500)        NULL,
  -- callback side (decrypted returnMessage, pipe-field order per the spec)
  `payment_status_code`         VARCHAR(20)         NULL COMMENT 'M001 = success',
  `payment_status_description`  VARCHAR(40)         NULL,
  `payment_transaction_id`      VARCHAR(100)        NULL COMMENT 'gateway transaction id',
  `unique_reference_id`         VARCHAR(80)         NULL COMMENT 'echoed unqPolicyNumber',
  `unique_reference_no_repeat`  VARCHAR(80)         NULL,
  `payable_premium`             DECIMAL(14,2)       NULL,
  `transaction_date_time`       VARCHAR(50)         NULL,
  `failed_reason`               TEXT                NULL,
  `standing_instruction_taken`  VARCHAR(10)         NULL,
  `standing_instruction_no`     VARCHAR(60)         NULL,
  `payment_gateway_used`        VARCHAR(60)         NULL,
  `decrypted_return_message`    TEXT                NULL,
  `raw_callback_body`           JSON                NULL COMMENT 'verbatim gateway POST body',
  `initiated_at`                DATETIME            NULL,
  `callback_received_at`        DATETIME            NULL,
  `created_at`                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`                  DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_payments_uuid`            (`uuid`),
  UNIQUE KEY `uk_nb_payments_unq_policy`      (`unq_policy_number`),
  UNIQUE KEY `uk_nb_payments_journey_attempt` (`journey_id`, `attempt_no`),
  KEY `idx_nb_payments_txn_id`     (`payment_transaction_id`),
  KEY `idx_nb_payments_status`     (`status`, `created_at`),
  KEY `idx_nb_payments_ref_repeat` (`unique_reference_no_repeat`) COMMENT 'callback fallback lookup',
  KEY `idx_nb_payments_deleted_at` (`deleted_at`),
  CONSTRAINT `fk_nb_payments_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_nb_payments_proposal`
    FOREIGN KEY (`proposal_id`) REFERENCES `nivabupa_journey_proposals` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- 9. nivabupa_journey_policies — the issued policy: status from
--    /nivabupa/proposal-status and the document from
--    /nivabupa/policy-download. One row per journey.
--
--    document_base64 is a LONGTEXT holding the policy PDF. It lives here
--    rather than in a twelfth table because every repository read in this
--    codebase names its columns explicitly, so the blob is never pulled into
--    a hot-path SELECT; document_available lets callers know it exists
--    without touching it.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_policies` (
  `id`                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                        CHAR(36)        NOT NULL,
  `journey_id`                  BIGINT UNSIGNED NOT NULL,
  `proposal_id`                 BIGINT UNSIGNED     NULL,
  `payment_id`                  BIGINT UNSIGNED     NULL,
  `status`                      ENUM('NOT_ISSUED','PENDING','UNDER_REVIEW','ISSUED','REJECTED','CANCELLED')
                                                NOT NULL DEFAULT 'NOT_ISSUED',
  `policy_number`               VARCHAR(80)         NULL,
  `application_number`          VARCHAR(80)         NULL,
  `issue_date`                  DATE                NULL,
  `start_date`                  DATE                NULL,
  `end_date`                    DATE                NULL,
  `sum_insured`                 DECIMAL(14,2)       NULL,
  `total_premium`               DECIMAL(14,2)       NULL,
  `pre_issuance_status`         VARCHAR(80)         NULL COMMENT 'from proposal-status preIssuanceStatusData',
  `pre_issuance_status_message` TEXT                NULL,
  `proposal_status_response`    JSON                NULL,
  `proposal_status_checked_at`  DATETIME            NULL,
  `document_available`          TINYINT(1)      NOT NULL DEFAULT 0,
  `document_base64`             LONGTEXT            NULL COMMENT 'policy PDF; excluded from default reads',
  `document_response`           JSON                NULL COMMENT 'download envelope minus the blob',
  `document_downloaded_at`      DATETIME            NULL,
  `created_at`                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`                  DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_policies_uuid`    (`uuid`),
  UNIQUE KEY `uk_nb_policies_journey` (`journey_id`),
  KEY `idx_nb_policies_policy_number` (`policy_number`),
  KEY `idx_nb_policies_application`   (`application_number`),
  KEY `idx_nb_policies_status`        (`status`),
  KEY `idx_nb_policies_deleted_at`    (`deleted_at`),
  CONSTRAINT `fk_nb_policies_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_nb_policies_proposal`
    FOREIGN KEY (`proposal_id`) REFERENCES `nivabupa_journey_proposals` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_nb_policies_payment`
    FOREIGN KEY (`payment_id`) REFERENCES `nivabupa_journey_payments` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- 10. nivabupa_api_transactions — one row per upstream call (NivaBupa REST,
--     caseapi, and the two SOAP encrypt/decrypt calls), plus the inbound
--     gateway callback. This is the "API responses where required" store and
--     the failure log in one place.
--
--     journey_id is NULLABLE on purpose: /nivabupa/token/test and any
--     pass-through call made without a journey header still get logged, and
--     ON DELETE SET NULL keeps the audit row after a journey is purged.
--
--     Append-only, so created_at is the only timestamp and there is no
--     deleted_at — an audit row that can be edited or hidden is not an audit
--     row. Prune by date with a partition/archive job instead.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_api_transactions` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`             CHAR(36)        NOT NULL,
  `journey_id`       BIGINT UNSIGNED     NULL,
  `api_name`         VARCHAR(60)     NOT NULL COMMENT 'TOKEN|PREMIUM|UW_DECISION|DATAPUSH|PAYMENT_ENCRYPT|PAYMENT_DECRYPT|PAYMENT_CALLBACK|PROPOSAL_STATUS|POLICY_DOWNLOAD',
  `journey_step`     VARCHAR(40)         NULL,
  `direction`        ENUM('OUTBOUND','INBOUND') NOT NULL DEFAULT 'OUTBOUND',
  `http_method`      VARCHAR(10)         NULL,
  `endpoint_url`     VARCHAR(500)        NULL,
  `status`           ENUM('SUCCESS','FAILED','TIMEOUT') NOT NULL,
  `http_status`      SMALLINT UNSIGNED   NULL,
  `duration_ms`      INT UNSIGNED        NULL,
  `request_payload`  JSON                NULL COMMENT 'credentials/tokens redacted before write',
  `response_payload` JSON                NULL,
  `error_code`       VARCHAR(60)         NULL,
  `error_message`    TEXT                NULL,
  `correlation_id`   VARCHAR(80)         NULL COMMENT 'unqPolicyNumber / applicationNumber / policyNumber',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_api_txn_uuid` (`uuid`),
  KEY `idx_nb_api_txn_journey`     (`journey_id`, `api_name`, `created_at`),
  KEY `idx_nb_api_txn_status`      (`status`, `created_at`),
  KEY `idx_nb_api_txn_correlation` (`correlation_id`),
  KEY `idx_nb_api_txn_api_name`    (`api_name`, `created_at`),
  CONSTRAINT `fk_nb_api_txn_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Deferred FK: nivabupa_journey_quotes.api_transaction_id →
-- nivabupa_api_transactions. Declared here because the transactions table is
-- created after the quotes table (quotes must exist before the journeys'
-- selected_quote_id FK can be added). Same catalogue guard as above.
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = 'policy_db'
    AND TABLE_NAME = 'nivabupa_journey_quotes'
    AND CONSTRAINT_NAME = 'fk_nb_quotes_api_transaction'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE `nivabupa_journey_quotes`
     ADD CONSTRAINT `fk_nb_quotes_api_transaction`
     FOREIGN KEY (`api_transaction_id`) REFERENCES `nivabupa_api_transactions` (`id`)
     ON DELETE SET NULL ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ───────────────────────────────────────────────────────────────────────────
-- 11. nivabupa_journey_events — step transition trail. Small rows, written on
--     every save, and the authoritative history behind "resume from the last
--     completed step" when nivabupa_journeys.last_completed_step needs
--     auditing or the journey has to be rewound.
--
--     event_type='ERROR' rows carry the non-API failures (validation, missing
--     returnMessage, decrypt parse failure) that have no api_transactions row
--     of their own — which is why this schema needs no separate error table.
--
--     Append-only: created_at only, no deleted_at.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_journey_events` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `journey_id`    BIGINT UNSIGNED NOT NULL,
  `event_type`    ENUM('JOURNEY_CREATED','STEP_ENTERED','STEP_COMPLETED','STEP_FAILED',
                       'JOURNEY_RESUMED','JOURNEY_ABANDONED','JOURNEY_COMPLETED','ERROR')
                                  NOT NULL,
  `from_step`     VARCHAR(40)         NULL,
  `to_step`       VARCHAR(40)         NULL,
  `message`       VARCHAR(500)        NULL,
  `error_code`    VARCHAR(60)         NULL,
  `error_message` TEXT                NULL,
  `error_stack`   TEXT                NULL,
  `metadata`      JSON                NULL,
  `ip_address`    VARCHAR(45)         NULL COMMENT 'sized for IPv6',
  `user_agent`    VARCHAR(255)        NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_nb_events_journey` (`journey_id`, `created_at`),
  KEY `idx_nb_events_type`    (`event_type`, `created_at`),
  CONSTRAINT `fk_nb_events_journey`
    FOREIGN KEY (`journey_id`) REFERENCES `nivabupa_journeys` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ───────────────────────────────────────────────────────────────────────────
-- nivabupa_schema_migrations — so migrate.js is idempotent and a
-- restarted/redeployed server never re-runs applied DDL. Prefixed like
-- everything else: a shared database may already have a Laravel `migrations`
-- or a plain `schema_migrations` table belonging to another application.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `nivabupa_schema_migrations` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `filename`   VARCHAR(255) NOT NULL,
  `applied_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_schema_migrations_filename` (`filename`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
