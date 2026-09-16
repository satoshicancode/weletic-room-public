# VIP tier grace — September 16, 2026

Status: isolated implementation/test evidence, not live acceptance.

## Existing merchant contract restored

The EN/JA/VI editor describes blank tier grace as the program default. Runtime
now resolves explicit internal override, current-tier grace, program grace, then
30 days, in that order. Zero is valid and is not replaced by a fallback.

New expiry-sweep jobs omit a grace override so the evaluator can use the tier
setting. Existing queued jobs with explicit overrides remain compatible. The
outbox validator now accepts zero, matching the merchant contract; omission stays
omission rather than acquiring a default at the queue boundary.

An already committed `tierExpiresAt` remains authoritative after setting edits.
Zero keeps the existing two-step lifecycle: record a due-now grace deadline, then
demote on the due review. No new immediate-transition semantics, schema migration,
entry-bonus rules, history rewrite or generation-fence changes are introduced.

## Evidence

- Seven focused suites: 173 tests passed, covering tier precedence, scheduler
  payloads, outbox validation and existing VIP/campaign contracts.
- Actual isolated MySQL VIP selection: 10 tests passed. Three new cases exercise
  tier override, program fallback and zero, persisted deadlines despite later
  edits, exact-boundary demotion and no additional entry bonus.
- Entire isolated communication/VIP database suite: 59 tests passed. Existing
  tests include concurrent promotion, transactional entry bonus/history/notice,
  rollback and stale installation generations.
- Independent SQL postflight checked all 157 schema tables and found no rows.
- Independent adversarial review found no blockers in precedence, scheduling,
  persisted deadlines, legacy payload compatibility or accounting fences.
- Web and Shopify typechecks/builds, web lint, Prisma validation and formatting
  passed. The web build generated 367 static pages with existing CSS/configuration
  and missing-local-service warnings. Temporary database access was revoked;
  the isolated MySQL container and Docker Desktop were stopped afterward.

The disposable database is separate from the retained development database.
Orders and fixtures are synthetic; notification delivery and the customer Redis
mutex are mocked; external fetch is forbidden. Passing these tests is neither
real email delivery nor a distributed Redis-lock claim.

## Remaining VIP/campaign work

Named yamaxdev merchant edits, real purchase progression, entry rewards,
downgrade/grace history and communication delivery still require live acceptance.
No checkbox in the unified matrix is closed by this document.

Additional coverage remains for actual worker-handler replay of both due-now
review jobs across more than two tiers with zero grace. The current handler unit
fixture mocks the evaluator; the new database cases exercise the evaluator and
persisted jobs directly, not that complete worker sequence.

Campaign database acceptance remains separate: exact schedule boundaries,
SKU/collection and VIP intersections, immutable captured rules, concurrent
allocation/replay, partial/full refunds and independent ledger/line SQL
conservation. Existing pure/mocked campaign tests are not those database proofs.
