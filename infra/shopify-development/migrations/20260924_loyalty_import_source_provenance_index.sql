-- Keep the full-source historical-import orphan check indexed without trusting
-- execution claims or a store filter. SQLite expression index on metadata.sourceId.
CREATE INDEX IF NOT EXISTS `wl_import_metadata_source_idx`
  ON `WeleticPointsLedgerEntry`(json_extract(`metadata`, '$.sourceId'));
