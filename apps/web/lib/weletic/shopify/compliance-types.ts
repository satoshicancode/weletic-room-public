import * as z from "zod/v4";

export const SHOPIFY_DURABLE_COMPLIANCE_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
  "app/uninstalled",
] as const;

export type ShopifyDurableComplianceTopic =
  (typeof SHOPIFY_DURABLE_COMPLIANCE_TOPICS)[number];

export const isShopifyDurableComplianceTopic = (
  topic: string,
): topic is ShopifyDurableComplianceTopic =>
  SHOPIFY_DURABLE_COMPLIANCE_TOPICS.includes(
    topic as ShopifyDurableComplianceTopic,
  );

const customerIdentitySchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    email: z.email().optional(),
  })
  .refine((customer) => customer.id !== undefined || customer.email, {
    message: "Shopify customer id or email is required",
  });

const customerDataRequestSchema = z.object({
  shop_domain: z.string().min(1),
  customer: customerIdentitySchema,
  orders_requested: z
    .array(z.union([z.string().min(1), z.number().int().positive()]))
    .default([]),
});

const customerRedactSchema = z.object({
  shop_domain: z.string().min(1),
  customer: customerIdentitySchema,
  orders_to_redact: z
    .array(z.union([z.string().min(1), z.number().int().positive()]))
    .default([]),
});

const shopRedactSchema = z.object({
  shop_domain: z.string().min(1),
});

const appUninstalledSchema = z.object({
  myshopify_domain: z.string().min(1),
});

export interface DurableComplianceSubject {
  shopDomain: string;
  customerId?: string;
  customerEmail?: string;
  legacyCustomerId?: string;
  shopperId?: string;
  accountId?: string;
  referralEmailDigests?: string[];
  installationGeneration?: string;
  redactedAt?: string;
  orderExternalIds: string[];
}

export function parseShopifyComplianceSubject({
  topic,
  payload,
}: {
  topic: ShopifyDurableComplianceTopic;
  payload: unknown;
}): DurableComplianceSubject {
  if (topic === "customers/data_request") {
    const parsed = customerDataRequestSchema.parse(payload);
    return {
      shopDomain: parsed.shop_domain,
      customerId:
        parsed.customer.id === undefined
          ? undefined
          : String(parsed.customer.id),
      customerEmail: parsed.customer.email?.trim().toLowerCase(),
      orderExternalIds: [
        ...new Set(parsed.orders_requested.map(String).filter(Boolean)),
      ],
    };
  }

  if (topic === "customers/redact") {
    const parsed = customerRedactSchema.parse(payload);
    return {
      shopDomain: parsed.shop_domain,
      customerId:
        parsed.customer.id === undefined
          ? undefined
          : String(parsed.customer.id),
      customerEmail: parsed.customer.email?.trim().toLowerCase(),
      orderExternalIds: [
        ...new Set(parsed.orders_to_redact.map(String).filter(Boolean)),
      ],
    };
  }

  if (topic === "shop/redact") {
    const parsed = shopRedactSchema.parse(payload);
    return { shopDomain: parsed.shop_domain, orderExternalIds: [] };
  }

  const parsed = appUninstalledSchema.parse(payload);
  return { shopDomain: parsed.myshopify_domain, orderExternalIds: [] };
}

export const complianceRequestTypeForTopic = {
  "customers/data_request": "customer_data_request",
  "customers/redact": "customer_redact",
  "shop/redact": "shop_redact",
  "app/uninstalled": "app_uninstalled",
} as const satisfies Record<ShopifyDurableComplianceTopic, string>;
