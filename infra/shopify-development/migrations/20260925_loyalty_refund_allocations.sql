-- Add immutable line-level evidence for new refund reversal events.
-- SQLite / Cloudflare D1 schema definition.
CREATE TABLE IF NOT EXISTS "WeleticLoyaltyRefundAllocation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeId" TEXT NOT NULL,
  "ledgerEntryId" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "refundId" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "points" BIGINT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefundAllocation_store_ledger_line_key"
  ON "WeleticLoyaltyRefundAllocation"("storeId", "ledgerEntryId", "orderLineId");

CREATE INDEX IF NOT EXISTS "WeleticLoyaltyRefundAllocation_storeId_grantId_orderLineId_idx"
  ON "WeleticLoyaltyRefundAllocation"("storeId", "grantId", "orderLineId");

CREATE INDEX IF NOT EXISTS "WeleticLoyaltyRefundAllocation_storeId_refundId_idx"
  ON "WeleticLoyaltyRefundAllocation"("storeId", "refundId");
