import { prisma } from "@/lib/prisma";
import * as weleticIds from "@/lib/weletic/ids";
import {
  retainCommunicationDeliveryRequest,
  type CommunicationDeliveryClaim,
} from "@/lib/weletic/loyalty/communication-delivery-snapshot";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { appendPointsLedgerEntryWithReceipt } from "@/lib/weletic/loyalty/ledger";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  awardBirthdayReward,
  awardSignupWelcomeBonus,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import { processOutboxJobsBatch } from "@/lib/weletic/loyalty/outbox-worker";
import { enqueuePurchasePointsCommunication } from "@/lib/weletic/loyalty/points-communication-producer";
import { createLoyaltyDiscountProvisioningIdentity } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { createLoyaltyRedemptionProvisioningSnapshot } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { enqueueReferralBenefitCommunication } from "@/lib/weletic/loyalty/referral-benefit-communication-producer";
import { createReferralCommunicationOrigin } from "@/lib/weletic/loyalty/referral-communication-origin";
import { getReferralCouponIdempotencyKey } from "@/lib/weletic/loyalty/referral-coupon-idempotency";
import { createReferralCouponRewardSnapshot } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import { createRewardCommunicationOrigin } from "@/lib/weletic/loyalty/reward-communication-origin";
import {
  enqueueRewardExpiryReminderJobs,
  readRewardExpirySweepCursor,
  REWARD_EXPIRY_SWEEP_KEY,
} from "@/lib/weletic/loyalty/reward-expiry-scheduler";
import { rewardRedeemedCommunicationJobSchema } from "@/lib/weletic/loyalty/reward-redeemed-communication-contract";
import { enqueueRewardRedeemedCommunication } from "@/lib/weletic/loyalty/reward-redeemed-communication-producer";
import { processWeleticLoyaltyAccountPrivacyScrubStep } from "@/lib/weletic/loyalty/shopper-privacy";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

// The whole notification handler (including source/refund checks) and Redis
// customer mutex are synthetic. Worker claim/completion,
// encrypted retention and privacy scrub execute against real MySQL. The ordered
// interleavings below prove SQL CAS behavior, not distributed-lock correctness.
const workerSender = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/loyalty/points-earned-notifications", () => ({
  sendPointsEarnedNotification: workerSender,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: async ({
    fn,
  }: {
    fn: () => Promise<unknown>;
  }) => fn(),
}));

