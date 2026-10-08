-- Apply only after exact-target review. No inferred/backfilled storefront routes.
CREATE TABLE IF NOT EXISTS `WeleticShopifyAppProxyRoute` (
  `storeId` VARCHAR(191) NOT NULL,
  `appId` VARCHAR(191) NOT NULL,
  `installationGeneration` VARCHAR(64) NULL,
  `pathPrefix` VARCHAR(128) NOT NULL,
  `observedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`storeId`, `appId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Earlier disposable previews created this table before legacy installations
-- were allowed to store a NULL generation. Keep that schema upgrade explicit.
ALTER TABLE `WeleticShopifyAppProxyRoute`
  MODIFY COLUMN `installationGeneration` VARCHAR(64) NULL;
