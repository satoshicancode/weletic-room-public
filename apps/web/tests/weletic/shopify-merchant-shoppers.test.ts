import {
  listShopifyMerchantShoppersInTransaction,
  readShopifyMerchantShopperInTransaction,
} from "@/lib/weletic/shopify/merchant-shoppers";
import { signWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { merchantShopperListInputSchema } from "@/lib/weletic/shoppers/merchant-contract";
import { ShopperProfileError } from "@/lib/weletic/shoppers/profile-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/customers/[operation]/route";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  list: vi.fn(),
  profile: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shoppers/directory", () => ({
  listMerchantShoppers: mocks.list,
}));
vi.mock("@/lib/weletic/shoppers/profile", () => ({
  readMerchantShopperProfile: mocks.profile,
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/staff-authorization")
  >()),
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));

const tx = {} as Parameters<
  typeof listShopifyMerchantShoppersInTransaction
>[0]["tx"];
const identity = {
  storeId: "store-a",
  projectId: "workspace-a",
  appId: "app-a",
  installationGeneration: "generation-a",
  shopifyUserId: "123",
  grantRevision: 1,
};
const actor = {
  version: 1,
  storeId: "store-a",
  appId: "app-a",
  installationGeneration: "generation-a",
  shop: "fixture.myshopify.com",
  userId: "123",
  sessionId: "fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: Date.now(),
  requestId: "b".repeat(64),
};
const page = {
  items: [],
  pagination: { limit: 20, hasMore: true, nextCursor: "inner-cursor" },
};
const list = (input: unknown = {}) =>
  listShopifyMerchantShoppersInTransaction({ tx, envelope: actor, input });
