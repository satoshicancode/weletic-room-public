import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  getCustomerLoyaltySummary,
  redeemCustomerPoints,
} from "@/lib/weletic/loyalty/customer";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { createRewardDefinition } from "@/lib/weletic/loyalty/rewards";
import {
  resolveShopifyOfflineCredentials,
  shopifyAdminGraphqlRequest,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  deactivateShopifyGiftCard,
  debitShopifyStoreCredit,
  lookupShopifyGiftCard,
  lookupShopifyStoreCreditAccount,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import {
  WeleticLoyaltyAccountStatus,
  WeleticPointsLedgerEntryType,
  WeleticRewardArtifactKind,
  WeleticRewardType,
} from "@prisma/client";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DISPOSABLE_TAG = "weletic_disposable_financial_validation";
const POINTS_GRANT = BigInt(300);
const POINTS_COST = BigInt(100);
const REWARD_AMOUNT_MINOR = BigInt(100);

type CheckName =
  | "safetyGates"
  | "customerCreated"
  | "localAccountCreated"
  | "giftCardIssued"
  | "giftCardReadback"
  | "storeCreditIssued"
  | "storeCreditReadback"
  | "walletValidated"
  | "giftCardDeactivated"
  | "storeCreditDebited"
  | "storeCreditZero"
  | "customerDeleted"
  | "localCleanup";

type ValidationReport = {
  timestamp: string;
  storeDomain: string;
  status: "PASSED" | "FAILED";
  checks: Record<CheckName, boolean>;
  cleanup: {
    remoteFinancialValueRemaining: boolean;
    remoteCustomerRemaining: boolean;
    localFixtureRowsRemaining: number;
  };
  failure?: { phase: CheckName | "unknown"; category: string };
};

type CliOptions = {
  storeDomain: string;
  reportPath: string;
  confirmStaging: boolean;
};

function parseCli(argv: string[]): CliOptions {
  let storeDomain = "";
  let reportPath = "";
  let confirmStaging = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--store") storeDomain = argv[++index] || "";
    else if (argument === "--report") reportPath = argv[++index] || "";
    else if (argument === "--confirm-staging") confirmStaging = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { storeDomain, reportPath, confirmStaging };
}

function assertSafety(options: CliOptions) {
  if (!options.confirmStaging) {
    throw new Error("Missing explicit staging confirmation.");
  }
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  ) {
    throw new Error("Financial validation is forbidden in production.");
  }
  const normalizedStore = options.storeDomain.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalizedStore)) {
    throw new Error("A canonical myshopify.com test-store domain is required.");
  }
  const allowlist = new Set(
    (process.env.WELETIC_LOYALTY_TEST_STORE_ALLOWLIST || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowlist.has(normalizedStore)) {
    throw new Error(
      "The requested store is not in the explicit test allowlist.",
    );
  }
  if (!path.isAbsolute(options.reportPath)) {
    throw new Error("The validation report path must be absolute.");
  }
  return normalizedStore;
}

function numericShopifyId(gid: string) {
  const match = gid.match(/^gid:\/\/shopify\/Customer\/(\d+)$/);
  if (!match) throw new Error("Shopify returned an invalid customer identity.");
  return match[1];
}

function moneyMatches(left: string, right: string) {
  return Math.abs(Number(left) - Number(right)) < 0.000001;
}

function safeFailureCategory(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (/^[A-Z0-9_]{2,80}$/.test(code)) return code;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

function writeReport(reportPath: string, report: ValidationReport) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(reportPath, 0o600);
}

