import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const GET = withWorkspace(
  async ({ workspace }) => {
    const programId = getDefaultProgramIdOrThrow(workspace);
    const profiles = await prisma.weleticPayoutProfile.findMany({
      where: { programId },
      orderBy: [{ status: "desc" }, { updatedAt: "desc" }],
      take: 250,
    });
    const partnerIds = Array.from(new Set(profiles.map((p) => p.partnerId)));
    const partners =
      partnerIds.length && typeof prisma?.partner?.findMany === "function"
        ? await prisma.partner.findMany({
            where: { id: { in: partnerIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
    const partnerMap = new Map(partners.map((p) => [p.id, p]));

    return NextResponse.json(
      profiles.map(({ providerAccountRef, ...profile }) => ({
        ...profile,
        partner: partnerMap.get(profile.partnerId) || null,
        providerAccountConfigured: Boolean(providerAccountRef),
      })),
    );
  },
  { requiredRoles: ["owner"] },
);