const fixtures: string[] = [];
let verified = false;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.COMMUNICATION_DELIVERY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    !/^\/weletic_loyalty_it_communications_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Refusing non-isolated communication database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    { databaseName: url.pathname.slice(1), principal: "loyalty_dev@%" },
  ]);
  expect(await prisma.weleticShopifyStore.count()).toBe(0);
  verified = true;
  vi.stubEnv("ENCRYPTION_KEY", "test-only-isolated-communication-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in communication DB tests");
    }),
  );
});
afterAll(async () => {
  if (verified && fixtures.length) {
    const scope = { storeId: { in: fixtures } };
    await prisma.weleticLoyaltyOutboxJob.deleteMany({ where: scope });
    await prisma.weleticRewardRedemption.deleteMany({ where: scope });
    await prisma.weleticLoyaltyReferral.deleteMany({ where: scope });
    await prisma.weleticRewardDefinition.deleteMany({ where: scope });
    await prisma.weleticPointsLedgerEntry.deleteMany({ where: scope });
    await prisma.weleticLoyaltyOrderLineEarn.deleteMany({ where: scope });
    await prisma.weleticLoyaltyEarnGrant.deleteMany({ where: scope });
    await prisma.weleticCommerceRefundLine.deleteMany({
      where: { refundId: { in: fixtures } },
    });
    await prisma.weleticCommerceRefund.deleteMany({ where: scope });
    await prisma.weleticCommerceOrderLine.deleteMany({
      where: { orderId: { in: fixtures } },
    });
    await prisma.weleticCommerceOrder.deleteMany({ where: scope });
    await prisma.weleticLoyaltyTierHistory.deleteMany({
      where: { accountId: { in: fixtures } },
    });
    await prisma.weleticLoyaltyAccount.deleteMany({ where: scope });
    await prisma.weleticLoyaltyTier.deleteMany({
      where: { programId: { in: fixtures } },
    });
    await prisma.weleticShopper.deleteMany({ where: scope });
    await prisma.weleticMerchantSettings.deleteMany({ where: scope });
    await prisma.weleticLoyaltyProgram.deleteMany({ where: scope });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: fixtures } },
    });
    expect(
      await prisma.programEnrollment.count({
        where: { programId: { in: fixtures } },
      }),
    ).toBe(0);
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM Program WHERE id IN (${Prisma.join(fixtures)})`,
    );
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM Project WHERE id IN (${Prisma.join(fixtures)})`,
    );
    for (const table of [
      "Project",
      "Program",
      "WeleticShopifyStore",
      "WeleticLoyaltyProgram",
      "WeleticShopper",
      "WeleticLoyaltyAccount",
      "WeleticLoyaltyOutboxJob",
      "WeleticMerchantSettings",
      "WeleticRewardRedemption",
      "WeleticLoyaltyReferral",
      "WeleticRewardDefinition",
      "WeleticLoyaltyTier",
      "WeleticLoyaltyTierHistory",
    ]) {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) AS count FROM ${table}`,
      );
      expect(rows[0].count).toBe(BigInt(0));
    }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});
const request = {
  to: "synthetic@example.com",
  from: "test@example.com",
  subject: "Saved",
  html: "<p>Saved synthetic points</p>",
};
const template = {
  subject: "Points",
  heading: "Points",
  body: "{{points}}",
  actionLabel: "View",
};
const policy = {
  journey: "points_earned",
  enabled: true,
  templates: { en: template, ja: template, vi: template },
};
const metadata = {
  loyaltyCommunications: { version: 1, sequence: 1, policies: [policy] },
};
async function seed(source = "purchase_points_available") {
  const eventPolicy = {
    ...policy,
    journey:
      source === "birthday_points_available" ? "birthday" : "points_earned",
  };
  const id = `communication-${randomUUID()}`;
  fixtures.push(id);
  await prisma.project.create({
    data: {
      id,
      name: "Communication DB fixture",
      slug: id,
      billingCycleStart: 1,
    },
  });
  await prisma.program.create({
    data: {
      id,
      workspaceId: id,
      name: "Communication DB fixture",
      slug: id,
      defaultFolderId: id,
      defaultGroupId: id,
    },
  });
  await prisma.weleticShopifyStore.create({
    data: {
      id,
      projectId: id,
      programId: id,
      shopDomain: `${id}.myshopify.com`,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      storeAccessState: "active",
      complianceState: "active",
      installationGeneration: "g1",
      apiVersion: "2026-07",
    },
  });
  await prisma.weleticLoyaltyProgram.create({
    data: {
      id,
      storeId: id,
      status: "active",
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [eventPolicy],
        },
      },
    },
  });
  await prisma.weleticShopper.create({
    data: {
      id,
      storeId: id,
      shopifyCustomerId: id,
      email: request.to,
      acceptsMarketing: true,
    },
  });
  await prisma.weleticLoyaltyAccount.create({
    data: { id, storeId: id, programId: id, shopperId: id, status: "active" },
  });
  await prisma.weleticMerchantSettings.create({ data: { storeId: id } });
  const candidate = await prisma.weleticLoyaltyOutboxJob.create({
    data: {
      id,
      storeId: id,
      jobType: "LOYALTY_COMMUNICATION",
      status: "processing",
      attempts: 1,
      lockedBy: "fixture-owner",
      lockedAt: new Date(),
      idempotencyKey: `fixture-${id}`,
      payload: {
        version: 1,
        journey: eventPolicy.journey,
        source,
        storeId: id,
        programId: id,
        accountId: id,
        installationGeneration: "g1",
        ledgerEntryId: id,
        ...(source === "purchase_points_available" ? { orderId: id } : {}),
        ...(source === "birthday_points_available"
          ? { calendarYear: 2026 }
          : {}),
        occurredAt: new Date().toISOString(),
        points: "20",
        ledgerPoints: "20",
        policyRevision: "a".repeat(64),
        policy: eventPolicy,
      },
    },
  });
  const claim: CommunicationDeliveryClaim = {
    candidate,
    ownerToken: candidate.lockedBy!,
    claimedAt: candidate.lockedAt!,
    attempt: 1,
  };
  const prepare = vi.fn().mockResolvedValue(request);
  return {
    id,
    args: {
      claim,
      accountId: id,
      expectedInstallationGeneration: "g1",
      recipientEmail: request.to,
      prepare,
    },
  };
}

async function seedRedemption(expiresAt: Date | null = null) {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  const createdAt = new Date();
  const snapshot = createLoyaltyRedemptionProvisioningSnapshot({
    reward: { id, name: "Synthetic redemption", rewardType: "amount_off" },
    pointsCost: BigInt(100),
    discountValue: "500",
    expiresInDays: null,
    shopCurrency: "JPY",
    currencyVerifiedAt: createdAt,
    customerSelectionDigest: "A".repeat(64),
    startsAt: createdAt,
    expiresAt,
  });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [
            {
              ...createDefaultLoyaltyCommunicationPolicy("reward_redeemed"),
              enabled: true,
            },
          ],
        },
      },
    },
  });
  await prisma.weleticRewardDefinition.create({
    data: {
      id,
      storeId: id,
      name: "Synthetic redemption",
      rewardType: "amount_off",
      pointsCost: BigInt(100),
      discountValue: 500,
    },
  });
  await withActiveStoreLoyaltyMutation({
    storeId: id,
    action: "redemption_communication_fixture",
    expectedInstallationGeneration: "g1",
    operation: async (tx) => {
      await appendPointsLedgerEntryWithReceipt({
        tx,
        storeId: id,
        accountId: id,
        entryType: "MANUAL_ADJUSTMENT",
        pointsDelta: BigInt(100),
        idempotencyKey: `opening:${id}`,
      });
      const debit = await appendPointsLedgerEntryWithReceipt({
        tx,
        storeId: id,
        accountId: id,
        entryType: "REDEEM_REWARD",
        pointsDelta: -BigInt(100),
        referenceType: "REWARD_REDEMPTION",
        referenceId: id,
        idempotencyKey: `redeem:${id}`,
      });
      await tx.weleticRewardRedemption.create({
        data: {
          id,
          storeId: id,
          accountId: id,
          rewardDefinitionId: id,
          pointsSpent: BigInt(100),
          shopifyDiscountCode: id,
          shopifyDiscountCodeCanonical: id.toUpperCase(),
          status: "provisioning",
          expiresAt,
          ledgerEntryId: debit.entry.id,
          metadata: {
            rewardSnapshot: { name: "Synthetic redemption" },
            shopifyDiscountOwnership: createLoyaltyDiscountProvisioningIdentity(
              {
                identity: {
                  storeId: id,
                  accountId: id,
                  redemptionId: id,
                  rewardDefinitionId: id,
                  discountCode: id,
                },
                rewardName: "Synthetic redemption",
              },
            ),
            provisioningSnapshot: snapshot,
            rewardCommunicationOrigin: createRewardCommunicationOrigin({
              storeId: id,
              accountId: id,
              redemptionId: id,
              installationGeneration: "g1",
              provisioningDigest: snapshot.contentDigest,
            }),
          },
        },
      });
    },
  });
  return id;
}

async function seedReferralPoints() {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.deleteMany({ where: { storeId: id } });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [
            {
              ...createDefaultLoyaltyCommunicationPolicy("referral_advocate"),
              enabled: true,
            },
          ],
        },
      },
    },
  });
  await prisma.weleticLoyaltyReferral.create({
    data: {
      id,
      storeId: id,
      advocateAccountId: id,
      status: "qualified",
      qualifyingOrderId: id,
      advocatePointsAwarded: BigInt(20),
      metadata: {
        qualificationOrderId: id,
        referralCommunicationOrigins: {
          advocate: createReferralCommunicationOrigin({
            storeId: id,
            programId: id,
            referralId: id,
            qualificationOrderId: id,
            accountId: id,
            side: "advocate",
            installationGeneration: "g1",
            qualificationPath: "preissued_friend_claim",
            qualifiedAt: new Date().toISOString(),
            kind: "points",
            points: "20",
          }),
        },
      },
    },
  });
  return id;
}

// This exercises the real ledger/producer transaction, not order classification
// or the entire qualification engine. No Shopify order or provider is involved.
function awardReferralPoints(id: string, rollback = false) {
  return withActiveStoreLoyaltyMutation({
    storeId: id,
    action: "referral_communication_fixture",
    expectedInstallationGeneration: "g1",
    operation: async (tx) => {
      const receipt = await appendPointsLedgerEntryWithReceipt({
        tx,
        storeId: id,
        accountId: id,
        entryType: "EARN_REFERRAL",
        pointsDelta: BigInt(20),
        referenceType: "referral_friend_claim",
        referenceId: id,
        idempotencyKey: `referral_friend_advocate:${id}:${id}`,
        metadata: { referralId: id, orderId: id },
      });
      await enqueueReferralBenefitCommunication({
        tx,
        identity: {
          storeId: id,
          programId: id,
          referralId: id,
          qualificationOrderId: id,
          accountId: id,
          side: "advocate",
        },
        expectedInstallationGeneration: "g1",
        receipt: {
          created: receipt.created,
          kind: "points",
          id: receipt.entry.id,
        },
      });
      if (rollback)
        throw new Error("synthetic referral rollback after enqueue");
      return receipt.created;
    },
  });
}

it("atomically commits one referral points notice under concurrent receipt replay", async () => {
  const id = await seedReferralPoints();
  const created = await Promise.all([
    awardReferralPoints(id),
    awardReferralPoints(id),
  ]);
  expect(created.sort()).toEqual([false, true]);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toMatchObject({
    source: "referral_benefit_confirmed",
    journey: "referral_advocate",
    points: "20",
    installationGeneration: "g1",
  });
});

it("rolls back referral points and their queued notice together", async () => {
  const id = await seedReferralPoints();
  await expect(awardReferralPoints(id, true)).rejects.toThrow(
    "synthetic referral rollback after enqueue",
  );
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(await awardReferralPoints(id)).toBe(true);
});

it("rejects stale referral provenance even when the outer writer uses fresh installation authority", async () => {
  const id = await seedReferralPoints();
  await prisma.weleticShopifyStore.update({
    where: { id },
    data: { installationGeneration: "g2" },
  });
  await expect(
    withActiveStoreLoyaltyMutation({
      storeId: id,
      action: "referral_communication_fixture",
      expectedInstallationGeneration: "g2",
      operation: async (tx) =>
        enqueueReferralBenefitCommunication({
          tx,
          identity: {
            storeId: id,
            programId: id,
            referralId: id,
            qualificationOrderId: id,
            accountId: id,
            side: "advocate",
          },
          expectedInstallationGeneration: "g2",
          receipt: {
            created: true,
            kind: "points",
            id: "must-not-read-receipt",
          },
        }),
    }),
  ).rejects.toThrow("Referral communication origin unavailable");
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
});

function issueRedemption(id: string, rollback = false) {
  return withActiveStoreLoyaltyMutation({
    storeId: id,
    action: "redemption_communication_fixture",
    expectedInstallationGeneration: "g1",
    operation: async (tx) => {
      const transition = await tx.weleticRewardRedemption.updateMany({
        where: { id, storeId: id, accountId: id, status: "provisioning" },
        data: { status: "issued", shopifyDiscountId: `synthetic-${id}` },
      });
      await enqueueRewardRedeemedCommunication({
        tx,
        storeId: id,
        accountId: id,
        expectedInstallationGeneration: "g1",
        receipt: {
          transitioned: transition.count === 1,
          redemptionId: id,
          occurredAt: new Date(),
        },
      });
      if (rollback) throw new Error("synthetic rollback after enqueue");
      return transition.count;
    },
  });
}

it("atomically commits one redemption notification under concurrent issuance replay", async () => {
  const id = await seedRedemption();
  const counts = await Promise.all([issueRedemption(id), issueRedemption(id)]);
  expect(counts.sort()).toEqual([0, 1]);
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].jobType).toBe("LOYALTY_COMMUNICATION");
  expect(
    rewardRedeemedCommunicationJobSchema.parse(jobs[0].payload),
  ).toMatchObject({
    journey: "reward_redeemed",
    source: "reward_issuance_confirmed",
    storeId: id,
    programId: id,
    accountId: id,
    redemptionId: id,
    installationGeneration: "g1",
    pointsSpent: "100",
  });
  expect(
    await prisma.weleticRewardRedemption.findUnique({ where: { id } }),
  ).toMatchObject({ status: "issued" });
});

it("persists confirmed issuance time with the redemption notice disabled and preserves it on replay", async () => {
  const id = await seedRedemption();
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        loyaltyCommunications: { version: 1, sequence: 2, policies: [] },
      },
    },
  });
  expect(await issueRedemption(id)).toBe(1);
  const first = await prisma.weleticRewardRedemption.findUniqueOrThrow({
    where: { id },
  });
  const firstMetadata = first.metadata as Prisma.JsonObject;
  expect(firstMetadata.rewardCommunicationIssuedAt).toEqual(expect.any(String));
  expect(
    Number.isFinite(
      new Date(firstMetadata.rewardCommunicationIssuedAt as string).getTime(),
    ),
  ).toBe(true);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(await issueRedemption(id)).toBe(0);
  const replay = await prisma.weleticRewardRedemption.findUniqueOrThrow({
    where: { id },
  });
  expect(replay.metadata).toEqual(first.metadata);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(2);
});

it("rolls back the issuance timestamp with a failed winning transaction", async () => {
  const id = await seedRedemption();
  const before = await prisma.weleticRewardRedemption.findUniqueOrThrow({
    where: { id },
  });
  await expect(issueRedemption(id, true)).rejects.toThrow(
    "synthetic rollback after enqueue",
  );
  const after = await prisma.weleticRewardRedemption.findUniqueOrThrow({
    where: { id },
  });
  expect(after.status).toBe("provisioning");
  expect(after.metadata).toEqual(before.metadata);
  expect(
    (after.metadata as Prisma.JsonObject).rewardCommunicationIssuedAt,
  ).toBeUndefined();
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
});

it("rolls back redemption issuance and notification together, preserving the original debit", async () => {
  const id = await seedRedemption();
  const ledgerQuery = {
    where: { storeId: id },
    orderBy: { sequenceNumber: "asc" as const },
  };
  const before = await prisma.weleticPointsLedgerEntry.findMany(ledgerQuery);
  expect(
    before.map(({ entryType, pointsDelta }) => ({ entryType, pointsDelta })),
  ).toEqual([
    { entryType: "MANUAL_ADJUSTMENT", pointsDelta: BigInt(100) },
    { entryType: "REDEEM_REWARD", pointsDelta: -BigInt(100) },
  ]);
  await expect(issueRedemption(id, true)).rejects.toThrow(
    "synthetic rollback after enqueue",
  );
  expect(
    await prisma.weleticRewardRedemption.findUnique({ where: { id } }),
  ).toMatchObject({ status: "provisioning", shopifyDiscountId: null });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(2);
  expect(await prisma.weleticPointsLedgerEntry.findMany(ledgerQuery)).toEqual(
    before,
  );
  expect(
    await prisma.weleticLoyaltyAccount.findUnique({ where: { id } }),
  ).toMatchObject({ cachedPointsBalance: BigInt(0) });
  expect(await issueRedemption(id)).toBe(1);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(1);
});

it.each(["generation", "suspended", "redacted"] as const)(
  "rejects redemption issuance without changing financial evidence after %s wins",
  async (change) => {
    const id = await seedRedemption();
    const redemptionBefore = await prisma.weleticRewardRedemption.findUnique({
      where: { id },
    });
    const ledgerQuery = {
      where: { storeId: id },
      orderBy: { sequenceNumber: "asc" as const },
    };
    const ledgerBefore =
      await prisma.weleticPointsLedgerEntry.findMany(ledgerQuery);
    await prisma.weleticShopifyStore.update({
      where: { id },
      data:
        change === "generation"
          ? { installationGeneration: "g2" }
          : change === "suspended"
            ? { storeAccessState: "suspended" }
            : { complianceState: "redacted" },
    });
    // Ordered interleaving: the installation/access/privacy write commits
    // before the producer's real store lock. No remote operation is modeled.
    await expect(issueRedemption(id)).rejects.toThrow();
    expect(
      await prisma.weleticRewardRedemption.findUnique({ where: { id } }),
    ).toEqual(redemptionBefore);
    expect(await prisma.weleticPointsLedgerEntry.findMany(ledgerQuery)).toEqual(
      ledgerBefore,
    );
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
    ).toBe(0);
  },
);

async function seedBirthday() {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  await prisma.weleticLoyaltyAccount.update({
    where: { id },
    data: { enrolledAt: new Date("2025-01-01T00:00:00Z") },
  });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [{ ...policy, journey: "birthday" }],
        },
      },
    },
  });
  return id;
}
const birthdayAward = (id: string) => ({
  storeId: id,
  accountId: id,
  birthDate: "1990-09-10",
  now: new Date("2026-09-10T00:00:00Z"),
  rewardPoints: BigInt(100),
});

it("commits one annual birthday award and notification under concurrent replay", async () => {
  const id = await seedBirthday();
  const results = await Promise.all([
    awardBirthdayReward(birthdayAward(id)),
    awardBirthdayReward(birthdayAward(id)),
  ]);
  expect(results.every((result) => result.awarded)).toBe(true);
  expect(results.filter((result) => result.isDuplicate)).toHaveLength(1);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toMatchObject({
    journey: "birthday",
    calendarYear: 2026,
    points: "100",
    ledgerEntryId: results[0].ledgerEntry?.id,
  });
  expect(jobs[0].payload).not.toHaveProperty("birthDate");
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(100));
});

it("does not backfill a birthday notice after policy opt-in, but announces the next annual award", async () => {
  const id = await seedBirthday();
  const enabled = (
    await prisma.weleticLoyaltyProgram.findUniqueOrThrow({ where: { id } })
  ).metadata as Prisma.InputJsonObject;
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata: {} },
  });
  await awardBirthdayReward(birthdayAward(id));
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata: enabled },
  });
  await awardBirthdayReward(birthdayAward(id));
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(0);
  await awardBirthdayReward({
    ...birthdayAward(id),
    now: new Date("2027-09-10T00:00:00Z"),
  });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(1);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(2);
});

it("rolls back the real birthday ledger and account when notification insertion fails", async () => {
  const id = await seedBirthday();
  await expect(
    prisma.$transaction(async (tx) => {
      const failingTx = new Proxy(tx, {
        get(target, property) {
          if (property !== "weleticLoyaltyOutboxJob")
            return Reflect.get(target, property);
          return new Proxy(target.weleticLoyaltyOutboxJob, {
            get(delegate, operation) {
              if (operation !== "create")
                return Reflect.get(delegate, operation);
              return async () => {
                throw new Error("Injected birthday outbox failure");
              };
            },
          });
        },
      });
      await awardBirthdayReward({ ...birthdayAward(id), tx: failingTx });
    }),
  ).rejects.toThrow("Injected birthday outbox failure");
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(0));
});

async function seedVip(enabled = true) {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  const template = {
    subject: "VIP {{tier_name}}",
    heading: "VIP",
    body: "Welcome",
    actionLabel: "View",
  };
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      vipTimeframe: "lifetime",
      vipMilestoneMode: "amount_spent",
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [
            {
              journey: "vip_achieved",
              enabled,
              templates: { en: template, ja: template, vi: template },
            },
          ],
        },
      },
    },
  });
  await prisma.weleticLoyaltyTier.createMany({
    data: [
      {
        id: `${id}-bronze`,
        programId: id,
        name: "Bronze",
        slug: "bronze",
        tierOrder: 1,
      },
      {
        id: `${id}-gold`,
        programId: id,
        name: "Gold",
        slug: "gold",
        tierOrder: 2,
        minSpendThreshold: BigInt(5000),
        entryBonusPoints: BigInt(100),
      },
    ],
  });
  await prisma.weleticLoyaltyAccount.update({
    where: { id },
    data: { currentTierId: `${id}-bronze` },
  });
  const amount = BigInt(10000);
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId: id,
      programId: id,
      shopperId: id,
      externalId: id,
      status: "paid",
      presentmentCurrency: "JPY",
      presentmentSubtotal: amount,
      presentmentNet: amount,
      presentmentTotal: amount,
      shopCurrency: "JPY",
      shopSubtotal: amount,
      shopNet: amount,
      shopTotal: amount,
      accountingCurrency: "JPY",
      accountingNet: amount,
      accountingTotal: amount,
      accountingFxRate: 1,
      occurredAt: new Date("2026-09-01T00:00:00Z"),
    },
  });
  return id;
}
const vipEvaluation = (id: string) => ({
  storeId: id,
  accountId: id,
  expectedInstallationGeneration: "g1",
  now: new Date("2026-09-10T00:00:00Z"),
});
it("commits one VIP promotion, entry bonus and notice under concurrent evaluation", async () => {
  const id = await seedVip();
  const results = await Promise.all([
    evaluateTierMaintenanceCycle(vipEvaluation(id)),
    evaluateTierMaintenanceCycle(vipEvaluation(id)),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "MAINTAINED",
    "PROMOTED",
  ]);
  const histories = await prisma.weleticLoyaltyTierHistory.findMany({
    where: { accountId: id },
  });
  expect(histories).toHaveLength(1);
  const notices = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  expect(notices).toHaveLength(1);
  expect(notices[0].payload).toMatchObject({
    journey: "vip_achieved",
    tierHistoryId: histories[0].id,
    sequenceNumber: 1,
  });
  expect(
    await prisma.weleticPointsLedgerEntry.count({
      where: { storeId: id, entryType: "TIER_BONUS" },
    }),
  ).toBe(1);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(100));
});
it.each(["notification", "post_bonus"])(
  "contains all VIP writes when %s insertion fails",
  async (phase) => {
    const id = await seedVip();
    await expect(
      prisma.$transaction(async (tx) => {
        const failingTx = new Proxy(tx, {
          get(target, property) {
            if (property !== "weleticLoyaltyOutboxJob")
              return Reflect.get(target, property);
            return new Proxy(target.weleticLoyaltyOutboxJob, {
              get(delegate, operation) {
                if (operation !== "create")
                  return Reflect.get(delegate, operation);
                return async (
                  args: Prisma.WeleticLoyaltyOutboxJobCreateArgs,
                ) => {
                  if (phase === "post_bonus") {
                    if (args.data.jobType !== "METAFIELD_SYNC")
                      return delegate.create(args);
                    expect(
                      await tx.weleticPointsLedgerEntry.count({
                        where: { storeId: id, entryType: "TIER_BONUS" },
                      }),
                    ).toBe(1);
                    expect(
                      await tx.weleticLoyaltyOutboxJob.count({
                        where: {
                          storeId: id,
                          jobType: "LOYALTY_COMMUNICATION",
                        },
                      }),
                    ).toBe(1);
                    expect(
                      (
                        await tx.weleticLoyaltyAccount.findUniqueOrThrow({
                          where: { id },
                        })
                      ).cachedPointsBalance,
                    ).toBe(BigInt(100));
                  }
                  throw new Error("Injected VIP outbox failure");
                };
              },
            });
          },
        });
        await evaluateTierMaintenanceCycle({
          ...vipEvaluation(id),
          tx: failingTx,
        });
      }),
    ).rejects.toThrow("Injected VIP outbox failure");
    expect(
      await prisma.weleticLoyaltyTierHistory.count({
        where: { accountId: id },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
    ).toBe(0);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
    ).toBe(0);
    expect(
      await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      currentTierId: `${id}-bronze`,
      cachedPointsBalance: BigInt(0),
    });
  },
);
it("does not announce an old VIP promotion after later policy opt-in", async () => {
  const id = await seedVip(false);
  expect((await evaluateTierMaintenanceCycle(vipEvaluation(id))).status).toBe(
    "PROMOTED",
  );
  const program = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { id },
  });
  const metadata = program.metadata as {
    loyaltyCommunications: { policies: { enabled: boolean }[] };
  };
  metadata.loyaltyCommunications.policies[0].enabled = true;
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata },
  });
  expect((await evaluateTierMaintenanceCycle(vipEvaluation(id))).status).toBe(
    "MAINTAINED",
  );
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(0);
});
it.each([false, true])(
  "invalidates superseded VIP delivery and creates a new requalification identity (retained=%s)",
  async (retained) => {
    const id = await seedVip();
    await evaluateTierMaintenanceCycle(vipEvaluation(id));
    const original = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    });
    const now = new Date();
    const candidate = await prisma.weleticLoyaltyOutboxJob.update({
      where: { id: original.id },
      data: {
        status: "processing",
        lockedBy: "vip-fixture-owner",
        lockedAt: now,
        attempts: 1,
      },
    });
    const args = {
      claim: {
        candidate,
        ownerToken: "vip-fixture-owner",
        claimedAt: now,
        attempt: 1,
      },
      accountId: id,
      expectedInstallationGeneration: "g1",
      recipientEmail: request.to,
      prepare: vi.fn().mockResolvedValue(request),
      wallClockNow: now,
    };
    if (retained) await retainCommunicationDeliveryRequest(args);
    const annual = {
      ...vipEvaluation(id),
      reviewPeriod: "ROLLING_12M" as const,
      gracePeriodDays: 1,
      now: new Date("2027-09-15T00:00:00Z"),
    };
    expect((await evaluateTierMaintenanceCycle(annual)).status).toBe(
      "IN_GRACE_PERIOD",
    );
    annual.now = new Date("2027-09-16T00:00:00Z");
    expect((await evaluateTierMaintenanceCycle(annual)).status).toBe("DEMOTED");
    args.prepare.mockClear();
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
      "no longer eligible",
    );
    expect(args.prepare).not.toHaveBeenCalled();
    // Advance the synthetic order into the new review window, then exercise the
    // real qualification path. No Shopify transaction is created.
    await prisma.weleticCommerceOrder.update({
      where: { id },
      data: { occurredAt: new Date("2027-09-14T00:00:00Z") },
    });
    expect((await evaluateTierMaintenanceCycle(annual)).status).toBe(
      "PROMOTED",
    );
    // Same target tier, different history: the earlier message stays obsolete.
    await expect(retainCommunicationDeliveryRequest(args)).rejects.toThrow(
      "no longer eligible",
    );
    expect(args.prepare).not.toHaveBeenCalled();
    const histories = await prisma.weleticLoyaltyTierHistory.findMany({
      where: { accountId: id },
      orderBy: { sequenceNumber: "asc" },
    });
    expect(histories.map((row) => row.changeReason)).toEqual([
      "threshold_reached",
      "annual_downgrade",
      "threshold_reached",
    ]);
    expect(histories.map((row) => row.sequenceNumber)).toEqual([1, 2, 3]);
    const notices = await prisma.weleticLoyaltyOutboxJob.findMany({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    });
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((row) => row.idempotencyKey)).size).toBe(2);
    expect(
      notices.find((row) => row.id !== original.id)?.payload,
    ).toMatchObject({ tierHistoryId: histories[2].id, sequenceNumber: 3 });
    expect(
      await prisma.weleticPointsLedgerEntry.count({
        where: { storeId: id, entryType: "TIER_BONUS" },
      }),
    ).toBe(2);
  },
);

it("rejects stale-generation VIP evaluation before promotion", async () => {
  const id = await seedVip();
  await prisma.weleticShopifyStore.update({
    where: { id },
    data: { installationGeneration: "g2" },
  });
  await expect(
    evaluateTierMaintenanceCycle(vipEvaluation(id)),
  ).rejects.toThrow();
  expect(
    await prisma.weleticLoyaltyTierHistory.count({ where: { accountId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
});

async function seedSignup() {
  const { id } = await seed();
  // Remove the unrelated synthetic delivery candidate, leaving a fresh account.
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  return id;
}

it("commits one signup ledger and communication under concurrent replay", async () => {
  const id = await seedSignup();
  const award = () =>
    awardSignupWelcomeBonus({
      storeId: id,
      accountId: id,
      bonusPoints: BigInt(100),
    });
  const entries = await Promise.all([award(), award()]);
  expect(entries[0]?.id).toBe(entries[1]?.id);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toMatchObject({
    source: "signup_points_available",
    points: "100",
    ledgerEntryId: entries[0]?.id,
  });
  expect(jobs[0].payload).not.toHaveProperty("orderId");
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(100));
});

it("does not backfill signup communications after later policy opt-in", async () => {
  const id = await seedSignup();
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata: {} },
  });
  await awardSignupWelcomeBonus({
    storeId: id,
    accountId: id,
    bonusPoints: BigInt(100),
  });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: { metadata },
  });
  await awardSignupWelcomeBonus({
    storeId: id,
    accountId: id,
    bonusPoints: BigInt(100),
  });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(0);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
});

it("rolls back the real signup ledger and balance when communication insertion fails", async () => {
  const id = await seedSignup();
  await expect(
    prisma.$transaction(async (tx) => {
      const failingTx = new Proxy(tx, {
        get(target, property) {
          if (property !== "weleticLoyaltyOutboxJob")
            return Reflect.get(target, property);
          return new Proxy(target.weleticLoyaltyOutboxJob, {
            get(delegate, operation) {
              if (operation !== "create")
                return Reflect.get(delegate, operation);
              return async () => {
                throw new Error("Injected outbox insertion failure");
              };
            },
          });
        },
      });
      await awardSignupWelcomeBonus({
        storeId: id,
        accountId: id,
        bonusPoints: BigInt(100),
        tx: failingTx,
      });
    }),
  ).rejects.toThrow("Injected outbox insertion failure");
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(0));
});

async function seedVipPrivacy() {
  const id = await seedVip();
  await evaluateTierMaintenanceCycle(vipEvaluation(id));
  const candidate = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  const now = new Date();
  return {
    id,
    args: {
      claim: {
        candidate,
        ownerToken: "fixture-owner",
        claimedAt: now,
        attempt: 1,
      } satisfies CommunicationDeliveryClaim,
      accountId: id,
      expectedInstallationGeneration: "g1",
      recipientEmail: request.to,
      prepare: vi.fn().mockResolvedValue(request),
    },
  };
}

it.each([
  ["before_completion", "purchase_points_available"],
  ["after_completion", "purchase_points_available"],
  ["before_completion", "signup_points_available"],
  ["after_completion", "signup_points_available"],
  ["before_completion", "birthday_points_available"],
  ["after_completion", "birthday_points_available"],
  ["before_completion", "vip_threshold_promotion"],
  ["after_completion", "vip_threshold_promotion"],
] as const)(
  "erases retained communication evidence when redaction wins %s for %s",
  async (ordering, source) => {
    const { id, args } =
      source === "vip_threshold_promotion"
        ? await seedVipPrivacy()
        : await seed(source);
    const jobId = args.claim.candidate.id;
    await prisma.weleticLoyaltyOutboxJob.update({
      where: { id: jobId },
      data: {
        status: "pending",
        attempts: 0,
        lockedBy: null,
        lockedAt: null,
        scheduledFor: new Date(0),
      },
    });
    const scrub = async () => {
      // The durable scrub phase follows account closure. This test is not a
      // substitute for the complete Shopify privacy ingress/locking lifecycle.
      await prisma.weleticLoyaltyAccount.update({
        where: { id },
        data: { status: "closed" },
      });
      return processWeleticLoyaltyAccountPrivacyScrubStep({
        storeId: id,
        accountId: id,
        phase: "scrub_account_outbox",
        redactedAt: new Date(),
      });
    };
    workerSender.mockReset();
    workerSender.mockImplementation(async ({ claim }) => {
      await retainCommunicationDeliveryRequest({ ...args, claim });
      const retained = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(retained.status).toBe("processing");
      expect(retained.payload).toHaveProperty("communicationDeliverySnapshot");
      if (ordering === "before_completion") await scrub();
      return "sent";
    });
    const result = await processOutboxJobsBatch({
      storeId: id,
      jobIds: [jobId],
      workerId: "synthetic-communication-privacy-worker",
      batchSize: 1,
    });
    expect(workerSender).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(ordering === "before_completion" ? 0 : 1);
    expect(result.skipped).toBe(ordering === "before_completion" ? 1 : 0);
    if (ordering === "after_completion") {
      const completed = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      expect(completed.status).toBe("completed");
      expect(completed.payload).toHaveProperty("communicationDeliverySnapshot");
      await scrub();
    }
    const erased = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(erased.status).toBe(
      ordering === "before_completion" ? "cancelled" : "completed",
    );
    expect(erased.payload).not.toHaveProperty("communicationDeliverySnapshot");
    expect(JSON.stringify(erased.payload)).not.toContain(request.to);
    expect(erased.lockedBy).toBeNull();
    expect(erased.lockedAt).toBeNull();
    expect(erased.errorLog).toBeNull();
    // A later worker poll cannot resurrect the stale retained claim.
    await processOutboxJobsBatch({
      storeId: id,
      jobIds: [jobId],
      batchSize: 1,
    });
    expect(workerSender).toHaveBeenCalledTimes(1);
    expect(
      (
        await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
          where: { id: jobId },
        })
      ).payload,
    ).not.toHaveProperty("communicationDeliverySnapshot");
  },
);

it("allows one competing claim snapshot and retries the exact persisted request", async () => {
  const { id, args } = await seed();
  const outcomes = await Promise.allSettled([
    retainCommunicationDeliveryRequest(args),
    retainCommunicationDeliveryRequest({
      ...args,
      claim: structuredClone(args.claim),
    }),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((result) => result.status === "rejected"),
  ).toHaveLength(1);
  const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id },
  });
  expect(JSON.stringify(row.payload)).not.toContain(request.to);
  const prepare = vi.fn(() => {
    throw new Error("Retry must not rerender");
  });
  expect(
    await retainCommunicationDeliveryRequest({
      ...args,
      claim: { ...args.claim, candidate: row },
      prepare,
    }),
  ).toEqual(request);
  expect(prepare).not.toHaveBeenCalled();
});

// Real overlapping transactions, without asserting a particular lock-wait time.
async function changeFirst(
  id: string,
  mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
  retain: () => Promise<unknown>,
) {
  let signal!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const change = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${id} FOR UPDATE`;
    await mutate(tx);
    signal();
    await gate;
  });
  await Promise.race([
    locked,
    change.then(() => {
      throw new Error("Unexpected transaction completion");
    }),
  ]);
  const attempt = retain().then(
    () => false,
    () => true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await change;
  expect(await attempt).toBe(true);
}
it.each([
  "program",
  "policy",
  "pause",
  "generation",
  "consent",
  "claim",
  "privacy",
])(
  "rejects a change-first %s transaction before retaining a request",
  async (kind) => {
    const { id, args } = await seed();
    await changeFirst(
      id,
      (tx) => {
        if (kind === "program")
          return tx.weleticLoyaltyProgram.update({
            where: { id },
            data: { killSwitchActive: true },
          });
        if (kind === "policy")
          return tx.weleticLoyaltyProgram.update({
            where: { id },
            data: {
              metadata: {
                loyaltyCommunications: {
                  version: 1,
                  sequence: 2,
                  policies: [{ ...policy, enabled: false }],
                },
              },
            },
          });
        if (kind === "pause")
          return tx.weleticMerchantSettings.update({
            where: { storeId: id },
            data: { shopperEmailPaused: true },
          });
        if (kind === "generation")
          return tx.weleticShopifyStore.update({
            where: { id },
            data: { installationGeneration: "g2" },
          });
        if (kind === "consent")
          return tx.weleticShopper.update({
            where: { id },
            data: { acceptsMarketing: false },
          });
        if (kind === "privacy")
          return tx.weleticLoyaltyAccount.update({
            where: { id },
            data: { status: "closed" },
          });
        return tx.weleticLoyaltyOutboxJob.update({
          where: { id },
          data: { lockedBy: "new-owner", attempts: 2 },
        });
      },
      () => retainCommunicationDeliveryRequest(args),
    );
    expect(args.prepare).not.toHaveBeenCalled();
    const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id },
    });
    expect(row.payload).not.toHaveProperty("communicationDeliverySnapshot");
  },
);
it("rechecks policy admission for an already retained retry", async () => {
  const { id, args } = await seed();
  await retainCommunicationDeliveryRequest(args);
  args.prepare.mockClear();
  await changeFirst(
    id,
    (tx) =>
      tx.weleticLoyaltyProgram.update({
        where: { id },
        data: { killSwitchActive: true },
      }),
    () => retainCommunicationDeliveryRequest(args),
  );
  expect(args.prepare).not.toHaveBeenCalled();
});

