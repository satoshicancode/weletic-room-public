-- Migration: 0002_loyalty_import_source_provenance_index.sql
-- Description: Provision expression index for fast JSON metadata source lookup on loyalty ledger entries

CREATE INDEX IF NOT EXISTS "wl_import_metadata_source_idx" ON "WeleticPointsLedgerEntry"(json_extract("metadata", '$.sourceId'));
