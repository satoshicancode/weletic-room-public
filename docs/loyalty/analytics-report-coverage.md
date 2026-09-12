# Loyalty analytics report coverage

Checkpoint: September 13, 2026; inspected public main through PR #32
(`6e6c46882602ae72e7991fa32eea3211f1e2652f`). **Analytics is not accepted live.**
This fulfills the report-disposition inventory, not the report implementations.

The [preserved benchmark](benchmark-smile-2026-09-08.md) identifies 34 included
reports plus two separately locked Finance reports. Its September 9 supplement
records filters, visible columns and UI-described definitions. Empty grids,
virtualized columns and locked reports remain unknown; no formulas are inferred
from titles. No renewed Smile access is required to start the tasks below.

## Current implementation evidence

- [Merchant contract](../../apps/web/lib/weletic/loyalty/merchant-analytics-contract.ts):
  one strict aggregate snapshot with liability, point activity, referral
  economics/current statuses, reward current statuses and current VIP assignments.
  There are no time buckets, sequential funnel stages or member-comparison fields.
- [Signed merchant service](../../apps/web/lib/weletic/shopify/merchant-analytics.ts):
  authenticated store scope and repeatable-read transaction; exports require the
  current owner and installation generation. CSV walks the same snapshot as JSON.
  It does not export customer, discount-code or order rows.
- [Existing calculations](../../apps/web/lib/weletic/loyalty/analytics.ts):
  reusable liability, health, referral economics and tier helpers, plus legacy
  cohort/extended-export functions. Function presence does not establish merchant
  exposure or reconcile a similarly named Smile metric.
- [Screen](../../apps/web/ui/weletic/loyalty/merchant-analytics-screen.tsx) and
  [copy](../../apps/web/ui/weletic/loyalty/merchant-analytics-copy.ts): current
  statuses are explicitly described as non-sequential; date boundaries are UTC.
- [Merchant tests](../../apps/web/tests/weletic/merchant-analytics.test.ts) and
  [analytics matrix tests](../../apps/web/tests/weletic/loyalty-analytics-matrix.test.ts)
  provide local service/calculation evidence, not named store SQL reconciliation.
  The [original checkpoint](merchant-analytics-implementation.md) records bounded
  UI/build evidence and its remaining gates.

`Partial` below means a related aggregate exists, not parity. `Missing` means the
current signed merchant snapshot has no report equivalent. `Decision` and
`Unknown` identify constraints that implementation must not silently guess.

## All 36 report dispositions

