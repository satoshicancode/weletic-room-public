import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// MOCK DECLARATIONS
// =============================================================================

vi.mock("server-only", () => ({}));

// This suite supplies legacy integration fixtures. Native credential-source
// authorization and lifecycle fences are covered by their dedicated suites.
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({ source: "legacy" })),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (fn: any) => Promise.resolve(fn),
}));

vi.mock("@dub/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@dub/utils")>("@dub/utils");
  return {
    ...actual,
    log: vi.fn().mockResolvedValue(undefined),
    APP_DOMAIN_WITH_NGROK: "https://yamax.ngrok.io",
  };
});

let mockIsLocalDev = false;
vi.mock("@/lib/api/environment", () => ({
  get isLocalDev() {
    return mockIsLocalDev;
  },
}));

const mockRedisStore = new Map<string, { value: string; expiresAt?: number }>();
vi.mock("@/lib/upstash", () => ({
  redis: {
    set: vi.fn(
      async (
        key: string,
        value: string,
        options?: { nx?: boolean; ex?: number },
      ) => {
        const now = Date.now();
        const existing = mockRedisStore.get(key);
        if (existing && existing.expiresAt && existing.expiresAt < now) {
          mockRedisStore.delete(key);
        }
        if (options?.nx && mockRedisStore.has(key)) {
          return null;
        }
        const expiresAt = options?.ex ? now + options.ex * 1000 : undefined;
        mockRedisStore.set(key, { value, expiresAt });
        return "OK";
      },
    ),
    get: vi.fn(async (key: string) => {
      const now = Date.now();
      const item = mockRedisStore.get(key);
      if (!item) return null;
      if (item.expiresAt && item.expiresAt < now) {
        mockRedisStore.delete(key);
        return null;
      }
      return item.value;
    }),
    del: vi.fn(async (key: string) => {
      const deleted = mockRedisStore.delete(key) ? 1 : 0;
      return deleted;
    }),
    eval: vi.fn(async (script: string, keys: string[], args: any[]) => {
      // Mock simple lock release script
      const key = keys[0];
      const val = args[0];
      const existing = mockRedisStore.get(key);
      if (existing && existing.value === val) {
        mockRedisStore.delete(key);
        return 1;
      }
      return 0;
    }),
  },
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  decryptOrPassthrough: (val: string) => val,
}));

vi.mock("@/lib/cron", () => ({
  qstash: {
    publishJSON: vi.fn().mockResolvedValue({ messageId: "msg_123" }),
    queue: vi.fn().mockReturnValue({
      enqueueJSON: vi.fn().mockResolvedValue({ messageId: "msg_123" }),
    }),
  },
}));

