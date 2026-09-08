# CI gates

Weletic Room uses progressive CI so routine development stays fast while a release candidate still receives complete validation.

## Gate 1: Fast Quality Gate

`Fast Quality Gate` runs automatically for every pull request targeting `main` and every push to `main`.

- Formatting always runs.
- Web lint, type-check, and dependency-aware unit tests run for changes under `apps/web`.
- Shopify type-check and Shopify Function tests run for changes under `packages/shopify-app`.
- Root lint and the complete unit suite run for shared or cross-application changes.
- Shared package, dependency, root configuration, CI workflow, and CI script changes run every fast check.
- A newer commit cancels stale work for the same pull request or branch.

The path classifier is intentionally conservative. Unknown code paths and shared package changes validate both applications. Documentation-only changes still receive formatting validation.

Branch protection should require the stable `Fast quality gate` summary check. It fails when any applicable fast check fails and treats intentionally skipped, unaffected suites as valid.

## Gate 2: Full Release Gate

`Full Release Gate` is intentionally not triggered by every push. Run it once the pull request is ready to merge:

```bash
gh workflow run playwright.yaml --ref <branch>
gh run list --workflow playwright.yaml --branch <branch> --limit 1
```

The gate uses one dependency installation to build the Shopify application, build the web application, and run the complete Playwright suite. Package-manager and Playwright browser caches are restored when safe. Its MySQL, Redis, MailHog, and serverless-redis-http containers are paused while the applications compile, then restarted and health-checked before database setup and browser testing.

The web build runs after its workspace dependencies, enables Next.js's CI-only Webpack build worker and memory optimizations, limits CI worker concurrency to one CPU, and caps each Node.js heap at 5 GB. GitHub's standard private-repository Linux runner has 8 GB of total memory, so the gate uses Next.js's two-phase build: it compiles while E2E services are paused, then restores the services and database before generating pages. This does not change local development or the resulting production validation.

The release gate intentionally does not persist `.next/cache`: this repository's compressed cache expands to roughly 5 GB and can exhaust the hosted runner's disk when Webpack writes a new generation. The generated Webpack cache is also deleted after the compile phase because the generate phase consumes compiled artifacts rather than that transient cache. Lightweight memory and disk heartbeats keep the resource profile visible during the otherwise quiet compilation phase.

Any commit added after a successful full gate invalidates that result. Run the full gate again against the new head SHA before merging.

The manual workflow publishes a `Full release gate` commit status for its exact head SHA. This status bridge is required because GitHub does not add a `workflow_dispatch` check-run to a pull request's status rollup. If the runner fails before it can publish a final result, the pending status continues to block the merge.

## Merge policy

A pull request is release-ready only when:

1. Every applicable `Fast Quality Gate` check passes for the current head SHA.
2. `Full release gate` passes for the same head SHA.
3. Any required migration or production activation has separate approval.

Do not repeatedly rerun a workflow when the GitHub Actions spending limit has been reached. Increase the budget or wait for the billing-cycle reset, then run only the missing gate.

## Deployment smoke

The deployment-status workflow remains the post-deployment smoke layer. It validates the deployed application rather than duplicating the full pre-merge suite.
