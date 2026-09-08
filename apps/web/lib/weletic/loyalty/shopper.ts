import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { awardSignupWelcomeBonus } from "@/lib/weletic/loyalty/non-purchase-earn";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { hasShopifyCustomerPrivacyTombstone } from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma, type WeleticLoyaltyAccount } from "@prisma/client";

export interface ShopifyCustomerPayload {
  id: number | string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  locale?: string | null;
  tags?: string | string[] | null;
  accepts_marketing?: boolean | null;
  orders_count?: number | null;
  total_spent?: string | number | null;
}

export async function upsertWeleticShopper({
  storeId,
  customer,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  customer?: ShopifyCustomerPayload | null;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!customer || !customer.id) {
    return null;
  }

  const shopifyCustomerId = String(customer.id);
  const email = customer.email?.trim().toLowerCase() || null;
  const phone = customer.phone?.trim() || null;
  const firstName = customer.first_name?.trim() || null;
  const lastName = customer.last_name?.trim() || null;
  const locale = customer.locale || "en";
  const acceptsMarketing = Boolean(customer.accepts_marketing);

  let tagsArray: string[] | null = null;
  if (typeof customer.tags === "string") {
    tagsArray = customer.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  } else if (Array.isArray(customer.tags)) {
    tagsArray = customer.tags.map((t) => String(t).trim()).filter(Boolean);
  }

  const result = await prisma.$transaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "shopper_upsert",
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      tx,
    });
    const hasIndependentPrivacyTombstone =
      await hasShopifyCustomerPrivacyTombstone({
        storeId,
        shopifyCustomerId,
        email,
        tx,
      });
    const existingShopper = await tx.weleticShopper.findUnique({
      where: {
        storeId_shopifyCustomerId: {
          storeId,
          shopifyCustomerId,
        },
      },
      include: {
        loyaltyAccount: { include: { program: true } },
      },
    });

    // The independent HMAC tombstone exists even when customers/redact arrived
    // before the first customer/order event. It is checked under the same
    // customer settlement lock as ingress, so delayed webhooks cannot recreate
    // a profile, loyalty account, or signup award after redaction.
    if (hasIndependentPrivacyTombstone) {
      if (!existingShopper?.loyaltyAccount) {
        return {
          shopper: existingShopper ?? null,
          loyaltyAccount: null,
          loyaltyProgram: null,
          loyaltyAccountCreated: false,
          privacyTombstoned: true,
        };
      }
      const { loyaltyAccount: accountWithProgram, ...shopper } =
        existingShopper;
      const { program: loyaltyProgram, ...loyaltyAccount } = accountWithProgram;
      return {
        shopper,
        loyaltyAccount,
        loyaltyProgram,
        loyaltyAccountCreated: false,
        privacyTombstoned: true,
      };
    }

    // Shopify can deliver customers/create, customers/update, and orders/paid
    // long after customers/redact. Keep the stable shopper/account identity so
    // financial orders can still be associated, but never write payload PII
    // back into a profile carrying the durable redaction tombstone.
    if (
      existingShopper?.loyaltyAccount &&
      hasShopifyCustomerRedactionTombstone(
        existingShopper.loyaltyAccount.metadata,
      )
    ) {
      const { loyaltyAccount: accountWithProgram, ...shopper } =
        existingShopper;
      const { program: loyaltyProgram, ...loyaltyAccount } = accountWithProgram;
      return {
        shopper,
        loyaltyAccount,
        loyaltyProgram,
        loyaltyAccountCreated: false,
        privacyTombstoned: true,
      };
    }

    // 1. Upsert Shopper
    const shopper = await tx.weleticShopper.upsert({
      where: {
        storeId_shopifyCustomerId: {
          storeId,
          shopifyCustomerId,
        },
      },
      create: {
        id: createWeleticId("wshop_"),
        storeId,
        shopifyCustomerId,
        firstName,
        lastName,
        email,
        phone,
        locale,
        tags: tagsArray ? tagsArray : Prisma.DbNull,
        acceptsMarketing,
        ordersCount: customer.orders_count ? Number(customer.orders_count) : 0,
        totalSpent: customer.total_spent
          ? BigInt(Math.round(Number(customer.total_spent) * 100))
          : BigInt(0),
      },
      update: {
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
        email: email ?? undefined,
        phone: phone ?? undefined,
        locale: locale ?? undefined,
        tags: tagsArray ? tagsArray : undefined,
        acceptsMarketing,
      },
    });

    // Identity ingestion is shared by commerce and reviews. It must neither
    // initialize nor activate loyalty just because a customer event arrived.
    const loyaltyProgram = await tx.weleticLoyaltyProgram.findUnique({
      where: { storeId },
    });
    let loyaltyAccount: WeleticLoyaltyAccount | null = null;
    if (existingShopper?.loyaltyAccount) {
      const { program, ...account } = existingShopper.loyaltyAccount;
      void program;
      loyaltyAccount = account;
    }

    if (
      !loyaltyProgram ||
      loyaltyProgram.status !== "active" ||
      loyaltyProgram.killSwitchActive
    ) {
      return {
        shopper,
        loyaltyAccount,
        loyaltyProgram,
        loyaltyAccountCreated: false,
        privacyTombstoned: false,
      };
    }

    const loyaltyAccountCreated = !existingShopper?.loyaltyAccount;
    // 3. Ensure Loyalty Account exists for Shopper. Customer settlement is
    // serialized before this transaction, so an existing account can be reused
    // without an empty-update upsert. Prisma's MySQL query engine rejects the
    // existing-row `upsert({ update: {} })` shape used by webhook replays.
    if (!loyaltyAccount) {
      loyaltyAccount = await tx.weleticLoyaltyAccount.create({
        data: {
          id: createWeleticId("wacc_"),
          storeId,
          programId: loyaltyProgram.id,
          shopperId: shopper.id,
          status: "active",
        },
      });
    }

    if (
      loyaltyAccountCreated &&
      loyaltyProgram.status === "active" &&
      !loyaltyProgram.killSwitchActive
    ) {
      const signupRule = await tx.weleticLoyaltyEarningRule.findFirst({
        where: {
          programId: loyaltyProgram.id,
          triggerCode: "account_created",
          ruleType: "fixed_points",
          isActive: true,
          deletedAt: null,
          OR: [{ startAt: null }, { startAt: { lte: new Date() } }],
          AND: [{ OR: [{ endAt: null }, { endAt: { gte: new Date() } }] }],
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      });

      if (signupRule?.fixedPoints) {
        await awardSignupWelcomeBonus({
          storeId,
          accountId: loyaltyAccount.id,
          bonusPoints: signupRule.fixedPoints,
          reason: signupRule.name,
          metadata: { earningRuleId: signupRule.id },
          loyaltyMaintenancePermit,
          tx,
        });
      }
    }

    return {
      shopper,
      loyaltyAccount,
      loyaltyProgram,
      loyaltyAccountCreated,
      privacyTombstoned: false,
    };
  });

  // Referral identity is provisioned lazily by the customer summary. Shopify
  // ingestion already runs under the customer settlement lock, so provisioning
  // it here would attempt to reacquire the same non-reentrant distributed lock.
  return result;
}

export {
  anonymizeWeleticShopper,
  getShopperDataExport,
} from "@/lib/weletic/loyalty/shopper-privacy";
