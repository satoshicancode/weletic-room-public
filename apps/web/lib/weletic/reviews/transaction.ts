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
            (error.code === "P2034" ||
              // Raw SQL store/review locks surface MySQL's transaction-wide
              // deadlock rollback as P2010/1213 rather than P2034. Do not
              // broaden this to lock timeouts or ambiguous connection errors.
              (error.code === "P2010" && error.meta?.code === "1213")))
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
