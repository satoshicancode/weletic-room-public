-- PR 4 stage 1: dedicated referral friend-email delivery leases.
-- Apply to staging before merging the Prisma schema change.
ALTER TABLE `WeleticLoyaltyReferral`
  ADD COLUMN `friendEmailLeaseToken` VARCHAR(64) NULL,
  ADD COLUMN `friendEmailLeaseReservedAt` DATETIME(3) NULL,
  ADD COLUMN `friendEmailLeaseExpiresAt` DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000',
  ADD COLUMN `friendEmailDeliveryAttempts` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `friendEmailLastError` TEXT NULL,
  ADD INDEX `wl_referral_email_lease_idx` (`storeId`, `friendEmailLeaseExpiresAt`);
