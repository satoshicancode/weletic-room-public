import { decrypt, encrypt } from "@/lib/encryption";
import {
  ANONYMOUS_CONFIRMATION_WINDOW_MS,
  anonymousConfirmationDigest,
  createAnonymousConfirmationOrigin,
  sendAnonymousReferralConfirmation,
} from "@/lib/weletic/loyalty/anonymous-referral-confirmation";
import { createReferralPrivacySnapshot } from "@/lib/weletic/loyalty/referral-privacy-snapshot";
import { createShopifyDerivedPrivacyDigest } from "@/lib/weletic/shopify/privacy-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  row: null as any,
  storeGeneration: "generation-a",
  active: true,
  paused: false,
  tombstone: false,
  account: { id: "advocate", metadata: null } as any,
  send: vi.fn(),
  prepare: vi.fn(),
  beforeTransaction: vi.fn(),
  beforeSettings: vi.fn(),
  failFinalization: false,
}));
vi.mock("@dub/email", () => ({ sendPreparedResendEmail: mocks.send }));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: async ({
    expectedInstallationGeneration,
  }: any) => {
    if (expectedInstallationGeneration !== mocks.storeGeneration)
      throw Error("Generation changed");
  },
}));
vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  lockLoyaltyProgramRow: async () => {
    if (!mocks.active) throw Error("Inactive");
    return { id: "program" };
  },
}));
vi.mock("@/lib/prisma", () => {
  const matches = (where: any) =>
    mocks.row &&
    (!where.id || where.id === mocks.row.id) &&
    (!where.storeId || where.storeId === mocks.row.storeId) &&
    (!where.friendEmailLeaseToken ||
      where.friendEmailLeaseToken === mocks.row.friendEmailLeaseToken);
  const update = (data: any) => {
    for (const [key, value] of Object.entries(data)) {
      mocks.row[key] =
        key === "friendEmailDeliveryAttempts"
          ? mocks.row[key] + (value as any).increment
          : structuredClone(value);
    }
  };
  const client: any = {
    weleticLoyaltyReferral: {
      findFirst: async ({ where }: any) =>
        matches(where) ? structuredClone(mocks.row) : null,
      update: async ({ data }: any) => {
        update(data);
        return structuredClone(mocks.row);
      },
      updateMany: async ({ where, data }: any) => {
        if (mocks.failFinalization && data.friendRewardEmailedAt)
          throw Error("Commit failed");
        if (!matches(where)) return { count: 0 };
        update(data);
        return { count: 1 };
      },
    },
    weleticLoyaltyAccount: { findFirst: async () => mocks.account },
    weleticMerchantSettings: {
      findUnique: async () => {
        await mocks.beforeSettings();
        return { shopperEmailPaused: mocks.paused };
      },
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: async () => (mocks.tombstone ? { id: "erased" } : null),
    },
    $queryRaw: async () => [],
    $executeRaw: async (
      _strings: any,
      _now: any,
      id: string,
      storeId: string,
      owner: string,
    ) => {
      if (
        !matches({ id, storeId, friendEmailLeaseToken: owner }) ||
        mocks.row.friendRewardEmailedAt
      )
        return 0;
      Object.assign(mocks.row, {
        friendEmailLeaseToken: null,
        friendEmailLeaseReservedAt: null,
        friendEmailLeaseExpiresAt: new Date(),
        friendEmailLastError:
          "Referral confirmation requires retry or reconciliation",
      });
      return 1;
    },
    $transaction: async (operation: any) => {
      await mocks.beforeTransaction();
      const before = structuredClone(mocks.row);
      try {
        return await operation(client);
      } catch (error) {
        mocks.row = before;
        throw error;
      }
    },
  };
  return { prisma: client };
});

