import { z } from "zod";

// Browser-safe collection fields. Module enablement and incentive activation
// have their own signed writers and must not be smuggled into collection edits.
export const reviewCollectionFields = {
  sendAfterDays: z.number().int().min(0).max(60),
  expiresAfterDays: z.number().int().min(1).max(90),
  autoPublish: z.boolean(),
  photoUploadsEnabled: z.boolean(),
  requestEmailEnabled: z.boolean(),
};

export const reviewCollectionPolicySchema = z
  .object({
    ...reviewCollectionFields,
    // Off by default. Offsets are elapsed days after confirmed initial delivery,
    // not after fulfillment or after the preceding reminder.
    reminderAfterDays: z.array(z.number().int().min(1).max(89)).max(3),
  })
  .strict()
  .superRefine((policy, context) => {
    policy.reminderAfterDays.forEach((day, index) => {
      if (day >= policy.expiresAfterDays)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reminderAfterDays", index],
          message: "Reminder must precede invitation expiry",
        });
      if (index > 0 && day <= policy.reminderAfterDays[index - 1])
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reminderAfterDays", index],
          message: "Reminder offsets must be unique and increasing",
        });
    });
  });

export const reviewCollectionReadInputSchema = z.object({}).strict();
export const reviewCollectionWriteInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    expectedInstallationGeneration: z.string().min(1).max(64),
    policy: reviewCollectionPolicySchema,
  })
  .strict();
export const reviewCollectionReadResponseSchema = z
  .object({
    revision: z.number().int().min(0).max(2_147_483_647),
    installationGeneration: z.string().min(1).max(64),
    moduleEnabled: z.boolean(),
    policy: reviewCollectionPolicySchema,
  })
  .strict();

export type ReviewCollectionPolicy = z.infer<
  typeof reviewCollectionPolicySchema
>;
export type ReviewCollectionWriteInput = z.infer<
  typeof reviewCollectionWriteInputSchema
>;

export function defaultReviewCollectionPolicy(): ReviewCollectionPolicy {
  return {
    sendAfterDays: 7,
    expiresAfterDays: 30,
    autoPublish: false,
    photoUploadsEnabled: true,
    requestEmailEnabled: false,
    reminderAfterDays: [],
  };
}
