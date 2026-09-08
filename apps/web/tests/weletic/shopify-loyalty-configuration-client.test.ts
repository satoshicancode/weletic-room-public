import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantLoyaltyConfigurationClient } from "../../../../packages/shopify-app/app/merchant-loyalty-configuration-client";

const view = {
  storeId: "store-a",
  installationGeneration: "g1",
  accountingCurrency: "JPY",
  configurationRevision: "a".repeat(64),
  capabilities: { configure: true, owner: true },
  program: {
    id: "program-a",
    settings: {
      name: "Loyalty",
      status: "draft",
      pointNameSingular: "Point",
      pointNamePlural: "Points",
      pointsPerCurrencyUnit: "1.25",
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
      liabilityMinorUnitsNumerator: "1",
      liabilityPointsDenominator: "100",
    },
  },
};
const update = {
  expectedRevision: "a".repeat(64),
  expectedInstallationGeneration: "g1",
  settings: { pointsPerCurrencyUnit: "1.2500" },
};

describe("validated Loyalty configuration browser client", () => {
  const token = vi.fn<() => Promise<string>>();
  const fetcher = vi.fn<typeof fetch>();
  const client = () => createMerchantLoyaltyConfigurationClient(token, fetcher);
  beforeEach(() => {
    vi.resetAllMocks();
    token.mockResolvedValue("synthetic");
    fetcher.mockImplementation(async () => Response.json(view));
  });

  it("uses fresh tokens and private transport for reads and saves", async () => {
    token.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    expect(await client().read()).toEqual(view);
    expect(await client().save(update)).toEqual(view);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/merchant/loyalty-configuration",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer second" }),
      }),
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      operation: "update",
      input: update,
    });
    expect(token).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...view, metadata: {} },
    { ...view, configurationRevision: null },
    {
      ...view,
      program: {
        ...view.program,
        settings: { ...view.program.settings, pointsPerCurrencyUnit: 1.25 },
      },
    },
    {
      ...view,
      program: {
        ...view.program,
        settings: { ...view.program.settings, liabilityPointsDenominator: 100 },
      },
    },
  ])("rejects malformed or overbroad responses %#", async (value) => {
    fetcher.mockResolvedValue(Response.json(value));
    await expect(client().read()).rejects.toThrow("unavailable");
  });

  it.each([
    { ...view, installationGeneration: "replacement" },
    { ...view, program: null, configurationRevision: null },
    {
      ...view,
      program: {
        ...view.program,
        settings: { ...view.program.settings, pointsPerCurrencyUnit: "1.2501" },
      },
    },
  ])("never acknowledges an inconsistent save %#", async (value) => {
    fetcher.mockResolvedValue(Response.json(value));
    await expect(client().save(update)).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a financial integer mismatch", async () => {
    await expect(
      client().save({
        ...update,
        settings: {
          liabilityValuationCurrency: "JPY",
          liabilityMinorUnitsNumerator: "1",
          liabilityPointsDenominator: "101",
        },
      }),
    ).rejects.toThrow("unavailable");
  });

  it("validates before obtaining a token or making a request", async () => {
    await expect(
      client().save({
        ...update,
        settings: { pointsPerCurrencyUnit: "0.00001" },
      }),
    ).rejects.toThrow("invalid");
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
    fetcher.mockResolvedValue(Response.json({ error: "private" }, { status }));
    await expect(client().save(update)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous connection failure", async () => {
    fetcher.mockRejectedValue(new Error("lost response"));
    await expect(client().save(update)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
