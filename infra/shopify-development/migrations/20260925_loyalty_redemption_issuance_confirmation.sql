-- Persist local confirmation of a remote reward artifact. Existing rows stay
-- NULL because reservation/creation time cannot establish remote issuance.
-- Exact-target metadata and mixed-version writers must be reviewed before DDL.
ALTER TABLE `WeleticRewardRedemption`
  ADD COLUMN `issuanceConfirmedAt` DATETIME(3) NULL;

CREATE INDEX `WeleticRewardRedemption_storeId_issuanceConfirmedAt_idx`
  ON `WeleticRewardRedemption`(`storeId`, `issuanceConfirmedAt`);
