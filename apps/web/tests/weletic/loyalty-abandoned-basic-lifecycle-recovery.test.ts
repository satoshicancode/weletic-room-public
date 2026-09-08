import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BasicLifecycleRecoveryCapsuleFile,
  readBasicLifecycleRecoveryCapsuleFile,
  sha256BasicLifecycleFile,
} from "../../scripts/loyalty/basic-lifecycle-recovery-capsule";
import {
  assertAbandonedBasicLifecycleDefinitionDiff,
  assertAbandonedBasicLifecycleFamilyDiff,
  assertAbandonedBasicLifecycleIngressOwnership,
  assertAbandonedBasicLifecycleProgramDiff,
  assertAbandonedBasicLifecycleProjectionGraph,
  assertAbandonedBasicLifecycleRecoverySafety,
  assertAbandonedBasicLifecycleRecoveryState,
  assertAbandonedOperationalBaselineBoundary,
  assertAbandonedRecoveryLeasePreservesOriginalOwnership,
  deriveAbandonedOperationalBaselineSnapshot,
  isAbandonedBasicLifecycleFixtureCreatedWithinLease,
  parseAbandonedBasicLifecycleRecoveryArgs,
  parseFailedBasicLifecycleReport,
  readExistingPassedRecoveryReport,
  writeAbandonedBasicLifecycleRecoveryReport,
  type RecoveryReport,
} from "../../scripts/loyalty/recover-abandoned-basic-lifecycle";

const RUN_MARKER = "weletic-a1-0123456789abcdef";
const PROGRAM_ID = "program_a1";
const STORE_ID = "store_a1";
const ACQUIRED_AT = new Date("2026-08-31T00:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-31T00:30:00.000Z");
const RECOVERY_AFTER = new Date("2026-08-31T06:00:00.000Z");
const RECOVERY_CHECK_NAMES = [
  "Exact current and recovered baseline tenant",
  "Expired abandoned maintenance generation",
  "Exact baseline metadata and program diff",
  "Exact lease-owned Shopify fixture discovery",
  "Exact temporary definition diff",
  "Exhaustive early-phase family and ingress closure",
  "Expired lease exact-generation takeover",
  "Exact fixture outbox quiescence",
  "Exact remote fixture deletion under customer locks",
  "Remote absence and stable local closure",
  "Canonical local cleanup and baseline program restore",
  "Two-pass zero-residue and baseline-outbox verification",
  "Atomic maintenance release and exact program baseline",
] as const;
const temporaryDirectories: string[] = [];
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (originalEncryptionKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  }
});

function timestamped(row: Record<string, unknown>, index: number) {
  const createdAt = new Date(ACQUIRED_AT.getTime() + index * 1_000);
  return { ...row, createdAt, updatedAt: createdAt };
}

function privateTemporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "weletic-a1-abandoned-state-"),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function recoveryStateFixture() {
  const digest = "a".repeat(64);
  const secondDigest = "b".repeat(64);
  const originalLease = {
    acquiredAt: ACQUIRED_AT.toISOString(),
    baselineMetadataSha256: digest,
    fixtureDisposableTagSha256: secondDigest,
    fixtureEmailSha256: [
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
      "0".repeat(64),
    ],
    fixtureRunMarkerTagSha256: "f".repeat(64),
    ownerTokenSha256: "1".repeat(64),
    recoveryAfter: RECOVERY_AFTER.toISOString(),
  };
  return {
    version: 3,
    phase: "remote_cleanup_started",
    sourceReport: {
      version: 3,
      sha256: "2".repeat(64),
      startedAt: ACQUIRED_AT.toISOString(),
      completedAt: COMPLETED_AT.toISOString(),
    },
    bindings: {
      failedReportPathSha256: "3".repeat(64),
      reportPathSha256: "4".repeat(64),
      storeDomainSha256: "5".repeat(64),
      tenantTupleSha256: "6".repeat(64),
      baselineProgramSha256: "7".repeat(64),
      sourceRecoveryCapsuleSha256: "c".repeat(64),
      historicalBaselineSnapshotSha256: "8".repeat(64),
      operationalBaselineSnapshotSha256: "b".repeat(64),
      preflightSnapshotSha256: "9".repeat(64),
    },
    originalLease,
    ownerToken: "recovery-owner-token-with-at-least-32-bytes",
    runMarker: RUN_MARKER,
    store: {
      id: STORE_ID,
      projectId: "workspace_a1",
      programId: "platform_program_a1",
      installationGeneration: "generation_a1",
      shopCurrency: "JPY",
    },
    remoteCustomers: [
      {
        id: "gid://shopify/Customer/1001",
        numericId: "1001",
        email: `${RUN_MARKER}-advocate@example.com`,
        firstName: "A1",
        lastName: "advocate",
        tags: ["weletic-a1-disposable", RUN_MARKER],
        createdAt: new Date(ACQUIRED_AT.getTime() + 1_000).toISOString(),
        outcome: "deleted",
      },
      {
        id: "gid://shopify/Customer/1002",
        numericId: "1002",
        email: `${RUN_MARKER}-referee@example.com`,
        firstName: "A1",
        lastName: "referee",
        tags: ["weletic-a1-disposable", RUN_MARKER],
        createdAt: new Date(ACQUIRED_AT.getTime() + 2_000).toISOString(),
        outcome: "delete_outcome_unknown",
      },
    ],
    retainedAuditIds: ["audit_a1"],
    fixtureShopperIds: ["shopper_a1"],
    fixtureAccountIds: ["account_a1"],
    fixtureLedgerIds: ["ledger_a1"],
    temporaryRuleIds: ["rule_signup", "rule_birthday"],
    temporaryTierIds: ["tier_member", "tier_vip"],
    temporaryReferralRuleIds: ["rule_referral"],
    temporaryRewardIds: ["reward_amount_off"],
    signupRuleId: "rule_signup",
  };
}

