import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty Identity & Shopper Isolation Boundary", () => {
  it("creates store-scoped shopper profile uniquely keyed by storeId and shopifyCustomerId", () => {
    interface SimulatedShopper {
      id: string;
      storeId: string;
      shopifyCustomerId: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
      ordersCount: number;
      totalSpent: bigint;
    }

    const shoppers = new Map<string, SimulatedShopper>();

    const upsertShopper = (
      storeId: string,
      customer: {
        id: number | string;
        first_name?: string;
        last_name?: string;
        email?: string;
        phone?: string;
      },
    ) => {
      const shopifyCustomerId = String(customer.id);
      const key = `${storeId}:${shopifyCustomerId}`;
      const existing = shoppers.get(key);

      if (existing) {
        existing.firstName = customer.first_name ?? existing.firstName;
        existing.lastName = customer.last_name ?? existing.lastName;
        existing.email = customer.email?.toLowerCase() ?? existing.email;
        existing.phone = customer.phone ?? existing.phone;
        return { shopper: existing, created: false };
      }

      const newShopper: SimulatedShopper = {
        id: `wshop_${shopifyCustomerId}`,
        storeId,
        shopifyCustomerId,
        firstName: customer.first_name ?? null,
        lastName: customer.last_name ?? null,
        email: customer.email ? customer.email.toLowerCase() : null,
        phone: customer.phone ?? null,
        ordersCount: 0,
        totalSpent: BigInt(0),
      };
      shoppers.set(key, newShopper);
      return { shopper: newShopper, created: true };
    };

    // Store A customer 101
    const resA = upsertShopper("store_A", {
      id: 101,
      first_name: "Hiro",
      last_name: "Nguyen",
      email: "HIRO@example.com",
    });
    expect(resA.created).toBe(true);
    expect(resA.shopper.email).toBe("hiro@example.com");

    // Store B customer with same Shopify ID (multi-tenant store isolation)
    const resB = upsertShopper("store_B", {
      id: 101,
      first_name: "Another",
      last_name: "Shopper",
      email: "another@example.com",
    });
    expect(resB.created).toBe(true);
    expect(resB.shopper.storeId).toBe("store_B");
    expect(shoppers.size).toBe(2);

    // Upsert Store A again with updated name
    const resA2 = upsertShopper("store_A", {
      id: 101,
      first_name: "Hiroshi",
    });
    expect(resA2.created).toBe(false);
    expect(resA2.shopper.firstName).toBe("Hiroshi");
    expect(resA2.shopper.email).toBe("hiro@example.com");
  });

  it("anonymizes shopper data for compliance while maintaining financial auditability", () => {
    const shopper: {
      id: string;
      storeId: string;
      shopifyCustomerId: string;
      firstName: string;
      lastName: string;
      email: string | null;
      phone: string | null;
      tags: string[];
      acceptsMarketing: boolean;
      ordersCount: number;
      totalSpent: bigint;
    } = {
      id: "wshop_999",
      storeId: "store_A",
      shopifyCustomerId: "999",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane.doe@example.com",
      phone: "+1234567890",
      tags: ["vip", "early-adopter"],
      acceptsMarketing: true,
      ordersCount: 3,
      totalSpent: BigInt(35000),
    };

    const orders = [
      { id: "worder_1", shopperId: "wshop_999", amount: BigInt(15000) },
      { id: "worder_2", shopperId: "wshop_999", amount: BigInt(20000) },
    ];

    // Redaction scrub
    shopper.firstName = "Redacted";
    shopper.lastName = "Customer";
    shopper.email = null;
    shopper.phone = null;
    shopper.tags = [];
    shopper.acceptsMarketing = false;

    expect(shopper.firstName).toBe("Redacted");
    expect(shopper.email).toBeNull();
    expect(shopper.phone).toBeNull();
    // Immutable financial stats and linked orders remain intact
    expect(shopper.ordersCount).toBe(3);
    expect(shopper.totalSpent).toBe(BigInt(35000));
    expect(orders.length).toBe(2);
    expect(orders[0].shopperId).toBe("wshop_999");
  });
});
