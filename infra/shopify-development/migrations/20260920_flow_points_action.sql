-- DRAFT: isolated rehearsal and review required before applying anywhere shared.
-- Create storage, deploy readers with action admission disabled, then enable
-- reviewed owner controls/writer only after the corresponding acceptance gate.
-- Rollback disables the endpoint/grants, never drops receipts or ledger history.
CREATE TABLE `WeleticShopifyFlowPointsGrant` (
  `id` VARCHAR(64) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `allowCredit` BOOLEAN NOT NULL DEFAULT false,
  `allowDebit` BOOLEAN NOT NULL DEFAULT false,
  `maxAbsolutePointsPerAction` DECIMAL(20,0) NOT NULL,
  `absolutePointsBudget` DECIMAL(20,0) NOT NULL,
  `absolutePointsUsed` DECIMAL(20,0) NOT NULL DEFAULT 0,
  `expiresAt` DATETIME(3) NOT NULL,
  `approvedByShopifyUserId` VARCHAR(20) NULL,
  `approvedMerchantActionId` VARCHAR(64) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `revokedByShopifyUserId` VARCHAR(20) NULL,
  `revokedMerchantActionId` VARCHAR(64) NULL,
  `staffRedactedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `flow_grant_approval_action` (`approvedMerchantActionId`),
  UNIQUE INDEX `flow_grant_revocation_action` (`revokedMerchantActionId`),
  INDEX `flow_grant_store_generation` (`storeId`, `appId`, `installationGeneration`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticShopifyFlowActionRun` (
  `id` VARCHAR(64) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `runKey` VARCHAR(64) NOT NULL,
  `payloadDigest` VARCHAR(64) NOT NULL,
  `grantId` VARCHAR(64) NOT NULL,
  `grantRevision` INTEGER NOT NULL,
  `ledgerEntryId` VARCHAR(191) NOT NULL,
  `pointsDelta` BIGINT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `flow_action_ledger_receipt` (`ledgerEntryId`),
  UNIQUE INDEX `flow_action_durable_run` (`storeId`, `appId`, `runKey`),
  INDEX `flow_action_audit_history` (`storeId`, `createdAt`, `id`),
  INDEX `flow_action_grant` (`grantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
