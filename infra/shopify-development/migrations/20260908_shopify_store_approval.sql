-- Apply only after target review and a recoverable snapshot. No activation is
-- performed by checking in this migration. Retained stores keep their previous
-- operational eligibility; every subsequently created store requires approval.
ALTER TABLE WeleticShopifyStore
  ADD COLUMN storeAccessState ENUM('pending_approval', 'active', 'suspended') NOT NULL DEFAULT 'active',
  ADD COLUMN storeAccessRevision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE WeleticShopifyStore
  ALTER COLUMN storeAccessState SET DEFAULT 'pending_approval';

CREATE TABLE WeleticShopifyStoreAccessChange (
  id VARCHAR(64) NOT NULL,
  storeId VARCHAR(191) NOT NULL,
  installationGeneration VARCHAR(64) NOT NULL,
  previousState ENUM('pending_approval', 'active', 'suspended') NOT NULL,
  nextState ENUM('pending_approval', 'active', 'suspended') NOT NULL,
  revision INTEGER NOT NULL,
  operator VARCHAR(191) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE INDEX WeleticShopifyStoreAccessChange_storeId_revision_key (storeId, revision)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
