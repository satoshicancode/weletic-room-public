import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BasicLifecycleReport } from "../../scripts/loyalty/validate-basic-lifecycle";
import {
  advanceBasicLifecycleOutboxStablePasses,
  assertBasicLifecycleAtomicReleaseAudit,
  assertBasicLifecycleCompletedVoucherCleanupOwnership,
  assertBasicLifecycleExactCustomerDeleted,
  assertBasicLifecycleExactDeleteCount,
  assertBasicLifecycleExactDiscountDeleted,
  assertBasicLifecycleFinalCleanupPrerequisites,
  assertBasicLifecycleFixtureCustomerProjection,
  assertBasicLifecycleFixtureOutboxOwnership,
  assertBasicLifecycleFxSnapshotOwnership,
  assertBasicLifecycleLocalCleanupPrerequisites,
  assertBasicLifecycleMaintenanceReleasePrerequisites,
  assertBasicLifecycleOutboxBaselineUnchanged,
  assertBasicLifecycleOutboxQuiescence,
  assertBasicLifecycleOwnedCustomerRedactRequest,
  assertBasicLifecycleReferralCleanupOwnership,
  assertBasicLifecycleSafety,
  assertBasicLifecycleTemporaryDefinitionReferenceOwnership,
  assignBasicLifecycleSerializedCustomerCreateAuditEvidence,
  BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS,
  BASIC_LIFECYCLE_OUTBOX_RUN_HORIZON_MS,
  captureBasicLifecycleOutboxBaselineDigests,
  classifyBasicLifecycleProgramUpdateReconciliation,
  evaluateBasicLifecycleCustomerCreateAuditEvidence,
  evaluateBasicLifecycleFixtureOutboxCleanup,
  evaluateBasicLifecycleOutboxQuiescence,
  getBasicLifecycleEvidenceProvenance,
  getBasicLifecycleOutboxTupleCheckMode,
  getBasicLifecycleReferralQualificationIdentity,
  HarnessState,
  isBasicLifecycleAuthenticatedBodyDigest,
  isBasicLifecycleExactFixtureOutboxJob,
  isBasicLifecycleExactTemporaryProgramState,
  isBasicLifecycleTemporaryProgramState,
  parseBasicLifecycleArgs,
  planBasicLifecycleHarnessOwnedProgramRestore,
  reconcileBasicLifecycleDisposableCustomerSearch,
  reconcileBasicLifecycleKnownOutboxIds,
  redactBasicLifecycleText,
  runBasicLifecycleCleanupSteps,
  runBasicLifecycleCustomerDeleteBarrier,
  runBasicLifecycleLockedOrchestration,
  serializeBasicLifecycleEvidenceProvenance,
  serializeBasicLifecycleReportForFile,
  shouldAttemptBasicLifecycleProgramRestore,
  writeRedactedReport,
} from "../../scripts/loyalty/validate-basic-lifecycle";

