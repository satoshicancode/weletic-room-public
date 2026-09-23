# Weletic Room v1 launch readiness

Reconciled September 24, 2026. Public `main` is
`83324a01b9c8e29de4ec216e1a53e8717e239981` (PR #102, green post-merge CI).
[Draft PR #101](https://github.com/satoshicancode/weletic-room-public/pull/101)
contains unpublished store-review, collection and shared-delivery work. Its
current local branch includes a merge from public main and a Shopify build fix;
those local changes are not shipped until the PR passes its own gate. Neither
Loyalty nor Reviews has passed installed, provider and operational release gates.

The [combined completion checklist](company-store-completion.md) defines the
capability contracts and T1–T4 evidence classes. This index names each
capability's next blocking gate and launch milestone. A passing test applies
only to the exact revision and environment recorded in its evidence.

| ID  | Capability                  | Current evidence                                                                                                      | Next blocking gate                                                  | Milestone |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| L01 | Points/refunds              | [Bounded live purchase/refund](yamaxdev-financial-acceptance-2026-09-19.md)                                           | Duplicate/crash, maturity/expiry and full ledger reconciliation     | M2        |
| L02 | Rewards/wallet              | Fixed discount live subset; [local boundaries](financial-reward-boundaries-2026-09-16.md)                             | Every enabled reward lifecycle and remote cleanup                   | M2        |
| L03 | Subscription policies       | [Local policy evidence](unified-acceptance-matrix.md)                                                                 | Real renewal/first-N, mixed lines and immutable snapshots           | M2        |
| L04 | VIP/campaigns               | [Local VIP](vip-grace-acceptance-2026-09-16.md) and [campaign](campaign-accounting-acceptance-2026-09-16.md) evidence | Live transitions, notices and refund allocation                     | M2        |
| L05 | Referrals                   | [Local account/anonymous lifecycle](referral-lifecycle-2026-09-17.md)                                                 | Live claim, qualification, clawback and confirmation                | M2        |
| L06 | Appearance/nudges           | [Local controls](launcher-controls-2026-09-13.md)                                                                     | Installed theme, mobile, accessibility and locale journey           | M2        |
| L07 | Shopper surfaces            | Local components; bounded wallet live subset                                                                          | Installed authenticated journeys and failures across surfaces       | M2        |
| L08 | Communications              | [Local producer implementation](communications-implementation.md)                                                     | Approved actual delivery, suppression and worker recovery           | M2/M3     |
| L09 | Analytics/exports           | [Report inventory](analytics-report-coverage.md); S24 code merged                                                     | Missing source-backed reports, private exports and reconciliation   | M2        |
| L10 | Historical imports          | [500-row pass; 8,100/50,000 failure](import-failure-evidence-2026-09-13.md)                                           | Root-cause evidence, then 50,000 commits and rollbacks              | M2        |
| R01 | Invitations/submission      | Local product path; prospective store path in draft #101                                                              | Installed fulfillment, inbox, scoped submit and retry               | M1/M5     |
| R02 | Moderation/display          | Local product path; store controls/widget in draft #101                                                               | Installed staff/theme journey, totals and privacy                   | M1/M5     |
| R03 | Open submissions            | Text gateway/account merged through PR #100                                                                           | Account photos and installed abuse/privacy journey                  | M5        |
| R04 | Incentive policy/disclosure | [Local policy controls](review-policy-completion-worklog.md)                                                          | Schema rollout, installed disclosure and actual delivery            | M1/M5     |
| R05 | Incentive fulfillment       | Local product recovery; store competition in draft #101                                                               | Live points/coupon competition and ambiguous provider recovery      | M1/M5     |
| R06 | Invalidity/cost             | [Local recovery](review-incentive-recovery.md)                                                                        | Installed adjudication and exact cost disposition                   | M5        |
| R07 | Store reviews               | [Draft worklog](store-review-core-worklog.md) and [acceptance packet](store-review-acceptance-packet.md)              | Current-head CI, schema gate and SR-01–SR-07                        | M1/M5     |
| R08 | Video/media                 | Private photos local; video missing                                                                                   | Bounded processor, privacy/object recovery and installed playback   | M5        |
| R09 | Q&A/translations            | Product translations merged in PR #97; Q&A missing                                                                    | Moderated Q&A, extended translations and installed journey          | M5        |
| R10 | Review imports              | Missing                                                                                                               | CSV/Judge.me preview, provenance, dedupe and rollback               | M5        |
| S01 | Identity/admission          | Local implementation; bounded live overlap                                                                            | Install/reinstall, staff revocation and reviewer admission          | M3        |
| S02 | Flow                        | Trigger/action code merged; [action packet](flow-points-action-acceptance.md)                                         | Published workflows and exact live receipts                         | M3        |
| S03 | Extensions/scopes           | Partial preview proof                                                                                                 | Ownership, grants, account/theme and eligible checkout placement    | M3        |
| S04 | Runtime/operations          | [Isolated container proof](../../infra/cloudflare-release/ISOLATED-VERIFICATION.md)                                   | Provider compatibility, supervision, alerts and restore             | M3        |
| S05 | Privacy/retention           | Foundations merged; draft store/delivery consumers                                                                    | Schema compatibility and live export/erase races                    | M1/M3     |
| S06 | Listing/production          | [Reviewer packet draft](app-store-reviewer-packet.md)                                                                 | Accepted build, listing/reviewer approval and controlled activation | M4        |

## Migration and runtime inventory

| Change                                                       | Source state                                          | Required before deployment                                                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Loyalty daily activity `(storeId, createdAt)` index          | Merged in PR #102; shared application unverified      | Exact target metadata, reviewed DDL and read-plan acceptance                                                                                 |
| Store-review five-table core                                 | Draft PR #101; only disposable SQL rehearsed          | Create all five before privacy readers; retain export-phase-compatible workers                                                               |
| Review collection/reminder settings and history              | Draft PR #101; only disposable SQL rehearsed          | Schema before readers/jobs; retain reminder export phase                                                                                     |
| Shared shopper delivery tables, settings and outbox labels   | Draft PR #101; only disposable SQL rehearsed          | Schema before sender/privacy workers; reconcile old exports and uncertain sends                                                              |
| Historical import tables, enums and nullable no-tier history | Code merged; target-specific schema status unverified | Run the [read-only import audit](historical-import-schema-release-gate.md) against each exact target, then separately approve compatible DDL |

Do not infer a target database's schema from a merged SQL file or disposable
rehearsal. Capture exact target metadata and mixed-version worker compatibility
before any shared migration. MySQL DDL requires forward containment after a
partial application.

## Next execution packets

1. **M1 PR #101:** finish storefront asset/source drift check, complete code and
   migration self-review, run current-head suites/builds and CI. Keep the PR draft
   until its reviewer and compatibility packet is complete.
2. **M1 installed:** use [SR-01–SR-07](store-review-acceptance-packet.md) with
   exact store, app generation, fixtures, recipient, expected writes, limits and
   cleanup. Shared schema and live sends/orders require their own approval.
3. **M3 resources:** complete the [acceptance resource inventory](release-resource-inventory-2026-09-20.md)
   with account-specific security, backup, email and full costs; present a
   separate production quote. Provision only after the corresponding approval.
4. **M4 launch:** freeze enabled claims and release SHA, prove the
   [reviewer journey](app-store-reviewer-packet.md), then request publication and
   production activation separately. Monitor the first company-store writer for
   72 hours and execute longer-cycle paths explicitly.

Hiro has approved the implementation plan. Spending, shared/production schema
application, live sends/orders, publication, production activation and legacy-app
retirement remain separate execution gates. The first module launches when its
own requirements and S01–S06 pass; the other module remains on the full roadmap.
