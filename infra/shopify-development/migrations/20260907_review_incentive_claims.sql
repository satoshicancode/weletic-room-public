-- AlterTable
ALTER TABLE `WeleticProductReview` ADD COLUMN `participationContentDigest` VARCHAR(64) NULL,
    ADD COLUMN `participationStatus` VARCHAR(32) NOT NULL DEFAULT 'pending',
    ADD COLUMN `participationValidatedAt` DATETIME(3) NULL,
    ADD COLUMN `participationValidationRevision` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `WeleticReviewRequest` ADD COLUMN `incentivePolicyId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `WeleticReviewSettings` ADD COLUMN `activeIncentivePolicyId` VARCHAR(191) NULL,
    ADD COLUMN `incentivePolicyRevision` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `WeleticReviewIncentivePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `contentDigest` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WeleticReviewIncentivePolicy_storeId_id_key`(`storeId`, `id`),
    UNIQUE INDEX `WeleticReviewIncentivePolicy_storeId_revision_key`(`storeId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WeleticReviewIncentiveClaim` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `policyId` VARCHAR(191) NOT NULL,
    `sourceReviewId` VARCHAR(191) NOT NULL,
    `subjectType` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'reserved',
    `awardSnapshot` JSON NOT NULL,
    `validationSnapshot` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WeleticReviewIncentiveClaim_storeId_shopperId_idx`(`storeId`, `shopperId`),
    INDEX `WeleticReviewIncentiveClaim_storeId_policyId_idx`(`storeId`, `policyId`),
    INDEX `WeleticReviewIncentiveClaim_orderId_idx`(`orderId`),
    UNIQUE INDEX `wl_review_incentive_order_uq`(`storeId`, `orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `WeleticReviewRequest_storeId_incentivePolicyId_idx` ON `WeleticReviewRequest`(`storeId`, `incentivePolicyId`);

-- CreateIndex
CREATE INDEX `WeleticReviewSettings_storeId_activeIncentivePolicyId_idx` ON `WeleticReviewSettings`(`storeId`, `activeIncentivePolicyId`);
