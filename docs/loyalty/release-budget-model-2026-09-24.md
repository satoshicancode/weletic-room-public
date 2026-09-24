# Separate acceptance and production budget models — September 24, 2026

Status: **planning models, not complete quotes or spending approval**. These
models separate the first Loyalty release from the later Reviews increment. No
resource was created or upgraded. The [resource inventory](release-resource-inventory-2026-09-20.md)
remains the account and compatibility gate.

## Read-only evidence and rate inputs

- PlanetScale CLI 0.324.0 listed one accessible organization and zero accessible
  databases on September 24. This is an inventory of the current CLI identity,
  not proof that no company database exists elsewhere. The September 20 Tokyo
  PS-10/PS-20 compute figures below are **stale provisional inputs**, not an
  account quote. Storage, backups, branches and network remain unpriced.
- Cloudflare account, Upstash account and Resend sender/plan ownership are
  unverified. The merged [Shopify runtime-image fix](https://github.com/satoshicancode/weletic-room-public/pull/119)
  at `373cdbe2` was built locally from the same source content and is
  980 MB unpacked and passed a no-network local startup smoke. The previous
  Shopify recipe produced a 4.47 GB image and exceeded the `basic` 4 GB disk. This
  establishes local Shopify image-size headroom only; the web/outbox measurements
  are recorded below, and Cloudflare deployment compatibility remains unverified.
- A local Linux/amd64 outbox build from public `main` `373cdbe2` succeeded with
  two CPUs, 2 GiB memory and no swap. `docker image ls` reports **4.55 GB**
  virtual/unpacked size (the manifest inspection reports 816,622,999 bytes) for
  image `sha256:0484c20a32632eb1997a3418433729980021a337d7e97c49bfb3112a16aaec5e`
  (build log `/tmp/weletic-outbox-image-373cdbe2-build.log`, SHA-256
  `c64c76b1454220f39a3b5508ffe13371ac03e2f74d9a187e0d2fbde9f092fab5`).
  The proposed `basic` outbox has only 4 GB disk, so the conservative local
  unpacked-size gate fails. This was a local build only; no runtime, provider or Cloudflare
  admission test was performed. The scoped image below resolves this local size
  failure; provider admission remains separate.
- A local Linux/amd64 web build from public `main` `febe7b69` also succeeded
  under a bounded two-CPU, 6 GiB, no-swap build. `docker image ls` reports
  **4.86 GB** virtual/unpacked size (manifest inspection 862,727,112 bytes)
  for image `sha256:9c9aa2cd39351ceb248ea8dd1c1df07da59244e68d5f61e5902abfbb82256898`
  (build log `/tmp/weletic-web-image-febe7b69-build.log`, SHA-256
  `44335cd746e77f14c5933f3f05858835d3c03c8527f1bd263355eff0e34781ce`).
  The proposed 4 GB web disk therefore fails the same conservative local gate.
  Neither web nor outbox baseline image was uploaded to Cloudflare.
- The [merged scoped-runtime image fix](https://github.com/satoshicancode/weletic-room-public/pull/120)
  was built from `febe7b69` plus the image change and reduces
  the Docker virtual/unpacked web and outbox sizes to **3.15 GB** and **2.84 GB**.
  The [footprint record](release-runtime-footprint-2026-09-24.md) contains immutable
  image IDs, build-log hashes and limits. Both real no-network, read-only
  runtime smokes passed, including generated Prisma loading and Next route/auth
  rejection. Exact PR-head CI and [post-merge CI](https://github.com/satoshicancode/weletic-room-public/actions/runs/35957419207) passed. This establishes local 4 GB disk headroom
  only; Cloudflare admission and deployed memory proof remain open.
- [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
  lists $5/month Workers Paid base, 25 GiB-hours memory, 375 vCPU-minutes and
  200 GB-hours disk included, then $0.0000025/GiB-second,
  $0.000020/vCPU-second and $0.00000007/GB-second. [Custom instance limits](https://developers.cloudflare.com/containers/platform/limits/)
  permit a 1 vCPU / 3 GiB / 4 GB web candidate. Image size must fit the selected
  disk. Container egress, Workers requests/CPU, Durable Objects and logs are
  separate billable dimensions.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  includes 10 million requests and 30 million CPU-ms/month, then $0.30/million
  requests and $0.02/million CPU-ms. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  includes 400,000 GB-s/month, then $12.50/million GB-s, rounded to whole
  million billable units; an object that cannot hibernate can incur idle
  wall-clock charges. [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  includes 20 million events/month, then $0.60/million; retained logs need a
  privacy and retention review.
- [Redis pricing](https://upstash.com/pricing/redis) is $0.20/100,000 commands
  on pay-as-you-go; [QStash pricing](https://upstash.com/pricing/qstash) is
  $1/100,000 **delivery attempts**, with retries billed again. Each Prod Pack
  adds $200/month and includes at-rest encryption and an SLA; whether both
  packs are required for the selected data and workload is unresolved.
- [R2 Standard pricing](https://developers.cloudflare.com/r2/pricing/) is
  $0.015/GB-month after 10 GB-month free, with separate Class A/B operations.
  [Resend Pro pricing](https://resend.com/pricing) is $20/month for 50,000
  transactional emails, with paid overage above that. Resend [states that
  message content and delivery logs are stored in the United States](https://resend.com/security/gdpr),
  regardless of the sending region; provider choice and data-transfer review
  remain open.

## Candidate footprints and arithmetic

Both models assume 720 hours/month and **separate billing accounts**, so each
uses its own included allowances. If acceptance and production share an account,
recalculate the allowances once across both environments. These are chosen
usage scenarios, not measured load or upper billing bounds. The previous
web and outbox images exceeded 4 GB. PR #120's merged images fit that disk
locally, but provider admission and actual resource use are unverified. The
arithmetic below is an illustrative partial subtotal, not a deployable resource
proposal.

| Assumption                      | Acceptance, one controlled company store                                                                | Production, first accepted module                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Containers                      | One 1 vCPU / 3 GiB / 4 GB web; one `basic` Shopify; one `basic` outbox (**PR #120 images fit locally**) | Two web; two Shopify; one `basic` outbox writer (**PR #120 images fit locally**) |
| Aggregate provisioned resources | 1.5 vCPU, 5 GiB memory, 12 GB disk                                                                      | 2.75 vCPU, 9 GiB memory, 20 GB disk                                              |
| Container CPU utilization       | 5% while continuously running                                                                           | 10% while continuously running                                                   |
| Worker ingress                  | 100,000 requests at 10 ms CPU each                                                                      | 5 million requests at 10 ms CPU each                                             |
| Durable Objects                 | Three objects assumed awake all month                                                                   | Five objects assumed awake all month                                             |
| Redis / QStash                  | 1 million commands / 100,000 attempts                                                                   | 10 million commands / 1 million attempts                                         |
| R2 Standard                     | 20 GB-month, below free operation limits                                                                | 100 GB-month, below free operation limits                                        |
| Transactional email             | One provisional Resend Pro plan                                                                         | One provisional Resend Pro plan                                                  |

The container line is calculated as `$5 + max(0, GiB-hours - 25) × 3600 ×
$0.0000025 + max(0, GB-hours - 200) × 3600 × $0.00000007 +
max(0, busy-vCPU-hours - 6.25) × 3600 × $0.000020`. It yields **$42.74** for
acceptance and **$80.48** for production. The five production objects consume
1,620,000 GB-s if awake all month; after the 400,000 included GB-s and
whole-million billable rounding, this scenario is **$25**. Three acceptance
objects yield **$12.50**. Actual hibernation and account-wide usage must be
measured. Workers CPU is $0 in the acceptance scenario and $0.40 in the
production scenario; request count is within the included 10 million.

| Known-price component                    | Acceptance USD/month | Production USD/month | Qualification                                            |
| ---------------------------------------- | -------------------: | -------------------: | -------------------------------------------------------- |
| Containers including Workers Paid base   |                42.74 |                80.48 | Candidate sizing, continuous operation                   |
| Durable Objects, awake-duration scenario |                12.50 |                25.00 | Actual object lifetime unverified                        |
| Workers requests and CPU                 |                 0.00 |                 0.40 | Scenario above, shared allowance unverified              |
| PlanetScale Vitess compute               |                47.00 |                71.00 | September 20 regional catalogue; **not** a current quote |
| Upstash Redis pay-as-you-go              |                 2.00 |                20.00 | Excludes storage/bandwidth and Prod Pack                 |
| QStash pay-as-you-go                     |                 1.00 |                10.00 | Includes assumed retries in attempt count                |
| R2 Standard storage                      |                 0.15 |                 1.35 | Assumes operation counts stay in free tiers              |
| Resend Pro                               |                20.00 |                20.00 | Provisional provider/plan, no overage                    |
| **Partial scenario subtotal**            |           **125.39** |           **228.23** | **Illustrative only; provider admission and costs open** |

The first-module production model excludes Reviews video. A later 1 vCPU /
3 GiB / 4 GB video worker active and fully busy for 100 hours adds about
**$10.00** in container charges before processing, storage, network, queue and
monitoring effects. It cannot be folded into the Loyalty production approval.
The production layout also needs actual load, failover and one-financial-writer
proof before being selected.

## Missing amounts that prevent approval

| Item             | Evidence needed before a complete acceptance and production quote                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL              | Account-owned Tokyo Vitess quote, storage growth, backup retention, restore tests, branching, transfer, compatible native/HTTP transactions and lock behavior.                                                                                             |
| Cloudflare       | Account plan/allowance ownership, exact release-SHA builds, provider image admission, real CPU and sleep behavior, container egress region/volume, Workers/DO/log usage, registry/image retention and alert pricing.                                       |
| Redis and QStash | Account/region, keys and payload classification, selected security plan, actual retries, schedules, storage, bandwidth, DLQ retention and budget-cap failure behavior. Selecting both $200 Prod Packs adds **$400/month** before any other missing charge. |
| R2 and media     | Private buckets, Class A/B operations, media retention and cleanup, video processor limits and incident storage.                                                                                                                                           |
| Email            | Approved sender/domain and recipient policy, account plan, expected transactional volume, overage cap, deliverability and US processing review.                                                                                                            |
| Operations       | Monitoring and paging, audit-log retention, backups/restore, DNS/certificates, taxes, exchange rates, incident reserve, overlap with existing apps and any separate acceptance account base fees.                                                          |

The earlier proposed **$300/month acceptance ceiling is still unapproved and
incomplete**. The partial acceptance subtotal is not a request to spend $125.39;
it omits material charges. The production subtotal is a separate model, not a
production budget or a deployment authorization. A packet becomes approval-ready
only after every missing line is either priced from the selected account/plan or
explicitly shown to be inapplicable, with measured capacity, a total monthly
ceiling, alert thresholds and containment. Keep existing apps running until
retirement receives its own approval.
