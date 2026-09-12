import { prisma } from "@/lib/prisma";
import { loadShopifyPrivacyHmacKeyring } from "@/lib/weletic/shopify/privacy-identity";
import { Prisma } from "@prisma/client";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSIONED_DIGEST_PATTERN =
  /^hmac:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):[A-F0-9]{64}$/;
const CUSTOMER_PSEUDONYM_PATTERN =
  /^redacted:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):[A-F0-9]{64}$/;
const LEGACY_UNKEYED_DIGEST_PATTERN = /^[A-F0-9]{64}$/i;
const MAX_SAMPLE_IDS = 5;
const MAX_BATCH_SIZE = 250;
export const SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS =
  25 * 60 * 60 * 1000;

const AUDIT_SOURCES = [
  "customer_tombstones",
  "shop_tombstones",
  "compliance_requests",
  "shopper_pseudonyms",
  "customer_pseudonyms",
  "shop_pseudonyms",
  "redemption_snapshots",
  "referral_signals",
  "voucher_cleanup_snapshots",
  "nonterminal_outbox_snapshots",
  "webhook_events",
  "pending_installations",
] as const;

type AuditSource = (typeof AUDIT_SOURCES)[number];

export interface ShopifyPrivacyKeyRetirementAuditCursor {
  sourceIndex?: number;
  lastId?: string;
}

export interface ShopifyPrivacyKeyDependencyFinding {
  source: AuditSource;
  keyId: string;
  count: number;
  sampleRecordIds: string[];
}

export interface ShopifyLegacyPrivacyDigestFinding {
  source: AuditSource;
  count: number;
  sampleRecordIds: string[];
}

type AuditRecord = {
  id: string;
  [field: string]: unknown;
};

function auditPage(batchSize: number, lastId?: string) {
  return {
    take: batchSize + 1,
    orderBy: { id: "asc" as const },
    ...(lastId ? { where: { id: { gt: lastId } } } : {}),
  };
}

async function loadAuditPage({
  source,
  batchSize,
  lastId,
}: {
  source: AuditSource;
  batchSize: number;
  lastId?: string;
}): Promise<AuditRecord[]> {
  const page = auditPage(batchSize, lastId);
  if (source === "pending_installations") {
    return prisma.weleticShopifyPendingInstallation.findMany({
      ...page,
      select: { id: true, identityKeyId: true },
    });
  }
  if (source === "customer_tombstones") {
    return prisma.weleticShopifyCustomerPrivacyTombstone.findMany({
      ...page,
      select: { id: true, identityKeyId: true },
    });
  }
  if (source === "shop_tombstones") {
    return prisma.weleticShopifyShopPrivacyTombstone.findMany({
      ...page,
      select: { id: true, identityKeyId: true },
    });
  }
  if (source === "compliance_requests") {
    return prisma.weleticShopifyComplianceRequest.findMany({
      ...page,
      select: {
        id: true,
        subjectKeyId: true,
        authenticatedBodyDigest: true,
        shopDomain: true,
      },
    });
  }
  if (source === "shopper_pseudonyms") {
    return prisma.weleticShopper.findMany({
      ...page,
      select: { id: true, shopifyCustomerId: true },
    });
  }
  if (source === "customer_pseudonyms") {
    return prisma.customer.findMany({
      ...page,
      select: { id: true, externalId: true },
    });
  }
  if (source === "shop_pseudonyms") {
    return prisma.weleticShopifyStore.findMany({
      ...page,
      select: { id: true, shopDomain: true },
    });
  }
  if (source === "redemption_snapshots") {
    return prisma.weleticRewardRedemption.findMany({
      ...page,
      select: { id: true, metadata: true },
    });
  }
  if (source === "referral_signals") {
    return prisma.weleticLoyaltyReferral.findMany({
      ...page,
      select: {
        id: true,
        friendEmailDigest: true,
        ipHash: true,
        userAgentHash: true,
        fraudSignals: true,
        metadata: true,
      },
    });
  }
  if (source === "voucher_cleanup_snapshots") {
    return prisma.weleticShopifyVoucherCleanup.findMany({
      ...page,
      select: { id: true, ownershipSnapshot: true },
    });
  }
  if (source === "nonterminal_outbox_snapshots") {
    return prisma.weleticLoyaltyOutboxJob.findMany({
      ...page,
      where: {
        ...(page.where ?? {}),
        jobType: {
          in: [
            "REFERRAL_REWARD_PROVISION",
            "REDEMPTION_RECOVERY",
            "VOUCHER_PRIVACY_CLEANUP",
          ],
        },
        status: { in: ["pending", "processing", "failed", "dead_letter"] },
      },
      select: { id: true, payload: true },
    });
  }
  return prisma.weleticShopifyWebhookEvent.findMany({
    ...page,
    select: { id: true, authenticatedBodyDigest: true },
  });
}