async function createDisposableCustomer({
  shopDomain,
  accessToken,
  runTag,
}: {
  shopDomain: string;
  accessToken: string;
  runTag: string;
}) {
  type CustomerNode = { id: string; email: string | null; tags: string[] };
  try {
    const data = await shopifyAdminGraphqlRequest<{
      customerCreate: {
        customer: CustomerNode | null;
        userErrors: Array<{ message: string }>;
      };
    }>({
      shopDomain,
      accessToken,
      query: `mutation WeleticFinancialCustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id email tags }
          userErrors { field message }
        }
      }`,
      variables: {
        input: {
          firstName: "Weletic",
          lastName: "Financial Validation",
          tags: [DISPOSABLE_TAG, runTag],
        },
      },
      maxRetries: 0,
      postDispatchOutcomeUnknown: true,
    });
    if (data.customerCreate.userErrors.length > 0) {
      throw new Error("Shopify rejected the disposable customer fixture.");
    }
    const customer = data.customerCreate.customer;
    if (
      !customer ||
      customer.email !== null ||
      !customer.tags.includes(DISPOSABLE_TAG) ||
      !customer.tags.includes(runTag)
    ) {
      throw new Error(
        "Shopify returned an unsafe disposable customer fixture.",
      );
    }
    return customer;
  } catch (error) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reconciled = await shopifyAdminGraphqlRequest<{
        customers: { nodes: CustomerNode[] };
      }>({
        shopDomain,
        accessToken,
        query: `query WeleticFinancialCustomerReconcile($query: String!) {
          customers(first: 5, query: $query) { nodes { id email tags } }
        }`,
        variables: { query: `tag:${runTag}` },
        maxRetries: 1,
      });
      const exact = reconciled.customers.nodes.filter(
        (customer) =>
          customer.email === null &&
          customer.tags.includes(DISPOSABLE_TAG) &&
          customer.tags.includes(runTag),
      );
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) {
        throw new Error("Multiple disposable customers matched one run tag.");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw error;
  }
}

async function readCustomerStoreCreditAccount({
  shopDomain,
  accessToken,
  customerGid,
  currencyCode,
}: {
  shopDomain: string;
  accessToken: string;
  customerGid: string;
  currencyCode: string;
}) {
  const data = await shopifyAdminGraphqlRequest<{
    customer: {
      storeCreditAccounts: {
        nodes: Array<{
          id: string;
          balance: { amount: string; currencyCode: string };
        }>;
      };
    } | null;
  }>({
    shopDomain,
    accessToken,
    query: `query WeleticFinancialCustomerStoreCredit($id: ID!) {
      customer(id: $id) {
        storeCreditAccounts(first: 10) {
          nodes { id balance { amount currencyCode } }
        }
      }
    }`,
    variables: { id: customerGid },
    maxRetries: 1,
  });
  const accounts =
    data.customer?.storeCreditAccounts.nodes.filter(
      (account) => account.balance.currencyCode === currencyCode,
    ) || [];
  if (accounts.length !== 1) {
    throw new Error("Shopify did not expose one exact Store Credit account.");
  }
  return accounts[0];
}

async function deleteDisposableCustomer({
  shopDomain,
  accessToken,
  customerGid,
  runTag,
}: {
  shopDomain: string;
  accessToken: string;
  customerGid: string;
  runTag: string;
}) {
  const before = await shopifyAdminGraphqlRequest<{
    customer: { id: string; tags: string[] } | null;
  }>({
    shopDomain,
    accessToken,
    query: `query WeleticFinancialCustomerDeleteGuard($id: ID!) {
      customer(id: $id) { id tags }
    }`,
    variables: { id: customerGid },
  });
  if (!before.customer) return true;
  if (
    !before.customer.tags.includes(DISPOSABLE_TAG) ||
    !before.customer.tags.includes(runTag)
  ) {
    throw new Error("Refusing to delete a customer without both fixture tags.");
  }
  try {
    const deleted = await shopifyAdminGraphqlRequest<{
      customerDelete: {
        deletedCustomerId: string | null;
        userErrors: Array<{ message: string }>;
      };
    }>({
      shopDomain,
      accessToken,
      query: `mutation WeleticFinancialCustomerDelete($input: CustomerDeleteInput!) {
        customerDelete(input: $input) {
          deletedCustomerId
          userErrors { field message }
        }
      }`,
      variables: { input: { id: customerGid } },
      maxRetries: 0,
      postDispatchOutcomeUnknown: true,
    });
    if (
      deleted.customerDelete.userErrors.length > 0 ||
      deleted.customerDelete.deletedCustomerId !== customerGid
    ) {
      throw new Error("Shopify did not confirm disposable customer deletion.");
    }
  } catch (error) {
    const reconciled = await shopifyAdminGraphqlRequest<{
      customer: { id: string } | null;
    }>({
      shopDomain,
      accessToken,
      query: `query WeleticFinancialCustomerDeleteReconcile($id: ID!) {
        customer(id: $id) { id }
      }`,
      variables: { id: customerGid },
    });
    if (reconciled.customer) throw error;
  }
  const after = await shopifyAdminGraphqlRequest<{
    customer: { id: string } | null;
  }>({
    shopDomain,
    accessToken,
    query: `query WeleticFinancialCustomerDeleted($id: ID!) {
      customer(id: $id) { id }
    }`,
    variables: { id: customerGid },
  });
  return after.customer === null;
}

