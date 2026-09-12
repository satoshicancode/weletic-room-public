# Three storefront nudges — implementation draft

Scope: L08, preserving R3 of the Smile benchmark. Build all three merchant editors
and shopper runtime, not configuration-only parity. No deployment or enablement.

## Current delivery status

The local draft implements all three localized preset-icon editors and the
shared signup/spending/reward-use runtime, including signed collection membership
lookup, exact cart eligibility, immutable wallet terms, and browser impression
coordination. Merchant writes are revision/generation fenced. All defaults remain
off. This is a functional increment, not a claim of complete Smile appearance
parity or live loyalty acceptance.

Focused and real local-browser evidence is recorded below. Shopify build/tests,
web lint, Prisma validation and supported-file formatting passed. The final
isolated Next build passed with zero fixture rows and temporary grant revocation.
Final full web tests passed: 402 files, 6,243 tests passed and six skipped. No PR has been published for
this draft. Uploaded icons/managed media, broader appearance parity, automatic
campaign prompts and named `yamaxdev` acceptance remain outstanding.

Deployment is separately gated: upgrade every strict snapshot reader/worker
before enabling producers of snapshots containing `exchangeType`. Old readers
reject that new field; reverting to them after issuance is not a safe rollback.
No shared schema change is included in this increment.

The remaining sections are chronological checkpoints. Their older "pending" or
"not implemented" statements describe that checkpoint, not the current state.

## Weletic defaults selected under delegated implementation authority

- All nudges off initially. EN/JA/VI plain-text title, description and CTA; use
  original Weletic icons/artwork. Spending supports points label/balance variables.
- Signup: first page for a new browser visitor, once per browser origin. No
  account identifiers in browser storage. No cross-device synchronization.
- Cart page only, not cart drawer. Reward usage precedes spending. Suppress
  reward usage when a discount is already applied. Exclude stored value and
  variable/incremental rewards. Require current eligibility, never infer it from
  stale cached balances; the existing redemption gateway remains authoritative.
- Cart impression/dismissal cooldown: 24 hours. Local storage plus browser Web
  Locks coordinates tabs; unavailable storage/locking suppresses optional nudges.
  No cookies or server-side customer impression records. Signup history persists
  until browser storage is cleared; the dismissal clock is local, not financial.
- Automatic campaign prompt is deferred explicitly, not silently implemented as
  a fourth nudge. Uploaded icon validation/managed media integration remains part
  of the complete editor scope; presets alone do not satisfy full appearance.

The 24-hour policy and browser coordination are Weletic choices, not observed
Smile behavior. Smile's exact dismissal timing remains unknown.

## Implementation and verification sequence

1. Shared strict policy/defaults and deterministic eligibility evaluator; test
   guest/member, cart page/drawer, affordability with exact integer strings,
   expired/used/unavailable artifacts and reward precedence.
2. Store metadata revision-fenced service and existing signed merchant gateway,
   shared localized editor. No new database tables or unauthenticated write API.
   Every write requires installation generation, revision and configure rights.
3. Project safe settings into the existing App Proxy response and integrate the
   actual shared theme runtime. Actions open login/rewards/wallet; no automatic
   redemption, discount application, tracking export or email.
4. Browser impression coordination, dismissal/focus restoration, EN/JA/VI at
   375px, loading/error/permission and storage-unavailable cases. Verify actual
   components, then isolated races, full gates and public CI. Named yamaxdev
   acceptance remains a separate live execution gate.

Initial checkpoint: strict policy/defaults and the actual shared theme asset's pure
eligibility selector are implemented locally. Fifty-one focused tests passed
(policy, selector and existing theme-asset regressions). The selector returns only
the nudge kind, never a customer identifier or redemption authority. Its explicit
`eligible` input still needs a current shopper-safe projection adapter; callers
must not infer product/VIP/subscription eligibility from points alone.

Focused policy lint passed. The first root-level JS lint command used a parser
too old for pre-existing optional chaining; rerunning from the Shopify package
with ECMAScript 2022 passed. No lint rules or CI configuration changed.

At this initial checkpoint, no merchant editor, runtime projection, impression
storage or live behavior was complete. Later editor evidence follows below.

Independent foundation review found no integration-independent blocker. It
identified missing DEL control-character rejection, now fixed, and requested
additional disabled-policy, malformed/unsafe-number points, missing projections,
unknown reward/channel and millisecond expiry tests. The corrected run passed
**59 tests across three files**; focused lint passed. A standalone contract
typecheck passed, not yet the full web/Shopify builds. None of these tests proves
that the future projection adapter supplies truthful eligibility or freshness.

## Settings and signed gateway checkpoint

