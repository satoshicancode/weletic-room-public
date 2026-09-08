# Deploying Weletic Partners

## Domains

Configure:

- `NEXT_PUBLIC_APP_DOMAIN=https://app.weletic.com` for program operations.
- `NEXT_PUBLIC_ADMIN_DOMAIN=https://admin.weletic.com` for platform operations.
- `NEXT_PUBLIC_PARTNERS_DOMAIN=https://partners.weletic.com` for creators.
- `SHOPIFY_APP_URL=https://shopify.weletic.com` for the standalone embedded
  Shopify process.
- The program short-link domain as `go.weletic.com` in Dub and point its DNS
  record to the deployed redirect service.
- The program storefront URL as `https://www.weletic.com`.

The host environment variables are read by Dub middleware and authentication;
they are not compile-time aliases in Weletic-owned code.

## Database rollout

This Dub version manages its split Prisma schema with `prisma db push` rather
than checked-in SQL migrations. Use this sequence:

1. Take a database backup and restore it into staging.
2. Run `pnpm --filter web prisma:generate`.
3. Preview the schema delta with
   `pnpm --filter web exec prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma --script`.
4. Verify default values: program accounting currency `USD`, partner locale
   `en`, timezone `UTC`, nullable display/payout currencies, and the additive
   encrypted `WeleticShopifyAppSession` table.
5. Replay sanitized Shopify order/refund fixtures in staging.
6. Apply it in production during a quiet period with
   `pnpm --filter web exec prisma db push --schema=prisma`. Do not add
   `--accept-data-loss`; Prisma must stop if it detects a destructive change.
7. Run a full catalog sync, then financial reconciliation.

Never use `--accept-data-loss` for this rollout. Existing Dub commissions and
payouts remain intact; only new Weletic commerce events receive line-level
ledger records and FX snapshots.

### Loyalty schema activation

The loyalty birthday and referral-coupon release adds four referral-rule
columns plus new referral-status and outbox-job enum values. Activate it in
this order:

1. Pause loyalty mutations, order/refund webhook consumers, and every loyalty
   outbox worker. Record the current referral and outbox status counts.
2. Restore a current production snapshot into staging. The target-database
   diff must contain only the expected referral-rule column additions and the
   two enum expansions before applying it. Use a PlanetScale deploy request or
   a measured quiet window for direct MySQL DDL.
3. Apply the additive schema before deploying application code. Existing
   referral rules default to `points` for both reward kinds; both reward IDs
   remain `NULL`.
4. Deploy the new core API and outbox consumer everywhere, and wait until all
   old workers have drained. An old Prisma client must never consume the new
   `BIRTHDAY_REWARD` or `REFERRAL_REWARD_PROVISION` values.
5. Deploy the Shopify runtime plus the theme and Customer Account extensions,
   then resume workers and webhook/API traffic. Keep the checkout extension
   disabled for the current Shopify Basic rollout. Enable birthday and referral
   coupons last and canary both job types.

Before activation, query `WeleticLoyaltyAccount.metadata` for an existing
`birthday` object. This release introduces the first supported registration
path, so normally no backfill is required. If legacy/manual rows exist, create
one matching annual `BIRTHDAY_REWARD` job per account and reconcile completed
jobs that lack the corresponding `birthday:{accountId}:{year}` ledger key. If
legacy birthday ledger metadata contains `birthDate`, remove that PII field
while preserving the immutable financial fields and remaining audit metadata.

On application rollback, keep the expanded schema. Do not shrink either enum
or drop the new columns after new job/status values or coupon configuration
have been written; pause producers/workers and forward-fix instead.

### Immutable loyalty earn-policy cutover

The append-only earn-policy release adds `WeleticLoyaltyEarnPolicyRevision`,
nullable policy-revision bindings on orders and earn grants, the program's
monotonic revision counter, and soft-retirement timestamps on rules, campaigns,
and tiers. The schema is additive, but the first policy generation is a global
data cutover and must be completed before the revision-aware runtime starts:

1. Enable the loyalty kill switch for every active program. Pause merchant
   policy mutations, order/refund webhook ingress and consumers, historical
   backfill commits, and every loyalty outbox worker. Drain provisioning
   redemptions, nonterminal outbox jobs, committing backfills, destructive
   compliance lifecycles, and received/failed `orders/paid` or
   `refunds/create` events. Keep this fence active through final verification.
