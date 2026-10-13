import { linkCache } from "@/lib/api/links/cache";
import {
  evictLinkFromKv,
  evictLinksBatchFromKv,
} from "@/lib/weletic/link-kv-cache";
import { SHOPIFY_FLOW_TRIGGER_HANDLES } from "@/lib/weletic/loyalty/flow-triggers";
import { FlowTriggerPayloadSchema } from "@/lib/weletic/loyalty/outbox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTargetUrl } from "../../workers/link-redirector/src/index";

// Mock link-kv-cache
vi.mock("@/lib/weletic/link-kv-cache", () => ({
  evictLinkFromKv: vi.fn(async () => true),
  evictLinksBatchFromKv: vi.fn(async () => ({ evictedCount: 1 })),
  buildKvKey: vi.fn((domain, key) => `link:${domain}:${key}`),
}));

// Mock upstash & next/cache
vi.mock("@/lib/upstash", () => ({
  redisGlobal: {
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
    pipeline: vi.fn(() => ({
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn(async () => []),
    })),
  },
  redisGlobalWithTimeout: {
    get: vi.fn(async () => null),
  },
  formatRedisLink: vi.fn((link) => link),
}));

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  getCache: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
  waitUntil: vi.fn((promise) => promise),
}));

describe("Round 2 Pre-Production Deep Audit Remediation Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. LINK-02: resolveTargetUrl Locale Sanitization & Safe URL Handling
  // =========================================================================
  describe("LINK-02 / REDIR-01: resolveTargetUrl Robustness", () => {
    it("handles URL with existing locale prefix without nested path corruption for JP", () => {
      const url = "https://yamax.com/en-us/products/flow-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toBe(
        "https://yamax.com/ja/products/flow-leggings?currency=JPY",
      );
      expect(resolved).not.toContain("/ja/en-us/");
    });

    it("handles URL with existing ja locale prefix without doubling for JP", () => {
      const url = "https://yamax.com/ja/products/flow-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toBe(
        "https://yamax.com/ja/products/flow-leggings?currency=JPY",
      );
      expect(resolved).not.toContain("/ja/ja/");
    });

    it("handles URL with existing locale prefix for VN", () => {
      const url = "https://yamax.com/ja-jp/products/flow-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "VN",
      });

      expect(resolved).toBe(
        "https://yamax.com/vi/products/flow-leggings?currency=VND",
      );
      expect(resolved).not.toContain("/vi/ja-jp/");
    });

    it("safely handles malformed / protocol-relative URL without throwing 500", () => {
      const url = "yamax.com/products/flow-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toContain("yamax.com");
      expect(resolved).toContain("currency=JPY");
    });
  });

  // =========================================================================
  // 2. LINK-01: Link KV Cache Eviction on Updates and Batch Operations
  // =========================================================================
  describe("LINK-01 / SYNC-07: Link KV Cache Invalidation", () => {
    it("evicts KV cache on linkCache.set even when link is active (disabledAt is null)", async () => {
      const activeLink = {
        id: "link_123",
        domain: "go.yamax.com",
        key: "summer2026",
        url: "https://yamax.com/products/updated-leggings",
        disabledAt: null,
      } as any;

      await linkCache.set(activeLink);

      expect(evictLinkFromKv).toHaveBeenCalledWith({
        domain: "go.yamax.com",
        key: "summer2026",
      });
    });

    it("batch evicts KV cache on linkCache.mset", async () => {
      const links = [
        {
          id: "l1",
          domain: "go.yamax.com",
          key: "k1",
          url: "https://yamax.com/1",
          disabledAt: null,
        },
        {
          id: "l2",
          domain: "go.yamax.com",
          key: "k2",
          url: "https://yamax.com/2",
          disabledAt: null,
        },
      ] as any[];

      await linkCache.mset(links);

      expect(evictLinksBatchFromKv).toHaveBeenCalledWith([
        { domain: "go.yamax.com", key: "k1" },
        { domain: "go.yamax.com", key: "k2" },
      ]);
    });
  });

  // =========================================================================
  // 3. FIN-12: FlowTriggerPayloadSchema Compliance on Points Expiry
  // =========================================================================
  describe("FIN-12 / LOY-01: Points Expiry Flow Trigger Payload Schema", () => {
    it("validates POINTS_EXPIRING_SOON payload matching scheduler output", () => {
      const payload = {
        accountId: "acc_test_123",
        handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON,
        pointsExpiring: "150",
        expiryDate: new Date("2026-11-01T00:00:00.000Z").toISOString(),
        urgency: "warning",
        policyVersion: 2,
      };

      const parsed = FlowTriggerPayloadSchema.parse(payload);
      expect(parsed.handle).toBe("weletic-points-expiring-soon");
      if ("pointsExpiring" in parsed) {
        expect(parsed.pointsExpiring).toBe("150");
        expect(parsed.urgency).toBe("warning");
      }
    });

    it("rejects payload with urgency other than warning or last_chance", () => {
      const invalidPayload = {
        accountId: "acc_test_123",
        handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON,
        pointsExpiring: "150",
        expiryDate: new Date("2026-11-01T00:00:00.000Z").toISOString(),
        urgency: "expire", // Invalid urgency
      };

      expect(() => FlowTriggerPayloadSchema.parse(invalidPayload)).toThrow();
    });

    it("rejects pointsExpiring with '0' as non-positive", () => {
      const zeroPayload = {
        accountId: "acc_test_123",
        handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON,
        pointsExpiring: "0",
        expiryDate: new Date("2026-11-01T00:00:00.000Z").toISOString(),
        urgency: "warning",
      };

      expect(() => FlowTriggerPayloadSchema.parse(zeroPayload)).toThrow();
    });
  });
});
