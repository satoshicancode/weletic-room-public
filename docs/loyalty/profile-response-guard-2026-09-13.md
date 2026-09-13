# Profile summary response guard

Status: local implementation; publication and live acceptance pending.

The customer-account profile block previously passed unchecked response JSON
to rendering. A non-array wallet or a null wallet entry could throw outside
the request error handler instead of presenting the localized retry state.

The block now validates the fields it renders before storing the summary.
Enrollment must be boolean, optional account/tier values must be objects, tier
names must be strings when present, and wallet entries must contain string
statuses. Missing/null optional wallets retain the existing empty-wallet
behavior. Unknown string statuses remain compatible and do not count as
available. Invalid point values retain the existing points-unavailable display;
valid signed-int64 strings remain exact.

Only enrollment, point text, tier name and wallet statuses are projected into
component state. Identifiers and unused response fields are not retained.
Malformed data follows the existing localized unavailable/retry view. This is
a rendering-boundary guard, not validation of the entire loyalty API schema.
No endpoint, authentication, scope, locale contract, schema or accounting changes.

## Local evidence

- Focused profile suite: 38 tests passed, including malformed shapes, projection
  and EN/JA/VI malformed-wallet-to-successful-retry journeys.
- Full Shopify suite: 5 files, 185 tests passed (2.82 seconds).
- Shopify TypeScript and Remix app build passed. The first typecheck failed
  because the new worktree lacked the ignored web dependency link; restoring
  that link resolved the errors without dependency or source changes.
- Tests render the actual Preact component in jsdom with mocked Shopify host
  APIs and network responses. They do not establish hosted extension rendering,
  network permissions, deployment or named-store acceptance.

Public-app identity and deployment gates remain unchanged. This correction does
not implement the separately proposed advanced appearance contract.
