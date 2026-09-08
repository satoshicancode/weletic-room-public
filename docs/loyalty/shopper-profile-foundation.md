# Shared shopper profile — local implementation checkpoint

2026-09-06, package 2 of the approved unified completion plan. This is an
additive read-only foundation, not acceptance of the full customer experience.

## Contract

`GET /api/weletic/shoppers/profile?workspaceId=…&shopperId=…` resolves the
workspace through existing authentication and requires `loyalty.read`, matching
the existing review-admin boundary. The service resolves an active, bound store
and the store-scoped `WeleticShopper`; it never creates a loyalty account or
uses Dub Customer/Partner identity. Requests cannot select another store.

The default `overview` contains shopper identity, recorded locale, existing
module states and nullable loyalty balances/tier. `section` selects `purchases`,
`points`, `referrals`, `reviews`, `rewards` or `review_requests`. Collections use
`limit` (1–50; default 20) and opaque `cursor` pagination scoped to store,
shopper, installation generation and section. Points use ledger sequence plus
ID; other sections use creation time plus ID. Purchase ordering is ingestion
chronology, with the separate original order time retained in each row.

Balances, pending deltas and monetary minor units are exact decimal strings.
Purchases retain their accounting currency; the profile does not sum currencies
or reinterpret gross order totals as post-refund revenue. Historical records
remain readable when a module is disabled. Redacted shoppers, frozen stores and
cross-store identities are unavailable. Read projections are not persisted and
therefore add no derived table to export or erase.

Responses are private/no-store. Queries select no bearer discount/gift-card
codes, delivery tokens, media URLs, raw provider errors, abuse signals or
arbitrary metadata. The overview's Shopify marketing boolean is explicitly not
affirmative consent evidence or suppression history. Review-request send records
and friend-offer email timestamps are partial communication evidence, not inbox
delivery proof.

## Directory and merchant consumer

`GET /api/weletic/shoppers?workspaceId=…` uses the same read permission and
store boundary. Optional `search` accepts up to 100 characters (name/email
substring or exact Shopify customer ID). Its bounded cursor is tied to store,
installation generation and search hash. Suppressed rows are filtered before
serialization, with continuation over the last scanned row even if a page has
no visible results. No redacted-match count is returned. Historical owner
tombstones are grouped to bound returned results; active identities are queried
separately through their composite unique keys. Expired owner links still block
disclosure, matching the profile policy.

The additive `/{workspace}/shoppers` merchant page is linked from Customers,
Loyalty and Reviews. Its reusable React view receives a typed transport and
selection callback; the thin Weletic adapter owns workspace auth and Next
navigation. Both the outer workspace hook and inner customer queries disable
previous-data retention, preventing old-workspace PII during transitions.
English, Japanese and Vietnamese cover the shared view and known enum values.
The surrounding existing workspace shell is still English. Original merchant
content is not automatically translated. There is no embedded Shopify or
customer-account adapter yet, and legacy account-management routes remain for
compatibility.

## Evidence and outstanding work

- 58 focused service/query/route-contract and interactive React tests pass.
  This includes the actual workspace hook under the app-wide SWR cache defaults,
  pending workspace transitions, exact amounts, privacy continuation and errors.
  Service route tests use mocked storage/auth.
  These verify the wrapper configuration, not real authenticated HTTP/RBAC.
- Nine isolated MySQL tests pass using production profile/directory reads, Prisma
  transactions and the real privacy HMAC resolver. They cover reviews-only
  shoppers, cross-store identity, exact pending points, sequence pagination,
  hidden one-star review history, token exclusion, tombstones and reinstall
  cursors. Additional cases cover reviews-only discovery, scoped search cursors,
  empty suppressed-page continuation and 80 expired historical owner identities.
  Generated fixture stores and their records were cleaned up.
- The DB suite refuses any target other than the named loopback development
  database and restricted principal. It creates no shared schema or live store
  records. External fetch is forbidden. Minimal scalar-parent fixtures do not
  constitute a full commerce/review-submission journey or erasure-worker proof.
- Root formatting and root lint (10 tasks) pass. Independent
  review found the omitted pending-point delta; the exact projection and its
  regression now pass re-review. Directory review also corrected unbounded owner
  tombstone results and outer-workspace cache retention; final source review has
  no remaining actionable findings. The foundation-only full local Vitest run
  passed 4,184 tests, six skipped, 272 files. The first expanded run caught a
  formatter-removed React import; explicit runtime React usage now survives the
  formatter and all 58 focused tests pass again. The expanded full local suite
  passed 4,204 tests with six skips across 275 files before rebasing onto merged
  PR63. Range-diff confirms both implementation patches are unchanged after the
  rebase; 87 focused shopper/renewal checks and all nine MySQL tests passed again.
  Post-rebase web types also passed with the 8 GB heap limit. Shopify types/build
  and Prisma validation passed (existing relation-mode index warnings remain).
  A post-browser type-check exceeded Node's default 4 GB heap and passed with the
  repository build's 8 GB limit. The local production web build passed after
  rebase with synthetic provider settings and the guarded isolated database.
  Types/lint were checked separately before the repository's separate-validation
  build mode. Final-head CI remains required before merge.
- Actual local password-authenticated merchant browser reads passed for the
  directory and profile (HTTP 200, private/no-store); unauthenticated directory
  access returned 401, unknown workspace and unknown shopper requests returned 404. The auth wrapper's unknown-workspace 404 does not carry the service cache
  header. This is not a complete role matrix or live two-merchant test.
- Desktop and 390-pixel mobile profile screenshots show exact balances and
  Japanese/Vietnamese copy. Both mobile document widths equal viewport width (390).
  Artifacts are local under `output/playwright/shopper-browser/`. These use the
  actual isolated development server, not a production build or live Shopify.
  Browser search and the reviews-only overview passed. A final points-tab request
  overlapped fixture cleanup and returned the expected unavailable state; it is
  not counted as history acceptance. Browser fixture rows were removed, the
  isolated server was stopped, and the proof browser was closed.

Still implement embedded Shopify and customer-account UI consumers,
shared settings, consent/suppression history, broader communication
events and the other approved package 2/8 requirements. Store reviews, direct
review coupons and new journeys must extend the explicitly qualified coverage
as their authoritative records become available. Existing APIs are unchanged.
No deployment, queue activation, email or merchant configuration change occurred.

The subsequent [shopper fact-segment checkpoint](shopper-segments.md) adds
read-only commerce/loyalty filters with query-scoped cursors. It does not add
saved groups, audience enrollment or sending and is not full-package acceptance.
