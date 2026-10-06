import { z } from "zod";

export const storeReviewSettingsPolicySchema = z
  .object({
    enabled: z.boolean(),
    requestEmailEnabled: z.boolean(),
    autoPublish: z.boolean(),
    sendAfterDays: z.number().int().min(0).max(60),
    expiresAfterDays: z.number().int().min(1).max(90),
  })
  .strict();
export const storeReviewSettingsReadInputSchema = z.object({}).strict();
export const storeReviewSettingsWriteInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    expectedInstallationGeneration: z.string().min(1).max(64),
    policy: storeReviewSettingsPolicySchema,
  })
  .strict();
export const storeReviewSettingsReadResponseSchema = z
  .object({
    revision: z.number().int().min(0).max(2_147_483_647),
    installationGeneration: z.string().min(1).max(64),
    productReviewsEnabled: z.boolean(),
    policy: storeReviewSettingsPolicySchema,
  })
  .strict();

export type StoreReviewSettingsWriteInput = z.infer<
  typeof storeReviewSettingsWriteInputSchema
>;
export function defaultStoreReviewSettingsPolicy() {
  return {
    enabled: false,
    requestEmailEnabled: false,
    autoPublish: false,
    sendAfterDays: 7,
    expiresAfterDays: 30,
  };
}
