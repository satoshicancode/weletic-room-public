import { z } from "zod";

export const loyaltyModuleToggleSchema = z
  .object({
    status: z.enum(["active", "disabled"]),
    expectedStatus: z.enum(["draft", "test", "active", "disabled"]),
    expectedInstallationGeneration: z.string().min(1).max(64),
  })
  .strict();

export type LoyaltyModuleToggle = z.infer<typeof loyaltyModuleToggleSchema>;
