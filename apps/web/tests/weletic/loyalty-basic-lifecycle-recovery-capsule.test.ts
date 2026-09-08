import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BasicLifecycleRecoveryCapsuleFile,
  parseBasicLifecycleRecoveryCapsule,
  readBasicLifecycleRecoveryCapsuleFile,
  sha256BasicLifecycleFile,
  writeExclusiveDurableArtifact,
} from "../../scripts/loyalty/basic-lifecycle-recovery-capsule";
import type { BasicLifecycleReport } from "../../scripts/loyalty/validate-basic-lifecycle";
import {
  createBasicLifecycleRecoverySnapshot,
  finalizeBasicLifecycleRecoveryArtifacts,
  getBasicLifecycleEvidenceProvenance,
  HarnessState,
  parseBasicLifecycleHarnessRecoveryCapsule,
} from "../../scripts/loyalty/validate-basic-lifecycle";

const temporaryDirectories: string[] = [];
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x31).toString("base64");
const WRONG_TEST_ENCRYPTION_KEY = Buffer.alloc(32, 0x32).toString("base64");

function privateTemporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "weletic-a1-recovery-"),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function createState(recoveryStatePath: string) {
  const state = new HarnessState(
    {
      confirmStaging: true,
      storeDomain: "a1-staging.myshopify.com",
      webhookTarget: "http://127.0.0.1:8888/api/shopify/integration/webhook",
      recoveryStatePath,
    },
    new Date("2026-08-31T00:00:00.000Z"),
  );
  state.storeId = "store_fixture";
  state.workspaceId = "workspace_fixture";
  state.programId = "program_fixture";
  state.installationGeneration = "sgen_fixture";
  state.currency = "JPY";
  state.rewardFixtureName = "A1 amount-off recovery fixture";
  state.storeTuple = {
    storeId: "store_fixture",
    shopDomain: "a1-staging.myshopify.com",
    workspaceId: "workspace_fixture",
    platformProgramId: "platform_program_fixture",
    loyaltyProgramId: "program_fixture",
    installationGeneration: "sgen_fixture",
    complianceState: "active",
    currency: "JPY",
    currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
  };
  state.programBaselineUpdatedAt = new Date("2026-08-30T01:00:00.000Z");
  state.programSnapshot = {
    name: "Baseline",
    status: "active",
    pointNameSingular: "point",
    pointNamePlural: "points",
    pointsPerCurrencyUnit: "1",
    holdingPeriodDays: 14,
    pointsExpiryMonths: 12,
    killSwitchActive: false,
    activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    disabledAt: null,
    enableOnlineStoreLauncher: true,
    enableCustomerAccountHub: true,
    enableCheckoutExtension: false,
    enableProductPointsWidget: true,
    enableMetafieldsSync: true,
    surfaceFlags: { retained: true },
    vipMilestoneMode: "points_earned",
    vipTimeframe: "lifetime",
    vipDowngradeGraceDays: 30,
    vipAutoDowngradeEnabled: true,
    branding: { retained: true },
    metadata: { retained: true },
  };
  state.baselineRuleIds.add("baseline_rule");
  state.baselineRuleDigests.set("baseline_rule", "a".repeat(64));
  state.baselineAccountTierById.set("baseline_account", {
    programId: "program_fixture",
    shopperId: "baseline_shopper",
    status: "active",
    ledgerVersion: 7,
    cachedPointsBalance: BigInt("9007199254740993"),
    cachedPendingPoints: BigInt(12),
    lifetimePointsEarned: BigInt(34),
    lifetimePointsRedeemed: BigInt(5),
    referralCount: 1,
    referralPointsEarned: BigInt(6),
    referralCode: "BASELINE",
    referredById: null,
    currentTierId: "baseline_tier",
    tierExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
    tierSpendRolling12Months: BigInt(100),
    tierPointsRolling12Months: BigInt(200),
    lastQualifyingActivityAt: new Date("2026-08-01T00:00:00.000Z"),
    nextExpiryDate: new Date("2027-08-01T00:00:00.000Z"),
    metadata: { retained: true },
    enrolledAt: new Date("2025-01-01T00:00:00.000Z"),
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  });
  state.fixtureCustomerNumericIds.add("18446744073709551615");
  state.fixtureLocalIdentityByCustomerId.set("18446744073709551615", {
    shopperId: "shopper_fixture",
    accountId: "account_fixture",
  });
  state.fixtureOutboxIds.add("outbox_fixture");
  state.checks.push({
    name: "baseline",
    status: "PASSED",
    durationMs: 1,
    evidence: getBasicLifecycleEvidenceProvenance().local[0],
  });
  return state;
}

