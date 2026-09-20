# ADR 0041: Review privacy, Flow grant arithmetic and execution

- Date: 2026-09-20
- Status: Accepted
- Stakeholders: Hiro (product owner), Codex (technical lead and implementer)

## Context

Public review aggregates must exclude erased identities even when the review
has no directly linked shopper tombstone. Per-row filtering after pagination
cannot make counts, cursors or summaries correct. The growing review surface
needs a consistent store-scoped eligibility predicate.

The Flow action's isolated SQL tests exposed Prisma's signed integer boundary
for nonnegative grant limits, budgets and usage, including the absolute value
of the minimum signed ledger amount. Rounding or restricting valid absolute
values is not acceptable. Separately, path-filtered CI reports skipped jobs even
when a full workflow on the identical commit succeeds; the previous strict
merge rule treated those skips as a blocker.

Hiro explicitly approved the three recommended choices and delegated routine
technical decisions and execution to Codex. This does not waive external release
gates in the approved completion plan.

## Decision

Use an indexed, store-scoped HMAC identity projection for review privacy, with
explicit key IDs, coverage/backfill state, atomic writer updates and rotation
tests. Missing coverage fails closed. Do not publish raw identities, digests or
private owner mappings. Apply the same eligibility predicate to public rows,
counts, summaries and pagination before enabling affected surfaces.

Use `DECIMAL(20,0)` for `maxAbsolutePointsPerAction`, `absolutePointsBudget`
and `absolutePointsUsed`, with canonical decimal strings and BigInt validation
at boundaries. Preserve the approved nonnegative range and reject fractional
or noncanonical input. Keep Shopify identifiers as strings and financial ledger
amounts signed integers; never convert these values through JavaScript Number.
Rehearse reader-before-writer migration locally; shared schema application
remains separately gated. The initial chat shorthand incorrectly called these
Flow IDs; source and failing SQL evidence identify grant quantities, not IDs.

For this completion plan, path-filtered skips may be accepted only when all jobs
of a separate full run succeed on the exact current PR head, required branch
checks pass, the branch is CLEAN/MERGEABLE and review findings are resolved.
Pending, failed or cancelled checks are not waived. Revalidate after branch
updates; never bypass server protection or force-push to obtain a merge.

Codex owns implementation, self-review, verification, commits, PRs, eligible
merges and routine technical choices. Do not ask Hiro to perform code review or
approve each ordinary step. Spending, shared/production migrations, real sends
and orders, publication/submission and production activation retain scoped gates.

## Alternatives considered

- **Per-request owner scans:** rejected as the default because aggregate
  correctness would require scanning the full eligible set, with unbounded cost.
- **Unsigned BIGINT with a separate raw-SQL repository:** rejected in favor of
  exact decimal persistence through the existing ORM boundary.
- **Treat every classifier skip as a merge failure:** replaced by exact-head
  full-run evidence; no relaxation of test coverage or branch protection.

## Consequences

### Positive

- Consistent privacy eligibility and exact Flow grant arithmetic.
- Technical work can proceed without repeated routine approvals.

### Negative / trade-offs accepted

- Projection maintenance, backfill and key rotation add operational complexity.
- Decimal grant migration requires compatibility and range tests.
- Full workflow evidence must remain bound to the actual commit being merged.

### Follow-ups

- Implement and rehearse both data changes with privacy/concurrency regressions.
- Revalidate pending PRs; resolve drift without discarding unrelated drafts.
- Preserve named live acceptance and independent production release gates.

## References

- [Approved completion scope](0040-company-store-loyalty-and-reviews-completion.md)
- [Completion checklist](../loyalty/company-store-completion.md)
- Hiro's explicit approval in this task on September 20, 2026.
