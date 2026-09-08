# Native reviews implementation

**Historical first-release contract.** The [unified acceptance matrix](unified-acceptance-matrix.md)
supersedes this document's narrower scope and publication-coupled incentive
policy. Product/store reviews, open submissions, video, imports, Q&A and manual
translations are now in scope. Participation-based points-or-coupon incentives
must be revisioned per order; hiding legitimate criticism must not revoke them.
The current legacy service does not yet satisfy that contract. Preserve this
document as implementation history, not an instruction to activate old policy.

Approved in the “Find existing reviews integration” task: verified purchases
first, text and photos at launch, and a staged Judge.me cutover. Reviews belong
inside Weletic Room and share its Shopify connector, customers, points ledger,
email transport, storage, privacy lifecycle, and storefront proxy.

## Scope and contracts

1. Add `weletic-reviews.prisma`: settings, per-order/product requests, immutable
   request-line purchase bindings, reviews, and private media. Keep the previous
   provider's schema for one transition release. Add typed native review jobs to
   the existing durable outbox. No shared database changes during implementation.
2. Reuse the OpenClub request/moderation lifecycle and extract provider-neutral
   rewards from Weletic's existing Judge.me adapter. Publishing an eligible
   verified review awards once regardless of rating; hiding/rejecting it reverses
   the exact award once, including when the customer balance is negative.
3. Process authenticated fulfillment and cancellation events. Request one review
   per order/product after fulfillment, revalidate paid/refund/customer truth
   before send and submit, and consume hashed expiring tokens atomically. Email
   delivery uses conditional leases and the existing transport.
4. Add workspace-authorized Reviews management, settings, moderation, merchant
   replies, filters, and request/reward statuses. The Shopify embedded app retains
   health/status and links to the main dashboard.
5. Add public published-review projection and summary through the authenticated
   app proxy, review stars and full review blocks, filters/cursors, verified and
   incentivized disclosures, and durable standard rating metafield updates.
   Do not emit duplicate Product JSON-LD.
6. Add token-bound photos with byte/MIME/size/count validation and private storage;
   extend customer export/redaction and shop redaction, with retryable object
   cleanup. Disable new Judge.me connections; native becomes the default provider.

## Verification and release

Tests must invoke production services and Prisma transaction boundaries for
concurrent token consumption, request deduplication, send leases, moderation,
rewards/clawbacks, tenant isolation, refund and cancellation replay, redaction,
and upload ownership. Verify storefront output and submission with Playwright;
run type-check, lint, unit tests, builds, Prisma validation, staged isolated MySQL
SQL checks, and adversarial review before publishing the PR.

PR #52 is a separate unmerged Flow dependency. Reconcile review reward event hooks
with that PR before release. Shared schema application and Shopify app publication
retain their explicit approval gates. This document records implementation scope,
not live deployment evidence. Video, imports, open/unverified submissions, and
removal of dormant Judge.me storage remain outside this first release.

## Operational contract

- Native reviews and invitation sending default to disabled. Enablement starts
  at the activation timestamp; it never sends invitations for historical
  fulfillments. There is one request per store/order/product, not per variant.
- Only a fully fulfilled, paid purchase with remaining unrefunded product
  quantity can supply a new review. Cancellation remains authoritative even
  when its webhook arrives before the paid-order projection.
- Photos are optional: up to five JPEG/PNG/WebP inputs of 2 MiB each. The server
  decodes and converts them to metadata-free WebP in the existing private R2
  bucket. Private storage configuration is required; there is no public-bucket
  fallback. Abandoned reservations have durable cleanup jobs.
- A published review can earn points independently of its rating. A later full
  refund invalidates unused invitations but does not delete genuine submitted
  feedback. Hiding/rejecting a rewarded review appends one exact reversal;
  republication cannot award again. Customer privacy erases content/photos but
  retains the historical financial ledger.
- Request email workers use durable token leases, renewal, and winning-token
  finalization. Concurrent workers have one-send test evidence for both
  transports. Resend uses a stable idempotency key. SMTP cannot guarantee
  exactly-once delivery across a process crash after server acceptance; that
  transport ambiguity is not represented as a solved guarantee.
- Reviews are managed at `/<workspace-slug>/reviews`; reward rules remain at
  `/<workspace-slug>/loyalty/earn`. Owner-only settings are separate from normal
  moderation permissions. The embedded Shopify app shows health and deep links.
- Public reads, invitation APIs, and private media links are non-cacheable.
  Shopify receives only the current aggregate in `reviews.rating` and
  `reviews.rating_count`; the theme blocks do not add Product JSON-LD.

## Explicit rollout gates

1. Keep both settings disabled. Confirm the exact shared staging database and
   obtain Hiro's approval before applying schema changes. The SQL baseline is
   main after PR #51; if PR #52 has landed or its schema has been applied,
   regenerate the outbox enum migration so `FLOW_TRIGGER` is preserved.
2. Apply the additive `native-reviews-stage-1.sql` on approved staging, validate
   Prisma/schema drift, then run `native-reviews-stage-2-gate.sql`. All seven
   finding counts must be zero. Do not infer shared-staging proof from the
   isolated local database results.
3. Obtain explicit merge confirmation for this shared-schema PR. Roll out the
   web app and workers only after expansion; keep invitation activation off
   until all worker instances understand the new outbox enum values.
4. Obtain separate Shopify publication approval. Publish the two theme blocks
   and fulfilled/cancelled subscriptions; verify a real app-proxy HMAC round
   trip, valid/expired/single-use invitations, photo storage/deletion, owner
   settings, moderation, and standard rating metafields on an approved store.
5. Confirm the existing email sender and private storage are configured. Enable
   native collection for one approved merchant, verify fulfillment -> email ->
   submission -> moderation -> points and public projection, then verify refund,
   cancellation, customer export/redaction and shop redaction paths. Never
   activate Judge.me and native projection writers together.
6. Reconcile review reward event hooks with PR #52 before final release. Real
   Flow workflow evidence belongs to its separate deployment gate. No ESP,
   Klaviyo, video, import, or open-submission completion claim is made here.

Rollback is containment: disable invitation sending/native reviews and retain
schema, grants, and ledger evidence. Do not drop tables or rewrite financial
history as an automatic rollback. Re-enablement does not revive cancelled
invitations; only new eligible fulfillment events create requests.

## Flow integration follow-up (2026-09-05)

PR #52 now reconciles the post-#53 review service: both native and retained
Judge.me awards enqueue the points-earned event from the shared reward service,
in the same transaction and keyed by the immutable award ledger ID. Reversals
and republication do not emit a second earned event. See
[the combined evidence and outstanding gates](shopify-flow-integration-evidence.md).
This code integration does not authorize shared database changes, Shopify
publication, collection activation, or invitation sending.
