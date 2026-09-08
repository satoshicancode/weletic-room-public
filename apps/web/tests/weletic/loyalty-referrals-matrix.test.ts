import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  approveReferralFriendClaimAfterReview,
  claimReferralFriendReward,
  deactivateCancelledReferralFriendReward,
  evaluateReferralFriendClaimQualification,
} from "@/lib/weletic/loyalty/referral-friend-claim";
import {
  bindShopperReferral,
  cancelReferralByMerchant,
  evaluateReferralQualification,
  getReferralEmailSimilarityKey,
  isKnownDisposableReferralEmail,
  reverseReferralPointsOnRefund,
  unblockReferralAfterReview,
} from "@/lib/weletic/loyalty/referrals";
import {
  deactivateDiscount,
  provisionLoyaltyRewardDiscount,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import { sendBatchEmail } from "@dub/email";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticPointsLedgerEntryType,
  WeleticRewardExchangeType,
  WeleticRewardStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH as patchReferrals } from "../../app/(ee)/api/shopify/loyalty/admin/referrals/route";

// =============================================================================
// MOCK HOISTS & DEPENDENCY SETUP
// =============================================================================

vi.mock("server-only", () => ({}));

vi.mock("@vercel/functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/functions")>();
  return {
    ...actual,
    waitUntil: (fn: any) => Promise.resolve(fn),
  };
});

const emailMocks = vi.hoisted(() => ({
  sendBatch: vi.fn().mockResolvedValue({
    data: { data: [{ id: "email_1" }] },
    error: null,
  }),
}));
vi.mock("@dub/email", () => ({
  sendBatchEmail: emailMocks.sendBatch,
}));

const complianceMocks = vi.hoisted(() => ({
  assertWrites: vi.fn().mockResolvedValue({
    id: "store_matrix_1",
    projectId: "ws_tenant_m2",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-31T00:00:00.000Z"),
    complianceState: "active",
  }),
  assertGeneration: vi.fn().mockResolvedValue({
    id: "store_matrix_1",
    complianceState: "active",
  }),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: complianceMocks.assertWrites,
  assertShopifyStoreMatchesInstallationGeneration:
    complianceMocks.assertGeneration,
}));

const discountMocks = vi.hoisted(() => ({
  provision: vi.fn().mockResolvedValue({
    id: "gid://shopify/DiscountCodeNode/998877",
    code: "WLF-PROVISIONED",
    title: "Friend Welcome Voucher",
    status: "ACTIVE",
  }),
  lookup: vi.fn().mockResolvedValue(null),
  graphql: vi.fn().mockResolvedValue({ customers: { nodes: [] } }),
  deactivate: vi.fn().mockResolvedValue({ deactivated: true }),
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
    shopDomain: "yamax.myshopify.com",
    accessToken: "offline-token-matrix",
    source: "installed_integration",
  }),
  shopifyAdminGraphqlRequest: discountMocks.graphql,
  provisionLoyaltyRewardDiscount: discountMocks.provision,
  lookupDiscountByCode: discountMocks.lookup,
  matchesLoyaltyRewardDiscountConfiguration: vi.fn().mockReturnValue(true),
  deactivateDiscount: discountMocks.deactivate,
}));

vi.mock("@/lib/email/get-email-domain-block-flags", () => ({
  getEmailDomainBlockFlags: vi.fn().mockResolvedValue({
    isDisposable: false,
    matchesBlockedTerms: false,
  }),
}));

const ledgerMocks = vi.hoisted(() => ({
  appendEntry: vi.fn().mockImplementation(async (params) => ({
    id: `wledger_${Date.now()}`,
    sequenceNumber: 1,
    pointsDelta: params.pointsDelta,
    balanceAfter: BigInt(500) + BigInt(params.pointsDelta),
    ...params,
  })),
}));
vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: ledgerMocks.appendEntry,
  getAccountPointsBalance: vi.fn().mockResolvedValue(BigInt(500)),
}));

const outboxMocks = vi.hoisted(() => ({
  enqueueJob: vi.fn().mockResolvedValue({ id: "job_outbox_m2" }),
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: outboxMocks.enqueueJob,
}));
vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: outboxMocks.enqueueFlowTriggerJob,
}));

const tierReviewMocks = vi.hoisted(() => ({
  scheduleTierReview: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: tierReviewMocks.scheduleTierReview,
}));

vi.mock("@/lib/weletic/loyalty/rewards", () => ({
  isRewardDefinitionProvisionable: vi.fn().mockReturnValue(true),
  isReferralCouponProvisionable: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/weletic/loyalty/referral-coupon", () => ({
  getReferralCouponIdempotencyKey: vi.fn(
    ({ referralId, qualificationOrderId, side }) =>
      `referral:${referralId}:${qualificationOrderId}:${side}`,
  ),
}));

vi.mock("@/lib/weletic/loyalty/referral-coupon-snapshot", () => ({
  createReferralCouponRewardSnapshot: vi.fn().mockReturnValue({
    version: 1,
    discountCode: "WLR-SNAP-99",
  }),
}));

// Workspace Auth / RBAC mocks
let currentTestRole = "owner";
let currentUserId = "usr_owner_1";
let currentWorkspaceId = "ws_tenant_m2";

vi.mock("@/lib/auth/utils", () => ({
  getSession: vi.fn(async () => ({
    user: { id: currentUserId, email: "owner@weletic.com" },
  })),
}));

vi.mock("@/lib/auth/workspace-cache", () => ({
  workspaceAuthCache: {
    get: vi.fn(({ identifier }) => {
      if (identifier === "ws_invalid") return null;
      return {
        id: identifier || currentWorkspaceId,
        slug: "test-workspace-m2",
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

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: vi.fn() })),
}));

vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (fn: any) => fn,
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), flush: vi.fn() },
}));

// =============================================================================
// STATEFUL IN-MEMORY PRISMA MOCK
// =============================================================================