Added strict read/save/acknowledgement contracts, an internal metadata service,
the signature-verified backend route, and Shopify authenticated action/client/API
route. Saves require current installation generation and revision, use existing
store → program locking, preserve unrelated metadata, and reject failed CAS
without retry. No initialization, activation, financial write or schema change.
Reads require `loyalty.read`; saves require `loyalty.configure`; capabilities
remain false for read-only staff. These are local routes, not deployed endpoints.

Independent source review found no blocker. Explicit configure/read-only tests
were added, and the sequence-overflow test now uses a current revision to avoid
passing merely because the snapshot was stale. The first route test run could
not load unbuilt shared packages (48 other tests passed); after building the four
local dependencies, **113 tests across eight files passed**, including actual
HMAC validation, sanitizer/ownership/fencing tests, the selector and existing
theme-asset regressions. Focused lint passed. Persistence/authorization boundaries
in this suite are mocked; real MySQL and live staff acceptance remain required.

Shopify typecheck and local build passed at this gateway checkpoint. The full web
typecheck subsequently passed. The full web build has not run for this draft.

## Merchant editor checkpoint — September 10, 19:30 JST

Implemented the shared editor and authenticated embedded page/navigation, with
all three nudge policies and EN/JA/VI content, explicit save/discard/reload,
default-copy restore without implicit enablement, preset icons, preview, and
localized unsaved-navigation/unload protection. Saves retain all policy/language
edits and require the current generation/revision. Same-tick duplicate submission
is suppressed. Uncertain, stale or cross-store acknowledgements preserve the
draft but disable further writes until explicit reload. No private identifiers
are rendered in the editor DOM.

Independent review identified missing pre-submit validation feedback and missing
content-language attributes. Both were corrected. Invalid drafts now name the
affected nudge, language and field; translated fields and preview content have
their own language attributes. Follow-up review found no new bounded blocker.

- **133 tests / 10 files passed**, covering contract, actual shared JS selector,
  mocked service/gateway, HMAC route, client/action, actual editor and mocked
  router navigation guard. Includes pending-save transport replacement, duplicate
  submits, permissions, ambiguous/stale acknowledgements and validation.
- Full web typecheck, Shopify typecheck/build and focused UI lint passed on
  public base `17500247a4` plus this local draft. These are not full release gates.
