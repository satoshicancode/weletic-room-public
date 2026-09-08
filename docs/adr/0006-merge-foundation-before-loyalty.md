# ADR 0006: Merge foundation before Loyalty

- Date: 2026-08-16
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The approved Customer Loyalty architecture in ADRs 0003 through 0005 depends on
the Weletic global affiliate and Shopify commerce foundation currently contained
in draft pull request #1. That pull request spans 71 commits and has not yet
landed on `main`. Its current CI state is unstable because the Prettier and
Playwright jobs are failing.

Starting the five planned Loyalty pull requests before the foundation lands
would either mix new Loyalty scope into an already large pull request or create
a stack whose base is not yet stable. Both approaches would make review,
verification, rollback, and later ownership of the Loyalty bounded context less
clear.

## Decision

We will stabilize and merge the existing global affiliate platform foundation
before implementing Customer Loyalty. Pull request #1 will first receive only
the fixes required to make its existing scope pass local verification and CI,
plus any documentation already approved for that foundation.

Because pull request #1 predates the current release workflow and is a large,
multi-domain change, Codex will perform an adversarial scope and correctness
self-review before pushing the stabilization work. The pull request will not be
merged automatically: after CI is green and GitHub reports it mergeable, Hiro
must give explicit per-merge approval.

After the merge, Codex will synchronize local `main`, remove the merged feature
branch where safe, and create the five approved Loyalty pull requests from the
updated `main`. Loyalty implementation must continue to follow ADRs 0003 through 0005.

## Alternatives considered

- **Add Loyalty to pull request #1** — Rejected because it would expand an
  already large foundation change, blur the Affiliate/Loyalty boundary, and
  increase regression and rollback risk.
- **Start stacked Loyalty pull requests before pull request #1 merges** —
  Rejected because every pull request would depend on an unstable base and would
  require rebasing or replacement if the parent branch changes or is deleted.
- **Abandon pull request #1 and rebuild the foundation as smaller pull
  requests** — Rejected for now because it would duplicate substantial completed
  work without evidence that the branch is unsalvageable.

## Consequences

### Positive

- Loyalty begins from a tested, merged, and reproducible foundation.
- The five Loyalty pull requests can remain narrowly scoped and independently
  reviewable.
- CI failures and latent foundation defects are resolved before new reward
  liability is introduced.
- The final merge boundary and commit history clearly separate foundation work
  from Customer Loyalty work.

### Negative / trade-offs accepted

- Loyalty implementation starts later while pull request #1 is stabilized.
- The large foundation branch requires a more expensive self-review and local
  verification pass.
- Hiro must provide an additional explicit merge approval after CI becomes
  green.
- If stabilization reveals a new architectural or migration decision, work must
  pause for a focused decision before the foundation can merge.

### Follow-ups

- Inspect the failed Prettier and Playwright jobs and propose a focused repair
  plan based on their logs.
- Apply only approved in-scope fixes and run formatting, type-checking, linting,
  unit tests, E2E tests, and builds as applicable.
- Re-read `git diff main...HEAD` for dead code, secrets, unfinished paths,
  unintended deletions, migration risk, and scope drift.
- Push the verified branch and wait for all GitHub checks to succeed.
- Request Hiro's explicit approval to squash-merge pull request #1.
- After merge, synchronize `main`, clean up the merged branch, and start the
  approved five-PR Loyalty implementation sequence.

## References

- Hiro approval of Option A, stabilize and merge the foundation first, in the
  Weletic Room architecture discussion on 2026-08-16.
- https://github.com/satoshicancode/weletic-room/pull/1
- `docs/adr/0003-customer-loyalty-bounded-context.md`
- `docs/adr/0004-loyalty-activation-and-balance-policies.md`
- `docs/adr/0005-historical-points-as-opening-balance.md`
- `/Users/hironguyen/.codex/memories/project_adr_0006.md`
