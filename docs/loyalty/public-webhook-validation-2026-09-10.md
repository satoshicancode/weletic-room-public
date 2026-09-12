# Public webhook routing — September 10, 2026

Local implementation follow-up to ADR 0029. No Shopify webhook subscription was
created, changed or deleted. This does not establish deployed callback reachability
or named `yamaxdev` installation acceptance.

## Defect and correction

The shared provisioning boundary ignored `SHOPIFY_WEBHOOK_URL` and could select a
retained custom-app development callback. Normal and segment provisioning now
require the reviewed public client ID, app/backend origins and exact webhook path
when the public identity or either reserved host is selected. Public provisioning
rejects legacy overrides and loopback isolation before GraphQL transport.

Legacy configuration retains its existing precedence. Its fully resolved callback
is checked again: scheme-less domains and preview fallbacks must not introduce a
public target under custom credentials. Trailing-dot host aliases select strict
policy in both this boundary and the shared SDK/gateway runtime policy; accepted
URLs remain exact. Errors contain no URL, token or credential values.

## Verification

- Focused webhook suites: 70 tests in five files passed; runtime suite: 94 tests
  in four files passed. Shopify package tests: 32 passed.
- Synthetic GraphQL transport exercises both real provisioning functions, exact
  callback creation/audit, and rejection before any transport on unsafe settings.
  This is not a live Shopify registration or delivery test.
- Independent review identified effective legacy-target and trailing-dot alias
  bypasses; both were fixed and re-reviewed with no remaining blockers.
- Web/Shopify typechecks, root lint and Shopify production build passed. Existing
  nonfatal framework/source-map warnings remain.
- Frozen full web regression: 396 files passed; 6,081 tests passed and six skipped
  (510.15 seconds). No source or test edits occurred during this run.
- Full production web build passed against fresh isolated database
  `weletic_loyalty_it_access_20260910054140997` on the approved local port 3307.
  Independent SQL reconciliation found zero Store, Program and approval-audit
  rows. The test schema is retained; no existing schema was changed. Fresh public
  CI is required for the new commit.

## Remaining gates

Public deployment, backend namespace/secret isolation, endpoint reachability,
installation/reinstallation and actual event receipt remain outstanding. No schema,
credentials, custom manifest, import branch or external Shopify state changed.
This routing guard must not be treated as full backend isolation proof.
