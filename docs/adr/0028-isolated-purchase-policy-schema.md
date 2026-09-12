# ADR 0028: Isolated purchase-policy schema

- Date: 2026-09-10
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

After ADR 0027's installation tables were applied, read-only compatibility checks
found three missing `purchasePolicy` columns. Current Prisma reads reproduced
P2022 on earning rules, rewards and referral rules. The remaining ten schema
differences retain import/review structures and are outside the focused rollout.

## Decision

Hiro approved applying only `20260908_loyalty_purchase_policy.sql` to
`127.0.0.1:3307/weletic_loyalty_dev`, after a fresh private snapshot. It adds one
nullable JSON column to each of the three affected tables. Verify target identity,
stopped writers, exact migration contents, resulting columns and Prisma reads.
Preserve all ten unrelated differences and the frozen import work.

Runtime startup, deployment, installation, loyalty activation, orders, emails and
production changes are not included. Do not execute the full Prisma diff.

## Alternatives considered

- **Start the runtime without the columns** — rejected because reads already fail.
- **Apply the full schema diff** — rejected because it removes retained data
  structures and narrows types needed by unrelated work.
- **Remove purchase-policy support from code** — rejected because subscription
  eligibility remains part of the approved loyalty scope.

## Consequences

### Positive

- Resolves the confirmed missing-column incompatibility without removing data.
- Nullable storage preserves existing application-level policy defaults.

### Negative / trade-offs accepted

- MySQL DDL is non-atomic; keep writers stopped during any partial failure.
- Successful empty-table reads do not prove live purchase-policy behavior.

### Follow-ups

- Record snapshot/migration hashes and read-only postflight evidence.
- Complete public-app release gates under separate execution approvals.

## References

- [ADR 0027](0027-isolated-installation-schema-and-hostnames.md)
- [PR #15](https://github.com/satoshicancode/weletic-room-public/pull/15)
- Hiro's explicit approval in this task on September 10, 2026.
