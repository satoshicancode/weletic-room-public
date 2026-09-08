import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN } from "@/lib/weletic/shopify/privacy-identity";

import {
  BasicLifecycleRecoveryCapsuleFile,
  parseBasicLifecycleRecoveryCapsule,
  sha256BasicLifecycleFile,
  writeExclusiveDurableArtifact,
} from "./basic-lifecycle-recovery-capsule";

const DEFAULT_WEBHOOK_TARGET =
  "http://127.0.0.1:8888/api/shopify/integration/webhook";
const STAGING_STORE_ALLOWLIST_ENV = "WELETIC_LOYALTY_STAGING_ALLOWLIST";
const STAGING_TARGET_ALLOWLIST_ENV = "WELETIC_LOYALTY_STAGING_WEBHOOK_TARGETS";
const DISPOSABLE_CUSTOMER_TAG = "weletic-a1-disposable";
const BASIC_LIFECYCLE_FIXTURE_ROLES = [
  "advocate",
  "referee",
  "lifecycle",
  "privacy",
] as const;
const BASIC_LIFECYCLE_MAINTENANCE_RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1_000;
const REPORT_VERSION = 4;
export const BASIC_LIFECYCLE_OUTBOX_RUN_HORIZON_MS = 2 * 60 * 60 * 1_000;

type CheckStatus = "PASSED" | "FAILED" | "DEFERRED";
export type BasicLifecycleEvidenceKind =
  | "LOCAL_SAFETY_GUARD"
  | "LIVE_CUSTOMER_PROVISIONING"
  | "SIGNED_SYNTHETIC_INGRESS"
  | "LIVE_SHOPIFY_READBACK"
  | "LOGICAL_TIME_WORKER"
  | "SYNTHETIC_LOCAL_EVIDENCE"
  | "SYNTHETIC_LOGICAL_TIME_EVIDENCE"
  | "COMPOSITE_STAGING_EVIDENCE"
  | "COMPOSITE_LOGICAL_TIME_EVIDENCE"
  | "LIVE_SHOPIFY_CLEANUP";

export interface BasicLifecycleEvidenceDescriptor {
  kind: BasicLifecycleEvidenceKind;
  liveShopify: boolean;
  authenticatedSynthetic: boolean;
  logicalTime: boolean;
  summary: string;
}

const BASIC_LIFECYCLE_EVIDENCE: Record<
  BasicLifecycleEvidenceKind,
  BasicLifecycleEvidenceDescriptor
> = {
  LOCAL_SAFETY_GUARD: {
    kind: "LOCAL_SAFETY_GUARD",
    liveShopify: false,
    authenticatedSynthetic: false,
    logicalTime: false,
    summary: "Local database, lock, tuple, and cleanup safety evidence.",
  },
  LIVE_CUSTOMER_PROVISIONING: {
    kind: "LIVE_CUSTOMER_PROVISIONING",
    liveShopify: true,
    authenticatedSynthetic: false,
    logicalTime: false,
    summary:
      "Live Shopify Admin customerCreate followed by observation of its locally provisioned account; the payload-free registered webhook audit row is retained and not claimed by the harness.",
  },
  SIGNED_SYNTHETIC_INGRESS: {
    kind: "SIGNED_SYNTHETIC_INGRESS",
    liveShopify: false,
    authenticatedSynthetic: true,
    logicalTime: false,
    summary:
      "Authenticated HMAC-signed synthetic staging webhook ingress; not a real checkout event.",
  },
  LIVE_SHOPIFY_READBACK: {
    kind: "LIVE_SHOPIFY_READBACK",
    liveShopify: true,
    authenticatedSynthetic: false,
    logicalTime: false,
    summary: "Live Shopify Admin metafield or discount API readback.",
  },
  LOGICAL_TIME_WORKER: {
    kind: "LOGICAL_TIME_WORKER",
    liveShopify: false,
    authenticatedSynthetic: false,
    logicalTime: true,
    summary:
      "Exact fixture-scoped local outbox execution with an explicit logical business clock.",
  },
  SYNTHETIC_LOCAL_EVIDENCE: {
    kind: "SYNTHETIC_LOCAL_EVIDENCE",
    liveShopify: false,
    authenticatedSynthetic: true,
    logicalTime: false,
    summary:
      "Authenticated HMAC-signed synthetic ingress plus local durable-state assertions; no live Shopify readback.",
  },
  SYNTHETIC_LOGICAL_TIME_EVIDENCE: {
    kind: "SYNTHETIC_LOGICAL_TIME_EVIDENCE",
    liveShopify: false,
    authenticatedSynthetic: true,
    logicalTime: true,
    summary:
      "Authenticated HMAC-signed synthetic ingress plus exact fixture-scoped logical-time worker execution; no live Shopify readback.",
  },
  COMPOSITE_STAGING_EVIDENCE: {
    kind: "COMPOSITE_STAGING_EVIDENCE",
    liveShopify: true,
    authenticatedSynthetic: true,
    logicalTime: false,
    summary:
      "Composite evidence combining signed synthetic ingress, local durable state, and live Shopify Admin API readback.",
  },
  COMPOSITE_LOGICAL_TIME_EVIDENCE: {
    kind: "COMPOSITE_LOGICAL_TIME_EVIDENCE",
    liveShopify: true,
    authenticatedSynthetic: true,
    logicalTime: true,
    summary:
      "Composite evidence combining signed synthetic ingress, local durable state, exact logical-time worker execution, and live Shopify Admin API readback.",
  },
  LIVE_SHOPIFY_CLEANUP: {
    kind: "LIVE_SHOPIFY_CLEANUP",
    liveShopify: true,
    authenticatedSynthetic: false,
    logicalTime: false,
    summary:
      "Live Shopify customer and discount deletion with Admin API absence readback, followed by exact local cleanup, two residue passes, retained-baseline verification, and maintenance-lease release as the final step.",
  },
};

export const BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS = {
  "A1 harness runtime availability": "LOCAL_SAFETY_GUARD",
  "Staging tenant, credential, and baseline safety": "LOCAL_SAFETY_GUARD",
  "Retained-customer exclusivity and drained outbox quiescence":
    "LOCAL_SAFETY_GUARD",
  "Temporary loyalty configuration installation": "LOCAL_SAFETY_GUARD",
  "Real Shopify customer creation and webhook provisioning":
    "LIVE_CUSTOMER_PROVISIONING",
  "Signup award idempotency": "SYNTHETIC_LOCAL_EVIDENCE",
  "Referral bind and first-order qualification": "SIGNED_SYNTHETIC_INGRESS",
  "Holding release and partial/full refund reversals":
    "SYNTHETIC_LOGICAL_TIME_EVIDENCE",
  "VIP transition and Shopify metafield readback": "COMPOSITE_STAGING_EVIDENCE",
  "Voucher use, cancellation, and logical-time expiry":
    "COMPOSITE_LOGICAL_TIME_EVIDENCE",
  "Birthday scheduling and logical-time award": "LOGICAL_TIME_WORKER",
  "Customer redaction and voucher privacy cleanup":
    "COMPOSITE_STAGING_EVIDENCE",
  "Restore configuration and remove disposable fixtures":
    "LIVE_SHOPIFY_CLEANUP",
} as const satisfies Record<string, BasicLifecycleEvidenceKind>;

export function getBasicLifecycleEvidenceProvenance() {
  return {
    live: [
      BASIC_LIFECYCLE_EVIDENCE.LIVE_CUSTOMER_PROVISIONING,
      BASIC_LIFECYCLE_EVIDENCE.LIVE_SHOPIFY_READBACK,
    ],
    synthetic: [BASIC_LIFECYCLE_EVIDENCE.SIGNED_SYNTHETIC_INGRESS],
    local: [
      BASIC_LIFECYCLE_EVIDENCE.LOCAL_SAFETY_GUARD,
      BASIC_LIFECYCLE_EVIDENCE.LOGICAL_TIME_WORKER,
    ],
    composite: [
      BASIC_LIFECYCLE_EVIDENCE.SYNTHETIC_LOCAL_EVIDENCE,
      BASIC_LIFECYCLE_EVIDENCE.SYNTHETIC_LOGICAL_TIME_EVIDENCE,
      BASIC_LIFECYCLE_EVIDENCE.COMPOSITE_STAGING_EVIDENCE,
      BASIC_LIFECYCLE_EVIDENCE.COMPOSITE_LOGICAL_TIME_EVIDENCE,
    ],
    cleanup: [BASIC_LIFECYCLE_EVIDENCE.LIVE_SHOPIFY_CLEANUP],
  };
}

export function serializeBasicLifecycleEvidenceProvenance() {
  return JSON.stringify(getBasicLifecycleEvidenceProvenance());
}

export interface BasicLifecycleCliOptions {
  confirmStaging: boolean;
  storeDomain: string;
  webhookTarget: string;
  reportPath?: string;
  recoveryStatePath?: string;
  resumeCleanupFromReportPath?: string;
}

export interface BasicLifecycleCheck {
  name: string;
  status: CheckStatus;
  durationMs: number;
  evidence: BasicLifecycleEvidenceDescriptor;
  reason?: string;
}

export interface BasicLifecycleReport {
  version: number;
  startedAt: string;
  completedAt: string;
  overallStatus: CheckStatus;
  summary: {
    total: number;
    passed: number;
    failed: number;
    deferred: number;
  };
  checks: BasicLifecycleCheck[];
  cleanup: BasicLifecycleCheck;
  evidenceProvenance: ReturnType<typeof getBasicLifecycleEvidenceProvenance>;
  intentionallySkipped: string[];
  intentionallyRetained: string[];
  recoveryCapsule: { sha256: string } | null;
  recoverySource?: { version: number; sha256: string };
}

const BASIC_LIFECYCLE_TEMPORARY_PROGRAM_CONFIG = {
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

export function isBasicLifecycleTemporaryProgramState(
  value: Record<string, unknown> | null | undefined,
  holdingPeriodDays = 0,
) {
  return Boolean(
    value &&
      value.status === "active" &&
      String(value.pointsPerCurrencyUnit) === "1" &&
      value.holdingPeriodDays === holdingPeriodDays &&
      value.pointsExpiryMonths === 0 &&
      value.killSwitchActive === false &&
      value.enableMetafieldsSync === true &&
      value.vipMilestoneMode === "points_earned" &&
      value.vipTimeframe === "lifetime" &&
      value.vipDowngradeGraceDays === 30 &&
      value.vipAutoDowngradeEnabled === true,
  );
}

export function isBasicLifecycleExactTemporaryProgramState(
  _baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  holdingPeriodDays = 0,
) {
  return isBasicLifecycleTemporaryProgramState(current, holdingPeriodDays);
}

export function classifyBasicLifecycleProgramUpdateReconciliation({
  baseline,
  current,
  previousHoldingPeriodDays,
  targetHoldingPeriodDays,
}: {
  baseline: Record<string, unknown>;
  current: Record<string, unknown>;
  previousHoldingPeriodDays: number;
  targetHoldingPeriodDays: number;
}) {
  if (
    isBasicLifecycleExactTemporaryProgramState(
      baseline,
      current,
      targetHoldingPeriodDays,
    )
  ) {
    return "committed" as const;
  }
  if (
    isBasicLifecycleExactTemporaryProgramState(
      baseline,
      current,
      previousHoldingPeriodDays,
    )
  ) {
    return "retry" as const;
  }
  return "drift" as const;
}

export function planBasicLifecycleHarnessOwnedProgramRestore(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  holdingPeriodCandidates: readonly number[] = [0, 1],
) {
  const restoreData: Record<string, unknown> = {};
  const alreadyBaselineKeys: string[] = [];
  const externallyDriftedKeys: string[] = [];
  for (const [key, defaultTemporaryValue] of Object.entries(
    BASIC_LIFECYCLE_TEMPORARY_PROGRAM_CONFIG,
  )) {
    const baselineValue = baseline[key];
    const currentValue = current[key];
    if (canonicalDigest(currentValue) === canonicalDigest(baselineValue)) {
      alreadyBaselineKeys.push(key);
      continue;
    }
    const temporaryValues =
      key === "holdingPeriodDays"
        ? holdingPeriodCandidates
        : [defaultTemporaryValue];
    if (
      temporaryValues.some(
        (temporaryValue) =>
          canonicalDigest(currentValue) === canonicalDigest(temporaryValue),
      )
    ) {
      restoreData[key] = baselineValue;
      continue;
    }
    externallyDriftedKeys.push(key);
  }
  return { restoreData, alreadyBaselineKeys, externallyDriftedKeys };
}

export function shouldAttemptBasicLifecycleProgramRestore({
  attempt,
  maxAttempts,
  nowMs,
  deadlineMs,
}: {
  attempt: number;
  maxAttempts: number;
  nowMs: number;
  deadlineMs: number;
}) {
  return attempt < maxAttempts && nowMs < deadlineMs;
}

export interface BasicLifecycleOutboxQuiescenceRow {
  status: string;
  scheduledFor: Date;
  nextRetryAt: Date | null;
  attempts: number;
}

function basicLifecycleOutboxEffectiveAt(
  row: BasicLifecycleOutboxQuiescenceRow,
) {
  return Math.max(
    row.scheduledFor.getTime(),
    row.nextRetryAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
}

export function evaluateBasicLifecycleOutboxQuiescence(
  rows: readonly BasicLifecycleOutboxQuiescenceRow[],
  now: Date,
  horizonMs = BASIC_LIFECYCLE_OUTBOX_RUN_HORIZON_MS,
) {
  assertCondition(
    Number.isFinite(horizonMs) && horizonMs > 0,
    "The outbox run horizon must be a positive finite duration.",
  );
  const nowMs = now.getTime();
  const horizonAtMs = nowMs + horizonMs;
  const processingCount = rows.filter(
    ({ status }) => status === "processing",
  ).length;
  const futurePendingCount = rows.filter(
    (row) =>
      row.status === "pending" &&
      row.attempts === 0 &&
      basicLifecycleOutboxEffectiveAt(row) > horizonAtMs,
  ).length;
  const activeCount = rows.filter((row) => {
    if (row.status === "processing") return false;
    if (row.status === "failed" || row.status === "dead_letter") return true;
    if (row.status === "pending") {
      return (
        row.attempts !== 0 ||
        basicLifecycleOutboxEffectiveAt(row) <= horizonAtMs
      );
    }
    return row.status !== "completed" && row.status !== "cancelled";
  }).length;
  const eligibleCount = rows.filter(
    (row) =>
      (row.status === "pending" || row.status === "failed") &&
      basicLifecycleOutboxEffectiveAt(row) <= nowMs,
  ).length;
  return {
    safe: processingCount === 0 && activeCount === 0,
    processingCount,
    activeCount,
    eligibleCount,
    futurePendingCount,
  };
}

export function assertBasicLifecycleOutboxQuiescence(
  rows: readonly BasicLifecycleOutboxQuiescenceRow[],
  now: Date,
) {
  const result = evaluateBasicLifecycleOutboxQuiescence(rows, now);
  if (!result.safe) {
    throw new Error(
      "The staging store has active, failed, dead-letter, or in-flight non-fixture outbox work.",
    );
  }
  return result;
}

export function captureBasicLifecycleOutboxBaselineDigests<
  Row extends { id: string },
>(rows: readonly Row[]) {
  const digests = new Map<string, string>();
  for (const row of rows) {
    assertCondition(
      !digests.has(row.id),
      "The baseline outbox snapshot contains a duplicate job identity.",
    );
    digests.set(row.id, canonicalDigest(row));
  }
  return digests;
}

export function assertBasicLifecycleOutboxBaselineUnchanged<
  Row extends { id: string },
>(baselineDigests: ReadonlyMap<string, string>, currentRows: readonly Row[]) {
  const currentDigests =
    captureBasicLifecycleOutboxBaselineDigests(currentRows);
  assertCondition(
    currentDigests.size === baselineDigests.size &&
      [...baselineDigests].every(
        ([id, digest]) => currentDigests.get(id) === digest,
      ),
    "A retained pre-run outbox job was changed or removed during validation.",
  );
  return { unchangedCount: baselineDigests.size };
}

export function evaluateBasicLifecycleFixtureOutboxCleanup(
  rows: ReadonlyArray<{ id: string; status: string }>,
) {
  return {
    cancellableIds: rows
      .filter(({ status }) => status === "pending" || status === "failed")
      .map(({ id }) => id),
    processingIds: rows
      .filter(({ status }) => status === "processing")
      .map(({ id }) => id),
  };
}

export function reconcileBasicLifecycleKnownOutboxIds({
  knownIds,
  existingRows,
  localFixtureCleanupComplete,
}: {
  knownIds: ReadonlySet<string>;
  existingRows: ReadonlyArray<{ id: string }>;
  localFixtureCleanupComplete: boolean;
}) {
  const existingIds = new Set(existingRows.map(({ id }) => id));
  const missingIds = [...knownIds].filter((id) => !existingIds.has(id));
  assertCondition(
    missingIds.length === 0 || localFixtureCleanupComplete,
    "A classified fixture outbox row disappeared before quiescence.",
  );
  return existingIds;
}

export function isBasicLifecycleExactFixtureOutboxJob({
  job,
  baselineJobIds,
  knownFixtureJobIds,
  exactFixtureValues,
  runMarker,
}: {
  job: { id: string; payload: unknown; idempotencyKey: string | null };
  baselineJobIds: ReadonlySet<string>;
  knownFixtureJobIds: ReadonlySet<string>;
  exactFixtureValues: ReadonlySet<string>;
  runMarker: string;
}) {
  if (baselineJobIds.has(job.id)) return false;
  return (
    knownFixtureJobIds.has(job.id) ||
    jsonContainsExactValue(job.payload, exactFixtureValues) ||
    job.idempotencyKey?.includes(runMarker) === true
  );
}

export function assertBasicLifecycleFixtureOutboxOwnership({
  storeId,
  job,
  baselineJobIds,
  fixtureAccountIds,
  fixtureShopperIds,
  fixtureOrderIds,
  fixtureOrderExternalIds,
  fixtureGrantIds,
  fixtureCustomerNumericIds,
  fixtureReferralIds,
  fixtureRedemptionIds,
  fixtureCleanupIds,
  fixtureRewardIds,
  fixtureDiscountCodes,
}: {
  storeId: string;
  job: {
    id: string;
    jobType: string;
    payload: unknown;
  };
  baselineJobIds: ReadonlySet<string>;
  fixtureAccountIds: ReadonlySet<string>;
  fixtureShopperIds: ReadonlySet<string>;
  fixtureOrderIds: ReadonlySet<string>;
  fixtureOrderExternalIds: ReadonlySet<string>;
  fixtureGrantIds: ReadonlySet<string>;
  fixtureCustomerNumericIds: ReadonlySet<string>;
  fixtureReferralIds: ReadonlySet<string>;
  fixtureRedemptionIds: ReadonlySet<string>;
  fixtureCleanupIds: ReadonlySet<string>;
  fixtureRewardIds: ReadonlySet<string>;
  fixtureDiscountCodes: ReadonlySet<string>;
}) {
  const payload = isJsonObject(job.payload) ? job.payload : null;
  const exactString = (field: string, values: ReadonlySet<string>) =>
    payload !== null &&
    typeof payload[field] === "string" &&
    values.has(payload[field] as string);
  const optionalExactString = (field: string, values: ReadonlySet<string>) =>
    payload !== null &&
    (!Object.prototype.hasOwnProperty.call(payload, field) ||
      payload[field] === undefined ||
      exactString(field, values));

  let exactFixtureOwnership = false;
  switch (job.jobType) {
    case "HOLDING_PERIOD_RELEASE":
      exactFixtureOwnership =
        exactString("accountId", fixtureAccountIds) &&
        exactString("shopperId", fixtureShopperIds) &&
        exactString("orderId", fixtureOrderIds) &&
        optionalExactString("grantId", fixtureGrantIds) &&
        optionalExactString("sourceOrderExternalId", fixtureOrderExternalIds);
      break;
    case "INACTIVITY_EXPIRY":
    case "TIER_REVIEW":
    case "BIRTHDAY_REWARD":
      exactFixtureOwnership = exactString("accountId", fixtureAccountIds);
      break;
    case "METAFIELD_SYNC":
      exactFixtureOwnership =
        exactString("accountId", fixtureAccountIds) &&
        optionalExactString("shopifyCustomerId", fixtureCustomerNumericIds);
      break;
    case "REDEMPTION_RECOVERY":
      exactFixtureOwnership =
        exactString("accountId", fixtureAccountIds) &&
        exactString("redemptionId", fixtureRedemptionIds) &&
        exactString("rewardDefinitionId", fixtureRewardIds) &&
        exactString("shopifyDiscountCode", fixtureDiscountCodes);
      break;
    case "REFERRAL_REWARD_PROVISION": {
      const side = payload?.side;
      const referralId = payload?.referralId;
      const qualificationOrderId = payload?.qualificationOrderId;
      const accountId = payload?.accountId;
      const rewardDefinitionId = payload?.rewardDefinitionId;
      const fingerprint =
        (side === "advocate" || side === "referee") &&
        typeof referralId === "string" &&
        typeof qualificationOrderId === "string" &&
        typeof accountId === "string" &&
        typeof rewardDefinitionId === "string"
          ? crypto
              .createHash("sha256")
              .update(
                JSON.stringify([
                  storeId,
                  referralId,
                  qualificationOrderId,
                  accountId,
                  rewardDefinitionId,
                  side,
                ]),
              )
              .digest("hex")
              .slice(0, 24)
              .toUpperCase()
          : null;
      const hasRewardSnapshot =
        payload !== null &&
        Object.prototype.hasOwnProperty.call(payload, "rewardSnapshot") &&
        payload.rewardSnapshot !== undefined;
      const rewardSnapshot = isJsonObject(payload?.rewardSnapshot)
        ? payload.rewardSnapshot
        : null;
      exactFixtureOwnership =
        exactString("referralId", fixtureReferralIds) &&
        exactString("qualificationOrderId", fixtureOrderIds) &&
        exactString("accountId", fixtureAccountIds) &&
        exactString("rewardDefinitionId", fixtureRewardIds) &&
        (!hasRewardSnapshot ||
          (rewardSnapshot !== null &&
            rewardSnapshot.rewardDefinitionId === rewardDefinitionId &&
            rewardSnapshot.ownershipFingerprint === fingerprint &&
            rewardSnapshot.discountCode === `WLR-${fingerprint}`));
      break;
    }
    case "VOUCHER_PRIVACY_CLEANUP":
      exactFixtureOwnership =
        exactString("cleanupId", fixtureCleanupIds) &&
        exactString("redemptionId", fixtureRedemptionIds) &&
        exactString("accountId", fixtureAccountIds);
      break;
  }

  assertCondition(
    !baselineJobIds.has(job.id) && exactFixtureOwnership,
    "An outbox row mixes retained or non-fixture identities with fixture data; it was not processed, cancelled, or deleted and the maintenance lease remains active.",
  );
}

export function getBasicLifecycleOutboxTupleCheckMode(
  stage: "before" | "poll" | "after",
) {
  return stage === "poll" ? ("database" as const) : ("live" as const);
}

export function advanceBasicLifecycleOutboxStablePasses({
  previousStablePasses,
  beforeCount,
  afterCount,
}: {
  previousStablePasses: number;
  beforeCount: number;
  afterCount: number;
}) {
  return beforeCount === afterCount ? previousStablePasses + 1 : 0;
}

export function assertBasicLifecycleFinalCleanupPrerequisites(input: {
  localFixtureCleanupComplete: boolean;
  fixtureOutboxQuiescedAfterLocalCleanup: boolean;
}) {
  assertCondition(
    input.localFixtureCleanupComplete &&
      input.fixtureOutboxQuiescedAfterLocalCleanup,
    "Final residue verification requires completed local cleanup and post-local outbox fixed-point deletion.",
  );
}

export function assertBasicLifecycleMaintenanceReleasePrerequisites(input: {
  maintenanceLeaseAcquired: boolean;
  programSnapshotRestored: boolean;
  localFixtureCleanupComplete: boolean;
  fixtureOutboxQuiescedAfterLocalCleanup: boolean;
  zeroResiduePasses: number;
  baselineOutboxVerified: boolean;
}) {
  assertCondition(
    input.maintenanceLeaseAcquired &&
      input.programSnapshotRestored &&
      input.localFixtureCleanupComplete &&
      input.fixtureOutboxQuiescedAfterLocalCleanup &&
      input.zeroResiduePasses >= 2 &&
      input.baselineOutboxVerified,
    "The staging maintenance lease remains active until program restoration, exact local cleanup, two residue passes, and retained-outbox verification all succeed.",
  );
}

export function assertBasicLifecycleAtomicReleaseAudit(input: {
  residueCounts: readonly number[];
  temporaryDefinitionReferenceCount: number;
  fixtureOutboxCount: number;
  fixtureWebhookCount: number;
}) {
  assertCondition(
    input.residueCounts.every((count) => count === 0) &&
      input.temporaryDefinitionReferenceCount === 0 &&
      input.fixtureOutboxCount === 0 &&
      input.fixtureWebhookCount === 0,
    "The atomic lease-release audit found fixture residue, a temporary-definition reference, or late fixture queue/ingress work; the maintenance lease remains active.",
  );
}

export function assertBasicLifecycleTemporaryDefinitionReferenceOwnership({
  fixtureAccountIds,
  references,
}: {
  fixtureAccountIds: ReadonlySet<string>;
  references: ReadonlyArray<{
    family: string;
    rowId: string;
    accountId: string | null;
    exactFixtureRow: boolean;
  }>;
}) {
  assertCondition(
    references.every(
      ({ accountId, exactFixtureRow }) =>
        exactFixtureRow &&
        accountId !== null &&
        fixtureAccountIds.has(accountId),
    ),
    "A retained or concurrent non-fixture row references temporary loyalty configuration; no temporary definition was deleted and the maintenance lease remains active.",
  );
}

export function assertBasicLifecycleExactDeleteCount({
  family,
  expected,
  actual,
}: {
  family: string;
  expected: number;
  actual: number;
}) {
  assertCondition(
    expected === actual,
    `Exact fixture deletion count changed for ${family}; cleanup was rolled back and the maintenance lease remains active.`,
  );
}

export function assertBasicLifecycleFxSnapshotOwnership({
  snapshotIds,
  baselineIds,
  snapshots,
  exactOrderIds,
  exactRefundIds,
}: {
  snapshotIds: ReadonlySet<string>;
  baselineIds: ReadonlySet<string>;
  snapshots: ReadonlyArray<{
    id: string;
    orderIds: readonly string[];
    refundIds: readonly string[];
    payoutQuoteCount: number;
  }>;
  exactOrderIds: ReadonlySet<string>;
  exactRefundIds: ReadonlySet<string>;
}) {
  assertCondition(
    [...snapshotIds].every((id) => !baselineIds.has(id)) &&
      snapshots.length === snapshotIds.size &&
      snapshots.every(
        (snapshot) =>
          snapshotIds.has(snapshot.id) &&
          snapshot.payoutQuoteCount === 0 &&
          snapshot.orderIds.every((id) => exactOrderIds.has(id)) &&
          snapshot.refundIds.every((id) => exactRefundIds.has(id)),
      ),
    "An FX snapshot is baseline, missing, or shared outside exact fixture orders/refunds; cleanup was stopped.",
  );
}

export function assertBasicLifecycleExactDiscountDeleted(
  _exactDiscountGid: string,
  exactReadback: { id: string } | null,
) {
  assertCondition(
    !exactReadback,
    "Shopify still exposes the exact fixture discount GID after deletion.",
  );
}

function canonicalizeBasicLifecycleDiscountCode(value: string) {
  return value.trim().toUpperCase();
}

export function assertBasicLifecycleCompletedVoucherCleanupOwnership({
  storeId,
  redemption,
  discountGid,
  expectedOwnershipFingerprint,
  cleanup,
  requestLinks,
  fixtureCleanupIds,
  fixtureRequestIds,
  remote,
}: {
  storeId: string;
  redemption: {
    id: string;
    accountId: string;
    rewardDefinitionId: string;
    shopifyDiscountCode: string;
  };
  discountGid: string;
  expectedOwnershipFingerprint: string;
  cleanup: {
    id: string;
    storeId: string;
    redemptionId: string;
    sourceRequestId: string | null;
    source: string;
    status: string;
    expectedDiscountCodeCanonical: string;
    expectedDiscountId: string | null;
    ownershipSnapshot: unknown;
    lastError: string | null;
    remoteVerifiedAt: Date | null;
    remoteUsageCount: number | null;
    remoteUsageObservedAt: Date | null;
    remoteDeactivatedAt: Date | null;
    remoteOutcome: string | null;
    completedAt: Date | null;
  } | null;
  requestLinks: ReadonlyArray<{
    storeId: string;
    requestId: string;
    cleanupId: string;
    request: {
      id: string;
      storeId: string;
      requestType: string;
      status: string;
      phase: string;
      completedAt: Date | null;
      payloadCiphertext: string | null;
    };
  }>;
  fixtureCleanupIds: ReadonlySet<string>;
  fixtureRequestIds: ReadonlySet<string>;
  remote: { id: string; code: string; title: string } | null;
}) {
  const snapshot = isJsonObject(cleanup?.ownershipSnapshot)
    ? cleanup.ownershipSnapshot
    : null;
  const expectedCode = canonicalizeBasicLifecycleDiscountCode(
    redemption.shopifyDiscountCode,
  );
  const linkedRequests = requestLinks.filter(
    (link) =>
      cleanup &&
      link.storeId === storeId &&
      link.cleanupId === cleanup.id &&
      fixtureRequestIds.has(link.requestId) &&
      link.request.id === link.requestId &&
      link.request.storeId === storeId &&
      link.request.requestType === "customer_redact" &&
      link.request.status === "completed" &&
      link.request.phase === "completed" &&
      link.request.completedAt !== null &&
      link.request.payloadCiphertext === null,
  );
  assertCondition(
    cleanup &&
      fixtureCleanupIds.has(cleanup.id) &&
      cleanup.storeId === storeId &&
      cleanup.redemptionId === redemption.id &&
      cleanup.source === "customer_redact" &&
      cleanup.sourceRequestId !== null &&
      fixtureRequestIds.has(cleanup.sourceRequestId) &&
      cleanup.status === "completed" &&
      cleanup.completedAt !== null &&
      cleanup.lastError === null &&
      cleanup.expectedDiscountCodeCanonical === expectedCode &&
      cleanup.expectedDiscountId === discountGid &&
      cleanup.remoteVerifiedAt !== null &&
      cleanup.remoteUsageCount === 0 &&
      cleanup.remoteUsageObservedAt !== null &&
      cleanup.remoteDeactivatedAt !== null &&
      cleanup.remoteOutcome === "deactivated" &&
      linkedRequests.length === 1 &&
      snapshot?.version === 1 &&
      (snapshot.kind === "generic" || snapshot.kind === "referral") &&
      snapshot.expectedCode === expectedCode &&
      typeof snapshot.expectedTitle === "string" &&
      snapshot.expectedTitle.length > 0 &&
      snapshot.ownershipFingerprint === expectedOwnershipFingerprint &&
      snapshot.captureError === null &&
      remote?.id === discountGid &&
      canonicalizeBasicLifecycleDiscountCode(remote.code) === expectedCode &&
      remote.title === snapshot.expectedTitle,
    "Refusing to delete a redacted Shopify discount without exact terminal cleanup ownership and live identity proof.",
  );
}

export function assertBasicLifecycleOwnedCustomerRedactRequest({
  storeId,
  request,
  fixtureRequestIds,
  fixtureWebhookIds,
}: {
  storeId: string;
  request: {
    id: string;
    storeId: string;
    requestType: string;
    webhookId: string;
  };
  fixtureRequestIds: ReadonlySet<string>;
  fixtureWebhookIds: ReadonlySet<string>;
}) {
  assertCondition(
    fixtureRequestIds.has(request.id) &&
      request.storeId === storeId &&
      request.requestType === "customer_redact" &&
      fixtureWebhookIds.has(request.webhookId),
    "Refusing to drain a customer-redact request without exact fixture ownership.",
  );
}

export function assertBasicLifecycleExactCustomerDeleted(
  _exactCustomerGid: string,
  exactReadback: { id: string } | null,
) {
  assertCondition(
    !exactReadback,
    "Shopify still exposes the exact disposable customer after customerDelete reported success.",
  );
}

export function assertBasicLifecycleFixtureCustomerProjection({
  storeId,
  customerId,
  expectedPseudonym,
  expectedIdentityKeyId,
  expectedCustomerDigest,
  now,
  shopper,
  account,
  tombstone,
  baselineShopperIds,
  baselineAccountIds,
  fixtureRequestIds,
  hasRedactionMetadata,
  metadataContainsFixtureIdentity,
}: {
  storeId: string;
  customerId: string;
  expectedPseudonym: string;
  expectedIdentityKeyId: string;
  expectedCustomerDigest: string;
  now: Date;
  shopper: {
    id: string;
    storeId: string;
    shopifyCustomerId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    locale: string | null;
    tags: unknown;
    segmentIds: unknown;
    acceptsMarketing: boolean;
  } | null;
  account: {
    id: string;
    storeId: string;
    shopperId: string;
    status: string;
    referralCode: string | null;
    referredById: string | null;
    lastQualifyingActivityAt: Date | null;
    nextExpiryDate: Date | null;
  } | null;
  tombstone: {
    storeId: string;
    shopperId: string | null;
    accountId: string | null;
    sourceRequestId: string | null;
    identityKind: string;
    identityKeyId: string;
    customerDigest: string;
    expiresAt: Date;
    sourceRequest: {
      id: string;
      storeId: string;
      requestType: string;
      status: string;
      phase: string;
      completedAt: Date | null;
      subjectKind: string | null;
      subjectKeyId: string | null;
      subjectDigest: string | null;
      payloadCiphertext: string | null;
    } | null;
  } | null;
  baselineShopperIds: ReadonlySet<string>;
  baselineAccountIds: ReadonlySet<string>;
  fixtureRequestIds: ReadonlySet<string>;
  hasRedactionMetadata: boolean;
  metadataContainsFixtureIdentity: boolean;
}) {
  assertCondition(
    shopper &&
      account &&
      shopper.storeId === storeId &&
      account.storeId === storeId &&
      account.shopperId === shopper.id &&
      !baselineShopperIds.has(shopper.id) &&
      !baselineAccountIds.has(account.id),
    "A disposable customer projection is missing, cross-tenant, or baseline-owned.",
  );
  if (shopper.shopifyCustomerId === customerId) {
    assertCondition(
      account.status === "active" && !hasRedactionMetadata && !tombstone,
      "An active disposable customer projection is not exactly raw, active, and untombstoned.",
    );
    return "active" as const;
  }
  assertCondition(
    shopper.shopifyCustomerId === expectedPseudonym &&
      account.status === "closed" &&
      account.referralCode === null &&
      account.referredById === null &&
      account.lastQualifyingActivityAt === null &&
      account.nextExpiryDate === null &&
      hasRedactionMetadata &&
      !metadataContainsFixtureIdentity &&
      shopper.firstName === "Redacted" &&
      shopper.lastName === "Customer" &&
      shopper.email === null &&
      shopper.phone === null &&
      shopper.locale === null &&
      shopper.tags === null &&
      shopper.segmentIds === null &&
      shopper.acceptsMarketing === false &&
      tombstone?.storeId === storeId &&
      tombstone.identityKind === "customer_id" &&
      tombstone.identityKeyId === expectedIdentityKeyId &&
      tombstone.customerDigest === expectedCustomerDigest &&
      tombstone.shopperId === shopper.id &&
      tombstone.accountId === account.id &&
      tombstone.expiresAt.getTime() > now.getTime() &&
      Boolean(
        tombstone.sourceRequestId &&
          fixtureRequestIds.has(tombstone.sourceRequestId),
      ) &&
      tombstone.sourceRequest?.requestType === "customer_redact" &&
      tombstone.sourceRequest.id === tombstone.sourceRequestId &&
      tombstone.sourceRequest.storeId === storeId &&
      tombstone.sourceRequest.status === "completed" &&
      tombstone.sourceRequest.phase === "completed" &&
      tombstone.sourceRequest.completedAt !== null &&
      tombstone.sourceRequest.subjectKind === null &&
      tombstone.sourceRequest.subjectKeyId === null &&
      tombstone.sourceRequest.subjectDigest === null &&
      tombstone.sourceRequest.payloadCiphertext === null,
    "A redacted disposable customer projection lacks its exact pseudonym, scrubbed closed owner, or linked fixture tombstone.",
  );
  return "redacted" as const;
}

export interface BasicLifecycleRunnableStep {
  name: string;
  run: () => Promise<void>;
}

export async function runBasicLifecycleCleanupSteps({
  steps,
  formatError = (error: unknown) => redactBasicLifecycleText(error),
}: {
  steps: readonly BasicLifecycleRunnableStep[];
  formatError?: (error: unknown) => string;
}) {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(`${step.name}: ${formatError(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Fixture cleanup had ${failures.length} failure(s): ${failures.join(" | ")}`,
    );
  }
}

export async function runBasicLifecycleLockedOrchestration({
  withLocks,
  phases,
  cleanup,
}: {
  withLocks: <T>(task: () => Promise<T>) => Promise<T>;
  phases: readonly BasicLifecycleRunnableStep[];
  cleanup: () => Promise<void>;
}) {
  return withLocks(async () => {
    let phaseError: unknown;
    for (const phase of phases) {
      try {
        await phase.run();
      } catch (error) {
        phaseError = error;
        break;
      }
    }
    let cleanupError: unknown;
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }
    return { phaseError, cleanupError };
  });
}

export async function runBasicLifecycleCustomerDeleteBarrier({
  waitForTerminalIngress,
  withCustomerLock,
  revalidateInsideLock,
  deleteAndConfirmInsideLock,
}: {
  waitForTerminalIngress: () => Promise<void>;
  withCustomerLock: <T>(task: () => Promise<T>) => Promise<T>;
  revalidateInsideLock: () => Promise<void>;
  deleteAndConfirmInsideLock: () => Promise<void>;
}) {
  await waitForTerminalIngress();
  return withCustomerLock(async () => {
    await revalidateInsideLock();
    await deleteAndConfirmInsideLock();
  });
}

export async function reconcileBasicLifecycleDisposableCustomerSearch({
  lookup,
  mode,
  runMarker,
  expectedEmail,
  wait = delay,
  pollMs = 500,
  maxAttempts = 20,
}: {
  lookup: () => Promise<
    Array<{ id: string; tags: string[]; email?: string | null }>
  >;
  mode: "unique" | "stable_set";
  runMarker: string;
  expectedEmail?: string;
  wait?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxAttempts?: number;
}) {
  let previousSignature: string | null = null;
  let stablePasses = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const nodes = (await lookup()).filter(
      (node) =>
        node.tags.includes(DISPOSABLE_CUSTOMER_TAG) &&
        node.tags.includes(runMarker) &&
        (!expectedEmail ||
          node.email?.trim().toLowerCase() ===
            expectedEmail.trim().toLowerCase()),
    );
    const uniqueIds = new Set(nodes.map(({ id }) => id));
    assertCondition(
      uniqueIds.size === nodes.length,
      "Disposable Shopify customer search returned a duplicate identity.",
    );
    if (mode === "unique") {
      assertCondition(
        nodes.length <= 1,
        "Disposable Shopify customer reconciliation returned multiple exact matches.",
      );
      if (nodes.length === 1) return nodes;
    } else {
      const signature = [...uniqueIds].sort().join("\n");
      stablePasses = signature === previousSignature ? stablePasses + 1 : 1;
      previousSignature = signature;
      if (nodes.length > 0 && stablePasses >= 2) return nodes;
      if (nodes.length === 0 && attempt + 1 === maxAttempts) return nodes;
    }
    if (attempt + 1 < maxAttempts) await wait(pollMs);
  }
  throw new Error(
    "Timed out reconciling an exact disposable Shopify customer after an unknown create outcome.",
  );
}

