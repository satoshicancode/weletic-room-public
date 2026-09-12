import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  addRetentionDays,
  getShopifyCustomerTombstoneRetentionDays,
  getShopifyFinancialRetentionDays,
} from "@/lib/weletic/shopify/compliance-config";
import { canonicalizeShopifyDomain } from "@/lib/weletic/shopify/store-resolver";
import {
  Prisma,
  WeleticCustomerPrivacyIdentityKind,
  type WeleticShopifyCustomerPrivacyTombstone,
} from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";

const PRIVACY_HMAC_ENV = "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CUSTOMER_IDENTITY_CONTEXT =
  "weletic:shopify:customer-privacy-identity:v1";
const SHOP_IDENTITY_CONTEXT = "weletic:shopify:shop-privacy-identity:v1";
const DERIVED_SIGNAL_CONTEXT = "weletic:shopify:derived-privacy-signal:v1";
export const VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN =
  /^hmac:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-F0-9]{64})$/;

export type ShopifyDerivedPrivacyDigestPurpose =
  | "customer_selection"
  | "referral_email"
  | "referral_ip"
  | "referral_user_agent"
  | "customer_activity"
  | "nudge_membership"
  | "webhook_body";

type ShopifyPrivacyHmacKey = {
  identityKeyId: string;
  secret: Buffer;
};

export type ShopifyPrivacyHmacKeyring = {
  // Do not retire a previous key merely because privacy tombstones expired.
  // Referral signals and active voucher selection snapshots can retain its
  // key ID; deployment remains blocked until every such digest expires or is
  // migrated under an audited retention release.
  current: ShopifyPrivacyHmacKey;
  all: readonly ShopifyPrivacyHmacKey[];
};

export type ShopifyCustomerPrivacyIdentity = {
  identityKind: WeleticCustomerPrivacyIdentityKind;
  identityKeyId: string;
  customerDigest: string;
};

export type ShopifyShopPrivacyIdentity = {
  identityKeyId: string;
  shopDomainDigest: string;
};

/**
 * A retained customer identity is already owned by another pseudonymous
 * shopper/account. Compliance callers must dead-letter this condition for
 * operator review instead of silently rebinding an email or recycled id.
 */
export class ShopifyCustomerPrivacyOwnerConflictError extends Error {}

export const SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN =
  /^redacted:v1:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-F0-9]{64})$/;

function decodeBase64Secret(encoded: string) {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const secret = Buffer.from(normalized, "base64");
  const inputWithoutPadding = normalized.replace(/=+$/, "");
  const encodedWithoutPadding = secret.toString("base64").replace(/=+$/, "");
  return secret.length === 32 && inputWithoutPadding === encodedWithoutPadding
    ? secret
    : null;
}

export function loadShopifyPrivacyHmacKeyring(
  rawValue = process.env.WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS,
): ShopifyPrivacyHmacKeyring {
  let configured = rawValue?.trim();
  if (!configured && process.env.NODE_ENV === "test") {
    configured = `test-v1:${Buffer.alloc(32, 0x42).toString("base64")}`;
  }
  if (!configured) {
    throw new Error(
      `${PRIVACY_HMAC_ENV} is required for Shopify privacy identity processing.`,
    );
  }

  const seenKeyIds = new Set<string>();
  const keys = configured.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const identityKeyId = entry.slice(0, separator).trim();
    const encodedSecret = entry.slice(separator + 1).trim();
    if (
      separator <= 0 ||
      !KEY_ID_PATTERN.test(identityKeyId) ||
      seenKeyIds.has(identityKeyId)
    ) {
      throw new Error(
        `${PRIVACY_HMAC_ENV} contains an invalid or duplicate key id.`,
      );
    }
    const secret = decodeBase64Secret(encodedSecret);
    if (!secret) {
      throw new Error(
        `${PRIVACY_HMAC_ENV} keys must be exactly 32 bytes encoded as base64.`,
      );
    }
    seenKeyIds.add(identityKeyId);
    return { identityKeyId, secret };
  });

  if (keys.length === 0) {
    throw new Error(`${PRIVACY_HMAC_ENV} must contain at least one key.`);
  }
  return { current: keys[0], all: keys };
}

