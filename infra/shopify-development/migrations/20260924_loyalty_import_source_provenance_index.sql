-- Keep the full-source historical-import orphan check indexed without trusting
-- execution claims or a store filter. The generated value is only a candidate
-- selector; the reader also checks the original JSON string exactly.
-- Apply before deploying the indexed reader or measuring full-size throughput.
ALTER TABLE `WeleticPointsLedgerEntry`
  ADD COLUMN `importSourceId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    GENERATED ALWAYS AS (
      CAST(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.sourceId')) AS CHAR(191) CHARACTER SET utf8mb4)
    ) VIRTUAL;

CREATE INDEX `wl_import_metadata_source_idx`
  ON `WeleticPointsLedgerEntry`(`importSourceId`);
