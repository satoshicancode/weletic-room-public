# Shopify Flow / native reviews integration evidence

Date: 2026-09-05. Baseline: native reviews #53, `3fefbf0e77`.
Scope: PR #52 combined with that baseline, without rewriting branch history.

## Reconciliation

- Native and retained Judge.me points awards use one provider-neutral producer.
  The ledger entry and `FLOW_TRIGGER` job share the caller's Prisma transaction;
  the job key includes the immutable award ledger ID.
- Duplicate awards, moderation clawbacks, and republication do not emit another
  points-earned event. Concurrent native moderation and rollback are exercised
  through production services on isolated MySQL, not an in-memory simulator.
- Both reviews and Flow retain their outbox handlers and installation fences.
  Flow rechecks the job's original generation after customer-lock acquisition
  and after credential resolution, then dispatches only the captured credential.
- HTTP 200 GraphQL `INTERNAL_SERVER_ERROR` remains retryable. Deterministic
  validation/access errors still dead-letter; no broad retry of every API error
  or change to the shared discount transport was introduced.
- The additive Flow SQL now starts from main #53 and preserves all existing
  native-review enum labels in order. A regression test compares the complete
  migration enum with Prisma.

## Isolated database evidence

Fresh database: `weletic_loyalty_it_flow_reviews_20260905`, MySQL 8.
Created from main #53's Prisma schema, then expanded with the exact
`shopify-flow-stage-1.sql`. Prisma schema comparison returned **no difference**.
All four Flow and seven native-review stage-2 finding counts were zero.

The three production-service database suites passed **29 tests**: ledger 7,
operations 7, native reviews 15. These cover concurrent review publication,
ledger-linked generation-bound Flow deduplication, append-only reversal,
transaction rollback, and concurrent email lease acquisition. Email transports
and object storage were mocked; no real message or object was sent.

The local Flow validator passed **7/7 production-contract checks**. Eight other
validators passed **147/147 simulated checks** with network access blocked.
Those simulations are not live Shopify or database-transaction proof. Shopify
Function schema-backed fixtures passed **10/10**.

## Combined code verification

- Full Vitest run on frozen source: **261 files, 3,891 passed, 6 intentionally
  skipped**. The final run completed without failures.
- Focused Flow/native/Judge.me suite: **85 tests passed**, including stale
  generation, captured credentials, terminal versus retryable credential errors,
  and production outbox state transitions.
- Web type-check passed with Node's 8 GiB heap; Shopify app type-check passed.
- Root lint, affected-file lint, repository-wide Prettier, and Prisma validation
  passed. Prisma reports existing relation-mode index warnings.
- Next.js production build on frozen source passed and generated **373 pages**
  using synthetic build configuration and the isolated database. Types and lint
  ran as separate checks, matching the existing CI build arrangement.
- Shopify CLI `app build` passed, including theme, function, and UI-extension
  builds. This command did not publish the app or run real Flow workflows.
- Independent adversarial review found and resolved transient GraphQL-error
  classification and reconnect/credential-adoption gaps. Final scoped reviews
  had no remaining P1/P2 findings.

## Release boundaries

- The actual development database has **not** received the Flow schema in this
  follow-up. Apply and merge require explicit Hiro confirmation.
- Shopify extensions have **not** been published; no real workflow or lifecycle
  enable/disable delivery evidence is claimed. Publication requires separate
  approval for the development store `n0pvef-cs.myshopify.com`.
- Keep Flow-producing app processes and workers paused until publication passes.
  Dispatch for unobserved stores is intentional, not a deployment toggle.
- Native reviews and invitation emails stay disabled. ESP/Klaviyo remains
  deferred. No production repair, backfill commit, or financial valuation was
  enabled. Persisted analytics remains unavailable while valuation is unset.
- The historical-backfill and analytics persisted audits are not replaced by
  mocks; their outstanding release evidence remains separate.

Contracts checked against Shopify's official
[Flow trigger reference](https://shopify.dev/docs/apps/build/flow/triggers/reference)
and [lifecycle callback contract](https://shopify.dev/docs/apps/build/flow/track-lifecycle-events).

## Subsequent development checkpoint — 2026-09-05

The release-boundary statements above describe the PR #52 checkpoint. The
additive Flow and native-review schemas were subsequently applied to the existing
development database with approved staged validation. Runtime hardening #54 is
merged with green CI. See the current
[six-package rollout record](referral-reviews-live-rollout.md).

Publication and real workflow/lifecycle evidence remain pending. The current
custom-distribution app on the Basic store cannot meet native Flow eligibility.
Hiro approved pursuing public distribution in [ADR 0016](../adr/0016-public-shopify-app-distribution.md);
that approval does not convert the existing app or prove the Flow release gate.
ESP/Klaviyo remains deferred.