- Branch then fast-forwarded normally to public main `4eb83df57c` (PR #20),
  preserving every draft file; the same **133 tests passed again** on this base.
- Actual shared editor and Shopify CSS were exercised in a local browser with a
  synthetic in-memory transport at `127.0.0.1:4189`. At 375px, EN/JA/VI each had
  document scroll width 375px, matching content-language attributes, and no
  private fixture store/generation identifiers in the DOM. Keyboard Enter saved
  the synthetic draft and disabled Save afterward. A simulated ambiguous save
  preserved text, showed the sanitized error and disabled further saving.
- Browser fixture/artifacts remain outside the public repository under
  `/tmp/weletic-nudge-browser.qHjErm`. No Shopify, database or customer actions
  occurred. This bounded browser check does not prove full keyboard/screen-reader
  accessibility, real embedded navigation or shopper nudges.

**Still uncommitted and unpublished.** Current eligibility/freshness projection,
shopper display, impression/dismissal coordination, managed uploaded icons,
isolated database races, full release gates and named live acceptance remain
outstanding. No migration, deployment or enablement was performed.

## Public configuration and browser receipt checkpoint

The existing signed internal program response now includes `nudges`, containing
only the strict versioned presentation settings. Arbitrary program metadata is
not serialized. Missing/corrupt settings and inactive/kill-switched programs
project all-off defaults. Existing clients remain compatible with the additive
field; the widget does not render prompts from it yet.

The actual shared theme asset now contains `claimLoyaltyNudgeImpression`. It uses
an exclusive browser Web Lock and a fixed anonymous local-storage receipt with
only version, signup-seen and cart-impression timestamp. Both cart prompts share
the exact 24-hour cooldown. Signup history remains separate. Invalid clocks,
corrupt records, unavailable locks, throwing or silently discarded storage writes
suppress the optional prompt. It rechecks synchronous eligibility after acquiring
the lock; rendering must recheck again because a receipt grants no authority.

Evidence: **50 tests across three files passed** for the public projection,
existing program route (including new active/kill-switch projection cases), and
receipt helper. The earlier selector/receipt/theme-asset run passed 68 tests.
Focused JS and TypeScript lint passed. Independent review found no blocker in
this increment. Lock tests use an in-memory serial queue, not real cross-tab
browser locks. No runtime integration, deployment or store mutation is implied.

The combined current draft suite subsequently passed **183 tests / 13 files**.
Full web typecheck passed against public main `4eb83df57c` plus this draft after
local Prisma client generation (no database connection or schema application).
Prettier and `git diff --check` passed. Full build/CI/release gates remain pending.

Important next integration constraint: `customer.ts` currently computes catalog
`canRedeem` from participation and affordability. It is not sufficient evidence
for complete cart product/collection, minimum purchase, subscription, VIP, or
usage-limit eligibility. The adapter must establish those conditions rather than
rename `canRedeem` to `eligible`. Suspended/unapproved stores must also fail
closed when constructing the active runtime context. These remain implementation
tasks, not waived acceptance requirements.

## Signup runtime checkpoint — September 10

The actual widget now displays the first-visit signup prompt from the public
configuration response. It uses localized text nodes and preset glyphs, does not
take focus, opens the existing drawer on CTA, supports dismissal/Escape with
focus restoration, and removes the prompt on drawer opening or controller
destruction. A separate anonymous first-page marker prevents a disabled first
page from becoming a later signup impression. No customer identity is stored.
Missing/malformed login attributes are unknown, not treated as logged out.

The program response now additionally suppresses nudge configuration unless the
store is approved/active, compliance-active, not uninstalled/redacted, and has an
installation generation. This changes only nudge presentation gating; it is not
a claim that all legacy public program fields gained the same lifecycle gate.

**93 tests across four files passed**: actual shared/widget code in happy-dom,
mock browser locks, receipt helper, existing theme regressions and program route.
Coverage includes EN/JA/VI signup, CTA without writes, dismissal/focus, repeat
pages, disabled/hidden/member/unknown-auth suppression, and destruction while
waiting for either lock. Independent review caught the unknown-auth adapter gap;
it was fixed and re-reviewed with no new blocker. CSS now bounds prompt width
and height, but real browser mobile/long-copy/cross-tab acceptance remains open.
Full web typecheck, focused JS/TypeScript lint, Prettier and diff whitespace
checks passed after the final fixes. Full build and CI have not run for this
runtime increment.

This is **signup integration only**, not completion of all three nudges. Points
spending and reward usage still require full cart eligibility and runtime wiring.
Uploaded icons, complete appearance controls, live store acceptance and release
gates remain outstanding. Everything remains local/unpublished; no deployment or
Shopify transaction occurred.

## Real local browser checkpoint — September 10, 19:46 JST

Loaded the actual shared/widget JS and stylesheet in headed Chromium at
`127.0.0.1:4190`, with an explicitly synthetic program response. No Shopify or
database requests were made. Fixture and screenshot remain outside the repository
at `/tmp/weletic-nudge-runtime.974XBO`.

- At 375×667, EN/JA/VI with 100-character titles and 300-character descriptions
  had document width 375px. Prompt bounds were left 39/right 359/bottom 567;
  top was 171px (EN/VI) and 127.5px (JA). No automatic focus capture occurred.
  The Vietnamese screenshot was inspected: text wraps and both buttons remain
  inside the prompt, above the launcher. This fixture uses synthetic repeated
  copy; it does not establish editorial quality or all possible theme styling.
- Two real same-origin tabs concurrently invoked the actual cart-impression
  helper with browser Web Locks and localStorage. Results were `[true, false]`:
  one claim won. Eligibility was explicitly synthetic `true`; **this is not
  cart eligibility or member-nudge rendering acceptance**.
- A second page did not display another signup prompt. Keyboard Escape dismissed
  the visible prompt and returned focus to the launcher. Reload followed by a
  bounded settling wait still showed zero signup prompts.
- The only console resource error was the fixture's missing favicon (404).

This closes the bounded real-browser coordination/layout evidence gap for this
fixture, not full storefront/live acceptance. Storage-restricted browsers, all
short viewport sizes, theme interactions, member policies and live Shopify
installations remain separate acceptance work.

## Member-policy projection prerequisite

Customer summaries now expose validated `purchasePolicy` on catalog rewards and
inside wallet `termsSnapshot`. Catalog policy comes from the current provisionable
definition; wallet policy comes from the existing ownership-validated immutable
standard/referral issuance snapshot, never the current definition. Missing policy
in older supported snapshots retains the existing one-time default. Invalid
snapshot handling remains unavailable rather than borrowing current terms.

The focused customer/tier-one suite passed **105 tests**. Added assertions prove
that a standard issued reward keeps both/first-three-payments and a referral
reward keeps subscription/first-payment while the current catalog remains
one-time. The customer suite passed again after the referral assertion. Full web
typecheck and focused lint passed for the implementation. This additive read DTO
change does not modify snapshots, redemption writers, database schema or policy.
Shopify typecheck also passed. Independent source review found no blocker and
confirmed the historical default matches existing discount provisioning. Explicit
old-snapshot omission fixtures remain an additional regression test to add; the
current assertions cover distinct modern standard and referral issuance policies.

Inspection also clarified that `usageLimitPerCustomer` configures Shopify usage
of each issued discount; it must not be reinterpreted as a lifetime cap on the
number of loyalty redemptions. Cart-use restrictions and reward issuance remain
separate checks. Member nudge cart matching and rendering are still unfinished.

## Cart input prerequisite

Added `normalizeLoyaltyNudgeCart` and `loadLoyaltyNudgeCart` to the actual shared
theme asset. The loader accepts only relative locale-root paths, uses GET with
same-origin credentials/no-store through the existing bounded fetch helper, and
suppresses aborted, failed or malformed reads. It is not wired into the widget
yet and does not mutate the cart.

Normalized input contains currency, exact integer amount strings with explicit
`shopify_cart_integer` unit, discount-presence flag, and bounded line facts
(product/variant IDs, quantity, amount, purchase kind, shipping/gift-card/remote
flags). It excludes cart tokens, notes, attributes, line keys, discount codes and
free-form properties. Unsafe numeric inputs and inconsistent item counts fail
closed. A selling plan identifies a subscription line, not a proven renewal
sequence. Collections and checkout eligibility still need separate evidence.

Reference checked September 10: Shopify's [Cart API](https://shopify.dev/docs/api/ajax/reference/cart)
documents locale-aware cart reads and presentment-currency amounts. The [Liquid
cart reference](https://shopify.dev/docs/api/liquid/objects/cart) also documents
special scaling for currencies without subunits. No direct comparison with
ledger minor units or exchange-rate assumption has been introduced: that
conversion remains an explicit eligibility-adapter requirement.

The first normalization/selector/theme suite passed 72 tests; adding transport
tests brought the focused run to **80 tests / three files**. Transport is mocked.
No real cart read or complete member-nudge eligibility is claimed.

Review identified malformed explicit `remote` flags being interpreted as local;
these now fail closed while omission retains the documented local default.
Additional variant/error tests brought the suite to **87 tests / three files**,
including HTTP failure, invalid JSON and actual AbortController cancellation.
The subsequent timeout-triggered cancellation fixture also passed, bringing the
run to **88 tests / three files**. It uses the real AbortController with a mocked
transport and fake timer advancement, and verifies timer cleanup. Real cart
transport remains outstanding. Full web typecheck and focused lint passed for
the implementation and final fixtures. Independent
re-review confirmed the remote fix. No monetary conversion or eligibility
shortcut was added.

## Cart matching and monetary prerequisites

Added shared theme helpers for same-line purchase/resource matching and exact
minimum-spend comparison. Product, variant and caller-proven collection scopes
are validated; remote, gift-card and malformed lines cannot qualify. Shipping
rewards require a matching shipping line. Subscription cadence is not inferred
from a selling plan, and these helpers are not a complete eligibility decision.

Review caught an initial whole-cart subtotal comparison. The corrected minimum
sums only matching lines: a $1 eligible item plus $99 unrelated items cannot
satisfy a $100 targeted minimum. This follows Shopify's documented
[targeted discount requirements](https://help.shopify.com/en/manual/discounts/discount-types/percentage-fixed-amount).
Regression tests cover product/collection and purchase-type intersections.

Public program and ownership-validated wallet terms now expose currency precision
from the existing backend money convention. Wallet precision uses the immutable
issuance currency. The adapter compares exact integers for supported zero- and
two-decimal mappings; unverified precision and mismatched currency fail closed.
No schema, financial writer or policy changes were made.

The focused customer/public-program/cart/matching/selector run passed **132 tests
/ five files**. Full web typecheck and focused TypeScript lint passed. Independent
re-review found no remaining blocker in this bounded helper/DTO change. These are
local tests, not live Shopify acceptance.

The combined nudge and customer/public-program suite subsequently passed **259
tests / 16 files**. `git diff --check` passed. The root ESLint invocation initially
used an older JavaScript parser default and rejected existing modern syntax;
theme assets require explicit ECMAScript 2022 script parser options.

Still outstanding before member nudges can be enabled: trusted collection
membership, immutable wallet resource/exchange-type provenance, complete
eligibility composition, widget rendering, and real cart/browser acceptance.
The feature remains uncommitted and unpublished; default policies remain off.

## Catalog eligibility composition

Added `loyaltyCatalogNudgeEligible` to compose current catalog `canRedeem`, fixed
exchange type, online channel, supported discount type, strict purchase-policy
shape, active program, proven currency/minimum and absence of applied discounts.
The selector still independently checks exact points affordability. This is a
presentation hint only, not redemption authorization, wallet eligibility or a
renewal-order classifier. All supported native cadences allow the initial cart
purchase; no renewal sequence is inferred from a selling plan.

Independent review found a free-shipping minimum defect: matching digital items
were excluded from the subtotal. Minimum evaluation now separately requires a
matching shippable line, then sums all otherwise matching merchandise. Mixed
physical/digital and digital-only regressions cover the correction. Re-review
found no remaining blocker in this bounded fix.

The combined suite passed **278 tests / 16 files**, full web typecheck passed,
and focused JavaScript/TypeScript lint passed. Transport and cart fixtures remain
synthetic. The helper is not yet connected to the member widget, and no live
acceptance, deployment, publication or policy enablement occurred.

## Member spending widget integration

The actual widget now reads the signed customer summary and locale-root cart
on an explicitly identified cart page when the spending policy is enabled.
The theme embed supplies escaped page type and locale root, with no shopper
identifier. Catalog eligibility and exact balance checks feed the existing
impression lock. Localized templates are rendered as text; the CTA opens the
existing drawer without issuing or applying a reward.

Authentication errors, account/program denial, changed summary epoch, disposal,
hidden document/launcher and failed cart reads suppress the prompt. Input,
change, submit, external click, cart-update and visibility events invalidate it
before and after the asynchronous impression claim. Review caught click-only
Ajax controls missing from this invalidation and the correction is tested.
Read freshness is bounded to ten seconds, including visible lifetime; expiry
returns focus to the launcher if focus was inside the prompt. This conservative
technical freshness limit is a Weletic choice, not observed Smile behavior.

The combined suite passed **287 tests / 16 files**; the subsequent expiry/focus
regression brought the widget suite to **26 passing tests**. Full web typecheck
passed. Independent review found no remaining blocker in this bounded change.
Tests execute actual assets with synthetic HTTP and cart fixtures; these do not
prove live Shopify behavior or member browser/mobile acceptance.

Still outstanding: real browser member checks, delayed member-fetch coverage,
trusted collection membership (currently suppressed), wallet resource and
exchange provenance, reward-usage rendering and precedence, database races,
full builds and publication. All default nudge policies remain disabled.

## Delayed reads and member browser checkpoint

Four delayed-customer regressions now cover disposal, cart input, changed login
presentation and drawer opening before the response completes. Each suppresses
the prompt without writing the daily impression receipt. The actual widget suite
passed **30 tests**; full web typecheck and focused test lint passed.

Real Chromium ran the current shared/widget assets and CSS against synthetic
customer/program/cart responses at **375 × 667**. EN/JA/VI used deliberately long
original sample copy (not final member journey copy). Inspected screenshots show
wrapped content and visible controls with no horizontal overflow: document width
375, prompt left 39/right 359/bottom 567; top 177 in EN/VI and 132 in JA.
Keyboard focus plus Enter opened the drawer and removed the prompt in all three
locales. Local fixture and screenshots are outside the public repository at
`/tmp/weletic-nudge-runtime.974XBO`; no shopper data or Shopify traffic was used.

This closes the bounded delayed-read and mobile member-prompt checks, not full
shopper-surface acceptance. Real cart transport, actual merchant copy, collection
membership, wallet usage/precedence and live lifecycle evidence remain pending.

## Issued exchange-type provenance prerequisite

Shopify embedded typecheck and build passed for the member-widget integration.
The standard redemption provisioning snapshot now optionally records the actual
fixed/incremental exchange type and includes it in the content digest. Missing
legacy values remain absent/unknown, never defaulted to fixed. The owned customer
wallet projects this value or null; referral provenance was added in the later
checkpoint below. No resource identifiers were added at this checkpoint
to the wallet DTO, and no database migration was introduced.

New regression tests cover both exchange types, tampering, removal and continued
legacy parsing. The financial-definition, saga, adversarial saga, shopper-coupon
and customer suites passed **114 tests / five files**. Focused lint passed.
Independent review found no code blocker and separately passed ten financial
definition tests. These suites are local; they do not prove MySQL races or live
Shopify issuance.

**Mandatory release ordering:** old strict snapshot readers reject the new field.
Upgrade all readers before allowing new-format production, or stop/drain writers
for a coordinated reader/producer rollout. Do not roll back to old readers after
new snapshots exist. No rollout was executed. Review-incentive coupon promises
that omit exchange type continue to produce unknown provenance; do not change
them or infer fixed exchange as part of this loyalty-only stream.

## Owned wallet eligibility projection

The authenticated wallet terms now additionally project original product,
variant and collection identifiers and activation time from the validated
issuance snapshot. This deliberately extends the earlier count-only projection
with merchandise IDs already present in catalog contracts, not shopper IDs,
customer-selection digests, content digests or ownership proofs. Invalid or
cross-owner snapshots still yield unavailable terms. Tests verify standard and
referral merchandise scopes come from issuance, not current reward definitions.

`loyaltyWalletNudgeEligible` now checks available discount-code status, supported
immutable fixed exchange, consistent channel/type, issued and activation times,
expiry, original currency/minimum/purchase/targeting terms and discount absence.
It does not require spendable points or current catalog redeemability: issuance
and spending admission remain separate. Shared discount matching was extracted
without adding synthetic affordability inputs. Unknown legacy exchange
types remain suppressed. Collection matching still needs caller-proven membership.

The customer/matching/selector suite passed **101 tests / three files**. Independent
review found no blocker in the bounded projection and predicate. Widget integration
must still enforce fresh authenticated state and use existing safe wallet
navigation; this predicate does not validate or navigate `applyUrl`. No wallet
prompt, live issuance, deployment or external write is claimed by these tests.

## Reward-use widget integration

The member widget now selects between spending and reward-use prompts using the
same fresh signed customer/cart reads and anonymous daily impression lock.
Eligible issued rewards take priority; used/unavailable rewards allow spending
fallback. Wallet prompts do not require spendable points. Their CTA explicitly
opens the home wallet in the existing drawer without applying a discount or
following an artifact URL.

EN/JA/VI runtime tests cover priority and read-only wallet navigation, plus
zero-point wallet access and used-reward fallback. Review caught visible coupon
expiry: the prompt now expires at the earlier of cart freshness and qualifying
coupon expiry. Final qualification and deadline calculation share one timestamp
before rendering; queued-lock expiry suppresses the prompt without a receipt.
Re-review found no remaining blocker in this bounded integration.

The combined suite passed **318 tests / 16 files**, full web typecheck and focused
lint passed. The final expiry-boundary correction passed the **37-test widget
suite** again. All HTTP/cart inputs remain synthetic. Real reward-use browser
acceptance, collection membership, remaining database races,
complete quality gates and publication are still outstanding. No live mutation
or deployment occurred, and nudge defaults remain disabled.

## Full quality-gate run in progress

Full web lint passed with zero warnings, and the Shopify package unit suite
passed **27 tests**. The full sequential web unit suite and Next production build
were started against this worktree and remain pending at this checkpoint. Logs:
`/tmp/weletic-nudges-full-web-suite.log` and
`/tmp/weletic-nudges-full-web-build.log`. Do not count either as passed until its
process exits successfully. The web unit configuration explicitly excludes
integration/performance files; these runs cannot replace isolated database races.

No dependency upgrades, environment credentials, schema application, deployment
or publication were introduced to run these checks.

The dedicated nudge database test/configuration is now drafted and linted. It
refuses any target except the named isolated `127.0.0.1:3307` fixture and verifies
server UUID, database and principal before seeding. Cases cover competing
revision saves, foreign-store revisions and generation change rejection, with
exact fixture-parent cleanup and no external fetches. These tests have **not yet
run**; the fresh fixture schema and temporary-grant runner are still to be set up.
Do not use this scaffold as database acceptance evidence.

### Completed full-suite and isolated SQL checkpoint

The full sequential web suite exited successfully: **398 files, 6,185 passing
tests and six skipped**. The skipped tests are not acceptance evidence. The
initial production build compiled and completed type validation but failed page
data collection because `DATABASE_URL` was absent; it is not a passing build.

The new isolated fixture `weletic_loyalty_it_nudges_20260910a` was created with
schema-only table copies on the approved localhost MySQL instance. All **three
nudge database tests passed** using real transactions. Independent SQL checks
verified zero remaining rows in Project, Program, WeleticShopifyStore,
WeleticLoyaltyProgram and ProgramEnrollment, and the temporary data privileges
were revoked. Source/legacy/production records were not modified.

Evidence limits: the generation case proves rejection after the lifecycle writer
commits, not that the save was observably queued on its lock; table copies do not
prove foreign-key/migration acceptance. Authentication is separately tested by
gateway contracts, not by these SQL tests. The reviewed runner lives outside the
public repository at `/tmp/weletic-run-nudge-db.mjs`; test log is
`/tmp/weletic-nudge-db.log`.

A production-build retry is now running with SELECT-only access to this empty
fixture. It must finish and revoke the temporary grant before its result is
accepted. Log: `/tmp/weletic-nudge-isolated-build.log`.

### Reward-use browser checkpoint

Real Chromium at 375 × 667 verified the current reward-use runtime with synthetic
issued-coupon and affordable-catalog responses together. In EN/JA/VI the wallet
prompt won priority, and keyboard Enter opened the existing wallet containing
the fixture reward. Recorded application requests were only program/customer/cart
GETs, with no discount navigation or mutation. Inspected screenshots showed
visible controls and document width 375: prompt left 39/right 359/bottom 567,
top 384/372/363 respectively. Copy was original localized fixture text, not a
live merchant configuration. Screenshots remain outside the repository under
`/tmp/weletic-nudge-runtime.974XBO/wallet-{en,ja,vi}.png`.

All changed supported code/documentation files also passed Prettier check.
The isolated production-build retry remains pending; browser evidence does not
close live-store, collection-membership or publication gates.

### Build completion and referral provenance

The isolated Next build exited successfully, including static page generation.
The runner revoked its temporary SELECT privilege and independently confirmed
the five fixture tables remained empty. This build started before the subsequent
referral-provenance edit; rerun final validation on the publication candidate.

Referral coupon snapshots now optionally preserve fixed/incremental exchange
provenance with digest coverage, matching standard issuance. Newly qualified
coupons project that owned immutable value to the wallet. Legacy omission remains
unknown; no backfill or inference from today's reward definition occurs.
Tests cover both values, removal/tampering, invalid values, legacy omission and
customer projection. The financial/referral/friend-claim/privacy/customer suites
passed **69 tests / five files**, and focused lint passed.

The same strict-reader rollout gate applies to referral snapshots: upgrade
all readers, including referral outbox workers, before new producers, and do not roll back to an old reader after new
snapshots exist. No rollout, real qualification or email was performed.
Independent review confirmed actual referral creators preserve the field and
privacy cleanup removes the full snapshot. No blocking code finding remained.

### Fresh typecheck correction and collection-read investigation

The non-incremental typecheck found TS2339 in the SQL test's filtered rejected
promise result. An explicit status guard now narrows the result before inspecting
its error. All three isolated SQL tests passed again, with five-table zero-row
reconciliation and privilege revocation. Application behavior was unchanged.
The follow-up web typecheck completed successfully (session 82838, exit 0).

The existing internal catalog route is synchronization/status, not a shopper
membership reader; do not repurpose its POST operation for cart nudges. Shopify's
[Admin product query](https://shopify.dev/docs/api/admin-graphql/latest/queries/product)
documents `inCollection(id:)`, suitable for exact targeted membership checks.
The remaining implementation needs a bounded authenticated read, with requested
product IDs validated and collection scope derived from the owned current/issued
reward terms, not unrestricted client-provided collections. Use GraphQL variables,
strict response identity/boolean validation, current installation admission and
post-read generation checks. Unknown membership must continue to suppress hints.
No live GraphQL request or new endpoint has been implemented by this investigation.

### Bounded collection-query contract

Added a pure query builder and response parser, not yet connected to a transport.
Product and collection IDs are typed canonical Shopify GIDs and passed through
GraphQL variables. Raw input is capped at 50 products and 20 collections; the
deduplicated cross product is capped at 100 membership checks. Partial GraphQL
errors, missing products, mismatched product identities and non-boolean membership
values reject the entire result. Fifteen focused tests and focused ESLint passed;
the two new files were formatted. These checks do not prove live Shopify access.

Next integration remains the authenticated reader, server-derived reward scope,
installation-generation recheck, and cart runtime wiring. Collection-scoped nudges
remain fail-closed. No endpoint, credentials, deployment or store mutation was
introduced. The complete draft still requires final candidate validation and
review before publication.

### Generation-bound collection reader (internal draft)

Added the server-side reader around the bounded query contract. It validates
products before I/O, requires active approved/non-redacted/non-uninstalled store
and active non-killed program, and derives collection IDs from the authenticated
shopper's affordable catalog rewards and original available-wallet terms. It
requests generation-bound credentials from the existing signed token authority,
requires product-read scope, performs one bounded direct GraphQL read without
fallback/retry, and discards results if store admission, installation generation,
domain, program identity or program update timestamp changes.

Review caught a side effect in the existing summary: referral identity provisioning.
An internal `provisionReferralIdentity: false` option now suppresses both referral
link and code producers for this reader. Existing callers retain their behavior.
The actual summary test checks the producers are not called with an active offer;
the reader tests also check it requests this read-only mode.

Verification: 28 query/reader tests passed, focused reader/customer ESLint passed,
and the web typecheck passed after correcting the wallet DTO field to
`termsSnapshot`. The initial combined reader/customer run passed 31 tests before
four additional reader cases were added. No live request was made: transports and
database reads were mocked. Route authorization, browser wiring, final candidate
verification, and live evidence are still outstanding; this is not a completed
collection-nudge feature or a published change.

Independent follow-up review found no remaining blocker in the internal helper
and independently passed all three focused suites (50 tests). The strengthened
real-summary test also passed with an explicit non-null active referral offer.
This review does not cover an endpoint or runtime integration, neither of which
has been added for membership lookup yet.

### Signed collection lookup and cart runtime integration

The draft now includes `GET customer/nudge-collections` through the existing
authenticated Shopify App Proxy and signed internal gateway. Only the verified
shopper ID and up to 50 numeric product IDs are forwarded; caller customer IDs
and collection scope are not trusted. The backend resolves persisted canonical
store/alias records without invoking the older credential-verifying resolver,
rejects ambiguous aliases, and uses the generation-bound reader above. Responses
are private/no-store and upstream error text is not returned.

Lookup budgets are 10 requests/minute per shopper and 60/minute per store, using
purpose-separated privacy digests in the existing Redis limiter. Limiter failure
or timeout suppresses lookup, rather than bypassing the limit. This adds the
`nudge_membership` digest purpose, not a new identity or authorization model.

The cart runtime requests membership only when collection-scoped terms exist,
validates the complete product-key/collection-ID response, and passes verified
membership into spending, wallet-priority, and final coupon-expiry checks. A late
response after cart invalidation cannot consume an impression or show a prompt.
Unknown/malformed/nonmatching membership remains unavailable.

Verification at this checkpoint: 90 focused route/proxy/reader/query/widget tests
passed; the subsequently strengthened widget suite passed all 45 tests (including
wallet priority and late cart invalidation). Focused lint, Shopify typecheck, and
the first web route typecheck passed. The final web typecheck also passed (session
4069, exit 0). Independent follow-up review found no remaining blocker and passed
63 route/proxy/widget tests. Transport
and DB evidence remains synthetic: no Shopify calls, deployments, orders,
redemptions, emails or production changes were performed. Browser/live acceptance
and full final-candidate verification remain outstanding.

### Real Chromium collection checkpoint

The actual shared theme JS/CSS passed a local Chromium fixture in EN/JA/VI at
375 × 667. Collection-qualified wallet prompts had x=39, width=320 and bottom=567
in each language (top=384/372/363 respectively); document width stayed 375.
Keyboard focus plus Enter opened the existing wallet and removed the prompt in
all three languages. Unknown membership produced no prompt and no impression
receipt. Screenshots were visually inspected and remain outside the repository
under `/tmp/weletic-nudge-runtime.974XBO/collection-{en,ja,vi}.png`.

Each run made four synthetic GETs only: program, customer, local cart and collection
membership. There was no discount navigation, redemption, live GraphQL request or
real customer data. The fixture uses original localized sample copy, not saved
merchant configuration. The fixture browser and local server were closed after
inspection. This proves bounded browser integration, not live store acceptance.

Final candidate checks are running independently: full web unit suite, isolated
SELECT-only Next build, Shopify build/unit suite, Prisma validation and full lint.
Do not reuse earlier checkpoint build/unit counts as the result of this candidate.

Candidate results so far: Shopify build passed and all 27 Shopify unit tests
passed; Prisma validation passed with existing relation-mode/index warnings;
full web lint passed with zero warnings; all supported changed files passed
Prettier. Liquid has no configured Prettier parser and was excluded using
`--ignore-unknown`, not reported as formatted. `git diff --check` passed.
The first Prisma command lacked the repository-specific `--schema prisma/schema`
argument and failed before validation; the corrected command is the successful
evidence. Full web unit tests and the isolated Next build remain pending in
sessions 62629 and 65919 respectively. The Next build has compiled successfully;
its overall success and automatic fixture grant revocation are not yet proven.

### Final isolated build and database results

The final Next build completed successfully (session 65919, exit 0), including
compilation, type/lint validation, page generation and output tracing. The runner
verified zero rows in all five fixture tables and revoked its temporary SELECT
grant. The final isolated nudge SQL suite then passed all three tests again
(session 30845, exit 0); its temporary write grant was also revoked, with all five
tables empty afterward. This is isolated schema evidence only, not a shared or
live-store schema application. Full web unit session 62629 is still running.

### Final full-suite result

Session 62629 completed with exit 0: 402 files passed, 6,243 tests passed and six
skipped (6,249 total), in 569.15 seconds. The unit config excludes separate
integration/performance suites; neither skipped tests nor synthetic workloads
constitute live acceptance. This is the final candidate's full-suite evidence,
superseding the earlier 6,185-test checkpoint. All planned local checks have now
passed; public PR CI and deployment/live gates remain outstanding.
