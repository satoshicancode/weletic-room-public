# S17 recorded-ledger redemption-to-earn rate — implementation candidate

Status: standalone implementation candidate based on public main. No installed
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
existing activity query and index gate. On this reconciled branch, 38 focused
S16/S17 service, UI and arithmetic tests pass, along with TypeScript using the CI heap
setting, full web lint, Prisma validation and formatting. Current-head CI, a
standalone production build and isolated SQL rerun are separate checks. The
earlier stacked candidate passed a complete web unit suite, production build
and isolated SQL reconciliation; those results do not certify this branch.
Neither implementation establishes a named installed journey or complete
Smile parity.

The inherited isolated SQL test accepts disposable loopback MySQL on the
standard port 3307 or the alternate port 3312. It still requires an exact
isolated schema and matching principal. No shared or provider database was used
by this standalone branch's focused checks.
