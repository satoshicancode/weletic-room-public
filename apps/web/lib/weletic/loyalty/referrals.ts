import { createId } from "@/lib/api/create-id";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import {
  appendPointsLedgerEntry,
  OptimisticConcurrencyError,
} from "@/lib/weletic/loyalty/ledger";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { getReferralCouponIdempotencyKey } from "@/lib/weletic/loyalty/referral-coupon";
import { createReferralCouponRewardSnapshot } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import { DEFAULT_REFERRAL_RULE_CONFIG } from "@/lib/weletic/loyalty/referral-rule-config";
import { isReferralCouponProvisionable } from "@/lib/weletic/loyalty/rewards";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  createAllShopifyDerivedPrivacyDigests,
  createShopifyDerivedPrivacyDigest,
} from "@/lib/weletic/shopify/privacy-identity";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
} from "@/lib/weletic/shopify/store-compliance-state";
import { nanoid } from "@dub/utils";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardExchangeType,
  WeleticRewardStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";

const REFERRAL_COUPON_CANCELLABLE_STATUSES = new Set<WeleticRedemptionStatus>([
  WeleticRedemptionStatus.provisioning,
  WeleticRedemptionStatus.issued,
  WeleticRedemptionStatus.active,
]);
const REFERRAL_TRANSACTION_RETRIES = 5;
const SAFE_REFERRAL_LINK_KEY_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,118}$/;

function getReferralLinkKey(referralCode: string): string {
  const normalizedCode = referralCode.trim().toLowerCase();
  if (SAFE_REFERRAL_LINK_KEY_SEGMENT.test(normalizedCode)) {
    return `ref-${normalizedCode}`;
  }

  const digest = createHash("sha256")
    .update(referralCode, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `ref-${digest}`;
}

function isReusableReferralLink(
  link: {
    domain: string;
    key: string;
    url: string;
    shortLink: string;
    archived: boolean;
    disabledAt: Date | null;
    expiresAt: Date | null;
  },
  expected: {
    domain: string;
    key: string;
    url: string;
    shortLink: string;
    now: Date;
  },
): boolean {
  return (
    link.domain === expected.domain &&
    link.key === expected.key &&
    link.url === expected.url &&
    link.shortLink === expected.shortLink &&
    !link.archived &&
    !link.disabledAt &&
    (!link.expiresAt || link.expiresAt.getTime() > expected.now.getTime())
  );
}

class ReferralTransactionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralTransactionConflictError";
  }
}

class ReferralLimitReachedError extends Error {
  constructor() {
    super("Advocate has reached the maximum allowed referrals.");
    this.name = "ReferralLimitReachedError";
  }
}

class ReferralAccountInactiveError extends Error {
  constructor() {
    super("Referral account is no longer active.");
    this.name = "ReferralAccountInactiveError";
  }
}

function isRetryableReferralTransactionError(error: unknown): boolean {
  return (
    error instanceof OptimisticConcurrencyError ||
    error instanceof ReferralTransactionConflictError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code))
  );
}

export async function runSerializableReferralTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= REFERRAL_TRANSACTION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        attempt === REFERRAL_TRANSACTION_RETRIES ||
        !isRetryableReferralTransactionError(error)
      ) {
        throw error;
      }
    }
  }

  throw new Error("Referral transaction retry budget exhausted.");
}

function createDefaultReferralRule(
  tx: Prisma.TransactionClient,
  programId: string,
) {
  return tx.weleticLoyaltyReferralRule.create({
    data: {
      id: createWeleticId("wreferral_"),
      programId,
      advocatePointsReward: BigInt(
        DEFAULT_REFERRAL_RULE_CONFIG.advocatePointsReward,
      ),
      refereePointsReward: BigInt(
        DEFAULT_REFERRAL_RULE_CONFIG.refereePointsReward,
      ),
      advocateRewardKind: DEFAULT_REFERRAL_RULE_CONFIG.advocateRewardKind,
      refereeRewardKind: DEFAULT_REFERRAL_RULE_CONFIG.refereeRewardKind,
      advocateRewardDefinitionId:
        DEFAULT_REFERRAL_RULE_CONFIG.advocateRewardDefinitionId,
      refereeRewardDefinitionId:
        DEFAULT_REFERRAL_RULE_CONFIG.refereeRewardDefinitionId,
      minQualifyingOrderSubtotal: new Prisma.Decimal(
        DEFAULT_REFERRAL_RULE_CONFIG.minQualifyingOrderSubtotal,
      ),
      maxReferralsPerAdvocate:
        DEFAULT_REFERRAL_RULE_CONFIG.maxReferralsPerAdvocate,
      fraudCheckSameIp: DEFAULT_REFERRAL_RULE_CONFIG.fraudCheckSameIp,
      isActive: DEFAULT_REFERRAL_RULE_CONFIG.isActive,
    },
  });
}

/**
 * Generates an uppercase, human-friendly referral code.
 */
