import { z } from "zod";
import { ReviewError } from "./contracts";
import {
  reviewIncentiveDisclosure,
  type ReviewDisclosure,
} from "./incentive-disclosure";
import { readReviewIncentivePolicySnapshot } from "./incentive-policy";
import { assertReviewPurchaseNotSuppressed } from "./purchase";
import {
  assertStoreReviewPurchase,
  assertStoreReviewRequestLineBindings,
  storeReviewRequestInclude,
} from "./store-purchase";
import { withReviewMutation } from "./transaction";

export const storeAccountInvitationQuerySchema = z
  .object({
    limit: z
      .union([
        z
          .string()
          .regex(/^(?:[1-9]|1[0-9]|20)$/)
          .transform(Number),
        z.number().int().min(1).max(20),
      ])
      .optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,191}$/)
      .optional(),
  })
  .strict();

type AccountInvitation = {
  requestId: string;
  orderExternalId: string;
  fulfilledAt: string;
  expiresAt: string;
  incentiveDisclosure: ReviewDisclosure | null;
};

/** A customer-account read, never a send authorization. The gateway supplies
 * shopper identity from Shopify's verified session, not from query parameters.
 */
export function listStoreAccountInvitations({
  storeId,
  shopperId,
  expectedInstallationGeneration,
  query,
}: {
  storeId: string;
  shopperId: string;
  expectedInstallationGeneration: string;
  query: unknown;
}) {
  const { limit = 10, cursor } = storeAccountInvitationQuerySchema.parse(query);
  return withReviewMutation(
    storeId,
    async (tx, generation) => {
      if (!generation || generation !== expectedInstallationGeneration)
        throw new ReviewError("conflict", "Installation changed");
      const [parent, settings, shopper] = await Promise.all([
        tx.weleticReviewSettings.findUnique({ where: { storeId } }),
        tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
        tx.weleticShopper.findFirst({
          where: { id: shopperId, storeId },
          include: { privacyTombstones: { select: { id: true } } },
        }),
      ]);
      if (!parent?.enabled || !settings?.enabled)
        throw new ReviewError("disabled", "Store reviews unavailable");
      if (!shopper || shopper.privacyTombstones.length)
        throw new ReviewError("not_found", "Review invitations unavailable");
      await assertReviewPurchaseNotSuppressed(tx, { storeId, shopper });
      const now = new Date();
      const anchor = cursor
        ? await tx.weleticStoreReviewRequest.findFirst({
            where: {
              id: cursor,
              storeId,
              shopperId,
              installationGeneration: generation,
            },
            select: { createdAt: true, id: true },
          })
        : null;
      if (cursor && !anchor)
        throw new ReviewError("bad_request", "Invalid invitation cursor");
      const requests = await tx.weleticStoreReviewRequest.findMany({
        where: {
          storeId,
          shopperId,
          installationGeneration: generation,
          status: "sent",
          expiresAt: { gt: now },
          ...(anchor
            ? {
                OR: [
                  { createdAt: { lt: anchor.createdAt } },
                  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        include: storeReviewRequestInclude,
      });
      const page = requests.slice(0, limit);
      const items: AccountInvitation[] = [];
      for (const request of page) {
        try {
          assertStoreReviewRequestLineBindings(request);
          assertStoreReviewPurchase(request, generation);
        } catch (error) {
          if (error instanceof ReviewError) continue;
          throw error;
        }
        if (
          await tx.weleticReviewOrderCancellation.findUnique({
            where: {
              storeId_orderExternalId: {
                storeId,
                orderExternalId: request.order.externalId,
              },
            },
          })
        )
          continue;
        const policy = await readReviewIncentivePolicySnapshot(
          tx,
          storeId,
          request.incentivePolicyId,
        );
        items.push({
          requestId: request.id,
          orderExternalId: request.order.externalId,
          fulfilledAt: request.fulfilledAt.toISOString(),
          expiresAt: request.expiresAt.toISOString(),
          incentiveDisclosure: reviewIncentiveDisclosure(policy),
        });
      }
      return {
        items,
        nextCursor: requests.length > limit ? page.at(-1)!.id : null,
      };
    },
    expectedInstallationGeneration,
  );
}
