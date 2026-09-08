import {
  loyaltyConfigurationResponseSchema,
  requiresLoyaltyConfigurationOwner,
  shopifyLoyaltyConfigurationInputSchema,
} from "@/lib/weletic/loyalty/configuration-contract";
import {
  readLoyaltyConfigurationInTransaction,
  writeLoyaltyConfigurationInTransaction,
} from "@/lib/weletic/loyalty/configuration-service";
import { LoyaltySettingsWriteError } from "@/lib/weletic/loyalty/settings-writer";
import { normalizeCurrency } from "@/lib/weletic/money";
import type { Prisma } from "@prisma/client";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

/** The signed route owns the Serializable transaction. Do not call this before
 * verifying the signature over both actor and request. Never retry mutations.
 */
export async function manageShopifyLoyaltyConfigurationInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = shopifyLoyaltyConfigurationInputSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission:
      data.operation === "read" ? "loyalty.read" : "loyalty.configure",
  });
  if (data.operation === "update") {
    if (
      data.input.expectedInstallationGeneration !== actor.installationGeneration
    )
      throw new LoyaltySettingsWriteError({
        code: "conflict",
        message: "Installation changed",
      });
    if (requiresLoyaltyConfigurationOwner(data.input.settings) && !actor.owner)
      throw new ShopifyStaffAuthorizationError("access_denied");
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      action: "loyalty_admin_settings_update",
      expectedInstallationGeneration: actor.installationGeneration,
    });
  }
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: {
      projectId: true,
      program: { select: { accountingCurrency: true } },
    },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const accountingCurrency = normalizeCurrency(
    store.program.accountingCurrency,
  );
  const configuration =
    data.operation === "update"
      ? await writeLoyaltyConfigurationInTransaction({
          tx,
          storeId: actor.storeId,
          accountingCurrency,
          input: data.input,
        })
      : await readLoyaltyConfigurationInTransaction(tx, actor.storeId);
  const capabilities = await readSettingsCapabilities(tx, actor);
  return loyaltyConfigurationResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    accountingCurrency,
    ...configuration,
    capabilities: { configure: capabilities.loyalty, owner: actor.owner },
  });
}