const profile = (
  input: unknown = { shopperId: "shopper-a", section: "purchases" },
) => readShopifyMerchantShopperInTransaction({ tx, envelope: actor, input });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(identity);
  mocks.list.mockResolvedValue(page);
  mocks.profile.mockResolvedValue({ ...page, section: "purchases" });
  mocks.transaction.mockImplementation((callback) => callback(tx));
  vi.stubEnv(
    "WELETIC_SHOPIFY_SERVICE_SECRET",
    "synthetic-customers-service-secret-at-least-32",
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("Shopify merchant shopper authorization adapter", () => {
  it("uses customers.read and the same transaction with the authorized workspace", async () => {
    await list({ search: "  buyer  ", minPoints: " 9007199254740993 " });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope: actor,
      permission: "customers.read",
    });
    expect(mocks.list).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({
        search: "buyer",
        minPoints: "9007199254740993",
        cursor: undefined,
      }),
      tx,
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
    await profile();
    expect(mocks.profile).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({ shopperId: "shopper-a", section: "purchases" }),
      tx,
    );
  });
  it.each([
    "storeId",
    "appId",
    "installationGeneration",
    "shopifyUserId",
    "grantRevision",
    "projectId",
  ])("rejects a cursor after %s changes before reading data", async (field) => {
    const result = await list();
    mocks.list.mockClear();
    mocks.authorize.mockResolvedValue({ ...identity, [field]: "other" });
    await expect(
      list({ cursor: result.pagination.nextCursor }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("round trips canonical cursors with normalized filters but rejects changed filters or encoding", async () => {
    const first = await list({ search: " buyer ", minPoints: " 1 " });
    await list({
      search: "buyer",
      minPoints: "1",
      cursor: first.pagination.nextCursor,
    });
    expect(mocks.list).toHaveBeenLastCalledWith(
      "workspace-a",
      expect.objectContaining({ cursor: "inner-cursor" }),
      tx,
    );
    for (const input of [
      {
        search: "different",
        minPoints: "1",
        cursor: first.pagination.nextCursor,
      },
      { search: "buyer", minPoints: "2", cursor: first.pagination.nextCursor },
      {
        search: "buyer",
        minPoints: "1",
        cursor: `${first.pagination.nextCursor}=`,
      },
    ])
      await expect(list(input)).rejects.toMatchObject({ code: "bad_request" });
  });
  it("binds profile cursors to shopper and section and rejects a directory cursor", async () => {
    const first = await profile();
    if (first.section === "overview") throw new Error("Expected page");
    await profile({
      shopperId: "shopper-a",
      section: "purchases",
      cursor: first.pagination.nextCursor,
    });
    expect(mocks.profile).toHaveBeenLastCalledWith(
      "workspace-a",
      expect.objectContaining({ cursor: "inner-cursor" }),
      tx,
    );
    for (const input of [
      { shopperId: "shopper-b", section: "purchases" },
      { shopperId: "shopper-a", section: "reviews" },
    ])
      await expect(
        profile({ ...input, cursor: first.pagination.nextCursor }),
      ).rejects.toMatchObject({ code: "bad_request" });
    const directory = await list();
    await expect(
      profile({
        shopperId: "shopper-a",
        section: "purchases",
        cursor: directory.pagination.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
  it.each(["access_denied", "invalid_actor", "request_replayed"] as const)(
    "does not read after %s",
    async (code) => {
      mocks.authorize.mockRejectedValue(
        new ShopifyStaffAuthorizationError(code),
      );
      await expect(list()).rejects.toMatchObject({ code });
      await expect(profile()).rejects.toMatchObject({ code });
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.profile).not.toHaveBeenCalled();
    },
  );
  it.each([
    { storeId: "other" },
    { workspaceId: "other" },
    { owner: true },
    { limit: 51 },
    { minPoints: "1.5" },
    { minPoints: "4", maxPoints: "3" },
    { loyalty: "not_enrolled", minPoints: "0" },
    { purchasedFrom: "2026-09-01" },
    { purchase: "has_order", purchasedFrom: "2026-02-30" },
    { cursor: "x".repeat(4097) },
  ])(
    "retains segment validation and rejects identity injection: %j",
    async (input) => {
      expect(merchantShopperListInputSchema.safeParse(input).success).toBe(
        false,
      );
      await expect(list(input)).rejects.toThrow();
      expect(mocks.authorize).not.toHaveBeenCalled();
    },
  );
  it("keeps overview responses and terminal pages unchanged", async () => {
    const overview = { section: "overview", shopper: { id: "shopper-a" } };
    mocks.profile.mockResolvedValue(overview);
    expect(await profile({ shopperId: "shopper-a" })).toEqual(overview);
    mocks.list.mockResolvedValue({
      ...page,
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    });
    expect((await list()).pagination.nextCursor).toBeNull();
    await expect(
      profile({ shopperId: "shopper-a", cursor: "invalid" }),
    ).rejects.toThrow();
  });
});

function signed(value: unknown, operation = "list", signedBody?: string) {
  const body = JSON.stringify(value);
  const path = `/api/internal/shopify/merchant/customers/${operation}`;
  const timestamp = String(Date.now());
  return new Request(`https://fixture.invalid${path}`, {
    method: "POST",
    body,
    headers: {
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body: signedBody ?? body,
        secret: process.env.WELETIC_SHOPIFY_SERVICE_SECRET!,
      }),
    },
  });
}
const post = (request: Request, operation = "list") =>
  POST(request, { params: Promise.resolve({ operation }) });

describe("signed customer endpoints", () => {
  it.each(["list", "profile"])(
    "authenticates the full %s envelope and performs one transaction",
    async (operation) => {
      const input =
        operation === "list"
          ? {}
          : { shopperId: "shopper-a", section: "purchases" };
      const response = await post(
        signed({ actor, input }, operation),
        operation,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.authorize).toHaveBeenCalledWith({
        tx,
        envelope: actor,
        permission: "customers.read",
      });
    },
  );
  it("rejects unsigned and body-tampered requests without opening a transaction", async () => {
    const request = signed({ actor, input: {} });
    request.headers.delete("x-weletic-signature");
    expect((await post(request)).status).toBe(401);
    expect(
      (
        await post(
          signed(
            { actor, input: { search: "modified" } },
            "list",
            JSON.stringify({ actor, input: {} }),
          ),
        )
      ).status,
    ).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { actor: { ...actor, owner: true }, input: {} },
    { actor, input: { workspaceId: "other" } },
    { actor, input: {}, storeId: "other" },
    { actor, input: { search: "x".repeat(17000) } },
  ])("rejects expanded or oversized envelopes", async (body) => {
    expect((await post(signed(body))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([
    ["access_denied", 403],
    ["invalid_actor", 401],
    ["request_replayed", 409],
  ] as const)("sanitizes %s", async (code, status) => {
    mocks.authorize.mockRejectedValue(new ShopifyStaffAuthorizationError(code));
    const result = await post(signed({ actor, input: {} }));
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error: code });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each([
    new ShopperProfileError("not_found"),
    new ShopperProfileError("bad_request"),
    new Error("private database connection"),
  ])("sanitizes data errors", async (error) => {
    mocks.list.mockRejectedValue(error);
    const result = await post(signed({ actor, input: {} }));
    expect(result.status).toBe(
      error instanceof ShopperProfileError
        ? error.code === "not_found"
          ? 404
          : 400
        : 503,
    );
    expect(await result.text()).not.toContain("private database");
  });
});