async function seedFinancial(held = false) {
  const { id } = await seed();
  await prisma.weleticLoyaltyOutboxJob.delete({ where: { id } });
  const amount = BigInt(10000);
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId: id,
      programId: id,
      shopperId: id,
      externalId: id,
      status: "paid",
      presentmentCurrency: "JPY",
      presentmentSubtotal: amount,
      presentmentNet: amount,
      presentmentTotal: amount,
      shopCurrency: "JPY",
      shopSubtotal: amount,
      shopNet: amount,
      shopTotal: amount,
      accountingCurrency: "JPY",
      accountingNet: amount,
      accountingTotal: amount,
      accountingFxRate: 1,
      occurredAt: new Date(),
    },
  });
  await prisma.weleticCommerceOrderLine.create({
    data: {
      id,
      orderId: id,
      externalId: id,
      title: "Synthetic item",
      quantity: 10,
      presentmentGross: amount,
      presentmentNet: amount,
      shopGross: amount,
      shopNet: amount,
      accountingNet: amount,
      commissionableAccountingAmount: amount,
    },
  });
  await prisma.weleticLoyaltyEarnGrant.create({
    data: {
      id,
      storeId: id,
      programId: id,
      accountId: id,
      shopperId: id,
      orderId: id,
      status: held ? "pending" : "settled",
      currency: "JPY",
      eligibleSubtotalAmount: amount,
      orderTotalAmount: amount,
      grossPoints: BigInt(100),
      pendingPoints: held ? BigInt(100) : BigInt(0),
      settledPoints: held ? BigInt(0) : BigInt(100),
      availableAt: new Date(0),
      pointsPerCurrencyUnit: 1,
      effectiveMultiplier: 1,
    },
  });
  await prisma.weleticLoyaltyOrderLineEarn.create({
    data: {
      id,
      grantId: id,
      orderLineId: id,
      storeId: id,
      quantity: 10,
      lineNetAmount: amount,
      awardedPoints: BigInt(100),
    },
  });
  if (held)
    await prisma.weleticLoyaltyAccount.update({
      where: { id },
      data: { cachedPendingPoints: BigInt(100) },
    });
  return id;
}
function post(id: string, rollback = false) {
  return withActiveStoreLoyaltyMutation({
    storeId: id,
    action: "communication_db_fixture",
    expectedInstallationGeneration: "g1",
    operation: async (tx) => {
      const receipt = await appendPointsLedgerEntryWithReceipt({
        tx,
        storeId: id,
        accountId: id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(100),
        grantId: id,
        referenceType: "COMMERCE_ORDER",
        referenceId: id,
        idempotencyKey: `earn:${id}`,
      });
      await enqueuePurchasePointsCommunication({
        tx,
        storeId: id,
        programId: id,
        receipt,
      });
      if (rollback) throw new Error("Synthetic rollback after enqueue");
      return receipt.created;
    },
  });
}
it("commits one ledger and notification across competing same-event transactions", async () => {
  const id = await seedFinancial();
  expect((await Promise.all([post(id), post(id)])).sort()).toEqual([
    false,
    true,
  ]);
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(1);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(1);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(100));
});
it("rolls back ledger, balance and notification atomically", async () => {
  const id = await seedFinancial();
  await expect(post(id, true)).rejects.toThrow("Synthetic rollback");
  expect(
    await prisma.weleticPointsLedgerEntry.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(0);
  expect(
    (await prisma.weleticLoyaltyAccount.findUniqueOrThrow({ where: { id } }))
      .cachedPointsBalance,
  ).toBe(BigInt(0));
});
it("reconciles a persisted partial refund before a holding-release notification", async () => {
  const id = await seedFinancial(true);
  await prisma.weleticCommerceOrder.update({
    where: { id },
    data: { status: "partially_refunded" },
  });
  const amount = BigInt(3000);
  await prisma.weleticCommerceRefund.create({
    data: {
      id,
      storeId: id,
      orderId: id,
      externalId: id,
      presentmentCurrency: "JPY",
      presentmentAmount: amount,
      shopCurrency: "JPY",
      shopAmount: amount,
      accountingCurrency: "JPY",
      accountingAmount: amount,
      accountingFxRate: 1,
      occurredAt: new Date(),
    },
  });
  await prisma.weleticCommerceRefundLine.create({
    data: {
      id,
      refundId: id,
      orderLineId: id,
      externalId: id,
      quantity: 3,
      presentmentAmount: amount,
      shopAmount: amount,
      accountingAmount: amount,
    },
  });
  const result = await releaseHoldingPeriodGrant({
    storeId: id,
    grantId: id,
    expectedInstallationGeneration: "g1",
  });
  expect(result.released).toBe(true);
  const account = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id },
  });
  expect(account.cachedPointsBalance).toBe(BigInt(70));
  expect(account.cachedPendingPoints).toBe(BigInt(0));
  const grant = await prisma.weleticLoyaltyEarnGrant.findUniqueOrThrow({
    where: { id },
  });
  expect(grant.settledPoints).toBe(BigInt(70));
  expect(grant.reversedPoints).toBe(BigInt(30));
  const jobs = await prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
  });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toMatchObject({ points: "70", ledgerPoints: "100" });
  await releaseHoldingPeriodGrant({
    storeId: id,
    grantId: id,
    expectedInstallationGeneration: "g1",
  });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: id, jobType: "LOYALTY_COMMUNICATION" },
    }),
  ).toBe(1);
});

