import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShopifyMerchantActorEnvelope } from "../../lib/weletic/shopify/staff-contract";

const database = new PrismaClient();
vi.mock("@/lib/prisma", () => ({ prisma: database }));
const fixtures: Array<{ id: string; shop: string; installationId: string }> =
  [];
const configurationProgramIds: string[] = [];
let safeToClean = false;
vi.mock("@/lib/weletic/shopify/privacy-identity", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/privacy-identity")
  >()),
  deriveAllShopifyShopPrivacyIdentities: ({
    shopDomain,
  }: {
    shopDomain: string;
  }) => [
    {
      identityKeyId: "staff-db-test",
      shopDomainDigest: createHash("sha256").update(shopDomain).digest("hex"),
    },
  ],
}));

describe("Shopify staff authorization with actual MySQL transactions", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.SHOPIFY_SESSION_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.username !== "loyalty_dev" ||
      url.pathname !== "/weletic_loyalty_dev"
    )
      throw new Error("Refusing non-isolated staff database");
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
    safeToClean = true;
    vi.stubEnv("SHOPIFY_API_KEY", "staff-db-test");
    vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    vi.stubEnv(
      "WELETIC_SHOPIFY_SERVICE_SECRET",
      randomBytes(32).toString("hex"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network forbidden in staff DB tests");
      }),
    );
  });

  afterAll(async () => {
    if (safeToClean) {
      const ids = fixtures.map((f) => f.id);
      const shops = fixtures.map((f) => f.shop);
      await database.weleticReviewModerationAudit.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopifyCustomerPrivacyTombstone.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticMerchantSettings.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticLoyaltyOutboxJob.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticPointsLedgerEntry.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticRewardDefinition.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticLoyaltyAccount.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticReviewSettings.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticProductReview.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticReviewRequest.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopper.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopifyProduct.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopifyMerchantAction.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopifyStaffGrant.deleteMany({
        where: { storeId: { in: ids } },
      });
      await database.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: shops } },
      });
      await database.weleticShopifySessionCoordination.deleteMany({
        where: { appId: "staff-db-test", shop: { in: shops } },
      });
      await database.installedIntegration.deleteMany({
        where: { id: { in: fixtures.map((f) => f.installationId) } },
      });
      await database.weleticShopifyStore.deleteMany({
        where: { id: { in: ids } },
      });
      // The isolated DB deliberately lacks unrelated affiliate enrollment
      // columns. Avoid Prisma's emulated cascade into that partial schema;
      // these exact synthetic program IDs have no enrollment dependants.
      for (const id of configurationProgramIds)
        await database.$executeRaw`DELETE FROM Program WHERE id = ${id}`;
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  });

  async function seed() {
    const suffix = randomUUID();
    const fixture = {
      id: `staff_${suffix}`,
      shop: `staff-${suffix}.myshopify.com`,
      installationId: `staff_install_${suffix}`,
    };
    fixtures.push(fixture);
    const { encrypt } = await import("../../lib/encryption");
    const { SHOPIFY_INTEGRATION_ID } = await import("@dub/utils");
    const projectId = `staff_project_${suffix}`;
    await database.weleticShopifyStore.create({
      data: {
        storeAccessState: "active",
        id: fixture.id,
        projectId,
        programId: `staff_program_${suffix}`,
        shopDomain: fixture.shop,
        shopCurrency: "JPY",
        apiVersion: "2026-07",
        installationGeneration: "generation-1",
      },
    });
    await database.installedIntegration.create({
      data: {
        id: fixture.installationId,
        projectId,
        userId: `staff_user_${suffix}`,
        integrationId: SHOPIFY_INTEGRATION_ID,
        credentials: {
          shop: fixture.shop,
          accessToken: encrypt("synthetic-offline"),
          installationGeneration: "generation-1",
        },
      },
    });
    await database.weleticShopifyAppSession.create({
      data: {
        id: `offline_${fixture.shop}`,
        shop: fixture.shop,
        isOnline: false,
        payload: encrypt(
          JSON.stringify([
            ["id", `offline_${fixture.shop}`],
            ["shop", fixture.shop],
            ["isOnline", false],
            ["accessToken", "synthetic-offline"],
          ]),
        ),
      },
    });
    return fixture;
  }

  async function actor(
    fixture: Awaited<ReturnType<typeof seed>>,
    owner = true,
  ): Promise<ShopifyMerchantActorEnvelope> {
    const { encrypt } = await import("../../lib/encryption");
    const { bindShopifyOnlineSession } = await import(
      "../../lib/weletic/shopify/session-online-binding"
    );
    const userId = owner ? "123" : "456";
    const sessionId = `${fixture.shop}_${userId}`;
    const binding = {
      appId: "staff-db-test",
      shop: fixture.shop,
      storeId: fixture.id,
      installationGeneration: "generation-1",
    };
    const expiresAt = new Date(Date.now() + 3_600_000);
    const payload = encrypt(
      JSON.stringify(
        bindShopifyOnlineSession(
          [
            ["id", sessionId],
            ["shop", fixture.shop],
            ["isOnline", true],
            ["userId", Number(userId)],
            ["accountOwner", owner],
            ["collaborator", false],
            ["associatedUserScope", "read_products"],
            ["accessToken", "synthetic-online"],
            ["expires", expiresAt.getTime()],
          ],
          binding,
        ),
      ),
    );
    await database.weleticShopifyAppSession.upsert({
      where: { id: sessionId },
      create: {
        id: sessionId,
        shop: fixture.shop,
        isOnline: true,
        payload,
        expiresAt,
      },
      update: { payload, expiresAt },
    });
    return {
      ...binding,
      version: 1,
      userId,
      sessionId,
      sessionDigest: createHash("sha256").update(payload).digest("hex"),
      authenticatedAt: Date.now() - 1000,
      requestId: randomBytes(32).toString("hex"),
    };
  }

  const freshNonce = (value: ShopifyMerchantActorEnvelope) => ({
    ...value,
    requestId: randomBytes(32).toString("hex"),
  });
  async function signedRequest(
    value: unknown,
    mutate?: (request: Request, body: string) => Request,
    list:
      | boolean
      | "moderate"
      | "overview"
      | "export"
      | "reviews"
      | "settings"
      | "loyalty-configuration"
      | "earning-rules"
      | "reward-catalog"
      | "referral-configuration"
      | "customers"
      | "customer-profile" = false,
  ) {
    const { signWeleticShopifyRequest } = await import(
      "../../lib/weletic/shopify/service-auth"
    );
    const path =
      list === "referral-configuration"
        ? "/api/internal/shopify/merchant/referral-configuration"
        : list === "reward-catalog"
          ? "/api/internal/shopify/merchant/reward-catalog"
          : list === "moderate"
            ? "/api/internal/shopify/merchant/reviews/moderate"
            : list === "earning-rules"
              ? "/api/internal/shopify/merchant/earning-rules"
              : list === "loyalty-configuration"
                ? "/api/internal/shopify/merchant/loyalty-configuration"
                : list === "customers"
                  ? "/api/internal/shopify/merchant/customers/list"
                  : list === "customer-profile"
                    ? "/api/internal/shopify/merchant/customers/profile"
                    : list === "settings"
                      ? "/api/internal/shopify/merchant/settings"
                      : list === "reviews"
                        ? "/api/internal/shopify/merchant/reviews/list"
                        : list === "export"
                          ? "/api/internal/shopify/merchant/staff/export"
                          : list === "overview"
                            ? "/api/internal/shopify/merchant/overview"
                            : `/api/internal/shopify/merchant/staff/grants${list ? "/list" : ""}`;
    const body = JSON.stringify(value);
    const timestamp = String(Date.now());
    const request = new Request(`https://staff-test.invalid${path}`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "x-weletic-timestamp": timestamp,
        "x-weletic-signature": signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path,
          body,
          secret: process.env.WELETIC_SHOPIFY_SERVICE_SECRET!,
        }),
      },
    });
    if (list === "earning-rules") {
      const { POST } = await import(
        "../../app/api/internal/shopify/merchant/earning-rules/route"
      );
      return POST(mutate ? mutate(request, body) : request);
    }
    if (list === "reward-catalog") {
      const { POST } = await import(
        "../../app/api/internal/shopify/merchant/reward-catalog/route"
      );
      return POST(mutate ? mutate(request, body) : request);
    }
    if (list === "referral-configuration") {
      const { POST } = await import(
        "../../app/api/internal/shopify/merchant/referral-configuration/route"
      );
      return POST(mutate ? mutate(request, body) : request);
    }
    if (list === "loyalty-configuration") {
      const { POST } = await import(
        "../../app/api/internal/shopify/merchant/loyalty-configuration/route"
      );
      return POST(mutate ? mutate(request, body) : request);
    }
    if (list === "customers" || list === "customer-profile") {
      const { POST } = await import(
        "../../app/api/internal/shopify/merchant/customers/[operation]/route"
      );
      return POST(mutate ? mutate(request, body) : request, {
        params: Promise.resolve({
          operation: list === "customers" ? "list" : "profile",
        }),
      });
    }
    const { POST } =
      list === "moderate"
        ? await import(
            "../../app/api/internal/shopify/merchant/reviews/moderate/route"
          )
        : list === "settings"
          ? await import(
              "../../app/api/internal/shopify/merchant/settings/route"
            )
          : list === "reviews"
            ? await import(
                "../../app/api/internal/shopify/merchant/reviews/list/route"
              )
            : list === "export"
              ? await import(
                  "../../app/api/internal/shopify/merchant/staff/export/route"
                )
              : list === "overview"
                ? await import(
                    "../../app/api/internal/shopify/merchant/overview/route"
                  )
                : list
                  ? await import(
                      "../../app/api/internal/shopify/merchant/staff/grants/list/route"
                    )
                  : await import(
                      "../../app/api/internal/shopify/merchant/staff/grants/route"
                    );
    return POST(mutate ? mutate(request, body) : request);
  }

  async function seedConfiguration() {
    const f = await seed();
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    configurationProgramIds.push(store.programId);
    await database.program.create({
      data: {
        id: store.programId,
        workspaceId: store.projectId,
        defaultFolderId: `folder_${f.id}`,
        defaultGroupId: `group_${f.id}`,
        name: "Configuration fixture",
        slug: `configuration-${randomUUID()}`,
        accountingCurrency: "JPY",
      },
    });
    return f;
  }
  const configurationRequest = (
    envelope: ShopifyMerchantActorEnvelope,
    request: unknown,
  ) =>
    signedRequest(
      { actor: envelope, request },
      undefined,
      "loyalty-configuration",
    );
  const configurationUpdate = (
    expectedRevision: string | null,
    settings: unknown,
  ) => ({
    operation: "update",
    input: {
      expectedInstallationGeneration: "generation-1",
      expectedRevision,
      settings,
    },
  });

  const earningRuleRequest = (
    envelope: ShopifyMerchantActorEnvelope,
    request: unknown,
  ) => signedRequest({ actor: envelope, request }, undefined, "earning-rules");
  const earningRuleSave = (
    expectedRevision: string | null,
    ruleId: string | null = null,
    name = "Purchase",
    multiplier = "1.2500",
  ) => ({
    operation: "save",
    input: {
      expectedInstallationGeneration: "generation-1",
      expectedRevision,
      ruleId,
      rule: {
        name,
        description: null,
        triggerCode: "order_paid",
        priority: 0,
        multiplier,
        fixedPoints: null,
        maxPointsPerEvent: "9007199254740993",
        minOrderSubtotal: "123.45",
        excludeDiscountedItems: false,
        excludeTaxesAndShipping: true,
        maxEventsPerCustomer: null,
        limitInterval: null,
        conditions: null,
        isActive: false,
      },
    },
  });

  async function referralConfigurationFixture(createProgram = true) {
    const f = await seed();
    if (createProgram)
      await database.weleticLoyaltyProgram.create({
        data: {
          id: `loyalty_${f.id}`,
          storeId: f.id,
          name: "Controlled referral program",
          status: "draft",
        },
      });
    const { manageWorkspaceReferralConfiguration: manage } = await import(
      "../../lib/weletic/loyalty/workspace-referral-configuration"
    );
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    const authority = {
      workspaceId: store.projectId,
      role: "owner",
      permissions: ["loyalty.read", "loyalty.write"] as const,
    };
    const state = await manage(authority, { operation: "read" });
    const input = {
      expectedRevision: state.revision,
      expectedInstallationGeneration: "generation-1",
      ruleId: state.ruleId,
      fields: {
        ...state.fields!,
        advocatePointsReward: "9007199254740993",
        minQualifyingOrderSubtotal: "30",
        isActive: true,
      },
    };
    return { f, manage, authority, state, input };
  }

  it("referral configuration: read never initializes; competing saves commit one exact rule", async () => {
    const absent = await referralConfigurationFixture(false);
    expect(absent.state.programId).toBeNull();
    await expect(
      absent.manage(absent.authority, {
        operation: "save",
        input: absent.input,
      }),
    ).rejects.toThrow();
    expect(
      await database.weleticLoyaltyProgram.count({
        where: { storeId: absent.f.id },
      }),
    ).toBe(0);
    const { f, manage, authority, input } =
      await referralConfigurationFixture();
    const results = await Promise.allSettled([
      manage(authority, { operation: "save", input }),
      manage(authority, { operation: "save", input }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const final = await manage(authority, { operation: "read" });
    expect(final.fields?.advocatePointsReward).toBe("9007199254740993");
    expect(
      await database.weleticLoyaltyReferralRule.count({
        where: { programId: final.programId! },
      }),
    ).toBe(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("referral configuration: signed authorization, replay, stale generation and rollback are atomic", async () => {
    const { f, state, input } = await referralConfigurationFixture();
    const owner = await actor(f);
    const staff = await actor(f, false);
    expect(
      (
        await signedRequest(
          { actor: staff, request: { operation: "save", input } },
          undefined,
          "referral-configuration",
        )
      ).status,
    ).toBe(403);
    const read = await signedRequest(
      { actor: owner, request: { operation: "read" } },
      undefined,
      "referral-configuration",
    );
    expect(read.status).toBe(200);
    expect((await read.json()).revision).toBe(state.revision);
    expect(
      (
        await signedRequest(
          { actor: owner, request: { operation: "save", input } },
          undefined,
          "referral-configuration",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await signedRequest(
          {
            actor: freshNonce(owner),
            request: {
              operation: "save",
              input: { ...input, expectedInstallationGeneration: "old" },
            },
          },
          undefined,
          "referral-configuration",
        )
      ).status,
    ).toBe(409);
    const { manageShopifyReferralConfigurationInTransaction: manage } =
      await import("../../lib/weletic/shopify/referral-configuration");
    const before = await database.weleticShopifyMerchantAction.count({
      where: { storeId: f.id },
    });
    await expect(
      database.$transaction(
        async (tx) => {
          await manage({
            tx,
            envelope: freshNonce(owner),
            request: { operation: "save", input },
          });
          throw new Error("forced referral rollback");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow("forced referral rollback");
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(before);
    expect(
      await database.weleticLoyaltyReferralRule.count({
        where: { programId: state.programId! },
      }),
    ).toBe(0);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), request: { operation: "save", input } },
          undefined,
          "referral-configuration",
        )
      ).status,
    ).toBe(200);
  });

  it("referral configuration: enforces narrowed workspace authority and current coupon/currency bindings", async () => {
    const { f, manage, authority, input } =
      await referralConfigurationFixture();
    await expect(
      manage(
        { ...authority, permissions: ["loyalty.read"] },
        { operation: "save", input },
      ),
    ).rejects.toThrow();
    await expect(
      manage({ ...authority, permissions: [] }, { operation: "read" }),
    ).rejects.toThrow();
    await expect(
      manage(authority, {
        operation: "save",
        input: {
          ...input,
          fields: { ...input.fields, minQualifyingOrderSubtotal: "1.01" },
        },
      }),
    ).rejects.toThrow();
    const foreign = await referralConfigurationFixture();
    await database.weleticRewardDefinition.create({
      data: {
        id: `coupon_${foreign.f.id}`,
        storeId: foreign.f.id,
        name: "Foreign coupon",
        rewardType: "amount_off",
        pointsCost: BigInt(1),
        discountValue: new Prisma.Decimal(1),
        status: "active",
      },
    });
    await expect(
      manage(authority, {
        operation: "save",
        input: {
          ...input,
          fields: {
            ...input.fields,
            advocateRewardKind: "coupon",
            advocatePointsReward: "0",
            advocateRewardDefinitionId: `coupon_${foreign.f.id}`,
          },
        },
      }),
    ).rejects.toThrow();
    await database.weleticShopifyStore.update({
      where: { id: f.id },
      data: { shopCurrency: "BHD" },
    });
    await expect(
      manage(authority, { operation: "save", input }),
    ).rejects.toThrow();
    const changed = await manage(authority, { operation: "read" });
    const saved = await manage(authority, {
      operation: "save",
      input: {
        ...input,
        expectedRevision: changed.revision,
        fields: { ...input.fields, minQualifyingOrderSubtotal: "1.01" },
      },
    });
    expect(saved.fields?.minQualifyingOrderSubtotal).toBe("1.01");
    const row = await database.weleticLoyaltyReferralRule.findUniqueOrThrow({
      where: { id: saved.ruleId! },
    });
    const { referralMinimumSubtotalMinorUnits } = await import(
      "../../lib/weletic/loyalty/referrals"
    );
    expect(
      referralMinimumSubtotalMinorUnits({
        minimumSubtotal: row.minQualifyingOrderSubtotal!,
        currency: "BHD",
      }),
    ).toBe(BigInt(1010));
  });

  it("referral configuration: empty-rule pause stays inactive when runtime acquires defaults", async () => {
    const { manage, authority, state } = await referralConfigurationFixture();
    expect(state.ruleId).toBeNull();
    expect(state.active).toBe(true);
    const paused = await manage(authority, {
      operation: "pause",
      input: {
        expectedRevision: state.revision,
        expectedInstallationGeneration: "generation-1",
      },
    });
    expect(paused.active).toBe(false);
    expect(paused.ruleId).not.toBeNull();
    const { getOrCreateReferralRule } = await import(
      "../../lib/weletic/loyalty/referrals"
    );
    const runtime = await getOrCreateReferralRule(state.programId!);
    expect(runtime.id).toBe(paused.ruleId);
    expect(runtime.isActive).toBe(false);
    expect(
      await database.weleticLoyaltyReferralRule.count({
        where: { programId: state.programId! },
      }),
    ).toBe(1);
  });

  it("referral configuration: pause preserves every legacy economic column without currency", async () => {
    const { f, manage, authority, state } =
      await referralConfigurationFixture();
    await database.weleticLoyaltyReferralRule.createMany({
      data: [1, 2].map((n) => ({
        id: `legacy_${f.id}_${n}`,
        programId: state.programId!,
        advocatePointsReward: BigInt(-5),
        refereePointsReward: BigInt("9007199254740993"),
        isActive: true,
      })),
    });
    await database.weleticShopifyStore.update({
      where: { id: f.id },
      data: { shopCurrency: "" },
    });
    const before = await database.weleticLoyaltyReferralRule.findMany({
      where: { programId: state.programId! },
      orderBy: { id: "asc" },
    });
    const legacy = await manage(authority, { operation: "read" });
    expect(legacy.fields).toBeNull();
    const paused = await manage(authority, {
      operation: "pause",
      input: {
        expectedRevision: legacy.revision,
        expectedInstallationGeneration: "generation-1",
      },
    });
    expect(paused.active).toBe(false);
    const after = await database.weleticLoyaltyReferralRule.findMany({
      where: { programId: state.programId! },
      orderBy: { id: "asc" },
    });
    const economics = (row: (typeof before)[number]) => {
      const { updatedAt, isActive, ...retained } = row;
      return retained;
    };
    expect(after.map(economics)).toEqual(before.map(economics));
    expect(after.every((row) => !row.isActive)).toBe(true);
  });

  it("referral configuration: selecting a shared coupon never issues it and stale reward edits invalidate saves", async () => {
    const { f, manage, authority, input } =
      await referralConfigurationFixture();
    const rewardId = `shared_coupon_${f.id}`;
    await database.weleticRewardDefinition.create({
      data: {
        id: rewardId,
        storeId: f.id,
        name: "Shared coupon",
        rewardType: "amount_off",
        pointsCost: BigInt(100),
        discountValue: new Prisma.Decimal(1),
        status: "active",
        appliesToResource: "entire_order",
      },
    });
    const current = await manage(authority, { operation: "read" });
    expect(current.couponOptions.map((row) => row.id)).toContain(rewardId);
    const couponInput = {
      ...input,
      expectedRevision: current.revision,
      fields: {
        ...input.fields,
        advocateRewardKind: "coupon",
        advocateRewardDefinitionId: rewardId,
        advocatePointsReward: "0",
      },
    };
    const saved = await manage(authority, {
      operation: "save",
      input: couponInput,
    });
    expect(saved.fields?.advocateRewardDefinitionId).toBe(rewardId);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    await database.weleticRewardDefinition.update({
      where: { id: rewardId },
      data: { status: "inactive" },
    });
    await expect(
      manage(authority, {
        operation: "save",
        input: {
          ...couponInput,
          ruleId: saved.ruleId,
          expectedRevision: saved.revision,
        },
      }),
    ).rejects.toThrow();
    expect(
      (await manage(authority, { operation: "read" })).couponOptions,
    ).toHaveLength(0);
  });

  async function rewardCatalogFixture() {
    const f = await seed();
    const {
      readRewardCatalogInTransaction: read,
      saveRewardCatalogInTransaction: save,
    } = await import("../../lib/weletic/loyalty/reward-catalog-service");
    const { withActiveStoreLoyaltyMutation } = await import(
      "../../lib/weletic/loyalty/merchant-write-fence"
    );
    const state = await database.$transaction((tx) => read(tx, f.id));
    const input = {
      expectedInstallationGeneration: "generation-1",
      expectedRevision: state.revision,
      rewardId: null as string | null,
      reward: {
        name: "Controlled discount",
        description: null,
        rewardType: "amount_off" as const,
        salesChannel: "online_store" as const,
        exchangeType: "fixed" as const,
        pointsCost: "9007199254740993",
        pointsStep: null,
        minPointsCost: null,
        maxPointsCost: null,
        discountValue: "1",
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: "entire_order" as const,
        entitledProductIds: [],
        entitledVariantIds: [],
        entitledCollectionIds: [],
        combinesWithOrderDiscounts: false,
        combinesWithProductDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
        expiresInDays: null,
        status: "inactive" as const,
      },
    };
    const write = (value: unknown, rollback = false) =>
      withActiveStoreLoyaltyMutation({
        storeId: f.id,
        action: "loyalty_reward_catalog_write",
        expectedInstallationGeneration: "generation-1",
        operation: async (tx, generation) => {
          if (!generation) throw new Error("Missing generation");
          const result = await save({
            tx,
            storeId: f.id,
            installationGeneration: generation,
            input: value,
          });
          if (rollback) throw new Error("forced catalog rollback");
          return result;
        },
      });
    return { f, read, input, write };
  }

  it("reward catalog: competing creations commit once with exact inactive values and no financial writes", async () => {
    const { f, input, write } = await rewardCatalogFixture();
    const results = await Promise.allSettled([write(input), write(input)]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rewards = await database.weleticRewardDefinition.findMany({
      where: { storeId: f.id },
    });
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({
      status: "inactive",
      pointsCost: BigInt("9007199254740993"),
    });
    expect(rewards[0].discountValue?.toString()).toBe("1");
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("reward catalog: rolls back creation and rejects currency changes without reinterpreting money", async () => {
    const { f, read, input, write } = await rewardCatalogFixture();
    await expect(write(input, true)).rejects.toThrow("forced catalog rollback");
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect((await database.$transaction((tx) => read(tx, f.id))).revision).toBe(
      input.expectedRevision,
    );
    await database.weleticShopifyStore.update({
      where: { id: f.id },
      data: { shopCurrency: "USD" },
    });
    await expect(write(input)).rejects.toThrow();
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("reward catalog: competing edits have one winner and stale retries cannot overwrite it", async () => {
    const { f, read, input, write } = await rewardCatalogFixture();
    const created = await write(input);
    const update = {
      ...input,
      expectedRevision: created.revision,
      rewardId: created.affectedRewardId,
    };
    const results = await Promise.allSettled([
      write({ ...update, reward: { ...input.reward, name: "Writer A" } }),
      write({ ...update, reward: { ...input.reward, name: "Writer B" } }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const committed = await database.$transaction((tx) => read(tx, f.id));
    expect(["Writer A", "Writer B"]).toContain(committed.rewards[0].name);
    await expect(write(update)).rejects.toThrow();
    expect(await database.$transaction((tx) => read(tx, f.id))).toEqual(
      committed,
    );
  });

  it("reward catalog: signed gateway enforces staff permissions, private responses and nonce replay", async () => {
    const { f, input } = await rewardCatalogFixture();
    const owner = await actor(f);
    const staff = await actor(f, false);
    const request = (actor: ShopifyMerchantActorEnvelope, request: unknown) =>
      signedRequest({ actor, request }, undefined, "reward-catalog");
    expect(
      (await request(freshNonce(staff), { operation: "read" })).status,
    ).toBe(403);
    expect(
      (
        await signedRequest({
          actor: freshNonce(owner),
          input: {
            userId: "456",
            permissions: ["loyalty.read"],
            expectedRevision: 0,
          },
        })
      ).status,
    ).toBe(200);
    const read = await request(freshNonce(staff), { operation: "read" });
    expect(read.status).toBe(200);
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await read.json()).toMatchObject({
      capabilities: { configure: false },
      rewards: [],
    });
    expect(
      (await request(freshNonce(staff), { operation: "save", input })).status,
    ).toBe(403);
    const writer = freshNonce(owner);
    const saved = await request(writer, { operation: "save", input });
    expect(saved.status).toBe(200);
    const response = await saved.json();
    expect(response.rewards[0].fields.pointsCost).toBe("9007199254740993");
    expect(response.rewards[0]).not.toHaveProperty("shopifyPriceRuleId");
    expect((await request(writer, { operation: "save", input })).status).toBe(
      409,
    );
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(1);
    const tampered = await signedRequest(
      { actor: freshNonce(owner), request: { operation: "read" } },
      (request) =>
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: "{}",
        }),
      "reward-catalog",
    );
    expect(tampered.status).toBe(401);
  });

  it("reward catalog: workspace and signed Shopify edits share one winning state", async () => {
    const { f, input, write } = await rewardCatalogFixture();
    const created = await write(input);
    const { manageWorkspaceRewardCatalog: manage } = await import(
      "../../lib/weletic/loyalty/workspace-reward-catalog"
    );
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    const authority = {
      workspaceId: store.projectId!,
      role: "owner",
      permissions: ["loyalty.read", "loyalty.write"] as const,
    };
    const owner = await actor(f);
    const current = await manage(authority, { operation: "read" });
    expect(current.revision).toBe(created.revision);
    const update = {
      ...input,
      rewardId: created.affectedRewardId,
      expectedRevision: created.revision,
    };
    await expect(
      manage(
        { ...authority, permissions: ["loyalty.read"] },
        { operation: "save", input: update },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const [workspace, shopify] = await Promise.allSettled([
      manage(authority, {
        operation: "save",
        input: {
          ...update,
          reward: { ...input.reward, name: "Workspace winner" },
        },
      }),
      signedRequest(
        {
          actor: freshNonce(owner),
          request: {
            operation: "save",
            input: {
              ...update,
              reward: { ...input.reward, name: "Shopify winner" },
            },
          },
        },
        undefined,
        "reward-catalog",
      ),
    ]);
    if (shopify.status !== "fulfilled") throw shopify.reason;
    if (workspace.status === "fulfilled")
      expect(shopify.value.status).toBe(409);
    else expect(shopify.value.status).toBe(200);
    const final = await manage(authority, { operation: "read" });
    expect(final.rewards[0].name).toBe(
      workspace.status === "fulfilled" ? "Workspace winner" : "Shopify winner",
    );
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(1);
  });

  it("reward catalog: rolls back authorized receipt and reward together", async () => {
    const { f, input } = await rewardCatalogFixture();
    const owner = await actor(f);
    const { manageShopifyRewardCatalogInTransaction: manage } = await import(
      "../../lib/weletic/shopify/reward-catalog"
    );
    await expect(
      database.$transaction(
        async (tx) => {
          await manage({
            tx,
            envelope: owner,
            request: { operation: "save", input },
          });
          throw new Error("authorized rollback");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow("authorized rollback");
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("reward catalog: signed stale generation and foreign IDs cannot write", async () => {
    const { f, input, write } = await rewardCatalogFixture();
    const foreign = await rewardCatalogFixture();
    const other = await foreign.write(foreign.input);
    const owner = await actor(f);
    const request = (input: unknown) =>
      signedRequest(
        { actor: freshNonce(owner), request: { operation: "save", input } },
        undefined,
        "reward-catalog",
      );
    expect(
      (await request({ ...input, expectedInstallationGeneration: "old" }))
        .status,
    ).toBe(409);
    expect(
      (await request({ ...input, rewardId: other.affectedRewardId })).status,
    ).toBe(409);
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    const saved = await write(input);
    await database.weleticShopifyStore.update({
      where: { id: f.id },
      data: { installationGeneration: "generation-2" },
    });
    expect(
      (
        await request({
          ...input,
          rewardId: saved.affectedRewardId,
          expectedRevision: saved.revision,
        })
      ).status,
    ).toBe(401);
    expect(
      await database.weleticRewardDefinition.count({
        where: { storeId: f.id },
      }),
    ).toBe(1);
  });

  it("reward catalog: contains legacy terms without currency, economics changes or reactivation", async () => {
    const { f, input, write } = await rewardCatalogFixture();
    const created = await write(input);
    await database.weleticRewardDefinition.update({
      where: { id: created.affectedRewardId },
      data: {
        status: "active",
        shopifyPriceRuleId: "legacy-provider-reference",
      },
    });
    await database.weleticShopifyStore.update({
      where: { id: f.id },
      data: { shopCurrency: "" },
    });
    const before = await database.weleticRewardDefinition.findUniqueOrThrow({
      where: { id: created.affectedRewardId },
    });
    const owner = await actor(f);
    const staff = await actor(f, false);
    expect(
      (
        await signedRequest({
          actor: freshNonce(owner),
          input: {
            userId: "456",
            permissions: ["loyalty.read"],
            expectedRevision: 0,
          },
        })
      ).status,
    ).toBe(200);
    const request = (request: unknown, identity = owner) =>
      signedRequest(
        { actor: freshNonce(identity), request },
        undefined,
        "reward-catalog",
      );
    const read = await request({ operation: "read" });
    expect(read.status).toBe(200);
    const state = await read.json();
    expect(state).toMatchObject({
      shopCurrency: null,
      rewards: [{ fields: null, status: "active" }],
    });
    const containment = {
      expectedInstallationGeneration: "generation-1",
      expectedRevision: state.revision,
      rewardId: before.id,
      status: "inactive",
    };
    expect(
      (await request({ operation: "contain", input: containment }, staff))
        .status,
    ).toBe(403);
    expect(
      (
        await request({
          operation: "contain",
          input: { ...containment, status: "active" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request({
          operation: "save",
          input: {
            ...input,
            rewardId: before.id,
            expectedRevision: state.revision,
          },
        })
      ).status,
    ).toBe(409);
    const paused = await request({ operation: "contain", input: containment });
    expect(paused.status).toBe(200);
    const pausedState = await paused.json();
    expect(pausedState.rewards[0]).toMatchObject({
      status: "inactive",
      fields: null,
    });
    const after = await database.weleticRewardDefinition.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect({
      ...after,
      status: before.status,
      updatedAt: before.updatedAt,
    }).toEqual(before);
    expect(
      (await request({ operation: "contain", input: containment })).status,
    ).toBe(409);
    const archive = {
      ...containment,
      expectedRevision: pausedState.revision,
      status: "archived",
    };
    const { manageShopifyRewardCatalogInTransaction: manage } = await import(
      "../../lib/weletic/shopify/reward-catalog"
    );
    const receiptCount = await database.weleticShopifyMerchantAction.count({
      where: { storeId: f.id },
    });
    await expect(
      database.$transaction(
        async (tx) => {
          await manage({
            tx,
            envelope: freshNonce(owner),
            request: { operation: "contain", input: archive },
          });
          throw new Error("containment rollback");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow("containment rollback");
    expect(
      await database.weleticRewardDefinition.findUniqueOrThrow({
        where: { id: before.id },
      }),
    ).toEqual(after);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(receiptCount);
    const archived = await request({ operation: "contain", input: archive });
    expect(archived.status).toBe(200);
    const archivedState = await archived.json();
    expect(
      (
        await request({
          operation: "contain",
          input: { ...containment, expectedRevision: archivedState.revision },
        })
      ).status,
    ).toBe(409);
    const final = await database.weleticRewardDefinition.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(final.status).toBe("archived");
    expect({
      ...final,
      status: before.status,
      updatedAt: before.updatedAt,
    }).toEqual(before);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("earning rules: shares exact persisted values and one winning revision across workspace and Shopify", async () => {
    const f = await seedConfiguration();
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    const { manageWorkspaceEarningRules: manage } = await import(
      "../../lib/weletic/loyalty/workspace-earning-rules"
    );
    const authority = {
      workspaceId: store.projectId,
      role: "owner",
      permissions: ["loyalty.read", "loyalty.write"] as const,
    };
    expect(await manage(authority, { operation: "read" })).toMatchObject({
      programId: null,
      revision: null,
      rules: [],
    });
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    const created = await manage(authority, earningRuleSave(null));
    expect(created.shopCurrency).toBe("JPY");
    const ruleId = created.affectedRuleId!;
    const persisted =
      await database.weleticLoyaltyEarningRule.findUniqueOrThrow({
        where: { id: ruleId },
      });
    expect(persisted.maxPointsPerEvent).toBe(BigInt("9007199254740993"));
    expect(persisted.multiplier.toString()).toBe("1.25");
    expect(persisted.minOrderSubtotal?.toString()).toBe("123.45");
    const owner = await actor(f);
    const read = await earningRuleRequest(freshNonce(owner), {
      operation: "read",
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      revision: created.revision,
      shopCurrency: "JPY",
      rules: [
        { id: ruleId, fields: { maxPointsPerEvent: "9007199254740993" } },
      ],
    });
    // Both production entry points start together. This verifies the committed
    // outcome, not direct observation of the database lock acquisition order.
    const [workspace, shopify] = await Promise.allSettled([
      manage(
        authority,
        earningRuleSave(created.revision, ruleId, "Workspace winner", "2"),
      ),
      earningRuleRequest(
        freshNonce(owner),
        earningRuleSave(created.revision, ruleId, "Shopify winner", "3"),
      ),
    ]);
    expect(shopify.status).toBe("fulfilled");
    if (shopify.status !== "fulfilled") throw shopify.reason;
    if (workspace.status === "fulfilled")
      expect(shopify.value.status).toBe(409);
    else {
      expect(["conflict", "P2034"]).toContain(workspace.reason.code);
      expect(shopify.value.status).toBe(200);
    }
    const current = await manage(authority, { operation: "read" });
    expect(current.rules[0].name).toBe(
      workspace.status === "fulfilled" ? "Workspace winner" : "Shopify winner",
    );
    expect(current.rules[0].fields?.multiplier).toBe(
      workspace.status === "fulfilled" ? "2" : "3",
    );
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(2);
    expect(
      (
        await earningRuleRequest(
          freshNonce(owner),
          earningRuleSave(created.revision, ruleId, "Stale replay"),
        )
      ).status,
    ).toBe(409);
    expect((await manage(authority, { operation: "read" })).revision).toBe(
      current.revision,
    );
  });

  it("earning rules: rolls back rule, program, policy and receipt together", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const { manageShopifyEarningRulesInTransaction: manage } = await import(
      "../../lib/weletic/shopify/earning-rules"
    );
    let writtenRuleId: string | null = null;
    await expect(
      database.$transaction(
        async (tx) => {
          const saved = await manage({
            tx,
            envelope: owner,
            request: earningRuleSave(null),
          });
          writtenRuleId = saved.affectedRuleId;
          throw new Error("controlled earning rule rollback");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow("controlled earning rule rollback");
    expect(writtenRuleId).not.toBeNull();
    expect(
      await database.weleticLoyaltyEarningRule.count({
        where: { id: writtenRuleId! },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    // Rolled-back authorization receipts must not consume the request nonce.
    expect(
      (await earningRuleRequest(owner, earningRuleSave(null))).status,
    ).toBe(200);
  });

  it("earning rules: update versus retirement has one winner and cannot resurrect retired rows", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const response = await earningRuleRequest(
      freshNonce(owner),
      earningRuleSave(null),
    );
    expect(response.status).toBe(200);
    const created = await response.json();
    const retire = {
      operation: "retire",
      input: {
        expectedInstallationGeneration: "generation-1",
        expectedRevision: created.revision,
        ruleId: created.affectedRuleId,
      },
    };
    const outcomes = await Promise.all([
      earningRuleRequest(
        freshNonce(owner),
        earningRuleSave(
          created.revision,
          created.affectedRuleId,
          "Updated",
          "2",
        ),
      ),
      earningRuleRequest(freshNonce(owner), retire),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(2);
    const currentResponse = await earningRuleRequest(freshNonce(owner), {
      operation: "read",
    });
    const current = await currentResponse.json();
    const intermediate =
      await database.weleticLoyaltyEarningRule.findUniqueOrThrow({
        where: { id: created.affectedRuleId },
      });
    if (outcomes[0].status === 200) {
      expect(intermediate.deletedAt).toBeNull();
      expect(intermediate.name).toBe("Updated");
      expect(intermediate.multiplier.toString()).toBe("2");
      expect(current.rules).toHaveLength(1);
    } else {
      expect(intermediate.deletedAt).not.toBeNull();
      expect(intermediate.name).toBe("Purchase");
      expect(current.rules).toEqual([]);
    }
    if (current.rules.length) {
      expect(
        (
          await earningRuleRequest(freshNonce(owner), {
            ...retire,
            input: { ...retire.input, expectedRevision: current.revision },
          })
        ).status,
      ).toBe(200);
    }
    const afterResponse = await earningRuleRequest(freshNonce(owner), {
      operation: "read",
    });
    const after = await afterResponse.json();
    expect(after.rules).toEqual([]);
    const counts = async () => ({
      policies: await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
      receipts: await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    });
    const beforeFailure = await counts();
    expect(
      (
        await earningRuleRequest(
          freshNonce(owner),
          earningRuleSave(after.revision, created.affectedRuleId),
        )
      ).status,
    ).toBe(404);
    expect(await counts()).toEqual(beforeFailure);
    const row = await database.weleticLoyaltyEarningRule.findUniqueOrThrow({
      where: { id: created.affectedRuleId },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.isActive).toBe(false);
    const finalRead = await earningRuleRequest(freshNonce(owner), {
      operation: "read",
    });
    expect(finalRead.status).toBe(200);
    expect((await finalRead.json()).revision).toBe(after.revision);
  });

  it("earning rules: rejects stale generations and foreign rule IDs without policy writes", async () => {
    const f = await seedConfiguration();
    const foreign = await seedConfiguration();
    const owner = await actor(f);
    const foreignOwner = await actor(foreign);
    const createdResponse = await earningRuleRequest(
      freshNonce(owner),
      earningRuleSave(null),
    );
    const foreignResponse = await earningRuleRequest(
      freshNonce(foreignOwner),
      earningRuleSave(null),
    );
    expect(createdResponse.status).toBe(200);
    expect(foreignResponse.status).toBe(200);
    const created = await createdResponse.json();
    const other = await foreignResponse.json();
    const request = earningRuleSave(created.revision, created.affectedRuleId);
    request.input.expectedInstallationGeneration = "previous-generation";
    expect((await earningRuleRequest(freshNonce(owner), request)).status).toBe(
      409,
    );
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    const { manageWorkspaceEarningRules: manage } = await import(
      "../../lib/weletic/loyalty/workspace-earning-rules"
    );
    const authority = {
      workspaceId: store.projectId,
      role: "owner",
      permissions: ["loyalty.read", "loyalty.write"] as const,
    };
    await expect(manage(authority, request)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      (
        await earningRuleRequest(
          freshNonce(owner),
          earningRuleSave(created.revision, other.affectedRuleId),
        )
      ).status,
    ).toBe(404);
    await expect(
      manage(
        authority,
        earningRuleSave(created.revision, other.affectedRuleId),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await manage(authority, { operation: "read" })).revision).toBe(
      created.revision,
    );
    const foreignRead = await earningRuleRequest(freshNonce(foreignOwner), {
      operation: "read",
    });
    expect((await foreignRead.json()).revision).toBe(other.revision);
    for (const storeId of [f.id, foreign.id])
      expect(
        await database.weleticLoyaltyEarnPolicyRevision.count({
          where: { storeId },
        }),
      ).toBe(1);
  });

  it("shares one configuration revision across workspace and signed Shopify writers", async () => {
    const f = await seedConfiguration();
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    const { manageWorkspaceLoyaltyConfiguration: manage } = await import(
      "../../lib/weletic/loyalty/workspace-configuration"
    );
    const authority = {
      workspaceId: store.projectId,
      role: "owner",
      permissions: ["loyalty.read", "loyalty.write"] as const,
    };
    expect(await manage(authority)).toMatchObject({
      program: null,
      configurationRevision: null,
    });
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    const created = await manage(
      authority,
      configurationUpdate(null, {
        name: "Workspace created",
        pointsPerCurrencyUnit: "1.2500",
      }).input,
    );
    expect(created.program?.settings.pointsPerCurrencyUnit).toBe("1.25");
    const owner = await actor(f);
    const read = await configurationRequest(freshNonce(owner), {
      operation: "read",
    });
    expect((await read.json()).configurationRevision).toBe(
      created.configurationRevision,
    );
    const results = await Promise.allSettled([
      manage(
        authority,
        configurationUpdate(created.configurationRevision, {
          pointsPerCurrencyUnit: "2",
        }).input,
      ),
      configurationRequest(
        freshNonce(owner),
        configurationUpdate(created.configurationRevision, {
          pointsPerCurrencyUnit: "3",
        }),
      ),
    ]);
    const [workspaceResult, shopifyResult] = results;
    expect(shopifyResult.status).toBe("fulfilled");
    if (shopifyResult.status !== "fulfilled") throw shopifyResult.reason;
    if (workspaceResult.status === "fulfilled") {
      expect(shopifyResult.value.status).toBe(409);
      expect(
        workspaceResult.value.program?.settings.pointsPerCurrencyUnit,
      ).toBe("2");
    } else {
      expect(shopifyResult.value.status).toBe(200);
      expect(["conflict", "P2034"]).toContain(workspaceResult.reason.code);
    }
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(2);
    const current = await manage(authority);
    expect(current.program?.settings.pointsPerCurrencyUnit).toBe(
      workspaceResult.status === "fulfilled" ? "2" : "3",
    );
    await expect(
      manage(
        { ...authority, permissions: ["loyalty.read"] },
        configurationUpdate(current.configurationRevision, { name: "Denied" })
          .input,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      manage(
        { ...authority, role: "member" },
        configurationUpdate(current.configurationRevision, { status: "active" })
          .input,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await manage(authority)).configurationRevision).toBe(
      current.configurationRevision,
    );
  });

  it("rolls back a workspace configuration and policy write together", async () => {
    const f = await seedConfiguration();
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: f.id },
    });
    const { manageWorkspaceLoyaltyConfigurationInTransaction: manage } =
      await import("../../lib/weletic/loyalty/workspace-configuration");
    const authority = {
      workspaceId: store.projectId,
      role: "owner",
      permissions: ["loyalty.read", "loyalty.write"] as const,
    };
    await expect(
      database.$transaction(
        async (tx) => {
          await manage({
            tx,
            authority,
            update: configurationUpdate(null, { name: "Rolled back" }).input,
          });
          throw new Error("controlled workspace post-write failure");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow("controlled workspace post-write failure");
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("configures Loyalty through actual signed transactions without side effects on reads", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const staff = await actor(f, false);
    expect(
      (await configurationRequest(staff, { operation: "read" })).status,
    ).toBe(403);
    await grant(freshNonce(owner), 0, ["loyalty.read"]);
    const initial = await configurationRequest(freshNonce(staff), {
      operation: "read",
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      program: null,
      configurationRevision: null,
      capabilities: { configure: false, owner: false },
    });
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    expect(
      (
        await configurationRequest(
          freshNonce(staff),
          configurationUpdate(null, { name: "Loyalty" }),
        )
      ).status,
    ).toBe(403);
    await grant(freshNonce(owner), 1, ["loyalty.read", "loyalty.configure"]);
    const created = await configurationRequest(
      freshNonce(staff),
      configurationUpdate(null, {
        name: "Loyalty",
        pointsPerCurrencyUnit: "1.2500",
      }),
    );
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const data = await created.json();
    expect(data.program.settings).toMatchObject({
      status: "draft",
      pointsPerCurrencyUnit: "1.25",
      liabilityValuationCurrency: null,
    });
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(1);
    const before = await database.weleticLoyaltyProgram.findUniqueOrThrow({
      where: { storeId: f.id },
    });
    for (const settings of [
      { status: "active" },
      { killSwitchActive: false },
      {
        liabilityValuationCurrency: "JPY",
        liabilityMinorUnitsNumerator: "1",
        liabilityPointsDenominator: "100",
      },
    ])
      expect(
        (
          await configurationRequest(
            freshNonce(staff),
            configurationUpdate(data.configurationRevision, settings),
          )
        ).status,
      ).toBe(403);
    expect(
      await database.weleticLoyaltyProgram.findUnique({
        where: { storeId: f.id },
      }),
    ).toEqual(before);
    const saved = await configurationRequest(
      freshNonce(owner),
      configurationUpdate(data.configurationRevision, {
        liabilityValuationCurrency: "JPY",
        liabilityMinorUnitsNumerator: "1",
        liabilityPointsDenominator: "100",
      }),
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).program.settings).toMatchObject({
      liabilityMinorUnitsNumerator: "1",
      liabilityPointsDenominator: "100",
    });
    expect(
      await database.weleticLoyaltyProgram.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({
      liabilityMinorUnitsNumerator: BigInt(1),
      liabilityPointsDenominator: BigInt(100),
    });
    await grant(freshNonce(owner), 2, []);
    expect(
      (await configurationRequest(freshNonce(staff), { operation: "read" }))
        .status,
    ).toBe(403);
  });

  it("rejects overlapping changed configuration and replays with one committed writer", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const created = await configurationRequest(
      freshNonce(owner),
      configurationUpdate(null, { name: "Initial" }),
    );
    expect(created.status).toBe(200);
    const revision = (await created.json()).configurationRevision;
    const firstActor = freshNonce(owner);
    const secondActor = freshNonce(owner);
    const responses = await Promise.all([
      configurationRequest(
        firstActor,
        configurationUpdate(revision, { pointsPerCurrencyUnit: "2" }),
      ),
      configurationRequest(
        secondActor,
        configurationUpdate(revision, { pointsPerCurrencyUnit: "3" }),
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const winnerIndex = responses.findIndex(
      (response) => response.status === 200,
    );
    const winner = await responses[winnerIndex].json();
    expect(
      await database.weleticLoyaltyProgram.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({
      pointsPerCurrencyUnit: new Prisma.Decimal(
        winner.program.settings.pointsPerCurrencyUnit,
      ),
    });
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(2);
    const replay = await configurationRequest(
      winnerIndex === 0 ? firstActor : secondActor,
      configurationUpdate(revision, {
        pointsPerCurrencyUnit: winnerIndex === 0 ? "2" : "3",
      }),
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "request_replayed" });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id, permission: "loyalty.configure" },
      }),
    ).toBe(2);
  });

  it("rejects a configuration worker started while another writer holds the transaction lock", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const initial = await configurationRequest(
      freshNonce(owner),
      configurationUpdate(null, { name: "Initial" }),
    );
    expect(initial.status).toBe(200);
    const revision = (await initial.json()).configurationRevision;
    const { manageShopifyLoyaltyConfigurationInTransaction: manage } =
      await import("../../lib/weletic/shopify/loyalty-configuration");
    const locked = barrier();
    const release = barrier();
    const attempted = barrier();
    const first = database.$transaction(
      async (tx) => {
        const result = await manage({
          tx,
          envelope: freshNonce(owner),
          request: configurationUpdate(revision, {
            pointsPerCurrencyUnit: "2",
          }),
        });
        locked.release();
        await release.promise;
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    // Release the barrier if setup fails, so an assertion failure cannot strand
    // an active fixture transaction until the test timeout.
    void first.catch(() => locked.release());
    await locked.promise;
    const second = database.$transaction(
      async (tx) => {
        const pending = manage({
          tx,
          envelope: freshNonce(owner),
          request: configurationUpdate(revision, {
            pointsPerCurrencyUnit: "3",
          }),
        });
        attempted.release();
        return pending;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    void second.catch(() => attempted.release());
    const outcomes = Promise.allSettled([first, second]);
    try {
      await attempted.promise;
    } finally {
      release.release();
    }
    expect(await outcomes).toMatchObject([
      {
        status: "fulfilled",
        value: { program: { settings: { pointsPerCurrencyUnit: "2" } } },
      },
      { status: "rejected", reason: { code: "conflict" } },
    ]);
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(2);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id, permission: "loyalty.configure" },
      }),
    ).toBe(2);
    expect(
      await database.weleticLoyaltyProgram.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({ pointsPerCurrencyUnit: new Prisma.Decimal("2") });
  });

  it("rolls back configuration, policy revision and action receipt on business failure", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const { manageShopifyLoyaltyConfigurationInTransaction } = await import(
      "../../lib/weletic/shopify/loyalty-configuration"
    );
    const request = configurationUpdate(null, { name: "Rolled back" });
    await expect(
      database.$transaction(
        async (tx) => {
          await manageShopifyLoyaltyConfigurationInTransaction({
            tx,
            envelope: owner,
            request,
          });
          throw new Error("controlled post-write failure");
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).rejects.toThrow("controlled post-write failure");
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect((await configurationRequest(owner, request)).status).toBe(200);
  });

  it("rejects signed invalid values, tampering, currency mismatch and old generation without writes", async () => {
    const f = await seedConfiguration();
    const owner = await actor(f);
    const initial = configurationUpdate(null, { name: "Initial" });
    const send = (request: unknown) =>
      configurationRequest(freshNonce(owner), request);
    expect(
      (
        await send(
          configurationUpdate(null, { pointsPerCurrencyUnit: "0.00001" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          configurationUpdate(null, {
            liabilityValuationCurrency: "USD",
            liabilityMinorUnitsNumerator: "1",
            liabilityPointsDenominator: "100",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send({
          ...initial,
          input: { ...initial.input, expectedInstallationGeneration: "old" },
        })
      ).status,
    ).toBe(409);
    const tampered = await signedRequest(
      { actor: freshNonce(owner), request: initial },
      (request, body) =>
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: body.replace("Initial", "Tampered"),
        }),
      "loyalty-configuration",
    );
    expect(tampered.status).toBe(401);
    expect(
      await database.weleticLoyaltyProgram.count({ where: { storeId: f.id } }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("authorizes signed settings reads/writes with explicit grants and rejects replay/revocation", async () => {
    const f = await seed();
    const owner = await actor(f);
    const staff = await actor(f, false);
    const read = () =>
      signedRequest(
        { actor: freshNonce(staff), request: { operation: "read", input: {} } },
        undefined,
        "settings",
      );
    expect((await read()).status).toBe(403);
    await grant(freshNonce(owner), 0, ["reviews.configure"]);
    expect((await read()).status).toBe(403);
    await grant(freshNonce(owner), 1, ["settings.configure"]);
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      storeId: f.id,
      revision: 0,
      capabilities: {
        settings: true,
        appearance: false,
        loyalty: false,
        reviews: false,
      },
    });
    const { merchantSettingsResponseSchema } = await import(
      "../../lib/weletic/merchant-settings/merchant-contract"
    );
    expect(merchantSettingsResponseSchema.safeParse(responseBody).success).toBe(
      true,
    );
    expect(
      await database.weleticMerchantSettings.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    const writer = freshNonce(staff);
    const value = {
      actor: writer,
      request: {
        operation: "update",
        input: {
          expectedRevision: 0,
          expectedInstallationGeneration: "generation-1",
          settings: {
            brandName: "Controlled settings",
            shopperEmailPaused: true,
          },
        },
      },
    };
    expect((await signedRequest(value, undefined, "settings")).status).toBe(
      403,
    );
    await grant(freshNonce(owner), 2, [
      "settings.configure",
      "appearance.configure",
    ]);
    // Denied write rolls back its nonce; retrying after an explicit grant works.
    expect((await signedRequest(value, undefined, "settings")).status).toBe(
      200,
    );
    expect((await signedRequest(value, undefined, "settings")).status).toBe(
      409,
    );
    expect(
      await database.weleticShopifyMerchantAction.findFirst({
        where: { storeId: f.id, requestId: writer.requestId },
      }),
    ).toMatchObject({
      permission: "settings.configure",
      shopifyUserId: "456",
      owner: false,
    });
    expect(
      await database.weleticMerchantSettings.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({ revision: 1, shopperEmailPaused: true });
    await grant(freshNonce(owner), 3, []);
    expect((await read()).status).toBe(403);
    expect(
      (
        await signedRequest(
          { ...value, actor: freshNonce(staff) },
          undefined,
          "settings",
        )
      ).status,
    ).toBe(403);
  });

  it("serializes competing signed settings updates so only one revision wins", async () => {
    const f = await seed();
    const owner = await actor(f);
    const responses = await Promise.all(
      ["First", "Second"].map((brandName) =>
        signedRequest(
          {
            actor: freshNonce(owner),
            request: {
              operation: "update",
              input: {
                expectedRevision: 0,
                expectedInstallationGeneration: "generation-1",
                settings: { brandName },
              },
            },
          },
          undefined,
          "settings",
        ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await database.weleticMerchantSettings.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({ revision: 1 });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id, permission: "settings.configure" },
      }),
    ).toBe(1);
  });
  it("requires reviews.configure for a module transition and preserves collection policy", async () => {
    const f = await seed();
    const owner = await actor(f);
    const staff = await actor(f, false);
    const previous = await database.weleticReviewSettings.create({
      data: {
        storeId: f.id,
        enabled: true,
        requestEmailEnabled: true,
        sendAfterDays: 21,
        expiresAfterDays: 45,
      },
    });
    const request = {
      operation: "review-module",
      input: {
        enabled: false,
        expectedUpdatedAt: previous.updatedAt.toISOString(),
        expectedInstallationGeneration: "generation-1",
      },
    };
    await grant(freshNonce(owner), 0, ["settings.configure"]);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(staff), request },
          undefined,
          "settings",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await database.weleticReviewSettings.findUniqueOrThrow({
          where: { storeId: f.id },
        })
      ).enabled,
    ).toBe(true);
    await grant(freshNonce(owner), 1, ["reviews.configure"]);
    const response = await signedRequest(
      { actor: freshNonce(staff), request },
      undefined,
      "settings",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "installationGeneration",
      "settings",
      "storeId",
    ]);
    expect(body.settings).toMatchObject({
      enabled: false,
      requestEmailEnabled: true,
    });
    const { reviewModuleResponseSchema } = await import(
      "../../lib/weletic/merchant-settings/merchant-contract"
    );
    expect(reviewModuleResponseSchema.safeParse(body).success).toBe(true);
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({
      enabled: false,
      requestEmailEnabled: true,
      sendAfterDays: 21,
      expiresAfterDays: 45,
    });
    expect(
      (
        await signedRequest(
          { actor: freshNonce(staff), request },
          undefined,
          "settings",
        )
      ).status,
    ).toBe(409);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.id, jobType: "REVIEW_SUMMARY_SYNC" },
      }),
    ).toBe(1);
  });

  it("rejects settings tampering and stale writes without retaining failed action receipts", async () => {
    const f = await seed();
    const owner = await actor(f);
    const request = {
      operation: "update",
      input: {
        expectedRevision: 99,
        expectedInstallationGeneration: "generation-1",
        settings: { brandName: "Invalid" },
      },
    };
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), request },
          undefined,
          "settings",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await signedRequest(
          {
            actor: freshNonce(owner),
            request: {
              ...request,
              input: {
                ...request.input,
                expectedRevision: 0,
                expectedInstallationGeneration: "old",
              },
            },
          },
          undefined,
          "settings",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), request },
          (original, body) =>
            new Request(original.url, {
              method: "POST",
              headers: original.headers,
              body: body.replace("Invalid", "Tampered"),
            }),
          "settings",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await signedRequest(
          {
            actor: freshNonce(owner),
            request: { operation: "read", input: { workspaceId: "foreign" } },
          },
          undefined,
          "settings",
        )
      ).status,
    ).toBe(400);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticMerchantSettings.count({
        where: { storeId: f.id },
      }),
    ).toBe(0);
  });

  it("serves actual customer projections only with current customers.read authority", async () => {
    const fixture = await seed();
    const other = await seed();
    const owner = await actor(fixture);
    const staff = await actor(fixture, false);
    const shopper = await database.weleticShopper.create({
      data: {
        id: `shopper_${randomUUID()}`,
        storeId: fixture.id,
        shopifyCustomerId: "111",
        email: "controlled@example.test",
      },
    });
    const foreign = await database.weleticShopper.create({
      data: {
        id: `shopper_${randomUUID()}`,
        storeId: other.id,
        shopifyCustomerId: "111",
        email: "foreign@example.test",
      },
    });
    const request = (input: unknown, profile = false) =>
      signedRequest(
        { actor: freshNonce(staff), input },
        undefined,
        profile ? "customer-profile" : "customers",
      );
    expect((await request({})).status).toBe(403);
    await grant(freshNonce(owner), 0, ["reviews.read"]);
    expect((await request({})).status).toBe(403);
    await grant(freshNonce(owner), 1, ["customers.read"]);
    const directory = await request({});
    expect(directory.status).toBe(200);
    const listed = await directory.json();
    const {
      merchantShopperDirectoryResponseSchema,
      merchantShopperProfileResponseSchema,
    } = await import("../../lib/weletic/shoppers/merchant-response");
    expect(
      merchantShopperDirectoryResponseSchema.safeParse(listed).success,
    ).toBe(true);
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([
      shopper.id,
    ]);
    expect(JSON.stringify(listed)).not.toContain("foreign@example.test");
    const result = await request({ shopperId: shopper.id }, true);
    expect(result.status).toBe(200);
    const profileData = await result.json();
    expect(
      merchantShopperProfileResponseSchema.safeParse(profileData).success,
    ).toBe(true);
    expect(profileData).toMatchObject({
      section: "overview",
      shopper: { id: shopper.id },
      loyalty: null,
    });
    const count = () =>
      database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      });
    const before = await count();
    expect((await request({ shopperId: foreign.id }, true)).status).toBe(404);
    expect(await count()).toBe(before); // failed data read rolls back the authorization receipt
    await grant(freshNonce(owner), 2, []);
    expect((await request({})).status).toBe(403);
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: { installationGeneration: "generation-2" },
    });
    expect((await request({})).status).toBe(401);
  });
  it("allows appearance-only staff without exposing or changing general settings", async () => {
    const f = await seed();
    const owner = await actor(f);
    const staff = await actor(f, false);
    await database.weleticMerchantSettings.create({
      data: {
        storeId: f.id,
        revision: 1,
        brandName: "Original",
        timeZone: "Asia/Tokyo",
        shopperEmailPaused: true,
      },
    });
    await grant(freshNonce(owner), 0, ["appearance.configure"]);
    const send = (operation: string, input: unknown = {}, asOwner = false) =>
      signedRequest(
        {
          actor: freshNonce(asOwner ? owner : staff),
          request: { operation, input },
        },
        undefined,
        "settings",
      );
    expect((await send("read")).status).toBe(403);
    const read = await send("appearance-read");
    expect(read.status).toBe(200);
    const view = await read.json();
    const { merchantAppearanceResponseSchema } = await import(
      "../../lib/weletic/merchant-settings/merchant-contract"
    );
    expect(merchantAppearanceResponseSchema.safeParse(view).success).toBe(true);
    expect(view.settings).toEqual({
      brandName: "Original",
      logoUrl: null,
      accentColor: null,
    });
    expect(view).not.toHaveProperty("modules");
    expect(view).not.toHaveProperty("capabilities");
    const input = {
      expectedRevision: 1,
      expectedInstallationGeneration: staff.installationGeneration,
      settings: { brandName: "Appearance" },
    };
    for (const settings of [
      { shopperEmailPaused: false },
      { timeZone: "UTC" },
      { defaultLocale: "en" },
      {},
    ])
      expect(
        (await send("appearance-update", { ...input, settings })).status,
      ).toBe(400);
    const saved = await send("appearance-update", input);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      revision: 2,
      settings: { brandName: "Appearance" },
    });
    expect(
      (
        await send(
          "update",
          { ...input, settings: { shopperEmailPaused: false } },
          true,
        )
      ).status,
    ).toBe(409);
    expect(
      await database.weleticMerchantSettings.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({
      revision: 2,
      brandName: "Appearance",
      timeZone: "Asia/Tokyo",
      shopperEmailPaused: true,
    });
    await grant(freshNonce(owner), 1, []);
    expect((await send("appearance-read")).status).toBe(403);
    expect(
      (await send("appearance-update", { ...input, expectedRevision: 2 }))
        .status,
    ).toBe(403);
  });
  it("requires loyalty.configure for signed module changes and retains exact policy", async () => {
    const f = await seed();
    const owner = await actor(f);
    const staff = await actor(f, false);
    await database.weleticLoyaltyProgram.create({
      data: {
        id: `program_${randomUUID()}`,
        storeId: f.id,
        status: "disabled",
        pointsExpiryDays: 7,
        liabilityValuationCurrency: "JPY",
        liabilityMinorUnitsNumerator: BigInt(1),
        liabilityPointsDenominator: BigInt(100),
      },
    });
    const request = {
      operation: "loyalty-module",
      input: {
        status: "active",
        expectedStatus: "disabled",
        expectedInstallationGeneration: staff.installationGeneration,
      },
    };
    const send = () =>
      signedRequest(
        { actor: freshNonce(staff), request },
        undefined,
        "settings",
      );
    await grant(freshNonce(owner), 0, [
      "settings.configure",
      "reviews.configure",
    ]);
    expect((await send()).status).toBe(403);
    await grant(freshNonce(owner), 1, ["loyalty.configure"]);
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      storeId: f.id,
      installationGeneration: staff.installationGeneration,
      settings: { status: "active", killSwitchActive: false },
    });
    expect((await send()).status).toBe(409);
    expect(
      await database.weleticLoyaltyProgram.findUnique({
        where: { storeId: f.id },
      }),
    ).toMatchObject({
      status: "active",
      pointsExpiryDays: 7,
      pointsExpiryPolicyVersion: 1,
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: BigInt(1),
      liabilityPointsDenominator: BigInt(100),
    });
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId: f.id },
      }),
    ).toBe(1);
  });

  it("filters actual privacy tombstones and rejects cross-store customer cursors", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const now = new Date();
    const first = await database.weleticShopper.create({
      data: {
        id: `shopper_z_${randomUUID()}`,
        storeId: fixture.id,
        shopifyCustomerId: "222",
        createdAt: now,
      },
    });
    await database.weleticShopper.create({
      data: {
        id: `shopper_a_${randomUUID()}`,
        storeId: fixture.id,
        shopifyCustomerId: "333",
        createdAt: now,
      },
    });
    const request = (input: unknown, profile = false) =>
      signedRequest(
        { actor: freshNonce(owner), input },
        undefined,
        profile ? "customer-profile" : "customers",
      );
    const initial = await request({ limit: 1 });
    expect(initial.status).toBe(200);
    const firstPage = await initial.json();
    expect(firstPage.items.map((item: { id: string }) => item.id)).toEqual([
      first.id,
    ]);
    expect(firstPage.pagination.nextCursor).toEqual(expect.any(String));
    const next = await request({
      limit: 1,
      cursor: firstPage.pagination.nextCursor,
    });
    expect(next.status).toBe(200);
    expect((await next.json()).items[0].id).not.toBe(first.id);
    const before = await database.weleticShopifyMerchantAction.count({
      where: { storeId: fixture.id },
    });
    expect(
      (
        await request({
          limit: 1,
          search: "changed",
          cursor: firstPage.pagination.nextCursor,
        })
      ).status,
    ).toBe(400);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(before);
    const { deriveAllShopifyCustomerPrivacyIdentities } = await import(
      "../../lib/weletic/shopify/privacy-identity"
    );
    const identity = deriveAllShopifyCustomerPrivacyIdentities({
      storeId: fixture.id,
      shopifyCustomerId: first.shopifyCustomerId,
    })[0];
    await database.weleticShopifyCustomerPrivacyTombstone.create({
      data: {
        id: `privacy_${randomUUID()}`,
        storeId: fixture.id,
        ...identity,
        shopperId: first.id,
        redactedAt: now,
        expiresAt: new Date(now.getTime() + 60000),
      },
    });
    expect(
      (await (await request({})).json()).items.map(
        (item: { id: string }) => item.id,
      ),
    ).not.toContain(first.id);
    expect((await request({ shopperId: first.id }, true)).status).toBe(404);
    const other = await seed();
    const otherOwner = await actor(other);
    expect(
      (
        await signedRequest(
          {
            actor: otherOwner,
            input: { limit: 1, cursor: firstPage.pagination.nextCursor },
          },
          undefined,
          "customers",
        )
      ).status,
    ).toBe(400);
  });

  it("lists only current-installation grants with scoped stable pagination", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const other = await seed();
    const otherOwner = await actor(other);
    const { replaceShopifyStaffGrantInTransaction } = await import(
      "../../lib/weletic/shopify/staff-grants"
    );
    for (const userId of ["456", "789", "999"]) {
      await database.$transaction((tx) =>
        replaceShopifyStaffGrantInTransaction({
          tx,
          envelope: freshNonce(owner),
          input: { userId, permissions: ["reviews.read"], expectedRevision: 0 },
        }),
      );
    }
    await grant(otherOwner, 0, ["loyalty.adjust"]);
    const { shopifyStaffGrantId } = await import(
      "../../lib/weletic/shopify/staff-authorization"
    );
    for (const alternate of [
      { ...owner, installationGeneration: "generation-old" },
      { ...owner, appId: "different-app" },
    ]) {
      await database.weleticShopifyStaffGrant.create({
        data: {
          id: shopifyStaffGrantId({ ...alternate, userId: "555" }),
          storeId: fixture.id,
          appId: alternate.appId,
          installationGeneration: alternate.installationGeneration,
          shopifyUserId: "555",
          permissions: ["loyalty.adjust"],
          revision: 1,
          updatedByShopifyUserId: "123",
        },
      });
    }
    const first = await signedRequest(
      { actor: freshNonce(owner), input: { limit: 2 } },
      undefined,
      true,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const page = await first.json();
    expect(page.grants).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await signedRequest(
      {
        actor: freshNonce(owner),
        input: { limit: 2, cursor: page.nextCursor },
      },
      undefined,
      true,
    );
    expect(second.status).toBe(200);
    const final = await second.json();
    expect(final.grants).toHaveLength(1);
    expect(final.nextCursor).toBeNull();
    expect(
      [...page.grants, ...final.grants]
        .map((row: { userId: string }) => row.userId)
        .sort(),
    ).toEqual(["456", "789", "999"]);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(otherOwner), input: { cursor: page.nextCursor } },
          undefined,
          true,
        )
      ).status,
    ).toBe(400);
    const staff = await actor(fixture, false);
    expect(
      (await signedRequest({ actor: staff, input: {} }, undefined, true))
        .status,
    ).toBe(403);
  });

  it("lists revoked and malformed grants without implying active authority", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    await grant(owner, 0, []);
    let result = await signedRequest(
      { actor: freshNonce(owner), input: {} },
      undefined,
      true,
    );
    expect((await result.json()).grants).toMatchObject([
      { userId: "456", status: "revoked", permissions: [] },
    ]);
    await database.weleticShopifyStaffGrant.updateMany({
      where: { storeId: fixture.id },
      data: { permissions: ["*"] },
    });
    result = await signedRequest(
      { actor: freshNonce(owner), input: {} },
      undefined,
      true,
    );
    expect((await result.json()).grants).toMatchObject([
      { userId: "456", status: "invalid", permissions: [] },
    ]);
    for (const data of [
      { permissions: ["reviews.read"], shopifyUserId: "0" },
      { shopifyUserId: "456", id: "f".repeat(64) },
    ]) {
      await database.weleticShopifyStaffGrant.updateMany({
        where: { storeId: fixture.id },
        data,
      });
      const invalid = await signedRequest(
        { actor: freshNonce(owner), input: {} },
        undefined,
        true,
      );
      expect((await invalid.json()).grants).toMatchObject([
        { status: "invalid", permissions: [] },
      ]);
    }
    const before = await database.weleticShopifyMerchantAction.count({
      where: { storeId: fixture.id },
    });
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), input: { cursor: "garbage" } },
          undefined,
          true,
        )
      ).status,
    ).toBe(400);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(before);
  });

  it("signed gateway commits one owner grant and rejects its replay", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const body = {
      actor: owner,
      input: {
        userId: "456",
        permissions: ["reviews.moderate"],
        expectedRevision: 0,
      },
    };
    const result = await signedRequest(body);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await result.json()).toEqual({
      grant: { userId: "456", permissions: ["reviews.moderate"], revision: 1 },
    });
    expect((await signedRequest(body)).status).toBe(409);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(1);
  });

  it("rejects signed-body tampering and unsigned actor headers before mutation", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const input = {
      userId: "456",
      permissions: ["reviews.read"],
      expectedRevision: 0,
    };
    const body = { actor: owner, input };
    const tampered = await signedRequest(
      body,
      (request) =>
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({
            ...body,
            actor: { ...owner, userId: "789", sessionId: `${owner.shop}_789` },
          }),
        }),
    );
    expect(tampered.status).toBe(401);
    const unsignedActor = await signedRequest({ input }, (request, raw) => {
      const headers = new Headers(request.headers);
      headers.set("x-weletic-actor", JSON.stringify(owner));
      return new Request(request.url, { method: "POST", body: raw, headers });
    });
    expect(unsignedActor.status).toBe(400);
    expect(
      (await signedRequest({ actor: { ...owner, accountOwner: true }, input }))
        .status,
    ).toBe(400);
    expect(
      await database.weleticShopifyStaffGrant.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(0);
  });

  it("signed service identity does not let staff grant access", async () => {
    const fixture = await seed();
    const staff = await actor(fixture, false);
    const result = await signedRequest({
      actor: staff,
      input: {
        userId: "789",
        expectedRevision: 0,
        permissions: ["reviews.read"],
      },
    });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "access_denied" });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(0);
  });
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  type Hooks = { attempted?: () => void; beforeCommit?: () => Promise<void> };
  async function authorize(
    envelope: ShopifyMerchantActorEnvelope,
    hooks: Hooks = {},
  ) {
    const { authorizeShopifyMerchantInTransaction } = await import(
      "../../lib/weletic/shopify/staff-authorization"
    );
    return database.$transaction(async (tx) => {
      const pending = authorizeShopifyMerchantInTransaction({
        tx,
        envelope,
        permission: "reviews.moderate",
      });
      hooks.attempted?.();
      const result = await pending;
      await hooks.beforeCommit?.();
      return result;
    });
  }
  async function grant(
    envelope: ShopifyMerchantActorEnvelope,
    expectedRevision: number,
    permissions: string[],
    hooks: Hooks = {},
  ) {
    const { replaceShopifyStaffGrantInTransaction } = await import(
      "../../lib/weletic/shopify/staff-grants"
    );
    return database.$transaction(async (tx) => {
      const pending = replaceShopifyStaffGrantInTransaction({
        tx,
        envelope,
        input: { userId: "456", expectedRevision, permissions },
      });
      hooks.attempted?.();
      const result = await pending;
      await hooks.beforeCommit?.();
      return result;
    });
  }

  it("purges staff privacy in bounded, rollback-safe, exact-store batches", async () => {
    const { purgeShopifyStaffPrivacyBatch } = await import(
      "../../lib/weletic/shopify/staff-privacy"
    );
    const fixture = await seed();
    const other = await seed();
    await grant(await actor(other), 0, ["reviews.read"]);
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: { complianceState: "frozen" },
    });
    await database.weleticShopifyStaffGrant.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        id: randomUUID(),
        storeId: fixture.id,
        appId: "staff-db-test",
        installationGeneration: "generation-1",
        shopifyUserId: String(i + 1),
        permissions: ["reviews.read"],
        updatedByShopifyUserId: "123",
      })),
    });
    await database.weleticShopifyMerchantAction.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        id: randomUUID(),
        storeId: fixture.id,
        appId: "staff-db-test",
        installationGeneration: "generation-1",
        requestId: String(i),
        shopifyUserId: "123",
        owner: true,
        permission: "staff.manage",
      })),
    });
    const purge = (rollback = false) =>
      database.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM WeleticShopifyStore WHERE id = ${fixture.id} FOR UPDATE`,
        );
        const result = await purgeShopifyStaffPrivacyBatch(tx, fixture.id);
        if (rollback) throw new Error("synthetic rollback");
        return result;
      });
    await expect(purge(true)).rejects.toThrow("synthetic rollback");
    expect(
      await database.weleticShopifyStaffGrant.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(101);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(101);
    await expect(purge()).resolves.toEqual({ pending: true });
    expect(
      await database.weleticShopifyStaffGrant.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(1);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(1);
    await expect(purge()).resolves.toEqual({ pending: true });
    await expect(purge()).resolves.toEqual({ pending: false });
    expect(
      await database.weleticShopifyStaffGrant.count({
        where: { storeId: other.id },
      }),
    ).toBe(1);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: other.id },
      }),
    ).toBe(1);
  });

  it("serves only native overview fields with a current exact permission", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const response = await signedRequest(
      { actor: owner, input: {} },
      undefined,
      "overview",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      shop: fixture.shop,
      canManageStaff: true,
      catalog: {
        products: 0,
        markets: 0,
        syncStatus: "pending",
        lastSyncAt: null,
      },
    });
    expect(
      (await signedRequest({ actor: owner, input: {} }, undefined, "overview"))
        .status,
    ).toBe(409);
    await grant(freshNonce(owner), 0, ["reviews.read"]);
    const staff = await actor(fixture, false);
    expect(
      (await signedRequest({ actor: staff, input: {} }, undefined, "overview"))
        .status,
    ).toBe(403);
    await grant(freshNonce(owner), 1, ["overview.read"]);
    const granted = await signedRequest(
      { actor: freshNonce(staff), input: {} },
      undefined,
      "overview",
    );
    expect(granted.status).toBe(200);
    expect((await granted.json()).canManageStaff).toBe(false);
    await grant(freshNonce(owner), 2, []);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(staff), input: {} },
          undefined,
          "overview",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), input: { shop: "other.myshopify.com" } },
          undefined,
          "overview",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), input: {} },
          (request) => {
            request.headers.delete("x-weletic-signature");
            return request;
          },
          "overview",
        )
      ).status,
    ).toBe(401);
  });

  it.each([false, true])(
    "rolls back moderation, authority, audit and outbox (legacy award: %s)",
    async (legacyAward) => {
      const fixture = await seed();
      const envelope = await actor(fixture);
      const reviewId = `${fixture.id}_moderation`;
      const requestId = `${fixture.id}_request`;
      const now = new Date();
      await database.weleticShopifyProduct.createMany({
        data: [
          {
            id: `${fixture.id}_product`,
            storeId: fixture.id,
            programId: `program_${fixture.id}`,
            externalId: "moderation-product",
            handle: "moderation-product",
            title: "Moderation product",
          },
        ],
      });
      // Minimal moderation fixture; no purchase or incentive validation is claimed.
      await database.weleticReviewRequest.createMany({
        data: [
          {
            id: requestId,
            storeId: fixture.id,
            orderId: `${fixture.id}_order`,
            productId: `${fixture.id}_product`,
            shopperId: `${fixture.id}_shopper`,
            fulfilledAt: now,
            sendAt: now,
            expiresAt: now,
          },
        ],
      });
      await database.weleticProductReview.createMany({
        data: [
          {
            id: reviewId,
            storeId: fixture.id,
            requestId,
            productId: `${fixture.id}_product`,
            shopperId: `${fixture.id}_shopper`,
            rating: 1,
            title: "Honest criticism",
            body: "A genuine review",
            displayName: "Buyer",
            status: "published",
            rewardStatus: legacyAward ? "awarded" : "pending",
          },
        ],
      });
      const accountId = `${fixture.id}_account`;
      const points = BigInt("9007199254740993");
      if (legacyAward) {
        // Historical ledger fixture, not a fabricated purchase-earning journey.
        // Most points were already spent: the exact reversal must go negative.
        await database.weleticLoyaltyAccount.createMany({
          data: [
            {
              id: accountId,
              storeId: fixture.id,
              programId: `${fixture.id}_loyalty_program`,
              shopperId: `${fixture.id}_shopper`,
              cachedPointsBalance: BigInt(7),
              lifetimePointsEarned: points,
              lifetimePointsRedeemed: points - BigInt(7),
              ledgerVersion: 2,
            },
          ],
        });
        await database.weleticPointsLedgerEntry.createMany({
          data: [
            {
              id: `${fixture.id}_award`,
              storeId: fixture.id,
              accountId,
              sequenceNumber: 1,
              entryType: "EARN_BONUS",
              pointsDelta: points,
              balanceAfter: points,
              referenceType: "REVIEW_NATIVE",
              referenceId: reviewId,
              idempotencyKey: `review:native:${fixture.id}:${reviewId}`,
            },
            {
              id: `${fixture.id}_spent`,
              storeId: fixture.id,
              accountId,
              sequenceNumber: 2,
              entryType: "REDEEM_REWARD",
              pointsDelta: BigInt(7) - points,
              balanceAfter: BigInt(7),
              idempotencyKey: `${fixture.id}_spent`,
            },
          ],
        });
      }
      const historicalRows = await database.weleticPointsLedgerEntry.findMany({
        where: { storeId: fixture.id },
        orderBy: { sequenceNumber: "asc" },
      });
      const accountBefore = await database.weleticLoyaltyAccount.findUnique({
        where: { id: accountId },
      });
      const { moderateReviewWithAuditInTransaction } = await import(
        "../../lib/weletic/reviews/moderation-audit"
      );
      const { withReviewMutation } = await import(
        "../../lib/weletic/reviews/transaction"
      );
      const { authorizeShopifyMerchantInTransaction } = await import(
        "../../lib/weletic/shopify/staff-authorization"
      );
      const run = (failAfterModeration: boolean) =>
        withReviewMutation(
          fixture.id,
          async (tx, generation) => {
            const authorized = await authorizeShopifyMerchantInTransaction({
              tx,
              envelope,
              permission: "reviews.moderate",
            });
            const result = await moderateReviewWithAuditInTransaction({
              tx,
              storeId: fixture.id,
              actor: {
                kind: "shopify",
                userId: authorized.shopifyUserId,
                appId: authorized.appId,
                installationGeneration: authorized.installationGeneration,
                merchantActionId: authorized.actionId,
              },
              input: { reviewId, version: 1, status: "hidden", reason: "spam" },
              generation,
            });
            if (failAfterModeration) throw new Error("synthetic audit failure");
            return result;
          },
          "generation-1",
        );
      await expect(run(true)).rejects.toThrow("synthetic audit failure");
      expect(
        await database.weleticPointsLedgerEntry.findMany({
          where: { storeId: fixture.id },
          orderBy: { sequenceNumber: "asc" },
        }),
      ).toEqual(historicalRows);
      expect(
        await database.weleticLoyaltyAccount.findUnique({
          where: { id: accountId },
        }),
      ).toEqual(accountBefore);
      expect(
        await database.weleticProductReview.findUnique({
          where: { id: reviewId },
        }),
      ).toMatchObject({
        status: "published",
        version: 1,
        rewardStatus: legacyAward ? "awarded" : "pending",
      });
      expect(
        await database.weleticReviewModerationAudit.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(0);
      expect(
        await database.weleticLoyaltyOutboxJob.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(0);
      expect(
        await database.weleticShopifyMerchantAction.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(0);
      await expect(run(false)).resolves.toMatchObject({
        status: "hidden",
        version: 2,
      });
      if (legacyAward) {
        const rows = await database.weleticPointsLedgerEntry.findMany({
          where: { storeId: fixture.id },
          orderBy: { sequenceNumber: "asc" },
        });
        expect(rows).toHaveLength(3);
        expect(rows.slice(0, 2)).toEqual(historicalRows);
        expect(rows[2]).toMatchObject({
          entryType: "REFUND_REVERSAL",
          pointsDelta: -points,
          balanceAfter: BigInt(7) - points,
          sequenceNumber: 3,
          referenceType: "REVIEW_NATIVE_CLAWBACK",
          referenceId: reviewId,
        });
        expect(
          await database.weleticLoyaltyAccount.findUnique({
            where: { id: accountId },
          }),
        ).toMatchObject({
          cachedPointsBalance: BigInt(7) - points,
          ledgerVersion: 3,
          lifetimePointsEarned: points,
          lifetimePointsRedeemed: points - BigInt(7),
        });
        expect(
          await database.weleticProductReview.findUnique({
            where: { id: reviewId },
          }),
        ).toMatchObject({ rewardStatus: "reversed" });
        expect(
          await database.weleticLoyaltyOutboxJob.count({
            where: { storeId: fixture.id, jobType: "TIER_REVIEW" },
          }),
        ).toBe(1);
      }
      expect(
        await database.weleticReviewModerationAudit.findMany({
          where: { storeId: fixture.id },
        }),
      ).toEqual([
        expect.objectContaining({
          actorKind: "shopify",
          actorUserId: "123",
          fromVersion: 1,
          toVersion: 2,
          reasonCode: "spam",
        }),
      ]);
      expect(
        await database.weleticLoyaltyOutboxJob.count({
          where: { storeId: fixture.id, jobType: "REVIEW_SUMMARY_SYNC" },
        }),
      ).toBe(1);
      expect(
        await database.weleticShopifyMerchantAction.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(1);
      const snapshot = () =>
        Promise.all([
          database.weleticLoyaltyAccount.findUnique({
            where: { id: accountId },
          }),
          database.weleticPointsLedgerEntry.findMany({
            where: { storeId: fixture.id },
            orderBy: { sequenceNumber: "asc" },
          }),
          database.weleticProductReview.findUnique({ where: { id: reviewId } }),
          database.weleticReviewModerationAudit.findMany({
            where: { storeId: fixture.id },
            orderBy: { id: "asc" },
          }),
          database.weleticLoyaltyOutboxJob.findMany({
            where: { storeId: fixture.id },
            orderBy: { id: "asc" },
          }),
          database.weleticShopifyMerchantAction.findMany({
            where: { storeId: fixture.id },
            orderBy: { id: "asc" },
          }),
        ]);
      const committed = await snapshot();
      await expect(run(false)).rejects.toMatchObject({
        code: "request_replayed",
      });
      expect(await snapshot()).toEqual(committed);
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(legacyAward ? 3 : 0);
      expect(
        await database.weleticProductReview.findUnique({
          where: { id: reviewId },
        }),
      ).toMatchObject({ status: "hidden", version: 2 });
      if (legacyAward) {
        const { purgeNativeReviewsBatch } = await import(
          "../../lib/weletic/reviews/privacy"
        );
        await expect(purgeNativeReviewsBatch(fixture.id)).rejects.toThrow(
          "Review purge requires a frozen store",
        );
        expect(await snapshot()).toEqual(committed);
        await database.weleticShopifyStore.update({
          where: { id: fixture.id },
          data: { complianceState: "frozen" },
        });
        // Audit children are drained before review parents, without deleting
        // the retained account or financial ledger created above.
        await expect(purgeNativeReviewsBatch(fixture.id)).resolves.toEqual({
          hasMore: true,
        });
        expect(
          await database.weleticReviewModerationAudit.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        expect(
          await database.weleticProductReview.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(1);
        await expect(purgeNativeReviewsBatch(fixture.id)).resolves.toEqual({
          hasMore: false,
        });
        expect(
          await database.weleticProductReview.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        expect(
          await database.weleticReviewRequest.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        const afterPurge = await snapshot();
        for (const index of [0, 1, 4, 5])
          expect(afterPurge[index]).toEqual(committed[index]);
      }
    },
  );

  it("authorizes signed moderation and commits only one competing expected version", async () => {
    const fixture = await seed();
    const other = await seed();
    const owner = await actor(fixture);
    const staff = await actor(fixture, false);
    const otherOwner = await actor(other);
    const reviewId = `${fixture.id}_gateway_review`;
    await database.weleticShopifyProduct.createMany({
      data: [
        {
          id: `${fixture.id}_product`,
          storeId: fixture.id,
          programId: `program_${fixture.id}`,
          externalId: "gateway-product",
          handle: "gateway-product",
          title: "Gateway product",
        },
      ],
    });
    await database.weleticReviewRequest.createMany({
      data: [
        {
          id: `${reviewId}_request`,
          storeId: fixture.id,
          orderId: `${fixture.id}_order`,
          productId: `${fixture.id}_product`,
          shopperId: `${fixture.id}_shopper`,
          fulfilledAt: new Date(),
          sendAt: new Date(),
          expiresAt: new Date(),
        },
      ],
    });
    await database.weleticProductReview.createMany({
      data: [
        {
          id: reviewId,
          storeId: fixture.id,
          requestId: `${reviewId}_request`,
          productId: `${fixture.id}_product`,
          shopperId: `${fixture.id}_shopper`,
          status: "hidden",
          rating: 1,
          title: "Review",
          body: "Honest criticism",
          displayName: "Buyer",
        },
      ],
    });
    const input = {
      reviewId,
      version: 1,
      merchantReply: "Thank you",
      reason: "merchant_reply",
    };
    const request = (
      envelope: ShopifyMerchantActorEnvelope,
      patch: unknown = input,
    ) =>
      signedRequest(
        { actor: freshNonce(envelope), input: patch },
        undefined,
        "moderate",
      );
    expect((await request(staff)).status).toBe(403);
    await grant(freshNonce(owner), 0, ["reviews.read"]);
    expect((await request(staff)).status).toBe(403);
    expect((await request(otherOwner)).status).toBe(404);
    expect((await request(owner, { ...input, owner: true })).status).toBe(400);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), input },
          (req) => {
            req.headers.delete("x-weletic-signature");
            return req;
          },
          "moderate",
        )
      ).status,
    ).toBe(401);
    expect(
      await database.weleticReviewModerationAudit.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(0);
    await grant(freshNonce(owner), 1, ["reviews.moderate"]);
    const outcomes = await Promise.all([request(staff), request(staff)]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    const success = outcomes.find((r) => r.status === 200)!;
    expect(success.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await success.json()).toMatchObject({
      reviewId,
      version: 2,
      status: "hidden",
    });
    expect(
      await database.weleticReviewModerationAudit.findMany({
        where: { storeId: fixture.id },
      }),
    ).toEqual([
      expect.objectContaining({
        actorUserId: "456",
        reasonCode: "merchant_reply",
        toVersion: 2,
      }),
    ]);
    // Unicode maximum-length fields fit the explicit 32KB signed-body limit.
    expect(
      (
        await request(staff, {
          ...input,
          version: 2,
          reason: "other",
          reasonDetails: "字".repeat(1000),
          merchantReply: "字".repeat(5000),
        })
      ).status,
    ).toBe(200);
    await grant(freshNonce(owner), 2, []);
    expect((await request(staff, { ...input, version: 3 })).status).toBe(403);
    expect(
      await database.weleticReviewModerationAudit.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(2);
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: reviewId },
      }),
    ).toMatchObject({ version: 3, moderatedByUserId: null });
  });

  it.each(["moderate", "freeze", "reinstall"] as const)(
    "fences audited moderation behind an observed %s transaction",
    async (transition) => {
      const fixture = await seed();
      const owner = await actor(fixture);
      const reviewId = `${fixture.id}_locked_review`;
      await database.weleticShopifyProduct.createMany({
        data: [
          {
            id: `${fixture.id}_product`,
            storeId: fixture.id,
            programId: `${fixture.id}_program`,
            externalId: "locked-product",
            handle: "locked-product",
            title: "Locked product",
          },
        ],
      });
      await database.weleticReviewRequest.createMany({
        data: [
          {
            id: `${reviewId}_request`,
            storeId: fixture.id,
            orderId: `${fixture.id}_order`,
            productId: `${fixture.id}_product`,
            shopperId: `${fixture.id}_shopper`,
            fulfilledAt: new Date(),
            sendAt: new Date(),
            expiresAt: new Date(),
          },
        ],
      });
      await database.weleticProductReview.createMany({
        data: [
          {
            id: reviewId,
            storeId: fixture.id,
            requestId: `${reviewId}_request`,
            productId: `${fixture.id}_product`,
            shopperId: `${fixture.id}_shopper`,
            rating: 1,
            title: "Criticism",
            body: "Synthetic content",
            displayName: "Buyer",
            status: "published",
          },
        ],
      });
      const { assertShopifyStoreAcceptsOperationalWrites } = await import(
        "../../lib/weletic/shopify/store-compliance-state"
      );
      const { authorizeShopifyMerchantInTransaction } = await import(
        "../../lib/weletic/shopify/staff-authorization"
      );
      const { moderateReviewWithAuditInTransaction } = await import(
        "../../lib/weletic/reviews/moderation-audit"
      );
      const held = barrier();
      const release = barrier();
      const started = barrier();
      let secondConnection: bigint | number | undefined;
      const originalReview =
        await database.weleticProductReview.findUniqueOrThrow({
          where: { id: reviewId },
        });
      const installation =
        await database.installedIntegration.findUniqueOrThrow({
          where: { id: fixture.installationId },
        });
      // Real production fence/auth/mutation functions in the same Serializable
      // boundary as withReviewMutation. Hooks only control commit timing.
      const run = (first: boolean) =>
        database.$transaction(
          async (tx) => {
            if (first && transition !== "moderate") {
              // Controlled lifecycle fixture transition, holding the same store
              // row as production fencing. Not a full reinstall/erasure worker.
              await tx.weleticShopifyStore.update({
                where: { id: fixture.id },
                data:
                  transition === "freeze"
                    ? { complianceState: "frozen" }
                    : { installationGeneration: "generation-2" },
              });
              if (transition === "reinstall") {
                await tx.installedIntegration.update({
                  where: { id: fixture.installationId },
                  data: {
                    credentials: {
                      ...(installation.credentials as Prisma.JsonObject),
                      installationGeneration: "generation-2",
                    },
                  },
                });
              }
              held.release();
              await release.promise;
              return null;
            }
            if (!first) {
              const [connection] = await tx.$queryRaw<
                Array<{ id: bigint | number }>
              >`SELECT CONNECTION_ID() AS id`;
              secondConnection = connection.id;
              started.release();
            }
            const store = await assertShopifyStoreAcceptsOperationalWrites({
              tx,
              storeId: fixture.id,
              action: "native_reviews",
              expectedInstallationGeneration: "generation-1",
            });
            const authorized = await authorizeShopifyMerchantInTransaction({
              tx,
              envelope: freshNonce(owner),
              permission: "reviews.moderate",
            });
            const result = await moderateReviewWithAuditInTransaction({
              tx,
              storeId: fixture.id,
              generation: store?.installationGeneration ?? null,
              actor: {
                kind: "shopify",
                userId: authorized.shopifyUserId,
                appId: authorized.appId,
                installationGeneration: authorized.installationGeneration,
                merchantActionId: authorized.actionId,
              },
              input: {
                reviewId,
                version: 1,
                status: "hidden",
                reason: "other",
                reasonDetails: first ? "Winning change" : "Stale change",
              },
            });
            if (first) {
              held.release();
              await release.promise;
            }
            return result;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10_000,
          },
        );
      const first = run(true);
      // Attach handlers immediately, including when a setup assertion fails.
      const firstOutcome = first.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error("First transaction did not hold");
        }),
      ]);
      const second = run(false);
      const secondOutcome = second.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let observedLockState: Record<string, unknown> = {};
      try {
        await Promise.race([
          started.promise,
          second.then(() => {
            throw new Error("Second transaction did not start");
          }),
        ]);
        // Observe only our exact test connection. Explicit SELECT aliases avoid
        // the unnamed f0/f1 columns Prisma returns for SHOW FULL PROCESSLIST.
        await expect
          .poll(
            async () => {
              const processes = await database.$queryRaw<
                Array<{ statementInfo: string | null }>
              >`SELECT INFO AS statementInfo FROM information_schema.PROCESSLIST WHERE ID = ${secondConnection}`;
              const connection = processes[0];
              observedLockState = {
                columns: Object.keys(processes[0] ?? {}),
                connectionFound: Boolean(connection),
                infoPresent: Boolean(connection?.statementInfo),
                hasStore: connection?.statementInfo?.includes(
                  "WeleticShopifyStore",
                ),
                hasLock: /FOR UPDATE/i.test(connection?.statementInfo ?? ""),
              };
              return Boolean(
                connection?.statementInfo?.includes("WeleticShopifyStore") &&
                  /FOR UPDATE/i.test(connection.statementInfo),
              );
            },
            { timeout: 3000, interval: 20 },
          )
          .toBe(true);
      } catch (error) {
        throw new Error(
          `Lock observation failed: ${JSON.stringify(observedLockState)}`,
          { cause: error },
        );
      } finally {
        release.release();
        await Promise.all([firstOutcome, secondOutcome]);
      }
      if (transition !== "moderate") {
        expect(await firstOutcome).toEqual({ value: null });
        expect(await secondOutcome).toMatchObject({
          error: {
            name: "ShopifyStoreOperationalWritesBlockedError",
            complianceState:
              transition === "freeze"
                ? "frozen"
                : "stale_installation_generation",
          },
        });
        expect(
          await database.weleticProductReview.findUnique({
            where: { id: reviewId },
          }),
        ).toEqual(originalReview);
        expect(
          await database.weleticReviewModerationAudit.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        expect(
          await database.weleticShopifyMerchantAction.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        expect(
          await database.weleticLoyaltyOutboxJob.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        expect(
          await database.weleticPointsLedgerEntry.count({
            where: { storeId: fixture.id },
          }),
        ).toBe(0);
        return;
      }
      expect(await firstOutcome).toMatchObject({
        value: { reviewId, version: 2, status: "hidden" },
      });
      expect(await secondOutcome).toMatchObject({
        error: { code: "conflict" },
      });
      expect(
        await database.weleticProductReview.findUnique({
          where: { id: reviewId },
        }),
      ).toMatchObject({ version: 2, status: "hidden" });
      expect(
        await database.weleticReviewModerationAudit.findMany({
          where: { storeId: fixture.id },
        }),
      ).toEqual([
        expect.objectContaining({
          fromVersion: 1,
          toVersion: 2,
          reasonDetails: "Winning change",
        }),
      ]);
      expect(
        await database.weleticShopifyMerchantAction.count({
          where: { storeId: fixture.id },
        }),
      ).toBe(1);
      expect(
        await database.weleticLoyaltyOutboxJob.count({
          where: { storeId: fixture.id, jobType: "REVIEW_SUMMARY_SYNC" },
        }),
      ).toBe(1);
    },
  );

  it("exports all moderation audit pages for only the requested store and shopper", async () => {
    const fixture = await seed();
    const otherStore = await seed();
    const subjects = [
      {
        id: `${fixture.id}_target`,
        storeId: fixture.id,
        shopifyCustomerId: "789",
      },
      {
        id: `${fixture.id}_other`,
        storeId: fixture.id,
        shopifyCustomerId: "790",
      },
      {
        id: `${otherStore.id}_target`,
        storeId: otherStore.id,
        shopifyCustomerId: "789",
      },
    ];
    await database.weleticShopper.createMany({ data: subjects });
    await database.weleticShopifyProduct.createMany({
      data: [fixture, otherStore].map((store) => ({
        id: `${store.id}_product`,
        storeId: store.id,
        programId: `${store.id}_program`,
        externalId: "export-product",
        handle: "export-product",
        title: "Export product",
      })),
    });
    await database.weleticReviewRequest.createMany({
      data: subjects.map((subject) => ({
        id: `${subject.id}_request`,
        storeId: subject.storeId,
        shopperId: subject.id,
        productId: `${subject.storeId}_product`,
        orderId: `${subject.id}_order`,
        fulfilledAt: new Date(),
        sendAt: new Date(),
        expiresAt: new Date(),
      })),
    });
    // Content-only export fixtures; no verified purchase or award is claimed.
    await database.weleticProductReview.createMany({
      data: subjects.map((subject) => ({
        id: `${subject.id}_review`,
        storeId: subject.storeId,
        shopperId: subject.id,
        requestId: `${subject.id}_request`,
        productId: `${subject.storeId}_product`,
        status: "hidden",
        version: 103,
        rating: 1,
        title: "Review",
        body: "Synthetic feedback",
        displayName: "Buyer",
      })),
    });
    const expectedIds = Array.from(
      { length: 101 },
      (_, i) => `${subjects[0].id}_audit_${String(i).padStart(3, "0")}`,
    );
    const rows: Prisma.WeleticReviewModerationAuditCreateManyInput[] =
      subjects.flatMap((subject, index) =>
        Array.from({ length: index === 0 ? 101 : 1 }, (_, i) => ({
          id: `${subject.id}_audit_${String(i).padStart(3, "0")}`,
          storeId: subject.storeId,
          reviewId: `${subject.id}_review`,
          actorKind: "shopify",
          actorUserId: "123",
          appId: "staff-db-test",
          installationGeneration: "generation-1",
          merchantActionId: "b".repeat(64),
          reasonCode: "other",
          reasonDetails: `Explanation ${subject.id} ${i}`,
          fromVersion: i + 1,
          toVersion: i + 2,
          fromStatus: "hidden",
          toStatus: "hidden",
          replyChanged: true,
        })),
      );
    await database.weleticReviewModerationAudit.createMany({ data: rows });
    const { getShopperDataExport } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    const exported = await getShopperDataExport({
      storeId: fixture.id,
      shopifyCustomerId: "789",
    });
    expect(exported?.shopperId).toBe(subjects[0].id);
    expect(exported?.reviewModerationAudits.map((row) => row.id)).toEqual(
      expectedIds,
    );
    expect(
      new Set(exported?.reviewModerationAudits.map((row) => row.id)).size,
    ).toBe(101);
    expect(exported?.exportCompleteness).toMatchObject({
      complete: true,
      internallyPaginated: true,
      pageSize: 100,
    });
    for (const row of exported!.reviewModerationAudits) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "id",
          "reviewId",
          "reasonCode",
          "reasonDetails",
          "fromVersion",
          "toVersion",
          "fromStatus",
          "toStatus",
          "replyChanged",
          "createdAt",
          "redactedAt",
        ].sort(),
      );
      expect(row.reviewId).toBe(`${subjects[0].id}_review`);
    }
    expect(exported?.reviewModerationAudits[100]).toMatchObject({
      fromVersion: 101,
      toVersion: 102,
      reasonDetails: `Explanation ${subjects[0].id} 100`,
    });
    const otherExport = await getShopperDataExport({
      storeId: otherStore.id,
      shopifyCustomerId: "789",
    });
    expect(otherExport?.reviewModerationAudits.map((row) => row.id)).toEqual([
      `${subjects[2].id}_audit_000`,
    ]);
    const neighborExport = await getShopperDataExport({
      storeId: fixture.id,
      shopifyCustomerId: "790",
    });
    expect(neighborExport?.reviewModerationAudits.map((row) => row.id)).toEqual(
      [`${subjects[1].id}_audit_000`],
    );
    await expect(
      getShopperDataExport({
        storeId: otherStore.id,
        shopifyCustomerId: "790",
      }),
    ).resolves.toBeNull();
    expect(
      await database.weleticReviewModerationAudit.count({
        where: { storeId: { in: [fixture.id, otherStore.id] } },
      }),
    ).toBe(103);
    const untouchedBefore =
      await database.weleticReviewModerationAudit.findMany({
        where: { id: { in: [rows[101].id, rows[102].id] } },
        orderBy: { id: "asc" },
      });
    // Freeze only this synthetic store to satisfy the privacy helper's caller
    // precondition. This is not a full compliance-worker erasure journey.
    await database.weleticShopifyStore.update({
      where: { id: fixture.id },
      data: { complianceState: "frozen" },
    });
    const { redactNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    for (let page = 0; page < 6; page++) {
      await expect(
        redactNativeReviewsBatch(fixture.id, subjects[0].id),
      ).resolves.toEqual({ hasMore: page < 5 });
    }
    const redactedExport = await getShopperDataExport({
      storeId: fixture.id,
      shopifyCustomerId: "789",
    });
    expect(redactedExport?.reviewModerationAudits.map((row) => row.id)).toEqual(
      expectedIds,
    );
    expect(
      redactedExport?.reviewModerationAudits.every(
        (row) => row.reasonDetails === null && row.redactedAt instanceof Date,
      ),
    ).toBe(true);
    expect(redactedExport?.nativeReviews).toEqual([
      expect.objectContaining({ status: "redacted", body: "", title: "" }),
    ]);
    expect(
      await database.weleticReviewModerationAudit.findMany({
        where: { id: { in: [rows[101].id, rows[102].id] } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(untouchedBefore);
  });

  it("drains audit privacy pages after review redaction without crossing shoppers", async () => {
    const fixture = await seed();
    const target = `${fixture.id}_target`;
    const other = `${fixture.id}_other`;
    await database.weleticProductReview.createMany({
      data: [target, other].map((shopperId) => ({
        id: `${shopperId}_review`,
        storeId: fixture.id,
        shopperId,
        requestId: `${shopperId}_request`,
        productId: `${fixture.id}_product`,
        status: "redacted",
        version: 23,
        rating: 1,
        title: "",
        body: "",
        displayName: "Redacted customer",
      })),
    });
    await database.weleticReviewModerationAudit.createMany({
      data: [target, other].flatMap((shopperId) =>
        Array.from({ length: shopperId === target ? 21 : 1 }, (_, i) => ({
          id: `${shopperId}_audit_${String(i).padStart(2, "0")}`,
          storeId: fixture.id,
          reviewId: `${shopperId}_review`,
          actorKind: "shopify",
          actorUserId: "123",
          merchantActionId: "a".repeat(64),
          reasonCode: "other",
          reasonDetails: "Private explanation",
          fromVersion: i + 1,
          toVersion: i + 2,
          fromStatus: "hidden",
          toStatus: "hidden",
          replyChanged: false,
        })),
      ),
    });
    const { redactNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await expect(redactNativeReviewsBatch(fixture.id, target)).resolves.toEqual(
      { hasMore: true },
    );
    expect(
      await database.weleticReviewModerationAudit.count({
        where: {
          storeId: fixture.id,
          reviewId: `${target}_review`,
          redactedAt: null,
        },
      }),
    ).toBe(1);
    await expect(redactNativeReviewsBatch(fixture.id, target)).resolves.toEqual(
      { hasMore: false },
    );
    const rows = await database.weleticReviewModerationAudit.findMany({
      where: { storeId: fixture.id },
    });
    expect(rows.filter((row) => row.reviewId === `${target}_review`)).toEqual(
      Array.from({ length: 21 }, () =>
        expect.objectContaining({
          reasonDetails: null,
          actorUserId: null,
          merchantActionId: null,
          redactedAt: expect.any(Date),
        }),
      ),
    );
    expect(
      rows.find((row) => row.reviewId === `${other}_review`),
    ).toMatchObject({
      reasonDetails: "Private explanation",
      actorUserId: "123",
      redactedAt: null,
    });
  });

  it("reads a scoped review inbox through the signed route and actual transaction", async () => {
    const fixture = await seed();
    const other = await seed();
    const owner = await actor(fixture);
    const otherOwner = await actor(other);
    const product = `${fixture.id}_product`;
    const otherProduct = `${other.id}_product`;
    // Read fixtures only: no purchase validation, incentives or sends are invoked.
    await database.weleticShopifyProduct.createMany({
      data: [fixture, other].map((store) => ({
        id: `${store.id}_product`,
        storeId: store.id,
        programId: `program_${store.id}`,
        externalId: "product-1",
        handle: "fixture-product",
        title: `Product ${store.id}`,
      })),
    });
    const createdAt = new Date("2026-09-01T00:00:00Z");
    await database.weleticShopper.createMany({
      data: [fixture, other].map((store) => ({
        id: `shopper_${store.id}`,
        storeId: store.id,
        shopifyCustomerId: "789",
      })),
    });
    // Required review parents are real fixture rows; the deliberately corrupt
    // product reference below remains separate from purchase validation.
    await database.weleticReviewRequest.createMany({
      data: [
        { id: `${fixture.id}_review_b`, storeId: fixture.id },
        { id: `${fixture.id}_review_a`, storeId: fixture.id },
        { id: `${other.id}_review`, storeId: other.id },
        { id: `${fixture.id}_corrupt_product`, storeId: fixture.id },
      ].map((item) => ({
        id: `request_${item.id}`,
        storeId: item.storeId,
        shopperId: `shopper_${item.storeId}`,
        productId: `${item.storeId}_product`,
        orderId: `order_${item.id}`,
        fulfilledAt: createdAt,
        sendAt: createdAt,
        expiresAt: new Date("2026-10-01T00:00:00Z"),
      })),
    });
    await database.weleticProductReview.createMany({
      data: [
        {
          id: `${fixture.id}_review_b`,
          storeId: fixture.id,
          productId: product,
        },
        {
          id: `${fixture.id}_review_a`,
          storeId: fixture.id,
          productId: product,
        },
        {
          id: `${other.id}_review`,
          storeId: other.id,
          productId: otherProduct,
        },
        {
          id: `${fixture.id}_corrupt_product`,
          storeId: fixture.id,
          productId: otherProduct,
        },
      ].map((item) => ({
        ...item,
        requestId: `request_${item.id}`,
        shopperId: `shopper_${item.storeId}`,
        status: "hidden",
        rating: 1,
        title: "Honest criticism",
        body: "A genuine low-rating review",
        displayName: "Buyer",
        rewardStatus: "awarded",
        incentivized: true,
        createdAt,
      })),
    });
    const read = (envelope: ShopifyMerchantActorEnvelope, input: unknown) =>
      signedRequest({ actor: envelope, input }, undefined, "reviews");
    const response = await read(owner, {
      view: "reviews",
      limit: 1,
      rating: 1,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const first = await response.json();
    expect(first.items.map((item: { id: string }) => item.id)).toEqual([
      `${fixture.id}_review_b`,
    ]);
    expect(first.items[0]).toMatchObject({
      rating: 1,
      status: "hidden",
      rewardStatus: "awarded",
    });
    expect((await read(owner, { view: "reviews" })).status).toBe(409);
    const next = await read(freshNonce(owner), {
      view: "reviews",
      rating: 1,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(await next.json()).toMatchObject({
      items: [{ id: `${fixture.id}_review_a` }],
      nextCursor: null,
    });
    expect(
      (
        await read(freshNonce(otherOwner), {
          view: "reviews",
          rating: 1,
          cursor: first.nextCursor,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await read(freshNonce(owner), {
          view: "reviews",
          rating: 5,
          cursor: first.nextCursor,
        })
      ).status,
    ).toBe(400);
    const staff = await actor(fixture, false);
    await grant(freshNonce(owner), 0, ["reviews.moderate"]);
    expect((await read(staff, { view: "reviews" })).status).toBe(403);
    await grant(freshNonce(owner), 1, ["reviews.read"]);
    expect((await read(freshNonce(staff), { view: "reviews" })).status).toBe(
      200,
    );
    await grant(freshNonce(owner), 2, []);
    expect((await read(freshNonce(staff), { view: "reviews" })).status).toBe(
      403,
    );
    expect(
      (await read(freshNonce(owner), { view: "requests", storeId: other.id }))
        .status,
    ).toBe(400);
    expect(
      (
        await signedRequest(
          { actor: freshNonce(owner), input: { view: "reviews" } },
          (request) => {
            request.headers.delete("x-weletic-signature");
            return request;
          },
          "reviews",
        )
      ).status,
    ).toBe(401);
  });

  it("exports retained staff data in owner-only scoped pages without credentials", async () => {
    const fixture = await seed();
    const other = await seed();
    const owner = await actor(fixture);
    await grant(freshNonce(owner), 0, ["reviews.read"]);
    await grant(await actor(other), 0, ["reviews.read"]);
    await database.weleticShopifyStaffGrant.create({
      data: {
        id: randomUUID(),
        storeId: fixture.id,
        appId: "staff-db-test",
        installationGeneration: "old-generation",
        shopifyUserId: "789",
        permissions: [],
        revision: 1,
        updatedByShopifyUserId: "123",
      },
    });
    const past = new Date("2026-01-01T00:00:00.000Z");
    await database.weleticShopifyStaffGrant.create({
      data: {
        id: randomUUID(),
        storeId: fixture.id,
        appId: "other-app",
        installationGeneration: "generation-1",
        shopifyUserId: "999",
        permissions: [],
        revision: 1,
        updatedByShopifyUserId: "123",
      },
    });
    await database.weleticShopifyStaffGrant.updateMany({
      where: { storeId: fixture.id },
      data: { createdAt: past },
    });
    await database.weleticShopifyMerchantAction.updateMany({
      where: { storeId: fixture.id },
      data: { createdAt: past },
    });
    const request = {
      actor: freshNonce(owner),
      input: { kind: "grants", limit: 1 },
    };
    const first = await signedRequest(request, undefined, "export");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const page = await first.json();
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect((await signedRequest(request, undefined, "export")).status).toBe(
      409,
    );
    const second = await signedRequest(
      {
        actor: freshNonce(owner),
        input: { kind: "grants", limit: 1, cursor: page.nextCursor },
      },
      undefined,
      "export",
    );
    const next = await second.json();
    expect(next.rows).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(next.createdBefore).toBe(page.createdBefore);
    expect(
      [...page.rows, ...next.rows].map((row) => row.shopifyUserId).sort(),
    ).toEqual(["456", "789"]);
    expect(
      [...page.rows, ...next.rows].some(
        (row) => row.installationGeneration === "old-generation",
      ),
    ).toBe(true);
    expect(
      (
        await signedRequest(
          {
            actor: await actor(other),
            input: { kind: "grants", cursor: page.nextCursor },
          },
          undefined,
          "export",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await signedRequest(
          {
            actor: freshNonce(owner),
            input: { kind: "actions", cursor: page.nextCursor },
          },
          undefined,
          "export",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await signedRequest(
          { actor: await actor(fixture, false), input: { kind: "actions" } },
          undefined,
          "export",
        )
      ).status,
    ).toBe(403);
    const actions = await signedRequest(
      { actor: freshNonce(owner), input: { kind: "actions" } },
      undefined,
      "export",
    );
    expect(actions.status).toBe(200);
    const exported = await actions.json();
    const { shopifyStaffExportResponseSchema } = await import(
      "../../lib/weletic/shopify/staff-export-contract"
    );
    for (const output of [page, next, exported])
      expect(shopifyStaffExportResponseSchema.safeParse(output).success).toBe(
        true,
      );
    const firstAuditPage = await signedRequest(
      { actor: freshNonce(owner), input: { kind: "actions", limit: 1 } },
      undefined,
      "export",
    );
    let auditPage = await firstAuditPage.json();
    const boundary = new Date(auditPage.createdBefore);
    const expectedIds = (
      await database.weleticShopifyMerchantAction.findMany({
        where: {
          storeId: fixture.id,
          appId: "staff-db-test",
          createdAt: { lt: boundary },
        },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((row) => row.id);
    const observedIds: string[] = [];
    for (let pages = 0; pages < 50; pages++) {
      observedIds.push(...auditPage.rows.map((row: { id: string }) => row.id));
      if (!auditPage.nextCursor) break;
      const response = await signedRequest(
        {
          actor: freshNonce(owner),
          input: { kind: "actions", limit: 1, cursor: auditPage.nextCursor },
        },
        undefined,
        "export",
      );
      expect(response.status).toBe(200);
      auditPage = await response.json();
      expect(auditPage.createdBefore).toBe(boundary.toISOString());
    }
    expect(auditPage.nextCursor).toBeNull();
    expect(observedIds).toEqual(expectedIds);
    expect(
      exported.rows.some(
        (row: { targetShopifyUserId: string }) =>
          row.targetShopifyUserId === "456",
      ),
    ).toBe(true);
    for (const row of exported.rows) {
      expect(row).not.toHaveProperty("requestId");
      expect(row).not.toHaveProperty("sessionDigest");
      expect(row).not.toHaveProperty("payload");
      expect(row).not.toHaveProperty("accessToken");
    }
    expect(JSON.stringify(exported)).not.toContain("synthetic-offline");
  });

  it("consumes a competing nonce exactly once", async () => {
    const fixture = await seed();
    const envelope = await actor(fixture);
    const locked = barrier();
    const release = barrier();
    const attempted = barrier();
    const first = authorize(envelope, {
      beforeCommit: async () => {
        locked.release();
        await release.promise;
      },
    });
    await locked.promise;
    const second = authorize(envelope, { attempted: attempted.release });
    const settled = Promise.allSettled([first, second]);
    await attempted.promise;
    release.release();
    const outcomes = await settled;
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "request_replayed" },
    });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(1);
  });

  it("rolls back nonce and audit when the business operation fails", async () => {
    const fixture = await seed();
    const envelope = await actor(fixture);
    const { authorizeShopifyMerchantInTransaction } = await import(
      "../../lib/weletic/shopify/staff-authorization"
    );
    await expect(
      database.$transaction(async (tx) => {
        await authorizeShopifyMerchantInTransaction({
          tx,
          envelope,
          permission: "reviews.moderate",
        });
        throw new Error("synthetic business failure");
      }),
    ).rejects.toThrow("synthetic business failure");
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(0);
    await expect(authorize(envelope)).resolves.toMatchObject({ owner: true });
  });

  it("defaults staff to denied, then grants and revokes exact permissions", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const staff = await actor(fixture, false);
    await expect(authorize(staff)).rejects.toMatchObject({
      code: "access_denied",
    });
    await expect(grant(owner, 0, ["reviews.moderate"])).resolves.toMatchObject({
      revision: 1,
    });
    await expect(authorize(staff)).resolves.toMatchObject({
      owner: false,
      grantRevision: 1,
    });
    await expect(grant(freshNonce(owner), 1, [])).resolves.toMatchObject({
      revision: 2,
    });
    await expect(authorize(freshNonce(staff))).rejects.toMatchObject({
      code: "access_denied",
    });
    const audits = await database.weleticShopifyMerchantAction.findMany({
      where: { storeId: fixture.id, permission: "staff.manage" },
      orderBy: { changedGrantRevision: "asc" },
    });
    expect(
      audits.map((a) => [
        a.changedPermissions,
        a.changedGrantRevision,
        a.targetShopifyUserId,
      ]),
    ).toEqual([
      [["reviews.moderate"], 1, "456"],
      [[], 2, "456"],
    ]);
  });

  it("allows exactly one concurrent expected-revision replacement", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const locked = barrier();
    const release = barrier();
    const attempted = barrier();
    const first = grant(owner, 0, ["reviews.read"], {
      beforeCommit: async () => {
        locked.release();
        await release.promise;
      },
    });
    await locked.promise;
    const second = grant(freshNonce(owner), 0, ["reviews.moderate"], {
      attempted: attempted.release,
    });
    const settled = Promise.allSettled([first, second]);
    await attempted.promise;
    release.release();
    const results = await settled;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { name: "ShopifyStaffGrantConflictError" },
    });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(1);
  });

  it("rejects replaced ciphertext and consistently replaced installations", async () => {
    const fixture = await seed();
    const old = await actor(fixture);
    const current = await actor(fixture);
    await expect(authorize(old)).rejects.toMatchObject({
      code: "invalid_actor",
    });
    const installation = await database.installedIntegration.findUniqueOrThrow({
      where: { id: fixture.installationId },
    });
    await database.$transaction(async (tx) => {
      await tx.weleticShopifyStore.update({
        where: { id: fixture.id },
        data: { installationGeneration: "generation-2" },
      });
      await tx.installedIntegration.update({
        where: { id: fixture.installationId },
        data: {
          credentials: {
            ...(installation.credentials as object),
            installationGeneration: "generation-2",
          },
        },
      });
    });
    await expect(authorize(current)).rejects.toMatchObject({
      code: "invalid_actor",
    });
  });

  it("keeps revocation possible at the terminal revision and prohibits regrant", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const staff = await actor(fixture, false);
    await grant(owner, 0, ["reviews.moderate"]);
    await database.weleticShopifyStaffGrant.updateMany({
      where: { storeId: fixture.id },
      data: { revision: 2_147_483_647 },
    });
    await expect(
      grant(freshNonce(owner), 2_147_483_647, []),
    ).resolves.toMatchObject({ revision: 2_147_483_647, permissions: [] });
    await expect(authorize(staff)).rejects.toMatchObject({
      code: "access_denied",
    });
    await expect(
      grant(freshNonce(owner), 2_147_483_647, ["reviews.moderate"]),
    ).rejects.toMatchObject({ name: "ShopifyStaffGrantConflictError" });
  });

  it("denies malformed grants and never lets staff administer access", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const staff = await actor(fixture, false);
    await grant(owner, 0, ["reviews.moderate"]);
    await expect(grant(staff, 1, [])).rejects.toMatchObject({
      code: "access_denied",
    });
    await database.weleticShopifyStaffGrant.updateMany({
      where: { storeId: fixture.id },
      data: { permissions: ["reviews.moderate", "*"] },
    });
    await expect(authorize(freshNonce(staff))).rejects.toMatchObject({
      code: "access_denied",
    });
  });

  it("cannot reuse another store's grant or plant an owner self-grant", async () => {
    const fixture = await seed();
    const other = await seed();
    const owner = await actor(fixture);
    const stranger = await actor(other, false);
    await grant(owner, 0, ["reviews.moderate"]);
    await expect(authorize(stranger)).rejects.toMatchObject({
      code: "access_denied",
    });
    await expect(
      authorize({ ...stranger, storeId: fixture.id }),
    ).rejects.toThrow();
    const { replaceShopifyStaffGrantInTransaction } = await import(
      "../../lib/weletic/shopify/staff-grants"
    );
    await expect(
      database.$transaction((tx) =>
        replaceShopifyStaffGrantInTransaction({
          tx,
          envelope: freshNonce(owner),
          input: {
            userId: "123",
            permissions: ["reviews.moderate"],
            expectedRevision: 0,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("rejects an actor that expires during a store-lock wait", async () => {
    const fixture = await seed();
    const envelope = await actor(fixture);
    const { lockShopifySessionLifecycle } = await import(
      "../../lib/weletic/shopify/session-lifecycle-fence"
    );
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = database.$transaction(async (tx) => {
      await lockShopifySessionLifecycle({
        tx,
        shop: fixture.shop,
        storeId: fixture.id,
      });
      locked();
      await held;
    });
    await ready;
    const almostExpired = { ...envelope, authenticatedAt: Date.now() - 59_000 };
    const attempted = barrier();
    const result = authorize(almostExpired, {
      attempted: attempted.release,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await attempted.promise;
      expect(Date.now() - almostExpired.authenticatedAt).toBeLessThan(60_000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      unlock();
    }
    await blocker;
    expect(await result).toMatchObject({ code: "invalid_actor" });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.id },
      }),
    ).toBe(0);
  });

  it("a staff action waiting behind revocation sees the committed revoked grant", async () => {
    const fixture = await seed();
    const owner = await actor(fixture);
    const staff = await actor(fixture, false);
    await grant(owner, 0, ["reviews.moderate"]);
    const { replaceShopifyStaffGrantInTransaction } = await import(
      "../../lib/weletic/shopify/staff-grants"
    );
    let release!: () => void;
    let changed!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const revoke = database.$transaction(async (tx) => {
      await replaceShopifyStaffGrantInTransaction({
        tx,
        envelope: freshNonce(owner),
        input: { userId: "456", expectedRevision: 1, permissions: [] },
      });
      changed();
      await held;
    });
    await ready;
    const attempted = barrier();
    const result = authorize(staff, { attempted: attempted.release }).then(
      () => null,
      (error: unknown) => error,
    );
    await attempted.promise;
    release();
    await revoke;
    expect(await result).toMatchObject({ code: "access_denied" });
  });
});
