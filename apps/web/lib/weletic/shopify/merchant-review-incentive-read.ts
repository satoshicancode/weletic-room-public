import type { Prisma } from "@prisma/client";
import { ReviewError } from "../reviews/contracts";
import { reviewIncentiveDisclosure } from "../reviews/incentive-disclosure";
import {
  merchantReviewIncentiveReadInputSchema,
  merchantReviewIncentiveReadResponseSchema,
} from "../reviews/incentive-merchant-contract";
import { readReviewIncentivePolicySnapshot } from "../reviews/incentive-policy";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";

/** Signed merchant caller only. No default settings or policies are created by
 * reading. The authorization receipt is the only write in this transaction.
 */
export async function readShopifyMerchantReviewIncentivesInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  merchantReviewIncentiveReadInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "reviews.configure",
  });
  const settings = await tx.weleticReviewSettings.findUnique({
    where: { storeId: actor.storeId },
    select: { incentivePolicyRevision: true, activeIncentivePolicyId: true },
  });
  const revision = settings?.incentivePolicyRevision ?? 0;
  const unavailable = () =>
    new ReviewError(
      "unavailable",
      "Review incentive policies require reconciliation",
    );
  if (!Number.isInteger(revision) || revision < 0 || revision > 2147483647)
    throw unavailable();
  const latest = revision
    ? await tx.weleticReviewIncentivePolicy.findUnique({
        where: { storeId_revision: { storeId: actor.storeId, revision } },
        select: { id: true },
      })
    : null;
  if (revision && !latest) throw unavailable();
  async function view(id: string) {
    const row = await tx.weleticReviewIncentivePolicy.findUnique({
      where: { storeId_id: { storeId: actor.storeId, id } },
      select: { id: true, revision: true, contentDigest: true },
    });
    if (!row || row.revision < 1 || row.revision > revision)
      throw unavailable();
    // This reader validates store ownership, strict snapshot shape and digest.
    const snapshot = await readReviewIncentivePolicySnapshot(
      tx,
      actor.storeId,
      id,
    );
    if (!snapshot) throw unavailable();
    let disclosure: ReturnType<typeof reviewIncentiveDisclosure> = null;
    try {
      disclosure = reviewIncentiveDisclosure(snapshot);
    } catch (error) {
      // An intact historical promise can be non-renderable (e.g. missing saved
      // target labels). Surface that state without inventing catalog terms.
      if (!(error instanceof ReviewError) || error.code !== "unavailable")
        throw error;
    }
    return {
      policyId: row.id,
      revision: row.revision,
      contentDigest: row.contentDigest,
      draft:
        snapshot.award.kind === "coupon"
          ? {
              kind: "coupon" as const,
              rewardDefinitionId: snapshot.award.terms.rewardDefinitionId,
            }
          : snapshot.award,
      disclosure,
      disclosureState: disclosure
        ? ("available" as const)
        : ("unavailable" as const),
    };
  }
  const latestPolicy = latest ? await view(latest.id) : null;
  const activeId = settings?.activeIncentivePolicyId ?? null;
  const activePolicy =
    activeId === null
      ? null
      : activeId === latest?.id
        ? latestPolicy
        : await view(activeId);
  return merchantReviewIncentiveReadResponseSchema.parse({
    revision,
    installationGeneration: actor.installationGeneration,
    activePolicy,
    latestPolicy,
    mode: activeId === null ? "legacy" : "versioned",
  });
}
