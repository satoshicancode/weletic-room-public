# Company-store bootstrap implementation checkpoint

September 12 status: PR #15 merged as `69149d76d898b6e14c5c54c5cd07568821e704f9`.
Its [merge and CI receipt](https://github.com/satoshicancode/weletic-room-public/pull/15)
supersedes only the draft/public-CI statements below. Runtime schema, fresh
authentication and named live bootstrap acceptance remain gated. See the
[current launch inventory](launch-status-2026-09-12.md).

September 10, 2026. [ADR 0026](../adr/0026-audited-company-store-bootstrap.md)
is approved. Implementation belongs to **draft PR #15, not merged or live accepted**.

Latest verification: the source-frozen full regression passed (394 files,
6,020 tests passed, six skipped; 522.60 seconds). Final focused coverage is
25 contract tests and 13 real isolated SQL tests. This supersedes earlier
running/failed checkpoints below, which are retained as execution history.
The checked-in `vitest.shopify-bootstrap-db.config.ts` also passed all 13 SQL
tests against fresh schema `weletic_loyalty_it_access_20260909182029950`.

## Implemented boundary

- `apps/web/scripts/loyalty/bootstrap-company-shopify-store.ts` is a trusted local
  operator CLI; there is no merchant endpoint or automatic install hook.
- Strict input binds app, canonical shop, pending installation ID, generation,
  pending revision, operator and reason. Apply additionally requires the exact
  preview digest. Caller-supplied currency, token, user or membership is rejected.
- Preview and apply each independently read the current offline SDK session
  through lifecycle/privacy, coordinator, admission and session locks. The
  pre-mapping token never becomes a generic worker/merchant credential.
- Shopify GraphQL verifies domain/currency outside locks, with redirects rejected
  and a ten-second transport timeout. A second locked capture checks session
  digest, revision, epoch, installation generation and evidence age (60 seconds).
- Deterministic IDs and names appear in the private preview. Commit creates only
  Project, Folder, Program, PartnerGroup and Store, plus admission mapping and
  immutable `bootstrap` audit. Existing/orphan records are rejected, not adopted.
- Required generic billing fields are inert: free bookkeeping, no Stripe identity
  or trial; affiliate payouts are external and the Program remains unstarted.
  No User, membership, invitation, customer, loyalty program, reward or send.
- Store access remains `pending_approval`. Mapping retains the pending generation
  but atomically revokes old SDK leases. Fresh native authentication and separate
  company approval are still required; loyalty is absent, not activated.
- No new schema is needed beyond PR #15's existing unapplied runtime migrations.

## Verification

- Twenty contract tests passed, including preview no-writes, identity/revision
  rejection, changed currency, expired evidence/token, collisions and injection.
- Full web typecheck and changed-file ESLint passed.
- Independent source review found no blocker. Its delayed-publication suggestion
  resulted in atomic lease revocation and a real database test.
- Six tests passed on fresh full-schema database
  `weletic_loyalty_it_access_20260909175911348` at isolated port 3307: exact minimal
  commit/duplicate rejection, competing apply (one winner), atomic pre-commit
  failure rollback, publication during provider lookup, uninstall during provider
  lookup, and rejection of a lease acquired before bootstrap.
- Database provider transport is synthetic; the tests do not contact Shopify.
  The delayed-lease case exercises real coordination revision advancement, not
  the entire HTTP SDK publication route. Uninstall is not shop-redaction coverage.
- Independent SQL reconciliation returned zero across 17 relevant bookkeeping,
  admission/session, user/membership/invite, customer/loyalty and credential tables.
- Initial five-case run passed assertions but failed Prisma relation-mode cleanup
  at Program deletion, reporting `ProgramEnrollment.partnerId` missing. Direct
  information-schema inspection proved that column exists. Exact parameterized
  fixture cleanup avoids that unrelated cascade traversal; the original database
  `weletic_loyalty_it_access_20260909175748109` also reconciles to zero across the
  same 17 tables. Both schemas are retained. This does not fix or accept the
  generic Prisma cascade behavior.
- Full regression and production build are running against this local draft;
  prior CI applies only to the previously published PR #15 revision.

### Expanded verification

- The first full regression ended with 393 passing files and one failed file:
  6,012 passed, three failed, six skipped. Bootstrap's earlier 20-test mock set
  was loaded before the service's orphan-reference guard edit; three happy-path
  tests then lacked the new mocked delegates. The final matching 25-test file
  passes separately. This mixed-version full run is not accepted as green
  evidence; a source-frozen full rerun is required before publication.

- Latest local checkpoint: 25 contract tests and 13 isolated full-schema SQL
  tests passed, the latter on `weletic_loyalty_it_access_20260909180844358`.
  This includes the real signed session route handler rejecting a delayed
  pre-bootstrap publication with 409, no native credential and no SDK token
  overwrite. It is not a listening HTTP server or Shopify OAuth acceptance test.
- Self-review added rejection of pre-existing orphan membership, invitation,
  integration and API-token/OAuth-code references to the proposed workspace,
  and support records owned by the proposed workspace/program. SQL proves an
  orphan owner membership is not adopted; independent review found no blocker.
  Arbitrary concurrent privileged raw-SQL writers are not covered by this claim.
- Production web build passed with 367 generated pages using fresh schema
  `weletic_loyalty_it_access_20260909180027643`, before the final orphan-reference
  guard addition. The guard has separate focused unit/SQL and typecheck coverage.
  Root lint/format passed during this verification pass; final changed-file
  checks and the broader regression remain pending.

- Eleven tests passed on fresh full-schema database
  `weletic_loyalty_it_access_20260909180338833`. Added shop-redaction during provider
  lookup, orphan workspace rejection, and committed generation/revision/expiry
  changes after preview. These are controlled committed interleavings, not a
  claim that every possible concurrent schedule was tested.
- The actual CLI loads using the repository's `tsx` runtime flags and rejects
  omitted arguments with exit 1 and the fixed sanitized operator message. The
  test environment used an unreachable placeholder database, not runtime data.
  Successful live CLI preview/apply remains unverified.

## Required before completion

1. Complete public CI for the published bootstrap update; earlier green PR checks
   do not prove a newer head. Broader regression/build and focused checks passed.
2. Validate fresh authentication after bootstrap through the actual Shopify SDK
   and install workflow; coordinator and signed-handler rejection tests do not
   establish successful live authentication.
3. Validate reviewed preview/apply behavior against named `yamaxdev` identity
   under explicit live execution authority. Local synthetic identity is not proof.
4. Apply the separately reviewed runtime schema only after approval; obtain
   separate endpoint/deployment/installation/activation approvals.

Keep preview output private. It contains internal store/workspace identifiers,
not credentials or customer data. Do not paste signed URLs or environment secrets
into the public repository. A failed/ambiguous apply requires inspecting the
current pending status and audit; do not create another installation or bypass
the revision fence to retry.

## Operator invocation (live execution still gated)

### Reproduce isolated database tests

After explicitly provisioning an empty full-schema test database and a scoped
non-root principal on `127.0.0.1:3307`, provide its private `DATABASE_URL` and set
`LOYALTY_DATABASE_INTEGRATION=1`. The database name must start with
`weletic_loyalty_it_access_`; runtime databases are rejected. Then run:

```sh
pnpm --filter web exec vitest run --config vitest.shopify-bootstrap-db.config.ts
```

The suite creates synthetic authentication and intercepts provider transport.
It does not apply schema or contact Shopify. Cleanup targets generated fixture
IDs only. Independently reconcile all tested tables afterward, including on
failure; do not report a passing assertion set with failed cleanup as accepted.

### Operator preview/apply

Use the dedicated public-app environment only. Privately verify `DATABASE_URL`,
`SHOPIFY_API_KEY`, encryption and privacy keyring configuration before execution;
do not load the legacy/custom-app environment. The command does not load secrets
from a file or accept credentials in its arguments. The canonical `.myshopify.com`
domain must match pending authentication, not merely a storefront alias.

From the repository root, preview with reviewed values replacing placeholders:

```sh
pnpm --filter web exec tsx --conditions=react-server \
  --import=./scripts/runtime/async-local-storage.cjs \
  scripts/loyalty/bootstrap-company-shopify-store.ts \
  --app APP_ID --shop CANONICAL_SHOP.myshopify.com \
  --pending PENDING_ID --generation GENERATION --revision REVISION \
  --operator OPERATOR --reason REASON
```

Inspect the exact IDs, names, currency, operator/reason and pending status. After
execution approval, repeat those same arguments with `--apply --expected-preview
PREVIEW_DIGEST`. A currency or input change requires a new preview. After success,
independently inspect the admission audit and Store/Program ownership; verify no
User, membership, credential projection or loyalty program was created. Do not
interpret `applied: true` as company approval, successful authentication, or loyalty
activation. Do not retry by changing generation/revision after an ambiguous result.
