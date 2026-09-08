import { metadataCache } from "@/lib/api/metadata-cache";
import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { RewardSchema } from "@/lib/zod/schemas/rewards";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

// GET /api/rewards - get all rewards for a program
export const GET = withWorkspace(async ({ workspace }) => {
  const programId = getDefaultProgramIdOrThrow(workspace);

  const cached = await metadataCache.getProgramRewards(programId);
  if (cached) {
    return NextResponse.json(cached);
  }

  const rewards = await prisma.reward.findMany({
    where: {
      programId,
    },
    orderBy: [
      {
        event: "desc",
      },
      {
        createdAt: "desc",
      },
    ],
  });

  const parsed = z.array(RewardSchema).parse(rewards);
  await metadataCache.setProgramRewards(programId, parsed);

  return NextResponse.json(parsed);
});
