# Signup points communications — implementation checkpoint

This follows the approved loyalty communications stream, without enabling email
delivery or changing the existing signup award policy. The separate nudge PR is
not a dependency of this change; this branch began from public main `4eb83df57c`.

## Scope and contracts

- Use the signup ledger append's real `created` receipt. A replay must return
  before reading current communications settings, so later opt-in cannot turn
  historical signup awards into fresh notices.
- Append an immutable `signup_points_available` event inside the same existing
  store/program-fenced award transaction. The event contains exact positive
  ledger points, store/program/account identity, installation generation, event
  time and the points-earned policy revision; no fabricated order or recipient.
- Reuse the durable LOYALTY_COMMUNICATION delivery machinery. Resolve exact
  EARN_BONUS/SIGNUP_BONUS ledger provenance before delivery and preserve existing
  consent, privacy, current-policy, account, program, generation, retained-message,
  lease, retry and suppression behavior. No purchase grant/order is invented.
- Imports, manual adjustments (including redemption compensation), birthday,
  referrals and activity awards are not signup events. Their communication
  integrations remain distinct follow-up work.

No schema, public API, provider, permission model or activation changes are
included. As with the purchase producer, failed outbox creation must roll back
the newly created award rather than silently lose its notification evidence.

## Current evidence and remaining work

The draft producer, award call site, strict event union and source-specific
delivery checks are implemented. Six focused suites passed 118 tests, including
signup provenance, exact points, replay suppression, disabled policies, wrong
account scope and delivery without an order. The award tests use the actual
ledger receipt but mock the producer boundary; producer and delivery tests use
mocked database/provider adapters. Focused lint passed. No real emails or Shopify
requests were made.

The first test attempt failed because this new worktree lacked built `@dub/utils`
outputs. All four dependency builds then passed, and the focused suites above
were rerun. A prior non-purchase fixture lacked the new producer's database
delegates; it now explicitly mocks and asserts the receipt boundary instead of
claiming end-to-end outbox persistence.

Independent review found no blocking code defect. The web typecheck passed with
the repository's existing 8 GB Node heap convention after the first attempt
exhausted the default heap. No suppressions or compiler changes were made.

The isolated MySQL communication-delivery suite passed all 17 tests on September 10. Three added tests invoke the actual signup award, ledger and outbox paths:
concurrent replay commits one ledger and one communication; later policy opt-in
does not backfill a prior signup; an injected outbox insertion failure rolls back
the real ledger and cached balance. The failure is injected at the transaction's
outbox delegate, not in the ledger. External fetch is forbidden; notification
delivery and customer Redis locking remain mocked as documented in the suite.
This proves local SQL transaction behavior, not live signup or email delivery.

The final web typecheck, including the added integration tests, passed. A second
independent review found no publication-blocking defect. Concurrent requests were
tested, but this is not a forced lock-wait interleaving proof.

The initial full regression run reported 5,916 passes, six skips and four failures.
Three failures came from the existing synthetic non-purchase stress harness not
mocking the newly introduced communication producer; its boundary is now explicit.
The fourth was the unchanged 50 ms in-memory latency assertion (observed 64.9 ms)
under parallel load. Both affected suites passed all 79 tests with one worker;
no production behavior, timeout or benchmark threshold was changed. The complete
bounded-concurrency rerun passed: 384 files, 5,920 tests and six skipped, in
435.17 seconds. Full web lint, changed-file formatting and Prisma validation
passed.

The embedded Shopify application's typecheck, 27 package tests and production
build passed. Existing sourcemap and framework future-flag warnings remain; the
build exited successfully and did not deploy anything.

The expanded SQL suite passed all 19 tests, including signup retained-message
redaction before and after worker completion. It used a second fresh schema-only
database, separate from the web build's read-only grant. Independent postflight
counts confirmed zero rows in all ten checked fixture tables, and the temporary
test grant was revoked. The earlier 17-test result is superseded by this run.

The isolated web production build also passed, including type validation and all
367 static pages. Existing CSS/framework/cache warnings remain. Independent
postflight counts found zero fixture rows and the temporary read-only grant was
revoked. Both test and build databases remain isolated and empty.

Still required: public CI and named live acceptance. Public main's
post-PR-21 run `34477541465` completed successfully; that is separate evidence,
not CI for this signup draft.

## Deployment gate

Existing strict workers accept only the purchase source. Upgrade all event
readers/workers before enabling signup-producing web processes, or use a
coordinated drained rollout. Old workers reject the new source, so rolling them
back after events have been produced is unsafe. Deployment and real delivery
remain explicit execution gates; this checkpoint does not authorize either.
