import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import {
  enqueueOutboxJob,
  processOutboxJobsBatch,
  reapStaleOutboxLocks,
} from "@/lib/weletic/loyalty/outbox";
import { deliverReferralEmailUnderLease } from "@/lib/weletic/loyalty/referral-friend-claim";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sendBatchEmail } from "../../../../packages/email/src";

const emailTransportMocks = vi.hoisted(() => ({
  resendClient: null as object | null,
  sendViaResend: vi.fn(),
  sendViaSmtp: vi.fn(),
}));

vi.mock("../../../../packages/email/src/resend", () => ({
  get resend() {
    return emailTransportMocks.resendClient;
  },
}));

vi.mock("../../../../packages/email/src/send-via-resend", () => ({
  sendBatchEmailViaResend: emailTransportMocks.sendViaResend,
  sendEmailViaResend: vi.fn(),
}));

vi.mock("../../../../packages/email/src/send-via-nodemailer", () => ({
  sendViaNodeMailer: emailTransportMocks.sendViaSmtp,
}));

const RUN_ID = `ops_dbit_${process.pid}_${Date.now()}`;
const workspaceId = `ws_${RUN_ID}`;
const affiliateProgramId = `program_${RUN_ID}`;
const storeId = `store_${RUN_ID}`;
const loyaltyProgramId = `loyalty_${RUN_ID}`;
const shopperId = `shopper_${RUN_ID}`;
const accountId = `account_${RUN_ID}`;

