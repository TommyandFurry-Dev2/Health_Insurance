-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 007 — Chola MS Freecharge payments
--
--   health_chola_freecharge_payments   one row per Freecharge (FCPG) checkout
--                                      started for a Chola proposal, and what
--                                      came of it: FCPG's verdict, the policy
--                                      issued against it, any refund.
--
-- WHY THE ROW IS WRITTEN BEFORE THE BUYER IS SENT TO PAY
--   A callback that finds no row is a buyer who paid and whom nothing records.
--   So the row (with its merchantTxnId and the opaque return reference) exists
--   before the checkout is handed to the browser; if it cannot be written, the
--   checkout is not started.
--
-- WHY THE RAW CALLBACK IS KEPT
--   callback_body is FCPG's post exactly as it arrived — { clientId, encData }
--   ciphertext — so it can be decrypted again if anything downstream failed.
--
-- PolicyGeneration for a paid row goes through health_chola_proposals (005),
-- whose UNIQUE key still refuses a second send for one proposal; issue_status
-- here mirrors that outcome for this payment.
--
-- Additive only: no existing table is touched. Idempotent (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

CREATE TABLE IF NOT EXISTS `health_chola_freecharge_payments` (
  `id`                       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  -- Ours, sent to FCPG; FCPG's charset, at most 30.
  `merchant_txn_id`          VARCHAR(30)      NOT NULL,
  -- The opaque reference the return page reads this payment by.
  `return_token`             CHAR(32)         NOT NULL,
  `gencon_proposal_number`   VARCHAR(30)      NOT NULL,
  `product`                  VARCHAR(20)      NOT NULL,
  -- The premium asked for (Chola's re-priced ProposalSave figure).
  `amount`                   DECIMAL(12,2)    NOT NULL,
  `currency`                 CHAR(3)          NOT NULL,
  -- INITIATED | PENDING | SUCCESS | FAILED | NEEDS_REVIEW
  `status`                   VARCHAR(20)      NOT NULL,
  `status_code`              VARCHAR(20)      DEFAULT NULL,
  `status_message`           VARCHAR(1000)    DEFAULT NULL,
  -- FCPG's own transaction id: PGID on PolicyGeneration, and the refund key.
  `txn_reference_id`         VARCHAR(64)      DEFAULT NULL,
  `paid_amount`              DECIMAL(12,2)    DEFAULT NULL,
  `txn_mode`                 VARCHAR(20)      DEFAULT NULL,
  `txn_sub_mode`             VARCHAR(20)      DEFAULT NULL,
  -- The /chola-return page the checkout named; the callback redirects there.
  `frontend_return_url`      VARCHAR(500)     DEFAULT NULL,
  `callback_count`           INT UNSIGNED     NOT NULL DEFAULT 0,
  `callback_body`            LONGTEXT         DEFAULT NULL,
  `callback_decrypted`       LONGTEXT         DEFAULT NULL,
  -- The last txn/status answer, as received.
  `status_response`          LONGTEXT         DEFAULT NULL,
  `last_checked_at`          DATETIME(3)      DEFAULT NULL,
  -- IN_PROGRESS | POLICY_ISSUED | ISSUE_FAILED | NEEDS_REVIEW (NULL: not tried)
  `issue_status`             VARCHAR(20)      DEFAULT NULL,
  `gencon_policy_number`     VARCHAR(40)      DEFAULT NULL,
  `issue_message`            TEXT             DEFAULT NULL,
  `refund_txn_id`            VARCHAR(30)      DEFAULT NULL,
  `refund_status_code`       VARCHAR(20)      DEFAULT NULL,
  `refund_status_message`    VARCHAR(1000)    DEFAULT NULL,
  `refund_response`          LONGTEXT         DEFAULT NULL,
  `created_at`               TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_health_chola_fc_merchant_txn` (`merchant_txn_id`),
  UNIQUE KEY `uk_health_chola_fc_return_token` (`return_token`),
  KEY `idx_health_chola_fc_proposal` (`gencon_proposal_number`),
  KEY `idx_health_chola_fc_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
