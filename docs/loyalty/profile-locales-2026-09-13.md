# Profile block localization — September 13, 2026

## Scope

The existing profile block converted database integer strings to Number and
hardcoded its summary, loading, error, retry and enrollment copy in English.
The implementation preserves signed 64-bit balances as BigInt and formats them through
Shopify's native `i18n.formatNumber`. Missing or malformed balances display a
localized unavailable label instead of an invented zero.

EN/JA/VI catalogs cover all visible block states. The merchant's tier name remains
escaped dynamic text; the fallback member name and available-wallet reward count
are localized. Wallet-count semantics, token gateway, endpoint, timeout, hub link,
manifest UID and target are unchanged. The public staging allowlist includes the
three new catalogs without changing extension ownership.

Shopify's [customer-account localization API](https://shopify.dev/docs/api/customer-account-ui-extensions/latest/target-apis/platform-apis/localization-api)
supports locale-file translations and BigInt numeric formatting. The implementation
uses separate singular/plural reward keys and a `formattedCount` replacement,
not a formatted string in Shopify's special numeric `count` option.

## Local evidence and remaining gates

- 25 component tests passed: signed int64 boundaries, malformed/lossy balances,
  exact EN/JA/VI summaries, escaped tier markup, unavailable/member labels,
  loading, HTTP error, retry, enrollment and failed authentication.
- Tests render real Preact with jsdom and a mocked Shopify host, token and HTTP
  transport. They preserve the authenticated URL/header contract and assert that
  synthetic account/token values do not appear in markup.
- Independent review found no blocker in the scoped changes. Validation here is
  only for point strings, not the complete API response. Malformed wallet data,
  host locale fallback, mobile/accessibility and live lifecycle acceptance remain
  open; this change does not claim those are covered.
- All 49 storefront/staging tests and 57 Shopify-package tests pass, along with
  Shopify typechecking and focused ESLint. An existing source-text check was
  updated to assert the retry translation key and English catalog rather than
  require a hardcoded label; actual component tests verify retry behavior.
- Root lint and the Shopify build passed. Web typechecking found that existing
  web tests import this extension under a pre-ES2020 target; the exact int64
  bounds now use `BigInt("…")` instead of literal syntax. Web typechecking and
  Prisma validation passed on retry without changing compiler settings or
  numeric behavior; the 57 package and 49 focused tests also passed again.
- Full Next build passed with temporary SELECT-only local fixture access;
  access was revoked and all 157 fixture tables were independently verified
  empty afterward. This build preceded synchronization with PR #40.
- After synchronizing public main `870c18daa08bd51bb6593030457bcfdae9dbc99b`,
  all 84 Shopify-package tests and 49 storefront/staging tests passed. Full web
  regression passed: 500 files, 8,095 tests passed and 6 skipped (634.60 seconds).
  Public PR CI remains a separate publication gate.

The full customer-account hub is a separate surface with remaining localization
work. These results certify neither that page nor complete L09 acceptance.

No schema, deployment, Shopify operation, real redemption or email was performed.
L09/E1–E2 remain open pending their complete named evidence.
