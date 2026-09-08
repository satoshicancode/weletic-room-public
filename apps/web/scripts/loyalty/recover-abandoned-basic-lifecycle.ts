import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { LoyaltyMaintenanceLease } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { Prisma, PrismaClient } from "@prisma/client";

import {
  BasicLifecycleRecoveryCapsuleFile,
  readBasicLifecycleRecoveryCapsuleFile,
  sha256BasicLifecycleFile,
  writeExclusiveDurableArtifact,
} from "./basic-lifecycle-recovery-capsule";
import {
  assertBasicLifecycleRecoverySnapshot,
  type BasicLifecycleRecoveryHarnessState,
  type BasicLifecycleRecoverySnapshot,
} from "./validate-basic-lifecycle";

const REPORT_VERSION = 2;
const SOURCE_REPORT_VERSIONS = new Set([3, 4]);
const LATEST_SOURCE_REPORT_VERSION = 4;
const STAGING_STORE_ALLOWLIST_ENV = "WELETIC_LOYALTY_STAGING_ALLOWLIST";
const DISPOSABLE_CUSTOMER_TAG = "weletic-a1-disposable";
const FIXTURE_ROLES = ["advocate", "referee", "lifecycle", "privacy"] as const;
const RECOVERY_TAKEOVER_WINDOW_MS = 6 * 60 * 60 * 1_000;
const SHOPIFY_CUSTOMER_CREATE_RETRY_HORIZON_MS = 4 * 60 * 60 * 1_000;
const LATE_INGRESS_SAFETY_MARGIN_MS = 30 * 60 * 1_000;
const RECOVERY_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const ABANDONED_RECOVERY_CHECK_NAMES = [
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

const ABANDONED_RECOVERY_FAMILY_NAMES = [
  "shopifyStores",
  "shopifyAppSessions",
  "shopifyMarkets",
  "shopifyProducts",
  "shopifyVariants",
  "shopifyTranslations",
  "shopifyMarketPrices",
  "shopifySyncRuns",
  "shopifyWebhookEvents",
  "productLinks",
  "commerceOrders",
  "commerceOrderLines",
  "commerceRefunds",
  "commerceRefundLines",
  "commissionRules",
  "commissionCalculations",
  "payoutProfiles",
  "payoutQuotes",
  "payoutStatements",
  "fxRateSnapshots",
  "reconciliationIssues",
  "upstreamCommissions",
  "upstreamPayouts",
  "affiliateCustomers",
  "affiliateCustomerFraudEvents",
  "affiliateCustomerSubmittedLeads",
  "loyaltyBonusCampaigns",
  "loyaltyEarningRules",
  "loyaltyTiers",
  "loyaltyTierHistories",
  "shoppers",
  "loyaltyAccounts",
  "loyaltyEarnGrants",
  "loyaltyOrderLineEarns",
  "pointsLedgerEntries",
  "rewardDefinitions",
  "rewardRedemptions",
  "loyaltyReferralRules",
  "loyaltyReferrals",
  "loyaltyBackfillJobs",
  "loyaltyBackfillPreviewItems",
  "loyaltyOutboxJobs",
  "shopifyInstallIntents",
  "shopifyComplianceRequests",
  "shopifyComplianceArtifacts",
  "shopifyCustomerPrivacyTombstones",
  "shopifyShopPrivacyTombstones",
  "shopifyVoucherCleanups",
  "shopifyVoucherCleanupRequestLinks",
] as const;

const TEMPORARY_PROGRAM_CONFIG = {
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
} as const;

type RecoveryStatus = "PASSED" | "FAILED" | "DEFERRED";

export interface AbandonedBasicLifecycleRecoveryOptions {
  confirmStaging: boolean;
  confirmAbandonedRecovery: boolean;
  storeDomain: string;
  failedReportPath: string;
  baselineDatabaseUrl: string;
  reportPath: string;
  recoveryStatePath: string;
  sourceRecoveryStatePath?: string;
}

interface FailedBasicLifecycleReport {
  version: number;
  startedAt: string;
  completedAt: string;
  overallStatus: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    deferred: number;
  };
  checks: Array<{
    name: string;
    status: string;
    durationMs: number;
    evidence: { kind: string };
  }>;
  cleanup: {
    name: string;
    status: string;
    durationMs: number;
    evidence: { kind: string };
  };
  recoveryCapsule?: { sha256: string } | null;
}

interface RecoveryCheck {
  name: string;
  status: RecoveryStatus;
  durationMs: number;
  reason?: string;
  evidence?: Record<string, number | boolean>;
}

export interface RecoveryReport {
  version: number;
  kind: "abandoned_a1_recovery";
  startedAt: string;
  completedAt: string;
  overallStatus: "PASSED" | "FAILED" | "DEFERRED";
  sourceReport: {
    version: number;
    sha256: string;
    preserved: true;
  };
  checks: RecoveryCheck[];
  mutation: {
    leaseTakenOver: boolean;
    remoteCustomersDeleted: number;
    localRowsDeleted: number;
    temporaryDefinitionsDeleted: number;
    maintenanceLeaseReleased: boolean;
  };
  recoveryCapsule: { sha256: string } | null;
  hardBoundary?: string;
}

type RecoveryMutationSummary = RecoveryReport["mutation"];

class AbandonedBasicLifecycleRecoveryFailure extends Error {
  constructor(
    message: string,
    readonly startedAt: string,
    readonly sourceReportVersion: number,
    readonly sourceReportSha256: string,
    readonly checks: RecoveryCheck[],
    readonly mutation: RecoveryMutationSummary,
  ) {
    super(message);
    this.name = "AbandonedBasicLifecycleRecoveryFailure";
  }
}

type JsonRecord = Record<string, unknown>;

const ABANDONED_RECOVERY_STATE_VERSION = 3 as const;

type AbandonedRecoveryRemoteOutcome =
  | "present"
  | "delete_outcome_unknown"
  | "deleted";

interface AbandonedRecoveryRemoteCustomer {
  id: string;
  numericId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  tags: string[];
  createdAt: string;
  outcome: AbandonedRecoveryRemoteOutcome;
}

type AbandonedRecoveryPhase =
  | "preflight_complete"
  | "lease_taken_over"
  | "remote_cleanup_started"
  | "remote_cleanup_complete"
  | "local_cleanup_complete"
  | "zero_residue_verified"
  | "lease_released";

interface AbandonedBasicLifecycleRecoveryState {
  version: typeof ABANDONED_RECOVERY_STATE_VERSION;
  phase: AbandonedRecoveryPhase;
  sourceReport: {
    version: number;
    sha256: string;
    startedAt: string;
    completedAt: string;
  };
  bindings: {
    failedReportPathSha256: string;
    reportPathSha256: string;
    storeDomainSha256: string;
    tenantTupleSha256: string;
    baselineProgramSha256: string;
    sourceRecoveryCapsuleSha256: string;
    historicalBaselineSnapshotSha256: string;
    operationalBaselineSnapshotSha256: string;
    preflightSnapshotSha256: string;
  };
  originalLease: LoyaltyMaintenanceLease;
  ownerToken: string;
  runMarker: string;
  store: {
    id: string;
    projectId: string;
    programId: string;
    installationGeneration: string | null;
    shopCurrency: string;
  };
  remoteCustomers: AbandonedRecoveryRemoteCustomer[];
  retainedAuditIds: string[];
  fixtureShopperIds: string[];
  fixtureAccountIds: string[];
  fixtureLedgerIds: string[];
  temporaryRuleIds: string[];
  temporaryTierIds: string[];
  temporaryReferralRuleIds: string[];
  temporaryRewardIds: string[];
  signupRuleId: string;
}

function assertCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function canonicalShopDomain(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.replace(/\.myshopify\.com$/, "") + ".myshopify.com";
}

function parseCsv(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => canonicalShopDomain(entry)),
  );
}

function isPlainObject(value: unknown): value is JsonRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    if (
      "toJSON" in value &&
      typeof (value as { toJSON?: unknown }).toJSON === "function"
    ) {
      return canonicalize((value as { toJSON: () => unknown }).toJSON());
    }
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function canonicalDigest(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "undefined")
    .digest("hex");
}

function canonicalEqual(left: unknown, right: unknown) {
  return canonicalDigest(left) === canonicalDigest(right);
}

function jsonContainsExactValue(
  value: unknown,
  exactValues: ReadonlySet<string>,
): boolean {
  if (typeof value === "string") return exactValues.has(value);
  if (Array.isArray(value)) {
    return value.some((entry) => jsonContainsExactValue(entry, exactValues));
  }
  if (value && typeof value === "object") {
    return Object.values(value as JsonRecord).some((entry) =>
      jsonContainsExactValue(entry, exactValues),
    );
  }
  return false;
}

function withoutKeys(value: JsonRecord, keys: readonly string[]) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function assertExactObjectKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
) {
  assertCondition(
    canonicalEqual(Object.keys(value).sort(), [...expected].sort()),
    `${label} has an unsupported or missing field.`,
  );
}

function canonicalPathSha256(value: string) {
  return canonicalDigest(path.normalize(path.resolve(value)));
}

function assertCanonicalRecoveryTimestamp(value: unknown, label: string) {
  assertCondition(typeof value === "string", `${label} is invalid.`);
  const parsed = new Date(value);
  assertCondition(
    Number.isFinite(parsed.getTime()) && parsed.toISOString() === value,
    `${label} is invalid.`,
  );
  return value;
}

function assertUniqueExactStrings(
  value: unknown,
  label: string,
  expectedLength?: number,
): asserts value is string[] {
  assertCondition(
    Array.isArray(value) &&
      value.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length > 0 &&
          entry === entry.trim(),
      ) &&
      new Set(value).size === value.length &&
      (expectedLength === undefined || value.length === expectedLength),
    `${label} is invalid.`,
  );
}

export function assertAbandonedBasicLifecycleRecoveryState(
  value: unknown,
): asserts value is AbandonedBasicLifecycleRecoveryState {
  assertCondition(
    isPlainObject(value),
    "The abandoned recovery state is invalid.",
  );
  assertExactObjectKeys(
    value,
    [
      "bindings",
      "fixtureAccountIds",
      "fixtureLedgerIds",
      "fixtureShopperIds",
      "ownerToken",
      "phase",
      "originalLease",
      "remoteCustomers",
      "retainedAuditIds",
      "runMarker",
      "signupRuleId",
      "sourceReport",
      "store",
      "temporaryReferralRuleIds",
      "temporaryRewardIds",
      "temporaryRuleIds",
      "temporaryTierIds",
      "version",
    ],
    "The abandoned recovery state",
  );
  const phases: AbandonedRecoveryPhase[] = [
    "preflight_complete",
    "lease_taken_over",
    "remote_cleanup_started",
    "remote_cleanup_complete",
    "local_cleanup_complete",
    "zero_residue_verified",
    "lease_released",
  ];
  assertCondition(
    value.version === ABANDONED_RECOVERY_STATE_VERSION &&
      phases.includes(value.phase as AbandonedRecoveryPhase),
    "The abandoned recovery state version or phase is invalid.",
  );

  const source = value.sourceReport;
  assertCondition(
    isPlainObject(source),
    "The recovery source binding is invalid.",
  );
  assertExactObjectKeys(
    source,
    ["completedAt", "sha256", "startedAt", "version"],
    "The recovery source binding",
  );
  const sourceStartedAt = assertCanonicalRecoveryTimestamp(
    source.startedAt,
    "The recovery source startedAt",
  );
  const sourceCompletedAt = assertCanonicalRecoveryTimestamp(
    source.completedAt,
    "The recovery source completedAt",
  );
  assertCondition(
    SOURCE_REPORT_VERSIONS.has(source.version as number) &&
      typeof source.sha256 === "string" &&
      RECOVERY_SHA256_PATTERN.test(source.sha256) &&
      Date.parse(sourceCompletedAt) >= Date.parse(sourceStartedAt),
    "The recovery source binding is invalid.",
  );

  const bindings = value.bindings;
  assertCondition(
    isPlainObject(bindings),
    "The recovery bindings are invalid.",
  );
  const bindingKeys = [
    "baselineProgramSha256",
    "failedReportPathSha256",
    "historicalBaselineSnapshotSha256",
    "operationalBaselineSnapshotSha256",
    "preflightSnapshotSha256",
    "reportPathSha256",
    "sourceRecoveryCapsuleSha256",
    "storeDomainSha256",
    "tenantTupleSha256",
  ];
  assertExactObjectKeys(bindings, bindingKeys, "The recovery bindings");
  assertCondition(
    bindingKeys.every(
      (key) =>
        typeof bindings[key] === "string" &&
        RECOVERY_SHA256_PATTERN.test(bindings[key] as string),
    ),
    "The recovery bindings are invalid.",
  );

  const lease = value.originalLease;
  assertCondition(
    isPlainObject(lease),
    "The original recovery lease is invalid.",
  );
  assertExactObjectKeys(
    lease,
    [
      "acquiredAt",
      "baselineMetadataSha256",
      "fixtureDisposableTagSha256",
      "fixtureEmailSha256",
      "fixtureRunMarkerTagSha256",
      "ownerTokenSha256",
      "recoveryAfter",
    ],
    "The original recovery lease",
  );
  const leaseAcquiredAt = assertCanonicalRecoveryTimestamp(
    lease.acquiredAt,
    "The original lease acquiredAt",
  );
  const originalRecoveryAfter = assertCanonicalRecoveryTimestamp(
    lease.recoveryAfter,
    "The original lease recoveryAfter",
  );
  assertUniqueExactStrings(
    lease.fixtureEmailSha256,
    "The original lease fixture digests",
    FIXTURE_ROLES.length,
  );
  assertCondition(
    [
      lease.baselineMetadataSha256,
      lease.fixtureDisposableTagSha256,
      lease.fixtureRunMarkerTagSha256,
      lease.ownerTokenSha256,
      ...lease.fixtureEmailSha256,
    ].every(
      (digest) =>
        typeof digest === "string" && RECOVERY_SHA256_PATTERN.test(digest),
    ) && Date.parse(originalRecoveryAfter) > Date.parse(leaseAcquiredAt),
    "The original recovery lease is invalid.",
  );
  assertCondition(
    typeof value.ownerToken === "string" &&
      value.ownerToken.length >= 32 &&
      value.ownerToken === value.ownerToken.trim(),
    "The active recovery generation is invalid.",
  );

  const store = value.store;
  assertCondition(
    isPlainObject(store),
    "The recovery tenant binding is invalid.",
  );
  assertExactObjectKeys(
    store,
    ["id", "installationGeneration", "programId", "projectId", "shopCurrency"],
    "The recovery tenant binding",
  );
  assertCondition(
    [store.id, store.projectId, store.programId, store.shopCurrency].every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry === entry.trim(),
    ) &&
      (store.installationGeneration === null ||
        (typeof store.installationGeneration === "string" &&
          store.installationGeneration.length > 0)),
    "The recovery tenant binding is invalid.",
  );
  assertCondition(
    typeof value.runMarker === "string" &&
      /^weletic-a1-[a-f0-9]+$/.test(value.runMarker) &&
      typeof value.signupRuleId === "string" &&
      value.signupRuleId.length > 0,
    "The recovery fixture marker is invalid.",
  );
  assertUniqueExactStrings(value.retainedAuditIds, "The retained audit IDs");
  assertUniqueExactStrings(value.fixtureShopperIds, "The fixture shopper IDs");
  assertUniqueExactStrings(value.fixtureAccountIds, "The fixture account IDs");
  assertUniqueExactStrings(value.fixtureLedgerIds, "The fixture ledger IDs");
  assertUniqueExactStrings(value.temporaryRuleIds, "The temporary rule IDs", 2);
  assertUniqueExactStrings(value.temporaryTierIds, "The temporary tier IDs", 2);
  assertUniqueExactStrings(
    value.temporaryReferralRuleIds,
    "The temporary referral rule IDs",
    1,
  );
  assertUniqueExactStrings(
    value.temporaryRewardIds,
    "The temporary reward IDs",
    1,
  );
  assertCondition(
    value.fixtureShopperIds.length === value.fixtureAccountIds.length &&
      value.fixtureAccountIds.length === value.fixtureLedgerIds.length &&
      value.retainedAuditIds.length === value.fixtureShopperIds.length &&
      value.fixtureShopperIds.length <= FIXTURE_ROLES.length,
    "The recovery fixture graph cardinality is invalid.",
  );

  const remoteCustomers = value.remoteCustomers;
  assertCondition(
    Array.isArray(remoteCustomers) &&
      remoteCustomers.length >= 1 &&
      remoteCustomers.length <= FIXTURE_ROLES.length,
    "The recovery remote fixture set is invalid.",
  );
  const remoteIds = new Set<string>();
  const remoteNumericIds = new Set<string>();
  const remoteEmails = new Set<string>();
  for (const customer of remoteCustomers) {
    assertCondition(
      isPlainObject(customer) &&
        canonicalEqual(Object.keys(customer).sort(), [
          "createdAt",
          "email",
          "firstName",
          "id",
          "lastName",
          "numericId",
          "outcome",
          "tags",
        ]),
      "A recovery remote fixture is invalid.",
    );
    const numericId = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(
      customer.id as string,
    )?.[1];
    assertUniqueExactStrings(
      customer.tags,
      "A recovery remote fixture tag set",
    );
    assertCondition(
      numericId &&
        customer.numericId === numericId &&
        typeof customer.email === "string" &&
        (customer.firstName === null ||
          typeof customer.firstName === "string") &&
        (customer.lastName === null || typeof customer.lastName === "string") &&
        FIXTURE_ROLES.some(
          (role) => customer.email === `${value.runMarker}-${role}@example.com`,
        ) &&
        customer.tags.includes(DISPOSABLE_CUSTOMER_TAG) &&
        customer.tags.includes(value.runMarker) &&
        ["present", "delete_outcome_unknown", "deleted"].includes(
          customer.outcome as string,
        ) &&
        isAbandonedBasicLifecycleFixtureCreatedWithinLease({
          createdAt: customer.createdAt as string,
          acquiredAt: lease.acquiredAt as string,
          recoveryAfter: lease.recoveryAfter as string,
        }),
      "A recovery remote fixture is outside the original ownership proof.",
    );
    remoteIds.add(customer.id as string);
    remoteNumericIds.add(customer.numericId as string);
    remoteEmails.add(customer.email as string);
  }
  assertCondition(
    remoteIds.size === remoteCustomers.length &&
      remoteNumericIds.size === remoteCustomers.length &&
      remoteEmails.size === remoteCustomers.length,
    "The recovery remote fixture set is duplicated.",
  );
  if (
    [
      "remote_cleanup_complete",
      "local_cleanup_complete",
      "zero_residue_verified",
      "lease_released",
    ].includes(value.phase as string)
  ) {
    assertCondition(
      remoteCustomers.every((customer) => customer.outcome === "deleted"),
      "The recovery phase exceeds its remote deletion checkpoint.",
    );
  }
}

