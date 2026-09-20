# Review mutation process-crash acceptance

## Boundary

September 20, 2026. Test-only increment on public main
`a6965d65079cd57fc15f558d977bace14790f4c0`. This evidence closes a bounded local
R02/R05/S04 recovery cases, not the whole Reviews module or its live gates.

In the moderation cases, the child loads the production review mutation fence and audited
moderation service. Its actor is a synthetic workspace operator, not an
authenticated Shopify staff member. The fixture changes a merchant reply; it
does not change publication, issue incentives or call a delivery provider.
The financial extension below separately exercises review-points fulfillment.

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

## Review-points fulfillment extension

Fresh fixture `weletic_loyalty_it_shopper_30759899a135`: **40 native-review tests
passed**, including the two moderation cases and two additional financial crash
cases. Exact database/account cleanup completed; retained ledger **16 → 16**.

Each financial case uses its own synthetic shopper/account. A synthetic promise
is bound to the invitation; the real submission service validates participation
and reserves its claim while the account is suspended. The fixture then enables
that account before the child calls production points fulfillment. This is not
evidence of policy activation, invitation disclosure/delivery, automatic
enrollment or live merchant authentication.

The award is **9007199254740993 points**, intentionally above JavaScript's safe
integer range but within the signed ledger range. Assertions reconcile raw SQL
SUMs with cached available/pending balances and lifetime earned points, the
ledger version, claim status and review-to-ledger linkage.

- Before commit: SIGKILL after fulfillment SQL leaves the original reserved
  claim, zero ledger rows, zero balance and zero account-owned Flow/tier jobs.
  An explicit retry fulfills the promise once.
- After commit: SIGKILL leaves one exact award, one points-earned Flow job and
  one tier-review job. Replay returns `already_fulfilled`; independently reread
  state remains identical.
- The later customer-erasure test now scopes its assertions to the erased
  shopper and proves that both unrelated buyers' requests, reviews, accounts,
  claims and ledger records remain unchanged.

Failed fixture `weletic_loyalty_it_shopper_d2289b4a5d65` had **34 passed / 6
failed**. The new buyers initially lacked required invitation email identities;
an existing missing-settings test also reset the shared revision counter while
retaining policy revisions. Those fixture defects were corrected with reserved
`example.test` addresses and exact settings snapshot restoration. The failed
fixture was removed, with retained ledger 16 → 16. No production behavior was
changed to make these tests pass.

The previously recorded production build remains applicable to unchanged
application sources; this extension changes tests/evidence only and receives
fresh type/lint/format and CI verification. It does not execute the outbox jobs
or prove provider/queue-worker recovery.

## Reproduction and remaining gates

Integration after PR #92: both the real post-mutation deadlock case and all four
process-crash cases are retained. Fresh fixture
`weletic_loyalty_it_shopper_da3e29a93459` passed **41 native-review tests** on
September 20. Exact fixture database/account cleanup completed; retained ledger
remained **16 → 16**. Typecheck and formatting passed; independent review found
no merge-specific fixture interaction. This is local integration evidence, not
new live acceptance. The updated branch requires fresh CI.

Use a newly created isolated MySQL database/account whose database name begins
with `weletic_loyalty_it_`, generated current Prisma client, and the checked-in
schema/activation migration. Run the native-review file with
`LOYALTY_DATABASE_INTEGRATION=1` and `vitest.loyalty-db.config.ts`. Never point
this destructive fixture suite at a shared or production database. The scoped
outer harness owns creation, ledger-baseline checks and exact database/account
removal; do not copy secrets into commands or repository artifacts.

Still required: authenticated HTTP response reconciliation, Shopify staff
receipt/session recovery, invitation/provider crash handling, worker lease
recovery, coupon/provider crash paths and named yamaxdev journeys. A killed
application process is not a database-server crash or a deployed supervision
rehearsal. No deployment, live send/order or schema rollout was performed.
