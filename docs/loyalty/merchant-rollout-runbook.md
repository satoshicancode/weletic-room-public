# Merchant onboarding and rollout runbook

**Last updated:** 2026-09-05

Nothing in this checklist is globally complete. Run it for each environment and connected store.

> **Active containment:** Historical backfill commits are disabled. Monetary liability, referral cost, CAC, and ROI remain unavailable until an owner configures exact valuation; any accounting-currency mismatch fails closed. Do not mark either path live-proven until the remediation release gates in the capability matrix pass.

This runbook currently covers Weletic's in-house brands on Shopify Basic. Active shopper surfaces are the Online Store theme/App Proxy and Shopify Customer Accounts, with native reward acceptance in standard Shopify Basic checkout. A Shopify POS amount/percentage gateway and extension are built, but activation remains deferred until customer-selection binding and its threat model are confirmed. The custom Checkout UI extension, Shopify Plus-only capabilities, and onboarding external partner stores are also deferred.

## 1. Database preflight

1. Generate and validate the split Prisma schema without applying it.
2. Diff the target database against the schema and review the exact transition.
3. Inspect destructive statements, required-column backfills, and unique constraints.
   `WeleticShopifyStore.currencyVerifiedAt` is deliberately nullable for the
   staged rollout. Existing stores remain unable to create new financial
   loyalty vouchers until Shopify has authoritatively refreshed both
   `shopCurrency` and this marker through reconnect or a successful catalog
   sync.
4. Query existing loyalty idempotency keys for duplicates before applying `[storeId, idempotencyKey]` uniqueness.
5. Schedule a maintenance window and pause loyalty mutation traffic, webhook consumers that award/refund points, and the loyalty outbox worker.
6. Take a recoverable backup/snapshot and record its integrity hash. Do not run a broad `prisma db push` yet: ADR 0015's canonical-code constraint is a two-stage migration.
7. Before schema application, require zero historical backfill jobs in
   `committing`. The additive `WeleticLoyaltyBackfillJob.commitLeaseId` column
   is the durable worker-attempt authority; do not run an application version
   that claims commits until that column exists, and do not resume an older
   worker after the new schema/application pair is active.
8. Before starting the token-owned referral email runtime, apply
   `apps/web/scripts/loyalty/sql/operations-concurrency-stage-1.sql` while old
   web and worker processes remain drained. The previous runtime stores leases
   in JSON and does not honor the new columns, so never overlap old and new
   referral email writers during this transition. Run
   `operations-concurrency-stage-2-gate.sql` immediately afterward and require
   all four finding counts to be zero. Do not deploy the new runtime until the
   columns and `wl_referral_email_lease_idx` exist, and do not resume the old
   runtime afterward.
9. Before starting the product-targeted bonus campaign runtime, apply
   `apps/web/scripts/loyalty/sql/bonus-campaign-targeting-stage-1.sql`. The two
   nullable JSON columns are additive, and null preserves the previous
   broadcast/VIP-only contract. Run
   `bonus-campaign-targeting-stage-2-gate.sql` immediately afterward and
   require all six shape, value, and duplicate finding counts to be zero.
   Do not expose target configuration or start the new runtime before the
   columns and zero-finding gate are confirmed.
10. Apply only `apps/web/scripts/loyalty/sql/adr-0015-discount-code-stage-1.sql`. It adds nullable canonical/quarantine fields without rewriting voucher codes or financial status.
11. Run the pre-write global audit, then apply the backfill only from the drained maintenance shell:

```bash
pnpm --filter web loyalty:migrate-discount-codes
pnpm --filter web loyalty:migrate-discount-codes -- \
  --apply \
  --maintenance-fence=loyalty-writers-paused-and-drained
```

Invalid codes and canonical collisions are release blockers. Reconcile each one against the exact Shopify identity and leave the row quarantined until an audited `resolved` disposition exists.

12. Repeat the unscoped persisted-state audit while retaining the maintenance acknowledgement:

    ```bash
    pnpm --filter web loyalty:migrate-discount-codes -- \
      --maintenance-fence=loyalty-writers-paused-and-drained
    ```

    Require `maintenanceAcknowledged=true`, `readyForFinalConstraint=true`, `scopedAuditOnly=false`, `blockingReconciliationIssues=0`, and empty invalid/collision/NULL/mismatch/duplicate/quarantine sets. A `--store` audit cannot authorize a global constraint. Only then apply `apps/web/scripts/loyalty/sql/adr-0015-discount-code-stage-2.sql` and the rest of the reviewed additive Prisma schema. Never bypass the final `NOT NULL` plus store-scoped unique constraint.

