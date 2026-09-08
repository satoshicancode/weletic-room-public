-- Additive expand migration. Never run against a shared environment without approval.
CREATE TABLE `WeleticShopifySessionCoordination` (
    `id` VARCHAR(64) NOT NULL,
    `appId` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(255) NOT NULL,
    `revision` BIGINT NOT NULL DEFAULT 0,
    `leaseEpoch` BIGINT NOT NULL DEFAULT 0,
    `leaseOwnerHash` VARCHAR(64) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WeleticShopifySessionCoordination_shop_idx`(`shop`),
    INDEX `WeleticShopifySessionCoordination_leaseExpiresAt_idx`(`leaseExpiresAt`),
    UNIQUE INDEX `WeleticShopifySessionCoordination_appId_shop_key`(`appId`, `shop`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
