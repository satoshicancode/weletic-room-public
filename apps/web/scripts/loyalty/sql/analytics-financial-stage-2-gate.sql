-- Loyalty financial analytics remediation, stage 2 release-gate queries.
-- This file is intentionally read-only. Every count must be zero before the
-- corrected financial analytics are marked live-proven.

-- Configurations must be either fully absent or fully populated with positive
-- integers and a canonical ISO-style currency code.
SELECT COUNT(*) AS invalid_or_partial_valuation_configs
FROM `WeleticLoyaltyProgram`
WHERE NOT (
  (`liabilityValuationCurrency` IS NULL
    AND `liabilityMinorUnitsNumerator` IS NULL
    AND `liabilityPointsDenominator` IS NULL)
  OR
  (`liabilityValuationCurrency` IS NOT NULL
    AND CHAR_LENGTH(`liabilityValuationCurrency`) = 3
    AND `liabilityValuationCurrency` REGEXP '^[A-Z]{3}$'
    AND BINARY `liabilityValuationCurrency` = BINARY UPPER(`liabilityValuationCurrency`)
    AND `liabilityMinorUnitsNumerator` > 0
    AND `liabilityPointsDenominator` > 0)
);

-- A configured valuation is denominated only in the core program accounting
-- currency; shop and presentment currencies are never valid substitutes.
SELECT COUNT(*) AS valuation_accounting_currency_mismatches
FROM `WeleticLoyaltyProgram` loyalty
JOIN `WeleticShopifyStore` store ON store.`id` = loyalty.`storeId`
JOIN `Program` program ON program.`id` = store.`programId`
WHERE loyalty.`liabilityValuationCurrency` IS NOT NULL
  AND BINARY loyalty.`liabilityValuationCurrency`
    <> BINARY UPPER(program.`accountingCurrency`);

-- Referral economics use accountingNet for qualifying rewarded/qualified
-- orders. Any mismatch makes those monetary metrics unavailable.
SELECT COUNT(*) AS referral_accounting_currency_mismatches
FROM `WeleticLoyaltyReferral` referral
JOIN `WeleticCommerceOrder` commerceOrder
  ON commerceOrder.`id` = referral.`qualifyingOrderId`
JOIN `WeleticLoyaltyProgram` loyalty
  ON loyalty.`storeId` = referral.`storeId`
WHERE referral.`status` IN ('qualified', 'rewarded')
  AND loyalty.`liabilityValuationCurrency` IS NOT NULL
  AND BINARY commerceOrder.`accountingCurrency`
    <> BINARY loyalty.`liabilityValuationCurrency`;

-- A qualified/rewarded referral must retain its attributed commerce order.
SELECT COUNT(*) AS missing_referral_qualifying_orders
FROM `WeleticLoyaltyReferral` referral
LEFT JOIN `WeleticCommerceOrder` commerceOrder
  ON commerceOrder.`id` = referral.`qualifyingOrderId`
  AND commerceOrder.`storeId` = referral.`storeId`
WHERE referral.`status` IN ('qualified', 'rewarded')
  AND (referral.`qualifyingOrderId` IS NULL OR commerceOrder.`id` IS NULL);

-- Cohort AOV/LTV use accountingTotal for every non-voided order. A mismatched
-- row fails the cohort monetary contract closed.
SELECT COUNT(*) AS cohort_accounting_currency_mismatches
FROM `WeleticCommerceOrder` commerceOrder
JOIN `WeleticLoyaltyProgram` loyalty
  ON loyalty.`storeId` = commerceOrder.`storeId`
WHERE commerceOrder.`status` <> 'voided'
  AND loyalty.`liabilityValuationCurrency` IS NOT NULL
  AND BINARY commerceOrder.`accountingCurrency`
    <> BINARY loyalty.`liabilityValuationCurrency`;

-- The persisted validator is the authoritative reconciliation gate because it
-- compares production service results with independent SQL totals inside one
-- repeatable-read transaction:
--   pnpm loyalty:validate-analytics -- --store=<shop-domain> --live \
--     --confirm-staging --json
