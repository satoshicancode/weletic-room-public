-- PR 4 stage 2: read-only integrity checks. Every finding count must be zero.
SELECT COUNT(*) AS invalid_email_lease_timestamps
FROM `WeleticLoyaltyReferral`
WHERE `friendEmailLeaseToken` IS NOT NULL
  AND (
    `friendEmailLeaseReservedAt` IS NULL
    OR `friendEmailLeaseExpiresAt` <= `friendEmailLeaseReservedAt`
  );

SELECT COUNT(*) AS orphaned_email_lease_timestamps
FROM `WeleticLoyaltyReferral`
WHERE `friendEmailLeaseToken` IS NULL
  AND `friendEmailLeaseReservedAt` IS NOT NULL;

SELECT COUNT(*) AS delivered_referrals_with_active_email_lease
FROM `WeleticLoyaltyReferral`
WHERE `friendRewardEmailedAt` IS NOT NULL
  AND `friendEmailLeaseToken` IS NOT NULL;

SELECT COUNT(*) AS invalid_email_delivery_attempts
FROM `WeleticLoyaltyReferral`
WHERE `friendEmailDeliveryAttempts` < 0;
