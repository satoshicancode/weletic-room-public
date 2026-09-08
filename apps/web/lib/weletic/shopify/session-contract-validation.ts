import * as z from "zod/v4";
import {
  SHOPIFY_SESSION_PROPERTY_KEYS,
  validShopifySessionIdentityProperties,
} from "./session-online-evidence";

export const shopifySessionShopSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
const counterSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= BigInt("9223372036854775806"),
  );
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const shopifySessionLeaseSchema = z
  .object({
    token: digestSchema,
    epoch: counterSchema,
    revision: counterSchema,
  })
  .strict();
export const shopifySessionObservationSchema = z
  .object({
    epoch: counterSchema,
    revision: counterSchema,
    sessionDigest: digestSchema,
    installationGeneration: z.string().min(1).max(255).nullable(),
    credentialTokenHash: digestSchema.nullable(),
  })
  .strict();
export const shopifySessionMutationFenceSchema = z
  .object({
    lease: shopifySessionLeaseSchema,
    observed: shopifySessionObservationSchema,
  })
  .strict();

export const shopifySessionPropertiesSchema = z
  .array(
    z.tuple([
      z.enum(SHOPIFY_SESSION_PROPERTY_KEYS),
      z.union([z.string().max(8192), z.number().finite(), z.boolean()]),
    ]),
  )
  .min(4)
  .max(20)
  .superRefine((properties, context) => {
    const keys = properties.map(([key]) => key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "Duplicate session keys" });
    }
  });

// Legacy stored payloads remain readable so the app adapter can discard unsafe
// online sessions as cache misses. Reject malformed identity types on new writes.
export const shopifySessionWritePropertiesSchema =
  shopifySessionPropertiesSchema.refine(
    validShopifySessionIdentityProperties,
    "Invalid session identity property types",
  );
