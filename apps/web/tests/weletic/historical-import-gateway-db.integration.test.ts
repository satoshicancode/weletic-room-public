import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ShopifyMerchantActorEnvelope } from "../../lib/weletic/shopify/staff-contract";

// Real route, signatures, authorization, native credential binding and SQL.
// Synthetic session records are NOT evidence of Shopify OAuth or browser login.
const database = new PrismaClient();
vi.mock("@/lib/prisma", () => ({ prisma: database }));
const fixtures: Array<{ storeId: string; shop: string }> = [];
const appId = "import-gateway-db";
const path = "/api/internal/shopify/merchant/imports";
let safeToClean = false;
let serviceSecret: string;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const name = process.env.HISTORICAL_IMPORT_SOURCE_FIXTURE_DATABASE;
  if (
    process.env.HISTORICAL_IMPORT_GATEWAY_DATABASE_INTEGRATION !== "1" ||
    process.env.HISTORICAL_IMPORT_DEDICATED_INSTANCE !== "1" ||
    !name ||
    !/^weletic_loyalty_it_import_[a-z0-9_]+$/.test(name) ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3308" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== `/${name}` ||
    url.search ||
    url.hash
  )
    throw new Error("Refusing non-disposable gateway database");
  expect(
    await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
  ).toEqual([{ name, principal: "loyalty_dev@%" }]);
  safeToClean = true;
  serviceSecret = randomBytes(32).toString("hex");
  vi.stubEnv("SHOPIFY_API_KEY", appId);
  vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);
  vi.stubEnv(
    "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
    `gateway:${randomBytes(32).toString("base64")}`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in gateway DB tests");
    }),
  );
});

afterAll(async () => {
  try {
    if (safeToClean && fixtures.length) {
      const ids = fixtures.map((f) => f.storeId);
      const shops = fixtures.map((f) => f.shop);
      const where = { storeId: { in: ids } };
      await database.weleticLoyaltyImportRowExecution.deleteMany({ where });
      await database.weleticLoyaltyImportRowSnapshot.deleteMany({ where });
      await database.weleticLoyaltyImportSource.deleteMany({ where });
      await database.weleticLoyaltyOutboxJob.deleteMany({ where });
      await database.weleticPointsLedgerEntry.deleteMany({ where });
      await database.weleticLoyaltyAccount.deleteMany({ where });
      await database.weleticShopper.deleteMany({ where });
      await database.weleticLoyaltyProgram.deleteMany({ where });
      await database.weleticShopifyMerchantAction.deleteMany({ where });
      await database.weleticShopifyStaffGrant.deleteMany({ where });
      await database.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: shops } },
      });
      await database.weleticShopifySessionCoordination.deleteMany({
        where: { appId, shop: { in: shops } },
      });
      await database.weleticShopifyInstallationCredential.deleteMany({ where });
      await database.weleticShopifyPendingInstallation.deleteMany({
        where: { appId, mappedStoreId: { in: ids } },
      });
      await database.weleticShopifyStore.deleteMany({
        where: { id: { in: ids } },
      });
    }
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  }
});

async function seed(owner = true) {
  const storeId = `gateway-${randomUUID()}`;
  const shop = `${storeId}.myshopify.com`;
  fixtures.push({ storeId, shop });
  const identity = {
    storeId,
    shop,
    appId,
    workspaceId: `workspace-${storeId}`,
    installationGeneration: "g1",
  };
  await database.weleticShopifyStore.create({
    data: {
      id: storeId,
      shopDomain: shop,
      projectId: identity.workspaceId,
      programId: `affiliate-${storeId}`,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      apiVersion: "2026-07",
      installationGeneration: "g1",
      storeAccessState: "active",
    },
  });
  await database.weleticLoyaltyProgram.create({
    data: {
      id: `program-${storeId}`,
      storeId,
      name: "Gateway fixture",
      status: "active",
      killSwitchActive: false,
    },
  });
  await database.weleticShopper.createMany({
    data: ["123", "456"].map((shopifyCustomerId) => ({
      id: `${storeId}-${shopifyCustomerId}`,
      storeId,
      shopifyCustomerId,
    })),
  });
  const { deriveAllShopifyShopPrivacyIdentities } = await import(
    "../../lib/weletic/shopify/privacy-identity"
  );
  await database.weleticShopifyPendingInstallation.create({
    data: {
      id: storeId,
      appId,
      ...deriveAllShopifyShopPrivacyIdentities({ shopDomain: shop })[0],
      installationGeneration: "g1",
      authenticatedAt: new Date(),
      state: "mapped",
      mappedStoreId: storeId,
    },
  });
  const { publishStoreOwnedShopifyCredential } = await import(
    "../../lib/weletic/shopify/store-owned-credential"
  );
  await database.$transaction((tx) =>
    publishStoreOwnedShopifyCredential(tx, {
      identity,
      expectedRevision: null,
      material: {
        accessToken: "synthetic-offline-only",
        scope: "read_customers",
      },
    }),
  );
  const { encrypt } = await import("../../lib/encryption");
  const { bindShopifyOnlineSession } = await import(
    "../../lib/weletic/shopify/session-online-binding"
  );
  const userId = "789";
  const sessionId = `${shop}_${userId}`;
  const expiresAt = new Date(Date.now() + 3_600_000);
  const binding = { appId, storeId, shop, installationGeneration: "g1" };
  const payload = encrypt(
    JSON.stringify(
      bindShopifyOnlineSession(
        [
          ["id", sessionId],
          ["shop", shop],
          ["isOnline", true],
          ["userId", Number(userId)],
          ["accountOwner", owner],
          ["collaborator", false],
          ["associatedUserScope", "read_customers"],
          ["accessToken", "synthetic-online-only"],
          ["expires", expiresAt.getTime()],
        ],
        binding,
      ),
    ),
  );
  await database.weleticShopifyAppSession.create({
    data: { id: sessionId, shop, isOnline: true, payload, expiresAt },
  });
  const actor = (): ShopifyMerchantActorEnvelope => ({
    ...binding,
    version: 1,
    userId,
    sessionId,
    sessionDigest: createHash("sha256").update(payload).digest("hex"),
    authenticatedAt: Date.now(),
    requestId: randomBytes(32).toString("hex"),
  });
  return { ...identity, sessionId, actor };
}

