import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { hasShopifyCustomerRedactionTombstone } from "../loyalty/shopper-privacy";
import {
  canonicalizeShopifyCustomerId,
  loadShopifyPrivacyHmacKeyring,
  parseShopifyCustomerPrivacyPseudonym,
} from "../shopify/privacy-identity";
import type { ReviewPrivacyBackfillCheckpoint } from "./privacy-owner-backfill";
import {
  buildReviewPrivacyOwnerProjection,
  reviewPrivacyKeySetDigest,
} from "./privacy-owner-contract";
import { reviewPrivacyOwnerSources } from "./privacy-owner-sources";

/** Independent read-only comparison with persisted sources, including unpublished
 * review owners. A page is one RR snapshot; a multi-page scan is NOT an atomic
 * store snapshot or proof that concurrent insertions before its cursor were seen.
 * Private checkpoint is operator-only; never expose it through a shopper API.
 */
export async function reconcileReviewPrivacySourcePage({
  storeId,
  installationGeneration,
  checkpoint,
  limit = 50,
}: {
  storeId: string;
  installationGeneration: string;
  checkpoint?: ReviewPrivacyBackfillCheckpoint;
  limit?: number;
}) {
  if (
    !storeId ||
    storeId.trim() !== storeId ||
    storeId.length > 191 ||
    !installationGeneration ||
    installationGeneration.trim() !== installationGeneration ||
    installationGeneration.length > 64 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Review privacy reconciliation scope invalid");
  const keyring = loadShopifyPrivacyHmacKeyring();
  const keySetDigest = reviewPrivacyKeySetDigest(keyring);
  if (
    checkpoint &&
    (checkpoint.storeId !== storeId ||
      checkpoint.installationGeneration !== installationGeneration ||
      checkpoint.keySetDigest !== keySetDigest ||
      !checkpoint.afterShopperId ||
      checkpoint.afterShopperId.trim() !== checkpoint.afterShopperId ||
      checkpoint.afterShopperId.length > 191)
  )
    throw new Error("Review privacy reconciliation checkpoint mismatch");
  return prisma.$transaction(
    async (tx) => {
      const store = await tx.weleticShopifyStore.findUnique({
        where: { id: storeId },
        select: {
          installationGeneration: true,
          storeAccessState: true,
          complianceState: true,
        },
      });
      if (
        !store ||
        store.installationGeneration !== installationGeneration ||
        store.storeAccessState !== "active" ||
        store.complianceState !== "active"
      )
        throw new Error(
          "Review privacy reconciliation installation unavailable",
        );
      const owners = await tx.weleticShopper.findMany({
        where: {
          ...reviewPrivacyOwnerSources(storeId),
          ...(checkpoint ? { id: { gt: checkpoint.afterShopperId } } : {}),
        },
        select: { id: true, shopifyCustomerId: true, email: true },
        orderBy: { id: "asc" },
        take: limit + 1,
      });
      // One store-wide reference snapshot at the beginning of a scan. Missing
      // or cross-store owners otherwise disappear from the owner-based scan.
      let orphanReviews: number | null = null;
      let orphanRequests: number | null = null;
      if (!checkpoint) {
        const rows = await tx.$queryRaw<
          Array<{ total: bigint; requests: bigint }>
        >`
          SELECT SUM(source.total) AS total, SUM(source.requests) AS requests FROM (
            SELECT COUNT(*) AS total, 0 AS requests FROM WeleticProductReview r
            LEFT JOIN WeleticShopper s ON s.storeId = r.storeId AND s.id = r.shopperId
            WHERE r.storeId = ${storeId} AND s.id IS NULL
            UNION ALL
            SELECT COUNT(*) AS total, 0 AS requests FROM WeleticStoreReview r
            LEFT JOIN WeleticShopper s ON s.storeId = r.storeId AND s.id = r.shopperId
            WHERE r.storeId = ${storeId} AND s.id IS NULL
            UNION ALL
            SELECT 0 AS total, COUNT(*) AS requests FROM WeleticReviewRequest r
            LEFT JOIN WeleticShopper s ON s.storeId = r.storeId AND s.id = r.shopperId
            WHERE r.storeId = ${storeId} AND s.id IS NULL
            UNION ALL
            SELECT 0 AS total, COUNT(*) AS requests FROM WeleticStoreReviewRequest r
            LEFT JOIN WeleticShopper s ON s.storeId = r.storeId AND s.id = r.shopperId
            WHERE r.storeId = ${storeId} AND s.id IS NULL
          ) source
        `;
        orphanReviews = Number(rows[0]?.total);
        orphanRequests = Number(rows[0]?.requests);
        if (
          rows.length !== 1 ||
          !Number.isSafeInteger(orphanReviews) ||
          orphanReviews < 0 ||
          !Number.isSafeInteger(orphanRequests) ||
          orphanRequests < 0
        )
          throw new Error("Review privacy owner reference counts unavailable");
      }
      const counts = {
        matched: 0,
        missing: 0,
        mismatched: 0,
        invalidSource: 0,
        suppressedClean: 0,
        suppressedPending: 0,
      };
      for (const owner of owners.slice(0, limit)) {
        const scope = { storeId, shopperId: owner.id };
        const coverage = await tx.weleticReviewOwnerPrivacyCoverage.findUnique({
          where: { storeId_shopperId: scope },
        });
        const identities = await tx.weleticReviewOwnerPrivacyIdentity.findMany({
          where: scope,
          select: {
            identityKind: true,
            identityKeyId: true,
            customerDigest: true,
          },
        });
        const accounts = await tx.weleticLoyaltyAccount.findMany({
          where: scope,
          select: { metadata: true },
          take: 2,
        });
        if (accounts.length > 1) {
          counts.invalidSource++;
          continue;
        }
        let pseudonym = false;
        let expected:
          | ReturnType<typeof buildReviewPrivacyOwnerProjection>
          | undefined;
        try {
          if (
            /^redacted:/i.test(
              canonicalizeShopifyCustomerId(owner.shopifyCustomerId),
            )
          ) {
            pseudonym = !!parseShopifyCustomerPrivacyPseudonym(
              owner.shopifyCustomerId,
              keyring,
            );
            if (!pseudonym) throw new Error("Invalid pseudonym");
          } else
            expected = buildReviewPrivacyOwnerProjection({
              ...scope,
              installationGeneration,
              shopifyCustomerId: owner.shopifyCustomerId,
              email: owner.email,
              keyring,
            });
        } catch {
          counts.invalidSource++;
          continue;
        }
        // Compare all retained proofs too: an old-key/unlinked tombstone must not
        // disappear from reconciliation because the source or key configuration moved.
        const tombstone =
          await tx.weleticShopifyCustomerPrivacyTombstone.findFirst({
            where: {
              storeId,
              OR: [
                { shopperId: owner.id },
                ...identities,
                ...(expected?.identities ?? []),
              ],
            },
            select: { id: true },
          });
        if (
          pseudonym ||
          tombstone ||
          coverage?.state === "redacted" ||
          hasShopifyCustomerRedactionTombstone(accounts[0]?.metadata)
        ) {
          // This certifies only this projection/source pair, not complete shopper
          // erasure across reviews, media, exports, accounts or provider systems.
          const terminal =
            pseudonym &&
            owner.email === null &&
            coverage?.state === "redacted" &&
            coverage.identityCount === 0 &&
            coverage.keySetDigest === null &&
            coverage.sourceDigest === null &&
            coverage.redactedAt !== null &&
            identities.length === 0;
          if (terminal) counts.suppressedClean++;
          else counts.suppressedPending++;
          continue;
        }
        if (!coverage) {
          counts.missing++;
          continue;
        }
        const proofTuples = (rows: typeof identities) =>
          rows
            .map((row) =>
              JSON.stringify([
                row.identityKind,
                row.identityKeyId,
                row.customerDigest,
              ]),
            )
            .sort();
        if (
          expected &&
          coverage.state === "active" &&
          coverage.installationGeneration === installationGeneration &&
          coverage.keySetDigest === expected.keySetDigest &&
          coverage.sourceDigest === expected.sourceDigest &&
          coverage.redactedAt === null &&
          coverage.identityCount === expected.identities.length &&
          identities.length === expected.identities.length &&
          JSON.stringify(proofTuples(identities)) ===
            JSON.stringify(proofTuples(expected.identities))
        )
          counts.matched++;
        else counts.mismatched++;
      }
      const last = owners.slice(0, limit).at(-1);
      return {
        counts,
        checked: Math.min(owners.length, limit),
        orphanReviews,
        orphanRequests,
        productionReady: false as const,
        checkpoint:
          owners.length > limit && last
            ? {
                storeId,
                installationGeneration,
                keySetDigest,
                afterShopperId: last.id,
              }
            : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
