import type { Prisma } from "@prisma/client";

/** Customer-owned history only; never export bearer material or worker leases. */
export const reviewReminderExportSelect = {
  id: true,
  requestId: true,
  sequence: true,
  scheduledFor: true,
  status: true,
  sentAt: true,
  settledAt: true,
  outcomeReason: true,
  createdAt: true,
} satisfies Prisma.WeleticReviewReminderSelect;
