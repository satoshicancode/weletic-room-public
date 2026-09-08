# Company-store approval

The public app serves company stores. A Shopify owner session does not authorize
a store to activate loyalty. This change implements the backend admission state,
transaction fences and local operator command. Public installation provisioning,
the pending-approval screen and named `yamaxdev` acceptance remain outstanding.

## State and concurrency contract

- New store rows default to `pending_approval`. Only `active` permits ordinary
  customer/catalog/order ingestion and guarded merchant/loyalty writes.
- `suspended` blocks those operations and new voucher issuance. Authentication,
  mandatory privacy handling and existing financial cleanup retain their separate
  lifecycle paths. Admission never overrides frozen/redacted compliance state.
- Approval and suspension lock the exact store, then its optional loyalty
  program. They check the canonical domain, installation generation and revision
  and commit an append-only operator audit in the same transaction as the state.
- Repeated/stale commands fail; they cannot silently adopt a new installation.
  There is no merchant HTTP endpoint for approving a store. CLI execution requires
  access to the trusted backend database environment; the operator label is audit
  attribution, not authentication.
- Approval does not activate a draft program, release a maintenance lease, grant
  Shopify scopes or change the program kill switch.

## Migration gate

`infra/shopify-development/migrations/20260908_shopify_store_approval.sql` is
unapplied to shared environments. Review the exact target and snapshot it before
application. The migration preserves existing stores as `active`, then changes
the default for future inserts to `pending_approval`. Inventory retained rows
before application: only an empty isolated public database or a reviewed set of
already-authorized company stores is eligible for this compatibility behavior.
Do not copy custom-app store/session rows into the public database.

Deploy the code only after its columns and audit table exist. Do not remove them
while this code is deployed. Suspending access is containment, not ledger rollback.

## Operator command

From `apps/web`, load the reviewed target environment through the existing runtime
wrapper and run:

```sh
pnpm exec tsx --conditions=react-server --import=./scripts/runtime/async-local-storage.cjs \
  ./scripts/loyalty/set-shopify-store-access.ts \
  --store '<exact-store-id>' --domain '<canonical-shop>.myshopify.com' \
  --generation '<observed-installation-generation>' --revision 1 \
  --state active --operator '<operator-identity>' --reason '<approval-reference>'
```

The default is a preview: it validates and locks but changes no state or audit.
After reviewing the result and obtaining the execution approval for that store,
repeat the exact command with `--apply`. Suspension uses `--state suspended` and
the current revision. Keep reasons free of credentials and shopper information.

## Evidence and remaining work

Local focused tests cover pending/suspended denial, strict state validation,
preview, exact identity, generation/revision rejection, privacy blocks and audit
creation. Eight real MySQL tests passed on 2026-09-08 in the fresh isolated
`weletic_loyalty_it_access_20260908c` database: migration defaults, competing
approvals, audit-failure rollback, stale installation rejection, both voucher
lock modes, tenant-isolated suspension and serialization with an operational
transaction. Production services and the committed SQL were exercised; fixture
rows were removed afterward. This is not a full production-schema or live-store
certificate.

Before public release:

- Persist and display pending status for unknown installations that do not yet
  have a workspace/program/store mapping. Current session persistence alone is
  not this admission record.
- Finish the signed status gateway and EN/JA/VI pending/suspended UI.
- Exercise the entire webhook/worker graph, including read-only providers and
  intentionally permitted privacy/financial cleanup, against the public identity.
- Verify fresh install/reinstall, company activation, suspension and stale-worker
  rejection on `yamaxdev`; record exact app/version and cleanup evidence.
