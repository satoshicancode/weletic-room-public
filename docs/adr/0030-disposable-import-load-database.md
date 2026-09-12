# ADR 0030: Disposable import-load database

- Date: 2026-09-12
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

The synthetic 50,000-row import profile exhausted the existing development
MySQL container's 768 MiB memory limit. Docker killed that server and interrupted
fixture cleanup. It was restored to healthy status; the disposable fixture and
temporary grant were removed. Repeating large loads on that server risks unrelated
development databases even when each test uses a separate schema.

## Decision

Hiro explicitly approved a separate disposable MySQL instance with a 2 GiB memory
limit, bound only to `127.0.0.1:3308`. Use the already available pinned MySQL image,
a fresh data volume and freshly generated test-only credentials. Do not share
sessions, credentials, data volumes or application services with port 3307.

Only synthetic fixtures and generated schemas may be written to this instance.
Verify its identity, memory limit, loopback binding and empty fixture state before
testing. Clean test rows and revoke temporary privileges afterward; stop the
disposable container when this execution finishes. This approval does not cover
shared-schema changes, application startup, deployments or live Shopify writes.

## Alternatives considered

- **Repeat on the existing instance** — rejected after the OOM incident because
  database-level isolation does not isolate server memory failure.
- **Increase the existing instance's limit** — rejected because it changes shared
  development infrastructure and leaves unrelated databases in the blast radius.
- **Weaken proof or raise transaction deadlines** — rejected; passing a benchmark
  must not remove provenance, ownership, containment or financial checks.

## Consequences

### Positive

- Resource failures are isolated from existing development databases.
- Load evidence uses explicit, reproducible resource limits.

### Negative / trade-offs accepted

- Adds a temporary 2 GiB memory budget and disposable storage.
- Results do not establish performance at the old 768 MiB limit or in production.

### Follow-ups

- Re-run ordinary regressions and the populated-source profile.
- Optimize query shape without changing proof or transactional boundaries.
- Retain full-scale, authenticated, supervised and live acceptance gates.

## References

- [Bounded rollback](0024-bounded-import-rollback-transactions.md)
- [Import implementation](../loyalty/historical-import-implementation.md)
- [Draft PR #13](https://github.com/satoshicancode/weletic-room-public/pull/13)
- Hiro's explicit approval in this task following the September 12 OOM report.
