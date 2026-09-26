import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { consumeFlowPointsBudget } from "../../lib/weletic/loyalty/flow-action-grant-contract";
import { readFlowGrantQuantities } from "../../lib/weletic/loyalty/flow-action-grant-storage";
import { purgeShopifyStaffPrivacyBatch } from "../../lib/weletic/shopify/staff-privacy";

const database = new PrismaClient();
const coreLaunch = process.env.WELETIC_FEATURE_PROFILE === "core-v1";
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("server-only", () => ({}));

describe("Flow action persistence on isolated MySQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    const suffix = url.pathname.match(
      /^\/weletic_loyalty_it_shopper_([a-f0-9]{12})$/,
    )?.[1];
    if (
      process.env.FLOW_ACTION_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== (process.env.FLOW_ACTION_DATABASE_PORT || "3307") ||
      !suffix ||
      url.username !== `wr_${suffix}`
    )
      throw new Error("Refusing non-isolated Flow action database");
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([
      { name: url.pathname.slice(1), principal: `${url.username}@%` },
    ]);
    vi.stubEnv("SHOPIFY_API_KEY", "flow-db-test");
    if (coreLaunch) vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/1");
    vi.stubEnv("ENCRYPTION_KEY", "37".repeat(32));
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `flow-test:${randomBytes(32).toString("base64")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External requests forbidden");
      }),
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  });

  async function ownerFixture(owner = true) {
    const { seedFlowOwner } = await import("./fixtures/flow-owner");
    const fixture = await seedFlowOwner(database, owner);
    if (coreLaunch) {
      // Synthetic subscription authority only in the guarded local database.
      // Keep production entitlement checks active for every core execution.
      const pending =
        await database.weleticShopifyPendingInstallation.findUniqueOrThrow({
          where: { mappedStoreId: fixture.storeId },
        });
      const [clock] = await database.$queryRaw<
        Array<{ now: Date }>
      >`SELECT CURRENT_TIMESTAMP(3) AS now`;
      await database.weleticShopifySubscriptionSnapshot.create({
        data: {
          id: createHash("sha256")
            .update(
              JSON.stringify([
                fixture.actor.appId,
                pending.id,
                fixture.actor.installationGeneration,
              ]),
            )
            .digest("hex"),
          appId: fixture.actor.appId,
          partnerAppId: "gid://shopify/App/1",
          pendingInstallationId: pending.id,
          installationGeneration: fixture.actor.installationGeneration,
          shopId: "gid://shopify/Shop/789",
          status: "private_free",
          planHandle: "company-free",
          verifiedAt: clock.now,
          validUntil: new Date(clock.now.getTime() + 300_000),
        },
      });
    }
    return fixture;
  }
  const policy = () => ({
    allowCredit: true,
    allowDebit: true,
    maxAbsolutePointsPerAction: "9223372036854775808",
    absolutePointsBudget: "18446744073709551615",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    expectedRevision: 0,
    expectedInstallationGeneration: "g1",
  });
  async function manage(
    fixture: Awaited<ReturnType<typeof ownerFixture>>,
    operation: "create" | "revoke",
    input: unknown,
    rollback = false,
  ) {
    const { manageShopifyFlowGrantInTransaction } = await import(
      "../../lib/weletic/shopify/merchant-flow-grants"
    );
    return database.$transaction(
      async (tx) => {
        const result = await manageShopifyFlowGrantInTransaction({
          tx,
          envelope: {
            ...fixture.actor,
            authenticatedAt: Date.now() - 1,
            requestId: randomBytes(32).toString("hex"),
          },
          operation,
          input,
        });
        if (rollback) throw new Error("synthetic rollback");
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  it("commits owner grant and action audit atomically, then permits only one concurrent revision-fenced revocation", async () => {
    const fixture = await ownerFixture();
    await expect(manage(fixture, "create", policy(), true)).rejects.toThrow(
      "synthetic rollback",
    );
    expect(
      await database.weleticShopifyFlowPointsGrant.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    const created = await manage(fixture, "create", policy());
    const saved =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: created.id },
      });
    expect(saved.approvedByShopifyUserId).toBe(fixture.actor.userId);
    expect(saved.absolutePointsBudget.toFixed()).toBe("18446744073709551615");
    await database.weleticLoyaltyProgram.update({
      where: { storeId: fixture.storeId },
      data: { killSwitchActive: true },
    });
    await expect(manage(fixture, "create", policy())).rejects.toMatchObject({
      name: "LoyaltyProgramWriteBlockedError",
    });
    const input = {
      grantId: created.id,
      expectedRevision: 1,
      expectedInstallationGeneration: "g1",
    };
    await expect(manage(fixture, "revoke", input, true)).rejects.toThrow(
      "synthetic rollback",
    );
    expect(
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toEqual(saved);
    const results = await Promise.allSettled([
      manage(fixture, "revoke", input),
      manage(fixture, "revoke", input),
    ]);
    expect(
      results.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
      "state_changed",
    );
    const revoked =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: created.id },
      });
    expect(revoked).toMatchObject({
      revision: 2,
      revokedByShopifyUserId: fixture.actor.userId,
      revokedAt: expect.any(Date),
      absolutePointsBudget: saved.absolutePointsBudget,
      absolutePointsUsed: saved.absolutePointsUsed,
    });
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(2);
    expect(revoked.revokedMerchantActionId).not.toBe(
      saved.approvedMerchantActionId,
    );
    expect(revoked.revokedMerchantActionId).toEqual(expect.any(String));
    for (const actionId of [
      saved.approvedMerchantActionId,
      revoked.revokedMerchantActionId!,
    ]) {
      const action =
        await database.weleticShopifyMerchantAction.findUniqueOrThrow({
          where: { id: actionId },
        });
      expect(action).toMatchObject({
        storeId: fixture.storeId,
        appId: fixture.actor.appId,
        installationGeneration: fixture.actor.installationGeneration,
        shopifyUserId: fixture.actor.userId,
        owner: true,
        permission: "loyalty.configure",
      });
    }
  });

  it("rejects delegated configuration staff without retaining an action audit or grant", async () => {
    const fixture = await ownerFixture(false);
    await expect(manage(fixture, "create", policy())).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(
      await database.weleticShopifyFlowPointsGrant.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it.each(["session", "generation", "admission", "expiry"] as const)(
    "rejects stale or invalid %s authority without grant or audit writes",
    async (change) => {
      const fixture = await ownerFixture();
      const input = policy();
      if (change === "session")
        await database.weleticShopifyAppSession.update({
          where: { id: fixture.actor.sessionId },
          data: { expiresAt: new Date(0) },
        });
      if (change === "generation")
        await database.weleticShopifyStore.update({
          where: { id: fixture.storeId },
          data: { installationGeneration: "g2" },
        });
      if (change === "admission")
        await database.weleticShopifyStore.update({
          where: { id: fixture.storeId },
          data: { storeAccessState: "suspended" },
        });
      if (change === "expiry") input.expiresAt = new Date(0).toISOString();
      const expectedError =
        change === "admission"
          ? {
              name: "ShopifyStoreOperationalWritesBlockedError",
              storeId: fixture.storeId,
              complianceState: "suspended",
            }
          : change === "expiry"
            ? { name: "FlowGrantMutationError", code: "invalid_expiry" }
            : { name: "ShopifyStaffAuthorizationError", code: "invalid_actor" };
      await expect(manage(fixture, "create", input)).rejects.toMatchObject(
        expectedError,
      );
      expect(
        await database.weleticShopifyFlowPointsGrant.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticShopifyMerchantAction.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it("cannot revoke a foreign store's grant even as another store owner", async () => {
    const target = await ownerFixture();
    const foreign = await ownerFixture();
    const created = await manage(target, "create", policy());
    const saved =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: created.id },
      });
    await expect(
      manage(foreign, "revoke", {
        grantId: created.id,
        expectedRevision: 1,
        expectedInstallationGeneration: "g1",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: created.id },
      }),
    ).toEqual(saved);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: foreign.storeId },
      }),
    ).toBe(0);
  });

  async function executionFixture() {
    const fixture = await ownerFixture();
    const grant = await manage(fixture, "create", policy());
    const program = await database.weleticLoyaltyProgram.findUniqueOrThrow({
      where: { storeId: fixture.storeId },
    });
    const shopper = await database.weleticShopper.create({
      data: {
        id: randomUUID(),
        storeId: fixture.storeId,
        shopifyCustomerId: "456",
      },
    });
    const account = await database.weleticLoyaltyAccount.create({
      data: {
        id: randomUUID(),
        storeId: fixture.storeId,
        programId: program.id,
        shopperId: shopper.id,
      },
    });
    const action = {
      handle: "weletic-adjust-points",
      shop_id: "789",
      shopify_domain: fixture.actor.shop,
      action_run_id: randomUUID(),
      properties: {
        customer_id: "gid://shopify/Customer/456",
        grant_id: grant.id,
        points_delta: "9007199254740993",
      },
    };
    const execute = async (input = action, rollback = false) => {
      const { executeFlowPointsActionInTransaction } = await import(
        "../../lib/weletic/loyalty/flow-action-execution"
      );
      return database.$transaction(
        async (tx) => {
          const result = await executeFlowPointsActionInTransaction({
            tx,
            scope: fixture.actor,
            input,
          });
          if (rollback) throw new Error("synthetic execution rollback");
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    };
    return { ...fixture, grant, account, action, execute };
  }

  it("atomically adjusts exact points and budget with one receipt and sync job across rollback and concurrent replay", async () => {
    const f = await executionFixture();
    await expect(f.execute(f.action, true)).rejects.toThrow(
      "synthetic execution rollback",
    );
    expect(
      await database.weleticShopifyFlowActionRun.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      (
        await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
          where: { id: f.grant.id },
        })
      ).absolutePointsUsed.toFixed(),
    ).toBe("0");
    const results = await Promise.all([f.execute(), f.execute()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "applied",
      "replayed",
    ]);
    expect(results[0].runId).toBe(results[1].runId);
    const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: f.account.id },
    });
    expect(account).toMatchObject({
      cachedPointsBalance: BigInt("9007199254740993"),
      lifetimePointsEarned: BigInt(0),
      ledgerVersion: 1,
    });
    expect(
      await database.$queryRaw`SELECT CAST(SUM(pointsDelta) AS CHAR) AS balance FROM WeleticPointsLedgerEntry WHERE accountId = ${account.id}`,
    ).toEqual([{ balance: "9007199254740993" }]);
    expect(
      (
        await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
          where: { id: f.grant.id },
        })
      ).absolutePointsUsed.toFixed(),
    ).toBe("9007199254740993");
    const run = await database.weleticShopifyFlowActionRun.findUniqueOrThrow({
      where: { id: results[0].runId },
    });
    expect(
      await database.weleticPointsLedgerEntry.findUniqueOrThrow({
        where: { id: run.ledgerEntryId },
      }),
    ).toMatchObject({
      accountId: account.id,
      storeId: f.storeId,
      referenceId: run.id,
      entryType: "MANUAL_ADJUSTMENT",
    });
    expect(
      await database.weleticLoyaltyOutboxJob.findMany({
        where: { storeId: f.storeId },
      }),
    ).toMatchObject([
      { jobType: "METAFIELD_SYNC", payload: { accountId: account.id } },
    ]);
    await expect(
      f.execute({
        ...f.action,
        properties: { ...f.action.properties, points_delta: "1" },
      }),
    ).rejects.toMatchObject({ code: "run_conflict" });
  });

  it.runIf(coreLaunch)(
    "pauses new Flow credits at billing expiry while preserving receipts and bounded corrections",
    async () => {
      const f = await executionFixture();
      const credit = {
        ...f.action,
        properties: { ...f.action.properties, points_delta: "25" },
      };
      const result = await f.execute(credit);
      const pending =
        await database.weleticShopifyPendingInstallation.findUniqueOrThrow({
          where: { mappedStoreId: f.storeId },
        });
      const subscription =
        await database.weleticShopifySubscriptionSnapshot.findFirstOrThrow({
          where: {
            pendingInstallationId: pending.id,
            installationGeneration: f.actor.installationGeneration,
          },
        });
      await database.weleticShopifySubscriptionSnapshot.update({
        where: { id: subscription.id },
        data: { validUntil: new Date(0) },
      });
      const assertState = async (
        balance: bigint,
        count: number,
        used: string,
      ) => {
        expect(
          await database.weleticLoyaltyAccount.findUniqueOrThrow({
            where: { id: f.account.id },
            select: { cachedPointsBalance: true },
          }),
        ).toEqual({ cachedPointsBalance: balance });
        expect(
          await database.$queryRaw`SELECT CAST(SUM(pointsDelta) AS CHAR) AS balance FROM WeleticPointsLedgerEntry WHERE accountId = ${f.account.id}`,
        ).toEqual([{ balance: balance.toString() }]);
        expect(
          await database.weleticPointsLedgerEntry.count({
            where: { storeId: f.storeId },
          }),
        ).toBe(count);
        expect(
          await database.weleticShopifyFlowActionRun.count({
            where: { storeId: f.storeId },
          }),
        ).toBe(count);
        expect(
          await database.weleticLoyaltyOutboxJob.count({
            where: { storeId: f.storeId, jobType: "METAFIELD_SYNC" },
          }),
        ).toBe(count);
        expect(
          await database.weleticLoyaltyOutboxJob.count({
            where: { storeId: f.storeId, jobType: { not: "METAFIELD_SYNC" } },
          }),
        ).toBe(0);
        expect(
          (
            await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
              where: { id: f.grant.id },
            })
          ).absolutePointsUsed.toFixed(),
        ).toBe(used);
      };
      expect(await f.execute(credit)).toEqual({
        status: "replayed",
        runId: result.runId,
      });
      const nextCredit = { ...credit, action_run_id: randomUUID() };
      await expect(f.execute(nextCredit)).rejects.toThrow(
        "subscription verification",
      );
      await assertState(BigInt(25), 1, "25");
      const debit = {
        ...credit,
        action_run_id: randomUUID(),
        properties: { ...credit.properties, points_delta: "-5" },
      };
      const correction = await f.execute(debit);
      expect(correction.status).toBe("applied");
      expect(await f.execute(debit)).toEqual({
        status: "replayed",
        runId: correction.runId,
      });
      await assertState(BigInt(20), 2, "30");
      const [clock] = await database.$queryRaw<
        Array<{ now: Date }>
      >`SELECT CURRENT_TIMESTAMP(3) AS now`;
      await database.weleticShopifySubscriptionSnapshot.update({
        where: { id: subscription.id },
        data: {
          verifiedAt: clock.now,
          validUntil: new Date(clock.now.getTime() + 300_000),
        },
      });
      // The failed attempt left no receipt or budget consumption; the same run
      // can succeed once a fresh subscription decision permits new benefits.
      expect((await f.execute(nextCredit)).status).toBe("applied");
      expect((await f.execute(nextCredit)).status).toBe("replayed");
      await assertState(BigInt(45), 3, "55");
      await manage(f, "revoke", {
        grantId: f.grant.id,
        expectedRevision: 1,
        expectedInstallationGeneration: "g1",
      });
      await expect(
        f.execute({ ...debit, action_run_id: randomUUID() }),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await f.execute(debit)).toEqual({
        status: "replayed",
        runId: correction.runId,
      });
      await assertState(BigInt(45), 3, "55");
    },
  );

  it("rejects balance overflow without consuming authority or creating a receipt", async () => {
    const f = await executionFixture();
    await database.weleticLoyaltyAccount.update({
      where: { id: f.account.id },
      data: { cachedPointsBalance: BigInt("9223372036854775807") },
    });
    await expect(f.execute()).rejects.toMatchObject({
      code: "balance_overflow",
    });
    expect(
      await database.weleticShopifyFlowActionRun.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      (
        await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
          where: { id: f.grant.id },
        })
      ).absolutePointsUsed.toFixed(),
    ).toBe("0");
  });

  it.each([
    "revoked",
    "expired",
    "foreign",
    "generation",
    "closed",
    "privacy",
    "privacy_metadata",
    "budget",
    "direction",
  ] as const)(
    "rejects %s execution without financial side effects",
    async (condition) => {
      const f = await executionFixture();
      if (condition === "revoked")
        await manage(f, "revoke", {
          grantId: f.grant.id,
          expectedRevision: 1,
          expectedInstallationGeneration: "g1",
        });
      if (condition === "expired")
        await database.weleticShopifyFlowPointsGrant.update({
          where: { id: f.grant.id },
          data: { expiresAt: new Date(0) },
        });
      if (condition === "foreign") {
        const other = await executionFixture();
        f.action.properties.grant_id = other.grant.id;
      }
      if (condition === "generation")
        await database.weleticShopifyFlowPointsGrant.update({
          where: { id: f.grant.id },
          data: { installationGeneration: "old-generation" },
        });
      if (condition === "closed")
        await database.weleticLoyaltyAccount.update({
          where: { id: f.account.id },
          data: { status: "closed" },
        });
      if (condition === "privacy") {
        const { upsertShopifyCustomerPrivacyTombstones } = await import(
          "../../lib/weletic/shopify/privacy-identity"
        );
        await upsertShopifyCustomerPrivacyTombstones({
          storeId: f.storeId,
          shopifyCustomerId: "456",
          shopperId: f.account.shopperId,
          accountId: f.account.id,
        });
      }
      if (condition === "privacy_metadata") {
        const { SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY } = await import(
          "../../lib/weletic/loyalty/shopper-privacy"
        );
        await database.weleticLoyaltyAccount.update({
          where: { id: f.account.id },
          data: {
            metadata: {
              [SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY]: {
                status: "redacted",
                redactedAt: new Date().toISOString(),
                source: "shopify_customers_redact",
              },
            },
          },
        });
      }
      if (condition === "budget")
        await database.weleticShopifyFlowPointsGrant.update({
          where: { id: f.grant.id },
          data: { absolutePointsUsed: "18446744073709551615" },
        });
      if (condition === "direction")
        await database.weleticShopifyFlowPointsGrant.update({
          where: { id: f.grant.id },
          data: { allowCredit: false },
        });
      if (condition === "budget" || condition === "direction")
        await expect(f.execute()).rejects.toThrow(
          "Flow points grant limit exceeded",
        );
      else
        await expect(f.execute()).rejects.toMatchObject({
          name: "FlowActionExecutionError",
          code: "unavailable",
        });
      expect(
        await database.weleticShopifyFlowActionRun.count({
          where: { storeId: f.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: f.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticLoyaltyOutboxJob.count({
          where: { storeId: f.storeId },
        }),
      ).toBe(0);
      expect(
        (
          await database.weleticLoyaltyAccount.findUniqueOrThrow({
            where: { id: f.account.id },
          })
        ).cachedPointsBalance,
      ).toBe(BigInt(0));
    },
  );

  it("retains a completed receipt through revocation and customer erasure without reapplying points", async () => {
    const f = await executionFixture();
    const result = await f.execute();
    await manage(f, "revoke", {
      grantId: f.grant.id,
      expectedRevision: 1,
      expectedInstallationGeneration: "g1",
    });
    await database.weleticShopper.update({
      where: { id: f.account.shopperId },
      data: { shopifyCustomerId: `redacted:${randomUUID()}` },
    });
    await database.weleticLoyaltyAccount.update({
      where: { id: f.account.id },
      data: { status: "closed" },
    });
    expect(await f.execute()).toEqual({
      status: "replayed",
      runId: result.runId,
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
    expect(
      (
        await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
          where: { id: f.grant.id },
        })
      ).absolutePointsUsed.toFixed(),
    ).toBe("9007199254740993");
  });

  it.each(["killed", "suspended"] as const)(
    "acknowledges completed runs after %s but rejects new writes",
    async (state) => {
      const f = await executionFixture();
      const result = await f.execute();
      if (state === "killed")
        await database.weleticLoyaltyProgram.update({
          where: { storeId: f.storeId },
          data: { killSwitchActive: true },
        });
      else
        await database.weleticShopifyStore.update({
          where: { id: f.storeId },
          data: { storeAccessState: "suspended" },
        });
      expect(await f.execute()).toEqual({
        status: "replayed",
        runId: result.runId,
      });
      await expect(
        f.execute({ ...f.action, action_run_id: randomUUID() }),
      ).rejects.toMatchObject({
        name:
          state === "killed"
            ? "LoyaltyProgramWriteBlockedError"
            : "ShopifyStoreOperationalWritesBlockedError",
      });
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: f.storeId },
        }),
      ).toBe(1);
    },
  );

  it("runs signed merchant HTTP through real owner authorization and SQL without duplicating grants on nonce replay", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/merchant/flow-grants/route"
    );
    const { signWeleticShopifyRequest } = await import(
      "../../lib/weletic/shopify/service-auth"
    );
    const secret = "synthetic-sql-http-service-secret-flow-only";
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const fixture = await ownerFixture();
    const path = "/api/internal/shopify/merchant/flow-grants";
    const payload = JSON.stringify({
      actor: { ...fixture.actor, authenticatedAt: Date.now() - 1 },
      operation: "create",
      input: policy(),
    });
    const send = (body: string, signed = body) => {
      const timestamp = String(Date.now());
      return POST(
        new Request(`https://example.invalid${path}`, {
          method: "POST",
          body,
          headers: {
            "x-weletic-timestamp": timestamp,
            "x-weletic-signature": signWeleticShopifyRequest({
              timestamp,
              method: "POST",
              path,
              body: signed,
              secret,
            }),
          },
        }),
      );
    };
    expect((await send(payload + " ", payload)).status).toBe(401);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    const created = await send(payload);
    expect(created.status).toBe(200);
    const result = await created.json();
    expect(result).toEqual({
      id: expect.stringMatching(/^wflowgrant_/),
      revision: 1,
      revokedAt: null,
    });
    expect((await send(payload)).status).toBe(409);
    expect(
      await database.weleticShopifyFlowPointsGrant.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    const delegated = await ownerFixture(false);
    const denied = await send(
      JSON.stringify({
        actor: { ...delegated.actor, authenticatedAt: Date.now() - 1 },
        operation: "create",
        input: policy(),
      }),
    );
    expect(denied.status).toBe(403);
    expect(
      await database.weleticShopifyFlowPointsGrant.count({
        where: { storeId: delegated.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: delegated.storeId },
      }),
    ).toBe(0);
  });

  it("lists and recovers only owner-scoped grants without writing audits, including equal-time pagination", async () => {
    const { readShopifyFlowGrantsInTransaction } = await import(
      "../../lib/weletic/shopify/merchant-flow-grants-read"
    );
    const f = await ownerFixture();
    const first = await manage(f, "create", policy());
    const second = await manage(f, "create", policy());
    const foreign = await ownerFixture();
    const foreignGrant = await manage(foreign, "create", policy());
    await database.weleticShopifyFlowPointsGrant.updateMany({
      where: { storeId: f.storeId },
      data: { createdAt: new Date("2026-01-01") },
    });
    await database.weleticLoyaltyProgram.update({
      where: { storeId: f.storeId },
      data: { killSwitchActive: true },
    });
    const read = (extra: Record<string, unknown> = {}) =>
      database.$transaction(
        (tx) =>
          readShopifyFlowGrantsInTransaction({
            tx,
            envelope: {
              ...f.actor,
              authenticatedAt: Date.now() - 1,
              requestId: randomBytes(32).toString("hex"),
            },
            input: { expectedInstallationGeneration: "g1", ...extra },
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    const a = await read({ limit: 1 });
    expect(a.grants).toHaveLength(1);
    expect(a.nextCursor).toBe(a.grants[0].id);
    const b = await read({ limit: 1, cursor: a.nextCursor });
    expect(b.nextCursor).toBeNull();
    expect([...a.grants, ...b.grants].map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(a.grants[0]).toMatchObject({
      absolutePointsBudget: "18446744073709551615",
      remainingAbsolutePoints: "18446744073709551615",
    });
    expect(a.grants[0]).not.toHaveProperty("approvedByShopifyUserId");
    await expect(read({ cursor: foreignGrant.id })).rejects.toMatchObject({
      code: "unavailable",
    });
    // Exact recovery is independent of pagination and cannot discover another tenant.
    expect(
      (await read({ grantId: first.id })).grants.map((row) => row.id),
    ).toEqual([first.id]);
    expect(
      (await read({ grantId: second.id })).grants.map((row) => row.id),
    ).toEqual([second.id]);
    expect((await read({ grantId: foreignGrant.id })).grants).toEqual([]);
    const foreignSaved =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: foreignGrant.id },
      });
    const foreignApproval =
      await database.weleticShopifyMerchantAction.findUniqueOrThrow({
        where: { id: foreignSaved.approvedMerchantActionId },
      });
    expect(
      (await read({ approvalRequestId: foreignApproval.requestId })).grants,
    ).toEqual([]);
    const grant =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: first.id },
      });
    const approval =
      await database.weleticShopifyMerchantAction.findUniqueOrThrow({
        where: { id: grant.approvedMerchantActionId },
      });
    expect(
      (await read({ approvalRequestId: approval.requestId })).grants.map(
        (row) => row.id,
      ),
    ).toEqual([first.id]);
    expect(
      (await read({ approvalRequestId: randomBytes(32).toString("hex") }))
        .grants,
    ).toEqual([]);
    expect(
      await database.weleticShopifyMerchantAction.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(2);
  });

  async function seed() {
    const id = randomUUID();
    const store = await database.weleticShopifyStore.create({
      data: {
        id,
        projectId: `flow-${id}`,
        programId: `flow-${id}`,
        shopDomain: `flow-${id}.myshopify.com`,
        shopCurrency: "JPY",
        apiVersion: "2026-07",
        installationGeneration: "generation-1",
        storeAccessState: "active",
        complianceState: "frozen",
      },
    });
    return store;
  }
  function grantData(storeId: string) {
    return {
      id: randomUUID(),
      storeId,
      appId: "flow-db-test",
      installationGeneration: "generation-1",
      allowCredit: true,
      allowDebit: true,
      maxAbsolutePointsPerAction: "100",
      absolutePointsBudget: "1000",
      absolutePointsUsed: "42",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      approvedByShopifyUserId: "123",
      approvedMerchantActionId: randomUUID(),
    };
  }

  it.each([
    "9223372036854775807",
    "9223372036854775808",
    "18446744073709551615",
  ])(
    "round-trips full-range decimal budget %s exactly through Prisma",
    async (value) => {
      const store = await seed();
      const input = {
        ...grantData(store.id),
        absolutePointsBudget: value,
      };
      const created = await database.weleticShopifyFlowPointsGrant.create({
        data: input,
      });
      expect(created.absolutePointsBudget.toFixed()).toBe(value);
      const read =
        await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
          where: { id: input.id },
        });
      expect(read.absolutePointsBudget.toFixed()).toBe(value);
      const sql = await database.$queryRaw<Array<{ budget: string }>>`
        SELECT CAST(absolutePointsBudget AS CHAR) AS budget
        FROM WeleticShopifyFlowPointsGrant WHERE id = ${input.id}`;
      expect(sql).toEqual([{ budget: value }]);
    },
  );

  it("serializes competing absolute-minimum debit budget consumption without rounding", async () => {
    const store = await seed();
    const grant = await database.weleticShopifyFlowPointsGrant.create({
      data: {
        ...grantData(store.id),
        maxAbsolutePointsPerAction: "9223372036854775808",
        absolutePointsBudget: "18446744073709551615",
        absolutePointsUsed: "0",
      },
    });
    // Storage/arithmetic test only: no endpoint, authorization or ledger writer.
    const consume = () =>
      database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyFlowPointsGrant WHERE id = ${grant.id} AND storeId = ${store.id} FOR UPDATE`;
        const locked = await tx.weleticShopifyFlowPointsGrant.findUniqueOrThrow(
          { where: { id: grant.id } },
        );
        const used = consumeFlowPointsBudget({
          ...readFlowGrantQuantities(locked),
          allowCredit: locked.allowCredit,
          allowDebit: locked.allowDebit,
          pointsDelta: BigInt("-9223372036854775808"),
        });
        await tx.weleticShopifyFlowPointsGrant.update({
          where: { id: grant.id },
          data: { absolutePointsUsed: used.toString() },
        });
        return used;
      });
    const outcomes = await Promise.allSettled([consume(), consume()]);
    expect(
      outcomes.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((entry) => entry.status === "rejected"),
    ).toHaveLength(1);
    const rejected = outcomes.find((entry) => entry.status === "rejected");
    if (rejected?.status === "rejected")
      expect(rejected.reason.message).toBe("Flow points grant limit exceeded");
    const persisted =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
    expect(readFlowGrantQuantities(persisted).absolutePointsUsed).toBe(
      BigInt("9223372036854775808"),
    );
    expect(
      await database.$queryRaw`SELECT CAST(absolutePointsUsed AS CHAR) AS used FROM WeleticShopifyFlowPointsGrant WHERE id = ${grant.id}`,
    ).toEqual([{ used: "9223372036854775808" }]);
  });

  it("retains receipts and authority through bounded rollback-safe exact-store staff erasure", async () => {
    const target = await seed();
    const foreign = await seed();
    const data = Array.from({ length: 101 }, () => grantData(target.id));
    await database.weleticShopifyFlowPointsGrant.createMany({ data });
    const foreignGrant = await database.weleticShopifyFlowPointsGrant.create({
      data: grantData(foreign.id),
    });
    const receipt = await database.weleticShopifyFlowActionRun.create({
      data: {
        id: randomUUID(),
        storeId: target.id,
        appId: "flow-db-test",
        installationGeneration: "generation-1",
        runKey: "a".repeat(64),
        payloadDigest: "b".repeat(64),
        grantId: data[0].id,
        grantRevision: 1,
        ledgerEntryId: `synthetic-receipt-${randomUUID()}`,
        pointsDelta: BigInt(42),
      },
    });
    const purge = (rollback = false) =>
      database.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM WeleticShopifyStore WHERE id = ${target.id} FOR UPDATE`,
        );
        const result = await purgeShopifyStaffPrivacyBatch(tx, target.id);
        if (rollback) throw new Error("synthetic rollback");
        return result;
      });
    await expect(purge(true)).rejects.toThrow("synthetic rollback");
    expect(
      await database.weleticShopifyFlowPointsGrant.count({
        where: { storeId: target.id, approvedByShopifyUserId: "123" },
      }),
    ).toBe(101);
    await expect(purge()).resolves.toEqual({ pending: true });
    expect(
      await database.weleticShopifyFlowPointsGrant.count({
        where: { storeId: target.id, approvedByShopifyUserId: "123" },
      }),
    ).toBe(1);
    await expect(purge()).resolves.toEqual({ pending: true });
    await expect(purge()).resolves.toEqual({ pending: false });
    const retained =
      await database.weleticShopifyFlowPointsGrant.findUniqueOrThrow({
        where: { id: data[0].id },
      });
    expect(retained).toMatchObject({
      approvedByShopifyUserId: null,
      revokedByShopifyUserId: null,
      staffRedactedAt: expect.any(Date),
      absolutePointsUsed: new Prisma.Decimal("42"),
      absolutePointsBudget: new Prisma.Decimal("1000"),
      maxAbsolutePointsPerAction: new Prisma.Decimal("100"),
      approvedMerchantActionId: data[0].approvedMerchantActionId,
      revision: 1,
    });
    expect(
      await database.weleticShopifyFlowActionRun.findUnique({
        where: { id: receipt.id },
      }),
    ).toEqual(receipt);
    expect(
      await database.weleticShopifyFlowPointsGrant.findUnique({
        where: { id: foreignGrant.id },
      }),
    ).toEqual(foreignGrant);
  });
});
