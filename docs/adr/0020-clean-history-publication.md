# ADR 0020: Clean-history public repository

- Date: 2026-09-08
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

The project needs a public source repository with standard GitHub-hosted Actions. The existing private repository contains historical credential-bearing commits and retained development evidence that must not become public merely by changing repository visibility.

Credential rotation protects active services, but does not establish the safety of every historical upstream capability. Publishing the existing Git history would therefore require additional owner verification or history rewriting and removal of cached historical references.

## Decision

Create a separate clean-history repository, `satoshicancode/weletic-room-public`, from an audited snapshot of the existing default branch. Keep `satoshicancode/weletic-room` private with its original history and PR records. Do not rewrite or force-push its history.

Preserve license and attribution notices. Do not transfer private environment files, deployment credentials, logs, artifacts, Git objects, or historical PR discussions. Recreate approved pending changes as newly based branches and PRs, checking their complete contents before transfer. A private source-to-public commit mapping may preserve operational traceability without importing historical objects.

Audit the copied workflow definitions and configure repository permissions before enabling Actions. Previously disabled unsafe integration workflows must not be re-enabled merely because this is a new repository. CI results remain merge gates; publication does not waive testing or security review.

## Alternatives considered

- **Publish existing history unchanged** — rejected because unresolved historical authentication capabilities would become publicly accessible.
- **Rewrite existing history in place** — rejected in favor of preserving the private record and avoiding force-pushes, cached PR references, and disruption to existing checkouts.
- **Remain private indefinitely** — does not meet the approved public-source and standard-runner objective.

## Consequences

### Positive

- Public history begins at an auditable boundary without importing sensitive historical objects.
- Existing private development history and evidence remain recoverable.

### Negative / trade-offs accepted

- Historical blame and old PR discussions remain in the private repository.
- Open branches and integrations require deliberate migration rather than a simple remote visibility change.

### Follow-ups

- Verify snapshot contents, workflow permissions, publication state, and public CI execution.
- Migrate approved pending PRs without bypassing their verification gates.
- Keep runtime configuration and private recovery evidence outside the public repository.

## References

- Hiro's approval of clean-history publication in the project discussion on 2026-09-08.
- Existing project license and attribution files, retained in this snapshot.
