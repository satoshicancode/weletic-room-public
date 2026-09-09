import {
  Prisma,
  PrismaClient,
  type WeleticLoyaltyAccount,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  captureHistoricalImportFields,
  planHistoricalImportFieldRestoration,
} from "../../lib/weletic/loyalty/historical-import-fields";
import {
  postImportOpeningBalanceInTransaction,
  reverseImportOpeningBalanceInTransaction,
} from "../../lib/weletic/loyalty/historical-import-ledger";
import { reconcileHistoricalImportLedger } from "../../lib/weletic/loyalty/historical-import-reconciliation";
import { appendPointsLedgerEntry } from "../../lib/weletic/loyalty/ledger";

const database = new PrismaClient();
const stores: string[] = [];
let safeToClean = false;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.HISTORICAL_IMPORT_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== "/weletic_loyalty_dev"
  )
    throw new Error("Refusing non-isolated historical import database");
  expect(
    await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
  ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
  safeToClean = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in import DB tests");
    }),
  );
});
afterAll(async () => {
  if (safeToClean && stores.length) {
    const where = { storeId: { in: stores } };
    await database.weleticPointsLedgerEntry.deleteMany({ where });
    await database.weleticLoyaltyAccount.deleteMany({ where });
    await database.weleticShopper.deleteMany({ where });
    await database.weleticLoyaltyProgram.deleteMany({ where });
    await database.weleticShopifyStore.deleteMany({
      where: { id: { in: stores } },
    });
  }
  vi.unstubAllGlobals();
  await database.$disconnect();
});
async function seed() {
  const storeId = `import-db-${randomUUID()}`;
  stores.push(storeId);
  const programId = `program-${storeId}`;
  const shopperId = `shopper-${storeId}`;
  const accountId = `account-${storeId}`;
  await database.weleticShopifyStore.create({
    data: {
      id: storeId,
      projectId: `workspace-${storeId}`,
      programId: `affiliate-${storeId}`,
      shopDomain: `${storeId}.myshopify.com`,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      apiVersion: "2026-07",
      installationGeneration: "g1",
    },
  });
  await database.weleticLoyaltyProgram.create({
    data: {
      id: programId,
      storeId,
      name: "Isolated import test",
      status: "active",
      killSwitchActive: false,
    },
  });
  await database.weleticShopper.create({
    data: { id: shopperId, storeId, shopifyCustomerId: "123" },
  });
  await database.weleticLoyaltyAccount.create({
    data: { id: accountId, storeId, programId, shopperId, status: "active" },
  });
  return {
    storeId,
    programId,
    shopperId,
    accountId,
    sourceId: `source-${storeId}`,
    snapshotId: `snapshot-${storeId}`,
    normalizedSha256: "a".repeat(64),
    openingBalance: BigInt("9007199254740993"),
    expectedLedgerVersion: 0,
  };
}
const options = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 20_000,
};

it("restores birthday and expiry fields atomically with correction without replacing unrelated metadata", async () => {
  const input = await seed();
  const initial = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: input.accountId },
  });
  const before = captureHistoricalImportFields(initial);
  const original = await database.$transaction(
    (tx) => postImportOpeningBalanceInTransaction({ ...input, tx }),
    options,
  );
  const applied = await database.weleticLoyaltyAccount.update({
    where: { id: input.accountId },
    data: {
      metadata: {
        birthday: {
          birthDate: "2000-02-29",
          registeredAt: "2026-09-09T00:00:00.000Z",
        },
      },
    },
  });
  const after = captureHistoricalImportFields(applied);
  await database.weleticLoyaltyAccount.update({
    where: { id: input.accountId },
    data: {
      metadata: {
        ...(applied.metadata as Prisma.JsonObject),
        unrelatedModule: "keep current value",
      },
    },
  });
  await database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<WeleticLoyaltyAccount[]>(
      Prisma.sql`SELECT * FROM WeleticLoyaltyAccount WHERE id = ${input.accountId} AND storeId = ${input.storeId} FOR UPDATE`,
    );
    const patch = planHistoricalImportFieldRestoration({
      before,
      after,
      current: rows[0],
    });
    await reverseImportOpeningBalanceInTransaction({
      ...input,
      tx,
      originalLedgerEntryId: original.id,
      expectedLedgerVersion: original.sequenceNumber,
    });
    const changed = await tx.weleticLoyaltyAccount.updateMany({
      where: {
        id: input.accountId,
        storeId: input.storeId,
        ledgerVersion: original.sequenceNumber + 1,
      },
      data: patch,
    });
    expect(changed.count).toBe(1);
  }, options);
  const restored = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: input.accountId },
  });
  expect(restored.cachedPointsBalance).toBe(BigInt(0));
  expect(restored.metadata).toEqual({ unrelatedModule: "keep current value" });
  expect(captureHistoricalImportFields(restored)).toEqual(before);
});

