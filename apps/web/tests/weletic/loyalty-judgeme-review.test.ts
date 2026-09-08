import {
  awardJudgeMeReview,
  configureJudgeMeIntegration,
  processJudgeMeWebhook,
  readJudgeMeReviewId,
  validateJudgeMeReviewRuleConditions,
  verifyJudgeMeWebhookSignature,
} from "@/lib/weletic/loyalty/review-providers/judgeme";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

const mocks = vi.hoisted(() => ({
  integrationFindUnique: vi.fn(),
  integrationFindUniqueOrThrow: vi.fn(),
  integrationUpdateMany: vi.fn(),
  integrationUpsert: vi.fn(),
  accountFindFirst: vi.fn(),
  ledgerFindUnique: vi.fn(),
  ledgerCount: vi.fn(),
  appendPointsLedgerEntry: vi.fn(),
}));

const transactionClient = {
  weleticLoyaltyReviewIntegration: {
    findUnique: mocks.integrationFindUnique,
    findUniqueOrThrow: mocks.integrationFindUniqueOrThrow,
    updateMany: mocks.integrationUpdateMany,
    upsert: mocks.integrationUpsert,
  },
  weleticLoyaltyAccount: { findFirst: mocks.accountFindFirst },
  weleticPointsLedgerEntry: {
    findUnique: mocks.ledgerFindUnique,
    count: mocks.ledgerCount,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyReviewIntegration: {
      findUnique: mocks.integrationFindUnique,
    },
  },
}));

vi.mock("@dub/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@dub/utils")>("@dub/utils");
  return {
    ...actual,
    APP_DOMAIN_WITH_NGROK: "https://app.weletic.test",
  };
});

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn(() => "judge-me-private-token"),
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(({ operation }) =>
    operation(transactionClient),
  ),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.appendPointsLedgerEntry,
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: vi.fn().mockResolvedValue(null),
}));

function integrationFixture() {
  return {
    id: "wreviewint_12345678901234567890",
    storeId: "wstore_1",
    provider: "judgeme",
    enabled: true,
    encryptedApiToken: "ciphertext",
    store: { id: "wstore_1", shopDomain: "brand.myshopify.com" },
  };
}

function accountFixture() {
  return {
    id: "wacc_1",
    program: {
      status: "active",
      killSwitchActive: false,
      earningRules: [
        {
          id: "wrule_review",
          name: "Write a verified review",
          triggerCode: "product_review",
          fixedPoints: BigInt(100),
          limitInterval: "monthly",
          maxEventsPerCustomer: 2,
          conditions: {
            provider: "judgeme",
            minContentLength: 20,
            photoBonusPoints: 25,
            videoBonusPoints: 50,
          },
        },
      ],
    },
  };
}

function reviewFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    email: "member@example.com",
    body: "A detailed, verified product review.",
    rating: 5,
    product_external_id: "gid://shopify/Product/1",
    verified: "verified-purchase",
    has_published_pictures: true,
    has_published_videos: false,
    reviewer: null,
    ...overrides,
  };
}