async function isolateExpirySweepFixtures() {
  // Only IDs created by this already-verified disposable database suite.
  await prisma.weleticLoyaltyProgram.updateMany({
    where: { storeId: { in: fixtures } },
    data: { status: "disabled" },
  });
}
async function seedExpiryReward() {
  const id = await seedRedemption(new Date(Date.now() + 3 * 86400000));
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        preserved: "merchant-value",
        loyaltyCommunications: {
          version: 1,
          sequence: 1,
          policies: [
            {
              ...createDefaultLoyaltyCommunicationPolicy("reward_expiry"),
              enabled: true,
            },
          ],
        },
      },
    },
  });
  await issueRedemption(id);
  return id;
}

async function seedExpiryReferralCoupon() {
  const id = await seedReferralPoints();
  const refereeId = `referee-${id}`;
  await prisma.weleticShopper.create({
    data: {
      id: refereeId,
      storeId: id,
      shopifyCustomerId: refereeId,
      email: "synthetic-friend@example.com",
      acceptsMarketing: true,
    },
  });
  await prisma.weleticLoyaltyAccount.create({
    data: {
      id: refereeId,
      storeId: id,
      programId: id,
      shopperId: refereeId,
      status: "active",
    },
  });
  const qualifiedAt = new Date(Date.now() - 1000);
  const identity = {
    storeId: id,
    programId: id,
    referralId: id,
    qualificationOrderId: id,
    accountId: id,
    side: "advocate" as const,
  };
  const reward = await prisma.weleticRewardDefinition.create({
    data: {
      id,
      storeId: id,
      name: "Synthetic referral coupon",
      rewardType: "amount_off",
      pointsCost: BigInt(100),
      discountValue: 500,
      expiresInDays: 3,
    },
  });
  const snapshot = createReferralCouponRewardSnapshot({
    identity: { ...identity, rewardDefinitionId: id },
    reward,
    qualifiedAt,
    shopCurrency: "JPY",
    currencyVerifiedAt: qualifiedAt,
    shopifyCustomerId: id,
  });
  const origin = createReferralCommunicationOrigin({
    ...identity,
    installationGeneration: "g1",
    qualificationPath: "account_referral",
    qualifiedAt: qualifiedAt.toISOString(),
    kind: "coupon",
    rewardDefinitionId: id,
    rewardSnapshotDigest: snapshot.contentDigest,
  });
  await prisma.weleticLoyaltyReferral.update({
    where: { id },
    data: {
      advocatePointsAwarded: BigInt(0),
      refereeAccountId: refereeId,
      metadata: {
        qualificationOrderId: id,
        referralCommunicationOrigins: { advocate: origin },
        referralCouponRewardSnapshots: { advocate: snapshot },
      },
    },
  });
  await prisma.weleticRewardRedemption.create({
    data: {
      id,
      storeId: id,
      accountId: id,
      rewardDefinitionId: id,
      idempotencyKey: getReferralCouponIdempotencyKey(identity),
      status: "issued",
      artifactKind: "discount_code",
      pointsSpent: BigInt(0),
      shopifyDiscountId: `synthetic-${id}`,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountCodeCanonical: snapshot.discountCode,
      createdAt: qualifiedAt,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: {
        referralId: id,
        qualificationOrderId: id,
        referralSide: "advocate",
        rewardSnapshot: snapshot,
        referralCommunicationIssuedAt: new Date().toISOString(),
        shopifyDiscountOwnershipFingerprint: snapshot.ownershipFingerprint,
        shopifyDiscountProvisioningName: snapshot.provisioningName,
        shopifyDiscountExpectedTitle: snapshot.expectedTitle,
      },
    },
  });
  const amount = BigInt(10000);
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId: id,
      programId: id,
      shopperId: refereeId,
      externalId: id,
      status: "paid",
      presentmentCurrency: "JPY",
      presentmentSubtotal: amount,
      presentmentNet: amount,
      presentmentTotal: amount,
      shopCurrency: "JPY",
      shopSubtotal: amount,
      shopNet: amount,
      shopTotal: amount,
      accountingCurrency: "JPY",
      accountingNet: amount,
      accountingTotal: amount,
      accountingFxRate: 1,
      occurredAt: qualifiedAt,
    },
  });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        loyaltyCommunications: {
          version: 1,
          sequence: 2,
          policies: [
            {
              ...createDefaultLoyaltyCommunicationPolicy("reward_expiry"),
              enabled: true,
            },
          ],
        },
      },
    },
  });
  return id;
}