function requireIsolatedDatabase() {
  if (process.env.LOYALTY_DATABASE_INTEGRATION !== "1") {
    throw new Error(
      "Set LOYALTY_DATABASE_INTEGRATION=1 to run the real loyalty database suite",
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.startsWith("weletic_loyalty_it_")) {
    throw new Error(
      `Refusing to run against non-isolated database '${databaseName}'`,
    );
  }
}

describe("loyalty operational paths real database concurrency", () => {
  beforeAll(async () => {
    requireIsolatedDatabase();
    await prisma.project.create({
      data: {
        id: workspaceId,
        name: "Loyalty Operations DB Integration",
        slug: workspaceId,
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: affiliateProgramId,
        workspaceId,
        defaultFolderId: `folder_${RUN_ID}`,
        defaultGroupId: `group_${RUN_ID}`,
        name: "Loyalty Operations DB Integration",
        slug: affiliateProgramId,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        storeAccessState: "active",
        id: storeId,
        projectId: workspaceId,
        programId: affiliateProgramId,
        shopDomain: `${RUN_ID}.myshopify.com`,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: loyaltyProgramId, storeId, status: "active" },
    });
    await prisma.weleticShopper.create({
      data: {
        id: shopperId,
        storeId,
        shopifyCustomerId: `customer_${RUN_ID}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId,
        programId: loyaltyProgramId,
        shopperId,
        referralCode: `REF-${RUN_ID}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.weleticLoyaltyOutboxJob.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyReferral.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyAccount.deleteMany({ where: { storeId } });
    await prisma.weleticShopper.deleteMany({ where: { storeId } });
    await prisma.weleticLoyaltyProgram.deleteMany({ where: { storeId } });
    await prisma.weleticShopifyStore.deleteMany({ where: { id: storeId } });
    // relationMode="prisma" emulates cascades by selecting every relation
    // field, including compatibility-only columns absent from this db-push
    // fixture. Direct deletes keep teardown scoped to the isolated test rows.
    await prisma.$executeRaw`DELETE FROM \`Program\` WHERE \`id\` = ${affiliateProgramId}`;
    await prisma.$executeRaw`DELETE FROM \`Project\` WHERE \`id\` = ${workspaceId}`;
    await prisma.$disconnect();
  });

  afterEach(() => {
    emailTransportMocks.resendClient = null;
    emailTransportMocks.sendViaResend.mockReset();
    emailTransportMocks.sendViaSmtp.mockReset();
    vi.unstubAllEnvs();
  });

  it.each([
    { transport: "resend", resendConfigured: true },
    { transport: "smtp", resendConfigured: false },
  ])(
    "permits exactly one $transport send under concurrent lease acquisition",
    async ({ transport, resendConfigured }) => {
      emailTransportMocks.resendClient = resendConfigured ? {} : null;
      emailTransportMocks.sendViaResend.mockReset();
      emailTransportMocks.sendViaSmtp.mockReset();
      emailTransportMocks.sendViaResend.mockResolvedValue({
        data: [{ id: `resend_${RUN_ID}` }],
        error: null,
      });
      emailTransportMocks.sendViaSmtp.mockResolvedValue({
        messageId: `smtp_${RUN_ID}`,
      });
      vi.stubEnv("SMTP_HOST", "smtp.test.invalid");
      vi.stubEnv("SMTP_PORT", "2525");

      const referralId = `referral_${transport}_${RUN_ID}`;
      await prisma.weleticLoyaltyReferral.create({
        data: {
          id: referralId,
          storeId,
          advocateAccountId: accountId,
          friendEmailDigest: `digest_${transport}_${RUN_ID}`,
          friendRewardProvisionedAt: new Date(),
        },
      });
      let sends = 0;
      const results = await Promise.all(
        Array.from({ length: 32 }, () =>
          deliverReferralEmailUnderLease({
            referralId,
            storeId,
            deliver: async () => {
              sends++;
              await new Promise((resolve) => setTimeout(resolve, 40));
              const delivery = await sendBatchEmail([
                {
                  to: `${transport}@example.test`,
                  subject: "Referral reward",
                  text: "Referral reward delivery concurrency proof",
                },
              ]);
              return {
                success: Boolean(delivery?.data),
                error: delivery?.error
                  ? String(delivery.error)
                  : delivery?.data
                    ? undefined
                    : "Delivery response data empty",
              };
            },
          }),
        ),
      );

      expect(sends).toBe(1);
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      const persisted = await prisma.weleticLoyaltyReferral.findUniqueOrThrow({
        where: { id: referralId },
      });
      expect(persisted.friendRewardEmailedAt).not.toBeNull();
      expect(persisted.friendEmailDeliveryAttempts).toBe(1);
      expect(persisted.friendEmailLeaseToken).toBeNull();
      expect(emailTransportMocks.sendViaResend).toHaveBeenCalledTimes(
        resendConfigured ? 1 : 0,
      );
      expect(emailTransportMocks.sendViaSmtp).toHaveBeenCalledTimes(
        resendConfigured ? 0 : 1,
      );
    },
  );

  it("counts only the single newly-created outbox job during a real burst", async () => {
    const idempotencyKey = `ops_outbox_${RUN_ID}`;
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        enqueueOutboxJob({
          storeId,
          jobType: "VOUCHER_PRIVACY_CLEANUP",
          payload: {
            cleanupId: `cleanup_${RUN_ID}`,
            redemptionId: `redemption_${RUN_ID}`,
            accountId,
          },
          idempotencyKey,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    await expect(
      prisma.weleticLoyaltyOutboxJob.count({
        where: { storeId, idempotencyKey },
      }),
    ).resolves.toBe(1);
  });

  it("deduplicates a Flow event across concurrent producer transactions", async () => {
    const eventId = `ledger_flow_${RUN_ID}`;
    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        prisma.$transaction((tx) =>
          enqueueFlowTriggerJob({
            storeId,
            eventId,
            payload: {
              accountId,
              handle: "weletic-points-earned",
              pointsDelta: "25",
              pointsBalance: "125",
              reason: "database_concurrency_test",
            },
            tx,
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    await expect(
      prisma.weleticLoyaltyOutboxJob.count({
        where: {
          storeId,
          idempotencyKey: `flow_trigger:weletic-points-earned:${eventId}`,
        },
      }),
    ).resolves.toBe(1);
  });

  it("allows exactly one real worker to acquire and fail an outbox job", async () => {
    const jobId = `outbox_worker_race_${RUN_ID}`;
    await prisma.weleticLoyaltyOutboxJob.create({
      data: {
        id: jobId,
        storeId,
        jobType: "VOUCHER_PRIVACY_CLEANUP",
        payload: {},
        idempotencyKey: `ops_worker_race_${RUN_ID}`,
        maxAttempts: 1,
      },
    });

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        processOutboxJobsBatch({
          batchSize: 1,
          storeId,
          jobIds: [jobId],
          workerId: `ops-worker-${index}`,
        }),
      ),
    );

    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1);
    const persisted = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        attempts: true,
        status: true,
        lockedBy: true,
        errorLog: true,
      },
    });
    expect(persisted).toMatchObject({
      attempts: 1,
      status: "dead_letter",
      lockedBy: null,
    });
    expect(persisted.errorLog).toEqual([
      expect.objectContaining({ attempt: 1 }),
    ]);
  });

  it("lets exactly one reaper release a stale real worker lease", async () => {
    const jobId = `outbox_stale_worker_${RUN_ID}`;
    const now = new Date("2026-09-04T12:00:00.000Z");
    await prisma.weleticLoyaltyOutboxJob.create({
      data: {
        id: jobId,
        storeId,
        jobType: "VOUCHER_PRIVACY_CLEANUP",
        payload: {},
        idempotencyKey: `ops_stale_worker_${RUN_ID}`,
        status: "processing",
        lockedAt: new Date("2026-09-04T11:00:00.000Z"),
        lockedBy: "dead-worker",
        attempts: 1,
      },
    });

    const reaped = await Promise.all(
      Array.from({ length: 16 }, () =>
        reapStaleOutboxLocks(60_000, now, { storeId, jobIds: [jobId] }),
      ),
    );

    expect(reaped.reduce((sum, count) => sum + count, 0)).toBe(1);
    await expect(
      prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { status: true, lockedAt: true, lockedBy: true },
      }),
    ).resolves.toEqual({ status: "failed", lockedAt: null, lockedBy: null });
  });

  it("allows one new owner to acquire an expired stale email lease", async () => {
    const referralId = `referral_stale_${RUN_ID}`;
    await prisma.weleticLoyaltyReferral.create({
      data: {
        id: referralId,
        storeId,
        advocateAccountId: accountId,
        friendEmailDigest: `digest_stale_${RUN_ID}`,
        friendRewardProvisionedAt: new Date(),
        friendEmailLeaseToken: "stale-worker",
        friendEmailLeaseReservedAt: new Date("2026-09-01T00:00:00.000Z"),
        friendEmailLeaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
        friendEmailDeliveryAttempts: 1,
      },
    });
    let sends = 0;
    const result = await deliverReferralEmailUnderLease({
      referralId,
      storeId,
      now: new Date("2026-09-01T00:02:00.000Z"),
      deliver: async () => {
        sends++;
        return { success: true };
      },
    });

    expect(result).toEqual({ acquired: true, emailSent: true });
    expect(sends).toBe(1);
    await expect(
      prisma.weleticLoyaltyReferral.findUniqueOrThrow({
        where: { id: referralId },
        select: { friendEmailDeliveryAttempts: true },
      }),
    ).resolves.toEqual({ friendEmailDeliveryAttempts: 2 });
  });
});
