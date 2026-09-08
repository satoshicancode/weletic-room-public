# Dub upstream synchronization runbook

1. Fetch `upstream` and review the release notes and Enterprise license impact.
2. Create `codex/upstream-dub-YYYY-MM-DD` from current `main`.
3. Merge the selected upstream tag or commit without rewriting history.
4. Resolve conflicts by retaining Weletic-prefixed modules and reapplying only
   the smallest necessary integration changes in shared Dub files.
5. Regenerate Prisma, run type-check, lint, unit/integration tests, and build.
6. Run Shopify webhook replay, catalog sync, commission, refund, and payout
   reconciliation fixtures.
7. Open a pull request that lists upstream commits, conflicts, behavior changes,
   and deferred migrations. Merge only after all checks pass.

The archived prototype lives on `codex/rescue-weletic-shopify-prototype`; it is
reference material, not a branch to merge into production.