13. While writes remain paused, inspect the ledger-version backfill:

    ```bash
    pnpm --filter web loyalty:migrate-ledger-version -- --dry-run
    ```

14. Run the ledger backfill without `--dry-run`, require zero reported errors, then repeat the dry run and verify every existing account's `ledgerVersion` equals its maximum ledger `sequenceNumber`.
15. Before the revision-aware application starts, establish one immutable,
    global earn-policy cutover while the same maintenance fence remains active.
    Apply the additive revision schema first, then run the global dry audit:

    ```bash
    T0="$(node -e 'process.stdout.write(new Date().toISOString())')"
    pnpm --filter web loyalty:backfill-earn-policy-revisions -- \
      --cutover-at="$T0" \
      --maintenance-fence=loyalty-writers-paused-and-drained
    ```

    Require `scope=all_stores`, `maintenanceAcknowledged=true`,
    `readyToApply=true`, and no blockers. Review the count of baselines, missing
    tier-history markers, and pre-T0 ungranted orders. If review takes longer
    than five minutes, generate a fresh T0 and repeat the dry run; never backdate
    the current mutable policy. Apply the same audited T0 with:

    ```bash
    pnpm --filter web loyalty:backfill-earn-policy-revisions -- \
      --cutover-at="$T0" --apply \
      --maintenance-fence=loyalty-writers-paused-and-drained
    ```

    Require `readyForRuntime=true`. A retry is idempotent only for that exact T0
    and must run while writers remain fenced. The command creates a current-
    state baseline at T0, not a reconstruction of older policy. It creates
    deterministic T0 markers for accounts whose current tier lacks usable
    event-time history. It never evaluates a pre-T0 order: each eligible order
    without an earn grant is left financially unchanged and quarantined through
    a critical `loyalty_pre_cutover_ungranted_order` reconciliation issue. Use
    an existing immutable legacy earn ledger as authority, or the separately
    reviewed historical-backfill/manual process; do not use today's policy.
    Keep affected stores kill-switched until those issues are resolved.

16. For a retained Shopify installation whose store and credential both predate
    `installationGeneration`, keep the maintenance fence active and audit the
    exact live credential before the new runtime starts:

    ```bash
    pnpm --filter web loyalty:activate-shopify-generation -- \
      --store=<exact-store>.myshopify.com
    ```

    Require `readyToApply=true`. This means there is exactly one active loyalty
    program and its kill switch is enabled, with zero provisioning redemptions,
    committing backfills, pending deletion lifecycles, or nonterminal loyalty
    outbox jobs of any type. Then activate it with
    `--apply --maintenance-fence=loyalty-writers-paused-and-drained`. The command
    verifies the credential and authoritative shop currency with Shopify,
    provisions every mandatory webhook, and publishes the first immutable
    generation under the store → program lock order. Shopify verification and
    webhook provisioning stay serialized behind that store lock so an uninstall
    or shop-redact freeze cannot race activation. Never fill generation or
    `currencyVerifiedAt` columns manually. A store that already has a consistent
    generation is an idempotent no-op.

    If the dry run reports that the retained credential is rejected or expired,
    keep the maintenance fence active and reopen the already-installed embedded
    app. A fresh Shopify token exchange may publish the first generation only
    after the same credential-hash compare-and-swap, drained-fence recheck, live
    currency verification, and mandatory-webhook checks. Do not manually repair
    generation or currency columns.

17. Deploy the new application code only after the compliance configuration in section 2 is complete. Resume the compliance worker first, then financial webhook settlement, the loyalty outbox, and finally shopper-facing writes.
18. Run the real-database concurrency suite only against a fresh database named `weletic_loyalty_it_<unique>`.

Before enabling redemption, require this query to return zero rows, and compare
each stored currency with Shopify Admin GraphQL rather than manually filling the
marker:

```sql
SELECT id, shopDomain, shopCurrency
FROM WeleticShopifyStore
WHERE complianceState = 'active' AND currencyVerifiedAt IS NULL;
```

