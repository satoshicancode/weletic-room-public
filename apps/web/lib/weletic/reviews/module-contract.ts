import { z } from "zod";

// Browser-safe module-only contract, independent of submission/token helpers.
export const reviewModuleToggleSchema = z
  .object({
    enabled: z.boolean(),
    expectedUpdatedAt: z.string().datetime().nullable(),
    expectedInstallationGeneration: z.string().min(1).max(64),
  })
  .strict();
export type ReviewModuleToggle = z.infer<typeof reviewModuleToggleSchema>;
