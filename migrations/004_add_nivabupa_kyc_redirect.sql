-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 004 — NivaBupa hosted KYC (RedirectionLinkEnc) on the same table
--
-- Migration 003 created nivabupa_kyc_requests for the CKYC OTP flow, where this
-- service asks for the OTP and verifies it. NivaBupa also host the whole KYC
-- step themselves: RedirectionLinkEnc issues a link to their own KYC page, the
-- buyer completes it there (CKYC, Aadhaar, OVD — whatever their page offers for
-- that customer), and GetKycStatusEnc reports the outcome.
--
-- Both flows end the same way — one row in this table, status VERIFIED, with
-- NivaBupa's own response in verified_response — so underwriting and Data Push
-- (services/nivabupaKyc.service.js) keep the single check they already have.
-- That is why this is three columns on the existing table rather than a table
-- of its own.
--
--   partner_request_id  the PartnerRequestId we send. NivaBupa key the KYC
--                       record on it: sending the same one again returns the
--                       SAME link with message "Duplicate Request", which is
--                       what makes a repeated "Verify KYC" click harmless.
--   nbhi_reference_no   NivaBupa's NBHIReferenceNo for the request.
--   redirect_url        the issued link. Active 72 hours, per their document —
--                       stored so a buyer who comes back can be sent to the
--                       same page instead of starting a second KYC record.
--
-- The status ENUM gains LINK_ISSUED, the hosted-flow equivalent of OTP_SENT:
-- the buyer is on NivaBupa's page and nothing is verified yet.
--
-- Additive only: no existing column is modified except the status ENUM, which
-- only gains a value (every stored value stays legal). Idempotent — MySQL has
-- no ADD COLUMN IF NOT EXISTS, so each statement is guarded by an
-- information_schema check and the file can be re-run safely.
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

-- No USE: scripts/migrate.js runs this connected to the database named by
-- DB_DATABASE, whatever it is called on a given server.

-- ── partner_request_id ─────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nivabupa_kyc_requests'
    AND COLUMN_NAME = 'partner_request_id'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `nivabupa_kyc_requests`
     ADD COLUMN `partner_request_id` VARCHAR(40) NULL
     COMMENT ''PartnerRequestId sent to RedirectionLinkEnc'' AFTER `ckyc_transaction_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── nbhi_reference_no ──────────────────────────────────────────────────────
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nivabupa_kyc_requests'
    AND COLUMN_NAME = 'nbhi_reference_no'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `nivabupa_kyc_requests`
     ADD COLUMN `nbhi_reference_no` VARCHAR(40) NULL
     COMMENT ''NivaBupa NBHIReferenceNo'' AFTER `partner_request_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── redirect_url ───────────────────────────────────────────────────────────
-- 600, not 255: the link is an encrypted blob in the path
-- (https://otc1.nivabupa.com/t/KYCDetail/KYCNew/P=<base64>) with no documented
-- ceiling, and a truncated link is a dead link.
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nivabupa_kyc_requests'
    AND COLUMN_NAME = 'redirect_url'
);
SET @sql := IF(@column_exists = 0,
  'ALTER TABLE `nivabupa_kyc_requests`
     ADD COLUMN `redirect_url` VARCHAR(600) NULL
     COMMENT ''NivaBupa-hosted KYC page, active 72h'' AFTER `nbhi_reference_no`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── status ENUM gains LINK_ISSUED ──────────────────────────────────────────
SET @has_value := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nivabupa_kyc_requests'
    AND COLUMN_NAME = 'status'
    AND COLUMN_TYPE LIKE '%LINK_ISSUED%'
);
SET @sql := IF(@has_value = 0,
  'ALTER TABLE `nivabupa_kyc_requests`
     MODIFY COLUMN `status`
     ENUM(''PENDING'',''OTP_SENT'',''LINK_ISSUED'',''VERIFIED'',''FAILED'')
     NOT NULL DEFAULT ''PENDING''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── index on partner_request_id ────────────────────────────────────────────
-- Plain index, not unique: the id is generated per attempt and never reused, but
-- a unique key here would turn a retry that raced into a 500 rather than a
-- second attempt row.
SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'nivabupa_kyc_requests'
    AND INDEX_NAME = 'idx_nb_kyc_req_partner_request'
);
SET @sql := IF(@index_exists = 0,
  'ALTER TABLE `nivabupa_kyc_requests`
     ADD KEY `idx_nb_kyc_req_partner_request` (`partner_request_id`)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
