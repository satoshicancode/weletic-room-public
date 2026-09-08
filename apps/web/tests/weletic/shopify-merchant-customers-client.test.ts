import { merchantShopperProfileResponseSchema } from "@/lib/weletic/shoppers/merchant-response";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantCustomersClient } from "../../../../packages/shopify-app/app/merchant-customers-client";

const time = "2026-09-07T00:00:00.000Z";
const base = { id: "record-a", createdAt: time };
const pagination = { limit: 20, hasMore: false, nextCursor: null };
const shopper = {
  ...base,
  id: "shopper-a",
  shopifyCustomerId: "123",
  firstName: "Controlled",
  lastName: null,
  email: "controlled@example.test",
};
const directory = { items: [{ ...shopper, loyalty: null }], pagination };
const overview = {
  section: "overview",
  shopper: {
    ...shopper,
    phone: null,
    locale: "ja",
    acceptsMarketing: false,
    updatedAt: time,
  },
  locale: { shopper: "ja", merchant: "en" },
  communicationPreferences: {
    shopifyAcceptsMarketing: false,
    consentEvidence: "unavailable",
    consentSource: null,
    consentRecordedAt: null,
    suppressionStatus: "unavailable",
  },
  modules: {
    loyalty: { status: "disabled", killSwitchActive: false },
    reviews: { enabled: false, requestEmailEnabled: false },
  },
  loyalty: {
    id: "account-a",
    status: "active",
    tier: null,
    pointsBalance: "-9007199254740993",
    pendingPoints: "9007199254740995",
    lifetimeEarned: "9007199254740997",
    lifetimeRedeemed: "0",
    enrolledAt: time,
  },
  coverage: {
    communications: "partial",
    communicationSources: ["review_requests", "referral_friend_emailed_at"],
    reason: "Recorded sources only",
    reviews: "native_product_reviews_only",
    rewards: "account_and_direct_shopper_rewards",
    purchases: "locally_projected_orders_only",
  },
};
const pages = [
  {
    section: "purchases",
    items: [
      {
        ...base,
        occurredAt: time,
        orderName: null,
        status: "partially_refunded",
        accountingCurrency: "JPY",
        accountingNet: "9007199254740993",
        accountingTotal: "9007199254740995",
      },
    ],
    pagination,
  },
  {
    section: "points",
    items: [
      {
        ...base,
        sequenceNumber: 9,
        entryType: "MANUAL_ADJUSTMENT",
        pointsDelta: "-9007199254740993",
        pendingDelta: "0",
        balanceAfter: "-9007199254740993",
      },
    ],
    pagination,
  },
  {
    section: "referrals",
    items: [
      {
        ...base,
        role: "friend",
        status: "rewarded",
        qualifyingOrderId: null,
        pointsAwarded: "100",
        rewardedAt: time,
        friendRewardEmailedAt: null,
      },
    ],
    pagination,
  },
  {
    section: "reviews",
    items: [
      {
        ...base,
        subject: "product",
        productId: "product-a",
        status: "hidden",
        rating: 1,
        title: "Honest criticism",
        verifiedPurchase: true,
        incentivized: true,
        rewardStatus: "awarded",
      },
    ],
    pagination,
  },
  {
    section: "rewards",
    items: [
      {
        ...base,
        rewardDefinitionId: "reward-a",
        status: "issued",
        artifactKind: "discount_code",
        pointsSpent: "0",
        fulfillmentSource: "review_incentive",
        usedAt: null,
        expiresAt: null,
      },
    ],
    pagination,
  },
  {
    section: "review_requests",
    items: [
      {
        ...base,
        productId: "product-a",
        orderId: "order-a",
        status: "sent",
        sendAt: time,
        sentAt: time,
        submittedAt: null,
        expiresAt: time,
        cancelledAt: null,
        deliveryAttempts: 1,
        deliveryEvidence: "application_send_record_only",
      },
    ],
    pagination,
  },
] as const;

