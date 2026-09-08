# Weletic Customer Loyalty rollout checklist

**Last updated:** 2026-09-01

This checklist is intentionally unchecked. Complete it separately for every deployment and merchant store.

Current product scope is Weletic's in-house brands on Shopify Basic. The active shopper surfaces in this release are the Online Store theme/App Proxy and Shopify Customer Accounts. Native reward acceptance in standard Shopify Basic checkout remains in scope. A Shopify POS amount/percentage gateway and extension are built, but activation remains deferred until customer-selection binding and its threat model are confirmed. The custom Checkout UI extension, every Shopify Plus-only capability, and the external partner-store service are also deferred.

PR #24, the [hardened 16/16 infrastructure-validator report](./evidence/infrastructure-validator-staging-2026-08-31-v2.json), the final [A1 Shopify Basic lifecycle v14 report](./evidence/a1-basic-lifecycle-staging-2026-08-31-v14.json), the [real checkout lifecycle report](./evidence/real-checkout-lifecycle-staging-2026-08-31.json), and the [financial reward lifecycle report](./evidence/financial-reward-lifecycle-staging-2026-09-01.json) are staging evidence only. V14 passed 13/13 lifecycle checks and exact cleanup using live customer provisioning and Shopify Admin readback, HMAC-signed synthetic order/refund/referral/privacy ingress, and exact logical-time workers. The real lifecycle separately proves one fixed-amount coupon checkout, real order/refund webhooks, exact corrected full-return clawback, and payment-baseline restoration. The financial report proves live Gift Card and Store Credit issuance, exact readback, wallet persistence, reversal, and zero-residue cleanup; it does not prove checkout use or expiry. None of this evidence pre-checks another database, environment, or store.

On 2026-09-01, `shopify app versions list --json` reported `loyalty-store-credit-readback-2026-09-01` as active. That is app-version deployment evidence only; it does not pre-check Customer Account page enablement, exact Loyalty Hub rendering, theme enablement, POS installation, or live shopper behavior.

The real lifecycle closes only the single fixed-amount/full-refund evidence gap. Other reward types and order/refund shapes, external `customers/data_request` delivery, `app/uninstalled`, `shop/redact`, Shopify Plus capability, external partner flow, and Online Store theme/App Proxy shopper flow remain unproven. Those gates remain unchecked below.

## Database and application

- [ ] Prisma schema validates and generates.
- [ ] `backfill-order-credit-stage-1.sql` is applied in staging while API commits remain disabled; its enum extension, widened currency threshold, immutable snapshot table, and durable credit-marker table match the reviewed Prisma schema.
- [ ] `loyalty:audit-backfill` and `backfill-order-credit-stage-2-gate.sql` report zero repairable, replay-pending, unresolved, incomplete, orphaned, or nonconserving records before a separate change enables commits.
- [ ] Target-database diff has been reviewed for destructive or blocking changes.
- [ ] Existing loyalty idempotency keys are compatible with the new store-scoped unique constraints.
- [ ] A recoverable database snapshot exists before schema application.
- [ ] Loyalty mutation traffic and the outbox worker are paused for the schema/backfill maintenance window.
- [ ] No historical backfill job is `committing` while the additive
      `WeleticLoyaltyBackfillJob.commitLeaseId` column is deployed; workers
      resume only after the application and schema both support the durable
      lease.
- [ ] The ADR 0015 stage-1 canonical-code SQL is applied before the final Prisma constraint; a broad `prisma db push` has not skipped the staged migration.
- [ ] The global canonical-code audit/backfill runs with the exact drained-maintenance acknowledgement; invalid codes and collisions are durably quarantined and reconciled against Shopify.
- [ ] The final global dry audit is unscoped and reports `readyForFinalConstraint=true`, `scopedAuditOnly=false`, zero blocking reconciliation issues, and empty NULL/mismatch/duplicate/quarantine sets.
- [ ] The stage-2 `NOT NULL` plus store-scoped unique constraint is applied only after that global persisted-state gate passes.
- [ ] After schema application, `loyalty:migrate-ledger-version --dry-run` is reviewed and the live backfill completes with zero errors before the new application starts.
- [ ] A second ledger-version dry run reports every existing account synchronized to its maximum ledger sequence.
- [ ] Web and Shopify app type-checks, package build, Shopify extension build, lint, and unit tests pass.
- [ ] Real MySQL concurrency tests pass in an isolated `weletic_loyalty_it_*` database.

