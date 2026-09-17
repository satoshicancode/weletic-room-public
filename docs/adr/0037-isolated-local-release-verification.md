# ADR 0037: Isolated local release verification

- Date: 2026-09-17
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Cloudflare web/outbox candidate recipes exist, but Docker Desktop is stopped.
Restarting its daemon may resume saved containers and background jobs. Local
image verification must not reactivate unrelated services or use retained live
credentials. Synthetic recipe tests do not prove image startup or shutdown.

## Decision

Hiro approved a separate isolated local Docker environment. Use a dedicated Lima
VM and explicit Unix socket for release verification. Do not start Docker Desktop,
switch its default context, import its containers/volumes, or mount the host home
directory into the VM. Install the pinned, checksum-verified Lima binary under a
task-specific user-local directory; no system package manager is required.

Bound the VM to four CPUs, 8 GiB RAM and an 80 GiB sparse disk. Run builds
sequentially, capped at two CPUs and at most 6 GiB with no swap. Runtime smoke
containers use no external network, no published ports, synthetic configuration,
read-only filesystems and at most two CPUs/2 GiB. Stop the dedicated VM after work;
retain its cache for repeatable verification unless separately asked to remove it.

This is local verification authority only. Cloud uploads, paid resources, DNS,
shared schema changes and real Shopify/email actions remain gated by ADR 0034.

## Alternatives considered

- **Restart Docker Desktop** — rejected because saved workloads may resume.
- **Accept static recipe tests alone** — rejected because native dependencies,
  packaging, production dispatch and shutdown require actual execution evidence.

## Consequences

### Positive

- Existing Docker Desktop state and application services remain untouched.
- Build and runtime evidence has an explicit, reproducible isolation boundary.

### Negative / trade-offs accepted

- Additional local tool, VM disk and duplicated dependency caches are required.
- VM setup downloads operating-system/container tooling; runtime smoke tests must
  separately enforce network isolation and must not inherit host secrets.

### Follow-ups

- Record tool/image checksums, VM settings, build results and exact cleanup.
- Do not mark image or deployment acceptance complete after a failed/partial run.

## References

- Hiro's explicit isolated-Docker approval in this task.
- [Managed-services topology](0034-cloudflare-containers-managed-services.md)
- [Release preparation](../../infra/cloudflare-release/README.md)
- [Lima installation](https://lima-vm.io/docs/installation/)