| ID  | Preserved report                              | Current disposition and remaining task                                                                                                                                                                     |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | List of customers                             | **Decision / missing.** Aggregate member counts only; customer-row fields and export privacy policy require A01.                                                                                           |
| S02 | List of customers by VIP tier                 | **Decision / partial.** Current tier counts exist, not customer rows, next-tier deltas or membership dates. A01, A05.                                                                                      |
| S03 | List of customers who can redeem              | **Unknown / missing.** Smile grid was empty. Do not infer its complete columns or affordability logic. A01 must use actual reward eligibility, not balance alone.                                          |
| S04 | List of customers with points expiring        | **Unknown / missing.** Empty reference grid and incomplete interval evidence. A01 needs actual lot expiry/schedule semantics and approved recipient fields.                                                |
| S05 | List of discounts created by Smile            | **Decision / partial.** Redemption counts by status/artifact exist, not code/recipient/issuance/usage rows or the complete reference filters. A01, A08.                                                    |
| S06 | List of excluded products                     | **Unknown / missing.** Reference date control observed, no row schema. A01 configuration-only branch must identify current versus revision-time exclusion semantics; do not invent historic exclusions.    |
| S07 | List of orders                                | **Decision / missing.** No signed merchant order-row export. A01 must reconcile accounting currency, refund meaning and authorized order identifiers.                                                      |
| S08 | List of orders by VIP tier                    | **Decision / missing.** Current VIP assignment cannot establish a tier at order time. A01, A05 require preserved temporal evidence.                                                                        |
| S09 | List of orders placed by referred customers   | **Unknown / missing.** Empty reference grid. A01, A06 must distinguish qualifying order from subsequent referred-customer orders.                                                                          |
| S10 | List of points redemptions                    | **Decision / partial.** Aggregate points/status/artifact counts exist, not event rows and channel/date filters. A01.                                                                                       |
| S11 | List of points transactions                   | **Decision / partial.** Aggregate ledger activity exists, not row-level points/type/range export. A01; preserve opening-balance and correction identities.                                                 |
| S12 | List of referrals                             | **Unknown / missing.** Empty reference grid; current status totals are not referral rows or historical transitions. A01, A06.                                                                              |
| S13 | List of Smile influenced orders               | **Unknown / missing.** No complete reference schema or signed equivalent. A01, A06 need unique order attribution before exposing this label.                                                               |
| S14 | List of top earning customers all-time        | **Decision / missing.** Reference minimum points was visible; rows were empty. A01 must define legitimate earns versus imports/manual credits and tie ordering.                                            |
| S15 | List of VIP tier changes                      | **Decision / missing.** Persisted tier history exists, not an owner-authorized row report. A01, A05.                                                                                                       |
| S16 | Order earning rate over time                  | **Missing.** No time-bucketed distinct earning-order/all-order numerator and denominator in merchant snapshot. A02.                                                                                        |
| S17 | Redemption rate over time                     | **Partial.** Point activity totals and a legacy rate exist; no merchant time series or displayed denominator. A02 must specify imports/refunds/zero denominator explicitly.                                |
| S18 | Reward usage rate over time                   | **Partial.** Current redemption-status counts are not observed discount usage over time. A02, A08 must reconcile issued/used dates, source and untracked usage.                                            |
| S19 | Sales influenced by Smile over time           | **Missing.** Aggregate referral economics cannot establish the deduplicated union of points/VIP/referral-influenced orders. A06.                                                                           |
| S20 | Smile benchmarks                              | **Unavailable / decision.** No proprietary peer dataset exists for company stores. A09: no fabricated peer comparison; historical target replacement requires a product decision.                          |
| S21 | First time vs repeat earners over time        | **Missing.** Current member/non-member helper is a different cohort. A03 needs first-ever qualifying earn evidence, not first event within the selected window.                                            |
| S22 | First time vs repeat redeemers over time      | **Missing.** Current status totals cannot identify first-ever successful redemption. A03.                                                                                                                  |
| S23 | Outstanding points over time                  | **Partial.** Current liability exists, not historical balances/expiry/debt evolution. A02 needs an opening boundary and exact cumulative movements.                                                        |
| S24 | Points activity over time                     | **Partial.** Selected-window ledger categories exist, without interval buckets. A02 must preserve separate imports, corrections and manual movements.                                                      |
| S25 | Top ways to earn                              | **Unknown / missing.** Reference shows Comment/Total but Total's meaning is unknown. A04 must publish Weletic's own count/point measures and provenance.                                                   |
| S26 | Top ways to redeem                            | **Unknown / partial.** Status/artifact grouping is not reward-name ranking; reference Total is undefined. A04.                                                                                             |
| S27 | Total members over time                       | **Partial.** Current total exists, without joining dates/cumulative membership history. A05.                                                                                                               |
| S28 | Referral conversion rate over time            | **Missing.** Legacy successful-referrals/total-referrals rate is not completed-referrals/link-clicks. A06 requires an actual traffic denominator and sequential evidence.                                  |
| S29 | Referral traffic over time                    | **Missing.** No dedicated referral-click collector/aggregate was found in the inspected loyalty paths. Do not substitute referral records or repeated page opens without a tracking/privacy contract. A06. |
| S30 | Sales from referred customers over time       | **Partial.** Referral economics exists, not a time series covering qualifying and subsequent referred-customer orders. A06.                                                                                |
| S31 | Top referrers                                 | **Unknown / decision.** Empty reference grid; completion-date control observed. A01, A06 must settle authorized ranking fields and completed/refunded meaning.                                             |
| S32 | VIP tier behaviour over time                  | **Unknown / missing.** Both reference sections were empty. A05 must define Weletic segment metrics from temporal evidence; do not invent Smile's columns.                                                  |
| S33 | VIP tier changes over time                    | **Partial.** Tier-history source exists, not time-bucketed added/promoted/demoted/removed counts. A05.                                                                                                     |
| S34 | VIP tier members over time                    | **Partial.** Current assignment groups exist, not historical tier membership. A05.                                                                                                                         |
| S35 | Financial value of discounts issued over time | **Platform-gated / unknown.** Smile Plus controls/formula were not observed. A08 must use Weletic's approved issued-value accounting, not equate face value, spent points and economic cost.               |
| S36 | Financial value of outstanding points         | **Platform-gated / partial.** Exact current rational liability exists. Smile's locked formula is unknown; A08 retains Weletic valuation and unavailable states, with independent SQL evidence.             |

