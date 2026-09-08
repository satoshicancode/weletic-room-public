import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    $queryRaw: mocks.queryRaw,
    weleticShopifyFlowTriggerState: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
  };
  return {
    prisma: {
      $transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
      weleticShopifyFlowTriggerState: {
        findMany: mocks.findMany,
      },
    },
  };
});

import {
  persistShopifyFlowLifecycleEvent,
  shouldDispatchShopifyFlowForStore,
} from "@/lib/weletic/loyalty/flow-lifecycle";

describe("Shopify Flow lifecycle state", () => {
  const payload = {
    flow_trigger_definition_id: "gid://shopify/FlowTriggerDefinition/101",
    has_enabled_flow: true,
    shop_id: "690933842",
    shopify_domain: "Example.MyShopify.com",
    timestamp: "2026-09-05T12:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([
      { id: "wstore_1", shopDomain: "example.myshopify.com" },
    ]);
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: "wflow_1" });
  });

  it("persists a newer callback against the canonical store", async () => {
    await expect(persistShopifyFlowLifecycleEvent(payload)).resolves.toEqual({
      status: "updated",
      storeId: "wstore_1",
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId_triggerDefinitionId: {
            storeId: "wstore_1",
            triggerDefinitionId: payload.flow_trigger_definition_id,
          },
        },
        create: expect.objectContaining({
          shopifyStoreId: payload.shop_id,
          hasEnabledFlow: true,
          observedAt: new Date(payload.timestamp),
        }),
      }),
    );
  });

  it("ignores equal and older callbacks", async () => {
    mocks.findUnique.mockResolvedValue({
      observedAt: new Date("2026-09-05T12:00:00.000Z"),
    });
    await expect(
      persistShopifyFlowLifecycleEvent({
        ...payload,
        has_enabled_flow: false,
        timestamp: "2026-09-05T11:59:59.999Z",
      }),
    ).resolves.toEqual({ status: "stale", storeId: "wstore_1" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("allows unobserved stores and only observed stores with an enabled flow", async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await expect(shouldDispatchShopifyFlowForStore("unseen")).resolves.toBe(
      true,
    );

    mocks.findMany.mockResolvedValueOnce([{ hasEnabledFlow: false }]);
    await expect(shouldDispatchShopifyFlowForStore("disabled")).resolves.toBe(
      false,
    );

    mocks.findMany.mockResolvedValueOnce([
      { hasEnabledFlow: false },
      { hasEnabledFlow: true },
    ]);
    await expect(shouldDispatchShopifyFlowForStore("enabled")).resolves.toBe(
      true,
    );
  });
});