export function generateReferralCode(prefix?: string): string {
  const cleanPrefix = prefix
    ? prefix
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 6)
        .toUpperCase()
    : "REF";
  const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${cleanPrefix}-${randomPart}`;
}

export type ReferralAbuseSignalKind = "ip" | "user_agent";

const KNOWN_DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "yopmail.com",
]);

export function normalizeReferralPersonName(
  firstName?: string | null,
  lastName?: string | null,
) {
  return [firstName, lastName]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export function getReferralEmailSimilarityKey(email?: string | null) {
  const normalized = email?.normalize("NFKC").trim().toLowerCase();
  if (!normalized) return null;
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) return null;
  let local = normalized.slice(0, separator).split("+", 1)[0];
  let domain = normalized.slice(separator + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  local = local.replace(/[._-]/g, "");
  return `${local}@${domain}`;
}

export function isKnownDisposableReferralEmail(email?: string | null) {
  const normalized = email?.normalize("NFKC").trim().toLowerCase();
  const domain = normalized?.split("@").at(-1);
  return Boolean(domain && KNOWN_DISPOSABLE_EMAIL_DOMAINS.has(domain));
}

function normalizeAbuseSignal(signal?: string | null) {
  return signal?.normalize("NFKC").trim() || null;
}

/** Generates only the current keyed, store-scoped privacy digest. */
export function hashAbuseSignal({
  storeId,
  kind,
  signal,
}: {
  storeId: string;
  kind: ReferralAbuseSignalKind;
  signal?: string | null;
}): string | null {
  const normalized = normalizeAbuseSignal(signal);
  if (!normalized) return null;
  return createShopifyDerivedPrivacyDigest({
    purpose: kind === "ip" ? "referral_ip" : "referral_user_agent",
    values: [storeId.trim(), normalized],
  });
}

/**
 * Rotation-aware lookup includes previous keyed digests and the read-only
 * legacy SHA-256 representation. New referral rows never write the legacy form.
 */
export function getAbuseSignalLookupDigests({
  storeId,
  kind,
  signal,
}: {
  storeId: string;
  kind: ReferralAbuseSignalKind;
  signal?: string | null;
}) {
  const normalized = normalizeAbuseSignal(signal);
  if (!normalized) return [];
  return [
    ...createAllShopifyDerivedPrivacyDigests({
      purpose: kind === "ip" ? "referral_ip" : "referral_user_agent",
      values: [storeId.trim(), normalized],
    }),
    createHash("sha256").update(normalized).digest("hex"),
  ];
}

function assertReferralAccountCanProvision({
  id,
  status,
  metadata,
}: {
  id: string;
  status: string;
  metadata: Prisma.JsonValue | null;
}) {
  if (status !== "active" || hasShopifyCustomerRedactionTombstone(metadata)) {
    throw new Error(`Loyalty account ${id} is not active.`);
  }
}

async function withActiveReferralAccountLock<T>({
  accountId,
  fn,
}: {
  accountId: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const identity = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      status: true,
      metadata: true,
      shopper: { select: { shopifyCustomerId: true } },
      store: { select: { id: true, projectId: true } },
    },
  });
  if (!identity) {
    throw new Error(`Loyalty account ${accountId} not found.`);
  }
  assertReferralAccountCanProvision(identity);

  return withShopifyCustomerSettlementLocks({
    storeId: identity.store.id,
    workspaceId: identity.store.projectId,
    shopifyCustomerId: identity.shopper.shopifyCustomerId,
    fn,
  });
}

async function ensureAccountReferralCodeUnlocked(
  accountId: string,
  shopperFirstName?: string | null,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<string> {
  let code = generateReferralCode(shopperFirstName || undefined);

  for (let attempt = 0; attempt < 5; attempt++) {
    const account = await prisma.weleticLoyaltyAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        storeId: true,
        status: true,
        metadata: true,
        referralCode: true,
      },
    });
    if (!account) {
      throw new Error(`Loyalty account ${accountId} not found.`);
    }
    assertReferralAccountCanProvision(account);
    if (account.referralCode) return account.referralCode;

    try {
      const updated = await withActiveStoreLoyaltyMutation({
        storeId: account.storeId,
        action: "loyalty_referral_code_provision",
        loyaltyMaintenancePermit,
        operation: (tx) =>
          tx.weleticLoyaltyAccount.updateMany({
            where: {
              id: account.id,
              storeId: account.storeId,
              status: "active",
              referralCode: null,
            },
            data: { referralCode: code },
          }),
      });
      if (updated.count === 1) return code;
    } catch (error) {
      if (
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
      ) {
        throw error;
      }
    }
    code = generateReferralCode(shopperFirstName || undefined);
  }

  const fallbackCode = `REF-${nanoid(8).toUpperCase()}`;
  const fallbackAccount = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    select: { storeId: true },
  });
  if (!fallbackAccount) {
    throw new Error(`Loyalty account ${accountId} not found.`);
  }
  const updated = await withActiveStoreLoyaltyMutation({
    storeId: fallbackAccount.storeId,
    action: "loyalty_referral_code_provision",
    loyaltyMaintenancePermit,
    operation: (tx) =>
      tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: accountId,
          storeId: fallbackAccount.storeId,
          status: "active",
          referralCode: null,
        },
        data: { referralCode: fallbackCode },
      }),
  });
  if (updated.count === 1) return fallbackCode;

  const current = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    select: { id: true, status: true, metadata: true, referralCode: true },
  });
  if (!current) throw new Error(`Loyalty account ${accountId} not found.`);
  assertReferralAccountCanProvision(current);
  if (current.referralCode) return current.referralCode;
  throw new Error(`Could not create a referral code for account ${accountId}.`);
}

/**
 * Ensures an active loyalty account has a unique referral code.
 */
export async function ensureAccountReferralCode(
  accountId: string,
  shopperFirstName?: string | null,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<string> {
  return withActiveReferralAccountLock({
    accountId,
    fn: () =>
      ensureAccountReferralCodeUnlocked(
        accountId,
        shopperFirstName,
        loyaltyMaintenancePermit,
      ),
  });
}

/**
 * Returns one deterministic referral rule. Active rules always win; when a
 * program is intentionally disabled, the newest inactive rule remains the
 * canonical configuration instead of silently creating a new active rule.
 * Newest-first preserves the merchant-visible behavior of the legacy admin
 * route while making duplicate imported rows deterministic.
 */
export async function getCanonicalReferralRule(programId: string) {
  return prisma.weleticLoyaltyReferralRule.findFirst({
    where: { programId },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

/**
 * Gets or creates the canonical referral rule for a loyalty program.
 *
 * The fast path preserves an explicitly inactive configuration. The creation
 * path serializes on the parent program row so two first-time callers cannot
 * create multiple active defaults.
 */
export async function getOrCreateReferralRule(programId: string) {
  const existing = await getCanonicalReferralRule(programId);
  if (existing) return existing;

  return runSerializableReferralTransaction(async (tx) => {
    const lockedProgram = await tx.weleticLoyaltyProgram.updateMany({
      where: { id: programId },
      data: { updatedAt: new Date() },
    });
    if (lockedProgram.count !== 1) {
      throw new Error(`Loyalty program ${programId} not found.`);
    }

    const concurrent = await tx.weleticLoyaltyReferralRule.findFirst({
      where: { programId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    if (concurrent) return concurrent;

    return createDefaultReferralRule(tx, programId);
  });
}

/**
 * Creates or retrieves a branded Dub shortlink for a loyalty shopper advocate
 * WITHOUT creating any Partner or ProgramEnrollment records (Zero-Partner
 * Invariant). Stores without a verified project short-link domain fall back to
 * the canonical Shopify storefront URL so a referral can never point at Dub's
 * public domain without a corresponding hosted redirect.
 */
export async function ensureAccountReferralLink(params: {
  storeId: string;
  accountId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<{
  referralCode: string;
  referralLink: string;
  dubLinkId: string | null;
}> {
  return withActiveReferralAccountLock({
    accountId: params.accountId,
    fn: () => ensureAccountReferralLinkUnlocked(params),
  });
}

async function ensureAccountReferralLinkUnlocked(params: {
  storeId: string;
  accountId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<{
  referralCode: string;
  referralLink: string;
  dubLinkId: string | null;
}> {
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: params.accountId },
    include: {
      shopper: true,
      store: {
        include: {
          project: {
            include: {
              domains: {
                where: { primary: true, verified: true, archived: false },
                take: 1,
              },
            },
          },
        },
      },
      program: true,
    },
  });

  if (!account) {
    throw new Error(`Loyalty account ${params.accountId} not found.`);
  }
  if (account.storeId !== params.storeId) {
    throw new Error(
      `Loyalty account ${params.accountId} does not belong to Shopify store ${params.storeId}`,
    );
  }
  assertReferralAccountCanProvision(account);

  const referralCode =
    account.referralCode ||
    (await ensureAccountReferralCodeUnlocked(
      account.id,
      account.shopper?.firstName,
      params.loyaltyMaintenancePermit,
    ));

  const destinationUrl = `https://${account.store.shopDomain}?ref=${encodeURIComponent(referralCode)}`;
  const primaryDomain = account.store.project?.domains?.[0]?.slug;

  if (!primaryDomain) {
    return {
      referralCode,
      referralLink: destinationUrl,
      dubLinkId: null,
    };
  }

  const key = getReferralLinkKey(referralCode);
  const shortLink = `https://${primaryDomain}/${key}`;
  const now = new Date();
  const externalId = `loyalty_referral:${account.id}`;
  const existingLink = await prisma.link.findFirst({
    where: {
      projectId: account.store.projectId,
      externalId,
    },
  });

  if (existingLink) {
    return isReusableReferralLink(existingLink, {
      domain: primaryDomain,
      key,
      url: destinationUrl,
      shortLink,
      now,
    })
      ? {
          referralCode,
          referralLink: existingLink.shortLink,
          dubLinkId: existingLink.id,
        }
      : {
          referralCode,
          referralLink: destinationUrl,
          dubLinkId: null,
        };
  }

  const link = await withActiveStoreLoyaltyMutation({
    storeId: account.storeId,
    action: "loyalty_referral_link_provision",
    loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    operation: async (tx) => {
      const concurrent = await tx.link.findFirst({
        where: { projectId: account.store.projectId, externalId },
      });
      if (concurrent) return concurrent;

      const tagIds = await Promise.all(
        ["loyalty", "shopper-referral"].map(async (name) => {
          const tag = await tx.tag.upsert({
            where: {
              name_projectId: {
                name,
                projectId: account.store.projectId,
              },
            },
            update: {},
            create: {
              id: createId({ prefix: "tag_" }),
              name,
              projectId: account.store.projectId,
            },
            select: { id: true },
          });
          return tag.id;
        }),
      );

      return tx.link.create({
        data: {
          id: createId({ prefix: "link_" }),
          domain: primaryDomain,
          key,
          url: destinationUrl,
          shortLink,
          projectId: account.store.projectId,
          programId: account.store.programId,
          partnerId: null,
          partnerGroupDefaultLinkId: null,
          externalId,
          trackConversion: true,
          tags: {
            createMany: {
              data: tagIds.map((tagId, index) => ({
                tagId,
                createdAt: new Date(Date.now() + index * 100),
              })),
            },
          },
          title: `Loyalty Referral: ${account.shopper?.firstName || "Member"}`,
          description: `Shop with my referral code ${referralCode} to get points and rewards!`,
        },
      });
    },
  });

  return isReusableReferralLink(link, {
    domain: primaryDomain,
    key,
    url: destinationUrl,
    shortLink,
    now,
  })
    ? {
        referralCode,
        referralLink: link.shortLink,
        dubLinkId: link.id,
      }
    : {
        referralCode,
        referralLink: destinationUrl,
        dubLinkId: null,
      };
}

