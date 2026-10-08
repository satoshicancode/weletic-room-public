# S11 recorded points-transaction row export candidate

September 25, 2026 JST. This is an implementation and isolated verification
record, not installed acceptance or a whole-history financial statement.

The signed Shopify merchant gateway now offers an owner-only CSV of up to 2,000
retained, non-redacted points-ledger entries within a selected UTC range of at
most 366 days. The route reauthorizes the current installation and audits the
export action. Candidate discovery uses the existing `(storeId, createdAt)`
index; selected accounts are locked and privacy is rechecked before rows are
returned. Over-limit results return no partial file. Store and account scopes
are checked with binary identity comparisons.

Rows carry a domain-separated pseudonymous account key, account ledger
sequence, UTC entry time, entry type, exact decimal-string points and pending
deltas, and recorded balance after the entry. The export omits customer/order
IDs, grants, references, idempotency keys, reason and metadata. Negative point
strings remain exact CSV values after strict integer validation; untrusted text
cells still use spreadsheet-formula neutralization. EN/JA/VI UI explains the
coverage and requires applied start/end dates. Spreadsheet auto-import may round
integers above its numeric precision; import the numeric columns as text to
preserve the file's exact values.

This is **recorded retained ledger history only**. Erased or missing history,
Shopify transactions outside the ledger, and unavailable pre-Weletic events
cannot be inferred. The export does not claim a complete customer lifetime or
reconstruct financial liabilities from account snapshots.

Local evidence on the candidate branch:

- Eleven focused contract/gateway/authorization tests passed; the merchant
  analytics UI suite passed, including owner/date gating, too-large refusal and
  EN/JA/VI labels.
- Two isolated MySQL 8.0.46 tests passed for exact values above JavaScript's
  safe-integer range, cross-store exclusion, 2,001-row refusal, redaction and
  erasure racing a locked export. The disposable database was
  `weletic_loyalty_it_ledger_rows_baf41c2d390a` on loopback port 3314.
  Independent post-test SQL counted zero ledger, account, store, program and
  project fixture rows. Log: `/tmp/weletic-ledger-row-s11-sql-rerun-20260925.log`,
  SHA-256 `05b34bdb19926b679213290e691272e4c59cd65b9bc1fca467b41eb5246407c9`.
- Web and Shopify TypeScript checks, targeted ESLint, route-policy test and
  Shopify app build passed. The web production build passed with a fresh
  disposable MySQL schema used only for unrelated static-page collection;
  independent SQL counted zero ledger, account and store rows, and the fixture
  was removed. Build log: `/tmp/weletic-ledger-row-export-s11-web-build-with-db-20260925.log`,
  SHA-256 `0b8922a7df6a4c393d5c0f6a2802cc01fd1337b15e5bb83016a909c6cab4de2a`.
- Full web lint passed. The complete deterministic unit suite passed with a
  fixture-only `SHOPIFY_API_KEY`: **663 files, 10,442 tests passed, six skipped**.
  Log: `/tmp/weletic-ledger-row-export-s11-full-unit-with-fixture-20260925.log`,
  SHA-256 `da135860ab32777a83332203a69f5e7af72b1a8dae0423f62d38bea0026097de`.
  Without that local setting, an unrelated archived-discount test fails with
  `invalid_scope` on both this branch and clean public `main`; its isolated
  rerun passed when the fixture ID was supplied. PR CI remains pending.

No migration, shared schema application, live export, provider send or module
activation is part of this slice. Provider-scale read-plan evidence, deployed
route admission, installed owner/staff journeys, privacy recovery and the
module release gates remain open.
