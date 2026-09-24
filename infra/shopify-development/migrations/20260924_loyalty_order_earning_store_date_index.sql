-- Supports bounded tenant-scoped daily order earning-rate reads and exports.
CREATE INDEX `WeleticCommerceOrder_storeId_occurredAt_idx`
  ON `WeleticCommerceOrder`(`storeId`, `occurredAt`);
