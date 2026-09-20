# Persistent acceptance resource packet — draft inventory

Status: incomplete proposal, **not provisioning or spending approval**.
Scope: S04/S06 under the approved company-store Loyalty and Reviews plan.
Source baseline: public main `a6965d65079cd57fc15f558d977bace14790f4c0`.

## Read-only account evidence

September 20, 2026 JST:

- PlanetScale CLI 0.324.0 successfully listed one accessible organization; an
  explicit database list for that organization returned `[]`. No database was
  created. This proves only the accessible organization's inventory, not that
  the company owns no database elsewhere. Account identifiers are omitted here.
- No Cloudflare or Upstash management connector is available in this session.
  Neither CLI is on PATH or in this checkout's dependency-bin inventory. The
  earlier release README records unauthenticated Wrangler; this run did not
  repeat that authentication check or infer current account/resource state.
- Cloudflare account/Workers plan, R2 buckets, Upstash Redis and QStash resources,
  billing ownership and usable regions remain **unverified**, not absent.
- No login, credential creation, provider mutation, image upload, DNS change,
  schema application, subscription upgrade or external communication occurred.

## Proposed acceptance footprint

Retain ADR 0034: Node containers and private R2, MySQL-compatible SQL with the
existing HTTP client protocol, REST Redis and QStash. No D1/Postgres rewrite.
This packet covers a persistent acceptance environment only; production is a
separate gate and must not silently inherit test databases or credentials.

| Component               | Candidate                                              | Required proof before purchase/deployment                                                                                |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Web/API                 | One container, trial sizing 1 vCPU / 3 GiB / 4 GB disk | Exact image fits disk, load/cold-start/heap evidence, route admission and private logging                                |
| Shopify app             | One `basic` container                                  | Fresh image fits disk, real embedded authentication and paired gateway                                                   |
| Outbox                  | One independently supervised `basic` container         | Drain/restart, lease recovery, scheduling and no accidental idle shutdown                                                |
| Reviews video processor | Separate bounded worker, sizing not selected           | Codec/quota implementation, measured peak resources, unsafe-file isolation; never hide this cost in outbox capacity      |
| SQL                     | Isolated PlanetScale Vitess candidate                  | Region/plan quote, native and HTTP connections to the same database, real transaction/lock/concurrency suite and restore |
| Redis                   | Dedicated Upstash-compatible REST database             | Owned region/plan, isolation and required command semantics; no legacy fallback                                          |
| QStash                  | Separately scoped queue/callback credentials           | Actual provider isolation controls, retries, signed callbacks, scheduling and dead-letter retention                      |
| R2                      | Private media/export storage, separate from legacy     | Access policy, signing, retention/erasure and exact-object cleanup; no public raw-media bucket                           |

Prefer a Japan-adjacent SQL/Redis placement for the first company store, subject
to actual provider region availability and measured container-to-database latency.
Do not claim that Cloudflare placement implies a fixed Japanese location or data
residency. Final region selection and compliance review remain outstanding.

## Cost inputs checked September 20

These are public rate inputs, not account-specific quotes or total estimates:

