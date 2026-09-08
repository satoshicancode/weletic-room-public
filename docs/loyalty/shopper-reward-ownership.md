# Shopper-owned reward fulfillment — package 3 working checkpoint

This work implements the approved unified plan, not a second coupon catalog or
points ledger. **Package 3 remains incomplete. Direct issuance is not enabled.**

## Why the ownership expansion is necessary

`WeleticRewardRedemption` originally required a loyalty account. Generic exchange
provisioning also requires a positive points debit, and cancellation/compensation
restores that debit. A reviews-only shopper must not be enrolled or credited and
debited artificial points merely to receive the promised review coupon.

The expand stage retains the same reward-definition catalog and fulfillment
table. It makes `accountId` nullable and adds optional `shopperId`,
`fulfillmentSource`, and `fulfillmentReference`. Historical rows are not rewritten
or reclassified; their original account ownership and metadata remain intact.
The source/reference unique index is scoped by store. The nullable historical
source fields do not synthesize duplicate financial identities for old rows.

The prospective direct source is `review_incentive_v1`. Its read contract requires
an explicit store-scoped shopper, null account, zero points spent, no ledger entry,
a source reference, and a discount-code artifact. Unknown or malformed direct
records are excluded from the merchant wallet, but privacy exports retain all
records associated with the unambiguous owner for investigation and erasure.
Account-backed rows belong to the account owner; the direct shopper branch
requires a null account. Contradictory shopper/account fields must not expose one
record to two shoppers. The canonical `rewardFulfillments` export is available
without an account; the nested account field remains a compatibility alias and
must not be summed with it.

## Implemented locally in the working branch

- Expanded Prisma ownership and checked-in SQL, with an isolated-only staging
  command. Shared database rollout is not performed by that command.
- Runtime guards before legacy account-based points cancellation, compensation,
  referral recovery, order settlement, and discount-deletion processing.
- Legacy recovery filters before its bounded page, so future direct reservations
  cannot starve account-backed recovery.
- One shopper-profile reward projection for legacy and valid direct records;
  reviews-only shoppers need no account. Points history still requires an account.
- Both privacy export paths discover shopper-owned as well as legacy rewards.
- Append-only review incentive policy revisions, with allocation separate from
  activation. Coupon promises copy the existing store's catalog terms and verified
  shop currency; later catalog edits do not change the saved promise.
- A durable unique order-wide review claim, reservable through the real store-
  locked transaction only after purchase revalidation and durable participation
  evidence bound to submitted content/media. Rating and publication are not
  eligibility inputs. Points remain reservation-only; coupon reservations now
  create one zero-point shared fulfillment and one ID-only outbox job in the
  same transaction.
- New invitations inherit the order's first invitation policy, including the
  legacy null policy. Mixed legacy/new orders fail closed; historical awards,
  including reversed awards, cannot be followed by a new-policy second claim.
- New-policy reviews cannot enter the legacy publication award or hiding/rejection
  clawback paths. Existing claims are returned, never recreated or revived.

- Generation-fenced direct coupon worker using the existing Shopify provisioning,
  recipient binding, immutable terms, exact remote configuration and ownership
  verification helpers. Version-two ownership is shopper/source/claim scoped;
  historical version-one fingerprints are byte-for-byte unchanged.
- Durable prepare markers commit before provider calls. Recovery adopts only the
  same verified remote coupon; an ambiguous create never generates a replacement.
  Known pre-dispatch failures clear only the winning worker's marker. A retry
  must still observe the exact marker it prepared against before reconciliation.

The internal reservation service and production outbox dispatcher now support
this path, but no endpoint or review-submission caller enables it. There is no
trusted participation validator or public policy activation writer. Tests use
real MySQL transactions and controlled Shopify transport responses, not real
coupon issuance. Legacy runtime assertions remain containment for event paths
that do not yet support direct fulfillment.

## Required continuation before direct issuance

