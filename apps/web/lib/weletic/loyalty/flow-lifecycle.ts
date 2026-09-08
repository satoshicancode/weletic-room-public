import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { canonicalizeShopifyDomain } from "@/lib/weletic/shopify/store-resolver";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const ShopifyNumericIdSchema = z.union([
  z.number().int().positive().safe().transform(String),
  z.string().regex(/^[1-9]\d{0,19}$/),
]);

export const ShopifyFlowLifecyclePayloadSchema = z
  .object({
    flow_trigger_definition_id: z.string().trim().min(1).max(191),
    has_enabled_flow: z.boolean(),
    shop_id: ShopifyNumericIdSchema,
    shopify_domain: z.string().trim().min(1).max(255),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type ShopifyFlowLifecyclePayload = z.input<
  typeof ShopifyFlowLifecyclePayloadSchema
>;

export type PersistShopifyFlowLifecycleResult =
  | { status: "updated"; storeId: string }
  | { status: "stale"; storeId: string };

/**
 * Persists lifecycle state in callback timestamp order. Locking the store row
 * serializes callbacks for every trigger definition without depending on a
 * process-local mutex.
 */
export async function persistShopifyFlowLifecycleEvent(
  rawPayload: ShopifyFlowLifecyclePayload,
): Promise<PersistShopifyFlowLifecycleResult> {
  const payload = ShopifyFlowLifecyclePayloadSchema.parse(rawPayload);
  const shopDomain = canonicalizeShopifyDomain(payload.shopify_domain);
  if (!shopDomain) throw new Error("Invalid Shopify lifecycle domain.");
  const observedAt = new Date(payload.timestamp);

  return prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<
      Array<{ id: string; shopDomain: string }>
    >(Prisma.sql`
      SELECT id, shopDomain
      FROM WeleticShopifyStore
      WHERE shopDomain = ${shopDomain}
      LIMIT 1
      FOR UPDATE
    `);
    const store = stores[0];
    if (!store) {
      throw new Error(
        `No connected Weletic Shopify store matches ${shopDomain}.`,
      );
    }

    const existing = await tx.weleticShopifyFlowTriggerState.findUnique({
      where: {
        storeId_triggerDefinitionId: {
          storeId: store.id,
          triggerDefinitionId: payload.flow_trigger_definition_id,
        },
      },
      select: { observedAt: true },
    });
    if (existing && existing.observedAt >= observedAt) {
      return { status: "stale", storeId: store.id };
    }

    await tx.weleticShopifyFlowTriggerState.upsert({
      where: {
        storeId_triggerDefinitionId: {
          storeId: store.id,
          triggerDefinitionId: payload.flow_trigger_definition_id,
        },
      },
      create: {
        id: createWeleticId("wflow_"),
        storeId: store.id,
        triggerDefinitionId: payload.flow_trigger_definition_id,
        shopifyStoreId: payload.shop_id,
        hasEnabledFlow: payload.has_enabled_flow,
        observedAt,
      },
      update: {
        shopifyStoreId: payload.shop_id,
        hasEnabledFlow: payload.has_enabled_flow,
        observedAt,
      },
    });
    return { status: "updated", storeId: store.id };
  });
}

/**
 * Before Shopify has sent any lifecycle callback, dispatch remains enabled for
 * backward compatibility. Once observed, at least one enabled workflow is
 * required for the store.
 */
export async function shouldDispatchShopifyFlowForStore(storeId: string) {
  const states = await prisma.weleticShopifyFlowTriggerState.findMany({
    where: { storeId },
    select: { hasEnabledFlow: true },
  });
  return states.length === 0 || states.some((state) => state.hasEnabledFlow);
}
