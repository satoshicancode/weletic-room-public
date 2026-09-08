import { prisma } from "@/lib/prisma";
import { recordWeleticRefund } from "@/lib/weletic/commerce/record-refund";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/commerce/record-refund", () => ({
  recordWeleticRefund: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: vi.fn() },
  },
}));

import { refundsCreate } from "../../app/(ee)/api/shopify/integration/webhook/refunds-create";

describe("frozen Shopify store refund routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordWeleticRefund).mockResolvedValue({
      refundId: "refund_1",
      duplicate: false,
    } as any);
  });

  it.each(["frozen", "redacted"] as const)(
    "retains financial settlement but requests privacy-minimized effects for a %s store",
    async (complianceState) => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_closed",
        complianceState,
      } as any);
      const event = { id: 100, order_id: 200 };

      const result = await refundsCreate({
        event,
        workspaceId: "workspace_closed",
      });

      expect(result).toContain("privacy-minimized financial settlement only");
      expect(recordWeleticRefund).toHaveBeenCalledWith(
        { event, workspaceId: "workspace_closed" },
        { privacyMinimizedFinancialSettlement: true },
      );
    },
  );
});
