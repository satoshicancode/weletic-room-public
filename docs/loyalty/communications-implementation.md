# Loyalty communications implementation checkpoint

Status: local work in progress, 2026-09-09. This is not a delivery or live
acceptance certificate. No producer, provider, schema or store setting has changed.

## Implemented foundation

- Strict policies for points earned, redemption, referral friend/advocate,
  birthday, VIP achievement, reward expiry, points warning and last chance.
- Each policy requires EN/JA/VI subject, heading, body and action label.
- Plain-text placeholders are journey-specific. Expressions, HTML, malformed
  placeholders and header control characters are rejected. Event values are
  substituted once without evaluation; downstream renderers must use text nodes.
- Save requests require installation generation and revision, and cannot select
  a store. These are validation contracts, not authorization implementation.
- Persistence uses the existing program metadata, preserving unrelated keys.
  Tenant-bound revisions include a monotonic sequence; identical saves advance
  the revision. Store then program locks and a conditional metadata update fence
  writes. A missing program is created only in draft status.
- The internal merchant service derives tenant/permissions from authenticated
  staff and checks operational installation eligibility before persistence.
  The internal HTTP route verifies the complete signed actor/request body before
  one repeatable-read transaction. Both HTTP adapters cap actual body bytes at
  128KiB, and responses are private/no-store with sanitized failure messages.
- The Shopify client obtains a fresh App Bridge token. Save acknowledgements
  require a changed revision, matching installation generation and exact saved
  policy; duplicate journeys and unsupported response fields fail validation.
  Responses explicitly identify this policy-to-producer integration as
  `not_connected`; this does not disable the existing standalone expiry sender.
- Forty-one focused contract, persistence, gateway, backend-route and Shopify
  action tests passed. Shopify types and focused lint passed. Independent
  persistence and HTTP-layer reviews found no concrete defects.
- Eight browser-client contract tests cover fresh tokens, omitted browser
  credentials, permission/conflict failures, invalid acknowledgements, authority
  injection and an ambiguous timed-out save with no automatic retry.
- Disabled-by-default EN/JA/VI editor templates cover all nine journeys. Ten
  tests validate their variables, locale coverage and independent draft objects.
  These defaults neither replace current sender copy nor activate producers.
- Initial persistence MySQL races now pass (see evidence below); authenticated
  browser acceptance remains outstanding. Web types passed after the HTTP additions.
- The shared merchant editor and Shopify navigation/route are implemented locally.
  Editor language and content language are independent; saves include all three
  locales. Unsaved drafts block journey changes, discard is explicit, and an
  ambiguous save clears write authority until reload. Sample previews render text
  nodes, contain no shopper data and do not claim to be delivered-email previews.
  Delivery remains visibly disconnected. Eight DOM tests passed for locales,
  save fences, invalid markup, permission denial, ambiguous saves and late replies.
  UI review found navigation could discard drafts; the route now blocks Remix
  navigation with localized confirmation and guards browser unload. Three focused
  guard tests passed, and the editor test verifies dirty-state propagation.
  Shopify types/build and focused UI lint passed before the guard addition;
  Shopify types passed again afterward. Follow-up review cleared the fix;
  real embedded-browser navigation checks remain pending; local router evidence
  is recorded below separately from the focused mocked guard tests.

## Local browser and broader verification checkpoint

- Root lint and scoped formatting passed. Prisma validation passed with existing
  relation-mode warnings; no schema was applied.
- A local Chromium fixture mounts the actual shared editor, stylesheet and
  unsaved-change hook under a real React Router data router. Its transport is
  in-memory fixture data, not Shopify authentication or provider delivery.
- English, Japanese and Vietnamese screenshots inspected at 375px: document width remains
  375px without page overflow. Fixture store/installation identifiers are absent
  from the inspected English DOM.
- Editing the subject and following a router link raises the discard prompt.
  Cancelling preserves the subject and current page; confirming navigates away.
  Returning through browser history remounts the editor. This extends the mocked
  navigation tests but does not prove embedded App Bridge navigation or unload.
- Full unit run passed: 364 test files, 5,585 tests passed and six skipped. The
  separate four-test MySQL suite also passed. Web production build passed
  with 398 generated pages. The Vietnamese lower preview was
  also inspected: text wraps within the mobile card and sample variable labels
  are explicitly visible. Full keyboard/error/permission and embedded browser
  acceptance remain outstanding. Screenshots stay local, outside the public PR.

## Remaining implementation

1. Extend database evidence to authenticated install/reinstall, staff revocation
   and future delivery leases; current persistence races are verified below.
2. Finish editor review and visual/keyboard/error-state browser verification.
   Keep actual producer availability separate from merchant enablement; saving
   a policy must never imply that an unimplemented journey can send.
3. Integrate event producers with durable immutable event/policy provenance,
   installation-generation rejection, recipient consent/suppression, shared
   pause controls, delivery leases, retry/dead-letter handling and privacy cleanup.
4. Preserve expiry timing in the existing expiry policy; avoid a second competing
   schedule source. Establish reward-expiry timing in its own validated policy.
5. Verify complete browser states, isolated financial/concurrency races, actual
   approved delivery and named yamaxdev evidence before checking release gates.

Recipient identity, reward codes, CTA destinations and sender identity are not
merchant template variables. They require trusted delivery-context handling.
Templates cannot grant consent, select recipients or authorize transport.

## Isolated MySQL persistence evidence

`vitest.communications-db.config.ts` ran four passing tests on 2026-09-09 against
the existing isolated local development MySQL instance. The suite checks exact
host/port/database/user before mutation, verifies `DATABASE()` and `CURRENT_USER()`,
forbids external fetch, and creates unique test-only store/program rows. Cleanup
is restricted to those exact generated store IDs; no schema application occurred.

- Concurrent creation from one revision: exactly one save succeeds, one conflicts,
  and one draft program exists.
- Concurrent edits to an existing policy: one winner; sequence advances exactly
  once and unrelated current metadata remains intact.
- A prior installation generation cannot persist a policy.
- Another tenant's revision cannot create a program.

These tests exercise the persistence service under real store/program locks.
The unrelated metadata and generation changes are committed before saving;
they do not prove a metadata writer or reinstall racing concurrently with a save.
Independent review verified the test guard/cleanup scope and these claim limits.
They do not replace signed staff authentication tests or named live `yamaxdev`
acceptance. Run explicitly with `COMMUNICATIONS_DATABASE_INTEGRATION=1` and the
guarded local development `DATABASE_URL`; never point the suite at production.
