# Referral email failure privacy — September 10, 2026

## Scope and status

Safety fix published in public PR #18. No real email, order, redemption, installation or
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

## September 12 integration review

Integrated public main `2c9a37ac19` using a normal merge without rewriting branch
history. Independent review of the resulting four-file PR diff found no blocking
source defect: successful delivery, lease predicates and retry behavior remain
unchanged. All 117 focused referral/route/outbox tests, web typecheck, root lint
and changed-file formatting passed. The refreshed full regression passed all 406
files: 6,389 tests passed and six existing tests skipped. Build and refreshed public
CI results are recorded in the PR before a merge decision. No live acceptance
or existing stored-error cleanup is claimed.

## Verification

### Post-installation-merge refresh — September 12

After PR #15 merged as `69149d76d8`, its changes were incorporated through a
normal merge without conflicts. Independent review confirmed the four-file
privacy diff does not alter the new native credential selection, tenant/generation
checks or pre-delivery store authorization. All 117 focused referral/route/outbox
tests, repository lint and changed-file formatting passed on the combined source.
The full regression passed all 436 files: 6,806 tests passed and six existing
tests skipped. The production build, including type validation and all 367 static
pages, passed using only temporary SELECT access to the isolated PR #15 fixture
on port 3307. All 154 tables remained empty and that grant was revoked afterward.
Fresh CI for the resulting commit is required before merging PR #18.

Hiro's continuation instruction approved the specific path-filtered Shopify-check
exception for this backend-only PR. The required Fast Quality Gate and every
applicable check must still pass; this does not change CI configuration or the
general merge policy. No deployment, application startup or real email is included.

### Earlier checkpoints

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
  used public base `98ec37645c`, before expiry PR #17 merged. After rebasing onto
  `b54bc81108`, all 115 tests across seven referral/expiry/outbox suites passed,
  and web typechecking passed. Public CI must verify the final branch. The build used the empty isolated test
  database on `127.0.0.1:3307`, temporary SELECT-only access, and no email-provider
  credentials. Its wrapper revoked the temporary grant on exit.

Tests use mocked delivery and database behavior. They do not prove real provider
delivery, MySQL lease concurrency, complete privacy-worker races or supervision.
Remaining referral communication work includes immutable merchant-policy/event
snapshots, EN/JA/VI content, qualification versus fulfillment boundaries, durable
provider-ready retries, suppression and clawback acceptance. No schema migration
or new authorization model is introduced here.
