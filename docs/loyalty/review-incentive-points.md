# Review incentive points — gated fulfillment

This package-3 increment fulfills an immutable product-review points promise
through the existing loyalty ledger. It introduces no schema, public route,
trusted-validation writer, enrollment, or activation change.

## Contract

- Reservation and immediate fulfillment share the store/program transaction.
  A shopper without an active loyalty account retains the reserved claim; the
  service never enrolls a reviews-only shopper or substitutes a coupon.
- The internal retry entry point rechecks the installation, owned review and
  purchase, validated content/media evidence, pinned policy and exact award.
  Current policy edits cannot change the promise. A changed or redacted review,
  damaged financial marker, legacy order invitation, or conflicting coupon
  fails closed.
- One `EARN_BONUS` entry uses `REVIEW_INCENTIVE` and the claim ID. The order-wide
  claim, review marker, balance, Flow event and tier-review job commit together.
  The Flow payload carries Shopify's external order ID, not the database ID.
- Integer strings remain exact through BigInt arithmetic. The configured photo
  bonus forms part of the single award; video is not yet eligible.
- Rating and publication are not participation criteria. A legitimate fulfilled
  claim remains fulfilled after a refund or hidden moderation state; an unpaid
  claim must still have an eligible purchase. Privacy is not fraud. Confirmed
  fraud reversal is a separate, still-required lifecycle service.

## Local evidence

The isolated MySQL suite passes 71 cases, including ten points-specific cases:
competing first claims, retry after enrollment with an unchanged promise,
low-rating/hidden/refunded replay, a single photo bonus, refunded unpaid claims,
damaged ledger markers, points above JavaScript's safe-integer range, rollback
after fulfillment, evidence/generation/privacy rejection, and coupon exclusion.
Tests invoke production services and Prisma transaction boundaries. Purchase and
trusted participation evidence are fixture-seeded. No real store, points balance,
email, provider coupon or shared database was changed.

The full unit suite passed 4,385 tests with six existing skips across 291 files.
Web/Shopify type-checks, root lint (10 tasks), formatting, Prisma validation,
web production compile-mode build, Shopify build and nine mock/static CLI
validators passed. Independent source review identified and verified the Flow
order-ID fix; the final 71-case database run passed after that fix. Full page
generation and browser/API release CI subsequently passed on `27edb3c01a`:
automatic/all-area fast gates and Full Release Gate 34055066816 succeeded, with
148 Playwright tests. PR #70 merged as `3a78127faa`; activation remains gated.

## Remaining gates

This is not customer-facing incentive acceptance. Trusted participation validation,
prospective policy activation, store-review integration, fraud reversal, coupon
settlement/recovery/cost reporting, complete privacy acceptance and controlled
`yamaxdev` end-to-end proof remain open. The legacy publication-based reward path
must not be enabled as the new participation policy. Shared schema rollout and
live activation remain separately gated.
