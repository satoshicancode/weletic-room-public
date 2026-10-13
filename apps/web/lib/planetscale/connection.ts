import { prisma } from "@/lib/prisma";

/**
 * Drop-in replacement for the `@planetscale/database` connection used by the
 * edge/stream helpers in this folder. The database is now SQLite (local) or
 * Cloudflare D1 (production, via the Prisma D1 adapter), so queries go through
 * Prisma's raw API instead of PlanetScale's HTTP driver. Raw SQL is adapted to
 * SQLite by the dialect extension installed in `@/lib/prisma`.
 *
 * Only the subset of the PlanetScale `Connection` API the codebase uses is
 * implemented: `execute(query, args)` -> `{ rows, size, rowsAffected, insertId }`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ExecutedQuery<T = any> {
  rows: T[];
  size: number;
  rowsAffected: number;
  insertId: string;
}

const READ_STATEMENT_RE = /^\s*(?:\(\s*)*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i;

/**
 * Raw SQLite integers come back as BigInt which is not JSON-serializable and
 * breaks `new Date(value)` / arithmetic in callers written for PlanetScale
 * (which returned plain numbers). Convert safely-representable BigInts.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  return value;
}

function normalizeRow<T>(row: T): T {
  if (row && typeof row === "object" && !Array.isArray(row)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      out[key] = normalizeValue(value);
    }
    return out as T;
  }
  return row;
}

export const conn = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute<T = any>(
    query: string,
    args: unknown[] = [],
  ): Promise<ExecutedQuery<T>> {
    if (READ_STATEMENT_RE.test(query)) {
      const rows = (await prisma.$queryRawUnsafe<T[]>(query, ...args)).map(
        normalizeRow,
      );
      return { rows, size: rows.length, rowsAffected: 0, insertId: "0" };
    }

    const rowsAffected = await prisma.$executeRawUnsafe(query, ...args);
    return { rows: [], size: 0, rowsAffected, insertId: "0" };
  },
};
