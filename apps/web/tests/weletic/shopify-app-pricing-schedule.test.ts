import {
  listSubscriptionRefreshPage,
  refreshScheduledSubscription,
} from "@/lib/weletic/shopify/app-pricing-schedule";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  stores: vi.fn(),
  snapshot: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findFirst: mocks.store, findMany: mocks.stores },
    weleticShopifySubscriptionSnapshot: { findFirst: mocks.snapshot },
  },
}));
vi.mock("@/lib/weletic/shopify/app-pricing-service", () => ({
  reconcileSubscribedInstallation: mocks.refresh,
}));
const now = new Date("2026-09-26T00:00:00Z");
const input = {
  appId: "public-app",
  scheduledAt: now.toISOString(),
  storeId: "store",
  installationGeneration: "g1",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
  vi.stubEnv("SHOPIFY_API_KEY", "public-app");
  mocks.store.mockResolvedValue({
    shopDomain: "company.myshopify.com",
    pendingInstallation: { id: "pending" },
  });
  mocks.snapshot.mockResolvedValue({
    status: "paid",
    validUntil: new Date(now.getTime() + 300000),
  });
  mocks.refresh.mockResolvedValue({ status: "paid" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("refreshes ahead of expiry despite provider latency and scheduler jitter", async () => {
  await refreshScheduledSubscription(input);
  expect(mocks.refresh).not.toHaveBeenCalled();
  vi.setSystemTime(new Date(now.getTime() + 240000 + 15000));
  await refreshScheduledSubscription(input);
  expect(mocks.refresh).toHaveBeenCalledWith(
    "company.myshopify.com",
    fetch,
    "g1",
  );
  // At this start, 45 seconds remain for the bounded provider request/commit.
});
it("does not touch foreign, stale or retired installation jobs", async () => {
  await refreshScheduledSubscription({ ...input, appId: "foreign" });
  expect(mocks.store).not.toHaveBeenCalled();
  await refreshScheduledSubscription({
    ...input,
    scheduledAt: new Date(now.getTime() - 600000).toISOString(),
  });
  expect(mocks.store).not.toHaveBeenCalled();
  mocks.store.mockResolvedValue(null);
  await refreshScheduledSubscription(input);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("returns pagination by scanned current installations", async () => {
  mocks.stores.mockResolvedValue(
    Array.from({ length: 100 }, (_, i) => ({
      id: `store-${String(i).padStart(3, "0")}`,
      installationGeneration: "g1",
    })),
  );
  const page = await listSubscriptionRefreshPage({
    appId: input.appId,
    scheduledAt: input.scheduledAt,
  });
  expect(page.jobs).toHaveLength(100);
  expect(page.nextCursor).toBe("store-099");
  expect(mocks.stores).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        pendingInstallation: { is: { appId: "public-app", state: "mapped" } },
      }),
    }),
  );
});
it("retries an unavailable provider rather than treating it as successful maintenance", async () => {
  mocks.snapshot.mockResolvedValue(null);
  mocks.refresh.mockResolvedValue({ status: "unavailable" });
  await expect(refreshScheduledSubscription(input)).rejects.toThrow(
    "unavailable",
  );
});