function exactDefinitionFixture() {
  return {
    baseline: {
      rules: [],
      tiers: [],
      referralRules: [],
      rewards: [],
    },
    current: {
      rules: [
        timestamped(
          {
            id: "wrule_signup",
            programId: PROGRAM_ID,
            name: "A1 signup validation",
            description: null,
            triggerCode: "account_created",
            ruleType: "fixed_points",
            priority: 2_000_000_000,
            multiplier: "1",
            fixedPoints: BigInt(500),
            minOrderSubtotal: null,
            maxPointsPerEvent: null,
            maxEventsPerCustomer: null,
            limitInterval: null,
            eligibleTierIds: null,
            conditions: null,
            excludeDiscountedItems: false,
            excludeTaxesAndShipping: true,
            startAt: null,
            endAt: null,
            isActive: true,
          },
          1,
        ),
        timestamped(
          {
            id: "wrule_birthday",
            programId: PROGRAM_ID,
            name: "A1 birthday validation",
            description: null,
            triggerCode: "birthday",
            ruleType: "fixed_points",
            priority: 2_000_000_000,
            multiplier: "1",
            fixedPoints: BigInt(75),
            minOrderSubtotal: null,
            maxPointsPerEvent: null,
            maxEventsPerCustomer: null,
            limitInterval: null,
            eligibleTierIds: null,
            conditions: null,
            excludeDiscountedItems: false,
            excludeTaxesAndShipping: true,
            startAt: null,
            endAt: null,
            isActive: true,
          },
          2,
        ),
      ],
      tiers: [
        timestamped(
          {
            id: "wtier_member",
            programId: PROGRAM_ID,
            name: "A1 Member",
            slug: `${RUN_MARKER}-member`,
            tierOrder: 100,
            minSpendThreshold: BigInt(0),
            minPointsThreshold: BigInt(0),
            pointsMultiplier: "1",
            entryBonusPoints: BigInt(0),
            gracePeriodDays: null,
            perks: null,
            iconUrl: null,
            color: null,
            criteria: null,
          },
          3,
        ),
        timestamped(
          {
            id: "wtier_vip",
            programId: PROGRAM_ID,
            name: "A1 VIP",
            slug: `${RUN_MARKER}-vip`,
            tierOrder: 101,
            minSpendThreshold: BigInt(0),
            minPointsThreshold: BigInt(2_000),
            pointsMultiplier: "1.25",
            entryBonusPoints: BigInt(0),
            gracePeriodDays: null,
            perks: null,
            iconUrl: null,
            color: null,
            criteria: null,
          },
          4,
        ),
      ],
      referralRules: [
        timestamped(
          {
            id: "wrule_referral",
            programId: PROGRAM_ID,
            advocatePointsReward: BigInt(125),
            refereePointsReward: BigInt(50),
            advocateRewardKind: "points",
            refereeRewardKind: "points",
            advocateRewardDefinitionId: null,
            refereeRewardDefinitionId: null,
            minQualifyingOrderSubtotal: "100",
            maxReferralsPerAdvocate: 10,
            fraudCheckSameIp: false,
            isActive: true,
          },
          5,
        ),
      ],
      rewards: [
        timestamped(
          {
            id: "wreward_a1",
            storeId: STORE_ID,
            name: `A1 amount-off ${RUN_MARKER}`,
            description: null,
            rewardType: "amount_off",
            exchangeType: "fixed",
            pointsCost: BigInt(50),
            pointsStep: null,
            minPointsCost: null,
            maxPointsCost: null,
            discountValue: "100",
            maxDiscountValue: null,
            minOrderAmount: null,
            status: "active",
            shopifyPriceRuleId: null,
            appliesToResource: "entire_order",
            entitledCollectionIds: null,
            entitledProductIds: null,
            entitledVariantIds: null,
            combinesWithProductDiscounts: false,
            combinesWithOrderDiscounts: false,
            combinesWithShippingDiscounts: false,
            usageLimit: null,
            usageLimitPerCustomer: 0,
            expiresInDays: 7,
          },
          6,
        ),
      ],
    },
  };
}