it("appends rollback and preserves the original ledger entry", async () => {
  const input = await seed();
  const original = await database.$transaction(
    (tx) => postImportOpeningBalanceInTransaction({ ...input, tx }),
    options,
  );
  await database.$transaction(
    (tx) =>
      reverseImportOpeningBalanceInTransaction({
        ...input,
        tx,
        originalLedgerEntryId: original.id,
        expectedLedgerVersion: original.sequenceNumber,
      }),
    options,
  );
  const entries = await database.weleticPointsLedgerEntry.findMany({
    where: { storeId: input.storeId },
    orderBy: { sequenceNumber: "asc" },
  });
  expect(entries).toHaveLength(2);
  expect(entries[0].id).toBe(original.id);
  expect(entries[1].pointsDelta).toBe(-input.openingBalance);
  expect(entries[1].referenceType).toBe("LOYALTY_IMPORT_ROLLBACK");
  expect(
    reconcileHistoricalImportLedger({
      storeId: input.storeId,
      sourceId: input.sourceId,
      normalizedSha256: input.normalizedSha256,
      rows: [
        {
          snapshotId: input.snapshotId,
          accountId: input.accountId,
          openingBalance: input.openingBalance,
          status: "rolled_back",
          ledgerEntryId: original.id,
          reversalLedgerEntryId: entries[1].id,
        },
      ],
      entries,
    }),
  ).toMatchObject({
    reconciled: true,
    fullyRolledBack: true,
    observedNetPoints: "0",
  });
  const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: input.accountId },
  });
  expect(account.cachedPointsBalance).toBe(BigInt(0));
  expect(account.lifetimePointsEarned).toBe(BigInt(0));
});
it("contains rollback after subsequent account activity", async () => {
  const input = await seed();
  const original = await database.$transaction(
    (tx) => postImportOpeningBalanceInTransaction({ ...input, tx }),
    options,
  );
  await database.$transaction(
    (tx) =>
      appendPointsLedgerEntry({
        tx,
        storeId: input.storeId,
        accountId: input.accountId,
        entryType: "MANUAL_ADJUSTMENT",
        pointsDelta: BigInt(1),
        idempotencyKey: "later-fixture-activity",
      }),
    options,
  );
  await expect(
    database.$transaction(
      (tx) =>
        reverseImportOpeningBalanceInTransaction({
          ...input,
          tx,
          originalLedgerEntryId: original.id,
          expectedLedgerVersion: original.sequenceNumber,
        }),
      options,
    ),
  ).rejects.toThrow("requires containment");
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(2);
  expect(
    (
      await database.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: input.accountId },
      })
    ).cachedPointsBalance,
  ).toBe(input.openingBalance + BigInt(1));
});
it("allows only one of two concurrent rollback attempts", async () => {
  const input = await seed();
  const original = await database.$transaction(
    (tx) => postImportOpeningBalanceInTransaction({ ...input, tx }),
    options,
  );
  const outcomes = await Promise.allSettled(
    [0, 1].map(() =>
      database.$transaction(
        (tx) =>
          reverseImportOpeningBalanceInTransaction({
            ...input,
            tx,
            originalLedgerEntryId: original.id,
            expectedLedgerVersion: original.sequenceNumber,
          }),
        options,
      ),
    ),
  );
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const loser = outcomes.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  expect(loser.reason.message).toBe(
    "Historical import rollback requires containment",
  );
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(2);
});