export function assertBasicLifecycleLocalCleanupPrerequisites(input: {
  customerIngressReconciled: boolean;
  outboxQuiescedForRemoteCleanup: boolean;
  outboxQuiescedForLocalCleanup: boolean;
  remoteDiscountCleanupComplete: boolean;
  remoteCustomerCleanupComplete: boolean;
  checkoutCacheCleanupComplete: boolean;
}) {
  assertCondition(
    Object.values(input).every(Boolean),
    "Local ownership proof is preserved because a remote, cache, or outbox cleanup prerequisite failed.",
  );
}

export function assertBasicLifecycleReferralCleanupOwnership({
  fixtureAccountIds,
  accountPointers,
  referrals,
}: {
  fixtureAccountIds: ReadonlySet<string>;
  accountPointers: ReadonlyArray<{
    id: string;
    referredById: string | null;
  }>;
  referrals: ReadonlyArray<{
    advocateAccountId: string;
    refereeAccountId: string;
  }>;
}) {
  assertCondition(
    accountPointers.length === fixtureAccountIds.size &&
      accountPointers.every(
        ({ id, referredById }) =>
          fixtureAccountIds.has(id) &&
          (!referredById || fixtureAccountIds.has(referredById)),
      ) &&
      referrals.every(
        ({ advocateAccountId, refereeAccountId }) =>
          fixtureAccountIds.has(advocateAccountId) &&
          fixtureAccountIds.has(refereeAccountId),
      ),
    "A retained account or cross-fixture referral touches the disposable referral tree; cleanup was stopped.",
  );
}

export function getBasicLifecycleReferralQualificationIdentity({
  referralId,
  commerceOrderId,
}: {
  referralId: string;
  commerceOrderId: string;
}) {
  return {
    qualifyingOrderId: commerceOrderId,
    advocateLedgerKey: `referral_advocate:${referralId}:${commerceOrderId}`,
    refereeLedgerKey: `referral_referee:${referralId}:${commerceOrderId}`,
  };
}

type Environment = Record<string, string | undefined>;

function normalizedShopDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function parseCsvAllowlist(value: string | undefined) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function parseBasicLifecycleArgs(
  args: string[],
): BasicLifecycleCliOptions {
  const result: BasicLifecycleCliOptions = {
    confirmStaging: false,
    storeDomain: "",
    webhookTarget: DEFAULT_WEBHOOK_TARGET,
  };

  for (const argument of args) {
    if (argument === "--confirm-staging") {
      result.confirmStaging = true;
      continue;
    }
    if (argument.startsWith("--store=")) {
      result.storeDomain = normalizedShopDomain(argument.slice(8));
      continue;
    }
    if (argument.startsWith("--target=")) {
      result.webhookTarget = argument.slice(9).trim();
      continue;
    }
    if (argument.startsWith("--report=")) {
      result.reportPath = argument.slice(9).trim();
      continue;
    }
    if (argument.startsWith("--recovery-state=")) {
      result.recoveryStatePath = argument.slice(17).trim();
      continue;
    }
    if (argument.startsWith("--resume-cleanup-from-report=")) {
      result.resumeCleanupFromReportPath = argument.slice(29).trim();
      continue;
    }
    throw new Error("Unsupported A1 lifecycle option.");
  }

  return result;
}

export function assertBasicLifecycleSafety(
  options: BasicLifecycleCliOptions,
  env: Environment = process.env,
) {
  if (!options.confirmStaging) {
    throw new Error(
      "Refusing Shopify mutations without the explicit --confirm-staging flag.",
    );
  }
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    throw new Error("The A1 lifecycle harness cannot run in production.");
  }

  const store = normalizedShopDomain(options.storeDomain);
  if (!store) {
    throw new Error(
      "The staging store must be supplied explicitly with --store and allowlisted in WELETIC_LOYALTY_STAGING_ALLOWLIST.",
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store)) {
    throw new Error(
      "The staging store must be a canonical myshopify.com domain.",
    );
  }
  const allowedStores = parseCsvAllowlist(env[STAGING_STORE_ALLOWLIST_ENV]);
  if (!allowedStores.has(store)) {
    throw new Error(
      `Refusing non-allowlisted Shopify store. Add it explicitly to ${STAGING_STORE_ALLOWLIST_ENV}.`,
    );
  }

  let target: URL;
  try {
    target = new URL(options.webhookTarget);
  } catch {
    throw new Error("The webhook target must be an absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) {
    throw new Error("The webhook target must use HTTP or HTTPS.");
  }
  if (target.username || target.password || target.search || target.hash) {
    throw new Error(
      "The webhook target cannot contain credentials, query parameters, or fragments.",
    );
  }
  const defaultTargetHosts = new Set(["127.0.0.1", "localhost"]);
  const explicitTargetOrigins = parseCsvAllowlist(
    env[STAGING_TARGET_ALLOWLIST_ENV],
  );
  const targetAllowed =
    defaultTargetHosts.has(target.hostname.toLowerCase()) ||
    explicitTargetOrigins.has(target.origin.toLowerCase());
  if (!targetAllowed) {
    throw new Error(
      `Refusing non-local webhook target. Add its origin explicitly to ${STAGING_TARGET_ALLOWLIST_ENV}.`,
    );
  }
  if (
    !defaultTargetHosts.has(target.hostname.toLowerCase()) &&
    target.protocol !== "https:"
  ) {
    throw new Error("Explicit non-local webhook targets must use HTTPS.");
  }
  if (target.pathname !== "/api/shopify/integration/webhook") {
    throw new Error(
      "The webhook target must be the exact Shopify integration webhook path.",
    );
  }
  if (options.reportPath && !options.reportPath.trim()) {
    throw new Error("The report path cannot be empty.");
  }
  if (
    !options.recoveryStatePath ||
    !path.isAbsolute(options.recoveryStatePath)
  ) {
    throw new Error(
      "Staging mutation runs require --recovery-state=<absolute path>.",
    );
  }
  if (options.resumeCleanupFromReportPath) {
    const sourceReportPath = path.resolve(options.resumeCleanupFromReportPath);
    assertCondition(
      path.isAbsolute(options.resumeCleanupFromReportPath) &&
        fs.statSync(sourceReportPath).isFile() &&
        fs.statSync(options.recoveryStatePath).isFile() &&
        Boolean(options.reportPath) &&
        path.resolve(options.reportPath!) !== sourceReportPath &&
        path.resolve(options.reportPath!) !==
          path.resolve(options.recoveryStatePath),
      "Cleanup recovery requires distinct explicit source-report, destination-report, and existing capsule files.",
    );
  }
}

/**
 * Last-line protection for console/report errors. Runtime values are also
 * registered and replaced exactly, so provider messages cannot disclose a
 * fixture identity even when their wording changes.
 */
export function redactBasicLifecycleText(
  value: unknown,
  sensitiveValues: Iterable<string> = [],
) {
  let text = value instanceof Error ? value.message : String(value);
  const exactValues = [...sensitiveValues]
    .filter((item) => item.length >= 3)
    .sort((left, right) => right.length - left.length);
  for (const item of exactValues) {
    text = text.split(item).join("[redacted]");
  }
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/gid:\/\/shopify\/Customer\/\d+/gi, "[redacted-customer]")
    .replace(/gid:\/\/shopify\/[A-Za-z]+\/\d+/g, "[redacted-shopify-id]")
    .replace(/\bshp(?:at|ss|ca)_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/\bw[a-z][a-z0-9]*_[A-Za-z0-9_-]+\b/gi, "[redacted-id]")
    .replace(/\b(?:WLA1|WL-|WLR-)[A-Z0-9-]{4,}\b/g, "[redacted-voucher]")
    .slice(0, 1_000);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalDigest(value: unknown) {
  const canonicalize = (item: unknown): unknown => {
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (item instanceof Date) return { $date: item.toISOString() };
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === "object") {
      if (
        "toJSON" in item &&
        typeof (item as { toJSON?: unknown }).toJSON === "function"
      ) {
        return canonicalize((item as { toJSON: () => unknown }).toJSON());
      }
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return item;
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "undefined")
    .digest("hex");
}

function jsonContainsExactValue(value: unknown, expected: ReadonlySet<string>) {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return expected.has(String(value));
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsExactValue(item, expected));
  }
  return Object.values(value).some((item) =>
    jsonContainsExactValue(item, expected),
  );
}

function numericCustomerId(gid: string) {
  const match = /^gid:\/\/shopify\/Customer\/(\d+)$/.exec(gid);
  if (!match)
    throw new Error("Shopify returned a malformed customer identity.");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      "Shopify customer identity exceeds the webhook safe range.",
    );
  }
  return value;
}

function uniqueNumericIdentity() {
  const random = crypto.randomBytes(6).readUIntBE(0, 6);
  return 700_000_000_000 + (random % 100_000_000_000);
}

function moneySet(amount: string, currency: string) {
  return {
    shop_money: { amount, currency_code: currency },
    presentment_money: { amount, currency_code: currency },
  };
}

function evidenceFor(kind: BasicLifecycleEvidenceKind) {
  return { ...BASIC_LIFECYCLE_EVIDENCE[kind] };
}

function evidenceForCheck(
  name: keyof typeof BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS,
) {
  return evidenceFor(BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[name]);
}

interface BasicLifecycleStoreTuple {
  storeId: string;
  shopDomain: string;
  workspaceId: string;
  platformProgramId: string;
  loyaltyProgramId: string;
  installationGeneration: string;
  complianceState: "active";
  currency: string;
  currencyVerifiedAt: Date;
}

export class HarnessState {
  readonly sensitive = new Set<string>();
  readonly remoteCustomerGids = new Set<string>();
  readonly baselineCustomerGids = new Set<string>();
  readonly baselineRuleIds = new Set<string>();
  readonly baselineTierIds = new Set<string>();
  readonly baselineReferralRuleIds = new Set<string>();
  readonly baselineRewardIds = new Set<string>();
  readonly baselineBonusCampaignIds = new Set<string>();
  readonly baselineRuleDigests = new Map<string, string>();
  readonly baselineTierDigests = new Map<string, string>();
  readonly baselineReferralRuleDigests = new Map<string, string>();
  readonly baselineRewardDigests = new Map<string, string>();
  readonly baselineBonusCampaignDigests = new Map<string, string>();
  readonly baselineFxRateSnapshotIds = new Set<string>();
  readonly baselineAccountTierById = new Map<
    string,
    {
      programId: string;
      shopperId: string;
      status: string;
      ledgerVersion: number;
      cachedPointsBalance: bigint;
      cachedPendingPoints: bigint;
      lifetimePointsEarned: bigint;
      lifetimePointsRedeemed: bigint;
      referralCount: number;
      referralPointsEarned: bigint;
      referralCode: string | null;
      referredById: string | null;
      currentTierId: string | null;
      tierExpiresAt: Date | null;
      tierSpendRolling12Months: bigint;
      tierPointsRolling12Months: bigint;
      lastQualifyingActivityAt: Date | null;
      nextExpiryDate: Date | null;
      metadata: unknown;
      enrolledAt: Date;
      createdAt: Date;
      updatedAt: Date;
    }
  >();
  readonly baselineShopperById = new Map<
    string,
    {
      shopifyCustomerId: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
      locale: string | null;
      tags: unknown;
      segmentIds: unknown;
      acceptsMarketing: boolean;
      ordersCount: number;
      totalSpent: bigint;
      createdAt: Date;
      updatedAt: Date;
    }
  >();
  readonly remoteDiscountGids = new Set<string>();
  readonly remoteDiscountCodesByGid = new Map<string, string>();
  readonly fixtureDiscountCodes = new Set<string>();
  readonly baselineLocalCustomerIds = new Set<string>();
  readonly fixtureCustomerEmails = new Set<string>();
  readonly uncertainFixtureCustomerEmails = new Set<string>();
  readonly fixtureCustomerNumericIds = new Set<string>();
  readonly fixtureCheckoutTokens = new Set<string>();
  readonly fixtureCheckoutCacheByToken = new Map<
    string,
    { customerId: string }
  >();
  readonly fixtureLocalIdentityByCustomerId = new Map<
    string,
    { shopperId: string; accountId: string }
  >();
  readonly retainedPrivacyFenceCustomerIds = new Set<string>();
  registeredCustomerCreateAuditCount = 0;
  baselineCustomerCreateAuditCount = 0;
  baselineCustomerCreateNonNullPayloadCount = 0;
  baselineCustomerCreateInvalidAuditCount = 0;
  readonly baselineCustomerCreateBodyDigests = new Set<string>();
  readonly registeredCustomerCreateAuditBodyDigests = new Set<string>();
  readonly registeredCustomerCreateAuditByCustomerGid = new Map<
    string,
    { webhookId: string; bodyDigest: string }
  >();
  readonly registeredCustomerCreateDuplicateWebhookIds = new Set<string>();
  retainedPrivacyFenceCount = 0;
  retainedPrivacyFencesTtlValid = false;
  fixtureOutboxQuiescedForRemoteCleanup = false;
  fixtureOutboxQuiescedForLocalCleanup = false;
  fixtureOutboxQuiescedAfterLocalCleanup = false;
  fixtureCustomerIngressReconciled = false;
  remoteDiscountCleanupComplete = false;
  remoteCustomerCleanupComplete = false;
  checkoutCacheCleanupComplete = false;
  localFixtureCleanupComplete = false;
  maintenanceLeaseAcquired = false;
  maintenanceLeaseReleased = false;
  maintenanceLeaseReleaseDispatched = false;
  maintenanceLeaseReleaseUncertain = false;
  zeroResiduePasses = 0;
  baselineOutboxVerified = false;
  baselineOutboxSnapshotCaptured = false;
  // Only harness-generated webhook IDs are owned and deletable. Shopify's
  // registered delivery rows are payload-free audit evidence and are never
  // inferred from a time window or deleted by this harness.
  readonly webhookIds = new Set<string>();
  readonly fixtureAccountIds = new Set<string>();
  readonly fixtureShopperIds = new Set<string>();
  readonly fixtureOrderIds = new Set<string>();
  readonly fixtureOrderExternalIds = new Set<string>();
  readonly fixtureGrantIds = new Set<string>();
  readonly fixtureRuleIds = new Set<string>();
  readonly fixtureReferralRuleIds = new Set<string>();
  readonly fixtureTierIds = new Set<string>();
  readonly fixtureRewardIds = new Set<string>();
  readonly fixtureReferralIds = new Set<string>();
  readonly fixtureRedemptionIds = new Set<string>();
  readonly baselineReconciliationIssueIds = new Set<string>();
  readonly fixtureReconciliationIssueIds = new Set<string>();
  readonly fixtureComplianceRequestIds = new Set<string>();
  readonly fixtureCustomerPrivacyTombstoneIds = new Set<string>();
  readonly fixtureShopPrivacyTombstoneIds = new Set<string>();
  readonly fixtureCommissionCalculationIds = new Set<string>();
  readonly fixtureCommissionIds = new Set<string>();
  readonly fixtureCleanupIds = new Set<string>();
  readonly baselineOutboxJobIds = new Set<string>();
  readonly baselineOutboxJobDigests = new Map<string, string>();
  readonly fixtureOutboxIds = new Set<string>();
  readonly fixtureFxRateSnapshotIds = new Set<string>();
  readonly checks: BasicLifecycleCheck[] = [];
  programSnapshot?: Record<string, unknown>;
  storeTuple?: BasicLifecycleStoreTuple;
  storeId?: string;
  programId?: string;
  workspaceId?: string;
  installationGeneration?: string | null;
  currency?: string;
  accessToken?: string;
  rewardFixtureName?: string;
  configMutated = false;
  programMutationDispatched = false;
  programMutationUncertain = false;
  readonly programOwnedFieldDriftKeys = new Set<string>();
  expectedTemporaryHoldingPeriodDays = 0;
  programBaselineUpdatedAt?: Date;
  lastHarnessProgramUpdatedAt?: Date;
  runMarker = `weletic-a1-${crypto.randomBytes(8).toString("hex")}`;
  maintenanceOwnerToken = crypto.randomBytes(32).toString("base64url");
  maintenancePermit?: import("@/lib/weletic/loyalty/maintenance-write-fence").LoyaltyMaintenancePermit;
  maintenanceLeaseMetadata?: import("@prisma/client").Prisma.JsonValue;
  activePhase?: string;
  activeCleanupStep?: string;
  private recoveryCapsule?: BasicLifecycleRecoveryCapsuleFile<BasicLifecycleRecoverySnapshot>;

  constructor(
    readonly options: BasicLifecycleCliOptions,
    readonly startedAt = new Date(),
  ) {
    this.sensitive.add(this.runMarker);
    this.sensitive.add(this.maintenanceOwnerToken);
    for (const role of BASIC_LIFECYCLE_FIXTURE_ROLES) {
      const email = `${this.runMarker}-${role}@example.com`;
      this.fixtureCustomerEmails.add(email);
      this.sensitive.add(email);
    }
  }

  registerSensitive(...values: Array<string | null | undefined>) {
    for (const value of values) {
      if (value) this.sensitive.add(String(value));
    }
  }

  safeError(error: unknown) {
    return redactBasicLifecycleText(error, this.sensitive);
  }

  private recoveryForbiddenValues() {
    return [
      this.accessToken,
      process.env.ENCRYPTION_KEY,
      process.env.SHOPIFY_WEBHOOK_SECRET,
      process.env.DATABASE_URL,
      process.env.DIRECT_URL,
    ];
  }

  initializeRecoveryCapsule(checkpoint: string) {
    assertCondition(
      this.options.recoveryStatePath,
      "The required recovery-state path is unavailable.",
    );
    assertCondition(
      !this.recoveryCapsule,
      "The recovery capsule was already initialized.",
    );
    const capsule =
      new BasicLifecycleRecoveryCapsuleFile<BasicLifecycleRecoverySnapshot>(
        this.options.recoveryStatePath,
      );
    capsule.create({
      state: createBasicLifecycleRecoverySnapshot(this),
      checkpoint,
      forbiddenValues: this.recoveryForbiddenValues(),
    });
    this.recoveryCapsule = capsule;
  }

  resumeRecoveryCapsule() {
    assertCondition(
      this.options.recoveryStatePath,
      "The required recovery-state path is unavailable.",
    );
    assertCondition(
      !this.recoveryCapsule,
      "The recovery capsule was already initialized.",
    );
    const capsule =
      new BasicLifecycleRecoveryCapsuleFile<BasicLifecycleRecoverySnapshot>(
        this.options.recoveryStatePath,
      );
    const loaded = capsule.load(assertBasicLifecycleRecoverySnapshot);
    assertCondition(
      loaded.reportBinding === null,
      "A report-bound lifecycle capsule cannot be resumed.",
    );
    Object.assign(this, loaded.state.harnessState);
    this.recoveryCapsule = capsule;
    this.sensitive.clear();
    const registerNested = (value: unknown, seen = new Set<object>()) => {
      if (typeof value === "string") {
        this.registerSensitive(value);
        return;
      }
      if (!value || typeof value !== "object" || value instanceof Date) return;
      if (seen.has(value)) return;
      seen.add(value);
      if (value instanceof Set) {
        for (const item of value) registerNested(item, seen);
      } else if (value instanceof Map) {
        for (const [key, item] of value) {
          registerNested(key, seen);
          registerNested(item, seen);
        }
      } else if (Array.isArray(value)) {
        for (const item of value) registerNested(item, seen);
      } else {
        for (const item of Object.values(value)) registerNested(item, seen);
      }
    };
    for (const field of [
      ...BASIC_LIFECYCLE_RECOVERY_SET_FIELDS,
      ...BASIC_LIFECYCLE_RECOVERY_MAP_FIELDS,
    ]) {
      registerNested(this[field]);
    }
    registerNested(this.runMarker);
    registerNested(this.maintenanceOwnerToken);
    registerNested(this.storeTuple);
    registerNested(this.storeId);
    registerNested(this.programId);
    registerNested(this.workspaceId);
    registerNested(this.installationGeneration);
    registerNested(this.rewardFixtureName);
    return loaded.state;
  }

  checkpointRecoveryState(checkpoint: string) {
    if (!this.recoveryCapsule) return;
    this.recoveryCapsule.checkpoint({
      state: createBasicLifecycleRecoverySnapshot(this),
      checkpoint,
      forbiddenValues: this.recoveryForbiddenValues(),
    });
  }

  recoveryCapsuleSha256() {
    return this.recoveryCapsule?.sha256() ?? null;
  }

  bindRecoveryCapsuleToReport({
    reportPath,
    reportSha256,
    capsuleSha256BeforeBinding,
  }: {
    reportPath: string;
    reportSha256: string;
    capsuleSha256BeforeBinding: string;
  }) {
    assertCondition(
      this.recoveryCapsule,
      "The recovery capsule is unavailable for report binding.",
    );
    this.recoveryCapsule.bindReport({
      state: createBasicLifecycleRecoverySnapshot(this),
      reportPath,
      reportSha256,
      capsuleSha256BeforeBinding,
      forbiddenValues: this.recoveryForbiddenValues(),
    });
  }

  securelyDeleteRecoveryCapsule() {
    assertCondition(
      this.recoveryCapsule,
      "The recovery capsule is unavailable for secure unlink.",
    );
    this.recoveryCapsule.secureUnlink();
    this.recoveryCapsule = undefined;
  }

  async check(
    name: string,
    task: () => Promise<void>,
    evidenceKind: BasicLifecycleEvidenceKind = "LOCAL_SAFETY_GUARD",
  ) {
    const started = Date.now();
    this.activePhase = name;
    this.checkpointRecoveryState(`check:${name}:before`);
    try {
      await task();
      this.checks.push({
        name,
        status: "PASSED",
        durationMs: Date.now() - started,
        evidence: evidenceFor(evidenceKind),
      });
      this.activePhase = undefined;
      this.checkpointRecoveryState(`check:${name}:passed`);
    } catch (error) {
      this.checks.push({
        name,
        status: "FAILED",
        durationMs: Date.now() - started,
        evidence: evidenceFor(evidenceKind),
        reason: this.safeError(error),
      });
      this.activePhase = undefined;
      this.checkpointRecoveryState(`check:${name}:failed`);
      throw error;
    }
  }

  defer(name: string, reason: string) {
    this.checks.push({
      name,
      status: "DEFERRED",
      durationMs: 0,
      evidence: evidenceFor("LOCAL_SAFETY_GUARD"),
      reason: this.safeError(reason),
    });
  }
}

const BASIC_LIFECYCLE_RECOVERY_SET_FIELDS = [
  "remoteCustomerGids",
  "baselineCustomerGids",
  "baselineRuleIds",
  "baselineTierIds",
  "baselineReferralRuleIds",
  "baselineRewardIds",
  "baselineBonusCampaignIds",
  "baselineFxRateSnapshotIds",
  "remoteDiscountGids",
  "fixtureDiscountCodes",
  "baselineLocalCustomerIds",
  "fixtureCustomerEmails",
  "uncertainFixtureCustomerEmails",
  "fixtureCustomerNumericIds",
  "fixtureCheckoutTokens",
  "retainedPrivacyFenceCustomerIds",
  "baselineCustomerCreateBodyDigests",
  "registeredCustomerCreateAuditBodyDigests",
  "registeredCustomerCreateDuplicateWebhookIds",
  "webhookIds",
  "fixtureAccountIds",
  "fixtureShopperIds",
  "fixtureOrderIds",
  "fixtureOrderExternalIds",
  "fixtureGrantIds",
  "fixtureRuleIds",
  "fixtureReferralRuleIds",
  "fixtureTierIds",
  "fixtureRewardIds",
  "fixtureReferralIds",
  "fixtureRedemptionIds",
  "baselineReconciliationIssueIds",
  "fixtureReconciliationIssueIds",
  "fixtureComplianceRequestIds",
  "fixtureCustomerPrivacyTombstoneIds",
  "fixtureShopPrivacyTombstoneIds",
  "fixtureCommissionCalculationIds",
  "fixtureCommissionIds",
  "fixtureCleanupIds",
  "baselineOutboxJobIds",
  "fixtureOutboxIds",
  "fixtureFxRateSnapshotIds",
  "programOwnedFieldDriftKeys",
] as const;

const BASIC_LIFECYCLE_RECOVERY_MAP_FIELDS = [
  "baselineRuleDigests",
  "baselineTierDigests",
  "baselineReferralRuleDigests",
  "baselineRewardDigests",
  "baselineBonusCampaignDigests",
  "baselineAccountTierById",
  "baselineShopperById",
  "remoteDiscountCodesByGid",
  "fixtureCheckoutCacheByToken",
  "fixtureLocalIdentityByCustomerId",
  "registeredCustomerCreateAuditByCustomerGid",
  "baselineOutboxJobDigests",
] as const;

const BASIC_LIFECYCLE_RECOVERY_BOOLEAN_FIELDS = [
  "retainedPrivacyFencesTtlValid",
  "fixtureOutboxQuiescedForRemoteCleanup",
  "fixtureOutboxQuiescedForLocalCleanup",
  "fixtureOutboxQuiescedAfterLocalCleanup",
  "fixtureCustomerIngressReconciled",
  "remoteDiscountCleanupComplete",
  "remoteCustomerCleanupComplete",
  "checkoutCacheCleanupComplete",
  "localFixtureCleanupComplete",
  "maintenanceLeaseAcquired",
  "maintenanceLeaseReleased",
  "maintenanceLeaseReleaseDispatched",
  "maintenanceLeaseReleaseUncertain",
  "baselineOutboxVerified",
  "baselineOutboxSnapshotCaptured",
  "configMutated",
  "programMutationDispatched",
  "programMutationUncertain",
] as const;

const BASIC_LIFECYCLE_RECOVERY_NUMBER_FIELDS = [
  "registeredCustomerCreateAuditCount",
  "baselineCustomerCreateAuditCount",
  "baselineCustomerCreateNonNullPayloadCount",
  "baselineCustomerCreateInvalidAuditCount",
  "retainedPrivacyFenceCount",
  "zeroResiduePasses",
  "expectedTemporaryHoldingPeriodDays",
] as const;

const BASIC_LIFECYCLE_RECOVERY_REQUIRED_STRING_FIELDS = [
  "runMarker",
  "maintenanceOwnerToken",
] as const;

const BASIC_LIFECYCLE_RECOVERY_OPTIONAL_STRING_FIELDS = [
  "storeId",
  "programId",
  "workspaceId",
  "installationGeneration",
  "currency",
  "rewardFixtureName",
  "activePhase",
  "activeCleanupStep",
] as const;

const BASIC_LIFECYCLE_RECOVERY_OPTIONAL_DATE_FIELDS = [
  "programBaselineUpdatedAt",
  "lastHarnessProgramUpdatedAt",
] as const;

const BASIC_LIFECYCLE_RECOVERY_OTHER_FIELDS = [
  "startedAt",
  "checks",
  "programSnapshot",
  "storeTuple",
  "maintenanceLeaseMetadata",
] as const;

export const BASIC_LIFECYCLE_RECOVERY_RUNTIME_ONLY_FIELDS = [
  "options",
  "sensitive",
  "accessToken",
  "maintenancePermit",
  "recoveryCapsule",
] as const;

const BASIC_LIFECYCLE_RECOVERY_STATE_FIELDS = [
  ...BASIC_LIFECYCLE_RECOVERY_SET_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_MAP_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_BOOLEAN_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_NUMBER_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_REQUIRED_STRING_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_OPTIONAL_STRING_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_OPTIONAL_DATE_FIELDS,
  ...BASIC_LIFECYCLE_RECOVERY_OTHER_FIELDS,
] as const;

type BasicLifecycleRecoveryStateField =
  (typeof BASIC_LIFECYCLE_RECOVERY_STATE_FIELDS)[number];

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function isBasicLifecycleAuthenticatedBodyDigest(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN.test(value)
  );
}

export type BasicLifecycleRecoveryHarnessState = Pick<
  HarnessState,
  BasicLifecycleRecoveryStateField
>;

export interface BasicLifecycleRecoverySnapshot {
  schemaVersion: 1;
  harnessState: BasicLifecycleRecoveryHarnessState;
}

function assertExactRecoveryKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  assertCondition(
    actual.length === required.length &&
      actual.every((key, index) => key === required[index]),
    `${label} has an unsupported or missing field.`,
  );
}

function isPlainRecoveryObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecoveryObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertCondition(isPlainRecoveryObject(value), `${label} must be an object.`);
  assertExactRecoveryKeys(value, expectedKeys, label);
}

function isRecoveryJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isRecoveryJsonValue(entry, ancestors));
    }
    return (
      isPlainRecoveryObject(value) &&
      Object.values(value).every((entry) =>
        isRecoveryJsonValue(entry, ancestors),
      )
    );
  } finally {
    ancestors.delete(value);
  }
}

function isNonEmptyRecoveryString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableDate(value: unknown): value is Date | null {
  return (
    value === null ||
    (value instanceof Date && Number.isFinite(value.getTime()))
  );
}

function assertRecoveryStoreTuple(value: unknown) {
  assertRecoveryObject(
    value,
    [
      "storeId",
      "shopDomain",
      "workspaceId",
      "platformProgramId",
      "loyaltyProgramId",
      "installationGeneration",
      "complianceState",
      "currency",
      "currencyVerifiedAt",
    ],
    "Recovery store tuple",
  );
  assertCondition(
    [
      value.storeId,
      value.workspaceId,
      value.platformProgramId,
      value.loyaltyProgramId,
      value.installationGeneration,
      value.currency,
    ].every(isNonEmptyRecoveryString) &&
      typeof value.shopDomain === "string" &&
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value.shopDomain) &&
      value.complianceState === "active" &&
      value.currencyVerifiedAt instanceof Date &&
      Number.isFinite(value.currencyVerifiedAt.getTime()),
    "Recovery store tuple is invalid.",
  );
}

const BASIC_LIFECYCLE_RECOVERY_PROGRAM_KEYS = [
  "name",
  "status",
  "pointNameSingular",
  "pointNamePlural",
  "pointsPerCurrencyUnit",
  "holdingPeriodDays",
  "pointsExpiryMonths",
  "killSwitchActive",
  "activatedAt",
  "disabledAt",
  "enableOnlineStoreLauncher",
  "enableCustomerAccountHub",
  "enableCheckoutExtension",
  "enableProductPointsWidget",
  "enableMetafieldsSync",
  "surfaceFlags",
  "vipMilestoneMode",
  "vipTimeframe",
  "vipDowngradeGraceDays",
  "vipAutoDowngradeEnabled",
  "branding",
  "metadata",
] as const;

function isRecoveryDecimal(value: unknown) {
  if (typeof value === "string") {
    return /^-?(?:\d+\.?\d*|\.\d+)$/.test(value);
  }
  if (!value || typeof value !== "object") return false;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON !== "function") return false;
  try {
    return isRecoveryDecimal(toJSON.call(value));
  } catch {
    return false;
  }
}

function assertRecoveryProgramSnapshot(value: unknown) {
  assertRecoveryObject(
    value,
    BASIC_LIFECYCLE_RECOVERY_PROGRAM_KEYS,
    "Recovery program snapshot",
  );
  const stringFields = [
    "name",
    "status",
    "pointNameSingular",
    "pointNamePlural",
    "vipMilestoneMode",
    "vipTimeframe",
  ] as const;
  const numberFields = [
    "holdingPeriodDays",
    "pointsExpiryMonths",
    "vipDowngradeGraceDays",
  ] as const;
  const booleanFields = [
    "killSwitchActive",
    "enableOnlineStoreLauncher",
    "enableCustomerAccountHub",
    "enableCheckoutExtension",
    "enableProductPointsWidget",
    "enableMetafieldsSync",
    "vipAutoDowngradeEnabled",
  ] as const;
  assertCondition(
    stringFields.every((field) => isNonEmptyRecoveryString(value[field])) &&
      numberFields.every((field) => isNonNegativeSafeInteger(value[field])) &&
      booleanFields.every((field) => typeof value[field] === "boolean") &&
      isRecoveryDecimal(value.pointsPerCurrencyUnit) &&
      isNullableDate(value.activatedAt) &&
      isNullableDate(value.disabledAt) &&
      isRecoveryJsonValue(value.surfaceFlags) &&
      isRecoveryJsonValue(value.branding) &&
      isRecoveryJsonValue(value.metadata),
    "Recovery program snapshot is invalid.",
  );
}

function assertRecoveryAccountSnapshot(value: unknown) {
  assertRecoveryObject(
    value,
    [
      "programId",
      "shopperId",
      "status",
      "ledgerVersion",
      "cachedPointsBalance",
      "cachedPendingPoints",
      "lifetimePointsEarned",
      "lifetimePointsRedeemed",
      "referralCount",
      "referralPointsEarned",
      "referralCode",
      "referredById",
      "currentTierId",
      "tierExpiresAt",
      "tierSpendRolling12Months",
      "tierPointsRolling12Months",
      "lastQualifyingActivityAt",
      "nextExpiryDate",
      "metadata",
      "enrolledAt",
      "createdAt",
      "updatedAt",
    ],
    "Recovery baseline account",
  );
  const bigintFields = [
    "cachedPointsBalance",
    "cachedPendingPoints",
    "lifetimePointsEarned",
    "lifetimePointsRedeemed",
    "referralPointsEarned",
    "tierSpendRolling12Months",
    "tierPointsRolling12Months",
  ] as const;
  assertCondition(
    [value.programId, value.shopperId, value.status].every(
      isNonEmptyRecoveryString,
    ) &&
      isNonNegativeSafeInteger(value.ledgerVersion) &&
      isNonNegativeSafeInteger(value.referralCount) &&
      bigintFields.every((field) => typeof value[field] === "bigint") &&
      isNullableString(value.referralCode) &&
      isNullableString(value.referredById) &&
      isNullableString(value.currentTierId) &&
      isNullableDate(value.tierExpiresAt) &&
      isNullableDate(value.lastQualifyingActivityAt) &&
      isNullableDate(value.nextExpiryDate) &&
      isRecoveryJsonValue(value.metadata) &&
      [value.enrolledAt, value.createdAt, value.updatedAt].every(
        (entry) => entry instanceof Date && Number.isFinite(entry.getTime()),
      ),
    "Recovery baseline account is invalid.",
  );
}

function assertRecoveryShopperSnapshot(value: unknown) {
  assertRecoveryObject(
    value,
    [
      "shopifyCustomerId",
      "firstName",
      "lastName",
      "email",
      "phone",
      "locale",
      "tags",
      "segmentIds",
      "acceptsMarketing",
      "ordersCount",
      "totalSpent",
      "createdAt",
      "updatedAt",
    ],
    "Recovery baseline shopper",
  );
  assertCondition(
    isNonEmptyRecoveryString(value.shopifyCustomerId) &&
      [
        value.firstName,
        value.lastName,
        value.email,
        value.phone,
        value.locale,
      ].every(isNullableString) &&
      isRecoveryJsonValue(value.tags) &&
      isRecoveryJsonValue(value.segmentIds) &&
      typeof value.acceptsMarketing === "boolean" &&
      isNonNegativeSafeInteger(value.ordersCount) &&
      typeof value.totalSpent === "bigint" &&
      [value.createdAt, value.updatedAt].every(
        (entry) => entry instanceof Date && Number.isFinite(entry.getTime()),
      ),
    "Recovery baseline shopper is invalid.",
  );
}

function assertRecoveryCheck(value: unknown) {
  assertCondition(
    isPlainRecoveryObject(value),
    "Recovery check must be an object.",
  );
  const hasReason = Object.prototype.hasOwnProperty.call(value, "reason");
  assertExactRecoveryKeys(
    value,
    hasReason
      ? ["name", "status", "durationMs", "evidence", "reason"]
      : ["name", "status", "durationMs", "evidence"],
    "Recovery check",
  );
  assertRecoveryObject(
    value.evidence,
    ["kind", "liveShopify", "authenticatedSynthetic", "logicalTime", "summary"],
    "Recovery check evidence",
  );
  assertCondition(
    isNonEmptyRecoveryString(value.name) &&
      new Set(["PASSED", "FAILED", "DEFERRED"]).has(String(value.status)) &&
      isNonNegativeSafeInteger(value.durationMs) &&
      (!hasReason || typeof value.reason === "string") &&
      Object.prototype.hasOwnProperty.call(
        BASIC_LIFECYCLE_EVIDENCE,
        String(value.evidence.kind),
      ) &&
      typeof value.evidence.liveShopify === "boolean" &&
      typeof value.evidence.authenticatedSynthetic === "boolean" &&
      typeof value.evidence.logicalTime === "boolean" &&
      isNonEmptyRecoveryString(value.evidence.summary),
    "Recovery check is invalid.",
  );
}

function assertRecoveryMaintenanceLeaseMetadata(value: unknown) {
  assertCondition(
    isPlainRecoveryObject(value) && isRecoveryJsonValue(value),
    "Recovery maintenance lease metadata must be a JSON object.",
  );
  const lease = value.__weleticLoyaltyMaintenanceLeaseV1;
  assertRecoveryObject(
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
    "Recovery maintenance lease",
  );
  const digests = [
    lease.baselineMetadataSha256,
    lease.fixtureDisposableTagSha256,
    lease.fixtureRunMarkerTagSha256,
    lease.ownerTokenSha256,
  ];
  assertCondition(
    typeof lease.acquiredAt === "string" &&
      typeof lease.recoveryAfter === "string" &&
      new Date(lease.acquiredAt).toISOString() === lease.acquiredAt &&
      new Date(lease.recoveryAfter).toISOString() === lease.recoveryAfter &&
      Date.parse(lease.recoveryAfter) > Date.parse(lease.acquiredAt) &&
      digests.every(
        (digest) => typeof digest === "string" && SHA256_PATTERN.test(digest),
      ) &&
      Array.isArray(lease.fixtureEmailSha256) &&
      lease.fixtureEmailSha256.length > 0 &&
      lease.fixtureEmailSha256.every(
        (digest) => typeof digest === "string" && SHA256_PATTERN.test(digest),
      ) &&
      new Set(lease.fixtureEmailSha256).size ===
        lease.fixtureEmailSha256.length,
    "Recovery maintenance lease is invalid.",
  );
  return lease;
}

