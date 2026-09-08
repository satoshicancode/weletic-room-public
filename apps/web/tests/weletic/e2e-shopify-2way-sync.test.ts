import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// MOCK DECLARATIONS
// =============================================================================

vi.mock("server-only", () => ({}));

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

vi.mock("@/lib/api/environment", () => ({
  isLocalDev: false,
}));

vi.mock("@/lib/upstash", () => ({
  redis: {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
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
          if (
            where.partnerGroupDefaultLinkId?.not !== undefined &&
            !link.partnerGroupDefaultLinkId
          )
            continue;
          if (where.discountCode?.is === null && link.discountCodeId) continue;
          if (where.OR && Array.isArray(where.OR)) {
            const hasOrMatch = where.OR.some((clause: any) => {
              if (clause.discountCode?.is === null && !link.discountCodeId)
                return true;
              if (clause.discountCode?.disabledAt?.not !== undefined) {
                const dc = link.discountCodeId
                  ? db.discountCodes.get(link.discountCodeId)
                  : null;
                return dc && dc.disabledAt !== null;
              }
              if (clause.discountCode?.linkId === null) {
                return !link.discountCodeId;
              }
              return false;
            });
            if (!hasOrMatch) continue;
          }
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
          if (where.linkId && code.linkId !== where.linkId) continue;
          if (where.disabledAt === null && code.disabledAt !== null) continue;
          if (where.disabledAt?.not !== undefined && code.disabledAt === null)
            continue;
          return code;
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }: { where: any }) => {
        if (where.id) return db.discountCodes.get(where.id) || null;
        if (where.programId_code) {
          for (const code of db.discountCodes.values()) {
            if (
              code.programId === where.programId_code.programId &&
              code.code.toUpperCase() ===
                where.programId_code.code.toUpperCase()
            ) {
              return code;
            }
          }
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where?: any } = {}) => {
        let results = Array.from(db.discountCodes.values());
        if (where?.programId) {
          results = results.filter((c) => c.programId === where.programId);
        }
        if (where?.program?.projectId || where?.program?.workspaceId) {
          const wsId = where.program.projectId || where.program.workspaceId;
          results = results.filter((c) => {
            const project = db.projects.get(wsId);
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
        // Check uniqueness collision on code
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
        if (data.linkId && db.links.has(data.linkId)) {
          const link = db.links.get(data.linkId);
          db.links.set(data.linkId, { ...link, discountCodeId: data.id });
        }
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
          if (where?.id?.not && code.id === where.id.not) matches = false;
          if (where?.programId && code.programId !== where.programId)
            matches = false;
          if (where?.linkId && code.linkId !== where.linkId) matches = false;
          if (where?.disabledAt?.not !== undefined && code.disabledAt === null)
            matches = false;
          if (where?.disabledAt === null && code.disabledAt !== null)
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
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const record = db.discountCodes.get(where.id);
        db.discountCodes.delete(where.id);
        return record;
      }),
      deleteMany: vi.fn(async ({ where }: { where: any }) => {
        let count = 0;
        for (const [id, code] of db.discountCodes.entries()) {
          if (where?.id?.in && where.id.in.includes(id)) {
            db.discountCodes.delete(id);
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
              if (
                clause.updatedAt?.lt &&
                record.updatedAt >= clause.updatedAt.lt
              )
                return false;
              return true;
            });
            if (!orMatch) continue;
          }
          const incrementAttempts = data.attempts?.increment ?? 0;
          db.weleticShopifyWebhookEvents.set(key, {
            ...record,
            ...data,
            attempts: record.attempts + incrementAttempts,
            updatedAt: new Date(),
          });
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
    $queryRaw: vi.fn(async () => {
      const store = db.weleticShopifyStores.values().next().value;
      return store ? [store] : [];
    }),
    $transaction: vi.fn(async function (this: any, action: any) {
      return typeof action === "function" ? action(this) : Promise.all(action);
    }),
  },
}));

// Import implementations under test
import { DubApiError } from "@/lib/api/errors";
import { linkCache } from "@/lib/api/links/cache";
import { createDiscountCode } from "@/lib/discounts/create-discount-code";
import { shopifyDiscountProvider } from "@/lib/discounts/discount-provider-shopify";
import { generateDiscountCodeForPartner } from "@/lib/discounts/generate-discount-code-for-partner";
import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
  type CommissionRuleContext,
} from "@/lib/weletic/commissions/rules";
import {
  convertMoney,
  decimalToMinorUnits,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import { WeleticCommissionRule } from "@prisma/client";
import { discountsUpdate } from "../../app/(ee)/api/shopify/integration/webhook/discounts-sync";
import { POST as shopifyWebhookHandler } from "../../app/(ee)/api/shopify/integration/webhook/route";

// =============================================================================
// HELPER FACTORIES
// =============================================================================

function setupFreshDatabase() {
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

  const workspace = {
    id: "ws_yamax",
    name: "Yamax Activewear",
    slug: "yamax",
    shopifyStoreId: "yamax-demo.myshopify.com",
    stripeConnectId: null,
    defaultProgramId: "prog_yamax",
    webhookEnabled: true,
  };
  db.projects.set(workspace.id, workspace);

  const installation = {
    id: "inst_yamax",
    projectId: "ws_yamax",
    integrationId: "shopify",
    credentials: {
      shop: "yamax-demo.myshopify.com",
      accessToken: "shpat_test_access_token_123",
      shopVerifiedAt: "2026-08-28T00:00:00.000Z",
      shopVerificationTokenHash:
        "824a40839f0c1ecf0f9f796cabe39c26b10e767dca9ac170a12f56290e8fffd3",
      scope:
        "read_products,read_markets,read_orders,read_translations,read_customers,write_discounts",
      installationGeneration: "sgen_yamax_current",
    },
  };
  db.installedIntegrations.set(installation.id, installation);

  const store = {
    id: "store_yamax",
    projectId: "ws_yamax",
    programId: "prog_yamax",
    shopDomain: "yamax-demo.myshopify.com",
    complianceState: "active",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
    installationGeneration: "sgen_yamax_current",
    syncStatus: "succeeded",
    lastReconciledAt: null,
  };
  db.weleticShopifyStores.set(store.id, store);

  const parentDiscount = {
    id: "disc_demo10",
    programId: "prog_yamax",
    amount: 10,
    type: "percentage",
    provider: "shopify",
    couponId: "gid://shopify/DiscountCodeNode/1001",
    autoProvisionEnabledAt: new Date("2026-01-01T00:00:00Z"),
  };
  db.discounts.set(parentDiscount.id, parentDiscount);

  const group = {
    id: "grp_ambassadors",
    name: "Ambassadors",
    programId: "prog_yamax",
    discountId: "disc_demo10",
  };
  db.partnerGroups.set(group.id, group);

  const partner = {
    id: "partner_hiro",
    name: "Hiro Nguyen",
    email: "hiro@weletic.com",
    groupId: "grp_ambassadors",
    programId: "prog_yamax",
  };
  db.partners.set(partner.id, partner);

  const defaultLink = {
    id: "link_hiro_default",
    domain: "yamax.fit",
    key: "hiro",
    url: "https://yamax.fit/hiro",
    programId: "prog_yamax",
    partnerId: "partner_hiro",
    partnerGroupDefaultLinkId: "grp_def_link_1",
    discountCodeId: null,
  };
  db.links.set(defaultLink.id, defaultLink);

  return {
    workspace,
    installation,
    store,
    parentDiscount,
    group,
    partner,
    defaultLink,
  };
}

function computeHmac(body: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");
}

function createBaseRule(
  overrides: Partial<WeleticCommissionRule> = {},
): WeleticCommissionRule {
  return {
    id: overrides.id ?? "wrule_default",
    logicalKey: overrides.logicalKey ?? "default",
    version: overrides.version ?? 1,
    programId: overrides.programId ?? "prog_yamax",
    partnerId: overrides.partnerId ?? null,
    scope: overrides.scope ?? "program",
    ruleType: overrides.ruleType ?? "percentage",
    fixedAmountMode: overrides.fixedAmountMode ?? "line",
    priority: overrides.priority ?? 0,
    collectionExternalId: overrides.collectionExternalId ?? null,
    productId: overrides.productId ?? null,
    variantId: overrides.variantId ?? null,
    promotionCode: overrides.promotionCode ?? null,
    tag: overrides.tag ?? null,
    basisPoints: overrides.basisPoints ?? 1000, // 10%
    fixedAmount: overrides.fixedAmount ?? null,
    currency: overrides.currency ?? null,
    minOrderAmount: overrides.minOrderAmount ?? null,
    maxCommissionAmount: overrides.maxCommissionAmount ?? null,
    effectiveAt: overrides.effectiveAt ?? new Date("2026-01-01T00:00:00Z"),
    expiresAt: overrides.expiresAt ?? null,
    active: overrides.active ?? true,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

// =============================================================================
// TEST SUITE: 2-WAY SHOPIFY SYNCHRONIZATION E2E INTEGRATION SUITE
// =============================================================================

describe("Weletic 2-Way Shopify Sync & Simulation E2E Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFreshDatabase();
  });

  // ===========================================================================
  // TEST 1: FORWARD SYNC
  // ===========================================================================
  describe("Test 1: Forward Sync (Partner Creation ➜ Shopify Parent Discount Bulk Add & Collision Retries)", () => {
    it("1.1: generates partner code and executes discountRedeemCodeBulkAdd against parent discount DEMO10", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();

      // Mock Shopify GraphQL response for bulk add mutation
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        discountRedeemCodeBulkAdd: {
          bulkCreation: {
            id: "gid://shopify/DiscountRedeemCodeBulkCreation/555",
          },
          userErrors: [],
        },
      });

      await generateDiscountCodeForPartner({
        workspaceId: workspace.id,
        partner,
      });

      // Verify Shopify GraphQL mutation was executed with parent GID and uppercase partner code
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          shopifyStoreId: "yamax-demo.myshopify.com",
          accessToken: "shpat_test_access_token_123",
          variables: {
            discountId: "gid://shopify/DiscountCodeNode/1001",
            codes: [{ code: "HIRO10OFF" }],
          },
        }),
      );

      // Verify Weletic Database record creation
      const createdCode = Array.from(db.discountCodes.values()).find(
        (c) => c.code === "HIRO10OFF",
      );
      expect(createdCode).toBeDefined();
      expect(createdCode?.programId).toBe("prog_yamax");
      expect(createdCode?.partnerId).toBe(partner.id);
      expect(createdCode?.linkId).toBe(defaultLink.id);
      expect(createdCode?.discountId).toBe(parentDiscount.id);
      expect(createdCode?.disabledAt).toBeNull();

      // Verify link association
      const updatedLink = db.links.get(defaultLink.id);
      expect(updatedLink.discountCodeId).toBe(createdCode?.id);
    });

    it("1.2: creates standalone discount with discountCodeBasicCreate when no parent coupon is attached", async () => {
      const { workspace, partner, defaultLink } = setupFreshDatabase();

      // Create standalone percentage discount (couponId is null)
      const standaloneDiscount = {
        id: "disc_standalone_20",
        programId: "prog_yamax",
        amount: 20,
        type: "percentage" as const,
        provider: "shopify" as const,
        couponId: null,
        autoProvisionEnabledAt: new Date("2026-01-01T00:00:00Z"),
      };
      db.discounts.set(standaloneDiscount.id, standaloneDiscount as any);

      const standaloneGroup = {
        id: "grp_standalone",
        name: "Standalone Group",
        programId: "prog_yamax",
        discountId: "disc_standalone_20",
      };
      db.partnerGroups.set(standaloneGroup.id, standaloneGroup);

      const standalonePartner = {
        id: "partner_alex",
        name: "Alex Smith",
        email: "alex@weletic.com",
        groupId: "grp_standalone",
        programId: "prog_yamax",
      };
      db.partners.set(standalonePartner.id, standalonePartner);

      const standaloneLink = {
        id: "link_alex_default",
        domain: "yamax.fit",
        key: "alex",
        url: "https://yamax.fit/alex",
        programId: "prog_yamax",
        partnerId: "partner_alex",
        partnerGroupDefaultLinkId: "grp_def_link_2",
        discountCodeId: null,
      };
      db.links.set(standaloneLink.id, standaloneLink);

      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: "gid://shopify/DiscountCodeNode/2002",
            codeDiscount: {
              codes: { nodes: [{ code: "ALEX20OFF" }] },
            },
          },
          userErrors: [],
        },
      });

      await generateDiscountCodeForPartner({
        workspaceId: workspace.id,
        partner: standalonePartner,
      });

      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            basicCodeDiscount: expect.objectContaining({
              code: "ALEX20OFF",
              customerGets: expect.objectContaining({
                items: { all: true },
                value: { percentage: 0.2 },
              }),
            }),
          }),
        }),
      );

      const createdCode = Array.from(db.discountCodes.values()).find(
        (c) => c.code === "ALEX20OFF",
      );
      expect(createdCode).toBeDefined();
      expect(createdCode?.discountId).toBe("disc_standalone_20");
    });

    it("1.3: retries with random 2-character suffix on standalone code collision up to 3 attempts", async () => {
      const { workspace, partner, defaultLink } = setupFreshDatabase();

      const standaloneDiscount = {
        id: "disc_standalone_retry",
        programId: "prog_yamax",
        amount: 15,
        type: "percentage" as const,
        provider: "shopify" as const,
        couponId: null,
      };

      // 1st call fails with code already exists (TAKEN)
      // 2nd call succeeds with retried suffix code
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [
              {
                field: ["basicCodeDiscount", "code"],
                message: "Discount code already exists",
                code: "TAKEN",
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/3003",
              codeDiscount: {
                codes: { nodes: [{ code: "SAVE15AB" }] },
              },
            },
            userErrors: [],
          },
        });

      const result = await shopifyDiscountProvider.createDiscountCode({
        workspace,
        discount: standaloneDiscount as any,
        code: "SAVE15",
        shouldRetry: true,
      });

      expect(result.code).toBe("SAVE15AB");
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(2);
    });

    it("1.4: rolls back external Shopify discount code if local Prisma database insert hits uniqueness conflict", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();

      // Seed an existing conflicting record in DB with code "HIRO"
      db.discountCodes.set("dcode_existing", {
        id: "dcode_existing",
        code: "HIRO",
        programId: "prog_yamax",
        partnerId: "partner_other",
        linkId: "link_other",
        discountId: "disc_demo10",
        disabledAt: null,
      });

      // External Shopify call succeeds for standalone or bulk code
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          discountRedeemCodeBulkAdd: {
            bulkCreation: { id: "gid://shopify/Bulk/1" },
            userErrors: [],
          },
        })
        // Rollback call to delete code from Shopify
        .mockResolvedValueOnce({
          codeDiscountNodeByCode: { id: "gid://shopify/DiscountCodeNode/1001" },
        })
        .mockResolvedValueOnce({
          discountCodeDelete: {
            deletedCodeDiscountId: "gid://shopify/DiscountCodeNode/1001",
            userErrors: [],
          },
        });

      await expect(
        createDiscountCode({
          workspace,
          partner,
          link: defaultLink,
          discount: parentDiscount as any,
          code: "HIRO",
        }),
      ).rejects.toThrow(DubApiError);

      // Verify rollback execution
      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("codeDiscountNodeByCode"),
          variables: { code: "HIRO" },
        }),
      );
    });

    it("1.5: rejects discount code creation if link already has an active discount code assigned", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();

      // Assign an existing code to defaultLink
      db.discountCodes.set("dcode_assigned", {
        id: "dcode_assigned",
        code: "PREVIOUS10",
        programId: "prog_yamax",
        partnerId: partner.id,
        linkId: defaultLink.id,
        discountId: parentDiscount.id,
        disabledAt: null,
      });
      db.links.set(defaultLink.id, {
        ...defaultLink,
        discountCodeId: "dcode_assigned",
      });

      await expect(
        createDiscountCode({
          workspace,
          partner,
          link: defaultLink,
          discount: parentDiscount as any,
        }),
      ).rejects.toThrow(DubApiError);
    });

    it("1.6: skips discount code generation gracefully when partner has no groupId or autoProvision is disabled", async () => {
      const { workspace } = setupFreshDatabase();

      // Partner without groupId
      const partnerNoGroup = {
        id: "partner_nogrp",
        name: "No Group",
        groupId: null,
      };
      await generateDiscountCodeForPartner({
        workspaceId: workspace.id,
        partner: partnerNoGroup as any,
      });
      expect(shopifyAdminGraphql).not.toHaveBeenCalled();

      // Partner in group with autoProvisionEnabledAt = null
      const disabledDiscount = {
        id: "disc_disabled",
        programId: "prog_yamax",
        amount: 10,
        type: "percentage",
        provider: "shopify",
        autoProvisionEnabledAt: null,
      };
      db.discounts.set(disabledDiscount.id, disabledDiscount as any);
      const disabledGroup = {
        id: "grp_disabled",
        name: "Disabled Group",
        discountId: "disc_disabled",
        programId: "prog_yamax",
      };
      db.partnerGroups.set(disabledGroup.id, disabledGroup);
      const partnerDisabled = {
        id: "partner_dis",
        name: "Disabled Partner",
        groupId: "grp_disabled",
      };

      await generateDiscountCodeForPartner({
        workspaceId: workspace.id,
        partner: partnerDisabled as any,
      });
      expect(shopifyAdminGraphql).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // TEST 2: REVERSE SYNC
  // ===========================================================================
  describe("Test 2: Reverse Sync (Shopify Deletion/Update ➜ Webhook ➜ DB Soft-Delete & Cache Invalidation)", () => {
    const webhookSecret = "shpss_test_secret_weletic_2026";

    it("2.1: processes discounts/delete webhook, soft-deletes DB DiscountCode, and purges linkCache", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();

      // Create active discount code HIRO in DB
      const codeRecord = {
        id: "dcode_hiro_active",
        code: "HIRO",
        programId: "prog_yamax",
        partnerId: partner.id,
        linkId: defaultLink.id,
        discountId: parentDiscount.id,
        disabledAt: null,
      };
      db.discountCodes.set(codeRecord.id, codeRecord);
      db.links.set(defaultLink.id, {
        ...defaultLink,
        discountCodeId: codeRecord.id,
      });

      const payload = {
        id: 1001,
        admin_graphql_api_id: "gid://shopify/DiscountCodeNode/1001",
        code: "HIRO",
      };
      const rawBody = JSON.stringify(payload);
      const signature = computeHmac(rawBody, webhookSecret);

      process.env.SHOPIFY_WEBHOOK_SECRET = webhookSecret;

      const req = new Request(
        "https://app.weletic.com/api/shopify/integration/webhook",
        {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-demo.myshopify.com",
            "x-shopify-webhook-id": "wh_event_del_101",
            "x-shopify-hmac-sha256": signature,
            "content-type": "application/json",
          },
          body: rawBody,
        },
      );

      const response = await shopifyWebhookHandler(req);
      expect(response.status).toBe(200);
      const responseText = await response.text();
      expect(responseText).toContain(
        "Successfully disabled 1 discount code(s)",
      );

      // Assert DB state: disabledAt is now populated
      const updatedCode = db.discountCodes.get(codeRecord.id);
      expect(updatedCode?.disabledAt).not.toBeNull();
      expect(updatedCode?.disabledAt instanceof Date).toBe(true);

      // Assert cache invalidation was triggered
      expect(linkCache.expireMany).toHaveBeenCalledWith([
        expect.objectContaining({ domain: "yamax.fit", key: "hiro" }),
      ]);
      expect(linkCache.delete).toHaveBeenCalledWith({
        domain: "yamax.fit",
        key: "hiro",
      });
    });

    it("2.2: enforces strict HMAC-SHA256 signature verification in webhook router", async () => {
      const { workspace } = setupFreshDatabase();
      process.env.SHOPIFY_WEBHOOK_SECRET = webhookSecret;

      const rawBody = JSON.stringify({ id: 1001, code: "HIRO" });
      const validSignature = computeHmac(rawBody, webhookSecret);
      const tamperedBody = JSON.stringify({ id: 1001, code: "TAMPERED" });

      // Valid signature succeeds
      expect(
        verifyShopifyWebhookSignature({
          body: rawBody,
          signature: validSignature,
          secret: webhookSecret,
        }),
      ).toBe(true);

      // Tampered payload fails
      expect(
        verifyShopifyWebhookSignature({
          body: tamperedBody,
          signature: validSignature,
          secret: webhookSecret,
        }),
      ).toBe(false);

      // Invalid signature fails
      expect(
        verifyShopifyWebhookSignature({
          body: rawBody,
          signature: "invalid_base64_hmac",
          secret: webhookSecret,
        }),
      ).toBe(false);
    });

    it("2.3: deduplicates simultaneous and repeat deliveries of the same webhookId", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();
      process.env.SHOPIFY_WEBHOOK_SECRET = webhookSecret;

      // Seed discount code
      db.discountCodes.set("dcode_idem", {
        id: "dcode_idem",
        code: "HIRO",
        programId: "prog_yamax",
        partnerId: partner.id,
        linkId: defaultLink.id,
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      const payload = { id: 1001, code: "HIRO" };
      const rawBody = JSON.stringify(payload);
      const signature = computeHmac(rawBody, webhookSecret);

      const makeRequest = () =>
        new Request("https://app.weletic.com/api/shopify/integration/webhook", {
          method: "POST",
          headers: {
            "x-shopify-topic": "discounts/delete",
            "x-shopify-shop-domain": "yamax-demo.myshopify.com",
            "x-shopify-webhook-id": "wh_idempotent_999",
            "x-shopify-hmac-sha256": signature,
          },
          body: rawBody,
        });

      // 1st delivery processes successfully
      const res1 = await shopifyWebhookHandler(makeRequest());
      expect(res1.status).toBe(200);

      // 2nd repeat delivery acknowledges deduplication without redundant work
      const res2 = await shopifyWebhookHandler(makeRequest());
      expect(res2.status).toBe(200);
      const text2 = await res2.text();
      expect(text2).toContain("Duplicate webhook was already processed");
    });

    it("2.4: processes discounts/update webhook when discount transitions to EXPIRED or DISABLED status", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();

      const codeRecord = {
        id: "dcode_hiro_status",
        code: "HIRO",
        programId: "prog_yamax",
        partnerId: partner.id,
        linkId: defaultLink.id,
        discountId: parentDiscount.id,
        disabledAt: null,
      };
      db.discountCodes.set(codeRecord.id, codeRecord);

      // Webhook event indicating discount has expired
      const updateResult = await discountsUpdate({
        event: {
          id: 1001,
          code: "HIRO",
          status: "expired",
          ends_at: new Date(Date.now() - 3600_000).toISOString(),
        },
        workspace,
      });

      expect(updateResult).toContain(
        "Successfully disabled 1 discount code(s)",
      );
      expect(db.discountCodes.get(codeRecord.id)?.disabledAt).not.toBeNull();
    });

    it("2.5: reactivates discount code when discounts/update webhook transitions status back to ACTIVE", async () => {
      const { workspace, partner, defaultLink, parentDiscount } =
        setupFreshDatabase();

      // Seed disabled discount code
      const codeRecord = {
        id: "dcode_hiro_inactive",
        code: "HIRO",
        programId: "prog_yamax",
        partnerId: partner.id,
        linkId: defaultLink.id,
        discountId: parentDiscount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      };
      db.discountCodes.set(codeRecord.id, codeRecord);

      const updateResult = await discountsUpdate({
        event: {
          id: 1001,
          code: "HIRO",
          status: "active",
        },
        workspace,
      });

      expect(updateResult).toContain("reactivated");
      expect(db.discountCodes.get(codeRecord.id)?.disabledAt).toBeNull();
    });
  });

  // ===========================================================================
  // TEST 3: FINANCIAL SETTLEMENT & INVARIANT ENGINE
  // ===========================================================================
  describe("Test 3: Financial Settlement & ADR 0004 Proportional Refund Invariant", () => {
    const baseTimestamp = new Date("2026-08-20T12:00:00Z");

    const leggingsRule = createBaseRule({
      id: "rule_leggings_20",
      scope: "product",
      productId: "prod_leggings",
      basisPoints: 2000, // 20%
      priority: 100,
    });

    const tankRule = createBaseRule({
      id: "rule_tank_10",
      scope: "product",
      productId: "prod_tank",
      basisPoints: 1000, // 10%
      priority: 100,
    });

    const defaultProgramRule = createBaseRule({
      id: "rule_default_prog_5",
      scope: "program",
      basisPoints: 500, // 5%
      priority: 0,
    });

    const rules = [leggingsRule, tankRule, defaultProgramRule];

    it("3.1: multi-line order attribution accurately calculates line earnings and total commission under orders/paid", () => {
      // Line 1: Yamax Agile™ Leggings ($100.00 / 10,000 cents), 20% commission -> $20.00 (2,000 cents)
      const line1Ctx: CommissionRuleContext = {
        programId: "prog_yamax",
        partnerId: "partner_hiro",
        productId: "prod_leggings",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000), // $100.00
        quantity: 1,
        occurredAt: baseTimestamp,
      };
      const line1Rule = selectCommissionRule(rules, line1Ctx);
      expect(line1Rule?.id).toBe("rule_leggings_20");
      const line1Earnings = calculateCommission({
        rule: line1Rule!,
        context: line1Ctx,
      });
      expect(line1Earnings).toBe(BigInt(2000)); // $20.00

      // Line 2: Yamax Flow™ Tank Top ($50.00 / 5,000 cents), 10% commission -> $5.00 (500 cents)
      const line2Ctx: CommissionRuleContext = {
        programId: "prog_yamax",
        partnerId: "partner_hiro",
        productId: "prod_tank",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(5000), // $50.00
        quantity: 1,
        occurredAt: baseTimestamp,
      };
      const line2Rule = selectCommissionRule(rules, line2Ctx);
      expect(line2Rule?.id).toBe("rule_tank_10");
      const line2Earnings = calculateCommission({
        rule: line2Rule!,
        context: line2Ctx,
      });
      expect(line2Earnings).toBe(BigInt(500)); // $5.00

      // Total order commission = $25.00 (2500 cents)
      const totalCommission = line1Earnings + line2Earnings;
      expect(totalCommission).toBe(BigInt(2500));
    });

    it("3.2: first partial refund (50% on Line 1) claws back exactly 50% commission via ADR 0004 proportional rule", () => {
      const line1TotalAmount = BigInt(10000); // $100.00
      const line1Earnings = BigInt(2000); // $20.00
      const refundAmount = BigInt(5000); // $50.00 refund (50%)

      const reversal = calculateRefundReversal({
        originalCommissionableAmount: line1TotalAmount,
        originalEarnings: line1Earnings,
        alreadyReversed: BigInt(0),
        refundedAmount: refundAmount,
      });

      expect(reversal).toBe(BigInt(1000)); // $10.00 reversed

      const netLine1Earnings = line1Earnings - reversal;
      expect(netLine1Earnings).toBe(BigInt(1000)); // $10.00 net
    });

    it("3.3: second partial refund (remaining 50% on Line 1) claws back remaining commission and isolates Line 2", () => {
      const line1TotalAmount = BigInt(10000);
      const line1Earnings = BigInt(2000);
      const priorReversed = BigInt(1000); // $10.00 already reversed
      const secondRefundAmount = BigInt(5000); // Remaining $50.00

      const secondReversal = calculateRefundReversal({
        originalCommissionableAmount: line1TotalAmount,
        originalEarnings: line1Earnings,
        alreadyReversed: priorReversed,
        refundedAmount: secondRefundAmount,
      });

      expect(secondReversal).toBe(BigInt(1000)); // $10.00 reversed

      const totalReversedLine1 = priorReversed + secondReversal;
      expect(totalReversedLine1).toBe(BigInt(2000)); // 100% reversed
      const netLine1 = line1Earnings - totalReversedLine1;
      expect(netLine1).toBe(BigInt(0)); // $0.00 net on Line 1

      // Line 2 ($5.00 earnings) remains 100% untouched (Line isolation invariant)
      const line2Earnings = BigInt(500);
      const netOrderEarnings = netLine1 + line2Earnings;
      expect(netOrderEarnings).toBe(BigInt(500)); // $5.00 net order
    });

    it("3.4: over-refund attempt on Line 1 is strictly clamped to original earnings (Upper-Bound Invariant)", () => {
      const line1TotalAmount = BigInt(10000);
      const line1Earnings = BigInt(2000);
      const priorReversed = BigInt(2000); // Already 100% reversed
      const excessRefundAmount = BigInt(2000); // Attempting to refund another $20.00

      const excessReversal = calculateRefundReversal({
        originalCommissionableAmount: line1TotalAmount,
        originalEarnings: line1Earnings,
        alreadyReversed: priorReversed,
        refundedAmount: excessRefundAmount,
      });

      // Clamped to 0 (cannot reverse more than original earnings)
      expect(excessReversal).toBe(BigInt(0));
    });

    it("3.5: 3-way uneven proportional split preserves penny conservation with 0 rounding leakage", () => {
      // $100.00 order with 3 lines: $33.33, $33.33, $33.34 with total commission 1000 cents ($10.00)
      const lineAmounts = [BigInt(3333), BigInt(3333), BigInt(3334)];
      const totalCommission = BigInt(1000);

      const allocatedCommissions = allocateCommissionProportionally({
        total: totalCommission,
        amounts: lineAmounts,
      });

      expect(allocatedCommissions).toHaveLength(3);
      const sumAllocated = allocatedCommissions.reduce(
        (a, b) => a + b,
        BigInt(0),
      );
      expect(sumAllocated).toBe(totalCommission); // Exact conservation (1000 cents)

      // Refund of Line 1 ($33.33)
      const line1Reversal = calculateRefundReversal({
        originalCommissionableAmount: lineAmounts[0],
        originalEarnings: allocatedCommissions[0],
        alreadyReversed: BigInt(0),
        refundedAmount: lineAmounts[0],
      });
      expect(line1Reversal).toBe(allocatedCommissions[0]);
    });

    it("3.6: validates multi-currency integer arithmetic across USD, JPY, EUR, and VND", () => {
      // USD ($120.50 -> 12050 cents)
      expect(decimalToMinorUnits("120.50", "USD")).toBe(BigInt(12050));

      // JPY (¥6000 -> 6000 yen, 0 decimals)
      expect(decimalToMinorUnits("6000", "JPY")).toBe(BigInt(6000));

      // EUR (€85.00 -> 8500 cents)
      expect(decimalToMinorUnits("85.00", "EUR")).toBe(BigInt(8500));

      // VND (₫500000 -> 500000 dong, 0 decimals)
      expect(decimalToMinorUnits("500000", "VND")).toBe(BigInt(500000));

      // Conversion from minor to minor units with exchange rate
      const usdMoney = {
        amount: BigInt(10000),
        currency: normalizeCurrency("USD"),
      }; // $100.00
      const fxQuote = {
        base: normalizeCurrency("USD"),
        quote: normalizeCurrency("JPY"),
        rate: "155.5",
        provider: "ecb",
        capturedAt: new Date("2026-08-20T00:00:00Z"),
      }; // 1 USD = 155.5 JPY
      const jpyMoney = convertMoney(usdMoney, fxQuote);
      expect(jpyMoney.amount).toBe(BigInt(15550)); // ¥15,550
      expect(jpyMoney.currency).toBe(normalizeCurrency("JPY"));
    });
  });

  // ===========================================================================
  // TEST 4: RECONCILIATION & DRIFT AUTO-HEALING
  // ===========================================================================
  describe("Test 4: Discount Drift Detection & Safe Reconciliation", () => {
    it("4.1: auto-heals local drift and keeps owned remote cleanup report-only", async () => {
      const { workspace, store, parentDiscount } = setupFreshDatabase();

      // SETUP 4 TEST CONDITIONS:
      // State 1: SYNCED10 — Active in DB & Active in Shopify (In-Sync)
      db.discountCodes.set("dcode_synced", {
        id: "dcode_synced",
        code: "SYNCED10",
        programId: "prog_yamax",
        partnerId: "partner_1",
        linkId: "link_1",
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      // State 2: ORPHAN_DB_20 — Active in DB, Missing in Shopify (Orphaned in Weletic)
      db.discountCodes.set("dcode_orphan_db", {
        id: "dcode_orphan_db",
        code: "ORPHAN_DB_20",
        programId: "prog_yamax",
        partnerId: "partner_2",
        linkId: "link_2",
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      // State 4: DESYNC_DISABLED_40 — Disabled in DB, Active in Shopify (Status Desync)
      db.discountCodes.set("dcode_desync_disabled", {
        id: "dcode_desync_disabled",
        code: "DESYNC_DISABLED_40",
        programId: "prog_yamax",
        partnerId: "partner_4",
        linkId: "link_4",
        discountId: parentDiscount.id,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      });

      // State 5: DESYNC_EXPIRED_50 — Active in DB, Expired in Shopify (Status Desync)
      db.discountCodes.set("dcode_desync_expired", {
        id: "dcode_desync_expired",
        code: "DESYNC_EXPIRED_50",
        programId: "prog_yamax",
        partnerId: "partner_5",
        linkId: "link_5",
        discountId: parentDiscount.id,
        disabledAt: null,
      });

      // Mock Shopify GraphQL nodes returned during scan:
      // - Node 1: SYNCED10 (status: ACTIVE)
      // - Node 3: ORPHAN_SHOP_30 (status: ACTIVE, title: "Dub Discount (ORPHAN_SHOP_30)") -> Orphaned in Shopify
      // - Node 4: DESYNC_DISABLED_40 (status: ACTIVE)
      // - Node 5: DESYNC_EXPIRED_50 (status: EXPIRED)
      // Note: ORPHAN_DB_20 is omitted from Shopify response (simulating deletion on Shopify)
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        codeDiscountNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/DiscountCodeNode/101",
              codeDiscount: {
                title: "Dub Discount (SYNCED10)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "code_101", code: "SYNCED10", asyncUsageCount: 0 },
                  ],
                },
              },
            },
            {
              id: "gid://shopify/DiscountCodeNode/103",
              codeDiscount: {
                title: "Dub Discount (ORPHAN_SHOP_30)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "code_103",
                      code: "ORPHAN_SHOP_30",
                      asyncUsageCount: 0,
                    },
                  ],
                },
              },
            },
            {
              id: "gid://shopify/DiscountCodeNode/104",
              codeDiscount: {
                title: "Dub Discount (DESYNC_DISABLED_40)",
                status: "ACTIVE",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "code_104",
                      code: "DESYNC_DISABLED_40",
                      asyncUsageCount: 0,
                    },
                  ],
                },
              },
            },
            {
              id: "gid://shopify/DiscountCodeNode/105",
              codeDiscount: {
                title: "Dub Discount (DESYNC_EXPIRED_50)",
                status: "EXPIRED",
                codes: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "code_105",
                      code: "DESYNC_EXPIRED_50",
                      asyncUsageCount: 0,
                    },
                  ],
                },
              },
            },
          ],
        },
      });

      // Execute reconciliation with autoHeal: true
      const result = await reconcileWeleticShopifyDiscounts({
        workspaceId: workspace.id,
        autoHeal: true,
      });

      // Assert results
      expect(result.driftStates.inSync).toBe(1); // SYNCED10
      expect(result.driftStates.orphanedInWeletic).toBe(1); // ORPHAN_DB_20
      expect(result.driftStates.orphanedInShopify).toBe(0); // ORPHAN_SHOP_30 has no authoritative ownership evidence
      expect(result.driftStates.statusDesyncShopifyActive).toBe(1); // DESYNC_DISABLED_40
      expect(result.driftStates.statusDesyncShopifyInactive).toBe(1); // DESYNC_EXPIRED_50

      expect(result.healedCount).toBe(2);
      expect(result.manualCleanupCount).toBe(1);
      expect(result.issues).toHaveLength(3);
      expect(result.issues.filter((issue) => issue.healed)).toHaveLength(2);
      expect(
        result.issues.find((issue) => issue.code === "DESYNC_DISABLED_40"),
      ).toMatchObject({
        healed: false,
        details: {
          requiresManualCleanup: true,
          cleanupMode: "manual_verified_shopify_cleanup",
          ownershipEvidence: { source: "discount_code_row" },
        },
      });
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);

      // Assert DB state after auto-healing:
      // DESYNC_EXPIRED_50 soft-deleted in DB
      expect(
        db.discountCodes.get("dcode_desync_expired")?.disabledAt,
      ).not.toBeNull();

      // Assert WeleticReconciliationIssue records in DB
      const issuesInDb = Array.from(db.weleticReconciliationIssues.values());
      expect(issuesInDb).toHaveLength(3);
      expect(
        issuesInDb.filter((issue) => issue.status === "resolved"),
      ).toHaveLength(2);
      expect(
        issuesInDb.find((issue) => issue.externalKey === "DESYNC_DISABLED_40")
          ?.status,
      ).toBe("open");
    });

    it("4.2: handles multi-page GraphQL pagination gracefully when fetching Shopify discount nodes", async () => {
      const { workspace } = setupFreshDatabase();

      // Page 1: 1 node + hasNextPage: true
      // Page 2: 1 node + hasNextPage: false
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: true, endCursor: "cursor_page_2" },
            nodes: [
              {
                id: "gid://shopify/DiscountCodeNode/P1",
                codeDiscount: {
                  title: "Dub Discount (PAGE1)",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ id: "c_p1", code: "PAGE1", asyncUsageCount: 0 }],
                  },
                },
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          codeDiscountNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "gid://shopify/DiscountCodeNode/P2",
                codeDiscount: {
                  title: "Dub Discount (PAGE2)",
                  status: "ACTIVE",
                  codes: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ id: "c_p2", code: "PAGE2", asyncUsageCount: 0 }],
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

      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(2);
      expect(shopifyAdminGraphql).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          variables: expect.objectContaining({ after: "cursor_page_2" }),
        }),
      );
    });
  });
});
