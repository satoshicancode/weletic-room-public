-- Draft additive reader-before-writer migration. Not applied by this change.
-- No activation, seed data, foreign keys or changes to historical product reviews.
-- Prisma relationMode=prisma: ownership is enforced by locked application writes.
CREATE TABLE `WeleticStoreReviewSettings` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `requestEmailEnabled` BOOLEAN NOT NULL DEFAULT false,
    `autoPublish` BOOLEAN NOT NULL DEFAULT false,
    `sendAfterDays` INTEGER NOT NULL DEFAULT 7,
    `expiresAfterDays` INTEGER NOT NULL DEFAULT 30,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WeleticStoreReviewSettings_storeId_key`(`storeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticStoreReviewRequest` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `incentivePolicyId` VARCHAR(191) NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `settingsRevision` INTEGER NOT NULL,
    `status` ENUM('queued', 'sending', 'sent', 'submitted', 'expired', 'cancelled', 'failed') NOT NULL DEFAULT 'queued',
    `fulfilledAt` DATETIME(3) NOT NULL,
    `sendAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `tokenHash` VARCHAR(64) NULL,
    `encryptedDeliveryToken` TEXT NULL,
    `encryptedDeliverySnapshot` MEDIUMTEXT NULL,
    `deliveryToken` VARCHAR(64) NULL,
    `deliveryLeaseExpiresAt` DATETIME(3) NULL,
    `deliveryReservedAt` DATETIME(3) NULL,
    `deliveryAttempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancellationReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WeleticStoreReviewRequest_tokenHash_key`(`tokenHash`),
    INDEX `WeleticStoreReviewRequest_orderId_idx`(`orderId`),
    INDEX `WeleticStoreReviewRequest_storeId_shopperId_idx`(`storeId`, `shopperId`),
    INDEX `WeleticStoreReviewRequest_storeId_incentivePolicyId_idx`(`storeId`, `incentivePolicyId`),
    INDEX `store_review_request_due`(`storeId`, `status`, `sendAt`, `id`),
    INDEX `store_review_request_lease`(`status`, `deliveryLeaseExpiresAt`),
    INDEX `store_review_request_expiry`(`expiresAt`, `id`),
    UNIQUE INDEX `WeleticStoreReviewRequest_storeId_id_key`(`storeId`, `id`),
    UNIQUE INDEX `WeleticStoreReviewRequest_storeId_orderId_key`(`storeId`, `orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticStoreReviewRequestLine` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `orderLineId` VARCHAR(191) NOT NULL,
    `purchasedQuantity` INTEGER NOT NULL,

    INDEX `WeleticStoreReviewRequestLine_storeId_requestId_idx`(`storeId`, `requestId`),
    INDEX `WeleticStoreReviewRequestLine_orderLineId_idx`(`orderLineId`),
    UNIQUE INDEX `WeleticStoreReviewRequestLine_requestId_orderLineId_key`(`requestId`, `orderLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticStoreReview` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NULL,
    `requestId` VARCHAR(191) NULL,
    `source` ENUM('invitation', 'open', 'imported') NOT NULL,
    `status` ENUM('pending', 'published', 'hidden', 'rejected', 'redacted') NOT NULL DEFAULT 'pending',
    `version` INTEGER NOT NULL DEFAULT 1,
    `rating` INTEGER NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `body` TEXT NOT NULL,
    `displayName` VARCHAR(80) NOT NULL,
    `locale` VARCHAR(8) NOT NULL,
    `merchantReply` TEXT NULL,
    `verifiedPurchase` BOOLEAN NOT NULL DEFAULT false,
    `incentivized` BOOLEAN NOT NULL DEFAULT false,
    `participationStatus` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `participationValidatedAt` DATETIME(3) NULL,
    `participationValidationRevision` VARCHAR(64) NULL,
    `participationContentDigest` VARCHAR(64) NULL,
    `rewardStatus` ENUM('pending', 'awarded', 'ineligible', 'reversed', 'invalidated', 'recovery_pending', 'unrecoverable') NOT NULL DEFAULT 'ineligible',
    `rewardLedgerId` VARCHAR(191) NULL,
    `rewardReason` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `moderatedAt` DATETIME(3) NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WeleticStoreReview_requestId_key`(`requestId`),
    INDEX `WeleticStoreReview_storeId_shopperId_idx`(`storeId`, `shopperId`),
    INDEX `store_review_listing`(`storeId`, `status`, `createdAt`, `id`),
    INDEX `store_review_privacy`(`storeId`, `redactedAt`, `id`),
    UNIQUE INDEX `WeleticStoreReview_storeId_id_key`(`storeId`, `id`),
    UNIQUE INDEX `WeleticStoreReview_storeId_requestId_key`(`storeId`, `requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticStoreReviewModerationAudit` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `actorKind` VARCHAR(32) NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `appId` VARCHAR(191) NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `merchantActionId` VARCHAR(64) NULL,
    `reasonCode` VARCHAR(32) NOT NULL,
    `reasonDetails` TEXT NULL,
    `fromVersion` INTEGER NOT NULL,
    `toVersion` INTEGER NOT NULL,
    `fromStatus` ENUM('pending', 'published', 'hidden', 'rejected', 'redacted') NOT NULL,
    `toStatus` ENUM('pending', 'published', 'hidden', 'rejected', 'redacted') NOT NULL,
    `replyChanged` BOOLEAN NOT NULL,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `store_review_moderation_created`(`storeId`, `createdAt`, `id`),
    INDEX `store_review_moderation_privacy`(`storeId`, `redactedAt`, `id`),
    UNIQUE INDEX `store_review_moderation_version`(`storeId`, `reviewId`, `toVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
