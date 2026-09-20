import type { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import {
  lockReviewOwnerPrivacySource,
  ReviewOwnerPrivacySuppressedError,
} from "./privacy-owner-write";

/** Caller holds current store/staff authority in the same transaction. This
 * checks retained proofs without creating coverage or enabling any module.
 */
export async function assertReviewTranslationOwnerAvailable(input: {
  tx: Prisma.TransactionClient;
  storeId: string;
  shopperId: string;
  installationGeneration: string;
}) {
  try {
    await lockReviewOwnerPrivacySource(input);
  } catch (error) {
    if (error instanceof ReviewOwnerPrivacySuppressedError)
      throw new ReviewError("not_found", "Review unavailable");
    throw error;
  }
}
