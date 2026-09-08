import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = { findMany: vi.fn(), findUnique: vi.fn() };
const sessions = { findMany: vi.fn() };
const issues = { upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() };
const tx = { weleticShopifyStore: stores, weleticReconciliationIssue: issues };
const database = {
  weleticShopifyStore: stores,
  weleticShopifyAppSession: sessions,
  weleticReconciliationIssue: issues,
  $transaction: vi.fn(async (fn) => fn(tx)),
};
const lock = vi.fn();
const snapshot = vi.fn();
const credential = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-lifecycle-fence")
  >()),
  lockShopifySessionLifecycle: lock,
}));
vi.mock("@/lib/weletic/shopify/session-snapshot", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-snapshot")
  >()),
  readShopifySessionSnapshot: snapshot,
}));
vi.mock("@/lib/weletic/shopify/token-authority", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/shopify/token-authority")>()),
  fetchShopifyTokenAuthorityCredential: credential,
}));

const appId = "renewal-test";
const healthySnapshot = () => ({
  observed: {
    credentialTokenHash: createHash("sha256")
      .update("must-not-leave-worker")
      .digest("hex"),
    installationGeneration: "generation-1",
    sessionDigest: "b".repeat(64),
    revision: "1",
    epoch: "1",
  },
  properties: [["accessToken", "must-not-leave-worker"]],
});
const store = {
  id: "store-1",
  shopDomain: "renewal.myshopify.com",
  installationGeneration: "generation-1",
};
const input = () => ({
  appId,
  storeId: store.id,
  installationGeneration: "generation-1",
  scheduledAt: new Date().toISOString(),
});