function assertRecoveryMapValues(
  harnessState: BasicLifecycleRecoveryHarnessState,
) {
  const digestMaps = [
    harnessState.baselineRuleDigests,
    harnessState.baselineTierDigests,
    harnessState.baselineReferralRuleDigests,
    harnessState.baselineRewardDigests,
    harnessState.baselineBonusCampaignDigests,
    harnessState.baselineOutboxJobDigests,
  ];
  assertCondition(
    digestMaps.every((map) =>
      [...map.values()].every(
        (digest) => typeof digest === "string" && SHA256_PATTERN.test(digest),
      ),
    ),
    "Recovery digest map contains an invalid digest.",
  );
  assertCondition(
    [...harnessState.remoteDiscountCodesByGid.values()].every(
      isNonEmptyRecoveryString,
    ),
    "Recovery discount-code map is invalid.",
  );
  for (const snapshot of harnessState.baselineAccountTierById.values()) {
    assertRecoveryAccountSnapshot(snapshot);
  }
  for (const snapshot of harnessState.baselineShopperById.values()) {
    assertRecoveryShopperSnapshot(snapshot);
  }
  for (const cache of harnessState.fixtureCheckoutCacheByToken.values()) {
    assertRecoveryObject(cache, ["customerId"], "Recovery checkout cache");
    assertCondition(
      isNonEmptyRecoveryString(cache.customerId),
      "Recovery checkout cache is invalid.",
    );
  }
  for (const identity of harnessState.fixtureLocalIdentityByCustomerId.values()) {
    assertRecoveryObject(
      identity,
      ["shopperId", "accountId"],
      "Recovery local customer identity",
    );
    assertCondition(
      isNonEmptyRecoveryString(identity.shopperId) &&
        isNonEmptyRecoveryString(identity.accountId),
      "Recovery local customer identity is invalid.",
    );
  }
  for (const assignment of harnessState.registeredCustomerCreateAuditByCustomerGid.values()) {
    assertRecoveryObject(
      assignment,
      ["webhookId", "bodyDigest"],
      "Recovery customer-create audit assignment",
    );
    assertCondition(
      isNonEmptyRecoveryString(assignment.webhookId) &&
        isBasicLifecycleAuthenticatedBodyDigest(assignment.bodyDigest),
      "Recovery customer-create audit assignment is invalid.",
    );
  }
}

export function assertBasicLifecycleRecoverySnapshot(
  value: unknown,
): asserts value is BasicLifecycleRecoverySnapshot {
  assertCondition(isJsonObject(value), "Recovery snapshot must be an object.");
  assertExactRecoveryKeys(
    value,
    ["schemaVersion", "harnessState"],
    "Recovery snapshot",
  );
  assertCondition(
    value.schemaVersion === 1 && isJsonObject(value.harnessState),
    "Recovery snapshot schema is unsupported.",
  );
  const harnessState = value.harnessState;
  assertExactRecoveryKeys(
    harnessState,
    BASIC_LIFECYCLE_RECOVERY_STATE_FIELDS,
    "Recovery harness state",
  );
  for (const field of BASIC_LIFECYCLE_RECOVERY_SET_FIELDS) {
    const set = harnessState[field];
    assertCondition(
      set instanceof Set &&
        [...set].every((entry) => typeof entry === "string"),
      `Recovery field ${field} must be a string Set.`,
    );
  }
  for (const field of BASIC_LIFECYCLE_RECOVERY_MAP_FIELDS) {
    const map = harnessState[field];
    assertCondition(
      map instanceof Map &&
        [...map.keys()].every((key) => typeof key === "string"),
      `Recovery field ${field} must be a string-keyed Map.`,
    );
  }
  const typedHarnessState =
    harnessState as unknown as BasicLifecycleRecoveryHarnessState;
  assertRecoveryMapValues(typedHarnessState);
  for (const digestSet of [
    typedHarnessState.baselineCustomerCreateBodyDigests,
    typedHarnessState.registeredCustomerCreateAuditBodyDigests,
  ]) {
    assertCondition(
      [...digestSet].every(isBasicLifecycleAuthenticatedBodyDigest),
      "Recovery customer-create digest set is invalid.",
    );
  }
  for (const field of BASIC_LIFECYCLE_RECOVERY_BOOLEAN_FIELDS) {
    assertCondition(
      typeof harnessState[field] === "boolean",
      `Recovery field ${field} must be boolean.`,
    );
  }
  for (const field of BASIC_LIFECYCLE_RECOVERY_NUMBER_FIELDS) {
    const fieldValue = harnessState[field];
    assertCondition(
      typeof fieldValue === "number" &&
        Number.isSafeInteger(fieldValue) &&
        fieldValue >= 0,
      `Recovery field ${field} must be a non-negative safe integer.`,
    );
  }
  for (const field of BASIC_LIFECYCLE_RECOVERY_REQUIRED_STRING_FIELDS) {
    const fieldValue = harnessState[field];
    assertCondition(
      typeof fieldValue === "string" && fieldValue.length > 0,
      `Recovery field ${field} must be a non-empty string.`,
    );
  }
  for (const field of BASIC_LIFECYCLE_RECOVERY_OPTIONAL_STRING_FIELDS) {
    assertCondition(
      harnessState[field] === undefined ||
        isNonEmptyRecoveryString(harnessState[field]),
      `Recovery field ${field} must be a non-empty string or undefined.`,
    );
  }
  for (const field of BASIC_LIFECYCLE_RECOVERY_OPTIONAL_DATE_FIELDS) {
    const fieldValue = harnessState[field];
    assertCondition(
      fieldValue === undefined ||
        (fieldValue instanceof Date && Number.isFinite(fieldValue.getTime())),
      `Recovery field ${field} must be a Date or undefined.`,
    );
  }
  assertCondition(
    harnessState.startedAt instanceof Date &&
      Number.isFinite(harnessState.startedAt.getTime()) &&
      /^weletic-a1-[a-f0-9]{16}$/.test(typedHarnessState.runMarker) &&
      /^[A-Za-z0-9_-]{32,}$/.test(typedHarnessState.maintenanceOwnerToken) &&
      [
        typedHarnessState.storeId,
        typedHarnessState.programId,
        typedHarnessState.workspaceId,
        typedHarnessState.installationGeneration,
        typedHarnessState.currency,
        typedHarnessState.rewardFixtureName,
      ].every(isNonEmptyRecoveryString) &&
      typedHarnessState.programBaselineUpdatedAt instanceof Date &&
      Number.isFinite(typedHarnessState.programBaselineUpdatedAt.getTime()) &&
      Array.isArray(harnessState.checks),
    "Recovery snapshot has invalid structured state.",
  );
  for (const check of typedHarnessState.checks) assertRecoveryCheck(check);
  assertRecoveryProgramSnapshot(typedHarnessState.programSnapshot);
  assertRecoveryStoreTuple(typedHarnessState.storeTuple);
  const storeTuple = typedHarnessState.storeTuple!;
  assertCondition(
    storeTuple.storeId === typedHarnessState.storeId &&
      storeTuple.workspaceId === typedHarnessState.workspaceId &&
      storeTuple.loyaltyProgramId === typedHarnessState.programId &&
      storeTuple.installationGeneration ===
        typedHarnessState.installationGeneration &&
      storeTuple.currency === typedHarnessState.currency,
    "Recovery scalar identities do not match the exact store tuple.",
  );
  const expectedFixtureEmails = BASIC_LIFECYCLE_FIXTURE_ROLES.map(
    (role) => `${typedHarnessState.runMarker}-${role}@example.com`,
  ).sort();
  assertCondition(
    [...typedHarnessState.fixtureCustomerEmails].sort().join("\0") ===
      expectedFixtureEmails.join("\0") &&
      [...typedHarnessState.uncertainFixtureCustomerEmails].every((email) =>
        typedHarnessState.fixtureCustomerEmails.has(email),
      ),
    "Recovery fixture customer identities are invalid.",
  );
  if (typedHarnessState.maintenanceLeaseMetadata !== undefined) {
    const lease = assertRecoveryMaintenanceLeaseMetadata(
      typedHarnessState.maintenanceLeaseMetadata,
    );
    const digest = (entry: string) =>
      crypto.createHash("sha256").update(entry).digest("hex");
    assertCondition(
      lease.ownerTokenSha256 ===
        digest(typedHarnessState.maintenanceOwnerToken) &&
        lease.fixtureRunMarkerTagSha256 ===
          digest(typedHarnessState.runMarker) &&
        lease.fixtureDisposableTagSha256 === digest(DISPOSABLE_CUSTOMER_TAG) &&
        (lease.fixtureEmailSha256 as string[]).join("\0") ===
          expectedFixtureEmails
            .map((email) => digest(email))
            .sort()
            .join("\0"),
      "Recovery maintenance lease does not match its exact owner and fixtures.",
    );
  }
  assertCondition(
    !typedHarnessState.maintenanceLeaseAcquired ||
      typedHarnessState.maintenanceLeaseMetadata !== undefined,
    "An acquired recovery lease must include its exact metadata.",
  );
  assertCondition(
    !typedHarnessState.maintenanceLeaseReleased ||
      (typedHarnessState.maintenanceLeaseAcquired &&
        typedHarnessState.maintenanceLeaseReleaseDispatched &&
        !typedHarnessState.maintenanceLeaseReleaseUncertain),
    "A released recovery lease has invalid checkpoint state.",
  );
}

export function createBasicLifecycleRecoverySnapshot(
  state: HarnessState,
): BasicLifecycleRecoverySnapshot {
  const runtimeOnly = new Set<string>(
    BASIC_LIFECYCLE_RECOVERY_RUNTIME_ONLY_FIELDS,
  );
  const expected = new Set<string>(BASIC_LIFECYCLE_RECOVERY_STATE_FIELDS);
  const unexpected = Object.keys(state).filter(
    (field) => !runtimeOnly.has(field) && !expected.has(field),
  );
  assertCondition(
    unexpected.length === 0,
    `HarnessState added a field without a recovery classification: ${unexpected.join(", ")}`,
  );
  const harnessState = Object.fromEntries(
    BASIC_LIFECYCLE_RECOVERY_STATE_FIELDS.map((field) => [
      field,
      (state as unknown as Record<string, unknown>)[field],
    ]),
  ) as BasicLifecycleRecoveryHarnessState;
  const snapshot = { schemaVersion: 1 as const, harnessState };
  assertBasicLifecycleRecoverySnapshot(snapshot);
  return snapshot;
}

export function parseBasicLifecycleHarnessRecoveryCapsule(bytes: string) {
  return parseBasicLifecycleRecoveryCapsule<BasicLifecycleRecoverySnapshot>(
    bytes,
    assertBasicLifecycleRecoverySnapshot,
  );
}

interface FixtureCustomer {
  role: string;
  gid: string;
  numericId: number;
  email: string;
  accountId: string;
  shopperId: string;
}

interface FixtureOrder {
  orderId: number;
  lineIds: number[];
  totalMinorAmount: bigint;
  lineMinorAmounts: bigint[];
  payload: Record<string, unknown>;
}

function assertCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

async function loadRuntime() {
  const [
    prismaModule,
    discounts,
    simulator,
    ids,
    rewards,
    referrals,
    outbox,
    nonPurchaseEarn,
    complianceWorker,
    privacyCache,
    redemptionDiscountIdentity,
    merchantWriteFence,
    settlementLock,
    privacyIdentity,
    shopperPrivacy,
    money,
    earn,
    ledgerEntryPolicy,
    redisLock,
    maintenanceWriteFence,
    earnPolicyRevision,
  ] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/weletic/loyalty/shopify-discounts"),
    import("../dev/simulate-shopify-webhook"),
    import("@/lib/weletic/ids"),
    import("@/lib/weletic/loyalty/rewards"),
    import("@/lib/weletic/loyalty/referrals"),
    import("@/lib/weletic/loyalty/outbox"),
    import("@/lib/weletic/loyalty/non-purchase-earn"),
    import("@/lib/weletic/shopify/compliance-worker"),
    import("@/lib/weletic/shopify/privacy-cache"),
    import("@/lib/weletic/loyalty/redemption-discount-identity"),
    import("@/lib/weletic/loyalty/merchant-write-fence"),
    import("@/lib/weletic/shopify/customer-settlement-lock"),
    import("@/lib/weletic/shopify/privacy-identity"),
    import("@/lib/weletic/loyalty/shopper-privacy"),
    import("@/lib/weletic/money"),
    import("@/lib/weletic/loyalty/earn"),
    import("@/lib/weletic/loyalty/ledger-entry-policy"),
    import("@/lib/weletic/redis-lock"),
    import("@/lib/weletic/loyalty/maintenance-write-fence"),
    import("@/lib/weletic/loyalty/earn-policy-revision"),
  ]);
  return {
    prisma: prismaModule.prisma,
    ...discounts,
    dispatchShopifyWebhook: simulator.dispatchShopifyWebhook,
    createWeleticId: ids.createWeleticId,
    ...rewards,
    ...referrals,
    ...outbox,
    ...nonPurchaseEarn,
    processShopifyComplianceRequest:
      complianceWorker.processShopifyComplianceRequest,
    writeShopifyCheckoutCache: privacyCache.writeShopifyCheckoutCache,
    deleteExactIndexedShopifyCheckoutCache:
      privacyCache.deleteExactIndexedShopifyCheckoutCache,
    auditShopifyCustomerPrivacyFences:
      privacyCache.auditShopifyCustomerPrivacyFences,
    assertExpectedLoyaltyDiscountNode:
      redemptionDiscountIdentity.assertExpectedLoyaltyDiscountNode,
    getLoyaltyDiscountOwnershipFingerprint:
      redemptionDiscountIdentity.getLoyaltyDiscountOwnershipFingerprint,
    withActiveStoreLoyaltyMutation:
      merchantWriteFence.withActiveStoreLoyaltyMutation,
    shopifyCustomerSettlementLockKeys:
      settlementLock.shopifyCustomerSettlementLockKeys,
    withShopifyCustomerSettlementLocks:
      settlementLock.withShopifyCustomerSettlementLocks,
    SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS:
      settlementLock.SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
    withDistributedLock: redisLock.withDistributedLock,
    getShopifyCustomerPrivacyPseudonym:
      privacyIdentity.getShopifyCustomerPrivacyPseudonym,
    SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN:
      privacyIdentity.SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN,
    parseShopifyCustomerPrivacyPseudonym:
      privacyIdentity.parseShopifyCustomerPrivacyPseudonym,
    hasShopifyCustomerRedactionTombstone:
      shopperPrivacy.hasShopifyCustomerRedactionTombstone,
    decimalToMinorUnits: money.decimalToMinorUnits,
    minorUnitsToDecimal: money.minorUnitsToDecimal,
    calculateEligibleOrderPoints: earn.calculateEligibleOrderPoints,
    calculateRefundPointsReversal: earn.calculateRefundPointsReversal,
    GENUINE_EARN_ENTRY_TYPES: ledgerEntryPolicy.GENUINE_EARN_ENTRY_TYPES,
    ...maintenanceWriteFence,
    publishLoyaltyEarnPolicyRevision:
      earnPolicyRevision.publishLoyaltyEarnPolicyRevision,
  };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;

async function readBasicLifecycleStoreTuple(
  runtime: Runtime,
  state: HarnessState,
  db: any = runtime.prisma,
): Promise<BasicLifecycleStoreTuple> {
  const store = await db.weleticShopifyStore.findUnique({
    where: state.storeId
      ? { id: state.storeId }
      : { shopDomain: state.options.storeDomain },
    select: {
      id: true,
      shopDomain: true,
      projectId: true,
      programId: true,
      installationGeneration: true,
      complianceState: true,
      shopCurrency: true,
      currencyVerifiedAt: true,
      loyaltyProgram: { select: { id: true } },
    },
  });
  assertCondition(
    store?.loyaltyProgram &&
      store.complianceState === "active" &&
      store.installationGeneration &&
      store.currencyVerifiedAt,
    "The exact staging store tuple is no longer active and complete.",
  );
  state.registerSensitive(
    store.id,
    store.projectId,
    store.programId,
    store.loyaltyProgram.id,
    store.installationGeneration,
    store.currencyVerifiedAt.toISOString(),
  );
  return {
    storeId: store.id,
    shopDomain: normalizedShopDomain(store.shopDomain),
    workspaceId: store.projectId,
    platformProgramId: store.programId,
    loyaltyProgramId: store.loyaltyProgram.id,
    installationGeneration: store.installationGeneration,
    complianceState: "active",
    currency: store.shopCurrency.toUpperCase(),
    currencyVerifiedAt: store.currencyVerifiedAt,
  };
}

function storeTuplesMatch(
  expected: BasicLifecycleStoreTuple,
  current: BasicLifecycleStoreTuple,
) {
  return (
    expected.storeId === current.storeId &&
    expected.shopDomain === current.shopDomain &&
    expected.workspaceId === current.workspaceId &&
    expected.platformProgramId === current.platformProgramId &&
    expected.loyaltyProgramId === current.loyaltyProgramId &&
    expected.installationGeneration === current.installationGeneration &&
    expected.complianceState === current.complianceState &&
    expected.currency === current.currency &&
    expected.currencyVerifiedAt.getTime() ===
      current.currencyVerifiedAt.getTime()
  );
}

async function assertCurrentBasicLifecycleStoreTuple(
  runtime: Runtime,
  state: HarnessState,
  db?: any,
) {
  assertCondition(
    state.storeTuple,
    "The baseline staging store tuple was not captured.",
  );
  const current = await readBasicLifecycleStoreTuple(runtime, state, db);
  assertCondition(
    storeTuplesMatch(state.storeTuple, current),
    "The staging store tenant, program, installation, compliance, or currency tuple drifted.",
  );
  if (!db) {
    assertCondition(
      state.accessToken,
      "The live Shopify tuple cannot be verified without staging credentials.",
    );
    const live: {
      shop: { myshopifyDomain: string; currencyCode: string } | null;
    } = await runtime.shopifyAdminGraphqlRequest({
      shopDomain: state.options.storeDomain,
      accessToken: state.accessToken,
      query: `query WeleticA1LiveStoreTuple {
        shop { myshopifyDomain currencyCode }
      }`,
    });
    assertCondition(
      live.shop &&
        normalizedShopDomain(live.shop.myshopifyDomain) ===
          state.storeTuple.shopDomain &&
        live.shop.currencyCode.trim().toUpperCase() ===
          state.storeTuple.currency,
      "The live Shopify shop domain or currency drifted from the captured staging tuple.",
    );
  }
  return current;
}

async function withHarnessStoreMutation<T>(
  runtime: Runtime,
  state: HarnessState,
  action: string,
  operation: (tx: any) => Promise<T>,
  tupleVerification: "live" | "database" = "live",
) {
  assertCondition(
    state.storeId && state.installationGeneration,
    "The staging store mutation fence is unavailable.",
  );
  await assertCurrentBasicLifecycleStoreTuple(
    runtime,
    state,
    tupleVerification === "database" ? runtime.prisma : undefined,
  );
  return runtime.withActiveStoreLoyaltyMutation({
    storeId: state.storeId,
    action,
    expectedInstallationGeneration: state.installationGeneration,
    loyaltyMaintenancePermit: state.maintenancePermit,
    operation: async (tx: any) => {
      await assertCurrentBasicLifecycleStoreTuple(runtime, state, tx);
      return operation(tx);
    },
  });
}

async function readHarnessProgramState(runtime: Runtime, state: HarnessState) {
  assertCondition(
    state.programId,
    "The loyalty program identity is unavailable.",
  );
  const current = await runtime.prisma.weleticLoyaltyProgram.findUnique({
    where: { id: state.programId },
    select: {
      updatedAt: true,
      name: true,
      status: true,
      pointNameSingular: true,
      pointNamePlural: true,
      pointsPerCurrencyUnit: true,
      holdingPeriodDays: true,
      pointsExpiryMonths: true,
      killSwitchActive: true,
      activatedAt: true,
      disabledAt: true,
      enableOnlineStoreLauncher: true,
      enableCustomerAccountHub: true,
      enableCheckoutExtension: true,
      enableProductPointsWidget: true,
      enableMetafieldsSync: true,
      surfaceFlags: true,
      vipMilestoneMode: true,
      vipTimeframe: true,
      vipDowngradeGraceDays: true,
      vipAutoDowngradeEnabled: true,
      branding: true,
      metadata: true,
    },
  });
  assertCondition(
    current,
    "The loyalty program disappeared during validation.",
  );
  return current;
}

async function updateHarnessOwnedProgram(
  runtime: Runtime,
  state: HarnessState,
  action: string,
  data: Record<string, unknown>,
) {
  assertCondition(
    state.configMutated && state.programId && state.lastHarnessProgramUpdatedAt,
    "The harness does not own a mutable loyalty program version.",
  );
  const previousHoldingPeriodDays = state.expectedTemporaryHoldingPeriodDays;
  const targetHoldingPeriodDays =
    typeof data.holdingPeriodDays === "number"
      ? data.holdingPeriodDays
      : previousHoldingPeriodDays;
  state.programMutationDispatched = true;
  state.programMutationUncertain = true;
  state.expectedTemporaryHoldingPeriodDays = targetHoldingPeriodDays;
  state.checkpointRecoveryState(`${action}:before`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const expectedUpdatedAt = state.lastHarnessProgramUpdatedAt;
    try {
      const updated = await withHarnessStoreMutation(
        runtime,
        state,
        action,
        async (tx) => {
          const result = await tx.weleticLoyaltyProgram.updateMany({
            where: { id: state.programId!, updatedAt: expectedUpdatedAt },
            data,
          });
          assertCondition(
            result.count === 1,
            "The harness-owned loyalty program version drifted before its temporary update.",
          );
          await runtime.publishLoyaltyEarnPolicyRevision({
            tx,
            storeId: state.storeId!,
            programId: state.programId!,
            reason: action,
          });
          return tx.weleticLoyaltyProgram.findUniqueOrThrow({
            where: { id: state.programId! },
            select: { updatedAt: true },
          });
        },
      );
      state.lastHarnessProgramUpdatedAt = updated.updatedAt;
      state.programMutationUncertain = false;
      state.registerSensitive(updated.updatedAt.toISOString());
      state.checkpointRecoveryState(`${action}:committed`);
      return;
    } catch (error) {
      lastError = error;
      try {
        const current = await readHarnessProgramState(runtime, state);
        assertCondition(
          state.programSnapshot,
          "The harness program baseline is unavailable during update reconciliation.",
        );
        const outcome = classifyBasicLifecycleProgramUpdateReconciliation({
          baseline: state.programSnapshot,
          current,
          previousHoldingPeriodDays,
          targetHoldingPeriodDays,
        });
        assertCondition(
          outcome !== "drift",
          "The harness-owned loyalty program fields drifted during its temporary update.",
        );
        state.lastHarnessProgramUpdatedAt = current.updatedAt;
        state.registerSensitive(current.updatedAt.toISOString());
        if (outcome === "committed") {
          state.programMutationUncertain = false;
          state.checkpointRecoveryState(`${action}:reconciled-commit`);
          return;
        }
      } catch (reconciliationError) {
        // Preserve the dispatched/uncertain marker. Cleanup reconciles under
        // all retained-customer locks and never releases them while temporary
        // configuration ownership is uncertain.
        throw reconciliationError;
      }
    }
  }
  throw (
    lastError ?? new Error("The harness program update retry was exhausted.")
  );
}

async function withRetainedCustomerSettlementLocks<T>(
  runtime: Runtime,
  state: HarnessState,
  task: () => Promise<T>,
) {
  assertCondition(
    state.workspaceId && state.storeId,
    "The retained-customer settlement lock scope is unavailable.",
  );
  const lockKeys = Array.from(
    new Set(
      [...state.baselineLocalCustomerIds].flatMap((shopifyCustomerId) =>
        runtime.shopifyCustomerSettlementLockKeys({
          workspaceId: state.workspaceId!,
          storeId: state.storeId!,
          shopifyCustomerId,
        }),
      ),
    ),
  ).sort();
  state.registerSensitive(...lockKeys);
  const acquire = (index: number): Promise<T> =>
    index >= lockKeys.length
      ? task()
      : runtime.withDistributedLock({
          key: lockKeys[index],
          ttlSeconds: runtime.SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
          fn: () => acquire(index + 1),
        });
  return acquire(0);
}

async function assertStoreOutboxQuiescence(
  runtime: Runtime,
  state: HarnessState,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const now = new Date();
  const rows = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: state.storeId! },
  });
  state.baselineOutboxJobIds.clear();
  state.baselineOutboxJobDigests.clear();
  const baselineDigests = captureBasicLifecycleOutboxBaselineDigests(rows);
  for (const [id, digest] of baselineDigests) {
    state.baselineOutboxJobIds.add(id);
    state.baselineOutboxJobDigests.set(id, digest);
    state.registerSensitive(id);
  }
  state.baselineOutboxSnapshotCaptured = true;
  return assertBasicLifecycleOutboxQuiescence(rows, now);
}

async function verifyBaselineOutboxJobsUnchanged(
  runtime: Runtime,
  state: HarnessState,
) {
  assertCondition(
    state.baselineOutboxSnapshotCaptured,
    "The retained outbox baseline was not captured before validation.",
  );
  const baselineIds = [...state.baselineOutboxJobDigests.keys()];
  const currentRows =
    baselineIds.length === 0
      ? []
      : await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
          where: {
            storeId: state.storeId!,
            id: { in: baselineIds },
          },
        });
  assertBasicLifecycleOutboxBaselineUnchanged(
    state.baselineOutboxJobDigests,
    currentRows,
  );
  state.baselineOutboxVerified = true;
  state.checkpointRecoveryState("baseline-outbox:verified");
}

