# ADR 0032: Local Cloudflare Containers compatibility proof

- Date: 2026-09-13
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Cloudflare is the intended hosting platform, but ADR 0031 deliberately separates
code integration from deployment. The existing application comprises Next.js,
an embedded Remix app, and Node-based loyalty workers. Framework support alone
does not establish packaging, dependency or shutdown compatibility.

Hiro approved a local-only Containers compatibility implementation after PR 50.
This resolves permission to build and test that candidate locally, not the final
production topology or any external execution gate.

## Decision

Add isolated runtime packaging and verification under `infra/cloudflare-local`.
Exercise the existing application processes without changing authentication,
ledger arithmetic, tenant boundaries, installation-generation fences or schemas.
Keep runtime-specific build changes opt-in; existing deployment defaults remain.
Use synthetic configuration, no inherited host secrets, and isolated local tests.

No deployment, image upload, paid resource creation, DNS change, shared schema
application or live-store activity is authorized. Local compatibility evidence
must distinguish build, process, emulator and database-backed evidence; one does
not imply the others. Do not mark loyalty accepted from this proof.

## Alternatives considered

- **Immediately deploy Containers** — rejected: production dependencies, resource
  costs, security configuration and schema rollout remain unreviewed.
- **Start with a Workers/OpenNext adaptation** — deferred: first measure the
  existing Node applications in containers before accepting a runtime rewrite.
- **Keep producing unrelated small fixes** — insufficient to resolve the known
  runtime prerequisite for named live-store acceptance.

## Consequences

### Positive

- Enables concrete packaging and process-lifecycle evidence without cloud writes.
- Preserves current financial and Shopify contracts while evaluating hosting.

### Negative / trade-offs accepted

- Local images and tests consume disk/CPU and do not prove cloud availability.
- A failed compatibility experiment may still require a different topology.

### Follow-ups

- Verify Next, Remix and worker packaging, configuration rejection and shutdown.
- Review persistent services, isolation, worker supervision, regions and costs.
- Obtain separate reviewed schema/deployment authority before any live execution.

## References

- Hiro's affirmative approval in this task on September 13, 2026.
- [ADR 0031](0031-import-code-integration-release-separation.md)
- [Cloudflare local Containers](https://developers.cloudflare.com/containers/guides/local-dev/)