export interface BindReferralInput {
  storeId: string;
  refereeAccountId: string;
  referralCode: string;
  clientIp?: string;
  userAgent?: string;
  dubLinkId?: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}

/**
 * Binds a new customer loyalty account to an advocate using their referral code.
 * Enforces 6-layer anti-abuse validation (self-referrals, matching shopper/email, IP matching, and duplicate referral protections).
 */
export async function bindShopperReferral(input: BindReferralInput) {
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId: input.storeId,
    action: "referral_binding",
    loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
  });
  const normalizedCode = input.referralCode.trim().toUpperCase();

  const advocateAccount = await prisma.weleticLoyaltyAccount.findFirst({
    where: {
      storeId: input.storeId,
      referralCode: normalizedCode,
      status: "active",
    },
    include: {
      shopper: true,
    },
  });

  if (!advocateAccount) {
    throw new Error(`Invalid or expired referral code: '${normalizedCode}'`);
  }
  assertReferralAccountCanProvision(advocateAccount);

  // Check 1: Account ID match
  if (advocateAccount.id === input.refereeAccountId) {
    throw new Error("Self-referral is strictly prohibited.");
  }

  const refereeAccount = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: input.refereeAccountId },
    include: { shopper: true },
  });

  if (!refereeAccount) {
    throw new Error(`Referee account ${input.refereeAccountId} not found.`);
  }
  if (refereeAccount.storeId !== input.storeId) {
    throw new Error("Referee account belongs to another Shopify store.");
  }
  assertReferralAccountCanProvision(refereeAccount);

  const existingReferral = await prisma.weleticLoyaltyReferral.findUnique({
    where: {
      advocateAccountId_refereeAccountId: {
        advocateAccountId: advocateAccount.id,
        refereeAccountId: refereeAccount.id,
      },
    },
  });

  // Resolve the idempotency key before re-running mutable anti-abuse checks.
  // A profile can change after a valid bind (for example, an email update),
  // but replaying the same successful operation must still return its row.
  if (existingReferral) {
    return existingReferral;
  }

  // Check 2: Shopper ID match
  if (
    advocateAccount.shopperId &&
    refereeAccount.shopperId &&
    advocateAccount.shopperId === refereeAccount.shopperId
  ) {
    throw new Error("Self-referral is strictly prohibited.");
  }

  // Check 3: Email equality match
  const advocateEmail = (advocateAccount.shopper?.email || "")
    .trim()
    .toLowerCase();
  const refereeEmail = (refereeAccount.shopper?.email || "")
    .trim()
    .toLowerCase();
  if (advocateEmail && refereeEmail && advocateEmail === refereeEmail) {
    throw new Error(
      "Advocate and referee cannot share the same email address.",
    );
  }

  const advocateEmailSimilarityKey =
    getReferralEmailSimilarityKey(advocateEmail);
  const refereeEmailSimilarityKey = getReferralEmailSimilarityKey(refereeEmail);
  const advocateName = normalizeReferralPersonName(
    advocateAccount.shopper?.firstName,
    advocateAccount.shopper?.lastName,
  );
  const refereeName = normalizeReferralPersonName(
    refereeAccount.shopper?.firstName,
    refereeAccount.shopper?.lastName,
  );
  const preTransactionFraudSignals = {
    similarEmail: Boolean(
      advocateEmailSimilarityKey &&
        refereeEmailSimilarityKey &&
        advocateEmailSimilarityKey === refereeEmailSimilarityKey,
    ),
    sameName: Boolean(
      advocateName && refereeName && advocateName === refereeName,
    ),
    disposableEmail: isKnownDisposableReferralEmail(refereeEmail),
    existingCustomer: Number(refereeAccount.shopper?.ordersCount || 0) > 0,
  };

  // Check 4: A repeated successful bind to the same advocate is idempotent.
  // Only a different advocate is a conflict. A same-advocate pointer without
  // its referral row is allowed through so the transaction can repair an
  // interrupted legacy/import state.
  if (
    refereeAccount.referredById &&
    refereeAccount.referredById !== advocateAccount.id
  ) {
    throw new Error("Account has already been referred by another member.");
  }

  // Check 5/6 are repeated under the store/program lock below. A merchant can
  // disable referrals while this optimistic read phase is running; no pending
  // referral may be created from that stale configuration.
  const ipHash = hashAbuseSignal({
    storeId: input.storeId,
    kind: "ip",
    signal: input.clientIp,
  });
  const ipHashLookup = getAbuseSignalLookupDigests({
    storeId: input.storeId,
    kind: "ip",
    signal: input.clientIp,
  });
  const userAgentHash = hashAbuseSignal({
    storeId: input.storeId,
    kind: "user_agent",
    signal: input.userAgent,
  });

  const referral = await runSerializableReferralTransaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId: input.storeId,
      action: "referral_binding",
      loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
      tx,
    });
    // This read is intentionally repeated inside the serializable transaction.
    // A concurrent first bind can commit after the optimistic fast-path read;
    // returning its row makes both callers observe the same successful bind.
    const concurrentReferral = await tx.weleticLoyaltyReferral.findUnique({
      where: {
        advocateAccountId_refereeAccountId: {
          advocateAccountId: advocateAccount.id,
          refereeAccountId: refereeAccount.id,
        },
      },
    });
    if (concurrentReferral) return concurrentReferral;

    // Lock order is store -> program -> accounts. The admin referral-rule
    // route uses the same store/program order, so a concurrent disable either
    // commits first and is observed below or waits until this bind commits.
    const activeProgramClaim = await tx.weleticLoyaltyProgram.updateMany({
      where: {
        id: advocateAccount.programId,
        storeId: input.storeId,
        status: "active",
        killSwitchActive: false,
      },
      data: { updatedAt: new Date() },
    });
    if (activeProgramClaim.count !== 1) {
      throw new Error("Customer referral program is currently inactive.");
    }

    const activeAccountIds = [advocateAccount.id, refereeAccount.id].sort();
    const activeAccountsClaim = await tx.weleticLoyaltyAccount.updateMany({
      where: {
        id: { in: activeAccountIds },
        storeId: input.storeId,
        status: "active",
      },
      data: { updatedAt: new Date() },
    });
    if (activeAccountsClaim.count !== activeAccountIds.length) {
      throw new ReferralAccountInactiveError();
    }

    // Re-read the canonical rule only after the program row is locked. This
    // is the rule snapshot that governs the pending-row mutation below.
    let lockedRule = await tx.weleticLoyaltyReferralRule.findFirst({
      where: { programId: advocateAccount.programId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    lockedRule ??= await createDefaultReferralRule(
      tx,
      advocateAccount.programId,
    );
    if (!lockedRule.isActive) {
      throw new Error("Customer referral program is currently inactive.");
    }
    if (lockedRule.maxReferralsPerAdvocate) {
      if (advocateAccount.referralCount >= lockedRule.maxReferralsPerAdvocate) {
        throw new Error("Advocate has reached the maximum allowed referrals.");
      }
      // Re-evaluate the cap against the current locked row. The optimistic
      // advocate snapshot above may predate a qualification that consumed the
      // final slot before this transaction acquired the account locks.
      const capEligibility = await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: advocateAccount.id,
          storeId: input.storeId,
          status: "active",
          referralCount: { lt: lockedRule.maxReferralsPerAdvocate },
        },
        data: { updatedAt: new Date() },
      });
      if (capEligibility.count !== 1) {
        throw new Error("Advocate has reached the maximum allowed referrals.");
      }
    }

    // The advocate row claim above serializes concurrent first binds. Query
    // the exact tenant/advocate/IP tuple only after that claim so no history
    // window (or two simultaneous referees) can bypass the fraud signal.
    const matchingIpReferral =
      lockedRule.fraudCheckSameIp && ipHash
        ? await tx.weleticLoyaltyReferral.findFirst({
            where: {
              storeId: input.storeId,
              advocateAccountId: advocateAccount.id,
              ipHash: { in: ipHashLookup },
            },
            select: { id: true },
          })
        : null;
    const fraudSignals = {
      ...preTransactionFraudSignals,
      sameIp: matchingIpReferral !== null,
    };
    const fraudReasons = [
      fraudSignals.sameIp
        ? "Same IP address detected as an existing referral"
        : null,
      fraudSignals.similarEmail
        ? "Advocate and friend use materially similar email addresses"
        : null,
      fraudSignals.sameName
        ? "Advocate and friend use the same normalized name"
        : null,
      fraudSignals.disposableEmail
        ? "Friend uses a known disposable email domain"
        : null,
      fraudSignals.existingCustomer
        ? "Friend already has Shopify order history"
        : null,
    ].filter((reason): reason is string => Boolean(reason));
    const isFraud = fraudReasons.length > 0;
    const fraudReason = fraudReasons.join("; ") || null;

    if (!isFraud) {
      const claimed = await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: refereeAccount.id,
          storeId: input.storeId,
          status: "active",
          referredById: null,
        },
        data: { referredById: advocateAccount.id },
      });
      if (claimed.count !== 1) {
        const currentReferee = await tx.weleticLoyaltyAccount.findUnique({
          where: { id: refereeAccount.id },
          select: {
            storeId: true,
            status: true,
            metadata: true,
            referredById: true,
          },
        });
        if (!currentReferee || currentReferee.storeId !== input.storeId) {
          throw new ReferralAccountInactiveError();
        }
        assertReferralAccountCanProvision({
          id: refereeAccount.id,
          status: currentReferee.status,
          metadata: currentReferee.metadata,
        });
        if (currentReferee.referredById !== advocateAccount.id) {
          throw new Error(
            "Account has already been referred by another member.",
          );
        }

        const committedReferral = await tx.weleticLoyaltyReferral.findUnique({
          where: {
            advocateAccountId_refereeAccountId: {
              advocateAccountId: advocateAccount.id,
              refereeAccountId: refereeAccount.id,
            },
          },
        });
        if (committedReferral) return committedReferral;
      }
    }

    return await tx.weleticLoyaltyReferral.create({
      data: {
        id: createWeleticId("wreferral_"),
        storeId: input.storeId,
        advocateAccountId: advocateAccount.id,
        refereeShopperId: refereeAccount.shopperId,
        refereeAccountId: refereeAccount.id,
        dubLinkId: input.dubLinkId || null,
        status: isFraud
          ? WeleticLoyaltyReferralStatus.fraud_blocked
          : WeleticLoyaltyReferralStatus.pending,
        ipHash,
        userAgentHash,
        fraudReason,
        fraudSignals: isFraud
          ? ({
              ...fraudSignals,
              clientIpHash: ipHash,
            } as Prisma.InputJsonValue)
          : Prisma.DbNull,
        metadata: {
          referralCode: normalizedCode,
          hasClientIpSignal: Boolean(ipHash),
          hasUserAgentSignal: Boolean(userAgentHash),
        } as Prisma.InputJsonValue,
      },
    });
  });

  return referral;
}

