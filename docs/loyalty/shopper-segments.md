# Shopper segments from existing facts

Package 2 implementation checkpoint, 2026-09-06. Read-only dynamic segments in
the shared shopper directory; no new schema, enrollments, persisted membership,
Partner groups, provider calls or send authorization.

## API contract

`GET /api/weletic/shoppers` retains workspace authentication, `loyalty.read`,
private/no-store responses, search and bounded keyset pagination. Optional
additive query parameters match **all** selected conditions:

| Parameter                          | Values and meaning                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loyalty`                          | `any` (default), `enrolled` (any account status), `not_enrolled`, `active`, `suspended`, `closed`                                                                                           |
| `minPoints`, `maxPoints`           | Inclusive cached settled-balance bounds as canonical signed 64-bit decimal strings; blank means unset. Pending points and monetary value are not included. Negative balances are supported. |
| `vip`                              | `any` (default), `assigned` (existing non-deleted tier in this store), `unassigned` (an account with no tier ID). These are recorded assignments, not a new qualification evaluation.       |
| `purchase`                         | `any` (default), `has_order`, `no_order`; only locally recorded orders with current status `paid` or `partially_refunded` count.                                                            |
| `purchasedFrom`, `purchasedBefore` | Valid `YYYY-MM-DD` calendar dates, interpreted as UTC midnight. Start inclusive, end exclusive, applied to original order time. Require a purchase condition.                               |

Point ranges must be ordered; date windows must have an end after the start.
Not-enrolled cannot combine with point/tier conditions. Invalid input returns
the existing private generic 400, not an unhandled conversion error. Unknown
unrelated query parameters retain the pre-existing stripping behavior.

The service filters relations in MySQL before the bounded shopper scan. Order
and account relations carry independent store predicates; assigned tier programs
are also store-scoped. Shopper lifetime counters, money totals, cached Shopify
segment IDs, marketing flags and affiliate data are not eligibility inputs.
Missing local history does **not** prove a shopper never purchased. Order status
does not assert positive remaining spend or review/referral/reward eligibility.

Version 2 cursors bind store, installation generation, search and all normalized
segment criteria. Version 1 cursors remain accepted only for unfiltered requests
with the original search scope during the compatibility window. Changing a
condition requires restarting pagination. This is a live view, not an immutable
membership snapshot: account/order changes can change results between pages.

## Privacy and interfaces

Existing pseudonym, identity and linked-owner tombstone suppression still runs
before serialization, even for expired linked-owner identities. Empty suppressed
pages retain continuation and never expose redacted-match counts. No derived
segment membership is stored, exported or left behind by erasure.

The reusable merchant browser adds labeled English/Japanese/Vietnamese controls,
explicit Apply/Search and Clear behavior, validation feedback, and resets cursors
on segment changes. SWR keys include all criteria and do not retain old results
while a different scope/query loads. Surrounding Dub navigation remains English.

This does not add saved named segments, bulk sending, Shopify segment mutation,
campaign enrollment, customer-account UI or an embedded Shopify adapter. Those
consumers must keep their own permission, consent and event-idempotency checks.

## Verification and release status

Production-service MySQL tests cover order states, date boundaries, exact large
and negative balances, malformed foreign relations, deleted/foreign tiers,
privacy suppression and scoped pagination. The suite guards the exact isolated
loopback database and principal, blocks external fetch and cleans its synthetic
rows. Unit/React tests cover validation, legacy/new cursors, request boundaries,
filter application and old-result removal. Final test totals and CI evidence are
recorded on the delivery PR after verification.

No live Shopify store, shared schema or email transport was changed. This
checkpoint does not certify the full package or a live `yamaxdev` journey.
