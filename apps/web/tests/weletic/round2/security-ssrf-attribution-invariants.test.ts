import dns from "dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Hoisted mocks for ordersPaid and validation
const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  settle: vi.fn(),
  process: vi.fn(),
  publish: vi.fn(),
  linkFindFirst: vi.fn(),
  customerFindUnique: vi.fn(),
  discountFindMany: vi.fn(),
  cacheRead: vi.fn(),
  cacheWrite: vi.fn(),
  cacheDelete: vi.fn(),
  guard: vi.fn(),
  attribute: vi.fn(),
  sale: vi.fn(),
  domainExists: vi.fn(),
  validateDubLinkSubdomain: vi.fn(),
}));

// Mock cron / QStash
vi.mock("@/lib/cron", () => ({
  qstash: { publishJSON: mocks.publish },
}));

// Mock Prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    link: { findFirst: mocks.linkFindFirst },
    customer: { findUnique: mocks.customerFindUnique },
    discountCode: { findMany: mocks.discountFindMany },
  },
}));

// Mock Weletic commerce & settlement
vi.mock("@/lib/weletic/commerce/record-order", () => ({
  recordWeleticOrder: mocks.record,
}));
vi.mock("@/lib/weletic/loyalty/redemption-settlement", () => ({
  settleRewardRedemptionsUsedByOrder: mocks.settle,
}));
vi.mock("@/lib/integrations/shopify/create-sale", () => ({
  createShopifySale: mocks.sale,
}));
vi.mock("@/lib/integrations/shopify/process-order", () => ({
  processOrder: mocks.process,
  attributeViaDiscountCode: mocks.attribute,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: async ({ fn }: any) => fn({}),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
  assertShopifyStoreMatchesInstallationGeneration: vi.fn(),
  isShopifyStoreOperationalWritesBlocked: () => false,
}));
vi.mock("@/lib/weletic/shopify/privacy-cache", () => ({
  readShopifyCheckoutCacheField: mocks.cacheRead,
  writeShopifyCheckoutCache: mocks.cacheWrite,
  deleteShopifyCheckoutCache: mocks.cacheDelete,
}));

// Mock auth session wrapper for domain validation route
vi.mock("@/lib/auth", () => ({
  withSession: (handler: any) => async (req: any, ctx: any) => {
    const params = await ctx?.params;
    return handler({
      req,
      params,
      session: { user: { id: "usr_test_security" } },
    });
  },
}));

// Mock domain utils
vi.mock("@/lib/api/domains/utils", () => ({
  domainExists: mocks.domainExists,
}));
vi.mock("@/lib/api/domains/validate-dub-link-subdomain", () => ({
  validateDubLinkSubdomain: mocks.validateDubLinkSubdomain,
}));

import { ordersPaid } from "../../../app/(ee)/api/shopify/integration/webhook/orders-paid";
import { GET as validateDomainRoute } from "../../../app/api/domains/[domain]/validate/route";
import {
  assertSafeIp,
  assertSafeUrl,
  hasSiteConfigured,
} from "../../../app/api/domains/[domain]/validate/utils";

const createOrderEvent = (overrides: Record<string, any> = {}) => ({
  id: 88776655,
  confirmation_number: "CN-SEC-01",
  checkout_token: "chk_sec_token_01",
  created_at: "2026-08-20T12:00:00Z",
  line_items: [],
  customer: {
    id: 998877,
    email: "shopper@secure-test.io",
    first_name: "Security",
    last_name: "Tester",
  },
  current_subtotal_price_set: {
    shop_money: { amount: "120.00", currency_code: "USD" },
  },
  discount_codes: [{ code: "PARTNER20" }],
  ...overrides,
});

