-- Reader-before-writer preparation only. Existing invitation IDs and purchase
-- flags are preserved. Do not enable requestless writers until source, media,
-- export/purge, authorization and no-incentive acceptance gates pass.
-- Rehearse in an isolated database; shared application remains an explicit gate.
ALTER TABLE `WeleticProductReview`
  MODIFY COLUMN `requestId` VARCHAR(191) NULL,
  ALTER COLUMN `verifiedPurchase` SET DEFAULT 0;
