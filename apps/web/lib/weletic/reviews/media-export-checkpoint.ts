import { prisma } from "@/lib/prisma";
import {
  readComplianceMediaCheckpoint,
  storeEncryptedComplianceArtifact,
  type ComplianceArtifactLease,
} from "@/lib/weletic/shopify/compliance-artifacts";
import { z } from "zod";
import {
  exportReviewMediaFile,
  reviewMediaFileExportSelect,
  reviewMediaFileExportWhere,
} from "./media-file-export";

const checkpointSchema = z
  .object({
    format: z.literal("review_media_files_v1"),
    sequence: z.number().int().nonnegative().safe(),
    afterId: z.string().min(1).max(191).nullable(),
    hasMore: z.boolean(),
    files: z
      .array(z.object({ id: z.string().min(1).max(191) }).passthrough())
      .length(1),
  })
  .strict();

/** Publication owns the page cursor. A retry recovers this immutable result
 * even when the original row has disappeared from the live eligible set.
 */
export async function exportReviewMediaPage(input: {
  requestId: string;
  storeId: string;
  shopperId: string | null;
  sequence: number;
  afterId: string | null;
  expiresAt: Date;
  lease: ComplianceArtifactLease;
}) {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    input.sequence >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("Review export sequence invalid");
  function checkpoint(value: unknown) {
    const parsed = checkpointSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.sequence !== input.sequence ||
      parsed.data.afterId !== input.afterId
    )
      throw new Error(
        "Review export checkpoint is invalid or requires legacy recovery",
      );
    return { fileId: parsed.data.files[0].id, hasMore: parsed.data.hasMore };
  }
  const existing = await readComplianceMediaCheckpoint(input);
  if (existing !== null) return checkpoint(existing);
  if (!input.shopperId) return { fileId: null, hasMore: false };
  const rows = await prisma.weleticReviewMedia.findMany({
    where: reviewMediaFileExportWhere(input.storeId, input.shopperId),
    select: reviewMediaFileExportSelect,
    orderBy: { id: "asc" },
    take: 2,
    // Keyset comparison survives deletion of the previously exported row.
    ...(input.afterId
      ? {
          where: {
            ...reviewMediaFileExportWhere(input.storeId, input.shopperId),
            id: { gt: input.afterId },
          },
        }
      : {}),
  });
  if (!rows.length) return { fileId: null, hasMore: false };
  const file = await exportReviewMediaFile(
    input.storeId,
    input.shopperId,
    rows[0],
  );
  await storeEncryptedComplianceArtifact({
    ...input,
    kind: "review_media",
    value: {
      format: "review_media_files_v1",
      sequence: input.sequence,
      afterId: input.afterId,
      hasMore: rows.length > 1,
      files: [file],
    },
  });
  // The writer can return a pre-existing winner from a competing/ambiguous
  // publication. Resolve its encrypted cursor instead of trusting local rows.
  const winner = await readComplianceMediaCheckpoint(input);
  if (winner === null)
    throw new Error("Review export publication is unresolved");
  return checkpoint(winner);
}
