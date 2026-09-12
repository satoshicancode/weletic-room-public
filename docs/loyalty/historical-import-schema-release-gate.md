# Historical import schema release gate

Status: implementation checkpoint, September 12, 2026. **PR #13 remains draft;
this document does not authorize a shared schema change, merge, deployment, or
worker startup.**

## Why the gate is required

The import branch adds mandatory customer export, customer erasure, and shop
erasure phases. Those phases query source/snapshot/execution tables even when
merchant imports are unused. Missing infrastructure must fail and retry; it must
never be interpreted as an empty export or completed erasure.

Keep environments on the previous application version until their schema has
passed the reviewed release gate. Merely disabling imports in the merchant UI
does not protect privacy processing. The audit below is an operator preflight,
not an automatic startup hook, and does not itself make this branch deployable.

## Read-only audit

With an explicitly selected target and a read-only database credential injected
through the environment, run from `apps/web`:

```sh
pnpm exec tsx scripts/loyalty/audit-historical-import-schema.ts
```

The command does not load another checkout's environment, read shopper rows,
apply DDL, start workers, or print connection credentials. Exit zero and
`ready: true` mean the inspected import contract matches; any other outcome
blocks this release. Re-run after DDL and immediately before deploying the exact
reviewed application commit. Record target identity privately, commit SHA,
observation time, and the normalized audit result. Do not put credentials or
connection strings in the public repository.

The audit checks:

- All three import tables are InnoDB base tables.
- Exact import column inventory, types, nullability, defaults, collation, and
  generated-column attributes; exact integer/decimal accounting types.
- Required ordered/full-width unique and lookup indexes. Unapproved unique
  constraints, including additional prefixed duplicates, fail closed.
- Required import and communication outbox labels in an explicitly recognized
  lineage, plus job-type field attributes.
- Nullable tier-history destination and its field attributes, needed for
  rollback to no prior tier.

It is a targeted compatibility check, not a full infrastructure/security audit.
It does not certify grants, server configuration, triggers, unrelated tables,
queue supervision, application versions already running, concurrency, or live
privacy acceptance. Those release checks remain required independently.

## Enum reconciliation and DDL boundaries

The local-only `scripts/dev/apply-loyalty-import-execution-schema.ts` now uses
the shared pure enum planner. It recognizes the historical public prefix,
optionally followed by the known local-only `REVIEW_POINTS_FULFILL`, and the
known communication/import suffixes. Missing labels are appended, never inserted
ahead of existing values. Unknown values, reordering, and partial import pairs
are rejected for manual investigation. This preserves existing MySQL enum
ordinals even when the public and isolated-local lineages differ.

The script still accepts only `127.0.0.1:3307/weletic_loyalty_dev` with its existing
identity checks and defaults to printing a proposal. It is **not** a general
migration runner, does not create the three import tables, and was **not applied**
in this checkpoint. Earlier DDL hashes/receipts describe their historical script
versions; they are not approvals of a newly generated statement list.

For an existing target, first approve its exact additive DDL and rollout order.
MySQL DDL is not transactionally reversible. After partial application, inspect
actual metadata and generate a new proposal; do not blindly rerun old SQL or
drop tables to roll back. Any newer schema must remain compatible with the old
application during a staged rollout. No force push, shared schema application,
CI pipeline change, or automatic deployment is part of this checkpoint.

## Required acceptance and deferred work

1. Independently review exact target metadata and additive DDL, including all
   source/snapshot/execution tables and mixed-version behavior.
2. Obtain explicit approval before modifying an existing shared/production
   schema or deploying schema-dependent application/compliance workers.
3. Run this preflight on that exact target before and after the approved DDL.
4. Demonstrate privacy failure retains its checkpoint, then real retry cleans
   the same tenant's records after schema availability; verify independent SQL.
5. Complete import commit/rollback races, worker-generation rejection,
   authenticated merchant journeys, and full 50,000-row execution/reconciliation.
6. Record named `yamaxdev` acceptance before claiming live completion.

The original dirty checkout remains preserved. Subsequent PR #13 checkpoints
integrate approved grouped rollback, bounded populated-source continuation and
isolated signed-gateway evidence; see the current implementation receipts.
None removes this shared-schema gate or supplies Shopify-authenticated browser
or live acceptance. Provenance and containment checks remain mandatory.