export interface EvaluateReferralQualificationInput {
  storeId: string;
  orderId: string;
  refereeShopperId: string;
  /** Order subtotal in the Shopify store currency's minor units. */
  orderSubtotal: bigint;
  /** Shopify store currency; referral thresholds are configured in this currency. */
  currency: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}

export function referralMinimumSubtotalMinorUnits({
  minimumSubtotal,
  currency,
}: {
  minimumSubtotal: { toString(): string };
  currency: string;
}): bigint {
  return decimalToMinorUnits(minimumSubtotal.toString(), currency);
}

/**
 * Evaluates whether a referee's completed order qualifies both advocate and referee for referral rewards.
 */
export async function evaluateReferralQualification(
  input: EvaluateReferralQualificationInput,
) {
  const refereeAccount = await prisma.weleticLoyaltyAccount.findUnique({
    where: { shopperId: input.refereeShopperId },
    include: { shopper: { select: { ordersCount: true } } },
  });

  if (!refereeAccount) {
    return {
      qualified: false,
      reason: "No loyalty account found for shopper",
      advocatePointsAwarded: BigInt(0),
      refereePointsAwarded: BigInt(0),
    };
  }
  if (refereeAccount.storeId !== input.storeId) {
    throw new Error(
      "Referee loyalty account belongs to another Shopify store.",
    );
  }
  if (
    refereeAccount.status !== "active" ||
    hasShopifyCustomerRedactionTombstone(refereeAccount.metadata)
  ) {
    return {
      qualified: false as const,
      reason: "Referral account is no longer active.",
      advocatePointsAwarded: BigInt(0),
      refereePointsAwarded: BigInt(0),
    };
  }

  // The pending-row read, invalidation check, award idempotency checks, claim,
  // ledger writes, and counters must share one serializable transaction. This
  // prevents a refunded order from winning an ABA pending -> rewarded ->
  // pending -> rewarded cycle under MySQL's default REPEATABLE READ behavior.
  try {
    return await runSerializableReferralTransaction(async (tx) => {
      const operationalStore = await assertShopifyStoreAcceptsOperationalWrites(
        {
          storeId: input.storeId,
          action: "referral_qualification",
          requireVerifiedCurrency: true,
          expectedInstallationGeneration: input.expectedInstallationGeneration,
          loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
          tx,
        },
      );
      if (!operationalStore) {
        throw new Error("Referral Shopify store is unavailable.");
      }
      if (
        operationalStore.shopCurrency.trim().toUpperCase() !==
        input.currency.trim().toUpperCase()
      ) {
        throw new Error(
          "Referral order currency does not match the verified Shopify store currency.",
        );
      }
      const referral = await tx.weleticLoyaltyReferral.findFirst({
        where: {
          storeId: input.storeId,
          refereeAccountId: refereeAccount.id,
          status: WeleticLoyaltyReferralStatus.pending,
        },
        include: {
          advocateAccount: true,
        },
      });

      if (!referral) {
        return {
          qualified: false as const,
          reason: "No pending referral found",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        };
      }
      if (referral.advocateAccount.storeId !== input.storeId) {
        throw new Error("Referral advocate belongs to another Shopify store.");
      }
      if (
        referral.advocateAccount.status !== "active" ||
        hasShopifyCustomerRedactionTombstone(referral.advocateAccount.metadata)
      ) {
        throw new ReferralAccountInactiveError();
      }

      const referralMetadata =
        referral.metadata &&
        typeof referral.metadata === "object" &&
        !Array.isArray(referral.metadata)
          ? (referral.metadata as Record<string, unknown>)
          : {};
      const invalidatedQualificationOrderIds = Array.isArray(
        referralMetadata.invalidatedQualificationOrderIds,
      )
        ? referralMetadata.invalidatedQualificationOrderIds.filter(
            (orderId: unknown): orderId is string =>
              typeof orderId === "string",
          )
        : [];

      if (invalidatedQualificationOrderIds.includes(input.orderId)) {
        return {
          qualified: false as const,
          reason: "Refunded order cannot qualify the referral again",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        };
      }

      // Shopify increments orders_count before this paid-order lifecycle is
      // finalized. A value of 1 is the friend's first real order; anything
      // higher is ineligible for a Smile-compatible new-customer referral.
      if (Number(refereeAccount.shopper?.ordersCount || 0) > 1) {
        const blocked = await tx.weleticLoyaltyReferral.updateMany({
          where: {
            id: referral.id,
            storeId: input.storeId,
            status: WeleticLoyaltyReferralStatus.pending,
          },
          data: {
            status: WeleticLoyaltyReferralStatus.fraud_blocked,
            fraudReason: "Qualifying purchase is not the friend's first order",
            fraudSignals: {
              ...((referral.fraudSignals &&
              typeof referral.fraudSignals === "object" &&
              !Array.isArray(referral.fraudSignals)
                ? referral.fraudSignals
                : {}) as Record<string, unknown>),
              nonFirstOrder: true,
              observedOrdersCount: refereeAccount.shopper?.ordersCount || 0,
            } as Prisma.InputJsonValue,
            metadata: {
              ...referralMetadata,
              fraudBlockedAtQualificationOrderId: input.orderId,
            } as Prisma.InputJsonValue,
          },
        });
        if (blocked.count !== 1) {
          throw new ReferralTransactionConflictError(
            `Referral ${referral.id} changed during first-order validation.`,
          );
        }
        return {
          qualified: false as const,
          reason: "Referral requires the friend's first real order",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        };
      }

      let rule = await tx.weleticLoyaltyReferralRule.findFirst({
        where: { programId: referral.advocateAccount.programId },
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      });
      if (!rule) {
        // Legacy Soho/Gemini imports can contain a pending referral without a
        // rule. Restore the previous default-creation behavior, but serialize
        // it on the tenant-bound parent program so concurrent paid orders or
        // an admin save cannot create competing defaults.
        const lockedProgram = await tx.weleticLoyaltyProgram.updateMany({
          where: {
            id: referral.advocateAccount.programId,
            storeId: input.storeId,
          },
          data: { updatedAt: new Date() },
        });
        if (lockedProgram.count !== 1) {
          throw new Error(
            `Referral loyalty program ${referral.advocateAccount.programId} is unavailable for this store.`,
          );
        }
        rule = await tx.weleticLoyaltyReferralRule.findFirst({
          where: { programId: referral.advocateAccount.programId },
          orderBy: [
            { isActive: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
        });
        rule ??= await createDefaultReferralRule(
          tx,
          referral.advocateAccount.programId,
        );
      }
      if (!rule.isActive) {
        return {
          qualified: false as const,
          reason: "Customer referral program is currently inactive",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        };
      }

      if (rule.minQualifyingOrderSubtotal) {
        const minimumSubtotal = referralMinimumSubtotalMinorUnits({
          minimumSubtotal: rule.minQualifyingOrderSubtotal,
          currency: input.currency,
        });

        if (input.orderSubtotal < minimumSubtotal) {
          return {
            qualified: false as const,
            reason: `Order subtotal ${input.orderSubtotal} ${input.currency} minor units is below minimum qualifying amount ${minimumSubtotal}`,
            advocatePointsAwarded: BigInt(0),
            refereePointsAwarded: BigInt(0),
          };
        }
      }

      const advocateAwarded =
        rule.advocateRewardKind !== "coupon" &&
        rule.advocatePointsReward > BigInt(0)
          ? rule.advocatePointsReward
          : BigInt(0);
      const refereeAwarded =
        rule.refereeRewardKind !== "coupon" &&
        rule.refereePointsReward > BigInt(0)
          ? rule.refereePointsReward
          : BigInt(0);
      const qualifiedAt = new Date();
      const couponJobSpecs = [
        ...(rule.advocateRewardKind === "coupon" &&
        rule.advocateRewardDefinitionId
          ? [
              {
                side: "advocate" as const,
                accountId: referral.advocateAccountId,
                rewardDefinitionId: rule.advocateRewardDefinitionId,
              },
            ]
          : []),
        ...(rule.refereeRewardKind === "coupon" &&
        rule.refereeRewardDefinitionId
          ? [
              {
                side: "referee" as const,
                accountId: refereeAccount.id,
                rewardDefinitionId: rule.refereeRewardDefinitionId,
              },
            ]
          : []),
      ];
      const couponJobs = await Promise.all(
        couponJobSpecs.map(async (job) => {
          const reward = await tx.weleticRewardDefinition.findFirst({
            where: {
              id: job.rewardDefinitionId,
              storeId: input.storeId,
              status: WeleticRewardStatus.active,
              exchangeType: WeleticRewardExchangeType.fixed,
            },
          });
          if (!reward) {
            throw new Error(
              `Referral coupon reward ${job.rewardDefinitionId} is no longer available.`,
            );
          }
          if (!isReferralCouponProvisionable(reward)) {
            throw new Error(
              `Referral coupon reward ${job.rewardDefinitionId} cannot be provisioned in Shopify.`,
            );
          }
          const recipientAccount = await tx.weleticLoyaltyAccount.findFirst({
            where: {
              id: job.accountId,
              storeId: input.storeId,
              status: "active",
            },
            select: {
              shopper: { select: { shopifyCustomerId: true } },
            },
          });
          if (!recipientAccount) {
            throw new Error(
              `Referral coupon recipient ${job.accountId} is no longer available.`,
            );
          }
          return {
            ...job,
            rewardSnapshot: createReferralCouponRewardSnapshot({
              identity: {
                storeId: input.storeId,
                referralId: referral.id,
                qualificationOrderId: input.orderId,
                accountId: job.accountId,
                rewardDefinitionId: job.rewardDefinitionId,
                side: job.side,
              },
              reward,
              qualifiedAt,
              shopCurrency: input.currency,
              currencyVerifiedAt: operationalStore.currencyVerifiedAt!,
              shopifyCustomerId: recipientAccount.shopper.shopifyCustomerId,
            }),
          };
        }),
      );
      const advocateLedgerKey = `referral_advocate:${referral.id}:${input.orderId}`;
      const refereeLedgerKey = `referral_referee:${referral.id}:${input.orderId}`;
      const couponOutboxKeys = couponJobs.map(
        (job) =>
          `job:${getReferralCouponIdempotencyKey({
            referralId: referral.id,
            qualificationOrderId: input.orderId,
            side: job.side,
          })}`,
      );
      const existingAwards = await Promise.all([
        advocateAwarded > BigInt(0)
          ? tx.weleticPointsLedgerEntry.findUnique({
              where: {
                storeId_idempotencyKey: {
                  storeId: input.storeId,
                  idempotencyKey: advocateLedgerKey,
                },
              },
            })
          : null,
        refereeAwarded > BigInt(0)
          ? tx.weleticPointsLedgerEntry.findUnique({
              where: {
                storeId_idempotencyKey: {
                  storeId: input.storeId,
                  idempotencyKey: refereeLedgerKey,
                },
              },
            })
          : null,
        ...couponOutboxKeys.map((idempotencyKey) =>
          tx.weleticLoyaltyOutboxJob.findUnique({
            where: {
              storeId_idempotencyKey: {
                storeId: input.storeId,
                idempotencyKey,
              },
            },
          }),
        ),
      ]);
      if (existingAwards.some(Boolean)) {
        return {
          qualified: false as const,
          reason: "Referral award already exists for this order",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        };
      }

      // Redaction closes an account with an optimistic updatedAt predicate.
      // Touch both accounts in one tenant-bound statement before any referral
      // award is claimed. Either this transaction wins and redaction retries
      // after scrubbing the committed effects, or redaction wins and this
      // active-only claim rolls the entire award back. A single IN predicate
      // also lets the database acquire both rows in index order, avoiding a
      // two-account application-lock deadlock.
      const accountIds = [
        ...new Set([referral.advocateAccountId, refereeAccount.id]),
      ];
      const activeAccountsClaim = await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: { in: accountIds },
          storeId: input.storeId,
          status: "active",
        },
        data: { updatedAt: new Date() },
      });
      if (activeAccountsClaim.count !== accountIds.length) {
        throw new ReferralAccountInactiveError();
      }

      const claimed = await tx.weleticLoyaltyReferral.updateMany({
        where: {
          id: referral.id,
          storeId: input.storeId,
          status: WeleticLoyaltyReferralStatus.pending,
        },
        data: {
          status:
            couponJobs.length > 0
              ? WeleticLoyaltyReferralStatus.qualified
              : WeleticLoyaltyReferralStatus.rewarded,
          qualifyingOrderId: input.orderId,
          advocatePointsAwarded: advocateAwarded,
          refereePointsAwarded: refereeAwarded,
          rewardedAt: couponJobs.length > 0 ? null : qualifiedAt,
          metadata: {
            ...referralMetadata,
            requiredCouponSides: couponJobs.map((job) => job.side),
            referralCouponRewardSnapshots: Object.fromEntries(
              couponJobs.map((job) => [job.side, job.rewardSnapshot]),
            ),
            qualificationOrderId: input.orderId,
            rewardKinds: {
              advocate: rule.advocateRewardKind,
              referee: rule.refereeRewardKind,
            },
          } as Prisma.InputJsonValue,
        },
      });
      if (claimed.count !== 1) {
        return {
          qualified: false as const,
          reason: "Referral was already qualified by another order",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        };
      }

      // Reserve the advocate's final counter slot with one atomic predicate.
      // Distinct referrals can qualify concurrently, so an earlier in-memory
      // comparison cannot safely enforce the configured cap.
      const advocateCounterClaim = await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: referral.advocateAccountId,
          storeId: input.storeId,
          status: "active",
          ...(typeof rule.maxReferralsPerAdvocate === "number"
            ? { referralCount: { lt: rule.maxReferralsPerAdvocate } }
            : {}),
        },
        data: {
          referralCount: { increment: 1 },
          referralPointsEarned: { increment: advocateAwarded },
        },
      });
      if (advocateCounterClaim.count !== 1) {
        // Throw so the preceding referral status claim rolls back with the
        // counter reservation. Returning would commit a qualified-but-unpaid
        // referral after the cap had already been reached.
        throw new ReferralLimitReachedError();
      }

      if (advocateAwarded > BigInt(0)) {
        const advocateLedgerEntry = await appendPointsLedgerEntry({
          storeId: input.storeId,
          accountId: referral.advocateAccountId,
          entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
          pointsDelta: advocateAwarded,
          referenceType: "referral",
          referenceId: referral.id,
          idempotencyKey: advocateLedgerKey,
          reason: `Referral reward for inviting friend (${input.orderId})`,
          metadata: {
            referralId: referral.id,
            qualificationOrderId: input.orderId,
            refereeAccountId: refereeAccount.id,
            orderId: input.orderId,
          },
          tx,
        });
        await enqueueFlowTriggerJob({
          storeId: input.storeId,
          eventId: advocateLedgerEntry.id,
          payload: {
            accountId: referral.advocateAccountId,
            handle: "weletic-points-earned",
            pointsDelta: advocateAwarded.toString(),
            pointsBalance: advocateLedgerEntry.balanceAfter.toString(),
            reason: "referral_advocate_reward",
            orderId: input.orderId,
          },
          loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
          tx,
        });
      }

      if (refereeAwarded > BigInt(0)) {
        const refereeLedgerEntry = await appendPointsLedgerEntry({
          storeId: input.storeId,
          accountId: refereeAccount.id,
          entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
          pointsDelta: refereeAwarded,
          referenceType: "referral",
          referenceId: referral.id,
          idempotencyKey: refereeLedgerKey,
          reason: `Welcome bonus for joining via referral (${input.orderId})`,
          metadata: {
            referralId: referral.id,
            advocateAccountId: referral.advocateAccountId,
            orderId: input.orderId,
          },
          tx,
        });
        await enqueueFlowTriggerJob({
          storeId: input.storeId,
          eventId: refereeLedgerEntry.id,
          payload: {
            accountId: refereeAccount.id,
            handle: "weletic-points-earned",
            pointsDelta: refereeAwarded.toString(),
            pointsBalance: refereeLedgerEntry.balanceAfter.toString(),
            reason: "referral_friend_reward",
            orderId: input.orderId,
          },
          loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
          tx,
        });
      }

      if (advocateAwarded > BigInt(0)) {
        await scheduleTierReviewAfterQualifyingActivity({
          storeId: input.storeId,
          accountId: referral.advocateAccountId,
          activityKey: advocateLedgerKey,
          reason: "referral_advocate_points_earned",
          loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
          tx,
        });
      }
      if (refereeAwarded > BigInt(0)) {
        await scheduleTierReviewAfterQualifyingActivity({
          storeId: input.storeId,
          accountId: refereeAccount.id,
          activityKey: refereeLedgerKey,
          reason: "referral_referee_points_earned",
          loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
          tx,
        });
      }

      for (const [index, couponJob] of couponJobs.entries()) {
        await enqueueOutboxJob({
          storeId: input.storeId,
          jobType: "REFERRAL_REWARD_PROVISION",
          payload: {
            referralId: referral.id,
            accountId: couponJob.accountId,
            rewardDefinitionId: couponJob.rewardDefinitionId,
            side: couponJob.side,
            qualificationOrderId: input.orderId,
            rewardSnapshot: couponJob.rewardSnapshot,
          },
          idempotencyKey: couponOutboxKeys[index],
          loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
          tx,
        });
      }

      await enqueueOutboxJob({
        storeId: input.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: referral.advocateAccountId,
          triggerReason: "referral_reward_advocate",
        },
        idempotencyKey: `metafield_sync:referral_adv:${referral.id}:${input.orderId}`,
        loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
        tx,
      });
      await enqueueOutboxJob({
        storeId: input.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: referral.refereeAccountId,
          triggerReason: "referral_reward_referee",
        },
        idempotencyKey: `metafield_sync:referral_ref:${referral.id}:${input.orderId}`,
        loyaltyMaintenancePermit: input.loyaltyMaintenancePermit,
        tx,
      });

      return {
        qualified: true as const,
        referralId: referral.id,
        advocatePointsAwarded: advocateAwarded,
        refereePointsAwarded: refereeAwarded,
        couponProvisioning: couponJobs.length > 0,
      };
    });
  } catch (error) {
    if (
      error instanceof ReferralLimitReachedError ||
      error instanceof ReferralAccountInactiveError
    ) {
      return {
        qualified: false as const,
        reason: error.message,
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      };
    }
    throw error;
  }
}

