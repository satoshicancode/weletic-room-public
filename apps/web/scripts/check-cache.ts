import { getGroupOrThrow } from "../lib/api/groups/get-group-or-throw";
import { metadataCache } from "../lib/api/metadata-cache";
import { prisma } from "../lib/prisma";

async function check() {
  const programId = "prog_1M00F0KG216FY10PWQ5NN4ZSQ";
  const groupInDb = await prisma.partnerGroup.findUnique({
    where: {
      programId_slug: {
        programId,
        slug: "default",
      },
    },
    include: {
      saleReward: true,
      leadReward: true,
      clickReward: true,
      referralReward: true,
    },
  });
  console.log("=== DB STATE ===");
  console.log("DB group:", {
    id: groupInDb?.id,
    saleRewardId: groupInDb?.saleRewardId,
    saleReward: groupInDb?.saleReward,
  });

  console.log("\n=== REDIS CACHE STATE ===");
  const keys = ["default", "0:0", "1:0", "0:1", "1:1"];
  for (const opt of keys) {
    const cachedBySlug = await metadataCache.getGroup(
      programId,
      "default",
      opt,
    );
    const cachedById = groupInDb?.id
      ? await metadataCache.getGroup(programId, groupInDb.id, opt)
      : null;
    console.log(`Option [${opt}]:`);
    console.log(
      `  by slug 'default':`,
      cachedBySlug
        ? {
            id: (cachedBySlug as any).id,
            saleRewardId: (cachedBySlug as any).saleRewardId,
            saleReward: (cachedBySlug as any).saleReward,
          }
        : "NULL",
    );
    console.log(
      `  by id '${groupInDb?.id}':`,
      cachedById
        ? {
            id: (cachedById as any).id,
            saleRewardId: (cachedById as any).saleRewardId,
            saleReward: (cachedById as any).saleReward,
          }
        : "NULL",
    );
  }

  console.log("\n=== getGroupOrThrow (includeExpandedFields: true) ===");
  const resolved = await getGroupOrThrow({
    programId,
    groupId: "default",
    includeExpandedFields: true,
  });
  console.log("Result:", {
    id: resolved.id,
    saleRewardId: resolved.saleRewardId,
    saleReward: resolved.saleReward,
  });
}

check().catch(console.error);
