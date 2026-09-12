# ADR 0026: Audited company-store bootstrap

- Date: 2026-09-10
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Shopify authenticates an installation and its users, but does not define
Weletic's internal workspace structure. ADR 0025 makes installation credentials
store/app-owned, rather than owned by an arbitrarily selected Weletic user.
The admission mapper nevertheless requires a pre-existing Store, Project and
Program. An isolated public-app environment cannot inherit custom-app records.

Generic workspace onboarding has unrelated user, billing and invitation behavior.
An unknown App Store installation must not invoke that onboarding or provision
loyalty. Hiro explicitly approved a minimal audited setup command on September 10.

## Decision

Implement dedicated operator-only preview/apply bootstrap under
`apps/web/lib/weletic/shopify` and `apps/web/scripts/loyalty`. It creates only
the required per-store Project, Program, support records, Store and admission
mapping, with immutable operator/reason audit evidence in one transaction.
It binds exact app/shop identity, pending installation ID, generation and
revision, and verifies canonical Shopify identity/currency through the current
authenticated pending installation before committing. Caller input cannot
substitute for Shopify identity evidence.

Create no Weletic User, membership, generic InstalledIntegration, subscription,
invitation or customer. Keep store access pending and loyalty disabled or absent.
Provisioning neither publishes native credentials nor approves or activates the
store. Fresh authentication and company approval remain distinct gates. Normal
reinstallation uses the retained mapping, not first-store bootstrap.

## Alternatives considered

- **Existing-record mapping only** — preserves the current mapper but does not
  resolve provisioning in an empty isolated environment.
- **Generic onboarding or installer ownership** — introduces unrelated side
  effects and confuses Shopify store access with company/workspace authority.
- **Automatic provisioning on public installation** — violates the explicit
  company-store admission boundary for unknown installations.

## Consequences

### Positive

- An empty company environment can be prepared without fabricated user ownership.
- Exact preview fences and atomic audit records make provisioning attributable.
- Unknown installations still cannot create operational loyalty records by login.

### Negative / trade-offs accepted

- Initial provisioning requires a trusted operator and fresh Shopify evidence.
- Internal bookkeeping records need a dedicated minimal creation path and tests.

### Follow-ups

- Implement and independently review identity, transaction and concurrency fences.
- Verify collision, rollback, privacy/reinstall races and zero unrelated effects
  using fresh isolated MySQL fixtures and synthetic provider transport.
- Document any required schema delta; runtime DDL remains a separate approval.
- Obtain separate authority for endpoints, deployment, live installation and
  activation. This decision does not authorize any of those operations.

## References

- [Bootstrap specification](../loyalty/first-install-bootstrap-proposal.md)
- [Shopify-native identity](0025-shopify-native-store-installation-identity.md)
- [Company admission](0023-pending-public-installations.md)
- Hiro's September 10 approval of the audited minimal setup command in this task.
