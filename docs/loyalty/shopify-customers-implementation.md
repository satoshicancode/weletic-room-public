# Shopify Customers implementation checkpoint

Date: 2026-09-07. Scope: unified completion plan, package 8. Status: backend
adapter and Shopify Customers UI implemented locally; release and live acceptance
pending.

## Contract and boundaries

- Reuse the existing shopper directory, segment predicates, profile sections,
  privacy filtering, and exact string-valued balances. No new customer model,
  reward writer, schema migration, or Partner enrollment.
- Existing workspace callers retain their transaction behavior. Shopify callers
  supply the transaction that establishes `customers.read` authority.
- Internal POST routes are `/api/internal/shopify/merchant/customers/list` and
  `/api/internal/shopify/merchant/customers/profile`. Verify the signature over
  the entire bounded actor/input body before opening the database transaction.
- Remix POST adapters are `/api/merchant/customers` and
  `/api/merchant/customers/profile`. They use the existing fresh online merchant
  authenticator and bounded signed backend transport. GET is rejected.
- Browser input is strictly limited to filters, cursors, and shopper ID/section.
  Workspace identity is taken from the authorized store, whose `projectId` is
  unique. The same transaction holds the installation/authority fence while
  reading the shopper projection.
- Cursor scope includes operation, store, workspace, app, installation generation,
  staff user, grant revision, and normalized filters. The wrapper is an opaque
  pagination contract, not a signature or authorization mechanism. Every page
  independently authorizes and runs store-scoped queries.
- Directory/profile projections omit credentials, coupon bearer artifacts,
  private media keys, provider error details, and arbitrary metadata. Errors and
  private/no-store responses retain the existing fail-closed behavior.
- Shopify mounts the shared EN/JA/VI shopper browser with scoped styles and a thin
  App Bridge transport. Strict browser-safe response schemas validate every
  section, pagination consistency, exact integer strings, and projection fields.
- Each Shopify screen owns its cache. Navigation uses fresh keys, and pending
  revalidation hides previous data. Failed authorization is not automatically
  retried. The installation loader returns no customer data or session secrets.

## Local evidence

- Focused gateway, shared profile/directory, browser client, rendered UI, and
  coordinated-authentication tests passed: 202 tests in seven files. Nine Shopify
  route-bootstrap tests passed separately.
- Web and Shopify type-checks, all ten root lint tasks, repository formatting,
  Prisma validation, and Shopify build passed.
- Web production build passed with 362 static pages against the guarded isolated
  MySQL database. The first invocation lacked `DATABASE_URL` and stopped during
  static data collection; rerunning with verified local credentials resolved the
  environment failure without changing application code. No shared DB was used.
- Final UI-head full unit suite passed: 304 files, 4,694 tests, six skipped.
- Guarded actual MySQL staff suite: 21 tests passed, including two new Customers
  cases. Target: isolated `127.0.0.1:3307/weletic_loyalty_dev`, identity checked
  as `loyalty_dev@%`; no live Shopify requests. Fixture cleanup uses generated
  store IDs only.
- The new DB cases prove permission-specific directory/profile access,
  grant/revocation behavior, store-generation mismatch rejection, cross-store
  shopper rejection, actual cursor pagination/filter mismatch, privacy
  tombstone suppression, and authorization-receipt rollback after failed reads.
  The final UI run also validates actual directory/profile responses against the
  browser response schemas.
- Independent read-only adversarial review found no blockers in gateway or
  fixture changes. Review identified an SWR cached-data flash on revisiting a
  section; fresh navigation keys fixed it, with two rendered DOM-mutation
  regression tests and an independent follow-up review.
- Real Chromium exercised the local Remix Customers page with synthetic App
  Bridge and HTTP fixtures; nonlocal network requests were blocked. English,
  Japanese, and Vietnamese rendered. The Vietnamese 375px viewport measured
  375px document width, with exact large positive/negative points intact.
- Browser navigation back to Overview held a fresh request, then returned 403:
  neither visible content nor inserted DOM nodes exposed cached personal data.
  Exactly one fresh request occurred, no automatic retry; explicit retry worked.
  This proves local UI behavior, not real staff authentication or inbox delivery.
- A separate local Chromium keyboard pass reached and opened a profile using
  Tab/Enter, then reached and activated Purchases. The focused button had a solid
  2px outline and the selected section exposed `aria-current="page"`. This is a
  bounded keyboard smoke test, not complete screen-reader/accessibility coverage.
- PR #79's first Shopify CI check exposed a remaining generated-Prisma type
  import in the shared label formatter, masked by local generation. Its types
  now derive from the browser-safe response contract. The complete Shopify app
  type-check also passes with `@prisma/client` mapped to an empty module; 41
  focused UI/client tests pass. Fresh exact-head CI remains required.

## Remaining release work

- Complete full accessibility and broader mobile coverage, CI/release,
  and live
  `yamaxdev` acceptance evidence before declaring this package accepted.
- DB tests change the store generation only; they do not prove a complete
  reinstall workflow. Cross-store cursor rejection is not a same-store
  generation-replacement test. The tombstone fixture combines digest and owner
  linkage and does not independently isolate those lookup paths.
- No store reconnection, email send, database rollout, Shopify deployment,
  migration, or benchmark-store change was performed for this checkpoint.