Currency refresh is a financial generation change: reconnect and catalog
metadata publication lock the store row and then the loyalty-program row. A
voucher provisioner holding the program lock re-reads the verified store
currency immediately before Shopify I/O and rejects an older immutable
snapshot. Discount reconciliation likewise binds every publication and safe
local-only auto-heal to the exact persisted `currencyVerifiedAt` and
`installationGeneration` captured by the run; freeze, reconnect, or callback
refresh invalidates the old run. Destructive Shopify discount
cleanup is report-only for this release: operators must verify exact local
ownership (local row ID plus Shopify node and redeem-code IDs), clean up the
exact code manually in Shopify Admin, and rerun the full scan. A replacement
that reuses the same code text does not inherit ownership. Never infer
ownership from a “Dub”/“Weletic” title, a standalone node
shape, or membership in a shared bulk parent, and never delete a bulk parent to
clean up one redeem code. Reconciliation must fully paginate both discount
nodes and each nested redeem-code connection; missing `pageInfo`, an incomplete
cursor, or any empty continuation page aborts the run without publishing or
healing local state. The eligible local rows are snapshotted before Shopify I/O,
and local disable uses an exact row/code/active/`updatedAt` compare-and-swap so
a concurrent create or reactivation survives for the next scan. Legacy issues
without exact identity remain open for ownership verification while a
same-text active code exists, are excluded from manual-cleanup counts, and
resolve only when a complete scan observes the code absent or inactive.

Catalog sync start is also generation-bound: the credential's exact
`installationGeneration` must match before a run can attach to a store. A stale
run may close its own run record but cannot publish failure or catalog state to
a newer installation generation. Referral binding locks the store and active
program, then re-reads the canonical referral rule before creating a pending
referral; a concurrent merchant disable wins before or after that transaction,
never in the middle of it.

Friend-reward email delivery is protected by an atomic delivery reservation
lease (token, reservation/expiry timestamps, attempts, and last error), transport error isolation, and
privacy preservation (HMAC digest). A 60-second reservation lease prevents
concurrent duplicate sends through dedicated token-owned lease columns; transport failures are captured gracefully without
crashing the customer coupon claim response, and raw emails are never stored in
database metadata.

This ordering is mandatory: the schema adds `ledgerVersion` with a default of zero, while existing accounts may already have higher sequence numbers. Starting the new writer before the backfill can create sequence conflicts. Do not treat a successful local `prisma validate` as proof that the production transition is safe.

## 2. Required configuration

- `DATABASE_URL` for the web application.
- `WELETIC_SHOPIFY_SERVICE_SECRET` shared by the Shopify Remix app and web app; at least 32 characters.
- Shopify app client credentials and an offline session for the exact connected store.
- Shopify Admin API version `2026-07` unless a controlled override is required.
- Required scopes for the enabled capabilities: customers, orders, discounts, products, and metafields. Historical access beyond Shopify's normal order window also requires `read_all_orders` approval and grant.
- Valid production URLs for the Shopify app and the signed Weletic core.
- Cron authentication for `/api/cron/weletic/loyalty/outbox`, or a supervised deployment of `pnpm --filter web loyalty:outbox-worker`.
- A versioned Shopify privacy HMAC keyring, explicit customer-tombstone and
  financial-retention durations, a short compliance-export lifetime, and fully
  configured private object storage. The exact variables and rotation rules are
  documented in `docs/runbooks/deploy-weletic.md`; production intentionally
  fails closed when any value is missing.
- Authenticated QStash delivery plus a reviewed periodic recovery schedule for
  `/api/cron/weletic/shopify/compliance`. The route existing in the application
  is not proof that the deployment invokes it.

Redis is not the source of truth for loyalty financial reservations in this implementation. Redemption, idempotency, leases, and recovery use MySQL/Prisma records.

## 3. Shopify app and webhook preflight

Run the validator in read-only mode first:

```bash
pnpm --filter web loyalty:validate-test-store -- \
  --store=<exact-store>.myshopify.com --dry-run --json
```

The dry-run proves exact persisted store/workspace resolution and the presence of an offline credential record. It also runs local service-HMAC cryptographic checks and static Customer Account claim-parser checks using locally constructed inputs. It intentionally skips Shopify Admin GraphQL discount calls and webhook provisioning, therefore returns a warning and does **not** prove live credential acceptance, effective scopes, GraphQL reachability, App Proxy authentication, or Customer Account JWT verification.

Then run the default validator against an authorized disposable/test store. This non-dry run is required to prove live credential acceptance, effective Admin API access, GraphQL reachability, webhook provisioning, and discount creation/readback/deactivation/deletion. Cleanup is enabled by default. The hardened validator preflights each nonce-bound code, binds fixed-amount economics to the live Shopify shop currency, grants cleanup authority only after exact title, type, and immutable-configuration readback, and requires `node(id: <authorized-gid>)` to be absent after cleanup. A code lookup, mutation dispatch, or mutation boolean alone is not cleanup evidence.

