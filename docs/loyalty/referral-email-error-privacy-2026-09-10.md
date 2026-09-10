# Referral email failure privacy — September 10, 2026

## Scope and status

Unpublished safety fix. No real email, order, redemption, installation or
deployment occurred. This does not connect the referral communication editor or
complete referral delivery acceptance.

The existing friend-email adapter returned provider error messages and logged
thrown provider exceptions. The lease helper also retained arbitrary callback
errors in `friendEmailLastError`. Such errors can contain recipient addresses,
voucher URLs or provider credentials.

The fix records only `Referral email delivery failed` for returned errors,
exceptions and unconfirmed responses. It removes raw exception logging at this
adapter and sanitizes independently at the lease persistence boundary, including
alternate delivery callbacks. Successful delivery, discount issuance, provider
selection, idempotency keys, lease ownership and retry timing are unchanged.
Existing stored errors are not rewritten; historical data cleanup requires its
own scoped audit and authorization.

## Verification

- Five new regression cases failed before the fix, demonstrating returned and
  thrown provider/callback error disclosure plus inconsistent empty-response
  handling. The corrected claim and route suites passed all 30 tests.
- Broader referral, matrix, privacy-snapshot and email-durability suites passed
  all 45 tests after updating one legacy assertion that expected raw timeout text.
  That durability case still verifies the provisioned discount remains available,
  no successful email timestamp is recorded, and the failed lease is released.
- Web typecheck, focused lint, root lint (10 tasks), formatting and diff whitespace
  checks passed. Independent review found no actionable source issues.
- Full unit regression passed: 5,677 tests passed, six skipped, 368 files, in
  593.35 seconds. The production build passed with exit code zero. These runs
  used public base `98ec37645c`, before expiry PR #17 merged; post-rebase
  verification is required before publication. The build used the empty isolated test
  database on `127.0.0.1:3307`, temporary SELECT-only access, and no email-provider
  credentials. Its wrapper revoked the temporary grant on exit.

Tests use mocked delivery and database behavior. They do not prove real provider
delivery, MySQL lease concurrency, complete privacy-worker races or supervision.
Remaining referral communication work includes immutable merchant-policy/event
snapshots, EN/JA/VI content, qualification versus fulfillment boundaries, durable
provider-ready retries, suppression and clawback acceptance. No schema migration
or new authorization model is introduced here.