export function canonicalizeShopifyCustomerId(value: string | number) {
  const normalized = String(value).normalize("NFKC").trim();
  const gidMatch = normalized.match(/^gid:\/\/shopify\/Customer\/([^/]+)$/i);
  const canonical = gidMatch?.[1] ?? normalized;
  if (!canonical || canonical.length > 191) {
    throw new Error("Shopify customer id is invalid.");
  }
  return canonical;
}

export function canonicalizeShopifyCustomerEmail(value: string) {
  const canonical = value.normalize("NFKC").trim().toLowerCase();
  if (
    !canonical ||
    canonical.length > 320 ||
    canonical.startsWith("@") ||
    canonical.endsWith("@") ||
    canonical.split("@").length !== 2
  ) {
    throw new Error("Shopify customer email is invalid.");
  }
  return canonical;
}

function customerIdentityValue({
  identityKind,
  identity,
}: {
  identityKind: WeleticCustomerPrivacyIdentityKind;
  identity: string | number;
}) {
  return identityKind === WeleticCustomerPrivacyIdentityKind.customer_id
    ? canonicalizeShopifyCustomerId(identity)
    : canonicalizeShopifyCustomerEmail(String(identity));
}

function hmacDigest({
  key,
  context,
  values,
}: {
  key: ShopifyPrivacyHmacKey;
  context: string;
  values: readonly string[];
}) {
  const hmac = createHmac("sha256", key.secret);
  hmac.update(context, "utf8");
  for (const value of values) {
    hmac.update("\0", "utf8");
    hmac.update(value, "utf8");
  }
  return hmac.digest("hex").toUpperCase();
}

function deriveSignalDigestWithKey({
  purpose,
  values,
  key,
}: {
  purpose: ShopifyDerivedPrivacyDigestPurpose;
  values: readonly string[];
  key: ShopifyPrivacyHmacKey;
}) {
  if (values.length === 0 || values.some((value) => !value)) {
    throw new Error("Shopify privacy digest values must be non-empty.");
  }
  const digest = hmacDigest({
    key,
    context: DERIVED_SIGNAL_CONTEXT,
    values: [purpose, ...values],
  });
  return `hmac:v1:${key.identityKeyId}:${digest}`;
}

