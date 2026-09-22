import { prisma } from "@/lib/prisma";
import {
  ANONYMOUS_CONFIRMATION_WINDOW_MS,
  createAnonymousConfirmationOrigin,
  resumeAnonymousReferralConfirmation,
  sendAnonymousReferralConfirmation,
} from "@/lib/weletic/loyalty/anonymous-referral-confirmation";
import { purgeAnonymousReferralConfirmations } from "@/lib/weletic/loyalty/anonymous-referral-retention";
import { createReferralPrivacySnapshot } from "@/lib/weletic/loyalty/referral-privacy-snapshot";
import { scrubReferralCustomerContext } from "@/lib/weletic/loyalty/shopper-privacy";
import {
  admitShopperDeliveryInTransaction,
  shopperDeliveryContentDigest,
  ShopperDeliveryDeferredError,
} from "@/lib/weletic/merchant-settings/delivery-reservations";
import { createShopifyDerivedPrivacyDigest } from "@/lib/weletic/shopify/privacy-identity";
import { Prisma } from "@prisma/client";
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

const transport = vi.hoisted(() => ({ send: vi.fn() }));
const hooks = vi.hoisted(() => ({
  afterTransaction: vi.fn(),
  beforeCommit: vi.fn(),
}));
// Real transactions and real SQL, with an explicit post-commit scheduling hook.
// Prisma's extended client cannot be vi.spyOn'ed reliably.
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  return {
    ...actual,
    prisma: new Proxy(actual.prisma, {
      get(target, key) {
        if (key === "$transaction")
          return async (operation: any, options: any) => {
            const result = await target.$transaction(async (tx) => {
              const value = await operation(tx);
              await hooks.beforeCommit();
              return value;
            }, options);
            await hooks.afterTransaction();
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
});
vi.mock("@dub/email", () => ({ sendPreparedResendEmail: transport.send }));
const runId = `anon_${process.pid}_${Date.now()}`;
const workspaceId = `ws_${runId}`,
  affiliateId = `aff_${runId}`,
  storeId = `store_${runId}`,
  programId = `prog_${runId}`,
  shopperId = `shopper_${runId}`,
  accountId = `account_${runId}`;
const generation = `gen_${runId}`,
  referralId = `ref_${runId}`;
const email = "fixture-friend@example.test";
const prepared = {
  to: email,
  from: "Weletic <loyalty@example.test>",
  subject: "Your requested reward is ready",
  html: "<p>TEST-CODE</p>",
};
const prepare = vi.fn().mockResolvedValue(prepared);
const send = () =>
  sendAnonymousReferralConfirmation({ storeId, referralId, email, prepare });
const read = () =>
  prisma.weleticLoyaltyReferral.findUniqueOrThrow({
    where: { id: referralId },
  });

function guard() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    (url.username !== "loyalty_dev" &&
      (!/^wr_[a-f0-9]{12}$/.test(url.username) ||
        !url.pathname.endsWith(url.username.slice(3)))) ||
    !/^\/weletic_loyalty_it_anonymous_\d{8}_[a-z0-9]+$/.test(url.pathname) ||
    url.search
  )
    throw Error(
      "Only a fresh isolated anonymous-confirmation test database is allowed",
    );
}

describe("anonymous confirmation real MySQL lifecycle, mocked provider", () => {
  beforeAll(async () => {
    guard();
    await prisma.project.create({
      data: {
        id: workspaceId,
        name: "Anonymous confirmation isolated test",
        slug: workspaceId,
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: affiliateId,
        workspaceId,
        defaultFolderId: `folder_${runId}`,
        defaultGroupId: `group_${runId}`,
        name: "Isolated test",
        slug: affiliateId,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: workspaceId,
        programId: affiliateId,
        shopDomain: `${runId}.myshopify.com`,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
        storeAccessState: "active",
        installationGeneration: generation,
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: programId, storeId, status: "active" },
    });
    await prisma.weleticShopper.create({
      data: { id: shopperId, storeId, shopifyCustomerId: `fixture_${runId}` },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: { id: accountId, storeId, programId, shopperId },
    });
  });
  beforeEach(async () => {
    hooks.afterTransaction.mockReset();
    hooks.beforeCommit.mockReset();
    vi.stubEnv("ENCRYPTION_KEY", "isolated-anonymous-test-encryption-only");
    transport.send
      .mockReset()
      .mockResolvedValue({ data: { data: [{ id: "mock-provider" }] } });
    prepare.mockReset().mockResolvedValue(prepared);
    await prisma.weleticShopperDeliveryIdentity.deleteMany({
      where: { storeId },
    });
    await prisma.weleticShopperDeliveryReservation.deleteMany({
      where: { storeId },
    });
    await prisma.weleticLoyaltyOutboxJob.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyReferral.deleteMany({ where: { storeId } });
    await prisma.weleticMerchantSettings.deleteMany({ where: { storeId } });
    await prisma.weleticShopifyStore.update({
      where: { id: storeId },
      data: {
        installationGeneration: generation,
        complianceState: "active",
        storeAccessState: "active",
      },
    });
    await prisma.weleticLoyaltyProgram.update({
      where: { id: programId },
      data: { status: "active", killSwitchActive: false },
    });
    await prisma.weleticLoyaltyAccount.update({
      where: { id: accountId },
      data: { status: "active", metadata: Prisma.DbNull },
    });
    const now = new Date();
    const rewardSnapshot = {
      rewardDefinition: { name: "Fixture coupon" },
      expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
    };
    const scope = {
      storeId,
      referralId,
      friendEmailDigest: createShopifyDerivedPrivacyDigest({
        purpose: "referral_email",
        values: [storeId, email],
      }),
    };
    await prisma.weleticLoyaltyReferral.create({
      data: {
        id: referralId,
        storeId,
        advocateAccountId: accountId,
        friendEmailDigest: scope.friendEmailDigest,
        friendRewardDefinitionId: "fixture_reward",
        friendShopifyDiscountCode: "TEST-CODE",
        friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/fixture",
        friendRewardProvisionedAt: now,
        friendRewardExpiresAt: new Date(rewardSnapshot.expiresAt),
        metadata: {
          friendRewardSnapshot: rewardSnapshot,
          friendPrivacySnapshot: createReferralPrivacySnapshot({
            ...scope,
            email,
            now,
          }),
          anonymousConfirmationOrigin: createAnonymousConfirmationOrigin({
            ...scope,
            programId,
            installationGeneration: generation,
            rewardDefinitionId: "fixture_reward",
            discountCode: "TEST-CODE",
            rewardSnapshot,
            locale: "en",
          }),
        },
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    guard();
    hooks.afterTransaction.mockReset();
    await prisma.weleticShopperDeliveryIdentity.deleteMany({
      where: { storeId },
    });
    await prisma.weleticShopperDeliveryReservation.deleteMany({
      where: { storeId },
    });
    await prisma.weleticLoyaltyOutboxJob.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyReferral.deleteMany({ where: { storeId } });
    await prisma.weleticMerchantSettings.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyAccount.deleteMany({ where: { storeId } });
    await prisma.weleticShopper.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyProgram.deleteMany({ where: { storeId } });
    await prisma.weleticShopifyStore.deleteMany({ where: { id: storeId } });
    await prisma.$executeRaw`DELETE FROM \`Program\` WHERE id = ${affiliateId}`;
    await prisma.$executeRaw`DELETE FROM \`Project\` WHERE id = ${workspaceId}`;
    await prisma.$disconnect();
  });
  it("permits one provider dispatch under 12 concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, send));
    expect(results.some((result) => result.emailSent)).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    const row = await read();
    expect(row.friendEmailDeliveryAttempts).toBe(1);
    expect(row.friendRewardEmailedAt).not.toBeNull();
    expect((row.metadata as any).anonymousConfirmationDelivery).toBeUndefined();
  });
  it("retries an ambiguous failure using the committed exact request", async () => {
    transport.send.mockRejectedValueOnce(Error("Ambiguous simulated timeout"));
    expect((await send()).emailSent).toBe(false);
    const retained = (await read()).metadata as any;
    expect(retained.anonymousConfirmationDelivery.ciphertext).toBeTruthy();
    expect(JSON.stringify(retained)).not.toContain(email);
    prepare.mockResolvedValue({
      ...prepared,
      subject: "Changed",
      html: "Changed",
    });
    expect((await send()).emailSent).toBe(true);
    expect(transport.send.mock.calls[1]).toEqual(transport.send.mock.calls[0]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("blocks erasure before dispatch without restoring ciphertext", async () => {
    let calls = 0;
    hooks.afterTransaction.mockImplementation(async () => {
      calls++;
      if (calls === 1)
        await scrubReferralCustomerContext({
          storeId,
          referralId,
          redactedAt: new Date(),
        });
    });
    expect((await send()).emailSent).toBe(false);
    expect(transport.send).not.toHaveBeenCalled();
    const row = await read();
    expect((row.metadata as any).anonymousConfirmationDelivery).toBeUndefined();
    expect((row.metadata as any).anonymousConfirmationOrigin).toBeUndefined();
    expect(row.friendEmailLeaseToken).toBeNull();
  });
  it("serializes erasure behind an admitted in-flight send and removes all payload evidence", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport.send.mockImplementation(async () => {
      entered();
      await gate;
      return { data: { data: [{ id: "mock" }] } };
    });
    const sending = send();
    await started;
    let erased = false;
    const erasing = scrubReferralCustomerContext({
      storeId,
      referralId,
      redactedAt: new Date(),
    }).then(() => {
      erased = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(erased).toBe(false);
    } finally {
      release();
    }
    expect((await sending).emailSent).toBe(true);
    await erasing;
    const metadata = (await read()).metadata as any;
    expect(metadata.anonymousConfirmationDelivery).toBeUndefined();
    expect(metadata.anonymousConfirmationOrigin).toBeUndefined();
  });
  it.each(["generation", "disabled", "closed_advocate"])(
    "rejects %s changed between preparation and dispatch",
    async (kind) => {
      let calls = 0;
      hooks.afterTransaction.mockImplementation(async () => {
        if (++calls === 1) {
          if (kind === "generation")
            await prisma.weleticShopifyStore.update({
              where: { id: storeId },
              data: { installationGeneration: "different" },
            });
          if (kind === "disabled")
            await prisma.weleticLoyaltyProgram.update({
              where: { id: programId },
              data: { status: "disabled" },
            });
          if (kind === "closed_advocate")
            await prisma.weleticLoyaltyAccount.update({
              where: { id: accountId },
              data: { status: "closed" },
            });
        }
      });
      expect((await send()).emailSent).toBe(false);
      expect(transport.send).not.toHaveBeenCalled();
    },
  );
  it("physically purges expired ciphertext from a frozen store and prohibits regeneration", async () => {
    transport.send.mockRejectedValueOnce(Error("ambiguous"));
    await send();
    const retained = ((await read()).metadata as any)
      .anonymousConfirmationDelivery;
    await prisma.weleticShopifyStore.update({
      where: { id: storeId },
      data: { complianceState: "frozen" },
    });
    const boundary = new Date(
      new Date(retained.preparedAt).getTime() +
        ANONYMOUS_CONFIRMATION_WINDOW_MS,
    );
    expect(
      await purgeAnonymousReferralConfirmations({
        take: 10,
        now: new Date(boundary.getTime() - 1),
      }),
    ).toBe(0);
    expect(
      await purgeAnonymousReferralConfirmations({ take: 10, now: boundary }),
    ).toBe(1);
    const row = await read();
    expect((row.metadata as any).anonymousConfirmationDelivery).toBeUndefined();
    expect((row.metadata as any).anonymousConfirmationTerminal).toBe(
      "expired_or_reconciliation",
    );
    expect(row.friendEmailLeaseToken).toBeNull();
    await prisma.weleticShopifyStore.update({
      where: { id: storeId },
      data: { complianceState: "active" },
    });
    expect((await send()).emailSent).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    "invalid",
    {
      preparedAt: "not-a-date",
      expiresAt: "not-a-date",
      ciphertext: "private",
    },
  ])("purges malformed retained data %j", async (malformed) => {
    const row = await read();
    await prisma.weleticLoyaltyReferral.update({
      where: { id: referralId },
      data: {
        metadata: {
          ...(row.metadata as any),
          anonymousConfirmationDelivery: malformed,
        },
      },
    });
    expect(
      await purgeAnonymousReferralConfirmations({ take: 10, now: new Date() }),
    ).toBe(1);
    expect((await read()).metadata).not.toHaveProperty(
      "anonymousConfirmationDelivery",
    );
  });
  it("does not disclose emailed state across tenants", async () => {
    expect((await send()).emailSent).toBe(true);
    expect(
      await sendAnonymousReferralConfirmation({
        storeId: `other_${storeId}`,
        referralId,
        email,
        prepare,
      }),
    ).toEqual({ emailSent: false, state: "unavailable" });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("retains exact bytes after provider acknowledgment and a rolled-back SQL finalization", async () => {
    let commits = 0;
    hooks.beforeCommit.mockImplementation(() => {
      if (++commits === 2)
        throw Error(
          "Injected transaction rollback after provider acknowledgment",
        );
    });
    expect((await send()).emailSent).toBe(false);
    const row = await read();
    expect(row.friendRewardEmailedAt).toBeNull();
    expect((row.metadata as any).anonymousConfirmationDelivery).toBeDefined();
    hooks.beforeCommit.mockReset();
    expect((await send()).emailSent).toBe(true);
    expect(transport.send.mock.calls[1]).toEqual(transport.send.mock.calls[0]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("does not release a newer worker's lease during stale error cleanup", async () => {
    let commits = 0;
    hooks.afterTransaction.mockImplementation(async () => {
      if (++commits === 1)
        await prisma.weleticLoyaltyReferral.update({
          where: { id: referralId },
          data: { friendEmailLeaseToken: "new-owner" },
        });
    });
    expect((await send()).emailSent).toBe(false);
    expect(transport.send).not.toHaveBeenCalled();
    expect((await read()).friendEmailLeaseToken).toBe("new-owner");
  });

  it("rechecks reward expiry after waiting for the store lock", async () => {
    const row = await read();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
      entered();
      await gate;
    });
    await started;
    const sending = send();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(row.friendRewardExpiresAt!);
    } finally {
      release();
    }
    await held;
    expect((await sending).emailSent).toBe(false);
    expect(transport.send).not.toHaveBeenCalled();
    expect((await read()).friendEmailDeliveryAttempts).toBe(0);
  });

  it("respects merchant pause, then admits exactly one resumed confirmation", async () => {
    await prisma.weleticMerchantSettings.create({
      data: { storeId, shopperEmailPaused: true },
    });
    expect((await send()).emailSent).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await read()).friendEmailDeliveryAttempts).toBe(0);
    await prisma.weleticMerchantSettings.update({
      where: { storeId },
      data: { shopperEmailPaused: false },
    });
    await Promise.all(Array.from({ length: 12 }, send));
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect((await read()).friendEmailDeliveryAttempts).toBe(1);
  });
  it("resumes a queued never-attempted confirmation after 25 hours without rerendering", async () => {
    await prisma.weleticMerchantSettings.create({
      data: { storeId, shopperEmailPaused: true },
    });
    expect((await send()).state).toBe("deferred");
    const before = await read();
    expect(before.friendEmailDeliveryAttempts).toBe(0);
    expect(
      await prisma.weleticShopperDeliveryReservation.count({
        where: { storeId },
      }),
    ).toBe(0);
    const queued = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId, jobType: "ANONYMOUS_REFERRAL_EMAIL" },
    });
    expect(JSON.stringify(queued.payload)).not.toContain(email);
    const resumedAt = new Date(Date.now() + 25 * 3600000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(resumedAt);
    expect(
      await purgeAnonymousReferralConfirmations({ take: 10, now: resumedAt }),
    ).toBe(0);
    await prisma.weleticMerchantSettings.update({
      where: { storeId },
      data: { shopperEmailPaused: false },
    });
    const candidate = await prisma.weleticLoyaltyOutboxJob.update({
      where: { id: queued.id },
      data: {
        status: "processing",
        attempts: 1,
        lockedBy: "resumed-worker",
        lockedAt: resumedAt,
      },
    });
    await resumeAnonymousReferralConfirmation({
      candidate,
      ownerToken: "resumed-worker",
      claimedAt: resumedAt,
      attempt: 1,
    });
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(
      prepared,
      `loyalty-referral-friend-${referralId}`,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    const after = await read();
    expect(after.friendRewardExpiresAt).toEqual(before.friendRewardExpiresAt);
    expect(after.friendRewardEmailedAt).not.toBeNull();
    const reservation =
      await prisma.weleticShopperDeliveryReservation.findFirstOrThrow({
        where: { storeId },
      });
    expect(reservation.retryUntil.getTime()).toBe(
      resumedAt.getTime() + ANONYMOUS_CONFIRMATION_WINDOW_MS,
    );
    expect(reservation.state).toBe("sent");
  });

  it("keeps an ambiguous provider attempt bound to its original deadline", async () => {
    transport.send.mockRejectedValueOnce(Error("ambiguous"));
    expect((await send()).emailSent).toBe(false);
    const queued = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId, jobType: "ANONYMOUS_REFERRAL_EMAIL" },
    });
    const deadline = new Date(
      ((await read()).metadata as any).anonymousConfirmationDelivery.expiresAt,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline);
    const candidate = await prisma.weleticLoyaltyOutboxJob.update({
      where: { id: queued.id },
      data: {
        status: "processing",
        attempts: 1,
        lockedBy: "late-worker",
        lockedAt: deadline,
      },
    });
    await expect(
      resumeAnonymousReferralConfirmation({
        candidate,
        ownerToken: "late-worker",
        claimedAt: deadline,
        attempt: 1,
      }),
    ).rejects.toThrow("reconciliation");
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("charges the anonymous send against later authenticated messages at the same email", async () => {
    await prisma.weleticMerchantSettings.create({
      data: {
        storeId,
        timeZone: "UTC",
        shopperDeliveryPolicy: {
          version: 1,
          quietHours: null,
          maxMessagesPer24Hours: 1,
        },
      },
    });
    expect((await send()).state).toBe("sent");
    await expect(
      prisma.$transaction((tx) =>
        admitShopperDeliveryInTransaction({
          tx,
          input: {
            storeId,
            installationGeneration: generation,
            producer: "loyalty_communication",
            sourceKey: "later-authenticated-message",
            provider: "resend",
            contentDigest: shopperDeliveryContentDigest(prepared),
            email,
            shopifyCustomerId: "later-registered-customer",
            expiresAt: null,
            retryUntil: new Date(Date.now() + ANONYMOUS_CONFIRMATION_WINDOW_MS),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ShopperDeliveryDeferredError);
    expect(
      await prisma.weleticShopperDeliveryReservation.count({
        where: { storeId },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticShopperDeliveryIdentity.count({
        where: { storeId, identityKind: "customer_id" },
      }),
    ).toBe(0);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
