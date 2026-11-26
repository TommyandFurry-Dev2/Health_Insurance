-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 006 — health_journey_drafts: break / resume for the health journey
--
-- One row per buyer journey: what they TYPED on the Search page and on any
-- insurer's proposal form, saved as they go, so a buyer who leaves part way can
-- verify their mobile again and carry on with every field still filled in.
--
-- WHY A NEW TABLE, AND NOT nivabupa_journeys.step_data
--   nivabupa_journeys belongs to one insurer and is driven by that insurer's
--   upstream calls (its rows default to NIVA_BUPA / REASSURE30). A buyer on the
--   Search page has not chosen an insurer yet — six are quoted at once — so the
--   draft cannot live in one insurer's tables. Nothing here replaces or touches
--   the NivaBupa journey; the two are independent.
--
-- WHO A DRAFT BELONGS TO
--   mobile + pan. The mobile is the one the buyer verified (the session token
--   carries it — see src/helpers/healthJourneySession.helper.js); the PAN is
--   the one entered with it at the start of the journey. Mobile alone is not
--   enough: an agent logs in with their own mobile and buys for many
--   customers, and must get back each customer's draft, not the last one typed.
--
-- WHAT IS NOT HERE
--   No premium, quote reference, payment or policy data — those belong to the
--   insurer and go stale; a resumed journey re-quotes. No Aadhaar, CKYC,
--   document, bank or OTP values either: the service strips those before
--   writing (src/constants/healthJourney.constants.js SENSITIVE_*).
--
-- NO FOREIGN KEY TO users
--   Unlike nivabupa_journeys, a draft does not create a row in the host
--   application's users table. A draft is a convenience for an anonymous buyer;
--   inventing an account for everyone who reaches the Search page would be a
--   much bigger change to a table this service does not own.
--
-- Additive only: no existing table is touched. Idempotent (IF NOT EXISTS).
-- Engine/charset as in 001: InnoDB + utf8mb4.
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

CREATE TABLE IF NOT EXISTS `health_journey_drafts` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid`                  CHAR(36)        NOT NULL COMMENT 'public journey id held by the SPA',
  `mobile`                VARCHAR(10)     NOT NULL COMMENT 'verified mobile — the owner',
  `pan`                   CHAR(10)        NOT NULL COMMENT 'PAN entered with the mobile; picks whose journey this is',
  `status`                ENUM('IN_PROGRESS','COMPLETED','ABANDONED','EXPIRED')
                                          NOT NULL DEFAULT 'IN_PROGRESS',
  `current_step`          VARCHAR(20)     NOT NULL DEFAULT 'SEARCH' COMMENT 'step of the latest save',
  `furthest_step`         VARCHAR(20)     NOT NULL DEFAULT 'SEARCH' COMMENT 'never moves backwards',
  `insurer_code`          VARCHAR(30)         NULL COMMENT 'insurer whose proposal form was last saved',
  -- Text with a json_valid() check on MariaDB, a native JSON column on MySQL —
  -- the same `JSON` declaration 001 uses. Bound as a plain string (db.toJson).
  `form_data`             JSON                NULL COMMENT 'user-entered values only, by section',
  `verification`          ENUM('OTP','UNVERIFIED') NOT NULL DEFAULT 'OTP'
                                          COMMENT 'how the session that created it proved the mobile',
  `completion_reference`  VARCHAR(100)        NULL COMMENT 'policy / proposal number reported at completion',
  `save_count`            INT UNSIGNED    NOT NULL DEFAULT 0,
  `resume_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_activity_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`            DATETIME        NOT NULL COMMENT 'sliding: pushed forward on every save and resume',
  `completed_at`          DATETIME            NULL,
  `abandoned_at`          DATETIME            NULL,
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_hj_drafts_uuid` (`uuid`),
  -- The resume lookup: newest IN_PROGRESS draft for one mobile + PAN.
  KEY `idx_hj_drafts_owner`  (`mobile`, `pan`, `status`, `last_activity_at`),
  -- The sweeper: IN_PROGRESS drafts past expires_at.
  KEY `idx_hj_drafts_expiry` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Health journey break/resume drafts — see migrations/006';
