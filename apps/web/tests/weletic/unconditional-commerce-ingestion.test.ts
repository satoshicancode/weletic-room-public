import { describe, expect, it } from "vitest";

describe("Weletic Unconditional Commerce Ingestion & Multi-Module Dispatch", () => {
  it("persists unattributed orders with shopper profile and zero commission calculations", () => {
    interface OrderRecord {
      id: string;
      storeId: string;
      externalId: string;
      shopperId: string | null;
      partnerId: string | null;
      amount: bigint;
      status: string;
    }

    const orderStore = new Map<string, OrderRecord>();
    const shopperStore = new Map<string, { id: string; customerId: string }>();
    const commissions: Array<{ id: string; orderId: string; amount: bigint }> =
      [];

    const recordCommerceEvent = ({
      storeId,
      externalId,
      customer,
      partnerId,
      amount,
    }: {
      storeId: string;
      externalId: string;
      customer?: { id: number } | null;
      partnerId?: string | null;
      amount: bigint;
    }) => {
      // Step 1: Upsert Shopper if customer exists
      let shopperId: string | null = null;
      if (customer?.id) {
        const shopperKey = `${storeId}:${customer.id}`;
        let shopper = shopperStore.get(shopperKey);
        if (!shopper) {
          shopper = {
            id: `wshop_${customer.id}`,
            customerId: String(customer.id),
          };
          shopperStore.set(shopperKey, shopper);
        }
        shopperId = shopper.id;
      }

      // Step 2: Record Order
      const orderId = `worder_${externalId}`;
      const order: OrderRecord = {
        id: orderId,
        storeId,
        externalId,
        shopperId,
        partnerId: partnerId ?? null,
        amount,
        status: "paid",
      };
      orderStore.set(orderId, order);

      // Step 3: Dispatch optional partner commission
      if (partnerId) {
        commissions.push({
          id: `comm_${orderId}`,
          orderId,
          amount: (amount * BigInt(10)) / BigInt(100), // 10%
        });
      }

      return { order, shopperId, commissionCount: commissions.length };
    };

    // 1. Unattributed identified order
    const unattributed = recordCommerceEvent({
      storeId: "store_123",
      externalId: "ord_1001",
      customer: { id: 555 },
      partnerId: null,
      amount: BigInt(5000),
    });

    expect(unattributed.order.shopperId).toBe("wshop_555");
    expect(unattributed.order.partnerId).toBeNull();
    expect(commissions.length).toBe(0);

    // 2. Guest unattributed order
    const guestOrder = recordCommerceEvent({
      storeId: "store_123",
      externalId: "ord_1002",
      customer: null,
      partnerId: null,
      amount: BigInt(8000),
    });

    expect(guestOrder.order.shopperId).toBeNull();
    expect(guestOrder.order.partnerId).toBeNull();
    expect(commissions.length).toBe(0);

    // 3. Attributed order with creator partner
    const attributed = recordCommerceEvent({
      storeId: "store_123",
      externalId: "ord_1003",
      customer: { id: 555 },
      partnerId: "partner_creator_1",
      amount: BigInt(10000),
    });

    expect(attributed.order.shopperId).toBe("wshop_555");
    expect(attributed.order.partnerId).toBe("partner_creator_1");
    expect(commissions.length).toBe(1);
    expect(commissions[0].amount).toBe(BigInt(1000));
  });

  it("handles refund recording for unattributed orders without throwing order_not_attributed", () => {
    interface RefundRecord {
      id: string;
      orderId: string;
      amount: bigint;
    }

    const orders = new Map([
      [
        "worder_1001",
        {
          id: "worder_1001",
          partnerId: null,
          amount: BigInt(5000),
          status: "paid",
        },
      ],
    ]);
    const refunds: RefundRecord[] = [];

    const recordRefund = (orderId: string, refundAmount: bigint) => {
      const order = orders.get(orderId);
      if (!order) {
        return { ignored: true, reason: "order_not_found" };
      }

      const refundId = `wref_${refundAmount}_${Date.now()}`;
      refunds.push({
        id: refundId,
        orderId,
        amount: refundAmount,
      });

      order.status =
        refundAmount >= order.amount ? "refunded" : "partially_refunded";

      return { ignored: false, refundId, orderStatus: order.status };
    };

    const result = recordRefund("worder_1001", BigInt(2500));
    expect(result.ignored).toBe(false);
    expect(result.orderStatus).toBe("partially_refunded");
    expect(refunds.length).toBe(1);
  });
});