async function refreshRetainedBaselineUnderLocks(
  runtime: Runtime,
  state: HarnessState,
) {
  const liveCustomerGids = await listAllCustomerGids(runtime, state);
  assertCondition(
    liveCustomerGids.size === state.baselineCustomerGids.size &&
      [...liveCustomerGids].every((gid) => state.baselineCustomerGids.has(gid)),
    "The Shopify customer set changed before retained-customer exclusivity was established.",
  );
  const [accounts, shoppers] = await Promise.all([
    runtime.prisma.weleticLoyaltyAccount.findMany({
      where: { storeId: state.storeId! },
      select: {
        id: true,
        programId: true,
        shopperId: true,
        status: true,
        ledgerVersion: true,
        cachedPointsBalance: true,
        cachedPendingPoints: true,
        lifetimePointsEarned: true,
        lifetimePointsRedeemed: true,
        referralCount: true,
        referralPointsEarned: true,
        referralCode: true,
        referredById: true,
        currentTierId: true,
        tierExpiresAt: true,
        tierSpendRolling12Months: true,
        tierPointsRolling12Months: true,
        lastQualifyingActivityAt: true,
        nextExpiryDate: true,
        metadata: true,
        enrolledAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    runtime.prisma.weleticShopper.findMany({
      where: { storeId: state.storeId! },
      select: {
        id: true,
        shopifyCustomerId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        locale: true,
        tags: true,
        segmentIds: true,
        acceptsMarketing: true,
        ordersCount: true,
        totalSpent: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);
  state.baselineAccountTierById.clear();
  for (const { id, ...snapshot } of accounts) {
    state.baselineAccountTierById.set(id, snapshot);
    state.registerSensitive(
      id,
      snapshot.currentTierId,
      snapshot.tierExpiresAt?.toISOString(),
      snapshot.lastQualifyingActivityAt?.toISOString(),
      snapshot.nextExpiryDate?.toISOString(),
    );
  }
  state.baselineShopperById.clear();
  for (const { id, ...snapshot } of shoppers) {
    state.baselineShopperById.set(id, snapshot);
    state.registerSensitive(
      id,
      snapshot.shopifyCustomerId,
      snapshot.firstName,
      snapshot.lastName,
      snapshot.email,
      snapshot.phone,
      snapshot.locale,
      snapshot.createdAt.toISOString(),
      snapshot.updatedAt.toISOString(),
    );
  }
}

async function listAllCustomerGids(runtime: Runtime, state: HarnessState) {
  const gids = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result: {
      customers: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await runtime.shopifyAdminGraphqlRequest({
      shopDomain: state.options.storeDomain,
      accessToken: state.accessToken!,
      query: `query WeleticA1CustomerBaseline($after: String) {
        customers(first: 250, after: $after) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      variables: { after },
    });
    for (const node of result.customers.nodes) gids.add(node.id);
    if (!result.customers.pageInfo.hasNextPage) return gids;
    after = result.customers.pageInfo.endCursor;
    if (!after) {
      throw new Error("Shopify customer baseline pagination was incomplete.");
    }
  }
  throw new Error(
    "Shopify customer baseline exceeded the bounded safety scan; refusing disposable-customer cleanup.",
  );
}

async function prepareContext(runtime: Runtime, state: HarnessState) {
  const store = await runtime.prisma.weleticShopifyStore.findUnique({
    where: { shopDomain: state.options.storeDomain },
    include: { loyaltyProgram: true },
  });
  assertCondition(
    store,
    "The allowlisted Shopify staging store is unavailable.",
  );
  assertCondition(
    store.complianceState === "active",
    "The staging store is not in the active compliance state.",
  );
  assertCondition(
    store.currencyVerifiedAt,
    "The staging store currency has not been verified.",
  );
  assertCondition(
    store.installationGeneration,
    "The staging store has no active installation generation.",
  );
  assertCondition(
    store.loyaltyProgram,
    "The staging store has no loyalty program to snapshot and restore.",
  );

  const credentials = await runtime.resolveShopifyOfflineCredentials({
    storeId: store.id,
  });
  assertCondition(
    credentials.shopDomain === state.options.storeDomain,
    "Resolved Shopify credentials do not match the allowlisted staging store.",
  );

  state.storeId = store.id;
  state.workspaceId = store.projectId;
  state.programId = store.loyaltyProgram.id;
  state.installationGeneration = store.installationGeneration;
  state.currency = store.shopCurrency.toUpperCase();
  state.accessToken = credentials.accessToken;
  state.storeTuple = {
    storeId: store.id,
    shopDomain: normalizedShopDomain(store.shopDomain),
    workspaceId: store.projectId,
    platformProgramId: store.programId,
    loyaltyProgramId: store.loyaltyProgram.id,
    installationGeneration: store.installationGeneration,
    complianceState: "active",
    currency: store.shopCurrency.toUpperCase(),
    currencyVerifiedAt: store.currencyVerifiedAt,
  };
  state.registerSensitive(
    store.id,
    store.projectId,
    store.programId,
    store.loyaltyProgram.id,
    store.installationGeneration,
    credentials.accessToken,
  );

  const program = store.loyaltyProgram;
  state.programBaselineUpdatedAt = program.updatedAt;
  state.registerSensitive(program.updatedAt.toISOString());
  state.programSnapshot = {
    name: program.name,
    status: program.status,
    pointNameSingular: program.pointNameSingular,
    pointNamePlural: program.pointNamePlural,
    pointsPerCurrencyUnit: program.pointsPerCurrencyUnit,
    holdingPeriodDays: program.holdingPeriodDays,
    pointsExpiryMonths: program.pointsExpiryMonths,
    killSwitchActive: program.killSwitchActive,
    activatedAt: program.activatedAt,
    disabledAt: program.disabledAt,
    enableOnlineStoreLauncher: program.enableOnlineStoreLauncher,
    enableCustomerAccountHub: program.enableCustomerAccountHub,
    enableCheckoutExtension: program.enableCheckoutExtension,
    enableProductPointsWidget: program.enableProductPointsWidget,
    enableMetafieldsSync: program.enableMetafieldsSync,
    surfaceFlags: program.surfaceFlags,
    vipMilestoneMode: program.vipMilestoneMode,
    vipTimeframe: program.vipTimeframe,
    vipDowngradeGraceDays: program.vipDowngradeGraceDays,
    vipAutoDowngradeEnabled: program.vipAutoDowngradeEnabled,
    branding: program.branding,
    metadata: program.metadata,
  };

  const [
    rules,
    tiers,
    referralRules,
    rewards,
    bonusCampaigns,
    accountTiers,
    shoppers,
    fxRateSnapshots,
    reconciliationIssues,
  ] = await Promise.all([
    runtime.prisma.weleticLoyaltyEarningRule.findMany({
      where: { programId: program.id },
    }),
    runtime.prisma.weleticLoyaltyTier.findMany({
      where: { programId: program.id },
    }),
    runtime.prisma.weleticLoyaltyReferralRule.findMany({
      where: { programId: program.id },
    }),
    runtime.prisma.weleticRewardDefinition.findMany({
      where: { storeId: store.id },
    }),
    runtime.prisma.weleticLoyaltyBonusCampaign.findMany({
      where: { programId: program.id },
    }),
    runtime.prisma.weleticLoyaltyAccount.findMany({
      where: { storeId: store.id },
      select: {
        id: true,
        programId: true,
        shopperId: true,
        status: true,
        ledgerVersion: true,
        cachedPointsBalance: true,
        cachedPendingPoints: true,
        lifetimePointsEarned: true,
        lifetimePointsRedeemed: true,
        referralCount: true,
        referralPointsEarned: true,
        referralCode: true,
        referredById: true,
        currentTierId: true,
        tierExpiresAt: true,
        tierSpendRolling12Months: true,
        tierPointsRolling12Months: true,
        lastQualifyingActivityAt: true,
        nextExpiryDate: true,
        metadata: true,
        enrolledAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    runtime.prisma.weleticShopper.findMany({
      where: { storeId: store.id },
      select: {
        id: true,
        shopifyCustomerId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        locale: true,
        tags: true,
        segmentIds: true,
        acceptsMarketing: true,
        ordersCount: true,
        totalSpent: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    runtime.prisma.weleticFxRateSnapshot.findMany({
      select: { id: true },
    }),
    runtime.prisma.weleticReconciliationIssue.findMany({
      where: { storeId: store.id },
      select: { id: true },
    }),
  ]);
  rules.forEach((rule) => {
    const { id } = rule;
    state.baselineRuleIds.add(id);
    state.baselineRuleDigests.set(id, canonicalDigest(rule));
    state.registerSensitive(id);
  });
  tiers.forEach((tier) => {
    const { id } = tier;
    state.baselineTierIds.add(id);
    state.baselineTierDigests.set(id, canonicalDigest(tier));
    state.registerSensitive(id);
  });
  referralRules.forEach((rule) => {
    const { id } = rule;
    state.baselineReferralRuleIds.add(id);
    state.baselineReferralRuleDigests.set(id, canonicalDigest(rule));
    state.registerSensitive(id);
  });
  rewards.forEach((reward) => {
    const { id } = reward;
    state.baselineRewardIds.add(id);
    state.baselineRewardDigests.set(id, canonicalDigest(reward));
    state.registerSensitive(id);
  });
  bonusCampaigns.forEach((campaign) => {
    state.baselineBonusCampaignIds.add(campaign.id);
    state.baselineBonusCampaignDigests.set(
      campaign.id,
      canonicalDigest(campaign),
    );
    state.registerSensitive(campaign.id);
  });
  fxRateSnapshots.forEach(({ id }) => {
    state.baselineFxRateSnapshotIds.add(id);
    state.registerSensitive(id);
  });
  reconciliationIssues.forEach(({ id }) => {
    state.baselineReconciliationIssueIds.add(id);
    state.registerSensitive(id);
  });
  accountTiers.forEach(({ id, ...snapshot }) => {
    state.baselineAccountTierById.set(id, snapshot);
    state.registerSensitive(
      id,
      snapshot.currentTierId,
      snapshot.tierExpiresAt?.toISOString(),
      snapshot.lastQualifyingActivityAt?.toISOString(),
      snapshot.nextExpiryDate?.toISOString(),
    );
  });
  shoppers.forEach(({ id, shopifyCustomerId, ...snapshot }) => {
    state.baselineLocalCustomerIds.add(shopifyCustomerId);
    state.baselineShopperById.set(id, { shopifyCustomerId, ...snapshot });
    state.registerSensitive(
      id,
      shopifyCustomerId,
      snapshot.firstName,
      snapshot.lastName,
      snapshot.email,
      snapshot.phone,
      snapshot.locale,
      snapshot.createdAt.toISOString(),
      snapshot.updatedAt.toISOString(),
    );
  });

  const customerCreateAuditRows =
    await runtime.prisma.weleticShopifyWebhookEvent.findMany({
      where: { storeId: store.id, topic: "customers/create" },
      select: {
        payload: true,
        authenticatedBodyDigest: true,
        storeInstallationGeneration: true,
        status: true,
        processedAt: true,
        error: true,
      },
    });
  state.baselineCustomerCreateAuditCount = customerCreateAuditRows.length;
  state.baselineCustomerCreateNonNullPayloadCount =
    customerCreateAuditRows.filter(({ payload }) => payload !== null).length;
  state.baselineCustomerCreateInvalidAuditCount =
    customerCreateAuditRows.filter(
      (row) =>
        !isTerminalCustomerCreateAuditEvidence(
          row,
          state.installationGeneration,
        ),
    ).length;
  for (const { authenticatedBodyDigest } of customerCreateAuditRows) {
    if (authenticatedBodyDigest) {
      state.baselineCustomerCreateBodyDigests.add(authenticatedBodyDigest);
      state.registerSensitive(authenticatedBodyDigest);
    }
  }

  const baseline = await listAllCustomerGids(runtime, state);
  for (const gid of baseline) {
    state.baselineCustomerGids.add(gid);
    const numericId = gid.split("/").at(-1);
    if (numericId) state.baselineLocalCustomerIds.add(numericId);
    state.registerSensitive(gid, numericId);
  }
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
}

async function installFixtureConfiguration(
  runtime: Runtime,
  state: HarnessState,
) {
  const programId = state.programId!;
  const storeId = state.storeId!;
  const maxTier = await runtime.prisma.weleticLoyaltyTier.aggregate({
    where: { programId },
    _max: { tierOrder: true },
  });
  const tierBase = (maxTier._max.tierOrder ?? 0) + 100;
  const signupRuleId = runtime.createWeleticId("wrule_");
  const birthdayRuleId = runtime.createWeleticId("wrule_");
  const entryTierId = runtime.createWeleticId("wtier_");
  const vipTierId = runtime.createWeleticId("wtier_");
  const referralRuleId = runtime.createWeleticId("wrule_");
  state.registerSensitive(
    signupRuleId,
    birthdayRuleId,
    entryTierId,
    vipTierId,
    referralRuleId,
  );
  [signupRuleId, birthdayRuleId].forEach((id) => state.fixtureRuleIds.add(id));
  state.fixtureReferralRuleIds.add(referralRuleId);
  [entryTierId, vipTierId].forEach((id) => state.fixtureTierIds.add(id));
  state.rewardFixtureName = `A1 amount-off ${state.runMarker}`;
  state.registerSensitive(state.rewardFixtureName);

  // This is the first durable ownership record. It is created exclusively
  // only after the full locked baseline is captured and before the lease or
  // any temporary configuration can be mutated.
  state.initializeRecoveryCapsule("configuration-install:before");

  let installedProgram: {
    updatedAt: Date;
    metadata: import("@prisma/client").Prisma.JsonValue;
  };
  const leaseAcquiredAt = new Date();
  const leaseRecoveryAfter = new Date(
    leaseAcquiredAt.getTime() + BASIC_LIFECYCLE_MAINTENANCE_RECOVERY_WINDOW_MS,
  );
  state.programMutationDispatched = true;
  state.programMutationUncertain = true;
  state.expectedTemporaryHoldingPeriodDays = 0;
  state.checkpointRecoveryState("configuration-install:dispatched");
  try {
    installedProgram = await withHarnessStoreMutation(
      runtime,
      state,
      "a1_install_fixture_configuration",
      async (tx) => {
        const currentProgram = await tx.weleticLoyaltyProgram.findUniqueOrThrow(
          {
            where: { id: programId },
            select: { updatedAt: true, metadata: true },
          },
        );
        assertCondition(
          currentProgram.updatedAt.getTime() ===
            state.programBaselineUpdatedAt!.getTime(),
          "The loyalty program changed before the maintenance lease could be acquired.",
        );
        const maintenanceMetadata =
          runtime.createLoyaltyMaintenanceLeaseMetadata({
            existingMetadata: currentProgram.metadata,
            ownerToken: state.maintenanceOwnerToken,
            runMarker: state.runMarker,
            fixtureEmails: [...state.fixtureCustomerEmails],
            acquiredAt: leaseAcquiredAt,
            recoveryAfter: leaseRecoveryAfter,
          });
        const updated = await tx.weleticLoyaltyProgram.updateMany({
          where: {
            id: programId,
            updatedAt: state.programBaselineUpdatedAt!,
          },
          data: {
            ...BASIC_LIFECYCLE_TEMPORARY_PROGRAM_CONFIG,
            metadata: maintenanceMetadata,
          },
        });
        assertCondition(
          updated.count === 1,
          "The loyalty program changed before the temporary configuration could be installed.",
        );
        await tx.weleticLoyaltyEarningRule.createMany({
          data: [
            {
              id: signupRuleId,
              programId,
              name: "A1 signup validation",
              triggerCode: "account_created",
              ruleType: "fixed_points",
              priority: 2_000_000_000,
              fixedPoints: BigInt(500),
              isActive: true,
            },
            {
              id: birthdayRuleId,
              programId,
              name: "A1 birthday validation",
              triggerCode: "birthday",
              ruleType: "fixed_points",
              priority: 2_000_000_000,
              fixedPoints: BigInt(75),
              isActive: true,
            },
          ],
        });
        await tx.weleticLoyaltyTier.createMany({
          data: [
            {
              id: entryTierId,
              programId,
              name: "A1 Member",
              slug: `${state.runMarker}-member`,
              tierOrder: tierBase,
              minSpendThreshold: BigInt(0),
              minPointsThreshold: BigInt(0),
              pointsMultiplier: "1",
            },
            {
              id: vipTierId,
              programId,
              name: "A1 VIP",
              slug: `${state.runMarker}-vip`,
              tierOrder: tierBase + 1,
              minSpendThreshold: BigInt(0),
              minPointsThreshold: BigInt(2_000),
              pointsMultiplier: "1.25",
            },
          ],
        });
        await tx.weleticLoyaltyReferralRule.create({
          data: {
            id: referralRuleId,
            programId,
            advocatePointsReward: BigInt(125),
            refereePointsReward: BigInt(50),
            advocateRewardKind: "points",
            refereeRewardKind: "points",
            minQualifyingOrderSubtotal: "100",
            maxReferralsPerAdvocate: 10,
            fraudCheckSameIp: false,
            isActive: true,
          },
        });
        await runtime.publishLoyaltyEarnPolicyRevision({
          tx,
          storeId,
          programId,
          reason: "a1_fixture_policy_installed",
        });
        return tx.weleticLoyaltyProgram.findUniqueOrThrow({
          where: { id: programId },
          select: { updatedAt: true, metadata: true },
        });
      },
    );
    state.maintenancePermit = runtime.createLoyaltyMaintenanceOwnerPermit({
      storeId,
      metadata: installedProgram.metadata,
      ownerToken: state.maintenanceOwnerToken,
    });
    state.maintenanceLeaseMetadata = installedProgram.metadata;
    state.maintenanceLeaseAcquired = true;
    state.configMutated = true;
    state.programMutationUncertain = false;
    state.lastHarnessProgramUpdatedAt = installedProgram.updatedAt;
    state.registerSensitive(installedProgram.updatedAt.toISOString());
    state.checkpointRecoveryState("configuration-install:committed");
  } catch (error) {
    const [program, ruleCount, tierCount, referralCount] = await Promise.all([
      readHarnessProgramState(runtime, state),
      runtime.prisma.weleticLoyaltyEarningRule.count({
        where: { programId, id: { in: [signupRuleId, birthdayRuleId] } },
      }),
      runtime.prisma.weleticLoyaltyTier.count({
        where: { programId, id: { in: [entryTierId, vipTierId] } },
      }),
      runtime.prisma.weleticLoyaltyReferralRule.count({
        where: { programId, id: referralRuleId },
      }),
    ]);
    const committed = ruleCount === 2 && tierCount === 2 && referralCount === 1;
    const absent = ruleCount === 0 && tierCount === 0 && referralCount === 0;
    assertCondition(
      committed || absent,
      "Temporary configuration installation reached an inconsistent local outcome.",
    );
    if (committed) {
      state.maintenancePermit = runtime.createLoyaltyMaintenanceOwnerPermit({
        storeId,
        metadata: program.metadata,
        ownerToken: state.maintenanceOwnerToken,
      });
      state.maintenanceLeaseMetadata = program.metadata;
      state.maintenanceLeaseAcquired = true;
      assertCondition(
        state.programSnapshot &&
          isBasicLifecycleExactTemporaryProgramState(
            state.programSnapshot,
            program,
          ),
        "The loyalty program drifted after an unknown configuration-install outcome; refusing to adopt its version.",
      );
      state.configMutated = true;
      state.programMutationUncertain = false;
      state.lastHarnessProgramUpdatedAt = program.updatedAt;
      state.registerSensitive(program.updatedAt.toISOString());
      state.checkpointRecoveryState("configuration-install:reconciled-commit");
    } else {
      assertCondition(
        runtime.readLoyaltyMaintenanceLease(program.metadata) === null,
        "The configuration install did not create fixtures, but a maintenance lease has an unknown owner.",
      );
      assertCondition(
        program &&
          state.programSnapshot &&
          programSnapshotMatches(state.programSnapshot, program),
        "The configuration install did not create fixtures, but the program no longer matches its baseline.",
      );
      state.programMutationDispatched = false;
      state.programMutationUncertain = false;
      state.checkpointRecoveryState("configuration-install:reconciled-absent");
    }
    throw error;
  }

  state.checkpointRecoveryState("reward-create:before");
  try {
    const reward = await withHarnessStoreMutation(
      runtime,
      state,
      "a1_create_fixture_reward",
      (tx) =>
        runtime.createRewardDefinition({
          storeId,
          name: state.rewardFixtureName!,
          rewardType: "amount_off",
          exchangeType: "fixed",
          pointsCost: BigInt(50),
          discountValue: "100",
          usageLimitPerCustomer: 0,
          expiresInDays: 7,
          tx,
        }),
    );
    state.fixtureRewardIds.add(reward.id);
    state.registerSensitive(reward.id);
    state.checkpointRecoveryState("reward-create:committed");
  } catch (error) {
    await discoverUncertainFixtureReward(runtime, state);
    state.checkpointRecoveryState("reward-create:reconciled-after-error");
    throw error;
  }
}

async function createDisposableCustomer(
  runtime: Runtime,
  state: HarnessState,
  role: string,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const email = `${state.runMarker}-${role}@example.com`;
  assertCondition(
    state.fixtureCustomerEmails.has(email),
    "The disposable customer identity was not predeclared in the maintenance lease.",
  );
  state.registerSensitive(email);
  let result: {
    customerCreate: {
      customer: { id: string; tags: string[] } | null;
      userErrors: Array<{ message: string }>;
    };
  };
  state.uncertainFixtureCustomerEmails.add(email);
  state.checkpointRecoveryState(`customer-create:${role}:before`);
  try {
    result = await runtime.shopifyAdminGraphqlRequest({
      shopDomain: state.options.storeDomain,
      accessToken: state.accessToken!,
      query: `mutation WeleticA1CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }`,
      variables: {
        input: {
          email,
          firstName: "A1",
          lastName: role,
          tags: [DISPOSABLE_CUSTOMER_TAG, state.runMarker],
        },
      },
      postDispatchOutcomeUnknown: true,
    });
  } catch {
    const matches = await reconcileBasicLifecycleDisposableCustomerSearch({
      mode: "unique",
      runMarker: state.runMarker,
      expectedEmail: email,
      pollMs: 1_000,
      maxAttempts: 120,
      lookup: async () => {
        const reconciled: {
          customers: {
            nodes: Array<{
              id: string;
              tags: string[];
              email: string | null;
            }>;
          };
        } = await runtime.shopifyAdminGraphqlRequest({
          shopDomain: state.options.storeDomain,
          accessToken: state.accessToken!,
          query: `query WeleticA1CustomerCreateReconcile($query: String!) {
            customers(first: 5, query: $query) { nodes { id tags email } }
          }`,
          variables: { query: `email:${email}` },
        });
        return reconciled.customers.nodes;
      },
    });
    result = { customerCreate: { customer: matches[0], userErrors: [] } };
  }
  if (result.customerCreate.userErrors.length > 0) {
    state.uncertainFixtureCustomerEmails.delete(email);
    state.checkpointRecoveryState(`customer-create:${role}:rejected`);
    throw new Error(
      `Shopify customerCreate rejected the disposable fixture: ${result.customerCreate.userErrors
        .map((item) => item.message)
        .join("; ")}`,
    );
  }
  const customer = result.customerCreate.customer;
  assertCondition(customer, "Shopify customerCreate returned no customer.");
  assertCondition(
    customer.tags.includes(DISPOSABLE_CUSTOMER_TAG) &&
      customer.tags.includes(state.runMarker),
    "Shopify did not retain the disposable customer safety tags.",
  );
  assertCondition(
    !state.baselineCustomerGids.has(customer.id),
    "Shopify returned a retained baseline customer for a disposable create.",
  );
  const numericId = numericCustomerId(customer.id);
  state.fixtureCustomerNumericIds.add(String(numericId));
  state.remoteCustomerGids.add(customer.id);
  state.uncertainFixtureCustomerEmails.delete(email);
  state.registerSensitive(customer.id, String(numericId));
  state.checkpointRecoveryState(`customer-create:${role}:observed`);
  return { gid: customer.id, numericId, email };
}

async function waitForLocalCustomer(
  runtime: Runtime,
  state: HarnessState,
  remote: {
    gid: string;
    numericId: number;
    email: string;
  },
  role: string,
): Promise<FixtureCustomer> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const shopper = await runtime.prisma.weleticShopper.findUnique({
      where: {
        storeId_shopifyCustomerId: {
          storeId: state.storeId!,
          shopifyCustomerId: String(remote.numericId),
        },
      },
      include: { loyaltyAccount: true },
    });
    if (shopper?.loyaltyAccount) {
      state.fixtureShopperIds.add(shopper.id);
      state.fixtureAccountIds.add(shopper.loyaltyAccount.id);
      state.fixtureLocalIdentityByCustomerId.set(String(remote.numericId), {
        shopperId: shopper.id,
        accountId: shopper.loyaltyAccount.id,
      });
      state.registerSensitive(shopper.id, shopper.loyaltyAccount.id);
      state.checkpointRecoveryState(`customer-local:${role}:observed`);
      return {
        role,
        ...remote,
        shopperId: shopper.id,
        accountId: shopper.loyaltyAccount.id,
      };
    }
    await delay(1_000);
  }
  throw new Error(
    "Timed out waiting for the real customers/create webhook to provision a local loyalty account.",
  );
}

function isTerminalCustomerCreateAuditEvidence(
  row: {
    payload: unknown;
    authenticatedBodyDigest: string | null;
    storeInstallationGeneration: string | null;
    status: string;
    processedAt: Date | null;
    error: string | null;
  },
  installationGeneration: string | null | undefined,
) {
  return (
    row.payload === null &&
    Boolean(row.authenticatedBodyDigest) &&
    row.storeInstallationGeneration === installationGeneration &&
    row.status === "processed" &&
    row.processedAt !== null &&
    row.error === null
  );
}

export function evaluateBasicLifecycleCustomerCreateAuditEvidence({
  rows,
  baselineCount,
  baselineNonNullPayloadCount,
  baselineInvalidCount,
  baselineBodyDigests,
  ownedSyntheticWebhookIds,
  installationGeneration,
  expectedRegisteredCount,
}: {
  rows: ReadonlyArray<{
    webhookId: string;
    payload: unknown;
    authenticatedBodyDigest: string | null;
    storeInstallationGeneration: string | null;
    status: string;
    processedAt: Date | null;
    error: string | null;
  }>;
  baselineCount: number;
  baselineNonNullPayloadCount: number;
  baselineInvalidCount: number;
  baselineBodyDigests: ReadonlySet<string>;
  ownedSyntheticWebhookIds: ReadonlySet<string>;
  installationGeneration: string | null | undefined;
  expectedRegisteredCount: number;
}) {
  const unownedRows = rows.filter(
    ({ webhookId }) => !ownedSyntheticWebhookIds.has(webhookId),
  );
  const candidates = unownedRows.filter(
    ({ authenticatedBodyDigest }) =>
      authenticatedBodyDigest &&
      !baselineBodyDigests.has(authenticatedBodyDigest),
  );
  const terminalCandidates = candidates.filter((row) =>
    isTerminalCustomerCreateAuditEvidence(row, installationGeneration),
  );
  const observedBodyDigests = new Set(
    unownedRows.flatMap(({ authenticatedBodyDigest }) =>
      authenticatedBodyDigest ? [authenticatedBodyDigest] : [],
    ),
  );
  const exact =
    unownedRows.length === baselineCount + candidates.length &&
    unownedRows.filter(({ payload }) => payload !== null).length ===
      baselineNonNullPayloadCount &&
    unownedRows.filter(
      (row) =>
        !isTerminalCustomerCreateAuditEvidence(row, installationGeneration),
    ).length === baselineInvalidCount &&
    [...baselineBodyDigests].every((digest) =>
      observedBodyDigests.has(digest),
    ) &&
    candidates.length >= expectedRegisteredCount &&
    terminalCandidates.length === candidates.length;
  return {
    exact,
    candidateCount: candidates.length,
    terminalCandidateCount: terminalCandidates.length,
    terminalBodyDigests: terminalCandidates.map(
      ({ authenticatedBodyDigest }) => authenticatedBodyDigest!,
    ),
    terminalCandidates: terminalCandidates.map(
      ({ webhookId, authenticatedBodyDigest }) => ({
        webhookId,
        bodyDigest: authenticatedBodyDigest!,
      }),
    ),
  };
}

export function assignBasicLifecycleSerializedCustomerCreateAuditEvidence({
  customerGids,
  existingAssignments,
  existingDuplicateWebhookIds = new Set<string>(),
  terminalCandidates,
}: {
  customerGids: ReadonlySet<string>;
  existingAssignments: ReadonlyMap<
    string,
    { webhookId: string; bodyDigest: string }
  >;
  existingDuplicateWebhookIds?: ReadonlySet<string>;
  terminalCandidates: ReadonlyArray<{
    webhookId: string;
    bodyDigest: string;
  }>;
}) {
  const candidatesByWebhookId = new Map(
    terminalCandidates.map((candidate) => [candidate.webhookId, candidate]),
  );
  const claimedWebhookIds = new Set<string>();
  for (const [customerGid, assignment] of existingAssignments) {
    const candidate = candidatesByWebhookId.get(assignment.webhookId);
    assertCondition(
      customerGids.has(customerGid) &&
        candidate?.bodyDigest === assignment.bodyDigest &&
        !claimedWebhookIds.has(assignment.webhookId),
      "A serialized registered customers/create audit assignment is missing, duplicated, or changed.",
    );
    claimedWebhookIds.add(assignment.webhookId);
  }
  for (const webhookId of existingDuplicateWebhookIds) {
    assertCondition(
      candidatesByWebhookId.has(webhookId) && !claimedWebhookIds.has(webhookId),
      "A serialized duplicate registered customers/create audit row is missing or overlaps a primary assignment.",
    );
    claimedWebhookIds.add(webhookId);
  }
  const unassignedCustomerGids = [...customerGids].filter(
    (gid) => !existingAssignments.has(gid),
  );
  const unclaimedCandidates = terminalCandidates.filter(
    ({ webhookId }) => !claimedWebhookIds.has(webhookId),
  );
  assertCondition(
    unassignedCustomerGids.length <= 1,
    "More than one serialized customer/audit assignment is unresolved; refusing ambiguous pairing.",
  );
  if (unassignedCustomerGids.length === 0) {
    return {
      primary: null,
      duplicateCandidates: unclaimedCandidates,
    };
  }
  assertCondition(
    unclaimedCandidates.length >= 1,
    "A serialized disposable customer has no terminal registered customers/create audit evidence.",
  );
  const [assignment, ...duplicateCandidates] = [...unclaimedCandidates].sort(
    (left, right) => left.webhookId.localeCompare(right.webhookId),
  );
  return {
    primary: {
      customerGid: unassignedCustomerGids[0],
      assignment,
    },
    duplicateCandidates,
  };
}

async function captureRegisteredCustomerCreateAuditEvidence(
  runtime: Runtime,
  state: HarnessState,
  expectedCount: number,
) {
  const rows = await runtime.prisma.weleticShopifyWebhookEvent.findMany({
    where: { storeId: state.storeId!, topic: "customers/create" },
    select: {
      webhookId: true,
      payload: true,
      authenticatedBodyDigest: true,
      storeInstallationGeneration: true,
      status: true,
      processedAt: true,
      error: true,
    },
  });
  const evaluation = evaluateBasicLifecycleCustomerCreateAuditEvidence({
    rows,
    baselineCount: state.baselineCustomerCreateAuditCount,
    baselineNonNullPayloadCount:
      state.baselineCustomerCreateNonNullPayloadCount,
    baselineInvalidCount: state.baselineCustomerCreateInvalidAuditCount,
    baselineBodyDigests: state.baselineCustomerCreateBodyDigests,
    ownedSyntheticWebhookIds: state.webhookIds,
    installationGeneration: state.installationGeneration,
    expectedRegisteredCount: expectedCount,
  });
  for (const digest of evaluation.terminalBodyDigests) {
    state.registeredCustomerCreateAuditBodyDigests.add(digest);
    state.registerSensitive(digest);
  }
  state.registeredCustomerCreateAuditCount =
    state.registeredCustomerCreateAuditBodyDigests.size;
  assertCondition(
    evaluation.exact,
    "Registered customers/create audit evidence was not exactly counted, authenticated, generation-fenced, terminal, error-free, and payload-free.",
  );
  return evaluation;
}

async function waitForRegisteredCustomerCreateAuditAssignments(
  runtime: Runtime,
  state: HarnessState,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const evaluation = await captureRegisteredCustomerCreateAuditEvidence(
        runtime,
        state,
        state.remoteCustomerGids.size,
      );
      const next = assignBasicLifecycleSerializedCustomerCreateAuditEvidence({
        customerGids: state.remoteCustomerGids,
        existingAssignments: state.registeredCustomerCreateAuditByCustomerGid,
        existingDuplicateWebhookIds:
          state.registeredCustomerCreateDuplicateWebhookIds,
        terminalCandidates: evaluation.terminalCandidates,
      });
      if (next.primary) {
        state.registeredCustomerCreateAuditByCustomerGid.set(
          next.primary.customerGid,
          next.primary.assignment,
        );
        state.registerSensitive(
          next.primary.customerGid,
          next.primary.assignment.webhookId,
          next.primary.assignment.bodyDigest,
        );
      }
      for (const duplicate of next.duplicateCandidates) {
        state.registeredCustomerCreateDuplicateWebhookIds.add(
          duplicate.webhookId,
        );
        state.registerSensitive(duplicate.webhookId, duplicate.bodyDigest);
      }
      assertCondition(
        state.registeredCustomerCreateAuditByCustomerGid.size ===
          state.remoteCustomerGids.size,
        "A serialized disposable customer has no exact registered audit assignment.",
      );
      state.checkpointRecoveryState(
        "registered-customer-create-audit:assigned",
      );
      return;
    } catch {
      if (Date.now() >= deadline) break;
      await delay(1_000);
    }
  } while (true);
  throw new Error(
    "Timed out assigning serialized disposable customers to terminal payload-free registered customers/create audit evidence.",
  );
}

async function reconcileFixtureCustomerLocalProjections(
  runtime: Runtime,
  state: HarnessState,
  customerIds: ReadonlySet<string> = state.fixtureCustomerNumericIds,
) {
  for (const customerId of customerIds) {
    const known = state.fixtureLocalIdentityByCustomerId.get(customerId);
    const expectedPseudonym = runtime.getShopifyCustomerPrivacyPseudonym({
      storeId: state.storeId!,
      shopifyCustomerId: customerId,
    });
    const parsedPseudonym =
      runtime.parseShopifyCustomerPrivacyPseudonym(expectedPseudonym);
    assertCondition(
      parsedPseudonym,
      "The exact disposable customer pseudonym could not be derived.",
    );
    const shoppers = await runtime.prisma.weleticShopper.findMany({
      where: {
        storeId: state.storeId!,
        OR: [
          { shopifyCustomerId: customerId },
          { shopifyCustomerId: expectedPseudonym },
          ...(known ? [{ id: known.shopperId }] : []),
        ],
      },
      include: {
        loyaltyAccount: {
          select: {
            id: true,
            storeId: true,
            shopperId: true,
            status: true,
            referralCode: true,
            referredById: true,
            lastQualifyingActivityAt: true,
            nextExpiryDate: true,
            metadata: true,
          },
        },
      },
      take: 3,
    });
    assertCondition(
      shoppers.length === 1,
      "A disposable Shopify customer does not resolve to exactly one local shopper projection.",
    );
    const shopper = shoppers[0];
    const account = shopper.loyaltyAccount;
    const tombstone =
      await runtime.prisma.weleticShopifyCustomerPrivacyTombstone.findUnique({
        where: {
          storeId_identityKind_identityKeyId_customerDigest: {
            storeId: state.storeId!,
            identityKind: "customer_id",
            identityKeyId: parsedPseudonym.identityKeyId,
            customerDigest: parsedPseudonym.customerDigest,
          },
        },
        select: {
          storeId: true,
          identityKind: true,
          identityKeyId: true,
          customerDigest: true,
          shopperId: true,
          accountId: true,
          sourceRequestId: true,
          expiresAt: true,
          sourceRequest: {
            select: {
              id: true,
              storeId: true,
              requestType: true,
              status: true,
              phase: true,
              completedAt: true,
              subjectKind: true,
              subjectKeyId: true,
              subjectDigest: true,
              payloadCiphertext: true,
            },
          },
        },
      });
    const metadataText = JSON.stringify(account?.metadata ?? null);
    assertBasicLifecycleFixtureCustomerProjection({
      storeId: state.storeId!,
      customerId,
      expectedPseudonym,
      expectedIdentityKeyId: parsedPseudonym.identityKeyId,
      expectedCustomerDigest: parsedPseudonym.customerDigest,
      now: new Date(),
      shopper,
      account,
      tombstone,
      baselineShopperIds: new Set(state.baselineShopperById.keys()),
      baselineAccountIds: new Set(state.baselineAccountTierById.keys()),
      fixtureRequestIds: state.fixtureComplianceRequestIds,
      hasRedactionMetadata: Boolean(
        account &&
          runtime.hasShopifyCustomerRedactionTombstone(account.metadata),
      ),
      metadataContainsFixtureIdentity:
        metadataText.includes(customerId) ||
        [...state.fixtureCustomerEmails].some((email) =>
          metadataText.includes(email),
        ),
    });
    assertCondition(
      account &&
        (!known ||
          (shopper.id === known.shopperId && account.id === known.accountId)),
      "The disposable customer projection changed its exact local owner.",
    );
    state.fixtureShopperIds.add(shopper.id);
    state.fixtureAccountIds.add(account.id);
    state.fixtureLocalIdentityByCustomerId.set(customerId, {
      shopperId: shopper.id,
      accountId: account.id,
    });
    state.registerSensitive(shopper.id, account.id, expectedPseudonym);
  }
}

async function assertRegisteredCustomerCreateAuditAssignment(
  runtime: Runtime,
  state: HarnessState,
  customerGid: string,
) {
  const assignment =
    state.registeredCustomerCreateAuditByCustomerGid.get(customerGid);
  assertCondition(
    assignment,
    "A disposable customer has no exact registered customers/create audit assignment.",
  );
  const row = await runtime.prisma.weleticShopifyWebhookEvent.findFirst({
    where: {
      storeId: state.storeId!,
      webhookId: assignment.webhookId,
      topic: "customers/create",
    },
    select: {
      payload: true,
      authenticatedBodyDigest: true,
      storeInstallationGeneration: true,
      status: true,
      processedAt: true,
      error: true,
    },
  });
  assertCondition(
    row?.authenticatedBodyDigest === assignment.bodyDigest &&
      isTerminalCustomerCreateAuditEvidence(row, state.installationGeneration),
    "A disposable customer's exact registered audit assignment is missing or no longer terminal and payload-free.",
  );
}

async function withFixtureCustomerSettlementLocks<T>(
  runtime: Runtime,
  state: HarnessState,
  customerGid: string,
  task: () => Promise<T>,
) {
  assertCondition(
    state.workspaceId && state.storeId,
    "The fixture-customer settlement lock scope is unavailable.",
  );
  const customerId = String(numericCustomerId(customerGid));
  assertCondition(
    state.remoteCustomerGids.has(customerGid) &&
      state.fixtureCustomerNumericIds.has(customerId) &&
      !state.baselineCustomerGids.has(customerGid) &&
      !state.baselineLocalCustomerIds.has(customerId),
    "The fixture-customer settlement lock subject is not exact or is baseline-owned.",
  );
  return runtime.withShopifyCustomerSettlementLocks({
    workspaceId: state.workspaceId,
    storeId: state.storeId,
    shopifyCustomerId: customerId,
    fn: task,
  });
}

async function reconcileFixtureCustomerIngress(
  runtime: Runtime,
  state: HarnessState,
  timeoutMs = 120_000,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  await discoverUncertainFixtureCustomers(runtime, state);
  const expectedCount = state.remoteCustomerGids.size;
  assertCondition(
    state.fixtureCustomerNumericIds.size === expectedCount,
    "A disposable Shopify customer identity could not be mapped to its exact numeric subject.",
  );

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      await waitForRegisteredCustomerCreateAuditAssignments(
        runtime,
        state,
        Math.max(1, deadline - Date.now()),
      );
      await reconcileFixtureCustomerLocalProjections(runtime, state);
      assertCondition(
        state.registeredCustomerCreateAuditByCustomerGid.size === expectedCount,
        "The exact registered customer-audit assignment set is incomplete.",
      );
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(1_000);
    }
  } while (true);
  throw new Error(
    `Timed out reconciling every disposable customer to exact terminal, payload-free registered audit evidence and its local shopper/account projection; remote and local ownership proof was preserved. Last safe cause: ${state.safeError(lastError)}`,
  );
}

async function dispatchSignedWebhook(
  runtime: Runtime,
  state: HarnessState,
  topic: string,
  payload: Record<string, unknown>,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  assertCondition(
    state.maintenanceLeaseAcquired && state.maintenancePermit,
    "Synthetic lifecycle ingress requires the harness-owned maintenance lease.",
  );
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  assertCondition(
    secret,
    "SHOPIFY_WEBHOOK_SECRET is required by the signed staging harness.",
  );
  state.registerSensitive(secret);
  const webhookId = `a1-${crypto.randomBytes(16).toString("hex")}`;
  state.webhookIds.add(webhookId);
  state.registerSensitive(webhookId);
  state.checkpointRecoveryState(`webhook:${topic}:${webhookId}:before`);
  const result = await runtime.dispatchShopifyWebhook({
    topic,
    payload,
    shopDomain: state.options.storeDomain,
    secret,
    webhookId,
    url: state.options.webhookTarget,
    maintenanceOwnerToken: state.maintenanceOwnerToken,
  });
  state.registerSensitive(result.signature);
  if (!result.ok) {
    throw new Error(`Signed ${topic} webhook returned HTTP ${result.status}.`);
  }
  state.checkpointRecoveryState(`webhook:${topic}:${webhookId}:accepted`);
  return webhookId;
}

function createFixtureOrder(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
  options: { amount?: number; discountCode?: string } = {},
): FixtureOrder {
  const orderId = uniqueNumericIdentity();
  const lineOneId = uniqueNumericIdentity();
  const lineTwoId = uniqueNumericIdentity();
  const amount = options.amount ?? 1_000;
  const currency = state.currency!;
  const totalMinorAmount = runtime.decimalToMinorUnits(
    String(amount),
    currency,
  );
  const lineOneMinorAmount = (totalMinorAmount * BigInt(3)) / BigInt(5);
  const lineTwoMinorAmount = totalMinorAmount - lineOneMinorAmount;
  const amountDecimal = runtime.minorUnitsToDecimal(totalMinorAmount, currency);
  const externalId = String(orderId);
  state.fixtureOrderExternalIds.add(externalId);
  state.registerSensitive(externalId, String(lineOneId), String(lineTwoId));
  if (options.discountCode) state.registerSensitive(options.discountCode);
  const occurredAt = new Date().toISOString();
  const checkoutToken = `a1-checkout-${crypto.randomBytes(12).toString("hex")}`;
  const orderName = `#A1-${String(orderId).slice(-6)}`;
  const confirmationNumber = `A1${String(orderId).slice(-8)}`;
  state.fixtureCheckoutTokens.add(checkoutToken);
  state.registerSensitive(checkoutToken, orderName, confirmationNumber);
  return {
    orderId,
    lineIds: [lineOneId, lineTwoId],
    totalMinorAmount,
    lineMinorAmounts: [lineOneMinorAmount, lineTwoMinorAmount],
    payload: {
      id: orderId,
      name: orderName,
      confirmation_number: confirmationNumber,
      checkout_token: checkoutToken,
      created_at: occurredAt,
      processed_at: occurredAt,
      financial_status: "paid",
      currency,
      customer: {
        id: customer.numericId,
        email: customer.email,
        first_name: "A1",
        last_name: customer.role,
      },
      current_subtotal_price_set: moneySet(amountDecimal, currency),
      current_total_discounts_set: moneySet("0", currency),
      current_total_price_set: moneySet(amountDecimal, currency),
      current_total_tax_set: moneySet("0", currency),
      total_shipping_price_set: moneySet("0", currency),
      discount_codes: options.discountCode
        ? [{ code: options.discountCode }]
        : [],
      line_items: [
        {
          id: lineOneId,
          product_id: null,
          variant_id: null,
          sku: null,
          title: "A1 fixture line one",
          quantity: 1,
          price_set: moneySet(
            runtime.minorUnitsToDecimal(lineOneMinorAmount, currency),
            currency,
          ),
          total_discount_set: moneySet("0", currency),
        },
        {
          id: lineTwoId,
          product_id: null,
          variant_id: null,
          sku: null,
          title: "A1 fixture line two",
          quantity: 1,
          price_set: moneySet(
            runtime.minorUnitsToDecimal(lineTwoMinorAmount, currency),
            currency,
          ),
          total_discount_set: moneySet("0", currency),
        },
      ],
      billing_address: { province: "Tokyo", country_code: "JP" },
    },
  };
}

function createFixtureRefund(
  runtime: Runtime,
  state: HarnessState,
  order: FixtureOrder,
  lines: Array<{ index: number; amountMinor?: bigint }>,
) {
  const refundId = uniqueNumericIdentity();
  state.registerSensitive(String(refundId));
  const refundLineItems = lines.map(({ index, amountMinor }) => {
    const refundLineId = uniqueNumericIdentity();
    state.registerSensitive(String(refundLineId));
    const exactMinorAmount = amountMinor ?? order.lineMinorAmounts[index];
    assertCondition(
      exactMinorAmount !== undefined,
      "Fixture refund referenced an unknown order line.",
    );
    return {
      id: refundLineId,
      line_item_id: order.lineIds[index],
      quantity: 1,
      subtotal_set: moneySet(
        runtime.minorUnitsToDecimal(exactMinorAmount, state.currency!),
        state.currency!,
      ),
    };
  });
  return {
    id: refundId,
    order_id: order.orderId,
    created_at: new Date().toISOString(),
    refund_line_items: refundLineItems,
  };
}

async function dispatchFixtureOrder(
  runtime: Runtime,
  state: HarnessState,
  order: FixtureOrder,
  customer: FixtureCustomer,
) {
  const checkoutToken = String(order.payload.checkout_token);
  state.fixtureCheckoutCacheByToken.set(checkoutToken, {
    customerId: String(customer.numericId),
  });
  state.checkpointRecoveryState(`checkout-cache:${checkoutToken}:before`);
  await runtime.writeShopifyCheckoutCache({
    checkoutToken,
    fields: { clickId: "" },
    ttlSeconds: 15 * 60,
    storeId: state.storeId!,
    customerId: customer.numericId,
  });
  await dispatchSignedWebhook(runtime, state, "orders/paid", order.payload);
}

async function findGrantForOrder(
  runtime: Runtime,
  state: HarnessState,
  order: FixtureOrder,
) {
  const commerceOrder = await runtime.prisma.weleticCommerceOrder.findUnique({
    where: {
      storeId_externalId: {
        storeId: state.storeId!,
        externalId: String(order.orderId),
      },
    },
    include: {
      loyaltyEarnGrants: { include: { lineEarns: true } },
    },
  });
  assertCondition(commerceOrder, "Fixture order was not persisted locally.");
  assertCondition(
    commerceOrder.loyaltyEarnGrants.length === 1,
    "Fixture order did not produce exactly one loyalty earn grant.",
  );
  const grant = commerceOrder.loyaltyEarnGrants[0];
  state.fixtureOrderIds.add(commerceOrder.id);
  state.fixtureGrantIds.add(grant.id);
  state.registerSensitive(commerceOrder.id, grant.id);
  return { commerceOrder, grant };
}

async function findOutboxJob(
  runtime: Runtime,
  state: HarnessState,
  predicate: (job: any) => boolean,
) {
  const jobs = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      storeId: state.storeId!,
      ...(state.baselineOutboxJobIds.size > 0
        ? { id: { notIn: [...state.baselineOutboxJobIds] } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  const job = jobs.find(predicate);
  assertCondition(job, "Expected fixture-scoped outbox job was not found.");
  assertOwnedFixtureOutboxRows(state, [job]);
  state.fixtureOutboxIds.add(job.id);
  state.registerSensitive(job.id);
  return job;
}

async function processExactOutbox(
  runtime: Runtime,
  state: HarnessState,
  jobIds: string[],
  logicalNow: Date,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  assertCondition(
    jobIds.every((id) => !state.baselineOutboxJobIds.has(id)),
    "Refusing to process a retained pre-run outbox job.",
  );
  await discoverUncertainLocalFixtures(runtime, state);
  const exactJobs = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: state.storeId!, id: { in: jobIds } },
  });
  assertCondition(
    exactJobs.length === jobIds.length,
    "An exact fixture outbox job disappeared before scoped execution.",
  );
  assertOwnedFixtureOutboxRows(state, exactJobs);
  for (const id of jobIds) {
    state.fixtureOutboxIds.add(id);
    state.registerSensitive(id);
  }
  state.checkpointRecoveryState("outbox-processing:before");
  const result = await runtime.processOutboxJobsBatch({
    storeId: state.storeId!,
    jobIds,
    batchSize: jobIds.length,
    logicalNow,
    workerId: `a1-worker-${crypto.randomBytes(8).toString("hex")}`,
    loyaltyMaintenancePermit: state.maintenancePermit,
  });
  for (const job of result.jobs) {
    state.registerSensitive(job.id, job.error);
  }
  assertCondition(
    result.processed === jobIds.length &&
      result.succeeded === jobIds.length &&
      result.failed === 0 &&
      result.deadLettered === 0,
    "A fixture-scoped outbox job did not complete successfully.",
  );
  state.checkpointRecoveryState("outbox-processing:completed");
}

async function validateSignupIdempotency(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
) {
  const before = await runtime.prisma.weleticPointsLedgerEntry.findMany({
    where: {
      storeId: state.storeId!,
      accountId: customer.accountId,
      referenceType: "SIGNUP_BONUS",
    },
  });
  assertCondition(
    before.length === 1,
    "Real customer creation did not award one signup bonus.",
  );
  assertCondition(
    before[0].pointsDelta === BigInt(500) &&
      before[0].pendingDelta === BigInt(0) &&
      before[0].referenceId === customer.accountId &&
      before[0].idempotencyKey === `signup:${customer.accountId}`,
    "The real customer signup ledger economics did not equal the temporary 500-point rule.",
  );
  await dispatchSignedWebhook(runtime, state, "customers/create", {
    id: customer.numericId,
    first_name: "A1",
    last_name: customer.role,
    email: customer.email,
    tags: `${DISPOSABLE_CUSTOMER_TAG}, ${state.runMarker}`,
    accepts_marketing: false,
    orders_count: 0,
    total_spent: "0",
  });
  const after = await runtime.prisma.weleticPointsLedgerEntry.findMany({
    where: {
      storeId: state.storeId!,
      accountId: customer.accountId,
      referenceType: "SIGNUP_BONUS",
    },
  });
  assertCondition(
    after.length === 1,
    "Duplicate customers/create delivery duplicated signup points.",
  );
  assertCondition(
    after[0].id === before[0].id &&
      after[0].pointsDelta === BigInt(500) &&
      after[0].pendingDelta === BigInt(0),
    "Duplicate signup delivery changed the exact signup ledger entry.",
  );
}

async function validateReferralQualification(
  runtime: Runtime,
  state: HarnessState,
  advocate: FixtureCustomer,
  referee: FixtureCustomer,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const referralCode = await runtime.ensureAccountReferralCode(
    advocate.accountId,
    "A1",
    state.maintenancePermit,
  );
  state.registerSensitive(referralCode);
  const firstBind = await runtime.bindShopperReferral({
    storeId: state.storeId!,
    refereeAccountId: referee.accountId,
    referralCode,
    userAgent: "Weletic-A1-Validation",
    loyaltyMaintenancePermit: state.maintenancePermit,
  });
  const replayedBind = await runtime.bindShopperReferral({
    storeId: state.storeId!,
    refereeAccountId: referee.accountId,
    referralCode,
    userAgent: "Weletic-A1-Validation",
    loyaltyMaintenancePermit: state.maintenancePermit,
  });
  state.registerSensitive(firstBind.id, replayedBind.id);
  state.fixtureReferralIds.add(firstBind.id);
  assertCondition(
    firstBind.id === replayedBind.id && firstBind.status === "pending",
    "Referral binding was not idempotent and pending.",
  );

  const [advocateBefore, refereeBefore] = await Promise.all([
    runtime.prisma.weleticLoyaltyAccount.findUnique({
      where: { id: advocate.accountId },
    }),
    runtime.prisma.weleticLoyaltyAccount.findUnique({
      where: { id: referee.accountId },
    }),
  ]);
  assertCondition(
    advocateBefore && refereeBefore,
    "Referral account baselines are unavailable.",
  );

  const order = createFixtureOrder(runtime, state, referee, {
    amount: 1_000,
  });
  await dispatchFixtureOrder(runtime, state, order, referee);
  const [
    { commerceOrder, grant },
    referral,
    advocateAfter,
    refereeAfter,
    referralLedger,
  ] = await Promise.all([
    findGrantForOrder(runtime, state, order),
    runtime.prisma.weleticLoyaltyReferral.findUnique({
      where: { id: firstBind.id },
    }),
    runtime.prisma.weleticLoyaltyAccount.findUnique({
      where: { id: advocate.accountId },
    }),
    runtime.prisma.weleticLoyaltyAccount.findUnique({
      where: { id: referee.accountId },
    }),
    runtime.prisma.weleticPointsLedgerEntry.findMany({
      where: {
        storeId: state.storeId!,
        referenceType: "referral",
        referenceId: firstBind.id,
        accountId: { in: [advocate.accountId, referee.accountId] },
      },
    }),
  ]);
  const referralIdentity = getBasicLifecycleReferralQualificationIdentity({
    referralId: firstBind.id,
    commerceOrderId: commerceOrder.id,
  });
  const expectedOrderPoints = runtime.calculateEligibleOrderPoints({
    netAmountCents: order.totalMinorAmount,
    currency: state.currency!,
    pointsPerCurrencyUnit: "1",
    multiplier: "1",
  });
  assertCondition(
    referral?.status === "rewarded" &&
      referral.advocatePointsAwarded === BigInt(125) &&
      referral.refereePointsAwarded === BigInt(50) &&
      referral.qualifyingOrderId === referralIdentity.qualifyingOrderId &&
      grant.grossPoints === expectedOrderPoints &&
      grant.settledPoints === expectedOrderPoints &&
      grant.pendingPoints === BigInt(0),
    "Referral order did not qualify with the exact order and two-sided economics.",
  );
  const advocateEntry = referralLedger.find(
    ({ accountId }) => accountId === advocate.accountId,
  );
  const refereeEntry = referralLedger.find(
    ({ accountId }) => accountId === referee.accountId,
  );
  assertCondition(
    referralLedger.length === 2 &&
      advocateEntry?.pointsDelta === BigInt(125) &&
      advocateEntry.pendingDelta === BigInt(0) &&
      advocateEntry.idempotencyKey === referralIdentity.advocateLedgerKey &&
      refereeEntry?.pointsDelta === BigInt(50) &&
      refereeEntry.pendingDelta === BigInt(0) &&
      refereeEntry.idempotencyKey === referralIdentity.refereeLedgerKey,
    "Referral qualification did not create exactly the canonical advocate/referee ledger pair.",
  );
  assertCondition(
    advocateAfter &&
      refereeAfter &&
      advocateAfter.referralCount === advocateBefore.referralCount + 1 &&
      advocateAfter.referralPointsEarned ===
        advocateBefore.referralPointsEarned + BigInt(125) &&
      advocateAfter.cachedPointsBalance ===
        advocateBefore.cachedPointsBalance + BigInt(125) &&
      advocateAfter.lifetimePointsEarned ===
        advocateBefore.lifetimePointsEarned + BigInt(125) &&
      advocateAfter.ledgerVersion === advocateBefore.ledgerVersion + 1 &&
      refereeAfter.cachedPointsBalance ===
        refereeBefore.cachedPointsBalance + expectedOrderPoints + BigInt(50) &&
      refereeAfter.lifetimePointsEarned ===
        refereeBefore.lifetimePointsEarned + expectedOrderPoints + BigInt(50) &&
      refereeAfter.ledgerVersion === refereeBefore.ledgerVersion + 2,
    "Referral qualification did not update both account projections by the exact ledger deltas.",
  );
}

async function validateHoldingAndRefunds(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
) {
  await updateHarnessOwnedProgram(runtime, state, "a1_enable_holding_period", {
    holdingPeriodDays: 1,
  });
  const pendingOrder = createFixtureOrder(runtime, state, customer, {
    amount: 1_000,
  });
  await dispatchFixtureOrder(runtime, state, pendingOrder, customer);
  let { grant } = await findGrantForOrder(runtime, state, pendingOrder);
  const expectedPendingGross = runtime.calculateEligibleOrderPoints({
    netAmountCents: pendingOrder.totalMinorAmount,
    currency: state.currency!,
    pointsPerCurrencyUnit: "1",
    multiplier: "1",
  });
  assertCondition(
    grant.status === "pending" &&
      grant.grossPoints === expectedPendingGross &&
      grant.pendingPoints === expectedPendingGross &&
      grant.settledPoints === BigInt(0) &&
      grant.reversedPoints === BigInt(0),
    "Holding-period order did not retain the exact expected pending points.",
  );
  const firstLine = grant.lineEarns.find(
    (line) => line.lineExternalId === String(pendingOrder.lineIds[0]),
  );
  assertCondition(
    firstLine,
    "The first fixture order-line earn was not persisted.",
  );
  const expectedPartial = runtime.calculateRefundPointsReversal({
    originalGrant: grant,
    refundedLines: [
      {
        orderLineId: firstLine.orderLineId,
        cumulativeShopAmount: pendingOrder.lineMinorAmounts[0],
      },
    ],
  });
  await dispatchSignedWebhook(
    runtime,
    state,
    "refunds/create",
    createFixtureRefund(runtime, state, pendingOrder, [{ index: 0 }]),
  );
  ({ grant } = await findGrantForOrder(runtime, state, pendingOrder));
  assertCondition(
    grant.status === "partially_reversed" &&
      grant.pendingPoints ===
        expectedPendingGross - expectedPartial.totalPointsToClawback &&
      grant.settledPoints === BigInt(0) &&
      grant.reversedPoints === expectedPartial.totalPointsToClawback,
    "Partial refund did not apply the exact pending-point reversal.",
  );
  const holdingJob = await findOutboxJob(runtime, state, (job) => {
    if (job.jobType !== "HOLDING_PERIOD_RELEASE") return false;
    return isJsonObject(job.payload) && job.payload.grantId === grant.id;
  });
  await processExactOutbox(
    runtime,
    state,
    [holdingJob.id],
    new Date(grant.availableAt.getTime() + 60_000),
  );
  ({ grant } = await findGrantForOrder(runtime, state, pendingOrder));
  assertCondition(
    grant.pendingPoints === BigInt(0) &&
      grant.settledPoints ===
        expectedPendingGross - expectedPartial.totalPointsToClawback &&
      grant.reversedPoints === expectedPartial.totalPointsToClawback,
    "The holding worker did not release the exact post-refund balance.",
  );

  await updateHarnessOwnedProgram(runtime, state, "a1_disable_holding_period", {
    holdingPeriodDays: 0,
  });
  const immediateOrder = createFixtureOrder(runtime, state, customer, {
    amount: 1_000,
  });
  await dispatchFixtureOrder(runtime, state, immediateOrder, customer);
  ({ grant } = await findGrantForOrder(runtime, state, immediateOrder));
  const expectedImmediateGross = runtime.calculateEligibleOrderPoints({
    netAmountCents: immediateOrder.totalMinorAmount,
    currency: state.currency!,
    pointsPerCurrencyUnit: "1",
    multiplier: "1",
  });
  assertCondition(
    grant.status === "settled" &&
      grant.grossPoints === expectedImmediateGross &&
      grant.settledPoints === expectedImmediateGross &&
      grant.pendingPoints === BigInt(0) &&
      grant.reversedPoints === BigInt(0),
    "Zero-holding order did not settle the exact expected points immediately.",
  );
  await dispatchSignedWebhook(
    runtime,
    state,
    "refunds/create",
    createFixtureRefund(runtime, state, immediateOrder, [
      { index: 0 },
      { index: 1 },
    ]),
  );
  ({ grant } = await findGrantForOrder(runtime, state, immediateOrder));
  assertCondition(
    grant.status === "reversed" &&
      grant.grossPoints === expectedImmediateGross &&
      grant.reversedPoints === expectedImmediateGross &&
      grant.settledPoints === BigInt(0) &&
      grant.pendingPoints === BigInt(0),
    "Full refund did not reverse the complete immediate earn grant.",
  );
}

async function validateVipAndMetafieldReadback(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const vipTierId = [...state.fixtureTierIds][1];
  assertCondition(vipTierId, "VIP fixture tier is unavailable.");
  const before = await runtime.prisma.weleticLoyaltyAccount.findUnique({
    where: { id: customer.accountId },
    include: { currentTier: true },
  });
  assertCondition(
    before && before.currentTierId !== vipTierId,
    "The VIP fixture owner had already entered the target tier before the transition check.",
  );
  const order = createFixtureOrder(runtime, state, customer, {
    amount: 2_000,
  });
  await dispatchFixtureOrder(runtime, state, order, customer);
  const { grant } = await findGrantForOrder(runtime, state, order);
  const account = await runtime.prisma.weleticLoyaltyAccount.findUnique({
    where: { id: customer.accountId },
    include: { currentTier: true },
  });
  assertCondition(
    account?.currentTierId === vipTierId && before,
    "Loyalty activity did not promote the fixture account to the temporary VIP tier.",
  );
  const expectedPoints = runtime.calculateEligibleOrderPoints({
    netAmountCents: order.totalMinorAmount,
    currency: state.currency!,
    pointsPerCurrencyUnit: "1",
    multiplier: String(before.currentTier?.pointsMultiplier ?? "1"),
  });
  const [qualifyingEntries, qualifyingOrders] = await Promise.all([
    runtime.prisma.weleticPointsLedgerEntry.findMany({
      where: {
        storeId: state.storeId!,
        accountId: customer.accountId,
        entryType: { in: [...runtime.GENUINE_EARN_ENTRY_TYPES] },
        pointsDelta: { gt: BigInt(0) },
      },
      select: { pointsDelta: true },
    }),
    runtime.prisma.weleticCommerceOrder.findMany({
      where: {
        storeId: state.storeId!,
        shopperId: customer.shopperId,
        status: "paid",
      },
      select: { shopNet: true },
    }),
  ]);
  const expectedTierPoints = qualifyingEntries.reduce(
    (sum, { pointsDelta }) => sum + pointsDelta,
    BigInt(0),
  );
  const expectedTierSpend = qualifyingOrders.reduce(
    (sum, { shopNet }) => sum + shopNet,
    BigInt(0),
  );
  assertCondition(
    grant.status === "settled" &&
      grant.grossPoints === expectedPoints &&
      grant.settledPoints === expectedPoints &&
      grant.pendingPoints === BigInt(0) &&
      grant.reversedPoints === BigInt(0) &&
      account.cachedPointsBalance ===
        before.cachedPointsBalance + expectedPoints &&
      account.cachedPendingPoints === before.cachedPendingPoints &&
      account.lifetimePointsEarned ===
        before.lifetimePointsEarned + expectedPoints &&
      account.ledgerVersion === before.ledgerVersion + 1 &&
      account.tierPointsRolling12Months === expectedTierPoints &&
      account.tierSpendRolling12Months === expectedTierSpend,
    "VIP qualifying order did not produce the exact grant and account projection delta.",
  );

  const metafieldJob = await runtime.enqueueOutboxJob({
    storeId: state.storeId!,
    jobType: "METAFIELD_SYNC",
    payload: {
      accountId: customer.accountId,
      shopifyCustomerId: String(customer.numericId),
      triggerReason: "a1_live_readback",
    },
    idempotencyKey: `a1_metafield_sync:${state.runMarker}:${customer.accountId}`,
    loyaltyMaintenancePermit: state.maintenancePermit,
  });
  assertCondition(
    metafieldJob,
    "VIP validation could not enqueue metafield synchronization.",
  );
  await processExactOutbox(runtime, state, [metafieldJob.job.id], new Date());

  const readback: {
    customer: {
      metafields: { nodes: Array<{ key: string; value: string }> };
    } | null;
  } = await runtime.shopifyAdminGraphqlRequest({
    shopDomain: state.options.storeDomain,
    accessToken: state.accessToken!,
    query: `query WeleticA1MetafieldReadback($id: ID!) {
      customer(id: $id) {
        metafields(first: 20, namespace: "weletic_loyalty") {
          nodes { key value }
        }
      }
    }`,
    variables: { id: customer.gid },
  });
  const fields = new Map(
    (readback.customer?.metafields.nodes ?? []).map((node) => [
      node.key,
      node.value,
    ]),
  );
  const expectedStatus =
    account.tierExpiresAt && account.tierExpiresAt > new Date()
      ? "in_grace_period"
      : account.status.toLowerCase();
  const expectedFields = new Map<string, string>([
    ["vip_tier", account.currentTier!.name],
    ["vip_tier_order", String(account.currentTier!.tierOrder)],
    ["points_balance", String(account.cachedPointsBalance)],
    ["pending_points", String(account.cachedPendingPoints)],
    ["lifetime_points", String(account.lifetimePointsEarned)],
    [
      "tier_multiplier",
      Number(account.currentTier!.pointsMultiplier).toFixed(2),
    ],
    ["member_status", expectedStatus],
  ]);
  if (account.referralCode) {
    expectedFields.set("referral_code", account.referralCode);
    expectedFields.set(
      "referral_link",
      `https://${state.options.storeDomain}?ref=${account.referralCode}`,
    );
  }
  assertCondition(
    [...expectedFields].every(
      ([key, expectedValue]) => fields.get(key) === expectedValue,
    ),
    "Shopify metafield readback did not exactly match the promoted loyalty account.",
  );
}

async function issueFixtureVoucher(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
  suffix: string,
  expiresAt?: Date,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const rewardDefinitionId = [...state.fixtureRewardIds][0];
  assertCondition(
    rewardDefinitionId,
    "Amount-off reward fixture is unavailable.",
  );
  const discountCode = `WLA1-${crypto.randomBytes(9).toString("hex").toUpperCase()}`;
  state.fixtureDiscountCodes.add(discountCode);
  state.registerSensitive(discountCode);
  state.checkpointRecoveryState(`voucher:${suffix}:before`);
  const existing = await runtime.lookupDiscountByCode(
    state.options.storeDomain,
    state.accessToken!,
    discountCode,
  );
  assertCondition(
    !existing,
    "A generated fixture voucher collided with a retained discount.",
  );
  const result = await runtime.redeemReward({
    storeId: state.storeId!,
    accountId: customer.accountId,
    rewardDefinitionId,
    discountCode,
    idempotencyKey: `a1:${state.runMarker}:${suffix}:${customer.accountId}`,
    loyaltyMaintenancePermit: state.maintenancePermit,
    ...(expiresAt ? { expiresAt } : {}),
  });
  state.registerSensitive(
    result.redemption.id,
    result.redemption.ledgerEntryId,
    result.shopifyDiscountId,
  );
  state.fixtureRedemptionIds.add(result.redemption.id);
  assertCondition(
    result.status === "issued" && result.shopifyDiscountId,
    "Shopify did not issue the fixture voucher.",
  );
  state.remoteDiscountGids.add(result.shopifyDiscountId);
  state.remoteDiscountCodesByGid.set(result.shopifyDiscountId, discountCode);
  state.checkpointRecoveryState(`voucher:${suffix}:issued`);
  const liveDiscount = await runtime.lookupDiscountByCode(
    state.options.storeDomain,
    state.accessToken!,
    discountCode,
  );
  assertCondition(
    liveDiscount?.id === result.shopifyDiscountId,
    "The issued voucher could not be read back with its exact Shopify identity.",
  );
  const liveValue = liveDiscount.configuration?.basicValue;
  assertCondition(
    liveDiscount.configuration?.kind === "basic" &&
      liveValue?.kind === "amount" &&
      runtime.decimalToMinorUnits(liveValue.amount, state.currency!) ===
        runtime.decimalToMinorUnits("100", state.currency!) &&
      liveValue.currencyCode.trim().toUpperCase() === state.currency &&
      liveValue.appliesOnEachItem === false,
    "The live Shopify voucher did not preserve the exact 100-unit amount-off economics and store currency.",
  );
  runtime.assertExpectedLoyaltyDiscountNode({
    identity: {
      storeId: state.storeId!,
      redemptionId: result.redemption.id,
      accountId: customer.accountId,
      rewardDefinitionId,
      discountCode,
    },
    metadata: result.redemption.metadata,
    remote: liveDiscount,
  });
  const debitEntries = await runtime.prisma.weleticPointsLedgerEntry.findMany({
    where: {
      storeId: state.storeId!,
      accountId: customer.accountId,
      referenceType: "REWARD_REDEMPTION",
      referenceId: result.redemption.id,
    },
  });
  assertCondition(
    debitEntries.length === 1 &&
      debitEntries[0].id === result.redemption.ledgerEntryId &&
      debitEntries[0].pointsDelta === BigInt(-50) &&
      debitEntries[0].pendingDelta === BigInt(0) &&
      debitEntries[0].idempotencyKey === `redeem_debit:${result.redemption.id}`,
    "Voucher issuance did not produce the exact one-time 50-point debit.",
  );
  return {
    redemptionId: result.redemption.id,
    discountCode,
    discountGid: result.shopifyDiscountId,
  };
}

async function validateVoucherLifecycle(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const usedVoucher = await issueFixtureVoucher(
    runtime,
    state,
    customer,
    "used",
  );
  const usedOrder = createFixtureOrder(runtime, state, customer, {
    amount: 500,
    discountCode: usedVoucher.discountCode,
  });
  await dispatchFixtureOrder(runtime, state, usedOrder, customer);
  const used = await runtime.prisma.weleticRewardRedemption.findUnique({
    where: { id: usedVoucher.redemptionId },
  });
  assertCondition(
    used?.status === "used" && used.orderId === String(usedOrder.orderId),
    "Signed paid-order settlement did not mark the voucher used.",
  );
  const usedRefunds = await runtime.prisma.weleticPointsLedgerEntry.count({
    where: {
      storeId: state.storeId!,
      accountId: customer.accountId,
      referenceId: usedVoucher.redemptionId,
      referenceType: {
        in: ["REWARD_REDEMPTION_CANCEL", "REDEMPTION_REFUND"],
      },
    },
  });
  assertCondition(
    usedRefunds === 0,
    "A used voucher incorrectly refunded its redemption debit.",
  );

  const cancelledVoucher = await issueFixtureVoucher(
    runtime,
    state,
    customer,
    "cancelled",
  );
  await runtime.cancelRewardRedemption({
    storeId: state.storeId!,
    redemptionId: cancelledVoucher.redemptionId,
    reason: "A1 disposable validation",
    loyaltyMaintenancePermit: state.maintenancePermit,
  });
  const cancelled = await runtime.prisma.weleticRewardRedemption.findUnique({
    where: { id: cancelledVoucher.redemptionId },
  });
  assertCondition(
    cancelled?.status === "cancelled",
    "Voucher cancellation did not settle locally.",
  );
  const cancellationRefunds =
    await runtime.prisma.weleticPointsLedgerEntry.findMany({
      where: {
        storeId: state.storeId!,
        accountId: customer.accountId,
        referenceId: cancelledVoucher.redemptionId,
        referenceType: {
          in: ["REWARD_REDEMPTION_CANCEL", "REDEMPTION_REFUND"],
        },
      },
    });
  assertCondition(
    cancellationRefunds.length === 1 &&
      cancellationRefunds[0].referenceType === "REWARD_REDEMPTION_CANCEL" &&
      cancellationRefunds[0].pointsDelta === BigInt(50) &&
      cancellationRefunds[0].pendingDelta === BigInt(0) &&
      cancellationRefunds[0].idempotencyKey ===
        `redeem_cancel:${cancelledVoucher.redemptionId}`,
    "Voucher cancellation did not refund exactly 50 points once with the canonical ledger identity.",
  );
  const cancelledRemote = await runtime.lookupDiscountByCode(
    state.options.storeDomain,
    state.accessToken!,
    cancelledVoucher.discountCode,
  );
  assertCondition(
    !cancelledRemote ||
      runtime.isInactiveShopifyDiscountStatus(cancelledRemote.status),
    "Cancelled voucher remained active in Shopify.",
  );

  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const expiredVoucher = await issueFixtureVoucher(
    runtime,
    state,
    customer,
    "expired",
    expiresAt,
  );
  const expiryJob = await findOutboxJob(runtime, state, (job) => {
    if (job.jobType !== "REDEMPTION_RECOVERY") return false;
    return (
      isJsonObject(job.payload) &&
      job.payload.redemptionId === expiredVoucher.redemptionId &&
      job.payload.sagaPhase === "expiry"
    );
  });
  await processExactOutbox(
    runtime,
    state,
    [expiryJob.id],
    new Date(expiresAt.getTime() + 60_000),
  );
  const expired = await runtime.prisma.weleticRewardRedemption.findUnique({
    where: { id: expiredVoucher.redemptionId },
  });
  assertCondition(
    expired?.status === "expired",
    "Logical-time expiry did not expire the voucher.",
  );
  const expiryRefunds = await runtime.prisma.weleticPointsLedgerEntry.findMany({
    where: {
      storeId: state.storeId!,
      accountId: customer.accountId,
      referenceId: expiredVoucher.redemptionId,
      referenceType: {
        in: ["REWARD_REDEMPTION_CANCEL", "REDEMPTION_REFUND"],
      },
    },
  });
  assertCondition(
    expiryRefunds.length === 1 &&
      expiryRefunds[0].referenceType === "REDEMPTION_REFUND" &&
      expiryRefunds[0].pointsDelta === BigInt(50) &&
      expiryRefunds[0].pendingDelta === BigInt(0) &&
      expiryRefunds[0].idempotencyKey ===
        `saga_compensate:${expiredVoucher.redemptionId}`,
    "Voucher expiry did not refund exactly 50 points once with the canonical saga ledger identity.",
  );
  const expiredRemote = await runtime.lookupDiscountByCode(
    state.options.storeDomain,
    state.accessToken!,
    expiredVoucher.discountCode,
  );
  assertCondition(
    !expiredRemote ||
      runtime.isInactiveShopifyDiscountStatus(expiredRemote.status),
    "Expired voucher remained active in Shopify.",
  );
}

async function validateBirthdayWorker(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const logicalYear = state.startedAt.getUTCFullYear() + 1;
  const month = String(state.startedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(state.startedAt.getUTCDate()).padStart(2, "0");
  const birthDate = `1990-${month}-${day}`;
  const registeredAt = `${logicalYear - 1}-01-01T00:00:00.000Z`;
  state.registerSensitive(birthDate, registeredAt);
  const schedule = runtime.getNextBirthdayRewardSchedule({
    birthDate,
    registeredAt,
    now: new Date(`${logicalYear}-01-01T00:00:00.000Z`),
  });
  const account = await runtime.prisma.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: customer.accountId },
  });
  const metadata = isJsonObject(account.metadata) ? account.metadata : {};
  await withHarnessStoreMutation(
    runtime,
    state,
    "a1_set_fixture_birthday_metadata",
    (tx) =>
      tx.weleticLoyaltyAccount.update({
        where: { id: customer.accountId },
        data: {
          metadata: {
            ...metadata,
            birthday: {
              birthDate,
              registeredAt,
              nextEligibleYear: schedule.calendarYear,
            },
          },
        },
      }),
    "database",
  );
  const job = await runtime.enqueueOutboxJob({
    storeId: state.storeId!,
    jobType: "BIRTHDAY_REWARD",
    payload: {
      accountId: customer.accountId,
      birthDate,
      registeredAt,
      calendarYear: schedule.calendarYear,
    },
    scheduledFor: schedule.scheduledFor,
    idempotencyKey: `a1_birthday:${state.runMarker}:${customer.accountId}:${schedule.calendarYear}`,
    loyaltyMaintenancePermit: state.maintenancePermit,
  });
  assertCondition(
    job,
    "Birthday validation could not enqueue a scheduled reward.",
  );
  await processExactOutbox(
    runtime,
    state,
    [job.job.id],
    new Date(schedule.scheduledFor.getTime() + 60_000),
  );
  const awards = await runtime.prisma.weleticPointsLedgerEntry.findMany({
    where: {
      storeId: state.storeId!,
      accountId: customer.accountId,
      referenceType: "BIRTHDAY_REWARD",
      referenceId: String(schedule.calendarYear),
    },
  });
  assertCondition(
    awards.length === 1 &&
      awards[0].pointsDelta === BigInt(75) &&
      awards[0].pendingDelta === BigInt(0) &&
      awards[0].referenceId === String(schedule.calendarYear) &&
      awards[0].idempotencyKey ===
        `birthday:${customer.accountId}:${schedule.calendarYear}`,
    "Logical birthday worker did not award the exact 75-point annual ledger entry once.",
  );
  const nextJob = await findOutboxJob(runtime, state, (candidate) => {
    if (candidate.jobType !== "BIRTHDAY_REWARD") return false;
    return (
      isJsonObject(candidate.payload) &&
      candidate.payload.accountId === customer.accountId &&
      candidate.payload.calendarYear === schedule.calendarYear + 1
    );
  });
  assertCondition(
    nextJob.status === "pending",
    "Birthday worker did not schedule the next annual cycle.",
  );
}

async function processFixtureVoucherCleanupJobs(
  runtime: Runtime,
  state: HarnessState,
  requestId: string,
) {
  const cleanups = await runtime.prisma.weleticShopifyVoucherCleanup.findMany({
    where: {
      storeId: state.storeId!,
      OR: [
        { sourceRequestId: requestId },
        { requestLinks: { some: { requestId } } },
      ],
    },
  });
  const cleanupIds = new Set<string>();
  for (const cleanup of cleanups) {
    cleanupIds.add(cleanup.id);
    state.fixtureCleanupIds.add(cleanup.id);
    state.registerSensitive(
      cleanup.id,
      cleanup.redemptionId,
      cleanup.expectedDiscountCode,
      cleanup.expectedDiscountId,
    );
  }
  if (cleanupIds.size === 0) return 0;

  const jobs = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      storeId: state.storeId!,
      jobType: "VOUCHER_PRIVACY_CLEANUP",
      status: { in: ["pending", "failed"] },
    },
  });
  const matching = jobs.filter(
    (job) =>
      isJsonObject(job.payload) &&
      typeof job.payload.cleanupId === "string" &&
      cleanupIds.has(job.payload.cleanupId),
  );
  for (const job of matching) {
    const logicalNow = new Date(
      Math.max(
        Date.now(),
        job.scheduledFor.getTime() + 1,
        (job.nextRetryAt?.getTime() ?? 0) + 1,
      ),
    );
    await processExactOutbox(runtime, state, [job.id], logicalNow);
  }
  return cleanupIds.size;
}

async function drainCustomerRedactRequest(
  runtime: Runtime,
  state: HarnessState,
  requestId: string,
  timeoutMs = 600_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request =
      await runtime.prisma.weleticShopifyComplianceRequest.findUnique({
        where: { id: requestId },
      });
    assertCondition(request, "Customer-redact compliance request disappeared.");
    if (request.status === "completed") return;
    if (request.status === "dead_letter") {
      state.registerSensitive(request.lastError);
      throw new Error(
        "Customer-redact compliance request reached dead letter.",
      );
    }

    await processFixtureVoucherCleanupJobs(runtime, state, requestId);
    const current = new Date();
    if (request.nextRetryAt && request.nextRetryAt > current) {
      await delay(
        Math.min(
          1_000,
          Math.max(100, request.nextRetryAt.getTime() - current.getTime() + 25),
        ),
      );
      continue;
    }
    const result = await runtime.processShopifyComplianceRequest({
      requestId,
      workerId: `a1-compliance-${crypto.randomBytes(8).toString("hex")}`,
      enqueueContinuation: false,
    });
    if (result.status === "leased" || result.status === "lost_race") {
      await delay(250);
    }
  }
  throw new Error("Timed out draining the fixture customer-redact lifecycle.");
}

async function drainOwnedFixtureCustomerRedactRequests(
  runtime: Runtime,
  state: HarnessState,
  timeoutMs = 600_000,
) {
  if (!state.storeId || state.fixtureComplianceRequestIds.size === 0) return;
  const requests =
    await runtime.prisma.weleticShopifyComplianceRequest.findMany({
      where: {
        storeId: state.storeId,
        id: { in: [...state.fixtureComplianceRequestIds] },
      },
      select: {
        id: true,
        storeId: true,
        requestType: true,
        webhookId: true,
      },
    });
  assertCondition(
    requests.length === state.fixtureComplianceRequestIds.size,
    "One or more exact fixture compliance requests disappeared before cleanup recovery.",
  );
  const deadline = Date.now() + timeoutMs;
  for (const request of requests) {
    assertBasicLifecycleOwnedCustomerRedactRequest({
      storeId: state.storeId,
      request,
      fixtureRequestIds: state.fixtureComplianceRequestIds,
      fixtureWebhookIds: state.webhookIds,
    });
    await drainCustomerRedactRequest(
      runtime,
      state,
      request.id,
      Math.max(1, deadline - Date.now()),
    );
  }
}

async function validateCustomerRedactVoucherCleanup(
  runtime: Runtime,
  state: HarnessState,
  customer: FixtureCustomer,
) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const voucher = await issueFixtureVoucher(
    runtime,
    state,
    customer,
    "privacy",
  );
  await collectFixtureOutboxIds(runtime, state);
  const fixtureShopId = uniqueNumericIdentity();
  state.registerSensitive(String(fixtureShopId));
  const webhookId = await dispatchSignedWebhook(
    runtime,
    state,
    "customers/redact",
    {
      shop_id: fixtureShopId,
      shop_domain: state.options.storeDomain,
      customer: { id: customer.numericId, email: customer.email },
      orders_to_redact: [],
    },
  );
  const request =
    await runtime.prisma.weleticShopifyComplianceRequest.findUnique({
      where: { webhookId },
    });
  assertCondition(
    request?.requestType === "customer_redact",
    "Signed customers/redact webhook did not persist the expected durable request.",
  );
  state.fixtureComplianceRequestIds.add(request.id);
  state.registerSensitive(request.id);
  state.checkpointRecoveryState("customer-redact:request-observed");
  await drainCustomerRedactRequest(runtime, state, request.id);

  const [account, shopper, cleanups, remote, completedRequest] =
    await Promise.all([
      runtime.prisma.weleticLoyaltyAccount.findUnique({
        where: { id: customer.accountId },
      }),
      runtime.prisma.weleticShopper.findUnique({
        where: { id: customer.shopperId },
      }),
      runtime.prisma.weleticShopifyVoucherCleanup.findMany({
        where: {
          storeId: state.storeId!,
          requestLinks: { some: { requestId: request.id } },
        },
      }),
      runtime.lookupDiscountByCode(
        state.options.storeDomain,
        state.accessToken!,
        voucher.discountCode,
      ),
      runtime.prisma.weleticShopifyComplianceRequest.findUnique({
        where: { id: request.id },
      }),
    ]);
  const rawCustomerId = String(customer.numericId);
  const expectedPseudonym = runtime.getShopifyCustomerPrivacyPseudonym({
    storeId: state.storeId!,
    shopifyCustomerId: rawCustomerId,
  });
  state.registerSensitive(expectedPseudonym);
  const parsedPseudonym =
    runtime.parseShopifyCustomerPrivacyPseudonym(expectedPseudonym);
  assertCondition(
    parsedPseudonym &&
      runtime.SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN.test(
        expectedPseudonym,
      ) &&
      expectedPseudonym !== rawCustomerId,
    "Customer redaction did not produce the approved versioned pseudonym shape.",
  );
  const tombstone =
    await runtime.prisma.weleticShopifyCustomerPrivacyTombstone.findUnique({
      where: {
        storeId_identityKind_identityKeyId_customerDigest: {
          storeId: state.storeId!,
          identityKind: "customer_id",
          identityKeyId: parsedPseudonym.identityKeyId,
          customerDigest: parsedPseudonym.customerDigest,
        },
      },
    });
  state.registerSensitive(tombstone?.id);
  if (tombstone) state.fixtureCustomerPrivacyTombstoneIds.add(tombstone.id);
  state.retainedPrivacyFenceCustomerIds.add(rawCustomerId);
  const fenceAudit = await runtime.auditShopifyCustomerPrivacyFences({
    storeId: state.storeId!,
    customerId: rawCustomerId,
  });
  assertCondition(
    fenceAudit.fenceCount > 0 && fenceAudit.allTtlValid,
    "Customer redaction did not retain valid bounded privacy fences.",
  );
  state.retainedPrivacyFenceCount = fenceAudit.fenceCount;
  state.retainedPrivacyFencesTtlValid = fenceAudit.allTtlValid;
  state.checkpointRecoveryState("customer-redact:privacy-evidence-observed");
  const metadataText = JSON.stringify(account?.metadata ?? null);
  assertCondition(
    account?.status === "closed" &&
      account.referralCode === null &&
      account.referredById === null &&
      account.lastQualifyingActivityAt === null &&
      account.nextExpiryDate === null &&
      runtime.hasShopifyCustomerRedactionTombstone(account.metadata) &&
      !metadataText.includes(rawCustomerId) &&
      !metadataText.includes(customer.email) &&
      shopper?.shopifyCustomerId === expectedPseudonym &&
      shopper.shopifyCustomerId !== rawCustomerId &&
      shopper.firstName === "Redacted" &&
      shopper.lastName === "Customer" &&
      shopper?.email === null &&
      shopper?.phone === null &&
      shopper.locale === null &&
      shopper.tags === null &&
      shopper.segmentIds === null &&
      shopper.acceptsMarketing === false,
    "Customer redaction did not exactly close, scrub, and pseudonymize the disposable loyalty owner.",
  );
  assertCondition(
    completedRequest?.status === "completed" &&
      completedRequest.storeId === state.storeId &&
      completedRequest.webhookId === webhookId &&
      completedRequest.requestType === "customer_redact" &&
      completedRequest.phase === "completed" &&
      completedRequest.completedAt !== null &&
      completedRequest.payloadCiphertext === null &&
      completedRequest.subjectKind === null &&
      completedRequest.subjectKeyId === null &&
      completedRequest.subjectDigest === null &&
      tombstone?.storeId === state.storeId &&
      tombstone.identityKind === "customer_id" &&
      tombstone.identityKeyId === parsedPseudonym.identityKeyId &&
      tombstone.customerDigest === parsedPseudonym.customerDigest &&
      tombstone.shopperId === customer.shopperId &&
      tombstone.accountId === customer.accountId &&
      tombstone.sourceRequestId === request.id,
    "Customer-redact request was not terminally scrubbed or its durable tombstone lost the exact pseudonymous owner/source linkage.",
  );
  assertCondition(
    cleanups.length >= 1 &&
      cleanups.every((cleanup) => cleanup.status === "completed"),
    "Customer redaction did not complete every linked voucher cleanup.",
  );
  assertCondition(
    !remote || runtime.isInactiveShopifyDiscountStatus(remote.status),
    "Customer-redact voucher cleanup left the Shopify discount active.",
  );
}

function markProgramSnapshotRestored(state: HarnessState) {
  state.configMutated = false;
  state.programMutationDispatched = false;
  state.programMutationUncertain = false;
  state.lastHarnessProgramUpdatedAt = undefined;
  state.expectedTemporaryHoldingPeriodDays = 0;
  state.checkpointRecoveryState("program-restore:reconciled");
}

function assertProgramRestoreComplete(state: HarnessState) {
  assertCondition(
    !state.configMutated &&
      !state.programMutationDispatched &&
      !state.programMutationUncertain &&
      !state.lastHarnessProgramUpdatedAt,
    "Fixture cleanup cannot continue before the exact program snapshot is restored.",
  );
}

async function restoreProgramConfiguration(
  runtime: Runtime,
  state: HarnessState,
) {
  if (
    !state.configMutated &&
    !state.programMutationDispatched &&
    !state.programMutationUncertain
  ) {
    return;
  }
  assertCondition(
    state.programId && state.programSnapshot,
    "The dispatched loyalty-program mutation has no complete restore state.",
  );

  // An unavailable database/API leaves the outcome unknown. Retrying here is
  // intentional: this function executes while all retained-customer locks are
  // held, and must not return while an exact harness temporary state remains.
  const maxAttempts = 120;
  const deadlineMs = Date.now() + 120_000;
  for (
    let attempt = 0;
    shouldAttemptBasicLifecycleProgramRestore({
      attempt,
      maxAttempts,
      nowMs: Date.now(),
      deadlineMs,
    });
    attempt += 1
  ) {
    try {
      await assertCurrentBasicLifecycleStoreTuple(runtime, state);
      const current = await readHarnessProgramState(runtime, state);
      const restorePlan = planBasicLifecycleHarnessOwnedProgramRestore(
        state.programSnapshot,
        current,
        [state.expectedTemporaryHoldingPeriodDays, 0, 1],
      );
      for (const key of restorePlan.externallyDriftedKeys) {
        state.programOwnedFieldDriftKeys.add(key);
      }
      if (Object.keys(restorePlan.restoreData).length === 0) {
        markProgramSnapshotRestored(state);
        return;
      }

      state.configMutated = true;
      state.programMutationDispatched = true;
      state.programMutationUncertain = true;
      state.lastHarnessProgramUpdatedAt = current.updatedAt;
      state.registerSensitive(current.updatedAt.toISOString());
      state.checkpointRecoveryState("program-restore:before-cas");

      await withHarnessStoreMutation(
        runtime,
        state,
        "a1_restore_fixture_configuration",
        async (tx) => {
          const result = await tx.weleticLoyaltyProgram.updateMany({
            where: { id: state.programId!, updatedAt: current.updatedAt },
            data: restorePlan.restoreData,
          });
          assertCondition(
            result.count === 1,
            "The loyalty program CAS restore lost ownership before it could commit.",
          );
          await runtime.publishLoyaltyEarnPolicyRevision({
            tx,
            storeId: state.storeId!,
            programId: state.programId!,
            reason: "a1_fixture_program_restored",
          });
        },
      );
      state.programMutationUncertain = true;
      state.checkpointRecoveryState("program-restore:cas-outcome-uncertain");
    } catch (error) {
      state.programMutationUncertain = true;
      state.checkpointRecoveryState("program-restore:error-outcome-uncertain");
      if (
        !shouldAttemptBasicLifecycleProgramRestore({
          attempt: attempt + 1,
          maxAttempts,
          nowMs: Date.now(),
          deadlineMs,
        })
      ) {
        throw new Error(
          "Timed out reconciling the dispatched loyalty-program mutation; all destructive cleanup remains blocked.",
          { cause: error },
        );
      }
      await delay(Math.min(1_000, 100 + attempt * 100));
    }
  }
  state.programMutationUncertain = true;
  throw new Error(
    "Timed out reconciling the dispatched loyalty-program mutation; all destructive cleanup remains blocked.",
  );
}

async function discoverUncertainFixtureReward(
  runtime: Runtime,
  state: HarnessState,
) {
  if (!state.storeId || !state.rewardFixtureName) return;
  const rewards = await runtime.prisma.weleticRewardDefinition.findMany({
    where: {
      storeId: state.storeId,
      name: state.rewardFixtureName,
      id: { notIn: [...state.baselineRewardIds] },
    },
    select: { id: true },
    take: 2,
  });
  assertCondition(
    rewards.length <= 1,
    "The unique temporary reward name resolved to multiple non-baseline rows.",
  );
  if (rewards[0]) {
    state.fixtureRewardIds.add(rewards[0].id);
    state.registerSensitive(rewards[0].id);
  }
}

async function discoverUncertainLocalFixtures(
  runtime: Runtime,
  state: HarnessState,
) {
  if (!state.storeId) return;
  await discoverUncertainFixtureReward(runtime, state);

  for (const gid of state.remoteCustomerGids) {
    const numericId = gid.split("/").at(-1);
    if (numericId) state.fixtureCustomerNumericIds.add(numericId);
  }

  const shopperIdentityFilters: Array<Record<string, unknown>> = [];
  if (state.fixtureCustomerNumericIds.size > 0) {
    shopperIdentityFilters.push({
      shopifyCustomerId: { in: [...state.fixtureCustomerNumericIds] },
    });
  }
  if (state.fixtureCustomerEmails.size > 0) {
    shopperIdentityFilters.push({
      email: { in: [...state.fixtureCustomerEmails] },
    });
  }
  if (shopperIdentityFilters.length > 0) {
    const shoppers = await runtime.prisma.weleticShopper.findMany({
      where: {
        storeId: state.storeId,
        OR: shopperIdentityFilters,
      },
      include: { loyaltyAccount: { select: { id: true } } },
    });
    for (const shopper of shoppers) {
      state.fixtureShopperIds.add(shopper.id);
      state.registerSensitive(
        shopper.id,
        shopper.shopifyCustomerId,
        shopper.email,
      );
      if (shopper.loyaltyAccount) {
        state.fixtureAccountIds.add(shopper.loyaltyAccount.id);
        state.registerSensitive(shopper.loyaltyAccount.id);
        if (state.fixtureCustomerNumericIds.has(shopper.shopifyCustomerId)) {
          state.fixtureLocalIdentityByCustomerId.set(
            shopper.shopifyCustomerId,
            {
              shopperId: shopper.id,
              accountId: shopper.loyaltyAccount.id,
            },
          );
        }
      }
    }
  }

  if (state.fixtureOrderExternalIds.size > 0) {
    const orders = await runtime.prisma.weleticCommerceOrder.findMany({
      where: {
        storeId: state.storeId,
        externalId: { in: [...state.fixtureOrderExternalIds] },
      },
      select: {
        id: true,
        loyaltyEarnGrants: { select: { id: true } },
      },
    });
    for (const order of orders) {
      state.fixtureOrderIds.add(order.id);
      state.registerSensitive(order.id);
      for (const grant of order.loyaltyEarnGrants) {
        state.fixtureGrantIds.add(grant.id);
        state.registerSensitive(grant.id);
      }
    }
  }

  if (state.fixtureAccountIds.size > 0 && state.fixtureRewardIds.size > 0) {
    const redemptions = await runtime.prisma.weleticRewardRedemption.findMany({
      where: {
        storeId: state.storeId,
        accountId: { in: [...state.fixtureAccountIds] },
        rewardDefinitionId: { in: [...state.fixtureRewardIds] },
        idempotencyKey: { startsWith: `a1:${state.runMarker}:` },
      },
      select: {
        id: true,
        shopifyDiscountId: true,
        shopifyDiscountCode: true,
      },
    });
    for (const redemption of redemptions) {
      state.fixtureRedemptionIds.add(redemption.id);
      state.fixtureDiscountCodes.add(redemption.shopifyDiscountCode);
      state.registerSensitive(
        redemption.id,
        redemption.shopifyDiscountId,
        redemption.shopifyDiscountCode,
      );
      if (redemption.shopifyDiscountId) {
        state.remoteDiscountGids.add(redemption.shopifyDiscountId);
        state.remoteDiscountCodesByGid.set(
          redemption.shopifyDiscountId,
          redemption.shopifyDiscountCode,
        );
      }
    }
  }

  if (state.webhookIds.size > 0) {
    const requests =
      await runtime.prisma.weleticShopifyComplianceRequest.findMany({
        where: {
          storeId: state.storeId,
          webhookId: { in: [...state.webhookIds] },
          requestType: "customer_redact",
        },
        select: { id: true },
      });
    for (const request of requests) {
      state.fixtureComplianceRequestIds.add(request.id);
      state.registerSensitive(request.id);
    }
  }

  if (state.fixtureComplianceRequestIds.size > 0) {
    const [customerTombstones, shopTombstones] = await Promise.all([
      runtime.prisma.weleticShopifyCustomerPrivacyTombstone.findMany({
        where: {
          storeId: state.storeId,
          OR: [
            {
              sourceRequestId: {
                in: [...state.fixtureComplianceRequestIds],
              },
            },
            { shopperId: { in: [...state.fixtureShopperIds] } },
            { accountId: { in: [...state.fixtureAccountIds] } },
          ],
        },
        select: { id: true },
      }),
      runtime.prisma.weleticShopifyShopPrivacyTombstone.findMany({
        where: {
          storeId: state.storeId,
          sourceRequestId: { in: [...state.fixtureComplianceRequestIds] },
        },
        select: { id: true },
      }),
    ]);
    for (const { id } of customerTombstones) {
      state.fixtureCustomerPrivacyTombstoneIds.add(id);
      state.registerSensitive(id);
    }
    for (const { id } of shopTombstones) {
      state.fixtureShopPrivacyTombstoneIds.add(id);
      state.registerSensitive(id);
    }
    const cleanups = await runtime.prisma.weleticShopifyVoucherCleanup.findMany(
      {
        where: {
          storeId: state.storeId,
          OR: [
            {
              sourceRequestId: {
                in: [...state.fixtureComplianceRequestIds],
              },
            },
            {
              requestLinks: {
                some: {
                  requestId: { in: [...state.fixtureComplianceRequestIds] },
                },
              },
            },
          ],
        },
      },
    );
    for (const cleanup of cleanups) {
      state.fixtureCleanupIds.add(cleanup.id);
      state.fixtureRedemptionIds.add(cleanup.redemptionId);
      state.registerSensitive(
        cleanup.id,
        cleanup.redemptionId,
        cleanup.expectedDiscountCode,
        cleanup.expectedDiscountId,
      );
    }
  }
  state.checkpointRecoveryState("uncertain-fixture-discovery:completed");
}

function assertOwnedFixtureOutboxRows(
  state: HarnessState,
  jobs: ReadonlyArray<{ id: string; jobType: string; payload: unknown }>,
) {
  assertCondition(
    state.storeId,
    "The fixture outbox ownership scope is unavailable.",
  );
  for (const job of jobs) {
    assertBasicLifecycleFixtureOutboxOwnership({
      storeId: state.storeId,
      job,
      baselineJobIds: state.baselineOutboxJobIds,
      fixtureAccountIds: state.fixtureAccountIds,
      fixtureShopperIds: state.fixtureShopperIds,
      fixtureOrderIds: state.fixtureOrderIds,
      fixtureOrderExternalIds: state.fixtureOrderExternalIds,
      fixtureGrantIds: state.fixtureGrantIds,
      fixtureCustomerNumericIds: state.fixtureCustomerNumericIds,
      fixtureReferralIds: state.fixtureReferralIds,
      fixtureRedemptionIds: state.fixtureRedemptionIds,
      fixtureCleanupIds: state.fixtureCleanupIds,
      fixtureRewardIds: state.fixtureRewardIds,
      fixtureDiscountCodes: state.fixtureDiscountCodes,
    });
  }
}

async function collectFixtureOutboxIds(runtime: Runtime, state: HarnessState) {
  if (!state.storeId) return;
  await discoverUncertainLocalFixtures(runtime, state);
  const fixturePseudonyms = [...state.fixtureCustomerNumericIds].map(
    (customerId) =>
      runtime.getShopifyCustomerPrivacyPseudonym({
        storeId: state.storeId!,
        shopifyCustomerId: customerId,
      }),
  );
  state.registerSensitive(...fixturePseudonyms);
  const sensitiveIds = new Set([
    state.runMarker,
    ...state.fixtureCustomerNumericIds,
    ...state.fixtureCustomerEmails,
    ...fixturePseudonyms,
    ...state.remoteCustomerGids,
    ...state.fixtureAccountIds,
    ...state.fixtureShopperIds,
    ...state.fixtureOrderIds,
    ...state.fixtureOrderExternalIds,
    ...state.fixtureGrantIds,
    ...state.fixtureReferralIds,
    ...state.fixtureRedemptionIds,
    ...state.fixtureCleanupIds,
    ...state.fixtureComplianceRequestIds,
    ...state.fixtureCustomerPrivacyTombstoneIds,
    ...state.fixtureShopPrivacyTombstoneIds,
    ...state.fixtureRewardIds,
    ...state.fixtureDiscountCodes,
    ...state.remoteDiscountGids,
    ...state.webhookIds,
  ]);
  const jobs = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
    where: {
      storeId: state.storeId,
      ...(state.baselineOutboxJobIds.size > 0
        ? { id: { notIn: [...state.baselineOutboxJobIds] } }
        : {}),
    },
  });
  for (const job of jobs) {
    if (
      isBasicLifecycleExactFixtureOutboxJob({
        job,
        baselineJobIds: state.baselineOutboxJobIds,
        knownFixtureJobIds: state.fixtureOutboxIds,
        exactFixtureValues: sensitiveIds,
        runMarker: state.runMarker,
      })
    ) {
      assertOwnedFixtureOutboxRows(state, [job]);
      state.fixtureOutboxIds.add(job.id);
      state.registerSensitive(job.id, job.idempotencyKey, job.lastError);
    }
  }
}

