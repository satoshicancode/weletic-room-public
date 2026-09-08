import { toggleLoyaltyModuleInTransaction } from "@/lib/weletic/loyalty/module-settings";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { shopifyMerchantSettingsInputSchema } from "@/lib/weletic/merchant-settings/merchant-contract";
import {
  readMerchantSettingsInTransaction,
  updateMerchantSettingsInTransaction,
} from "@/lib/weletic/merchant-settings/service";
import { toggleReviewModuleInTransaction } from "@/lib/weletic/reviews/service";
import type { Prisma } from "@prisma/client";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

/** Only call after authenticating the signature over the entire actor/request
 * body. Never authorize in one transaction and mutate in another.
 * Shared configuration does not authorize loyalty/review module transitions.
 */
export async function manageShopifyMerchantSettingsInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = shopifyMerchantSettingsInputSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission:
      data.operation === "review-module"
        ? "reviews.configure"
        : data.operation === "loyalty-module"
          ? "loyalty.configure"
          : data.operation === "appearance-read" ||
              data.operation === "appearance-update"
            ? "appearance.configure"
            : "settings.configure",
  });
  if (
    data.operation !== "read" &&
    data.operation !== "appearance-read" &&
    data.input.expectedInstallationGeneration !== actor.installationGeneration
  )
    throw new MerchantSettingsError("conflict");
  if (
    data.operation === "appearance-read" ||
    data.operation === "appearance-update"
  ) {
    const result =
      data.operation === "appearance-read"
        ? await readMerchantSettingsInTransaction(tx, actor.projectId)
        : await updateMerchantSettingsInTransaction({
            tx,
            storeId: actor.storeId,
            workspaceId: actor.projectId,
            input: data.input,
          });
    if (
      result.storeId !== actor.storeId ||
      result.installationGeneration !== actor.installationGeneration
    )
      throw new MerchantSettingsError("not_found");
    return {
      storeId: result.storeId,
      installationGeneration: result.installationGeneration,
      revision: result.revision,
      branding: result.branding,
      settings: {
        brandName: result.settings.brandName,
        logoUrl: result.settings.logoUrl,
        accentColor: result.settings.accentColor,
      },
    };
  }
  if (data.operation === "loyalty-module") {
    const program = await toggleLoyaltyModuleInTransaction(
      tx,
      actor.storeId,
      data.input,
    );
    return {
      storeId: actor.storeId,
      installationGeneration: actor.installationGeneration,
      settings: {
        status: program.status,
        killSwitchActive: program.killSwitchActive,
      },
    };
  }
  if (data.operation === "review-module") {
    const settings = await toggleReviewModuleInTransaction(
      tx,
      actor.storeId,
      data.input,
    );
    return {
      storeId: actor.storeId,
      installationGeneration: actor.installationGeneration,
      settings: {
        enabled: settings.enabled,
        requestEmailEnabled: settings.requestEmailEnabled,
        updatedAt: settings.updatedAt.toISOString(),
      },
    };
  }
  const capabilities = await readSettingsCapabilities(tx, actor);
  if (
    data.operation === "update" &&
    ["brandName", "logoUrl", "accentColor"].some((key) =>
      Object.prototype.hasOwnProperty.call(data.input.settings, key),
    ) &&
    !capabilities.appearance
  )
    throw new ShopifyStaffAuthorizationError("access_denied");
  const result =
    data.operation === "read"
      ? await readMerchantSettingsInTransaction(tx, actor.projectId)
      : await updateMerchantSettingsInTransaction({
          tx,
          storeId: actor.storeId,
          workspaceId: actor.projectId,
          input: data.input,
        });
  if (
    result.storeId !== actor.storeId ||
    result.installationGeneration !== actor.installationGeneration
  )
    throw new MerchantSettingsError("not_found");
  return { ...result, capabilities };
}
