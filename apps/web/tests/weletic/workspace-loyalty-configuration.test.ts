import type { WorkspaceConfigurationAuthority } from "@/lib/weletic/loyalty/workspace-configuration";
import { manageWorkspaceLoyaltyConfigurationInTransaction as manage } from "@/lib/weletic/loyalty/workspace-configuration";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  program: vi.fn(),
  fence: vi.fn(),
  writer: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.fence,
}));
vi.mock("@/lib/weletic/loyalty/settings-writer", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/loyalty/settings-writer")>()),
  writeValidatedLoyaltySettingsInTransaction: mocks.writer,
}));
const tx = {
  weleticShopifyStore: { findFirst: mocks.store },
  weleticLoyaltyProgram: { findUnique: mocks.program },
} as unknown as Prisma.TransactionClient;
const row = () => ({
  id: "program-a",
  name: "Loyalty",
  status: "draft",
  pointNameSingular: "Point",
  pointNamePlural: "Points",
  pointsPerCurrencyUnit: new Prisma.Decimal("1.0001"),
  holdingPeriodDays: 14,
  pointsExpiryMonths: 12,
  pointsExpiryDays: 0,
  pointsExpiryWarningDays: 30,
  pointsExpiryLastChanceDays: 3,
  pointsExpiryWarningEnabled: true,
  pointsExpiryLastChanceEnabled: true,
  killSwitchActive: false,
  vipMilestoneMode: "amount_spent",
  vipTimeframe: "rolling_12m",
  vipDowngradeGraceDays: 30,
  vipAutoDowngradeEnabled: true,
  liabilityValuationCurrency: "JPY",
  liabilityMinorUnitsNumerator: BigInt("1"),
  liabilityPointsDenominator: BigInt("100"),
  updatedAt: new Date("2026-09-07T00:00:00.000Z"),
  earnPolicyVersion: 5,
});

const authority: WorkspaceConfigurationAuthority = {
  workspaceId: "workspace-a",
  role: "member",
  permissions: ["loyalty.read", "loyalty.write"],
};
const storeRow = () => ({
  id: "store-a",
  projectId: "workspace-a",
  installationGeneration: "g1",
  program: { accountingCurrency: "JPY" },
});
const read = (access = authority) => manage({ tx, authority: access });
const save = async (settings: unknown, access = authority) => {
  const current = await read(access);
  return manage({
    tx,
    authority: access,
    update: {
      expectedInstallationGeneration: "g1",
      expectedRevision: current.configurationRevision,
      settings,
    },
  });
};
describe("workspace Loyalty configuration authority and transaction adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.store.mockResolvedValue(storeRow());
    mocks.program.mockResolvedValue(row());
  });
  it("reads exact settings without fences, writes or initialization", async () => {
    expect(await read()).toMatchObject({
      accountingCurrency: "JPY",
      capabilities: { configure: true, owner: false },
      program: { settings: { pointsPerCurrencyUnit: "1.0001" } },
    });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.store).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "workspace-a",
          complianceState: "active",
          installationGeneration: { not: null },
        },
      }),
    );
    mocks.program.mockResolvedValue(null);
    expect(await read()).toMatchObject({
      program: null,
      configurationRevision: null,
    });
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("derives configure from token-narrowed permissions, not the owner role", async () => {
    const access = {
      ...authority,
      role: "owner",
      permissions: ["loyalty.read"] as const,
    };
    expect(await read(access)).toMatchObject({
      capabilities: { configure: false, owner: true },
    });
    await expect(save({ name: "Changed" }, access)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("denies missing read authority before any database access", async () => {
    await expect(read({ ...authority, permissions: [] })).rejects.toMatchObject(
      { code: "forbidden" },
    );
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it.each([
    { status: "active" },
    { killSwitchActive: false },
    {
      liabilityValuationCurrency: null,
      liabilityMinorUnitsNumerator: null,
      liabilityPointsDenominator: null,
    },
  ])("denies member owner-only fields %j", async (settings) => {
    await expect(save(settings)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("writes through the same transaction and preserves exact owner valuation", async () => {
    await save(
      {
        liabilityValuationCurrency: "JPY",
        liabilityMinorUnitsNumerator: "9223372036854775807",
        liabilityPointsDenominator: "100",
      },
      { ...authority, role: "owner" },
    );
    expect(mocks.fence).toHaveBeenCalledWith({
      tx,
      storeId: "store-a",
      action: "loyalty_admin_settings_update",
      expectedInstallationGeneration: "g1",
    });
    expect(mocks.writer).toHaveBeenCalledWith(
      tx,
      "store-a",
      expect.objectContaining({
        parsedLiabilityNumerator: BigInt("9223372036854775807"),
        parsedLiabilityDenominator: BigInt("100"),
        expectedStatus: "draft",
      }),
    );
  });
  it("rejects cross-workspace and generationless bindings", async () => {
    mocks.store.mockResolvedValue({ ...storeRow(), projectId: "other" });
    await expect(read()).rejects.toMatchObject({ code: "not_found" });
    mocks.store.mockResolvedValue({
      ...storeRow(),
      installationGeneration: null,
    });
    await expect(read()).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.program).not.toHaveBeenCalled();
  });
  it("rejects stale installation before the write fence", async () => {
    await expect(
      manage({
        tx,
        authority,
        update: {
          expectedInstallationGeneration: "old",
          expectedRevision: null,
          settings: { name: "Changed" },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("rechecks workspace binding after the fence", async () => {
    const current = await read();
    mocks.store
      .mockResolvedValueOnce(storeRow())
      .mockResolvedValueOnce({ ...storeRow(), id: "replacement" });
    await expect(
      manage({
        tx,
        authority,
        update: {
          expectedInstallationGeneration: "g1",
          expectedRevision: current.configurationRevision,
          settings: { name: "Changed" },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("rejects changed configuration and accounting currency mismatch", async () => {
    await expect(
      manage({
        tx,
        authority,
        update: {
          expectedInstallationGeneration: "g1",
          expectedRevision: null,
          settings: { name: "Changed" },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      save(
        {
          liabilityValuationCurrency: "USD",
          liabilityMinorUnitsNumerator: "1",
          liabilityPointsDenominator: "100",
        },
        { ...authority, role: "owner" },
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("never retries an uncertain write", async () => {
    mocks.writer.mockRejectedValue(new Error("Uncertain"));
    await expect(save({ name: "Changed" })).rejects.toThrow("Uncertain");
    expect(mocks.writer).toHaveBeenCalledTimes(1);
  });
});
