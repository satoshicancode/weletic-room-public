import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { deriveAllShopifyCustomerPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  type WeleticShopperDeliveryIdentity,
  type WeleticShopperDeliveryReservation,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  evaluateShopperDelivery,
  SHOPPER_DELIVERY_WINDOW_MS,
} from "./delivery-policy";

const identitySchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    producer: z.enum([
      "loyalty_communication",
      "points_expiry",
      "referral_confirmation",
      "review_invitation",
      "review_reminder",
      "store_review_invitation",
    ]),
    sourceKey: z.string().min(1).max(256),
    provider: z.enum(["resend", "smtp"]),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    email: z.string().email().max(320),
    shopifyCustomerId: z.string().min(1).max(191).nullable(),
    expiresAt: z.date().nullable(),
    retryUntil: z.date(),
  })
  .strict();
export type ShopperDeliveryIdentity = z.infer<typeof identitySchema>;

export class ShopperDeliveryDeferredError extends Error {
  constructor(
    readonly retryAt: Date,
    readonly reason: string,
  ) {
    super("Shopper delivery deferred by shared policy");
    this.name = "ShopperDeliveryDeferredError";
  }
}
export class ShopperDeliveryReconciliationRequiredError extends Error {
  constructor() {
    super("Shopper delivery requires reconciliation");
    this.name = "ShopperDeliveryReconciliationRequiredError";
  }
}
export class ShopperDeliveryIneligibleError extends Error {
  constructor() {
    super("Shopper delivery is no longer eligible");
    this.name = "ShopperDeliveryIneligibleError";
  }
}

export class ShopperDeliveryAlreadySentError extends Error {
  constructor() {
    super("Shopper delivery was already acknowledged");
  }
}

export function isShopperDeliveryError(error: unknown) {
  return (
    error instanceof ShopperDeliveryDeferredError ||
    error instanceof ShopperDeliveryReconciliationRequiredError ||
    error instanceof ShopperDeliveryIneligibleError ||
    error instanceof ShopperDeliveryAlreadySentError
  );
}

