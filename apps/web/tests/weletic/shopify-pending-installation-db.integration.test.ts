import { PrismaClient } from "@prisma/client";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const db = new PrismaClient();
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("server-only", () => ({}));
const appId = `pending-test-${randomUUID()}`;
const shops: string[] = [];
const mappedStores: string[] = [];
const inventoryCatalogIds: string[] = [];
let ready = false;
describe("pending admission with real isolated MySQL transactions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      !/^\/weletic_loyalty_it_access_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error("Isolated pending test database required");
    const [tables] = await db.$queryRaw<
      Array<{ total: bigint }>
    >`SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema=DATABASE()`;
    if (Number(tables.total)) throw new Error("Fresh empty database required");
    await db.$executeRawUnsafe(
      "CREATE TABLE WeleticShopifyStore (id VARCHAR(191) PRIMARY KEY, shopDomain VARCHAR(191) NOT NULL UNIQUE, projectId VARCHAR(191) NOT NULL DEFAULT 'fixture-workspace', programId VARCHAR(191) NOT NULL DEFAULT 'fixture-program', complianceState VARCHAR(32) NOT NULL DEFAULT 'active', installationGeneration VARCHAR(64), uninstalledAt DATETIME(3), redactedAt DATETIME(3), storeAccessState VARCHAR(32) NOT NULL DEFAULT 'pending_approval', storeAccessRevision INT NOT NULL DEFAULT 1, syncStatus VARCHAR(32) DEFAULT 'pending', lastSyncError TEXT, updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))",
    );
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifyShopPrivacyTombstone (
      id VARCHAR(64) PRIMARY KEY, storeId VARCHAR(191), identityKeyId VARCHAR(64) NOT NULL,
      shopDomainDigest VARCHAR(64) NOT NULL, expiresAt DATETIME(3) NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifyComplianceRequest (
      id VARCHAR(64) PRIMARY KEY, storeId VARCHAR(191) NOT NULL,
      requestType VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL,
      shopDomain VARCHAR(191), phase VARCHAR(32), payloadCiphertext LONGTEXT,
      triggeredAt DATETIME(3), receivedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), completedAt DATETIME(3),
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`);
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifyVoucherCleanup (
      id VARCHAR(64) PRIMARY KEY, storeId VARCHAR(191) NOT NULL, redemptionId VARCHAR(191) NOT NULL,
      source VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, lockedBy VARCHAR(191),
      lockedAt DATETIME(3), leaseVersion INT NOT NULL, expectedDiscountCodeCanonical VARCHAR(255) NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifyVoucherCleanupRequestLink (
      id VARCHAR(64) PRIMARY KEY, storeId VARCHAR(191) NOT NULL, requestId VARCHAR(64) NOT NULL,
      cleanupId VARCHAR(64) NOT NULL, UNIQUE KEY request_cleanup (requestId, cleanupId))`);
    await db.$executeRawUnsafe(
      `CREATE TABLE Project (id VARCHAR(191) PRIMARY KEY)`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE InstalledIntegration (id VARCHAR(191) PRIMARY KEY, projectId VARCHAR(191), integrationId VARCHAR(191), credentials JSON, updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`,
    );
    await db.$executeRawUnsafe(`CREATE TABLE Integration (
      id VARCHAR(191) PRIMARY KEY, projectId VARCHAR(191), name VARCHAR(191), slug VARCHAR(191),
      description TEXT, logo TEXT, verified BOOLEAN, guideUrl TEXT, comingSoon BOOLEAN,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`);
    await db.$executeRawUnsafe(
      `CREATE TABLE WeleticLoyaltyProgram (id VARCHAR(191) PRIMARY KEY, storeId VARCHAR(191), status VARCHAR(32), killSwitchActive BOOLEAN, metadata JSON)`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE WeleticShopifyStaffGrant (id VARCHAR(64) PRIMARY KEY, storeId VARCHAR(191), appId VARCHAR(191))`,
    );
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifyStoreAccessChange (
      id VARCHAR(64) PRIMARY KEY, storeId VARCHAR(191), installationGeneration VARCHAR(64),
      previousState VARCHAR(32), nextState VARCHAR(32), revision INT, operator VARCHAR(191), reason VARCHAR(500),
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY store_revision (storeId, revision))`);
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifySessionCoordination (
      id VARCHAR(64) PRIMARY KEY, appId VARCHAR(191) NOT NULL, shop VARCHAR(255) NOT NULL,
      revision BIGINT NOT NULL DEFAULT 0, leaseEpoch BIGINT NOT NULL DEFAULT 0,
      leaseOwnerHash VARCHAR(64), leaseExpiresAt DATETIME(3),
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL,
      UNIQUE KEY app_shop (appId, shop))`);
    await db.$executeRawUnsafe(`CREATE TABLE WeleticShopifyAppSession (
      id VARCHAR(191) PRIMARY KEY, shop VARCHAR(191) NOT NULL, isOnline BOOLEAN NOT NULL,
      expiresAt DATETIME(3), payload TEXT NOT NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL)`);
    const migration = readFileSync(
      new URL(
        "../../../../infra/shopify-development/migrations/20260909_pending_installations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const sql of migration
      .replace(/^--.*$/gm, "")
      .split(";")
      .filter((value) => value.trim()))
      await db.$executeRawUnsafe(sql);
    const credentialMigration = readFileSync(
      new URL(
        "../../../../infra/shopify-development/migrations/20260909_store_owned_shopify_credentials.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const sql of credentialMigration
      .replace(/^--.*$/gm, "")
      .split(";")
      .filter((value) => value.trim()))
      await db.$executeRawUnsafe(sql);
    ready = true;
  });
  afterAll(async () => {
    if (ready) {
      await db.weleticShopifyInstallationCredential.deleteMany({
        where: { appId },
      });
      const rows = await db.weleticShopifyPendingInstallation.findMany({
        where: { appId },
        select: { id: true },
      });
      for (const { id } of rows) {
        await db.weleticShopifyPendingInstallationChange.deleteMany({
          where: { pendingInstallationId: id },
        });
        await db.weleticShopifyPendingInstallation.delete({ where: { id } });
      }
      await db.weleticShopifySessionCoordination.deleteMany({
        where: { appId },
      });
      await db.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: shops } },
      });
      for (const storeId of mappedStores) {
        await db.$executeRaw`DELETE FROM InstalledIntegration WHERE projectId = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticShopifyStaffGrant WHERE storeId = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticShopifyStoreAccessChange WHERE storeId = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticLoyaltyProgram WHERE storeId = ${storeId}`;
        await db.$executeRaw`DELETE FROM Project WHERE id = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticShopifyVoucherCleanupRequestLink WHERE storeId = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticShopifyVoucherCleanup WHERE storeId = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticShopifyComplianceRequest WHERE storeId = ${storeId}`;
        await db.$executeRaw`DELETE FROM WeleticShopifyStore WHERE id = ${storeId}`;
      }
      for (const id of inventoryCatalogIds) {
        await db.$executeRaw`DELETE FROM Integration WHERE id = ${id}`;
      }
    }
    await db.$disconnect();
  });
  function scope() {
    const shop = `pending-${randomUUID()}.myshopify.com`;
    shops.push(shop);
    return { appId, shop };
  }
  async function legacyScopeFixture() {
    const target = scope();
    const storeId = randomUUID();
    mappedStores.push(storeId);
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
    vi.stubEnv("WELETIC_LOYALTY_TEST_STORE_ALLOWLIST", target.shop);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { encrypt } = await import("@/lib/encryption");
    const { SHOPIFY_INTEGRATION_ID } = await import("@dub/utils");
    const generation = randomUUID();
    await db.$executeRaw`INSERT INTO WeleticShopifyStore (id, shopDomain, projectId, installationGeneration)
      VALUES (${storeId}, ${target.shop}, ${storeId}, ${generation})`;
    const credentials = JSON.stringify({
      shop: target.shop,
      installationGeneration: generation,
      accessToken: encrypt("synthetic-scope-token"),
      scope: "read_products",
    });
    await db.$executeRaw`INSERT INTO InstalledIntegration (id, projectId, integrationId, credentials)
      VALUES (${storeId}, ${storeId}, ${SHOPIFY_INTEGRATION_ID}, ${credentials})`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              currentAppInstallation: {
                accessScopes: [
                  { handle: "read_products" },
                  { handle: "write_discounts" },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { reconcileLegacyShopifyScopes } = await import(
      "../../scripts/loyalty/reconcile-shopify-installation-scopes"
    );
    return {
      target,
      storeId,
      fetchMock,
      run: () =>
        reconcileLegacyShopifyScopes({
          storeDomain: target.shop,
          confirmStaging: true,
          apply: true,
        }),
    };
  }
  it.each(["unchanged", "public_admission", "generic_integration"])(
    "rechecks offline bootstrap authority after legacy selection in SQL (%s)",
    async (transition) => {
      const f = await legacyScopeFixture();
      const { encrypt } = await import("@/lib/encryption");
      const { readLegacyBootstrapSession } = await import(
        "@/lib/weletic/shopify/store-resolver"
      );
      const { readShopifyCredentialSource } = await import(
        "@/lib/weletic/shopify/credential-source"
      );
      const [store] = await db.$queryRaw<
        Array<{ installationGeneration: string }>
      >`SELECT installationGeneration FROM WeleticShopifyStore WHERE id=${f.storeId}`;
      const input = {
        storeId: f.storeId,
        workspaceId: f.storeId,
        shop: f.target.shop,
        installationGeneration: store.installationGeneration,
      };
      const integration = await db.installedIntegration.findUniqueOrThrow({
        where: { id: f.storeId },
        select: { integrationId: true, credentials: true },
      });
      await db.$executeRaw`DELETE FROM InstalledIntegration WHERE id=${f.storeId}`;
      const payload = encrypt(
        JSON.stringify({ accessToken: "synthetic-bootstrap-token" }),
      );
      await db.$executeRaw`INSERT INTO WeleticShopifyAppSession (id, shop, isOnline, payload, updatedAt)
        VALUES (${randomUUID()}, ${f.target.shop}, FALSE, ${payload}, CURRENT_TIMESTAMP(3))`;
      await expect(readShopifyCredentialSource(input)).resolves.toEqual({
        source: "legacy",
      });

      // Deterministic committed interleaving, not a simultaneous contention test.
      if (transition === "public_admission") await authenticate(f.target);
      if (transition === "generic_integration")
        await db.$executeRaw`INSERT INTO InstalledIntegration (id, projectId, integrationId, credentials)
          VALUES (${f.storeId}, ${f.storeId}, ${integration.integrationId}, ${JSON.stringify(integration.credentials)})`;
      if (transition === "public_admission")
        await expect(readLegacyBootstrapSession(input)).rejects.toThrow(
          "managed by Shopify",
        );
      else
        await expect(readLegacyBootstrapSession(input)).resolves.toBe(
          transition === "unchanged" ? "synthetic-bootstrap-token" : null,
        );
      expect(f.fetchMock).not.toHaveBeenCalled();
      expect(
        await db.weleticShopifyAppSession.count({
          where: { shop: f.target.shop },
        }),
      ).toBe(1);
    },
  );
  it("publishes legacy scopes and revision atomically, rejecting an older SDK observation", async () => {
    const f = await legacyScopeFixture();
    await expect(f.run()).resolves.toMatchObject({
      updated: true,
      added: ["write_discounts"],
    });
    expect(f.fetchMock).toHaveBeenCalledOnce();
    const rows = await db.$queryRaw<
      Array<{ scope: string }>
    >`SELECT JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.scope')) AS scope FROM InstalledIntegration WHERE id=${f.storeId}`;
    expect(rows).toEqual([{ scope: "read_products,write_discounts" }]);
    const coordinator =
      await db.weleticShopifySessionCoordination.findFirstOrThrow({
        where: f.target,
      });
    expect(coordinator.revision).toBe(BigInt(1));
    expect(coordinator.leaseEpoch).toBe(BigInt(0));
    const { acquireShopifySessionLease } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    await expect(
      db.$transaction((tx) =>
        acquireShopifySessionLease(tx, f.target, "a".repeat(64), {
          epoch: "0",
          revision: "0",
        }),
      ),
    ).rejects.toThrow();
  });
  it("rolls back the coordinator revision when scope publication fails in SQL", async () => {
    const f = await legacyScopeFixture();
    const { ensureShopifySessionCoordination } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    await db.$transaction((tx) =>
      ensureShopifySessionCoordination(tx, f.target),
    );
    // The generated UUID and constraint exist only in this fresh fixture DB.
    await db.$executeRawUnsafe(
      `ALTER TABLE InstalledIntegration ADD CONSTRAINT reject_scope_fixture CHECK (id <> '${f.storeId}' OR JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.scope')) = 'read_products')`,
    );
    try {
      await expect(f.run()).rejects.toThrow("reject_scope_fixture");
      const coordinator =
        await db.weleticShopifySessionCoordination.findFirstOrThrow({
          where: f.target,
        });
      expect(coordinator.revision).toBe(BigInt(0));
      const rows = await db.$queryRaw<
        Array<{ scope: string }>
      >`SELECT JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.scope')) AS scope FROM InstalledIntegration WHERE id=${f.storeId}`;
      expect(rows).toEqual([{ scope: "read_products" }]);
    } finally {
      await db.$executeRawUnsafe(
        "ALTER TABLE InstalledIntegration DROP CHECK reject_scope_fixture",
      );
    }
  });
  it("leaves scopes unchanged when SDK promotion prevents legacy publication", async () => {
    const f = await legacyScopeFixture();
    const { ensureShopifySessionCoordination } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    await db.$transaction((tx) =>
      ensureShopifySessionCoordination(tx, f.target),
    );
    await db.$executeRaw`UPDATE WeleticShopifySessionCoordination SET leaseEpoch=1 WHERE appId=${appId} AND shop=${f.target.shop}`;
    await expect(f.run()).rejects.toThrow("stale_session");
    const rows = await db.$queryRaw<
      Array<{ scope: string }>
    >`SELECT JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.scope')) AS scope FROM InstalledIntegration WHERE id=${f.storeId}`;
    expect(rows).toEqual([{ scope: "read_products" }]);
    expect(
      (
        await db.weleticShopifySessionCoordination.findFirstOrThrow({
          where: f.target,
        })
      ).revision,
    ).toBe(BigInt(0));
  });
  it("rejects public scope reconciliation before any remote legacy-token read", async () => {
    const f = await legacyScopeFixture();
    await authenticate(f.target);
    await expect(f.run()).rejects.toThrow("managed by Shopify");
    expect(f.fetchMock).not.toHaveBeenCalled();
    const rows = await db.$queryRaw<
      Array<{ scope: string }>
    >`SELECT JSON_UNQUOTE(JSON_EXTRACT(credentials, '$.scope')) AS scope FROM InstalledIntegration WHERE id=${f.storeId}`;
    expect(rows).toEqual([{ scope: "read_products" }]);
  });
  async function authenticate(target: ReturnType<typeof scope>) {
    const { ensureShopifySessionCoordination } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    const { ensurePendingInstallationAfterAuthentication } = await import(
      "@/lib/weletic/shopify/installation-admission"
    );
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE shopDomain=${target.shop} FOR UPDATE`;
      await ensureShopifySessionCoordination(tx, target);
      return ensurePendingInstallationAfterAuthentication(
        tx,
        target,
        new Date(Date.now() - 60_000),
      );
    });
  }
  it.each([true, false])(
    "rejects legacy resolver use after same-generation public admission in SQL (preverified=%s)",
    async (preverified) => {
      const f = await legacyScopeFixture();
      const {
        verifyAndBindShopifyIntegrationCredential,
        shopifyCredentialVerificationHash,
      } = await import("@/lib/weletic/shopify/store-resolver");
      const { readShopifyCredentialSource } = await import(
        "@/lib/weletic/shopify/credential-source"
      );
      const [store] = await db.$queryRaw<
        Array<{ installationGeneration: string }>
      >`
        SELECT installationGeneration FROM WeleticShopifyStore WHERE id=${f.storeId}`;
      if (preverified)
        await db.$executeRaw`UPDATE InstalledIntegration SET credentials=JSON_SET(credentials, '$.shopVerificationTokenHash', ${shopifyCredentialVerificationHash("synthetic-scope-token")}) WHERE id=${f.storeId}`;
      const installation = await db.installedIntegration.findUniqueOrThrow({
        where: { id: f.storeId },
        select: { id: true, credentials: true },
      });
      await expect(
        readShopifyCredentialSource({
          storeId: f.storeId,
          workspaceId: f.storeId,
          shop: f.target.shop,
          installationGeneration: store.installationGeneration,
        }),
      ).resolves.toEqual({ source: "legacy" });
      const admit = async () => {
        const pending = await authenticate(f.target);
        await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state='mapped', mappedStoreId=${f.storeId}, installationGeneration=${store.installationGeneration} WHERE id=${pending.id}`;
      };
      if (preverified) await admit();
      const customFetch = vi.fn(async () => {
        await admit();
        return Response.json({
          data: {
            shop: { myshopifyDomain: f.target.shop, currencyCode: "USD" },
          },
        });
      });
      await expect(
        verifyAndBindShopifyIntegrationCredential({
          installation,
          expectedStore: {
            id: f.storeId,
            installationGeneration: store.installationGeneration,
          },
          expectedShopDomain: f.target.shop,
          customFetch,
        }),
      ).rejects.toThrow("managed by Shopify");
      expect(customFetch).toHaveBeenCalledTimes(preverified ? 0 : 1);
      const retained = await db.installedIntegration.findUniqueOrThrow({
        where: { id: f.storeId },
        select: { credentials: true },
      });
      expect(retained.credentials).toEqual(installation.credentials);
      const [unchanged] = await db.$queryRaw<
        Array<{ installationGeneration: string }>
      >`SELECT installationGeneration FROM WeleticShopifyStore WHERE id=${f.storeId}`;
      expect(unchanged.installationGeneration).toBe(
        store.installationGeneration,
      );
    },
  );

  it("publishes a verified legacy alias with a current SQL credential read and canonical coordinator", async () => {
    const f = await legacyScopeFixture();
    const { verifyAndBindShopifyIntegrationCredential } = await import(
      "@/lib/weletic/shopify/store-resolver"
    );
    const installation = await db.installedIntegration.findUniqueOrThrow({
      where: { id: f.storeId },
      select: { id: true, credentials: true },
    });
    const [store] = await db.$queryRaw<
      Array<{ installationGeneration: string }>
    >`SELECT installationGeneration FROM WeleticShopifyStore WHERE id=${f.storeId}`;
    const alias = `alias-${randomUUID()}.myshopify.com`;
    const result = await verifyAndBindShopifyIntegrationCredential({
      installation,
      expectedStore: {
        id: f.storeId,
        installationGeneration: store.installationGeneration,
      },
      expectedShopDomain: alias,
      customFetch: vi.fn(async () =>
        Response.json({
          data: { shop: { myshopifyDomain: alias, currencyCode: "USD" } },
        }),
      ),
    });
    expect(result?.shop).toBe(alias);
    const persisted = await db.installedIntegration.findUniqueOrThrow({
      where: { id: f.storeId },
      select: { credentials: true },
    });
    expect(persisted.credentials).toMatchObject({
      shop: alias,
      installationGeneration: store.installationGeneration,
    });
    const state = await db.weleticShopifySessionCoordination.findFirstOrThrow({
      where: f.target,
    });
    expect(state.revision).toBe(BigInt(1));
    expect(
      await db.weleticShopifySessionCoordination.count({
        where: { appId, shop: alias },
      }),
    ).toBe(0);
  });

  async function privacy(
    target: ReturnType<typeof scope>,
    topic: "shop/redact" | "app/uninstalled" | "customers/data_request",
  ) {
    const { handlePendingInstallationPrivacy } = await import(
      "@/lib/weletic/shopify/pending-installation-privacy"
    );
    return db.$transaction((tx) =>
      handlePendingInstallationPrivacy(
        tx,
        target,
        topic,
        topic === "app/uninstalled" ? new Date(Date.now() - 1000) : null,
      ),
    );
  }
  async function credentialFixture(
    credentialScope = "read_orders",
    workspaceId = "fixture-workspace",
  ) {
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
    const target = scope();
    const pending = await authenticate(target);
    const storeId = randomUUID();
    mappedStores.push(storeId);
    const identity = {
      ...target,
      storeId,
      workspaceId,
      installationGeneration: pending.installationGeneration!,
    };
    await db.$executeRaw`INSERT INTO WeleticShopifyStore (id, shopDomain, projectId, installationGeneration)
      VALUES (${storeId}, ${target.shop}, ${workspaceId}, ${identity.installationGeneration})`;
    await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation
      SET state='mapped', mappedStoreId=${storeId} WHERE id=${pending.id}`;
    const services = await import(
      "../../lib/weletic/shopify/store-owned-credential"
    );
    const material = {
      accessToken: "synthetic-isolated-token",
      scope: credentialScope,
    };
    const publish = (expectedRevision: number | null) =>
      db.$transaction((tx) =>
        services.publishStoreOwnedShopifyCredential(tx, {
          identity,
          material,
          expectedRevision,
        }),
      );
    return { identity, material, services, publish };
  }
  /** Actual SDK, signing client, backend handlers and MySQL transactions.
   * Only HTTP dispatch and Shopify's provider response are intercepted. No
   * request can fall through to the network, and no backend authority is mocked.
   */
  async function sdkSqlTransport(shop: string) {
    const secret = "synthetic-sdk-sql-service-secret-32-characters";
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    vi.stubEnv("SHOPIFY_API_SECRET", "synthetic-sdk-sql-app-secret");
    vi.stubEnv("SCOPES", "read_products");
    vi.stubEnv("SHOPIFY_APP_URL", "https://shopify-runtime.invalid");
    vi.stubEnv("WELETIC_API_URL", "https://session-gateway.invalid");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const sessionRoute = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const coordinationRoute = await import(
      "../../app/api/internal/shopify/sessions/coordination/route"
    );
    const controls = {
      providerCalls: 0,
      publicationCalls: 0,
      failProvider: false,
      beforeProviderResponse: null as (() => Promise<void>) | null,
      publicationResults: [] as Array<{ status: number; error?: string }>,
      coordinationErrors: [] as Array<{ status: number; error: string }>,
    };
    vi.stubGlobal(
      "fetch",
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "session-gateway.invalid") {
          if (url.pathname === "/api/internal/shopify/sessions/coordination") {
            const response = await (request.method === "GET"
              ? coordinationRoute.GET(request)
              : coordinationRoute.POST(request));
            if (!response.ok) {
              const result = await response.clone().json();
              controls.coordinationErrors.push({
                status: response.status,
                error: result.error,
              });
            }
            return response;
          }
          if (
            url.pathname === "/api/internal/shopify/sessions/coordinated" &&
            request.method === "POST"
          ) {
            controls.publicationCalls++;
            const response = await sessionRoute.POST(request);
            const result = await response.clone().json();
            controls.publicationResults.push({
              status: response.status,
              ...(result.error ? { error: result.error } : {}),
            });
            return response;
          }
          if (
            url.pathname === "/api/internal/shopify/sessions" &&
            request.method === "GET"
          ) {
            return sessionRoute.GET(request);
          }
          throw new Error("Unexpected synthetic backend operation");
        }
        if (
          url.hostname === shop &&
          url.pathname === "/admin/oauth/access_token"
        ) {
          controls.providerCalls++;
          expect(await request.clone().json()).toMatchObject({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            requested_token_type:
              "urn:shopify:params:oauth:token-type:offline-access-token",
          });
          if (controls.failProvider)
            throw new Error("Synthetic provider unavailable");
          await controls.beforeProviderResponse?.();
          return Response.json({
            access_token: "synthetic-sdk-sql-token",
            scope: "read_products",
            expires_in: 3600,
            refresh_token: "synthetic-sdk-sql-refresh",
            refresh_token_expires_in: 7_776_000,
          });
        }
        if (
          url.hostname === shop &&
          /^\/admin\/api\/\d{4}-\d{2}\/graphql.json$/.test(url.pathname)
        ) {
          return Response.json({
            data: {
              currentAppInstallation: {
                accessScopes: [{ handle: "read_products" }],
              },
            },
          });
        }
        throw new Error("Unexpected synthetic transport destination");
      },
    );
    const sdk = await import(
      "../../../../packages/shopify-app/app/shopify.server"
    );
    const request = () => {
      const now = Math.floor(Date.now() / 1000);
      const encoded = [
        Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
          "base64url",
        ),
        Buffer.from(
          JSON.stringify({
            iss: `https://${shop}/admin`,
            dest: `https://${shop}`,
            aud: appId,
            sub: "123",
            iat: now - 1,
            nbf: now - 1,
            exp: now + 60,
            sid: "synthetic-sdk-sql-session",
            jti: randomUUID(),
          }),
        ).toString("base64url"),
      ].join(".");
      const token = `${encoded}.${createHmac("sha256", "synthetic-sdk-sql-app-secret").update(encoded).digest("base64url")}`;
      return new Request(`https://shopify-runtime.invalid/?shop=${shop}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    };
    return { controls, authenticate: () => sdk.authenticate.admin(request()) };
  }

  it("publishes fresh SDK authentication through signed backend routes into native SQL ownership without an installer", async () => {
    const f = await credentialFixture("read_products", randomUUID());
    const transport = await sdkSqlTransport(f.identity.shop);
    const result = await transport.authenticate().catch((error) => {
      expect(transport.controls.publicationResults).toEqual([{ status: 200 }]);
      throw error;
    });
    expect(result.session.accessToken).toBe("synthetic-sdk-sql-token");
    expect(transport.controls.providerCalls).toBe(1);
    expect(transport.controls.publicationCalls).toBe(1);
    const native = await db.$transaction((tx) =>
      f.services.readStoreOwnedShopifyCredential(tx, f.identity),
    );
    expect(native).toMatchObject({
      accessToken: "synthetic-sdk-sql-token",
      scope: "read_products",
      revision: 1,
    });
    const session = await db.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${f.identity.shop}` },
    });
    expect(session.payload).not.toContain("synthetic-sdk-sql-token");
    const [state] = await db.$queryRaw<
      Array<{ revision: bigint; leaseExpiresAt: Date | null }>
    >`
      SELECT revision, leaseExpiresAt FROM WeleticShopifySessionCoordination WHERE appId=${appId} AND shop=${f.identity.shop}`;
    expect(Number(state.revision)).toBe(1);
    // Released leases retain the owner digest to reject acquisition replay.
    expect(state.leaseExpiresAt).toBeNull();
    expect(
      await db.installedIntegration.count({
        where: { projectId: f.identity.workspaceId },
      }),
    ).toBe(0);
    const [store] = await db.$queryRaw<
      Array<{ storeAccessState: string }>
    >`SELECT storeAccessState FROM WeleticShopifyStore WHERE id=${f.identity.storeId}`;
    expect(store.storeAccessState).toBe("pending_approval");
  });

  it("rejects competing SDK authentication while the first exchange owns the SQL lease", async () => {
    const f = await credentialFixture("read_products", randomUUID());
    const transport = await sdkSqlTransport(f.identity.shop);
    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const held = new Promise<void>((resolve) => (releaseProvider = resolve));
    const entered = new Promise<void>((resolve) => (providerEntered = resolve));
    transport.controls.beforeProviderResponse = async () => {
      providerEntered();
      await held;
    };
    // Attach rejection handling immediately; always release and join the first
    // operation before fixture cleanup, even when a race assertion fails.
    const first = transport.authenticate().then(
      () => true,
      () => false,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered,
        first.then(() => {
          throw new Error("First authentication ended before provider barrier");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Provider barrier timed out")),
            5000,
          );
        }),
      ]);
      await expect(transport.authenticate()).rejects.toBeDefined();
      expect(transport.controls.coordinationErrors).toEqual([
        { status: 409, error: "lease_busy" },
      ]);
      expect(transport.controls.providerCalls).toBe(1);
      expect(transport.controls.publicationCalls).toBe(0);
    } finally {
      clearTimeout(timer);
      releaseProvider();
      await first;
    }
    expect(await first).toBe(true);
    expect(transport.controls.publicationCalls).toBe(1);
    const native = await db.$transaction((tx) =>
      f.services.readStoreOwnedShopifyCredential(tx, f.identity),
    );
    expect(native).toMatchObject({ revision: 1 });
    const [state] = await db.$queryRaw<
      Array<{ revision: bigint; leaseExpiresAt: Date | null }>
    >`SELECT revision, leaseExpiresAt FROM WeleticShopifySessionCoordination WHERE appId=${appId} AND shop=${f.identity.shop}`;
    expect(Number(state.revision)).toBe(1);
    expect(state.leaseExpiresAt).toBeNull();
  });

  it("rejects an in-flight SDK exchange after SQL generation rotation and accepts fresh authentication", async () => {
    const f = await credentialFixture("read_products", randomUUID());
    const transport = await sdkSqlTransport(f.identity.shop);
    const nextGeneration = randomUUID();
    const { revokeShopifySessionCoordination } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    transport.controls.beforeProviderResponse = async () => {
      // Explicit lifecycle fixture, not a claim of webhook/reinstall coverage.
      // Preserve production lock ordering: Store, coordinator, admission.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id=${f.identity.storeId} FOR UPDATE`;
        await revokeShopifySessionCoordination(tx, {
          appId,
          shop: f.identity.shop,
        });
        await tx.$executeRaw`UPDATE WeleticShopifyStore SET installationGeneration=${nextGeneration} WHERE id=${f.identity.storeId}`;
        await tx.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET installationGeneration=${nextGeneration}, revision=revision+1 WHERE mappedStoreId=${f.identity.storeId} AND appId=${appId}`;
      });
    };
    await expect(transport.authenticate()).rejects.toBeDefined();
    expect(
      await db.weleticShopifyAppSession.count({
        where: { shop: f.identity.shop },
      }),
    ).toBe(0);
    const [count] = await db.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*) AS total FROM WeleticShopifyInstallationCredential WHERE storeId=${f.identity.storeId}`;
    expect(Number(count.total)).toBe(0);
    const [store] = await db.$queryRaw<
      Array<{ installationGeneration: string; storeAccessState: string }>
    >`SELECT installationGeneration, storeAccessState FROM WeleticShopifyStore WHERE id=${f.identity.storeId}`;
    expect(store).toMatchObject({
      installationGeneration: nextGeneration,
      storeAccessState: "pending_approval",
    });
    transport.controls.beforeProviderResponse = null;
    await transport.authenticate();
    const native = await db.$transaction((tx) =>
      f.services.readStoreOwnedShopifyCredential(tx, {
        ...f.identity,
        installationGeneration: nextGeneration,
      }),
    );
    expect(native).toMatchObject({ revision: 1 });
    expect(transport.controls.providerCalls).toBe(2);
  });

  it("recovers prepared mapped reinstall through actual SDK and SQL after a provider failure without enabling loyalty", async () => {
    const f = await mappedReconnectFixture();
    await f.prepare();
    const [prepared] = await db.$queryRaw<
      Array<{ installationGeneration: string }>
    >`SELECT installationGeneration FROM WeleticShopifyStore WHERE id=${f.storeId}`;
    const transport = await sdkSqlTransport(f.actor.shop);
    transport.controls.failProvider = true;
    await expect(transport.authenticate()).rejects.toBeDefined();
    expect(transport.controls.publicationCalls).toBe(0);
    expect(
      await db.weleticShopifyInstallationCredential.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    transport.controls.failProvider = false;
    await transport.authenticate();
    expect(transport.controls.providerCalls).toBe(2);
    expect(transport.controls.publicationCalls).toBe(1);
    const credential =
      await db.weleticShopifyInstallationCredential.findUniqueOrThrow({
        where: { storeId_appId: { storeId: f.storeId, appId } },
      });
    expect(credential.installationGeneration).toBe(
      prepared.installationGeneration,
    );
    expect(credential.installationGeneration).not.toBe(
      f.fixture.identity.installationGeneration,
    );
    expect(
      await db.installedIntegration.count({ where: { projectId: f.storeId } }),
    ).toBe(0);
    const [state] = await db.$queryRaw<
      Array<{
        status: string;
        killSwitchActive: number;
        storeAccessState: string;
      }>
    >`
      SELECT p.status, p.killSwitchActive, s.storeAccessState FROM WeleticLoyaltyProgram p
      JOIN WeleticShopifyStore s ON s.id=p.storeId WHERE s.id=${f.storeId}`;
    expect(state).toMatchObject({
      status: "disabled",
      storeAccessState: "pending_approval",
    });
    expect(Boolean(state.killSwitchActive)).toBe(true);
  });

  it("rolls back SDK payload, native credential and coordinator revision together on SQL publication failure", async () => {
    const f = await credentialFixture("read_products", randomUUID());
    const transport = await sdkSqlTransport(f.identity.shop);
    if (!/^[a-f0-9-]{36}$/.test(f.identity.storeId))
      throw new Error("Invalid synthetic fixture ID");
    await db.$executeRawUnsafe(`ALTER TABLE WeleticShopifyInstallationCredential
      ADD CONSTRAINT reject_sdk_sql_fixture CHECK (storeId <> '${f.identity.storeId}')`);
    try {
      await expect(transport.authenticate()).rejects.toBeDefined();
      expect(transport.controls.publicationResults).toEqual([
        { status: 500, error: "Unable to store Shopify session" },
      ]);
      expect(
        await db.weleticShopifyAppSession.count({
          where: { shop: f.identity.shop },
        }),
      ).toBe(0);
      expect(
        await db.weleticShopifyInstallationCredential.count({
          where: { storeId: f.identity.storeId },
        }),
      ).toBe(0);
      const [state] = await db.$queryRaw<
        Array<{ revision: bigint; leaseExpiresAt: Date | null }>
      >`
        SELECT revision, leaseExpiresAt FROM WeleticShopifySessionCoordination WHERE appId=${appId} AND shop=${f.identity.shop}`;
      expect(Number(state.revision)).toBe(0);
      expect(state.leaseExpiresAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe(
        "ALTER TABLE WeleticShopifyInstallationCredential DROP CHECK reject_sdk_sql_fixture",
      );
    }
    // Recovery is a fresh SDK operation, not re-use of the failed lease.
    await transport.authenticate();
    expect(transport.controls.publicationResults.at(-1)).toEqual({
      status: 200,
    });
    expect(
      await db.weleticShopifyInstallationCredential.count({
        where: { storeId: f.identity.storeId },
      }),
    ).toBe(1);
  });

  async function inventoryFixture() {
    const { SHOPIFY_INTEGRATION_ID } = await import("@dub/utils");
    if (!inventoryCatalogIds.includes(SHOPIFY_INTEGRATION_ID)) {
      inventoryCatalogIds.push(SHOPIFY_INTEGRATION_ID);
      await db.$executeRaw`INSERT INTO Integration (id, projectId, name, slug, verified, comingSoon)
        VALUES (${SHOPIFY_INTEGRATION_ID}, 'fixture-catalog-owner', 'Shopify', 'shopify', true, false)`;
    }
    const f = await credentialFixture("read_orders", randomUUID());
    const { readWorkspaceIntegrationInventory } = await import(
      "@/lib/weletic/shopify/integration-inventory"
    );
    return {
      ...f,
      catalogId: SHOPIFY_INTEGRATION_ID,
      read: () => readWorkspaceIntegrationInventory(f.identity.workspaceId),
      readWorkspaceIntegrationInventory,
    };
  }

  it("discovers mapped pending Shopify configuration with no generic installer or credential row", async () => {
    const f = await inventoryFixture();
    const rows = await f.read();
    expect(rows.map((row) => row.id)).toEqual([f.catalogId]);
    expect(JSON.stringify(rows)).not.toContain(f.identity.shop);
    expect(JSON.stringify(rows)).not.toContain(f.identity.storeId);
    expect(rows[0]).not.toHaveProperty("credentials");
    expect(rows[0]).not.toHaveProperty("installations");
    const [counts] = await db.$queryRaw<
      Array<{ genericRows: bigint; credentialRows: bigint }>
    >`
      SELECT (SELECT COUNT(*) FROM InstalledIntegration WHERE projectId=${f.identity.workspaceId}) AS genericRows,
      (SELECT COUNT(*) FROM WeleticShopifyInstallationCredential WHERE storeId=${f.identity.storeId}) AS credentialRows`;
    expect(Number(counts.genericRows)).toBe(0);
    expect(Number(counts.credentialRows)).toBe(0);
  });

  it("excludes foreign workspace, foreign app and redacted native inventory in actual SQL", async () => {
    const f = await inventoryFixture();
    expect(await f.readWorkspaceIntegrationInventory(randomUUID())).toEqual([]);
    vi.stubEnv("SHOPIFY_API_KEY", "foreign-app");
    expect(await f.read()).toEqual([]);
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state='redacted' WHERE mappedStoreId=${f.identity.storeId}`;
    expect(await f.read()).toEqual([]);
    await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state='mapped' WHERE mappedStoreId=${f.identity.storeId}`;
    await db.$executeRaw`UPDATE WeleticShopifyStore SET complianceState='redacted' WHERE id=${f.identity.storeId}`;
    expect(await f.read()).toEqual([]);
  });

  it("lists retained uninstall mappings for recovery and deduplicates a legacy row", async () => {
    const f = await inventoryFixture();
    await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state='uninstalled' WHERE mappedStoreId=${f.identity.storeId}`;
    await db.$executeRaw`UPDATE WeleticShopifyStore SET complianceState='frozen' WHERE id=${f.identity.storeId}`;
    expect((await f.read()).map((row) => row.id)).toEqual([f.catalogId]);
    const legacyId = randomUUID();
    try {
      await db.$executeRaw`INSERT INTO InstalledIntegration (id, projectId, integrationId) VALUES (${legacyId}, ${f.identity.workspaceId}, ${f.catalogId})`;
      expect((await f.read()).map((row) => row.id)).toEqual([f.catalogId]);
    } finally {
      await db.$executeRaw`DELETE FROM InstalledIntegration WHERE id=${legacyId}`;
    }
  });

  it("rejects a legacy callback after concurrent first public authentication with no Store", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    const target = scope();
    const { lockLegacyShopifyConnection } = await import(
      "../../lib/weletic/shopify/legacy-connection-fence"
    );
    const { lockShopifySessionLifecycle } = await import(
      "../../lib/weletic/shopify/session-lifecycle-fence"
    );
    const { ensureShopifySessionCoordination } = await import(
      "../../lib/weletic/shopify/session-coordination"
    );
    const { ensurePendingInstallationAfterAuthentication } = await import(
      "../../lib/weletic/shopify/installation-admission"
    );
    // SDK lease acquisition normally establishes the coordinator before its
    // provider exchange. There is still no Store, admission or credential here.
    await db.$transaction((tx) => ensureShopifySessionCoordination(tx, target));
    let signalLocked!: () => void;
    let releaseAuth!: () => void;
    let callbackAtCoordinator!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const attempted = new Promise<void>((resolve) => {
      callbackAtCoordinator = resolve;
    });
    const authentication = db.$transaction(
      async (tx) => {
        await lockShopifySessionLifecycle({
          tx,
          shop: target.shop,
          storeId: null,
        });
        await ensureShopifySessionCoordination(tx, target);
        signalLocked();
        await gate;
        return ensurePendingInstallationAfterAuthentication(
          tx,
          target,
          new Date(),
        );
      },
      { timeout: 10_000 },
    );
    await locked;
    const callback = db.$transaction(
      async (tx) => {
        const instrumented = new Proxy(tx, {
          get(client, property) {
            if (property === "$executeRaw")
              return (...args: Parameters<typeof tx.$executeRaw>) => {
                // Real SQL is unchanged; signal only when the callback has passed
                // its real Store/tombstone reads and attempts coordinator locking.
                callbackAtCoordinator();
                return client.$executeRaw(...args);
              };
            const value = Reflect.get(client, property);
            return typeof value === "function" ? value.bind(client) : value;
          },
        });
        await lockLegacyShopifyConnection(instrumented, {
          workspaceId: randomUUID(),
          shop: target.shop,
        });
      },
      { timeout: 10_000 },
    );
    // Attach rejection handling before releasing the competing transaction.
    const rejected = expect(callback).rejects.toThrow("managed by Shopify");
    try {
      await attempted;
    } finally {
      releaseAuth();
    }
    const admitted = await authentication;
    await rejected;
    expect(
      await db.weleticShopifyPendingInstallation.count({
        where: { id: admitted.id, appId },
      }),
    ).toBe(1);
    const rows = await db.$queryRaw<
      Array<{ total: bigint }>
    >`SELECT COUNT(*) AS total FROM WeleticShopifyStore WHERE shopDomain=${target.shop}`;
    expect(Number(rows[0].total)).toBe(0);
  });
  async function mappedReconnectFixture() {
    const fixture = await credentialFixture();
    const { storeId, shop } = fixture.identity;
    const cutoff = new Date(Date.now() - 10_000);
    await db.$executeRaw`INSERT INTO Project (id) VALUES (${storeId})`;
    await db.$executeRaw`UPDATE WeleticShopifyStore SET projectId=${storeId}, complianceState='frozen',
      uninstalledAt=${cutoff}, storeAccessState='active' WHERE id=${storeId}`;
    await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state='uninstalled', uninstalledAt=${cutoff}
      WHERE mappedStoreId=${storeId}`;
    await db.$executeRaw`INSERT INTO WeleticLoyaltyProgram (id, storeId, status, killSwitchActive)
      VALUES (${storeId}, ${storeId}, 'disabled', true)`;
    await db.$executeRaw`INSERT INTO WeleticShopifyStaffGrant (id, storeId, appId) VALUES (${storeId}, ${storeId}, ${appId})`;
    await db.$executeRaw`INSERT INTO WeleticShopifyComplianceRequest
      (id, storeId, shopDomain, requestType, status, phase, triggeredAt, receivedAt, completedAt)
      VALUES (${storeId}, ${storeId}, ${shop}, 'app_uninstalled', 'completed', 'completed', ${cutoff}, ${cutoff}, CURRENT_TIMESTAMP(3))`;
    const service = await import(
      "../../lib/weletic/shopify/installation-reconnect"
    );
    const actor = {
      appId,
      shop,
      userId: "123",
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
    const observation = await db.$transaction((tx) =>
      service.observePendingInstallationReconnect(tx, actor),
    );
    const prepare = () =>
      db.$transaction((tx) =>
        service.preparePendingInstallationReconnect(tx, actor, observation),
      );
    return { fixture, storeId, actor, observation, service, prepare };
  }
  it("reconnects a scrubbed mapped Store once and requires fresh native authentication before approval", async () => {
    const f = await mappedReconnectFixture();
    const outcomes = await Promise.allSettled([f.prepare(), f.prepare()]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const [store] = await db.$queryRaw<
      Array<{
        installationGeneration: string;
        storeAccessState: string;
        storeAccessRevision: number;
      }>
    >`
      SELECT installationGeneration, storeAccessState, storeAccessRevision FROM WeleticShopifyStore WHERE id=${f.storeId}`;
    expect(store).toMatchObject({
      storeAccessState: "pending_approval",
      storeAccessRevision: 2,
    });
    expect(store.installationGeneration).not.toBe(
      f.fixture.identity.installationGeneration,
    );
    expect(
      await db.weleticShopifyStaffGrant.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    const { changeShopifyStoreAccess } = await import(
      "../../lib/weletic/shopify/store-access-operator"
    );
    const approval = {
      storeId: f.storeId,
      shopDomain: f.actor.shop,
      expectedInstallationGeneration: store.installationGeneration,
      expectedRevision: 2,
      nextState: "active",
      operator: "isolated-test",
      reason: "Synthetic store approval",
      apply: true,
    };
    await expect(changeShopifyStoreAccess(approval)).rejects.toThrow(
      "fresh Shopify authentication",
    );
    // Synthetic publication invokes the actual encrypted persistence primitive;
    // it does not claim an SDK exchange or remote Shopify acceptance.
    await db.$transaction((tx) =>
      f.fixture.services.publishStoreOwnedShopifyCredential(tx, {
        identity: {
          ...f.fixture.identity,
          workspaceId: f.storeId,
          installationGeneration: store.installationGeneration,
        },
        material: f.fixture.material,
        expectedRevision: null,
      }),
    );
    await expect(changeShopifyStoreAccess(approval)).resolves.toMatchObject({
      applied: true,
      revision: 3,
    });
    const programs = await db.$queryRaw<
      Array<{ status: string; killSwitchActive: number }>
    >`SELECT status, killSwitchActive FROM WeleticLoyaltyProgram WHERE storeId=${f.storeId}`;
    expect(programs).toEqual([{ status: "disabled", killSwitchActive: 1 }]);
    expect(
      await db.installedIntegration.count({ where: { projectId: f.storeId } }),
    ).toBe(0);
  });
  it("rolls back mapped reconnect generation, approval, grants and audits together", async () => {
    const f = await mappedReconnectFixture();
    const before = await db.weleticShopifySessionCoordination.findFirstOrThrow({
      where: { appId, shop: f.actor.shop },
    });
    await expect(
      db.$transaction(async (tx) => {
        await f.service.preparePendingInstallationReconnect(
          tx,
          f.actor,
          f.observation,
        );
        throw new Error("injected mapped reconnect rollback");
      }),
    ).rejects.toThrow("injected mapped reconnect rollback");
    const [store] = await db.$queryRaw<
      Array<{
        installationGeneration: string;
        storeAccessState: string;
        storeAccessRevision: number;
      }>
    >`
      SELECT installationGeneration, storeAccessState, storeAccessRevision FROM WeleticShopifyStore WHERE id=${f.storeId}`;
    expect(store).toEqual({
      installationGeneration: f.fixture.identity.installationGeneration,
      storeAccessState: "active",
      storeAccessRevision: 1,
    });
    expect(
      await db.weleticShopifyStaffGrant.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
    expect(
      await db.weleticShopifyStoreAccessChange.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await db.weleticShopifyPendingInstallationChange.count({
        where: { mappedStoreId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await db.weleticShopifySessionCoordination.findFirstOrThrow({
        where: { appId, shop: f.actor.shop },
      }),
    ).toEqual(before);
  });
  it("rejects a stale administrative disconnect after a locked generation replacement", async () => {
    const fixture = await credentialFixture();
    const { persistAndQueueInternalShopifyDisconnect } = await import(
      "../../lib/weletic/shopify/compliance-ingress"
    );
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id=${fixture.identity.storeId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE WeleticShopifyStore SET installationGeneration='replacement-generation' WHERE id=${fixture.identity.storeId}`;
    });
    await expect(
      persistAndQueueInternalShopifyDisconnect({
        storeId: fixture.identity.storeId,
        canonicalShopDomain: fixture.identity.shop,
        idempotencyKey: "synthetic-stale-disconnect",
        expectedInstallationGeneration: fixture.identity.installationGeneration,
      }),
    ).rejects.toThrow("installation changed");
    expect(
      await db.weleticShopifyComplianceRequest.count({
        where: { storeId: fixture.identity.storeId },
      }),
    ).toBe(0);
    const [store] = await db.$queryRaw<
      Array<{ complianceState: string; installationGeneration: string }>
    >`
      SELECT complianceState, installationGeneration FROM WeleticShopifyStore WHERE id=${fixture.identity.storeId}`;
    expect(store).toEqual({
      complianceState: "active",
      installationGeneration: "replacement-generation",
    });
  });
  it("serializes native credential creation and rotation with one revision winner", async () => {
    const fixture = await credentialFixture();
    for (const expectedRevision of [null, 1]) {
      const outcomes = await Promise.allSettled([
        fixture.publish(expectedRevision),
        fixture.publish(expectedRevision),
      ]);
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = outcomes.find((result) => result.status === "rejected");
      expect(
        rejected?.status === "rejected" && rejected.reason.message,
      ).toContain("revision fence");
    }
    const stored = await db.weleticShopifyInstallationCredential.findMany({
      where: { storeId: fixture.identity.storeId, appId },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].revision).toBe(2);
    expect(stored[0].credentialCiphertext).not.toContain(
      fixture.material.accessToken,
    );
    expect(
      await db.$transaction((tx) =>
        fixture.services.readStoreOwnedShopifyCredential(tx, fixture.identity),
      ),
    ).toEqual({ ...fixture.material, revision: 2 });
  });
  it("reads public native authority transactionally and refuses missing-admission downgrade", async () => {
    const fixture = await credentialFixture();
    await fixture.publish(null);
    const { readShopifyCredentialSource } = await import(
      "../../lib/weletic/shopify/credential-source"
    );
    const { appId: ignoredApp, ...input } = fixture.identity;
    expect(await readShopifyCredentialSource(input)).toEqual({
      source: "native",
      ...fixture.material,
      revision: 1,
      installationGeneration: input.installationGeneration,
    });
    await expect(
      readShopifyCredentialSource({
        ...input,
        workspaceId: "foreign-workspace",
      }),
    ).rejects.toThrow("identity changed");
    await db.weleticShopifyPendingInstallation.deleteMany({
      where: { appId, mappedStoreId: input.storeId },
    });
    await expect(readShopifyCredentialSource(input)).rejects.toThrow(
      "requires its admission",
    );
    expect(
      await db.weleticShopifyInstallationCredential.count({
        where: { storeId: input.storeId, appId },
      }),
    ).toBe(1);
  });
  it("authorizes frozen credential reads only through a live linked uninstall cleanup", async () => {
    const fixture = await credentialFixture("write_discounts");
    await fixture.publish(null);
    const { encrypt } = await import("../../lib/encryption");
    const { storeId, shop, installationGeneration } = fixture.identity;
    const cleanupId = randomUUID();
    const requestId = randomUUID();
    const payload = encrypt(
      JSON.stringify({ shopDomain: shop, installationGeneration }),
    );
    await db.$executeRaw`UPDATE WeleticShopifyStore SET complianceState='frozen' WHERE id=${storeId}`;
    await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state='uninstalled', uninstalledAt=CURRENT_TIMESTAMP(3) WHERE mappedStoreId=${storeId}`;
    await db.$executeRaw`INSERT INTO WeleticShopifyComplianceRequest (id, storeId, requestType, status, shopDomain, phase, payloadCiphertext)
      VALUES (${requestId}, ${storeId}, 'app_uninstalled', 'processing', ${shop}, 'voucher_cleanup', ${payload})`;
    await db.$executeRaw`INSERT INTO WeleticShopifyVoucherCleanup (id, storeId, redemptionId, source, status, lockedBy, lockedAt, leaseVersion, expectedDiscountCodeCanonical)
      VALUES (${cleanupId}, ${storeId}, 'redemption-fixture', 'app_uninstalled', 'processing', 'worker-fixture', CURRENT_TIMESTAMP(3), 1, 'FIXTURE')`;
    await db.$executeRaw`INSERT INTO WeleticShopifyVoucherCleanupRequestLink (id, storeId, requestId, cleanupId)
      VALUES (${randomUUID()}, ${storeId}, ${requestId}, ${cleanupId})`;
    const proof = {
      storeId,
      cleanupId,
      redemptionId: "redemption-fixture",
      source: "app_uninstalled",
      lockOwner: "worker-fixture",
      leaseVersion: 1,
      expectedCode: "FIXTURE",
    };
    const read = () =>
      db.$transaction((tx) =>
        fixture.services.readFrozenStoreOwnedVoucherCredential(tx, proof),
      );
    expect(await read()).toMatchObject({
      ...fixture.material,
      shopDomain: shop,
      installationGeneration,
    });
    await db.$executeRaw`UPDATE WeleticShopifyComplianceRequest SET status='completed' WHERE id=${requestId}`;
    await expect(read()).rejects.toThrow("request is unavailable");
    await db.$executeRaw`UPDATE WeleticShopifyComplianceRequest SET status='processing' WHERE id=${requestId}`;
    await db.$executeRaw`UPDATE WeleticShopifyVoucherCleanup SET lockedAt=DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 6 MINUTE) WHERE id=${cleanupId}`;
    await expect(read()).rejects.toThrow("lease changed");
  });
  it("rolls back native credential creation and erasure on transaction failure", async () => {
    const fixture = await credentialFixture();
    await expect(
      db.$transaction(async (tx) => {
        await fixture.services.publishStoreOwnedShopifyCredential(tx, {
          identity: fixture.identity,
          material: fixture.material,
          expectedRevision: null,
        });
        throw new Error("injected rollback");
      }),
    ).rejects.toThrow("injected rollback");
    expect(
      await db.weleticShopifyInstallationCredential.count({
        where: { storeId: fixture.identity.storeId },
      }),
    ).toBe(0);
    await fixture.publish(null);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id=${fixture.identity.storeId} FOR UPDATE`;
        await tx.weleticShopifyInstallationCredential.deleteMany({
          where: {
            storeId: fixture.identity.storeId,
            appId,
            installationGeneration: fixture.identity.installationGeneration,
          },
        });
        throw new Error("injected erasure rollback");
      }),
    ).rejects.toThrow("injected erasure rollback");
    expect(
      await db.$transaction((tx) =>
        fixture.services.readStoreOwnedShopifyCredential(tx, fixture.identity),
      ),
    ).toEqual({ ...fixture.material, revision: 1 });
  });
  it("rejects native credential refresh after freeze or generation replacement", async () => {
    const fixture = await credentialFixture();
    await fixture.publish(null);
    await db.$executeRaw`UPDATE WeleticShopifyStore SET complianceState='frozen' WHERE id=${fixture.identity.storeId}`;
    await expect(fixture.publish(1)).rejects.toThrow("Frozen Shopify");
    await db.$executeRaw`UPDATE WeleticShopifyStore SET complianceState='active', installationGeneration='new-generation' WHERE id=${fixture.identity.storeId}`;
    await expect(fixture.publish(1)).rejects.toThrow(
      "identity or generation changed",
    );
    const stored =
      await db.weleticShopifyInstallationCredential.findFirstOrThrow({
        where: { storeId: fixture.identity.storeId, appId },
      });
    expect(stored.revision).toBe(1);
    expect(stored.installationGeneration).toBe(
      fixture.identity.installationGeneration,
    );
  });
  it("publishes one stable pending generation for concurrent authentication", async () => {
    const target = scope();
    const storeCountBefore = await db.weleticShopifyStore.count();
    const records = await Promise.all([
      authenticate(target),
      authenticate(target),
    ]);
    expect(records[0].id).toBe(records[1].id);
    expect(records[0].installationGeneration).toBe(
      records[1].installationGeneration,
    );
    expect(records[0].state).toBe("pending_approval");
    expect(records[0].mappedStoreId).toBeNull();
    expect(await db.weleticShopifyStore.count()).toBe(storeCountBefore);
    expect(
      await db.weleticShopifyStore.count({
        where: { shopDomain: target.shop },
      }),
    ).toBe(0);
  });
  it("revokes an acquired lease and refuses stale renewal after uninstall", async () => {
    const target = scope();
    await authenticate(target);
    const { acquireShopifySessionLease, renewShopifySessionLease } =
      await import("@/lib/weletic/shopify/session-coordination");
    const lease = await db.$transaction((tx) =>
      acquireShopifySessionLease(tx, target, "a".repeat(64), {
        epoch: "0",
        revision: "0",
      }),
    );
    expect(await privacy(target, "app/uninstalled")).toEqual({
      disposition: "uninstalled",
    });
    await expect(
      db.$transaction((tx) => renewShopifySessionLease(tx, lease)),
    ).rejects.toMatchObject({ code: "stale_session" });
    await expect(authenticate(target)).rejects.toThrow("lifecycle review");
  });
  it("does not recreate raw-shop coordination state on repeated redaction", async () => {
    const target = scope();
    const record = await authenticate(target);
    await db.weleticShopifyAppSession.create({
      data: {
        id: `offline_${target.shop}`,
        shop: target.shop,
        isOnline: false,
        payload: "synthetic-private-payload",
      },
    });
    await privacy(target, "shop/redact");
    expect(await privacy(target, "shop/redact")).toEqual({
      disposition: "already_redacted",
    });
    await privacy(target, "customers/data_request");
    expect(
      await db.weleticShopifySessionCoordination.count({ where: target }),
    ).toBe(0);
    expect(
      await db.weleticShopifyAppSession.count({ where: { shop: target.shop } }),
    ).toBe(0);
    const redacted =
      await db.weleticShopifyPendingInstallation.findUniqueOrThrow({
        where: { id: record.id },
      });
    expect(redacted.state).toBe("redacted");
    expect(redacted.installationGeneration).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain(target.shop);
  });
  async function reconnectFixture() {
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    const target = scope();
    const original = await authenticate(target);
    const { handlePendingInstallationPrivacy } = await import(
      "@/lib/weletic/shopify/pending-installation-privacy"
    );
    await db.$transaction((tx) =>
      handlePendingInstallationPrivacy(
        tx,
        target,
        "app/uninstalled",
        new Date(Date.now() - 10_000),
      ),
    );
    const seconds = Math.floor(Date.now() / 1000);
    const identity = {
      ...target,
      userId: "123",
      issuedAt: seconds - 1,
      expiresAt: seconds + 50,
    };
    const services = await import(
      "@/lib/weletic/shopify/installation-reconnect"
    );
    const observation = await db.$transaction((tx) =>
      services.observePendingInstallationReconnect(tx, identity),
    );
    return { target, original, identity, observation, ...services };
  }
  it("allows one competing reconnect and preserves its generation through publication recovery", async () => {
    const fixture = await reconnectFixture();
    const prepare = () =>
      db.$transaction((tx) =>
        fixture.preparePendingInstallationReconnect(
          tx,
          fixture.identity,
          fixture.observation,
        ),
      );
    const attempts = await Promise.allSettled([prepare(), prepare()]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const loser = attempts.find((result) => result.status === "rejected");
    if (loser?.status !== "rejected")
      throw new Error("Missing reconnect loser");
    expect(loser.reason).toMatchObject({
      message: "Installation reconnect is unavailable or stale",
    });
    const prepared =
      await db.weleticShopifyPendingInstallation.findUniqueOrThrow({
        where: { id: fixture.original.id },
      });
    expect(prepared.state).toBe("pending_approval");
    expect(prepared.mappedStoreId).toBeNull();
    expect(prepared.installationGeneration).not.toBe(
      fixture.original.installationGeneration,
    );
    expect(prepared.revision).toBe(fixture.observation.expectedRevision + 1);
    // Model a provider failure by leaving preparation committed with no session.
    // Ordinary publication recovery must reuse this generation, not approve it.
    expect(
      await db.weleticShopifyAppSession.count({
        where: { shop: fixture.target.shop },
      }),
    ).toBe(0);
    const recovered = await authenticate(fixture.target);
    expect(recovered.installationGeneration).toBe(
      prepared.installationGeneration,
    );
    expect(recovered.revision).toBe(prepared.revision);
    expect(recovered.state).toBe("pending_approval");
    expect(
      await db.weleticShopifyStore.count({
        where: { shopDomain: fixture.target.shop },
      }),
    ).toBe(0);
    await expect(prepare()).rejects.toThrow("unavailable or stale");
  });
  it("rolls back reconnect generation, coordinator revocation and session removal together", async () => {
    const fixture = await reconnectFixture();
    await db.weleticShopifyAppSession.create({
      data: {
        id: `offline_${fixture.target.shop}`,
        shop: fixture.target.shop,
        isOnline: false,
        payload: "synthetic-stale-session",
      },
    });
    const before = await db.weleticShopifySessionCoordination.findFirstOrThrow({
      where: fixture.target,
    });
    await expect(
      db.$transaction(async (tx) => {
        await fixture.preparePendingInstallationReconnect(
          tx,
          fixture.identity,
          fixture.observation,
        );
        throw new Error("injected reconnect commit failure");
      }),
    ).rejects.toThrow("injected reconnect commit failure");
    const after = await db.weleticShopifyPendingInstallation.findUniqueOrThrow({
      where: { id: fixture.original.id },
    });
    expect(after.state).toBe("uninstalled");
    expect(after.installationGeneration).toBe(
      fixture.original.installationGeneration,
    );
    expect(after.revision).toBe(fixture.observation.expectedRevision);
    expect(
      await db.weleticShopifySessionCoordination.findFirstOrThrow({
        where: fixture.target,
      }),
    ).toEqual(before);
    expect(
      await db.weleticShopifyAppSession.count({
        where: { shop: fixture.target.shop },
      }),
    ).toBe(1);
  });
  it("does not persist a raw shop merely for an unknown customer-data request", async () => {
    const target = scope();
    expect(await privacy(target, "customers/data_request")).toEqual({
      disposition: "no_customer_data",
    });
    expect(
      await db.weleticShopifySessionCoordination.count({ where: target }),
    ).toBe(0);
  });
  it("does not extend tombstone retention on replay", async () => {
    const target = scope();
    const record = await authenticate(target);
    await privacy(target, "shop/redact");
    const before = await db.weleticShopifyPendingInstallation.findUniqueOrThrow(
      { where: { id: record.id } },
    );
    await privacy(target, "shop/redact");
    const after = await db.weleticShopifyPendingInstallation.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.revision).toBe(before.revision);
  });
  it("prunes only a bounded set of expired fully redacted admissions", async () => {
    const { deleteExpiredPendingInstallations } = await import(
      "../../lib/weletic/shopify/pending-installation-retention"
    );
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "10");
    const now = new Date();
    const old = new Date(now.getTime() - 20 * 86400000);
    const future = new Date(now.getTime() + 20 * 86400000);
    const records: string[] = [];
    for (let index = 0; index < 7; index++) {
      const target = scope();
      const row = await authenticate(target);
      await privacy(target, "shop/redact");
      await db.weleticShopifyPendingInstallation.update({
        where: { id: row.id },
        data: { redactedAt: old, expiresAt: future },
      });
      records.push(row.id);
    }
    // Both expiry mechanisms are exercised: stored deadline and shorter policy.
    await db.weleticShopifyPendingInstallation.update({
      where: { id: records[0] },
      data: { redactedAt: new Date(now.getTime() - 1000), expiresAt: old },
    });
    for (const [offset, state] of [
      "pending_approval",
      "mapped",
      "uninstalled",
    ].entries())
      await db.weleticShopifyPendingInstallation.update({
        where: { id: records[offset + 2] },
        data: { state: state as "pending_approval" | "mapped" | "uninstalled" },
      });
    await db.weleticShopifyPendingInstallation.update({
      where: { id: records[5] },
      data: { authenticatedAt: old },
    });
    await db.weleticShopifyPendingInstallationChange.create({
      data: {
        id: randomUUID(),
        pendingInstallationId: records[6],
        installationGeneration: "synthetic-generation",
        revision: 1,
        operation: "map",
        operator: "test",
        reason: "Injected inconsistent retained audit",
      },
    });
    expect(
      await db.$transaction((tx) =>
        deleteExpiredPendingInstallations(tx, { now, batchSize: 1 }),
      ),
    ).toBe(1);
    expect(
      await db.$transaction((tx) =>
        deleteExpiredPendingInstallations(tx, { now, batchSize: 100 }),
      ),
    ).toBe(1);
    expect(
      await db.weleticShopifyPendingInstallation.count({
        where: { id: { in: records.slice(0, 2) } },
      }),
    ).toBe(0);
    expect(
      await db.weleticShopifyPendingInstallation.count({
        where: { id: { in: records.slice(2) } },
      }),
    ).toBe(5);
    expect(
      await db.$transaction((tx) =>
        deleteExpiredPendingInstallations(tx, { now, batchSize: 100 }),
      ),
    ).toBe(0);
  });
  it("preserves an admission reopened by a concurrent lock owner", async () => {
    const { deleteExpiredPendingInstallations } = await import(
      "../../lib/weletic/shopify/pending-installation-retention"
    );
    const target = scope();
    const row = await authenticate(target);
    await privacy(target, "shop/redact");
    const now = new Date();
    const expired = new Date(now.getTime() - 86400000);
    await db.weleticShopifyPendingInstallation.update({
      where: { id: row.id },
      data: { redactedAt: expired, expiresAt: expired },
    });
    let locked!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Synthetic competing lifecycle write, not a claim that the reinstall API
    // exists. It owns the row before the cleanup statement can inspect it.
    const reopen = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyPendingInstallation WHERE id = ${row.id} FOR UPDATE`;
      locked();
      await gate;
      await tx.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state = 'pending_approval', installationGeneration = 'new-generation', authenticatedAt = CURRENT_TIMESTAMP(3), redactedAt = NULL, expiresAt = NULL, revision = revision + 1 WHERE id = ${row.id}`;
    });
    await acquired;
    try {
      // Keep the competing row lock until cleanup actually returns; merely
      // scheduling both promises would allow a fully sequential false positive.
      expect(
        await db.$transaction(
          (tx) => deleteExpiredPendingInstallations(tx, { now }),
          { timeout: 2000, maxWait: 1000 },
        ),
      ).toBe(0);
    } finally {
      release();
      await reopen;
    }
    expect(
      await db.weleticShopifyPendingInstallation.findUnique({
        where: { id: row.id },
      }),
    ).toMatchObject({
      state: "pending_approval",
      installationGeneration: "new-generation",
    });
  });
  it.each([true, false])(
    "freezes and erases a provisioned admission atomically (mapped=%s)",
    async (isMapped) => {
      const {
        freezeMappedInstallationAdmission,
        redactMappedInstallationAdmission,
      } = await import("../../lib/weletic/shopify/mapped-installation-privacy");
      vi.stubEnv("SHOPIFY_API_KEY", appId);
      const target = scope();
      const row = await authenticate(target);
      const storeId = randomUUID();
      mappedStores.push(storeId);
      await db.$executeRaw`INSERT INTO WeleticShopifyStore (id, shopDomain) VALUES (${storeId}, ${target.shop})`;
      if (isMapped)
        await db.$executeRaw`UPDATE WeleticShopifyPendingInstallation SET state = 'mapped', mappedStoreId = ${storeId} WHERE id = ${row.id}`;
      await db.weleticShopifyPendingInstallationChange.create({
        data: {
          id: randomUUID(),
          pendingInstallationId: row.id,
          mappedStoreId: isMapped ? storeId : null,
          installationGeneration: row.installationGeneration!,
          revision: 1,
          operation: "map",
          operator: "synthetic-operator",
          reason: "Isolated mapped fixture",
        },
      });
      const mapped = {
        storeId,
        shop: target.shop,
        installationGeneration: row.installationGeneration,
      };
      const cutoff = new Date();
      expect(
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
          return freezeMappedInstallationAdmission(tx, { ...mapped, cutoff });
        }),
      ).toBe("frozen");
      expect(
        await db.weleticShopifyPendingInstallation.findUnique({
          where: { id: row.id },
        }),
      ).toMatchObject({
        state: "uninstalled",
        mappedStoreId: isMapped ? storeId : null,
        installationGeneration: row.installationGeneration,
      });
      const erasure = {
        ...mapped,
        redactedAt: cutoff,
        expiresAt: new Date(cutoff.getTime() + 86400000),
      };
      await expect(
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
          await redactMappedInstallationAdmission(tx, erasure);
          throw new Error("Injected finalization rollback");
        }),
      ).rejects.toThrow("Injected finalization rollback");
      expect(
        await db.weleticShopifyPendingInstallation.findUnique({
          where: { id: row.id },
        }),
      ).toMatchObject({
        state: "uninstalled",
        mappedStoreId: isMapped ? storeId : null,
      });
      expect(
        await db.weleticShopifyPendingInstallationChange.count({
          where: { pendingInstallationId: row.id },
        }),
      ).toBe(1);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
        await redactMappedInstallationAdmission(tx, erasure);
      });
      expect(
        await db.weleticShopifyPendingInstallation.findUnique({
          where: { id: row.id },
        }),
      ).toMatchObject({
        state: "redacted",
        mappedStoreId: null,
        installationGeneration: null,
        authenticatedAt: null,
        uninstalledAt: null,
        expiresAt: erasure.expiresAt,
      });
      expect(
        await db.weleticShopifyPendingInstallationChange.count({
          where: { pendingInstallationId: row.id },
        }),
      ).toBe(0);
    },
  );
});
