import { manageShopifyFlowGrantInTransaction } from "@/lib/weletic/shopify/merchant-flow-grants";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  fence: vi.fn(),
  program: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/staff-authorization")
  >()),
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRow: mocks.program,
}));

const now = new Date("2026-09-20T00:00:00Z");
const actor = {
  owner: true,
  storeId: "store-1",
  appId: "public-1",
  installationGeneration: "g1",
  shopifyUserId: "123",
  actionId: "a".repeat(64),
};
const policy = {
  allowCredit: true,
  allowDebit: true,
  maxAbsolutePointsPerAction: "9223372036854775808",
  absolutePointsBudget: "18446744073709551615",
  expiresAt: "2026-10-01T00:00:00Z",
  expectedRevision: 0,
  expectedInstallationGeneration: "g1",
};
const grant = {
  id: `wflowgrant_${"a".repeat(20)}`,
  storeId: "store-1",
  appId: "public-1",
  installationGeneration: "g1",
  revision: 1,
  revokedAt: null,
  maxAbsolutePointsPerAction: new Prisma.Decimal(
    policy.maxAbsolutePointsPerAction,
  ),
  absolutePointsBudget: new Prisma.Decimal(policy.absolutePointsBudget),
  absolutePointsUsed: new Prisma.Decimal(0),
};
const envelope = { trustedFixture: true };
const txMock = () => ({
  $queryRaw: vi.fn().mockResolvedValue([{ now }]),
  weleticShopifyFlowPointsGrant: {
    create: vi.fn().mockResolvedValue(grant),
    findUnique: vi.fn().mockResolvedValue(grant),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
});
let db = txMock();
const call = (operation: "create" | "revoke", input: unknown = policy) =>
  manageShopifyFlowGrantInTransaction({
    tx: db as unknown as Prisma.TransactionClient,
    envelope,
    operation,
    input,
  });
const revoke = {
  grantId: grant.id,
  expectedRevision: 1,
  expectedInstallationGeneration: "g1",
};

beforeEach(() => {
  vi.clearAllMocks();
  db = txMock();
  mocks.authorize.mockResolvedValue(actor);
  mocks.fence.mockResolvedValue(undefined);
  mocks.program.mockResolvedValue(undefined);
});
describe("owner Flow grant mutation boundary (mocked authority/persistence)", () => {
  it("persists exact strings and authenticated actor provenance in the caller transaction", async () => {
    expect(await call("create")).toEqual({
      id: grant.id,
      revision: 1,
      revokedAt: null,
    });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx: db,
      envelope,
      permission: "loyalty.configure",
    });
    expect(mocks.program).toHaveBeenCalledWith({
      tx: db,
      storeId: actor.storeId,
      mode: "active",
    });
    expect(db.weleticShopifyFlowPointsGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: actor.storeId,
        appId: actor.appId,
        installationGeneration: "g1",
        maxAbsolutePointsPerAction: policy.maxAbsolutePointsPerAction,
        absolutePointsBudget: policy.absolutePointsBudget,
        absolutePointsUsed: "0",
        approvedByShopifyUserId: actor.shopifyUserId,
        approvedMerchantActionId: actor.actionId,
      }),
    });
    expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fence.mock.invocationCallOrder[0],
    );
    expect(mocks.fence.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.program.mock.invocationCallOrder[0],
    );
  });
  it("rejects delegated configuration staff even if permission authorization passes", async () => {
    mocks.authorize.mockResolvedValue({ ...actor, owner: false });
    await expect(call("create")).rejects.toThrow("access_denied");
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(db.weleticShopifyFlowPointsGrant.create).not.toHaveBeenCalled();
  });
  it("rejects mismatched installation generation", async () => {
    await expect(
      call("create", { ...policy, expectedInstallationGeneration: "old" }),
    ).rejects.toThrow("state_changed");
    expect(db.weleticShopifyFlowPointsGrant.create).not.toHaveBeenCalled();
  });
  it.each(["maxAbsolutePointsPerAction", "absolutePointsBudget"])(
    "rejects fractional %s before authorization or SQL",
    async (field) => {
      await expect(
        call("create", { ...policy, [field]: "1.5" }),
      ).rejects.toThrow();
      expect(mocks.authorize).not.toHaveBeenCalled();
    },
  );
  it("uses fresh DB time rather than a pre-lock local clock for expiry", async () => {
    db.$queryRaw.mockResolvedValue([{ now: new Date(policy.expiresAt) }]);
    await expect(call("create")).rejects.toThrow("invalid_expiry");
    expect(db.weleticShopifyFlowPointsGrant.create).not.toHaveBeenCalled();
  });
  it("fails closed on missing DB clock", async () => {
    db.$queryRaw.mockResolvedValue([]);
    await expect(call("create")).rejects.toThrow("unavailable");
  });
  it("revokes with generation/revision CAS and retains policy and used budget", async () => {
    db.$queryRaw
      .mockResolvedValueOnce([{ id: grant.id }])
      .mockResolvedValueOnce([{ now }]);
    expect(await call("revoke", revoke)).toEqual({
      id: grant.id,
      revision: 2,
      revokedAt: now.toISOString(),
    });
    expect(mocks.program).toHaveBeenCalledWith({
      tx: db,
      storeId: actor.storeId,
      mode: "lock_only",
    });
    expect(db.weleticShopifyFlowPointsGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: grant.id,
        storeId: actor.storeId,
        appId: actor.appId,
        installationGeneration: "g1",
        revision: 1,
        revokedAt: null,
      },
      data: {
        revision: { increment: 1 },
        revokedAt: now,
        revokedByShopifyUserId: actor.shopifyUserId,
        revokedMerchantActionId: actor.actionId,
      },
    });
  });
  it.each([
    { storeId: "foreign" },
    { appId: "foreign" },
    { installationGeneration: "old" },
  ])("rejects mismatched persisted authority %j", async (patch) => {
    db.$queryRaw.mockResolvedValue([{ id: grant.id }]);
    db.weleticShopifyFlowPointsGrant.findUnique.mockResolvedValue({
      ...grant,
      ...patch,
    });
    await expect(call("revoke", revoke)).rejects.toThrow("unavailable");
    expect(db.weleticShopifyFlowPointsGrant.updateMany).not.toHaveBeenCalled();
  });
  it("rejects stale revisions and zero-row CAS", async () => {
    db.$queryRaw
      .mockResolvedValueOnce([{ id: grant.id }])
      .mockResolvedValueOnce([{ id: grant.id }])
      .mockResolvedValueOnce([{ now }]);
    await expect(
      call("revoke", { ...revoke, expectedRevision: 2 }),
    ).rejects.toThrow("state_changed");
    db.weleticShopifyFlowPointsGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(call("revoke", revoke)).rejects.toThrow("state_changed");
  });
});
