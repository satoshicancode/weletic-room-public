import { metadataCache } from "@/lib/api/metadata-cache";
import { prisma } from "@/lib/prisma";
import { RewardSchema } from "@/lib/zod/schemas/rewards";
import * as z from "zod/v4";
import { DubApiError } from "../errors";

export async function getRewardOrThrow({
  rewardId,
  programId,
}: {
  rewardId: string;
  programId: string;
}): Promise<z.infer<typeof RewardSchema>> {
  const cached = await metadataCache.getReward<z.infer<typeof RewardSchema>>(
    programId,
    rewardId,
  );
  if (cached) {
    return cached;
  }

  const reward = await prisma.reward.findUnique({
    where: {
      id: rewardId,
    },
  });

  if (!reward) {
    throw new DubApiError({
      code: "not_found",
      message: "Reward not found.",
    });
  }

  if (reward.programId !== programId) {
    throw new DubApiError({
      code: "not_found",
      message: "Reward does not belong to the program.",
    });
  }

  const result = RewardSchema.parse(reward);
  await metadataCache.setReward(programId, rewardId, result);
  return result;
}
