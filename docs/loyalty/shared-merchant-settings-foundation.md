# Shared merchant settings foundation

Status: locally implemented and under verification on 2026-09-06. Not deployed,
not accepted on `yamaxdev`, and not completion of package 2 or the unified plan.

## Contract and compatibility

- One optional `WeleticMerchantSettings` row per canonical store, separate from
  loyalty enrollment. GET has no initialization side effects. Missing rows keep
  legacy branding and the existing producers' delivery eligibility.
- Branding contains an optional name, public HTTPS logo URL and six-digit accent
  color. Review invitations, friend referral coupons and points-expiry emails
  consume these fields. No server-side logo fetching is added.
- `WeleticShopifyStore.defaultLocale` remains the single stored default locale.
  Saving a default language does not translate existing email templates.
- The IANA timezone is **stored only**; it does not yet alter delivery timing,
  date displays, quiet hours, birthday, campaign or expiry policies. All three UI
  locales disclose this limitation. No timezone is inferred from currency.
- GET/PATCH `/api/weletic/merchant-settings` uses workspace authorization and
  private, no-store responses. PATCH is owner-only and bounded to 16 KiB; it
  requires the expected settings revision and installation generation.
- Settings writes serialize through the active-store transaction fence, reject
  stale revisions/reinstalls and do not create or activate a loyalty program.
- Independent module buttons reuse existing loyalty/review writers. Additive
  stale status/generation or review-updatedAt checks protect these new controls;
  existing callers retain their transition contract. Review toggles preserve the
  saved collection policy. Disabling reviews cancels outstanding invitations,
  but retains submitted reviews. Enabling does not send historical invitations.
- The legacy review incentive policy has not been cut over to participation-based
  points-or-coupon awards. The UI explicitly warns that enabling is not acceptance
  of that future policy.

## Email pause semantics

`shopperEmailPaused` stops new review-invitation, referral-coupon and expiry-notice
delivery claims; it neither grants consent nor enables a producer. Resuming must
still pass the original producer's checks. Messages already in flight can finish.

The queue excludes paused review-request and expiry-notification candidates before
its bounded page is selected. Financial expiry and other non-email work remain
eligible. A producer pause detected after polling restores only the exact winning
claim, preserving the previous attempt count and error state. A stale worker cannot
overwrite a replacement worker's claim. The referral email SQL claim independently
checks the pause flag in the same conditional UPDATE as the lease acquisition.

This is a merchant pause, not a per-shopper suppression/consent system. Shared
consent evidence, complaints, quiet hours, reminder journeys and provider delivery
history remain later work. No provider send or transport fallback is activated by
these changes.

## Additive schema and release order

The checked-in SQL at
`infra/shopify-development/migrations/20260906_merchant_settings.sql` creates only
`WeleticMerchantSettings`. There are no existing-table rewrites, data backfills,
default module activations, drops or destructive rollback instructions.

`stage-merchant-settings.mjs` is deliberately limited to the isolated Docker MySQL
database at `127.0.0.1:3307/weletic_loyalty_dev`. It verifies private no-follow
credential reads, absence of retained environment files, database principal,
container ownership and an exact single-table Prisma diff. It then verifies an
empty post-stage diff. It cannot be used as a shared-environment deployment tool.

On 2026-09-06 the isolated table was staged successfully; existing tables changed:
0; merchant configuration rows written by staging: 0. Test fixtures are random,
store-scoped and removed after the database suite.

Before shared-environment release: validate the same additive expansion against
that environment, obtain its explicit schema/merge confirmation, apply the table
before switching application code, then verify readers/writers and email pause.
Keep the table on application rollback. Do not deploy table-dependent code first.
Missing-table errors fail closed; they are not treated as missing settings rows.

Final shop redaction deletes the merchant configuration under the store fence,
including repeat redaction. Customer erasure does not delete merchant-only branding.

## Current evidence and remaining gates

- 33 contract tests and 11 HTTP/React component tests passed locally, including
  malformed-logo rejection without an uncaught URL parser error.
- 13 isolated-MySQL tests passed, including revision races, workspace/owner and
  installation fences, module policy preservation, actual queue candidate SQL
  for absent/unpaused/paused settings, resume, and competing referral leases.
- The two pause-after-claim tests deliberately inject the producer's pause error
  into the query boundary; claim acquisition/restoration and stale-worker checks
  use real MySQL. They are not remote-lock or provider-send proof.
- Queue fixtures use absent recipients/accounts and an empty summary projection;
  these prove selection/lease behavior, not financial expiry or inbox delivery.
- The referral concurrency case uses a controlled delivery callback, not Resend
  or SMTP. Existing provider-specific acceptance remains a separate gate.
- Three-language component tests cover change-only writes, persistent save
  confirmation, owner controls, independent module actions and tenant switching.
  No authenticated browser, Shopify embedded UI or live storefront proof yet.
- Final web type-check passed with an 8 GiB Node heap after the default-heap run
  exhausted memory. Root lint passed all 10 tasks; Shopify types/build, Prisma
  validation and the web production build (362 generated pages) passed locally.
- A serial full-suite run passed 4,316 tests, skipped six, and failed one newly
  added privacy assertion placed in the wrong lifecycle phase. The assertion was
  moved to final redaction and all 59 privacy-worker tests passed on rerun. The
  focused regression run passed 169 tests. A fresh green full CI run remains a
  release gate; the earlier failing run is not relabeled as green.
- Repository formatting and independent source review passed; fresh CI remains
  required before release. No live store
  changes, external email, extension publication, shared database update or
  module activation occurred here.

The existing shipped foundations remain PR #64 (shopper directory/profile,
`a8bbf0e9fa112ca66527eec4c1ecc7a1b0ca17dd`) and PR #65 (module lifecycle,
`8b3f711a2a9135e72e465e59112ba8c3630aca14`). Post-merge Fast Quality Gate for
PR #65 passed in run `34035246844`. These are code/local evidence, not blanket
Smile/Judge.me parity or live acceptance.
