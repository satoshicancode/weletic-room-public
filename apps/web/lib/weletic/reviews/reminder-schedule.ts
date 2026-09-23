import { z } from "zod";
import { reviewCollectionPolicySchema } from "./collection-contract";

const DAY_MS = 86_400_000;
const reminderSnapshotSchema = z
  .object({
    version: z.literal(1),
    collectionRevision: z.number().int().min(0).max(2_147_483_647),
    expiresAfterDays: z.number().int().min(1).max(90),
    reminderAfterDays: z.array(z.number().int().min(1).max(89)).max(3),
  })
  .strict();

/** Immutable schedule only; never contains tokens, recipients or award terms.
 * Existing invitations without a snapshot have no retroactive reminders.
 */
export function snapshotReviewReminderSchedule(
  input: unknown,
  collectionRevision: number,
) {
  const policy = reviewCollectionPolicySchema.parse(input);
  return reminderSnapshotSchema.parse({
    version: 1,
    collectionRevision,
    expiresAfterDays: policy.expiresAfterDays,
    reminderAfterDays: policy.requestEmailEnabled
      ? [...policy.reminderAfterDays]
      : [],
  });
}

export function planReviewReminders({
  snapshot,
  sentAt,
  expiresAt,
}: {
  snapshot: unknown;
  sentAt: Date;
  expiresAt: Date;
}) {
  if (snapshot === null || snapshot === undefined) return [];
  const saved = reminderSnapshotSchema.parse(snapshot);
  // Validate saved schedules too: corruption is not a reason to invent sends.
  reviewCollectionPolicySchema.parse({
    sendAfterDays: 0,
    expiresAfterDays: saved.expiresAfterDays,
    autoPublish: false,
    photoUploadsEnabled: false,
    requestEmailEnabled: true,
    reminderAfterDays: saved.reminderAfterDays,
  });
  if (
    !Number.isFinite(sentAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime())
  )
    throw new Error("Invalid review reminder dates");
  return saved.reminderAfterDays.flatMap((day, index) => {
    const dueAt = new Date(sentAt.getTime() + day * DAY_MS);
    // A delayed initial send shortens the window; never extend expiry or shift
    // an already expired reminder earlier to force delivery.
    return Number.isFinite(dueAt.getTime()) && dueAt < expiresAt
      ? [{ sequence: index + 1, dueAt }]
      : [];
  });
}
