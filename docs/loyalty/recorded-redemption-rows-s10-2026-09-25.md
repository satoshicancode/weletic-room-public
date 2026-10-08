# S10 recorded points-redemption row export candidate

September 25, 2026 JST. This is an implementation and isolated verification
record, not installed acceptance or a complete redemption-history statement.

The signed Shopify merchant gateway offers the current store owner an audited
CSV of up to 2,000 retained, non-redacted, account-backed redemptions with
positive points spent. Both UTC date endpoints are required; a range wider
than 366 days or more than 2,000 matching rows produces no partial file. The
selected range filters the redemption's recorded creation time. The status is
its **current** status at export, not an event history; `usedAt` may fall
outside the selected range. Direct zero-point shopper coupons are outside this
points-redemption report.

Each row contains report-scoped pseudonymous account and redemption keys,
creation and optional use time, current status, artifact kind, and exact decimal
points spent. The export omits discount codes, customer and order IDs,
fulfillment references and free-text metadata. CSV numeric cells are strictly
validated, while untrusted text cells are neutralized for spreadsheet formulas.
EN/JA/VI UI requires applied dates and explains that large point values must
be imported as text in spreadsheet apps to avoid rounding.

The route verifies the signed request before database access, reauthorizes the
current installation and owner permission, and uses the existing store/date
index for bounded candidate discovery. It locks selected accounts and rechecks
privacy and row scope before returning data. Store and account identity
comparisons are binary. The locking reads also use indexed IDs and force
primary-key access in redemption-first order so their scope stays within the
selected rows. This is retained Weletic data only: erased or missing
history, issuance transition times, remote use not reconciled to the local row,
and pre-Weletic redemptions remain unavailable. Provider-scale query-plan and
installed owner/staff acceptance remain open.

Local evidence:

- Focused contract, signed-route, action and EN/JA/VI UI tests passed, including
  owner/date gating, stale generation and over-limit refusal: 58 tests. The
  exact Cloudflare route-policy suite also passed: 33 tests.
- Two isolated MySQL 8.0.46 tests passed on a disposable loopback database for
  exact values above JavaScript's safe integer range, cross-store and
  zero-point exclusion, 2,001-row refusal, current redaction and an erasure
  racing a locked export. Independent SQL counted zero redemption, reward,
  account, shopper, store, program and project fixture rows after the tests.
  Log: `/tmp/weletic-redemption-row-s10-sql-final-20260925.log`, SHA-256
  `ca2555a35fcb19296d94bc593c3c95c62712f64101c5e59c3f22b1d9435aeeaa`.
- A read-only `EXPLAIN` on the empty disposable schema used primary-key ranges
  for the selected accounts and redemptions and a primary-key lookup for each
  joined account; independent SQL then counted zero fixture rows in all seven
  affected tables. This does not replace a populated provider-scale plan.
  Log: `/tmp/weletic-redemption-row-s10-sql-plan-final-20260925.log`, SHA-256
  `ddd17158b52e5513bcf122d10120904b09ab348fc51732107b9c2959d81687b6`.
- The full repository unit run passed seven tasks, including 666 web test files
  (10,457 passed, six skipped) and 19 Shopify app test files (322 passed).
  Root lint passed all ten tasks; web TypeScript, Shopify TypeScript, Prisma
  validation, Shopify app build, web production build and repository Prettier
  check passed. Full unit log SHA-256:
  `b3238b90f0a0162686a8178c74c37ac7ee570b565950d89ee546afa42054e750`;
  web build SHA-256:
  `6568b75dfda66c0a6c32688647c94feefcef449ce175f7a545adba714268d16a`.

No migration, shared schema application, live export or provider operation is
part of this slice. The S10 row remains partial until provider and installed
acceptance, and the Loyalty module release gate remains open.
