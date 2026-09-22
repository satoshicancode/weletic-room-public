import type { Prisma } from "@prisma/client";
import { z } from "zod";

const inputSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    requestIds: z
      .array(z.string().min(1).max(191))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    reason: z.enum([
      "submitted",
      "expired",
      "privacy",
      "settings_disabled",
      "purchase_ineligible",
    ]),
  })
  .strict();

/** Erasure-only primitive. Caller owns the existing store/customer lifecycle
 * fence. Preserve sent/ambiguous history; erase private payloads and cancel only
 * unsettled delivery authority. No invitation, award or enrollment is created.
 */
export async function eraseReviewReminderMaterialInTransaction(
  tx: Prisma.TransactionClient,
  input: z.infer<typeof inputSchema>,
) {
  const { storeId, requestIds, reason } = inputSchema.parse(input);
  const owned = {
    storeId,
    requestId: { in: requestIds },
    request: { storeId, id: { in: requestIds } },
  } satisfies Prisma.WeleticReviewReminderWhereInput;
  await tx.weleticReviewReminder.updateMany({
    where: {
      ...owned,
      attempts: 0,
      status: { in: ["queued", "sending", "failed"] },
    },
    data: {
      status: "cancelled",
      settledAt: new Date(),
      outcomeReason: reason,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  await tx.weleticReviewReminder.updateMany({
    where: {
      ...owned,
      attempts: { gt: 0 },
      status: { in: ["queued", "sending", "failed"] },
    },
    data: {
      status: "reconciliation",
      settledAt: new Date(),
      outcomeReason: `${reason}_delivery_unconfirmed`,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  // Includes sent/reconciliation rows, without rewriting their transport outcome.
  await tx.weleticReviewReminder.updateMany({
    where: owned,
    data: { encryptedDeliverySnapshot: null },
  });
  await tx.weleticReviewRequest.updateMany({
    where: { storeId, id: { in: requestIds } },
    data: { encryptedReminderToken: null },
  });
}

/** Same transaction as the settings disable. Cancel pending authority now so a
 * rapid disable/re-enable cannot revive old reminders before a sweep runs.
 * Initial sent invitation hashes remain usable when only email is disabled.
 */
export async function disableReviewRemindersInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  z.string().min(1).max(191).parse(storeId);
  await tx.weleticReviewReminder.updateMany({
    where: {
      storeId,
      request: { storeId },
      attempts: 0,
      status: { in: ["queued", "sending", "failed"] },
    },
    data: {
      status: "cancelled",
      settledAt: new Date(),
      outcomeReason: "settings_disabled",
      leaseToken: null,
      leaseExpiresAt: null,
      encryptedDeliverySnapshot: null,
    },
  });
  await tx.weleticReviewReminder.updateMany({
    where: {
      storeId,
      request: { storeId },
      attempts: { gt: 0 },
      status: { in: ["queued", "sending", "failed"] },
    },
    data: {
      status: "reconciliation",
      settledAt: new Date(),
      outcomeReason: "settings_disabled_delivery_unconfirmed",
      leaseToken: null,
      leaseExpiresAt: null,
      encryptedDeliverySnapshot: null,
    },
  });
  await tx.weleticReviewRequest.updateMany({
    where: { storeId, encryptedReminderToken: { not: null } },
    data: { encryptedReminderToken: null },
  });
}
