import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyRequest: vi.fn(),
  resolveStore: vi.fn(),
  findStore: vi.fn(),
  rateLimit: vi.fn(),
  limit: vi.fn(),
  claim: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBody: vi.fn((request: Request) => request.text()),
  verifyWeleticShopifyRequest: mocks.verifyRequest,
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: mocks.resolveStore,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: mocks.findStore,
    },
  },
}));

vi.mock("@/lib/upstash", () => ({
  ratelimit: mocks.rateLimit,
}));

vi.mock("@/lib/weletic/loyalty/referral-friend-claim", () => ({
  claimReferralFriendReward: mocks.claim,
}));

import { POST } from "../../app/api/internal/shopify/loyalty/referral/claim/route";

function claimRequest(overrides: Record<string, unknown> = {}) {
  return new Request(
    "https://app.weletic.com/api/internal/shopify/loyalty/referral/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shop: "yamax.myshopify.com",
        referralCode: "alice-1234",
        email: "friend@example.com",
        clientIp: "203.0.113.42",
        userAgent: "Referral Browser",
        ...overrides,
      }),
    },
  );
}

describe("anonymous referral friend claim internal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyRequest.mockReturnValue(true);
    mocks.resolveStore.mockResolvedValue({ storeId: "store_1" });
    mocks.findStore.mockResolvedValue({ id: "store_1" });
    mocks.limit.mockResolvedValue({ success: true });
    mocks.rateLimit.mockReturnValue({ limit: mocks.limit });
    mocks.claim.mockResolvedValue({
      status: "claimed",
      discountCode: "WLF-TEST",
      applyUrl: "https://yamax.myshopify.com/discount/WLF-TEST",
      expiresAt: null,
      emailSent: true,
    });
  });

  it("requires a signed Shopify service request before resolving the store", async () => {
    mocks.verifyRequest.mockReturnValue(false);

    const response = await POST(claimRequest());

    expect(response.status).toBe(401);
    expect(mocks.resolveStore).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("normalizes the referral code and forwards only validated claim fields", async () => {
    const response = await POST(claimRequest({ ignored: "value" }));

    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.42",
      userAgent: "Referral Browser",
    });
    expect(await response.json()).toMatchObject({
      data: { status: "claimed", discountCode: "WLF-TEST" },
    });
  });

  it("fails closed when the distributed rate limiter is unavailable", async () => {
    mocks.limit.mockRejectedValue(new Error("Redis unavailable"));

    const response = await POST(claimRequest());

    expect(response.status).toBe(503);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("returns a generic eligibility error without exposing referral state", async () => {
    mocks.claim.mockRejectedValue(
      new Error("This referral invitation is invalid or has expired."),
    );

    const response = await POST(claimRequest());
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.message).toBe(
      "Unable to claim this referral reward. Check the invitation and eligibility, then try again.",
    );
    expect(JSON.stringify(payload)).not.toContain("invalid or has expired");
  });
});