const ABANDONED_RECOVERY_PHASE_ORDER: AbandonedRecoveryPhase[] = [
  "preflight_complete",
  "lease_taken_over",
  "remote_cleanup_started",
  "remote_cleanup_complete",
  "local_cleanup_complete",
  "zero_residue_verified",
  "lease_released",
];

function recoveryPhaseAtLeast(
  phase: AbandonedRecoveryPhase,
  expected: AbandonedRecoveryPhase,
) {
  return (
    ABANDONED_RECOVERY_PHASE_ORDER.indexOf(phase) >=
    ABANDONED_RECOVERY_PHASE_ORDER.indexOf(expected)
  );
}

function recoveryLeaseOwnershipProof(lease: LoyaltyMaintenanceLease) {
  return {
    acquiredAt: lease.acquiredAt,
    baselineMetadataSha256: lease.baselineMetadataSha256,
    fixtureDisposableTagSha256: lease.fixtureDisposableTagSha256,
    fixtureEmailSha256: [...lease.fixtureEmailSha256],
    fixtureRunMarkerTagSha256: lease.fixtureRunMarkerTagSha256,
  };
}

export function assertAbandonedRecoveryLeasePreservesOriginalOwnership({
  originalLease,
  currentLease,
}: {
  originalLease: LoyaltyMaintenanceLease;
  currentLease: LoyaltyMaintenanceLease;
}) {
  assertCondition(
    canonicalEqual(
      recoveryLeaseOwnershipProof(currentLease),
      recoveryLeaseOwnershipProof(originalLease),
    ) &&
      Date.parse(currentLease.recoveryAfter) >=
        Date.parse(originalLease.recoveryAfter),
    "The renewed recovery lease changed its original ownership proof.",
  );
}

function recoveryTenantTuple({
  storeDomain,
  store,
}: {
  storeDomain: string;
  store: AbandonedBasicLifecycleRecoveryState["store"];
}) {
  return {
    storeDomain,
    id: store.id,
    projectId: store.projectId,
    programId: store.programId,
    installationGeneration: store.installationGeneration,
    shopCurrency: store.shopCurrency,
  };
}

function checkpointAbandonedRecoveryState({
  capsule,
  state,
  checkpoint,
  forbiddenValues,
}: {
  capsule: BasicLifecycleRecoveryCapsuleFile<AbandonedBasicLifecycleRecoveryState>;
  state: AbandonedBasicLifecycleRecoveryState;
  checkpoint: string;
  forbiddenValues: Iterable<string | null | undefined>;
}) {
  assertAbandonedBasicLifecycleRecoveryState(state);
  capsule.checkpoint({ state, checkpoint, forbiddenValues });
}

function redactRecoveryText(
  value: unknown,
  sensitiveValues: Iterable<string> = [],
) {
  let text = value instanceof Error ? value.message : String(value);
  for (const sensitive of [...sensitiveValues]
    .filter((item) => item.length >= 3)
    .sort((left, right) => right.length - left.length)) {
    text = text.split(sensitive).join("[redacted]");
  }
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/gid:\/\/shopify\/[A-Za-z]+\/\d+/g, "[redacted-shopify-id]")
    .replace(/\b(?:mysql|mysqls):\/\/[^\s]+/gi, "[redacted-database-url]")
    .replace(/\bw[a-z][a-z0-9]*_[A-Za-z0-9_-]+\b/gi, "[redacted-id]")
    .slice(0, 1_000);
}

export function parseAbandonedBasicLifecycleRecoveryArgs(
  args: string[],
): AbandonedBasicLifecycleRecoveryOptions {
  const options: AbandonedBasicLifecycleRecoveryOptions = {
    confirmStaging: false,
    confirmAbandonedRecovery: false,
    storeDomain: "",
    failedReportPath: "",
    baselineDatabaseUrl: "",
    reportPath: "",
    recoveryStatePath: "",
  };
  for (const argument of args) {
    if (argument === "--confirm-staging") {
      options.confirmStaging = true;
    } else if (argument === "--confirm-abandoned-recovery") {
      options.confirmAbandonedRecovery = true;
    } else if (argument.startsWith("--store=")) {
      options.storeDomain = canonicalShopDomain(argument.slice(8));
    } else if (argument.startsWith("--failed-report=")) {
      options.failedReportPath = argument.slice(16).trim();
    } else if (argument.startsWith("--baseline-db-url=")) {
      options.baselineDatabaseUrl = argument.slice(18).trim();
    } else if (argument.startsWith("--report=")) {
      options.reportPath = argument.slice(9).trim();
    } else if (argument.startsWith("--recovery-state=")) {
      options.recoveryStatePath = argument.slice(17).trim();
    } else if (argument.startsWith("--source-recovery-state=")) {
      options.sourceRecoveryStatePath = argument.slice(24).trim();
    } else {
      throw new Error("Unsupported abandoned A1 recovery option.");
    }
  }
  return options;
}

