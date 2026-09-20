# Review moderation process-crash acceptance

## Boundary

September 20, 2026. Test-only increment on public main
`a6965d65079cd57fc15f558d977bace14790f4c0`. This evidence closes a bounded local
R02/S04 recovery case, not the whole Reviews module or its live gates.

The child process loads the production review mutation fence and audited
moderation service. Its actor is a synthetic workspace operator, not an
authenticated Shopify staff member. The fixture changes a merchant reply; it
does not change publication, issue incentives or call a delivery provider.

## Named evidence

Disposable MySQL database `weletic_loyalty_it_shopper_ced7df99cb49`:
**38 native-review integration tests passed**, including both new crash cases.
The exact fixture database and restricted account were removed afterward.
The retained development loyalty ledger stayed at **16 rows before and after**.

Also passed: 30 focused contract/service/privacy tests, web typecheck, focused
ESLint, Prettier, Prisma validation (existing relation-mode index warnings),
and independent adversarial review. The full Next.js production build generated
367 static pages with loopback provider placeholders and disposable SQL fixture
`weletic_loyalty_it_shopper_22ffcbe31e16`; that fixture was also removed with the
retained ledger unchanged at 16. CI/merge and live acceptance are separate gates.

| Case          | Actual interruption                                                                                                            | Independently reread result                          | Recovery result                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Before commit | Parent receives IPC only after reply mutation and audit insert inside the open transaction, then kills that child with SIGKILL | Original version 1, no reply, zero moderation audits | Same expected-version operation commits version 2 and exactly one audit                 |
| After commit  | Child announces the barrier only after the production transaction resolves, then receives SIGKILL                              | Version 2, expected reply, exactly one audit         | Replay with expected version 1 is rejected as conflict; final state still has one audit |

The parent verifies SIGKILL and child closure before reconciliation. It kills
only its own forked process, including timeout/failure cleanup. The child checks
the loopback disposable database prefix before importing application modules;
its environment excludes provider credentials. Child failures produce fixed
diagnostics rather than database URLs, review content or raw exception output.

An initial harness attempt reached MySQL before readiness and stopped before
creating a fixture. After container health was confirmed, the named run above
passed. This startup failure is not counted as a failed application journey.

## Reproduction and remaining gates

Use a newly created isolated MySQL database/account whose database name begins
with `weletic_loyalty_it_`, generated current Prisma client, and the checked-in
schema/activation migration. Run the native-review file with
`LOYALTY_DATABASE_INTEGRATION=1` and `vitest.loyalty-db.config.ts`. Never point
this destructive fixture suite at a shared or production database. The scoped
outer harness owns creation, ledger-baseline checks and exact database/account
removal; do not copy secrets into commands or repository artifacts.

Still required: authenticated HTTP response reconciliation, Shopify staff
receipt/session recovery, invitation/provider crash handling, worker lease
recovery, financial award crash paths and named yamaxdev journeys. A killed
application process is not a database-server crash or a deployed supervision
rehearsal. No deployment, live send/order or schema rollout was performed.
