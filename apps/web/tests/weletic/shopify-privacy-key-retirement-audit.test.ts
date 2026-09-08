import {
  SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS,
  auditShopifyPrivacyKeyRetirement,
  auditShopifyPrivacyKeyRetirementBatch,
  serializeShopifyPrivacyKeyRetirementAudit,
} from "@/lib/weletic/shopify/privacy-key-retirement-audit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customerTombstoneFindMany: vi.fn(),
  shopTombstoneFindMany: vi.fn(),
  complianceRequestFindMany: vi.fn(),
  shopperFindMany: vi.fn(),
  customerFindMany: vi.fn(),
  storeFindMany: vi.fn(),
  redemptionFindMany: vi.fn(),
  referralFindMany: vi.fn(),
  voucherCleanupFindMany: vi.fn(),
  outboxFindMany: vi.fn(),
  webhookEventFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyCustomerPrivacyTombstone: {
      findMany: mocks.customerTombstoneFindMany,
    },
    weleticShopifyShopPrivacyTombstone: {
      findMany: mocks.shopTombstoneFindMany,
    },
    weleticShopifyComplianceRequest: {
      findMany: mocks.complianceRequestFindMany,
    },
    weleticShopper: { findMany: mocks.shopperFindMany },
    customer: { findMany: mocks.customerFindMany },
    weleticShopifyStore: { findMany: mocks.storeFindMany },
    weleticRewardRedemption: { findMany: mocks.redemptionFindMany },
    weleticLoyaltyReferral: { findMany: mocks.referralFindMany },
    weleticShopifyVoucherCleanup: {
      findMany: mocks.voucherCleanupFindMany,
    },
    weleticLoyaltyOutboxJob: { findMany: mocks.outboxFindMany },
    weleticShopifyWebhookEvent: { findMany: mocks.webhookEventFindMany },
  },
}));

function encodedKey(byte: number) {
  return Buffer.alloc(32, byte).toString("base64");
}

const ALL_FIND_MANY_MOCKS = Object.values(mocks);

