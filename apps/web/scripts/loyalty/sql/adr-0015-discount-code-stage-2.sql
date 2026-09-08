-- ADR 0015 stage 2: final cardinality gate.
-- Run only while the writer/drain maintenance fence is still active and after
-- the global `loyalty:migrate-discount-codes` audit reports
-- readyForFinalConstraint=true, scopedAuditOnly=false, and empty persisted
-- NULL/mismatch/duplicate/quarantine sets. A `--store` audit cannot authorize
-- this global constraint. Resolve every open canonical collision/invalid-code
-- issue against Shopify first. This statement intentionally fails if any
-- canonical value is NULL or duplicated; the preceding persisted-value audit
-- additionally proves that canonical == NFKC(trim(raw)).uppercase for each row.
ALTER TABLE `WeleticRewardRedemption`
  MODIFY COLUMN `shopifyDiscountCodeCanonical` VARCHAR(191)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  ADD CONSTRAINT `wl_redemption_store_code_canonical_uq`
    UNIQUE (`storeId`, `shopifyDiscountCodeCanonical`);
