"use server";

import { recordAuditLog } from "@/lib/api/audit-logs/record-audit-log";
import { metadataCache } from "@/lib/api/metadata-cache";
import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import {
  ALLOWED_MIN_PAYOUT_AMOUNTS,
  getAllowedMinPayoutAmounts,
} from "@/lib/constants/payouts";
import { getPlanCapabilities } from "@/lib/plan-capabilities";
import { prisma } from "@/lib/prisma";
import { submittedLeadFormSchema } from "@/lib/zod/schemas/submitted-lead-form";
import { waitUntil } from "@vercel/functions";
import { revalidatePath } from "next/cache";
import * as z from "zod/v4";
import { getProgramOrThrow } from "../../api/programs/get-program-or-throw";
import { ProgramSchema, updateProgramSchema } from "../../zod/schemas/programs";
import { authActionClient } from "../safe-action";
import { throwIfNoPermission } from "../throw-if-no-permission";

const schema = updateProgramSchema.partial().extend({
  workspaceId: z.string(),
  applyHoldingPeriodDaysToAllGroups: z.boolean().optional(),
  referralFormData: submittedLeadFormSchema.optional(),
});

export const updateProgramAction = authActionClient
  .inputSchema(schema)
  .action(async ({ parsedInput, ctx }) => {
    const { workspace, user } = ctx;
    const {
      supportEmail,
      helpUrl,
      termsUrl,
      minPayoutAmount,
      accountingCurrency,
      messagingEnabledAt,
      referralFormData,
    } = parsedInput;

    throwIfNoPermission({
      role: workspace.role,
      requiredRoles: ["owner", "member"],
    });

    if (
      minPayoutAmount !== undefined &&
      !getAllowedMinPayoutAmounts(workspace.id).includes(minPayoutAmount)
    ) {
      throw new Error(
        `Invalid minimum payout amount: Must be one of ${ALLOWED_MIN_PAYOUT_AMOUNTS.join(", ")}`,
      );
    }

    const programId = getDefaultProgramIdOrThrow(workspace);

    const program = await getProgramOrThrow({
      workspaceId: workspace.id,
      programId,
    });

    if (
      accountingCurrency !== undefined &&
      accountingCurrency !== program.accountingCurrency
    ) {
      const [commissions, payouts, commerceOrders] = await Promise.all([
        prisma.commission.count({ where: { programId } }),
        prisma.payout.count({ where: { programId } }),
        prisma.weleticCommerceOrder.count({ where: { programId } }),
      ]);
      if (commissions + payouts + commerceOrders > 0) {
        throw new Error(
          "Accounting currency cannot be changed after financial activity exists.",
        );
      }
    }

    const updatedProgram = await prisma.program.update({
      where: {
        id: programId,
      },
      data: {
        supportEmail,
        helpUrl,
        termsUrl,
        minPayoutAmount,
        accountingCurrency,
        ...(messagingEnabledAt !== undefined &&
          (getPlanCapabilities(workspace.plan).canMessagePartners ||
            messagingEnabledAt === null) && { messagingEnabledAt }),
        ...(referralFormData !== undefined && {
          referralFormData: referralFormData ?? null,
        }),
      },
    });

    if (updatedProgram.termsUrl !== program.termsUrl) {
      revalidatePath(`/partners.dub.co/${program.slug}/apply`);
    }

    waitUntil(
      recordAuditLog({
        workspaceId: workspace.id,
        programId: program.id,
        action: "program.updated",
        description: `Program ${program.name} updated`,
        actor: user,
        targets: [
          {
            type: "program",
            id: program.id,
            metadata: updatedProgram,
          },
        ],
      }),
    );

    await metadataCache.invalidateProgram(programId, workspace.id);

    return {
      success: true,
      program: ProgramSchema.parse(updatedProgram),
    };
  });