describe("abandoned A1 recovery safety", () => {
  it("publishes restored policy before an abandoned maintenance generation can be released", () => {
    const source = fs.readFileSync(
      new URL(
        "../../scripts/loyalty/recover-abandoned-basic-lifecycle.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const reason of [
      'reason: "a1_abandoned_recovery_policy_restored"',
      'reason: "a1_abandoned_recovery_release_policy_verified"',
    ]) {
      const reasonIndex = source.indexOf(reason);
      expect(reasonIndex).toBeGreaterThan(0);
      expect(
        source.slice(Math.max(0, reasonIndex - 220), reasonIndex),
      ).toContain("publishLoyaltyEarnPolicyRevision({");
      expect(
        source.slice(Math.max(0, reasonIndex - 120), reasonIndex),
      ).toContain("tx,");
    }
    expect(source).toContain(
      'withoutKeys(baseline, ["metadata", "updatedAt", "earnPolicyVersion"])',
    );
    expect(source).toContain('withoutKeys(baseline, ["earnPolicyVersion"])');
  });

  it("requires every explicit recovery input", () => {
    expect(
      parseAbandonedBasicLifecycleRecoveryArgs([
        "--confirm-staging",
        "--confirm-abandoned-recovery",
        "--store=example.myshopify.com",
        "--failed-report=/tmp/failed.json",
        "--baseline-db-url=mysql://readonly@localhost/baseline",
        "--report=/tmp/recovery.json",
        "--recovery-state=/tmp/recovery-state.json",
      ]),
    ).toEqual({
      confirmStaging: true,
      confirmAbandonedRecovery: true,
      storeDomain: "example.myshopify.com",
      failedReportPath: "/tmp/failed.json",
      baselineDatabaseUrl: "mysql://readonly@localhost/baseline",
      reportPath: "/tmp/recovery.json",
      recoveryStatePath: "/tmp/recovery-state.json",
    });
    expect(() =>
      parseAbandonedBasicLifecycleRecoveryArgs(["--unknown"]),
    ).toThrow(/Unsupported/);
    expect(
      parseAbandonedBasicLifecycleRecoveryArgs([
        "--source-recovery-state=/tmp/source-recovery-state.json",
      ]).sourceRecoveryStatePath,
    ).toBe("/tmp/source-recovery-state.json");
  });

  it("accepts only a separate loopback baseline database", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "weletic-a1-recovery-safety-"),
    );
    temporaryDirectories.push(directory);
    const failedReportPath = path.join(directory, "failed.json");
    fs.writeFileSync(failedReportPath, "{}\n");
    const options = {
      confirmStaging: true,
      confirmAbandonedRecovery: true,
      storeDomain: "example.myshopify.com",
      failedReportPath,
      baselineDatabaseUrl: "mysql://root@127.0.0.1:3306/baseline_copy",
      reportPath: path.join(directory, "recovery.json"),
      recoveryStatePath: path.join(directory, "recovery-state.json"),
    };
    expect(() =>
      assertAbandonedBasicLifecycleRecoverySafety(options, {
        NODE_ENV: "test",
        DATABASE_URL: "mysql://live.example.com/live_database",
        WELETIC_LOYALTY_STAGING_ALLOWLIST: "example.myshopify.com",
      }),
    ).not.toThrow();
    expect(() =>
      assertAbandonedBasicLifecycleRecoverySafety(
        {
          ...options,
          baselineDatabaseUrl:
            "mysql://readonly@shared.example.com/baseline_copy",
        },
        {
          NODE_ENV: "test",
          DATABASE_URL: "mysql://live.example.com/live_database",
          WELETIC_LOYALTY_STAGING_ALLOWLIST: "example.myshopify.com",
        },
      ),
    ).toThrow(/loopback/);
    expect(() =>
      assertAbandonedBasicLifecycleRecoverySafety(
        {
          ...options,
          baselineDatabaseUrl: "mysql://root@localhost/live_database",
        },
        {
          NODE_ENV: "test",
          DATABASE_URL: "mysql://live.example.com/live_database",
          WELETIC_LOYALTY_STAGING_ALLOWLIST: "example.myshopify.com",
        },
      ),
    ).toThrow(/differ/);
    expect(() =>
      assertAbandonedBasicLifecycleRecoverySafety(
        { ...options, recoveryStatePath: "relative-state.json" },
        {
          NODE_ENV: "test",
          DATABASE_URL: "mysql://live.example.com/live_database",
          WELETIC_LOYALTY_STAGING_ALLOWLIST: "example.myshopify.com",
        },
      ),
    ).toThrow(/absolute/);
    expect(() =>
      assertAbandonedBasicLifecycleRecoverySafety(
        { ...options, recoveryStatePath: options.reportPath },
        {
          NODE_ENV: "test",
          DATABASE_URL: "mysql://live.example.com/live_database",
          WELETIC_LOYALTY_STAGING_ALLOWLIST: "example.myshopify.com",
        },
      ),
    ).toThrow(/separate paths/);
  });

  it("round-trips a partial remote deletion journal and rejects tampering", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "abandoned-state.json");
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    const state = recoveryStateFixture();
    assertAbandonedBasicLifecycleRecoveryState(state);
    expect(() =>
      assertAbandonedBasicLifecycleRecoveryState({ ...state, version: 1 }),
    ).toThrow(/version or phase/);
    expect(() =>
      assertAbandonedBasicLifecycleRecoveryState({
        ...state,
        bindings: {
          ...state.bindings,
          baselineSnapshotSha256: "0".repeat(64),
        },
      }),
    ).toThrow(/unsupported or missing field/);
    expect(() =>
      assertAbandonedBasicLifecycleRecoveryState({
        ...state,
        accessToken: "must-never-enter-the-journal",
      }),
    ).toThrow(/unsupported or missing field/);

    const writer = new BasicLifecycleRecoveryCapsuleFile<
      ReturnType<typeof recoveryStateFixture>
    >(capsulePath);
    writer.create({
      state,
      checkpoint: "remote-delete-dispatch-uncertain",
      forbiddenValues: ["runtime-access-token-not-in-state"],
    });
    const serializedCapsule = fs.readFileSync(capsulePath, "utf8");
    expect(serializedCapsule).not.toContain(state.ownerToken);
    expect(serializedCapsule).not.toContain(state.remoteCustomers[0].id);
    expect(serializedCapsule).not.toContain(state.remoteCustomers[0].email);

    const resumed = new BasicLifecycleRecoveryCapsuleFile<
      ReturnType<typeof recoveryStateFixture>
    >(capsulePath).load(assertAbandonedBasicLifecycleRecoveryState).state;
    expect(resumed.remoteCustomers.map(({ outcome }) => outcome)).toEqual([
      "deleted",
      "delete_outcome_unknown",
    ]);
    expect(resumed.remoteCustomers.map(({ id }) => id)).toEqual(
      state.remoteCustomers.map(({ id }) => id),
    );

    const encrypted = JSON.parse(fs.readFileSync(capsulePath, "utf8")) as {
      ciphertext: string;
    };
    encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -2)}AA`;
    fs.writeFileSync(capsulePath, `${JSON.stringify(encrypted)}\n`, {
      mode: 0o600,
    });
    expect(() =>
      new BasicLifecycleRecoveryCapsuleFile(capsulePath).load(
        assertAbandonedBasicLifecycleRecoveryState,
      ),
    ).toThrow(/authentication failed|tampered/);
  });

  it("keeps the original ownership window immutable across lease takeover", () => {
    const state = recoveryStateFixture();
    const originalLease = state.originalLease;
    expect(() =>
      assertAbandonedRecoveryLeasePreservesOriginalOwnership({
        originalLease,
        currentLease: {
          ...originalLease,
          ownerTokenSha256: "0".repeat(64),
          recoveryAfter: new Date(
            RECOVERY_AFTER.getTime() + 60_000,
          ).toISOString(),
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertAbandonedRecoveryLeasePreservesOriginalOwnership({
        originalLease,
        currentLease: {
          ...originalLease,
          fixtureEmailSha256: [
            ...originalLease.fixtureEmailSha256.slice(0, 3),
            "b".repeat(64),
          ],
        },
      }),
    ).toThrow(/original ownership proof/);
    expect(() =>
      assertAbandonedRecoveryLeasePreservesOriginalOwnership({
        originalLease,
        currentLease: {
          ...originalLease,
          recoveryAfter: new Date(RECOVERY_AFTER.getTime() - 1).toISOString(),
        },
      }),
    ).toThrow(/original ownership proof/);
  });

  it("accepts only the exact PASSED report in the final binding crash window", () => {
    const directory = privateTemporaryDirectory();
    const reportPath = path.join(directory, "passed-recovery.json");
    const capsulePath = path.join(directory, "passed-recovery-state.json");
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    const state = {
      ...recoveryStateFixture(),
      phase: "lease_released",
      remoteCustomers: recoveryStateFixture().remoteCustomers.map(
        (customer) => ({
          ...customer,
          outcome: "deleted",
        }),
      ),
    };
    assertAbandonedBasicLifecycleRecoveryState(state);
    const capsuleWriter = new BasicLifecycleRecoveryCapsuleFile<
      ReturnType<typeof recoveryStateFixture>
    >(capsulePath);
    capsuleWriter.create({
      state,
      checkpoint: "maintenance-lease-released",
    });
    const capsuleSha256 = capsuleWriter.sha256();
    const report: RecoveryReport = {
      version: 2,
      kind: "abandoned_a1_recovery",
      startedAt: ACQUIRED_AT.toISOString(),
      completedAt: COMPLETED_AT.toISOString(),
      overallStatus: "PASSED",
      sourceReport: {
        version: 3,
        sha256: state.sourceReport.sha256,
        preserved: true,
      },
      checks: RECOVERY_CHECK_NAMES.map((name) => ({
        name,
        status: "PASSED",
        durationMs: 1,
        evidence: { exact: true },
      })),
      mutation: {
        leaseTakenOver: true,
        remoteCustomersDeleted: state.remoteCustomers.length,
        localRowsDeleted:
          state.fixtureShopperIds.length +
          state.fixtureAccountIds.length +
          state.fixtureLedgerIds.length,
        temporaryDefinitionsDeleted: 6,
        maintenanceLeaseReleased: true,
      },
      recoveryCapsule: { sha256: capsuleSha256 },
    };
    writeAbandonedBasicLifecycleRecoveryReport(reportPath, report);

    const resumedCapsule = new BasicLifecycleRecoveryCapsuleFile<
      ReturnType<typeof recoveryStateFixture>
    >(capsulePath);
    const resumedState = resumedCapsule.load(
      assertAbandonedBasicLifecycleRecoveryState,
    ).state;
    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toBeNull();
    expect(() => resumedCapsule.secureUnlink()).toThrow(
      /durable report is bound/,
    );
    expect(fs.existsSync(capsulePath)).toBe(true);

    expect(
      readExistingPassedRecoveryReport({
        reportPath,
        sourceSha256: state.sourceReport.sha256,
        capsuleSha256,
        recoveryState: state,
      }),
    ).toMatchObject({ overallStatus: "PASSED" });
    resumedCapsule.bindReport({
      state: resumedState,
      reportPath,
      reportSha256: sha256BasicLifecycleFile(reportPath),
      capsuleSha256BeforeBinding: capsuleSha256,
    });
    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toMatchObject({ reportSha256: sha256BasicLifecycleFile(reportPath) });

    const tampered = {
      ...report,
      checks: report.checks.map((check, index) =>
        index === 0
          ? { ...check, evidence: { leakedRuntimeValue: "not-report-safe" } }
          : check,
      ),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(tampered)}\n`);
    expect(() =>
      readExistingPassedRecoveryReport({
        reportPath,
        sourceSha256: state.sourceReport.sha256,
        capsuleSha256,
        recoveryState: state,
      }),
    ).toThrow(/exact PASSED journal result/);
  });

  it("rejects a completed remote phase with an uncertain customer outcome", () => {
    const state = {
      ...recoveryStateFixture(),
      phase: "remote_cleanup_complete",
    };
    expect(() => assertAbandonedBasicLifecycleRecoveryState(state)).toThrow(
      /remote deletion checkpoint/,
    );
    state.remoteCustomers = state.remoteCustomers.map((customer) => ({
      ...customer,
      outcome: "deleted",
    }));
    expect(() =>
      assertAbandonedBasicLifecycleRecoveryState(state),
    ).not.toThrow();
  });

  it("accepts only the exact failed lifecycle phase", () => {
    const report = {
      version: 3,
      startedAt: ACQUIRED_AT.toISOString(),
      completedAt: COMPLETED_AT.toISOString(),
      overallStatus: "FAILED",
      summary: { total: 6, passed: 4, failed: 2, deferred: 0 },
      checks: [
        {
          name: "A1 harness runtime availability",
          status: "PASSED",
          durationMs: 1,
          evidence: { kind: "LOCAL_SAFETY_GUARD" },
        },
        {
          name: "Staging tenant, credential, and baseline safety",
          status: "PASSED",
          durationMs: 1,
          evidence: { kind: "LOCAL_SAFETY_GUARD" },
        },
        {
          name: "Retained-customer exclusivity and drained outbox quiescence",
          status: "PASSED",
          durationMs: 1,
          evidence: { kind: "LOCAL_SAFETY_GUARD" },
        },
        {
          name: "Temporary loyalty configuration installation",
          status: "PASSED",
          durationMs: 1,
          evidence: { kind: "LOCAL_SAFETY_GUARD" },
        },
        {
          name: "Real Shopify customer creation and webhook provisioning",
          status: "FAILED",
          durationMs: 1,
          evidence: { kind: "LIVE_CUSTOMER_PROVISIONING" },
        },
      ],
      cleanup: {
        name: "Restore configuration and remove disposable fixtures",
        status: "FAILED",
        durationMs: 1,
        evidence: { kind: "LIVE_SHOPIFY_CLEANUP" },
      },
      evidenceProvenance: {},
      intentionallySkipped: [],
      intentionallyRetained: [],
    };
    expect(
      parseFailedBasicLifecycleReport(JSON.stringify(report)),
    ).toMatchObject({ version: 3, overallStatus: "FAILED" });
    expect(
      parseFailedBasicLifecycleReport(
        JSON.stringify({
          ...report,
          version: 4,
          recoveryCapsule: { sha256: "a".repeat(64) },
        }),
      ),
    ).toMatchObject({
      version: 4,
      overallStatus: "FAILED",
      recoveryCapsule: { sha256: "a".repeat(64) },
    });
    expect(() =>
      parseFailedBasicLifecycleReport(
        JSON.stringify({ ...report, version: 4 }),
      ),
    ).toThrow(/unsupported schema|recovery capsule binding/);
    expect(() =>
      parseFailedBasicLifecycleReport(
        JSON.stringify({ ...report, overallStatus: "PASSED" }),
      ),
    ).toThrow(/exact failed A1/);
  });

  it("allows only baseline or exact temporary program values", () => {
    const baseline = {
      name: "Retained",
      status: "disabled",
      pointsPerCurrencyUnit: "3",
      holdingPeriodDays: 7,
      metadata: { retained: true },
      updatedAt: new Date(0),
    };
    expect(() =>
      assertAbandonedBasicLifecycleProgramDiff({
        baseline,
        current: {
          ...baseline,
          status: "active",
          pointsPerCurrencyUnit: "1",
          holdingPeriodDays: 0,
          updatedAt: new Date(1),
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertAbandonedBasicLifecycleProgramDiff({
        baseline,
        current: { ...baseline, name: "Unexpected drift" },
      }),
    ).toThrow(/non-harness drift/);
  });

  it("accepts only the exact temporary definition delta", () => {
    const fixture = exactDefinitionFixture();
    expect(
      assertAbandonedBasicLifecycleDefinitionDiff({
        ...fixture,
        programId: PROGRAM_ID,
        storeId: STORE_ID,
        runMarker: RUN_MARKER,
        acquiredAt: ACQUIRED_AT.getTime(),
        completedAt: COMPLETED_AT.getTime(),
      }),
    ).toEqual({ temporaryDefinitionCount: 6 });

    const changed = exactDefinitionFixture();
    (changed.current.referralRules[0] as Record<string, unknown>)[
      "fraudCheckSameIp"
    ] = true;
    expect(() =>
      assertAbandonedBasicLifecycleDefinitionDiff({
        ...changed,
        programId: PROGRAM_ID,
        storeId: STORE_ID,
        runMarker: RUN_MARKER,
        acquiredAt: ACQUIRED_AT.getTime(),
        completedAt: COMPLETED_AT.getTime(),
      }),
    ).toThrow(/referral rule/);
  });

  it("performs a symmetric family diff with only predeclared extras", () => {
    const baseline = {
      accounts: [{ id: "retained", status: "active" }],
      outbox: [{ id: "baseline-job", status: "completed" }],
    };
    const current = {
      accounts: [
        { id: "retained", status: "active" },
        { id: "fixture", status: "active" },
      ],
      outbox: [{ id: "baseline-job", status: "completed" }],
    };
    expect(
      assertAbandonedBasicLifecycleFamilyDiff({
        baseline,
        current,
        allowedExtraIds: { accounts: new Set(["fixture"]) },
      }),
    ).toEqual({ retainedRowCount: 2, allowedExtraRowCount: 1 });
    expect(() =>
      assertAbandonedBasicLifecycleFamilyDiff({
        baseline,
        current: {
          ...current,
          outbox: [{ id: "baseline-job", status: "failed" }],
        },
        allowedExtraIds: { accounts: new Set(["fixture"]) },
      }),
    ).toThrow(/retained outbox/);
  });

  it("derives an operational baseline that preserves pre-lease history", () => {
    const beforeLease = new Date(ACQUIRED_AT.getTime() - 60_000);
    const afterLease = new Date(ACQUIRED_AT.getTime() + 60_000);
    const historical = {
      audits: [
        {
          id: "historical-audit",
          status: "processed",
          createdAt: beforeLease,
          updatedAt: beforeLease,
        },
      ],
      sessions: [
        {
          id: "offline-session",
          shop: "example.myshopify.com",
          createdAt: beforeLease,
        },
      ],
    };
    const current = {
      audits: [
        ...historical.audits,
        {
          id: "valid-pre-lease-audit",
          status: "processed",
          createdAt: beforeLease,
          updatedAt: beforeLease,
        },
        {
          id: "lease-owned-audit",
          status: "processed",
          createdAt: afterLease,
          updatedAt: afterLease,
        },
      ],
      sessions: [...historical.sessions],
    };
    const leaseOwned = { audits: new Set(["lease-owned-audit"]) };

    expect(
      assertAbandonedOperationalBaselineBoundary({
        historical,
        current,
        allowedLeaseOwnedIds: leaseOwned,
        leaseAcquiredAt: ACQUIRED_AT,
      }),
    ).toEqual({
      stableHistoricalRows: 2,
      preLeaseRetainedDriftRows: 1,
      leaseOwnedRows: 1,
    });
    expect(
      deriveAbandonedOperationalBaselineSnapshot({
        current,
        excludedIds: leaseOwned,
      }).audits.map(({ id }) => id),
    ).toEqual(["historical-audit", "valid-pre-lease-audit"]);
  });

  it("rejects unowned post-lease drift and missing historical rows", () => {
    const beforeLease = new Date(ACQUIRED_AT.getTime() - 60_000);
    const afterLease = new Date(ACQUIRED_AT.getTime() + 60_000);
    const historical = {
      audits: [
        {
          id: "historical-audit",
          status: "processed",
          createdAt: beforeLease,
          updatedAt: beforeLease,
        },
      ],
    };
    expect(() =>
      assertAbandonedOperationalBaselineBoundary({
        historical,
        current: {
          audits: [
            ...historical.audits,
            {
              id: "unowned-post-lease-audit",
              status: "processed",
              createdAt: afterLease,
              updatedAt: afterLease,
            },
          ],
        },
        allowedLeaseOwnedIds: {},
        leaseAcquiredAt: ACQUIRED_AT,
      }),
    ).toThrow(/changed at or after/);
    expect(() =>
      assertAbandonedOperationalBaselineBoundary({
        historical,
        current: { audits: [] },
        allowedLeaseOwnedIds: {},
        leaseAcquiredAt: ACQUIRED_AT,
      }),
    ).toThrow(/historical audits row is missing/);
  });

  it("accepts only the exact shopper-account-signup-ledger graph", () => {
    const createdAt = new Date(ACQUIRED_AT.getTime() + 1_000);
    const shopper = {
      id: "wshop_fixture",
      storeId: STORE_ID,
      shopifyCustomerId: "123",
      firstName: "A1",
      lastName: "advocate",
      email: `${RUN_MARKER}-advocate@example.com`,
      phone: null,
      locale: "en",
      tags: ["weletic-a1-disposable", RUN_MARKER],
      segmentIds: null,
      acceptsMarketing: false,
      ordersCount: 0,
      totalSpent: BigInt(0),
      createdAt,
      updatedAt: createdAt,
    };
    const account = {
      id: "wacc_fixture",
      storeId: STORE_ID,
      programId: PROGRAM_ID,
      shopperId: shopper.id,
      status: "active",
      ledgerVersion: 1,
      cachedPointsBalance: BigInt(500),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(500),
      lifetimePointsRedeemed: BigInt(0),
      lastQualifyingActivityAt: createdAt,
      nextExpiryDate: null,
      referralCode: null,
      referredById: null,
      referralCount: 0,
      referralPointsEarned: BigInt(0),
      currentTierId: null,
      tierExpiresAt: null,
      tierSpendRolling12Months: BigInt(0),
      tierPointsRolling12Months: BigInt(0),
      enrolledAt: createdAt,
      metadata: null,
      createdAt,
      updatedAt: createdAt,
    };
    const ledger = {
      id: "wledger_fixture",
      storeId: STORE_ID,
      accountId: account.id,
      sequenceNumber: 1,
      entryType: "EARN_BONUS",
      pointsDelta: BigInt(500),
      pendingDelta: BigInt(0),
      balanceAfter: BigInt(500),
      grantId: null,
      referenceType: "SIGNUP_BONUS",
      referenceId: account.id,
      idempotencyKey: `signup:${account.id}`,
      reason: "A1 signup validation",
      metadata: {
        bonusType: "WELCOME_SIGNUP",
        earningRuleId: "wrule_signup",
      },
      createdAt,
    };
    const input = {
      remoteCustomers: [
        {
          numericId: "123",
          email: `${RUN_MARKER}-advocate@example.com`,
          firstName: "A1",
          lastName: "advocate",
          tags: ["weletic-a1-disposable", RUN_MARKER],
        },
      ],
      shoppers: [shopper],
      accounts: [account],
      ledgerEntries: [ledger],
      storeId: STORE_ID,
      programId: PROGRAM_ID,
      runMarker: RUN_MARKER,
      signupRuleId: "wrule_signup",
      acquiredAt: ACQUIRED_AT.getTime(),
      now: COMPLETED_AT.getTime(),
    };
    expect(assertAbandonedBasicLifecycleProjectionGraph(input)).toEqual({
      shopperCount: 1,
      accountCount: 1,
      signupLedgerCount: 1,
    });
    expect(() =>
      assertAbandonedBasicLifecycleProjectionGraph({
        ...input,
        shoppers: [{ ...shopper, tags: null }],
      }),
    ).not.toThrow();
    expect(() =>
      assertAbandonedBasicLifecycleProjectionGraph({
        ...input,
        shoppers: [{ ...shopper, tags: ["unowned"] }],
      }),
    ).toThrow(/customer projection/);
    expect(() =>
      assertAbandonedBasicLifecycleProjectionGraph({
        ...input,
        ledgerEntries: [{ ...ledger, pointsDelta: BigInt(501) }],
      }),
    ).toThrow(/signup ledger/);
  });

  it("bounds remote ownership by the lease window, not report completion", () => {
    expect(
      isAbandonedBasicLifecycleFixtureCreatedWithinLease({
        createdAt: new Date(COMPLETED_AT.getTime() + 1),
        acquiredAt: ACQUIRED_AT,
        recoveryAfter: RECOVERY_AFTER,
      }),
    ).toBe(true);
    expect(
      isAbandonedBasicLifecycleFixtureCreatedWithinLease({
        createdAt: new Date(RECOVERY_AFTER.getTime() + 1),
        acquiredAt: ACQUIRED_AT,
        recoveryAfter: RECOVERY_AFTER,
      }),
    ).toBe(false);
  });

  it("requires one terminal payload-free audit and projection per remote customer", () => {
    const row = {
      payload: null,
      authenticatedBodyDigest: "a".repeat(64),
      storeInstallationGeneration: "generation-1",
      status: "processed",
      processedAt: new Date(),
      error: null,
    };
    expect(() =>
      assertAbandonedBasicLifecycleIngressOwnership({
        remoteCustomerCount: 2,
        localProjectionCount: 2,
        auditRows: [row, { ...row, authenticatedBodyDigest: "b".repeat(64) }],
        installationGeneration: "generation-1",
        leaseAcquiredAt: ACQUIRED_AT,
        recoveryAfter: RECOVERY_AFTER,
        now: RECOVERY_AFTER,
      }),
    ).not.toThrow();
    expect(() =>
      assertAbandonedBasicLifecycleIngressOwnership({
        remoteCustomerCount: 2,
        localProjectionCount: 1,
        auditRows: [row],
        installationGeneration: "generation-1",
        leaseAcquiredAt: ACQUIRED_AT,
        recoveryAfter: RECOVERY_AFTER,
        now: new Date(RECOVERY_AFTER.getTime() - 1),
        undeliveredCustomerCreatedAt: [ACQUIRED_AT],
      }),
    ).toThrow(/retry horizon/);

    expect(
      assertAbandonedBasicLifecycleIngressOwnership({
        remoteCustomerCount: 3,
        localProjectionCount: 1,
        auditRows: [row],
        installationGeneration: "generation-1",
        leaseAcquiredAt: ACQUIRED_AT,
        recoveryAfter: RECOVERY_AFTER,
        now: RECOVERY_AFTER,
        undeliveredCustomerCreatedAt: [
          ACQUIRED_AT,
          new Date(ACQUIRED_AT.getTime() + 1),
        ],
      }),
    ).toEqual({ terminalProjectionCount: 1, expiredUndeliveredCount: 2 });
  });

  it("writes a separate immutable mode-0600 recovery report", () => {
    const directory = privateTemporaryDirectory();
    const reportPath = path.join(directory, "recovery.json");
    const report: RecoveryReport = {
      version: 2,
      kind: "abandoned_a1_recovery",
      startedAt: ACQUIRED_AT.toISOString(),
      completedAt: COMPLETED_AT.toISOString(),
      overallStatus: "FAILED",
      sourceReport: {
        version: 3,
        sha256: "a".repeat(64),
        preserved: true,
      },
      checks: [],
      mutation: {
        leaseTakenOver: false,
        remoteCustomersDeleted: 0,
        localRowsDeleted: 0,
        temporaryDefinitionsDeleted: 0,
        maintenanceLeaseReleased: false,
      },
      recoveryCapsule: null,
      hardBoundary: "Exact ownership was incomplete.",
    };

    writeAbandonedBasicLifecycleRecoveryReport(reportPath, report);
    expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(() =>
      writeAbandonedBasicLifecycleRecoveryReport(reportPath, report),
    ).toThrow();

    const missingParent = path.join(directory, "missing", "recovery.json");
    expect(() =>
      writeAbandonedBasicLifecycleRecoveryReport(missingParent, report),
    ).toThrow();
    expect(fs.existsSync(path.dirname(missingParent))).toBe(false);
  });
});