function everyString(value: unknown, visit: (value: string) => void) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => everyString(item, visit));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => everyString(item, visit));
  }
}

function analyzeAuditRecord({
  source,
  record,
  retiringKeyIds,
}: {
  source: AuditSource;
  record: AuditRecord;
  retiringKeyIds: ReadonlySet<string>;
}) {
  const matchedKeyIds = new Set<string>();
  let legacyDigestFound = false;
  const directKeyIds = [record.identityKeyId, record.subjectKeyId].filter(
    (value): value is string => typeof value === "string",
  );
  directKeyIds.forEach((keyId) => {
    if (retiringKeyIds.has(keyId)) matchedKeyIds.add(keyId);
  });

  everyString(record, (value) => {
    const versionedKeyId =
      value.match(VERSIONED_DIGEST_PATTERN)?.[1] ??
      value.match(CUSTOMER_PSEUDONYM_PATTERN)?.[1];
    if (versionedKeyId && retiringKeyIds.has(versionedKeyId)) {
      matchedKeyIds.add(versionedKeyId);
    }
    for (const keyId of retiringKeyIds) {
      if (
        value.startsWith(`redacted-${keyId}-`) &&
        value.endsWith(".invalid")
      ) {
        matchedKeyIds.add(keyId);
      }
    }
    if (
      [
        "redemption_snapshots",
        "referral_signals",
        "voucher_cleanup_snapshots",
        "nonterminal_outbox_snapshots",
      ].includes(source) &&
      LEGACY_UNKEYED_DIGEST_PATTERN.test(value)
    ) {
      legacyDigestFound = true;
    }
  });
  return { matchedKeyIds, legacyDigestFound };
}

export async function auditShopifyPrivacyKeyRetirementBatch({
  retiringKeyIds,
  cursor = {},
  batchSize = 100,
}: {
  retiringKeyIds: readonly string[];
  cursor?: ShopifyPrivacyKeyRetirementAuditCursor;
  batchSize?: number;
}) {
  const uniqueKeyIds = [
    ...new Set(retiringKeyIds.map((value) => value.trim())),
  ];
  if (
    uniqueKeyIds.length === 0 ||
    uniqueKeyIds.some((keyId) => !KEY_ID_PATTERN.test(keyId))
  ) {
    throw new Error(
      "At least one valid retiring Shopify privacy key id is required.",
    );
  }
  const keyring = loadShopifyPrivacyHmacKeyring();
  const configuredKeyIds = new Set(
    keyring.all.map(({ identityKeyId }) => identityKeyId),
  );
  if (uniqueKeyIds.some((keyId) => !configuredKeyIds.has(keyId))) {
    throw new Error(
      "Every retiring Shopify privacy key must remain configured while the release audit runs.",
    );
  }
  if (uniqueKeyIds.includes(keyring.current.identityKeyId)) {
    throw new Error(
      "The current Shopify privacy writer key cannot be retired; rotate a replacement into the first keyring position before auditing the previous key.",
    );
  }

  const sourceIndex = Math.max(0, cursor.sourceIndex ?? 0);
  const source = AUDIT_SOURCES[sourceIndex];
  if (!source) {
    return {
      completed: true as const,
      cursor: null,
      dependencies: [] as ShopifyPrivacyKeyDependencyFinding[],
      legacyDebt: [] as ShopifyLegacyPrivacyDigestFinding[],
      scanned: 0,
    };
  }
  const boundedBatchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.trunc(batchSize)),
  );
  const records = await loadAuditPage({
    source,
    batchSize: boundedBatchSize,
    lastId: cursor.lastId,
  });
  const hasMore = records.length > boundedBatchSize;
  const bounded = records.slice(0, boundedBatchSize);
  const dependencyMap = new Map<string, ShopifyPrivacyKeyDependencyFinding>();
  let legacyCount = 0;
  const legacySamples: string[] = [];
  const retiring = new Set(uniqueKeyIds);
  for (const record of bounded) {
    const analysis = analyzeAuditRecord({
      source,
      record,
      retiringKeyIds: retiring,
    });
    for (const keyId of analysis.matchedKeyIds) {
      const finding = dependencyMap.get(keyId) ?? {
        source,
        keyId,
        count: 0,
        sampleRecordIds: [],
      };
      finding.count += 1;
      if (finding.sampleRecordIds.length < MAX_SAMPLE_IDS) {
        finding.sampleRecordIds.push(record.id);
      }
      dependencyMap.set(keyId, finding);
    }
    if (analysis.legacyDigestFound) {
      legacyCount += 1;
      if (legacySamples.length < MAX_SAMPLE_IDS) legacySamples.push(record.id);
    }
  }

  const nextSourceIndex = hasMore ? sourceIndex : sourceIndex + 1;
  return {
    completed: nextSourceIndex >= AUDIT_SOURCES.length && !hasMore,
    cursor:
      nextSourceIndex >= AUDIT_SOURCES.length && !hasMore
        ? null
        : ({
            sourceIndex: nextSourceIndex,
            ...(hasMore && bounded.length > 0
              ? { lastId: bounded[bounded.length - 1].id }
              : {}),
          } satisfies ShopifyPrivacyKeyRetirementAuditCursor),
    dependencies: [...dependencyMap.values()],
    legacyDebt:
      legacyCount > 0
        ? [{ source, count: legacyCount, sampleRecordIds: legacySamples }]
        : [],
    scanned: bounded.length,
  };
}