/**
 * Reverses referral rewards if referee's qualifying order is cancelled or refunded.
 */
export async function reverseReferralPointsOnRefund(params: {
  storeId: string;
  orderId: string;
  refundId: string;
  privacyMinimized?: boolean;
  terminalCancellationReason?: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<{
  reversed: boolean;
  advocateReversed: bigint;
  refereeReversed: bigint;
}> {
  return runSerializableReferralTransaction(async (tx) => {
    if (params.privacyMinimized) {
      const settlementStore =
        await assertShopifyStoreMatchesInstallationGeneration({
          storeId: params.storeId,
          action: "referral_refund_financial_settlement",
          expectedInstallationGeneration: params.expectedInstallationGeneration,
          tx,
        });
      if (settlementStore?.complianceState === "active") {
        await assertShopifyStoreAcceptsOperationalWrites({
          storeId: params.storeId,
          action: "referral_refund_financial_settlement",
          expectedInstallationGeneration: params.expectedInstallationGeneration,
          loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
          tx,
        });
      }
    } else {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: params.storeId,
        action: "referral_refund_reversal",
        expectedInstallationGeneration: params.expectedInstallationGeneration,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx,
      });
    }
    const referral = await tx.weleticLoyaltyReferral.findFirst({
      where: {
        storeId: params.storeId,
        qualifyingOrderId: params.orderId,
        status: {
          in: [
            WeleticLoyaltyReferralStatus.rewarded,
            WeleticLoyaltyReferralStatus.qualified,
          ],
        },
      },
    });

    if (!referral) {
      return {
        reversed: false,
        advocateReversed: BigInt(0),
        refereeReversed: BigInt(0),
      };
    }

    const involvedAccounts =
      (await tx.weleticLoyaltyAccount.findMany({
        where: {
          id: {
            in: [referral.advocateAccountId, referral.refereeAccountId].filter(
              (accountId): accountId is string => Boolean(accountId),
            ),
          },
          storeId: params.storeId,
        },
        select: { id: true, metadata: true },
      })) ?? [];
    const privacyRedactedAccountIds = new Set(
      involvedAccounts
        .filter((account) =>
          hasShopifyCustomerRedactionTombstone(account.metadata),
        )
        .map((account) => account.id),
    );
    const hasPrivacyRedactedAccount =
      params.privacyMinimized === true || privacyRedactedAccountIds.size > 0;

    const advocateClawback = referral.advocatePointsAwarded;
    const refereeClawback = referral.refereePointsAwarded;
    const referralMetadata =
      referral.metadata &&
      typeof referral.metadata === "object" &&
      !Array.isArray(referral.metadata)
        ? (referral.metadata as Record<string, unknown>)
        : {};
    const qualificationOrderId =
      typeof referralMetadata.qualificationOrderId === "string"
        ? referralMetadata.qualificationOrderId
        : referral.qualifyingOrderId;
    const priorInvalidatedQualificationOrderIds = Array.isArray(
      referralMetadata.invalidatedQualificationOrderIds,
    )
      ? referralMetadata.invalidatedQualificationOrderIds.filter(
          (orderId: unknown): orderId is string => typeof orderId === "string",
        )
      : [];
    const invalidatedQualificationOrderIds = Array.from(
      new Set([...priorInvalidatedQualificationOrderIds, params.orderId]),
    );
    const reversedAt = new Date().toISOString();
    const terminalCancellationReason =
      params.terminalCancellationReason?.trim() || null;
    const generationRedemptions = qualificationOrderId
      ? await tx.weleticRewardRedemption.findMany({
          where: {
            storeId: params.storeId,
            idempotencyKey: {
              in: (["advocate", "referee"] as const).map((side) =>
                getReferralCouponIdempotencyKey({
                  referralId: referral.id,
                  qualificationOrderId,
                  side,
                }),
              ),
            },
            status: {
              in: [
                WeleticRedemptionStatus.provisioning,
                WeleticRedemptionStatus.issued,
                WeleticRedemptionStatus.active,
                WeleticRedemptionStatus.used,
              ],
            },
          },
        })
      : [];
    const hasConsumedCoupon = generationRedemptions.some(
      (redemption) => redemption.status === WeleticRedemptionStatus.used,
    );
    const claimed = await tx.weleticLoyaltyReferral.updateMany({
      where: {
        id: referral.id,
        storeId: params.storeId,
        qualifyingOrderId: params.orderId,
        status: {
          in: [
            WeleticLoyaltyReferralStatus.rewarded,
            WeleticLoyaltyReferralStatus.qualified,
          ],
        },
      },
      data: {
        status: WeleticLoyaltyReferralStatus.cancelled,
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
        metadata: {
          ...referralMetadata,
          reversedAt,
          ...(terminalCancellationReason
            ? {
                cancelledAt: reversedAt,
                cancellationReason: terminalCancellationReason,
                requalificationBlocked: true,
                requalificationBlockedReason: "merchant_cancelled",
              }
            : hasPrivacyRedactedAccount
              ? {
                  requalificationBlocked: true,
                  requalificationBlockedReason: "customer_privacy_redacted",
                }
              : {
                  refundId: params.refundId,
                  invalidatedQualificationOrderIds,
                  requalificationBlocked: true,
                  requalificationBlockedReason: hasConsumedCoupon
                    ? "referral_coupon_used"
                    : "qualifying_order_fully_refunded",
                }),
        } as Prisma.InputJsonValue,
      },
    });
    if (claimed.count !== 1) {
      throw new ReferralTransactionConflictError(
        `Referral ${referral.id} changed during refund reversal.`,
      );
    }

    // 1. Clawback advocate points
    if (advocateClawback > BigInt(0)) {
      await appendPointsLedgerEntry({
        storeId: params.storeId,
        accountId: referral.advocateAccountId,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: -advocateClawback,
        referenceType: "REFERRAL_REFUND_CLAWBACK",
        referenceId: referral.id,
        idempotencyKey: `referral_reversal_advocate:${referral.id}:${params.refundId}`,
        reason: terminalCancellationReason
          ? `Referral reward cancelled by merchant: ${terminalCancellationReason}`
          : hasPrivacyRedactedAccount
            ? "Referral reward adjusted after customer redaction."
            : `Referral reward clawback due to referee order refund (${params.orderId})`,
        tx,
      });
    }

    if (!hasConsumedCoupon) {
      // A used coupon is an irreversible benefit and must retain its lifetime
      // cap slot even if the qualifying order is later refunded. The guarded
      // decrement also prevents imported counter drift from going negative and
      // accidentally expanding the configured cap.
      await tx.weleticLoyaltyAccount.updateMany({
        where: {
          id: referral.advocateAccountId,
          storeId: params.storeId,
          referralCount: { gt: 0 },
        },
        data: { referralCount: { decrement: 1 } },
      });
    }
    if (advocateClawback > BigInt(0)) {
      await tx.weleticLoyaltyAccount.updateMany({
        where: { id: referral.advocateAccountId, storeId: params.storeId },
        data: { referralPointsEarned: { decrement: advocateClawback } },
      });
    }

    // 2. Clawback referee welcome bonus
    if (refereeClawback > BigInt(0) && referral.refereeAccountId) {
      await appendPointsLedgerEntry({
        storeId: params.storeId,
        accountId: referral.refereeAccountId,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: -refereeClawback,
        referenceType: "REFERRAL_REFUND_CLAWBACK",
        referenceId: referral.id,
        idempotencyKey: `referral_reversal_referee:${referral.id}:${params.refundId}`,
        reason: terminalCancellationReason
          ? `Referral welcome reward cancelled by merchant: ${terminalCancellationReason}`
          : hasPrivacyRedactedAccount
            ? "Referral welcome reward adjusted after customer redaction."
            : `Referral welcome bonus clawback due to order refund (${params.orderId})`,
        tx,
      });
    }

    for (const discoveredRedemption of generationRedemptions) {
      if (discoveredRedemption.status === WeleticRedemptionStatus.used) {
        continue;
      }
      if (
        !REFERRAL_COUPON_CANCELLABLE_STATUSES.has(discoveredRedemption.status)
      ) {
        continue;
      }

      // This row was read in the same SERIALIZABLE transaction. If a coupon
      // worker or settlement changes it after this read, InnoDB aborts one
      // transaction (or this CAS loses); the outer retry then re-reads fresh
      // metadata and cannot erase remoteProvisionAttemptedAt or a used state.
      const cancelled = await tx.weleticRewardRedemption.updateMany({
        where: {
          id: discoveredRedemption.id,
          storeId: params.storeId,
          status: discoveredRedemption.status,
        },
        data: {
          status: WeleticRedemptionStatus.cancelled,
          compensationReason: terminalCancellationReason
            ? `Referral cancelled by merchant: ${terminalCancellationReason}`
            : hasPrivacyRedactedAccount
              ? "Referral reward cancelled after customer redaction."
              : `Referral qualifying order refunded (${params.refundId})`,
          metadata: {
            ...((discoveredRedemption.metadata &&
            typeof discoveredRedemption.metadata === "object" &&
            !Array.isArray(discoveredRedemption.metadata)
              ? discoveredRedemption.metadata
              : {}) as Record<string, unknown>),
            ...(terminalCancellationReason
              ? {
                  cancelledAt: reversedAt,
                  cancellationReason: terminalCancellationReason,
                }
              : hasPrivacyRedactedAccount
                ? { privacySafeCancellation: true }
                : { cancelledAt: reversedAt, refundId: params.refundId }),
          } as Prisma.InputJsonValue,
        },
      });
      if (cancelled.count !== 1) {
        throw new ReferralTransactionConflictError(
          `Referral redemption ${discoveredRedemption.id} changed during refund cancellation.`,
        );
      }

      if (!params.privacyMinimized) {
        await enqueueOutboxJob({
          storeId: params.storeId,
          jobType: "REDEMPTION_RECOVERY",
          payload: {
            redemptionId: discoveredRedemption.id,
            accountId: discoveredRedemption.accountId,
            rewardDefinitionId: discoveredRedemption.rewardDefinitionId,
            pointsCost: "0",
            shopifyDiscountCode: discoveredRedemption.shopifyDiscountCode,
            attemptCount: 0,
            sagaPhase: "compensating",
          },
          idempotencyKey: `discount_deactivate:${discoveredRedemption.id}`,
          tx,
        });
      }
    }

    // 3. Enqueue follow-up customer metafield sync
    if (
      !params.privacyMinimized &&
      !privacyRedactedAccountIds.has(referral.advocateAccountId)
    ) {
      await enqueueOutboxJob({
        storeId: params.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: referral.advocateAccountId,
          triggerReason: "referral_refund_clawback",
        },
        idempotencyKey: `metafield_sync:referral_refund_adv:${referral.id}:${params.refundId}`,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx,
      });
      if (advocateClawback > BigInt(0)) {
        await scheduleTierReviewAfterQualifyingActivity({
          storeId: params.storeId,
          accountId: referral.advocateAccountId,
          activityKey: `referral_refund:${referral.id}:${params.refundId}:advocate`,
          reason: "referral_advocate_points_reversed",
          loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
          tx,
        });
      }
    }

    if (
      !params.privacyMinimized &&
      referral.refereeAccountId &&
      !privacyRedactedAccountIds.has(referral.refereeAccountId)
    ) {
      await enqueueOutboxJob({
        storeId: params.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: referral.refereeAccountId,
          triggerReason: "referral_refund_clawback",
        },
        idempotencyKey: `metafield_sync:referral_refund_ref:${referral.id}:${params.refundId}`,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx,
      });
      if (refereeClawback > BigInt(0)) {
        await scheduleTierReviewAfterQualifyingActivity({
          storeId: params.storeId,
          accountId: referral.refereeAccountId,
          activityKey: `referral_refund:${referral.id}:${params.refundId}:referee`,
          reason: "referral_referee_points_reversed",
          loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
          tx,
        });
      }
    }

    return {
      reversed: true,
      advocateReversed: advocateClawback,
      refereeReversed: refereeClawback,
    };
  });
}

