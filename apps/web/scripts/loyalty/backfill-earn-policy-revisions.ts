import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  buildLoyaltyEarnPolicySnapshot,
  publishLoyaltyEarnPolicyRevision,
  verifyLoyaltyEarnPolicyRevisionSnapshot,
} from "@/lib/weletic/loyalty/earn-policy-revision";
import { lockLoyaltyProgramRow } from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

export const EARN_POLICY_CUTOVER_MAINTENANCE_FENCE =
  "loyalty-writers-paused-and-drained";

const CUTOVER_REASON_PREFIX = "earn-policy-cutover:";
const PRE_CUTOVER_ORDER_ISSUE_KIND = "loyalty_pre_cutover_ungranted_order";
const BLOCKING_OUTBOX_JOB_STATUSES = [
  "pending",
  "processing",
  "failed",
  "dead_letter",
] as const;
const FINANCIAL_WEBHOOK_TOPICS = ["orders/paid", "refunds/create"] as const;
const BLOCKING_WEBHOOK_STATUSES = ["received", "failed"] as const;
const EARN_ELIGIBLE_ORDER_STATUSES = [
  "paid",
  "partially_refunded",
  "refunded",
] as const;
const BATCH_SIZE = 250;
const MAX_FIRST_CUTOVER_AGE_MS = 5 * 60 * 1000;

type ProgramProjection = Prisma.WeleticLoyaltyProgramGetPayload<{
  include: {
    earningRules: true;
    bonusCampaigns: true;
    tiers: true;
  };
}>;

type BaselineInspection = {
  totalPrograms: number;
  existingBaselines: number;
  baselinesToCreate: Array<{
    programId: string;
    storeId: string;
    expectedFingerprint: string;
  }>;
  blockers: string[];
};

type TierMarkerCandidate = {
  accountId: string;
  storeId: string;
  programId: string;
  tierId: string;
  nextSequenceNumber: number;
  accountUpdatedAt: Date;
  qualifyingSpendSnapshot: bigint;
  qualifyingPointsSnapshot: bigint;
};

type TierHistorySequenceAssignment = {
  historyId: string;
  accountId: string;
  storeId: string;
  programId: string;
  effectiveAt: Date;
  sequenceNumber: number;
};

type TierInspection = {
  accountsWithCurrentTier: number;
  usableHistories: number;
  sequenceAssignments: TierHistorySequenceAssignment[];
  markersToCreate: TierMarkerCandidate[];
  blockers: string[];
};

export type TierHistorySequencePlanRow = {
  id: string;
  accountId: string;
  effectiveAt: Date;
  sequenceNumber: number | null;
  toTierId: string;
};

export function planTierHistorySequences(rows: TierHistorySequencePlanRow[]) {
  const historiesByAccount = new Map<string, TierHistorySequencePlanRow[]>();
  for (const row of rows) {
    const histories = historiesByAccount.get(row.accountId) ?? [];
    histories.push(row);
    historiesByAccount.set(row.accountId, histories);
  }

  const orderedHistoriesByAccount = new Map<
    string,
    TierHistorySequencePlanRow[]
  >();
  const assignments: Array<{
    historyId: string;
    accountId: string;
    effectiveAt: Date;
    sequenceNumber: number;
  }> = [];
  const blockedAccountIds = new Set<string>();
  const nextSequenceNumberByAccount = new Map<string, number>();
  const blockers: string[] = [];

  for (const [accountId, histories] of historiesByAccount) {
    const historiesAtTimestamp = new Map<
      number,
      TierHistorySequencePlanRow[]
    >();
    for (const history of histories) {
      const timestamp = history.effectiveAt.getTime();
      const tied = historiesAtTimestamp.get(timestamp) ?? [];
      tied.push(history);
      historiesAtTimestamp.set(timestamp, tied);
    }
    const ambiguousTie = [...historiesAtTimestamp.entries()].find(
      ([, tied]) =>
        tied.length > 1 &&
        tied.some((history) => history.sequenceNumber === null),
    );
    if (ambiguousTie) {
      blockedAccountIds.add(accountId);
      blockers.push(
        `Account ${accountId} has ${ambiguousTie[1].length} tier histories at ${new Date(ambiguousTie[0]).toISOString()} without a complete authoritative sequence; their order cannot be reconstructed.`,
      );
      continue;
    }

    const ordered = [...histories].sort((left, right) => {
      const byTime = left.effectiveAt.getTime() - right.effectiveAt.getTime();
      if (byTime !== 0) return byTime;
      if (
        left.sequenceNumber !== null &&
        right.sequenceNumber !== null &&
        left.sequenceNumber !== right.sequenceNumber
      ) {
        return left.sequenceNumber - right.sequenceNumber;
      }
      return left.id.localeCompare(right.id);
    });
    orderedHistoriesByAccount.set(accountId, ordered);

    const accountAssignments: typeof assignments = [];
    let accountBlocker: string | null = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const history = ordered[index];
      const expectedSequence = index + 1;
      if (history.sequenceNumber === null) {
        accountAssignments.push({
          historyId: history.id,
          accountId,
          effectiveAt: history.effectiveAt,
          sequenceNumber: expectedSequence,
        });
        continue;
      }
      if (
        !Number.isSafeInteger(history.sequenceNumber) ||
        history.sequenceNumber !== expectedSequence
      ) {
        accountBlocker = `Account ${accountId} tier history ${history.id} has sequence ${history.sequenceNumber}; expected contiguous sequence ${expectedSequence}.`;
        break;
      }
    }
    if (accountBlocker) {
      blockedAccountIds.add(accountId);
      blockers.push(accountBlocker);
      continue;
    }
    assignments.push(...accountAssignments);
    nextSequenceNumberByAccount.set(accountId, ordered.length + 1);
  }

  return {
    assignments,
    blockedAccountIds,
    blockers,
    nextSequenceNumberByAccount,
    orderedHistoriesByAccount,
  };
}

