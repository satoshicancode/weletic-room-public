-- Supports bounded, tenant-scoped UTC ledger activity reads and exports.
CREATE INDEX `WeleticPointsLedgerEntry_storeId_createdAt_idx`
  ON `WeleticPointsLedgerEntry`(`storeId`, `createdAt`);
