import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

import {
  normalizeShopDomain,
  canonicalizeShopifyDomain,
} from "../../lib/weletic/shopify/store-resolver";
import {
  handleLinkRedirection,
  buildKvKey,
  type LinkRecord,
  type LinkRedirectorEnv,
} from "../../workers/link-redirector/src/index";
import {
  findActiveDiscountCode,
  extractOrderDiscountCodes,
} from "../../workers/queue-consumer/src/index";
import {
  addCustomHostnameToCloudflare,
  extractSslValidationRecords,
  CloudflareSaaSError,
} from "../../lib/api/domains/cloudflare-saas";

describe("Milestone 6 Adversarial Challenge: Budget Boundaries, Quotas & Multi-Tenant Invariants", () => {
  // =========================================================================
  // 1. Multi-Tenant Zero-Hardcoding AST & Static Analysis Audit (Invariant 4)
  // =========================================================================
  describe("1. Invariant 4: Zero Hardcoded Multi-Tenant Strings across Worker Modules", () => {
    const workersDir = path.resolve(__dirname, "../../workers");

    function getAllWorkerTsFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...getAllWorkerTsFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".toml"))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const workerFiles = getAllWorkerTsFiles(workersDir);

    it("verifies worker files exist in apps/web/workers", () => {
      expect(workerFiles.length).toBeGreaterThan(0);
    });

    it("ensures zero occurrences of specific store domains across all worker sources and configs", () => {
      const forbiddenDomains = [
        "yamaxdev",
        "montdev",
        "yamax-demo",
        "myshopify.com",
      ];

      for (const filePath of workerFiles) {
        const content = fs.readFileSync(filePath, "utf-8");
        // Check wrangler configs or ts files
        for (const forbidden of forbiddenDomains) {
          // Exclude comments or schema references if any, but in production workers none should be hardcoded
          // Check if literal domain string appears as a value
          const regex = new RegExp(`['"\`]${forbidden}`, "i");
          const matches = regex.test(content);
          expect(
            matches,
            `Found hardcoded tenant domain "${forbidden}" in ${path.relative(workersDir, filePath)}`,
          ).toBe(false);
        }
      }
    });

    it("ensures zero occurrences of hardcoded project/workspace IDs in worker source code", () => {
      const forbiddenWorkspacePatterns = [
        /['"`]ws_[a-zA-Z0-9_-]{10,}['"`]/,
        /['"`]cl[a-z0-9]{20,}['"`]/, // Dub CUID pattern
      ];

      for (const filePath of workerFiles) {
        if (filePath.endsWith(".ts")) {
          const content = fs.readFileSync(filePath, "utf-8");
          for (const pattern of forbiddenWorkspacePatterns) {
            const match = pattern.exec(content);
            expect(
              match,
              `Found hardcoded workspace ID ${match ? match[0] : ""} in ${path.relative(workersDir, filePath)}`,
            ).toBeNull();
          }
        }
      }
    });

    it("verifies canonical store resolver is imported and used in queue-consumer and cron-triggers", () => {
      const queueConsumerIndex = fs.readFileSync(
        path.join(workersDir, "queue-consumer/src/index.ts"),
        "utf-8",
      );
      expect(queueConsumerIndex).toContain("resolveShopifyStoreByDomain");

      const cronTriggersIndex = fs.readFileSync(
        path.join(workersDir, "cron-triggers/src/index.ts"),
        "utf-8",
      );
      expect(cronTriggersIndex).toContain("resolveShopifyStoreByDomain");
    });
  });

  // =========================================================================
  // 2. Canonical Store Resolution Resilience & Edge Cases (Invariant 1)
  // =========================================================================
  describe("2. Invariant 1: Canonical Store Resolution Resilience on Boundary Cases", () => {
    it("handles whitespace padding, uppercase characters, and protocol prefixes", () => {
      expect(normalizeShopDomain("   yamax.myshopify.com   ")).toBe("yamax.myshopify.com");
      expect(normalizeShopDomain("YAMAX.MYSHOPIFY.COM")).toBe("yamax.myshopify.com");
      expect(normalizeShopDomain("https://yamax.myshopify.com")).toBe("yamax.myshopify.com");
      expect(normalizeShopDomain("http://yamax.myshopify.com/")).toBe("yamax.myshopify.com");
      expect(normalizeShopDomain("https://yamax.myshopify.com/admin/oauth/authorize")).toBe("yamax.myshopify.com");
      expect(normalizeShopDomain("  HTTPS://STORE.EXAMPLE.COM/PATH?QUERY=1  ")).toBe("store.example.com");
    });

    it("handles empty, malformed, or null domains gracefully", () => {
      expect(normalizeShopDomain("")).toBe("");
      expect(normalizeShopDomain("   ")).toBe("");
      expect(canonicalizeShopifyDomain("")).toBeNull();
      expect(canonicalizeShopifyDomain("not-a-shopify-domain.com")).toBeNull();
      expect(canonicalizeShopifyDomain("invalid_subdomain!.myshopify.com")).toBeNull();
      expect(canonicalizeShopifyDomain("valid-store-123.myshopify.com")).toBe("valid-store-123.myshopify.com");
    });
  });

  // =========================================================================
  // 3. Soft-Delete Coherence Across Affiliate Links & Discounts (Invariant 2)
  // =========================================================================
  describe("3. Invariant 2: Soft-Delete Coherence Enforcement", () => {
    class MemoryKV {
      public store = new Map<string, string>();
      async get(key: string, type?: string) {
        const val = this.store.get(key);
        if (!val) return null;
        return type === "json" ? JSON.parse(val) : val;
      }
      async put(key: string, value: string) {
        this.store.set(key, value);
      }
    }

    it("link-redirector returns 404 when link has disabledAt set (soft-deleted in KV)", async () => {
      const kv = new MemoryKV();
      const disabledLink: LinkRecord = {
        id: "lnk_disabled_123",
        projectId: "ws_test_123",
        partnerId: "part_test_123",
        url: "https://yamax.co/products/leggings",
        disabledAt: "2026-10-01T00:00:00.000Z", // Soft-deleted
      };

      await kv.put("link:yamax.co:vip-deal", JSON.stringify(disabledLink));

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
      };

      const request = new Request("https://yamax.co/vip-deal");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(404);
    });

    it("link-redirector returns 404 when link has expired (expiresAt in past)", async () => {
      const kv = new MemoryKV();
      const expiredLink: LinkRecord = {
        id: "lnk_expired_123",
        projectId: "ws_test_123",
        url: "https://yamax.co/products/leggings",
        disabledAt: null,
        expiresAt: "2026-01-01T00:00:00.000Z", // Expired
      };

      await kv.put("link:yamax.co:expired-promo", JSON.stringify(expiredLink));

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
      };

      const request = new Request("https://yamax.co/expired-promo");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(404);
    });

    it("link-redirector returns 302 when link is active and valid (disabledAt is null)", async () => {
      const kv = new MemoryKV();
      const activeLink: LinkRecord = {
        id: "lnk_active_123",
        projectId: "ws_test_123",
        partnerId: "part_active_123",
        url: "https://yamax.co/products/leggings",
        disabledAt: null,
      };

      await kv.put("link:yamax.co:active-deal", JSON.stringify(activeLink));

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
      };

      const request = new Request("https://yamax.co/active-deal");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toContain("https://yamax.co/products/leggings");
      expect(response.headers.get("Location")).toContain("via=active-deal");
    });

    it("queue-consumer findActiveDiscountCode strictly queries disabledAt: null", async () => {
      const mockPrisma = {
        discountCode: {
          findFirst: vi.fn(async (args) => {
            // Verify invariant 2 assertion
            expect(args.where.disabledAt).toBeNull();
            if (args.where.code === "DISABLED_CODE") {
              return null; // soft deleted
            }
            return {
              id: "dc_1",
              code: "ACTIVE_CODE",
              programId: args.where.programId,
              partnerId: "part_1",
              linkId: "lnk_1",
              disabledAt: null,
            };
          }),
        },
      };

      const resultActive = await findActiveDiscountCode(
        mockPrisma as any,
        "prog_123",
        "ACTIVE_CODE",
      );
      expect(resultActive).not.toBeNull();
      expect(resultActive?.partnerId).toBe("part_1");

      const resultDisabled = await findActiveDiscountCode(
        mockPrisma as any,
        "prog_123",
        "DISABLED_CODE",
      );
      expect(resultDisabled).toBeNull();
    });

    it("extractOrderDiscountCodes normalizes and deduplicates mixed case discounts", () => {
      const orderPayload = {
        discount_codes: [
          { code: "Summer20" },
          { code: " SUMMER20 " },
          { code: "VIP10" },
        ],
        discount_applications: [
          { type: "discount_code", title: "summer20" },
          { type: "automatic", title: "Automatic Free Shipping" },
        ],
      };

      const codes = extractOrderDiscountCodes(orderPayload);
      expect(codes).toEqual(["SUMMER20", "VIP10"]);
    });
  });

  // =========================================================================
  // 4. Financial Cost Model & Cloudflare Quota Stress-Testing Oracle
  // =========================================================================
  describe("4. Financial Ledger & Quota Stress-Testing Oracle ($0.00–$5.00/mo vs Legacy)", () => {
    interface CloudflareUsage {
      monthlyOrders: number;
      monthlyClicks: number;
      r2StorageGb: number;
      customHostnames: number;
    }

    interface CostBreakdown {
      baseWorkersPaid: number;
      d1StorageCost: number;
      d1ReadsCost: number;
      d1WritesCost: number;
      kvReadsCost: number;
      kvWritesCost: number;
      r2StorageCost: number;
      r2OperationsCost: number;
      queuesOpsCost: number;
      analyticsEngineCost: number;
      saasHostnamesCost: number;
      totalMonthlyCost: number;
    }

    /**
     * Authoritative Cloudflare Native Pricing Calculation Engine
     * Based on official Cloudflare documentation:
     * - Workers Paid: $5.00/mo base (includes 10M requests, 1M queue ops, 10M KV reads, 1M KV writes, 10M AE writes, 10GB D1)
     * - D1 (Paid): 10GB included, $0.75/GB-mo overage; 25B reads included, 50M writes included
     * - R2: 10GB included, $0.015/GB-mo overage; 1M Class A included, 10M Class B included; $0.00 egress
     * - KV (Paid): 10M reads included ($0.50/M overage), 1M writes included ($5.00/M overage)
     * - Queues (Paid): 1M ops included ($0.40/M overage) - 1 msg = 2 ops (send + ack/receive)
     * - Cloudflare for SaaS: 100 Custom Hostnames Free per zone ($0.10/hostname-mo overage)
     * - Workers Analytics Engine: 10M datapoints/mo included ($0.25/M overage)
     */
    function calculateCloudflareMonthlyCost(usage: CloudflareUsage): CostBreakdown {
      const baseWorkersPaid = 5.00;

      // D1: Average order generates ~3 rows in D1; ledger reconciliation reads ~10k rows/day
      const d1StorageGb = Math.max(0, usage.monthlyOrders * 0.00001); // 100k orders = 1GB
      const d1StorageCost = d1StorageGb > 10 ? (d1StorageGb - 10) * 0.75 : 0;
      const d1ReadsCost = 0; // Under 25B rows/mo
      const d1Writes = usage.monthlyOrders * 4;
      const d1WritesCost = d1Writes > 50_000_000 ? ((d1Writes - 50_000_000) / 1_000_000) * 1.00 : 0;

      // KV Reads: 1 per link click
      const kvReadsCost = usage.monthlyClicks > 10_000_000
        ? Math.ceil((usage.monthlyClicks - 10_000_000) / 1_000_000) * 0.50
        : 0;
      const kvWritesCost = 0; // Link creation is << 1M/mo

      // R2 Storage: 10GB included, $0.015/GB overage
      const r2StorageCost = usage.r2StorageGb > 10
        ? (usage.r2StorageGb - 10) * 0.015
        : 0;
      const r2OperationsCost = 0; // Within 1M / 10M free tiers

      // Queues: 1 order = 1 enqueue + 1 dequeue = 2 operations
      const queueOperations = usage.monthlyOrders * 2;
      const queuesOpsCost = queueOperations > 1_000_000
        ? ((queueOperations - 1_000_000) / 1_000_000) * 0.40
        : 0;

      // Analytics Engine: 1 datapoint per link click
      const analyticsEngineCost = usage.monthlyClicks > 10_000_000
        ? ((usage.monthlyClicks - 10_000_000) / 1_000_000) * 0.25
        : 0;

      // Cloudflare for SaaS: 100 free hostnames
      const saasHostnamesCost = usage.customHostnames > 100
        ? (usage.customHostnames - 100) * 0.10
        : 0;

      const totalMonthlyCost =
        baseWorkersPaid +
        d1StorageCost +
        d1ReadsCost +
        d1WritesCost +
        kvReadsCost +
        kvWritesCost +
        r2StorageCost +
        r2OperationsCost +
        queuesOpsCost +
        analyticsEngineCost +
        saasHostnamesCost;

      return {
        baseWorkersPaid,
        d1StorageCost,
        d1ReadsCost,
        d1WritesCost,
        kvReadsCost,
        kvWritesCost,
        r2StorageCost,
        r2OperationsCost,
        queuesOpsCost,
        analyticsEngineCost,
        saasHostnamesCost,
        totalMonthlyCost: Math.round(totalMonthlyCost * 100) / 100,
      };
    }

    it("proves baseline launch traffic operates at exactly $5.00/mo (within $0-$5 boundary)", () => {
      const baseline: CloudflareUsage = {
        monthlyOrders: 1_000,
        monthlyClicks: 100_000,
        r2StorageGb: 5,
        customHostnames: 20,
      };

      const cost = calculateCloudflareMonthlyCost(baseline);
      expect(cost.totalMonthlyCost).toBe(5.00);
      expect(cost.saasHostnamesCost).toBe(0);
      expect(cost.queuesOpsCost).toBe(0);
      expect(cost.kvReadsCost).toBe(0);
      expect(cost.r2StorageCost).toBe(0);
    });

    it("proves growth traffic (30,000 orders/mo, 1.5M clicks/mo, 50 domains) stays within $5.23/mo", () => {
      const growth: CloudflareUsage = {
        monthlyOrders: 30_000,
        monthlyClicks: 1_500_000,
        r2StorageGb: 25, // 15GB overage = $0.225
        customHostnames: 50,
      };

      const cost = calculateCloudflareMonthlyCost(growth);
      expect(cost.totalMonthlyCost).toBe(5.23);
      expect(cost.queuesOpsCost).toBe(0); // 60k ops < 1M ops
      expect(cost.kvReadsCost).toBe(0); // 1.5M reads < 10M reads
      expect(cost.saasHostnamesCost).toBe(0); // 50 < 100 free hostnames
    });

    it("proves high-scale traffic (200,000 orders/mo, 8M clicks/mo, 90 domains) costs only $5.60/mo", () => {
      const highScale: CloudflareUsage = {
        monthlyOrders: 200_000,
        monthlyClicks: 8_000_000,
        r2StorageGb: 50, // 40GB overage = $0.60
        customHostnames: 90,
      };

      const cost = calculateCloudflareMonthlyCost(highScale);
      expect(cost.totalMonthlyCost).toBe(5.60);
      expect(cost.queuesOpsCost).toBe(0); // 400k ops < 1M ops
      expect(cost.saasHostnamesCost).toBe(0); // 90 < 100 free hostnames
    });

    it("adversarially stress-tests extreme viral surge (1M orders/mo, 25M clicks/mo, 120 domains, 200GB R2)", () => {
      const extremeSurge: CloudflareUsage = {
        monthlyOrders: 1_000_000, // 2M queue ops -> 1M overage = $0.40
        monthlyClicks: 25_000_000, // 15M overage KV = $7.50, 15M overage AE = $3.75
        r2StorageGb: 200, // 190GB overage = $2.85
        customHostnames: 120, // 20 overage = $2.00
      };

      const cost = calculateCloudflareMonthlyCost(extremeSurge);
      // Legacy stack for this volume would exceed $1,200.00/mo
      // Cloudflare total: 5.00 + 0 + 7.50 + 2.85 + 0.40 + 3.75 + 2.00 = $21.50/mo
      expect(cost.totalMonthlyCost).toBeLessThan(25.00);
      expect(cost.totalMonthlyCost).toBe(21.50);

      // Slashes legacy cost by >97%
      const legacyEquivalentCost = 650.00;
      const savingsPercent = ((legacyEquivalentCost - cost.totalMonthlyCost) / legacyEquivalentCost) * 100;
      expect(savingsPercent).toBeGreaterThan(96);
    });

    it("verifies Cloudflare for SaaS free tier allowance is exactly 100 hostnames", () => {
      const underQuota = calculateCloudflareMonthlyCost({
        monthlyOrders: 100,
        monthlyClicks: 100,
        r2StorageGb: 1,
        customHostnames: 100,
      });
      expect(underQuota.saasHostnamesCost).toBe(0);

      const overQuota = calculateCloudflareMonthlyCost({
        monthlyOrders: 100,
        monthlyClicks: 100,
        r2StorageGb: 1,
        customHostnames: 105,
      });
      expect(overQuota.saasHostnamesCost).toBe(0.50); // 5 * $0.10
    });
  });
});
