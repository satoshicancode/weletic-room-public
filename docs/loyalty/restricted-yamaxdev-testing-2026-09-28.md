# Restricted yamaxdev testing — September 28, 2026

Approved Option A: [ADR 0047](../adr/0047-restricted-yamaxdev-testing.md).
Registration and the Shopify Support question remain deferred. This mode enables
feature testing without recording synthetic billing as verified subscription
acceptance. It adds no schema migration and requires no new paid resources.

## Runtime contract

Use the existing isolated preview launcher with a private mode-0600 core
configuration. Set `mode` to `restricted-development`, omit both plan handles,
and set `installationGeneration` to the current authenticated pending
installation UUID. Keep the remaining five identity/support keys from the
[preview packet](yamaxdev-core-preview-packet-2026-09-26.md).
Never copy secrets or authenticated session payloads into evidence.

The launcher pins public app `c7d49cebb06e445db345bb200f966a03`, Partner app
`419628580865`, shop `73236414690`, and authenticated domain
`montdev.myshopify.com` (admin alias yamaxdev). It requires development mode,
core-v1 scope and loopback SQL/Redis/media services. Reinstall requires a new
explicit generation pin. Setup-only and restricted development cannot coexist.

The backend verifies Shopify Admin identity and `partnerDevelopment`, records
`restricted_development` with no plan, and expires authority within five minutes.
Partner subscription lookup is not used while this mode is enabled. Entry and
scheduled reconciliation reuse existing refresh fencing. The embedded status
states that billing remains untested in EN/JA/VI. Production environment
validation rejects either restricted key, including malformed values.

First review claims on the canonical testing shop always require current
store-scoped authority, even after flags are removed or the snapshot is replaced
by an unavailable response. Other stores retain their existing invitation
settlement rules. Existing claims, ledger replays, refunds, reversals and privacy
work retain their recovery paths. Later product invitations for an already
promised order retain the same saved per-order policy; they do not create a
second participation award. No historical invitation generation is authorized.

## Local evidence

These are synthetic provider-boundary tests, not installed Shopify receipts:

- Eight isolated MySQL billing tests passed, including restricted identity
  provisioning, generation/expiry checks, removed-mode rejection after an
  unavailable refresh, profile changes, suspension, development-status loss and
  privacy rejection. Existing paid/private-free, stale refresh and reinstall
  regressions remain in the same suite.
- Fifty-five focused backend tests plus a first-claim/replay regression passed.
- Eight runtime/production-environment tests passed.
- All 335 Shopify UI tests passed with one worker. Earlier high-concurrency
  runs had worker startup timeouts and are not counted as successful runs.

The SQL schema was applied only to a newly created local disposable test
database. No shared or production schema was changed. Backend and Shopify type
checks, changed-backend lint, Shopify build and final adversarial review passed.
Release CI remains required before merge. The first backend type-check exceeded
Node’s default heap; the successful retry used an 8 GiB heap limit.

## Bounded installed identity verification

The temporary preview authenticated the canonical Shopify development shop with
real Admin API identity verification, mapped its current installation to the
isolated local store, and recorded a fresh `restricted_development` receipt.
The embedded Reviews page displayed the restricted-testing notice after reload,
explicitly stating that subscription billing remains unverified. No purchase,
redemption, invitation or participation claim was created during this check.
Extensions remained disabled. This is identity/provisioning evidence only.

App entry exposed a transient session-verification race. Subscription verification
now retries an unavailable response once with fresh SDK authentication; denied or
reauthentication responses do not retry, and repeated failure keeps access paused.
Five UI regressions cover the retry, bounds and cleanup. The initial root-loader
reauthentication recovery was manual and is not claimed as clean cold-start
acceptance. Sixty-four legacy review-provider tests passed after their transaction
fixtures were extended with the new store lookup.

Installed navigation also exposed VIP and expiry fields in the loyalty settings
form. The shared form now uses server-derived core scope to hide these controls
and omit them from both draft creation and updates. All 83 focused configuration
tests passed, including hidden-field write regressions. Installed navigation
confirmed the core-only form. Existing incompatible settings are preserved and
still cannot activate through the server guard.

## Installed customer journeys remain open

Before execution, record the merged source SHA, observed installation generation,
temporary ingress pair, exact test-payment fixtures and controlled recipients,
expected points/coupon/refund outcomes, extension identities, and cleanup.
Use only the canonical development shop and isolated services. Keep real billing,
public publication, spending and production activation outside this packet.
Local success cannot be reported as inbox, checkout, storefront or Flow acceptance.

## Installed purchase and refund evidence — September 28

Bounded run based on merged main `3ca4e21d3b2fd4be10d5b1da0c6e4323fb733eca`,
with the logging/customer-projection fixes in PR #181. The pinned installation
remained `26d58bff-ee10-4fcd-84d4-030a2e49ec87`. All application persistence
remained isolated on loopback; Shopify actions targeted only yamaxdev.

