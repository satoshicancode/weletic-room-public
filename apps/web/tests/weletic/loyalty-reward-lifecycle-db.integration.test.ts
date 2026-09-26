import { PrismaClient, WeleticPointsLedgerEntryType } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const database = new PrismaClient();
const transport = vi.hoisted(() => ({
  create: vi.fn(),
  lookup: vi.fn(),
  deactivate: vi.fn(),
  credentials: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: ({ fn }: { fn: () => Promise<unknown> }) => fn(),
}));
vi.mock(
  "@/lib/weletic/shopify/customer-settlement-lock",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/shopify/customer-settlement-lock")
    >()),
    withShopifyCustomerSettlementLocks: ({
      fn,
    }: {
      fn: () => Promise<unknown>;
    }) => fn(),
  }),
);
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
const coreLaunch = process.env.WELETIC_FEATURE_PROFILE === "core-v1";
const appId = `reward_app_${suffix}`;
const pendingId = `reward_pending_${suffix}`;
const generation = `reward_generation_${suffix}`;
const subscriptionId = createHash("sha256")
  .update(JSON.stringify([appId, pendingId, generation]))
  .digest("hex");

function requireDisposableTarget() {
  const url = new URL(process.env.DATABASE_URL ?? "invalid:");
  const match = /^\/weletic_loyalty_it_reward_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_REWARD_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== (process.env.LOYALTY_REWARD_DATABASE_PORT || "3309") ||
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
const enabledVariants = coreLaunch ? [variants[0]] : variants;

async function expireFixtureSubscription() {
  if (!coreLaunch) return;
  await database.weleticShopifySubscriptionSnapshot.update({
    where: { id: subscriptionId },
    data: { validUntil: new Date(0) },
  });
  const { assertStoreSubscriptionForNewBenefit } = await import(
    "@/lib/weletic/shopify/app-pricing-service"
  );
  await expect(
    database.$transaction((tx) =>
      assertStoreSubscriptionForNewBenefit(tx, storeId),
    ),
  ).rejects.toThrow("subscription verification");
}

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
    expect(await database.weleticFxRateSnapshot.count()).toBe(0);
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
        installationGeneration: generation,
      },
    });
    if (coreLaunch) {
      // Synthetic authority only in the guarded disposable SQL database.
      // Production subscription checks stay active throughout the suite.
      vi.stubEnv("SHOPIFY_API_KEY", appId);
      vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/1");
      await database.weleticShopifyPendingInstallation.create({
        data: {
          id: pendingId,
          appId,
          identityKeyId: "synthetic-reward-fixture",
          shopDomainDigest: createHash("sha256").update(id).digest("hex"),
          installationGeneration: generation,
          state: "mapped",
          mappedStoreId: storeId,
          authenticatedAt: new Date(),
        },
      });
    }
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

  beforeEach(async () => {
    if (!coreLaunch) return;
    const [clock] = await database.$queryRaw<Array<{ now: Date }>>`
      SELECT CURRENT_TIMESTAMP(3) AS now
    `;
    await database.weleticShopifySubscriptionSnapshot.upsert({
      where: { id: subscriptionId },
      create: {
        id: subscriptionId,
        appId,
        partnerAppId: "gid://shopify/App/1",
        pendingInstallationId: pendingId,
        installationGeneration: generation,
        shopId: "gid://shopify/Shop/2",
        status: "private_free",
        planHandle: "company-free",
        verifiedAt: clock.now,
        validUntil: new Date(clock.now.getTime() + 300_000),
      },
      update: {
        verifiedAt: clock.now,
        validUntil: new Date(clock.now.getTime() + 300_000),
      },
    });
  });

  afterAll(async () => {
    if (verified) {
      await database.weleticShopifySubscriptionSnapshot.deleteMany({
        where: { id: subscriptionId },
      });
      await database.weleticShopifyPendingInstallation.deleteMany({
        where: { id: pendingId },
      });
      await database.weleticLoyaltyOutboxJob.deleteMany({ where: { storeId } });
      await database.weleticRewardRedemption.deleteMany({ where: { storeId } });
      await database.weleticRewardDefinition.deleteMany({ where: { storeId } });
      await database.weleticPointsLedgerEntry.deleteMany({
        where: { storeId },
      });
      await database.weleticCommerceOrder.deleteMany({ where: { storeId } });
      await database.weleticFxRateSnapshot.deleteMany({
        where: { provider: "order-snapshot:gid://shopify/Order/2001" },
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
    for (const [index, variant] of enabledVariants.entries()) {
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

    expect(transport.create).toHaveBeenCalledTimes(enabledVariants.length);
    expect(
      await database.weleticRewardRedemption.count({ where: { storeId } }),
    ).toBe(enabledVariants.length);
    const rows = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId, accountId },
      orderBy: { sequenceNumber: "asc" },
    });
    const debits = rows.filter((row) => row.entryType === "REDEEM_REWARD");
    expect(debits).toHaveLength(enabledVariants.length);
    const ledgerBalance = await sumPersistedLedgerPoints();
    const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(account.cachedPointsBalance).toBe(ledgerBalance);
    expect(account.cachedPointsBalance).toBe(
      BigInt(coreLaunch ? 1_900 : 1_300),
    );
    expect(rows.map((row) => row.balanceAfter).at(-1)).toBe(ledgerBalance);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId, jobType: "REDEMPTION_RECOVERY" },
      }),
    ).toBe(enabledVariants.length + 1);
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

    await expireFixtureSubscription();
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

  it("claws back order earnings after coupon use without recrediting the reward", async () => {
    const { appendPointsLedgerEntry } = await import(
      "@/lib/weletic/loyalty/ledger"
    );
    const { provisionDiscountSaga } = await import(
      "@/lib/weletic/loyalty/saga"
    );
    const { settleRewardRedemptionsUsedByOrder } = await import(
      "@/lib/weletic/loyalty/redemption-settlement"
    );
    const { recordWeleticRefund } = await import(
      "@/lib/weletic/commerce/record-refund"
    );
    const orderId = "gid://shopify/Order/2001";
    const orderLineId = `refund_line_${suffix}`;
    const grantId = `refund_grant_${suffix}`;
    const rewardDefinitionId = `refund_reward_${suffix}`;
    const discountCode = `WL-${suffix.toUpperCase()}-REFUND`;
    transport.create
      .mockReset()
      .mockImplementation(
        async ({
          discountCode: requestedCode,
          rewardDefinition,
        }: {
          discountCode: string;
          rewardDefinition: { discountValue: number | string | null };
        }) => {
          expect(requestedCode).toBe(discountCode);
          expect(String(rewardDefinition.discountValue)).toMatch(
            /^1(?:\.0+)?$/,
          );
          return {
            id: `gid://shopify/DiscountCodeNode/${suffix}-refund`,
            code: discountCode,
            title: "Isolated refund reward",
            status: "ACTIVE",
          };
        },
      );
    transport.lookup.mockReset().mockResolvedValue(null);
    transport.credentials.mockReset().mockResolvedValue({
      shopDomain: `${suffix}.myshopify.com`,
      accessToken: "test-only-token",
      source: "app_session",
    });
    await database.weleticRewardDefinition.create({
      data: {
        id: rewardDefinitionId,
        storeId,
        name: "Refund order amount off",
        rewardType: "amount_off",
        exchangeType: "fixed",
        pointsCost: BigInt(100),
        discountValue: 1,
      },
    });
    const issued = await provisionDiscountSaga({
      storeId,
      accountId,
      rewardDefinitionId,
      idempotencyKey: `reward-${suffix}-refund`,
      discountCode,
      shopDomain: `${suffix}.myshopify.com`,
      accessToken: "test-only-token",
    });
    expect(issued).toEqual(
      expect.objectContaining({ success: true, status: "issued" }),
    );

    await database.weleticCommerceOrder.create({
      data: {
        id: orderId,
        storeId,
        programId: affiliateProgramId,
        shopperId,
        externalId: "2001",
        presentmentCurrency: "USD",
        presentmentSubtotal: BigInt(1_000),
        presentmentDiscount: BigInt(100),
        presentmentNet: BigInt(900),
        presentmentTotal: BigInt(900),
        shopCurrency: "USD",
        shopSubtotal: BigInt(1_000),
        shopDiscount: BigInt(100),
        shopNet: BigInt(900),
        shopTotal: BigInt(900),
        accountingCurrency: "USD",
        accountingNet: BigInt(900),
        accountingTotal: BigInt(900),
        accountingFxRate: "1.0",
        occurredAt: new Date("2026-09-24T12:00:00Z"),
      },
    });
    await database.weleticCommerceOrderLine.create({
      data: {
        id: orderLineId,
        orderId,
        externalId: "20011",
        title: "Two-unit reward order",
        quantity: 2,
        presentmentGross: BigInt(1_000),
        presentmentDiscount: BigInt(100),
        presentmentNet: BigInt(900),
        shopGross: BigInt(1_000),
        shopDiscount: BigInt(100),
        shopNet: BigInt(900),
        accountingNet: BigInt(900),
        commissionableAccountingAmount: BigInt(900),
      },
    });
    expect(
      await settleRewardRedemptionsUsedByOrder({
        storeId,
        discountCodes: [discountCode],
        orderId,
        shopifyCustomerId: `gid://shopify/Customer/${suffix}`,
        usedAt: new Date("2026-09-24T12:00:00Z"),
      }),
    ).toMatchObject({ markedUsed: 1 });
    const redemption = await database.weleticRewardRedemption.findUniqueOrThrow(
      { where: { id: issued.redemptionId } },
    );
    expect(redemption.status).toBe("used");
    expect(redemption.orderId).toBe(orderId);
    const balanceBeforeEarn = await sumPersistedLedgerPoints();
    await database.weleticLoyaltyEarnGrant.create({
      data: {
        id: grantId,
        storeId,
        programId: loyaltyProgramId,
        accountId,
        shopperId,
        orderId,
        status: "settled",
        currency: "USD",
        eligibleSubtotalAmount: BigInt(900),
        orderTotalAmount: BigInt(900),
        grossPoints: BigInt(180),
        settledPoints: BigInt(180),
        availableAt: new Date("2026-09-24T12:00:00Z"),
        settledAt: new Date("2026-09-24T12:00:00Z"),
        pointsPerCurrencyUnit: "20.0",
        effectiveMultiplier: "1.0",
      },
    });
    await database.weleticLoyaltyOrderLineEarn.create({
      data: {
        id: `refund_line_earn_${suffix}`,
        grantId,
        orderLineId,
        storeId,
        quantity: 2,
        lineNetAmount: BigInt(900),
        awardedPoints: BigInt(180),
      },
    });
    await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      pointsDelta: BigInt(180),
      grantId,
      idempotencyKey: `refund_order_earn:${suffix}`,
    });
    expect(await sumPersistedLedgerPoints()).toBe(
      balanceBeforeEarn + BigInt(180),
    );

    await expireFixtureSubscription();
    for (const [index, expectedReversed] of [90, 180].entries()) {
      const event = {
        id: 3001 + index,
        order_id: 2001,
        created_at: `2026-09-25T0${index}:00:00Z`,
        refund_line_items: [
          {
            id: 4001 + index,
            line_item_id: 20011,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: "4.50", currency_code: "USD" },
            },
          },
        ],
      };
      const first = await recordWeleticRefund({
        event,
        workspaceId,
      });
      expect(first.duplicate).toBe(false);
      if (!first.loyaltyLedgerEntryId)
        throw new Error("Refund ingestion did not post an earn reversal");
      expect(
        await database.weleticPointsLedgerEntry.findUniqueOrThrow({
          where: { id: first.loyaltyLedgerEntryId },
          select: { entryType: true, pointsDelta: true },
        }),
      ).toEqual({ entryType: "REFUND_REVERSAL", pointsDelta: BigInt(-90) });
      const replay = await recordWeleticRefund({ event, workspaceId });
      expect(replay.duplicate).toBe(true);
      expect(replay.loyaltyLedgerEntryId).toBe(first.loyaltyLedgerEntryId);
      expect(
        await database.weleticCommerceRefund.findUniqueOrThrow({
          where: { id: first.refundId },
          select: {
            storeId: true,
            orderId: true,
            externalId: true,
            presentmentAmount: true,
            shopAmount: true,
            accountingAmount: true,
            lines: {
              select: {
                orderLineId: true,
                quantity: true,
                presentmentAmount: true,
                shopAmount: true,
                accountingAmount: true,
              },
            },
          },
        }),
      ).toEqual({
        storeId,
        orderId,
        externalId: String(event.id),
        presentmentAmount: BigInt(450),
        shopAmount: BigInt(450),
        accountingAmount: BigInt(450),
        lines: [
          {
            orderLineId,
            quantity: 1,
            presentmentAmount: BigInt(450),
            shopAmount: BigInt(450),
            accountingAmount: BigInt(450),
          },
        ],
      });
      expect(
        await database.weleticCommerceRefund.aggregate({
          where: { storeId, orderId },
          _count: { _all: true },
          _sum: { accountingAmount: true },
        }),
      ).toEqual({
        _count: { _all: index + 1 },
        _sum: { accountingAmount: BigInt((index + 1) * 450) },
      });
      expect(
        await database.weleticCommerceOrder.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        }),
      ).toEqual({ status: index === 0 ? "partially_refunded" : "refunded" });
      expect(
        await database.weleticLoyaltyEarnGrant.findUniqueOrThrow({
          where: { id: grantId },
          select: { reversedPoints: true },
        }),
      ).toEqual({ reversedPoints: BigInt(expectedReversed) });
      expect(await sumPersistedLedgerPoints()).toBe(
        balanceBeforeEarn + BigInt(180 - expectedReversed),
      );
      expect(
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: redemption.id },
          select: { status: true, orderId: true },
        }),
      ).toEqual({ status: "used", orderId });
    }

    expect(
      await database.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          accountId,
          grantId,
          entryType: "REFUND_REVERSAL",
        },
      }),
    ).toBe(2);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          accountId,
          referenceId: redemption.id,
          referenceType: "REDEMPTION_REFUND",
        },
      }),
    ).toBe(0);
    expect(
      (
        await database.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: accountId },
          select: { cachedPointsBalance: true },
        })
      ).cachedPointsBalance,
    ).toBe(await sumPersistedLedgerPoints());
  }, 120_000);

  it.runIf(coreLaunch).each(["unchanged", "changed"] as const)(
    "reconciles an uncertain coupon after billing expiry with %s currency verification",
    async (currencyVerification) => {
      const { provisionDiscountSaga } = await import(
        "@/lib/weletic/loyalty/saga"
      );
      const { handleRedemptionRecovery } = await import(
        "@/lib/weletic/loyalty/outbox-worker"
      );
      const { RedemptionRecoveryPayloadSchema } = await import(
        "@/lib/weletic/loyalty/outbox"
      );
      const balanceBefore = await sumPersistedLedgerPoints();
      const recoveryId = `${suffix}-${currencyVerification}`;
      const rewardDefinitionId = `uncertain_recovery_${recoveryId}`;
      await database.weleticRewardDefinition.create({
        data: {
          id: rewardDefinitionId,
          storeId,
          name: "Uncertain five-dollar coupon",
          rewardType: "amount_off",
          exchangeType: "fixed",
          pointsCost: BigInt(100),
          discountValue: 500,
        },
      });
      transport.create
        .mockReset()
        .mockRejectedValue(new Error("response lost after create"));
      transport.lookup.mockReset().mockResolvedValue(null);
      transport.deactivate.mockReset();
      transport.credentials.mockReset().mockResolvedValue({
        shopDomain: `${suffix}.myshopify.com`,
        accessToken: "test-only-token",
        source: "app_session",
      });
      const issued = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: `uncertain-recovery-${recoveryId}`,
        discountCode: `WL-${recoveryId}-RECOVERY`,
        shopDomain: `${suffix}.myshopify.com`,
        accessToken: "test-only-token",
      });
      expect(issued).toMatchObject({
        success: false,
        status: "provisioning",
        compensated: false,
      });
      const redemption =
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: issued.redemptionId },
        });
      const job = await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: {
          storeId_idempotencyKey: {
            storeId,
            idempotencyKey: `recovery:${redemption.id}`,
          },
        },
      });
      const payload = RedemptionRecoveryPayloadSchema.parse(job.payload);
      await expireFixtureSubscription();
      const assertReservation = async (status: string) => {
        expect(await sumPersistedLedgerPoints()).toBe(
          balanceBefore - BigInt(100),
        );
        expect(
          await database.weleticLoyaltyAccount.findUniqueOrThrow({
            where: { id: accountId },
            select: { cachedPointsBalance: true },
          }),
        ).toEqual({ cachedPointsBalance: balanceBefore - BigInt(100) });
        expect(
          await database.weleticRewardRedemption.findUniqueOrThrow({
            where: { id: redemption.id },
            select: { status: true },
          }),
        ).toEqual({ status });
        const entries = await database.weleticPointsLedgerEntry.findMany({
          where: { storeId, accountId, referenceId: redemption.id },
          select: { entryType: true, pointsDelta: true },
        });
        expect(entries).toEqual([
          { entryType: "REDEEM_REWARD", pointsDelta: BigInt(-100) },
        ]);
        expect(transport.create).toHaveBeenCalledTimes(1);
        expect(transport.deactivate).not.toHaveBeenCalled();
      };
      // A lookup miss cannot establish that Shopify did not create the coupon.
      await expect(
        handleRedemptionRecovery(storeId, payload, generation),
      ).rejects.toThrow("reconciliation remains pending");
      await assertReservation("provisioning");
      const metadata = redemption.metadata as {
        shopifyDiscountOwnership: { expectedTitle: string };
        provisioningSnapshot: { startsAt: string };
      };
      const remote = {
        id: `gid://shopify/DiscountCodeNode/${recoveryId}-recovered`,
        code: redemption.shopifyDiscountCode,
        title: metadata.shopifyDiscountOwnership.expectedTitle,
        status: "ACTIVE",
        configuration: {
          kind: "basic",
          // Shopify persists discount timestamps at whole-second precision.
          startsAt: new Date(
            Math.floor(
              new Date(metadata.provisioningSnapshot.startsAt).getTime() /
                1_000,
            ) * 1_000,
          ).toISOString(),
          endsAt: null,
          usageLimit: 1,
          appliesOncePerCustomer: true,
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: false,
          recurringCycleLimit: 1,
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
          customerSelection: {
            kind: "customers",
            customerIds: [`gid://shopify/Customer/${suffix}`],
          },
          minimumRequirement: null,
          basicValue: {
            kind: "amount",
            amount: "5.00",
            currencyCode: "USD",
            appliesOnEachItem: false,
          },
          basicItems: { kind: "all" },
        },
      };
      transport.lookup.mockResolvedValue({
        ...remote,
        title: "Another merchant's coupon",
      });
      await expect(
        handleRedemptionRecovery(storeId, payload, generation),
      ).rejects.toThrow("Shopify discount ownership mismatch");
      await assertReservation("provisioning");
      transport.lookup.mockResolvedValue(remote);
      if (currencyVerification === "changed") {
        // Change the SQL currency generation during the remote read: the
        // adoption transaction must compare with the original snapshot.
        transport.lookup.mockImplementationOnce(async () => {
          await database.weleticShopifyStore.update({
            where: { id: storeId },
            data: { currencyVerifiedAt: new Date("2026-09-25T00:00:00Z") },
          });
          return remote;
        });
        transport.deactivate.mockResolvedValue(true);
        expect(
          await handleRedemptionRecovery(storeId, payload, generation),
        ).toBe("deactivated");
        expect(
          await database.weleticRewardRedemption.findUniqueOrThrow({
            where: { id: redemption.id },
            select: { status: true, shopifyDiscountId: true },
          }),
        ).toEqual({ status: "failed", shopifyDiscountId: remote.id });
        expect(transport.deactivate).toHaveBeenCalledTimes(1);
        expect(transport.deactivate).toHaveBeenCalledWith(
          `${suffix}.myshopify.com`,
          "test-only-token",
          remote.id,
          undefined,
        );
        await handleRedemptionRecovery(storeId, payload, generation);
        expect(transport.deactivate).toHaveBeenCalledTimes(1);
        expect(transport.create).toHaveBeenCalledTimes(1);
        expect(
          await database.weleticPointsLedgerEntry.findMany({
            where: { storeId, accountId, referenceId: redemption.id },
            select: { entryType: true, pointsDelta: true },
            orderBy: { sequenceNumber: "asc" },
          }),
        ).toEqual([
          { entryType: "REDEEM_REWARD", pointsDelta: BigInt(-100) },
          { entryType: "MANUAL_ADJUSTMENT", pointsDelta: BigInt(100) },
        ]);
        expect(await sumPersistedLedgerPoints()).toBe(balanceBefore);
        expect(
          await database.weleticLoyaltyAccount.findUniqueOrThrow({
            where: { id: accountId },
            select: { cachedPointsBalance: true },
          }),
        ).toEqual({ cachedPointsBalance: balanceBefore });
        return;
      }
      expect(await handleRedemptionRecovery(storeId, payload, generation)).toBe(
        "healed",
      );
      await assertReservation("issued");
      expect(
        await database.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: redemption.id },
          select: { shopifyDiscountId: true },
        }),
      ).toEqual({ shopifyDiscountId: remote.id });
      const lookupsAfterRecovery = transport.lookup.mock.calls.length;
      await handleRedemptionRecovery(storeId, payload, generation);
      await assertReservation("issued");
      expect(transport.lookup).toHaveBeenCalledTimes(lookupsAfterRecovery);
    },
  );

  it("rejects a competing wallet reservation while the first remote issuance waits", async () => {
    const { provisionDiscountSaga } = await import(
      "@/lib/weletic/loyalty/saga"
    );
    const balanceBefore = await sumPersistedLedgerPoints();
    expect(balanceBefore).toBeGreaterThan(BigInt(1));
    const pointsCost = balanceBefore / BigInt(2) + BigInt(1);
    const rewardDefinitionId = `concurrent_reward_${suffix}`;
    await database.weleticRewardDefinition.create({
      data: {
        id: rewardDefinitionId,
        storeId,
        name: "Concurrent wallet reservation",
        rewardType: "amount_off",
        exchangeType: "fixed",
        pointsCost,
        discountValue: 5,
      },
    });
    let signalRemoteEntered!: () => void;
    let releaseRemote!: () => void;
    const remoteEntered = new Promise<void>((resolve) => {
      signalRemoteEntered = resolve;
    });
    const remoteHeld = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    transport.create
      .mockReset()
      .mockImplementation(
        async ({ discountCode }: { discountCode: string }) => {
          signalRemoteEntered();
          await remoteHeld;
          return {
            id: `gid://shopify/DiscountCodeNode/${discountCode}`,
            code: discountCode,
            title: "Isolated concurrent reward",
            status: "ACTIVE",
          };
        },
      );
    transport.lookup.mockReset().mockResolvedValue(null);
    transport.credentials.mockReset().mockResolvedValue({
      shopDomain: `${suffix}.myshopify.com`,
      accessToken: "test-only-token",
      source: "app_session",
    });
    const redemptionCountBefore = await database.weleticRewardRedemption.count({
      where: { storeId, accountId },
    });
    const debitCountBefore = await database.weleticPointsLedgerEntry.count({
      where: { storeId, accountId, entryType: "REDEEM_REWARD" },
    });
    const requests = [0, 1].map((index) =>
      provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: `reward-${suffix}-concurrent-${index}`,
        discountCode: `WL-${suffix}-concurrent-${index}`,
        shopDomain: `${suffix}.myshopify.com`,
        accessToken: "test-only-token",
      }),
    );
    const observed = requests.map((request) =>
      request.then(
        () => ({ kind: "fulfilled" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
    );
    const within = async <T>(pending: Promise<T>, label: string) => {
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`${label} timed out`)),
              10_000,
            );
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };
    let firstSettled!:
      | { kind: "fulfilled" }
      | { kind: "rejected"; error: unknown };
    let remoteCallsBeforeRelease = 0;
    let stageFailure: Error | null = null;
    try {
      const reachedRemote = await within(
        Promise.race([
          remoteEntered.then(() => true),
          Promise.all(observed).then(() => false),
        ]),
        "Remote reservation entry",
      );
      if (!reachedRemote) {
        throw new Error(
          "Neither competing reservation reached remote issuance",
        );
      }
      firstSettled = await within(
        Promise.race(observed),
        "Competing reservation rejection",
      );
      remoteCallsBeforeRelease = transport.create.mock.calls.length;
    } catch (error) {
      stageFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      releaseRemote();
    }
    const outcomes = await within(
      Promise.allSettled(requests),
      "Competing reservation settlement",
    );
    if (stageFailure) throw stageFailure;
    expect(firstSettled).toMatchObject({
      kind: "rejected",
      error: expect.objectContaining({
        message: expect.stringContaining("Insufficient points balance"),
      }),
    });
    expect(remoteCallsBeforeRelease).toBe(1);
    const successes = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value.success,
    );
    const failures = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringContaining("Insufficient points balance"),
      }),
    });
    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId, accountId },
      }),
    ).toBe(redemptionCountBefore + 1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId, accountId, entryType: "REDEEM_REWARD" },
      }),
    ).toBe(debitCountBefore + 1);
    const balanceAfter = await sumPersistedLedgerPoints();
    expect(balanceAfter).toBe(balanceBefore - pointsCost);
    expect(
      (
        await database.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: accountId },
          select: { cachedPointsBalance: true },
        })
      ).cachedPointsBalance,
    ).toBe(balanceAfter);
  }, 120_000);
});
