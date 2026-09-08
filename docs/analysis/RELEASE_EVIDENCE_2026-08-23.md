# Release Evidence — 2026-08-23

Evidence last updated: 2026-08-24.

## Executive status

**Pre-production remediation passed its first complete PR gate.** The repository
is not deployed to Vercel or released on the production Weletic domains. This
report replaces the earlier release claim and records only reproducible evidence
from PR #10, including commit `d078eb1771` and the billing-flow fix at
`29ba78c32a`.

## Test inventory and contracts

| Suite                              | Files |                         Tests | Default gate | Current evidence                            |
| ---------------------------------- | ----: | ----------------------------: | ------------ | ------------------------------------------- |
| Weletic local/unit subset          |    92 |                         1,190 | Yes          | Passed locally on 2026-08-24                |
| All deterministic local/unit tests |   123 |                         1,647 | Yes          | Passed locally on 2026-08-24                |
| Deployed API integration tests     |    50 | Determined against deployment | No           | Requires deployment URL and API credentials |
| Cache wall-clock benchmarks        |     1 |                             3 | No           | Passed locally on 2026-08-23                |
| Playwright browser tests           |    16 |                           147 | Yes          | Green CI run `32699753066`                  |

`pnpm test` and `pnpm test:unit` run deterministic tests without deployment
credentials. `pnpm test:integration` fails before test collection when any
required deployment credential is absent. `pnpm test:performance` is explicit
and independent so runner timing variance cannot block a release.

## Quality and build evidence

- Frozen lockfile install: passed locally on 2026-08-24.
- Root zero-warning lint: passed locally and in CI run `32699752985`.
- Web and Shopify type-checks: passed locally and in CI run `32699752985`.
- Deterministic unit tests: 123 files and 1,647 tests passed locally and in CI
  run `32699752985`.
- Shopify and web production builds: passed in isolated GitHub checkouts in CI
  run `32699752985`; the web build completed all 371 static pages.
- The web production build also passed all five Turbo tasks and all 371 static
  pages in a clean detached worktree at `29ba78c32a`. The live development
  server's `.next` directory was not shared or modified.
- Prettier: passed locally and in CI run `32699752989` after repository-wide
  normalization.
- Playwright: run `32699753066` discovered 147 tests across 16 spec files and
  concluded successfully. It reported 146 direct passes and one retry-only flake
  in a layout-coupled billing locator; PR #10 replaces that locator with an
  accessible role assertion, and the final protected PR run remains the merge
  gate.

Canceled, failed, or pending runs on PRs #7, #8, and #9 are not accepted as
evidence for this release.

## Deployment evidence

- GitHub/Vercel deployment ID: **none exists or is verified**.
- Core web production runtime: **not deployed**.
- Shopify Remix production runtime: **not deployed**.
- Shopify app configuration release: **not released**.
- Production DNS attachment: **not authorized in this remediation phase**.

Deployment identifiers, temporary hosting URLs, production domains, and smoke
test results must be appended only after the rollout is actually performed.

## Database correction

This repository uses split Prisma schemas backed by MySQL/PlanetScale. The
approved rollout is backup, staging restore, cumulative `prisma migrate diff`
review, and `prisma db push`. PostgreSQL and `prisma migrate deploy` instructions
do not apply. Never use `--accept-data-loss`.

## Security remediation

Hardcoded Shopify API secret, webhook secret, and internal service secret were
removed from runtime and development tooling. The public Shopify app `client_id`
remains in `shopify.app.toml` by design. Because the former secrets remain in Git
history, treat them as compromised and rotate them before any production
deployment. The core and Shopify runtimes must receive the new secrets through
their hosting environment; the internal service secret must be dedicated and
must not fall back to the database encryption key.

## Production gate

Production database mutation and DNS changes require Hiro's explicit
confirmation after the remediation PR is merged, staging schema evidence is
reviewed, Shopify credentials are rotated, valid hosting credentials are
restored, and temporary deployment URLs pass integration, browser, catalog,
refund, commission, and reconciliation checks.
