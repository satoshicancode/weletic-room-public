# ADR 0023: Pending public installations without workspaces

- Date: 2026-09-09
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

Weletic uses a public Shopify registration for company stores, not a SaaS
onboarding funnel. Unknown installations must authenticate and receive required
privacy handling without gaining customer synchronization or loyalty authority.
The existing store model requires a project and program. PR #5 adds audited
store approval but cannot represent an installation before that mapping exists.

SDK sessions and session coordination are authentication infrastructure, not an
admission decision. Treating their existence as approval would bypass the company
store gate. Fabricating a workspace for every installation would introduce the
self-service provisioning explicitly excluded from the product.

## Decision

Persist a separate app/canonical-shop-scoped pending-installation record. Keep
workspace/program/store creation and loyalty activation operator-controlled.
Provide a signed, fresh authenticated approval-status projection and an EN/JA/VI
embedded screen. Never expose credentials, shopper identifiers, or an approval
write endpoint to merchants.

Integrate installation generation, session revision and lifecycle handling with
the existing session coordination and privacy boundaries. Operator mapping must
be audited, revision/generation fenced and exact-store bound. Uninstall and
redaction must fence stale authentication and approval operations; reinstall must
not silently inherit active loyalty authority.

## Alternatives considered

- **Automatically create a workspace and program** — rejected because unknown
  installations must not create company resources or self-onboard.
- **Use SDK sessions as approval state** — rejected because credential refresh,
  invalidation and deletion are not durable admission decisions.
- **Keep only the existing store gate** — rejected because an unmapped install
  needs a truthful status and lifecycle handling before a store exists.

## Consequences

### Positive

- Unknown stores can receive a useful status without customer-data access.
- Existing company-store approval remains explicit and auditable.

### Negative / trade-offs accepted

- A new schema and a pre-mapping lifecycle must be maintained and reconciled
  with the existing session and mapped-store lifecycle.

### Follow-ups

- Implement and test authentication, signed status, operator mapping, uninstall,
  redaction, concurrent approval/reinstall and cross-store denial.
- Review the migration separately before application. This decision authorizes
  implementation, not live installs, activation, deployment or shared schema use.

## References

- Hiro's September 9 approval of the pending-installation record/status screen.
- [Store approval foundation](../loyalty/store-approval-implementation.md)
- [Remaining company-store work](../loyalty/smile-parity-backlog-2026-09-09.md#l13--company-store-approval)
