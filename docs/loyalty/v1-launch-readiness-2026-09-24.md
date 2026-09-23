# Weletic Room v1 launch readiness

Code baseline reconciled September 24, 2026: public `main` at
[`037e80fe`](https://github.com/satoshicancode/weletic-room-public/commit/037e80febde2b6ccedb67ddd5b0285d30f63f7c7)
(PR #112, [green post-merge CI](https://github.com/satoshicancode/weletic-room-public/actions/runs/35924317916)).
The store-review, prospective collection and shared-delivery code is merged.
Its shared schemas have not been applied to a release target, and neither
Loyalty nor Reviews has passed installed, provider and operational release gates.

The [combined completion checklist](company-store-completion.md) defines the
capability contracts and T1–T4 evidence classes. This index names each
capability's next blocking gate and launch milestone. A passing test applies
only to the exact revision and environment recorded in its evidence.
“Locally verified” describes the documented implementation subset and does not
mean installed acceptance. “Partial” identifies a named missing sub-capability.

| ID  | Capability                  | Implementation status                        | Current evidence                                                                                                                                                                                                                                                                   | Next blocking gate                                                          | Milestone |
| --- | --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- |
| L01 | Points/refunds              | locally verified; bounded live subset        | [Bounded live purchase/refund](yamaxdev-financial-acceptance-2026-09-19.md)                                                                                                                                                                                                        | Duplicate/crash, maturity/expiry and full ledger reconciliation             | M2        |
| L02 | Rewards/wallet              | locally verified; fixed discount live subset | Fixed discount live subset; [local boundaries](financial-reward-boundaries-2026-09-16.md), [voucher cleanup fix](https://github.com/satoshicancode/weletic-room-public/pull/104) and [isolated SQL reconciliation](https://github.com/satoshicancode/weletic-room-public/pull/105) | Every enabled reward lifecycle, real provider cleanup and use               | M2        |
| L03 | Subscription policies       | locally verified                             | [Local policy evidence](unified-acceptance-matrix.md)                                                                                                                                                                                                                              | Real renewal/first-N, mixed lines and immutable snapshots                   | M2        |
| L04 | VIP/campaigns               | locally verified                             | [Local VIP](vip-grace-acceptance-2026-09-16.md) and [campaign](campaign-accounting-acceptance-2026-09-16.md) evidence                                                                                                                                                              | Live transitions, notices and refund allocation                             | M2        |
| L05 | Referrals                   | locally verified                             | [Local account/anonymous lifecycle](referral-lifecycle-2026-09-17.md)                                                                                                                                                                                                              | Live claim, qualification, clawback and confirmation                        | M2        |
| L06 | Appearance/nudges           | implemented                                  | [Local controls](launcher-controls-2026-09-13.md)                                                                                                                                                                                                                                  | Installed theme, mobile, accessibility and locale journey                   | M2        |
| L07 | Shopper surfaces            | locally verified; bounded live subset        | Local components; bounded wallet live subset                                                                                                                                                                                                                                       | Installed authenticated journeys and failures across surfaces               | M2        |
| L08 | Communications              | implemented                                  | [Local producer implementation](communications-implementation.md)                                                                                                                                                                                                                  | Approved actual delivery, suppression and worker recovery                   | M2/M3     |
| L09 | Analytics/exports           | implemented; incomplete                      | [Report inventory](analytics-report-coverage.md); [S24 daily activity](https://github.com/satoshicancode/weletic-room-public/pull/102) merged, shared index unapplied                                                                                                              | S16–S18/S23, private exports, installed reconciliation and S24 index gate   | M2        |
| L10 | Historical imports          | locally verified at bounded scale            | [500-row pass; 8,100/50,000 failure](import-failure-evidence-2026-09-13.md); [read-only index preflight](https://github.com/satoshicancode/weletic-room-public/pull/107) merged; [indexed reader](https://github.com/satoshicancode/weletic-room-public/pull/106) draft            | Exact-target migration/provider gate, then 50,000 commits and rollbacks     | M2        |
| R01 | Invitations/submission      | locally verified                             | Local product path; prospective store path merged in PR #101                                                                                                                                                                                                                       | Installed fulfillment, inbox, scoped submit and retry                       | M1/M5     |
| R02 | Moderation/display          | locally verified                             | Local product path; store controls/widget merged in PR #101                                                                                                                                                                                                                        | Installed staff/theme journey, totals and privacy                           | M1/M5     |
| R03 | Open submissions            | implemented; account photos open             | Text gateway/account merged through PR #100                                                                                                                                                                                                                                        | Account photos and installed abuse/privacy journey                          | M5        |
| R04 | Incentive policy/disclosure | locally verified                             | [Local policy controls](review-policy-completion-worklog.md)                                                                                                                                                                                                                       | Schema rollout, installed disclosure and actual delivery                    | M1/M5     |
| R05 | Incentive fulfillment       | locally verified                             | Local product recovery; store competition merged in PR #101                                                                                                                                                                                                                        | Live points/coupon competition and ambiguous provider recovery              | M1/M5     |
| R06 | Invalidity/cost             | locally verified                             | [Local recovery](review-incentive-recovery.md)                                                                                                                                                                                                                                     | Installed adjudication and exact cost disposition                           | M5        |
| R07 | Store reviews               | locally verified; schema gated               | [Implementation worklog](store-review-core-worklog.md), merged PR #101, [storefront build](store-review-storefront-build-2026-09-24.md) and [acceptance packet](store-review-acceptance-packet.md)                                                                                 | Schema gate and installed SR-01–SR-07                                       | M1/M5     |
| R08 | Video/media                 | partial; video missing                       | Private photos local; video missing                                                                                                                                                                                                                                                | Bounded processor, privacy/object recovery and installed playback           | M5        |
| R09 | Q&A/translations            | partial; Q&A missing                         | Product translations merged in PR #97; Q&A missing                                                                                                                                                                                                                                 | Moderated Q&A, extended translations and installed journey                  | M5        |
| R10 | Review imports              | missing                                      | Missing                                                                                                                                                                                                                                                                            | CSV/Judge.me preview, provenance, dedupe and rollback                       | M5        |
| S01 | Identity/admission          | locally verified                             | Local implementation; bounded live overlap                                                                                                                                                                                                                                         | Install/reinstall, staff revocation and reviewer admission                  | M3        |
| S02 | Flow                        | locally verified                             | Trigger/action code merged; [action packet](flow-points-action-acceptance.md)                                                                                                                                                                                                      | Published workflows and exact live receipts                                 | M3        |
| S03 | Extensions/scopes           | implemented                                  | Partial preview proof; [default-config Shopify build](store-review-storefront-build-2026-09-24.md)                                                                                                                                                                                 | Public-app ownership, grants, account/theme and eligible checkout placement | M3        |
| S04 | Runtime/operations          | locally verified                             | [Isolated container proof](../../infra/cloudflare-release/ISOLATED-VERIFICATION.md); [explicit review route admission](https://github.com/satoshicancode/weletic-room-public/pull/112)                                                                                             | Provider compatibility, supervision, alerts and restore                     | M3        |
| S05 | Privacy/retention           | implemented                                  | Foundations and store/delivery consumers merged                                                                                                                                                                                                                                    | Schema compatibility and live export/erase races                            | M1/M3     |
| S06 | Listing/production          | missing acceptance                           | [Reviewer packet draft](app-store-reviewer-packet.md)                                                                                                                                                                                                                              | Accepted build, listing/reviewer approval and controlled activation         | M4        |

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

## Migration and runtime inventory

The repository has [29 checked-in Shopify-development SQL files](../../infra/shopify-development/migrations/).
The table below isolates the known v1 deployment candidates; it does not assert
which older files are already present on an acceptance or production database.
No exact-target schema inventory is available yet. M0's unapplied-migration
disposition therefore remains open until read-only target metadata is compared
with every candidate file and the current Prisma schema.

| Change                                                       | Source state                                              | Required before deployment                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loyalty daily activity `(storeId, createdAt)` index          | Merged in PR #102; shared application unverified          | Exact target metadata, reviewed DDL and read-plan acceptance                                                                                                                                                           |
| Store-review five-table core                                 | Merged PR #101; only disposable SQL rehearsed             | Create all five before privacy readers; retain export-phase-compatible workers                                                                                                                                         |
| Review collection/reminder settings and history              | Merged PR #101; only disposable SQL rehearsed             | Schema before readers/jobs; retain reminder export phase                                                                                                                                                               |
| Shared shopper delivery tables, settings and outbox labels   | Merged PR #101; only disposable SQL rehearsed             | Schema before sender/privacy workers; reconcile old exports and uncertain sends                                                                                                                                        |
| Historical import tables, enums and nullable no-tier history | Code merged; target-specific schema status unverified     | Run the [read-only import audit](historical-import-schema-release-gate.md) against each exact target, then separately approve compatible DDL                                                                           |
| Historical import ledger generated source column and index   | Draft PR #106 only; read-only preflight merged in PR #107 | Prove generated-column/index compatibility and read plan on the exact provider; approve DDL separately before deploying the indexed reader. Do not run `prisma db push` afterward because it removes the column/index. |

Do not infer a target database's schema from a merged SQL file or disposable
rehearsal. Capture exact target metadata and mixed-version worker compatibility
before any shared migration. MySQL DDL requires forward containment after a
partial application.

## Next execution packets

1. **M1 installed:** PR #101 code, the size-compliant default-config storefront
   build and PR #112's guarded review routes are verified locally. Rehearse exact
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
