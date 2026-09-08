# ADR 0005: Historical points as opening balance

- Date: 2026-08-16
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

ADR 0004 requires a full historical Shopify order and refund backfill for
identified customers. Because no Weletic loyalty rules existed when those
orders occurred, the backfill needs an explicit policy for calculating points,
making them available, and applying expiry. This policy determines the opening
reward liability shown to merchants before activation.

Chronologically replaying history would pretend that the loyalty program and
its holding and expiry policies existed at the time of every purchase. That can
cause points earned from valid old purchases to expire immediately at launch,
which is difficult to explain to customers. Applying the first live earning rule
retroactively would instead couple historical liability to a rule intended for
future commerce and make later configuration changes harder to audit.

## Decision

Historical points will be imported as an opening-balance grant. Each merchant
will configure and freeze a dedicated backfill rule. The rule will calculate
points from eligible historical net merchandise spend after discounts, excluding
taxes and shipping, and will reconcile all imported refunds before producing the
grant.

The ledger will preserve the original Shopify orders, refunds, line allocations,
and occurrence dates as source evidence. Customer-visible opening points become
available at loyalty activation, not at the original purchase dates. Any expiry
clock starts at activation. Backfill calculations remain hidden in preview state
until reconciliation succeeds and an authorized merchant explicitly activates
the opening balances. The frozen backfill rule never changes when live earning
rules are edited later.

Commit is a resumable, job-serialized conversion rather than an all-or-nothing
request. Each preview item receives one store-scoped idempotent ledger entry and
its committed marker in the same transaction; job counters are recomputed from
the immutable ledger liabilities. A process crash leaves the job `committing`
and a later caller may resume only after its bounded lease is stale. Store freeze
or installation-generation change stops further liabilities and records a
terminal `failed` audit with the exact partial count and points already granted;
that frozen preview snapshot cannot be restarted after reactivation.

## Alternatives considered

- **Chronological replay** — Apply earning, holding, refund, and expiry behavior
  from each order's original date. Rejected because the program did not exist at
  those dates, older points can expire immediately, and the result is hard for
  customers to understand.
- **Apply the first live rule retroactively** — Use the launch earning rule for
  all historical orders. Rejected because it couples opening liability to future
  program behavior and weakens auditability when live rules change.
- **Manual opening adjustments only** — Let merchants upload or enter balances
  without order-level calculation. Rejected because Weletic would lose the
  source-order and refund evidence needed for reconciliation and exact audit.

## Consequences

### Positive

- Merchants can preview and approve a clear opening liability before customers
  see points.
- Existing customers receive usable opening points rather than immediately
  expired historical entries.
- Historical evidence remains traceable to orders, lines, refunds, and a frozen
  rule version.
- Live earning-rule changes cannot silently alter the historical grant.
- Retry and reconciliation can remain idempotent because preview calculations
  are separate from activated ledger entries.

### Negative / trade-offs accepted

- Backfill requires a separate merchant configuration and activation step.
- The opening balance does not simulate the counterfactual history of a loyalty
  program that never existed.
- All opening points become available together at activation, increasing initial
  redemption liability.
- Expiry dates cluster around the activation date unless later customer activity
  policies spread them out.
- Preview storage, reconciliation reporting, activation authorization, and an
  immutable rule snapshot add implementation scope.

### Follow-ups

- Add a versioned backfill rule with a frozen status and activation reference.
- Build a resumable dry-run importer for all eligible Shopify orders and refunds.
- Store per-order and per-line preview calculations with stable idempotency keys.
- Report included and excluded orders, refunds, customers, proposed points,
  negative balances, and estimated reward liability before activation.
- Require workspace owner authorization to activate the reconciled preview.
- Atomically convert approved preview totals into available opening-balance
  ledger entries while retaining source-level calculation evidence.
- Start expiry from activation and document that behavior in merchant and
  customer-facing policy text.
- Prevent live earning-rule edits from mutating or recalculating an activated
  historical grant.

## References

- Hiro approval of Option A, opening-balance grant, in the Weletic Room
  architecture discussion on 2026-08-16.
- `docs/adr/0003-customer-loyalty-bounded-context.md`
- `docs/adr/0004-loyalty-activation-and-balance-policies.md`
- `/Users/hironguyen/.codex/memories/project_adr_0005.md`
- `apps/web/prisma/schema/weletic-commerce.prisma`
- `apps/web/lib/weletic/commerce/record-order.ts`
- `apps/web/lib/weletic/commerce/record-refund.ts`