## Authentication and tenant isolation

- [ ] `WELETIC_SHOPIFY_SERVICE_SECRET` is configured consistently and rotated through the approved secret store.
- [ ] App Proxy and Customer Account gateways reject invalid/missing Shopify identity.
- [ ] Retired direct customer and checkout core routes return HTTP 410.
- [ ] Merchant routes derive store context from the authenticated workspace.
- [ ] Owner-only financial actions reject member/viewer roles.
- [ ] Cross-store account, reward, redemption, referral, and outbox identifiers fail closed.

## Shopify connection

- [ ] Exact store record and offline session resolve without fallback.
- [ ] A retained pre-generation installation passes the activation dry run with exactly one active kill-switched program and no provisioning redemption, committing backfill, pending deletion lifecycle, or nonterminal loyalty outbox job.
- [ ] Installation-generation activation is applied under `--maintenance-fence=loyalty-writers-paused-and-drained`; generation/currency columns were not filled manually.
- [ ] Every active store has non-null `currencyVerifiedAt`, and its stored
      currency matches an authoritative Shopify Admin GraphQL read.
- [ ] Reconnect/catalog currency changes serialize on store → program locks;
      stale voucher snapshots and stale discount reconciliation generations
      fail before Shopify or local auto-heal mutations.
- [ ] Required Shopify scopes are granted; Gift Card rewards have `read_gift_cards`, `write_gift_cards`, and `write_customers`; Store Credit has `read_store_credit_accounts` and `write_store_credit_account_transactions`; `read_all_orders` is present if the backfill requires it.
- [ ] The infrastructure validator's read-only checks pass for the exact deployment/store.
- [ ] Live fixed-amount, percentage, free-shipping, and free-product/BXGY adapter create/lookup/deactivate/delete checks pass and cleanup is confirmed.
- [ ] Live Gift Card creation, exact deterministic lookup/adoption, customer retrieval, checkout use, expiry, and deactivation cleanup pass without exposing the code in logs.
- [ ] Live Store Credit issue/use/expiry passes on new customer accounts; an injected lost-response case dead-letters for manual reconciliation without a second credit mutation.
- [ ] Required webhooks are registered at the deployed endpoints.
- [ ] GraphQL Admin API version is `2026-07` or an explicitly tested override.

## Loyalty behavior

- [ ] Concurrent distinct ledger writes do not lose updates.
- [ ] Duplicate idempotency requests create one financial mutation.
- [ ] Pending points mature once; pre-maturity refunds void pending points first.
- [ ] Partial and full refunds never reverse more than the source award.
- [ ] Discounted full-quantity returns reverse the complete source line award even when Shopify's cash refund is lower than the earning snapshot; supplemental maintenance correction is replay-idempotent.
- [ ] Failed discount provisioning restores points exactly once.
- [ ] An uncertain remote create never restores points on lookup misses alone;
      exhausted recovery dead-letters into manual reconciliation.
- [ ] A retry that finds its owned Shopify voucher already inactive converges
      local generic/referral state without requiring another remote mutation.
- [ ] Used vouchers cannot be cancelled or refunded by expiry.
- [ ] Unused voucher expiry restores points once and deactivates the Shopify discount.
- [ ] Referral qualification and refund clawback are store-scoped and idempotent.
- [ ] VIP upgrades, downgrade grace, and metafield sync pass against real store data.

## Compliance and privacy

