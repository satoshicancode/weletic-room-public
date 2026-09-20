-- DRAFT: isolated rehearsal and review required before shared application.
-- Schema before readers; keep translation writers/projection disabled until
-- authorization, privacy and concurrency acceptance. Rollback disables writers;
-- do not delete revision tombstones or retained audit evidence.
CREATE TABLE `WeleticProductReviewTranslation` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `reviewId` VARCHAR(191) NOT NULL,
  `locale` VARCHAR(8) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `sourceReviewVersion` INTEGER NOT NULL,
  `sourceDigest` VARCHAR(64) NULL,
  `sourceLocale` VARCHAR(8) NULL,
  `title` VARCHAR(120) NULL,
  `body` TEXT NULL,
  `redactedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `review_translation_locale` (`storeId`, `reviewId`, `locale`),
  UNIQUE INDEX `WeleticProductReviewTranslation_storeId_id_key` (`storeId`, `id`),
  INDEX `review_translation_privacy` (`storeId`, `redactedAt`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticReviewTranslationAudit` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `translationId` VARCHAR(191) NOT NULL,
  `fromRevision` INTEGER NOT NULL,
  `toRevision` INTEGER NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `sourceReviewVersion` INTEGER NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `actorShopifyUserId` VARCHAR(20) NULL,
  `merchantActionId` VARCHAR(64) NOT NULL,
  `staffRedactedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `review_translation_action` (`merchantActionId`),
  UNIQUE INDEX `review_translation_audit_revision` (`storeId`, `translationId`, `toRevision`),
  INDEX `review_translation_actor_privacy` (`storeId`, `staffRedactedAt`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
