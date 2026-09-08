# Shopify merchant loyalty analytics

Implementation checkpoint: 2026-09-09. This is a local implementation, not named
`yamaxdev` acceptance or a complete analytics release certificate.

## Boundary and contracts

- `/loyalty-analytics` uses a fresh App Bridge token for each request. The Remix
  action authenticates the merchant and signs the complete actor/request body.
- The internal analytics route verifies that signature, validates a bounded
  strict request, and authorizes the current installation/session/staff grant.
  Authorization and aggregate reads share a repeatable-read transaction.
- Reads require `analytics.read`. Exports require `analytics.export` and the
  current store owner, preserving the existing owner-only financial-export
  policy. Export requests also fence the installation generation.
- Neither request accepts a caller-selected store identifier. Every aggregate
  query uses the authenticated store. No shopper sample, code, email or customer
  identifier is projected into the screen or export.
- Replies are private/no-store. The client validates the response schema and
  filter/generation/download acknowledgement. Failed or stale requests do not
  leave the previous report presented as fresh data.

## Measurement semantics

- Balances, financial liability and VIP distribution are current snapshots;
  active-member counts use the existing 90-day activity definition.
- Point activity uses inclusive UTC date boundaries. Empty bounds mean all
  history in that direction. Earned-point totals explicitly include the existing
  backfill classification; backfills and corrections also appear separately.
- Reward and referral status tables group records created inside that range by
  their current status. They are status cohorts, not sequential funnel steps.
- Currency values are exact integer minor-unit strings, with the currency shown
  alongside the report. No browser numeric conversion or inferred exchange rate
  is used. Merchant-authored tier names remain unchanged.
- Unconfigured valuation returns null financial values, not a fabricated 1:1
  valuation. Referral currency-quality failures mask referral economics while
  preserving independently valid liability. The reason is retained in exports.
- VIP distribution now represents persisted assignments: unassigned accounts and
  references to unavailable tiers have explicit groups. It never assumes that a
  missing assignment means entry-tier enrollment.
- CSV and JSON export the same explicit aggregate snapshot. CSV text cells use
  the shared formula-injection defense. Null remains distinguishable from zero.

## Verification and remaining gates

Focused service, contract, action, core analytics and DOM tests cover permission
failure, store isolation, stale installation, large exact values, valuation
unavailability, CSV safety, EN/JA/VI, async error mapping, late responses and
edited date filters. Independent review findings were corrected with regressions.

Local verification checkpoint:

- Full unit run: 354 files passed, 5,509 tests passed and six skipped. The six
  route tests added after that run started passed separately.
- Latest screen/route regression run: two files and 13 tests passed.
- Web types/build, Shopify types/build, Prisma validation, lint and formatting
  passed. The Shopify build retains existing sourcemap/future-flag warnings.
- Local Chromium fixture renders the actual shared screen and Shopify stylesheet.
  EN/JA/VI mobile screenshots were inspected at 375px. Japanese and Vietnamese
  document widths remain 375px; tables overflow within their own focusable
  regions rather than widening the page. The exact large integer remains intact.
- Keyboard smoke check: Tab moved from the referral region to reward utilization;
  ArrowRight scrolled that focused region by 40px with a visible solid outline.
  This checks table access, not the entire keyboard acceptance matrix.
- Fixture store/installation identifiers were absent from the inspected DOM.
  A fixture JSON download completed; this is not provider-backed export evidence.
  The only browser console error on the current fixture origin was its missing
  favicon. Screenshots and downloaded fixture artifacts remain local, outside
  the public change set.

Named store SQL reconciliation, real signed browser journeys, full keyboard
acceptance and public-app scope acceptance remain outstanding. Existing cohort
analytics are not exposed by this screen yet, and this checkpoint does not
certify complete analytics coverage. No schema application, provider operation
or deployment is included.
