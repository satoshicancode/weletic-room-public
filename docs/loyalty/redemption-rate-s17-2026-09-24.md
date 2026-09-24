# S17 recorded-ledger redemption-to-earn rate — implementation candidate

Status: unmerged stacked candidate on draft PR #117's S16 branch. No installed
merchant acceptance or complete historical coverage is claimed.

The signed merchant snapshot derives one UTC-month row from the existing
tenant-scoped, bounded S24 daily ledger series within the selected inclusive
instants; the first and last months may be partial. The numerator is the absolute
points debited with `REDEEM_REWARD` entries during the month. The denominator is
positive earned points from `EARN_ORDER`, `EARN_REFERRAL`, `EARN_BONUS` and
`TIER_BONUS`, excluding `BACKFILL` opening balances. `REFUND_REVERSAL`, expiry,
backfill corrections and manual adjustments remain separate S24 categories;
this is not a net wallet movement or discount-use rate. A later refund does not
rewrite an earlier month's gross debit. Canceled or compensated redemptions
remain in that gross debit; restoration credits are separate manual
adjustments. Members can spend points earned in a different month, so the
ratio can exceed 100%.

`redemptionRateBasisPoints` is the half-up-rounded integer ratio of redeemed to
earned points (`10000` = 100%). Exact amounts are decimal strings. A zero
denominator produces `null`, not a fabricated zero rate. The response carries
`coverage: recorded_ledger_only`; absent historical or peer data is not
inferred. EN/JA/VI copy explains the calculation and limits.

The series shares the signed merchant read, installation/store checks and
owner-only JSON/CSV export. It adds no SQL read or schema change beyond S24's
existing activity query and index gate. Focused service, UI and arithmetic
tests pass. The complete local web unit suite passed (649 files, 10,357 tests,
6 skipped), along with TypeScript, lint, Prisma validation, formatting and the
production web build (367 static pages) against a disposable empty local MySQL
schema. The schema was verified empty and removed. An
isolated MySQL fixture independently reconciled the ten-point
qualifying earn and five-point redemption against the derived 50% rate while
excluding a much larger backfill and another store; cleanup returned stores,
ledger entries and accounts to zero. These tests do not establish a named
installed journey or complete Smile parity.

The isolated SQL test now requires loopback port 3312 because port 3307 was
already occupied by an unrelated SSH listener on this host. No connection to
that listener was attempted.
