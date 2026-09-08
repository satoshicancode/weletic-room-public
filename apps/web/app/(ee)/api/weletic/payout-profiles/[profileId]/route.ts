import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { refreshWeleticOpenPayoutQuotes } from "@/lib/weletic/payouts/create-quote";
import { assertPayoutProviderCompatibility } from "@/lib/weletic/payouts/providers";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

const reviewPayoutProfileSchema = z.object({
  status: z.enum(["verified", "disabled"]),
  notes: z.string().trim().max(2_000).nullish(),
});

export const PATCH = withWorkspace(
  async ({ workspace, params, req, session }) => {
    const programId = getDefaultProgramIdOrThrow(workspace);
    const input = reviewPayoutProfileSchema.parse(await parseRequestBody(req));
    const profile = await prisma.weleticPayoutProfile.findFirstOrThrow({
      where: {
        id: params.profileId,
        programId,
      },
    });

    if (input.status === "verified") {
      const configuration = assertPayoutProviderCompatibility({
        provider: profile.provider as Parameters<
          typeof assertPayoutProviderCompatibility
        >[0]["provider"],
        method: profile.method as Parameters<
          typeof assertPayoutProviderCompatibility
        >[0]["method"],
        payoutCurrency: profile.payoutCurrency,
        providerAccountRef: profile.providerAccountRef,
      });
      if (!configuration.automaticSettlement && !input.notes?.trim()) {
        throw new Error(
          "Manual and bank-transfer profiles require verification notes.",
        );
      }
      const details =
        profile.details &&
        typeof profile.details === "object" &&
        !Array.isArray(profile.details)
          ? profile.details
          : null;
      if (
        profile.provider === "bank_transfer" &&
        (!details ||
          !("accountLast4" in details) ||
          typeof details.accountLast4 !== "string" ||
          !/^\d{4}$/.test(details.accountLast4))
      ) {
        throw new Error(
          "Bank-transfer profiles require the destination account's last four digits.",
        );
      }
    }

    const updated = await prisma.weleticPayoutProfile.update({
      where: { id: profile.id },
      data: {
        status: input.status,
        verifiedAt: input.status === "verified" ? new Date() : null,
        verifiedByUserId: session.user.id,
        verificationNotes: input.notes,
      },
    });
    await refreshWeleticOpenPayoutQuotes({
      partnerId: profile.partnerId,
      programId,
      payoutProvider:
        input.status === "verified" ? profile.provider : undefined,
    });
    const { providerAccountRef, ...safeProfile } = updated;
    return NextResponse.json({
      ...safeProfile,
      providerAccountConfigured: Boolean(providerAccountRef),
    });
  },
  { requiredRoles: ["owner"] },
);
