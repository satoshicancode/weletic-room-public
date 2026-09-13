# Customer-account hub localization — September 13, 2026

## Scope and status

Draft implementation on public-main base
`e560efc921be0ad1aed7ac7bf5d2d98c731ca61a`. This is local component evidence,
not a completed release, full L09 acceptance, or a named live yamaxdev journey.

- EN/JA/VI native host translations cover summary, balances, rewards, wallet,
  referrals, VIP, campaigns, birthday, activity, earning actions and error states.
  Merchant names, descriptions and perks remain escaped merchant content.
- Point formatting retains exact integer values. Currency display uses buyer
  locale and exact decimal/minor-unit parsing; malformed amounts show unavailable.
  Display rounding does not change ledger arithmetic or reward eligibility.
- VIP completion requires consistent current-tier/list evidence and explicit
  absence of a next tier. Missing data does not imply the highest tier.
- Expiry display honors the API's zero-days sentinel for months-based policies.
- Clipboard DOM targets are generated UI identifiers, not persisted reward IDs.
  Point-history labels use localized entry types instead of ledger audit reasons,
  which can contain internal order references or provisioning diagnostics. The
  backend audit trail and existing API payload are unchanged.
- Remote errors are mapped to local messages. HTTP authentication, permission
  and rate-limit guidance survives non-JSON error bodies. Unknown write outcomes
  remain unconfirmed; arbitrary server/transport details are not displayed.
- Redemption artifact validation precedes retry-key deletion. Empty, primitive,
  malformed-code, unknown-kind and explicit failure payloads retain the same
  intent. Legacy code-only responses and explicit wallet-only artifact kinds
  remain supported; store-credit transaction references are never shown as codes.
- Public extension staging includes the localization module. Extension identity,
  target, signed gateway, request fields and backend accounting are unchanged.

## Verification checkpoint

- 88 real Preact/jsdom hub tests; 172 Shopify-package tests passed in total.
  The host localization API, session token and HTTP responses are mocked.
- 49 web storefront/staging tests and Shopify typecheck passed.
- Component coverage includes all seven earning-action labels, exact numeric
  boundaries, wallet variants, expiry/birthday states, VIP evidence, error recovery,
  same-page history retries and repeated malformed redemption responses preserving
  identical request bodies and keys across EN/JA/VI.
- Independent review found and verified fixes for the months-only expiry and
  malformed-success retry issues. Subsequent scoped reviews found no blocker.
- Repository lint, Shopify build and Prisma validation passed at earlier draft
  checkpoints. Web typecheck caught BigInt syntax incompatible with the importing
  web project's target; constructor-based arithmetic passed its retry. Final
  source-frozen publication checks remain required.
- Full web regression passed: 500 files, 8,095 tests passed and six skipped
  (760.30 seconds). Source edits occurred during this run; it is broad regression
  evidence, not a frozen-revision certification of those later changes. The final
  artifact validation separately passed all 172 package and 49 focused web tests.
- Final web typecheck passed after artifact validation. The SELECT-only isolated
  Next build passed, its temporary fixture grant was revoked, and independent SQL
  reconciliation confirmed all 157 fixture tables remained empty. Source changes
  occurred during the build; the final artifact logic also has separate focused
  test and typecheck evidence rather than relying on compilation timing.
- Final Shopify build and repository lint passed after artifact validation. Public
  CI and merge status remain separate gates.

## Remaining acceptance and publication gates

- Complete the final frozen-source verification suite and public PR CI before
  merging. Passing an earlier draft does not certify subsequent source changes.
- Native Shopify rendering, actual clipboard operation, 375px layout, keyboard
  navigation, accessibility, language switching/fallback and real customer-account
  authentication remain unproven by jsdom custom-element tests.
- Full response-schema validation is not claimed. Artifact validation does not
  independently prove financial settlement or validate every summary, wallet,
  pagination and earning-response field. These remain adversarial/live checks.
- No real order, redemption, email, installation, deployment or loyalty activation
  is established here. Protected-data/network permissions, public-app identity,
  Cloudflare runtime and production rollout retain their separate gates.

The [unified acceptance matrix](unified-acceptance-matrix.md) remains authoritative.
No live checkbox is closed by this document.
