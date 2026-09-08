import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { createHash, randomBytes } from "node:crypto";

export interface CreateInstallIntentOptions {
  workspaceId: string;
  shopDomain: string;
  ttlSeconds?: number;
}

export interface InstallIntentResult {
  intentId: string;
  token: string;
  shopDomain: string;
  expiresAt: Date;
}

export function hashIntentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createShopifyInstallIntent({
  workspaceId,
  shopDomain,
  ttlSeconds = 600, // 10 minutes default
}: CreateInstallIntentOptions): Promise<InstallIntentResult> {
  const normalizedShop = shopDomain.trim().toLowerCase();
  if (!normalizedShop.endsWith(".myshopify.com")) {
    throw new Error(
      "Invalid Shopify domain format. Must end with .myshopify.com",
    );
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashIntentToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const intentId = createWeleticId("wintent_");

  await prisma.weleticShopifyInstallIntent.create({
    data: {
      id: intentId,
      workspaceId,
      shopDomain: normalizedShop,
      tokenHash,
      expiresAt,
    },
  });

  return {
    intentId,
    token: rawToken,
    shopDomain: normalizedShop,
    expiresAt,
  };
}

export async function consumeShopifyInstallIntent({
  shopDomain,
  token,
  expectedWorkspaceId,
}: {
  shopDomain: string;
  token: string;
  expectedWorkspaceId?: string;
}): Promise<{ valid: boolean; workspaceId?: string; error?: string }> {
  const normalizedShop = shopDomain.trim().toLowerCase();
  const tokenHash = hashIntentToken(token);
  const now = new Date();

  return await prisma.$transaction(async (tx) => {
    const intent = await tx.weleticShopifyInstallIntent.findUnique({
      where: { tokenHash },
    });

    if (!intent) {
      return { valid: false, error: "invalid_intent_token" };
    }

    if (intent.consumedAt) {
      return { valid: false, error: "intent_already_consumed" };
    }

    if (intent.expiresAt < now) {
      return { valid: false, error: "intent_expired" };
    }

    if (intent.shopDomain !== normalizedShop) {
      return { valid: false, error: "shop_domain_mismatch" };
    }

    if (expectedWorkspaceId && intent.workspaceId !== expectedWorkspaceId) {
      return { valid: false, error: "workspace_mismatch" };
    }

    await tx.weleticShopifyInstallIntent.update({
      where: { id: intent.id },
      data: { consumedAt: now },
    });

    return {
      valid: true,
      workspaceId: intent.workspaceId,
    };
  });
}
