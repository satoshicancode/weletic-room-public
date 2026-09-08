-- Additive isolated-stage migration. No grant backfill or activation.
-- Existing tables must be inspected, not silently accepted with IF NOT EXISTS.
CREATE TABLE `WeleticShopifyStaffGrant` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `shopifyUserId` VARCHAR(20) NOT NULL,
    `permissions` JSON NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `updatedByShopifyUserId` VARCHAR(20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `WeleticShopifyStaffGrant_storeId_updatedAt_idx`(`storeId`, `updatedAt`),
    UNIQUE INDEX `shopify_staff_grant_scope`(`storeId`, `appId`, `installationGeneration`, `shopifyUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticShopifyMerchantAction` (
    `id` VARCHAR(64) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `requestId` VARCHAR(64) NOT NULL,
    `shopifyUserId` VARCHAR(20) NOT NULL,
    `owner` BOOLEAN NOT NULL,
    `permission` VARCHAR(64) NOT NULL,
    `grantRevision` INTEGER NULL,
    `targetShopifyUserId` VARCHAR(20) NULL,
    `changedPermissions` JSON NULL,
    `changedGrantRevision` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `WeleticShopifyMerchantAction_storeId_createdAt_id_idx`(`storeId`, `createdAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
