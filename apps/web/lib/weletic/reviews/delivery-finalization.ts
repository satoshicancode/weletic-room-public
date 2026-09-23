import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { prepareReviewRemindersInTransaction } from "./reminder-production";

const schema = z
  .object({
    storeId: z.string().min(1).max(191),
    requestId: z.string().min(1).max(191),
    leaseToken: z.string().min(1).max(64),
    installationGeneration: z.string().min(1).max(64).nullable(),
    invitationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

/** Called only after confirmed initial transport, inside a database transaction
 * and the existing customer settlement lock. A lost lease rolls everything back;
 * recovery uses the already prepared initial provider identity, never a new send.
 */
export async function finalizeReviewDeliveryInTransaction(
  tx: Prisma.TransactionClient,
  input: z.infer<typeof schema>,
) {
  const data = schema.parse(input);
  await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${data.storeId} FOR UPDATE`;
  const finalized = await tx.weleticReviewRequest.updateMany({
    where: {
      id: data.requestId,
      storeId: data.storeId,
      installationGeneration: data.installationGeneration,
      status: "sending",
      deliveryToken: data.leaseToken,
    },
    data: {
      status: "sent",
      sentAt: new Date(),
      deliveryToken: null,
      deliveryLeaseExpiresAt: null,
      encryptedDeliveryToken: null,
      encryptedDeliverySnapshot: null,
      lastError: null,
    },
  });
  if (finalized.count !== 1)
    throw new ReviewError(
      "conflict",
      "Review delivery lease lost before finalization",
    );
  if (data.installationGeneration)
    await prepareReviewRemindersInTransaction(tx, {
      storeId: data.storeId,
      requestId: data.requestId,
      installationGeneration: data.installationGeneration,
      token: data.invitationToken,
    });
}
