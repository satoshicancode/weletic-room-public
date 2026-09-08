# ADR 0001: Global accounting currency

- Date: 2026-08-14
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic sells through Shopify across multiple markets. Customers can see and
pay in a presentment currency that differs from Shopify's shop currency, while
partners can reside in other countries and request payouts in a third currency.
Dub's current conversion path normalizes non-USD sales to USD immediately and
many aggregate fields assume that all stored amounts are directly additive.

Mixed-currency aggregation would make commission totals, payout thresholds,
refunds, and financial reconciliation ambiguous. Keeping a separate ledger for
every market currency would preserve original amounts, but it would multiply
the complexity of global reporting and cross-market partner payouts.

## Decision

Each Weletic partner program will have one configurable accounting currency.
The initial accounting currency is USD. Shopify presentment currency, Shopify
shop currency, and partner payout currency remain separate concepts and must
be preserved alongside the accounting amount.

Every currency conversion used for a commission or payout will be snapshotted
with its source and target currencies, rate, provider, timestamp, and rounding
result. Historical financial values will not be recalculated when rates change.

## Alternatives considered

- **Separate ledger per market currency** — Retain earnings independently in
  each sale currency. Rejected because reporting, payout thresholds, and
  partners earning across markets become substantially harder to reconcile.
- **Hard-code USD throughout the product** — Keep Dub's current normalization
  behavior. Rejected because it discards the distinction between presentment,
  shop, accounting, and payout money and prevents a future base-currency change.

## Consequences

### Positive

- Program-wide sales, commissions, thresholds, and reports are additive.
- Original Shopify amounts remain auditable in the customer's currency.
- The accounting currency can change for a future program or legal entity
  without redesigning the money model.
- Partners can be paid through country-specific methods and currencies without
  changing historical commissions.

### Negative / trade-offs accepted

- Every non-accounting-currency transaction requires an explicit FX snapshot.
- Rounding differences must be recorded and reconciled.
- Existing USD-normalization code and currency-implicit aggregates need a
  compatibility migration.

### Follow-ups

- Define a shared Money type using ISO 4217 currency codes and minor units.
- Add the program accounting-currency field and backfill existing programs to
  USD.
- Add immutable FX snapshots to commerce commission and payout calculations.
- Preserve Shopify presentment and shop money for orders and refunds.
- Make dashboards, exports, emails, and payout thresholds currency-aware.

## References

- Hiro approval in the Weletic Partners architecture discussion on 2026-08-14.
- `apps/web/lib/api/conversions/track-sale.ts`
- `apps/web/lib/analytics/convert-currency.ts`
- https://shopify.dev/docs/apps/build/markets/index
