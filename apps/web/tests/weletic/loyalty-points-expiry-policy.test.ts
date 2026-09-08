import { prisma } from "@/lib/prisma";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import { sendPointsExpiryNotification } from "@/lib/weletic/loyalty/points-expiry-notifications";
import {
  calculateNextPointsExpiryDate,
  getPointsExpiryStageDate,
  pointsExpiryDatesMatch,
} from "@/lib/weletic/loyalty/points-expiry-policy";
import { enqueuePointsExpiryLifecycleJobs } from "@/lib/weletic/loyalty/points-expiry-scheduler";
import { sendBatchEmail } from "@dub/email";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticMerchantSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    weleticLoyaltyProgram: { findMany: vi.fn() },
    weleticLoyaltyAccount: { findFirst: vi.fn() },
    weleticPointsLedgerEntry: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn(),
}));

vi.mock("@dub/email", () => ({
  sendBatchEmail: vi.fn(),
}));

const policy = {
  status: "active",
  killSwitchActive: false,
  pointsExpiryDays: 0,
  pointsExpiryMonths: 1,
  pointsExpiryWarningDays: 30,
  pointsExpiryLastChanceDays: 3,
  pointsExpiryWarningEnabled: true,
  pointsExpiryLastChanceEnabled: true,
  pointsExpiryPolicyAnchorAt: null,
  pointsExpiryPolicyVersion: 2,
  activatedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
} as const;

