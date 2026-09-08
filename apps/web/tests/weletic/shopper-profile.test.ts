import { prisma } from "@/lib/prisma";
import {
  shopperProfileChronology,
  ShopperProfileError,
  shopperProfilePage,
  shopperProfileQuerySchema,
  shopperProfileSequence,
} from "@/lib/weletic/shoppers/profile-query";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  shopper: vi.fn(),
  account: vi.fn(),
  privacy: vi.fn(),
  metadataRedacted: vi.fn(),
  tombstone: vi.fn(),
  program: vi.fn(),
  settings: vi.fn(),
  tier: vi.fn(),
  orders: vi.fn(),
  reviews: vi.fn(),
  requests: vi.fn(),
  referrals: vi.fn(),
  ledger: vi.fn(),
  rewards: vi.fn(),
  permissions: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) => {
      mocks.transaction();
      return callback({
        weleticShopifyStore: { findFirst: mocks.store },
        weleticShopper: { findFirst: mocks.shopper },
        weleticLoyaltyAccount: { findFirst: mocks.account },
        weleticShopifyCustomerPrivacyTombstone: { findFirst: mocks.tombstone },
        weleticLoyaltyProgram: { findUnique: mocks.program },
        weleticReviewSettings: { findUnique: mocks.settings },
        weleticLoyaltyTier: { findFirst: mocks.tier },
        weleticCommerceOrder: { findMany: mocks.orders },
        weleticProductReview: { findMany: mocks.reviews },
        weleticReviewRequest: { findMany: mocks.requests },
        weleticLoyaltyReferral: { findMany: mocks.referrals },
        weleticPointsLedgerEntry: { findMany: mocks.ledger },
        weleticRewardRedemption: { findMany: mocks.rewards },
      });
    },
  },
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: mocks.metadataRedacted,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  hasShopifyCustomerPrivacyTombstone: mocks.privacy,
  SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN: /^redacted:/,
}));
vi.mock("@/lib/auth", () => ({
  withWorkspace:
    (
      handler: (context: {
        workspace: { id: string };
        searchParams: Record<string, string>;
      }) => unknown,
      options: unknown,
    ) =>
    (request: Request) => {
      mocks.permissions(options);
      return handler({
        workspace: { id: "authorized-workspace" },
        searchParams: Object.fromEntries(new URL(request.url).searchParams),
      });
    },
}));

import { shopperRewardOwnershipWhere } from "@/lib/weletic/loyalty/reward-ownership";
import { readMerchantShopperProfile } from "@/lib/weletic/shoppers/profile";
import { GET } from "../../app/(ee)/api/weletic/shoppers/profile/route";

const now = new Date("2026-09-06T00:00:00Z");
const scope = {
  storeId: "store-1",
  shopperId: "shopper-1",
  section: "purchases" as const,
  generation: "g1",
};
const shopper = {
  id: "shopper-1",
  shopifyCustomerId: "1234",
  firstName: "Controlled",
  lastName: "Fixture",
  email: "shopper@example.test",
  phone: null,
  locale: "ja",
  acceptsMarketing: true,
  createdAt: now,
  updatedAt: now,
};
const account = {
  id: "account-1",
  status: "active",
  metadata: null,
  currentTierId: "tier-1",
  cachedPointsBalance: BigInt("-9007199254740993"),
  cachedPendingPoints: BigInt("9007199254740995"),
  lifetimePointsEarned: BigInt("9007199254740997"),
  lifetimePointsRedeemed: BigInt("9007199254740999"),
  enrolledAt: now,
};

