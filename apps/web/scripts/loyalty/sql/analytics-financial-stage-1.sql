-- Loyalty financial analytics remediation, stage 1 (additive schema only).
--
-- Apply this reviewed SQL to an isolated/staging database before deploying the
-- application. All columns are nullable so existing programs continue to
-- return monetary metrics as unavailable until an owner saves an exact
-- valuation in the program accounting currency.

ALTER TABLE `WeleticLoyaltyProgram`
  ADD COLUMN `liabilityValuationCurrency` VARCHAR(3) NULL,
  ADD COLUMN `liabilityMinorUnitsNumerator` BIGINT NULL,
  ADD COLUMN `liabilityPointsDenominator` BIGINT NULL;
