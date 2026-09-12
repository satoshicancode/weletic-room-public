# ADR 0021: Isolated loyalty import tables

- Date: 2026-09-09
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

Imports need immutable provenance and separate execution evidence. Mock tests
cannot establish MySQL transaction or unique-index behavior. Applying the whole
Prisma schema would exceed the reviewed scope.

## Decision

Hiro approved creating only `WeleticLoyaltyImportSource`,
`WeleticLoyaltyImportRowSnapshot`, and `WeleticLoyaltyImportRowExecution` in
`weletic_loyalty_dev` at `127.0.0.1:3307`, then running guarded integration tests
with exact fixture cleanup. Generate only these CREATE TABLE statements from
Prisma; verify the database principal and absence of all three tables first.
Alter no existing tables. Production and Shopify remain excluded.

## Alternatives considered

- Full schema push: rejected because it can apply unrelated staged changes.
- Mocks alone: rejected because they cannot demonstrate database races.

## Consequences

### Positive

Real import source, execution and accounting tests can run in isolation.

### Negative / trade-offs accepted

MySQL DDL is not transactionally rolled back. Inspect any partial creation before
retrying; never silently adopt or overwrite existing tables.

### Follow-ups

Production migrations, new outbox types, store-approval schema and no-tier
rollback history remain separate gates. These tests do not prove complete import
or live Shopify acceptance.

## References

- [Import implementation](../loyalty/historical-import-implementation.md)
- Hiro's explicit approval in the loyalty completion task on 2026-09-09.