it.each([
  ...(["redemption", "referral_coupon"] as const).flatMap((kind) =>
    (["used", "expired", "generation", "suspended"] as const).map((change) => ({
      kind,
      change,
    })),
  ),
  { kind: "referral_coupon" as const, change: "order_refunded" as const },
  { kind: "referral_coupon" as const, change: "referral_cancelled" as const },
])(
  "rejects retained SQL $kind expiry delivery after $change wins",
  async ({ kind, change }) => {
    await isolateExpirySweepFixtures();
    const id =
      kind === "redemption"
        ? await seedExpiryReward()
        : await seedExpiryReferralCoupon();
    const now = new Date(Date.now() + 1000);
    expect(await enqueueRewardExpiryReminderJobs({ now })).toMatchObject({
      jobsEnqueued: 1,
      programFailures: [],
    });
    const queued = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: id },
    });
    const candidate = await prisma.weleticLoyaltyOutboxJob.update({
      where: { id: queued.id },
      data: {
        status: "processing",
        attempts: 1,
        lockedBy: "expiry-fixture-owner",
        lockedAt: now,
      },
    });
    const args = {
      claim: {
        candidate,
        ownerToken: candidate.lockedBy!,
        claimedAt: candidate.lockedAt!,
        attempt: 1,
      },
      accountId: id,
      expectedInstallationGeneration: "g1",
      recipientEmail: request.to,
      prepare: vi.fn().mockResolvedValue(request),
      wallClockNow: now,
    };
    expect(await retainCommunicationDeliveryRequest(args)).toEqual(request);
    const retained = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(retained.payload).toHaveProperty("communicationDeliverySnapshot");
    expect(JSON.stringify(retained.payload)).not.toContain(request.to);
    const retry = {
      ...args,
      claim: { ...args.claim, candidate: retained },
      prepare: vi.fn(() => {
        throw new Error("A retained retry must not render again");
      }),
    };
    expect(await retainCommunicationDeliveryRequest(retry)).toEqual(request);
    if (change === "order_refunded") {
      await prisma.weleticCommerceOrder.update({
        where: { id },
        data: { status: "refunded" },
      });
    } else if (change === "referral_cancelled") {
      await prisma.weleticLoyaltyReferral.update({
        where: { id },
        data: { status: "cancelled" },
      });
    } else if (change === "used") {
      await prisma.weleticRewardRedemption.update({
        where: { id },
        data: { status: "used" },
      });
    } else if (change === "expired") {
      const redemption = await prisma.weleticRewardRedemption.findUniqueOrThrow(
        {
          where: { id },
        },
      );
      retry.wallClockNow = redemption.expiresAt!;
    } else {
      await prisma.weleticShopifyStore.update({
        where: { id },
        data:
          change === "generation"
            ? { installationGeneration: "g2" }
            : { storeAccessState: "suspended" },
      });
    }
    await expect(retainCommunicationDeliveryRequest(retry)).rejects.toThrow();
    expect(retry.prepare).not.toHaveBeenCalled();
    expect(
      await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id: candidate.id },
      }),
    ).toEqual(retained);
  },
);

