-- Review and explicit application approval required. No shared schema execution
-- is authorized by the implementation PR. Apply before enabling this runtime.
-- MySQL DDL is not atomic: snapshot first and keep auth/privacy/operator writers
-- stopped across both CREATE statements and any interrupted recovery.
CREATE TABLE `WeleticShopifyPendingInstallation` (
  `id` VARCHAR(64) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `identityKeyId` VARCHAR(64) NOT NULL,
  `shopDomainDigest` VARCHAR(64) NOT NULL,
  `installationGeneration` VARCHAR(64) NULL,
  `state` ENUM('pending_approval', 'mapped', 'uninstalled', 'redacted') NOT NULL DEFAULT 'pending_approval',
  `revision` INTEGER NOT NULL DEFAULT 1,
  `mappedStoreId` VARCHAR(191) NULL,
  `authenticatedAt` DATETIME(3) NULL,
  `uninstalledAt` DATETIME(3) NULL,
  `redactedAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `pending_installation_identity_key` (`appId`, `identityKeyId`, `shopDomainDigest`),
  UNIQUE INDEX `WeleticShopifyPendingInstallation_mappedStoreId_key` (`mappedStoreId`),
  INDEX `WeleticShopifyPendingInstallation_state_expiresAt_idx` (`state`, `expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `WeleticShopifyPendingInstallationChange` (
  `id` VARCHAR(64) NOT NULL,
  `pendingInstallationId` VARCHAR(64) NOT NULL,
  `mappedStoreId` VARCHAR(191) NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `revision` INTEGER NOT NULL,
  `operation` VARCHAR(32) NOT NULL,
  `operator` VARCHAR(191) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `pending_installation_audit_revision_key` (`pendingInstallationId`, `revision`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
