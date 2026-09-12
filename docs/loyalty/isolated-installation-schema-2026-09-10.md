# Isolated installation schema execution — September 10, 2026

Authority: [ADR 0027](../adr/0027-isolated-installation-schema-and-hostnames.md).
Source migrations: PR #15 at `02d29b6dafcc4c26879f52f2d70cd062155b86e7`.

## Applied and verified

Only `127.0.0.1:3307/weletic_loyalty_dev` was modified. The staging helper checked
the Docker Compose project, volume, loopback binding, database principal and
server UUID. Ports 8890/3002 were stopped, there were no other runtime database
connections, and Store row count was zero before and after execution.

The private pre-DDL snapshot is 261,942 bytes, SHA-256
`50fa22e03091545f25d620d7f8bbbbbf1f12ebf3fa0e11897ccac0bfdeb7a314`.
It is retained outside Git in the isolated environment's private secret directory
with mode 0600 (directory 0700). Snapshot contents are not published.

| Reviewed migration                             | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `20260909_pending_installations.sql`           | `7a490b95b7b6160f20e8e1ba7bd1e6ddacbcee0f5a7f7b8180b1093d705ae80b` |
| `20260909_store_owned_shopify_credentials.sql` | `1a971d7930834e0762eda59dc9c104f3759aff90b0ae07329d9fa6e190afdc5f` |

Exactly three CREATE TABLE statements completed:

- `WeleticShopifyPendingInstallation`
- `WeleticShopifyPendingInstallationChange`
- `WeleticShopifyInstallationCredential`

Postflight and a separate read-only verification invocation found all three
tables present, empty, and without differences against the branch Prisma model.
The helper compared definitions while normalizing index order and whitespace;
it executed the hash-pinned reviewed SQL, never the generated Prisma diff.
An independent safety reviewer found no blocking issue before application.

The existing development-preflight, isolated-runtime and runtime-scope suites
passed all 60 tests across three files. The hostname JSON passed exact-origin and
disabled-routing assertions; changed documentation/configuration passed Prettier.

## Deliberately preserved differences

Thirteen unrelated schema-diff statements remain. They propose removing an order
index; altering CommerceOrder, earning rules, outbox jobs, referral rules, tier
history, review settings and reward definitions; and dropping the three import
tables, acquisition decisions and review-incentive activations. None was executed.
These retained-environment differences must be assessed for runtime compatibility;
the three-table comparison is not proof of full-database equality or live readiness.

## Configuration only

`infra/shopify-development/public-hostnames.json` records the approved origins:

- `https://loyalty-shopify-dev.weletic.com`
- `https://loyalty-api-dev.weletic.com`

It explicitly disables public routing and is not consumed by the existing
loopback runtime. No custom-app TOML, DNS, tunnel, remote registration, extension
UID, deployment, installation, credential, store, customer, order, email or
loyalty activation was changed. Frozen import work remains untouched.

## Remaining gates

PR #15 is still a draft. Reconcile retained-schema compatibility before runtime
startup. Public configuration/extension ownership validation, exposure/deployment
approval and named yamaxdev install/reinstall and loyalty lifecycle evidence remain
outstanding. The schema application does not satisfy any live shopper acceptance.
