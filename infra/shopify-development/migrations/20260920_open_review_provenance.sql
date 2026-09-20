-- Apply with reader-before-writer rollout, only after isolated rehearsal.
-- No open writer or merchant setting is activated by this schema.
CREATE TABLE `WeleticOpenReviewSubmission` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `reviewId` VARCHAR(191) NOT NULL,
  `shopperId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `idempotencyKey` VARCHAR(64) NOT NULL,
  `contentDigest` VARCHAR(64) NULL,
  `settingsRevision` INTEGER NOT NULL,
  `disclosureRevision` VARCHAR(64) NOT NULL,
  `locale` VARCHAR(8) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `redactedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `open_review_source_review` (`reviewId`),
  UNIQUE KEY `open_review_operation` (`storeId`, `idempotencyKey`),
  UNIQUE KEY `open_review_owned_source` (`storeId`, `reviewId`),
  KEY `open_review_author_rate` (`storeId`, `shopperId`, `createdAt`),
  KEY `open_review_source_privacy` (`storeId`, `redactedAt`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
