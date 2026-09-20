# Review privacy backfill — internal operator procedure

Status: local implementation under verification. Shared/production migration,
execution and release remain separately gated. This command is not a public API
or a Shopify staff-authentication mechanism. It is for a trusted operator with
approved, isolated database credentials and the complete retained privacy keyring.
An operator reference is an opaque audit label, never an email or an access grant.

## Before execution

- Verify the exact environment, approved store ID and installation generation.
- Rehearse the checked-in owner-privacy DDL in isolated SQL. Do not run the command
  against a database without its audit table or substitute production credentials.
- Retain all keys still referenced by privacy proofs/tombstones. A backfill is not
  authority to remove keys, repair ambiguous proofs or clear privacy suppression.
- Use a private directory outside the repository for checkpoints. Files include
  internal owner cursors and a private key-set proof; never publish or attach them.
- Assign a UUID-v4 run ID and a 1–64 character alphanumeric/underscore/hyphen
  operator reference. Record the execution authorization in the private run record.

## Preview then apply one bounded page

From `apps/web`, with explicitly selected approved runtime credentials:

```sh
pnpm exec tsx scripts/loyalty/backfill-review-privacy.ts \
  --store STORE_ID --generation GENERATION --limit 50
```

This performs a scoped selection only: no projection or audit writes. Output is
counts plus a selection digest, not shopper identities or key proofs. Preview
does **not** guarantee that every selected owner can be projected. Current source,
privacy, generation and key guards execute again during apply.

```sh
pnpm exec tsx scripts/loyalty/backfill-review-privacy.ts \
  --store STORE_ID --generation GENERATION --limit 50 \
  --apply --expected-preview PREVIEW_DIGEST \
  --operator OPERATOR_REFERENCE --run-id RUN_UUID \
  --checkpoint-output /PRIVATE_DIRECTORY/page-001.json
```

Apply rejects a different selection, scope, generation, key configuration, limit
or starting cursor. The digest is a confirmation guard, not authorization or a
claim that source values cannot change. Every owner is independently locked and
revalidated. Projection and its operation audit row commit together.

The output file is reserved exclusively with mode `0600` before writes; an
existing file or final-path symlink is rejected. stdout contains only counts and
`hasMore`. The checkpoint contains `null` at scan end, otherwise a private scoped
cursor. To continue, use `--checkpoint /PRIVATE_DIRECTORY/page-001.json` on both
the next preview and apply, retain the same run ID, and supply a NEW output path.
Input must be an owned private regular file, not a symlink, and at most 8 KiB.

## Failure, replay and reconciliation

- Errors are sanitized and exit nonzero. Earlier owners may already have committed.
- Termination/output failure can leave an empty or partial output file. It is not
  a valid resume token. Keep the previous valid checkpoint; preview and replay from
  it using a new output path. Do not guess a later cursor from audit operation counts.
- Replays are projection-idempotent but append another audit operation. Audit row
  counts are committed operations, **not unique owners**. Inspect the private audit
  table by exact store/run/generation and reconcile with persisted coverage.
- A completed scan does not prove readiness: owners inserted before the cursor,
  source changes, writer inventory, key rotation and suppressed-source cleanup
  require independent reconciliation. Restart from the beginning when needed.
- Run `inspect-review-privacy.ts` with the exact store/generation to assess current
  publishable-reader coverage. Even a complete reader snapshot is not production
  readiness or evidence that all historical sources were reconciled.
- Do not delete financial history, tombstones or provenance to make a check pass.

Audit storage access and retention must be finalized before shared rollout.
Keep checkpoints only in the approved private operational location and dispose
of exact files after their run's reconciliation/retention requirements are met.
No automatic audit deletion or broad filesystem cleanup is performed by this tool.

## Independent source reconciliation

```sh
pnpm exec tsx scripts/loyalty/inspect-review-privacy.ts \
  --store STORE_ID --generation GENERATION --sources \
  --page-size 50 --max-pages 100
```

This read-only scan includes unpublished review owners and independently derives
expected proofs from persisted shopper identity. It compares exact identity
tuples, source/key digests, generation and coverage state. Counts distinguish
matched, missing, mismatched, invalid-source, suppressed-clean and
suppressed-pending projections. Suppressed-clean concerns only the pseudonymized
customer-ID/email and cleared projection; it does not certify complete privacy
erasure of reviews, media, other profile fields, exports or providers.

Retained proofs participate in tombstone matching even when a legacy source
writer changed an email without updating coverage. The command never repairs,
deletes or publishes data. It also reports a first-page snapshot count of reviews
with missing/cross-store owner references, which an owner scan would omit.

Page size and page count are each bounded to 1–100. Truncation, unresolved counts
or orphan references produce nonzero exit status. Output contains counts only,
not owner cursors, customer identity or key fingerprints. Each page is a separate
Repeatable Read snapshot, so concurrent inserts before the cursor or later edits
can invalidate a completed scan. Writer inventory/fencing and final reconciliation
remain required before rollout. Zero findings is not production readiness.

### Local source-writer inventory (September 20)

Search of `apps/web/lib`, `apps/web/app` and `apps/web/scripts` identified these
direct Prisma shopper mutation paths; tests/seeds are not runtime writer evidence:

| Path                                                     | Identity effect                                    | Projection obligation                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/weletic/loyalty/shopper.ts`                         | Customer ingestion/upsert, including email updates | Checks old persisted source, then replaces coverage from final source in the same transaction; real generation required                                  |
| `lib/weletic/loyalty/shopper-privacy.ts`                 | Customer pseudonymization                          | Clears projection and CAS-updates scoped source in the same transaction                                                                                  |
| `lib/weletic/shopify/compliance-worker.ts`               | Whole-shop pseudonymization                        | Clears projection and CAS-updates scoped source in the same transaction                                                                                  |
| `lib/weletic/commerce/record-order.ts`                   | Direct update changes order count/segments only    | Identity ingestion delegates to shared shopper upsert                                                                                                    |
| `scripts/loyalty/validate-financial-reward-lifecycle.ts` | Explicit test-fixture shopper creation             | Not a production ingestion path; requires its own live execution approval. Missing review coverage must stay fail-closed until normal ingestion/backfill |

Legacy stores without a real installation generation do not receive active
coverage. This repository search does not prove absence of external database
writers, old deployed processes or operator SQL. Before release, reconcile the
actual deployed writer inventory, fence old processes, apply reviewed schema in
reader-before-writer order and rerun source/reader checks. Do not treat this table
as evidence that those operational steps have already happened.