vi.mock("@/lib/api-logs/capture-webhook-log", () => ({
  captureWebhookLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/links/cache", () => ({
  linkCache: {
    expireMany: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", async () => {
  return {
    shopifyAdminGraphql: vi.fn(),
    ShopifyAdminGraphqlError: class extends Error {
      code: string;
      userErrors?: any[];
      constructor(code: string, message: string, userErrors?: any[]) {
        super(message);
        this.name = "ShopifyAdminGraphqlError";
        this.code = code;
        this.userErrors = userErrors;
      }
    },
  };
});

// In-memory Prisma store mock
const db = {
  projects: new Map<string, any>(),
  installedIntegrations: new Map<string, any>(),
  partners: new Map<string, any>(),
  partnerGroups: new Map<string, any>(),
  discounts: new Map<string, any>(),
  discountCodes: new Map<string, any>(),
  links: new Map<string, any>(),
  weleticShopifyStores: new Map<string, any>(),
  weleticShopifyWebhookEvents: new Map<string, any>(),
  weleticReconciliationIssues: new Map<string, any>(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; shopifyStoreId?: string };
        }) => {
          let proj: any = null;
          if (where.id) proj = db.projects.get(where.id) || null;
          else if (where.shopifyStoreId) {
            for (const p of db.projects.values()) {
              if (p.shopifyStoreId === where.shopifyStoreId) {
                proj = p;
                break;
              }
            }
          }
          if (!proj) return null;
          const insts = Array.from(db.installedIntegrations.values()).filter(
            (i) => i.projectId === proj.id,
          );
          const store = Array.from(db.weleticShopifyStores.values()).find(
            (candidate) => candidate.projectId === proj.id,
          );
          return {
            ...proj,
            installedIntegrations: insts,
            weleticShopifyStore: store ?? null,
          };
        },
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const proj = db.projects.get(where.id);
        if (!proj) throw new Error(`Project ${where.id} not found`);
        const insts = Array.from(db.installedIntegrations.values()).filter(
          (i) => i.projectId === proj.id,
        );
        return { ...proj, installedIntegrations: insts };
      }),
    },
    installedIntegration: {
      findFirst: vi.fn(async ({ where }: { where: { projectId?: string } }) => {
        for (const inst of db.installedIntegrations.values()) {
          if (!where.projectId || inst.projectId === where.projectId)
            return inst;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return db.installedIntegrations.get(where.id) ?? null;
      }),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    partner: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return db.partners.get(where.id) || null;
      }),
    },
    partnerGroup: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const group = db.partnerGroups.get(where.id);
        if (!group) return null;
        const discount = group.discountId
          ? db.discounts.get(group.discountId)
          : null;
        return { ...group, discount };
      }),
    },
    link: {
      findFirst: vi.fn(async ({ where }: { where: any }) => {
        for (const link of db.links.values()) {
          if (where.programId && link.programId !== where.programId) continue;
          if (where.partnerId && link.partnerId !== where.partnerId) continue;
          if (where.discountCode?.is === null && link.discountCodeId) continue;
          return link;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const link = db.links.get(where.id);
        if (!link) return null;
        const discountCode = link.discountCodeId
          ? db.discountCodes.get(link.discountCodeId)
          : null;
        return {
          ...link,
          discountCode: discountCode ? { code: discountCode.code } : null,
        };
      }),
    },
    discountCode: {
      findFirst: vi.fn(async ({ where }: { where: any }) => {
        for (const code of db.discountCodes.values()) {
          if (
            where.code &&
            code.code.toUpperCase() !== where.code.toUpperCase()
          )
            continue;
          if (where.programId && code.programId !== where.programId) continue;
          if (where.partnerId && code.partnerId !== where.partnerId) continue;
          return code;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(db.discountCodes.values());
        if (where?.programId) {
          results = results.filter((c) => c.programId === where.programId);
        }
        if (where?.program?.workspaceId) {
          results = results.filter((c) => {
            const project = db.projects.get(where.program.workspaceId);
            return project && c.programId === project.defaultProgramId;
          });
        }
        if (where?.OR && Array.isArray(where.OR)) {
          results = results.filter((c) => {
            return where.OR.some((clause: any) => {
              if (clause.code?.in && Array.isArray(clause.code.in)) {
                return clause.code.in
                  .map((x: string) => x.toUpperCase())
                  .includes(c.code.toUpperCase());
              }
              if (
                clause.discount?.couponId?.in &&
                Array.isArray(clause.discount.couponId.in)
              ) {
                const discount = db.discounts.get(c.discountId);
                return (
                  discount &&
                  clause.discount.couponId.in.includes(discount.couponId)
                );
              }
              return false;
            });
          });
        }
        return results.map((c) => ({
          ...c,
          discount: db.discounts.get(c.discountId) || null,
          partner: db.partners.get(c.partnerId) || null,
          link: db.links.get(c.linkId) || null,
        }));
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        for (const existing of db.discountCodes.values()) {
          if (existing.code.toUpperCase() === data.code.toUpperCase()) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed on code",
              {
                code: "P2002",
                clientVersion: "5.0.0",
              },
            );
          }
        }
        const record = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          disabledAt: null,
        };
        db.discountCodes.set(data.id, record);
        return record;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: any }) => {
          const existing = db.discountCodes.get(where.id);
          if (!existing) throw new Error(`DiscountCode ${where.id} not found`);
          const updated = { ...existing, ...data, updatedAt: new Date() };
          db.discountCodes.set(where.id, updated);
          return updated;
        },
      ),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const [id, code] of db.discountCodes.entries()) {
          let matches = true;
          if (typeof where?.id === "string" && id !== where.id) matches = false;
          if (where?.id?.in && !where.id.in.includes(id)) matches = false;
          if (where?.disabledAt === null && code.disabledAt !== null)
            matches = false;
          if (where?.programId && code.programId !== where.programId)
            matches = false;
          if (where?.OR && Array.isArray(where.OR)) {
            matches = where.OR.some((clause: any) => {
              if (clause.code?.in && Array.isArray(clause.code.in)) {
                return clause.code.in
                  .map((x: string) => x.toUpperCase())
                  .includes(code.code.toUpperCase());
              }
              if (
                clause.discount?.couponId?.in &&
                Array.isArray(clause.discount.couponId.in)
              ) {
                const discount = db.discounts.get(code.discountId);
                return (
                  discount &&
                  clause.discount.couponId.in.includes(discount.couponId)
                );
              }
              return false;
            });
          }
          if (matches) {
            db.discountCodes.set(id, {
              ...code,
              ...data,
              updatedAt: new Date(),
            });
            count++;
          }
        }
        return { count };
      }),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(
        async ({ where }: { where: { projectId?: string; id?: string } }) => {
          if (where.projectId) {
            for (const store of db.weleticShopifyStores.values()) {
              if (store.projectId === where.projectId) return store;
            }
          }
          if (where.id) return db.weleticShopifyStores.get(where.id) || null;
          return null;
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: any }) => {
        for (const store of db.weleticShopifyStores.values()) {
          if (where.projectId && store.projectId === where.projectId)
            return store;
          if (where.id && store.id === where.id) return store;
          if (where.OR && Array.isArray(where.OR)) {
            for (const clause of where.OR) {
              if (clause.projectId && store.projectId === clause.projectId)
                return store;
              if (clause.id && store.id === clause.id) return store;
            }
          }
        }
        return null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: any }) => {
          const store = db.weleticShopifyStores.get(where.id);
          if (!store) throw new Error(`Store ${where.id} not found`);
          const updated = { ...store, ...data, updatedAt: new Date() };
          db.weleticShopifyStores.set(where.id, updated);
          return updated;
        },
      ),
    },
    weleticRewardRedemption: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    weleticShopifyWebhookEvent: {
      create: vi.fn(async ({ data }: { data: any }) => {
        const key = data.webhookId;
        if (db.weleticShopifyWebhookEvents.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on webhookId",
            {
              code: "P2002",
              clientVersion: "5.0.0",
            },
          );
        }
        const record = {
          ...data,
          status: "received",
          createdAt: new Date(),
          updatedAt: new Date(),
          attempts: data.attempts || 1,
        };
        db.weleticShopifyWebhookEvents.set(key, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: { where: { webhookId: string } }) => {
        return db.weleticShopifyWebhookEvents.get(where.webhookId) || null;
      }),
      findUniqueOrThrow: vi.fn(
        async ({ where }: { where: { webhookId: string } }) => {
          const event = db.weleticShopifyWebhookEvents.get(where.webhookId);
          if (!event) throw new Error(`Webhook ${where.webhookId} not found`);
          return event;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; webhookId?: string };
          data: any;
        }) => {
          for (const [
            key,
            record,
          ] of db.weleticShopifyWebhookEvents.entries()) {
            if (record.id === where.id || key === where.webhookId) {
              const updated = { ...record, ...data, updatedAt: new Date() };
              db.weleticShopifyWebhookEvents.set(key, updated);
              return updated;
            }
          }
          return null;
        },
      ),
      updateMany: vi.fn(async ({ where, data }: { where: any; data: any }) => {
        let count = 0;
        for (const [key, record] of db.weleticShopifyWebhookEvents.entries()) {
          if (where.webhookId && key !== where.webhookId) continue;
          if (where.id && record.id !== where.id) continue;
          if (where.storeId && record.storeId !== where.storeId) continue;
          if (where.topic && record.topic !== where.topic) continue;
          if (
            where.attempts !== undefined &&
            record.attempts !== where.attempts
          )
            continue;
          if (
            where.storeInstallationGeneration !== undefined &&
            record.storeInstallationGeneration !==
              where.storeInstallationGeneration
          )
            continue;
          if (
            typeof where.status === "string" &&
            record.status !== where.status
          )
            continue;
          if (where.status?.in && !where.status.in.includes(record.status))
            continue;
          if (where.OR && Array.isArray(where.OR)) {
            const orMatch = where.OR.some((clause: any) => {
              if (clause.status && record.status !== clause.status)
                return false;
              if (clause.updatedAt?.lt) {
                if (record.updatedAt >= clause.updatedAt.lt) return false;
              }
              return true;
            });
            if (!orMatch) continue;
          }
          const incrementAttempts = data.attempts?.increment || 0;
          const updated = {
            ...record,
            ...data,
            attempts: record.attempts + incrementAttempts,
            updatedAt: new Date(),
          };
          db.weleticShopifyWebhookEvents.set(key, updated);
          count++;
        }
        return { count };
      }),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = `${where.storeId_kind_externalKey.storeId}:${where.storeId_kind_externalKey.kind}:${where.storeId_kind_externalKey.externalKey}`;
        const existing = db.weleticReconciliationIssues.get(key);
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: new Date() };
          db.weleticReconciliationIssues.set(key, updated);
          return updated;
        } else {
          const created = {
            ...create,
            status: create.status || "open",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          db.weleticReconciliationIssues.set(key, created);
          return created;
        }
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [key, issue] of db.weleticReconciliationIssues.entries()) {
          let match = true;
          if (where.storeId && issue.storeId !== where.storeId) match = false;
          if (where.externalKey && issue.externalKey !== where.externalKey)
            match = false;
          if (where.kind && issue.kind !== where.kind) match = false;
          if (where.status && issue.status !== where.status) match = false;
          if (match) {
            db.weleticReconciliationIssues.set(key, {
              ...issue,
              ...data,
              updatedAt: new Date(),
            });
            count++;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async ({ where }: any = {}) => {
        let results = Array.from(db.weleticReconciliationIssues.values());
        if (where?.storeId)
          results = results.filter((i) => i.storeId === where.storeId);
        if (where?.status)
          results = results.filter((i) => i.status === where.status);
        return results;
      }),
    },
    $queryRaw: vi.fn(async (query: Prisma.Sql) => {
      const sql = query.strings.join("?");
      if (sql.includes("FROM InstalledIntegration")) {
        const id = query.values[0];
        if (typeof id !== "string") throw new Error("Expected installation ID");
        const installation = db.installedIntegrations.get(id);
        return installation ? [installation] : [];
      }
      // This discount/webhook fixture has no loyalty program configured.
      if (sql.includes("FROM WeleticLoyaltyProgram")) return [];
      // Legacy fixtures have no privacy tombstone, public admission or native
      // credential. The real legacy ownership fence still executes these reads.
      if (
        sql.includes("FROM WeleticShopifyShopPrivacyTombstone") ||
        sql.includes("FROM WeleticShopifyPendingInstallation") ||
        sql.includes("FROM WeleticShopifyInstallationCredential")
      )
        return [];
      if (!sql.includes("FROM WeleticShopifyStore")) {
        throw new Error("Unhandled SQL in webhook simulation");
      }
      const store = db.weleticShopifyStores.values().next().value;
      return store ? [store] : [];
    }),
    $executeRaw: vi.fn(async (query: Prisma.Sql) => {
      if (
        !query.strings
          .join("?")
          .includes("INSERT INTO WeleticShopifySessionCoordination")
      ) {
        throw new Error("Unhandled SQL write in webhook simulation");
      }
      // These in-memory webhook tests do not model database locking. Real
      // coordinator contention is covered by isolated SQL integration tests.
      return 1;
    }),
    $transaction: vi.fn(async function (this: any, action: any) {
      return typeof action === "function" ? action(this) : Promise.all(action);
    }),
  },
}));

