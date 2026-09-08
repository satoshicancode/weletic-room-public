import {
  buildLoyaltyEarnPolicySnapshot,
  parseLoyaltyEarnPolicySnapshot,
  publishLoyaltyEarnPolicyRevision,
  resolveLoyaltyEarnPolicyRevisionAt,
  verifyLoyaltyEarnPolicyRevisionSnapshot,
} from "@/lib/weletic/loyalty/earn-policy-revision";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORE_ID = "store_policy_revision";
const OTHER_STORE_ID = "store_policy_revision_other";
const PROGRAM_ID = "program_policy_revision";
const EFFECTIVE_AT = new Date("2026-09-01T12:00:00.000Z");
const OCCURRED_AT = new Date("2026-09-01T12:30:00.000Z");

function canonicalJsonForTest(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJsonForTest(object[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintRawSnapshot(value: unknown) {
  return createHash("sha256").update(canonicalJsonForTest(value)).digest("hex");
}

function loyaltyProgram(overrides: Record<string, unknown> = {}) {
  return {
    id: PROGRAM_ID,
    storeId: STORE_ID,
    name: "Yamax Points",
    status: "active",
    pointNameSingular: "Point",
    pointNamePlural: "Points",
    pointsPerCurrencyUnit: new Prisma.Decimal("1.25"),
    holdingPeriodDays: 14,
    pointsExpiryMonths: 12,
    pointsExpiryDays: 0,
    pointsExpiryWarningDays: 30,
    pointsExpiryLastChanceDays: 3,
    pointsExpiryWarningEnabled: true,
    pointsExpiryLastChanceEnabled: true,
    pointsExpiryPolicyAnchorAt: new Date("2026-08-01T00:00:00.000Z"),
    pointsExpiryPolicyVersion: 2,
    earnPolicyVersion: 3,
    killSwitchActive: false,
    activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    disabledAt: null,
    vipMilestoneMode: "both",
    vipTimeframe: "rolling_12m",
    vipDowngradeGraceDays: 45,
    vipAutoDowngradeEnabled: true,
    branding: { accent: "#ffcc00" },
    metadata: { displayOnly: true },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-31T00:00:00.000Z"),
    earningRules: [
      {
        id: "rule_order_base",
        programId: PROGRAM_ID,
        name: "Order base",
        description: "Display-only description",
        triggerCode: "order_paid",
        ruleType: "multiplier",
        priority: 100,
        multiplier: new Prisma.Decimal("1.5"),
        fixedPoints: null,
        minOrderSubtotal: new Prisma.Decimal("12.34"),
        maxPointsPerEvent: BigInt("9007199254740993"),
        maxEventsPerCustomer: 5,
        limitInterval: "monthly",
        eligibleTierIds: ["tier_gold", "tier_silver"],
        conditions: {
          productTags: ["loyalty", "featured"],
          collections: ["gid://shopify/Collection/22"],
        },
        excludeDiscountedItems: true,
        excludeTaxesAndShipping: true,
        startAt: new Date("2026-08-01T00:00:00.000Z"),
        endAt: new Date("2026-10-01T00:00:00.000Z"),
        isActive: true,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        deletedAt: null,
      },
      {
        id: "rule_signup",
        programId: PROGRAM_ID,
        name: "Signup",
        description: null,
        triggerCode: "signup",
        ruleType: "fixed_points",
        priority: 50,
        multiplier: new Prisma.Decimal("1"),
        fixedPoints: BigInt(250),
        minOrderSubtotal: null,
        maxPointsPerEvent: BigInt(250),
        maxEventsPerCustomer: 1,
        limitInterval: "lifetime",
        eligibleTierIds: [],
        conditions: null,
        excludeDiscountedItems: false,
        excludeTaxesAndShipping: true,
        startAt: null,
        endAt: null,
        isActive: true,
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
        deletedAt: null,
      },
    ],
    bonusCampaigns: [
      {
        id: "campaign_double_points",
        programId: PROGRAM_ID,
        name: "Double points weekend",
        description: null,
        multiplier: new Prisma.Decimal("2.75"),
        startAt: new Date("2026-09-05T00:00:00.000Z"),
        endAt: new Date("2026-09-07T23:59:59.999Z"),
        isActive: true,
        eligibleTierIds: ["tier_silver", "tier_gold"],
        eligibleSkus: ["SKU-B", "SKU-A"],
        eligibleCollectionIds: [
          "gid://shopify/Collection/22",
          "gid://shopify/Collection/11",
        ],
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        deletedAt: null,
      },
    ],
    tiers: [
      {
        id: "tier_gold",
        programId: PROGRAM_ID,
        name: "Gold",
        slug: "gold",
        tierOrder: 3,
        minSpendThreshold: BigInt("12345678901234567"),
        minPointsThreshold: BigInt("9876543210987654"),
        pointsMultiplier: new Prisma.Decimal("1.75"),
        entryBonusPoints: BigInt(500),
        gracePeriodDays: 60,
        perks: [{ code: "priority_support" }],
        iconUrl: "https://cdn.example.com/gold.svg",
        color: "#FFD700",
        criteria: { retainedOrders: 3 },
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        deletedAt: null,
      },
      {
        id: "tier_silver",
        programId: PROGRAM_ID,
        name: "Silver",
        slug: "silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(50_000),
        minPointsThreshold: BigInt(5_000),
        pointsMultiplier: new Prisma.Decimal("1.25"),
        entryBonusPoints: BigInt(100),
        gracePeriodDays: null,
        perks: [],
        iconUrl: null,
        color: "#C0C0C0",
        criteria: null,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        deletedAt: null,
      },
    ],
    ...overrides,
  };
}

type TestRevision = {
  id: string;
  storeId: string;
  programId: string;
  version: number;
  effectiveAt: Date;
  schemaVersion: number;
  snapshot: unknown;
  fingerprint: string;
  reason: string | null;
  createdAt: Date;
};

function getIncrement(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "increment" in value &&
    typeof value.increment === "number"
  ) {
    return value.increment;
  }
  return null;
}

function mockTransaction({
  program = loyaltyProgram(),
  revisions = [],
}: {
  program?: ReturnType<typeof loyaltyProgram>;
  revisions?: TestRevision[];
} = {}) {
  let currentProgram = { ...program };
  const revisionRows = [...revisions];

  const findRevision = (args: any) => {
    const where = args?.where ?? {};
    const id = where.id ?? where.AND?.find?.((item: any) => item.id)?.id;
    const effectiveAtLimit =
      where.effectiveAt?.lte ??
      where.AND?.find?.((item: any) => item.effectiveAt)?.effectiveAt?.lte;

    return (
      revisionRows
        .filter((revision) => !id || revision.id === id)
        .filter(
          (revision) => !where.storeId || revision.storeId === where.storeId,
        )
        .filter(
          (revision) =>
            !where.programId || revision.programId === where.programId,
        )
        .filter(
          (revision) =>
            !effectiveAtLimit || revision.effectiveAt <= effectiveAtLimit,
        )
        .sort(
          (left, right) =>
            right.effectiveAt.getTime() - left.effectiveAt.getTime() ||
            right.version - left.version,
        )[0] ?? null
    );
  };

  const updateProgram = (args: any) => {
    const nextValue = args?.data?.earnPolicyVersion;
    const increment = getIncrement(nextValue);
    currentProgram = {
      ...currentProgram,
      earnPolicyVersion:
        increment === null
          ? nextValue ?? currentProgram.earnPolicyVersion
          : currentProgram.earnPolicyVersion + increment,
    };
    return currentProgram;
  };

  const tx: any = {
    $queryRaw: vi.fn().mockImplementation(async () => [currentProgram]),
    weleticLoyaltyProgram: {
      findFirst: vi.fn().mockImplementation(async () => currentProgram),
      findUnique: vi.fn().mockImplementation(async () => currentProgram),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => currentProgram),
      update: vi.fn().mockImplementation(async (args) => updateProgram(args)),
      updateMany: vi.fn().mockImplementation(async (args) => {
        const expectedVersion = args?.where?.earnPolicyVersion;
        if (
          typeof expectedVersion === "number" &&
          expectedVersion !== currentProgram.earnPolicyVersion
        ) {
          return { count: 0 };
        }
        updateProgram(args);
        return { count: 1 };
      }),
    },
    weleticLoyaltyEarnPolicyRevision: {
      findFirst: vi.fn().mockImplementation(async (args) => findRevision(args)),
      findUnique: vi
        .fn()
        .mockImplementation(async (args) => findRevision(args)),
      create: vi.fn().mockImplementation(async ({ data }) => {
        const revision = {
          id: data.id ?? `policy-revision-${data.version}`,
          ...data,
          createdAt: data.createdAt ?? new Date("2026-09-01T12:01:00.000Z"),
        } as TestRevision;
        revisionRows.push(revision);
        return revision;
      }),
    },
  };

  return { tx, revisionRows };
}

function persistedRevision(
  overrides: Partial<TestRevision> = {},
): TestRevision {
  const built = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());
  return {
    id: "policy_revision_3",
    storeId: STORE_ID,
    programId: PROGRAM_ID,
    version: 3,
    effectiveAt: EFFECTIVE_AT,
    schemaVersion: 1,
    snapshot: built.snapshot,
    fingerprint: built.fingerprint,
    reason: "baseline",
    createdAt: new Date("2026-09-01T12:00:01.000Z"),
    ...overrides,
  };
}

