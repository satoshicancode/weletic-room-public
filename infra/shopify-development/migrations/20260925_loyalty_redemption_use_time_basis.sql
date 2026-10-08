-- Additive provenance for reward use timestamps. Apply to the exact release
-- target before deploying writers or privacy readers that use these columns.
-- Historical rows remain NULL; do not infer an event time from usedAt alone.
ALTER TABLE `WeleticRewardRedemption`
  ADD COLUMN `usedAtBasis` VARCHAR(32) NULL;

ALTER TABLE `WeleticRewardCouponUse`
  ADD COLUMN `usedAtBasis` VARCHAR(32) NULL;
