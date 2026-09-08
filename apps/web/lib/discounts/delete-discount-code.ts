import { prisma } from "@/lib/prisma";
import { APP_DOMAIN_WITH_NGROK, chunk } from "@dub/utils";
import { Discount, DiscountCode } from "@prisma/client";
import { enqueueBatchJobs } from "../cron/enqueue-batch-jobs";

type DeleteDiscountCodesParams = Pick<
  DiscountCode,
  "id" | "code" | "programId"
> & {
  discount: Pick<Discount, "provider"> | null;
};

type EnqueueDeleteDiscountCodeParams = Pick<
  DiscountCode,
  "code" | "programId"
> & {
  discount: Pick<Discount, "provider"> | null;
};

// Triggered in the following cases:
// 1. When a discount is deleted
// 2. When a link is deleted that has a discount code associated with it
// 3. When partners are banned / deactivated
// 4. When a partner is moved to a different group
export async function deleteDiscountCodes(
  input: (DeleteDiscountCodesParams | null | undefined)[],
  { isSoftDelete = true }: { isSoftDelete?: boolean } = {},
) {
  const discountCodes = input.filter(
    (dc): dc is NonNullable<typeof dc> => dc != null,
  );

  if (discountCodes.length === 0) {
    console.log(
      "[deleteDiscountCodes] No discount codes to delete. Skipping...",
    );
    return;
  }

  if (isSoftDelete) {
    // Soft delete the discount codes from the database (mark them as disabled)
    const disabledDiscountCodes = await prisma.discountCode.updateMany({
      where: {
        id: {
          in: discountCodes.map(({ id }) => id),
        },
      },
      data: {
        disabledAt: new Date(),
      },
    });

    console.log(
      `[deleteDiscountCodes] Disabled ${disabledDiscountCodes.count} discount codes.`,
    );
  } else {
    // Delete the discount codes from the database
    const deletedDiscountCodes = await prisma.discountCode.deleteMany({
      where: {
        id: {
          in: discountCodes.map(({ id }) => id),
        },
      },
    });

    console.log(
      `[deleteDiscountCodes] Deleted ${deletedDiscountCodes.count} discount codes.`,
    );
  }

  await enqueueDeleteDiscountCode(discountCodes);
}

import { isNonRecoverableDiscountError } from "./discount-error";
import { getDiscountProvider } from "./discount-provider";

// Only enqueue external-provider cleanup for codes whose provider is known.
// Orphaned codes (discount relation is null) still get deleted locally above
// but we can't tell which external provider to clean up, so we skip them.
export async function enqueueDeleteDiscountCode(
  discountCodes: EnqueueDeleteDiscountCodeParams[],
) {
  const codesWithProvider = discountCodes.filter(
    (dc): dc is typeof dc & { discount: Pick<Discount, "provider"> } =>
      dc.discount != null,
  );

  if (codesWithProvider.length === 0) {
    return;
  }

  // If QStash is not configured or in development mode, execute direct cleanup immediately
  if (!process.env.QSTASH_TOKEN || process.env.NODE_ENV === "development") {
    for (const discountCode of codesWithProvider) {
      try {
        const workspace = await prisma.project.findUnique({
          where: {
            defaultProgramId: discountCode.programId,
          },
          select: {
            id: true,
            stripeConnectId: true,
            shopifyStoreId: true,
          },
        });

        if (workspace) {
          const discountProvider = getDiscountProvider(
            discountCode.discount.provider,
          );
          await discountProvider.disableDiscountCode({
            workspace,
            code: discountCode.code,
          });
        }
      } catch (error) {
        if (!isNonRecoverableDiscountError(error)) {
          console.warn(
            `[Direct disableDiscountCode failed for ${discountCode.code}]:`,
            error,
          );
        }
      }
    }
    return;
  }

  // Queue the job to remove the discount codes from provider
  const chunks = chunk(codesWithProvider, 100);

  for (const chunkOfCodes of chunks) {
    try {
      await enqueueBatchJobs(
        chunkOfCodes.map((discountCode) => ({
          url: `${APP_DOMAIN_WITH_NGROK}/api/cron/discount-codes/disable`,
          method: "POST",
          queueName: "delete-discount-code",
          body: {
            code: discountCode.code,
            programId: discountCode.programId,
            provider: discountCode.discount.provider,
          },
        })),
      );
    } catch (err) {
      // Fallback to direct execution if enqueue fails
      for (const discountCode of chunkOfCodes) {
        try {
          const workspace = await prisma.project.findUnique({
            where: {
              defaultProgramId: discountCode.programId,
            },
            select: {
              id: true,
              stripeConnectId: true,
              shopifyStoreId: true,
            },
          });

          if (workspace) {
            const discountProvider = getDiscountProvider(
              discountCode.discount.provider,
            );
            await discountProvider.disableDiscountCode({
              workspace,
              code: discountCode.code,
            });
          }
        } catch (error) {
          if (!isNonRecoverableDiscountError(error)) {
            console.warn(
              `[Fallback disableDiscountCode failed for ${discountCode.code}]:`,
              error,
            );
          }
        }
      }
    }
  }
}
