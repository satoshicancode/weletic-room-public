import { PrismaClient, type Prisma } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ShopifySessionMutationFence,
  ShopifySessionSnapshot,
} from "../../lib/weletic/shopify/session-contract";

const database = new PrismaClient();
const fixtures: Array<{
  id: string;
  shop: string;
  projectId: string;
  installationId: string;
}> = [];
const key = randomBytes(32).toString("hex");
const serviceSecret = randomBytes(32).toString("hex");
let safeToClean = false;
vi.mock("@/lib/prisma", () => ({ prisma: database }));
// Stable test HMAC identity; the production resolver, tombstone SQL and
// lifecycle/store locks still run against real MySQL, not mocked transactions.
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: ({
    shopDomain,
  }: {
    shopDomain: string;
  }) => [
    {
      identityKeyId: "session-boundary-test",
      shopDomainDigest: createHash("sha256").update(shopDomain).digest("hex"),
    },
  ],
}));

describe("signed session API boundaries with real MySQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.SHOPIFY_SESSION_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.username !== "loyalty_dev" ||
      url.pathname !== "/weletic_loyalty_dev"
    )
      throw new Error("Refusing non-isolated session boundary database");
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
    safeToClean = true;
    vi.stubEnv("SHOPIFY_API_KEY", "session-boundary-test");
    vi.stubEnv("ENCRYPTION_KEY", key);
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External network forbidden in database tests");
      }),
    );
  });
  afterAll(async () => {
    if (safeToClean) {
      const ids = fixtures.map((fixture) => fixture.id);
      const shops = fixtures.map((fixture) => fixture.shop);
      await database.weleticReconciliationIssue.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopifyAppSession.deleteMany({
        where: {
          id: {
            in: shops.flatMap((shop) => [`offline_${shop}`, `${shop}_123`]),
          },
        },
      });
      await database.weleticShopifySessionCoordination.deleteMany({
        where: { appId: "session-boundary-test", shop: { in: shops } },
      });
      await database.weleticShopifyShopPrivacyTombstone.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.installedIntegration.deleteMany({
        where: {
          id: { in: fixtures.map((fixture) => fixture.installationId) },
        },
      });
      await database.weleticShopifyStore.deleteMany({
        where: { id: { in: ids } },
      });
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  });

  async function seed() {
    const suffix = randomUUID();
    const fixture = {
      id: `stest_${suffix}`,
      shop: `boundary-${suffix}.myshopify.com`,
      projectId: `sproject_${suffix}`,
      installationId: `sinstall_${suffix}`,
    };
    fixtures.push(fixture);
    const { encrypt } = await import("../../lib/encryption");
    const { SHOPIFY_INTEGRATION_ID } = await import("@dub/utils");
    // The schema uses relationMode=prisma. These deliberately minimal fixtures
    // reference only generated, otherwise-unused IDs; no merchant row is reused.
    await database.weleticShopifyStore.create({
      data: {
        storeAccessState: "active",
        ...{ id: fixture.id, projectId: fixture.projectId },
        programId: `sprogram_${suffix}`,
        shopDomain: fixture.shop,
        shopCurrency: "JPY",
        apiVersion: "2026-07",
        installationGeneration: "generation-1",
      },
    });
    await database.installedIntegration.create({
      data: {
        id: fixture.installationId,
        projectId: fixture.projectId,
        userId: `suser_${suffix}`,
        integrationId: SHOPIFY_INTEGRATION_ID,
        credentials: {
          shop: fixture.shop,
          accessToken: encrypt("synthetic-old-token"),
          installationGeneration: "generation-1",
        },
      },
    });
    await database.weleticShopifyAppSession.create({
      data: {
        id: `offline_${fixture.shop}`,
        shop: fixture.shop,
        isOnline: false,
        payload: encrypt(
          JSON.stringify(properties(fixture.shop, "synthetic-old-token")),
        ),
      },
    });
    return fixture;
  }
  function properties(shop: string, token?: string) {
    return [
      ["id", `offline_${shop}`],
      ["shop", shop],
      ["state", ""],
      ["isOnline", false],
      ...(token ? [["accessToken", token]] : []),
    ];
  }
  async function request(path: string, method = "GET", data?: unknown) {
    const body = data === undefined ? "" : JSON.stringify(data);
    const timestamp = String(Date.now());
    const { signWeleticShopifyRequest } = await import(
      "../../lib/weletic/shopify/service-auth"
    );
    return new Request(`https://session-boundary.invalid${path}`, {
      method,
      ...(body ? { body } : {}),
      headers: {
        "x-weletic-timestamp": timestamp,
        "x-weletic-signature": signWeleticShopifyRequest({
          timestamp,
          method,
          path,
          body,
          secret: serviceSecret,
        }),
      },
    });
  }
  const coordinationPath = "/api/internal/shopify/sessions/coordination";
  const mutationPath = "/api/internal/shopify/sessions/coordinated";
  async function observe(shop: string) {
    const route = await import(
      "../../app/api/internal/shopify/sessions/coordination/route"
    );
    return route.GET(await request(`${coordinationPath}?shop=${shop}`));
  }
  async function acquire(shop: string): Promise<ShopifySessionMutationFence> {
    const snapshotResponse = await observe(shop);
    expect(snapshotResponse.status).toBe(200);
    const snapshot: ShopifySessionSnapshot = await snapshotResponse.json();
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/coordination/route"
    );
    const response = await POST(
      await request(coordinationPath, "POST", {
        action: "acquire",
        shop,
        token: randomBytes(32).toString("hex"),
        observed: snapshot.observed,
      }),
    );
    expect(response.status).toBe(200);
    return {
      lease: (await response.json()).lease,
      observed: snapshot.observed,
    };
  }
  async function publish(
    shop: string,
    coordination: ShopifySessionMutationFence,
    token?: string,
  ) {
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/coordinated/route"
    );
    return POST(
      await request(mutationPath, "POST", {
        properties: properties(shop, token),
        expectedCredentialTokenHash: coordination.observed.credentialTokenHash,
        coordination,
      }),
    );
  }

  it("authenticates before accessing the database and keeps credentials noncacheable", async () => {
    const { GET } = await import(
      "../../app/api/internal/shopify/sessions/coordination/route"
    );
    const response = await GET(
      new Request(
        `https://session-boundary.invalid${coordinationPath}?shop=unused.myshopify.com`,
      ),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("persists narrower online scopes through signed SQL boundaries without changing offline credentials", async () => {
    const fixture = await seed();
    const { GET, POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const { deserializeShopifySession } = await import(
      "../../../../packages/shopify-app/app/session-properties.server"
    );
    const offline = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${fixture.shop}` },
    });
    const installation = await database.installedIntegration.findUniqueOrThrow({
      where: { id: fixture.installationId },
    });
    const sessionId = `${fixture.shop}_123`;
    const saved = [
      ["id", sessionId],
      ["shop", fixture.shop],
      ["state", ""],
      ["isOnline", true],
      ["userId", 123],
      ["accountOwner", false],
      ["collaborator", false],
      ["scope", "read_products,write_discounts"],
      ["associatedUserScope", "read_products"],
      ["accessToken", "synthetic-online-token"],
      ["expires", Date.now() + 60_000],
    ];
    const path = "/api/internal/shopify/sessions";
    expect(
      (await POST(await request(path, "POST", { properties: saved }))).status,
    ).toBe(200);
    const response = await GET(await request(`${path}?id=${sessionId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const restored = deserializeShopifySession(
      (await response.json()).sessions[0].properties,
    )!;
    expect(restored.onlineAccessInfo?.associated_user_scope).toBe(
      "read_products",
    );
    expect(restored.onlineAccessInfo?.associated_user.account_owner).toBe(
      false,
    );
    const row = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.payload).not.toContain("synthetic-online-token");
    const malformed = saved.map(([key, value]) => [
      key,
      key === "accountOwner" ? "false" : value,
    ]);
    expect(
      (await POST(await request(path, "POST", { properties: malformed })))
        .status,
    ).toBe(400);
    expect(
      await database.weleticShopifyAppSession.findUnique({
        where: { id: sessionId },
      }),
    ).toEqual(row);
    expect(
      await database.weleticShopifyAppSession.findUnique({
        where: { id: offline.id },
      }),
    ).toEqual(offline);
    expect(
      await database.installedIntegration.findUnique({
        where: { id: installation.id },
      }),
    ).toEqual(installation);
  });

  it("publishes an encrypted original-installation binding without changing offline authority", async () => {
    const fixture = await seed();
    const original = await acquire(fixture.shop);
    const { GET, POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const before = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${fixture.shop}` },
    });
    const projection = await database.installedIntegration.findUniqueOrThrow({
      where: { id: fixture.installationId },
    });
    const path = "/api/internal/shopify/sessions";
    const onlineProperties = [
      ["id", `${fixture.shop}_123`],
      ["shop", fixture.shop],
      ["state", ""],
      ["isOnline", true],
      ["userId", 123],
      ["accountOwner", true],
      ["collaborator", false],
      ["associatedUserScope", "read_products"],
      ["expires", Date.now() + 60_000],
      ["accessToken", "synthetic-online-token"],
    ];
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties,
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(200);
    const response = await GET(await request(`${path}?id=${fixture.shop}_123`));
    expect(await response.json()).toEqual({
      sessions: [
        {
          properties: onlineProperties,
          onlineDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          onlineBinding: {
            appId: "session-boundary-test",
            shop: fixture.shop,
            storeId: fixture.id,
            installationGeneration: "generation-1",
          },
        },
      ],
    });
    expect(
      await database.weleticShopifyAppSession.findUniqueOrThrow({
        where: { id: before.id },
      }),
    ).toEqual(before);
    expect(
      await database.installedIntegration.findUniqueOrThrow({
        where: { id: projection.id },
      }),
    ).toEqual(projection);
    const after = await observe(fixture.shop);
    expect((await after.json()).observed.revision).toBe(
      original.observed.revision,
    );
    const savedRow = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `${fixture.shop}_123` },
    });
    expect(
      (
        await POST(
          await request(path, "POST", { properties: onlineProperties }),
        )
      ).status,
    ).toBe(409);
    expect(
      await database.weleticShopifyAppSession.findUniqueOrThrow({
        where: { id: savedRow.id },
      }),
    ).toEqual(savedRow);
    for (const lease of [
      { ...original.lease, token: randomBytes(32).toString("hex") },
      {
        ...original.lease,
        epoch: String(BigInt(original.lease.epoch) + BigInt(1)),
      },
    ]) {
      expect(
        (
          await POST(
            await request(path, "POST", {
              properties: onlineProperties,
              onlineCoordination: { ...original, lease },
            }),
          )
        ).status,
      ).toBe(409);
      expect(
        await database.weleticShopifyAppSession.findUniqueOrThrow({
          where: { id: savedRow.id },
        }),
      ).toEqual(savedRow);
    }
    const leaseBeforeMalformed =
      await database.weleticShopifySessionCoordination.findFirstOrThrow({
        where: { shop: fixture.shop },
      });
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties.map(([key, value]) => [
              key,
              key === "id" ? `${fixture.shop}_124` : value,
            ]),
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      await database.weleticShopifySessionCoordination.findFirstOrThrow({
        where: { shop: fixture.shop },
      }),
    ).toEqual(leaseBeforeMalformed);
    expect(
      await database.weleticShopifyAppSession.findUnique({
        where: { id: `${fixture.shop}_124` },
      }),
    ).toBeNull();
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties,
            coordination: original,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: properties(fixture.shop),
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(400);
    // The original observation must never be rebound to a replacement install.
    // Update both authoritative records, so rejection proves stale observation
    // fencing rather than merely detecting inconsistent fixture credentials.
    await database.$transaction([
      database.weleticShopifyStore.update({
        where: { id: fixture.id },
        data: { installationGeneration: "generation-2" },
      }),
      database.installedIntegration.update({
        where: { id: fixture.installationId },
        data: {
          credentials: {
            ...(projection.credentials as Prisma.JsonObject),
            installationGeneration: "generation-2",
          },
        },
      }),
    ]);
    const row = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `${fixture.shop}_123` },
    });
    expect(row.payload).not.toContain("synthetic-online-token");
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties,
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      await database.weleticShopifyAppSession.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toEqual(row);
  });

  it("deletes only the original online payload version and preserves offline credentials", async () => {
    const fixture = await seed();
    const original = await acquire(fixture.shop);
    const { GET, POST, DELETE } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const offline = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${fixture.shop}` },
    });
    const path = "/api/internal/shopify/sessions";
    const id = `${fixture.shop}_123`;
    const onlineProperties = [
      ["id", id],
      ["shop", fixture.shop],
      ["state", ""],
      ["isOnline", true],
      ["userId", 123],
      ["accountOwner", false],
      ["collaborator", false],
      ["associatedUserScope", "read_products"],
      ["expires", Date.now() + 60000],
      ["accessToken", "synthetic-online-token"],
    ];
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties,
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(200);
    const first = (await (await GET(await request(`${path}?id=${id}`))).json())
      .sessions[0];
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties,
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(200);
    const replacement =
      await database.weleticShopifyAppSession.findUniqueOrThrow({
        where: { id },
      });
    const remove = (expectedPayloadDigest: string) =>
      request(path, "DELETE", {
        ids: [id],
        onlineDeletion: {
          shop: fixture.shop,
          expectedPayloadDigest,
          coordination: original,
        },
      });
    expect((await DELETE(await remove(first.onlineDigest))).status).toBe(409);
    expect(
      await database.weleticShopifyAppSession.findUniqueOrThrow({
        where: { id },
      }),
    ).toEqual(replacement);
    expect(
      (await DELETE(await request(path, "DELETE", { ids: [id] }))).status,
    ).toBe(400);
    const current = (
      await (await GET(await request(`${path}?id=${id}`))).json()
    ).sessions[0];
    expect(current.onlineDigest).not.toBe(first.onlineDigest);
    const deleted = await DELETE(await remove(current.onlineDigest));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(
      await (await DELETE(await remove(current.onlineDigest))).json(),
    ).toEqual({ deleted: 0 });
    expect(
      await database.weleticShopifyAppSession.findUniqueOrThrow({
        where: { id: offline.id },
      }),
    ).toEqual(offline);
    expect((await (await observe(fixture.shop)).json()).observed.revision).toBe(
      original.observed.revision,
    );
  });

  it("allows one online exchange across competing real signed clients and rejects the cached generation after reinstall", async () => {
    const fixture = await seed();
    const route = await import("../../app/api/internal/shopify/sessions/route");
    const coordination = await import(
      "../../app/api/internal/shopify/sessions/coordination/route"
    );
    const { CoordinatedWeleticSessionStorage } = await import(
      "../../../../packages/shopify-app/app/coordinated-session-storage.server"
    );
    const { deserializeShopifySession } = await import(
      "../../../../packages/shopify-app/app/session-properties.server"
    );
    const first = new CoordinatedWeleticSessionStorage();
    const second = new CoordinatedWeleticSessionStorage();
    const priorFetch = globalThis.fetch;
    vi.stubEnv("WELETIC_API_URL", "https://session-boundary.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const incoming = new Request(input, init);
        const url = new URL(incoming.url);
        if (url.origin !== "https://session-boundary.invalid")
          throw new Error("External network forbidden");
        if (url.pathname.endsWith("/coordination"))
          return incoming.method === "GET"
            ? coordination.GET(incoming)
            : coordination.POST(incoming);
        if (url.pathname !== "/api/internal/shopify/sessions")
          throw new Error("Unexpected signed client route");
        return incoming.method === "GET"
          ? route.GET(incoming)
          : route.POST(incoming);
      }),
    );
    let releaseProvider!: () => void;
    let notifyProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyProvider = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const transport = vi.fn<typeof fetch>(async () => {
      notifyProvider();
      await released;
      return Response.json({
        access_token: "synthetic-online-token",
        expires_in: 60,
        associated_user_scope: "read_products",
        associated_user: { id: 123, account_owner: false, collaborator: false },
      });
    });
    const onlineProperties: import("../../lib/weletic/shopify/session-contract").ShopifySessionProperty[] =
      [
        ["id", `${fixture.shop}_123`],
        ["shop", fixture.shop],
        ["state", ""],
        ["isOnline", true],
        ["userId", 123],
        ["accountOwner", false],
        ["collaborator", false],
        ["associatedUserScope", "read_products"],
        ["accessToken", "synthetic-online-token"],
        ["expires", Date.now() + 60000],
      ];
    const offline = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${fixture.shop}` },
    });
    const projection = await database.installedIntegration.findUniqueOrThrow({
      where: { id: fixture.installationId },
    });
    const winner = first.runOperation(async () => {
      await first.tokenRequest(
        `https://${fixture.shop}/admin/oauth/access_token`,
        {},
        transport,
      );
      return first.storeSession(deserializeShopifySession(onlineProperties)!);
    });
    try {
      // Propagate early acquisition failures instead of hanging on a provider
      // barrier that would never be reached.
      await Promise.race([
        entered,
        winner.then(() => {
          throw new Error("Provider barrier not observed");
        }),
      ]);
      await expect(
        second.runOperation(() =>
          second.tokenRequest(
            `https://${fixture.shop}/admin/oauth/access_token`,
            {},
            transport,
          ),
        ),
      ).rejects.toMatchObject({ status: 409 });
      releaseProvider();
      expect(await winner).toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(
        await database.weleticShopifyAppSession.findUniqueOrThrow({
          where: { id: offline.id },
        }),
      ).toEqual(offline);
      expect(
        await database.installedIntegration.findUniqueOrThrow({
          where: { id: projection.id },
        }),
      ).toEqual(projection);
      expect(
        await second.runOperation(() =>
          second.loadSession(`${fixture.shop}_123`),
        ),
      ).toBeDefined();
      await database.$transaction([
        database.weleticShopifyStore.update({
          where: { id: fixture.id },
          data: { installationGeneration: "generation-2" },
        }),
        database.installedIntegration.update({
          where: { id: fixture.installationId },
          data: {
            credentials: {
              ...(projection.credentials as Prisma.JsonObject),
              installationGeneration: "generation-2",
            },
          },
        }),
      ]);
      expect(
        await second.runOperation(() =>
          second.loadSession(`${fixture.shop}_123`),
        ),
      ).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      releaseProvider();
      await winner.catch(() => undefined);
      vi.stubGlobal("fetch", priorFetch);
    }
  });

  it("rejects expired online publication and expired lease ownership without inserting a session", async () => {
    const fixture = await seed();
    const original = await acquire(fixture.shop);
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const onlineProperties = [
      ["id", `${fixture.shop}_123`],
      ["shop", fixture.shop],
      ["state", ""],
      ["isOnline", true],
      ["userId", 123],
      ["accountOwner", false],
      ["collaborator", false],
      ["associatedUserScope", ""],
      ["expires", Date.now() - 1000],
      ["accessToken", "synthetic-online-token"],
    ];
    const path = "/api/internal/shopify/sessions";
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: onlineProperties,
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(409);
    await database.weleticShopifySessionCoordination.updateMany({
      where: { shop: fixture.shop },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const freshProperties = onlineProperties.map(([key, value]) => [
      key,
      key === "expires" ? Date.now() + 60_000 : value,
    ]);
    expect(
      (
        await POST(
          await request(path, "POST", {
            properties: freshProperties,
            onlineCoordination: original,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      await database.weleticShopifyAppSession.findUnique({
        where: { id: `${fixture.shop}_123` },
      }),
    ).toBeNull();
  });

  it("revalidates the original installation on lease renewal before provider work", async () => {
    const fixture = await seed();
    const original = await acquire(fixture.shop);
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/coordination/route"
    );
    async function requestBody() {
      return request(coordinationPath, "POST", {
        action: "renew",
        shop: fixture.shop,
        ...original,
      });
    }
    const valid = await POST(await requestBody());
    expect(valid.status).toBe(200);
    const before =
      await database.weleticShopifySessionCoordination.findFirstOrThrow({
        where: { shop: fixture.shop },
      });
    const { encrypt } = await import("../../lib/encryption");
    // Same store-row transaction used by reconnect. The coordinator itself
    // is unchanged, so lease ownership alone must not pass the next refresh.
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${fixture.id} FOR UPDATE`;
      await tx.weleticShopifyStore.update({
        where: { id: fixture.id },
        data: { installationGeneration: "generation-2" },
      });
      await tx.installedIntegration.update({
        where: { id: fixture.installationId },
        data: {
          credentials: {
            shop: fixture.shop,
            installationGeneration: "generation-2",
            accessToken: encrypt("synthetic-old-token"),
          },
        },
      });
    });
    const stale = await POST(await requestBody());
    expect(stale.status).toBe(409);
    const after =
      await database.weleticShopifySessionCoordination.findFirstOrThrow({
        where: { shop: fixture.shop },
      });
    expect(after.leaseExpiresAt).toEqual(before.leaseExpiresAt);
    expect(after.revision).toBe(before.revision);
  });

  it("the renewal worker skips a replaced installation through real lifecycle locks", async () => {
    const fixture = await seed();
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "1");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    const { renewInstalledShopifySession, listDueShopifySessionRenewals } =
      await import("../../lib/weletic/shopify/session-renewal");
    const scheduledAt = new Date().toISOString();
    await database.weleticShopifyAppSession.update({
      where: { id: `offline_${fixture.shop}` },
      data: { expiresAt: new Date(0) },
    });
    const page = await listDueShopifySessionRenewals({
      appId: "session-boundary-test",
      scheduledAt,
    });
    expect(page.jobs).toContainEqual({
      storeId: fixture.id,
      installationGeneration: "generation-1",
      appId: "session-boundary-test",
      scheduledAt,
    });
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: { installationGeneration: "generation-2" },
    });
    expect(
      await renewInstalledShopifySession({
        storeId: fixture.id,
        installationGeneration: "generation-1",
        appId: "session-boundary-test",
        scheduledAt,
      }),
    ).toEqual({ status: "stale" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent missing-session incidents and resolves them after credential recovery", async () => {
    const fixture = await seed();
    const retainedFetch = globalThis.fetch;
    const { renewInstalledShopifySession, listDueShopifySessionRenewals } =
      await import("../../lib/weletic/shopify/session-renewal");
    const { readShopifySessionHealth } = await import(
      "../../lib/weletic/shopify/session-health"
    );
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "1");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    vi.stubEnv("SHOPIFY_APP_URL", "https://authority.invalid");
    const job = {
      storeId: fixture.id,
      installationGeneration: "generation-1",
      appId: "session-boundary-test",
      scheduledAt: new Date().toISOString(),
    };
    await database.weleticShopifyAppSession.delete({
      where: { id: `offline_${fixture.shop}` },
    });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            {
              code: "SESSION_MISSING",
              shop: fixture.shop,
              installationGeneration: "generation-1",
            },
            { status: 404 },
          ),
        ),
      );
      expect(
        await Promise.all([
          renewInstalledShopifySession(job),
          renewInstalledShopifySession(job),
        ]),
      ).toEqual([
        { status: "reconnect_required" },
        { status: "reconnect_required" },
      ]);
      const [incident] = await database.weleticReconciliationIssue.findMany({
        where: { storeId: fixture.id },
      });
      expect(
        await database.weleticReconciliationIssue.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(1);
      expect(incident.status).toBe("open");
      expect((await readShopifySessionHealth(fixture.projectId)).status).toBe(
        "reconnect_required",
      );
      expect(incident.details).toEqual({
        reason: "session_missing",
        appId: "session-boundary-test",
      });
      // Publish through the production signed session boundary, not a mocked
      // transaction, before allowing a healthy result to clear the incident.
      const fence = await acquire(fixture.shop);
      expect(
        (await publish(fixture.shop, fence, "synthetic-recovered-token"))
          .status,
      ).toBe(200);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            shop: fixture.shop,
            installationGeneration: "generation-1",
            accessToken: "synthetic-recovered-token",
            scope: "read_products",
            expiresAt: null,
          }),
        ),
      );
      const nextSweep = await listDueShopifySessionRenewals({
        appId: job.appId,
        scheduledAt: job.scheduledAt,
      });
      const recoveryJob = nextSweep.jobs.find(
        (candidate) => candidate.storeId === fixture.id,
      );
      expect(recoveryJob).toEqual(job);
      expect((await renewInstalledShopifySession(recoveryJob!)).status).toBe(
        "healthy",
      );
      expect((await readShopifySessionHealth(fixture.projectId)).status).toBe(
        "not_observed",
      );
      expect(
        await database.weleticReconciliationIssue.findUnique({
          where: { id: incident.id },
        }),
      ).toMatchObject({
        status: "resolved",
        detectedAt: incident.detectedAt,
        resolvedAt: expect.any(Date),
      });
      // Another confirmed loss reopens the same durable identity, not a new row.
      await database.weleticShopifyAppSession.delete({
        where: { id: `offline_${fixture.shop}` },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            {
              code: "SESSION_MISSING",
              shop: fixture.shop,
              installationGeneration: "generation-1",
            },
            { status: 404 },
          ),
        ),
      );
      expect(await renewInstalledShopifySession(job)).toEqual({
        status: "reconnect_required",
      });
      expect(
        await database.weleticReconciliationIssue.findMany({
          where: { storeId: fixture.id },
        }),
      ).toEqual([
        expect.objectContaining({
          id: incident.id,
          status: "open",
          resolvedAt: null,
        }),
      ]);
    } finally {
      vi.stubGlobal("fetch", retainedFetch);
    }
  });

  it("does not open a delayed missing-session incident after real credential publication", async () => {
    const fixture = await seed();
    const retainedFetch = globalThis.fetch;
    const { renewInstalledShopifySession } = await import(
      "../../lib/weletic/shopify/session-renewal"
    );
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "1");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    vi.stubEnv("SHOPIFY_APP_URL", "https://authority.invalid");
    await database.weleticShopifyAppSession.delete({
      where: { id: `offline_${fixture.shop}` },
    });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const fence = await acquire(fixture.shop);
          expect(
            (await publish(fixture.shop, fence, "synthetic-newer-token"))
              .status,
          ).toBe(200);
          return Response.json(
            {
              code: "SESSION_MISSING",
              shop: fixture.shop,
              installationGeneration: "generation-1",
            },
            { status: 404 },
          );
        }),
      );
      expect(
        await renewInstalledShopifySession({
          storeId: fixture.id,
          installationGeneration: "generation-1",
          appId: "session-boundary-test",
          scheduledAt: new Date().toISOString(),
        }),
      ).toEqual({ status: "stale" });
      expect(
        await database.weleticReconciliationIssue.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(0);
    } finally {
      vi.stubGlobal("fetch", retainedFetch);
    }
  });

  it("does not resolve an incident when a healthy authority response arrives after invalidation", async () => {
    const fixture = await seed();
    const retainedFetch = globalThis.fetch;
    const { renewInstalledShopifySession } = await import(
      "../../lib/weletic/shopify/session-renewal"
    );
    vi.stubEnv("WELETIC_SHOPIFY_RENEWAL_ENABLED", "1");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");
    vi.stubEnv("SHOPIFY_APP_URL", "https://authority.invalid");
    const incident = await database.weleticReconciliationIssue.create({
      data: {
        id: randomUUID(),
        storeId: fixture.id,
        kind: "shopify_session_missing",
        externalKey: "generation-1",
        severity: "warning",
        details: { reason: "session_missing" },
      },
    });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          await database.weleticShopifyAppSession.delete({
            where: { id: `offline_${fixture.shop}` },
          });
          return Response.json({
            shop: fixture.shop,
            installationGeneration: "generation-1",
            accessToken: "synthetic-old-token",
            scope: "read_products",
            expiresAt: null,
          });
        }),
      );
      expect(
        await renewInstalledShopifySession({
          storeId: fixture.id,
          installationGeneration: "generation-1",
          appId: "session-boundary-test",
          scheduledAt: new Date().toISOString(),
        }),
      ).toEqual({ status: "stale" });
      expect(
        await database.weleticReconciliationIssue.findUnique({
          where: { id: incident.id },
        }),
      ).toMatchObject({ status: "open", resolvedAt: null });
    } finally {
      vi.stubGlobal("fetch", retainedFetch);
    }
  });

  it("creates the first unbound SDK session and fences deletion without losing its revision record", async () => {
    const suffix = randomUUID();
    const fixture = {
      id: `stest_${suffix}`,
      shop: `boundary-${suffix}.myshopify.com`,
      projectId: `sproject_${suffix}`,
      installationId: `sinstall_${suffix}`,
    };
    fixtures.push(fixture);
    const original = await acquire(fixture.shop);
    expect(original.observed.installationGeneration).toBeNull();
    const response = await publish(
      fixture.shop,
      original,
      "synthetic-first-token",
    );
    expect(response.status).toBe(200);
    const current: ShopifySessionMutationFence = (await response.json())
      .coordination;
    const { DELETE } = await import(
      "../../app/api/internal/shopify/sessions/coordinated/route"
    );
    const stale = await DELETE(
      await request(mutationPath, "DELETE", {
        ids: [`offline_${fixture.shop}`],
        coordination: original,
      }),
    );
    expect(stale.status).toBe(409);
    const deleted = await DELETE(
      await request(mutationPath, "DELETE", {
        ids: [`offline_${fixture.shop}`],
        coordination: current,
      }),
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).deleted).toBe(1);
    expect(
      await database.weleticShopifyAppSession.count({
        where: { id: `offline_${fixture.shop}` },
      }),
    ).toBe(0);
    expect(
      (
        await database.weleticShopifySessionCoordination.findFirstOrThrow({
          where: { shop: fixture.shop },
        })
      ).revision,
    ).toBe(BigInt(2));
  });

  it("atomically publishes one SDK payload and projection across competing original observations", async () => {
    const fixture = await seed();
    const fence = await acquire(fixture.shop);
    const responses = await Promise.all([
      publish(fixture.shop, fence, "synthetic-next-a"),
      publish(fixture.shop, fence, "synthetic-next-b"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const { decrypt } = await import("../../lib/encryption");
    const row = await database.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${fixture.shop}` },
    });
    const installation = await database.installedIntegration.findUniqueOrThrow({
      where: { id: fixture.installationId },
    });
    const sdkToken = Object.fromEntries(
      JSON.parse(decrypt(row.payload)),
    ).accessToken;
    const credentials = installation.credentials as { accessToken: string };
    expect(decrypt(credentials.accessToken)).toBe(sdkToken);
    expect(
      (
        await database.weleticShopifySessionCoordination.findFirstOrThrow({
          where: { shop: fixture.shop },
        })
      ).revision,
    ).toBe(BigInt(1));
    expect((await publish(fixture.shop, fence)).status).toBe(409); // late SDK invalidation
  });

  it("rejects SDK/projection drift before lease acquisition", async () => {
    const fixture = await seed();
    const { encrypt } = await import("../../lib/encryption");
    await database.weleticShopifyAppSession.update({
      where: { id: `offline_${fixture.shop}` },
      data: {
        payload: encrypt(
          JSON.stringify(properties(fixture.shop, "synthetic-stale-token")),
        ),
      },
    });
    expect((await observe(fixture.shop)).status).toBe(409);
    expect(
      await database.weleticShopifySessionCoordination.count({
        where: { shop: fixture.shop },
      }),
    ).toBe(0);
  });

  it("allows a token-less invalidation snapshot without erasing the credential projection", async () => {
    const fixture = await seed();
    const fence = await acquire(fixture.shop);
    expect((await publish(fixture.shop, fence)).status).toBe(200);
    const response = await observe(fixture.shop);
    expect(response.status).toBe(200);
    const snapshot: ShopifySessionSnapshot = await response.json();
    expect(Object.fromEntries(snapshot.properties!)).not.toHaveProperty(
      "accessToken",
    );
    expect(snapshot.observed.credentialTokenHash).toBe(
      fence.observed.credentialTokenHash,
    );
  });

  it("rejects changed installation generation, freezes and tombstones before stale publication", async () => {
    const fixture = await seed();
    const fence = await acquire(fixture.shop);
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: { installationGeneration: "generation-2" },
    });
    expect(
      (await publish(fixture.shop, fence, "synthetic-next-token")).status,
    ).toBe(409);
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: { complianceState: "frozen" },
    });
    expect((await observe(fixture.shop)).status).toBe(409);
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: {
        complianceState: "active",
        installationGeneration: "generation-1",
      },
    });
    await database.weleticShopifyShopPrivacyTombstone.create({
      data: {
        id: `stomb_${randomUUID()}`,
        storeId: fixture.id,
        identityKeyId: "session-boundary-test",
        shopDomainDigest: createHash("sha256")
          .update(fixture.shop)
          .digest("hex"),
        redactedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(
      (await publish(fixture.shop, fence, "synthetic-next-token")).status,
    ).toBe(409);
    expect(
      (
        await database.weleticShopifySessionCoordination.findFirstOrThrow({
          where: { shop: fixture.shop },
        })
      ).revision,
    ).toBe(BigInt(0));
  });

  it("requires a coordinated proof on the new endpoint and rejects a cross-shop proof", async () => {
    const first = await seed();
    const second = await seed();
    const fence = await acquire(first.shop);
    expect(
      (await publish(second.shop, fence, "synthetic-next-token")).status,
    ).toBe(409);
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/coordinated/route"
    );
    const response = await POST(
      await request(mutationPath, "POST", {
        properties: properties(first.shop, "synthetic-next-token"),
      }),
    );
    expect(response.status).toBe(400);
  });
});
