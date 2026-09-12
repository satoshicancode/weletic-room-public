import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const db = new PrismaClient();
let rollbackApply = false;
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(db, {
    get(target, property) {
      if (property !== "$transaction") return Reflect.get(target, property);
      return (fn: (tx: unknown) => Promise<{ applied?: boolean }>) =>
        db.$transaction(async (tx) => {
          const result = await fn(tx);
          if (rollbackApply && result.applied)
            throw new Error("Synthetic pre-commit failure");
          return result;
        });
    },
  }),
}));
vi.mock("server-only", () => ({}));
const appId = `bootstrap-${randomUUID()}`;
const shops: string[] = [];
const plans: Array<{
  workspaceId: string;
  programId: string;
  folderId: string;
  groupId: string;
  storeId: string;
}> = [];
let ready = false;

describe("company bootstrap on fresh full-schema MySQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      !/^\/weletic_loyalty_it_access_[a-z0-9_]+$/.test(url.pathname)
    )
      throw new Error("Fresh isolated bootstrap database required");
    const [identity] = await db.$queryRaw<
      Array<{ name: string; principal: string }>
    >`SELECT DATABASE() AS name, CURRENT_USER() AS principal`;
    if (
      identity.name !== url.pathname.slice(1) ||
      !identity.principal.startsWith(`${decodeURIComponent(url.username)}@`) ||
      url.username === "root"
    )
      throw new Error("Unexpected database identity");
    if (
      (await db.project.count()) ||
      (await db.user.count()) ||
      (await db.weleticShopifyPendingInstallation.count())
    )
      throw new Error("Empty full-schema fixture required");
    vi.stubEnv("SHOPIFY_API_KEY", appId);
    vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Unexpected external fetch");
      }),
    );
    ready = true;
  });
  afterAll(async () => {
    if (ready) {
      const pending = await db.weleticShopifyPendingInstallation.findMany({
        where: { appId },
        select: { id: true },
      });
      await db.weleticShopifyPendingInstallationChange.deleteMany({
        where: { pendingInstallationId: { in: pending.map((p) => p.id) } },
      });
      await db.weleticShopifyPendingInstallation.deleteMany({
        where: { appId },
      });
      for (const p of plans) {
        // Exact fixture IDs only. Avoid Prisma's unrelated relation-mode
        // cascade traversal through the generic affiliate schema.
        await db.$executeRaw`DELETE FROM WeleticShopifyStore WHERE id=${p.storeId}`;
        await db.$executeRaw`DELETE FROM PartnerGroup WHERE id=${p.groupId}`;
        await db.$executeRaw`DELETE FROM Program WHERE id=${p.programId}`;
        await db.$executeRaw`DELETE FROM Folder WHERE id=${p.folderId}`;
        await db.$executeRaw`DELETE FROM ProjectUsers WHERE projectId=${p.workspaceId}`;
        await db.$executeRaw`DELETE FROM Project WHERE id=${p.workspaceId}`;
      }
      await db.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: shops } },
      });
      await db.weleticShopifySessionCoordination.deleteMany({
        where: { appId },
      });
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  async function fixture() {
    const shop = `bootstrap-${randomUUID()}.myshopify.com`;
    shops.push(shop);
    const { ensureShopifySessionCoordination } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    const { ensurePendingInstallationAfterAuthentication } = await import(
      "@/lib/weletic/shopify/installation-admission"
    );
    const { encrypt } = await import("@/lib/encryption");
    const pending = await db.$transaction(async (tx) => {
      await ensureShopifySessionCoordination(tx, { appId, shop });
      await tx.weleticShopifySessionCoordination.updateMany({
        where: { appId, shop },
        data: { leaseEpoch: BigInt(1), revision: BigInt(1) },
      });
      await tx.weleticShopifyAppSession.create({
        data: {
          id: `offline_${shop}`,
          shop,
          isOnline: false,
          payload: encrypt(
            JSON.stringify([
              ["id", `offline_${shop}`],
              ["shop", shop],
              ["isOnline", false],
              ["accessToken", "synthetic-bootstrap-token"],
            ]),
          ),
        },
      });
      return ensurePendingInstallationAfterAuthentication(
        tx,
        { appId, shop },
        new Date(Date.now() - 60_000),
      );
    });
    const input = {
      appId,
      shop,
      pendingInstallationId: pending.id,
      expectedInstallationGeneration: pending.installationGeneration!,
      expectedRevision: pending.revision,
      operator: "fixture-operator",
      reason: "synthetic isolated acceptance",
    };
    const transport: typeof fetch = async (url, init) => {
      expect(String(url)).toBe(
        `https://${shop}/admin/api/2026-07/graphql.json`,
      );
      expect(init?.redirect).toBe("error");
      return new Response(
        JSON.stringify({
          data: { shop: { myshopifyDomain: shop, currencyCode: "JPY" } },
        }),
      );
    };
    const { bootstrapCompanyStore } = await import(
      "@/lib/weletic/shopify/company-store-bootstrap"
    );
    const preview = await bootstrapCompanyStore(input, transport);
    plans.push(preview.records);
    const apply = (fetcher = transport) =>
      bootstrapCompanyStore(
        { ...input, apply: true, expectedPreview: preview.previewDigest },
        fetcher,
      );
    return { input, preview, apply, transport };
  }
  it("commits an exact userless pending store, then rejects duplicate apply", async () => {
    const f = await fixture();
    const result = await f.apply();
    expect(result.applied).toBe(true);
    const store = await db.weleticShopifyStore.findUniqueOrThrow({
      where: { id: result.records.storeId },
    });
    expect(store).toMatchObject({
      shopCurrency: "JPY",
      storeAccessState: "pending_approval",
      storeAccessRevision: 1,
    });
    const program = await db.program.findUniqueOrThrow({
      where: { id: result.records.programId },
    });
    expect(program).toMatchObject({
      accountingCurrency: "JPY",
      startedAt: null,
      messagingEnabledAt: null,
      payoutMode: "external",
    });
    await expect(f.apply()).rejects.toThrow();
    expect(
      await db.weleticShopifyPendingInstallationChange.count({
        where: { pendingInstallationId: f.input.pendingInstallationId },
      }),
    ).toBe(1);
    for (const count of await Promise.all([
      db.user.count(),
      db.projectUsers.count(),
      db.projectInvite.count(),
      db.installedIntegration.count(),
      db.weleticShopper.count(),
      db.weleticLoyaltyProgram.count(),
      db.weleticLoyaltyOutboxJob.count(),
      db.weleticShopifyInstallationCredential.count(),
      db.weleticShopifyStoreAccessChange.count(),
    ]))
      expect(count).toBe(0);
    const project = await db.project.findUniqueOrThrow({
      where: { id: result.records.workspaceId },
    });
    expect(project).toMatchObject({
      stripeId: null,
      trialEndsAt: null,
      stripeConnectId: null,
    });
  });
  it("concurrent apply has exactly one committed winner", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.apply(), f.apply()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.weleticShopifyStore.count({
        where: { id: f.preview.records.storeId },
      }),
    ).toBe(1);
    expect(
      await db.weleticShopifyPendingInstallationChange.count({
        where: { pendingInstallationId: f.input.pendingInstallationId },
      }),
    ).toBe(1);
  });
  it("rejects delayed pre-bootstrap publication through the signed HTTP route", async () => {
    const f = await fixture();
    const { acquireShopifySessionLease } = await import(
      "@/lib/weletic/shopify/session-coordination"
    );
    const { readShopifySessionSnapshot } = await import(
      "@/lib/weletic/shopify/session-snapshot"
    );
    const { lockShopifySessionLifecycle } = await import(
      "@/lib/weletic/shopify/session-lifecycle-fence"
    );
    const { signWeleticShopifyRequest } = await import(
      "@/lib/weletic/shopify/service-auth"
    );
    const scope = { appId, shop: f.input.shop };
    const proof = await db.$transaction(async (tx) => {
      await lockShopifySessionLifecycle({
        tx,
        shop: scope.shop,
        storeId: null,
      });
      const snapshot = await readShopifySessionSnapshot(tx, scope, undefined);
      const lease = await acquireShopifySessionLease(
        tx,
        scope,
        "ac".repeat(32),
        snapshot.observed,
      );
      return {
        observed: snapshot.observed,
        lease: {
          token: lease.token,
          epoch: lease.epoch,
          revision: lease.revision,
        },
      };
    });
    await f.apply();
    const secret = "synthetic-bootstrap-http-service-secret";
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const path = "/api/internal/shopify/sessions/coordinated";
    const timestamp = String(Date.now());
    const body = JSON.stringify({
      properties: [
        ["id", `offline_${scope.shop}`],
        ["shop", scope.shop],
        ["state", "synthetic"],
        ["isOnline", false],
        ["accessToken", "stale-publication-token"],
        ["scope", "read_products"],
      ],
      expectedCredentialTokenHash: null,
      coordination: proof,
    });
    const { POST } = await import(
      "../../app/api/internal/shopify/sessions/route"
    );
    const response = await POST(
      new Request(`https://gateway.invalid${path}`, {
        method: "POST",
        body,
        headers: {
          "x-weletic-timestamp": timestamp,
          "x-weletic-signature": signWeleticShopifyRequest({
            timestamp,
            method: "POST",
            path,
            body,
            secret,
          }),
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(
      await db.weleticShopifyInstallationCredential.count({
        where: { storeId: f.preview.records.storeId },
      }),
    ).toBe(0);
    const { decrypt } = await import("@/lib/encryption");
    const session = await db.weleticShopifyAppSession.findUniqueOrThrow({
      where: { id: `offline_${scope.shop}` },
    });
    expect(decrypt(session.payload)).not.toContain("stale-publication-token");
  });
  it("revokes a delayed SDK publication lease acquired before bootstrap", async () => {
    const f = await fixture();
    const {
      acquireShopifySessionLease,
      observeShopifySessionCoordination,
      advanceShopifySessionRevision,
    } = await import("@/lib/weletic/shopify/session-coordination");
    const lease = await db.$transaction(async (tx) => {
      const scope = { appId, shop: f.input.shop };
      return acquireShopifySessionLease(
        tx,
        scope,
        "ab".repeat(32),
        await observeShopifySessionCoordination(tx, scope),
      );
    });
    await f.apply();
    await expect(
      db.$transaction((tx) => advanceShopifySessionRevision(tx, lease)),
    ).rejects.toThrow("stale_session");
    expect(
      await db.weleticShopifyInstallationCredential.count({
        where: { storeId: f.preview.records.storeId },
      }),
    ).toBe(0);
  });
  it("rolls every record and audit back on a pre-commit failure", async () => {
    const f = await fixture();
    rollbackApply = true;
    try {
      await expect(f.apply()).rejects.toThrow("Synthetic pre-commit failure");
    } finally {
      rollbackApply = false;
    }
    expect(
      await db.project.count({ where: { id: f.preview.records.workspaceId } }),
    ).toBe(0);
    expect(
      await db.program.count({ where: { id: f.preview.records.programId } }),
    ).toBe(0);
    expect(
      await db.folder.count({ where: { id: f.preview.records.folderId } }),
    ).toBe(0);
    expect(
      await db.partnerGroup.count({ where: { id: f.preview.records.groupId } }),
    ).toBe(0);
    expect(
      await db.weleticShopifyStore.count({
        where: { id: f.preview.records.storeId },
      }),
    ).toBe(0);
    expect(
      await db.weleticShopifyPendingInstallationChange.count({
        where: { pendingInstallationId: f.input.pendingInstallationId },
      }),
    ).toBe(0);
  });
  it("rejects credential publication committed during provider lookup", async () => {
    const f = await fixture();
    await expect(
      f.apply(async (url, init) => {
        await db.weleticShopifySessionCoordination.updateMany({
          where: { appId, shop: f.input.shop },
          data: { revision: { increment: 1 } },
        });
        return f.transport(url, init);
      }),
    ).rejects.toThrow();
    expect(
      await db.project.count({ where: { id: f.preview.records.workspaceId } }),
    ).toBe(0);
  });
  it.each(["app/uninstalled", "shop/redact"] as const)(
    "rejects %s committed during provider lookup",
    async (topic) => {
      const f = await fixture();
      const { handlePendingInstallationPrivacy } = await import(
        "@/lib/weletic/shopify/pending-installation-privacy"
      );
      await expect(
        f.apply(async (url, init) => {
          await db.$transaction((tx) =>
            handlePendingInstallationPrivacy(
              tx,
              { appId, shop: f.input.shop },
              topic,
              new Date(),
            ),
          );
          return f.transport(url, init);
        }),
      ).rejects.toThrow();
      expect(
        await db.project.count({
          where: { id: f.preview.records.workspaceId },
        }),
      ).toBe(0);
    },
  );
  it("rejects an orphan workspace without adopting it", async () => {
    const f = await fixture();
    await db.project.create({
      data: {
        id: f.preview.records.workspaceId,
        slug: f.preview.records.slug,
        name: "Synthetic orphan",
        billingCycleStart: 1,
      },
    });
    await expect(f.apply()).rejects.toThrow();
    expect(
      await db.weleticShopifyStore.count({
        where: { id: f.preview.records.storeId },
      }),
    ).toBe(0);
    expect(
      await db.project.findUniqueOrThrow({
        where: { id: f.preview.records.workspaceId },
      }),
    ).toMatchObject({ name: "Synthetic orphan", defaultProgramId: null });
  });
  it("rejects an orphan owner membership before creating its workspace", async () => {
    const f = await fixture();
    const membershipId = randomUUID();
    await db.$executeRaw`INSERT INTO ProjectUsers (id, userId, projectId, role, createdAt, updatedAt)
      VALUES (${membershipId}, 'synthetic-orphan-user', ${f.preview.records.workspaceId}, 'owner', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))`;
    await expect(f.apply()).rejects.toThrow();
    expect(
      await db.project.count({ where: { id: f.preview.records.workspaceId } }),
    ).toBe(0);
    expect(await db.projectUsers.count({ where: { id: membershipId } })).toBe(
      1,
    );
  });
  it.each(["generation", "revision", "expiry"])(
    "rejects a committed %s change after preview",
    async (change) => {
      const f = await fixture();
      if (change === "expiry")
        await db.weleticShopifyAppSession.update({
          where: { id: `offline_${f.input.shop}` },
          data: { expiresAt: new Date(0) },
        });
      else
        await db.weleticShopifyPendingInstallation.update({
          where: { id: f.input.pendingInstallationId },
          data:
            change === "generation"
              ? { installationGeneration: randomUUID() }
              : { revision: { increment: 1 } },
        });
      await expect(f.apply()).rejects.toThrow();
      expect(
        await db.project.count({
          where: { id: f.preview.records.workspaceId },
        }),
      ).toBe(0);
    },
  );
});
