import { PrismaClient, WeleticPointsLedgerEntryType } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = new PrismaClient();
const transport = vi.hoisted(() => ({
  create: vi.fn(),
  lookup: vi.fn(),
  deactivate: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: ({
    fn,
  }: {
    fn: () => Promise<unknown>;
  }) => fn(),
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >()),
  provisionLoyaltyRewardDiscount: transport.create,
  lookupDiscountByCode: transport.lookup,
  deactivateDiscount: transport.deactivate,
  resolveShopifyOfflineCredentials: transport.credentials,
}));

const suffix = randomBytes(6).toString("hex");
const id = `reward_lifecycle_${suffix}`;
const workspaceId = `ws_${id}`;
const affiliateProgramId = `program_${id}`;
const storeId = `store_${id}`;
const loyaltyProgramId = `loyalty_${id}`;
const shopperId = `shopper_${id}`;
const accountId = `account_${id}`;
let verified = false;

function requireDisposableTarget() {
  const url = new URL(process.env.DATABASE_URL ?? "invalid:");
  const match = /^\/weletic_loyalty_it_reward_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_REWARD_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    !match ||
    url.username !== `wr_${match[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  ) {
    throw new Error("Refusing non-isolated reward lifecycle database");
  }
  return {
    databaseName: url.pathname.slice(1),
    principal: `${url.username}@%`,
  };
}

const variants = [
  {
    label: "fixed amount",
    rewardType: "amount_off",
    exchangeType: "fixed",
    discountValue: 5,
  },
  {
    label: "incremental amount",
    rewardType: "amount_off",
    exchangeType: "incremental",
    discountValue: 2,
    pointsStep: BigInt(100),
    minPointsCost: BigInt(100),
    maxPointsCost: BigInt(500),
  },
  {
    label: "percentage",
    rewardType: "percentage_off",
    exchangeType: "fixed",
    discountValue: 10,
  },
  {
    label: "shipping",
    rewardType: "free_shipping",
    exchangeType: "fixed",
    discountValue: null,
  },
  {
    label: "product",
    rewardType: "free_product",
    exchangeType: "fixed",
    discountValue: 100,
    entitledProductIds: ["gid://shopify/Product/1234"],
  },
] as const;

async function sumPersistedLedgerPoints() {
  const [result] = await database.$queryRaw<
    Array<{ balance: string }>
  >`SELECT CAST(COALESCE(SUM(\`pointsDelta\`), 0) AS CHAR) AS balance FROM \`WeleticPointsLedgerEntry\` WHERE \`storeId\` = ${storeId} AND \`accountId\` = ${accountId}`;
  return BigInt(result.balance);
}

describe("loyalty reward lifecycle on isolated MySQL", () => {
  beforeAll(async () => {
    const target = requireDisposableTarget();
    expect(
      await database.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
    ).toEqual([target]);
    expect(await database.weleticShopifyStore.count()).toBe(0);
    verified = true;
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `reward-test:${randomBytes(32).toString("base64")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External network forbidden in reward SQL test");
      }),
    );
    await database.project.create({
      data: {
        id: workspaceId,
        name: id,
        slug: workspaceId,
        billingCycleStart: 1,
      },
    });
    await database.program.create({
      data: {
        id: affiliateProgramId,
        workspaceId,
        defaultFolderId: `folder_${id}`,
        defaultGroupId: `group_${id}`,
        name: id,
        slug: affiliateProgramId,
      },
    });
    await database.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: workspaceId,
        programId: affiliateProgramId,
        shopDomain: `${suffix}.myshopify.com`,
        storeAccessState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-09-24T00:00:00Z"),
        apiVersion: "2026-07",
      },
    });
    await database.weleticLoyaltyProgram.create({
      data: { id: loyaltyProgramId, storeId, status: "active" },
    });
    await database.weleticShopper.create({
      data: {
        id: shopperId,
        storeId,
        shopifyCustomerId: `gid://shopify/Customer/${suffix}`,
      },
    });
    await database.weleticLoyaltyAccount.create({
      data: { id: accountId, storeId, programId: loyaltyProgramId, shopperId },
    });
    const { appendPointsLedgerEntry } = await import(
      "@/lib/weletic/loyalty/ledger"
    );
    await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      pointsDelta: BigInt(2_000),
      idempotencyKey: `opening:${id}`,
    });
  });

  afterAll(async () => {
    if (verified) {
      await database.weleticLoyaltyOutboxJob.deleteMany({ where: { storeId } });
      await database.weleticRewardRedemption.deleteMany({ where: { storeId } });
      await database.weleticRewardDefinition.deleteMany({ where: { storeId } });
      await database.weleticPointsLedgerEntry.deleteMany({
        where: { storeId },
      });
      await database.weleticLoyaltyAccount.deleteMany({ where: { storeId } });
      await database.weleticShopper.deleteMany({ where: { storeId } });
      await database.weleticLoyaltyProgram.deleteMany({ where: { storeId } });
      await database.weleticShopifyStore.deleteMany({ where: { id: storeId } });
      await database.$executeRaw`DELETE FROM \`Program\` WHERE \`id\` = ${affiliateProgramId}`;
      await database.$executeRaw`DELETE FROM \`Project\` WHERE \`id\` = ${workspaceId}`;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await database.$disconnect();
  });

  it("reconciles native issuance, replay, uncertain responses and terminal compensation", async () => {
    const { provisionDiscountSaga, compensateDiscountSaga } = await import(
      "@/lib/weletic/loyalty/saga"
    );
    const { ShopifyDiscountError } = await import(
      "@/lib/weletic/loyalty/shopify-discounts"
    );
    transport.create.mockReset();
    transport.lookup.mockReset();
    transport.deactivate.mockReset();
    transport.credentials.mockReset();
    transport.lookup.mockResolvedValue(null);
    transport.deactivate.mockResolvedValue(true);
    transport.credentials.mockResolvedValue({
      shopDomain: `${suffix}.myshopify.com`,
      accessToken: "test-only-token",
      source: "app_session",
    });
    transport.create.mockImplementation(
      async ({
        discountCode,
        rewardDefinition,
      }: {
        discountCode: string;
        rewardDefinition: { discountValue: number | string | null };
      }) => {
        if (discountCode.endsWith("-1")) {
          expect(String(rewardDefinition.discountValue)).toBe("6");
        }
        return {
          id: `gid://shopify/DiscountCodeNode/${discountCode}`,
          code: discountCode,
          title: "Isolated reward",
          status: "ACTIVE",
        };
      },
    );
    const results: Array<{ redemptionId: string; rewardType: string }> = [];
    for (const [index, variant] of variants.entries()) {
      const rewardDefinitionId = `reward_${suffix}_${index}`;
      await database.weleticRewardDefinition.create({
        data: {
          id: rewardDefinitionId,
          storeId,
          name: variant.label,
          rewardType: variant.rewardType,
          exchangeType: variant.exchangeType,
          pointsCost: BigInt(100),
          discountValue: variant.discountValue,
          ...(variant.exchangeType === "incremental"
            ? {
                pointsStep: variant.pointsStep,
                minPointsCost: variant.minPointsCost,
                maxPointsCost: variant.maxPointsCost,
              }
            : {}),
          ...(variant.rewardType === "free_product"
            ? { entitledProductIds: [...variant.entitledProductIds] }
            : {}),
        },
      });
      const request = {
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: `reward-${suffix}-${index}`,
        discountCode: `WL-${suffix}-${index}`,
        shopDomain: `${suffix}.myshopify.com`,
        accessToken: "test-only-token",
        ...(index === 0 ? { expiresAt: new Date(Date.now() + 60_000) } : {}),
        ...(variant.exchangeType === "incremental"
          ? { pointsCostOverride: BigInt(300), discountValueOverride: 6 }
          : {}),
      };
      const issued = await provisionDiscountSaga(request);
      expect(issued.success).toBe(true);
      expect(issued.status).toBe("issued");
      expect(issued.pointsSpent).toBe(
        variant.exchangeType === "incremental" ? BigInt(300) : BigInt(100),
      );
      const replay = await provisionDiscountSaga(request);
      expect(replay.redemptionId).toBe(issued.redemptionId);
      results.push({
        redemptionId: issued.redemptionId,
        rewardType: variant.rewardType,
      });
    }

    expect(transport.create).toHaveBeenCalledTimes(variants.length);
    expect(
      await database.weleticRewardRedemption.count({ where: { storeId } }),
    ).toBe(variants.length);
    const rows = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId, accountId },
      orderBy: { sequenceNumber: "asc" },
    });
    const debits = rows.filter((row) => row.entryType === "REDEEM_REWARD");
    expect(debits).toHaveLength(variants.length);
    const ledgerBalance = await sumPersistedLedgerPoints();
    const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(account.cachedPointsBalance).toBe(ledgerBalance);
    expect(account.cachedPointsBalance).toBe(BigInt(1_300));
    expect(rows.map((row) => row.balanceAfter).at(-1)).toBe(ledgerBalance);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId, jobType: "REDEMPTION_RECOVERY" },
      }),
    ).toBe(variants.length + 1);
    for (const { redemptionId, rewardType } of results) {
      const row = await database.weleticRewardRedemption.findUniqueOrThrow({
        where: { id: redemptionId },
      });
      expect(row.status).toBe("issued");
      expect(
        (row.metadata as { provisioningSnapshot: { rewardType: string } })
          .provisioningSnapshot.rewardType,
      ).toBe(rewardType);
    }

    const openingBalance = (
      await database.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
      })
    ).cachedPointsBalance;
    for (const outcome of ["uncertain", "terminal"] as const) {
      const rewardDefinitionId = `reward_${suffix}_${outcome}`;
      await database.weleticRewardDefinition.create({
        data: {
          id: rewardDefinitionId,
          storeId,
          name: outcome,
          rewardType: "amount_off",
          exchangeType: "fixed",
          pointsCost: BigInt(100),
          discountValue: 5,
        },
      });
      transport.create.mockReset();
      transport.create.mockRejectedValueOnce(
        outcome === "uncertain"
          ? new Error("connection closed after request")
          : new ShopifyDiscountError("INVALID_REQUEST", "Rejected by Shopify"),
      );
      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: `reward-${suffix}-${outcome}`,
        discountCode: `WL-${suffix}-${outcome}`,
        shopDomain: `${suffix}.myshopify.com`,
        accessToken: "test-only-token",
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe(
        outcome === "uncertain" ? "provisioning" : "failed",
      );
      expect(result.compensated).toBe(outcome === "terminal");
      const redemption =
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: result.redemptionId },
        });
      expect(redemption.status).toBe(result.status);
      const entries = await database.weleticPointsLedgerEntry.findMany({
        where: { storeId, accountId, referenceId: result.redemptionId },
      });
      expect(
        entries.filter((row) => row.entryType === "REDEEM_REWARD"),
      ).toHaveLength(1);
      expect(
        entries.filter((row) => row.referenceType === "REDEMPTION_REFUND"),
      ).toHaveLength(outcome === "terminal" ? 1 : 0);
      if (outcome === "terminal") {
        await compensateDiscountSaga({
          redemptionId: result.redemptionId,
          reason: "idempotent repeat",
        });
        expect(
          await database.weleticPointsLedgerEntry.count({
            where: {
              storeId,
              accountId,
              referenceId: result.redemptionId,
              referenceType: "REDEMPTION_REFUND",
            },
          }),
        ).toBe(1);
      }
    }
    const independentlyReconciledBalance = await sumPersistedLedgerPoints();
    expect(independentlyReconciledBalance).toBe(openingBalance - BigInt(100));
    expect(
      (
        await database.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: accountId },
        })
      ).cachedPointsBalance,
    ).toBe(independentlyReconciledBalance);

    const expiringRedemption =
      await database.weleticRewardRedemption.findUniqueOrThrow({
        where: { id: results[0].redemptionId },
      });
    const expiryJob = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: {
        storeId,
        idempotencyKey: `redemption_expiry:${expiringRedemption.id}`,
      },
    });
    const { RedemptionRecoveryPayloadSchema } = await import(
      "@/lib/weletic/loyalty/outbox"
    );
    const { handleRedemptionRecovery } = await import(
      "@/lib/weletic/loyalty/outbox-worker"
    );
    const expiryPayload = RedemptionRecoveryPayloadSchema.parse(
      expiryJob.payload,
    );
    const remote = {
      id: expiringRedemption.shopifyDiscountId,
      code: expiringRedemption.shopifyDiscountCode,
      title: (
        expiringRedemption.metadata as {
          shopifyDiscountOwnership: { expectedTitle: string };
        }
      ).shopifyDiscountOwnership.expectedTitle,
      status: "ACTIVE",
    };
    transport.lookup.mockResolvedValueOnce({
      ...remote,
      title: "Foreign voucher",
    });
    transport.deactivate.mockReset();
    transport.deactivate.mockResolvedValueOnce(false).mockResolvedValue(true);
    const expiryNow = new Date(expiringRedemption.expiresAt!.getTime() + 1_000);
    const balanceBeforeExpiry = await sumPersistedLedgerPoints();
    await expect(
      handleRedemptionRecovery(storeId, expiryPayload, undefined, expiryNow),
    ).rejects.toThrow("Shopify discount ownership mismatch");
    expect(transport.deactivate).not.toHaveBeenCalled();
    expect(await sumPersistedLedgerPoints()).toBe(balanceBeforeExpiry);
    transport.lookup.mockResolvedValue(remote);
    await expect(
      handleRedemptionRecovery(storeId, expiryPayload, undefined, expiryNow),
    ).rejects.toThrow("did not confirm expired discount deactivation");
    expect(transport.deactivate).toHaveBeenCalledWith(
      `${suffix}.myshopify.com`,
      "test-only-token",
      remote.id,
    );
    expect(
      (
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: expiringRedemption.id },
        })
      ).status,
    ).toBe("issued");
    expect(await sumPersistedLedgerPoints()).toBe(balanceBeforeExpiry);
    await handleRedemptionRecovery(
      storeId,
      expiryPayload,
      undefined,
      expiryNow,
    );
    expect(
      (
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: expiringRedemption.id },
        })
      ).status,
    ).toBe("expired");
    await handleRedemptionRecovery(
      storeId,
      expiryPayload,
      undefined,
      expiryNow,
    );
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          accountId,
          referenceId: expiringRedemption.id,
          referenceType: "REDEMPTION_REFUND",
        },
      }),
    ).toBe(1);
    expect(await sumPersistedLedgerPoints()).toBe(
      balanceBeforeExpiry + BigInt(100),
    );

    const { settleRewardRedemptionsUsedByOrder } = await import(
      "@/lib/weletic/loyalty/redemption-settlement"
    );
    const balanceBeforeUse = await sumPersistedLedgerPoints();
    for (const [index, { redemptionId }] of results.entries()) {
      const redemption =
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: redemptionId },
        });
      const orderId = `gid://shopify/Order/${1000 + index}`;
      const request = {
        storeId,
        discountCodes: [redemption.shopifyDiscountCode],
        orderId,
        shopifyCustomerId: `gid://shopify/Customer/${suffix}`,
        usedAt: new Date("2026-09-24T12:00:00Z"),
      };
      expect(await settleRewardRedemptionsUsedByOrder(request)).toEqual({
        matched: 1,
        markedUsed: 1,
        lateUseCorrections: index === 0 ? 1 : 0,
      });
      expect(
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: redemptionId },
          select: { status: true, orderId: true },
        }),
      ).toMatchObject({ status: "used", orderId });
      expect(await settleRewardRedemptionsUsedByOrder(request)).toEqual({
        matched: 0,
        markedUsed: 0,
        lateUseCorrections: 0,
      });
      expect(await sumPersistedLedgerPoints()).toBe(
        balanceBeforeUse - BigInt(100),
      );
    }
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          accountId,
          referenceType: "REDEMPTION_LATE_USE",
          referenceId: expiringRedemption.id,
        },
      }),
    ).toBe(1);
    expect(await sumPersistedLedgerPoints()).toBe(
      balanceBeforeUse - BigInt(100),
    );
    expect(
      (
        await database.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: accountId },
        })
      ).cachedPointsBalance,
    ).toBe(await sumPersistedLedgerPoints());
  }, 120_000);
});
