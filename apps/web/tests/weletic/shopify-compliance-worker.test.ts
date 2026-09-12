import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativeCredentialDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  merchantSettingsDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  staffGrantFindMany: vi.fn().mockResolvedValue([]),
  staffActionFindMany: vi.fn().mockResolvedValue([]),
  staffGrantDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  staffActionDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  shopperFindMany: vi.fn(),
  shopperFindUnique: vi.fn(),
  shopperUpdate: vi.fn(),
  customerFindMany: vi.fn(),
  customerFindUnique: vi.fn(),
  customerUpdateMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  nativeReviewFindMany: vi.fn(),
  nativeRequestFindMany: vi.fn(),
  nativeMediaFindMany: vi.fn(),
  incentiveClaimFindMany: vi.fn(),
  incentivePolicyFindMany: vi.fn(),
  couponUseFindMany: vi.fn().mockResolvedValue([]),
  invalidationFindMany: vi.fn().mockResolvedValue([]),
  nativeMediaDownload: vi.fn(),
  earnGrantFindMany: vi.fn(),
  earnGrantUpdateMany: vi.fn(),
  orderLineEarnFindMany: vi.fn(),
  orderLineEarnUpdateMany: vi.fn(),
  backfillPreviewFindMany: vi.fn(),
  backfillPreviewDeleteMany: vi.fn(),
  backfillSnapshotFindMany: vi.fn(),
  backfillSnapshotDeleteMany: vi.fn(),
  backfillCreditFindMany: vi.fn(),
  backfillCreditDeleteMany: vi.fn(),
  backfillJobFindMany: vi.fn(),
  backfillJobDeleteMany: vi.fn(),
  policyRevisionFindMany: vi.fn(),
  policyRevisionDeleteMany: vi.fn(),
  earningRuleFindMany: vi.fn(),
  earningRuleDeleteMany: vi.fn(),
  bonusCampaignFindMany: vi.fn(),
  bonusCampaignDeleteMany: vi.fn(),
  referralRuleFindMany: vi.fn(),
  referralRuleDeleteMany: vi.fn(),
  loyaltyTierFindMany: vi.fn(),
  loyaltyTierUpdateMany: vi.fn(),
  rewardDefinitionFindMany: vi.fn(),
  rewardDefinitionUpdateMany: vi.fn(),
  referralFindMany: vi.fn(),
  redactFriendEmail: vi.fn(),
  redactFriendShopBatch: vi.fn(),
  deriveReferralEmailDigests: vi.fn(),
  artifactStore: vi.fn(),
  artifactDeliver: vi.fn(),
  artifactExpiryDeleteBatch: vi.fn(),
  artifactStoreDeleteBatch: vi.fn(),
  artifactCustomerDeleteBatch: vi.fn(),
  tombstoneExpiryDeleteBatch: vi.fn(),
  couponUseExpiryDeleteBatch: vi
    .fn()
    .mockResolvedValue({ selectedStores: 0, deleted: 0, results: [] }),
  tombstoneCustomer: vi.fn(),
  tombstoneShop: vi.fn(),
  prepareRedaction: vi.fn(),
  scrubCustomerContext: vi.fn(),
  scrubAccountStep: vi.fn(),
  voucherEnumerationStep: vi.fn(),
  voucherTerminalCounts: vi.fn(),
  withDistributedLock: vi.fn(),
  settlementLocks: vi.fn(),
  pseudonym: vi.fn(),
  parsePseudonym: vi.fn(),
  deriveCustomerIdentities: vi.fn(),
  deriveShopIdentities: vi.fn(),
  privacyTombstoneFindMany: vi.fn(),
  shopPrivacyTombstoneFindFirst: vi.fn(),
  checkoutCacheDelete: vi.fn(),
  customerCachePurge: vi.fn(),
  customerCacheIndexPurge: vi.fn(),
  storeCachePurge: vi.fn(),
  requestFindUnique: vi.fn(),
  requestFindFirst: vi.fn(),
  requestFindUniqueOrThrow: vi.fn(),
  requestFindMany: vi.fn(),
  requestUpdateMany: vi.fn(),
  accountFindFirst: vi.fn(),
  accountUpdateMany: vi.fn(),
  orderFindMany: vi.fn(),
  orderUpdateMany: vi.fn(),
  calculationFindMany: vi.fn(),
  calculationUpdateMany: vi.fn(),
  linkFindMany: vi.fn(),
  linkUpdateMany: vi.fn(),
  productDeleteMany: vi.fn(),
  marketDeleteMany: vi.fn(),
  webhookDeleteMany: vi.fn(),
  syncRunDeleteMany: vi.fn(),
  transaction: vi.fn(),
  storeQueryRaw: vi.fn(),
  programQueryRaw: vi.fn(),
  requestLeaseQueryRaw: vi.fn(),
  storeUpdate: vi.fn(),
  programUpdateMany: vi.fn(),
  projectFindUnique: vi.fn(),
  projectUpdate: vi.fn(),
  installationFindMany: vi.fn(),
  installationDeleteMany: vi.fn(),
  appSessionDeleteMany: vi.fn(),
  coordinationDeleteMany: vi.fn(),
  installIntentDeleteMany: vi.fn(),
  sessionIssueDeleteMany: vi.fn(),
  invalidateStoreCache: vi.fn(),
  CustomerOwnerConflictError: class extends Error {},
  freezeUninstall: vi.fn(),
  appUninstalledStep: vi.fn(),
  enqueueWorker: vi.fn(),
  publishPolicyRevision: vi.fn(),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
}));
vi.mock("@/lib/storage", () => ({
  storage: { getSignedDownloadUrl: mocks.nativeMediaDownload },
}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: mocks.publishPolicyRevision,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticMerchantSettings: { deleteMany: mocks.merchantSettingsDeleteMany },
    weleticShopper: {
      findMany: mocks.shopperFindMany,
      findUnique: mocks.shopperFindUnique,
      update: mocks.shopperUpdate,
    },
    customer: {
      findMany: mocks.customerFindMany,
      findUnique: mocks.customerFindUnique,
      updateMany: mocks.customerUpdateMany,
    },
    weleticPointsLedgerEntry: { findMany: mocks.ledgerFindMany },
    weleticProductReview: { findMany: mocks.nativeReviewFindMany },
    weleticReviewRequest: { findMany: mocks.nativeRequestFindMany },
    weleticReviewIncentiveClaim: { findMany: mocks.incentiveClaimFindMany },
    weleticReviewIncentivePolicy: { findMany: mocks.incentivePolicyFindMany },
    weleticRewardCouponUse: { findMany: mocks.couponUseFindMany },
    weleticReviewIncentiveInvalidation: {
      findMany: mocks.invalidationFindMany,
    },
    weleticReviewMedia: { findMany: mocks.nativeMediaFindMany },
    weleticLoyaltyEarnGrant: {
      findMany: mocks.earnGrantFindMany,
      updateMany: mocks.earnGrantUpdateMany,
    },
    weleticLoyaltyOrderLineEarn: {
      findMany: mocks.orderLineEarnFindMany,
      updateMany: mocks.orderLineEarnUpdateMany,
    },
    weleticLoyaltyBackfillPreviewItem: {
      findMany: mocks.backfillPreviewFindMany,
      deleteMany: mocks.backfillPreviewDeleteMany,
    },
    weleticLoyaltyBackfillOrderSnapshot: {
      findMany: mocks.backfillSnapshotFindMany,
      deleteMany: mocks.backfillSnapshotDeleteMany,
    },
    weleticLoyaltyBackfillOrderCredit: {
      findMany: mocks.backfillCreditFindMany,
      deleteMany: mocks.backfillCreditDeleteMany,
    },
    weleticLoyaltyBackfillJob: {
      findMany: mocks.backfillJobFindMany,
      deleteMany: mocks.backfillJobDeleteMany,
    },
    weleticLoyaltyEarnPolicyRevision: {
      findMany: mocks.policyRevisionFindMany,
      deleteMany: mocks.policyRevisionDeleteMany,
    },
    weleticLoyaltyEarningRule: {
      findMany: mocks.earningRuleFindMany,
      deleteMany: mocks.earningRuleDeleteMany,
    },
    weleticLoyaltyBonusCampaign: {
      findMany: mocks.bonusCampaignFindMany,
      deleteMany: mocks.bonusCampaignDeleteMany,
    },
    weleticLoyaltyReferralRule: {
      findMany: mocks.referralRuleFindMany,
      deleteMany: mocks.referralRuleDeleteMany,
    },
    weleticLoyaltyTier: {
      findMany: mocks.loyaltyTierFindMany,
      updateMany: mocks.loyaltyTierUpdateMany,
    },
    weleticRewardDefinition: {
      findMany: mocks.rewardDefinitionFindMany,
      updateMany: mocks.rewardDefinitionUpdateMany,
    },
    weleticRewardRedemption: { findMany: vi.fn() },
    weleticLoyaltyTierHistory: { findMany: vi.fn() },
    weleticLoyaltyReferral: { findMany: mocks.referralFindMany },
    weleticCommerceOrder: {
      findMany: mocks.orderFindMany,
      updateMany: mocks.orderUpdateMany,
    },
    weleticCommissionCalculation: {
      findMany: mocks.calculationFindMany,
      updateMany: mocks.calculationUpdateMany,
    },
    link: {
      findMany: mocks.linkFindMany,
      updateMany: mocks.linkUpdateMany,
    },
    weleticLoyaltyAccount: {
      findMany: vi.fn(),
      findFirst: mocks.accountFindFirst,
      updateMany: mocks.accountUpdateMany,
    },
    weleticShopifyComplianceRequest: {
      findUnique: mocks.requestFindUnique,
      findFirst: mocks.requestFindFirst,
      findUniqueOrThrow: mocks.requestFindUniqueOrThrow,
      findMany: mocks.requestFindMany,
      updateMany: mocks.requestUpdateMany,
    },
    weleticShopifyComplianceArtifact: { findMany: vi.fn() },
    weleticShopifyCustomerPrivacyTombstone: {
      findMany: mocks.privacyTombstoneFindMany,
    },
    weleticShopifyShopPrivacyTombstone: {
      findFirst: mocks.shopPrivacyTombstoneFindFirst,
    },
    weleticShopifyProduct: { deleteMany: mocks.productDeleteMany },
    weleticShopifyMarket: { deleteMany: mocks.marketDeleteMany },
    weleticShopifyWebhookEvent: { deleteMany: mocks.webhookDeleteMany },
    weleticShopifySyncRun: { deleteMany: mocks.syncRunDeleteMany },
    weleticShopifyStore: { update: mocks.storeUpdate },
    weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
    project: {
      findUnique: mocks.projectFindUnique,
      update: mocks.projectUpdate,
    },
    installedIntegration: {
      findMany: mocks.installationFindMany,
      deleteMany: mocks.installationDeleteMany,
    },
    weleticShopifyAppSession: { deleteMany: mocks.appSessionDeleteMany },
    weleticShopifySessionCoordination: {
      deleteMany: mocks.coordinationDeleteMany,
    },
    weleticShopifyInstallIntent: {
      deleteMany: mocks.installIntentDeleteMany,
    },
    weleticReconciliationIssue: { deleteMany: mocks.sessionIssueDeleteMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => {
  const customerContextKeys = new Set([
    "orderName",
    "customerOrderSequence",
    "customerClassification",
    "customerEmail",
    "customerName",
    "shopifyCustomerId",
    "email",
  ]);
  const scrubCustomerContextJsonValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(scrubCustomerContextJsonValue);
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !customerContextKeys.has(key))
        .map(([key, item]) => [key, scrubCustomerContextJsonValue(item)]),
    );
  };
  return {
    SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY: "shopifyCustomerRedaction",
    prepareWeleticShopperRedaction: mocks.prepareRedaction,
    scrubWeleticShopperCustomerContext: mocks.scrubCustomerContext,
    processWeleticLoyaltyAccountPrivacyScrubStep: mocks.scrubAccountStep,
    scrubCustomerContextJsonValue,
  };
});
vi.mock("@/lib/weletic/loyalty/voucher-privacy-cleanup", () => ({
  processStoreVoucherCleanupComplianceStep: vi.fn(),
  processAccountVoucherEnumerationComplianceStep: mocks.voucherEnumerationStep,
  getVoucherCleanupRequestTerminalCounts: mocks.voucherTerminalCounts,
}));
vi.mock("@/lib/weletic/loyalty/referral-friend-claim", () => ({
  redactReferralFriendClaimsForEmail: mocks.redactFriendEmail,
  redactReferralFriendClaimsForShopBatch: mocks.redactFriendShopBatch,
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/shopify/privacy-identity")
  >()),
  ShopifyCustomerPrivacyOwnerConflictError: mocks.CustomerOwnerConflictError,
  upsertShopifyCustomerPrivacyTombstones: mocks.tombstoneCustomer,
  upsertShopifyShopPrivacyTombstone: mocks.tombstoneShop,
  getShopifyCustomerPrivacyPseudonym: mocks.pseudonym,
  parseShopifyCustomerPrivacyPseudonym: mocks.parsePseudonym,
  deriveAllShopifyCustomerPrivacyIdentities: mocks.deriveCustomerIdentities,
  deriveAllShopifyShopPrivacyIdentities: mocks.deriveShopIdentities,
  createAllShopifyDerivedPrivacyDigests: mocks.deriveReferralEmailDigests,
}));
vi.mock("@/lib/weletic/shopify/privacy-cache", () => ({
  deleteShopifyCheckoutCache: mocks.checkoutCacheDelete,
  purgeShopifyCustomerPrivacyCacheBatch: mocks.customerCachePurge,
  purgeShopifyLegacyCustomerPrivacyCache: mocks.customerCacheIndexPurge,
  purgeShopifyStorePrivacyCacheBatch: mocks.storeCachePurge,
}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.withDistributedLock,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS: 120,
  withShopifyCustomerSettlementLocks: mocks.settlementLocks,
}));
vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  invalidateShopifyStoreDomainCache: mocks.invalidateStoreCache,
  normalizeShopDomain: (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, ""),
}));
vi.mock("@/lib/weletic/shopify/compliance-artifacts", () => ({
  storeEncryptedComplianceArtifact: mocks.artifactStore,
  deliverComplianceExportReference: mocks.artifactDeliver,
  deleteExpiredComplianceArtifactsBatch: mocks.artifactExpiryDeleteBatch,
  deleteComplianceArtifactsForStoreBatch: mocks.artifactStoreDeleteBatch,
  deleteComplianceArtifactsForCustomerRedactionBatch:
    mocks.artifactCustomerDeleteBatch,
}));
vi.mock("@/lib/weletic/shopify/compliance-retention", () => ({
  deleteExpiredShopifyPrivacyTombstonesBatch: mocks.tombstoneExpiryDeleteBatch,
}));
vi.mock("@/lib/weletic/loyalty/coupon-use-retention", () => ({
  deleteExpiredShopperCouponUsesBatch: mocks.couponUseExpiryDeleteBatch,
}));
vi.mock("@/lib/weletic/shopify/compliance-ingress", () => ({
  enqueueShopifyComplianceWorker: mocks.enqueueWorker,
  freezeShopifyStoreForUninstall: mocks.freezeUninstall,
}));
vi.mock(
  "../../app/(ee)/api/shopify/integration/webhook/app-uninstalled",
  () => ({
    processAppUninstalledComplianceStep: mocks.appUninstalledStep,
  }),
);

