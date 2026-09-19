-- Additive isolated rehearsal first; shared/production application needs approval.
-- Pause review writers, create table, deploy history-aware readers, then enable
-- reviewed activation writers. Never roll back to processing-time policy readers
-- after activation history exists. Preserve history and saved invitation policies.
CREATE TABLE `WeleticReviewIncentiveActivation` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `policyId` VARCHAR(191) NOT NULL,
  `policyRevision` INTEGER NOT NULL,
  `previousPolicyId` VARCHAR(191) NULL,
  `contentDigest` VARCHAR(64) NOT NULL,
  `effectiveAt` DATETIME(3) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `shopifyUserId` VARCHAR(20) NOT NULL,
  `merchantActionId` VARCHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `WeleticReviewIncentiveActivation_merchantActionId_key` (`merchantActionId`),
  UNIQUE INDEX `WeleticReviewIncentiveActivation_storeId_policyId_key` (`storeId`, `policyId`),
  UNIQUE INDEX `WeleticReviewIncentiveActivation_storeId_policyRevision_key` (`storeId`, `policyRevision`),
  INDEX `review_incentive_activation_effective` (`storeId`, `effectiveAt`, `policyRevision`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
