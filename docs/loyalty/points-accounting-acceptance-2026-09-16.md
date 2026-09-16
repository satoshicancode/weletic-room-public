# Points and accounting acceptance — September 16, 2026

## Disposition

The isolated accounting lifecycle has named real-MySQL evidence. This is **not
live `yamaxdev` acceptance**, Shopify webhook acceptance, or production readiness.
Acceptance matrix C1/C2/G2/G4 remain open for their broader/live requirements.

No real orders, refunds, reward issuance, emails, installations, or deployments
were performed. Commerce records were synthetic; the spend in P06 was a ledger
fixture, not an issued Shopify discount. The birthday/expiry handlers ran directly,
without starting an outbox delivery worker. Authentication in route tests is
fixture-backed, not a real merchant login.

## Named database evidence

Command: `pnpm --filter web exec vitest run --config vitest.points-accounting-db.config.ts`.
Set `POINTS_ACCOUNTING_DATABASE_INTEGRATION=1` and inject `DATABASE_URL` privately.
The suite refuses anything except `loyalty_dev` on `127.0.0.1:3307` in a database
named `weletic_loyalty_it_points_<suffix>`, verifies the connected database and
principal, and requires empty store/account/ledger tables before fixtures.
Provision and apply the current Prisma schema only to a fresh, explicitly selected
test database. Do not use the retained application database or production secrets.

Recorded run: fresh database `weletic_loyalty_it_points_20260916_a`; **9/9 passed**.
Only logging/link-cache infrastructure is mocked. Financial functions, Prisma
transactions, store fences, grant allocation, ledger writes, and reconciliation
queries use actual MySQL. A fake application clock controls timing. All `fetch`
calls are rejected. No production reconciliation/auto-repair helper is invoked.

| ID  | Journey and expected result                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | Two-line purchase earns 100 once despite competing deliveries. Partial refund leaves 70, cumulative full refund leaves 0; refund and order replay do not credit/debit twice.                        |
| P02 | 100 pending; partial refund leaves 70 pending. Release fails initially and one millisecond before persisted maturity; competing releases at the exact boundary produce 70 available, 0 pending.     |
| P03 | Fully refunded pending points never mature. A competing maturity/refund pair conserves the remaining 40 points.                                                                                     |
| P04 | Repeated signup enrollment awards 25 once. Birthday awards 50 once in each eligible calendar year, reaching 75 then 125.                                                                            |
| P05 | Manual ledger adjustment preserves `9007199254740993` exactly; identical replay is harmless, conflicting replay fails, debit returns balance to zero. Cross-store and stale-generation writes fail. |
| P06 | Spend 80 from 100; full refund leaves debt of -80, not zero. A later 100-point purchase repays debt and leaves 20.                                                                                  |
| P07 | Early expiry fails; stale policy does not mutate. Due expiry removes 40 available exactly once and leaves 100 pending untouched.                                                                    |
| P08 | Read-only SQL detects intentionally corrupted account cache and historical `balanceAfter`, without repairing either. Exact synthetic rows are restored explicitly afterward.                        |
| P09 | Changing fixture installation generation rejects old-generation purchase, refund and maturity writers; 100 pending remains unchanged. This is a generation-fence test, not a Shopify reinstall.     |

The independent SQL oracle verifies available balance, pending-grant totals,
lifetime earned/redeemed counters, contiguous ledger sequences, every historical
running balance, grant conservation, and line-allocation/refund conservation.
It uses SQL sums/window functions and explicit accounting rules, not the
production projection/reconciliation implementation.

Cleanup is restricted to exact store/project/program IDs created by this run.
A separate read-only SQL postflight checked all **157 schema tables**, with no
remaining rows after cleanup. No database or volume was dropped.

## Defects addressed

- The holding-period handler previously relied on scheduled delivery timing and
  could release a grant before its stored maturity. It now fails early deliveries
  so workers can retry, rejects invalid dates, and uses the persisted date rather
  than a caller-supplied payload. Refunded orders may still be voided early.
- Both owner-only manual adjustment routes could search for the first shopper when
  all target identifiers were absent. They now require valid explicit identifiers,
  check supplied customer selectors against the account, and reject unsafe JSON
  numbers, fractional/coercible values, zero and out-of-range signed 64-bit deltas.
  Large values use exact decimal strings. Existing ownership authorization remains.
- Legacy mocked maturity fixtures now carry explicit due dates. The M3 mock suite
  resets queued mock responses between tests to prevent cross-test contamination.

## Local regression verification

The focused run passed **379 tests in 12 suites**: holding/refunds, admin API and
RBAC, financial concurrency, campaign accounting, outbox, M3 stress, points expiry,
birthday registration, non-purchase earning, exact financial math and basic points
calculation. Both manual routes include successful large decimal-string cases.
These tests use mocks where already established and are separate from P01–P09.
Web and Shopify TypeScript checks, focused ESLint, Prettier and Prisma validation
also passed. Existing Prisma relation-mode index warnings are unchanged.
The web production build passed (367 static pages) using SELECT-only access to
the empty isolated schema; temporary privileges were then revoked and all 157
tables rechecked empty. The Shopify default build also passed. Build-time warnings
for intentionally absent Redis/QStash credentials remain; no provider was invoked.
The final web typecheck required `NODE_OPTIONS=--max-old-space-size=8192` after
Next generated its full type surface; the default 4 GB attempt exhausted its heap.

## Remaining live acceptance gate

After an approved isolated public runtime and real `yamaxdev` authentication are
available, execute and retain named evidence for:

1. Real paid order ingestion and replay; compare Shopify merchandise amounts,
   immutable line allocations, ledger history and read-only SQL totals.
2. Real signup, birthday registration/eligibility and owner-authorized manual
   adjustment through installed merchant/shopper surfaces; reject unauthorized
   users, conflicting identifiers and stale authentication.
3. Worker-driven maturity, expiry warning/last-chance timing, due expiry and
   replay, including delivered/suppressed notification evidence. Direct handler
   tests do not establish scheduler supervision or email delivery.
4. Real partial/full refunds both before and after maturity, including spent-point
   debt; record cumulative line-level clawback, replay, wallet history and SQL.
5. Fresh installation generation, stale worker rejection, exact fixture cleanup
   and final independent reconciliation. Platform orders must not be simulated
   and presented as real acceptance.

These executions retain the explicit gates for deployment, installation,
Shopify orders/refunds and real communications. No production `weletic.com`
rollout is included.
