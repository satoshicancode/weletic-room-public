import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCustomerNudgeCollectionMembership as read } from "../../lib/weletic/loyalty/nudge-collection-reader";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  program: vi.fn(),
  summary: vi.fn(),
  token: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    weleticLoyaltyProgram: { findUnique: mocks.program },
  },
}));
vi.mock("../../lib/weletic/loyalty/customer", () => ({
  getCustomerLoyaltySummary: mocks.summary,
}));
vi.mock("@/lib/weletic/shopify/token-authority", () => ({
  fetchShopifyTokenAuthorityCredential: mocks.token,
}));
const p = "gid://shopify/Product/1",
  c = "gid://shopify/Collection/2";
const input = {
  storeId: "store",
  shopifyCustomerId: "customer",
  productIds: [p],
};
const store = {
  id: "store",
  shopDomain: "fixture.myshopify.com",
  installationGeneration: "gen1",
  storeAccessState: "active",
  complianceState: "active",
  uninstalledAt: null,
  redactedAt: null,
};
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.store.mockResolvedValue(store);
  mocks.program.mockResolvedValue({
    id: "program",
    status: "active",
    killSwitchActive: false,
    updatedAt: new Date(0),
  });
  mocks.summary.mockResolvedValue({
    isEnrolled: true,
    account: { canParticipate: true },
    program: { isActive: true },
    rewards: [{ canRedeem: true, entitledCollectionIds: [c] }],
    rewardWallet: [],
  });
  mocks.token.mockResolvedValue({
    shopDomain: store.shopDomain,
    scope: "read_products",
    accessToken: "fixture-only",
  });
  fetchMock = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { p0: { id: p, c0: true } } })),
    );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it("binds credentials to the installation and queries only owned reward scope", async () => {
  expect(await read(input)).toEqual({ [p]: [c] });
  expect(mocks.token).toHaveBeenCalledWith({
    shopDomain: store.shopDomain,
    installationGeneration: "gen1",
  });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables).toEqual({
    p0: p,
    c0: c,
  });
  expect(mocks.store).toHaveBeenCalledTimes(2);
  expect(mocks.summary).toHaveBeenCalledWith(
    expect.objectContaining({ provisionReferralIdentity: false }),
  );
});
it("uses original wallet terms even without affordable catalog rewards", async () => {
  mocks.summary.mockResolvedValue({
    isEnrolled: true,
    account: { canParticipate: true },
    program: { isActive: true },
    rewards: [],
    rewardWallet: [
      { status: "available", termsSnapshot: { entitledCollectionIds: [c] } },
    ],
  });
  expect(await read(input)).toEqual({ [p]: [c] });
});
it("rejects invalid products before I/O", async () => {
  expect(await read({ ...input, productIds: ["invalid"] })).toBeNull();
  expect(mocks.store).not.toHaveBeenCalled();
});
it.each(["pending_approval", "suspended"])(
  "blocks %s stores before token access",
  async (state) => {
    mocks.store.mockResolvedValue({ ...store, storeAccessState: state });
    expect(await read(input)).toBeNull();
    expect(mocks.token).not.toHaveBeenCalled();
  },
);
it("discards a result after reinstall", async () => {
  mocks.store
    .mockResolvedValueOnce(store)
    .mockResolvedValueOnce({ ...store, installationGeneration: "gen2" });
  expect(await read(input)).toBeNull();
});
it("discards a result after store suspension", async () => {
  mocks.store
    .mockResolvedValueOnce(store)
    .mockResolvedValueOnce({ ...store, storeAccessState: "suspended" });
  expect(await read(input)).toBeNull();
});
it("discards a result after program changes", async () => {
  mocks.program
    .mockResolvedValueOnce({
      id: "program",
      status: "active",
      killSwitchActive: false,
      updatedAt: new Date(0),
    })
    .mockResolvedValueOnce({
      id: "program",
      status: "active",
      killSwitchActive: false,
      updatedAt: new Date(1),
    });
  expect(await read(input)).toBeNull();
});
it("rejects credentials for another store before fetching", async () => {
  mocks.token.mockResolvedValue({
    shopDomain: "other.myshopify.com",
    scope: "read_products",
    accessToken: "fixture-only",
  });
  expect(await read(input)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("does not fetch for a shopper without participation", async () => {
  mocks.summary.mockResolvedValue({
    isEnrolled: true,
    account: { canParticipate: false },
    program: { isActive: true },
  });
  expect(await read(input)).toBeNull();
  expect(mocks.token).not.toHaveBeenCalled();
});
it.each(["read_customers", ""])(
  "does not fetch without product scope %s",
  async (scope) => {
    mocks.token.mockResolvedValue({
      shopDomain: store.shopDomain,
      scope,
      accessToken: "fixture-only",
    });
    expect(await read(input)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it("does not retry or expose an upstream failure", async () => {
  fetchMock.mockRejectedValue(new Error("private upstream payload"));
  expect(await read(input)).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