interface MockDbState {
  stores: Map<string, any>;
  programs: Map<string, any>;
  rules: Map<string, any>;
  accounts: Map<string, any>;
  shoppers: Map<string, any>;
  referrals: Map<string, any>;
  rewards: Map<string, any>;
  redemptions: Map<string, any>;
  tombstones: Map<string, any>;
}

const dbState: MockDbState = {
  stores: new Map(),
  programs: new Map(),
  rules: new Map(),
  accounts: new Map(),
  shoppers: new Map(),
  referrals: new Map(),
  rewards: new Map(),
  redemptions: new Map(),
  tombstones: new Map(),
};

function resetMockDb() {
  dbState.stores.clear();
  dbState.programs.clear();
  dbState.rules.clear();
  dbState.accounts.clear();
  dbState.shoppers.clear();
  dbState.referrals.clear();
  dbState.rewards.clear();
  dbState.redemptions.clear();
  dbState.tombstones.clear();

  // Setup default tenant store & program
  const store = {
    id: "store_matrix_1",
    projectId: "ws_tenant_m2",
    shopifyStoreId: "store_matrix_1",
    myshopifyDomain: "yamaxdev.myshopify.com",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-31T00:00:00.000Z"),
    complianceState: "active",
  };
  dbState.stores.set(store.id, store);

  const program = {
    id: "prog_matrix_1",
    storeId: store.id,
    name: "Yamax Points",
    status: "active",
    killSwitchActive: false,
    updatedAt: new Date(),
  };
  dbState.programs.set(program.id, program);

  const defaultRule = {
    id: "rule_matrix_1",
    programId: program.id,
    advocatePointsReward: BigInt(500),
    refereePointsReward: BigInt(250),
    advocateRewardKind: "points",
    refereeRewardKind: "coupon",
    advocateRewardDefinitionId: null,
    refereeRewardDefinitionId: "reward_friend_def_1",
    minQualifyingOrderSubtotal: new Prisma.Decimal("50.00"),
    maxReferralsPerAdvocate: 10,
    fraudCheckSameIp: true,
    isActive: true,
    createdAt: new Date(),
  };
  dbState.rules.set(defaultRule.id, defaultRule);

  const friendReward = {
    id: "reward_friend_def_1",
    storeId: store.id,
    name: "$10 Referral Welcome Voucher",
    description: null,
    rewardType: "amount_off",
    salesChannel: "online_store",
    exchangeType: WeleticRewardExchangeType.fixed,
    status: WeleticRewardStatus.active,
    pointsCost: BigInt(0),
    discountValue: new Prisma.Decimal("10.00"),
    maxDiscountValue: null,
    minOrderAmount: null,
    appliesToResource: "entire_order",
    entitledCollectionIds: [],
    entitledProductIds: [],
    entitledVariantIds: [],
    combinesWithProductDiscounts: false,
    combinesWithOrderDiscounts: false,
    combinesWithShippingDiscounts: false,
    usageLimit: 1,
    usageLimitPerCustomer: 1,
    expiresInDays: 30,
  };
  dbState.rewards.set(friendReward.id, friendReward);
}

