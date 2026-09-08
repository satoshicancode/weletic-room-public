# Shopify shared settings — working checkpoint

Date: 2026-09-07. Approved unified plan packages 2 and 8. This is unfinished
local implementation, not a released Settings/Appearance interface.

## Intended delivery

- Reuse the shared merchant settings service and three-language editor behind
  authenticated Shopify staff gateways; never synthesize workspace ownership.
- Keep shared settings, appearance, loyalty and review operations mapped to
  their explicit permissions. A shared-settings grant cannot toggle modules.
- Preserve expected revisions and installation generations, independent module
  behavior, existing workspace authorization, pause semantics and financial gates.
- Use browser-safe response contracts, fresh authenticated writes/reads and
  private/no-store responses. Do not retry uncertain writes automatically.
- Complete transaction/permission races, gateway and UI tests, local browser
  evidence, full verification and approved release. Live app acceptance remains
  separate from compilation and synthetic evidence.

No new schema, provider configuration, shared DB rollout, store reconnection,
email send or module activation is authorized by this increment.

## Implemented so far

- The existing workspace writer still requires its owner role and active-store
  transaction. Both callers can share one internal update implementation.
- An internal transaction-level writer validates the saved revision, operational
  store fence and expected installation; it checks workspace/store agreement.
- The Shopify internal adapter explicitly authorizes `settings.configure` and
  shares that transaction for reads/writes. Strict input rejects caller workspace
  identity, role claims and module-transition fields.
- The signed Next POST gateway verifies the bounded actor/request body, then
  authorizes and writes in one Serializable transaction. The Remix POST adapter
  uses the existing fresh online authenticator and an eight-second signed
  transport deadline; errors are sanitized without automatic write retries.
- The browser client validates the explicit response projection and verifies the
  saved generation, next revision and changed fields. It uses fresh tokens,
  omits cookies, and returns no cached authority. UI wiring is recorded below.
- Fifteen focused adapter/API tests passed. Adapter authority is mocked in these
  tests; they do not prove signed ingress or actual staff authorization.
- Fifteen isolated MySQL settings tests passed, using production shared writers,
  including new caller-rollback and cross-workspace/stale-revision cases. External
  network access is forbidden by the test fixture. This is not live Shopify proof.
- The signed staff-gateway MySQL suite passed all 22 tests, including settings
  grant/replay/revoke behavior, tampering, failed-action receipt rollback and
  two competing expected-revision writes with exactly one winner. The latter
  uses concurrent promises, not an instrumented lock-wait barrier. The first run
  exposed a reused nonce in the new fixture; each separate grant now has its own
  nonce. Production replay rejection was preserved.
- Forty-four combined adapter/client/API tests passed. Actual signed gateway
  responses are also checked against the browser schema in the DB suite.
- Web type-check, focused lint and formatting passed. Independent read-only
  review found no blockers in the transaction extraction or permission adapter.
  Shopify type-check and build passed after the gateway/client additions.
  Independent follow-up review found no blockers. Full-suite/web-build/release
  verification remains pending for the finished feature.

## Remaining

### Review-module continuation

- Shopify review toggles require `reviews.configure`, independently of shared
  settings permission. They reuse the existing review writer in the signed
  caller transaction and return only the module projection.
- Existing policy, Judge.me writer exclusion, invitation cancellation and summary
  outbox behavior are preserved. Generation and saved timestamp checks reject
  stale changes; no automatic write retry was added.
- All 68 focused tests, 23 signed staff MySQL tests and 16 shared-settings MySQL
  tests passed. Rollback checks restore the complete settings row and exact
  original invitation token. Synthetic invitation references are not evidence of
  purchase validation. Web/Shopify types and focused lint passed.
- Independent read-only review found no blockers. A broad regression run passed
  4,662 tests with six existing skips, but source changed during that run, so it
  is not final exact-head release evidence.

### Loyalty-module continuation

- Extracted the existing normalized loyalty settings writer without duplicating
  financial settings, expiry anchors or immutable earn-policy publication. The
  workspace route retains validation, owner restrictions and error semantics.
- The signed Shopify operation requires `loyalty.configure`, expected status and
  installation generation. It cannot initialize a program or clear its kill
  switch. Browser acknowledgement contains only module state and is validated.
