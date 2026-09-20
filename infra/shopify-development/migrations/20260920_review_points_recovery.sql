-- Additive queue expansion. Rehearse on a disposable isolated database before
-- separately approved shared rollout. Preserve all existing enum ordinals.
-- Deploy the compatible reader/worker before enabling recovery producers.
ALTER TABLE `WeleticLoyaltyOutboxJob`
  MODIFY COLUMN `jobType` ENUM(
    'HOLDING_PERIOD_RELEASE',
    'INACTIVITY_EXPIRY',
    'TIER_REVIEW',
    'METAFIELD_SYNC',
    'REDEMPTION_RECOVERY',
    'BIRTHDAY_REWARD',
    'REFERRAL_REWARD_PROVISION',
    'VOUCHER_PRIVACY_CLEANUP',
    'REVIEW_REQUEST_EMAIL',
    'REVIEW_SUMMARY_SYNC',
    'REVIEW_MEDIA_CLEANUP',
    'FLOW_TRIGGER',
    'SHOPPER_REWARD_PROVISION',
    'LOYALTY_COMMUNICATION',
    'HISTORICAL_IMPORT_COMMIT',
    'HISTORICAL_IMPORT_ROLLBACK',
    'REVIEW_POINTS_RECOVERY'
  ) NOT NULL;

ALTER TABLE `WeleticReviewIncentiveClaim`
  ADD COLUMN `recoveryDiscoveryCheckedAt` DATETIME(3) NULL;
CREATE INDEX `review_claim_recovery_scan`
  ON `WeleticReviewIncentiveClaim` (`status`, `subjectType`, `recoveryDiscoveryCheckedAt`, `id`);
