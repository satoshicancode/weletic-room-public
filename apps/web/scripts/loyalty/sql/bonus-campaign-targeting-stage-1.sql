-- PR 5 stage 1: additive, normalized bonus-campaign line targeting.
-- Null values preserve the existing broadcast/VIP-only behavior.
ALTER TABLE `WeleticLoyaltyBonusCampaign`
  ADD COLUMN `eligibleSkus` JSON NULL,
  ADD COLUMN `eligibleCollectionIds` JSON NULL;
