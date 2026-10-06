import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  prismaLinkFindUnique: vi.fn(),
  prismaLinkUpdate: vi.fn(),
  prismaCustomerFindUnique: vi.fn(),
  prismaCustomerUpdate: vi.fn(),
  prismaProjectUpdate: vi.fn(),
  recordWeleticOrder: vi.fn(),
  recordSale: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
  redisGet: vi.fn(),
  redisHget: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    link: {
      findUniqueOrThrow: mocks.prismaLinkFindUnique,
      update: mocks.prismaLinkUpdate,
    },
    customer: {
      findUniqueOrThrow: mocks.prismaCustomerFindUnique,
      update: mocks.prismaCustomerUpdate,
    },
    project: {
      update: mocks.prismaProjectUpdate,
    },
    $transaction: async (fn: any) =>
      fn({
        link: { update: mocks.prismaLinkUpdate },
        customer: { update: mocks.prismaCustomerUpdate },
        project: { update: mocks.prismaProjectUpdate },
      }),
  },
}));

vi.mock("@/lib/upstash", () => ({
  redis: {
    set: mocks.redisSet,
    del: mocks.redisDel,
    get: mocks.redisGet,
    hget: mocks.redisHget,
  },
}));

vi.mock("@/lib/tinybird", () => ({
  recordSale: mocks.recordSale,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
  getCache: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
  })),
}));

vi.mock("@/lib/analytics/is-first-conversion", () => ({
  isFirstConversion: () => false,
}));

vi.mock("@/lib/api/links/include-tags", () => ({
  includeTags: {},
}));

vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  assertShopifySettlementLockContext: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi
    .fn()
    .mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/shopify/privacy-cache", () => ({
  deleteShopifyCheckoutCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/webhook/publish", () => ({
  sendWorkspaceWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/webhook/transform", () => ({
  transformSaleEventData: (data: any) => data,
}));

vi.mock("@/lib/postback/send-partner-postback", () => ({
  sendPartnerPostback: vi.fn().mockResolvedValue(undefined),
}));

import { createShopifySale } from "@/lib/integrations/shopify/create-sale";

