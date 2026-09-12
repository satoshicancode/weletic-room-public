import { deriveAllShopifyCustomerPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import type { Prisma } from "@prisma/client";
import { historicalImportPreviewRequestSchema } from "./historical-import-contract";
import { planHistoricalImportBirthday } from "./historical-import-fields";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

export type HistoricalImportPreviewIssue =
  | "customer_unavailable"
  | "account_unavailable"
  | "tier_unavailable"
  | "birthday_conflict"
  | "balance_overflow";

/**
 * Read-only projection within the caller's authenticated repeatable-read
 * transaction. It does not authorize imports or replace commit-time fences.
 * Only row positions and financial projections leave this boundary, not PII.
 */
export async function inspectHistoricalImportPreview({
  tx,
  storeId,
  programId,
  request,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  request: unknown;
}) {
  const input = historicalImportPreviewRequestSchema.parse(request);
  const program = await tx.weleticLoyaltyProgram.findFirst({
    where: { id: programId, storeId },
    select: { id: true },
  });
  if (!program) throw new Error("Historical import program unavailable");
  const tiers = await tx.weleticLoyaltyTier.findMany({
    where: { programId, deletedAt: null },
    select: { id: true },
  });
  const tierIds = new Set(tiers.map((tier) => tier.id));
  const numericId = (id: string) => id.slice("gid://shopify/Customer/".length);
  const shoppers = await tx.weleticShopper.findMany({
    where: {
      storeId,
      shopifyCustomerId: {
        in: input.rows.flatMap((row) => [
          row.shopifyCustomerId,
          numericId(row.shopifyCustomerId),
        ]),
      },
    },
    include: { loyaltyAccount: true },
  });
  const byIdentity = new Map(
    shoppers.map((shopper) => [shopper.shopifyCustomerId, shopper]),
  );
  const resolved = input.rows.map((row) => {
    const candidates = [
      byIdentity.get(row.shopifyCustomerId),
      byIdentity.get(numericId(row.shopifyCustomerId)),
    ].filter((value) => value !== undefined);
    return candidates.length === 1 ? candidates[0] : null;
  });
  const identities = input.rows.map((row, index) =>
    deriveAllShopifyCustomerPrivacyIdentities({
      storeId,
      shopifyCustomerId: row.shopifyCustomerId,
      email:
        resolved[index]?.storeId === storeId ? resolved[index]?.email : null,
    }),
  );
  const tombstones = await tx.weleticShopifyCustomerPrivacyTombstone.findMany({
    where: {
      storeId,
      OR: [
        { shopperId: { in: shoppers.map((shopper) => shopper.id) } },
        {
          accountId: {
            in: shoppers.flatMap((shopper) =>
              shopper.loyaltyAccount ? [shopper.loyaltyAccount.id] : [],
            ),
          },
        },
        ...identities.flat(),
      ],
    },
    select: {
      shopperId: true,
      accountId: true,
      identityKind: true,
      identityKeyId: true,
      customerDigest: true,
      expiresAt: true,
    },
  });
  const identityKey = (identity: {
    identityKind: string;
    identityKeyId: string;
    customerDigest: string;
  }) =>
    JSON.stringify([
      identity.identityKind,
      identity.identityKeyId,
      identity.customerDigest,
    ]);
  const now = new Date();
  const blockedIdentities = new Set(
    tombstones.filter((value) => value.expiresAt > now).map(identityKey),
  );
  const blockedShoppers = new Set(tombstones.map((value) => value.shopperId));
  const blockedAccounts = new Set(tombstones.map((value) => value.accountId));
  const results: Array<{
    rowNumber: number;
    issues: HistoricalImportPreviewIssue[];
    wouldEnroll: boolean;
    balanceBefore: string | null;
    balanceAfter: string | null;
  }> = [];
  for (const [index, row] of input.rows.entries()) {
    const issues: HistoricalImportPreviewIssue[] = [];
    // Shopify webhooks persist numeric IDs; GraphQL consumers can retain GIDs.
    // If both records exist, do not choose one wallet or merge identities here.
    const shopper = resolved[index];
    const account = shopper?.loyaltyAccount;
    const identityBlocked = identities[index].some((identity) =>
      blockedIdentities.has(identityKey(identity)),
    );
    const ownerBlocked =
      (shopper && blockedShoppers.has(shopper.id)) ||
      (account && blockedAccounts.has(account.id));
    if (
      !shopper ||
      shopper.storeId !== storeId ||
      identityBlocked ||
      ownerBlocked
    )
      issues.push("customer_unavailable");
    if (
      account &&
      (account.storeId !== storeId ||
        account.programId !== programId ||
        account.shopperId !== shopper?.id ||
        account.status !== "active" ||
        hasShopifyCustomerRedactionTombstone(account.metadata))
    )
      issues.push("account_unavailable");
    if (row.tierId && !tierIds.has(row.tierId)) issues.push("tier_unavailable");
    // Reuse the commit planner without applying its metadata or schedule.
    // Do not inspect or disclose birthday state for an unavailable owner.
    if (!issues.length && row.birthday) {
      try {
        planHistoricalImportBirthday({
          metadata: account?.metadata ?? null,
          birthday: row.birthday,
          now,
        });
      } catch {
        issues.push("birthday_conflict");
      }
    }
    // Do not expose balances from an unavailable/cross-tenant account.
    const eligible = !issues.length;
    const before = eligible ? account?.cachedPointsBalance ?? BigInt(0) : null;
    const after = before === null ? null : before + BigInt(row.openingBalance);
    if (
      after !== null &&
      (after > BigInt("9223372036854775807") ||
        after < BigInt("-9223372036854775808"))
    )
      issues.push("balance_overflow");
    results.push({
      rowNumber: index + 1,
      issues,
      wouldEnroll: !issues.length && !account,
      balanceBefore: !issues.length ? before?.toString() ?? null : null,
      balanceAfter: !issues.length ? after?.toString() ?? null : null,
    });
  }
  return { rows: results, valid: results.every((row) => !row.issues.length) };
}