export function assertAbandonedBasicLifecycleRecoverySafety(
  options: AbandonedBasicLifecycleRecoveryOptions,
  env: NodeJS.ProcessEnv = process.env,
) {
  assertCondition(
    options.confirmStaging && options.confirmAbandonedRecovery,
    "Both staging and abandoned-recovery confirmations are required.",
  );
  assertCondition(
    env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production",
    "Abandoned A1 recovery cannot run in production.",
  );
  assertCondition(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(options.storeDomain),
    "An exact canonical staging store is required.",
  );
  assertCondition(
    parseCsv(env[STAGING_STORE_ALLOWLIST_ENV]).has(options.storeDomain),
    "The exact staging store is not allowlisted.",
  );
  assertCondition(
    options.failedReportPath &&
      options.baselineDatabaseUrl &&
      options.reportPath &&
      options.recoveryStatePath,
    "Failed-report, baseline-db-url, recovery-report, and recovery-state inputs are required.",
  );
  const baselineUrl = new URL(options.baselineDatabaseUrl);
  assertCondition(
    baselineUrl.protocol === "mysql:",
    "The baseline database URL must be an explicit MySQL URL.",
  );
  assertCondition(
    ["localhost", "127.0.0.1", "::1"].includes(baselineUrl.hostname),
    "The recovered baseline must use an explicit loopback MySQL endpoint.",
  );
  const baselineDatabaseName = decodeURIComponent(
    baselineUrl.pathname.replace(/^\//, ""),
  );
  assertCondition(
    Boolean(baselineDatabaseName) && !baselineDatabaseName.includes("/"),
    "The recovered baseline must name one exact local database.",
  );
  const liveDatabaseUrl = env.DATABASE_URL;
  assertCondition(
    typeof liveDatabaseUrl === "string" && liveDatabaseUrl.length > 0,
    "The live database URL is required to separate it from the baseline.",
  );
  const liveUrl = new URL(liveDatabaseUrl);
  const liveDatabaseName = decodeURIComponent(
    liveUrl.pathname.replace(/^\//, ""),
  );
  assertCondition(
    baselineDatabaseName !== liveDatabaseName,
    "The recovered baseline database must differ from the live database.",
  );
  const sourcePath = path.resolve(options.failedReportPath);
  const reportPath = path.resolve(options.reportPath);
  assertCondition(
    path.isAbsolute(options.recoveryStatePath),
    "The recovery-state path must be absolute.",
  );
  const recoveryStatePath = path.normalize(options.recoveryStatePath);
  const sourceRecoveryStatePath = options.sourceRecoveryStatePath
    ? path.normalize(options.sourceRecoveryStatePath)
    : null;
  assertCondition(
    new Set(
      [
        sourcePath,
        reportPath,
        recoveryStatePath,
        sourceRecoveryStatePath,
      ].filter((value): value is string => Boolean(value)),
    ).size === (sourceRecoveryStatePath ? 4 : 3),
    "The failed report and every recovery artifact must use separate paths.",
  );
  assertCondition(
    fs.statSync(sourcePath).isFile(),
    "The explicit failed report is unavailable.",
  );
  if (sourceRecoveryStatePath) {
    assertCondition(
      path.isAbsolute(sourceRecoveryStatePath) &&
        fs.statSync(sourceRecoveryStatePath).isFile(),
      "The source recovery capsule must be an explicit existing file.",
    );
  }
  // A PASSED report can exist only in the final report-binding crash window.
  // The strict capsule reader validates that case before any further mutation.
}

export function parseFailedBasicLifecycleReport(
  serialized: string,
): FailedBasicLifecycleReport {
  const parsed: unknown = JSON.parse(serialized);
  assertCondition(isPlainObject(parsed), "The failed report is malformed.");
  const expectedTopLevelKeys = [
    "checks",
    "cleanup",
    "completedAt",
    "evidenceProvenance",
    "intentionallyRetained",
    "intentionallySkipped",
    "overallStatus",
    "startedAt",
    "summary",
    "version",
    ...(parsed.version === 4 ? ["recoveryCapsule"] : []),
  ];
  assertCondition(
    canonicalEqual(Object.keys(parsed).sort(), expectedTopLevelKeys.sort()),
    "The failed report has an unsupported schema.",
  );
  const checks = parsed.checks;
  const cleanup = parsed.cleanup;
  const summary = parsed.summary;
  assertCondition(
    SOURCE_REPORT_VERSIONS.has(parsed.version as number) &&
      parsed.overallStatus === "FAILED" &&
      typeof parsed.startedAt === "string" &&
      Number.isFinite(Date.parse(parsed.startedAt)) &&
      typeof parsed.completedAt === "string" &&
      Number.isFinite(Date.parse(parsed.completedAt)) &&
      Date.parse(parsed.completedAt) >= Date.parse(parsed.startedAt) &&
      Array.isArray(checks) &&
      checks.every(
        (check) =>
          isPlainObject(check) &&
          typeof check.name === "string" &&
          typeof check.status === "string" &&
          typeof check.durationMs === "number" &&
          check.durationMs >= 0 &&
          isPlainObject(check.evidence) &&
          typeof check.evidence.kind === "string",
      ) &&
      isPlainObject(cleanup) &&
      cleanup.name === "Restore configuration and remove disposable fixtures" &&
      cleanup.status === "FAILED" &&
      typeof cleanup.durationMs === "number" &&
      cleanup.durationMs >= 0 &&
      isPlainObject(cleanup.evidence) &&
      cleanup.evidence.kind === "LIVE_SHOPIFY_CLEANUP" &&
      isPlainObject(summary) &&
      typeof summary.total === "number" &&
      typeof summary.passed === "number" &&
      typeof summary.failed === "number" &&
      typeof summary.deferred === "number" &&
      isPlainObject(parsed.evidenceProvenance) &&
      Array.isArray(parsed.intentionallySkipped) &&
      Array.isArray(parsed.intentionallyRetained),
    "The source is not an exact failed A1 lifecycle report.",
  );
  if (parsed.version === 4) {
    assertCondition(
      isPlainObject(parsed.recoveryCapsule) &&
        canonicalEqual(Object.keys(parsed.recoveryCapsule), ["sha256"]) &&
        typeof parsed.recoveryCapsule.sha256 === "string" &&
        RECOVERY_SHA256_PATTERN.test(parsed.recoveryCapsule.sha256),
      "The failed v4 report is missing its exact recovery capsule binding.",
    );
  }
  const expectedChecks = [
    ["A1 harness runtime availability", "PASSED", "LOCAL_SAFETY_GUARD"],
    [
      "Staging tenant, credential, and baseline safety",
      "PASSED",
      "LOCAL_SAFETY_GUARD",
    ],
    [
      "Retained-customer exclusivity and drained outbox quiescence",
      "PASSED",
      "LOCAL_SAFETY_GUARD",
    ],
    [
      "Temporary loyalty configuration installation",
      "PASSED",
      "LOCAL_SAFETY_GUARD",
    ],
    [
      "Real Shopify customer creation and webhook provisioning",
      "FAILED",
      "LIVE_CUSTOMER_PROVISIONING",
    ],
  ] as const;
  assertCondition(
    checks.length === expectedChecks.length &&
      checks.every(
        (check, index) =>
          check.name === expectedChecks[index][0] &&
          check.status === expectedChecks[index][1] &&
          check.evidence.kind === expectedChecks[index][2],
      ),
    "The failed report did not reach the abandoned temporary-configuration state.",
  );
  const allStatuses = [...checks, cleanup].map(({ status }) => status);
  assertCondition(
    summary.total === allStatuses.length &&
      summary.passed ===
        allStatuses.filter((status) => status === "PASSED").length &&
      summary.failed ===
        allStatuses.filter((status) => status === "FAILED").length &&
      summary.deferred ===
        allStatuses.filter((status) => status === "DEFERRED").length,
    "The failed report summary does not recompute exactly.",
  );
  return parsed as unknown as FailedBasicLifecycleReport;
}

export function assertAbandonedBasicLifecycleProgramDiff({
  baseline,
  current,
}: {
  baseline: JsonRecord;
  current: JsonRecord;
}) {
  const ignored = new Set(["metadata", "updatedAt"]);
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const baselineValue = baseline[key];
    const currentValue = current[key];
    if (key in TEMPORARY_PROGRAM_CONFIG) {
      const temporaryValue =
        TEMPORARY_PROGRAM_CONFIG[key as keyof typeof TEMPORARY_PROGRAM_CONFIG];
      assertCondition(
        canonicalEqual(currentValue, baselineValue) ||
          canonicalEqual(currentValue, temporaryValue),
        "The current program has non-harness drift from its recovered baseline.",
      );
      continue;
    }
    assertCondition(
      canonicalEqual(currentValue, baselineValue),
      "The current program has non-harness drift from its recovered baseline.",
    );
  }
}

export function isAbandonedBasicLifecycleFixtureCreatedWithinLease({
  createdAt,
  acquiredAt,
  recoveryAfter,
}: {
  createdAt: string | Date;
  acquiredAt: string | Date;
  recoveryAfter: string | Date;
}) {
  const created = new Date(createdAt).getTime();
  const acquired = new Date(acquiredAt).getTime();
  const recovery = new Date(recoveryAfter).getTime();
  return (
    Number.isFinite(created) &&
    Number.isFinite(acquired) &&
    Number.isFinite(recovery) &&
    created >= acquired &&
    created <= recovery
  );
}

export function assertAbandonedBasicLifecycleIngressOwnership({
  remoteCustomerCount,
  localProjectionCount,
  auditRows,
  installationGeneration,
  leaseAcquiredAt,
  recoveryAfter,
  now,
  undeliveredCustomerCreatedAt = [],
}: {
  remoteCustomerCount: number;
  localProjectionCount: number;
  auditRows: ReadonlyArray<{
    payload: unknown;
    authenticatedBodyDigest: string | null;
    storeInstallationGeneration: string | null;
    status: string;
    processedAt: Date | null;
    error: string | null;
  }>;
  installationGeneration: string | null;
  leaseAcquiredAt: string | Date;
  recoveryAfter: string | Date;
  now: string | Date;
  undeliveredCustomerCreatedAt?: ReadonlyArray<string | Date>;
}) {
  const acquiredAtMs = new Date(leaseAcquiredAt).getTime();
  const recoveryAfterMs = new Date(recoveryAfter).getTime();
  const nowMs = new Date(now).getTime();
  assertCondition(
    remoteCustomerCount > 0 &&
      localProjectionCount >= 0 &&
      localProjectionCount <= remoteCustomerCount &&
      auditRows.length === localProjectionCount &&
      new Set(auditRows.map((row) => row.authenticatedBodyDigest)).size ===
        auditRows.length &&
      auditRows.every(
        (row) =>
          row.payload === null &&
          Boolean(row.authenticatedBodyDigest) &&
          row.storeInstallationGeneration === installationGeneration &&
          row.status === "processed" &&
          row.processedAt !== null &&
          row.error === null,
      ),
    "Every lease-owned remote customer must have one exact terminal payload-free registered audit and local projection before takeover.",
  );
  const expiredUndeliveredCount = remoteCustomerCount - localProjectionCount;
  if (expiredUndeliveredCount > 0) {
    assertCondition(
      undeliveredCustomerCreatedAt.length === expiredUndeliveredCount &&
        Number.isFinite(acquiredAtMs) &&
        Number.isFinite(recoveryAfterMs) &&
        Number.isFinite(nowMs) &&
        recoveryAfterMs - acquiredAtMs >=
          Math.max(
            RECOVERY_TAKEOVER_WINDOW_MS,
            SHOPIFY_CUSTOMER_CREATE_RETRY_HORIZON_MS +
              LATE_INGRESS_SAFETY_MARGIN_MS,
          ) &&
        nowMs >= recoveryAfterMs &&
        undeliveredCustomerCreatedAt.every((createdAt) => {
          const createdAtMs = new Date(createdAt).getTime();
          return (
            Number.isFinite(createdAtMs) &&
            createdAtMs >= acquiredAtMs &&
            createdAtMs <= recoveryAfterMs &&
            nowMs >=
              Math.max(
                recoveryAfterMs,
                createdAtMs +
                  SHOPIFY_CUSTOMER_CREATE_RETRY_HORIZON_MS +
                  LATE_INGRESS_SAFETY_MARGIN_MS,
              )
          );
        }),
      "Unaudited exact fixtures remain inside the Shopify retry horizon plus safety margin.",
    );
  }
  return {
    terminalProjectionCount: localProjectionCount,
    expiredUndeliveredCount,
  };
}

function assertRetainedRowsExact(
  family: string,
  baselineRows: JsonRecord[],
  currentRows: JsonRecord[],
) {
  const currentById = new Map(currentRows.map((row) => [String(row.id), row]));
  for (const baseline of baselineRows) {
    const current = currentById.get(String(baseline.id));
    assertCondition(
      current && canonicalEqual(current, baseline),
      `A retained ${family} row is missing or changed from the recovered baseline.`,
    );
  }
  const baselineIds = new Set(baselineRows.map((row) => String(row.id)));
  return currentRows.filter((row) => !baselineIds.has(String(row.id)));
}

function assertFixtureTimestamp(
  row: JsonRecord,
  acquiredAt: number,
  completedAt: number,
) {
  const createdAt = new Date(row.createdAt as string | Date).getTime();
  const updatedAt = new Date(row.updatedAt as string | Date).getTime();
  assertCondition(
    Number.isFinite(createdAt) &&
      Number.isFinite(updatedAt) &&
      createdAt >= acquiredAt &&
      createdAt <= completedAt &&
      updatedAt >= createdAt &&
      updatedAt <= completedAt,
    "A temporary definition falls outside the exact failed-run time boundary.",
  );
}

export function assertAbandonedBasicLifecycleDefinitionDiff({
  baseline,
  current,
  programId,
  storeId,
  runMarker,
  acquiredAt,
  completedAt,
}: {
  baseline: {
    rules: JsonRecord[];
    tiers: JsonRecord[];
    referralRules: JsonRecord[];
    rewards: JsonRecord[];
  };
  current: {
    rules: JsonRecord[];
    tiers: JsonRecord[];
    referralRules: JsonRecord[];
    rewards: JsonRecord[];
  };
  programId: string;
  storeId: string;
  runMarker: string;
  acquiredAt: number;
  completedAt: number;
}) {
  const rules = assertRetainedRowsExact(
    "earning-rule",
    baseline.rules,
    current.rules,
  );
  const tiers = assertRetainedRowsExact("tier", baseline.tiers, current.tiers);
  const referralRules = assertRetainedRowsExact(
    "referral-rule",
    baseline.referralRules,
    current.referralRules,
  );
  const rewards = assertRetainedRowsExact(
    "reward-definition",
    baseline.rewards,
    current.rewards,
  );
  assertCondition(
    rules.length === 2 &&
      tiers.length === 2 &&
      referralRules.length === 1 &&
      rewards.length === 1,
    "The current definition delta is not the exact A1 temporary cardinality.",
  );
  const ruleSignatures = rules
    .map((row) =>
      canonicalDigest(
        withoutKeys(row, ["id", "programId", "createdAt", "updatedAt"]),
      ),
    )
    .sort();
  const expectedRuleSignatures = [
    {
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
    {
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
  ]
    .map(canonicalDigest)
    .sort();
  assertCondition(
    canonicalEqual(ruleSignatures, expectedRuleSignatures) &&
      rules.every((row) => row.programId === programId),
    "The extra earning rules do not exactly match the A1 fixture signatures.",
  );

  const baselineMaxTier = baseline.tiers.reduce(
    (maximum, row) => Math.max(maximum, Number(row.tierOrder)),
    0,
  );
  const tierSignatures = tiers
    .map((row) =>
      canonicalDigest(
        withoutKeys(row, ["id", "programId", "createdAt", "updatedAt"]),
      ),
    )
    .sort();
  const expectedTierSignatures = [
    {
      name: "A1 Member",
      slug: `${runMarker}-member`,
      tierOrder: baselineMaxTier + 100,
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
    {
      name: "A1 VIP",
      slug: `${runMarker}-vip`,
      tierOrder: baselineMaxTier + 101,
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
  ]
    .map(canonicalDigest)
    .sort();
  assertCondition(
    canonicalEqual(tierSignatures, expectedTierSignatures) &&
      tiers.every((row) => row.programId === programId),
    "The extra tiers do not exactly match the lease-owned A1 fixture signatures.",
  );

  const referral = referralRules[0];
  assertCondition(
    referral.programId === programId &&
      canonicalEqual(
        withoutKeys(referral, ["id", "programId", "createdAt", "updatedAt"]),
        {
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
      ),
    "The extra referral rule does not exactly match the A1 fixture signature.",
  );

  const reward = rewards[0];
  assertCondition(
    reward.storeId === storeId &&
      canonicalEqual(
        withoutKeys(reward, ["id", "storeId", "createdAt", "updatedAt"]),
        {
          name: `A1 amount-off ${runMarker}`,
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
      ),
    "The extra reward does not exactly match the lease-owned A1 fixture signature.",
  );
  [...rules, ...tiers, referral, reward].forEach((row) =>
    assertFixtureTimestamp(row, acquiredAt, completedAt),
  );
  return {
    temporaryDefinitionCount:
      rules.length + tiers.length + referralRules.length + rewards.length,
  };
}

export type AbandonedBasicLifecycleFamilySnapshot = Record<
  string,
  JsonRecord[]
>;

export function assertAbandonedBasicLifecycleFamilyDiff({
  baseline,
  current,
  allowedExtraIds,
}: {
  baseline: AbandonedBasicLifecycleFamilySnapshot;
  current: AbandonedBasicLifecycleFamilySnapshot;
  allowedExtraIds: Record<string, ReadonlySet<string>>;
}) {
  const baselineFamilies = Object.keys(baseline).sort();
  const currentFamilies = Object.keys(current).sort();
  assertCondition(
    canonicalEqual(baselineFamilies, currentFamilies),
    "The recovery family snapshot is incomplete.",
  );
  let retainedRowCount = 0;
  let allowedExtraRowCount = 0;
  for (const family of baselineFamilies) {
    const baselineRows = baseline[family];
    const currentRows = current[family];
    const extras = assertRetainedRowsExact(family, baselineRows, currentRows);
    const allowed = allowedExtraIds[family] ?? new Set<string>();
    assertCondition(
      extras.length === allowed.size &&
        extras.every((row) => allowed.has(String(row.id))),
      `The ${family} delta is not an exact dependency of the abandoned fixture.`,
    );
    retainedRowCount += baselineRows.length;
    allowedExtraRowCount += extras.length;
  }
  assertCondition(
    Object.keys(allowedExtraIds).every((family) =>
      baselineFamilies.includes(family),
    ),
    "An allowed recovery delta names an unscanned family.",
  );
  return { retainedRowCount, allowedExtraRowCount };
}

export function deriveAbandonedOperationalBaselineSnapshot({
  current,
  excludedIds,
}: {
  current: AbandonedBasicLifecycleFamilySnapshot;
  excludedIds: Record<string, ReadonlySet<string>>;
}): AbandonedBasicLifecycleFamilySnapshot {
  const families = Object.keys(current).sort();
  assertCondition(
    Object.keys(excludedIds).every((family) => families.includes(family)),
    "An operational-baseline exclusion names an unscanned family.",
  );
  return Object.fromEntries(
    families.map((family) => {
      const excluded = excludedIds[family] ?? new Set<string>();
      return [
        family,
        current[family].filter(({ id }) => !excluded.has(String(id))),
      ];
    }),
  );
}

function latestRecoveryRowTimestamp(row: JsonRecord) {
  const timestamps = [row.createdAt, row.updatedAt]
    .map((value) => new Date(value as string | Date).getTime())
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function assertAbandonedOperationalBaselineBoundary({
  historical,
  current,
  allowedLeaseOwnedIds,
  leaseAcquiredAt,
}: {
  historical: AbandonedBasicLifecycleFamilySnapshot;
  current: AbandonedBasicLifecycleFamilySnapshot;
  allowedLeaseOwnedIds: Record<string, ReadonlySet<string>>;
  leaseAcquiredAt: string | Date;
}) {
  const historicalFamilies = Object.keys(historical).sort();
  const currentFamilies = Object.keys(current).sort();
  assertCondition(
    canonicalEqual(historicalFamilies, currentFamilies),
    "The historical and operational recovery family scans differ.",
  );
  assertCondition(
    Object.keys(allowedLeaseOwnedIds).every((family) =>
      historicalFamilies.includes(family),
    ),
    "A lease-owned recovery identity names an unscanned family.",
  );
  const leaseAcquiredAtMs = new Date(leaseAcquiredAt).getTime();
  assertCondition(
    Number.isFinite(leaseAcquiredAtMs),
    "The operational-baseline lease boundary is invalid.",
  );

  let stableHistoricalRows = 0;
  let preLeaseRetainedDriftRows = 0;
  let leaseOwnedRows = 0;
  for (const family of historicalFamilies) {
    const historicalRows = historical[family];
    const currentRows = current[family];
    const historicalById = new Map(
      historicalRows.map((row) => [String(row.id), row]),
    );
    const currentById = new Map(
      currentRows.map((row) => [String(row.id), row]),
    );
    for (const row of historicalRows) {
      assertCondition(
        currentById.has(String(row.id)),
        `A historical ${family} row is missing from the operational baseline.`,
      );
    }

    const allowed = allowedLeaseOwnedIds[family] ?? new Set<string>();
    for (const row of currentRows) {
      const id = String(row.id);
      const historicalRow = historicalById.get(id);
      if (allowed.has(id)) {
        assertCondition(
          !historicalRow,
          `A lease-owned ${family} identity overlaps the historical baseline.`,
        );
        leaseOwnedRows += 1;
        continue;
      }
      if (historicalRow && canonicalEqual(historicalRow, row)) {
        stableHistoricalRows += 1;
        continue;
      }
      const latestTimestamp = latestRecoveryRowTimestamp(row);
      assertCondition(
        latestTimestamp !== null && latestTimestamp < leaseAcquiredAtMs,
        `An unowned ${family} row changed at or after the abandoned lease boundary.`,
      );
      preLeaseRetainedDriftRows += 1;
    }
  }
  return {
    stableHistoricalRows,
    preLeaseRetainedDriftRows,
    leaseOwnedRows,
  };
}

function boundedFixtureTimestamp(
  value: unknown,
  acquiredAt: number,
  now: number,
) {
  const timestamp = new Date(value as string | Date).getTime();
  return (
    Number.isFinite(timestamp) && timestamp >= acquiredAt && timestamp <= now
  );
}

export function assertAbandonedBasicLifecycleProjectionGraph({
  remoteCustomers,
  shoppers,
  accounts,
  ledgerEntries,
  storeId,
  programId,
  runMarker,
  signupRuleId,
  acquiredAt,
  now,
}: {
  remoteCustomers: ReadonlyArray<{
    numericId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    tags: string[];
  }>;
  shoppers: JsonRecord[];
  accounts: JsonRecord[];
  ledgerEntries: JsonRecord[];
  storeId: string;
  programId: string;
  runMarker: string;
  signupRuleId: string;
  acquiredAt: number;
  now: number;
}) {
  const remoteById = new Map(
    remoteCustomers.map((customer) => [customer.numericId, customer]),
  );
  const shoppersById = new Map(
    shoppers.map((shopper) => [shopper.id, shopper]),
  );
  const accountsByShopperId = new Map(
    accounts.map((account) => [account.shopperId, account]),
  );
  const ledgersByAccountId = new Map<string, JsonRecord[]>();
  for (const entry of ledgerEntries) {
    const accountId = String(entry.accountId);
    const rows = ledgersByAccountId.get(accountId) ?? [];
    rows.push(entry);
    ledgersByAccountId.set(accountId, rows);
  }
  assertCondition(
    shoppers.length === accounts.length &&
      accounts.length === ledgerEntries.length &&
      new Set(shoppers.map(({ shopifyCustomerId }) => shopifyCustomerId))
        .size === shoppers.length &&
      new Set(accounts.map(({ shopperId }) => shopperId)).size ===
        accounts.length,
    "The abandoned customer projection graph is not one-to-one.",
  );

  for (const shopper of shoppers) {
    const remote = remoteById.get(String(shopper.shopifyCustomerId));
    const account = accountsByShopperId.get(shopper.id);
    const role = remote?.email.match(
      new RegExp(
        `^${runMarker}-(advocate|referee|lifecycle|privacy)@example\\.com$`,
      ),
    )?.[1];
    assertCondition(
      remote &&
        role &&
        shopper.storeId === storeId &&
        shopper.firstName === remote.firstName &&
        shopper.lastName === remote.lastName &&
        shopper.email === remote.email &&
        shopper.phone === null &&
        shopper.locale === "en" &&
        (shopper.tags === null || canonicalEqual(shopper.tags, remote.tags)) &&
        shopper.segmentIds === null &&
        shopper.acceptsMarketing === false &&
        Number(shopper.ordersCount) === 0 &&
        BigInt(shopper.totalSpent as bigint | number | string) === BigInt(0) &&
        boundedFixtureTimestamp(shopper.createdAt, acquiredAt, now) &&
        boundedFixtureTimestamp(shopper.updatedAt, acquiredAt, now),
      "A new shopper is not the exact lease-owned customer projection.",
    );
    assertCondition(
      account &&
        account.storeId === storeId &&
        account.programId === programId &&
        account.status === "active" &&
        Number(account.ledgerVersion) === 1 &&
        BigInt(account.cachedPointsBalance as bigint | number | string) ===
          BigInt(500) &&
        BigInt(account.cachedPendingPoints as bigint | number | string) ===
          BigInt(0) &&
        BigInt(account.lifetimePointsEarned as bigint | number | string) ===
          BigInt(500) &&
        BigInt(account.lifetimePointsRedeemed as bigint | number | string) ===
          BigInt(0) &&
        account.lastQualifyingActivityAt !== null &&
        boundedFixtureTimestamp(
          account.lastQualifyingActivityAt,
          acquiredAt,
          now,
        ) &&
        account.nextExpiryDate === null &&
        account.referralCode === null &&
        account.referredById === null &&
        Number(account.referralCount) === 0 &&
        BigInt(account.referralPointsEarned as bigint | number | string) ===
          BigInt(0) &&
        account.currentTierId === null &&
        account.tierExpiresAt === null &&
        BigInt(account.tierSpendRolling12Months as bigint | number | string) ===
          BigInt(0) &&
        BigInt(
          account.tierPointsRolling12Months as bigint | number | string,
        ) === BigInt(0) &&
        account.metadata === null &&
        boundedFixtureTimestamp(account.enrolledAt, acquiredAt, now) &&
        boundedFixtureTimestamp(account.createdAt, acquiredAt, now) &&
        boundedFixtureTimestamp(account.updatedAt, acquiredAt, now),
      "A new loyalty account is not the exact signup projection.",
    );
    const accountLedgers = ledgersByAccountId.get(String(account.id)) ?? [];
    const entry = accountLedgers[0];
    assertCondition(
      accountLedgers.length === 1 &&
        entry.storeId === storeId &&
        Number(entry.sequenceNumber) === 1 &&
        entry.entryType === "EARN_BONUS" &&
        BigInt(entry.pointsDelta as bigint | number | string) === BigInt(500) &&
        BigInt(entry.pendingDelta as bigint | number | string) === BigInt(0) &&
        BigInt(entry.balanceAfter as bigint | number | string) ===
          BigInt(500) &&
        entry.grantId === null &&
        entry.referenceType === "SIGNUP_BONUS" &&
        entry.referenceId === account.id &&
        entry.idempotencyKey === `signup:${account.id}` &&
        entry.reason === "A1 signup validation" &&
        canonicalEqual(entry.metadata, {
          bonusType: "WELCOME_SIGNUP",
          earningRuleId: signupRuleId,
        }) &&
        boundedFixtureTimestamp(entry.createdAt, acquiredAt, now),
      "A new points row is not the exact signup ledger dependency.",
    );
  }
  assertCondition(
    accounts.every(({ shopperId }) => shoppersById.has(shopperId)) &&
      ledgerEntries.every(({ accountId }) =>
        accounts.some(({ id }) => id === accountId),
      ),
    "A new account or ledger row escapes the exact customer projection graph.",
  );
  return {
    shopperCount: shoppers.length,
    accountCount: accounts.length,
    signupLedgerCount: ledgerEntries.length,
  };
}

function sortedFamilyRows(rows: unknown[]): JsonRecord[] {
  return (rows as JsonRecord[]).sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  );
}

async function loadAbandonedBasicLifecycleFamilySnapshot({
  client,
  storeId,
  workspaceId,
  platformProgramId,
  loyaltyProgramId,
  shopDomain,
  fixtureCustomerNumericIds,
}: {
  client: any;
  storeId: string;
  workspaceId: string;
  platformProgramId: string;
  loyaltyProgramId: string;
  shopDomain: string;
  fixtureCustomerNumericIds: readonly string[];
}): Promise<AbandonedBasicLifecycleFamilySnapshot> {
  const db = client as PrismaClient;
  const ordered = { id: "asc" as const };
  const families = await Promise.all([
    db.weleticShopifyStore.findMany({
      where: { id: storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyAppSession.findMany({
      where: { shop: shopDomain },
      select: {
        id: true,
        shop: true,
        isOnline: true,
        createdAt: true,
      },
      orderBy: ordered,
    }),
    db.weleticShopifyMarket.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticShopifyProduct.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticShopifyVariant.findMany({
      where: { product: { storeId } },
      orderBy: ordered,
    }),
    db.weleticShopifyTranslation.findMany({
      where: { product: { storeId } },
      orderBy: ordered,
    }),
    db.weleticShopifyMarketPrice.findMany({
      where: { market: { storeId } },
      orderBy: ordered,
    }),
    db.weleticShopifySyncRun.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticShopifyWebhookEvent.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticProductLink.findMany({
      where: { programId: platformProgramId },
      orderBy: ordered,
    }),
    db.weleticCommerceOrder.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticCommerceOrderLine.findMany({
      where: { order: { storeId } },
      orderBy: ordered,
    }),
    db.weleticCommerceRefund.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticCommerceRefundLine.findMany({
      where: { refund: { storeId } },
      orderBy: ordered,
    }),
    db.weleticCommissionRule.findMany({
      where: { programId: platformProgramId },
      orderBy: ordered,
    }),
    db.weleticCommissionCalculation.findMany({
      where: {
        OR: [
          { orderLine: { order: { storeId } } },
          { refundLine: { refund: { storeId } } },
          { rule: { programId: platformProgramId } },
          { commission: { programId: platformProgramId } },
        ],
      },
      orderBy: ordered,
    }),
    db.weleticPayoutProfile.findMany({
      where: { programId: platformProgramId },
      orderBy: ordered,
    }),
    db.weleticPayoutQuote.findMany({
      where: { payout: { programId: platformProgramId } },
      orderBy: ordered,
    }),
    db.weleticPayoutStatement.findMany({
      where: { payout: { programId: platformProgramId } },
      orderBy: ordered,
    }),
    db.weleticFxRateSnapshot.findMany({
      where: {
        OR: [
          { orders: { some: { storeId } } },
          { refunds: { some: { storeId } } },
          {
            payoutQuotes: {
              some: { payout: { programId: platformProgramId } },
            },
          },
        ],
      },
      orderBy: ordered,
    }),
    db.weleticReconciliationIssue.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.commission.findMany({
      where: { programId: platformProgramId },
      orderBy: ordered,
    }),
    db.payout.findMany({
      where: { programId: platformProgramId },
      orderBy: ordered,
    }),
    db.customer.findMany({
      where: {
        projectId: workspaceId,
        externalId: { in: [...fixtureCustomerNumericIds] },
      },
      orderBy: ordered,
    }),
    db.fraudEvent.findMany({
      where: {
        customer: {
          projectId: workspaceId,
          externalId: { in: [...fixtureCustomerNumericIds] },
        },
      },
      orderBy: ordered,
    }),
    db.submittedLead.findMany({
      where: {
        customer: {
          projectId: workspaceId,
          externalId: { in: [...fixtureCustomerNumericIds] },
        },
      },
      orderBy: ordered,
    }),
    db.weleticLoyaltyBonusCampaign.findMany({
      where: { programId: loyaltyProgramId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyEarningRule.findMany({
      where: { programId: loyaltyProgramId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyTier.findMany({
      where: { programId: loyaltyProgramId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyTierHistory.findMany({
      where: { account: { storeId } },
      orderBy: ordered,
    }),
    db.weleticShopper.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticLoyaltyAccount.findMany({ where: { storeId }, orderBy: ordered }),
    db.weleticLoyaltyEarnGrant.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyOrderLineEarn.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticPointsLedgerEntry.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticRewardDefinition.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticRewardRedemption.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyReferralRule.findMany({
      where: { programId: loyaltyProgramId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyReferral.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyBackfillJob.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticLoyaltyBackfillPreviewItem.findMany({
      where: { job: { storeId } },
      orderBy: ordered,
    }),
    db.weleticLoyaltyOutboxJob.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyInstallIntent.findMany({
      where: { workspaceId, shopDomain },
      orderBy: ordered,
    }),
    db.weleticShopifyComplianceRequest.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyComplianceArtifact.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyCustomerPrivacyTombstone.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyShopPrivacyTombstone.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyVoucherCleanup.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
    db.weleticShopifyVoucherCleanupRequestLink.findMany({
      where: { storeId },
      orderBy: ordered,
    }),
  ]);
  const names = ABANDONED_RECOVERY_FAMILY_NAMES;
  assertCondition(
    names.length === families.length,
    "The recovery family loader is internally inconsistent.",
  );
  return Object.fromEntries(
    names.map((name, index) => [name, sortedFamilyRows(families[index])]),
  );
}

function jsonWriteValue(value: unknown) {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

function baselineProgramUpdateData(
  baseline: JsonRecord,
  metadata: Prisma.InputJsonValue | Prisma.NullTypes.DbNull,
  updatedAt?: Date,
) {
  return {
    name: baseline.name as string,
    status: baseline.status as any,
    pointNameSingular: baseline.pointNameSingular as string,
    pointNamePlural: baseline.pointNamePlural as string,
    pointsPerCurrencyUnit: baseline.pointsPerCurrencyUnit as any,
    holdingPeriodDays: baseline.holdingPeriodDays as number,
    pointsExpiryMonths: baseline.pointsExpiryMonths as number,
    killSwitchActive: baseline.killSwitchActive as boolean,
    activatedAt: baseline.activatedAt as Date | null,
    disabledAt: baseline.disabledAt as Date | null,
    enableOnlineStoreLauncher: baseline.enableOnlineStoreLauncher as boolean,
    enableCustomerAccountHub: baseline.enableCustomerAccountHub as boolean,
    enableCheckoutExtension: baseline.enableCheckoutExtension as boolean,
    enableProductPointsWidget: baseline.enableProductPointsWidget as boolean,
    enableMetafieldsSync: baseline.enableMetafieldsSync as boolean,
    surfaceFlags: jsonWriteValue(baseline.surfaceFlags),
    vipMilestoneMode: baseline.vipMilestoneMode as any,
    vipTimeframe: baseline.vipTimeframe as any,
    vipDowngradeGraceDays: baseline.vipDowngradeGraceDays as number,
    vipAutoDowngradeEnabled: baseline.vipAutoDowngradeEnabled as boolean,
    branding: jsonWriteValue(baseline.branding),
    metadata,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function assertProgramBusinessEqualsBaseline(
  baseline: JsonRecord,
  current: JsonRecord,
) {
  assertCondition(
    canonicalEqual(
      withoutKeys(baseline, ["metadata", "updatedAt", "earnPolicyVersion"]),
      withoutKeys(current, ["metadata", "updatedAt", "earnPolicyVersion"]),
    ),
    "The loyalty program is not restored to the exact baseline business state.",
  );
}

function programEqualsBaselineExceptRevisionAudit(
  baseline: JsonRecord,
  current: JsonRecord,
) {
  return canonicalEqual(
    withoutKeys(baseline, ["earnPolicyVersion"]),
    withoutKeys(current, ["earnPolicyVersion"]),
  );
}

export function writeAbandonedBasicLifecycleRecoveryReport(
  reportPath: string,
  report: RecoveryReport,
) {
  const absolute = path.resolve(reportPath);
  writeExclusiveDurableArtifact(
    absolute,
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

export function readExistingPassedRecoveryReport({
  reportPath,
  sourceSha256,
  capsuleSha256,
  recoveryState,
}: {
  reportPath: string;
  sourceSha256: string;
  capsuleSha256: string;
  recoveryState: AbandonedBasicLifecycleRecoveryState;
}) {
  const value: unknown = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assertCondition(
    isPlainObject(value),
    "The existing recovery report is invalid.",
  );
  assertExactObjectKeys(
    value,
    [
      "checks",
      "completedAt",
      "kind",
      "mutation",
      "overallStatus",
      "recoveryCapsule",
      "sourceReport",
      "startedAt",
      "version",
    ],
    "The existing recovery report",
  );
  assertCondition(
    value.version === REPORT_VERSION &&
      value.kind === "abandoned_a1_recovery" &&
      value.overallStatus === "PASSED" &&
      typeof value.startedAt === "string" &&
      new Date(value.startedAt).toISOString() === value.startedAt &&
      typeof value.completedAt === "string" &&
      new Date(value.completedAt).toISOString() === value.completedAt &&
      Date.parse(value.completedAt) >= Date.parse(value.startedAt) &&
      Array.isArray(value.checks) &&
      canonicalEqual(
        value.checks.map((check) => (isPlainObject(check) ? check.name : null)),
        ABANDONED_RECOVERY_CHECK_NAMES,
      ) &&
      value.checks.every(
        (check) =>
          isPlainObject(check) &&
          canonicalEqual(Object.keys(check).sort(), [
            "durationMs",
            "evidence",
            "name",
            "status",
          ]) &&
          check.status === "PASSED" &&
          typeof check.name === "string" &&
          typeof check.durationMs === "number" &&
          Number.isFinite(check.durationMs) &&
          check.durationMs >= 0 &&
          isPlainObject(check.evidence) &&
          Object.values(check.evidence).every(
            (entry) =>
              typeof entry === "boolean" ||
              (typeof entry === "number" && Number.isFinite(entry)),
          ),
      ) &&
      isPlainObject(value.sourceReport) &&
      canonicalEqual(Object.keys(value.sourceReport).sort(), [
        "preserved",
        "sha256",
        "version",
      ]) &&
      value.sourceReport.version === recoveryState.sourceReport.version &&
      value.sourceReport.sha256 === sourceSha256 &&
      value.sourceReport.preserved === true &&
      isPlainObject(value.mutation) &&
      canonicalEqual(Object.keys(value.mutation).sort(), [
        "leaseTakenOver",
        "localRowsDeleted",
        "maintenanceLeaseReleased",
        "remoteCustomersDeleted",
        "temporaryDefinitionsDeleted",
      ]) &&
      value.mutation.leaseTakenOver === true &&
      value.mutation.remoteCustomersDeleted ===
        recoveryState.remoteCustomers.length &&
      value.mutation.localRowsDeleted ===
        recoveryState.fixtureShopperIds.length +
          recoveryState.fixtureAccountIds.length +
          recoveryState.fixtureLedgerIds.length &&
      value.mutation.temporaryDefinitionsDeleted === 6 &&
      value.mutation.maintenanceLeaseReleased === true &&
      isPlainObject(value.recoveryCapsule) &&
      canonicalEqual(Object.keys(value.recoveryCapsule), ["sha256"]) &&
      value.recoveryCapsule.sha256 === capsuleSha256,
    "The existing recovery report is not the exact PASSED journal result.",
  );
  return value as unknown as RecoveryReport;
}

async function runRecoveryPreflight(
  options: AbandonedBasicLifecycleRecoveryOptions,
) {
  const startedAt = new Date();
  const sourceBytes = fs.readFileSync(options.failedReportPath);
  const sourceReport = parseFailedBasicLifecycleReport(
    sourceBytes.toString("utf8"),
  );
  const sourceSha256 = crypto
    .createHash("sha256")
    .update(sourceBytes)
    .digest("hex");
  let sourceRecoveryHarnessState: BasicLifecycleRecoveryHarnessState | null =
    null;
  let sourceRecoveryCapsuleSha256 = canonicalDigest(null);
  if (sourceReport.version === 4) {
    assertCondition(
      options.sourceRecoveryStatePath,
      "A failed v4 lifecycle report requires its explicit private source recovery capsule.",
    );
    sourceRecoveryCapsuleSha256 = sha256BasicLifecycleFile(
      options.sourceRecoveryStatePath,
    );
    assertCondition(
      sourceReport.recoveryCapsule?.sha256 === sourceRecoveryCapsuleSha256,
      "The failed v4 report does not bind the supplied source recovery capsule.",
    );
    const sourceCapsule =
      readBasicLifecycleRecoveryCapsuleFile<BasicLifecycleRecoverySnapshot>(
        options.sourceRecoveryStatePath,
        assertBasicLifecycleRecoverySnapshot,
      );
    sourceRecoveryHarnessState = sourceCapsule.state.harnessState;
    assertCondition(
      sourceRecoveryHarnessState.startedAt.toISOString() ===
        sourceReport.startedAt &&
        sourceRecoveryHarnessState.maintenanceLeaseAcquired &&
        !sourceRecoveryHarnessState.maintenanceLeaseReleased &&
        sourceRecoveryHarnessState.remoteDiscountGids.size === 0,
      "The source recovery capsule is not the exact abandoned early customer-provisioning state.",
    );
  } else {
    assertCondition(
      !options.sourceRecoveryStatePath,
      "A v3 lifecycle report cannot adopt an unrelated source recovery capsule.",
    );
  }
  const sensitive = new Set([
    options.storeDomain,
    options.failedReportPath,
    options.baselineDatabaseUrl,
    options.reportPath,
    options.recoveryStatePath,
  ]);
  if (options.sourceRecoveryStatePath) {
    sensitive.add(options.sourceRecoveryStatePath);
  }
  if (sourceRecoveryHarnessState) {
    sensitive.add(sourceRecoveryHarnessState.maintenanceOwnerToken);
    sensitive.add(sourceRecoveryHarnessState.runMarker);
    for (const value of [
      ...sourceRecoveryHarnessState.remoteCustomerGids,
      ...sourceRecoveryHarnessState.fixtureCustomerNumericIds,
      ...sourceRecoveryHarnessState.fixtureCustomerEmails,
      ...sourceRecoveryHarnessState.fixtureRuleIds,
      ...sourceRecoveryHarnessState.fixtureTierIds,
      ...sourceRecoveryHarnessState.fixtureReferralRuleIds,
      ...sourceRecoveryHarnessState.fixtureRewardIds,
    ]) {
      sensitive.add(value);
    }
  }
  const recoveryCapsule =
    new BasicLifecycleRecoveryCapsuleFile<AbandonedBasicLifecycleRecoveryState>(
      options.recoveryStatePath,
    );
  // The null sentinel exists only until the first exact preflight creates the
  // journal. Every destructive path below is reached after that assignment.
  let recoveryState = (
    fs.existsSync(options.recoveryStatePath)
      ? recoveryCapsule.load(assertAbandonedBasicLifecycleRecoveryState).state
      : null
  ) as AbandonedBasicLifecycleRecoveryState;
  if (recoveryState) {
    assertCondition(
      recoveryState.sourceReport.version === sourceReport.version &&
        recoveryState.sourceReport.sha256 === sourceSha256 &&
        recoveryState.sourceReport.startedAt === sourceReport.startedAt &&
        recoveryState.sourceReport.completedAt === sourceReport.completedAt &&
        recoveryState.bindings.failedReportPathSha256 ===
          canonicalPathSha256(options.failedReportPath) &&
        recoveryState.bindings.reportPathSha256 ===
          canonicalPathSha256(options.reportPath) &&
        recoveryState.bindings.storeDomainSha256 ===
          canonicalDigest(options.storeDomain) &&
        recoveryState.bindings.sourceRecoveryCapsuleSha256 ===
          sourceRecoveryCapsuleSha256,
      "The private recovery journal does not bind this source, report, or store.",
    );
    sensitive.add(recoveryState.ownerToken);
    sensitive.add(recoveryState.runMarker);
    for (const customer of recoveryState.remoteCustomers) {
      sensitive.add(customer.id);
      sensitive.add(customer.numericId);
      sensitive.add(customer.email);
    }
  } else {
    assertCondition(
      !fs.existsSync(options.reportPath),
      "The recovery report already exists without its private recovery journal.",
    );
  }
  const checks: RecoveryCheck[] = [];
  let remoteFixtureCustomerCount = 0;
  let temporaryDefinitionCount = 0;
  let newLocalProjectionCount = 0;
  let newRegisteredAuditRowCount = 0;
  const mutation: RecoveryMutationSummary = {
    leaseTakenOver: false,
    remoteCustomersDeleted: 0,
    localRowsDeleted: 0,
    temporaryDefinitionsDeleted: 0,
    maintenanceLeaseReleased: false,
  };
  const check = async (
    name: string,
    task: () => Promise<Record<string, number | boolean> | void>,
  ) => {
    const started = Date.now();
    try {
      const evidence = await task();
      checks.push({
        name,
        status: "PASSED",
        durationMs: Date.now() - started,
        ...(evidence ? { evidence } : {}),
      });
    } catch (error) {
      checks.push({
        name,
        status: "FAILED",
        durationMs: Date.now() - started,
        reason: redactRecoveryText(error, sensitive),
      });
      throw error;
    }
  };

  const baseline = new PrismaClient({
    datasources: { db: { url: options.baselineDatabaseUrl } },
  });
  const { prisma } = await import("@/lib/prisma");
  const maintenance = await import(
    "@/lib/weletic/loyalty/maintenance-write-fence"
  );
  const shopify = await import("@/lib/weletic/loyalty/shopify-discounts");
  const settlementLocks = await import(
    "@/lib/weletic/shopify/customer-settlement-lock"
  );
  const merchantFence = await import(
    "@/lib/weletic/loyalty/merchant-write-fence"
  );
  const policyRevision = await import(
    "@/lib/weletic/loyalty/earn-policy-revision"
  );
  try {
    let currentStore: any;
    let baselineStore: any;
    let lease!: import("@/lib/weletic/loyalty/maintenance-write-fence").LoyaltyMaintenanceLease;
    let activeLease:
      | import("@/lib/weletic/loyalty/maintenance-write-fence").LoyaltyMaintenanceLease
      | null = null;
    let accessToken = "";
    let historicalBaselineSnapshot!: AbandonedBasicLifecycleFamilySnapshot;
    let operationalBaselineSnapshot!: AbandonedBasicLifecycleFamilySnapshot;
    let currentSnapshot!: AbandonedBasicLifecycleFamilySnapshot;
    let retainedAuditIds = new Set<string>();
    let fixtureShopperIds = new Set<string>();
    let fixtureAccountIds = new Set<string>();
    let fixtureLedgerIds = new Set<string>();
    let temporaryRuleIds = new Set<string>();
    let temporaryTierIds = new Set<string>();
    let temporaryReferralRuleIds = new Set<string>();
    let temporaryRewardIds = new Set<string>();
    let signupRuleId = "";
    await check("Exact current and recovered baseline tenant", async () => {
      [currentStore, baselineStore] = await Promise.all([
        prisma.weleticShopifyStore.findUnique({
          where: { shopDomain: options.storeDomain },
          include: { loyaltyProgram: true },
        }),
        baseline.weleticShopifyStore.findUnique({
          where: { shopDomain: options.storeDomain },
          include: { loyaltyProgram: true },
        }),
      ]);
      assertCondition(
        currentStore?.loyaltyProgram && baselineStore?.loyaltyProgram,
        "The exact current or recovered baseline loyalty tenant is missing.",
      );
      sensitive.add(currentStore.id);
      sensitive.add(currentStore.projectId);
      sensitive.add(currentStore.programId);
      sensitive.add(currentStore.loyaltyProgram.id);
      assertCondition(
        currentStore.id === baselineStore.id &&
          currentStore.projectId === baselineStore.projectId &&
          currentStore.programId === baselineStore.programId &&
          currentStore.loyaltyProgram.id === baselineStore.loyaltyProgram.id &&
          currentStore.installationGeneration ===
            baselineStore.installationGeneration &&
          currentStore.shopCurrency === baselineStore.shopCurrency &&
          currentStore.complianceState === "active" &&
          baselineStore.complianceState === "active",
        "The current and recovered baseline tenant tuples do not match exactly.",
      );
      if (sourceRecoveryHarnessState) {
        const sourceTuple = sourceRecoveryHarnessState.storeTuple;
        assertCondition(
          sourceTuple &&
            sourceTuple.storeId === currentStore.id &&
            sourceTuple.shopDomain === options.storeDomain &&
            sourceTuple.workspaceId === currentStore.projectId &&
            sourceTuple.platformProgramId === currentStore.programId &&
            sourceTuple.loyaltyProgramId === currentStore.loyaltyProgram.id &&
            sourceTuple.installationGeneration ===
              currentStore.installationGeneration &&
            sourceTuple.currency === currentStore.shopCurrency.toUpperCase() &&
            sourceRecoveryHarnessState.storeId === currentStore.id &&
            sourceRecoveryHarnessState.workspaceId === currentStore.projectId &&
            sourceRecoveryHarnessState.programId ===
              currentStore.loyaltyProgram.id &&
            sourceRecoveryHarnessState.installationGeneration ===
              currentStore.installationGeneration &&
            canonicalEqual(
              sourceRecoveryHarnessState.maintenanceLeaseMetadata,
              currentStore.loyaltyProgram.metadata,
            ),
          "The source recovery capsule tenant or maintenance generation differs from live state.",
        );
      }
      if (recoveryState) {
        const currentStateStore = {
          id: currentStore.id,
          projectId: currentStore.projectId,
          programId: currentStore.programId,
          installationGeneration: currentStore.installationGeneration,
          shopCurrency: currentStore.shopCurrency,
        } satisfies AbandonedBasicLifecycleRecoveryState["store"];
        assertCondition(
          canonicalEqual(currentStateStore, recoveryState.store) &&
            canonicalDigest(
              recoveryTenantTuple({
                storeDomain: options.storeDomain,
                store: currentStateStore,
              }),
            ) === recoveryState.bindings.tenantTupleSha256 &&
            canonicalDigest(baselineStore.loyaltyProgram) ===
              recoveryState.bindings.baselineProgramSha256,
          "The live or recovered tenant no longer matches the private recovery journal.",
        );
      }
      return { exactTenantTuple: true };
    });

    await check("Expired abandoned maintenance generation", async () => {
      activeLease = maintenance.readLoyaltyMaintenanceLease(
        currentStore.loyaltyProgram.metadata,
      );
      if (
        recoveryState &&
        recoveryPhaseAtLeast(recoveryState.phase, "zero_residue_verified") &&
        !activeLease
      ) {
        lease = recoveryState.originalLease;
        assertCondition(
          programEqualsBaselineExceptRevisionAudit(
            baselineStore.loyaltyProgram as unknown as JsonRecord,
            currentStore.loyaltyProgram as unknown as JsonRecord,
          ),
          "The maintenance lease disappeared before an exact baseline release.",
        );
        recoveryState.phase = "lease_released";
        mutation.maintenanceLeaseReleased = true;
        checkpointAbandonedRecoveryState({
          capsule: recoveryCapsule,
          state: recoveryState,
          checkpoint: "lease-release-reconciled",
          forbiddenValues: [
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
        return {
          recoveryBoundaryReached: true,
          authenticatedSourceOwnerContinuation: Boolean(
            sourceRecoveryHarnessState,
          ),
        };
      }
      assertCondition(
        activeLease,
        "The exact abandoned maintenance lease is missing.",
      );
      lease = recoveryState?.originalLease ?? activeLease;
      if (recoveryState) {
        assertAbandonedRecoveryLeasePreservesOriginalOwnership({
          originalLease: recoveryState.originalLease,
          currentLease: activeLease,
        });
      }
      assertCondition(
        Date.parse(lease.acquiredAt) >= Date.parse(sourceReport.startedAt) &&
          Date.parse(lease.acquiredAt) <= Date.parse(sourceReport.completedAt),
        "The active lease was not acquired by the explicit failed report.",
      );
      if (!recoveryState && sourceRecoveryHarnessState) {
        maintenance.createLoyaltyMaintenanceOwnerPermit({
          storeId: currentStore.id,
          metadata: currentStore.loyaltyProgram.metadata,
          ownerToken: sourceRecoveryHarnessState.maintenanceOwnerToken,
        });
      } else if (!recoveryState) {
        assertCondition(
          Date.now() >= Date.parse(activeLease.recoveryAfter),
          "The abandoned lease has not reached its recovery boundary.",
        );
      }
      return {
        recoveryBoundaryReached:
          Date.now() >= Date.parse(activeLease.recoveryAfter),
        authenticatedSourceOwnerContinuation: Boolean(
          sourceRecoveryHarnessState,
        ),
      };
    });

    await check("Exact baseline metadata and program diff", async () => {
      if (
        recoveryState &&
        recoveryPhaseAtLeast(recoveryState.phase, "lease_released")
      ) {
        assertCondition(
          programEqualsBaselineExceptRevisionAudit(
            baselineStore.loyaltyProgram as unknown as JsonRecord,
            currentStore.loyaltyProgram as unknown as JsonRecord,
          ),
          "The released loyalty program differs from its recovered baseline.",
        );
        return { baselineMetadataHashMatched: true, exactProgramDiff: true };
      }
      maintenance.assertLoyaltyMaintenanceBaselineMetadata({
        baselineMetadata: baselineStore.loyaltyProgram.metadata,
        leaseMetadata: currentStore.loyaltyProgram.metadata,
      });
      if (
        recoveryState &&
        recoveryPhaseAtLeast(recoveryState.phase, "local_cleanup_complete")
      ) {
        assertProgramBusinessEqualsBaseline(
          baselineStore.loyaltyProgram as unknown as JsonRecord,
          currentStore.loyaltyProgram as unknown as JsonRecord,
        );
      } else {
        assertAbandonedBasicLifecycleProgramDiff({
          baseline: baselineStore.loyaltyProgram as unknown as JsonRecord,
          current: currentStore.loyaltyProgram as unknown as JsonRecord,
        });
      }
      return { baselineMetadataHashMatched: true, exactProgramDiff: true };
    });

    let exactRemoteCustomers: AbandonedRecoveryRemoteCustomer[] = [];
    let runMarker = "";
    await check("Exact lease-owned Shopify fixture discovery", async () => {
      const credentials = await shopify.resolveShopifyOfflineCredentials({
        storeId: currentStore.id,
      });
      accessToken = credentials.accessToken;
      sensitive.add(credentials.accessToken);
      if (recoveryState) {
        exactRemoteCustomers = recoveryState.remoteCustomers.map(
          (customer) => ({
            ...customer,
            tags: [...customer.tags],
          }),
        );
        runMarker = recoveryState.runMarker;
        let outcomeChanged = false;
        for (const customer of exactRemoteCustomers) {
          const lookup = await shopify.shopifyAdminGraphqlRequest<{
            customer: {
              id: string;
              email: string | null;
              firstName: string | null;
              lastName: string | null;
              tags: string[];
              createdAt: string;
            } | null;
          }>({
            shopDomain: options.storeDomain,
            accessToken,
            query: `query WeleticAbandonedA1StoredCustomerProof($id: ID!) {
              customer(id: $id) { id email firstName lastName tags createdAt }
            }`,
            variables: { id: customer.id },
          });
          if (!lookup.customer) {
            if (customer.outcome !== "deleted") {
              customer.outcome = "deleted";
              outcomeChanged = true;
            }
            continue;
          }
          assertCondition(
            customer.outcome !== "deleted" &&
              canonicalEqual(
                lookup.customer,
                withoutKeys(customer as unknown as JsonRecord, [
                  "numericId",
                  "outcome",
                ]),
              ),
            "A journaled remote fixture changed or reappeared during recovery.",
          );
          const ownership =
            maintenance.readLoyaltyMaintenanceFixtureCustomerOwnership({
              metadata: currentStore.loyaltyProgram.metadata,
              email: lookup.customer.email ?? "",
              tags: lookup.customer.tags,
            });
          assertCondition(
            ownership.owned &&
              ownership.runMarkerTag === runMarker &&
              isAbandonedBasicLifecycleFixtureCreatedWithinLease({
                createdAt: lookup.customer.createdAt,
                acquiredAt: recoveryState.originalLease.acquiredAt,
                recoveryAfter: recoveryState.originalLease.recoveryAfter,
              }),
            "A journaled remote fixture no longer has its original ownership proof.",
          );
          if (customer.outcome === "delete_outcome_unknown") {
            customer.outcome = "present";
            outcomeChanged = true;
          }
        }
        if (activeLease) {
          const storedIds = new Set(
            exactRemoteCustomers.map((customer) => customer.id),
          );
          const ownershipQueries = [
            `tag:${runMarker}`,
            ...FIXTURE_ROLES.map(
              (role) => `email:${runMarker}-${role}@example.com`,
            ),
          ];
          for (const queryValue of ownershipQueries) {
            const ownershipSearch = await shopify.shopifyAdminGraphqlRequest<{
              customers: {
                nodes: Array<{
                  id: string;
                  email: string | null;
                  firstName: string | null;
                  lastName: string | null;
                  tags: string[];
                  createdAt: string;
                }>;
                pageInfo: { hasNextPage: boolean };
              };
            }>({
              shopDomain: options.storeDomain,
              accessToken,
              query: `query WeleticA1JournalOwnershipCollisions($query: String!) {
                  customers(first: 50, query: $query) {
                    nodes { id email firstName lastName tags createdAt }
                    pageInfo { hasNextPage }
                  }
                }`,
              variables: { query: queryValue },
            });
            assertCondition(
              !ownershipSearch.customers.pageInfo.hasNextPage,
              "Journal ownership collision discovery exceeded its bounded scan.",
            );
            for (const candidate of ownershipSearch.customers.nodes) {
              const ownership =
                maintenance.readLoyaltyMaintenanceFixtureCustomerOwnership({
                  metadata: currentStore.loyaltyProgram.metadata,
                  email: candidate.email ?? "",
                  tags: candidate.tags,
                });
              assertCondition(
                !ownership.partialMatch &&
                  (!ownership.owned || storedIds.has(candidate.id)),
                "A non-journaled customer collides with the original recovery ownership proof.",
              );
            }
          }
        }
        if (outcomeChanged) {
          recoveryState.remoteCustomers = exactRemoteCustomers.map(
            (customer) => ({ ...customer, tags: [...customer.tags] }),
          );
          checkpointAbandonedRecoveryState({
            capsule: recoveryCapsule,
            state: recoveryState,
            checkpoint: "remote-outcomes-reconciled",
            forbiddenValues: [
              accessToken,
              options.baselineDatabaseUrl,
              process.env.DATABASE_URL,
            ],
          });
        }
        remoteFixtureCustomerCount = exactRemoteCustomers.length;
        return { remoteFixtureCustomerCount };
      }
      const response = await shopify.shopifyAdminGraphqlRequest<{
        customers: {
          nodes: Array<{
            id: string;
            email: string | null;
            firstName: string | null;
            lastName: string | null;
            tags: string[];
            createdAt: string;
          }>;
          pageInfo: { hasNextPage: boolean };
        };
      }>({
        shopDomain: options.storeDomain,
        accessToken: credentials.accessToken,
        query: `query WeleticA1AbandonedRecoveryCustomers($query: String!) {
          customers(first: 50, query: $query) {
            nodes { id email firstName lastName tags createdAt }
            pageInfo { hasNextPage }
          }
        }`,
        variables: { query: `tag:${DISPOSABLE_CUSTOMER_TAG}` },
      });
      assertCondition(
        !response.customers.pageInfo.hasNextPage,
        "Disposable-customer discovery exceeded its exact bounded scan.",
      );
      for (const customer of response.customers.nodes) {
        const ownership =
          maintenance.readLoyaltyMaintenanceFixtureCustomerOwnership({
            metadata: currentStore.loyaltyProgram.metadata,
            email: customer.email ?? "",
            tags: customer.tags,
          });
        if (ownership.partialMatch) {
          throw new Error(
            "A Shopify customer partially matches the lease and cannot be adopted safely.",
          );
        }
        if (!ownership.owned) continue;
        assertCondition(
          customer.email && ownership.runMarkerTag,
          "An exact fixture customer has redacted ownership fields.",
        );
        sensitive.add(customer.id);
        sensitive.add(customer.email);
        sensitive.add(ownership.runMarkerTag);
        exactRemoteCustomers.push({
          id: customer.id,
          numericId:
            /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(customer.id)?.[1] ?? "",
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          tags: customer.tags,
          createdAt: customer.createdAt,
          outcome: "present",
        });
        if (!runMarker) runMarker = ownership.runMarkerTag;
        assertCondition(
          runMarker === ownership.runMarkerTag,
          "Lease-owned customers expose more than one run marker.",
        );
      }
      assertCondition(
        exactRemoteCustomers.length >= 1 &&
          exactRemoteCustomers.length <= FIXTURE_ROLES.length,
        "The lease-owned Shopify customer cardinality is not recoverable.",
      );
      assertCondition(
        lease.fixtureEmailSha256.length === FIXTURE_ROLES.length,
        "The abandoned lease does not contain the exact A1 email cardinality.",
      );
      for (const role of FIXTURE_ROLES) {
        const email = `${runMarker}-${role}@example.com`;
        sensitive.add(email);
        const ownership =
          maintenance.readLoyaltyMaintenanceFixtureCustomerOwnership({
            metadata: currentStore.loyaltyProgram.metadata,
            email,
            tags: [DISPOSABLE_CUSTOMER_TAG, runMarker],
          });
        assertCondition(
          ownership.owned,
          "The recovered run marker does not reconstruct every leased fixture identity.",
        );
      }
      const discoveredCustomerIds = new Set(
        response.customers.nodes.map(({ id }) => id),
      );
      const ownershipQueries = [
        `tag:${runMarker}`,
        ...FIXTURE_ROLES.map(
          (role) => `email:${runMarker}-${role}@example.com`,
        ),
      ];
      for (const queryValue of ownershipQueries) {
        const ownershipSearch = await shopify.shopifyAdminGraphqlRequest<
          typeof response
        >({
          shopDomain: options.storeDomain,
          accessToken: credentials.accessToken,
          query: `query WeleticA1AbandonedRecoveryOwnershipCollisions($query: String!) {
              customers(first: 50, query: $query) {
                nodes { id email firstName lastName tags createdAt }
                pageInfo { hasNextPage }
              }
            }`,
          variables: { query: queryValue },
        });
        assertCondition(
          !ownershipSearch.customers.pageInfo.hasNextPage,
          "Fixture ownership collision discovery exceeded its bounded scan.",
        );
        for (const customer of ownershipSearch.customers.nodes) {
          const ownership =
            maintenance.readLoyaltyMaintenanceFixtureCustomerOwnership({
              metadata: currentStore.loyaltyProgram.metadata,
              email: customer.email ?? "",
              tags: customer.tags,
            });
          if (ownership.partialMatch) {
            throw new Error(
              "A Shopify customer partially matches the lease and cannot be adopted safely.",
            );
          }
          if (!ownership.owned || discoveredCustomerIds.has(customer.id)) {
            continue;
          }
          assertCondition(
            customer.email && ownership.runMarkerTag === runMarker,
            "An exact fixture collision search returned ambiguous ownership.",
          );
          const numericId =
            /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(customer.id)?.[1] ?? "";
          sensitive.add(customer.id);
          sensitive.add(customer.email);
          if (numericId) sensitive.add(numericId);
          exactRemoteCustomers.push({
            id: customer.id,
            numericId,
            email: customer.email,
            firstName: customer.firstName,
            lastName: customer.lastName,
            tags: customer.tags,
            createdAt: customer.createdAt,
            outcome: "present",
          });
          discoveredCustomerIds.add(customer.id);
        }
      }
      const exactEmails = new Set(
        exactRemoteCustomers.map(({ email }) => email),
      );
      assertCondition(
        exactEmails.size === exactRemoteCustomers.length &&
          exactRemoteCustomers.every(({ email, id, numericId, createdAt }) => {
            const parsedNumericId = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(
              id,
            )?.[1];
            if (parsedNumericId) sensitive.add(parsedNumericId);
            return (
              Boolean(parsedNumericId) &&
              numericId === parsedNumericId &&
              FIXTURE_ROLES.some(
                (role) => email === `${runMarker}-${role}@example.com`,
              ) &&
              isAbandonedBasicLifecycleFixtureCreatedWithinLease({
                createdAt,
                acquiredAt: lease.acquiredAt,
                // A controlled diagnostic may create another predeclared
                // fixture after the failed report finishes. The lease recovery
                // boundary is the final ownership window; nothing later may
                // be adopted by this run.
                recoveryAfter: lease.recoveryAfter,
              })
            );
          }),
        "A lease-owned Shopify customer is duplicated or outside the failed run.",
      );
      if (sourceRecoveryHarnessState) {
        assertCondition(
          runMarker === sourceRecoveryHarnessState.runMarker &&
            canonicalEqual(
              exactRemoteCustomers.map(({ id }) => id).sort(),
              [...sourceRecoveryHarnessState.remoteCustomerGids].sort(),
            ) &&
            canonicalEqual(
              exactRemoteCustomers.map(({ numericId }) => numericId).sort(),
              [...sourceRecoveryHarnessState.fixtureCustomerNumericIds].sort(),
            ) &&
            exactRemoteCustomers.every(({ email }) =>
              sourceRecoveryHarnessState.fixtureCustomerEmails.has(email),
            ),
          "The live Shopify fixtures differ from the authenticated source recovery capsule.",
        );
      }
      remoteFixtureCustomerCount = exactRemoteCustomers.length;
      return { remoteFixtureCustomerCount };
    });

    await check("Exact temporary definition diff", async () => {
      const programId = currentStore.loyaltyProgram.id;
      const storeId = currentStore.id;
      const [baselineDefinitions, currentDefinitions] = await Promise.all([
        Promise.all([
          baseline.weleticLoyaltyEarningRule.findMany({ where: { programId } }),
          baseline.weleticLoyaltyTier.findMany({ where: { programId } }),
          baseline.weleticLoyaltyReferralRule.findMany({
            where: { programId },
          }),
          baseline.weleticRewardDefinition.findMany({ where: { storeId } }),
        ]),
        Promise.all([
          prisma.weleticLoyaltyEarningRule.findMany({ where: { programId } }),
          prisma.weleticLoyaltyTier.findMany({ where: { programId } }),
          prisma.weleticLoyaltyReferralRule.findMany({ where: { programId } }),
          prisma.weleticRewardDefinition.findMany({ where: { storeId } }),
        ]),
      ]);
      if (
        recoveryState &&
        recoveryState.phase === "remote_cleanup_complete" &&
        baselineDefinitions.every((rows, index) =>
          canonicalEqual(rows, currentDefinitions[index]),
        )
      ) {
        assertProgramBusinessEqualsBaseline(
          baselineStore.loyaltyProgram as unknown as JsonRecord,
          currentStore.loyaltyProgram as unknown as JsonRecord,
        );
        recoveryState.phase = "local_cleanup_complete";
        checkpointAbandonedRecoveryState({
          capsule: recoveryCapsule,
          state: recoveryState,
          checkpoint: "local-cleanup-reconciled",
          forbiddenValues: [
            accessToken,
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
      }
      if (
        recoveryState &&
        recoveryPhaseAtLeast(recoveryState.phase, "local_cleanup_complete")
      ) {
        assertCondition(
          baselineDefinitions.every((rows, index) =>
            canonicalEqual(rows, currentDefinitions[index]),
          ),
          "Temporary definitions remain after the journaled local cleanup.",
        );
        temporaryRuleIds = new Set(recoveryState.temporaryRuleIds);
        temporaryTierIds = new Set(recoveryState.temporaryTierIds);
        temporaryReferralRuleIds = new Set(
          recoveryState.temporaryReferralRuleIds,
        );
        temporaryRewardIds = new Set(recoveryState.temporaryRewardIds);
        signupRuleId = recoveryState.signupRuleId;
        temporaryDefinitionCount = 6;
        return { temporaryDefinitionCount };
      }
      const result = assertAbandonedBasicLifecycleDefinitionDiff({
        baseline: {
          rules: baselineDefinitions[0] as unknown as JsonRecord[],
          tiers: baselineDefinitions[1] as unknown as JsonRecord[],
          referralRules: baselineDefinitions[2] as unknown as JsonRecord[],
          rewards: baselineDefinitions[3] as unknown as JsonRecord[],
        },
        current: {
          rules: currentDefinitions[0] as unknown as JsonRecord[],
          tiers: currentDefinitions[1] as unknown as JsonRecord[],
          referralRules: currentDefinitions[2] as unknown as JsonRecord[],
          rewards: currentDefinitions[3] as unknown as JsonRecord[],
        },
        programId,
        storeId,
        runMarker,
        acquiredAt: Date.parse(lease.acquiredAt),
        completedAt: Date.parse(sourceReport.completedAt),
      });
      const baselineRuleIds = new Set(
        baselineDefinitions[0].map(({ id }) => id),
      );
      const baselineTierIds = new Set(
        baselineDefinitions[1].map(({ id }) => id),
      );
      const baselineReferralRuleIds = new Set(
        baselineDefinitions[2].map(({ id }) => id),
      );
      const baselineRewardIds = new Set(
        baselineDefinitions[3].map(({ id }) => id),
      );
      temporaryRuleIds = new Set(
        currentDefinitions[0]
          .filter(({ id }) => !baselineRuleIds.has(id))
          .map(({ id }) => id),
      );
      temporaryTierIds = new Set(
        currentDefinitions[1]
          .filter(({ id }) => !baselineTierIds.has(id))
          .map(({ id }) => id),
      );
      temporaryReferralRuleIds = new Set(
        currentDefinitions[2]
          .filter(({ id }) => !baselineReferralRuleIds.has(id))
          .map(({ id }) => id),
      );
      temporaryRewardIds = new Set(
        currentDefinitions[3]
          .filter(({ id }) => !baselineRewardIds.has(id))
          .map(({ id }) => id),
      );
      const signupRule = currentDefinitions[0].find(
        ({ id, triggerCode }) =>
          temporaryRuleIds.has(id) && triggerCode === "account_created",
      );
      assertCondition(
        signupRule,
        "The exact temporary signup rule could not be identified.",
      );
      signupRuleId = signupRule.id;
      if (sourceRecoveryHarnessState) {
        assertCondition(
          canonicalEqual(
            [...temporaryRuleIds].sort(),
            [...sourceRecoveryHarnessState.fixtureRuleIds].sort(),
          ) &&
            canonicalEqual(
              [...temporaryTierIds].sort(),
              [...sourceRecoveryHarnessState.fixtureTierIds].sort(),
            ) &&
            canonicalEqual(
              [...temporaryReferralRuleIds].sort(),
              [...sourceRecoveryHarnessState.fixtureReferralRuleIds].sort(),
            ) &&
            canonicalEqual(
              [...temporaryRewardIds].sort(),
              [...sourceRecoveryHarnessState.fixtureRewardIds].sort(),
            ),
          "The temporary definition identities differ from the authenticated source recovery capsule.",
        );
      }
      if (recoveryState) {
        assertCondition(
          canonicalEqual(
            [...temporaryRuleIds].sort(),
            recoveryState.temporaryRuleIds,
          ) &&
            canonicalEqual(
              [...temporaryTierIds].sort(),
              recoveryState.temporaryTierIds,
            ) &&
            canonicalEqual(
              [...temporaryReferralRuleIds].sort(),
              recoveryState.temporaryReferralRuleIds,
            ) &&
            canonicalEqual(
              [...temporaryRewardIds].sort(),
              recoveryState.temporaryRewardIds,
            ) &&
            signupRuleId === recoveryState.signupRuleId,
          "The temporary definition identities differ from the private recovery journal.",
        );
      }
      [
        ...temporaryRuleIds,
        ...temporaryTierIds,
        ...temporaryReferralRuleIds,
        ...temporaryRewardIds,
      ].forEach((id) => sensitive.add(id));
      temporaryDefinitionCount = result.temporaryDefinitionCount;
      return { temporaryDefinitionCount };
    });

    await check(
      "Exhaustive early-phase family and ingress closure",
      async () => {
        const numericIds = exactRemoteCustomers.map(
          ({ numericId }) => numericId,
        );
        [historicalBaselineSnapshot, currentSnapshot] = await Promise.all([
          loadAbandonedBasicLifecycleFamilySnapshot({
            client: baseline,
            storeId: currentStore.id,
            workspaceId: currentStore.projectId,
            platformProgramId: currentStore.programId,
            loyaltyProgramId: currentStore.loyaltyProgram.id,
            shopDomain: options.storeDomain,
            fixtureCustomerNumericIds: numericIds,
          }),
          loadAbandonedBasicLifecycleFamilySnapshot({
            client: prisma,
            storeId: currentStore.id,
            workspaceId: currentStore.projectId,
            platformProgramId: currentStore.programId,
            loyaltyProgramId: currentStore.loyaltyProgram.id,
            shopDomain: options.storeDomain,
            fixtureCustomerNumericIds: numericIds,
          }),
        ]);
        if (recoveryState) {
          assertCondition(
            canonicalDigest(historicalBaselineSnapshot) ===
              recoveryState.bindings.historicalBaselineSnapshotSha256,
            "The historical recovery baseline differs from the private recovery journal.",
          );
          retainedAuditIds = new Set(recoveryState.retainedAuditIds);
          fixtureShopperIds = new Set(recoveryState.fixtureShopperIds);
          fixtureAccountIds = new Set(recoveryState.fixtureAccountIds);
          fixtureLedgerIds = new Set(recoveryState.fixtureLedgerIds);
        }
        const historicalFixtureShoppers =
          historicalBaselineSnapshot.shoppers.filter(({ shopifyCustomerId }) =>
            numericIds.includes(String(shopifyCustomerId)),
          );
        assertCondition(
          historicalFixtureShoppers.length === 0,
          "A lease-owned remote customer already existed in the historical baseline.",
        );
        const fixtureShoppers = currentSnapshot.shoppers.filter((row) =>
          recoveryState
            ? fixtureShopperIds.has(String(row.id))
            : numericIds.includes(String(row.shopifyCustomerId)),
        );
        if (!recoveryState) {
          fixtureShopperIds = new Set(
            fixtureShoppers.map(({ id }) => String(id)),
          );
        }
        const fixtureAccounts = currentSnapshot.loyaltyAccounts.filter((row) =>
          recoveryState
            ? fixtureAccountIds.has(String(row.id))
            : fixtureShopperIds.has(String(row.shopperId)),
        );
        if (!recoveryState) {
          fixtureAccountIds = new Set(
            fixtureAccounts.map(({ id }) => String(id)),
          );
        }
        const fixtureLedgers = currentSnapshot.pointsLedgerEntries.filter(
          (row) =>
            recoveryState
              ? fixtureLedgerIds.has(String(row.id))
              : fixtureAccountIds.has(String(row.accountId)),
        );
        if (!recoveryState) {
          fixtureLedgerIds = new Set(
            fixtureLedgers.map(({ id }) => String(id)),
          );
        }
        const now = new Date();
        const registeredAudits = currentSnapshot.shopifyWebhookEvents.filter(
          (row) =>
            new Date(row.createdAt as string | Date).getTime() >=
            Date.parse(lease.acquiredAt),
        );
        assertCondition(
          registeredAudits.every(
            (row) =>
              row.storeId === currentStore.id &&
              row.topic === "customers/create" &&
              boundedFixtureTimestamp(
                row.createdAt,
                Date.parse(lease.acquiredAt),
                now.getTime(),
              ),
          ),
          "A post-lease webhook audit is not exact lease-window customers/create evidence.",
        );
        const registeredAuditIds = new Set(
          registeredAudits.map(({ id }) => String(id)),
        );
        if (recoveryState) {
          assertCondition(
            canonicalEqual(
              [...registeredAuditIds].sort(),
              recoveryState.retainedAuditIds,
            ),
            "The post-lease webhook audit identities differ from the private recovery journal.",
          );
        } else {
          retainedAuditIds = registeredAuditIds;
        }
        const leaseOwnedIds = {
          loyaltyEarningRules: temporaryRuleIds,
          loyaltyTiers: temporaryTierIds,
          loyaltyReferralRules: temporaryReferralRuleIds,
          rewardDefinitions: temporaryRewardIds,
          shoppers: fixtureShopperIds,
          loyaltyAccounts: fixtureAccountIds,
          pointsLedgerEntries: fixtureLedgerIds,
          shopifyWebhookEvents: retainedAuditIds,
        };
        const boundaryProof = assertAbandonedOperationalBaselineBoundary({
          historical: historicalBaselineSnapshot,
          current: currentSnapshot,
          allowedLeaseOwnedIds: leaseOwnedIds,
          leaseAcquiredAt: lease.acquiredAt,
        });
        operationalBaselineSnapshot =
          deriveAbandonedOperationalBaselineSnapshot({
            current: currentSnapshot,
            excludedIds: leaseOwnedIds,
          });
        if (recoveryState) {
          assertCondition(
            canonicalDigest(operationalBaselineSnapshot) ===
              recoveryState.bindings.operationalBaselineSnapshotSha256,
            "The operational recovery baseline differs from the private recovery journal.",
          );
        }
        if (
          recoveryState &&
          recoveryPhaseAtLeast(recoveryState.phase, "local_cleanup_complete")
        ) {
          const familyProof = assertAbandonedBasicLifecycleFamilyDiff({
            baseline: operationalBaselineSnapshot,
            current: currentSnapshot,
            allowedExtraIds: { shopifyWebhookEvents: retainedAuditIds },
          });
          newLocalProjectionCount = fixtureShopperIds.size;
          newRegisteredAuditRowCount = retainedAuditIds.size;
          return {
            terminalProjectionCount: newLocalProjectionCount,
            expiredUndeliveredCount:
              exactRemoteCustomers.length - newLocalProjectionCount,
            ...boundaryProof,
            ...familyProof,
          };
        }
        const graph = assertAbandonedBasicLifecycleProjectionGraph({
          remoteCustomers: exactRemoteCustomers,
          shoppers: fixtureShoppers,
          accounts: fixtureAccounts,
          ledgerEntries: fixtureLedgers,
          storeId: currentStore.id,
          programId: currentStore.loyaltyProgram.id,
          runMarker,
          signupRuleId,
          acquiredAt: Date.parse(lease.acquiredAt),
          now: now.getTime(),
        });
        if (recoveryState) {
          const currentFixtureShopperIds = fixtureShoppers.map(({ id }) =>
            String(id),
          );
          const currentFixtureAccountIds = fixtureAccounts.map(({ id }) =>
            String(id),
          );
          const currentFixtureLedgerIds = fixtureLedgers.map(({ id }) =>
            String(id),
          );
          assertCondition(
            canonicalEqual(
              currentFixtureShopperIds.sort(),
              recoveryState.fixtureShopperIds,
            ) &&
              canonicalEqual(
                currentFixtureAccountIds.sort(),
                recoveryState.fixtureAccountIds,
              ) &&
              canonicalEqual(
                currentFixtureLedgerIds.sort(),
                recoveryState.fixtureLedgerIds,
              ) &&
              canonicalEqual(
                [...retainedAuditIds].sort(),
                recoveryState.retainedAuditIds,
              ) &&
              canonicalDigest(currentSnapshot) ===
                recoveryState.bindings.preflightSnapshotSha256,
            "The local fixture graph differs from the private recovery journal.",
          );
        }
        [
          ...fixtureShopperIds,
          ...fixtureAccountIds,
          ...fixtureLedgerIds,
          ...retainedAuditIds,
        ].forEach((id) => sensitive.add(id));
        newLocalProjectionCount = fixtureShoppers.length;
        newRegisteredAuditRowCount = registeredAudits.length;
        const projectedCustomerIds = new Set(
          fixtureShoppers.map(({ shopifyCustomerId }) =>
            String(shopifyCustomerId),
          ),
        );
        const ownership = assertAbandonedBasicLifecycleIngressOwnership({
          remoteCustomerCount: exactRemoteCustomers.length,
          localProjectionCount: newLocalProjectionCount,
          auditRows: registeredAudits as any,
          installationGeneration: currentStore.installationGeneration,
          leaseAcquiredAt: lease.acquiredAt,
          recoveryAfter: lease.recoveryAfter,
          now,
          undeliveredCustomerCreatedAt: exactRemoteCustomers
            .filter(({ numericId }) => !projectedCustomerIds.has(numericId))
            .map(({ createdAt }) => createdAt),
        });
        const familyProof = assertAbandonedBasicLifecycleFamilyDiff({
          baseline: operationalBaselineSnapshot,
          current: currentSnapshot,
          allowedExtraIds: leaseOwnedIds,
        });
        assertCondition(
          currentSnapshot.loyaltyOutboxJobs.length ===
            operationalBaselineSnapshot.loyaltyOutboxJobs.length,
          "Early customers/create unexpectedly produced loyalty outbox work.",
        );
        return {
          ...ownership,
          ...graph,
          ...boundaryProof,
          retainedRowCount: familyProof.retainedRowCount,
          allowedExtraRowCount: familyProof.allowedExtraRowCount,
        };
      },
    );

    let renewedMetadata!: Prisma.InputJsonObject;
    let ownerPermit:
      | import("@/lib/weletic/loyalty/maintenance-write-fence").LoyaltyMaintenancePermit
      | undefined;
    let recoveryOwnerToken =
      recoveryState?.ownerToken ??
      sourceRecoveryHarnessState?.maintenanceOwnerToken ??
      crypto.randomBytes(48).toString("base64url");
    sensitive.add(recoveryOwnerToken);
    if (!recoveryState) {
      const stateStore = {
        id: currentStore.id,
        projectId: currentStore.projectId,
        programId: currentStore.programId,
        installationGeneration: currentStore.installationGeneration,
        shopCurrency: currentStore.shopCurrency,
      } satisfies AbandonedBasicLifecycleRecoveryState["store"];
      recoveryState = {
        version: ABANDONED_RECOVERY_STATE_VERSION,
        phase: "preflight_complete",
        sourceReport: {
          version: sourceReport.version,
          sha256: sourceSha256,
          startedAt: sourceReport.startedAt,
          completedAt: sourceReport.completedAt,
        },
        bindings: {
          failedReportPathSha256: canonicalPathSha256(options.failedReportPath),
          reportPathSha256: canonicalPathSha256(options.reportPath),
          storeDomainSha256: canonicalDigest(options.storeDomain),
          tenantTupleSha256: canonicalDigest(
            recoveryTenantTuple({
              storeDomain: options.storeDomain,
              store: stateStore,
            }),
          ),
          baselineProgramSha256: canonicalDigest(baselineStore.loyaltyProgram),
          sourceRecoveryCapsuleSha256,
          historicalBaselineSnapshotSha256: canonicalDigest(
            historicalBaselineSnapshot,
          ),
          operationalBaselineSnapshotSha256: canonicalDigest(
            operationalBaselineSnapshot,
          ),
          preflightSnapshotSha256: canonicalDigest(currentSnapshot),
        },
        originalLease: lease,
        ownerToken: recoveryOwnerToken,
        runMarker,
        store: stateStore,
        remoteCustomers: exactRemoteCustomers.map((customer) => ({
          ...customer,
          tags: [...customer.tags],
        })),
        retainedAuditIds: [...retainedAuditIds].sort(),
        fixtureShopperIds: [...fixtureShopperIds].sort(),
        fixtureAccountIds: [...fixtureAccountIds].sort(),
        fixtureLedgerIds: [...fixtureLedgerIds].sort(),
        temporaryRuleIds: [...temporaryRuleIds].sort(),
        temporaryTierIds: [...temporaryTierIds].sort(),
        temporaryReferralRuleIds: [...temporaryReferralRuleIds].sort(),
        temporaryRewardIds: [...temporaryRewardIds].sort(),
        signupRuleId,
      };
      assertAbandonedBasicLifecycleRecoveryState(recoveryState);
      recoveryCapsule.create({
        state: recoveryState,
        checkpoint: "abandoned-recovery-preflight-complete",
        forbiddenValues: [
          accessToken,
          options.baselineDatabaseUrl,
          process.env.DATABASE_URL,
        ],
      });
    }
    await check("Expired lease exact-generation takeover", async () => {
      if (recoveryState.phase === "lease_released") {
        renewedMetadata = {};
        mutation.leaseTakenOver = true;
        return { exactGenerationTakenOver: true };
      }
      const currentMetadata = currentStore.loyaltyProgram.metadata;
      try {
        ownerPermit = maintenance.createLoyaltyMaintenanceOwnerPermit({
          storeId: currentStore.id,
          metadata: currentMetadata,
          ownerToken: recoveryOwnerToken,
        });
        assertCondition(
          isPlainObject(currentMetadata),
          "The active recovery metadata is invalid.",
        );
        renewedMetadata = currentMetadata as Prisma.InputJsonObject;
        mutation.leaseTakenOver = true;
        if (recoveryState.phase === "preflight_complete") {
          recoveryState.phase = "lease_taken_over";
          checkpointAbandonedRecoveryState({
            capsule: recoveryCapsule,
            state: recoveryState,
            checkpoint: "lease-takeover-reconciled",
            forbiddenValues: [
              accessToken,
              options.baselineDatabaseUrl,
              process.env.DATABASE_URL,
            ],
          });
        }
        return { exactGenerationTakenOver: true };
      } catch (error) {
        assertCondition(
          error instanceof maintenance.LoyaltyMaintenanceBlockedError,
          "The current recovery generation could not be authenticated.",
        );
      }

      assertCondition(
        activeLease && Date.now() >= Date.parse(activeLease.recoveryAfter),
        "A different recovery owner still holds the renewed maintenance lease.",
      );
      if (recoveryState.phase !== "preflight_complete") {
        recoveryOwnerToken = crypto.randomBytes(48).toString("base64url");
        sensitive.add(recoveryOwnerToken);
        recoveryState.ownerToken = recoveryOwnerToken;
        checkpointAbandonedRecoveryState({
          capsule: recoveryCapsule,
          state: recoveryState,
          checkpoint: "next-takeover-token-durable",
          forbiddenValues: [
            accessToken,
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
      }
      const takeoverNow = new Date();
      const takeoverRecoveryAfter = new Date(
        takeoverNow.getTime() + RECOVERY_TAKEOVER_WINDOW_MS,
      );
      const result = await prisma.$transaction(
        (tx) =>
          maintenance.takeOverExpiredLoyaltyMaintenanceLeaseWithCas({
            tx,
            storeId: currentStore.id,
            programId: currentStore.loyaltyProgram.id,
            expectedUpdatedAt: currentStore.loyaltyProgram.updatedAt,
            expectedMetadata: currentStore.loyaltyProgram.metadata,
            newOwnerToken: recoveryOwnerToken,
            now: takeoverNow,
            recoveryAfter: takeoverRecoveryAfter,
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 60_000,
        },
      );
      renewedMetadata = result.metadata;
      ownerPermit = result.permit;
      mutation.leaseTakenOver = true;
      recoveryState.phase = recoveryPhaseAtLeast(
        recoveryState.phase,
        "lease_taken_over",
      )
        ? recoveryState.phase
        : "lease_taken_over";
      checkpointAbandonedRecoveryState({
        capsule: recoveryCapsule,
        state: recoveryState,
        checkpoint: "lease-taken-over",
        forbiddenValues: [
          accessToken,
          options.baselineDatabaseUrl,
          process.env.DATABASE_URL,
        ],
      });
      return { exactGenerationTakenOver: true };
    });

    await check("Exact fixture outbox quiescence", async () => {
      if (recoveryState.phase === "lease_released") {
        return { exactFixtureOutboxRows: 0, baselineOutboxUnchanged: true };
      }
      assertCondition(ownerPermit, "The recovery owner permit is unavailable.");
      await merchantFence.withActiveStoreLoyaltyMutation({
        storeId: currentStore.id,
        action: "a1_abandoned_recovery_outbox_quiescence",
        expectedInstallationGeneration: currentStore.installationGeneration,
        loyaltyMaintenancePermit: ownerPermit,
        operation: async (tx) => {
          const currentOutbox = await tx.weleticLoyaltyOutboxJob.findMany({
            where: { storeId: currentStore.id },
            orderBy: { id: "asc" },
          });
          assertRetainedRowsExact(
            "loyalty-outbox",
            operationalBaselineSnapshot.loyaltyOutboxJobs,
            currentOutbox as unknown as JsonRecord[],
          );
          assertCondition(
            currentOutbox.length ===
              operationalBaselineSnapshot.loyaltyOutboxJobs.length,
            "Early-phase recovery found fixture outbox work that the customer path cannot produce.",
          );
        },
      });
      return { exactFixtureOutboxRows: 0, baselineOutboxUnchanged: true };
    });

    const preflightShopperByCustomerId = new Map(
      currentSnapshot.shoppers
        .filter(({ id }) => fixtureShopperIds.has(String(id)))
        .map((row) => [String(row.shopifyCustomerId), row]),
    );
    const preflightAccountByShopperId = new Map(
      currentSnapshot.loyaltyAccounts
        .filter(({ id }) => fixtureAccountIds.has(String(id)))
        .map((row) => [String(row.shopperId), row]),
    );
    const preflightLedgerByAccountId = new Map(
      currentSnapshot.pointsLedgerEntries
        .filter(({ id }) => fixtureLedgerIds.has(String(id)))
        .map((row) => [String(row.accountId), row]),
    );

    await check(
      "Exact remote fixture deletion under customer locks",
      async () => {
        if (recoveryState.phase === "lease_released") {
          mutation.remoteCustomersDeleted = exactRemoteCustomers.length;
          return { remoteCustomersDeleted: mutation.remoteCustomersDeleted };
        }
        assertCondition(
          ownerPermit,
          "The recovery owner permit is unavailable.",
        );
        if (
          !recoveryPhaseAtLeast(recoveryState.phase, "remote_cleanup_started")
        ) {
          recoveryState.phase = "remote_cleanup_started";
          checkpointAbandonedRecoveryState({
            capsule: recoveryCapsule,
            state: recoveryState,
            checkpoint: "before-first-remote-delete",
            forbiddenValues: [
              accessToken,
              options.baselineDatabaseUrl,
              process.env.DATABASE_URL,
            ],
          });
        }
        for (const customer of [...exactRemoteCustomers].sort((left, right) =>
          left.numericId.localeCompare(right.numericId),
        )) {
          if (customer.outcome === "deleted") continue;
          await settlementLocks.withShopifyCustomerSettlementLocks({
            workspaceId: currentStore.projectId,
            storeId: currentStore.id,
            shopifyCustomerId: customer.numericId,
            fn: async () => {
              const currentProgram =
                await prisma.weleticLoyaltyProgram.findUnique({
                  where: { id: currentStore.loyaltyProgram.id },
                  select: { storeId: true, metadata: true },
                });
              if (
                !currentProgram ||
                currentProgram.storeId !== currentStore.id ||
                !canonicalEqual(currentProgram.metadata, renewedMetadata)
              ) {
                throw new Error(
                  "The renewed recovery generation changed before remote cleanup.",
                );
              }
              maintenance.assertLoyaltyMaintenanceWriteAllowed({
                storeId: currentStore.id,
                metadata: currentProgram.metadata,
                permit: ownerPermit,
              });
              const expectedShopper = preflightShopperByCustomerId.get(
                customer.numericId,
              );
              if (expectedShopper) {
                const currentShopper = await prisma.weleticShopper.findUnique({
                  where: {
                    storeId_shopifyCustomerId: {
                      storeId: currentStore.id,
                      shopifyCustomerId: customer.numericId,
                    },
                  },
                });
                const expectedAccount = preflightAccountByShopperId.get(
                  String(expectedShopper.id),
                );
                const currentAccount = expectedAccount
                  ? await prisma.weleticLoyaltyAccount.findUnique({
                      where: { id: String(expectedAccount.id) },
                    })
                  : null;
                const expectedLedger = expectedAccount
                  ? preflightLedgerByAccountId.get(String(expectedAccount.id))
                  : null;
                const currentLedger = expectedLedger
                  ? await prisma.weleticPointsLedgerEntry.findUnique({
                      where: { id: String(expectedLedger.id) },
                    })
                  : null;
                assertCondition(
                  currentShopper &&
                    currentAccount &&
                    currentLedger &&
                    canonicalEqual(currentShopper, expectedShopper) &&
                    canonicalEqual(currentAccount, expectedAccount) &&
                    canonicalEqual(currentLedger, expectedLedger),
                  "A projected fixture changed before its customer-locked remote cleanup.",
                );
              } else {
                const boundary = Math.max(
                  Date.parse(lease.recoveryAfter),
                  Date.parse(customer.createdAt) +
                    SHOPIFY_CUSTOMER_CREATE_RETRY_HORIZON_MS +
                    LATE_INGRESS_SAFETY_MARGIN_MS,
                );
                assertCondition(
                  Date.now() >= boundary,
                  "An unaudited remote fixture has not crossed its exact retry closure boundary.",
                );
                const unexpectedProjection =
                  await prisma.weleticShopper.findUnique({
                    where: {
                      storeId_shopifyCustomerId: {
                        storeId: currentStore.id,
                        shopifyCustomerId: customer.numericId,
                      },
                    },
                  });
                assertCondition(
                  !unexpectedProjection,
                  "A formerly undelivered customer projected after preflight.",
                );
              }

              const lookup = await shopify.shopifyAdminGraphqlRequest<{
                customer: {
                  id: string;
                  email: string | null;
                  firstName: string | null;
                  lastName: string | null;
                  tags: string[];
                  createdAt: string;
                } | null;
              }>({
                shopDomain: options.storeDomain,
                accessToken,
                query: `query WeleticAbandonedA1CustomerProof($id: ID!) {
                customer(id: $id) { id email firstName lastName tags createdAt }
              }`,
                variables: { id: customer.id },
              });
              assertCondition(
                lookup.customer &&
                  lookup.customer.id === customer.id &&
                  lookup.customer.email === customer.email &&
                  lookup.customer.firstName === customer.firstName &&
                  lookup.customer.lastName === customer.lastName &&
                  canonicalEqual(lookup.customer.tags, customer.tags) &&
                  lookup.customer.createdAt === customer.createdAt,
                "The exact remote fixture changed before deletion.",
              );
              const ownership =
                maintenance.readLoyaltyMaintenanceFixtureCustomerOwnership({
                  metadata: renewedMetadata as unknown as Prisma.JsonValue,
                  email: lookup.customer.email ?? "",
                  tags: lookup.customer.tags,
                });
              assertCondition(
                ownership.owned &&
                  ownership.runMarkerTag === runMarker &&
                  isAbandonedBasicLifecycleFixtureCreatedWithinLease({
                    createdAt: lookup.customer.createdAt,
                    acquiredAt: lease.acquiredAt,
                    recoveryAfter: lease.recoveryAfter,
                  }),
                "The exact remote fixture no longer matches the original lease ownership window.",
              );
              let confirmedDeleted = false;
              customer.outcome = "delete_outcome_unknown";
              recoveryState.remoteCustomers = exactRemoteCustomers.map(
                (remoteCustomer) => ({
                  ...remoteCustomer,
                  tags: [...remoteCustomer.tags],
                }),
              );
              checkpointAbandonedRecoveryState({
                capsule: recoveryCapsule,
                state: recoveryState,
                checkpoint: "remote-delete-dispatch-uncertain",
                forbiddenValues: [
                  accessToken,
                  options.baselineDatabaseUrl,
                  process.env.DATABASE_URL,
                ],
              });
              try {
                const deleted = await shopify.shopifyAdminGraphqlRequest<{
                  customerDelete: {
                    deletedCustomerId: string | null;
                    userErrors: Array<{ message: string }>;
                  };
                }>({
                  shopDomain: options.storeDomain,
                  accessToken,
                  query: `mutation WeleticAbandonedA1CustomerDelete($input: CustomerDeleteInput!) {
                  customerDelete(input: $input) {
                    deletedCustomerId
                    userErrors { field message }
                  }
                }`,
                  variables: { input: { id: customer.id } },
                  postDispatchOutcomeUnknown: true,
                });
                confirmedDeleted =
                  deleted.customerDelete.deletedCustomerId === customer.id &&
                  deleted.customerDelete.userErrors.length === 0;
                assertCondition(
                  confirmedDeleted,
                  "Shopify did not confirm exact fixture customer deletion.",
                );
              } catch (error) {
                const reconciled = await shopify.shopifyAdminGraphqlRequest<{
                  customer: { id: string } | null;
                }>({
                  shopDomain: options.storeDomain,
                  accessToken,
                  query: `query WeleticAbandonedA1CustomerDeleteReconcile($id: ID!) {
                    customer(id: $id) { id }
                  }`,
                  variables: { id: customer.id },
                });
                if (reconciled.customer) throw error;
                confirmedDeleted = true;
              }
              const readback = await shopify.shopifyAdminGraphqlRequest<{
                customer: { id: string } | null;
              }>({
                shopDomain: options.storeDomain,
                accessToken,
                query: `query WeleticAbandonedA1CustomerDeleteReadback($id: ID!) {
                customer(id: $id) { id }
              }`,
                variables: { id: customer.id },
              });
              assertCondition(
                confirmedDeleted && !readback.customer,
                "Shopify still exposes an exact fixture after deletion.",
              );
              customer.outcome = "deleted";
              recoveryState.remoteCustomers = exactRemoteCustomers.map(
                (remoteCustomer) => ({
                  ...remoteCustomer,
                  tags: [...remoteCustomer.tags],
                }),
              );
              checkpointAbandonedRecoveryState({
                capsule: recoveryCapsule,
                state: recoveryState,
                checkpoint: "remote-delete-confirmed",
                forbiddenValues: [
                  accessToken,
                  options.baselineDatabaseUrl,
                  process.env.DATABASE_URL,
                ],
              });
            },
          });
        }
        assertCondition(
          exactRemoteCustomers.every(
            (customer) => customer.outcome === "deleted",
          ),
          "Not every journaled remote fixture reached confirmed absence.",
        );
        recoveryState.phase = "remote_cleanup_complete";
        recoveryState.remoteCustomers = exactRemoteCustomers.map(
          (customer) => ({
            ...customer,
            tags: [...customer.tags],
          }),
        );
        checkpointAbandonedRecoveryState({
          capsule: recoveryCapsule,
          state: recoveryState,
          checkpoint: "remote-cleanup-complete",
          forbiddenValues: [
            accessToken,
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
        mutation.remoteCustomersDeleted = exactRemoteCustomers.length;
        return { remoteCustomersDeleted: mutation.remoteCustomersDeleted };
      },
    );

    await check("Remote absence and stable local closure", async () => {
      for (const customer of exactRemoteCustomers) {
        const readback = await shopify.shopifyAdminGraphqlRequest<{
          customer: { id: string } | null;
        }>({
          shopDomain: options.storeDomain,
          accessToken,
          query: `query WeleticAbandonedA1RemoteAbsence($id: ID!) {
            customer(id: $id) { id }
          }`,
          variables: { id: customer.id },
        });
        assertCondition(
          !readback.customer,
          "An exact remote fixture reappeared after customer-locked deletion.",
        );
      }
      const stableSnapshot = await loadAbandonedBasicLifecycleFamilySnapshot({
        client: prisma,
        storeId: currentStore.id,
        workspaceId: currentStore.projectId,
        platformProgramId: currentStore.programId,
        loyaltyProgramId: currentStore.loyaltyProgram.id,
        shopDomain: options.storeDomain,
        fixtureCustomerNumericIds: exactRemoteCustomers.map(
          ({ numericId }) => numericId,
        ),
      });
      assertAbandonedBasicLifecycleFamilyDiff({
        baseline: currentSnapshot,
        current: stableSnapshot,
        allowedExtraIds: {},
      });
      currentSnapshot = stableSnapshot;
      return { remoteAbsenceConfirmed: true, localClosureStable: true };
    });

    await check(
      "Canonical local cleanup and baseline program restore",
      async () => {
        if (
          recoveryPhaseAtLeast(recoveryState.phase, "local_cleanup_complete")
        ) {
          mutation.localRowsDeleted = fixtureShopperIds.size * 3;
          mutation.temporaryDefinitionsDeleted = 6;
          return {
            localRowsDeleted: mutation.localRowsDeleted,
            temporaryDefinitionsDeleted: mutation.temporaryDefinitionsDeleted,
            programBusinessRestored: true,
          };
        }
        assertCondition(
          recoveryState.phase === "remote_cleanup_complete" && ownerPermit,
          "Local cleanup requires confirmed remote absence and the recovery owner permit.",
        );
        const exactValues = new Set([
          ...fixtureShopperIds,
          ...fixtureAccountIds,
          ...fixtureLedgerIds,
          ...temporaryRuleIds,
          ...temporaryTierIds,
          ...temporaryReferralRuleIds,
          ...temporaryRewardIds,
          ...exactRemoteCustomers.flatMap(({ id, numericId }) => [
            id,
            numericId,
          ]),
        ]);
        const deleted = await merchantFence.withActiveStoreLoyaltyMutation({
          storeId: currentStore.id,
          action: "a1_abandoned_recovery_local_cleanup",
          expectedInstallationGeneration: currentStore.installationGeneration,
          loyaltyMaintenancePermit: ownerPermit,
          operation: async (tx) => {
            const fixtureShopperRows = await tx.weleticShopper.findMany({
              where: {
                storeId: currentStore.id,
                id: { in: [...fixtureShopperIds] },
              },
              orderBy: { id: "asc" },
            });
            const fixtureAccountRows = await tx.weleticLoyaltyAccount.findMany({
              where: {
                storeId: currentStore.id,
                id: { in: [...fixtureAccountIds] },
              },
              orderBy: { id: "asc" },
            });
            const fixtureLedgerRows =
              await tx.weleticPointsLedgerEntry.findMany({
                where: {
                  storeId: currentStore.id,
                  id: { in: [...fixtureLedgerIds] },
                },
                orderBy: { id: "asc" },
              });
            assertCondition(
              canonicalEqual(
                fixtureShopperRows,
                currentSnapshot.shoppers.filter(({ id }) =>
                  fixtureShopperIds.has(String(id)),
                ),
              ) &&
                canonicalEqual(
                  fixtureAccountRows,
                  currentSnapshot.loyaltyAccounts.filter(({ id }) =>
                    fixtureAccountIds.has(String(id)),
                  ),
                ) &&
                canonicalEqual(
                  fixtureLedgerRows,
                  currentSnapshot.pointsLedgerEntries.filter(({ id }) =>
                    fixtureLedgerIds.has(String(id)),
                  ),
                ),
              "The exact local fixture graph changed inside the cleanup transaction.",
            );

            const [
              accountReferences,
              tierHistoryReferences,
              grantReferences,
              redemptionReferences,
              referralReferences,
              previewReferences,
              orderReferences,
              tombstoneReferences,
              rewardRuleReferences,
              allStoreLedgers,
              allStoreOutbox,
              allStoreReconciliation,
              allStoreVoucherCleanup,
              allProgramRules,
              allProgramCampaigns,
            ] = await Promise.all([
              tx.weleticLoyaltyAccount.findMany({
                where: {
                  storeId: currentStore.id,
                  OR: [
                    { referredById: { in: [...fixtureAccountIds] } },
                    { currentTierId: { in: [...temporaryTierIds] } },
                  ],
                },
              }),
              tx.weleticLoyaltyTierHistory.findMany({
                where: {
                  OR: [
                    { accountId: { in: [...fixtureAccountIds] } },
                    { fromTierId: { in: [...temporaryTierIds] } },
                    { toTierId: { in: [...temporaryTierIds] } },
                  ],
                },
              }),
              tx.weleticLoyaltyEarnGrant.findMany({
                where: {
                  storeId: currentStore.id,
                  OR: [
                    { accountId: { in: [...fixtureAccountIds] } },
                    { shopperId: { in: [...fixtureShopperIds] } },
                    { selectedRuleId: { in: [...temporaryRuleIds] } },
                    { tierId: { in: [...temporaryTierIds] } },
                  ],
                },
              }),
              tx.weleticRewardRedemption.findMany({
                where: {
                  storeId: currentStore.id,
                  OR: [
                    { accountId: { in: [...fixtureAccountIds] } },
                    { rewardDefinitionId: { in: [...temporaryRewardIds] } },
                  ],
                },
              }),
              tx.weleticLoyaltyReferral.findMany({
                where: {
                  storeId: currentStore.id,
                  OR: [
                    { advocateAccountId: { in: [...fixtureAccountIds] } },
                    { refereeAccountId: { in: [...fixtureAccountIds] } },
                    { refereeShopperId: { in: [...fixtureShopperIds] } },
                  ],
                },
              }),
              tx.weleticLoyaltyBackfillPreviewItem.findMany({
                where: {
                  OR: [
                    { accountId: { in: [...fixtureAccountIds] } },
                    { shopperId: { in: [...fixtureShopperIds] } },
                  ],
                },
              }),
              tx.weleticCommerceOrder.findMany({
                where: {
                  storeId: currentStore.id,
                  shopperId: { in: [...fixtureShopperIds] },
                },
              }),
              tx.weleticShopifyCustomerPrivacyTombstone.findMany({
                where: {
                  storeId: currentStore.id,
                  OR: [
                    { shopperId: { in: [...fixtureShopperIds] } },
                    { accountId: { in: [...fixtureAccountIds] } },
                  ],
                },
              }),
              tx.weleticLoyaltyReferralRule.findMany({
                where: {
                  programId: currentStore.loyaltyProgram.id,
                  OR: [
                    {
                      advocateRewardDefinitionId: {
                        in: [...temporaryRewardIds],
                      },
                    },
                    {
                      refereeRewardDefinitionId: {
                        in: [...temporaryRewardIds],
                      },
                    },
                  ],
                },
              }),
              tx.weleticPointsLedgerEntry.findMany({
                where: { storeId: currentStore.id },
              }),
              tx.weleticLoyaltyOutboxJob.findMany({
                where: { storeId: currentStore.id },
                orderBy: { id: "asc" },
              }),
              tx.weleticReconciliationIssue.findMany({
                where: { storeId: currentStore.id },
              }),
              tx.weleticShopifyVoucherCleanup.findMany({
                where: { storeId: currentStore.id },
              }),
              tx.weleticLoyaltyEarningRule.findMany({
                where: { programId: currentStore.loyaltyProgram.id },
              }),
              tx.weleticLoyaltyBonusCampaign.findMany({
                where: { programId: currentStore.loyaltyProgram.id },
              }),
            ]);
            assertCondition(
              accountReferences.length === 0 &&
                tierHistoryReferences.length === 0 &&
                grantReferences.length === 0 &&
                redemptionReferences.length === 0 &&
                referralReferences.length === 0 &&
                previewReferences.length === 0 &&
                orderReferences.length === 0 &&
                tombstoneReferences.length === 0 &&
                rewardRuleReferences.length === 0,
              "A supposedly early-phase fixture has a non-allowlisted relational dependency.",
            );
            const ledgerSoftReferences = allStoreLedgers.filter((row) =>
              jsonContainsExactValue(
                { referenceId: row.referenceId, metadata: row.metadata },
                exactValues,
              ),
            );
            assertCondition(
              ledgerSoftReferences.length === fixtureLedgerIds.size &&
                ledgerSoftReferences.every(({ id }) =>
                  fixtureLedgerIds.has(id),
                ),
              "A retained ledger row soft-references an abandoned fixture identity.",
            );
            assertCondition(
              allStoreOutbox.length ===
                operationalBaselineSnapshot.loyaltyOutboxJobs.length &&
                canonicalEqual(
                  allStoreOutbox,
                  operationalBaselineSnapshot.loyaltyOutboxJobs,
                ) &&
                !allStoreOutbox.some((row) =>
                  jsonContainsExactValue(row.payload, exactValues),
                ) &&
                !allStoreReconciliation.some((row) =>
                  jsonContainsExactValue(
                    { externalKey: row.externalKey, details: row.details },
                    exactValues,
                  ),
                ) &&
                !allStoreVoucherCleanup.some((row) =>
                  jsonContainsExactValue(row.ownershipSnapshot, exactValues),
                ) &&
                !allProgramRules.some(
                  (row) =>
                    !temporaryRuleIds.has(row.id) &&
                    jsonContainsExactValue(row.eligibleTierIds, exactValues),
                ) &&
                !allProgramCampaigns.some((row) =>
                  jsonContainsExactValue(row.eligibleTierIds, exactValues),
                ),
              "A retained soft-reference or outbox row points at an abandoned fixture.",
            );

            const currentProgram = await tx.weleticLoyaltyProgram.findUnique({
              where: { id: currentStore.loyaltyProgram.id },
            });
            assertCondition(
              currentProgram &&
                canonicalEqual(currentProgram.metadata, renewedMetadata),
              "The renewed lease changed inside the canonical cleanup transaction.",
            );
            maintenance.assertLoyaltyMaintenanceWriteAllowed({
              storeId: currentStore.id,
              metadata: currentProgram.metadata,
              permit: ownerPermit,
            });

            const ledgerDelete = await tx.weleticPointsLedgerEntry.deleteMany({
              where: {
                storeId: currentStore.id,
                id: { in: [...fixtureLedgerIds] },
              },
            });
            const accountDelete = await tx.weleticLoyaltyAccount.deleteMany({
              where: {
                storeId: currentStore.id,
                id: { in: [...fixtureAccountIds] },
              },
            });
            const shopperDelete = await tx.weleticShopper.deleteMany({
              where: {
                storeId: currentStore.id,
                id: { in: [...fixtureShopperIds] },
              },
            });
            assertCondition(
              ledgerDelete.count === fixtureLedgerIds.size &&
                accountDelete.count === fixtureAccountIds.size &&
                shopperDelete.count === fixtureShopperIds.size,
              "The exact local fixture graph was not deleted atomically.",
            );

            await tx.weleticLoyaltyProgram.update({
              where: { id: currentStore.loyaltyProgram.id },
              data: baselineProgramUpdateData(
                baselineStore.loyaltyProgram as unknown as JsonRecord,
                renewedMetadata,
              ),
            });
            const referralRuleDelete =
              await tx.weleticLoyaltyReferralRule.deleteMany({
                where: {
                  programId: currentStore.loyaltyProgram.id,
                  id: { in: [...temporaryReferralRuleIds] },
                },
              });
            const earningRuleDelete =
              await tx.weleticLoyaltyEarningRule.deleteMany({
                where: {
                  programId: currentStore.loyaltyProgram.id,
                  id: { in: [...temporaryRuleIds] },
                },
              });
            const tierDelete = await tx.weleticLoyaltyTier.deleteMany({
              where: {
                programId: currentStore.loyaltyProgram.id,
                id: { in: [...temporaryTierIds] },
              },
            });
            const rewardDelete = await tx.weleticRewardDefinition.deleteMany({
              where: {
                storeId: currentStore.id,
                id: { in: [...temporaryRewardIds] },
              },
            });
            assertCondition(
              referralRuleDelete.count === temporaryReferralRuleIds.size &&
                earningRuleDelete.count === temporaryRuleIds.size &&
                tierDelete.count === temporaryTierIds.size &&
                rewardDelete.count === temporaryRewardIds.size,
              "The exact temporary definition set was not deleted atomically.",
            );
            await policyRevision.publishLoyaltyEarnPolicyRevision({
              tx,
              storeId: currentStore.id,
              programId: currentStore.loyaltyProgram.id,
              reason: "a1_abandoned_recovery_policy_restored",
            });
            return {
              localRows:
                ledgerDelete.count + accountDelete.count + shopperDelete.count,
              definitions:
                referralRuleDelete.count +
                earningRuleDelete.count +
                tierDelete.count +
                rewardDelete.count,
            };
          },
        });
        mutation.localRowsDeleted = deleted.localRows;
        mutation.temporaryDefinitionsDeleted = deleted.definitions;
        recoveryState.phase = "local_cleanup_complete";
        checkpointAbandonedRecoveryState({
          capsule: recoveryCapsule,
          state: recoveryState,
          checkpoint: "local-cleanup-complete",
          forbiddenValues: [
            accessToken,
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
        return {
          localRowsDeleted: deleted.localRows,
          temporaryDefinitionsDeleted: deleted.definitions,
          programBusinessRestored: true,
        };
      },
    );

    await check(
      "Two-pass zero-residue and baseline-outbox verification",
      async () => {
        for (let pass = 0; pass < 2; pass += 1) {
          const verificationSnapshot =
            await loadAbandonedBasicLifecycleFamilySnapshot({
              client: prisma,
              storeId: currentStore.id,
              workspaceId: currentStore.projectId,
              platformProgramId: currentStore.programId,
              loyaltyProgramId: currentStore.loyaltyProgram.id,
              shopDomain: options.storeDomain,
              fixtureCustomerNumericIds: exactRemoteCustomers.map(
                ({ numericId }) => numericId,
              ),
            });
          assertAbandonedBasicLifecycleFamilyDiff({
            baseline: operationalBaselineSnapshot,
            current: verificationSnapshot,
            allowedExtraIds: { shopifyWebhookEvents: retainedAuditIds },
          });
          assertCondition(
            canonicalEqual(
              verificationSnapshot.loyaltyOutboxJobs,
              operationalBaselineSnapshot.loyaltyOutboxJobs,
            ),
            "The baseline outbox changed during zero-residue verification.",
          );
          const program = await prisma.weleticLoyaltyProgram.findUnique({
            where: { id: currentStore.loyaltyProgram.id },
          });
          assertCondition(
            program,
            "The loyalty program disappeared during recovery.",
          );
          if (recoveryState.phase === "lease_released") {
            assertCondition(
              programEqualsBaselineExceptRevisionAudit(
                baselineStore.loyaltyProgram as unknown as JsonRecord,
                program as unknown as JsonRecord,
              ),
              "The released program changed during zero-residue verification.",
            );
          } else {
            assertCondition(
              canonicalEqual(program.metadata, renewedMetadata),
              "The renewed lease changed during zero-residue verification.",
            );
          }
          assertProgramBusinessEqualsBaseline(
            baselineStore.loyaltyProgram as unknown as JsonRecord,
            program as unknown as JsonRecord,
          );
          if (recoveryState.phase !== "lease_released") {
            assertCondition(
              ownerPermit,
              "The recovery owner permit is unavailable.",
            );
            maintenance.assertLoyaltyMaintenanceBaselineMetadata({
              baselineMetadata: baselineStore.loyaltyProgram.metadata,
              leaseMetadata: program.metadata,
            });
            maintenance.assertLoyaltyMaintenanceWriteAllowed({
              storeId: currentStore.id,
              metadata: program.metadata,
              permit: ownerPermit,
            });
          }
          for (const customer of exactRemoteCustomers) {
            const remote = await shopify.shopifyAdminGraphqlRequest<{
              customer: { id: string } | null;
            }>({
              shopDomain: options.storeDomain,
              accessToken,
              query: `query WeleticAbandonedA1ZeroResidueRemote($id: ID!) {
              customer(id: $id) { id }
            }`,
              variables: { id: customer.id },
            });
            assertCondition(
              !remote.customer,
              "An exact remote fixture remains during zero-residue verification.",
            );
          }
          for (const queryValue of [
            `tag:${runMarker}`,
            ...FIXTURE_ROLES.map(
              (role) => `email:${runMarker}-${role}@example.com`,
            ),
          ]) {
            const collisionSearch = await shopify.shopifyAdminGraphqlRequest<{
              customers: {
                nodes: Array<{ id: string }>;
                pageInfo: { hasNextPage: boolean };
              };
            }>({
              shopDomain: options.storeDomain,
              accessToken,
              query: `query WeleticAbandonedA1ZeroResidueOwnership($query: String!) {
                  customers(first: 50, query: $query) {
                    nodes { id }
                    pageInfo { hasNextPage }
                  }
                }`,
              variables: { query: queryValue },
            });
            assertCondition(
              !collisionSearch.customers.pageInfo.hasNextPage &&
                collisionSearch.customers.nodes.length === 0,
              "A lease-identity Shopify customer remains during zero-residue verification.",
            );
          }
        }
        if (recoveryState.phase !== "lease_released") {
          recoveryState.phase = "zero_residue_verified";
          checkpointAbandonedRecoveryState({
            capsule: recoveryCapsule,
            state: recoveryState,
            checkpoint: "zero-residue-verified",
            forbiddenValues: [
              accessToken,
              options.baselineDatabaseUrl,
              process.env.DATABASE_URL,
            ],
          });
        }
        return {
          zeroResiduePasses: 2,
          retainedRegisteredAuditRows: retainedAuditIds.size,
          baselineOutboxUnchanged: true,
        };
      },
    );

    await check(
      "Atomic maintenance release and exact program baseline",
      async () => {
        if (recoveryState.phase === "lease_released") {
          mutation.maintenanceLeaseReleased = true;
          return { maintenanceLeaseReleased: true, exactProgramBaseline: true };
        }
        const releasePermit = ownerPermit;
        assertCondition(
          recoveryState.phase === "zero_residue_verified" && releasePermit,
          "Maintenance release requires the journaled zero-residue proof.",
        );
        await merchantFence.withActiveStoreLoyaltyMutation({
          storeId: currentStore.id,
          action: "a1_abandoned_recovery_release",
          expectedInstallationGeneration: currentStore.installationGeneration,
          loyaltyMaintenancePermit: releasePermit,
          operation: async (tx) => {
            const program = await tx.weleticLoyaltyProgram.findUnique({
              where: { id: currentStore.loyaltyProgram.id },
            });
            assertCondition(
              program && canonicalEqual(program.metadata, renewedMetadata),
              "The renewed lease changed immediately before release.",
            );
            assertProgramBusinessEqualsBaseline(
              baselineStore.loyaltyProgram as unknown as JsonRecord,
              program as unknown as JsonRecord,
            );
            await policyRevision.publishLoyaltyEarnPolicyRevision({
              tx,
              storeId: currentStore.id,
              programId: currentStore.loyaltyProgram.id,
              reason: "a1_abandoned_recovery_release_policy_verified",
            });
            const restoredMetadata =
              maintenance.removeLoyaltyMaintenanceLeaseMetadata({
                existingMetadata: program.metadata,
                permit: releasePermit,
              });
            await tx.weleticLoyaltyProgram.update({
              where: { id: currentStore.loyaltyProgram.id },
              data: baselineProgramUpdateData(
                baselineStore.loyaltyProgram as unknown as JsonRecord,
                restoredMetadata,
                baselineStore.loyaltyProgram.updatedAt,
              ),
            });
          },
        });
        mutation.maintenanceLeaseReleased = true;
        const finalProgram = await prisma.weleticLoyaltyProgram.findUnique({
          where: { id: currentStore.loyaltyProgram.id },
        });
        assertCondition(
          finalProgram &&
            programEqualsBaselineExceptRevisionAudit(
              baselineStore.loyaltyProgram as unknown as JsonRecord,
              finalProgram as unknown as JsonRecord,
            ) &&
            maintenance.readLoyaltyMaintenanceLease(finalProgram.metadata) ===
              null,
          "The released live loyalty program does not equal the recovered baseline exactly.",
        );
        recoveryState.phase = "lease_released";
        checkpointAbandonedRecoveryState({
          capsule: recoveryCapsule,
          state: recoveryState,
          checkpoint: "maintenance-lease-released",
          forbiddenValues: [
            accessToken,
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
        return { maintenanceLeaseReleased: true, exactProgramBaseline: true };
      },
    );

    const currentCapsule =
      readBasicLifecycleRecoveryCapsuleFile<AbandonedBasicLifecycleRecoveryState>(
        options.recoveryStatePath,
        assertAbandonedBasicLifecycleRecoveryState,
      );
    const capsuleSha256BeforeBinding =
      currentCapsule.reportBinding?.capsuleSha256BeforeBinding ??
      recoveryCapsule.sha256();
    if (fs.existsSync(options.reportPath)) {
      const existingReport = readExistingPassedRecoveryReport({
        reportPath: options.reportPath,
        sourceSha256,
        capsuleSha256: capsuleSha256BeforeBinding,
        recoveryState,
      });
      const reportSha256 = sha256BasicLifecycleFile(options.reportPath);
      if (currentCapsule.reportBinding) {
        assertCondition(
          currentCapsule.reportBinding.absolutePath ===
            path.normalize(path.resolve(options.reportPath)) &&
            currentCapsule.reportBinding.reportSha256 === reportSha256,
          "The bound recovery report changed before private-state removal.",
        );
      } else {
        recoveryCapsule.bindReport({
          state: recoveryState,
          reportPath: path.resolve(options.reportPath),
          reportSha256,
          capsuleSha256BeforeBinding,
          forbiddenValues: [
            accessToken,
            options.baselineDatabaseUrl,
            process.env.DATABASE_URL,
          ],
        });
      }
      recoveryCapsule.secureUnlink();
      return existingReport;
    }

    const report = {
      version: REPORT_VERSION,
      kind: "abandoned_a1_recovery",
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      overallStatus: "PASSED",
      sourceReport: {
        version: sourceReport.version,
        sha256: sourceSha256,
        preserved: true,
      },
      checks,
      mutation: { ...mutation },
      recoveryCapsule: { sha256: capsuleSha256BeforeBinding },
    } satisfies RecoveryReport;
    writeAbandonedBasicLifecycleRecoveryReport(options.reportPath, report);
    const reportSha256 = sha256BasicLifecycleFile(options.reportPath);
    recoveryCapsule.bindReport({
      state: recoveryState,
      reportPath: path.resolve(options.reportPath),
      reportSha256,
      capsuleSha256BeforeBinding,
      forbiddenValues: [
        accessToken,
        options.baselineDatabaseUrl,
        process.env.DATABASE_URL,
      ],
    });
    recoveryCapsule.secureUnlink();
    return report;
  } catch (error) {
    throw new AbandonedBasicLifecycleRecoveryFailure(
      redactRecoveryText(error, sensitive),
      startedAt.toISOString(),
      sourceReport.version,
      sourceSha256,
      checks,
      { ...mutation },
    );
  } finally {
    await Promise.allSettled([baseline.$disconnect(), prisma.$disconnect()]);
  }
}

async function main() {
  let options: AbandonedBasicLifecycleRecoveryOptions | undefined;
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  try {
    options = parseAbandonedBasicLifecycleRecoveryArgs(process.argv.slice(2));
    assertAbandonedBasicLifecycleRecoverySafety(options);
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    const report = await runRecoveryPreflight(options);
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    originalConsole.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    const sourcePath = options?.failedReportPath;
    const sourceBytes =
      sourcePath && fs.existsSync(sourcePath)
        ? fs.readFileSync(sourcePath)
        : Buffer.from("unavailable");
    const recoveryFailure =
      error instanceof AbandonedBasicLifecycleRecoveryFailure ? error : null;
    let recoveryCapsuleSha256: string | null = null;
    if (
      options?.recoveryStatePath &&
      fs.existsSync(options.recoveryStatePath)
    ) {
      try {
        recoveryCapsuleSha256 = sha256BasicLifecycleFile(
          options.recoveryStatePath,
        );
      } catch {
        // A malformed/tampered private journal remains in place for manual
        // investigation; its contents or path never enter the public report.
      }
    }
    const report: RecoveryReport = {
      version: REPORT_VERSION,
      kind: "abandoned_a1_recovery",
      startedAt: recoveryFailure?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      overallStatus: "FAILED",
      sourceReport: {
        version:
          recoveryFailure?.sourceReportVersion ?? LATEST_SOURCE_REPORT_VERSION,
        sha256:
          recoveryFailure?.sourceReportSha256 ??
          crypto.createHash("sha256").update(sourceBytes).digest("hex"),
        preserved: true,
      },
      checks: recoveryFailure?.checks.length
        ? recoveryFailure.checks
        : [
            {
              name: "Fail-closed abandoned-run recovery",
              status: "FAILED",
              durationMs: 0,
              reason: redactRecoveryText(error, [
                options?.storeDomain ?? "",
                options?.failedReportPath ?? "",
                options?.baselineDatabaseUrl ?? "",
                options?.reportPath ?? "",
                options?.recoveryStatePath ?? "",
              ]),
            },
          ],
      mutation: recoveryFailure?.mutation ?? {
        leaseTakenOver: false,
        remoteCustomersDeleted: 0,
        localRowsDeleted: 0,
        temporaryDefinitionsDeleted: 0,
        maintenanceLeaseReleased: false,
      },
      recoveryCapsule: recoveryCapsuleSha256
        ? { sha256: recoveryCapsuleSha256 }
        : null,
      hardBoundary:
        recoveryFailure?.message ??
        "Recovery stopped before takeover because exact baseline, ownership, or registered-ingress proof was incomplete.",
    };
    if (
      options?.reportPath &&
      !fs.existsSync(options.reportPath) &&
      !recoveryCapsuleSha256
    ) {
      writeAbandonedBasicLifecycleRecoveryReport(options.reportPath, report);
    }
    originalConsole.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("recover-abandoned-basic-lifecycle.ts")
) {
  void main();
}
