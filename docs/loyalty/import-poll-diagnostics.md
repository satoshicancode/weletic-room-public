# Historical import poll diagnostics

## Scope

The opt-in real-database lifecycle harness now records sanitized evidence when a
worker returns an entirely empty result. This is test support, not a production
retry policy or a change to either application or database clocks.

An empty poll may wait only when the observed job is pending, unclaimed, has
consumed no failure attempts, and has an eligibility timestamp later than the
poll's start. The source must still have the expected phase and completed-row
count, with no live execution lease according to the database clock. The later
of `scheduledFor` and `nextRetryAt` controls the wait.

Waiting is limited to three polls and a ten-second eligibility budget. An
already-due job, missing job/source, changed progress, active claim/lease, invalid
timestamp or exhausted budget fails explicitly. Worker failures/dead letters are
returned unchanged to the existing assertions, never retried by this helper.
The budget does not interrupt a stalled worker or SQL call; existing transaction
and test timeouts remain necessary.

## Evidence and privacy

Diagnostics whitelist application/database time, queue status/due/retry/claim
timestamps, attempts, source status/revision/lease expiry and completed row count.
They exclude store/customer/job/source identifiers, raw payloads, source contents,
credentials, staff IDs and claim/lease tokens. Unexpected status strings are
represented as `unknown`, not copied into logs.

Twenty-two focused unit cases passed, covering future due/retry times, unchanged
worker failure results, unexplained empty states, malformed timestamps, time and
poll bounds, and exclusion of accidental extra fields/private status text.

Three real MySQL cases passed in fresh isolated fixture
`127.0.0.1:3307/weletic_loyalty_it_import_poll_20260913`:

- Future scheduled time: one observed empty poll, then a successful real import.
- Future retry time: the same real scheduling behavior using the retry timestamp.
- Missing job: one empty poll fails explicitly without changing the real fixture
  job/source or creating an account/ledger balance.

Both successful cases verify exact cached balances and independent SQL ledger
totals. The fixture's temporary DML grant was revoked and all 157 tables were
independently confirmed empty after the three-case run.

The existing 500/50,000-row lifecycle calls this helper without removing its
per-delivery progress, failure, terminal status, row-count, independent SQL or
rollback assertions. The real 500-row lifecycle passed in 114.3 seconds: terminal
commit and rollback, 1,000 total ledger entries with zero net points afterward,
and 500 zero-balance accounts at ledger version 2. Independent cleanup again
confirmed 157 empty tables and revoked fixture-only DML permissions. This run
did not encounter a natural empty poll; the three small fixtures provide that
path's direct evidence. Web type-check, focused lint, formatting and adversarial
review also passed.

Full-scale acceptance remains open. These diagnostics do
not retroactively establish the cause of the earlier 44,285-row stop.

No shared schema application, Cloudflare deployment, Shopify operation, customer
import, email or loyalty activation is performed by this change.