describe("immutable loyalty earn-policy revisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("canonical snapshot codec", () => {
    it("builds the same canonical snapshot and SHA-256 fingerprint regardless of relation order", () => {
      const left = loyaltyProgram();
      const right = loyaltyProgram({
        earningRules: [...left.earningRules].reverse().map((rule) => ({
          ...rule,
          eligibleTierIds: [...rule.eligibleTierIds].reverse(),
          conditions:
            rule.conditions === null
              ? null
              : {
                  collections: rule.conditions.collections,
                  productTags: rule.conditions.productTags,
                },
        })),
        bonusCampaigns: [...left.bonusCampaigns].reverse().map((campaign) => ({
          ...campaign,
          eligibleTierIds: [...campaign.eligibleTierIds].reverse(),
          eligibleSkus: [...campaign.eligibleSkus].reverse(),
          eligibleCollectionIds: [...campaign.eligibleCollectionIds].reverse(),
        })),
        tiers: [...left.tiers].reverse(),
      });

      const first = buildLoyaltyEarnPolicySnapshot(left);
      const second = buildLoyaltyEarnPolicySnapshot(right);

      expect(first.snapshot).toEqual(second.snapshot);
      expect(first.fingerprint).toBe(second.fingerprint);
      expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("changes the fingerprint when a financial policy value changes", () => {
      const original = loyaltyProgram();
      const changed = loyaltyProgram({
        earningRules: original.earningRules.map((rule, index) =>
          index === 0
            ? { ...rule, multiplier: new Prisma.Decimal("1.5001") }
            : rule,
        ),
      });

      expect(buildLoyaltyEarnPolicySnapshot(changed).fingerprint).not.toBe(
        buildLoyaltyEarnPolicySnapshot(original).fingerprint,
      );
    });

    it("changes the fingerprint when immutable campaign line targets change", () => {
      const original = loyaltyProgram();
      const changed = loyaltyProgram({
        bonusCampaigns: original.bonusCampaigns.map((campaign) => ({
          ...campaign,
          eligibleSkus: [...campaign.eligibleSkus, "SKU-C"],
        })),
      });

      expect(buildLoyaltyEarnPolicySnapshot(changed).fingerprint).not.toBe(
        buildLoyaltyEarnPolicySnapshot(original).fingerprint,
      );
    });

    it("excludes the operational kill switch from historical earning policy", () => {
      const running = buildLoyaltyEarnPolicySnapshot(
        loyaltyProgram({ killSwitchActive: false }),
      );
      const maintenancePaused = buildLoyaltyEarnPolicySnapshot(
        loyaltyProgram({ killSwitchActive: true }),
      );

      expect(maintenancePaused.fingerprint).toBe(running.fingerprint);
      expect(maintenancePaused.snapshot.program).not.toHaveProperty(
        "killSwitchActive",
      );
    });

    it("verifies the exact stored canonical JSON instead of a normalized reconstruction", () => {
      const built = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());
      const tampered = structuredClone(built.snapshot);
      tampered.program.pointsPerCurrencyUnit = "1.250";

      expect(() =>
        verifyLoyaltyEarnPolicyRevisionSnapshot({
          revisionId: "revision_exact_json",
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          schemaVersion: 1,
          snapshot: tampered,
          fingerprint: built.fingerprint,
          expectedStoreId: STORE_ID,
          expectedProgramId: PROGRAM_ID,
        }),
      ).toThrow(/fingerprint/i);
    });

    it("rejects a revision row whose scalar tenant identity disagrees with its program", () => {
      const built = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());

      expect(() =>
        verifyLoyaltyEarnPolicyRevisionSnapshot({
          revisionId: "revision_cross_tenant",
          storeId: OTHER_STORE_ID,
          programId: PROGRAM_ID,
          schemaVersion: 1,
          snapshot: built.snapshot,
          fingerprint: built.fingerprint,
          expectedStoreId: STORE_ID,
          expectedProgramId: PROGRAM_ID,
        }),
      ).toThrow(/tenant|store/i);
    });

    it.each([
      [
        "unknown nested field",
        (snapshot: any) => {
          snapshot.program.futureFinancialField = "future";
        },
      ],
      [
        "non-canonical numeric decimal",
        (snapshot: any) => {
          snapshot.program.pointsPerCurrencyUnit = 1.25;
        },
      ],
    ])("rejects a recomputed fingerprint over an %s", (_scenario, mutate) => {
      const built = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());
      const tampered = structuredClone(built.snapshot) as any;
      mutate(tampered);

      expect(() =>
        verifyLoyaltyEarnPolicyRevisionSnapshot({
          revisionId: "revision_noncanonical_nested",
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          schemaVersion: 1,
          snapshot: tampered,
          fingerprint: fingerprintRawSnapshot(tampered),
          expectedStoreId: STORE_ID,
          expectedProgramId: PROGRAM_ID,
        }),
      ).toThrow(/unknown|non-canonical/i);
    });

    it("serializes Decimal, BigInt, and Date values as canonical JSON and restores their types", () => {
      const { snapshot } = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());
      const json = JSON.stringify(snapshot);
      const persisted = snapshot as any;

      expect(json).toContain("9007199254740993");
      expect(persisted.program.pointsPerCurrencyUnit).toBe("1.25");
      expect(persisted.earningRules[0].minOrderSubtotal).toBe("12.34");
      expect(
        persisted.earningRules.find(
          (rule: { id: string }) => rule.id === "rule_order_base",
        ).maxPointsPerEvent,
      ).toBe("9007199254740993");
      expect(persisted.bonusCampaigns[0].startAt).toBe(
        "2026-09-05T00:00:00.000Z",
      );
      expect(
        persisted.tiers.find((tier: { id: string }) => tier.id === "tier_gold")
          .minSpendThreshold,
      ).toBe("12345678901234567");

      const parsed = parseLoyaltyEarnPolicySnapshot(snapshot) as any;
      const parsedRule = parsed.earningRules.find(
        (rule: { id: string }) => rule.id === "rule_order_base",
      );
      const parsedCampaign = parsed.bonusCampaigns.find(
        (campaign: { id: string }) => campaign.id === "campaign_double_points",
      );
      const parsedTier = parsed.tiers.find(
        (tier: { id: string }) => tier.id === "tier_gold",
      );

      expect(parsed.program.pointsPerCurrencyUnit).toBeInstanceOf(
        Prisma.Decimal,
      );
      expect(parsed.program.pointsPerCurrencyUnit.toString()).toBe("1.25");
      expect(parsedRule.maxPointsPerEvent).toBe(BigInt("9007199254740993"));
      expect(parsedRule.startAt).toEqual(new Date("2026-08-01T00:00:00.000Z"));
      expect(parsedCampaign.multiplier).toBeInstanceOf(Prisma.Decimal);
      expect(parsedCampaign.startAt).toEqual(
        new Date("2026-09-05T00:00:00.000Z"),
      );
      expect(parsedCampaign.eligibleSkus).toEqual(["SKU-A", "SKU-B"]);
      expect(parsedCampaign.eligibleCollectionIds).toEqual([
        "gid://shopify/Collection/11",
        "gid://shopify/Collection/22",
      ]);
      expect(parsedTier.minSpendThreshold).toBe(BigInt("12345678901234567"));
      expect(parsedTier.pointsMultiplier).toBeInstanceOf(Prisma.Decimal);
    });

    it("continues to verify legacy snapshots that predate line targeting", () => {
      const { snapshot } = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());
      const legacySnapshot = structuredClone(snapshot);
      delete legacySnapshot.bonusCampaigns[0].eligibleSkus;
      delete legacySnapshot.bonusCampaigns[0].eligibleCollectionIds;

      const parsed = verifyLoyaltyEarnPolicyRevisionSnapshot({
        revisionId: "revision_legacy_campaign",
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        schemaVersion: 1,
        snapshot: legacySnapshot,
        fingerprint: fingerprintRawSnapshot(legacySnapshot),
        expectedStoreId: STORE_ID,
        expectedProgramId: PROGRAM_ID,
      });

      expect(parsed.bonusCampaigns[0]).not.toHaveProperty("eligibleSkus");
      expect(parsed.bonusCampaigns[0]).not.toHaveProperty(
        "eligibleCollectionIds",
      );
    });

    it("rejects unsupported or malformed persisted snapshots instead of coercing them", () => {
      expect(() =>
        parseLoyaltyEarnPolicySnapshot({
          schemaVersion: 999,
          program: {},
          earningRules: [],
          bonusCampaigns: [],
          tiers: [],
        }),
      ).toThrow();

      const { snapshot } = buildLoyaltyEarnPolicySnapshot(loyaltyProgram());
      expect(() =>
        parseLoyaltyEarnPolicySnapshot({
          ...(snapshot as any),
          earningRules: [
            {
              ...(snapshot as any).earningRules[0],
              maxPointsPerEvent: "not-an-integer",
            },
          ],
        }),
      ).toThrow();

      expect(() =>
        parseLoyaltyEarnPolicySnapshot({
          ...(snapshot as any),
          earningRules: [
            {
              ...(snapshot as any).earningRules[0],
              isActive: "false",
            },
          ],
        }),
      ).toThrow("must be a boolean");
    });

    it.each([
      [
        "zero program earning rate",
        (program: any) => {
          program.pointsPerCurrencyUnit = new Prisma.Decimal(0);
        },
      ],
      [
        "non-positive rule multiplier",
        (program: any) => {
          program.earningRules[0].multiplier = new Prisma.Decimal(-1);
        },
      ],
      [
        "non-positive fixed-points amount",
        (program: any) => {
          program.earningRules[1].fixedPoints = BigInt(0);
        },
      ],
      [
        "negative order minimum",
        (program: any) => {
          program.earningRules[0].minOrderSubtotal = new Prisma.Decimal(-1);
        },
      ],
      [
        "non-positive event cap",
        (program: any) => {
          program.earningRules[0].maxPointsPerEvent = BigInt(0);
        },
      ],
      [
        "non-positive event count limit",
        (program: any) => {
          program.earningRules[0].maxEventsPerCustomer = 0;
        },
      ],
      [
        "incomplete event limit",
        (program: any) => {
          program.earningRules[0].limitInterval = null;
        },
      ],
      [
        "non-positive campaign multiplier",
        (program: any) => {
          program.bonusCampaigns[0].multiplier = new Prisma.Decimal(0);
        },
      ],
      [
        "reversed campaign window",
        (program: any) => {
          program.bonusCampaigns[0].endAt = new Date(
            "2026-09-04T00:00:00.000Z",
          );
        },
      ],
      [
        "negative tier spend threshold",
        (program: any) => {
          program.tiers[0].minSpendThreshold = BigInt(-1);
        },
      ],
      [
        "negative tier points threshold",
        (program: any) => {
          program.tiers[0].minPointsThreshold = BigInt(-1);
        },
      ],
      [
        "non-positive tier multiplier",
        (program: any) => {
          program.tiers[0].pointsMultiplier = new Prisma.Decimal(0);
        },
      ],
      [
        "negative tier entry bonus",
        (program: any) => {
          program.tiers[0].entryBonusPoints = BigInt(-1);
        },
      ],
    ])("rejects a %s", (_scenario, mutate) => {
      const program = loyaltyProgram();
      mutate(program);
      expect(() => buildLoyaltyEarnPolicySnapshot(program)).toThrow();
    });
  });

  describe("revision publication", () => {
    it("returns the existing head without incrementing or writing when the fingerprint is unchanged", async () => {
      const head = persistedRevision();
      const { tx } = mockTransaction({ revisions: [head] });

      const result = await publishLoyaltyEarnPolicyRevision({
        tx,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
        reason: "duplicate admin save",
      });

      expect(result).toBe(head);
      expect(tx.weleticLoyaltyEarnPolicyRevision.create).not.toHaveBeenCalled();
      expect(tx.weleticLoyaltyProgram.update).not.toHaveBeenCalled();
      expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
    });

    it("increments the program version and creates one immutable revision for a changed fingerprint", async () => {
      const stalePolicy = buildLoyaltyEarnPolicySnapshot(
        loyaltyProgram({ pointsPerCurrencyUnit: new Prisma.Decimal("1") }),
      );
      const staleHead = persistedRevision({
        fingerprint: stalePolicy.fingerprint,
        snapshot: stalePolicy.snapshot,
      });
      const { tx } = mockTransaction({ revisions: [staleHead] });
      const effectiveAt = new Date("2026-09-02T00:00:00.000Z");

      const result = await publishLoyaltyEarnPolicyRevision({
        tx,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        effectiveAt,
        reason: "earning rule updated",
      });

      expect(result).toMatchObject({
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        version: 4,
        effectiveAt,
        schemaVersion: 1,
        reason: "earning rule updated",
      });
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(tx.weleticLoyaltyEarnPolicyRevision.create).toHaveBeenCalledTimes(
        1,
      );
      expect(
        tx.weleticLoyaltyEarnPolicyRevision.create.mock.calls[0][0].data,
      ).toMatchObject({
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        version: 4,
        effectiveAt,
        reason: "earning rule updated",
      });
    });

    it("fails closed instead of deduplicating against a corrupt revision head", async () => {
      const head = persistedRevision({
        snapshot: { corrupted: true },
      });
      const { tx } = mockTransaction({ revisions: [head] });

      await expect(
        publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
          reason: "unchanged admin save",
        }),
      ).rejects.toThrow(/fingerprint|snapshot|schema|canonical/i);

      expect(tx.weleticLoyaltyEarnPolicyRevision.create).not.toHaveBeenCalled();
      expect(tx.weleticLoyaltyProgram.updateMany).not.toHaveBeenCalled();
    });

    it("fails closed when the loaded aggregate belongs to another store", async () => {
      const { tx } = mockTransaction({
        program: loyaltyProgram({ storeId: OTHER_STORE_ID }),
      });

      await expect(
        publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          effectiveAt: EFFECTIVE_AT,
          reason: "cross-tenant attempt",
        }),
      ).rejects.toThrow(/store|tenant|program/i);

      expect(tx.weleticLoyaltyEarnPolicyRevision.create).not.toHaveBeenCalled();
    });
  });

  describe("event-time resolution", () => {
    it("returns the newest eligible revision and a fully decoded policy", async () => {
      const older = persistedRevision({
        id: "policy_revision_2",
        version: 2,
        effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      const current = persistedRevision();
      const { tx } = mockTransaction({ revisions: [older, current] });

      const result = await resolveLoyaltyEarnPolicyRevisionAt({
        tx,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        occurredAt: OCCURRED_AT,
      });

      expect(result?.revision).toBe(current);
      expect(
        (result?.policy as any).program.pointsPerCurrencyUnit,
      ).toBeInstanceOf(Prisma.Decimal);
    });

    it("returns null when no revision existed at the event time", async () => {
      const { tx } = mockTransaction({ revisions: [] });

      await expect(
        resolveLoyaltyEarnPolicyRevisionAt({
          tx,
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          occurredAt: OCCURRED_AT,
        }),
      ).resolves.toBeNull();
    });

    it("honors an older order-bound preferred revision after newer policies are published", async () => {
      const preferred = persistedRevision({
        id: "policy_revision_order_bound",
        version: 2,
        effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      const newer = persistedRevision({
        id: "policy_revision_newer",
        version: 3,
      });
      const { tx } = mockTransaction({ revisions: [newer, preferred] });

      const result = await resolveLoyaltyEarnPolicyRevisionAt({
        tx,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        occurredAt: OCCURRED_AT,
        preferredRevisionId: preferred.id,
      });

      expect(result?.revision).toBe(preferred);
    });

    it.each([
      {
        label: "another store",
        revision: persistedRevision({ storeId: OTHER_STORE_ID }),
      },
      {
        label: "another program",
        revision: persistedRevision({ programId: "program_other" }),
      },
      {
        label: "the future",
        revision: persistedRevision({
          effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
        }),
      },
    ])(
      "rejects a preferred revision from $label instead of silently falling back",
      async ({ revision }) => {
        const { tx } = mockTransaction({ revisions: [revision] });
        tx.weleticLoyaltyEarnPolicyRevision.findUnique.mockResolvedValueOnce(
          revision,
        );
        tx.weleticLoyaltyEarnPolicyRevision.findFirst.mockResolvedValueOnce(
          revision,
        );

        await expect(
          resolveLoyaltyEarnPolicyRevisionAt({
            tx,
            storeId: STORE_ID,
            programId: PROGRAM_ID,
            occurredAt: OCCURRED_AT,
            preferredRevisionId: revision.id,
          }),
        ).rejects.toThrow(/store|tenant|program|future|effective|event/i);
      },
    );

    it("fails closed if an eligible revision contains a malformed snapshot", async () => {
      const malformed = persistedRevision({
        snapshot: {
          schemaVersion: 1,
          program: { pointsPerCurrencyUnit: "NaN" },
          earningRules: [],
          bonusCampaigns: [],
          tiers: [],
        },
      });
      const { tx } = mockTransaction({ revisions: [malformed] });

      await expect(
        resolveLoyaltyEarnPolicyRevisionAt({
          tx,
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          occurredAt: OCCURRED_AT,
        }),
      ).rejects.toThrow();
    });

    it("fails closed if the database returns a future revision for an event-time lookup", async () => {
      const future = persistedRevision({
        effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
      });
      const { tx } = mockTransaction({ revisions: [future] });
      tx.weleticLoyaltyEarnPolicyRevision.findFirst.mockResolvedValueOnce(
        future,
      );

      await expect(
        resolveLoyaltyEarnPolicyRevisionAt({
          tx,
          storeId: STORE_ID,
          programId: PROGRAM_ID,
          occurredAt: OCCURRED_AT,
        }),
      ).rejects.toThrow(/future|effective|event/i);
    });
  });
});