describe("shared merchant shopper projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.mockResolvedValue({
      id: "store-1",
      installationGeneration: "g1",
      defaultLocale: "en",
    });
    mocks.shopper.mockResolvedValue(shopper);
    mocks.account.mockResolvedValue(account);
    mocks.privacy.mockResolvedValue(false);
    mocks.metadataRedacted.mockReturnValue(false);
    mocks.tombstone.mockResolvedValue(null);
    mocks.program.mockResolvedValue({
      status: "disabled",
      killSwitchActive: false,
    });
    mocks.settings.mockResolvedValue({
      enabled: false,
      requestEmailEnabled: false,
    });
    mocks.tier.mockResolvedValue({ id: "tier-1", name: "Silver" });
    for (const mock of [
      mocks.orders,
      mocks.reviews,
      mocks.requests,
      mocks.referrals,
      mocks.ledger,
      mocks.rewards,
    ])
      mock.mockResolvedValue([]);
  });

  it("reuses the caller transaction and retains redaction rejection", async () => {
    const tx = await prisma.$transaction(async (tx) => tx);
    mocks.transaction.mockClear();
    const result = await readMerchantShopperProfile(
      "workspace-1",
      { shopperId: "shopper-1" },
      tx,
    );
    expect(result).toMatchObject({
      section: "overview",
      shopper: { id: "shopper-1" },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    mocks.privacy.mockResolvedValue(true);
    await expect(
      readMerchantShopperProfile("workspace-1", { shopperId: "shopper-1" }, tx),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("resolves a shopper without creating or requiring a loyalty account", async () => {
    mocks.account.mockResolvedValue(null);
    const result = await readMerchantShopperProfile("workspace-1", {
      shopperId: "shopper-1",
    });
    expect(result).toMatchObject({
      section: "overview",
      shopper: { id: "shopper-1" },
      loyalty: null,
      communicationPreferences: {
        shopifyAcceptsMarketing: true,
        consentEvidence: "unavailable",
        consentRecordedAt: null,
        suppressionStatus: "unavailable",
      },
      coverage: { communications: "partial" },
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.tier).not.toHaveBeenCalled();
  });

  it("keeps disabled-module history and exact negative/large balances", async () => {
    const result = await readMerchantShopperProfile("workspace-1", {
      shopperId: "shopper-1",
    });
    expect(result).toMatchObject({
      loyalty: {
        pointsBalance: "-9007199254740993",
        pendingPoints: "9007199254740995",
        lifetimeEarned: "9007199254740997",
        lifetimeRedeemed: "9007199254740999",
      },
      modules: { loyalty: { status: "disabled" }, reviews: { enabled: false } },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(mocks.tier).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tier-1", program: { storeId: "store-1" } },
      }),
    );
  });

  it.each([
    "store",
    "generation",
    "shopper",
    "pseudonym",
    "metadata",
    "identity",
    "owner",
  ])("rejects missing or redacted ownership: %s", async (kind) => {
    if (kind === "store") mocks.store.mockResolvedValue(null);
    if (kind === "generation")
      mocks.store.mockResolvedValue({
        id: "store-1",
        installationGeneration: null,
      });
    if (kind === "shopper") mocks.shopper.mockResolvedValue(null);
    if (kind === "pseudonym")
      mocks.shopper.mockResolvedValue({
        ...shopper,
        shopifyCustomerId: "redacted:fixture",
      });
    if (kind === "metadata") mocks.metadataRedacted.mockReturnValue(true);
    if (kind === "identity") mocks.privacy.mockResolvedValue(true);
    if (kind === "owner")
      mocks.tombstone.mockResolvedValue({ id: "tombstone" });
    await expect(
      readMerchantShopperProfile("workspace-1", {
        shopperId: "shopper-1",
        section: "reviews",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.reviews).not.toHaveBeenCalled();
  });

  it("uses the authorized workspace and store on every ownership boundary", async () => {
    const response = await GET(
      new NextRequest(
        "https://app.example.test/api/weletic/shoppers/profile?shopperId=shopper-1&workspaceId=foreign&storeId=foreign",
      ),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.permissions).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.read"],
    });
    expect(mocks.store).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "authorized-workspace",
          complianceState: "active",
          installationGeneration: { not: null },
        },
      }),
    );
    expect(mocks.shopper).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "shopper-1", storeId: "store-1" },
      }),
    );
    expect(mocks.account).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopperId: "shopper-1", storeId: "store-1" },
      }),
    );
    expect(mocks.privacy).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        shopifyCustomerId: "1234",
        email: shopper.email,
      }),
    );
    expect(mocks.tombstone).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store-1",
          OR: [{ shopperId: "shopper-1" }, { accountId: "account-1" }],
        },
      }),
    );
  });

  it.each([
    "purchases",
    "reviews",
    "review_requests",
    "rewards",
    "points",
  ] as const)(
    "bounds and scopes the %s collection with explicit projections",
    async (section) => {
      const mock = {
        purchases: mocks.orders,
        reviews: mocks.reviews,
        review_requests: mocks.requests,
        rewards: mocks.rewards,
        points: mocks.ledger,
      }[section];
      await readMerchantShopperProfile("workspace-1", {
        shopperId: "shopper-1",
        section,
        limit: 2,
      });
      const args = mock.mock.calls[0][0];
      if (section === "rewards") {
        expect(args.where).toEqual({
          AND: [
            shopperRewardOwnershipWhere({
              storeId: "store-1",
              shopperId: "shopper-1",
              accountId: "account-1",
            }),
            {},
          ],
        });
      } else
        expect(args.where).toMatchObject({
          storeId: "store-1",
          ...(["points", "rewards"].includes(section)
            ? { accountId: "account-1" }
            : { shopperId: "shopper-1" }),
        });
      expect(args.take).toBe(3);
      expect(args.orderBy).toEqual([
        { [section === "points" ? "sequenceNumber" : "createdAt"]: "desc" },
        { id: "desc" },
      ]);
      for (const key of [
        "tokenHash",
        "encryptedDeliveryToken",
        "deliveryToken",
        "metadata",
        "shopifyDiscountCode",
        "objectKey",
        "lastError",
        "checkoutToken",
        "friendEmailDigest",
      ])
        expect(args.select).not.toHaveProperty(key);
    },
  );

  it("retains per-order accounting currency and exact minor-unit amounts without summing currencies", async () => {
    mocks.orders.mockResolvedValue([
      {
        id: "order-1",
        createdAt: now,
        occurredAt: now,
        orderName: "#1",
        status: "paid",
        accountingCurrency: "JPY",
        accountingNet: BigInt("9007199254740993"),
        accountingTotal: BigInt("9007199254740995"),
      },
    ]);
    const result = await readMerchantShopperProfile("workspace-1", {
      shopperId: "shopper-1",
      section: "purchases",
    });
    expect(result).toMatchObject({
      items: [
        {
          accountingCurrency: "JPY",
          accountingNet: "9007199254740993",
          accountingTotal: "9007199254740995",
        },
      ],
    });
  });

  it("reads friend referrals even without loyalty enrollment and omits the other shopper's identifiers", async () => {
    mocks.account.mockResolvedValue(null);
    mocks.referrals.mockResolvedValue([
      {
        id: "referral-1",
        createdAt: now,
        advocateAccountId: "another-account",
        status: "rewarded",
        qualifyingOrderId: "order-1",
        advocatePointsAwarded: BigInt(200),
        refereePointsAwarded: BigInt(100),
        rewardedAt: now,
        friendRewardEmailedAt: now,
      },
    ]);
    const result = await readMerchantShopperProfile("workspace-1", {
      shopperId: "shopper-1",
      section: "referrals",
    });
    expect(result).toMatchObject({
      items: [{ id: "referral-1", role: "friend", pointsAwarded: "100" }],
    });
    expect(JSON.stringify(result)).not.toContain("another-account");
    expect(mocks.referrals.mock.calls[0][0].where).toEqual({
      storeId: "store-1",
      AND: [{ OR: [{ refereeShopperId: "shopper-1" }] }, {}],
    });
  });

  it.each(["points"])(
    "returns no %s for an unenrolled shopper",
    async (section) => {
      mocks.account.mockResolvedValue(null);
      expect(
        await readMerchantShopperProfile("workspace-1", {
          shopperId: "shopper-1",
          section,
        }),
      ).toMatchObject({
        items: [],
        pagination: { hasMore: false, nextCursor: null },
      });
      expect(mocks.ledger).not.toHaveBeenCalled();
      expect(mocks.rewards).not.toHaveBeenCalled();
    },
  );

  it("reads direct coupons without creating a loyalty account or ledger", async () => {
    mocks.account.mockResolvedValue(null);
    mocks.rewards.mockResolvedValue([
      {
        id: "direct-1",
        createdAt: now,
        rewardDefinitionId: "reward-1",
        status: "issued",
        artifactKind: "discount_code",
        pointsSpent: BigInt(0),
        fulfillmentSource: "review_incentive_v1",
        usedAt: null,
        expiresAt: null,
      },
    ]);
    const result = await readMerchantShopperProfile("workspace-1", {
      shopperId: "shopper-1",
      section: "rewards",
    });
    expect(result).toMatchObject({
      items: [
        {
          id: "direct-1",
          pointsSpent: "0",
          fulfillmentSource: "review_incentive_v1",
        },
      ],
    });
    expect(mocks.rewards.mock.calls[0][0].where).toEqual({
      AND: [
        shopperRewardOwnershipWhere({
          storeId: "store-1",
          shopperId: "shopper-1",
          accountId: null,
        }),
        {},
      ],
    });
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("explains pending-only ledger changes with exact deltas", async () => {
    mocks.ledger.mockResolvedValue([
      {
        id: "pending-1",
        createdAt: now,
        sequenceNumber: 1,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(0),
        pendingDelta: BigInt("9007199254740993"),
        balanceAfter: BigInt(-1),
      },
    ]);
    const result = await readMerchantShopperProfile("workspace-1", {
      shopperId: "shopper-1",
      section: "points",
    });
    expect(result).toMatchObject({
      items: [
        {
          pointsDelta: "0",
          pendingDelta: "9007199254740993",
          balanceAfter: "-1",
        },
      ],
    });
    expect(mocks.ledger.mock.calls[0][0].select.pendingDelta).toBe(true);
  });

  it("fails closed without leaking database/identity failures", async () => {
    mocks.privacy.mockRejectedValue(
      new Error("secret-bearing SQL and customer@example.test"),
    );
    const response = await GET(
      new NextRequest(
        "https://app.example.test/api/weletic/shoppers/profile?shopperId=shopper-1",
      ),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toMatch(
      /secret-bearing|customer@example/,
    );
  });
});

describe("scoped shopper profile cursors", () => {
  const rows = [
    { id: "b", createdAt: now },
    { id: "a", createdAt: now },
  ];
  it("uses timestamp and ID together for tied rows", () => {
    const page = shopperProfilePage(scope, rows, 1, (row) => ({ id: row.id }));
    expect(page.items).toEqual([{ id: "b" }]);
    expect(
      shopperProfileChronology(scope, page.pagination.nextCursor!),
    ).toEqual({
      OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: "b" } }],
    });
  });
  it("uses ledger sequence rather than timestamp for points", () => {
    const pointScope = { ...scope, section: "points" as const };
    const page = shopperProfilePage(
      pointScope,
      rows.map((row, i) => ({ ...row, sequenceNumber: 9 - i })),
      1,
      (row) => row.id,
    );
    expect(
      shopperProfileSequence(pointScope, page.pagination.nextCursor!),
    ).toEqual({
      OR: [
        { sequenceNumber: { lt: 9 } },
        { sequenceNumber: 9, id: { lt: "b" } },
      ],
    });
  });
  it.each(["storeId", "shopperId", "generation", "section"] as const)(
    "rejects a cursor from another %s",
    (key) => {
      const cursor = shopperProfilePage(scope, rows, 1, (row) => row.id)
        .pagination.nextCursor!;
      expect(() =>
        shopperProfileChronology(
          { ...scope, [key]: key === "section" ? "reviews" : "other" },
          cursor,
        ),
      ).toThrow(ShopperProfileError);
    },
  );
  it.each(["%%%", "e30", "bnVsbA", "W10", "a".repeat(2049)])(
    "rejects malformed cursors",
    (cursor) => {
      expect(() => shopperProfileChronology(scope, cursor)).toThrow(
        ShopperProfileError,
      );
    },
  );
  it.each([0, -1, 51, 1.5, "NaN"])("rejects invalid limits", (limit) => {
    expect(
      shopperProfileQuerySchema.safeParse({ shopperId: "shopper-1", limit })
        .success,
    ).toBe(false);
  });
  it("finishes without a cursor and keeps overview default explicit", () => {
    expect(
      shopperProfilePage(scope, rows, 2, (row) => row.id).pagination,
    ).toEqual({ limit: 2, hasMore: false, nextCursor: null });
    expect(
      shopperProfileQuerySchema.parse({ shopperId: "shopper-1" }).section,
    ).toBe("overview");
  });
});
