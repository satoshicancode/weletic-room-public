-- CreateTable
CREATE TABLE `WeleticRewardCouponUse` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `redemptionId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `orderExternalId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `usedAt` DATETIME(3) NOT NULL,
    `discountAmountMinor` BIGINT NULL,
    `currency` VARCHAR(3) NULL,
    `amountUnavailableReason` VARCHAR(64) NULL,
    `priorRedemptionStatus` VARCHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `wl_coupon_use_shopper_idx`(`storeId`, `shopperId`, `createdAt`, `id`),
    INDEX `wl_coupon_use_order_idx`(`storeId`, `orderExternalId`),
    INDEX `wl_coupon_use_store_id_idx`(`storeId`, `id`),
    UNIQUE INDEX `wl_coupon_use_order_uq`(`storeId`, `redemptionId`, `orderExternalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `wl_reward_store_id_uq` ON `WeleticRewardRedemption`(`storeId`, `id`);
