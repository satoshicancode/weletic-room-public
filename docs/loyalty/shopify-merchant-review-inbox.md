# Shopify merchant review inbox

Date: 2026-09-07. This implements part of package 8 of the approved unified
loyalty/reviews plan, on top of the staff-authorization foundation in PR #76.
Neither this inbox nor that schema has been deployed to a Shopify store.

## Implemented contract

- `/reviews` provides a read-only product-review and invitation inbox with
  English, Japanese and Vietnamese copy. Status and rating filters clear prior
  results; rating filters apply only to reviews. Content is rendered as escaped
  text, not HTML. Pagination is bounded and observational, not a frozen snapshot.
- Each browser read obtains a fresh App Bridge token and uses
  `POST /api/merchant/reviews`. Its signed backend counterpart is
  `POST /api/internal/shopify/merchant/reviews/list`.
- Current `reviews.read` authority, nonce consumption and list queries execute
  in the same Prisma transaction. `reviews.moderate` alone does not imply read
  permission. A denied request never falls back to offline credentials.
- The existing workspace list service accepts an explicit transaction while
  preserving its default database caller. Both paths constrain related products
  and media to the same store. Merchant cursors additionally bind app,
  installation generation, view, status and rating.
- Merchant projections exclude shopper IDs, tokens, private media keys/IDs,
  raw provider errors and internal reward reasons. The inbox reports only whether
  a delivery error exists. Low-rating/hidden reviews remain readable and keep
  their recorded incentive state; listing does not award or revoke anything.
- The route retains installation bootstrap without serializing session data.
  Form POSTs return 405. No moderation, sending or reward writer is added.

## Local evidence

- 76 focused service/client/SDK-fixture tests pass, including the new signed
  reviews adapter. These use synthetic identity/provider evidence.
- 19 isolated MySQL tests pass. The new case calls the actual signed gateway
  and production list service: same-timestamp keyset pagination, another store's
  rows, a deliberately corrupt cross-store product association, cursor/filter
  mismatches, replay, exact grants and revocation. Fixtures are read-only test
  inputs, not validated purchase journeys, and are cleaned up afterward.
- Six Shopify loader/action tests pass. They prove bootstrap-only serialization,
  redirect propagation and disabled form writes, not rendered browser behavior.
- Both package type-checks, focused lint, formatting and Shopify build pass.
  The database adapter explicitly accepts the application client's password-omit
  configuration and transaction clients without a type cast or suppression.
- Independent read-only adversarial review found no blocking issue.
- The complete web unit run at commit `bb57b192d4` passed 4,616 tests across
  301 files, with six skipped. Full web lint also passed. This includes the
  existing production-service tests distinguishing legacy publication rewards
  from new policy-backed participation rewards; it is not live Shopify proof.
- The guarded loopback-configured web compile-mode build also passed. This
  verifies compilation, not authenticated runtime acceptance or deployment.
- Rebased verification exposed an intermittent stalled-response fixture timeout:
  Undici can collect the temporary mock Request's derived abort controller.
  The fixture now listens directly to the signal passed to fetch. Production
  deadlines and the assertions for one dispatch, 503 and lease release remain
  unchanged; the test timeout was not increased.
- After the fixture correction, all 76 focused tests and the complete 301-file
  web suite passed again (4,616 passed, six skipped).

## Still required

Live owner/staff/denial acceptance and complete keyboard/accessibility journeys
remain unproven. PR CI and live acceptance are separate gates.
PR #76 merged with explicit schema confirmation as `57995b4e0e`; neither that
merge nor this inbox authorizes database rollout or deployment.

Moderation, replies, private-media preview, invitation controls, store-experience
reviews and Q&A are explicitly unavailable here, not implied complete. These
remain required by later increments of the original plan. No store, deployment,
email configuration or historical financial data was changed.

The next moderation writer must authorize and audit within the existing mutation
transaction, not authorize first and invoke a second transaction afterward.
`moderateNativeReview` currently preserves legacy reward side effects while
excluding policy-backed participation rewards from publication-based issuance
and hiding-based clawbacks. A staff adapter must preserve that financial-history
boundary, lifecycle fences, expected versions and summary outbox updates. A
button calling the existing workspace endpoint is not a valid implementation of
Shopify staff authorization or audited moderation reasons.

## Synthetic rendered-browser evidence

A loopback-only Vite session rendered the actual route component after mocked
Remix loader navigation. App Bridge and merchant API responses were mocked;
all other browser network destinations were blocked. This does not prove live
installation authentication or authorize bypassing the production loader.

- English rendered a hidden one-star review and retained its incentive label.
  An HTML-like image/event-handler string rendered as text, with zero matching
  image elements in the DOM.
- Japanese review and Vietnamese invitation screens were visually inspected at
  390 px width; the document width also remained 390 px. Review text was not
  automatically translated.
- A next-page 403 removed the prior review and pagination controls and placed
  focus on the localized denial notice.
- Switching to invitations removed the rating filter. Changing invitation status
  cleared the previously displayed result before an explicit reload.
- Browser inspection caught English Polaris live-region announcements despite
  localized page copy. The inbox now supplies Polaris's bundled EN/JA/VI
  dictionaries; the actual Japanese and Vietnamese announcements were verified.
  No authentication or business authority changed.

Screenshots are local ignored artifacts under
`output/playwright/shopper-rewards/`: `reviews-ja-mobile.png` and
`reviews-invitations-vi-mobile.png`. The Japanese screenshot predates the
live-region fix; the later DOM snapshot proves that announcement's translation.
A transient HMR error during an intermediate import edit was corrected; the
subsequent type-check, six route tests and Shopify build pass. Independent
read-only review found no blocker in the locale-provider change.
