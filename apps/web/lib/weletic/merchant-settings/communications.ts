import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export class ShopperEmailPausedError extends Error {
  constructor() {
    super("Shopper email is paused");
    this.name = "ShopperEmailPausedError";
  }
}

/** Shared shopper email policy only; this never grants marketing consent or
 * enables a producer. Missing configuration preserves the producer's gates. */
export async function readShopperCommunicationSettings({
  storeId,
  legacyBrandName = "Weletic",
  tx = prisma,
}: {
  storeId: string;
  legacyBrandName?: string;
  tx?: Pick<Prisma.TransactionClient, "weleticMerchantSettings">;
}) {
  const settings = await tx.weleticMerchantSettings.findUnique({
    where: { storeId },
    select: {
      brandName: true,
      logoUrl: true,
      accentColor: true,
      shopperEmailPaused: true,
    },
  });
  return {
    brandName: settings?.brandName ?? legacyBrandName,
    configuredBrandName: settings?.brandName ?? null,
    logoUrl: settings?.logoUrl ?? null,
    accentColor: settings?.accentColor ?? null,
    paused: settings?.shopperEmailPaused ?? false,
  };
}