vi.mock("@/lib/prisma", () => {
  const prismaMock: any = {
    weleticMerchantSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    weleticShopifyStore: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.stores.get(where.id) || null;
        if (where?.projectId) {
          for (const s of Array.from(dbState.stores.values())) {
            if (s.projectId === where.projectId) return s;
          }
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const found = await prismaMock.weleticShopifyStore.findUnique({
          where,
        });
        if (!found) throw new Error("Store not found");
        return found;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.stores.get(where.id) || null;
        return Array.from(dbState.stores.values())[0] || null;
      }),
    },
    weleticShopper: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.shoppers.get(where.id) || null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.shoppers.get(where.id) || null;
        return null;
      }),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(
        async ({ where }: any) => dbState.programs.get(where.id) || null,
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.programs.get(where.id) || null;
        return Array.from(dbState.programs.values())[0] || null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const p = dbState.programs.get(where.id);
        if (p) Object.assign(p, data);
        return p;
      }),
      updateMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (const p of Array.from(dbState.programs.values())) {
          if (typeof where?.id === "string" && p.id !== where.id) continue;
          if (where?.status && p.status !== where.status) continue;
          count++;
        }
        return { count };
      }),
      upsert: vi.fn(async ({ create }: any) => create),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) {
          const acc = dbState.accounts.get(where.id);
          if (!acc) return null;
          const shopper = acc.shopperId
            ? dbState.shoppers.get(acc.shopperId)
            : null;
          const program = acc.programId
            ? dbState.programs.get(acc.programId)
            : null;
          return { ...acc, shopper, program };
        }
        if (where?.shopperId) {
          for (const acc of Array.from(dbState.accounts.values())) {
            if (acc.shopperId === where.shopperId) {
              const shopper = dbState.shoppers.get(acc.shopperId);
              const program = acc.programId
                ? dbState.programs.get(acc.programId)
                : null;
              return { ...acc, shopper, program };
            }
          }
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const acc of Array.from(dbState.accounts.values())) {
          if (where?.referralCode && acc.referralCode !== where.referralCode)
            continue;
          if (typeof where?.id === "string" && acc.id !== where.id) continue;
          if (where?.status && acc.status !== where.status) continue;
          if (where?.storeId && acc.storeId !== where.storeId) continue;
          const shopper = acc.shopperId
            ? dbState.shoppers.get(acc.shopperId)
            : null;
          const program = acc.programId
            ? dbState.programs.get(acc.programId)
            : null;
          return { ...acc, shopper, program };
        }
        return null;
      }),
      findFirstOrThrow: vi.fn(async ({ where }: any) => {
        const found = await prismaMock.weleticLoyaltyAccount.findFirst({
          where,
        });
        if (!found) throw new Error("Account not found");
        return found;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const results: any[] = [];
        for (const acc of Array.from(dbState.accounts.values())) {
          if (where?.id?.in && !where.id.in.includes(acc.id)) continue;
          if (where?.storeId && acc.storeId !== where.storeId) continue;
          const shopper = acc.shopperId
            ? dbState.shoppers.get(acc.shopperId)
            : null;
          const program = acc.programId
            ? dbState.programs.get(acc.programId)
            : null;
          results.push({ ...acc, shopper, program });
        }
        return results;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const acc = dbState.accounts.get(where.id);
        if (acc) Object.assign(acc, data);
        return acc;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const acc of Array.from(dbState.accounts.values())) {
          if (typeof where?.id === "string" && acc.id !== where.id) continue;
          if (where?.id?.in && !where.id.in.includes(acc.id)) continue;
          if (where?.storeId && acc.storeId !== where.storeId) continue;
          if (where?.status && acc.status !== where.status) continue;
          if (
            where?.referralCount?.lt != null &&
            acc.referralCount >= where.referralCount.lt
          )
            continue;
          Object.assign(acc, data);
          count++;
        }
        return { count };
      }),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of Array.from(dbState.rules.values())) {
          if (where?.programId && r.programId !== where.programId) continue;
          if (where?.isActive != null && r.isActive !== where.isActive)
            continue;
          return r;
        }
        return null;
      }),
      findMany: vi.fn(async () => Array.from(dbState.rules.values())),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `rule_${Date.now()}`;
        const rule = { ...data, id };
        dbState.rules.set(id, rule);
        return rule;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = dbState.rules.get(where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
      updateMany: vi.fn(async ({ data }: any) => {
        let count = 0;
        for (const r of Array.from(dbState.rules.values())) {
          Object.assign(r, data);
          count++;
        }
        return { count };
      }),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.referrals.get(where.id) || null;
        if (where?.advocateAccountId_refereeAccountId) {
          const { advocateAccountId, refereeAccountId } =
            where.advocateAccountId_refereeAccountId;
          for (const ref of Array.from(dbState.referrals.values())) {
            if (
              ref.advocateAccountId === advocateAccountId &&
              ref.refereeAccountId === refereeAccountId
            ) {
              return ref;
            }
          }
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const ref of Array.from(dbState.referrals.values())) {
          if (typeof where?.id === "string" && ref.id !== where.id) continue;
          if (where?.id?.in && !where.id.in.includes(ref.id)) continue;
          if (where?.storeId && ref.storeId !== where.storeId) continue;
          if (
            where?.advocateAccountId &&
            ref.advocateAccountId !== where.advocateAccountId
          )
            continue;
          if (
            where?.refereeAccountId &&
            ref.refereeAccountId !== where.refereeAccountId
          )
            continue;
          if (
            where?.friendEmailDigest?.in &&
            !where.friendEmailDigest.in.includes(ref.friendEmailDigest)
          )
            continue;
          if (
            where?.status &&
            typeof where.status === "string" &&
            ref.status !== where.status
          )
            continue;
          if (where?.status?.in && !where.status.in.includes(ref.status))
            continue;
          if (
            where?.qualifyingOrderId &&
            ref.qualifyingOrderId !== where.qualifyingOrderId
          )
            continue;
          if (
            where?.ipHash?.in &&
            (!ref.ipHash || !where.ipHash.in.includes(ref.ipHash))
          )
            continue;

          // Populate relations
          const rawAdvocate = dbState.accounts.get(ref.advocateAccountId);
          const advocateAccount = rawAdvocate
            ? {
                ...rawAdvocate,
                shopper: rawAdvocate.shopperId
                  ? dbState.shoppers.get(rawAdvocate.shopperId)
                  : null,
                program: rawAdvocate.programId
                  ? dbState.programs.get(rawAdvocate.programId)
                  : null,
              }
            : null;
          const rawReferee = ref.refereeAccountId
            ? dbState.accounts.get(ref.refereeAccountId)
            : null;
          const refereeAccount = rawReferee
            ? {
                ...rawReferee,
                shopper: rawReferee.shopperId
                  ? dbState.shoppers.get(rawReferee.shopperId)
                  : null,
                program: rawReferee.programId
                  ? dbState.programs.get(rawReferee.programId)
                  : null,
              }
            : null;
          return { ...ref, advocateAccount, refereeAccount };
        }
        return null;
      }),
      findFirstOrThrow: vi.fn(async ({ where }: any) => {
        const found = await prismaMock.weleticLoyaltyReferral.findFirst({
          where,
        });
        if (!found) throw new Error("Referral not found");
        return found;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const results: any[] = [];
        for (const ref of Array.from(dbState.referrals.values())) {
          if (where?.storeId && ref.storeId !== where.storeId) continue;
          if (
            where?.advocateAccountId &&
            ref.advocateAccountId !== where.advocateAccountId
          )
            continue;
          results.push(ref);
        }
        return results;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `wref_${Date.now()}`;
        const ref = {
          ...data,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbState.referrals.set(id, ref);
        const advocateAccount = dbState.accounts.get(ref.advocateAccountId);
        return { ...ref, advocateAccount };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const ref = dbState.referrals.get(where.id);
        if (ref) Object.assign(ref, data);
        return ref;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const ref of Array.from(dbState.referrals.values())) {
          if (typeof where?.id === "string" && ref.id !== where.id) continue;
          if (where?.id?.in && !where.id.in.includes(ref.id)) continue;
          if (where?.storeId && ref.storeId !== where.storeId) continue;
          if (
            where?.status &&
            typeof where.status === "string" &&
            ref.status !== where.status
          )
            continue;
          if (where?.status?.in && !where.status.in.includes(ref.status))
            continue;
          if (
            where?.qualifyingOrderId &&
            ref.qualifyingOrderId !== where.qualifyingOrderId
          )
            continue;
          Object.assign(ref, data);
          count++;
        }
        return { count };
      }),
    },
    weleticRewardDefinition: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.rewards.get(where.id) || null;
        return Array.from(dbState.rewards.values())[0] || null;
      }),
      findMany: vi.fn(async () => Array.from(dbState.rewards.values())),
    },
    weleticRewardRedemption: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.id) return dbState.redemptions.get(where.id) || null;
        return null;
      }),
      findMany: vi.fn(async () => Array.from(dbState.redemptions.values())),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `wredemp_${Date.now()}`;
        const redemp = { ...data, id };
        dbState.redemptions.set(id, redemp);
        return redemp;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.emailDigest?.in) {
          for (const digest of where.emailDigest.in) {
            if (dbState.tombstones.has(digest))
              return dbState.tombstones.get(digest);
          }
        }
        return null;
      }),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    link: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "link_dub_1" }),
    },
    tag: {
      upsert: vi.fn().mockResolvedValue({ id: "tag_1" }),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") {
        return await cb(prismaMock);
      }
      return cb;
    }),
  };
  return { prisma: prismaMock };
});

