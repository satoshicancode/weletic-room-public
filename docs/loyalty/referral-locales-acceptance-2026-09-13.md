# Referral claim and sharing locale acceptance — September 13, 2026

This is local L06/L09 presentation evidence, not live referral acceptance.
The existing claim protocol, eligibility decisions, Shopify issuance and delivery
producers are unchanged. Merchant-authored benefit names remain escaped text and
are not automatically translated.

## Implementation and automated evidence

- EN/JA/VI copy for points invitations, coupon form/label/submission state,
  claimed result, eligibility review, email-delivery status and fallback failure.
- Twenty-seven new synthetic-transport tests cover the three locales, points-only
  invitations without a coupon POST, merchant-name escaping, claimed/review
  results, missing-message HTTP failure and both `emailSent` values, plus guest
  sharing instructions, member benefit/copy feedback and missing-link states.
- Sharing-tab interface strings are translated, including membership guidance;
  merchant benefit names remain escaped before interpolation. The membership
  branch was not separately proven reachable by these tests.
- New tests plus existing widget-core/theme-asset suites: 85 passed on public
  main `845789d674` with the locale patch. This does
  not imply the full repository suite, CI or live browser acceptance passed.
- Shopify package typecheck/build, focused test lint, JavaScript syntax and
  changed-file formatting passed. Adversarial review found no code blocker;
  additional email-state assertions address its coverage feedback.

## Browser evidence

Real Chrome at 375 × 812 with actual shared/widget/CSS assets, static fixture HTML
and a local synthetic HTTP claim responder. No real discount, email, customer or
store configuration was created or modified.

- Japanese: localized form; entered a synthetic email, Tab/Enter submission;
  claimed result displays the synthetic code, localized apply/copy actions and
  email-unavailable instruction. Document width 375px; drawer width 343px.
- Vietnamese: localized form and keyboard submission; synthetic review response
  displays the localized no-coupon-issued explanation, without a code. The
  screenshot was visually inspected at 375px.
- English: points invitation explains the 100 Coins benefit and provides account
  links without a coupon-claim form; document width remains 375px.
- Japanese sharing follow-up: long synthetic referral link wraps at 375px
  without document overflow; no private account sentinel appears in the DOM.
  Tab/Enter activates copy and shows Japanese success feedback. Screenshot
  visually inspected with the newly merged shared/landing assets present.
- Vietnamese sharing follow-up: missing-link state shows translated guidance
  and no copy action; screenshot visually inspected at 375 × 812.
- Automated locale cases are not substitutes for browser interaction or live
  Shopify proof. This is a selected state matrix, not all states in every locale.

## Remaining scope

Live App Proxy authentication, invitation attribution, new-customer/abuse checks,
concurrency/retry behavior, remote issuance, email delivery, qualification,
clawback and independent SQL remain under L06/L10 and the acceptance matrix.
Server-provided error messages remain unchanged and may be English; this patch
localizes only the existing fallback when no message is supplied. Every browser
state/locale and complete accessibility acceptance remain separate tasks.
The first web typecheck failed because the new worktree lacked its generated
Prisma client; generation was corrected and the web typecheck rerun passed.
Full repository lint also passed. The full unit suite passed: 498 files,
8,056 tests passed and 6 skipped (762.72 seconds). The complete web build remains
pending at this checkpoint. No launch checkbox is closed by this patch.
