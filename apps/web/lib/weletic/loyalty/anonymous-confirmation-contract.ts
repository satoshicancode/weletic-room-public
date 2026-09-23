import { z } from "zod";

/** Source reference only: never persist an email address in a queue payload. */
export const anonymousConfirmationJobSchema = z
  .object({
    version: z.literal(1),
    referralId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();
