-- Additive only. Stage/inspect before enabling the audited writer or privacy
-- workers. This file does not authorize a shared-database rollout.
CREATE TABLE `WeleticReviewModerationAudit` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `actorKind` VARCHAR(32) NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `appId` VARCHAR(191) NULL,
    `installationGeneration` VARCHAR(64) NULL,
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
    INDEX `review_moderation_store_created`(`storeId`, `createdAt`, `id`),
    INDEX `review_moderation_redaction`(`storeId`, `redactedAt`, `id`),
    UNIQUE INDEX `review_moderation_version_unique`(`storeId`, `reviewId`, `toVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
