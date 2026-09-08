import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantSettingsClient } from "../../../../packages/shopify-app/app/merchant-settings-client";

const view = {
  storeId: "store-a",
  installationGeneration: "g1",
  revision: 1,
  settings: {
    brandName: null,
    logoUrl: null,
    accentColor: null,
    defaultLocale: "en",
    timeZone: null,
    shopperEmailPaused: true,
  },
  branding: { name: "Weletic", source: "default" },
  modules: {
    loyalty: { status: "not_configured", killSwitchActive: false },
    reviews: { enabled: false, requestEmailEnabled: false, updatedAt: null },
  },
};
const update = {
  expectedRevision: 0,
  expectedInstallationGeneration: "g1",
  settings: { shopperEmailPaused: true },
};

describe("validated shared-settings browser client", () => {
  const token = vi.fn<() => Promise<string>>();
  const fetcher = vi.fn<typeof fetch>();
  const client = () => createMerchantSettingsClient(token, fetcher);
  beforeEach(() => {
    vi.resetAllMocks();
    token.mockResolvedValue("synthetic");
    fetcher.mockImplementation(async () => Response.json(view));
  });
  it("reads and saves with fresh tokens and no cookie/cache authority", async () => {
    token.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    expect(await client().read()).toEqual(view);
    expect(await client().save(update)).toEqual(view);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/merchant/settings",
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
    { ...view, credentials: "private" },
    { ...view, settings: { ...view.settings, providerToken: "private" } },
    {
      ...view,
      modules: {
        ...view.modules,
        reviews: { ...view.modules.reviews, enabled: "true" },
      },
    },
    { ...view, revision: -1 },
  ])("rejects unexpected response fields or types", async (response) => {
    fetcher.mockResolvedValue(Response.json(response));
    await expect(client().read()).rejects.toThrow("unavailable");
  });
  it.each([
    { ...view, revision: 2 },
    { ...view, installationGeneration: "replacement" },
    { ...view, settings: { ...view.settings, shopperEmailPaused: false } },
  ])("does not acknowledge an inconsistent write result", async (response) => {
    fetcher.mockResolvedValue(Response.json(response));
    await expect(client().save(update)).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("validates before obtaining authority or sending", async () => {
    await expect(
      client().save({ ...update, expectedRevision: -1 }),
    ).rejects.toThrow("invalid");
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates a review-only module result and preserves the typed request", async () => {
    const input = {
      enabled: false,
      expectedUpdatedAt: null,
      expectedInstallationGeneration: "g1",
    };
    const result = {
      storeId: "store-a",
      installationGeneration: "g1",
      settings: {
        enabled: false,
        requestEmailEnabled: true,
        updatedAt: new Date(0).toISOString(),
      },
    };
    fetcher.mockResolvedValue(Response.json(result));
    expect(await client().reviews(input)).toEqual(result);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      operation: "review-module",
      input,
    });
  });
  it("validates loyalty-only acknowledgements without clearing the kill switch", async () => {
    const input = {
      status: "active" as const,
      expectedStatus: "disabled" as const,
      expectedInstallationGeneration: "g1",
    };
    const result = {
      storeId: "store-a",
      installationGeneration: "g1",
      settings: { status: "active", killSwitchActive: true },
    };
    fetcher.mockResolvedValue(Response.json(result));
    expect(await client().loyalty(input)).toEqual(result);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      operation: "loyalty-module",
      input,
    });
    fetcher.mockResolvedValue(
      Response.json({
        ...result,
        settings: { ...result.settings, status: "disabled" },
      }),
    );
    await expect(client().loyalty(input)).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    {
      enabled: true,
      requestEmailEnabled: false,
      updatedAt: new Date(0).toISOString(),
    },
    { enabled: false, requestEmailEnabled: false, updatedAt: "invalid date" },
    {
      enabled: false,
      requestEmailEnabled: false,
      updatedAt: new Date(0).toISOString(),
      token: "private",
    },
  ])(
    "rejects malformed or inconsistent review module acknowledgements",
    async (settings) => {
      fetcher.mockResolvedValue(
        Response.json({
          storeId: "store-a",
          installationGeneration: "g1",
          settings,
        }),
      );
      await expect(
        client().reviews({
          enabled: false,
          expectedUpdatedAt: null,
          expectedInstallationGeneration: "g1",
        }),
      ).rejects.toThrow("unavailable");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it.each([401, 403, 409, 503])(
    "does not retry denied/uncertain status %s",
    async (status) => {
      fetcher.mockResolvedValue(new Response("private detail", { status }));
      await expect(client().save(update)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
});