async function run() {
  const options = parseCli(process.argv.slice(2));
  const storeDomain = assertSafety(options);
  const checks: ValidationReport["checks"] = {
    safetyGates: true,
    customerCreated: false,
    localAccountCreated: false,
    giftCardIssued: false,
    giftCardReadback: false,
    storeCreditIssued: false,
    storeCreditReadback: false,
    walletValidated: false,
    giftCardDeactivated: false,
    storeCreditDebited: false,
    storeCreditZero: false,
    customerDeleted: false,
    localCleanup: false,
  };
  const report: ValidationReport = {
    timestamp: new Date().toISOString(),
    storeDomain,
    status: "FAILED",
    checks,
    cleanup: {
      remoteFinancialValueRemaining: true,
      remoteCustomerRemaining: true,
      localFixtureRowsRemaining: 0,
    },
  };
  let phase: CheckName | "unknown" = "safetyGates";
  let customerGid: string | null = null;
  let customerId: string | null = null;
  let shopperId: string | null = null;
  let accountId: string | null = null;
  let giftRewardId: string | null = null;
  let storeCreditRewardId: string | null = null;
  let giftRedemptionId: string | null = null;
  let storeCreditRedemptionId: string | null = null;
  let giftCardId: string | null = null;
  let storeCreditAccountId: string | null = null;
  let giftCardCode: string | null = null;
  let remoteFinancialCleanupComplete = false;
  const runToken = crypto.randomBytes(8).toString("hex");
  const runTag = `weletic_fin_${runToken}`;
  const giftCode = `WLG${crypto.randomBytes(7).toString("hex").toUpperCase()}`;
  const storeCreditReference = `WLS${crypto.randomBytes(7).toString("hex").toUpperCase()}`;

  try {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { shopDomain: storeDomain },
      include: { loyaltyProgram: true },
    });
    if (
      !store?.loyaltyProgram ||
      store.loyaltyProgram.status !== "active" ||
      store.loyaltyProgram.killSwitchActive ||
      store.loyaltyProgram.enableCheckoutExtension ||
      !store.currencyVerifiedAt
    ) {
      throw new Error(
        "The target is not an active Shopify Basic staging program.",
      );
    }
    const credentials = await resolveShopifyOfflineCredentials({
      storeId: store.id,
    });

    phase = "customerCreated";
    const customer = await createDisposableCustomer({
      shopDomain: storeDomain,
      accessToken: credentials.accessToken,
      runTag,
    });
    customerGid = customer.id;
    customerId = numericShopifyId(customer.id);
    checks.customerCreated = true;

    phase = "localAccountCreated";
    shopperId = createWeleticId("wshop_");
    accountId = createWeleticId("wacc_");
    await prisma.$transaction(async (tx) => {
      await tx.weleticShopper.create({
        data: {
          id: shopperId!,
          storeId: store.id,
          shopifyCustomerId: customerId!,
          firstName: "Weletic",
          lastName: "Financial Validation",
          email: null,
          tags: [DISPOSABLE_TAG, runTag],
        },
      });
      await tx.weleticLoyaltyAccount.create({
        data: {
          id: accountId!,
          storeId: store.id,
          programId: store.loyaltyProgram!.id,
          shopperId: shopperId!,
          status: WeleticLoyaltyAccountStatus.active,
          metadata: { disposableValidation: true, runTag },
        },
      });
    });
    await appendPointsLedgerEntry({
      storeId: store.id,
      accountId,
      entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      pointsDelta: POINTS_GRANT,
      idempotencyKey: `financial-validation:${runToken}:grant`,
      reason: "Disposable financial reward validation",
      metadata: { disposableValidation: true },
    });
    checks.localAccountCreated = true;

    const [giftReward, storeCreditReward] = await Promise.all([
      createRewardDefinition({
        storeId: store.id,
        name: `Disposable Gift Card Validation ${runToken}`,
        rewardType: WeleticRewardType.gift_card,
        pointsCost: POINTS_COST,
        discountValue: REWARD_AMOUNT_MINOR.toString(),
        usageLimitPerCustomer: 1,
      }),
      createRewardDefinition({
        storeId: store.id,
        name: `Disposable Store Credit Validation ${runToken}`,
        rewardType: WeleticRewardType.store_credit,
        pointsCost: POINTS_COST,
        discountValue: REWARD_AMOUNT_MINOR.toString(),
        usageLimitPerCustomer: 1,
      }),
    ]);
    giftRewardId = giftReward.id;
    storeCreditRewardId = storeCreditReward.id;

    phase = "giftCardIssued";
    const giftRedemption = await redeemCustomerPoints({
      storeId: store.id,
      shopifyCustomerId: customerId,
      rewardDefinitionId: giftReward.id,
      discountCode: giftCode,
      idempotencyKey: `financial-validation:${runToken}:gift-card`,
    });
    giftRedemptionId = giftRedemption.redemptionId;
    giftCardCode = giftRedemption.giftCardCode;
    if (
      giftRedemption.artifactKind !== WeleticRewardArtifactKind.gift_card ||
      !giftCardCode ||
      giftRedemption.status !== "issued"
    ) {
      throw new Error("Gift Card redemption did not finalize as issued.");
    }
    const persistedGift = await prisma.weleticRewardRedemption.findUnique({
      where: { id: giftRedemptionId },
      select: { shopifyGiftCardId: true },
    });
    if (!persistedGift?.shopifyGiftCardId) {
      throw new Error(
        "Gift Card redemption is missing its remote artifact ID.",
      );
    }
    giftCardId = persistedGift.shopifyGiftCardId;
    checks.giftCardIssued = true;

    phase = "giftCardReadback";
    let giftReadback: Awaited<ReturnType<typeof lookupShopifyGiftCard>> = null;
    for (let attempt = 0; attempt < 10 && !giftReadback; attempt += 1) {
      giftReadback = await lookupShopifyGiftCard({
        shopDomain: storeDomain,
        accessToken: credentials.accessToken,
        code: giftCardCode,
        customerId,
        amountMinor: REWARD_AMOUNT_MINOR,
        currencyCode: store.shopCurrency,
        expiresAt: null,
        note: `Weletic loyalty redemption ${giftRedemptionId}`,
      });
      if (!giftReadback) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (!giftReadback || giftReadback.id !== giftCardId) {
      throw new Error("Gift Card exact remote readback failed.");
    }
    checks.giftCardReadback = true;

    phase = "storeCreditIssued";
    const creditRedemption = await redeemCustomerPoints({
      storeId: store.id,
      shopifyCustomerId: customerId,
      rewardDefinitionId: storeCreditReward.id,
      discountCode: storeCreditReference,
      idempotencyKey: `financial-validation:${runToken}:store-credit`,
      notifyStoreCreditOwner: false,
    });
    storeCreditRedemptionId = creditRedemption.redemptionId;
    if (
      creditRedemption.artifactKind !==
        WeleticRewardArtifactKind.store_credit ||
      creditRedemption.artifactCode !== null ||
      creditRedemption.status !== "issued"
    ) {
      throw new Error("Store Credit redemption did not finalize as issued.");
    }
    checks.storeCreditIssued = true;

    phase = "storeCreditReadback";
    const customerCredit = await readCustomerStoreCreditAccount({
      shopDomain: storeDomain,
      accessToken: credentials.accessToken,
      customerGid,
      currencyCode: store.shopCurrency,
    });
    storeCreditAccountId = customerCredit.id;
    const expectedAmount = minorUnitsToDecimal(
      REWARD_AMOUNT_MINOR,
      store.shopCurrency,
    );
    if (!moneyMatches(customerCredit.balance.amount, expectedAmount)) {
      throw new Error("Store Credit balance did not match the issued value.");
    }
    const accountReadback = await lookupShopifyStoreCreditAccount({
      credentials,
      accountId: storeCreditAccountId,
    });
    if (
      !accountReadback ||
      accountReadback.currencyCode !== store.shopCurrency ||
      !moneyMatches(accountReadback.balance, expectedAmount)
    ) {
      throw new Error("Store Credit exact account readback failed.");
    }
    checks.storeCreditReadback = true;

    phase = "walletValidated";
    await prisma.weleticLoyaltyAccount.update({
      where: { id: accountId },
      data: { status: WeleticLoyaltyAccountStatus.suspended },
    });
    const summary = await getCustomerLoyaltySummary({
      storeId: store.id,
      shopifyCustomerId: customerId,
    });
    if (!summary.isEnrolled) {
      throw new Error("Disposable customer is not enrolled in Loyalty.");
    }
    const walletKinds = new Set(
      summary.rewardWallet.map((item) => item.artifactKind),
    );
    if (
      summary.account.pointsBalance !== "100" ||
      !walletKinds.has(WeleticRewardArtifactKind.gift_card) ||
      !walletKinds.has(WeleticRewardArtifactKind.store_credit) ||
      summary.recentActivity.filter(
        (item) => item.entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD,
      ).length !== 2
    ) {
      throw new Error(
        "Customer wallet or activity did not expose both rewards.",
      );
    }
    checks.walletValidated = true;

    phase = "giftCardDeactivated";
    checks.giftCardDeactivated = await deactivateShopifyGiftCard({
      credentials,
      giftCardId,
    });
    if (!checks.giftCardDeactivated) {
      throw new Error("Shopify did not confirm Gift Card deactivation.");
    }

    phase = "storeCreditDebited";
    const debit = await debitShopifyStoreCredit({
      credentials,
      accountId: storeCreditAccountId,
      amountMinor: REWARD_AMOUNT_MINOR,
      currencyCode: store.shopCurrency,
    });
    checks.storeCreditDebited = true;
    if (!moneyMatches(debit.balanceAfter, "0")) {
      throw new Error("Store Credit debit did not restore a zero balance.");
    }
    const zeroReadback = await lookupShopifyStoreCreditAccount({
      credentials,
      accountId: storeCreditAccountId,
    });
    checks.storeCreditZero = Boolean(
      zeroReadback && moneyMatches(zeroReadback.balance, "0"),
    );
    if (!checks.storeCreditZero) {
      throw new Error("Store Credit zero-balance readback failed.");
    }
    remoteFinancialCleanupComplete = true;
    report.cleanup.remoteFinancialValueRemaining = false;

    phase = "customerDeleted";
    checks.customerDeleted = await deleteDisposableCustomer({
      shopDomain: storeDomain,
      accessToken: credentials.accessToken,
      customerGid,
      runTag,
    });
    if (!checks.customerDeleted) {
      throw new Error("Disposable Shopify customer remains after deletion.");
    }
    report.cleanup.remoteCustomerRemaining = false;

    phase = "localCleanup";
    const redemptionIds = [giftRedemptionId, storeCreditRedemptionId].filter(
      (value): value is string => Boolean(value),
    );
    await prisma.$transaction(async (tx) => {
      if (redemptionIds.length > 0) {
        await tx.weleticLoyaltyOutboxJob.deleteMany({
          where: {
            storeId: store.id,
            idempotencyKey: {
              in: redemptionIds.flatMap((id) => [
                `metafield_sync:redeem:${id}`,
                `redemption_expiry:${id}`,
                `recovery:${id}`,
              ]),
            },
          },
        });
      }
      if (accountId) {
        await tx.weleticRewardRedemption.deleteMany({
          where: { storeId: store.id, accountId },
        });
        await tx.weleticPointsLedgerEntry.deleteMany({
          where: { storeId: store.id, accountId },
        });
        await tx.weleticLoyaltyAccount.deleteMany({
          where: { id: accountId, storeId: store.id },
        });
      }
      if (shopperId) {
        await tx.weleticShopper.deleteMany({
          where: { id: shopperId, storeId: store.id },
        });
      }
      const rewardIds = [giftRewardId, storeCreditRewardId].filter(
        (value): value is string => Boolean(value),
      );
      if (rewardIds.length > 0) {
        await tx.weleticRewardDefinition.deleteMany({
          where: { storeId: store.id, id: { in: rewardIds } },
        });
      }
    });

    const outboxKeys = redemptionIds.flatMap((id) => [
      `metafield_sync:redeem:${id}`,
      `redemption_expiry:${id}`,
      `recovery:${id}`,
    ]);
    const remaining = await Promise.all([
      accountId
        ? prisma.weleticLoyaltyAccount.count({ where: { id: accountId } })
        : 0,
      shopperId ? prisma.weleticShopper.count({ where: { id: shopperId } }) : 0,
      redemptionIds.length > 0
        ? prisma.weleticRewardRedemption.count({
            where: { id: { in: redemptionIds } },
          })
        : 0,
      accountId
        ? prisma.weleticPointsLedgerEntry.count({ where: { accountId } })
        : 0,
      outboxKeys.length > 0
        ? prisma.weleticLoyaltyOutboxJob.count({
            where: { storeId: store.id, idempotencyKey: { in: outboxKeys } },
          })
        : 0,
      giftRewardId
        ? prisma.weleticRewardDefinition.count({ where: { id: giftRewardId } })
        : 0,
      storeCreditRewardId
        ? prisma.weleticRewardDefinition.count({
            where: { id: storeCreditRewardId },
          })
        : 0,
    ]);
    report.cleanup.localFixtureRowsRemaining = remaining.reduce(
      (sum, count) => sum + count,
      0,
    );
    checks.localCleanup = report.cleanup.localFixtureRowsRemaining === 0;
    if (!checks.localCleanup) {
      throw new Error("Local disposable fixture cleanup was incomplete.");
    }

    report.status = "PASSED";
  } catch (error) {
    report.failure = { phase, category: safeFailureCategory(error) };
    if (!customerGid) report.cleanup.remoteCustomerRemaining = false;
    if (!giftCardId && !storeCreditAccountId) {
      report.cleanup.remoteFinancialValueRemaining = false;
    } else if (remoteFinancialCleanupComplete) {
      report.cleanup.remoteFinancialValueRemaining = false;
    }
    process.exitCode = 1;
  } finally {
    writeReport(options.reportPath, report);
    await prisma.$disconnect();
  }

  process.stdout.write(
    `${JSON.stringify({ status: report.status, checks: report.checks, cleanup: report.cleanup })}\n`,
  );
}

void run();