1. Finish the trusted purchase/abuse validator and connect the new claim to actual
   award fulfillment in one transaction. No production validator, public policy
   activation writer, or caller of the new reservation service exists yet. Add
   store-experience review integration and coupon media-bonus policies. The point
   selector retains the existing max(photo, video) bonus and caps one exact total;
   video participation remains false until validated video processing exists.
2. Complete direct order-use, discount-deletion, expiry and recovery lifecycle
   dispatch. Current legacy assertions would reject a direct record; these event
   paths must work before submission integration is enabled. Amount-off,
   percentage-off and free-shipping coupons have provisioning support; free-product
   policy drafts remain rejected until exact remote verification is supported.
3. Prove the complete coupon lifecycle and operational failure handling through
   production outbox services, including stale leases, bounded retries, terminal
   reconciliation and module pause/reinstall. Do not equate one successful
   dispatch with complete operational coverage.
4. Finish shopper-scoped erasure, metadata scrubbing, and voucher cleanup. Include
   the new claim, participation evidence, and immutable policy references in
   privacy export/retention and frozen-shop purge. A direct
   record must not be lost because the shopper lacks an account. Preserve remote
   ownership evidence and ambiguous provision attempts until cleanup resolves.
5. Implement fraud invalidation, unused-coupon deactivation and explicit used/late
   coupon unrecoverable cost. Never manufacture customer debt or a points refund.
6. Add production-service MySQL claim/provision/recovery/settlement races, complete
   financial/privacy regression coverage, UI/API compatibility checks, full CI and
   independent review. Reservation concurrency is not proof of a delivered award.

The remaining acquisition/referral/affiliate decision work and all other approved
packages retain their original scope. No live Shopify, inbox, checkout, or full
Smile/Judge.me parity is claimed by this checkpoint.

## Local staging and evidence

`node infra/shopify-development/stage-shopper-reward-ownership.mjs
--confirm-isolated-expand-schema --credentials-root <isolated-credentials-root>`
checks private credential permissions, exact loopback MySQL identity, Docker
ownership, the complete expected schema diff, and the post-stage diff. MySQL DDL
is not transactional: partial failures stop for inspection, never a table rebuild
or destructive rollback. Preserve expanded columns on application rollback.

The original commands record the incremental development stages below. For a
verified isolated database still at the merged-main schema, use
`--confirm-isolated-complete-expansion` with the same credentials-root argument.
This compares the complete pending statement set against all three reviewed SQL
files and executes in their explicit phase order. Only operation ordering may
differ; missing, duplicate, extra or altered statements are rejected. A partially
applied schema requires inspection, not automatic inference of a recovery plan.
All commands retain the exact loopback/Docker/principal checks and reject shared
environments. A complete-mode no-op is not evidence of a fresh baseline rehearsal.

The ownership-only stage passed without changing historical business fields. Sixteen isolated
MySQL profile/segment tests passed, including the real production profile query
for a reviews-only direct reward and a concurrent source-uniqueness constraint
test. These tests use synthetic records, block external fetch, and clean up their
fixture stores. They do not issue remote coupons or execute a review incentive.

The earlier ownership-focused run passed 265 tests across twelve files, including a new test
of the production cancellation entry point rejecting a direct reward before any
transaction or provider call. Three retained catalog simulator assertions in that
total are not counted as production-service evidence. Sixteen isolated MySQL tests
passed after supplying the export fixture's required reward-definition parent;
the earlier missing-parent fixture failure is not relabeled as an application
failure. The second schema stage was a no-op. Web type-check and root lint (ten
tasks) passed. Independent review cleared the gated expansion after the export
ownership fix; the same-store contradictory-ownership database regression passes.
The subsequent claim expansion was applied only to the same verified local MySQL
instance using `--confirm-isolated-review-claims`; this phase requires the earlier
ownership expansion to exist. The complete pre-stage SQL exactly matched
`20260907_review_incentive_claims.sql`, the post-stage diff was empty, and counts
of existing review/settings/request and redemption rows were unchanged. Repeating
the stage was a no-op. `--inspect-isolated-review-claims` is read-only and prints
only the schema diff after validating the isolated environment identity.