describe("bounded scheduled Shopify session renewal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "1");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    vi.stubEnv("VERCEL", "");
    stores.findMany.mockResolvedValue([store]);
    stores.findUnique.mockResolvedValue(store);
    sessions.findMany.mockResolvedValue([]);
    lock.mockResolvedValue(store);
    snapshot.mockResolvedValue(healthySnapshot());
    issues.upsert.mockResolvedValue({});
    issues.updateMany.mockResolvedValue({ count: 1 });
    issues.findMany.mockResolvedValue([]);
    credential.mockResolvedValue({
      accessToken: "must-not-leave-worker",
      expiresAt: new Date(Date.now() + 3600_000),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is disabled by default before database or provider access", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "");
    const service = await import("@/lib/weletic/shopify/session-renewal");
    expect(await service.renewInstalledShopifySession(input())).toEqual({
      status: "disabled",
    });
    expect(
      await service.listDueShopifySessionRenewals({
        appId,
        scheduledAt: new Date().toISOString(),
      }),
    ).toEqual({ jobs: [], nextCursor: null });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(stores.findMany).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it("refuses activation with the development cron-auth bypass", async () => {
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "");
    const { renewInstalledShopifySession } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    await expect(renewInstalledShopifySession(input())).rejects.toThrow(
      "authenticated",
    );
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("queues due and absent offline sessions but excludes future, permanent and mismatched sessions", async () => {
    const variants = Array.from({ length: 5 }, (_, index) => ({
      ...store,
      id: `store-${index}`,
      shopDomain: `renewal-${index}.myshopify.com`,
    }));
    stores.findMany.mockResolvedValue(variants);
    const now = new Date();
    sessions.findMany.mockResolvedValue([
      {
        id: `offline_${variants[0].shopDomain}`,
        shop: variants[0].shopDomain,
        expiresAt: new Date(now.getTime() + 239_000),
      },
      {
        id: `offline_${variants[1].shopDomain}`,
        shop: variants[1].shopDomain,
        expiresAt: new Date(now.getTime() + 241_000),
      },
      {
        id: `offline_${variants[2].shopDomain}`,
        shop: variants[2].shopDomain,
        expiresAt: null,
      },
      {
        id: `offline_${variants[3].shopDomain}`,
        shop: "other.myshopify.com",
        expiresAt: new Date(0),
      },
    ]);
    const { listDueShopifySessionRenewals } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    const result = await listDueShopifySessionRenewals(
      { appId, scheduledAt: now.toISOString() },
      now,
    );
    expect(result.jobs.map((job) => job.storeId)).toEqual([
      "store-0",
      "store-4",
    ]);
    expect(JSON.stringify(result)).not.toContain("Token");
    expect(sessions.findMany.mock.calls[0][0].select).toEqual({
      id: true,
      shop: true,
      expiresAt: true,
    });
  });

  it("advances keyset progress even when a full page contains no due sessions", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...store,
      id: `store-${String(index).padStart(3, "0")}`,
      shopDomain: `renewal-${index}.myshopify.com`,
    }));
    stores.findMany.mockResolvedValue(rows);
    sessions.findMany.mockResolvedValue(
      rows.map((row) => ({
        id: `offline_${row.shopDomain}`,
        shop: row.shopDomain,
        expiresAt: null,
      })),
    );
    const { listDueShopifySessionRenewals } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    const result = await listDueShopifySessionRenewals({
      appId,
      scheduledAt: new Date().toISOString(),
      afterId: "previous",
    });
    expect(result).toEqual({ jobs: [], nextCursor: "store-099" });
    expect(stores.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        orderBy: { id: "asc" },
        where: expect.objectContaining({
          id: { gt: "previous" },
          complianceState: "active",
        }),
      }),
    );
  });

  it.each([null, new Date("2100-01-01T00:00:00Z")])(
    "reconciles open current-generation incidents even when session expiry is %s",
    async (expiresAt) => {
      sessions.findMany.mockResolvedValue([
        {
          id: `offline_${store.shopDomain}`,
          shop: store.shopDomain,
          expiresAt,
        },
      ]);
      issues.findMany.mockResolvedValue([{ storeId: store.id }]);
      const { listDueShopifySessionRenewals } = await import(
        "@/lib/weletic/shopify/session-renewal"
      );
      const page = await listDueShopifySessionRenewals({
        appId,
        scheduledAt: new Date().toISOString(),
      });
      expect(page.jobs).toHaveLength(1);
      expect(issues.findMany).toHaveBeenCalledWith({
        where: {
          kind: "shopify_session_missing",
          status: "open",
          OR: [{ storeId: store.id, externalKey: "generation-1" }],
        },
        select: { storeId: true },
      });
    },
  );

  it.each(["foreign-app", "expired", "future"])(
    "discards %s jobs before accessing an installation",
    async (kind) => {
      const job = input();
      if (kind === "foreign-app") job.appId = "other-app";
      else
        job.scheduledAt = new Date(
          Date.now() + (kind === "expired" ? -16 * 60_000 : 2 * 60_000),
        ).toISOString();
      const { renewInstalledShopifySession } = await import(
        "@/lib/weletic/shopify/session-renewal"
      );
      expect(await renewInstalledShopifySession(job)).toEqual({
        status: "stale",
      });
      expect(database.$transaction).not.toHaveBeenCalled();
    },
  );

  it("passes the original generation to the authority and never returns the credential", async () => {
    const { renewInstalledShopifySession } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    const result = await renewInstalledShopifySession(input());
    expect(credential).toHaveBeenCalledWith({
      shopDomain: store.shopDomain,
      installationGeneration: "generation-1",
    });
    expect(result.status).toBe("healthy");
    expect(JSON.stringify(result)).not.toContain("must-not-leave-worker");
    expect(lock).toHaveBeenCalledWith({
      tx,
      shop: store.shopDomain,
      storeId: store.id,
    });
  });

  it.each(["missing-store", "new-generation", "missing-projection"])(
    "skips %s without a provider request",
    async (kind) => {
      if (kind === "missing-store") stores.findUnique.mockResolvedValue(null);
      if (kind === "new-generation")
        lock.mockResolvedValue({
          ...store,
          installationGeneration: "generation-2",
        });
      if (kind === "missing-projection")
        snapshot.mockResolvedValue({ observed: { credentialTokenHash: null } });
      const { renewInstalledShopifySession } = await import(
        "@/lib/weletic/shopify/session-renewal"
      );
      expect(await renewInstalledShopifySession(input())).toEqual({
        status: "stale",
      });
      expect(credential).not.toHaveBeenCalled();
    },
  );

  it("retries safe temporary failures without leaking their text", async () => {
    credential.mockRejectedValue(new Error("secret-provider-detail"));
    const { renewInstalledShopifySession } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    await expect(renewInstalledShopifySession(input())).rejects.toThrow(
      "Shopify session renewal temporarily unavailable",
    );
    expect(issues.upsert).not.toHaveBeenCalled();
    expect(issues.updateMany).not.toHaveBeenCalled();
  });

  it("durably records only confirmed missing sessions with a generation-scoped identity", async () => {
    const { ShopifyTokenAuthorityError } = await import(
      "@/lib/weletic/shopify/token-authority"
    );
    credential.mockRejectedValue(
      new ShopifyTokenAuthorityError("AUTH_EXPIRED", "private-error-detail"),
    );
    snapshot.mockResolvedValue({ ...healthySnapshot(), properties: null });
    const { renewInstalledShopifySession } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    expect(await renewInstalledShopifySession(input())).toEqual({
      status: "reconnect_required",
    });
    const upsert = issues.upsert.mock.calls[0][0];
    expect(upsert.where.storeId_kind_externalKey).toEqual({
      storeId: store.id,
      kind: "shopify_session_missing",
      externalKey: "generation-1",
    });
    expect(upsert.create.details).toEqual({ reason: "session_missing", appId });
    expect(JSON.stringify(upsert)).not.toMatch(
      /private-error-detail|must-not-leave-worker|credentialTokenHash/,
    );
    expect(issues.updateMany).not.toHaveBeenCalled();
  });

  it.each(["new-generation", "new-revision", "new-session"])(
    "ignores a delayed missing result after %s",
    async (change) => {
      const { ShopifyTokenAuthorityError } = await import(
        "@/lib/weletic/shopify/token-authority"
      );
      credential.mockRejectedValue(
        new ShopifyTokenAuthorityError("AUTH_EXPIRED", "missing"),
      );
      snapshot.mockResolvedValueOnce({
        ...healthySnapshot(),
        properties: null,
      });
      if (change === "new-generation") {
        lock.mockResolvedValueOnce(store).mockResolvedValue({
          ...store,
          installationGeneration: "generation-2",
        });
      } else if (change === "new-revision") {
        snapshot.mockResolvedValue({
          ...healthySnapshot(),
          properties: null,
          observed: { ...healthySnapshot().observed, revision: "2" },
        });
      }
      const { renewInstalledShopifySession } = await import(
        "@/lib/weletic/shopify/session-renewal"
      );
      expect(await renewInstalledShopifySession(input())).toEqual({
        status: "stale",
      });
      expect(issues.upsert).not.toHaveBeenCalled();
    },
  );

  it("resolves only the original generation after confirming the current SDK and installed credential", async () => {
    const { renewInstalledShopifySession } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    expect((await renewInstalledShopifySession(input())).status).toBe(
      "healthy",
    );
    expect(issues.updateMany).toHaveBeenCalledWith({
      where: {
        storeId: store.id,
        kind: "shopify_session_missing",
        externalKey: "generation-1",
        status: "open",
      },
      data: { status: "resolved", resolvedAt: expect.any(Date) },
    });
    expect(issues.upsert).not.toHaveBeenCalled();
  });

  it.each(["missing-session", "changed-credential", "expired-result"])(
    "does not clear an incident after %s",
    async (change) => {
      snapshot.mockResolvedValueOnce(healthySnapshot());
      if (change === "missing-session")
        snapshot.mockResolvedValue({ ...healthySnapshot(), properties: null });
      if (change === "changed-credential")
        snapshot.mockResolvedValue({
          ...healthySnapshot(),
          observed: {
            ...healthySnapshot().observed,
            credentialTokenHash: "a".repeat(64),
          },
        });
      if (change === "expired-result")
        credential.mockResolvedValue({
          accessToken: "must-not-leave-worker",
          expiresAt: new Date(0),
        });
      const { renewInstalledShopifySession } = await import(
        "@/lib/weletic/shopify/session-renewal"
      );
      expect(await renewInstalledShopifySession(input())).toEqual({
        status: "stale",
      });
      expect(issues.updateMany).not.toHaveBeenCalled();
    },
  );

  it("retries incident persistence failures rather than acknowledging a lost alert", async () => {
    const { ShopifyTokenAuthorityError } = await import(
      "@/lib/weletic/shopify/token-authority"
    );
    credential.mockRejectedValue(
      new ShopifyTokenAuthorityError("AUTH_EXPIRED", "missing"),
    );
    snapshot.mockResolvedValue({ ...healthySnapshot(), properties: null });
    issues.upsert.mockRejectedValue(new Error("private-sql-detail"));
    const { renewInstalledShopifySession } = await import(
      "@/lib/weletic/shopify/session-renewal"
    );
    await expect(renewInstalledShopifySession(input())).rejects.toThrow(
      "Shopify session renewal temporarily unavailable",
    );
  });
});
