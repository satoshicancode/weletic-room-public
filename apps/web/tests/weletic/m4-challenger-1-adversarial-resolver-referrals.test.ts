import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

const legacy = vi.hoisted(() => ({
  lock: vi.fn(),
  advance: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/legacy-connection-fence", () => ({
  lockLegacyShopifyConnection: legacy.lock,
}));

vi.mock("@/lib/weletic/shopify/session-coordination", () => ({
  advanceLegacyShopifySessionRevision: legacy.advance,
}));

vi.mock("@/lib/weletic/shopify/session-snapshot", () => ({
  configuredShopifySessionScope: (shop: string) => ({
    appId: "weletic-app",
    shop,
  }),
}));

vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({ source: "legacy" })),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: vi.fn(async () => ({
    id: `wpledger_test_${Date.now()}`,
    balance: 500,
  })),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(async () => ({ id: `job_${Date.now()}` })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: legacy.queryRaw,
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
    project: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({
        id: "ref_created_01",
        status: "fraud_blocked",
      }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn().mockResolvedValue({
        id: "rule_active",
        isActive: true,
        maxReferralsPerAdvocate: 10,
      }),
      create: vi.fn(),
      update: vi.fn(),
    },
    link: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    tag: {
      upsert: vi.fn().mockResolvedValue({ id: "tag_upserted_1" }),
    },
  },
}));

import { encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import {
  bindShopperReferral,
  ensureAccountReferralLink,
  hashAbuseSignal,
} from "@/lib/weletic/loyalty/referrals";
import { readShopifyCredentialSource } from "@/lib/weletic/shopify/credential-source";
import {
  canonicalizeShopifyDomain,
  normalizeShopDomain,
  resolveShopifyStoreByDomain,
  shopifyCredentialVerificationHash,
} from "@/lib/weletic/shopify/store-resolver";

describe("Milestone 4 Challenger 1: Adversarial Store Resolver & Referrals Gate Verification", () => {
  const workspaceId = "ws_adv_gate_001";
  const programId = "prog_adv_gate_001";
  const testAccessToken = "shpat_adversarial_test_secret_token_999";
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;
  let encryptedToken: string;
  const mockFetch = vi.fn<typeof fetch>();

  beforeAll(() => {
    process.env.ENCRYPTION_KEY =
      "challenger-gate-verification-encryption-key-32b";
    encryptedToken = encrypt(testAccessToken);
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    legacy.lock.mockReset().mockResolvedValue(undefined);
    legacy.advance.mockReset().mockResolvedValue(undefined);
    mockFetch.mockReset().mockRejectedValue(new Error("Network unmocked"));
    vi.stubGlobal("fetch", mockFetch);

    vi.mocked(readShopifyCredentialSource)
      .mockReset()
      .mockResolvedValue({ source: "legacy" } as any);
    vi.mocked(prisma.project.findUnique).mockReset().mockResolvedValue(null);
    vi.mocked(prisma.project.findFirst).mockReset().mockResolvedValue(null);
    vi.mocked(prisma.weleticShopifyStore.findUnique)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(prisma.installedIntegration.findFirst)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(prisma.installedIntegration.findUnique)
      .mockReset()
      .mockResolvedValue(null);
    vi.mocked(prisma.installedIntegration.update)
      .mockReset()
      .mockResolvedValue({} as any);
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
      (async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })) as any,
    );

    legacy.queryRaw.mockReset().mockImplementation(async (query: any) => {
      const qStr = query.strings.join("");
      const storeId = String(query.values?.[0] || "store_default");
      if (qStr.includes("FROM InstalledIntegration")) {
        const row = await prisma.installedIntegration.findUnique({
          where: { id: query.values[0] },
        });
        return row ? [row] : [];
      }
      if (qStr.includes("FROM WeleticLoyaltyProgram")) {
        return [
          {
            id: programId,
            storeId,
            status: "active",
            killSwitchActive: false,
            metadata: null,
          },
        ];
      }
      if (qStr.includes("FROM WeleticShopifyStore")) {
        const store = await prisma.weleticShopifyStore.findUnique({
          where: { id: query.values[0] },
        });
        if (store) return [store];
      }
      return [
        {
          id: storeId,
          projectId: workspaceId,
          shopDomain: "canonical-tenant.myshopify.com",
          complianceState: "active",
          storeAccessState: "active",
          installationGeneration: "gen_gate_1",
        },
      ];
    });

    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === "function" ? callback(prisma) : callback,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. ADVERSARIAL DOMAIN NORMALIZATION & CANONICALIZATION HARNESS
  // =========================================================================
  describe("1. Domain Normalization & Canonicalization Attack Vectors", () => {
    it("handles adversarial inputs without throwing unexpected exceptions", () => {
      // Empty and falsy values
      expect(normalizeShopDomain("")).toBe("");
      expect(normalizeShopDomain("   ")).toBe("");
      expect(canonicalizeShopifyDomain("")).toBeNull();
      expect(canonicalizeShopifyDomain("   ")).toBeNull();

      // Protocols, trailing slashes, path traversal and queries
      expect(normalizeShopDomain("https://STORE-A.myshopify.com/")).toBe(
        "store-a.myshopify.com",
      );
      expect(
        normalizeShopDomain(
          "http://STORE-B.myshopify.com/admin/auth?shop=test",
        ),
      ).toBe("store-b.myshopify.com");
      expect(
        canonicalizeShopifyDomain("https://VALID-STORE.myshopify.com/path"),
      ).toBe("valid-store.myshopify.com");

      // Attack vectors: leading/trailing dashes, consecutive dots, symbols
      expect(canonicalizeShopifyDomain("-invalid.myshopify.com")).toBeNull();
      expect(canonicalizeShopifyDomain("invalid-.myshopify.com")).toBeNull();
      expect(canonicalizeShopifyDomain("double..dot.myshopify.com")).toBeNull();
      expect(canonicalizeShopifyDomain("store.attacker.com")).toBeNull();
      expect(
        canonicalizeShopifyDomain("store.myshopify.com.evil.com"),
      ).toBeNull();
      expect(normalizeShopDomain("store.myshopify.com/../../etc/passwd")).toBe(
        "store.myshopify.com",
      );
    });

    it("ensures canonicalizeShopifyDomain strictly permits only valid RFC-compliant myshopify subdomains", () => {
      const validSubdomains = [
        "a.myshopify.com",
        "123.myshopify.com",
        "store-1.myshopify.com",
        "brand-new-store-2026.myshopify.com",
      ];
      for (const d of validSubdomains) {
        expect(canonicalizeShopifyDomain(d)).toBe(d);
      }

      const invalidSubdomains = [
        "*.myshopify.com",
        "store_name.myshopify.com", // underscore invalid in Shopify subdomain
        "store..myshopify.com",
        "store@domain.myshopify.com",
        "myshopify.com", // root domain without subdomain
        ".myshopify.com",
      ];
      for (const d of invalidSubdomains) {
        expect(canonicalizeShopifyDomain(d)).toBeNull();
      }
    });
  });

  // =========================================================================
  // 2. MULTI-DOMAIN CANONICAL RESOLUTION & INVARIANT 1 VERIFICATION
  // =========================================================================
  describe("2. Canonical Store Resolver Multi-Domain Matrix (Invariant 1)", () => {
    it("resolves store seamlessly via weleticShopifyStore.shopDomain", async () => {
      const shop = "tenant-primary.myshopify.com";
      const storeRecord = {
        id: "store_prim_1",
        projectId: workspaceId,
        shopDomain: shop,
        complianceState: "active",
        storeAccessState: "active",
        installationGeneration: "gen_prim",
      };

      (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
        async (args: any) => {
          if (
            args?.where?.shopDomain === shop ||
            args?.where?.projectId === workspaceId ||
            args?.where?.id === "store_prim_1"
          ) {
            return storeRecord as any;
          }
          return null;
        },
      );

      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        id: workspaceId,
        shopifyStoreId: shop,
        defaultProgramId: programId,
        installedIntegrations: [
          {
            id: "inst_prim",
            credentials: {
              shop,
              accessToken: encryptedToken,
              shopVerifiedAt: "2026-10-01T00:00:00.000Z",
              shopVerificationTokenHash:
                shopifyCredentialVerificationHash(testAccessToken),
              installationGeneration: "gen_prim",
            },
          },
        ],
      } as any);

      vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValue({
        id: "inst_prim",
        projectId: workspaceId,
        credentials: {
          shop,
          accessToken: encryptedToken,
          shopVerifiedAt: "2026-10-01T00:00:00.000Z",
          shopVerificationTokenHash:
            shopifyCredentialVerificationHash(testAccessToken),
          installationGeneration: "gen_prim",
        },
      } as any);

      const resolved = await resolveShopifyStoreByDomain(shop);
      expect(resolved).not.toBeNull();
      expect(resolved?.workspaceId).toBe(workspaceId);
      expect(resolved?.programId).toBe(programId);
      expect(resolved?.accessToken).toBe(testAccessToken);
      expect(resolved?.storeId).toBe("store_prim_1");
      expect(resolved?.allDomains).toContain(shop);
    });

    it("resolves store seamlessly via legacy domain stored in credentials.shop (alias resolution)", async () => {
      const legacyAlias = "legacy-alias.myshopify.com";
      const canonicalShop = "current-name.myshopify.com";

      const storeRecord = {
        id: "store_legacy_1",
        projectId: workspaceId,
        shopDomain: canonicalShop,
        complianceState: "active",
        storeAccessState: "active",
        installationGeneration: "gen_leg",
      };

      (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
        async (args: any) => {
          if (
            args?.where?.id === "store_legacy_1" ||
            args?.where?.projectId === workspaceId
          ) {
            return storeRecord as any;
          }
          return null;
        },
      );

      // InstalledIntegration lookup by credentials.shop matches legacy alias
      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        id: "inst_legacy",
        credentials: {
          shop: legacyAlias,
          accessToken: encryptedToken,
          shopVerifiedAt: "2026-09-01T00:00:00.000Z",
          shopVerificationTokenHash:
            shopifyCredentialVerificationHash(testAccessToken),
          installationGeneration: "gen_leg",
        },
        project: {
          id: workspaceId,
          shopifyStoreId: canonicalShop,
          defaultProgramId: programId,
          weleticShopifyStore: storeRecord,
        },
      } as any);

      vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValue({
        id: "inst_legacy",
        projectId: workspaceId,
        credentials: {
          shop: legacyAlias,
          accessToken: encryptedToken,
          shopVerifiedAt: "2026-09-01T00:00:00.000Z",
          shopVerificationTokenHash:
            shopifyCredentialVerificationHash(testAccessToken),
          installationGeneration: "gen_leg",
        },
      } as any);

      const resolved = await resolveShopifyStoreByDomain(legacyAlias);
      expect(resolved).not.toBeNull();
      expect(resolved?.workspaceId).toBe(workspaceId);
      expect(resolved?.accessToken).toBe(testAccessToken);
      expect(resolved?.allDomains).toContain(legacyAlias);
      expect(resolved?.allDomains).toContain(canonicalShop);
    });

    it("rejects unverified credential alias when live Shopify verification fails", async () => {
      const unverifiedDomain = "unverified-alias.myshopify.com";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.project.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null);

      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        id: "inst_unverified",
        credentials: {
          shop: unverifiedDomain,
          accessToken: encryptedToken,
          // Missing shopVerificationTokenHash -> triggers live verification
        },
        project: {
          id: workspaceId,
          shopifyStoreId: "legit.myshopify.com",
          defaultProgramId: programId,
          weleticShopifyStore: {
            id: "store_legit",
            shopDomain: "legit.myshopify.com",
            installationGeneration: "gen_unverified",
          },
        },
      } as any);

      // Live Shopify Admin GraphQL responds with 401 Unauthorized
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const resolved = await resolveShopifyStoreByDomain(unverifiedDomain);
      expect(resolved).toBeNull();
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(prisma.installedIntegration.update).not.toHaveBeenCalled();
    });

    it("rejects unverified credential alias when live Shopify identity returns a different shop domain", async () => {
      const requestedDomain = "claimed-victim.myshopify.com";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.project.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.project.findFirst).mockResolvedValue(null);

      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        id: "inst_spoofed",
        credentials: {
          shop: requestedDomain,
          accessToken: encryptedToken,
        },
        project: {
          id: workspaceId,
          shopifyStoreId: "attacker.myshopify.com",
          defaultProgramId: programId,
          weleticShopifyStore: {
            id: "store_attacker",
            shopDomain: "attacker.myshopify.com",
            installationGeneration: "gen_spoof",
          },
        },
      } as any);

      // Live GraphQL returns actual domain is attacker.myshopify.com, not claimed-victim
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            shop: {
              myshopifyDomain: "attacker.myshopify.com",
              currencyCode: "USD",
            },
          },
        }),
      } as Response);

      const resolved = await resolveShopifyStoreByDomain(requestedDomain);
      expect(resolved).toBeNull();
      expect(prisma.installedIntegration.update).not.toHaveBeenCalled();
    });

    it("rejects credential from mismatched installationGeneration", async () => {
      const domain = "stale-gen.myshopify.com";

      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        id: "inst_stale",
        credentials: {
          shop: domain,
          accessToken: encryptedToken,
          installationGeneration: "gen_OLD", // old generation
          shopVerificationTokenHash:
            shopifyCredentialVerificationHash(testAccessToken),
        },
        project: {
          id: workspaceId,
          shopifyStoreId: domain,
          defaultProgramId: programId,
          weleticShopifyStore: {
            id: "store_fresh",
            shopDomain: domain,
            installationGeneration: "gen_NEW", // store is on new generation
          },
        },
      } as any);

      const resolved = await resolveShopifyStoreByDomain(domain);
      expect(resolved).toBeNull();
    });

    it("rejects resolution when InstalledIntegration belongs to a foreign workspace", async () => {
      const domain = "foreign-workspace.myshopify.com";
      const tokenHash = shopifyCredentialVerificationHash(testAccessToken);

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: "store_target",
        projectId: "ws_target_victim",
        shopDomain: domain,
        complianceState: "active",
        storeAccessState: "active",
        installationGeneration: "gen_cross",
      } as any);

      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        id: "ws_target_victim",
        shopifyStoreId: domain,
        defaultProgramId: "prog_target",
        installedIntegrations: [
          {
            id: "inst_target",
            credentials: {
              shop: domain,
              accessToken: encryptedToken,
              installationGeneration: "gen_cross",
              shopVerificationTokenHash: tokenHash,
            },
          },
        ],
      } as any);

      legacy.queryRaw.mockImplementation(async (query: any) => {
        const qStr = query.strings.join("");
        if (qStr.includes("FROM InstalledIntegration")) {
          return [
            {
              id: "inst_target",
              projectId: "ws_attacker_foreign", // MISMATCH!
              credentials: {
                shop: domain,
                accessToken: encryptedToken,
                installationGeneration: "gen_cross",
                shopVerificationTokenHash: tokenHash,
              },
            },
          ];
        }
        if (qStr.includes("FROM WeleticShopifyStore")) {
          return [
            {
              id: "store_target",
              projectId: "ws_target_victim",
              shopDomain: domain,
              complianceState: "active",
              installationGeneration: "gen_cross",
            },
          ];
        }
        return [];
      });

      const resolved = await resolveShopifyStoreByDomain(domain);
      expect(resolved).toBeNull();
    });

    it("enforces native credential boundary: only canonical shopDomain can authenticate", async () => {
      const canonicalShop = "native-canonical.myshopify.com";
      const aliasQuery = "native-alias.myshopify.com";

      (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
        async (args: any) => {
          if (args?.where?.projectId === workspaceId) {
            return {
              id: "store_native_1",
              projectId: workspaceId,
              shopDomain: canonicalShop,
              complianceState: "active",
              storeAccessState: "active",
              installationGeneration: "gen_nat",
            } as any;
          }
          return null;
        },
      );

      vi.mocked(prisma.project.findUnique).mockResolvedValue({
        id: workspaceId,
        shopifyStoreId: aliasQuery,
        defaultProgramId: programId,
        installedIntegrations: [],
      } as any);

      vi.mocked(readShopifyCredentialSource).mockResolvedValue({
        source: "native",
        accessToken: "shpat_native_token_valid",
      } as any);

      // Querying with alias when source is native must be rejected
      const resolved = await resolveShopifyStoreByDomain(aliasQuery);
      expect(resolved).toBeNull();
    });
  });

  // =========================================================================
  // 3. ZERO-HARDCODING INVARIANT (INVARIANT 4) AUDIT
  // =========================================================================
  describe("3. Zero-Hardcoding Invariant (Invariant 4) Verification", () => {
    it("dynamically resolves arbitrary tenant domains without hardcoded domain checks", async () => {
      const arbitraryTenants = [
        {
          domain: "brand-alpha.myshopify.com",
          ws: "ws_alpha",
          prog: "prog_alpha",
          token: "tok_alpha",
        },
        {
          domain: "brand-beta.myshopify.com",
          ws: "ws_beta",
          prog: "prog_beta",
          token: "tok_beta",
        },
        {
          domain: "custom-tenant-gamma.myshopify.com",
          ws: "ws_gamma",
          prog: "prog_gamma",
          token: "tok_gamma",
        },
      ];

      for (const tenant of arbitraryTenants) {
        vi.mocked(readShopifyCredentialSource).mockResolvedValue({
          source: "legacy",
        } as any);
        const encTok = encrypt(tenant.token);
        const tHash = shopifyCredentialVerificationHash(tenant.token);
        const stRec = {
          id: `store_${tenant.ws}`,
          projectId: tenant.ws,
          shopDomain: tenant.domain,
          complianceState: "active",
          storeAccessState: "active",
          installationGeneration: "gen_dyn",
        };

        (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
          async (args: any) => {
            if (
              args?.where?.shopDomain === tenant.domain ||
              args?.where?.projectId === tenant.ws ||
              args?.where?.id === `store_${tenant.ws}`
            ) {
              return stRec as any;
            }
            return null;
          },
        );

        vi.mocked(prisma.project.findUnique).mockResolvedValue({
          id: tenant.ws,
          shopifyStoreId: tenant.domain,
          defaultProgramId: tenant.prog,
          installedIntegrations: [
            {
              id: `inst_${tenant.ws}`,
              credentials: {
                shop: tenant.domain,
                accessToken: encTok,
                installationGeneration: "gen_dyn",
                shopVerificationTokenHash: tHash,
                shopVerifiedAt: "2026-10-01T00:00:00Z",
              },
            },
          ],
        } as any);

        vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValue({
          id: `inst_${tenant.ws}`,
          projectId: tenant.ws,
          credentials: {
            shop: tenant.domain,
            accessToken: encTok,
            installationGeneration: "gen_dyn",
            shopVerificationTokenHash: tHash,
            shopVerifiedAt: "2026-10-01T00:00:00Z",
          },
        } as any);

        legacy.queryRaw.mockImplementation(async (query: any) => {
          const qStr = query.strings.join("");
          if (qStr.includes("FROM InstalledIntegration")) {
            return [
              {
                id: `inst_${tenant.ws}`,
                projectId: tenant.ws,
                credentials: {
                  shop: tenant.domain,
                  accessToken: encTok,
                  installationGeneration: "gen_dyn",
                  shopVerificationTokenHash: tHash,
                  shopVerifiedAt: "2026-10-01T00:00:00Z",
                },
              },
            ];
          }
          if (qStr.includes("FROM WeleticShopifyStore")) {
            return [stRec];
          }
          return [];
        });

        const res = await resolveShopifyStoreByDomain(tenant.domain);
        expect(res).not.toBeNull();
        expect(res?.workspaceId).toBe(tenant.ws);
        expect(res?.programId).toBe(tenant.prog);
        expect(res?.accessToken).toBe(tenant.token);
        expect(res?.primaryDomain).toBe(tenant.domain);
      }
    });
  });

  // =========================================================================
  // 4. DECOUPLED REFERRALS ENGINE ADVERSARIAL MATRIX (referrals.ts)
  // =========================================================================
  describe("4. Decoupled Referrals Engine Adversarial Testing (referrals.ts)", () => {
    const storeId = "store_ref_test_01";
    const accountId = "acc_advocate_01";
    const shopDomain = "arbitrary-merchant.myshopify.com";
    const projectId = "proj_ref_test_01";

    it("ensureAccountReferralLink resolves shortLink using verified primary custom domain", async () => {
      const primaryDomain = "ref.custom-brand.com";
      const referralCode = "GATE-9999";
      const key = `ref-${referralCode.toLowerCase()}`;
      const destinationUrl = `https://${shopDomain}?ref=${encodeURIComponent(referralCode)}`;
      const shortLink = `https://${primaryDomain}/${key}`;

      const mockAccount = {
        id: accountId,
        storeId,
        referralCode,
        status: "active",
        metadata: null,
        shopper: {
          id: "sh_1",
          firstName: "Hiro",
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
        store: {
          id: storeId,
          shopDomain,
          projectId,
          programId,
          complianceState: "active",
          storeAccessState: "active",
          project: {
            domains: [
              {
                slug: primaryDomain,
                primary: true,
                verified: true,
                archived: false,
              },
            ],
          },
        },
      };

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async (args: any) => {
          if (args?.where?.id === accountId) return mockAccount as any;
          return null;
        },
      );

      vi.mocked(prisma.link.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.link.create).mockResolvedValueOnce({
        id: "link_gate_created",
        domain: primaryDomain,
        key,
        url: destinationUrl,
        shortLink,
      } as any);

      const linkResult = await ensureAccountReferralLink({
        storeId,
        accountId,
      });
      expect(linkResult.referralCode).toBe(referralCode);
      expect(linkResult.referralLink).toBe(shortLink);
      expect(linkResult.dubLinkId).toBe("link_gate_created");

      expect(prisma.link.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId,
            programId,
            partnerId: null, // ZERO PARTNER
            url: destinationUrl,
          }),
        }),
      );
    });

    it("ensureAccountReferralLink ignores unverified or archived domains and falls back to destinationUrl", async () => {
      // In decoupled architecture, when store.project is not preloaded or has no verified primary domains,
      // prisma.project.findUnique queries domains where primary: true, verified: true, archived: false.
      // If none match, primaryDomain is null and it returns destinationUrl.
      const mockAccount = {
        id: accountId,
        storeId,
        referralCode: "GATE-UNVERIFIED",
        status: "active",
        metadata: null,
        shopper: {
          id: "sh_1",
          firstName: "Hiro",
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
        store: {
          id: storeId,
          shopDomain,
          projectId,
          programId,
          complianceState: "active",
          storeAccessState: "active",
          // No preloaded project: triggers decoupled prisma.project.findUnique
        },
      };

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async (args: any) => {
          if (args?.where?.id === accountId) return mockAccount as any;
          return null;
        },
      );

      // Project lookup returns empty domains (because none are primary+verified+unarchived)
      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
        id: projectId,
        domains: [], // No verified primary domains!
      } as any);

      const linkResult = await ensureAccountReferralLink({
        storeId,
        accountId,
      });
      expect(linkResult.referralCode).toBe("GATE-UNVERIFIED");
      expect(linkResult.referralLink).toBe(
        `https://${shopDomain}?ref=GATE-UNVERIFIED`,
      );
      expect(linkResult.dubLinkId).toBeNull();
      expect(prisma.link.create).not.toHaveBeenCalled();
    });

    it("ensureAccountReferralLink queries decoupled prisma.project.findUnique when project is not preloaded", async () => {
      const primaryDomain = "decoupled.brand.link";
      const referralCode = "GATE-DECOUPLED";
      const key = `ref-${referralCode.toLowerCase()}`;
      const destinationUrl = `https://${shopDomain}?ref=${encodeURIComponent(referralCode)}`;
      const shortLink = `https://${primaryDomain}/${key}`;

      const mockAccount = {
        id: accountId,
        storeId,
        referralCode,
        status: "active",
        metadata: null,
        shopper: {
          id: "sh_1",
          firstName: "Hiro",
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
        store: {
          id: storeId,
          shopDomain,
          projectId,
          programId,
          complianceState: "active",
          storeAccessState: "active",
        },
      };

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async (args: any) => {
          if (args?.where?.id === accountId) return mockAccount as any;
          return null;
        },
      );

      vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
        id: projectId,
        domains: [
          {
            slug: primaryDomain,
            primary: true,
            verified: true,
            archived: false,
          },
        ],
      } as any);

      vi.mocked(prisma.link.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.link.create).mockResolvedValueOnce({
        id: "link_decoupled_created",
        domain: primaryDomain,
        key,
        url: destinationUrl,
        shortLink,
      } as any);

      const linkResult = await ensureAccountReferralLink({
        storeId,
        accountId,
      });
      expect(linkResult.referralCode).toBe(referralCode);
      expect(linkResult.referralLink).toBe(shortLink);
      expect(prisma.project.findUnique).toHaveBeenCalledWith({
        where: { id: projectId },
        include: {
          domains: {
            where: { primary: true, verified: true, archived: false },
            take: 1,
          },
        },
      });
    });

    it("survives gracefully when prisma.project is undefined in isolated test harness", async () => {
      const originalProjectDelegate = prisma.project;
      try {
        (prisma as any).project = undefined;

        const mockAccount = {
          id: accountId,
          storeId,
          referralCode: "SAFE-NO-DELEGATE",
          status: "active",
          metadata: null,
          shopper: {
            id: "sh_1",
            firstName: "Hiro",
            shopifyCustomerId: "gid://shopify/Customer/123",
          },
          store: {
            id: storeId,
            shopDomain,
            projectId,
            programId,
            complianceState: "active",
            storeAccessState: "active",
          },
        };

        (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
          async (args: any) => {
            if (args?.where?.id === accountId) return mockAccount as any;
            return null;
          },
        );

        const result = await ensureAccountReferralLink({ storeId, accountId });
        expect(result.referralCode).toBe("SAFE-NO-DELEGATE");
        expect(result.referralLink).toBe(
          `https://${shopDomain}?ref=SAFE-NO-DELEGATE`,
        );
        expect(result.dubLinkId).toBeNull();
      } finally {
        (prisma as any).project = originalProjectDelegate;
      }
    });

    it("throws strict error when account does not belong to specified storeId", async () => {
      const mockAccount = {
        id: accountId,
        storeId: "store_foreign_99",
        status: "active",
        shopper: {
          id: "sh_1",
          firstName: "Hiro",
          shopifyCustomerId: "gid://shopify/Customer/123",
        },
        store: {
          id: "store_foreign_99",
          shopDomain,
          projectId,
          complianceState: "active",
          storeAccessState: "active",
        },
      };

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async (args: any) => {
          if (args?.where?.id === accountId) return mockAccount as any;
          return null;
        },
      );

      await expect(
        ensureAccountReferralLink({ storeId: "store_victim_01", accountId }),
      ).rejects.toThrow(/does not belong to Shopify store/);
    });
  });

  // =========================================================================
  // 5. ANTI-ABUSE & SELF-REFERRAL ATTACK VECTORS (referrals.ts)
  // =========================================================================
  describe("5. Anti-Abuse & Anti-Self-Referral Validation", () => {
    it("hashes IP abuse signals deterministically with store-scoped privacy digest", () => {
      const storeId = "store_hash_test";
      const ip = "203.0.113.195";
      const hash1 = hashAbuseSignal({ storeId, kind: "ip", signal: ip });
      const hash2 = hashAbuseSignal({ storeId, kind: "ip", signal: ip });
      expect(hash1).toBeDefined();
      expect(hash1).toEqual(hash2);
      expect(hash1).not.toBeNull();
      expect(typeof hash1).toBe("string");
    });

    it("strictly blocks self-referral attempts where advocate and referee share identical shopper IDs", async () => {
      const storeId = "store_antiabuse";
      const programId = "prog_antiabuse";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: storeId,
        projectId: workspaceId,
        complianceState: "active",
        storeAccessState: "active",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_same_shopper",
        storeId,
        shopperId: "shopper_common_id",
        status: "active",
        metadata: null,
        referredById: null,
        store: { id: storeId, projectId: workspaceId, programId },
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_advocate_same_shopper",
        storeId,
        shopperId: "shopper_common_id", // IDENTICAL SHOPPER ID!
        status: "active",
        metadata: null,
        referredById: null,
        store: { id: storeId, projectId: workspaceId, programId },
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_referee_same_shopper",
          referralCode: "SELF-REF",
        }),
      ).rejects.toThrow(/Self-referral is strictly prohibited/);
    });

    it("detects same-IP abuse signal and marks referral status fraud_blocked", async () => {
      const storeId = "store_antiabuse_ip";
      const programId = "prog_antiabuse_ip";
      const commonIp = "198.51.100.42";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: storeId,
        projectId: workspaceId,
        complianceState: "active",
        storeAccessState: "active",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_ip",
        storeId,
        shopperId: "shopper_referee_unique",
        status: "active",
        metadata: null,
        referredById: null,
        store: { id: storeId, projectId: workspaceId, programId },
      } as any);

      const advocateIpHash = hashAbuseSignal({
        storeId,
        kind: "ip",
        signal: commonIp,
      });

      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_advocate_ip",
        storeId,
        shopperId: "shopper_advocate_unique",
        status: "active",
        programId,
        metadata: {
          signupIpHash: advocateIpHash,
        },
        referredById: null,
        store: { id: storeId, projectId: workspaceId, programId },
      } as any);

      const result = await bindShopperReferral({
        storeId,
        refereeAccountId: "acc_referee_ip",
        referralCode: "IP-MATCH",
        clientIp: commonIp, // Matches advocate signup IP!
      });

      expect(result.status).toBe("fraud_blocked");
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });
  });
});