describe("Round 2 Security Suite: SSRF Prevention & Orders-Paid Attribution Invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockResolvedValue({ id: "store_sec_01" });
    mocks.record.mockResolvedValue({
      orderId: "worder_sec_01",
      customerPrivacyTombstoned: false,
    });
    mocks.customerFindUnique.mockResolvedValue(null);
    mocks.cacheRead.mockResolvedValue("");
    mocks.attribute.mockResolvedValue({
      customer: { id: "cus_sec_01" },
      leadEvent: { event_id: "lead_sec_01" },
    });
    mocks.sale.mockResolvedValue({});
    mocks.domainExists.mockResolvedValue(false);
    mocks.validateDubLinkSubdomain.mockReturnValue(null);
  });

  // =========================================================================
  // Part 1: SSRF Protection on Domain Validation Route
  // =========================================================================
  describe("Part 1: SSRF Protection & Private IP Filtering (assertSafeIp & assertSafeUrl)", () => {
    describe("assertSafeIp boundary checks", () => {
      it("blocks loopback IPv4 addresses (127.0.0.0/8)", () => {
        expect(() => assertSafeIp("127.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("127.0.0.2")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("127.255.255.255")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("blocks cloud instance metadata endpoint and link-local addresses (169.254.0.0/16)", () => {
        expect(() => assertSafeIp("169.254.169.254")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("169.254.1.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("blocks RFC 1918 private IPv4 networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", () => {
        expect(() => assertSafeIp("10.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("10.255.255.255")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("172.16.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("172.31.255.255")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("192.168.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("192.168.1.100")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("blocks Carrier-Grade NAT (CGNAT 100.64.0.0/10)", () => {
        expect(() => assertSafeIp("100.64.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("100.127.255.255")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("blocks unspecified (0.0.0.0/8), multicast (224.0.0.0/4), and reserved (240.0.0.0/4)", () => {
        expect(() => assertSafeIp("0.0.0.0")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("224.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("240.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("blocks IPv6 loopback (::1, ::), unique-local (fc00::/7), and link-local (fe80::/10)", () => {
        expect(() => assertSafeIp("::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("::")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("fe80::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("fc00::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("fd00::1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("blocks IPv4-mapped IPv6 representations of internal addresses", () => {
        expect(() => assertSafeIp("::ffff:127.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("::ffff:169.254.169.254")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("::ffff:10.0.0.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
        expect(() => assertSafeIp("::ffff:192.168.1.1")).toThrow(
          "URL resolves to a private or internal IP address.",
        );
      });

      it("permits public routable IP addresses across IPv4 and IPv6", () => {
        expect(() => assertSafeIp("8.8.8.8")).not.toThrow();
        expect(() => assertSafeIp("1.1.1.1")).not.toThrow();
        expect(() => assertSafeIp("93.184.216.34")).not.toThrow();
        expect(() => assertSafeIp("2606:4700:4700::1111")).not.toThrow();
      });
    });

    describe("assertSafeUrl protocol and DNS safety", () => {
      it("rejects non-http/https protocols (e.g. ftp, file, gopher)", async () => {
        await expect(
          assertSafeUrl("ftp://files.example.com/data"),
        ).rejects.toThrow("Only http and https URLs are allowed.");
        await expect(assertSafeUrl("file:///etc/shadow")).rejects.toThrow(
          "Only http and https URLs are allowed.",
        );
      });

      it("rejects localhost and internal hostname suffixes without issuing DNS lookup", async () => {
        await expect(assertSafeUrl("http://localhost:8080")).rejects.toThrow(
          "URL resolves to a private or internal hostname.",
        );
        await expect(
          assertSafeUrl("http://metadata.aws.internal"),
        ).rejects.toThrow("URL resolves to a private or internal hostname.");
        await expect(assertSafeUrl("http://gateway.local")).rejects.toThrow(
          "URL resolves to a private or internal hostname.",
        );
      });

      it("blocks domain resolving to 169.254.169.254 via DNS lookup", async () => {
        const lookupSpy = vi
          .spyOn(dns, "lookup")
          .mockResolvedValueOnce([
            { address: "169.254.169.254", family: 4 },
          ] as any);

        await expect(
          assertSafeUrl("http://cloud-meta.attacker.net/credentials"),
        ).rejects.toThrow("URL resolves to a private or internal IP address.");
        lookupSpy.mockRestore();
      });

      it("allows safe public URL when DNS resolves to routable IP", async () => {
        const lookupSpy = vi
          .spyOn(dns, "lookup")
          .mockResolvedValueOnce([
            { address: "93.184.216.34", family: 4 },
          ] as any);

        await expect(
          assertSafeUrl("https://safe-brand.io"),
        ).resolves.toBeUndefined();
        lookupSpy.mockRestore();
      });
    });

    describe("hasSiteConfigured and GET /api/domains/[domain]/validate route", () => {
      it("hasSiteConfigured returns false without making fetch when domain resolves to 169.254.169.254", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const lookupSpy = vi
          .spyOn(dns, "lookup")
          .mockResolvedValue([
            { address: "169.254.169.254", family: 4 },
          ] as any);
        const resolveSpy = vi
          .spyOn(dns, "resolve")
          .mockResolvedValue(["169.254.169.254"] as any);

        const result = await hasSiteConfigured("meta-proxy.attacker.io");
        expect(result).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();

        lookupSpy.mockRestore();
        resolveSpy.mockRestore();
        fetchSpy.mockRestore();
      });

      it("hasSiteConfigured returns true when public domain returns HTTP 200", async () => {
        const lookupSpy = vi
          .spyOn(dns, "lookup")
          .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(new Response(null, { status: 200 }));

        const result = await hasSiteConfigured("active-shop.com");
        expect(result).toBe(true);

        lookupSpy.mockRestore();
        fetchSpy.mockRestore();
      });

      it("GET route returns { status: 'invalid' } for malformed domain", async () => {
        const request = new Request(
          "https://api.test/api/domains/not-a-domain..invalid/validate",
        );
        const response = await validateDomainRoute(request as any, {
          params: Promise.resolve({ domain: "not-a-domain..invalid" }),
        });

        const json = await response.json();
        expect(json.status).toBe("invalid");
      });

      it("GET route rejects domains starting with www.", async () => {
        const request = new Request(
          "https://api.test/api/domains/www.partner-shop.com/validate",
        );
        const response = await validateDomainRoute(request as any, {
          params: Promise.resolve({ domain: "www.partner-shop.com" }),
        });

        const json = await response.json();
        expect(json.status).toBe("invalid");
        expect(json.message).toContain("Custom domain cannot start with www.");
      });

      it("GET route returns { status: 'conflict' } when domain is already registered", async () => {
        mocks.domainExists.mockResolvedValueOnce(true);

        const request = new Request(
          "https://api.test/api/domains/existing-brand.io/validate",
        );
        const response = await validateDomainRoute(request as any, {
          params: Promise.resolve({ domain: "existing-brand.io" }),
        });

        const json = await response.json();
        expect(json.status).toBe("conflict");
      });

      it("GET route returns { status: 'available' } for safe unconfigured domain", async () => {
        const lookupSpy = vi
          .spyOn(dns, "lookup")
          .mockRejectedValue(new Error("ENOTFOUND"));
        const resolveSpy = vi
          .spyOn(dns, "resolve")
          .mockRejectedValue(new Error("ENOTFOUND"));

        const request = new Request(
          "https://api.test/api/domains/unconfigured-custom-domain.org/validate",
        );
        const response = await validateDomainRoute(request as any, {
          params: Promise.resolve({ domain: "unconfigured-custom-domain.org" }),
        });

        const json = await response.json();
        expect(json.status).toBe("available");

        lookupSpy.mockRestore();
        resolveSpy.mockRestore();
      });
    });
  });

  // =========================================================================
  // Part 2: Orders-Paid Commission Attribution with Disabled Link History
  // =========================================================================
  describe("Part 2: Orders-Paid Commission Attribution & Soft-Delete Coherence (INV2-01)", () => {
    const baseWorkspace = {
      id: "ws_sec_tenant_100",
      defaultProgramId: "prog_sec_tenant_100",
      webhookEnabled: false,
    };

    it("Case 1: Legitimate past order placed BEFORE link disabledAt (orderCreatedAt <= link.disabledAt) attributes correctly", async () => {
      const linkDisabledAt = new Date("2026-06-01T00:00:00Z");
      const orderCreatedAt = "2026-05-15T12:00:00Z"; // 16 days before link was disabled

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_valid_past",
          code: "PARTNER20",
          programId: baseWorkspace.defaultProgramId,
          partnerId: "partner_charlie",
          disabledAt: null, // Active discount code
          link: {
            id: "link_charlie_historical",
            programId: baseWorkspace.defaultProgramId,
            partnerId: "partner_charlie",
            disabledAt: linkDisabledAt, // Disabled in the future relative to the order
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PARTNER20" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace as any,
      });

      expect(result).toBe(
        "[Shopify] Order event processed successfully with discount codes.",
      );
      expect(mocks.attribute).toHaveBeenCalledWith({
        event,
        workspace: baseWorkspace,
        link: expect.objectContaining({
          id: "link_charlie_historical",
        }),
      });
      expect(mocks.sale).toHaveBeenCalledTimes(1);
    });

    it("Case 2: Order placed AFTER link disabledAt (orderCreatedAt > link.disabledAt) rejects attribution", async () => {
      const linkDisabledAt = new Date("2026-06-01T00:00:00Z");
      const orderCreatedAt = "2026-06-15T12:00:00Z"; // 14 days after link was disabled

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_with_disabled_link",
          code: "PARTNER20",
          programId: baseWorkspace.defaultProgramId,
          partnerId: "partner_charlie",
          disabledAt: null,
          link: {
            id: "link_charlie_expired",
            programId: baseWorkspace.defaultProgramId,
            partnerId: "partner_charlie",
            disabledAt: linkDisabledAt, // Link was already disabled when order happened!
          },
        },
      ]);

      // No other active links in DB
      mocks.linkFindFirst.mockResolvedValue(null);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PARTNER20" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace as any,
      });

      // Attribution skipped; factual order recorded
      expect(result).toBe(
        "[Shopify] Factual order recorded. Order is not from a Dub affiliate link.",
      );
      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
    });

    it("Case 3: Invariant 2 Coherence: Queries with disabledAt: null to select newer active link over older disabled link", async () => {
      const linkDisabledAt = new Date("2026-06-01T00:00:00Z");
      const orderCreatedAt = "2026-07-01T12:00:00Z"; // After older link was disabled

      // Directly attached link is disabled
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_reassigned",
          code: "PARTNER20",
          programId: baseWorkspace.defaultProgramId,
          partnerId: "partner_charlie",
          disabledAt: null,
          link: {
            id: "link_charlie_disabled_old",
            programId: baseWorkspace.defaultProgramId,
            partnerId: "partner_charlie",
            disabledAt: linkDisabledAt,
          },
        },
      ]);

      // Database returns the active subsequent link when queried with disabledAt: null
      const activeLink = {
        id: "link_charlie_new_active",
        programId: baseWorkspace.defaultProgramId,
        partnerId: "partner_charlie",
        disabledAt: null,
        createdAt: new Date("2026-06-15T00:00:00Z"),
      };
      mocks.linkFindFirst.mockResolvedValue(activeLink);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PARTNER20" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace as any,
      });

      expect(result).toBe(
        "[Shopify] Order event processed successfully with discount codes.",
      );

      // Verify Prisma query strictly filtered out disabled records (disabledAt: null)
      expect(mocks.linkFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            programId: baseWorkspace.defaultProgramId,
            partnerId: "partner_charlie",
            disabledAt: null,
          }),
        }),
      );

      // Attribution succeeded with the active link
      expect(mocks.attribute).toHaveBeenCalledWith({
        event,
        workspace: baseWorkspace,
        link: expect.objectContaining({
          id: "link_charlie_new_active",
        }),
      });
      expect(mocks.sale).toHaveBeenCalledTimes(1);
    });

    it("Case 4: Fail-closed security rule: Order with missing/corrupted timestamp rejects attribution on disabled code/link", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_disabled_no_ts",
          code: "PARTNER20",
          programId: baseWorkspace.defaultProgramId,
          partnerId: "partner_charlie",
          disabledAt: new Date("2026-06-01T00:00:00Z"),
          link: null,
        },
      ]);

      // Webhook event with null/corrupted timestamp
      const event = createOrderEvent({
        created_at: undefined,
        processed_at: "not-a-valid-date",
        discount_codes: [{ code: "PARTNER20" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace as any,
      });

      expect(result).toBe(
        "[Shopify] Factual order recorded. Order is not from a Dub affiliate link.",
      );
      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
    });

    it("Case 5: Multi-Tenant Zero-Hardcoding: Works dynamically without any hardcoded tenant or store identifiers", async () => {
      const dynamicStoreId = `store_${Date.now()}`;
      const dynamicWorkspace = {
        id: `ws_dynamic_${Date.now()}`,
        defaultProgramId: `prog_dynamic_${Date.now()}`,
        webhookEnabled: false,
      };

      mocks.guard.mockResolvedValue({ id: dynamicStoreId });
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_active",
          code: "TENANT_DISCOUNT",
          programId: dynamicWorkspace.defaultProgramId,
          partnerId: "partner_dynamic",
          disabledAt: null,
          link: {
            id: "link_active_tenant",
            programId: dynamicWorkspace.defaultProgramId,
            partnerId: "partner_dynamic",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        discount_codes: [{ code: "TENANT_DISCOUNT" }],
      });

      const result = await ordersPaid({
        event,
        workspace: dynamicWorkspace as any,
        storeId: dynamicStoreId,
      });

      expect(result).toBe(
        "[Shopify] Order event processed successfully with discount codes.",
      );
      expect(mocks.attribute).toHaveBeenCalledWith({
        event,
        workspace: dynamicWorkspace,
        link: expect.objectContaining({
          id: "link_active_tenant",
        }),
      });
    });
  });
});
