import { prisma } from "@/lib/prisma";
import { listMerchantShoppers } from "@/lib/weletic/shoppers/directory";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/(ee)/api/weletic/shoppers/route";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  shoppers: vi.fn(),
  accounts: vi.fn(),
  owners: vi.fn(),
  identities: vi.fn(),
  permissions: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (tx: unknown) => unknown) => {
      mocks.transaction();
      return callback({
        weleticShopifyStore: { findFirst: mocks.store },
        weleticShopper: { findMany: mocks.shoppers },
        weleticLoyaltyAccount: { findMany: mocks.accounts },
        weleticShopifyCustomerPrivacyTombstone: {
          groupBy: mocks.owners,
          findMany: mocks.identities,
        },
      });
    },
  },
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: (metadata: unknown) =>
    metadata === "redacted",
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN: /^redacted:/,
  deriveAllShopifyCustomerPrivacyIdentities: ({
    shopifyCustomerId,
  }: {
    shopifyCustomerId: string;
  }) => [
    {
      identityKind: "customer_id",
      identityKeyId: "test",
      customerDigest: shopifyCustomerId,
    },
  ],
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

describe("merchant shopper directory boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.mockResolvedValue({
      id: "store-a",
      installationGeneration: "g1",
    });
    mocks.shoppers.mockResolvedValue([
      {
        id: "shopper-a",
        shopifyCustomerId: "1234",
        firstName: "Fixture",
        lastName: null,
        email: "fixture@example.test",
        createdAt: new Date("2026-09-06T00:00:00Z"),
      },
    ]);
    mocks.accounts.mockResolvedValue([]);
    mocks.owners.mockResolvedValue([]);
    mocks.identities.mockResolvedValue([]);
  });
  it("reuses the caller transaction without bypassing privacy filtering", async () => {
    const tx = await prisma.$transaction(async (tx) => tx);
    mocks.transaction.mockClear();
    const result = await listMerchantShoppers("authorized-workspace", {}, tx);
    expect(result.items).toHaveLength(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.store.mock.calls[0][0].where.projectId).toBe(
      "authorized-workspace",
    );
    mocks.accounts.mockResolvedValue([
      {
        id: "account",
        shopperId: "shopper-a",
        status: "active",
        metadata: "redacted",
      },
    ]);
    expect(
      (await listMerchantShoppers("authorized-workspace", {}, tx)).items,
    ).toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { search: "x".repeat(101) },
    { cursor: "x".repeat(2049) },
    { minPoints: "1.5" },
    { minPoints: "1.5", maxPoints: "10" },
    { loyalty: "not_enrolled", minPoints: "0" },
  ])("rejects unbounded query %j before database work", async (query) => {
    await expect(
      listMerchantShoppers("workspace", query),
    ).rejects.toBeDefined();
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("uses the authorized workspace, bounded selects and grouped owner existence", async () => {
    const response = await GET(
      new NextRequest(
        "https://local.test/api/weletic/shoppers?workspaceId=untrusted&search=Fixture",
      ),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.permissions).toHaveBeenCalledWith({
      requiredPermissions: ["loyalty.read"],
    });
    expect(mocks.store.mock.calls[0][0].where.projectId).toBe(
      "authorized-workspace",
    );
    expect(mocks.shoppers.mock.calls[0][0]).toMatchObject({
      take: 21,
      where: { storeId: "store-a" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(Object.keys(mocks.shoppers.mock.calls[0][0].select).sort()).toEqual(
      [
        "id",
        "shopifyCustomerId",
        "firstName",
        "lastName",
        "email",
        "createdAt",
      ].sort(),
    );
    expect(mocks.owners).toHaveBeenCalledWith({
      by: ["shopperId"],
      where: { storeId: "store-a", shopperId: { in: ["shopper-a"] } },
    });
    expect(mocks.identities.mock.calls[0][0].where).toMatchObject({
      storeId: "store-a",
      expiresAt: { gt: expect.any(Date) },
      OR: [
        {
          identityKind: "customer_id",
          identityKeyId: "test",
          customerDigest: "1234",
        },
      ],
    });
  });
  it("hides legacy redaction metadata without returning that metadata", async () => {
    mocks.accounts.mockResolvedValue([
      {
        id: "account",
        shopperId: "shopper-a",
        status: "active",
        metadata: "redacted",
      },
    ]);
    expect((await listMerchantShoppers("workspace", {})).items).toEqual([]);
  });
  it("binds continuation to normalized segment criteria", async () => {
    const row = {
      id: "b",
      shopifyCustomerId: "1234",
      firstName: null,
      lastName: null,
      email: null,
      createdAt: new Date("2026-09-06T00:00:00Z"),
    };
    mocks.shoppers.mockResolvedValue([
      row,
      { ...row, id: "a", shopifyCustomerId: "5678" },
    ]);
    const first = await listMerchantShoppers("workspace", {
      limit: 1,
      minPoints: " 9007199254740993 ",
    });
    const cursor = first.pagination.nextCursor!;
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString()).v).toBe(2);
    await expect(
      listMerchantShoppers("workspace", {
        cursor,
        minPoints: "9007199254740993",
      }),
    ).resolves.toBeDefined();
    for (const changed of [
      {},
      { minPoints: "9007199254740994" },
      { minPoints: "9007199254740993", purchase: "has_order" },
    ]) {
      await expect(
        listMerchantShoppers("workspace", { cursor, ...changed }),
      ).rejects.toMatchObject({ code: "bad_request" });
    }
  });
  it("accepts a legacy cursor only with no segment filters", async () => {
    const { createHash } = await import("node:crypto");
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        storeId: "store-a",
        generation: "g1",
        searchHash: createHash("sha256").update("").digest("hex"),
        createdAt: "2026-09-06T00:00:00.000Z",
        id: "legacy",
      }),
    ).toString("base64url");
    await expect(
      listMerchantShoppers("workspace", { cursor }),
    ).resolves.toBeDefined();
    await expect(
      listMerchantShoppers("workspace", { cursor, loyalty: "active" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
  it.each([
    "%%%",
    Buffer.from(JSON.stringify({ v: 99 })).toString("base64url"),
  ])("rejects malformed cursors", async (cursor) => {
    await expect(
      listMerchantShoppers("workspace", { cursor }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(mocks.shoppers).not.toHaveBeenCalled();
  });
  it("returns private generic failures without database errors", async () => {
    mocks.store.mockRejectedValue(new Error("password=not-for-response"));
    const response = await GET(
      new NextRequest("https://local.test/api/weletic/shoppers"),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("password");
  });
  it("returns a private 400 for malformed paired point bounds", async () => {
    const response = await GET(
      new NextRequest(
        "https://local.test/api/weletic/shoppers?minPoints=1.5&maxPoints=10",
      ),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.store).not.toHaveBeenCalled();
  });
});
