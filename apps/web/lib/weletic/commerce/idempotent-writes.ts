import type { WeleticIdPrefix } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

/**
 * Building blocks for money flows that must be correct on Cloudflare D1, where
 * `$transaction` provides no atomicity (see lib/prisma/d1-semantics.ts).
 *
 * Pattern: derive every id deterministically from the business key, write
 * children first, write the "commit marker" row last, and make every insert
 * tolerant of a unique-key duplicate. A crashed attempt is then completed by
 * its retry without producing a second financial effect.
 */

export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2002";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2002") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unique constraint failed/i.test(message);
}

/** Stable, collision-resistant id for a business key (same shape as nanoid(20)). */
export function deterministicWeleticId(
  prefix: WeleticIdPrefix,
  ...parts: string[]
): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex");
  return `${prefix}${digest.slice(0, 20)}`;
}

/**
 * `createMany` without `skipDuplicates` (unsupported by SQLite/D1). Tries the
 * efficient single statement first; if any row collides with an existing
 * unique key the statement is rejected as a whole, so the rows are inserted one
 * by one and collisions are ignored. Returns the number of rows inserted.
 */
export async function createManyIgnoringDuplicates<T extends object>(
  delegate: {
    createMany(args: { data: T[] }): Promise<unknown>;
    create(args: { data: T }): Promise<unknown>;
  },
  rows: T[],
): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    await delegate.createMany({ data: rows });
    return rows.length;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  let inserted = 0;
  for (const row of rows) {
    try {
      await delegate.create({ data: row });
      inserted++;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return inserted;
}

/**
 * Creates a row keyed by a unique column, or returns the id of the row that
 * already owns that key (a replay or a concurrent writer).
 */
export async function createOrGetByUnique({
  create,
  findExistingId,
}: {
  create: () => Promise<{ id: string }>;
  findExistingId: () => Promise<string | null | undefined>;
}): Promise<{ id: string; created: boolean }> {
  try {
    const row = await create();
    return { id: row.id, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existingId = await findExistingId();
    if (!existingId) throw error;
    return { id: existingId, created: false };
  }
}
