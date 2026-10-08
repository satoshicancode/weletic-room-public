# S15 recorded tier-event export candidate

The signed merchant analytics snapshot stays aggregate-only. This separate
owner-only export reads retained VIP tier-history events for one authenticated
store and installation generation, within at most 366 UTC calendar days. One
request returns up to 2,000 rows from one database transaction. A larger result
returns no rows and asks the owner to narrow the UTC range; there is no partial
download or cross-request assembly. Candidate discovery is a nonlocking read.
Before any row is returned, the same transaction locks the selected accounts and rechecks
privacy and event existence with a current locking read. No new schema or
migration is introduced.

Rows contain an account pseudonym, the recorded event time and reason, and the
**current** labels for the former and new tier IDs. The pseudonym is derived from
the store ID and a random internal account ID; the CSV does not expose either
raw ID, Shopify customer identity, free-text notes, spend or points snapshots.
An account with a privacy-redaction marker is excluded. This is retained event
history, not a reconstruction of historical tier names or membership. Erased or
pre-Weletic history is unavailable. The merchant screen explains these limits
in English, Japanese and Vietnamese and requires both dates before export.

Local verification on September 25:

- Focused contract, signed-route, gateway, service, screen and CSV tests passed
  (50 tests across four files); the existing analytics screen tests remained
  green. The Shopify app and full web TypeScript checks passed; the web check
  used an 8 GB Node heap because the default 4 GB heap was insufficient for
  this monorepo. The Shopify app build, targeted lint, formatting and the
  explicit release-route test passed.
- A fresh, disposable MySQL 8.0 schema on loopback port 3312 passed the guarded
  isolated SQL tests. They inserted 201 tied-timestamp events for one account,
  another event for the same store and a foreign-store event. One export returned
  202 rows without foreign data. Adding 1,800 events returned `too_large` with
  **zero** rows. After the first account was marked redacted, only the second
  account remained; renaming the tier changed its displayed current label. A
  separate test held an account erasure lock while export started, then committed
  redaction; the export waited and excluded that account.
- The fixture EXPLAIN used the store/account and account/history indexes for
  candidate discovery, but also reported a temporary table and filesort. That
  read has no tier-history row locks; its provider-scale latency and read plan
  remain an acceptance gate. The final current read is keyed by selected
  accounts and candidate event IDs, capped at 2,000.
- Independent SQL after test cleanup counted zero tier histories, accounts,
  stores and merchant actions. The disposable schema and container were removed.

The installed yamaxdev owner journey, real staff denial, provider-scale read
plan and release-image evidence remain open. This candidate does not make
Loyalty analytics accepted or launch-ready.
