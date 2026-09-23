# Historical import provenance index release gate

Status: candidate migration and reader; **not applied to any shared target**.
The full-size import acceptance gate remains open. This change makes the
source-wide ledger search indexable; it does not prove 50,000 commits or
rollbacks, worker recovery, or independent financial reconciliation.

## Deployment order

The indexed reader uses `FORCE INDEX (wl_import_metadata_source_idx)` and
therefore cannot run before
[`20260924_loyalty_import_source_provenance_index.sql`](../../infra/shopify-development/migrations/20260924_loyalty_import_source_provenance_index.sql)
has completed on its exact database. A missing index is an error, not an empty
reconciliation. Keep the previous application revision deployed while the
additive DDL is reviewed, approved, applied, and verified; pause new import
work if the target DDL needs a table-lock window. Keep privacy and recovery
workers compatible with persisted jobs. The previous reader can use the newer
schema. Do not deploy the new reader or start a
50,000-row run before the index is visible and its read plan is accepted.
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

Before approval, capture the target database identity, MySQL/Vitess version,
existing `WeleticPointsLedgerEntry` definition and indexes, row count, storage
and DDL impact, application/worker revisions, deployment route, rollback
containment, and the approved maintenance window. Verify generated-column and
index compatibility on that exact provider; the disposable MySQL result alone
does not establish PlanetScale/Vitess support or online DDL behavior. Record
the expected cost and time for both column and index creation. Do not include
credentials or customer rows in the public evidence.

After DDL, inspect `information_schema.COLUMNS` and `information_schema.STATISTICS`
for the binary-collated virtual `importSourceId` column and full-width
`wl_import_metadata_source_idx` index. Run a read-only exact-source query using
both the indexed candidate predicate and `JSON_CONTAINS` on a known import
source. Compare its IDs and count with the previous JSON-path reader, including
any foreign-store or orphan evidence, without publishing identifiers. Record
`EXPLAIN FORMAT=JSON` showing an indexed `ref` lookup. Then run the existing
[historical import schema audit](historical-import-schema-release-gate.md) and
the complete import regression suite on the release candidate.

MySQL DDL may be only partially applied. If validation fails, pause the new
reader and imports, inspect actual metadata, and create a forward-compatible
repair proposal. Do not assume the `ALTER TABLE` and `CREATE INDEX` statements
roll back together. The old reader remains the runtime fallback until the
new schema and worker revision are accepted. An application rollback can use
the old reader against the additive column/index; do not drop the index as an
automatic rollback step.

## Local evidence and limit

The regular isolated import suite passed 50 tests with 11 opt-in cases skipped.
An additional opt-in disposable-MySQL test passed: it compares the indexed
selector with the old Prisma JSON predicate, including an unclaimed same-source
ledger row, and checks an indexed `ref` plan with 999 unrelated synthetic
entries. The fixtures were removed after each run, and the retained local
ledger count remained unchanged. These entries are not financial acceptance
data. The indexed lookup remains global after source ownership validation so
foreign-store ledger writes cannot
be hidden by a tenant filter. The exact JSON predicate guards against
generated-column cast collisions. Source IDs use the existing 191-character
MySQL key contract. Target migration, provider compatibility, full-size load,
and installed acceptance are unverified.
