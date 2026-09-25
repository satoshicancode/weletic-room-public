# S01 current-account row export candidate

September 25, 2026 JST. This records implementation and isolated verification,
not installed acceptance or a complete customer-history report.

The signed Shopify merchant path offers an owner-only CSV of up to 2,000
retained, non-redacted Loyalty accounts enrolled within a selected UTC range of
at most 366 days. The current installation generation is fenced and the
`analytics.export` permission is audited. Candidate discovery is bounded; the
selected account rows are locked in stable ID order and privacy-filtered again
before returning data. Over-limit results return no partial file. Store and
account comparisons include binary identity checks.

Rows contain a domain-separated pseudonymous account key, enrollment instant,
current account status, current tier order, cached points/pending balances and
lifetime earned/redeemed counters as exact decimal strings. The export omits
raw account, shopper and Shopify customer IDs, contact details, referral codes,
orders and metadata. The EN/JA/VI interface requires applied start/end dates
and explains that spreadsheet numeric columns should be imported as text.

This is a **current retained-account snapshot grouped by recorded enrollment**.
It does not reconstruct historical VIP membership, erased accounts, missing
pre-Weletic history, customer lifetime or independent ledger reconciliation.
The account pseudonyms use a report-specific domain and therefore cannot be
joined to ledger, redemption or tier-history CSVs. That separation is
intentional for this candidate; a cross-report key contract would need a
separate approved privacy design before account-level reconciliation is
claimed. Provider-scale query plans and latency remain open because the
current account index does not match the store/enrollment sort; the 2,001-row
output bound does not bound the rows scanned. A named installed merchant
journey also remains open.

Candidate-branch evidence:

- Focused contract, signed route, app action and UI suite: 62 tests passed,
  including owner/date gating, stale generation, oversized refusal and
  EN/JA/VI labels.
- Three isolated MySQL 8.0.46 tests passed on loopback port 3314: exact values
  above JavaScript's safe integer range, populated current-tier join,
  cross-store exclusion, stable pseudonyms, erasure racing an export and
  refusal of a partial result at 2,001 eligible accounts. The database is
  `weletic_loyalty_it_account_rows`; independent SQL counted zero account,
  shopper, tier, store, program and project rows after fixture teardown.
- Web and Shopify TypeScript checks, full web lint, Prisma validation and 33
  Cloudflare release-route policy tests passed. The Shopify app build passed.
  The final-head web production build passed against the disposable database;
  its log is `/tmp/weletic-account-row-web-build-final-20260925.log` (SHA-256
  `6377961db1ea3e78a312cbd04b1db548090653b1f617bb8da1ebc3ed89ffb616`).
  The Shopify build log is
  `/tmp/weletic-account-row-shopify-build-final-20260925.log` (SHA-256
  `b0c987d3a0d5e6f5d84cb57875e63d4ec9ec6323e32e21986fe4d9a33e9f8ba0`).
  The complete deterministic web unit suite passed: **669 files, 10,482 tests
  passed, six skipped**, with only a fixture `SHOPIFY_API_KEY`. Its log is
  `/tmp/weletic-account-row-full-unit-20260925.log` (SHA-256
  `a13acc47480c7c3e818128464a0a8846e9e235552f876642bce647f84ec46fde`).
  Current-head PR CI evidence remains pending.

No shared migration, live export, provider send or module activation is part
of this slice.
