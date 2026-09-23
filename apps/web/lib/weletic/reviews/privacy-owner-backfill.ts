import { prisma } from "@/lib/prisma";
import { createHash, randomUUID } from "node:crypto";
import { loadShopifyPrivacyHmacKeyring } from "../shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "../shopify/store-compliance-state";
import { reviewPrivacyKeySetDigest } from "./privacy-owner-contract";
import { redactReviewOwnerPrivacyProjection } from "./privacy-owner-redact";
import { reviewPrivacyOwnerSources } from "./privacy-owner-sources";
import {
  replaceReviewOwnerPrivacyProjection,
  ReviewOwnerPrivacySuppressedError,
} from "./privacy-owner-write";

type BackfillScope = {
  storeId: string;
  installationGeneration: string;
  keySetDigest: string;
};

/** Private operator checkpoint, not a shopper cursor or public API contract. */
export type ReviewPrivacyBackfillCheckpoint = BackfillScope & {
  afterShopperId: string;
};

/** Internal bounded maintenance primitive. Completion of a scan is NOT store
 * readiness: concurrent insertion before a checkpoint needs reconciliation.
 * The eventual operator entry point must remain explicitly authorized.
 */
export async function backfillReviewOwnerPrivacyPage({
  storeId,
  installationGeneration,
  keySetDigest,
  checkpoint,
  limit = 50,
  audit,
  dryRun = false,
  expectedPreviewDigest,
}: BackfillScope & {
  checkpoint?: ReviewPrivacyBackfillCheckpoint;
  limit?: number;
  // Trusted internal attribution, NOT authentication or a Shopify staff grant.
  // An operator-facing apply entry point must require this context.
  audit?: { runId: string; operatorReference: string };
  dryRun?: boolean;
  expectedPreviewDigest?: string;
}) {
  if (
    typeof dryRun !== "boolean" ||
    (expectedPreviewDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(expectedPreviewDigest))
  )
    throw new Error("Review privacy backfill preview invalid");
  if (
    audit &&
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      audit.runId,
    ) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(audit.operatorReference))
  )
    throw new Error("Review privacy backfill audit context invalid");
  if (
    !storeId ||
    storeId.trim() !== storeId ||
    storeId.length > 191 ||
    !installationGeneration ||
    installationGeneration.trim() !== installationGeneration ||
    installationGeneration.length > 64 ||
    !/^[a-f0-9]{64}$/.test(keySetDigest) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Review privacy backfill scope invalid");
  if (
    checkpoint &&
    (checkpoint.storeId !== storeId ||
      checkpoint.installationGeneration !== installationGeneration ||
      checkpoint.keySetDigest !== keySetDigest ||
      !checkpoint.afterShopperId ||
      checkpoint.afterShopperId.trim() !== checkpoint.afterShopperId ||
      checkpoint.afterShopperId.length > 191)
  )
    throw new Error("Review privacy backfill checkpoint mismatch");
  const currentKeys = () => {
    const keyring = loadShopifyPrivacyHmacKeyring();
    if (reviewPrivacyKeySetDigest(keyring) !== keySetDigest)
      throw new Error("Review privacy backfill key set changed");
    return keyring;
  };
  currentKeys();
  const owners = await prisma.$transaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId,
      expectedInstallationGeneration: installationGeneration,
      action: "review_privacy_backfill",
    });
    return tx.weleticShopper.findMany({
      where: {
        ...reviewPrivacyOwnerSources(storeId),
        ...(checkpoint ? { id: { gt: checkpoint.afterShopperId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
  });
  // This confirms the selected batch, not historical source values or privacy
  // readiness. Each current owner is independently revalidated under write locks.
  const previewDigest = createHash("sha256")
    .update(
      JSON.stringify([
        "review-privacy-backfill-selection-v1",
        storeId,
        installationGeneration,
        keySetDigest,
        checkpoint?.afterShopperId ?? null,
        limit,
        owners.map((owner) => owner.id),
      ]),
    )
    .digest("hex");
  if (
    expectedPreviewDigest !== undefined &&
    expectedPreviewDigest !== previewDigest
  )
    throw new Error("Review privacy backfill preview changed");
  if (dryRun)
    return {
      projected: 0,
      suppressed: 0,
      checkpoint: null,
      preview: {
        digest: previewDigest,
        selected: Math.min(owners.length, limit),
        hasMore: owners.length > limit,
      },
    };
  let projected = 0;
  let suppressed = 0;
  for (const owner of owners.slice(0, limit)) {
    const outcome = await prisma.$transaction(async (tx) => {
      const keyring = currentKeys();
      let result: "projected" | "suppressed";
      try {
        await replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner.id,
          installationGeneration,
          keyring,
        });
        result = "projected";
      } catch (error) {
        if (!(error instanceof ReviewOwnerPrivacySuppressedError)) throw error;
        // The source helper still holds current store/owner/privacy locks.
        // Record only authoritative suppression; source erasure is a separate
        // privacy-worker obligation, not something this backfill claims to do.
        await redactReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner.id,
        });
        result = "suppressed";
      }
      // Outside the suppression catch: audit failures must abort this owner's
      // transaction, never be interpreted as authoritative privacy suppression.
      if (audit)
        await tx.weleticReviewPrivacyBackfillAudit.create({
          data: {
            id: randomUUID(),
            runId: audit.runId,
            storeId,
            installationGeneration,
            operatorReference: audit.operatorReference,
            outcome: result,
          },
        });
      return result;
    });
    if (outcome === "projected") projected++;
    else suppressed++;
  }
  const last = owners.slice(0, limit).at(-1);
  return {
    projected,
    suppressed,
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
}
