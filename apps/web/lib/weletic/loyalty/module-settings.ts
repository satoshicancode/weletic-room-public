import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import type { Prisma } from "@prisma/client";
import { loyaltyModuleToggleSchema } from "./module-contract";
import { writeValidatedLoyaltySettingsInTransaction } from "./settings-writer";

/** Caller authorizes loyalty.configure and owns the Serializable transaction. */
export async function toggleLoyaltyModuleInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
  input: unknown,
) {
  const data = loyaltyModuleToggleSchema.parse(input);
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    action: "loyalty_admin_settings_update",
    expectedInstallationGeneration: data.expectedInstallationGeneration,
  });
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
  });
  // Module controls cannot initialize a program or clear its emergency switch.
  if (!program) throw new MerchantSettingsError("not_found");
  if (program.status !== data.expectedStatus)
    throw new MerchantSettingsError("conflict");
  return writeValidatedLoyaltySettingsInTransaction(tx, storeId, {
    status: data.status,
    expectedStatus: data.expectedStatus,
  });
}
