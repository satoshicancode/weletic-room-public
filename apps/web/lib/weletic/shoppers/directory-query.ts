import { z } from "zod";

export const shopperDirectoryQuerySchema = z.object({
  search: z.string().trim().max(100).default(""),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
