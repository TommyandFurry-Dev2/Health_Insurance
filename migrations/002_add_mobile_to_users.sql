-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 002 — add `mobile` to the existing users table
--
-- Isolated in its own file because `users` belongs to the host Laravel
-- application, not to this service. Keeping the one change to a table we do not
-- own separate from the nivabupa_* schema means it can be reviewed, and
-- reverted, on its own.
--
-- WHY mobile is needed
--   nivabupa_journeys identifies buyers by mobile number. It is the field
--   mandatory on both POST /nivabupa/payment/initiate and
--   POST /nivabupa/proposal-status, so it is the one identifier guaranteed to
--   exist for any journey that can reach payment — and it is what
--   POST /nivabupa/journey/resume-by-mobile looks a returning buyer up by,
--   which is the resume path that works from a new device or after browser
--   storage is cleared.
--
-- WHY this is safe for the host application
--   * Additive only. No existing column is modified, renamed, or dropped.
--   * NULLable with no default, so every existing row stays valid and any
--     INSERT the host app already performs keeps working untouched.
--   * UNIQUE, but MySQL treats NULLs as distinct in a unique index, so any
--     number of host-app rows may leave mobile empty. Only real numbers are
--     forced to be unique — which is the constraint journeys rely on.
--
-- Idempotent: MySQL has no ADD COLUMN IF NOT EXISTS, so both statements are
-- guarded by an information_schema check and the file can be re-run safely.
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

USE `policy_db`;

-- ── mobile column ──────────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = 'policy_db'
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'mobile'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `users`
     ADD COLUMN `mobile` VARCHAR(15) NULL
     COMMENT ''insurance journey identity key; see migrations/002''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── unique index on mobile ─────────────────────────────────────────────────
-- Unique rather than a plain index: user.repository.findOrCreateByMobile relies
-- on one row per number, and enforcing that in the database instead of in
-- application code is what stops two concurrent journey-create requests for the
-- same buyer from producing two user rows.
SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = 'policy_db'
    AND TABLE_NAME = 'users'
    AND INDEX_NAME = 'uk_users_mobile'
);
SET @sql := IF(@index_exists = 0,
  'ALTER TABLE `users` ADD UNIQUE KEY `uk_users_mobile` (`mobile`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