- [ ] The versioned privacy HMAC keyring, tombstone/financial retention values, short export lifetime, private object storage, cron authentication, and compliance recovery schedule are explicitly configured.
- [ ] Mandatory compliance ingress persists before acknowledgement, validates HMAC and header/body tenant agreement, works without a live Admin token, and deduplicates by Shopify webhook ID.
- [ ] `customers/data_request` proves encrypted private export creation, authenticated download, and physical object/token removal after expiry without exposing data to an unauthorized external destination.
- [ ] `customers/redact` proves the tombstone prevents delayed customer/order ingestion from recreating the identity and drives exact unused-voucher cleanup without compensating used vouchers.
- [ ] `app/uninstalled` and `shop/redact` are rehearsed only on an authorized disposable installation. Do not fire either destructive topic against a retained staging/merchant store merely to satisfy this checklist.
- [ ] Compliance requests and voucher cleanup have no `failed`, `processing`, or `dead_letter` blocker before activation.

## Surfaces and operations

- [ ] Theme blocks/app embed are deployed and enabled.
- [ ] The active app version contains the Customer Account extension, the merchant has enabled its page target, and the expected Weletic Loyalty Hub version renders for a logged-in shopper.
- [ ] Before Shopify POS activation, confirm and test a customer-selection binding that the gateway can trust; then deploy the tile/modal and prove one amount and one percentage redemption on a real POS cart.
- [ ] The custom Checkout UI extension remains disabled; no Shopify Plus-only capability is part of this rollout. Standard Shopify Basic checkout reward acceptance is tested separately.
- [ ] The Customer Account flow independently passes summary, fixed/incremental redemption, coupon wallet/history, referral, order, and refund checks.
- [ ] The deployed Customer Account page is enabled and presented as the Weletic Loyalty Hub; its navigation label, all-tier VIP view, reward terms, points-shop progress, referral offers/sharing, activity views, campaign messaging, expiry copy, and financial-artifact presentation match the enabled program capabilities.
- [ ] The Online Store theme/App Proxy flow independently passes its logged-in shopper checks; Customer Account evidence has not been reused as proof for this surface.
- [ ] Storefront DOM contains no cleartext shopper PII or Shopify customer ID.
- [ ] Outbox cron or continuous worker is deployed and observed processing a real job.
- [ ] Manual/staging outbox runs use an exact store/job scope; logical-clock validation cannot process unrelated jobs.
- [ ] Alerts exist for webhook failures, outbox retries/dead letters, and stuck redemptions.
- [ ] Kill switch behavior is tested and the operator runbook is accessible.

## Product claims

- [ ] Merchant copy lists only reward types and sales channels that passed the store-specific rollout gates.
- [ ] Signup and birthday are not marketed until their complete live lifecycles pass; customer-intent social/link actions and the existing signed Judge.me integration are not marketed until their configured policy limits, provider setup, abuse controls, and live lifecycles are proven.
- [ ] Points expiry is not marketed as Smile-equivalent until warning and last-chance thresholds, consent-aware delivery, customer/admin reporting, and real elapsed-time worker operation are proven.
- [ ] Referrals are not marketed as Smile-equivalent until friend claim, one-time friend reward, first-real-order qualification, advocate fulfillment, social/email sharing, cancellation, refund clawback, and fraud-review activity are live-proven. Email delivery also needs a durable reservation/outbox state machine and either provider idempotency or an explicit ambiguous/no-auto-retry policy before production activation.
- [ ] VIP and bonus campaigns are not marketed as Smile-equivalent until entry rewards, tier history/requalification, downgrade grace, campaign overlap/duration/multiplier invariants, SKU/collection match-any allocation, and exact targeted-line order/refund effects are live-proven.
- [ ] Gift Card, Store Credit, and POS parity are not claimed until their live gates above pass; Flow, additional ESP, and full visual on-site-editor parity remain unimplemented and are not claimed.
- [ ] Merchant and shopper copy describes the current Shopify Basic, in-house-brand scope and makes no Shopify Plus or external-partner-service claim.
- [ ] The current [capability matrix](./capability-matrix.md) is linked from the release notes.
