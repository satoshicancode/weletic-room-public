# Free-first local acceptance — September 26, 2026

Status: local synthetic evidence only. Paid acceptance provisioning is pending;
the current execution path uses existing local Docker resources. No purchase,
shared schema change, real email, Shopify order, tunnel, publication or production
activation was performed in this slice.

Runtime source: `7622573c9a434ec262b278eba900dd8b3b28cced`. The follow-up test
fixture changes and this record are in [PR 176](https://github.com/satoshicancode/weletic-room-public/pull/176).
See the [canonical checklist](core-launch-checklist.md) for remaining launch gates.

## Environment and boundaries

- Fresh local databases `weletic_loyalty_it_core_20260926` and
  `weletic_loyalty_it_verify_20260926`, scoped test users and
  current Prisma schema. Existing databases and user/import work were preserved.
- MySQL 8 through the existing local container and a local SQL HTTP simulator;
  local Redis and private-media service. This does not certify managed Vitess,
  Cloudflare Containers, R2 or QStash compatibility or durability.
- Web on loopback port 8890 and Shopify process on loopback port 3002, with
  `WELETIC_FEATURE_PROFILE=core-v1`. These processes were stopped after probes.
- MailHog on loopback SMTP 11026 and inbox 18026. No external relay or delivery.
- No Partner API credential supplied to the runtime. SQL review fixtures use
  explicitly synthetic app/shop/installation subscription records; production
  subscription checks remain active. These fixtures are not billing approval.
- MySQL's published port changed after container restart. Discover it with
  `docker port`; do not reuse an old port or touch an unrelated listener.

Private operator logs and local runner scripts are under
`/tmp/weletic-free-first-20260926`. They are temporary local evidence, not a
portable deployment package; do not publish its credential file.

## Results

| Check                                             | Result                    | Limit                                                                                                                                                                |
| ------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local HTTP probes                                 | 7/7 passed                | Unsigned session/internal/outbox/billing requests rejected; foreign host rejected; login renders; signed absent-session read succeeds. No installed Shopify session. |
| Explicit core SQL selection                       | 9/9 passed                | Real MySQL transactions; synthetic subscription, transport and storage dependencies.                                                                                 |
| Production review email renderer and SMTP adapter | EN/JA/VI captured locally | Synthetic content, `.test` recipients, intentionally nonfunctional fixture link. Not fulfillment-to-review acceptance or inbox deliverability.                       |
| Broad pre-change SQL suite in legacy profile      | 124/125 passed            | Deferred referral final-cap-slot race failed; root cause not established. It remains a P1 follow-up, not a green full-suite result.                                  |

The full native-review SQL file was rerun after the fixture change on a second
fresh database: **114 passed, 1 core-only test skipped** in the legacy profile,
including the original customer-erasure test.

The core selection covers concurrent ledger entries, idempotency, holding release,
refund rollback, bearer-token single use, atomic review award rollback, moderation
deduplication, photo/privacy locking and expired-billing invitation rejection.

Initial core review tests failed because the legacy fixture had no mapped
installation or fresh subscription. The fixture now creates explicit local
authority and refreshes its five-minute validity using database time. An expiry
test verifies that this setup has not bypassed the production gate.

The broad customer-erasure test depends on crash/open-review fixtures from earlier
tests in its file. Running it alone is not valid: its expected unrelated customer
records are absent. Its assertions remain unchanged; it is excluded from the
focused selection. No claim of isolated core end-to-end erasure acceptance is made.

## Reproducing the focused SQL selection

Use an isolated database whose name starts with `weletic_loyalty_it_`, a scoped
test user, the current local schema, and the existing SQL HTTP test configuration.
Provide `DATABASE_URL`, `PLANETSCALE_DATABASE_URL` and the test configuration privately;
never load a shared or production environment into this command. From `apps/web`:

```sh
LOYALTY_DATABASE_INTEGRATION=1 WELETIC_FEATURE_PROFILE=core-v1 \
  pnpm exec vitest run --config vitest.loyalty-db.config.ts \
  --testNamePattern 'serializes distinct concurrent|deduplicates a concurrent idempotency|serializes holding release|rolls back refund source|consumes one bearer token|rolls back review points|concurrently publishes once|does not write a photo when privacy|core billing expiry'
```

The broad review suite must run on a fresh database: its failure-injection checks
add table-wide constraints that conflict with retained rows from an earlier run.
A reused-database rerun exposed two such setup failures; no production service
assertions were relaxed to accommodate them.

This is a named selection, not the full legacy capability suite under core mode.
Deferred capability tests must retain their original profile.

## Next execution boundary

Prepare a separate bounded yamaxdev dev-store packet: verify immutable shop and
app identities, local HTTPS tunnel routing, required extensions and synthetic
fixtures before any installation/configuration write, test order or real send.
Local success does not close Partner-hosted pricing, Flow workflow receipts,
native discount checkout/refund, private R2, real inbox, protected-data review,
backup restoration or persistent-worker acceptance.

Persistent acceptance and production still use the proposed Cloudflare topology.
The [resource and rollout packets](core-launch-execution-packets.md) remain
proposals; previous budget discussion does not authorize purchases during this
free-first phase.
