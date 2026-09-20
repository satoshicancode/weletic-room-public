# Customer-account Reviews implementation

## Scope and current state — September 20, 2026

R03 follow-up to the merged signed customer-account gateways in PR #98.
Work is on `codex/review-customer-account-ui`, separate from private-media
export [PR #99](https://github.com/satoshicancode/weletic-room-public/pull/99),
merged as `6720371a2a03d5651b1962e4dd9802c3f534cc16` after both latest-head
workflows passed all six checks. Local main was synced while preserving the
pre-existing acceptance-matrix edits. Post-merge run `35517477606` passed.
This account UI is an unfinished implementation, not live acceptance.

The account interface must work without Loyalty enrollment or a successful
Loyalty summary response. Use the existing Shopify customer-account session
token and signed review gateway. Open submissions are always disclosed as
unverified and unrewarded; product context never establishes purchase proof.
No schema changes, new scopes, public write endpoint or deployment are planned.

## Implemented draft

- Account client validates prepared policy, original author binding and exact
  product identity; it rejects rewarded/verified or malformed preparation.
- Submission snapshots remain only in memory. Concurrent clicks share one
  request; retry reuses the original submission/upload IDs and bytes. Confirmed
  uploads are not uploaded again after a lost submission reply.
- Every HTTP request obtains a fresh session token. No automatic mutation retry,
  redirects or persistent credential/draft storage. Responses are bounded to
  8 KiB; private server messages are not shown to the shopper.
- Input and photo limits match the existing gateway. Low ratings are valid.
- Added a real Preact text-review form with EN/JA/VI disclosure, consent,
  validation, confirmed receipt and immutable retry states. Module routing does
  not call Loyalty endpoints for the Reviews view. Account photo controls remain
  unavailable and disclosed; this does not close the photo requirement.
- Public extension staging includes the new source dependencies. The existing
  entry point owns endpoint rewriting; the review component has no hardcoded
  origin and inherits no custom-app UID.
- Independent review found and corrected three navigation races: losing an
  unresolved operation on module switch, carrying consent/draft to another
  product, and failing to prepare the destination after an in-flight submission
  resolves. Root-level pending ownership keeps recovery mounted; product changes
  reset idle drafts; a prior-product receipt is distinguished from the new form.
  Re-review found no remaining blocker in these corrections.
- All 306 Shopify tests passed across 15 files, including 29 review-client tests,
  15 actual-component tests and an offline public-stage bundle test. Shopify
  TypeScript, focused ESLint, Prettier and Remix production build passed on the
  final picker-fix snapshot. Five isolated public-extension staging tests passed. These use mocked
  transports/DOM components, not an installed Shopify rendering bridge.
- Definite initial `invalid_review_input` responses can unlock correction,
  but an earlier ambiguous response remains unresolved even if a later attempt
  returns that code. Only the gateway's exact code/status/action combination
  gets this treatment; private server messages remain hidden. Text draft content
  is retained for correction; navigation recovery compares the current product
  rather than a stale async closure.
- Independent follow-up review found no blocker in that recovery logic. Added
  its requested delayed-rejection regressions: product A → B clears old consent,
  and navigating to Loyalty releases the module lock after a definite rejection.
- An offline Vite bundle now compiles the actual staged account entry and all
  new dependencies at ES2015, asserts public routing and excludes the legacy
  endpoint. The exact randomly created staging directory is removed afterward.
  This is not a Shopify CLI deployment or proof of the native rendering bridge.
- The existing signed prepare response now includes the same-store active
  product's title. The account form requires that title and renders it as text;
  it is excluded from mutation payloads. This is an additive response field with
  no schema change: deploy the backend reader before the new account extension.
  Older forms ignore the additional field; the new form fails closed against an
  old backend.
- Added an EN/JA/VI product picker using the existing customer-account
  Storefront query capability, with bounded 20-product pages, cursor validation,
  escaped titles, empty/error states and explicit retry. It reads public product
  IDs/titles only; selecting a product still requires signed backend preparation.
  Reviews entry points remain available when Loyalty is loading or unavailable.
- Independent review caught rapid pagination clicks corrupting cursor history.
  Synchronous navigation/retry fencing and a double-click regression resolve it;
  re-review reported no remaining blocker. Eight query-contract tests and six
  picker component tests pass. All 49 focused backend/staging tests pass.
- Full web typechecking first exhausted Node's default 4 GiB heap; the 8 GiB
  retry passed, matching the configured CI heap limit. A raw web-suite run
  passed 9,838 tests but failed 30 across six legacy Shopify suites (six skipped).
  Isolated reproduction identified missing synthetic app identity and
  `invalid_scope`; the canonical serial command reproduced that failure too.
  CI provides a nonsecret app identity, absent from this environment. The rerun
  with those checked-in fixture values passed all 610 files: 9,868 tests passed,
  six skipped. Root lint passed (10 tasks, nine cached). No production credential
  or authentication-rule changes were involved. No fresh full Next.js build or
  SQL concurrency run was performed for this UI/additive read-field slice.

## Remaining implementation and acceptance

1. Review the product-title addition, complete relevant backend checks and
   expand photo-error cases once account uploads have a supported bridge.
2. Finish the independent account Reviews UI's product context and real platform
   rendering. Implemented disclosure/consent, preparation, confirmation and
   uncertainty states must pass installed-account acceptance. Do not expose
   author bindings, tokens or private customer IDs in rendered markup.
3. Verify the implemented product picker/deep links and navigation transitions
   in the installed account runtime; pending operations must retain identity
   across rerenders and stale preparation must remain rejected.
4. Complete photos using supported platform capabilities. Shopify's 2026-07
   Drop zone docs and installed customer-account element typings currently
   expose selection events/value but not a `files` accessor. Do not assume
   native DOM file access or claim uploads work from a passing mock. Verify an
   actual supported bridge before enabling the account photo control.
5. Verify the staged account extension in Shopify's own development runtime,
   preserving legacy custom extension identities and generating no public UID
   in the offline bundle test. The current installed
   SDK exposes a global `navigation` used by its own Preact hook, while current
   documentation describes `shopify.navigation`; confirm actual runtime behavior
   rather than hiding that discrepancy with an unsafe type assertion.
6. Test actual components, language coverage, keyboard, 375px layout, disabled
   Loyalty, missing product, expired authentication, failures, double clicks and
   ambiguous responses. Run types/lint/build and independent review before PR.
7. Verify installed-account authentication and provider behavior on `yamaxdev`
   under the existing external execution gates. Local tests do not close R03.

References: [Shopify Drop zone](https://shopify.dev/docs/api/customer-account-ui-extensions/latest/web-components/forms/drop-zone),
[Navigation API](https://shopify.dev/docs/api/customer-account-ui-extensions/latest/target-apis/platform-apis/navigation-api),
[authoritative completion matrix](company-store-completion.md).