Evidence snapshot: on 2026-08-31, the [hardened infrastructure validator](./evidence/infrastructure-validator-staging-2026-08-31-v2.json) passed 16/16 against the approved staging store. It exercised staging Admin GraphQL discount creation, exact readback, deactivation/deletion, and exact-GID absence cleanup for fixed-amount, percentage, free-shipping, and free-product/BXGY adapters plus canonical webhook provisioning. PR #24 separately proved one logged-in Customer Account fixed-amount redemption with coupon wallet/history and a clean targeted reconciliation. The service-HMAC and claim-parser checks remain local/static evidence, and none of these facts replaces the dedicated order/refund, holding/release, voucher settlement, signup, birthday, referral, VIP/metafield, privacy, or Online Store theme/App Proxy lifecycle gates. Those lifecycles are evidence-qualified in the final [v14 report](./evidence/a1-basic-lifecycle-staging-2026-08-31-v14.json), with its intentionally skipped flows still requiring separate proof.

After any Shopify permission update, compare the cached installation scopes with Shopify's authoritative grant before enabling the affected reward. The command is a dry run unless `--apply` is present, requires the exact staging allowlist and confirmation, and is forbidden in production:

```bash
pnpm --filter web loyalty:reconcile-shopify-scopes -- \
  --store=<exact-store>.myshopify.com --confirm-staging

pnpm --filter web loyalty:reconcile-shopify-scopes -- \
  --store=<exact-store>.myshopify.com --confirm-staging --apply
```

For an authorized disposable store, run the dedicated financial lifecycle after Gift Card and Store Credit scopes are granted. It creates an email-free tagged customer, issues one minimal-value Gift Card and Store Credit reward, verifies both through Shopify and the customer wallet, then deactivates/debits and deletes every exact fixture. The report path must be absolute and is written with owner-only permissions:

```bash
pnpm --filter web loyalty:validate-financial-rewards -- \
  --store=<exact-store>.myshopify.com --confirm-staging \
  --report=/absolute/private/path/financial-reward-report.json
```

The [2026-09-01 staging report](./evidence/financial-reward-lifecycle-staging-2026-09-01.json) passed all 13 checks with zero remaining remote financial value, no disposable Shopify customer, and no local fixture rows. It proves issuance, exact readback, wallet persistence, and cleanup—not checkout use or expiry.

To verify multi-line checkout, proportional clawbacks, cumulative quantity flooring, non-fixed reward types (percentage off, free shipping, BXGY), and negative balance protection under simulated and staging conditions:

```bash
# Run simulation suite (offline mock)
pnpm --filter web loyalty:validate-checkout-matrix -- --mock

# Run dry-run against store credentials
pnpm --filter web loyalty:validate-checkout-matrix -- \
  --store=<exact-store>.myshopify.com --dry-run --json
```

To verify Online Store Theme Blocks, Liquid escaping, App Proxy gateway routing, HMAC verification, security boundaries, and PDP product points calculation:

```bash
# Run simulation suite (offline mock)
pnpm --filter web loyalty:validate-theme-proxy -- --mock

# Run dry-run against local assets and store configuration
pnpm --filter web loyalty:validate-theme-proxy -- \
  --store=<exact-store>.myshopify.com --dry-run --json
```

To verify Points Inactivity Expiry & Multi-Stage Lifecycle (Nhóm 1.3) including 30-day advance warnings, 3/7-day last-chance urgency notifications, Stage 3 zero-residue ledger debits (`EXPIRATION`) driving balance strictly to zero, nextExpiryDate reset, marketing consent & participation gates, insolvent negative balance protection, rolling expiry extension on qualifying shopper activities, and policy version fencing invalidating stale outbox jobs:

```bash
# Run simulation suite (offline mock)
pnpm loyalty:validate-points-expiry -- --mock

# Run dry-run with structured JSON output against store credentials
pnpm loyalty:validate-points-expiry -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Run live verification on authorized staging store
pnpm loyalty:validate-points-expiry -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

To verify Referral Qualification, Fraud Review & Advocate Fulfillment Matrix (Nhóm 1.2) including anonymous friend claims with single-use Shopify coupons (`WLF-<fingerprint>`), 60-second atomic token-owned email delivery leases in dedicated columns, first-order qualification with BigInt minor units across USD/JPY/VND and guest checkout attribution, 8-layer anti-self-referral and multi-vector abuse detection (account ID, shopper ID, canonical email, dot/plus sub-addressing, normalized person name NFKD Unicode, disposable domains, returning customer, IP abuse digest), advocate reward points/coupon fulfillment, full-refund clawback with partial-refund preservation and insolvent negative-balance support, and owner-only RBAC fraud review controls (`loyalty.write`, `owner`):

```bash
# Run simulation suite (offline mock)
pnpm loyalty:validate-referrals-matrix -- --mock

