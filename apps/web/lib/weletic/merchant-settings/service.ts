import { prisma } from "@/lib/prisma";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import {
  MerchantSettingsError,
  merchantSettingsUpdateSchema,
  type MerchantSettingsUpdate,
} from "./contracts";

const storeProjection = {
  id: true,
  projectId: true,
  installationGeneration: true,
  defaultLocale: true,
  merchantSettings: true,
  loyaltyProgram: {
    select: { name: true, status: true, killSwitchActive: true },
  },
  reviewSettings: {
    select: { enabled: true, requestEmailEnabled: true, updatedAt: true },
  },
} satisfies Prisma.WeleticShopifyStoreSelect;

export async function readMerchantSettingsInTransaction(
  tx: Prisma.TransactionClient,
  workspaceId: string,
) {
  const store = await tx.weleticShopifyStore.findFirst({
    where: {
      projectId: workspaceId,
      complianceState: "active",
      installationGeneration: { not: null },
    },
    select: storeProjection,
  });
  if (!store?.installationGeneration)
    throw new MerchantSettingsError("not_found");
  const settings = store.merchantSettings;
  return {
    storeId: store.id,
    installationGeneration: store.installationGeneration,
    revision: settings?.revision ?? 0,
    settings: {
      brandName: settings?.brandName ?? null,
      logoUrl: settings?.logoUrl ?? null,
      accentColor: settings?.accentColor ?? null,
      defaultLocale: store.defaultLocale,
      timeZone: settings?.timeZone ?? null,
      shopperEmailPaused: settings?.shopperEmailPaused ?? false,
    },
    branding: {
      name: settings?.brandName ?? store.loyaltyProgram?.name ?? "Weletic",
      source: settings?.brandName
        ? ("merchant" as const)
        : store.loyaltyProgram?.name
          ? ("legacy_loyalty" as const)
          : ("default" as const),
    },
    modules: {
      loyalty: {
        status: store.loyaltyProgram?.status ?? "not_configured",
        killSwitchActive: store.loyaltyProgram?.killSwitchActive ?? false,
      },
      reviews: {
        enabled: store.reviewSettings?.enabled ?? false,
        requestEmailEnabled: store.reviewSettings?.requestEmailEnabled ?? false,
        updatedAt: store.reviewSettings?.updatedAt.toISOString() ?? null,
      },
    },
  };
}

export function readMerchantSettings(workspaceId: string) {
  return prisma.$transaction((tx) =>
    readMerchantSettingsInTransaction(tx, workspaceId),
  );
}

async function applySettings(
  tx: Prisma.TransactionClient,
  storeId: string,
  workspaceId: string,
  data: MerchantSettingsUpdate,
) {
  const current = await readMerchantSettingsInTransaction(tx, workspaceId);
  if (current.storeId !== storeId) throw new MerchantSettingsError("not_found");
  if (current.revision !== data.expectedRevision)
    throw new MerchantSettingsError("conflict");
  const { defaultLocale, ...settings } = data.settings;
  if (current.revision === 0) {
    await tx.weleticMerchantSettings.create({
      data: { storeId, revision: 1, ...settings },
    });
  } else {
    const updated = await tx.weleticMerchantSettings.updateMany({
      where: { storeId, revision: current.revision },
      data: { ...settings, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new MerchantSettingsError("conflict");
  }
  if (defaultLocale !== undefined)
    await tx.weleticShopifyStore.update({
      where: { id: storeId },
      data: { defaultLocale },
    });
  return readMerchantSettingsInTransaction(tx, workspaceId);
}

/** Internal primitive for an already authorized caller. Keep authorization,
 * the operational store fence and the write on the same transaction. This does
 * not turn Shopify staff into workspace owners or initialize either module.
 */
export async function updateMerchantSettingsInTransaction({
  tx,
  storeId,
  workspaceId,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  workspaceId: string;
  input: unknown;
}) {
  const data = merchantSettingsUpdateSchema.parse(input);
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    action: "shared_merchant_settings_update",
    expectedInstallationGeneration: data.expectedInstallationGeneration,
  });
  return applySettings(tx, storeId, workspaceId, data);
}

export async function updateMerchantSettings(
  workspaceId: string,
  input: unknown,
  role: string,
) {
  if (role !== "owner") throw new MerchantSettingsError("forbidden");
  const data = merchantSettingsUpdateSchema.parse(input);
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { projectId: workspaceId },
    select: { id: true },
  });
  if (!store) throw new MerchantSettingsError("not_found");
  return withActiveStoreLoyaltyMutation({
    storeId: store.id,
    action: "shared_merchant_settings_update",
    expectedInstallationGeneration: data.expectedInstallationGeneration,
    operation: (tx) => applySettings(tx, store.id, workspaceId, data),
  });
}

export type MerchantSettings = Awaited<ReturnType<typeof readMerchantSettings>>;