it("rotates actual MySQL sweep ordering across seven stores and repairs malformed/future cursors", async () => {
  await isolateExpirySweepFixtures();
  const ids: string[] = [];
  for (let n = 0; n < 7; n++) ids.push(await seedExpiryReward());
  for (const [index, stamp] of [
    "2099-01-01T00:00:00.000Z",
    "invalid",
  ].entries()) {
    const program = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
      where: { id: ids[index] },
    });
    await prisma.weleticLoyaltyProgram.update({
      where: { id: program.id },
      data: {
        metadata: {
          ...(program.metadata as Prisma.JsonObject),
          [REWARD_EXPIRY_SWEEP_KEY]: {
            installationGeneration: "old-generation",
            lastRedemptionId: "zzzz",
            lastScannedAt: stamp,
          },
        },
      },
    });
  }
  const now = new Date(Date.now() + 1000);
  const first = await enqueueRewardExpiryReminderJobs({ now });
  const second = await enqueueRewardExpiryReminderJobs({
    now: new Date(now.getTime() + 1000),
  });
  expect(first.programFailures).toEqual([]);
  expect(second.programFailures).toEqual([]);
  expect(first.programsScanned).toBe(5);
  expect(first.jobsEnqueued + second.jobsEnqueued).toBe(7);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId: { in: ids } },
    }),
  ).toBe(7);
  for (const id of ids) {
    const program = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
      where: { id },
    });
    expect(program.metadata).toMatchObject({
      preserved: "merchant-value",
      [REWARD_EXPIRY_SWEEP_KEY]: {
        installationGeneration: "g1",
        lastRedemptionId: null,
      },
    });
  }
});

