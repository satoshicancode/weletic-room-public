import { OptimisticConcurrencyError } from "@/lib/weletic/loyalty/ledger";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { Prisma } from "@prisma/client";

export async function withReviewMutation<T>(
  storeId: string,
  operation: (
    tx: Prisma.TransactionClient,
    generation: string | null,
  ) => Promise<T>,
  expectedInstallationGeneration?: string | null,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withActiveStoreLoyaltyMutation({
        storeId,
        action: "native_reviews",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        operation,
      });
    } catch (error) {
      if (
        attempt >= 4 ||
        !(
          error instanceof OptimisticConcurrencyError ||
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2034")
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
