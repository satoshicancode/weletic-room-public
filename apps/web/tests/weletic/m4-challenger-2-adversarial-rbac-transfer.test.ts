import { throwIfNoPermission } from "@/lib/actions/throw-if-no-permission";
import {
  PERMISSION_ACTIONS as DUB_PERMISSION_ACTIONS,
  ROLE_PERMISSIONS as DUB_ROLE_PERMISSIONS,
  getPermissionsByRole,
} from "@/lib/api/rbac/permissions";
import {
  PluginPermissionDefinition,
  permissionRegistry,
} from "@/lib/api/rbac/plugin-registry";
import {
  DUB_RESOURCE_KEYS,
  DUB_RESOURCES,
  RESOURCE_KEYS,
  RESOURCES,
} from "@/lib/api/rbac/resources";
import { throwIfNoAccess } from "@/lib/api/tokens/throw-if-no-access";
import {
  DUB_RESOURCE_SCOPES,
  DUB_SCOPES,
  getScopesByResourceForRole,
  getScopesForRole,
  mapScopesToPermissions,
  RESOURCE_SCOPES,
  ROLE_SCOPES_MAP,
  SCOPE_PERMISSIONS_MAP,
  SCOPES,
  SCOPES_BY_RESOURCE,
  validateScopesForRole,
} from "@/lib/api/tokens/scopes";
import {
  BELOW_MIN_WITHDRAWAL_FEE_CENTS,
  MIN_FORCE_WITHDRAWAL_AMOUNT_CENTS,
  MIN_WITHDRAWAL_AMOUNT_CENTS,
} from "@/lib/constants/payouts";
import { createStripeTransfer } from "@/lib/partners/create-stripe-transfer";
import {
  TransferPreProcessingContext,
  executeTransferPreProcessingHook,
  registerTransferPreProcessingHook,
  transferHookRegistry,
} from "@/lib/partners/transfer-hooks";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { weleticSettlementHook } from "@/lib/weletic/payouts/settlement-hook";
import { WorkspaceRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Canonical Weletic permission definitions
const WELETIC_PERMISSIONS: PluginPermissionDefinition[] = [
  {
    action: "loyalty.read",
    description: "access loyalty program",
    roles: ["owner", "member", "viewer", "billing"],
    resource: {
      name: "Loyalty",
      key: "loyalty",
      description:
        "Create, read, update, and delete loyalty programs, rewards, and rules",
    },
    scope: {
      type: "read",
      resource: "loyalty",
      includeInApisRead: true,
      includeInApisAll: true,
    },
  },
  {
    action: "loyalty.write",
    description: "manage loyalty program",
    roles: ["owner", "member"],
    resource: {
      name: "Loyalty",
      key: "loyalty",
      description:
        "Create, read, update, and delete loyalty programs, rewards, and rules",
    },
    scope: {
      type: "write",
      resource: "loyalty",
      includeInApisAll: true,
    },
  },
];

// Hoisted mocks for stripe and prisma
const stripeMocks = vi.hoisted(() => ({
  transfersCreate: vi.fn(),
  accountsRetrieve: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => {
  const quoteUpdate = vi.fn().mockResolvedValue({ id: "quote_1" });
  const statementUpdate = vi.fn().mockResolvedValue({ id: "stmt_1" });
  const statementFindUnique = vi.fn().mockResolvedValue({
    snapshot: { payoutAmount: "1000", feeAmount: "0" },
  });
  const partnerFindUniqueOrThrow = vi.fn();
  const payoutFindMany = vi.fn();
  const payoutUpdateMany = vi.fn();
  const commissionFindMany = vi.fn().mockResolvedValue([]);
  const commissionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const partnerUpdate = vi.fn();

  const mock: any = {
    partner: {
      findUniqueOrThrow: partnerFindUniqueOrThrow,
      update: partnerUpdate,
    },
    payout: {
      findMany: payoutFindMany,
      updateMany: payoutUpdateMany,
    },
    commission: {
      findMany: commissionFindMany,
      updateMany: commissionUpdateMany,
    },
    weleticPayoutQuote: { update: quoteUpdate },
    weleticPayoutStatement: {
      findUnique: statementFindUnique,
      update: statementUpdate,
    },
  };
  mock.$transaction = vi.fn(async (cb) => cb(mock));
  return mock;
});

const settlementMock = vi.hoisted(() => ({
  getWeleticPayoutSettlement: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    transfers: {
      create: stripeMocks.transfersCreate,
    },
    accounts: {
      retrieve: stripeMocks.accountsRetrieve,
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMocks,
}));

vi.mock("@/lib/weletic/payouts/get-settlement", () => ({
  getWeleticPayoutSettlement: settlementMock.getWeleticPayoutSettlement,
}));

vi.mock("@/lib/partners/payouts/mark-payouts-as-processed", () => ({
  markPayoutsAsProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/partners/payouts/create-payouts-idempotency-key", () => ({
  createPayoutsIdempotencyKey: vi.fn(() => "mock_idempotency_key"),
}));

vi.mock("@/lib/partners/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api/commissions/track-commission-update-activity-log", () => ({
  trackCommissionStatusUpdatesByProgram: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@dub/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ id: "email_sent_id" }),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise) => promise),
}));