describe("Judge.me verified review earning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.integrationFindUnique.mockResolvedValue(integrationFixture());
    mocks.accountFindFirst.mockResolvedValue(accountFixture());
    mocks.ledgerFindUnique.mockResolvedValue(null);
    mocks.ledgerCount.mockResolvedValue(0);
    mocks.appendPointsLedgerEntry.mockResolvedValue({
      pointsDelta: BigInt(125),
      balanceAfter: BigInt(325),
    });
    mocks.integrationUpsert.mockResolvedValue({
      id: "wreviewint_12345678901234567890",
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    mocks.integrationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.integrationFindUniqueOrThrow.mockResolvedValue({
      id: "wreviewint_12345678901234567890",
      provider: "judgeme",
      enabled: true,
      lastVerifiedAt: new Date("2026-09-01T00:00:01.000Z"),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies the official hex HMAC and extracts supported event IDs", () => {
    const rawBody = JSON.stringify({ review: { id: 42 } });
    const signature = createHmac("sha256", "secret")
      .update(rawBody)
      .digest("hex");
    expect(
      verifyJudgeMeWebhookSignature({ rawBody, signature, secret: "secret" }),
    ).toBe(true);
    expect(
      verifyJudgeMeWebhookSignature({
        rawBody,
        signature: "0".repeat(64),
        secret: "secret",
      }),
    ).toBe(false);
    expect(readJudgeMeReviewId({ review_id: 7 })).toBe("7");
    expect(readJudgeMeReviewId({ review: { id: "8" } })).toBe("8");
  });

  it("validates review rule thresholds and rejects another provider", () => {
    expect(
      validateJudgeMeReviewRuleConditions({ photoBonusPoints: 25 }),
    ).toEqual({
      provider: "judgeme",
      minContentLength: 20,
      photoBonusPoints: 25,
      videoBonusPoints: 0,
    });
    expect(() =>
      validateJudgeMeReviewRuleConditions({ provider: "spoofed" }),
    ).toThrow("Judge.me only");
  });

  it("prepares a disabled integration before registering webhooks, then activates with compare-and-swap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ shop: { domain: "brand.myshopify.com" } }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ webhooks: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ webhook: { id: 101 } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ webhook: { id: 102 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      configureJudgeMeIntegration({
        storeId: "wstore_1",
        shopDomain: "brand.myshopify.com",
        privateApiToken: "judge-me-private-token",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ provider: "judgeme", enabled: true }),
    );

    expect(mocks.integrationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ enabled: false }),
        update: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(mocks.integrationUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[1],
    );
    expect(mocks.integrationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "wreviewint_12345678901234567890",
          enabled: false,
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        }),
        data: expect.objectContaining({
          enabled: true,
          webhookIds: {
            "review/created": "101",
            "review/updated": "102",
          },
        }),
      }),
    );
  });

  it("ignores spoofed webhook PII and reads the authoritative review", async () => {
    const rawBody = JSON.stringify({
      review: {
        id: 42,
        email: "attacker@example.com",
        verified: "admin",
        body: "forged",
      },
    });
    const signature = createHmac("sha256", "judge-me-private-token")
      .update(rawBody)
      .digest("hex");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ review: reviewFixture() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      processJudgeMeWebhook({
        integrationId: "wreviewint_12345678901234567890",
        rawBody,
        signature,
      }),
    ).resolves.toEqual({
      status: "awarded",
      pointsAwarded: "125",
      accountId: "wacc_1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/reviews/42");
    expect(mocks.accountFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shopper: { email: "member@example.com" },
        }),
      }),
    );
    const ledgerCall = mocks.appendPointsLedgerEntry.mock.calls[0][0];
    expect(ledgerCall.pointsDelta).toBe(BigInt(125));
    expect(ledgerCall.idempotencyKey).toBe("review:judgeme:wstore_1:42");
    expect(ledgerCall.metadata).not.toHaveProperty("email");
    expect(ledgerCall.metadata).not.toHaveProperty("body");
  });

  it("does not award an unverified review", async () => {
    await expect(
      awardJudgeMeReview({
        integrationId: "wreviewint_12345678901234567890",
        review: reviewFixture({ verified: "unverified" }),
      }),
    ).resolves.toEqual({
      status: "ignored",
      reason: "review_not_verified",
    });
    expect(mocks.accountFindFirst).not.toHaveBeenCalled();
    expect(mocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    [{ verified: "unverified" }, "review not verified"],
    [{ published: false }, "review unpublished"],
    [{ hidden: true }, "review unpublished"],
    [{ curated: "spam" }, "review moderated"],
  ])(
    "claws back an awarded review when Judge.me reports %s",
    async (overrides, reason) => {
      const rawBody = JSON.stringify({ review: { id: 42 } });
      const signature = createHmac("sha256", "judge-me-private-token")
        .update(rawBody)
        .digest("hex");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ review: reviewFixture(overrides) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      mocks.ledgerFindUnique.mockImplementation(async ({ where }) => {
        const key = where.storeId_idempotencyKey.idempotencyKey;
        return key === "review:judgeme:wstore_1:42"
          ? {
              id: "wledger_award_42",
              accountId: "wacc_1",
              pointsDelta: BigInt(125),
            }
          : null;
      });
      mocks.appendPointsLedgerEntry.mockResolvedValue({
        pointsDelta: BigInt(-125),
        balanceAfter: BigInt(-25),
      });

      await expect(
        processJudgeMeWebhook({
          integrationId: "wreviewint_12345678901234567890",
          rawBody,
          signature,
        }),
      ).resolves.toMatchObject({
        status: "clawed_back",
        pointsReversed: "125",
        balanceAfter: "-25",
      });
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pointsDelta: BigInt(-125),
          reason: `Judge.me ${reason}`,
        }),
      );
    },
  );

  it("treats an authoritative Judge.me 404 as deletion and claws back once", async () => {
    const rawBody = JSON.stringify({ review_id: 42 });
    const signature = createHmac("sha256", "judge-me-private-token")
      .update(rawBody)
      .digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    mocks.ledgerFindUnique.mockImplementation(async ({ where }) => {
      const key = where.storeId_idempotencyKey.idempotencyKey;
      return key === "review:judgeme:wstore_1:42"
        ? {
            id: "wledger_award_42",
            accountId: "wacc_1",
            pointsDelta: BigInt(125),
          }
        : null;
    });
    mocks.appendPointsLedgerEntry.mockResolvedValue({
      pointsDelta: BigInt(-125),
      balanceAfter: BigInt(-125),
    });

    await expect(
      processJudgeMeWebhook({
        integrationId: "wreviewint_12345678901234567890",
        rawBody,
        signature,
      }),
    ).resolves.toMatchObject({ status: "clawed_back" });
    expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "review_clawback:judgeme:wstore_1:42",
        reason: "Judge.me review was deleted",
      }),
    );
  });

  it("fails closed when the integration is disabled before the award transaction", async () => {
    mocks.integrationFindUnique
      .mockResolvedValueOnce(integrationFixture())
      .mockResolvedValueOnce({ ...integrationFixture(), enabled: false });

    await expect(
      awardJudgeMeReview({
        integrationId: "wreviewint_12345678901234567890",
        review: reviewFixture(),
      }),
    ).resolves.toEqual({
      status: "ignored",
      reason: "integration_unavailable",
    });
    expect(mocks.accountFindFirst).not.toHaveBeenCalled();
    expect(mocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("enforces the monthly velocity cap and global review idempotency", async () => {
    mocks.ledgerCount.mockResolvedValue(2);
    await expect(
      awardJudgeMeReview({
        integrationId: "wreviewint_12345678901234567890",
        review: reviewFixture(),
        now: new Date("2026-09-15T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      status: "limit_reached",
      reason: "review_velocity_limit",
    });
    expect(mocks.appendPointsLedgerEntry).not.toHaveBeenCalled();

    mocks.ledgerFindUnique.mockResolvedValue({ id: "wledger_existing" });
    await expect(
      awardJudgeMeReview({
        integrationId: "wreviewint_12345678901234567890",
        review: reviewFixture(),
      }),
    ).resolves.toEqual({
      status: "duplicate",
      reason: "review_already_rewarded",
    });
  });
});