export function createShopifyDerivedPrivacyDigest({
  purpose,
  values,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  purpose: ShopifyDerivedPrivacyDigestPurpose;
  values: readonly string[];
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return deriveSignalDigestWithKey({
    purpose,
    values,
    key: keyring.current,
  });
}

export function createAllShopifyDerivedPrivacyDigests({
  purpose,
  values,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  purpose: ShopifyDerivedPrivacyDigestPurpose;
  values: readonly string[];
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return keyring.all.map((key) =>
    deriveSignalDigestWithKey({ purpose, values, key }),
  );
}

/**
 * Produces rotation-aware identities for the exact authenticated webhook
 * bytes. Base64 is only a lossless in-memory encoding; neither it nor the raw
 * body is persisted by this helper.
 */
export function createAllShopifyWebhookBodyDigests({
  topic,
  rawBodyBytes,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  topic: string;
  rawBodyBytes: Uint8Array;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  const normalizedTopic = topic.trim();
  if (!normalizedTopic || rawBodyBytes.byteLength === 0) {
    throw new Error(
      "An authenticated Shopify webhook topic and body are required.",
    );
  }
  return createAllShopifyDerivedPrivacyDigests({
    purpose: "webhook_body",
    values: [normalizedTopic, Buffer.from(rawBodyBytes).toString("base64")],
    keyring,
  });
}

export function verifyShopifyDerivedPrivacyDigest({
  encodedDigest,
  purpose,
  values,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  encodedDigest: string;
  purpose: ShopifyDerivedPrivacyDigestPurpose;
  values: readonly string[];
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  const parsed = encodedDigest.match(VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN);
  if (!parsed) return false;
  const key = keyring.all.find(
    ({ identityKeyId }) => identityKeyId === parsed[1],
  );
  if (!key) return false;
  const expected = deriveSignalDigestWithKey({ purpose, values, key });
  const actualBuffer = Buffer.from(encodedDigest, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function deriveCustomerIdentityWithKey({
  storeId,
  identityKind,
  identity,
  key,
}: {
  storeId: string;
  identityKind: WeleticCustomerPrivacyIdentityKind;
  identity: string | number;
  key: ShopifyPrivacyHmacKey;
}): ShopifyCustomerPrivacyIdentity {
  const normalizedStoreId = storeId.trim();
  if (!normalizedStoreId) throw new Error("Shopify store id is required.");
  return {
    identityKind,
    identityKeyId: key.identityKeyId,
    customerDigest: hmacDigest({
      key,
      context: CUSTOMER_IDENTITY_CONTEXT,
      values: [
        normalizedStoreId,
        identityKind,
        customerIdentityValue({ identityKind, identity }),
      ],
    }),
  };
}

export function deriveShopifyCustomerPrivacyIdentity({
  storeId,
  identityKind,
  identity,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  storeId: string;
  identityKind: WeleticCustomerPrivacyIdentityKind;
  identity: string | number;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return deriveCustomerIdentityWithKey({
    storeId,
    identityKind,
    identity,
    key: keyring.current,
  });
}

/**
 * Replaces a raw Shopify customer identifier in retained financial rows. The
 * value is deterministic only inside one store/key version, contains no raw
 * identifier, and stays within the 191-character Shopify identity columns.
 */
export function getShopifyCustomerPrivacyPseudonym({
  storeId,
  shopifyCustomerId,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  storeId: string;
  shopifyCustomerId: string | number;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  const identity = deriveShopifyCustomerPrivacyIdentity({
    storeId,
    identityKind: WeleticCustomerPrivacyIdentityKind.customer_id,
    identity: shopifyCustomerId,
    keyring,
  });
  return `redacted:v1:${identity.identityKeyId}:${identity.customerDigest}`;
}

/**
 * Recognizes a retained customer pseudonym without ever treating it as a new
 * raw Shopify identity. The key must remain configured so privacy locks and
 * erasure retries continue to converge across key rotation.
 */
export function parseShopifyCustomerPrivacyPseudonym(
  value: string,
  keyring = loadShopifyPrivacyHmacKeyring(),
) {
  const normalized = value.trim();
  const match = normalized.match(SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN);
  if (!match) {
    if (normalized.startsWith("redacted:")) {
      throw new Error("Retained Shopify customer pseudonym is invalid.");
    }
    return null;
  }
  const [, identityKeyId, customerDigest] = match;
  if (!keyring.all.some((key) => key.identityKeyId === identityKeyId)) {
    throw new Error("Retained Shopify customer pseudonym key is unavailable.");
  }
  return {
    value: normalized,
    identityKeyId,
    customerDigest,
  };
}

export function deriveAllShopifyCustomerPrivacyIdentities({
  storeId,
  shopifyCustomerId,
  email,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  storeId: string;
  shopifyCustomerId?: string | number | null;
  email?: string | null;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  const subjects: Array<{
    identityKind: WeleticCustomerPrivacyIdentityKind;
    identity: string | number;
  }> = [];
  if (shopifyCustomerId !== undefined && shopifyCustomerId !== null) {
    subjects.push({
      identityKind: WeleticCustomerPrivacyIdentityKind.customer_id,
      identity: shopifyCustomerId,
    });
  }
  if (email?.trim()) {
    subjects.push({
      identityKind: WeleticCustomerPrivacyIdentityKind.customer_email,
      identity: email,
    });
  }
  if (subjects.length === 0) {
    throw new Error("A Shopify customer id or email is required.");
  }

  return subjects.flatMap((subject) =>
    keyring.all.map((key) =>
      deriveCustomerIdentityWithKey({ storeId, ...subject, key }),
    ),
  );
}

function deriveShopIdentityWithKey({
  shopDomain,
  key,
}: {
  shopDomain: string;
  key: ShopifyPrivacyHmacKey;
}): ShopifyShopPrivacyIdentity {
  const canonicalDomain = canonicalizeShopifyDomain(shopDomain);
  if (!canonicalDomain) throw new Error("Shopify shop domain is invalid.");
  return {
    identityKeyId: key.identityKeyId,
    shopDomainDigest: hmacDigest({
      key,
      context: SHOP_IDENTITY_CONTEXT,
      values: [canonicalDomain],
    }),
  };
}

export function deriveShopifyShopPrivacyIdentity({
  shopDomain,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  shopDomain: string;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return deriveShopIdentityWithKey({
    shopDomain,
    key: keyring.current,
  });
}

export function deriveAllShopifyShopPrivacyIdentities({
  shopDomain,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  shopDomain: string;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return keyring.all.map((key) =>
    deriveShopIdentityWithKey({ shopDomain, key }),
  );
}

export async function upsertShopifyCustomerPrivacyTombstones({
  storeId,
  shopifyCustomerId,
  email,
  shopperId,
  accountId,
  redactedAt = new Date(),
  expiresAt = addRetentionDays(
    redactedAt,
    getShopifyCustomerTombstoneRetentionDays(),
  ),
  sourceRequestId,
  tx,
}: {
  storeId: string;
  shopifyCustomerId?: string | number | null;
  email?: string | null;
  shopperId?: string | null;
  accountId?: string | null;
  redactedAt?: Date;
  expiresAt?: Date;
  sourceRequestId?: string | null;
  tx?: Prisma.TransactionClient;
}) {
  const currentKeyring = loadShopifyPrivacyHmacKeyring();
  const currentOnly: ShopifyPrivacyHmacKeyring = {
    current: currentKeyring.current,
    all: [currentKeyring.current],
  };
  const allIdentities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId,
    email,
    keyring: currentKeyring,
  });
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId,
    email,
    keyring: currentOnly,
  });
  const execute = async (client: Prisma.TransactionClient) => {
    const [shopperOwner, accountOwner, sourceRequest] = await Promise.all([
      shopperId
        ? client.weleticShopper.findUnique({
            where: { storeId_id: { storeId, id: shopperId } },
            select: { id: true, storeId: true },
          })
        : null,
      accountId
        ? client.weleticLoyaltyAccount.findUnique({
            where: { storeId_id: { storeId, id: accountId } },
            select: { id: true, storeId: true, shopperId: true },
          })
        : null,
      sourceRequestId
        ? client.weleticShopifyComplianceRequest.findUnique({
            where: { storeId_id: { storeId, id: sourceRequestId } },
            select: { id: true },
          })
        : null,
    ]);
    if (sourceRequestId && !sourceRequest) {
      throw new Error(
        "Shopify customer privacy tombstone source request does not belong to the store.",
      );
    }
    if (shopperId && shopperOwner?.storeId !== storeId) {
      throw new Error(
        "Shopify customer privacy tombstone shopper owner does not belong to the store.",
      );
    }
    if (accountId && accountOwner?.storeId !== storeId) {
      throw new Error(
        "Shopify customer privacy tombstone account owner does not belong to the store.",
      );
    }
    if (
      shopperId &&
      accountId &&
      accountOwner?.shopperId !== shopperOwner?.id
    ) {
      throw new Error(
        "Shopify customer privacy tombstone owners do not identify the same shopper.",
      );
    }

    type LockedCustomerTombstone = {
      id: string;
      identityKind: WeleticCustomerPrivacyIdentityKind;
      identityKeyId: string;
      customerDigest: string;
      shopperId: string | null;
      accountId: string | null;
      sourceRequestId: string | null;
    };
    const identityKey = (identity: {
      identityKind: WeleticCustomerPrivacyIdentityKind;
      identityKeyId: string;
      customerDigest: string;
    }) =>
      `${identity.identityKind}\0${identity.identityKeyId}\0${identity.customerDigest}`;
    const lockedByIdentity = new Map<string, LockedCustomerTombstone>();
    const sortedIdentities = [...allIdentities].sort((left, right) =>
      identityKey(left).localeCompare(identityKey(right)),
    );
    for (const identity of sortedIdentities) {
      const existingRows = await client.$queryRaw<
        LockedCustomerTombstone[]
      >(Prisma.sql`
        SELECT id, identityKind, identityKeyId, customerDigest,
               shopperId, accountId, sourceRequestId
        FROM WeleticShopifyCustomerPrivacyTombstone
        WHERE storeId = ${storeId}
          AND identityKind = ${identity.identityKind}
          AND identityKeyId = ${identity.identityKeyId}
          AND customerDigest = ${identity.customerDigest}
        LIMIT 1
        FOR UPDATE
      `);
      if (existingRows[0]) {
        lockedByIdentity.set(identityKey(identity), existingRows[0]);
      }
    }
    const retainedShopperIds = new Set(
      [...lockedByIdentity.values()]
        .map(({ shopperId: value }) => value)
        .filter((value): value is string => Boolean(value)),
    );
    const retainedAccountIds = new Set(
      [...lockedByIdentity.values()]
        .map(({ accountId: value }) => value)
        .filter((value): value is string => Boolean(value)),
    );
    if (shopperId) retainedShopperIds.add(shopperId);
    if (accountId) retainedAccountIds.add(accountId);
    if (retainedShopperIds.size > 1 || retainedAccountIds.size > 1) {
      throw new ShopifyCustomerPrivacyOwnerConflictError(
        "Shopify customer privacy identity is already bound to another retained owner.",
      );
    }
    const effectiveShopperId = [...retainedShopperIds][0] ?? null;
    const effectiveAccountId = [...retainedAccountIds][0] ?? null;
    if (effectiveShopperId && effectiveAccountId) {
      const effectiveAccount =
        accountOwner?.id === effectiveAccountId
          ? accountOwner
          : await client.weleticLoyaltyAccount.findUnique({
              where: { storeId_id: { storeId, id: effectiveAccountId } },
              select: { id: true, storeId: true, shopperId: true },
            });
      if (effectiveAccount?.shopperId !== effectiveShopperId) {
        throw new ShopifyCustomerPrivacyOwnerConflictError(
          "Shopify customer privacy identity has conflicting retained owner links.",
        );
      }
    }

    const tombstones: WeleticShopifyCustomerPrivacyTombstone[] = [];
    for (const identity of identities) {
      const tombstone =
        await client.weleticShopifyCustomerPrivacyTombstone.upsert({
          where: {
            storeId_identityKind_identityKeyId_customerDigest: {
              storeId,
              ...identity,
            },
          },
          create: {
            id: createWeleticId("wtomb_"),
            storeId,
            ...identity,
            shopperId: effectiveShopperId,
            accountId: effectiveAccountId,
            sourceRequestId: sourceRequestId ?? null,
            redactedAt,
            expiresAt,
          },
          // A row that was absent during SELECT ... FOR UPDATE can be inserted
          // concurrently. Never let the unique-key loser rewrite the winner's
          // retained owner or audit source.
          update: {},
        });
      if (
        (tombstone.shopperId &&
          effectiveShopperId &&
          tombstone.shopperId !== effectiveShopperId) ||
        (tombstone.accountId &&
          effectiveAccountId &&
          tombstone.accountId !== effectiveAccountId)
      ) {
        throw new ShopifyCustomerPrivacyOwnerConflictError(
          "Shopify customer privacy identity is already bound to another retained owner.",
        );
      }
      if (!tombstone.shopperId && effectiveShopperId) {
        await client.weleticShopifyCustomerPrivacyTombstone.updateMany({
          where: { id: tombstone.id, shopperId: null },
          data: { shopperId: effectiveShopperId },
        });
      }
      if (!tombstone.accountId && effectiveAccountId) {
        await client.weleticShopifyCustomerPrivacyTombstone.updateMany({
          where: { id: tombstone.id, accountId: null },
          data: { accountId: effectiveAccountId },
        });
      }
      if (!tombstone.sourceRequestId && sourceRequestId) {
        await client.weleticShopifyCustomerPrivacyTombstone.updateMany({
          where: { id: tombstone.id, sourceRequestId: null },
          data: { sourceRequestId },
        });
      }
      await client.weleticShopifyCustomerPrivacyTombstone.updateMany({
        where: { id: tombstone.id, expiresAt: { lt: expiresAt } },
        data: { redactedAt, expiresAt },
      });
      const persisted =
        await client.weleticShopifyCustomerPrivacyTombstone.findUniqueOrThrow({
          where: { id: tombstone.id },
        });
      if (
        (persisted.shopperId &&
          effectiveShopperId &&
          persisted.shopperId !== effectiveShopperId) ||
        (persisted.accountId &&
          effectiveAccountId &&
          persisted.accountId !== effectiveAccountId)
      ) {
        throw new ShopifyCustomerPrivacyOwnerConflictError(
          "Shopify customer privacy identity is already bound to another retained owner.",
        );
      }
      if (persisted.shopperId && persisted.accountId) {
        const persistedAccount =
          accountOwner?.id === persisted.accountId
            ? accountOwner
            : await client.weleticLoyaltyAccount.findUnique({
                where: {
                  storeId_id: { storeId, id: persisted.accountId },
                },
                select: { id: true, storeId: true, shopperId: true },
              });
        if (persistedAccount?.shopperId !== persisted.shopperId) {
          throw new ShopifyCustomerPrivacyOwnerConflictError(
            "Shopify customer privacy identity has conflicting retained owner links.",
          );
        }
      }
      tombstones.push(persisted);
    }
    return tombstones;
  };
  return tx ? execute(tx) : prisma.$transaction(execute);
}

export async function hasShopifyCustomerPrivacyTombstone({
  storeId,
  shopifyCustomerId,
  email,
  now = new Date(),
  tx,
}: {
  storeId: string;
  shopifyCustomerId?: string | number | null;
  email?: string | null;
  now?: Date;
  tx?: Prisma.TransactionClient;
}) {
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId,
    email,
  });
  const client = tx ?? prisma;
  const tombstone =
    await client.weleticShopifyCustomerPrivacyTombstone.findFirst({
      where: {
        storeId,
        expiresAt: { gt: now },
        OR: identities.map((identity) => identity),
      },
      select: { id: true },
    });
  return Boolean(tombstone);
}

/**
 * Proves that an incoming raw Shopify customer belongs to a retained
 * pseudonymous shopper/account. This is intentionally limited to exact
 * financial settlement and returns only a boolean; it never restores or
 * persists the raw subject.
 */
export async function matchesShopifyCustomerPrivacyTombstoneOwner({
  storeId,
  shopifyCustomerId,
  email,
  shopperId,
  accountId,
  now = new Date(),
  tx,
}: {
  storeId: string;
  shopifyCustomerId?: string | number | null;
  email?: string | null;
  shopperId?: string | null;
  accountId?: string | null;
  now?: Date;
  tx?: Prisma.TransactionClient;
}) {
  const ownerLinks = [
    ...(shopperId ? [{ shopperId }] : []),
    ...(accountId ? [{ accountId }] : []),
  ];
  if (ownerLinks.length === 0) {
    throw new Error(
      "A pseudonymous shopper or loyalty account is required for privacy ownership verification.",
    );
  }
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId,
    email,
  });
  const client = tx ?? prisma;
  const tombstone =
    await client.weleticShopifyCustomerPrivacyTombstone.findFirst({
      where: {
        storeId,
        expiresAt: { gt: now },
        AND: [{ OR: identities }, { OR: ownerLinks }],
      },
      select: { id: true },
    });
  return Boolean(tombstone);
}

export async function upsertShopifyShopPrivacyTombstone({
  storeId,
  shopDomain,
  redactedAt = new Date(),
  expiresAt = addRetentionDays(redactedAt, getShopifyFinancialRetentionDays()),
  sourceRequestId,
  tx,
}: {
  storeId: string;
  shopDomain: string;
  redactedAt?: Date;
  expiresAt?: Date;
  sourceRequestId?: string | null;
  tx?: Prisma.TransactionClient;
}) {
  const identity = deriveShopifyShopPrivacyIdentity({ shopDomain });
  const execute = async (client: Prisma.TransactionClient) => {
    if (sourceRequestId) {
      const sourceRequest =
        await client.weleticShopifyComplianceRequest.findUnique({
          where: { storeId_id: { storeId, id: sourceRequestId } },
          select: { id: true },
        });
      if (!sourceRequest) {
        throw new Error(
          "Shop privacy tombstone source request does not belong to the store.",
        );
      }
    }
    const existingRows = await client.$queryRaw<
      Array<{
        id: string;
        storeId: string;
        sourceRequestId: string | null;
      }>
    >(Prisma.sql`
      SELECT id, storeId, sourceRequestId
      FROM WeleticShopifyShopPrivacyTombstone
      WHERE identityKeyId = ${identity.identityKeyId}
        AND shopDomainDigest = ${identity.shopDomainDigest}
      LIMIT 1
      FOR UPDATE
    `);
    const existing = existingRows[0];
    if (existing && existing.storeId !== storeId) {
      throw new Error(
        "Shop privacy tombstone identity is already bound to another store.",
      );
    }
    const tombstone = await client.weleticShopifyShopPrivacyTombstone.upsert({
      where: {
        identityKeyId_shopDomainDigest: identity,
      },
      create: {
        id: createWeleticId("wtomb_"),
        storeId,
        ...identity,
        sourceRequestId: sourceRequestId ?? null,
        redactedAt,
        expiresAt,
      },
      // Insert-or-no-op is required because an absent row cannot be locked and
      // another transaction may win the unique insert.
      update: {},
    });
    // The digest is globally unique because a raw Shopify domain may identify
    // only one retained store owner at a time. Concurrent cross-store upserts
    // can both observe absence before the unique write; validating the returned
    // owner inside this transaction makes the losing writer roll back instead
    // of rebinding the existing tombstone/source request.
    if (tombstone.storeId !== storeId) {
      throw new Error(
        "Shop privacy tombstone identity is already bound to another store.",
      );
    }
    if (!tombstone.sourceRequestId && sourceRequestId) {
      await client.weleticShopifyShopPrivacyTombstone.updateMany({
        where: { id: tombstone.id, sourceRequestId: null },
        data: { sourceRequestId },
      });
    }
    await client.weleticShopifyShopPrivacyTombstone.updateMany({
      where: { id: tombstone.id, expiresAt: { lt: expiresAt } },
      data: { redactedAt, expiresAt },
    });
    const persisted =
      await client.weleticShopifyShopPrivacyTombstone.findUniqueOrThrow({
        where: { id: tombstone.id },
      });
    if (persisted.storeId !== storeId) {
      throw new Error(
        "Shop privacy tombstone identity has a conflicting retained owner or audit source.",
      );
    }
    return persisted;
  };
  return tx ? execute(tx) : prisma.$transaction(execute);
}
