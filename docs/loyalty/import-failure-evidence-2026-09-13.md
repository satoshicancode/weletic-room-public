# Full-scale import failure evidence — September 13, 2026

## Observed result

The dedicated loopback MySQL rerun of PR #33's candidate
`720d69a15123bea12a9333a147cb2b50d84f6c9d` failed. Last confirmed progress was
8,100 committed rows out of 50,000, across 162 successful worker deliveries.
The next worker result reported `processed: 1`, `failed: 1`, `deadLettered: 0`.
The unchanged harness assertion requires zero failures and correctly rejected it.
Neither complete commit nor rollback acceptance was established.

The final successful delivery took 26,755ms. Concurrent local validation was
running, but this is context, not proof of resource contention or a timeout.
The failing call's nested cause was not retained. Do not label its cause as
clock skew, transaction expiry, lease expiry or corruption without new evidence.

The runner revoked temporary fixture privileges and independently verified that
all 157 fixture tables were empty afterward. The original private log remains
preserved. No production data or schema was changed; no full-scale rerun is
authorized or implied by this diagnostic change.

## Diagnostic correction

The runtime import worker intentionally replaces nested errors with a generic
safe message before the outbox persists them. That privacy boundary is unchanged.
The isolated test harness now observes the real recovery, batch and continuation
functions immediately before this boundary. It reports only fixed stage names,
allowlisted Prisma codes and known error-class names, then rethrows the identical
error without retrying. At most eight records are emitted per test.

On failed/dead-lettered delivery, the harness also reads the existing sanitized
job/source clock, lease, revision and row-count evidence before its original
assertion and fixture cleanup. A failed diagnostic read is reported with a fixed
marker; it cannot turn a failure into a pass. Raw messages, SQL, causes, stacks,
payloads, shopper identifiers and lease material are never logged by this path.

These are observed error markers, not root-cause conclusions. Errors sanitized
inside a wrapped primitive cannot be reconstructed. Production retry policy,
timeouts, ledger writes, reconciliation and acceptance assertions are unchanged.

## Verification and next action

The stage observer and existing polling helper pass 32 focused unit tests,
including identity-preserving rethrow, no retry, reporter failure and hostile
error getters. The real expired-lease SQL probe and 500-row commit/rollback run
both passed (2 tests passed, 52 unrelated cases skipped; 99.62 seconds total).
The expired lease rejected the real batch call without ledger or row-execution
writes. The lifecycle completed all 500 commits and rollbacks with the original
financial assertions unchanged. Temporary fixture privileges were revoked, and
independent SQL verified all 157 fixture tables empty afterward.

This evidence comes from the isolated loopback MySQL instance on port 3308, not
a Shopify store or production environment. It does not resolve the earlier
50,000-row failure or establish full-scale acceptance.

The complete web unit suite passed: 498 files, 8,029 passed and 6 skipped
(750.51 seconds). Web typecheck, full repository lint and changed-file formatting
also passed. Independent adversarial review found no blocker. These local checks
do not substitute for full-scale or live acceptance.

After bounded verification, use the diagnostic evidence to design a controlled
reproduction. Do not simply rerun 50,000 rows or relax the zero-failure/financial
assertions. The full-scale requirement remains open under L12.
