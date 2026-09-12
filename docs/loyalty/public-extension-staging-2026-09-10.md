# Offline public extension staging — September 10, 2026

Implements the packaging step of the
[extension reconciliation inventory](public-extension-reconciliation-2026-09-10.md).
This is not ownership, deployment, live shopper or Flow acceptance evidence.

Subsequent [build evidence](public-extension-build-2026-09-10.md) records successful
UI/theme builds, stable local candidate IDs and the public product-points initial
display correction. It supersedes the bundle-build gap in this historical receipt.

## Implemented

`infra/shopify-development/stage-public-extensions.mjs` builds a 34-file package
containing ten reviewed extensions, a public app configuration, a minimal package
manifest and source-hash receipt. It copies only an explicit file allowlist.

- Removes all inherited extension UIDs. Any source TOML change must first pass a
  review and update the pinned manifest hash; quoted/escaped UID spellings cannot
  evade removal. Text replacements additionally require exact source anchors.
- Keeps thank-you rendering, excluding Plus-only checkout reductions, POS, the
  free-product Function, review blocks/assets and partner conversion tracking.
- Retains the five loyalty theme assets and all three available theme locales.
  Account/thank-you locale inventories are preserved as present, not invented or
  claimed complete. Existing initial-render gaps remain in the inventory.
- Changes only staged UI/Flow URLs to the approved public app/backend origins.
- Builds in memory before writing; rejects symlinked source files and creates only
  a new mode-0700 directory directly under the canonical OS temporary directory.
  Files are mode 0600 and exclusive-create. Existing destinations are never reused.
- No environment files, secrets, dependencies, custom identities or unknown files
  are copied. No network, installation, provisioning or deployment is performed by
  the staging tool. The checked-in public configuration still disables discovery.

Run the tool with a new directory under the canonical OS temporary directory:
`node infra/shopify-development/stage-public-extensions.mjs <new-temporary-directory>`.
Its `STAGING.json` deliberately says `unowned_not_deployable`. A partial stage after
an I/O failure remains unowned and must not be reused or deployed.

## Verification and a rejected identity result

Five focused tests passed: exact inventory, no inherited IDs, source hashes,
endpoint/target changes, theme dependency closure, partner-control removal,
changed-source rejection (including four alternate UID spellings), exclusive
destination creation and custom-manifest preservation. Web types and root lint
passed. Independent review found the original textual UID-format gap; pinned
source hashes fixed it and re-review found no remaining offline-staging blocker.

A private temporary stage was passed to `shopify app config validate --json` with
telemetry disabled. CLI returned `valid: true`, `issues: []`, but also inserted ten
local UIDs. Critically, the thank-you extension received the same UID as the
retained custom checkout extension. That package is **rejected as public ownership
evidence** and has not been deployed. Syntax validity does not prove safe identity.
The source checkout and custom manifest remained unchanged.

### Collision correction and local candidate mapping

Inspection of the installed CLI's `buildUIDFromStrategy` confirmed that an absent
UID is derived from the extension handle. The staged thank-you manifest now has
the explicit handle `weletic-public-loyalty-thank-you` and the name
`Weletic Loyalty Thank You`. The custom manifest and its hash are unchanged.
The new exact-anchor transformation passed the five focused tests and independent
re-review. A fresh temporary package again passed CLI validation with no issues.
Independent comparison found ten unique candidate UIDs and no matches against the
eleven UIDs in all twelve retained custom extension manifests.

The following mapping preserves **local candidates only**. It is not a remote
registration receipt and must not be promoted to a deployment manifest without
the remaining ownership and build gates. The first colliding package remains
rejected; no stage has been deployed.

| Extension                                           | Local candidate UID                            |
| --------------------------------------------------- | ---------------------------------------------- |
| `loyalty-checkout-slider` (public thank-you handle) | `273ad8ae-e263-466c-c0b3-a040a44de963b8e40c2e` |
| `weletic-analytics`                                 | `01a76e14-840f-6c0b-186c-df2a5e7016c9e65724f9` |
| `weletic-customer-account`                          | `81203e9c-7cf8-4edf-48d9-f4cc3d8d78e194508205` |
| `weletic-customer-account-blocks`                   | `34ae9ffa-d82a-c0bd-9e6c-0098431d74b4f785924a` |
| `weletic-flow-lifecycle`                            | `599fded7-dfa8-b82a-29f5-039e370e6f60cd3fb5ed` |
| `weletic-points-earned`                             | `7f144949-377f-f70f-52c9-c08a145037d7c8ad5d13` |
| `weletic-points-expiring-soon`                      | `0de310fe-7c17-8dd0-cea0-9145fef07b524cc9865e` |
| `weletic-referral-completed`                        | `e4090cbb-167b-494b-0136-652bcebaa49d5c312baa` |
| `weletic-reward-redeemed`                           | `ddbfe489-4190-b6f1-3a66-991112d46bcd9a3a0a95` |
| `weletic-vip-tier-changed`                          | `fc4687f3-1b57-dacd-2fdb-6e45d54f577e434a0a99` |

## Next execution gates

1. Record authoritative public registration evidence for the local candidates.
   Repeat the disjointness/uniqueness audit when adopting the public mapping. Do not
   copy the rejected validation result into a deployable configuration.
2. Build the staged UI/theme extensions with the declared dependencies; CLI schema
   validation is not a bundle build. Preserve stable identities on rebuild.
3. Complete public backend isolation and approved deployment gates, then named
   `yamaxdev` install/reinstall, customer-data/network access, shopper and real Flow
   acceptance. A4 and the overall loyalty goal remain open.
