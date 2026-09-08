-- Native reviews: additive staging migration based on main #51.
-- Do not apply to shared infrastructure without explicit approval.
-- If PR #52 is merged/applied first, regenerate the outbox ENUM alteration to
-- retain FLOW_TRIGGER before applying this file. Never drop an existing value.
-- AlterTable
ALTER TABLE `WeleticLoyaltyOutboxJob` MODIFY `jobType` ENUM('HOLDING_PERIOD_RELEASE', 'INACTIVITY_EXPIRY', 'TIER_REVIEW', 'METAFIELD_SYNC', 'REDEMPTION_RECOVERY', 'BIRTHDAY_REWARD', 'REFERRAL_REWARD_PROVISION', 'VOUCHER_PRIVACY_CLEANUP', 'REVIEW_REQUEST_EMAIL', 'REVIEW_SUMMARY_SYNC', 'REVIEW_MEDIA_CLEANUP') NOT NULL;

-- CreateTable
CREATE TABLE `WeleticReviewSettings` (
    `storeId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `sendAfterDays` INTEGER NOT NULL DEFAULT 7,
    `expiresAfterDays` INTEGER NOT NULL DEFAULT 30,
    `autoPublish` BOOLEAN NOT NULL DEFAULT false,
    `photoUploadsEnabled` BOOLEAN NOT NULL DEFAULT true,
    `requestEmailEnabled` BOOLEAN NOT NULL DEFAULT false,
    `activatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`storeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WeleticReviewOrderCancellation` (
    `storeId` VARCHAR(191) NOT NULL,
    `orderExternalId` VARCHAR(191) NOT NULL,
    `cancelledAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`storeId`, `orderExternalId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WeleticReviewRequest` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NULL,
    `status` ENUM('queued', 'sending', 'sent', 'submitted', 'expired', 'cancelled', 'failed') NOT NULL DEFAULT 'queued',
    `fulfilledAt` DATETIME(3) NOT NULL,
    `sendAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `tokenHash` VARCHAR(64) NULL,
    `encryptedDeliveryToken` TEXT NULL,
    `deliveryToken` VARCHAR(64) NULL,
    `deliveryReservedAt` DATETIME(3) NULL,
    `deliveryLeaseExpiresAt` DATETIME(3) NULL,
    `deliveryAttempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancellationReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WeleticReviewRequest_tokenHash_key`(`tokenHash`),
    INDEX `WeleticReviewRequest_storeId_status_sendAt_id_idx`(`storeId`, `status`, `sendAt`, `id`),
    INDEX `WeleticReviewRequest_storeId_shopperId_idx`(`storeId`, `shopperId`),
    INDEX `WeleticReviewRequest_status_deliveryLeaseExpiresAt_idx`(`status`, `deliveryLeaseExpiresAt`),
    INDEX `WeleticReviewRequest_orderId_idx`(`orderId`),
    INDEX `WeleticReviewRequest_productId_idx`(`productId`),
    UNIQUE INDEX `WeleticReviewRequest_storeId_orderId_productId_key`(`storeId`, `orderId`, `productId`),
    UNIQUE INDEX `WeleticReviewRequest_storeId_id_key`(`storeId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WeleticReviewRequestLine` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `orderLineId` VARCHAR(191) NOT NULL,
    `purchasedQuantity` INTEGER NOT NULL,

    INDEX `WeleticReviewRequestLine_orderLineId_idx`(`orderLineId`),
    UNIQUE INDEX `WeleticReviewRequestLine_requestId_orderLineId_key`(`requestId`, `orderLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WeleticProductReview` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `status` ENUM('pending', 'published', 'hidden', 'rejected', 'redacted') NOT NULL DEFAULT 'pending',
    `version` INTEGER NOT NULL DEFAULT 1,
    `rating` INTEGER NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `body` TEXT NOT NULL,
    `displayName` VARCHAR(80) NOT NULL,
    `merchantReply` TEXT NULL,
    `verifiedPurchase` BOOLEAN NOT NULL DEFAULT true,
    `incentivized` BOOLEAN NOT NULL DEFAULT false,
    `rewardStatus` ENUM('pending', 'awarded', 'ineligible', 'reversed') NOT NULL DEFAULT 'pending',
    `rewardLedgerId` VARCHAR(191) NULL,
    `rewardReason` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `moderatedAt` DATETIME(3) NULL,
    `moderatedByUserId` VARCHAR(191) NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WeleticProductReview_requestId_key`(`requestId`),
    INDEX `WeleticProductReview_storeId_productId_status_createdAt_id_idx`(`storeId`, `productId`, `status`, `createdAt`, `id`),
    INDEX `WeleticProductReview_storeId_status_createdAt_id_idx`(`storeId`, `status`, `createdAt`, `id`),
    INDEX `WeleticProductReview_storeId_shopperId_idx`(`storeId`, `shopperId`),
    INDEX `WeleticProductReview_productId_idx`(`productId`),
    UNIQUE INDEX `WeleticProductReview_storeId_id_key`(`storeId`, `id`),
    UNIQUE INDEX `WeleticProductReview_storeId_requestId_key`(`storeId`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WeleticReviewMedia` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NULL,
    `objectKey` VARCHAR(191) NOT NULL,
    `contentType` VARCHAR(32) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `status` ENUM('reserved', 'uploaded', 'deletion_pending', 'deleted') NOT NULL DEFAULT 'reserved',
    `uploadExpiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WeleticReviewMedia_objectKey_key`(`objectKey`),
    INDEX `WeleticReviewMedia_storeId_requestId_status_idx`(`storeId`, `requestId`, `status`),
    INDEX `WeleticReviewMedia_storeId_reviewId_idx`(`storeId`, `reviewId`),
    INDEX `WeleticReviewMedia_status_uploadExpiresAt_idx`(`status`, `uploadExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
