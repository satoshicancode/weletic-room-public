-- CreateIndex
CREATE INDEX IF NOT EXISTS "wl_import_metadata_source_idx" ON "WeleticPointsLedgerEntry"(json_extract("metadata", '$.sourceId'));