function markFullyCleanedState(state: HarnessState) {
  const digest = (value: string) =>
    crypto.createHash("sha256").update(value).digest("hex");
  state.maintenanceLeaseMetadata = {
    __weleticLoyaltyMaintenanceLeaseV1: {
      acquiredAt: "2026-08-31T00:00:00.000Z",
      baselineMetadataSha256: "1".repeat(64),
      fixtureDisposableTagSha256: digest("weletic-a1-disposable"),
      fixtureEmailSha256: [...state.fixtureCustomerEmails]
        .map((email) => digest(email))
        .sort(),
      fixtureRunMarkerTagSha256: digest(state.runMarker),
      ownerTokenSha256: digest(state.maintenanceOwnerToken),
      recoveryAfter: "2026-08-31T06:00:00.000Z",
    },
  };
  state.maintenanceLeaseAcquired = true;
  state.maintenanceLeaseReleased = true;
  state.maintenanceLeaseReleaseDispatched = true;
  state.fixtureCustomerIngressReconciled = true;
  state.fixtureOutboxQuiescedForRemoteCleanup = true;
  state.remoteDiscountCleanupComplete = true;
  state.remoteCustomerCleanupComplete = true;
  state.checkoutCacheCleanupComplete = true;
  state.fixtureOutboxQuiescedForLocalCleanup = true;
  state.localFixtureCleanupComplete = true;
  state.fixtureOutboxQuiescedAfterLocalCleanup = true;
  state.zeroResiduePasses = 2;
  state.baselineOutboxVerified = true;
}

