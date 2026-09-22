import { prisma } from "@/lib/prisma";
import {
  readComplianceReviewCheckpoint,
  storeEncryptedComplianceArtifact,
  type ComplianceArtifactLease,
} from "@/lib/weletic/shopify/compliance-artifacts";
import { z } from "zod";
import {
  deliveryExportSelect,
  deliveryExportWhere,
  deliveryPrivacyIdentitiesSchema,
  type DeliveryPrivacyIdentities,
} from "./delivery-privacy";
import { shopperDeliveryContentDigest } from "./delivery-reservations";

const PAGE_SIZE = 20;
const checkpointSchema = z
  .object({
    format: z.literal("shopper_delivery_rows_v1"),
    kind: z.literal("shopper_delivery"),
    sequence: z.number().int().nonnegative().safe(),
    afterId: z.string().min(1).max(191).nullable(),
    identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    hasMore: z.boolean(),
    rows: z
      .array(z.object({ id: z.string().min(1).max(191) }).passthrough())
      .min(1)
      .max(PAGE_SIZE),
  })
  .strict();

/** Cursor and count come from the immutable winning artifact, never a refetched
 * live page after an ambiguous publication. Not a point-in-time store snapshot.
 */
export async function exportShopperDeliveryPage(input: {
  requestId: string;
  storeId: string;
  identities: DeliveryPrivacyIdentities;
  kind: "shopper_delivery";
  sequence: number;
  afterId: string | null;
  expiresAt: Date;
  lease: ComplianceArtifactLease;
}) {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    input.sequence >= 2147483647
  )
    throw new Error("Shopper delivery export sequence invalid");
  const identities = deliveryPrivacyIdentitiesSchema.parse(input.identities);
  const identityDigest = shopperDeliveryContentDigest(identities);
  function recover(value: unknown) {
    const result = checkpointSchema.safeParse(value);
    if (
      !result.success ||
      result.data.kind !== input.kind ||
      result.data.sequence !== input.sequence ||
      result.data.afterId !== input.afterId ||
      result.data.identityDigest !== identityDigest
    )
      throw new Error("Shopper delivery export checkpoint invalid");
    const page = result.data;
    const ids = page.rows.map(({ id }) => id);
    if (new Set(ids).size !== ids.length || ids.includes(input.afterId ?? ""))
      throw new Error("Shopper delivery export checkpoint does not advance");
    return {
      lastId: page.rows[page.rows.length - 1].id,
      count: page.rows.length,
      hasMore: page.hasMore,
    };
  }
  const existing = await readComplianceReviewCheckpoint(input);
  if (existing !== null) return recover(existing);
  const page = {
    where: {
      ...deliveryExportWhere(input.storeId, identities),
      ...(input.afterId ? { id: { gt: input.afterId } } : {}),
    },
    orderBy: { id: "asc" as const },
    take: PAGE_SIZE + 1,
  };
  const rows = await prisma.weleticShopperDeliveryReservation.findMany({
    ...page,
    select: deliveryExportSelect,
  });
  if (!rows.length) return { lastId: null, count: 0, hasMore: false };
  await storeEncryptedComplianceArtifact({
    ...input,
    value: {
      format: "shopper_delivery_rows_v1",
      kind: input.kind,
      sequence: input.sequence,
      afterId: input.afterId,
      identityDigest,
      hasMore: rows.length > PAGE_SIZE,
      rows: rows.slice(0, PAGE_SIZE),
    },
  });
  const winner = await readComplianceReviewCheckpoint(input);
  if (winner === null)
    throw new Error("Shopper delivery export publication unresolved");
  return recover(winner);
}