import { ShopifyComplianceDispatchUnavailableError } from "../../lib/weletic/shopify/compliance-dispatch";
import {
  boundedComplianceRecoveryBatchSize,
  ComplianceOperatorReviewError,
  processCustomerDataRequestStep,
  processCustomerRedactStep,
  processShopifyComplianceBatch,
  processShopifyComplianceRequest,
  processShopRedactStep,
  resolveCustomerSubject,
} from "../../lib/weletic/shopify/compliance-worker";

describe("durable compliance worker boundaries", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("SHOPIFY_API_KEY", "public-app-test");
    vi.clearAllMocks();
    mocks.shopperFindMany.mockResolvedValue([]);
    mocks.customerFindMany.mockResolvedValue([]);
    mocks.customerFindUnique.mockResolvedValue(null);
    mocks.shopperFindUnique.mockResolvedValue(null);
    mocks.customerUpdateMany.mockResolvedValue({ count: 0 });
    mocks.shopperUpdate.mockResolvedValue({});
    mocks.ledgerFindMany.mockResolvedValue([]);
    mocks.nativeReviewFindMany.mockResolvedValue([]);
    mocks.nativeRequestFindMany.mockResolvedValue([]);
    mocks.nativeMediaFindMany.mockResolvedValue([]);
    mocks.nativeMediaDownload.mockResolvedValue(
      "https://private.example.test/signed",
    );
    mocks.earnGrantFindMany.mockResolvedValue([]);
    mocks.earnGrantUpdateMany.mockResolvedValue({ count: 0 });
    mocks.orderLineEarnFindMany.mockResolvedValue([]);
    mocks.orderLineEarnUpdateMany.mockResolvedValue({ count: 0 });
    mocks.backfillPreviewFindMany.mockResolvedValue([]);
    mocks.backfillPreviewDeleteMany.mockResolvedValue({ count: 0 });
    mocks.backfillSnapshotFindMany.mockResolvedValue([]);
    mocks.backfillSnapshotDeleteMany.mockResolvedValue({ count: 0 });
    mocks.backfillCreditFindMany.mockResolvedValue([]);
    mocks.backfillCreditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.backfillJobFindMany.mockResolvedValue([]);
    mocks.backfillJobDeleteMany.mockResolvedValue({ count: 0 });
    mocks.policyRevisionFindMany.mockResolvedValue([]);
    mocks.policyRevisionDeleteMany.mockResolvedValue({ count: 0 });
    mocks.earningRuleFindMany.mockResolvedValue([]);
    mocks.earningRuleDeleteMany.mockResolvedValue({ count: 0 });
    mocks.bonusCampaignFindMany.mockResolvedValue([]);
    mocks.bonusCampaignDeleteMany.mockResolvedValue({ count: 0 });
    mocks.referralRuleFindMany.mockResolvedValue([]);
    mocks.referralRuleDeleteMany.mockResolvedValue({ count: 0 });
    mocks.loyaltyTierFindMany.mockResolvedValue([]);
    mocks.loyaltyTierUpdateMany.mockResolvedValue({ count: 0 });
    mocks.rewardDefinitionFindMany.mockResolvedValue([]);
    mocks.rewardDefinitionUpdateMany.mockResolvedValue({ count: 0 });
    mocks.referralFindMany.mockResolvedValue([]);
    mocks.redactFriendEmail.mockResolvedValue(0);
    mocks.redactFriendShopBatch.mockResolvedValue({
      scrubbed: 0,
      hasMore: false,
      lastId: undefined,
    });
    mocks.deriveReferralEmailDigests.mockReturnValue([
      "hmac:v1:kid_1:FRIEND_EMAIL_DIGEST",
    ]);
    mocks.artifactStore.mockResolvedValue({});
    mocks.artifactDeliver.mockResolvedValue({});
    mocks.artifactExpiryDeleteBatch.mockResolvedValue({
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    mocks.artifactStoreDeleteBatch.mockResolvedValue({
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    mocks.artifactCustomerDeleteBatch.mockResolvedValue({
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    mocks.tombstoneExpiryDeleteBatch.mockResolvedValue({
      customer: { selected: 0, deleted: 0 },
      shop: { selected: 0, deleted: 0 },
    });
    mocks.tombstoneCustomer.mockResolvedValue([]);
    mocks.tombstoneShop.mockResolvedValue({
      identityKeyId: "kid_1",
      shopDomainDigest: "SAFE_SHOP_DIGEST_1234567890",
    });
    mocks.prepareRedaction.mockResolvedValue({
      found: false,
      shopperId: null,
      accountId: null,
      redactedAt: new Date("2026-08-30T00:00:00.000Z"),
    });
    mocks.scrubCustomerContext.mockResolvedValue({ found: false });
    mocks.scrubAccountStep.mockResolvedValue({
      completed: true,
      phase: "completed",
      cursor: null,
    });
    mocks.voucherEnumerationStep.mockResolvedValue({
      completed: false,
      phase: "scrub_customer_identity",
      cursor: null,
      progress: {},
    });
    mocks.voucherTerminalCounts.mockResolvedValue({
      outstanding: 0,
      completed: 0,
      deadLetter: 0,
      cancelled: 0,
      total: 0,
    });
    mocks.withDistributedLock.mockImplementation(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    );
    mocks.settlementLocks.mockImplementation(
      async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
    );
    mocks.pseudonym.mockImplementation(
      ({ shopifyCustomerId }) => `redacted:v1:kid_1:${shopifyCustomerId}`,
    );
    mocks.parsePseudonym.mockReturnValue(null);
    mocks.deriveCustomerIdentities.mockReturnValue([
      {
        identityKind: "customer_id",
        identityKeyId: "kid_1",
        customerDigest: "SAFE_DIGEST",
      },
    ]);
    mocks.deriveShopIdentities.mockReturnValue([
      {
        identityKeyId: "kid_1",
        shopDomainDigest: "SAFE_SHOP_DIGEST_1234567890",
      },
    ]);
    mocks.shopPrivacyTombstoneFindFirst.mockResolvedValue({
      identityKeyId: "kid_1",
      shopDomainDigest: "SAFE_SHOP_DIGEST_1234567890",
    });
    mocks.privacyTombstoneFindMany.mockResolvedValue([]);
    mocks.checkoutCacheDelete.mockResolvedValue(1);
    mocks.customerCachePurge.mockResolvedValue({
      completed: true,
      deleted: 0,
      cursor: null,
    });
    mocks.customerCacheIndexPurge.mockResolvedValue(undefined);
    mocks.storeCachePurge.mockResolvedValue({
      completed: true,
      deleted: 0,
      cursor: null,
    });
    mocks.accountFindFirst.mockResolvedValue(null);
    mocks.accountUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderFindMany.mockResolvedValue([]);
    mocks.orderUpdateMany.mockResolvedValue({ count: 0 });
    mocks.calculationFindMany.mockResolvedValue([]);
    mocks.calculationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.linkFindMany.mockResolvedValue([]);
    mocks.linkUpdateMany.mockResolvedValue({ count: 0 });
    mocks.requestFindUnique.mockResolvedValue(null);
    mocks.requestFindFirst.mockImplementation((input) =>
      mocks.requestFindUniqueOrThrow(input),
    );
    mocks.requestFindMany.mockResolvedValue([]);
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.productDeleteMany.mockReturnValue({ operation: "delete-products" });
    mocks.marketDeleteMany.mockReturnValue({ operation: "delete-markets" });
    mocks.webhookDeleteMany.mockReturnValue({ operation: "delete-webhooks" });
    mocks.syncRunDeleteMany.mockReturnValue({ operation: "delete-sync-runs" });
    mocks.storeQueryRaw.mockResolvedValue([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "target.myshopify.com",
        complianceState: "frozen",
        redactedAt: null,
        financialRetentionUntil: null,
      },
    ]);
    mocks.requestLeaseQueryRaw.mockImplementation(async (query: any) => [
      {
        id: query?.values?.[0] ?? "wcomp_redact",
        status: "processing",
        lockedBy: "worker_1",
        leaseVersion: 1,
      },
    ]);
    mocks.programQueryRaw.mockResolvedValue([
      { id: "program_1", disabledAt: null },
    ]);
    mocks.transaction.mockImplementation(async (input: any) => {
      if (typeof input !== "function") return Promise.all(input);
      return input({
        weleticShopifyStaffGrant: {
          findMany: mocks.staffGrantFindMany,
          deleteMany: mocks.staffGrantDeleteMany,
        },
        weleticShopifyMerchantAction: {
          findMany: mocks.staffActionFindMany,
          deleteMany: mocks.staffActionDeleteMany,
        },
        weleticMerchantSettings: {
          deleteMany: mocks.merchantSettingsDeleteMany,
        },
        $queryRaw: (query: any) => {
          const sql = query?.strings?.join("") ?? "";
          if (sql.includes("WeleticShopifyPendingInstallation")) return [];
          if (sql.includes("WeleticShopifyComplianceRequest")) {
            return mocks.requestLeaseQueryRaw(query);
          }
          if (sql.includes("WeleticLoyaltyProgram")) {
            return mocks.programQueryRaw(query);
          }
          return mocks.storeQueryRaw(query);
        },
        project: {
          findUnique: mocks.projectFindUnique,
          update: mocks.projectUpdate,
        },
        weleticShopifyInstallationCredential: {
          deleteMany: mocks.nativeCredentialDeleteMany,
        },
        installedIntegration: {
          findMany: mocks.installationFindMany,
          deleteMany: mocks.installationDeleteMany,
        },
        weleticShopifyAppSession: {
          deleteMany: mocks.appSessionDeleteMany,
        },
        weleticShopifySessionCoordination: {
          deleteMany: mocks.coordinationDeleteMany,
        },
        weleticShopifyInstallIntent: {
          deleteMany: mocks.installIntentDeleteMany,
        },
        weleticReconciliationIssue: {
          deleteMany: mocks.sessionIssueDeleteMany,
        },
        weleticShopifyStore: { update: mocks.storeUpdate },
        weleticShopifyShopPrivacyTombstone: {
          findFirst: mocks.shopPrivacyTombstoneFindFirst,
        },
        weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
        weleticCommerceOrder: { updateMany: mocks.orderUpdateMany },
        weleticLoyaltyEarnGrant: {
          findMany: mocks.earnGrantFindMany,
          updateMany: mocks.earnGrantUpdateMany,
        },
        weleticLoyaltyOrderLineEarn: {
          findMany: mocks.orderLineEarnFindMany,
          updateMany: mocks.orderLineEarnUpdateMany,
        },
        weleticLoyaltyBackfillPreviewItem: {
          findMany: mocks.backfillPreviewFindMany,
          deleteMany: mocks.backfillPreviewDeleteMany,
        },
        weleticLoyaltyBackfillOrderSnapshot: {
          findMany: mocks.backfillSnapshotFindMany,
          deleteMany: mocks.backfillSnapshotDeleteMany,
        },
        weleticLoyaltyBackfillOrderCredit: {
          findMany: mocks.backfillCreditFindMany,
          deleteMany: mocks.backfillCreditDeleteMany,
        },
        weleticLoyaltyBackfillJob: {
          findMany: mocks.backfillJobFindMany,
          deleteMany: mocks.backfillJobDeleteMany,
        },
        weleticLoyaltyEarnPolicyRevision: {
          findMany: mocks.policyRevisionFindMany,
          deleteMany: mocks.policyRevisionDeleteMany,
        },
        weleticLoyaltyEarningRule: {
          findMany: mocks.earningRuleFindMany,
          deleteMany: mocks.earningRuleDeleteMany,
        },
        weleticLoyaltyBonusCampaign: {
          findMany: mocks.bonusCampaignFindMany,
          deleteMany: mocks.bonusCampaignDeleteMany,
        },
        weleticLoyaltyReferralRule: {
          findMany: mocks.referralRuleFindMany,
          deleteMany: mocks.referralRuleDeleteMany,
        },
        weleticLoyaltyTier: {
          findMany: mocks.loyaltyTierFindMany,
          updateMany: mocks.loyaltyTierUpdateMany,
        },
        weleticRewardDefinition: {
          findMany: mocks.rewardDefinitionFindMany,
          updateMany: mocks.rewardDefinitionUpdateMany,
        },
        weleticShopifyComplianceRequest: {
          findUnique: mocks.requestFindUnique,
          updateMany: mocks.requestUpdateMany,
        },
      });
    });
    mocks.storeUpdate.mockReturnValue({ operation: "redact-store" });
    mocks.programUpdateMany.mockResolvedValue({ count: 1 });
    mocks.publishPolicyRevision.mockResolvedValue({ id: "wpolicy_disabled" });
    mocks.freezeUninstall.mockResolvedValue({
      complianceState: "frozen",
      cutoff: new Date("2026-08-30T00:00:00.000Z"),
    });
    mocks.appUninstalledStep.mockResolvedValue({
      completed: false,
      phase: "enumerate_vouchers",
    });
    mocks.enqueueWorker.mockResolvedValue(true);
    mocks.projectFindUnique.mockResolvedValue({
      shopifyStoreId: "primary.example.com",
    });
    mocks.projectUpdate.mockReturnValue({ operation: "clear-project" });
    mocks.installationFindMany.mockResolvedValue([
      { credentials: { shop: "target.myshopify.com" } },
    ]);
    mocks.installationDeleteMany.mockReturnValue({
      operation: "delete-installations",
    });
    mocks.appSessionDeleteMany.mockReturnValue({
      operation: "delete-sessions",
    });
    mocks.coordinationDeleteMany.mockReturnValue({
      operation: "delete-coordination",
    });
    mocks.installIntentDeleteMany.mockReturnValue({
      operation: "delete-intents",
    });
  });

  it("does not convert a nullable externalId into the fake customer id 'null'", async () => {
    mocks.customerFindMany.mockResolvedValue([
      { id: "legacy_1", externalId: null },
    ]);
    await expect(
      resolveCustomerSubject({
        storeId: "store_1",
        workspaceId: "workspace_1",
        subject: {
          shopDomain: "target.myshopify.com",
          customerEmail: "customer@example.com",
          orderExternalIds: [],
        },
      }),
    ).resolves.toEqual({
      customerId: null,
      legacyCustomerId: "legacy_1",
      shopperId: null,
      accountId: null,
      tombstoned: false,
    });
  });

  it("caps recovery sweeps to three request steps inside the 60-second route budget", () => {
    expect(boundedComplianceRecoveryBatchSize(1_000)).toBe(3);
    expect(boundedComplianceRecoveryBatchSize(Number.NaN)).toBe(3);
    expect(boundedComplianceRecoveryBatchSize(0)).toBe(1);
  });

  it("services retention before refusing request claims after its wall-clock budget", async () => {
    mocks.requestFindMany.mockResolvedValue([
      { id: "wcomp_1" },
      { id: "wcomp_2" },
      { id: "wcomp_3" },
    ]);
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2);

    const result = await processShopifyComplianceBatch({
      batchSize: 3,
      workerId: "recovery_1",
      timeBudgetMs: 1,
    });

    now.mockRestore();
    expect(result).toMatchObject({
      selected: 3,
      processed: 0,
      budgetExhausted: true,
      artifactExpiry: { selected: 0, deleted: 0, failed: 0 },
      tombstoneExpiry: {
        customer: { selected: 0, deleted: 0 },
        shop: { selected: 0, deleted: 0 },
      },
    });
    expect(mocks.requestFindUnique).not.toHaveBeenCalled();
    expect(mocks.artifactExpiryDeleteBatch).toHaveBeenCalledOnce();
    expect(mocks.tombstoneExpiryDeleteBatch).toHaveBeenCalledOnce();
    expect(mocks.couponUseExpiryDeleteBatch).toHaveBeenCalledOnce();
  });

  it("does not starve retention across repeated over-budget recovery runs", async () => {
    mocks.requestFindMany.mockResolvedValue([{ id: "wcomp_slow_oldest" }]);

    await processShopifyComplianceBatch({
      batchSize: 3,
      workerId: "recovery_1",
      timeBudgetMs: 0,
    });
    await processShopifyComplianceBatch({
      batchSize: 3,
      workerId: "recovery_2",
      timeBudgetMs: 0,
    });

    expect(mocks.artifactExpiryDeleteBatch).toHaveBeenCalledTimes(2);
    expect(mocks.tombstoneExpiryDeleteBatch).toHaveBeenCalledTimes(2);
    expect(mocks.couponUseExpiryDeleteBatch).toHaveBeenCalledTimes(2);
    expect(mocks.requestFindUnique).not.toHaveBeenCalled();
  });

  it("dead-letters ambiguous email-only identities instead of choosing the first row", async () => {
    mocks.shopperFindMany.mockResolvedValue([{ shopifyCustomerId: "42" }]);
    mocks.customerFindMany.mockResolvedValue([
      { id: "legacy_unbound", externalId: null },
    ]);
    await expect(
      resolveCustomerSubject({
        storeId: "store_1",
        workspaceId: "workspace_1",
        subject: {
          shopDomain: "target.myshopify.com",
          customerEmail: "customer@example.com",
          orderExternalIds: [],
        },
      }),
    ).rejects.toBeInstanceOf(ComplianceOperatorReviewError);
  });

  it("exports native reviews, requests and owned media without submission credentials", async () => {
    mocks.shopperFindUnique.mockResolvedValue({
      id: "shopper_1",
      loyaltyAccount: { id: "account_1" },
    });
    mocks.nativeReviewFindMany.mockResolvedValue([
      { id: "review_1", body: "Honest feedback" },
    ]);
    mocks.nativeRequestFindMany.mockResolvedValue([
      { id: "request_1", status: "submitted" },
    ]);
    mocks.nativeMediaFindMany.mockResolvedValue([
      { id: "media_1", objectKey: "private-review-object" },
    ]);
    mocks.incentiveClaimFindMany.mockResolvedValue([
      { id: "claim_1", policyId: "policy_1", status: "reserved" },
    ]);
    mocks.incentivePolicyFindMany.mockResolvedValue([
      { id: "policy_1", revision: 1 },
    ]);
    mocks.couponUseFindMany.mockResolvedValue([
      {
        id: "use_1",
        discountAmountMinor: BigInt("9007199254740993"),
        currency: "JPY",
      },
    ]);
    for (const [phase, next] of [
      ["export_orders", "export_native_reviews"],
      ["export_native_reviews", "export_review_requests"],
      ["export_review_requests", "export_review_media"],
      ["export_review_media", "export_review_incentive_claims"],
      ["export_review_incentive_claims", "export_coupon_uses"],
      ["export_coupon_uses", "export_review_incentive_invalidations"],
      ["export_review_incentive_invalidations", "export_manifest"],
    ]) {
      const result = await processCustomerDataRequestStep({
        id: "wcomp_native",
        storeId: "store_1",
        phase,
        lockedBy: "worker_1",
        leaseVersion: 1,
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          customerId: "42",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      });
      expect(result.phase).toBe(next);
    }
    expect(mocks.nativeRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store_1", shopperId: "shopper_1" },
        select: expect.objectContaining({ id: true, status: true }),
      }),
    );
    expect(mocks.couponUseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store_1", shopperId: "shopper_1" },
        take: 101,
      }),
    );
    expect(mocks.invalidationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store_1", shopperId: "shopper_1" },
        take: 101,
      }),
    );
    expect(
      mocks.invalidationFindMany.mock.calls[0][0].select,
    ).not.toHaveProperty("actorUserId");
    expect(mocks.artifactStore).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "coupon_uses",
        value: [
          {
            id: "use_1",
            discountAmountMinor: BigInt("9007199254740993"),
            currency: "JPY",
          },
        ],
      }),
    );
    const selected = mocks.nativeRequestFindMany.mock.calls[0][0].select;
    expect(mocks.incentiveClaimFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store_1",
          shopperId: "shopper_1",
        },
      }),
    );
    expect(selected.incentivePolicy.select).not.toHaveProperty("claims");
    expect(mocks.incentivePolicyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store_1", id: { in: ["policy_1"] } },
      }),
    );
    for (const secret of [
      "tokenHash",
      "encryptedDeliveryToken",
      "deliveryToken",
      "deliveryLeaseExpiresAt",
    ])
      expect(selected).not.toHaveProperty(secret);
    expect(mocks.nativeMediaFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store_1",
          request: { storeId: "store_1", shopperId: "shopper_1" },
          status: "uploaded",
        },
      }),
    );
    expect(mocks.nativeMediaDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "private-review-object",
        bucket: "private",
      }),
    );
    expect(mocks.artifactStore).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "review_media",
        value: [
          { id: "media_1", downloadUrl: "https://private.example.test/signed" },
        ],
      }),
    );
  });

  it("checkpoints a 100-record export page and resumes from its exact cursor", async () => {
    mocks.shopperFindUnique.mockResolvedValue({
      id: "shopper_1",
      loyaltyAccount: { id: "account_1" },
    });
    mocks.ledgerFindMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `ledger_${String(index + 1).padStart(3, "0")}`,
      })),
    );
    const result = await processCustomerDataRequestStep({
      id: "wcomp_1",
      storeId: "store_1",
      phase: "export_ledger",
      lockedBy: "worker_1",
      leaseVersion: 1,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });
    expect(result).toMatchObject({
      completed: false,
      phase: "export_ledger",
      cursor: { lastId: "ledger_100", sequence: 1 },
    });
    expect(mocks.artifactStore).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ledger",
        sequence: 0,
        value: expect.any(Array),
      }),
    );
    expect(mocks.artifactStore.mock.calls[0][0].value).toHaveLength(100);
  });

  it("boundedly exports earn grants, order-line earns, and both backfill snapshot formats through their durable owner", async () => {
    mocks.earnGrantFindMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `grant_${String(index + 1).padStart(3, "0")}`,
      })),
    );
    mocks.orderLineEarnFindMany.mockResolvedValue([{ id: "line_earn_001" }]);
    mocks.backfillSnapshotFindMany.mockResolvedValue([{ id: "snapshot_001" }]);
    mocks.backfillPreviewFindMany.mockResolvedValue([{ id: "preview_001" }]);
    const request = {
      id: "wcomp_export_loyalty",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: { chunks: 2, records: 10 },
      store: { projectId: "workspace_1" },
    };

    const grants = await processCustomerDataRequestStep({
      ...request,
      phase: "export_earn_grants",
    });
    expect(grants).toMatchObject({
      completed: false,
      phase: "export_earn_grants",
      cursor: { lastId: "grant_100", sequence: 1 },
      progress: { chunks: 3, records: 110 },
    });
    expect(mocks.earnGrantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: {
          storeId: "store_1",
          OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
        },
      }),
    );
    expect(mocks.artifactStore).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestId: "wcomp_export_loyalty",
        storeId: "store_1",
        kind: "earn_grants",
        sequence: 0,
        value: expect.any(Array),
      }),
    );
    expect(mocks.artifactStore.mock.calls[0][0].value).toHaveLength(100);

    const lineEarns = await processCustomerDataRequestStep({
      ...request,
      phase: "export_order_line_earns",
    });
    expect(lineEarns).toMatchObject({
      completed: false,
      phase: "export_backfill_order_credits",
    });
    expect(mocks.orderLineEarnFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: {
          storeId: "store_1",
          grant: {
            storeId: "store_1",
            OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
          },
        },
      }),
    );
    expect(mocks.artifactStore).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "order_line_earns",
        value: [{ id: "line_earn_001" }],
      }),
    );

    mocks.backfillCreditFindMany.mockResolvedValueOnce([{ id: "credit_001" }]);
    const credits = await processCustomerDataRequestStep({
      ...request,
      phase: "export_backfill_order_credits",
    });
    expect(credits).toMatchObject({
      completed: false,
      phase: "export_backfill_order_snapshots",
    });
    expect(mocks.backfillCreditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: { storeId: "store_1", accountId: "account_42" },
      }),
    );
    expect(mocks.artifactStore).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        kind: "backfill_order_credits",
        value: [{ id: "credit_001" }],
      }),
    );

    const snapshots = await processCustomerDataRequestStep({
      ...request,
      phase: "export_backfill_order_snapshots",
    });
    expect(snapshots).toMatchObject({
      completed: false,
      phase: "export_backfill_preview",
    });
    expect(mocks.backfillSnapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: {
          storeId: "store_1",
          OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
        },
      }),
    );
    expect(mocks.artifactStore).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        kind: "backfill_order_snapshots",
        value: [{ id: "snapshot_001" }],
      }),
    );

    const preview = await processCustomerDataRequestStep({
      ...request,
      phase: "export_backfill_preview",
    });
    expect(preview).toMatchObject({
      completed: false,
      phase: "export_redemptions",
    });
    expect(mocks.backfillPreviewFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: {
          job: { storeId: "store_1" },
          OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
        },
      }),
    );
    expect(mocks.artifactStore).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        kind: "backfill_preview",
        value: [{ id: "preview_001" }],
      }),
    );
  });

  it("does not query owner-linked loyalty exports when no durable owner resolved", async () => {
    const request = {
      id: "wcomp_ownerless_export",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    await expect(
      processCustomerDataRequestStep({
        ...request,
        phase: "export_earn_grants",
      }),
    ).resolves.toMatchObject({ phase: "export_order_line_earns" });
    await expect(
      processCustomerDataRequestStep({
        ...request,
        phase: "export_order_line_earns",
      }),
    ).resolves.toMatchObject({ phase: "export_backfill_order_credits" });
    await expect(
      processCustomerDataRequestStep({
        ...request,
        phase: "export_backfill_order_credits",
      }),
    ).resolves.toMatchObject({ phase: "export_backfill_order_snapshots" });
    await expect(
      processCustomerDataRequestStep({
        ...request,
        phase: "export_backfill_order_snapshots",
      }),
    ).resolves.toMatchObject({ phase: "export_backfill_preview" });
    await expect(
      processCustomerDataRequestStep({
        ...request,
        phase: "export_backfill_preview",
      }),
    ).resolves.toMatchObject({ phase: "export_redemptions" });

    expect(mocks.earnGrantFindMany).not.toHaveBeenCalled();
    expect(mocks.orderLineEarnFindMany).not.toHaveBeenCalled();
    expect(mocks.backfillCreditFindMany).not.toHaveBeenCalled();
    expect(mocks.backfillSnapshotFindMany).not.toHaveBeenCalled();
    expect(mocks.backfillPreviewFindMany).not.toHaveBeenCalled();
    expect(mocks.artifactStore).not.toHaveBeenCalled();
  });

  it("exports anonymous friend claims through a rotation-aware email digest without retaining raw email", async () => {
    mocks.referralFindMany.mockResolvedValue([
      {
        id: "wreferral_friend_1",
        status: "pending",
        friendShopifyDiscountCode: "WLF-SAFE-CODE",
      },
    ]);
    const request = {
      id: "wcomp_friend_export",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      subjectDigest: "SAFE_SUBJECT_DIGEST",
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };
    const received = await processCustomerDataRequestStep({
      ...request,
      phase: "received",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerEmail: "friend@example.com",
        orderExternalIds: [],
      }),
    });

    expect(received.payloadCiphertext).not.toContain("friend@example.com");
    expect(received.payloadCiphertext).toContain("FRIEND_EMAIL_DIGEST");

    const exported = await processCustomerDataRequestStep({
      ...request,
      phase: "export_friend_referral_claims",
      payloadCiphertext: received.payloadCiphertext,
    });
    expect(exported).toMatchObject({
      completed: false,
      phase: "export_orders",
    });
    expect(mocks.referralFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store_1",
          friendEmailDigest: {
            in: ["hmac:v1:kid_1:FRIEND_EMAIL_DIGEST"],
          },
        },
        select: expect.not.objectContaining({ friendEmailDigest: true }),
      }),
    );
    expect(mocks.artifactStore).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "friend_referral_claims",
        value: [
          {
            id: "wreferral_friend_1",
            status: "pending",
            friendShopifyDiscountCode: "WLF-SAFE-CODE",
          },
        ],
      }),
    );
  });

  it("exports retained post-redaction records through the unexpired HMAC owner", async () => {
    mocks.customerFindUnique.mockResolvedValue(null);
    mocks.shopperFindUnique.mockResolvedValue(null);
    mocks.privacyTombstoneFindMany.mockResolvedValue([
      { shopperId: "shopper_redacted", accountId: "account_redacted" },
    ]);

    const result = await processCustomerDataRequestStep({
      id: "wcomp_post_redaction",
      storeId: "store_1",
      phase: "received",
      lockedBy: "worker_1",
      leaseVersion: 1,
      subjectDigest: "SAFE_DIGEST",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result.phase).toBe("export_identity");
    expect(result.payloadCiphertext).toContain("shopper_redacted");
    expect(result.payloadCiphertext).toContain("account_redacted");
    expect(result.payloadCiphertext).not.toContain('"customerId":"42"');
    expect(mocks.privacyTombstoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_1",
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it("keeps customer redaction pending until voucher cleanup is terminal", async () => {
    mocks.voucherTerminalCounts.mockResolvedValue({
      outstanding: 1,
      completed: 0,
      deadLetter: 0,
      cancelled: 0,
      total: 1,
    });
    const result = await processCustomerRedactStep({
      id: "wcomp_redact",
      storeId: "store_1",
      phase: "customer_voucher_cleanup",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: [],
      }),
      store: { projectId: "workspace_1" },
    });
    expect(result).toMatchObject({
      completed: false,
      phase: "customer_voucher_cleanup",
      progress: {
        voucherCleanup: { outstanding: 1 },
      },
    });
    expect(mocks.voucherTerminalCounts).toHaveBeenCalledWith({
      storeId: "store_1",
      requestId: "wcomp_redact",
    });
  });

  it("freezes and tombstones the customer inside the same settlement lock", async () => {
    const events: string[] = [];
    mocks.settlementLocks.mockImplementation(async ({ fn }) => {
      events.push("lock-enter");
      const result = await fn();
      events.push("lock-exit");
      return result;
    });
    mocks.prepareRedaction.mockImplementation(async () => {
      events.push("account-frozen");
      return {
        found: true,
        shopperId: "shopper_1",
        accountId: "account_1",
        redactedAt: new Date("2026-08-30T00:00:00.000Z"),
      };
    });
    mocks.tombstoneCustomer.mockImplementation(async () => {
      events.push("tombstone");
      return [];
    });

    const result = await processCustomerRedactStep({
      id: "wcomp_redact",
      storeId: "store_1",
      subjectDigest: "SAFE_EMAIL_DIGEST",
      phase: "freeze_customer",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        customerEmail: "member@example.com",
        orderExternalIds: [],
      }),
      store: { projectId: "workspace_1" },
    });

    expect(events).toEqual([
      "lock-enter",
      "account-frozen",
      "tombstone",
      "lock-exit",
    ]);
    expect(mocks.settlementLocks).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      storeId: "store_1",
      shopifyCustomerId: "42",
      fn: expect.any(Function),
    });
    expect(result).toMatchObject({
      phase: "revoke_customer_exports",
    });
    // The test encryption mock is identity-only. Production keeps the raw
    // email solely inside ciphertext until the rotation-aware export fence has
    // converged; it must never escape into cursor/progress state.
    expect(JSON.stringify(result.progress)).not.toContain("member@example.com");
  });

  it("revokes matching completed and in-flight exports before customer erasure", async () => {
    mocks.deriveCustomerIdentities.mockReturnValueOnce([
      {
        identityKind: "customer_id",
        identityKeyId: "kid_1",
        customerDigest: "SAFE_DIGEST",
      },
      {
        identityKind: "customer_id",
        identityKeyId: "previous_kid",
        customerDigest: "PREVIOUS_SAFE_DIGEST",
      },
    ]);
    mocks.artifactCustomerDeleteBatch.mockResolvedValueOnce({
      selected: 1,
      deleted: 1,
      failed: 0,
    });
    const request = {
      id: "wcomp_redact",
      storeId: "store_1",
      subjectKind: "customer_id",
      subjectKeyId: "kid_1",
      subjectDigest: "SAFE_DIGEST",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "revoke_customer_exports",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: {
        ownerShopperId: "shopper_42",
        ownerAccountId: "account_42",
      },
      store: { projectId: "workspace_1" },
    };

    const result = await processCustomerRedactStep(request);

    expect(result).toMatchObject({
      phase: "revoke_customer_exports",
      progress: { customerExportArtifactsDeleted: 1 },
    });
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_1",
          requestType: "customer_data_request",
          OR: expect.arrayContaining([
            {
              subjectKind: "customer_id",
              subjectKeyId: "kid_1",
              subjectDigest: "SAFE_DIGEST",
            },
            {
              subjectKind: "customer_id",
              subjectKeyId: "previous_kid",
              subjectDigest: "PREVIOUS_SAFE_DIGEST",
            },
          ]),
          AND: expect.arrayContaining([
            {
              NOT: {
                phase: { startsWith: "superseded_by_shop_redact:" },
              },
            },
          ]),
        }),
        data: expect.objectContaining({
          status: "completed",
          phase: "superseded_by_customer_redact:wcomp_redact",
          leaseVersion: { increment: 1 },
          payloadCiphertext: null,
          subjectDigest: null,
          lockedBy: null,
        }),
      }),
    );
    const exportFilters = mocks.requestUpdateMany.mock.calls[0][0].where.OR;
    expect(exportFilters).not.toContainEqual({
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
    });
    expect(mocks.artifactCustomerDeleteBatch).toHaveBeenCalledWith({
      storeId: "store_1",
      supersededPhase: "superseded_by_customer_redact:wcomp_redact",
      batchSize: 20,
    });
  });

  it("permanently supersedes every scrubbed export when an ownerless redaction cannot prove any owner unrelated", async () => {
    mocks.deriveCustomerIdentities.mockReturnValueOnce([
      {
        identityKind: "customer_id",
        identityKeyId: "kid_1",
        customerDigest: "NEW_REDACTION_DIGEST",
      },
    ]);
    mocks.artifactCustomerDeleteBatch.mockResolvedValueOnce({
      selected: 1,
      deleted: 1,
      failed: 0,
    });

    const result = await processCustomerRedactStep({
      id: "wcomp_redact_ownerless",
      storeId: "store_1",
      subjectKind: "customer_id",
      subjectKeyId: "kid_1",
      subjectDigest: "NEW_REDACTION_DIGEST",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "revoke_customer_exports",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: ["order-retained-1"],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      phase: "revoke_customer_exports",
      progress: { customerExportArtifactsDeleted: 1 },
    });
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              AND: [
                {
                  subjectKind: null,
                  subjectKeyId: null,
                  subjectDigest: null,
                },
              ],
            },
          ]),
          AND: expect.arrayContaining([
            {
              NOT: {
                phase: { startsWith: "superseded_by_customer_redact:" },
              },
            },
          ]),
        }),
        data: expect.objectContaining({
          phase: "superseded_by_customer_redact:wcomp_redact_ownerless",
          payloadCiphertext: null,
          subjectDigest: null,
        }),
      }),
    );
    expect(mocks.artifactCustomerDeleteBatch).toHaveBeenCalledWith({
      storeId: "store_1",
      supersededPhase: "superseded_by_customer_redact:wcomp_redact_ownerless",
      batchSize: 20,
    });
  });

  it("permanently supersedes a legacy-owner export when redaction resolves only a shopper owner", async () => {
    mocks.artifactCustomerDeleteBatch.mockResolvedValueOnce({
      selected: 1,
      deleted: 1,
      failed: 0,
    });

    await processCustomerRedactStep({
      id: "wcomp_redact_shopper_owner",
      storeId: "store_1",
      subjectKind: "customer_id",
      subjectKeyId: "kid_1",
      subjectDigest: "NEW_REDACTION_DIGEST",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "revoke_customer_exports",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        shopperId: "shopper_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: { ownerShopperId: "shopper_42" },
      store: { projectId: "workspace_1" },
    });

    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              AND: [
                {
                  subjectKind: null,
                  subjectKeyId: null,
                  subjectDigest: null,
                },
                {
                  progress: {
                    path: "$.ownerShopperId",
                    equals: Prisma.AnyNull,
                  },
                },
              ],
            },
          ]),
        }),
      }),
    );
  });

  it("does not let a stale customer redaction weaken a completed shop-redaction fence", async () => {
    mocks.storeQueryRaw.mockResolvedValueOnce([
      { id: "store_1", complianceState: "redacted" },
    ]);

    await expect(
      processCustomerRedactStep({
        id: "wcomp_stale_customer_redact",
        storeId: "store_1",
        subjectKind: "customer_id",
        subjectKeyId: "kid_1",
        subjectDigest: "SAFE_DIGEST",
        lockedBy: "worker_1",
        leaseVersion: 1,
        phase: "revoke_customer_exports",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          customerId: "42",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).rejects.toThrow(
      "Compliance request lease no longer authorizes privacy mutation.",
    );

    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.artifactCustomerDeleteBatch).not.toHaveBeenCalled();
  });

  it("keeps the first shop-redaction supersession source immutable", async () => {
    const result = await processShopRedactStep({
      id: "wcomp_second_shop_redact",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "purge_export_artifacts",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result.phase).toBe("credential_scrub");
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: {
            phase: { startsWith: "superseded_by_shop_redact:" },
          },
        }),
        data: expect.objectContaining({
          phase: "superseded_by_shop_redact:wcomp_second_shop_redact",
        }),
      }),
    );
  });

  it("routes a reviews-only shopper through voucher enumeration before identity erasure", async () => {
    mocks.artifactCustomerDeleteBatch.mockResolvedValueOnce({
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    const request = {
      id: "wcomp_shopper_only",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "revoke_customer_exports",
      cursor: null,
      progress: null,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        shopperId: "shopper_42",
        orderExternalIds: [],
      }),
      store: { projectId: "workspace_1" },
    };
    expect(await processCustomerRedactStep(request)).toMatchObject({
      phase: "enumerate_customer_vouchers",
    });
    mocks.voucherEnumerationStep.mockResolvedValueOnce({
      completed: false,
      phase: "scrub_customer_identity",
      cursor: null,
      progress: {},
    });
    expect(
      await processCustomerRedactStep({
        ...request,
        phase: "enumerate_customer_vouchers",
      }),
    ).toMatchObject({ phase: "purge_customer_order_cache" });
    expect(mocks.voucherEnumerationStep).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: request.id,
        storeId: request.storeId,
        shopperId: "shopper_42",
        accountId: undefined,
      }),
    );
  });

  it("checkpoints bounded voucher enumeration without embedding cleanup IDs", async () => {
    mocks.voucherEnumerationStep.mockResolvedValue({
      completed: false,
      phase: "enumerate_customer_vouchers",
      cursor: {
        afterCreatedAt: "2026-08-30T00:00:00.000Z",
        afterRedemptionId: "redemption_100",
        drainUntil: "2026-08-30T00:02:00.000Z",
      },
      progress: { lastBatchScanned: 100 },
    });
    const result = await processCustomerRedactStep({
      id: "wcomp_redact",
      storeId: "store_1",
      phase: "enumerate_customer_vouchers",
      cursor: { afterRedemptionId: "redemption_0" },
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      store: { projectId: "workspace_1" },
    });

    expect(mocks.voucherEnumerationStep).toHaveBeenCalledWith({
      requestId: "wcomp_redact",
      storeId: "store_1",
      accountId: "account_42",
      cursor: { afterRedemptionId: "redemption_0" },
    });
    expect(result).toMatchObject({
      phase: "enumerate_customer_vouchers",
      cursor: { afterRedemptionId: "redemption_100" },
      delaySeconds: 0,
    });
    expect(JSON.stringify(result)).not.toContain("cleanupIds");
  });

  it("pseudonymizes the exact Shopify identities and removes customer email", async () => {
    const result = await processCustomerRedactStep({
      id: "wcomp_redact",
      storeId: "store_1",
      subjectDigest: "SAFE_DIGEST",
      phase: "scrub_customer_identity",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        legacyCustomerId: "legacy_42",
        shopperId: "shopper_42",
        accountId: "account_42",
        redactedAt: "2026-08-30T00:00:00.000Z",
        orderExternalIds: [],
      }),
      store: { projectId: "workspace_1" },
    });

    expect(result.phase).toBe("scrub_account_outbox");
    expect(mocks.scrubCustomerContext).toHaveBeenCalledWith(
      expect.objectContaining({
        shopifyCustomerId: "42",
        shopperId: "shopper_42",
        accountId: "account_42",
      }),
    );
    expect(mocks.customerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "legacy_42", projectId: "workspace_1" },
        data: expect.objectContaining({
          externalId: "redacted:v1:kid_1:42",
          email: null,
        }),
      }),
    );
    expect(JSON.stringify(mocks.customerUpdateMany.mock.calls)).not.toContain(
      "member@example.com",
    );
  });

  it("bounds shop pseudonymization to 20 shoppers and redacts only exact legacy IDs", async () => {
    mocks.shopperFindMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        id: `shopper_${String(index + 1).padStart(2, "0")}`,
        shopifyCustomerId: String(index + 1),
        email: `c${index + 1}@example.com`,
        loyaltyAccount: { id: `account_${index + 1}` },
      })),
    );
    mocks.tombstoneCustomer.mockImplementation(
      async ({ shopifyCustomerId }) => [
        {
          identityKind: "customer_id",
          identityKeyId: "kid_1",
          customerDigest: `digest_${shopifyCustomerId}`,
        },
      ],
    );
    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "redact_shoppers",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });
    expect(result).toMatchObject({
      completed: false,
      phase: "redact_shoppers",
      cursor: { lastId: "shopper_20" },
    });
    expect(mocks.shopperUpdate).toHaveBeenCalledTimes(20);
    expect(mocks.prepareRedaction).toHaveBeenCalledTimes(20);
    expect(mocks.customerCacheIndexPurge).toHaveBeenCalledTimes(20);
    expect(mocks.customerUpdateMany).toHaveBeenCalledTimes(20);
    expect(mocks.customerUpdateMany.mock.calls[0][0].where).toEqual({
      projectId: "workspace_1",
      externalId: "1",
    });
    expect(mocks.customerUpdateMany.mock.calls[0][0].data.externalId).toBe(
      "redacted:v1:kid_1:1",
    );
    expect(mocks.shopperUpdate.mock.calls[0][0].data.shopifyCustomerId).toBe(
      "redacted:v1:kid_1:1",
    );
    expect(
      mocks.customerUpdateMany.mock.calls.some(
        ([input]) => input.where?.email !== undefined,
      ),
    ).toBe(false);
  });

  it("does not chain a retained pseudonym when a shop-redact page checkpoint is lost", async () => {
    const retainedPseudonym = `redacted:v1:kid_1:${"A".repeat(64)}`;
    mocks.shopperFindMany.mockResolvedValue([
      {
        id: "shopper_already_redacted",
        shopifyCustomerId: retainedPseudonym,
        email: null,
        loyaltyAccount: { id: "account_1" },
      },
    ]);
    mocks.parsePseudonym.mockReturnValue({
      value: retainedPseudonym,
      identityKeyId: "kid_1",
      customerDigest: "A".repeat(64),
    });

    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "redact_shoppers",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: { lastId: "shopper_before_lost_checkpoint" },
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      completed: false,
      phase: "redact_order_calculations",
    });
    expect(mocks.prepareRedaction).not.toHaveBeenCalled();
    expect(mocks.tombstoneCustomer).not.toHaveBeenCalled();
    expect(mocks.pseudonym).not.toHaveBeenCalled();
    expect(mocks.customerUpdateMany).not.toHaveBeenCalled();
    expect(mocks.shopperUpdate).not.toHaveBeenCalled();
    expect(retainedPseudonym).toBe(`redacted:v1:kid_1:${"A".repeat(64)}`);
  });

  it("does not let a stale received-phase worker thaw a store already finalized as redacted", async () => {
    mocks.storeQueryRaw.mockResolvedValueOnce([
      {
        id: "store_1",
        complianceState: "redacted",
      },
    ]);

    await expect(
      processShopRedactStep({
        id: "wcomp_stale_shop_redact",
        storeId: "store_1",
        lockedBy: "worker_1",
        leaseVersion: 1,
        receivedAt: new Date("2026-08-30T00:00:00.000Z"),
        phase: "received",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).resolves.toEqual({ completed: true, phase: "already_redacted" });

    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.programUpdateMany).not.toHaveBeenCalled();
  });

  it("scrubs anonymous friend vouchers before shop-redact cache and credential cleanup", async () => {
    const receivedAt = new Date("2026-08-30T00:00:00.000Z");
    mocks.redactFriendShopBatch.mockResolvedValueOnce({
      scrubbed: 20,
      hasMore: true,
      lastId: "wreferral_020",
    });

    const result = await processShopRedactStep({
      id: "wcomp_friend_shop_redact",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      receivedAt,
      phase: "scrub_shop_friend_referral_claims",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: { lastId: "wreferral_000" },
      progress: { shopFriendReferralClaimsScrubbed: 5 },
      store: { projectId: "workspace_1" },
    });

    expect(mocks.redactFriendShopBatch).toHaveBeenCalledWith({
      storeId: "store_1",
      afterId: "wreferral_000",
      batchSize: 20,
      redactedAt: receivedAt,
    });
    expect(result).toMatchObject({
      completed: false,
      phase: "scrub_shop_friend_referral_claims",
      cursor: { lastId: "wreferral_020" },
      progress: { shopFriendReferralClaimsScrubbed: 25 },
    });
    expect(mocks.storeCachePurge).not.toHaveBeenCalled();
  });

  it("uses the authenticated shop-redact receipt time for the kill-switch timestamp", async () => {
    const receivedAt = new Date("2026-08-29T23:59:58.000Z");
    mocks.storeQueryRaw.mockResolvedValueOnce([
      { id: "store_1", complianceState: "active" },
    ]);

    await expect(
      processShopRedactStep({
        id: "wcomp_received_timestamp",
        storeId: "store_1",
        lockedBy: "worker_1",
        leaseVersion: 1,
        receivedAt,
        phase: "received",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).resolves.toEqual({ completed: false, phase: "enumerate_vouchers" });

    expect(mocks.programUpdateMany).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
      data: {
        status: "disabled",
        killSwitchActive: true,
        disabledAt: receivedAt,
      },
    });
    expect(mocks.publishPolicyRevision).toHaveBeenCalledWith({
      tx: expect.objectContaining({
        weleticShopifyStore: { update: mocks.storeUpdate },
        weleticLoyaltyProgram: { updateMany: mocks.programUpdateMany },
      }),
      storeId: "store_1",
      programId: "program_1",
      reason: "shopify_shop_redact_frozen",
    });
  });

  it("does not recreate a policy revision when another shop-redact worker revisits a post-scrub frozen store", async () => {
    mocks.storeQueryRaw.mockResolvedValueOnce([
      { id: "store_1", complianceState: "frozen" },
    ]);
    mocks.programQueryRaw.mockResolvedValueOnce([
      {
        id: "program_1",
        disabledAt: new Date("2026-08-29T23:59:58.000Z"),
      },
    ]);

    await expect(
      processShopRedactStep({
        id: "wcomp_duplicate_after_policy_scrub",
        storeId: "store_1",
        lockedBy: "worker_1",
        leaseVersion: 1,
        receivedAt: new Date("2026-08-30T00:00:00.000Z"),
        phase: "received",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).resolves.toEqual({ completed: false, phase: "enumerate_vouchers" });

    expect(mocks.programUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.publishPolicyRevision).not.toHaveBeenCalled();
  });

  it("preserves an earlier durable kill-switch timestamp during delayed shop-redact recovery", async () => {
    const earlierDisabledAt = new Date("2026-08-29T23:58:00.000Z");
    mocks.storeQueryRaw.mockResolvedValueOnce([
      { id: "store_1", complianceState: "active" },
    ]);
    mocks.programQueryRaw.mockResolvedValueOnce([
      { id: "program_1", disabledAt: earlierDisabledAt },
    ]);

    await processShopRedactStep({
      id: "wcomp_later_received",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      phase: "received",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(mocks.programUpdateMany).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
      data: {
        status: "disabled",
        killSwitchActive: true,
        disabledAt: earlierDisabledAt,
      },
    });
  });

  it("rejects a reclaimed shop-redact received worker before freezing the store", async () => {
    mocks.requestLeaseQueryRaw.mockResolvedValueOnce([
      {
        id: "wcomp_reclaimed_received",
        status: "processing",
        lockedBy: "worker_new",
        leaseVersion: 2,
      },
    ]);

    await expect(
      processShopRedactStep({
        id: "wcomp_reclaimed_received",
        storeId: "store_1",
        lockedBy: "worker_stale",
        leaseVersion: 1,
        receivedAt: new Date("2026-08-30T00:00:00.000Z"),
        phase: "received",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).rejects.toThrow(
      "Compliance request lease no longer authorizes privacy mutation.",
    );

    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.programUpdateMany).not.toHaveBeenCalled();
  });

  it("makes a stale repeated shop finalizer read-only and preserves the first tombstone source", async () => {
    const financialRetentionUntil = new Date("2033-08-30T00:00:00.000Z");
    mocks.storeQueryRaw.mockResolvedValueOnce([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "redacted-kid_1-SAFE_SHOP_DIGEST_1234567890.invalid",
        complianceState: "redacted",
        redactedAt: new Date("2026-08-30T00:00:00.000Z"),
        financialRetentionUntil,
      },
    ]);

    await expect(
      processShopRedactStep({
        id: "wcomp_stale_finalizer",
        storeId: "store_1",
        phase: "finalize",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).resolves.toMatchObject({
      completed: true,
      phase: "completed",
      progress: {
        financialRetentionUntil: financialRetentionUntil.toISOString(),
      },
    });

    expect(mocks.shopPrivacyTombstoneFindFirst).toHaveBeenCalledOnce();
    expect(mocks.tombstoneShop).not.toHaveBeenCalled();
    expect(mocks.appSessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.coordinationDeleteMany).not.toHaveBeenCalled();
    expect(mocks.installIntentDeleteMany).not.toHaveBeenCalled();
    expect(mocks.installationDeleteMany).not.toHaveBeenCalled();
    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("waits for the catalog-sync lock before purging shop catalog state", async () => {
    mocks.withDistributedLock.mockImplementation(async ({ onLocked }) =>
      onLocked(),
    );
    await expect(
      processShopRedactStep({
        id: "wcomp_shop",
        storeId: "store_1",
        phase: "purge_catalog",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).rejects.toThrow("Catalog sync is still draining");
    expect(mocks.withDistributedLock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "weletic:catalog-sync:workspace_1",
        onLocked: expect.any(Function),
      }),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("deletes legacy checkout payloads before customer identity scrubbing", async () => {
    mocks.orderFindMany.mockResolvedValue([
      { id: "order_1", checkoutToken: "legacy-customer-checkout" },
    ]);

    const result = await processCustomerRedactStep({
      id: "wcomp_customer_cache",
      storeId: "store_1",
      phase: "purge_customer_order_cache",
      cursor: null,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        shopperId: "shopper_42",
        orderExternalIds: [],
      }),
      store: { projectId: "workspace_1" },
    });

    expect(mocks.checkoutCacheDelete).toHaveBeenCalledWith(
      "legacy-customer-checkout",
    );
    expect(result.phase).toBe("purge_customer_cache");
  });

  it("boundedly deletes customer-owned backfill previews and retries without touching another store", async () => {
    mocks.backfillPreviewFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 21 }, (_, index) => ({
          id: `preview_${String(index + 1).padStart(2, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ id: "preview_21" }])
      .mockResolvedValueOnce([]);
    const request = {
      id: "wcomp_customer_backfill",
      storeId: "store_1",
      phase: "purge_customer_backfill_preview",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: { customerBackfillPreviewDeleted: 4 },
      store: { projectId: "workspace_1" },
    };

    const first = await processCustomerRedactStep(request);
    expect(first).toMatchObject({
      completed: false,
      phase: "purge_customer_backfill_preview",
      cursor: Prisma.DbNull,
      progress: { customerBackfillPreviewDeleted: 24 },
    });
    expect(mocks.backfillSnapshotFindMany).toHaveBeenCalledWith({
      take: 21,
      orderBy: { id: "asc" },
      where: {
        storeId: "store_1",
        OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
      },
      select: { id: true },
    });
    expect(mocks.backfillPreviewDeleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: Array.from(
            { length: 20 },
            (_, index) => `preview_${String(index + 1).padStart(2, "0")}`,
          ),
        },
        job: { storeId: "store_1" },
        OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
      },
    });

    const retry = await processCustomerRedactStep({
      ...request,
      cursor: first.cursor,
      progress: first.progress,
    });
    expect(retry).toMatchObject({
      completed: false,
      phase: "scrub_customer_earn_grants",
      progress: { customerBackfillPreviewDeleted: 25 },
    });
    expect(mocks.backfillPreviewDeleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["preview_21"] },
        job: { storeId: "store_1" },
        OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
      },
    });

    await expect(
      processCustomerRedactStep({
        ...request,
        cursor: first.cursor,
        progress: retry.progress,
      }),
    ).resolves.toMatchObject({
      phase: "scrub_customer_earn_grants",
      progress: { customerBackfillPreviewDeleted: 25 },
    });
    expect(mocks.backfillPreviewDeleteMany).toHaveBeenCalledTimes(2);
  });

  it("deletes immutable customer backfill snapshots before legacy previews", async () => {
    mocks.backfillSnapshotFindMany
      .mockResolvedValueOnce([{ id: "snapshot_01" }])
      .mockResolvedValueOnce([]);
    const request = {
      id: "wcomp_customer_backfill_snapshot",
      storeId: "store_1",
      phase: "purge_customer_backfill_preview",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const deleted = await processCustomerRedactStep(request);
    expect(deleted).toMatchObject({
      completed: false,
      phase: "purge_customer_backfill_preview",
      progress: { customerBackfillOrderSnapshotsDeleted: 1 },
    });
    expect(mocks.backfillSnapshotDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["snapshot_01"] },
        storeId: "store_1",
        OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
      },
    });
    expect(mocks.backfillCreditDeleteMany).toHaveBeenCalledWith({
      where: {
        storeId: "store_1",
        snapshotId: { in: ["snapshot_01"] },
      },
    });

    await expect(
      processCustomerRedactStep({
        ...request,
        cursor: deleted.cursor,
        progress: deleted.progress,
      }),
    ).resolves.toMatchObject({
      completed: false,
      phase: "scrub_customer_earn_grants",
      progress: { customerBackfillOrderSnapshotsDeleted: 1 },
    });
  });

  it("deletes customer backfill credit markers before their snapshots", async () => {
    mocks.backfillCreditFindMany.mockResolvedValueOnce([{ id: "credit_01" }]);
    const result = await processCustomerRedactStep({
      id: "wcomp_customer_backfill_credit",
      storeId: "store_1",
      phase: "purge_customer_backfill_preview",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      completed: false,
      phase: "purge_customer_backfill_preview",
      progress: { customerBackfillOrderCreditsDeleted: 1 },
    });
    expect(mocks.backfillCreditDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["credit_01"] },
        storeId: "store_1",
        accountId: "account_42",
      },
    });
    expect(mocks.backfillSnapshotFindMany).not.toHaveBeenCalled();
  });

  it("boundedly scrubs earn-grant customer context while preserving ownership and financial FKs", async () => {
    mocks.earnGrantFindMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        id: `grant_${String(index + 1).padStart(2, "0")}`,
        calculationSnapshot: {
          customerEmail: `member${index + 1}@example.com`,
          retainedRuleId: "earning_rule_1",
          retainedOrderAmount: 125,
        },
        metadata: {
          orderName: `#${index + 1}`,
          retainedSource: "shopify_order",
        },
      })),
    );
    const result = await processCustomerRedactStep({
      id: "wcomp_customer_grants",
      storeId: "store_1",
      phase: "scrub_customer_earn_grants",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      completed: false,
      phase: "scrub_customer_earn_grants",
      cursor: { lastId: "grant_20" },
      progress: { customerEarnGrantsScrubbed: 20 },
    });
    expect(mocks.earnGrantUpdateMany).toHaveBeenCalledTimes(20);
    expect(mocks.earnGrantUpdateMany.mock.calls[0][0]).toEqual({
      where: {
        id: "grant_01",
        storeId: "store_1",
        OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
      },
      data: {
        calculationSnapshot: {
          retainedRuleId: "earning_rule_1",
          retainedOrderAmount: 125,
        },
        metadata: { retainedSource: "shopify_order" },
      },
    });
    expect(
      mocks.earnGrantUpdateMany.mock.calls.every(
        ([input]) =>
          !("accountId" in input.data) &&
          !("shopperId" in input.data) &&
          !("storeId" in input.data) &&
          !("ledgerEntryId" in input.data),
      ),
    ).toBe(true);
    expect(JSON.stringify(mocks.earnGrantUpdateMany.mock.calls)).not.toContain(
      "@example.com",
    );
  });

  it("boundedly scrubs order-line earn context without severing its grant or order-line FKs", async () => {
    mocks.orderLineEarnFindMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        id: `line_earn_${String(index + 1).padStart(2, "0")}`,
        metadata: {
          customerClassification: "member",
          retainedProductId: "product_1",
          retainedQuantity: 2,
        },
      })),
    );
    const result = await processCustomerRedactStep({
      id: "wcomp_customer_line_earns",
      storeId: "store_1",
      phase: "scrub_customer_order_line_earns",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        shopperId: "shopper_42",
        accountId: "account_42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      completed: false,
      phase: "scrub_customer_order_line_earns",
      cursor: { lastId: "line_earn_20" },
      progress: { customerOrderLineEarnsScrubbed: 20 },
    });
    expect(mocks.orderLineEarnUpdateMany).toHaveBeenCalledTimes(20);
    expect(mocks.orderLineEarnUpdateMany.mock.calls[0][0]).toEqual({
      where: {
        id: "line_earn_01",
        storeId: "store_1",
        grant: {
          storeId: "store_1",
          OR: [{ accountId: "account_42" }, { shopperId: "shopper_42" }],
        },
      },
      data: {
        metadata: {
          retainedProductId: "product_1",
          retainedQuantity: 2,
        },
      },
    });
    expect(
      mocks.orderLineEarnUpdateMany.mock.calls.every(
        ([input]) =>
          !("grantId" in input.data) &&
          !("orderLineId" in input.data) &&
          !("storeId" in input.data),
      ),
    ).toBe(true);
  });

  it("deletes every store checkout cache before clearing retained tokens", async () => {
    mocks.orderFindMany.mockResolvedValue([
      { id: "order_1", checkoutToken: "legacy-store-checkout" },
    ]);

    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "redact_orders",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(mocks.checkoutCacheDelete).toHaveBeenCalledWith(
      "legacy-store-checkout",
    );
    expect(mocks.orderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["order_1"] }, storeId: "store_1" },
        data: expect.objectContaining({
          checkoutToken: null,
          orderName: null,
          customerOrderSequence: null,
          customerClassification: "unknown",
          customerSegmentIds: expect.anything(),
          shopperId: null,
        }),
      }),
    );
    expect(result.phase).toBe("scrub_shop_account_context");
  });

  it("boundedly removes customer-derived commission inputs before retaining orders", async () => {
    mocks.calculationFindMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        id: `calculation_${String(index + 1).padStart(2, "0")}`,
        inputs: {
          orderName: `#${index + 1}`,
          customerEmail: `customer${index + 1}@example.com`,
          retainedFinancialRule: "rule_1",
        },
      })),
    );

    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "redact_order_calculations",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      phase: "redact_order_calculations",
      cursor: { lastId: "calculation_20" },
    });
    expect(mocks.calculationUpdateMany).toHaveBeenCalledTimes(20);
    expect(mocks.calculationUpdateMany.mock.calls[0][0].data.inputs).toEqual({
      retainedFinancialRule: "rule_1",
    });
    expect(
      JSON.stringify(
        mocks.calculationUpdateMany.mock.calls.map(([input]) => input.data),
      ),
    ).not.toContain("customer1@example.com");
  });

  it("boundedly scrubs every shop account and retains only a privacy tombstone", async () => {
    mocks.accountFindFirst
      .mockResolvedValueOnce({ id: "account_1" })
      .mockResolvedValueOnce(null);
    mocks.scrubAccountStep.mockResolvedValueOnce({
      completed: true,
      phase: "completed",
      cursor: null,
    });

    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "scrub_shop_account_context",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };
    const first = await processShopRedactStep(request);
    expect(first).toMatchObject({
      phase: "scrub_shop_account_context",
      cursor: { afterAccountId: "account_1" },
    });
    expect(mocks.accountUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account_1", storeId: "store_1" },
        data: expect.objectContaining({
          status: "closed",
          referralCode: null,
          referredById: null,
          metadata: {
            shopifyCustomerRedaction: expect.objectContaining({
              status: "redacted",
            }),
          },
        }),
      }),
    );
    expect(mocks.scrubAccountStep).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_1",
        accountId: "account_1",
        shopErasure: true,
      }),
    );

    const second = await processShopRedactStep({
      ...request,
      cursor: first.cursor,
    });
    expect(second.phase).toBe("scrub_redacted_referral_links");
  });

  it("removes raw shop destinations from referral links redacted earlier", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { id: "link_redacted_1" },
      { id: "link_redacted_2" },
    ]);

    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "scrub_redacted_referral_links",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(mocks.linkUpdateMany).toHaveBeenCalledWith({
      where: {
        projectId: "workspace_1",
        id: { in: ["link_redacted_1", "link_redacted_2"] },
      },
      data: { url: "https://redacted.invalid" },
    });
    expect(result.phase).toBe("scrub_shop_earn_grants");
  });

  it("boundedly scrubs retained earn snapshots before deleting shop backfill state", async () => {
    mocks.earnGrantFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 21 }, (_, index) => ({
          id: `grant_${String(index + 1).padStart(2, "0")}`,
          calculationSnapshot: {
            shopifyCustomerId: `customer_${index}`,
            policyVersion: "retained-v1",
          },
          metadata: {
            nested: { email: `customer-${index}@example.com`, retained: true },
          },
        })),
      )
      .mockResolvedValueOnce([
        {
          id: "grant_21",
          calculationSnapshot: { customerEmail: "last@example.com" },
          metadata: null,
        },
      ]);
    mocks.orderLineEarnFindMany.mockResolvedValueOnce([
      {
        id: "line_earn_1",
        metadata: {
          customerName: "Raw customer",
          retainedCalculation: "financial",
        },
      },
    ]);
    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const grants = await processShopRedactStep({
      ...request,
      phase: "scrub_shop_earn_grants",
    });
    expect(grants).toMatchObject({
      completed: false,
      phase: "scrub_shop_earn_grants",
      cursor: { lastId: "grant_20" },
      progress: { shopEarnGrantsScrubbed: 20 },
    });
    expect(mocks.earnGrantUpdateMany).toHaveBeenCalledTimes(20);
    expect(mocks.earnGrantUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "grant_01", storeId: "store_1" },
      data: {
        calculationSnapshot: { policyVersion: "retained-v1" },
        metadata: { nested: { retained: true } },
      },
    });

    await expect(
      processShopRedactStep({
        ...request,
        phase: "scrub_shop_earn_grants",
        cursor: grants.cursor,
        progress: grants.progress,
      }),
    ).resolves.toMatchObject({
      completed: false,
      phase: "scrub_shop_order_line_earns",
      progress: { shopEarnGrantsScrubbed: 21 },
    });

    await expect(
      processShopRedactStep({
        ...request,
        phase: "scrub_shop_order_line_earns",
      }),
    ).resolves.toMatchObject({
      completed: false,
      phase: "purge_loyalty_backfill",
      progress: { shopOrderLineEarnsScrubbed: 1 },
    });
    expect(mocks.orderLineEarnUpdateMany).toHaveBeenCalledWith({
      where: { id: "line_earn_1", storeId: "store_1" },
      data: { metadata: { retainedCalculation: "financial" } },
    });
  });

  it("drains bounded backfill previews before jobs and converges idempotently", async () => {
    mocks.backfillPreviewFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 21 }, (_, index) => ({
          id: `preview_${String(index + 1).padStart(2, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ id: "preview_21" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.backfillJobFindMany
      .mockResolvedValueOnce([{ id: "backfill_job_1" }])
      .mockResolvedValueOnce([]);
    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "purge_loyalty_backfill",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const previews = await processShopRedactStep(request);
    expect(previews).toMatchObject({
      completed: false,
      phase: "purge_loyalty_backfill",
      progress: { loyaltyBackfillPreviewsDeleted: 20 },
    });
    expect(mocks.backfillPreviewDeleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: Array.from(
            { length: 20 },
            (_, index) => `preview_${String(index + 1).padStart(2, "0")}`,
          ),
        },
        job: { storeId: "store_1" },
      },
    });
    expect(mocks.backfillJobFindMany).not.toHaveBeenCalled();

    const lastPreview = await processShopRedactStep(request);
    expect(lastPreview).toMatchObject({
      completed: false,
      phase: "purge_loyalty_backfill",
      progress: { loyaltyBackfillPreviewsDeleted: 1 },
    });
    expect(mocks.backfillJobFindMany).not.toHaveBeenCalled();

    const job = await processShopRedactStep(request);
    expect(job).toMatchObject({
      completed: false,
      phase: "purge_loyalty_backfill",
      progress: { loyaltyBackfillJobsDeleted: 1 },
    });
    expect(mocks.backfillJobDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["backfill_job_1"] }, storeId: "store_1" },
    });

    const completed = await processShopRedactStep(request);
    expect(completed).toMatchObject({
      completed: false,
      phase: "purge_loyalty_rules",
    });
    expect(mocks.backfillPreviewDeleteMany).toHaveBeenCalledTimes(2);
    expect(mocks.backfillJobDeleteMany).toHaveBeenCalledOnce();
  });

  it("purges durable backfill credits before snapshots during shop redaction", async () => {
    mocks.backfillCreditFindMany
      .mockResolvedValueOnce([{ id: "credit_01" }])
      .mockResolvedValue([]);
    mocks.backfillSnapshotFindMany
      .mockResolvedValueOnce([{ id: "snapshot_01" }])
      .mockResolvedValue([]);
    const request = {
      id: "wcomp_shop_backfill_order_records",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "purge_loyalty_backfill",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const credit = await processShopRedactStep(request);
    expect(credit).toMatchObject({
      completed: false,
      phase: "purge_loyalty_backfill",
      progress: { loyaltyBackfillCreditsDeleted: 1 },
    });
    expect(mocks.backfillCreditDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["credit_01"] }, storeId: "store_1" },
    });

    const snapshot = await processShopRedactStep({
      ...request,
      progress: credit.progress,
    });
    expect(snapshot).toMatchObject({
      completed: false,
      phase: "purge_loyalty_backfill",
      progress: {
        loyaltyBackfillCreditsDeleted: 1,
        loyaltyBackfillOrderSnapshotsDeleted: 1,
      },
    });
    expect(mocks.backfillSnapshotDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["snapshot_01"] }, storeId: "store_1" },
    });
  });

  it("boundedly purges operational loyalty rules before retained financial definitions", async () => {
    mocks.earningRuleFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 21 }, (_, index) => ({
          id: `earning_rule_${String(index + 1).padStart(2, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ id: "earning_rule_21" }])
      .mockResolvedValueOnce([]);
    mocks.bonusCampaignFindMany
      .mockResolvedValueOnce([{ id: "campaign_1" }])
      .mockResolvedValueOnce([]);
    mocks.referralRuleFindMany
      .mockResolvedValueOnce([{ id: "referral_rule_1" }])
      .mockResolvedValueOnce([]);
    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "purge_loyalty_rules",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const bounded = await processShopRedactStep(request);
    expect(bounded).toMatchObject({
      completed: false,
      phase: "purge_loyalty_rules",
      progress: { loyaltyOperationalRulesDeleted: 22 },
    });
    expect(mocks.earningRuleDeleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: Array.from(
            { length: 20 },
            (_, index) => `earning_rule_${String(index + 1).padStart(2, "0")}`,
          ),
        },
        program: { storeId: "store_1" },
      },
    });
    expect(mocks.bonusCampaignDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["campaign_1"] },
        program: { storeId: "store_1" },
      },
    });
    expect(mocks.referralRuleDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["referral_rule_1"] },
        program: { storeId: "store_1" },
      },
    });

    await expect(processShopRedactStep(request)).resolves.toMatchObject({
      completed: false,
      phase: "scrub_loyalty_tiers",
      progress: { loyaltyOperationalRulesDeleted: 1 },
    });
    await expect(processShopRedactStep(request)).resolves.toMatchObject({
      completed: false,
      phase: "scrub_loyalty_tiers",
      progress: { loyaltyOperationalRulesDeleted: 0 },
    });
    expect(mocks.earningRuleDeleteMany).toHaveBeenCalledTimes(2);
    expect(mocks.bonusCampaignDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.referralRuleDeleteMany).toHaveBeenCalledOnce();
  });

  it("boundedly purges immutable earn-policy revisions while retaining nullable financial records", async () => {
    mocks.policyRevisionFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 21 }, (_, index) => ({
          id: `policy_revision_${String(index + 1).padStart(2, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ id: "policy_revision_21" }]);
    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      phase: "scrub_loyalty_program",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const bounded = await processShopRedactStep(request);
    expect(bounded).toMatchObject({
      completed: false,
      phase: "scrub_loyalty_program",
      progress: { loyaltyPolicyRevisionsDeleted: 20 },
    });
    expect(mocks.policyRevisionDeleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: Array.from(
            { length: 20 },
            (_, index) =>
              `policy_revision_${String(index + 1).padStart(2, "0")}`,
          ),
        },
        storeId: "store_1",
      },
    });
    expect(mocks.programUpdateMany).not.toHaveBeenCalled();

    const completed = await processShopRedactStep({
      ...request,
      progress: bounded.progress,
    });
    expect(completed).toMatchObject({
      completed: false,
      phase: "purge_native_reviews",
      progress: { loyaltyPolicyRevisionsDeleted: 21 },
    });
    expect(mocks.policyRevisionDeleteMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ["policy_revision_21"] },
        storeId: "store_1",
      },
    });
    expect(mocks.programUpdateMany).toHaveBeenCalledOnce();
    expect(mocks.orderUpdateMany).toHaveBeenLastCalledWith({
      where: {
        storeId: "store_1",
        loyaltyPolicyRevisionId: { in: ["policy_revision_21"] },
      },
      data: { loyaltyPolicyRevisionId: null },
    });
    expect(mocks.earnGrantUpdateMany).toHaveBeenLastCalledWith({
      where: {
        storeId: "store_1",
        policyRevisionId: { in: ["policy_revision_21"] },
      },
      data: { policyRevisionId: null },
    });
    expect(mocks.orderUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.earnGrantUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("scrubs tier, reward, and program presentation data while retaining FK targets", async () => {
    mocks.loyaltyTierFindMany
      .mockResolvedValueOnce(
        Array.from({ length: 21 }, (_, index) => ({
          id: `tier_${String(index + 1).padStart(2, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ id: "tier_21" }])
      .mockResolvedValueOnce([]);
    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      lockedBy: "worker_1",
      leaseVersion: 1,
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };

    const tiers = await processShopRedactStep({
      ...request,
      phase: "scrub_loyalty_tiers",
    });
    expect(tiers).toMatchObject({
      completed: false,
      phase: "scrub_loyalty_tiers",
      cursor: { lastId: "tier_20" },
      progress: { loyaltyTiersScrubbed: 20 },
    });
    expect(mocks.loyaltyTierUpdateMany).toHaveBeenCalledTimes(20);
    expect(mocks.loyaltyTierUpdateMany.mock.calls[0][0]).toEqual({
      where: {
        id: "tier_01",
        program: { storeId: "store_1" },
      },
      data: {
        name: "Redacted loyalty tier",
        slug: "redacted-tier_01",
        minSpendThreshold: 0,
        minPointsThreshold: 0,
        pointsMultiplier: 1,
        entryBonusPoints: 0,
        gracePeriodDays: null,
        perks: Prisma.DbNull,
        iconUrl: null,
        color: null,
        criteria: Prisma.DbNull,
      },
    });
    expect(
      mocks.loyaltyTierUpdateMany.mock.calls.every(
        ([input]) => !("id" in input.data) && !("programId" in input.data),
      ),
    ).toBe(true);

    await expect(
      processShopRedactStep({
        ...request,
        phase: "scrub_loyalty_tiers",
        cursor: tiers.cursor,
      }),
    ).resolves.toMatchObject({
      completed: false,
      phase: "scrub_loyalty_rewards",
      progress: { loyaltyTiersScrubbed: 1 },
    });
    await expect(
      processShopRedactStep({
        ...request,
        phase: "scrub_loyalty_tiers",
        cursor: tiers.cursor,
      }),
    ).resolves.toMatchObject({
      completed: false,
      phase: "scrub_loyalty_rewards",
      progress: { loyaltyTiersScrubbed: 0 },
    });
    expect(mocks.loyaltyTierUpdateMany).toHaveBeenCalledTimes(21);

    mocks.rewardDefinitionFindMany.mockResolvedValueOnce([{ id: "reward_1" }]);
    const rewards = await processShopRedactStep({
      ...request,
      phase: "scrub_loyalty_rewards",
    });
    expect(rewards).toMatchObject({
      completed: false,
      phase: "scrub_loyalty_program",
      progress: { loyaltyRewardsScrubbed: 1 },
    });
    expect(mocks.rewardDefinitionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["reward_1"] }, storeId: "store_1" },
        data: expect.objectContaining({
          name: "Redacted loyalty reward",
          status: "archived",
          shopifyPriceRuleId: null,
          entitledCollectionIds: Prisma.DbNull,
          entitledProductIds: Prisma.DbNull,
          entitledVariantIds: Prisma.DbNull,
        }),
      }),
    );
    expect(
      mocks.rewardDefinitionUpdateMany.mock.calls[0][0].data,
    ).not.toHaveProperty("id");
    expect(
      mocks.rewardDefinitionUpdateMany.mock.calls[0][0].data,
    ).not.toHaveProperty("programId");

    const program = await processShopRedactStep({
      ...request,
      phase: "scrub_loyalty_program",
    });
    expect(program).toMatchObject({
      completed: false,
      phase: "purge_native_reviews",
    });
    expect(mocks.programUpdateMany).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
      data: expect.objectContaining({
        name: "Redacted loyalty program",
        status: "disabled",
        killSwitchActive: true,
        earnPolicyVersion: 0,
        branding: Prisma.DbNull,
        metadata: Prisma.DbNull,
      }),
    });
    expect(
      mocks.programUpdateMany.mock.calls.at(-1)?.[0].data,
    ).not.toHaveProperty("id");
    expect(
      mocks.programUpdateMany.mock.calls.at(-1)?.[0].data,
    ).not.toHaveProperty("storeId");
  });

  it("denies an active store before reading or deleting staff records", async () => {
    mocks.storeQueryRaw.mockResolvedValueOnce([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "target.myshopify.com",
        complianceState: "active",
        redactedAt: null,
        financialRetentionUntil: null,
      },
    ]);
    await expect(
      processShopRedactStep({
        id: "wcomp_shop",
        storeId: "store_1",
        phase: "finalize",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).rejects.toThrow("requires a frozen Shopify store");
    expect(mocks.staffGrantFindMany).not.toHaveBeenCalled();
    expect(mocks.staffActionFindMany).not.toHaveBeenCalled();
    expect(mocks.staffGrantDeleteMany).not.toHaveBeenCalled();
    expect(mocks.staffActionDeleteMany).not.toHaveBeenCalled();
  });

  it("drains remaining staff data when retrying an already-redacted store", async () => {
    mocks.storeQueryRaw.mockResolvedValueOnce([
      {
        id: "store_1",
        projectId: "workspace_1",
        shopDomain: "redacted-kid_1-SAFE_SHOP_DIGEST_1234567890.invalid",
        complianceState: "redacted",
        redactedAt: new Date("2026-08-30T00:00:00.000Z"),
        financialRetentionUntil: new Date("2033-08-30T00:00:00.000Z"),
      },
    ]);
    mocks.staffActionFindMany.mockResolvedValueOnce([
      { id: "remaining_action" },
    ]);
    await expect(
      processShopRedactStep({
        id: "wcomp_shop",
        storeId: "store_1",
        phase: "finalize",
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).resolves.toMatchObject({ completed: false, phase: "finalize" });
    expect(mocks.staffActionDeleteMany).toHaveBeenCalledWith({
      where: { storeId: "store_1", id: { in: ["remaining_action"] } },
    });
    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.tombstoneShop).not.toHaveBeenCalled();
  });

  it("drains staff grants and actor audits before declaring shop erasure complete", async () => {
    const request = {
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "finalize",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    };
    mocks.staffGrantFindMany.mockResolvedValueOnce([{ id: "grant_1" }]);
    mocks.staffActionFindMany.mockResolvedValueOnce([{ id: "action_1" }]);
    await expect(processShopRedactStep(request)).resolves.toMatchObject({
      completed: false,
      phase: "finalize",
    });
    for (const find of [mocks.staffGrantFindMany, mocks.staffActionFindMany])
      expect(find).toHaveBeenCalledWith({
        where: { storeId: "store_1" },
        orderBy: { id: "asc" },
        select: { id: true },
        take: 100,
      });
    expect(mocks.staffGrantDeleteMany).toHaveBeenCalledWith({
      where: { storeId: "store_1", id: { in: ["grant_1"] } },
    });
    expect(mocks.staffActionDeleteMany).toHaveBeenCalledWith({
      where: { storeId: "store_1", id: { in: ["action_1"] } },
    });
    expect(mocks.storeUpdate).not.toHaveBeenCalled();
    expect(mocks.tombstoneShop).not.toHaveBeenCalled();
    await expect(processShopRedactStep(request)).resolves.toMatchObject({
      completed: true,
    });
    expect(mocks.staffGrantDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.staffActionDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("scrubs other durable request payloads when shop erasure becomes terminal", async () => {
    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "finalize",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result).toMatchObject({
      completed: true,
      phase: "completed",
      progress: { financialHardPurge: "operator_gated" },
    });
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store_1", id: { not: "wcomp_shop" } },
        data: expect.objectContaining({
          payloadCiphertext: null,
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
        }),
      }),
    );
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_1",
          status: { in: ["pending", "processing", "retrying"] },
        }),
        data: expect.objectContaining({
          status: "completed",
          phase: "already_redacted",
        }),
      }),
    );
    expect(mocks.storeQueryRaw).toHaveBeenCalledOnce();
    expect(
      mocks.storeQueryRaw.mock.calls[0]?.[0]?.strings?.join(" ") ?? "",
    ).toContain("FOR UPDATE");
    expect(mocks.tombstoneShop).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_1",
        sourceRequestId: "wcomp_shop",
        tx: expect.any(Object),
      }),
    );
    expect(mocks.appSessionDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.coordinationDeleteMany).toHaveBeenCalledWith(
      mocks.appSessionDeleteMany.mock.calls[0][0],
    );
    expect(mocks.installIntentDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.sessionIssueDeleteMany).toHaveBeenCalledWith({
      where: { storeId: "store_1", kind: "shopify_session_missing" },
    });
    expect(mocks.merchantSettingsDeleteMany).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
    });
    expect(mocks.installationDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.nativeCredentialDeleteMany).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
    });
    expect(mocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: "workspace_1" },
      data: { shopifyStoreId: null },
    });
    expect(mocks.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "store_1" },
        data: expect.objectContaining({ complianceState: "redacted" }),
      }),
    );
  });

  it("invalidates every retained Shopify alias around credential erasure", async () => {
    const result = await processShopRedactStep({
      id: "wcomp_shop",
      storeId: "store_1",
      phase: "credential_scrub",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      store: { projectId: "workspace_1" },
    });

    expect(result.phase).toBe("finalize");
    expect(mocks.coordinationDeleteMany).toHaveBeenCalledWith(
      mocks.appSessionDeleteMany.mock.calls[0][0],
    );
    expect(mocks.invalidateStoreCache).toHaveBeenNthCalledWith(1, [
      "target.myshopify.com",
      "primary.example.com",
    ]);
    expect(mocks.invalidateStoreCache).toHaveBeenNthCalledWith(2, [
      "target.myshopify.com",
      "primary.example.com",
    ]);
    expect(mocks.appSessionDeleteMany).toHaveBeenCalledWith({
      where: {
        shop: {
          in: ["target.myshopify.com", "primary.example.com"],
        },
      },
    });
  });

  it("propagates export delivery failure so the lease owner records a durable retry", async () => {
    mocks.artifactDeliver.mockRejectedValue(new Error("delivery failed"));
    await expect(
      processCustomerDataRequestStep({
        id: "wcomp_export",
        storeId: "store_1",
        shopDomain: "target.myshopify.com",
        phase: "export_notify",
        lockedBy: "worker_1",
        leaseVersion: 1,
        payloadCiphertext: JSON.stringify({
          shopDomain: "target.myshopify.com",
          customerId: "42",
          orderExternalIds: [],
        }),
        cursor: null,
        progress: null,
        store: { projectId: "workspace_1" },
      }),
    ).rejects.toThrow("delivery failed");
  });

  it("scrubs linkable subject HMAC fields when a request completes", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_complete",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_complete",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "customer_data_request",
      status: "processing",
      phase: "export_notify",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_1",
      store: { projectId: "workspace_1" },
    });

    await processShopifyComplianceRequest({
      requestId: "wcomp_complete",
      workerId: "worker_1",
    });

    const checkpoint = mocks.requestUpdateMany.mock.calls.at(-1)?.[0];
    expect(checkpoint.data).toMatchObject({
      status: "completed",
      payloadCiphertext: null,
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
      completedAt: expect.any(Date),
    });
  });

  it("fails a lost continuation loudly and resumes from its committed checkpoint", async () => {
    const updatedAt = new Date("2026-08-30T00:00:01.000Z");
    mocks.requestFindUnique
      .mockResolvedValueOnce({
        id: "wcomp_stalled_enqueue",
        status: "pending",
        nextRetryAt: null,
        lockedAt: null,
        leaseVersion: 0,
      })
      .mockResolvedValueOnce({
        id: "wcomp_stalled_enqueue",
        storeId: "store_1",
        status: "pending",
        phase: "enumerate_vouchers",
        leaseVersion: 1,
        lockedAt: null,
        lockedBy: null,
        nextRetryAt: null,
        updatedAt,
      })
      .mockResolvedValueOnce({
        id: "wcomp_stalled_enqueue",
        status: "retrying",
        nextRetryAt: new Date(0),
        lockedAt: null,
        leaseVersion: 1,
      });
    const baseRequest = {
      id: "wcomp_stalled_enqueue",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "app_uninstalled",
      status: "processing",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        installationGeneration: "generation_1",
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: null,
      store: { projectId: "workspace_1" },
    };
    mocks.requestFindUniqueOrThrow
      .mockResolvedValueOnce({
        ...baseRequest,
        phase: "received",
        leaseVersion: 1,
        lockedBy: "worker_1",
      })
      .mockResolvedValueOnce({
        ...baseRequest,
        phase: "enumerate_vouchers",
        leaseVersion: 2,
        lockedBy: "worker_2",
      });
    mocks.appUninstalledStep
      .mockResolvedValueOnce({
        completed: false,
        phase: "enumerate_vouchers",
      })
      .mockResolvedValueOnce({ completed: true, phase: "completed" });
    mocks.enqueueWorker.mockResolvedValueOnce(false);

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_stalled_enqueue",
        workerId: "worker_1",
      }),
    ).rejects.toBeInstanceOf(ShopifyComplianceDispatchUnavailableError);

    expect(mocks.requestUpdateMany.mock.calls.at(-1)?.[0]).toEqual({
      where: {
        id: "wcomp_stalled_enqueue",
        storeId: "store_1",
        status: "pending",
        phase: "enumerate_vouchers",
        leaseVersion: 1,
        lockedAt: null,
        lockedBy: null,
        nextRetryAt: null,
        updatedAt,
      },
      data: {
        lastError:
          "Compliance continuation dispatch unavailable; the durable recovery sweep remains authoritative.",
      },
    });

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_stalled_enqueue",
        workerId: "worker_2",
      }),
    ).resolves.toMatchObject({
      claimed: true,
      completed: true,
      phase: "completed",
    });
    expect(mocks.appUninstalledStep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: "received", workerId: "worker_1" }),
    );
    expect(mocks.appUninstalledStep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "enumerate_vouchers",
        workerId: "worker_2",
      }),
    );
    expect(mocks.freezeUninstall).toHaveBeenCalledOnce();
  });

  it("keeps a marker database outage on the fail-loud continuation path", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce({
        id: "wcomp_marker_outage",
        status: "pending",
        nextRetryAt: null,
        lockedAt: null,
        leaseVersion: 0,
      })
      .mockRejectedValueOnce(new Error("database unavailable"));
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_marker_outage",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "app_uninstalled",
      status: "processing",
      phase: "received",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        installationGeneration: "generation_1",
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_1",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: null,
      store: { projectId: "workspace_1" },
    });
    mocks.appUninstalledStep.mockResolvedValueOnce({
      completed: false,
      phase: "enumerate_vouchers",
    });
    mocks.enqueueWorker.mockResolvedValueOnce(false);

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_marker_outage",
        workerId: "worker_1",
      }),
    ).rejects.toBeInstanceOf(ShopifyComplianceDispatchUnavailableError);

    expect(mocks.requestUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.requestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attempts: expect.anything() }),
      }),
    );
  });

  it("lets an exact staging drain suppress competing continuation delivery", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_local_drain",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_local_drain",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "app_uninstalled",
      status: "processing",
      phase: "received",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        installationGeneration: "generation_1",
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_1",
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      triggeredAt: null,
      store: { projectId: "workspace_1" },
    });

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_local_drain",
        workerId: "worker_1",
        enqueueContinuation: false,
      }),
    ).resolves.toMatchObject({
      claimed: true,
      completed: false,
      phase: "enumerate_vouchers",
    });
    expect(mocks.enqueueWorker).not.toHaveBeenCalled();
  });

  it("never persists raw compliance subjects in retry diagnostics", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_error",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_error",
      storeId: "store_1",
      shopDomain: "raw-shop.myshopify.com",
      requestType: "customer_data_request",
      status: "processing",
      phase: "export_notify",
      payloadCiphertext: JSON.stringify({
        shopDomain: "raw-shop.myshopify.com",
        customerId: "raw-customer-42",
        customerEmail: "raw-member@example.com",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_1",
      store: { projectId: "workspace_1" },
    });
    mocks.artifactDeliver.mockRejectedValueOnce(
      new Error(
        "delivery failed for raw-shop.myshopify.com raw-customer-42 raw-member@example.com",
      ),
    );

    await processShopifyComplianceRequest({
      requestId: "wcomp_error",
      workerId: "worker_1",
    });

    const retry = mocks.requestUpdateMany.mock.calls.at(-1)?.[0];
    expect(retry.data.lastError).toContain("[redacted]");
    expect(retry.data.lastError).not.toContain("raw-shop.myshopify.com");
    expect(retry.data.lastError).not.toContain("raw-customer-42");
    expect(retry.data.lastError).not.toContain("raw-member@example.com");
  });

  it("does not overwrite a reclaimed lease after a stale successful step", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_reclaimed_success",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_reclaimed_success",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "customer_data_request",
      status: "processing",
      phase: "export_notify",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_stale",
      store: { projectId: "workspace_1" },
    });
    mocks.requestUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_reclaimed_success",
        workerId: "worker_stale",
      }),
    ).resolves.toMatchObject({ status: "lost_lease" });

    expect(mocks.requestUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.requestUpdateMany.mock.calls[1][0].where).toEqual({
      id: "wcomp_reclaimed_success",
      lockedBy: "worker_stale",
      leaseVersion: 1,
    });
  });

  it("does not borrow a newer worker lease when reclaim happens before the post-claim reload", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_reclaimed_before_reload",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestUpdateMany.mockResolvedValueOnce({ count: 1 });
    // Worker A's version-1 claim committed, worker B reclaimed version 2, and
    // A's exact post-claim predicate must now see no row.
    mocks.requestFindFirst.mockResolvedValueOnce(null);

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_reclaimed_before_reload",
        workerId: "worker_a",
      }),
    ).resolves.toEqual({
      claimed: true,
      completed: false,
      status: "lost_lease",
    });

    expect(mocks.requestFindFirst).toHaveBeenCalledWith({
      where: {
        id: "wcomp_reclaimed_before_reload",
        status: "processing",
        lockedBy: "worker_a",
        leaseVersion: 1,
      },
      include: { store: { select: { projectId: true } } },
    });
    expect(mocks.artifactDeliver).not.toHaveBeenCalled();
  });

  it("terminally scrubs a crash-recovered old uninstall after a newer reinstall generation", async () => {
    const oldTriggeredAt = new Date("2026-08-29T23:59:00.000Z");
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_delayed_uninstall",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_delayed_uninstall",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "app_uninstalled",
      status: "processing",
      phase: "received",
      triggeredAt: oldTriggeredAt,
      receivedAt: new Date("2026-08-30T00:00:00.000Z"),
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        installationGeneration: "install_generation_new",
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_1",
      store: { projectId: "workspace_1" },
    });
    mocks.freezeUninstall.mockResolvedValueOnce({
      complianceState: "stale_reinstall",
      cutoff: oldTriggeredAt,
    });

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_delayed_uninstall",
        workerId: "worker_1",
      }),
    ).resolves.toMatchObject({
      claimed: true,
      completed: true,
      phase: "stale_after_reinstall",
    });

    expect(mocks.freezeUninstall).toHaveBeenCalledWith({
      storeId: "store_1",
      workspaceId: "workspace_1",
      canonicalShopDomain: "target.myshopify.com",
      cutoff: oldTriggeredAt,
      expectedInstallationGeneration: "install_generation_new",
    });
    expect(mocks.appUninstalledStep).not.toHaveBeenCalled();
    expect(mocks.requestUpdateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: "completed",
      phase: "stale_after_reinstall",
      payloadCiphertext: null,
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
    });
  });

  it("does not overwrite a reclaimed lease after a stale failed step", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_reclaimed_failure",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_reclaimed_failure",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "customer_data_request",
      status: "processing",
      phase: "export_notify",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        orderExternalIds: [],
      }),
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_stale",
      store: { projectId: "workspace_1" },
    });
    mocks.artifactDeliver.mockRejectedValueOnce(new Error("delivery failed"));
    mocks.requestUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_reclaimed_failure",
        workerId: "worker_stale",
      }),
    ).resolves.toMatchObject({ status: "lost_lease" });

    expect(mocks.requestUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.requestUpdateMany.mock.calls[1][0].where).toEqual({
      id: "wcomp_reclaimed_failure",
      lockedBy: "worker_stale",
      leaseVersion: 1,
    });
  });

  it("dead-letters a conflicting tombstone owner for operator review without rebinding", async () => {
    mocks.requestFindUnique.mockResolvedValue({
      id: "wcomp_owner_conflict",
      status: "pending",
      nextRetryAt: null,
      lockedAt: null,
      leaseVersion: 0,
    });
    mocks.requestFindUniqueOrThrow.mockResolvedValue({
      id: "wcomp_owner_conflict",
      storeId: "store_1",
      shopDomain: "target.myshopify.com",
      requestType: "customer_redact",
      status: "processing",
      phase: "freeze_customer",
      payloadCiphertext: JSON.stringify({
        shopDomain: "target.myshopify.com",
        customerId: "42",
        customerEmail: "member@example.com",
        orderExternalIds: [],
      }),
      subjectDigest: "SAFE_DIGEST",
      cursor: null,
      progress: null,
      attempts: 0,
      maxAttempts: 10,
      leaseVersion: 1,
      lockedBy: "worker_1",
      store: { projectId: "workspace_1" },
    });
    mocks.tombstoneCustomer.mockRejectedValueOnce(
      new mocks.CustomerOwnerConflictError(
        "Shopify customer privacy identity is already bound to another retained owner.",
      ),
    );

    await expect(
      processShopifyComplianceRequest({
        requestId: "wcomp_owner_conflict",
        workerId: "worker_1",
      }),
    ).resolves.toMatchObject({ status: "dead_letter" });

    expect(mocks.requestUpdateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: {
        id: "wcomp_owner_conflict",
        lockedBy: "worker_1",
        leaseVersion: 1,
      },
      data: {
        status: "dead_letter",
        nextRetryAt: null,
      },
    });
  });
});