async function quiesceFixtureOutboxJobs(
  runtime: Runtime,
  state: HarnessState,
  timeoutMs = 240_000,
) {
  if (!state.storeId) return;
  await assertCurrentBasicLifecycleStoreTuple(
    runtime,
    state,
    getBasicLifecycleOutboxTupleCheckMode("before") === "database"
      ? runtime.prisma
      : undefined,
  );
  const deadline = Date.now() + timeoutMs;
  let stablePasses = 0;
  while (Date.now() < deadline) {
    await assertCurrentBasicLifecycleStoreTuple(
      runtime,
      state,
      getBasicLifecycleOutboxTupleCheckMode("poll") === "database"
        ? runtime.prisma
        : undefined,
    );
    const beforeCount = state.fixtureOutboxIds.size;
    await collectFixtureOutboxIds(runtime, state);
    const jobIds = [...state.fixtureOutboxIds];
    assertCondition(
      jobIds.every((id) => !state.baselineOutboxJobIds.has(id)),
      "Refusing to cancel a retained pre-run outbox job.",
    );
    if (jobIds.length === 0) {
      stablePasses = advanceBasicLifecycleOutboxStablePasses({
        previousStablePasses: stablePasses,
        beforeCount,
        afterCount: state.fixtureOutboxIds.size,
      });
      if (stablePasses >= 2) {
        await assertCurrentBasicLifecycleStoreTuple(
          runtime,
          state,
          getBasicLifecycleOutboxTupleCheckMode("after") === "database"
            ? runtime.prisma
            : undefined,
        );
        const finalCount = state.fixtureOutboxIds.size;
        await collectFixtureOutboxIds(runtime, state);
        if (state.fixtureOutboxIds.size === finalCount) return;
        stablePasses = 0;
      }
      await delay(250);
      continue;
    }

    const rows = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
      where: { storeId: state.storeId, id: { in: jobIds } },
    });
    const reconciledIds = reconcileBasicLifecycleKnownOutboxIds({
      knownIds: new Set(jobIds),
      existingRows: rows,
      localFixtureCleanupComplete: state.localFixtureCleanupComplete,
    });
    if (reconciledIds.size !== jobIds.length) {
      state.fixtureOutboxIds.clear();
      for (const id of reconciledIds) state.fixtureOutboxIds.add(id);
      state.checkpointRecoveryState(
        "post-local-outbox:known-deletions-reconciled",
      );
    }
    assertOwnedFixtureOutboxRows(state, rows);
    const active = evaluateBasicLifecycleFixtureOutboxCleanup(rows);
    if (active.cancellableIds.length > 0) {
      await withHarnessStoreMutation(
        runtime,
        state,
        "a1_cancel_fixture_outbox_jobs",
        async (tx) => {
          const currentRows = await tx.weleticLoyaltyOutboxJob.findMany({
            where: {
              storeId: state.storeId!,
              id: { in: active.cancellableIds },
            },
          });
          assertCondition(
            currentRows.length === active.cancellableIds.length &&
              currentRows.every(({ status }: { status: string }) =>
                ["pending", "failed"].includes(status),
              ),
            "A fixture outbox row changed before exact cancellation.",
          );
          assertOwnedFixtureOutboxRows(state, currentRows);
          const cancelled = await tx.weleticLoyaltyOutboxJob.updateMany({
            where: {
              storeId: state.storeId!,
              OR: currentRows.map(
                (row: {
                  id: string;
                  status: string;
                  attempts: number;
                  updatedAt: Date;
                }) => ({
                  id: row.id,
                  status: row.status,
                  attempts: row.attempts,
                  updatedAt: row.updatedAt,
                }),
              ),
            },
            data: {
              status: "cancelled",
              lockedAt: null,
              lockedBy: null,
              nextRetryAt: null,
            },
          });
          assertBasicLifecycleExactDeleteCount({
            family: "fixture outbox cancellations",
            expected: currentRows.length,
            actual: cancelled.count,
          });
          return cancelled;
        },
        "database",
      );
      stablePasses = 0;
      continue;
    }
    if (active.processingIds.length > 0) {
      stablePasses = 0;
      await delay(250);
      continue;
    }
    await collectFixtureOutboxIds(runtime, state);
    stablePasses = advanceBasicLifecycleOutboxStablePasses({
      previousStablePasses: stablePasses,
      beforeCount,
      afterCount:
        state.fixtureOutboxIds.size === jobIds.length
          ? state.fixtureOutboxIds.size
          : -1,
    });
    if (stablePasses >= 2) {
      await assertCurrentBasicLifecycleStoreTuple(
        runtime,
        state,
        getBasicLifecycleOutboxTupleCheckMode("after") === "database"
          ? runtime.prisma
          : undefined,
      );
      const finalCount = state.fixtureOutboxIds.size;
      await collectFixtureOutboxIds(runtime, state);
      if (state.fixtureOutboxIds.size === finalCount) return;
      stablePasses = 0;
    }
    await delay(250);
  }
  throw new Error(
    "Timed out waiting for exact fixture outbox work to reach a non-processing fixed point.",
  );
}