- Cloudflare Containers: Workers Paid base $5/month; memory $0.0000025 per
  additional GiB-second, CPU $0.000020 per additional vCPU-second, disk $0.00000007
  per additional GB-second. Included usage is 25 GiB-hours, 375 vCPU-minutes and
  200 GB-hours monthly. Memory/disk bill provisioned resources while active;
  CPU bills active usage. [Provider pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- `basic` is 1/4 vCPU, 1 GiB memory and 4 GB disk. Custom instances require at
  least 1 vCPU and 3 GiB per vCPU. Image size must fit instance disk, so the
  candidate footprint is not accepted until image sizes are checked.
  [Provider limits](https://developers.cloudflare.com/containers/platform/limits/)
- Redis pay-as-you-go advertises $0.20 per 100K commands. A configured budget
  cap can rate-limit the database, so reaching it must fail closed and alert,
  not silently bypass locks. No availability add-on is assumed included.
  [Provider pricing](https://upstash.com/pricing/redis)
- QStash pay-as-you-go advertises $1 per 100K messages. Each delivery attempt,
  including retries, is billed; no free-retry assumption. Plan retention and
  isolation must be chosen before deployment.
  [Provider pricing](https://upstash.com/pricing/qstash)
- PlanetScale's regional catalogue, retrieved September 20 at 02:19 UTC,
  identifies AWS Tokyo (`ap-northeast-1`, catalogue selector `ap-northeast`).
  Its Vitess PS-10 three-node cluster is $47/month (1/8 vCPU, 1 GiB per node);
  PS-20 is $71/month. These are cluster compute prices, not an account quote
  including storage/options. Do not substitute a cheap Postgres offer.
  [Regional catalogue](https://planetscale.com/pricing.md?region=ap-northeast)

The earlier three-container sensitivity range excludes SQL, video processing,
Redis/QStash, storage, networking, images, logging, email and taxes. It must not
be presented as the total cost of this expanded Loyalty + Reviews release.

## Proposed region and planning envelope — not authorized

Recommend an acceptance-only Tokyo PS-10 Vitess cluster and a single-primary
Tokyo Redis database, subject to compatibility and load tests. Upstash lists
Tokyo as a primary region; no read replicas are assumed.
[Redis regions](https://upstash.com/docs/redis/features/globaldatabase).
Use Cloudflare placement near these dependencies where available, but measure
actual latency. R2 location hints and QStash routing are not a Japanese residency
guarantee. Confirm their processing locations before using non-synthetic data.

The following is a reproducible **scenario**, not measured workload or a bill
guarantee. Assume 720 hours/month; the first three containers run continuously
(5 GiB memory, 12 GB disk, 1.5 vCPU provisioned in aggregate). Expected CPU
utilization is 5%; stress assumes 100%. Model video separately at 1 vCPU,
3 GiB and 4 GB disk, fully busy for 20 or 100 hours, respectively. Video remains
disabled until resource limits, image fit and safe processing are proved.

| Monthly item                                                      | Expected scenario, USD | Stress scenario, USD |
| ----------------------------------------------------------------- | ---------------------: | -------------------: |
| Containers including video and Workers base                       |                  44.74 |               126.61 |
| Vitess PS-10 cluster compute                                      |                  47.00 |                47.00 |
| Redis: 1M / 10M commands, <=1 GB and included bandwidth           |                   2.00 |                20.00 |
| QStash: 100K / 1M attempts, including retries, included bandwidth |                   1.00 |                10.00 |
| R2 Standard: 20 / 100 GB-month; within free operation quotas      |                   0.15 |                 1.35 |
| Priced subtotal                                                   |              **94.89** |           **204.96** |
| Unpriced-services planning reserve, not a provider quote          |                  50.00 |                75.00 |
| Planning envelope before tax                                      |             **144.89** |           **279.96** |

Container arithmetic uses monthly aggregate allowances once, assuming they are
unused elsewhere: memory `max(0, GiB-hours - 25) * 3600 * 0.0000025`,
disk `max(0, GB-hours - 200) * 3600 * 0.00000007`, and CPU
`max(0, busy-vCPU-hours - 6.25) * 3600 * 0.000020`, plus $5 base.
This includes video memory/disk only during its bounded active hours. A worker
that remains awake beyond those hours invalidates this assumption.

R2 Standard is $0.015/GB-month after the first 10 GB; this scenario assumes
less than 1M Class A and 10M Class B operations. Direct R2 egress is free,
not all application/container networking.
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).
Redis storage/bandwidth overages, QStash bandwidth and Prod Packs are not
included in their table entries; no paid add-on is selected. Prod Packs are
not merely SLA upgrades: the current Redis and QStash pricing pages also list
encryption at rest and security/compliance features in these packs. Before
non-synthetic use, verify selected-plan at-rest protection and inventory keys,
payloads, headers, delivery logs and dead-letter data for sensitive content.
Do not infer that TLS or pseudonymous identifiers eliminate this requirement.
Redis advertises +$200/month per database and QStash +$200/month; selecting
both would add $400, moving these envelopes to $544.89/$679.96 before tax.
That exceeds the proposed ceiling and requires a revised approved proposal,
not silently weaker controls. Neither add-on necessity nor base-plan security
adequacy has been established by this draft.

The reserve must cover a verified quote for SQL storage/backup/restore and
any paid development branch, Workers/DO request and duration usage, logs,
image registry, container egress, monitoring and transactional email. It is
not proof those services fit. In particular, Durable Objects can bill wall-clock
duration while unable to hibernate, separately from container CPU.
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
No extra replica, second environment, concurrent blue/green deployment or
autoscaling is assumed. Shared-account free allowances, taxes and currency
conversion may change actual charges. Stress is **not an upper billing bound**.

Proposed approval ceiling: **$300/month before tax for acceptance only**, with
alerts at $150/$225 and a forecast-to-ceiling alert. This is a requested budget,
not an approved spend or provider-enforced cap. Before provisioning, price every
reserve item and prove the estimate fits; otherwise return a revised bundle.
At forecast breach, stop admitting new acceptance traffic/video jobs, disable
affected writers and pause producers with an audit trail. Retain privacy handling,
durable queues and financial history; never cut database access mid-transaction
or treat Redis rate limiting as permission to bypass locks. Existing provider
charges may continue after containment. Production needs a separate estimate.

## Conditions for one approval-ready bundle

1. Complete read-only Cloudflare/Upstash inventory using authorized account
   access; identify reusable plans without sharing application credentials.
2. Obtain an account-specific Vitess quote including storage/options; measure
   native/HTTP compatibility. Verify Redis/QStash security plans and payload
   sensitivity before proposing any non-synthetic workload.
3. Finalize worker/media footprint, image sizes and scheduler ownership. Keep
   one bounded writer per responsibility, with independent monitoring.
4. Price the complete footprint at expected and upper-bound usage, including
   retries, storage growth, retention, video processing and backup/restore.
5. Present one resource list, region choice, monthly spending ceiling and
   proposed alerts/containment for approval. If provider caps can interrupt
   service, disclose that trade-off. A cost alert is not a hard billing cap.
6. Only after approval create isolated resources/secrets; rehearse migrations,
   restore and environment-dependent acceptance before public submission or
   activating either module on weletic.com.

This inventory does not close S04/S06. Local + CLI remains the approved primary
development path while persistent-environment prerequisites are unresolved.
