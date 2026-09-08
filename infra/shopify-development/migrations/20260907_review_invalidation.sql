-- AlterTable
ALTER TABLE `WeleticShopifyVoucherCleanup` MODIFY `source` ENUM('customer_redact', 'app_uninstalled', 'shop_redact', 'review_invalidation') NOT NULL;

-- CreateTable
CREATE TABLE `WeleticReviewIncentiveInvalidation` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `claimId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `decisionId` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(64) NOT NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `decisionSnapshot` JSON NOT NULL,
    `outcome` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `cleanupId` VARCHAR(191) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `wl_review_invalidation_shopper_idx`(`storeId`, `shopperId`, `id`),
    INDEX `wl_review_invalidation_work_idx`(`storeId`, `outcome`, `id`),
    UNIQUE INDEX `wl_review_invalidation_decision_uq`(`storeId`, `decisionId`),
    UNIQUE INDEX `wl_review_invalidation_claim_uq`(`storeId`, `claimId`),
    UNIQUE INDEX `wl_review_invalidation_cleanup_uq`(`storeId`, `cleanupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `wl_review_claim_store_id_uq` ON `WeleticReviewIncentiveClaim`(`storeId`, `id`);
