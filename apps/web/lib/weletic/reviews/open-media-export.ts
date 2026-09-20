import type { Prisma } from "@prisma/client";

/** Authorized privacy export only. Includes unattached and terminal uploads,
 * never object keys, private digests, operation keys or authorization state.
 */
export const openReviewMediaExportSelect = {
  id: true,
  source: true,
  settingsRevision: true,
  createdAt: true,
  redactedAt: true,
  media: {
    select: {
      contentType: true,
      sizeBytes: true,
      status: true,
      uploadExpiresAt: true,
    },
  },
} satisfies Prisma.WeleticOpenReviewMediaOwnershipSelect;

export function openReviewMediaExportWhere(storeId: string, shopperId: string) {
  return {
    storeId,
    shopperId,
    media: { storeId, requestId: null },
  } satisfies Prisma.WeleticOpenReviewMediaOwnershipWhereInput;
}
