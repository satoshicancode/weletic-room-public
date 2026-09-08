import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditCanonicalDiscountCodes,
  DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
  migrateCanonicalDiscountCodes,
} from "../../scripts/loyalty/migrate-discount-code-canonical";

const mocks = vi.hoisted(() => ({
  nullableRowsQuery: vi.fn(),
  requiredModelFindMany: vi.fn(),
  backfillExecuteRaw: vi.fn(),
  programCount: vi.fn(),
  redemptionCount: vi.fn(),
  outboxCount: vi.fn(),
  reconciliationCount: vi.fn(),
  executeRaw: vi.fn(),
  reconciliationUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: mocks.executeRaw,
    weleticReconciliationIssue: { upsert: mocks.reconciliationUpsert },
  };
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  return {
    prisma: {
      weleticRewardRedemption: {
        findMany: mocks.requiredModelFindMany,
        count: mocks.redemptionCount,
      },
      weleticLoyaltyProgram: { count: mocks.programCount },
      weleticLoyaltyOutboxJob: { count: mocks.outboxCount },
      weleticReconciliationIssue: { count: mocks.reconciliationCount },
      $queryRaw: mocks.nullableRowsQuery,
      $executeRaw: mocks.backfillExecuteRaw,
      $transaction: mocks.transaction,
    },
  };
});