export async function cancelReferralByMerchant({
  storeId,
  referralId,
  reason,
}: {
  storeId: string;
  referralId: string;
  reason: string;
}) {
  const cancellationReason = reason.trim();
  if (!cancellationReason) {
    throw new Error("A referral cancellation reason is required.");
  }

  const referral = await prisma.weleticLoyaltyReferral.findFirst({
    where: { id: referralId, storeId },
  });
  if (!referral) throw new Error(`Referral ${referralId} not found.`);
  if (referral.status === WeleticLoyaltyReferralStatus.cancelled) {
    const { deactivateCancelledReferralFriendReward } = await import(
      "@/lib/weletic/loyalty/referral-friend-claim"
    );
    await deactivateCancelledReferralFriendReward({ storeId, referralId });
    return prisma.weleticLoyaltyReferral.findFirstOrThrow({
      where: { id: referralId, storeId },
    });
  }

  if (
    referral.status === WeleticLoyaltyReferralStatus.qualified ||
    referral.status === WeleticLoyaltyReferralStatus.rewarded
  ) {
    if (!referral.qualifyingOrderId) {
      throw new Error(
        `Qualified referral ${referralId} is missing its qualifying order.`,
      );
    }
    await reverseReferralPointsOnRefund({
      storeId,
      orderId: referral.qualifyingOrderId,
      refundId: `merchant-cancel:${referral.id}`,
      terminalCancellationReason: cancellationReason,
    });
    const { deactivateCancelledReferralFriendReward } = await import(
      "@/lib/weletic/loyalty/referral-friend-claim"
    );
    await deactivateCancelledReferralFriendReward({ storeId, referralId });
    return prisma.weleticLoyaltyReferral.findFirstOrThrow({
      where: { id: referralId, storeId },
    });
  }

  const cancelled = await runSerializableReferralTransaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "referral_merchant_cancel",
      tx,
    });
    const metadata =
      referral.metadata &&
      typeof referral.metadata === "object" &&
      !Array.isArray(referral.metadata)
        ? (referral.metadata as Record<string, unknown>)
        : {};
    const cancelledAt = new Date();
    const updated = await tx.weleticLoyaltyReferral.updateMany({
      where: {
        id: referral.id,
        storeId,
        status: {
          in: [
            WeleticLoyaltyReferralStatus.pending,
            WeleticLoyaltyReferralStatus.fraud_blocked,
          ],
        },
      },
      data: {
        status: WeleticLoyaltyReferralStatus.cancelled,
        metadata: {
          ...metadata,
          cancelledAt: cancelledAt.toISOString(),
          cancellationReason,
          requalificationBlocked: true,
          requalificationBlockedReason: "merchant_cancelled",
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) {
      throw new ReferralTransactionConflictError(
        `Referral ${referral.id} changed during merchant cancellation.`,
      );
    }
    return tx.weleticLoyaltyReferral.findFirstOrThrow({
      where: { id: referral.id, storeId },
    });
  });
  const { deactivateCancelledReferralFriendReward } = await import(
    "@/lib/weletic/loyalty/referral-friend-claim"
  );
  await deactivateCancelledReferralFriendReward({ storeId, referralId });
  return cancelled;
}