## Implementation-ready follow-ups

All tasks retain the existing signed gateway, actor-derived store scope,
owner-only exports, no-store responses, generation fencing and aggregate-only
DOM. No customer export or new public write endpoint is implicitly approved.

### A01 — Explicit row-export/privacy contract

Scope: S01–S15/S31 row reports and S06 configuration-only inventory. Existing
scalar CSV/JSON is not an authorization to add names, emails, IDs, referral URLs
or discount codes. Decision needed: allowed fields, roles, retention/download
policy and whether a particular report should remain aggregate-only. Keep S06
separate because it can be configuration data without customer identity.

Approach: define one strict schema per approved report, use actor-scoped queries,
bounded pagination/size, source revisions where relevant, and formula-safe CSV.
Dependencies: field-policy decision and actual source evidence; empty Smile grids
do not supply either. Tests: owner/staff denial, foreign tenant/generation,
date/point filters, pagination ties, CSV injection and payload/DOM privacy.
Done: approved schemas, exact independently reconciled exports and named signed
merchant acceptance. Until then, customer-row equivalents remain gated.

### A02 — Time-bucketed activity and denominators

Scope: S16–S18/S23/S24. Extend exact analytics and merchant contracts/UI with
explicit bucket timezone, inclusive range boundaries, event timestamps and both
numerator/denominator. Use immutable ledger/earn/redemption evidence; do not
derive event-time usage from a redemption's current status.

Dependencies: source coverage for actual discount use and explicit unknown
behavior; existing UTC filters are not proof of historical bucket semantics.
Tests: empty/zero denominator, month boundaries, multiple order lines counted
once, pending maturity, expiry, imports/manual adjustments, partial/full refunds,
late changes, very large integers and independent SQL. Done: reconciled series,
truthful unavailable values, matching CSV/JSON and EN/JA/VI display.

### A03 — First/repeat event cohorts

Scope: S21/S22. Determine each shopper's first-ever eligible earn/redemption
before applying the report window; group distinct shoppers per bucket. Define
whether reversed/failed/pending events qualify from existing lifecycle evidence,
not from an account's current balance or membership alone.

Dependencies: documented eligible-event rules and retained event history; erased
or missing history must not silently become first-time activity. Tests: first
event before window, repeated events in one bucket, imports, failed issuance,
replay, refunds and privacy erasure. Done: exact distinct counts/denominators,
proven source coverage and signed aggregate exposure with no shopper IDs.

### A04 — Earning/redemption breakdowns

Scope: S25/S26. Group immutable action/reward revision provenance, not mutable
display names alone; expose separately named event counts and exact point totals.
The reference's undefined Total column is not a formula specification.

Dependencies: source provenance for historical records; use an explicit unknown
group instead of guessing. Tests: renamed/deleted rules, shared names, correction
entries, zero-point coupons, refunds, imports and CSV injection. Done: rankings
reconcile to the corresponding activity totals with documented exclusions and
matching exports/localized screen.

### A05 — Membership and VIP temporal reports

