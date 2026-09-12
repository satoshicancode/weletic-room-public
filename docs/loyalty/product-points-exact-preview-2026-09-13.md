# Product points price decoding — September 13, 2026

## Defects and scope

The previous controller divided theme prices by the ISO currency fraction scale.
For JPY/KRW that scale was one, overestimating points by 100×. Shopify's
[Liquid variant price documentation](https://shopify.dev/docs/api/liquid/objects/variant#variant-price)
specifies appended hundredths for currencies without subunits: a ¥1,000 variant
is represented as `100000`. This representation must not be confused with the
ledger's ISO minor-unit amounts.

The Liquid first paint also calculated a fictional one-point-per-unit estimate
before the public program response arrived. It now starts unavailable (`—`).
Merchant prefix/suffix text is escaped in both markup and attributes.

The controller applies the existing base rate using bounded integer parsing,
four-decimal scaled rates and BigInt floor division. It retains exact integer
values above Number's safe range, honors locale formatting, accepts zero-price
variant events and refuses malformed/lossy inputs or failed HTTP responses.
No ledger, gateway, database, reward policy or customer identifier changes.

## Evidence and remaining work

- 29 new tests plus 38 existing theme-asset tests passed (67 total),
  including the floating-point boundary `100 × 0.57 = 57`.
- Coverage includes JPY/KRW/USD, fractional rates, large exact prices, EN/JA/VI
  number formatting, zero-price changes, invalid values, inactive programs,
  failed HTTP and static Liquid first-paint/escaping assertions.
- Independent adversarial review found no blocker in this scoped correction.
- Web types, full repository lint, Shopify typecheck/build, JavaScript syntax,
  formatting and Prisma validation passed. No schema was applied.
- The first full unit run failed in an unchanged cache benchmark at 50.73ms
  against its 50ms limit (731 tests passed before fail-fast). It measures 1,000
  assertions on an in-memory object, not the product controller. The threshold
  remains unchanged. After the build completed, the isolated benchmark passed
  (1 passed, 63 unrelated cases skipped; test duration 25ms). This does not prove
  a root cause for the prior threshold miss.
- The subsequent full run passed 6,232 tests before failing the public-extension
  staging test: its exact source anchor still expected the removed fictional
  Liquid estimate. The staging anchor now verifies the shared unavailable
  placeholder without rewriting it. Regression checks reject a changed estimate
  or duplicated source.
  The two affected suites pass all 34 tests; focused ESLint, syntax and diff checks
  pass. Independent follow-up review found no blocker in the staging correction.
- The complete rerun after that correction passed: 500 files, 8,095 tests passed
  and 6 skipped (658.24 seconds). No benchmark or acceptance assertion was relaxed.
  The branch then fast-forwarded over documentation-only PR #38; runtime code
  remained unchanged. Public CI remains pending at publication.
- Chrome at 375 × 812, actual controller/CSS and synthetic HTTP/static HTML:
  the ¥1,000 fixture at 2.5 points/yen shows 2,500 with no horizontal overflow.
  Native select-option changes show zero for the free sample and 3,750 for the
  ¥1,500 variant. The initial screenshot was visually inspected. Keyboard-only
  selection is not certified by this check; attempts did not change selection.
- The full web build passed using temporary SELECT-only privileges on the empty
  loopback fixture. Those privileges were revoked and independent SQL verified
  all 157 tables empty afterward. CI and live theme rendering remain unverified.
  Static Liquid assertions and fixture HTML are not a Shopify theme-engine render.

This remains a base-program estimate, not a guarantee of awarded points. The
public program endpoint does not establish shopper VIP, targeted campaigns,
subscription eligibility, order discounts/taxes or presentment-to-program
currency conversion. Variant selection across multiple product forms and theme
section lifecycle acceptance also remain separate surface work under L09/E1–E2.
No launch checkbox is closed, and nothing is deployed by this patch.
