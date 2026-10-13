import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordVerifiedAppProxyRoute } from "../app/app-proxy-observation.server";
const api = vi.hoisted(() => vi.fn());
vi.mock("../app/weletic-api.server", () => ({ weleticApiJson: api }));
const shop = "synthetic.myshopify.com";
const timestamp = Math.floor(Date.now() / 1000);
const url = `https://app.example/apps/proxy/reviews/write?shop=${shop}&path_prefix=%2Fapps%2Fweletic-1&timestamp=${timestamp}&signature=verified-by-sdk`;
beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue({});
  vi.stubEnv("SHOPIFY_API_KEY", "a".repeat(32));
});
afterEach(() => vi.unstubAllEnvs());
it("forwards only verified routing context without the shopper invitation token", async () => {
  await recordVerifiedAppProxyRoute(new Request(url), shop);
  expect(api).toHaveBeenCalledWith(
    "/api/internal/shopify/installation/proxy-route",
    {
      method: "POST",
      body: JSON.stringify({
        shop,
        appId: "a".repeat(32),
        pathPrefix: "/apps/weletic-1",
        timestamp,
      }),
      signal: expect.any(AbortSignal),
    },
  );
});
it("deduplicates successful observations for the same signed route", async () => {
  const uniqueShop = "dedupe.myshopify.com";
  const uniqueUrl = url.replaceAll(shop, uniqueShop);
  await recordVerifiedAppProxyRoute(new Request(uniqueUrl), uniqueShop);
  await recordVerifiedAppProxyRoute(new Request(uniqueUrl), uniqueShop);
  expect(api).toHaveBeenCalledTimes(1);
});
it("does not evict active dedupe entries when the bounded cache fills", async () => {
  const uniqueShop = (index: number) => `bounded-${index}.myshopify.com`;
  const uniqueUrl = (shopName: string) => url.replaceAll(shop, shopName);
  const firstShop = uniqueShop(0);
  const firstUrl = uniqueUrl(firstShop);
  for (let index = 0; index < 520; index++) {
    const currentShop = uniqueShop(index);
    await recordVerifiedAppProxyRoute(
      new Request(uniqueUrl(currentShop)),
      currentShop,
    );
  }
  const callCount = api.mock.calls.length;
  await recordVerifiedAppProxyRoute(new Request(firstUrl), firstShop);
  expect(api.mock.calls.length).toBe(callCount);
  expect(callCount).toBeLessThan(520);
});
it.each(["shop", "path_prefix", "timestamp", "signature"])(
  "rejects ambiguous %s",
  async (key) => {
    await expect(
      recordVerifiedAppProxyRoute(new Request(`${url}&${key}=other`), shop),
    ).rejects.toBeInstanceOf(Response);
    expect(api).not.toHaveBeenCalled();
  },
);
it("rejects absent or foreign SDK sessions", async () => {
  await expect(
    recordVerifiedAppProxyRoute(new Request(url), undefined),
  ).rejects.toBeInstanceOf(Response);
  await expect(
    recordVerifiedAppProxyRoute(new Request(url), "other.myshopify.com"),
  ).rejects.toBeInstanceOf(Response);
  expect(api).not.toHaveBeenCalled();
});
