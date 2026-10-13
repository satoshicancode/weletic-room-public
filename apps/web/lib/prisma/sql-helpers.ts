import { Prisma } from "@prisma/client";

export const isMysql = Boolean(process.env.DATABASE_URL?.startsWith("mysql:"));

/**
 * In MySQL, evaluates to `FOR UPDATE` for row locking.
 * In SQLite / Cloudflare D1, evaluates to `Prisma.empty` because SQLite serializes transactions.
 */
export const forUpdateClause = isMysql ? Prisma.sql`FOR UPDATE` : Prisma.empty;

/**
 * In MySQL, evaluates to `CURRENT_TIMESTAMP(3)`.
 * In SQLite / Cloudflare D1, evaluates to `CURRENT_TIMESTAMP`.
 */
export const currentTimestampClause = isMysql
  ? Prisma.sql`CURRENT_TIMESTAMP(3)`
  : Prisma.sql`CURRENT_TIMESTAMP`;
