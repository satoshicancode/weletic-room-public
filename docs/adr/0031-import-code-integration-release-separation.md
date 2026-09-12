# ADR 0031: Separate import code integration from release

- Date: 2026-09-12
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (impl)

## Context

PR #13 passed its code checks but remained draft because import tables are also
required by existing privacy processing. Disabling the merchant import UI does
not make deployment to an unprepared database safe. Browser, maximum-size and
live acceptance were also outstanding and had been grouped with the merge hold.

Hiro confirmed that Cloudflare is the intended hosting platform and deployment
setup is still pending. Repository inspection found only the quality workflow
active, no repository webhooks and no recorded deployments. This is a dated
observation, not a guarantee about future hosting connections.

## Decision

Hiro explicitly approved code-only integration without database changes,
deployment, worker startup or loyalty activation. PR #13 was squash-merged as
`a09df959abe4540914b1bf03863fbd0d31099c55`. This supersedes only the draft/merge
hold in ADR 0024 and historical checkpoint notes; its transaction design and
all schema, privacy and release requirements remain in force.

Code integration is not feature acceptance. Any future Cloudflare connection
or runtime start must treat this main revision as schema-dependent. Review the
exact target schema, rollout order and runtime compatibility before deployment;
do not infer release permission from this merge or from a green quality gate.
Cloudflare's deployment mechanism and runtime topology are not selected here.

## Alternatives considered

- **Keep the PR draft until all live acceptance passes** — rejected because it
  unnecessarily blocks code integration when deployment is not connected.
- **Deploy with imports hidden** — rejected because privacy consumers still
  require the import tables even without merchant import activity.

## Consequences

### Positive

- Follow-up work can start from public main without a long-lived import branch.
- Merge evidence and release evidence have distinct, explicit meanings.

### Negative / trade-offs accepted

- Main must not be deployed or started against an unprepared database.
- Historical draft statements need the superseding decision linked prominently.

### Follow-ups

- Complete authenticated browser and maximum-size upload/staging acceptance.
- Complete real-worker 50,000-row commit/rollback and independent reconciliation.
- Verify exact-target schema compatibility and privacy failure/retry recovery.
- Review worker supervision and named yamaxdev acceptance before activation.
- Obtain separate approval for schema application and Cloudflare deployment.

## References

- [PR #13](https://github.com/satoshicancode/weletic-room-public/pull/13)
- [ADR 0024](0024-bounded-import-rollback-transactions.md)
- [Schema release gate](../loyalty/historical-import-schema-release-gate.md)
