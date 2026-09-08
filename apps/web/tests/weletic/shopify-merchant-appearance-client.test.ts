import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantAppearanceClient } from "../../../../packages/shopify-app/app/merchant-settings-client";

describe("appearance-only browser contract", () => {
  const fetcher = vi.fn<typeof fetch>();
  const token = vi.fn(async () => "synthetic");
  const view = {
    storeId: "store-a",
    installationGeneration: "g1",
    revision: 1,
    settings: { brandName: "Brand", logoUrl: null, accentColor: "#abcdef" },
    branding: { name: "Brand", source: "merchant" },
  };
  const input = {
    expectedRevision: 0,
    expectedInstallationGeneration: "g1",
    settings: { accentColor: "#ABCDEF" },
  };
  const client = () => createMerchantAppearanceClient(token, fetcher);
  beforeEach(() => {
    vi.clearAllMocks();
    fetcher.mockImplementation(async () => Response.json(view));
  });
  it("uses fresh tokens and strictly normalized appearance operations", async () => {
    expect(await client().read()).toEqual(view);
    expect(await client().save(input)).toEqual(view);
    expect(token).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      operation: "appearance-read",
      input: {},
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      operation: "appearance-update",
      input: { ...input, settings: { accentColor: "#abcdef" } },
    });
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
    });
  });
  it.each([
    { shopperEmailPaused: false },
    { defaultLocale: "ja" },
    { timeZone: "UTC" },
    {},
  ])(
    "rejects non-appearance or empty writes before authentication",
    async (settings) => {
      await expect(
        client().save({
          ...input,
          settings: { brandName: undefined, ...settings },
        }),
      ).rejects.toThrow("invalid");
      expect(token).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...view, modules: {} },
    { ...view, settings: { ...view.settings, shopperEmailPaused: false } },
    { ...view, revision: 0 },
    { ...view, installationGeneration: "old" },
    { ...view, settings: { ...view.settings, accentColor: "#123456" } },
  ])(
    "rejects overbroad or inconsistent acknowledgements without retries",
    async (response) => {
      fetcher.mockResolvedValue(Response.json(response));
      await expect(client().save(input)).rejects.toThrow("unavailable");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});
