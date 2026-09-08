import { manageShopifyLoyaltyConfigurationInTransaction as manage } from "@/lib/weletic/shopify/loyalty-configuration";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  fence: vi.fn(),
  writer: vi.fn(),
  capabilities: vi.fn(),
  store: vi.fn(),
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
vi.mock("@/lib/weletic/shopify/settings-capabilities", () => ({
  readSettingsCapabilities: mocks.capabilities,
}));
vi.mock("@/lib/weletic/loyalty/settings-writer", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/loyalty/settings-writer")>()),
  writeValidatedLoyaltySettingsInTransaction: mocks.writer,
}));

const tx = {
  weleticShopifyStore: { findUnique: mocks.store },
  weleticLoyaltyProgram: { findUnique: mocks.program },
} as unknown as Prisma.TransactionClient;
const envelope = { fixture: "verified at signed route" };
const actor = {
  storeId: "store-a",
  projectId: "workspace-a",
  installationGeneration: "g1",
  owner: false,
};
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
const read = () => manage({ tx, envelope, request: { operation: "read" } });
const update = (
  expectedRevision: string | null,
  settings: unknown,
  generation = "g1",
) =>
  manage({
    tx,
    envelope,
    request: {
      operation: "update",
      input: {
        expectedRevision,
        expectedInstallationGeneration: generation,
        settings,
      },
    },
  });

describe("Shopify Loyalty configuration transaction adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue(actor);
    mocks.capabilities.mockResolvedValue({ loyalty: true });
    mocks.store.mockResolvedValue({
      projectId: "workspace-a",
      program: { accountingCurrency: "JPY" },
    });
    mocks.program.mockResolvedValue(row());
  });

  it("reads an exact minimal projection without initializing or writing", async () => {
    const result = await read();
    expect(result.program?.settings.pointsPerCurrencyUnit).toBe("1.0001");
    expect(result.program?.settings.liabilityPointsDenominator).toBe("100");
    expect(result.configurationRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.program).not.toHaveProperty("updatedAt");
    expect(result.program).not.toHaveProperty("earnPolicyVersion");
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope,
      permission: "loyalty.read",
    });
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(mocks.program.mock.calls[0][0].select).not.toHaveProperty(
      "metadata",
    );
  });

  it("represents a missing program without side effects", async () => {
    mocks.program.mockResolvedValue(null);
    expect(await read()).toMatchObject({
      program: null,
      configurationRevision: null,
    });
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it("uses a state fingerprint, not an unconditional write counter", async () => {
    const before = await read();
    const after = await update(before.configurationRevision, {
      name: "Loyalty",
    });
    expect(after.configurationRevision).toBe(before.configurationRevision);
    expect(mocks.writer).toHaveBeenCalledTimes(1);
  });

  it("keeps revisions stable when ORM property order changes", async () => {
    const before = await read();
    mocks.program.mockResolvedValue(
      Object.fromEntries(Object.entries(row()).reverse()),
    );
    expect((await read()).configurationRevision).toBe(
      before.configurationRevision,
    );
  });

  it("fences and writes using the same transaction and re-reads the published revision", async () => {
    const before = await read();
    mocks.writer.mockImplementation(async () => {
      mocks.program.mockResolvedValue({
        ...row(),
        name: "Updated",
        earnPolicyVersion: 6,
      });
    });
    const after = await update(before.configurationRevision, {
      name: "Updated",
    });
    expect(after.configurationRevision).not.toBe(before.configurationRevision);
    expect(after.program?.settings.name).toBe("Updated");
    expect(mocks.authorize).toHaveBeenLastCalledWith({
      tx,
      envelope,
      permission: "loyalty.configure",
    });
    expect(mocks.fence).toHaveBeenCalledWith({
      tx,
      storeId: "store-a",
      action: "loyalty_admin_settings_update",
      expectedInstallationGeneration: "g1",
    });
    expect(mocks.writer).toHaveBeenCalledWith(
      tx,
      "store-a",
      expect.objectContaining({ name: "Updated", expectedStatus: "draft" }),
    );
  });

  it("rejects an unchanged timestamp with a newer earning revision", async () => {
    const before = await read();
    mocks.program.mockResolvedValue({ ...row(), earnPolicyVersion: 6 });
    await expect(
      update(before.configurationRevision, { name: "Stale" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it.each([
    { status: "active" },
    { killSwitchActive: false },
    {
      liabilityValuationCurrency: null,
      liabilityMinorUnitsNumerator: null,
      liabilityPointsDenominator: null,
    },
  ])(
    "denies owner-only configuration to ordinary staff %#",
    async (settings) => {
      await expect(update("a".repeat(64), settings)).rejects.toMatchObject({
        code: "access_denied",
      });
      expect(mocks.writer).not.toHaveBeenCalled();
      expect(mocks.fence).not.toHaveBeenCalled();
    },
  );

  it("checks accounting currency even for owners", async () => {
    mocks.authorize.mockResolvedValue({ ...actor, owner: true });
    const before = await read();
    await expect(
      update(before.configurationRevision, {
        liabilityValuationCurrency: "USD",
        liabilityMinorUnitsNumerator: "1",
        liabilityPointsDenominator: "100",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it("passes exact owner valuation to the existing writer", async () => {
    mocks.authorize.mockResolvedValue({ ...actor, owner: true });
    const before = await read();
    await update(before.configurationRevision, {
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: "9223372036854775807",
      liabilityPointsDenominator: "100",
    });
    expect(mocks.writer).toHaveBeenCalledWith(
      tx,
      "store-a",
      expect.objectContaining({
        parsedLiabilityNumerator: BigInt("9223372036854775807"),
        parsedLiabilityDenominator: BigInt("100"),
        valuationFieldsPresent: true,
      }),
    );
  });

  it("rejects stale installations before touching configuration", async () => {
    await expect(
      update("a".repeat(64), { name: "Updated" }, "old"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it("does not read or write after staff authority is denied", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(read()).rejects.toThrow("denied");
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
  });

  it("rejects a mismatched workspace rather than adopting it", async () => {
    mocks.store.mockResolvedValue({
      projectId: "foreign",
      program: { accountingCurrency: "JPY" },
    });
    await expect(read()).rejects.toMatchObject({ code: "invalid_actor" });
    expect(mocks.program).not.toHaveBeenCalled();
  });

  it("does not retry an uncertain writer failure", async () => {
    const before = await read();
    mocks.writer.mockRejectedValue(new Error("connection lost"));
    await expect(
      update(before.configurationRevision, { name: "Updated" }),
    ).rejects.toThrow("connection lost");
    expect(mocks.writer).toHaveBeenCalledTimes(1);
  });
});
