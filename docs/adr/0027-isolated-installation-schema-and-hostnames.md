# ADR 0027: Isolated installation schema and hostnames

- Date: 2026-09-10
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

PR #15 implements pending admission and store-owned credentials. Its consumers
cannot safely run before their tables exist. Prior approvals covered the audited
bootstrap command and earlier store-approval schema, not these two migrations.

The public-app test environment must remain isolated from the custom app and
production. Selecting future HTTPS hostnames must not implicitly expose services.

## Decision

Hiro explicitly approved applying only `20260909_pending_installations.sql` and
`20260909_store_owned_shopify_credentials.sql` to
`127.0.0.1:3307/weletic_loyalty_dev`, after a private snapshot and target checks.
Keep application and worker writers stopped; verify the resulting schema and
record the outcome. Do not execute an unfiltered Prisma schema diff.

Reserve configuration-only origins `https://loyalty-shopify-dev.weletic.com` and
`https://loyalty-api-dev.weletic.com`. Keep the existing loopback runtime policy
and custom-app TOML unchanged. DNS, public routing, deployment, installation,
loyalty activation, orders, emails, and production changes remain unapproved.

## Alternatives considered

- **Defer all schema work until deployment** — rejected because isolated schema
  verification should precede release and live installation.
- **Apply the full schema diff** — rejected because unrelated retained tables and
  frozen import changes are outside this approval.
- **Enable public routing with hostname configuration** — rejected because
  exposure and installation are separate execution gates.

## Consequences

### Positive

- Unblocks local schema compatibility verification without public side effects.
- Makes the narrow execution authority explicit and auditable.

### Negative / trade-offs accepted

- MySQL DDL is non-atomic; partial failure requires inspection with writers stopped.
- Hostname configuration alone does not provide a working public application.

### Follow-ups

- Record snapshot digest, migration hashes, schema comparison and row checks.
- Complete PR #15 release review; obtain separate public exposure/install approval.

## References

- [PR #15](https://github.com/satoshicancode/weletic-room-public/pull/15)
- [ADR 0025](0025-shopify-native-store-installation-identity.md)
- [ADR 0026](0026-audited-company-store-bootstrap.md)
- Hiro's explicit approval in this task on September 10, 2026.
- [Execution evidence](../loyalty/isolated-installation-schema-2026-09-10.md)