Twenty-six isolated MySQL tests pass, including ten new production transaction
cases: competing claims, inactive/concurrent policy revisions, coupon promise
immutability, low-rating hidden review eligibility, missing validation, changed
content, full-refund status, stale installation/cross-store rejection, mixed
legacy-order exclusion, later invitation inheritance, and invalidated claim
replay. Several cases share a test. Durable validation records are synthetic
fixtures, not live anti-abuse evidence. The test transport blocks external fetch;
only the controlled invitation test enqueues an email job, never sends it.

The focused current run passes 144 tests across eight files; policy tests also
pass independent review. The reviewer caught and verified fixes for malformed
BigInt validation and mixed-policy legacy order overlap. Web type-check, Prisma
validation/generation, and root lint pass. The first full-suite run found an
over-broad account-relation guard in legacy recovery; it was narrowed to branches
that dereference the relation while keeping the direct-source guard unconditional.
The outbox/performance-focused rerun passes all 77 tests (as does clean main).
That claim-foundation full unit run passed all 289 files: 4,368 tests passed and six existing
tests skipped. This total still includes retained simulators; it is not live
acceptance evidence.

### Coupon reservation and provisioning continuation

The append-only outbox enum expansion was staged only in the verified isolated
database with `--confirm-isolated-shopper-coupon-outbox`. The full schema diff
matched `20260907_shopper_coupon_outbox.sql`, the post-stage diff was empty, and
existing redemption/outbox counts were unchanged. The enum label is appended,
preserving historical MySQL ordinals. The bootstrap Flow SQL retains the same
complete enum; existing installations use the dated expansion, not a downgrade.

The current isolated MySQL suite passes **36 tests**, including same-transaction
claim/coupon/job reservation and rollback, competing workers with the Redis mutex
removed, real outbox lease/dispatch completion, lost create-response adoption,
ambiguous lookup misses, stale installations, invalid claims, foreign/configuration-
drift rejection, and pre-dispatch failure recovery. The deterministic retry race
pauses workers after real transaction commits and verifies that clearing another
worker's observed marker cannot permit an unprepared create. Coupon tests create
neither loyalty accounts nor points ledger entries. The trusted participation
evidence and provider responses remain controlled fixtures.

Independent review verified the retry-marker fix, legacy ownership compatibility
and enum ordering, with no remaining findings in that bounded review. The complete
staging planner also passed independent review and 11 tests. A read-only Prisma
comparison from merged-main's datamodel matched all 11 reviewed SQL statements;
complete mode against the already expanded isolated database was a no-op. This
does not claim a second fresh-database application.

Final local verification for this continuation:

- Full unit suite: **4,383 passed, six existing skips, 291 files**.
- Isolated MySQL suite: **36 passed**, with real production transactions and
  controlled transport; no Shopify API calls or real email delivery.
- Web and Shopify type-checks, root lint (10 tasks), repository formatting,
  focused staging-script formatting, and Prisma validation passed.
- Web production **compile mode** and the Shopify application build passed.
  Web page generation and the full browser/API release suite remain CI gates.
- Nine CLI validators passed in explicitly simulated/mock mode: checkout/refund,
  theme proxy, expiry, referrals, VIP, earning actions, Flow/ESP, stored-value and
  bonus campaigns. The first standalone referral run lacked its test HMAC key;
  rerunning with synthetic configuration passed. Analytics/backfill live-data
  validators and live lifecycle validators were not run against shared stores.

CI and explicit schema-merge approval remain outstanding. Remaining privacy,
fraud, settlement and activation requirements above are still open.

Do not deploy or enable direct issuance from this working checkpoint.
Shared-schema approval is required before merge/rollout.
