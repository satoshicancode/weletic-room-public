/**
 * Cloudflare D1 transaction semantics.
 *
 * Prisma's D1 adapter does NOT provide transactions: `$transaction(fn)` and
 * `$transaction([...])` run every statement independently (no atomicity, no
 * rollback, no isolation). The native SQLite engine used by local dev/Vitest
 * *does* provide real transactions, which would silently mask any money-flow
 * code that only works because of rollback.
 *
 * `withD1TransactionSemantics` makes the native engine behave like D1:
 *  - interactive transactions receive the plain client (each statement is its
 *    own atomic unit, a throw in the middle leaves earlier writes in place);
 *  - batch transactions run sequentially with no rollback.
 *
 * Enable it for any process with `WELETIC_D1_TX_SEMANTICS=1`; the concurrency
 * suites under tests/weletic/d1-*.test.ts do so explicitly.
 *
 * Money-flow code must therefore be correct under these rules:
 *  1. every multi-step write is resumable: each step is idempotent (unique
 *     key + create-or-get, absolute `set` instead of `increment`) and a replay
 *     of the whole operation completes whatever a crashed attempt left behind;
 *  2. serialization points are single statements: unique-constraint inserts
 *     (the append-only ledger's `(accountId, sequenceNumber)`/idempotency key)
 *     or compare-and-set `updateMany` guarded by a version / state column.
 */

export const D1_TX_SEMANTICS_ENV = "WELETIC_D1_TX_SEMANTICS";

export function isD1TransactionSemanticsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[D1_TX_SEMANTICS_ENV] === "1";
}

type AnyClient = Record<string | symbol, any>;

/**
 * Returns a client whose `$transaction` has D1's non-atomic behaviour. All
 * other members (models, `$queryRaw`, ...) are forwarded unchanged.
 */
export function withD1TransactionSemantics<T extends object>(client: T): T {
  const base = client as unknown as AnyClient;

  const nonAtomicTransaction = async (arg: unknown) => {
    if (typeof arg === "function") {
      // The "transaction client" is simply the client: statement-level atomicity.
      return (arg as (tx: unknown) => Promise<unknown>)(proxy);
    }
    if (Array.isArray(arg)) {
      const results: unknown[] = [];
      for (const operation of arg) results.push(await operation);
      return results;
    }
    throw new TypeError("Unsupported $transaction argument");
  };

  const proxy: T = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "$transaction") return nonAtomicTransaction;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
  return proxy;
}