function reportFor(
  state: HarnessState,
  overallStatus: "PASSED" | "FAILED",
): BasicLifecycleReport {
  const provenance = getBasicLifecycleEvidenceProvenance();
  return {
    version: 4,
    startedAt: state.startedAt.toISOString(),
    completedAt: "2026-08-31T00:01:00.000Z",
    overallStatus,
    summary: {
      total: 1,
      passed: overallStatus === "PASSED" ? 1 : 0,
      failed: overallStatus === "FAILED" ? 1 : 0,
      deferred: 0,
    },
    checks: [],
    cleanup: {
      name: "Restore configuration and remove disposable fixtures",
      status: overallStatus,
      durationMs: 1,
      evidence: provenance.cleanup[0],
    },
    evidenceProvenance: provenance,
    intentionallySkipped: [],
    intentionallyRetained: [],
    recoveryCapsule: { sha256: state.recoveryCapsuleSha256()! },
  };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

afterEach(() => {
  if (originalEncryptionKey === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("A1 future-run recovery capsules", () => {
  it("round-trips the complete cleanup snapshot with exact Date, BigInt, Set, and Map values", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const state = createState(capsulePath);

    state.initializeRecoveryCapsule("baseline:captured");

    expect(fs.statSync(capsulePath).mode & 0o777).toBe(0o600);
    const parsed = parseBasicLifecycleHarnessRecoveryCapsule(
      fs.readFileSync(capsulePath, "utf8"),
    );
    expect(parsed.version).toBe(1);
    expect(parsed.checkpoint).toBe("baseline:captured");
    expect(parsed.state.harnessState.startedAt).toEqual(state.startedAt);
    expect(
      (
        parsed.state.harnessState.baselineAccountTierById.get(
          "baseline_account",
        ) as { cachedPointsBalance: bigint; tierExpiresAt: Date }
      ).cachedPointsBalance,
    ).toBe(BigInt("9007199254740993"));
    expect(
      (
        parsed.state.harnessState.programSnapshot as {
          activatedAt: Date;
        }
      ).activatedAt,
    ).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(
      parsed.state.harnessState.fixtureCustomerNumericIds.has(
        "18446744073709551615",
      ),
    ).toBe(true);
    expect(parsed.state.harnessState.baselineRuleDigests).toEqual(
      state.baselineRuleDigests,
    );
    expect(Object.keys(parsed.state.harnessState)).not.toContain("accessToken");
    expect(Object.keys(parsed.state.harnessState)).not.toContain(
      "maintenancePermit",
    );
  });

  it("round-trips an own __proto__ field without prototype mutation", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "prototype-safe.json");
    const state = JSON.parse(
      '{"__proto__":{"polluted":true},"retained":"value"}',
    ) as Record<string, unknown>;
    const file = new BasicLifecycleRecoveryCapsuleFile<Record<string, unknown>>(
      capsulePath,
    );
    file.create({ state, checkpoint: "prototype-safe" });

    const parsed = file.load().state;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(
      true,
    );
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects authenticated capsules with malformed recovery-critical nested state", () => {
    const mutations: Array<
      (
        snapshot: ReturnType<typeof createBasicLifecycleRecoverySnapshot>,
      ) => void
    > = [
      (snapshot) => {
        (
          snapshot.harnessState as unknown as Record<string, unknown>
        ).storeTuple = new Map();
      },
      (snapshot) => {
        (
          snapshot.harnessState as unknown as Record<string, unknown>
        ).programSnapshot = new Date();
      },
      (snapshot) => {
        (snapshot.harnessState as unknown as Record<string, unknown>).checks = [
          { garbage: true },
        ];
      },
      (snapshot) => {
        snapshot.harnessState.baselineAccountTierById.set("malformed", {
          garbage: true,
        } as never);
      },
      (snapshot) => {
        (
          snapshot.harnessState as unknown as Record<string, unknown>
        ).maintenanceLeaseMetadata = { notALease: true };
      },
    ];

    mutations.forEach((mutate, index) => {
      const directory = privateTemporaryDirectory();
      const capsulePath = path.join(directory, `malformed-${index}.json`);
      const snapshot = createBasicLifecycleRecoverySnapshot(
        createState(capsulePath),
      );
      mutate(snapshot);
      new BasicLifecycleRecoveryCapsuleFile(capsulePath).create({
        state: snapshot,
        checkpoint: "malformed-authenticated-state",
      });
      expect(() =>
        parseBasicLifecycleHarnessRecoveryCapsule(
          fs.readFileSync(capsulePath, "utf8"),
        ),
      ).toThrow(/Recovery/);
    });
  });

  it("requires a canonical 256-bit key before creating a file and uses a fresh nonce", () => {
    const directory = privateTemporaryDirectory();
    const missingKeyPath = path.join(directory, "missing-key.json");
    delete process.env.ENCRYPTION_KEY;
    expect(() =>
      createState(missingKeyPath).initializeRecoveryCapsule("missing-key"),
    ).toThrow(/exact 32-byte canonical base64 or 64-character hexadecimal/);
    expect(fs.existsSync(missingKeyPath)).toBe(false);

    const weakKeyPath = path.join(directory, "weak-key.json");
    process.env.ENCRYPTION_KEY = "human-readable-passphrase";
    expect(() =>
      createState(weakKeyPath).initializeRecoveryCapsule("weak-key"),
    ).toThrow(/exact 32-byte canonical base64 or 64-character hexadecimal/);
    expect(fs.existsSync(weakKeyPath)).toBe(false);

    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const firstPath = path.join(directory, "first.json");
    const secondPath = path.join(directory, "second.json");
    createState(firstPath).initializeRecoveryCapsule("same-checkpoint");
    createState(secondPath).initializeRecoveryCapsule("same-checkpoint");
    const firstEnvelope = JSON.parse(fs.readFileSync(firstPath, "utf8"));
    const secondEnvelope = JSON.parse(fs.readFileSync(secondPath, "utf8"));
    expect(
      Buffer.from(firstEnvelope.ciphertext, "base64").subarray(0, 12),
    ).not.toEqual(
      Buffer.from(secondEnvelope.ciphertext, "base64").subarray(0, 12),
    );

    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    const hexKeyPath = path.join(directory, "hex-key.json");
    createState(hexKeyPath).initializeRecoveryCapsule("hex-key");
    expect(readBasicLifecycleRecoveryCapsuleFile(hexKeyPath).sequence).toBe(0);
  });

  it("encrypts the exact recovery owner and fixture identities while excluding runtime credentials", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const state = createState(capsulePath);
    const previousWebhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const customerGid = "gid://shopify/Customer/18446744073709551615";
    const localAccountId = "lacct_confidential_fixture_identity";
    state.accessToken = "shpat_must_not_enter_capsule";
    state.remoteCustomerGids.add(customerGid);
    state.fixtureAccountIds.add(localAccountId);
    process.env.SHOPIFY_WEBHOOK_SECRET =
      "webhook-secret-must-not-enter-capsule";
    process.env.DATABASE_URL =
      "postgresql://database-secret-must-not-enter-capsule.invalid/db";
    try {
      state.initializeRecoveryCapsule("baseline:captured");
      const bytes = fs.readFileSync(capsulePath, "utf8");
      expect(bytes).not.toContain(state.accessToken);
      expect(bytes).not.toContain(process.env.ENCRYPTION_KEY);
      expect(bytes).not.toContain(process.env.SHOPIFY_WEBHOOK_SECRET);
      expect(bytes).not.toContain(process.env.DATABASE_URL);
      expect(bytes).not.toContain(state.maintenanceOwnerToken);
      expect(bytes).not.toContain(state.runMarker);
      for (const email of state.fixtureCustomerEmails) {
        expect(bytes).not.toContain(email);
      }
      expect(bytes).not.toContain("18446744073709551615");
      expect(bytes).not.toContain(customerGid);
      expect(bytes).not.toContain(localAccountId);

      const parsed = parseBasicLifecycleHarnessRecoveryCapsule(bytes);
      expect(parsed.state.harnessState.maintenanceOwnerToken).toBe(
        state.maintenanceOwnerToken,
      );
      expect(parsed.state.harnessState.fixtureCustomerEmails).toEqual(
        state.fixtureCustomerEmails,
      );
      expect(parsed.state.harnessState.fixtureCustomerNumericIds).toContain(
        "18446744073709551615",
      );
      expect(parsed.state.harnessState.remoteCustomerGids).toContain(
        customerGid,
      );
      expect(parsed.state.harnessState.fixtureAccountIds).toContain(
        localAccountId,
      );
    } finally {
      if (previousWebhookSecret === undefined) {
        delete process.env.SHOPIFY_WEBHOOK_SECRET;
      } else {
        process.env.SHOPIFY_WEBHOOK_SECRET = previousWebhookSecret;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("never overwrites an existing capsule and rejects direct or parent symlinks", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const first = createState(capsulePath);
    first.initializeRecoveryCapsule("baseline:captured");
    const original = fs.readFileSync(capsulePath, "utf8");

    expect(() =>
      createState(capsulePath).initializeRecoveryCapsule("second-run"),
    ).toThrow(/already exists/);
    expect(fs.readFileSync(capsulePath, "utf8")).toBe(original);

    const symlinkPath = path.join(directory, "symlink.json");
    fs.symlinkSync(capsulePath, symlinkPath);
    expect(() =>
      createState(symlinkPath).initializeRecoveryCapsule("symlink-run"),
    ).toThrow(/symlink/);

    const linkedDirectory = path.join(directory, "linked-directory");
    fs.symlinkSync(directory, linkedDirectory);
    expect(() =>
      createState(
        path.join(linkedDirectory, "other.json"),
      ).initializeRecoveryCapsule("parent-symlink"),
    ).toThrow(/symlink/);
  });

  it("allows a root-owned sticky system temp ancestor only through a private mode-0700 leaf", () => {
    const systemTemporaryDirectory = fs.realpathSync(os.tmpdir());
    const systemTemporaryStat = fs.statSync(systemTemporaryDirectory);
    const isRootOwnedStickySharedAncestor =
      systemTemporaryStat.uid === 0 &&
      (systemTemporaryStat.mode & 0o1000) !== 0 &&
      (systemTemporaryStat.mode & 0o022) !== 0;
    const privateLeaf = privateTemporaryDirectory();
    const capsulePath = path.join(privateLeaf, "recovery.json");

    createState(capsulePath).initializeRecoveryCapsule("portable-temp-leaf");

    expect(fs.statSync(privateLeaf).mode & 0o777).toBe(0o700);
    expect(readBasicLifecycleRecoveryCapsuleFile(capsulePath).sequence).toBe(0);
    if ((systemTemporaryStat.mode & 0o022) !== 0) {
      expect(isRootOwnedStickySharedAncestor).toBe(true);
    }
  });

  it("rejects non-private files and non-owner-writable or shared parent directories", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const state = createState(capsulePath);
    state.initializeRecoveryCapsule("baseline:captured");

    fs.chmodSync(capsulePath, 0o640);
    expect(() => state.checkpointRecoveryState("unsafe-file-mode")).toThrow(
      /mode-0600/,
    );
    fs.chmodSync(capsulePath, 0o600);

    const nonWritableDirectory = privateTemporaryDirectory();
    fs.chmodSync(nonWritableDirectory, 0o500);
    expect(() =>
      createState(
        path.join(nonWritableDirectory, "recovery.json"),
      ).initializeRecoveryCapsule("non-writable-parent"),
    ).toThrow(/mode-0700/);
    fs.chmodSync(nonWritableDirectory, 0o700);

    const sharedDirectory = privateTemporaryDirectory();
    fs.chmodSync(sharedDirectory, 0o720);
    expect(() =>
      createState(
        path.join(sharedDirectory, "recovery.json"),
      ).initializeRecoveryCapsule("shared-parent"),
    ).toThrow(/group\/world-writable/);
    fs.chmodSync(sharedDirectory, 0o700);
  });

  it("atomically replaces checkpoints and preserves the prior capsule when replacement fails", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const state = createState(capsulePath);
    const initialSnapshot = createBasicLifecycleRecoverySnapshot(state);
    let failBeforeRename = false;
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath, {
      beforeAtomicRename: () => {
        if (failBeforeRename) throw new Error("injected rename failure");
      },
    });
    file.create({ state: initialSnapshot, checkpoint: "initial" });
    const initialBytes = fs.readFileSync(capsulePath, "utf8");

    state.fixtureOutboxIds.add("outbox_after_checkpoint");
    file.checkpoint({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "next",
    });
    const nextBytes = fs.readFileSync(capsulePath, "utf8");
    expect(nextBytes).not.toBe(initialBytes);
    expect(readBasicLifecycleRecoveryCapsuleFile(capsulePath).sequence).toBe(1);
    expect(fs.readdirSync(directory)).toEqual(["recovery.json"]);

    failBeforeRename = true;
    expect(() =>
      file.checkpoint({
        state: createBasicLifecycleRecoverySnapshot(state),
        checkpoint: "must-not-replace",
      }),
    ).toThrow(/injected rename failure/);
    expect(fs.readFileSync(capsulePath, "utf8")).toBe(nextBytes);
    expect(fs.readdirSync(directory)).toEqual(["recovery.json"]);

    const resumed = new BasicLifecycleRecoveryCapsuleFile(capsulePath);
    expect(resumed.load().sequence).toBe(1);
    resumed.checkpoint({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "resumed-after-validated-load",
    });
    expect(readBasicLifecycleRecoveryCapsuleFile(capsulePath).sequence).toBe(2);
  });

  it("publishes complete durable artifacts exclusively and cleans pre-publication failures", () => {
    const directory = privateTemporaryDirectory();
    const failedPath = path.join(directory, "failed-report.json");
    expect(() =>
      writeExclusiveDurableArtifact(failedPath, '{"complete":false}\n', {
        beforePublication: () => {
          throw new Error("injected pre-publication failure");
        },
      }),
    ).toThrow(/injected pre-publication failure/);
    expect(fs.existsSync(failedPath)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);

    const reportPath = path.join(directory, "report.json");
    expect(
      writeExclusiveDurableArtifact(reportPath, '{"complete":true}\n'),
    ).toBe(reportPath);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual({
      complete: true,
    });
    expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(["report.json"]);

    expect(() =>
      writeExclusiveDurableArtifact(reportPath, '{"complete":false}\n'),
    ).toThrow(/already exists/);
    expect(fs.readFileSync(reportPath, "utf8")).toBe('{"complete":true}\n');
  });

  it("rejects durable artifact and binding paths that traverse an ancestor symlink", () => {
    const directory = privateTemporaryDirectory();
    const actualDirectory = path.join(directory, "actual");
    const nestedDirectory = path.join(actualDirectory, "nested");
    fs.mkdirSync(nestedDirectory, { recursive: true, mode: 0o700 });
    const linkedDirectory = path.join(directory, "linked");
    fs.symlinkSync(actualDirectory, linkedDirectory);
    const aliasedReportPath = path.join(
      linkedDirectory,
      "nested",
      "report.json",
    );

    expect(() =>
      writeExclusiveDurableArtifact(aliasedReportPath, '{"redacted":true}\n'),
    ).toThrow(/cannot traverse a symlink/);

    const reportPath = path.join(nestedDirectory, "report.json");
    writeExclusiveDurableArtifact(reportPath, '{"redacted":true}\n');
    const capsulePath = path.join(directory, "recovery.json");
    const state = createState(capsulePath);
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath);
    file.create({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "before-report",
    });
    expect(() =>
      file.bindReport({
        state: createBasicLifecycleRecoverySnapshot(state),
        reportPath: aliasedReportPath,
        reportSha256: sha256BasicLifecycleFile(reportPath),
        capsuleSha256BeforeBinding: file.sha256(),
      }),
    ).toThrow(/cannot traverse a symlink/);
    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toBeNull();
  });

  it("refuses to unlink an authenticated capsule before report binding", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const state = createState(capsulePath);
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath);
    file.create({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "before-report",
    });

    expect(() => file.secureUnlink()).toThrow(
      /before a durable report is bound/,
    );
    expect(fs.existsSync(capsulePath)).toBe(true);
  });

  it("restores the authenticated capsule if unlink durability confirmation fails", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const reportPath = path.join(directory, "report.json");
    const state = createState(capsulePath);
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath, {
      beforeSecureUnlinkDirectoryFsync: () => {
        throw new Error("injected unlink fsync failure");
      },
    });
    file.create({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "before-unlink",
    });
    writeExclusiveDurableArtifact(reportPath, '{"redacted":true}\n');
    file.bindReport({
      state: createBasicLifecycleRecoverySnapshot(state),
      reportPath,
      reportSha256: sha256BasicLifecycleFile(reportPath),
      capsuleSha256BeforeBinding: file.sha256(),
    });
    const retainedBytes = fs.readFileSync(capsulePath, "utf8");

    expect(() => file.secureUnlink()).toThrow(/injected unlink fsync failure/);
    expect(fs.readFileSync(capsulePath, "utf8")).toBe(retainedBytes);
    expect(readBasicLifecycleRecoveryCapsuleFile(capsulePath).checkpoint).toBe(
      "report-written-and-bound",
    );
  });

  it("retains a bound capsule if the durable report no longer matches", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const reportPath = path.join(directory, "report.json");
    const state = createState(capsulePath);
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath);
    file.create({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "before-report",
    });
    writeExclusiveDurableArtifact(reportPath, '{"redacted":true}\n');
    file.bindReport({
      state: createBasicLifecycleRecoverySnapshot(state),
      reportPath,
      reportSha256: sha256BasicLifecycleFile(reportPath),
      capsuleSha256BeforeBinding: file.sha256(),
    });
    fs.appendFileSync(reportPath, "tampered\n");

    expect(() => file.secureUnlink()).toThrow(/report SHA-256 does not match/);
    expect(fs.existsSync(capsulePath)).toBe(true);
  });

  it("binds the exact encrypted capsule and redacted report SHA-256 values", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const reportPath = path.join(directory, "report.json");
    const state = createState(capsulePath);
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath);
    file.create({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "before-report",
    });
    writeExclusiveDurableArtifact(reportPath, '{"redacted":true}\n');
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual({
      redacted: true,
    });
    const capsuleSha256BeforeBinding = file.sha256();
    const reportSha256 = sha256BasicLifecycleFile(reportPath);

    expect(() =>
      file.bindReport({
        state: createBasicLifecycleRecoverySnapshot(state),
        reportPath,
        reportSha256,
        capsuleSha256BeforeBinding: "0".repeat(64),
      }),
    ).toThrow(/stale capsule SHA-256/);
    expect(() =>
      file.bindReport({
        state: createBasicLifecycleRecoverySnapshot(state),
        reportPath,
        reportSha256: "0".repeat(64),
        capsuleSha256BeforeBinding,
      }),
    ).toThrow(/stale report SHA-256/);

    file.bindReport({
      state: createBasicLifecycleRecoverySnapshot(state),
      reportPath,
      reportSha256,
      capsuleSha256BeforeBinding,
    });

    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toEqual({
      absolutePath: reportPath,
      reportSha256,
      capsuleSha256BeforeBinding,
    });
    expect(file.sha256()).not.toBe(capsuleSha256BeforeBinding);
    file.checkpoint({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "binding-preserved",
    });
    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toEqual({
      absolutePath: reportPath,
      reportSha256,
      capsuleSha256BeforeBinding,
    });
  });

  it("does not bind a report when its durability fsync fails", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    const reportPath = path.join(directory, "report.json");
    const state = createState(capsulePath);
    const file = new BasicLifecycleRecoveryCapsuleFile(capsulePath, {
      fsyncReport: () => {
        throw new Error("injected report fsync failure");
      },
    });
    file.create({
      state: createBasicLifecycleRecoverySnapshot(state),
      checkpoint: "before-report",
    });
    writeExclusiveDurableArtifact(reportPath, '{"redacted":true}\n');
    const originalCapsuleBytes = fs.readFileSync(capsulePath, "utf8");

    expect(() =>
      file.bindReport({
        state: createBasicLifecycleRecoverySnapshot(state),
        reportPath,
        reportSha256: sha256BasicLifecycleFile(reportPath),
        capsuleSha256BeforeBinding: file.sha256(),
      }),
    ).toThrow(/injected report fsync failure/);
    expect(fs.readFileSync(capsulePath, "utf8")).toBe(originalCapsuleBytes);
    expect(readBasicLifecycleRecoveryCapsuleFile(capsulePath)).toMatchObject({
      sequence: 0,
      reportBinding: null,
    });
  });

  it("rejects unsupported versions, extra fields, wrong keys, and ciphertext tampering", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "recovery.json");
    createState(capsulePath).initializeRecoveryCapsule("baseline:captured");
    const parsed = JSON.parse(fs.readFileSync(capsulePath, "utf8"));

    expect(() =>
      parseBasicLifecycleRecoveryCapsule(
        JSON.stringify({ ...parsed, version: 2 }),
      ),
    ).toThrow(/header/);
    expect(() =>
      parseBasicLifecycleRecoveryCapsule(
        JSON.stringify({ ...parsed, unexpected: true }),
      ),
    ).toThrow(/unsupported or missing field/);
    expect(() =>
      parseBasicLifecycleRecoveryCapsule(
        JSON.stringify({ ...parsed, algorithm: "aes-256-gcm:v0" }),
      ),
    ).toThrow(/header/);
    expect(() =>
      parseBasicLifecycleRecoveryCapsule(
        JSON.stringify({ ...parsed, ciphertext: "not-base64" }),
      ),
    ).toThrow(/header/);
    expect(() =>
      parseBasicLifecycleRecoveryCapsule(
        JSON.stringify({
          ...parsed,
          ciphertext: Buffer.alloc(28).toString("base64"),
        }),
      ),
    ).toThrow(/header/);

    process.env.ENCRYPTION_KEY = WRONG_TEST_ENCRYPTION_KEY;
    expect(() =>
      parseBasicLifecycleRecoveryCapsule(fs.readFileSync(capsulePath, "utf8")),
    ).toThrow(/authentication failed/);

    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const ciphertext = Buffer.from(parsed.ciphertext, "base64");
    ciphertext[ciphertext.length - 1] ^= 1;
    parsed.ciphertext = ciphertext.toString("base64");
    expect(() =>
      parseBasicLifecycleRecoveryCapsule(JSON.stringify(parsed)),
    ).toThrow(/authentication failed/);
  });

  it("writes and binds the redacted report before deleting only a fully cleaned capsule", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "success-recovery.json");
    const reportPath = path.join(directory, "success-report.json");
    const state = createState(capsulePath);
    state.initializeRecoveryCapsule("baseline:captured");
    markFullyCleanedState(state);
    state.checkpointRecoveryState("run:final-state");
    const report = reportFor(state, "PASSED");

    expect(
      finalizeBasicLifecycleRecoveryArtifacts({
        state,
        report,
        reportPath,
      }),
    ).toEqual({
      capsuleDeleted: true,
      absoluteReportPath: reportPath,
    });
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(capsulePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual(
      expect.objectContaining({
        version: 4,
        recoveryCapsule: { sha256: report.recoveryCapsule!.sha256 },
      }),
    );
  });

  it("retains a nominally passed capsule when any persisted cleanup proof is incomplete", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "incomplete-recovery.json");
    const reportPath = path.join(directory, "incomplete-report.json");
    const state = createState(capsulePath);
    state.initializeRecoveryCapsule("baseline:captured");
    markFullyCleanedState(state);
    state.remoteCustomerCleanupComplete = false;
    state.checkpointRecoveryState("run:incomplete-cleanup-proof");
    const report = reportFor(state, "PASSED");

    expect(
      finalizeBasicLifecycleRecoveryArtifacts({ state, report, reportPath }),
    ).toEqual({
      capsuleDeleted: false,
      absoluteReportPath: reportPath,
    });
    expect(fs.existsSync(capsulePath)).toBe(true);
    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toBeNull();
  });

  it("retains the capsule for a failed run even after writing its redacted report", () => {
    const directory = privateTemporaryDirectory();
    const capsulePath = path.join(directory, "failed-recovery.json");
    const reportPath = path.join(directory, "failed-report.json");
    const state = createState(capsulePath);
    state.initializeRecoveryCapsule("baseline:captured");
    state.checkpointRecoveryState("run:failed");
    const report = reportFor(state, "FAILED");

    expect(
      finalizeBasicLifecycleRecoveryArtifacts({
        state,
        report,
        reportPath,
      }),
    ).toEqual({
      capsuleDeleted: false,
      absoluteReportPath: reportPath,
    });
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(capsulePath)).toBe(true);
    expect(
      readBasicLifecycleRecoveryCapsuleFile(capsulePath).reportBinding,
    ).toBeNull();
  });
});