async function send(
  actor: ShopifyMerchantActorEnvelope,
  request: Record<string, unknown>,
  sourceBase64?: string,
  tamper = false,
) {
  const { signWeleticShopifyRequest } = await import(
    "../../lib/weletic/shopify/service-auth"
  );
  const { POST } = await import(
    "../../app/api/internal/shopify/merchant/imports/route"
  );
  const body = JSON.stringify({
    actor,
    request,
    ...(sourceBase64 ? { sourceBase64 } : {}),
  });
  const timestamp = String(Date.now());
  const signature = signWeleticShopifyRequest({
    timestamp,
    method: "POST",
    path,
    body,
    secret: serviceSecret,
  });
  const response = await POST(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      body: tamper ? `${body} ` : body,
      headers: {
        "x-weletic-timestamp": timestamp,
        "x-weletic-signature": signature,
      },
    }),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return { status: response.status, data: await response.json() };
}

async function stage(fixture: Awaited<ReturnType<typeof seed>>) {
  const bytes = Buffer.from(
    JSON.stringify([
      {
        shopifyCustomerId: "gid://shopify/Customer/123",
        openingBalance: "9007199254740993",
      },
      { shopifyCustomerId: "gid://shopify/Customer/456", openingBalance: "7" },
    ]),
  );
  const request = {
    operation: "inspect",
    expectedInstallationGeneration: "g1",
    source: {
      format: "json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  const preview = await send(
    fixture.actor(),
    request,
    bytes.toString("base64"),
  );
  expect(preview.status).toBe(200);
  expect(preview.data).toMatchObject({
    valid: true,
    rowCount: 2,
    totalOpeningBalance: "9007199254741000",
  });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: fixture.storeId },
    }),
  ).toBe(0);
  const staged = await send(
    fixture.actor(),
    { ...request, operation: "stage", expectedRevision: preview.data.revision },
    bytes.toString("base64"),
  );
  expect(staged.status).toBe(200);
  expect(staged.data.status).toBe("preview");
  return staged.data;
}

