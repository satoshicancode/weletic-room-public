-- Draft additive migration; apply only with scoped shared-schema approval.
-- Deploy compatible privacy workers before delivery writers. No activation or sends.
-- Identity aliases contain HMACs, never raw email/customer identifiers.
ALTER TABLE `WeleticMerchantSettings` ADD COLUMN `shopperDeliveryPolicy` JSON NULL;

CREATE TABLE `WeleticShopperDeliveryReservation` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `producer` VARCHAR(32) NOT NULL,
    `provider` VARCHAR(16) NOT NULL,
    `contentDigest` VARCHAR(64) NOT NULL,
    `state` ENUM('attempted', 'sent') NOT NULL DEFAULT 'attempted',
    `capacityAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `retryUntil` DATETIME(3) NOT NULL,
    `attemptedAt` DATETIME(3) NULL,
    `sentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `wl_delivery_capacity_idx`(`storeId`, `capacityAt`, `id`),
    UNIQUE INDEX `WeleticShopperDeliveryReservation_storeId_id_key`(`storeId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticShopperDeliveryIdentity` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `reservationId` VARCHAR(64) NOT NULL,
    `identityKind` ENUM('customer_id', 'customer_email') NOT NULL,
    `identityKeyId` VARCHAR(64) NOT NULL,
    `customerDigest` VARCHAR(64) NOT NULL,

    INDEX `wl_delivery_identity_lookup_idx`(`storeId`, `identityKind`, `identityKeyId`, `customerDigest`),
    UNIQUE INDEX `wl_delivery_identity_unique`(`storeId`, `reservationId`, `identityKind`, `identityKeyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Append only: existing persisted enum positions remain unchanged.
ALTER TABLE `WeleticLoyaltyOutboxJob` MODIFY COLUMN `jobType` ENUM('HOLDING_PERIOD_RELEASE', 'INACTIVITY_EXPIRY', 'TIER_REVIEW', 'METAFIELD_SYNC', 'REDEMPTION_RECOVERY', 'BIRTHDAY_REWARD', 'REFERRAL_REWARD_PROVISION', 'VOUCHER_PRIVACY_CLEANUP', 'REVIEW_REQUEST_EMAIL', 'REVIEW_SUMMARY_SYNC', 'REVIEW_MEDIA_CLEANUP', 'FLOW_TRIGGER', 'SHOPPER_REWARD_PROVISION', 'LOYALTY_COMMUNICATION', 'HISTORICAL_IMPORT_COMMIT', 'HISTORICAL_IMPORT_ROLLBACK', 'REVIEW_POINTS_RECOVERY', 'ANONYMOUS_REFERRAL_EMAIL') NOT NULL;
