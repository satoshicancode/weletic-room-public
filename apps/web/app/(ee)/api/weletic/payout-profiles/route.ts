import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const GET = withWorkspace(
  async ({ workspace }) => {
    const programId = getDefaultProgramIdOrThrow(workspace);
    const profiles = await prisma.weleticPayoutProfile.findMany({
      where: { programId },
      include: {
        partner: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ status: "desc" }, { updatedAt: "desc" }],
      take: 250,
    });
    return NextResponse.json(
      profiles.map(({ providerAccountRef, ...profile }) => ({
        ...profile,
        providerAccountConfigured: Boolean(providerAccountRef),
      })),
    );
  },
  { requiredRoles: ["owner"] },
);
