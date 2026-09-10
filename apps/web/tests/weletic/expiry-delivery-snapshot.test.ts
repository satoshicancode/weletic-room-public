import { encrypt } from "@/lib/encryption";
import {
  retainExpiryDeliveryRequest,
  type ExpiryDeliveryClaim,
} from "@/lib/weletic/loyalty/expiry-delivery-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  activeAccount: vi.fn(),
  fence: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  assertActiveLoyaltyAccountForMutation: mocks.activeAccount,
  withActiveStoreLoyaltyMutation: mocks.fence,
}));

describe("encrypted expiry delivery evidence", () => {
  const request = {
    to: "synthetic@example.com",
    from: "Rewards <test@example.com>",
    subject: "Saved balance 123",
    html: "<p>Synthetic name: 123 points</p>",
    headers: {
      "List-Unsubscribe": "https://synthetic.myshopify.com/account/profile",
    },
  };
  function fixture() {
    const claim: ExpiryDeliveryClaim = {
      candidate: {
        id: "job",
        storeId: "store",
        jobType: "INACTIVITY_EXPIRY",
        status: "pending",
        idempotencyKey: "fixture-job-key",
        scheduledFor: new Date("2026-09-10T00:00:00Z"),
        createdAt: new Date("2026-09-10T00:00:00Z"),
        updatedAt: new Date("2026-09-10T00:00:00Z"),
        attempts: 0,
        maxAttempts: 5,
        priority: 10,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
        errorLog: [],
        payload: {
          accountId: "account",
          stage: "warning",
          installationGeneration: "g1",
        },
      },
      ownerToken: "worker-owned-token",
      claimedAt: new Date("2026-09-10T00:00:00Z"),
      attempt: 1,
    };
    const prepare = vi.fn().mockResolvedValue(request);
    const args = {
      claim,
      accountId: "account",
      expectedInstallationGeneration: "g1",
      idempotencyKey: "stable-provider-key",
      recipientEmail: "synthetic@example.com",
      prepare,
    };
    return { args, claim, prepare };
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "test-only-expiry-evidence-key-never-for-runtime",
    );
    mocks.findFirst.mockResolvedValue({
      id: "job",
      updatedAt: new Date("2026-09-10T00:00:00Z"),
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.activeAccount.mockResolvedValue({ id: "account" });
    mocks.fence.mockImplementation(async ({ operation }) =>
      operation({
        weleticLoyaltyOutboxJob: {
          findFirst: mocks.findFirst,
          updateMany: mocks.updateMany,
        },
      }),
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores encrypted evidence with full worker and generation fences", async () => {
    const { args, claim } = fixture();
    expect(await retainExpiryDeliveryRequest(args)).toEqual(request);
    expect(mocks.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store",
        expectedInstallationGeneration: "g1",
      }),
    );
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "job",
          storeId: "store",
          status: "processing",
          lockedBy: claim.ownerToken,
          lockedAt: claim.claimedAt,
          attempts: 1,
          payload: {
            equals: {
              accountId: "account",
              stage: "warning",
              installationGeneration: "g1",
            },
          },
        }),
      }),
    );
    const stored = JSON.stringify(mocks.updateMany.mock.calls[0][0].data);
    expect(stored).not.toContain(request.to);
    expect(stored).not.toContain(request.html);
    expect(claim.candidate.payload).toHaveProperty("expiryDeliverySnapshot");
  });
  it("reuses the identical envelope after inputs change and never prepares again", async () => {
    const { args, prepare } = fixture();
    const original = await retainExpiryDeliveryRequest(args);
    prepare.mockResolvedValue({
      ...request,
      subject: "Changed",
      to: "changed@example.com",
    });
    expect(await retainExpiryDeliveryRequest(args)).toEqual(original);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });
  it.each(["accountId", "expectedInstallationGeneration"] as const)(
    "rejects changed %s before writing",
    async (field) => {
      const { args } = fixture();
      args[field] = "foreign";
      await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
        "evidence unavailable",
      );
      expect(mocks.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["storeId", "id"] as const)(
    "rejects encrypted evidence copied to another job %s",
    async (field) => {
      const { args, claim } = fixture();
      await retainExpiryDeliveryRequest(args);
      claim.candidate[field] = "foreign";
      await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
        "evidence unavailable",
      );
      expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a different provider idempotency key", async () => {
    const { args } = fixture();
    await retainExpiryDeliveryRequest(args);
    args.idempotencyKey = "replacement";
    await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
      "evidence unavailable",
    );
  });
  it.each([-1, 23 * 60 * 60 * 1000, 25 * 60 * 60 * 1000])(
    "requires reconciliation for unsafe retry age %s",
    async (age) => {
      const { args, prepare } = fixture();
      const start = new Date("2026-09-10T00:00:00Z");
      await retainExpiryDeliveryRequest({ ...args, wallClockNow: start });
      await expect(
        retainExpiryDeliveryRequest({
          ...args,
          wallClockNow: new Date(start.getTime() + age),
        }),
      ).rejects.toThrow("reconciliation required");
      expect(prepare).toHaveBeenCalledTimes(1);
    },
  );
  it("never prepares when the worker has lost its claim", async () => {
    const { args, prepare } = fixture();
    mocks.findFirst.mockResolvedValue(null);
    await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
      "evidence unavailable",
    );
    expect(prepare).not.toHaveBeenCalled();
  });
  it("does not change the in-memory claim if persistence loses a race", async () => {
    const { args, claim } = fixture();
    const original = structuredClone(claim.candidate.payload);
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
      "evidence unavailable",
    );
    expect(claim.candidate.payload).toEqual(original);
  });
  it("does not prepare after account or generation rejection", async () => {
    const { args, prepare } = fixture();
    mocks.activeAccount.mockRejectedValue(new Error("redacted account"));
    await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
      "redacted account",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it.each(["not-ciphertext", encryptFixture])(
    "fails closed with a sanitized decrypt/parse error (%s)",
    async (input) => {
      const { args, claim } = fixture();
      claim.candidate.payload = {
        ...(claim.candidate.payload as object),
        expiryDeliverySnapshot: typeof input === "function" ? input() : input,
      };
      await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
        /^Expiry delivery evidence unavailable$/,
      );
      expect(mocks.updateMany).not.toHaveBeenCalled();
    },
  );
  it("does not retain customer text from a prepare failure", async () => {
    const { args, prepare } = fixture();
    prepare.mockRejectedValue(new Error("sensitive@example.com"));
    await expect(retainExpiryDeliveryRequest(args)).rejects.toThrow(
      /^Expiry delivery evidence unavailable$/,
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

function encryptFixture() {
  return encrypt(JSON.stringify({ to: "private@example.com" }));
}