export async function unblockReferralAfterReview({
  storeId,
  referralId,
  reviewNote,
}: {
  storeId: string;
  referralId: string;
  reviewNote?: string | null;
}) {
  return runSerializableReferralTransaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "referral_fraud_review_unblock",
      tx,
    });
    const referral = await tx.weleticLoyaltyReferral.findFirst({
      where: { id: referralId, storeId },
      include: {
        advocateAccount: true,
        refereeAccount: true,
      },
    });
    if (!referral) throw new Error(`Referral ${referralId} not found.`);
    if (referral.status === WeleticLoyaltyReferralStatus.pending) {
      return referral;
    }
    if (referral.status !== WeleticLoyaltyReferralStatus.fraud_blocked) {
      throw new Error("Only fraud-blocked referrals can be unblocked.");
    }
    if (!referral.refereeAccount || !referral.refereeAccountId) {
      throw new Error(
        "Anonymous friend claims must be approved through the friend-claim review flow.",
      );
    }
    assertReferralAccountCanProvision(referral.advocateAccount);
    assertReferralAccountCanProvision(referral.refereeAccount);
    if (
      referral.refereeAccount.referredById &&
      referral.refereeAccount.referredById !== referral.advocateAccountId
    ) {
      throw new Error("Friend is already attributed to another advocate.");
    }

    const rule = await tx.weleticLoyaltyReferralRule.findFirst({
      where: { programId: referral.advocateAccount.programId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    if (!rule?.isActive) {
      throw new Error("Customer referral program is currently inactive.");
    }
    if (
      typeof rule.maxReferralsPerAdvocate === "number" &&
      referral.advocateAccount.referralCount >= rule.maxReferralsPerAdvocate
    ) {
      throw new Error("Advocate has reached the maximum allowed referrals.");
    }

    const accountClaim = await tx.weleticLoyaltyAccount.updateMany({
      where: {
        id: referral.refereeAccountId,
        storeId,
        status: "active",
        OR: [
          { referredById: null },
          { referredById: referral.advocateAccountId },
        ],
      },
      data: { referredById: referral.advocateAccountId },
    });
    if (accountClaim.count !== 1) {
      throw new ReferralTransactionConflictError(
        `Friend account for referral ${referral.id} changed during fraud review.`,
      );
    }

    const metadata =
      referral.metadata &&
      typeof referral.metadata === "object" &&
      !Array.isArray(referral.metadata)
        ? (referral.metadata as Record<string, unknown>)
        : {};
    const fraudSignals =
      referral.fraudSignals &&
      typeof referral.fraudSignals === "object" &&
      !Array.isArray(referral.fraudSignals)
        ? (referral.fraudSignals as Record<string, unknown>)
        : {};
    const reviewedAt = new Date().toISOString();
    const updated = await tx.weleticLoyaltyReferral.updateMany({
      where: {
        id: referral.id,
        storeId,
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
      },
      data: {
        status: WeleticLoyaltyReferralStatus.pending,
        fraudReason: null,
        fraudSignals: {
          ...fraudSignals,
          merchantReview: "unblocked",
          merchantReviewedAt: reviewedAt,
        } as Prisma.InputJsonValue,
        metadata: {
          ...metadata,
          fraudReview: {
            outcome: "unblocked",
            reviewedAt,
            note: reviewNote?.trim() || null,
          },
        } as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) {
      throw new ReferralTransactionConflictError(
        `Referral ${referral.id} changed during fraud review.`,
      );
    }
    return tx.weleticLoyaltyReferral.findFirstOrThrow({
      where: { id: referral.id, storeId },
    });
  });
}

/**
 * Returns comprehensive referral stats and history for a loyalty account.
 */
export async function getAccountReferralStats(accountId: string) {
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    include: {
      _count: {
        select: {
          advocateReferrals: true,
        },
      },
      advocateReferrals: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          refereeAccount: {
            include: { shopper: true },
          },
        },
      },
    },
  });

  if (!account) {
    throw new Error(`Loyalty account ${accountId} not found.`);
  }

  const qualifiedReferralCount = await prisma.weleticLoyaltyReferral.count({
    where: {
      storeId: account.storeId,
      advocateAccountId: account.id,
      status: {
        in: [
          WeleticLoyaltyReferralStatus.qualified,
          WeleticLoyaltyReferralStatus.rewarded,
        ],
      },
    },
  });

  return {
    referralCode: account.referralCode,
    totalReferralCount: account._count.advocateReferrals,
    qualifiedReferralCount,
    referralPointsEarned: account.referralPointsEarned,
    referrals: (account.advocateReferrals || []).map((r) => ({
      id: r.id,
      status: r.status,
      refereeName: r.refereeAccount?.shopper?.firstName || "Friend",
      advocatePointsAwarded: r.advocatePointsAwarded,
      refereePointsAwarded: r.refereePointsAwarded,
      rewardedAt: r.rewardedAt,
      createdAt: r.createdAt,
    })),
  };
}
