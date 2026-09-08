import { prisma } from "@/lib/prisma";
import { customerRedemptionPointsRequestedSchema } from "@/lib/weletic/loyalty/customer-redemption-request";
import {
  readWeleticShopifyRequestBody,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Admin Route Handlers
import {
  GET as getAccounts,
  POST as postAccounts,
} from "../../app/(ee)/api/shopify/loyalty/admin/accounts/route";
import { GET as getActivity } from "../../app/(ee)/api/shopify/loyalty/admin/activity/route";
import { POST as postAdjust } from "../../app/(ee)/api/shopify/loyalty/admin/adjust/route";
import { POST as postBackfill } from "../../app/(ee)/api/shopify/loyalty/admin/backfill/route";
import {
  DELETE as deleteReward,
  POST as postReward,
  PUT as putReward,
} from "../../app/(ee)/api/shopify/loyalty/admin/rewards/route";
import { POST as postSettings } from "../../app/(ee)/api/shopify/loyalty/admin/settings/route";
import { DELETE as deleteTier } from "../../app/(ee)/api/shopify/loyalty/admin/tiers/route";

// Internal Route Handlers
import { POST as internalPostRedeem } from "../../app/api/internal/shopify/loyalty/customer/redeem/route";
import { GET as internalGetCustomer } from "../../app/api/internal/shopify/loyalty/customer/route";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb) => {
      try {
        if (typeof cb === "function") cb();
      } catch {}
    }),
  };
});
vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (fn: any) => fn,
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), flush: vi.fn() },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: vi.fn() })),
}));

// Mock store-resolver
vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: vi.fn(async (domain: string) => {
    if (
      domain === "tenant-a.myshopify.com" ||
      domain === "yamaxdev.myshopify.com"
    ) {
      return {
        storeId: "store_tenant_a",
        workspaceId: "ws_tenant_a",
        shopDomain: domain,
        isActive: true,
      };
    }
    if (domain === "tenant-b.myshopify.com") {
      return {
        storeId: "store_tenant_b",
        workspaceId: "ws_tenant_b",
        shopDomain: domain,
        isActive: true,
      };
    }
    return null;
  }),
}));

let currentTestRole = "owner";
let currentUserId = "usr_owner_1";
let currentWorkspaceId = "ws_tenant_a";
let authenticatedSession: any = {
  user: { id: currentUserId, email: "user@weletic.com" },
};

vi.mock("@/lib/auth/utils", () => ({
  getSession: vi.fn(async () => authenticatedSession),
}));

