-- DRAFT: additive schema; isolated rehearsal only until reviewed rollout.
-- Reader-before-writer deployment and complete backfill/readiness are required.
-- Private identity proofs must never enter public projections or exports.
CREATE TABLE `WeleticReviewPrivacyBackfillAudit` (
    `id` VARCHAR(36) NOT NULL,
    `runId` VARCHAR(36) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NOT NULL,
    `operatorReference` VARCHAR(64) NOT NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `WeleticReviewPrivacyBackfillAudit_storeId_runId_idx`(`storeId`, `runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticReviewOwnerPrivacyCoverage` (
    `storeId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `installationGeneration` VARCHAR(64) NULL,
    `state` ENUM('active', 'redacted') NOT NULL,
    `keySetDigest` CHAR(64) NULL,
    `sourceDigest` CHAR(64) NULL,
    `identityCount` INTEGER NOT NULL DEFAULT 0,
    `redactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `WeleticReviewOwnerPrivacyCoverage_storeId_state_keySetDigest_idx`(`storeId`, `state`, `keySetDigest`),
    PRIMARY KEY (`storeId`, `shopperId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticReviewOwnerPrivacyIdentity` (
    `storeId` VARCHAR(191) NOT NULL,
    `shopperId` VARCHAR(191) NOT NULL,
    `identityKind` ENUM('customer_id', 'customer_email') NOT NULL,
    `identityKeyId` VARCHAR(64) NOT NULL,
    `customerDigest` CHAR(64) NOT NULL,
    INDEX `review_owner_privacy_identity_match`(`storeId`, `identityKind`, `identityKeyId`, `customerDigest`),
    INDEX `WeleticReviewOwnerPrivacyIdentity_identityKeyId_idx`(`identityKeyId`),
    PRIMARY KEY (`storeId`, `shopperId`, `identityKind`, `identityKeyId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