# Run dry-run with structured JSON output against store credentials
pnpm loyalty:validate-referrals-matrix -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Run live verification on authorized staging store
pnpm loyalty:validate-referrals-matrix -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

To verify VIP Tier Progression, Requalification & Downgrade Grace Sweep (Nhóm 1.5) including milestone progression across spend thresholds and timeframes (`rolling_12m`, `calendar_year`, `lifetime`), net refund deductions with zero-floor, intermediate crossed-tier iteration awarding skipped-tier entry bonuses with monotonic points ledger sequences, 30-day downgrade grace period retention, immediate requalification clearing grace, single-tier step-down demotion, base tier demotion immunity, lifetime mode immunity, scheduled cron sweep daemon (`enqueueTierReviewSweepJobs`) enqueuing durable `TIER_REVIEW` outbox jobs, and customer metafield synchronization under `weletic_loyalty` namespace with strict PII exclusion:

```bash
# Run simulation suite (offline mock)
pnpm loyalty:validate-vip-lifecycle -- --mock

# Run dry-run with structured JSON output against store configuration
pnpm loyalty:validate-vip-lifecycle -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Run live verification on authorized staging store
pnpm loyalty:validate-vip-lifecycle -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

The following checks retain regression coverage for Social Earning Actions, Birthday Engine and the legacy signed Judge.me adapter (Nhóm 1.6 / Item 9). They are not native review collection or live provider-delivery proof. New Judge.me connections are disabled; use the [native reviews rollout gates](native-reviews-plan.md#explicit-rollout-gates) for verified-purchase text/photo collection, moderation, points and storefront blocks. Video is not included in native reviews.

```bash
# Run simulation suite (offline mock)
pnpm loyalty:validate-earning-actions -- --mock

# Run dry-run with structured JSON output against store configuration
pnpm loyalty:validate-earning-actions -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Run live verification on authorized staging store
pnpm loyalty:validate-earning-actions -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

To validate the local native Shopify Flow contracts (Nhóm 1.7 / Item 10):

```bash
pnpm loyalty:validate-flow-esp
pnpm --filter web exec vitest run tests/weletic/loyalty-shopify-flow.test.ts
pnpm --filter web exec vitest run tests/weletic/shopify-flow-lifecycle-route.test.ts
pnpm --filter web exec vitest run tests/weletic/shopify-flow-lifecycle-state.test.ts
pnpm --filter web exec vitest run tests/weletic/shopify-flow-outbox.test.ts
pnpm --filter web exec vitest run tests/weletic/shopify-flow-worker.test.ts
```

The validator reads the four extension manifests and production payload/outbox contracts. It intentionally refuses `--live`: local checks do not prove publication or workflow delivery. After the schema gate passes, obtain explicit approval before `shopify app deploy` because that command publishes extensions. Then retain evidence from one real staging workflow per trigger plus lifecycle enable/disable callbacks. ESP/Klaviyo delivery is deferred; only pure payload-formatting helpers remain.

For the post-#53 baseline, apply `shopify-flow-stage-1.sql` only after explicit
development-database approval. It preserves all three native-review outbox types;
do not replay the historical #51 native-review migration against this expanded
schema. Compare the actual database to the combined Prisma schema and require
both Flow and native-review stage-2 gates to return zero findings. The isolated
rehearsal and remaining release boundaries are recorded in
[Flow integration evidence](shopify-flow-integration-evidence.md).

Keep Flow-producing application processes and outbox workers paused until the
separate extension publication gate passes. Unobserved stores intentionally
remain dispatch-eligible: an unpublished trigger is not a disabled feature flag
and Shopify may reject it terminally. Do not resume producers merely because the
schema or code merge succeeded. Native collection and invitation emails remain
disabled until their own explicitly approved rollout.

