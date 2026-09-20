-- Additive reader-before-writer rollout. Rehearse only in isolated SQL first.
-- This does not enable uploads; invitation media keeps its original requestId.
ALTER TABLE `WeleticReviewMedia`
  MODIFY COLUMN `requestId` VARCHAR(191) NULL,
  ADD UNIQUE KEY `review_media_owned_id` (`storeId`, `id`);

CREATE TABLE `WeleticOpenReviewMediaOwnership` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `mediaId` VARCHAR(191) NOT NULL,
  `shopperId` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `submissionKey` VARCHAR(64) NOT NULL,
  `idempotencyKey` VARCHAR(64) NOT NULL,
  `contentDigest` VARCHAR(64) NULL,
  `settingsRevision` INTEGER NOT NULL,
  `storageWriteState` VARCHAR(16) NOT NULL DEFAULT 'not_started',
  `storageWriteToken` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `redactedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `open_review_media_id` (`mediaId`),
  UNIQUE KEY `open_review_media_owner` (`storeId`, `mediaId`),
  UNIQUE KEY `open_review_media_operation` (`storeId`, `idempotencyKey`),
  KEY `open_review_media_author_rate` (`storeId`, `shopperId`, `createdAt`),
  KEY `open_review_media_submission` (`storeId`, `submissionKey`),
  KEY `open_review_media_privacy` (`storeId`, `redactedAt`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
