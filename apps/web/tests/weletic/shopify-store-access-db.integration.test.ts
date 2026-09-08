import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = new PrismaClient();
vi.mock("@/lib/prisma", () => ({ prisma: database }));
const ids: string[] = [];
let ready = false;

describe("company store admission using MySQL row locks", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      !/^\/weletic_loyalty_it_access_[a-z0-9_]+$/.test(url.pathname)
    ) {
      throw new Error("Refusing a non-isolated approval test database.");
    }
    const tables = await database.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()`;
    if (Number(tables[0].count) !== 0)
      throw new Error("Use a fresh empty approval test database.");
    // Minimal pre-migration tables for the production services exercised here.
    await database.$executeRawUnsafe(`CREATE TABLE WeleticShopifyStore (
      id VARCHAR(191) PRIMARY KEY, shopDomain VARCHAR(191) NOT NULL,
      projectId VARCHAR(191) NOT NULL, installationGeneration VARCHAR(64),
      complianceState VARCHAR(32) NOT NULL DEFAULT 'active',
      shopCurrency VARCHAR(8) NOT NULL DEFAULT 'JPY', currencyVerifiedAt DATETIME(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`);
    await database.$executeRawUnsafe(`CREATE TABLE WeleticShopifyComplianceRequest (
      id VARCHAR(191) PRIMARY KEY, storeId VARCHAR(191), requestType VARCHAR(32), status VARCHAR(32))`);
    await database.$executeRawUnsafe(`CREATE TABLE WeleticLoyaltyProgram (
      id VARCHAR(191) PRIMARY KEY, storeId VARCHAR(191), status VARCHAR(32), killSwitchActive BOOLEAN, metadata JSON)`);
    await database.$executeRaw`INSERT INTO WeleticShopifyStore (id, shopDomain, projectId) VALUES ('retained', 'retained.myshopify.com', 'retained')`;
    const sql = readFileSync(
      new URL(
        "../../../../infra/shopify-development/migrations/20260908_shopify_store_approval.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const statement of sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .filter((value) => value.trim())) {
      await database.$executeRawUnsafe(statement);
    }
    ready = true;
    ids.push("retained");
  });
  afterAll(async () => {
    if (ready)
      for (const id of ids) {
        await database.$executeRaw`DELETE FROM WeleticShopifyStoreAccessChange WHERE storeId = ${id}`;
        await database.$executeRaw`DELETE FROM WeleticLoyaltyProgram WHERE storeId = ${id}`;
        await database.$executeRaw`DELETE FROM WeleticShopifyStore WHERE id = ${id}`;
      }
    await database.$disconnect();
  });
  async function seed() {
    const id = `access_${randomUUID()}`;
    ids.push(id);
    const shopDomain = `${id.replaceAll("_", "-")}.myshopify.com`;
    await database.$executeRaw`INSERT INTO WeleticShopifyStore (id, shopDomain, projectId, installationGeneration, currencyVerifiedAt) VALUES (${id}, ${shopDomain}, ${id}, 'generation_1', CURRENT_TIMESTAMP(3))`;
    await database.$executeRaw`INSERT INTO WeleticLoyaltyProgram (id, storeId, status, killSwitchActive) VALUES (${id}, ${id}, 'active', false)`;
    return {
      storeId: id,
      shopDomain,
      expectedInstallationGeneration: "generation_1",
      expectedRevision: 1,
      nextState: "active",
      operator: "integration-test",
      reason: "Disposable company fixture",
      apply: true,
    };
  }
  it("preserves retained eligibility and defaults new stores to pending", async () => {
    const input = await seed();
    const rows = await database.$queryRaw<
      Array<{ id: string; storeAccessState: string }>
    >`SELECT id, storeAccessState FROM WeleticShopifyStore WHERE id IN ('retained', ${input.storeId})`;
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: "retained", storeAccessState: "active" },
        { id: input.storeId, storeAccessState: "pending_approval" },
      ]),
    );
  });
  it("allows exactly one concurrent approval of the same revision", async () => {
    const { changeShopifyStoreAccess } = await import(
      "../../lib/weletic/shopify/store-access-operator"
    );
    const input = await seed();
    const results = await Promise.allSettled([
      changeShopifyStoreAccess(input),
      changeShopifyStoreAccess(input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await database.weleticShopifyStoreAccessChange.count({
        where: { storeId: input.storeId },
      }),
    ).toBe(1);
  });
  it("rolls back the state change when its audit cannot commit", async () => {
    const { changeShopifyStoreAccess } = await import(
      "../../lib/weletic/shopify/store-access-operator"
    );
    const input = await seed();
    await database.weleticShopifyStoreAccessChange.create({
      data: {
        id: randomUUID(),
        storeId: input.storeId,
        installationGeneration: "generation_1",
        previousState: "pending_approval",
        nextState: "active",
        revision: 2,
        operator: "integration-test",
        reason: "Injected audit collision",
      },
    });
    await expect(changeShopifyStoreAccess(input)).rejects.toThrow();
    const rows = await database.$queryRaw<
      Array<{ storeAccessState: string; storeAccessRevision: number }>
    >`SELECT storeAccessState, storeAccessRevision FROM WeleticShopifyStore WHERE id = ${input.storeId}`;
    expect(rows).toEqual([
      { storeAccessState: "pending_approval", storeAccessRevision: 1 },
    ]);
  });
  it("rejects approval observed before an installation-generation change", async () => {
    const { changeShopifyStoreAccess } = await import(
      "../../lib/weletic/shopify/store-access-operator"
    );
    const input = await seed();
    await database.$executeRaw`UPDATE WeleticShopifyStore SET installationGeneration = 'generation_2' WHERE id = ${input.storeId}`;
    await expect(changeShopifyStoreAccess(input)).rejects.toThrow(
      "installation and revision",
    );
    expect(
      await database.weleticShopifyStoreAccessChange.count({
        where: { storeId: input.storeId },
      }),
    ).toBe(0);
  });
  it.each(["active", "lock_only"] as const)(
    "blocks suspended voucher adoption through %s mode",
    async (mode) => {
      const { changeShopifyStoreAccess } = await import(
        "../../lib/weletic/shopify/store-access-operator"
      );
      const { withLoyaltyProgramRowLock, assertLockedLoyaltyProgramActive } =
        await import("../../lib/weletic/loyalty/program-write-fence");
      const input = await seed();
      await changeShopifyStoreAccess(input);
      await changeShopifyStoreAccess({
        ...input,
        expectedRevision: 2,
        nextState: "suspended",
      });
      const remoteIssue = vi.fn();
      await expect(
        withLoyaltyProgramRowLock({
          storeId: input.storeId,
          mode,
          operation: async (_tx, program) => {
            assertLockedLoyaltyProgramActive(program);
            remoteIssue();
          },
        }),
      ).rejects.toMatchObject({ name: "LoyaltyProgramWriteBlockedError" });
      expect(remoteIssue).not.toHaveBeenCalled();
    },
  );
  it("blocks writes after suspension and preserves other tenants", async () => {
    const { changeShopifyStoreAccess } = await import(
      "../../lib/weletic/shopify/store-access-operator"
    );
    const { withShopifyStoreOperationalWriteFence } = await import(
      "../../lib/weletic/shopify/store-compliance-state"
    );
    const input = await seed();
    const other = await seed();
    await changeShopifyStoreAccess(input);
    await changeShopifyStoreAccess(other);
    await changeShopifyStoreAccess({
      ...input,
      expectedRevision: 2,
      nextState: "suspended",
    });
    const operation = vi.fn(async () => "written");
    await expect(
      withShopifyStoreOperationalWriteFence({
        storeId: input.storeId,
        action: "customer_sync",
        operation,
      }),
    ).rejects.toMatchObject({ complianceState: "suspended" });
    expect(operation).not.toHaveBeenCalled();
    await expect(
      withShopifyStoreOperationalWriteFence({
        storeId: other.storeId,
        action: "customer_sync",
        operation,
      }),
    ).resolves.toBe("written");
  });
  it("serializes suspension behind an already-running operational write", async () => {
    const { changeShopifyStoreAccess } = await import(
      "../../lib/weletic/shopify/store-access-operator"
    );
    const { withShopifyStoreOperationalWriteFence } = await import(
      "../../lib/weletic/shopify/store-compliance-state"
    );
    const input = await seed();
    await changeShopifyStoreAccess(input);
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const write = withShopifyStoreOperationalWriteFence({
      storeId: input.storeId,
      action: "customer_sync",
      operation: async () => {
        entered();
        await released;
        events.push("write");
      },
    });
    await locked;
    const suspend = changeShopifyStoreAccess({
      ...input,
      expectedRevision: 2,
      nextState: "suspended",
    }).then(() => {
      events.push("suspend");
    });
    release();
    await Promise.all([write, suspend]);
    expect(events).toEqual(["write", "suspend"]);
  });
});