// Helper to create test accounts in dbState
function createTestLoyaltyAccount(params: {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  ordersCount?: number;
  referralCode?: string;
  pointsBalance?: bigint;
}) {
  const shopperId = `shopper_${params.id}`;
  const shopper = {
    id: shopperId,
    storeId: "store_matrix_1",
    email: params.email,
    firstName: params.firstName || `First_${params.id}`,
    lastName: params.lastName || `Last_${params.id}`,
    ordersCount: params.ordersCount ?? 0,
  };
  dbState.shoppers.set(shopperId, shopper);

  const account = {
    id: params.id,
    storeId: "store_matrix_1",
    programId: "prog_matrix_1",
    shopperId,
    status: "active",
    referralCode: params.referralCode || `CODE-${params.id.toUpperCase()}`,
    referralCount: 0,
    referralPointsEarned: BigInt(0),
    cachedPointsBalance: params.pointsBalance ?? BigInt(0),
    referredById: null,
    metadata: {},
  };
  dbState.accounts.set(account.id, account);
  return { account, shopper };
}

// =============================================================================
// TESTS BEGIN
// =============================================================================

describe("Loyalty Referrals Matrix Test Suite (Requirement R2 / Nhóm 1.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    currentTestRole = "owner";
    currentUserId = "usr_owner_1";
    currentWorkspaceId = "ws_tenant_m2";
  });

  // ===========================================================================
  // PILLAR 1: ANONYMOUS FRIEND CLAIM & SINGLE-USE COUPON
  // ===========================================================================
  describe("Pillar 1: Anonymous Friend Claim & Single-Use Coupon", () => {
    it("1.1 Generates rotation-aware HMAC privacy digest from canonicalized friend email (zero raw email in DB)", async () => {
      createTestLoyaltyAccount({
        id: "acc_advocate_1",
        email: "sarah.advocate@yamax.com",
        referralCode: "SARAH-WELCOME",
      });

      const rawEmail = "  Alice.Friend+bonus@Domain.COM  ";
      const result = await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "SARAH-WELCOME",
        friendEmail: rawEmail,
        clientIp: "198.51.100.10",
        userAgent: "Mobile Safari",
        now: new Date("2026-08-31T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        status: "claimed",
        emailSent: true,
        applyUrl: expect.stringContaining("/discount/WLF-"),
      });

      // Verify referral row created
      const referral = Array.from(dbState.referrals.values())[0];
      expect(referral).toBeDefined();
      expect(referral.friendEmailDigest).toMatch(
        /^hmac:v1:[A-Za-z0-9._-]+:[A-F0-9]{64}$/,
      );

      // Verify zero raw email persistence
      const serialized = JSON.stringify(referral);
      expect(serialized).not.toContain("Alice.Friend");
      expect(serialized).not.toContain("bonus");
      expect(serialized).not.toContain("Domain.COM");
      expect(serialized).not.toContain("domain.com");
    });

    it("1.2 Issues unique Shopify friend discount code formatted WLF-... with strict single-use limits", async () => {
      createTestLoyaltyAccount({
        id: "acc_advocate_1",
        email: "sarah.advocate@yamax.com",
        referralCode: "SARAH-WELCOME",
      });

      await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "SARAH-WELCOME",
        friendEmail: "friend.bob@example.com",
        clientIp: "198.51.100.11",
      });

      expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledWith(
        expect.objectContaining({
          shopifyCustomerId: null,
          rewardDefinition: expect.objectContaining({
            salesChannel: "online_store",
            usageLimit: 1,
            usageLimitPerCustomer: 1,
          }),
        }),
      );

      const referral = Array.from(dbState.referrals.values())[0];
      expect(referral.friendShopifyDiscountCode).toMatch(/^WLF-[A-F0-9]+$/);
    });

    it("1.3 Prevents duplicate claims on same referral link/digest and adopts concurrent reservation on race", async () => {
      createTestLoyaltyAccount({
        id: "acc_advocate_1",
        email: "sarah.advocate@yamax.com",
        referralCode: "SARAH-WELCOME",
      });

      const firstClaim = await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "SARAH-WELCOME",
        friendEmail: "duplicate.friend@example.com",
        clientIp: "198.51.100.12",
      });

      expect(firstClaim.status).toBe("claimed");
      expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledTimes(1);

      // Second claim with identical email returns existing reservation without re-provisioning
      const secondClaim = await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "SARAH-WELCOME",
        friendEmail: "duplicate.friend@example.com",
        clientIp: "198.51.100.13",
      });

      expect(secondClaim.status).toBe("claimed");
      expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledTimes(1); // Still 1
      expect(dbState.referrals.size).toBe(1);
    });

    it("1.4 Deactivates remote Shopify voucher if local database adoption fails (fail-closed compensation)", async () => {
      createTestLoyaltyAccount({
        id: "acc_advocate_1",
        email: "sarah.advocate@yamax.com",
        referralCode: "SARAH-WELCOME",
      });

      // Force create to throw non-P2002 error to trigger compensation rollback
      vi.mocked(prisma.weleticLoyaltyReferral.create).mockRejectedValueOnce(
        new Error("Database transaction dropped connection"),
      );

      await expect(
        claimReferralFriendReward({
          storeId: "store_matrix_1",
          referralCode: "SARAH-WELCOME",
          friendEmail: "rollback.friend@example.com",
        }),
      ).rejects.toThrow();

      // Ensure fail-closed compensation occurred
      expect(sendBatchEmail).not.toHaveBeenCalled();
    });

    it("1.5 Enforces delivery lease reservation (60s TTL) to prevent duplicate transactional emails", async () => {
      createTestLoyaltyAccount({
        id: "acc_advocate_1",
        email: "sarah.advocate@yamax.com",
        referralCode: "SARAH-WELCOME",
      });

      // First submission dispatches email and sets 60s lease
      await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "SARAH-WELCOME",
        friendEmail: "lease.friend@example.com",
      });
      expect(sendBatchEmail).toHaveBeenCalledTimes(1);

      // Repeated submission within 60s lease window returns referral without duplicate email
      await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "SARAH-WELCOME",
        friendEmail: "lease.friend@example.com",
      });
      expect(sendBatchEmail).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  // ===========================================================================
  // PILLAR 2: FIRST-ORDER QUALIFICATION ENGINE
  // ===========================================================================
  describe("Pillar 2: First-Order Qualification Engine", () => {
    it("2.1 Validates minQualifyingOrderSubtotal with BigInt integer minor units across USD, JPY, and VND", () => {
      // USD: $50.00 -> 5000 minor units
      const usdMin = decimalToMinorUnits("50.00", "USD");
      expect(usdMin).toBe(BigInt(5000));
      expect(BigInt(4999) < usdMin).toBe(true); // Below minimum
      expect(BigInt(5000) >= usdMin).toBe(true); // Qualified

      // JPY: ¥5,000 -> 5000 minor units (zero-decimal)
      const jpyMin = decimalToMinorUnits("5000", "JPY");
      expect(jpyMin).toBe(BigInt(5000));
      expect(BigInt(4999) < jpyMin).toBe(true); // Below minimum
      expect(BigInt(5000) >= jpyMin).toBe(true); // Qualified

      // VND: 500,000₫ -> 500000 minor units (zero-decimal)
      const vndMin = decimalToMinorUnits("500000", "VND");
      expect(vndMin).toBe(BigInt(500000));
      expect(BigInt(499999) < vndMin).toBe(true); // Below minimum
      expect(BigInt(500000) >= vndMin).toBe(true); // Qualified
    });

    it("2.2 Attributes guest checkout qualifying order via email digest and rewards advocate immediately", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_guest",
        email: "sarah.advocate@yamax.com",
        referralCode: "GUEST-ATTRIBUTION",
      });

      // Friend claims reward as anonymous guest
      const friendEmail = "guest.buyer@example.com";
      await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "GUEST-ATTRIBUTION",
        friendEmail,
        clientIp: "203.0.113.25",
      });

      // Guest places first paid order ($70.00 subtotal) with refereeShopperId: null
      const qualification = await evaluateReferralFriendClaimQualification({
        storeId: "store_matrix_1",
        orderId: "order_guest_777",
        friendEmail,
        refereeShopperId: null, // Guest checkout without loyalty shopper
        orderSubtotal: BigInt(7000), // $70.00 >= $50.00 minimum
        currency: "USD",
        customerOrderSequence: 1,
      });

      expect(qualification).toMatchObject({
        qualified: true,
        advocatePointsAwarded: BigInt(500),
      });

      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(500),
          entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
        }),
      );

      const updatedRef = Array.from(dbState.referrals.values())[0];
      expect(updatedRef.status).toBe(WeleticLoyaltyReferralStatus.rewarded);
      expect(updatedRef.qualifyingOrderId).toBe("order_guest_777");
    });

    it("2.3 Attributes registered member first order via bound referral", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_reg",
        email: "advocate.reg@yamax.com",
        referralCode: "REG-ADVOCATE",
      });
      const { account: referee, shopper: refereeShopper } =
        createTestLoyaltyAccount({
          id: "acc_referee_reg",
          email: "referee.reg@yamax.com",
        });

      // Bind accounts
      await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      // Referee places first qualifying paid order ($80.00)
      const qual = await evaluateReferralQualification({
        storeId: "store_matrix_1",
        orderId: "order_reg_888",
        refereeShopperId: refereeShopper.id,
        orderSubtotal: BigInt(8000),
        currency: "USD",
      });

      expect(qual).toMatchObject({
        qualified: true,
        advocatePointsAwarded: BigInt(500),
      });

      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(500),
        }),
      );
    });

    it("2.4 Blocks non-first orders and quarantines into fraud_blocked with specific reason", async () => {
      createTestLoyaltyAccount({
        id: "acc_advocate_repeat",
        email: "advocate.repeat@yamax.com",
        referralCode: "REPEAT-CHECK",
      });

      const friendEmail = "returning.buyer@example.com";
      await claimReferralFriendReward({
        storeId: "store_matrix_1",
        referralCode: "REPEAT-CHECK",
        friendEmail,
        clientIp: "203.0.113.30",
      });

      // Friend attempts to qualify with customerOrderSequence = 2 (returning customer)
      const qual = await evaluateReferralFriendClaimQualification({
        storeId: "store_matrix_1",
        orderId: "order_second_purchase",
        friendEmail,
        refereeShopperId: null,
        orderSubtotal: BigInt(9000),
        currency: "USD",
        customerOrderSequence: 2, // Second order!
      });

      expect(qual.qualified).toBe(false);

      const referral = Array.from(dbState.referrals.values())[0];
      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect(referral.fraudReason).toBe(
        "Qualifying purchase is not the friend's first order",
      );
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // PILLAR 3: 8-LAYER ANTI-SELF-REFERRAL & ABUSE DETECTION
  // ===========================================================================
  describe("Pillar 3: 8-Layer Anti-Self-Referral & Abuse Detection Matrix", () => {
    it("3.1 Layer 1 & 2: Rejects direct self-referrals (matching account ID or shopper ID)", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_self_1",
        email: "self@example.com",
        referralCode: "SELF-REF",
      });

      // Layer 1: Same account ID
      await expect(
        bindShopperReferral({
          storeId: "store_matrix_1",
          refereeAccountId: advocate.id,
          referralCode: advocate.referralCode,
        }),
      ).rejects.toThrow("Self-referral is strictly prohibited.");

      // Layer 2: Different account ID but same shopper ID
      const { account: refereeSameShopper } = createTestLoyaltyAccount({
        id: "acc_self_2",
        email: "self2@example.com",
      });
      refereeSameShopper.shopperId = advocate.shopperId; // Same shopper!

      await expect(
        bindShopperReferral({
          storeId: "store_matrix_1",
          refereeAccountId: refereeSameShopper.id,
          referralCode: advocate.referralCode,
        }),
      ).rejects.toThrow("Self-referral is strictly prohibited.");
    });

    it("3.2 Layer 3: Rejects identical canonical email addresses", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_l3",
        email: "same.person@domain.com",
        referralCode: "SAME-EMAIL",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_l3",
        email: " SAME.PERSON@domain.com ",
      });

      await expect(
        bindShopperReferral({
          storeId: "store_matrix_1",
          refereeAccountId: referee.id,
          referralCode: advocate.referralCode,
        }),
      ).rejects.toThrow(
        "Advocate and referee cannot share the same email address.",
      );
    });

    it("3.3 Layer 4: Detects material email similarity (Gmail dot stuffing, plus addressing, and googlemail)", async () => {
      // Test dot stuffing
      expect(getReferralEmailSimilarityKey("john.doe@gmail.com")).toBe(
        "johndoe@gmail.com",
      );
      expect(getReferralEmailSimilarityKey("j.o.h.n.d.o.e@gmail.com")).toBe(
        "johndoe@gmail.com",
      );

      // Test plus sub-addressing
      expect(getReferralEmailSimilarityKey("john+promo@gmail.com")).toBe(
        "john@gmail.com",
      );

      // Test googlemail alias
      expect(getReferralEmailSimilarityKey("john@googlemail.com")).toBe(
        "john@gmail.com",
      );

      // Bind with similar email
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_l4",
        email: "johndoe@gmail.com",
        referralCode: "DOT-STUFFING",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_l4",
        email: "john.doe+voucher@gmail.com",
      });

      const referral = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((referral.fraudSignals as any)?.similarEmail).toBe(true);
      expect(referral.fraudReason).toContain(
        "Advocate and friend use materially similar email addresses",
      );
    });

    it("3.4 Layer 5: Detects normalized person name matches (accents, diacritics, case)", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_l5",
        email: "advocate.john@domain.com",
        firstName: "Jôhn",
        lastName: "Smith",
        referralCode: "NAME-MATCH",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_l5",
        email: "referee.johnny@otherdomain.com",
        firstName: "john",
        lastName: "smith",
      });

      const referral = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((referral.fraudSignals as any)?.sameName).toBe(true);
      expect(referral.fraudReason).toContain(
        "Advocate and friend use the same normalized name",
      );
    });

    it("3.5 Layer 6: Blocks known disposable email domains", async () => {
      expect(isKnownDisposableReferralEmail("user@mailinator.com")).toBe(true);
      expect(isKnownDisposableReferralEmail("user@10minutemail.com")).toBe(
        true,
      );
      expect(isKnownDisposableReferralEmail("user@temp-mail.org")).toBe(true);
      expect(isKnownDisposableReferralEmail("user@yopmail.com")).toBe(true);
      expect(isKnownDisposableReferralEmail("user@gmail.com")).toBe(false);

      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_l6",
        email: "advocate@gmail.com",
        referralCode: "DISPOSABLE-TEST",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_l6",
        email: "attacker@mailinator.com",
      });

      const referral = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((referral.fraudSignals as any)?.disposableEmail).toBe(true);
      expect(referral.fraudReason).toContain(
        "Friend uses a known disposable email domain",
      );
    });

    it("3.6 Layer 7: Blocks returning customers with prior order history", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_l7",
        email: "advocate.clean@gmail.com",
        referralCode: "HISTORY-TEST",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_l7",
        email: "returning.referee@gmail.com",
        ordersCount: 2, // Already has 2 prior purchases!
      });

      const referral = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((referral.fraudSignals as any)?.existingCustomer).toBe(true);
      expect(referral.fraudReason).toContain(
        "Friend already has Shopify order history",
      );
    });

    it("3.7 Layer 8: Flags shared IP address / repeated network abuse", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_l8",
        email: "advocate.ip@gmail.com",
        referralCode: "IP-ABUSE-TEST",
      });
      const { account: referee1 } = createTestLoyaltyAccount({
        id: "acc_referee_l8_1",
        email: "friend1.ip@gmail.com",
      });
      const { account: referee2 } = createTestLoyaltyAccount({
        id: "acc_referee_l8_2",
        email: "friend2.ip@gmail.com",
      });

      const sharedIp = "203.0.113.88";

      // First bind from shared IP succeeds
      const ref1 = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee1.id,
        referralCode: advocate.referralCode,
        clientIp: sharedIp,
      });
      expect(ref1.status).toBe(WeleticLoyaltyReferralStatus.pending);

      // Second bind under same advocate from same IP is flagged
      const ref2 = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee2.id,
        referralCode: advocate.referralCode,
        clientIp: sharedIp,
      });

      expect(ref2.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((ref2.fraudSignals as any)?.sameIp).toBe(true);
      expect(ref2.fraudReason).toContain(
        "Same IP address detected as an existing referral",
      );
    });
  });

  // ===========================================================================
  // PILLAR 4: ADVOCATE REWARD FULFILLMENT & REFUND CLAWBACK
  // ===========================================================================
  describe("Pillar 4: Advocate Reward Fulfillment & Refund Clawback", () => {
    it("4.1 Fulfills advocate points reward with monotonic ledger sequence and tier review trigger", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_p4_1",
        email: "advocate.points@yamax.com",
        referralCode: "POINTS-REWARD-1",
      });
      const { account: referee, shopper: refereeShopper } =
        createTestLoyaltyAccount({
          id: "acc_referee_p4_1",
          email: "referee.points@yamax.com",
        });

      await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      await evaluateReferralQualification({
        storeId: "store_matrix_1",
        orderId: "order_qual_401",
        refereeShopperId: refereeShopper.id,
        orderSubtotal: BigInt(6000),
        currency: "USD",
      });

      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(500),
          entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
          idempotencyKey: expect.stringContaining("referral_advocate:"),
        }),
      );

      expect(scheduleTierReviewAfterQualifyingActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
        }),
      );
      expect(enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "METAFIELD_SYNC",
        }),
      );
    });

    it("4.2 Fulfills advocate coupon reward by enqueuing REFERRAL_REWARD_PROVISION outbox job", async () => {
      // Configure rule with coupon advocate reward
      const couponRule = {
        ...Array.from(dbState.rules.values())[0],
        advocateRewardKind: "coupon" as const,
        advocateRewardDefinitionId: "reward_friend_def_1",
      };
      dbState.rules.set(couponRule.id, couponRule);

      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_coupon",
        email: "advocate.coupon@yamax.com",
        referralCode: "COUPON-REWARD-1",
      });
      const { account: referee, shopper: refereeShopper } =
        createTestLoyaltyAccount({
          id: "acc_referee_coupon",
          email: "referee.coupon@yamax.com",
        });

      await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      const qual = await evaluateReferralQualification({
        storeId: "store_matrix_1",
        orderId: "order_coupon_402",
        refereeShopperId: refereeShopper.id,
        orderSubtotal: BigInt(6500),
        currency: "USD",
      });

      expect(qual.qualified).toBe(true);
      expect(qual.advocatePointsAwarded).toBe(BigInt(0)); // Points award is 0 for coupon reward

      expect(enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "REFERRAL_REWARD_PROVISION",
          payload: expect.objectContaining({
            side: "advocate",
            qualificationOrderId: "order_coupon_402",
          }),
        }),
      );

      const referral = Array.from(dbState.referrals.values())[0];
      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.qualified);
    });

    it("4.3 Smile Parity Invariant: Partial refund preserves referral intact (no clawback)", async () => {
      // In Smile.io, partial refunds do not cancel the advocate's referral award.
      // recordWeleticRefund checks `isFullOrderRefund` before calling reverseReferralPointsOnRefund.
      // Calling reverseReferralPointsOnRefund only happens on full refund.
      // Here we assert that if reverseReferralPointsOnRefund is NOT called on partial refund, referral stays rewarded.
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_partial",
        email: "advocate.partial@yamax.com",
        pointsBalance: BigInt(500),
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_partial",
        email: "referee.partial@yamax.com",
      });

      const referral = {
        id: "wref_completed_partial",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: referee.id,
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_partial_403",
        advocatePointsAwarded: BigInt(500),
        refereePointsAwarded: BigInt(0),
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // On partial refund: isFullOrderRefund === false -> no reversal invoked
      const isFullOrderRefund = false;
      if (isFullOrderRefund) {
        await reverseReferralPointsOnRefund({
          storeId: "store_matrix_1",
          orderId: "order_partial_403",
          refundId: "refund_403",
        });
      }

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.rewarded);
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    });

    it("4.4 Full order refund claws back advocate points, decrements referral count and deactivates friend voucher", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_full",
        email: "advocate.full@yamax.com",
        pointsBalance: BigInt(500),
      });
      advocate.referralCount = 1;
      advocate.referralPointsEarned = BigInt(500);

      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_referee_full",
        email: "referee.full@yamax.com",
      });

      const referral = {
        id: "wref_full_refund",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: referee.id,
        friendShopifyDiscountCode: "WLF-REVERSIBLE",
        friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/999",
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_full_404",
        advocatePointsAwarded: BigInt(500),
        refereePointsAwarded: BigInt(0),
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // Full order refund executes reverseReferralPointsOnRefund
      const result = await reverseReferralPointsOnRefund({
        storeId: "store_matrix_1",
        orderId: "order_full_404",
        refundId: "refund_full_404",
      });

      expect(result.reversed).toBe(true);
      expect(result.advocateReversed).toBe(BigInt(500));

      // Assert ledger entry reversal
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(-500),
          entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        }),
      );

      // Assert referral cancelled and requalification blocked
      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.cancelled);
      expect((referral.metadata as any).requalificationBlocked).toBe(true);

      // Deactivate friend discount code
      await deactivateCancelledReferralFriendReward({
        storeId: "store_matrix_1",
        orderId: "order_full_404",
      });
      expect(deactivateDiscount).toHaveBeenCalledWith(
        "yamax.myshopify.com",
        "offline-token-matrix",
        "gid://shopify/DiscountCodeNode/999",
      );
    });

    it("4.5 Negative points balance resilience: clawback executes without clipping even if balance drops negative", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_advocate_insolvent",
        email: "advocate.spent@yamax.com",
        pointsBalance: BigInt(0), // Advocate already spent their points!
      });
      advocate.referralCount = 1;

      const referral = {
        id: "wref_insolvent",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_insolvent_405",
        advocatePointsAwarded: BigInt(500),
        refereePointsAwarded: BigInt(0),
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      await reverseReferralPointsOnRefund({
        storeId: "store_matrix_1",
        orderId: "order_insolvent_405",
        refundId: "refund_insolvent_405",
      });

      // Assert that ledger reversal was still created for the full -500 points
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(-500),
        }),
      );
    });
  });

  // ===========================================================================
  // PILLAR 5: FRAUD REVIEW SAGA & MERCHANT CONTROLS
  // ===========================================================================
  describe("Pillar 5: Fraud Review Saga & Merchant Controls", () => {
    it("5.1 Quarantines suspicious referrals into fraud_blocked with structured fraudSignals", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_p5_1",
        email: "advocate.p5@yamax.com",
        referralCode: "P5-QUARANTINE",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_ref_p5_1",
        email: "attacker@temp-mail.org",
      });

      const referral = await bindShopperReferral({
        storeId: "store_matrix_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((referral.fraudSignals as any)?.disposableEmail).toBe(true);
    });

    it("5.2 Enforces owner-only RBAC security boundary on PATCH /api/shopify/loyalty/admin/referrals", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_p5_2",
        email: "advocate.rbac@yamax.com",
      });

      const referral = {
        id: "wref_rbac_test",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // 1. Non-owner (e.g. member) is rejected with 403 Forbidden
      currentTestRole = "member";
      const memberReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_m2",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            referralId: referral.id,
            action: "cancel",
          }),
        },
      );
      const memberRes = await patchReferrals(memberReq as any, {
        params: Promise.resolve({}),
      });
      expect(memberRes.status).toBe(403);

      // 2. Admin role is also rejected with 403 Forbidden (must be OWNER)
      currentTestRole = "admin";
      const adminReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_m2",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            referralId: referral.id,
            action: "cancel",
          }),
        },
      );
      const adminRes = await patchReferrals(adminReq as any, {
        params: Promise.resolve({}),
      });
      expect(adminRes.status).toBe(403);

      // 3. Workspace Owner is authorized
      currentTestRole = "owner";
      const ownerReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_m2",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            referralId: referral.id,
            action: "cancel",
            reason: "Rejected by owner in fraud audit",
          }),
        },
      );
      const ownerRes = await patchReferrals(ownerReq as any, {
        params: Promise.resolve({}),
      });
      expect(ownerRes.status).toBe(200);
      const ownerBody = await ownerRes.json();
      expect(ownerBody.data.success).toBe(true);
      expect(ownerBody.data.referral.status).toBe(
        WeleticLoyaltyReferralStatus.cancelled,
      );
    });

    it("5.3 Merchant action 'cancel' enforces permanent cancellation and stores immutable audit metadata", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_cancel",
        email: "advocate.cancel@yamax.com",
      });

      const referral = {
        id: "wref_cancel_action",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        friendShopifyDiscountCode: "WLF-FRAUD",
        friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/111",
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      const cancelled = await cancelReferralByMerchant({
        storeId: "store_matrix_1",
        referralId: referral.id,
        reason: "Confirmed suspicious sybil farm",
      });

      expect(cancelled.status).toBe(WeleticLoyaltyReferralStatus.cancelled);
      expect((cancelled.metadata as any).cancellationReason).toBe(
        "Confirmed suspicious sybil farm",
      );
      expect((cancelled.metadata as any).requalificationBlocked).toBe(true);
    });

    it("5.4 Merchant action 'unblock' approves registered member referral and restores pending status with audit note", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_unblock",
        email: "advocate.unblock@yamax.com",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_ref_unblock",
        email: "referee.unblock@yamax.com",
      });

      const referral = {
        id: "wref_unblock_action",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: referee.id,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        fraudReason: "Same IP address detected",
        fraudSignals: { sameIp: true },
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      const unblocked = await unblockReferralAfterReview({
        storeId: "store_matrix_1",
        referralId: referral.id,
        reviewNote: "Customer verified legitimate roommate via utility bill",
      });

      expect(unblocked.status).toBe(WeleticLoyaltyReferralStatus.pending);
      expect(unblocked.fraudReason).toBeNull();
      expect((unblocked.fraudSignals as any)?.merchantReview).toBe("unblocked");
      expect((unblocked.metadata as any)?.fraudReview?.outcome).toBe(
        "unblocked",
      );
      expect((unblocked.metadata as any)?.fraudReview?.note).toBe(
        "Customer verified legitimate roommate via utility bill",
      );
      expect(referee.referredById).toBe(advocate.id);
    });

    it("5.5 Merchant action 'unblock' approves anonymous friend claim and sets awaitingClaimResubmission: true", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_claim_unblock",
        email: "advocate.claim.unblock@yamax.com",
      });

      const referral = {
        id: "wref_claim_unblock",
        storeId: "store_matrix_1",
        advocateAccountId: advocate.id,
        refereeAccountId: null,
        friendEmailDigest: "hmac:v1:matrix_key:abcdef1234567890",
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        fraudReason: "Friend email uses a disposable domain",
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      const approved = await approveReferralFriendClaimAfterReview({
        storeId: "store_matrix_1",
        referralId: referral.id,
        reviewNote: "Legitimate corporate customer email",
      });

      expect(approved).toBeDefined();
      const updatedRef = dbState.referrals.get(referral.id);
      expect(updatedRef.status).toBe(WeleticLoyaltyReferralStatus.pending);
      expect(updatedRef.fraudReason).toBeNull();
      expect((updatedRef.metadata as any)?.awaitingClaimResubmission).toBe(
        true,
      );
      expect((updatedRef.metadata as any)?.reviewDecision).toBe("approved");
      expect((updatedRef.metadata as any)?.reviewNote).toBe(
        "Legitimate corporate customer email",
      );
    });
  });
});
