import { DubApiError } from "@/lib/api/errors";
import { getPartnerForProgram } from "@/lib/api/partner-profile/get-partner-for-program";
import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { booleanQuerySchema } from "@/lib/zod/schemas/misc";
import {
  EnrolledPartnerCompositeSchema,
  EnrolledPartnerSchemaExtended,
} from "@/lib/zod/schemas/partners";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

const getPartnerQuerySchema = z.object({
  includeComposite: booleanQuerySchema.optional().default(false),
});

// GET /api/partners/:partnerId – Get a partner by ID
export const GET = withWorkspace(
  async ({ workspace, params, searchParams }) => {
    const { partnerId } = params;
    const { includeComposite } = getPartnerQuerySchema.parse(searchParams);
    const programId = getDefaultProgramIdOrThrow(workspace);

    const partner = await getPartnerForProgram({
      programId,
      partnerId,
      includeComposite,
    });

    if (!partner) {
      throw new DubApiError({
        code: "not_found",
        message: "Partner not found.",
      });
    }

    if (includeComposite) {
      return NextResponse.json(EnrolledPartnerCompositeSchema.parse(partner));
    }

    return NextResponse.json(EnrolledPartnerSchemaExtended.parse(partner));
  },
  {
    requiredPlan: ["business", "advanced", "enterprise"],
  },
);
