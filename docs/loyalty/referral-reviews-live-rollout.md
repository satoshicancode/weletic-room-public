# Referral and native reviews: development release

Target: `n0pvef-cs.myshopify.com`. Updated 2026-09-05.

[Notion planning copy](https://www.notion.so/3d2e26097bfd81c0a667ce21978d4fdc).

This is the approved six-package release plan and an evidence checkpoint, not a
claim of live completion. It covers Weletic's own referral and native verified
text/photo reviews. Video, historical review imports, ESP/Klaviyo, production
backfill corrections, and monetary valuation activation remain outside scope.

## Baseline

Main includes the remediation PRs #47–#51, native reviews #53, Flow #52, and
runtime hardening [#54](https://github.com/satoshicancode/weletic-room/pull/54)
(`a65349d4dc193c5e005c73af130bc2a7b1eea7dd`). The additive reviews and Flow
schemas have been applied to the existing development database. The private
2026-09-05 rollout record reports no schema drift, 30 zero-finding integrity
checks, and byte-for-byte preservation of existing data. That record supersedes
older documents that still describe the shared development schema as pending.
It does not prove Shopify publication or a real referral/review journey.

## Six packages and acceptance evidence

| Package                   | Work and required evidence                                                                                                                                                                                                                          | Current state                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Runtime                | Run the web and Shopify apps with matching secrets and stable HTTPS origins; configure authenticated scheduling, an exact-store worker, verified transactional sender, and private photo storage. Prove actual delivery and private object removal. | Runtime #54 merged/CI green; Resend sender configured. Actual delivery, hosted runtime/worker, and private photo lifecycle remain unproven. |
| 2. Shopify publication    | Validate and publish extensions, review/referral theme blocks, customer-account surfaces, fulfilled/cancelled subscriptions, and App Proxy. Verify authenticated round trips and the exact installed app version.                                   | Not published. Endpoint alignment and the Flow platform decision below remain.                                                              |
| 3. Shopify Flow           | One real workflow per immutable trigger: points earned, VIP tier changed, reward redeemed, and points expiring soon. Verify delivery, enable/disable callbacks, timestamp ordering, and disabled-store suppression. Use log-only test actions.      | Platform eligibility blocks the current custom-app/Basic-store combination.                                                                 |
| 4. Referral journey       | Real referral link → anonymous friend claim → delivered coupon → actual first paid test checkout → one advocate reward. Verify duplicate/fraud behavior and exact refund/cancellation reversal.                                                     | Complete live journey not proven.                                                                                                           |
| 5. Native review journey  | Real full fulfillment → delivered invitation → text/photo submission → moderation → one points award and public rating/metafield. Prove low-rating neutrality, reuse rejection, clawback, and privacy/photo removal with ledger preservation.       | Complete live journey not proven.                                                                                                           |
| 6. Cutover and operations | Activate only one review projection/reward writer, preserve the existing provider until replacement evidence passes, verify monitoring/recovery, and record final release evidence with a clean merged main.                                        | Pending preceding gates.                                                                                                                    |

## Current preflight evidence

Read-only checks on 2026-09-05 established:

- Shopify Admin **Settings → Plan** identifies the target as **Basic**. Calling
  this a development environment does not change its Shopify subscription plan.
- The app's Partner **Distribution** page identifies **Custom distribution**
  scoped to this store. No distribution or subscription change was made.
- [Shopify's Flow trigger documentation](https://shopify.dev/docs/apps/build/flow/triggers/create)
  restricts custom-app triggers/actions to Plus stores and Plus development
  stores. Publication alone cannot satisfy package 3 on this Basic store. An
  eligible test-store/app arrangement is still required. Hiro subsequently
  approved pursuing public distribution; see [ADR 0016](../adr/0016-public-shopify-app-distribution.md)
  and the [public-app roadmap](public-app-roadmap.md). The actual new-app setup
  and publication remain gated; no paid-store upgrade is authorized.
- Authenticated Redis `PING` returned HTTP 200 and `PONG`.
- Authenticated private R2 bucket `HEAD` returned HTTP 200. This proves bucket
  access, not upload permissions, public-access isolation, or object deletion.
- Subsequent approved configuration verified `email.weletic.com` in Resend
  (Tokyo), enabled sending with enforced TLS, and left receiving disabled. A
  sending-only domain-restricted development key is stored in the ignored local
  environment, with sender `Weletic <notifications@email.weletic.com>`. No secret
  belongs in checked-in evidence. SMTP still points to local capture.
- The 36 email-adapter tests passed again after configuration with network access
  blocked. This is not delivery proof; two distinct approved test inboxes remain
  needed for the advocate/friend journey. Reply-to is optional, not a blocker.

No actual email, Shopify publication, workflow activation, or live fixture
mutation was performed by these checks or sender setup. Credentials and signed
installation URLs must not be copied into this document or public evidence.

## Runtime contract

- `WELETIC_TRANSACTIONAL_EMAIL_FROM` must be a valid single mailbox verified by
  the external provider. `WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO` is optional;
  omitting it does not send customers to Dub support. Existing unrelated Dub
  defaults and local capture compatibility remain intact.
- Resend takes precedence when configured. SMTP forwards sender/reply-to, uses
  numeric ports, implicit TLS on port 465, and certificate verification. Other
  SMTP ports retain opportunistic STARTTLS; do not use an external server without
  verifying its encrypted transport. Mocked adapter tests are not delivery proof.
- Before starting any public local tunnel, set
  `WELETIC_ENFORCE_CRON_AUTH=1` in the server environment and verify unsigned
  Vercel/QStash requests are rejected. Vercel remains strict independently of this
  flag. QStash's public development signing keys are not used by verification.
- Existing QStash verification binds the body, not the destination URL. The new
  strict-mode tests do not prove destination binding or hosted scheduled delivery.
  Do not enable a broad scheduler as a substitute for store-scoped execution.

After the release gates permit processing, run one bounded batch from the repo
root:

```sh
pnpm --filter web loyalty:outbox-worker --store=n0pvef-cs.myshopify.com --once
```

Omit `--once` for the supervised continuous worker only after the bounded pass.
`--once` processes one batch, not the entire queue; failures or dead letters
return a nonzero exit. Exact-store lookup failures stop before any batch. Omitting
`--store` retains the legacy **global all-store** mode and is not an approved
shortcut for this rollout. Avoid `dev:all`/global sync auto-healing during the
scoped release.

## Verification and containment

Merged runtime-patch checkpoint (2026-09-05): all 264 web unit-test files passed,
with 4,003 tests passed and six existing skips. Web TypeScript passed with an
8 GiB heap; Shopify TypeScript/build, root lint, repository Prettier, Prisma
validation, and independent adversarial review passed. The first run exposed a
missing local install of the already-locked `sharp` dependency and an email
environment-type mismatch; frozen-lockfile installation and a type-only fix
resolved both. No dependency manifest or lockfile changed. The web production
build subsequently passed with CI fixture settings, external transport credentials
disabled, and the isolated `weletic_loyalty_it_flow_reviews_20260905` database;
all 383 static pages were generated. Lint and TypeScript ran separately, following
the existing CI build contract. All 29 real-MySQL integration tests also passed,
including configured-sender assertions at the production review-service boundary
for both mocked email transports. PR #54 passed both required CI gates, including
148 Playwright tests, and was squash-merged. The
[post-merge Fast Quality Gate](https://github.com/satoshicancode/weletic-room/actions/runs/33953581791)
also passed on the merge SHA above. None of the six live release packages is
complete; local and CI results are not live evidence.

For subsequent runtime PRs: independently review the diff, run formatting,
root lint, web/Shopify type-checks, unit tests and builds. Use the existing CI
gates; do not alter pipelines or bypass checks. Test financial and concurrency
paths through production services and isolated MySQL boundaries, then retain
separate named-store evidence for external behavior.

Use only explicitly controlled customer inboxes and disposable non-production
orders/media for the live journeys. Never trigger real card charges or send
invitations to historical customers. Native collection begins before new test
fulfillment; it must not back-send invitations for historical fulfillment.

On failure, disable collection/invitation sending and pause processing. Preserve
grants, schemas, and ledger history; never rewrite financial rows or run a
shop-wide purge. Keep backfill commits and unconfigured financial metrics off.
Do not disable or uninstall Judge.me/Smile merely because the replacement code
builds. Their billing cancellation is separate from technical cutover.