- All 155 focused API/adapter/client tests passed. The isolated MySQL suites
  passed 18 settings tests and 26 signed staff tests, covering exact retained
  valuation, expiry transitions, policy snapshots, rollback and separate grants.
- Web/Shopify types, focused lint and independent read-only review passed.
  The Customers merge initially exposed a missing partial privacy mock in the
  combined DB fixture; it and scoped shopper cleanup were restored before the
  successful 26-test run. No production privacy bypass was introduced.
- Customers PR #79 is merged at `625d33f0a8`; its post-merge CI passed. This
  settings branch includes that main revision. Full Settings release verification
  and live acceptance are still pending.

### Shared Settings UI continuation

- The Shopify Settings route now uses the existing shared EN/JA/VI editor with
  fresh App Bridge requests and a private, data-free installation bootstrap.
- Current staff grants produce explicit UI capability hints. Every mutation
  still authorizes independently. Branding changes through the combined settings
  operation additionally require `appearance.configure`; general configuration
  does not grant module or branding authority.
- Shared browser code no longer imports service types. The workspace read
  adapter validates the same response contract; its existing owner controls are
  preserved. Unconfigured loyalty cannot be activated by the module button.
- Cache keys are fresh per visit and settings are hidden during reauthorization.
  A screen-level synchronous write guard survives editor remounts. Denied or
  uncertain writes hide controls until an explicit fresh read succeeds; a
  background refresh cannot unblock them. These fix a review-discovered race.
- All 43 focused UI/adapter/client tests and 26 signed MySQL tests passed.
  Web/Shopify types, Shopify build, 12 bootstrap tests and focused lint passed.
  Follow-up independent review found no remaining blocker in the concurrency fix.
  Later local browser evidence is recorded below; live Shopify acceptance is
  still outstanding.

### Appearance-only access and local browser evidence

- Separate signed appearance operations require only `appearance.configure`.
  They reject general settings and module fields and return only branding,
  store identity and shared revision. The existing settings writer prevents
  silent overwrites between both screens. There is no second branding store.
- Appearance uses the same shared editor and mutation guard, displaying only
  brand name, public logo URL and accent color. It does not implement the
  remaining specialized widget-layout configuration from the full product plan.
- All 75 focused tests, 27 signed MySQL tests and 15 bootstrap tests passed.
  Appearance-only staff, rejected general-field writes, stale shared revisions
  and revoked grants are exercised against the signed production route.
- Web/Shopify types, Shopify build and repository lint passed. Whole-feature
  independent review found no actionable code blocker. The web production build
  passed with 362 static pages using the guarded isolated MySQL database. The
  full unit-suite rerun passed: 308 files, 4,760 tests and six existing skips.
- Local Chromium used the production shared component and browser client with
  synthetic tokens/HTTP responses; all nonlocal network requests were blocked.
  English appearance save and retained confirmation, Japanese rendering and
  Vietnamese 375px layout passed. Document width equals viewport width (375px),
  with exactly the three branding inputs. These do not prove an actual Shopify
  staff token exchange, provider delivery, deployment or `yamaxdev` acceptance.
- A synthetic 403 on save removed all form controls; explicit reload restored
  the saved name rather than the rejected draft. General Settings saved a UTC
  timezone through keyboard Tab/Enter with a visible solid 2px focus outline.
  The timezone remains stored-only. No delivery timing behavior was inferred.
- Expiry, VIP and bonus CLI validators passed in `mock` mode with zero failed
  or skipped checks. These are simulated evidence, not additional DB/live proof.
- The first full-unit run caught the initializer inventory's old writer path.
  Its narrow explicit-status exception now follows the extracted settings writer;
  all other initializers must still specify draft. The full rerun passed.

Final local checks also passed: 18 shared-settings MySQL tests, 27 signed staff
MySQL tests, configured repository formatting, focused CSS/CJS formatting,
Prisma validation and Shopify TypeScript/CommonJS lint. These are not a shared
schema rollout. Exact pushed-head CI remains required before merge.

CI release verification remains unfinished. Existing stored-only timezone,
consent and specialized-layout limitations remain explicit. No schema rollout,
live merchant setting change or external send was performed.