describe("Smile-parity rolling points expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(sendBatchEmail).mockResolvedValue({
      data: { data: [{ id: "email_expiry_1" }] },
      error: null,
    } as any);
  });

  it("uses calendar-safe months and the later policy anchor", () => {
    const endOfMonth = calculateNextPointsExpiryDate({
      policy,
      lastActivityAt: new Date("2026-01-31T12:00:00.000Z"),
    });
    expect(endOfMonth?.toISOString()).toBe("2026-02-28T12:00:00.000Z");

    const anchored = calculateNextPointsExpiryDate({
      policy: {
        ...policy,
        pointsExpiryPolicyAnchorAt: new Date("2026-02-15T00:00:00.000Z"),
      },
      lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
      fallbackAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(anchored?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("supports Smile's exact 3-day window and 30/3-day stages", () => {
    const expiryAt = calculateNextPointsExpiryDate({
      policy: { ...policy, pointsExpiryDays: 3, pointsExpiryMonths: 0 },
      lastActivityAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(expiryAt?.toISOString()).toBe("2026-08-04T00:00:00.000Z");

    const annualExpiry = new Date("2027-08-01T00:00:00.000Z");
    expect(
      getPointsExpiryStageDate({
        policy,
        expiryAt: annualExpiry,
        stage: "warning",
      }).toISOString(),
    ).toBe("2027-07-02T00:00:00.000Z");
    expect(
      getPointsExpiryStageDate({
        policy,
        expiryAt: annualExpiry,
        stage: "last_chance",
      }).toISOString(),
    ).toBe("2027-07-29T00:00:00.000Z");
  });

  it("returns no expiry while the program is disabled", () => {
    expect(
      calculateNextPointsExpiryDate({
        policy: { ...policy, status: "disabled" },
        lastActivityAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("resets the rolling account clock for every non-expiration balance change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    const tx = {
      weleticPointsLedgerEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "wledger_adjustment" }),
      },
      weleticLoyaltyAccount: {
        findUnique: vi.fn().mockResolvedValue({
          id: "wlacc_expiry",
          storeId: "wstore_expiry",
          cachedPointsBalance: BigInt(100),
          cachedPendingPoints: BigInt(0),
          lifetimePointsEarned: BigInt(100),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 7,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      weleticLoyaltyProgram: {
        findUnique: vi.fn().mockResolvedValue({
          ...policy,
          pointsExpiryMonths: 12,
        }),
      },
    };

    await appendPointsLedgerEntry({
      storeId: "wstore_expiry",
      accountId: "wlacc_expiry",
      entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      pointsDelta: 50,
      idempotencyKey: "manual:expiry-reset",
      tx: tx as any,
    });

    expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastQualifyingActivityAt: new Date("2026-08-31T12:00:00.000Z"),
          nextExpiryDate: new Date("2027-08-31T12:00:00.000Z"),
          pointsExpiryPolicyVersion: 2,
          pointsExpiryJobsScheduledAt: null,
        }),
      }),
    );
  });

  it("reconciles policy versions and queues warning, last-chance, and expiry exactly once", async () => {
    const expiryAt = new Date("2026-09-30T00:00:00.000Z");
    const accountFindMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "wlacc_expiry",
          cachedPointsBalance: BigInt(500),
          lastQualifyingActivityAt: new Date("2026-08-30T00:00:00.000Z"),
          nextExpiryDate: expiryAt,
        },
      ]);
    const accountUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      weleticLoyaltyProgram: {
        findUnique: vi.fn().mockResolvedValue({
          ...policy,
          id: "wprog_1",
          pointsExpiryPolicyAnchorAt: new Date("2026-08-30T00:00:00.000Z"),
        }),
      },
      weleticLoyaltyAccount: {
        findMany: accountFindMany,
        updateMany: accountUpdateMany,
      },
    };
    vi.mocked(prisma.weleticLoyaltyProgram.findMany).mockResolvedValue([
      { storeId: "wstore_expiry" },
    ] as any);
    vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
      async ({ operation }: any) => operation(tx),
    );
    vi.mocked(enqueueOutboxJobFromProgramTransaction).mockResolvedValue({
      id: "woutbox_expiry",
    } as any);

    const result = await enqueuePointsExpiryLifecycleJobs({
      now: new Date("2026-09-01T00:00:00.000Z"),
      batchSize: 10,
    });

    expect(result).toMatchObject({
      programsScanned: 1,
      accountsScheduled: 1,
      jobsEnqueued: 5,
    });
    expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledTimes(5);
    expect(
      vi
        .mocked(enqueueOutboxJobFromProgramTransaction)
        .mock.calls.filter(([call]) => call.jobType === "INACTIVITY_EXPIRY")
        .map(([call]) => ({
          stage: (call.payload as any).stage,
          scheduledFor: call.scheduledFor?.toISOString(),
          idempotencyKey: call.idempotencyKey,
        })),
    ).toEqual([
      {
        stage: "warning",
        scheduledFor: "2026-09-01T00:00:00.000Z",
        idempotencyKey:
          "inactivity_expiry:warning:wlacc_expiry:2026-09-30T00:00:00.000Z:v2",
      },
      {
        stage: "last_chance",
        scheduledFor: "2026-09-27T00:00:00.000Z",
        idempotencyKey:
          "inactivity_expiry:last_chance:wlacc_expiry:2026-09-30T00:00:00.000Z:v2",
      },
      {
        stage: "expire",
        scheduledFor: "2026-09-30T00:00:00.000Z",
        idempotencyKey:
          "inactivity_expiry:expire:wlacc_expiry:2026-09-30T00:00:00.000Z:v2",
      },
    ]);
    expect(
      vi
        .mocked(enqueueOutboxJobFromProgramTransaction)
        .mock.calls.filter(([call]) => call.jobType === "FLOW_TRIGGER"),
    ).toHaveLength(2);
    expect(accountUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { pointsExpiryJobsScheduledAt: expiryAt },
      }),
    );
  });

  it("publishes the initialized expiry anchor as a revision in the same transaction and at the same instant", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const programUpdate = vi.fn().mockResolvedValue({ id: "wprog_anchor" });
    const tx = {
      weleticLoyaltyProgram: {
        findUnique: vi.fn().mockResolvedValue({
          ...policy,
          id: "wprog_anchor",
          pointsExpiryPolicyAnchorAt: null,
        }),
        update: programUpdate,
      },
      weleticLoyaltyAccount: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    };
    vi.mocked(prisma.weleticLoyaltyProgram.findMany).mockResolvedValue([
      { storeId: "wstore_anchor" },
    ] as any);
    vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
      async ({ operation }: any) => operation(tx),
    );
    vi.mocked(publishLoyaltyEarnPolicyRevision).mockResolvedValue({
      id: "wpolicy_anchor",
    } as any);

    const result = await enqueuePointsExpiryLifecycleJobs({
      now,
      batchSize: 10,
    });

    expect(result).toMatchObject({
      programsScanned: 1,
      accountsReconciled: 0,
      accountsScheduled: 0,
      jobsEnqueued: 0,
    });
    expect(programUpdate).toHaveBeenCalledWith({
      where: { id: "wprog_anchor" },
      data: {
        pointsExpiryPolicyAnchorAt: now,
        pointsExpiryPolicyVersion: 3,
      },
    });
    expect(publishLoyaltyEarnPolicyRevision).toHaveBeenCalledOnce();
    expect(publishLoyaltyEarnPolicyRevision).toHaveBeenCalledWith({
      tx,
      storeId: "wstore_anchor",
      programId: "wprog_anchor",
      effectiveAt: now,
      reason: "points_expiry_anchor_initialized",
    });
  });

  it("does not send immediate reminders when a newly enabled window is shorter than its thresholds", async () => {
    const enabledAt = new Date("2026-09-01T00:00:00.000Z");
    const expiryAt = new Date("2026-09-04T00:00:00.000Z");
    const tx = {
      weleticLoyaltyProgram: {
        findUnique: vi.fn().mockResolvedValue({
          ...policy,
          id: "wprog_short_window",
          pointsExpiryDays: 3,
          pointsExpiryMonths: 0,
          pointsExpiryPolicyAnchorAt: enabledAt,
        }),
      },
      weleticLoyaltyAccount: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: "wlacc_short_window",
              cachedPointsBalance: BigInt(500),
              lastQualifyingActivityAt: null,
              nextExpiryDate: expiryAt,
            },
          ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    vi.mocked(prisma.weleticLoyaltyProgram.findMany).mockResolvedValue([
      { storeId: "wstore_expiry" },
    ] as any);
    vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
      async ({ operation }: any) => operation(tx),
    );
    vi.mocked(enqueueOutboxJobFromProgramTransaction).mockResolvedValue({
      id: "woutbox_short_window",
    } as any);

    const result = await enqueuePointsExpiryLifecycleJobs({
      now: enabledAt,
      batchSize: 10,
    });

    expect(result.jobsEnqueued).toBe(1);
    expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ stage: "expire" }),
        scheduledFor: expiryAt,
      }),
    );
  });

  it("retries serializable conflicts without double-counting rolled-back work", async () => {
    const expiryAt = new Date("2026-09-30T00:00:00.000Z");
    const tx = {
      weleticLoyaltyProgram: {
        findUnique: vi.fn().mockResolvedValue({
          ...policy,
          id: "wprog_retry",
          pointsExpiryPolicyAnchorAt: new Date("2026-08-30T00:00:00.000Z"),
        }),
      },
      weleticLoyaltyAccount: {
        findMany: vi.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.pointsExpiryPolicyVersion?.not !== undefined
              ? []
              : [
                  {
                    id: "wlacc_retry",
                    cachedPointsBalance: BigInt(500),
                    lastQualifyingActivityAt: new Date(
                      "2026-08-30T00:00:00.000Z",
                    ),
                    nextExpiryDate: expiryAt,
                  },
                ],
          ),
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    vi.mocked(prisma.weleticLoyaltyProgram.findMany).mockResolvedValue([
      { storeId: "wstore_expiry" },
    ] as any);
    const conflict = new Prisma.PrismaClientKnownRequestError(
      "Transaction write conflict",
      { code: "P2034", clientVersion: "test" },
    );
    let attempt = 0;
    vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
      async ({ operation }: any) => {
        attempt++;
        const value = await operation(tx);
        if (attempt === 1) throw conflict;
        return value;
      },
    );
    vi.mocked(enqueueOutboxJobFromProgramTransaction).mockResolvedValue({
      id: "woutbox_retry",
    } as any);

    const result = await enqueuePointsExpiryLifecycleJobs({
      now: new Date("2026-09-01T00:00:00.000Z"),
      batchSize: 10,
    });

    expect(withActiveStoreLoyaltyMutation).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      programsScanned: 1,
      programsSkipped: 0,
      accountsScheduled: 1,
      jobsEnqueued: 5,
    });
  });

  it.each([
    ["en", "500 Points expire on September 30, 2026"],
    ["ja-JP", "500 Pointsの有効期限は2026年9月30日です"],
    ["vi-VN", "500 Points sẽ hết hạn vào 30 tháng 9, 2026"],
    ["fr-FR", "500 Points expire on September 30, 2026"],
    ["not a locale", "500 Points expire on September 30, 2026"],
  ])(
    "sends a consent-gated, idempotent %s reminder and rejects stale dates",
    async (locale, subject) => {
      const expiryAt = "2026-09-30T00:00:00.000Z";
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: "wlacc_expiry",
        cachedPointsBalance: BigInt(500),
        nextExpiryDate: new Date(expiryAt),
        pointsExpiryPolicyVersion: 2,
        shopper: {
          email: "member@example.com",
          firstName: "Mai",
          locale,
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...policy,
          name: "Yamax Points",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamax.myshopify.com" },
      } as any);

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_expiry",
        payload: {
          accountId: "wlacc_expiry",
          lastActivityAt: "2026-08-30T00:00:00.000Z",
          expiryMonths: 1,
          expiryAt,
          stage: "warning",
          policyVersion: 2,
        },
        now: new Date("2026-09-01T00:00:00.000Z"),
      });

      expect(outcome).toBe("sent");
      expect(sendBatchEmail).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            to: "member@example.com",
            subject,
            variant: "marketing",
            unsubscribeUrl: "https://yamax.myshopify.com/account/profile",
          }),
        ],
        {
          idempotencyKey:
            "loyalty-expiry-warning-wlacc_expiry-2026-09-30T00:00:00.000Z",
        },
      );

      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "wlacc_opted_out",
        cachedPointsBalance: BigInt(500),
        nextExpiryDate: new Date(expiryAt),
        pointsExpiryPolicyVersion: 2,
        shopper: {
          email: "opted-out@example.com",
          acceptsMarketing: false,
          ordersCount: 1,
        },
        program: {
          ...policy,
          name: "Yamax Points",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamax.myshopify.com" },
      } as any);
      expect(
        await sendPointsExpiryNotification({
          storeId: "wstore_expiry",
          payload: {
            accountId: "wlacc_opted_out",
            lastActivityAt: "2026-08-30T00:00:00.000Z",
            expiryMonths: 1,
            expiryAt,
            stage: "warning",
            policyVersion: 2,
          },
          now: new Date("2026-09-01T00:00:00.000Z"),
        }),
      ).toBe("ineligible");
      expect(sendBatchEmail).toHaveBeenCalledTimes(1);

      expect(pointsExpiryDatesMatch(expiryAt, "2026-10-01T00:00:00.000Z")).toBe(
        false,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "wlacc_expiry",
        cachedPointsBalance: BigInt(500),
        nextExpiryDate: new Date("2026-10-01T00:00:00.000Z"),
        pointsExpiryPolicyVersion: 2,
        shopper: {
          email: "member@example.com",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...policy,
          name: "Yamax Points",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamax.myshopify.com" },
      } as any);
      expect(
        await sendPointsExpiryNotification({
          storeId: "wstore_expiry",
          payload: {
            accountId: "wlacc_expiry",
            lastActivityAt: "2026-08-30T00:00:00.000Z",
            expiryMonths: 1,
            expiryAt,
            stage: "warning",
            policyVersion: 2,
          },
        }),
      ).toBe("stale");
    },
  );

  it("keeps the outbox retryable when no email provider accepts the reminder", async () => {
    const expiryAt = "2026-09-30T00:00:00.000Z";
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
      id: "wlacc_expiry",
      cachedPointsBalance: BigInt(500),
      nextExpiryDate: new Date(expiryAt),
      pointsExpiryPolicyVersion: 2,
      shopper: {
        email: "member@example.com",
        firstName: "Mai",
        locale: "en",
        acceptsMarketing: true,
        ordersCount: 1,
      },
      program: {
        ...policy,
        name: "Yamax Points",
        pointNamePlural: "Points",
      },
      store: { shopDomain: "yamax.myshopify.com" },
    } as any);
    vi.mocked(sendBatchEmail).mockResolvedValue({
      data: null,
      error: null,
    } as any);

    await expect(
      sendPointsExpiryNotification({
        storeId: "wstore_expiry",
        payload: {
          accountId: "wlacc_expiry",
          lastActivityAt: "2026-08-30T00:00:00.000Z",
          expiryMonths: 1,
          expiryAt,
          stage: "warning",
          policyVersion: 2,
        },
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("email provider unavailable");
  });
});