Scope: S02/S08/S15/S27/S32–S34. Reconstruct history from membership creation and
persisted tier changes, distinguishing null/unavailable assignments and current
snapshots. Do not apply today's tier to historical orders.

Dependencies: historic completeness and explicit membership/segment definitions;
S32's reference schema remains unknown. Tests: tier entry/upgrade/downgrade,
grace, deletion, same-time transitions, import without entry rewards and privacy
cleanup. Done: independently reconciled temporal counts, documented unknown
intervals, source-backed segment metrics and named merchant acceptance.

### A06 — Sequential referrals and unique revenue attribution

Scope: S09/S12/S13/S19/S28–S31. A current status histogram is not a funnel.
Referral creation, retained claim metadata, immutable qualification origins and
reward receipts offer different evidence levels. A collector for link clicks
was not found in the inspected loyalty code; traffic cannot be synthesized from
the number of referral rows.

Approach: define event-time start/qualification/completion transitions, retention
and original generation; count distinct referrals through ordered stages. Treat
click collection/deduplication/consent as an explicit instrumentation decision,
not permission to add an unauthenticated public write API. Preserve unknown
traffic/conversion when the denominator is absent. Attribute each order once
across points/VIP/referral influences and distinguish qualifying from subsequent
referred-customer orders.

Tests: repeated clicks/claims, event order/window crossings, coupon retries,
anonymous-to-account claim, fraud, cancellation/clawback, multi-source order
attribution, mixed currencies and independent SQL. Done: documented event and
denominator contracts, actual source coverage, exact funnel/revenue exports and
named live acceptance—not a relabeled status table.

### A07 — Member-comparison metrics outside the report-ID catalog

The legacy `calculateMemberCohortAttribution` queries current loyalty accounts
and selected-window orders. It does not prove membership at purchase time.
Its `ltv` is spend per ordering customer, not Smile's UI-described three-year
estimate. `getOrderAmountMinorUnits` permits fallback amount fields, while the
database path selects accounting totals; refund handling and anonymous shopper
identity need explicit reconciliation before merchant exposure.

Scope: expose validated comparison metrics with truthful cohort/time labels,
exact rational averages/lifts and null baselines. Do not publish the old `ltv`
under an estimated lifetime-value label. Dependencies: documented membership
timing, order/refund/net-or-gross semantics and anonymous-identity handling.
Tests: joining after purchase, no customer identity, repeated orders, refunded
orders, mixed currencies, zero baseline and amounts above Number precision.
Done: approved/labeled definitions, exact SQL comparison and shared signed
UI/export contracts. The current helper is a starting point, not acceptance.

### A08 — Financial and reward-usage reconciliation

Scope: S05/S18/S35/S36. Preserve rational point valuation and exact accounting
currency. Distinguish outstanding liability, face value issued, remotely observed
usage, cancellation/expiry, stored-value remaining balance and unrecoverable cost.
Do not silently equate these quantities or infer a locked Smile formula.

Dependencies: authoritative per-artifact capability/evidence and reviewed
valuation; stored-value limitations remain visibly unavailable. Tests: missing
valuation, missing/mismatched currency, partial usage/refunds, duplicate remote
receipts, fractional point values, zero cost and independent SQL/export totals.
Done: every exposed monetary measure has a source/formula/evidence disposition;
unsupported measures are null/unavailable, not zero or simulated.

### A09 — Peer benchmark disposition

Scope: S20. No peer comparison is implemented or certified because no authorized
peer dataset exists. Keep it unavailable. If Hiro wants company historical
targets instead, obtain that product decision and label them as company targets,
not Smile or industry benchmarks. Done: explicit product disposition in the UI
and coverage map; no invented values or external merchant data acquisition.

## Verification of this inventory

All S01–S36 IDs appear exactly once in the disposition table. Report titles match
the preserved catalog. Every row names an implementation task or a constrained
unknown/decision. This document adds no API, data collection, feature activation,
runtime schema, deployment or live-acceptance claim. L11 and the applicable
acceptance-matrix analytics gates remain unchecked.
