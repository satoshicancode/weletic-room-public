# Weletic Customer Loyalty documentation

**Last updated:** 2026-09-06

Start with the [unified acceptance matrix](./unified-acceptance-matrix.md) for the approved 12-package loyalty/reviews scope and outstanding gates. This directory also retains qualified historical staging evidence; it does not claim full Smile.io/Judge.me parity or production readiness.

The [shared shopper profile checkpoint](./shopper-profile-foundation.md) covers
the read-only directory/profile API and Weletic merchant view, its local proofs,
and the remaining shared-settings and Shopify/customer UI gates.

`yamaxdev` is the implementation/acceptance environment; `n0pvef-cs` is the paid-trial competitor reference. Public-app foundations are in scope, but external-merchant launch/billing, POS and Plus-only checkout remain deferred. Gift Card/Store Credit API-management and settlement proof must remain separately qualified under the approved payment addendum.

The [module lifecycle foundation](./module-lifecycle-foundation.md) documents
explicit loyalty activation, independent shopper ingestion and the remaining
shared-settings/live-acceptance work.

| Document                                                        | Purpose                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Capability and Smile.io comparison](./capability-matrix.md)    | Current target-store observations, Weletic capability status, reusable platform components, and remaining gaps.  |
| [Architecture](./ARCHITECTURE.md)                               | Tenant boundaries, financial event model, Shopify surfaces, and asynchronous processing.                         |
| [API reference](./API_REFERENCE.md)                             | Authenticated Shopify gateways, internal service routes, merchant APIs, and intentionally retired public routes. |
| [Security architecture](./token-security-architecture.md)       | Shopify authentication, signed internal requests, RBAC, and zero-PII storefront rules.                           |
| [Points accounting guide](./financial-accounting-guide.md)      | Exact arithmetic, append-only event ledger, holding periods, refunds, OCC, and reconciliation.                   |
| [Discount saga runbook](./discount-saga-runbook.md)             | Shopify GraphQL `2026-07` provisioning, compensation, recovery, expiry, and outbox operations.                   |
| [Merchant rollout runbook](./merchant-rollout-runbook.md)       | Required infrastructure, schema preflight, backfill, live validation, enablement, and rollback.                  |
| [Rollout checklist](./ROLLOUT_CHECKLIST.md)                     | Environment-specific launch gates. Unchecked items must be completed for each deployment.                        |
| [Superseded parity analysis](./SMILE_GROWTH_PARITY_ANALYSIS.md) | Records why the earlier 100% parity assessment must not be used as a readiness claim.                            |

## Authority and evidence

[unified-acceptance-matrix.md](./unified-acceptance-matrix.md) is the current scope/acceptance checkpoint. [capability-matrix.md](./capability-matrix.md) retains the historical capability inventory and named-store observations. Infrastructure validation, the composite A1 lifecycle harness, the real fixed-amount checkout/order/refund lifecycle, the Gift Card and Store Credit financial lifecycle, and Shopify CLI app-version deployment are different evidence classes and must not be substituted for one another.

`docs/architecture/LOYALTY_DEEPENING_SPECIFICATION.md` is a historical design proposal. It is superseded and non-authoritative for implementation status, Smile.io parity, rollout, or readiness claims; retain it only as design history.

## Verification commands

From the repository root:

```bash
pnpm --filter web prisma:generate
pnpm --filter web exec tsc --noEmit
pnpm --filter @weletic/shopify-app exec tsc --noEmit
pnpm --filter @weletic/shopify-app exec shopify app build
pnpm --filter web test:unit
```

The real-database concurrency suite is opt-in and refuses a database whose name does not start with `weletic_loyalty_it_`:

```bash
LOYALTY_DATABASE_INTEGRATION=1 \
DATABASE_URL='mysql://.../weletic_loyalty_it_<unique>' \
pnpm --filter web exec vitest run \
  --config vitest.loyalty-db.config.ts \
  tests/weletic/loyalty-ledger-db.integration.test.ts
```

The infrastructure validator uses the exact connected store record and offline Shopify credentials. Dry-run validates read-only prerequisites; the default mode creates and then cleans up test discounts and may provision missing webhooks:

```bash
pnpm --filter web exec dotenv-flow -e .env -- \
  tsx --conditions=react-server \
  --import=./scripts/runtime/async-local-storage.cjs \
  ./scripts/loyalty/validate-test-store.ts \
  --store=n0pvef-cs.myshopify.com --dry-run --json
```

As of 2026-09-01, the [hardened infrastructure-validator report](./evidence/infrastructure-validator-staging-2026-08-31-v2.json) passed 16/16 checks on the target staging store. It includes fixed-amount, percentage, free-shipping, and free-product/BXGY discount adapter lifecycles with nonce-bound ownership, authoritative-currency and immutable-configuration readback, deactivation/deletion, exact-GID absence cleanup, and canonical webhook provisioning. Its service-HMAC and Customer Account claim inputs remain local/static evidence rather than live App Proxy or JWT proof.

Separately, the final [A1 Shopify Basic lifecycle v14 report](./evidence/a1-basic-lifecycle-staging-2026-08-31-v14.json) passed 13/13 checks and exact configuration/fixture cleanup. It proves live customer provisioning and live Shopify Admin discount/metafield readback, HMAC-signed synthetic order/refund/referral/privacy ingress, and exact logical-time worker execution. Its cleanup restored both remote and local baselines before releasing the maintenance lease and removing the encrypted recovery capsule. Earlier failed and recovery reports remain immutable audit history; v14 is the A1 release result.

The [real checkout lifecycle report](./evidence/real-checkout-lifecycle-staging-2026-08-31.json) independently proves one native fixed-amount coupon checkout, one paid order and registered webhook retry, one full item-plus-shipping refund, the registered refund webhook, an idempotent correction for the discovered discounted-full-return defect, and payment-baseline restoration. It does not prove the remaining reward types or order/refund shapes.

The [financial reward lifecycle report](./evidence/financial-reward-lifecycle-staging-2026-09-01.json) independently passed 13/13 Gift Card and Store Credit issuance, exact readback, wallet, reversal, customer-deletion, and zero-residue cleanup checks. It does not prove checkout use or expiry.

On 2026-09-01, `shopify app versions list --json` reported `loyalty-store-credit-readback-2026-09-01` as the active app version. This confirms deployment of the current extension bundle, not merchant enablement, exact Loyalty Hub rendering, or live exercise of the expanded Hub contracts. External `customers/data_request` delivery, `app/uninstalled`, `shop/redact`, the remaining shopper lifecycles, and the Online Store theme/App Proxy flow still require separate evidence. Shopify Plus activation and the external partner-store service remain deferred.