const now = new Date("2026-09-17T00:00:00.000Z");
const email = "friend@example.test";
const request = {
  to: email,
  from: "Weletic <loyalty@example.test>",
  replyTo: ["support@example.test"],
  subject: "Your requested reward is ready",
  html: "<p>CODE-TEST</p>",
};
const send = () =>
  sendAnonymousReferralConfirmation({
    storeId: "store",
    referralId: "referral",
    email,
    prepare: mocks.prepare,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("ENCRYPTION_KEY", "isolated-test-key-not-a-secret");
  mocks.storeGeneration = "generation-a";
  mocks.active = true;
  mocks.paused = false;
  mocks.tombstone = false;
  mocks.account = { id: "advocate", metadata: null };
  mocks.failFinalization = false;
  mocks.beforeTransaction.mockReset();
  mocks.beforeSettings.mockReset();
  mocks.send.mockReset().mockResolvedValue({
    data: { data: [{ id: "fake-provider-id" }] },
    error: null,
  });
  mocks.prepare.mockReset().mockResolvedValue(request);
  const rewardSnapshot = {
    rewardDefinition: { name: "Test reward" },
    expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
  };
  const scope = {
    storeId: "store",
    referralId: "referral",
    friendEmailDigest: createShopifyDerivedPrivacyDigest({
      purpose: "referral_email",
      values: ["store", email],
    }),
  };
  mocks.row = {
    id: "referral",
    ...scope,
    advocateAccountId: "advocate",
    refereeAccountId: null,
    friendRewardDefinitionId: "reward",
    friendShopifyDiscountCode: "CODE-TEST",
    friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/test",
    friendRewardProvisionedAt: now,
    friendRewardEmailedAt: null,
    friendRewardExpiresAt: new Date(rewardSnapshot.expiresAt),
    status: "pending",
    friendEmailLeaseExpiresAt: new Date(0),
    friendEmailLeaseToken: null,
    friendEmailDeliveryAttempts: 0,
    metadata: {
      friendRewardSnapshot: rewardSnapshot,
      anonymousConfirmationOrigin: createAnonymousConfirmationOrigin({
        ...scope,
        programId: "program",
        installationGeneration: "generation-a",
        rewardDefinitionId: "reward",
        discountCode: "CODE-TEST",
        rewardSnapshot,
        locale: "en",
      }),
      friendPrivacySnapshot: createReferralPrivacySnapshot({
        ...scope,
        email,
        now,
      }),
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("anonymous requested confirmation retained delivery", () => {
  it("rejects a valid encrypted request transplanted from another claim for the same recipient", async () => {
    mocks.send.mockRejectedValueOnce(Error("ambiguous"));
    await send();
    const retained = mocks.row.metadata.anonymousConfirmationDelivery;
    const foreign = {
      ...JSON.parse(decrypt(retained.ciphertext)),
      originDigest: "another-claim",
      providerKey: "another-claim-key",
    };
    retained.ciphertext = encrypt(JSON.stringify(foreign));
    expect((await send()).emailSent).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("rejects rewritten outer timestamps even if they still form a 23-hour window", async () => {
    mocks.send.mockRejectedValueOnce(Error("ambiguous"));
    await send();
    const retained = mocks.row.metadata.anonymousConfirmationDelivery;
    retained.preparedAt = new Date(now.getTime() + 3600000).toISOString();
    retained.expiresAt = new Date(
      now.getTime() + 3600000 + ANONYMOUS_CONFIRMATION_WINDOW_MS,
    ).toISOString();
    vi.setSystemTime(new Date(now.getTime() + 3600000));
    expect((await send()).emailSent).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it.each(["pending", "qualified", "rewarded"])(
    "accepts an unexpired %s reward, including no-expiry policies",
    async (status) => {
      mocks.row.status = status;
      mocks.row.friendRewardExpiresAt = null;
      mocks.row.metadata.friendRewardSnapshot.expiresAt = null;
      mocks.row.metadata.anonymousConfirmationOrigin.rewardDigest =
        anonymousConfirmationDigest(mocks.row.metadata.friendRewardSnapshot);
      expect((await send()).emailSent).toBe(true);
    },
  );
  it.each(["cancelled", "fraud_blocked"])(
    "never sends a %s reward",
    async (status) => {
      mocks.row.status = status;
      expect((await send()).emailSent).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    { data: { data: [] } },
    { data: { data: [{}] } },
    { error: { message: "private" }, data: null },
  ])(
    "retains payload on incomplete provider acknowledgment %j",
    async (acknowledgment) => {
      mocks.send.mockResolvedValue(acknowledgment);
      expect((await send()).emailSent).toBe(false);
      expect(mocks.row.friendRewardEmailedAt).toBeNull();
      expect(mocks.row.metadata.anonymousConfirmationDelivery).toBeDefined();
    },
  );
  it("bounds a hanging provider call without pretending it was cancelled", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    mocks.send.mockImplementationOnce(() => new Promise(() => {}));
    const sending = send();
    await vi.advanceTimersByTimeAsync(8_001);
    expect((await sending).emailSent).toBe(false);
    expect(mocks.row.metadata.anonymousConfirmationDelivery).toBeDefined();
    expect((await send()).emailSent).toBe(true);
    expect(mocks.send.mock.calls[1]).toEqual(mocks.send.mock.calls[0]);
  });
  it("commits encrypted exact request before sending, then physically removes it", async () => {
    mocks.send.mockImplementation(async (sent, key) => {
      const retained = mocks.row.metadata.anonymousConfirmationDelivery;
      expect(JSON.parse(decrypt(retained.ciphertext)).request).toEqual(request);
      expect(JSON.stringify(mocks.row.metadata)).not.toContain(email);
      expect(sent).toEqual(request);
      expect(key).toBe("loyalty-referral-friend-referral");
      return { data: { data: [{ id: "fake" }] } };
    });
    expect(await send()).toEqual({ emailSent: true, state: "sent" });
    expect(mocks.row.metadata.anonymousConfirmationDelivery).toBeUndefined();
    expect(mocks.row.metadata.anonymousConfirmationTerminal).toBe("sent");
    expect(mocks.row.friendEmailLeaseToken).toBeNull();
    expect(await send()).toEqual({ emailSent: true, state: "sent" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each(["en", "ja", "vi"] as const)(
    "freezes %s locale and locked reward source",
    async (locale) => {
      mocks.row.metadata.anonymousConfirmationOrigin.locale = locale;
      await send();
      expect(mocks.prepare).toHaveBeenCalledWith(locale, {
        discountCode: "CODE-TEST",
        rewardName: "Test reward",
        expiresAt: mocks.row.friendRewardExpiresAt,
      });
    },
  );
  it("retries ambiguous failures with identical bytes/key and no rerender", async () => {
    mocks.send.mockRejectedValueOnce(
      Error(`Private provider failure ${email}`),
    );
    expect((await send()).emailSent).toBe(false);
    const retained = structuredClone(
      mocks.row.metadata.anonymousConfirmationDelivery,
    );
    expect(mocks.row.friendEmailLastError).not.toContain(email);
    mocks.prepare.mockResolvedValue({
      ...request,
      from: "changed@example.test",
      html: "changed",
    });
    vi.setSystemTime(new Date(now.getTime() + 1000));
    expect((await send()).emailSent).toBe(true);
    expect(mocks.send.mock.calls[1]).toEqual(mocks.send.mock.calls[0]);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(retained.expiresAt).toBe(
      new Date(now.getTime() + ANONYMOUS_CONFIRMATION_WINDOW_MS).toISOString(),
    );
  });
  it("preserves bytes after provider success and local finalization failure", async () => {
    mocks.failFinalization = true;
    expect((await send()).emailSent).toBe(false);
    expect(mocks.row.metadata.anonymousConfirmationDelivery).toBeDefined();
    mocks.failFinalization = false;
    expect((await send()).emailSent).toBe(true);
    expect(mocks.send.mock.calls[1]).toEqual(mocks.send.mock.calls[0]);
  });
  it.each([
    "generation",
    "program",
    "privacy",
    "advocate",
    "paused",
    "erasure",
  ])(
    "fails closed when %s changes between prepare and dispatch",
    async (kind) => {
      mocks.beforeTransaction
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          if (kind === "generation") mocks.storeGeneration = "generation-b";
          if (kind === "program") mocks.active = false;
          if (kind === "privacy") mocks.tombstone = true;
          if (kind === "advocate") mocks.account = null;
          if (kind === "paused") mocks.paused = true;
          if (kind === "erasure") {
            mocks.row.metadata = {};
            mocks.row.friendEmailLeaseToken = null;
          }
        });
      expect((await send()).emailSent).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
      if (kind === "erasure") expect(mocks.row.metadata).toEqual({});
    },
  );
  it.each(["legacy", "reward", "recipient", "status", "snapshot", "attempted"])(
    "rejects %s evidence without creating send authority",
    async (kind) => {
      if (kind === "legacy")
        delete mocks.row.metadata.anonymousConfirmationOrigin;
      if (kind === "reward")
        mocks.row.metadata.friendRewardSnapshot.rewardDefinition.name =
          "Changed";
      if (kind === "recipient") mocks.row.friendEmailDigest = "different";
      if (kind === "status") mocks.row.status = "cancelled";
      if (kind === "snapshot") delete mocks.row.metadata.friendPrivacySnapshot;
      if (kind === "attempted") mocks.row.friendEmailDeliveryAttempts = 1;
      expect((await send()).emailSent).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );
  it("does not send at the exact 23-hour retry boundary", async () => {
    mocks.send.mockRejectedValueOnce(Error("ambiguous"));
    await send();
    vi.setSystemTime(
      new Date(now.getTime() + ANONYMOUS_CONFIRMATION_WINDOW_MS),
    );
    expect((await send()).emailSent).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("uses a fresh expiry clock after awaited settings reads", async () => {
    mocks.beforeSettings.mockImplementation(() => {
      vi.setSystemTime(mocks.row.friendRewardExpiresAt);
    });
    expect((await send()).emailSent).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not clear a different owner's lease", async () => {
    mocks.beforeTransaction
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        mocks.row.friendEmailLeaseToken = "new-owner";
      });
    expect((await send()).emailSent).toBe(false);
    expect(mocks.row.friendEmailLeaseToken).toBe("new-owner");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects modified ciphertext without regenerating it", async () => {
    mocks.send.mockRejectedValueOnce(Error("ambiguous"));
    await send();
    mocks.row.metadata.anonymousConfirmationDelivery.ciphertext = "invalid";
    expect((await send()).emailSent).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("rejects provider recipient remapping", async () => {
    mocks.prepare.mockResolvedValue({ ...request, to: "delivered@resend.dev" });
    expect((await send()).emailSent).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("returns busy without rendering when an existing lease is live", async () => {
    mocks.row.friendEmailLeaseExpiresAt = new Date(now.getTime() + 60_000);
    expect(await send()).toEqual({ emailSent: false, state: "busy" });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
