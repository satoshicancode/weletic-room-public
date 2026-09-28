import {
  appProxyObservationSchema,
  appProxyPathSchema,
  assertFreshAppProxyTimestamp,
} from "@/lib/weletic/shopify/app-proxy-contract";
import {
  observeAppProxyRoute,
  readReviewInvitationPath,
} from "@/lib/weletic/shopify/app-proxy-route";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  generation: "generation-a" as string | null,
  tx: {
    $queryRaw: vi.fn(),
    weleticShopifyPendingInstallation: { findUnique: vi.fn() },
    weleticShopifyStore: { findUniqueOrThrow: vi.fn() },
    weleticShopifyAppProxyRoute: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: async (
    _id: string,
    fn: (tx: unknown, generation: string | null) => unknown,
  ) => fn(state.tx, state.generation),
}));
const now = new Date("2026-09-28T03:00:00Z");
const input = {
  shop: "synthetic.myshopify.com",
  appId: "a".repeat(32),
  pathPrefix: "/apps/weletic-1",
  timestamp: now.getTime() / 1000 - 1,
};
const installation = {
  appId: input.appId,
  state: "mapped",
  installationGeneration: "generation-a",
  authenticatedAt: new Date(now.getTime() - 120000),
  uninstalledAt: null,
  redactedAt: null,
};
const tx = state.tx as unknown as Prisma.TransactionClient;
beforeEach(() => {
  vi.resetAllMocks();
  state.generation = "generation-a";
  vi.stubEnv("SHOPIFY_API_KEY", input.appId);
  state.tx.$queryRaw.mockResolvedValue([{ now }]);
  state.tx.weleticShopifyPendingInstallation.findUnique.mockResolvedValue(
    installation,
  );
  state.tx.weleticShopifyStore.findUniqueOrThrow.mockResolvedValue({
    shopDomain: input.shop,
  });
  state.tx.weleticShopifyAppProxyRoute.findUnique.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("installation-bound proxy route", () => {
  it.each([
    "/apps/x?next=evil",
    "//evil.test/x",
    "/apps/../x",
    "/apps/a%2fb",
    "/apps/a#x",
    "/apps/a/b",
    "https://evil.test",
    "/apps/",
    "/apps/é",
  ])("rejects unsafe prefix %s", (path) => {
    expect(appProxyPathSchema.safeParse(path).success).toBe(false);
  });
  it("rejects duplicate/extra authority and stale or future timestamps", () => {
    expect(
      appProxyObservationSchema.safeParse({ ...input, generation: "forged" })
        .success,
    ).toBe(false);
    expect(() =>
      assertFreshAppProxyTimestamp(input.timestamp - 61, now),
    ).toThrow();
    expect(() =>
      assertFreshAppProxyTimestamp(input.timestamp + 2, now),
    ).toThrow();
  });
  it("records the observed suffix instead of assuming the manifest path", async () => {
    await observeAppProxyRoute("store-a", input);
    expect(state.tx.weleticShopifyAppProxyRoute.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          storeId: "store-a",
          appId: input.appId,
          installationGeneration: "generation-a",
          pathPrefix: "/apps/weletic-1",
        }),
      }),
    );
  });
  it("records a signed app route for an active legacy installation without a generation", async () => {
    state.generation = null;
    state.tx.weleticShopifyPendingInstallation.findUnique.mockResolvedValue(
      null,
    );
    await observeAppProxyRoute("store-a", input);
    expect(state.tx.weleticShopifyAppProxyRoute.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          installationGeneration: null,
          pathPrefix: input.pathPrefix,
        }),
      }),
    );
  });
  it.each([
    { appId: "b".repeat(32) },
    { installationGeneration: "other-generation" },
    { state: "uninstalled" },
    { redactedAt: now },
    { authenticatedAt: new Date(input.timestamp * 1000) },
  ])("rejects stale installation identity %j", async (patch) => {
    state.tx.weleticShopifyPendingInstallation.findUnique.mockResolvedValue({
      ...installation,
      ...patch,
    });
    await expect(observeAppProxyRoute("store-a", input)).rejects.toThrow();
    expect(state.tx.weleticShopifyAppProxyRoute.upsert).not.toHaveBeenCalled();
  });
  it("rejects cross-store domain and cross-app observations", async () => {
    await expect(
      observeAppProxyRoute("store-a", {
        ...input,
        shop: "other.myshopify.com",
      }),
    ).rejects.toThrow();
    await expect(
      observeAppProxyRoute("store-a", { ...input, appId: "b".repeat(32) }),
    ).rejects.toThrow();
    expect(state.tx.weleticShopifyAppProxyRoute.upsert).not.toHaveBeenCalled();
  });
  it("does not overwrite a newer path and rejects conflicting same-second observations", async () => {
    state.tx.weleticShopifyAppProxyRoute.findUnique.mockResolvedValue({
      installationGeneration: state.generation,
      observedAt: now,
      pathPrefix: "/tools/new",
    });
    await expect(observeAppProxyRoute("store-a", input)).resolves.toEqual({
      recorded: false,
    });
    await expect(
      observeAppProxyRoute("store-a", {
        ...input,
        timestamp: now.getTime() / 1000,
      }),
    ).rejects.toThrow("Conflicting");
    expect(state.tx.weleticShopifyAppProxyRoute.upsert).not.toHaveBeenCalled();
  });
  it("does not rewrite an unchanged route on repeated public visits", async () => {
    state.tx.weleticShopifyAppProxyRoute.findUnique.mockResolvedValue({
      installationGeneration: state.generation,
      observedAt: new Date(input.timestamp * 1000 - 1000),
      pathPrefix: input.pathPrefix,
    });
    await expect(observeAppProxyRoute("store-a", input)).resolves.toEqual({
      recorded: false,
    });
    expect(state.tx.weleticShopifyAppProxyRoute.upsert).not.toHaveBeenCalled();
  });
  it("requires a verified current-generation route for new invitations", async () => {
    await expect(
      readReviewInvitationPath(tx, "legacy-store", null),
    ).rejects.toThrow("verification");
    await expect(
      readReviewInvitationPath(tx, "store-a", state.generation),
    ).rejects.toThrow("verification");
    state.tx.weleticShopifyAppProxyRoute.findUnique.mockResolvedValue({
      installationGeneration: "retired",
      pathPrefix: "/apps/weletic-1",
    });
    await expect(
      readReviewInvitationPath(tx, "store-a", state.generation),
    ).rejects.toThrow("verification");
    state.tx.weleticShopifyAppProxyRoute.findUnique.mockResolvedValue({
      installationGeneration: state.generation,
      pathPrefix: "/apps/weletic-1",
    });
    await expect(
      readReviewInvitationPath(tx, "store-a", state.generation),
    ).resolves.toBe("/apps/weletic-1");
    state.tx.weleticShopifyAppProxyRoute.findUnique.mockResolvedValue({
      installationGeneration: null,
      pathPrefix: "/community/weletic",
    });
    await expect(
      readReviewInvitationPath(tx, "legacy-store", null),
    ).resolves.toBe("/community/weletic");
  });
});