describe("canonical loyalty discount-code migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nullableRowsQuery.mockResolvedValue([]);
    mocks.requiredModelFindMany.mockRejectedValue(
      new Error("required Prisma model cannot deserialize stage-one NULL"),
    );
    mocks.backfillExecuteRaw.mockResolvedValue(1);
    mocks.programCount.mockResolvedValue(0);
    mocks.redemptionCount.mockResolvedValue(0);
    mocks.outboxCount.mockResolvedValue(0);
    mocks.reconciliationCount.mockResolvedValue(0);
    mocks.executeRaw.mockResolvedValue(1);
    mocks.reconciliationUpsert.mockResolvedValue({ id: "issue-1" });
  });

  it("audits canonical collisions deterministically within each store", () => {
    const audit = auditCanonicalDiscountCodes([
      {
        id: "redemption-b",
        storeId: "store-a",
        shopifyDiscountCode: " code-10 ",
      },
      {
        id: "redemption-a",
        storeId: "store-a",
        shopifyDiscountCode: "CODE-10",
      },
      {
        id: "redemption-c",
        storeId: "store-b",
        shopifyDiscountCode: "code-10",
      },
    ]);
    expect(audit.collisions).toEqual([
      {
        storeId: "store-a",
        canonicalCode: "CODE-10",
        redemptionIds: ["redemption-a", "redemption-b"],
      },
    ]);
    expect(audit.cleanGroups).toEqual([
      {
        storeId: "store-b",
        canonicalCode: "CODE-10",
        redemptionIds: ["redemption-c"],
      },
    ]);
  });

  it("treats composed, decomposed, and full-width equivalents with exact binary semantics", () => {
    const unicodeAudit = auditCanonicalDiscountCodes([
      {
        id: "composed",
        storeId: "store-unicode",
        shopifyDiscountCode: "RÉWARD-10",
      },
      {
        id: "decomposed",
        storeId: "store-unicode",
        shopifyDiscountCode: "re\u0301ward-10",
      },
      {
        id: "full-width",
        storeId: "store-unicode",
        shopifyDiscountCode: "ＲÉＷＡＲＤ－１０",
      },
    ]);

    expect(unicodeAudit.cleanGroups).toEqual([]);
    expect(unicodeAudit.collisions).toEqual([
      {
        storeId: "store-unicode",
        canonicalCode: "RÉWARD-10",
        redemptionIds: ["composed", "decomposed", "full-width"],
      },
    ]);
  });

  it("reports stale, null, and duplicate persisted canonical identities", () => {
    const audit = auditCanonicalDiscountCodes([
      {
        id: "correct",
        storeId: "store-a",
        shopifyDiscountCode: "first",
        shopifyDiscountCodeCanonical: "FIRST",
      },
      {
        id: "stale",
        storeId: "store-a",
        shopifyDiscountCode: "second",
        shopifyDiscountCodeCanonical: "FIRST",
      },
      {
        id: "null",
        storeId: "store-a",
        shopifyDiscountCode: "third",
        shopifyDiscountCodeCanonical: null,
      },
    ]);

    expect(audit.persistedCanonicalNullRows).toEqual([
      { id: "null", storeId: "store-a" },
    ]);
    expect(audit.persistedCanonicalMismatches).toEqual([
      {
        id: "stale",
        storeId: "store-a",
        expectedCanonical: "SECOND",
        persistedCanonical: "FIRST",
      },
    ]);
    expect(audit.persistedCanonicalDuplicates).toEqual([
      {
        storeId: "store-a",
        canonicalCode: "FIRST",
        redemptionIds: ["correct", "stale"],
      },
    ]);
  });

  it("loads nullable stage-one canonical rows without the required Prisma model", async () => {
    const stagedRow = {
      id: "stage-one-null",
      storeId: "store-stage-one",
      shopifyDiscountCode: "stage-one-code",
      shopifyDiscountCodeCanonical: null,
      settlementQuarantinedAt: null,
      settlementQuarantineReason: null,
    };
    mocks.nullableRowsQuery
      .mockResolvedValueOnce([stagedRow])
      .mockResolvedValueOnce([stagedRow]);

    const result = await migrateCanonicalDiscountCodes();

    expect(result.persistedCanonicalNullRows).toEqual([
      { id: stagedRow.id, storeId: stagedRow.storeId },
    ]);
    expect(mocks.requiredModelFindMany).not.toHaveBeenCalled();
    expect(mocks.nullableRowsQuery).toHaveBeenCalledTimes(2);
    for (const [statement] of mocks.nullableRowsQuery.mock.calls) {
      expect(statement.strings.join(" ")).toContain(
        "shopifyDiscountCodeCanonical",
      );
    }
  });

  it("quarantines collisions without mutating their raw code or financial status", async () => {
    const initialRows = [
      {
        id: "collision-1",
        storeId: "store-a",
        shopifyDiscountCode: "same-code",
        shopifyDiscountCodeCanonical: null,
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
      {
        id: "collision-2",
        storeId: "store-a",
        shopifyDiscountCode: " SAME-CODE ",
        shopifyDiscountCodeCanonical: null,
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
      {
        id: "clean-1",
        storeId: "store-a",
        shopifyDiscountCode: "clean-code",
        shopifyDiscountCodeCanonical: null,
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
    ];
    const finalRows = initialRows.map((row) =>
      row.id === "clean-1"
        ? { ...row, shopifyDiscountCodeCanonical: "CLEAN-CODE" }
        : {
            ...row,
            settlementQuarantinedAt: new Date("2026-08-30T00:00:00.000Z"),
            settlementQuarantineReason: "collision",
          },
    );
    mocks.nullableRowsQuery
      .mockResolvedValueOnce(initialRows)
      .mockResolvedValueOnce(finalRows);

    const result = await migrateCanonicalDiscountCodes({
      apply: true,
      maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
    });

    expect(result.readyForFinalConstraint).toBe(false);
    expect(result.collisionRows).toBe(2);
    expect(mocks.backfillExecuteRaw).toHaveBeenCalledTimes(1);
    const [backfillStatement] = mocks.backfillExecuteRaw.mock.calls[0];
    const backfillSql = backfillStatement.strings.join(" ");
    expect(backfillSql).toContain("SET shopifyDiscountCodeCanonical =");
    expect(backfillSql).toContain("shopifyDiscountCodeCanonical <=>");
    expect(backfillSql).toContain("settlementQuarantinedAt <=>");
    expect(backfillSql).toContain("settlementQuarantineReason <=>");
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    for (const [statement] of mocks.executeRaw.mock.calls) {
      const sqlText = statement.strings.join(" ");
      const updateClause = sqlText.split("WHERE")[0];
      expect(sqlText).toContain("shopifyDiscountCodeCanonical = NULL");
      expect(sqlText).toContain("settlementQuarantinedAt");
      expect(sqlText).toContain("shopifyDiscountCode =");
      expect(sqlText).toContain("shopifyDiscountCodeCanonical <=>");
      expect(sqlText).toContain("settlementQuarantinedAt <=>");
      expect(sqlText).toContain("settlementQuarantineReason <=>");
      expect(updateClause).not.toContain("shopifyDiscountCode =");
      expect(updateClause).not.toContain("status =");
      expect(updateClause).not.toContain("pointsSpent");
    }
    expect(mocks.reconciliationUpsert).toHaveBeenCalledTimes(1);
  });

  it("backfills canonical identity without clearing an existing quarantine", async () => {
    const quarantinedAt = new Date("2026-08-29T03:00:00.000Z");
    const initial = {
      id: "quarantined-clean-code",
      storeId: "store-a",
      shopifyDiscountCode: " clean-code ",
      shopifyDiscountCodeCanonical: null,
      settlementQuarantinedAt: quarantinedAt,
      settlementQuarantineReason: "independent financial review",
    };
    mocks.nullableRowsQuery
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([
        {
          ...initial,
          shopifyDiscountCodeCanonical: "CLEAN-CODE",
        },
      ]);

    const result = await migrateCanonicalDiscountCodes({
      apply: true,
      maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
    });

    const [statement] = mocks.backfillExecuteRaw.mock.calls[0];
    const updateClause = statement.strings.join(" ").split("WHERE")[0];
    expect(updateClause).toContain("shopifyDiscountCodeCanonical");
    expect(updateClause).not.toContain("settlementQuarantinedAt");
    expect(updateClause).not.toContain("settlementQuarantineReason");
    expect(statement.values).toEqual(
      expect.arrayContaining([
        "CLEAN-CODE",
        initial.id,
        initial.storeId,
        initial.shopifyDiscountCode,
        quarantinedAt,
        "independent financial review",
      ]),
    );
    expect(result.persistedQuarantineRows).toEqual([
      { id: initial.id, storeId: initial.storeId },
    ]);
    expect(result.readyForFinalConstraint).toBe(false);
  });

  it("fails closed when a raw code changes between audit and CAS backfill", async () => {
    mocks.nullableRowsQuery.mockResolvedValueOnce([
      {
        id: "raced-redemption",
        storeId: "store-a",
        shopifyDiscountCode: "code-before",
        shopifyDiscountCodeCanonical: null,
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
    ]);
    mocks.backfillExecuteRaw.mockResolvedValueOnce(0);

    await expect(
      migrateCanonicalDiscountCodes({
        apply: true,
        maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
      }),
    ).rejects.toThrow(
      "Canonical discount-code row raced-redemption changed during backfill.",
    );
  });

  it("re-audits persisted state and rejects a post-backfill raw-code mutation", async () => {
    mocks.nullableRowsQuery
      .mockResolvedValueOnce([
        {
          id: "raced-redemption",
          storeId: "store-a",
          shopifyDiscountCode: "code-before",
          shopifyDiscountCodeCanonical: null,
          settlementQuarantinedAt: null,
          settlementQuarantineReason: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "raced-redemption",
          storeId: "store-a",
          shopifyDiscountCode: "code-after",
          shopifyDiscountCodeCanonical: "CODE-BEFORE",
          settlementQuarantinedAt: null,
          settlementQuarantineReason: null,
        },
      ]);

    const result = await migrateCanonicalDiscountCodes({
      apply: true,
      maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
    });

    expect(result.readyForFinalConstraint).toBe(false);
    expect(result.persistedCanonicalMismatches).toEqual([
      {
        id: "raced-redemption",
        storeId: "store-a",
        expectedCanonical: "CODE-AFTER",
        persistedCanonical: "CODE-BEFORE",
      },
    ]);
  });

  it("quarantines invalid rows and retains an operator-visible issue", async () => {
    const initial = {
      id: "invalid-redemption",
      storeId: "store-a",
      shopifyDiscountCode: "   ",
      shopifyDiscountCodeCanonical: null,
      settlementQuarantinedAt: null,
      settlementQuarantineReason: null,
    };
    mocks.nullableRowsQuery
      .mockResolvedValueOnce([initial])
      .mockResolvedValueOnce([
        {
          ...initial,
          settlementQuarantinedAt: new Date("2026-08-30T00:00:00.000Z"),
          settlementQuarantineReason: "invalid",
        },
      ]);

    const result = await migrateCanonicalDiscountCodes({
      apply: true,
      maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
    });

    expect(result.readyForFinalConstraint).toBe(false);
    expect(result.invalidRows).toHaveLength(1);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.reconciliationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_discount_code_canonical_invalid",
          severity: "critical",
        }),
      }),
    );
  });

  it("requires the explicit maintenance fence and a drained database preflight", async () => {
    await expect(
      migrateCanonicalDiscountCodes({ apply: true }),
    ).rejects.toThrow("Refusing canonical discount-code writes");

    mocks.programCount.mockResolvedValueOnce(1);
    await expect(
      migrateCanonicalDiscountCodes({
        apply: true,
        maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
      }),
    ).rejects.toThrow("migration fence is not drained");

    expect(mocks.outboxCount).toHaveBeenCalledWith({
      where: {
        status: {
          in: ["pending", "processing", "failed", "dead_letter"],
        },
        jobType: {
          in: [
            "REDEMPTION_RECOVERY",
            "REFERRAL_REWARD_PROVISION",
            "VOUCHER_PRIVACY_CLEANUP",
          ],
        },
      },
    });
  });

  it("re-inspects the durable fence after the final persisted reload", async () => {
    const persisted = [
      {
        id: "ready-redemption",
        storeId: "store-a",
        shopifyDiscountCode: "ready-code",
        shopifyDiscountCodeCanonical: "READY-CODE",
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
    ];
    mocks.nullableRowsQuery
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted);
    mocks.outboxCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(
      migrateCanonicalDiscountCodes({
        apply: true,
        maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
      }),
    ).rejects.toThrow("migration fence is not drained");
    expect(mocks.outboxCount).toHaveBeenCalledTimes(2);
  });

  it("reports final-constraint readiness only for a global exact persisted audit", async () => {
    const persisted = [
      {
        id: "ready-redemption",
        storeId: "store-a",
        shopifyDiscountCode: " ready-code ",
        shopifyDiscountCodeCanonical: "READY-CODE",
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
    ];
    mocks.nullableRowsQuery
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted);
    const unacknowledgedResult = await migrateCanonicalDiscountCodes();
    expect(unacknowledgedResult.maintenanceAcknowledged).toBe(false);
    expect(unacknowledgedResult.readyForFinalConstraint).toBe(false);

    mocks.nullableRowsQuery
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted);
    const globalResult = await migrateCanonicalDiscountCodes({
      maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
    });
    expect(globalResult.maintenanceAcknowledged).toBe(true);
    expect(globalResult.readyForFinalConstraint).toBe(true);

    mocks.nullableRowsQuery
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted);
    const scopedResult = await migrateCanonicalDiscountCodes({
      storeId: "store-a",
    });
    expect(scopedResult.scopedAuditOnly).toBe(true);
    expect(scopedResult.readyForFinalConstraint).toBe(false);
  });

  it("blocks the final constraint for open or ignored canonical reconciliation issues", async () => {
    const persisted = [
      {
        id: "resolved-row",
        storeId: "store-a",
        shopifyDiscountCode: "resolved-code",
        shopifyDiscountCodeCanonical: "RESOLVED-CODE",
        settlementQuarantinedAt: null,
        settlementQuarantineReason: null,
      },
    ];
    mocks.nullableRowsQuery
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted);
    mocks.reconciliationCount.mockResolvedValueOnce(2);

    const result = await migrateCanonicalDiscountCodes({
      maintenanceFence: DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE,
    });

    expect(mocks.reconciliationCount).toHaveBeenCalledWith({
      where: {
        kind: {
          in: [
            "loyalty_discount_code_canonical_collision",
            "loyalty_discount_code_canonical_invalid",
          ],
        },
        status: { in: ["open", "ignored"] },
      },
    });
    expect(result.blockingReconciliationIssues).toBe(2);
    expect(result.readyForFinalConstraint).toBe(false);
  });
});
