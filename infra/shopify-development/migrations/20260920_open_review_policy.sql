-- Additive reader-before-writer migration. No activation or existing settings changes.
-- Foreign keys are managed by the application (Prisma relationMode = prisma).
CREATE TABLE `WeleticOpenReviewPolicy` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `revision` INT NOT NULL,
  `snapshot` JSON NOT NULL,
  `contentDigest` VARCHAR(64) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `shopifyUserId` VARCHAR(20) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `WeleticOpenReviewPolicy_storeId_revision_key` (`storeId`, `revision`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
