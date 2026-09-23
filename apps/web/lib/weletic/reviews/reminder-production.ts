import { encrypt } from "@/lib/encryption";
import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { hashReviewToken, ReviewError } from "./contracts";
import { planReviewReminders } from "./reminder-schedule";

const identity = z
  .object({
    storeId: z.string().min(1).max(191),
    requestId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

/** Called in initial delivery finalization under the store/customer fence.
 * A successful initial transport is prerequisite, not permission to resurrect
 * paused, retired or cancelled reminders. Never callable from a public route.
 */
export async function prepareReviewRemindersInTransaction(
  tx: Prisma.TransactionClient,
  input: z.infer<typeof identity>,
) {
  const { storeId, requestId, installationGeneration, token } =
    identity.parse(input);
  const request = await tx.weleticReviewRequest.findFirst({
    where: { id: requestId, storeId, installationGeneration },
    include: { store: { include: { reviewSettings: true } } },
  });
  if (
    !request ||
    request.status !== "sent" ||
    !request.sentAt ||
    request.expiresAt <= new Date()
  )
    return 0;
  const store = request.store;
  if (
    store.installationGeneration !== installationGeneration ||
    store.complianceState !== "active" ||
    store.storeAccessState !== "active" ||
    !store.reviewSettings?.enabled ||
    !store.reviewSettings.requestEmailEnabled
  )
    return 0;
  if (!request.tokenHash || hashReviewToken(token) !== request.tokenHash)
    throw new ReviewError("conflict", "Reminder invitation identity changed");
  const planned = planReviewReminders({
    snapshot: request.reminderSnapshot,
    sentAt: request.sentAt,
    expiresAt: request.expiresAt,
  });
  let unsettled = 0;
  for (const { sequence, dueAt } of planned) {
    const row = await tx.weleticReviewReminder.upsert({
      where: { storeId_requestId_sequence: { storeId, requestId, sequence } },
      create: {
        id: createWeleticId("wrevrem_"),
        storeId,
        requestId,
        sequence,
        installationGeneration,
        scheduledFor: dueAt,
      },
      update: {},
    });
    if (
      row.storeId !== storeId ||
      row.requestId !== requestId ||
      row.sequence !== sequence ||
      row.installationGeneration !== installationGeneration ||
      row.scheduledFor.getTime() !== dueAt.getTime()
    )
      throw new ReviewError(
        "conflict",
        "Reminder delivery requires reconciliation",
      );
    if (["queued", "sending", "failed"].includes(row.status)) {
      unsettled++;
      // This row is the durable scheduling intent. The authenticated sweep
      // enqueues later; maintenance cannot roll back a confirmed email receipt.
    }
  }
  const retained = await tx.weleticReviewRequest.updateMany({
    where: {
      id: requestId,
      storeId,
      installationGeneration,
      status: "sent",
      tokenHash: request.tokenHash,
    },
    data: { encryptedReminderToken: unsettled ? encrypt(token) : null },
  });
  if (retained.count !== 1)
    throw new ReviewError(
      "conflict",
      "Reminder invitation changed during preparation",
    );
  return unsettled;
}
