-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 003 — NivaBupa KYC (CKYC OTP flow)
--
-- One row per KYC attempt, keyed by the kyc_reference_id this service generates
-- for it. That reference is what the SPA sends to underwriting and Data Push
-- (X-NivaBupa-Kyc-Request-Id), so both can find the KYC NivaBupa verified.
--
-- WHY a table of its own rather than nivabupa_journey_kyc
--   nivabupa_journey_kyc is one row per journey and its journey_id is NOT NULL,
--   but the NivaBupa proposal flow runs without a journey. journey_id is
--   recorded here when a journey happens to be in context.
--
-- ckyc_request_id / ckyc_transaction_id are NivaBupa's CYCRequestId and
-- CKYCTransactionID from EKYCOTPDetailEnc. They stay server-side: the OTP is
-- verified and re-sent against them without the browser ever holding them.
--
-- verified_response holds NivaBupa's decrypted EKYCDetailEnc response, written
-- only once NivaBupa has verified the OTP. It is the source of the verified
-- PROPOSER.KYC values Data Push sends — never the browser.
--
-- Additive only: no existing table is touched. Idempotent (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

USE `policy_db`;

CREATE TABLE IF NOT EXISTS `nivabupa_kyc_requests` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kyc_reference_id`     VARCHAR(40)     NOT NULL,
  `application_no`       VARCHAR(40)     NOT NULL COMMENT 'also the proposal SOURCING_APPNO',
  `journey_id`           BIGINT UNSIGNED NULL,
  `pan`                  VARCHAR(10)     NOT NULL,
  `mobile`               VARCHAR(15)     NOT NULL,
  `ckyc_request_id`      VARCHAR(40)     NULL COMMENT 'NivaBupa CYCRequestId',
  `ckyc_transaction_id`  VARCHAR(40)     NULL COMMENT 'NivaBupa CKYCTransactionID',
  `status`               ENUM('PENDING','OTP_SENT','VERIFIED','FAILED') NOT NULL DEFAULT 'PENDING',
  `ckyc_status`          VARCHAR(60)     NULL,
  `status_message`       VARCHAR(255)    NULL,
  `ckyc_number`          VARCHAR(30)     NULL,
  `verify_attempts`      INT UNSIGNED    NOT NULL DEFAULT 0,
  `verified_response`    JSON            NULL,
  `verified_at`          DATETIME        NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_nb_kyc_req_reference` (`kyc_reference_id`),
  KEY `idx_nb_kyc_req_application` (`application_no`),
  KEY `idx_nb_kyc_req_journey`     (`journey_id`),
  KEY `idx_nb_kyc_req_status`      (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
