-- Supports tenant-scoped retained-enrollment series and bounded current-account
-- row exports by recorded enrollment date. Apply only after exact-target schema
-- inventory and a reviewed DDL window; MySQL index creation is not transactional.
CREATE INDEX `WeleticLoyaltyAccount_storeId_enrolledAt_idx`
  ON `WeleticLoyaltyAccount`(`storeId`, `enrolledAt`);
