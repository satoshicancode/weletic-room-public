# Reward issuance confirmation: S18 prerequisite

## Contract

`WeleticRewardRedemption.issuanceConfirmedAt` is nullable and records when a
local transaction first durably confirms a remotely issued reward. Discount,
gift-card, store-credit, referral-coupon and shopper-review-coupon finalizers
set it only while changing a reserved/provisioning redemption to `issued`.
Exact-match adoption after an uncertain remote response uses the same transition.
An already-issued replay does not change the timestamp.

This is local confirmation time. It is not necessarily the remote artifact's
creation time. Existing redemptions remain `NULL`, because `createdAt` records
reservation and cannot prove issuance. S18 reward usage rate still needs an
explicit coverage denominator, observed use/cancellation sources, historical
disposition and reconciliation. The new field does not make S18 available.

Shopper privacy exports include this timestamp. The value remains associated
with the redemption through later use, cancellation and refund handling.

## Deployment boundary

The additive SQL file is
[`20260925_loyalty_redemption_issuance_confirmation.sql`](../../infra/shopify-development/migrations/20260925_loyalty_redemption_issuance_confirmation.sql).
Before applying it to any shared target, capture exact table/index metadata,
confirm that the column and index are absent, review provider DDL behavior and
mixed-version workers, and approve a schema-first window. Deploy writers only
after that target has both objects. If DDL partially applies, inspect metadata
and use a forward repair; do not rerun the whole file blindly. No shared target
was migrated by this change.

## Verification and remaining gates

The SQL applied to a disposable MySQL 8.0.46 database created from the prior
public-main Prisma schema. The current Prisma schema then reported "already in
sync"; metadata showed a nullable `DATETIME(3)` and the `(storeId,
issuanceConfirmedAt)` index. A bounded date-range query selected that index in
`EXPLAIN`. Focused tests cover first confirmation and uncertain-outcome adoption.
The disposable SQL fixture transitioned one provisioning row once, rejected a
second guarded transition, and retained `NULL` for a preexisting issued row.
The full web unit suite passed with a local fixture Shopify app key: 669 files,
10,482 tests passed and six skipped. Focused issuance tests passed 145/145;
Prisma validation, TypeScript and web lint passed. The Shopify CLI app build
also passed, and the generated review asset checked at 8,419 bytes. The web
production build passed against the disposable MySQL fixture, including static
page generation. CI, the shopper SQL integration suite and target-specific
deployment evidence remain separate gates. The shopper suite's fixed local
port 3307 was already held by an unrelated SSH process, which was left
untouched; the new assertions must run in isolated SQL CI.