function mergeFindings<
  T extends { source: AuditSource; count: number; sampleRecordIds: string[] },
>(target: Map<string, T>, findings: T[], key: (finding: T) => string) {
  for (const finding of findings) {
    const mapKey = key(finding);
    const existing = target.get(mapKey);
    if (!existing) {
      target.set(mapKey, { ...finding });
      continue;
    }
    existing.count += finding.count;
    existing.sampleRecordIds = [
      ...new Set([...existing.sampleRecordIds, ...finding.sampleRecordIds]),
    ].slice(0, MAX_SAMPLE_IDS);
  }
}

export async function auditShopifyPrivacyKeyRetirement({
  retiringKeyIds,
  retiringKeyLastWriteAt,
  writersFenced,
  now = new Date(),
  batchSize = 100,
}: {
  retiringKeyIds: readonly string[];
  retiringKeyLastWriteAt: Date;
  writersFenced: boolean;
  now?: Date;
  batchSize?: number;
}) {
  if (!writersFenced) {
    throw new Error(
      "Shopify privacy digest writers/workers must be fenced during the retirement audit.",
    );
  }
  if (!Number.isFinite(retiringKeyLastWriteAt.getTime())) {
    throw new Error(
      "The retiring privacy key last-write timestamp is invalid.",
    );
  }
  const overlapMs = now.getTime() - retiringKeyLastWriteAt.getTime();
  const dependencyMap = new Map<string, ShopifyPrivacyKeyDependencyFinding>();
  const legacyMap = new Map<string, ShopifyLegacyPrivacyDigestFinding>();
  let cursor: ShopifyPrivacyKeyRetirementAuditCursor | null = {};
  let scanned = 0;
  while (cursor) {
    const batch = await auditShopifyPrivacyKeyRetirementBatch({
      retiringKeyIds,
      cursor,
      batchSize,
    });
    scanned += batch.scanned;
    mergeFindings(
      dependencyMap,
      batch.dependencies,
      (finding) => `${finding.source}:${finding.keyId}`,
    );
    mergeFindings(legacyMap, batch.legacyDebt, (finding) => finding.source);
    cursor = batch.cursor;
  }
  const dependencies = [...dependencyMap.values()];
  const legacyDebt = [...legacyMap.values()];
  const cacheOverlapSatisfied =
    overlapMs >= SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS;
  return {
    ready:
      dependencies.length === 0 &&
      legacyDebt.length === 0 &&
      cacheOverlapSatisfied,
    cacheOverlapSatisfied,
    minimumCacheOverlapHours:
      SHOPIFY_PRIVACY_KEY_RETIREMENT_MIN_OVERLAP_MS / 3_600_000,
    scanned,
    dependencies,
    legacyDebt,
  };
}

export function serializeShopifyPrivacyKeyRetirementAudit(
  result: Awaited<ReturnType<typeof auditShopifyPrivacyKeyRetirement>>,
): Prisma.JsonObject {
  return JSON.parse(JSON.stringify(result)) as Prisma.JsonObject;
}
