import type { Prisma } from "@prisma/client";

/** Shared owner discovery for projection maintenance and independent checks.
 * Invitations need coverage even before submission. Imported content without a
 * shopper is deliberately not assigned a fabricated owner by this query.
 */
export function reviewPrivacyOwnerSources(storeId: string) {
  if (!storeId || storeId.trim() !== storeId || storeId.length > 191)
    throw new Error("Review privacy source store invalid");
  return {
    storeId,
    OR: [
      { nativeReviews: { some: { storeId } } },
      { reviewRequests: { some: { storeId } } },
      { storeReviews: { some: { storeId } } },
      { storeReviewRequests: { some: { storeId } } },
    ],
  } satisfies Prisma.WeleticShopperWhereInput;
}