async function discoverFixtureReconciliationIssues(
  runtime: Runtime,
  state: HarnessState,
) {
  if (!state.storeId) return;
  const exactFixtureValues = new Set([
    state.runMarker,
    ...state.fixtureOrderExternalIds,
    ...state.fixtureAccountIds,
    ...state.fixtureReferralIds,
    ...state.fixtureRedemptionIds,
    ...state.fixtureOutboxIds,
    ...state.fixtureDiscountCodes,
  ]);
  const candidates = await runtime.prisma.weleticReconciliationIssue.findMany({
    where: {
      storeId: state.storeId,
      ...(state.baselineReconciliationIssueIds.size > 0
        ? { id: { notIn: [...state.baselineReconciliationIssueIds] } }
        : {}),
    },
  });
  for (const issue of candidates) {
    const externalKeyParts = issue.externalKey.split(":");
    if (
      externalKeyParts.some((part) => exactFixtureValues.has(part)) ||
      jsonContainsExactValue(issue.details, exactFixtureValues)
    ) {
      state.fixtureReconciliationIssueIds.add(issue.id);
      state.registerSensitive(issue.id, issue.externalKey);
    }
  }
}

async function discoverUncertainFixtureDiscounts(
  runtime: Runtime,
  state: HarnessState,
) {
  if (
    !state.storeId ||
    !state.accessToken ||
    state.fixtureAccountIds.size === 0
  ) {
    return;
  }
  const redemptions = await runtime.prisma.weleticRewardRedemption.findMany({
    where: {
      storeId: state.storeId,
      accountId: { in: [...state.fixtureAccountIds] },
      rewardDefinitionId: { in: [...state.fixtureRewardIds] },
      idempotencyKey: { startsWith: `a1:${state.runMarker}:` },
    },
    select: {
      id: true,
      shopifyDiscountId: true,
      shopifyDiscountCode: true,
    },
  });
  for (const redemption of redemptions) {
    state.fixtureRedemptionIds.add(redemption.id);
    state.registerSensitive(
      redemption.id,
      redemption.shopifyDiscountId,
      redemption.shopifyDiscountCode,
    );
    let discountGid = redemption.shopifyDiscountId;
    if (!discountGid) {
      const remote = await runtime.lookupDiscountByCode(
        state.options.storeDomain,
        state.accessToken,
        redemption.shopifyDiscountCode,
      );
      discountGid = remote?.id ?? null;
    }
    if (discountGid) {
      state.remoteDiscountGids.add(discountGid);
      state.remoteDiscountCodesByGid.set(
        discountGid,
        redemption.shopifyDiscountCode,
      );
      state.registerSensitive(discountGid);
    }
  }
}

async function discoverUncertainFixtureCustomers(
  runtime: Runtime,
  state: HarnessState,
) {
  if (!state.accessToken) return;
  assertCondition(
    state.uncertainFixtureCustomerEmails.size <= 1,
    "Serialized provisioning left more than one uncertain disposable customer outcome.",
  );
  const exactEmailMatches: Array<{
    id: string;
    tags: string[];
    email?: string | null;
  }> = [];
  for (const email of state.uncertainFixtureCustomerEmails) {
    const matches = await reconcileBasicLifecycleDisposableCustomerSearch({
      mode: "unique",
      runMarker: state.runMarker,
      expectedEmail: email,
      pollMs: 1_000,
      maxAttempts: 120,
      lookup: async () => {
        const result: {
          customers: {
            nodes: Array<{
              id: string;
              tags: string[];
              email: string | null;
            }>;
          };
        } = await runtime.shopifyAdminGraphqlRequest({
          shopDomain: state.options.storeDomain,
          accessToken: state.accessToken!,
          query: `query WeleticA1UncertainCustomerByEmail($query: String!) {
            customers(first: 5, query: $query) { nodes { id tags email } }
          }`,
          variables: { query: `email:${email}` },
        });
        return result.customers.nodes;
      },
    });
    exactEmailMatches.push(...matches);
  }
  const stableTagMatches =
    await reconcileBasicLifecycleDisposableCustomerSearch({
      mode: "stable_set",
      runMarker: state.runMarker,
      pollMs: 500,
      maxAttempts: 20,
      lookup: async () => {
        const result: {
          customers: {
            nodes: Array<{ id: string; tags: string[] }>;
            pageInfo: { hasNextPage: boolean };
          };
        } = await runtime.shopifyAdminGraphqlRequest({
          shopDomain: state.options.storeDomain,
          accessToken: state.accessToken!,
          query: `query WeleticA1UncertainCustomerCleanup($query: String!) {
          customers(first: 100, query: $query) {
            nodes { id tags }
            pageInfo { hasNextPage }
          }
        }`,
          variables: {
            query: `tag:${DISPOSABLE_CUSTOMER_TAG} AND tag:${state.runMarker}`,
          },
        });
        assertCondition(
          !result.customers.pageInfo.hasNextPage,
          "The exact fixture customer cleanup query exceeded its bounded result set.",
        );
        return result.customers.nodes;
      },
    });
  const customers = [
    ...new Map(
      [...exactEmailMatches, ...stableTagMatches].map((customer) => [
        customer.id,
        customer,
      ]),
    ).values(),
  ];
  for (const customer of customers) {
    if (
      !customer.tags.includes(DISPOSABLE_CUSTOMER_TAG) ||
      !customer.tags.includes(state.runMarker)
    ) {
      continue;
    }
    assertCondition(
      !state.baselineCustomerGids.has(customer.id),
      "A retained baseline customer matched the disposable run marker; cleanup was stopped.",
    );
    state.remoteCustomerGids.add(customer.id);
    const numericId = customer.id.split("/").at(-1);
    if (numericId) state.fixtureCustomerNumericIds.add(numericId);
    state.registerSensitive(customer.id, numericId);
  }
  if (exactEmailMatches.length > 0) {
    state.uncertainFixtureCustomerEmails.clear();
  }
}

async function cleanupOneRemoteDiscount(
  runtime: Runtime,
  state: HarnessState,
  discountGid: string,
) {
  const discountCode = state.remoteDiscountCodesByGid.get(discountGid);
  assertCondition(
    discountCode,
    "Refusing to delete a Shopify discount without its fixture voucher identity.",
  );
  const owned = await runtime.prisma.weleticRewardRedemption.findFirst({
    where: {
      id: { in: [...state.fixtureRedemptionIds] },
      storeId: state.storeId!,
      accountId: { in: [...state.fixtureAccountIds] },
      rewardDefinitionId: { in: [...state.fixtureRewardIds] },
      idempotencyKey: { startsWith: `a1:${state.runMarker}:` },
      shopifyDiscountCode: discountCode,
    },
    select: {
      id: true,
      accountId: true,
      rewardDefinitionId: true,
      shopifyDiscountCode: true,
      shopifyDiscountId: true,
      metadata: true,
    },
  });
  assertCondition(
    owned,
    "Refusing to delete a Shopify discount without a fixture-owned redemption proof.",
  );
  state.registerSensitive(
    owned.id,
    owned.accountId,
    owned.rewardDefinitionId,
    owned.shopifyDiscountCode,
    owned.shopifyDiscountId,
  );
  assertCondition(
    !owned.shopifyDiscountId || owned.shopifyDiscountId === discountGid,
    "Refusing to mutate a Shopify discount whose persisted identity differs from the fixture proof.",
  );
  const remote = await runtime.lookupDiscountByCode(
    state.options.storeDomain,
    state.accessToken!,
    owned.shopifyDiscountCode,
  );
  const exactBefore: {
    codeDiscountNode: { id: string } | null;
  } = await runtime.shopifyAdminGraphqlRequest({
    shopDomain: state.options.storeDomain,
    accessToken: state.accessToken!,
    query: `query WeleticA1DiscountCleanupProof($id: ID!) {
      codeDiscountNode(id: $id) { id }
    }`,
    variables: { id: discountGid },
  });
  if (!exactBefore.codeDiscountNode) return;
  assertCondition(
    exactBefore.codeDiscountNode.id === discountGid,
    "Refusing to mutate a Shopify discount whose exact live GID differs from the fixture proof.",
  );
  if (remote) {
    state.registerSensitive(remote.id, remote.code, remote.title);
    assertCondition(
      remote.id === discountGid,
      "Refusing to mutate a Shopify discount whose live identity differs from the fixture proof.",
    );
    const cleanup = await runtime.prisma.weleticShopifyVoucherCleanup.findFirst(
      {
        where: {
          id: { in: [...state.fixtureCleanupIds] },
          storeId: state.storeId!,
          redemptionId: owned.id,
          source: "customer_redact",
          requestLinks: {
            some: {
              requestId: { in: [...state.fixtureComplianceRequestIds] },
            },
          },
        },
        include: {
          requestLinks: {
            include: {
              request: {
                select: {
                  id: true,
                  storeId: true,
                  requestType: true,
                  status: true,
                  phase: true,
                  completedAt: true,
                  payloadCiphertext: true,
                },
              },
            },
          },
        },
      },
    );
    if (cleanup) {
      if (!owned.accountId)
        throw new Error("Expected an account-backed lifecycle fixture.");
      const identity = {
        storeId: state.storeId!,
        redemptionId: owned.id,
        accountId: owned.accountId,
        rewardDefinitionId: owned.rewardDefinitionId,
        discountCode: owned.shopifyDiscountCode,
      };
      assertBasicLifecycleCompletedVoucherCleanupOwnership({
        storeId: state.storeId!,
        redemption: {
          id: owned.id,
          accountId: owned.accountId,
          rewardDefinitionId: owned.rewardDefinitionId,
          shopifyDiscountCode: owned.shopifyDiscountCode,
        },
        discountGid,
        expectedOwnershipFingerprint:
          runtime.getLoyaltyDiscountOwnershipFingerprint(identity),
        cleanup,
        requestLinks: cleanup.requestLinks,
        fixtureCleanupIds: state.fixtureCleanupIds,
        fixtureRequestIds: state.fixtureComplianceRequestIds,
        remote,
      });
    } else {
      if (!owned.accountId)
        throw new Error("Expected an account-backed lifecycle fixture.");
      runtime.assertExpectedLoyaltyDiscountNode({
        identity: {
          storeId: state.storeId!,
          redemptionId: owned.id,
          accountId: owned.accountId,
          rewardDefinitionId: owned.rewardDefinitionId,
          discountCode: owned.shopifyDiscountCode,
        },
        metadata: owned.metadata,
        remote,
      });
    }
  }
  await runtime
    .deactivateDiscount(
      state.options.storeDomain,
      state.accessToken!,
      discountGid,
    )
    .catch(() => undefined);
  let deleteError: unknown;
  try {
    await runtime.deleteDiscount(
      state.options.storeDomain,
      state.accessToken!,
      discountGid,
    );
  } catch (error) {
    deleteError = error;
  }
  const exactReadback: {
    codeDiscountNode: { id: string } | null;
  } = await runtime.shopifyAdminGraphqlRequest({
    shopDomain: state.options.storeDomain,
    accessToken: state.accessToken!,
    query: `query WeleticA1DiscountDeletionReadback($id: ID!) {
      codeDiscountNode(id: $id) { id }
    }`,
    variables: { id: discountGid },
  });
  if (exactReadback.codeDiscountNode) {
    if (deleteError) throw deleteError;
  }
  assertBasicLifecycleExactDiscountDeleted(
    discountGid,
    exactReadback.codeDiscountNode,
  );
}