2. Take a recoverable snapshot, rehearse on its staging restore, review the
   schema diff, and apply the additive revision/soft-retirement schema. Do not
   deploy revision-aware writers yet.
3. Choose one fresh global T0 after the fence is established. The command is
   dry-run-first and global-only; a store-scoped run cannot authorize the
   cutover:

   ```bash
   T0="$(node -e 'process.stdout.write(new Date().toISOString())')"
   pnpm --filter web loyalty:backfill-earn-policy-revisions -- \
     --cutover-at="$T0" \
     --maintenance-fence=loyalty-writers-paused-and-drained
   ```

   Require `scope=all_stores`, `maintenanceAcknowledged=true`,
   `readyToApply=true`, and an empty `blockers` array. Review baseline, tier
   marker, and pre-T0 order counts. T0 must be current; if review takes more
   than five minutes, generate a new T0 and repeat the dry run. Never move T0
   backward to make a historical order eligible.

4. Apply the same audited T0 without releasing the fence:

   ```bash
   pnpm --filter web loyalty:backfill-earn-policy-revisions -- \
     --cutover-at="$T0" --apply \
     --maintenance-fence=loyalty-writers-paused-and-drained
   ```

   Require `readyForRuntime=true`. The utility publishes exactly one current-
   state baseline per existing program at T0, creates deterministic T0 tier-
   state markers only where the current tier lacks usable event-time history,
   and verifies the persisted revision fingerprints and tenant relationships.
   It is idempotent for the same T0; a partial retry must keep the original T0
   and the maintenance fence.

5. The utility never awards or recalculates a pre-T0 order. Paid/refunded
   pre-T0 orders associated with a loyalty account but lacking an earn grant
   are retained unchanged and receive an open critical
   `loyalty_pre_cutover_ungranted_order` reconciliation issue. If an immutable
   legacy `earn_order:{orderId}` ledger row exists, recover from that authority;
   otherwise use only the reviewed historical-backfill/manual disposition.
   Keep affected stores kill-switched until those liabilities are resolved.
6. Deploy the revision-aware runtime only after the apply result and a repeat
   fence inspection are clean. Resume compliance recovery first, then financial
   webhooks, the loyalty outbox, merchant policy writes, and finally shopper
   loyalty writes. Do not drop the revision table or nullable bindings on
   rollback; pause writers and forward-fix.

### Durable Shopify compliance activation

ADR 0015 adds durable compliance requests, privacy tombstones, encrypted export
artifacts, voucher-cleanup leases, Shopify store lifecycle state, and a canonical
discount-code identity. Treat this as a staged data migration rather than a
single `prisma db push`:

The reviewed additive schema diff also includes nullable
`authenticatedBodyDigest` columns on the Shopify webhook-event and compliance-
request tables. They are nullable only for staged legacy rows; every new signed
delivery must persist a versioned keyed-HMAC digest, and a duplicate legacy row
without one fails closed rather than being trusted.

1. Establish the maintenance fence before changing the schema. Turn on the
   loyalty kill switch for every target store, stop new redemption/referral
   producers, and let every `provisioning` redemption reach a durable terminal
   state. The kill-switch update and every new reservation, remote create,
   adoption, and issued finalization contend on the same tenant-bound
   `WeleticLoyaltyProgram` row, so a committed disable is a durable database
   write fence. Lock-only recovery deliberately remains available while
   disabled so orphan vouchers can be verified, deactivated, and compensated.
   Then pause the loyalty outbox, financial webhook consumers, and compliance
   workers. Verify twice that there are zero `provisioning`
   redemptions and zero `pending`, `processing`, `failed`, or `dead_letter`
   `REDEMPTION_RECOVERY`, `REFERRAL_REWARD_PROVISION`, or
   `VOUCHER_PRIVACY_CLEANUP` jobs. Resolve or explicitly cancel replayable
   failures; pausing a worker does not drain its queue. Keep this fence in
   place through stage 2. Take a recoverable database snapshot and rehearse
   the complete sequence on a restored staging copy.
