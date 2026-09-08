-- Historical backfill remediation, stage 1 (additive schema only).
--
-- Preconditions:
--   1. Historical backfill API commits remain disabled.
--   2. No repair command is running.
--   3. Apply to an isolated/staging database first, then run Prisma validate,
--      the database integration suite, and the audit CLI in dry-run mode.
--
-- Do not use this file as authorization to enable commits. The stage-2 audit
-- must report zero unresolved legacy jobs and the overlap concurrency test must
-- be green first.

ALTER TABLE `WeleticPointsLedgerEntry`
  MODIFY COLUMN `entryType` ENUM(
    'EARN_ORDER',
    'EARN_REFERRAL',
    'EARN_BONUS',
    'REDEEM_REWARD',
    'REFUND_REVERSAL',
    'MANUAL_ADJUSTMENT',
    'EXPIRATION',
    'BACKFILL',
    'BACKFILL_CORRECTION',
    'TIER_BONUS'
  ) NOT NULL;

-- Widening preserves existing values while allowing exact thresholds for
-- currencies with three or four minor-unit digits.
ALTER TABLE `WeleticLoyaltyBackfillJob`
  MODIFY COLUMN `minOrderAmount` DECIMAL(18, 4) NULL;

CREATE TABLE `WeleticLoyaltyBackfillOrderSnapshot` (
  `id` VARCHAR(191) NOT NULL,
  `jobId` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `programId` VARCHAR(191) NOT NULL,
  `shopperId` VARCHAR(191) NOT NULL,
  `accountId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `orderVersion` DATETIME(3) NOT NULL,
  `orderStatus` ENUM('pending', 'paid', 'partially_refunded', 'refunded', 'voided') NOT NULL,
  `orderHash` VARCHAR(64) NOT NULL,
  `policyRevisionId` VARCHAR(191) NOT NULL,
  `currency` VARCHAR(191) NOT NULL,
  `eligibleSpend` BIGINT NOT NULL,
  `refundedSpend` BIGINT NOT NULL,
  `orderTotalAmount` BIGINT NOT NULL,
  `projectedPoints` BIGINT NOT NULL,
  `pointsPerCurrencyUnit` DECIMAL(10, 4) NOT NULL,
  `effectiveMultiplier` DECIMAL(10, 4) NOT NULL DEFAULT 1.0,
  `lineAllocations` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE KEY `WeleticLoyaltyBackfillOrderSnapshot_jobId_orderId_key` (`jobId`, `orderId`),
  KEY `WeleticLoyaltyBackfillOrderSnapshot_storeId_orderId_idx` (`storeId`, `orderId`),
  KEY `WeleticLoyaltyBackfillOrderSnapshot_jobId_accountId_idx` (`jobId`, `accountId`),
  KEY `WeleticLoyaltyBackfillOrderSnapshot_shopperId_idx` (`shopperId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticLoyaltyBackfillOrderCredit` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `programId` VARCHAR(191) NOT NULL,
  `jobId` VARCHAR(191) NOT NULL,
  `snapshotId` VARCHAR(191) NOT NULL,
  `orderId` VARCHAR(191) NOT NULL,
  `accountId` VARCHAR(191) NOT NULL,
  `status` ENUM('claimed', 'credited') NOT NULL DEFAULT 'claimed',
  `points` BIGINT NOT NULL,
  `ledgerEntryId` VARCHAR(191) NULL,
  `earnGrantId` VARCHAR(191) NULL,
  `creditedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE KEY `WeleticLoyaltyBackfillOrderCredit_snapshotId_key` (`snapshotId`),
  UNIQUE KEY `WeleticLoyaltyBackfillOrderCredit_ledgerEntryId_key` (`ledgerEntryId`),
  UNIQUE KEY `WeleticLoyaltyBackfillOrderCredit_earnGrantId_key` (`earnGrantId`),
  UNIQUE KEY `WeleticLoyaltyBackfillOrderCredit_storeId_orderId_key` (`storeId`, `orderId`),
  KEY `WeleticLoyaltyBackfillOrderCredit_jobId_status_idx` (`jobId`, `status`),
  KEY `WeleticLoyaltyBackfillOrderCredit_accountId_createdAt_idx` (`accountId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
