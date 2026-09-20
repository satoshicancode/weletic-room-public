import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { buildReviewStorePrivacySql } from "./privacy-public-sql";

/** Read-only diagnostic of the same eligibility used by public readers.
 * This is snapshot evidence, not authorization to activate writers, proof of
 * source-writer completeness, or certification of production readiness.
 * No raw owner identifiers, HMAC proofs or shopper content leave this function.
 */
export async function inspectReviewPrivacyReaderCoverage({
  storeId,
  installationGeneration,
}: {
  storeId: string;
  installationGeneration: string;
}) {
  if (
    !storeId ||
    storeId.trim() !== storeId ||
    storeId.length > 191 ||
    !installationGeneration ||
    installationGeneration.trim() !== installationGeneration ||
    installationGeneration.length > 64
  )
    throw new Error("Review privacy inspection scope invalid");
  return prisma.$transaction(
    async (tx) => {
      const store = await tx.weleticShopifyStore.findUnique({
        where: { id: storeId },
        select: {
          installationGeneration: true,
          complianceState: true,
          storeAccessState: true,
          reviewSettings: { select: { enabled: true } },
        },
      });
      if (!store || store.installationGeneration !== installationGeneration)
        throw new Error("Review privacy inspection installation unavailable");
      if (
        store.complianceState !== "active" ||
        store.storeAccessState !== "active"
      )
        return {
          status: "store_unavailable" as const,
          readerCoverageComplete: false,
          counts: null,
        };
      if (!store.reviewSettings?.enabled)
        return {
          status: "module_disabled" as const,
          readerCoverageComplete: false,
          counts: null,
        };
      const privacy = buildReviewStorePrivacySql({
        storeId,
        installationGeneration,
      });
      const rows = await tx.$queryRaw<
        Array<{
          total: bigint;
          eligible: bigint | null;
          suppressed: bigint | null;
          unknown: bigint | null;
        }>
      >(Prisma.sql`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN ${privacy.eligible} THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN ${privacy.suppressed} THEN 1 ELSE 0 END) AS suppressed,
        SUM(CASE WHEN ${privacy.unknown} THEN 1 ELSE 0 END) AS unknown
      FROM ${privacy.from} WHERE ${privacy.base}`);
      if (rows.length !== 1)
        throw new Error("Review privacy inspection totals unavailable");
      const counts = {
        total: Number(rows[0].total),
        eligible: Number(rows[0].eligible ?? 0),
        suppressed: Number(rows[0].suppressed ?? 0),
        unknown: Number(rows[0].unknown ?? 0),
      };
      if (
        Object.values(counts).some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        ) ||
        counts.eligible + counts.suppressed + counts.unknown !== counts.total
      )
        throw new Error("Review privacy inspection totals invalid");
      return {
        status: "inspected" as const,
        readerCoverageComplete: counts.unknown === 0,
        counts,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
