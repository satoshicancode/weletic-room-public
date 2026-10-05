-- Migration: 20261005_perf01_relation_composite_indexes.sql
-- Description: Add composite and relationMode indexes for PERF-01 and Invariant 2, and add version column for PERF-06 OCC.

-- 1. PERF-01: WeleticLoyaltyTierHistory
CREATE INDEX `WeleticLoyaltyTierHistory_fromTierId_idx` ON `WeleticLoyaltyTierHistory`(`fromTierId`);

-- 2. PERF-01: WeleticLoyaltyEarnGrant
CREATE INDEX `WeleticLoyaltyEarnGrant_shopperId_idx` ON `WeleticLoyaltyEarnGrant`(`shopperId`);
CREATE INDEX `WeleticLoyaltyEarnGrant_programId_status_idx` ON `WeleticLoyaltyEarnGrant`(`programId`, `status`);

-- 3. PERF-01: WeleticRewardRedemption
CREATE INDEX `WeleticRewardRedemption_rewardDefinitionId_idx` ON `WeleticRewardRedemption`(`rewardDefinitionId`);

-- 4. PERF-01: WeleticLoyaltyBackfillPreviewItem
CREATE INDEX `WeleticLoyaltyBackfillPreviewItem_accountId_idx` ON `WeleticLoyaltyBackfillPreviewItem`(`accountId`);

-- 5. PERF-01: DiscountCode
CREATE INDEX `DiscountCode_programId_disabledAt_idx` ON `DiscountCode`(`programId`, `disabledAt`);
CREATE INDEX `DiscountCode_partnerId_disabledAt_idx` ON `DiscountCode`(`partnerId`, `disabledAt`);

-- 6. PERF-01: FraudAlert
CREATE INDEX `FraudAlert_programId_partnerId_idx` ON `FraudAlert`(`programId`, `partnerId`);
CREATE INDEX `FraudAlert_reviewedById_idx` ON `FraudAlert`(`reviewedById`);

-- 7. PERF-06: WeleticLoyaltyProgram OCC version column
ALTER TABLE `WeleticLoyaltyProgram` ADD COLUMN `version` INT NOT NULL DEFAULT 1;
