# Core launch execution packets — September 26, 2026

Status: implementation preparation. No live spending, shared DDL, delivery,
publication or activation is authorized by this document. The
[canonical checklist](core-launch-checklist.md) owns release scope.

## A. Resource proposal for approval

Select separate Room acceptance and production resources. Do not reuse the
Partners Redis, existing custom-app credentials or provider datasets. Acceptance
starts with yamaxdev; production starts with one approved company store. No video
processor, import worker, marketing campaign service or advanced analytics stack.

| Resource              | Acceptance                                                                               | Production                                                           |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Cloudflare Containers | 1 web: 1 vCPU/3 GiB/4 GB; 1 basic Shopify; 1 basic outbox                                | 2 web; 2 basic Shopify; 1 basic outbox                               |
| Cloudflare ingress    | Workers Paid, explicit host routing, core-v1 runtime admission                           | Same, independently scoped secrets; only one financial outbox writer |
| SQL                   | PlanetScale Vitess AWS Tokyo PS-10, three-node cluster, 10 GiB included                  | Tokyo PS-20, three-node cluster, 10 GiB included                     |
| Redis                 | Dedicated Tokyo Fixed 250 MB + Prod Pack                                                 | Dedicated Tokyo Fixed 1 GB + Prod Pack                               |
| QStash                | Dedicated paid usage workspace + Prod Pack, US East                                      | Separate paid workspace + Prod Pack, US East                         |
| R2                    | Private acceptance bucket, APAC hint, 20 GB scenario                                     | Separate private bucket, APAC hint, 100 GB scenario                  |
| Email                 | Dedicated approved transactional sender, Resend Pro                                      | Separate sender/key, Resend Pro                                      |
| Monitoring            | Existing provider dashboards/logs; 7-day redacted application logs; daily operator check | Same plus provider alert rules and 72-hour launch watch              |

Cloudflare placement must be measured near Tokyo; an APAC hint is not a data
residency guarantee. QStash and email processing involve US infrastructure.
Confirm these transfers in the protected-data evidence before live recipients.
No additional replicas/read regions or automatic capacity upgrades are selected.

### Budget, USD per 30-day month

Conservative accounting assumes no free credits, 720 continuous hours, full CPU
utilization as the upper container scenario, and separate environments. Lower
expected CPU scenarios are 5% acceptance / 10% production. These are estimates
and proposed caps, not an account invoice or an automatic provider spending cap.

| Line                                | Acceptance | Production | Basis                                                           |
| ----------------------------------- | ---------: | ---------: | --------------------------------------------------------------- |
| Containers + Workers base, full CPU |     117.34 |     209.51 | 1.5/2.75 total vCPU, 5/9 GiB, 12/20 GB disk                     |
| Durable Objects allowance           |      25.00 |      25.00 | Conservative allowance for awake objects                        |
| Workers requests/CPU/logs allowance |       5.00 |      10.00 | 0.1m/5m requests; no customer bodies in logs                    |
| SQL compute                         |      47.00 |      71.00 | Public regional catalogue queried September 26                  |
| SQL extra daily backups             |       1.61 |       1.61 | Seven retained full 10 GB copies at $0.023/GB-month             |
| One 24-hour restore rehearsal       |       1.57 |       2.37 | Same-size temporary compute; remove only approved test resource |
| Redis incl. Prod Pack               |     210.00 |     220.00 | Fixed 250 MB/1 GB, no extra read regions                        |
| QStash incl. Prod Pack              |     201.00 |     210.00 | 100k/1m delivery attempts including retries                     |
| R2 storage                          |       0.30 |       1.50 | 20/100 GB without free allowance                                |
| R2 operations allowance             |       5.00 |      10.00 | Bounded upload/read/delete traffic                              |
| Resend Pro                          |      20.00 |      20.00 | ≤50k monthly transactional messages/environment                 |
| **Scenario subtotal**               | **633.82** | **780.99** | Before reserve                                                  |
| **Proposed monthly ceiling**        | **750.00** | **950.00** | Reserve covers tax/FX, transfer and incidental usage            |

