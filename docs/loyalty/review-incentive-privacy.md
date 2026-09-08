# Review incentive privacy — merged gated foundation

This continues the approved unified plan after the gated shopper-owned coupon
foundation in PR #68. It is not activation or complete privacy acceptance.

## Implemented in PR #69

- Both shopper export paths include participation evidence, invitation promises,
  and order-wide incentive claims. Claim pages retain owned rows with damaged
  policy references, resolving promises separately within the same store and
  returning `policy: null` with a reason when unavailable. Exports exclude
  invitation bearer/lease fields and never join another shopper's claims.
- Review redaction clears content-linked validation evidence and sets claims to
  `privacy_redacted`, retaining their order identity and award snapshot. Privacy
  is not fraud: it does not append a points reversal or permit another claim.
- The same store-locked transaction cancels pending, processing and failed direct
  coupon provision jobs for selected claims. Provision workers revalidate the
  retained claim, so a delayed invocation cannot issue a redacted award.
- Claims without surviving invitations are still processed in bounded pages.
  Review participation fields are scrubbed even on previously redacted reviews.
- Frozen-shop purge drains claims and then policy revisions in bounded pages,
  after invitation/media prerequisites. Coupon claim evidence remains until
  voucher cleanup has a verified outcome and its local redemption is terminal.
  These checks do not themselves perform remote deactivation.
- The shared voucher cleanup accepts an additive shopper-only ID payload while
  retaining legacy account jobs. Its versioned ownership snapshot binds store,
  shopper, claim, coupon and installation generation. Enumeration captures fresh
  attempted-create evidence and quarantines the coupon under the same store lock
  used by provisioning, then cancels pending provision jobs atomically.
- Cleanup rechecks generation, immutable ownership, quarantine and its winning
  lease before provider I/O and local finalization. Credential resolution occurs
  outside the store lock because its integration binding takes that lock itself.
  Unused coupons are cancelled; used benefits remain used without points debt.
  The existing uninstall/shop-erasure usage grace also applies to direct coupons.
- Durable customer erasure enumerates shopper-only coupons and links them to its
  existing request completion gate. Compatibility erasure first installs HMAC
  tombstones under the store lock, drains reviews/coupons, then scrubs identity.

## Evidence and limitations

The expanded privacy/cleanup revision passed 4,385 unit tests with six existing
skips across 291 files. Do not reuse the foundation's CI results for this branch.
The 61-case isolated MySQL run passed, including production exports,
redaction, cross-store exclusion, malformed policy references, replay, bounded
policy purge, unresolved-versus-completed cleanup gates, and resumable orphaned-
claim redaction across the page boundary. Controlled
cleanup fixtures prove the purge gate, not real Shopify cleanup. Added production
cleanup cases cover source-specific usage grace, late usage, immutable-owner
damage, same-generation real integration credential binding, prepare/cleanup
barriers, stale lease takeover, generation changes between lookup/deactivation,
accountless erasure, request links and shared-dispatcher replay. Provider lookup,
create and deactivation responses are controlled; external fetch is forbidden.

Web and Shopify type-checks, root lint (10 tasks), formatting, Prisma validation,
web production compile-mode build and Shopify build passed. Web type-check used
the CI-standard 8 GB heap after exhausting Node's default heap. Nine mock/static
CLI validators passed; no live validator was run. On head `0cba56e618`, the
automatic and explicit all-area fast gates passed, including Shopify checks in
the all-area run. Full Release Gate 34053847934 passed compilation, page generation
and all 148 Playwright tests. These CI checks are not live-store acceptance.
Independent source review verified the export fix, preserved financial markers,
bounded operations and cleanup prerequisites with no remaining concrete findings.
No shared database, live store, real coupon, email or private object was changed.

## Still required before privacy/activation acceptance

1. Prove the complete export/redaction/purge journey, including private media and all
   newly introduced records, before enabling incentives. Trusted participation,
   policy activation and the other package-3 lifecycle gates remain open.
2. Finish direct-coupon order-use, refund/fraud and terminal recovery workflows,
   including explicit unrecoverable-cost accounting. The cleanup audit preserves
   a used benefit, but is not itself the unified incentive-cost report.
3. Rehearse full durable erasure/retention and credential removal on the acceptance
   runtime, including repeated lifecycle events and operator reconciliation for
   unverifiable or earlier-installation coupons. Local controlled responses are
   not live Shopify evidence.

PR #68 merged as `e09d76c892`; this continuation merged in PR #69 as `c5e45a34b0`.
It has no additional schema change. Shared database rollout and live activation
retain their explicit gates.
