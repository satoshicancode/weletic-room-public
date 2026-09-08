"use server";

import { recordAuditLog } from "@/lib/api/audit-logs/record-audit-log";
import { metadataCache } from "@/lib/api/metadata-cache";
import { getDiscountOrThrow } from "@/lib/api/partners/get-discount-or-throw";
import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { qstash } from "@/lib/cron";
import { deleteDiscountCodes } from "@/lib/discounts/delete-discount-code";
import { prisma } from "@/lib/prisma";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { waitUntil } from "@vercel/functions";
import * as z from "zod/v4";
import { authActionClient } from "../safe-action";
import { throwIfNoPermission } from "../throw-if-no-permission";

const deleteDiscountSchema = z.object({
  workspaceId: z.string(),
  discountId: z.string(),
});

export const deleteDiscountAction = authActionClient
  .inputSchema(deleteDiscountSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workspace, user } = ctx;
    const { discountId } = parsedInput;

    throwIfNoPermission({
      role: workspace.role,
      requiredRoles: ["owner", "member"],
    });

    const programId = getDefaultProgramIdOrThrow(workspace);

    const existingDiscount = await prisma.discount.findUnique({
      where: {
        id: discountId,
      },
    });

    if (!existingDiscount) {
      // Idempotently clean up any lingering references
      await prisma.partnerGroup.updateMany({
        where: { discountId },
        data: { discountId: null },
      });
      await prisma.programEnrollment.updateMany({
        where: { discountId },
        data: { discountId: null },
      });
      await prisma.discountCode.updateMany({
        where: { discountId },
        data: { discountId: null },
      });
      return { success: true };
    }

    const discount = await getDiscountOrThrow({
      programId,
      discountId,
    });

    // Cache discount codes to delete them later
    const discountCodes = await prisma.discountCode.findMany({
      where: {
        discountId: discount.id,
      },
      select: {
        id: true,
        code: true,
        programId: true,
        discount: {
          select: {
            provider: true,
          },
        },
      },
    });

    const group = await prisma.$transaction(async (tx) => {
      const group = await tx.partnerGroup.update({
        where: {
          discountId: discount.id,
        },
        data: {
          discountId: null,
        },
      });

      await tx.programEnrollment.updateMany({
        where: {
          discountId: discount.id,
        },
        data: {
          discountId: null,
        },
      });

      await tx.discountCode.updateMany({
        where: {
          discountId: discount.id,
        },
        data: {
          discountId: null,
        },
      });

      await tx.discount.delete({
        where: {
          id: discount.id,
        },
      });

      return group;
    });

    waitUntil(
      Promise.allSettled([
        qstash.publishJSON({
          url: `${APP_DOMAIN_WITH_NGROK}/api/cron/links/invalidate-for-discounts`,
          body: {
            groupId: group.id,
          },
        }),

        deleteDiscountCodes(discountCodes),

        recordAuditLog({
          workspaceId: workspace.id,
          programId,
          action: "discount.deleted",
          description: `Discount ${discountId} deleted`,
          actor: user,
          targets: [
            {
              type: "discount",
              id: discountId,
              metadata: discount,
            },
          ],
        }),
      ]),
    );

    await Promise.all([
      metadataCache.invalidateGroup(programId, group.id, group.slug),
      metadataCache.invalidateProgram(programId, workspace.id),
    ]);
  });
