# Scheduled Shopify renewal — work in progress

This is the next package 1 increment after the installed credential boundary in
PR #61. It is not release-ready or activated. The full unified completion plan
still governs acceptance; a working scheduler alone does not complete package 1.

## Implemented locally

- Disabled-by-default `WELETIC_SHOPIFY_RENEWAL_ENABLED` gate, requiring enforced
  cron authentication even in development. No scheduler configuration was added.
- Authenticated root cron dispatch with minute-scoped deduplication.
- App-level QStash jobs and the existing failed-publication recovery mechanism,
  independent of loyalty activation or financial maintenance modes.
- Stable store-ID pages of 100, with continuation based on scanned stores, not
  successful renewal. Due and missing offline sessions produce credential-free
  jobs; future and non-expiring sessions are skipped unless an open incident for
  the current generation needs reconciliation after interactive recovery.
- Deterministic app/time/cursor continuation deduplication, including recovery
  of deferred publication. Transport deduplication is not a credential fence.
- Original app/store/installation identity and a 15-minute job-age bound. The
  worker uses actual lifecycle locks and the installed-only SDK authority.
- Four-minute scan lead, inside the current SDK's five-minute refresh threshold.
  A healthy result means a usable credential was obtained, not necessarily that
  a new provider token was issued: a competing operation may already have done it.
- Generation-scoped `shopify_session_missing` incidents in the existing
  reconciliation table. Missing results require an unchanged original observation
  and absent current session under lifecycle/coordinator locks. Healthy results
  clear only an incident whose current SDK and installed credential match the
  response. No credentials, hashes or raw errors enter incident details.
- Workspace-authorized, private/no-store incident projection and an English
  notice in Weletic's Shopify integration settings. Missing, loading and request
  failure states are explicit; absence of an incident does not claim live health.
  Shopify-embedded and multilingual presentation remain broader package 8 work.
- Shop erasure deletes only these nonfinancial incidents under the final store
  lock. Financial reconciliation records remain subject to existing retention.

## Required before shipping this increment

1. Complete final validation and CI. Browser validation found and corrected the
   existing catalog-sync button's unsupported children usage: it now supplies the
   shared `Button`'s `text`/`icon` props and displays its accessible name. Do not
   count the entire settings UI as accepted based on these checks. PR #62 merged
   the per-attempt account and authenticated-origin fixture corrections at
   `5fe5205516`; Full Release run `34026729589` passed all 148 tests. Earlier
   failures exposed shared-account quota exhaustion and then a localhost versus
   app.localhost cookie-origin mismatch; neither application quota nor cookie
   policy was weakened. PR #61 merged at `14a3ea56f0` after release run
   `34027609239` passed all 148 tests on exact head `1a8ff67645`; this worker's
   own final-head CI remains required.
2. Validate scheduler timing/capacity and durable execution failure visibility
   before activation. Generic `Job` records retain failed publications, not
   completed execution history. Neither QStash credentials nor an active cron
   schedule are configured by this increment.
3. Separately approve activation and prove real renewal/reconnect on `yamaxdev`.
   Preserve the retained database and `n0pvef-cs`. Do not activate public endpoints,
   external sends or provider calls as part of a code merge.

Transient failures remain retryable; only positively established missing sessions
are reconnect candidates. SDK 500 responses do not prove invalid refresh tokens.
Non-expiring-token migration and definitive provider rejection handling need
explicit coverage before claiming complete token-lifecycle acceptance.

## Local draft evidence — 2026-09-06

- Full web Vitest suite passed: **4,194 passed, 6 skipped, 276 files**, including
  service, cron, actual job-adapter recovery, merchant projection and SSR notice
  tests. This excludes the separate integration-test configuration and is not
  evidence of live Shopify operation. The initial run caught a JSX runtime
  binding issue in the notice; the formatted correction passed the full rerun.
- **23 isolated MySQL session tests passed**, including concurrent incident
  creation, signed credential recovery, next-sweep/merchant-read composition and
  stale provider-result rejection. HTTP responses are controlled fixtures, but
  production Prisma transactions, locks and signed publication routes execute.
- Adversarial review cleared dispatch, incident ordering, tenant scoping and
  privacy cleanup. The recovered-session alert gap found during review was fixed
  and its production-boundary regression passed; re-review is clear.
- Web type-check passed using the repository's 8 GB memory setting. Root lint
  passed (10 tasks) and root `prettier-check` passed.
- Web production build passed (359 pages); Shopify build and type-check passed.
  Builds used synthetic provider configuration; web static generation used only
  the guarded isolated database. Independent types/lint passed before using the
  repository's separate-validation build mode.
- The subsequent catalog button correction passed focused lint and was confirmed
  in the real browser (`renewal-mobile-corrected.png`). The final web type-check
  and all 27 focused regression tests passed. A final production build including
  the presentation correction also passed (359 pages). CI proof is still required.
- After rebasing onto merged PR #61, range-diff confirmed all six local commits
  retained identical patches. Web type-check and 107 focused renewal, incident,
  dispatch, notice and compliance tests passed again; final adversarial review
  found no rebase drift. This does not substitute for final-head CI.
- Prisma validation passed with the explicit `prisma/schema` multi-file path.
  The isolated schema comparison passed without changes. Existing relation-mode
  index warnings remain; no schema migration was applied.
- Browser proof ran against the actual local development merchant page at port
  8890 with a synthetic password-authenticated account. Desktop and 390-pixel
  mobile screenshots showed the notice without horizontal overflow. The real
  authenticated health API returned `reconnect_required`; after resolving only
  the fixture incident and reloading, it returned `not_observed` and the notice
  disappeared. This validates presentation of durable state, not real Shopify
  token recovery (the separate MySQL tests exercise that controlled boundary).
- Unauthenticated health and unsigned renewal-cron requests returned 401; an
  authenticated request for an unknown workspace returned 404. This is not yet
  a live two-merchant cross-tenant acceptance test.
- The initial production localhost preview omitted isolated-routing flags and
  redirected repeatedly. Browser checks used the checked-in isolation flags in
  development mode; do not describe them as production-preview browser proof.
- Screenshots are retained locally under
  `output/playwright/renewal-browser/renewal-{desktop,mobile,resolved-mobile}.png`.
  Synthetic browser fixture rows were removed and port 8890 was stopped after
  validation. Temporary fixture/launcher scripts are ignored local artifacts.
- No schema migration, actual queue publication, scheduled activation, provider
  operation, live merchant-store mutation or real email occurred. Native tests
  created and removed only generated fixtures in the guarded isolated database.

## Activation isolation checks

The queue destination is built from `APP_DOMAIN_WITH_NGROK`, which prioritizes
`NEXT_PUBLIC_APP_DOMAIN`. The isolated configuration fixes that to port 8890 and
the SDK authority to port 3002. Its runtime allowlist does not permit the renewal
activation flag or QStash delivery configuration yet. A separate activation
preflight must verify both destinations and app identity; do not enable this
worker in an environment that falls back to retained/public default endpoints.
