# ADR 0025: Shopify-native store installation identity

- Date: 2026-09-09
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic is an embedded public Shopify app for approved company stores. ADR 0018
already permits a freshly verified Shopify owner to administer store-scoped
loyalty without a separate Weletic account. Shopify staff identity and Weletic
workspace membership are distinct authorities, not interchangeable IDs.

The generic Dub `InstalledIntegration` model requires a Weletic `User`. Current
Shopify credential readers depend on that model, but uninstall correctly deletes
its generation's credentials and installation row. Requiring that deleted row
or an arbitrarily selected workspace user to reconnect is an implementation
dependency, not a Shopify requirement. The proposed mandatory operator-owner
bootstrap would perpetuate that dependency and conflicts with ADR 0018.

## Decision

Use Shopify-managed installation, App Bridge identity verification and the
existing coordinated SDK token exchange for normal embedded installation and
reinstallation. Bind installation authority to the app and exact store, its
approved workspace mapping and current installation generation, not the first
installer. Preserve ADR 0018's current-owner verification, explicit store-scoped
staff grants and operation permissions. Do not grant global workspace membership
or use offline credentials to bypass a staff denial.

Remove the mandatory Weletic-user dependency from the Shopify credential path.
Prefer a Shopify-specific store/app credential boundary over weakening the
generic integration model for other providers. Installer/staff identity is
auditable attribution, not credential ownership. All credential consumers and
writers must use one generation-fenced source of authority; ambiguous or
divergent sources fail closed rather than falling back to stale credentials.

Company-store admission remains separate: unknown stores remain pending, with
no automatic workspace/customer provisioning. Reinstall verifies current Shopify
identity, valid retained store mapping and completed applicable cleanup before
new authentication is published. It does not reuse old tokens or staff grants,
inherit active company approval, or enable the disabled loyalty program.
Operator tools remain for initial company mapping and exceptional recovery,
not the normal reinstall path. Redaction/tombstone rules are unchanged.

## Alternatives considered

- **Require a Weletic user and operator bootstrap on every reinstall** — rejected
  because it makes normal Shopify authentication depend on unrelated user identity.
- **Equate the installer or matching email with a workspace administrator** —
  rejected because app installation permissions do not grant cross-store authority.
- **Retain old credentials through uninstall** — rejected because it weakens
  credential erasure and stale-generation rejection.
- **Make generic integration user ownership optional for every provider** — not
  selected; a Shopify-specific boundary limits compatibility and tenancy risk.

## Consequences

### Positive

- Normal merchant authentication stays inside Shopify.
- Uninstall/reinstall no longer depends on the original Weletic installer.
- Company approval and global workspace authority remain explicit and separate.

### Negative / trade-offs accepted

- Credential resolution, publication, callback, background jobs and privacy must
  be reconciled together; a schema-only change cannot establish readiness.
- Existing legacy/custom installations require a deliberate compatibility and
  cutover boundary, not an automatic credential copy into the public environment.

### Follow-ups

- Inventory all `InstalledIntegration` Shopify readers/writers, including paths
  outside the loyalty namespace, before changing runtime credential authority.
- Implement the scoped credential contract, guarded migration and shared resolver;
  preserve exact arithmetic, store/program lock order and session revision fencing.
- Prove actual post-uninstall state with zero generic installation rows, fresh
  token exchange, concurrent reinstall/approval, stale worker denial, owner/staff
  changes and privacy rollback in isolated tests and named `yamaxdev` acceptance.
- Retain separate approvals for runtime schema, deployment, live installation,
  activation, orders, emails and public release. This ADR deploys nothing.

## References

- Hiro approved the Shopify-native recommendation: “Tôi muốn theo tiêu chuẩn của shopify.”
- [ADR 0018](0018-shopify-owner-and-store-scoped-staff-access.md)
- [ADR 0023](0023-pending-public-installations.md), whose company admission remains valid.
- [Shopify-managed installation](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation)
- [Access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Implementation record](../loyalty/pending-installation-implementation.md)
