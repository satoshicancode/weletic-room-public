import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  nativeRead: vi.fn(),
  nativePublish: vi.fn(),
  upsert: vi.fn(),
  advance: vi.fn(),
  snapshot: vi.fn(),
  verify: vi.fn(),
  legacyRead: vi.fn(),
  legacyWrite: vi.fn(),
}));
const shop = "company.myshopify.com";
const store = {
  id: "store-1",
  projectId: "workspace-1",
  shopDomain: shop,
  complianceState: "active",
  installationGeneration: "generation-1",
};
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    weleticShopifyStore: { findUnique: vi.fn(async () => store) },
  },
}));
vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBody: (request: Request) => request.text(),
  verifyWeleticShopifyRequest: mocks.verify,
}));
vi.mock("@/lib/weletic/shopify/compliance-store-resolver", () => ({
  resolveComplianceShopifyStoreByDomain: vi.fn(async () => ({
    storeId: store.id,
    complianceState: "active",
  })),
}));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-lifecycle-fence")
  >()),
  lockShopifySessionLifecycle: vi.fn(async () => store),
}));
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: vi.fn(async () => ({
    state: "mapped",
    mappedStoreId: store.id,
  })),
}));
vi.mock("@/lib/weletic/shopify/store-owned-credential", () => ({
  readStoreOwnedShopifyCredential: mocks.nativeRead,
  publishStoreOwnedShopifyCredential: mocks.nativePublish,
}));
vi.mock("@/lib/weletic/shopify/session-coordination", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-coordination")
  >()),
  advanceShopifySessionRevision: mocks.advance,
  observeShopifySessionCoordination: vi.fn(async () => ({
    revision: "3",
    epoch: "2",
  })),
}));
vi.mock("@/lib/weletic/shopify/session-snapshot", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-snapshot")
  >()),
  readShopifySessionSnapshot: mocks.snapshot,
}));
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const observed = {
  epoch: "2",
  revision: "3",
  sessionDigest: hash("synthetic-session"),
  installationGeneration: store.installationGeneration,
  credentialTokenHash: hash("old-token"),
};
const lease = { token: "a".repeat(64), epoch: "2", revision: "3" };
function request({
  coordinated = true,
  expected = observed.credentialTokenHash,
}: { coordinated?: boolean; expected?: string | null } = {}) {
  return new Request("https://local.test/api/internal/shopify/sessions", {
    method: "POST",
    body: JSON.stringify({
      properties: [
        ["id", `offline_${shop}`],
        ["shop", shop],
        ["state", "synthetic"],
        ["isOnline", false],
        ["accessToken", "new-token"],
        ["scope", "read_orders"],
      ],
      expectedCredentialTokenHash: expected,
      ...(coordinated
        ? {
            coordination: {
              observed: { ...observed, credentialTokenHash: expected },
              lease,
            },
          }
        : {}),
    }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", "public-app");
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  mocks.verify.mockReturnValue(true);
  mocks.nativeRead.mockResolvedValue({
    revision: 7,
    accessToken: "old-token",
    scope: "read_orders",
  });
  mocks.nativePublish.mockResolvedValue({ revision: 8 });
  mocks.snapshot.mockResolvedValue({ observed, properties: null });
  mocks.advance.mockResolvedValue({
    ...lease,
    appId: "public-app",
    shop,
    revision: "4",
  });
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      weleticShopifyAppSession: { upsert: mocks.upsert },
      installedIntegration: {
        findMany: mocks.legacyRead,
        update: mocks.legacyWrite,
      },
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("public native credential session publication wiring", () => {
  it.each(["online", "tokenless", "offline"])(
    "rejects uncoordinated public %s writes",
    async (kind) => {
      const body = await request({ coordinated: false }).json();
      if (kind === "online")
        body.properties = [
          ["id", "online_new"],
          ["shop", shop],
          ["state", "synthetic"],
          ["isOnline", true],
          ["accessToken", "new-online-token"],
        ];
      if (kind === "tokenless")
        body.properties = body.properties.filter(
          ([key]: [string, unknown]) => key !== "accessToken",
        );
      const { POST } = await import(
        "../../app/api/internal/shopify/sessions/route"
      );
      const response = await POST(
        new Request("https://local.test/api/internal/shopify/sessions", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(409);
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.nativePublish).not.toHaveBeenCalled();
      expect(mocks.legacyRead).not.toHaveBeenCalled();
    },
  );
  it("publishes the native revision and SDK session in the same transaction without installer access", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.nativePublish).toHaveBeenCalledWith(expect.anything(), {
      identity: {
        appId: "public-app",
        shop,
        storeId: store.id,
        workspaceId: store.projectId,
        installationGeneration: store.installationGeneration,
      },
      expectedRevision: 7,
      material: { accessToken: "new-token", scope: "read_orders" },
    });
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(mocks.snapshot).toHaveBeenLastCalledWith(
      expect.anything(),
      { appId: "public-app", shop },
      store,
    );
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.legacyRead).not.toHaveBeenCalled();
    expect(mocks.legacyWrite).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("new-token");
  });
  it("creates a missing native credential only behind a matching coordinated observation", async () => {
    mocks.nativeRead.mockResolvedValue(null);
    mocks.snapshot.mockResolvedValue({
      observed: { ...observed, credentialTokenHash: null },
      properties: null,
    });
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    expect((await POST(request({ expected: null }))).status).toBe(200);
    expect(mocks.nativePublish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedRevision: null }),
    );
    expect(mocks.legacyRead).not.toHaveBeenCalled();
  });
  it("rejects stale native token authority before session or credential publication", async () => {
    mocks.nativeRead.mockResolvedValue({
      revision: 8,
      accessToken: "newer-token",
      scope: "read_orders",
    });
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    expect((await POST(request())).status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.nativePublish).not.toHaveBeenCalled();
    expect(mocks.legacyRead).not.toHaveBeenCalled();
  });
  it("does not acknowledge storage when native publication fails", async () => {
    mocks.nativePublish.mockRejectedValue(new Error("injected failure"));
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    expect((await POST(request())).status).toBe(500);
    expect(mocks.legacyWrite).not.toHaveBeenCalled();
  });
  it("rejects an unsigned request before opening a transaction", async () => {
    mocks.verify.mockReturnValue(false);
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    expect((await POST(request())).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
