import * as z from "zod/v4";

export const reviewDeliveryOutcomeSchema = z.enum([
  "queued",
  "sending",
  "confirmed",
  "unconfirmed",
  "cancelled",
  "unavailable",
]);
const delivery = {
  outcome: reviewDeliveryOutcomeSchema,
  attempts: z.number().int().nonnegative(),
  scheduledFor: z.string().datetime(),
  confirmedAt: z.string().datetime().nullable(),
};
export const reviewDeliveryHistorySchema = z
  .object({
    initial: z
      .object(delivery)
      .strict()
      .refine(
        (row) => (row.outcome === "confirmed") === (row.confirmedAt !== null),
      ),
    reminders: z
      .array(
        z
          .object({ sequence: z.number().int().min(1).max(3), ...delivery })
          .strict()
          .refine(
            (row) =>
              (row.outcome === "confirmed") === (row.confirmedAt !== null),
          ),
      )
      .max(3)
      .refine((rows) =>
        rows.every(
          (row, index) =>
            index === 0 || row.sequence > rows[index - 1].sequence,
        ),
      ),
  })
  .strict();
export type ReviewDeliveryHistory = z.infer<typeof reviewDeliveryHistorySchema>;

/** Status is not proof of provider delivery. Preserve ambiguity after cleanup
 * or submission; never project raw provider errors or cancellation explanations.
 */
export function reviewDeliveryOutcome(
  input: {
    status: string;
    attempts: number;
    sentAt: Date | null;
    leaseExpiresAt?: Date | null;
  },
  now = new Date(),
) {
  if (input.sentAt) return "confirmed" as const;
  if (input.status === "reconciliation") return "unconfirmed" as const;
  if (
    input.status === "sending" &&
    input.leaseExpiresAt &&
    input.leaseExpiresAt > now
  )
    return "sending" as const;
  if (input.attempts > 0) return "unconfirmed" as const;
  if (input.status === "queued") return "queued" as const;
  if (["cancelled", "expired"].includes(input.status))
    return "cancelled" as const;
  return "unavailable" as const;
}
