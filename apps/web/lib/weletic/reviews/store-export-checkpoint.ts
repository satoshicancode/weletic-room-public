import { prisma } from "@/lib/prisma";
import {
  readComplianceReviewCheckpoint,
  storeEncryptedComplianceArtifact,
  type ComplianceArtifactLease,
} from "@/lib/weletic/shopify/compliance-artifacts";
import { z } from "zod";
import {
  storeReviewAuditExportSelect,
  storeReviewExportSelect,
  storeReviewRequestExportSelect,
} from "./store-export";

const PAGE_SIZE = 20;
const checkpointSchema = z
  .object({
    format: z.literal("store_review_rows_v1"),
    kind: z.enum([
      "store_reviews",
      "store_review_requests",
      "store_review_audits",
    ]),
    sequence: z.number().int().nonnegative().safe(),
    afterId: z.string().min(1).max(191).nullable(),
    shopperId: z.string().min(1).max(191),
    hasMore: z.boolean(),
    rows: z
      .array(z.object({ id: z.string().min(1).max(191) }).passthrough())
      .min(1)
      .max(PAGE_SIZE),
  })
  .strict();

/** Cursor and count come from the immutable winning artifact, never a refetched
 * live page after an ambiguous publication. Not a point-in-time store snapshot.
 */
export async function exportStoreReviewPage(input: {
  requestId: string;
  storeId: string;
  shopperId: string | null;
  kind: "store_reviews" | "store_review_requests" | "store_review_audits";
  sequence: number;
  afterId: string | null;
  expiresAt: Date;
  lease: ComplianceArtifactLease;
}) {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    input.sequence >= 2147483647
  )
    throw new Error("Store-review export sequence invalid");
  function recover(value: unknown) {
    const result = checkpointSchema.safeParse(value);
    if (
      !result.success ||
      result.data.kind !== input.kind ||
      result.data.sequence !== input.sequence ||
      result.data.afterId !== input.afterId ||
      result.data.shopperId !== input.shopperId
    )
      throw new Error("Store-review export checkpoint invalid");
    const page = result.data;
    const ids = page.rows.map(({ id }) => id);
    if (new Set(ids).size !== ids.length || ids.includes(input.afterId ?? ""))
      throw new Error("Store-review export checkpoint does not advance");
    return {
      lastId: page.rows[page.rows.length - 1].id,
      count: page.rows.length,
      hasMore: page.hasMore,
    };
  }
  const existing = await readComplianceReviewCheckpoint(input);
  if (existing !== null) return recover(existing);
  if (!input.shopperId) return { lastId: null, count: 0, hasMore: false };
  const page = {
    where: {
      storeId: input.storeId,
      shopperId: input.shopperId,
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
    },
    orderBy: { id: "asc" as const },
    take: PAGE_SIZE + 1,
  };
  const rows =
    input.kind === "store_reviews"
      ? await prisma.weleticStoreReview.findMany({
          ...page,
          select: storeReviewExportSelect,
        })
      : input.kind === "store_review_requests"
        ? await prisma.weleticStoreReviewRequest.findMany({
            ...page,
            select: storeReviewRequestExportSelect,
          })
        : await prisma.weleticStoreReviewModerationAudit.findMany({
            ...page,
            where: {
              storeId: input.storeId,
              review: { storeId: input.storeId, shopperId: input.shopperId },
              ...(input.afterId ? { id: { gt: input.afterId } } : {}),
            },
            select: storeReviewAuditExportSelect,
          });
  if (!rows.length) return { lastId: null, count: 0, hasMore: false };
  await storeEncryptedComplianceArtifact({
    ...input,
    value: {
      format: "store_review_rows_v1",
      kind: input.kind,
      sequence: input.sequence,
      afterId: input.afterId,
      shopperId: input.shopperId,
      hasMore: rows.length > PAGE_SIZE,
      rows: rows.slice(0, PAGE_SIZE),
    },
  });
  const winner = await readComplianceReviewCheckpoint(input);
  if (winner === null)
    throw new Error("Store-review export publication unresolved");
  return recover(winner);
}
