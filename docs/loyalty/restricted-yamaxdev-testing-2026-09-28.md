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
