-- Add immutable line-level evidence for new refund reversal events. Apply to
-- the exact target before deploying the writer or wallet reconciliation reader.
-- Historical ledger entries stay without allocations and remain unavailable.
CREATE TABLE `WeleticLoyaltyRefundAllocation` (
  `id` VARCHAR(191) NOT NULL,
  `storeId` VARCHAR(191) NOT NULL,
  `ledgerEntryId` VARCHAR(191) NOT NULL,
  `grantId` VARCHAR(191) NOT NULL,
  `refundId` VARCHAR(191) NOT NULL,
  `orderLineId` VARCHAR(191) NOT NULL,
  `points` BIGINT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `RefundAllocation_store_ledger_line_key`
    (`storeId`, `ledgerEntryId`, `orderLineId`),
  INDEX `WeleticLoyaltyRefundAllocation_storeId_grantId_orderLineId_idx`
    (`storeId`, `grantId`, `orderLineId`),
  INDEX `WeleticLoyaltyRefundAllocation_storeId_refundId_idx`
    (`storeId`, `refundId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