// Imports under test
import { linkCache } from "@/lib/api/links/cache";
import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import { createAllShopifyWebhookBodyDigests } from "@/lib/weletic/shopify/privacy-identity";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import { POST as shopifyWebhookHandler } from "../../app/(ee)/api/shopify/integration/webhook/route";
import {
  buildMockPayload,
  computeShopifyHmac,
} from "../../scripts/dev/simulate-shopify-webhook";

// Helper to reset and seed base state
function setupTestState() {
  db.projects.clear();
  db.installedIntegrations.clear();
  db.partners.clear();
  db.partnerGroups.clear();
  db.discounts.clear();
  db.discountCodes.clear();
  db.links.clear();
  db.weleticShopifyStores.clear();
  db.weleticShopifyWebhookEvents.clear();
  db.weleticReconciliationIssues.clear();
  mockRedisStore.clear();

  mockIsLocalDev = false;

  const workspace = {
    id: "ws_adversarial",
    name: "Adversarial Test Workspace",
    slug: "adversarial-shop",
    shopifyStoreId: "yamax-adversarial.myshopify.com",
    stripeConnectId: null,
    defaultProgramId: "prog_adv",
    webhookEnabled: true,
  };
  db.projects.set(workspace.id, workspace);

  const installation = {
    id: "inst_adv",
    projectId: "ws_adversarial",
    integrationId: "shopify",
    credentials: {
      shop: "yamax-adversarial.myshopify.com",
      accessToken: "shpat_adv_token_999",
      shopVerifiedAt: "2026-08-28T00:00:00.000Z",
      shopVerificationTokenHash:
        "6cafd41d97287383d0e18e13b4878cca841fe95352d571a34b668ad2c6c0a19f",
      scope:
        "read_products,read_markets,read_orders,read_translations,read_customers,write_discounts",
      installationGeneration: "sgen_adversarial_current",
    },
  };
  db.installedIntegrations.set(installation.id, installation);

  const store = {
    id: "store_adv",
    projectId: "ws_adversarial",
    shopDomain: "yamax-adversarial.myshopify.com",
    complianceState: "active",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
    installationGeneration: "sgen_adversarial_current",
    syncStatus: "succeeded",
    lastReconciledAt: null,
  };
  db.weleticShopifyStores.set(store.id, store);

  const parentDiscount = {
    id: "disc_adv_10",
    programId: "prog_adv",
    amount: 10,
    type: "percentage",
    provider: "shopify",
    couponId: "gid://shopify/DiscountCodeNode/5005",
    autoProvisionEnabledAt: new Date("2026-01-01T00:00:00Z"),
  };
  db.discounts.set(parentDiscount.id, parentDiscount);

  const partner = {
    id: "partner_adv_1",
    name: "Adversarial Partner",
    email: "adv@weletic.com",
    groupId: "grp_adv",
    programId: "prog_adv",
  };
  db.partners.set(partner.id, partner);

  const link = {
    id: "link_adv_1",
    domain: "yamax.fit",
    key: "adv",
    url: "https://yamax.fit/adv",
    programId: "prog_adv",
    partnerId: "partner_adv_1",
    discountCodeId: null,
  };
  db.links.set(link.id, link);

  return { workspace, installation, store, parentDiscount, partner, link };
}

