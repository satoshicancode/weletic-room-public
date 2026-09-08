import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { REVIEW_INCENTIVE_REVERSAL_REFERENCE } from "./ledger-entry-policy";

const reversalEvidence = z.object({
  revision: z.literal("review_incentive_reversal_v1"),
  originalAwardEntryId: z.string().min(1),
  claimId: z.string().min(1),
});

/** Original earn dates define the VIP window. A later invalidation removes
 * that original contribution, never another cycle's unrelated earnings. Read
 * reversals in bounded ID batches; never treat ordinary refunds as invalidity.
 */
export async function sumValidQualifyingPoints({
  db,
  storeId,
  accountId,
  entries,
}: {
  db: Pick<Prisma.TransactionClient, "weleticPointsLedgerEntry">;
  storeId: string;
  accountId: string;
  entries: {
    id: string;
    pointsDelta: bigint;
    referenceType: string | null;
    referenceId: string | null;
  }[];
}) {
  const originals = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    if (entry.referenceType !== "REVIEW_INCENTIVE") continue;
    if (!entry.referenceId || !entry.id || originals.has(entry.referenceId))
      throw new Error(
        "Review qualifying-points ownership requires reconciliation",
      );
    originals.set(entry.referenceId, entry);
  }
  let total = entries.reduce(
    (sum, entry) => sum + BigInt(entry.pointsDelta),
    BigInt(0),
  );
  const claims = [...originals.keys()];
  const seen = new Set<string>();
  for (let offset = 0; offset < claims.length; offset += 500) {
    const reversals = await db.weleticPointsLedgerEntry.findMany({
      where: {
        storeId,
        accountId,
        entryType: "REFUND_REVERSAL",
        referenceType: REVIEW_INCENTIVE_REVERSAL_REFERENCE,
        referenceId: { in: claims.slice(offset, offset + 500) },
      },
      select: {
        referenceId: true,
        pointsDelta: true,
        pendingDelta: true,
        grantId: true,
        idempotencyKey: true,
        metadata: true,
      },
    });
    for (const reversal of reversals) {
      const original = reversal.referenceId
        ? originals.get(reversal.referenceId)
        : null;
      const evidence = reversalEvidence.safeParse(reversal.metadata);
      if (
        !original ||
        !evidence.success ||
        seen.has(reversal.referenceId!) ||
        evidence.data.originalAwardEntryId !== original.id ||
        evidence.data.claimId !== original.referenceId ||
        reversal.idempotencyKey !==
          `review_incentive_reversal:${original.referenceId}` ||
        reversal.pendingDelta !== BigInt(0) ||
        reversal.grantId !== null ||
        reversal.pointsDelta !== -original.pointsDelta
      )
        throw new Error(
          "Review qualifying-points reversal requires reconciliation",
        );
      seen.add(reversal.referenceId!);
      total -= original.pointsDelta;
    }
  }
  return total;
}
