import * as z from "zod/v4";
import type { ShopifySessionProperty } from "./session-contract";
import {
  shopifySessionPropertiesSchema,
  shopifySessionShopSchema,
} from "./session-contract-validation";
import { readOnlineSessionEvidence } from "./session-online-evidence";

export const shopifyOnlineSessionBindingSchema = z
  .object({
    appId: z.string().min(1).max(191),
    shop: shopifySessionShopSchema,
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

export type ShopifyOnlineSessionBinding = z.infer<
  typeof shopifyOnlineSessionBindingSchema
>;

const envelopeSchema = z
  .object({
    version: z.literal(1),
    properties: shopifySessionPropertiesSchema,
    onlineBinding: shopifyOnlineSessionBindingSchema,
  })
  .strict();

function assertBoundIdentity(
  properties: ShopifySessionProperty[],
  binding: ShopifyOnlineSessionBinding,
) {
  const evidence = readOnlineSessionEvidence(properties);
  const values = Object.fromEntries(properties);
  if (
    !evidence ||
    values.shop !== binding.shop ||
    values.id !== `${binding.shop}_${evidence.userId}` ||
    typeof values.accessToken !== "string" ||
    !values.accessToken ||
    typeof values.expires !== "number" ||
    !Number.isSafeInteger(values.expires) ||
    values.expires <= 0 ||
    values.expires > 8640000000000000
  ) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Invalid installation-bound online session",
      },
    ]);
  }
}

/** Binding comes from a verified, locked server observation, never SDK flags. */
export function bindShopifyOnlineSession(
  properties: ShopifySessionProperty[],
  binding: ShopifyOnlineSessionBinding,
) {
  const envelope = envelopeSchema.parse({
    version: 1,
    properties,
    onlineBinding: binding,
  });
  assertBoundIdentity(envelope.properties, envelope.onlineBinding);
  return envelope;
}

/** Legacy arrays remain readable, but do not acquire installation evidence. */
export function readShopifySessionPayload(value: unknown): {
  properties: ShopifySessionProperty[];
  onlineBinding?: ShopifyOnlineSessionBinding;
} {
  if (Array.isArray(value))
    return { properties: shopifySessionPropertiesSchema.parse(value) };
  const envelope = envelopeSchema.parse(value);
  assertBoundIdentity(envelope.properties, envelope.onlineBinding);
  return {
    properties: envelope.properties,
    onlineBinding: envelope.onlineBinding,
  };
}
