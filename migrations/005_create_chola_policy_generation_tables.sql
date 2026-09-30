-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 005 — Chola MS PolicyGeneration evidence and outcomes
--
--   health_chola_policy_generation_logs   one row per PolicyGeneration request
--                                         actually sent, from ANY path (the
--                                         website's PG and the backend-built APD
--                                         one), with the request and response
--                                         exactly as they crossed the wire. This
--                                         is the evidence shared with Chola MS.
--
--   health_chola_proposals                one row per proposal the BACKEND has
--                                         tagged payment for (the ops route, and
--                                         the website's route under APD — see
--                                         src/services/cholaPolicyIssuer.service.js)
--                                         and what came of it.
--
-- WHY THE PROPOSAL ROW IS WRITTEN BEFORE THE CALL
--   PolicyGeneration is not idempotent: a second call for a proposal fails at
--   Chola on INS.UK_WS_PORTAL_PAY, and under APD a second call that DID succeed
--   would debit the deposit twice. The UNIQUE key on gencon_proposal_number is
--   what refuses a second send — claimed before anything goes to Chola, so a
--   crash mid-call still leaves the proposal marked as sent.
--
-- WHY THESE NAMES
--   Carried over unchanged from the standalone novacred-insurance-integrations
--   service (its migration 002). Where the two share a schema the tables already
--   exist, CREATE TABLE IF NOT EXISTS leaves them — and their rows — alone, and a
--   proposal claimed there stays claimed here.
--
-- The bearer token is never stored: request_headers carries it masked.
--
-- Additive only: no existing table is touched. Idempotent (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

CREATE TABLE IF NOT EXISTS `health_chola_policy_generation_logs` (
  `id`                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  -- When the request was sent, to the millisecond.
  `created_at`              DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- 'website' (the browser-built PG request, or the website's route under APD)
  -- or 'ops' (built by the backend on an operator's request).
  `source`                  VARCHAR(20)      NOT NULL,
  `product`                 VARCHAR(20)      NOT NULL,
  -- CHOLA_PAYMENT_MODE for a backend-built request; NULL for the website's own
  -- PG body — tagging_mode/pay_mode below say what it sent.
  `payment_mode`            VARCHAR(20)      DEFAULT NULL,
  `tagging_mode`            VARCHAR(20)      DEFAULT NULL,
  `pay_mode`                VARCHAR(20)      DEFAULT NULL,
  `gencon_proposal_number`  VARCHAR(30)      DEFAULT NULL,
  `request_url`             VARCHAR(500)     NOT NULL,
  `request_headers`         TEXT             NOT NULL,
  -- Text, not JSON: a JSON column re-serialises, and the point of this table is
  -- the bytes that were sent — including Flexi Health's "ChequeorDDnumber ".
  `request_body`            LONGTEXT         NOT NULL,
  -- NULL when no response arrived (timeout, connection failure).
  `http_status`             SMALLINT         DEFAULT NULL,
  `response_body`           LONGTEXT         DEFAULT NULL,
  `error_code`              VARCHAR(50)      DEFAULT NULL,
  `error_message`           TEXT             DEFAULT NULL,
  `correlation_id`          VARCHAR(64)      DEFAULT NULL,
  `duration_ms`             INT UNSIGNED     DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_health_chola_pg_logs_proposal` (`gencon_proposal_number`),
  KEY `idx_health_chola_pg_logs_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `health_chola_proposals` (
  `id`                      BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `gencon_proposal_number`  VARCHAR(30)      NOT NULL,
  `product`                 VARCHAR(20)      NOT NULL,
  `payment_mode`            VARCHAR(20)      NOT NULL,
  `amount`                  DECIMAL(12,2)    DEFAULT NULL,
  -- POLICY_GENERATION_SENT  claimed, request going out (or the process died)
  -- POLICY_ISSUED           Success with a policy number
  -- PAYMENT_PENDING         Success with Chola's payment page (PG_CHOLA)
  -- PAYMENT_FAILED          Chola refused it, or it was never sent — the only
  --                         state a deliberate re-attempt is allowed from
  -- NEEDS_REVIEW            outcome unknown (timeout, 5xx, Success without a
  --                         policy number) — Chola may have acted on it, so it
  --                         is reconciled with them, never re-sent
  `status`                  VARCHAR(30)      NOT NULL,
  `gencon_policy_number`    VARCHAR(40)      DEFAULT NULL,
  `payment_url`             VARCHAR(1000)    DEFAULT NULL,
  `error_message`           TEXT             DEFAULT NULL,
  `schedule_url`            VARCHAR(1000)    DEFAULT NULL,
  `cis_url`                 VARCHAR(1000)    DEFAULT NULL,
  `policy_pdf`              LONGBLOB         DEFAULT NULL,
  `policy_pdf_error`        TEXT             DEFAULT NULL,
  `created_at`              TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_health_chola_proposals_proposal` (`gencon_proposal_number`),
  KEY `idx_health_chola_proposals_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
