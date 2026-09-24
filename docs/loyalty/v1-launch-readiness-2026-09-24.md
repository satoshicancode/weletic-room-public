# Weletic Room v1 launch readiness

Code baseline reconciled September 24, 2026: public `main` at
[`84920e6b`](https://github.com/satoshicancode/weletic-room-public/commit/84920e6bdca8da2c3f075d9d36b8e9fad43a8fa6)
(PR #124; [current-head CI passed](https://github.com/satoshicancode/weletic-room-public/actions/runs/35974711123)).
The store-review, prospective collection and shared-delivery code is merged.
Its shared schemas have not been applied to a release target, and neither
Loyalty nor Reviews has passed installed, provider and operational release gates.

The [combined completion checklist](company-store-completion.md) defines the
capability contracts and T1–T4 evidence classes. This index names each
capability's next blocking gate and launch milestone. A passing test applies
only to the exact revision and environment recorded in its evidence.
“Locally verified” describes the documented implementation subset and does not
mean installed acceptance. “Partial” identifies a named missing sub-capability.

| ID  | Capability                  | Implementation status                        | Current evidence                                                                                                                                                                                                                                                                                                                                         | Next blocking gate                                                                                            | Milestone |
| --- | --------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| L01 | Points/refunds              | locally verified; bounded live subset        | [Bounded live purchase/refund](yamaxdev-financial-acceptance-2026-09-19.md)                                                                                                                                                                                                                                                                              | Duplicate/crash, maturity/expiry and full ledger reconciliation                                               | M2        |
| L02 | Rewards/wallet              | locally verified; fixed discount live subset | Fixed discount live subset; [local boundaries](financial-reward-boundaries-2026-09-16.md), [voucher cleanup fix](https://github.com/satoshicancode/weletic-room-public/pull/104), [isolated SQL reconciliation](https://github.com/satoshicancode/weletic-room-public/pull/105) and [used-reward refund/replay SQL](reward-sql-acceptance-2026-09-24.md) | Every enabled reward lifecycle, real provider cleanup and use                                                 | M2        |
| L03 | Subscription policies       | locally verified                             | [Local policy evidence](unified-acceptance-matrix.md)                                                                                                                                                                                                                                                                                                    | Real renewal/first-N, mixed lines and immutable snapshots                                                     | M2        |
| L04 | VIP/campaigns               | locally verified                             | [Local VIP](vip-grace-acceptance-2026-09-16.md) and [campaign](campaign-accounting-acceptance-2026-09-16.md) evidence                                                                                                                                                                                                                                    | Live transitions, notices and refund allocation                                                               | M2        |
| L05 | Referrals                   | locally verified                             | [Local account/anonymous lifecycle](referral-lifecycle-2026-09-17.md)                                                                                                                                                                                                                                                                                    | Live claim, qualification, clawback and confirmation                                                          | M2        |
| L06 | Appearance/nudges           | implemented                                  | [Local controls](launcher-controls-2026-09-13.md)                                                                                                                                                                                                                                                                                                        | Installed theme, mobile, accessibility and locale journey                                                     | M2        |
| L07 | Shopper surfaces            | locally verified; bounded live subset        | Local components; bounded wallet live subset                                                                                                                                                                                                                                                                                                             | Installed authenticated journeys and failures across surfaces                                                 | M2        |
| L08 | Communications              | implemented                                  | [Local producer implementation](communications-implementation.md)                                                                                                                                                                                                                                                                                        | Approved actual delivery, suppression and worker recovery                                                     | M2/M3     |
| L09 | Analytics/exports           | implemented; incomplete                      | [Report inventory](analytics-report-coverage.md); [S23 ledger net](recorded-ledger-net-s23-2026-09-24.md) merged; [S21 first recorded earns](first-recorded-earners-s21-2026-09-24.md) has local SQL evidence; shared indexes unapplied                                                                                                                  | S18, lifetime cohorts, historical liability, private exports, installed reconciliation and shared index gates | M2        |
| L10 | Historical imports          | locally verified at bounded scale            | [Latest 50,000-row failure and bounded proof profile](historical-import-scale-attempt-2026-09-24.md); [proof-reader joins](https://github.com/satoshicancode/weletic-room-public/pull/122); [current enum preflight](https://github.com/satoshicancode/weletic-room-public/pull/110)                                                                     | 50,000 real commits and rollbacks, restart and independent reconciliation                                     | M2        |
| R01 | Invitations/submission      | locally verified                             | Local product path; prospective store path merged in PR #101; [bounded collection packet](review-collection-live-acceptance-packet.md) updated in PR #111                                                                                                                                                                                                | Installed fulfillment, inbox, scoped submit and retry                                                         | M1/M5     |
| R02 | Moderation/display          | locally verified                             | Local product path; store controls/widget merged in PR #101                                                                                                                                                                                                                                                                                              | Installed staff/theme journey, totals and privacy                                                             | M1/M5     |
| R03 | Open submissions            | implemented; account photos open             | Text gateway/account merged through PR #100                                                                                                                                                                                                                                                                                                              | Account photos and installed abuse/privacy journey                                                            | M5        |
| R04 | Incentive policy/disclosure | locally verified                             | [Local policy controls](review-policy-completion-worklog.md)                                                                                                                                                                                                                                                                                             | Schema rollout, installed disclosure and actual delivery                                                      | M1/M5     |
| R05 | Incentive fulfillment       | locally verified                             | Local product recovery; store competition merged in PR #101                                                                                                                                                                                                                                                                                              | Live points/coupon competition and ambiguous provider recovery                                                | M1/M5     |
| R06 | Invalidity/cost             | locally verified                             | [Local recovery](review-incentive-recovery.md)                                                                                                                                                                                                                                                                                                           | Installed adjudication and exact cost disposition                                                             | M5        |
| R07 | Store reviews               | locally verified; schema gated               | [Implementation worklog](store-review-core-worklog.md), merged PR #101, [storefront build](store-review-storefront-build-2026-09-24.md) and [acceptance packet](store-review-acceptance-packet.md)                                                                                                                                                       | Schema gate and installed SR-01–SR-07                                                                         | M1/M5     |
| R08 | Video/media                 | partial; video missing                       | Private photos local; video missing                                                                                                                                                                                                                                                                                                                      | Bounded processor, privacy/object recovery and installed playback                                             | M5        |
| R09 | Q&A/translations            | partial; Q&A missing                         | Product translations merged in PR #97; Q&A missing                                                                                                                                                                                                                                                                                                       | Moderated Q&A, extended translations and installed journey                                                    | M5        |
| R10 | Review imports              | missing                                      | Missing                                                                                                                                                                                                                                                                                                                                                  | CSV/Judge.me preview, provenance, dedupe and rollback                                                         | M5        |
| S01 | Identity/admission          | locally verified                             | Local implementation; bounded live overlap                                                                                                                                                                                                                                                                                                               | Install/reinstall, staff revocation and reviewer admission                                                    | M3        |
| S02 | Flow                        | locally verified                             | Trigger/action code merged; [action packet](flow-points-action-acceptance.md)                                                                                                                                                                                                                                                                            | Published workflows and exact live receipts                                                                   | M3        |
| S03 | Extensions/scopes           | implemented                                  | Partial preview proof; [default-config Shopify build](store-review-storefront-build-2026-09-24.md)                                                                                                                                                                                                                                                       | Public-app ownership, grants, account/theme and eligible checkout placement                                   | M3        |
| S04 | Runtime/operations          | locally verified                             | [Isolated container proof](../../infra/cloudflare-release/ISOLATED-VERIFICATION.md); [explicit review route admission](https://github.com/satoshicancode/weletic-room-public/pull/112)                                                                                                                                                                   | Provider compatibility, supervision, alerts and restore                                                       | M3        |
| S05 | Privacy/retention           | implemented                                  | Foundations and store/delivery consumers merged                                                                                                                                                                                                                                                                                                          | Schema compatibility and live export/erase races                                                              | M1/M3     |
| S06 | Listing/production          | missing acceptance                           | [Reviewer packet draft](app-store-reviewer-packet.md)                                                                                                                                                                                                                                                                                                    | Accepted build, listing/reviewer approval and controlled activation                                           | M4        |

L02's [isolated used-reward refund and replay evidence](https://github.com/satoshicancode/weletic-room-public/pull/116) is merged; it does not establish installed Shopify acceptance.

L10's bounded 500-row worker lifecycle passed again on `cb58f386` in isolated
MySQL: 500 commits, 500 rollbacks, final exact SQL reconciliation and disposable
fixture cleanup. The run took 11 commit deliveries and 11 rollback deliveries;
its local log is `/tmp/weletic-import-500-lifecycle-after-122.log` (SHA-256
`b52157c3528ccf9b9bdfd73c989e1178d82aedc1c7defc367004c3027ebbad34`).
This does not close the 50,000-row, restart or installed gates.

L09's [recorded-order earning-rate code](https://github.com/satoshicancode/weletic-room-public/pull/117) is merged. It excludes missing Shopify orders, and its additive index has not been applied to a shared database. This is neither a whole-store rate nor installed acceptance.

L09's [recorded-ledger redemption-to-earn code](https://github.com/satoshicancode/weletic-room-public/pull/124) is merged after 38 focused combined tests, green current-head CI, a bounded production build and [isolated SQL reconciliation](redemption-rate-s17-2026-09-24.md). Its monthly ratio excludes historical backfill from earned points and does not measure discount use or whole-store behavior. Installed acceptance remains open. Earlier stacked PR #118 was closed and superseded.

Read-only Shopify CLI check on September 24 at `037e80fe`: CLI 4.7.0 accepted
both app configurations with zero validation issues. `shopify app info --json`
reported 15 selected extensions for the default configuration and zero for
`loyalty-public`; the two configurations have distinct client IDs. No extension
was deployed or installed by this check. An authenticated, read-only
`shopify app versions list --json` found one active public-app version created
September 5 and 20 default-app versions. That listing does not expose extension
contents or installed-store ownership. Before installed acceptance, reconcile
the public app's extension identities and confirm ownership, grants and placement
against the actual Shopify app and company store. The default-config build does
not establish those facts for `loyalty-public`.

A fresh [13-extension public staging build](public-extension-build-2026-09-24.md)
passed local validation on the same source SHA; its unique candidate UIDs remain
unowned until the public-app mapping and deployment gate are accepted.

The merged [Shopify runtime-image fix](https://github.com/satoshicancode/weletic-room-public/pull/119)
reduces the local image from the previous recipe's 4.47 GB to 980 MB unpacked
and passes a no-network guarded startup smoke. It provides local headroom for the proposed
4 GB `basic` disk, not Cloudflare admission, deployed memory proof or installed
acceptance. The [draft budget models](https://github.com/satoshicancode/weletic-room-public/pull/113) still need
account-specific pricing and provider image admission.

A local Linux/amd64 outbox build from `373cdbe2` succeeded, but `docker image ls`
reported **4.55 GB** unpacked, above the proposed 4 GB `basic` disk. This is a
local fit failure, not a Cloudflare admission test. The [separate budget models](https://github.com/satoshicancode/weletic-room-public/pull/113)
record that the previous `basic` outbox footprint was invalid. A local Linux/amd64 web build
from `febe7b69` also succeeded, but measured **4.86 GB** unpacked, above the
proposed 4 GB disk. Both baseline footprints fail the conservative local fit
gate. No release image was uploaded.

[The merged scoped-runtime fix](https://github.com/satoshicancode/weletic-room-public/pull/120)
from `febe7b69` reduces the local web and outbox images to **3.15 GB** and
**2.84 GB** unpacked. Both pass the [formal no-network guarded startup smoke](release-runtime-footprint-2026-09-24.md),
including generated Prisma loading and real Next route/auth rejection. The
images locally fit the 4 GB disk. Cloudflare admission,
deployed memory and provider operation remain open; no release image was
uploaded.

Read-only Yamax installation inventory on September 24: the authenticated
[installed-app list](https://admin.shopify.com/store/n0pvef-cs/settings/apps)
contained the existing **custom** Weletic Room app, Judge.me, Smile.io and Flow,
but no separate public Weletic app across its three pages. The custom app's
[installation detail](https://admin.shopify.com/store/n0pvef-cs/settings/apps/app_installations/app/weletic-room)
showed four active extensions: Weletic Loyalty Checkout Slider, Account Blocks,
Customer Account Hub and Launcher (App Embed), with zero active Functions. Its
extension-detail app ID matches the checked-in `shopify.app.toml` client ID and
differs from `shopify.app.loyalty-public.toml`; this is the retained custom app.
Shopify's protected-customer-data confirmation applies to that custom app only;
it is not evidence for the public listing candidate. The public-app CLI still
listed one active version created September 5, but did not expose its extension
manifest. In the installed [Flow workflow list](https://admin.shopify.com/store/n0pvef-cs/apps/flow),
the sole active workflow was “Recover abandoned checkout” with Shopify's
“Customer abandons checkout” trigger. No Weletic Flow workflow was present.
No app was installed, extension deployed, workflow changed or live operation run
during this inventory. S02/S03 require a controlled public-app installation,
exact extension ownership and named Flow workflow receipts before acceptance.

## Migration and runtime inventory

The repository has [29 checked-in Shopify-development SQL files](../../infra/shopify-development/migrations/).
The table below isolates the known v1 deployment candidates; it does not assert
which older files are already present on an acceptance or production database.
The merged [read-only review schema preflight](review-release-schema-preflight.md)
checks five relevant migration groups on a disposable MySQL fixture; it has not
audited a release target. No exact-target schema inventory is available yet. M0's unapplied-migration
disposition therefore remains open until read-only target metadata is compared
with every candidate file and the current Prisma schema.

| Change                                                         | Source state                                                                        | Required before deployment                                                                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loyalty daily activity `(storeId, createdAt)` index            | Merged in PR #102; shared application unverified                                    | Exact target metadata, reviewed DDL and read-plan acceptance                                                                                                                                                           |
| Loyalty recorded-order earning `(storeId, occurredAt)` index   | Merged PR #117; isolated SQL only                                                   | Exact target metadata, reviewed DDL and read-plan acceptance before deploying the S16 reader                                                                                                                           |
| Store-review five-table core                                   | Merged PR #101; only disposable SQL rehearsed                                       | Create all five before privacy readers; retain export-phase-compatible workers                                                                                                                                         |
| Review collection/reminder settings and history                | Merged PR #101; only disposable SQL rehearsed                                       | Schema before readers/jobs; retain reminder export phase                                                                                                                                                               |
| Product-review encrypted delivery snapshot and retention index | Merged code; only disposable SQL rehearsed                                          | Verify existing request table before email retry and privacy cleanup readers                                                                                                                                           |
| Review owner-privacy projection/audit tables                   | Merged code; only disposable SQL rehearsed                                          | Verify all three tables, identity indexes and backfill readiness before public/merchant privacy readers                                                                                                                |
| Shared shopper delivery tables, settings and outbox labels     | Merged PR #101; only disposable SQL rehearsed                                       | Schema before sender/privacy workers; reconcile old exports and uncertain sends                                                                                                                                        |
| Historical import tables, enums and nullable no-tier history   | PR #110 read-only enum lineage fix merged; target-specific schema status unverified | Run the [read-only import audit](historical-import-schema-release-gate.md) against each exact target, then separately approve compatible DDL                                                                           |
| Historical import ledger generated source column and index     | Draft PR #106 only; read-only preflight merged in PR #107                           | Prove generated-column/index compatibility and read plan on the exact provider; approve DDL separately before deploying the indexed reader. Do not run `prisma db push` afterward because it removes the column/index. |

Do not infer a target database's schema from a merged SQL file or disposable
rehearsal. Capture exact target metadata and mixed-version worker compatibility
before any shared migration. MySQL DDL requires forward containment after a
partial application.

## Next execution packets

1. **M1 installed:** PR #101 code, the size-compliant default-config storefront
   build, PR #112's guarded review routes and PR #115's read-only schema preflight
   are verified locally. Run the preflight against the selected target and rehearse exact
   target migration order and mixed-version privacy/delivery workers before
   deployment; keep store-review writers disabled until the schema gate passes.
2. **M1 journeys:** use [SR-01–SR-07](store-review-acceptance-packet.md) with
   exact store, app generation, fixtures, recipient, expected writes, limits and
   cleanup. Shared schema and live sends/orders require their own approval.
3. **M3 resources:** complete the [acceptance resource inventory](release-resource-inventory-2026-09-20.md)
   and [separate acceptance/production models in PR #113](https://github.com/satoshicancode/weletic-room-public/pull/113)
   with account-specific security, backup, email and full costs. Neither priced
   subtotal is a complete quote. Provision only after the corresponding approval.
4. **M2 import index:** keep PR #106 draft until the generated-column schema
   and provider/read-plan gates pass on the exact target. PR #107 supplies a
   read-only preflight, not migration approval or scale acceptance.
5. **M4 launch:** freeze enabled claims and release SHA, prove the
   [reviewer journey](app-store-reviewer-packet.md), then request publication and
   production activation separately. Monitor the first company-store writer for
   72 hours and execute longer-cycle paths explicitly.

Hiro has approved the implementation plan. Spending, shared/production schema
application, live sends/orders, publication, production activation and legacy-app
retirement remain separate execution gates. The first module launches when its
own requirements and S01–S06 pass; the other module remains on the full roadmap.
