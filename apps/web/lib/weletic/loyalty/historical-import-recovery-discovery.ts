import { prisma } from "@/lib/prisma";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { lockLoyaltyProgramRow } from "./program-write-fence";

const identifier = z.string().min(1).max(191);
const requestSchema = z
  .object({
    storeId: identifier,
    programId: identifier,
    installationGeneration: identifier,
    afterSourceId: identifier.optional(),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();
const candidateSchema = z
  .object({
    id: identifier,
    storeId: identifier,
    programId: identifier,
    installationGeneration: identifier,
    status: z.literal("committing"),
    leaseExpiresAt: z.date(),
  })
  .strict();

/** Internal discovery hints, never execution permits. A supervisor must recover
 * each candidate in a fresh transaction and handle conflicts without adopting
 * an existing owner's token. Pagination is an ID scan, not a snapshot: restart
 * from the beginning on subsequent sweeps to see newly expired earlier IDs.
 * Does not expose lease credentials or mutate source/account/ledger records.
 * Query-plan/load acceptance remains required; LIMIT bounds output, not scans.
 */
export async function discoverHistoricalImportCommitRecovery(request: unknown) {
  const input = requestSchema.parse(request);
  return prisma.$transaction(
    async (tx) => {
      await assertShopifyStoreAcceptsOperationalWrites({
        tx,
        storeId: input.storeId,
        expectedInstallationGeneration: input.installationGeneration,
        action: "loyalty_import_recovery_discovery",
      });
      const program = await lockLoyaltyProgramRow({
        tx,
        storeId: input.storeId,
        mode: "active",
      });
      if (program.id !== input.programId || program.storeId !== input.storeId)
        throw new HistoricalImportConflictError();
      const clocks = await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT UTC_TIMESTAMP(3) AS now`;
      const now = clocks[0]?.now;
      if (
        clocks.length !== 1 ||
        !(now instanceof Date) ||
        !Number.isFinite(now.getTime())
      )
        throw new HistoricalImportConflictError();
      const after =
        input.afterSourceId === undefined
          ? Prisma.empty
          : Prisma.sql`AND BINARY id > BINARY ${input.afterSourceId}`;
      const raw = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT id, storeId, programId, installationGeneration, status, leaseExpiresAt
      FROM WeleticLoyaltyImportSource
      WHERE storeId = ${input.storeId} AND programId = ${input.programId}
        AND installationGeneration = ${input.installationGeneration}
        AND status = 'committing' AND leaseId IS NOT NULL
        AND leaseExpiresAt <= ${now} ${after}
      ORDER BY BINARY id ASC LIMIT ${input.limit + 1}
    `);
      if (raw.length > input.limit + 1)
        throw new HistoricalImportConflictError();
      let previous = input.afterSourceId;
      const rows = raw.map((value) => {
        const parsed = candidateSchema.safeParse(value);
        if (!parsed.success) throw new HistoricalImportConflictError();
        const row = parsed.data;
        if (
          row.storeId !== input.storeId ||
          row.programId !== input.programId ||
          row.installationGeneration !== input.installationGeneration ||
          row.leaseExpiresAt > now ||
          (previous !== undefined &&
            Buffer.compare(Buffer.from(previous), Buffer.from(row.id)) >= 0)
        )
          throw new HistoricalImportConflictError();
        previous = row.id;
        return {
          sourceId: row.id,
          storeId: row.storeId,
          programId: row.programId,
          installationGeneration: row.installationGeneration,
        };
      });
      return {
        candidates: rows.slice(0, input.limit),
        nextCursor:
          rows.length > input.limit ? rows[input.limit - 1].sourceId : null,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}
