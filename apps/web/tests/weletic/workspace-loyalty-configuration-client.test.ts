import { createWorkspaceLoyaltyConfigurationClient } from "@/lib/weletic/loyalty/workspace-configuration-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("workspace Loyalty configuration browser client", () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = () =>
    createWorkspaceLoyaltyConfigurationClient("workspace/a&b", fetcher);
  beforeEach(() => {
    vi.resetAllMocks();
    fetcher.mockImplementation(async () => Response.json(view));
  });
  afterEach(() => vi.useRealTimers());
  it.each(["fetch", "body"])(
    "bounds stalled %s without retrying",
    async (stage) => {
      vi.useFakeTimers();
      if (stage === "fetch")
        fetcher.mockImplementation(() => new Promise<Response>(() => {}));
      else {
        const response = Response.json(view);
        response.json = () => new Promise<unknown>(() => {});
        fetcher.mockResolvedValue(response);
      }
      const pending = expect(client().save(update)).rejects.toThrow(
        "uncertain",
      );
      await vi.advanceTimersByTimeAsync(8000);
      await pending;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
  it("uses an explicit encoded workspace, private cache and same-origin credentials", async () => {
    expect(await client().read()).toEqual(view);
    expect(await client().save(update)).toEqual(view);
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/weletic/loyalty-configuration?workspaceId=workspace%2Fa%26b",
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(update);
    expect(fetcher.mock.calls[1][1]?.method).toBe("PATCH");
  });
  it("rejects empty scope and invalid precision before sending", async () => {
    expect(() => createWorkspaceLoyaltyConfigurationClient(" ")).toThrow();
    await expect(
      client().save({
        ...update,
        settings: { pointsPerCurrencyUnit: "0.00001" },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains BigInt-sized valuation strings", async () => {
    const settings = {
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: "9223372036854775807",
      liabilityPointsDenominator: "100",
    };
    fetcher.mockResolvedValueOnce(
      Response.json({
        ...view,
        program: {
          ...view.program,
          settings: { ...view.program.settings, ...settings },
        },
      }),
    );
    await client().save({ ...update, settings });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).settings).toEqual(
      settings,
    );
  });
  it.each([401, 403, 409, 503])("does not retry HTTP %s", async (status) => {
    fetcher.mockResolvedValue(Response.json({ error: "rejected" }, { status }));
    await expect(client().save(update)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...view, installationGeneration: "old" },
    { ...view, program: null, configurationRevision: null },
    {
      ...view,
      program: {
        ...view.program,
        settings: { ...view.program.settings, pointsPerCurrencyUnit: "2" },
      },
    },
    { ...view, extra: "invalid" },
  ])(
    "rejects invalid or mismatched acknowledgements without retry",
    async (response) => {
      fetcher.mockResolvedValue(Response.json(response));
      await expect(client().save(update)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
