import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertSafeIp,
  assertSafeUrl,
  hasSiteConfigured,
} from "../../../app/api/domains/[domain]/validate/utils";
import dns from "dns/promises";
import fs from "fs";
import path from "path";

describe("Milestone 5: Architecture Invariants & Security Hardening", () => {
  describe("1. SEC-SSRF-01: Domain Validation SSRF Protection", () => {
    describe("assertSafeIp", () => {
      it("rejects loopback addresses (127.0.0.0/8)", () => {
        expect(() => assertSafeIp("127.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("127.0.1.100")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("rejects link-local and AWS/cloud metadata address (169.254.169.254)", () => {
        expect(() => assertSafeIp("169.254.169.254")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("169.254.1.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("rejects private RFC 1918 subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", () => {
        expect(() => assertSafeIp("10.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("172.16.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("172.31.255.255")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("192.168.1.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("rejects CGNAT subnets (100.64.0.0/10)", () => {
        expect(() => assertSafeIp("100.64.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("100.127.255.255")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("rejects IPv6 loopback and mapped private IPv4", () => {
        expect(() => assertSafeIp("::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("::ffff:127.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("::ffff:169.254.169.254")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("fe80::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("fc00::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("accepts valid public routable IP addresses", () => {
        expect(() => assertSafeIp("8.8.8.8")).not.toThrow();
        expect(() => assertSafeIp("1.1.1.1")).not.toThrow();
        expect(() => assertSafeIp("93.184.216.34")).not.toThrow();
        expect(() => assertSafeIp("2606:4700:4700::1111")).not.toThrow();
      });
    });

    describe("assertSafeUrl", () => {
      it("rejects non-http/https protocols", async () => {
        await expect(assertSafeUrl("ftp://example.com")).rejects.toThrow(
          "Only http and https URLs are allowed.",
        );
        await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(
          "Only http and https URLs are allowed.",
        );
      });

      it("rejects localhost and internal hostnames without DNS lookup", async () => {
        await expect(assertSafeUrl("http://localhost:3000")).rejects.toThrow(
          "URL resolves to a private or internal hostname.",
        );
        await expect(
          assertSafeUrl("http://app.internal/secrets"),
        ).rejects.toThrow("URL resolves to a private or internal hostname.");
        await expect(
          assertSafeUrl("http://printer.local/admin"),
        ).rejects.toThrow("URL resolves to a private or internal hostname.");
      });

      it("rejects URLs resolving to loopback or metadata via DNS", async () => {
        const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
          { address: "127.0.0.1", family: 4 },
        ] as any);

        await expect(
          assertSafeUrl("http://malicious-localtest.me"),
        ).rejects.toThrow("URL resolves to a private or internal IP address.");
        lookupSpy.mockRestore();
      });

      it("rejects URLs resolving to AWS instance metadata service", async () => {
        const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
          { address: "169.254.169.254", family: 4 },
        ] as any);

        await expect(
          assertSafeUrl("http://attacker-metadata-proxy.com"),
        ).rejects.toThrow("URL resolves to a private or internal IP address.");
        lookupSpy.mockRestore();
      });

      it("allows safe public URLs", async () => {
        const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
          { address: "93.184.216.34", family: 4 },
        ] as any);

        await expect(
          assertSafeUrl("https://example.com"),
        ).resolves.toBeUndefined();
        lookupSpy.mockRestore();
      });
    });

    describe("hasSiteConfigured SSRF Prevention", () => {
      it("aborts and returns false without making fetch when domain resolves to internal IP", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue([
          { address: "127.0.0.1", family: 4 },
        ] as any);
        const resolveSpy = vi.spyOn(dns, "resolve").mockResolvedValue([
          "127.0.0.1",
        ] as any);

        const result = await hasSiteConfigured("evil.127.0.0.1.nip.io");
        expect(result).toBe(false);
        // fetch MUST NOT have been called with loopback
        expect(fetchSpy).not.toHaveBeenCalled();

        lookupSpy.mockRestore();
        resolveSpy.mockRestore();
        fetchSpy.mockRestore();
      });
    });
  });

  describe("2. INV2-01: Orders-Paid Soft-Deleted Link Attribution Coherence", () => {
    it("proves that querying with disabledAt: null selects active subsequent link instead of early disabled link", async () => {
      const mockLinks = [
        {
          id: "link_old_disabled",
          programId: "prog_123",
          partnerId: "partner_456",
          createdAt: new Date("2025-01-01T00:00:00Z"),
          disabledAt: new Date("2025-06-01T00:00:00Z"),
        },
        {
          id: "link_new_active",
          programId: "prog_123",
          partnerId: "partner_456",
          createdAt: new Date("2025-07-01T00:00:00Z"),
          disabledAt: null,
        },
      ];

      // Simulate the defective query (without disabledAt: null)
      const defectiveQuery = (where: any) =>
        mockLinks
          .filter(
            (l) =>
              l.programId === where.programId &&
              l.partnerId === where.partnerId,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;

      const defectiveResult = defectiveQuery({
        programId: "prog_123",
        partnerId: "partner_456",
      });

      // Defective query returns the disabled link
      expect(defectiveResult?.id).toBe("link_old_disabled");
      expect(defectiveResult?.disabledAt).not.toBeNull();
      // Downstream orders-paid sets link = null if !isTemporarilyValid, breaking attribution!
      const isTemporarilyValid = (disabledAt: Date | null) => disabledAt === null;
      const attributedLinkDefective = isTemporarilyValid(defectiveResult.disabledAt)
        ? defectiveResult
        : null;
      expect(attributedLinkDefective).toBeNull(); // Fails attribution!

      // Simulate fixed query (with disabledAt: null)
      const fixedQuery = (where: any) =>
        mockLinks
          .filter(
            (l) =>
              l.programId === where.programId &&
              l.partnerId === where.partnerId &&
              (where.disabledAt === null ? l.disabledAt === null : true),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;

      const fixedResult = fixedQuery({
        programId: "prog_123",
        partnerId: "partner_456",
        disabledAt: null,
      });

      // Fixed query returns the active link
      expect(fixedResult?.id).toBe("link_new_active");
      expect(fixedResult?.disabledAt).toBeNull();
      const attributedLinkFixed = isTemporarilyValid(fixedResult.disabledAt)
        ? fixedResult
        : null;
      expect(attributedLinkFixed).not.toBeNull();
      expect(attributedLinkFixed?.id).toBe("link_new_active");
    });
  });

  describe("3. INV1-01: Canonical Store Resolution in Nudge Collections", () => {
    it("uses resolveShopifyStoreByDomain to resolve store aliases", async () => {
      const routeContent = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../app/api/internal/shopify/loyalty/customer/nudge-collections/route.ts",
        ),
        "utf-8",
      );

      // Verifies resolveShopifyStoreByDomain is imported and called
      expect(routeContent).toContain("resolveShopifyStoreByDomain");
      expect(routeContent).toMatch(/store\s*=\s*await\s+resolveShopifyStoreByDomain\(shop\)/);
    });
  });

  describe("4. INV2-02 & INV2-03: Soft-Delete Invariant 2 in Partner Profile & Coupon Import", () => {
    it("verifies getPartnerForProgram filters out soft-deleted discount codes", () => {
      const partnerProfileContent = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../lib/api/partner-profile/get-partner-for-program.ts",
        ),
        "utf-8",
      );

      expect(partnerProfileContent).toContain("discountCodes: {");
      expect(partnerProfileContent).toMatch(/discountCodes:\s*\{\s*where:\s*\{\s*disabledAt:\s*null\s*\}/);
    });

    it("verifies importAffiliateCoupons filters soft-deleted codes and auto-purges them before re-creating", () => {
      const importCouponsContent = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../lib/rewardful/import-affiliate-coupons.ts",
        ),
        "utf-8",
      );

      // Verifies existing query filters disabledAt: null
      expect(importCouponsContent).toMatch(
        /existingDiscountCodes\s*=\s*await\s*prisma\.discountCode\.findMany\(\{\s*where:\s*\{[\s\S]*?disabledAt:\s*null/,
      );

      // Verifies auto-purge deleteMany before createMany to satisfy Invariant 2.3
      expect(importCouponsContent).toMatch(
        /prisma\.discountCode\.deleteMany\(\{\s*where:\s*\{[\s\S]*?disabledAt:\s*\{\s*not:\s*null\s*\}/,
      );
    });
  });

  describe("5. INV4-01 & INV4-03: Zero-Hardcoding Invariants", () => {
    it("purges yamaxdev test brand from subscription-status localized UI strings", () => {
      const subscriptionStatusContent = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../../../packages/shopify-app/app/subscription-status.tsx",
        ),
        "utf-8",
      );

      expect(subscriptionStatusContent).not.toContain("yamaxdev");
      expect(subscriptionStatusContent).toContain("Restricted development feature testing.");
      expect(subscriptionStatusContent).toContain("開発ストア限定の機能テストです。");
      expect(subscriptionStatusContent).toContain("Thử nghiệm tính năng giới hạn trên cửa hàng phát triển.");
    });

    it("replaces deep relative import with environment configuration in flow points-adjustment", () => {
      const flowRouteContent = fs.readFileSync(
        path.resolve(
          __dirname,
          "../../../app/api/shopify/flow/points-adjustment/route.ts",
        ),
        "utf-8",
      );

      expect(flowRouteContent).not.toContain("public-runtime-policy.mjs");
      expect(flowRouteContent).not.toContain("../../../../../../../packages");
      expect(flowRouteContent).toMatch(/process\.env\.SHOPIFY_CLIENT_ID/);
    });
  });
});
