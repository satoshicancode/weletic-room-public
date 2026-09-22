-- Additive reader-before-writer rollout. Rehearse only on isolated SQL first;
-- shared application requires its separate approved execution packet.
ALTER TABLE `WeleticReviewSettings`
  ADD COLUMN `collectionRevision` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `reminderAfterDays` JSON NULL;

ALTER TABLE `WeleticReviewRequest`
  ADD COLUMN `reminderSnapshot` JSON NULL,
  ADD COLUMN `encryptedReminderToken` TEXT NULL;

CREATE TABLE `WeleticReviewReminder` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `requestId` VARCHAR(191) NOT NULL,
  `sequence` INTEGER NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `scheduledFor` DATETIME(3) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `leaseToken` VARCHAR(64) NULL,
  `leaseExpiresAt` DATETIME(3) NULL,
  `encryptedDeliverySnapshot` MEDIUMTEXT NULL,
  `sentAt` DATETIME(3) NULL,
  `settledAt` DATETIME(3) NULL,
  `outcomeReason` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `review_reminder_delivery_uq` (`storeId`, `requestId`, `sequence`),
  INDEX `review_reminder_due` (`status`, `scheduledFor`, `id`),
  INDEX `review_reminder_discovery` (`status`, `updatedAt`, `id`),
  INDEX `review_reminder_request_status` (`storeId`, `requestId`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
