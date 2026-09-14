# ADR 0034: Cloudflare Containers with managed persistent services

- Date: 2026-09-14
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

ADR 0032 authorized local compatibility testing, not a production topology.
PR #51 established bounded Node image/build evidence. The subsequent dependency
review found native MySQL and PlanetScale-compatible HTTP SQL clients, REST
Redis, QStash delivery/recovery and S3-compatible private storage. A successful
container startup does not replace these services or establish live acceptance.

The goal remains complete loyalty for company stores, beginning with named
public-app acceptance on `yamaxdev`. Rewriting persistence and queue semantics
would add a new financial/concurrency validation project to that launch path.

## Decision

Hiro selected Option A: Cloudflare Containers/R2 with compatible managed SQL,
Redis and QStash. Retain the Node applications, signed Shopify gateways,
existing queue contracts and database accounting/tenant/generation invariants.
Use Cloudflare for stateless application containers, ingress/scheduling and R2;
keep durable database, session, queue and private export state outside ephemeral
container disks. This authorizes implementation of the reviewed architecture.

This does not select a database vendor, paid plan, region, capacity or budget.
Inventory existing company resources before proposing new ones. Provisioning,
spending, image uploads, DNS, shared schema application, deployment, Shopify
installation/submission, real orders/redemptions/emails and old-app uninstall
retain their separate explicit execution gates. The illustrative sizing/cost
scenario in the review is not an approved allocation or spending limit.

## Alternatives considered

- **Workers/D1/KV/Queues rewrite** — rejected for this launch path: changes
  runtime, transaction and queue semantics before current loyalty acceptance.
- **Treat local probe images as release images** — rejected: they inject
  synthetic configuration and do not prove authenticated journeys, provider
  compatibility, supervision or real delivery.

## Consequences

### Positive

- Preserves existing financial and integration contracts during hosting work.
- Resolves the topology choice without implying SaaS billing or public onboarding.

### Negative / trade-offs accepted

- Requires services outside Cloudflare and separate provider/cost management.
- Database protocol, region latency, resource limits and job recovery still need
  deployment-specific verification; local evidence is insufficient.

### Follow-ups

- Implement fail-closed preflight, production entrypoints and fresh release builds.
- Preserve cron authentication and queue-retry ownership of compliance recovery.
- Inventory providers and select isolated namespaces, plans, region and budget.
- Rehearse target schema rollout, recovery and named live-store acceptance before
  production activation. Keep the full loyalty acceptance matrix open.

## References

- Hiro's explicit Option A selection in this task, September 14, 2026.
- [Topology review](../loyalty/cloudflare-topology-review-2026-09-14.md)
- [ADR 0032](0032-local-cloudflare-containers-compatibility.md)
- [Acceptance matrix](../loyalty/unified-acceptance-matrix.md)