describe("FIN-04: Currency Conversion in Link Stats (createShopifySale)", () => {
  const workspaceId = "ws_test_123";
  const customerId = "cust_test_456";
  const linkId = "link_test_789";

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.redisSet.mockResolvedValue("OK");
    mocks.redisDel.mockResolvedValue(1);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisHget.mockResolvedValue(null);

    mocks.prismaCustomerFindUnique.mockResolvedValue({
      id: customerId,
      firstSaleAt: new Date("2026-01-01"),
      sales: 2,
      saleAmount: BigInt(5000),
    });

    mocks.prismaProjectUpdate.mockResolvedValue({ id: workspaceId });
    mocks.prismaCustomerUpdate.mockResolvedValue({
      id: customerId,
      sales: 3,
      saleAmount: BigInt(11443),
    });
    mocks.prismaLinkUpdate.mockResolvedValue({
      id: linkId,
      sales: 3,
      saleAmount: BigInt(11443),
    });
  });

  const createOrderEvent = ({
    amount,
    currencyCode,
    invoiceId = "INV-001",
    checkoutToken = "tok_001",
  }: {
    amount: string;
    currencyCode: string;
    invoiceId?: string;
    checkoutToken?: string;
  }) => ({
    id: 998877,
    name: "#1001",
    confirmation_number: invoiceId,
    checkout_token: checkoutToken,
    current_subtotal_price_set: {
      shop_money: {
        amount,
        currency_code: currencyCode,
      },
    },
    line_items: [],
    discount_codes: [],
  });

  const leadData = {
    link_id: linkId,
    workspace_id: workspaceId,
    click_id: "click_123",
  } as any;

  const settlementLockContext = {} as any;

  it("converts JPY order to USD cents without treating ¥10,000 as 10,000 cents ($100.00)", async () => {
    // Non-program link defaulting to USD accounting currency
    mocks.prismaLinkFindUnique.mockResolvedValue({
      id: linkId,
      projectId: workspaceId,
      programId: null,
      partnerId: null,
      program: null,
    });

    const event = createOrderEvent({
      amount: "10000",
      currencyCode: "JPY",
      invoiceId: "INV-JPY-10000",
    });

    await createShopifySale({
      event,
      customerId,
      workspaceId,
      leadData,
      settlementLockContext,
    });

    // At fallback rate of 155.2 JPY/USD:
    // 10000 JPY / 155.2 = 64.43298... USD -> 6443 cents
    expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: linkId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 6443 },
        }),
      }),
    );

    expect(mocks.prismaCustomerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: customerId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 6443 },
        }),
      }),
    );

    // Crucial anti-corruption invariant: MUST NOT be raw 10,000 cents ($100.00)
    expect(mocks.prismaLinkUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          saleAmount: { increment: 10000 },
        }),
      }),
    );
  });

  it("converts EUR order to USD cents with proper decimal scaling (0.92 EUR/USD rate)", async () => {
    mocks.prismaLinkFindUnique.mockResolvedValue({
      id: linkId,
      projectId: workspaceId,
      programId: null,
      partnerId: null,
      program: null,
    });

    const event = createOrderEvent({
      amount: "100.00",
      currencyCode: "EUR",
      invoiceId: "INV-EUR-100",
    });

    await createShopifySale({
      event,
      customerId,
      workspaceId,
      leadData,
      settlementLockContext,
    });

    // At fallback rate of 0.92 EUR/USD:
    // 100.00 EUR / 0.92 = 108.6956... USD -> 10870 cents
    expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: linkId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 10870 },
        }),
      }),
    );

    expect(mocks.prismaCustomerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: customerId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 10870 },
        }),
      }),
    );
  });

  it("converts VND order to USD cents without treating 2,500,000 VND as 2,500,000 cents ($25,000)", async () => {
    mocks.prismaLinkFindUnique.mockResolvedValue({
      id: linkId,
      projectId: workspaceId,
      programId: null,
      partnerId: null,
      program: null,
    });

    const event = createOrderEvent({
      amount: "2500000",
      currencyCode: "VND",
      invoiceId: "INV-VND-2500000",
    });

    await createShopifySale({
      event,
      customerId,
      workspaceId,
      leadData,
      settlementLockContext,
    });

    // At fallback rate of 25,450 VND/USD:
    // 2,500,000 VND / 25450 = 98.2318... USD -> 9823 cents
    expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: linkId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 9823 },
        }),
      }),
    );

    expect(mocks.prismaCustomerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: customerId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 9823 },
        }),
      }),
    );

    // Crucial anti-corruption invariant: MUST NOT be raw 2,500,000 cents ($25,000.00)
    expect(mocks.prismaLinkUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          saleAmount: { increment: 2500000 },
        }),
      }),
    );
  });

  it("performs 1:1 pass-through for same-currency USD order", async () => {
    mocks.prismaLinkFindUnique.mockResolvedValue({
      id: linkId,
      projectId: workspaceId,
      programId: null,
      partnerId: null,
      program: null,
    });

    const event = createOrderEvent({
      amount: "50.00",
      currencyCode: "USD",
      invoiceId: "INV-USD-50",
    });

    await createShopifySale({
      event,
      customerId,
      workspaceId,
      leadData,
      settlementLockContext,
    });

    // 50.00 USD -> 5000 cents
    expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: linkId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 5000 },
        }),
      }),
    );

    expect(mocks.prismaCustomerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: customerId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 5000 },
        }),
      }),
    );
  });

  it("converts JPY order to program accounting currency EUR when program defines EUR accounting", async () => {
    mocks.prismaLinkFindUnique.mockResolvedValue({
      id: linkId,
      projectId: workspaceId,
      programId: "prog_eur_123",
      partnerId: null, // no partner so does not call recordWeleticOrder
      program: {
        accountingCurrency: "EUR",
      },
    });

    const event = createOrderEvent({
      amount: "10000",
      currencyCode: "JPY",
      invoiceId: "INV-JPY-EUR-10000",
    });

    await createShopifySale({
      event,
      customerId,
      workspaceId,
      leadData,
      settlementLockContext,
    });

    // JPY rate = 155.2, EUR rate = 0.92
    // 10000 JPY * (0.92 / 155.2) = 59.278... EUR -> 5928 cents (€59.28)
    expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: linkId },
        data: expect.objectContaining({
          sales: { increment: 1 },
          saleAmount: { increment: 5928 },
        }),
      }),
    );
  });

  it("handles live Redis rates dynamically when present in cache", async () => {
    // Simulate live Redis rate: JPY = 160.0
    mocks.redisHget.mockImplementation(async (key: string, field: string) => {
      if (key === "fxRates:usd" && field === "JPY") return "160.0";
      return null;
    });

    mocks.prismaLinkFindUnique.mockResolvedValue({
      id: linkId,
      projectId: workspaceId,
      programId: null,
      partnerId: null,
      program: null,
    });

    const event = createOrderEvent({
      amount: "16000",
      currencyCode: "JPY",
      invoiceId: "INV-JPY-LIVE-16000",
    });

    await createShopifySale({
      event,
      customerId,
      workspaceId,
      leadData,
      settlementLockContext,
    });

    // At live rate of 160.0 JPY/USD:
    // 16000 JPY / 160.0 = 100.00 USD -> 10000 cents
    expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: linkId },
        data: expect.objectContaining({
          saleAmount: { increment: 10000 },
        }),
      }),
    );
  });

  describe("Adversarial FX & Currency Normalization Stress Suite (Challenger 2)", () => {
    it("handles massive order > 2^31 - 1 VND (5,000,000,000 VND) without overflow, float distortion, or NaN", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      // 5 billion VND is strictly > 2^31 - 1 (2,147,483,647)
      const event = createOrderEvent({
        amount: "5000000000",
        currencyCode: "VND",
        invoiceId: "INV-VND-5B",
      });

      await createShopifySale({
        event,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      // Rate = (1 / 25450).toFixed(12) = 0.000039292731
      // 5,000,000,000 VND * 0.000039292731 = 196,463.655 USD -> 19,646,366 cents ($196,463.66)
      const linkCall = mocks.prismaLinkUpdate.mock.calls[0][0];
      const linkInc = linkCall.data.saleAmount.increment;
      const custCall = mocks.prismaCustomerUpdate.mock.calls[0][0];
      const custInc = custCall.data.saleAmount.increment;

      expect(linkInc).toBe(19646366);
      expect(custInc).toBe(19646366);
      expect(Number.isInteger(linkInc)).toBe(true);
      expect(Number.isSafeInteger(linkInc)).toBe(true);
      expect(Number.isNaN(linkInc)).toBe(false);
    });

    it("handles extreme order of 100 billion VND without precision degradation", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const event = createOrderEvent({
        amount: "100000000000",
        currencyCode: "VND",
        invoiceId: "INV-VND-100B",
      });

      await createShopifySale({
        event,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      // 100,000,000,000 VND * 0.000039292731 = 3,929,273.10 USD -> 392,927,310 cents
      const linkInc =
        mocks.prismaLinkUpdate.mock.calls[0][0].data.saleAmount.increment;
      expect(linkInc).toBe(392927310);
      expect(Number.isSafeInteger(linkInc)).toBe(true);
    });

    it("handles zero-amount orders (0.00 USD and 0 JPY) cleanly with 0 cents increment", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const eventUsd = createOrderEvent({
        amount: "0.00",
        currencyCode: "USD",
        invoiceId: "INV-USD-ZERO",
      });

      await createShopifySale({
        event: eventUsd,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            saleAmount: { increment: 0 },
          }),
        }),
      );

      vi.clearAllMocks();
      mocks.redisSet.mockResolvedValue("OK");
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const eventJpy = createOrderEvent({
        amount: "0",
        currencyCode: "JPY",
        invoiceId: "INV-JPY-ZERO",
      });

      await createShopifySale({
        event: eventJpy,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            saleAmount: { increment: 0 },
          }),
        }),
      );
    });

    it("rejects corrupted zero or negative FX rates from Redis without corrupting stats", async () => {
      mocks.redisHget.mockImplementation(async (key: string, field: string) => {
        if (key === "fxRates:usd" && field === "JPY") return "0";
        return null;
      });

      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const event = createOrderEvent({
        amount: "10000",
        currencyCode: "JPY",
        invoiceId: "INV-JPY-ZERO-RATE",
      });

      await expect(
        createShopifySale({
          event,
          customerId,
          workspaceId,
          leadData,
          settlementLockContext,
        }),
      ).rejects.toThrow(/Missing FX rate for JPY\/USD/);

      // Invariant: Prisma update MUST NOT be called with 0, Infinity, or NaN
      expect(mocks.prismaLinkUpdate).not.toHaveBeenCalled();
      expect(mocks.prismaCustomerUpdate).not.toHaveBeenCalled();
      // Invariant: Idempotency lock must be cleared on failure to allow retry
      expect(mocks.redisDel).toHaveBeenCalled();
    });

    it("rejects unsupported currency code not present in fallback rates or Redis", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const event = createOrderEvent({
        amount: "150.00",
        currencyCode: "CHF", // Swiss Franc not in fallback table
        invoiceId: "INV-CHF-150",
      });

      await expect(
        createShopifySale({
          event,
          customerId,
          workspaceId,
          leadData,
          settlementLockContext,
        }),
      ).rejects.toThrow(/Missing FX rate for CHF\/USD/);

      expect(mocks.prismaLinkUpdate).not.toHaveBeenCalled();
      expect(mocks.prismaCustomerUpdate).not.toHaveBeenCalled();
      expect(mocks.redisDel).toHaveBeenCalled();
    });

    it("rejects invalid ISO 4217 currency syntax immediately", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const event = createOrderEvent({
        amount: "100.00",
        currencyCode: "INVALID",
        invoiceId: "INV-INVALID-CURRENCY",
      });

      await expect(
        createShopifySale({
          event,
          customerId,
          workspaceId,
          leadData,
          settlementLockContext,
        }),
      ).rejects.toThrow(/Invalid ISO 4217 currency code: INVALID/);

      expect(mocks.prismaLinkUpdate).not.toHaveBeenCalled();
    });

    it("performs 1:1 pass-through for non-USD same-currency orders (EUR to EUR and JPY to JPY)", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: "prog_eur",
        partnerId: null,
        program: { accountingCurrency: "EUR" },
      });

      const eventEur = createOrderEvent({
        amount: "250.00",
        currencyCode: "EUR",
        invoiceId: "INV-EUR-EUR",
      });

      await createShopifySale({
        event: eventEur,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            saleAmount: { increment: 25000 },
          }),
        }),
      );

      vi.clearAllMocks();
      mocks.redisSet.mockResolvedValue("OK");
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: "prog_jpy",
        partnerId: null,
        program: { accountingCurrency: "JPY" },
      });

      const eventJpy = createOrderEvent({
        amount: "50000",
        currencyCode: "JPY",
        invoiceId: "INV-JPY-JPY",
      });

      await createShopifySale({
        event: eventJpy,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            saleAmount: { increment: 50000 },
          }),
        }),
      );
    });

    it("converts cross-currency non-USD to non-USD (EUR store order to GBP program accounting)", async () => {
      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: "prog_gbp",
        partnerId: null,
        program: { accountingCurrency: "GBP" },
      });

      const event = createOrderEvent({
        amount: "100.00",
        currencyCode: "EUR",
        invoiceId: "INV-EUR-GBP-100",
      });

      await createShopifySale({
        event,
        customerId,
        workspaceId,
        leadData,
        settlementLockContext,
      });

      // EUR fallback = 0.92, GBP fallback = 0.79
      // Rate = 0.79 / 0.92 = 0.858695652174
      // 100.00 EUR -> 85.8695... GBP -> 8587 GBP cents
      expect(mocks.prismaLinkUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            saleAmount: { increment: 8587 },
          }),
        }),
      );
    });

    it("safely aborts and cleans lock when Redis connection fails during quote fetching", async () => {
      mocks.redisHget.mockRejectedValue(
        new Error("Upstash Redis connection timeout"),
      );

      mocks.prismaLinkFindUnique.mockResolvedValue({
        id: linkId,
        projectId: workspaceId,
        programId: null,
        partnerId: null,
        program: null,
      });

      const event = createOrderEvent({
        amount: "10000",
        currencyCode: "JPY",
        invoiceId: "INV-REDIS-FAIL",
      });

      await expect(
        createShopifySale({
          event,
          customerId,
          workspaceId,
          leadData,
          settlementLockContext,
        }),
      ).rejects.toThrow("Upstash Redis connection timeout");

      // Invariant: Prisma update is never called
      expect(mocks.prismaLinkUpdate).not.toHaveBeenCalled();
      expect(mocks.prismaCustomerUpdate).not.toHaveBeenCalled();
      // Invariant: Redis idempotency key is deleted to allow future retry
      expect(mocks.redisDel).toHaveBeenCalled();
    });
  });
});