// =============================================================================
// ADVERSARIAL STRESS TEST SUITE
// =============================================================================

describe("Adversarial Stress Test Suite (Challenger 1 Verification)", () => {
  const secret = "shopify-webhook-test-secret";

  beforeEach(() => {
    vi.clearAllMocks();
    setupTestState();
    process.env.SHOPIFY_WEBHOOK_SECRET = secret;
  });

  // ===========================================================================
  // SECTION 1: CONCURRENT WEBHOOK IDEMPOTENCY & LEASE LOCKING
  // ===========================================================================
  describe("Section 1: Concurrency, Idempotency & Lease Locking Under Adversarial Dispatches", () => {
    it("1.1: 20 simultaneous duplicate webhook dispatches result in exactly 1 ingestion and 19 409/duplicate responses", async () => {
      const { workspace, partner, link, parentDiscount } = setupTestState();

      // Seed discount code
      db.discountCodes.set("dcode_adv_del", {
        id: "dcode_adv_del",
        code: "ADV10",
        programId: "prog_adv",
        partnerId: partner.id,
        linkId: link.id,
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      const payload = { id: 5005, code: "ADV10" };
      const rawBody = JSON.stringify(payload);
      const signature = computeShopifyHmac(rawBody, secret);
      const webhookId = "wh_burst_concurrency_20_reqs";

      const dispatch = () =>
        shopifyWebhookHandler(
          new Request(
            "https://app.weletic.com/api/shopify/integration/webhook",
            {
              method: "POST",
              headers: {
                "x-shopify-topic": "discounts/delete",
                "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
                "x-shopify-webhook-id": webhookId,
                "x-shopify-hmac-sha256": signature,
                "content-type": "application/json",
              },
              body: rawBody,
            },
          ),
        );

      // Launch 20 concurrent requests
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => dispatch()),
      );

      // Count status codes
      const statuses = responses.map((r) => r.status);
      const ok200s = statuses.filter((s) => s === 200);
      const conflict409s = statuses.filter((s) => s === 409);

      // Total responses must equal 20
      expect(responses.length).toBe(20);
      expect(ok200s.length + conflict409s.length).toBe(20);

      // Exactly 1 winner should have processed the event, or remaining acknowledged as duplicate
      const eventRecord = db.weleticShopifyWebhookEvents.get(webhookId);
      expect(eventRecord).toBeDefined();
      expect(eventRecord?.status).toBe("processed");

      // Verify side effects occurred exactly once
      expect(db.discountCodes.get("dcode_adv_del")?.disabledAt).not.toBeNull();
      expect(linkCache.expireMany).toHaveBeenCalledTimes(1);
    });

    it("1.2: stale received lease (> 60s) is safely reclaimed by a retry request", async () => {
      const { store } = setupTestState();

      const webhookId = "wh_stale_lease_recovery";
      const payload = { id: 5005, code: "NONEXISTENT_CODE" };
      const rawBody = JSON.stringify(payload);
      // Seed a stale "received" record updated 90 seconds ago
      db.weleticShopifyWebhookEvents.set(webhookId, {
        id: "whook_stale_1",
        storeId: store.id,
        webhookId,
        topic: "discounts/delete",
        status: "received",
        attempts: 1,
        createdAt: new Date(Date.now() - 90_000),
        updatedAt: new Date(Date.now() - 90_000), // > 60s ago
        payload: { id: "5005" },
        authenticatedBodyDigest: createAllShopifyWebhookBodyDigests({
          topic: "discounts/delete",
          rawBodyBytes: Buffer.from(rawBody),
        })[0],
        storeInstallationGeneration: store.installationGeneration,
      });

      const signature = computeShopifyHmac(rawBody, secret);

      const res = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "x-shopify-webhook-id": webhookId,
            "x-shopify-hmac-sha256": signature,
            "content-type": "application/json",
          },
          body: rawBody,
        }),
      );

      // Successfully claimed stale lease, incremented attempts to 2, and processed
      expect(res.status).toBe(200);
      const eventRecord = db.weleticShopifyWebhookEvents.get(webhookId);
      expect(eventRecord?.attempts).toBe(2);
      expect(eventRecord?.status).toBe("processed");
    });

    it("1.3: failed webhook event can be retried and successfully claimed", async () => {
      const { store } = setupTestState();

      const webhookId = "wh_failed_retry_recovery";
      const payload = { id: 5005, code: "NONEXISTENT_CODE" };
      const rawBody = JSON.stringify(payload);
      // Seed a "failed" record
      db.weleticShopifyWebhookEvents.set(webhookId, {
        id: "whook_failed_1",
        storeId: store.id,
        webhookId,
        topic: "discounts/delete",
        status: "failed",
        error: "Temporary network glitch",
        attempts: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        authenticatedBodyDigest: createAllShopifyWebhookBodyDigests({
          topic: "discounts/delete",
          rawBodyBytes: Buffer.from(rawBody),
        })[0],
        storeInstallationGeneration: store.installationGeneration,
      });

      const signature = computeShopifyHmac(rawBody, secret);

      const res = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "x-shopify-webhook-id": webhookId,
            "x-shopify-hmac-sha256": signature,
            "content-type": "application/json",
          },
          body: rawBody,
        }),
      );

      expect(res.status).toBe(200);
      const eventRecord = db.weleticShopifyWebhookEvents.get(webhookId);
      expect(eventRecord?.status).toBe("processed");
      expect(eventRecord?.attempts).toBe(2);
    });

    it("1.4: already processed webhook immediately returns 200 without re-running side effects", async () => {
      const { store } = setupTestState();

      const webhookId = "wh_already_completed";
      const payload = { id: 5005, code: "NONEXISTENT_CODE" };
      const rawBody = JSON.stringify(payload);
      db.weleticShopifyWebhookEvents.set(webhookId, {
        id: "whook_done_1",
        storeId: store.id,
        webhookId,
        topic: "discounts/delete",
        status: "processed",
        attempts: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        authenticatedBodyDigest: createAllShopifyWebhookBodyDigests({
          topic: "discounts/delete",
          rawBodyBytes: Buffer.from(rawBody),
        })[0],
        storeInstallationGeneration: store.installationGeneration,
      });

      const signature = computeShopifyHmac(rawBody, secret);

      const res = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "x-shopify-webhook-id": webhookId,
            "x-shopify-hmac-sha256": signature,
            "content-type": "application/json",
          },
          body: rawBody,
        }),
      );

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Duplicate webhook was already processed");
      expect(linkCache.expireMany).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // SECTION 2: HMAC SIGNATURE TAMPERING & CRYPTOGRAPHIC SECURITY
  // ===========================================================================
  describe("Section 2: HMAC Cryptographic Hardening & Tampering Attacks", () => {
    it("2.1: rejects tampered body (single whitespace added after HMAC generation)", async () => {
      const rawBody = JSON.stringify({ id: 1001, code: "HIRO" });
      const signature = computeShopifyHmac(rawBody, secret);
      const tamperedBody = `${rawBody} `;

      const res = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "x-shopify-webhook-id": "wh_tamper_space",
            "x-shopify-hmac-sha256": signature,
            "content-type": "application/json",
          },
          body: tamperedBody,
        }),
      );

      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain("Invalid webhook signature");
    });

    it("2.2: rejects altered HMAC signature with length mismatch safely without throwing RangeError", () => {
      const body = JSON.stringify({ event: "test" });
      const validSignature = computeShopifyHmac(body, secret);

      // Truncated signature
      expect(
        verifyShopifyWebhookSignature({
          body,
          signature: validSignature.slice(0, 10),
          secret,
        }),
      ).toBe(false);

      // Appended signature
      expect(
        verifyShopifyWebhookSignature({
          body,
          signature: `${validSignature}extra`,
          secret,
        }),
      ).toBe(false);

      // Empty signature or empty secret
      expect(
        verifyShopifyWebhookSignature({
          body,
          signature: "",
          secret,
        }),
      ).toBe(false);
      expect(
        verifyShopifyWebhookSignature({
          body,
          signature: validSignature,
          secret: "",
        }),
      ).toBe(false);
    });

    it("2.3: returns 503 when SHOPIFY_WEBHOOK_SECRET is missing in production mode", async () => {
      delete process.env.SHOPIFY_WEBHOOK_SECRET;

      const rawBody = JSON.stringify({ id: 1001 });
      const res = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "content-type": "application/json",
          },
          body: rawBody,
        }),
      );

      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("Webhook verification is unavailable");
    });

    it("2.4: local dev mode accepts valid secret signature and rejects invalid signature when header provided", async () => {
      mockIsLocalDev = true;
      process.env.SHOPIFY_WEBHOOK_SECRET = secret;

      const rawBody = JSON.stringify({ id: 1001, code: "HIRO" });
      const validSig = computeShopifyHmac(rawBody, secret);
      const invalidSig = "completely_wrong_hmac_signature";

      // Invalid signature in dev -> 401
      const resInvalid = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "x-shopify-webhook-id": "wh_local_invalid_signature",
            "x-shopify-hmac-sha256": invalidSig,
            "content-type": "application/json",
          },
          body: rawBody,
        }),
      );
      expect(resInvalid.status).toBe(401);

      // Valid signature in dev -> 200
      const resValid = await shopifyWebhookHandler(
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-adversarial.myshopify.com",
            "x-shopify-webhook-id": "wh_local_valid_signature",
            "x-shopify-hmac-sha256": validSig,
            "content-type": "application/json",
          },
          body: rawBody,
        }),
      );
      expect(resValid.status).toBe(200);
    });
  });

  // ===========================================================================
  // SECTION 3: MULTI-CURRENCY ZERO-DECIMAL PRECISION & PAYLOAD GENERATION
  // ===========================================================================
  describe("Section 3: Multi-Currency Zero-Decimal Precision (JPY, VND) & Payload Integrity", () => {
    it("3.1: formats JPY amounts as integer strings without decimals across orders, lines, and refunds", () => {
      const jpyOrderPayload = buildMockPayload("orders/paid", {
        amount: "15000",
        currency: "JPY",
        code: "YAMAX_TOKYO",
      });

      expect(jpyOrderPayload.currency).toBe("JPY");
      expect(jpyOrderPayload.current_subtotal_price_set.shop_money.amount).toBe(
        "15000",
      );
      expect(
        jpyOrderPayload.current_total_discounts_set.shop_money.amount,
      ).toBe("1500"); // 10%
      expect(jpyOrderPayload.current_total_price_set.shop_money.amount).toBe(
        "13500",
      ); // 90%

      // Line items
      for (const line of jpyOrderPayload.line_items) {
        expect(line.price_set.shop_money.amount).not.toContain(".");
        expect(line.total_discount_set.shop_money.amount).not.toContain(".");
      }

      // Minor unit conversion checks
      expect(
        decimalToMinorUnits(
          jpyOrderPayload.current_subtotal_price_set.shop_money.amount,
          "JPY",
        ),
      ).toBe(BigInt(15000));
    });

    it("3.2: formats VND amounts as integer strings without decimals", () => {
      const vndOrderPayload = buildMockPayload("orders/paid", {
        amount: "2500000",
        currency: "VND",
        code: "SAIGON",
      });

      expect(vndOrderPayload.currency).toBe("VND");
      expect(vndOrderPayload.current_subtotal_price_set.shop_money.amount).toBe(
        "2500000",
      );
      expect(
        vndOrderPayload.current_subtotal_price_set.shop_money.amount,
      ).not.toContain(".");
      expect(decimalToMinorUnits("2500000", "VND")).toBe(BigInt(2500000));

      const vndRefundPayload = buildMockPayload("refunds/create", {
        amount: "1000000",
        currency: "VND",
      });
      expect(
        vndRefundPayload.refund_line_items[0].subtotal_set.shop_money.amount,
      ).toBe("1000000");
    });

    it("3.3: decimal currencies (USD, EUR, GBP) preserve 2-decimal precision (e.g. 120.00)", () => {
      const usdPayload = buildMockPayload("orders/paid", {
        amount: "120",
        currency: "USD",
      });
      expect(usdPayload.current_subtotal_price_set.shop_money.amount).toBe(
        "120.00",
      );
      expect(
        decimalToMinorUnits(
          usdPayload.current_subtotal_price_set.shop_money.amount,
          "USD",
        ),
      ).toBe(BigInt(12000));

      const eurPayload = buildMockPayload("orders/paid", {
        amount: "89.5",
        currency: "EUR",
      });
      expect(eurPayload.current_subtotal_price_set.shop_money.amount).toBe(
        "89.50",
      );
      expect(
        decimalToMinorUnits(
          eurPayload.current_subtotal_price_set.shop_money.amount,
          "EUR",
        ),
      ).toBe(BigInt(8950));
    });
  });

  // ===========================================================================
  // SECTION 4: 5-STATE DRIFT DETECTION & SAFE HEALING MATRIX
  // ===========================================================================
  describe("Section 4: 5-State Discount Drift Matrix & Safe Healing Verification", () => {
    it("4.1: verifies State 1 (In-Sync): active in DB and active in Shopify", async () => {
      const { workspace, parentDiscount } = setupTestState();

      db.discountCodes.set("dcode_s1", {
        id: "dcode_s1",
        code: "STATE1_IN_SYNC",
        programId: "prog_adv",
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/S1",
              codeDiscount: {
                title: "Dub Discount (STATE1_IN_SYNC)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "c_s1", code: "STATE1_IN_SYNC", asyncUsageCount: 0 },
                  ],
                },
              },
            },
          ],
        },
      });

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: false,
      });

      expect(result.driftStates.inSync).toBe(1);
      expect(result.openCount).toBe(0);
      expect(result.issues).toHaveLength(0);
    });

    it("4.2: verifies State 2 (Orphaned in Weletic): active in DB, missing in Shopify, disables locally", async () => {
      const { workspace, parentDiscount } = setupTestState();

      db.discountCodes.set("dcode_s2", {
        id: "dcode_s2",
        code: "STATE2_ORPHAN_WELETIC",
        programId: "prog_adv",
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      // Shopify returns 0 nodes (missing on Shopify)
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: { pageInfo: { hasNextPage: false }, nodes: [] },
      });

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInWeletic).toBe(1);
      expect(result.healedCount).toBe(1);
      expect(result.issues[0].healingAction).toBe(
        "disabled_in_db_missing_in_shopify",
      );
      expect(db.discountCodes.get("dcode_s2")?.disabledAt).not.toBeNull(); // disabled locally
    });

    it("4.3: verifies State 2 fallback: if parent coupon missing, disables locally in DB", async () => {
      const { workspace } = setupTestState();

      // Discount without parent couponId
      const standaloneDisc = {
        id: "disc_no_parent",
        programId: "prog_adv",
        amount: 10,
        type: "percentage",
        provider: "shopify",
        couponId: null,
      };
      db.discounts.set(standaloneDisc.id, standaloneDisc as any);

      db.discountCodes.set("dcode_s2_fallback", {
        id: "dcode_s2_fallback",
        code: "STATE2_NO_PARENT",
        programId: "prog_adv",
        discountId: standaloneDisc.id,
        disabledAt: null,
      });

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: { pageInfo: { hasNextPage: false }, nodes: [] },
      });

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInWeletic).toBe(1);
      expect(result.healedCount).toBe(1);
      expect(result.issues[0].healingAction).toBe(
        "disabled_in_db_missing_in_shopify",
      );
      expect(
        db.discountCodes.get("dcode_s2_fallback")?.disabledAt,
      ).not.toBeNull();
    });

    it("4.4: does not classify an unmanaged standalone Shopify node from its title", async () => {
      const { workspace } = setupTestState();

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/S3",
              codeDiscount: {
                title: "Dub Discount (ORPHAN_IN_SHOPIFY)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "c_s3",
                      code: "ORPHAN_IN_SHOPIFY",
                      asyncUsageCount: 0,
                    },
                  ],
                },
              },
            },
          ],
        },
      });

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: true,
      });

      expect(result.driftStates.orphanedInShopify).toBe(0);
      expect(result.healedCount).toBe(0);
      expect(result.manualCleanupCount).toBe(0);
      expect(result.issues).toHaveLength(0);
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("4.5: keeps owned State 4 remote cleanup open for manual verification", async () => {
      const { workspace, parentDiscount } = setupTestState();

      db.discountCodes.set("dcode_s4", {
        id: "dcode_s4",
        code: "STATE4_DESYNC_ACTIVE",
        programId: "prog_adv",
        discountId: parentDiscount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      });

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/S4",
              codeDiscount: {
                title: "Dub Discount (STATE4_DESYNC_ACTIVE)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "c_s4",
                      code: "STATE4_DESYNC_ACTIVE",
                      asyncUsageCount: 0,
                    },
                  ],
                },
              },
            },
          ],
        },
      });

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: true,
      });

      expect(result.driftStates.statusDesyncShopifyActive).toBe(1);
      expect(result.healedCount).toBe(0);
      expect(result.manualCleanupCount).toBe(1);
      expect(result.issues[0]).toMatchObject({
        healed: false,
        details: {
          requiresManualCleanup: true,
          cleanupMode: "manual_verified_shopify_cleanup",
          ownershipEvidence: {
            source: "discount_code_row",
            discountCodeId: "dcode_s4",
          },
        },
      });
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
    });

    it("4.6: verifies State 5 (Status Desync): active in DB, expired in Shopify, soft-deletes in DB", async () => {
      const { workspace, parentDiscount } = setupTestState();

      db.discountCodes.set("dcode_s5", {
        id: "dcode_s5",
        code: "STATE5_DESYNC_EXPIRED",
        programId: "prog_adv",
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/S5",
              codeDiscount: {
                title: "Dub Discount (STATE5_DESYNC_EXPIRED)",
                status: "EXPIRED",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "c_s5",
                      code: "STATE5_DESYNC_EXPIRED",
                      asyncUsageCount: 0,
                    },
                  ],
                },
              },
            },
          ],
        },
      });

      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: true,
      });

      expect(result.driftStates.statusDesyncShopifyInactive).toBe(1);
      expect(result.healedCount).toBe(1);
      expect(result.issues[0].healingAction).toBe(
        "disabled_in_db_expired_in_shopify",
      );
      expect(db.discountCodes.get("dcode_s5")?.disabledAt).not.toBeNull();
    });

    it("4.7: distributed lock blocks concurrent reconciliation runs on the same workspace", async () => {
      const { workspace } = setupTestState();

      // Seed lock in Redis
      mockRedisStore.set(`weletic:reconciliation:discounts:${workspace.id}`, {
        value: "locked_token",
        expiresAt: Date.now() + 60_000,
      });

      await expect(
        reconcileWeleticShopifyDiscounts({
          workspaceId: workspace.id,
        }),
      ).rejects.toThrow("Shopify discount reconciliation is already running.");
    });
  });
});
