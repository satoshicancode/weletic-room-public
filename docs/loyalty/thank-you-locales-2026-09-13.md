# Thank-you balance localization — September 13, 2026

## Scope

The existing thank-you extension coerced signed database integer strings to
JavaScript Number and hardcoded its heading and balance labels in English.
The draft preserves exact signed 64-bit balances as BigInt and sends them to
Shopify's `i18n.formatNumber`; `i18n.translate` consumes EN/JA/VI locale files.
The public staging allowlist includes those catalogs. No target, manifest UID,
endpoint, authentication, schema, reward policy or deployment setting changes.

Shopify's [localization API](https://shopify.dev/docs/api/checkout-ui-extensions/latest/target-apis/platform-apis/localization-api)
documents locale-file translation and localized numeric rendering. The installed
2026.7.0 types explicitly accept BigInt in `formatNumber`.

This remains the account balance, not points earned on the displayed order.
It must not claim that an order has earned points before the accounting pipeline
confirms it. Existing unrelated default-locale keys remain compatible.

## Local evidence and limits

- 27 focused tests pass: signed boundaries and unsafe-number rejection, malformed
  or unenrolled responses, exact EN/JA/VI component rendering, omitted zero/unknown
  pending values, HTTP failure and authentication failure.
- Component rendering uses real Preact in jsdom with mocked Shopify translation,
  token and HTTP transports. It verifies that synthetic identity/token fields do
  not enter markup. It does not prove Shopify-host rendering, language selection,
  protected-data access, mobile layout, screen-reader behavior or live balance.
- Missing/invalid available balances hide the summary rather than displaying an
  invented zero. Missing/invalid pending balances omit that line, not the valid
  available balance. Only balance fields enter component state.
- All 59 Shopify-package tests and five public-stage tests pass. Shopify
  typechecking, root lint, Shopify build and Prisma validation pass. Independent
  review found no blocker; host locale fallback and lifecycle remain unverified.
  Web typechecking initially exhausted Node's default 4 GB heap; the retry passed
  using the existing 8 GB CI setting. The full web build passed with temporary
  SELECT-only access to the isolated loopback fixture. Privileges were revoked
  afterward and independent SQL confirmed all 157 tables empty. No schema was
  applied.
- After syncing merged PR #39, all 34 product/staging tests and 59 Shopify-package
  tests passed again. Full web regression passed: 500 files, 8,095 tests passed
  and 6 skipped (647.26 seconds). Public CI remains pending at publication; the
  build above preceded that sync and is not a live-runtime acceptance result.

Named yamaxdev acceptance, public registration ownership, permissions and release
remain open. No checkout-reductions target is activated and no live operation is
performed by this change.