2. Apply only
   `apps/web/scripts/loyalty/sql/adr-0015-discount-code-stage-1.sql`. It adds nullable
   canonical/quarantine columns and does not rewrite voucher codes or financial
   status.
3. Run `pnpm --filter web loyalty:migrate-discount-codes` as the pre-write
   audit. On a fresh stage-1 schema, exit code 2 is expected because persisted
   canonical values are still NULL; inspect the reported invalid rows and raw
   canonical collisions before continuing. Apply only from the drained
   maintenance shell with
   `pnpm --filter web loyalty:migrate-discount-codes -- --apply --maintenance-fence=loyalty-writers-paused-and-drained`.
   The CLI verifies this database-backed fence before its first write and again
   after its final persisted reload. Any invalid code or canonical collision is
   a release blocker and is durably quarantined for exact reconciliation
   against Shopify.
4. Repeat the global dry audit without `--store`, while retaining the exact
   acknowledgement:
   `pnpm --filter web loyalty:migrate-discount-codes -- --maintenance-fence=loyalty-writers-paused-and-drained`.
   Require `maintenanceAcknowledged=true`, `readyForFinalConstraint=true`,
   `scopedAuditOnly=false`, `blockingReconciliationIssues=0`, and empty
   `invalidRows`, `collisions`, `persistedCanonicalNullRows`,
   `persistedCanonicalMismatches`, `persistedCanonicalDuplicates`, and
   `persistedQuarantineRows`. This final audit reloads persisted database state;
   it is not the pre-backfill calculation. Open or ignored canonical
   collision/invalid issues still block stage 2; only exact Shopify
   reconciliation followed by an explicit `resolved` disposition is accepted.
   If any value is non-empty, keep the maintenance fence active and restart at
   the audit/backfill step. Only then apply
   `apps/web/scripts/loyalty/sql/adr-0015-discount-code-stage-2.sql` and the rest
   of the reviewed additive Prisma schema. Never bypass the final `NOT NULL`
   and store-scoped unique constraint.
5. Deploy the application, resume the compliance worker first, then financial
   webhook settlement, the loyalty outbox, and finally shopper-facing loyalty
   writes. Confirm there are no pending collision issues or dead-letter cleanup
   rows before enabling a program.

Production must explicitly configure all of the following; there are no
production defaults:

- `WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS`, ordered current key first, in the form
  `key-id:<base64-encoded-32-byte-key>[,previous-key-id:<key>]`. Removing a
  previous key is an operator-blocked action until **every** durable digest
  carrying that key ID has expired or been migrated, including tombstones,
  active voucher customer-selection snapshots, and referral IP/user-agent
  signals. Referral abuse checks currently retain those signals without a
  bounded expiry, so a previous key must remain configured until a separate
  audited retention/migration release removes that dependency.
- `WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS`, based on the approved
  anti-resurrection/privacy policy.
- `WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS`, based on the approved accounting
  and legal-retention policy; it is not a legal conclusion embedded in code.
- `WELETIC_SHOPIFY_COMPLIANCE_EXPORT_RETENTION_HOURS`, defining the short-lived
  private export window.
- `STORAGE_ENDPOINT`, `STORAGE_PRIVATE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, and
  `STORAGE_SECRET_ACCESS_KEY`. Compliance export creation and deletion fail
  closed when private storage is incomplete.

Privacy HMAC key retirement is a fenced release operation. First deploy a new
key in the first/current keyring position and keep every older key configured.
After all digest writers/workers are fenced and the retiring key has not been
used for at least 25 hours, run the bounded full dependency gate from
`apps/web`:

```bash
pnpm loyalty:audit-privacy-key-retirement \
  --retire=<previous-key-id> \
  --last-write-at=<ISO-8601> \
  --writers-fenced
