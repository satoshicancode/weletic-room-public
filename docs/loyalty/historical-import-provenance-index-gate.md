# Historical import provenance index release gate

Status: candidate migration and reader; **not applied to any shared target**.
The full-size import acceptance gate remains open. This change makes the
source-wide ledger search indexable; it does not prove 50,000 commits or
rollbacks, worker recovery, or independent financial reconciliation.

## Deployment order

The indexed reader uses `json_extract(metadata, '$.sourceId')` backed by an
SQLite expression index `wl_import_metadata_source_idx` and
therefore runs with indexed lookups once
[`20260924_loyalty_import_source_provenance_index.sql`](../../infra/shopify-development/migrations/20260924_loyalty_import_source_provenance_index.sql)
has completed on its exact database. Under Cloudflare D1 / SQLite, expression
indexes on `json_extract(...)` avoid unindexed table scans without requiring
virtual generated columns or vendor-specific `FORCE INDEX` hints.
In a disposable MySQL round trip, a subsequent `prisma db push` silently
removed **both** the generated column and index because they are outside the
Prisma schema. Do not run `db push` against a migrated target. Treat any schema
sync, repair, or provider-initiated rebuild as requiring a fresh metadata and
read-plan audit before the indexed reader resumes. The rollout must identify
and disable every automatic `db push` path; this remains an unresolved
operational compatibility gate until the exact deployment route is reviewed.
The checked-in `prisma:push` script and Playwright workflow use `db push`; no
checked-in release step was found invoking it. That repository search does not
verify an external deployment platform or operator procedure.

Before approval, capture the target database identity (Cloudflare D1 / SQLite),
existing `WeleticPointsLedgerEntry` definition and indexes, row count, storage
and DDL impact, application/worker revisions, deployment route, rollback
containment, and the approved maintenance window. Verify expression index
compatibility on Cloudflare D1. Record the expected cost and time for index
creation. Do not include credentials or customer rows in the public evidence.

After DDL, inspect SQLite schema definitions (`sqlite_master` or `PRAGMA index_list('WeleticPointsLedgerEntry')`)
for the `wl_import_metadata_source_idx` expression index on `json_extract(metadata, '$.sourceId')`.
Run a read-only exact-source query using `WHERE json_extract(metadata, '$.sourceId') = ?` on a known import
source. Compare its IDs and count with the previous JSON-path reader, including
any foreign-store or orphan evidence, without publishing identifiers. Record
`EXPLAIN QUERY PLAN` showing an indexed `SEARCH ... USING INDEX wl_import_metadata_source_idx` lookup.
Then run the complete import regression suite on the release candidate.

If validation fails, pause the new reader and imports, inspect actual metadata,
and create a forward-compatible repair proposal. The old reader remains the
runtime fallback until the new schema and worker revision are accepted.
An application rollback can use the old reader against the additive index;
do not drop the index as an automatic rollback step.

## Local evidence and limit

The regular isolated import suite passed 44 test suites (776 tests) with zero errors.
Local SQLite query plan inspection confirms that `EXPLAIN QUERY PLAN` produces
`SEARCH WeleticPointsLedgerEntry USING INDEX wl_import_metadata_source_idx (<expr>=?)`
when querying by `json_extract(metadata, '$.sourceId')`.
The indexed lookup remains global after source ownership validation so foreign-store
ledger writes cannot be hidden by a tenant filter. Remote multi-replica D1 write latency
and full-size installed acceptance remain unverified.