async function cleanupRemoteDiscounts(runtime: Runtime, state: HarnessState) {
  if (!state.storeId || !state.accessToken) return;
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const errors: string[] = [];
  try {
    await discoverUncertainFixtureDiscounts(runtime, state);
  } catch (error) {
    errors.push(state.safeError(error));
  }
  for (const discountGid of state.remoteDiscountGids) {
    try {
      await cleanupOneRemoteDiscount(runtime, state, discountGid);
    } catch (error) {
      errors.push(state.safeError(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Remote fixture discount cleanup had ${errors.length} failure(s): ${errors.join(" | ")}`,
    );
  }
}

async function cleanupOneRemoteCustomer(
  runtime: Runtime,
  state: HarnessState,
  customerGid: string,
) {
  assertCondition(
    !state.baselineCustomerGids.has(customerGid),
    "Refusing to delete a retained Shopify customer from the baseline denylist.",
  );
  const customerId = String(numericCustomerId(customerGid));
  return runBasicLifecycleCustomerDeleteBarrier({
    waitForTerminalIngress: async () => {
      await assertRegisteredCustomerCreateAuditAssignment(
        runtime,
        state,
        customerGid,
      );
      await reconcileFixtureCustomerLocalProjections(
        runtime,
        state,
        new Set([customerId]),
      );
    },
    withCustomerLock: (task) =>
      withFixtureCustomerSettlementLocks(runtime, state, customerGid, task),
    revalidateInsideLock: async () => {
      await assertRegisteredCustomerCreateAuditAssignment(
        runtime,
        state,
        customerGid,
      );
      await reconcileFixtureCustomerLocalProjections(
        runtime,
        state,
        new Set([customerId]),
      );
    },
    deleteAndConfirmInsideLock: async () => {
      const lookup: {
        customer: { id: string; tags: string[] } | null;
      } = await runtime.shopifyAdminGraphqlRequest({
        shopDomain: state.options.storeDomain,
        accessToken: state.accessToken!,
        query: `query WeleticA1CustomerCleanupProof($id: ID!) {
          customer(id: $id) { id tags }
        }`,
        variables: { id: customerGid },
      });
      if (!lookup.customer) return;
      assertCondition(
        lookup.customer.id === customerGid &&
          lookup.customer.tags.includes(DISPOSABLE_CUSTOMER_TAG) &&
          lookup.customer.tags.includes(state.runMarker),
        "Refusing to delete a Shopify customer without both disposable fixture tags.",
      );
      let deleted: {
        customerDelete: {
          deletedCustomerId: string | null;
          userErrors: Array<{ message: string }>;
        };
      };
      try {
        deleted = await runtime.shopifyAdminGraphqlRequest({
          shopDomain: state.options.storeDomain,
          accessToken: state.accessToken!,
          query: `mutation WeleticA1CustomerDelete($input: CustomerDeleteInput!) {
            customerDelete(input: $input) {
              deletedCustomerId
              userErrors { field message }
            }
          }`,
          variables: { input: { id: customerGid } },
          postDispatchOutcomeUnknown: true,
        });
      } catch (error) {
        const reconciled: { customer: { id: string } | null } =
          await runtime.shopifyAdminGraphqlRequest({
            shopDomain: state.options.storeDomain,
            accessToken: state.accessToken!,
            query: `query WeleticA1CustomerDeleteReconcile($id: ID!) {
              customer(id: $id) { id }
            }`,
            variables: { id: customerGid },
          });
        if (reconciled.customer) throw error;
        deleted = {
          customerDelete: { deletedCustomerId: customerGid, userErrors: [] },
        };
      }
      assertCondition(
        deleted.customerDelete.userErrors.length === 0 &&
          deleted.customerDelete.deletedCustomerId === customerGid,
        "Shopify did not confirm disposable customer deletion.",
      );
      const exactReadback: { customer: { id: string } | null } =
        await runtime.shopifyAdminGraphqlRequest({
          shopDomain: state.options.storeDomain,
          accessToken: state.accessToken!,
          query: `query WeleticA1CustomerDeletionReadback($id: ID!) {
            customer(id: $id) { id }
          }`,
          variables: { id: customerGid },
        });
      assertBasicLifecycleExactCustomerDeleted(
        customerGid,
        exactReadback.customer,
      );
    },
  });
}

async function cleanupRemoteCustomers(runtime: Runtime, state: HarnessState) {
  if (!state.accessToken) return;
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  assertCondition(
    state.fixtureCustomerIngressReconciled,
    "Remote customer cleanup is blocked until every registered customers/create delivery and local projection is terminal.",
  );
  await reconcileFixtureCustomerIngress(runtime, state);
  state.fixtureCustomerIngressReconciled = true;
  const errors: string[] = [];
  for (const customerGid of state.remoteCustomerGids) {
    try {
      await cleanupOneRemoteCustomer(runtime, state, customerGid);
    } catch (error) {
      errors.push(state.safeError(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Remote fixture customer cleanup had ${errors.length} failure(s): ${errors.join(" | ")}`,
    );
  }
}

async function cleanupCheckoutCaches(runtime: Runtime, state: HarnessState) {
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const errors: string[] = [];
  for (const checkoutToken of state.fixtureCheckoutTokens) {
    try {
      const identity = state.fixtureCheckoutCacheByToken.get(checkoutToken);
      assertCondition(
        identity && state.storeId,
        "Exact checkout-cache store/customer ownership is unavailable.",
      );
      await runtime.deleteExactIndexedShopifyCheckoutCache({
        checkoutToken,
        storeId: state.storeId,
        customerId: identity.customerId,
      });
    } catch (error) {
      errors.push(state.safeError(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Fixture checkout-cache cleanup had ${errors.length} failure(s): ${errors.join(" | ")}`,
    );
  }
}

async function cleanupLocalFixtures(runtime: Runtime, state: HarnessState) {
  if (!state.storeId) return;
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  await discoverUncertainLocalFixtures(runtime, state);
  await collectFixtureOutboxIds(runtime, state);
  await quiesceFixtureOutboxJobs(runtime, state);
  await discoverFixtureReconciliationIssues(runtime, state);

  for (const id of state.fixtureRuleIds) {
    assertCondition(
      !state.baselineRuleIds.has(id),
      "Refusing to delete a baseline earning rule.",
    );
  }
  for (const id of state.fixtureReferralRuleIds) {
    assertCondition(
      !state.baselineReferralRuleIds.has(id),
      "Refusing to delete a baseline referral rule.",
    );
  }
  for (const id of state.fixtureTierIds) {
    assertCondition(
      !state.baselineTierIds.has(id),
      "Refusing to delete a baseline VIP tier.",
    );
  }
  for (const id of state.fixtureRewardIds) {
    assertCondition(
      !state.baselineRewardIds.has(id),
      "Refusing to delete a baseline reward.",
    );
  }

  const orders = await runtime.prisma.weleticCommerceOrder.findMany({
    where: {
      storeId: state.storeId,
      externalId: { in: [...state.fixtureOrderExternalIds] },
    },
    include: {
      fxRateSnapshot: { select: { id: true } },
      lines: { select: { id: true } },
      refunds: {
        select: {
          id: true,
          fxRateSnapshot: { select: { id: true } },
          lines: { select: { id: true } },
        },
      },
      loyaltyEarnGrants: { select: { id: true } },
    },
  });
  const orderIds = orders.map(({ id }) => id);
  const orderLineIds = orders.flatMap(({ lines }) => lines.map(({ id }) => id));
  const refundIds = orders.flatMap(({ refunds }) =>
    refunds.map(({ id }) => id),
  );
  const refundLineIds = orders.flatMap(({ refunds }) =>
    refunds.flatMap(({ lines }) => lines.map(({ id }) => id)),
  );
  const grantIds = orders.flatMap(({ loyaltyEarnGrants }) =>
    loyaltyEarnGrants.map(({ id }) => id),
  );
  for (const snapshotId of orders.flatMap((order) => [
    ...(order.fxRateSnapshot ? [order.fxRateSnapshot.id] : []),
    ...order.refunds.flatMap((refund) =>
      refund.fxRateSnapshot ? [refund.fxRateSnapshot.id] : [],
    ),
  ])) {
    state.fixtureFxRateSnapshotIds.add(snapshotId);
    state.registerSensitive(snapshotId);
  }
  if (state.fixtureFxRateSnapshotIds.size > 0) {
    const snapshots = await runtime.prisma.weleticFxRateSnapshot.findMany({
      where: { id: { in: [...state.fixtureFxRateSnapshotIds] } },
      select: {
        id: true,
        orders: { select: { id: true } },
        refunds: { select: { id: true } },
        payoutQuotes: { select: { id: true } },
      },
    });
    const exactOrderIds = new Set(orderIds);
    const exactRefundIds = new Set(refundIds);
    assertBasicLifecycleFxSnapshotOwnership({
      snapshotIds: state.fixtureFxRateSnapshotIds,
      baselineIds: state.baselineFxRateSnapshotIds,
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        orderIds: snapshot.orders.map(({ id }) => id),
        refundIds: snapshot.refunds.map(({ id }) => id),
        payoutQuoteCount: snapshot.payoutQuotes.length,
      })),
      exactOrderIds,
      exactRefundIds,
    });
  }
  [
    ...orderIds,
    ...orderLineIds,
    ...refundIds,
    ...refundLineIds,
    ...grantIds,
  ].forEach((id) => state.registerSensitive(id));

  if (orderLineIds.length > 0 || refundLineIds.length > 0) {
    const unexpectedCalculations =
      await runtime.prisma.weleticCommissionCalculation.findMany({
        where: {
          OR: [
            ...(orderLineIds.length > 0
              ? [{ orderLineId: { in: orderLineIds } }]
              : []),
            ...(refundLineIds.length > 0
              ? [{ refundLineId: { in: refundLineIds } }]
              : []),
          ],
        },
        select: { id: true, commissionId: true },
      });
    for (const calculation of unexpectedCalculations) {
      state.fixtureCommissionCalculationIds.add(calculation.id);
      state.registerSensitive(calculation.id, calculation.commissionId);
      if (calculation.commissionId) {
        state.fixtureCommissionIds.add(calculation.commissionId);
      }
    }
    assertCondition(
      unexpectedCalculations.length === 0,
      "A disposable loyalty order unexpectedly entered partner commission accounting; cleanup was stopped.",
    );
  }

  const accountIds = [...state.fixtureAccountIds];
  const shopperIds = [...state.fixtureShopperIds];
  const requestIds = [...state.fixtureComplianceRequestIds];
  const cleanupIds = [...state.fixtureCleanupIds];
  const outboxIds = [...state.fixtureOutboxIds];
  assertCondition(
    outboxIds.every((id) => !state.baselineOutboxJobIds.has(id)),
    "Refusing to delete a retained pre-run outbox job.",
  );
  await withHarnessStoreMutation(
    runtime,
    state,
    "a1_delete_fixture_local_rows",
    async (tx: any) => {
      const exactOutboxRows =
        outboxIds.length === 0
          ? []
          : await tx.weleticLoyaltyOutboxJob.findMany({
              where: { storeId: state.storeId, id: { in: outboxIds } },
            });
      assertCondition(
        exactOutboxRows.length === outboxIds.length &&
          exactOutboxRows.every(({ status }: { status: string }) =>
            ["completed", "cancelled", "dead_letter"].includes(status),
          ),
        "A fixture outbox row is missing or non-terminal inside the cleanup transaction.",
      );
      assertOwnedFixtureOutboxRows(state, exactOutboxRows);
      const [
        referralTreeAccounts,
        fixtureReferrals,
        tierAccounts,
        tierHistories,
        rewardRedemptions,
        definitionGrants,
        storeLedgerEntries,
        referralRulesUsingFixtureRewards,
      ] = await Promise.all([
        tx.weleticLoyaltyAccount.findMany({
          where: {
            storeId: state.storeId,
            OR: [
              { id: { in: accountIds } },
              { referredById: { in: accountIds } },
            ],
          },
          select: { id: true, referredById: true },
        }),
        tx.weleticLoyaltyReferral.findMany({
          where: {
            storeId: state.storeId,
            OR: [
              { advocateAccountId: { in: accountIds } },
              { refereeAccountId: { in: accountIds } },
            ],
          },
          select: { id: true, advocateAccountId: true, refereeAccountId: true },
        }),
        tx.weleticLoyaltyAccount.findMany({
          where: {
            storeId: state.storeId,
            currentTierId: { in: [...state.fixtureTierIds] },
          },
          select: { id: true },
        }),
        tx.weleticLoyaltyTierHistory.findMany({
          where: {
            OR: [
              { fromTierId: { in: [...state.fixtureTierIds] } },
              { toTierId: { in: [...state.fixtureTierIds] } },
            ],
          },
          select: { id: true, accountId: true },
        }),
        tx.weleticRewardRedemption.findMany({
          where: {
            storeId: state.storeId,
            rewardDefinitionId: { in: [...state.fixtureRewardIds] },
          },
          select: { id: true, accountId: true },
        }),
        tx.weleticLoyaltyEarnGrant.findMany({
          where: {
            storeId: state.storeId,
            OR: [
              { selectedRuleId: { in: [...state.fixtureRuleIds] } },
              { tierId: { in: [...state.fixtureTierIds] } },
            ],
          },
          select: { id: true, accountId: true },
        }),
        tx.weleticPointsLedgerEntry.findMany({
          where: { storeId: state.storeId },
          select: {
            id: true,
            accountId: true,
            referenceId: true,
            metadata: true,
          },
        }),
        tx.weleticLoyaltyReferralRule.findMany({
          where: {
            programId: state.programId,
            OR: [
              {
                advocateRewardDefinitionId: {
                  in: [...state.fixtureRewardIds],
                },
              },
              {
                refereeRewardDefinitionId: {
                  in: [...state.fixtureRewardIds],
                },
              },
            ],
          },
          select: { id: true },
        }),
      ]);
      assertBasicLifecycleReferralCleanupOwnership({
        fixtureAccountIds: state.fixtureAccountIds,
        accountPointers: referralTreeAccounts,
        referrals: fixtureReferrals,
      });
      const exactDefinitionValues = new Set([
        ...state.fixtureRuleIds,
        ...state.fixtureTierIds,
        ...state.fixtureRewardIds,
        ...state.fixtureReferralRuleIds,
      ]);
      const ledgerDefinitionReferences = storeLedgerEntries.filter(
        (entry: { referenceId: string | null; metadata: unknown }) =>
          (entry.referenceId !== null &&
            exactDefinitionValues.has(entry.referenceId)) ||
          jsonContainsExactValue(entry.metadata, exactDefinitionValues),
      );
      const fixtureGrantIds = new Set(grantIds);
      assertBasicLifecycleTemporaryDefinitionReferenceOwnership({
        fixtureAccountIds: state.fixtureAccountIds,
        references: [
          ...tierAccounts.map((account: { id: string }) => ({
            family: "tier account",
            rowId: account.id,
            accountId: account.id,
            exactFixtureRow: state.fixtureAccountIds.has(account.id),
          })),
          ...tierHistories.map(
            (history: { id: string; accountId: string }) => ({
              family: "tier history",
              rowId: history.id,
              accountId: history.accountId,
              exactFixtureRow: state.fixtureAccountIds.has(history.accountId),
            }),
          ),
          ...rewardRedemptions.map(
            (redemption: { id: string; accountId: string }) => ({
              family: "reward redemption",
              rowId: redemption.id,
              accountId: redemption.accountId,
              exactFixtureRow: state.fixtureRedemptionIds.has(redemption.id),
            }),
          ),
          ...definitionGrants.map(
            (grant: { id: string; accountId: string }) => ({
              family: "earning grant",
              rowId: grant.id,
              accountId: grant.accountId,
              exactFixtureRow: fixtureGrantIds.has(grant.id),
            }),
          ),
          ...ledgerDefinitionReferences.map(
            (entry: { id: string; accountId: string }) => ({
              family: "points ledger metadata",
              rowId: entry.id,
              accountId: entry.accountId,
              exactFixtureRow: state.fixtureAccountIds.has(entry.accountId),
            }),
          ),
        ],
      });
      assertCondition(
        referralRulesUsingFixtureRewards.every(({ id }: { id: string }) =>
          state.fixtureReferralRuleIds.has(id),
        ),
        "A retained referral rule references a temporary reward; no temporary definition was deleted and the maintenance lease remains active.",
      );
      for (const { id, accountId } of tierHistories) {
        state.registerSensitive(id, accountId);
      }
      for (const { id } of fixtureReferrals) state.registerSensitive(id);

      if (state.fixtureReconciliationIssueIds.size > 0) {
        await tx.weleticReconciliationIssue.deleteMany({
          where: {
            storeId: state.storeId,
            id: { in: [...state.fixtureReconciliationIssueIds] },
          },
        });
      }
      if (tierHistories.length > 0) {
        const deletedTierHistories =
          await tx.weleticLoyaltyTierHistory.deleteMany({
            where: {
              id: { in: tierHistories.map(({ id }: { id: string }) => id) },
            },
          });
        assertBasicLifecycleExactDeleteCount({
          family: "temporary-tier histories",
          expected: tierHistories.length,
          actual: deletedTierHistories.count,
        });
      }
      if (cleanupIds.length > 0) {
        await tx.weleticShopifyVoucherCleanupRequestLink.deleteMany({
          where: { storeId: state.storeId, cleanupId: { in: cleanupIds } },
        });
        await tx.weleticShopifyVoucherCleanup.deleteMany({
          where: { storeId: state.storeId, id: { in: cleanupIds } },
        });
      }
      if (requestIds.length > 0) {
        await tx.weleticShopifyCustomerPrivacyTombstone.deleteMany({
          where: {
            storeId: state.storeId,
            id: { in: [...state.fixtureCustomerPrivacyTombstoneIds] },
          },
        });
        await tx.weleticShopifyShopPrivacyTombstone.deleteMany({
          where: {
            storeId: state.storeId,
            id: { in: [...state.fixtureShopPrivacyTombstoneIds] },
          },
        });
        await tx.weleticShopifyComplianceArtifact.deleteMany({
          where: { storeId: state.storeId, requestId: { in: requestIds } },
        });
        await tx.weleticShopifyComplianceRequest.deleteMany({
          where: { storeId: state.storeId, id: { in: requestIds } },
        });
      }
      if (outboxIds.length > 0) {
        const deletedOutbox = await tx.weleticLoyaltyOutboxJob.deleteMany({
          where: {
            storeId: state.storeId,
            OR: exactOutboxRows.map(
              (row: {
                id: string;
                status: string;
                attempts: number;
                updatedAt: Date;
              }) => ({
                id: row.id,
                status: row.status,
                attempts: row.attempts,
                updatedAt: row.updatedAt,
              }),
            ),
          },
        });
        assertBasicLifecycleExactDeleteCount({
          family: "fixture outbox jobs",
          expected: outboxIds.length,
          actual: deletedOutbox.count,
        });
      }
      if (accountIds.length > 0) {
        await tx.weleticLoyaltyAccount.updateMany({
          where: {
            storeId: state.storeId,
            id: { in: accountIds },
            referredById: { not: null },
          },
          data: { referredById: null },
        });
        await tx.weleticLoyaltyReferral.deleteMany({
          where: {
            storeId: state.storeId,
            OR: [
              { advocateAccountId: { in: accountIds } },
              { refereeAccountId: { in: accountIds } },
            ],
          },
        });
        await tx.weleticLoyaltyTierHistory.deleteMany({
          where: { accountId: { in: accountIds } },
        });
        await tx.weleticRewardRedemption.deleteMany({
          where: { storeId: state.storeId, accountId: { in: accountIds } },
        });
        await tx.weleticPointsLedgerEntry.deleteMany({
          where: { storeId: state.storeId, accountId: { in: accountIds } },
        });
        await tx.weleticLoyaltyBackfillPreviewItem.deleteMany({
          where: { accountId: { in: accountIds } },
        });
      }
      if (grantIds.length > 0) {
        await tx.weleticLoyaltyOrderLineEarn.deleteMany({
          where: { storeId: state.storeId, grantId: { in: grantIds } },
        });
        await tx.weleticLoyaltyEarnGrant.deleteMany({
          where: { storeId: state.storeId, id: { in: grantIds } },
        });
      }
      if (refundIds.length > 0) {
        await tx.weleticCommerceRefundLine.deleteMany({
          where: { refundId: { in: refundIds } },
        });
        await tx.weleticCommerceRefund.deleteMany({
          where: { storeId: state.storeId, id: { in: refundIds } },
        });
      }
      if (orderLineIds.length > 0) {
        await tx.weleticCommerceOrderLine.deleteMany({
          where: { id: { in: orderLineIds } },
        });
      }
      if (orderIds.length > 0) {
        await tx.weleticCommerceOrder.deleteMany({
          where: { storeId: state.storeId, id: { in: orderIds } },
        });
      }
      if (state.fixtureFxRateSnapshotIds.size > 0) {
        const deletedSnapshots = await tx.weleticFxRateSnapshot.deleteMany({
          where: {
            id: { in: [...state.fixtureFxRateSnapshotIds] },
            orders: { none: {} },
            refunds: { none: {} },
            payoutQuotes: { none: {} },
          },
        });
        assertCondition(
          deletedSnapshots.count === state.fixtureFxRateSnapshotIds.size,
          "Not every exact unreferenced fixture FX snapshot was deleted.",
        );
      }
      if (accountIds.length > 0) {
        const deletedAccounts = await tx.weleticLoyaltyAccount.deleteMany({
          where: { storeId: state.storeId, id: { in: accountIds } },
        });
        assertBasicLifecycleExactDeleteCount({
          family: "fixture loyalty accounts",
          expected: accountIds.length,
          actual: deletedAccounts.count,
        });
      }
      if (shopperIds.length > 0) {
        const deletedShoppers = await tx.weleticShopper.deleteMany({
          where: { storeId: state.storeId, id: { in: shopperIds } },
        });
        assertBasicLifecycleExactDeleteCount({
          family: "fixture shoppers",
          expected: shopperIds.length,
          actual: deletedShoppers.count,
        });
      }
      if (state.webhookIds.size > 0) {
        await tx.weleticShopifyWebhookEvent.deleteMany({
          where: {
            storeId: state.storeId,
            webhookId: { in: [...state.webhookIds] },
          },
        });
      }
      if (state.fixtureRewardIds.size > 0) {
        const deletedRewards = await tx.weleticRewardDefinition.deleteMany({
          where: {
            storeId: state.storeId,
            id: { in: [...state.fixtureRewardIds] },
          },
        });
        assertBasicLifecycleExactDeleteCount({
          family: "temporary rewards",
          expected: state.fixtureRewardIds.size,
          actual: deletedRewards.count,
        });
      }
      if (state.fixtureTierIds.size > 0) {
        const deletedTiers = await tx.weleticLoyaltyTier.deleteMany({
          where: {
            programId: state.programId,
            id: { in: [...state.fixtureTierIds] },
          },
        });
        assertBasicLifecycleExactDeleteCount({
          family: "temporary tiers",
          expected: state.fixtureTierIds.size,
          actual: deletedTiers.count,
        });
      }
      if (state.fixtureRuleIds.size > 0) {
        const deletedRules = await tx.weleticLoyaltyEarningRule.deleteMany({
          where: {
            programId: state.programId,
            id: { in: [...state.fixtureRuleIds] },
          },
        });
        assertBasicLifecycleExactDeleteCount({
          family: "temporary earning rules",
          expected: state.fixtureRuleIds.size,
          actual: deletedRules.count,
        });
      }
      if (state.fixtureReferralRuleIds.size > 0) {
        const deletedReferralRules =
          await tx.weleticLoyaltyReferralRule.deleteMany({
            where: {
              programId: state.programId,
              id: { in: [...state.fixtureReferralRuleIds] },
            },
          });
        assertBasicLifecycleExactDeleteCount({
          family: "temporary referral rules",
          expected: state.fixtureReferralRuleIds.size,
          actual: deletedReferralRules.count,
        });
      }
      await runtime.publishLoyaltyEarnPolicyRevision({
        tx,
        storeId: state.storeId!,
        programId: state.programId!,
        reason: "a1_fixture_policy_definitions_removed",
      });
    },
  );
}

async function cleanupPostLocalFixtureOutbox(
  runtime: Runtime,
  state: HarnessState,
  timeoutMs = 240_000,
) {
  if (!state.storeId) return;
  const deadline = Date.now() + timeoutMs;
  let stableZeroPasses = 0;
  while (Date.now() < deadline) {
    await quiesceFixtureOutboxJobs(
      runtime,
      state,
      Math.max(1, deadline - Date.now()),
    );
    await collectFixtureOutboxIds(runtime, state);
    const exactIds = [...state.fixtureOutboxIds];
    assertCondition(
      exactIds.every((id) => !state.baselineOutboxJobIds.has(id)),
      "Refusing to delete a retained pre-run outbox job.",
    );
    if (exactIds.length > 0) {
      const exactRows = await runtime.prisma.weleticLoyaltyOutboxJob.findMany({
        where: { storeId: state.storeId, id: { in: exactIds } },
      });
      assertCondition(
        exactRows.length === exactIds.length,
        "A post-local fixture outbox row disappeared before cleanup.",
      );
      assertOwnedFixtureOutboxRows(state, exactRows);
      const terminalIds = exactRows
        .filter(({ status }) =>
          ["completed", "cancelled", "dead_letter"].includes(status),
        )
        .map(({ id }) => id);
      assertCondition(
        terminalIds.length === exactRows.length,
        "Post-local fixture outbox cleanup found a non-terminal exact job and refused deletion.",
      );
      const deleted = await withHarnessStoreMutation<{ count: number }>(
        runtime,
        state,
        "a1_delete_post_local_fixture_outbox",
        async (tx) => {
          const currentRows = await tx.weleticLoyaltyOutboxJob.findMany({
            where: {
              storeId: state.storeId!,
              id: { in: terminalIds },
            },
          });
          assertCondition(
            currentRows.length === terminalIds.length &&
              currentRows.every(({ status }: { status: string }) =>
                ["completed", "cancelled", "dead_letter"].includes(status),
              ),
            "A post-local fixture outbox row changed before exact deletion.",
          );
          assertOwnedFixtureOutboxRows(state, currentRows);
          return tx.weleticLoyaltyOutboxJob.deleteMany({
            where: {
              storeId: state.storeId!,
              OR: currentRows.map(
                (row: {
                  id: string;
                  status: string;
                  attempts: number;
                  updatedAt: Date;
                }) => ({
                  id: row.id,
                  status: row.status,
                  attempts: row.attempts,
                  updatedAt: row.updatedAt,
                }),
              ),
            },
          });
        },
        "database",
      );
      assertCondition(
        deleted.count === terminalIds.length,
        "An exact post-local outbox job changed status before terminal deletion; cleanup stopped.",
      );
    }
    await collectFixtureOutboxIds(runtime, state);
    const residueCount = await runtime.prisma.weleticLoyaltyOutboxJob.count({
      where: {
        storeId: state.storeId,
        id: { in: [...state.fixtureOutboxIds] },
      },
    });
    stableZeroPasses = residueCount === 0 ? stableZeroPasses + 1 : 0;
    if (stableZeroPasses >= 2) {
      await quiesceFixtureOutboxJobs(
        runtime,
        state,
        Math.max(1, deadline - Date.now()),
      );
      await collectFixtureOutboxIds(runtime, state);
      const finalCount = await runtime.prisma.weleticLoyaltyOutboxJob.count({
        where: {
          storeId: state.storeId,
          id: { in: [...state.fixtureOutboxIds] },
        },
      });
      if (finalCount === 0) return;
      stableZeroPasses = 0;
    }
    await delay(250);
  }
  throw new Error(
    "Timed out deleting exact post-local fixture outbox work to a stable zero fixed point.",
  );
}

function programSnapshotMatches(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  return Object.entries(snapshot).every(
    ([key, expected]) =>
      canonicalDigest(current[key]) === canonicalDigest(expected),
  );
}

function programSnapshotMatchesUnderMaintenanceLease(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
  maintenanceLeaseMetadata: unknown,
) {
  return (
    Object.entries(snapshot).every(
      ([key, expected]) =>
        key === "metadata" ||
        canonicalDigest(current[key]) === canonicalDigest(expected),
    ) &&
    canonicalDigest(current.metadata) ===
      canonicalDigest(maintenanceLeaseMetadata)
  );
}

function sameOptionalDate(left: Date | null, right: Date | null) {
  return left === null
    ? right === null
    : right !== null && left.getTime() === right.getTime();
}

async function verifyZeroResidueOnce(runtime: Runtime, state: HarnessState) {
  if (!state.storeId || !state.programId || !state.programSnapshot) return;
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  await captureRegisteredCustomerCreateAuditEvidence(
    runtime,
    state,
    state.remoteCustomerGids.size,
  );
  await discoverUncertainLocalFixtures(runtime, state);
  await collectFixtureOutboxIds(runtime, state);
  assertCondition(
    !state.configMutated &&
      !state.programMutationDispatched &&
      !state.programMutationUncertain &&
      !state.lastHarnessProgramUpdatedAt,
    "The temporary program configuration was not CAS-restored.",
  );
  assertBasicLifecycleFinalCleanupPrerequisites({
    localFixtureCleanupComplete: state.localFixtureCleanupComplete,
    fixtureOutboxQuiescedAfterLocalCleanup:
      state.fixtureOutboxQuiescedAfterLocalCleanup,
  });

  const remoteCustomers: {
    customers: {
      nodes: Array<{ id: string; tags: string[] }>;
      pageInfo: { hasNextPage: boolean };
    };
  } = await runtime.shopifyAdminGraphqlRequest({
    shopDomain: state.options.storeDomain,
    accessToken: state.accessToken!,
    query: `query WeleticA1CustomerResidue($query: String!) {
      customers(first: 100, query: $query) {
        nodes { id tags }
        pageInfo { hasNextPage }
      }
    }`,
    variables: {
      query: `tag:${DISPOSABLE_CUSTOMER_TAG} AND tag:${state.runMarker}`,
    },
  });
  assertCondition(
    !remoteCustomers.customers.pageInfo.hasNextPage &&
      remoteCustomers.customers.nodes.length === 0,
    "A disposable Shopify customer from this run remains after cleanup.",
  );
  const finalCustomerGids = await listAllCustomerGids(runtime, state);
  assertCondition(
    finalCustomerGids.size === state.baselineCustomerGids.size &&
      [...finalCustomerGids].every((gid) =>
        state.baselineCustomerGids.has(gid),
      ),
    "The final Shopify customer set differs from the exact pre-run baseline.",
  );
  for (const code of state.fixtureDiscountCodes) {
    const discount = await runtime.lookupDiscountByCode(
      state.options.storeDomain,
      state.accessToken!,
      code,
    );
    assertCondition(
      !discount,
      "A disposable Shopify voucher from this run remains after cleanup.",
    );
  }
  for (const discountGid of state.remoteDiscountGids) {
    const exactReadback: {
      codeDiscountNode: { id: string } | null;
    } = await runtime.shopifyAdminGraphqlRequest({
      shopDomain: state.options.storeDomain,
      accessToken: state.accessToken!,
      query: `query WeleticA1DiscountResidueReadback($id: ID!) {
        codeDiscountNode(id: $id) { id }
      }`,
      variables: { id: discountGid },
    });
    assertBasicLifecycleExactDiscountDeleted(
      discountGid,
      exactReadback.codeDiscountNode,
    );
  }

  const customerCreateAuditRows =
    await runtime.prisma.weleticShopifyWebhookEvent.findMany({
      where: { storeId: state.storeId, topic: "customers/create" },
      select: {
        webhookId: true,
        payload: true,
        authenticatedBodyDigest: true,
        storeInstallationGeneration: true,
        status: true,
        processedAt: true,
        error: true,
      },
    });
  const retainedRegisteredRows = customerCreateAuditRows.filter(
    ({ authenticatedBodyDigest }) =>
      authenticatedBodyDigest &&
      state.registeredCustomerCreateAuditBodyDigests.has(
        authenticatedBodyDigest,
      ),
  );
  assertCondition(
    customerCreateAuditRows.length >=
      state.baselineCustomerCreateAuditCount +
        state.registeredCustomerCreateAuditCount &&
      customerCreateAuditRows.filter(({ payload }) => payload !== null)
        .length === state.baselineCustomerCreateNonNullPayloadCount &&
      retainedRegisteredRows.length ===
        state.registeredCustomerCreateAuditCount &&
      state.registeredCustomerCreateAuditByCustomerGid.size ===
        state.remoteCustomerGids.size &&
      [...state.remoteCustomerGids].every((customerGid) => {
        const assignment =
          state.registeredCustomerCreateAuditByCustomerGid.get(customerGid);
        return Boolean(
          assignment &&
            retainedRegisteredRows.some(
              (row) =>
                row.webhookId === assignment.webhookId &&
                row.authenticatedBodyDigest === assignment.bodyDigest,
            ),
        );
      }) &&
      retainedRegisteredRows.every((row) =>
        isTerminalCustomerCreateAuditEvidence(
          row,
          state.installationGeneration,
        ),
      ),
    "Intentionally retained customers/create audit evidence is missing or no longer authenticated, generation-fenced, terminal, error-free, and payload-free.",
  );
  if (state.retainedPrivacyFenceCustomerIds.size > 0) {
    const fenceAudits = await Promise.all(
      [...state.retainedPrivacyFenceCustomerIds].map((customerId) =>
        runtime.auditShopifyCustomerPrivacyFences({
          storeId: state.storeId!,
          customerId,
        }),
      ),
    );
    assertCondition(
      fenceAudits.reduce((total, audit) => total + audit.fenceCount, 0) ===
        state.retainedPrivacyFenceCount &&
        fenceAudits.every((audit) => audit.allTtlValid),
      "Intentionally retained keyed-HMAC privacy fences are missing or have invalid TTLs.",
    );
  }

  const program = await runtime.prisma.weleticLoyaltyProgram.findUnique({
    where: { id: state.programId },
    select: {
      name: true,
      status: true,
      pointNameSingular: true,
      pointNamePlural: true,
      pointsPerCurrencyUnit: true,
      holdingPeriodDays: true,
      pointsExpiryMonths: true,
      killSwitchActive: true,
      activatedAt: true,
      disabledAt: true,
      enableOnlineStoreLauncher: true,
      enableCustomerAccountHub: true,
      enableCheckoutExtension: true,
      enableProductPointsWidget: true,
      enableMetafieldsSync: true,
      surfaceFlags: true,
      vipMilestoneMode: true,
      vipTimeframe: true,
      vipDowngradeGraceDays: true,
      vipAutoDowngradeEnabled: true,
      branding: true,
      metadata: true,
    },
  });
  assertCondition(
    state.programOwnedFieldDriftKeys.size === 0 &&
      program &&
      state.maintenanceLeaseAcquired &&
      !state.maintenanceLeaseReleased &&
      state.maintenancePermit &&
      programSnapshotMatchesUnderMaintenanceLease(
        state.programSnapshot,
        program,
        state.maintenanceLeaseMetadata,
      ),
    "The loyalty program does not match its pre-run snapshot plus the exact harness-owned maintenance lease.",
  );
  runtime.assertLoyaltyMaintenanceWriteAllowed({
    storeId: state.storeId,
    metadata: program.metadata,
    permit: state.maintenancePermit,
  });

  const retainedAccounts = await runtime.prisma.weleticLoyaltyAccount.findMany({
    where: { id: { in: [...state.baselineAccountTierById.keys()] } },
    select: {
      id: true,
      storeId: true,
      programId: true,
      shopperId: true,
      status: true,
      ledgerVersion: true,
      cachedPointsBalance: true,
      cachedPendingPoints: true,
      lifetimePointsEarned: true,
      lifetimePointsRedeemed: true,
      referralCount: true,
      referralPointsEarned: true,
      referralCode: true,
      referredById: true,
      currentTierId: true,
      tierExpiresAt: true,
      tierSpendRolling12Months: true,
      tierPointsRolling12Months: true,
      lastQualifyingActivityAt: true,
      nextExpiryDate: true,
      metadata: true,
      enrolledAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  assertCondition(
    retainedAccounts.length === state.baselineAccountTierById.size,
    "A retained pre-run loyalty account disappeared during validation.",
  );
  for (const account of retainedAccounts) {
    const baseline = state.baselineAccountTierById.get(account.id);
    assertCondition(
      baseline &&
        account.storeId === state.storeId &&
        account.programId === baseline.programId &&
        account.shopperId === baseline.shopperId &&
        account.status === baseline.status &&
        account.ledgerVersion === baseline.ledgerVersion &&
        account.cachedPointsBalance === baseline.cachedPointsBalance &&
        account.cachedPendingPoints === baseline.cachedPendingPoints &&
        account.lifetimePointsEarned === baseline.lifetimePointsEarned &&
        account.lifetimePointsRedeemed === baseline.lifetimePointsRedeemed &&
        account.referralCount === baseline.referralCount &&
        account.referralPointsEarned === baseline.referralPointsEarned &&
        account.referralCode === baseline.referralCode &&
        account.referredById === baseline.referredById &&
        account.currentTierId === baseline.currentTierId &&
        sameOptionalDate(account.tierExpiresAt, baseline.tierExpiresAt) &&
        account.tierSpendRolling12Months ===
          baseline.tierSpendRolling12Months &&
        account.tierPointsRolling12Months ===
          baseline.tierPointsRolling12Months &&
        sameOptionalDate(
          account.lastQualifyingActivityAt,
          baseline.lastQualifyingActivityAt,
        ) &&
        sameOptionalDate(account.nextExpiryDate, baseline.nextExpiryDate) &&
        canonicalDigest(account.metadata) ===
          canonicalDigest(baseline.metadata) &&
        account.enrolledAt.getTime() === baseline.enrolledAt.getTime() &&
        account.createdAt.getTime() === baseline.createdAt.getTime() &&
        account.updatedAt.getTime() === baseline.updatedAt.getTime(),
      "A retained pre-run loyalty account changed during the exclusive validation window.",
    );
  }

  const retainedShoppers = await runtime.prisma.weleticShopper.findMany({
    where: { id: { in: [...state.baselineShopperById.keys()] } },
    select: {
      id: true,
      storeId: true,
      shopifyCustomerId: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      locale: true,
      tags: true,
      segmentIds: true,
      acceptsMarketing: true,
      ordersCount: true,
      totalSpent: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  assertCondition(
    retainedShoppers.length === state.baselineShopperById.size,
    "A retained pre-run shopper disappeared during validation.",
  );
  for (const shopper of retainedShoppers) {
    const baseline = state.baselineShopperById.get(shopper.id);
    assertCondition(
      baseline &&
        shopper.storeId === state.storeId &&
        shopper.shopifyCustomerId === baseline.shopifyCustomerId &&
        shopper.firstName === baseline.firstName &&
        shopper.lastName === baseline.lastName &&
        shopper.email === baseline.email &&
        shopper.phone === baseline.phone &&
        shopper.locale === baseline.locale &&
        canonicalDigest(shopper.tags) === canonicalDigest(baseline.tags) &&
        canonicalDigest(shopper.segmentIds) ===
          canonicalDigest(baseline.segmentIds) &&
        shopper.acceptsMarketing === baseline.acceptsMarketing &&
        shopper.ordersCount === baseline.ordersCount &&
        shopper.totalSpent === baseline.totalSpent &&
        shopper.createdAt.getTime() === baseline.createdAt.getTime() &&
        shopper.updatedAt.getTime() === baseline.updatedAt.getTime(),
      "A retained pre-run shopper profile changed during the exclusive validation window.",
    );
  }

  const [
    retainedRules,
    retainedTiers,
    retainedReferralRules,
    retainedRewards,
    retainedBonusCampaigns,
  ] = await Promise.all([
    runtime.prisma.weleticLoyaltyEarningRule.findMany({
      where: { id: { in: [...state.baselineRuleIds] } },
    }),
    runtime.prisma.weleticLoyaltyTier.findMany({
      where: { id: { in: [...state.baselineTierIds] } },
    }),
    runtime.prisma.weleticLoyaltyReferralRule.findMany({
      where: { id: { in: [...state.baselineReferralRuleIds] } },
    }),
    runtime.prisma.weleticRewardDefinition.findMany({
      where: { id: { in: [...state.baselineRewardIds] } },
    }),
    runtime.prisma.weleticLoyaltyBonusCampaign.findMany({
      where: { id: { in: [...state.baselineBonusCampaignIds] } },
    }),
  ]);
  const retainedCollections: Array<
    [Array<{ id: string }>, Map<string, string>, string]
  > = [
    [retainedRules, state.baselineRuleDigests, "earning rules"],
    [retainedTiers, state.baselineTierDigests, "tiers"],
    [
      retainedReferralRules,
      state.baselineReferralRuleDigests,
      "referral rules",
    ],
    [retainedRewards, state.baselineRewardDigests, "rewards"],
    [
      retainedBonusCampaigns,
      state.baselineBonusCampaignDigests,
      "bonus campaigns",
    ],
  ];
  for (const [rows, baselineDigests, label] of retainedCollections) {
    assertCondition(
      rows.length === baselineDigests.size &&
        rows.every(
          (row) => baselineDigests.get(row.id) === canonicalDigest(row),
        ),
      `One or more retained ${label} changed during validation.`,
    );
  }

  await discoverFixtureReconciliationIssues(runtime, state);
  const accountIds = [...state.fixtureAccountIds];
  const shopperIds = [...state.fixtureShopperIds];
  const orderExternalIds = [...state.fixtureOrderExternalIds];
  const requestIds = [...state.fixtureComplianceRequestIds];
  const cleanupIds = [...state.fixtureCleanupIds];
  const outboxIds = [...state.fixtureOutboxIds];
  const webhookIds = [...state.webhookIds];
  const redemptionIds = [...state.fixtureRedemptionIds];
  const unownedOrphanFxSnapshots =
    await runtime.prisma.weleticFxRateSnapshot.findMany({
      where: {
        id: {
          notIn: [
            ...state.baselineFxRateSnapshotIds,
            ...state.fixtureFxRateSnapshotIds,
          ],
        },
        orders: { none: {} },
        refunds: { none: {} },
        payoutQuotes: { none: {} },
      },
      select: { id: true },
      take: 101,
    });
  assertCondition(
    unownedOrphanFxSnapshots.length === 0,
    "A post-dispatch orphan FX snapshot lacks exact fixture ownership; manual audit is required.",
  );
  const residueCounts = await Promise.all([
    runtime.prisma.weleticLoyaltyEarningRule.count({
      where: {
        programId: state.programId,
        id: { in: [...state.fixtureRuleIds] },
      },
    }),
    runtime.prisma.weleticLoyaltyReferralRule.count({
      where: {
        programId: state.programId,
        id: { in: [...state.fixtureReferralRuleIds] },
      },
    }),
    runtime.prisma.weleticLoyaltyTier.count({
      where: {
        programId: state.programId,
        id: { in: [...state.fixtureTierIds] },
      },
    }),
    runtime.prisma.weleticRewardDefinition.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: [...state.fixtureRewardIds] } },
          ...(state.rewardFixtureName
            ? [
                {
                  name: state.rewardFixtureName,
                  id: { notIn: [...state.baselineRewardIds] },
                },
              ]
            : []),
        ],
      },
    }),
    runtime.prisma.weleticShopper.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: shopperIds } },
          { shopifyCustomerId: { in: [...state.fixtureCustomerNumericIds] } },
          { email: { in: [...state.fixtureCustomerEmails] } },
        ],
      },
    }),
    runtime.prisma.weleticLoyaltyAccount.count({
      where: {
        storeId: state.storeId,
        OR: [{ id: { in: accountIds } }, { shopperId: { in: shopperIds } }],
      },
    }),
    runtime.prisma.weleticLoyaltyReferral.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: [...state.fixtureReferralIds] } },
          { advocateAccountId: { in: accountIds } },
          { refereeAccountId: { in: accountIds } },
        ],
      },
    }),
    runtime.prisma.weleticRewardRedemption.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: redemptionIds } },
          {
            accountId: { in: accountIds },
            idempotencyKey: { startsWith: `a1:${state.runMarker}:` },
          },
        ],
      },
    }),
    runtime.prisma.weleticPointsLedgerEntry.count({
      where: {
        storeId: state.storeId,
        OR: [
          { accountId: { in: accountIds } },
          { referenceId: { in: redemptionIds } },
        ],
      },
    }),
    runtime.prisma.weleticLoyaltyTierHistory.count({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          { fromTierId: { in: [...state.fixtureTierIds] } },
          { toTierId: { in: [...state.fixtureTierIds] } },
        ],
      },
    }),
    runtime.prisma.weleticLoyaltyEarnGrant.count({
      where: { storeId: state.storeId, accountId: { in: accountIds } },
    }),
    runtime.prisma.weleticLoyaltyOrderLineEarn.count({
      where: {
        storeId: state.storeId,
        grant: { accountId: { in: accountIds } },
      },
    }),
    runtime.prisma.weleticCommerceOrder.count({
      where: { storeId: state.storeId, externalId: { in: orderExternalIds } },
    }),
    runtime.prisma.weleticCommerceOrderLine.count({
      where: {
        order: {
          storeId: state.storeId,
          externalId: { in: orderExternalIds },
        },
      },
    }),
    runtime.prisma.weleticCommerceRefund.count({
      where: {
        storeId: state.storeId,
        order: { externalId: { in: orderExternalIds } },
      },
    }),
    runtime.prisma.weleticCommerceRefundLine.count({
      where: {
        refund: {
          storeId: state.storeId,
          order: { externalId: { in: orderExternalIds } },
        },
      },
    }),
    runtime.prisma.weleticFxRateSnapshot.count({
      where: { id: { in: [...state.fixtureFxRateSnapshotIds] } },
    }),
    runtime.prisma.weleticCommissionCalculation.count({
      where: { id: { in: [...state.fixtureCommissionCalculationIds] } },
    }),
    runtime.prisma.commission.count({
      where: { id: { in: [...state.fixtureCommissionIds] } },
    }),
    runtime.prisma.weleticLoyaltyOutboxJob.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: outboxIds } },
          { idempotencyKey: { contains: state.runMarker } },
        ],
      },
    }),
    runtime.prisma.weleticShopifyWebhookEvent.count({
      where: { storeId: state.storeId, webhookId: { in: webhookIds } },
    }),
    runtime.prisma.weleticShopifyComplianceRequest.count({
      where: {
        storeId: state.storeId,
        OR: [{ id: { in: requestIds } }, { webhookId: { in: webhookIds } }],
      },
    }),
    runtime.prisma.weleticShopifyComplianceArtifact.count({
      where: { storeId: state.storeId, requestId: { in: requestIds } },
    }),
    runtime.prisma.weleticShopifyCustomerPrivacyTombstone.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: [...state.fixtureCustomerPrivacyTombstoneIds] } },
          { sourceRequestId: { in: requestIds } },
          { shopperId: { in: shopperIds } },
          { accountId: { in: accountIds } },
        ],
      },
    }),
    runtime.prisma.weleticShopifyShopPrivacyTombstone.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: [...state.fixtureShopPrivacyTombstoneIds] } },
          { sourceRequestId: { in: requestIds } },
        ],
      },
    }),
    runtime.prisma.weleticShopifyVoucherCleanup.count({
      where: {
        storeId: state.storeId,
        OR: [
          { id: { in: cleanupIds } },
          { redemptionId: { in: redemptionIds } },
          { sourceRequestId: { in: requestIds } },
        ],
      },
    }),
    runtime.prisma.weleticShopifyVoucherCleanupRequestLink.count({
      where: {
        storeId: state.storeId,
        OR: [
          { cleanupId: { in: cleanupIds } },
          { requestId: { in: requestIds } },
        ],
      },
    }),
    runtime.prisma.weleticLoyaltyBackfillPreviewItem.count({
      where: { accountId: { in: accountIds } },
    }),
    runtime.prisma.weleticReconciliationIssue.count({
      where: {
        storeId: state.storeId,
        id: { in: [...state.fixtureReconciliationIssueIds] },
      },
    }),
  ]);
  assertCondition(
    residueCounts.every((count) => count === 0),
    "One or more exact fixture-local row families remain after cleanup.",
  );
  state.zeroResiduePasses += 1;
  state.checkpointRecoveryState(`zero-residue:pass-${state.zeroResiduePasses}`);
}

async function verifyZeroResidue(runtime: Runtime, state: HarnessState) {
  state.zeroResiduePasses = 0;
  await verifyZeroResidueOnce(runtime, state);
  await verifyZeroResidueOnce(runtime, state);
}

async function assertBasicLifecycleAtomicReleaseReady(
  runtime: Runtime,
  state: HarnessState,
  tx: any,
) {
  assertCondition(
    state.storeId && state.programId,
    "The atomic release audit scope is unavailable.",
  );
  const storeId = state.storeId;
  const programId = state.programId;
  const accountIds = [...state.fixtureAccountIds];
  const shopperIds = [...state.fixtureShopperIds];
  const orderExternalIds = [...state.fixtureOrderExternalIds];
  const requestIds = [...state.fixtureComplianceRequestIds];
  const cleanupIds = [...state.fixtureCleanupIds];
  const redemptionIds = [...state.fixtureRedemptionIds];

  const exactDefinitionValues = new Set([
    ...state.fixtureRuleIds,
    ...state.fixtureTierIds,
    ...state.fixtureRewardIds,
    ...state.fixtureReferralRuleIds,
  ]);
  const [
    tierAccounts,
    tierHistories,
    rewardRedemptions,
    definitionGrants,
    storeLedgerEntries,
    referralRulesUsingFixtureRewards,
  ] = await Promise.all([
    tx.weleticLoyaltyAccount.findMany({
      where: { storeId, currentTierId: { in: [...state.fixtureTierIds] } },
      select: { id: true },
    }),
    tx.weleticLoyaltyTierHistory.findMany({
      where: {
        OR: [
          { fromTierId: { in: [...state.fixtureTierIds] } },
          { toTierId: { in: [...state.fixtureTierIds] } },
        ],
      },
      select: { id: true, accountId: true },
    }),
    tx.weleticRewardRedemption.findMany({
      where: {
        storeId,
        rewardDefinitionId: { in: [...state.fixtureRewardIds] },
      },
      select: { id: true, accountId: true },
    }),
    tx.weleticLoyaltyEarnGrant.findMany({
      where: {
        storeId,
        OR: [
          { selectedRuleId: { in: [...state.fixtureRuleIds] } },
          { tierId: { in: [...state.fixtureTierIds] } },
        ],
      },
      select: { id: true, accountId: true },
    }),
    tx.weleticPointsLedgerEntry.findMany({
      where: { storeId },
      select: { id: true, accountId: true, referenceId: true, metadata: true },
    }),
    tx.weleticLoyaltyReferralRule.findMany({
      where: {
        programId,
        OR: [
          {
            advocateRewardDefinitionId: {
              in: [...state.fixtureRewardIds],
            },
          },
          {
            refereeRewardDefinitionId: {
              in: [...state.fixtureRewardIds],
            },
          },
        ],
      },
      select: { id: true },
    }),
  ]);
  const ledgerDefinitionReferences = storeLedgerEntries.filter(
    (entry: { referenceId: string | null; metadata: unknown }) =>
      (entry.referenceId !== null &&
        exactDefinitionValues.has(entry.referenceId)) ||
      jsonContainsExactValue(entry.metadata, exactDefinitionValues),
  );
  assertBasicLifecycleTemporaryDefinitionReferenceOwnership({
    fixtureAccountIds: state.fixtureAccountIds,
    references: [
      ...tierAccounts.map((account: { id: string }) => ({
        family: "tier account",
        rowId: account.id,
        accountId: account.id,
        exactFixtureRow: state.fixtureAccountIds.has(account.id),
      })),
      ...tierHistories.map((history: { id: string; accountId: string }) => ({
        family: "tier history",
        rowId: history.id,
        accountId: history.accountId,
        exactFixtureRow: state.fixtureAccountIds.has(history.accountId),
      })),
      ...rewardRedemptions.map(
        (redemption: { id: string; accountId: string }) => ({
          family: "reward redemption",
          rowId: redemption.id,
          accountId: redemption.accountId,
          exactFixtureRow: state.fixtureRedemptionIds.has(redemption.id),
        }),
      ),
      ...definitionGrants.map((grant: { id: string; accountId: string }) => ({
        family: "earning grant",
        rowId: grant.id,
        accountId: grant.accountId,
        exactFixtureRow: state.fixtureGrantIds.has(grant.id),
      })),
      ...ledgerDefinitionReferences.map(
        (entry: { id: string; accountId: string }) => ({
          family: "points ledger metadata",
          rowId: entry.id,
          accountId: entry.accountId,
          exactFixtureRow: state.fixtureAccountIds.has(entry.accountId),
        }),
      ),
    ],
  });
  assertCondition(
    tierAccounts.length === 0 &&
      tierHistories.length === 0 &&
      rewardRedemptions.length === 0 &&
      definitionGrants.length === 0 &&
      ledgerDefinitionReferences.length === 0 &&
      referralRulesUsingFixtureRewards.length === 0,
    "A temporary loyalty-definition reference appeared before lease release; the lease remains active.",
  );

  const currentStoreOutbox = await tx.weleticLoyaltyOutboxJob.findMany({
    where: { storeId },
  });
  const fixturePseudonyms = [...state.fixtureCustomerNumericIds].map(
    (customerId) =>
      runtime.getShopifyCustomerPrivacyPseudonym({
        storeId,
        shopifyCustomerId: customerId,
      }),
  );
  const exactFixtureValues = new Set([
    state.runMarker,
    ...state.fixtureCustomerNumericIds,
    ...state.fixtureCustomerEmails,
    ...fixturePseudonyms,
    ...state.remoteCustomerGids,
    ...state.fixtureAccountIds,
    ...state.fixtureShopperIds,
    ...state.fixtureOrderIds,
    ...state.fixtureOrderExternalIds,
    ...state.fixtureGrantIds,
    ...state.fixtureReferralIds,
    ...state.fixtureRedemptionIds,
    ...state.fixtureCleanupIds,
    ...state.fixtureComplianceRequestIds,
    ...state.fixtureCustomerPrivacyTombstoneIds,
    ...state.fixtureShopPrivacyTombstoneIds,
    ...state.fixtureRewardIds,
    ...state.fixtureDiscountCodes,
    ...state.remoteDiscountGids,
    ...state.webhookIds,
  ]);
  const fixtureOutboxRows = currentStoreOutbox.filter((job: any) =>
    isBasicLifecycleExactFixtureOutboxJob({
      job,
      baselineJobIds: state.baselineOutboxJobIds,
      knownFixtureJobIds: state.fixtureOutboxIds,
      exactFixtureValues,
      runMarker: state.runMarker,
    }),
  );
  assertOwnedFixtureOutboxRows(state, fixtureOutboxRows);
  assertCondition(
    fixtureOutboxRows.length === 0,
    "Fixture outbox work appeared after the final residue pass; the maintenance lease remains active.",
  );
  const retainedOutboxRows = currentStoreOutbox.filter((job: { id: string }) =>
    state.baselineOutboxJobDigests.has(job.id),
  );
  assertBasicLifecycleOutboxBaselineUnchanged(
    state.baselineOutboxJobDigests,
    retainedOutboxRows,
  );

  const fixtureWebhookCount = await tx.weleticShopifyWebhookEvent.count({
    where: { storeId, webhookId: { in: [...state.webhookIds] } },
  });

  const residueCounts = await Promise.all([
    tx.weleticLoyaltyEarningRule.count({
      where: { programId, id: { in: [...state.fixtureRuleIds] } },
    }),
    tx.weleticLoyaltyReferralRule.count({
      where: { programId, id: { in: [...state.fixtureReferralRuleIds] } },
    }),
    tx.weleticLoyaltyTier.count({
      where: { programId, id: { in: [...state.fixtureTierIds] } },
    }),
    tx.weleticRewardDefinition.count({
      where: {
        storeId,
        OR: [
          { id: { in: [...state.fixtureRewardIds] } },
          ...(state.rewardFixtureName
            ? [
                {
                  name: state.rewardFixtureName,
                  id: { notIn: [...state.baselineRewardIds] },
                },
              ]
            : []),
        ],
      },
    }),
    tx.weleticShopper.count({
      where: {
        storeId,
        OR: [
          { id: { in: shopperIds } },
          { shopifyCustomerId: { in: [...state.fixtureCustomerNumericIds] } },
          { email: { in: [...state.fixtureCustomerEmails] } },
        ],
      },
    }),
    tx.weleticLoyaltyAccount.count({
      where: {
        storeId,
        OR: [{ id: { in: accountIds } }, { shopperId: { in: shopperIds } }],
      },
    }),
    tx.weleticLoyaltyReferral.count({
      where: {
        storeId,
        OR: [
          { id: { in: [...state.fixtureReferralIds] } },
          { advocateAccountId: { in: accountIds } },
          { refereeAccountId: { in: accountIds } },
        ],
      },
    }),
    tx.weleticRewardRedemption.count({
      where: {
        storeId,
        OR: [
          { id: { in: redemptionIds } },
          {
            accountId: { in: accountIds },
            idempotencyKey: { startsWith: `a1:${state.runMarker}:` },
          },
        ],
      },
    }),
    tx.weleticPointsLedgerEntry.count({
      where: {
        storeId,
        OR: [
          { accountId: { in: accountIds } },
          { referenceId: { in: redemptionIds } },
        ],
      },
    }),
    tx.weleticLoyaltyTierHistory.count({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          { fromTierId: { in: [...state.fixtureTierIds] } },
          { toTierId: { in: [...state.fixtureTierIds] } },
        ],
      },
    }),
    tx.weleticLoyaltyEarnGrant.count({
      where: { storeId, accountId: { in: accountIds } },
    }),
    tx.weleticLoyaltyOrderLineEarn.count({
      where: { storeId, grant: { accountId: { in: accountIds } } },
    }),
    tx.weleticCommerceOrder.count({
      where: { storeId, externalId: { in: orderExternalIds } },
    }),
    tx.weleticCommerceOrderLine.count({
      where: { order: { storeId, externalId: { in: orderExternalIds } } },
    }),
    tx.weleticCommerceRefund.count({
      where: { storeId, order: { externalId: { in: orderExternalIds } } },
    }),
    tx.weleticCommerceRefundLine.count({
      where: {
        refund: { storeId, order: { externalId: { in: orderExternalIds } } },
      },
    }),
    tx.weleticFxRateSnapshot.count({
      where: { id: { in: [...state.fixtureFxRateSnapshotIds] } },
    }),
    tx.weleticCommissionCalculation.count({
      where: { id: { in: [...state.fixtureCommissionCalculationIds] } },
    }),
    tx.commission.count({
      where: { id: { in: [...state.fixtureCommissionIds] } },
    }),
    tx.weleticShopifyWebhookEvent.count({
      where: { storeId, webhookId: { in: [...state.webhookIds] } },
    }),
    tx.weleticShopifyComplianceRequest.count({
      where: {
        storeId,
        OR: [
          { id: { in: requestIds } },
          { webhookId: { in: [...state.webhookIds] } },
        ],
      },
    }),
    tx.weleticShopifyComplianceArtifact.count({
      where: { storeId, requestId: { in: requestIds } },
    }),
    tx.weleticShopifyCustomerPrivacyTombstone.count({
      where: {
        storeId,
        OR: [
          { id: { in: [...state.fixtureCustomerPrivacyTombstoneIds] } },
          { sourceRequestId: { in: requestIds } },
          { shopperId: { in: shopperIds } },
          { accountId: { in: accountIds } },
        ],
      },
    }),
    tx.weleticShopifyShopPrivacyTombstone.count({
      where: {
        storeId,
        OR: [
          { id: { in: [...state.fixtureShopPrivacyTombstoneIds] } },
          { sourceRequestId: { in: requestIds } },
        ],
      },
    }),
    tx.weleticShopifyVoucherCleanup.count({
      where: {
        storeId,
        OR: [
          { id: { in: cleanupIds } },
          { redemptionId: { in: redemptionIds } },
          { sourceRequestId: { in: requestIds } },
        ],
      },
    }),
    tx.weleticShopifyVoucherCleanupRequestLink.count({
      where: {
        storeId,
        OR: [
          { cleanupId: { in: cleanupIds } },
          { requestId: { in: requestIds } },
        ],
      },
    }),
    tx.weleticLoyaltyBackfillPreviewItem.count({
      where: { accountId: { in: accountIds } },
    }),
    tx.weleticReconciliationIssue.count({
      where: {
        storeId,
        id: { in: [...state.fixtureReconciliationIssueIds] },
      },
    }),
  ]);
  assertBasicLifecycleAtomicReleaseAudit({
    residueCounts,
    temporaryDefinitionReferenceCount:
      tierAccounts.length +
      tierHistories.length +
      rewardRedemptions.length +
      definitionGrants.length +
      ledgerDefinitionReferences.length +
      referralRulesUsingFixtureRewards.length,
    fixtureOutboxCount: fixtureOutboxRows.length,
    fixtureWebhookCount,
  });
}

async function releaseBasicLifecycleMaintenanceLease(
  runtime: Runtime,
  state: HarnessState,
) {
  if (!state.maintenanceLeaseAcquired) {
    assertCondition(
      !state.maintenancePermit &&
        !state.maintenanceLeaseMetadata &&
        !state.configMutated &&
        !state.programMutationDispatched &&
        !state.programMutationUncertain,
      "A maintenance-lease acquisition has an unknown outcome; no release was attempted.",
    );
    return;
  }
  assertProgramRestoreComplete(state);
  assertBasicLifecycleMaintenanceReleasePrerequisites({
    maintenanceLeaseAcquired: state.maintenanceLeaseAcquired,
    programSnapshotRestored:
      !state.configMutated &&
      !state.programMutationDispatched &&
      !state.programMutationUncertain &&
      !state.lastHarnessProgramUpdatedAt,
    localFixtureCleanupComplete: state.localFixtureCleanupComplete,
    fixtureOutboxQuiescedAfterLocalCleanup:
      state.fixtureOutboxQuiescedAfterLocalCleanup,
    zeroResiduePasses: state.zeroResiduePasses,
    baselineOutboxVerified: state.baselineOutboxVerified,
  });
  assertCondition(
    state.storeId &&
      state.programId &&
      state.programSnapshot &&
      state.maintenancePermit &&
      state.maintenanceLeaseMetadata &&
      !state.maintenanceLeaseReleased &&
      state.programOwnedFieldDriftKeys.size === 0,
    "The exact harness-owned maintenance lease cannot be released.",
  );

  state.maintenanceLeaseReleaseDispatched = true;
  state.maintenanceLeaseReleaseUncertain = true;
  state.checkpointRecoveryState("maintenance-lease-release:before");

  await withHarnessStoreMutation(
    runtime,
    state,
    "a1_release_maintenance_lease_last",
    async (tx) => {
      const current = await tx.weleticLoyaltyProgram.findUniqueOrThrow({
        where: { id: state.programId! },
        select: {
          updatedAt: true,
          name: true,
          status: true,
          pointNameSingular: true,
          pointNamePlural: true,
          pointsPerCurrencyUnit: true,
          holdingPeriodDays: true,
          pointsExpiryMonths: true,
          killSwitchActive: true,
          activatedAt: true,
          disabledAt: true,
          enableOnlineStoreLauncher: true,
          enableCustomerAccountHub: true,
          enableCheckoutExtension: true,
          enableProductPointsWidget: true,
          enableMetafieldsSync: true,
          surfaceFlags: true,
          vipMilestoneMode: true,
          vipTimeframe: true,
          vipDowngradeGraceDays: true,
          vipAutoDowngradeEnabled: true,
          branding: true,
          metadata: true,
        },
      });
      assertCondition(
        programSnapshotMatchesUnderMaintenanceLease(
          state.programSnapshot!,
          current,
          state.maintenanceLeaseMetadata,
        ),
        "The program changed after residue verification; the maintenance lease remains active.",
      );
      await assertBasicLifecycleAtomicReleaseReady(runtime, state, tx);
      const baselineMetadata = runtime.removeLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: current.metadata,
        permit: state.maintenancePermit!,
      });
      const released = await tx.weleticLoyaltyProgram.updateMany({
        where: { id: state.programId!, updatedAt: current.updatedAt },
        data: { metadata: baselineMetadata },
      });
      assertBasicLifecycleExactDeleteCount({
        family: "maintenance lease",
        expected: 1,
        actual: released.count,
      });
      const restored = await tx.weleticLoyaltyProgram.findUniqueOrThrow({
        where: { id: state.programId! },
      });
      assertCondition(
        programSnapshotMatches(state.programSnapshot!, restored),
        "The program did not exactly match its baseline at maintenance-lease release.",
      );
    },
    "database",
  );

  state.maintenanceLeaseReleased = true;
  state.maintenanceLeaseReleaseUncertain = false;
  state.maintenancePermit = undefined;
  state.checkpointRecoveryState("maintenance-lease-release:committed");
}

async function retryBasicLifecycleCleanupStep(
  task: () => Promise<void>,
  attempts = 3,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function cleanupHarness(runtime: Runtime, state: HarnessState) {
  const afterRestore = (task: () => Promise<void>) => async () => {
    assertProgramRestoreComplete(state);
    await task();
  };
  await runBasicLifecycleCleanupSteps({
    formatError: (error) => state.safeError(error),
    steps: [
      {
        name: "restore program snapshot",
        run: () => restoreProgramConfiguration(runtime, state),
      },
      {
        name: "discover exact uncertain fixtures",
        run: () => discoverUncertainLocalFixtures(runtime, state),
      },
      {
        name: "resume exact customer-redact compliance",
        run: () =>
          state.localFixtureCleanupComplete
            ? Promise.resolve()
            : drainOwnedFixtureCustomerRedactRequests(runtime, state),
      },
      {
        name: "reconcile registered customer ingress",
        run: async () => {
          if (state.fixtureCustomerIngressReconciled) return;
          await reconcileFixtureCustomerIngress(runtime, state);
          state.fixtureCustomerIngressReconciled = true;
        },
      },
      {
        name: "quiesce exact fixture outbox before remote cleanup",
        run: afterRestore(async () => {
          await retryBasicLifecycleCleanupStep(() =>
            quiesceFixtureOutboxJobs(runtime, state),
          );
          state.fixtureOutboxQuiescedForRemoteCleanup = true;
        }),
      },
      {
        name: "delete exact remote discounts",
        run: afterRestore(async () => {
          if (state.remoteDiscountCleanupComplete) return;
          assertCondition(
            state.fixtureOutboxQuiescedForRemoteCleanup,
            "Remote discount cleanup is blocked until exact outbox quiescence succeeds.",
          );
          await retryBasicLifecycleCleanupStep(() =>
            cleanupRemoteDiscounts(runtime, state),
          );
          state.remoteDiscountCleanupComplete = true;
        }),
      },
      {
        name: "delete exact remote customers",
        run: afterRestore(async () => {
          if (state.remoteCustomerCleanupComplete) return;
          assertCondition(
            state.fixtureOutboxQuiescedForRemoteCleanup,
            "Remote customer cleanup is blocked until exact outbox quiescence succeeds.",
          );
          assertCondition(
            state.fixtureCustomerIngressReconciled,
            "Remote customer cleanup is blocked until registered customer ingress reconciliation succeeds.",
          );
          await retryBasicLifecycleCleanupStep(() =>
            cleanupRemoteCustomers(runtime, state),
          );
          state.remoteCustomerCleanupComplete = true;
        }),
      },
      {
        name: "deindex and delete exact checkout caches",
        run: afterRestore(async () => {
          if (state.checkoutCacheCleanupComplete) return;
          assertCondition(
            state.fixtureOutboxQuiescedForRemoteCleanup,
            "Cache cleanup is blocked until exact outbox quiescence succeeds.",
          );
          assertCondition(
            state.fixtureCustomerIngressReconciled,
            "Cache cleanup is blocked until registered customer ingress reconciliation succeeds.",
          );
          await retryBasicLifecycleCleanupStep(() =>
            cleanupCheckoutCaches(runtime, state),
          );
          state.checkoutCacheCleanupComplete = true;
        }),
      },
      {
        name: "requiesce exact fixture outbox",
        run: afterRestore(async () => {
          await retryBasicLifecycleCleanupStep(() =>
            quiesceFixtureOutboxJobs(runtime, state),
          );
          state.fixtureOutboxQuiescedForLocalCleanup = true;
        }),
      },
      {
        name: "delete exact local fixtures",
        run: afterRestore(async () => {
          if (state.localFixtureCleanupComplete) return;
          assertBasicLifecycleLocalCleanupPrerequisites({
            customerIngressReconciled: state.fixtureCustomerIngressReconciled,
            outboxQuiescedForRemoteCleanup:
              state.fixtureOutboxQuiescedForRemoteCleanup,
            outboxQuiescedForLocalCleanup:
              state.fixtureOutboxQuiescedForLocalCleanup,
            remoteDiscountCleanupComplete: state.remoteDiscountCleanupComplete,
            remoteCustomerCleanupComplete: state.remoteCustomerCleanupComplete,
            checkoutCacheCleanupComplete: state.checkoutCacheCleanupComplete,
          });
          await cleanupLocalFixtures(runtime, state);
          state.localFixtureCleanupComplete = true;
        }),
      },
      {
        name: "delete and requiesce post-local exact outbox",
        run: afterRestore(async () => {
          assertCondition(
            state.localFixtureCleanupComplete,
            "Post-local outbox cleanup is blocked until exact local fixture deletion succeeds.",
          );
          await cleanupPostLocalFixtureOutbox(runtime, state);
          state.fixtureOutboxQuiescedAfterLocalCleanup = true;
        }),
      },
      {
        name: "reconcile program snapshot after local cleanup",
        run: () => restoreProgramConfiguration(runtime, state),
      },
      {
        name: "verify two-pass zero residue",
        run: afterRestore(() => verifyZeroResidue(runtime, state)),
      },
      {
        name: "verify retained baseline outbox unchanged",
        run: () => verifyBaselineOutboxJobsUnchanged(runtime, state),
      },
      {
        name: "release maintenance lease last",
        run: () => releaseBasicLifecycleMaintenanceLease(runtime, state),
      },
    ].map((step) => ({
      name: step.name,
      run: async () => {
        state.activeCleanupStep = step.name;
        state.checkpointRecoveryState(`cleanup:${step.name}:before`);
        try {
          await step.run();
          state.activeCleanupStep = undefined;
          state.checkpointRecoveryState(`cleanup:${step.name}:passed`);
        } catch (error) {
          state.activeCleanupStep = undefined;
          state.checkpointRecoveryState(`cleanup:${step.name}:failed`);
          throw error;
        }
      },
    })),
  });
}

function summarizeReport(
  state: HarnessState,
  cleanup: BasicLifecycleCheck,
  recoveryCapsuleSha256: string | null,
  recoverySource?: BasicLifecycleReport["recoverySource"],
): BasicLifecycleReport {
  const allChecks = [...state.checks, cleanup];
  const failed = allChecks.filter((check) => check.status === "FAILED").length;
  const deferred = allChecks.filter(
    (check) => check.status === "DEFERRED",
  ).length;
  const passed = allChecks.filter((check) => check.status === "PASSED").length;
  return {
    version: REPORT_VERSION,
    startedAt: state.startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    overallStatus: failed > 0 ? "FAILED" : deferred > 0 ? "DEFERRED" : "PASSED",
    summary: {
      total: allChecks.length,
      passed,
      failed,
      deferred,
    },
    checks: state.checks,
    cleanup,
    evidenceProvenance: getBasicLifecycleEvidenceProvenance(),
    intentionallySkipped: [
      "real Shopify checkout order and refund lifecycle",
      "live checkout coupon acceptance and application",
      "Shopify Plus checkout-only capabilities",
      "app/uninstalled store freeze and teardown",
      "shop/redact store erasure",
      "customers/data_request webhook delivery and external export delivery",
      "external partner or multi-merchant service flows",
    ],
    intentionallyRetained: [
      `authenticated, generation-fenced, terminal, error-free, payload-free registered customers/create audit evidence: count=${state.registeredCustomerCreateAuditCount}, owned=false, deleted=false`,
      `keyed-HMAC customer privacy fences: count=${state.retainedPrivacyFenceCount}, ttlValid=${state.retainedPrivacyFencesTtlValid}, securityEvidence=true, deleted=false`,
    ],
    recoveryCapsule: recoveryCapsuleSha256
      ? { sha256: recoveryCapsuleSha256 }
      : null,
    ...(recoverySource ? { recoverySource } : {}),
  };
}

export function serializeBasicLifecycleReportForFile(
  report: BasicLifecycleReport,
  sensitiveValues: Iterable<string> = [],
) {
  const redactCheck = (check: BasicLifecycleCheck): BasicLifecycleCheck => ({
    ...check,
    ...(check.reason
      ? { reason: redactBasicLifecycleText(check.reason, sensitiveValues) }
      : {}),
  });
  // Whitelist the report schema instead of spreading the runtime object. This
  // keeps store/customer identifiers out even when an older caller supplies a
  // legacy property that is no longer part of BasicLifecycleReport.
  return `${JSON.stringify(
    {
      version: report.version,
      startedAt: report.startedAt,
      completedAt: report.completedAt,
      overallStatus: report.overallStatus,
      summary: report.summary,
      checks: report.checks.map(redactCheck),
      cleanup: redactCheck(report.cleanup),
      evidenceProvenance: report.evidenceProvenance,
      intentionallySkipped: report.intentionallySkipped,
      intentionallyRetained: report.intentionallyRetained,
      recoveryCapsule: report.recoveryCapsule,
      ...(report.recoverySource
        ? { recoverySource: report.recoverySource }
        : {}),
    },
    null,
    2,
  )}\n`;
}

export function writeRedactedReport(
  reportPath: string,
  report: BasicLifecycleReport,
  sensitiveValues: Iterable<string> = [],
) {
  const absolutePath = path.resolve(reportPath);
  writeExclusiveDurableArtifact(
    absolutePath,
    serializeBasicLifecycleReportForFile(report, sensitiveValues),
  );
  return absolutePath;
}

export function finalizeBasicLifecycleRecoveryArtifacts({
  state,
  report,
  reportPath,
}: {
  state: HarnessState;
  report: BasicLifecycleReport;
  reportPath?: string;
}) {
  const absoluteReportPath = reportPath
    ? writeRedactedReport(reportPath, report, state.sensitive)
    : null;
  const eligibleForCapsuleDeletion =
    report.overallStatus === "PASSED" &&
    report.cleanup.status === "PASSED" &&
    state.maintenanceLeaseAcquired &&
    state.maintenanceLeaseReleased &&
    state.maintenanceLeaseReleaseDispatched &&
    !state.maintenanceLeaseReleaseUncertain &&
    !state.configMutated &&
    !state.programMutationDispatched &&
    !state.programMutationUncertain &&
    !state.lastHarnessProgramUpdatedAt &&
    state.fixtureCustomerIngressReconciled &&
    state.fixtureOutboxQuiescedForRemoteCleanup &&
    state.remoteDiscountCleanupComplete &&
    state.remoteCustomerCleanupComplete &&
    state.checkoutCacheCleanupComplete &&
    state.fixtureOutboxQuiescedForLocalCleanup &&
    state.localFixtureCleanupComplete &&
    state.fixtureOutboxQuiescedAfterLocalCleanup &&
    state.zeroResiduePasses >= 2 &&
    state.baselineOutboxVerified;
  if (
    !eligibleForCapsuleDeletion ||
    !absoluteReportPath ||
    !report.recoveryCapsule
  ) {
    return { capsuleDeleted: false, absoluteReportPath };
  }
  try {
    state.bindRecoveryCapsuleToReport({
      reportPath: absoluteReportPath,
      reportSha256: sha256BasicLifecycleFile(absoluteReportPath),
      capsuleSha256BeforeBinding: report.recoveryCapsule.sha256,
    });
    state.securelyDeleteRecoveryCapsule();
    return { capsuleDeleted: true, absoluteReportPath };
  } catch {
    // Cleanup and its redacted report are already durable. Any binding or
    // unlink uncertainty retains the private capsule for manual recovery.
    return { capsuleDeleted: false, absoluteReportPath };
  }
}

function readFailedBasicLifecycleCleanupSource({
  reportPath,
  recoveryStatePath,
  expectedStartedAt,
}: {
  reportPath: string;
  recoveryStatePath: string;
  expectedStartedAt: string;
}) {
  const bytes = fs.readFileSync(reportPath);
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  assertCondition(
    isJsonObject(parsed),
    "The cleanup recovery source report is malformed.",
  );
  const expectedKeys = [
    "checks",
    "cleanup",
    "completedAt",
    "evidenceProvenance",
    "intentionallyRetained",
    "intentionallySkipped",
    "overallStatus",
    "recoveryCapsule",
    "startedAt",
    "summary",
    "version",
    ...(Object.prototype.hasOwnProperty.call(parsed, "recoverySource")
      ? ["recoverySource"]
      : []),
  ];
  assertExactRecoveryKeys(
    parsed,
    expectedKeys,
    "The cleanup recovery source report",
  );
  const capsuleSha256 = sha256BasicLifecycleFile(recoveryStatePath);
  assertCondition(
    parsed.version === REPORT_VERSION &&
      parsed.overallStatus === "FAILED" &&
      parsed.startedAt === expectedStartedAt &&
      typeof parsed.completedAt === "string" &&
      Number.isFinite(Date.parse(parsed.completedAt)) &&
      Array.isArray(parsed.checks) &&
      isJsonObject(parsed.cleanup) &&
      parsed.cleanup.status === "FAILED" &&
      isJsonObject(parsed.summary) &&
      isJsonObject(parsed.evidenceProvenance) &&
      Array.isArray(parsed.intentionallySkipped) &&
      Array.isArray(parsed.intentionallyRetained) &&
      isJsonObject(parsed.recoveryCapsule) &&
      parsed.recoveryCapsule.sha256 === capsuleSha256,
    "The cleanup recovery source does not bind the exact failed run and private capsule.",
  );
  for (const check of parsed.checks) assertRecoveryCheck(check);
  assertRecoveryCheck(parsed.cleanup);
  const statuses = [...parsed.checks, parsed.cleanup].map(
    (check) => check.status,
  );
  assertCondition(
    parsed.summary.total === statuses.length &&
      parsed.summary.passed ===
        statuses.filter((status) => status === "PASSED").length &&
      parsed.summary.failed ===
        statuses.filter((status) => status === "FAILED").length &&
      parsed.summary.deferred ===
        statuses.filter((status) => status === "DEFERRED").length,
    "The cleanup recovery source summary does not recompute exactly.",
  );
  return {
    version: parsed.version,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function prepareBasicLifecycleCleanupRecoveryContext(
  runtime: Runtime,
  state: HarnessState,
) {
  assertCondition(
    state.storeTuple &&
      state.storeId &&
      state.programId &&
      state.maintenanceLeaseAcquired &&
      state.maintenanceLeaseMetadata &&
      state.programSnapshot &&
      state.options.storeDomain === state.storeTuple.shopDomain,
    "The cleanup recovery capsule is not an active exact lifecycle generation.",
  );
  const credentials = await runtime.resolveShopifyOfflineCredentials({
    storeId: state.storeId,
  });
  assertCondition(
    credentials.shopDomain === state.options.storeDomain,
    "Cleanup recovery credentials do not match the authenticated source tenant.",
  );
  state.accessToken = credentials.accessToken;
  state.registerSensitive(credentials.accessToken);
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const program = await readHarnessProgramState(runtime, state);
  if (state.maintenanceLeaseReleased) {
    assertCondition(
      state.maintenanceLeaseReleaseDispatched &&
        !state.maintenanceLeaseReleaseUncertain &&
        programSnapshotMatches(state.programSnapshot, program),
      "The released cleanup recovery generation does not match its exact program baseline.",
    );
    state.maintenancePermit = undefined;
  } else {
    state.maintenancePermit = runtime.createLoyaltyMaintenanceOwnerPermit({
      storeId: state.storeId,
      metadata: program.metadata,
      ownerToken: state.maintenanceOwnerToken,
    });
  }
}

async function verifyReleasedBasicLifecycleCleanup(
  runtime: Runtime,
  state: HarnessState,
) {
  assertCondition(
    state.maintenanceLeaseAcquired &&
      state.maintenanceLeaseReleased &&
      state.maintenanceLeaseReleaseDispatched &&
      !state.maintenanceLeaseReleaseUncertain &&
      !state.configMutated &&
      !state.programMutationDispatched &&
      !state.programMutationUncertain &&
      !state.lastHarnessProgramUpdatedAt &&
      state.fixtureCustomerIngressReconciled &&
      state.fixtureOutboxQuiescedForRemoteCleanup &&
      state.remoteDiscountCleanupComplete &&
      state.remoteCustomerCleanupComplete &&
      state.checkoutCacheCleanupComplete &&
      state.fixtureOutboxQuiescedForLocalCleanup &&
      state.localFixtureCleanupComplete &&
      state.fixtureOutboxQuiescedAfterLocalCleanup &&
      state.zeroResiduePasses >= 2 &&
      state.baselineOutboxVerified,
    "The released cleanup capsule does not contain every durable completion checkpoint.",
  );
  await assertCurrentBasicLifecycleStoreTuple(runtime, state);
  const currentProgram = await readHarnessProgramState(runtime, state);
  assertCondition(
    state.programSnapshot &&
      programSnapshotMatches(state.programSnapshot, currentProgram),
    "The released loyalty program no longer matches its exact pre-run baseline.",
  );
  const finalCustomerGids = await listAllCustomerGids(runtime, state);
  assertCondition(
    finalCustomerGids.size === state.baselineCustomerGids.size &&
      [...finalCustomerGids].every((gid) =>
        state.baselineCustomerGids.has(gid),
      ),
    "The released Shopify customer set differs from the exact pre-run baseline.",
  );
  for (const discountGid of state.remoteDiscountGids) {
    const exactReadback: {
      codeDiscountNode: { id: string } | null;
    } = await runtime.shopifyAdminGraphqlRequest({
      shopDomain: state.options.storeDomain,
      accessToken: state.accessToken!,
      query: `query WeleticA1ReleasedDiscountResidue($id: ID!) {
        codeDiscountNode(id: $id) { id }
      }`,
      variables: { id: discountGid },
    });
    assertBasicLifecycleExactDiscountDeleted(
      discountGid,
      exactReadback.codeDiscountNode,
    );
  }
  await captureRegisteredCustomerCreateAuditEvidence(
    runtime,
    state,
    state.remoteCustomerGids.size,
  );
  await assertBasicLifecycleAtomicReleaseReady(runtime, state, runtime.prisma);
  await verifyBaselineOutboxJobsUnchanged(runtime, state);
}

async function runBasicLifecycleCleanupRecovery(
  options: BasicLifecycleCliOptions,
): Promise<BasicLifecycleReport> {
  assertCondition(
    options.resumeCleanupFromReportPath &&
      options.recoveryStatePath &&
      options.reportPath,
    "Cleanup recovery inputs are incomplete.",
  );
  const state = new HarnessState({
    ...options,
    storeDomain: normalizedShopDomain(options.storeDomain),
  });
  const recovered = state.resumeRecoveryCapsule().harnessState;
  const recoverySource = readFailedBasicLifecycleCleanupSource({
    reportPath: options.resumeCleanupFromReportPath,
    recoveryStatePath: options.recoveryStatePath,
    expectedStartedAt: recovered.startedAt.toISOString(),
  });
  state.checks.splice(0);
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  let runtime: Runtime | null = null;
  let cleanup: BasicLifecycleCheck = {
    name: "Restore configuration and remove disposable fixtures",
    status: "PASSED",
    durationMs: 0,
    evidence: evidenceForCheck(
      "Restore configuration and remove disposable fixtures",
    ),
  };
  try {
    await state.check("A1 cleanup recovery runtime availability", async () => {
      runtime = await loadRuntime();
    });
    await state.check(
      "Authenticated cleanup recovery source and live tenant",
      () => prepareBasicLifecycleCleanupRecoveryContext(runtime!, state),
    );
    const cleanupStarted = Date.now();
    try {
      await withRetainedCustomerSettlementLocks(runtime!, state, () =>
        state.maintenanceLeaseReleased
          ? verifyReleasedBasicLifecycleCleanup(runtime!, state)
          : cleanupHarness(runtime!, state),
      );
      cleanup.durationMs = Date.now() - cleanupStarted;
    } catch (error) {
      cleanup = {
        ...cleanup,
        status: "FAILED",
        durationMs: Date.now() - cleanupStarted,
        reason: state.safeError(error),
      };
    }
  } catch (error) {
    cleanup = {
      ...cleanup,
      status: "FAILED",
      reason: state.safeError(error),
    };
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  state.checkpointRecoveryState("cleanup-recovery:final-state");
  const report = summarizeReport(
    state,
    cleanup,
    state.recoveryCapsuleSha256(),
    recoverySource,
  );
  finalizeBasicLifecycleRecoveryArtifacts({
    state,
    report,
    reportPath: options.reportPath,
  });
  return report;
}

export async function runBasicLifecycleValidation(
  options: BasicLifecycleCliOptions,
): Promise<BasicLifecycleReport> {
  assertBasicLifecycleSafety(options);
  if (options.resumeCleanupFromReportPath) {
    return runBasicLifecycleCleanupRecovery(options);
  }
  const state = new HarnessState({
    ...options,
    storeDomain: normalizedShopDomain(options.storeDomain),
  });
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  // Imported runtime paths may log provider payloads. The harness emits one
  // deliberately redacted JSON document after all cleanup, so suppress every
  // incidental line while fixture identities are in memory.
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;

  let runtime: Runtime | null = null;
  let cleanup: BasicLifecycleCheck = {
    name: "Restore configuration and remove disposable fixtures",
    status: "PASSED",
    durationMs: 0,
    evidence: evidenceForCheck(
      "Restore configuration and remove disposable fixtures",
    ),
  };
  try {
    await state.check(
      "A1 harness runtime availability",
      async () => {
        runtime = await loadRuntime();
      },
      BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS["A1 harness runtime availability"],
    );
    await state.check(
      "Staging tenant, credential, and baseline safety",
      () => prepareContext(runtime!, state),
      BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
        "Staging tenant, credential, and baseline safety"
      ],
    );
    let lockScopeEntered = false;
    try {
      let customers!: Record<string, FixtureCustomer>;
      const cleanupStarted = Date.now();
      const orchestration = await runBasicLifecycleLockedOrchestration({
        withLocks: (task) =>
          withRetainedCustomerSettlementLocks(runtime!, state, async () => {
            lockScopeEntered = true;
            return task();
          }),
        phases: [
          {
            name: "retained baseline and outbox preflight",
            run: () =>
              state.check(
                "Retained-customer exclusivity and drained outbox quiescence",
                async () => {
                  await refreshRetainedBaselineUnderLocks(runtime!, state);
                  await assertStoreOutboxQuiescence(runtime!, state);
                },
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Retained-customer exclusivity and drained outbox quiescence"
                ],
              ),
          },
          {
            name: "install temporary configuration",
            run: () =>
              state.check(
                "Temporary loyalty configuration installation",
                () => installFixtureConfiguration(runtime!, state),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Temporary loyalty configuration installation"
                ],
              ),
          },
          {
            name: "provision live fixture customers",
            run: () =>
              state.check(
                "Real Shopify customer creation and webhook provisioning",
                async () => {
                  const provisioned: FixtureCustomer[] = [];
                  for (const role of BASIC_LIFECYCLE_FIXTURE_ROLES) {
                    const remote = await createDisposableCustomer(
                      runtime!,
                      state,
                      role,
                    );
                    const local = await waitForLocalCustomer(
                      runtime!,
                      state,
                      remote,
                      role,
                    );
                    await waitForRegisteredCustomerCreateAuditAssignments(
                      runtime!,
                      state,
                    );
                    provisioned.push(local);
                  }
                  customers = Object.fromEntries(
                    provisioned.map((customer) => [customer.role, customer]),
                  );
                  await captureRegisteredCustomerCreateAuditEvidence(
                    runtime!,
                    state,
                    BASIC_LIFECYCLE_FIXTURE_ROLES.length,
                  );
                },
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Real Shopify customer creation and webhook provisioning"
                ],
              ),
          },
          {
            name: "signup idempotency",
            run: () =>
              state.check(
                "Signup award idempotency",
                () =>
                  validateSignupIdempotency(
                    runtime!,
                    state,
                    customers.advocate,
                  ),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Signup award idempotency"
                ],
              ),
          },
          {
            name: "referral qualification",
            run: () =>
              state.check(
                "Referral bind and first-order qualification",
                () =>
                  validateReferralQualification(
                    runtime!,
                    state,
                    customers.advocate,
                    customers.referee,
                  ),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Referral bind and first-order qualification"
                ],
              ),
          },
          {
            name: "holding and refund economics",
            run: () =>
              state.check(
                "Holding release and partial/full refund reversals",
                () =>
                  validateHoldingAndRefunds(
                    runtime!,
                    state,
                    customers.lifecycle,
                  ),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Holding release and partial/full refund reversals"
                ],
              ),
          },
          {
            name: "VIP and metafield readback",
            run: () =>
              state.check(
                "VIP transition and Shopify metafield readback",
                () =>
                  validateVipAndMetafieldReadback(
                    runtime!,
                    state,
                    customers.advocate,
                  ),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "VIP transition and Shopify metafield readback"
                ],
              ),
          },
          {
            name: "voucher lifecycle",
            run: () =>
              state.check(
                "Voucher use, cancellation, and logical-time expiry",
                () =>
                  validateVoucherLifecycle(runtime!, state, customers.advocate),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Voucher use, cancellation, and logical-time expiry"
                ],
              ),
          },
          {
            name: "birthday lifecycle",
            run: () =>
              state.check(
                "Birthday scheduling and logical-time award",
                () =>
                  validateBirthdayWorker(runtime!, state, customers.advocate),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Birthday scheduling and logical-time award"
                ],
              ),
          },
          {
            name: "privacy lifecycle",
            run: () =>
              state.check(
                "Customer redaction and voucher privacy cleanup",
                () =>
                  validateCustomerRedactVoucherCleanup(
                    runtime!,
                    state,
                    customers.privacy,
                  ),
                BASIC_LIFECYCLE_CHECK_EVIDENCE_KINDS[
                  "Customer redaction and voucher privacy cleanup"
                ],
              ),
          },
        ],
        cleanup: () => cleanupHarness(runtime!, state),
      });
      cleanup.durationMs = Date.now() - cleanupStarted;
      if (orchestration.cleanupError) {
        cleanup = {
          name: cleanup.name,
          status: "FAILED",
          durationMs: cleanup.durationMs,
          evidence: evidenceForCheck(
            "Restore configuration and remove disposable fixtures",
          ),
          reason: state.safeError(orchestration.cleanupError),
        };
      }
    } catch (error) {
      if (!lockScopeEntered) {
        state.checks.push({
          name: "Retained-customer exclusivity and drained outbox quiescence",
          status: "FAILED",
          durationMs: 0,
          evidence: evidenceForCheck(
            "Retained-customer exclusivity and drained outbox quiescence",
          ),
          reason: state.safeError(error),
        });
      } else if (cleanup.status !== "FAILED") {
        cleanup = {
          name: cleanup.name,
          status: "FAILED",
          durationMs: cleanup.durationMs,
          evidence: evidenceForCheck(
            "Restore configuration and remove disposable fixtures",
          ),
          reason: state.safeError(error),
        };
      }
    }
  } catch {
    // Runtime/baseline validation failed before any fixture mutation.
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }

  state.checkpointRecoveryState("run:final-state");
  const report = summarizeReport(state, cleanup, state.recoveryCapsuleSha256());
  finalizeBasicLifecycleRecoveryArtifacts({
    state,
    report,
    reportPath: options.reportPath,
  });
  return report;
}

async function main() {
  let options: BasicLifecycleCliOptions;
  try {
    options = parseBasicLifecycleArgs(process.argv.slice(2));
    const report = await runBasicLifecycleValidation(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.overallStatus === "PASSED" ? 0 : 1;
  } catch (error) {
    const failure = {
      version: REPORT_VERSION,
      overallStatus: "FAILED",
      error: redactBasicLifecycleText(error),
    };
    console.log(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("validate-basic-lifecycle.ts")
) {
  void main();
}
