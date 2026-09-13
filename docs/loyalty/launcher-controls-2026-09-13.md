# Launcher controls — September 13 implementation checkpoint

Status: locally verified, awaiting public CI; not deployed. This advances L07; it does not
close merchant or shopper live-acceptance gates.

## Reference and implementation

The September 9 R2 addendum in the [Smile benchmark](benchmark-smile-2026-09-08.md)
directly observed separate desktop/mobile copy, layouts, position and spacing,
device visibility, homepage hiding, URL-containing exclusions and shape controls.
Numeric limits and detailed matching semantics were not observed. The following
are explicit Weletic implementation rules, not claims about Smile:

- Optional `branding.launcherPresentation` in the existing JSON branding value;
  no schema migration. Existing stores retain 24px spacing, icon/text layout and
  pill shape. Smile's observed 20px/16px settings are not silently applied.
- Desktop and mobile each configure label, position, layout and side/bottom
  spacing. Null label/position inherit the existing shared launcher fields.
- Mobile is at most 767 CSS pixels. Spacing is an integer from 0 through 128px;
  labels are trimmed, limited to 40 characters and reject embedded controls.
- Layouts: icon then text, text then icon, icon only, text only. Shapes: square,
  beveled corners, rounded, pill/circle. Existing Weletic icons remain unchanged.
- Visibility: both devices, desktop only, hidden, additionally gated by the
  existing floating-launcher master switch and program/member visibility rules.
- Homepage hiding recognizes `/` and the current Shopify locale root, with or
  without its trailing slash. URL exclusions use literal case-sensitive substring
  matching against the browser URL, including query and fragment. Up to 20 unique,
  trimmed strings, each at most 256 characters; no regex or wildcard semantics.
- Resize, popstate and hashchange re-evaluate presentation. Ordinary navigation
  remounts the widget. No History API monkey-patching or browser-storage policy
  persistence. Theme code that only calls pushState without emitting a navigation
  event is not claimed as covered.
- Malformed policies suppress the launcher. Initial program-fetch failure cannot
  reveal a launcher whose visibility policy is unknown. After a successful read,
  the last in-memory program presentation is retained across a refresh failure.
- Existing nudges disappear when the launcher becomes hidden and follow configured
  device positioning. If less than 96px remains above the launcher, optional
  nudges are suppressed. Long launcher content stays inside a viewport-bounded,
  scrollable button; its accessible label remains complete. Alternate
  account/landing surfaces are not modified.

## Merchant contract and compatibility

The EN/JA/VI shared appearance editor uses the existing signed gateway and carries
both installation generation and expected revision. Tenant ownership and program
maintenance admission are unchanged. Invalid input cannot write. An older
full-replacement appearance save omitting already-configured presentation is
rejected rather than erasing the policy. Legacy partial branding updates retain it.
There is no new public write API or customer-data field.

## Verification so far

- 166 focused tests passed across eight suites: presentation contract/runtime,
  actual shared editor in EN/JA/VI, appearance service/contract/client, actual
  drawer and nudge runtime with mocked transports.
- Web and Shopify typechecks passed. Focused ESLint and root lint passed
  (10 tasks). Shopify build and Prisma validation passed. Independent review found nudge interaction and validator-parity
  issues; fixes and regression tests were added before publication.
- Local real Chromium at 375px: editor saves device settings through a synthetic
  revisioned transport; EN/JA/VI show no horizontal document overflow or cleartext
  fixture store/generation identifiers. Mobile launcher uses its label/layout/
  offset; Tab/Enter opens the drawer with focus inside. Escape closes it. A
  matching hash exclusion hides both launcher and drawer.
- Maximum spacing (128px), a 40-character label and 375×320 viewport reproduced
  an offscreen nudge. After the fix, the launcher begins 16px below the top and
  remains within the viewport; a fresh eligible signup prompt is suppressed for
  insufficient space. At 375×812 the launcher and prompt both fit.
- The initial full unit run stopped after 423 tests on the former expectation
  that unknown initial visibility reveals an authenticated launcher. The test
  now requires it hidden while retaining all successful wallet/landing checks.
  The 110-test theme/drawer/nudge regression rerun passed.
- The next full run stopped at the test-store validator because the new checkout
  lacked CI's synthetic Shopify app identity. With the five public Shopify/service
  fixture environment values from `quality.yaml`, all 28 validator tests passed.
  Production validation was not relaxed. The full fixture-configured rerun passed:
  503 files, 8,151 tests passed and six skipped in 686.95 seconds.
- The isolated Next production build passed. Its temporary SELECT permission was
  revoked and independent SQL confirmed all 157 fixture tables remained empty.
- Four real isolated-MySQL tests passed, including atomic competing launcher
  policies, legacy omission rejection, foreign revision and stale generation.
  The first execution passed assertions but failed Prisma's cleanup cascade
  because the historical fixture lacks newer optional installation tables. Its
  five verified fixture records were removed and all 151 tables reconciled empty.
  Cleanup now uses parameterized SQL for the exact in-memory test store IDs, as
  existing parent cleanup already does, and disconnects in `finally`. The full
  four-test rerun passed with grant revocation and all 151 tables independently
  empty. No shared schema or production record was changed.
- Browser fixture initially used the wrong JSX transform and failed to render;
  rebuilt with the automatic JSX runtime used by the application. This fixture
  failure is not counted as passing evidence.
- Public CI remains pending at this checkpoint. Final independent
  review found no remaining blocker in the implementation.
  No named `yamaxdev` live evidence exists for these additions.

## Remaining work

Finish full verification and final review, then publish
the reviewed change. Coordinate backend, embedded editor and theme asset release;
prove signed live saves, stale revisions and actual storefront behavior on
`yamaxdev` before marking the applicable matrix items accepted.

L07 still includes separate visitor/member panel copy, section ordering/default
opening view, expanded color roles, managed images/icons and contrast acceptance.
Artwork upload and custom stack-order requirements need explicit disposition.
These controls do not implement those features or certify full Smile parity.