describe("Shopify privacy HMAC key-retirement audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `current-2026:${encodedKey(1)},previous-2025:${encodedKey(2)}`,
    );
    ALL_FIND_MANY_MOCKS.forEach((mock) => mock.mockResolvedValue([]));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("paginates one bounded source and reports only internal record ids", async () => {
    const retiringDigest = "A".repeat(64);
    mocks.shopperFindMany.mockResolvedValue([
      {
        id: "shopper-1",
        shopifyCustomerId: `redacted:v1:previous-2025:${retiringDigest}`,
      },
      {
        id: "shopper-2",
        shopifyCustomerId: `redacted:v1:current-2026:${"B".repeat(64)}`,
      },
      { id: "shopper-sentinel", shopifyCustomerId: "raw-not-exported" },
    ]);

    const result = await auditShopifyPrivacyKeyRetirementBatch({
      retiringKeyIds: ["previous-2025"],
      cursor: { sourceIndex: 3 },
      batchSize: 2,
    });

    expect(mocks.shopperFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3, orderBy: { id: "asc" } }),
    );
    expect(result).toMatchObject({
      completed: false,
      cursor: { sourceIndex: 3, lastId: "shopper-2" },
      scanned: 2,
      dependencies: [
        {
          source: "shopper_pseudonyms",
          keyId: "previous-2025",
          count: 1,
          sampleRecordIds: ["shopper-1"],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(retiringDigest);
    expect(JSON.stringify(result)).not.toContain("raw-not-exported");
  });

  it("finds keyed nested referral signals and separates legacy digest debt", async () => {
    const versioned = `hmac:v1:previous-2025:${"C".repeat(64)}`;
    const legacy = "D".repeat(64);
    mocks.referralFindMany.mockResolvedValue([
      {
        id: "referral-1",
        ipHash: legacy,
        userAgentHash: null,
        fraudSignals: { clientIpHash: versioned },
        metadata: { rewardSnapshot: { customerSelectionDigest: versioned } },
      },
    ]);

    const result = await auditShopifyPrivacyKeyRetirementBatch({
      retiringKeyIds: ["previous-2025"],
      cursor: { sourceIndex: 7 },
      batchSize: 10,
    });

    expect(result.dependencies).toEqual([
      {
        source: "referral_signals",
        keyId: "previous-2025",
        count: 1,
        sampleRecordIds: ["referral-1"],
      },
    ]);
    expect(result.legacyDebt).toEqual([
      {
        source: "referral_signals",
        count: 1,
        sampleRecordIds: ["referral-1"],
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(versioned);
    expect(serialized).not.toContain(legacy);
  });

  it("blocks retirement while a retained dependency exists", async () => {
    mocks.complianceRequestFindMany.mockResolvedValue([
      {
        id: "request-1",
        subjectKeyId: "previous-2025",
        shopDomain: "redacted-previous-2025-safe.invalid",
      },
    ]);
    const now = new Date("2026-08-30T12:00:00.000Z");

    const result = await auditShopifyPrivacyKeyRetirement({
      retiringKeyIds: ["previous-2025"],
      retiringKeyLastWriteAt: new Date(
        now.getTime() - SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS - 1,
      ),
      writersFenced: true,
      now,
    });

    expect(result.ready).toBe(false);
    expect(result.cacheOverlapSatisfied).toBe(true);
    expect(result.dependencies).toEqual([
      {
        source: "compliance_requests",
        keyId: "previous-2025",
        count: 1,
        sampleRecordIds: ["request-1"],
      },
    ]);
    expect(serializeShopifyPrivacyKeyRetirementAudit(result)).toEqual(
      expect.objectContaining({ ready: false }),
    );
  });

  it("includes authenticated compliance and operational webhook body digests", async () => {
    const digest = `hmac:v1:previous-2025:${"E".repeat(64)}`;
    mocks.complianceRequestFindMany.mockResolvedValueOnce([
      {
        id: "request-body-1",
        subjectKeyId: null,
        authenticatedBodyDigest: digest,
        shopDomain: "target.myshopify.com",
      },
    ]);
    mocks.webhookEventFindMany.mockResolvedValueOnce([
      { id: "event-body-1", authenticatedBodyDigest: digest },
    ]);

    const requestBatch = await auditShopifyPrivacyKeyRetirementBatch({
      retiringKeyIds: ["previous-2025"],
      cursor: { sourceIndex: 2 },
    });
    const eventBatch = await auditShopifyPrivacyKeyRetirementBatch({
      retiringKeyIds: ["previous-2025"],
      cursor: { sourceIndex: 10 },
    });

    expect(requestBatch.dependencies).toEqual([
      {
        source: "compliance_requests",
        keyId: "previous-2025",
        count: 1,
        sampleRecordIds: ["request-body-1"],
      },
    ]);
    expect(eventBatch.dependencies).toEqual([
      {
        source: "webhook_events",
        keyId: "previous-2025",
        count: 1,
        sampleRecordIds: ["event-body-1"],
      },
    ]);
    expect(JSON.stringify([requestBatch, eventBatch])).not.toContain(
      "E".repeat(64),
    );
  });

  it("passes only after a dependency-free full scan and the cache overlap", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const result = await auditShopifyPrivacyKeyRetirement({
      retiringKeyIds: ["previous-2025"],
      retiringKeyLastWriteAt: new Date(
        now.getTime() - SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS,
      ),
      writersFenced: true,
      now,
      batchSize: 2,
    });

    expect(result).toMatchObject({
      ready: true,
      cacheOverlapSatisfied: true,
      dependencies: [],
      legacyDebt: [],
      scanned: 0,
    });
    expect(
      ALL_FIND_MANY_MOCKS.every((mock) => mock.mock.calls.length === 1),
    ).toBe(true);
  });

  it("blocks retirement before the 25-hour privacy-cache overlap", async () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const result = await auditShopifyPrivacyKeyRetirement({
      retiringKeyIds: ["previous-2025"],
      retiringKeyLastWriteAt: new Date(
        now.getTime() - SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS + 1,
      ),
      writersFenced: true,
      now,
    });

    expect(result.ready).toBe(false);
    expect(result.cacheOverlapSatisfied).toBe(false);
  });

  it("requires writers to be fenced and the retiring key to remain configured but not current", async () => {
    await expect(
      auditShopifyPrivacyKeyRetirement({
        retiringKeyIds: ["previous-2025"],
        retiringKeyLastWriteAt: new Date("2026-08-29T00:00:00.000Z"),
        writersFenced: false,
      }),
    ).rejects.toThrow("writers/workers must be fenced");

    await expect(
      auditShopifyPrivacyKeyRetirementBatch({
        retiringKeyIds: ["already-removed"],
      }),
    ).rejects.toThrow("must remain configured");

    await expect(
      auditShopifyPrivacyKeyRetirementBatch({
        retiringKeyIds: ["current-2026"],
      }),
    ).rejects.toThrow("current Shopify privacy writer key cannot be retired");
    expect(
      ALL_FIND_MANY_MOCKS.every((mock) => mock.mock.calls.length === 0),
    ).toBe(true);
  });
});
