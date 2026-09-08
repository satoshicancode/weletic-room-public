-- Additive, nullable policy envelopes preserve existing behavior through
-- application-level legacy defaults until each merchant saves explicit terms.
ALTER TABLE `WeleticLoyaltyEarningRule`
  ADD COLUMN `purchasePolicy` JSON NULL;

ALTER TABLE `WeleticRewardDefinition`
  ADD COLUMN `purchasePolicy` JSON NULL;

ALTER TABLE `WeleticLoyaltyReferralRule`
  ADD COLUMN `purchasePolicy` JSON NULL;
