# Explicit module lifecycle foundation

Local implementation checkpoint: 2026-09-06. Part of package 2 of the approved
unified loyalty/reviews plan; not package acceptance or live Shopify proof.

## Behavior

- Customer and paid-order ingestion persist the store-scoped shared shopper
  independently of loyalty. Ingestion no longer creates a loyalty program.
- A missing, draft, test, disabled, or kill-switched program does not enroll a new
  loyalty account or issue its signup award. An explicitly active program can
  enroll the shopper on their next customer/order event. This does not bulk-enroll
  existing shoppers when the merchant activates the program.
- Existing accounts, balances and history remain intact. Disabling/reactivating
  loyalty does not reopen closed or suspended accounts. Privacy tombstones and
  installation-generation checks still precede ingestion writes.
- Settings, branding, earning-rule, referral, campaign, tier and historical
  preview initialization explicitly create **draft** programs. Existing program
  states are not rewritten. Status changes retain the existing owner guard;
  malformed explicit statuses are rejected. Loading settings cannot activate
  loyalty, although GET still initializes a draft row for API compatibility.
- Settings/backfill initialization rechecks existence inside the existing store
  write fence, avoiding a blind create after a concurrent initializer wins.
- Backfill previews that need to enroll an historical shopper require an active,
  non-killed program. Otherwise they fail with the existing inactive-program
  error instead of silently enrolling or presenting an incomplete zero preview.
  Previews for existing eligible accounts remain available. Concurrent enrollment
  attempts reuse one account under the store/program lock; cross-store and
  redacted/closed identities cannot be enrolled by this path.

## Verification boundaries

The focused production service/API tests use mocked dependencies. Separate
opt-in MySQL tests invoke the real shopper service, preview-enrollment service,
Prisma transactions, store/program row locks and privacy lookup. The initial
15-case database run passed for inactive states, activation plus concurrent
enrollment, concurrent preview reuse, exact retained balances, closed accounts,
stale generation, cross-store rejection, retained erased identities and a
disable-wins-store-lock race. These are isolated local fixtures,
not `yamaxdev` acceptance. External fetch is forbidden; no email/Shopify operation
is performed. Fixture cleanup is restricted to generated store IDs.

Local verification on the PR63 base (`98d5aef787`): 4,214 unit tests passed,
six skipped across 277 files. A subsequent 129-case focused run also covers the
runtime initializer inventory, shopper lifecycle, admin settings and privacy
ingestion. Web type-check, root lint (10 tasks), the repository's TS/TSX/Markdown
formatting check, Shopify type-check/build and Prisma validation passed. Prisma
retains its existing relation-mode index warnings. An additional all-extension
format scan flagged 14 untouched JSON/GraphQL/JavaScript files outside the normal
format gate; those unrelated files were not changed. Exact-head CI remains a
separate merge requirement.

The local web production build also passed (359 static-page generation targets)
with guarded isolated services and synthetic provider configuration. It used the
repository's separate-validation mode: types/lint were checked independently,
not by Next's build step. This is not provider-operation or deployment evidence.

Use `vitest.module-lifecycle-db.config.ts` only with
`MODULE_LIFECYCLE_DATABASE_INTEGRATION=1` and the guarded local database:
`127.0.0.1:3307/weletic_loyalty_dev`, principal `loyalty_dev@%`. The config does not
autoload environment files. Do not use retained merchant databases or copy
credentials into fixtures/logs.

## Still open

- Shared branding, locale, shopper consent/suppression and module-control UI.
- Native review participation incentives, acquisition precedence and all other
  unfinished unified-plan packages.
- End-to-end merchant/customer acceptance on `yamaxdev`.
- Shared schema validation/migration gates. This increment makes no schema
  change; Prisma's historical program default remains `active`, so new runtime
  initialization code must continue specifying `draft` explicitly. Existing
  programs are not retrospectively reclassified.
- Historical backfill audit/repair gates. Commit operations remain disabled;
  this work does not declare financial reconciliation complete.
