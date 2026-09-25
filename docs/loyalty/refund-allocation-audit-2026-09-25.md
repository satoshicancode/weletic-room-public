# Refund allocation audit — release gate

This draft adds immutable, per-order-line evidence to **new** points refund
reversals. The writer stores allocation rows and the existing ledger event in
one transaction. The read-only store audit checks event conservation, line and
refund ownership, each line's cumulative reversal, and the final target
computed from retained refund amounts and quantities. It reports `mismatch`
for contradictory evidence and `unavailable` for legacy events without line
provenance, order-level adjustments, and holding-period voids that cannot be
recomputed from the line-refund formula. It never backfills guessed history.
The final source-line target is independently recomputed; this check does not
reconstruct the processing-order point split between multiple refunds of the
same line. That narrower attribution remains unavailable as separate evidence.

The audit uses indexed allocation rows rather than `JSON_TABLE`. [PlanetScale's
published Vitess JSON guidance](https://planetscale.com/blog/the-mysql-json-data-type)
says `JSON_TABLE` is unsupported; compatibility
of the exact intended provider and plan still requires a target-specific query
test. The ledger's JSON allocation copy remains a consistency cross-check and
does not replace the normalized rows.

## Schema-first and rollback packet

- Apply `infra/shopify-development/migrations/20260925_loyalty_refund_allocations.sql`
  to the exact approved target before deploying either the refund writer or
  wallet reconciliation reader. It creates one additive table with a unique
  store/ledger/line key and no historical backfill.
- Inspect the target's existing schema and migration ledger first. Verify
  collation, table/index absence, plan limits, and the intended database role.
  Run the read-only query plan and a disposable transaction before enabling
  financial writes.
- Keep the previous compatible worker available during deployment. A binary
  rollback may stop new allocation writes, but the table and existing rows
  must remain: deleting them would turn already-posted financial events into
  unauditable history. Resume the new reader/writer only after schema and
  transaction verification.
- No shared database schema was applied, and no live store operation was run
  by this local implementation. Shared migration and activation need their
  separate scoped approvals.
- The existing analytics validator requires a fully `clean` wallet audit.
  Stores with historical refund or holding-void events therefore remain blocked
  by `unavailable` until a separately reviewed, store-specific acceptance
  record establishes which legacy evidence can be accepted. Do not turn an
  unknown history into a `clean` result or silently bypass that gate.

## Local evidence and remaining gates

The disposable MySQL 8.4 points suite passed 30 tests. It exercises multi-line
refunds, partial and full reversals, replay, tenant boundaries, source-money
and quantity tampering, allocation-row and metadata corruption, redacted
ledger metadata, and exact fixture cleanup. Prisma validation, focused lint
and TypeScript passed. The complete local web unit run stopped on older
Shopify simulation fixtures with `invalid_scope`; the same failures reproduce
on unchanged public `main` in this environment. A full Next.js build compiled
but static page collection lacked `DATABASE_URL`. CI and exact-target provider
evidence are still required. Local tests do not prove Vitess behavior,
installed Shopify journeys, provider delivery, worker recovery, backup
restoration, or release acceptance. Older refund/void histories remain
explicitly unavailable to this new source audit.