type PreCutoverOrderCandidate = {
  orderId: string;
  storeId: string;
  externalId: string;
  status: string;
  occurredAt: Date;
  shopperId: string;
  accountId: string;
  programId: string;
  legacyEarnLedgerPresent: boolean;
};

type PreCutoverOrderInspection = {
  totalCandidates: number;
  candidatesWithLegacyEarnLedger: number;
  issuesCreated: number;
  byStore: Record<string, number>;
  samples: PreCutoverOrderCandidate[];
};

type PolicyBindingInspection = {
  boundOrders: number;
  boundGrants: number;
  blockers: string[];
};

function parseCutoverAt(value: string | undefined) {
  if (!value) {
    throw new Error(
      "A global --cutover-at=<ISO-8601 timestamp> is required for both audit and apply modes.",
    );
  }
  const cutoverAt = new Date(value);
  if (!Number.isFinite(cutoverAt.getTime())) {
    throw new Error("--cutover-at must be a valid ISO-8601 timestamp.");
  }
  return cutoverAt;
}

function cutoverReason(cutoverAt: Date) {
  return `${CUTOVER_REASON_PREFIX}${cutoverAt.toISOString()}`;
}

function tierMarkerId(accountId: string, cutoverAt: Date) {
  const digest = createHash("sha256")
    .update(JSON.stringify(["earn_policy_cutover_tier", accountId, cutoverAt]))
    .digest("hex")
    .slice(0, 20);
  return `wtier_${digest}`;
}

async function inspectMaintenanceFence(
  client: typeof prisma | Prisma.TransactionClient,
) {
  const [
    writeEnabledPrograms,
    provisioningRedemptions,
    blockingOutboxJobs,
    committingBackfills,
    blockingLifecycleRequests,
    blockingFinancialWebhooks,
  ] = await Promise.all([
    client.weleticLoyaltyProgram.count({
      where: { status: "active", killSwitchActive: false },
    }),
    client.weleticRewardRedemption.count({
      where: { status: "provisioning" },
    }),
    client.weleticLoyaltyOutboxJob.count({
      where: { status: { in: [...BLOCKING_OUTBOX_JOB_STATUSES] } },
    }),
    client.weleticLoyaltyBackfillJob.count({
      where: { status: "committing" },
    }),
    client.weleticShopifyComplianceRequest.count({
      where: {
        requestType: { in: ["app_uninstalled", "shop_redact"] },
        status: { not: "completed" },
      },
    }),
    client.weleticShopifyWebhookEvent.count({
      where: {
        topic: { in: [...FINANCIAL_WEBHOOK_TOPICS] },
        status: { in: [...BLOCKING_WEBHOOK_STATUSES] },
      },
    }),
  ]);

  return {
    writeEnabledPrograms,
    provisioningRedemptions,
    blockingOutboxJobs,
    committingBackfills,
    blockingLifecycleRequests,
    blockingFinancialWebhooks,
  };
}

function isMaintenanceFenceReady(
  fence: Awaited<ReturnType<typeof inspectMaintenanceFence>>,
) {
  return Object.values(fence).every((count) => count === 0);
}

function assertMaintenanceFence(
  maintenanceFence: string | undefined,
  fence: Awaited<ReturnType<typeof inspectMaintenanceFence>>,
) {
  if (maintenanceFence !== EARN_POLICY_CUTOVER_MAINTENANCE_FENCE) {
    throw new Error(
      `Refusing earn-policy cutover writes without --maintenance-fence=${EARN_POLICY_CUTOVER_MAINTENANCE_FENCE}.`,
    );
  }
  if (!isMaintenanceFenceReady(fence)) {
    throw new Error(
      `Earn-policy cutover fence is not drained (${Object.entries(fence)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}).`,
    );
  }
}

async function loadPrograms(
  storeIds: Set<string>,
): Promise<ProgramProjection[]> {
  return prisma.weleticLoyaltyProgram.findMany({
    where: { storeId: { in: [...storeIds] } },
    orderBy: [{ storeId: "asc" }, { id: "asc" }],
    include: {
      earningRules: true,
      bonusCampaigns: true,
      tiers: true,
    },
  });
}

async function loadStoreIds() {
  const stores = await prisma.weleticShopifyStore.findMany({
    where: { complianceState: { not: "redacted" } },
    select: { id: true },
  });
  return new Set(stores.map(({ id }) => id));
}

function latestMutablePolicyTimestamp(program: ProgramProjection) {
  return [
    program.updatedAt,
    ...program.earningRules.map((rule) => rule.updatedAt),
    ...program.bonusCampaigns.map((campaign) => campaign.updatedAt),
    ...program.tiers.map((tier) => tier.updatedAt),
  ].reduce((latest, timestamp) => (timestamp > latest ? timestamp : latest));
}

