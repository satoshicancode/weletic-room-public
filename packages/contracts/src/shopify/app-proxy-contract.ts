import { z } from "zod";

export const appProxyPathSchema = z
  .string()
  .max(128)
  .regex(/^\/(?:apps|a|community|tools)\/[a-z0-9][a-z0-9_-]*$/);

export const appProxyObservationSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    appId: z.string().regex(/^[a-f0-9]{32}$/),
    pathPrefix: appProxyPathSchema,
    timestamp: z.number().int().positive().safe(),
  })
  .strict();

export type AppProxyObservation = z.infer<typeof appProxyObservationSchema>;

export function assertFreshAppProxyTimestamp(timestamp: number, now: Date) {
  const milliseconds = timestamp * 1000;
  // Do not accept future observations: they could suppress a later path change.
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > now.getTime() ||
    now.getTime() - milliseconds > 60_000
  )
    throw new Error("App proxy observation is stale");
}
