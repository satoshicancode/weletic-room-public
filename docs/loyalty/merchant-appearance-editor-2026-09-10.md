# Existing loyalty appearance editor — September 10 checkpoint

Status: locally verified implementation; public PR/CI pending, not deployed or
accepted on yamaxdev. This is the first bounded L07 step, not full Smile
appearance or nudge parity.

## Scope and contracts

The embedded appearance page retains its existing brand settings and adds the
shared loyalty editor for nine already-supported fields: launcher label,
position, icon, floating visibility, primary/header text colors, panel title,
welcome subtitle, and optional public HTTPS hero image URL. This does not add
new shopper presentation policies, initialize a missing loyalty program, change
program activation, or modify financial settings.

The Remix adapter obtains a fresh App Bridge token and uses the existing signed
merchant gateway. The backend verifies the complete actor/request signature,
reauthorizes `appearance.configure` in the transaction, checks project ownership,
and fences writes by installation generation, program revision, operational
state, and maintenance lease. Store identifiers cannot be supplied in the editor
request. Save uses store/program lock order and a compare-and-swap over the
previous stored values, preserving unrelated metadata. No schema migration.

Legacy stored branding remains readable, including previously allowed embedded
whitespace. New writes apply strict field validation. A missing program remains
unconfigured; reads never create one. Saves are not automatically retried.
An unverified or ambiguous acknowledgement preserves the local draft but disables
another save until reload. Route navigation and browser unload guard unsaved work.

## Local evidence

- Contract/service/gateway/client/action suites: 58 tests passed before the route
  suite was added. These use mocked database/transport boundaries, not MySQL race
  or live Shopify evidence.
- Route suite: 15 tests passed with the real HMAC verifier and mocked database/
  gateway. Covers signed success, tampered actor/request, expired/missing
  signatures, strict authority rejection, malformed/oversized bodies, and safe
  authorization/conflict/maintenance/unknown-error responses.
- Root lint: 10 successful tasks. Web and Shopify typechecks passed. Shopify
  production build passed with existing non-fatal sourcemap warnings.
- Independent review found and resolved a legacy-whitespace compatibility issue;
  subsequent bounded review found no new blockers.
- Browser receipt `APPEARANCE-LOCAL-20260910`: actual shared component and existing
  Shopify stylesheet, loopback-only Vite fixture with an explicitly synthetic
  transport. English, Japanese, and Vietnamese rendered at 375px without document
  overflow (document width = viewport width = 375). Synthetic internal store ID
  was absent from the DOM. This is not an embedded App Bridge acceptance run.
- Browser save produced exactly one request; ambiguous failure retained the draft
  and disabled editing; confirmed reload restored saved state. Keyboard Enter
  submission, repeated Enter during pending save, loading state, and Tab to the
  next labelled field passed. These are bounded keyboard checks, not a complete
  accessibility audit.
- Full web regression: 5,779 passed, 6 existing skips, 376 files; Shopify unit
  suite: 27 passed. Both production builds passed.
  A subsequent database-fixture typecheck exhausted Node's default 4 GB heap;
  the corrected fixture passed the 8 GB rerun. Prisma schema validation passed
  without schema changes. Public PR/CI is pending.
- `APPEARANCE-MYSQL-20260910`: three tests passed in the approved empty isolated
  MySQL fixture: exactly one competing revision succeeds, a foreign-store
  revision receives the expected conflict error, and a generation-change-first
  overlap rejects the stale writer with the expected operational-state error.
  The last case does not establish measured lock-wait duration. The disabled
  program remains disabled; unrelated metadata is preserved. Actor authentication
  is not exercised by these DB primitives. Initial seeding used an invalid enum;
  corrected to the schema's `disabled` value before the passing run.
  Independent SQL found zero remaining Project, Program, store and loyalty-program
  rows. Temporary SELECT/INSERT/UPDATE/DELETE grants were revoked; no schema change.
- Browser permission-denied and missing-program responses disabled editing;
  invalid color validation sent no request. A stale acknowledgement retained
  the draft and disabled retry. These checks used the same synthetic transport.

Local screenshots and the synthetic fixture remain ignored under
`output/playwright/appearance`; no Smile assets, shopper data, signed URLs or
credentials are published. The only observed fixture console error was its
missing favicon, not an editor request failure.

## Remaining acceptance and implementation

1. Finish public PR/CI gates. Retain the qualified MySQL
   contention and change-first evidence above; do not call it live acceptance.
2. Prove authenticated embedded navigation, staff permission changes, persisted
   readback and actual launcher/drawer projection on yamaxdev after the public
   identity and live execution gates are met. Fixture success does not close B1,
   B4, or shopper-surface acceptance.
3. Continue L07's separate device-specific spacing/layout/visibility, URL
   exclusions, shape, section ordering/default view, visitor/member copy and
   additional color/banner controls. Preserve the backlog's explicit decisions
   and source confidence; do not infer undocumented Smile behavior.
4. L08's three nudge editors and runtime eligibility/dismissal remain separate,
   unimplemented work. No nudge or communication is activated by this editor.

No shared schema application, public deployment/exposure, installation, real
order/redemption/email, or old-app uninstall was performed for this checkpoint.
