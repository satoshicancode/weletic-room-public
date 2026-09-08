-- ADR 0015 stage 1: additive and intentionally nullable.
-- Establish and retain the runbook's kill-switch + drained-worker maintenance
-- fence before applying this reviewed SQL. Run the global canonical
-- audit/backfill immediately afterward with the explicit maintenance-fence
-- acknowledgement. Do not deploy application code or apply the final Prisma
-- NOT NULL + UNIQUE constraint while the persisted-state audit reports any
-- invalid, collision, NULL, mismatch, duplicate, or quarantined row.
ALTER TABLE `WeleticRewardRedemption`
  ADD COLUMN `shopifyDiscountCodeCanonical` VARCHAR(191)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN `settlementQuarantinedAt` DATETIME(3) NULL,
  ADD COLUMN `settlementQuarantineReason` TEXT NULL;
