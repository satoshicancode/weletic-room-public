-- ADR 0025. Additive draft; explicit runtime application approval is required.
-- No credential copying/backfill from custom/private apps or generic integrations.
-- Apply only after snapshot/target review and before enabling its consumers.
CREATE TABLE `WeleticShopifyInstallationCredential` (
  `id` VARCHAR(64) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NOT NULL,
  `revision` INTEGER NOT NULL DEFAULT 1,
  `credentialCiphertext` LONGTEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `shopify_store_app_credential_key` (`storeId`, `appId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
