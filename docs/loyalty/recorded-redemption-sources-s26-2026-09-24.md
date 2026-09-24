# Recorded redemption debit sources (S26)

Status: implementation candidate, September 24, 2026. This is a partial
Weletic-defined breakdown, not the unknown Smile `Total` formula or installed
acceptance.

The signed merchant snapshot groups retained negative `REDEEM_REWARD` ledger
entries by reward definition ID, name and type captured at debit time. A named
group requires the linked redemption to point back to that ledger entry and to
match the captured reward ID and exact points spent. The linked redemption does
not independently verify the captured name or type. Missing, malformed or
inconsistent provenance contributes to an explicit unknown group. The report
shows ten named groups; all remaining named groups are summed as other. The
named, other and unknown groups reconcile to an exact count and gross point
total. Date filters use inclusive ledger `createdAt` instants. An omitted range
means all retained history for the authenticated store.

This is a count of debit entries, not unique customers, issued voucher success,
remote discount uses, net cost or historical reward-revision economics. Later
cancellations and refunds are separate ledger movements. Zero-point direct
awards and missing or erased history are not reconstructed. Captured names can
change between debits and remain separate groups. Existing merchant read and
owner-only export permissions, installation fencing, formula-safe CSV and
EN/JA/VI disclosure are reused. No writer or schema migration is added.

Focused service, signed-response, CSV and screen tests pass (49 tests). The
complete web unit suite passed (655 files, 10,403 tests, six skipped), as did
full web lint, TypeScript (8 GB heap), Prisma validation and the supported
loyalty-only production build.
A disposable MySQL 8.0 fixture on loopback
port 3312 independently reconciles the exact debit total above JavaScript
number precision, two captured names for one reward ID, unknown provenance,
case/accent-sensitive grouping, inclusive partial instants, cross-store
exclusion and the top-ten overflow bucket. That is not a provider-scale read
plan. Exact-head CI and named installed merchant acceptance remain open.