describe("Shopify Basic loyalty lifecycle harness safety", () => {
  it("accepts only versioned authenticated webhook body digests in recovery state", () => {
    expect(
      isBasicLifecycleAuthenticatedBodyDigest(
        `hmac:v1:test-v1:${"A".repeat(64)}`,
      ),
    ).toBe(true);
    expect(isBasicLifecycleAuthenticatedBodyDigest("a".repeat(64))).toBe(false);
    expect(
      isBasicLifecycleAuthenticatedBodyDigest(
        `hmac:v1:invalid key:${"A".repeat(64)}`,
      ),
    ).toBe(false);
  });

  it("requires the explicit staging confirmation", () => {
    const options = parseBasicLifecycleArgs([]);
    expect(() =>
      assertBasicLifecycleSafety(options, { NODE_ENV: "development" }),
    ).toThrow(/confirm-staging/);
  });

  it("requires an explicit allowlisted store and defaults only the localhost webhook route", () => {
    const options = parseBasicLifecycleArgs(["--confirm-staging"]);
    expect(options).toEqual({
      confirmStaging: true,
      storeDomain: "",
      webhookTarget: "http://127.0.0.1:8888/api/shopify/integration/webhook",
    });
    expect(() =>
      assertBasicLifecycleSafety(options, { NODE_ENV: "development" }),
    ).toThrow(/must be supplied explicitly/);

    const explicit = parseBasicLifecycleArgs([
      "--confirm-staging",
      "--store=loyalty-a1-example.myshopify.com",
      "--recovery-state=/home/test-user/.weletic/recovery.json",
    ]);
    expect(() =>
      assertBasicLifecycleSafety(explicit, {
        NODE_ENV: "development",
        WELETIC_LOYALTY_STAGING_ALLOWLIST: "loyalty-a1-example.myshopify.com",
      }),
    ).not.toThrow();
  });

  it("refuses a different store unless it is explicitly allowlisted", () => {
    const options = parseBasicLifecycleArgs([
      "--confirm-staging",
      "--store=another-dev.myshopify.com",
      "--recovery-state=/home/test-user/.weletic/recovery.json",
    ]);
    expect(() =>
      assertBasicLifecycleSafety(options, { NODE_ENV: "development" }),
    ).toThrow(/non-allowlisted/);
    expect(() =>
      assertBasicLifecycleSafety(options, {
        NODE_ENV: "development",
        WELETIC_LOYALTY_STAGING_ALLOWLIST: "another-dev.myshopify.com",
      }),
    ).not.toThrow();
  });

  it("refuses a public webhook origin unless separately allowlisted", () => {
    const options = parseBasicLifecycleArgs([
      "--confirm-staging",
      "--store=loyalty-a1-example.myshopify.com",
      "--target=https://dev-webhook.weletic.com/api/shopify/integration/webhook",
      "--recovery-state=/home/test-user/.weletic/recovery.json",
    ]);
    expect(() =>
      assertBasicLifecycleSafety(options, {
        NODE_ENV: "development",
        WELETIC_LOYALTY_STAGING_ALLOWLIST: "loyalty-a1-example.myshopify.com",
      }),
    ).toThrow(/non-local webhook target/);
    expect(() =>
      assertBasicLifecycleSafety(options, {
        NODE_ENV: "development",
        WELETIC_LOYALTY_STAGING_ALLOWLIST: "loyalty-a1-example.myshopify.com",
        WELETIC_LOYALTY_STAGING_WEBHOOK_TARGETS:
          "https://dev-webhook.weletic.com",
      }),
    ).not.toThrow();
  });

  it("requires a credential-free HTTP(S) webhook URL with the exact route", () => {
    for (const target of [
      "ftp://localhost/api/shopify/integration/webhook",
      "http://user:secret@localhost/api/shopify/integration/webhook",
      "http://localhost/api/shopify/integration/webhook?secret=value",
      "http://localhost/api/shopify/integration/webhook#fragment",
      "http://localhost/api/shopify/integration/webhook/extra",
    ]) {
      const options = parseBasicLifecycleArgs([
        "--confirm-staging",
        `--target=${target}`,
      ]);
      expect(() =>
        assertBasicLifecycleSafety(options, { NODE_ENV: "development" }),
      ).toThrow();
    }
  });

  it("requires an explicit absolute recovery-state path for staging mutations", () => {
    const base = [
      "--confirm-staging",
      "--store=loyalty-a1-example.myshopify.com",
    ];
    const environment = {
      NODE_ENV: "development",
      WELETIC_LOYALTY_STAGING_ALLOWLIST: "loyalty-a1-example.myshopify.com",
    };

    expect(() =>
      assertBasicLifecycleSafety(parseBasicLifecycleArgs(base), environment),
    ).toThrow(/recovery-state=<absolute path>/);
    expect(() =>
      assertBasicLifecycleSafety(
        parseBasicLifecycleArgs([
          ...base,
          "--recovery-state=relative/recovery.json",
        ]),
        environment,
      ),
    ).toThrow(/recovery-state=<absolute path>/);
  });

  it("requires distinct existing source and capsule files for cleanup recovery", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "weletic-a1-cleanup-recovery-"),
    );
    const sourceReportPath = path.join(directory, "failed.json");
    const recoveryStatePath = path.join(directory, "recovery.enc");
    const reportPath = path.join(directory, "recovery-report.json");
    fs.writeFileSync(sourceReportPath, "{}\n");
    fs.writeFileSync(recoveryStatePath, "{}\n");
    try {
      const options = parseBasicLifecycleArgs([
        "--confirm-staging",
        "--store=loyalty-a1-example.myshopify.com",
        `--resume-cleanup-from-report=${sourceReportPath}`,
        `--recovery-state=${recoveryStatePath}`,
        `--report=${reportPath}`,
      ]);
      expect(options.resumeCleanupFromReportPath).toBe(sourceReportPath);
      expect(() =>
        assertBasicLifecycleSafety(options, {
          NODE_ENV: "development",
          WELETIC_LOYALTY_STAGING_ALLOWLIST: "loyalty-a1-example.myshopify.com",
        }),
      ).not.toThrow();
      expect(() =>
        assertBasicLifecycleSafety(
          { ...options, reportPath: sourceReportPath },
          {
            NODE_ENV: "development",
            WELETIC_LOYALTY_STAGING_ALLOWLIST:
              "loyalty-a1-example.myshopify.com",
          },
        ),
      ).toThrow(/distinct explicit/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects production and unknown CLI options", () => {
    const options = parseBasicLifecycleArgs(["--confirm-staging"]);
    expect(() =>
      assertBasicLifecycleSafety(options, { NODE_ENV: "production" }),
    ).toThrow(/cannot run in production/);
    const unsupported = "--secret=must-not-be-echoed";
    expect(() =>
      parseBasicLifecycleArgs(["--confirm-staging", unsupported]),
    ).toThrow(/Unsupported/);
    try {
      parseBasicLifecycleArgs([unsupported]);
    } catch (error) {
      expect(String(error)).not.toContain("must-not-be-echoed");
    }
  });

  it("redacts provider errors before they can reach JSON or console output", () => {
    const exactSensitiveValue = "actual-sensitive-fixture-value";
    const raw = `customer gid://shopify/Customer/123 discount gid://shopify/DiscountCodeNode/456 email fixture@example.com token shpat_secret redemption wredemp_secret voucher WLA1-ABCDEF1234 exact ${exactSensitiveValue}`;
    const redacted = redactBasicLifecycleText(raw, [exactSensitiveValue]);
    expect(redacted).not.toContain("123");
    expect(redacted).not.toContain("456");
    expect(redacted).not.toContain("fixture@example.com");
    expect(redacted).not.toContain("shpat_secret");
    expect(redacted).not.toContain("wredemp_secret");
    expect(redacted).not.toContain("WLA1-ABCDEF1234");
    expect(redacted).not.toContain(exactSensitiveValue);
    expect(redacted).toContain("[redacted-customer]");
    expect(redacted).toContain("[redacted-shopify-id]");
    expect(redacted).toContain("[redacted-email]");
    expect(redacted).toContain("[redacted-token]");
    expect(redacted).toContain("[redacted-id]");
    expect(redacted).toContain("[redacted-voucher]");
    expect(redacted).toContain("exact [redacted]");
  });

  it("adopts an unknown install outcome only when every temporary field matches", () => {
    const exact = {
      status: "active",
      pointsPerCurrencyUnit: "1",
      holdingPeriodDays: 0,
      pointsExpiryMonths: 0,
      killSwitchActive: false,
      enableMetafieldsSync: true,
      vipMilestoneMode: "points_earned",
      vipTimeframe: "lifetime",
      vipDowngradeGraceDays: 30,
      vipAutoDowngradeEnabled: true,
    };
    expect(isBasicLifecycleTemporaryProgramState(exact)).toBe(true);
    expect(
      isBasicLifecycleTemporaryProgramState(
        { ...exact, holdingPeriodDays: 1 },
        1,
      ),
    ).toBe(true);
    expect(
      isBasicLifecycleTemporaryProgramState({
        ...exact,
        holdingPeriodDays: 7,
      }),
    ).toBe(false);
    expect(
      isBasicLifecycleTemporaryProgramState({
        ...exact,
        vipMilestoneMode: "amount_spent",
      }),
    ).toBe(false);
  });

  it("allows only zero-attempt pending work beyond the explicit run horizon", () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const atHorizon = new Date(
      now.getTime() + BASIC_LIFECYCLE_OUTBOX_RUN_HORIZON_MS,
    );
    const beyondHorizon = new Date(atHorizon.getTime() + 1);
    const safeRows = [
      {
        status: "completed",
        scheduledFor: now,
        nextRetryAt: null,
        attempts: 4,
      },
      {
        status: "cancelled",
        scheduledFor: now,
        nextRetryAt: null,
        attempts: 1,
      },
      {
        status: "pending",
        scheduledFor: beyondHorizon,
        nextRetryAt: null,
        attempts: 0,
      },
    ];
    expect(evaluateBasicLifecycleOutboxQuiescence(safeRows, now)).toEqual({
      safe: true,
      processingCount: 0,
      activeCount: 0,
      eligibleCount: 0,
      futurePendingCount: 1,
    });

    expect(
      evaluateBasicLifecycleOutboxQuiescence(
        [
          {
            status: "pending",
            scheduledFor: atHorizon,
            nextRetryAt: null,
            attempts: 0,
          },
        ],
        now,
      ),
    ).toMatchObject({ safe: false, activeCount: 1 });

    for (const status of ["pending", "failed", "dead_letter", "processing"]) {
      const rows = [
        {
          status,
          scheduledFor: status === "pending" ? atHorizon : beyondHorizon,
          nextRetryAt: beyondHorizon,
          attempts: status === "pending" ? 1 : 0,
        },
      ];
      expect(() => assertBasicLifecycleOutboxQuiescence(rows, now)).toThrow(
        /outbox work/,
      );
    }
    expect(
      evaluateBasicLifecycleOutboxQuiescence(
        [
          {
            status: "pending",
            scheduledFor: now,
            nextRetryAt: null,
            attempts: 0,
          },
        ],
        now,
      ),
    ).toMatchObject({ safe: false, activeCount: 1, eligibleCount: 1 });
  });

  it("uses the later scheduled or retry time for the pending-job horizon", () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const atHorizon = new Date(
      now.getTime() + BASIC_LIFECYCLE_OUTBOX_RUN_HORIZON_MS,
    );
    const beyondHorizon = new Date(atHorizon.getTime() + 1);
    const base = {
      status: "pending",
      scheduledFor: now,
      attempts: 0,
    };
    expect(
      evaluateBasicLifecycleOutboxQuiescence(
        [{ ...base, nextRetryAt: atHorizon }],
        now,
      ),
    ).toMatchObject({ safe: false, activeCount: 1 });
    expect(
      evaluateBasicLifecycleOutboxQuiescence(
        [{ ...base, nextRetryAt: beyondHorizon }],
        now,
      ),
    ).toMatchObject({ safe: true, activeCount: 0, futurePendingCount: 1 });
  });

  it("proves every retained baseline outbox row remained byte-semantically unchanged", () => {
    const baselineRows = [
      {
        id: "retained-future-job",
        status: "pending",
        attempts: 0,
        scheduledFor: new Date("2026-08-30T03:00:00.000Z"),
        nextRetryAt: null,
        payload: { accountId: "retained-account", nested: { value: 1 } },
        updatedAt: new Date("2026-08-29T23:00:00.000Z"),
      },
    ];
    const baselineDigests =
      captureBasicLifecycleOutboxBaselineDigests(baselineRows);
    const unchangedRows = [
      {
        ...baselineRows[0],
        scheduledFor: new Date(baselineRows[0].scheduledFor),
        updatedAt: new Date(baselineRows[0].updatedAt),
        payload: { nested: { value: 1 }, accountId: "retained-account" },
      },
    ];
    expect(
      assertBasicLifecycleOutboxBaselineUnchanged(
        baselineDigests,
        unchangedRows,
      ),
    ).toEqual({ unchangedCount: 1 });
    expect(() =>
      assertBasicLifecycleOutboxBaselineUnchanged(baselineDigests, [
        { ...unchangedRows[0], attempts: 1 },
      ]),
    ).toThrow(/changed or removed/);
    expect(() =>
      assertBasicLifecycleOutboxBaselineUnchanged(baselineDigests, []),
    ).toThrow(/changed or removed/);
  });

  it("serializes explicit live, signed-synthetic, and local provenance", () => {
    const provenance = getBasicLifecycleEvidenceProvenance();
    const serialized = serializeBasicLifecycleEvidenceProvenance();
    expect(provenance.live).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          liveShopify: true,
          summary: expect.stringContaining("customerCreate"),
        }),
        expect.objectContaining({
          liveShopify: true,
          summary: expect.stringContaining("readback"),
        }),
      ]),
    );
    expect(provenance.synthetic).toEqual([
      expect.objectContaining({
        authenticatedSynthetic: true,
        logicalTime: false,
        summary: expect.stringContaining("not a real checkout"),
      }),
    ]);
    expect(provenance.local).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "LOGICAL_TIME_WORKER",
          logicalTime: true,
        }),
      ]),
    );
    expect(provenance.cleanup).toEqual([
      expect.objectContaining({
        kind: "LIVE_SHOPIFY_CLEANUP",
        liveShopify: true,
        summary: expect.stringContaining("deletion"),
      }),
    ]);
    expect(BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS).toMatchObject({
      "Signup award idempotency": "SYNTHETIC_LOCAL_EVIDENCE",
      "Holding release and partial/full refund reversals":
        "SYNTHETIC_LOGICAL_TIME_EVIDENCE",
      "Voucher use, cancellation, and logical-time expiry":
        "COMPOSITE_LOGICAL_TIME_EVIDENCE",
      "Restore configuration and remove disposable fixtures":
        "LIVE_SHOPIFY_CLEANUP",
    });
    expect(JSON.parse(serialized)).toEqual(provenance);
  });

  it("keeps the retained v9 artifact identifier-free and aligned with the check provenance contract", () => {
    const artifact = JSON.parse(
      fs.readFileSync(
        new URL(
          "../../../../docs/loyalty/evidence/a1-basic-lifecycle-staging-2026-08-31-v9.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      version: number;
      checks: BasicLifecycleReport["checks"];
      cleanup: BasicLifecycleReport["cleanup"];
      evidenceProvenance: BasicLifecycleReport["evidenceProvenance"];
      storeDomain?: string;
    };
    const cleanupName =
      "Restore configuration and remove disposable fixtures" as const;
    const expectedCheckKinds = Object.fromEntries(
      Object.entries(BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS).filter(
        ([name]) => name !== cleanupName,
      ),
    );
    const artifactCheckKinds = Object.fromEntries(
      artifact.checks.map((check) => [check.name, check.evidence.kind]),
    );

    expect(artifact.version).toBe(3);
    expect(artifact).not.toHaveProperty("storeDomain");
    expect(artifactCheckKinds).toEqual(expectedCheckKinds);
    expect(artifact.cleanup.evidence.kind).toBe(
      BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[cleanupName],
    );
    const withoutHistoricalSummaries = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, entry) =>
          key === "summary" ? undefined : entry,
        ),
      );
    expect(withoutHistoricalSummaries(artifact.evidenceProvenance)).toEqual(
      withoutHistoricalSummaries(getBasicLifecycleEvidenceProvenance()),
    );
    expect(
      Object.values(artifact.evidenceProvenance)
        .flat()
        .every((entry) => entry.summary.trim().length > 0),
    ).toBe(true);
  });

  it("wires the harness through a Node 24 guard, native env loading, and the tsx import hook", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["loyalty:validate-basic-lifecycle"]).toBe(
      "node -e \"if (process.versions.node.split('.')[0] !== '24') throw new Error('A1 lifecycle validation requires Node 24')\" && node --env-file=.env --conditions=react-server --import=./scripts/runtime/async-local-storage.cjs --import=tsx ./scripts/loyalty/validate-basic-lifecycle.ts",
    );
    const rootPackageJson = JSON.parse(
      fs.readFileSync(
        new URL("../../../../package.json", import.meta.url),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    expect(rootPackageJson.scripts["loyalty:validate-basic-lifecycle"]).toBe(
      "pnpm --filter web loyalty:validate-basic-lifecycle",
    );
  });

  it("publishes every snapshot-backed staging policy mutation in its transaction", () => {
    const source = fs.readFileSync(
      new URL(
        "../../scripts/loyalty/validate-basic-lifecycle.ts",
        import.meta.url,
      ),
      "utf8",
    );
    for (const reason of [
      "reason: action",
      'reason: "a1_fixture_policy_installed"',
      'reason: "a1_fixture_program_restored"',
      'reason: "a1_fixture_policy_definitions_removed"',
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
  });

  it("restores only exact harness-owned fields while preserving unrelated merchant drift", () => {
    const baseline = {
      name: "Retained program",
      surfaceFlags: { launcher: true },
      branding: { accent: "blue" },
      metadata: { owner: "in-house" },
    };
    const exact = {
      ...baseline,
      status: "active",
      pointsPerCurrencyUnit: "1",
      holdingPeriodDays: 0,
      pointsExpiryMonths: 0,
      killSwitchActive: false,
      enableMetafieldsSync: true,
      vipMilestoneMode: "points_earned",
      vipTimeframe: "lifetime",
      vipDowngradeGraceDays: 30,
      vipAutoDowngradeEnabled: true,
    };
    expect(isBasicLifecycleExactTemporaryProgramState(baseline, exact)).toBe(
      true,
    );
    expect(
      isBasicLifecycleExactTemporaryProgramState(baseline, {
        ...exact,
        branding: { accent: "merchant-change" },
      }),
    ).toBe(true);
    expect(
      isBasicLifecycleExactTemporaryProgramState(baseline, {
        ...exact,
        holdingPeriodDays: 2,
      }),
    ).toBe(false);
  });

  it("plans a field-by-field CAS restore for mixed baseline, temporary, and external values", () => {
    const baseline = {
      status: "disabled",
      pointsPerCurrencyUnit: "2",
      holdingPeriodDays: 7,
      pointsExpiryMonths: 12,
      killSwitchActive: true,
      enableMetafieldsSync: false,
      vipMilestoneMode: "spend",
      vipTimeframe: "rolling_12_months",
      vipDowngradeGraceDays: 14,
      vipAutoDowngradeEnabled: false,
    };
    const plan = planBasicLifecycleHarnessOwnedProgramRestore(baseline, {
      ...baseline,
      status: "active",
      holdingPeriodDays: 1,
      killSwitchActive: "merchant-third-value",
    });
    expect(plan.restoreData).toEqual({
      status: "disabled",
      holdingPeriodDays: 7,
    });
    expect(plan.alreadyBaselineKeys).toContain("pointsPerCurrencyUnit");
    expect(plan.externallyDriftedKeys).toEqual(["killSwitchActive"]);
    expect(
      planBasicLifecycleHarnessOwnedProgramRestore(baseline, {
        ...baseline,
        killSwitchActive: "merchant-third-value",
      }).restoreData,
    ).toEqual({});
  });

  it("retries a timestamp-only program lock drift but stops on owned-field drift", () => {
    const baseline = { name: "Retained program" };
    const temporary = {
      status: "active",
      pointsPerCurrencyUnit: "1",
      holdingPeriodDays: 0,
      pointsExpiryMonths: 0,
      killSwitchActive: false,
      enableMetafieldsSync: true,
      vipMilestoneMode: "points_earned",
      vipTimeframe: "lifetime",
      vipDowngradeGraceDays: 30,
      vipAutoDowngradeEnabled: true,
    };
    expect(
      classifyBasicLifecycleProgramUpdateReconciliation({
        baseline,
        current: { ...temporary, updatedAt: new Date() },
        previousHoldingPeriodDays: 0,
        targetHoldingPeriodDays: 1,
      }),
    ).toBe("retry");
    expect(
      classifyBasicLifecycleProgramUpdateReconciliation({
        baseline,
        current: { ...temporary, holdingPeriodDays: 1 },
        previousHoldingPeriodDays: 0,
        targetHoldingPeriodDays: 1,
      }),
    ).toBe("committed");
    expect(
      classifyBasicLifecycleProgramUpdateReconciliation({
        baseline,
        current: { ...temporary, killSwitchActive: true },
        previousHoldingPeriodDays: 0,
        targetHoldingPeriodDays: 1,
      }),
    ).toBe("drift");
  });

  it("bounds program mutation reconciliation by both attempts and deadline", () => {
    expect(
      shouldAttemptBasicLifecycleProgramRestore({
        attempt: 119,
        maxAttempts: 120,
        nowMs: 999,
        deadlineMs: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldAttemptBasicLifecycleProgramRestore({
        attempt: 120,
        maxAttempts: 120,
        nowMs: 999,
        deadlineMs: 1_000,
      }),
    ).toBe(false);
    expect(
      shouldAttemptBasicLifecycleProgramRestore({
        attempt: 1,
        maxAttempts: 120,
        nowMs: 1_000,
        deadlineMs: 1_000,
      }),
    ).toBe(false);
  });

  it("classifies only pending/failed exact jobs as cancellable and never processing jobs", () => {
    expect(
      evaluateBasicLifecycleFixtureOutboxCleanup([
        { id: "pending", status: "pending" },
        { id: "failed", status: "failed" },
        { id: "processing", status: "processing" },
        { id: "done", status: "completed" },
      ]),
    ).toEqual({
      cancellableIds: ["pending", "failed"],
      processingIds: ["processing"],
    });
  });

  it("reconciles only rows deleted by the completed local fixture transaction", () => {
    const knownIds = new Set(["deleted-with-local-fixtures", "late-job"]);
    expect(
      reconcileBasicLifecycleKnownOutboxIds({
        knownIds,
        existingRows: [{ id: "late-job" }],
        localFixtureCleanupComplete: true,
      }),
    ).toEqual(new Set(["late-job"]));
    expect(() =>
      reconcileBasicLifecycleKnownOutboxIds({
        knownIds,
        existingRows: [{ id: "late-job" }],
        localFixtureCleanupComplete: false,
      }),
    ).toThrow(/disappeared before quiescence/);
  });

  it("uses live tuple checks only around outbox polling, never on each wait iteration", () => {
    const stages = [
      "before",
      ...Array.from({ length: 960 }, () => "poll" as const),
      "after",
    ] as const;
    const modes = stages.map(getBasicLifecycleOutboxTupleCheckMode);
    expect(modes.filter((mode) => mode === "live")).toHaveLength(2);
    expect(modes.filter((mode) => mode === "database")).toHaveLength(960);
  });

  it("discovers delayed exact outbox work from the DB baseline without an app-clock gate", () => {
    const baselineJobIds = new Set(["retained-job"]);
    const exactFixtureValues = new Set(["fixture-account"]);
    const base = {
      baselineJobIds,
      knownFixtureJobIds: new Set<string>(),
      exactFixtureValues,
      runMarker: "fixture-run",
    };
    expect(
      isBasicLifecycleExactFixtureOutboxJob({
        ...base,
        job: {
          id: "delayed-job",
          payload: { accountId: "fixture-account" },
          idempotencyKey: "canonical-key-without-run-marker",
        },
      }),
    ).toBe(true);
    expect(
      isBasicLifecycleExactFixtureOutboxJob({
        ...base,
        job: {
          id: "retained-job",
          payload: { accountId: "fixture-account" },
          idempotencyKey: "fixture-run",
        },
      }),
    ).toBe(false);
    expect(
      isBasicLifecycleExactFixtureOutboxJob({
        ...base,
        job: {
          id: "unrelated-job",
          payload: { accountId: "other-account" },
          idempotencyKey: "canonical-key",
        },
      }),
    ).toBe(false);
  });

  it("requires every job-specific outbox identity to belong to the exact fixture", () => {
    const ownership = {
      storeId: "fixture-store",
      baselineJobIds: new Set(["retained-job"]),
      fixtureAccountIds: new Set(["fixture-account"]),
      fixtureShopperIds: new Set(["fixture-shopper"]),
      fixtureOrderIds: new Set(["fixture-order"]),
      fixtureOrderExternalIds: new Set(["fixture-order-external"]),
      fixtureGrantIds: new Set(["fixture-grant"]),
      fixtureCustomerNumericIds: new Set(["123"]),
      fixtureReferralIds: new Set(["fixture-referral"]),
      fixtureRedemptionIds: new Set(["fixture-redemption"]),
      fixtureCleanupIds: new Set(["fixture-cleanup"]),
      fixtureRewardIds: new Set(["fixture-reward"]),
      fixtureDiscountCodes: new Set(["FIXTURE-CODE"]),
    };
    const exactJobs = [
      {
        id: "holding",
        jobType: "HOLDING_PERIOD_RELEASE",
        payload: {
          accountId: "fixture-account",
          shopperId: "fixture-shopper",
          orderId: "fixture-order",
          grantId: "fixture-grant",
          sourceOrderExternalId: "fixture-order-external",
        },
      },
      {
        id: "expiry",
        jobType: "INACTIVITY_EXPIRY",
        payload: { accountId: "fixture-account" },
      },
      {
        id: "tier",
        jobType: "TIER_REVIEW",
        payload: { accountId: "fixture-account" },
      },
      {
        id: "metafield",
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: "fixture-account",
          shopifyCustomerId: "123",
        },
      },
      {
        id: "recovery",
        jobType: "REDEMPTION_RECOVERY",
        payload: {
          accountId: "fixture-account",
          redemptionId: "fixture-redemption",
          rewardDefinitionId: "fixture-reward",
          shopifyDiscountCode: "FIXTURE-CODE",
        },
      },
      {
        id: "birthday",
        jobType: "BIRTHDAY_REWARD",
        payload: { accountId: "fixture-account" },
      },
      {
        id: "referral",
        jobType: "REFERRAL_REWARD_PROVISION",
        payload: {
          referralId: "fixture-referral",
          qualificationOrderId: "fixture-order",
          accountId: "fixture-account",
          rewardDefinitionId: "fixture-reward",
          side: "advocate",
        },
      },
      {
        id: "privacy",
        jobType: "VOUCHER_PRIVACY_CLEANUP",
        payload: {
          cleanupId: "fixture-cleanup",
          redemptionId: "fixture-redemption",
          accountId: "fixture-account",
        },
      },
    ];
    for (const job of exactJobs) {
      expect(() =>
        assertBasicLifecycleFixtureOutboxOwnership({ ...ownership, job }),
      ).not.toThrow();
    }

    expect(() =>
      assertBasicLifecycleFixtureOutboxOwnership({
        ...ownership,
        job: {
          ...exactJobs[4],
          payload: {
            ...(exactJobs[4].payload as Record<string, unknown>),
            accountId: "retained-account",
          },
        },
      }),
    ).toThrow(/mixes retained or non-fixture identities/);
    expect(() =>
      assertBasicLifecycleFixtureOutboxOwnership({
        ...ownership,
        job: {
          ...exactJobs[6],
          payload: {
            ...(exactJobs[6].payload as Record<string, unknown>),
            accountId: "retained-account",
          },
        },
      }),
    ).toThrow(/mixes retained or non-fixture identities/);
    expect(() =>
      assertBasicLifecycleFixtureOutboxOwnership({
        ...ownership,
        job: { ...exactJobs[1], id: "retained-job" },
      }),
    ).toThrow(/mixes retained or non-fixture identities/);
  });

  it("uses the internal commerce order identity for referral settlement evidence", () => {
    const identity = getBasicLifecycleReferralQualificationIdentity({
      referralId: "referral-fixture",
      commerceOrderId: "worder_internal",
    });
    expect(identity).toEqual({
      qualifyingOrderId: "worder_internal",
      advocateLedgerKey: "referral_advocate:referral-fixture:worder_internal",
      refereeLedgerKey: "referral_referee:referral-fixture:worder_internal",
    });
  });

  it("allows only a fully fixture-owned self-referential referral tree to be cleared", () => {
    const fixtureAccountIds = new Set(["advocate", "referee"]);
    expect(() =>
      assertBasicLifecycleReferralCleanupOwnership({
        fixtureAccountIds,
        accountPointers: [
          { id: "advocate", referredById: null },
          { id: "referee", referredById: "advocate" },
        ],
        referrals: [
          {
            advocateAccountId: "advocate",
            refereeAccountId: "referee",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleReferralCleanupOwnership({
        fixtureAccountIds,
        accountPointers: [
          { id: "advocate", referredById: null },
          { id: "referee", referredById: "advocate" },
          { id: "retained", referredById: "advocate" },
        ],
        referrals: [],
      }),
    ).toThrow(/retained account|cross-fixture referral/);
    expect(() =>
      assertBasicLifecycleReferralCleanupOwnership({
        fixtureAccountIds,
        accountPointers: [
          { id: "advocate", referredById: null },
          { id: "referee", referredById: "advocate" },
        ],
        referrals: [
          {
            advocateAccountId: "advocate",
            refereeAccountId: "retained",
          },
        ],
      }),
    ).toThrow(/retained account|cross-fixture referral/);
  });

  it("blocks temporary-definition deletion when any reference is not an exact fixture row", () => {
    const fixtureAccountIds = new Set(["fixture-account"]);
    const safe = {
      fixtureAccountIds,
      references: [
        {
          family: "reward redemption",
          rowId: "fixture-redemption",
          accountId: "fixture-account",
          exactFixtureRow: true,
        },
      ],
    };
    expect(() =>
      assertBasicLifecycleTemporaryDefinitionReferenceOwnership(safe),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleTemporaryDefinitionReferenceOwnership({
        ...safe,
        references: [
          {
            family: "reward redemption",
            rowId: "concurrent-redemption",
            accountId: "retained-account",
            exactFixtureRow: false,
          },
        ],
      }),
    ).toThrow(/non-fixture row references temporary loyalty configuration/);
  });

  it("reconciles partial registered customer evidence and excludes exact synthetic webhook rows", () => {
    const generation = "install-generation";
    const terminalRow = (webhookId: string, digest: string) => ({
      webhookId,
      payload: null,
      authenticatedBodyDigest: digest,
      storeInstallationGeneration: generation,
      status: "processed",
      processedAt: new Date("2026-08-30T00:00:00.000Z"),
      error: null,
    });
    const baseline = terminalRow("retained", "baseline-digest");
    const first = terminalRow("registered-1", "fixture-digest-1");
    const synthetic = terminalRow("synthetic-owned", "synthetic-digest");
    const common = {
      baselineCount: 1,
      baselineNonNullPayloadCount: 0,
      baselineInvalidCount: 0,
      baselineBodyDigests: new Set(["baseline-digest"]),
      ownedSyntheticWebhookIds: new Set(["synthetic-owned"]),
      installationGeneration: generation,
      expectedRegisteredCount: 2,
    };
    const partial = evaluateBasicLifecycleCustomerCreateAuditEvidence({
      ...common,
      rows: [baseline, first, synthetic],
    });
    expect(partial).toMatchObject({
      exact: false,
      candidateCount: 1,
      terminalCandidateCount: 1,
      terminalBodyDigests: ["fixture-digest-1"],
    });
    const complete = evaluateBasicLifecycleCustomerCreateAuditEvidence({
      ...common,
      rows: [
        baseline,
        first,
        terminalRow("registered-2", "fixture-digest-2"),
        terminalRow("registered-duplicate", "fixture-digest-duplicate"),
        synthetic,
      ],
    });
    expect(complete).toMatchObject({
      exact: true,
      candidateCount: 3,
      terminalCandidateCount: 3,
    });
  });

  it("requires exact active or redacted disposable customer projection proof", () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const common = {
      storeId: "store-fixture",
      customerId: "42",
      expectedPseudonym: "redacted:v1:key:DIGEST",
      expectedIdentityKeyId: "key",
      expectedCustomerDigest: "DIGEST",
      now,
      baselineShopperIds: new Set(["retained-shopper"]),
      baselineAccountIds: new Set(["retained-account"]),
      fixtureRequestIds: new Set(["request-fixture"]),
    };
    const activeShopper = {
      id: "shopper-fixture",
      storeId: "store-fixture",
      shopifyCustomerId: "42",
      firstName: "A1",
      lastName: "advocate",
      email: "fixture@example.com",
      phone: null,
      locale: null,
      tags: ["weletic-a1-disposable"],
      segmentIds: null,
      acceptsMarketing: false,
    };
    const activeAccount = {
      id: "account-fixture",
      storeId: "store-fixture",
      shopperId: "shopper-fixture",
      status: "active",
      referralCode: null,
      referredById: null,
      lastQualifyingActivityAt: null,
      nextExpiryDate: null,
    };
    expect(
      assertBasicLifecycleFixtureCustomerProjection({
        ...common,
        shopper: activeShopper,
        account: activeAccount,
        tombstone: null,
        hasRedactionMetadata: false,
        metadataContainsFixtureIdentity: false,
      }),
    ).toBe("active");
    expect(() =>
      assertBasicLifecycleFixtureCustomerProjection({
        ...common,
        shopper: activeShopper,
        account: activeAccount,
        tombstone: null,
        hasRedactionMetadata: true,
        metadataContainsFixtureIdentity: false,
      }),
    ).toThrow(/untombstoned/);

    const redactedShopper = {
      ...activeShopper,
      shopifyCustomerId: common.expectedPseudonym,
      firstName: "Redacted",
      lastName: "Customer",
      email: null,
      tags: null,
      segmentIds: null,
    };
    const redactedAccount = { ...activeAccount, status: "closed" };
    const sourceRequest = {
      id: "request-fixture",
      storeId: "store-fixture",
      requestType: "customer_redact",
      status: "completed",
      phase: "completed",
      completedAt: new Date("2026-08-29T23:59:00.000Z"),
      subjectKind: null,
      subjectKeyId: null,
      subjectDigest: null,
      payloadCiphertext: null,
    };
    const tombstone = {
      storeId: "store-fixture",
      identityKind: "customer_id",
      identityKeyId: "key",
      customerDigest: "DIGEST",
      shopperId: "shopper-fixture",
      accountId: "account-fixture",
      sourceRequestId: "request-fixture",
      expiresAt: new Date("2026-09-30T00:00:00.000Z"),
      sourceRequest,
    };
    const redacted = {
      ...common,
      shopper: redactedShopper,
      account: redactedAccount,
      tombstone,
      hasRedactionMetadata: true,
      metadataContainsFixtureIdentity: false,
    };
    expect(assertBasicLifecycleFixtureCustomerProjection(redacted)).toBe(
      "redacted",
    );
    for (const unsafe of [
      {
        ...redacted,
        shopper: { ...redactedShopper, shopifyCustomerId: "wrong" },
      },
      { ...redacted, tombstone: { ...tombstone, expiresAt: now } },
      {
        ...redacted,
        tombstone: { ...tombstone, storeId: "other-store" },
      },
      { ...redacted, metadataContainsFixtureIdentity: true },
      {
        ...redacted,
        baselineShopperIds: new Set(["shopper-fixture"]),
      },
      {
        ...redacted,
        tombstone: {
          ...tombstone,
          sourceRequest: { ...sourceRequest, phase: "processing" },
        },
      },
      {
        ...redacted,
        tombstone: {
          ...tombstone,
          sourceRequest: { ...sourceRequest, subjectKind: "customer_id" },
        },
      },
      {
        ...redacted,
        tombstone: {
          ...tombstone,
          sourceRequest: { ...sourceRequest, subjectKeyId: "key" },
        },
      },
      {
        ...redacted,
        tombstone: {
          ...tombstone,
          sourceRequest: { ...sourceRequest, subjectDigest: "DIGEST" },
        },
      },
    ]) {
      expect(() =>
        assertBasicLifecycleFixtureCustomerProjection(unsafe),
      ).toThrow();
    }
  });

  it("assigns one serialized customer while retaining duplicate terminal audit evidence", () => {
    expect(
      assignBasicLifecycleSerializedCustomerCreateAuditEvidence({
        customerGids: new Set(["gid://shopify/Customer/1"]),
        existingAssignments: new Map(),
        terminalCandidates: [
          { webhookId: "registered-1", bodyDigest: "digest-1" },
          { webhookId: "registered-2", bodyDigest: "digest-2" },
        ],
      }),
    ).toEqual({
      primary: {
        customerGid: "gid://shopify/Customer/1",
        assignment: { webhookId: "registered-1", bodyDigest: "digest-1" },
      },
      duplicateCandidates: [
        { webhookId: "registered-2", bodyDigest: "digest-2" },
      ],
    });
    expect(
      assignBasicLifecycleSerializedCustomerCreateAuditEvidence({
        customerGids: new Set(["gid://shopify/Customer/1"]),
        existingAssignments: new Map([
          [
            "gid://shopify/Customer/1",
            { webhookId: "registered-1", bodyDigest: "digest-1" },
          ],
        ]),
        existingDuplicateWebhookIds: new Set(["registered-2"]),
        terminalCandidates: [
          { webhookId: "registered-1", bodyDigest: "digest-1" },
          { webhookId: "registered-2", bodyDigest: "digest-2" },
          { webhookId: "registered-3", bodyDigest: "digest-3" },
        ],
      }),
    ).toEqual({
      primary: null,
      duplicateCandidates: [
        { webhookId: "registered-3", bodyDigest: "digest-3" },
      ],
    });
    expect(() =>
      assignBasicLifecycleSerializedCustomerCreateAuditEvidence({
        customerGids: new Set([
          "gid://shopify/Customer/1",
          "gid://shopify/Customer/2",
        ]),
        existingAssignments: new Map(),
        terminalCandidates: [
          { webhookId: "registered-1", bodyDigest: "digest-1" },
          { webhookId: "registered-2", bodyDigest: "digest-2" },
        ],
      }),
    ).toThrow(/ambiguous pairing/);
  });

  it("orders customer cleanup as wait, lock, revalidate, delete, and exact readback", async () => {
    const order: string[] = [];
    await runBasicLifecycleCustomerDeleteBarrier({
      waitForTerminalIngress: async () => {
        order.push("wait");
      },
      withCustomerLock: async (task) => {
        order.push("lock");
        return task();
      },
      revalidateInsideLock: async () => {
        order.push("revalidate");
      },
      deleteAndConfirmInsideLock: async () => {
        order.push("delete-and-readback");
      },
    });
    expect(order).toEqual([
      "wait",
      "lock",
      "revalidate",
      "delete-and-readback",
    ]);
  });

  it("requires two empty outbox scans and resets stability when delayed work appears", () => {
    const firstEmpty = advanceBasicLifecycleOutboxStablePasses({
      previousStablePasses: 0,
      beforeCount: 0,
      afterCount: 0,
    });
    expect(firstEmpty).toBe(1);
    expect(
      advanceBasicLifecycleOutboxStablePasses({
        previousStablePasses: firstEmpty,
        beforeCount: 0,
        afterCount: 1,
      }),
    ).toBe(0);
    expect(() =>
      assertBasicLifecycleFinalCleanupPrerequisites({
        localFixtureCleanupComplete: true,
        fixtureOutboxQuiescedAfterLocalCleanup: false,
      }),
    ).toThrow(/post-local outbox/);
  });

  it("keeps the lease when the atomic release transaction sees late residue", () => {
    const clean = {
      residueCounts: [0, 0, 0],
      temporaryDefinitionReferenceCount: 0,
      fixtureOutboxCount: 0,
      fixtureWebhookCount: 0,
    };
    expect(() => assertBasicLifecycleAtomicReleaseAudit(clean)).not.toThrow();
    for (const drift of [
      { residueCounts: [0, 1] },
      { temporaryDefinitionReferenceCount: 1 },
      { fixtureOutboxCount: 1 },
      { fixtureWebhookCount: 1 },
    ]) {
      expect(() =>
        assertBasicLifecycleAtomicReleaseAudit({ ...clean, ...drift }),
      ).toThrow(/atomic lease-release audit/);
    }
  });

  it("releases the maintenance lease only after every cleanup proof succeeds", () => {
    const complete = {
      maintenanceLeaseAcquired: true,
      programSnapshotRestored: true,
      localFixtureCleanupComplete: true,
      fixtureOutboxQuiescedAfterLocalCleanup: true,
      zeroResiduePasses: 2,
      baselineOutboxVerified: true,
    };
    expect(() =>
      assertBasicLifecycleMaintenanceReleasePrerequisites(complete),
    ).not.toThrow();
    for (const incomplete of [
      { ...complete, maintenanceLeaseAcquired: false },
      { ...complete, programSnapshotRestored: false },
      { ...complete, localFixtureCleanupComplete: false },
      { ...complete, fixtureOutboxQuiescedAfterLocalCleanup: false },
      { ...complete, zeroResiduePasses: 1 },
      { ...complete, baselineOutboxVerified: false },
    ]) {
      expect(() =>
        assertBasicLifecycleMaintenanceReleasePrerequisites(incomplete),
      ).toThrow(/maintenance lease remains active/);
    }
  });

  it("requires exact delete counts before a cleanup transaction can commit", () => {
    expect(() =>
      assertBasicLifecycleExactDeleteCount({
        family: "fixture rewards",
        expected: 2,
        actual: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleExactDeleteCount({
        family: "fixture rewards",
        expected: 2,
        actual: 1,
      }),
    ).toThrow(/deletion count changed/);
  });

  it("retries exact customer search through delayed Shopify indexing", async () => {
    const lookup = vi
      .fn<() => Promise<Array<{ id: string; tags: string[]; email: string }>>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "gid://shopify/Customer/42",
          tags: ["weletic-a1-disposable", "weletic-a1-run"],
          email: "fixture@example.com",
        },
      ]);
    const wait = vi.fn(async () => undefined);
    const result = await reconcileBasicLifecycleDisposableCustomerSearch({
      lookup,
      mode: "unique",
      runMarker: "weletic-a1-run",
      expectedEmail: "fixture@example.com",
      wait,
      maxAttempts: 4,
      pollMs: 1,
    });
    expect(result).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("refuses baseline, missing, payout-owned, or externally shared FX snapshots", () => {
    const safe = {
      snapshotIds: new Set(["wfx_fixture"]),
      baselineIds: new Set(["wfx_retained"]),
      snapshots: [
        {
          id: "wfx_fixture",
          orderIds: ["order_fixture"],
          refundIds: ["refund_fixture"],
          payoutQuoteCount: 0,
        },
      ],
      exactOrderIds: new Set(["order_fixture"]),
      exactRefundIds: new Set(["refund_fixture"]),
    };
    expect(() => assertBasicLifecycleFxSnapshotOwnership(safe)).not.toThrow();
    for (const unsafe of [
      { ...safe, baselineIds: new Set(["wfx_fixture"]) },
      { ...safe, snapshots: [] },
      {
        ...safe,
        snapshots: [{ ...safe.snapshots[0], payoutQuoteCount: 1 }],
      },
      {
        ...safe,
        snapshots: [{ ...safe.snapshots[0], orderIds: ["retained-order"] }],
      },
    ]) {
      expect(() => assertBasicLifecycleFxSnapshotOwnership(unsafe)).toThrow(
        /cleanup was stopped/,
      );
    }
  });

  it("requires exact discount-GID absence even when a code lookup could miss a renamed node", () => {
    expect(() =>
      assertBasicLifecycleExactDiscountDeleted(
        "gid://shopify/DiscountCodeNode/42",
        null,
      ),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleExactDiscountDeleted(
        "gid://shopify/DiscountCodeNode/42",
        { id: "gid://shopify/DiscountCodeNode/42" },
      ),
    ).toThrow(/exact fixture discount GID/);
  });

  it("accepts only exact terminal voucher-cleanup ownership after privacy metadata is scrubbed", () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const input = {
      storeId: "store_fixture",
      redemption: {
        id: "redemption_fixture",
        accountId: "account_fixture",
        rewardDefinitionId: "reward_fixture",
        shopifyDiscountCode: "WL-A1-FIXTURE",
      },
      discountGid: "gid://shopify/DiscountCodeNode/42",
      expectedOwnershipFingerprint: "FINGERPRINT123",
      cleanup: {
        id: "cleanup_fixture",
        storeId: "store_fixture",
        redemptionId: "redemption_fixture",
        sourceRequestId: "request_fixture",
        source: "customer_redact",
        status: "completed",
        expectedDiscountCodeCanonical: "WL-A1-FIXTURE",
        expectedDiscountId: "gid://shopify/DiscountCodeNode/42",
        ownershipSnapshot: {
          version: 1,
          kind: "generic",
          expectedCode: "WL-A1-FIXTURE",
          expectedTitle: "Fixture reward [WL:FINGERPRINT123] (WL-A1-FIXTURE)",
          ownershipFingerprint: "FINGERPRINT123",
          remoteProvisionAttemptedAt: now.toISOString(),
          remoteProvisionReconcileUntil: now.toISOString(),
          captureError: null,
        },
        lastError: null,
        remoteVerifiedAt: now,
        remoteUsageCount: 0,
        remoteUsageObservedAt: now,
        remoteDeactivatedAt: now,
        remoteOutcome: "deactivated",
        completedAt: now,
      },
      requestLinks: [
        {
          storeId: "store_fixture",
          requestId: "request_fixture",
          cleanupId: "cleanup_fixture",
          request: {
            id: "request_fixture",
            storeId: "store_fixture",
            requestType: "customer_redact",
            status: "completed",
            phase: "completed",
            completedAt: now,
            payloadCiphertext: null,
          },
        },
      ],
      fixtureCleanupIds: new Set(["cleanup_fixture"]),
      fixtureRequestIds: new Set(["request_fixture"]),
      remote: {
        id: "gid://shopify/DiscountCodeNode/42",
        code: "wl-a1-fixture",
        title: "Fixture reward [WL:FINGERPRINT123] (WL-A1-FIXTURE)",
      },
    };
    expect(() =>
      assertBasicLifecycleCompletedVoucherCleanupOwnership(input),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleCompletedVoucherCleanupOwnership({
        ...input,
        fixtureRequestIds: new Set(["another-request"]),
      }),
    ).toThrow(/terminal cleanup ownership/);
    expect(() =>
      assertBasicLifecycleCompletedVoucherCleanupOwnership({
        ...input,
        cleanup: {
          ...input.cleanup,
          ownershipSnapshot: {
            ...input.cleanup.ownershipSnapshot,
            ownershipFingerprint: "WRONG",
          },
        },
      }),
    ).toThrow(/terminal cleanup ownership/);
    expect(() =>
      assertBasicLifecycleCompletedVoucherCleanupOwnership({
        ...input,
        remote: { ...input.remote, id: "gid://shopify/DiscountCodeNode/99" },
      }),
    ).toThrow(/terminal cleanup ownership/);
  });

  it("drains only exact harness-owned customer-redact requests", () => {
    const base = {
      storeId: "store_fixture",
      request: {
        id: "request_fixture",
        storeId: "store_fixture",
        requestType: "customer_redact",
        webhookId: "webhook_fixture",
      },
      fixtureRequestIds: new Set(["request_fixture"]),
      fixtureWebhookIds: new Set(["webhook_fixture"]),
    };
    expect(() =>
      assertBasicLifecycleOwnedCustomerRedactRequest(base),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleOwnedCustomerRedactRequest({
        ...base,
        fixtureWebhookIds: new Set(["unowned-webhook"]),
      }),
    ).toThrow(/exact fixture ownership/);
    expect(() =>
      assertBasicLifecycleOwnedCustomerRedactRequest({
        ...base,
        request: { ...base.request, storeId: "another-store" },
      }),
    ).toThrow(/exact fixture ownership/);
  });

  it("rejects a nominal customerDelete success while the exact customer remains", () => {
    const gid = "gid://shopify/Customer/42";
    expect(() =>
      assertBasicLifecycleExactCustomerDeleted(gid, null),
    ).not.toThrow();
    expect(() =>
      assertBasicLifecycleExactCustomerDeleted(gid, { id: gid }),
    ).toThrow(/still exposes the exact disposable customer/);
  });

  it("runs cleanup under the lock after every injected lifecycle phase failure", async () => {
    for (let failingPhase = 0; failingPhase < 3; failingPhase += 1) {
      let lockHeld = false;
      let cleanupRan = false;
      const phasesRun: number[] = [];
      const result = await runBasicLifecycleLockedOrchestration({
        withLocks: async (task) => {
          lockHeld = true;
          try {
            return await task();
          } finally {
            lockHeld = false;
          }
        },
        phases: [0, 1, 2].map((index) => ({
          name: `phase-${index}`,
          run: async () => {
            expect(lockHeld).toBe(true);
            phasesRun.push(index);
            if (index === failingPhase) throw new Error(`phase-${index}`);
          },
        })),
        cleanup: async () => {
          expect(lockHeld).toBe(true);
          cleanupRan = true;
        },
      });
      expect(result.phaseError).toBeInstanceOf(Error);
      expect(result.cleanupError).toBeUndefined();
      expect(cleanupRan).toBe(true);
      expect(phasesRun).toEqual(
        Array.from({ length: failingPhase + 1 }, (_, index) => index),
      );
      expect(lockHeld).toBe(false);
    }
  });

  it("stops production-style phases when the real state.check records a failure", async () => {
    const state = new HarnessState(
      parseBasicLifecycleArgs(["--confirm-staging"]),
    );
    const laterPhase = vi.fn();
    const cleanup = vi.fn();
    const result = await runBasicLifecycleLockedOrchestration({
      withLocks: (task) => task(),
      phases: [
        {
          name: "real-check",
          run: () =>
            state.check("real failing check", async () => {
              throw new Error("phase-sensitive-failure");
            }),
        },
        { name: "must-not-run", run: laterPhase },
      ],
      cleanup,
    });
    expect(result.phaseError).toBeInstanceOf(Error);
    expect(laterPhase).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(state.checks).toEqual([
      expect.objectContaining({
        name: "real failing check",
        status: "FAILED",
        reason: "phase-sensitive-failure",
      }),
    ]);
  });

  it("attempts every cleanup step and surfaces both cleanup and residue failures", async () => {
    const attempted: string[] = [];
    await expect(
      runBasicLifecycleCleanupSteps({
        steps: ["remote", "local", "residue"].map((name) => ({
          name,
          run: async () => {
            attempted.push(name);
            if (name !== "local") throw new Error(`${name}-failure`);
          },
        })),
      }),
    ).rejects.toThrow(/2 failure\(s\).*remote-failure.*residue-failure/);
    expect(attempted).toEqual(["remote", "local", "residue"]);
  });

  it("still captures read-only registered ingress when program restoration fails", async () => {
    const ingressCapture = vi.fn(async () => undefined);
    await expect(
      runBasicLifecycleCleanupSteps({
        steps: [
          {
            name: "restore-program",
            run: async () => {
              throw new Error("restore-failure");
            },
          },
          { name: "read-only-ingress", run: ingressCapture },
        ],
      }),
    ).rejects.toThrow(/restore-failure/);
    expect(ingressCapture).toHaveBeenCalledOnce();
  });

  it("preserves local ownership proof after an injected permanent remote failure", async () => {
    const remoteDiscountCleanupComplete = false;
    let localOwnershipProofExists = true;
    const localDelete = vi.fn(() => {
      localOwnershipProofExists = false;
    });
    await expect(
      runBasicLifecycleCleanupSteps({
        steps: [
          {
            name: "remote-discount",
            run: async () => {
              throw new Error("permanent-remote-failure");
            },
          },
          {
            name: "local-delete",
            run: async () => {
              assertBasicLifecycleLocalCleanupPrerequisites({
                customerIngressReconciled: true,
                outboxQuiescedForRemoteCleanup: true,
                outboxQuiescedForLocalCleanup: true,
                remoteDiscountCleanupComplete,
                remoteCustomerCleanupComplete: true,
                checkoutCacheCleanupComplete: true,
              });
              localDelete();
            },
          },
        ],
      }),
    ).rejects.toThrow(/2 failure\(s\)/);
    expect(localDelete).not.toHaveBeenCalled();
    expect(localOwnershipProofExists).toBe(true);
  });

  it("redacts emitted report files while preserving composite provenance and retained evidence labels", () => {
    const sensitive = "wfx_secret-fixture";
    const provenance = getBasicLifecycleEvidenceProvenance();
    const report: BasicLifecycleReport = {
      version: 4,
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:00:01.000Z",
      overallStatus: "FAILED",
      summary: { total: 2, passed: 0, failed: 2, deferred: 0 },
      checks: [
        {
          name: "fixture",
          status: "FAILED",
          durationMs: 1,
          evidence: provenance.synthetic[0],
          reason: `provider leaked ${sensitive} and fixture@example.com`,
        },
      ],
      cleanup: {
        name: "cleanup",
        status: "FAILED",
        durationMs: 1,
        evidence: provenance.cleanup[0],
        reason: `cleanup leaked ${sensitive}`,
      },
      evidenceProvenance: provenance,
      intentionallySkipped: [],
      intentionallyRetained: [
        "payload-free registered customers/create audit evidence: count=4",
        "keyed-HMAC customer privacy fences: count=2, ttlValid=true",
      ],
      recoveryCapsule: null,
    };
    const legacyStoreIdentifier = "loyalty-a1-private.myshopify.com";
    const legacyReport: BasicLifecycleReport & { storeDomain: string } = {
      ...report,
      storeDomain: legacyStoreIdentifier,
    };
    const serialized = serializeBasicLifecycleReportForFile(legacyReport, [
      sensitive,
    ]);
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain("fixture@example.com");
    expect(serialized).not.toContain(legacyStoreIdentifier);
    expect(serialized).not.toContain("storeDomain");
    expect(JSON.parse(serialized).evidenceProvenance.composite).toHaveLength(4);

    const directory = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "a1-report-"),
    );
    const reportPath = path.join(directory, "report.json");
    try {
      writeRedactedReport(reportPath, report, [sensitive]);
      const emitted = fs.readFileSync(reportPath, "utf8");
      expect(emitted).toBe(serialized);
      expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600);

      const missingParent = path.join(directory, "missing", "report.json");
      expect(() =>
        writeRedactedReport(missingParent, report, [sensitive]),
      ).toThrow();
      expect(fs.existsSync(path.dirname(missingParent))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