describe("validated Shopify Customers client", () => {
  const token = vi.fn<() => Promise<string>>();
  const fetcher = vi.fn<typeof fetch>();
  const client = () => createMerchantCustomersClient(token, fetcher);
  beforeEach(() => {
    vi.resetAllMocks();
    token.mockResolvedValue("synthetic-token");
  });

  it("normalizes the shared screen's empty cursor and obtains fresh tokens without cookies", async () => {
    token.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    fetcher.mockImplementation(async () => Response.json(directory));
    await client().list({ cursor: "" });
    await client().list({ search: "Controlled" });
    expect(
      JSON.parse(String(fetcher.mock.calls[0][1]?.body)),
    ).not.toHaveProperty("cursor");
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/merchant/customers",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer second" }),
      }),
    ]);
    expect(token).toHaveBeenCalledTimes(2);
  });
  it("accepts the production directory accountId projection", async () => {
    const page = {
      ...directory,
      items: [
        {
          ...directory.items[0],
          loyalty: { accountId: "account-a", status: "active" },
        },
      ],
    };
    fetcher.mockResolvedValue(Response.json(page));
    expect(await client().list({})).toEqual(page);
  });
  it("keeps exact negative and large balances and unavailable consent evidence", async () => {
    fetcher.mockResolvedValue(Response.json(overview));
    expect(
      await client().profile({ shopperId: "shopper-a", cursor: "" }),
    ).toEqual(overview);
  });
  it.each(pages)(
    "validates the $section section without dropping fields",
    async (page) => {
      fetcher.mockResolvedValue(Response.json(page));
      expect(
        await client().profile({
          shopperId: "shopper-a",
          section: page.section,
        }),
      ).toEqual(page);
    },
  );
  it.each([401, 403, 404, 409, 503])(
    "never retries status %s",
    async (status) => {
      fetcher.mockResolvedValue(new Response("private error", { status }));
      await expect(client().list({})).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { ...directory, token: "private" },
    { ...directory, items: [{ ...directory.items[0], couponCode: "private" }] },
    { ...directory, items: [directory.items[0], directory.items[0]] },
    { ...directory, pagination: { ...pagination, limit: 50 } },
    { ...directory, pagination: { ...pagination, hasMore: true } },
    {
      ...directory,
      pagination: { ...pagination, hasMore: true, nextCursor: "same" },
    },
  ])("rejects unsafe or inconsistent directory data", async (value) => {
    fetcher.mockResolvedValue(Response.json(value));
    await expect(client().list({ cursor: "same" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  it.each([
    { ...overview, shopper: { ...overview.shopper, id: "other" } },
    {
      ...overview,
      loyalty: { ...overview.loyalty, pointsBalance: 9007199254740992 },
    },
    { ...overview, loyalty: { ...overview.loyalty, pointsBalance: "1e4" } },
    { ...overview, shopper: { ...overview.shopper, token: "private" } },
    pages[0],
  ])(
    "rejects cross-shopper, wrong-section, lossy and expanded profile responses",
    async (value) => {
      fetcher.mockResolvedValue(Response.json(value));
      await expect(
        client().profile({ shopperId: "shopper-a" }),
      ).rejects.toMatchObject({ code: "unavailable" });
    },
  );
  it("rejects redacted reviews and bearer coupon artifacts", () => {
    expect(
      merchantShopperProfileResponseSchema.safeParse({
        ...pages[3],
        items: [{ ...pages[3].items[0], status: "redacted" }],
      }).success,
    ).toBe(false);
    expect(
      merchantShopperProfileResponseSchema.safeParse({
        ...pages[4],
        items: [{ ...pages[4].items[0], shopifyDiscountCode: "private" }],
      }).success,
    ).toBe(false);
  });
  it("rejects invalid query identity before obtaining a token", async () => {
    await expect(client().list({ minPoints: "1.5" })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