function hasNonEmptyRuleConditions(value: Prisma.JsonValue | null) {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

async function inspectBaselines({
  programs,
  storeIds,
  cutoverAt,
  now,
}: {
  programs: ProgramProjection[];
  storeIds: Set<string>;
  cutoverAt: Date;
  now: Date;
}): Promise<BaselineInspection> {
  const desiredReason = cutoverReason(cutoverAt);
  const programIds = programs.map(({ id }) => id);
  const programIdSet = new Set(programIds);
  const programById = new Map(programs.map((program) => [program.id, program]));
  // relationMode="prisma" does not provide database foreign keys. Audit every
  // revision, including non-cutover rows whose parent program may be gone.
  const revisions = await prisma.weleticLoyaltyEarnPolicyRevision.findMany({
    orderBy: [{ programId: "asc" }, { version: "asc" }],
  });
  const allCutoverRevisions = revisions.filter((revision) =>
    revision.reason?.startsWith(CUTOVER_REASON_PREFIX),
  );
  const blockers: string[] = [];
  const baselinesToCreate: BaselineInspection["baselinesToCreate"] = [];
  let existingBaselines = 0;

  for (const revision of revisions) {
    const parent = programById.get(revision.programId);
    if (!parent) {
      blockers.push(
        `Loyalty earn-policy revision ${revision.id} references missing program ${revision.programId}.`,
      );
      continue;
    }
    if (
      revision.storeId !== parent.storeId ||
      !storeIds.has(revision.storeId)
    ) {
      blockers.push(
        `Loyalty earn-policy revision ${revision.id} crosses or references a missing Shopify store.`,
      );
    }
  }

  for (const revision of allCutoverRevisions) {
    if (!programIdSet.has(revision.programId)) {
      blockers.push(
        `Global earn-policy cutover revision ${revision.id} references missing program ${revision.programId}.`,
      );
    }
    if (
      revision.reason !== desiredReason ||
      revision.effectiveAt.getTime() !== cutoverAt.getTime()
    ) {
      blockers.push(
        `Existing global earn-policy cutover revision ${revision.id} uses ${revision.effectiveAt.toISOString()}; rerun with that exact T0 instead of creating a second cutover.`,
      );
    }
  }

  const revisionsByProgram = new Map<string, typeof revisions>();
  for (const revision of revisions) {
    const rows = revisionsByProgram.get(revision.programId) ?? [];
    rows.push(revision);
    revisionsByProgram.set(revision.programId, rows);
  }

  for (const program of programs) {
    const rows = revisionsByProgram.get(program.id) ?? [];
    const head = rows.at(-1);
    const exactBaselines = rows.filter(
      (revision) =>
        revision.reason === desiredReason &&
        revision.effectiveAt.getTime() === cutoverAt.getTime(),
    );

    if (!storeIds.has(program.storeId)) {
      blockers.push(
        `Loyalty program ${program.id} references missing Shopify store ${program.storeId}.`,
      );
    }
    const unsupportedOrderRules = program.earningRules.filter(
      (rule) =>
        rule.deletedAt === null &&
        rule.triggerCode === "order_paid" &&
        !rule.excludeTaxesAndShipping,
    );
    if (unsupportedOrderRules.length > 0) {
      blockers.push(
        `Program ${program.id} has tax/shipping-inclusive order rules without refund-safe allocation: ${unsupportedOrderRules
          .map(({ id }) => id)
          .join(", ")}.`,
      );
    }
    const conditionedOrderRules = program.earningRules.filter(
      (rule) =>
        rule.deletedAt === null &&
        rule.isActive &&
        rule.triggerCode === "order_paid" &&
        hasNonEmptyRuleConditions(rule.conditions),
    );
    if (conditionedOrderRules.length > 0) {
      blockers.push(
        `Program ${program.id} has active conditioned order rules that the revision runtime cannot evaluate safely: ${conditionedOrderRules
          .map(({ id }) => id)
          .join(", ")}.`,
      );
    }

    if ((head?.version ?? 0) !== program.earnPolicyVersion) {
      blockers.push(
        `Program ${program.id} has earnPolicyVersion=${program.earnPolicyVersion} but revision head=${head?.version ?? 0}.`,
      );
    }
    rows.forEach((revision, index) => {
      if (revision.version !== index + 1) {
        blockers.push(
          `Program ${program.id} has a non-contiguous revision version ${revision.version}.`,
        );
      }
      try {
        verifyLoyaltyEarnPolicyRevisionSnapshot({
          revisionId: revision.id,
          storeId: revision.storeId,
          programId: revision.programId,
          schemaVersion: revision.schemaVersion,
          snapshot: revision.snapshot,
          fingerprint: revision.fingerprint,
          expectedStoreId: program.storeId,
          expectedProgramId: program.id,
        });
      } catch (error) {
        blockers.push(
          `Program ${program.id} revision ${revision.id} is invalid: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    });

    if (exactBaselines.length > 1) {
      blockers.push(
        `Program ${program.id} has multiple baseline revisions at the global cutover T0.`,
      );
      continue;
    }
    const baseline = exactBaselines[0];
    if (baseline) {
      existingBaselines += 1;
      if (baseline.version !== 1) {
        blockers.push(
          `Program ${program.id} baseline is version ${baseline.version}; the cutover baseline must be its first revision.`,
        );
      }
      if (head) {
        if (head.id !== baseline.id) {
          blockers.push(
            `Program ${program.id} has revisions after its cutover baseline; this cutover utility may only be retried before revision-aware writers resume.`,
          );
        }
        const currentFingerprint =
          buildLoyaltyEarnPolicySnapshot(program).fingerprint;
        if (currentFingerprint !== head.fingerprint) {
          blockers.push(
            `Program ${program.id} mutable policy no longer matches revision head ${head.id}.`,
          );
        }
      }
      continue;
    }

    if (rows.length > 0 || program.earnPolicyVersion !== 0) {
      blockers.push(
        `Program ${program.id} already has revision history without the requested global cutover baseline.`,
      );
      continue;
    }
    const latestMutation = latestMutablePolicyTimestamp(program);
    if (latestMutation > cutoverAt) {
      blockers.push(
        `Program ${program.id} policy changed at ${latestMutation.toISOString()}, after T0; refusing to backdate current state.`,
      );
      continue;
    }
    baselinesToCreate.push({
      programId: program.id,
      storeId: program.storeId,
      expectedFingerprint: buildLoyaltyEarnPolicySnapshot(program).fingerprint,
    });
  }

  const hasExistingCutover =
    existingBaselines > 0 || allCutoverRevisions.length > 0;
  if (
    cutoverAt.getTime() > now.getTime() ||
    (programs.length > 0 &&
      !hasExistingCutover &&
      now.getTime() - cutoverAt.getTime() > MAX_FIRST_CUTOVER_AGE_MS)
  ) {
    blockers.push(
      "The first global cutover T0 must be current (not future and no more than five minutes old). A partial rerun may reuse its already-persisted T0 while writers remain fenced.",
    );
  }

  return {
    totalPrograms: programs.length,
    existingBaselines,
    baselinesToCreate,
    blockers: Array.from(new Set(blockers)),
  };
}

async function inspectPolicyBindings({
  programs,
  storeIds,
}: {
  programs: ProgramProjection[];
  storeIds: Set<string>;
}): Promise<PolicyBindingInspection> {
  const programById = new Map(programs.map((program) => [program.id, program]));
  const blockers: string[] = [];
  let boundOrders = 0;
  let boundGrants = 0;
  let orderCursor: string | undefined;

  do {
    const orders = await prisma.weleticCommerceOrder.findMany({
      where: { loyaltyPolicyRevisionId: { not: null } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      skip: orderCursor ? 1 : 0,
      cursor: orderCursor ? { id: orderCursor } : undefined,
      select: {
        id: true,
        storeId: true,
        loyaltyPolicyRevisionId: true,
      },
    });
    if (orders.length === 0) break;
    orderCursor = orders.at(-1)?.id;
    boundOrders += orders.length;
    const revisions = await prisma.weleticLoyaltyEarnPolicyRevision.findMany({
      where: {
        id: {
          in: orders.flatMap(({ loyaltyPolicyRevisionId }) =>
            loyaltyPolicyRevisionId ? [loyaltyPolicyRevisionId] : [],
          ),
        },
      },
      select: { id: true, storeId: true, programId: true },
    });
    const revisionById = new Map(
      revisions.map((revision) => [revision.id, revision]),
    );
    for (const order of orders) {
      const revisionId = order.loyaltyPolicyRevisionId;
      const revision = revisionId ? revisionById.get(revisionId) : undefined;
      const parent = revision ? programById.get(revision.programId) : undefined;
      if (
        !revision ||
        revision.storeId !== order.storeId ||
        !storeIds.has(order.storeId) ||
        !parent ||
        parent.storeId !== order.storeId
      ) {
        blockers.push(
          `Commerce order ${order.id} has an orphan or cross-tenant loyalty policy binding ${revisionId ?? "null"}.`,
        );
      }
    }
  } while (orderCursor);

  let grantCursor: string | undefined;
  do {
    const grants = await prisma.weleticLoyaltyEarnGrant.findMany({
      where: { policyRevisionId: { not: null } },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      skip: grantCursor ? 1 : 0,
      cursor: grantCursor ? { id: grantCursor } : undefined,
      select: {
        id: true,
        storeId: true,
        programId: true,
        policyRevisionId: true,
      },
    });
    if (grants.length === 0) break;
    grantCursor = grants.at(-1)?.id;
    boundGrants += grants.length;
    const revisions = await prisma.weleticLoyaltyEarnPolicyRevision.findMany({
      where: {
        id: {
          in: grants.flatMap(({ policyRevisionId }) =>
            policyRevisionId ? [policyRevisionId] : [],
          ),
        },
      },
      select: { id: true, storeId: true, programId: true },
    });
    const revisionById = new Map(
      revisions.map((revision) => [revision.id, revision]),
    );
    for (const grant of grants) {
      const revisionId = grant.policyRevisionId;
      const revision = revisionId ? revisionById.get(revisionId) : undefined;
      const parent = programById.get(grant.programId);
      if (
        !revision ||
        revision.storeId !== grant.storeId ||
        revision.programId !== grant.programId ||
        !storeIds.has(grant.storeId) ||
        !parent ||
        parent.storeId !== grant.storeId
      ) {
        blockers.push(
          `Loyalty earn grant ${grant.id} has an orphan or cross-tenant policy binding ${revisionId ?? "null"}.`,
        );
      }
    }
  } while (grantCursor);

  return {
    boundOrders,
    boundGrants,
    blockers: Array.from(new Set(blockers)),
  };
}

async function inspectTierMarkers({
  programs,
  cutoverAt,
}: {
  programs: ProgramProjection[];
  cutoverAt: Date;
}): Promise<TierInspection> {
  const programById = new Map(programs.map((program) => [program.id, program]));
  const activeTierIdsByProgram = new Map(
    programs.map((program) => [
      program.id,
      new Set(
        program.tiers
          .filter((tier) => tier.deletedAt === null)
          .map((tier) => tier.id),
      ),
    ]),
  );
  const markersToCreate: TierMarkerCandidate[] = [];
  const sequenceAssignments: TierHistorySequenceAssignment[] = [];
  const blockers: string[] = [];
  let accountsWithCurrentTier = 0;
  let usableHistories = 0;
  let cursor: string | undefined;

  do {
    const accounts = await prisma.weleticLoyaltyAccount.findMany({
      where: {
        programId: { in: [...programById.keys()] },
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      select: {
        id: true,
        storeId: true,
        programId: true,
        currentTierId: true,
        tierSpendRolling12Months: true,
        tierPointsRolling12Months: true,
        updatedAt: true,
      },
    });
    if (accounts.length === 0) break;
    cursor = accounts.at(-1)?.id;
    accountsWithCurrentTier += accounts.filter(
      ({ currentTierId }) => currentTierId !== null,
    ).length;

    const histories = await prisma.weleticLoyaltyTierHistory.findMany({
      where: {
        accountId: { in: accounts.map(({ id }) => id) },
      },
      orderBy: [{ accountId: "asc" }, { effectiveAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        accountId: true,
        effectiveAt: true,
        sequenceNumber: true,
        toTierId: true,
      },
    });
    const historiesAfterCutover = histories.filter(
      (history) => history.effectiveAt > cutoverAt,
    );
    const accountsWithPostCutoverHistory = new Set(
      historiesAfterCutover.map(({ accountId }) => accountId),
    );
    for (const history of historiesAfterCutover) {
      blockers.push(
        `Account ${history.accountId} has tier history ${history.id} effective after T0 at ${history.effectiveAt.toISOString()}; keep writers fenced and choose a current global cutover timestamp.`,
      );
    }

    const sequencePlan = planTierHistorySequences(
      histories.filter((history) => history.effectiveAt <= cutoverAt),
    );
    blockers.push(...sequencePlan.blockers);
    const accountById = new Map(
      accounts.map((account) => [account.id, account]),
    );
    for (const assignment of sequencePlan.assignments) {
      const account = accountById.get(assignment.accountId);
      if (!account || accountsWithPostCutoverHistory.has(account.id)) continue;
      sequenceAssignments.push({
        ...assignment,
        storeId: account.storeId,
        programId: account.programId,
      });
    }

    for (const account of accounts) {
      const program = programById.get(account.programId);
      const tierId = account.currentTierId;
      if (
        !program ||
        program.storeId !== account.storeId ||
        (tierId !== null &&
          !activeTierIdsByProgram.get(account.programId)?.has(tierId))
      ) {
        blockers.push(
          `Account ${account.id} has a current tier outside its store-scoped active policy.`,
        );
        continue;
      }
      if (
        sequencePlan.blockedAccountIds.has(account.id) ||
        accountsWithPostCutoverHistory.has(account.id)
      ) {
        continue;
      }
      if (!tierId) continue;
      const orderedHistories =
        sequencePlan.orderedHistoriesByAccount.get(account.id) ?? [];
      if (orderedHistories.at(-1)?.toTierId === tierId) {
        usableHistories += 1;
        continue;
      }
      if (account.updatedAt > cutoverAt) {
        blockers.push(
          `Account ${account.id} changed at ${account.updatedAt.toISOString()}, after T0; refusing to backdate a tier marker.`,
        );
        continue;
      }
      markersToCreate.push({
        accountId: account.id,
        storeId: account.storeId,
        programId: account.programId,
        tierId,
        nextSequenceNumber:
          sequencePlan.nextSequenceNumberByAccount.get(account.id) ?? 1,
        accountUpdatedAt: account.updatedAt,
        qualifyingSpendSnapshot: account.tierSpendRolling12Months,
        qualifyingPointsSnapshot: account.tierPointsRolling12Months,
      });
    }
  } while (cursor);

  return {
    accountsWithCurrentTier,
    usableHistories,
    sequenceAssignments,
    markersToCreate,
    blockers: Array.from(new Set(blockers)),
  };
}

async function scanPreCutoverOrders({
  programs,
  cutoverAt,
  quarantine,
}: {
  programs: ProgramProjection[];
  cutoverAt: Date;
  quarantine: boolean;
}): Promise<PreCutoverOrderInspection> {
  const programByStoreId = new Map(
    programs.map((program) => [program.storeId, program]),
  );
  const result: PreCutoverOrderInspection = {
    totalCandidates: 0,
    candidatesWithLegacyEarnLedger: 0,
    issuesCreated: 0,
    byStore: {},
    samples: [],
  };
  let cursor: string | undefined;

  do {
    const orders = await prisma.weleticCommerceOrder.findMany({
      where: {
        storeId: { in: [...programByStoreId.keys()] },
        occurredAt: { lt: cutoverAt },
        status: { in: [...EARN_ELIGIBLE_ORDER_STATUSES] },
        shopperId: { not: null },
        loyaltyEarnGrants: { none: {} },
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      select: {
        id: true,
        storeId: true,
        externalId: true,
        status: true,
        occurredAt: true,
        shopperId: true,
      },
    });
    if (orders.length === 0) break;
    cursor = orders.at(-1)?.id;
    const shopperIds = orders.flatMap((order) =>
      order.shopperId ? [order.shopperId] : [],
    );
    const accounts = await prisma.weleticLoyaltyAccount.findMany({
      where: { shopperId: { in: shopperIds } },
      select: { id: true, storeId: true, programId: true, shopperId: true },
    });
    const accountByShopperId = new Map(
      accounts.map((account) => [account.shopperId, account]),
    );
    const ledgerEntries = await prisma.weleticPointsLedgerEntry.findMany({
      where: {
        storeId: { in: [...programByStoreId.keys()] },
        idempotencyKey: {
          in: orders.map((order) => `earn_order:${order.id}`),
        },
      },
      select: { storeId: true, idempotencyKey: true },
    });
    const legacyLedgerKeys = new Set(
      ledgerEntries.map((entry) => `${entry.storeId}\0${entry.idempotencyKey}`),
    );
    const candidates: PreCutoverOrderCandidate[] = [];

    for (const order of orders) {
      const program = programByStoreId.get(order.storeId);
      const account = order.shopperId
        ? accountByShopperId.get(order.shopperId)
        : undefined;
      if (
        !program ||
        !account ||
        account.storeId !== order.storeId ||
        account.programId !== program.id ||
        !order.shopperId
      ) {
        continue;
      }
      const candidate: PreCutoverOrderCandidate = {
        orderId: order.id,
        storeId: order.storeId,
        externalId: order.externalId,
        status: order.status,
        occurredAt: order.occurredAt,
        shopperId: order.shopperId,
        accountId: account.id,
        programId: account.programId,
        legacyEarnLedgerPresent: legacyLedgerKeys.has(
          `${order.storeId}\0earn_order:${order.id}`,
        ),
      };
      candidates.push(candidate);
      result.totalCandidates += 1;
      result.byStore[order.storeId] = (result.byStore[order.storeId] ?? 0) + 1;
      if (candidate.legacyEarnLedgerPresent) {
        result.candidatesWithLegacyEarnLedger += 1;
      }
      if (result.samples.length < 50) result.samples.push(candidate);
    }

    if (quarantine && candidates.length > 0) {
      const existingIssues = await prisma.weleticReconciliationIssue.findMany({
        where: {
          kind: PRE_CUTOVER_ORDER_ISSUE_KIND,
          OR: candidates.map((candidate) => ({
            storeId: candidate.storeId,
            externalKey: candidate.orderId,
          })),
        },
        select: { storeId: true, externalKey: true },
      });
      const existingKeys = new Set(
        existingIssues.map((issue) => `${issue.storeId}\0${issue.externalKey}`),
      );
      const missingIssues: Prisma.WeleticReconciliationIssueCreateManyInput[] =
        candidates
          .filter(
            (candidate) =>
              !existingKeys.has(`${candidate.storeId}\0${candidate.orderId}`),
          )
          .map((candidate) => ({
            id: createWeleticId("wrecon_"),
            storeId: candidate.storeId,
            externalKey: candidate.orderId,
            kind: PRE_CUTOVER_ORDER_ISSUE_KIND,
            severity: "critical",
            status: "open",
            detectedAt: new Date(),
            details: {
              orderId: candidate.orderId,
              externalOrderId: candidate.externalId,
              orderStatus: candidate.status,
              orderOccurredAt: candidate.occurredAt.toISOString(),
              shopperId: candidate.shopperId,
              accountId: candidate.accountId,
              programId: candidate.programId,
              cutoverAt: cutoverAt.toISOString(),
              legacyEarnLedgerPresent: candidate.legacyEarnLedgerPresent,
              resolutionMarker:
                "do_not_evaluate_with_current_policy; use_authoritative_legacy_ledger_or_reviewed_historical_backfill",
            } satisfies Prisma.InputJsonObject,
          }));
      if (missingIssues.length > 0) {
        const created = await prisma.weleticReconciliationIssue.createMany({
          data: missingIssues,
          skipDuplicates: true,
        });
        result.issuesCreated += created.count;
      }
    }
  } while (cursor);

  return result;
}

async function createBaselines({
  plans,
  cutoverAt,
}: {
  plans: BaselineInspection["baselinesToCreate"];
  cutoverAt: Date;
}) {
  for (const plan of plans) {
    await prisma.$transaction(async (tx) => {
      const locked = await lockLoyaltyProgramRow({
        tx,
        storeId: plan.storeId,
        mode: "lock_only",
      });
      if (
        locked.id !== plan.programId ||
        (locked.status === "active" && !Boolean(locked.killSwitchActive))
      ) {
        throw new Error(
          `Program ${plan.programId} left the maintenance fence before baseline publication.`,
        );
      }
      const lockedProjection = await tx.weleticLoyaltyProgram.findFirst({
        where: { id: plan.programId, storeId: plan.storeId },
        include: {
          earningRules: true,
          bonusCampaigns: true,
          tiers: true,
        },
      });
      if (
        !lockedProjection ||
        buildLoyaltyEarnPolicySnapshot(lockedProjection).fingerprint !==
          plan.expectedFingerprint
      ) {
        throw new Error(
          `Program ${plan.programId} policy changed after the cutover audit.`,
        );
      }
      await publishLoyaltyEarnPolicyRevision({
        tx,
        storeId: plan.storeId,
        programId: plan.programId,
        effectiveAt: cutoverAt,
        reason: cutoverReason(cutoverAt),
      });
    });
  }
}

async function backfillTierHistorySequences({
  assignments,
}: {
  assignments: TierHistorySequenceAssignment[];
}) {
  const byProgram = new Map<string, TierHistorySequenceAssignment[]>();
  for (const assignment of assignments) {
    const rows = byProgram.get(assignment.programId) ?? [];
    rows.push(assignment);
    byProgram.set(assignment.programId, rows);
  }

  let updated = 0;
  for (const programAssignments of byProgram.values()) {
    for (
      let index = 0;
      index < programAssignments.length;
      index += BATCH_SIZE
    ) {
      const batch = programAssignments.slice(index, index + BATCH_SIZE);
      updated += await prisma.$transaction(async (tx) => {
        const first = batch[0];
        const locked = await lockLoyaltyProgramRow({
          tx,
          storeId: first.storeId,
          mode: "lock_only",
        });
        if (
          locked.id !== first.programId ||
          (locked.status === "active" && !Boolean(locked.killSwitchActive))
        ) {
          throw new Error(
            `Program ${first.programId} left the maintenance fence before tier history sequencing.`,
          );
        }

        const accountIds = [
          ...new Set(batch.map(({ accountId }) => accountId)),
        ];
        const accounts = await tx.weleticLoyaltyAccount.findMany({
          where: { id: { in: accountIds } },
          select: { id: true, storeId: true, programId: true },
        });
        const accountById = new Map(
          accounts.map((account) => [account.id, account]),
        );
        const histories = await tx.weleticLoyaltyTierHistory.findMany({
          where: { id: { in: batch.map(({ historyId }) => historyId) } },
          select: {
            id: true,
            accountId: true,
            effectiveAt: true,
            sequenceNumber: true,
          },
        });
        const historyById = new Map(
          histories.map((history) => [history.id, history]),
        );

        let batchUpdated = 0;
        for (const assignment of batch) {
          const account = accountById.get(assignment.accountId);
          const history = historyById.get(assignment.historyId);
          if (
            !account ||
            account.storeId !== assignment.storeId ||
            account.programId !== assignment.programId ||
            !history ||
            history.accountId !== assignment.accountId ||
            history.effectiveAt.getTime() !== assignment.effectiveAt.getTime()
          ) {
            throw new Error(
              `Tier history ${assignment.historyId} changed tenant or event time during cutover.`,
            );
          }
          if (history.sequenceNumber === assignment.sequenceNumber) continue;
          if (history.sequenceNumber !== null) {
            throw new Error(
              `Tier history ${assignment.historyId} acquired conflicting sequence ${history.sequenceNumber} during cutover.`,
            );
          }
          const result = await tx.weleticLoyaltyTierHistory.updateMany({
            where: {
              id: assignment.historyId,
              accountId: assignment.accountId,
              effectiveAt: assignment.effectiveAt,
              sequenceNumber: null,
            },
            data: { sequenceNumber: assignment.sequenceNumber },
          });
          if (result.count !== 1) {
            throw new Error(
              `Tier history ${assignment.historyId} could not be sequenced atomically.`,
            );
          }
          batchUpdated += 1;
        }
        return batchUpdated;
      });
    }
  }
  return updated;
}

async function createTierMarkers({
  candidates,
  cutoverAt,
}: {
  candidates: TierMarkerCandidate[];
  cutoverAt: Date;
}) {
  const byProgram = new Map<string, TierMarkerCandidate[]>();
  for (const candidate of candidates) {
    const rows = byProgram.get(candidate.programId) ?? [];
    rows.push(candidate);
    byProgram.set(candidate.programId, rows);
  }

  let created = 0;
  for (const programCandidates of byProgram.values()) {
    for (let index = 0; index < programCandidates.length; index += BATCH_SIZE) {
      const batch = programCandidates.slice(index, index + BATCH_SIZE);
      created += await prisma.$transaction(async (tx) => {
        const first = batch[0];
        const locked = await lockLoyaltyProgramRow({
          tx,
          storeId: first.storeId,
          mode: "lock_only",
        });
        if (
          locked.id !== first.programId ||
          (locked.status === "active" && !Boolean(locked.killSwitchActive))
        ) {
          throw new Error(
            `Program ${first.programId} left the maintenance fence before tier marker creation.`,
          );
        }
        const accounts = await tx.weleticLoyaltyAccount.findMany({
          where: { id: { in: batch.map(({ accountId }) => accountId) } },
          select: {
            id: true,
            storeId: true,
            programId: true,
            currentTierId: true,
            tierSpendRolling12Months: true,
            tierPointsRolling12Months: true,
            updatedAt: true,
          },
        });
        const accountById = new Map(
          accounts.map((account) => [account.id, account]),
        );
        const histories = await tx.weleticLoyaltyTierHistory.findMany({
          where: {
            accountId: { in: batch.map(({ accountId }) => accountId) },
          },
          orderBy: [{ accountId: "asc" }, { sequenceNumber: "desc" }],
          select: {
            id: true,
            accountId: true,
            toTierId: true,
            effectiveAt: true,
            sequenceNumber: true,
          },
        });
        const latestByAccount = new Map<string, (typeof histories)[number]>();
        const historiesByAccount = new Map<
          string,
          (typeof histories)[number][]
        >();
        for (const history of histories) {
          const accountHistories =
            historiesByAccount.get(history.accountId) ?? [];
          accountHistories.push(history);
          historiesByAccount.set(history.accountId, accountHistories);
          if (!latestByAccount.has(history.accountId)) {
            latestByAccount.set(history.accountId, history);
          }
        }
        const activeTiers = await tx.weleticLoyaltyTier.findMany({
          where: {
            programId: first.programId,
            deletedAt: null,
            id: { in: batch.map(({ tierId }) => tierId) },
          },
          select: { id: true },
        });
        const activeTierIds = new Set(activeTiers.map(({ id }) => id));
        const rows: Prisma.WeleticLoyaltyTierHistoryCreateManyInput[] = [];

        for (const candidate of batch) {
          const account = accountById.get(candidate.accountId);
          if (
            !account ||
            account.storeId !== candidate.storeId ||
            account.programId !== candidate.programId ||
            account.currentTierId !== candidate.tierId ||
            account.updatedAt.getTime() !==
              candidate.accountUpdatedAt.getTime() ||
            account.updatedAt > cutoverAt ||
            !activeTierIds.has(candidate.tierId)
          ) {
            throw new Error(
              `Account ${candidate.accountId} changed tenant or tier state during cutover.`,
            );
          }
          const accountHistories =
            historiesByAccount.get(candidate.accountId) ?? [];
          const invalidHistory = accountHistories.find(
            (history) =>
              history.effectiveAt > cutoverAt ||
              !Number.isSafeInteger(history.sequenceNumber) ||
              Number(history.sequenceNumber) < 1,
          );
          if (invalidHistory) {
            throw new Error(
              `Account ${candidate.accountId} acquired invalid or post-cutover tier history ${invalidHistory.id} during cutover.`,
            );
          }
          if (
            latestByAccount.get(candidate.accountId)?.toTierId ===
            candidate.tierId
          ) {
            continue;
          }
          const latestSequence =
            latestByAccount.get(candidate.accountId)?.sequenceNumber ?? 0;
          if (
            latestSequence + 1 !== candidate.nextSequenceNumber ||
            accountHistories.length + 1 !== candidate.nextSequenceNumber
          ) {
            throw new Error(
              `Account ${candidate.accountId} tier history changed after the cutover audit.`,
            );
          }
          rows.push({
            id: tierMarkerId(candidate.accountId, cutoverAt),
            accountId: candidate.accountId,
            sequenceNumber: candidate.nextSequenceNumber,
            fromTierId: candidate.tierId,
            toTierId: candidate.tierId,
            changeReason: "program_activation",
            notes: `Earn-policy cutover tier-state marker at ${cutoverAt.toISOString()}; not a tier transition.`,
            qualifyingSpendSnapshot: candidate.qualifyingSpendSnapshot,
            qualifyingPointsSnapshot: candidate.qualifyingPointsSnapshot,
            effectiveAt: cutoverAt,
          });
        }
        if (rows.length === 0) return 0;
        const inserted = await tx.weleticLoyaltyTierHistory.createMany({
          data: rows,
          skipDuplicates: true,
        });
        return inserted.count;
      });
    }
  }
  return created;
}

export async function backfillEarnPolicyRevisions({
  cutoverAt,
  apply = false,
  maintenanceFence,
}: {
  cutoverAt: Date;
  apply?: boolean;
  maintenanceFence?: string;
}) {
  const normalizedCutoverAt = new Date(cutoverAt);
  if (!Number.isFinite(normalizedCutoverAt.getTime())) {
    throw new Error("cutoverAt must be a valid timestamp.");
  }
  const now = new Date();
  const storeIds = await loadStoreIds();
  const programs = await loadPrograms(storeIds);
  const initialFence = await inspectMaintenanceFence(prisma);
  const [baseline, policyBindings, tiers, preCutoverOrders] = await Promise.all(
    [
      inspectBaselines({
        programs,
        storeIds,
        cutoverAt: normalizedCutoverAt,
        now,
      }),
      inspectPolicyBindings({ programs, storeIds }),
      inspectTierMarkers({ programs, cutoverAt: normalizedCutoverAt }),
      scanPreCutoverOrders({
        programs,
        cutoverAt: normalizedCutoverAt,
        quarantine: false,
      }),
    ],
  );
  const maintenanceAcknowledged =
    maintenanceFence === EARN_POLICY_CUTOVER_MAINTENANCE_FENCE;
  const blockers = [
    ...baseline.blockers,
    ...policyBindings.blockers,
    ...tiers.blockers,
  ];
  const readyToApply =
    maintenanceAcknowledged &&
    isMaintenanceFenceReady(initialFence) &&
    blockers.length === 0;

  if (!apply) {
    return {
      dryRun: true,
      scope: "all_stores" as const,
      cutoverAt: normalizedCutoverAt.toISOString(),
      maintenanceAcknowledged,
      maintenanceFence: initialFence,
      baseline: {
        totalPrograms: baseline.totalPrograms,
        existingBaselines: baseline.existingBaselines,
        baselinesToCreate: baseline.baselinesToCreate.length,
      },
      policyBindings: {
        boundOrders: policyBindings.boundOrders,
        boundGrants: policyBindings.boundGrants,
      },
      tierHistory: {
        accountsWithCurrentTier: tiers.accountsWithCurrentTier,
        usableHistories: tiers.usableHistories,
        historiesToSequence: tiers.sequenceAssignments.length,
        markersToCreate: tiers.markersToCreate.length,
      },
      preCutoverOrders,
      blockers,
      readyToApply,
    };
  }

  assertMaintenanceFence(maintenanceFence, initialFence);
  if (blockers.length > 0) {
    throw new Error(
      `Earn-policy cutover audit has blockers: ${blockers.join(" | ")}`,
    );
  }

  await createBaselines({
    plans: baseline.baselinesToCreate,
    cutoverAt: normalizedCutoverAt,
  });
  const tierHistoriesSequenced = await backfillTierHistorySequences({
    assignments: tiers.sequenceAssignments,
  });
  const tierMarkersCreated = await createTierMarkers({
    candidates: tiers.markersToCreate,
    cutoverAt: normalizedCutoverAt,
  });
  const initialQuarantinedOrders = await scanPreCutoverOrders({
    programs,
    cutoverAt: normalizedCutoverAt,
    quarantine: true,
  });

  const verificationFence = await inspectMaintenanceFence(prisma);
  assertMaintenanceFence(maintenanceFence, verificationFence);
  const refreshedStoreIds = await loadStoreIds();
  const refreshedPrograms = await loadPrograms(refreshedStoreIds);
  const [finalBaseline, finalPolicyBindings, finalTiers] = await Promise.all([
    inspectBaselines({
      programs: refreshedPrograms,
      storeIds: refreshedStoreIds,
      cutoverAt: normalizedCutoverAt,
      now: new Date(),
    }),
    inspectPolicyBindings({
      programs: refreshedPrograms,
      storeIds: refreshedStoreIds,
    }),
    inspectTierMarkers({
      programs: refreshedPrograms,
      cutoverAt: normalizedCutoverAt,
    }),
  ]);
  const finalBlockers = [
    ...finalBaseline.blockers,
    ...finalPolicyBindings.blockers,
    ...finalTiers.blockers,
  ];
  if (
    finalBlockers.length > 0 ||
    finalBaseline.baselinesToCreate.length > 0 ||
    finalTiers.sequenceAssignments.length > 0 ||
    finalTiers.markersToCreate.length > 0
  ) {
    throw new Error(
      `Persisted earn-policy cutover verification failed: ${[
        ...finalBlockers,
        finalBaseline.baselinesToCreate.length > 0
          ? `${finalBaseline.baselinesToCreate.length} baselines remain`
          : "",
        finalTiers.sequenceAssignments.length > 0
          ? `${finalTiers.sequenceAssignments.length} tier histories remain unsequenced`
          : "",
        finalTiers.markersToCreate.length > 0
          ? `${finalTiers.markersToCreate.length} tier markers remain`
          : "",
      ]
        .filter(Boolean)
        .join(" | ")}`,
    );
  }
  const quarantinedOrders = await scanPreCutoverOrders({
    programs: refreshedPrograms,
    cutoverAt: normalizedCutoverAt,
    quarantine: true,
  });
  const finalFence = await inspectMaintenanceFence(prisma);
  assertMaintenanceFence(maintenanceFence, finalFence);

  return {
    dryRun: false,
    scope: "all_stores" as const,
    cutoverAt: normalizedCutoverAt.toISOString(),
    maintenanceAcknowledged: true,
    maintenanceFence: finalFence,
    baselinesCreated: baseline.baselinesToCreate.length,
    existingBaselines: baseline.existingBaselines,
    policyBindings: {
      boundOrders: finalPolicyBindings.boundOrders,
      boundGrants: finalPolicyBindings.boundGrants,
    },
    tierHistoriesSequenced,
    tierMarkersCreated,
    preCutoverOrders: quarantinedOrders,
    reconciliationIssuesCreated:
      initialQuarantinedOrders.issuesCreated + quarantinedOrders.issuesCreated,
    reconciliationIssuesPresent: quarantinedOrders.totalCandidates,
    readyForRuntime: true,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const cutoverArg = args.find((arg) => arg.startsWith("--cutover-at="));
  const maintenanceFenceArg = args.find((arg) =>
    arg.startsWith("--maintenance-fence="),
  );
  const unsupportedStoreArg = args.find((arg) => arg.startsWith("--store="));

  if (unsupportedStoreArg) {
    console.error(
      new Error(
        "Store-scoped earn-policy cutover is forbidden; remove --store and audit every store at one global T0.",
      ),
    );
    process.exitCode = 1;
  } else {
    Promise.resolve()
      .then(() =>
        backfillEarnPolicyRevisions({
          cutoverAt: parseCutoverAt(cutoverArg?.slice("--cutover-at=".length)),
          apply,
          maintenanceFence: maintenanceFenceArg?.slice(
            "--maintenance-fence=".length,
          ),
        }),
      )
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        if (result.dryRun && !result.readyToApply) process.exitCode = 2;
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