/** Stable across JSON object key ordering; callers hash immutable provider bytes. */
export function shopperDeliveryContentDigest(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function shopperDeliveryReservationId(
  input: Pick<
    ShopperDeliveryIdentity,
    "storeId" | "installationGeneration" | "producer" | "sourceKey"
  >,
) {
  return shopperDeliveryContentDigest([
    "shopper_delivery_v1",
    input.storeId,
    input.installationGeneration,
    input.producer,
    input.sourceKey,
  ]);
}

type PrivacyIdentity = ReturnType<
  typeof deriveAllShopifyCustomerPrivacyIdentities
>[number];
function matches(saved: PrivacyIdentity, current: PrivacyIdentity) {
  return (
    current.identityKind === saved.identityKind &&
    current.identityKeyId === saved.identityKeyId &&
    current.customerDigest === saved.customerDigest
  );
}

/** Caller must retain its exact source lease, immutable request and consent
 * checks in this transaction. This function owns capacity, not source authority.
 * Store row locking serializes email/customer overlap even for first-use aliases.
 * Commit immediately before provider I/O. A crash after this commit consumes
 * capacity conservatively, even if transport never started. */
export async function admitShopperDeliveryInTransaction({
  tx,
  input,
  now: suppliedNow,
  priorAttempt = false,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  input: ShopperDeliveryIdentity;
  now?: Date;
  priorAttempt?: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const value = identitySchema.parse(input);
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId: value.storeId,
    expectedInstallationGeneration: value.installationGeneration,
    action: "shopper_delivery_admission",
    loyaltyMaintenancePermit,
  });
  // Sample after lock acquisition; waiting must not borrow an earlier window.
  const now = suppliedNow ?? new Date();
  if (!Number.isFinite(now.getTime()))
    throw new ShopperDeliveryIneligibleError();
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId: value.storeId,
    email: value.email,
    shopifyCustomerId: value.shopifyCustomerId,
  });
  const id = shopperDeliveryReservationId(value);
  const identityPredicate = (values: typeof identities) =>
    Prisma.join(
      values.map(
        (identity) =>
          Prisma.sql`(identityKind = ${identity.identityKind} AND identityKeyId = ${identity.identityKeyId} AND customerDigest = ${identity.customerDigest})`,
      ),
      " OR ",
    );
  // Current reads are necessary even if a caller established a repeatable-read
  // snapshot before taking the store lock. Plain ORM reads could miss a winner.
  const suppressed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyCustomerPrivacyTombstone
    WHERE storeId = ${value.storeId} AND expiresAt > ${now} AND (${identityPredicate(identities)})
    LIMIT 1 FOR UPDATE
  `);
  if (suppressed.length) throw new ShopperDeliveryIneligibleError();
  const retained = await tx.$queryRaw<WeleticShopperDeliveryReservation[]>`
    SELECT * FROM WeleticShopperDeliveryReservation WHERE id = ${id} FOR UPDATE
  `;
  const existing = retained[0]
    ? {
        ...retained[0],
        identities: await tx.$queryRaw<WeleticShopperDeliveryIdentity[]>`
    SELECT * FROM WeleticShopperDeliveryIdentity WHERE storeId = ${value.storeId} AND reservationId = ${id} FOR UPDATE
  `,
      }
    : undefined;
  if (existing) {
    if (
      existing.storeId !== value.storeId ||
      existing.installationGeneration !== value.installationGeneration ||
      existing.provider !== value.provider ||
      existing.contentDigest !== value.contentDigest ||
      existing.retryUntil.getTime() !== value.retryUntil.getTime() ||
      (existing.expiresAt?.getTime() ?? null) !==
        (value.expiresAt?.getTime() ?? null)
    )
      throw new ShopperDeliveryReconciliationRequiredError();
    // Both retained kinds must match. An email match cannot reassign a source
    // originally owned by a different authenticated customer.
    for (const kind of new Set(
      existing.identities.map((identity) => identity.identityKind),
    )) {
      if (
        !existing.identities.some(
          (saved) =>
            saved.identityKind === kind &&
            identities.some((current) => matches(saved, current)),
        )
      )
        throw new ShopperDeliveryReconciliationRequiredError();
    }
    const retainedKinds = new Set(
      existing.identities.map((identity) => identity.identityKind),
    );
    const currentKinds = new Set(
      identities.map((identity) => identity.identityKind),
    );
    if (
      retainedKinds.size !== currentKinds.size ||
      [...currentKinds].some((kind) => !retainedKinds.has(kind))
    )
      throw new ShopperDeliveryReconciliationRequiredError();
    if (!existing.identities.length)
      throw new ShopperDeliveryReconciliationRequiredError();
    if (existing.state === "sent") return { id, status: "sent" as const };
    if (
      existing.attemptedAt &&
      (value.provider === "smtp" || now < existing.attemptedAt)
    )
      throw new ShopperDeliveryReconciliationRequiredError();
  } else if (priorAttempt) {
    // Never manufacture capacity evidence for a legacy/uncertain transport.
    throw new ShopperDeliveryReconciliationRequiredError();
  }
  if (
    !existing &&
    value.retryUntil.getTime() > now.getTime() + 23 * 60 * 60_000
  )
    throw new ShopperDeliveryReconciliationRequiredError();
  if (now >= value.retryUntil)
    throw new ShopperDeliveryReconciliationRequiredError();
  if (value.expiresAt && now >= value.expiresAt)
    throw new ShopperDeliveryIneligibleError();
  const settingsRows = await tx.$queryRaw<
    Array<{
      shopperEmailPaused: boolean | number;
      timeZone: string | null;
      shopperDeliveryPolicy: Prisma.JsonValue | null;
    }>
  >`
    SELECT shopperEmailPaused, timeZone, shopperDeliveryPolicy FROM WeleticMerchantSettings
    WHERE storeId = ${value.storeId} FOR UPDATE
  `;
  const settings = settingsRows[0];
  let deferred: ShopperDeliveryDeferredError | undefined;
  // Enforce the email and customer budgets separately. Joining all aliases in
  // a single summed counter would overcount distinct overlapping audiences.
  for (const kind of new Set(
    identities.map((identity) => identity.identityKind),
  )) {
    const counted =
      settings?.shopperDeliveryPolicy == null
        ? []
        : await tx.$queryRaw<Array<{ capacityAt: Date }>>(Prisma.sql`
      SELECT r.capacityAt FROM WeleticShopperDeliveryReservation r
      WHERE r.storeId = ${value.storeId} AND r.id <> ${id}
        AND r.capacityAt > ${new Date(now.getTime() - SHOPPER_DELIVERY_WINDOW_MS)}
        AND EXISTS (SELECT 1 FROM WeleticShopperDeliveryIdentity i
          WHERE i.storeId = r.storeId AND i.reservationId = r.id
            AND (${identityPredicate(identities.filter((identity) => identity.identityKind === kind))}) FOR UPDATE)
      ORDER BY r.capacityAt DESC, r.id DESC LIMIT 100 FOR UPDATE
    `);
    const decision = evaluateShopperDelivery({
      policy: settings?.shopperDeliveryPolicy ?? null,
      timeZone: settings?.timeZone ?? null,
      paused: Boolean(settings?.shopperEmailPaused),
      now,
      expiresAt: value.expiresAt,
      countedReservationTimes: counted.map((row) => row.capacityAt),
    });
    if (decision.status === "expired")
      throw new ShopperDeliveryIneligibleError();
    if (decision.status !== "eligible") {
      const retryAt =
        decision.status === "deferred"
          ? new Date(
              Math.min(
                decision.retryAt.getTime(),
                value.retryUntil.getTime(),
                value.expiresAt?.getTime() ?? Infinity,
              ),
            )
          : new Date(
              Math.min(
                now.getTime() + 5 * 60_000,
                value.expiresAt?.getTime() ?? Infinity,
                value.retryUntil.getTime(),
              ),
            );
      const error = new ShopperDeliveryDeferredError(
        retryAt,
        decision.status === "deferred" ? "policy_window" : decision.reason,
      );
      if (!deferred || error.retryAt > deferred.retryAt) deferred = error;
    }
  }
  if (deferred) throw deferred;
  if (!existing) {
    await tx.weleticShopperDeliveryReservation.create({
      data: {
        id,
        storeId: value.storeId,
        installationGeneration: value.installationGeneration,
        producer: value.producer,
        provider: value.provider,
        contentDigest: value.contentDigest,
        state: "attempted",
        capacityAt: now,
        attemptedAt: now,
        retryUntil: value.retryUntil,
        expiresAt: value.expiresAt,
        identities: {
          create: identities.map((identity) => ({
            ...identity,
            id: shopperDeliveryContentDigest([
              id,
              identity.identityKind,
              identity.identityKeyId,
            ]),
          })),
        },
      },
    });
  } else {
    // Add current aliases during rotation without changing the original slot.
    await tx.weleticShopperDeliveryIdentity.createMany({
      data: identities.map((identity) => ({
        ...identity,
        storeId: value.storeId,
        reservationId: id,
        id: shopperDeliveryContentDigest([
          id,
          identity.identityKind,
          identity.identityKeyId,
        ]),
      })),
      skipDuplicates: true,
    });
  }
  return { id, status: "admitted" as const };
}

/** Acknowledgment records an observation, never recreates a deleted reservation. */
export async function confirmShopperDeliveryInTransaction(
  tx: Prisma.TransactionClient,
  input: Pick<
    ShopperDeliveryIdentity,
    | "storeId"
    | "installationGeneration"
    | "producer"
    | "sourceKey"
    | "contentDigest"
  >,
  now = new Date(),
) {
  return tx.weleticShopperDeliveryReservation.updateMany({
    where: {
      id: shopperDeliveryReservationId(input),
      storeId: input.storeId,
      installationGeneration: input.installationGeneration,
      contentDigest: input.contentDigest,
      state: "attempted",
    },
    data: { state: "sent", sentAt: now },
  });
}