```

The command refuses to audit the current/first key. Do not remove a previous
key unless it exits successfully with `ready=true`, zero dependencies, zero
legacy unkeyed-digest debt, and a satisfied cache overlap. Keep writers fenced
between the clean audit and the reviewed key-removal deployment; otherwise the
audit is stale and must be repeated.

QStash delivery is a latency optimization, while the durable database request
is the source of truth. A periodic authenticated invocation of
`/api/cron/weletic/shopify/compliance` is also required to recover missed queue
publishes, stale leases, expired export objects, and expired tombstones. Do not
claim production readiness until that schedule is explicitly reviewed and
activated in the deployment configuration. Verify that customer export links
are delivered only to a workspace owner, use the stable bearer token in the URL
fragment, return `no-store`/`no-referrer` headers, and stop working after expiry.

For uninstall and shop erasure drills, prove this exact order: freeze new
operational writes, reconcile/deactivate unused Shopify vouchers while offline
credentials remain usable, preserve remotely used vouchers as pseudonymous
financial facts without restoring points, record dead letters for ambiguous
ownership, scrub credentials/sessions, and then complete erasure. A delayed
`orders/paid` or `refunds/create` event may perform privacy-minimized settlement
but must not recreate a shopper or award new points after the freeze.

## Required services

MySQL/PlanetScale, Redis, QStash, Tinybird, storage, email, and Shopify secrets
remain required by the Dub base. Weletic additionally depends on current FX
rates in `fxRates:usd`; configure `CURRENCY_API_KEY` and
`WELETIC_FX_MAX_AGE_HOURS` (48 by default). A missing or stale conversion rate
fails closed.

## Shopify embedded app rollout

Deploy the core before the standalone Shopify process so its signed API and
session table are available when Shopify authentication begins.

Configure the core with `WELETIC_SHOPIFY_SERVICE_SECRET` (at least 32 random
characters) and its existing 32-byte base64 `ENCRYPTION_KEY`. Configure the
Shopify process with `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_APP_URL=https://shopify.weletic.com`,
`WELETIC_API_URL=https://app.weletic.com`, and the same
`WELETIC_SHOPIFY_SERVICE_SECRET`. Keep `SHOPIFY_ADMIN_API_VERSION=2026-07`
aligned with the API version in the standalone app and `shopify.app.toml`. Do
not configure `SHOPIFY_ADMIN_GRAPHQL_PROXY_URL` in production; it is an optional
development-only GraphQL proxy.

Before `shopify app deploy`, confirm that `shopify.app.toml` uses the deployed
Shopify host for `application_url` and `/auth/callback`, and the core host for
webhook delivery. Do not run production with localhost or Shopify template
fallback URLs. The maintained Shopify Remix runtime has expiring offline access
tokens enabled; verify the encrypted session payload round-trips both
`refreshToken` and `refreshTokenExpires` before onboarding a production shop.
Also confirm that the deployed Remix route manifest contains the `/auth/*`
handler used by the OAuth callback. Load the embedded document with a valid
`shop` query parameter and verify its response includes Shopify's expected
`Content-Security-Policy: frame-ancestors ...` directive and
`X-Content-Type-Options: nosniff`. Verify a document without a valid `shop`
parameter uses `frame-ancestors 'none'`, and an internal mutating request larger
than 256 KiB receives HTTP 413.

## Release gates

- Prisma validation and generation pass.
- `pnpm lint`, web and Shopify type-checks, `pnpm test:unit`, Prettier, both
  production builds, and Playwright pass. The default test command is the
  deterministic local/unit suite; it does not depend on deployment secrets.
- Run `pnpm test:integration` only against a deployed environment with
  `E2E_BASE_URL`, `E2E_TOKEN`, `E2E_TOKEN_MEMBER`, `E2E_TOKEN_OLD`, and
  `E2E_PUBLISHABLE_KEY`. Run `pnpm test:performance` separately; wall-clock
  benchmarks are diagnostic evidence, not shared-runner release blockers.
- Shopify app scopes and webhook subscriptions match the commerce operations
  runbook.
- Signed internal Shopify calls reject missing, tampered, and stale signatures;
  OAuth sessions survive a Shopify process restart and remain unreadable in the
  database without `ENCRYPTION_KEY`.
- Catalog sync has no error and reconciliation has no unresolved critical issue.
- Test partner can create a `go.weletic.com` product link and complete a test
  order, partial refund, payout quote, and localized statement.
- The storefront theme passes the EN/VI/JA and country-context link matrix in a
  signed-out browser session.
- Every inherited Dub screen and notification included in the launch journey
  has completed EN/VI/JA migration and translation QA; the initial Weletic-owned
  commerce surfaces alone are not sufficient to claim full-portal localization.
