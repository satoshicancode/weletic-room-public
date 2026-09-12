# Import scheduling evidence — September 13, 2026

## Result and boundary

Two real, isolated MySQL tests demonstrate that a future `scheduledFor` or
`nextRetryAt` legitimately returns an empty worker poll. Neither poll changes the
job, source or accounts, consumes an attempt, nor creates ledger/execution rows. Without
changing either clock or the stored due time, a later eligible poll commits the
one-row synthetic import exactly once. Independent SQL verifies the exact ledger
total and the account balance is checked against the source opening balance.

This is **not** a confirmed root cause for the prior 50,000-row run and is **not**
full-scale import acceptance. No production scheduling or accounting behavior
changes in this work.

## Prior failure

The dedicated 50,000-row lifecycle run stopped after 44,285 committed rows when a
worker invocation returned `processed: 0`, `failed: 0`, `deadLettered: 0`. The test
requires every invocation to process one job. It did not capture the job's due
time or the two clocks at the failure, so clock skew remains a hypothesis.

Source inspection establishes a possible boundary:

- Import continuation scheduling uses the database's `UTC_TIMESTAMP(3)`.
- Outbox eligibility uses application wall-clock time.
- An immediate application poll can precede a stored database-clock due time.

The failed run did not establish terminal commit or rollback correctness. Its
fixture cleanup was independently reconciled, and the dedicated test container
was stopped. The original import worktrees remain preserved.

## Reproduction and evidence

- Test: `apps/web/tests/weletic/historical-import-source-db.integration.test.ts`,
  `leaves a future-due import %s untouched until eligible`.
- Inputs: one synthetic source row per case; due time five seconds in the future;
  real claim/dispatch/acknowledgement path; scoped store and job identifiers.
- No fake timers, transport simulation, external network, Shopify operations, or
  application/database clock changes.
- Fresh generated-schema fixture:
  `127.0.0.1:3307/weletic_loyalty_it_import_scheduling_20260913`.
- Two tests passed. Temporary fixture-only DML permissions were revoked;
  independent SQL confirmed all 157 fixture tables empty afterward.
- The first attempt stopped before test collection because the new worktree's
  `@dub/utils` package was unbuilt. After building it, the rerun passed. The first
  attempt also left the database empty with permissions revoked.

These tests do not prove concurrent worker races, all lifecycle paths, or the
50,000-row terminal accounting totals.

## Next bounded task

Before another expensive full-scale run:

1. Capture sanitized empty-poll diagnostics in the opt-in lifecycle harness:
   application/database times, queue status/due/retry timestamps, attempt count,
   source phase/revision/lease expiry, and completed row counts. Exclude customer
   identities, payloads, source contents, credentials and lease tokens.
2. Distinguish an observed future-due job from a stuck or unexpectedly unavailable
   job. Only then allow a bounded wait for legitimate eligibility. Do not blindly
   retry all empty polls or weaken failure, terminal row-count, independent SQL
   reconciliation, or rollback assertions.
3. Verify due-time waiting and unexpected empty-poll failure paths on small
   fixtures, then the existing bounded lifecycle, before reconsidering 50,000 rows.

Definition of done: small real-worker evidence for both legitimate waiting and
bounded failure, exact commit/rollback totals, sanitized diagnostics and verified
fixture cleanup. Production clock changes would require a separate design
decision; this evidence does not authorize them.