it("posts an exact opening balance without lifetime earns or synthetic outbox events", async () => {
  const input = await seed();
  await database.$transaction(
    (tx) => postImportOpeningBalanceInTransaction({ ...input, tx }),
    options,
  );
  const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: input.accountId },
  });
  expect(account.cachedPointsBalance).toBe(input.openingBalance);
  expect(account.lifetimePointsEarned).toBe(BigInt(0));
  expect(account.cachedPendingPoints).toBe(BigInt(0));
  expect(account.ledgerVersion).toBe(1);
  expect(
    await database.weleticLoyaltyEarnGrant.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(0);
  expect(
    await database.weleticLoyaltyOutboxJob.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(0);
  const entries = await database.weleticPointsLedgerEntry.findMany({
    where: { storeId: input.storeId },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: input.openingBalance,
    referenceType: "LOYALTY_IMPORT_OPENING_BALANCE",
    referenceId: input.snapshotId,
  });
});
it("permits only one competing write from the same account version", async () => {
  const input = await seed();
  const outcomes = await Promise.allSettled(
    [0, 1].map((index) =>
      database.$transaction(
        (tx) =>
          postImportOpeningBalanceInTransaction({
            ...input,
            snapshotId: `${input.snapshotId}-${index}`,
            tx,
          }),
        options,
      ),
    ),
  );
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = outcomes.find(
    (outcome) => outcome.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason.message).toBe(
    "Opening-balance account revision changed",
  );
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(1);
  expect(
    (
      await database.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: input.accountId },
      })
    ).cachedPointsBalance,
  ).toBe(input.openingBalance);
});
it("rejects current closure even when Repeatable Read retains an earlier active snapshot", async () => {
  const input = await seed();
  await expect(
    database.$transaction(async (tx) => {
      const initial = await tx.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: input.accountId },
      });
      expect(initial.status).toBe("active");
      // Separate connection commits the same status/metadata changes used by
      // closure, without changing ledgerVersion. This is not full privacy rollout.
      await database.weleticLoyaltyAccount.update({
        where: { id: input.accountId },
        data: { status: "closed", metadata: { closureFixture: true } },
      });
      const stale = await tx.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: input.accountId },
      });
      expect(stale.status).toBe("active");
      expect(stale.ledgerVersion).toBe(0);
      return postImportOpeningBalanceInTransaction({ ...input, tx });
    }, options),
  ).rejects.toThrow("account unavailable");
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(0);
});
it("rolls back the real ledger and cached balance if the enclosing operation fails", async () => {
  const input = await seed();
  await expect(
    database.$transaction(async (tx) => {
      await postImportOpeningBalanceInTransaction({ ...input, tx });
      throw new Error("simulate row-execution failure");
    }, options),
  ).rejects.toThrow("row-execution failure");
  const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: input.accountId },
  });
  expect(account.cachedPointsBalance).toBe(BigInt(0));
  expect(account.ledgerVersion).toBe(0);
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: input.storeId },
    }),
  ).toBe(0);
});
it("rejects an account selected through another tenant", async () => {
  const input = await seed();
  const other = await seed();
  await expect(
    database.$transaction(
      (tx) =>
        postImportOpeningBalanceInTransaction({
          ...input,
          storeId: other.storeId,
          tx,
        }),
      options,
    ),
  ).rejects.toThrow("account unavailable");
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: { in: [input.storeId, other.storeId] } },
    }),
  ).toBe(0);
});