To verify Store Credit & Gift Card Financial Ledger Lifecycle (Nhóm 1.8 / Item 2) including Shopify Store Credit Admin GraphQL API 2024-10+ mutations (`customerStoreCreditAccountCredit`, `customerStoreCreditAccountDebit`), multi-currency minor unit precision (USD, JPY, VND, BHD), Gift Card issuance (`giftCardCreate`) with masked code security (`•••• •••• •••• 1D4E`), double-spend prevention, expiration deactivation, monotonic ledger transitions, and multi-account balance reconciliation with zero drift:

```bash
# Run simulation suite (offline mock)
pnpm loyalty:validate-store-credit-gift-cards -- --mock

# Run dry-run with structured JSON output against store configuration
pnpm loyalty:validate-store-credit-gift-cards -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Run live verification on authorized staging store
pnpm loyalty:validate-store-credit-gift-cards -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

To verify Bonus Points Campaigns Engine (Nhóm 1.9 / Item 11) including half-open scheduling windows `[startAt, endAt)`, non-overlapping store invariant, multiplier bounds (1.5x-10.0x), max duration (<= 31 days), running-campaign immutability, broadcast/tier targeting, normalized SKU/collection match-any targeting, exact rational line allocation, and immutable refund evidence:

```bash
# Run simulation suite (offline mock)
pnpm loyalty:validate-bonus-campaigns -- --mock

# Run dry-run with structured JSON output against store configuration
pnpm loyalty:validate-bonus-campaigns -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Run the guarded simulation label (requires --confirm-staging)
pnpm loyalty:validate-bonus-campaigns -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

All checks in this validator are local simulations, including `--live`; its
provenance remains `simulated` and `live=false`. Live evidence requires a
retained staged order and refund that cross production services and Prisma
transaction boundaries.

To validate the corrected financial analytics contract against persisted data (Nhóm 1.11 / Item 12):

```bash
# Read persisted state and invoke production analytics services inside a
# repeatable-read Prisma transaction; no data is written
pnpm loyalty:validate-analytics -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Guarded read-only staging evidence; retain the JSON report
pnpm loyalty:validate-analytics -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json \
  --output=<retained-report-path>.json
```

The analytics validator rejects `--mock`. It proves that production liability, referral, and cohort services agree with independent SQL totals for the selected persisted store, verifies accounting-currency quality, and checks zero-cost ROI semantics. A retained named staging report is required before the capability is labelled live-proven.

To inspect persisted historical backfill state and exercise the production service (Nhóm 1.10 / Item 13):

```bash
# Audit only; exits 2 while repairable, replay-pending, or unresolved rows remain
pnpm loyalty:audit-backfill -- --store=<exact-store>.myshopify.com

# Run dry-run with structured JSON output against store configuration
pnpm loyalty:validate-historical-backfill -- \
  --store=<exact-store>.myshopify.com --dry-run --json

# Guarded staging database validation only; commit remains disabled
pnpm loyalty:validate-historical-backfill -- \
  --store=<exact-store>.myshopify.com --confirm-staging --live --json
```

The validator reads persisted marker, snapshot, grant, line-allocation, and ledger consistency; it does not execute commits. Safe commit behavior additionally requires `loyalty-backfill-concurrency.test.ts` and the isolated-MySQL `loyalty-ledger-db.integration.test.ts` to pass.

> **Mandatory Fail-Closed Safety Guardrail**: In all loyalty CLI validators (`validate-bonus-campaigns`, `validate-loyalty-analytics`, `validate-historical-backfill`, etc.), invoking `--live` without the explicit `--confirm-staging` flag triggers an intentional fail-closed guardrail and immediately exits with code 1. This prevents accidental execution against live production stores.

> **Evidence classification**: `--mock` is an offline simulation. `--dry-run` proves only the code and reads it actually executes. A `--live` command is live evidence only when it reaches the named production service and Prisma transaction boundary and produces a retained, reviewable report. Passing a validator does not establish competitor parity.

Also on 2026-09-01, `shopify app versions list --json` reported `loyalty-store-credit-readback-2026-09-01` as the active app version. This confirms app-version deployment only. It does not prove that a merchant enabled the Customer Account page target, theme blocks, or POS extension, nor that the expanded Loyalty Hub rendered or completed a live shopper flow.

## 4. Program setup

