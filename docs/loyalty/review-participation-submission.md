# Review participation submission — integration in progress

Date: 2026-09-08. Current base: `95fd5e105b` (PR #82).

This package-3 increment recovers the participation-only changes from preserved
local commit `088c38c593`. Its acquisition-schema ancestors are not included.
The preserved branch remains untouched. No schema migration, policy activation,
store deployment, external send or historical repair is part of this increment.

## Implementation and contracts

- Connect policy-tagged purchase invitations to trusted server-derived
  participation evidence and the existing order-wide incentive claim service.
  Token consumption, review/media writes, claim reservation and points/coupon
  outbox writes share the existing store-fenced transaction.
- Retain strict null-only legacy policy semantics. Malformed non-null promises
  fail closed; they never fall back to publication-based legacy awards.
- Validate purchase ownership, installation generation, cancellation, bounded
  submission content, owned uploaded photos and identity-only privacy suppression.
  This is bounded purchase/invitation validation, not comprehensive spam or fraud
  detection. Rating and publication do not determine participation eligibility.
- Apply identity-only privacy suppression at the shared invitation reader for
  legacy and prospective policies alike, before preview, submission or upload
  preflight. Historical reward semantics do not exempt new writes from privacy.
- Honor already-validated points promises after ordinary refunds. Confirmed
  invalidation and privacy suppression remain separate blocking decisions.
- Support owned points retries without publishing pending or hidden criticism.
  Coupon retries remain exclusively in the existing fulfillment worker.
- Expose additive workspace reward-policy/retry fields. Enrichment uses the
  supplied database transaction; the strict Shopify staff projection still omits
  private ownership/policy details and these workspace-only fields.

Touched boundaries: reviews services/admin, shopper coupon worker, workspace
review component and production-service/component/database tests. No migration
or new public endpoint. Policy configuration and activation remain unfinished.

## Verification and release gates

Focused service/policy/component/Shopify tests passed 43 cases after building
local workspace packages. The additional transaction-bound staff projection test
passed in the expanded 19-case staff suite. Independent read-only review found no concrete
blocker; root remains responsible for final whole-diff verification.

All 141 current isolated-MySQL cases passed. The ported cases cover actual low-rating submission, single order
awards across competing reviews, token replay, photo fixture bonuses, pre-commit
rollback, corrupted promises, delayed enrollment/refund, privacy and retry
ownership. Web types (8 GB heap), repository-wide formatting/lint and local
workspace package builds also passed. The full web unit suite passed 4,949 tests
across 320 files, with six existing skips. The compile-mode web build passed,
with existing CSS/browser-data/revalidate warnings. These full-run results used
the original PR #81 base before the final shared-reader privacy correction.
They are not evidence for combined-head page generation or live acceptance.

Final review found that legacy invitations bypassed identity-only suppression.
Two new real-MySQL cases first reproduced the failure, then passed after moving
the check into the shared reader. They cover ID/email suppression for preview,
submission and upload preflight, with unchanged tokens and no review/media writes.
The branch then fast-forwarded onto PR #82 without conflicts. All 143 combined
database cases passed. The strengthened full-invitation preservation assertions
also passed in both ID/email cases. The combined compile-mode build exited zero.
Combined web types passed, and the full unit suite passed 5,191 tests across 335
files with six existing skips. Exact-head CI is still required.
Shopify types, its 18 unit tests and Prisma validation passed. Seven existing
expiry/referral/VIP/earning/Flow/financial-reward/campaign validators passed only
in mock/static mode. Historical backfill deliberately rejects its removed mock
mode; neither that refusal nor these simulated validators establish the live
backfill or analytics release gates. Those still require persisted audit evidence.

Database tests may use only guarded loopback development fixtures. They prove
service/transaction behavior, not real inbox, media-upload or Shopify acceptance.
Both `yamaxdev` activation and `n0pvef-cs` benchmark configuration remain unchanged.
The unified product is not complete; live acceptance and remaining package gates
must be tracked separately.

## Audited moderation integration

The local integration also incorporates PR #78's supplied-transaction moderation
primitive. Participation ownership, strict null-only legacy behavior and retry
semantics remain inside that primitive, so workspace and audited callers share
the same reward decision. Independent read-only review found no blocker.

The combined unit suite passed 5,239 tests across 339 files with six existing
skips; all 144 isolated shopper MySQL cases and repository lint passed. The added
audit case proves unchanged account, ledger and claim rows when a controlled
participation review is hidden, complete rollback after audit creation, and
stale-version rejection without mutation. It uses a controlled workspace actor,
not a live Shopify staff session. This integration does not activate either
policy configuration or the audited gateway. Exact-head CI remains required.

Combined web/Shopify types, 21 Shopify route tests, Prisma validation, complete
repository formatting and guarded compile-mode web build/tracing also passed.
All seven previously listed mock/static validators passed again on the combined
tree. The strengthened pending-to-hidden audit test additionally confirms that
no summary or reward job is added for unpublished content. No live evidence is
implied by those results.

## Deferred reviews follow-up

Hiro's 2026-09-08 priority decision is to finish this integration and PR #78,
then focus implementation on loyalty. The reviews work below is deferred, not
removed from the approved product plan. No prospective activation is authorized
by this integration.

Current `requests.ts` already snapshots the active policy when an order receives
its first invitation and preserves that policy for later product groups. The
missing piece is an authenticated policy configuration/activation writer, not a
second invitation scheduler. Activation must require complete promise disclosure
and leave historical invitations unchanged.
Turning prospective incentives off must publish a versioned `none` policy rather
than clear the policy pointer and accidentally restore the legacy reward writer.

`loyalty/shopper.ts` creates accounts only for an active program, but does not
resume review points reserved before enrollment. Recovery must use the existing
claim/ledger transaction and durable outbox, with bounded progress and replay
protection. It must handle program pause/resume, installation replacement,
identity suppression and confirmed invalidity without blocking identity ingestion
on one damaged claim. No coupon path may manufacture an account or points entry.
Implement and test these remaining behaviors before enabling prospective policies.