- Created one test product (`15381080834274`, variant `67555393339618`) at
  JPY 1,000, nonphysical, untaxed, inventory untracked, and one synthetic customer
  (`31242295345378`) with marketing consent off. Signed customer events created
  one active zero-balance loyalty account through the normal ingestion handler.
- Activated the core earning program: one point per JPY, zero holding delay,
  one-time purchases, per-event cap 2,000. Saved an active fixed JPY 500 reward
  costing 1,000 points; minimum order JPY 1,000, one use, one-day expiry.
- Test order **#1047** (`18912340574434`) used Shopify's Bogus gateway for
  2×JPY 1,000. Its signed paid event produced exactly one +2000 ledger entry.
  Two separate no-notification refunds of one item each produced one -1000
  reversal each. The order became fully refunded and account balance returned
  to zero. This does not prove coupon redemption or negative-balance acceptance.
- Activated the immutable 100-point participation policy before test order
  **#1048** (`18912358367458`), which paid JPY 1,000 through the test gateway and
  earned 1,000 points. Fulfilled only this second order, with customer notification
  off. The signed fulfillment event was retained as processed.
- Review defaults of seven-day delay, thirty-day validity, photos, manual publication and no
  reminders were observed. A temporary zero-day diagnostic was saved for the
  second fulfillment; seven days was restored afterward. No elapsed seven-day
  delivery acceptance is claimed.

The second fulfillment created **no invitation**: Shopify redacted the recipient
email, and an independent real Admin API request returned `This app is not
approved to use the email field`. No customer email was injected into local SQL.
Email-only development access is prepared in Partner Dashboard but requires
explicit access-expansion confirmation before saving. It does not require a
billing registration payment or App Store submission; production data review is
still separate. No external-inbox or installed submission/photo/moderation proof
is claimed by this run.

The first worker attempt exposed a blank optional referral link that made Shopify
reject the entire customer projection. The fix omits blank text and emits only
core balance/pending/lifetime/member-status fields in core-v1. Retrying the same
failed job succeeded; a separate Admin API read returned 2,000/0/2,000/active before
refunds. Existing remote VIP/referral values are preserved, not deleted. Twenty-five focused
sync/legacy tests, three telemetry tests, types, lint and independent review passed.
The type-check required an 8 GiB Node heap; the earlier default-heap failure is not
counted as a pass.

The points-earned Flow job is retained as dead-letter evidence: the extension is
absent from this development preview (`Invalid handle 'weletic-points-earned'`).
No workflow receipt or installed Flow acceptance is claimed. Two early product
webhook receipts failed during concurrent local full-catalog sync; subsequent
catalog and customer events processed. This is not persistent-runtime acceptance.

Remaining installed gates: authenticated shopper redemption and checkout use,
review email access and delivery, submission/photo/award/moderation/display,
actual Flow workflows, duplicate/crash recovery under the installed candidate,
and persistent operations. Billing registration and production remain deferred.
Private evidence is kept outside Git; no invitation tokens, credentials or
customer contact details are included here.

## Installed review progress and proxy-path defect — September 28

Hiro saved Email access; the real Admin API returned the expected synthetic
customer email after normal embedded session refresh. A genuine customers/update
webhook populated the isolated shopper record. The prior fulfilled payload had
already been cleared after processing, so the same test order #1048 was unfulfilled
and fulfilled again with customer notifications off. No new order or payment was
created. Its signed event created one request with the original immutable
100-point policy. A temporary zero-day diagnostic was restored to seven days;
thirty-day validity, manual publication, photos and no reminders remain.

The exact invitation job completed through local SMTP/MailHog. An initial private
CLI runner incorrectly selected React server conditions, which prevented template
rendering before dispatch; removing that runner flag allowed the same job to
complete. No external inbox delivery or seven-day elapsed timing is claimed.

The delivered link used `/apps/weletic`, but the Shopify installed-app settings
show `/apps/weletic-1`. The legacy app is preserved. Manually correcting the path
allowed real Shopify proxy authentication and a one-star text/photo submission.
It was verified-purchase, pending moderation, and awarded exactly 100 points.
The image was stored as WebP. Reopening the consumed invitation was rejected.
Merchant publication with a reply succeeded; hiding the synthetic review retained
the same single award and independently reconciled balance of 1,100 points.

The unmodified invitation journey is still defective. The implementation now
persists the strictly validated proxy path learned from any fresh signed Shopify
app-proxy GET, bound to app/store/installation generation. New delivery snapshots
require the current route, while existing encrypted snapshots remain immutable.
The additive record has a local-only migration; no shared DDL was applied.
Focused contract tests cover freshness, reinstall fencing, tenant identity and
retry preservation. The local slice passed 81 focused web tests, 8 Shopify
gateway tests, both type checks, lint, Prisma validation and the Shopify build.
Its updated nullable-generation DDL has not been applied: the available database
target was not confirmed as the isolated test database. The observer is bounded,
deduplicated and fire-and-forget so a backend outage cannot stall storefront
traffic. Installed preview re-test remains required before accepting the journey.
Published storefront display and installed photo deletion have not passed; no
claim is made from a blocked JSON navigation.
