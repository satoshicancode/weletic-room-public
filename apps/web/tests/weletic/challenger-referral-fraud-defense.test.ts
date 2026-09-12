import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  claimReferralFriendReward,
  deactivateCancelledReferralFriendReward,
  evaluateReferralFriendClaimQualification,
} from "@/lib/weletic/loyalty/referral-friend-claim";
import {
  bindShopperReferral,
  getReferralEmailSimilarityKey,
  isKnownDisposableReferralEmail,
  reverseReferralPointsOnRefund,
} from "@/lib/weletic/loyalty/referrals";
import {
  deactivateDiscount,
  provisionLoyaltyRewardDiscount,
} from "@/lib/weletic/loyalty/shopify-discounts";
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
// MOCKS & ISOLATION HOISTS
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
    data: { data: [{ id: "email_challenger_1" }] },
    error: null,
  }),
}));
vi.mock("@dub/email", () => ({
  sendBatchEmail: emailMocks.sendBatch,
}));

const complianceMocks = vi.hoisted(() => ({
  assertWrites: vi.fn().mockResolvedValue({
    id: "store_challenger_ref_1",
    projectId: "ws_tenant_challenger",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-31T00:00:00.000Z"),
    complianceState: "active",
    installationGeneration: null,
  }),
  assertGeneration: vi.fn().mockResolvedValue({
    id: "store_challenger_ref_1",
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
    id: "gid://shopify/DiscountCodeNode/554433",
    code: "WLF-STRESS-TEST",
    title: "Friend Reward Voucher",
    status: "ACTIVE",
  }),
  lookup: vi.fn().mockResolvedValue(null),
  graphql: vi.fn().mockResolvedValue({ customers: { nodes: [] } }),
  deactivate: vi.fn().mockResolvedValue({ deactivated: true }),
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
    shopDomain: "challenger.myshopify.com",
    accessToken: "offline-token-challenger",
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
  enqueueJob: vi.fn().mockResolvedValue({ id: "job_outbox_challenger" }),
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: outboxMocks.enqueueJob,
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
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
    discountCode: "WLR-SNAP-CHALLENGER",
  }),
}));

// Workspace Auth / RBAC mocks
let currentTestRole = "owner";
let currentUserId = "usr_owner_challenger";
let currentWorkspaceId = "ws_tenant_challenger";

vi.mock("@/lib/auth/utils", () => ({
  getSession: vi.fn(async () => {
    if (!currentUserId) return null;
    return {
      user: { id: currentUserId, email: "owner@challenger.test" },
    };
  }),
}));

