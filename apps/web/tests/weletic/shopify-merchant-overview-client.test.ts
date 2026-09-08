import { describe, expect, it, vi } from "vitest";
import { createMerchantOverviewClient } from "../../../../packages/shopify-app/app/merchant-overview-client";

const overview = {
  shop: "fixture.myshopify.com",
  canManageStaff: false,
  catalog: {
    products: 2,
    markets: 1,
    syncStatus: "succeeded",
    lastSyncAt: "2026-09-07T00:00:00.000Z",
  },
};
describe("native merchant overview client", () => {
  it("uses a fresh bearer for each read without cookie or caller-selected shop", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(overview));
    const read = createMerchantOverviewClient(token, transport);
    await expect(read()).resolves.toEqual(overview);
    await read();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]).toEqual([
      "/api/merchant/overview",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: "{}",
        headers: {
          Authorization: "Bearer first",
          "Content-Type": "application/json",
        },
      }),
    ]);
    expect(transport.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer second",
    });
  });
  it.each([
    { ...overview, canManageStaff: "true" },
    { ...overview, shop: "https://other.invalid" },
    { ...overview, partnerLinks: [] },
    { ...overview, catalog: { ...overview.catalog, products: -1 } },
    { ...overview, catalog: { ...overview.catalog, syncStatus: "unknown" } },
    { ...overview, catalog: { ...overview.catalog, lastSyncAt: "not-a-date" } },
  ])("rejects malformed or expanded projections", async (data) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(data));
    await expect(
      createMerchantOverviewClient(async () => "token", transport)(),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, "reauthenticate"],
    [403, "denied"],
    [503, "unavailable"],
  ])("does not fall back after HTTP %s", async (status, code) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("private error", { status: Number(status) }),
      );
    await expect(
      createMerchantOverviewClient(async () => "token", transport)(),
    ).rejects.toMatchObject({ code, message: code });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
