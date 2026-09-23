import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const deliveryPrivacyIdentitiesSchema = z
  .array(
    z
      .object({
        identityKind: z.enum(["customer_id", "customer_email"]),
        identityKeyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        customerDigest: z.string().regex(/^[A-Fa-f0-9]{64}$/),
      })
      .strict(),
  )
  .min(1)
  .max(50);
export type DeliveryPrivacyIdentities = z.infer<
  typeof deliveryPrivacyIdentitiesSchema
>;

/** Email capacity is shared, but a customer export must not disclose another
 * authenticated customer's messages merely because their mailbox is shared. */
export function deliveryExportWhere(
  storeId: string,
  input: DeliveryPrivacyIdentities,
): Prisma.WeleticShopperDeliveryReservationWhereInput {
  const identities = deliveryPrivacyIdentitiesSchema.parse(input);
  const customer = identities.filter(
    (identity) => identity.identityKind === "customer_id",
  );
  const email = identities.filter(
    (identity) => identity.identityKind === "customer_email",
  );
  return {
    storeId,
    OR: [
      ...(customer.length
        ? [{ identities: { some: { storeId, OR: customer } } }]
        : []),
      ...(email.length
        ? [
            {
              AND: [
                {
                  identities: {
                    none: { identityKind: "customer_id" as const },
                  },
                },
                { identities: { some: { storeId, OR: email } } },
              ],
            },
          ]
        : []),
    ],
  };
}

export const deliveryExportSelect = {
  id: true,
  producer: true,
  provider: true,
  state: true,
  capacityAt: true,
  expiresAt: true,
  attemptedAt: true,
  sentAt: true,
  createdAt: true,
} satisfies Prisma.WeleticShopperDeliveryReservationSelect;

/** Bounded erasure, including orphan aliases. Customer tombstones must already
 * exist; whole-store cleanup requires a frozen/redacted store. Lock order is the
 * same as admission, so cleanup cannot race a newly admitted reservation. */
export async function eraseShopperDeliveryBatch({
  storeId,
  identities: input,
}: {
  storeId: string;
  identities?: DeliveryPrivacyIdentities;
}) {
  const identities =
    input === undefined
      ? undefined
      : deliveryPrivacyIdentitiesSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<
      Array<{ id: string; complianceState: string }>
    >`SELECT id, complianceState FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
    if (!stores.length) throw new Error("Delivery privacy store unavailable");
    if (
      !identities &&
      !["frozen", "redacted"].includes(stores[0].complianceState)
    )
      throw new Error("Delivery privacy purge requires a frozen store");
    if (
      identities &&
      !(await tx.weleticShopifyCustomerPrivacyTombstone.findFirst({
        where: { storeId, OR: identities, expiresAt: { gt: new Date() } },
        select: { id: true },
      }))
    )
      throw new Error("Delivery privacy erasure requires suppression");
    const rows = await tx.weleticShopperDeliveryReservation.findMany({
      where: identities
        ? deliveryExportWhere(storeId, identities)
        : { storeId },
      take: 20,
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const ids = rows.map((row) => row.id);
    if (ids.length) {
      await tx.weleticShopperDeliveryIdentity.deleteMany({
        where: { storeId, reservationId: { in: ids } },
      });
      await tx.weleticShopperDeliveryReservation.deleteMany({
        where: { storeId, id: { in: ids } },
      });
    }
    // Finish owned rows before removing aliases, or later pages could lose
    // their ownership lookup. Foreign authenticated rows keep customer aliases
    // and capacity; only their matching mailbox aliases are erased.
    const aliases =
      rows.length === 20
        ? []
        : await tx.weleticShopperDeliveryIdentity.findMany({
            where: { storeId, ...(identities ? { OR: identities } : {}) },
            take: 20,
            orderBy: { id: "asc" },
            select: { id: true },
          });
    if (aliases.length)
      await tx.weleticShopperDeliveryIdentity.deleteMany({
        where: { storeId, id: { in: aliases.map((row) => row.id) } },
      });
    return {
      hasMore: rows.length === 20 || aliases.length === 20,
      count: rows.length,
    };
  });
}
