import { metadataCache } from "@/lib/api/metadata-cache";
import { getGroupBountySummaries } from "@/lib/bounty/api/get-group-bounty-summaries";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { DubApiError } from "../errors";

export const getGroupOrThrow = async <
  TIncludeExpanded extends boolean = false,
  TIncludeBounties extends boolean = false,
>({
  programId,
  groupId,
  includeExpandedFields = false as TIncludeExpanded,
  includeBounties = false as TIncludeBounties,
}: {
  programId: string;
  groupId: string;
  includeExpandedFields?: TIncludeExpanded;
  includeBounties?: TIncludeBounties;
}) => {
  const optionsKey = `${includeExpandedFields ? 1 : 0}:${includeBounties ? 1 : 0}`;
  const cached = await metadataCache.getGroup<any>(
    programId,
    groupId,
    optionsKey,
  );
  if (cached) {
    return cached as any as Prisma.PartnerGroupGetPayload<{
      include: {
        clickReward: TIncludeExpanded;
        leadReward: TIncludeExpanded;
        saleReward: TIncludeExpanded;
        referralReward: TIncludeExpanded;
        discount: TIncludeExpanded;
        utmTemplate: TIncludeExpanded;
        partnerGroupDefaultLinks: TIncludeExpanded;
        program: TIncludeExpanded;
        workflow: TIncludeExpanded;
      };
    }> & {
      bounties?: any;
      moveRules?: Prisma.JsonValue | null;
    };
  }

  const group = await prisma.partnerGroup.findUnique({
    where: {
      ...(groupId.startsWith("grp_")
        ? {
            id: groupId,
          }
        : {
            programId_slug: {
              programId,
              slug: groupId,
            },
          }),
    },
    include: {
      clickReward: includeExpandedFields,
      leadReward: includeExpandedFields,
      saleReward: includeExpandedFields,
      referralReward: includeExpandedFields,
      discount: includeExpandedFields,
      utmTemplate: includeExpandedFields,
      partnerGroupDefaultLinks: includeExpandedFields,
      program: includeExpandedFields,
      workflow: includeExpandedFields,
    },
  });

  if (!group) {
    throw new DubApiError({
      code: "not_found",
      message: `Group "${groupId}" not found.`,
    });
  }

  if (group.programId !== programId) {
    throw new DubApiError({
      code: "forbidden",
      message: `Group "${groupId}" not found in your program.`,
    });
  }

  const result = {
    ...group,
    ...(includeBounties && {
      bounties: await getGroupBountySummaries({
        programId,
        groupId: group.id,
      }),
    }),
    moveRules: (group as any).workflow?.triggerConditions,
  };

  await metadataCache.setGroup(
    programId,
    groupId,
    result,
    optionsKey,
    group.id,
    group.slug,
  );

  return result as any as Prisma.PartnerGroupGetPayload<{
    include: {
      clickReward: TIncludeExpanded;
      leadReward: TIncludeExpanded;
      saleReward: TIncludeExpanded;
      referralReward: TIncludeExpanded;
      discount: TIncludeExpanded;
      utmTemplate: TIncludeExpanded;
      partnerGroupDefaultLinks: TIncludeExpanded;
      program: TIncludeExpanded;
      workflow: TIncludeExpanded;
    };
  }> & {
    bounties?: any;
    moveRules?: Prisma.JsonValue | null;
  };
};
