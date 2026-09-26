-- Additive proposal only. Apply to a separately approved exact target before dependent readers.
-- No automatic rollback: retain subscription/privacy evidence.
CREATE TABLE `WeleticShopifySubscriptionSnapshot` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `appId` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `partnerAppId` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `pendingInstallationId` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `installationGeneration` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `shopId` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'unavailable',
  `planHandle` varchar(191) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `cancelAtEndOfCycle` tinyint(1) NOT NULL DEFAULT '0',
  `cycleEndsAt` datetime(3) DEFAULT NULL,
  `verifiedAt` datetime(3) DEFAULT NULL,
  `validUntil` datetime(3) DEFAULT NULL,
  `refreshToken` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `revision` int NOT NULL DEFAULT '0',
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shopify_subscription_installation_key` (`appId`,`pendingInstallationId`,`installationGeneration`),
  KEY `shopify_subscription_refresh_index` (`status`,`validUntil`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