vi.mock("@/lib/auth/workspace-cache", () => ({
  workspaceAuthCache: {
    get: vi.fn(({ identifier, userId }) => {
      if (identifier === "ws_invalid" || !authenticatedSession) return null;
      return {
        id: identifier || currentWorkspaceId,
        slug: "test-workspace",
        plan: "enterprise",
        users: [
          {
            userId: currentUserId,
            role: currentTestRole,
            defaultFolderId: null,
            workspacePreferences: null,
          },
        ],
      };
    }),
    set: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: vi.fn(), findFirst: vi.fn() },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticLoyaltyBackfillJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyBackfillPreviewItem: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    weleticRewardDefinition: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyTier: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyEarningRule: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyBonusCampaign: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticShopper: { findFirst: vi.fn(), findUnique: vi.fn() },
    project: { findUnique: vi.fn() },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

const TEST_SECRET = "test-secret-at-least-32-characters-long-1234567890abcdef";

describe("Milestone 1 (M1): Adversarial Security & Anti-Abuse Stress Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", TEST_SECRET);
    currentTestRole = "owner";
    currentUserId = "usr_owner_1";
    currentWorkspaceId = "ws_tenant_a";
    authenticatedSession = {
      user: { id: currentUserId, email: "user@weletic.com" },
    };

    // Default mock store for Tenant A
    (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
      async ({ where }: any) => {
        if (
          where?.projectId === "ws_tenant_a" ||
          where?.id === "store_tenant_a"
        ) {
          return {
            id: "store_tenant_a",
            projectId: "ws_tenant_a",
            shopDomain: "tenant-a.myshopify.com",
            shopCurrency: "USD",
          } as any;
        }
        if (
          where?.projectId === "ws_tenant_b" ||
          where?.id === "store_tenant_b"
        ) {
          return {
            id: "store_tenant_b",
            projectId: "ws_tenant_b",
            shopDomain: "tenant-b.myshopify.com",
            shopCurrency: "EUR",
          } as any;
        }
        return null;
      },
    );

    (prisma.weleticShopifyStore.findFirst as any).mockImplementation(
      async ({ where }: any) => {
        if (where?.projectId === "ws_tenant_a") {
          return {
            id: "store_tenant_a",
            projectId: "ws_tenant_a",
            shopDomain: "tenant-a.myshopify.com",
            shopCurrency: "USD",
          } as any;
        }
        if (where?.projectId === "ws_tenant_b") {
          return {
            id: "store_tenant_b",
            projectId: "ws_tenant_b",
            shopDomain: "tenant-b.myshopify.com",
            shopCurrency: "EUR",
          } as any;
        }
        return null;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // =========================================================================
  // 1. CROSS-TENANT IDOR ATTACKS
  // =========================================================================
  describe("1. Cross-Tenant IDOR Attack Resilience", () => {
    it("IDOR-1: blocks tenant A from reading tenant B's account details via accountId injection", async () => {
      // Mock: account belongs to Tenant B (storeId: store_tenant_b)
      (prisma.weleticLoyaltyAccount.findFirst as any).mockImplementation(
        async ({ where }: any) => {
          if (
            where?.id === "acc_tenant_b" &&
            where?.storeId === "store_tenant_a"
          ) {
            return null; // Tenant A store query must return null
          }
          if (
            where?.id === "acc_tenant_b" &&
            where?.storeId === "store_tenant_b"
          ) {
            return {
              id: "acc_tenant_b",
              storeId: "store_tenant_b",
              cachedPointsBalance: BigInt(5000),
            } as any;
          }
          return null;
        },
      );

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/accounts?workspaceId=ws_tenant_a&accountId=acc_tenant_b",
      ) as any;
      const res = await getAccounts(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.message).toContain("not found");
      expect(prisma.weleticLoyaltyAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "acc_tenant_b", storeId: "store_tenant_a" },
        }),
      );
    });

    it("IDOR-2: blocks tenant A from adjusting points on tenant B's account", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
        null,
      ); // Not found under store_tenant_a

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/adjust?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: "acc_tenant_b",
            pointsDelta: 1000,
            reason: "Malicious cross-tenant injection",
          }),
        },
      ) as any;
      const res = await postAdjust(req, { params: Promise.resolve({}) });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.message).toContain("not found for this store");
    });

    it("IDOR-3: blocks tenant A from mutating or deleting tenant B's reward definition", async () => {
      vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValueOnce(
        null,
      ); // Not found under store_tenant_a

      // PUT attempt
      const reqPut = new Request(
        "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "reward_tenant_b",
            name: "Hacked Reward",
            pointsCost: 1,
          }),
        },
      ) as any;
      const resPut = await putReward(reqPut, { params: Promise.resolve({}) });
      expect(resPut.status).toBe(404);
      const dataPut = await resPut.json();
      expect(dataPut.error.message).toContain("not found for this store");

      // DELETE attempt
      vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValueOnce(
        null,
      );
      const reqDel = new Request(
        "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a&id=reward_tenant_b",
        { method: "DELETE" },
      ) as any;
      const resDel = await deleteReward(reqDel, {
        params: Promise.resolve({}),
      });
      expect(resDel.status).toBe(404);
    });

    it("IDOR-4: blocks tenant A from deleting tenant B's VIP tier", async () => {
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce({
        id: "prog_tenant_a",
        storeId: "store_tenant_a",
      } as any);
      vi.mocked(prisma.weleticLoyaltyTier.findFirst).mockResolvedValueOnce(
        null,
      ); // Not found in prog_tenant_a

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/tiers?workspaceId=ws_tenant_a&id=wtier_tenant_b",
        { method: "DELETE" },
      ) as any;
      const res = await deleteTier(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.message).toContain("not found for this store program");
    });

    it("IDOR-5: blocks tenant A from committing or cancelling tenant B's backfill job", async () => {
      vi.mocked(
        prisma.weleticLoyaltyBackfillJob.findUnique,
      ).mockResolvedValueOnce({
        id: "job_tenant_b",
        storeId: "store_tenant_b", // Belongs to Tenant B
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/backfill?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "commit", jobId: "job_tenant_b" }),
        },
      ) as any;
      const res = await postBackfill(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.message).toContain("not found for this store");
    });
  });

  // =========================================================================
  // 2. PRIVILEGE ESCALATION & GRANULAR RBAC ENFORCEMENT
  // =========================================================================
  describe("2. Non-Owner Privilege Escalation & Role Matrix", () => {
    const sensitiveEndpoints = [
      {
        name: "Adjust points",
        handler: postAdjust,
        method: "POST",
        path: "/api/shopify/loyalty/admin/adjust",
        body: { accountId: "acc_1", pointsDelta: 100 },
      },
      {
        name: "Accounts manual adjust",
        handler: postAccounts,
        method: "POST",
        path: "/api/shopify/loyalty/admin/accounts",
        body: { accountId: "acc_1", pointsDelta: 100 },
      },
      {
        name: "Settings kill switch",
        handler: postSettings,
        method: "POST",
        path: "/api/shopify/loyalty/admin/settings",
        body: { killSwitchActive: true },
      },
      {
        name: "Settings status change",
        handler: postSettings,
        method: "POST",
        path: "/api/shopify/loyalty/admin/settings",
        body: { status: "disabled" },
      },
      {
        name: "Backfill commit",
        handler: postBackfill,
        method: "POST",
        path: "/api/shopify/loyalty/admin/backfill",
        body: { action: "commit", jobId: "job_1" },
      },
      {
        name: "Backfill cancel",
        handler: postBackfill,
        method: "POST",
        path: "/api/shopify/loyalty/admin/backfill",
        body: { action: "cancel", jobId: "job_1" },
      },
      {
        name: "Activity CSV export",
        handler: getActivity,
        method: "GET",
        path: "/api/shopify/loyalty/admin/activity?format=csv",
        body: null,
      },
    ];

    for (const ep of sensitiveEndpoints) {
      it(`blocks non-owner role 'member' from executing ${ep.name} with 403`, async () => {
        currentTestRole = "member";
        const req = new Request(
          `http://localhost${ep.path}${ep.path.includes("?") ? "&" : "?"}workspaceId=ws_tenant_a`,
          {
            method: ep.method,
            headers: ep.body ? { "Content-Type": "application/json" } : {},
            body: ep.body ? JSON.stringify(ep.body) : undefined,
          },
        ) as any;

        const res = await ep.handler(req, { params: Promise.resolve({}) });
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error.code).toMatch(/forbidden|unauthorized/);
      });

      it(`blocks read-only role 'viewer' from executing ${ep.name} with 403`, async () => {
        currentTestRole = "viewer";
        const req = new Request(
          `http://localhost${ep.path}${ep.path.includes("?") ? "&" : "?"}workspaceId=ws_tenant_a`,
          {
            method: ep.method,
            headers: ep.body ? { "Content-Type": "application/json" } : {},
            body: ep.body ? JSON.stringify(ep.body) : undefined,
          },
        ) as any;

        const res = await ep.handler(req, { params: Promise.resolve({}) });
        expect(res.status).toBe(403);
      });
    }

    it("allows non-owner role 'member' to execute standard loyalty.write actions (e.g. create reward)", async () => {
      currentTestRole = "member";
      vi.mocked(prisma.weleticRewardDefinition.create).mockResolvedValueOnce({
        id: "reward_new",
        storeId: "store_tenant_a",
        name: "10% Discount",
        rewardType: "discount_percentage",
        pointsCost: BigInt(100),
        discountValue: 10,
        minOrderAmount: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const req = new Request(
        "http://localhost/api/shopify/loyalty/admin/rewards?workspaceId=ws_tenant_a",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "10% Discount",
            rewardType: "discount_percentage",
            pointsCost: 100,
          }),
        },
      ) as any;
      const res = await postReward(req, { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.name).toBe("10% Discount");
    });
  });

  // =========================================================================
  // 3. HMAC FORGERY, TAMPERING & CRYPTOGRAPHIC BOUNDARY
  // =========================================================================
  describe("3. HMAC Forgery, Payload Tampering & Secret Enforcement", () => {
    it("HMAC-1: rejects requests signed with an attacker's wrong secret", () => {
      const attackerSecret = "attacker-secret-that-is-32-chars-long-123456";
      const now = Date.now();
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const attackerSig = signWeleticShopifyRequest({
        timestamp: String(now),
        method: "GET",
        path,
        body,
        secret: attackerSecret,
      });

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(now),
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: attackerSig,
        },
      });

      expect(verifyWeleticShopifyRequest({ request: req, body, now })).toBe(
        false,
      );
    });

    it("HMAC-2: rejects single-bit flipped signature (tampered signature)", () => {
      const now = Date.now();
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const validSig = signWeleticShopifyRequest({
        timestamp: String(now),
        method: "GET",
        path,
        body,
        secret: TEST_SECRET,
      });

      // Flip last character
      const lastChar = validSig.slice(-1);
      const tamperedChar = lastChar === "a" ? "b" : "a";
      const tamperedSig = validSig.slice(0, -1) + tamperedChar;

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(now),
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: tamperedSig,
        },
      });

      expect(verifyWeleticShopifyRequest({ request: req, body, now })).toBe(
        false,
      );
    });

    it("HMAC-3: rejects malformed signature formats (non-hex, truncated, spaces, null bytes)", () => {
      const now = Date.now();
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const malformedSignatures = [
        "", // empty
        "abcd", // too short
        "a".repeat(63), // 63 chars (must be 64)
        "a".repeat(65), // 65 chars
        "g".repeat(64), // invalid hex 'g'
        "z".repeat(64), // invalid hex 'z'
        "!" + "a".repeat(63), // non-hex symbol
        "null",
        "undefined",
      ];

      for (const badSig of malformedSignatures) {
        const req = new Request(`https://app.weletic.com${path}`, {
          method: "GET",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(now),
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: badSig,
          },
        });

        expect(verifyWeleticShopifyRequest({ request: req, body, now })).toBe(
          false,
        );
      }
    });

    it("HMAC-4: fails closed when WELETIC_SHOPIFY_SERVICE_SECRET is unset or under 32 characters", () => {
      const now = Date.now();
      const path = "/api/internal/shopify/loyalty/customer";
      const body = "";

      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", "");
      const reqEmpty = new Request(`https://app.weletic.com${path}`, {
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(now),
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "a".repeat(64),
        },
      });
      expect(() =>
        verifyWeleticShopifyRequest({ request: reqEmpty, body, now }),
      ).toThrow("must be at least 32 characters");

      vi.stubEnv(
        "WELETIC_SHOPIFY_SERVICE_SECRET",
        "short_secret_under_32_chars",
      );
      expect(() =>
        verifyWeleticShopifyRequest({ request: reqEmpty, body, now }),
      ).toThrow("must be at least 32 characters");
    });
  });

  // =========================================================================
  // 4. CLOCK SKEW & REPLAY ATTACKS
  // =========================================================================
  describe("4. Clock Skew & Replay Attack Defense", () => {
    it("TIME-1: rejects timestamps older than 5 minutes (300,001 ms in past)", () => {
      const now = 1724000000000;
      const staleTimestamp = String(
        now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1,
      );
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const sig = signWeleticShopifyRequest({
        timestamp: staleTimestamp,
        method: "GET",
        path,
        body,
        secret: TEST_SECRET,
      });

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: staleTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: sig,
        },
      });

      expect(verifyWeleticShopifyRequest({ request: req, body, now })).toBe(
        false,
      );
    });

    it("TIME-2: rejects timestamps further than 5 minutes in future (300,001 ms ahead)", () => {
      const now = 1724000000000;
      const futureTimestamp = String(
        now + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1,
      );
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const sig = signWeleticShopifyRequest({
        timestamp: futureTimestamp,
        method: "GET",
        path,
        body,
        secret: TEST_SECRET,
      });

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: futureTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: sig,
        },
      });

      expect(verifyWeleticShopifyRequest({ request: req, body, now })).toBe(
        false,
      );
    });

    it("TIME-3: accepts timestamps exactly on the 300,000 ms boundary", () => {
      const now = 1724000000000;
      const boundaryPast = String(now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS);
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const sigPast = signWeleticShopifyRequest({
        timestamp: boundaryPast,
        method: "GET",
        path,
        body,
        secret: TEST_SECRET,
      });

      const reqPast = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: boundaryPast,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: sigPast,
        },
      });

      expect(verifyWeleticShopifyRequest({ request: reqPast, body, now })).toBe(
        true,
      );
    });

    it("TIME-4: rejects non-numeric or unsafe integer timestamp strings (NaN, Infinity, floats, strings)", () => {
      const now = 1724000000000;
      const path =
        "/api/internal/shopify/loyalty/customer?shop=tenant-a.myshopify.com";
      const body = "";

      const badTimestamps = [
        "not_a_number",
        "1724000000.55", // float
        "Infinity",
        "-Infinity",
        "NaN",
        "9007199254740992", // > MAX_SAFE_INTEGER
        "",
        "null",
      ];

      for (const badTs of badTimestamps) {
        const sig = signWeleticShopifyRequest({
          timestamp: badTs,
          method: "GET",
          path,
          body,
          secret: TEST_SECRET,
        });

        const req = new Request(`https://app.weletic.com${path}`, {
          method: "GET",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: badTs,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: sig,
          },
        });

        expect(verifyWeleticShopifyRequest({ request: req, body, now })).toBe(
          false,
        );
      }
    });
  });

  // =========================================================================
  // 5. OVERSIZE PAYLOAD & STREAM EXHAUSTION ATTACKS
  // =========================================================================
  describe("5. Oversize Payload & Denial-of-Service Defense", () => {
    it("DOS-1: immediately rejects declared Content-Length > 256KiB without reading body", async () => {
      const oversizedBytes = WELETIC_SHOPIFY_MAX_BODY_BYTES + 1; // 262,145
      const req = new Request("https://app.weletic.com/internal", {
        method: "POST",
        headers: {
          "content-length": String(oversizedBytes),
        },
        body: "x".repeat(100),
      });

      const body = await readWeleticShopifyRequestBody(req);
      expect(body).toBeNull();
    });

    it("DOS-2: aborts stream and returns null when chunked stream exceeds 256KiB limit", async () => {
      const stream = new ReadableStream({
        start(controller) {
          const chunk = new Uint8Array(64 * 1024); // 64KiB chunks
          chunk.fill(120); // 'x'
          controller.enqueue(chunk); // 64KiB
          controller.enqueue(chunk); // 128KiB
          controller.enqueue(chunk); // 192KiB
          controller.enqueue(chunk); // 256KiB
          controller.enqueue(chunk); // 320KiB (exceeds limit!)
          controller.close();
        },
      });

      const req = new Request("https://app.weletic.com/internal", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as any);

      const body = await readWeleticShopifyRequestBody(req);
      expect(body).toBeNull();
    });

    it("DOS-3: rejects negative, float, or invalid Content-Length headers", async () => {
      const badHeaders = ["-1", "100.5", "invalid", "Infinity", "NaN"];

      for (const badHeader of badHeaders) {
        const req = new Request("https://app.weletic.com/internal", {
          method: "POST",
          headers: { "content-length": badHeader },
          body: "{}",
        });

        const body = await readWeleticShopifyRequestBody(req);
        expect(body).toBeNull();
      }
    });

    it("DOS-4: internal redeem endpoint returns 401 when payload body is oversized", async () => {
      const oversizedBytes = WELETIC_SHOPIFY_MAX_BODY_BYTES + 500;
      const req = new Request(
        "https://app.weletic.com/api/internal/shopify/loyalty/customer/redeem",
        {
          method: "POST",
          headers: {
            "content-length": String(oversizedBytes),
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(Date.now()),
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "a".repeat(64),
          },
          body: "x".repeat(100),
        },
      );

      const res = await internalPostRedeem(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("unauthorized");
    });

    it("DOS-5: rejects a signed redemption request without an idempotency key", async () => {
      const timestamp = String(Date.now());
      const path = "/api/internal/shopify/loyalty/customer/redeem";
      const body = JSON.stringify({
        shop: "tenant-a.myshopify.com",
        shopifyCustomerId: "cust_123",
        rewardDefinitionId: "reward_10",
      });
      const signature = signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        secret: TEST_SECRET,
      });
      const req = new Request(`https://app.weletic.com${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        },
        body,
      });

      const res = await internalPostRedeem(req);

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error.code).toBe("validation_failed");
      expect(data.error.details.idempotencyKey?._errors).toBeDefined();
    });

    it("DOS-6: rejects JSON-number points before unsafe integer coercion", async () => {
      const timestamp = String(Date.now());
      const path = "/api/internal/shopify/loyalty/customer/redeem";
      const body =
        '{"shop":"tenant-a.myshopify.com","shopifyCustomerId":"cust_123","rewardDefinitionId":"reward_10","pointsRequested":9007199254740993,"idempotencyKey":"intent-unsafe-number"}';
      const signature = signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        secret: TEST_SECRET,
      });
      const req = new Request(`https://app.weletic.com${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        },
        body,
      });

      const res = await internalPostRedeem(req);

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error.code).toBe("validation_failed");
      expect(data.error.details.pointsRequested?._errors).toBeDefined();
    });

    it("DOS-7: accepts legacy safe-number points and preserves exact string selections", () => {
      expect(customerRedemptionPointsRequestedSchema.parse(500)).toBe("500");
      expect(
        customerRedemptionPointsRequestedSchema.parse("9007199254740993"),
      ).toBe("9007199254740993");

      for (const invalid of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        "0",
        "01",
        "500.0",
      ]) {
        expect(
          customerRedemptionPointsRequestedSchema.safeParse(invalid).success,
        ).toBe(false);
      }
    });
  });

  // =========================================================================
  // 6. MULTI-DOMAIN RESOLUTION & ROUTING
  // =========================================================================
  describe("6. Multi-Domain Canonical Resolution & Zero-Hardcoding", () => {
    it("DOMAIN-1: returns 404 cleanly when shop domain is unknown or unregistered", async () => {
      const now = Date.now();
      const path =
        "/api/internal/shopify/loyalty/customer?shop=unregistered-attacker.myshopify.com";
      const body = "";

      const sig = signWeleticShopifyRequest({
        timestamp: String(now),
        method: "GET",
        path,
        body,
        secret: TEST_SECRET,
      });

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(now),
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: sig,
        },
      });

      const res = await internalGetCustomer(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("store_not_found");
    });

    it("DOMAIN-2: resolves aliases (e.g. yamaxdev.myshopify.com) dynamically to workspaceId", async () => {
      const now = Date.now();
      const path =
        "/api/internal/shopify/loyalty/customer?shop=yamaxdev.myshopify.com";
      const body = "";

      const sig = signWeleticShopifyRequest({
        timestamp: String(now),
        method: "GET",
        path,
        body,
        secret: TEST_SECRET,
      });

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(now),
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: sig,
        },
      });

      const res = await internalGetCustomer(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.storeId).toBe("store_tenant_a");
      expect(data.data.isEnrolled).toBe(false);
    });
  });
});
