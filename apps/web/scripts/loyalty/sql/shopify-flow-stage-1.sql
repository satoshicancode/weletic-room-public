-- PR 6 stage 1: native Shopify Flow delivery and lifecycle state.
-- Baseline: main after native reviews (#53). Preserve every existing enum value.
-- Apply to staging before merging the Prisma schema change.
-- Current bootstrap also retains the additive shopper-coupon job label.
-- Existing Flow installations use the dated shopper_coupon_outbox expansion.
ALTER TABLE `WeleticLoyaltyOutboxJob`
  MODIFY COLUMN `jobType` ENUM(
    'HOLDING_PERIOD_RELEASE',
    'INACTIVITY_EXPIRY',
    'TIER_REVIEW',
    'METAFIELD_SYNC',
    'REDEMPTION_RECOVERY',
    'BIRTHDAY_REWARD',
    'REFERRAL_REWARD_PROVISION',
    'VOUCHER_PRIVACY_CLEANUP',
    'REVIEW_REQUEST_EMAIL',
    'REVIEW_SUMMARY_SYNC',
    'REVIEW_MEDIA_CLEANUP',
    'FLOW_TRIGGER',
    'SHOPPER_REWARD_PROVISION'
  ) NOT NULL;

CREATE TABLE `WeleticShopifyFlowTriggerState` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `triggerDefinitionId` VARCHAR(191) NOT NULL,
  `shopifyStoreId` VARCHAR(32) NOT NULL,
  `hasEnabledFlow` BOOLEAN NOT NULL,
  `observedAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `WeleticShopifyFlowTriggerState_storeId_triggerDefinitionId_key`
    (`storeId`, `triggerDefinitionId`),
  INDEX `WeleticShopifyFlowTriggerState_storeId_hasEnabledFlow_idx`
    (`storeId`, `hasEnabledFlow`),
  INDEX `WeleticShopifyFlowTriggerState_observedAt_idx` (`observedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