it("advances the actual SQL cursor past invalid receipts and does not duplicate concurrent sweeps", async () => {
  await isolateExpirySweepFixtures();
  const id = await seedExpiryReward();
  for (const prefix of ["a", "b", "c"]) {
    await prisma.weleticRewardRedemption.create({
      data: {
        id: prefix + "-" + id,
        storeId: id,
        accountId: id,
        rewardDefinitionId: id,
        pointsSpent: BigInt(100),
        status: "issued",
        artifactKind: "discount_code",
        shopifyDiscountCode: prefix + "-" + id,
        shopifyDiscountCodeCanonical: (prefix + "-" + id).toUpperCase(),
        expiresAt: new Date(Date.now() + 86400000),
        metadata: {},
      },
    });
  }
  const now = new Date(Date.now() + 1000);
  const first = await enqueueRewardExpiryReminderJobs({ now, batchSize: 2 });
  expect(first).toMatchObject({
    rewardsScanned: 2,
    ineligible: 2,
    jobsEnqueued: 0,
    programFailures: [],
  });
  const program = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { id },
  });
  expect(readRewardExpirySweepCursor(program.metadata, "g1")).toBe("b-" + id);
  const runs = await Promise.all([
    enqueueRewardExpiryReminderJobs({
      now: new Date(now.getTime() + 1000),
      batchSize: 2,
    }),
    enqueueRewardExpiryReminderJobs({
      now: new Date(now.getTime() + 2000),
      batchSize: 2,
    }),
  ]);
  expect(runs.flatMap((r) => r.programFailures)).toEqual([]);
  expect(runs.reduce((n, r) => n + r.jobsEnqueued, 0)).toBe(1);
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(1);
});

