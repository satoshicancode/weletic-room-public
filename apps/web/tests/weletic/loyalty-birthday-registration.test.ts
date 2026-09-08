import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueOutboxJob: vi.fn(),
  findFirst: vi.fn(),
  resolveShopifyStoreByDomain: vi.fn(),
  storeFindUnique: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
    },
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueueOutboxJob,
}));

vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBody: vi.fn((request: Request) => request.text()),
  verifyWeleticShopifyRequest: vi.fn(() => true),
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: mocks.resolveShopifyStoreByDomain,
}));

const storeId = "wstore_birthday_cas";
const accountId = "wacc_birthday_cas";
const customerId = "customer_birthday_cas";
const initialUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

function birthdayRequest(birthMonth: number, birthDay: number) {
  return new Request(
    "https://app.weletic.test/api/internal/shopify/loyalty/customer/birthday",
    {
      method: "POST",
      body: JSON.stringify({
        shop: "birthday-cas.myshopify.com",
        shopifyCustomerId: customerId,
        birthMonth,
        birthDay,
      }),
    },
  );
}

describe("loyalty birthday registration OCC", () => {
  let metadata: Record<string, unknown>;
  let updatedAt: Date;
  let enqueuedJobs: Array<Record<string, any>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    metadata = { preferredLanguage: "en" };
    updatedAt = initialUpdatedAt;
    enqueuedJobs = [];

    mocks.resolveShopifyStoreByDomain.mockResolvedValue({ storeId });
    mocks.storeFindUnique.mockResolvedValue({
      id: storeId,
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      installationGeneration: "sgen_birthday_cas",
    });
    mocks.findFirst.mockImplementation(async (args: Record<string, any>) => {
      if (args.include) {
        // Every concurrent request starts from the same pre-registration
        // snapshot so the updatedAt predicate decides the winner.
        return {
          id: accountId,
          storeId,
          metadata: { preferredLanguage: "en" },
          updatedAt: initialUpdatedAt,
          program: {
            status: "active",
            killSwitchActive: false,
            earningRules: [{ id: "birthday_rule" }],
          },
        };
      }

      return { metadata, updatedAt };
    });
    mocks.updateMany.mockImplementation(async (args: Record<string, any>) => {
      if (args.where.updatedAt.getTime() !== updatedAt.getTime()) {
        return { count: 0 };
      }

      metadata = args.data.metadata;
      updatedAt = new Date(updatedAt.getTime() + 1);
      return { count: 1 };
    });
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          weleticLoyaltyAccount: { updateMany: mocks.updateMany },
          weleticShopifyStore: { findUnique: mocks.storeFindUnique },
        }),
    );
    mocks.enqueueOutboxJob.mockImplementation(async (job) => {
      enqueuedJobs.push(job);
      return { id: "birthday_job" };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns one canonical registration and enqueues one job for concurrent matching dates", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/birthday/route"
    );
    const responses = await Promise.all([
      POST(birthdayRequest(8, 29)),
      POST(birthdayRequest(8, 29)),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(bodies[0].data.registeredAt).toBe(bodies[1].data.registeredAt);
    expect(metadata).toMatchObject({
      preferredLanguage: "en",
      birthday: {
        birthDate: "2000-08-29",
        registeredAt: bodies[0].data.registeredAt,
        nextEligibleYear: 2026,
      },
    });
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]).toMatchObject({
      storeId,
      idempotencyKey: `birthday_reward:${accountId}:2026`,
      payload: {
        accountId,
        birthDate: "2000-08-29",
        registeredAt: bodies[0].data.registeredAt,
        calendarYear: 2026,
      },
    });
  });

  it("locks the losing request when concurrent requests submit different dates", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/birthday/route"
    );
    const responses = await Promise.all([
      POST(birthdayRequest(8, 29)),
      POST(birthdayRequest(9, 10)),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    const successIndex = responses.findIndex(
      (response) => response.status === 200,
    );
    const lockedIndex = responses.findIndex(
      (response) => response.status === 409,
    );

    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(lockedIndex).toBeGreaterThanOrEqual(0);
    expect(bodies[lockedIndex].error.code).toBe("birthday_locked");
    expect(enqueuedJobs).toHaveLength(1);
    expect((metadata.birthday as Record<string, unknown>).birthDate).toBe(
      bodies[successIndex].data.birthMonth === 8 ? "2000-08-29" : "2000-09-10",
    );
  });

  it("reloads and retries after an unrelated account update wins the CAS", async () => {
    mocks.updateMany
      .mockImplementationOnce(async () => {
        metadata = {
          preferredLanguage: "ja",
          marketingSource: "storefront",
        };
        updatedAt = new Date(updatedAt.getTime() + 1);
        return { count: 0 };
      })
      .mockImplementationOnce(async (args: Record<string, any>) => {
        expect(args.where.updatedAt).toEqual(updatedAt);
        metadata = args.data.metadata;
        updatedAt = new Date(updatedAt.getTime() + 1);
        return { count: 1 };
      });

    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/birthday/route"
    );
    const response = await POST(birthdayRequest(8, 29));

    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(metadata).toMatchObject({
      preferredLanguage: "ja",
      marketingSource: "storefront",
      birthday: { birthDate: "2000-08-29" },
    });
    expect(enqueuedJobs).toHaveLength(1);
  });

  it("does not publish birthday metadata or an outbox job when freeze wins after the initial read", async () => {
    mocks.storeFindUnique
      .mockResolvedValueOnce({
        id: storeId,
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        installationGeneration: "sgen_birthday_cas",
      })
      .mockResolvedValueOnce({
        id: storeId,
        complianceState: "frozen",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        installationGeneration: "sgen_birthday_cas",
      });

    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/birthday/route"
    );

    await expect(POST(birthdayRequest(8, 29))).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      complianceState: "frozen",
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.enqueueOutboxJob).not.toHaveBeenCalled();
    expect(metadata).toEqual({ preferredLanguage: "en" });
  });
});