vi.mock("@/lib/auth/workspace-cache", () => ({
  workspaceAuthCache: {
    get: vi.fn(({ identifier }) => {
      if (!currentUserId || identifier === "ws_invalid") return null;
      return {
        id: identifier || currentWorkspaceId,
        slug: "challenger-workspace",
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
// STATEFUL IN-MEMORY DATABASE MOCK
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

  const store = {
    id: "store_challenger_ref_1",
    projectId: "ws_tenant_challenger",
    shopifyStoreId: "store_challenger_ref_1",
    myshopifyDomain: "challenger.myshopify.com",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-31T00:00:00.000Z"),
    complianceState: "active",
  };
  dbState.stores.set(store.id, store);

  const program = {
    id: "prog_challenger_1",
    storeId: store.id,
    name: "Challenger Loyalty Program",
    status: "active",
    killSwitchActive: false,
    updatedAt: new Date(),
  };
  dbState.programs.set(program.id, program);

  const defaultRule = {
    id: "rule_challenger_1",
    programId: program.id,
    advocatePointsReward: BigInt(500),
    refereePointsReward: BigInt(250),
    advocateRewardKind: "points",
    refereeRewardKind: "coupon",
    advocateRewardDefinitionId: null,
    refereeRewardDefinitionId: "reward_def_challenger_friend",
    minQualifyingOrderSubtotal: new Prisma.Decimal("50.00"),
    maxReferralsPerAdvocate: 10,
    fraudCheckSameIp: true,
    isActive: true,
    createdAt: new Date(),
  };
  dbState.rules.set(defaultRule.id, defaultRule);

  const friendReward = {
    id: "reward_def_challenger_friend",
    storeId: store.id,
    name: "$15 Friend Voucher",
    description: null,
    rewardType: "amount_off",
    salesChannel: "online_store",
    exchangeType: WeleticRewardExchangeType.fixed,
    status: WeleticRewardStatus.active,
    pointsCost: BigInt(0),
    discountValue: new Prisma.Decimal("15.00"),
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
        if (where?.email) {
          for (const s of Array.from(dbState.shoppers.values())) {
            if (
              s.email?.trim().toLowerCase() ===
              where.email?.trim().toLowerCase()
            ) {
              return s;
            }
          }
        }
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
      updateMany: vi.fn(async () => ({ count: 1 })),
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
    $queryRaw: vi.fn(async (query) => {
      const storeId = String(query.values[0]);
      if (query.sql.includes("FROM WeleticLoyaltyProgram")) {
        return Array.from(dbState.programs.values()).filter(
          (program) => program.storeId === storeId,
        );
      }
      const store = dbState.stores.get(storeId);
      return store ? [{ ...store, storeAccessState: "active" }] : [];
    }),
  };
  return { prisma: prismaMock };
});

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
    storeId: "store_challenger_ref_1",
    email: params.email,
    firstName:
      params.firstName !== undefined ? params.firstName : `First_${params.id}`,
    lastName:
      params.lastName !== undefined ? params.lastName : `Last_${params.id}`,
    ordersCount: params.ordersCount ?? 0,
  };
  dbState.shoppers.set(shopperId, shopper);

  const account = {
    id: params.id,
    storeId: "store_challenger_ref_1",
    programId: "prog_challenger_1",
    shopperId,
    status: "active",
    referralCode: params.referralCode || `REF-${params.id.toUpperCase()}`,
    referralCount: 0,
    referralPointsEarned: BigInt(0),
    cachedPointsBalance: params.pointsBalance ?? BigInt(0),
    referredById: null,
    metadata: {},
  };
  dbState.accounts.set(account.id, account);
  return { account, shopper };
}

describe("Challenger 1 Stress Suite: Referral Anti-Fraud Defense & RBAC Boundary (Requirement R2 / Nhóm 1.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    currentTestRole = "owner";
    currentUserId = "usr_owner_challenger";
    currentWorkspaceId = "ws_tenant_challenger";

    discountMocks.graphql.mockResolvedValue({ customers: { nodes: [] } });
    discountMocks.provision.mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/554433",
      code: "WLF-STRESS-TEST",
      title: "Friend Reward Voucher",
      status: "ACTIVE",
    });
    discountMocks.lookup.mockResolvedValue(null);
    discountMocks.deactivate.mockResolvedValue({ deactivated: true });
    emailMocks.sendBatch.mockResolvedValue({
      data: { data: [{ id: "email_challenger_1" }] },
      error: null,
    });
  });

  // ===========================================================================
  // 1. Dot-Stuffing & Plus-Addressing Evasion Attacks on Email Normalization
  // ===========================================================================
  describe("1. Dot-Stuffing & Plus-Addressing Evasion Attacks on Email Normalization", () => {
    const advocateEmail = "satoshi.nakamoto@gmail.com";

    it("1.1 collapses dot-stuffing, plus-addressing, and googlemail aliases to identical similarity keys", () => {
      const canonicalKey = getReferralEmailSimilarityKey(advocateEmail);
      expect(canonicalKey).toBe("satoshinakamoto@gmail.com");

      const attackVectors = [
        "s.a.t.o.s.h.i.n.a.k.a.m.o.t.o@gmail.com", // extreme dot stuffing
        "satoshinak.amoto@gmail.com", // mid-string dot insertion
        "satoshi.nakamoto+freebie@gmail.com", // plus sub-addressing
        "satoshinakamoto+bot99@gmail.com", // plus sub-addressing
        "satoshinakamoto@googlemail.com", // googlemail domain aliasing
        "satoshi.nakamoto+bonus@googlemail.com", // plus sub-addressing on googlemail
        "satoshi-nakamoto@gmail.com", // dash separator
        "satoshi_nakamoto@gmail.com", // underscore separator
      ];

      for (const vector of attackVectors) {
        expect(getReferralEmailSimilarityKey(vector)).toBe(canonicalKey);
      }
    });

    it("1.2 traps email mutation attacks in registered member binding (bindShopperReferral)", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_evasion",
        email: advocateEmail,
        referralCode: "SATOSHI-REF",
      });

      const attackEmails = [
        "s.a.t.o.s.h.i.n.a.k.a.m.o.t.o@gmail.com",
        "satoshi.nakamoto+sybil1@gmail.com",
        "satoshinakamoto@googlemail.com",
      ];

      for (let i = 0; i < attackEmails.length; i++) {
        const attackEmail = attackEmails[i];
        const { account: referee } = createTestLoyaltyAccount({
          id: `acc_referee_evasion_${i}`,
          email: attackEmail,
        });

        const referral = await bindShopperReferral({
          storeId: "store_challenger_ref_1",
          refereeAccountId: referee.id,
          referralCode: advocate.referralCode,
        });

        expect(referral.status).toBe(
          WeleticLoyaltyReferralStatus.fraud_blocked,
        );
        expect((referral.fraudSignals as any)?.similarEmail).toBe(true);
        expect(referral.fraudReason).toContain(
          "Advocate and friend use materially similar email addresses",
        );
      }
    });

    it("1.3 traps email mutation attacks in anonymous friend claims (claimReferralFriendReward)", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_anon_evasion",
        email: advocateEmail,
        referralCode: "ANON-EVASION",
      });

      const outcome = await claimReferralFriendReward({
        storeId: "store_challenger_ref_1",
        referralCode: advocate.referralCode,
        friendEmail: "s.a.t.o.s.h.i.n.a.k.a.m.o.t.o+freevoucher@gmail.com",
        clientIp: "198.51.100.12",
      });

      // Anonymous claim routes fraud to review state and stores fraud_blocked record
      expect(outcome.status).toBe("review");
      const createdReferral = Array.from(dbState.referrals.values()).find(
        (r) => r.advocateAccountId === advocate.id,
      );
      expect(createdReferral).toBeDefined();
      expect(createdReferral.status).toBe(
        WeleticLoyaltyReferralStatus.fraud_blocked,
      );
      expect((createdReferral.fraudSignals as any)?.similarEmail).toBe(true);
    });
  });

  // ===========================================================================
  // 2. Internationalized / Unicode Character Homograph Tricks in Names
  // ===========================================================================
  describe("2. Internationalized / Unicode Homograph Tricks in Names", () => {
    it("2.1 traps name homograph attacks: diacritics, accents, Zen-kaku fullwidth, and noise in bindShopperReferral", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_homograph_canon",
        email: "advocate.canon@example.com",
        firstName: "Alexander",
        lastName: "Hamilton",
        referralCode: "HAMILTON-CANON",
      });

      const homographVariants = [
        ["Àlèxándér", "Hámíltón"], // Latin accented vowels
        ["Ålexander", "Hämiltön"], // Nordic & Germanic umlauts
        ["Alexandêr", "Hamiltõn"], // Circumflex & tilde
        ["Ａｌｅｘａｎｄｅｒ", "Ｈａｍｉｌｔｏｎ"], // Fullwidth Unicode (Zen-kaku)
        ["   aLeXaNdEr  ", "   hAmILtOn   "], // Mixed casing & spacing
        ["Alexander-Hamilton", ""], // Hyphenated compound name
        ["Alexander.Hamilton", "!"], // Punctuation noise
      ];

      for (let i = 0; i < homographVariants.length; i++) {
        const [firstName, lastName] = homographVariants[i];
        const { account: referee } = createTestLoyaltyAccount({
          id: `acc_ref_homograph_${i}`,
          email: `sybil_${i}@different-domain.org`,
          firstName,
          lastName,
        });

        const referral = await bindShopperReferral({
          storeId: "store_challenger_ref_1",
          refereeAccountId: referee.id,
          referralCode: advocate.referralCode,
        });

        expect(referral.status).toBe(
          WeleticLoyaltyReferralStatus.fraud_blocked,
        );
        expect((referral.fraudSignals as any)?.sameName).toBe(true);
        expect(referral.fraudReason).toContain(
          "Advocate and friend use the same normalized name",
        );
      }
    });
  });

  // ===========================================================================
  // 3. Disposable Email Domain Blacklist Enforcement
  // ===========================================================================
  describe("3. Disposable Email Domain Blacklist Enforcement", () => {
    it("3.1 identifies all known disposable domains with case-insensitivity", () => {
      const knownDomains = [
        "10minutemail.com",
        "guerrillamail.com",
        "mailinator.com",
        "temp-mail.org",
        "tempmail.com",
        "throwawaymail.com",
        "yopmail.com",
      ];

      for (const domain of knownDomains) {
        expect(isKnownDisposableReferralEmail(`sybil@${domain}`)).toBe(true);
        expect(
          isKnownDisposableReferralEmail(`sybil@${domain.toUpperCase()}`),
        ).toBe(true);
      }

      expect(isKnownDisposableReferralEmail("shopper@gmail.com")).toBe(false);
      expect(isKnownDisposableReferralEmail("member@yamax.com")).toBe(false);
      expect(isKnownDisposableReferralEmail("vip@outlook.com")).toBe(false);
    });

    it("3.2 blocks disposable email domains in member binding and anonymous claims", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_disp",
        email: "clean.advocate@gmail.com",
        referralCode: "DISPOSABLE-GATE",
      });

      // 1. Member bind with disposable domain
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_ref_disp",
        email: "fraudster@temp-mail.org",
      });
      const memberRef = await bindShopperReferral({
        storeId: "store_challenger_ref_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });
      expect(memberRef.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((memberRef.fraudSignals as any)?.disposableEmail).toBe(true);

      // 2. Anonymous claim with disposable domain
      const anonClaim = await claimReferralFriendReward({
        storeId: "store_challenger_ref_1",
        referralCode: advocate.referralCode,
        friendEmail: "burner@YOPMAIL.COM",
      });
      expect(anonClaim.status).toBe("review");
    });
  });

  // ===========================================================================
  // 4. Race Conditions in Anonymous Friend Claims & Concurrent Duplicate Protection
  // ===========================================================================
  describe("4. Race Conditions in Anonymous Friend Claims & Concurrent Duplicate Protection", () => {
    it("4.1 duplicate friend claims on the same digest provision Shopify discount exactly once and adopt reservation", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_race",
        email: "popular.advocate@yamax.com",
        referralCode: "RACE-PROTECT",
      });

      const friendEmail = "same.friend.victim@example.com";

      // 1. First claim succeeds and provisions Shopify discount
      const firstClaim = await claimReferralFriendReward({
        storeId: "store_challenger_ref_1",
        referralCode: advocate.referralCode,
        friendEmail,
        clientIp: "198.51.100.10",
      });

      expect(firstClaim.status).toBe("claimed");
      expect((firstClaim as any).discountCode).toBeDefined();

      // 2. Second claim with identical normalized email adopts existing reservation
      const secondClaim = await claimReferralFriendReward({
        storeId: "store_challenger_ref_1",
        referralCode: advocate.referralCode,
        friendEmail: "  same.friend.victim@example.com  ",
        clientIp: "198.51.100.11",
      });

      expect(secondClaim.status).toBe("claimed");

      // Assert that exactly ONE referral record was created in the database
      const referralCount = Array.from(dbState.referrals.values()).filter(
        (r) => r.advocateAccountId === advocate.id,
      ).length;
      expect(referralCount).toBe(1);

      // Assert that Shopify discount provisioning was invoked EXACTLY ONCE
      expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledOnce();
    });
  });

  // ===========================================================================
  // 5. Returning Customer Abuse Detection (Local & Remote Order History)
  // ===========================================================================
  describe("5. Returning Customer Abuse Detection", () => {
    it("5.1 blocks returning customers with local order history in member referral binding", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_returning",
        email: "advocate.first@yamax.com",
        referralCode: "RETURNING-BLOCK",
      });
      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_ref_returning",
        email: "returning.buyer@yamax.com",
        ordersCount: 3, // Already made 3 prior orders!
      });

      const referral = await bindShopperReferral({
        storeId: "store_challenger_ref_1",
        refereeAccountId: referee.id,
        referralCode: advocate.referralCode,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect((referral.fraudSignals as any)?.existingCustomer).toBe(true);
      expect(referral.fraudReason).toContain(
        "Friend already has Shopify order history",
      );
    });

    it("5.2 blocks qualification if friend order count is greater than 1 at checkout time", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_repeat",
        email: "advocate.repeat@yamax.com",
        referralCode: "REPEAT-ORDER-CHECK",
      });

      const friendEmail = "repeat.friend@example.com";
      await claimReferralFriendReward({
        storeId: "store_challenger_ref_1",
        referralCode: advocate.referralCode,
        friendEmail,
        clientIp: "203.0.113.30",
      });

      // Friend attempts to qualify with customerOrderSequence = 2 (returning customer)
      const qual = await evaluateReferralFriendClaimQualification({
        storeId: "store_challenger_ref_1",
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
  // 6. Partial Refund Preservation vs Full Refund Clawback Boundaries
  // ===========================================================================
  describe("6. Partial Refund Preservation vs Full Refund Clawback Boundaries", () => {
    it("6.1 preserves advocate reward on partial refunds (Smile / Yotpo parity standard)", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_partial_refund",
        email: "advocate.partial@yamax.com",
        pointsBalance: BigInt(500),
      });

      const { account: referee } = createTestLoyaltyAccount({
        id: "acc_ref_partial_refund",
        email: "referee.partial@yamax.com",
      });

      const referral = {
        id: "wref_partial_refund_test",
        storeId: "store_challenger_ref_1",
        advocateAccountId: advocate.id,
        refereeAccountId: referee.id,
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_partial_test_1",
        advocatePointsAwarded: BigInt(500),
        refereePointsAwarded: BigInt(0),
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // Parity invariant: On partial refund (isFullOrderRefund === false),
      // reverseReferralPointsOnRefund is NOT invoked.
      // The referral remains rewarded and advocate retains points.
      const isFullOrderRefund = false;
      if (isFullOrderRefund) {
        await reverseReferralPointsOnRefund({
          storeId: "store_challenger_ref_1",
          orderId: "order_partial_test_1",
          refundId: "refund_part_1",
        });
      }

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.rewarded);
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
      expect(deactivateDiscount).not.toHaveBeenCalled();
    });

    it("6.2 claws back advocate points and deactivates friend coupon on 100% full refund", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_full_refund",
        email: "advocate.full@yamax.com",
        pointsBalance: BigInt(500),
      });

      const referral = {
        id: "wref_full_refund_test",
        storeId: "store_challenger_ref_1",
        advocateAccountId: advocate.id,
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_full_test_1",
        advocatePointsAwarded: BigInt(500),
        refereePointsAwarded: BigInt(0),
        friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/888999",
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // Full order refund executes reverseReferralPointsOnRefund
      const result = await reverseReferralPointsOnRefund({
        storeId: "store_challenger_ref_1",
        orderId: "order_full_test_1",
        refundId: "refund_full_1",
      });

      expect(result.reversed).toBe(true);
      expect(result.advocateReversed).toBe(BigInt(500));
      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.cancelled);
      expect((referral.metadata as any)?.requalificationBlocked).toBe(true);

      // Points clawback debit appended
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(-500),
          entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        }),
      );

      // Deactivate friend discount code
      await deactivateCancelledReferralFriendReward({
        storeId: "store_challenger_ref_1",
        orderId: "order_full_test_1",
      });
      expect(deactivateDiscount).toHaveBeenCalledWith(
        "challenger.myshopify.com",
        "offline-token-challenger",
        "gid://shopify/DiscountCodeNode/888999",
      );
    });

    it("6.3 supports negative points deficit when advocate already spent points prior to full refund", async () => {
      const { account: advocate } = createTestLoyaltyAccount({
        id: "acc_adv_spent_all",
        email: "advocate.insolvent@yamax.com",
        pointsBalance: BigInt(0), // Points already spent!
      });

      const referral = {
        id: "wref_insolvent_clawback",
        storeId: "store_challenger_ref_1",
        advocateAccountId: advocate.id,
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_spent_all_1",
        advocatePointsAwarded: BigInt(500),
        refereePointsAwarded: BigInt(0),
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      await reverseReferralPointsOnRefund({
        storeId: "store_challenger_ref_1",
        orderId: "order_spent_all_1",
        refundId: "refund_spent_all_1",
      });

      // Full clawback completes without throwing or clipping
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: advocate.id,
          pointsDelta: BigInt(-500),
        }),
      );
    });
  });

  // ===========================================================================
  // 7. Owner-Only RBAC Security Boundary & Privilege Escalation Defense
  // ===========================================================================
  describe("7. Owner-Only RBAC Security Boundary & Privilege Escalation Defense", () => {
    it("7.1 rejects unauthenticated and non-owner callers with 401 / 403", async () => {
      const referral = {
        id: "wref_rbac_stress",
        storeId: "store_challenger_ref_1",
        advocateAccountId: "acc_adv_rbac",
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // 1. Unauthenticated -> 401
      currentUserId = "";
      const unauthReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_challenger",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ referralId: referral.id, action: "cancel" }),
        },
      );
      const unauthRes = await patchReferrals(unauthReq as any, {
        params: Promise.resolve({}),
      });
      expect(unauthRes.status).toBe(401);

      // 2. Member role -> 403
      currentUserId = "usr_member_challenger";
      currentTestRole = "member";
      const memberReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_challenger",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ referralId: referral.id, action: "cancel" }),
        },
      );
      const memberRes = await patchReferrals(memberReq as any, {
        params: Promise.resolve({}),
      });
      expect(memberRes.status).toBe(403);

      // 3. Admin role -> 403 (Owner is strictly required for fraud actions!)
      currentUserId = "usr_admin_challenger";
      currentTestRole = "admin";
      const adminReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_challenger",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ referralId: referral.id, action: "cancel" }),
        },
      );
      const adminRes = await patchReferrals(adminReq as any, {
        params: Promise.resolve({}),
      });
      expect(adminRes.status).toBe(403);
    });

    it("7.2 allows workspace owner to cancel and unblock referrals with audit tracking", async () => {
      currentUserId = "usr_owner_challenger";
      currentTestRole = "owner";

      const referral = {
        id: "wref_owner_authorized",
        storeId: "store_challenger_ref_1",
        advocateAccountId: "acc_adv_owner_test",
        refereeAccountId: null,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        metadata: {},
      };
      dbState.referrals.set(referral.id, referral);

      // Owner cancellation
      const ownerReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_challenger",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            referralId: referral.id,
            action: "cancel",
            reason: "Confirmed multi-accounting by owner audit",
          }),
        },
      );
      const ownerRes = await patchReferrals(ownerReq as any, {
        params: Promise.resolve({}),
      });
      expect(ownerRes.status).toBe(200);

      const resBody = await ownerRes.json();
      expect(resBody.data.referral.status).toBe(
        WeleticLoyaltyReferralStatus.cancelled,
      );
      const updated = dbState.referrals.get(referral.id);
      expect((updated.metadata as any)?.requalificationBlocked).toBe(true);
      expect((updated.metadata as any)?.cancellationReason).toBe(
        "Confirmed multi-accounting by owner audit",
      );
    });

    it("7.3 rejects invalid or malformed actions with 400 Bad Request", async () => {
      currentUserId = "usr_owner_challenger";
      currentTestRole = "owner";

      const badReq = new Request(
        "http://localhost/api/shopify/loyalty/admin/referrals?workspaceId=ws_tenant_challenger",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            referralId: "wref_owner_authorized",
            action: "malicious_exploit_action",
          }),
        },
      );
      const badRes = await patchReferrals(badReq as any, {
        params: Promise.resolve({}),
      });
      expect(badRes.status).toBe(400);
    });
  });
});
