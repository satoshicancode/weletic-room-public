-- Apply only after exact-target review. No inferred/backfilled storefront routes.
CREATE TABLE `WeleticShopifyAppProxyRoute` (
  `storeId` VARCHAR(191) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NULL,
  `pathPrefix` VARCHAR(128) NOT NULL,
  `observedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`storeId`, `appId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
