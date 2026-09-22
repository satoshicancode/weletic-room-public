import {
  admitShopperDeliveryInTransaction,
  ShopperDeliveryAlreadySentError,
  shopperDeliveryContentDigest,
  ShopperDeliveryIneligibleError,
} from "@/lib/weletic/merchant-settings/delivery-reservations";
import type { Prisma } from "@prisma/client";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";

/** Runs under the same exact outbox/source claim that retained these bytes. */
export async function admitRetainedLoyaltyDelivery({
  tx,
  storeId,
  installationGeneration,
  accountId,
  sourceKey,
  producer,
  request,
  preparedAt,
  expiresAt,
  now,
  priorAttempt,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string | null;
  accountId: string;
  sourceKey: string;
  producer: "loyalty_communication" | "points_expiry";
  request: { to: string };
  preparedAt: Date;
  expiresAt: Date | null;
  now?: Date;
  priorAttempt: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId, status: "active" },
    select: {
      shopper: {
        select: {
          shopifyCustomerId: true,
          email: true,
          acceptsMarketing: true,
        },
      },
    },
  });
  if (
    !installationGeneration ||
    !account?.shopper.acceptsMarketing ||
    account.shopper.email !== request.to
  )
    throw new ShopperDeliveryIneligibleError();
  const result = await admitShopperDeliveryInTransaction({
    tx,
    now,
    priorAttempt,
    loyaltyMaintenancePermit,
    input: {
      storeId,
      installationGeneration,
      producer,
      sourceKey,
      provider: "resend",
      contentDigest: shopperDeliveryContentDigest(request),
      email: request.to,
      shopifyCustomerId: account.shopper.shopifyCustomerId,
      expiresAt,
      retryUntil: new Date(preparedAt.getTime() + 23 * 60 * 60_000),
    },
  });
  if (result.status === "sent") throw new ShopperDeliveryAlreadySentError();
}