1. Configure point names, status, earn rate, holding period, expiry policy, and kill switch. Pre-validate points inactivity expiry rules, consent gates, and policy version invalidation using `pnpm loyalty:validate-points-expiry -- --dry-run`.
2. Configure order earning rules and conditions using the store's base currency.
3. Configure only reward types that passed the store-specific live gate: amount, percentage, free shipping, free product, Gift Card, or Store Credit. Keep each reward on its intended Online Store/POS channel. Pre-validate Store Credit and Gift Card financial lifecycle, currency minor unit conversions, and ledger atomicity using `pnpm loyalty:validate-store-credit-gift-cards -- --dry-run`.
4. Configure VIP milestone/timeframe/tier order and referral qualification rules. Pre-validate 8-layer anti-abuse thresholds and VIP downgrade grace sweeps using `pnpm loyalty:validate-referrals-matrix -- --dry-run` and `pnpm loyalty:validate-vip-lifecycle -- --dry-run`.
5. Keep signup, birthday and customer-intent social/link actions disabled until their configured policy limits, identity proof, abuse controls and live lifecycles are verified. Pre-validate their legacy regression coverage with `pnpm loyalty:validate-earning-actions -- --dry-run`. Native reviews replace new Judge.me connections; follow the separate [schema, publication and merchant activation gates](native-reviews-plan.md#explicit-rollout-gates). Native activation disables the retained legacy integration. Do not run competing review collectors or rating-metafield writers during cutover.
6. Keep Gift Card and Store Credit out of merchant-facing promises until the app is re-authorized for their scopes and their live lifecycle checks pass. Keep POS rewards disabled until the customer-selection binding and threat model are confirmed, then require extension deployment and a live cart lifecycle.
7. Keep Shopify Flow disabled until all four native trigger extensions are published, lifecycle state is persisted, and one real staging workflow per trigger passes enable/disable and delivery checks. Do not configure ESP/Klaviyo; it is deferred.
8. Configure broadcast, VIP-only, SKU, or collection bonus campaigns only after the additive columns exist and the six stage-2 findings are zero. SKU and collection lists use match-any semantics after schedule/VIP eligibility; nonmatching or missing line snapshots earn base points. Do not market product targeting as live-proven until a retained staged order and exact refund clawback pass.
9. Points activity may remain visible. An owner may configure financial reporting only with a positive integer rational valuation in the program accounting currency—for example, ¥1 per 100 points is numerator `1`, denominator `100`. Leave valuation unset, and monetary values unavailable, until the staged schema is applied. Do not label the feature live-proven until the persisted validator and independent SQL reconciliation pass.

## 5. Historical backfill

1. Use preview and audit only. The API rejects every commit request after owner and tenant validation.
2. Each new preview contains one immutable order snapshot with order version/hash, policy revision, currency, eligible/refunded spend, points, and line allocations. A changed order returns the job to `preview_ready` and requires regeneration.
3. Run `pnpm loyalty:audit-backfill -- --store=<exact-store>.myshopify.com` first. Never apply corrections automatically or rewrite existing ledger rows.
4. Before any repair apply, require explicit environment and merchant confirmation, a recoverable database snapshot, and the reviewed append-only correction plan. The guarded syntax is `pnpm loyalty:audit-backfill -- --apply --store=<exact-store>.myshopify.com --environment=staging --merchant-confirmation=<exact-store>.myshopify.com`.
5. Re-enable commits only after the audit reports zero unresolved jobs, overlapping MySQL-backed backfills prove exactly-once per-order credit, partial/full refund and preview-mutation cases pass, and repaired grants survive later refund replay.

## 6. Surface deployment and shopper smoke tests

1. Build and deploy the Shopify Remix app plus the theme and Customer Account extensions. Confirm the intended version is active with `shopify app versions list --json`; do not treat that result as merchant enablement. Do not activate the built POS extension until its customer-binding gate passes.
2. Enable the Customer Account page target, confirm the expected Weletic Loyalty Hub navigation label and expanded content render, and independently test summary, fixed/incremental redemption, financial-artifact presentation, coupon wallet/history, order earn, hold/release, discount use, refund, referral, and tier transition.
3. Enable the theme app embed and requested blocks in the merchant's active theme, then independently test the Online Store App Proxy flow. A passing Customer Account test is not evidence for the theme/App Proxy surface.
4. After the POS customer-binding threat model is approved and implemented, install the tile/modal and independently test one amount and one percentage reward on a real POS cart.
5. Confirm the custom Checkout UI extension remains disabled for this Shopify Basic rollout. Continue testing native reward acceptance through standard Shopify Basic checkout.
6. Inspect each rendered DOM and its network traffic: no cleartext shopper ID, name, email, phone, birthday, balance, or referral code may be embedded in Liquid markup.

## 7. Outbox and monitoring gate

Before activating the program:

- prove the outbox runner is scheduled or continuously supervised;
- use the exact `storeId` and explicit fixture `jobIds` for manual/staging worker runs, especially when injecting a logical clock; never time-travel unrelated jobs;
- alert on `failed` and `dead_letter` jobs;
- treat an uncertain Shopify create followed only by lookup misses as manual
  reconciliation: never restore points merely because a visibility deadline
  elapsed;
- monitor stuck `provisioning` redemptions;
- monitor and reconcile Store Credit redemptions flagged with pre-dispatch markers (`remoteProvisionAttemptedAt`): if remote outcome is unknown due to network timeout or socket drop, quarantine for manual store credit reconciliation and never blindly retry or restore points without verifying remote Shopify Store Credit balance;
- run financial ledger audit reconciliations to verify $\sum \text{pointsDelta} == \text{cachedPointsBalance}$ across all store accounts, ensuring zero drift between Weletic points debited and Shopify Store Credit / Gift Card liabilities issued;
- monitor webhook delivery failures and HMAC rejection rates;
- run ledger reconciliation in report mode on a sample and investigate any sequence gap;
- verify unused-voucher expiry restores points exactly once and never refunds a used voucher;
- supervise scheduled cron sweep daemon for VIP tier reviews (`enqueueTierReviewSweepJobs`), ensuring accounts past their 30-day grace period receive automated single-tier step-down demotions;
- supervise points inactivity outbox jobs, verifying warning/last-chance notifications and zero-residue expiration debits execute at cutoff without balance underflow;
- supervise `FLOW_TRIGGER` outbox jobs and alert on Shopify Flow dead-letter rates; ESP/Klaviyo delivery remains deferred;
- monitor active bonus campaigns to ensure running-campaign economics and tier/SKU/collection targeting remain immutable, adjacent campaigns transition without gaps or overlap, and persisted line evidence reconciles matching-line bonuses plus nonmatching-line base awards;
- monitor historical backfill commit leases (`commitLeaseId`), alerting on leases remaining active longer than 5 minutes or jobs stuck in `committing`;
- audit analytics exports for strict zero-PII compliance and verify circulating liability reports match underlying Prisma ledger sums.

## 8. Kill switch and rollback

The workspace owner can activate `killSwitchActive` or disable the program. This stops new loyalty earning/redemption while commerce ingestion should continue.

- **Bonus Campaign Emergency Rollback**: Early deactivation (`isActive: false`) is permitted mid-flight; running campaigns cannot have their multiplier, schedule, VIP audience, SKU list, or collection list edited in-flight. Early deactivation immediately halts bonus multipliers on subsequent orders while preserving immutable policy, grant, line-target, and pending holding-period evidence.
- **Historical Backfill Job Rollback**: Cancellation is permitted while a backfill job is in `pending` or `preview_ready` status with zero financial impact; once points liability has been committed (`committing` or `completed`), cancellation is rejected to prevent ledger inconsistency. Reconcile recorded ledger liabilities before re-attempting any backfill job.

Do not roll database schema backward blindly. Stop new loyalty activity, drain or pause workers, inspect in-flight grants/redemptions/jobs, and choose a forward fix or a backup restore based on the exact failure. Schema changes and remote Shopify discounts are not reverted by toggling the program status.

## 9. Privacy

Shopify mandatory privacy webhooks and Weletic retention policy must be verified in the deployed environment. Immutable/audit data does not justify retaining cleartext shopper PII indefinitely; redact identity fields while preserving non-identifying financial event records where legally permitted.

Before activating each store, exercise `customers/data_request` and
`customers/redact` with signed, authorized test webhooks. Confirm the ingress
persists before acknowledging, works without a live Admin token, rejects
mismatched header/body tenants, and is idempotent by Shopify webhook ID. Verify
that a redact-first customer cannot be recreated by delayed customer/order
ingestion, unused vouchers are remotely deactivated before points are restored,
remotely used vouchers are never compensated, and the exported encrypted
objects plus bearer token are physically removed after expiry. Do not deliver a
data-request artifact to an external support/storage destination until that
destination and retention policy are explicitly configured and authorized.

Exercise `app/uninstalled` and `shop/redact` only on an authorized disposable
installation. They are destructive lifecycle topics and must not be fired
against a retained staging or merchant store merely to satisfy a test plan. Any
compliance request or voucher cleanup in `dead_letter` is an operator blocker,
not a successful rollout.
