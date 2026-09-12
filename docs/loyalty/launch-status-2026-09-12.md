# Loyalty launch status — September 12, 2026

**Historical snapshot:** the code/publication statuses below are as of PR #27.
For later merged work through PR #37, use the
[September 13 public integration update](unified-acceptance-matrix.md#current-public-integration--september-13-2026).
In particular, redemption, account-backed referral and discount reward-expiry
communications are now integrated; a later full-scale import failure is recorded.
The conclusion remains **not ready to launch**. No live gate is closed by those
merges, and the remaining-work definitions below still require current evidence.

**Not ready to launch.** This reconciles public code integration through
`a3d8c28422281ea550bda6913dd72fb38d07edb9` (PR #27). It does not certify a
deployment, an installed app version, delivery or any live acceptance gate.
The [acceptance matrix](unified-acceptance-matrix.md) remains the requirement
checklist; the [September 9 backlog](smile-parity-backlog-2026-09-09.md) retains
field-level scope, dependencies, test cases and definitions of done.

## Corrections to older snapshots

- PR #13 is merged as `a09df959abe4540914b1bf03863fbd0d31099c55`, not an open
  draft. [ADR 0031](../adr/0031-import-code-integration-release-separation.md)
  separates code integration from schema application and release. The original
  checkout's unrelated/unpublished import changes remain preserved.
- PR #15 is merged as `69149d76d898b6e14c5c54c5cd07568821e704f9`. Its
  [public merge receipt](https://github.com/satoshicancode/weletic-room-public/pull/15)
  records native ownership, pending admission/status, audited bootstrap and
  isolated public configuration/staging. Runtime schema and live installation
  remain gated; local candidate extension IDs are not remote ownership proof.
- PR #18 is merged as `cfd241e62c97749954ee82c446586aa48e80e6be`. It sanitizes
  referral delivery errors; it does not complete referral communication journeys
  or repair historical stored errors.
- Appearance and nudges are no longer wholly absent: PRs #19 and #21 merged.
  Their bounded implementation does not establish full appearance parity.
- Communications are no longer universally `not_connected`. The current signed
  gateway reports `purchase_signup_birthday_vip_and_expiry_policies`, supported
  by PRs #17, #20, #22, #23 and #24. This is producer integration, not evidence of
  enabled policies, real delivery or completed referral/redemption/reward-expiry
  journeys. Older checkpoint documents describe their own dated state.
- PR #26 (`f5da1ec60af3aeca27610b414161d6560495c1c6`) rejects absent financial
  scope evidence before a fresh remote-attempt marker is persisted. That safety
  fix does not establish stored-value eligibility or complete shopper capability UX.
- PR #27 adds the isolated full-lifecycle test harness. Its six pre-merge checks
  passed. The 500-row lifecycle passed with independent exact SQL totals and
  empty-fixture reconciliation. A full 50,000-row run was started separately;
  **no terminal full-scale result is available at this checkpoint**. See the
  [import implementation](historical-import-implementation.md) for evidence limits.

## Complete workstream disposition

No live acceptance checkbox changes as a result of this reconciliation.

| Backlog                  | Current evidence level                                                      | Remaining launch work                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L00 Reference/repository | Written reference disposition captured; public code integrated              | Retain explicit unknowns; finish provenance/identity evidence under A2–A5. No repeat paid Smile access is required to start implementation.             |
| L01 Points lifecycle     | Existing code and isolated accounting evidence                              | Named purchase/signup/birthday/manual, maturity/expiry/replay, partial/full refund and independent SQL acceptance.                                      |
| L02 Rewards/wallet       | Bounded drawer/wallet evidence; financial scope guard merged                | Every supported reward lifecycle, truthful capability unavailability, checkout usage, cancellation/refund and ambiguity/retry acceptance.               |
| L03 Subscriptions        | Immutable purchase-policy contracts/editors merged                          | Real first/first-N/renewal classification, mixed orders, replay and native discount acceptance; no subscription selling/contract management.            |
| L04 VIP                  | Tier editors/lifecycle and achievement producer code exist                  | Named progression, entry rewards, history, grace/downgrade and delivery; resolve remaining policy unknowns explicitly.                                  |
| L05 Campaigns            | Shared campaign editor/contracts exist                                      | Schedule/target/VIP intersection, running-policy immutability, allocation/refund races and live lifecycle evidence.                                     |
| L06 Referrals            | Core flow/Flow producer and privacy fix exist                               | Full share/claim/qualification/fulfillment/clawback, abuse cases, friend/advocate policy integration and funnel acceptance.                             |
| L07 Appearance           | Nine existing fields exposed by signed editor in PR #19                     | Remaining device/spacing/shape/order/default-view controls, media handling and full EN/JA/VI embedded acceptance.                                       |
| L08 Nudges               | Three preset-icon editors/runtime in PR #21                                 | Uploaded icons/managed media and broader appearance parity; explicit campaign-prompt disposition; full live eligibility/dismissal acceptance.           |
| L09 Other surfaces       | Existing implementations; bounded local core evidence                       | Landing/product/account/thank-you surfaces across locales, mobile, keyboard, loading/error/permissions and privacy.                                     |
| L10 Communications       | Purchase/signup/birthday/VIP/points-expiry integration merged               | Redemption, referral friend/advocate and reward-expiry policy-to-delivery integration; remaining source/lease/privacy races; all named live deliveries. |
| L11 Analytics            | Signed exact export/editor foundation                                       | Sequential referral funnel/cohort exposure, report reconciliation, independent SQL/export evidence and live filters.                                    |
| L12 Imports              | PR #13 and full-lifecycle harness merged; isolated gateway/500-row evidence | Full 50,000-row terminal proof/cleanup, authenticated maximum-size browser/HTTP journey, runtime schema gate and named live acceptance.                 |
| L13 Store approval       | PRs #5/#15 code and isolated bootstrap evidence                             | Actual fresh authentication, install/reinstall, unknown-store containment, audited company approval and stale-generation acceptance.                    |
| L14 Public identity      | Separate local config and offline stage/build exist                         | HTTPS/backend namespace isolation, authoritative extension ownership/UIDs, public install/reinstall and privacy permissions.                            |
| L15 Flow                 | Trigger definitions and producers exist                                     | Publish and prove real workflows; implement staff-authorized idempotent adjustment action after its authorization decision.                             |
| L16 Operations/privacy   | Workers and guards exist                                                    | Deployed supervision, alerts/dead letters/stuck jobs, retries, generation/privacy races, retention cleanup and kill-switch/recovery rehearsals.         |
| L17 Platform/release     | Cloudflare selected; deployment setup pending                               | Runtime topology decision, permission/capability approvals, limited free listing submission and separate production rollout.                            |
| Q Verification           | Local and public CI evidence at named revisions                             | Complete applicable A–G gates with named `yamaxdev` evidence. Simulated transports and synthetic orders remain explicitly labeled.                      |

## Execution order and explicit decisions

1. Finish or diagnose the supervised full-scale import run; preserve its exact
   verdict, cleanup and resource evidence. Do not weaken proof or extend
   production deadlines merely to pass it.
2. Complete remaining local feature/contract gaps against L01–L17, retaining the
   signed gateways and accounting, tenant and generation invariants. Merged
   changes do not allow unreviewed runtime schema application.
3. Select the Cloudflare runtime topology. Existing approval names Cloudflare,
   not Containers versus a Workers-native adaptation. This is an architectural
   decision, not an environment variable to guess. ADR 0031 leaves it open.
4. Under separate execution authority, apply the reviewed runtime schema and
   isolated deployment, then public identity/authentication and approved-store
   gates. Only afterward perform authorized live shopper/worker/Flow/delivery
   acceptance and reconcile independent SQL.
5. Submit the free limited-visibility listing only after its required gates.
   Production `weletic.com` rollout and old custom-app removal remain separate;
   no SaaS billing, public onboarding funnel or excluded reviews work is added.

Other explicit dependencies remain in their backlog tasks: approved store
timezone, subscription fixtures, stored-value capability/currency/refund policy,
Flow action authorization and live mutation approvals. Neither this inventory
nor a green CI run supplies those decisions or authorizations.
