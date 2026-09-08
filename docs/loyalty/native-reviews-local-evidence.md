# Native reviews: local verification evidence

Date: 2026-09-05 (Asia/Tokyo). This is local implementation evidence, not shared
staging or production certification. See [rollout gates](native-reviews-plan.md).

## Database and service evidence

The existing Docker MySQL 8.0.46 instance was used with a newly created isolated
database, `weletic_loyalty_it_native_reviews_20260905`. No shared database was
modified. The main/#51 schema was installed first; the additive
`apps/web/scripts/loyalty/sql/native-reviews-stage-1.sql` was then applied.

The three suites in `vitest.loyalty-db.config.ts` passed **27 tests**, including
**14 native review tests** invoking production services and real Prisma
transactions. External email/storage transports were mocked; Redis serialization
was deliberately bypassed to test MySQL uniqueness and compare-and-set behavior.

Covered: overlapping request/outbox creation; single-use submission; one
concurrent send through each email transport; lease expiry and stale-worker
finalization; cancellation before paid projection; partial and full refund
eligibility; stable rating/time/id pagination; cross-filter cursor rejection;
one-star reward, exact negative-balance reversal and no re-award; upload revocation
before lock acquisition; privacy erasure with ledger preservation.

After the tests, the seven stage-2 SQL checks returned zero for invalid request,
line, review and media ownership; invalid bearer state; retained redacted content;
and missing reward-ledger evidence. Prisma validation passed. Existing repository
relation-mode index warnings were reported; no new schema validation error.
The final Prisma database-to-schema drift check reported no difference.

Reproduce the database tests only against an explicitly isolated database:

```sh
cd apps/web
DATABASE_URL=mysql://root@127.0.0.1:3306/weletic_loyalty_it_native_reviews_20260905 \
  LOYALTY_DATABASE_INTEGRATION=1 pnpm exec vitest run \
  --config vitest.loyalty-db.config.ts --no-file-parallelism --bail=1
```

The read-only backfill validator reported no unresolved findings on this local
database (it has no legacy backfill jobs). The analytics validator reconciled a
native-review test merchant to independent SQL with an explicit local USD 1/100
minor-unit valuation. Neither result authorizes production backfill commits.
The other nine loyalty validators passed in dry-run mode; those results retain
their simulator/static provenance and are not live Shopify evidence. The referral
dry-run used the repository's `NODE_ENV=test` privacy-key fixture.

## Browser evidence

Playwright drove the production review form and theme JavaScript through the
loopback-only `scripts/reviews/preview-native-reviews.ts` harness. HTTP responses
were synthetic; this did not exercise a deployed app proxy or authenticated
merchant dashboard.

- A one-star review submitted and displayed the pending-moderation acknowledgment.
- The invitation fragment was removed from the browser URL after initialization.
- Rating filters showed the review and the correct empty state.
- An HTML-looking review payload remained literal text; no injected image/script
  or handler executed.
- At 390 x 844, the review block had no horizontal overflow. Disconnecting and
  reconnecting the custom element reloaded the block correctly.
- Browser artifacts are local under `output/playwright/`. The fixture's missing
  favicon returned HTTP 400; no review JavaScript error was observed.

## Review and outstanding release evidence

The full web Vitest suite passed **3,885 tests across 255 files**, with six
existing skips. The native database suites above run separately; they are not
included in that unit-test count.

Web and Shopify production builds passed. The web build used the repository's
CI fixture settings with the isolated MySQL database; lint and TypeScript ran as
separate checks, following the existing CI configuration. Both type-checks, root
lint (10 tasks), repository Prettier checks, and all 10 Shopify function tests
passed. Shopify Theme Check reported an empty finding list for the complete
`weletic-analytics` theme app extension, including both new review blocks.

Independent read-only adversarial review verified the refund maintenance fence,
upload/privacy race fix, and email lease/finalization fix; its second pass found
no further actionable P1/P2 issue. Additional tests exercise the real service
signature, bounded proxy bodies, unpublished internal routes, standard rating
metafield writes/errors, owner-scoped exports, and exclusion of submission tokens.

Shared staging schema application, live email acceptance, real R2 erasure,
authenticated dashboard browser tests, Shopify publication/app-proxy behavior,
real metafield writes, and PR #52 Flow integration remain release gates. No
external email was sent and no Shopify extension was deployed during these checks.
