-- Additive expansion after 20260907_shopper_coupon_outbox.sql.
-- Apply only to the explicitly approved target after reviewing its current
-- enum. Upgrade/drain old workers before enabling communication producers.
-- Do not rerun an older bootstrap/expansion over this schema: that would remove
-- this label. Rollback stops producers; retain pending delivery evidence.
ALTER TABLE `WeleticLoyaltyOutboxJob` MODIFY `jobType` ENUM(
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
  'LOYALTY_COMMUNICATION'
) NOT NULL;