vi.mock("server-only", () => ({}));

describe("M4 Challenger 2: Adversarial RBAC & Transfer Hook Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure Weletic permissions are populated in the registry
    permissionRegistry.register(WELETIC_PERMISSIONS);
    // Ensure TransferHookRegistry has weleticSettlementHook registered
    transferHookRegistry.clear();
    registerTransferPreProcessingHook(weleticSettlementHook);

    // Setup standard Stripe account mock
    stripeMocks.accountsRetrieve.mockResolvedValue({
      id: "acct_connect_1",
      payouts_enabled: true,
      capabilities: { transfers: "active" },
    });

    stripeMocks.transfersCreate.mockResolvedValue({
      id: "tr_stripe_test_123",
      amount: 10000,
      currency: "usd",
    });

    settlementMock.getWeleticPayoutSettlement.mockImplementation(
      async ({ payoutId }) => ({
        payoutId,
        amount: BigInt(5000),
        currency: "USD",
        quoteId: `quote_${payoutId}`,
      }),
    );
  });

  // =========================================================================
  // SUB-SUITE 1: ADVERSARIAL DYNAMIC RBAC PLUGIN REGISTRY
  // =========================================================================
  describe("Adversarial Dynamic RBAC Plugin Registry", () => {
    const ALL_ROLES: WorkspaceRole[] = ["owner", "member", "viewer", "billing"];

    it("strictly denies unrecognized, unregistered, or bogus permission actions across all roles", () => {
      const bogusPermissions = [
        "loyalty.delete",
        "loyalty.destroy",
        "loyalty.admin",
        "workspace.superadmin",
        "unknown.permission",
        "arbitrary.action",
        "__proto__",
        "constructor",
        "' OR '1'='1",
      ];

      for (const role of ALL_ROLES) {
        const rolePermissions = getPermissionsByRole(role);
        for (const bogus of bogusPermissions) {
          expect(rolePermissions).not.toContain(bogus);
        }
      }

      // Ensure throwIfNoAccess strictly rejects unregistered permissions even for owner
      const ownerPerms = getPermissionsByRole("owner");
      for (const bogus of bogusPermissions) {
        expect(() =>
          throwIfNoAccess({
            permissions: ownerPerms as any,
            requiredPermissions: [bogus as any],
            workspaceId: "ws_test_123",
          }),
        ).toThrowError(/You don't have the necessary permissions/);
      }

      // Ensure throwIfNoPermission strictly rejects unregistered permissions even for owner
      for (const bogus of bogusPermissions) {
        expect(() =>
          throwIfNoPermission({
            role: "owner",
            requiredPermissions: [bogus as any],
          }),
        ).toThrowError(/You don't have the necessary permissions/);
      }
    });

    it("strictly isolates token scopes: unknown scopes map to zero permissions and fail validation", () => {
      const unknownScopes = [
        "loyalty.destroy",
        "invalid_scope",
        "malicious.scope",
        "loyalty.delete",
      ];

      const mappedPermissions = mapScopesToPermissions(unknownScopes as any);
      expect(mappedPermissions).toEqual([]);

      // validateScopesForRole must reject all unknown scopes for every role
      for (const role of ALL_ROLES) {
        expect(validateScopesForRole(unknownScopes as any, role)).toBe(false);
        for (const bogus of unknownScopes) {
          expect(validateScopesForRole([bogus as any], role)).toBe(false);
        }
      }
    });

    it("adversarially tests composite scope expansion: apis.read vs apis.all", () => {
      // 1. apis.read expansion
      const apisReadPerms = mapScopesToPermissions(["apis.read"]);
      expect(apisReadPerms).toContain("loyalty.read");
      expect(apisReadPerms).not.toContain("loyalty.write");
      // Must not contain any write permissions from core either
      expect(apisReadPerms).not.toContain("links.write");
      expect(apisReadPerms).not.toContain("workspaces.write");
      expect(apisReadPerms).not.toContain("domains.write");

      // 2. apis.all expansion
      const apisAllPerms = mapScopesToPermissions(["apis.all"]);
      expect(apisAllPerms).toContain("loyalty.read");
      expect(apisAllPerms).toContain("loyalty.write");
      expect(apisAllPerms).toContain("links.read");
      expect(apisAllPerms).toContain("links.write");

      // 3. Granular token scopes: loyalty.write automatically grants loyalty.read, but loyalty.read NEVER grants loyalty.write
      const readOnlyTokenPerms = mapScopesToPermissions(["loyalty.read"]);
      expect(readOnlyTokenPerms).toEqual(["loyalty.read"]);
      expect(readOnlyTokenPerms).not.toContain("loyalty.write");

      const writeTokenPerms = mapScopesToPermissions(["loyalty.write"]);
      expect(writeTokenPerms).toContain("loyalty.write");
      expect(writeTokenPerms).toContain("loyalty.read");
    });

    it("verifies dynamic custom plugin flags for includeInApisRead and includeInApisAll", () => {
      // Register custom plugin with selective composite flags
      permissionRegistry.register([
        {
          action: "custom_audit.read",
          description: "audit logs read",
          roles: ["owner"],
          scope: {
            type: "read",
            resource: "audit",
            includeInApisRead: false, // NOT in apis.read
            includeInApisAll: true,   // YES in apis.all
          },
        },
        {
          action: "custom_secret.read",
          description: "secret read",
          roles: ["owner"],
          scope: {
            type: "read",
            resource: "secret",
            includeInApisRead: false, // NOT in apis.read
            includeInApisAll: false,  // NOT in apis.all
          },
        },
      ]);

      const apisReadPerms = mapScopesToPermissions(["apis.read"]);
      expect(apisReadPerms).not.toContain("custom_audit.read");
      expect(apisReadPerms).not.toContain("custom_secret.read");

      const apisAllPerms = mapScopesToPermissions(["apis.all"]);
      expect(apisAllPerms).toContain("custom_audit.read");
      expect(apisAllPerms).not.toContain("custom_secret.read");
    });

    it("strictly preserves role privilege boundaries (viewer and billing never get loyalty.write)", () => {
      const viewerPerms = getPermissionsByRole("viewer");
      const billingPerms = getPermissionsByRole("billing");

      expect(viewerPerms).toContain("loyalty.read");
      expect(viewerPerms).not.toContain("loyalty.write");

      expect(billingPerms).toContain("loyalty.read");
      expect(billingPerms).not.toContain("loyalty.write");

      // Attempting to validate loyalty.write for viewer or billing must return false
      expect(validateScopesForRole(["loyalty.write"], "viewer")).toBe(false);
      expect(validateScopesForRole(["loyalty.write"], "billing")).toBe(false);

      // Attempting throwIfNoAccess for viewer on loyalty.write must throw
      expect(() =>
        throwIfNoAccess({
          permissions: viewerPerms as any,
          requiredPermissions: ["loyalty.write"],
          workspaceId: "ws_123",
        }),
      ).toThrowError(/You don't have the necessary permissions/);

      // Member gets loyalty.read & loyalty.write, but NOT owner-only permissions
      const memberPerms = getPermissionsByRole("member");
      expect(memberPerms).toContain("loyalty.read");
      expect(memberPerms).toContain("loyalty.write");
      expect(memberPerms).not.toContain("workspaces.write");
      expect(memberPerms).not.toContain("domains.write");
      expect(memberPerms).not.toContain("tokens.write");
      expect(memberPerms).not.toContain("webhooks.write");
    });

    it("stress-tests Proxy behavior and properties for SCOPES, RESOURCE_KEYS, and RESOURCES", () => {
      // 1. Array-like inspection
      expect(Array.isArray(SCOPES)).toBe(true);
      expect(Array.isArray(RESOURCE_KEYS)).toBe(true);
      expect(Array.isArray(RESOURCES)).toBe(true);

      // 2. Iteration and length
      expect(SCOPES.length).toBeGreaterThan(DUB_SCOPES.length);
      expect([...SCOPES]).toContain("loyalty.read");
      expect([...SCOPES]).toContain("loyalty.write");

      // 3. Index access
      expect(SCOPES[0]).toBeDefined();
      expect(RESOURCE_KEYS[0]).toBeDefined();

      // 4. Object proxies: SCOPE_PERMISSIONS_MAP, ROLE_SCOPES_MAP, SCOPES_BY_RESOURCE
      expect(SCOPE_PERMISSIONS_MAP["loyalty.read"]).toEqual(["loyalty.read"]);
      expect(SCOPE_PERMISSIONS_MAP["loyalty.write"]).toEqual([
        "loyalty.write",
        "loyalty.read",
      ]);

      expect(ROLE_SCOPES_MAP["owner"]).toContain("loyalty.read");
      expect(ROLE_SCOPES_MAP["owner"]).toContain("loyalty.write");
      expect(ROLE_SCOPES_MAP["viewer"]).toContain("loyalty.read");
      expect(ROLE_SCOPES_MAP["viewer"]).not.toContain("loyalty.write");

      expect(SCOPES_BY_RESOURCE["loyalty"]).toBeDefined();
      expect(SCOPES_BY_RESOURCE["loyalty"]).toHaveLength(2);
    });

    it("tests lifecycle isolation: clearing the registry purges all dynamic permissions", () => {
      permissionRegistry.clear();

      // After clear, only upstream Dub permissions exist
      expect(getPermissionsByRole("owner")).not.toContain("loyalty.read");
      expect(getPermissionsByRole("owner")).not.toContain("loyalty.write");
      expect(RESOURCE_KEYS).not.toContain("loyalty");
      expect(SCOPES).not.toContain("loyalty.read");
      expect(SCOPES).not.toContain("loyalty.write");
      expect(mapScopesToPermissions(["apis.read"])).not.toContain("loyalty.read");
      expect(mapScopesToPermissions(["apis.all"])).not.toContain("loyalty.write");

      // Re-registering restores functionality seamlessly
      permissionRegistry.register(WELETIC_PERMISSIONS);
      expect(getPermissionsByRole("owner")).toContain("loyalty.read");
      expect(getPermissionsByRole("owner")).toContain("loyalty.write");
    });
  });

  // =========================================================================
  // SUB-SUITE 2: ADVERSARIAL STRIPE TRANSFER HOOKS & SETTLEMENT ENGINE
  // =========================================================================
  describe("Adversarial Stripe Transfer Hooks & Settlement Engine", () => {
    const mockPartner = {
      id: "part_test_1",
      email: "partner@example.com",
      stripeConnectId: "acct_connect_1",
      payoutsEnabledAt: new Date(),
    };

    const createMockPayout = (
      id: string,
      amount: number,
      currency = "USD",
      invoiceId = "inv_1",
    ) =>
      ({
        id,
        amount,
        currency,
        invoiceId,
        status: "processing",
        method: "connect",
        program: {
          id: "prog_1",
          name: "Test Partner Program",
          logo: null,
          workspaceId: "ws_1",
        },
      }) as any;

    it("verifies TransferHookRegistry fallback behavior when hook is unregistered: totalTransferableAmount - withdrawalFee", async () => {
      // Clear hook registry completely
      transferHookRegistry.clear();

      // Case A: Payout below MIN_WITHDRAWAL_AMOUNT_CENTS (1000) with forceWithdrawal=true
      // This causes Dub core createStripeTransfer to apply BELOW_MIN_WITHDRAWAL_FEE_CENTS (50 cents)
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_sub_1", 500)],
        totalTransferableAmount: 500,
        withdrawalFee: BELOW_MIN_WITHDRAWAL_FEE_CENTS,
        forceWithdrawal: true,
      };

      const hookResult = await executeTransferPreProcessingHook(context);
      expect(hookResult).toBeNull();

      // Setup DB mocks for createStripeTransfer execution
      prismaMocks.partner.findUniqueOrThrow.mockResolvedValue(mockPartner);
      prismaMocks.payout.findMany.mockImplementation(async ({ where }) => {
        if (where?.status === "processing") {
          return [createMockPayout("po_sub_1", 500, "USD", "inv_1")];
        }
        return [];
      });

      // Call createStripeTransfer with unregistered hook
      const transfer = await createStripeTransfer({
        partnerId: mockPartner.id,
        invoiceId: "inv_1",
        forceWithdrawal: true,
      });

      expect(transfer).toBeDefined();
      // Verifies exact fallback calculation: 500 - 50 = 450 cents
      expect(stripeMocks.transfersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 450,
          currency: "usd",
        }),
        expect.any(Object),
      );

      // Case B: Payout above MIN_WITHDRAWAL_AMOUNT_CENTS (1000) -> withdrawalFee = 0
      vi.clearAllMocks();
      prismaMocks.payout.findMany.mockImplementation(async ({ where }) => {
        if (where?.status === "processing") {
          return [createMockPayout("po_above_1", 10000, "USD", "inv_2")];
        }
        return [];
      });

      const transferAbove = await createStripeTransfer({
        partnerId: mockPartner.id,
        invoiceId: "inv_2",
        forceWithdrawal: false,
      });

      expect(transferAbove).toBeDefined();
      // Fallback calculation: 10000 - 0 = 10000 cents
      expect(stripeMocks.transfersCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 10000,
          currency: "usd",
        }),
        expect.any(Object),
      );
    });

    it("verifies lifecycle cleanup: unregistering custom hook restores fallback behavior", async () => {
      transferHookRegistry.clear();

      const unregister = registerTransferPreProcessingHook(async (ctx) => ({
        finalTransferableAmount: 7777,
        settlementCurrency: "usd",
      }));

      // While registered, returns 7777
      let result = await executeTransferPreProcessingHook({
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 10000)],
        totalTransferableAmount: 10000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      });
      expect(result?.finalTransferableAmount).toBe(7777);

      // Unregister
      unregister();

      // Subsequent execution must return null (fallback restored)
      result = await executeTransferPreProcessingHook({
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 10000)],
        totalTransferableAmount: 10000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      });
      expect(result).toBeNull();
    });

    it("adversarially tests settlement hook: strictly rejects non-USD accounting currencies", async () => {
      const nonUsdCurrencies = ["EUR", "JPY", "VND", "GBP", "CAD", "AUD"];

      for (const currency of nonUsdCurrencies) {
        const context: TransferPreProcessingContext = {
          partner: mockPartner,
          allPayouts: [createMockPayout("po_bad_cur", 5000, currency)],
          totalTransferableAmount: 5000,
          withdrawalFee: 0,
          forceWithdrawal: false,
        };

        await expect(weleticSettlementHook(context)).rejects.toThrow(
          "Automatic Stripe settlement currently requires USD accounting payouts.",
        );
      }
    });

    it("strictly rejects non-USD or mixed settled currencies returned by getWeleticPayoutSettlement", async () => {
      // 1. Single non-USD settled currency
      settlementMock.getWeleticPayoutSettlement.mockResolvedValueOnce({
        payoutId: "po_1",
        amount: BigInt(5000),
        currency: "EUR",
        quoteId: "quote_po_1",
      });

      const contextEur: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000, "USD")],
        totalTransferableAmount: 5000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      await expect(weleticSettlementHook(contextEur)).rejects.toThrow(
        "Automatic Stripe settlement is currently limited to USD until cross-border funds flow is certified.",
      );

      // 2. Mixed settled currencies (e.g. payout 1 in USD, payout 2 in JPY)
      settlementMock.getWeleticPayoutSettlement
        .mockResolvedValueOnce({
          payoutId: "po_1",
          amount: BigInt(5000),
          currency: "USD",
          quoteId: "quote_po_1",
        })
        .mockResolvedValueOnce({
          payoutId: "po_2",
          amount: BigInt(5000),
          currency: "JPY",
          quoteId: "quote_po_2",
        });

      const contextMixed: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [
          createMockPayout("po_1", 5000, "USD"),
          createMockPayout("po_2", 5000, "USD"),
        ],
        totalTransferableAmount: 10000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      await expect(weleticSettlementHook(contextMixed)).rejects.toThrow(
        "Automatic Stripe settlement is currently limited to USD until cross-border funds flow is certified.",
      );
    });

    it("strictly verifies withdrawal fee deduction and bounds checks", async () => {
      // 1. Fee deduction from last payout
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [
          createMockPayout("po_1", 5000, "USD"),
          createMockPayout("po_2", 5000, "USD"),
        ],
        totalTransferableAmount: 10000,
        withdrawalFee: 500, // $5.00
        forceWithdrawal: true,
      };

      const result = await weleticSettlementHook(context);
      // Payout 1 ($50) + Payout 2 ($50 - $5 = $45) = $95 (9500 cents)
      expect(result.finalTransferableAmount).toBe(9500);
      expect(result.settlementCurrency).toBe("usd");

      // Verify DB transaction updated quote and statement for last payout
      expect(prismaMocks.weleticPayoutQuote.update).toHaveBeenCalledWith({
        where: { id: "quote_po_2" },
        data: {
          payoutAmount: BigInt(4500),
          feeAmount: { increment: BigInt(500) },
        },
      });

      expect(prismaMocks.weleticPayoutStatement.update).toHaveBeenCalledWith({
        where: { payoutId: "po_2" },
        data: {
          snapshot: {
            payoutAmount: "4500",
            feeAmount: "500",
          },
        },
      });

      // 2. Withdrawal fee equals payout amount (adjustedAmount === 0) -> must throw
      const contextExactExceed: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000, "USD")],
        totalTransferableAmount: 5000,
        withdrawalFee: 5000, // exactly 5000
        forceWithdrawal: true,
      };

      await expect(weleticSettlementHook(contextExactExceed)).rejects.toThrow(
        "The Stripe withdrawal fee exceeds the payout amount.",
      );

      // 3. Withdrawal fee strictly exceeds payout amount (adjustedAmount < 0) -> must throw
      const contextOverExceed: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000, "USD")],
        totalTransferableAmount: 5000,
        withdrawalFee: 5001,
        forceWithdrawal: true,
      };

      await expect(weleticSettlementHook(contextOverExceed)).rejects.toThrow(
        "The Stripe withdrawal fee exceeds the payout amount.",
      );
    });

    it("strictly guards against safe integer overflows in settlement calculation", async () => {
      // Mock settlement amount exceeding Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
      settlementMock.getWeleticPayoutSettlement.mockResolvedValueOnce({
        payoutId: "po_overflow",
        amount: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(100),
        currency: "USD",
        quoteId: "quote_overflow",
      });

      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_overflow", 10000, "USD")],
        totalTransferableAmount: 10000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      await expect(weleticSettlementHook(context)).rejects.toThrow(
        "Stripe settlement amount exceeds the safe integer range.",
      );
    });

    it("verifies failure atomicity: transaction error in settlement hook aborts createStripeTransfer without moving funds", async () => {
      // Simulate database transaction failure during settlement hook fee update
      prismaMocks.$transaction.mockRejectedValueOnce(
        new Error("Deadlock detected during statement snapshot lock"),
      );

      prismaMocks.partner.findUniqueOrThrow.mockResolvedValue(mockPartner);
      // Payout of 500 cents (< 1000) with forceWithdrawal=true triggers fee of 50 cents
      prismaMocks.payout.findMany.mockImplementation(async ({ where }) => {
        if (where?.status === "processing") {
          return [createMockPayout("po_1", 500, "USD", "inv_1")];
        }
        return [];
      });

      settlementMock.getWeleticPayoutSettlement.mockResolvedValueOnce({
        payoutId: "po_1",
        amount: BigInt(500),
        currency: "USD",
        quoteId: "quote_po_1",
      });

      // Execute transfer with fee requiring database transaction update
      await expect(
        createStripeTransfer({
          partnerId: mockPartner.id,
          invoiceId: "inv_1",
          forceWithdrawal: true,
        }),
      ).rejects.toThrow("Deadlock detected during statement snapshot lock");

      // CRITICAL SAFETY ASSERTIONS:
      // 1. Stripe transfer was NEVER initiated
      expect(stripeMocks.transfersCreate).not.toHaveBeenCalled();
      // 2. Payout status was NEVER mutated to 'sent'
      expect(prismaMocks.payout.updateMany).not.toHaveBeenCalled();
      // 3. Commission status was NEVER mutated to 'paid'
      expect(prismaMocks.commission.updateMany).not.toHaveBeenCalled();
    });

    it("verifies non-USD rejection in settlement hook aborts createStripeTransfer without moving funds", async () => {
      prismaMocks.partner.findUniqueOrThrow.mockResolvedValue(mockPartner);
      prismaMocks.payout.findMany.mockImplementation(async ({ where }) => {
        if (where?.status === "processing") {
          return [createMockPayout("po_eur_1", 5000, "EUR", "inv_eur")];
        }
        return [];
      });

      await expect(
        createStripeTransfer({
          partnerId: mockPartner.id,
          invoiceId: "inv_eur",
          forceWithdrawal: false,
        }),
      ).rejects.toThrow(
        "Automatic Stripe settlement currently requires USD accounting payouts.",
      );

      // CRITICAL SAFETY ASSERTIONS:
      expect(stripeMocks.transfersCreate).not.toHaveBeenCalled();
      expect(prismaMocks.payout.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.commission.updateMany).not.toHaveBeenCalled();
    });
  });
});