Expected lower-CPU subtotals are approximately $559.95 / $652.69. Both environments
running together have a proposed combined ceiling of $1,700/month; not approved.
The $400/environment Redis/QStash add-ons are selected to obtain encryption at
rest and provider operation features. Dropping them requires a separate review
of the actual data stored and an alternative security design, not silent omission.

Sources: [Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[instance constraints](https://developers.cloudflare.com/containers/platform/limits/),
[PlanetScale regional catalogue](https://planetscale.com/pricing),
[backup pricing](https://planetscale.com/docs/vitess/backups),
[Redis](https://upstash.com/pricing/redis), [QStash](https://upstash.com/pricing/qstash),
[R2](https://developers.cloudflare.com/r2/pricing/), [Resend](https://resend.com/pricing).
The public SQL SELECT returned Tokyo PS-10=$47 and PS-20=$71, each 10 GiB storage
and 100 GB included transfer. It is not a private account quotation.

Before purchase, bind this proposal to exact account IDs, regional availability,
billing owners, sender domain, support address and included allowance ownership.
Obtain the checkout totals; stop if either ceiling is exceeded. Alerts at 50%,
75%, 90%; at 90% pause new benefits/uploads/invitations, keep refunds/privacy and
existing obligations running. Do not shut off recovery services to meet a cap.
Capacity limits are acceptance targets: 1 store, ≤1k orders/day, ≤100 review
invitations/day, ≤10 concurrent wallet requests, ≤2 new redemptions/second burst.
Measure p95, queue age, SQL connections and memory before increasing them.

### Security, recovery and supervision

TLS everywhere; least-privilege keys per role; Partner API token only on web.
Private R2 with signed, short-lived photo access; no public bucket URLs. Separate
credentials for schema audit, migrations and runtime. SQL is the financial source
of truth; Redis loss must not change committed ledger/issuance outcomes. Signed
QStash payloads contain identifiers rather than email content or tokens.

Keep included 12-hour SQL backups plus seven additional daily backups. Proposed
RPO ≤12h and RTO ≤4h require an actual restore rehearsal, ledger reconciliation
and webhook replay; neither is yet proven. Restore into a separate target with
sends and grants off, verify privacy tombstones before replay, never restore over
live data. Rebuild caches and replay durable outbox receipts with deduplication.

Use guarded role entrypoints and singleton outbox supervision. Restart the outbox
mid-issuance in acceptance; verify fenced lease recovery. Alert on invalid webhook
signatures, backlog >5m, stale billing snapshot, repeated issuer ambiguity, worker
exit/OOM, privacy deadline risk and failed backup. Keep current provider data and
previous apps until replacement and retirement approval.

## B. Shared schema / deployment packet

The new additive table is [core-subscription-snapshot.sql](sql/core-subscription-snapshot.sql).
There is no automatic migration or shared application. Its unique key binds app,
pending installation and generation; immutable Shopify shop identity is recorded
only after authenticated Admin/Partner verification. Refresh revisions reject
late concurrent responses. Shop erasure deletes snapshots. Existing shared
privacy readers now require this table even outside core-v1.

1. Record exact SQL org/database/branch, region, principal, schema SHA and backup.
2. Run metadata-only `apps/web/scripts/loyalty/audit-core-release-schema.ts` and
   existing `audit-review-release-schema.ts` against a read-only target. The core
   inventory includes deferred tables; it checks existence plus the subscription
   unique index, not full type/enum compatibility.
3. Generate a full target-to-release Prisma schema diff as a review artifact;
   inspect types, enums, indexes, collation and any destructive statements.
   Do not run `db push` on a shared target. Review missing compatibility DDL even
   if the feature using it is disabled.
4. Approve the exact additive change set, apply through the provider's schema
   workflow, rerun inventory and transaction/lock acceptance, then deploy readers.
5. Roll back application images if needed; retain additive tables and receipts.

Only an isolated local MySQL 8 database has received the full schema. Target
PlanetScale native/HTTP transport, locking and backup restoration remain open.

Required runtime additions:

| Role         | Variables                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All          | `WELETIC_FEATURE_PROFILE=core-v1`; existing `WELETIC_RELEASE_PROFILE=loyalty-only` worker policy remains separate                                                     |
| Web          | `SHOPIFY_PARTNER_APP_ID`, `SHOPIFY_PARTNER_ORGANIZATION_ID`, `SHOPIFY_PARTNER_API_TOKEN`, `WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE`, `WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE` |
| Outbox       | `SHOPIFY_PARTNER_APP_ID` for snapshot identity; no Partner API token                                                                                                  |
| Embedded app | `SHOPIFY_APP_HANDLE`, `WELETIC_SUPPORT_EMAIL`; no Partner API token                                                                                                   |

Run paired ingress preflight; role startup also validates billing configuration.
Secrets go into provider secret stores, never images, command arguments or logs.

Configure authenticated GET `/api/cron/weletic/shopify/subscriptions` every minute.
It paginates current mapped installations and refreshes when ≤90s validity remains,
so normal reconciliation completes within five minutes with queue/network margin.
UI refreshes every four minutes and on entry/return. Authority still expires at
five minutes with no grace period. QStash jobs use one concurrent refresh and two
starts/second; measure backlog before adding stores. No subscription webhooks are
assumed. Register the two new job routes plus existing queue-retry supervision.

## C. Shopify publication and pricing packet

In the public app only: create public monthly USD500 `core-monthly`, no trial,
annual or usage charge; private free `company-free` and assign company shops.
Confirm actual handles and Partner App GID before setting environment variables.
Configure hosted pricing welcome link to `/`. Plan selection/return parameters
never grant access; server `activeSubscription` verification is authoritative.
A development store's no-charge public plan is allowed only when authenticated
Admin API confirms `partnerDevelopment`; production zero-price public data fails.

Stage with `infra/shopify-development/stage-public-extensions.mjs --core-v1`.
Bind the nine staged capabilities to public-owned identities: theme, customer
account hub, four named Flow triggers, bounded action and lifecycle endpoint.
The staging output is deliberately unowned/not deployable. Inspect extension
UIDs, public URLs, scopes, required protected fields and exact release SHA before
approving publication. Do not copy IDs from the custom app or enable deferred
extensions. Limited visibility still requires App Store review.

Listing draft: “Purchase points, fixed-value rewards and verified product reviews
for Shopify. Includes customer wallet/history, photo reviews, merchant moderation
and Shopify Flow integration. US$500/month; no trial. Private company plans are
assigned individually. Basic support is available through the listed contact.”
Publish only after screenshots, actual support/privacy URLs, cancellation guidance
and reviewer access agree with the installed release. No external features beyond
this checklist may be advertised as included.

## D. Bounded live acceptance / activation packet

Bind every run to yamaxdev's immutable shop ID, public app ID/version, installation
generation, image digests, release SHA, extension UIDs and exact fixtures. Obtain
approval for recipients, order amounts/payment method, coupons, uploads and cleanup.
No historical sends; only newly approved fixture orders. Record live receipts,
independent SQL results and timestamps; synthetic tests cannot substitute.

| Journey    | Required observations                                                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing    | Paid/private free/dev; declined selection; forged/cross-shop return; cancellation/cycle end; API outage; reinstalls; suspension stays suspended                                                                                   |
| Loyalty    | Enroll explicitly, eligible order → points → fixed coupon → checkout use; concurrent redemption; duplicate webhooks; ambiguous provider result; restart; partial/full refund; ledger reconciliation                               |
| Reviews    | Fulfill fixture, 7-day delay (approved test-clock alternative recorded), real inbox, 30-day token expiry/reuse, text and private photo, one award/order including low rating, manual moderation/reply/display, erase/export races |
| Flow       | Four real trigger receipts; bounded positive/negative action; duplicate run; revoked grant; disabled workflow; reinstall; no recursive or second participation award                                                              |
| Operations | Persistent signed webhook route, supervised restart, stale billing alert, restored backup, EN/JA/VI mobile/keyboard, pause/resume containment                                                                                     |

After all evidence and Shopify approval: request production activation for one
named company store, record switches and rollback operator, monitor 72 hours.
Pause new activity for financial mismatch, repeated duplicate awards, privacy
failure or delivery leakage; preserve obligation settlement. Retire old apps only
through the separate retirement approval. P0 remains open until those receipts exist.