it("rolls back queue failure and preserves the SQL retry cursor while recording its turn", async () => {
  await isolateExpirySweepFixtures();
  const id = await seedExpiryReward();
  const program = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { id },
  });
  await prisma.weleticLoyaltyProgram.update({
    where: { id },
    data: {
      metadata: {
        ...(program.metadata as Prisma.JsonObject),
        [REWARD_EXPIRY_SWEEP_KEY]: {
          installationGeneration: "g1",
          lastRedemptionId: "0",
          lastScannedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  });
  const collisionId = "collision-" + id;
  await prisma.weleticLoyaltyOutboxJob.create({
    data: {
      id: collisionId,
      storeId: id,
      jobType: "LOYALTY_COMMUNICATION",
      status: "completed",
      payload: { syntheticCollisionFixture: true },
      idempotencyKey: "collision-fixture",
    },
  });
  const createId = vi
    .spyOn(weleticIds, "createWeleticId")
    .mockReturnValue(collisionId);
  const now = new Date(Date.now() + 1000);
  try {
    const result = await enqueueRewardExpiryReminderJobs({ now });
    expect(result).toMatchObject({
      rewardsScanned: 0,
      jobsEnqueued: 0,
      programFailures: [{ storeId: id, checkpointRetained: true }],
    });
  } finally {
    createId.mockRestore();
  }
  const failed = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { id },
  });
  expect(readRewardExpirySweepCursor(failed.metadata, "g1")).toBe("0");
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(1);
  const retry = await enqueueRewardExpiryReminderJobs({
    now: new Date(now.getTime() + 1000),
  });
  expect(retry).toMatchObject({ jobsEnqueued: 1, programFailures: [] });
  expect(
    await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId: id } }),
  ).toBe(2);
});
