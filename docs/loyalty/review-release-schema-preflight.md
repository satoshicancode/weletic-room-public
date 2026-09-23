# Review release schema preflight

The read-only `audit-review-release-schema.ts` command checks whether a selected
MySQL database has the essential schema shape required by the merged store-review,
collection/reminder and shared-delivery readers. It is a **necessary check, not
migration approval or full compatibility proof**. The [M1 acceptance packet](store-review-acceptance-packet.md)
still requires exact target metadata review, additive DDL approval, isolated
rehearsal, mixed-version export/delivery workers and installed acceptance.

Generate the Prisma client from the exact release checkout before the audit;
record that source SHA with the target metadata. Run with a deliberately selected
database and a read-only account. Provide
`DATABASE_URL` through a private process environment, never through a tracked
file, shell history, command argument, PR or log. From the repository root:

```sh
pnpm --filter web exec tsx scripts/loyalty/audit-review-release-schema.ts
```

The command reads only `information_schema.TABLES`, `COLUMNS` and `STATISTICS`.
It reports fixed object/column/index issue codes and exits nonzero if the selected
schema is missing or incompatible. It never reads customer rows, applies DDL,
starts a worker or enables a module. Connection errors produce a fixed message
so driver diagnostics cannot disclose the target URL.

The check covers the five store-review tables, the reminder table, two shared
delivery tables, the collection fields on existing review settings/requests,
the shared delivery policy field, the append-only outbox enum and every index
declared for the eight new tables. It compares all scalar/enum columns of those
Prisma models with target metadata and checks release-critical state/identity
enum domains, private column types/nullability and disabled-by-default values.
Extra compatible columns are allowed. Passing does not
prove defaults, grants, provider-specific DDL behavior, existing data, transaction
semantics, background jobs or rollback of persisted export phases.

Local verification at the source revision of this document: nine focused
preflight/store-schema tests passed; the command returned `ready: true` against
the disposable MySQL import-scale fixture, where current Prisma tables and the
candidate provenance index had been applied. The fixture account had DML but no
DDL permission. That result says nothing about any shared or production schema;
their metadata has not been audited by this command.