it("traverses signed native-session preparation, worker commit, reconciliation and rollback", async () => {
  const f = await seed();
  expect((await send(f.actor(), { operation: "context" })).status).toBe(200);
  const staged = await stage(f);
  const sourceId = staged.sourceId as string;
  const read = () =>
    send(f.actor(), {
      operation: "status",
      sourceId,
      expectedInstallationGeneration: "g1",
    });
  for (const operation of ["commit", "rollback"] as const) {
    const before = await read();
    const started = await send(f.actor(), {
      operation,
      sourceId,
      expectedInstallationGeneration: "g1",
      expectedRevision: before.data.revision,
    });
    expect(started.status).toBe(200);
    expect(started.data.status).toBe(
      operation === "commit" ? "committing" : "rolling_back",
    );
    const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: {
        storeId: f.storeId,
        jobType:
          operation === "commit"
            ? "HISTORICAL_IMPORT_COMMIT"
            : "HISTORICAL_IMPORT_ROLLBACK",
      },
    });
    // Test-only scheduling release, not supervised/live worker acceptance.
    await database.weleticLoyaltyImportSource.update({
      where: { id: sourceId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await database.weleticLoyaltyOutboxJob.update({
      where: { id: job.id },
      data: { scheduledFor: new Date(0) },
    });
    const { processOutboxJobsBatch } = await import(
      "../../lib/weletic/loyalty/outbox-worker"
    );
    expect(
      await processOutboxJobsBatch({ storeId: f.storeId, jobIds: [job.id] }),
    ).toMatchObject({ failed: 0, deadLettered: 0, succeeded: 1 });
    const after = await read();
    const proof = await send(f.actor(), {
      operation: "reconcile",
      sourceId,
      expectedInstallationGeneration: "g1",
      expectedRevision: after.data.revision,
    });
    expect(proof.status).toBe(200);
    expect(proof.data).toMatchObject({
      reconciled: true,
      observedNetPoints: operation === "commit" ? "9007199254741000" : "0",
    });
  }
  const totals = await database.$queryRaw<
    Array<{ count: bigint; net: string }>
  >`SELECT COUNT(*) AS count, CAST(SUM(pointsDelta) AS CHAR) AS net FROM WeleticPointsLedgerEntry WHERE storeId = ${f.storeId}`;
  expect(totals).toEqual([{ count: BigInt(4), net: "0" }]);
});

it("rejects modified signed bytes and replays without additional durable actions", async () => {
  const f = await seed();
  const actor = f.actor();
  expect(
    (await send(actor, { operation: "context" }, undefined, true)).status,
  ).toBe(401);
  expect(
    await database.weleticShopifyMerchantAction.count({
      where: { storeId: f.storeId },
    }),
  ).toBe(0);
  expect((await send(actor, { operation: "context" })).status).toBe(200);
  expect((await send(actor, { operation: "context" })).status).toBe(409);
  expect(
    await database.weleticShopifyMerchantAction.count({
      where: { storeId: f.storeId },
    }),
  ).toBe(1);
});

it.each(["expired_session", "altered_digest", "missing_credential"])(
  "rejects %s without durable actions or financial writes",
  async (kind) => {
    const f = await seed();
    const actor = f.actor();
    if (kind === "expired_session")
      await database.weleticShopifyAppSession.update({
        where: { id: f.sessionId },
        data: { expiresAt: new Date(0) },
      });
    if (kind === "altered_digest") actor.sessionDigest = "0".repeat(64);
    if (kind === "missing_credential")
      await database.weleticShopifyInstallationCredential.deleteMany({
        where: { storeId: f.storeId },
      });
    expect((await send(actor, { operation: "context" })).status).toBe(401);
    const where = { storeId: f.storeId };
    expect(await database.weleticShopifyMerchantAction.count({ where })).toBe(
      0,
    );
    expect(await database.weleticLoyaltyImportSource.count({ where })).toBe(0);
    expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(0);
  },
);

it("serializes concurrent use of the same signed merchant nonce", async () => {
  const f = await seed();
  const actor = f.actor();
  const responses = await Promise.all([
    send(actor, { operation: "context" }),
    send(actor, { operation: "context" }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  expect(
    await database.weleticShopifyMerchantAction.count({
      where: { storeId: f.storeId },
    }),
  ).toBe(1);
});

it("requires a current staff grant rather than installation authority alone", async () => {
  const f = await seed(false);
  expect((await send(f.actor(), { operation: "context" })).status).toBe(403);
  const { shopifyStaffGrantId } = await import(
    "../../lib/weletic/shopify/staff-authorization"
  );
  const actor = f.actor();
  await database.weleticShopifyStaffGrant.create({
    data: {
      id: shopifyStaffGrantId(actor),
      storeId: f.storeId,
      appId,
      installationGeneration: "g1",
      shopifyUserId: actor.userId,
      updatedByShopifyUserId: "123",
      permissions: ["loyalty.configure"],
      revision: 1,
    },
  });
  expect((await send(f.actor(), { operation: "context" })).status).toBe(200);
  await database.weleticShopifyStaffGrant.deleteMany({
    where: { storeId: f.storeId },
  });
  expect((await send(f.actor(), { operation: "context" })).status).toBe(403);
});

it("rejects cross-store source IDs, stale revisions and stale installation generations", async () => {
  const first = await seed();
  const other = await seed();
  const staged = await stage(first);
  expect(
    (
      await send(other.actor(), {
        operation: "status",
        sourceId: staged.sourceId,
        expectedInstallationGeneration: "g1",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send(first.actor(), {
        operation: "commit",
        sourceId: staged.sourceId,
        expectedInstallationGeneration: "g1",
        expectedRevision: "0".repeat(64),
      })
    ).status,
  ).toBe(409);
  expect(
    await database.weleticLoyaltyOutboxJob.count({
      where: { storeId: first.storeId },
    }),
  ).toBe(0);
  await database.weleticShopifyStore.update({
    where: { id: first.storeId },
    data: { installationGeneration: "g2" },
  });
  expect((await send(first.actor(), { operation: "context" })).status).toBe(
    401,
  );
});
